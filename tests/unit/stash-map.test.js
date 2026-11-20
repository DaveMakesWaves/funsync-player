/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// electron/stash-map.js (Stash S1, 2026-11-18): Stash's GraphQL answers to
// the records kept in userData/stash/library.json (DESIGN-stash-s1.md (c)),
// with their limits, and the scene markers that Round 2 draws as seek-bar
// chapters (Dave, 2026-11-18). The answers are the local test Stash's
// (v0.32.0, synthetic library) in tests/fixtures/stash/.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  LIMITS, stashId, mapScene, mapScenes, mapListScene, mapScenePage, sceneListComplete,
  mapMarker, mapStudio, findApiKeyStrings,
} = require_('../../electron/stash-map.js');

const fixture = (name) => JSON.parse(fs.readFileSync(`tests/fixtures/stash/${name}`, 'utf8'));
const SCENE_1 = fixture('find-scene-by-oshash.response.json').data.findSceneByHash;
const ALL = fixture('all-scenes.response.json').data.findScenes;
const NOW = 1795000000000;
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('stash-map: a scene from the test Stash', () => {
  it('maps scene 1 to the stored record, people, studio and tags once by id', () => {
    const out = mapScene(SCENE_1, { now: NOW });
    expect(out.scene).toEqual({
      id: '1',
      title: 'Synthetic Scene Small',
      code: 'SYN-001',
      date: '2026-11-17',
      director: 'Synthetic Director',
      details: 'Synthetic test scene.',
      urls: ['https://example.invalid/scene/1'],
      rating100: 80,
      organized: true,
      studioId: '2',
      performerIds: ['1', '2'],
      tagIds: ['1', '2'],
      markers: [
        {
          id: '1', title: 'Synthetic marker one', seconds: 1.5, endSeconds: 3.25,
          tag: { id: '4', name: 'Synthetic Marker Tag' },
          tags: [{ id: '1', name: 'Synthetic Tag A' }],
        },
        { id: '2', title: '', seconds: 4, endSeconds: null, tag: { id: '2', name: 'Synthetic Tag B' }, tags: [] },
      ],
      stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: '00000000-0000-4000-8000-000000000101' }],
      files: [{
        path: 'C:\\Users\\user\\Desktop\\Coding-Projects\\stash-test\\library\\sub\\Synthetic Clip Small.mp4',
        size: 213390, oshash: '6b3f3b3ee9e8c31a', duration: 6,
      }],
      updatedAt: '2026-11-17T20:32:20Z',
      fetchedAt: NOW,
      // The next lot (2026-11-19): this older answer lists the file's
      // fingerprints, phash among them; nothing else of the next lot's.
      phash: '8a7da502fa0aeb6a',
    });
    // lists, in Stash's order (stash-library-file.js storeRecords keys them by id)
    expect(out.performers).toEqual([
      {
        id: '1', name: 'Synthetic Performer One', disambiguation: 'test',
        stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: '00000000-0000-4000-8000-000000000001' }],
      },
      { id: '2', name: 'Synthetic Performer Two', disambiguation: '', stashIds: [] },
    ]);
    expect(out.studios).toEqual([
      {
        id: '2', name: 'Synthetic Studio', parent: 'Synthetic Network', parentId: '1',
        stashIds: [{ endpoint: 'https://stash-box.invalid/graphql', stashId: '00000000-0000-4000-8000-0000000000aa' }],
      },
    ]);
    expect(out.tags).toEqual([{ id: '1', name: 'Synthetic Tag A' }, { id: '2', name: 'Synthetic Tag B' }]);
  });

  it('every scene of the full list maps, and people, studios and tags merge by id (nulls skipped)', () => {
    const merged = mapScenes(ALL.scenes, { now: NOW });
    expect(Object.keys(merged.scenes).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    const aliased = mapScenes({ a0: SCENE_1, a1: null, a2: ALL.scenes[0] }, { now: NOW });
    expect(Object.keys(aliased.scenes).sort()).toEqual(['1', '2']);
    expect(aliased.performers['1'].name).toBe('Synthetic Performer One');
    expect(aliased.studios['2'].name).toBe('Synthetic Studio');
    expect(aliased.tags['2'].name).toBe('Synthetic Tag B');
    expect(mapScenes(null)).toEqual({ scenes: {}, performers: {}, studios: {}, tags: {} });
  });
});

describe('stash-map: nothing Stash built is stored', () => {
  it('paths, sceneStreams and image URLs are never copied, even when the answer carries a key', () => {
    const raw = clone(SCENE_1);
    raw.paths = { screenshot: 'http://127.0.0.1:9999/scene/1/screenshot?apikey=SAMPLEKEY', funscript: 'http://127.0.0.1:9999/scene/1/funscript?apikey=SAMPLEKEY' };
    raw.sceneStreams = [{ url: 'http://127.0.0.1:9999/scene/1/stream.mp4?apikey=SAMPLEKEY', label: 'Direct' }];
    raw.performers[0].image_path = 'http://127.0.0.1:9999/performer/1/image?apikey=SAMPLEKEY';
    const out = mapScene(raw, { now: NOW });
    expect(findApiKeyStrings(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('SAMPLEKEY');
    expect(Object.keys(out.scene).sort()).toEqual([
      'code', 'date', 'details', 'director', 'fetchedAt', 'files', 'id', 'markers', 'organized', 'performerIds',
      'phash', 'rating100', 'stashIds', 'studioId', 'tagIds', 'title', 'updatedAt', 'urls',
    ]);
  });

  it('a string with "apikey=" anywhere (a scene URL, a title, an endpoint) is left out', () => {
    const raw = clone(SCENE_1);
    raw.urls = ['https://example.invalid/a', 'http://127.0.0.1:9999/scenes/1?ApiKey=SAMPLEKEY'];
    raw.title = 'see ?apikey=SAMPLEKEY';
    raw.stash_ids = [{ endpoint: 'https://stash-box.invalid/graphql?apikey=SAMPLEKEY', stash_id: 'x' }];
    const out = mapScene(raw, { now: NOW });
    expect(out.scene.urls).toEqual(['https://example.invalid/a']);
    expect(out.scene.title).toBeNull();
    expect(out.scene.stashIds).toEqual([]);
    expect(findApiKeyStrings(out)).toEqual([]);
  });

  it('findApiKeyStrings finds such a string (and a key) at any depth', () => {
    expect(findApiKeyStrings({ a: [{ b: 'x?apikey=1' }], c: 'ok', 'apikey=': 1 })).toEqual(['a.0.b', 'apikey=']);
  });
});

describe('stash-map: limits (left out, never cut into another name)', () => {
  it('at most 200 tags, 100 performers, 500 markers (the earliest), 10 URLs per scene', () => {
    const raw = clone(SCENE_1);
    raw.tags = Array.from({ length: 250 }, (_, i) => ({ id: String(100 + i), name: `tag ${i}` }));
    raw.performers = Array.from({ length: 150 }, (_, i) => ({ id: String(100 + i), name: `p ${i}` }));
    raw.scene_markers = Array.from({ length: 600 }, (_, i) => ({ id: String(1000 + i), title: `m${i}`, seconds: 600 - i }));
    raw.urls = Array.from({ length: 15 }, (_, i) => `https://example.invalid/${i}`);
    const out = mapScene(raw, { now: NOW });
    expect(out.scene.tagIds).toHaveLength(LIMITS.tagsPerScene);
    expect(out.tags).toHaveLength(200);
    expect(out.scene.performerIds).toHaveLength(LIMITS.performersPerScene);
    expect(out.performers).toHaveLength(100);
    expect(out.scene.markers).toHaveLength(LIMITS.markersPerScene);
    expect(out.scene.markers[0].seconds).toBe(1);
    expect(out.scene.markers[499].seconds).toBe(500);
    expect(out.scene.urls).toHaveLength(10);
    expect([LIMITS.tagsPerScene, LIMITS.performersPerScene, LIMITS.markersPerScene, LIMITS.urlsPerScene]).toEqual([200, 100, 500, 10]);
  });

  it('a name over 200 characters or with a lone surrogate is left out, not cut; 200 is kept', () => {
    const raw = clone(SCENE_1);
    const long = 'x'.repeat(201);
    raw.tags = [
      { id: '1', name: long },
      { id: '2', name: 'y'.repeat(200) },
      { id: '3', name: 'half \ud83d emoji' },
      { id: '4', name: 'whole \ud83d\ude00 emoji' },
    ];
    raw.performers = [{ id: '1', name: long }, { id: '2', name: 'Jane', disambiguation: long }];
    raw.studio = { id: '9', name: '\udc00' };
    const out = mapScene(raw, { now: NOW });
    expect(out.scene.tagIds).toEqual(['2', '4']);
    expect(out.tags.map((t) => t.name)).toEqual(['y'.repeat(200), 'whole \ud83d\ude00 emoji']);
    expect(out.scene.performerIds).toEqual(['2']);
    expect(out.performers).toEqual([{ id: '2', name: 'Jane', disambiguation: '', stashIds: [] }]);
    expect(out.scene.studioId).toBeNull();
    expect(out.studios).toEqual([]);
    // nothing anywhere is a 200-character piece of the long name
    expect(JSON.stringify(out)).not.toContain('x'.repeat(200));
  });

  it('details are display text: cut at 2,000 characters, never inside a surrogate pair', () => {
    const raw = clone(SCENE_1);
    raw.details = 'd'.repeat(2500);
    expect(mapScene(raw).scene.details).toBe('d'.repeat(2000));
    raw.details = `${'d'.repeat(1999)}\ud83d\ude00tail`;
    expect(mapScene(raw).scene.details).toBe('d'.repeat(1999));
    raw.details = 'bad \udc00';
    expect(mapScene(raw).scene.details).toBeNull();
  });

  it('checks rating, date, organised and file values', () => {
    const raw = clone(SCENE_1);
    Object.assign(raw, { rating100: 101, date: '17.11.2026', organized: 'yes' });
    raw.files = [
      { path: 'C:\\a.mp4', size: -1, duration: 'long', oshash: 'NOT-A-HASH' },
      { path: '', size: 5 },
      { path: ' C:\\b.mp4', size: 10, fingerprints: [{ type: 'phash', value: 'ff' }, { type: 'oshash', value: '00000000000000AB' }] },
    ];
    const out = mapScene(raw).scene;
    expect([out.rating100, out.date, out.organized]).toEqual([null, null, false]);
    expect(out.files).toEqual([
      { path: 'C:\\a.mp4', size: null, oshash: null, duration: null },
      // a path is kept exactly as Stash spells it; the hash from the fingerprints list
      { path: ' C:\\b.mp4', size: 10, oshash: '00000000000000ab', duration: null },
    ]);
  });
});

describe('stash-map: ids', () => {
  it('numeric strings and whole numbers are ids; a path, a prototype name or junk is not', () => {
    expect(stashId('12')).toBe('12');
    expect(stashId(12)).toBe('12');
    for (const bad of ['../1', '1/screenshot', '__proto__', 'constructor', '', ' 1', 'a'.repeat(65), -1, 1.5, null, {}]) {
      expect(stashId(bad), String(bad)).toBeNull();
    }
  });

  it('a scene, person, tag or marker with a bad id is left out, the rest kept', () => {
    const raw = clone(SCENE_1);
    raw.id = '../../settings';
    expect(mapScene(raw)).toBeNull();
    const ok = clone(SCENE_1);
    ok.performers.push({ id: '__proto__', name: 'Evil' }, { id: 'toString', name: 'Odd but fine' });
    ok.tags.push({ id: 'x/y', name: 'Slash' });
    const out = mapScene(ok);
    expect(out.scene.performerIds).toEqual(['1', '2', 'toString']);
    expect(out.performers.map((p) => p.id)).toEqual(['1', '2', 'toString']);
    expect(out.scene.tagIds).toEqual(['1', '2']);
    const merged = mapScenes([ok]);
    expect(Object.keys(merged.performers)).toEqual(['1', '2', 'toString']);
    expect(Object.getPrototypeOf(merged.performers)).toBe(Object.prototype);
  });
});

describe('stash-map: markers (seek-bar chapters in S1)', () => {
  it('sorted by start; an end at or before the start is no end; a marker with no valid start is left out', () => {
    const raw = clone(SCENE_1);
    raw.scene_markers = [
      { id: '5', title: 'late', seconds: 90, end_seconds: 120, primary_tag: { id: '1', name: 'A' }, tags: [] },
      { id: '6', title: 'backwards', seconds: 30, end_seconds: 10, primary_tag: null },
      { id: '7', title: 'no start', seconds: null },
      { id: '8', title: 'negative', seconds: -1 },
      { id: '5', title: 'duplicate id', seconds: 1 },
      { id: '9', title: 'early', seconds: 0, end_seconds: 0.5, primary_tag: { id: 'bad/id', name: 'x' }, tags: [{ id: '2', name: 'B' }, { id: '2', name: 'B again' }] },
    ];
    expect(mapScene(raw).scene.markers).toEqual([
      { id: '9', title: 'early', seconds: 0, endSeconds: 0.5, tag: null, tags: [{ id: '2', name: 'B' }] },
      { id: '6', title: 'backwards', seconds: 30, endSeconds: null, tag: null, tags: [] },
      { id: '5', title: 'late', seconds: 90, endSeconds: 120, tag: { id: '1', name: 'A' }, tags: [] },
    ]);
  });

  it('a marker title over the name limit is empty (the chapter then shows its tag)', () => {
    expect(mapMarker({ id: '1', title: 't'.repeat(201), seconds: 2, primary_tag: { id: '3', name: 'Tag' } }))
      .toEqual({ id: '1', title: '', seconds: 2, endSeconds: null, tag: { id: '3', name: 'Tag' }, tags: [] });
  });

  it('a studio keeps its parent\'s name and id, or none', () => {
    expect(mapStudio({ id: '2', name: 'S', parent_studio: { id: '1', name: 'Net' } })).toMatchObject({ parent: 'Net', parentId: '1' });
    expect(mapStudio({ id: '2', name: 'S', parent_studio: { id: '../1', name: 'Net' } })).toMatchObject({ parent: null, parentId: null });
    expect(mapStudio({ id: '2', name: 'S' })).toMatchObject({ parent: null, parentId: null });
  });
});

describe('stash-map: the light list a full sync reads', () => {
  it('maps a findScenes page: count, and each scene\'s id, last change and files', () => {
    const page = mapScenePage(ALL);
    expect(page.count).toBe(9);
    expect(page.dropped).toBe(0);
    expect(page.scenes).toHaveLength(9);
    expect(page.scenes.find((s) => s.id === '1')).toEqual({
      id: '1',
      updatedAt: '2026-11-17T20:32:20Z',
      files: [{
        path: 'C:\\Users\\user\\Desktop\\Coding-Projects\\stash-test\\library\\sub\\Synthetic Clip Small.mp4',
        size: 213390, oshash: '6b3f3b3ee9e8c31a',
      }],
    });
  });

  it('a scene with a bad id is dropped and counted, so the list cannot pass as complete', () => {
    const raw = clone(ALL);
    raw.scenes[0].id = '../9';
    const page = mapScenePage(raw);
    expect(page.dropped).toBe(1);
    expect(sceneListComplete({ allPagesFetched: true, firstCount: 9, lastCount: 9, scenes: page.scenes, dropped: page.dropped })).toBe(false);
    expect(mapListScene({ id: '1', files: null })).toEqual({ id: '1', updatedAt: null, files: [] });
    expect(mapScenePage(undefined)).toEqual({ count: null, scenes: [], dropped: 0 });
  });

  it('complete only when every page came, the count held from first to last page, and the ids add up to it', () => {
    const { scenes } = mapScenePage(ALL);
    expect(sceneListComplete({ allPagesFetched: true, firstCount: 9, lastCount: 9, scenes })).toBe(true);
    expect(sceneListComplete({ allPagesFetched: false, firstCount: 9, lastCount: 9, scenes })).toBe(false);
    expect(sceneListComplete({ allPagesFetched: true, firstCount: 9, lastCount: 8, scenes })).toBe(false);
    // a scene added mid-sync shifted a page: one id seen twice, one never seen
    const shifted = [...scenes.slice(0, 8), scenes[7]];
    expect(sceneListComplete({ allPagesFetched: true, firstCount: 9, lastCount: 9, scenes: shifted })).toBe(false);
    expect(sceneListComplete({ allPagesFetched: true, firstCount: null, lastCount: null, scenes: [] })).toBe(false);
    expect(sceneListComplete()).toBe(false);
  });
});
