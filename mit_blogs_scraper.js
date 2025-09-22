/*
  MIT Admissions Blogs Scraper (Edge via Playwright)
  - Scrapes the first page of https://mitadmissions.org/blogs/
  - For each post: Title | Author | Comment Count | Time | Article Content | Images In Article
  - Saves CSV to mit_blogs.csv in the same directory
*/

const fs = require('fs');
const path = require('path');
const { chromium, request: playwrightRequest } = require('playwright');

function csvEscape(v) {
  if (v === null || v === undefined) return '""';
  const s = String(v).replace(/\"/g, '""').replace(/\r?\n/g, ' ').trim();
  return `"${s}"`;
}

// CSV escape but preserve embedded newlines for fields that need multi-line content within a single cell
function csvEscapeKeepNewlines(v) {
  if (v === null || v === undefined) return '""';
  const s = String(v).replace(/\"/g, '""').trim();
  return `"${s}"`;
}

async function extractListing(page) {
  // Try to robustly collect post links from listing page
  const items = await page.$$eval('a', (nodes) => {
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const isPostHref = (href) => {
      if (!href) return false;
      // Real article pages use /blogs/entry/<slug>/
      if (!/\/blogs\/entry\//.test(href)) return false;
      // exclude obvious non-article patterns
      if (/\/blogs\/?$/.test(href)) return false; // the index itself
      if (/\/(category|tag|author)\//.test(href)) return false;
      if (/[?&](paged|page)=/i.test(href)) return false;
      if (/#/.test(href)) return false;
      return true;
    };

    const seen = new Set();
    const out = [];

    for (const a of nodes) {
      const href = a.href || '';
      if (!isPostHref(href)) continue;
      if (seen.has(href)) continue;
      const title = norm(a.textContent || '');
      if (title.length < 5) continue;

      // Try to find author/time nearby by walking up the DOM a bit
      let author = '';
      let time = '';
      let el = a;
      for (let i = 0; i < 6 && el; i++) {
        const authorEl = el.querySelector?.('[rel="author"], .author a, .byline a, .byline, .post-author, .entry-author');
        if (authorEl && !author) author = norm(authorEl.textContent).replace(/^by\s+/i, '');
        const timeEl = el.querySelector?.('time[datetime], time, .date, .entry-date, .posted-on time');
        if (timeEl && !time) time = timeEl.getAttribute('datetime') || norm(timeEl.textContent);
        el = el.parentElement;
      }

      out.push({ title, href, author, time });
      seen.add(href);
    }

    // De-dup and keep reasonable amount
    return out.slice(0, 20);
  });

  return items;
}

async function extractPostDetails(page) {
  // First, extract from the main document
  const base = await page.evaluate(() => {
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

    const pick = (sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };

    const titleEl = pick(['article h1', 'h1.entry-title', 'h1.post-title', 'h1']);
    const ogTitleEl = document.querySelector('meta[property="og:title"][content]');
    const docTitle = ogTitleEl?.getAttribute('content') || document.title || '';
    let title = norm(titleEl?.textContent || docTitle);

    // Author from DOM/meta fallbacks (will be overridden by "by ..." in title if present)
    const authorEl = pick(['[rel="author"]', '.author a', '.byline a', '.byline', '.post-author', '.entry-author', '.entry-meta .byline .author a', '.entry-meta .author a', '.entry-header .byline .author a', '.post-meta .author a']);
    let author = norm(authorEl?.textContent || '').replace(/^by\s+/i, '');
    if (!author) {
      const metaAuthor = document.querySelector('meta[name="author"][content]');
      if (metaAuthor) author = norm(metaAuthor.getAttribute('content'));
    }

    // If title contains "... by AUTHOR", use it as the source of truth for author and clean title
    const byIdx = title.toLowerCase().lastIndexOf(' by ');
    if (byIdx > -1) {
      const t = norm(title.slice(0, byIdx));
      const a = norm(title.slice(byIdx + 4));
      if (a) author = a;
      if (t) title = t;
    }

    const timeEl = pick(['time[datetime]', '.posted-on time', 'time', '.date', '.entry-date']);
    let time = timeEl ? (timeEl.getAttribute('datetime') || norm(timeEl.textContent)) : '';
    if (!time) {
      const metaTime = document.querySelector('meta[property="article:published_time"][content]');
      if (metaTime) time = norm(metaTime.getAttribute('content'));
    }

    // Find main article container (prefer the content body inside the article)
    const articleEl = pick(['article .article__body', '.article__body', 'article .entry-content', '.entry-content', 'article .post-content', 'article .content', 'article', '.post-content']);

    // Content text (preserve paragraph breaks and in-paragraph line breaks)
    let articleText = '';
    let articleForMedia = null;
    if (articleEl) {
      // Remove nav/aside/comments before grabbing text, if present
      const clone = articleEl.cloneNode(true);
      for (const sel of ['nav', 'aside', 'footer', '.comments', '#comments', '.comment-list', '.page__footnotes', '.share-tools-mod', '.article__tags-mod']) {
        clone.querySelectorAll(sel).forEach((n) => n.remove());
      }
      // Remove inline annotation markers and inline annotation notes
      clone.querySelectorAll('.annotation__number, .annotation').forEach((n) => n.remove());
      // Replace the whole annotation wrapper with plain text to avoid line breaks around citations
      clone.querySelectorAll('.annotation-mod').forEach((n) => {
        const text = n.querySelector('.annotation__text')?.innerText || '';
        const tn = document.createTextNode(text);
        n.replaceWith(tn);
      });

      const blocks = clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, figure, figcaption');
      const parts = [];
      const ZW_RE = /[\u200B\u200C\u200D\u2060]/g; // zero-width chars incl. word-joiner
      if (blocks.length) {
        blocks.forEach((el) => {
          let t = (el.innerText || '').replace(/\r\n/g, '\n');
          // Strip zero-width characters introduced by citation spans
          t = t.replace(ZW_RE, '');
          // Collapse 2+ blank lines within a block to a single blank line
          t = t.replace(/\n{2,}/g, '\n');
          // Also collapse stray single newlines surrounded by non-empty text (inline breaks) to a space
          t = t.replace(/(\S)\n(\S)/g, '$1 $2');
          // For list items, add a simple bullet prefix to indicate list structure
          if (el.tagName.toLowerCase() === 'li') {
            t = t ? `- ${t}` : t;
          }
          parts.push(t);
        });
        // Join blocks with a blank line between paragraphs
        articleText = parts.join('\n\n');
      } else {
        // Fallback: preserve line breaks from innerText of the whole container
        articleText = (clone.innerText || '').replace(/\r\n/g, '\n').replace(ZW_RE, '');
        // Avoid excessive blank lines
        articleText = articleText.replace(/\n{3,}/g, '\n\n');
      }
      articleForMedia = clone; // use the cleaned clone to restrict media to body only
    }

    // Images (only those inside the content body)
    let images = [];
    if (articleForMedia) {
      const toAbs = (u) => {
        try { return new URL(u, location.href).href; } catch (_) { return ''; }
      };
      const toKey = (u) => {
        try {
          const x = new URL(u, location.href);
          x.hash = '';
          x.search = '';
          x.username = '';
          x.password = '';
          x.hostname = x.hostname.toLowerCase();
          return x.href;
        } catch (_) { return ''; }
      };
      const fromSrcset = (srcset) => {
        if (!srcset) return '';
        // pick the candidate with the largest width
        const parts = srcset.split(',').map(s => s.trim());
        let best = '';
        let bestW = -1;
        for (const p of parts) {
          const m = p.match(/\s+(\d+)w$/);
          const url = p.replace(/\s+\d+w$/, '').trim();
          const w = m ? parseInt(m[1], 10) : 0;
          if (url && w >= bestW) { best = url; bestW = w; }
        }
        return best || parts[0] || '';
      };
      const getImgUrl = (img) => {
        return (
          // Flickity lazy-load attribute used in MIT theme galleries
          img.getAttribute('data-flickity-lazyload-src') ||
          fromSrcset(img.getAttribute('data-flickity-lazyload-srcset')) ||
          img.getAttribute('data-lazy-src') ||
          img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('src') ||
          img.currentSrc ||
          fromSrcset(img.getAttribute('data-lazy-srcset')) ||
          fromSrcset(img.getAttribute('srcset')) ||
          ''
        );
      };
      const isArticleImage = (url) => {
        try {
          const u = new URL(url, location.href);
          // only keep site uploads, exclude emoji and avatars from other hosts
          return u.hostname.endsWith('mitadmissions.org') && u.pathname.includes('/wp-content/uploads/');
        } catch (_) { return false; }
      };

      const set = new Set();

      // 1) <img>
      articleForMedia.querySelectorAll('img').forEach((img) => {
        const src = getImgUrl(img);
        const abs = toAbs(src);
        const key = toKey(abs);
        if (key && isArticleImage(abs)) set.add(key);
      });
      // 2) <picture><source srcset>
      articleForMedia.querySelectorAll('picture source[srcset]').forEach((s) => {
        const src = fromSrcset(s.getAttribute('srcset'));
        const abs = toAbs(src);
        const key = toKey(abs);
        if (key && isArticleImage(abs)) set.add(key);
      });
      // 3) <a href> linking directly to image files inside content
      articleForMedia.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(href)) {
          const abs = toAbs(href);
          const key = toKey(abs);
          if (key && isArticleImage(abs)) set.add(key);
        }
      });

      // 4) <video> sources inside the content (count as images per requirement)
      articleForMedia.querySelectorAll('video[src], video source[src]').forEach((el) => {
        const src = el.getAttribute('src') || '';
        const abs = toAbs(src);
        const key = toKey(abs);
        if (key) set.add(key);
      });

      // 5) <iframe> embeds for common video hosts (YouTube/Vimeo) - count as images
      articleForMedia.querySelectorAll('iframe[src]').forEach((ifr) => {
        const src = ifr.getAttribute('src') || '';
        const abs = toAbs(src);
        const key = toKey(abs);
        try {
          const u = new URL(abs);
          if (/youtube\.com$|(^|\.)youtu\.be$|(^|\.)vimeo\.com$|(^|\.)player\.vimeo\.com$/i.test(u.hostname)) {
            if (key) set.add(key);
          }
        } catch (_) {}
      });

      // 6) <a href> linking directly to video files inside content
      articleForMedia.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(href)) {
          const abs = toAbs(href);
          const key = toKey(abs);
          if (key) set.add(key);
        }
      });

      images = Array.from(set);
    }

    // Comment count: prefer explicit "X Comment(s)" text AFTER the article body
    let commentCount = 0;

    const extractLabelCount = (scopeEls) => {
      let best = 0;
      for (const el of scopeEls) {
        const t = norm(el.textContent);
        const m = t.match(/^(\d+)\s+Comments?$/i);
        if (m) best = Math.max(best, parseInt(m[1], 10));
      }
      return best;
    };

    // 1) From elements after articleEl in DOM order
    if (articleEl) {
      const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div,p,a,button,strong,em'))
        .filter(el => (articleEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !articleEl.contains(el));
      commentCount = extractLabelCount(candidates);
    }

    // 2) If not found, scan the whole page for the label
    if (!commentCount) {
      const allCandidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div,p,a,button,strong,em'));
      commentCount = extractLabelCount(allCandidates);
    }

    // 3) Last resort (older themes): headers with numbers in comments section
    if (!commentCount) {
      const headers = Array.from(document.querySelectorAll('#comments h2, #comments h3, .comments h2, .comments h3'));
      commentCount = extractLabelCount(headers);
    }

    return { title, author, time, articleText, images, imagesCount: images.length, commentCount };
  });

  // Then, try to refine commentCount inside Disqus iframe by counting names/avatars/posts
  // If host page did not yield a count, try to read the label inside the Disqus iframe ("X Comment(s)")
  try {
    if (!base.commentCount || base.commentCount === 0) {
      // wait a bit for iframe to exist
      await page.waitForSelector('iframe[src*="disqus.com"]', { timeout: 5000 }).catch(() => {});
      let disqusFrame = null;
      for (let i = 0; i < 8; i++) {
        disqusFrame = page.frames().find(f => f.url().includes('disqus.com')) || null;
        if (disqusFrame) break;
        await page.waitForTimeout(400);
      }
      if (disqusFrame) {
        await disqusFrame.waitForTimeout(1200);
        const count = await disqusFrame.evaluate(() => {
          const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
          const els = Array.from(document.querySelectorAll('h1,h2,h3,span,div,p,a,button,strong,em'));
          let best = 0;
          for (const el of els) {
            const t = norm(el.textContent);
            const m = t.match(/^(\d+)\s+Comment(?:s|\(s\))?$/i);
            if (m) best = Math.max(best, parseInt(m[1], 10));
          }
          return best;
        }).catch(() => 0);
        if (count > 0) base.commentCount = count;
      }
    }
  } catch (_) { /* ignore */ }

  return base;
}

async function run() {
  // CLI
  const args = process.argv.slice(2);
  let specificUrls = [];
  let crawlAll = false;
  let outPath = path.resolve(__dirname, 'mit_blogs.csv');
  let sinceISO = null;
  let concurrency = 2;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--urls' && args[i + 1]) {
      specificUrls.push(...args[i + 1].split(',').map(s => s.trim()).filter(Boolean));
      i++;
    } else if (a === '--all') {
      crawlAll = true;
    } else if (a === '--out' && args[i + 1]) {
      outPath = path.resolve(args[i + 1]);
      i++;
    } else if (a === '--since' && args[i + 1]) {
      sinceISO = args[i + 1];
      i++;
    } else if (a === '--concurrency' && args[i + 1]) {
      const v = parseInt(args[i + 1], 10);
      if (Number.isFinite(v) && v > 0 && v <= 10) concurrency = v;
      i++;
    } else if (/^https?:\/\//i.test(a)) {
      specificUrls.push(a);
    }
  }

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Helper to process a single URL with its own page (for concurrency)
  const processOneWithPage = async (href, seed = {}) => {
    const p = await context.newPage();
    try {
      await p.goto(href, { waitUntil: 'domcontentloaded' });
      const d = await extractPostDetails(p);
      const title = d.title || seed.title || '';
      const author = d.author || seed.author || '';
      const time = d.time || seed.time || '';
      const commentCount = Number.isFinite(d.commentCount) ? d.commentCount : 0;
      const articleContent = d.articleText || '';
      const imagesInArticle = (d.images || []).join('\n');
      const imageCount = Array.isArray(d.images) ? d.images.length : (d.imagesCount || 0);
      return { title, author, commentCount, time, articleContent, imagesInArticle, imageCount };
    } catch (err) {
      return {
        title: seed.title || '',
        author: seed.author || '',
        commentCount: 0,
        time: seed.time || '',
        articleContent: '',
        imagesInArticle: '',
        imageCount: 0
      };
    } finally {
      await p.close().catch(() => {});
    }
  };

  const results = [];

  // Concurrency runner
  const runPool = async (items) => {
    let idx = 0;
    const out = new Array(items.length);
    const worker = async (w) => {
      while (true) {
        const my = idx++;
        if (my >= items.length) break;
        const it = items[my];
        const r = await processOneWithPage(it.href || it, it.seed || {});
        out[my] = r;
      }
    };
    const tasks = Array.from({ length: Math.min(concurrency, items.length) }, (_, i) => worker(i));
    await Promise.all(tasks);
    return out;
  };

  // Fetch all post URLs via WordPress REST API when --all is set
  const getAllPostLinks = async () => {
    const req = await playwrightRequest.newContext();
const base = 'https://mitadmissions.org/wp-json/wp/v2/posts?per_page=100&_fields=link,date&_embed=0&orderby=date&order=desc';
    let links = [];
    let pageNo = 1;
    let totalPages = 1;
    while (true) {
      const url = `${base}&page=${pageNo}`;
      const resp = await req.get(url);
      if (!resp.ok()) break;
      const tp = parseInt(resp.headers()['x-wp-totalpages'] || resp.headers()['X-WP-TotalPages'] || '1', 10);
      if (Number.isFinite(tp)) totalPages = tp;
      const data = await resp.json();
      for (const it of data) {
        const link = it.link;
        const date = it.date;
        if (sinceISO && date && new Date(date) < new Date(sinceISO)) {
          continue;
        }
        links.push({ href: link, seed: { time: date } });
      }
      pageNo++;
      if (pageNo > totalPages) break;
    }
    await req.dispose();
    // De-dup keep order
    const seen = new Set();
    links = links.filter((x) => {
      if (seen.has(x.href)) return false;
      seen.add(x.href);
      return true;
    });
    return links;
  };

  if (specificUrls.length > 0) {
    const items = specificUrls.map((u) => ({ href: u }));
    const out = await runPool(items);
    results.push(...out);
  } else if (crawlAll) {
    const all = await getAllPostLinks();
    const out = await runPool(all);
    results.push(...out);
  } else {
    await page.goto('https://mitadmissions.org/blogs/', { waitUntil: 'domcontentloaded' });
    const listing = await extractListing(page);
    const items = listing.map((x) => ({ href: x.href, seed: x }));
    const out = await runPool(items);
    results.push(...out);
  }

  const header = ['Title', 'Author', 'Comment Count', 'Time', 'Article Content', 'Images In Article', 'Image Count'];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of results) {
    lines.push([
      csvEscape(r.title),
      csvEscape(r.author),
      csvEscape(r.commentCount),
      csvEscape(r.time),
      csvEscapeKeepNewlines(r.articleContent),
      csvEscapeKeepNewlines(r.imagesInArticle),
      csvEscape(r.imageCount),
    ].join(','));
  }

  // Write CSV with UTF-8 BOM to avoid mojibake (e.g., ’ -> 鈥檛) in Windows/Excel
  const csvContent = '\ufeff' + lines.join('\n');
  fs.writeFileSync(outPath, csvContent, 'utf8');
  await browser.close();

  console.log(`Saved ${results.length} rows to: ${outPath}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
