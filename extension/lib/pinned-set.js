// Shared helpers for the pinned set. The background service worker, the popup,
// and the options page all import this module.

export const SET_KEY = 'pinnedSet';

const PINNABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'chrome:', 'chrome-extension:']);
const CHROME_PROTOCOLS = new Set(['chrome:', 'chrome-extension:']);

// Sync storage caps one key at 8 KB, and the whole set shares one key.
const MAX_TITLE_LENGTH = 100;

// Counts code points, so that truncation never splits an emoji or other
// surrogate pair.
function truncate(text, max) {
  return [...text].slice(0, max).join('').trimEnd();
}

// Parses a URL into the form Chrome reports in tab.url. Chrome treats chrome:
// and chrome-extension: as standard schemes, but the URL parser doesn't, so
// this lowercases their host and adds the "/" path that Chrome adds.
function parse(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (CHROME_PROTOCOLS.has(parsed.protocol) && parsed.hostname) {
    parsed.hostname = parsed.hostname.toLowerCase();
    if (!parsed.pathname) parsed.pathname = '/';
  }
  return parsed;
}

export function isPinnableUrl(url) {
  const parsed = parse(url);
  if (!parsed || !PINNABLE_PROTOCOLS.has(parsed.protocol)) return false;
  return parsed.protocol === 'file:' || Boolean(parsed.hostname);
}

// Returns the URL without its hash, so that in-page navigation still matches.
export function matchKey(url) {
  const parsed = parse(url);
  if (!parsed) return null;
  parsed.hash = '';
  return parsed.href;
}

// Returns null for URLs without a hostname, such as file: URLs, so that
// unrelated local files never match each other by host.
export function hostKey(url) {
  const hostname = parse(url)?.hostname;
  return hostname ? hostname.replace(/^www\./, '') : null;
}

export async function getPinnedSet() {
  const { [SET_KEY]: stored } = await chrome.storage.sync.get(SET_KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((entry) => typeof entry?.id === 'string' && isPinnableUrl(entry.url))
    .map(({ id, url, title }) => ({ id, url, title: typeof title === 'string' ? title : '' }));
}

export async function savePinnedSet(entries) {
  if (!Array.isArray(entries)) throw new TypeError('savePinnedSet expects an array of entries.');
  const usedIds = new Set();
  const set = [];
  for (const entry of entries) {
    if (!isPinnableUrl(entry?.url)) continue;
    const url = parse(entry.url);
    // A repeated ID gets a fresh one, so that every slot stays unique.
    const id = typeof entry.id === 'string' && entry.id && !usedIds.has(entry.id)
      ? entry.id
      : crypto.randomUUID();
    usedIds.add(id);
    const title = (typeof entry.title === 'string' ? entry.title.trim() : '') || url.hostname || url.href;
    set.push({ id, url: url.href, title: truncate(title, MAX_TITLE_LENGTH) });
  }
  await chrome.storage.sync.set({ [SET_KEY]: set });
  return set;
}
