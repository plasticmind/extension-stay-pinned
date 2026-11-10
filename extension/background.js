import { getPinnedSet, savePinnedSet, isPinnableUrl, matchKey, hostKey } from './lib/pinned-set.js';

// Listeners register synchronously so that Chrome delivers the event that woke
// the service worker.

// Session restore can deliver its windows through onCreated, so a new window
// matches by position only when it looks restored. See reconcileWindow.
chrome.windows.onCreated.addListener(
  (win) => run(queueReconcile(win.id, { create: true, navigate: false, positional: 'restored' })),
  { windowTypes: ['normal'] },
);

chrome.windows.onRemoved.addListener((windowId) => {
  run(withWindowLock(windowId, () => chrome.storage.session.remove(recordKey(windowId))));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  run(replaceTabId(addedTabId, removedTabId));
});

chrome.runtime.onStartup.addListener(() => {
  run(reconcileAllWindows({ create: true, navigate: false }));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') run(chrome.runtime.openOptionsPage());
  if (reason === 'update') run(reconcileAllWindows({ create: false, navigate: false }));
});

// Shortcuts and messages share these actions. A missing windowId or tabId
// falls back to the last focused normal window and its active tab.
const actions = new Map([
  ['reset-window', async ({ windowId }) => resetWindow(windowId ?? (await focusedTarget()).windowId)],
  ['reset-tab', async ({ tabId }) => resetTab(tabId ?? (await focusedTarget()).tabId)],
  ['capture-window', async ({ windowId }) => captureWindow(windowId ?? (await focusedTarget()).windowId)],
]);

chrome.commands.onCommand.addListener((command, tab) => {
  const action = actions.get(command);
  if (action) run(action(tab?.id >= 0 ? { windowId: tab.windowId, tabId: tab.id } : {}));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = actions.get(message?.type);
  if (!action) return false;
  action(message).then(
    (data) => sendResponse({ ok: true, ...data }),
    (error) => sendResponse({ ok: false, error: error?.message ?? String(error) }),
  );
  return true;
});

// Reconcile

// Makes the window's pinned tabs match the set. See "Reconcile algorithm" in SPEC.md.
// Only a reset navigates, and only a reset changes a window that's already
// tracked. Automatic triggers leave tracked windows alone.
// Returns { restored, navigated }, or { skipped: reason } when it does nothing.
// Run it through reconcileWithRetry inside the window lock, never directly.
async function reconcileWindow(windowId, { create, navigate, positional = false }) {
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) return { skipped: 'no-window' };
  if (!isEligible(win)) return { skipped: 'unsupported-window' };
  const [set, record, tabs] = await Promise.all([getPinnedSet(), readRecord(windowId), queryTabs(windowId)]);
  if (set.length === 0) return { skipped: 'empty-set' };
  if (record && !navigate) return { skipped: 'tracked' };

  // Keep recorded tabs, then adopt unclaimed pinned tabs into the empty slots.
  // A tracked window adopts exact matches only, so a tab you pinned by hand on
  // the same site as a closed slot is never taken over.
  const assigned = new Map();
  for (const slot of set) {
    const tab = tabs.find((candidate) => candidate.id === record?.[slot.id]);
    if (tab) assigned.set(slot, tab);
  }
  const pinned = tabs.filter((tab) => tab.pinned);
  const keys = record ? [matchKey] : [matchKey, hostKey];
  pairByUrl(set, pinned, (slot) => slot.url, tabUrl, { keys, pairs: assigned });
  // positional: true (startup and update) always pairs the leftover pinned tabs
  // by position. 'restored' (a new window) pairs them only when they fill every
  // empty slot, the way a window restored from your last session does. A
  // window you drag a hand-pinned tab into doesn't, so that tab is left alone.
  if (!record && positional) {
    const claimed = new Set(assigned.values());
    const leftover = pinned.filter((tab) => !claimed.has(tab)).length;
    const empty = set.length - assigned.size;
    if (positional === true || leftover >= empty) pairInOrder(set, pinned, assigned);
  }

  const created = new Set();
  if (create) {
    for (const [index, slot] of set.entries()) {
      if (assigned.has(slot)) continue;
      const options = { windowId, url: slot.url, pinned: true, active: false, index };
      const tab = await attempt(chrome.tabs.create(options));
      if (!tab) continue;
      assigned.set(slot, tab);
      created.add(tab.id);
    }
  }
  let restored = created.size;
  for (const tab of assigned.values()) {
    if (!tab.pinned && (await succeeded(chrome.tabs.update(tab.id, { pinned: true })))) restored++;
  }

  // Pinning and creating shift indexes, so read the window again before ordering.
  const live = await queryTabs(windowId);
  const liveById = new Map(live.map((tab) => [tab.id, tab]));
  const slotTabs = set
    .map((slot) => ({ slot, tab: liveById.get(assigned.get(slot)?.id) }))
    .filter(({ tab }) => tab);
  await moveToFront(slotTabs.map(({ tab }) => tab.id), live.map((tab) => tab.id));

  let navigated = 0;
  if (navigate) {
    const away = slotTabs.filter(({ slot, tab }) => !created.has(tab.id) && tabUrl(tab) !== slot.url);
    const results = await Promise.all(
      away.map(({ slot, tab }) => succeeded(chrome.tabs.update(tab.id, { url: slot.url }))),
    );
    navigated = results.filter(Boolean).length;

    // Close tabs whose slot you removed from the set, unless a slot adopted them.
    const slotIds = new Set(set.map((slot) => slot.id));
    const inUse = new Set(slotTabs.map(({ tab }) => tab.id));
    const orphans = Object.entries(record ?? {})
      .filter(([slotId, tabId]) => !slotIds.has(slotId) && !inUse.has(tabId) && liveById.has(tabId))
      .map(([, tabId]) => succeeded(chrome.tabs.remove(tabId)));
    await Promise.all(orphans);
  }

  await writeRecord(windowId, Object.fromEntries(slotTabs.map(({ slot, tab }) => [slot.id, tab.id])));
  return { restored, navigated };
}

function queueReconcile(windowId, options) {
  return withWindowLock(windowId, () => reconcileWithRetry(windowId, options));
}

const DRAG_ERROR = 'user may be dragging a tab';
const DRAG_RETRY_MS = 250;
const DRAG_RETRY_LIMIT_MS = 10_000;

function isDragError(error) {
  return String(error?.message ?? error).includes(DRAG_ERROR);
}

// Chrome rejects every tab change while you drag a tab, and dragging a tab out
// into a new window fires onCreated mid-drag. A reconcile that hits the drag
// error throws before it saves the record, so it reruns from the start here.
async function reconcileWithRetry(windowId, options) {
  for (let waited = 0; ; waited += DRAG_RETRY_MS) {
    try {
      return await reconcileWindow(windowId, options);
    } catch (error) {
      if (!isDragError(error) || waited >= DRAG_RETRY_LIMIT_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, DRAG_RETRY_MS));
    }
  }
}

// Automatic triggers stay silent, but a reset someone asked for reports why it
// did nothing.
async function resetWindow(windowId) {
  const { skipped, ...counts } = await queueReconcile(windowId, { create: true, navigate: true });
  if (skipped) throw new Skip(skipped);
  return counts;
}

// Runs on startup and after an update, when every window is untracked and its
// pinned tabs came from the set, so matching by position is safe.
async function reconcileAllWindows(options) {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  await Promise.all(windows.map((win) => queueReconcile(win.id, { ...options, positional: true })));
}

// Greedily pairs each unpaired item in `left` with the first unused item in
// `right` whose URL has the same key. Each key is one full pass over `left`,
// so every exact match (ignoring the hash) wins before any same-host match.
// Adds the pairs to `pairs` and returns it.
function pairByUrl(left, right, leftUrl, rightUrl, { keys = [matchKey, hostKey], pairs = new Map() } = {}) {
  const used = new Set(pairs.values());
  for (const key of keys) {
    for (const item of left) {
      if (pairs.has(item)) continue;
      const wanted = key(leftUrl(item));
      if (wanted === null) continue;
      const match = right.find((other) => !used.has(other) && key(rightUrl(other)) === wanted);
      if (!match) continue;
      pairs.set(item, match);
      used.add(match);
    }
  }
  return pairs;
}

function pairInOrder(left, right, pairs) {
  const used = new Set(pairs.values());
  const free = right.filter((other) => !used.has(other));
  for (const item of left) {
    if (free.length === 0) break;
    if (!pairs.has(item)) pairs.set(item, free.shift());
  }
}

// Moves tabIds to indexes 0..n-1 in order. `order` lists every tab ID in the
// window by index, and tabs already in place don't move.
async function moveToFront(tabIds, order) {
  let index = 0;
  for (const id of tabIds) {
    if (order[index] !== id) {
      if (!(await succeeded(chrome.tabs.move(id, { index })))) continue;
      order = order.filter((other) => other !== id);
      order.splice(index, 0, id);
    }
    index++;
  }
}

// Reset tab, capture, and tab replacement

async function resetTab(tabId) {
  if (tabId == null) throw new Skip('no-tab');
  const { windowId } = await chrome.tabs.get(tabId);
  return withWindowLock(windowId, async () => {
    // Maps the tabs of an untracked window. A tracked window is left as it is.
    await reconcileWithRetry(windowId, { create: false, navigate: false });
    const [set, record = {}, tab] = await Promise.all([
      getPinnedSet(),
      readRecord(windowId),
      chrome.tabs.get(tabId),
    ]);
    const slot = set.find((entry) => record[entry.id] === tabId);
    if (!slot || tabUrl(tab) === slot.url) return { reset: false };
    await chrome.tabs.update(tabId, { url: slot.url });
    return { reset: true };
  });
}

async function captureWindow(windowId) {
  return withWindowLock(windowId, async () => {
    if (!isEligible(await chrome.windows.get(windowId))) throw new Error('unsupported-window');
    const [tabs, oldSet] = await Promise.all([queryTabs(windowId), getPinnedSet()]);
    const pinned = tabs.filter((tab) => tab.pinned && isPinnableUrl(tabUrl(tab)));
    if (pinned.length === 0) throw new Error('no-pinned-tabs');

    // Reusing slot IDs keeps other open windows mapped to their existing tabs.
    const reused = pairByUrl(pinned, oldSet, tabUrl, (slot) => slot.url);
    const entries = pinned.map((tab) => ({
      id: reused.get(tab)?.id ?? crypto.randomUUID(),
      url: tabUrl(tab),
      title: tab.title,
    }));
    const set = await savePinnedSet(entries);
    await writeRecord(windowId, Object.fromEntries(entries.map((entry, i) => [entry.id, pinned[i].id])));
    return { set };
  });
}

// Chrome sometimes swaps a tab's contents for a new tab with a new ID, for
// example after prerendering. Moving the slot to the new ID keeps it tracked.
async function replaceTabId(addedTabId, removedTabId) {
  const tab = await chrome.tabs.get(addedTabId).catch(() => null);
  if (!tab) return;
  await withWindowLock(tab.windowId, async () => {
    const record = await readRecord(tab.windowId);
    const slotId = Object.keys(record ?? {}).find((id) => record[id] === removedTabId);
    if (slotId) await writeRecord(tab.windowId, { ...record, [slotId]: addedTabId });
  });
}

// Serialization and storage

const windowLocks = new Map();

// Chains tasks per window so that two reconciles of one window never overlap.
function withWindowLock(windowId, task) {
  const result = (windowLocks.get(windowId) ?? Promise.resolve()).then(task);
  const tail = result.catch(() => {});
  windowLocks.set(windowId, tail);
  tail.then(() => {
    if (windowLocks.get(windowId) === tail) windowLocks.delete(windowId);
  });
  return result;
}

function recordKey(windowId) {
  return `window:${windowId}`;
}

async function readRecord(windowId) {
  const key = recordKey(windowId);
  return (await chrome.storage.session.get(key))[key];
}

function writeRecord(windowId, record) {
  return chrome.storage.session.set({ [recordKey(windowId)]: record });
}

// Helpers

function isEligible(win) {
  return win.type === 'normal' && !win.incognito;
}

function tabUrl(tab) {
  return tab.pendingUrl || tab.url;
}

async function queryTabs(windowId) {
  return (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
}

async function focusedTarget() {
  const win = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'], populate: true })
    .catch(() => {
      throw new Skip('no-window');
    });
  return { windowId: win.id, tabId: win.tabs.find((tab) => tab.active)?.id };
}

// A tab can close at any moment, so a failed tab operation skips that tab
// instead of failing the whole reconcile. Resolves to the result, or null.
// The drag error still throws, because it blocks every tab, not just this one.
function attempt(operation) {
  return operation.catch((error) => {
    if (isDragError(error)) throw error;
    console.debug('Stay Pinned skipped a tab operation:', error?.message ?? error);
    return null;
  });
}

function succeeded(operation) {
  return attempt(operation.then(() => true)).then(Boolean);
}

// An action that had nothing to do, such as a reset with an empty set. A
// message reports its code, and a shortcut, which has no UI, logs it quietly.
class Skip extends Error {}

function run(promise) {
  promise.catch((error) => {
    if (error instanceof Skip) console.debug('Stay Pinned did nothing:', error.message);
    else console.error('Stay Pinned:', error);
  });
}
