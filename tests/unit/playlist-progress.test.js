// Playlist resume state — last-watched marker, Continue, and Reset.
// Imports the real Playlists component (its constructor touches no DOM).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Playlists } from '../../renderer/components/playlists.js';

function makeSettings(initial = {}) {
  const store = { ...initial };
  return {
    _store: store,
    get: (key) => store[key],
    set: (key, value) => { store[key] = value; },
  };
}

function makeView(settings) {
  return new Playlists({
    settings,
    onPlayVideo: vi.fn(),
    onPlayAll: vi.fn(),
    library: null,
  });
}

const PL = {
  id: 'pl-1',
  name: 'Evening',
  videoPaths: ['C:/v/a.mp4', 'C:/v/b.mp4', 'C:/v/c.mp4'],
};

describe('_playlistProgress', () => {
  it('reads the stored marker for a playlist', () => {
    const settings = makeSettings({
      'library.playlistProgress': { 'pl-1': { lastVideoPath: 'C:/v/b.mp4', updatedAt: 5 } },
    });
    expect(makeView(settings)._playlistProgress('pl-1').lastVideoPath).toBe('C:/v/b.mp4');
  });

  it('returns null for an unknown or missing playlist', () => {
    const view = makeView(makeSettings({}));
    expect(view._playlistProgress('pl-1')).toBeNull();
    expect(view._playlistProgress(undefined)).toBeNull();
  });
});

describe('_playlistHasProgress', () => {
  it('is true when a last-watched marker exists', () => {
    const settings = makeSettings({
      'library.playlistProgress': { 'pl-1': { lastVideoPath: 'C:/v/b.mp4', updatedAt: 5 } },
    });
    expect(makeView(settings)._playlistHasProgress(PL)).toBe(true);
  });

  it('is true when any member video has a saved position, with no marker', () => {
    const settings = makeSettings({
      'library.resumePositions': { 'C:/v/c.mp4': { position: 600, duration: 3600 } },
    });
    expect(makeView(settings)._playlistHasProgress(PL)).toBe(true);
  });

  it('is false when nothing is stored — the Reset button stays hidden', () => {
    expect(makeView(makeSettings({}))._playlistHasProgress(PL)).toBe(false);
  });

  it('ignores positions belonging to videos outside this playlist', () => {
    const settings = makeSettings({
      'library.resumePositions': { 'C:/other/z.mp4': { position: 600, duration: 3600 } },
    });
    expect(makeView(settings)._playlistHasProgress(PL)).toBe(false);
  });

  it('tolerates a null playlist', () => {
    expect(makeView(makeSettings({}))._playlistHasProgress(null)).toBe(false);
  });
});

describe('_resetPlaylistProgress', () => {
  it('clears the marker and every member position', () => {
    const settings = makeSettings({
      'library.playlistProgress': { 'pl-1': { lastVideoPath: 'C:/v/b.mp4', updatedAt: 5 } },
      'library.resumePositions': {
        'C:/v/a.mp4': { position: 100, duration: 3600 },
        'C:/v/b.mp4': { position: 200, duration: 3600 },
      },
    });
    const view = makeView(settings);
    view._resetPlaylistProgress(PL);

    expect(settings.get('library.playlistProgress')['pl-1']).toBeUndefined();
    expect(settings.get('library.resumePositions')['C:/v/a.mp4']).toBeUndefined();
    expect(settings.get('library.resumePositions')['C:/v/b.mp4']).toBeUndefined();
    expect(view._playlistHasProgress(PL)).toBe(false);
  });

  it('leaves other playlists and unrelated videos alone', () => {
    const settings = makeSettings({
      'library.playlistProgress': {
        'pl-1': { lastVideoPath: 'C:/v/b.mp4', updatedAt: 5 },
        'pl-2': { lastVideoPath: 'C:/other/z.mp4', updatedAt: 9 },
      },
      'library.resumePositions': {
        'C:/v/a.mp4': { position: 100, duration: 3600 },
        'C:/other/z.mp4': { position: 300, duration: 3600 },
      },
    });
    makeView(settings)._resetPlaylistProgress(PL);

    expect(settings.get('library.playlistProgress')['pl-2']).toEqual({
      lastVideoPath: 'C:/other/z.mp4', updatedAt: 9,
    });
    expect(settings.get('library.resumePositions')['C:/other/z.mp4']).toEqual({
      position: 300, duration: 3600,
    });
  });

  it('is safe on a playlist with nothing stored', () => {
    const settings = makeSettings({});
    expect(() => makeView(settings)._resetPlaylistProgress(PL)).not.toThrow();
  });
});

describe('_continueFromLastWatched', () => {
  let settings, view;

  beforeEach(() => {
    settings = makeSettings({
      'library.playlistProgress': { 'pl-1': { lastVideoPath: 'C:/v/b.mp4', updatedAt: 5 } },
    });
    view = makeView(settings);
    view._playVideoByPath = vi.fn();
  });

  it('plays the last-watched video with a playlist context at the right index', () => {
    view._continueFromLastWatched(PL);
    expect(view._playVideoByPath).toHaveBeenCalledTimes(1);
    const [path, ctx] = view._playVideoByPath.mock.calls[0];
    expect(path).toBe('C:/v/b.mp4');
    expect(ctx.source).toBe('playlist');
    expect(ctx.sourceContext).toEqual({ playlistId: 'pl-1' });
    expect(ctx.list).toEqual(PL.videoPaths);
    // Index must point at the resumed video, so next/prev step from there.
    expect(ctx.index).toBe(1);
  });

  // Both cases below used to no-op. They now fall back to the first
  // unwatched video, which is what "continue this playlist" should mean
  // when the marker can't be honoured.
  it('falls back to the first unwatched when there is no marker', () => {
    const bare = makeView(makeSettings({}));
    bare._playVideoByPath = vi.fn();
    bare._continueFromLastWatched(PL);
    expect(bare._playVideoByPath.mock.calls[0][0]).toBe('C:/v/a.mp4');
  });

  it('falls back to the first unwatched when the marked video has left the playlist', () => {
    view._continueFromLastWatched({ ...PL, videoPaths: ['C:/v/a.mp4', 'C:/v/c.mp4'] });
    expect(view._playVideoByPath.mock.calls[0][0]).toBe('C:/v/a.mp4');
  });

  it('does nothing for an empty playlist', () => {
    view._continueFromLastWatched({ ...PL, videoPaths: [] });
    expect(view._playVideoByPath).not.toHaveBeenCalled();
  });
});

// --- Watched state, summary, and Continue targeting through the component ---

const finishedEntry = () => ({ duration: 3600, updatedAt: 1, finished: true });

describe('_continueFromLastWatched with watched state', () => {
  it('skips past a FINISHED marked video instead of replaying it', () => {
    const settings = makeSettings({
      'library.playlistProgress': { 'pl-1': { lastVideoPath: 'C:/v/a.mp4', updatedAt: 5 } },
      'library.resumePositions': { 'C:/v/a.mp4': finishedEntry() },
    });
    const view = makeView(settings);
    view._playVideoByPath = vi.fn();

    view._continueFromLastWatched(PL);

    const [path, ctx] = view._playVideoByPath.mock.calls[0];
    expect(path).toBe('C:/v/b.mp4');
    expect(ctx.index).toBe(1);
  });

  it('still resumes a marked video that is only part-watched', () => {
    const settings = makeSettings({
      'library.playlistProgress': { 'pl-1': { lastVideoPath: 'C:/v/a.mp4', updatedAt: 5 } },
      'library.resumePositions': { 'C:/v/a.mp4': { position: 600, duration: 3600 } },
    });
    const view = makeView(settings);
    view._playVideoByPath = vi.fn();

    view._continueFromLastWatched(PL);
    expect(view._playVideoByPath.mock.calls[0][0]).toBe('C:/v/a.mp4');
  });

  it('plays the first unwatched when there is no marker at all', () => {
    const settings = makeSettings({
      'library.resumePositions': { 'C:/v/a.mp4': finishedEntry() },
    });
    const view = makeView(settings);
    view._playVideoByPath = vi.fn();

    view._continueFromLastWatched(PL);
    expect(view._playVideoByPath.mock.calls[0][0]).toBe('C:/v/b.mp4');
  });
});

describe('_summariseProgress', () => {
  it('counts watched videos and remaining time from library durations', () => {
    const settings = makeSettings({
      'library.resumePositions': {
        'C:/v/a.mp4': finishedEntry(),
        'C:/v/b.mp4': { position: 600, duration: 3600 },
      },
    });
    const view = makeView(settings);
    view._library = { getVideoByPath: () => ({ duration: 3600 }) };

    const s = view._summariseProgress(PL);
    expect(s.watched).toBe(1);
    expect(s.inProgress).toBe(1);
    expect(s.total).toBe(3);
    // b has 3000s left, c has its full 3600s, a is watched and excluded.
    expect(s.remainingSeconds).toBe(3000 + 3600);
  });

  it('reports nothing watched for an untouched playlist', () => {
    const view = makeView(makeSettings({}));
    view._library = { getVideoByPath: () => ({ duration: 3600 }) };
    expect(view._summariseProgress(PL).watched).toBe(0);
  });
});

describe('_playlistHasProgress with watched-only state', () => {
  it('is true when a member is watched but nothing is part-played', () => {
    // Reset must stay available after finishing everything.
    const settings = makeSettings({
      'library.resumePositions': { 'C:/v/a.mp4': finishedEntry() },
    });
    expect(makeView(settings)._playlistHasProgress(PL)).toBe(true);
  });
});
