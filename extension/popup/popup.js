import { getPinnedSet, hostKey, SET_KEY } from '../lib/pinned-set.js';
import {
  errorText, linkToShortcuts, plural, renderFavicon, renderShortcuts, send, setBusy, setStatus, setUpCaptureConfirm,
} from '../ui/shared.js';

const els = {
  editLink: document.getElementById('edit-link'),
  count: document.getElementById('set-count'),
  list: document.getElementById('set-list'),
  empty: document.getElementById('empty-state'),
  actions: document.getElementById('actions'),
  reset: document.getElementById('reset-button'),
  status: document.getElementById('status'),
};

const captureConfirm = setUpCaptureConfirm(() => capture());
let currentSet = [];
let busy = false;

els.reset.addEventListener('click', onReset);
captureConfirm.trigger.addEventListener('click', onCaptureClick);
els.editLink.addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    showStatus("Couldn't open the options page.", 'error');
  }
});
linkToShortcuts(document.getElementById('change-shortcuts'), (text) => showStatus(text, 'error'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && SET_KEY in changes) loadSet();
});

loadSet();
renderShortcuts(document.getElementById('shortcut-list'));

async function loadSet() {
  try {
    renderSet(await getPinnedSet());
  } catch {
    els.list.setAttribute('aria-busy', 'false');
    showStatus("Couldn't load your pinned tabs.", 'error');
  }
}

function renderSet(set) {
  currentSet = set;
  const isEmpty = set.length === 0;

  els.list.replaceChildren(...set.map(renderSetItem));
  els.list.setAttribute('aria-busy', 'false');
  els.list.hidden = isEmpty;
  els.empty.hidden = !isEmpty;
  els.count.textContent = isEmpty ? '' : `(${set.length})`;

  // With nothing saved, resetting does nothing, so saving becomes the main action.
  els.reset.hidden = isEmpty;
  captureConfirm.trigger.classList.toggle('button-primary', isEmpty);
}

function renderSetItem(entry) {
  const item = document.createElement('li');
  item.className = 'set-item';
  item.title = entry.url;

  const title = document.createElement('span');
  title.className = 'set-title';
  title.textContent = entry.title || describeUrl(entry.url);

  const host = document.createElement('span');
  host.className = 'set-host';
  host.textContent = describeUrl(entry.url);

  const text = document.createElement('div');
  text.className = 'set-text';
  text.append(title, host);
  item.append(renderFavicon(entry.url), text);
  return item;
}

function describeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return hostKey(url) || parsed.host;
    }
    if (parsed.protocol === 'file:') return decodeURIComponent(parsed.pathname);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

async function onReset() {
  if (busy) return;
  captureConfirm.close();
  const response = await request('reset-window');

  if (response.ok) {
    showStatus(describeReset(response), 'success');
  } else {
    showStatus(errorText(response.error, 'reset pinned tabs'), 'error');
    // The set was cleared somewhere else, so show the empty state.
    if (response.error === 'empty-set') loadSet();
  }
}

function describeReset({ restored, navigated }) {
  if (!restored && !navigated) return 'Your pinned tabs already match the saved set.';

  const parts = [];
  if (restored) parts.push(`restored ${plural(restored, 'tab')}`);
  if (navigated) {
    parts.push(`reset ${plural(navigated, 'tab')} to ${navigated === 1 ? 'its saved page' : 'their saved pages'}`);
  }
  const sentence = parts.join(' and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function onCaptureClick() {
  if (busy) return;
  if (currentSet.length === 0) {
    capture();
    return;
  }
  captureConfirm.open(`Replace your ${plural(currentSet.length, 'saved tab')} with the pinned tabs in this window?`);
}

async function capture() {
  if (busy) return;
  const response = await request('capture-window');
  captureConfirm.close();
  captureConfirm.trigger.focus();

  if (response.ok) {
    // The storage listener redraws the list.
    const count = response.set.length;
    showStatus(`Saved ${plural(count, 'pinned tab')}. New windows now open with ${count === 1 ? 'it' : 'them'}.`, 'success');
  } else {
    showStatus(errorText(response.error, "save this window's pinned tabs"), 'error');
  }
}

// Sends a request for the popup's window, with the action buttons marked busy.
async function request(type) {
  busy = true;
  setBusy(els.actions, [els.reset, ...captureConfirm.buttons], true);
  showStatus('');
  try {
    return await send({ type, windowId: await currentWindowId() });
  } finally {
    busy = false;
    setBusy(els.actions, [els.reset, ...captureConfirm.buttons], false);
  }
}

async function currentWindowId() {
  try {
    return (await chrome.windows.getCurrent()).id;
  } catch {
    // The background falls back to the last focused normal window.
    return undefined;
  }
}

function showStatus(text, tone) {
  setStatus(els.status, text, tone);
}
