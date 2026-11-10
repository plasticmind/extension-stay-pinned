// Builds the Chrome Web Store screenshots and promo tile.
//
// It loads the extension in Chrome for Testing, saves a sample set of pinned tabs, captures the
// real popup and options pages in light and dark mode, and places them in 1280x800 frames.
//
// This script uses the network: it visits each sample site once so that Chrome caches its
// favicon, and the popup and options pages can show real site icons.
//
// Run it with: npm run store:assets

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'store', 'images');

// Sites that load without signing in, so each one caches its own favicon.
const SAMPLE_SET = [
  { title: 'Linear', url: 'https://linear.app/' },
  { title: 'Figma', url: 'https://www.figma.com/' },
  { title: 'Notion', url: 'https://www.notion.com/' },
  { title: 'Trello', url: 'https://trello.com/' },
  { title: 'Spotify', url: 'https://open.spotify.com/' },
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dataUrl(buffer, type = 'image/png') {
  return `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function launch(profile) {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    pipe: true,
    enableExtensions: true,
    defaultViewport: null,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'),
    { timeout: 15000 },
  );
  return { browser, extensionId: new URL(sw.url()).host, worker: await sw.worker() };
}

/** Captures an extension page in one color scheme and returns it as a PNG data URL. */
async function capture(browser, url, { width, scheme, selector = 'body', clipHeight }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#set-list[aria-busy="false"], #rows[aria-busy="false"]', { timeout: 10000 });
  // Let favicons finish loading.
  await page.waitForFunction(() => [...document.images].every((img) => img.complete), { timeout: 10000 });
  await delay(300);
  let png;
  if (clipHeight) {
    png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height: clipHeight } });
  } else {
    png = await (await page.$(selector)).screenshot({ type: 'png' });
  }
  await page.close();
  return { src: await dataUrl(png) };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-pinned-store-'));
  const { browser, extensionId, worker } = await launch(profile);
  const ext = (p) => `chrome-extension://${extensionId}/${p}`;

  try {
    // Visit each sample site so Chrome caches its favicon.
    for (const { url } of SAMPLE_SET) {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await page.close();
    }
    await delay(2000);

    await worker.evaluate(async (entries) => {
      const pinnedSet = entries.map((e) => ({ id: crypto.randomUUID(), ...e }));
      await chrome.storage.sync.set({ pinnedSet });
    }, SAMPLE_SET);

    const shots = {};
    for (const scheme of ['light', 'dark']) {
      shots[`popup-${scheme}`] = await capture(browser, ext('popup/popup.html'), { width: 320, scheme });
      shots[`options-${scheme}`] = await capture(browser, ext('options/options.html'), {
        width: 700,
        scheme,
        clipHeight: 660,
      });
    }

    // Favicons for the drawn tab strip, from the same cache the extension uses.
    const helper = await browser.newPage();
    await helper.goto(ext('popup/popup.html'));
    const favicons = await helper.evaluate(
      async (entries, base) => {
        const out = [];
        for (const { url } of entries) {
          const res = await fetch(`${base}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
          const blob = await res.blob();
          out.push(
            await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            }),
          );
        }
        return out;
      },
      SAMPLE_SET,
      `chrome-extension://${extensionId}`,
    );
    const globe = await helper.evaluate(async (base) => {
      const res = await fetch(`${base}/_favicon/?pageUrl=${encodeURIComponent('https://example.invalid/')}&size=32`);
      return (await res.arrayBuffer()).byteLength;
    }, `chrome-extension://${extensionId}`);
    favicons.forEach((src, i) => {
      if (Buffer.from(src.split(',')[1], 'base64').length === globe) {
        console.warn(`Warning: ${SAMPLE_SET[i].url} has no cached favicon, so it shows the default globe.`);
      }
    });
    await helper.close();

    const iconSrc = await dataUrl(await fs.readFile(path.join(EXT_DIR, 'icons', 'icon.svg')), 'image/svg+xml');
    const frames = buildFrames({ shots, favicons, iconSrc });

    const page = await browser.newPage();
    for (const frame of frames) {
      await page.setViewport({ width: frame.width, height: frame.height, deviceScaleFactor: 1 });
      await page.setContent(frame.html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(OUT_DIR, frame.name);
      await page.screenshot({ path: file, type: 'png', clip: { x: 0, y: 0, width: frame.width, height: frame.height } });
      console.log(`Wrote ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Frames

const KEY = (label) => `<kbd>${label}</kbd>`;

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 100%; height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1f1f1f;
    background: linear-gradient(160deg, #f4f8ff 0%, #e3edfd 100%);
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }
  body.dark { color: #e3e3e3; background: linear-gradient(160deg, #1d2129 0%, #121417 100%); }
  .frame { position: relative; width: 1280px; height: 800px; overflow: hidden; }
  .copy { position: absolute; left: 80px; top: 0; bottom: 0; width: 420px;
    display: flex; flex-direction: column; justify-content: center; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 600; color: #0b57d0; }
  .dark .brand { color: #a8c7fa; }
  .brand img { width: 28px; height: 28px; }
  h1 { font-size: 46px; line-height: 1.12; font-weight: 700; letter-spacing: -0.02em; }
  p { font-size: 21px; line-height: 1.45; color: #444746; }
  .dark p { color: #b5b8bd; }
  kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; height: 44px;
    padding: 0 12px; border-radius: 10px; background: #fff; border: 1px solid #c4c7c5;
    box-shadow: 0 2px 0 #c4c7c5; font: 600 22px system-ui, sans-serif; color: #1f1f1f; }
  .keys { display: flex; gap: 8px; align-items: center; font-size: 20px; color: #444746; }
  .shot { position: absolute; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(31, 58, 104, 0.22), 0 4px 14px rgba(31, 58, 104, 0.12); }
  .dark .shot { box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px #3c4043; }
  .shot img { display: block; width: 100%; }
`;

const WINDOW_CSS = `
  .win { position: absolute; border-radius: 12px; overflow: hidden; background: #fff;
    box-shadow: 0 24px 60px rgba(31, 58, 104, 0.24), 0 4px 14px rgba(31, 58, 104, 0.12); }
  .strip { height: 44px; background: #dfe5ee; display: flex; align-items: flex-end; padding: 0 10px; gap: 2px; }
  .lights { display: flex; gap: 8px; align-self: center; margin-right: 14px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .lights i:nth-child(1) { background: #ff5f57; } .lights i:nth-child(2) { background: #febc2e; }
  .lights i:nth-child(3) { background: #28c840; }
  .tab { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
    border-radius: 9px 9px 0 0; font-size: 13px; color: #3c4043; white-space: nowrap; }
  .tab.pinned { width: 42px; padding: 0; justify-content: center; }
  .tab img { width: 16px; height: 16px; }
  .tab.active { background: #fff; }
  .tab.normal { width: 190px; }
  .tab.normal span { overflow: hidden; text-overflow: ellipsis; }
  .sep { width: 1px; height: 18px; background: #aab4c3; align-self: center; margin: 0 4px; }
  .newtab { width: 28px; height: 28px; align-self: center; display: grid; place-items: center;
    font-size: 20px; color: #5f6368; }
  .pin-ring { outline: 2.5px solid #0b57d0; outline-offset: -3px; border-radius: 9px 9px 0 0; }
  .toolbar { height: 44px; display: flex; align-items: center; gap: 14px; padding: 0 14px; border-bottom: 1px solid #e3e3e3; }
  .nav { width: 16px; height: 16px; border-radius: 3px; background: #c4c7c5; opacity: 0.8; }
  .omni { flex: 1; height: 32px; border-radius: 16px; background: #eef1f5; display: flex; align-items: center;
    padding: 0 16px; font-size: 14px; color: #5f6368; }
  .ext { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; }
  .ext.on { background: #d3e3fd; }
  .ext img { width: 18px; height: 18px; }
  .page { position: relative; background: #fff; }
  .ntp { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; height: 100%; }
  .ntp .search { width: 56%; height: 44px; border-radius: 22px; border: 1px solid #dadce0; }
  .ntp .tiles { display: flex; gap: 22px; }
  .ntp .tiles i { width: 48px; height: 48px; border-radius: 50%; background: #f1f3f4; display: block; }
`;

function chromeWindow({ favicons, width, height, activePinned = -1, extOn = false, url, tabs, ring = false, inner = '' }) {
  const pinned = favicons
    .map((src, i) => `<div class="tab pinned${i === activePinned ? ' active' : ''}"><img src="${src}" alt=""></div>`)
    .join('');
  const normal = tabs
    .map((t) => `<div class="tab normal${t.active ? ' active' : ''}"><span>${t.title}</span></div>`)
    .join('');
  return `
    <div class="strip">
      <div class="lights"><i></i><i></i><i></i></div>
      <div style="display:flex;gap:2px" class="${ring ? 'pin-ring' : ''}">${pinned}</div>
      <div class="sep"></div>${normal}<div class="newtab">+</div>
    </div>
    <div class="toolbar">
      <div class="nav"></div><div class="nav"></div><div class="nav"></div>
      <div class="omni">${url}</div>
      <div class="ext${extOn ? ' on' : ''}"><img src="ICON" alt=""></div>
    </div>
    <div class="page" style="height:${height - 88}px">${inner}</div>`
    .replace(/^/, `<div class="win" style="width:${width}px;height:${height}px;LEFT_TOP">`)
    .concat('</div>');
}

function page({ dark = false, css = '', body }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${WINDOW_CSS}${css}</style></head>
    <body class="${dark ? 'dark' : ''}"><div class="frame">${body}</div></body></html>`;
}

function copy({ iconSrc, title, text, extra = '' }) {
  return `<div class="copy">
    <div class="brand"><img src="${iconSrc}" alt="">Stay Pinned</div>
    <h1>${title}</h1><p>${text}</p>${extra}</div>`;
}

function buildFrames({ shots, favicons, iconSrc }) {
  const place = (html, left, top) => html.replace('LEFT_TOP', `left:${left}px;top:${top}px`).replaceAll('ICON', iconSrc);
  const ntp = '<div class="ntp"><div class="search"></div><div class="tiles"><i></i><i></i><i></i><i></i><i></i></div></div>';

  // 1. Every window gets the pinned tabs.
  const back = chromeWindow({
    favicons, width: 700, height: 470, url: 'example.com/release-checklist',
    tabs: [{ title: 'Sprint planning notes' }, { title: 'Release checklist', active: true }],
    activePinned: -1,
  });
  const front = chromeWindow({
    favicons, width: 700, height: 470, url: 'Search or type a URL', ring: true,
    tabs: [{ title: 'New Tab', active: true }], inner: ntp,
  });
  const frame1 = page({
    body:
      copy({
        iconSrc,
        title: 'Your pinned tabs in every new window',
        text: 'Each new Chrome window opens with the same pinned tabs, in the same order, loaded and ready.',
      }) +
      place(back, 560, 70) +
      place(front, 500, 260),
  });

  // 2. Reset with a shortcut, from the popup.
  const popup = shots['popup-light'];
  const popupW = 340;
  const resetWin = chromeWindow({
    favicons, width: 720, height: 700, url: 'linear.app/acme/inbox', extOn: true, activePinned: 0,
    tabs: [{ title: 'Q4 roadmap' }], inner: '',
  });
  const frame2 = page({
    css: '.copy { width: 380px; }',
    body:
      copy({
        iconSrc,
        title: 'Reset them with one shortcut',
        text: 'Reopen pinned tabs you closed, put them back in order, and return each one to its saved page.',
        extra: `<div class="keys">${KEY('Alt')}+${KEY('Shift')}+${KEY('P')}</div>`,
      }) +
      place(resetWin, 510, 50) +
      `<div class="shot" style="left:${510 + 720 - popupW - 12}px;top:${50 + 88 + 2}px;width:${popupW}px">
         <img src="${popup.src}" alt=""></div>`,
  });

  // 3. The options page.
  const options = shots['options-light'];
  const frame3 = page({
    css: '.copy { width: 400px; }',
    body:
      copy({
        iconSrc,
        title: 'Save a window, or edit the list',
        text: 'Save the pinned tabs from any window with one click, or add, reorder, and rename them on the options page.',
      }) +
      `<div class="shot" style="left:520px;top:70px;width:700px"><img src="${options.src}" alt=""></div>`,
  });

  // 4. Dark mode.
  const popupDark = shots['popup-dark'];
  const optionsDark = shots['options-dark'];
  const frame4 = page({
    dark: true,
    css: '.copy { width: 400px; }',
    body:
      copy({
        iconSrc,
        title: 'Light and dark, like Chrome',
        text: 'Stay Pinned follows your system theme. It makes no network requests and sends your data nowhere.',
      }) +
      `<div class="shot" style="left:520px;top:50px;width:700px"><img src="${optionsDark.src}" alt=""></div>` +
      `<div class="shot" style="left:880px;top:170px;width:${popupW}px"><img src="${popupDark.src}" alt=""></div>`,
  });

  // Small promo tile, 440x280.
  const promo = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
      body { background: linear-gradient(150deg, #1a73e8 0%, #0b57d0 100%); color: #fff; }
      .tile { width: 440px; height: 280px; display: flex; flex-direction: column; justify-content: center;
        align-items: flex-start; padding: 0 40px; gap: 14px; }
      .mark { width: 64px; height: 64px; border-radius: 16px; background: #fff; display: grid; place-items: center; }
      .mark img { width: 40px; height: 40px; }
      .name { font-size: 38px; font-weight: 700; letter-spacing: -0.02em; }
      .tag { font-size: 19px; line-height: 1.35; color: #d3e3fd; max-width: 330px; }
      .pins { position: absolute; right: 28px; top: 28px; display: flex; gap: 6px; }
      .pins span { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.95);
        display: grid; place-items: center; }
      .pins img { width: 16px; height: 16px; }
    </style></head><body><div class="tile">
      <div class="pins">${favicons.slice(0, 4).map((src) => `<span><img src="${src}" alt=""></span>`).join('')}</div>
      <div class="mark"><img src="${iconSrc}" alt=""></div>
      <div class="name">Stay Pinned</div>
      <div class="tag">Your pinned tabs in every new window.</div>
    </div></body></html>`;

  return [
    { name: 'screenshot-1-every-window.png', width: 1280, height: 800, html: frame1 },
    { name: 'screenshot-2-reset.png', width: 1280, height: 800, html: frame2 },
    { name: 'screenshot-3-options.png', width: 1280, height: 800, html: frame3 },
    { name: 'screenshot-4-dark.png', width: 1280, height: 800, html: frame4 },
    { name: 'promo-small-440x280.png', width: 440, height: 280, html: promo },
  ];
}

await main();
