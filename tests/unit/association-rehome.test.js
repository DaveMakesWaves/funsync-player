// Re-homing manual associations when a video moves to a different source.
//
// The library has always had a filename fallback here, but it matched on
// basename alone and took the first hit. In a library that legitimately
// contains several `intro.mp4`s that could rob a live video of its
// association AND delete the original. These tests pin the safety rule:
// a move is only inferred on an unambiguous 1:1 basename match.

import { describe, it, expect } from 'vitest';
import { planAssociationRehome, pickRehomeCandidate, findMovedFile } from '../../renderer/js/association-rehome.js';

const plan = (storedPaths, scannedPaths, isUnavailable) =>
  planAssociationRehome({ storedPaths, scannedPaths, isUnavailable });

describe('planAssociationRehome — the move it is meant to catch', () => {
  it('re-homes a video that moved to a different source', () => {
    expect(plan(['D:/old/Scene.mp4'], ['E:/new/Scene.mp4']))
      .toEqual([{ from: 'D:/old/Scene.mp4', to: 'E:/new/Scene.mp4' }]);
  });

  it('matches case-insensitively and across path separators', () => {
    expect(plan(['D:\\old\\SCENE.mp4'], ['/mnt/new/scene.mp4']))
      .toEqual([{ from: 'D:\\old\\SCENE.mp4', to: '/mnt/new/scene.mp4' }]);
  });

  it('re-homes several independent moves at once', () => {
    const moves = plan(
      ['D:/old/a.mp4', 'D:/old/b.mp4'],
      ['E:/new/a.mp4', 'E:/new/b.mp4'],
    );
    expect(moves).toHaveLength(2);
    expect(moves).toContainEqual({ from: 'D:/old/a.mp4', to: 'E:/new/a.mp4' });
    expect(moves).toContainEqual({ from: 'D:/old/b.mp4', to: 'E:/new/b.mp4' });
  });
});

describe('planAssociationRehome — ambiguity must abort, not guess', () => {
  it('does NOT re-home when two stored entries share a filename', () => {
    // Which one moved? Unknowable. A wrong association is worse than a
    // missing one because the user cannot see that it is wrong.
    expect(plan(
      ['D:/one/intro.mp4', 'D:/two/intro.mp4'],
      ['E:/new/intro.mp4'],
    )).toEqual([]);
  });

  it('does NOT re-home when two scanned videos share a filename', () => {
    // Ambiguity on the DESTINATION side. The old code gave the entry to
    // whichever video happened to be scanned first.
    expect(plan(
      ['D:/old/intro.mp4'],
      ['E:/a/intro.mp4', 'E:/b/intro.mp4'],
    )).toEqual([]);
  });

  it('does NOT rob a video that still exists', () => {
    // The stored path is still in the scan, so it belongs to a live video
    // and is never an orphan — even though another video shares its name.
    expect(plan(
      ['D:/keep/intro.mp4'],
      ['D:/keep/intro.mp4', 'E:/other/intro.mp4'],
    )).toEqual([]);
  });

  it('handles the ping-pong case: both videos present, only one has an entry', () => {
    // Previously: the entry-less video stole the entry and deleted it, then
    // the robbed video stole it back on its own turn.
    const moves = plan(
      ['/lib/x/clip.mp4'],
      ['/lib/x/clip.mp4', '/lib/y/clip.mp4'],
    );
    expect(moves).toEqual([]);
  });
});

describe('planAssociationRehome — offline sources are protected', () => {
  it('leaves entries on a disconnected drive alone', () => {
    // The drive may come back. Stealing and deleting the entry would
    // defeat the offline-source protection the validation pass implements.
    expect(plan(
      ['D:/offline/Scene.mp4'],
      ['E:/new/Scene.mp4'],
      (p) => p.startsWith('D:/offline'),
    )).toEqual([]);
  });

  it('still re-homes when the offline predicate does not match', () => {
    expect(plan(
      ['D:/old/Scene.mp4'],
      ['E:/new/Scene.mp4'],
      (p) => p.startsWith('Z:/somewhere-else'),
    )).toHaveLength(1);
  });
});

describe('planAssociationRehome — nothing to do', () => {
  it('returns [] when the video did not move', () => {
    expect(plan(['D:/same/Scene.mp4'], ['D:/same/Scene.mp4'])).toEqual([]);
  });

  it('returns [] when no scanned video matches the orphan', () => {
    expect(plan(['D:/old/Gone.mp4'], ['E:/new/Other.mp4'])).toEqual([]);
  });

  it('tolerates empty and malformed input', () => {
    expect(plan([], [])).toEqual([]);
    expect(plan(undefined, undefined)).toEqual([]);
    expect(planAssociationRehome()).toEqual([]);
    expect(plan([''], [''])).toEqual([]);
  });
});

// --- Lazy single-video form -------------------------------------------
// Used by library.manualVariants and library.preferredVariants, which are
// looked up at playback time rather than during a scan. Both previously
// took the first basename match and deleted it — and because these paths
// WRITE settings, a wrong guess was persisted immediately.

describe('pickRehomeCandidate', () => {
  const pick = (storedPaths, videoPath, isLive) =>
    pickRehomeCandidate({ storedPaths, videoPath, isLive });

  it('returns the single orphaned entry that matches the filename', () => {
    expect(pick(['D:/old/Scene.mp4'], 'E:/new/Scene.mp4')).toBe('D:/old/Scene.mp4');
  });

  it('is case- and separator-insensitive', () => {
    expect(pick(['D:\\old\\SCENE.mp4'], '/mnt/new/scene.mp4')).toBe('D:\\old\\SCENE.mp4');
  });

  it('refuses when two stored entries share the filename', () => {
    expect(pick(['D:/a/intro.mp4', 'D:/b/intro.mp4'], 'E:/new/intro.mp4')).toBeNull();
  });

  it('refuses to steal from a video that is still in the library', () => {
    // The whole point: the candidate belongs to a live video, and the
    // caller would otherwise delete that video's entry.
    expect(pick(['D:/live/intro.mp4'], 'E:/new/intro.mp4', (p) => p === 'D:/live/intro.mp4'))
      .toBeNull();
  });

  it('still re-homes when only the OTHER same-named entry is live', () => {
    // One candidate is live (skipped), leaving exactly one orphan.
    const live = new Set(['D:/live/intro.mp4']);
    expect(pick(
      ['D:/live/intro.mp4', 'D:/gone/intro.mp4'],
      'E:/new/intro.mp4',
      (p) => live.has(p),
    )).toBe('D:/gone/intro.mp4');
  });

  it('ignores its own entry and non-matching names', () => {
    expect(pick(['E:/new/Scene.mp4'], 'E:/new/Scene.mp4')).toBeNull();
    expect(pick(['D:/old/Other.mp4'], 'E:/new/Scene.mp4')).toBeNull();
  });

  it('tolerates empty and malformed input', () => {
    expect(pick([], 'E:/new/Scene.mp4')).toBeNull();
    expect(pick(['D:/old/Scene.mp4'], '')).toBeNull();
    expect(pickRehomeCandidate()).toBeNull();
  });
});

// --- Recovering a file with no directory anchor -----------------------
// The global Orgasm Switch script is a single absolute path with no owning
// video, so the "look beside the video" recovery cannot apply. The library
// scan's funscript list is the candidate pool instead.

describe('findMovedFile', () => {
  it('finds the moved file by filename', () => {
    expect(findMovedFile(
      ['/lib/a/other.funscript', '/lib/b/finisher.funscript'],
      'D:/old/finisher.funscript',
    )).toBe('/lib/b/finisher.funscript');
  });

  it('refuses when several candidates share the filename', () => {
    // Driving a device from a script the user did not choose is worse
    // than leaving the switch unconfigured.
    expect(findMovedFile(
      ['/lib/a/finisher.funscript', '/lib/b/finisher.funscript'],
      'D:/old/finisher.funscript',
    )).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findMovedFile(['/lib/a/other.funscript'], 'D:/old/finisher.funscript')).toBeNull();
  });

  it('ignores the missing path itself', () => {
    expect(findMovedFile(['D:/old/finisher.funscript'], 'D:/old/finisher.funscript')).toBeNull();
  });

  it('is case- and separator-insensitive', () => {
    expect(findMovedFile(['/lib/b/FINISHER.funscript'], 'D:\\old\\finisher.funscript'))
      .toBe('/lib/b/FINISHER.funscript');
  });

  it('tolerates empty and malformed input', () => {
    expect(findMovedFile([], 'D:/old/f.funscript')).toBeNull();
    expect(findMovedFile(['/a/f.funscript'], '')).toBeNull();
    expect(findMovedFile(null, null)).toBeNull();
    expect(findMovedFile([null, undefined, ''], 'D:/old/f.funscript')).toBeNull();
  });
});
