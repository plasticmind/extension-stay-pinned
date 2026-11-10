# Stay Pinned: build spec

Stay Pinned is a Manifest V3 Chrome extension that gives every normal browser window the same set of pinned tabs, like Arc. A keyboard shortcut resets those pinned tabs to their saved URLs.

This spec is the contract between the agents building the extension. If you need to deviate from it, say so in your report rather than silently changing the contract.

## Goals

1. Every new normal window opens the saved set of pinned tabs automatically. The tabs load right away, with no manual reload step.
2. A keyboard shortcut resets the current window's pinned tabs to their saved URLs. It also restores any that were closed or unpinned, and puts them back in order.
3. A second shortcut resets only the active tab, if it's one of the set's tabs.
4. You define the set by pinning tabs in a window and saving them, or by editing a list on the options page.

## Non-goals

- Incognito windows, popup windows, app windows, and devtools windows. Skip anything where `window.type !== 'normal'` or `window.incognito === true`.
- Syncing navigation between windows. Each window has its own independent copy of each pinned tab.
- Automatically reopening a pinned tab the moment you close it. The reset shortcut brings it back.
- Automatically pushing set changes into windows that are already open. New windows get the new set, and reset applies it to an existing window.
- Build tooling. The extension is plain JavaScript (ES modules), HTML, and CSS with no bundler and no runtime dependencies.

## File layout and ownership

Load the `extension/` folder unpacked. It must stay free of `node_modules` and of any file or folder whose name starts with `_`, because Chrome refuses to load those.

```
extension-stay-pinned/
  SPEC.md                    (orchestrator)
  README.md                  (UI agent)
  package.json               (test agent; devDependency: puppeteer)
  .gitignore                 (test agent)
  test/                      (test agent)
  extension/
    manifest.json            (core agent)
    background.js            (core agent; service worker, "type": "module")
    lib/pinned-set.js        (core agent; shared helpers, imported by UI)
    popup/popup.html|css|js  (UI agent)
    options/options.html|css|js (UI agent)
    icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png (UI agent)
```

Only edit the files you own. If you need something from another agent's file, put the request in your report.

## Manifest

- `manifest_version: 3`, `name: "Stay Pinned"`, `version: "1.0.0"`, a one-line `description`.
- `minimum_chrome_version: "116"`.
- `permissions: ["tabs", "storage", "favicon"]`. No host permissions.
- `background: { "service_worker": "background.js", "type": "module" }`.
- `action: { "default_popup": "popup/popup.html", "default_title": "Stay Pinned", "default_icon": {...} }`.
- `options_ui: { "page": "options/options.html", "open_in_tab": true }`.
- `icons` for 16, 32, 48, and 128 at the paths in the file layout.
- `commands`:
  - `reset-window`: "Reset pinned tabs in this window". Suggested key `Alt+Shift+P` on all platforms (Option+Shift+P on macOS).
  - `reset-tab`: "Reset the current pinned tab". Suggested key `Alt+Shift+R` on all platforms.

## Data model

### The pinned set: `chrome.storage.sync`, key `pinnedSet`

An ordered array. Array order is pinned-tab order, left to right.

```js
{ id: string, url: string, title: string }
```

- `id` is a stable slot ID from `crypto.randomUUID()`. It must survive edits, so that open windows keep tracking their tabs.
- `url` is the full URL, stored as `new URL(url).href`, including any hash.
- `title` is a display label. Use the tab title when capturing, and fall back to the hostname.

### Window tracking: `chrome.storage.session`, one key per window, `window:<windowId>`

```js
// key "window:123"
{ [slotId: string]: tabId: number }
```

Each window gets its own key. Reconciles that run in parallel for different windows never write the same key, so they don't need a shared write queue.

The service worker can stop at any time, so it keeps no state in memory except the per-window lock described in "Serialization." Chrome clears session storage when the browser restarts and when the extension reloads or updates. Those are exactly the moments tab IDs become meaningless, so that's correct.

- A window with a record is **tracked**. A window without one is **untracked**.
- Delete a window's record on `chrome.windows.onRemoved`.
- On `chrome.tabs.onReplaced`, swap the old tab ID for the new one in whichever window record holds it.

## Shared module: `extension/lib/pinned-set.js`

The core agent owns this module. The UI imports it, so these exports and signatures are fixed:

```js
export const SET_KEY = 'pinnedSet';
export async function getPinnedSet();              // -> Entry[] (never null)
export async function savePinnedSet(entries);      // entries: {id?, url, title?}[]
                                                    // Validates with isPinnableUrl, drops invalid ones,
                                                    // canonicalizes url, keeps given ids, assigns missing ids,
                                                    // defaults title to hostname, truncates title to
                                                    // 100 characters (sync storage caps one key at 8 KB),
                                                    // writes sync storage,
                                                    // returns the saved Entry[].
export function isPinnableUrl(url);                // true for parseable http:, https:, file:, chrome:,
                                                    // and chrome-extension: URLs
export function matchKey(url);                     // URL href without the hash, or null if unparseable
export function hostKey(url);                      // hostname with a leading "www." removed, or null
```

## Reconcile algorithm (core agent)

`reconcileWindow(windowId, { create, navigate })` is idempotent and does all the work. `tabUrl(tab)` means `tab.pendingUrl || tab.url`.

1. Load the window. Stop if it isn't a normal, non-incognito window, or if the set is empty.
2. Load the window's record (tracked or not) and the window's tabs.
3. **Keep:** for each slot, keep the recorded tab if it still exists in this window.
4. **Adopt** existing pinned tabs that no slot has claimed, for slots that are still unfilled. Each step is one pass over all unfilled slots, in slot order, before the next step starts:
   1. Exact match on `matchKey(tabUrl(tab))` against `matchKey(slot.url)`.
   2. Same host via `hostKey`, taking the leftmost unclaimed pinned tab, only if the window was **untracked**. In a tracked window, an unfilled slot means you closed that tab, and a pinned tab on the same host is one you pinned by hand.
   3. Positional match, only if the window was **untracked**, and only in two cases:
      - The reconcile comes from `onStartup` or from `onInstalled` with reason `update`.
      - The reconcile comes from `onCreated`, and the leftover unclaimed pinned tabs are enough to fill every unfilled slot. That's what a session-restored window looks like. A restored window can fire `onCreated` before `onStartup` runs, so this case closes that race. Pair the remaining unclaimed pinned tabs, in index order, with the remaining unfilled slots, in slot order. This covers session restore and extension reloads, where the window's pinned tabs came from the set and one may have been navigated to another site. Never match by position on a reset or a new window. Those windows can hold pinned tabs you added by hand, for example windows that were open before you installed Stay Pinned or saved the set.
5. **Create** the slots that are still unfilled, if `create` is true: `chrome.tabs.create({ windowId, url, pinned: true, active: false, index })`. Never steal focus from the window's active tab.
6. **Order:** make sure every slot tab is pinned, and move slot tabs to indexes `0..n-1` in slot order. Pinned tabs that aren't in the set (ones you pinned by hand) stay to the right of the set, and Stay Pinned never navigates or closes them.
7. **Navigate,** if `navigate` is true: for each slot tab where `tabUrl(tab) !== slot.url` (an exact comparison, including the hash), call `chrome.tabs.update(tabId, { url: slot.url })`. Leave tabs that are already at their URL alone. Also close any tab the record maps to a slot ID that's no longer in the set. You removed that slot, so reset makes the window match the set.
8. Save the window's record with the final slot-to-tab mapping, and return `{ restored, navigated }` counts.

Tabs might disappear partway through. Catch and skip errors from individual tab operations instead of failing the whole reconcile.

**Tab drags:** while you drag a tab, Chrome rejects tab changes with "Tabs cannot be edited right now (user may be dragging a tab)." This error happens every time you drag a tab out into a new window, because `onCreated` fires mid-drag. When a reconcile hits that error, don't save the window's record. Retry the whole reconcile, inside the per-window lock, with a short backoff (about 250 ms, for up to about 10 seconds), until it succeeds.

### When it runs

| Trigger | Windows | `create` | `navigate` |
|---|---|---|---|
| `chrome.windows.onCreated` | that window, if untracked | true | false |
| `chrome.runtime.onStartup` | every untracked normal window | true | false |
| `chrome.runtime.onInstalled`, reason `update` (includes dev reloads) | every untracked normal window | false | false |
| `chrome.runtime.onInstalled`, reason `install` | none; open the options page instead | | |
| `reset-window` command or message | target window | true | true |

The `onCreated` and `onStartup` rows apply only to untracked windows. When a reconcile runs for a window that's already tracked, it does nothing.

### `reset-tab`

1. If the window is untracked, run a reconcile with `create: false, navigate: false` so its tabs get mapped.
2. If the target tab is mapped to a slot, navigate it to the slot URL (only if the URL differs). Otherwise do nothing.

### Serialization

Keep a per-window promise chain in memory, `Map<windowId, Promise>`, so two reconciles of the same window never overlap. This prevents duplicate tabs when, for example, `onStartup` and `onCreated` fire for the same window. Register every listener synchronously at the top level of `background.js`.

### Command targeting

`chrome.commands.onCommand` passes `(command, tab)`. Use `tab.windowId` and `tab.id`. If `tab` is missing, fall back to `chrome.windows.getLastFocused({ windowTypes: ['normal'] })` and its active tab.

## Message API (background listens on `chrome.runtime.onMessage`)

The response is always `{ ok: true, ...data }` or `{ ok: false, error: string }`. Return `true` from the listener and call `sendResponse` asynchronously.

| Request | Response data |
|---|---|
| `{ type: 'reset-window', windowId? }` | `{ restored, navigated }`, where `restored` counts tabs created plus tabs re-pinned. Errors: `'empty-set'`, `'unsupported-window'`, `'no-window'` |
| `{ type: 'reset-tab', tabId? }` | `{ reset: boolean }`. `reset` is false when the tab isn't a slot tab or is already at its URL |
| `{ type: 'capture-window', windowId? }` | `{ set: Entry[] }`. Errors: `'no-pinned-tabs'`, `'unsupported-window'` |

The keyboard commands and the messages share one code path, so the message tests cover both.

If `windowId` or `tabId` is omitted, use the last focused normal window or its active tab.

**`capture-window`** replaces the set with the window's pinned tabs, left to right. For each captured tab, reuse the `id` of an existing slot that matches it (exact `matchKey` first, then `hostKey`, with each old slot used at most once), so other open windows keep their mappings. Then write the window's record, so this window counts as tracked with those tabs and nothing gets duplicated.

The options page writes `pinnedSet` directly through `savePinnedSet`, keeping each row's `id`. The background doesn't need to react to set changes.

## UI (UI agent)

Follow Google developer documentation style for every UI string: sentence case, second person, active voice, short, and no "please," "simply," or exclamation marks. Support light and dark mode through `prefers-color-scheme`, and use the system font stack. Make it look native and calm: no frameworks and no external requests.

### Popup (`popup/`)

- A small header with the icon and "Stay Pinned."
- The set as a compact list: a favicon from `chrome-extension://<id>/_favicon/?pageUrl=<url>&size=16` (which needs the `favicon` permission), plus the title and hostname.
- A primary button, "Reset pinned tabs," which sends `reset-window` for the popup's window from `chrome.windows.getCurrent()`, then shows a short result.
- A secondary button, "Save this window's pinned tabs," which sends `capture-window` after an inline confirmation if the set isn't empty. Show a clear message for `no-pinned-tabs`.
- A link, "Edit pinned tabs," which calls `chrome.runtime.openOptionsPage()`.
- Current shortcuts from `chrome.commands.getAll()`, and a "Change shortcuts" link that opens `chrome://extensions/shortcuts` with `chrome.tabs.create`. Show "Not set" when a shortcut is empty.
- An empty state that explains how to start: pin tabs in this window, then save them.

### Options page (`options/`)

- An intro that explains what Stay Pinned does in one or two sentences.
- An editable, ordered list of the set. Each row has a favicon, a title input, a URL input, move up and move down buttons, and a remove button. Include an "Add tab" button, plus a "Save" button with a status message. Validate URLs with `isPinnableUrl` and show inline errors. Keep `id` on existing rows.
- "Use this window's pinned tabs," which sends `capture-window` with the options tab's own window ID from `chrome.tabs.getCurrent()`, then reloads the list.
- A shortcuts section with the current keys and a "Change shortcuts" link.
- A short "How it works" section: new windows get the set, reset restores and re-navigates, pinned tabs you add by hand are left alone, and set changes apply to new windows or when you reset.
- Accessible: real `<label>`s, visible focus styles, buttons with accessible names (such as "Move Gmail up"), and status messages in an `aria-live` region.

### Icons

A simple pushpin glyph that reads clearly at 16 px. Generate the PNGs with ImageMagick (`magick` is installed) from an SVG source, keep the SVG at `extension/icons/icon.svg`, and look at the output to check it.

## Tests (test agent)

`npm test` runs an end-to-end suite. It uses Puppeteer to launch Chrome for Testing with `extension/` loaded unpacked, using a throwaway profile directory. Chrome for Testing 144 is already cached in `~/.cache/puppeteer`. Branded Google Chrome no longer supports `--load-extension`, so use Chrome for Testing. Run headless by default, and let `HEADED=1` show the browser. Serve test pages from a local HTTP server on `127.0.0.1` so nothing touches the network. Drive the extension through `chrome.*` calls in the service worker, and through `chrome.runtime.sendMessage` from an extension page such as the options page opened in a tab.

The suite must cover at least these cases:

1. A new normal window gets the set as pinned tabs, in order, at indexes 0..n-1. They load (status `complete`, not discarded), and the window's own new tab stays active.
2. A second window gets its own copy, and the first window gains no duplicates.
3. If you navigate a pinned tab elsewhere, `reset-window` brings it back, and tabs already at their URL aren't reloaded or changed.
4. If you close a slot tab, `reset-window` recreates it at the correct index. If you unpin one, reset pins it again.
5. `reset-tab` resets the active slot tab, and does nothing on a tab that isn't a slot.
6. A pinned tab you added by hand survives reset untouched, to the right of the set.
7. `capture-window` saves the window's pinned tabs as the set, reuses matching IDs, and a new window then gets that set. Capturing a window with no pinned tabs returns `no-pinned-tabs`.
8. A `type: 'popup'` window gets no pinned tabs.
9. Race: create a window and immediately send `reset-window` for it, and no duplicates appear.
10. Recovery: clear `chrome.storage.session` to simulate a reload, navigate one pinned tab to another host, then `reset-window`. Existing tabs are adopted (including positionally), with no duplicates.
11. `chrome.commands.getAll()` lists `reset-window` and `reset-tab`.
12. The popup and options pages load without console errors. Save screenshots of both to `test/artifacts/` (gitignored).

Bonus, if it's reliable: simulate a real browser restart with session restore by relaunching the same profile with "continue where you left off."
