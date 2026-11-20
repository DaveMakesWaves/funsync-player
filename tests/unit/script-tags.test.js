// Recording the EroScripts tags of the post a video's script came from.
//
// Storage only — nothing displays these yet (Dave, 2026-08-06). Tag values
// below are real ones from discuss.eroscripts.com.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SCRIPT_TAGS_KEY,
  makeScriptTagRecord,
  recordScriptTags,
  getScriptTags,
} from '../../renderer/js/script-tags.js';

const TOPIC = {
  id: 75758,
  title: '[vESP] Izzy Green POV Onlyfans Blowjob [Multi-Axis]',
  url: 'https://discuss.eroscripts.com/t/vesp-izzy-green/75758',
  tags: ['osr2', 'multi-axis', 'blowjob', 'non-vr', 'len-2-5'],
};

function makeSettings(initial = {}) {
  const store = { ...initial };
  return { get: (k) => store[k], set: (k, v) => { store[k] = v; }, _store: store };
}

describe('makeScriptTagRecord', () => {
  it('captures the tags plus enough provenance to link back', () => {
    // Record v2 (video options, 2026-11-18): title, creator, the script the
    // tags describe, how the post was found, when its JSON was read, stale.
    expect(makeScriptTagRecord(TOPIC, 1754400000000)).toEqual({
      tags: ['osr2', 'multi-axis', 'blowjob', 'non-vr', 'len-2-5'],
      topicId: 75758,
      topicUrl: 'https://discuss.eroscripts.com/t/vesp-izzy-green/75758',
      title: '[vESP] Izzy Green POV Onlyfans Blowjob [Multi-Axis]',
      creator: null,
      scriptPath: null,
      match: 'download',
      source: 'eroscripts',
      savedAt: 1754400000000,
      fetchedAt: null,
      stale: false,
    });
  });

  it('records an EMPTY tag list rather than nothing', () => {
    // "This post has no tags" is a real answer, and has to be
    // distinguishable from "never downloaded from EroScripts".
    const record = makeScriptTagRecord({ id: 1, tags: [] }, 5);
    expect(record.tags).toEqual([]);
    expect(record.topicId).toBe(1);
  });

  it('returns null without a topic id — nothing to attribute', () => {
    expect(makeScriptTagRecord(null, 1)).toBeNull();
    expect(makeScriptTagRecord({ tags: ['osr2'] }, 1)).toBeNull();
  });

  it('drops blanks and duplicates', () => {
    const record = makeScriptTagRecord({ id: 1, tags: ['vr', '', 'vr', '  ', null, 'sr6'] }, 1);
    expect(record.tags).toEqual(['vr', 'sr6']);
  });

  it('makes no record when the tags are unknown (missing, null or malformed)', () => {
    // FT-066: this used to coerce a missing field to [] and store "this post
    // has no tags" — for posts whose tags the search simply didn't send.
    // (Rewritten: the old test pinned that coercion as correct.)
    expect(makeScriptTagRecord({ id: 1 }, 1)).toBeNull();
    expect(makeScriptTagRecord({ id: 1, tags: null }, 1)).toBeNull();
    expect(makeScriptTagRecord({ id: 1, tags: 'osr2' }, 1)).toBeNull();
  });
});

describe('recordScriptTags', () => {
  let settings;

  beforeEach(() => { settings = makeSettings(); });

  it('files the record under the video path', () => {
    expect(recordScriptTags(settings, 'D:/v/Clip.mp4', TOPIC, 7)).toBe(true);
    expect(getScriptTags(settings, 'D:/v/Clip.mp4').tags).toContain('multi-axis');
  });

  it('leaves other videos untouched', () => {
    recordScriptTags(settings, 'D:/v/A.mp4', TOPIC, 1);
    recordScriptTags(settings, 'D:/v/B.mp4', { id: 2, tags: ['vr'] }, 2);
    expect(getScriptTags(settings, 'D:/v/A.mp4').topicId).toBe(75758);
    expect(getScriptTags(settings, 'D:/v/B.mp4').topicId).toBe(2);
  });

  it('replaces rather than merging when a video gets a new script', () => {
    // Union-ing tags from two different posts would describe neither.
    recordScriptTags(settings, 'D:/v/Clip.mp4', TOPIC, 1);
    recordScriptTags(settings, 'D:/v/Clip.mp4', { id: 999, tags: ['vr', 'sr6'] }, 2);
    const record = getScriptTags(settings, 'D:/v/Clip.mp4');
    expect(record.tags).toEqual(['vr', 'sr6']);
    expect(record.topicId).toBe(999);
  });

  it('writes through the documented store key', () => {
    recordScriptTags(settings, 'D:/v/Clip.mp4', TOPIC, 1);
    expect(Object.keys(settings._store)).toEqual([SCRIPT_TAGS_KEY]);
  });

  it('writes nothing without a usable video path or topic', () => {
    expect(recordScriptTags(settings, '', TOPIC, 1)).toBe(false);
    expect(recordScriptTags(settings, 'D:/v/Clip.mp4', null, 1)).toBe(false);
    expect(recordScriptTags(null, 'D:/v/Clip.mp4', TOPIC, 1)).toBe(false);
    expect(settings._store[SCRIPT_TAGS_KEY]).toBeUndefined();
  });

  it('unknown tags never write, and never overwrite a good record (FT-066)', () => {
    recordScriptTags(settings, 'D:/v/Clip.mp4', TOPIC, 1);
    const before = getScriptTags(settings, 'D:/v/Clip.mp4');

    // A later download whose search result carried no tags (null).
    expect(recordScriptTags(settings, 'D:/v/Clip.mp4', { id: 999, tags: null }, 2)).toBe(false);
    expect(recordScriptTags(settings, 'D:/v/Clip.mp4', { id: 999 }, 3)).toBe(false);

    expect(getScriptTags(settings, 'D:/v/Clip.mp4')).toEqual(before);
    expect(getScriptTags(settings, 'D:/v/Clip.mp4').tags).toContain('multi-axis');
    // Nor does unknown create a record for a video that has none.
    expect(recordScriptTags(settings, 'D:/v/Other.mp4', { id: 5, tags: null }, 4)).toBe(false);
    expect(getScriptTags(settings, 'D:/v/Other.mp4')).toBeNull();
  });

  it('leaves an existing EMPTY record alone (absence rule: nothing is cleaned up)', () => {
    settings = makeSettings({ [SCRIPT_TAGS_KEY]: { 'D:/v/Old.mp4': { tags: [], topicId: 3, topicUrl: null, source: 'eroscripts', savedAt: 1 } } });
    expect(recordScriptTags(settings, 'D:/v/Old.mp4', { id: 3, tags: null }, 9)).toBe(false);
    expect(getScriptTags(settings, 'D:/v/Old.mp4')).toEqual({ tags: [], topicId: 3, topicUrl: null, source: 'eroscripts', savedAt: 1 });
  });
});

describe('getScriptTags', () => {
  it('returns null for a video with no record', () => {
    expect(getScriptTags(makeSettings(), 'D:/v/Unknown.mp4')).toBeNull();
    expect(getScriptTags(makeSettings(), '')).toBeNull();
  });
});
