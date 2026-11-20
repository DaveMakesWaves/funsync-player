/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash scene markers as seek-bar chapters (Stash S1, Dave's answer 3;
// DESIGN-stash-s1.md (j) row 1): which markers the playing video gets.
// The data is shaped as main's projection is (stage s1-2a-main: scene ids
// are opaque, raw for the data's own server, `<id>@<server-key>` for any
// other server, references alike).
import { describe, it, expect } from 'vitest';
import { stashMarkersForVideo, chapterStarts } from '../../renderer/js/stash-markers.js';

const SERVER = 'http://127.0.0.1:9999';
const OTHER = 'http://192.168.1.20:9999';
const V = 'C:\\Lib\\Alpha Scene.mp4';
const W = 'C:\\Lib\\Bravo Take.mp4';

function data(overrides = {}) {
  return {
    v: 1, rev: 3, server: { url: SERVER, version: 'v0.32.0' }, lastSync: { at: 1, kind: 'full', ok: true },
    links: {
      [V]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 5, oshash: 'aaaa' }, linkedAt: 2, state: 'ok' },
      // Linked while FunSync pointed at another Stash: that server's scene 1.
      [W]: { sceneId: `1@${OTHER}`, server: OTHER, by: 'oshash', fp: { size: 2000, mtimeMs: 5, oshash: 'bbbb' }, linkedAt: 2, state: 'ok' },
    },
    check: {}, refused: {},
    scenes: {
      1: {
        id: '1', title: 'Synthetic Scene Small', tagIds: [], performerIds: [], files: [],
        markers: [
          { id: '8', title: 'Second', seconds: 4.25, endSeconds: null, tag: { name: 'Synthetic Tag B' } },
          { id: '7', title: 'Synthetic marker one', seconds: 1, endSeconds: 3.5, tag: 'Synthetic Tag A' },
          { id: '9', title: '', seconds: 6, endSeconds: 6, tag: { name: 'Untitled marker tag' } },
        ],
      },
      [`1@${OTHER}`]: {
        id: `1@${OTHER}`, title: 'The other Stash\'s scene 1', tagIds: [], performerIds: [], files: [],
        markers: [{ id: '50', title: 'From the other Stash', seconds: 10, endSeconds: null, tag: null }],
      },
    },
    performers: {}, studios: {}, tags: {},
    ...overrides,
  };
}

describe('stashMarkersForVideo', () => {
  it('a linked video gets its scene\'s markers as ms, sorted, with a title (or the main tag\'s name)', () => {
    expect(stashMarkersForVideo(data(), V, { size: 1000, enabled: true })).toEqual([
      { startMs: 1000, endMs: 3500, title: 'Synthetic marker one' },
      { startMs: 4250, endMs: null, title: 'Second' },
      // An end equal to the start is a point marker; no title: its tag's name.
      { startMs: 6000, endMs: null, title: 'Untitled marker tag' },
    ]);
  });

  it('only the linked server\'s scene: a video linked on another Stash gets THAT scene\'s markers', () => {
    expect(stashMarkersForVideo(data(), W, { size: 2000, enabled: true }))
      .toEqual([{ startMs: 10000, endMs: null, title: 'From the other Stash' }]);
  });

  it('a link pointing at an id the data does not hold gets nothing (no other scene stands in)', () => {
    const d = data();
    d.links[W] = { ...d.links[W], sceneId: `2@${OTHER}` };
    d.scenes[2] = { id: '2', title: 'This server\'s scene 2', markers: [{ id: '1', title: 'wrong', seconds: 1 }] };
    expect(stashMarkersForVideo(d, W, { size: 2000, enabled: true })).toEqual([]);
  });

  it('every view filters by the linked server: a stored scene naming another server is not this link\'s', () => {
    const d = data();
    d.scenes[1] = { ...d.scenes[1], server: OTHER };          // same id, another server
    expect(stashMarkersForVideo(d, V, { size: 1000, enabled: true })).toEqual([]);
    d.scenes[1] = { ...d.scenes[1], server: `${SERVER.toUpperCase()}/` }; // the same server, written otherwise
    expect(stashMarkersForVideo(d, V, { size: 1000, enabled: true })).toHaveLength(3);
  });

  it('Stash off (or never set up): no markers', () => {
    expect(stashMarkersForVideo(data(), V, { size: 1000, enabled: false })).toEqual([]);
    expect(stashMarkersForVideo(data(), V, { size: 1000 })).toEqual([]);
    expect(stashMarkersForVideo(data(), V, { size: 1000, enabled: 'true' })).toEqual([]);
  });

  it('the trust check: a file whose size changed since the match shows none of the old file\'s markers', () => {
    expect(stashMarkersForVideo(data(), V, { size: 999, enabled: true })).toEqual([]);
    // Unknown size: trusted (as the tags).
    expect(stashMarkersForVideo(data(), V, { enabled: true })).toHaveLength(3);
  });

  it('a link the sync marked changed shows none; a gone scene keeps its markers (its data is kept)', () => {
    const changed = data();
    changed.links[V] = { ...changed.links[V], state: 'changed' };
    expect(stashMarkersForVideo(changed, V, { size: 1000, enabled: true })).toEqual([]);
    const gone = data();
    gone.links[V] = { ...gone.links[V], state: 'gone' };
    expect(stashMarkersForVideo(gone, V, { size: 1000, enabled: true })).toHaveLength(3);
  });

  it('no link (not in Stash, a check, a refusal), an unknown path or empty data: nothing', () => {
    const d = data({ check: { 'C:\\Lib\\C.mp4': { kind: 'several', sceneIds: ['1'] } } });
    expect(stashMarkersForVideo(d, 'C:\\Lib\\C.mp4', { enabled: true })).toEqual([]);
    expect(stashMarkersForVideo(d, 'C:\\Lib\\Nope.mp4', { enabled: true })).toEqual([]);
    expect(stashMarkersForVideo({}, V, { enabled: true })).toEqual([]);
    expect(stashMarkersForVideo(null, V, { enabled: true })).toEqual([]);
    expect(stashMarkersForVideo(data(), '', { enabled: true })).toEqual([]);
  });

  it('bad marker times are left out, never guessed', () => {
    const d = data();
    d.scenes[1] = { ...d.scenes[1], markers: [{ title: 'neg', seconds: -1 }, { title: 'nan', seconds: 'x' }, { title: 'ok', seconds: 2, endSeconds: 1 }] };
    expect(stashMarkersForVideo(d, V, { size: 1000, enabled: true })).toEqual([{ startMs: 2000, endMs: null, title: 'ok' }]);
  });

  it('the list and its entries are frozen (the seek bar copies what it keeps)', () => {
    const out = stashMarkersForVideo(data(), V, { size: 1000, enabled: true });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
  });
});

describe('chapterStarts: the player\'s previous / next chapter keys see both kinds', () => {
  it('the script\'s chapters and Stash\'s markers together, sorted, one entry per start', () => {
    expect(chapterStarts(
      [{ startMs: 0, endMs: 5000 }, { startMs: 5000, endMs: 9000 }],
      [{ startMs: 1000 }, { startMs: 5000 }, { startMs: 12000 }],
    )).toEqual([{ startMs: 0 }, { startMs: 1000 }, { startMs: 5000 }, { startMs: 12000 }]);
  });

  it('either list missing is fine', () => {
    expect(chapterStarts(null, [{ startMs: 3 }])).toEqual([{ startMs: 3 }]);
    expect(chapterStarts([{ startMs: 3 }], undefined)).toEqual([{ startMs: 3 }]);
    expect(chapterStarts()).toEqual([]);
  });
});
