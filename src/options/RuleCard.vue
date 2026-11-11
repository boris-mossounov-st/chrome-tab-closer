<script setup>
import { computed } from 'vue';
import { ruleErrors } from '../common.js';

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

const errors = computed(() => ruleErrors(props.rule));
const count = computed(() => props.stats?.tabs.length ?? 0);
const rows = computed(() => Math.min(6, Math.max(2, (props.rule.patterns || []).length)));

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
      <label class="flex items-center gap-1 whitespace-nowrap hint" title="Close after this many minutes of inactivity">
        <input v-model.number="rule.timeoutMinutes" type="number" min="0.5" step="0.5" class="field w-16 text-right">
        min
      </label>
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
        <template v-if="rule.enabled && stats.nextCloseMs !== null">
          · next auto-close in {{ fmtDuration(stats.nextCloseMs) }}
        </template>
      </span>
      <span class="flex shrink-0 gap-1.5">
        <button
          class="btn"
          :disabled="!count"
          title="Blink the matching tabs in the tab strip (pinned tabs are skipped)"
          @click="$emit('flash')"
        >
          Flash
        </button>
        <button class="btn" :disabled="!count" @click="$emit('close-all')">
          Close all{{ count ? ` (${count})` : '' }}
        </button>
      </span>
    </div>
  </article>
</template>
