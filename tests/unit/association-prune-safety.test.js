/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Associations must never be destroyed by a location being unreachable.
//
// INCIDENT, 2026-08-11. `D:\funsc` failed to scan (ENOENT, drive absent). The
// scan carried on with the remaining source and returned a PARTIAL result. The
// association validator compared stored associations against it, found every
// D:\funsc script "missing", and nulled 325 script pointers — hours of manual
// association work — 375ms after the failure.
//
// Three separate holes let that happen, and each gets a test here:
//
//   1. The scan KNEW `D:\funsc` had failed and said so in the log, but
//      `failedPaths` was shown as a toast and then discarded. It never
//      reached the validator's guard.
//   2. The guard checked only the VIDEO path. A video on C: holding a script
//      on D: was completely unprotected.
//   3. A single failed `fileExists` was treated as proof the association was
//      stale. "File missing" and "location unreachable" are different facts
//      and only the first justifies touching a user's data.
//
// The governing rule, and the thing these tests defend:
// AN ASSOCIATION IS ONLY EVER REMOVED BY AN EXPLICIT USER ACTION.
//
// 2026-11-18 (Dave, "Stop pruning"): taken literally now. Nothing prunes an
// association, even when its script is provably gone (absence-sibling-
// guards.test.js and video-options-library.test.js pin the keep).
// `_safeToPrune` stays the proof of absence: it gates the manual-variant
// prunes, and for a missing pairing it only picks "Script not found" over
// "Can't check the script right now". These tests pin that proof.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

function host({ unavailable = [], failedScans = [], fileExists = null, filesExist = null } = {}) {
  const h = {
    _unavailablePaths: new Set(unavailable),
    _failedScanPaths: new Set(failedScans),
    _isUnderUnavailableSource: Library.prototype._isUnderUnavailableSource,
    _safeToPrune: Library.prototype._safeToPrune,
    _pathStatus: Library.prototype._pathStatus,
  };
  global.window = global.window || {};
  window.funsync = { fileExists: fileExists || vi.fn().mockResolvedValue(true) };
  if (filesExist) window.funsync.filesExist = filesExist;
  return h;
}

/** fileExists fake: only the listed paths exist (a folder, typically). */
const onlyExists = (...present) => vi.fn((p) => Promise.resolve(present.includes(p)));

const SCRIPT_ON_D = 'D:\\funsc\\clip.funscript';
const VIDEO_ON_C = 'C:\\Users\\dave\\Videos\\clip.mp4';

describe('hole 1: a failed scan must count as unreachable', () => {
  it('treats a path under a FAILED SCAN source as unavailable', () => {
    const h = host({ failedScans: ['D:\\funsc'] });
    expect(h._isUnderUnavailableSource(SCRIPT_ON_D)).toBe(true);
  });

  it('still honours the periodic probe', () => {
    const h = host({ unavailable: ['D:\\funsc'] });
    expect(h._isUnderUnavailableSource(SCRIPT_ON_D)).toBe(true);
  });

  it('unions both signals rather than preferring one', () => {
    const h = host({ unavailable: ['E:\\other'], failedScans: ['D:\\funsc'] });
    expect(h._isUnderUnavailableSource(SCRIPT_ON_D)).toBe(true);
    expect(h._isUnderUnavailableSource('E:\\other\\x.funscript')).toBe(true);
    expect(h._isUnderUnavailableSource('C:\\fine\\x.funscript')).toBe(false);
  });

  it('does not match a sibling directory by prefix', () => {
    const h = host({ failedScans: ['D:\\funsc'] });
    expect(h._isUnderUnavailableSource('D:\\funsc2\\clip.funscript')).toBe(false);
  });
});

describe('hole 2: the SCRIPT path is guarded, not just the video path', () => {
  it('refuses to prune a script on a dead drive even when the video is fine', async () => {
    // The exact 2026-08-11 shape: video reachable, script not.
    const h = host({ failedScans: ['D:\\funsc'] });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(false);
    expect(h._isUnderUnavailableSource(VIDEO_ON_C)).toBe(false);
  });
});

describe('hole 3: a missing file is not proof the association is stale', () => {
  it('refuses to prune when the script DIRECTORY does not answer', async () => {
    const fileExists = vi.fn().mockResolvedValue(false); // dir unreachable
    const h = host({ fileExists });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(false);
    expect(fileExists).toHaveBeenCalledWith('D:\\funsc');
  });

  it('allows pruning only when the directory exists and the file does not', async () => {
    const fileExists = onlyExists('D:\\funsc'); // dir is fine, file is not there
    const h = host({ fileExists });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(true);
  });

  // A failed READ is not absence. `read-funscript` returns null for a locked
  // file (EBUSY) or a permissions error just as for a missing one, and two
  // prune paths (`_readFunscriptResilient`, app.js `_readScriptResilient`)
  // reach this guard on a read failure alone.
  it('refuses to prune when the file itself is still there', async () => {
    const filesExist = vi.fn(async (list) => list.map(() => true)); // file AND dir present
    const h = host({ filesExist });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(false);
  });

  // The singular file-exists IPC folds a timeout into `false`. The batch form
  // keeps it as `null`, and null is not evidence of anything.
  it('refuses to prune when the file check timed out (null)', async () => {
    const filesExist = vi.fn(async (list) => list.map((p) => (p === SCRIPT_ON_D ? null : true)));
    const h = host({ filesExist });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(false);
  });

  it('refuses to prune when the folder check timed out (null)', async () => {
    const filesExist = vi.fn(async (list) => list.map((p) => (p === SCRIPT_ON_D ? false : null)));
    const h = host({ filesExist });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(false);
  });

  it('prunes on an explicit absent file in a folder that answers, via the tri-state check', async () => {
    const filesExist = vi.fn(async (list) => list.map((p) => p !== SCRIPT_ON_D));
    const h = host({ filesExist });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(true);
  });

  // Fails CLOSED: a stale pointer costs one unmatched video, a wrong prune
  // costs hours of manual work.
  it('refuses to prune when the check throws', async () => {
    const fileExists = vi.fn().mockRejectedValue(new Error('ipc died'));
    const h = host({ fileExists });
    await expect(h._safeToPrune(SCRIPT_ON_D)).resolves.toBe(false);
  });

  it('refuses on a malformed path rather than guessing', async () => {
    const h = host();
    await expect(h._safeToPrune('')).resolves.toBe(false);
    await expect(h._safeToPrune('clip.funscript')).resolves.toBe(false);
  });
});

describe('the incident, replayed end to end', () => {
  it('a partial scan after an ENOENT prunes NOTHING', async () => {
    // Scan returned only Downloads; D:\funsc failed with ENOENT.
    const fileExists = vi.fn().mockImplementation((p) =>
      Promise.resolve(!String(p).startsWith('D:')));
    const h = host({ failedScans: ['D:\\funsc'], fileExists });

    const stored = [
      'D:\\funsc\\a.funscript',
      'D:\\funsc\\Xev\\b.funscript',
      'D:\\funsc\\c.funscript',
    ];
    const decisions = await Promise.all(stored.map((p) => h._safeToPrune(p)));
    expect(decisions).toEqual([false, false, false]);
  });

  it('a genuinely deleted script on a healthy drive is still PROVEN gone', async () => {
    // The proof must not be so broad that a real deletion never counts: it
    // is what says "Script not found" (and prunes a manual variant). The
    // association itself is kept since 2026-11-18 (Dave, "Stop pruning").
    const fileExists = onlyExists('C:\\videos'); // C: answers, the script is gone
    const h = host({ fileExists });
    await expect(h._safeToPrune('C:\\videos\\gone.funscript')).resolves.toBe(true);
  });
});

describe('the same rule must hold for script VARIATIONS', () => {
  // manualVariants had NO reachability guard at all. It never bit Dave only
  // because he had none stored; the moment variations live on an external
  // drive it is the identical loss.
  it('_safeToPrune is what both paths now gate on', async () => {
    const h = host({ failedScans: ['D:\\funsc'] });
    await expect(h._safeToPrune('D:\\funsc\\clip.soft.funscript')).resolves.toBe(false);
  });

  it('a variant on a healthy drive can still be cleaned up', async () => {
    const h = host({ fileExists: onlyExists('C:\\videos') });
    await expect(h._safeToPrune('C:\\videos\\clip.soft.funscript')).resolves.toBe(true);
  });
});
