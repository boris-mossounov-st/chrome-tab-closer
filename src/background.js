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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sweep-now') {
    sweep().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});
