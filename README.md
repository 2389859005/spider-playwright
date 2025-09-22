# MIT 招生博客爬虫

一个基于 Node.js + Playwright 的爬虫，用于抓取 MIT 招生博客，并将文章数据提取为干净的 CSV 格式。

主要功能
- 全站爬取：通过 WordPress REST API 枚举所有文章，然后使用 Playwright 渲染每篇文章以提取完整内容。
- 干净的文章文本：保留段落分隔符；移除脚注标记和内联注释；合并由引用导致的多余换行符。
- 媒体提取：仅收集文章正文内的媒体；支持延迟加载的图像、<picture>/<source>、直接图像链接、<video> 源、YouTube/Vimeo iframe 以及直接视频链接；视频计入图像计数。
- URL 标准化和去重：媒体 URL 经过标准化处理（去除查询/哈希；主机名标准化）并去重后计数。
- 评论计数：读取文章后的页面标签；回退到全页面标签和经典评论标题；如有必要，读取 Disqus iframe 内的标签。
- 适用于 Excel 的 CSV：UTF-8 BOM；"文章中的图像" 在单个单元格内以换行符分隔；"文章内容" 保留段落结构。


## 要求
- 推荐使用 Node.js 16+（理想情况下为 18+）
- Windows、macOS 或 Linux
- 浏览器：
  - 默认情况下，脚本在 Windows 上以无头模式启动 Edge (msedge)。如果您更喜欢 Chromium，请在代码中更改 `channel` 或将其删除。

安装依赖：
- npm install


## 输出
生成一个 CSV 文件（UTF-8 带 BOM），包含以下列：
- 标题
- 作者
- 评论数
- 时间（如果可用，为 ISO 8601 字符串）
- 文章内容
  - 保留段落分隔符；移除脚注标记和内联注释气泡。
  - 列表项以 "- " 为前缀。
  - 段落内的由引用导致的多余换行符将被合并。
- 文章中的图像
  - 单个 CSV 单元格内以换行符分隔的 URL（每个图像/视频占一行）。
  - 包括视频（video[src]、video source[src]、YouTube/Vimeo iframe、直接 .mp4/.webm/.ogg 链接）。
  - 仅包含在文章正文内找到的媒体。
- 图像计数
  - 标准化（去除查询/哈希）和去重后的唯一媒体 URL 数量。


## 使用方法
所有命令都应从项目目录运行：
- D:\download\vscodetest\d5data\spider-2

安装依赖：
- npm install

快速测试（从列表页面抓取少量文章）：
- node mit_blogs_scraper.js

爬取特定 URL：
- node mit_blogs_scraper.js --urls "https://mitadmissions.org/blogs/entry/rejection-therapy/,https://mitadmissions.org/blogs/entry/i-became-british-for-a-summer/"

爬取所有文章（全站）：
- node mit_blogs_scraper.js --all

爬取自某个日期以来的所有文章：
- node mit_blogs_scraper.js --all --since 2023-01-01

指定输出路径：
- node mit_blogs_scraper.js --all --out "D:\download\vscodetest\d5data\spider-2\mit_blogs_all.csv"

增加并发数（默认为 2，最大为 10）：
- node mit_blogs_scraper.js --all --concurrency 4

Windows 一键运行（批处理脚本）：
- run-scraper.cmd all [--since YYYY-MM-DD] [--out "C:\path\to\out.csv"] [--concurrency N]
- run-scraper.cmd urls "URL1,URL2,..." [--out "C:\path\to\out.csv"]
- run-scraper.cmd    (快速测试)

注意事项：
- 全站爬取可能需要一些时间，具体取决于网络和并发数。
- 考虑使用 `--since` 进行增量运行，然后在下游合并 CSV。


## 工作原理（高级概述）
1) URL 枚举（当使用 `--all` 时）：使用 WordPress REST API：`/wp-json/wp/v2/posts?per_page=100&_fields=link,date&_embed=0&orderby=date&order=desc` 进行分页，可选择在访问文章前通过 `--since` 进行过滤。
2) 页面渲染：在无头浏览器中访问每个文章 URL；脚本提取：
   - 标题 / 作者 / 时间
   - 从 `.article__body`（含回退方案）提取文章正文文本，去除脚注和内联注释，保留段落
   - 仅文章内的媒体（图像和视频）
   - 评论计数（含 Disqus iframe 回退方案）
3) 输出：写入 UTF-8 BOM CSV；"文章中的图像" 在单个单元格内以换行符分隔，便于在 Excel 中处理。


## 已知边缘情况 / 提示
- 如果 Excel 在单元格中显示为单个长行，请确保启用了"自动换行"。CSV 文件中已经包含嵌入的换行符。
- 一些较旧的文章可能具有略微不同的 DOM 结构；脚本包含了合理的回退方案。
- 如果 Edge 频道不可用或您更喜欢 Chromium，请在 `mit_blogs_scraper.js` 中更改启动器：
  - 从：`chromium.launch({ channel: 'msedge', headless: true })`
  - 改为：`chromium.launch({ headless: true })`

