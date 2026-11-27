/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScriptsPanel builds its DOM and imports
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// Dave, 2026-11-25: "searching by tag doesnt seem to work". Live in the
// sandbox: a search asked for while another was still loading (Enter again, a
// tag added in the EroScripts tab, Search) was DROPPED (`if (this._searching)
// return`), so the old results stayed, filtered by the new tag in the app: 9 of
// 50 where the forum has far more. Now it runs when the first ends, with what
// is asked for then, and the old answer is not shown.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const topic = (id, title) => ({ id, title, url: `https://discuss.eroscripts.com/t/${id}`, tags: [] });

let pending;
function makePanel() {
  const settings = new Map([['eroscripts.session', { cookie: 'TESTKEY01', username: 'tester' }]]);
  const panel = new EroScriptsPanel({ settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) } });
  panel._setLoggedIn('tester');
  return panel;
}
const box = (panel) => panel._panel.querySelector('#es-search-input');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  pending = [];
  window.funsync = {
    eroscriptsRestoreSession: vi.fn(async () => {}),
    eroscriptsValidate: vi.fn(async () => ({ valid: true })),
    eroscriptsCheckSession: vi.fn(async () => ({ state: 'valid' })),
    eroscriptsLogout: vi.fn(async () => {}),
    // Each search waits until the test answers it.
    eroscriptsSearch: vi.fn((q) => new Promise((resolve) => pending.push({ q, resolve }))),
    eroscriptsTopic: vi.fn(async () => ({ attachments: [] })),
    eroscriptsTopicImage: vi.fn(async () => null),
  };
});
afterEach(() => { delete window.funsync; document.body.innerHTML = ''; });

describe('a search asked for while one is loading', () => {
  it('runs when that one ends, with the words and tags of then; the old answer is never shown', async () => {
    const panel = makePanel();
    // The tab's decoration: the first tag goes into the query (decorateQuery).
    let tag = '';
    panel.queryDecorator = (q) => (tag ? `${q} tags:${tag}` : q);
    const shown = [];
    panel._docked = true;
    panel.onResults = (results) => { if (results) shown.push(results.map((r) => r.title)); };

    box(panel).value = 'squirt';
    const first = panel._search();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].q).toBe('squirt');
    // A tag added in the tab while it loads: the tab re-runs the search.
    tag = 'vr';
    panel.search();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);   // not sent alongside
    pending[0].resolve({ results: [topic(1, 'old, untagged')] });
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].q).toBe('squirt tags:vr');                        // the words and tag of now
    pending[1].resolve({ results: [topic(2, 'tagged vr')] });
    await vi.waitFor(() => expect(shown).toEqual([['tagged vr']]));     // the old answer never shown
  });

  it('several asks while it loads: one more search, the last words', async () => {
    const panel = makePanel();
    box(panel).value = 'a';
    const first = panel._search();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    box(panel).value = 'b';
    panel._search();
    box(panel).value = 'c';
    panel._search();
    pending[0].resolve({ results: [] });
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.map((p) => p.q)).toEqual(['a', 'c']);
    pending[1].resolve({ results: [] });
    await flush();
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(2);
  });

  it('asked while the login is being checked: only the newer one is sent', async () => {
    const panel = makePanel();
    let release;
    window.funsync.eroscriptsCheckSession = vi.fn(() => new Promise((r) => { release = () => r({ state: 'valid' }); }));
    box(panel).value = 'first';
    const first = panel._search();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    box(panel).value = 'second';
    panel._search();
    window.funsync.eroscriptsCheckSession = vi.fn(async () => ({ state: 'valid' }));
    release();
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].q).toBe('second');                                // no request for the first
    pending[0].resolve({ results: [] });
  });

  it('"Search with fewer words" while one loads is no longer ignored', async () => {
    const panel = makePanel();
    box(panel).value = 'many words here';
    const first = panel._search();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    panel._searchFewerWords('many words');
    pending[0].resolve({ results: [] });
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].q).toBe('many words');
    pending[1].resolve({ results: [] });
  });
});
