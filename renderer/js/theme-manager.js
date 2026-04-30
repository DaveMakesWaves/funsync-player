// theme-manager — applies the current theme to <html> and keeps it in
// sync with both the user's `settings.player.theme` choice AND the OS
// `prefers-color-scheme` when the user has chosen 'system' (the default).
//
// Settings changes flow through the shared event-bus (`eventBus.emit
// ('settings:changed', { path, value })` from data-service.js). The
// manager subscribes to that and re-applies whenever `player.theme`
// changes — keeps the settings panel decoupled from the manager.

import { eventBus } from './event-bus.js';
//
// Three valid values for `settings.player.theme`:
//   'system' — follow the OS preference (default for new installs)
//   'dark'   — always dark (the FunSync palette pre-redesign)
//   'light'  — always light (new in 2026-04-27 redesign)
//
// The theme is applied via `<html data-theme="dark|light">`. CSS in
// `renderer/styles/player.css` reads the attribute via
// `:root[data-theme="..."]` selectors.
//
// Pure functions where possible — `resolveEffectiveTheme()` is pure;
// `applyTheme()` and `initTheme()` touch the DOM.

const VALID_THEMES = new Set(['system', 'dark', 'light']);
const DEFAULT_THEME = 'system';

let _systemQuery = null;
let _systemListener = null;

/**
 * Resolve the user's theme preference into the *effective* applied
 * theme. Pure — no DOM, no side effects.
 *
 * @param {string} setting — value from settings.player.theme
 * @param {boolean} prefersDark — typically `window.matchMedia('(prefers-color-scheme: dark)').matches`
 * @returns {'dark'|'light'}
 */
export function resolveEffectiveTheme(setting, prefersDark) {
  const valid = VALID_THEMES.has(setting) ? setting : DEFAULT_THEME;
  if (valid === 'dark') return 'dark';
  if (valid === 'light') return 'light';
  // 'system' branch: defer to the OS. Default to dark when prefersDark
  // is undefined (early call before matchMedia evaluates) since the
  // app's pre-redesign theme was dark — keeps first-frame consistent.
  return prefersDark === false ? 'light' : 'dark';
}

/**
 * Apply a theme to <html data-theme="...">. Side-effect-only; does NOT
 * persist. Call this AFTER `setSetting()` to reflect the change visually.
 * @param {'dark'|'light'} effective
 */
export function applyTheme(effective) {
  if (effective !== 'dark' && effective !== 'light') return;
  document.documentElement.dataset.theme = effective;
}

/**
 * Initialize on app startup:
 *   1. Resolve the effective theme from setting + OS preference.
 *   2. Apply it.
 *   3. If the setting is 'system', wire a MediaQueryList listener so
 *      the theme tracks OS changes (user flips OS to dark at sundown).
 *
 * Returns a cleanup function that detaches the listener (useful for
 * tests; production never needs to call it because the page lives for
 * the app's lifetime).
 *
 * @param {object} dataService — DataService instance (reads/persists settings)
 */
export function initTheme(dataService) {
  const setting = dataService?.get?.('player.theme') || DEFAULT_THEME;
  _applyFromSetting(setting);

  // React to settings changes from anywhere (settings panel, IPC, etc.)
  // by re-resolving on each settings:changed event broadcast on the
  // shared event-bus (data-service.js emits this after every set()).
  eventBus.on('settings:changed', ({ path }) => {
    if (path === 'player.theme') {
      _applyFromSetting(dataService.get('player.theme') || DEFAULT_THEME);
    }
  });

  // Hook OS-theme changes when the user has selected 'system'. The
  // listener is single-shot wired so re-init doesn't double-attach.
  if (typeof window !== 'undefined' && window.matchMedia) {
    _systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (_systemListener && _systemQuery.removeEventListener) {
      _systemQuery.removeEventListener('change', _systemListener);
    }
    _systemListener = () => {
      const cur = dataService?.get?.('player.theme') || DEFAULT_THEME;
      if (cur === 'system') _applyFromSetting('system');
    };
    if (_systemQuery.addEventListener) {
      _systemQuery.addEventListener('change', _systemListener);
    }
  }

  return () => {
    if (_systemQuery && _systemListener && _systemQuery.removeEventListener) {
      _systemQuery.removeEventListener('change', _systemListener);
    }
    _systemListener = null;
    _systemQuery = null;
  };
}

function _applyFromSetting(setting) {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;
  applyTheme(resolveEffectiveTheme(setting, prefersDark));
}

/** Test helper — reset module-level state. */
export function _resetForTests() {
  if (_systemQuery && _systemListener && _systemQuery.removeEventListener) {
    _systemQuery.removeEventListener('change', _systemListener);
  }
  _systemQuery = null;
  _systemListener = null;
}
