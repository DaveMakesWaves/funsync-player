/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScripts panel, nav bar and inline search
 * build their DOM in the document, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// The EroScripts login, renderer side (Dave, 2026-11-18):
//   1. every EroScripts search (the panel's, the Associate flow's inline
//      search, and its link-only "Find the post" mode) sends nothing logged
//      out and says "Log in to EroScripts to search." with a login button,
//      never a silent empty list;
//   2. the saved login is checked when the panel or the inline search opens
//      (and before a search; main keeps the answer a few minutes) and after a
//      401 / 403. Only a definite "not logged in" drops the session (the
//      saved session, main's cookie, the panel's "Connected" and the top
//      bar's connected look); "could not check" changes nothing.
// What runs for real: EroScriptsPanel, NavBar (wired as app.js wires it),
// showEroScriptsSearchModal, Modal. Fakes: main's IPC (no forum is ever
// contacted), the login window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { NavBar } = await import('../../renderer/components/nav-bar.js');
const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');

// The English words read here; the strings merge adds them to the locales
// (SCRATCH/2d-session/strings.json).
const STRINGS = {
  'eroscripts.loginToSearch': 'Log in to EroScripts to search.',
};
function bundle() {
  const b = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
  for (const [key, value] of Object.entries(STRINGS)) {
    const parts = key.split('.');
    let o = b;
    for (const p of parts.slice(0, -1)) o = (o[p] ||= {});
    o[parts.at(-1)] = value;
  }
  return b;
}
const EN = bundle();

const SESSION = Object.freeze({ cookie: 'TESTCOOKIE', username: 'tester' });
const TOPICS = [{ id: 7, title: 'Alpha Scene', creator: 'scripter', likeCount: 1, views: 2, tags: [], thumbnail: null }];
const SEARCH_403 = { results: [], error: 'Access denied — try logging in again', errorCode: 'accessDenied', authExpired: true };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}
const overlay = () => [...document.querySelectorAll('.modal-overlay')].at(-1) || null;
const toastTexts = () => showToast.mock.calls.map(([text, type]) => ({ text: String(text), type }));

let settings;
let saved;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  showToast.mockClear();
  saved = window.funsync;
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  window.funsync = {
    eroscriptsRestoreSession: vi.fn(async () => ({ success: true })),
    eroscriptsValidate: vi.fn(async () => ({ valid: true })),
    eroscriptsCheckSession: vi.fn(async () => ({ state: 'valid' })),
    eroscriptsLogout: vi.fn(async () => ({ success: true })),
    eroscriptsLoginWindow: vi.fn(async () => ({ success: true, cookie: 'NEWCOOKIE', username: 'tester' })),
    eroscriptsStatus: vi.fn(async () => ({ loggedIn: false })),
    eroscriptsSearch: vi.fn(async () => ({ results: TOPICS })),
    eroscriptsTopic: vi.fn(async () => ({ attachments: [] })),
    eroscriptsTopicImage: vi.fn(async () => null),
    openExternal: vi.fn(),
  };
});
afterEach(() => {
  for (const o of [...document.querySelectorAll('.modal-overlay')].reverse()) o.querySelector('.modal-close-btn')?.click();
  delete window.app;
  window.funsync = saved;
  document.body.innerHTML = '';
});

/** The panel and the top bar, wired as app.js wires them. */
async function makeApp({ loggedIn = true } = {}) {
  settings = new Map(loggedIn ? [['eroscripts.session', { ...SESSION }]] : []);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = new NavBar({ onNavigate: () => {} });
  bar.init(host);
  const panel = new EroScriptsPanel({ settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) } });
  panel.onLoginStatusChanged = (v) => bar.setEroScriptsStatus(v);
  await settle();
  window.app = { eroscriptsPanel: panel };
  const connected = () => host.querySelector('.nav-bar__eroscripts').classList.contains('nav-bar__eroscripts--connected');
  return { panel, bar, connected };
}

async function panelSearch(panel, q = 'alpha') {
  panel._panel.querySelector('#es-search-input').value = q;
  await panel._search();
  await settle();
}

describe('the EroScripts panel\'s search, logged out', () => {
  it('sends nothing and says "log in to search" with the login button; the login runs the search once', async () => {
    const { panel } = await makeApp({ loggedIn: false });
    await panelSearch(panel);
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(window.funsync.eroscriptsCheckSession).not.toHaveBeenCalled();
    const results = panel._panel.querySelector('#es-results');
    expect(results.textContent).toContain('Log in to EroScripts to search.');
    const login = results.querySelector('.eroscripts-panel__login-needed-btn');
    expect(login.textContent).toBe(EN.eroscripts.logIn);

    login.click();
    await settle(6);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
    expect(settings.get('eroscripts.session')).toEqual({ cookie: 'NEWCOOKIE', username: 'tester' });
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('alpha');
    expect(results.querySelector('.eroscripts-panel__result-title').textContent).toBe('Alpha Scene');
  });

  it('a cancelled login sends nothing and asks again', async () => {
    window.funsync.eroscriptsLoginWindow = vi.fn(async () => ({ success: false, error: 'Login cancelled' }));
    const { panel } = await makeApp({ loggedIn: false });
    await panelSearch(panel);
    panel._panel.querySelector('.eroscripts-panel__login-needed-btn').click();
    await settle(6);
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(panel._panel.querySelector('.eroscripts-panel__login-needed-btn')).not.toBeNull();
  });

  it('right after launch a search waits for the saved login\'s start-up check instead of asking to log in', async () => {
    let answer;
    window.funsync.eroscriptsValidate = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    settings = new Map([['eroscripts.session', { ...SESSION }]]);
    const panel = new EroScriptsPanel({ settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) } });
    panel._panel.querySelector('#es-search-input').value = 'alpha';
    const searching = panel._search();
    await settle();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(panel._panel.querySelector('.eroscripts-panel__login-needed')).toBeNull();
    answer({ valid: true });
    await searching;
    await settle();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
  });

  it('main without a login sends nothing either and the panel asks to log in', async () => {
    const { panel } = await makeApp();
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [], error: 'Not logged in to EroScripts', errorCode: 'loginRequired', loginRequired: true }));
    await panelSearch(panel);
    expect(panel._panel.querySelector('#es-results').textContent).toContain('Log in to EroScripts to search.');
  });
});

describe('the session check from the panel', () => {
  it('a definite "not logged in" as the panel opens: the top bar stops saying connected and the session is forgotten, once', async () => {
    const { panel, connected } = await makeApp();
    expect(connected()).toBe(true);
    expect(panel.isLoggedIn).toBe(true);
    window.funsync.eroscriptsCheckSession = vi.fn(async () => ({ state: 'expired', status: 404 }));

    panel.show();
    await settle();

    expect(window.funsync.eroscriptsCheckSession).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsCheckSession).toHaveBeenCalledWith({ force: false });
    expect(connected()).toBe(false);
    expect(panel.isLoggedIn).toBe(false);
    expect(settings.get('eroscripts.session')).toBeNull();
    expect(window.funsync.eroscriptsLogout).toHaveBeenCalledTimes(1);
    expect(panel._panel.querySelector('#es-auth-label').textContent).toBe(EN.eroscripts.notLoggedIn);
    expect(toastTexts()).toEqual([{ text: EN.eroscripts.sessionExpired, type: 'warn' }]);
    panel.hide();
  });

  it('"could not check" (network, timeout, 5xx, Cloudflare) changes nothing; nor does a failed IPC', async () => {
    const { panel, connected } = await makeApp();
    for (const answer of [async () => ({ state: 'unknown' }), async () => { throw new Error('ipc gone'); }, async () => null]) {
      window.funsync.eroscriptsCheckSession = vi.fn(answer);
      panel.show();
      await settle();
      panel.hide();
      expect(window.funsync.eroscriptsCheckSession).toHaveBeenCalledTimes(1);
    }
    expect(connected()).toBe(true);
    expect(panel.isLoggedIn).toBe(true);
    expect(settings.get('eroscripts.session')).toEqual(SESSION);
    expect(window.funsync.eroscriptsLogout).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a search with a timed-out login sends nothing and asks to log in (not "no scripts found")', async () => {
    const { panel, connected } = await makeApp();
    window.funsync.eroscriptsCheckSession = vi.fn(async () => ({ state: 'expired', status: 404 }));
    await panelSearch(panel);
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(panel._panel.querySelector('#es-results').textContent).toContain('Log in to EroScripts to search.');
    expect(connected()).toBe(false);
  });

  it('a 403 asks the check again (forced): a login it finds good is kept and the refusal is said', async () => {
    const { panel, connected } = await makeApp();
    window.funsync.eroscriptsSearch = vi.fn(async () => SEARCH_403);
    await panelSearch(panel);
    expect(window.funsync.eroscriptsCheckSession.mock.calls).toEqual([[{ force: false }], [{ force: true }]]);
    expect(panel._panel.querySelector('#es-results').textContent.trim()).toBe(EN.eroscripts.error.accessDenied);
    expect(connected()).toBe(true);
    expect(settings.get('eroscripts.session')).toEqual(SESSION);
    expect(window.funsync.eroscriptsLogout).not.toHaveBeenCalled();
  });

  it('a 403 the check confirms drops the session, with one toast however many requests failed', async () => {
    const { panel, connected } = await makeApp();
    window.funsync.eroscriptsCheckSession = vi.fn(async (opts) => ({ state: opts?.force ? 'expired' : 'valid' }));
    await Promise.all([panel.handleSessionExpired(), panel.handleSessionExpired(), panel.handleSessionExpired()]);
    await settle();
    expect(connected()).toBe(false);
    expect(settings.get('eroscripts.session')).toBeNull();
    expect(window.funsync.eroscriptsLogout).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([{ text: EN.eroscripts.sessionExpired, type: 'warn' }]);
    // Logged out now: nothing more is asked.
    await panel.handleSessionExpired();
    expect(window.funsync.eroscriptsCheckSession).toHaveBeenCalledTimes(3);
  });

  it('Get Script refused while the login is good: the session stays and the refusal is said once', async () => {
    const { panel } = await makeApp();
    window.funsync.eroscriptsTopic = vi.fn(async () => ({ attachments: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true }));
    await panel._downloadFromTopic({ id: 7, title: 'Alpha' }, document.createElement('button'));
    expect(panel.isLoggedIn).toBe(true);
    expect(toastTexts()).toEqual([{ text: EN.eroscripts.error.accessDenied, type: 'error' }]);
  });
});

describe('the inline search (Associate flow and Find the post)', () => {
  const VIDEO = { path: 'C:/lib/Alpha Scene.mp4', name: 'Alpha Scene.mp4' };

  it('Associate, logged out: no search, "log in to search" with [Log In]; the login runs it once', async () => {
    await makeApp({ loggedIn: false });
    showEroScriptsSearchModal(VIDEO);
    await settle();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    const dlg = overlay();
    expect(dlg.querySelector('.eroscripts-inline__results').textContent).toContain('Log in to EroScripts to search.');

    // Pressing Search again still sends nothing.
    dlg.querySelector('.eroscripts-panel__search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();

    dlg.querySelector('.eroscripts-panel__login-needed-btn').click();
    await settle(6);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('Alpha Scene');
  });

  it('Find the post (link-only), logged out: asks to log in as it opens; Search sends nothing', async () => {
    await makeApp({ loggedIn: false });
    showEroScriptsSearchModal(VIDEO, { mode: 'link' });
    await settle();
    const dlg = overlay();
    expect(dlg.querySelector('.eroscripts-inline__results').textContent).toContain('Log in to EroScripts to search.');
    dlg.querySelector('.eroscripts-panel__btn').click(); // Search
    await settle();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
  });

  it('with no panel and main logged out, nothing is sent either', async () => {
    window.funsync.eroscriptsStatus = vi.fn(async () => ({ loggedIn: false }));
    showEroScriptsSearchModal(VIDEO);
    await settle();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(overlay().querySelector('.eroscripts-inline__results').textContent).toContain('Log in to EroScripts to search.');
    // No panel to log in with: no button that would do nothing.
    expect(overlay().querySelector('.eroscripts-panel__login-needed-btn')).toBeNull();
  });

  it('the saved login is checked as it opens: a timed-out one is dropped, nothing is searched, the top bar flips', async () => {
    const { connected } = await makeApp();
    window.funsync.eroscriptsCheckSession = vi.fn(async () => ({ state: 'expired', status: 404 }));
    showEroScriptsSearchModal(VIDEO);
    await settle();
    expect(window.funsync.eroscriptsCheckSession).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(connected()).toBe(false);
    expect(overlay().querySelector('.eroscripts-inline__results').textContent).toContain('Log in to EroScripts to search.');
  });

  it('logged in and good: it searches as before', async () => {
    await makeApp();
    showEroScriptsSearchModal(VIDEO);
    await settle();
    expect(window.funsync.eroscriptsCheckSession).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
  });

  it('a 403 asks the check (forced): a good login is kept and the refusal is said; a dead one asks to log in', async () => {
    const { panel } = await makeApp();
    window.funsync.eroscriptsSearch = vi.fn(async () => SEARCH_403);
    showEroScriptsSearchModal(VIDEO);
    await settle();
    expect(window.funsync.eroscriptsCheckSession).toHaveBeenLastCalledWith({ force: true });
    expect(panel.isLoggedIn).toBe(true);
    expect(overlay().querySelector('.eroscripts-panel__placeholder--error').textContent).toBe(EN.eroscripts.error.accessDenied);

    window.funsync.eroscriptsCheckSession = vi.fn(async (opts) => ({ state: opts?.force ? 'expired' : 'valid' }));
    overlay().querySelector('.eroscripts-panel__search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(panel.isLoggedIn).toBe(false);
    expect(overlay().querySelector('.eroscripts-inline__results').textContent).toContain('Log in to EroScripts to search.');
  });
});
