// Shared between the background service worker and the settings page.
//
// Rules are stored in chrome.storage.sync (built-in browser storage, synced with your
// Chrome profile). DEFAULT_RULES below is only used to seed storage on first install
// and by the "Restore defaults" button.
//
// Rule shape: { id, enabled, title, patterns: string[], timeoutMinutes }
// Pattern syntax: "/regex/flags" -> regular expression tested against the full URL,
//                 anything else  -> exact URL match.

export const DEFAULT_RULES = [
  {
    id: 'zoom',
    enabled: true,
    title: 'Zoom meeting launcher',
    // e.g. https://sensortower.zoom.us/j/99066921644?pwd=...#success
    // (does not match /wc/ — the in-browser Zoom web client)
    patterns: ['/^https:\\/\\/([\\w-]+\\.)*zoom\\.us\\/(j|s|my)\\//'],
    timeoutMinutes: 1,
  },
  {
    id: 'aws',
    enabled: true,
    title: 'AWS sign-in / SSO',
    patterns: [
      // e.g. https://us-east-1.signin.aws/platform/d-.../login?...
      '/^https:\\/\\/([\\w-]+\\.)*signin\\.aws(\\.amazon\\.com)?\\//',
      // page opened by `aws sso login`
      '/^https:\\/\\/[\\w-]+\\.awsapps\\.com\\/start\\/?#\\/device/',
    ],
    timeoutMinutes: 5,
  },
  {
    id: 'google-docs',
    enabled: true,
    title: 'Google Docs / Sheets / Slides',
    patterns: ['/^https:\\/\\/docs\\.google\\.com\\/(document|spreadsheets|presentation)\\//'],
    timeoutMinutes: 60,
  },
];

export const DEFAULT_SETTINGS = {
  rules: DEFAULT_RULES,
  skipPinned: true,   // never auto-close pinned tabs
  skipAudible: true,  // never auto-close tabs playing audio (e.g. a meeting in the browser)
};

export const newId = () => Math.random().toString(36).slice(2, 10);

// ---------- Storage ----------

/** Converts rules saved by v1.0 ({name, type, pattern}) to the current shape. */
function migrateRule(r) {
  if (Array.isArray(r.patterns)) return r;
  const p = r.pattern || '';
  return {
    id: r.id || newId(),
    enabled: r.enabled !== false,
    title: r.name || '',
    patterns: p ? [r.type === 'exact' ? p : `/${p}/`] : [],
    timeoutMinutes: r.timeoutMinutes,
  };
}

export async function hasStoredSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return !!settings;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...(settings || {}) };
  merged.rules = merged.rules.map(migrateRule);
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

// ---------- Matching ----------

const cache = new Map();

/** Parses one pattern line -> { kind: 'regex'|'exact'|'empty', re?, value?, error? } */
export function parsePattern(line) {
  const s = (line || '').trim();
  if (cache.has(s)) return cache.get(s);
  let parsed;
  const m = s.match(/^\/(.+)\/([dimsuv]*)$/);
  if (!s) parsed = { kind: 'empty' };
  else if (m) {
    try { parsed = { kind: 'regex', re: new RegExp(m[1], m[2]) }; }
    catch (e) { parsed = { kind: 'regex', error: e.message }; }
  } else parsed = { kind: 'exact', value: s };
  cache.set(s, parsed);
  return parsed;
}

/** Does any of the rule's patterns match the URL? (ignores `enabled`) */
export function ruleMatchesUrl(rule, url) {
  if (!url) return false;
  return (rule.patterns || []).some((line) => {
    const p = parsePattern(line);
    if (p.kind === 'regex') return p.re ? p.re.test(url) : false;
    if (p.kind === 'exact') return p.value === url;
    return false;
  });
}

/** First enabled rule matching the URL, or null. */
export function findRule(rules, url) {
  return rules.find((r) => r.enabled && ruleMatchesUrl(r, url)) || null;
}

export function timeoutMs(rule) {
  const n = Number(rule.timeoutMinutes);
  return n > 0 ? n * 60_000 : Infinity;
}

/** List of human-readable problems with a rule (empty if fine). */
export function ruleErrors(rule) {
  const errors = [];
  (rule.patterns || []).forEach((line, i) => {
    const p = parsePattern(line);
    if (p.error) errors.push(`Line ${i + 1}: invalid regex — ${p.error}`);
  });
  if (!(rule.patterns || []).some((l) => l.trim())) errors.push('No patterns — rule matches nothing');
  if (!(Number(rule.timeoutMinutes) > 0)) errors.push('Timeout must be greater than 0');
  return errors;
}

// ---------- Closing ----------

const CLOSED_LOG_MAX = 30;

/** Closes tabs and records them in the "recently closed" log. entries: [{tab, reason}] */
export async function closeTabs(entries) {
  if (!entries.length) return;
  try {
    await chrome.tabs.remove(entries.map((e) => e.tab.id));
  } catch (e) {
    console.warn('Tab Closer: failed to close some tabs', e);
  }
  const now = Date.now();
  const { closedLog = [] } = await chrome.storage.local.get('closedLog');
  const added = entries.map(({ tab, reason }) => ({
    time: now, title: tab.title || '', url: tab.url || '', rule: reason,
  }));
  await chrome.storage.local.set({ closedLog: [...added, ...closedLog].slice(0, CLOSED_LOG_MAX) });
}
