import { getPinnedSet, savePinnedSet, isPinnableUrl, hostKey, SET_KEY } from '../lib/pinned-set.js';
import {
  errorText, linkToShortcuts, plural, renderFavicon, renderShortcuts, send, setBusy, setStatus, setUpCaptureConfirm,
} from '../ui/shared.js';

const els = {
  form: document.getElementById('set-form'),
  columnLabels: document.querySelector('.column-labels'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty-state'),
  add: document.getElementById('add-button'),
  save: document.getElementById('save-button'),
  status: document.getElementById('status'),
  dirtyNote: document.getElementById('dirty-note'),
  shortcuts: document.getElementById('shortcut-list'),
  template: document.getElementById('row-template'),
};

/**
 * Rows in display order. Each row keeps its slot `id` so open windows keep
 * tracking their tabs after an edit.
 * @type {{ id?: string, el: HTMLLIElement, title: HTMLInputElement,
 *   url: HTMLInputElement, error: HTMLElement, icon: HTMLElement,
 *   up: HTMLButtonElement, down: HTMLButtonElement, remove: HTMLButtonElement,
 *   iconTimer?: number }[]}
 */
let rows = [];
let nextKey = 1;
let savedSet = [];
let dirty = false;
let busy = false;

const captureConfirm = setUpCaptureConfirm(() => capture());

els.form.addEventListener('submit', onSave);
els.add.addEventListener('click', addRow);
els.rows.addEventListener('input', onRowInput);
els.rows.addEventListener('change', onRowChange);
els.rows.addEventListener('click', onRowClick);
captureConfirm.trigger.addEventListener('click', onCaptureClick);
linkToShortcuts(document.getElementById('change-shortcuts'), (text) => announce(text, 'error'));

// Pick up shortcut changes when you come back from the shortcuts page.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderShortcuts(els.shortcuts);
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});
chrome.storage.onChanged.addListener(onStorageChanged);

renderShortcuts(els.shortcuts);
loadSet();

async function loadSet() {
  try {
    const set = await getPinnedSet();
    renderRows(set);
    markSaved(set);
  } catch {
    renderRows([]);
    announce("Couldn't load your pinned tabs. Reload this page to try again.", 'error');
  } finally {
    els.rows.setAttribute('aria-busy', 'false');
  }
}

async function onStorageChanged(changes, area) {
  if (area !== 'sync' || !(SET_KEY in changes) || busy) return;
  let set;
  try {
    set = await getPinnedSet();
  } catch {
    return;
  }
  if (fingerprint(set) === fingerprint(savedSet)) return;

  if (dirty) {
    announce('The saved list changed in another window. If you save, your changes here replace it.');
    return;
  }
  renderRows(set);
  markSaved(set);
  announce('The saved list changed in another window. This page now shows the latest list.');
}

/* Rendering */

function renderRows(set) {
  rows = set.map((entry) => createRow(entry));
  els.rows.replaceChildren(...rows.map((row) => row.el));
  refresh();
}

function createRow(entry = {}) {
  const key = `row-${nextKey++}`;
  const el = els.template.content.firstElementChild.cloneNode(true);

  const row = {
    id: entry.id,
    el,
    title: el.querySelector('[data-field="title"]'),
    url: el.querySelector('[data-field="url"]'),
    error: el.querySelector('[data-error]'),
    icon: el.querySelector('.row-icon'),
    up: el.querySelector('[data-action="up"]'),
    down: el.querySelector('[data-action="down"]'),
    remove: el.querySelector('[data-action="remove"]'),
  };

  if (entry.id) el.dataset.id = entry.id;
  row.title.id = `${key}-title`;
  row.url.id = `${key}-url`;
  row.error.id = `${key}-url-error`;
  el.querySelector('[data-label="title"]').htmlFor = row.title.id;
  el.querySelector('[data-label="url"]').htmlFor = row.url.id;
  row.title.value = entry.title ?? '';
  row.url.value = entry.url ?? '';

  updateIcon(row);
  return row;
}

/** Updates labels, accessible names, button states, and the empty state. */
function refresh() {
  const isEmpty = rows.length === 0;
  els.rows.hidden = isEmpty;
  els.columnLabels.hidden = isEmpty;
  els.empty.hidden = !isEmpty;

  rows.forEach((row, index) => {
    const position = index + 1;
    const name = rowName(row, index);
    row.el.querySelector('[data-label="title"]').textContent = `Title for tab ${position}`;
    row.el.querySelector('[data-label="url"]').textContent = `URL for tab ${position}`;
    labelButton(row.up, `Move ${name} up`);
    labelButton(row.down, `Move ${name} down`);
    labelButton(row.remove, `Remove ${name}`);
    row.up.disabled = index === 0;
    row.down.disabled = index === rows.length - 1;
    row.title.placeholder = hostFor(normalizeUrl(row.url.value)) || 'Title';
  });
}

function labelButton(button, label) {
  button.setAttribute('aria-label', label);
  button.title = label;
}

function rowName(row, index) {
  return row.title.value.trim() || hostFor(normalizeUrl(row.url.value)) || `tab ${index + 1}`;
}

function updateIcon(row) {
  const url = normalizeUrl(row.url.value);
  if (url && isPinnableUrl(url)) {
    row.icon.replaceChildren(renderFavicon(url));
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'favicon-placeholder';
    row.icon.replaceChildren(placeholder);
  }
}

function hostFor(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return hostKey(url) || parsed.host;
    if (parsed.protocol === 'file:') return decodeURIComponent(parsed.pathname.split('/').pop() || '');
    return parsed.host;
  } catch {
    return '';
  }
}

/* Editing */

function findRow(target) {
  const el = target.closest('.row');
  return rows.find((row) => row.el === el);
}

function onRowInput(event) {
  const row = findRow(event.target);
  if (!row) return;
  markDirty();
  if (event.target === row.url) {
    clearError(row);
    clearTimeout(row.iconTimer);
    row.iconTimer = setTimeout(() => updateIcon(row), 400);
  }
  refresh();
}

// Errors appear only when you save. Showing one on blur shifts the layout
// between mousedown and mouseup, so the click on the next button gets lost.
function onRowChange(event) {
  const row = findRow(event.target);
  if (!row || event.target !== row.url) return;
  const url = normalizeUrl(row.url.value);
  if (url !== row.url.value) row.url.value = url;
  clearTimeout(row.iconTimer);
  updateIcon(row);
  refresh();
}

function onRowClick(event) {
  const button = event.target.closest('button[data-action]');
  const row = button && findRow(button);
  if (!row || button.disabled) return;

  const action = button.dataset.action;
  if (action === 'up') moveRow(row, -1, button);
  else if (action === 'down') moveRow(row, 1, button);
  else if (action === 'remove') removeRow(row);
}

function moveRow(row, delta, button) {
  const index = rows.indexOf(row);
  const target = index + delta;
  if (target < 0 || target >= rows.length) return;

  // Move the neighbor rather than the row itself, so focus stays on the
  // button you pressed.
  const neighbor = rows[target];
  if (delta < 0) row.el.after(neighbor.el);
  else row.el.before(neighbor.el);
  rows[target] = row;
  rows[index] = neighbor;

  markDirty();
  refresh();
  if (button.disabled) (delta < 0 ? row.down : row.up).focus();
  announce(`Moved ${rowName(row, target)} to position ${target + 1} of ${rows.length}.`);
}

function removeRow(row) {
  const index = rows.indexOf(row);
  const name = rowName(row, index);
  clearTimeout(row.iconTimer);
  rows.splice(index, 1);
  row.el.remove();

  markDirty();
  refresh();
  const next = rows[index] ?? rows[index - 1];
  (next ? next.remove : els.add).focus();
  announce(`Removed ${name}.`);
}

function addRow() {
  const row = createRow();
  rows.push(row);
  els.rows.append(row.el);
  markDirty();
  refresh();
  row.title.focus();
}

/* Validation */

/** Accepts a bare host, such as "mail.google.com", by assuming https. */
function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed || isPinnableUrl(trimmed)) return trimmed;
  const hasScheme = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(trimmed);
  const looksLikeHost = /^(localhost|[^\s/:]+\.[^\s/:]+)(:\d+)?(\/|$)/i.test(trimmed);
  if (!hasScheme && looksLikeHost && isPinnableUrl(`https://${trimmed}`)) return `https://${trimmed}`;
  return trimmed;
}

/** Returns true if the row is valid or blank. Shows an inline error otherwise. */
function validateRow(row) {
  const url = normalizeUrl(row.url.value);
  if (url !== row.url.value) row.url.value = url;

  if (!url) {
    if (row.title.value.trim()) return showError(row, 'Enter a URL for this tab.');
    clearError(row);
    return true;
  }
  if (isPinnableUrl(url)) {
    clearError(row);
    return true;
  }

  let scheme = '';
  try {
    scheme = new URL(url).protocol;
  } catch {
    // Not a URL at all.
  }
  return showError(row, scheme
    ? `Stay Pinned can't pin ${scheme} URLs. Use an http, https, file, or chrome URL.`
    : 'Enter a full URL, such as https://example.com.');
}

function showError(row, message) {
  row.error.textContent = message;
  row.error.hidden = false;
  row.url.setAttribute('aria-invalid', 'true');
  row.url.setAttribute('aria-describedby', row.error.id);
  return false;
}

function clearError(row) {
  row.error.textContent = '';
  row.error.hidden = true;
  row.url.removeAttribute('aria-invalid');
  row.url.removeAttribute('aria-describedby');
}

function isBlank(row) {
  return !row.url.value.trim() && !row.title.value.trim();
}

/* Saving */

async function onSave(event) {
  event.preventDefault();
  if (busy) return;
  captureConfirm.close();

  const invalid = rows.filter((row) => !validateRow(row));
  if (invalid.length) {
    refresh();
    invalid[0].url.focus();
    announce(invalid.length === 1
      ? 'Fix the highlighted URL, then save again.'
      : `Fix the ${invalid.length} highlighted URLs, then save again.`, 'error');
    return;
  }

  // Blank rows are dropped rather than saved.
  rows = rows.filter((row) => {
    if (!isBlank(row)) return true;
    row.el.remove();
    return false;
  });
  // savePinnedSet assigns missing IDs and defaults empty titles.
  const entries = rows.map((row) => ({ id: row.id, url: row.url.value.trim(), title: row.title.value.trim() }));

  setPageBusy(true);
  try {
    // Every row passed validation, so the saved set lines up with the rows.
    const saved = await savePinnedSet(entries);
    applySaved(saved);
    markSaved(saved);
    if (saved.length === 0) {
      announce('Saved. New windows open without pinned tabs.', 'success');
    } else {
      announce(`Saved ${plural(saved.length, 'tab')}. New windows open with ${saved.length === 1 ? 'it' : 'them'}. `
        + 'To update a window that\'s already open, reset its pinned tabs.', 'success');
    }
  } catch (error) {
    announce(saveErrorText(error), 'error');
  } finally {
    setPageBusy(false);
  }
}

/** Updates rows in place with saved values, so focus stays where it was. */
function applySaved(saved) {
  saved.forEach((entry, index) => {
    const row = rows[index];
    row.id = entry.id;
    row.el.dataset.id = entry.id;
    row.url.value = entry.url;
    row.title.value = entry.title ?? '';
    updateIcon(row);
  });
  refresh();
}

function saveErrorText(error) {
  const message = String(error?.message ?? error ?? '');
  if (/quota/i.test(message)) {
    return 'The list is too large to save. Remove some tabs or shorten their URLs, then save again.';
  }
  return `Couldn't save your pinned tabs. ${message ? `Error: ${message}` : 'Try again.'}`;
}

function markDirty() {
  dirty = true;
  els.dirtyNote.hidden = false;
}

function fingerprint(set) {
  return JSON.stringify(set.map(({ id, url, title }) => [id, url, title]));
}

function markSaved(set) {
  savedSet = set;
  dirty = false;
  els.dirtyNote.hidden = true;
}

/* Capturing the current window */

function onCaptureClick() {
  if (busy) return;
  if (savedSet.length === 0 && !dirty) {
    capture();
    return;
  }
  captureConfirm.open(dirty
    ? "Replace this list with the pinned tabs in this window? You lose any changes you haven't saved."
    : `Replace your ${plural(savedSet.length, 'saved tab')} with the pinned tabs in this window?`);
}

async function capture() {
  if (busy) return;
  setPageBusy(true);

  let windowId;
  try {
    windowId = (await chrome.tabs.getCurrent())?.windowId;
  } catch {
    // The background falls back to the last focused normal window.
  }
  const response = await send({ type: 'capture-window', windowId });

  setPageBusy(false);
  captureConfirm.close();
  captureConfirm.trigger.focus();

  if (response.ok) {
    const { set } = response;
    renderRows(set);
    markSaved(set);
    announce(`Saved ${plural(set.length, 'pinned tab')} from this window. New windows open with ${set.length === 1 ? 'it' : 'them'}.`, 'success');
  } else {
    announce(errorText(response.error, "use this window's pinned tabs"), 'error');
  }
}

/* Busy state and status */

function setPageBusy(value) {
  busy = value;
  setBusy(els.form, [els.save, ...captureConfirm.buttons], value);
}

function announce(text, tone) {
  setStatus(els.status, text, tone);
}
