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

## Releases

`.github/workflows/release.yml` builds a zip of `dist/` with `manifest.json` at the zip root, the layout the Chrome Web Store expects.

- **Push a version tag** to publish a GitHub Release with the zip attached:
  ```sh
  git tag v1.2.0 && git push origin v1.2.0
  ```
  The version in the tag becomes the built manifest's `version`, so you don't need to edit `public/manifest.json`. Chrome versions must be 1–4 dot-separated numbers, so tags like `v1.2.0-beta` are rejected.
- **Run the workflow manually** (Actions → Release → Run workflow) to build the zip as a downloadable workflow artifact, without creating a release.

To install from a release zip, unzip it, then use **Load unpacked** on the unzipped folder.

## Rules

Each rule has:

- **Title**
- **Patterns**, one per line:
  - `/regex/` (optional flags, e.g. `/zoom\.us/i`) is tested against the full URL
  - anything else must equal the URL exactly
- **Timeout**: how long the tab must be inactive, in minutes, hours, days or weeks
- An **on/off** switch
- An optional **page check** (see below)

Each rule card also shows a live **count of open tabs** that match the rule, plus two buttons:

- **Flash** makes those tabs blink in the tab strip.
- **Close all** closes them right away, even if the rule is off. For a rule with a page check, only tabs that pass the check are closed.

Edits save automatically.

Rules are kept in `chrome.storage.sync`, Chrome's built-in extension storage, which syncs with your Chrome profile. The defaults in `src/common.js` are written to storage on first install and when you click **Restore defaults**. When an update adds new default rules, they're inserted into your saved rules; your existing rules aren't changed.

### Page checks

A page check makes a rule close a tab only if the page contains certain content:

- **Selector:** a CSS selector the page must contain. If it's empty, `body` is used.
- **Text** (optional): the matching element's visible text must contain this text, or match it if you write `/regex/`.
- **Sites:** the hosts the extension may read, e.g. `github.com, *.awsapps.com`. Access is granted per site with **Grant access** on the card, and Chrome asks you to confirm. You can revoke a site with the ✕ on its chip.

If a page can't be read, the tab stays open. That happens when the site has no access granted, when Chrome has unloaded the tab, or when the page is still loading. The check runs only for tabs that have already passed their timeout. If it fails, the next matching rule gets a chance.

Default rules that use page checks:

| Rule | Selector / text | Sites |
|---|---|---|
| GitHub closed issues / merged PRs | `[data-component="StateLabel"]:is([data-status^="issueClosed"], [data-status="pullMerged"], [data-status="pullClosed"])`: the item's own state badge in the header. Linked issues and PRs elsewhere on the page don't match. | `github.com` |
| AWS CLI login approved | `body` containing `Request approved` | `*.awsapps.com, 127.0.0.1, localhost` |

## Auto-close behaviour

- A tab's inactivity timer resets when the tab becomes the selected tab in the focused Chrome window, or when it loads a new URL.
- About every 30 seconds, each tab is matched against the rules. The first enabled matching rule without a page check decides the timeout. A rule with a page check applies only when its check passes.
- The tab you're looking at is never closed. If you switch to another app (for example, the Zoom app opens), the timer starts.
- Pinned tabs and tabs playing audio are skipped by default.
- **Catch-all** (off by default; the checkbox in the sticky header): closes all inactive unprotected tabs after a set time, 1 week by default. "Unprotected" means:
  - no rule without a page check handles the tab;
  - it isn't pinned or playing audio (if those options are on);
  - it isn't the tab you're looking at.

  The header shows how many tabs it would close right now, and you're asked to confirm when turning it on would close any.
- Timers start from Chrome's record of when each tab was last used, so long timeouts carry over across browser restarts. When the extension is reloaded or updated, timers also restart from that record, so a tab that has already been inactive past its timeout can close right away.

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
