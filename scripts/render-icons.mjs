// Renders the extension icon PNGs from extension/icons/icon.svg with Chrome.
//
// The 16, 32, and 48 px icons fill the canvas, so they read clearly in the toolbar. The 128 px
// icon fits the artwork in 96x96 with 16 px of transparent padding, as the Chrome Web Store asks.
//
// Usage: node scripts/render-icons.mjs [source.svg] [output-dir]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(ROOT, 'extension', 'icons', 'icon.svg'));
const outDir = path.resolve(process.argv[3] || path.join(ROOT, 'extension', 'icons'));

const SIZES = [
  { size: 16, art: 16 },
  { size: 32, art: 32 },
  { size: 48, art: 48 },
  { size: 128, art: 96 },
];

const svg = await fs.readFile(source, 'utf8');
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
await fs.mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: true, pipe: true });
try {
  const page = await browser.newPage();
  for (const { size, art } of SIZES) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const offset = (size - art) / 2;
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}
       img{position:absolute;left:${offset}px;top:${offset}px;width:${art}px;height:${art}px}</style>
       <img src="${src}" alt="">`,
      { waitUntil: 'load' },
    );
    const file = path.join(outDir, `icon-${size}.png`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`Wrote ${path.relative(ROOT, file)}`);
  }
} finally {
  await browser.close();
}
