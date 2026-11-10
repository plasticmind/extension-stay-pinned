// Shared harness: launches Chrome for Testing with the unpacked extension,
// drives it through the service worker and an extension page, and provides
// condition-based waits.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// STAY_PINNED_EXTENSION_DIR points the suite at another copy of the extension (for example, a
// deliberately broken one, to check that the suite catches the bug).
const EXT_DIR = path.resolve(process.env.STAY_PINNED_EXTENSION_DIR || path.join(ROOT, 'extension'));
const ARTIFACTS_DIR = path.join(ROOT, 'test', 'artifacts');
const HEADED = process.env.HEADED === '1';
// The popup and options pages set aria-busy="false" on their list once the set has rendered.
const READY = '#set-list[aria-busy="false"], #rows[aria-busy="false"]';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tabUrl(tab) {
  return tab.pendingUrl || tab.url;
}

/** Polls `check` until it returns a truthy value. `diagnose` adds context to the timeout error. */
export async function waitFor(check, { timeout = 10000, message = 'condition', diagnose } = {}) {
  const start = Date.now();
  let lastError;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - start > timeout) {
      let detail = '';
      if (diagnose) {
        try {
          detail = `\n${await diagnose()}`;
        } catch (error) {
          detail = `\n(diagnose failed: ${error.message})`;
        }
      }
      if (lastError) detail += `\nLast error: ${lastError.message}`;
      throw new Error(`Timed out after ${timeout} ms waiting for ${message}.${detail}`);
    }
    await delay(50);
  }
}

export function describeSnapshot(snap) {
  if (!snap) return '(no window)';
  const lines = [`window ${snap.window?.id} type=${snap.window?.type} record=${JSON.stringify(snap.record)}`];
  for (const t of snap.tabs) {
    lines.push(
      `  [${t.index}] id=${t.id}${t.pinned ? ' pinned' : ''}${t.active ? ' active' : ''} ${t.status}` +
        `${t.discarded ? ' discarded' : ''} ${tabUrl(t)}`,
    );
  }
  return lines.join('\n');
}

function resolveExecutable() {
  const candidate = process.env.CHROME_PATH || puppeteer.executablePath();
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Chrome for Testing not found at ${candidate}. Run "npx puppeteer browsers install chrome@144.0.7559.96" ` +
        'or set CHROME_PATH to a Chrome for Testing binary.',
    );
  }
  if (!/Chrome for Testing|chrome-(linux|win|mac)/i.test(candidate) && !process.env.CHROME_PATH) {
    throw new Error(`Refusing to use ${candidate}: branded Chrome ignores --load-extension.`);
  }
  return candidate;
}

export async function makeProfileDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'stay-pinned-profile-'));
}

function isDetached(error) {
  return /Target closed|Session closed|detached|Execution context|context was destroyed|No target with given id|Protocol error/i.test(
    String(error?.message || error),
  );
}

export class Harness {
  constructor({ browser, server, userDataDir, ownsProfile }) {
    this.browser = browser;
    this.server = server;
    this.userDataDir = userDataDir;
    this.ownsProfile = ownsProfile;
    this.extensionId = null;
    this.workerTarget = null;
    this.worker = null;
    this.driverPage = null;
    this.driverWindowId = null;
    this.keepTabIds = [];
    this.installOpenedOptions = false;
  }

  /**
   * Launches Chrome for Testing with a fresh (or given) profile and the unpacked extension.
   * Options: userDataDir (reuse a profile), ignoreDefaultArgs.
   */
  /**
   * install: 'flag' (default) loads the extension with --load-extension on every launch. Chrome
   * then treats each launch as a fresh install (onInstalled "install", never onStartup).
   * 'cdp' installs it once through Extensions.loadUnpacked, so it stays in the profile like a
   * normal unpacked install. 'profile' loads nothing and uses what the profile already has, so a
   * relaunch fires onStartup.
   */
  static async launch(server, { userDataDir, ignoreDefaultArgs = [], install = 'flag' } = {}) {
    if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
      throw new Error(`extension/manifest.json is missing, so there is no extension to load (${EXT_DIR}).`);
    }
    const ownsProfile = !userDataDir;
    const profile = userDataDir || (await makeProfileDir());
    const flagArgs = install === 'flag' ? [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`] : [];
    const browser = await puppeteer.launch({
      executablePath: resolveExecutable(),
      headless: HEADED ? false : true,
      userDataDir: profile,
      enableExtensions: install === 'cdp' ? [EXT_DIR] : true,
      pipe: true,
      defaultViewport: null,
      ignoreDefaultArgs,
      args: [...flagArgs, '--window-size=1280,900'],
    });
    const h = new Harness({ browser, server, userDataDir: profile, ownsProfile });
    try {
      await h.attachWorker();
    } catch (error) {
      await h.close();
      throw error;
    }
    return h;
  }

  async attachWorker({ exclude } = {}) {
    const target = await this.browser
      .waitForTarget(
        (t) =>
          t.type() === 'service_worker' &&
          t.url().startsWith('chrome-extension://') &&
          t.url().endsWith('/background.js') &&
          t !== exclude,
        { timeout: 15000 },
      )
      .catch(() => {
        throw new Error('The extension service worker (background.js) never started. Check manifest.json and background.js.');
      });
    this.workerTarget = target;
    this.extensionId = new URL(target.url()).host;
    this.worker = await target.worker();
    if (!this.worker) throw new Error('Could not attach to the extension service worker.');
    // chrome.* can be undefined for a moment right after attaching.
    await waitFor(() => this.worker.evaluate(() => typeof chrome !== 'undefined' && typeof chrome.windows?.getAll === 'function'), {
      timeout: 5000,
      message: 'chrome.windows to become available in the service worker',
    });
    return this.worker;
  }

  extUrl(p) {
    return `chrome-extension://${this.extensionId}/${p}`;
  }

  /** Evaluates `fn` in the service worker, reattaching once if the worker was stopped. */
  async sw(fn, ...args) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.worker.evaluate(fn, ...args);
      } catch (error) {
        if (attempt >= 1 || !isDetached(error)) throw error;
        await this.wakeWorker();
      }
    }
  }

  async wakeWorker() {
    if (this.driverPage && !this.driverPage.isClosed()) {
      await this.driverPage
        .evaluate(() => chrome.runtime.sendMessage({ type: '__test-wake' }).catch(() => {}))
        .catch(() => {});
    }
    await this.attachWorker({ exclude: this.workerTarget });
  }

  /**
   * Prepares the driver window: records whether install opened the options page, closes it,
   * and opens our own extension page to send runtime messages from.
   */
  async setupDriver({ waitForInstallPage = true, avoidWindowIds = [] } = {}) {
    const optionsPrefix = this.extUrl('options/options.html');
    if (waitForInstallPage) {
      const installTarget = await this.browser
        .waitForTarget((t) => t.type() === 'page' && t.url().startsWith(optionsPrefix), { timeout: 4000 })
        .catch(() => null);
      this.installOpenedOptions = Boolean(installTarget);
    }
    const windows = await this.sw(() => chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }));
    if (!windows.length) throw new Error('No normal window is open after launch.');
    const driverWindow = windows.find((w) => !avoidWindowIds.includes(w.id)) || windows[0];
    this.driverWindowId = driverWindow.id;
    // Keep the driver window alive with a plain page, then close extension pages (such as the
    // install-time options page, which can replace the startup about:blank tab).
    await this.createTab({ windowId: driverWindow.id, url: `${this.server.h1}/driver-home`, active: false });
    const extTabs = windows.flatMap((w) => w.tabs).filter((t) => tabUrl(t).startsWith('chrome-extension://'));
    if (extTabs.length) await this.removeTab(extTabs.map((t) => t.id));
    await this.openDriver();
  }

  async openDriver() {
    const candidates = ['options/options.html', 'popup/popup.html'];
    const problems = [];
    for (const p of candidates) {
      const url = `${this.extUrl(p)}?driver=1`;
      const keep = await this.sw(async (windowId) => {
        const wins = await chrome.windows.getAll({ populate: true });
        const win = wins.find((w) => w.id === windowId);
        return win ? win.tabs.filter((t) => !(t.pendingUrl || t.url).startsWith('chrome-extension://')).map((t) => t.id) : [];
      }, this.driverWindowId);
      const tab = await this.createTab({ windowId: this.driverWindowId, url, active: true });
      const target = await this.browser.waitForTarget((t) => t.url() === url, { timeout: 10000 }).catch(() => null);
      const page = target && (await target.page());
      const usable =
        page &&
        (await page
          .waitForFunction(() => typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function', {
            timeout: 3000,
          })
          .then(() => true)
          .catch(() => false));
      if (usable) {
        this.driverPage = page;
        this.keepTabIds = [...keep, tab.id];
        return page;
      }
      problems.push(`${p}: not a working extension page`);
      await this.sw((id) => chrome.tabs.remove(id).catch(() => {}), tab.id);
    }
    throw new Error(`No extension page is available to send messages from (${problems.join('; ')}).`);
  }

  async driver() {
    if (!this.driverPage || this.driverPage.isClosed()) await this.openDriver();
    return this.driverPage;
  }

  /** Sends a runtime message from the driver extension page and returns the response. */
  async send(message) {
    const page = await this.driver();
    return page.evaluate(
      async (message, timeout) => {
        let timer;
        try {
          return await Promise.race([
            chrome.runtime.sendMessage(message),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`No response to "${message.type}" within ${timeout} ms`)), timeout);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      message,
      10000,
    );
  }

  /** Evaluates `fn` in the driver extension page. */
  async inDriver(fn, ...args) {
    const page = await this.driver();
    return page.evaluate(fn, ...args);
  }

  // ---- State helpers -------------------------------------------------------

  setSet(entries) {
    return this.sw((pinnedSet) => chrome.storage.sync.set({ pinnedSet }), entries);
  }

  async getSet() {
    return this.sw(async () => (await chrome.storage.sync.get('pinnedSet')).pinnedSet);
  }

  /** All window records, keyed by window ID (from session keys "window:<windowId>"). */
  async getRecords() {
    return this.sw(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.fromEntries(
        Object.entries(all)
          .filter(([key]) => key.startsWith('window:'))
          .map(([key, value]) => [key.slice('window:'.length), value]),
      );
    });
  }

  /** Every key in session storage, to check the storage layout. */
  sessionKeys() {
    return this.sw(async () => Object.keys(await chrome.storage.session.get(null)));
  }

  clearSession() {
    return this.sw(() => chrome.storage.session.clear());
  }

  createWindow(options = {}) {
    return this.sw((options) => chrome.windows.create(options), options);
  }

  createTab(options) {
    return this.sw((options) => chrome.tabs.create(options), options);
  }

  updateTab(tabId, props) {
    return this.sw((tabId, props) => chrome.tabs.update(tabId, props), tabId, props);
  }

  removeTab(tabId) {
    return this.sw((tabId) => chrome.tabs.remove(tabId), tabId);
  }

  moveTab(tabId, index) {
    return this.sw((tabId, index) => chrome.tabs.move(tabId, { index }), tabId, index);
  }

  getTab(tabId) {
    return this.sw((tabId) => chrome.tabs.get(tabId).catch(() => null), tabId);
  }

  /** Closes a tab and waits until it's gone. */
  async closeTab(tabId) {
    await this.removeTab(tabId);
    await waitFor(async () => !(await this.getTab(tabId)), { message: `tab ${tabId} to close` });
  }

  /** Navigates a tab and waits until it loads. Extra props go to chrome.tabs.update. */
  async navigateTab(tabId, url, props = {}) {
    await this.updateTab(tabId, { url, ...props });
    return this.waitForLoaded(tabId, url);
  }

  /** Creates a tab and waits until it loads. */
  async openTab(options) {
    const tab = await this.createTab(options);
    await this.waitForLoaded(tab.id, options.url);
    return tab;
  }

  async snapshot(windowId) {
    return this.sw(async (windowId) => {
      const key = `window:${windowId}`;
      const [window, tabs, stored] = await Promise.all([
        chrome.windows.get(windowId).catch(() => null),
        chrome.tabs.query({ windowId }),
        chrome.storage.session.get(key),
      ]);
      if (!window) return null;
      return { window, tabs: tabs.sort((a, b) => a.index - b.index), record: stored[key] ?? null };
    }, windowId);
  }

  /** Waits until one tab matches `predicate(tab)`, returning that tab. */
  async waitForTab(tabId, predicate, message) {
    return waitFor(
      async () => {
        const tab = await this.getTab(tabId);
        return tab && predicate(tab) ? tab : null;
      },
      { message: message || `tab ${tabId} to match`, diagnose: async () => JSON.stringify(await this.getTab(tabId)) },
    );
  }

  waitForLoaded(tabId, url) {
    return this.waitForTab(tabId, (t) => t.status === 'complete' && t.url === url, `tab ${tabId} to load ${url}`);
  }

  /**
   * Waits until the window's first set.length tabs are the set's pinned tabs in order
   * (loaded, unless loaded=false), and the window's record maps each slot to its tab.
   * Then waits for the window to settle. Returns the settled snapshot.
   */
  async waitForSet(windowId, set, { loaded = true } = {}) {
    let last;
    await waitFor(
      async () => {
        last = await this.snapshot(windowId);
        const head = last?.tabs.slice(0, set.length) ?? [];
        return (
          head.length === set.length &&
          head.every(
            (t, i) =>
              t.pinned &&
              tabUrl(t) === set[i].url &&
              (!loaded || (t.status === 'complete' && !t.discarded)) &&
              last.record?.[set[i].id] === t.id,
          )
        );
      },
      {
        message: `window ${windowId} to hold the set's ${set.length} pinned tabs in order${loaded ? ', loaded' : ''}, mapped in its record`,
        diagnose: () => `Expected: ${set.map((e) => e.url).join(', ')}\n${describeSnapshot(last)}`,
      },
    );
    await this.settle([windowId]);
    return this.snapshot(windowId);
  }

  /**
   * Waits until tabs and session records in the given windows stop changing for quietMs.
   * Used before negative assertions such as "no duplicates appear".
   */
  async settle(windowIds) {
    const quietMs = 500;
    const timeout = 10000;
    const signature = () =>
      this.sw(async (windowIds) => {
        const tabs = await chrome.tabs.query({});
        const records = await chrome.storage.session.get(windowIds.map((id) => `window:${id}`));
        return JSON.stringify({
          tabs: tabs
            .filter((t) => windowIds.includes(t.windowId))
            .map((t) => [t.windowId, t.id, t.index, t.pinned, t.url, t.pendingUrl, t.status]),
          records: windowIds.map((id) => records[`window:${id}`] ?? null),
        });
      }, windowIds);
    const start = Date.now();
    let sig = await signature();
    let since = Date.now();
    while (Date.now() - since < quietMs) {
      if (Date.now() - start > timeout) throw new Error(`Windows ${windowIds.join(', ')} never settled.`);
      await delay(50);
      const next = await signature();
      if (next !== sig) {
        sig = next;
        since = Date.now();
      }
    }
  }

  /** Closes every window except the driver window, closes extra driver tabs, and clears storage. */
  async reset() {
    await this.driver();
    await this.sw(
      async (driverWindowId, keepTabIds) => {
        const wins = await chrome.windows.getAll({ populate: true });
        await Promise.all(
          wins.filter((w) => w.id !== driverWindowId).map((w) => chrome.windows.remove(w.id).catch(() => {})),
        );
        const driver = wins.find((w) => w.id === driverWindowId);
        const extra = (driver?.tabs || []).filter((t) => !keepTabIds.includes(t.id)).map((t) => t.id);
        if (extra.length) await chrome.tabs.remove(extra).catch(() => {});
      },
      this.driverWindowId,
      this.keepTabIds,
    );
    await waitFor(async () => (await this.sw(() => chrome.windows.getAll())).length === 1, {
      message: 'extra windows to close',
    });
    await this.sw(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.session.clear();
    });
    this.server.resetHits();
  }

  /** Opens an extension page in a new tab, collecting console errors from before the first load. */
  async openExtensionPage(p, { viewport } = {}) {
    const page = await this.browser.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
    page.on('requestfailed', (req) => errors.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
    if (viewport) await page.setViewport(viewport);
    await page.goto(this.extUrl(p), { waitUntil: 'load' });
    const ready = await page
      .waitForSelector(READY, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return { page, errors, ready };
  }

  /** Opens an extension page as a tab in a given window, so chrome.windows.getCurrent() is that window. */
  async openExtensionPageInWindow(windowId, p) {
    const url = `${this.extUrl(p)}?test=${Date.now()}`;
    await this.createTab({ windowId, url, active: true });
    const target = await this.browser.waitForTarget((t) => t.url() === url, { timeout: 10000 });
    const page = await target.page();
    await page.waitForSelector(READY, { timeout: 5000 });
    return page;
  }

  async close() {
    await this.browser?.close().catch(() => {});
    if (this.ownsProfile && this.userDataDir) {
      await fsp.rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Builds a set entry with a fresh slot ID. */
export function entry(url, title) {
  return { id: crypto.randomUUID(), url: new URL(url).href, title };
}

/** Three slots across two hosts. Charlie has a hash, to check exact (hash-aware) comparison. */
export function abc(server) {
  return [
    entry(`${server.h1}/a`, 'Alpha'),
    entry(`${server.h2}/b`, 'Bravo'),
    entry(`${server.h1}/c#top`, 'Charlie'),
  ];
}

export async function ensureArtifactsDir() {
  await fsp.mkdir(ARTIFACTS_DIR, { recursive: true });
  return ARTIFACTS_DIR;
}
