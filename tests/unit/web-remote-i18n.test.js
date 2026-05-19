// Smoke tests for backend/web-remote/i18n.js — the sibling i18n module
// for the web remote SPA. Mirrors the test surface of
// tests/unit/i18n.test.js but with the web-remote-specific concerns:
//
//   - Locale comes from the backend's /api/remote/locale endpoint, not
//     from a saved-setting argument.
//   - Locale bundles come from /locales/<lang>.json via fetch.
//   - Fallback chain: key → English → raw key string.
//
// Bundles + the locale endpoint are injected via _setBundlesForTests
// and a stub global fetch so we don't need a live backend.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  t,
  setLocale,
  getCurrentLocale,
  translatePage,
  initWebRemoteI18n,
  _resetForTests,
  _setBundlesForTests,
} from '../../backend/web-remote/i18n.js';

beforeEach(() => {
  _resetForTests();
});

describe('t() — lookup + fallback chain', () => {
  it('returns the value from the active locale', () => {
    _setBundlesForTests(
      'zh',
      { webRemote: { nav: { library: '媒体库' } } },
      { webRemote: { nav: { library: 'Library' } } },
    );
    expect(t('webRemote.nav.library')).toBe('媒体库');
  });

  it('falls back to English when key missing in active bundle', () => {
    _setBundlesForTests(
      'zh',
      { webRemote: {} },
      { webRemote: { nav: { library: 'Library' } } },
    );
    expect(t('webRemote.nav.library')).toBe('Library');
  });

  it('returns the raw key when missing from both bundles', () => {
    _setBundlesForTests('zh', {}, {});
    expect(t('webRemote.no.such.key')).toBe('webRemote.no.such.key');
  });
});

describe('t() — ICU interpolation + plural + select', () => {
  it('interpolates simple placeholders', () => {
    _setBundlesForTests('en', {
      hello: 'Hello, {name}!',
    }, {});
    expect(t('hello', { name: 'Dave' })).toBe('Hello, Dave!');
  });

  it('handles ICU plural', () => {
    _setBundlesForTests('en', {
      count: '{n, plural, one {# item} other {# items}}',
    }, {});
    expect(t('count', { n: 1 })).toBe('1 item');
    expect(t('count', { n: 5 })).toBe('5 items');
  });

  it('handles ICU select (used for grouping kind labels)', () => {
    _setBundlesForTests('en', {
      group: '{kind, select, collections {Collection} playlists {Playlist} categories {Category} other {Item}}',
    }, {});
    expect(t('group', { kind: 'collections' })).toBe('Collection');
    expect(t('group', { kind: 'playlists' })).toBe('Playlist');
    expect(t('group', { kind: 'unknown' })).toBe('Item');
  });
});

describe('setLocale() — bundle fetch + fallback', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches /locales/<lang>.json and switches dict', async () => {
    const bundles = {
      'en.json': { greeting: 'Hello' },
      'zh.json': { greeting: '你好' },
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const name = String(url).split('/').pop();
      if (bundles[name]) {
        return { ok: true, json: async () => bundles[name] };
      }
      return { ok: false, status: 404 };
    }));
    await setLocale('zh');
    expect(getCurrentLocale()).toBe('zh');
    expect(t('greeting')).toBe('你好');
  });

  it('falls back to English on unknown locale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const name = String(url).split('/').pop();
      if (name === 'en.json') {
        return { ok: true, json: async () => ({ greeting: 'Hello' }) };
      }
      return { ok: false, status: 404 };
    }));
    await setLocale('xx');
    // Resolved locale falls back to default 'en' when bundle fetch fails
    expect(getCurrentLocale()).toBe('en');
    expect(t('greeting')).toBe('Hello');
  });
});

describe('translatePage() — DOM walker', () => {
  it('applies data-i18n / data-i18n-title / data-i18n-aria-label / data-i18n-placeholder', () => {
    _setBundlesForTests('en', {
      label: 'Label',
      title: 'Title text',
      aria: 'Aria text',
      ph: 'Placeholder',
    }, {});
    const root = document.createElement('div');
    root.innerHTML = `
      <span data-i18n="label">old</span>
      <button data-i18n-title="title">btn</button>
      <button data-i18n-aria-label="aria">btn</button>
      <input data-i18n-placeholder="ph">
    `;
    translatePage(root);
    expect(root.querySelector('[data-i18n="label"]').textContent).toBe('Label');
    expect(root.querySelector('[data-i18n-title]').getAttribute('title')).toBe('Title text');
    expect(root.querySelector('[data-i18n-aria-label]').getAttribute('aria-label')).toBe('Aria text');
    expect(root.querySelector('[data-i18n-placeholder]').getAttribute('placeholder')).toBe('Placeholder');
  });
});

describe('initWebRemoteI18n() — bootstrap from /api/remote/locale', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads locale from the backend and activates it', async () => {
    const bundles = {
      'en.json': { hi: 'Hi' },
      'fr.json': { hi: 'Salut' },
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url);
      if (s.endsWith('/api/remote/locale')) {
        return { ok: true, json: async () => ({ locale: 'fr' }) };
      }
      const name = s.split('/').pop();
      if (bundles[name]) {
        return { ok: true, json: async () => bundles[name] };
      }
      return { ok: false, status: 404 };
    }));
    await initWebRemoteI18n();
    expect(getCurrentLocale()).toBe('fr');
    expect(t('hi')).toBe('Salut');
  });

  it('falls back to en when the locale endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url);
      if (s.endsWith('/api/remote/locale')) {
        return { ok: false, status: 500 };
      }
      if (s.endsWith('en.json')) {
        return { ok: true, json: async () => ({ hi: 'Hi' }) };
      }
      return { ok: false, status: 404 };
    }));
    await initWebRemoteI18n();
    expect(getCurrentLocale()).toBe('en');
    expect(t('hi')).toBe('Hi');
  });

  it('falls back to en when the locale endpoint throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url);
      if (s.endsWith('/api/remote/locale')) throw new Error('network');
      if (s.endsWith('en.json')) {
        return { ok: true, json: async () => ({ hi: 'Hi' }) };
      }
      return { ok: false, status: 404 };
    }));
    await initWebRemoteI18n();
    expect(getCurrentLocale()).toBe('en');
  });
});
