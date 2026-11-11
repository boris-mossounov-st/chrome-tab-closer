<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import RuleCard from './RuleCard.vue';
import {
  defaultRules, loadSettings, saveSettings, findRule, ruleMatchesUrl, timeoutMs, newId, hasCheck,
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
const search = ref('');
const rulesEl = ref(null);

// ---------- Load / autosave ----------

let lastSavedJson = '';
let saveTimer;

async function flushSave() {
  clearTimeout(saveTimer);
  const json = JSON.stringify(settings.value);
  if (!settings.value || json === lastSavedJson) return;
  lastSavedJson = json;
  await saveSettings(JSON.parse(json));
  status.value = 'All changes saved';
}

watch(settings, (value) => {
  if (!value || JSON.stringify(value) === lastSavedJson) return;
  status.value = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
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
let checkTicker;

onMounted(async () => {
  const s = await loadSettings();
  lastSavedJson = JSON.stringify(s);
  settings.value = s;
  closedLog.value = (await chrome.storage.local.get('closedLog')).closedLog || [];
  await refreshTabs();
  chrome.storage.onChanged.addListener(onStorageChanged);
  tabEvents.forEach((e) => chrome.tabs[e].addListener(refreshTabs));
  ticker = setInterval(refreshTabs, 2000);
  refreshChecks();
  checkTicker = setInterval(refreshChecks, 5000);
  chrome.permissions.onAdded.addListener(refreshChecks);
  chrome.permissions.onRemoved.addListener(refreshChecks);
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorageChanged);
  tabEvents.forEach((e) => chrome.tabs[e].removeListener(refreshTabs));
  clearInterval(ticker);
  clearInterval(checkTicker);
  chrome.permissions.onAdded.removeListener(refreshChecks);
  chrome.permissions.onRemoved.removeListener(refreshChecks);
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

  // Page-check rules: split matching tabs by the latest check results.
  for (const rule of s.rules) {
    if (!hasCheck(rule)) continue;
    const res = checkResults.value[rule.id] || {};
    const st = result[rule.id];
    st.check = { pass: [], fail: [], unreadable: {}, pending: 0 };
    for (const tab of st.tabs) {
      const r = res[tab.id];
      if (!r) st.check.pending++;
      else if (r.result === true) st.check.pass.push({ ...tab, match: r.match });
      else if (r.result === false) st.check.fail.push(tab);
      else st.check.unreadable[r.reason] = (st.check.unreadable[r.reason] || 0) + 1;
    }
  }
  return result;
});

// ---------- Page-check results (run by the background in matching tabs) ----------

const checkResults = ref({}); // { [ruleId]: { [tabId]: { result: true|false|null, reason? } } }
let checking = false;

async function refreshChecks() {
  if (checking || !settings.value) return;
  checking = true;
  try {
    const next = {};
    for (const rule of settings.value.rules) {
      if (!hasCheck(rule)) continue;
      const tabIds = tabs.value.filter((t) => ruleMatchesUrl(rule, tabUrl(t))).map((t) => t.id);
      if (!tabIds.length) continue;
      const res = await chrome.runtime
        .sendMessage({ type: 'check-tabs', check: JSON.parse(JSON.stringify(rule.check)), tabIds })
        .catch(() => null);
      if (res?.ok) next[rule.id] = res.results;
    }
    checkResults.value = next;
  } finally {
    checking = false;
  }
}

// Re-check when a check is edited (debounced).
let checkEditTimer;
watch(
  () => JSON.stringify(settings.value?.rules.map((r) => [r.patterns, r.check])),
  () => { clearTimeout(checkEditTimer); checkEditTimer = setTimeout(refreshChecks, 500); },
);

// ---------- Search ----------

const searching = computed(() => search.value.trim() !== '');

/** Rules to show, with their index in the full list (so move/delete act on the right rule). */
const visibleRules = computed(() => {
  const rules = settings.value?.rules || [];
  const q = search.value.trim().toLowerCase();
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => !q
      || (rule.title || '').toLowerCase().includes(q)
      || (rule.patterns || []).some((p) => p.toLowerCase().includes(q)));
});

// ---------- Actions ----------

async function addRule() {
  search.value = ''; // make sure the new rule is visible
  settings.value.rules.push({ id: newId(), enabled: true, title: '', patterns: [''], timeoutMinutes: 10 });
  await nextTick();
  const cards = rulesEl.value?.querySelectorAll('article');
  const card = cards?.[cards.length - 1];
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.querySelector('input[type=text]')?.focus({ preventScroll: true });
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
  if (confirm('Replace all rules with the default rules?')) settings.value.rules = defaultRules();
}

/** Sends a message to the background worker; returns its response or null (status shows why). */
async function toBackground(msg, what) {
  let res;
  try {
    res = await chrome.runtime.sendMessage(msg);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res) status.value = '⚠ Background is outdated — reload the extension in chrome://extensions';
  else if (!res.ok) status.value = `⚠ ${what} failed: ${res.error}`;
  return res?.ok ? res : null;
}

async function closeAll(rule) {
  await flushSave(); // the background reads the rule from storage
  // Done in the background so rules with a page check only close tabs that pass it.
  const res = await toBackground({ type: 'close-rule', ruleId: rule.id }, 'Close');
  if (res) {
    status.value = res.kept
      ? `Closed ${res.closed}; kept ${res.kept} that didn’t pass the page check (or couldn’t be read)`
      : `Closed ${res.closed}`;
  }
  refreshTabs();
}

async function flash(rule) {
  const st = stats.value[rule.id];
  // Page-check rules: only flash tabs that currently pass the check.
  const tabIds = (st?.check ? st.check.pass : st?.tabs || []).map((t) => t.id);
  // Runs in the background worker so it completes even if the popup closes.
  const res = await toBackground({ type: 'flash-tabs', tabIds }, 'Flash');
  if (res && !res.flashed) status.value = 'Nothing to flash (pinned tabs can’t be flashed)';
}

function reopen(entry) {
  chrome.tabs.create({ url: entry.url, active: true });
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
  <div v-if="settings" class="mx-auto max-w-3xl" :class="isPopup ? 'px-3 pb-3' : 'px-4 pb-6'">
    <!-- Sticky toolbar: always visible while scrolling through rules -->
    <header
      class="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90"
      :class="isPopup ? '-mx-3 px-3 py-2' : '-mx-4 px-4 pt-6 pb-3'"
    >
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-bold">Tab Closer</h1>
        <span class="hint text-xs">{{ status }}</span>
        <button
          v-if="isPopup"
          class="ml-auto whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
          @click="openFullPage"
        >
          Full page ↗
        </button>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <input
            v-model="search"
            type="search"
            placeholder="Search title or pattern…"
            class="field w-full pl-7"
            @keydown.esc="search = ''"
          >
          <svg
            class="hint pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2"
            viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
        </div>
        <button class="btn btn-primary whitespace-nowrap" @click="addRule">+ Add rule</button>
        <button class="btn whitespace-nowrap" title="Replace all rules with the defaults" @click="restoreDefaults">
          Restore defaults
        </button>
      </div>
    </header>

    <p v-if="!isPopup" class="hint mt-3">
      Closes tabs matching a rule after they've been inactive for the rule's timeout.
      A tab is active while it's the selected tab in the focused Chrome window; loading a new URL
      restarts its timer. The tab you're looking at is never closed.
    </p>

    <p class="hint mt-3 text-xs leading-relaxed">
      Patterns: one per line. <code>/regex/</code> (optionally with flags, e.g. <code>/zoom\.us/i</code>) is tested
      against the full URL; anything else must equal the URL exactly. When several rules match a tab, the first
      enabled one decides its timeout.
    </p>

    <section class="mt-2 flex flex-wrap gap-x-5 gap-y-1">
      <label class="flex items-center gap-2">
        <input v-model="settings.skipPinned" type="checkbox" class="size-4 accent-blue-600"> Never auto-close pinned tabs
      </label>
      <label class="flex items-center gap-2">
        <input v-model="settings.skipAudible" type="checkbox" class="size-4 accent-blue-600"> Never auto-close tabs playing audio
      </label>
    </section>

    <p v-if="searching" class="hint mt-3 text-xs">
      Showing {{ visibleRules.length }} of {{ settings.rules.length }} rules · reordering is disabled while searching ·
      <button class="text-blue-600 hover:underline dark:text-blue-400" @click="search = ''">clear</button>
    </p>

    <section ref="rulesEl" class="mt-3 flex flex-col gap-2.5">
      <RuleCard
        v-for="{ rule, index } in visibleRules"
        :key="rule.id"
        :rule="rule"
        :stats="stats[rule.id]"
        :first="searching || index === 0"
        :last="searching || index === settings.rules.length - 1"
        @remove="removeRule(index)"
        @move="(d) => moveRule(index, d)"
        @close-all="closeAll(rule)"
        @flash="flash(rule)"
      />
      <p v-if="!settings.rules.length" class="hint">No rules yet.</p>
      <p v-else-if="!visibleRules.length" class="hint">No rules match “{{ search }}”.</p>
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
            <td class="truncate py-1.5 pr-2">
              <a
                :href="e.url"
                :title="`Reopen ${e.url}\n(it still matches its rule, so it will auto-close again after the timeout)`"
                class="text-blue-600 hover:underline dark:text-blue-400"
                @click.prevent="reopen(e)"
              >{{ e.title || e.url }}</a>
            </td>
            <td class="hint w-56 truncate py-1.5">{{ e.rule }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">Nothing closed yet.</p>
    </template>
  </div>
</template>
