/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Odd strings and the per-pass cost of the tag engine (r3-fixup, 2026-11-18).
//
// R3R-1: a lone UTF-16 surrogate (half an emoji, valid JSON) in a funscript's
// metadata cost the video its speed stats on the backend. The renderer took
// the same string happily, so the two ports disagreed, and a key carrying one
// would make the phone's /api/remote/tags fail whole (no UTF-8 encoder takes
// it). Now such a string is unusable everywhere: no tag, no alias, no
// metadata value (the backend's twin: test_tag_fixup.py, and the shared
// table tests/fixtures/script-meta-harvest.json).
//
// R3R-6: a filter pass re-parsed (NFKD + slug) every key of every video; the
// parsed sets are now built once per index build.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  effectiveTags, funscriptMetaRecord, compileTagRules, isWellFormedText, filterByTags, tagKeySet,
} from '../../renderer/js/video-tags.js';
import { buildLibraryTagIndex, applyTagFilter, keySetsFor } from '../../renderer/js/library-tag-filter.js';

const V = 'C:/lib/Scene.mp4';
const S = 'C:/lib/Scene.funscript';
const HALF = '\ud83d';
const keys = (tags) => tags.map((t) => t.key);

describe('a string that is not well-formed text is no tag, from any source', () => {
  it('isWellFormedText', () => {
    expect(isWellFormedText('ok \ud83d\ude00')).toBe(true);
    expect(isWellFormedText(`x${HALF}`)).toBe(false);
    expect(isWellFormedText('\udc00x')).toBe(false);
    expect(isWellFormedText(5)).toBe(false);
  });

  it('your tags, the post\u2019s tags (both shapes), its creator, and the file\u2019s record', () => {
    const tags = effectiveTags(V, {
      user: { [V]: ['mine', `bad${HALF}`] },
      eroscripts: { [V]: { tags: ['pov', { id: 1, name: `x${HALF}` }, `\udc00`], creator: `C${HALF}`, scriptPath: S } },
      funscript: { [S]: { tags: ['file', `f${HALF}`], topicTags: [], performers: [`${HALF}Jane`] } },
    }, { scriptPath: S });
    expect(keys(tags)).toEqual(['content:file', 'content:mine', 'content:pov']);
    for (const t of tags) expect(isWellFormedText(t.key) && isWellFormedText(t.label)).toBe(true);
  });

  it('an alias from or to such a string is ignored', () => {
    const rules = compileTagRules({ aliases: { pov: `p${HALF}`, [`q${HALF}`]: 'pov' } });
    expect(keys(effectiveTags(V, { user: { [V]: ['pov'] } }, { rules }))).toEqual(['content:pov']);
  });

  it('funscriptMetaRecord leaves such a value out, as the backend\u2019s harvest does', () => {
    const rec = funscriptMetaRecord({
      title: `T${HALF}`, creator: `${HALF}`, author: 'Author', tags: ['a', `b${HALF}`], performers: [`${HALF}`],
      topic_url: `https://discuss.eroscripts.com/t/x/5${HALF}`, script_url: 'https://discuss.eroscripts.com/t/x/6',
    }, 1);
    expect(rec).toMatchObject({ tags: ['a'], performers: [], creator: 'Author', title: null, topicId: 6 });
  });

  it('the shared harvest table has the case (both suites read it)', () => {
    const { cases } = JSON.parse(fs.readFileSync('tests/fixtures/script-meta-harvest.json', 'utf8'));
    expect(cases.some((c) => /surrogate/.test(c.name))).toBe(true);
  });
});

describe('a filter pass reads keys parsed once per index build', () => {
  const videos = Array.from({ length: 50 }, (_, i) => ({ path: `C:/lib/v${i}.mp4`, funscriptPath: null }));
  const userTags = Object.fromEntries(videos.map((v, i) => [v.path, [`Tag ${i % 5}`, i % 2 ? 'The Handy' : 'pov']]));

  it('the same sets for the same index; a new build, new sets', () => {
    const one = buildLibraryTagIndex({ videos, userTags });
    const sets = keySetsFor(one.index);
    expect(keySetsFor(one.index)).toBe(sets);
    const a = sets.get(videos[3].path);
    applyTagFilter(videos, { include: ['device:the-handy'] }, { index: one.index });
    expect(sets.get(videos[3].path)).toBe(a);              // not parsed again
    const two = buildLibraryTagIndex({ videos, userTags });
    expect(keySetsFor(two.index)).not.toBe(sets);
  });

  it('gives what the lists give, for every query shape', () => {
    const { index } = buildLibraryTagIndex({ videos, userTags });
    const lists = Object.fromEntries([...index].map(([p, tags]) => [p, tags]));
    const sets = new Map([...index].map(([p, tags]) => [p, tagKeySet(tags)]));
    for (const query of [
      { include: ['device:the-handy'] }, { include: ['the-handy', 'content:pov'], mode: 'any' },
      { include: ['content:tag-1', 'device:the-handy'] }, { exclude: ['content:pov'] },
      { include: ['content:tag-1', 'content:tag-2'], mode: 'all' }, { include: ['tag-3'] },
    ]) {
      expect(filterByTags(videos, query, sets).map((v) => v.path)).toEqual(filterByTags(videos, query, lists).map((v) => v.path));
    }
    const shown = applyTagFilter(videos, { include: ['device:the-handy'] }, { index }).map((v) => v.path);
    expect(shown).toEqual(videos.filter((_, i) => i % 2).map((v) => v.path));
  });
});
