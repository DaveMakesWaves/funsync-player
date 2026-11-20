/**
 * @vitest-environment jsdom
 * jsdom on purpose: the picker is a REAL Modal built in a document and
 * driven by clicks and keys; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Find in Stash… on its own (renderer/components/stash-scene-picker.js;
// DESIGN-stash-s1.md (b) "Find in Stash…"; stage s1-2c-dialog,
// 2026-11-18): a search the user starts, ONE request per press, never as
// you type, never on open, never two at once; the scene picked comes back
// to the caller (who links it), and nothing else happens. Stash text is
// text. The search is a fake: no Stash is contacted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import {
  openStashScenePicker, normalizeStashResults, stashSearchSeed, isSendableQuery, stashSceneName, MAX_QUERY,
} from '../../renderer/components/stash-scene-picker.js';
import { bundleWith } from '../helpers/stash-dialog-fixtures.js';

const EN = bundleWith(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')));
const flush = () => new Promise((r) => setTimeout(r, 0));
const overlay = () => document.querySelector('.modal-overlay');
const input = () => overlay().querySelector('.stash-picker__input');
const go = () => overlay().querySelector('.stash-picker__go');
const status = () => overlay().querySelector('.stash-picker__status').textContent;
const results = () => [...overlay().querySelectorAll('.stash-picker__result')];
const type = (text) => {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
};
const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

const SCENES = {
  ok: true,
  count: 2,
  scenes: [
    { id: '2', title: 'Synthetic Scene Two', code: null, date: '2026-11-01', studio: { id: 's1', name: 'Synthetic Studio' }, files: [{ name: 'two.mp4', size: 10, duration: 61 }] },
    { id: '3', title: null, code: 'SYN-003', date: null, studio: null, files: [{ path: '/data/videos/three.mp4', size: 10, duration: 3725 }] },
  ],
};

let search;

function openPicker(opts = {}) {
  return openStashScenePicker({
    video: { name: 'Square_Clip.1080p.mp4', path: 'C:\\Lib\\Square_Clip.1080p.mp4' },
    search,
    errorText: (code) => `words for ${code}`,
    ...opts,
  });
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  search = vi.fn(async () => SCENES);
});

afterEach(async () => {
  while (document.querySelector('.modal-overlay')) {
    document.querySelector('.modal-overlay .modal-close-btn').click();
    await flush();
  }
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('a search the user starts, once per press', () => {
  it('opening sends nothing; the box starts with the file name; typing sends nothing', async () => {
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    expect(input().value).toBe('Square_Clip.1080p');
    expect(status()).toBe('Type and press Search. Nothing is sent before you do.');
    type('Synth');
    type('Synthetic');
    await flush();
    expect(search).not.toHaveBeenCalled();
  });

  it('Search sends exactly one request with the trimmed text; Enter is a press too', async () => {
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    type('  Synthetic  ');
    go().click();
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('Synthetic');
    enter();
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });

  it('a press while the last search runs sends nothing; the answer that lands is shown', async () => {
    let finish;
    search = vi.fn(() => new Promise((r) => { finish = r; }));
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    go().click();
    await flush();
    expect(status()).toBe('Searching…');
    expect(go().getAttribute('aria-disabled')).toBe('true');
    go().click();
    enter();
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    finish(SCENES);
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(go().hasAttribute('aria-disabled')).toBe(false);
  });

  it('empty or whitespace text sends nothing', async () => {
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    type('   ');
    go().click();
    enter();
    await flush();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('results, a pick, and nothing else', () => {
  it('each result shows its title (or "Scene <id>"), date, studio, file name and length; the count is said', async () => {
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    go().click();
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(status()).toBe('2 scenes found.');
    expect(results().map((r) => r.querySelector('.stash-picker__title').textContent)).toEqual(['“Synthetic Scene Two”', 'Scene 3']);
    expect(results().map((r) => r.querySelector('.stash-picker__meta').textContent)).toEqual([
      '2026-11-01 · Synthetic Studio · two.mp4 · 1:01',
      'SYN-003 · three.mp4 · 1:02:05',
    ]);
    expect(results()[0].querySelector('.stash-picker__link').getAttribute('aria-label')).toBe('Link this video to “Synthetic Scene Two”');
  });

  it('Link resolves the scene picked (its id as given) and closes; nothing else is sent', async () => {
    search = vi.fn(async () => ({ ok: true, count: 1, scenes: [{ id: '12@http://192.168.1.20:9999', title: 'Old one', files: [] }] }));
    const done = openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    go().click();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    results()[0].querySelector('.stash-picker__link').click();
    await expect(done).resolves.toEqual({ id: '12@http://192.168.1.20:9999', title: 'Old one', date: null, studio: null });
    expect(overlay()).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('closing resolves null', async () => {
    const done = openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    overlay().querySelector('.modal-close-btn').click();
    await expect(done).resolves.toBeNull();
  });

  it('more scenes than shown: says so', async () => {
    search = vi.fn(async () => ({ ...SCENES, count: 57 }));
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    go().click();
    await vi.waitFor(() => expect(status()).toBe('Showing the first 2 of 57. Add words to narrow the search.'));
  });

  it('no scene: says so with the text searched', async () => {
    search = vi.fn(async () => ({ ok: true, count: 0, scenes: [] }));
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    type('nothing like it');
    go().click();
    await vi.waitFor(() => expect(status()).toBe('No scenes found for “nothing like it”.'));
    expect(results()).toHaveLength(0);
  });

  it('a failure shows the caller\'s words for its code; a throw too', async () => {
    search = vi.fn(async () => ({ ok: false, code: 'unreachable' }));
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    go().click();
    await vi.waitFor(() => expect(status()).toBe('words for unreachable'));
    search.mockImplementationOnce(async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); });
    go().click();
    await vi.waitFor(() => expect(status()).toBe('words for timeout'));
  });
});

describe('text from Stash is text', () => {
  it('a title, studio and file name with markup render as text', async () => {
    const evil = '<img src=x onerror="window.__pickerPwned=1">';
    search = vi.fn(async () => ({ ok: true, count: 1, scenes: [{ id: '5', title: `${evil} T`, studio: { name: `${evil} S` }, files: [{ name: `${evil}.mp4` }] }] }));
    openPicker();
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    go().click();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(overlay().querySelector('img')).toBeNull();
    expect(results()[0].querySelector('.stash-picker__title').textContent).toBe(`“${evil} T”`);
    expect(results()[0].querySelector('.stash-picker__meta').textContent).toBe(`${evil} S · ${evil}.mp4`);
    expect(window.__pickerPwned).toBeUndefined();
  });
});

describe('helpers', () => {
  it('normalizeStashResults reads main\'s answer, the client\'s and a failure; drops what is not a scene', () => {
    expect(normalizeStashResults({ ok: false, error: { code: 'busy' } })).toEqual({ ok: false, code: 'busy' });
    expect(normalizeStashResults({ ok: false, code: 'badKey' })).toEqual({ ok: false, code: 'badKey' });
    expect(normalizeStashResults(null)).toEqual({ ok: false, code: 'notStash' });
    const r = normalizeStashResults({ count: 3, scenes: [{ id: '1', title: 'A' }, { id: '1', title: 'dup' }, { title: 'no id' }, 7] });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3);
    expect(r.scenes.map((s) => s.id)).toEqual(['1']);
  });

  it('the seed, the sendable text, the scene name', () => {
    expect(stashSearchSeed({ name: 'My Scene.mkv' })).toBe('My Scene');
    expect(stashSearchSeed({ path: 'C:\\a\\b\\Clip 3.mp4' })).toBe('Clip 3');
    expect(isSendableQuery('a')).toBe(true);
    expect(isSendableQuery('  ')).toBe(false);
    expect(isSendableQuery('x'.repeat(MAX_QUERY + 1))).toBe(false);
    expect(isSendableQuery('a\u0000b')).toBe(false);
    expect(stashSceneName({ id: '9@http://192.168.1.20:9999', title: null })).toBe('Scene 9');
  });
});
