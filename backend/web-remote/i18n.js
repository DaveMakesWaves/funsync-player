// Web-remote i18n — sibling to renderer/js/i18n.js.
//
// Architectural decisions mirror the desktop (see
// notes/features/IMPL-multi-language.md), with two web-remote-only
// adjustments:
//
//   - Variant policy: language base only (`zh`, not `zh-CN`).
//   - Default locale: 'en'.
//   - Active locale comes from the backend (`/api/remote/locale`),
//     which reads the desktop's persisted setting. The phone does NOT
//     present its own picker — option-2 scope from
//     notes/features/SCOPE-web-remote-i18n.md.
//   - Fallback chain: missing key → English bundle → raw key string.
//   - Locale bundles are served by the backend at `/locales/<lang>.json`
//     (mounted from the same renderer/locales/ source the desktop uses,
//     bundled into the PyInstaller exe in packaged builds).
//   - ICU MessageFormat plurals via the vendored
//     intl-messageformat.iife.js — same library the renderer uses.
//
// No SUPPORTED_LOCALES check on input: if the backend reports a code we
// don't recognise, the bundle fetch fails and we fall back to 'en'.

import { IntlMessageFormat } from './vendor/intl-messageformat.iife.js';

const DEFAULT_LOCALE = 'en';

// Module state.
let _currentLocale = DEFAULT_LOCALE;
let _dict = {};
let _enDict = {};
const _compileCache = new Map();
let _initialized = false;

/**
 * Resolve a t-key against the active locale, falling back to English
 * then to the raw key string. Dotted notation walks nested objects:
 *   t('webRemote.player.connecting')
 *     → dict.webRemote.player.connecting
 *
 * @param {string} key
 * @param {Object} [params] — interpolation values for ICU MessageFormat
 * @returns {string}
 */
export function t(key, params) {
  const tpl = _lookup(_dict, key) ?? _lookup(_enDict, key);
  if (tpl == null) return key;
  if (!params) return typeof tpl === 'string' ? tpl : key;
  const cacheKey = `${_currentLocale}|${key}`;
  let msg = _compileCache.get(cacheKey);
  if (!msg) {
    try {
      msg = new IntlMessageFormat(tpl, _currentLocale);
      _compileCache.set(cacheKey, msg);
    } catch (err) {
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
 * Activate a locale by code. Always preloads the English bundle so the
 * fallback chain works. Idempotent — second call with the same code is
 * a no-op after the first successful init.
 *
 * @param {string} locale
 */
export async function setLocale(locale) {
  const wanted = (typeof locale === 'string' && locale) ? locale : DEFAULT_LOCALE;
  if (_initialized && _currentLocale === wanted) return;
  if (Object.keys(_enDict).length === 0) {
    _enDict = await _loadBundle(DEFAULT_LOCALE);
  }
  _dict = wanted === DEFAULT_LOCALE ? _enDict : await _loadBundle(wanted);
  if (Object.keys(_dict).length === 0 && wanted !== DEFAULT_LOCALE) {
    // Unknown / failed bundle → silently fall back to English.
    _dict = _enDict;
    _currentLocale = DEFAULT_LOCALE;
  } else {
    _currentLocale = wanted;
  }
  _compileCache.clear();
  _initialized = true;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = _currentLocale;
  }
}

export function getCurrentLocale() { return _currentLocale; }

async function _loadBundle(locale) {
  try {
    // Cache-bust per app version so phones don't hold a stale bundle
    // when the desktop ships new strings. Backend serves the JSON via
    // a StaticFiles mount; query params don't affect the file resolved.
    const url = `/locales/${locale}.json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[i18n] Failed to load locale '${locale}':`, err.message);
    return {};
  }
}

/**
 * Walk the document tree and translate every element carrying a
 * data-i18n* attribute. Mirrors renderer/js/i18n.js::translatePage.
 *
 * Attributes recognised:
 *   data-i18n              → textContent
 *   data-i18n-title        → title attribute
 *   data-i18n-placeholder  → placeholder attribute
 *   data-i18n-aria-label   → aria-label attribute
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
 * One-shot bootstrap: ask the backend which locale the desktop is
 * using, then activate it. Caller should `await` this before rendering
 * any UI that uses t() so the first paint is correct.
 */
export async function initWebRemoteI18n() {
  let locale = DEFAULT_LOCALE;
  try {
    const r = await fetch('/api/remote/locale', { cache: 'no-cache' });
    if (r.ok) {
      const body = await r.json();
      if (body && typeof body.locale === 'string') locale = body.locale;
      // Theme mirroring (F5, 2026-08-04): same endpoint carries the
      // desktop's theme. 'system' resolves via prefers-color-scheme.
      // Applied here (the one guaranteed pre-render await) so the first
      // paint is already themed — same rule as the locale itself.
      applyRemoteTheme(body && body.theme);
    }
  } catch {
    // Network glitch / endpoint missing → stay on default. Web-remote
    // remains usable; just in English + dark.
  }
  await setLocale(locale);
}

/** Set <html data-theme> + the PWA theme-color meta from the desktop's theme. */
export function applyRemoteTheme(theme) {
  let effective = theme === 'light' || theme === 'dark' ? theme : null;
  if (!effective) {
    // 'system' / unknown → follow the PHONE's own preference.
    try {
      effective = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    } catch { effective = 'dark'; }
  }
  document.documentElement.dataset.theme = effective;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = effective === 'light' ? '#f5f5f7' : '#1a1a2e';
}

// Test-only — reset module state between cases (mirror of the
// renderer's _resetForTests so the parallel test file can clean up).
export function _resetForTests() {
  _currentLocale = DEFAULT_LOCALE;
  _dict = {};
  _enDict = {};
  _compileCache.clear();
  _initialized = false;
}

export function _setBundlesForTests(locale, bundle, enBundle) {
  _currentLocale = locale;
  _dict = bundle || {};
  _enDict = enBundle || {};
  _compileCache.clear();
  _initialized = true;
}
