// i18n core — handles locale selection, key lookup, ICU MessageFormat
// formatting, and DOM-attribute translation. Pattern mirrors
// `renderer/js/theme-manager.js` (settings-backed preference, reactive
// listener, single setter that updates state + emits an event).
//
// Locked architectural decisions live in
// `notes/features/IMPL-multi-language.md`:
//   - Variant policy: language base only (`zh` not `zh-CN`).
//   - Default locale: 'en'.
//   - Auto-detect: surfaces a non-intrusive toast (handled by
//     `offerLocaleIfDetected`); silent auto-switch is intentionally not
//     done.
//   - Fallback: missing key → English value → raw key string.
//   - Persistence: `settings.player.language`. `_localeOfferedFor` is the
//     marker that suppresses the offer-toast after one round.
//   - Plural-form runtime: ICU MessageFormat via `intl-messageformat`.

// NOTE: `intl-messageformat/index.js` is technically ESM but its top-level
// imports use bare specifiers (`@formatjs/fast-memoize`, etc.) that the
// Electron renderer (contextIsolation: true, nodeIntegration: false) can't
// resolve. The `.iife.js` build despite its name still uses ESM `export`
// syntax — it just inlines every dependency so there are no bare specifiers
// to resolve. That's the only variant that loads in the renderer.
import { IntlMessageFormat } from '../../node_modules/intl-messageformat/intl-messageformat.iife.js';
import { eventBus } from './event-bus.js';

// Supported locales — must match the JSON files in renderer/locales/.
// English is always the fallback; the others are the rollout tiers from
// the IMPL doc. Adding a new locale = drop a JSON file + extend this set
// + add an entry to LOCALE_LABELS so the dropdown can show its native
// name. Nothing else.
export const SUPPORTED_LOCALES = ['en', 'zh', 'ja', 'ko', 'de', 'es', 'fr', 'ru'];
export const LOCALE_LABELS = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  ru: 'Русский',
};

const DEFAULT_LOCALE = 'en';

// Module state. `_dict` is the merged active-locale bundle (used first
// in lookups); `_enDict` is always available as the English fallback per
// decision #4. Compiled-message cache avoids re-parsing the ICU AST on
// every `t()` call — the parser is the expensive part.
let _currentLocale = DEFAULT_LOCALE;
let _dict = {};
let _enDict = {};
const _compileCache = new Map();
let _initialized = false;

/**
 * Map an OS / browser locale string to one of the supported language-
 * base codes. Per IMPL decision #1, regional variants collapse to the
 * base language. Unknown locales fall back to English.
 *
 * Pure — exported for testing the mapping table independently.
 *
 * @param {string | null | undefined} rawCode
 * @returns {string} one of SUPPORTED_LOCALES
 */
export function resolveLocale(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') return DEFAULT_LOCALE;
  const lower = rawCode.toLowerCase();
  // Strip script subtags first (`zh-Hans-CN` → `zh-Hans` → handled below).
  // The mapping below handles all common shapes BCP-47 produces.
  if (/^zh(-|_|$)/.test(lower)) return 'zh';
  if (/^es(-|_|$)/.test(lower)) return 'es';
  if (/^pt(-|_|$)/.test(lower)) return 'pt';  // pt not yet in SUPPORTED_LOCALES — falls through to en below
  if (/^en(-|_|$)/.test(lower)) return 'en';
  // Base 2-char code lookup.
  const base = lower.split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(base) ? base : DEFAULT_LOCALE;
}

/**
 * Look up a key in the active locale, falling back to English then to
 * the raw key string. Dotted notation walks nested objects:
 * `t('nav.library')` → dict.nav.library.
 *
 * @param {string} key
 * @param {Object} [params] interpolation values for ICU MessageFormat
 * @returns {string}
 */
export function t(key, params) {
  const tpl = _lookup(_dict, key) ?? _lookup(_enDict, key);
  if (tpl == null) return key;
  if (!params) return typeof tpl === 'string' ? tpl : key;
  // Compile + format. ICU MessageFormat handles plurals, select, and
  // simple {var} interpolation in one syntax. Compiled message cached
  // by `${locale}|${key}` so a runtime locale switch invalidates only
  // the relevant entries.
  const cacheKey = `${_currentLocale}|${key}`;
  let msg = _compileCache.get(cacheKey);
  if (!msg) {
    try {
      msg = new IntlMessageFormat(tpl, _currentLocale);
      _compileCache.set(cacheKey, msg);
    } catch (err) {
      // Malformed ICU syntax — log and fall through to the raw template
      // string. This lets a corrupted translation file land without
      // breaking the whole UI.
      console.warn(`[i18n] Failed to compile message "${key}":`, err.message);
      return typeof tpl === 'string' ? tpl : key;
    }
  }
  try {
    const out = msg.format(params);
    return Array.isArray(out) ? out.join('') : String(out);
  } catch (err) {
    console.warn(`[i18n] Failed to format message "${key}":`, err.message);
    return typeof tpl === 'string' ? tpl : key;
  }
}

function _lookup(dict, key) {
  if (!dict || typeof key !== 'string') return undefined;
  const parts = key.split('.');
  let cur = dict;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Activate a locale. Loads the JSON bundle if it isn't already loaded,
 * updates the document <html lang>, clears the compile cache, and
 * emits `language:changed` so subscribing components can re-render.
 *
 * Always preloads English alongside the requested locale so the fallback
 * chain works (decision #4).
 *
 * @param {string} locale
 */
export async function setLocale(locale) {
  const resolved = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  if (_initialized && _currentLocale === resolved) return;

  // Always need en loaded for fallback.
  if (Object.keys(_enDict).length === 0) {
    _enDict = await _loadBundle('en');
  }
  _dict = resolved === 'en' ? _enDict : await _loadBundle(resolved);
  _currentLocale = resolved;
  _compileCache.clear();
  _initialized = true;

  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = resolved;
  }
  if (eventBus?.emit) eventBus.emit('language:changed', { locale: resolved });
}

export function getCurrentLocale() { return _currentLocale; }

async function _loadBundle(locale) {
  try {
    // Same import pattern as the rest of the renderer — relative path
    // to a file that ships in the asar. JSON imports require a Vite or
    // similar build; the codebase uses fetch with file:// for now.
    const url = new URL(`../locales/${locale}.json`, import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[i18n] Failed to load locale '${locale}':`, err.message);
    return {};
  }
}

/**
 * Walk the document and translate every element carrying a data-i18n*
 * attribute. Called after each `setLocale()` and once at boot.
 *
 * Recognised attributes:
 *   data-i18n               → textContent
 *   data-i18n-title         → title attribute
 *   data-i18n-placeholder   → placeholder attribute
 *   data-i18n-aria-label    → aria-label attribute
 *
 * Static — no interpolation params at this layer. Components needing
 * dynamic strings call `t()` directly during their own render.
 */
export function translatePage(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }
  for (const attrName of ['title', 'placeholder', 'aria-label']) {
    const dataName = `data-i18n-${attrName}`;
    for (const el of root.querySelectorAll(`[${dataName}]`)) {
      const key = el.getAttribute(dataName);
      if (key) el.setAttribute(attrName, t(key));
    }
  }
}

/**
 * One-shot initialization. Reads `app.getLocale()` (via window.funsync
 * preload bridge), respects the saved `settings.player.language`, and
 * activates the right locale before any component renders.
 *
 * @param {Object} args
 * @param {string} args.savedLocale — `settings.player.language` value ('en' by default per decision #2)
 */
export async function initI18n({ savedLocale }) {
  // savedLocale is the persisted user choice. If absent, default to en.
  // Per decision #2 we DO NOT silently switch based on system locale —
  // the first-launch language-prompt modal (renderer/components/language-
  // prompt-modal.js) handles that case explicitly so all users see every
  // supported language, not just the OS-suggested one.
  const chosen = SUPPORTED_LOCALES.includes(savedLocale) ? savedLocale : DEFAULT_LOCALE;
  await setLocale(chosen);
}

// Test-only — reset module state between cases.
export function _resetForTests() {
  _currentLocale = DEFAULT_LOCALE;
  _dict = {};
  _enDict = {};
  _compileCache.clear();
  _initialized = false;
}

/**
 * Test-only — inject bundles synchronously so test cases don't need to
 * mock `fetch`. Sets the active locale + dict + en fallback in one call.
 */
export function _setBundlesForTests(locale, bundle, enBundle) {
  _currentLocale = locale;
  _dict = bundle || {};
  _enDict = enBundle || {};
  _compileCache.clear();
  _initialized = true;
}
