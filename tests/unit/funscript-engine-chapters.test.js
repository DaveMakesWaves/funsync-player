// Tests for chapter + bookmark parsing in FunscriptEngine.
// SCOPE: notes/features/SCOPE-chapters-bookmarks.md §6 edge cases.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunscriptEngine } from '../../renderer/js/funscript-engine.js';

// Stub the backend CSV conversion — these tests don't care about it.
beforeEach(() => {
  if (!window.funsync) window.funsync = {};
  window.funsync.convertFunscript = vi.fn().mockResolvedValue({
    local_url: 'file://stub.csv', hash: 'stub', size_bytes: 0,
  });
});

function makeEngine() {
  return new FunscriptEngine({ backendPort: 5123 });
}

async function loadJSON(engine, obj) {
  return engine.loadContent(JSON.stringify(obj), 'test.funscript');
}

const MINIMAL_ACTIONS = [{ at: 100, pos: 50 }, { at: 200, pos: 75 }];

describe('FunscriptEngine — bookmark parsing', () => {
  it('C-E1: returns [] when metadata field is absent', async () => {
    const e = makeEngine();
    await loadJSON(e, { actions: MINIMAL_ACTIONS });
    expect(e.getBookmarks()).toEqual([]);
  });

  it('C-E2: returns [] when metadata.bookmarks is empty', async () => {
    const e = makeEngine();
    await loadJSON(e, { actions: MINIMAL_ACTIONS, metadata: { bookmarks: [] } });
    expect(e.getBookmarks()).toEqual([]);
  });

  it('C-E3: parses { at: <number>, name } shape', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [{ at: 12345, name: 'Intro ends' }] },
    });
    expect(e.getBookmarks()).toEqual([{ at: 12345, name: 'Intro ends' }]);
  });

  it('C-E4: parses { time: "HH:MM:SS.mmm", name } shape (MFP)', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [{ time: '00:00:42.500', name: 'Beat drop' }] },
    });
    expect(e.getBookmarks()).toEqual([{ at: 42500, name: 'Beat drop' }]);
  });

  it('C-E5: mixed shapes in same array normalised together', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [
        { at: 5000, name: 'A' },
        { time: '00:00:10.000', name: 'B' },
      ] },
    });
    expect(e.getBookmarks()).toEqual([
      { at: 5000, name: 'A' },
      { at: 10000, name: 'B' },
    ]);
  });

  it('C-E7: malformed time string drops the entry', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [
        { time: 'not-a-time', name: 'bad' },
        { at: 5000, name: 'good' },
      ] },
    });
    expect(e.getBookmarks()).toEqual([{ at: 5000, name: 'good' }]);
  });

  it('C-E8: missing name → empty string', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [{ at: 1000 }] },
    });
    expect(e.getBookmarks()).toEqual([{ at: 1000, name: '' }]);
  });

  it('C-E9: out-of-order bookmarks sorted by at', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [
        { at: 5000, name: 'C' },
        { at: 1000, name: 'A' },
        { at: 3000, name: 'B' },
      ] },
    });
    expect(e.getBookmarks().map((b) => b.name)).toEqual(['A', 'B', 'C']);
  });

  it('C-E10: negative at value dropped', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { bookmarks: [
        { at: -100, name: 'bad' },
        { at: 1000, name: 'good' },
      ] },
    });
    expect(e.getBookmarks()).toEqual([{ at: 1000, name: 'good' }]);
  });

  it('accepts top-level bookmarks (some scripts inline them)', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      bookmarks: [{ at: 5000, name: 'X' }],
    });
    expect(e.getBookmarks()).toEqual([{ at: 5000, name: 'X' }]);
  });
});

describe('FunscriptEngine — chapter parsing', () => {
  it('returns [] when no chapters', async () => {
    const e = makeEngine();
    await loadJSON(e, { actions: MINIMAL_ACTIONS });
    expect(e.getChapters()).toEqual([]);
  });

  it('parses number startTime/endTime', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'Scene 1', startTime: 0, endTime: 60000, color: '#ff8800' },
      ] },
    });
    expect(e.getChapters()).toEqual([
      { startMs: 0, endMs: 60000, name: 'Scene 1', color: '#ff8800' },
    ]);
  });

  it('parses TimeSpan startTime/endTime', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'Scene 2', startTime: '00:01:00.000', endTime: '00:02:30.500' },
      ] },
    });
    const out = e.getChapters();
    expect(out.length).toBe(1);
    expect(out[0].startMs).toBe(60000);
    expect(out[0].endMs).toBe(150500);
  });

  it('C-E11: drops reversed chapters (endMs < startMs)', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'Reversed', startTime: 60000, endTime: 10000 },
        { name: 'Good', startTime: 0, endTime: 30000 },
      ] },
    });
    expect(e.getChapters().map((c) => c.name)).toEqual(['Good']);
  });

  it('C-E12: zero-width chapter accepted', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'Marker', startTime: 5000, endTime: 5000 },
      ] },
    });
    expect(e.getChapters()).toEqual([
      expect.objectContaining({ startMs: 5000, endMs: 5000, name: 'Marker' }),
    ]);
  });

  it('C-E15: accepts Commonwealth `colour` spelling as alias', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'X', startTime: 0, endTime: 1000, colour: '#abcdef' },
      ] },
    });
    expect(e.getChapters()[0].color).toBe('#abcdef');
  });

  it('C-E16: auto-assigns from palette when no color provided', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'A', startTime: 0, endTime: 1000 },
        { name: 'B', startTime: 1000, endTime: 2000 },
      ] },
    });
    const out = e.getChapters();
    expect(out[0].color).toBeTruthy();
    expect(out[1].color).toBeTruthy();
    expect(out[0].color).not.toBe(out[1].color);  // different indices → different colors
  });

  it('sorts chapters by startMs', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [
        { name: 'C', startTime: 4000, endTime: 5000 },
        { name: 'A', startTime: 0, endTime: 1000 },
        { name: 'B', startTime: 2000, endTime: 3000 },
      ] },
    });
    expect(e.getChapters().map((c) => c.name)).toEqual(['A', 'B', 'C']);
  });

  it('accepts top-level chapters key', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      chapters: [{ name: 'X', startTime: 0, endTime: 1000 }],
    });
    expect(e.getChapters().length).toBe(1);
  });

  it('missing name → empty string', async () => {
    const e = makeEngine();
    await loadJSON(e, {
      actions: MINIMAL_ACTIONS,
      metadata: { chapters: [{ startTime: 0, endTime: 1000 }] },
    });
    expect(e.getChapters()[0].name).toBe('');
  });
});
