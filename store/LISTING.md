# Chrome Web Store listing

This file holds everything the Chrome Web Store Developer Dashboard asks for, in dashboard order. Copy each field from here when you create or update the listing.

To rebuild the files this listing uses:

- `npm run package` builds the upload zip at `dist/stay-pinned-<version>.zip`.
- `npm run store:assets` rebuilds the screenshots and promo tile in `store/images/`. It uses the network to cache the sample sites' favicons.

## Package

Upload `dist/stay-pinned-1.0.0.zip`. The dashboard reads the name, summary, version, and icon from `manifest.json`.

## Store listing

### Product details

**Name** (from the manifest)

```
Stay Pinned
```

**Summary** (from the manifest, 84 of 132 characters)

```
Opens your pinned tabs in every new window and resets them with a keyboard shortcut.
```

**Description**

```
Stay Pinned gives every new Chrome window the same pinned tabs, in the same order, the way Arc does. Press a shortcut to put them back the way you saved them.

WHAT IT DOES
• Every new window opens with your pinned tabs, loaded and ready.
• Each window gets its own copy of each pinned tab, so browsing in one window doesn't change the others.
• Alt+Shift+P (Option+Shift+P on Mac) resets the pinned tabs in the current window. It reopens tabs you closed, pins tabs you unpinned, puts them back in order, and returns each one to its saved page.
• Alt+Shift+R (Option+Shift+R on Mac) resets only the tab you're on.
• Tabs you pin by hand stay put. Stay Pinned keeps them to the right of your saved tabs and never changes or closes them.
• When Chrome restarts and restores your windows, Stay Pinned matches the restored tabs instead of opening duplicates.

SET UP YOUR PINNED TABS
1. In any window, pin the tabs you want and arrange them in order.
2. Click the Stay Pinned button in the toolbar.
3. Click "Save this window's pinned tabs."

You can also add, rename, reorder, and remove tabs on the options page. To change the shortcuts, go to chrome://extensions/shortcuts.

PRIVACY
Stay Pinned makes no network requests, has no analytics, and runs no remote code. It can't read or change the websites you visit. Your list of pinned tabs is saved in Chrome sync storage, so it follows you to other computers where Chrome sync is on.

GOOD TO KNOW
• Incognito, popup, and app windows don't get pinned tabs.
• Closing a pinned tab doesn't reopen it right away. Press the reset shortcut to bring it back.
• Changes to your list apply to new windows. To update a window that's already open, reset it.
```

**Category**

```
Make Chrome Yours > Functionality & UI
```

**Language**

```
English (United States)
```

### Graphic assets

| Field | File |
| --- | --- |
| Store icon (128x128) | `extension/icons/icon-128.png` |
| Screenshot 1 | `store/images/screenshot-1-every-window.png` |
| Screenshot 2 | `store/images/screenshot-2-reset.png` |
| Screenshot 3 | `store/images/screenshot-3-options.png` |
| Screenshot 4 | `store/images/screenshot-4-dark.png` |
| Small promo tile (440x280) | `store/images/promo-small-440x280.png` |
| Marquee promo tile (1400x560) | None. It's optional. |

### Additional fields

| Field | Value |
| --- | --- |
| Official URL | None |
| Homepage URL | `https://github.com/plasticmind/extension-stay-pinned` |
| Support URL | `https://github.com/plasticmind/extension-stay-pinned/issues` |
| Mature content | No |

## Privacy

### Single purpose

```
Stay Pinned keeps the same pinned tabs in every Chrome window. It opens your saved pinned tabs in each new window, and a keyboard shortcut resets them to their saved pages.
```

### Permission justification

**tabs**

```
Stay Pinned reads the URL of each tab in a window to find the tabs that match the user's saved list of pinned tabs. It uses those URLs to open missing pinned tabs, put them back in order, and return each one to its saved page without opening duplicates. When the user clicks "Save this window's pinned tabs," it reads the URLs and titles of that window's pinned tabs to build the list. Tab data stays on the device.
```

**storage**

```
Stay Pinned saves the user's list of pinned tabs (URL and title for each) in chrome.storage.sync, so the list is the same in every window and on every computer where the user has Chrome sync on. It also records, in chrome.storage.session, which tab in each open window matches which saved entry, so that resetting a window doesn't open duplicates.
```

**favicon**

```
Stay Pinned shows each saved site's icon next to its entry in the popup and on the options page. It reads the icon from Chrome's local favicon cache through the _favicon URL and doesn't fetch icons from the network.
```

### Remote code

```
No, I am not using remote code.
```

### Data usage

Check **Web history**. Leave every other data type unchecked.

Stay Pinned reads tab URLs and saves page URLs and titles. Google's User Data FAQ says that handling data counts even when the data stays on the device, so declaring web history matches what the extension does. The listing still shows that the data isn't sold, transferred, or used for unrelated purposes.

Check all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

```
https://github.com/plasticmind/extension-stay-pinned/blob/main/PRIVACY.md
```

## Distribution

| Field | Value |
| --- | --- |
| Payments | Free |
| Visibility | Public |
| Regions | All regions |

## Test instructions

Reviewers can test Stay Pinned without an account. Paste this into the optional test instructions field:

```
No account or sign-in is needed.
1. Pin two or three tabs in a window (right-click a tab, then select Pin).
2. Click the Stay Pinned toolbar button, then click "Save this window's pinned tabs."
3. Open a new window (Ctrl+N or Cmd+N). It opens with the same pinned tabs.
4. In the new window, close one pinned tab and navigate another to a different site.
5. Press Alt+Shift+P (Option+Shift+P on Mac), or click "Reset pinned tabs" in the popup. The closed tab comes back, and the navigated tab returns to its saved page.
```
