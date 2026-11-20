/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The desktop and the phone filter the same tags (r3-fixup R3R-2,
// 2026-11-18). The chain is: the desktop's ONE index (library-tag-filter.js
// buildLibraryTagIndex, what its Tags filter reads) -> the slice it sends
// (remote-tag-slice.js) -> the backend's register_tags (routes/media.py:
// shape checks and caps) -> /api/remote/tags -> the phone's filter
// (web-remote/tag-filter.js). tests/fixtures/tag-slice-parity.json pins it:
// this file checks the JS legs against it, and
// backend/tests/test_tag_slice_parity.py posts its `slice` to the REAL
// backend and checks the phone is served exactly `phoneVideoTags`. The old
// parity test stopped at the JS slice, so a backend cap the desktop does not
// apply (500 tags, creator last) passed it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  buildLibraryTagIndex, applyTagFilter, capVideoTags,
  MAX_TAGS_PER_VIDEO, MAX_TAG_KEY, MAX_TAG_LABEL,
} from '../../renderer/js/library-tag-filter.js';
import { buildRemoteTagSlice, remoteTagSliceFromIndex } from '../../renderer/js/remote-tag-slice.js';
import { filterByTags as phoneFilter } from '../../backend/web-remote/tag-filter.js';
import { NAME_FACETS } from '../../renderer/js/video-tags.js';

const FIXTURE = JSON.parse(fs.readFileSync('tests/fixtures/tag-slice-parity.json', 'utf8'));
const MEDIA_PY = fs.readFileSync('backend/routes/media.py', 'utf8');
const pyConst = (name) => Number(new RegExp(`^${name} = (\\d+)$`, 'm').exec(MEDIA_PY)?.[1]);

const { input } = FIXTURE;
const bulk = input.videos.find((v) => v.path.includes('Bulk')).path;

describe('the slice the desktop sends is its own index (the fixture is current)', () => {
  const { index } = buildLibraryTagIndex(input);

  it('the slice built from the index, and from a merge of its own, are the fixture', () => {
    expect(remoteTagSliceFromIndex(index)).toEqual(FIXTURE.slice);
    expect(buildRemoteTagSlice(input.videos, input)).toEqual(FIXTURE.slice);
  });

  it('a video over the cap keeps MAX_TAGS_PER_VIDEO tags, its names first, in facet order', () => {
    const tags = FIXTURE.slice[bulk];
    expect(tags).toHaveLength(MAX_TAGS_PER_VIDEO);
    const names = tags.filter((t) => NAME_FACETS.includes(t.facet)).map((t) => t.key);
    expect(names).toEqual(['performer:ann-other', 'performer:jane-doe', 'creator:scripter-zed']);
    expect(tags.at(-1).key).toBe('creator:scripter-zed');
    expect(index.get(bulk)).toHaveLength(MAX_TAGS_PER_VIDEO);
  });

  it('no key past MAX_TAG_KEY, no label past MAX_TAG_LABEL, no lone surrogate in what is sent', () => {
    for (const tags of Object.values(FIXTURE.slice)) {
      for (const t of tags) {
        expect(t.key.length).toBeLessThanOrEqual(MAX_TAG_KEY);
        expect(t.label.length).toBeLessThanOrEqual(MAX_TAG_LABEL);
        expect(t.key.isWellFormed() && t.label.isWellFormed()).toBe(true);
      }
    }
  });
});

describe('the same caps on both sides', () => {
  it('the desktop and the backend use the same numbers', () => {
    expect(pyConst('MAX_TAGS_PER_VIDEO')).toBe(MAX_TAGS_PER_VIDEO);
    expect(pyConst('MAX_TAG_KEY')).toBe(MAX_TAG_KEY);
    expect(pyConst('MAX_TAG_LABEL')).toBe(MAX_TAG_LABEL);
  });

  it('capVideoTags keeps the names even when they come last, and the order', () => {
    const many = [
      ...Array.from({ length: MAX_TAGS_PER_VIDEO + 5 }, (_, i) => ({ key: `content:t${i}`, facet: 'content' })),
      { key: 'performer:p', facet: 'performer' }, { key: 'creator:c', facet: 'creator' }, { key: 'studio:s', facet: 'studio' },
    ];
    const kept = capVideoTags(many);
    expect(kept).toHaveLength(MAX_TAGS_PER_VIDEO);
    expect(kept.slice(-3).map((t) => t.key)).toEqual(['performer:p', 'creator:c', 'studio:s']);
    expect(kept[MAX_TAGS_PER_VIDEO - 4].key).toBe(`content:t${MAX_TAGS_PER_VIDEO - 4}`);
    const few = many.slice(0, 3);
    expect(capVideoTags(few)).toBe(few);
  });
});

describe('every query: the desktop over its index and the phone over what the backend serves agree', () => {
  const { index } = buildLibraryTagIndex(input);
  for (const q of FIXTURE.queries) {
    it(q.include.join(' + '), () => {
      const desktop = applyTagFilter(input.videos, { include: q.include }, { index }).map((v) => v.path);
      const phone = phoneFilter(input.videos, { include: q.include, mode: 'facets' }, FIXTURE.phoneVideoTags).map((v) => v.path);
      expect(desktop).toEqual(q.expect);
      expect(phone).toEqual(q.expect);
    });
  }

  it('the cases the fixture claims are in it', () => {
    const by = Object.fromEntries(FIXTURE.queries.map((q) => [q.include.join('+'), q.expect.length]));
    expect(by['creator:scripter-zed']).toBe(1);       // the name the 500-cap used to cut on the phone
    expect(by['content:bulk-tag-1099']).toBe(0);      // past the cap: on neither side
    expect(by['content:hide-me']).toBe(0);            // hidden
    expect(by['content:ok']).toBe(1);                 // beside two lone surrogates
  });
});
