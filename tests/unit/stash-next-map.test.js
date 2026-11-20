/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot (2026-11-19, DESIGN-stash-s1.md appendix (j) #2, #3, #5,
// #6, #10; stage sn-main): what electron/stash-map.js keeps of the new
// fields, from the answers the LOCAL test Stash gave to the new documents
// (tests/fixtures/stash/sn-*.response.json), and its limits.
//
// Guards checked by reopening their hole (SCRATCH/sn-main/holes.jsonl):
//   - an answer WITHOUT a field leaves it out of the record (unknown), never
//     0 / [] / null (hole: default playCount to 0)
//   - a phash Stash wrote without leading zeros is padded to 16 hex (hole:
//     no padding: a short phash was dropped)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  mapScene, mapSceneActivity, mapTagPage, tagListComplete, normalizePhash, isoStamp, mapGroupRef, LIMITS, findApiKeyStrings,
} = require_('../../electron/stash-map.js');

const fixture = (name) => JSON.parse(fs.readFileSync(`tests/fixtures/stash/${name}`, 'utf8'));
const DETAILS = fixture('sn-scene-details.response.json').body.data;
const LIST = fixture('sn-scene-list.response.json').body.data.findScenes;
const TAGS = fixture('sn-tag-list.response.json').body.data.findTags;
const S1_DETAILS = fixture('s1-scene-details.response.json').body.data;
const NOW = 1763500000000;
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('the next lot\'s fields from the details the test Stash gave', () => {
  it('scene 1: plays, last play (UTC ISO), O-count, both Groups with its place, the primary file\'s phash', () => {
    const { scene } = mapScene(DETAILS.s0, { now: NOW });
    expect(scene).toMatchObject({
      id: '1',
      rating100: 80,
      organized: true,
      playCount: 1,
      lastPlayedAt: '2026-09-30T23:10:00.000Z',
      oCounter: 1,
      phash: '8a7da502fa0aeb6a',
      groups: [
        { id: '1', name: 'Synthetic Series A', sceneIndex: 3 },
        { id: '2', name: 'Synthetic Series B', sceneIndex: 2 },
      ],
    });
  });

  it('a scene never played and with no phash says so (0, null, []), which is not "unknown"', () => {
    const { scene } = mapScene(DETAILS.s4, { now: NOW }); // scene 5: O-count 2, no plays, no phash, no Group
    expect(scene.playCount).toBe(0);
    expect(scene.lastPlayedAt).toBeNull();
    expect(scene.oCounter).toBe(2);
    expect(scene.phash).toBeNull();
    expect(scene.groups).toEqual([]);
  });

  it('the re-encode (scene 10) has the same phash as scene 2: the "Looks the same (Stash)" pair', () => {
    expect(mapScene(DETAILS.s9, { now: NOW }).scene.phash).toBe('ab63cd1cc33c3343');
    expect(mapScene(DETAILS.s1, { now: NOW }).scene.phash).toBe('ab63cd1cc33c3343');
  });

  it('the light list gives the same values (what a full sync refreshes without the details)', () => {
    for (const raw of LIST.scenes) {
      const details = Object.values(DETAILS).find((d) => d && d.id === raw.id);
      const fromDetails = mapScene(details, { now: NOW }).scene;
      const fromList = mapSceneActivity(raw);
      for (const k of ['playCount', 'lastPlayedAt', 'oCounter', 'groups', 'phash']) expect(fromList[k], `${raw.id} ${k}`).toEqual(fromDetails[k]);
    }
  });

  it('an answer without the fields (S1\'s document) leaves them OUT: unknown, never 0 plays or no Group (guard)', () => {
    const { scene } = mapScene(S1_DETAILS.s0, { now: NOW });
    for (const k of ['playCount', 'lastPlayedAt', 'oCounter', 'groups', 'phash', 'activityAt']) {
      expect(Object.prototype.hasOwnProperty.call(scene, k), k).toBe(false);
    }
    expect(mapSceneActivity({ id: '1' })).toEqual({});
    expect(mapSceneActivity(null)).toEqual({});
    // Stash answering null for a count is not a count.
    expect(mapSceneActivity({ play_count: null, o_counter: null })).toEqual({});
  });
});

describe('limits: what is checked before anything is stored', () => {
  it('counts are whole numbers 0..1e9; anything else is left out', () => {
    for (const bad of [-1, 1.5, '3', 1e10, NaN, Infinity, true]) {
      expect(mapSceneActivity({ play_count: bad, o_counter: bad }), String(bad)).toEqual({});
    }
    expect(mapSceneActivity({ play_count: LIMITS.count, o_counter: 0 })).toEqual({ playCount: LIMITS.count, oCounter: 0 });
  });

  it('the last play becomes a UTC ISO stamp (text order = time order); junk is left out', () => {
    expect(isoStamp('2026-11-17T23:45:00+02:00')).toBe('2026-11-17T21:45:00.000Z');
    expect(isoStamp('2026-11-17T21:45:00Z')).toBe('2026-11-17T21:45:00.000Z');
    for (const bad of ['yesterday', '2026-11-17', '', 'x'.repeat(100), 12345, null]) expect(isoStamp(bad), String(bad)).toBeNull();
    expect(mapSceneActivity({ last_played_at: 'not a date' })).toEqual({});
    expect(mapSceneActivity({ last_played_at: null })).toEqual({ lastPlayedAt: null });
  });

  it('a phash is 16 lower-case hex; Stash\'s shorter hex (no leading zeros) is padded; anything else is null (guard)', () => {
    expect(normalizePhash('AB63CD1CC33C3343')).toBe('ab63cd1cc33c3343');
    expect(normalizePhash('abc')).toBe('0000000000000abc');
    expect(mapSceneActivity({ files: [{ phash: 'fa0aeb6a' }] }).phash).toBe('00000000fa0aeb6a');
    for (const bad of ['', 'xyz', '1'.repeat(17), 12345, null, undefined]) expect(normalizePhash(bad), String(bad)).toBeNull();
  });

  it('the phash is the PRIMARY file\'s: a second file\'s phash never stands in for it', () => {
    expect(mapSceneActivity({ files: [{ phash: null }, { phash: 'ab63cd1cc33c3343' }] }).phash).toBeNull();
    expect(mapSceneActivity({ files: [] }).phash).toBeNull();
    // A fingerprints list (older answers) is read too; a file that was never asked about stays unknown.
    expect(mapSceneActivity({ files: [{ fingerprints: [{ type: 'phash', value: '8a7da502fa0aeb6a' }] }] }).phash).toBe('8a7da502fa0aeb6a');
    expect(Object.prototype.hasOwnProperty.call(mapSceneActivity({ files: [{ path: '/a.mp4' }] }), 'phash')).toBe(false);
  });

  it('a Group needs a good id and a usable name (left out, never cut); at most 100 per scene; one entry per Group', () => {
    expect(mapGroupRef({ scene_index: 1, group: { id: '../x', name: 'A' } })).toBeNull();
    expect(mapGroupRef({ scene_index: 1, group: { id: '__proto__', name: 'A' } })).toBeNull();
    expect(mapGroupRef({ scene_index: 1, group: { id: '1', name: 'x'.repeat(LIMITS.name + 1) } })).toBeNull();
    expect(mapGroupRef({ scene_index: 1, group: { id: '1', name: 'bad \uD800 text' } })).toBeNull();
    expect(mapGroupRef({ scene_index: 1, group: { id: '1', name: 'see ?apikey=SAMPLEKEY' } })).toBeNull();
    expect(mapGroupRef({ scene_index: 2.5, group: { id: '1', name: 'A' } })).toEqual({ id: '1', name: 'A', sceneIndex: null });
    expect(mapGroupRef({ scene_index: null, group: { id: '1', name: 'A' } })).toEqual({ id: '1', name: 'A', sceneIndex: null });
    const many = Array.from({ length: 150 }, (_, i) => ({ scene_index: i, group: { id: String(i + 1), name: `G${i}` } }));
    many.push({ scene_index: 9, group: { id: '1', name: 'again' } });
    const out = mapSceneActivity({ groups: many }).groups;
    expect(out).toHaveLength(LIMITS.groupsPerScene);
    expect(out.filter((g) => g.id === '1')).toEqual([{ id: '1', name: 'G0', sceneIndex: 0 }]);
  });

  it('a scene whose answer carries a key anywhere stores none of it', () => {
    const raw = clone(DETAILS.s0);
    raw.groups[0].group.name = 'http://127.0.0.1:9999/group/1?apikey=SAMPLEKEY';
    raw.last_played_at = '2026-11-17T21:45:00Z?apikey=SAMPLEKEY';
    const out = mapScene(raw, { now: NOW });
    expect(findApiKeyStrings(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('SAMPLEKEY');
    expect(out.scene.groups.map((g) => g.id)).toEqual(['2']);
  });
});

describe('Stash\'s tag list (aliases, parents)', () => {
  it('maps the six test tags with their aliases and parents', () => {
    const page = mapTagPage(TAGS);
    expect(page.count).toBe(6);
    expect(page.dropped).toBe(0);
    expect(page.tags.find((t) => t.id === '2')).toEqual({ id: '2', name: 'Synthetic Tag B', aliases: ['synthetic-child'], parentIds: ['3'] });
    expect(page.tags.find((t) => t.id === '3')).toEqual({ id: '3', name: 'Synthetic Parent Tag', aliases: ['synthetic-parent'], parentIds: ['5'] });
    expect(page.tags.find((t) => t.id === '5').aliases).toEqual(['syn-gp', 'synthetic-grand']);
  });

  it('a bad tag is dropped and counted (the list cannot pass as complete); a bad alias or parent is left out', () => {
    const page = mapTagPage({
      count: 3,
      tags: [
        { id: '1', name: 'Ok', aliases: ['ok', 'x'.repeat(201), 'Fine', 'fine', 7, 'k?apikey=1'], parents: [{ id: '1' }, { id: '../2' }, { id: '2' }, { id: '2' }] },
        { id: '__proto__', name: 'Bad' },
        { id: '3', name: '' },
      ],
    });
    expect(page.tags).toEqual([{ id: '1', name: 'Ok', aliases: ['Fine'], parentIds: ['2'] }]);
    // sn-fixup: a readable id with an unusable name is skipped (its id
    // counts), only the unreadable id is dropped.
    expect(page.dropped).toBe(1);
    expect(page.skipped).toEqual(['3']);
    expect(tagListComplete({ allPagesFetched: true, firstCount: 3, lastCount: 3, tags: page.tags, dropped: page.dropped, skipped: page.skipped })).toBe(false);
    const whole = mapTagPage(TAGS);
    expect(tagListComplete({ allPagesFetched: true, firstCount: 6, lastCount: 6, tags: whole.tags })).toBe(true);
    expect(tagListComplete({ allPagesFetched: false, firstCount: 6, lastCount: 6, tags: whole.tags })).toBe(false);
    expect(tagListComplete({ allPagesFetched: true, firstCount: 6, lastCount: 7, tags: whole.tags })).toBe(false);
    expect(mapTagPage(null)).toEqual({ count: null, tags: [], dropped: 0, skipped: [] });
  });

  it('at most 50 aliases and 50 parents per tag', () => {
    const t = mapTagPage({ count: 1, tags: [{ id: '1', name: 'T', aliases: Array.from({ length: 80 }, (_, i) => `a${i}`), parents: Array.from({ length: 80 }, (_, i) => ({ id: String(i + 2) })) }] }).tags[0];
    expect(t.aliases).toHaveLength(LIMITS.aliasesPerTag);
    expect(t.parentIds).toHaveLength(LIMITS.parentsPerTag);
  });
});
