/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL search modal, the REAL Modal and the REAL
 * EroScripts panel build their DOM, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Dave (2026-11-18): "searches might want to take into account that
// underscores may exist instead of spaces and there may be extra words in the
// search term than there is in the forum post title". In the app:
// - the inline search (the Associate modal's "Find on EroScripts" and the
//   Tags section's "Find the post") starts from the CLEANED file name;
// - a search that finds nothing (there and in the EroScripts panel) offers ONE
//   "Search with fewer words" button, which searches the first few meaningful
//   words ONCE per press. Nothing searches again on its own.
// Asserted: the query in the box, the searches sent (fake IPC) and the button.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const { t } = await import('../../renderer/js/i18n.js');

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const overlay = () => document.querySelector('.modal-overlay');
const VIDEO = { path: 'C:/lib/Girl_Next_Door.Part.Two.With.Jane.Doe.1080p.bunkr.mp4', name: 'Girl_Next_Door.Part.Two.With.Jane.Doe.1080p.bunkr.mp4' };
const FOUND = [{ id: 1, title: 'Girl Next Door', url: 'https://discuss.eroscripts.com/t/x/1', creator: null, likeCount: 0, tags: [] }];

let saved;
beforeEach(() => {
  saved = window.funsync;
  document.body.innerHTML = '<div id="toast-container"></div><div id="app"></div>';
  window.funsync = {
    ...saved,
    eroscriptsStatus: vi.fn(async () => ({ loggedIn: true })),
    eroscriptsSearch: vi.fn(async () => ({ results: [] })),
    eroscriptsTopic: vi.fn(async () => ({ attachments: [] })),
    eroscriptsTopicImage: vi.fn(async () => null),
    eroscriptsDownload: vi.fn(async () => ({ success: true })),
    eroscriptsRestoreSession: vi.fn(async () => {}),
    eroscriptsValidate: vi.fn(async () => ({ valid: true })),
    eroscriptsCheckSession: vi.fn(async () => ({ state: 'valid' })),
  };
});

afterEach(() => {
  overlay()?.querySelector('.modal-close-btn')?.click();
  window.funsync = saved;
  document.body.innerHTML = '';
});

const fewerButtons = (root) => [...root.querySelectorAll('.eroscripts-panel__fewer-words')];

describe('the inline search (both modes)', () => {
  it('starts from the cleaned name: underscores and dots as spaces, 1080p and bunkr gone', async () => {
    showEroScriptsSearchModal(VIDEO, { mode: 'link' });
    await flush();
    expect(overlay().querySelector('.eroscripts-panel__search-input').value).toBe('Girl Next Door Part Two With Jane Doe');
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();      // link mode never searches on its own
  });

  it('download mode searches the cleaned name once as it opens, as before', async () => {
    showEroScriptsSearchModal(VIDEO);
    await flush();
    expect(window.funsync.eroscriptsSearch.mock.calls).toEqual([['Girl Next Door Part Two With Jane Doe']]);
  });

  it('nothing found: ONE "Search with fewer words"; each press is one search, never automatic', async () => {
    showEroScriptsSearchModal(VIDEO);
    await flush();
    const dlg = overlay();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    let buttons = fewerButtons(dlg);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(t('eroscripts.fewerWords'));
    expect(buttons[0].title).toBe(t('eroscripts.fewerWordsTitle', { query: 'Girl Next Door Part Two' }));
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);   // waits for a press

    buttons[0].click();
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(2);
    expect(window.funsync.eroscriptsSearch).toHaveBeenLastCalledWith('Girl Next Door Part Two');
    expect(dlg.querySelector('.eroscripts-panel__search-input').value).toBe('Girl Next Door Part Two');

    buttons = fewerButtons(dlg);
    expect(buttons).toHaveLength(1);
    window.funsync.eroscriptsSearch.mockResolvedValueOnce({ results: FOUND });
    buttons[0].click();
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenLastCalledWith('Girl Next Door');
    expect(fewerButtons(dlg)).toHaveLength(0);                           // found: no button
    expect(dlg.querySelectorAll('.eroscripts-inline__result')).toHaveLength(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(3);
  });

  it('a two-word search that finds nothing has no shorter form: no button', async () => {
    showEroScriptsSearchModal({ path: 'C:/lib/Two Words.mp4', name: 'Two Words.mp4' });
    await flush();
    expect(overlay().querySelector('.eroscripts-inline__results').textContent).toContain('Two Words');
    expect(fewerButtons(overlay())).toHaveLength(0);
  });
});

describe('the EroScripts panel', () => {
  function makePanel() {
    const store = new Map([['eroscripts.session', { cookie: 'TESTKEY01', username: 'tester' }]]);
    const panel = new EroScriptsPanel({ settings: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } });
    panel._setLoggedIn('tester');
    return panel;
  }

  it('nothing found: ONE button; a press searches the first few words once', async () => {
    const panel = makePanel();
    panel._panel.querySelector('#es-search-input').value = 'Girl Next Door Part Two With Jane Doe';
    await panel._search();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    const results = panel._panel.querySelector('#es-results');
    expect(results.textContent).toContain(t('eroscripts.noResultsHint'));
    const buttons = fewerButtons(results);
    expect(buttons).toHaveLength(1);
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);

    buttons[0].click();
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(2);
    expect(window.funsync.eroscriptsSearch).toHaveBeenLastCalledWith('Girl Next Door Part Two');
    expect(panel._panel.querySelector('#es-search-input').value).toBe('Girl Next Door Part Two');
  });

  it('the query text stays text (a hostile file name)', async () => {
    const panel = makePanel();
    panel._panel.querySelector('#es-search-input').value = '<img src=x onerror=alert(1)> one two three four';
    await panel._search();
    const results = panel._panel.querySelector('#es-results');
    expect(results.querySelector('img')).toBeNull();
    expect(fewerButtons(results)[0].title).toContain('<img');
  });
});
