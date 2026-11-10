// End-to-end suite for Stay Pinned. Run with `npm test` (headless) or `HEADED=1 npm test`.
// Case numbers match the "Tests" section of SPEC.md. Extra cases are labeled "extra".
//
// Why there are no keyboard-shortcut tests: automation can't press extension keyboard
// shortcuts. Puppeteer key events go to the page, not to Chrome's command handler, and
// there's no CDP call that fires chrome.commands.onCommand. The reset-window and reset-tab
// commands share their code path with the runtime messages of the same names, so the suite
// tests that shared path by sending messages from an extension page. Case 11 checks that
// both commands are registered.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Harness, abc as abcFor, describeSnapshot, ensureArtifactsDir, entry, tabUrl, waitFor } from './helpers/harness.js';
import { startServer } from './helpers/server.js';

const T = { timeout: 45000 };

let server;
let h;

function assertOk(response, what) {
  assert.equal(response?.ok, true, `${what}: expected { ok: true }, got ${JSON.stringify(response)}`);
}

/** Switches prefers-color-scheme and waits for the resulting CSS transitions to finish. */
async function emulateScheme(page, scheme) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  });
}

function pinnedIds(snap) {
  return snap.tabs.filter((t) => t.pinned).map((t) => t.id);
}

const abc = () => abcFor(server);

const home = (name) => `${server.h1}/home-${name}`;

describe('Stay Pinned end to end', () => {
  before(async () => {
    server = await startServer();
    h = await Harness.launch(server);
    await h.setupDriver();
  }, { timeout: 60000 });

  after(async () => {
    await h?.close();
    await server?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  // ---------------------------------------------------------------------------
  it('extra: manifest matches the spec', T, async () => {
    const m = await h.sw(() => chrome.runtime.getManifest());
    assert.equal(m.manifest_version, 3);
    assert.equal(m.name, 'Stay Pinned');
    assert.equal(m.version, '1.0.0');
    assert.equal(m.minimum_chrome_version, '116');
    assert.deepEqual([...(m.permissions || [])].sort(), ['favicon', 'storage', 'tabs']);
    assert.ok(!m.host_permissions?.length, 'no host permissions');
    assert.equal(m.background?.type, 'module');
    assert.equal(m.action?.default_popup, 'popup/popup.html');
    assert.equal(m.options_ui?.page, 'options/options.html');
    assert.equal(m.options_ui?.open_in_tab, true);
    for (const size of ['16', '32', '48', '128']) assert.equal(m.icons?.[size], `icons/icon-${size}.png`);
  });

  it('extra: install opens the options page', T, async () => {
    assert.ok(h.installOpenedOptions, 'expected onInstalled (reason install) to open options/options.html');
  });

  it('extra: lib/pinned-set.js helpers follow the spec', T, async () => {
    const result = await h.inDriver(async () => {
      const m = await import(chrome.runtime.getURL('lib/pinned-set.js'));
      const pin = (u) => m.isPinnableUrl(u);
      const empty = await m.getPinnedSet();
      const saved = await m.savePinnedSet([
        { id: 'keep-1', url: 'HTTPS://Example.COM/a#h', title: 'Kept' },
        { url: 'about:blank' },
        { url: 'not a url' },
        { url: 'http://www.foo.example/p' },
      ]);
      const stored = (await chrome.storage.sync.get(m.SET_KEY))[m.SET_KEY];
      const longTitle = 'x'.repeat(150);
      const [truncated] = await m.savePinnedSet([{ url: 'https://long.example/', title: longTitle }]);
      return {
        setKey: m.SET_KEY,
        empty,
        pinnable: {
          http: pin('http://a.example/'),
          https: pin('https://a.example/'),
          file: pin('file:///tmp/x.html'),
          chrome: pin('chrome://settings/'),
          ext: pin('chrome-extension://abc/page.html'),
          about: pin('about:blank'),
          data: pin('data:text/html,x'),
          js: pin('javascript:alert(1)'),
          ftp: pin('ftp://a.example/'),
          garbage: pin('not a url'),
          blank: pin(''),
        },
        matchKey: [m.matchKey('https://a.example/x?q=1#frag'), m.matchKey('nope')],
        hostKey: [
          m.hostKey('https://www.example.com/x'),
          m.hostKey('http://localhost:8080/'),
          m.hostKey('http://127.0.0.1:8080/'),
          m.hostKey('nope'),
        ],
        saved,
        stored,
        truncatedTitle: truncated?.title,
      };
    });
    assert.equal(result.setKey, 'pinnedSet');
    assert.deepEqual(result.empty, [], 'getPinnedSet() returns [] when nothing is stored');
    assert.deepEqual(result.pinnable, {
      http: true, https: true, file: true, chrome: true, ext: true,
      about: false, data: false, js: false, ftp: false, garbage: false, blank: false,
    });
    assert.deepEqual(result.matchKey, ['https://a.example/x?q=1', null]);
    assert.deepEqual(result.hostKey, ['example.com', 'localhost', '127.0.0.1', null]);
    assert.equal(result.saved.length, 2, `savePinnedSet drops invalid URLs: ${JSON.stringify(result.saved)}`);
    assert.deepEqual(result.saved[0], { id: 'keep-1', url: 'https://example.com/a#h', title: 'Kept' });
    assert.equal(result.saved[1].url, 'http://www.foo.example/p');
    assert.match(result.saved[1].id, /^[0-9a-f-]{36}$/, 'missing ids get crypto.randomUUID()');
    assert.ok(['www.foo.example', 'foo.example'].includes(result.saved[1].title), 'title defaults to the hostname');
    assert.deepEqual(result.stored, result.saved, 'savePinnedSet writes what it returns');
    assert.ok(result.truncatedTitle && result.truncatedTitle.length <= 100, `title truncated to 100 characters (got ${result.truncatedTitle?.length})`);
    assert.ok(result.truncatedTitle.length >= 99, 'truncation keeps the first ~100 characters');
  });

  // ---------------------------------------------------------------------------
  it('1. a new normal window gets the set, loaded, at 0..n-1, and its own tab stays active', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({}); // Default new tab page, like Cmd+N.
    const ownTabId = win.tabs[0].id;
    const snap = await h.waitForSet(win.id, set);

    assert.equal(snap.tabs.length, set.length + 1, describeSnapshot(snap));
    set.forEach((e, i) => {
      const t = snap.tabs[i];
      assert.equal(t.index, i);
      assert.equal(t.pinned, true);
      assert.equal(t.url, e.url, 'URL matches exactly, including the hash');
      assert.equal(t.status, 'complete');
      assert.equal(t.discarded, false);
      assert.equal(t.active, false, `slot tab ${i} must not steal focus`);
      assert.ok(server.hits(e.url) >= 1, `server saw a request for ${e.url}`);
    });
    const own = snap.tabs[set.length];
    assert.equal(own.id, ownTabId, "the window's own tab is still there");
    assert.equal(own.active, true, "the window's own tab stays active");
    assert.equal(own.pinned, false);

    const keys = await h.sessionKeys();
    assert.ok(keys.includes(`window:${win.id}`), `record lives at session key window:${win.id} (keys: ${keys})`);
    assert.ok(!keys.includes('windows'), 'the old shared "windows" key is gone');
  });

  it('2. a second window gets its own copy, and the first gains no duplicates', T, async () => {
    const set = abc();
    await h.setSet(set);
    const w1 = await h.createWindow({ url: home(1) });
    const s1 = await h.waitForSet(w1.id, set);
    const w2 = await h.createWindow({ url: home(2) });
    const s2 = await h.waitForSet(w2.id, set);
    await h.settle([w1.id, w2.id]);
    const f1 = await h.snapshot(w1.id);

    assert.equal(f1.tabs.length, set.length + 1, `window 1 has no duplicates\n${describeSnapshot(f1)}`);
    assert.deepEqual(pinnedIds(f1), pinnedIds(s1), 'window 1 kept the same tabs');
    assert.equal(s2.tabs.length, set.length + 1, describeSnapshot(s2));
    const shared = pinnedIds(s2).filter((id) => pinnedIds(f1).includes(id));
    assert.deepEqual(shared, [], 'the windows share no tabs');
  });

  it('3. reset-window brings a navigated tab back and leaves the others alone', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home(3) });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c] = before.tabs;
    const hitsBefore = set.map((e) => server.hits(e.url));

    await h.navigateTab(b.id, `${server.h1}/elsewhere`);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    assert.equal(r.navigated, 1, `navigated count: ${JSON.stringify(r)}`);
    assert.equal(r.restored, 0, `restored count: ${JSON.stringify(r)}`);

    const after = await h.waitForSet(win.id, set);
    assert.deepEqual(pinnedIds(after), [a.id, b.id, c.id], 'same tabs, same order');
    assert.equal(after.tabs.length, set.length + 1);
    assert.equal(server.hits(set[0].url), hitsBefore[0], 'slot A was not reloaded');
    assert.equal(server.hits(set[2].url), hitsBefore[2], 'slot C (with hash) was not reloaded');
    assert.equal(server.hits(set[1].url), hitsBefore[1] + 1, 'slot B loaded once more');
  });

  it('4a. reset-window recreates a closed slot tab at the correct index', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('4a') });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c, own] = before.tabs;
    const hitsA = server.hits(set[0].url);

    await h.closeTab(b.id);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    assert.equal(r.restored, 1, `restored count: ${JSON.stringify(r)}`);
    assert.equal(r.navigated, 0, `a newly created tab is not navigated again: ${JSON.stringify(r)}`);

    const after = await h.waitForSet(win.id, set);
    const ids = pinnedIds(after);
    assert.equal(ids.length, 3, describeSnapshot(after));
    assert.equal(ids[0], a.id);
    assert.notEqual(ids[1], b.id, 'slot B is a new tab');
    assert.equal(ids[2], c.id);
    assert.equal(after.tabs.find((t) => t.active)?.id, own.id, 'the active tab did not change');
    assert.equal(server.hits(set[0].url), hitsA, 'slot A was not reloaded');
  });

  it('4b. reset-window pins an unpinned slot tab again and moves it back', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('4b') });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c] = before.tabs;

    await h.updateTab(a.id, { pinned: false });
    await h.waitForTab(a.id, (t) => !t.pinned && t.index === 2, 'tab A to unpin and move right');

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    const after = await h.waitForSet(win.id, set);
    assert.deepEqual(pinnedIds(after), [a.id, b.id, c.id], 'the same tab is re-pinned, not replaced');
    assert.equal(after.tabs.length, set.length + 1, 'no tab was created');
  });

  it('5a. reset-tab resets the active slot tab and nothing else', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('5a') });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c, own] = before.tabs;

    await h.navigateTab(a.id, `${server.h1}/away-a`);
    await h.navigateTab(b.id, `${server.h2}/away-b`, { active: true });

    const r = await h.send({ type: 'reset-tab', tabId: b.id });
    assertOk(r, 'reset-tab');
    assert.equal(r.reset, true, `reset-tab on a slot tab: ${JSON.stringify(r)}`);
    await h.waitForLoaded(b.id, set[1].url);
    await h.settle([win.id]);
    assert.equal(tabUrl(await h.getTab(a.id)), `${server.h1}/away-a`, 'only the target tab is reset');

    // A tab that isn't a slot.
    await h.navigateTab(own.id, `${server.h1}/own-page`, { active: true });
    const ownHits = server.hits(`${server.h1}/own-page`);
    const r2 = await h.send({ type: 'reset-tab', tabId: own.id });
    assertOk(r2, 'reset-tab on a non-slot tab');
    assert.equal(r2.reset, false, `reset-tab on a non-slot tab: ${JSON.stringify(r2)}`);
    await h.settle([win.id]);
    const final = await h.snapshot(win.id);
    assert.equal(tabUrl(final.tabs.find((t) => t.id === own.id)), `${server.h1}/own-page`);
    assert.equal(server.hits(`${server.h1}/own-page`), ownHits, 'the non-slot tab was not reloaded');
    assert.equal(final.tabs.length, set.length + 1);

    // A slot tab already at its URL isn't reloaded.
    const hitsC = server.hits(set[2].url);
    const r3 = await h.send({ type: 'reset-tab', tabId: c.id });
    assertOk(r3, 'reset-tab on a slot tab already at its URL');
    await h.settle([win.id]);
    assert.equal(server.hits(set[2].url), hitsC, 'slot C was not reloaded');
  });

  it('5b. reset-tab maps an untracked window first, without creating tabs', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('5b') });
    const before = await h.waitForSet(win.id, set);
    const [a, , c] = before.tabs;

    await h.navigateTab(a.id, `${server.h1}/away-a`, { active: true });
    await h.closeTab(c.id);
    await h.clearSession();

    const r = await h.send({ type: 'reset-tab', tabId: a.id });
    assertOk(r, 'reset-tab');
    assert.equal(r.reset, true, `reset-tab in an untracked window: ${JSON.stringify(r)}`);
    await h.waitForLoaded(a.id, set[0].url);
    await h.settle([win.id]);
    const after = await h.snapshot(win.id);
    assert.equal(after.tabs.length, before.tabs.length - 1, `create: false, so slot C is not recreated\n${describeSnapshot(after)}`);
    assert.ok(after.record, 'the window is now tracked');
    assert.equal(after.record[set[0].id], a.id);
  });

  it('6. a pinned tab you added by hand survives reset untouched, to the right of the set', T, async () => {
    // Slots on 127.0.0.1 only, so the hand-pinned localhost tab can't match a slot by host.
    const set = [entry(`${server.h1}/a`, 'Alpha'), entry(`${server.h1}/c#top`, 'Charlie')];
    await h.setSet(set);
    const win = await h.createWindow({ url: home(6) });
    const before = await h.waitForSet(win.id, set);
    const [a, c] = before.tabs;

    const manualUrl = `${server.h2}/manual`;
    const manual = await h.openTab({ windowId: win.id, url: manualUrl, pinned: true, active: false });
    await h.moveTab(manual.id, 0);
    await h.navigateTab(a.id, `${server.h1}/away-a`);
    await h.closeTab(c.id);
    const manualHits = server.hits(manualUrl);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    assert.equal(r.restored, 1, `restored: ${JSON.stringify(r)}`);
    assert.equal(r.navigated, 1, `navigated: ${JSON.stringify(r)}`);

    const after = await h.waitForSet(win.id, set);
    const m = after.tabs.find((t) => t.id === manual.id);
    assert.ok(m, `the hand-pinned tab still exists\n${describeSnapshot(after)}`);
    assert.equal(m.pinned, true);
    assert.equal(m.index, set.length, 'it sits right after the set');
    assert.equal(m.url, manualUrl, 'it was not navigated');
    assert.equal(server.hits(manualUrl), manualHits, 'it was not reloaded');
    assert.equal(after.tabs[0].id, a.id, 'slot A kept its tab');
    assert.ok(!Object.values(after.record).includes(manual.id), 'the hand-pinned tab is not mapped to a slot');
  });

  it('extra: in a tracked window, a hand-pinned tab on a closed slot\'s host is not adopted', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('no-host-adopt') });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c] = before.tabs;

    await h.closeTab(b.id);
    // Same host as slot B (localhost), different path.
    const manualUrl = `${server.h2}/manual-b`;
    const manual = await h.openTab({ windowId: win.id, url: manualUrl, pinned: true, active: false });
    const manualHits = server.hits(manualUrl);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    const after = await h.waitForSet(win.id, set);
    const m = after.tabs.find((t) => t.id === manual.id);
    assert.ok(m, `the hand-pinned tab still exists\n${describeSnapshot(after)}`);
    assert.equal(m.url, manualUrl, 'the hand-pinned tab keeps its URL');
    assert.equal(m.pinned, true);
    assert.equal(m.index, set.length, 'it stays to the right of the set');
    assert.equal(server.hits(manualUrl), manualHits, 'it was not reloaded');
    assert.equal(after.tabs[0].id, a.id);
    assert.ok(![b.id, manual.id].includes(after.tabs[1].id), 'slot B is a new tab');
    assert.equal(after.tabs[2].id, c.id);
    assert.equal(r.restored, 1, `restored: ${JSON.stringify(r)}`);
    assert.ok(!Object.values(after.record).includes(manual.id), 'the hand-pinned tab is not mapped to a slot');
  });

  it('7a. capture-window saves pinned tabs as the set, reuses IDs, and new windows get it', T, async () => {
    const [a0, b0] = [entry(`${server.h1}/a`, 'Alpha'), entry(`${server.h2}/b`, 'Bravo')];
    await h.setSet([a0, b0]);
    const win = await h.createWindow({ url: home('7a') });
    const before = await h.waitForSet(win.id, [a0, b0]);
    const [a, b] = before.tabs;

    // Navigate B within its host, add a new pinned tab D, and reorder to B, A, D.
    await h.navigateTab(b.id, `${server.h2}/b2`);
    const d = await h.openTab({ windowId: win.id, url: `${server.h1}/d`, pinned: true, active: false });
    await h.moveTab(b.id, 0);
    await waitFor(async () => (await h.getTab(b.id)).index === 0, { message: 'tab B to move to index 0' });

    const r = await h.send({ type: 'capture-window', windowId: win.id });
    assertOk(r, 'capture-window');
    const urls = [`${server.h2}/b2`, `${server.h1}/a`, `${server.h1}/d`];
    assert.deepEqual(r.set.map((e) => e.url), urls, 'captured left to right');
    assert.equal(r.set[0].id, b0.id, 'B reuses its slot ID (same host)');
    assert.equal(r.set[1].id, a0.id, 'A reuses its slot ID (exact match)');
    assert.ok(r.set[2].id && ![a0.id, b0.id].includes(r.set[2].id), 'D gets a new ID; each old slot is used once');
    assert.deepEqual(r.set.map((e) => e.title), ['Page /b2', 'Page /a', 'Page /d'], 'titles come from the tabs');
    assert.deepEqual(await h.getSet(), r.set, 'the set in sync storage matches the response');

    const snap = await h.snapshot(win.id);
    assert.ok(snap.record, 'the captured window is tracked');
    assert.deepEqual(r.set.map((e) => snap.record[e.id]), [b.id, a.id, d.id], 'the record maps slots to the captured tabs');

    const rr = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(rr, 'reset-window after capture');
    assert.deepEqual([rr.restored, rr.navigated], [0, 0], `nothing to restore after capture: ${JSON.stringify(rr)}`);
    const settled = await h.waitForSet(win.id, r.set);
    assert.deepEqual(pinnedIds(settled), [b.id, a.id, d.id], 'no duplicates after capture + reset');

    const w2 = await h.createWindow({ url: home('7a-2') });
    const s2 = await h.waitForSet(w2.id, r.set);
    assert.equal(s2.tabs.length, r.set.length + 1, describeSnapshot(s2));
  });

  it('7b. capture-window with no pinned tabs returns no-pinned-tabs and keeps the set', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('7b') });
    const before = await h.waitForSet(win.id, set);
    await h.removeTab(before.tabs.filter((t) => t.pinned).map((t) => t.id));
    await waitFor(async () => (await h.snapshot(win.id)).tabs.every((t) => !t.pinned), { message: 'pinned tabs to close' });

    const r = await h.send({ type: 'capture-window', windowId: win.id });
    assert.deepEqual(r, { ok: false, error: 'no-pinned-tabs' });
    assert.deepEqual(await h.getSet(), set, 'the set is unchanged');
  });

  it('8. a popup window gets no pinned tabs', T, async () => {
    const set = abc();
    await h.setSet(set);
    const popup = await h.createWindow({ type: 'popup', url: home('popup') });
    // A normal window created afterward proves the extension is processing onCreated events.
    const normal = await h.createWindow({ url: home('normal') });
    await h.waitForSet(normal.id, set);
    await h.settle([popup.id, normal.id]);
    const snap = await h.snapshot(popup.id);
    assert.equal(snap.window.type, 'popup');
    assert.equal(snap.tabs.length, 1, describeSnapshot(snap));
    assert.equal(snap.tabs[0].pinned, false);
    assert.equal(snap.record, null, 'popup windows are never tracked');

    // An explicit reset-window on a popup window is refused and doesn't touch it.
    const r = await h.send({ type: 'reset-window', windowId: popup.id });
    assert.deepEqual(r, { ok: false, error: 'unsupported-window' });
    await h.settle([popup.id]);
    const after = await h.snapshot(popup.id);
    assert.equal(after.tabs.length, 1, `reset-window must skip popup windows\n${describeSnapshot(after)}`);
    assert.equal(after.tabs[0].pinned, false);
  });

  it('extra: reset-window with an empty set returns empty-set and changes nothing', T, async () => {
    const win = await h.createWindow({ url: home('empty') });
    const manual = await h.openTab({ windowId: win.id, url: `${server.h1}/manual`, pinned: true, active: false });
    await h.settle([win.id]);
    const before = await h.snapshot(win.id);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assert.deepEqual(r, { ok: false, error: 'empty-set' });
    await h.settle([win.id]);
    const after = await h.snapshot(win.id);
    assert.deepEqual(after.tabs.map((t) => [t.id, t.pinned, t.url]), before.tabs.map((t) => [t.id, t.pinned, t.url]));
  });

  it('extra: reset closes the tab of a slot removed from the set', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('removed') });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c, own] = before.tabs;

    // Remove slot B the way the options page does, keeping the other IDs.
    const remaining = [set[0], set[2]];
    const saved = await h.inDriver(async (entries) => {
      const m = await import(chrome.runtime.getURL('lib/pinned-set.js'));
      return m.savePinnedSet(entries);
    }, remaining);
    assert.deepEqual(saved.map((e) => e.id), remaining.map((e) => e.id), 'savePinnedSet keeps the IDs');

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    await waitFor(async () => !(await h.getTab(b.id)), { message: "the removed slot's tab to close" });
    const after = await h.waitForSet(win.id, remaining);
    assert.deepEqual(after.tabs.map((t) => t.id), [a.id, c.id, own.id], `the others remain\n${describeSnapshot(after)}`);
    assert.deepEqual(Object.keys(after.record).sort(), remaining.map((e) => e.id).sort(), 'the record drops the removed slot');
  });

  it('9. race: creating a window and resetting it at once makes no duplicates', T, async () => {
    const set = abc();
    await h.setSet(set);
    for (let i = 0; i < 3; i++) {
      const { windowId, responses } = await h.inDriver(async (url) => {
        const w = await chrome.windows.create({ url });
        // One reset right away, and two more racing each other.
        const responses = await Promise.all([
          chrome.runtime.sendMessage({ type: 'reset-window', windowId: w.id }),
          chrome.runtime.sendMessage({ type: 'reset-window', windowId: w.id }),
          chrome.runtime.sendMessage({ type: 'reset-window', windowId: w.id }),
        ]);
        return { windowId: w.id, responses };
      }, home(`race-${i}`));
      responses.forEach((r) => assertOk(r, 'racing reset-window'));
      const snap = await h.waitForSet(windowId, set);
      assert.equal(snap.tabs.length, set.length + 1, `iteration ${i}: no duplicates\n${describeSnapshot(snap)}`);
      assert.equal(Object.keys(snap.record).length, set.length, 'the record has one entry per slot');
    }
  });

  // Positional adoption runs only on onStartup and onInstalled (update). The extension reload
  // case (last in this file) and test/restart.test.js cover it through those real paths.
  it('10. recovery: on reset, an untracked window adopts its tabs by exact and same-host match', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home(10) });
    const before = await h.waitForSet(win.id, set);
    const ids = pinnedIds(before);

    await h.clearSession(); // The window is now untracked.
    // Slot B is on localhost. Move its tab to another localhost path so only a same-host match adopts it.
    await h.navigateTab(ids[1], `${server.h2}/b-moved`);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    assert.equal(r.restored, 0, `no tabs created: ${JSON.stringify(r)}`);
    assert.equal(r.navigated, 1, `only slot B navigated: ${JSON.stringify(r)}`);
    const after = await h.waitForSet(win.id, set);
    assert.equal(after.tabs.length, set.length + 1, `no duplicates\n${describeSnapshot(after)}`);
    assert.deepEqual(pinnedIds(after), ids, 'each existing tab was adopted into its own slot');
  });

  it('extra: on reset, an untracked window never adopts a pinned tab on an unrelated host', T, async () => {
    // A window opened before the set existed, holding a pinned tab you added by hand.
    const win = await h.createWindow({ url: home('unrelated') });
    const unrelatedUrl = `${server.h2}/unrelated`;
    const unrelated = await h.openTab({ windowId: win.id, url: unrelatedUrl, pinned: true, active: false });
    // Slots on 127.0.0.1 only, so the localhost tab matches no slot by URL or host.
    const set = [entry(`${server.h1}/a`, 'Alpha'), entry(`${server.h1}/c#top`, 'Charlie')];
    await h.setSet(set);
    await h.clearSession();
    const unrelatedHits = server.hits(unrelatedUrl);

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window');
    assert.equal(r.restored, set.length, `the set's tabs are created: ${JSON.stringify(r)}`);
    assert.equal(r.navigated, 0, `nothing is navigated: ${JSON.stringify(r)}`);
    const after = await h.waitForSet(win.id, set);
    const u = after.tabs.find((t) => t.id === unrelated.id);
    assert.ok(u, `the unrelated pinned tab still exists\n${describeSnapshot(after)}`);
    assert.equal(u.url, unrelatedUrl, 'it keeps its URL');
    assert.equal(u.pinned, true);
    assert.equal(u.index, set.length, 'it stays to the right of the set');
    assert.equal(server.hits(unrelatedUrl), unrelatedHits, 'it was not reloaded');
    assert.ok(!Object.values(after.record).includes(unrelated.id), 'it is not mapped to a slot');
  });

  it('11. chrome.commands.getAll() lists reset-window and reset-tab', T, async () => {
    const commands = await h.sw(() => chrome.commands.getAll());
    const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
    assert.ok(byName['reset-window'], `commands: ${JSON.stringify(commands)}`);
    assert.ok(byName['reset-tab'], `commands: ${JSON.stringify(commands)}`);
    assert.equal(byName['reset-window'].description, 'Reset pinned tabs in this window');
    assert.equal(byName['reset-tab'].description, 'Reset the current pinned tab');
  });

  it('12. the popup and options pages load without console errors (screenshots saved)', T, async () => {
    const dir = await ensureArtifactsDir();
    const failures = [];

    // Empty state first.
    {
      const { page, errors, ready } = await h.openExtensionPage('popup/popup.html', { viewport: { width: 380, height: 560 } });
      await emulateScheme(page, 'light');
      await page.screenshot({ path: path.join(dir, 'popup-empty.png'), fullPage: true });
      if (errors.length) failures.push(`popup (empty set): ${errors.join(' | ')}`);
      if (!ready) failures.push('popup (empty set): list never reached aria-busy="false"');
      await page.close();
    }

    const set = abc();
    await h.setSet(set);
    for (const [name, p, viewport] of [
      ['popup', 'popup/popup.html', { width: 380, height: 560 }],
      ['options', 'options/options.html', { width: 1000, height: 900 }],
    ]) {
      const { page, errors, ready } = await h.openExtensionPage(p, { viewport });
      if (!ready) failures.push(`${name}: list never reached aria-busy="false"`);
      await page.bringToFront();
      // Emulate both schemes explicitly; otherwise the host OS setting decides.
      for (const scheme of ['light', 'dark']) {
        await emulateScheme(page, scheme);
        await page.screenshot({ path: path.join(dir, `${name}-${scheme}.png`), fullPage: true });
      }
      if (errors.length) failures.push(`${name}: ${errors.join(' | ')}`);
      await page.close();
    }
    assert.deepEqual(failures, [], 'console errors');
  });

  it('extra: UI pages show the spec strings and are labeled', T, async () => {
    const set = abc();
    await h.setSet(set);
    const audit = () => {
      const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
      const name = (el) =>
        (el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ') ||
          [...(el.labels || [])].map((l) => l.textContent).join(' ') ||
          (el.tagName === 'BUTTON' || el.tagName === 'A' ? el.textContent : '') ||
          el.getAttribute('title') ||
          '').trim();
      const unlabeled = [...document.querySelectorAll('input, select, textarea, button, a[href]')]
        .filter((el) => el.type !== 'hidden' && visible(el) && !name(el))
        .map((el) => el.outerHTML.slice(0, 120));
      return {
        text: document.body.innerText,
        values: [...document.querySelectorAll('input')].map((i) => i.value),
        unlabeled,
        live: Boolean(document.querySelector('[aria-live], [role="status"], [role="alert"]')),
      };
    };

    // openExtensionPage waits until the page has rendered the set.
    const popup = await h.openExtensionPage('popup/popup.html');
    const p = await popup.page.evaluate(audit);
    await popup.page.close();
    for (const s of ['Stay Pinned', 'Reset pinned tabs', "Save this window's pinned tabs", 'Edit pinned tabs', 'Change shortcuts', 'Alpha']) {
      assert.ok(p.text.includes(s), `popup shows "${s}"`);
    }
    assert.deepEqual(p.unlabeled, [], 'popup controls have accessible names');

    const options = await h.openExtensionPage('options/options.html');
    const o = await options.page.evaluate(audit);
    await options.page.close();
    for (const s of ['Add tab', 'Save', "Use this window's pinned tabs", 'Change shortcuts', 'How it works']) {
      assert.ok(o.text.includes(s), `options shows "${s}"`);
    }
    for (const e of set) assert.ok(o.values.includes(e.url), `options lists ${e.url} in an input`);
    assert.deepEqual(o.unlabeled, [], 'options controls have accessible names');
    assert.ok(o.live, 'options has an aria-live status region');
  });

  it('extra: popup buttons reset the window and capture its pinned tabs', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('popup-ui') });
    const before = await h.waitForSet(win.id, set);
    const b = before.tabs[1];
    await h.navigateTab(b.id, `${server.h1}/elsewhere`);

    // Opened as a tab in the window, so the popup's chrome.windows.getCurrent() is that window.
    const page = await h.openExtensionPageInWindow(win.id, 'popup/popup.html');
    const statusText = () => page.$eval('#status', (el) => el.textContent.trim());
    await page.click('#reset-button');
    await waitFor(statusText, { message: 'the popup to show a reset result' });
    await h.waitForTab(b.id, (t) => tabUrl(t) === set[1].url, 'the popup reset to bring slot B back');

    const dUrl = `${server.h2}/d`;
    const d = await h.openTab({ windowId: win.id, url: dUrl, pinned: true, active: false });
    await page.click('#capture-button');
    await page.waitForSelector('#capture-confirm-button', { visible: true, timeout: 3000 });
    await page.click('#capture-confirm-button');
    const saved = await waitFor(async () => {
      const s = await h.getSet();
      return s?.length === 4 ? s : null;
    }, { message: 'the popup capture to save four tabs' });
    assert.deepEqual(saved.map((e) => e.url), [...set.map((e) => e.url), dUrl]);
    assert.deepEqual(saved.slice(0, 3).map((e) => e.id), set.map((e) => e.id), 'capture keeps the slot IDs');
    await page.close();
  });

  it('extra: options page lists rows by slot ID and saves edits without changing IDs', T, async () => {
    const set = abc();
    await h.setSet(set);
    const { page, errors } = await h.openExtensionPage('options/options.html');
    const ids = await page.$$eval('li.row[data-id]', (els) => els.map((el) => el.dataset.id));
    assert.deepEqual(ids, set.map((e) => e.id), 'one row per slot, in order');

    const title = 'li.row:first-child input[id$="-title"]';
    await page.$eval(title, (el) => { el.value = ''; });
    await page.type(title, 'Renamed');
    await page.click('#save-button');
    const saved = await waitFor(async () => {
      const s = await h.getSet();
      return s?.[0]?.title === 'Renamed' ? s : null;
    }, { message: 'the options page to save the new title' });
    assert.deepEqual(saved.map((e) => e.id), set.map((e) => e.id), 'IDs survive the edit');
    assert.deepEqual(saved.map((e) => e.url), set.map((e) => e.url));
    assert.deepEqual(errors, [], 'no console errors while editing');
    await page.close();
  });

  it('extra: closing a window deletes its record', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('close') });
    await h.waitForSet(win.id, set);
    await h.sw((id) => chrome.windows.remove(id), win.id);
    await waitFor(async () => !(String(win.id) in (await h.getRecords())), {
      timeout: 3000,
      message: `the record for closed window ${win.id} to be deleted`,
    });
  });

  // Keep this last: reloading the extension restarts the service worker and closes extension pages.
  it('extra: extension reload (onInstalled update) re-adopts tabs, positionally too, and creates none', T, async () => {
    const set = abc();
    await h.setSet(set);
    const win = await h.createWindow({ url: home('reload') });
    const before = await h.waitForSet(win.id, set);
    const [a, b, c] = before.tabs;
    // Slot A is on 127.0.0.1. Move its tab to localhost so only a positional match can adopt it.
    await h.navigateTab(a.id, `${server.h2}/elsewhere`);
    await h.closeTab(c.id);

    const oldTarget = h.workerTarget;
    await h.worker.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50)).catch(() => {});
    await h.attachWorker({ exclude: oldTarget });

    let snap;
    await waitFor(
      async () => {
        snap = await h.snapshot(win.id);
        return snap.record && snap.record[set[0].id] === a.id && snap.record[set[1].id] === b.id;
      },
      { message: 'the reloaded extension to re-adopt the window', diagnose: () => describeSnapshot(snap) },
    );
    await h.settle([win.id]);
    snap = await h.snapshot(win.id);
    assert.equal(snap.tabs.filter((t) => t.pinned).length, 2, `create: false on update\n${describeSnapshot(snap)}`);
    assert.equal(tabUrl(snap.tabs[0]), `${server.h2}/elsewhere`, 'navigate: false on update');
    assert.ok(!(set[2].id in snap.record), 'the closed slot stays unfilled');

    const r = await h.send({ type: 'reset-window', windowId: win.id });
    assertOk(r, 'reset-window after reload');
    assert.deepEqual([r.restored, r.navigated], [1, 1], JSON.stringify(r));
    const after = await h.waitForSet(win.id, set);
    const ids = pinnedIds(after);
    assert.equal(ids.length, set.length, `no duplicates after reset\n${describeSnapshot(after)}`);
    assert.deepEqual(ids.slice(0, 2), [a.id, b.id], 'the adopted tabs are reused, and tab A is back at its URL');
  });
});
