/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL search modal and the REAL Modal build their
 * dialogs in the document, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// "Find the post on EroScripts…" (video options design (c), stage 2b,
// 2026-11-18): the Associate flow's inline search in a link-only mode.
// Dave, 2026-11-17, answer 2: a search the user starts, once per press, that
// only links the post. So in this mode the search never runs on its own,
// never opens a post (no topic request), never downloads, and picking a
// result only hands it back. The download mode is pinned as it was: it
// still searches straight away and ignores the new options.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');
// Read through t(): the words are the same before and after the strings
// merge adds the new keys to the locales.
const { t } = await import('../../renderer/js/i18n.js');

const RESULTS = [
  { id: 321, title: 'Scene <img src=x onerror=alert(1)>', url: 'https://discuss.eroscripts.com/t/scene/321', creator: 'Ramie', likeCount: 3, tags: ['multi-axis'], thumbnail: null, avatar: null },
  { id: 654, title: 'Other scene', url: 'https://discuss.eroscripts.com/t/other/654', creator: null, likeCount: 0, tags: [] },
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const overlay = () => document.querySelector('.modal-overlay');

let saved;
beforeEach(() => {
  saved = window.funsync;
  document.body.innerHTML = '<div id="toast-container"></div>';
  window.funsync = {
    ...saved,
    // Logged in: logged out, every EroScripts search sends nothing (Dave,
    // 2026-11-18; eroscripts-session-check.test.js covers that).
    eroscriptsStatus: vi.fn(async () => ({ loggedIn: true })),
    eroscriptsSearch: vi.fn(async () => ({ results: RESULTS })),
    eroscriptsTopic: vi.fn(async () => ({ attachments: [] })),
    eroscriptsTopicImage: vi.fn(async () => null),
    eroscriptsDownload: vi.fn(async () => ({ success: true })),
  };
});

afterEach(() => {
  overlay()?.querySelector('.modal-close-btn')?.click();
  window.funsync = saved;
  document.body.innerHTML = '';
});

const VIDEO = { path: 'C:/lib/Some Scene.mp4', name: 'Some Scene.mp4' };

describe('link-only mode', () => {
  it('never searches on its own: one search per press of Search or Enter', async () => {
    showEroScriptsSearchModal(VIDEO, { mode: 'link' });
    await flush();
    const dlg = overlay();
    expect(dlg.querySelector('.eroscripts-panel__search-input').value).toBe('Some Scene');
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(dlg.querySelector('.eroscripts-inline__results').textContent).toBe(t('videoOptions.tags.find.prompt'));

    dlg.querySelector('.eroscripts-panel__btn').click();
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('Some Scene');

    const input = dlg.querySelector('.eroscripts-panel__search-input');
    input.value = 'another';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(2);
    expect(window.funsync.eroscriptsSearch).toHaveBeenLastCalledWith('another');
  });

  it('a result offers "Link this post" only; picking hands the post back, opens and downloads nothing', async () => {
    const done = showEroScriptsSearchModal(VIDEO, { mode: 'link' });
    await flush();
    const dlg = overlay();
    dlg.querySelector('.eroscripts-panel__btn').click();
    await flush();

    const rows = [...dlg.querySelectorAll('.eroscripts-inline__result--link')];
    expect(rows).toHaveLength(2);
    // Untrusted title: text only.
    expect(dlg.querySelector('img:not(.eroscripts-inline__result-thumb)')).toBeNull();
    expect(rows[0].querySelector('.eroscripts-panel__result-title').textContent).toBe(RESULTS[0].title);
    // No download buttons, no "open the post" header button.
    expect(dlg.querySelector('.eroscripts-inline__groups')).toBeNull();
    expect(dlg.querySelector('button.eroscripts-inline__result-head')).toBeNull();
    rows[0].querySelector('.eroscripts-inline__result-head').click();
    await flush();
    expect(window.funsync.eroscriptsTopic).not.toHaveBeenCalled();

    rows[1].querySelector('.eroscripts-inline__link-btn').click();
    await expect(done).resolves.toEqual({
      mode: 'link',
      topic: { id: 654, title: 'Other scene', url: 'https://discuss.eroscripts.com/t/other/654', creator: null },
    });
    expect(overlay()).toBeNull();
    expect(window.funsync.eroscriptsTopic).not.toHaveBeenCalled();
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();
  });

  it('a dead session is dropped the way the panel\'s search drops it', async () => {
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true }));
    // The caller's onAuthExpired asks the session check, which finds the
    // login dead and drops it (2026-11-18): logged out from then on.
    const onAuthExpired = vi.fn(async () => {
      window.funsync.eroscriptsStatus = vi.fn(async () => ({ loggedIn: false }));
    });
    showEroScriptsSearchModal(VIDEO, { mode: 'link', onAuthExpired });
    await flush();
    overlay().querySelector('.eroscripts-panel__btn').click();
    await flush();
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    // Logged out now: "Log in to EroScripts to search." with [Log In].
    expect(overlay().querySelector('.eroscripts-panel__login-needed').textContent).toContain(t('eroscripts.loginToSearch'));
  });

  it('Cancel hands back null', async () => {
    const done = showEroScriptsSearchModal(VIDEO, { mode: 'link' });
    await flush();
    overlay().querySelector('.modal-close-btn').click();
    await expect(done).resolves.toBeNull();
  });
});

describe('download mode (the Associate flow) is unchanged', () => {
  it('still searches straight away, opens a post on its header, and ignores onAuthExpired', async () => {
    const onAuthExpired = vi.fn();
    showEroScriptsSearchModal(VIDEO, { onAuthExpired });
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    const head = overlay().querySelector('button.eroscripts-inline__result-head');
    expect(head).not.toBeNull();
    expect(overlay().querySelector('.eroscripts-inline__link-btn')).toBeNull();
    head.click();
    await flush();
    expect(window.funsync.eroscriptsTopic).toHaveBeenCalledWith(321);

    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true }));
    overlay().querySelector('.eroscripts-panel__search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(onAuthExpired).not.toHaveBeenCalled();
  });
});
