/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Videos on a disconnected drive must go UNAVAILABLE, never deleted.
//
// Bug, 2026-08-06 (Dave): add videos from an external drive to a playlist,
// unplug the drive, open the playlist — every entry was permanently removed.
// `_renderDetail` probed each path with fileExists and called
// removeVideoFromPlaylist on each miss, so an absent VOLUME was treated as a
// deleted FILE. Reconnecting could not undo it; config.json was already
// rewritten.
//
// The invariant these tests exist to hold: absence is never destructive.
import { describe, it, expect, vi } from 'vitest';
import {
  probeAvailability,
  availabilityPredicate,
  partitionByAvailability,
  groupByVolume,
} from '../../renderer/js/playlist-availability.js';
import {
  pickContinueTarget,
  summarisePlaylistProgress,
  partitionByWatched,
} from '../../renderer/js/playlist-progress.js';

const E = (p) => `E:\\Videos\\${p}`;
const C = (p) => `C:\\Users\\dave\\Videos\\${p}`;

describe('probeAvailability', () => {
  it('uses ONE batch call, not one per path', async () => {
    const filesExist = vi.fn().mockResolvedValue([true, false, true]);
    const set = await probeAvailability([C('a.mp4'), E('b.mp4'), C('c.mp4')], { filesExist });

    expect(filesExist).toHaveBeenCalledTimes(1);
    expect(set.has(C('a.mp4'))).toBe(true);
    expect(set.has(E('b.mp4'))).toBe(false);
  });

  it('dedupes before probing', async () => {
    const filesExist = vi.fn().mockResolvedValue([true]);
    await probeAvailability([C('a.mp4'), C('a.mp4'), C('a.mp4')], { filesExist });
    expect(filesExist.mock.calls[0][0]).toEqual([C('a.mp4')]);
  });

  // Failing CLOSED here would recreate the original bug in a new form: a
  // transient IPC error would grey out (or drop) a perfectly good library.
  it('fails OPEN when the bridge throws', async () => {
    const filesExist = vi.fn().mockRejectedValue(new Error('ipc died'));
    const set = await probeAvailability([C('a.mp4'), E('b.mp4')], { filesExist });
    expect(set.size).toBe(2);
  });

  it('fails OPEN when the bridge is missing entirely', async () => {
    const set = await probeAvailability([C('a.mp4')], {});
    expect(set.has(C('a.mp4'))).toBe(true);
  });

  it('fails OPEN on a length mismatch rather than trusting it', async () => {
    const filesExist = vi.fn().mockResolvedValue([true]); // 1 result, 2 asked
    const set = await probeAvailability([C('a.mp4'), E('b.mp4')], { filesExist });
    expect(set.size).toBe(2);
  });

  it('falls back to per-path fileExists on an older bridge', async () => {
    const fileExists = vi.fn().mockImplementation((p) => Promise.resolve(p.startsWith('C:')));
    const set = await probeAvailability([C('a.mp4'), E('b.mp4')], { fileExists });
    expect(set.has(C('a.mp4'))).toBe(true);
    expect(set.has(E('b.mp4'))).toBe(false);
  });
});

describe('availabilityPredicate', () => {
  it('is permissive when availability is unknown', () => {
    expect(availabilityPredicate(null)('anything')).toBe(true);
  });
});

describe('groupByVolume', () => {
  it('groups Windows paths by drive letter', () => {
    const g = groupByVolume([E('a.mp4'), E('b.mp4'), C('c.mp4')]);
    expect(g.get('E:')).toHaveLength(2);
    expect(g.get('C:')).toHaveLength(1);
  });

  it('groups macOS and Linux mount points', () => {
    const g = groupByVolume(['/Volumes/Media/a.mp4', '/mnt/usb/b.mp4']);
    expect(g.get('/Volumes/Media')).toHaveLength(1);
    expect(g.get('/mnt/usb')).toHaveLength(1);
  });

  it('groups a UNC share by server+share', () => {
    const g = groupByVolume(['\\\\nas\\media\\a.mp4']);
    expect(g.get('\\\\nas\\media')).toHaveLength(1);
  });
});

describe('partitionByAvailability', () => {
  it('preserves playlist order in both halves', () => {
    const paths = [C('1'), E('2'), C('3'), E('4')];
    const { available, unavailable } =
      partitionByAvailability(paths, (p) => p.startsWith('C:'));
    expect(available).toEqual([C('1'), C('3')]);
    expect(unavailable).toEqual([E('2'), E('4')]);
  });
});

describe('pickContinueTarget with an unplugged drive', () => {
  const noEntries = () => null;
  const onC = (p) => p.startsWith('C:');

  it('skips an unavailable marked video', () => {
    const list = [E('1'), C('2'), C('3')];
    const target = pickContinueTarget(list, E('1'), noEntries, onC);
    expect(target.path).toBe(C('2'));
    // Index still refers to the FULL list, so a reconnect renumbers nothing.
    expect(target.index).toBe(1);
  });

  it('skips unavailable videos when searching forward', () => {
    const list = [C('1'), E('2'), E('3'), C('4')];
    const entries = { [C('1')]: { finished: true } };
    const target = pickContinueTarget(list, C('1'), (p) => entries[p] || null, onC);
    expect(target.path).toBe(C('4'));
  });

  it('returns null when NOTHING is reachable', () => {
    const list = [E('1'), E('2')];
    expect(pickContinueTarget(list, null, noEntries, onC)).toBeNull();
  });

  it('still returns an available target when everything is watched', () => {
    const list = [C('1'), E('2')];
    const entries = { [C('1')]: { finished: true }, [E('2')]: { finished: true } };
    const target = pickContinueTarget(list, C('1'), (p) => entries[p] || null, onC);
    expect(target.path).toBe(C('1')); // wraps to the only reachable one
  });

  it('behaves exactly as before when no predicate is passed', () => {
    const list = [E('1'), C('2')];
    expect(pickContinueTarget(list, E('1'), noEntries).path).toBe(E('1'));
  });
});

describe('summarisePlaylistProgress with an unplugged drive', () => {
  const onC = (p) => p.startsWith('C:');

  it('counts unavailable separately and keeps them in total', () => {
    const list = [C('1'), E('2'), E('3')];
    const s = summarisePlaylistProgress(list, () => null, () => 600, onC);
    expect(s.total).toBe(3);
    expect(s.unavailable).toBe(2);
  });

  // Time you cannot currently watch is not "time left".
  it('excludes unavailable videos from remaining time', () => {
    const list = [C('1'), E('2')];
    const s = summarisePlaylistProgress(list, () => null, () => 600, onC);
    expect(s.remainingSeconds).toBe(600);
  });

  it('still credits a finished video that is now unavailable', () => {
    const list = [E('1'), C('2')];
    const entries = { [E('1')]: { finished: true } };
    const s = summarisePlaylistProgress(list, (p) => entries[p] || null, () => 600, onC);
    expect(s.watched).toBe(1);
    expect(s.unavailable).toBe(1);
  });

  it('does not report an unreachable part-watched video as in progress', () => {
    const list = [E('1')];
    const entries = { [E('1')]: { position: 300, duration: 600 } };
    const s = summarisePlaylistProgress(list, (p) => entries[p] || null, () => 600, onC);
    expect(s.inProgress).toBe(0);
    expect(s.remainingSeconds).toBe(0);
  });
});

describe('partitionByWatched with an unplugged drive', () => {
  const onC = (p) => p.startsWith('C:');

  // Watched items go to the BACK (a marathon must still play). Unavailable
  // items are DROPPED — they can never play, and leaving them in the shuffle
  // bag would surface as a dead entry mid-queue.
  it('drops unavailable items rather than moving them to the back', () => {
    const list = [C('1'), E('2'), C('3')];
    const { unwatched, watched } = partitionByWatched(list, () => null, (v) => v, onC);
    expect(unwatched).toEqual([C('1'), C('3')]);
    expect(watched).toEqual([]);
  });

  it('is unchanged when no predicate is passed', () => {
    const list = [C('1'), E('2')];
    const { unwatched } = partitionByWatched(list, () => null);
    expect(unwatched).toEqual([C('1'), E('2')]);
  });
});
