<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import RuleCard from './RuleCard.vue';
import {
  DEFAULT_RULES, loadSettings, saveSettings, findRule, ruleMatchesUrl, timeoutMs, closeTabs, newId,
} from '../common.js';

defineProps({ isPopup: Boolean });

const settings = ref(null);   // edited settings, auto-saved
const status = ref('');
const tabs = ref([]);
const activity = ref({});
const focusedTabId = ref(null);
const closedLog = ref([]);
const testUrl = ref('');
const now = ref(Date.now());

// ---------- Load / autosave ----------

let lastSavedJson = '';
let saveTimer;

watch(settings, (value) => {
  const json = JSON.stringify(value);
  if (!value || json === lastSavedJson) return;
  status.value = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    lastSavedJson = json;
    await saveSettings(JSON.parse(json));
    status.value = 'All changes saved';
  }, 400);
}, { deep: true });

function onStorageChanged(changes, area) {
  // Another open settings view (popup vs. full page) saved changes — pick them up.
  if (area === 'sync' && changes.settings?.newValue) {
    const json = JSON.stringify(changes.settings.newValue);
    if (json !== lastSavedJson) {
      lastSavedJson = json;
      loadSettings().then((s) => { lastSavedJson = JSON.stringify(s); settings.value = s; });
    }
  }
  if (area === 'local' && changes.closedLog) closedLog.value = changes.closedLog.newValue || [];
  if (area === 'session') refreshTabs();
}

// ---------- Live tab data ----------

async function refreshTabs() {
  const [all, session] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get(['activity', 'focusedTabId']),
  ]);
  tabs.value = all;
  activity.value = session.activity || {};
  focusedTabId.value = session.focusedTabId ?? null;
  now.value = Date.now();
}

const tabEvents = ['onCreated', 'onRemoved', 'onUpdated'];
let ticker;

onMounted(async () => {
  const s = await loadSettings();
  lastSavedJson = JSON.stringify(s);
  settings.value = s;
  closedLog.value = (await chrome.storage.local.get('closedLog')).closedLog || [];
  await refreshTabs();
  chrome.storage.onChanged.addListener(onStorageChanged);
  tabEvents.forEach((e) => chrome.tabs[e].addListener(refreshTabs));
  ticker = setInterval(refreshTabs, 2000);
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorageChanged);
  tabEvents.forEach((e) => chrome.tabs[e].removeListener(refreshTabs));
  clearInterval(ticker);
});

const tabUrl = (t) => t.url || t.pendingUrl || '';

/** Per-rule stats: matching open tabs, and time until the next auto-close. */
const stats = computed(() => {
  const result = {};
  if (!settings.value) return result;
  const s = settings.value;
  for (const rule of s.rules) result[rule.id] = { tabs: [], nextCloseMs: null };

  for (const tab of tabs.value) {
    const url = tabUrl(tab);
    for (const rule of s.rules) {
      if (ruleMatchesUrl(rule, url)) result[rule.id].tabs.push(tab);
    }
    // Auto-close countdown follows the background logic: first enabled matching rule wins.
    const owner = findRule(s.rules, url);
    if (!owner) continue;
    if (tab.id === focusedTabId.value) continue;
    if (s.skipPinned && tab.pinned) continue;
    if (s.skipAudible && tab.audible) continue;
    const last = activity.value[tab.id];
    if (!last) continue;
    const remaining = Math.max(0, timeoutMs(owner) - (now.value - last));
    const st = result[owner.id];
    if (st.nextCloseMs === null || remaining < st.nextCloseMs) st.nextCloseMs = remaining;
  }
  return result;
});

// ---------- Actions ----------

function addRule() {
  settings.value.rules.push({ id: newId(), enabled: true, title: '', patterns: [''], timeoutMinutes: 10 });
}

function removeRule(index) {
  const rule = settings.value.rules[index];
  if (confirm(`Delete rule “${rule.title || 'Untitled'}”?`)) settings.value.rules.splice(index, 1);
}

function moveRule(index, delta) {
  const rules = settings.value.rules;
  const j = index + delta;
  if (j < 0 || j >= rules.length) return;
  [rules[index], rules[j]] = [rules[j], rules[index]];
}

function restoreDefaults() {
  if (confirm('Replace all rules with the default rules?')) settings.value.rules = structuredClone(DEFAULT_RULES);
}

async function closeAll(rule) {
  const matching = stats.value[rule.id]?.tabs || [];
  await closeTabs(matching.map((tab) => ({ tab, reason: `${rule.title || 'Untitled rule'} (closed manually)` })));
  refreshTabs();
}

function openFullPage() {
  chrome.runtime.openOptionsPage();
  window.close();
}

const testResult = computed(() => {
  const url = testUrl.value.trim();
  if (!url || !settings.value) return '';
  const rule = findRule(settings.value.rules, url);
  return rule
    ? `✓ Matches “${rule.title || 'Untitled rule'}” — closes after ${rule.timeoutMinutes} min of inactivity.`
    : '✗ No enabled rule matches this URL.';
});

const fmtTime = (t) => new Date(t).toLocaleString();
</script>

<template>
  <div v-if="settings" class="mx-auto max-w-3xl" :class="isPopup ? 'p-3' : 'px-4 py-6'">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-bold">Tab Closer</h1>
        <p v-if="!isPopup" class="hint mt-1">
          Closes tabs matching a rule after they've been inactive for the rule's timeout.
          A tab is active while it's the selected tab in the focused Chrome window; loading a new URL
          restarts its timer. The tab you're looking at is never closed.
        </p>
      </div>
      <button
        v-if="isPopup"
        class="whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
        @click="openFullPage"
      >
        Full page ↗
      </button>
    </header>

    <section class="mt-3 flex flex-col gap-2.5">
      <RuleCard
        v-for="(rule, i) in settings.rules"
        :key="rule.id"
        :rule="rule"
        :stats="stats[rule.id]"
        :first="i === 0"
        :last="i === settings.rules.length - 1"
        @remove="removeRule(i)"
        @move="(d) => moveRule(i, d)"
        @close-all="closeAll(rule)"
      />
      <p v-if="!settings.rules.length" class="hint">No rules yet.</p>
    </section>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button class="btn btn-primary" @click="addRule">+ Add rule</button>
      <button class="btn" @click="restoreDefaults">Restore defaults</button>
      <span class="hint ml-auto text-xs">{{ status }}</span>
    </div>

    <p class="hint mt-3 text-xs leading-relaxed">
      Patterns: one per line. <code>/regex/</code> (optionally with flags, e.g. <code>/zoom\.us/i</code>) is tested
      against the full URL; anything else must equal the URL exactly. When several rules match a tab, the first
      enabled one decides its timeout.
    </p>

    <section class="mt-3 space-y-1">
      <label class="flex items-center gap-2">
        <input v-model="settings.skipPinned" type="checkbox" class="size-4 accent-blue-600"> Never auto-close pinned tabs
      </label>
      <label class="flex items-center gap-2">
        <input v-model="settings.skipAudible" type="checkbox" class="size-4 accent-blue-600"> Never auto-close tabs playing audio
      </label>
    </section>

    <template v-if="!isPopup">
      <h2 class="mt-7 mb-2 font-semibold">Test a URL</h2>
      <input
        v-model="testUrl"
        type="url"
        class="field w-full font-mono text-xs"
        placeholder="https://sensortower.zoom.us/j/123?pwd=...#success"
      >
      <p class="hint mt-1.5 min-h-5">{{ testResult }}</p>

      <h2 class="mt-7 mb-2 font-semibold">Recently closed</h2>
      <table v-if="closedLog.length" class="w-full table-fixed border-collapse">
        <tbody class="divide-y divide-slate-200 dark:divide-slate-800">
          <tr v-for="(e, i) in closedLog" :key="i">
            <td class="hint w-44 py-1.5 pr-2 align-top whitespace-nowrap">{{ fmtTime(e.time) }}</td>
            <td class="truncate py-1.5 pr-2" :title="e.url">{{ e.title || e.url }}</td>
            <td class="hint w-56 truncate py-1.5">{{ e.rule }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">Nothing closed yet.</p>
    </template>
  </div>
</template>
