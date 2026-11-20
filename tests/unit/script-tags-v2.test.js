/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The EroScripts tag record v2 (video options design (c), 2026-11-18): the
// writers Get tags uses (applyTopicMeta, markScriptTagsStale), the readers
// that take both tag shapes, and the script check that decides whether a
// record describes the video's current script. That check must agree with
// what video-tags.js shows, or Get tags would be offered for tags the
// section hides (or the reverse).
import { describe, it, expect, vi } from 'vitest';
import {
  SCRIPT_TAGS_KEY, TAG_MATCH, makeScriptTagRecord, recordScriptTags, getScriptTags, scriptTagNames,
  sameScriptPath, recordIsForScript, applyTopicMeta, markScriptTagsStale,
} from '../../renderer/js/script-tags.js';
import { effectiveTags } from '../../renderer/js/video-tags.js';

const VIDEO = 'C:/v/Scene.mp4';
const SCRIPT = 'C:/v/Scene.funscript';
const META = {
  topicId: 7, url: 'https://discuss.eroscripts.com/t/scene/7', title: 'Scene', creator: 'Ramie',
  tags: [{ id: 1, name: 'pov' }, { name: 'the-handy' }],
};

function makeSettings(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  const set = vi.fn((key, value) => { store[key] = value; });
  return { get: (key) => store[key], set, _store: store };
}

describe('makeScriptTagRecord v2', () => {
  it('keeps {id, name} tags with their ids, strings as they were', () => {
    const record = makeScriptTagRecord({ id: 7, tags: [{ id: 1, name: ' pov ' }, 'vr', { id: 'x', name: 'sr6' }, { name: '' }, { id: 3 }, 'vr'] }, 1);
    expect(record.tags).toEqual([{ id: 1, name: 'pov' }, 'vr', { id: null, name: 'sr6' }]);
  });

  it('records the script, how the post was found and when its JSON was read', () => {
    const record = makeScriptTagRecord({ id: 7, tags: [], creator: 'Ramie' }, 5, { scriptPath: SCRIPT, match: TAG_MATCH.SEARCH, fetchedAt: 5 });
    expect(record).toMatchObject({ scriptPath: SCRIPT, match: 'search', fetchedAt: 5, creator: 'Ramie', stale: false });
    expect(makeScriptTagRecord({ id: 7, tags: [] }, 5, { match: 'bogus' }).match).toBe('download');
  });

  it('leaves out an over-long title or creator rather than cutting it', () => {
    const record = makeScriptTagRecord({ id: 7, tags: [], title: 'x'.repeat(1001), creator: '  ' }, 1);
    expect(record.title).toBeNull();
    expect(record.creator).toBeNull();
  });

  it('recordScriptTags passes the extra fields through (download with its script)', () => {
    const settings = makeSettings();
    expect(recordScriptTags(settings, VIDEO, { id: 7, tags: ['vr'] }, 3, { scriptPath: SCRIPT })).toBe(true);
    expect(getScriptTags(settings, VIDEO)).toMatchObject({ scriptPath: SCRIPT, match: 'download', fetchedAt: null });
  });
});

describe('scriptTagNames reads both shapes', () => {
  it('string[] and {id, name}', () => {
    expect(scriptTagNames({ tags: ['vr', { id: 1, name: 'pov' }, null, { id: 2 }] })).toEqual(['vr', 'pov']);
    expect(scriptTagNames(null)).toEqual([]);
    expect(scriptTagNames({ tags: 'vr' })).toEqual([]);
  });
});

describe('recordIsForScript', () => {
  // fixup-data 2026-11-18 (review-b RB-2): a record without scriptPath was
  // made by a download before the field, which saved the video's same-name
  // script. It describes THAT file, not whatever script the video has now.
  it('a record without scriptPath (older) describes the video\'s same-name script only', () => {
    expect(recordIsForScript({ topicId: 7 }, SCRIPT, VIDEO)).toBe(true);
    expect(recordIsForScript({ topicId: 7 }, 'c:\\V\\scene.FUNSCRIPT', VIDEO)).toBe(true);
    expect(recordIsForScript({ topicId: 7 }, 'C:/v/hand-picked.funscript', VIDEO)).toBe(false);
    expect(recordIsForScript({ topicId: 7 }, 'D:/elsewhere/Scene.funscript', VIDEO)).toBe(false);
    // Without the video's path it cannot be proved: not used.
    expect(recordIsForScript({ topicId: 7 }, SCRIPT)).toBe(false);
  });

  it('a record naming another script does not', () => {
    expect(recordIsForScript({ topicId: 7, scriptPath: 'C:/v/old.funscript' }, SCRIPT)).toBe(false);
    expect(recordIsForScript({ topicId: 7, scriptPath: 'C:\\V\\SCENE.funscript' }, SCRIPT)).toBe(true);
    expect(recordIsForScript(null, SCRIPT)).toBe(false);
    expect(sameScriptPath('C:/v/a/', 'c:\\v\\a')).toBe(true);
    expect(sameScriptPath('', '')).toBe(false);
  });

  it('agrees with what the Tags section shows (video-tags.js)', () => {
    const pairs = [
      [undefined, SCRIPT],
      [undefined, 'C:/v/old.funscript'],
      [undefined, 'D:/other/Scene.funscript'],
      [SCRIPT, SCRIPT],
      ['c:\\v\\scene.funscript', SCRIPT],
      ['C:/v/old.funscript', SCRIPT],
      ['C:/v/Scene.funscript/', SCRIPT],
      ['D:/other/Scene.funscript', SCRIPT],
    ];
    for (const [recordScript, current] of pairs) {
      const record = { tags: ['pov'], topicId: 7, ...(recordScript ? { scriptPath: recordScript } : {}) };
      const shown = effectiveTags(VIDEO, { eroscripts: { [VIDEO]: record } }, { scriptPath: current }).length > 0;
      expect(recordIsForScript(record, current, VIDEO), `${recordScript} on ${current}`).toBe(shown);
    }
  });
});

describe('applyTopicMeta', () => {
  it('replaces only this video\'s record and counts the new tags', () => {
    const settings = makeSettings({
      [SCRIPT_TAGS_KEY]: { [VIDEO]: { tags: ['POV', 'old'], topicId: 7, savedAt: 1 }, 'C:/v/B.mp4': { tags: ['vr'], topicId: 2, savedAt: 1 } },
      'library.userTags': { [VIDEO]: ['mine'] },
      'library.hiddenTags': { [VIDEO]: ['content:pov'] },
    });
    const res = applyTopicMeta(settings, VIDEO, META, { scriptPath: SCRIPT, match: 'download', now: 9 });
    expect(res).toMatchObject({ written: true, count: 2, newCount: 1 });
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO].tags).toEqual([{ id: 1, name: 'pov' }, { id: null, name: 'the-handy' }]);
    expect(settings._store[SCRIPT_TAGS_KEY]['C:/v/B.mp4']).toEqual({ tags: ['vr'], topicId: 2, savedAt: 1 });
    expect(settings._store['library.userTags']).toEqual({ [VIDEO]: ['mine'] });
    expect(settings._store['library.hiddenTags']).toEqual({ [VIDEO]: ['content:pov'] });
    expect(settings.set).toHaveBeenCalledTimes(1);
  });

  it('unknown tags (not a list) write nothing', () => {
    const settings = makeSettings({ [SCRIPT_TAGS_KEY]: { [VIDEO]: { tags: ['pov'], topicId: 7 } } });
    expect(applyTopicMeta(settings, VIDEO, { ...META, tags: null }, { scriptPath: SCRIPT }).written).toBe(false);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('reads the map again at write time, so another video written meanwhile is kept', () => {
    const settings = makeSettings({ [SCRIPT_TAGS_KEY]: {} });
    settings.set(SCRIPT_TAGS_KEY, { 'C:/v/B.mp4': { tags: ['vr'], topicId: 2 } });
    applyTopicMeta(settings, VIDEO, META, { scriptPath: SCRIPT });
    expect(Object.keys(settings._store[SCRIPT_TAGS_KEY]).sort()).toEqual(['C:/v/B.mp4', VIDEO].sort());
  });
});

describe('markScriptTagsStale', () => {
  it('marks the record of that topic stale and keeps everything else', () => {
    const record = { tags: ['pov', { id: 1, name: 'vr' }], topicId: 7, topicUrl: 'u', savedAt: 3 };
    const settings = makeSettings({ [SCRIPT_TAGS_KEY]: { [VIDEO]: record } });
    expect(markScriptTagsStale(settings, VIDEO, 7)).toBe(true);
    expect(settings._store[SCRIPT_TAGS_KEY][VIDEO]).toEqual({ ...record, stale: true });
  });

  it('writes nothing for no record, another topic, or a record already stale', () => {
    const settings = makeSettings({ [SCRIPT_TAGS_KEY]: { [VIDEO]: { tags: ['pov'], topicId: 7, stale: true }, 'C:/v/B.mp4': { tags: [], topicId: 8 } } });
    expect(markScriptTagsStale(settings, 'C:/v/None.mp4', 7)).toBe(false);
    expect(markScriptTagsStale(settings, 'C:/v/B.mp4', 7)).toBe(false);
    expect(markScriptTagsStale(settings, VIDEO, 7)).toBe(false);
    expect(settings.set).not.toHaveBeenCalled();
  });
});
