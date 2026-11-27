/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The saved metadata block (editor work list 5.3, 2026-11-24): what
// toFunscriptJSON writes is OpenFunscripter's block (OFS-lib Funscript.h
// struct Metadata), and nothing the file already had is lost or changed,
// top level or inside metadata, unknown keys included. The combined
// funscript 2.0 file built from it keeps its shape.
import { describe, it, expect } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';
import { buildCombinedFunscript, buildSeparateFunscripts } from '../../renderer/js/combined-funscript.js';
import { streamCutWarning } from '../../renderer/js/stream-session.js';

const OFS_KEYS = ['creator', 'description', 'duration', 'license', 'notes', 'performers', 'script_url', 'tags', 'title', 'type', 'video_url'];

const saved = (es) => JSON.parse(es.toFunscriptJSON());
function loaded(file) {
  const es = new EditableScript();
  es.loadFromData(JSON.parse(JSON.stringify(file)));
  return es;
}

describe('a file with no metadata block gets OFS\'s whole block', () => {
  it('every OFS key with OFS\'s empty default, in OFS\'s (alphabetical) order', () => {
    const out = saved(loaded({ actions: [{ at: 0, pos: 0 }, { at: 61500, pos: 100 }] }));
    expect(Object.keys(out.metadata)).toEqual(OFS_KEYS);
    expect(out.metadata).toEqual({
      creator: '', description: '', duration: 0, license: '', notes: '', performers: [],
      script_url: '', tags: [], title: '', type: 'basic', video_url: '',
    });
  });

  it('a new script (loadEmpty) and a cleared one get it too', () => {
    const es = new EditableScript();
    es.loadEmpty();
    es.insertAction(100, 50);
    expect(Object.keys(saved(es).metadata)).toEqual(OFS_KEYS);
    es.clear();
    expect(saved(es).metadata.type).toBe('basic');
  });

  it('the title is not taken from anything: OFS writes "" until the user types one', () => {
    expect(saved(loaded({ actions: [] })).metadata.title).toBe('');
  });
});

describe('what the file had is kept', () => {
  const FILE = {
    version: '1.1',
    inverted: true,
    range: 90,
    someTool: { x: 1 },                                    // unknown top-level key
    metadata: {
      title: 'Clip',
      creator: 'someone',
      tags: ['slow'],
      performers: 'not-an-array',                          // a value of another type: kept as it is
      duration: 754,
      custom: { nested: [1, 2] },                          // unknown metadata key
      chapters: [{ name: 'A', startTime: '00:00:01.000', endTime: '00:00:02.000' }],
    },
    actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }],
  };

  it('every top-level and metadata key and value, adding only the missing OFS keys', () => {
    const out = saved(loaded(FILE));
    expect(out.version).toBe('1.1');
    expect(out.inverted).toBe(true);
    expect(out.range).toBe(90);
    expect(out.someTool).toEqual({ x: 1 });
    expect(Object.keys(out).sort()).toEqual(Object.keys(FILE).sort());
    for (const [k, v] of Object.entries(FILE.metadata)) expect(out.metadata[k], k).toEqual(v);
    // Missing OFS keys added after the file's own, with OFS's defaults.
    expect(out.metadata).toMatchObject({ description: '', license: '', notes: '', script_url: '', type: 'basic', video_url: '' });
    expect(Object.keys(out.metadata).slice(0, Object.keys(FILE.metadata).length)).toEqual(Object.keys(FILE.metadata));
  });

  it('a type the file already set is not reset to "basic"', () => {
    const out = saved(loaded({ metadata: { type: 'custom' }, actions: [] }));
    expect(out.metadata.type).toBe('custom');
  });

  it('a metadata value that is not an object is written back untouched', () => {
    expect(saved(loaded({ metadata: 'hello', actions: [] })).metadata).toBe('hello');
    expect(saved(loaded({ metadata: [1, 2], actions: [] })).metadata).toEqual([1, 2]);
  });

  it('the block lives in the file, not in the editor: getMetadata and undo snapshots stay the file\'s', () => {
    const es = loaded({ actions: [{ at: 0, pos: 0 }] });
    es.toFunscriptJSON();
    expect(es.getMetadata()).toEqual({});
  });

  it('bookmarks still go in the block, and out of it when there are none', () => {
    const es = loaded({ metadata: { title: 'T', bookmarks: [{ at: 1000, name: 'b' }] }, actions: [] });
    expect(saved(es).metadata.bookmarks).toEqual([{ at: 1000, name: 'b' }]);
    es.removeBookmark(1000);
    expect('bookmarks' in saved(es).metadata).toBe(false);
    expect(saved(es).metadata.title).toBe('T');
  });

  it('the override argument gets the same treatment', () => {
    const es = loaded({ actions: [{ at: 0, pos: 0 }] });
    const out = JSON.parse(es.toFunscriptJSON({ version: '3.0', metadata: { creator: 'me' } }));
    expect(out.version).toBe('3.0');
    expect(out.metadata.creator).toBe('me');
    expect(out.metadata.type).toBe('basic');
  });
});

describe('duration', () => {
  it('the video length in whole seconds, as OFS writes it (truncated), replacing the file\'s', () => {
    const es = loaded({ metadata: { duration: 12 }, actions: [{ at: 0, pos: 0 }] });
    es.setVideoDuration(754_999);                 // 754.999 s
    expect(saved(es).metadata.duration).toBe(754);
  });

  it('unknown video length: the file\'s own value stays; none: 0 (OFS\'s default)', () => {
    expect(saved(loaded({ metadata: { duration: 300 }, actions: [] })).metadata.duration).toBe(300);
    expect(saved(loaded({ actions: [{ at: 0, pos: 0 }, { at: 90_000, pos: 100 }] })).metadata.duration).toBe(0);
  });

  it('never the last point\'s time: that would warn "another cut" on the next stream of this very video', () => {
    // A script that ends 40 s before its 10-minute video, saved with the
    // video length unknown, then streamed with the same video.
    const es = loaded({ actions: [{ at: 0, pos: 0 }, { at: 560_000, pos: 100 }] });
    const out = saved(es);
    expect(streamCutWarning({ scriptEndMs: 560_000, metaDurationS: out.metadata.duration, videoDurationS: 600 })).toBeNull();
  });

  it('setVideoDuration: junk or 0 means unknown; it survives loads and axis switches (it is the video\'s)', () => {
    const es = new EditableScript();
    es.setVideoDuration(-5);
    expect(es.videoDurationMs).toBe(0);
    es.setVideoDuration('x');
    expect(es.videoDurationMs).toBe(0);
    es.setVideoDuration(90_000);
    es.loadFromData({ actions: [] });
    es.importState(es.exportState());
    expect(saved(es).metadata.duration).toBe(90);
    es.setVideoDuration(0);
    expect(saved(es).metadata.duration).toBe(0);
  });
});

describe('the combined funscript 2.0 file keeps its shape', () => {
  it('root actions = stroke, channels + axes mirror, metadata carried once', () => {
    const es = loaded({ metadata: { title: 'Clip' }, actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });
    es.setVideoDuration(60_000);
    const main = saved(es);
    const out = buildCombinedFunscript(main, { twist: [{ at: 0, pos: 50 }, { at: 400, pos: 80 }] });
    expect(out.version).toBe('2.0');
    expect(out.actions).toEqual([{ at: 0, pos: 0 }, { at: 500, pos: 100 }]);
    expect(out.channels).toEqual({ twist: { actions: [{ at: 0, pos: 50 }, { at: 400, pos: 80 }] } });
    expect(out.axes).toEqual([{ id: 'R0', actions: [{ at: 0, pos: 50 }, { at: 400, pos: 80 }] }]);
    expect(out.metadata).toEqual(main.metadata);
    expect(out.metadata.duration).toBe(60);
    expect(Object.keys(out).sort()).toEqual(['actions', 'axes', 'channels', 'metadata', 'version']);
  });

  it('separate files: each axis file takes the same OFS block (as OFS writes one into every axis)', () => {
    const main = saved(loaded({ metadata: { creator: 'me' }, actions: [{ at: 0, pos: 0 }] }));
    const files = buildSeparateFunscripts(main, { twist: [{ at: 0, pos: 50 }] }, 'clip');
    expect(files.map((f) => f.name)).toEqual(['clip.funscript', 'clip.twist.funscript']);
    expect(files[1].content.metadata).toEqual(main.metadata);
    expect(files[0].content.version).toBe('1.0');
  });
});
