// Render the generated k6 reports to PNGs for the README.
// Reuses the Playwright + Chromium already installed by a sibling project, so
// nothing extra is downloaded. Run:  node tools/screenshot.mjs
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const require = createRequire('C:/Tuhin/Automation Testing Dmoney/');
const { chromium } = require('playwright');

const PROJECT = path.dirname(fileURLToPath(import.meta.url)).replace(/\\tools$/, '');
const EXE = 'C:/Users/Test Tuhin/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';
const shot = (p) => path.join(PROJECT, 'screenshots', p);
const rep = (p) => path.join(PROJECT, 'reports', p);

function terminalHtml(txt) {
  const esc = txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#0b0e14;}
    pre{color:#d6e2cc;background:#0b0e14;font:13px/1.5 "Cascadia Code","Consolas",monospace;
        padding:24px 28px;white-space:pre;}
    </style></head><body><pre>${esc}</pre></body></html>`;
}

const run = async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  // 1) k6-reporter HTML summary
  if (existsSync(rep('summary.html'))) {
    await page.goto(pathToFileURL(rep('summary.html')).href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('html-report.png'), fullPage: true });
    console.log('saved screenshots/html-report.png');
  }

  // 2) terminal-style metrics image from the plain-text summary
  if (existsSync(rep('summary.txt'))) {
    await page.setContent(terminalHtml(readFileSync(rep('summary.txt'), 'utf8')), { waitUntil: 'load' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: shot('metrics-summary.png'), fullPage: true });
    console.log('saved screenshots/metrics-summary.png');
  }

  // 3) web-dashboard time-series (shows per-phase degradation)
  if (existsSync(rep('dashboard.html'))) {
    await page.goto(pathToFileURL(rep('dashboard.html')).href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot('dashboard.png'), fullPage: true });
    console.log('saved screenshots/dashboard.png');
  }

  await browser.close();
};

run().catch((e) => { console.error(e); process.exit(1); });
