@echo off
setlocal enabledelayedexpansion

rem MIT Admissions Blogs Scraper runner
rem Usage:
rem   run-scraper.cmd all [--since YYYY-MM-DD] [--out "C:\path\to\out.csv"] [--concurrency N]
rem   run-scraper.cmd urls "URL1,URL2,..." [--out "C:\path\to\out.csv"]
rem   run-scraper.cmd            (quick test: grabs a handful from listing page)

set "SCRIPT_DIR=%~dp0"
set "NODE=node"
set "JS=%SCRIPT_DIR%mit_blogs_scraper.js"

if not exist "%JS%" (
  echo [ERROR] Cannot find mit_blogs_scraper.js next to this script.
  echo Current script dir: %SCRIPT_DIR%
  exit /b 1
)

if "%~1"=="" goto :quick

if /I "%~1"=="all" (
  shift
  echo Running full-site crawl...
  "%NODE%" "%JS%" --all %*
  goto :end
)

if /I "%~1"=="urls" (
  shift
  if "%~1"=="" (
    echo Usage: %~n0 urls "URL1,URL2,..." [--out "C:\path\to\out.csv"] [--concurrency N] [--since YYYY-MM-DD]
    goto :end
  )
  set "URLS=%~1"
  shift
  echo Running targeted URLs: %URLS%
  "%NODE%" "%JS%" --urls "%URLS%" %*
  goto :end
)

:quick
echo Running quick test (listing page sample) ...
"%NODE%" "%JS%" %*

:end
endlocal
