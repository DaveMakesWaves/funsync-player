/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Tags section and the REAL Library card line
 * build DOM, and i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// One display form for a tag everywhere (r3-fixup, r3-verify cosmetics,
// 2026-11-18). The real-app check saw "the handy" on a card and "the-handy"
// in the Filters picker for one tag: each video kept the label of its own
// best source, and the picker showed the first video's. Now the library
// index picks ONE label per key (the best source's, shown de-slugged when a
// file or post spelled it as a slug: tagDisplayLabel) for every video, the
// picker's counts, the cards, the phone's slice, and the dialog's chips.
// What you typed keeps your spelling. Long names on a card ellipsize and the
// "+N" stays.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { buildLibraryTagIndex } = await import('../../renderer/js/library-tag-filter.js');
const { remoteTagSliceFromIndex } = await import('../../renderer/js/remote-tag-slice.js');
const { funscriptMetaRecord, tagDisplayLabel } = await import('../../renderer/js/video-tags.js');
const { mountTagsSection, _resetTagsSectionForTests } = await import('../../renderer/components/video-options-tags.js');
const { Library } = await import('../../renderer/components/library.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
beforeAll(() => _setBundlesForTests('en', EN, EN));

const A = 'C:/lib/Alpha.mp4';
const A_S = 'C:/lib/Alpha.funscript';
const B = 'C:/lib/Bravo.mp4';
const B_S = 'C:/lib/Bravo.funscript';
const C = 'C:/lib/Charlie.mp4';
const videos = [{ path: A, funscriptPath: A_S }, { path: B, funscriptPath: B_S }, { path: C, funscriptPath: null }];
const input = {
  videos,
  // Alpha's file spells the device as a slug; Bravo's post gives the same tag.
  scriptMeta: { [A_S]: funscriptMetaRecord({ tags: ['the-handy', 'POV'] }, 1) },
  scriptTags: { [B]: { tags: ['the-handy', 'pov'], scriptPath: B_S } },
  userTags: { [C]: ['twin-only', 'pov'] },
};
const labelsOf = (index, key) => [...index.values()].flat().filter((t) => t.key === key).map((t) => t.label);

describe('the library index: one label per key', () => {
  const { index, counts } = buildLibraryTagIndex(input);

  it('a slug from a file and the post\u2019s tag show as one form, on every video and in the picker', () => {
    expect(labelsOf(index, 'device:the-handy')).toEqual(['the handy', 'the handy']);
    expect(counts.get('device:the-handy').label).toBe('the handy');
  });

  it('the best source\u2019s spelling wins for every video (you, then the file, then the post)', () => {
    expect(labelsOf(index, 'content:pov')).toEqual(['pov', 'pov', 'pov']);        // Charlie: you typed "pov"
    const noUser = buildLibraryTagIndex({ ...input, userTags: {} });
    expect(labelsOf(noUser.index, 'content:pov')).toEqual(['POV', 'POV']);        // the file's "POV" over the post's
  });

  it('what you typed keeps your spelling', () => {
    expect(counts.get('content:twin-only').label).toBe('twin-only');
  });

  it('the phone gets the same form', () => {
    const slice = remoteTagSliceFromIndex(index);
    expect(slice[A].find((t) => t.key === 'device:the-handy').label).toBe('the handy');
  });

  it('tagDisplayLabel: a length keeps its numbers, a name its spelling', () => {
    expect(tagDisplayLabel({ key: 'length:10-25', facet: 'length', value: '10-25', label: '10-25', sources: ['funscript'] })).toBe('10-25');
    expect(tagDisplayLabel({ key: 'creator:night-owl', facet: 'creator', value: 'night-owl', label: 'night-owl', sources: ['funscript'] })).toBe('night-owl');
    expect(tagDisplayLabel({ key: 'content:x-ray', facet: 'content', value: 'x-ray', label: 'x-ray', sources: ['user'] })).toBe('x-ray');
    expect(tagDisplayLabel({ key: 'content:x-ray', facet: 'content', value: 'x-ray', label: 'x-ray', sources: ['funscript'] })).toBe('x ray');
  });
});

describe('the dialog\u2019s chips show the library\u2019s form', () => {
  const handles = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h?.dispose?.();
    _resetTagsSectionForTests?.();
    document.body.innerHTML = '';
  });

  function mount(extra = {}) {
    const store = { 'library.userTags': {}, 'library.hiddenTags': {}, 'library.scriptTags': {}, 'library.tagSettings': {} };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountTagsSection(host, {
      video: { path: A, name: 'Alpha.mp4', funscriptPath: A_S },
      dataService: { get: (k) => store[k], set: vi.fn(), getCategories: () => [], getAllVideoCategories: () => ({}), getVideoCategories: () => [] },
      getLibraryVideos: () => videos,
      getScriptMeta: async (p) => input.scriptMeta[p] ?? null,
      scriptMeta: input.scriptMeta,
      onDataChanged: vi.fn(),
      announce: vi.fn(),
      modalBody: document.body,
      eroscripts: { isLoggedIn: vi.fn(async () => true), login: vi.fn(), sessionExpired: vi.fn() },
      ...extra,
    });
    handles.push(handle);
    return host;
  }
  const chipText = (host, key) => [...host.querySelectorAll('.video-options-tags__chip')]
    .find((li) => li.dataset.tagKey === key)?.querySelector('.video-options-tags__chip-label')?.textContent;

  it('with the library index: its label', async () => {
    const result = buildLibraryTagIndex(input);
    const host = mount({ getTagIndex: () => result });
    await vi.waitFor(() => expect(chipText(host, 'device:the-handy')).toBe('the handy'));
  });

  it('without it: the same display rule', async () => {
    const host = mount();
    await vi.waitFor(() => expect(chipText(host, 'device:the-handy')).toBe('the handy'));
  });
});

describe('a card\u2019s tag line', () => {
  const lineFor = (tags) => {
    const fake = { _cardTagIndex: new Map([[A, tags]]), _tagShownLabel: Library.prototype._tagShownLabel };
    return Library.prototype._createCardTagLine.call(fake, { path: A });
  };

  it('long names are separate ellipsizing chips, the "+N" its own chip that never shrinks', () => {
    const long = 'a very long tag name that cannot fit on one small card at all';
    const tags = [long, 'second', 'third', 'fourth', 'fifth'].map((label, i) => ({ key: `content:t${i}`, facet: 'content', label }));
    const line = lineFor(tags);
    const chips = [...line.querySelectorAll('.library__card-tag')];
    expect(chips.map((c) => c.textContent)).toEqual([long, 'second', 'third', '+2']);
    expect(chips.at(-1).classList.contains('library__card-tag--more')).toBe(true);
    expect(line.title).toBe(`${long}, second, third, fourth, fifth`);
  });

  it('the longest name gives way first: each chip shrinks by its length cubed (r3-verify-2, a short tag cut to "t…")', () => {
    // jsdom has no layout; the weighting was measured in the app (2026-11-22): with these factors a
    // 3-letter and an 8-letter tag stay whole beside a 40-letter one at 160 / 200 / 260 px.
    const tags = ['tit', 'an extremely long tag name of forty chars', 'big tits']
      .map((label, i) => ({ key: `content:s${i}`, facet: 'content', label }));
    const shrink = [...lineFor(tags).querySelectorAll('.library__card-tag')].map((c) => Number(c.style.flexShrink));
    expect(shrink).toEqual([27, 41 ** 3, 512]);
  });

  it('the stylesheet: a chip ellipsizes, the "+N" does not shrink', () => {
    const css = fs.readFileSync('renderer/styles/library.css', 'utf8').replace(/\r/g, '');
    const rule = (sel) => new RegExp(`(^|\\n)${sel.replace(/[.-]/g, (m) => `\\${m}`)} \\{([^}]*)\\}`).exec(css)?.[2] || '';
    const tag = rule('.library__card-tag');
    for (const decl of ['overflow: hidden', 'text-overflow: ellipsis', 'min-width: 0', 'white-space: nowrap']) {
      expect(tag + rule('.library__card-tags')).toContain(decl);
    }
    expect(rule('.library__card-tag--more')).toMatch(/flex-shrink: 0/);
    expect(rule('.library__card-tag--more')).toMatch(/max-width: none/);
  });
});
