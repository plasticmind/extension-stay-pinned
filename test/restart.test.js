// Bonus: a real browser restart with session restore ("Continue where you left off").
// Launches a profile, sets up a window, closes Chrome, and relaunches the same profile.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Harness, abc, describeSnapshot, makeProfileDir, tabUrl, waitFor } from './helpers/harness.js';
import { startServer } from './helpers/server.js';

describe('Stay Pinned across a browser restart', () => {
  let server;
  let profile;
  let h;

  after(async () => {
    await h?.close();
    await server?.close();
    if (profile) await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  it('bonus: session restore + onStartup adopts restored tabs without duplicates', { timeout: 90000 }, async () => {
    server = await startServer();
    profile = await makeProfileDir();
    // restore_on_startup: 1 is "Continue where you left off".
    await fsp.mkdir(path.join(profile, 'Default'), { recursive: true });
    await fsp.writeFile(
      path.join(profile, 'Default', 'Preferences'),
      JSON.stringify({ session: { restore_on_startup: 1 } }),
    );

    // First run: one window with the set, with slot B (localhost) navigated to another host,
    // so only a positional match on onStartup can adopt it.
    // Install once through CDP so the extension stays in the profile. With --load-extension,
    // Chrome treats every launch as a fresh install and never fires onStartup.
    h = await Harness.launch(server, { userDataDir: profile, install: 'cdp' });
    await h.setupDriver();
    const set = abc(server);
    await h.setSet(set);
    const homeUrl = `${server.h1}/home-restart`;
    const win = await h.createWindow({ url: homeUrl });
    const before = await h.waitForSet(win.id, set);
    await h.navigateTab(before.tabs[1].id, `${server.h1}/elsewhere-b`);
    await h.browser.close();
    h = null;

    // Second run: same profile, extension loaded from the profile, so onStartup fires.
    // Don't pass a startup URL, so Chrome restores the session.
    h = await Harness.launch(server, { userDataDir: profile, ignoreDefaultArgs: ['about:blank'], install: 'profile' });
    let restored;
    await waitFor(
      async () => {
        const wins = await h.sw(() => chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }));
        restored = wins.find((w) => w.tabs.some((t) => tabUrl(t) === homeUrl));
        return restored;
      },
      { timeout: 15000, message: 'Chrome to restore the window from the previous session' },
    );
    const windowId = restored.id;
    let snap;
    await waitFor(
      async () => {
        snap = await h.snapshot(windowId);
        return snap.record && set.every((e) => snap.record[e.id] != null);
      },
      { timeout: 15000, message: 'onStartup to adopt the restored window', diagnose: () => describeSnapshot(snap) },
    );
    await h.settle([windowId]);
    snap = await h.snapshot(windowId);
    const pinned = snap.tabs.filter((t) => t.pinned);
    assert.equal(pinned.length, set.length, `no duplicates after restart\n${describeSnapshot(snap)}`);
    assert.deepEqual(set.map((e) => snap.record[e.id]), pinned.map((t) => t.id), 'slots map to restored tabs in order');
    assert.equal(tabUrl(pinned[1]), `${server.h1}/elsewhere-b`, 'onStartup does not navigate (navigate: false)');

    // A reset now brings slot B back without creating anything.
    await h.setupDriver({ waitForInstallPage: false, avoidWindowIds: [windowId] });
    const r = await h.send({ type: 'reset-window', windowId });
    assert.equal(r?.ok, true, JSON.stringify(r));
    assert.deepEqual([r.restored, r.navigated], [0, 1], JSON.stringify(r));
    const after = await h.waitForSet(windowId, set, { loaded: false });
    const afterPinned = after.tabs.filter((t) => t.pinned).map((t) => t.id);
    assert.deepEqual(afterPinned, pinned.map((t) => t.id), 'no duplicates, and the same restored tabs are reused');
  });
});
