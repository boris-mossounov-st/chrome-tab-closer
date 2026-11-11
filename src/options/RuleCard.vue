<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import {
  ruleErrors, hasCheck, parseSites, siteOrigins, hostCovered, timeoutUnit, timeoutValue, setRuleTimeout,
} from '../common.js';

const props = defineProps({
  rule: { type: Object, required: true },
  stats: { type: Object, default: () => ({ tabs: [], nextCloseMs: null }) },
  first: Boolean,
  last: Boolean,
});
defineEmits(['remove', 'move', 'close-all', 'flash']);

// Textarea <-> patterns array (raw lines are kept so typing new lines works; empty lines are ignored when matching).
const patternsText = computed({
  get: () => (props.rule.patterns || []).join('\n'),
  set: (text) => { props.rule.patterns = text.split('\n'); },
});

const count = computed(() => props.stats?.tabs.length ?? 0);
const rows = computed(() => Math.min(6, Math.max(2, (props.rule.patterns || []).length)));
const checked = computed(() => hasCheck(props.rule));

// Timeout shown as value + unit; stored as timeoutMinutes (+ timeoutUnit for display).
const timeoutNum = computed({
  get: () => timeoutValue(props.rule),
  set: (v) => setRuleTimeout(props.rule, v),
});
const unit = computed({
  get: () => timeoutUnit(props.rule),
  set: (u) => setRuleTimeout(props.rule, timeoutValue(props.rule), u), // keep the number, change the unit
});
/** Tabs Flash/Close act on: all matching tabs, or only those passing the page check. */
const actionable = computed(() => (props.stats?.check ? props.stats.check.pass.length : count.value));

const unreadableHint = (reason) => ({
  'no access': 'Site access not granted — click “Grant access” above',
  unloaded: 'Chrome unloaded these tabs to save memory; they’re checked again once you open them',
  loading: 'Still loading',
}[reason] || reason);

// ---------- Page check ----------

const showCheck = ref(checked.value);

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const openHosts = computed(() => [...new Set(props.stats.tabs.map((t) => hostOf(t.url || t.pendingUrl)).filter(Boolean))]);

function toggleCheck() {
  showCheck.value = !showCheck.value;
  // Pre-fill sites from the hosts of currently open matching tabs.
  if (showCheck.value && !props.rule.check) {
    props.rule.check = { selector: '', text: '', sites: openHosts.value.join(', ') };
  }
}

function removeCheck() {
  props.rule.check = null;
  showCheck.value = false;
}

const selectorError = computed(() => {
  const sel = props.rule.check?.selector?.trim();
  if (!sel) return null;
  try { document.createDocumentFragment().querySelector(sel); return null; } catch { return 'Invalid CSS selector'; }
});

const errors = computed(() => [...ruleErrors(props.rule), ...(selectorError.value ? [selectorError.value] : [])]);

// Open matching tabs on hosts that aren't listed in sites -> their page can't be checked.
const uncoveredHosts = computed(() => (checked.value
  ? openHosts.value.filter((h) => !hostCovered(h, props.rule.check.sites))
  : []));

/** Per-site access: { 'github.com': true, ... } */
const access = ref({});
const missingSites = computed(() => parseSites(props.rule.check?.sites).filter((s) => access.value[s] === false));

async function refreshAccess() {
  const sites = parseSites(props.rule.check?.sites);
  const entries = await Promise.all(sites.map(async (site) => [
    site, await chrome.permissions.contains({ origins: [`*://${site}/*`] }),
  ]));
  access.value = Object.fromEntries(entries);
}

async function grantAccess() {
  // Must run directly from the click (user gesture). In the popup, Chrome's prompt may
  // close the popup; the permission is still granted.
  const origins = siteOrigins(props.rule).filter((o) => missingSites.value.some((s) => o === `*://${s}/*`));
  try { await chrome.permissions.request({ origins }); } finally { refreshAccess(); }
}

async function revokeAccess(site) {
  await chrome.permissions.remove({ origins: [`*://${site}/*`] });
  refreshAccess();
}

watch(() => props.rule.check?.sites, refreshAccess);
onMounted(() => {
  refreshAccess();
  chrome.permissions.onAdded.addListener(refreshAccess);
  chrome.permissions.onRemoved.addListener(refreshAccess);
});
onUnmounted(() => {
  chrome.permissions.onAdded.removeListener(refreshAccess);
  chrome.permissions.onRemoved.removeListener(refreshAccess);
});

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
</script>

<template>
  <article class="card transition-opacity" :class="{ 'opacity-60': !rule.enabled }">
    <div class="flex items-center gap-2">
      <input
        v-model="rule.enabled"
        type="checkbox"
        class="size-4 accent-blue-600"
        title="Enable / disable rule"
      >
      <input
        v-model="rule.title"
        type="text"
        placeholder="Rule title"
        class="field min-w-0 flex-1 font-semibold"
      >
      <span class="flex items-center gap-1" title="Close after this long without being used">
        <input v-model.number="timeoutNum" type="number" min="0" step="any" class="field w-14 text-right">
        <select v-model="unit" class="field">
          <option value="minutes">min</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
          <option value="weeks">weeks</option>
        </select>
      </span>
      <span class="flex">
        <button class="btn-icon" :disabled="first" title="Move up" @click="$emit('move', -1)">↑</button>
        <button class="btn-icon" :disabled="last" title="Move down" @click="$emit('move', 1)">↓</button>
        <button class="btn-icon hover:!text-red-600" title="Delete rule" @click="$emit('remove')">✕</button>
      </span>
    </div>

    <textarea
      v-model="patternsText"
      :rows="rows"
      spellcheck="false"
      placeholder="/^https:\/\/example\.com\/login/&#10;https://exact.example.com/page"
      class="field mt-2 block w-full resize-y font-mono text-xs leading-relaxed"
    />

    <!-- Page check -->
    <div class="mt-2">
      <button class="hint text-xs hover:text-slate-800 dark:hover:text-slate-100" @click="toggleCheck">
        {{ showCheck ? '▾' : '▸' }} Page check
        <span v-if="checked && !showCheck" class="ml-1 rounded bg-blue-100 px-1 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">on</span>
      </button>

      <div v-if="showCheck && rule.check" class="mt-1.5 space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-800">
        <p class="hint text-xs">
          Close only when the page has an element matching the selector whose text contains the text
          (plain text or <code>/regex/</code>). Leave text empty to just require the element.
        </p>
        <label class="flex items-center gap-2 text-xs">
          <span class="hint w-14 shrink-0">Selector</span>
          <input
            v-model="rule.check.selector"
            type="text"
            spellcheck="false"
            placeholder="body"
            class="field min-w-0 flex-1 font-mono text-xs"
          >
        </label>
        <label class="flex items-center gap-2 text-xs">
          <span class="hint w-14 shrink-0">Text</span>
          <input
            v-model="rule.check.text"
            type="text"
            spellcheck="false"
            placeholder="optional, e.g. Request approved"
            class="field min-w-0 flex-1 font-mono text-xs"
          >
        </label>
        <label class="flex items-center gap-2 text-xs">
          <span class="hint w-14 shrink-0">Sites</span>
          <input
            v-model="rule.check.sites"
            type="text"
            spellcheck="false"
            placeholder="github.com, *.example.com"
            class="field min-w-0 flex-1 font-mono text-xs"
          >
        </label>

        <div class="flex flex-wrap items-center gap-1.5 pl-16 text-xs">
          <span
            v-for="(ok, site) in access"
            :key="site"
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
            :class="ok
              ? 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'"
            :title="ok ? 'Page content can be read on this site' : 'No access yet — pages here can’t be checked'"
          >
            {{ ok ? '✓' : '!' }} {{ site }}
            <button v-if="ok" class="opacity-60 hover:opacity-100" title="Revoke access" @click="revokeAccess(site)">✕</button>
          </span>
          <button v-if="missingSites.length" class="btn btn-primary !px-2 !py-0.5 text-xs" @click="grantAccess">
            Grant access
          </button>
          <button class="ml-auto text-red-600 hover:underline dark:text-red-400" @click="removeCheck">Remove check</button>
        </div>

        <p v-if="uncoveredHosts.length" class="pl-16 text-xs text-amber-700 dark:text-amber-300">
          Open tab on {{ uncoveredHosts.join(', ') }} isn’t in Sites, so it can’t be checked (it’ll stay open).
        </p>
      </div>
    </div>

    <ul v-if="errors.length" class="mt-1 list-disc pl-5 text-xs text-red-600 dark:text-red-400">
      <li v-for="e in errors" :key="e">{{ e }}</li>
    </ul>

    <div class="mt-2 flex items-center justify-between gap-2">
      <span class="hint" :title="stats.tabs.map((t) => t.title || t.url).join('\n')">
        <span
          class="mr-1 inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold"
          :class="count ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' : 'bg-slate-200 text-slate-500 dark:bg-slate-800'"
        >{{ count }}</span>
        open {{ count === 1 ? 'tab' : 'tabs' }}
        <template v-if="stats.check && count">
          ·
          <b
            class="font-semibold"
            :class="actionable ? 'text-green-700 dark:text-green-400' : ''"
            :title="stats.check.pass.map((t) => `${t.title || t.url}\n   matched: ${t.match || '?'}`).join('\n\n')"
          >{{ stats.check.pass.length }} pass</b>,
          <span :title="stats.check.fail.map((t) => t.title || t.url).join('\n')">{{ stats.check.fail.length }} don’t</span>
          <span
            v-for="(n, reason) in stats.check.unreadable"
            :key="reason"
            class="text-amber-700 dark:text-amber-300"
            :title="unreadableHint(reason)"
          >, {{ n }} {{ reason }}</span>
          <span v-if="stats.check.pending">, {{ stats.check.pending }} checking…</span>
        </template>
        <template v-if="rule.enabled && stats.nextCloseMs !== null && !checked">
          · next auto-close in {{ fmtDuration(stats.nextCloseMs) }}
        </template>
      </span>
      <span class="flex shrink-0 gap-1.5">
        <button
          class="btn"
          :disabled="!actionable"
          :title="checked
            ? 'Blink the tabs that pass the page check (pinned tabs are skipped)'
            : 'Blink the matching tabs in the tab strip (pinned tabs are skipped)'"
          @click="$emit('flash')"
        >
          Flash
        </button>
        <button
          class="btn"
          :disabled="!actionable"
          :title="checked ? 'Close the tabs that pass the page check' : 'Close all matching tabs now'"
          @click="$emit('close-all')"
        >
          Close{{ actionable ? ` (${actionable})` : '' }}
        </button>
      </span>
    </div>
  </article>
</template>
