/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScriptsPanel builds its DOM, sets real button
 * labels and imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// What the EroScripts panel tells the user when a forum call fails
// (real-app checks verify-2, 2026-11-07; both also in v0.9.2):
//
//   FT-082  an expired session on the TOPIC call (Get Script) showed TWO
//           toasts: the localised "session expired" warning and an error
//           toast with main's English "Access denied — try logging in again".
//   i18n    the results area (and that toast) printed main's English error
//           sentences in every language: "Access denied — ...", "Rate
//           limited — ...", "Search failed (N) — ...".
//
// REAL panel, REAL i18n with the real French and German bundles, fake IPC
// answering exactly what electron/eroscripts-api.js returns. Asserted: the
// toasts shown and the text in the results area.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { eroscriptsErrorText } = await import('../../renderer/js/eroscripts-error-text.js');

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const FR = bundle('fr');
const DE = bundle('de');

// What main answers (electron/eroscripts-api.js), English `error` and all.
const SEARCH_403 = { results: [], error: 'Access denied — try logging in again', errorCode: 'accessDenied', authExpired: true };
const SEARCH_429 = { results: [], error: 'Rate limited — try again in a moment', errorCode: 'rateLimited' };
const SEARCH_502 = { results: [], error: 'Search failed (502) — try logging out and back in', errorCode: 'searchFailed', status: 502 };
const TOPIC_403 = { attachments: [], error: 'Access denied — try logging in again', errorCode: 'accessDenied', authExpired: true };
const TOPIC_500 = { attachments: [], error: 'Failed to load topic (500)', errorCode: 'topicFailed', status: 500 };

let settings;
function makePanel() {
  settings = new Map([['eroscripts.session', { cookie: 'TESTKEY01', username: 'tester' }]]);
  const panel = new EroScriptsPanel({
    settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) },
  });
  panel._setLoggedIn('tester');
  return panel;
}

async function search(panel, q = 'alpha') {
  panel._panel.querySelector('#es-search-input').value = q;
  await panel._search();
  return panel._panel.querySelector('#es-results').textContent.trim();
}

const toastCalls = () => showToast.mock.calls.map(([text, type]) => ({ text: String(text), type }));

beforeEach(() => {
  _setBundlesForTests('fr', FR, EN);
  showToast.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
  window.funsync = {
    // The constructor's session restore: the dummy session is valid.
    eroscriptsRestoreSession: vi.fn(async () => {}),
    eroscriptsValidate: vi.fn(async () => ({ valid: true })),
    // The session check (2026-11-18): the kept answer says the login is good;
    // asked again after a 401 / 403 (forced), the forum says it is dead. A
    // 403 alone no longer drops the login; this answer does.
    eroscriptsCheckSession: vi.fn(async (opts) => ({ state: opts?.force ? 'expired' : 'valid' })),
    eroscriptsLogout: vi.fn(async () => {}),
    eroscriptsSearch: vi.fn(async () => ({ results: [] })),
    eroscriptsTopic: vi.fn(async () => ({ attachments: [] })),
    eroscriptsTopicImage: vi.fn(async () => null),
  };
});
afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('FT-082: an expired session on Get Script says so once', () => {
  it('one warn toast, logged out, the button usable again; no English error toast', async () => {
    const panel = makePanel();
    await Promise.resolve();
    showToast.mockClear();
    window.funsync.eroscriptsTopic.mockResolvedValueOnce(TOPIC_403);
    const btn = document.createElement('button');

    await panel._downloadFromTopic({ id: 9001, title: 'Alpha' }, btn);

    expect(toastCalls()).toEqual([{ text: FR.eroscripts.sessionExpired, type: 'warn' }]);
    expect(panel.isLoggedIn ?? panel._loggedIn).toBe(false);
    expect(settings.get('eroscripts.session')).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(FR.eroscripts.getScript);
  });

  it('a topic that fails for another reason shows one error toast, in French', async () => {
    const panel = makePanel();
    showToast.mockClear();
    window.funsync.eroscriptsTopic.mockResolvedValueOnce(TOPIC_500);

    await panel._downloadFromTopic({ id: 9001, title: 'Alpha' }, document.createElement('button'));

    expect(toastCalls()).toEqual([{ text: 'Impossible de charger ce message (HTTP 500).', type: 'error' }]);
    expect(panel._loggedIn).toBe(true); // not a session problem
  });
});

describe('a failed search reads in the user\'s language', () => {
  it.each([
    ['403', SEARCH_403, FR.eroscripts.error.accessDenied],
    ['429', SEARCH_429, FR.eroscripts.error.rateLimited],
    ['502', SEARCH_502, 'La recherche a échoué (HTTP 502). Déconnectez-vous, puis reconnectez-vous.'],
  ])('%s: the results area shows the French text, not main\'s English', async (_s, answer, expected) => {
    const panel = makePanel();
    window.funsync.eroscriptsSearch.mockResolvedValueOnce(answer);
    const shown = await search(panel);
    expect(shown).toBe(expected);
    expect(shown).not.toBe(answer.error);
  });

  it('a 429 does not log out; a 403 does, with one toast', async () => {
    const panel = makePanel();
    showToast.mockClear();
    window.funsync.eroscriptsSearch.mockResolvedValueOnce(SEARCH_429);
    await search(panel);
    expect(panel._loggedIn).toBe(true);
    expect(showToast).not.toHaveBeenCalled();

    window.funsync.eroscriptsSearch.mockResolvedValueOnce(SEARCH_403);
    await search(panel);
    expect(panel._loggedIn).toBe(false);
    expect(toastCalls()).toEqual([{ text: FR.eroscripts.sessionExpired, type: 'warn' }]);
  });

  it('the message follows a language switch', async () => {
    const panel = makePanel();
    window.funsync.eroscriptsSearch.mockResolvedValueOnce(SEARCH_429);
    await search(panel);
    _setBundlesForTests('de', DE, EN);
    panel._retranslate();
    expect(panel._panel.querySelector('#es-results').textContent.trim()).toBe(DE.eroscripts.error.rateLimited);
  });
});

describe('eroscriptsErrorText', () => {
  it('every code main sends has a string in every locale', () => {
    const codes = ['rateLimited', 'accessDenied', 'searchFailed', 'topicFailed', 'noPosts', 'network'];
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const b = bundle(l);
      for (const c of codes) expect(typeof b.eroscripts.error?.[c], `${l} ${c}`).toBe('string');
    }
    _setBundlesForTests('en', EN, EN);
    for (const c of codes) expect(eroscriptsErrorText({ errorCode: c, status: 404 })).not.toMatch(/^eroscripts\./);
  });

  it('an answer with no known code keeps its own text', () => {
    expect(eroscriptsErrorText({ error: 'Download failed (404)' }, t)).toBe('Download failed (404)');
    expect(eroscriptsErrorText(null, t)).toBe('');
  });
});
