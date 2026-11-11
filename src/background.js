import {
  loadSettings, saveSettings, hasStoredSettings, addNewDefaults,
  ruleMatchesUrl, hasCheck, timeoutMs, idleCloseMs, fmtTimeout, closeTabs,
} from './common.js';

// "Activity" = last time a tab was focused (active tab of the focused window)
// or navigated to a new URL. A tab is closed once it has been inactive for
// longer than its matching rule's timeout. The currently focused tab is never closed.
//
// State lives in chrome.storage.session so it survives service-worker restarts
// (it is cleared when the browser restarts, which simply restarts the timers).

const ALARM = 'sweep';

let activity = {};        // { [tabId]: timestampMs }
let focusedTabId = null;  // tab currently focused, or null if Chrome is not focused

const ready = (async () => {
  const data = await chrome.storage.session.get(['activity', 'focusedTabId']);
  activity = data.activity || {};
  focusedTabId = data.focusedTabId ?? null;
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  }
})();

function persist() {
  return chrome.storage.session.set({ activity, focusedTabId });
}

async function getFocusedTabId() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (!win || !win.focused) return null;
    const tab = (win.tabs || []).find((t) => t.active);
    return tab ? tab.id : null;
  } catch {
    return null;
  }
}

/** Marks the previously focused tab (we just left it) and the newly focused tab as active now. */
async function refreshFocus() {
  const now = Date.now();
  const current = await getFocusedTabId();
  if (focusedTabId !== null) activity[focusedTabId] = now;
  if (current !== null) activity[current] = now;
  focusedTabId = current;
  return current;
}

/**
 * Should this tab be closed now? Returns the reason (string) or null.
 * Enabled rules matching the URL are tried in order:
 * - a rule without a page check owns the tab: it closes it once idle past its timeout,
 *   and nothing else (later rules, catch-all) is considered;
 * - a rule with a page check only claims the tab when it's idle past the timeout AND the
 *   page check passes; otherwise the next matching rule gets a chance.
 * Tabs no rule claims fall back to the catch-all "close inactive tabs after ..." setting.
 */
async function closeReason(settings, tab, url, idleMs) {
  for (const rule of settings.rules) {
    if (!rule.enabled || !ruleMatchesUrl(rule, url)) continue;
    const due = idleMs >= timeoutMs(rule);
    if (!hasCheck(rule)) return due ? rule.title || 'Untitled rule' : null;
    if (due && await pageCheckPasses(tab, rule.check)) return rule.title || 'Untitled rule';
  }
  if (idleMs >= idleCloseMs(settings)) {
    const { value, unit } = settings.idleClose;
    return `Inactive for ${fmtTimeout(value, unit)}`;
  }
  return null;
}

// ---- Page check ----

/**
 * Runs inside the page (must be self-contained). Returns { pass, match? }: pass is true if an
 * element matches `selector` and — when `text` is given — its visible text contains `text` or
 * matches "/regex/flags". `match` is a short snippet of the first passing element, so the
 * settings UI can show why a tab passed.
 */
function pageProbe(selector, text) {
  let els;
  try { els = [...document.querySelectorAll(selector || 'body')]; } catch { return { pass: false }; }
  let test = () => true;
  if (text) {
    const m = text.match(/^\/(.+)\/([dimsuv]*)$/);
    if (m) {
      let re;
      try { re = new RegExp(m[1], m[2]); } catch { return { pass: false }; }
      test = (s) => re.test(s);
    } else test = (s) => s.includes(text);
  }
  const el = els.find((e) => test(e.innerText ?? e.textContent ?? ''));
  if (!el) return { pass: false };
  const attrs = [...el.attributes]
    .filter((a) => a.name !== 'style' && !(a.name === 'class' && a.value.length > 60))
    .map((a) => `${a.name}="${a.value.slice(0, 60)}"`).join(' ');
  const inner = (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { pass: true, match: `<${el.tagName.toLowerCase()} ${attrs}>${inner}` };
}

/**
 * Runs the page check in a tab -> { result: true|false } or { result: null, reason } when the
 * page can't be read (no site access, unloaded/discarded tab, still loading, chrome:// page...).
 */
async function pageCheck(tab, check) {
  if (tab.discarded) return { result: null, reason: 'unloaded' };
  if (tab.status !== 'complete') return { result: null, reason: 'loading' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageProbe,
      args: [check.selector?.trim() || '', check.text?.trim() || ''],
    });
    return { result: res?.result?.pass === true, match: res?.result?.match };
  } catch (e) {
    return { result: null, reason: /permission|cannot access/i.test(e.message) ? 'no access' : e.message };
  }
}

const pageCheckPasses = async (tab, check) => (await pageCheck(tab, check)).result === true;

/** For the settings UI: page-check result per tab id, using the (possibly unsaved) check. */
async function checkTabs(check, tabIds) {
  const results = {};
  await Promise.all(tabIds.map(async (id) => {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) results[id] = await pageCheck(tab, check);
  }));
  return { ok: true, results };
}

/** "Close all" for one rule: closes matching tabs (only those passing the page check, if any). */
async function closeRuleTabs(ruleId) {
  const settings = await loadSettings();
  const rule = settings.rules.find((r) => r.id === ruleId);
  if (!rule) return { ok: false, error: 'Rule not found (still saving?)' };
  const tabs = (await chrome.tabs.query({})).filter((t) => ruleMatchesUrl(rule, t.url || t.pendingUrl));
  const toClose = [];
  for (const tab of tabs) {
    if (!hasCheck(rule) || await pageCheckPasses(tab, rule.check)) {
      toClose.push({ tab, reason: `${rule.title || 'Untitled rule'} (closed manually)` });
    }
  }
  await closeTabs(toClose);
  return { ok: true, closed: toClose.length, kept: tabs.length - toClose.length };
}

async function sweep() {
  await ready;
  const settings = await loadSettings();
  const now = Date.now();
  const current = await refreshFocus();
  const tabs = await chrome.tabs.query({});

  const live = new Set();
  const toClose = [];

  for (const tab of tabs) {
    live.add(String(tab.id));
    if (activity[tab.id] == null) {
      // First time we see it (e.g. after a browser restart): start from when Chrome says the
      // tab was last used, so long timeouts survive restarts.
      activity[tab.id] = Math.min(now, tab.lastAccessed || now);
    }
    if (tab.id === current) continue;
    if (settings.skipPinned && tab.pinned) continue;
    if (settings.skipAudible && tab.audible) continue;

    const url = tab.url || tab.pendingUrl;
    if (!url) continue;
    const reason = await closeReason(settings, tab, url, now - activity[tab.id]);
    if (reason) toClose.push({ tab, reason });
  }

  // Forget tabs that no longer exist.
  for (const id of Object.keys(activity)) {
    if (!live.has(id)) delete activity[id];
  }
  await persist();

  await closeTabs(toClose);
}

// ---- Event listeners (registered synchronously at top level, as MV3 requires) ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) sweep();
});

chrome.tabs.onActivated.addListener(async () => {
  await ready;
  await refreshFocus();
  await persist();
});

chrome.windows.onFocusChanged.addListener(async () => {
  await ready;
  await refreshFocus();
  await persist();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  // Restored tabs (browser restart, reopen closed tab) keep their last-used time.
  activity[tab.id] = Math.min(Date.now(), tab.lastAccessed || Date.now());
  await persist();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await ready;
  activity[tabId] = Date.now(); // navigation restarts the timer
  await persist();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  delete activity[tabId];
  if (focusedTabId === tabId) focusedTabId = null;
  await persist();
});

// First install: store the default rules so they live in browser storage, not code.
// Update/reload: add default rules introduced since the user's settings were saved.
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  const fresh = !(await hasStoredSettings());
  if (addNewDefaults(settings) || fresh) await saveSettings(settings);
});

// ---- Flash: make matching tabs blink in the tab strip ----
//
// Extensions can't recolor tabs directly, but they can put tabs in colored tab groups.
// Each ungrouped target tab gets its own temporary single-tab group (single-tab groups
// don't move the tab), whose color blinks; afterwards the tab is ungrouped again.
// Tabs already in a group get that group's color blinked and then restored.
// Pinned tabs can't be grouped and are skipped.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLASH_COLORS = ['yellow', 'red'];
const FLASH_STEPS = 8;        // color changes
const FLASH_STEP_MS = 350;
let flashing = false;

async function flashTabs(tabIds) {
  if (flashing || !tabIds?.length) return { ok: true, flashed: 0 };
  flashing = true;
  const tempGroupTabs = [];   // tab ids we grouped ourselves
  const groups = new Map();   // groupId -> original { color, title, collapsed } (null = our temp group)
  try {
    const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null))))
      .filter((t) => t && !t.pinned);

    for (const tab of tabs) {
      if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        if (!groups.has(tab.groupId)) {
          const g = await chrome.tabGroups.get(tab.groupId);
          groups.set(tab.groupId, { color: g.color, title: g.title, collapsed: g.collapsed });
          if (g.collapsed) await chrome.tabGroups.update(tab.groupId, { collapsed: false });
        }
      } else {
        const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
        await chrome.tabGroups.update(groupId, { title: '⚡' });
        tempGroupTabs.push(tab.id);
        groups.set(groupId, null);
      }
    }

    for (let i = 0; i < FLASH_STEPS; i++) {
      const color = FLASH_COLORS[i % FLASH_COLORS.length];
      await Promise.all([...groups.keys()].map((id) => chrome.tabGroups.update(id, { color }).catch(() => {})));
      await sleep(FLASH_STEP_MS);
    }
    return { ok: true, flashed: tabs.length };
  } finally {
    if (tempGroupTabs.length) await chrome.tabs.ungroup(tempGroupTabs).catch(() => {});
    await Promise.all([...groups].filter(([, orig]) => orig)
      .map(([id, orig]) => chrome.tabGroups.update(id, orig).catch(() => {})));
    flashing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sweep-now') {
    sweep().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg?.type === 'check-tabs') {
    checkTabs(msg.check, msg.tabIds)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'close-rule') {
    closeRuleTabs(msg.ruleId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'flash-tabs') {
    flashTabs(msg.tabIds)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
