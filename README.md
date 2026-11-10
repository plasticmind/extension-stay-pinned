# Stay Pinned

Stay Pinned is a Chrome extension that opens the same set of pinned tabs in every new browser window, the way Arc does. A keyboard shortcut resets those pinned tabs to the pages you saved.

## What it does

- Every new Chrome window opens with your pinned tabs, in order. The tabs load right away.
- Each window gets its own copy of each pinned tab. Browsing in one window doesn't change the others.
- A keyboard shortcut resets the pinned tabs in the current window. It reopens tabs you closed, pins tabs you unpinned, puts them back in order, and returns each one to its saved page.
- A second shortcut resets only the tab you're on, if it's one of your pinned tabs.
- Stay Pinned doesn't change or close tabs that you pin by hand. They stay to the right of your saved pinned tabs.

## Requirements

- Google Chrome 116 or later.

## Install

Stay Pinned isn't in the Chrome Web Store. To load it unpacked:

1. In Chrome, go to `chrome://extensions`.
1. Turn on **Developer mode**.
1. Click **Load unpacked**.
1. Select the `extension` folder in this repository, not the repository root.

The first time you install Stay Pinned, Chrome opens its options page so that you can set up your pinned tabs.

To pin the Stay Pinned button to the toolbar, click **Extensions** in the toolbar, then click the pin next to **Stay Pinned**.

## Set your pinned tabs

You can save the pinned tabs from a window, or edit the list directly.

Saving from a window works best. Some URLs redirect when they load. Gmail, for example, goes from `mail.google.com` to a longer inbox URL. If you type a URL like that, the tab never matches its saved URL, so it reloads every time you reset. Saving from a window records the page where each tab ends up.

### Save the pinned tabs from a window

1. In any window, pin the tabs you want. To pin a tab, right-click it and select **Pin**.
1. Arrange the pinned tabs in the order you want, from left to right.
1. Click the Stay Pinned button in the toolbar.
1. Click **Save this window's pinned tabs**. If you already have saved tabs, confirm that you want to replace them.

The options page has the same action, named **Use this window's pinned tabs**.

### Edit the list

1. Open the options page. In the Stay Pinned popup, click **Edit pinned tabs**.
1. Change the list:
    - To add a tab, click **Add tab**, then enter a title and a URL.
    - To change the order, use the move up and move down buttons.
    - To remove a tab, click its remove button.
1. Click **Save**.

The title is optional. If you leave it blank, Stay Pinned uses the site's hostname. Titles can be up to 100 characters long, and Stay Pinned shortens longer ones. If you enter a URL without `https://`, such as `mail.google.com`, Stay Pinned adds it for you.

Stay Pinned can pin `http`, `https`, `file`, `chrome`, and `chrome-extension` URLs.

Changes apply to new windows. To apply them to a window that's already open, reset its pinned tabs.

## Keyboard shortcuts

| Action | Default shortcut |
| --- | --- |
| Reset pinned tabs in this window | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on macOS) |
| Reset the current pinned tab | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on macOS) |

The popup and the options page show the shortcuts that are set now. If another extension already uses a default shortcut, Chrome leaves that shortcut unassigned, and Stay Pinned shows it as **Not set**.

To change a shortcut:

1. Go to `chrome://extensions/shortcuts`. You can also click **Change shortcuts** in the popup or on the options page.
1. Find **Stay Pinned**, then click the edit button next to the shortcut.
1. Press the key combination you want.

## How reset works

When you reset the pinned tabs in a window, Stay Pinned does the following:

- Reopens any saved pinned tab that you closed, at its saved position.
- Pins any saved tab that you unpinned.
- Moves the saved pinned tabs back into their saved order, at the far left.
- Returns any pinned tab that you navigated away from to its saved URL.
- Closes the pinned tab for any entry that you removed from the list.
- Doesn't reload tabs that are already on their saved page.
- Doesn't change tabs that you pinned by hand. They stay to the right of your saved pinned tabs.

Resetting the current tab does the same thing for one tab: if the tab you're on is one of your saved pinned tabs, Stay Pinned returns it to its saved page. If the tab is already on its saved page, or isn't one of your saved pinned tabs, the shortcut does nothing.

You can also reset a window from the popup. Click **Reset pinned tabs**. If you haven't saved any pinned tabs, or the window is an incognito or popup window, the popup tells you that it can't reset the window.

When Chrome restarts and restores your windows, Stay Pinned matches the restored pinned tabs to your saved ones instead of opening duplicates.

## Limitations

- Stay Pinned skips incognito windows, popup windows, app windows, and developer tools windows.
- Closing a pinned tab doesn't reopen it automatically. To bring it back, reset the window.
- Changes to the list don't update windows that are already open. To apply them, reset each window.
- Navigation doesn't sync between windows. Each window has its own copy of each pinned tab.
- Stay Pinned stores the list in Chrome sync storage, which limits one saved item to about 8 KB. A long list of long URLs might not save.
- If Chrome sync is on, your list syncs to other computers where you use Stay Pinned.
- To pin a `file` URL, you might need to turn on **Allow access to file URLs** on the extension's details page.

## Privacy

Stay Pinned makes no network requests and has no host permissions. It uses the `tabs`, `storage`, and `favicon` permissions to manage pinned tabs, save your list, and show site icons. For details, see the [Stay Pinned privacy policy](PRIVACY.md).

## Run the tests

The end-to-end tests use Puppeteer to load the extension in Chrome for Testing with a temporary profile. They serve test pages from a local server on `127.0.0.1`, so they don't use the network.

Before you begin, install Node.js 20 or later.

1. Install the dependencies. This step also downloads Chrome for Testing to `~/.cache/puppeteer`.

    ```sh
    npm install
    ```

1. Run the tests:

    ```sh
    npm test
    ```

The tests run headless. To watch the browser while the tests run, use `HEADED=1 npm test`.

The tests save screenshots of the popup and the options page to `test/artifacts/`.

## Change the icon

The icon PNGs come from `extension/icons/icon.svg`. After you edit the SVG, rebuild the PNGs:

```sh
npm run icons
```

The 16, 32, and 48 px icons fill their canvas. The 128 px icon has 16 px of transparent padding, as the Chrome Web Store asks.

## Publish a new version

The Chrome Web Store listing copy, privacy answers, and image list are in [the store listing file](store/LISTING.md).

1. Update `version` in `extension/manifest.json` and in `package.json`.
1. Run the tests:

    ```sh
    npm test
    ```

1. Build the upload zip. This step writes `dist/stay-pinned-<version>.zip`, with `manifest.json` at the root of the zip.

    ```sh
    npm run package
    ```

1. If the popup or options page changed, rebuild the screenshots and promo tile in `store/images/`. This step uses the network to cache the sample sites' favicons.

    ```sh
    npm run store:assets
    ```

1. In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), open Stay Pinned, upload the zip on the **Package** tab, and then click **Submit for review**.

## Project layout

```
extension/            The extension. Load this folder unpacked.
  manifest.json
  background.js       Service worker: opens and resets pinned tabs.
  lib/pinned-set.js   Shared helpers for reading and saving the list.
  popup/              Toolbar popup.
  options/            Options page.
  ui/                 Styles and helpers shared by the popup and the options page.
  icons/              Extension icons and their SVG source.
test/                 End-to-end tests.
scripts/              Icon rendering.
store/                Chrome Web Store listing copy, image generator, and images.
dist/                 Upload zips that npm run package builds. Not checked in.
PRIVACY.md            Privacy policy.
```
