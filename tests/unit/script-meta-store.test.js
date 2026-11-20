/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The funscript metadata store (P1 tags, Round 3, 2026-11-18):
// renderer/js/script-meta-store.js keeps the backend's harvest (each paired
// script's own metadata block) as the tag engine's `funscript` source. The
// fake below answers what GET /api/media/script-meta answers (through main's
// get-script-meta IPC); what is asserted is the map the library filter, the
// dialog and the phone slice read, its version and its change events.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  scriptMetaMap, getScriptMeta, scriptMetaVersion, onScriptMetaChanged, refreshScriptMeta,
  _resetScriptMetaStoreForTests, _setScriptMetaFetcherForTests,
} from '../../renderer/js/script-meta-store.js';
import { funscriptMetaRecord, effectiveTags } from '../../renderer/js/video-tags.js';

const A = 'C:/Library/Scene A.funscript';
const B = 'C:/Library/Scene B.funscript';
const META_A = { creator: 'Scripter One', tags: ['POV', 'Blowjob'], script_url: 'https://discuss.eroscripts.com/t/scene-a/101' };
const META_B = { tags: ['VR'] };

/** A backend that answers from a script of answers; records every question. */
function fakeBackend(answers) {
  const asked = [];
  const fn = vi.fn(async (query) => {
    asked.push(query);
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(query) : next;
  });
  _setScriptMetaFetcherForTests(fn, async () => {});
  return { asked, fn };
}

const answer = (records, extra = {}) => ({ records, pending: 0, registered: 3, cacheId: 'c0ffee', seq: 5, ...extra });

beforeEach(() => { _resetScriptMetaStoreForTests(); });

describe('before any harvest', () => {
  it('the map is empty, frozen and never null', () => {
    expect(scriptMetaMap()).toEqual({});
    expect(Object.isFrozen(scriptMetaMap())).toBe(true);
    expect(scriptMetaVersion()).toBe(0);
  });
});

describe('refreshScriptMeta: the harvest after a scan', () => {
  it('builds each record with funscriptMetaRecord, bumps the version, tells listeners', async () => {
    fakeBackend([answer({ [A]: { metadata: META_A, readAt: 1000, topicId: 101 } })]);
    const heard = vi.fn();
    onScriptMetaChanged(heard);
    await refreshScriptMeta();
    expect(scriptMetaMap()[A]).toEqual(funscriptMetaRecord(META_A, 1000));
    expect(scriptMetaMap()[A].topicId).toBe(101);
    expect(scriptMetaVersion()).toBe(1);
    expect(heard).toHaveBeenCalledTimes(1);
    // Frozen all the way: a reader cannot change what the next reader sees.
    expect(Object.isFrozen(scriptMetaMap())).toBe(true);
    expect(Object.isFrozen(scriptMetaMap()[A].tags)).toBe(true);
  });

  it('the record feeds effectiveTags as the funscript source', async () => {
    fakeBackend([answer({ [A]: { metadata: META_A, readAt: 1 } })]);
    await refreshScriptMeta();
    const tags = effectiveTags('C:/Library/Scene A.mp4', { funscript: scriptMetaMap() }, { scriptPath: A });
    expect(tags.map((t) => t.key)).toEqual(['content:blowjob', 'content:pov', 'creator:scripter-one']);
    expect(tags.every((t) => t.sources.includes('funscript'))).toBe(true);
  });

  it('keeps asking while the backend pass is pending, then only for what changed', async () => {
    const { asked } = fakeBackend([
      answer({ [A]: { metadata: META_A, readAt: 1 } }, { pending: 1, seq: 1 }),
      answer({ [B]: { metadata: META_B, readAt: 2 } }, { pending: 0, seq: 2 }),
    ]);
    await refreshScriptMeta();
    expect(asked).toEqual([{}, { since: 1, cache: 'c0ffee' }]);
    expect(Object.keys(scriptMetaMap()).sort()).toEqual([A, B]);
    expect(scriptMetaVersion()).toBe(2);
  });

  it('keeps asking while the backend has no library yet', async () => {
    const { asked } = fakeBackend([
      answer({}, { registered: 0 }),
      answer({ [A]: { metadata: META_A, readAt: 1 } }),
    ]);
    await refreshScriptMeta();
    expect(asked).toHaveLength(2);
    expect(scriptMetaMap()[A]).toBeTruthy();
  });

  it('an answer that changes nothing does not bump the version or notify', async () => {
    fakeBackend([answer({ [A]: { metadata: META_A, readAt: 1 } })]);
    await refreshScriptMeta();
    const heard = vi.fn();
    onScriptMetaChanged(heard);
    const before = scriptMetaMap();
    await refreshScriptMeta();
    expect(scriptMetaVersion()).toBe(1);
    expect(heard).not.toHaveBeenCalled();
    expect(scriptMetaMap()).toBe(before);
  });

  it('a call while the loop runs makes it ask once more, not start a second loop', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { asked } = fakeBackend([
      async () => { await gate; return answer({ [A]: { metadata: META_A, readAt: 1 } }); },
      answer({ [B]: { metadata: META_B, readAt: 2 } }),
    ]);
    const first = refreshScriptMeta();
    const second = refreshScriptMeta();          // a new scan landed meanwhile
    expect(second).toBe(first);
    release();
    await first;
    expect(asked).toHaveLength(2);
    expect(Object.keys(scriptMetaMap()).sort()).toEqual([A, B]);
  });
});

describe('absence is never destructive', () => {
  async function seeded() {
    fakeBackend([answer({ [A]: { metadata: META_A, readAt: 1 }, [B]: { metadata: META_B, readAt: 1 } })]);
    await refreshScriptMeta();
    return scriptMetaMap();
  }

  it('a backend that does not answer changes nothing', async () => {
    const before = await seeded();
    for (const failure of [null, undefined, { nope: 1 }, new Error('backend down')]) {
      fakeBackend([failure]);
      await refreshScriptMeta();
      expect(scriptMetaMap()).toBe(before);
    }
    expect(scriptMetaVersion()).toBe(1);
  });

  it('a script the answer does not mention keeps its record', async () => {
    await seeded();
    fakeBackend([answer({ [B]: { metadata: { tags: ['VR', 'Futa'] }, readAt: 9 } })]);
    await refreshScriptMeta();
    expect(scriptMetaMap()[A]).toEqual(funscriptMetaRecord(META_A, 1));
    expect(scriptMetaMap()[B].tags).toEqual(['VR', 'Futa']);
  });

  it('only the backend\'s word that the file was READ and has nothing removes a record', async () => {
    await seeded();
    // A record without `metadata` says nothing about the file: kept.
    fakeBackend([answer({ [A]: { readAt: 5 }, [B]: 'junk' })]);
    await refreshScriptMeta();
    expect(Object.keys(scriptMetaMap()).sort()).toEqual([A, B]);
    // `metadata: null` (read, no block) and `{}` (read, nothing usable): gone.
    fakeBackend([answer({ [A]: { metadata: null, readAt: 6 }, [B]: { metadata: {}, readAt: 6 } })]);
    await refreshScriptMeta();
    expect(scriptMetaMap()).toEqual({});
  });
});

describe('getScriptMeta: one script, for the video options dialog', () => {
  it('asks for that path and returns its record', async () => {
    const { asked } = fakeBackend([answer({ [A]: { metadata: META_A, readAt: 3 } })]);
    const record = await getScriptMeta(A);
    expect(asked).toEqual([{ paths: [A] }]);
    expect(record).toEqual(funscriptMetaRecord(META_A, 3));
    expect(scriptMetaMap()[A]).toBe(record);
  });

  it('falls back to the map when the backend does not answer, and null when unknown', async () => {
    fakeBackend([answer({ [A]: { metadata: META_A, readAt: 3 } })]);
    await refreshScriptMeta();
    fakeBackend([new Error('down')]);
    expect(await getScriptMeta(A)).toEqual(funscriptMetaRecord(META_A, 3));
    expect(await getScriptMeta(B)).toBeNull();
    expect(await getScriptMeta('')).toBeNull();
    expect(await getScriptMeta(null)).toBeNull();
  });

  it('only that path is taken from the answer, and the "what changed" mark does not move', async () => {
    const { asked } = fakeBackend([
      answer({ [A]: { metadata: META_A, readAt: 3 }, [B]: { metadata: META_B, readAt: 3 } }, { seq: 99 }),
      answer({}, { seq: 7 }),
    ]);
    await getScriptMeta(A);
    expect(Object.keys(scriptMetaMap())).toEqual([A]);
    await refreshScriptMeta();
    expect(asked.at(-1)).toEqual({});            // a whole answer, not "since 99"
  });
});

describe('listeners', () => {
  it('unsubscribe stops the calls, and a listener that throws does not stop the others', async () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onScriptMetaChanged(bad);
    const off = onScriptMetaChanged(good);
    fakeBackend([answer({ [A]: { metadata: META_A, readAt: 1 } })]);
    await refreshScriptMeta();
    expect(good).toHaveBeenCalledTimes(1);
    off();
    fakeBackend([answer({ [B]: { metadata: META_B, readAt: 1 } })]);
    await refreshScriptMeta();
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(onScriptMetaChanged(null)).toBeTypeOf('function');
    warn.mockRestore();
  });
});
