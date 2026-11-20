/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Tags section of the video options dialog builds
 * DOM, and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// Stash's tag aliases in the video options dialog (Stash "next" lot, stage
// sn-tags, 2026-11-19; the opt-in "Use Stash's tag aliases and sub-tags").
// The dialog's chips merge one video with the library index's OWN rules
// (buildLibraryTagIndex's `rules`), so with the opt-in on a script file's
// "synthetic-a" is the chip "Synthetic Tag A" there too, with the index's key
// (the one a hide, the filter and the cards use); with it off, the chip is
// exactly today's. Implied parents never become chips.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { buildLibraryTagIndex } = await import('../../renderer/js/library-tag-filter.js');
const { stashTagRuleSet } = await import('../../renderer/js/stash-tags.js');
const { mountTagsSection, _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
beforeAll(() => _setBundlesForTests('en', EN, EN));

const A = 'C:/lib/Alpha.mp4';
const A_S = 'C:/lib/Alpha.funscript';
const videos = [{ path: A, funscriptPath: A_S }];
const scriptMeta = { [A_S]: { tags: ['synthetic-a', 'Synthetic Tag B'], topicTags: [], performers: [], creator: null } };
const TAG_RULES = {
  aliases: { 'synthetic-a': 'synthetic-tag-a', 'syn-a-two': 'synthetic-tag-a' },
  children: { 'synthetic-parent-tag': ['synthetic-tag-b'] },
  names: { 'synthetic-tag-a': 'Synthetic Tag A', 'synthetic-tag-b': 'Synthetic Tag B', 'synthetic-parent-tag': 'Synthetic Parent Tag' },
};
const stashRules = stashTagRuleSet({ tagRules: TAG_RULES, tags: {} }, { enabled: true, useTagRules: true });

const handles = [];
afterEach(() => {
  for (const h of handles.splice(0)) h?.dispose?.();
  _resetTagsSectionForTests?.();
  document.body.innerHTML = '';
});

function mount(result) {
  const store = { 'library.userTags': {}, 'library.hiddenTags': {}, 'library.scriptTags': {}, 'library.tagSettings': {} };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = mountTagsSection(host, {
    video: { path: A, name: 'Alpha.mp4', funscriptPath: A_S },
    dataService: { get: (k) => store[k], set: vi.fn(), getCategories: () => [], getAllVideoCategories: () => ({}), getVideoCategories: () => [] },
    getLibraryVideos: () => videos,
    getScriptMeta: async (p) => scriptMeta[p] ?? null,
    scriptMeta,
    onDataChanged: vi.fn(),
    announce: vi.fn(),
    modalBody: document.body,
    eroscripts: { isLoggedIn: vi.fn(async () => true), login: vi.fn(), sessionExpired: vi.fn() },
    getTagIndex: () => result,
  });
  handles.push(handle);
  return host;
}

const chips = (host) => [...host.querySelectorAll('.video-options-tags__chip')]
  .map((li) => [li.dataset.tagKey, li.querySelector('.video-options-tags__chip-label')?.textContent]);

describe('the dialog\'s chips read the library index\'s rules', () => {
  it('opt-in on: the file\'s alias is Stash\'s tag, with the index\'s key and Stash\'s spelling; no implied parent chip', async () => {
    const result = buildLibraryTagIndex({ videos, scriptMeta, stashRules });
    expect([...result.counts.keys()]).toContain('content:synthetic-parent-tag');
    const host = mount(result);
    await vi.waitFor(() => expect(chips(host)).toEqual([
      ['content:synthetic-tag-a', 'Synthetic Tag A'],
      ['content:synthetic-tag-b', 'Synthetic Tag B'],
    ]));
  });

  it('opt-in off: today\'s chips', async () => {
    const result = buildLibraryTagIndex({ videos, scriptMeta });
    const host = mount(result);
    await vi.waitFor(() => expect(chips(host)).toEqual([
      ['content:synthetic-a', 'synthetic a'],
      ['content:synthetic-tag-b', 'Synthetic Tag B'],
    ]));
  });
});
