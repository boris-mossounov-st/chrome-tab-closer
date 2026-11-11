// Shared between the background service worker and the settings page.
//
// Rules are stored in chrome.storage.sync (built-in browser storage, synced with your
// Chrome profile). DEFAULT_RULES below is only used to seed storage on first install,
// to add newly introduced defaults on update (see `addedIn`), and by "Restore defaults".
//
// Rule shape: { id, enabled, title, patterns: string[], timeoutMinutes, check? }
// Pattern syntax: "/regex/flags" -> regular expression tested against the full URL,
//                 anything else  -> exact URL match.
//
// Optional page check: check = { selector, text, sites }
//   The tab only qualifies if the page has an element matching `selector` (CSS) whose
//   visible text contains `text` (plain substring, or "/regex/flags"); either may be empty.
//   `sites` lists the hosts the extension may read ("github.com, *.awsapps.com") — access
//   is granted per site from the settings page. Pages that can't be read are kept open.

/** Bump when adding default rules; rules with `addedIn` > the user's stored version get added on update. */
export const DEFAULTS_VERSION = 2;

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
    id: 'aws-cli-approved',
    addedIn: 2,
    enabled: true,
    title: 'AWS CLI login approved',
    // Pages left behind by `aws sso login`, closed only once they say "Request approved".
    patterns: [
      '/^https:\\/\\/[\\w-]+\\.awsapps\\.com\\/start\\//',
      '/^http:\\/\\/(127\\.0\\.0\\.1|localhost):\\d+\\/oauth\\/callback/',
    ],
    check: { selector: 'body', text: 'Request approved', sites: '*.awsapps.com, 127.0.0.1, localhost' },
    timeoutMinutes: 1,
  },
  {
    id: 'aws',
    enabled: true,
    title: 'AWS sign-in',
    // e.g. https://us-east-1.signin.aws/platform/d-.../login?...
    patterns: ['/^https:\\/\\/([\\w-]+\\.)*signin\\.aws(\\.amazon\\.com)?\\//'],
    timeoutMinutes: 5,
  },
  {
    id: 'google-docs',
    enabled: true,
    title: 'Google Docs / Sheets / Slides',
    patterns: ['/^https:\\/\\/docs\\.google\\.com\\/(document|spreadsheets|presentation)\\//'],
    timeoutMinutes: 60,
  },
  {
    id: 'github-done',
    addedIn: 2,
    enabled: true,
    title: 'GitHub closed issues / merged PRs',
    patterns: ['/^https:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/(issues|pull)\\/\\d+/'],
    // The item's own state badge in the (sticky) header. Linked issues/PRs elsewhere on the
    // page use different markup, so they don't trigger this.
    check: {
      selector: '[data-component="StateLabel"]:is([data-status^="issueClosed"], [data-status="pullMerged"], [data-status="pullClosed"])',
      text: '',
      sites: 'github.com',
    },
    timeoutMinutes: 30,
  },
];

export const DEFAULT_SETTINGS = {
  rules: DEFAULT_RULES.map(({ addedIn, ...r }) => r),
  defaultsVersion: DEFAULTS_VERSION,
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

/** Fresh copy of the default rules (without internal fields). */
export const defaultRules = () => structuredClone(DEFAULT_SETTINGS.rules);

export async function hasStoredSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return !!settings;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...(settings || {}) };
  // Settings saved before defaults were versioned count as version 1.
  if (settings && settings.defaultsVersion == null) merged.defaultsVersion = 1;
  merged.rules = merged.rules.map(migrateRule);
  return merged;
}

/**
 * Inserts default rules introduced after the user's `defaultsVersion` (at their default
 * position), without touching existing rules. Returns true if anything changed.
 */
export function addNewDefaults(settings) {
  const from = settings.defaultsVersion ?? 1;
  if (from >= DEFAULTS_VERSION) return false;
  DEFAULT_RULES.forEach(({ addedIn = 1, ...rule }, index) => {
    if (addedIn > from && !settings.rules.some((r) => r.id === rule.id)) {
      settings.rules.splice(Math.min(index, settings.rules.length), 0, structuredClone(rule));
    }
  });
  settings.defaultsVersion = DEFAULTS_VERSION;
  return true;
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

// ---------- Page check ----------

/** Does the rule have a page check (selector and/or text)? */
export function hasCheck(rule) {
  return !!(rule.check && (rule.check.selector?.trim() || rule.check.text?.trim()));
}

/** "github.com, https://*.example.com/x" -> ['github.com', '*.example.com'] */
export function parseSites(sites) {
  return (sites || '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^[a-z*]+:\/\//i, '').replace(/[/:].*$/, '').toLowerCase())
    .filter(Boolean);
}

/** Host permission patterns for a rule's sites (any scheme, any port, any path). */
export function siteOrigins(rule) {
  return parseSites(rule.check?.sites).map((host) => `*://${host}/*`);
}

/** Does a hostname fall under one of the sites ("*.example.com" also matches "example.com")? */
export function hostCovered(host, sites) {
  return parseSites(sites).some((site) => (site.startsWith('*.')
    ? host === site.slice(2) || host.endsWith(site.slice(1))
    : host === site));
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
  if (hasCheck(rule)) {
    const t = parsePattern(rule.check.text);
    if (t.error) errors.push(`Page check text: invalid regex — ${t.error}`);
    if (!parseSites(rule.check.sites).length) errors.push('Page check needs at least one site to read');
  }
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
