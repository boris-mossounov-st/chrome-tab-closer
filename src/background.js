import {
  loadSettings, saveSettings, hasStoredSettings, findRule, timeoutMs, closeTabs,
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
      activity[tab.id] = now; // first time we see it: start its timer now
      continue;
    }
    if (tab.id === current) continue;
    if (settings.skipPinned && tab.pinned) continue;
    if (settings.skipAudible && tab.audible) continue;

    const url = tab.url || tab.pendingUrl;
    if (!url) continue;
    const rule = findRule(settings.rules, url);
    if (!rule) continue;

    if (now - activity[tab.id] >= timeoutMs(rule)) {
      toClose.push({ tab, reason: rule.title || 'Untitled rule' });
    }
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
  activity[tab.id] = Date.now();
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

// Store the default rules on first install so they live in browser storage, not code.
chrome.runtime.onInstalled.addListener(async () => {
  if (!(await hasStoredSettings())) await saveSettings(await loadSettings());
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
  if (msg?.type === 'flash-tabs') {
    flashTabs(msg.tabIds)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
