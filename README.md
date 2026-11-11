# Tab Closer

A Chrome extension (Manifest V3) that closes tabs matching your URL rules after they've been inactive for a set time. It's meant for leftover Zoom launcher tabs, SSO/login pages and forgotten Google Docs.

## Build & install

```sh
npm install
npm run build        # or: npm run dev  (rebuilds on every change)
```

1. Open `chrome://extensions` and turn on **Developer mode**
2. Click **Load unpacked** and select the **`dist/`** folder
3. Click the toolbar icon to edit rules in the popup, or click **Full page ↗** for the full settings page

After a rebuild, click the reload icon on the extension's card. Changes to the settings page show up when you reopen it.

## Rules

Each rule has:

- **Title**
- **Patterns**, one per line:
  - `/regex/` (optional flags, e.g. `/zoom\.us/i`) is tested against the full URL
  - anything else must equal the URL exactly
- **Timeout** in minutes of inactivity
- An **on/off** switch

Each rule card also shows a live **count of open tabs** that match the rule and a **Close all** button. Close all closes those tabs right away, even if the rule is off. Edits save automatically.

Rules are kept in `chrome.storage.sync`, Chrome's built-in extension storage, which syncs with your Chrome profile. The defaults in `src/common.js` are written to storage only on first install or when you click **Restore defaults**.

## Auto-close behaviour

- A tab's inactivity timer resets when the tab becomes the selected tab in the focused Chrome window, or when it loads a new URL.
- About every 30 seconds, each tab is matched against the rules. The first enabled matching rule decides the timeout.
- The tab you're looking at is never closed. If you switch to another app (for example, the Zoom app opens), the timer starts.
- Pinned tabs and tabs playing audio are skipped by default.
- If the browser restarts, all timers start over.

## Layout

```
public/manifest.json      extension manifest (copied to dist/)
public/icons/             generated PNG icons (npm run icons)
icon.svg                  icon source
scripts/icons.js          renders icon.svg -> PNGs
options.html              popup + settings page entry
src/background.js         service worker: tracks activity, auto-closes tabs
src/common.js             default rules, storage, matching, closing (shared)
src/options/App.vue       settings UI (state, autosave, live tab stats)
src/options/RuleCard.vue  one rule: title, patterns, timeout, count, close-all
src/options/style.css     Tailwind entry + small component classes
```

Built with Vue 3, Tailwind CSS v4 and Vite:

- Vue templates are compiled at build time, so the bundle has no `eval` and works under the Manifest V3 security policy.
- Tailwind outputs only the utility classes used in the templates. A few shared component classes (`btn`, `field`, `card`) are defined in `src/options/style.css`.
- The whole `dist/` is about 100 KB: Vue about 75 KB, CSS about 16 KB.
