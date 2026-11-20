/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The phone's tag slice (P1 tags, Round 3, 2026-11-18): what the desktop
// sends the phone as `videoTags` (renderer/js/remote-tag-slice.js). The
// phone keeps no merge logic, so every rule the desktop's merge applies must
// already be in the slice: hidden tags gone, an EroScripts record about
// another script left out, the funscript harvest in. And the phone's filter
// over the slice must give what the desktop's filter gives over its own
// index: the shared parity fixture is run through the slice here.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildRemoteTagSlice, REMOTE_TAG_SETTING_PATHS } from '../../renderer/js/remote-tag-slice.js';
import { funscriptMetaRecord, filterByTags as desktopFilter } from '../../renderer/js/video-tags.js';
import { buildLibraryTagIndex } from '../../renderer/js/library-tag-filter.js';
import { filterByTags as phoneFilter } from '../../backend/web-remote/tag-filter.js';

const V = 'C:/Library/Scene.mp4';
const S = 'C:/Library/Scene.funscript';
const OTHER = 'C:/Library/Other.funscript';

const keys = (slice, path) => (slice[path] || []).map((t) => t.key);

describe('buildRemoteTagSlice', () => {
  it('merges your tags, the post and the script file, as {key, facet, label}', () => {
    const slice = buildRemoteTagSlice([{ path: V, funscriptPath: S }], {
      userTags: { [V]: ['favourite'] },
      scriptTags: { [V]: { tags: ['the-handy', 'len-10-25'], scriptPath: S, topicId: 1 } },
      scriptMeta: { [S]: funscriptMetaRecord({ tags: ['POV'], creator: 'Scripter One' }, 1) },
    });
    expect(slice[V]).toEqual([
      { key: 'length:10-25', facet: 'length', label: '10-25' },
      { key: 'device:the-handy', facet: 'device', label: 'the handy' },
      { key: 'content:favourite', facet: 'content', label: 'favourite' },
      { key: 'content:pov', facet: 'content', label: 'POV' },
      { key: 'creator:scripter-one', facet: 'creator', label: 'Scripter One' },
    ]);
  });

  it('a tag you hid on this video, or everywhere, is not sent (unless you gave it yourself)', () => {
    const slice = buildRemoteTagSlice([{ path: V, funscriptPath: S }], {
      userTags: { [V]: ['real'] },
      hiddenTags: { [V]: ['len-10-25'] },
      tagSettings: { hidden: ['the-handy', 'real'], aliases: {}, facetOverrides: {} },
      scriptTags: { [V]: { tags: ['the-handy', 'len-10-25', 'real', 'pov'], scriptPath: S } },
    });
    expect(keys(slice, V)).toEqual(['content:pov', 'content:real']);
  });

  it('a post about another script, or a video left with no script, gives no tags', () => {
    const records = { [V]: { tags: ['pov'], scriptPath: OTHER } };
    expect(buildRemoteTagSlice([{ path: V, funscriptPath: S }], { scriptTags: records })).toEqual({});
    const named = { [V]: { tags: ['pov'], scriptPath: S } };
    expect(buildRemoteTagSlice([{ path: V, funscriptPath: null }], { scriptTags: named })).toEqual({});
    expect(keys(buildRemoteTagSlice([{ path: V, funscriptPath: S }], { scriptTags: named }), V)).toEqual(['content:pov']);
  });

  it('the harvest counts only for the script the video plays now', () => {
    const scriptMeta = { [OTHER]: funscriptMetaRecord({ tags: ['vr'] }, 1) };
    expect(buildRemoteTagSlice([{ path: V, funscriptPath: S }], { scriptMeta })).toEqual({});
    expect(keys(buildRemoteTagSlice([{ path: V, funscriptPath: OTHER }], { scriptMeta }), V)).toEqual(['vr:vr']);
  });

  it('damaged stores and empty input give an empty slice, never a throw', () => {
    for (const stores of [{}, { userTags: [], scriptTags: 'x', hiddenTags: 5, tagSettings: null, scriptMeta: [] }]) {
      expect(buildRemoteTagSlice([{ path: V, funscriptPath: S }], stores)).toEqual({});
    }
    expect(buildRemoteTagSlice([], {})).toEqual({});
    expect(buildRemoteTagSlice(null, {})).toEqual({});
  });

  it('leaves the stores as they were', () => {
    const stores = { scriptTags: { [V]: { tags: ['pov'] } }, userTags: { [V]: ['a'] }, hiddenTags: { [V]: ['b'] } };
    const before = JSON.stringify(stores);
    buildRemoteTagSlice([{ path: V, funscriptPath: null }], stores);
    expect(JSON.stringify(stores)).toBe(before);
  });

  it('re-sends on every store that changes a merge, on a pairing, and on the Stash switch (Stash S1)', () => {
    expect([...REMOTE_TAG_SETTING_PATHS].sort()).toEqual([
      'library.associations', 'library.hiddenTags', 'library.scriptTags', 'library.tagSettings', 'library.userTags',
      'stash.enabled', 'stash.useTagRules',
    ]);
  });
});

describe('the phone, filtering the slice, agrees with the desktop (tag-filter-parity.json)', () => {
  // The desktop filters its own index (the tag objects of
  // library-tag-filter.js buildLibraryTagIndex, what the library's Tags
  // filter reads); the phone filters the slice's keys. Every query of the
  // shared fixture must give the same videos. The sources are the ones P1
  // has (yours, EroScripts, the script file), read with the dialog's rule:
  // Video B's post names no script and B has none, so its tags do not count
  // on either side (fixup-data 2026-11-18, RB-2).
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tag-filter-parity.json', 'utf8'));
  const videos = fixture.videos.map((v) => ({ path: v.path, name: v.name, funscriptPath: v.scriptPath }));
  const stores = {
    userTags: fixture.sources.user,
    hiddenTags: fixture.hidden,
    scriptTags: fixture.sources.eroscripts,
    tagSettings: { aliases: fixture.options.aliases, facetOverrides: fixture.options.facetOverrides, hidden: fixture.options.hiddenEverywhere },
    scriptMeta: fixture.sources.funscript,
  };
  const desktopIndex = buildLibraryTagIndex({ videos, ...stores }).index;
  const slice = buildRemoteTagSlice(videos, stores);
  const phoneKeys = Object.fromEntries(Object.entries(slice).map(([p, tags]) => [p, tags.map((t) => t.key)]));

  it('the slice holds exactly the desktop index, key for key', () => {
    expect(phoneKeys).toEqual(Object.fromEntries([...desktopIndex].map(([p, tags]) => [p, tags.map((t) => t.key)])));
    expect(Object.keys(phoneKeys).length).toBeGreaterThan(3);
  });

  for (const query of fixture.queries) {
    it(query.name, () => {
      const q = { include: query.include, exclude: query.exclude, mode: query.mode };
      const desktop = desktopFilter(videos, q, desktopIndex).map((v) => v.path);
      const phone = phoneFilter(videos, q, phoneKeys).map((v) => v.path);
      expect(phone).toEqual(desktop);
    });
  }
});
