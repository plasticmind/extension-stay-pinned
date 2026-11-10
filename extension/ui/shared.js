// Helpers shared by the popup and the options page.

// How long to wait for the background service worker before showing an error.
const RESPONSE_TIMEOUT_MS = 10000;

// Display order for the shortcuts. Chrome doesn't keep the manifest's key order.
const COMMAND_NAMES = ['reset-window', 'reset-tab'];

// macOS reports shortcuts with modifier symbols, such as "⌥⇧P".
const KEY_NAMES = { '⌘': 'Command', '⌥': 'Option', '⇧': 'Shift', '⌃': 'Control' };

export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Sends a message to the background. Resolves to its { ok, ... } response, or
// to { ok: false, error: 'no-response' } if it doesn't answer in time.
export async function send(message) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, RESPONSE_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([chrome.runtime.sendMessage(message), timeout]);
    if (response) return response;
  } catch {
    // Treated the same as no response.
  } finally {
    clearTimeout(timer);
  }
  return { ok: false, error: 'no-response' };
}

// Describes an error code from the background. `action` completes the
// sentence "Couldn't ...".
export function errorText(error, action) {
  switch (error) {
    case 'no-pinned-tabs':
      return "This window doesn't have any pinned tabs. To pin a tab, right-click it and select Pin.";
    case 'empty-set':
      return "You haven't saved any pinned tabs. To start, save this window's pinned tabs.";
    case 'unsupported-window':
      return "Stay Pinned doesn't manage incognito or popup windows.";
    case 'no-response':
      return "Stay Pinned didn't respond. On the Extensions page, reload Stay Pinned, then try again.";
    default:
      return `Couldn't ${action}. ${error ? `Error: ${error}` : 'Try again.'}`;
  }
}

// Shows a message in a live region. `tone` is "", "success", or "error".
export function setStatus(status, text, tone = '') {
  status.dataset.tone = tone;
  if (text && status.textContent === text) {
    // Clear first so screen readers announce a repeated message.
    status.textContent = '';
    setTimeout(() => { status.textContent = text; }, 50);
  } else {
    status.textContent = text;
  }
}

// Disables the page's action buttons while a request runs. They use
// aria-disabled, not disabled, so a focused button keeps keyboard focus.
export function setBusy(container, buttons, busy) {
  container.setAttribute('aria-busy', String(busy));
  for (const button of buttons) button.setAttribute('aria-disabled', String(busy));
}

export function renderFavicon(pageUrl) {
  const img = document.createElement('img');
  img.className = 'favicon';
  img.alt = '';
  img.width = 16;
  img.height = 16;
  img.decoding = 'async';
  img.src = faviconUrl(pageUrl, 16);
  img.srcset = `${faviconUrl(pageUrl, 32)} 2x`;
  return img;
}

function faviconUrl(pageUrl, size) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.href;
}

// Lists the manifest's commands and their current keys in a <dl>. Chrome
// leaves a shortcut empty when another extension already uses its keys.
export async function renderShortcuts(list) {
  const commands = await chrome.commands.getAll().catch(() => []);
  const keys = new Map(commands.map(({ name, shortcut }) => [name, shortcut]));
  const declared = chrome.runtime.getManifest().commands;

  list.replaceChildren(...COMMAND_NAMES.map((name) => {
    const term = document.createElement('dt');
    term.textContent = declared[name].description;

    const value = document.createElement('dd');
    const shortcut = keys.get(name);
    if (shortcut) {
      value.append(...shortcutKeys(shortcut).map(renderKey));
    } else {
      value.className = 'shortcut-unset';
      value.textContent = 'Not set';
    }

    const row = document.createElement('div');
    row.className = 'shortcut';
    row.append(term, value);
    return row;
  }));
}

function shortcutKeys(shortcut) {
  if (shortcut.includes('+') && shortcut.length > 1) {
    return shortcut.split('+').map((key) => key.trim()).filter(Boolean);
  }
  const keys = [];
  let rest = shortcut;
  while (rest && KEY_NAMES[rest[0]]) {
    keys.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest) keys.push(rest);
  return keys;
}

function renderKey(key) {
  const kbd = document.createElement('kbd');
  const name = KEY_NAMES[key];
  if (name) {
    const symbol = document.createElement('span');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = key;
    const label = document.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = name;
    kbd.append(symbol, label);
    kbd.title = name;
  } else {
    kbd.textContent = key;
  }
  return kbd;
}

// Makes a link open chrome://extensions/shortcuts in a new tab, because
// extension pages can't navigate to chrome:// URLs.
export function linkToShortcuts(link, showError) {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch {
      showError("Couldn't open the shortcuts page. Go to chrome://extensions/shortcuts.");
    }
  });
}

// Wires the inline confirmation that both pages show before they replace the
// saved tabs with a window's pinned tabs. The page supplies the question.
export function setUpCaptureConfirm(onConfirm) {
  const trigger = document.getElementById('capture-button');
  const panel = document.getElementById('capture-confirm');
  const question = document.getElementById('capture-confirm-text');
  const confirmButton = document.getElementById('capture-confirm-button');
  const cancelButton = document.getElementById('capture-cancel-button');

  function open(text) {
    question.textContent = text;
    trigger.hidden = true;
    panel.hidden = false;
    confirmButton.focus();
  }

  function close({ restoreFocus = false } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.hidden = false;
    if (restoreFocus) trigger.focus();
  }

  confirmButton.addEventListener('click', onConfirm);
  cancelButton.addEventListener('click', () => close({ restoreFocus: true }));
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close({ restoreFocus: true });
  });
  return { open, close, trigger, buttons: [trigger, confirmButton, cancelButton] };
}
