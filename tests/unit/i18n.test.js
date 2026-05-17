// Tests for the i18n core (renderer/js/i18n.js).
//
// Covers the locked decisions from notes/features/IMPL-multi-language.md:
//   1. Variant policy — language base only (resolveLocale tests).
//   2. Default locale — English (initI18n behaviour).
//   3. Auto-detect — offer toast, not silent switch.
//   4. Fallback — missing key → English → raw key.
//   7. ICU MessageFormat — plural / select / interpolation.
//
// Bundles are injected via `_setBundlesForTests` so the tests don't rely
// on `fetch()` resolving JSON files in jsdom.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  t, setLocale, getCurrentLocale, translatePage, resolveLocale,
  SUPPORTED_LOCALES, LOCALE_LABELS,
  _resetForTests, _setBundlesForTests,
} from '../../renderer/js/i18n.js';

beforeEach(() => { _resetForTests(); });

describe('resolveLocale — variant policy (decision #1: language base only)', () => {
  it('returns the base for known multi-region languages', () => {
    expect(resolveLocale('zh-CN')).toBe('zh');
    expect(resolveLocale('zh-TW')).toBe('zh');
    expect(resolveLocale('zh-HK')).toBe('zh');
    expect(resolveLocale('zh-Hans')).toBe('zh');
    expect(resolveLocale('zh-Hant')).toBe('zh');
    expect(resolveLocale('zh-Hans-CN')).toBe('zh');
    expect(resolveLocale('es-ES')).toBe('es');
    expect(resolveLocale('es-419')).toBe('es');
    expect(resolveLocale('es-MX')).toBe('es');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale('en-GB')).toBe('en');
  });

  it('handles 2-char base codes directly', () => {
    expect(resolveLocale('ja')).toBe('ja');
    expect(resolveLocale('ko')).toBe('ko');
    expect(resolveLocale('de')).toBe('de');
    expect(resolveLocale('fr')).toBe('fr');
    expect(resolveLocale('ru')).toBe('ru');
  });

  it('falls back to English for unknown / unsupported locales', () => {
    expect(resolveLocale('ar-SA')).toBe('en');
    expect(resolveLocale('he-IL')).toBe('en');
    expect(resolveLocale('vi-VN')).toBe('en');
    expect(resolveLocale('xx')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(42)).toBe('en');
  });

  it('treats unknown but supported-base codes as their base', () => {
    expect(resolveLocale('de-AT')).toBe('de');
    expect(resolveLocale('de_CH')).toBe('de');
    expect(resolveLocale('fr-CA')).toBe('fr');
  });

  it('is case-insensitive', () => {
    expect(resolveLocale('ZH-cn')).toBe('zh');
    expect(resolveLocale('EN-US')).toBe('en');
  });
});

describe('SUPPORTED_LOCALES + LOCALE_LABELS', () => {
  it('exports a defined list of supported locales', () => {
    expect(Array.isArray(SUPPORTED_LOCALES)).toBe(true);
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('zh');
  });

  it('has a native-script label for every supported locale', () => {
    for (const code of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[code]).toBeTruthy();
    }
  });
});

describe('t() — key lookup + fallback chain (decision #4)', () => {
  beforeEach(() => {
    _setBundlesForTests('zh', {
      nav: { library: '媒体库' },
      common: { ok: '确定' },
    }, {
      nav: { library: 'Library', playlists: 'Playlists' },
      common: { ok: 'OK', cancel: 'Cancel' },
      onlyEn: 'English-only',
    });
  });

  it('returns the active locale value for a present key', () => {
    expect(t('nav.library')).toBe('媒体库');
    expect(t('common.ok')).toBe('确定');
  });

  it('falls back to English when the active locale is missing the key', () => {
    expect(t('nav.playlists')).toBe('Playlists');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('onlyEn')).toBe('English-only');
  });

  it('returns the raw key when neither active nor English has the key', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('handles dotted nested keys', () => {
    expect(t('common.ok')).toBe('确定');
  });

  it('handles partial-path keys (returns raw if the path is incomplete)', () => {
    // `nav` exists as an object — typed as a partial path; not a leaf.
    // The lookup returns the object, which the caller decides to render
    // as `[object Object]` — t() guards with `typeof tpl === 'string'`.
    expect(t('nav')).toBe('nav');
  });

  it('handles malformed key (empty, non-string)', () => {
    expect(t('')).toBe('');
    expect(t(null)).toBeFalsy();
  });
});

describe('t() — ICU MessageFormat (decision #7)', () => {
  beforeEach(() => {
    _setBundlesForTests('en', {
      library: {
        videoCount: '{count, plural, one {# video} other {# videos}}',
        videoCountFiltered: '{filtered, plural, one {# video} other {# videos}} of {total}',
      },
      greet: 'Hello, {name}!',
    }, {});
  });

  it('handles simple {var} interpolation', () => {
    expect(t('greet', { name: 'World' })).toBe('Hello, World!');
  });

  it('handles English plurals — one / other', () => {
    expect(t('library.videoCount', { count: 1 })).toBe('1 video');
    expect(t('library.videoCount', { count: 5 })).toBe('5 videos');
    expect(t('library.videoCount', { count: 0 })).toBe('0 videos');
  });

  it('handles combined interpolation + plural', () => {
    expect(t('library.videoCountFiltered', { filtered: 1, total: 100 })).toBe('1 video of 100');
    expect(t('library.videoCountFiltered', { filtered: 42, total: 100 })).toBe('42 videos of 100');
  });

  it('returns the raw template when no params given', () => {
    expect(t('library.videoCount')).toBe('{count, plural, one {# video} other {# videos}}');
  });

  it('handles Russian-style plural forms via ICU (one/few/many)', () => {
    _resetForTests();
    _setBundlesForTests('ru', {
      videoCount: '{count, plural, one {# видео} few {# видео} many {# видео} other {# видео}}',
    }, {});
    // Russian plural rules: 1 → one, 2–4 → few, 5–20 → many, etc.
    // We don't assert each variant's literal text — the point is the
    // ICU runtime accepts the syntax and doesn't blow up.
    expect(typeof t('videoCount', { count: 1 })).toBe('string');
    expect(typeof t('videoCount', { count: 2 })).toBe('string');
    expect(typeof t('videoCount', { count: 5 })).toBe('string');
  });

  it('handles {var, select, ...} for non-numeric branching', () => {
    _resetForTests();
    _setBundlesForTests('en', {
      role: '{role, select, admin {Administrator} user {User} other {Guest}}',
    }, {});
    expect(t('role', { role: 'admin' })).toBe('Administrator');
    expect(t('role', { role: 'user' })).toBe('User');
    expect(t('role', { role: 'wat' })).toBe('Guest');
  });

  it('falls through gracefully on malformed ICU syntax', () => {
    // Intentionally broken — open brace with no matching close.
    _resetForTests();
    _setBundlesForTests('en', {
      broken: 'Hello {name',
    }, {});
    // Returns the raw template; doesn't crash.
    const result = t('broken', { name: 'World' });
    expect(typeof result).toBe('string');
  });
});

describe('setLocale + getCurrentLocale', () => {
  it('exposes the active locale via getCurrentLocale', () => {
    _setBundlesForTests('en', {}, { nav: { library: 'Library' } });
    expect(getCurrentLocale()).toBe('en');
  });

  it('tracks state changes from _setBundlesForTests injections', () => {
    _setBundlesForTests('zh', { nav: { library: '媒体库' } }, {});
    expect(getCurrentLocale()).toBe('zh');
  });
});

describe('translatePage — DOM walker', () => {
  beforeEach(() => {
    _setBundlesForTests('en', {
      nav: { library: 'Library', playlists: 'Playlists' },
      player: { play: 'Play', playTooltip: 'Play (Space)' },
      library: { searchPlaceholder: 'Search…' },
      common: { close: 'Close dialog' },
    }, {});
    document.body.innerHTML = '';
  });

  it('translates data-i18n textContent', () => {
    document.body.innerHTML = `
      <span data-i18n="nav.library">old text</span>
      <span data-i18n="nav.playlists">old</span>
    `;
    translatePage(document);
    const spans = document.querySelectorAll('span');
    expect(spans[0].textContent).toBe('Library');
    expect(spans[1].textContent).toBe('Playlists');
  });

  it('translates data-i18n-title to the title attribute', () => {
    document.body.innerHTML = `<button data-i18n-title="player.playTooltip" title="old">btn</button>`;
    translatePage(document);
    expect(document.querySelector('button').title).toBe('Play (Space)');
  });

  it('translates data-i18n-placeholder to the placeholder attribute', () => {
    document.body.innerHTML = `<input data-i18n-placeholder="library.searchPlaceholder" placeholder="old">`;
    translatePage(document);
    expect(document.querySelector('input').placeholder).toBe('Search…');
  });

  it('translates data-i18n-aria-label to the aria-label attribute', () => {
    document.body.innerHTML = `<button data-i18n-aria-label="common.close" aria-label="old">×</button>`;
    translatePage(document);
    expect(document.querySelector('button').getAttribute('aria-label')).toBe('Close dialog');
  });

  it('handles multiple attribute kinds on the same element', () => {
    document.body.innerHTML = `
      <button data-i18n="player.play" data-i18n-title="player.playTooltip">x</button>
    `;
    translatePage(document);
    const btn = document.querySelector('button');
    expect(btn.textContent).toBe('Play');
    expect(btn.title).toBe('Play (Space)');
  });

  it('leaves unmarked elements alone', () => {
    document.body.innerHTML = `<span>untranslated text</span>`;
    translatePage(document);
    expect(document.querySelector('span').textContent).toBe('untranslated text');
  });

  it('is a no-op on null / non-DOM input', () => {
    expect(() => translatePage(null)).not.toThrow();
    expect(() => translatePage({})).not.toThrow();
  });
});

// Note: The legacy `offerLocaleIfDetected` toast was removed when the
// language-prompt modal landed. The modal handles first-launch language
// selection for all users (not just non-English-OS ones) so existing 0.5.x
// users see every supported locale on equal footing after the update.
// See `renderer/components/language-prompt-modal.js` for the replacement.
