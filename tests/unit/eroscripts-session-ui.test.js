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

// Live, 2026-11-25 (testing the EroScripts tab's tags): the auth button had a
// permanent login listener BESIDE the onclick _setLoggedIn / _setLoggedOut
// swap. Log Out logged out AND opened the login window; Log In after that
// opened two. The leftover window held FunSync's quit for 30 s. Also in v0.10.0.
describe('the Log In / Log Out button does one thing', () => {
  const authBtn = (panel) => panel._panel.querySelector('#es-auth-btn');

  it('Log Out logs out and opens no login window', async () => {
    const { panel } = await makeApp({ loggedIn: true });
    await vi.waitFor(() => expect(authBtn(panel).textContent).toBe(EN.eroscripts.logOut));
    authBtn(panel).click();
    await settle(6);
    expect(window.funsync.eroscriptsLogout).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsLoginWindow).not.toHaveBeenCalled();
    expect(panel._loggedIn).toBe(false);
    expect(authBtn(panel).textContent).toBe(EN.eroscripts.logIn);
  });

  it('Log In after a Log Out opens ONE login window', async () => {
    const { panel } = await makeApp({ loggedIn: true });
    await vi.waitFor(() => expect(authBtn(panel).textContent).toBe(EN.eroscripts.logOut));
    authBtn(panel).click();
    await settle(6);
    authBtn(panel).click();
    await settle(6);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
    expect(panel._loggedIn).toBe(true);
    expect(window.funsync.eroscriptsLogout).toHaveBeenCalledTimes(1);   // the login click did not log out again
  });

  it('a second ask while the window is open waits for it (Get tags, the results area), no second window', async () => {
    const { panel } = await makeApp({ loggedIn: false });
    let finish;
    window.funsync.eroscriptsLoginWindow = vi.fn(() => new Promise((r) => { finish = r; }));
    authBtn(panel).click();
    const viaGetTags = panel.login();
    await settle(2);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
    finish({ success: true, cookie: 'NEWCOOKIE', username: 'tester' });
    expect(await viaGetTags).toBe(true);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
  });
});

describe('login() from another surface (the Tags section) always opens the window', () => {
  it('even when the panel still thinks it is logged in (main says it is not): the window picks the session up again', async () => {
    const { panel } = await makeApp({ loggedIn: true });
    await vi.waitFor(() => expect(panel._loggedIn).toBe(true));
    expect(await panel.login()).toBe(true);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
    // The panel's own button, logged in, is Log Out and opens nothing.
    panel._panel.querySelector('#es-auth-btn').click();
    await settle(6);
    expect(window.funsync.eroscriptsLoginWindow).toHaveBeenCalledTimes(1);
  });
});

// Dave, 2026-11-25, the tab's top row: the account as a picture with a menu
// (the panel keeps the name, the picture and the waiting, and says when they
// change); the search box the Library's (docked only); the band behind it.
describe('the panel behind the tab\'s top row (2026-11-25)', () => {
  const PIC = 'https://discuss.eroscripts.com/user_avatar/discuss.eroscripts.com/tester/64/5_2.png';

  it('the login window\'s picture is kept (and saved with the session); the login check refreshes it; Log Out forgets it', async () => {
    window.funsync.eroscriptsLoginWindow = vi.fn(async () => ({ success: true, cookie: 'NEWCOOKIE', username: 'tester', avatar: PIC }));
    const { panel } = await makeApp({ loggedIn: false });
    const changed = vi.fn();
    panel.onProfileChanged = changed;
    const opening = panel.openLogin();
    expect(panel.loginPending).toBe(true);
    await opening;
    await settle();
    expect(panel.loginPending).toBe(false);
    expect(panel.username).toBe('tester');
    expect(panel.avatarUrl).toBe(PIC);
    expect(settings.get('eroscripts.session')).toEqual({ cookie: 'NEWCOOKIE', username: 'tester', avatar: PIC });
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);       // waiting, then signed in
    // A new picture from the forum.
    const NEW = PIC.replace('5_2', '6_2');
    window.funsync.eroscriptsCheckSession = vi.fn(async () => ({ state: 'valid', username: 'tester', avatar: NEW }));
    changed.mockClear();
    await panel.checkSession({ force: true });
    expect(panel.avatarUrl).toBe(NEW);
    expect(settings.get('eroscripts.session').avatar).toBe(NEW);
    expect(changed).toHaveBeenCalledTimes(1);
    await panel.checkSession({ force: true });                          // the same picture: no repaint
    expect(changed).toHaveBeenCalledTimes(1);
    await panel.logout();
    expect(panel.avatarUrl).toBe('');
    expect(panel.username).toBe('');
    expect(window.funsync.eroscriptsLogout).toHaveBeenCalled();
  });

  it('a saved session restores its picture at start-up', async () => {
    settings = null;
    const panelSettings = new Map([['eroscripts.session', { ...SESSION, avatar: PIC }]]);
    const panel = new EroScriptsPanel({ settings: { get: (k) => panelSettings.get(k), set: (k, v) => panelSettings.set(k, v) } });
    await settle();
    expect(panel.isLoggedIn).toBe(true);
    expect(panel.avatarUrl).toBe(PIC);
  });

  it('docked, the search box is the Library\'s (magnifier, clear button, its classes); undocked, the panel\'s own again', async () => {
    const { panel } = await makeApp();
    const cleared = vi.fn();
    panel.onQueryCleared = cleared;
    const host = document.createElement('div');
    document.body.appendChild(host);
    panel.dock(host);
    const input = panel._panel.querySelector('#es-search-input');
    const box = input.parentElement;
    expect(box.classList.contains('library__search')).toBe(true);
    expect(input.classList.contains('library__search-input')).toBe(true);
    expect(input.classList.contains('eroscripts-panel__search-input')).toBe(false);
    expect(box.querySelector('.library__search-icon svg')).toBeTruthy();
    const clear = box.querySelector('.library__search-clear');
    expect(clear.hidden).toBe(true);
    expect(clear.getAttribute('aria-label')).toBe(EN.library.clearSearchAria);
    input.value = 'pmv';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(input.value).toBe('');
    expect(clear.hidden).toBe(true);
    expect(cleared).toHaveBeenCalledTimes(1);                           // the newest list comes back
    expect(document.activeElement).toBe(input);
    panel.undock();
    expect(input.parentElement.classList.contains('eroscripts-panel__input-row')).toBe(true);
    expect(input.classList.contains('eroscripts-panel__search-input')).toBe(true);
    expect(input.classList.contains('library__search-input')).toBe(false);
    panel.dock(host);                                                   // and again: one box, not two
    expect(panel._panel.querySelectorAll('.library__search').length).toBe(1);
  });

  it('the styles: the floating panel\'s shadow never reaches the docked one (the band); docked, no login line or Search button of its own', () => {
    const modern = fs.readFileSync('renderer/styles/modern.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]*)\{[^{}]*box-shadow:\s*var\(--elev-3\), var\(--edge-highlight\)[^{}]*\}/g;
    const panelRules = [...modern.matchAll(rule)].map((m) => m[1].trim()).filter((sel) => /\.eroscripts-panel(?![_-])/.test(sel));
    expect(panelRules.length).toBeGreaterThan(0);
    for (const sel of panelRules) expect(sel).toContain(':not(.eroscripts-panel--docked)');
    const es = fs.readFileSync('renderer/styles/eroscripts.css', 'utf8');
    expect(es).toMatch(/\.eroscripts-panel--docked \.eroscripts-panel__auth-bar \{ display: none; \}/);
    expect(es).toMatch(/\.eroscripts-panel--docked #es-search-btn \{ display: none; \}/);
  });
});
