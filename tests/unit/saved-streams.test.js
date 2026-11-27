/**
 * @vitest-environment node
 * No DOM required: the pure saved-stream helpers (renderer/js/saved-streams.js).
 *
 * Dave, 2026-11-23: "saving the loaded url and script pairing in a library ...
 * a special icon to indicate its not local media ... full library features".
 * notes/features/SCOPE-saved-streams.md.
 */
import { describe, it, expect } from 'vitest';
import { isStreamPath, streamEntryFrom, upsertStream, removeStream, streamToVideo, streamVideos } from '../../renderer/js/saved-streams.js';

const ES = 'https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f';

describe('saved streams', () => {
  it('a record keyed like the per-video offset, the stream address never kept', () => {
    const e = streamEntryFrom({ pageUrl: ES, title: ' POV squat ', site: 'EroSync', duration: 774, scriptPath: 'C:\\D\\s.funscript', axes: { pitch: 'C:\\D\\s.pitch.funscript', bad: '' }, topicId: 350088, now: 5 });
    expect(e).toEqual({
      key: 'stream:erosync.net/videos/abc6d128-7035-44d3-88a4-64dd63a2bc5f', pageUrl: ES, title: 'POV squat', site: 'EroSync',
      duration: 774, scriptPath: 'C:\\D\\s.funscript', axes: { pitch: 'C:\\D\\s.pitch.funscript' }, topicId: 350088, addedAt: 5,
    });
    expect(JSON.stringify(e)).not.toMatch(/localhost|proxy|m3u8/);
    expect(streamEntryFrom({ pageUrl: 'not a url' })).toBe(null);
    expect(streamEntryFrom({ pageUrl: 'https://x.com/v/1' }).title).toBe('x.com/v/1');        // no title: its address
    expect(isStreamPath(e.key)).toBe(true);
    expect(isStreamPath('C:\\Videos\\a.mp4')).toBe(false);
  });

  it('saving again updates in place, keeps when it was added and a script it had', () => {
    const a = streamEntryFrom({ pageUrl: ES, title: 'Old', scriptPath: 'C:\\s.funscript', now: 1 });
    const b = streamEntryFrom({ pageUrl: 'https://erosync.net/videos/abc6d128-7035-44d3-88a4-64dd63a2bc5f', title: 'New', now: 9 });
    const list = upsertStream(upsertStream([], a), b);
    expect(list).toHaveLength(1);                                     // /embed/ and /videos/: one video
    expect(list[0]).toMatchObject({ title: 'New', addedAt: 1, scriptPath: 'C:\\s.funscript' });
    expect(removeStream(list, a.key)).toEqual([]);
    expect(upsertStream([null, { nokey: 1 }], a)).toEqual([a]);        // a damaged list does not break it
  });

  it('as a library video: its key is its path, marked as a stream, its script a file', () => {
    const e = streamEntryFrom({ pageUrl: ES, title: 'T', duration: 774, scriptPath: 'C:\\s.funscript', axes: { roll: 'C:\\s.roll.funscript' }, now: 3 });
    expect(streamToVideo(e)).toEqual({
      path: e.key, name: 'T', _stream: true, pageUrl: ES, site: '', duration: 774,
      hasFunscript: true, funscriptPath: 'C:\\s.funscript', _multiAxis: { axes: { roll: 'C:\\s.roll.funscript' } },
      size: 0, mtime: 3, addedAt: 3,
    });
    expect(streamVideos([e, null, { title: 'no key' }])).toHaveLength(1);
  });
});
