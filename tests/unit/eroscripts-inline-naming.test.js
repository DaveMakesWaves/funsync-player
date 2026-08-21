/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Download naming for the inline EroScripts search.
//
// This is the part that decides whether the app can find these files again.
// Auto-pairing matches a funscript to a video by filename, and companion
// detection matches axes to their main by base name — so a downloaded set
// has to take the VIDEO's base name, keeping the axis suffix. Using the
// EroScripts base name would satisfy neither.
import { describe, it, expect } from 'vitest';
import { targetFileName } from '../../renderer/components/eroscripts-inline-search.js';
import { parseAxisSuffix, getBaseName } from '../../renderer/js/multi-axis.js';

const VIDEO = 'D:/clips/Izzy Green POV Onlyfans.mp4';

describe('targetFileName', () => {
  it('renames the main script to the video base name', () => {
    expect(targetFileName(VIDEO, null)).toBe('Izzy Green POV Onlyfans.funscript');
  });

  it('keeps the axis suffix so companions stay detectable', () => {
    expect(targetFileName(VIDEO, 'roll')).toBe('Izzy Green POV Onlyfans.roll.funscript');
    expect(targetFileName(VIDEO, 'pitch')).toBe('Izzy Green POV Onlyfans.pitch.funscript');
  });

  it('handles Windows separators and dotted video names', () => {
    // Backslashes doubled: `\v` in a JS string literal is a vertical
    // tab, not a path separator. The first version of this test failed for
    // that reason alone — the code was right.
    expect(targetFileName('C:\\videos\\My Video v1.2.mkv', 'twist'))
      .toBe('My Video v1.2.twist.funscript');
  });

  it('produces names the app can round-trip', () => {
    // The real contract: what we write must be readable by the very
    // functions that later rebuild the multi-axis set.
    const main = targetFileName(VIDEO, null);
    const roll = targetFileName(VIDEO, 'roll');

    expect(parseAxisSuffix(main)).toBeNull();
    expect(parseAxisSuffix(roll)?.suffix).toBe('roll');
    // Both must resolve to the SAME base, or the companion never pairs.
    expect(getBaseName(main)).toBe(getBaseName(roll));
    expect(getBaseName(roll)).toBe('Izzy Green POV Onlyfans');
  });

  it('round-trips every axis in the definition list', () => {
    for (const suffix of ['surge', 'sway', 'twist', 'roll', 'pitch', 'vib', 'lube', 'pump', 'suck', 'valve']) {
      const name = targetFileName(VIDEO, suffix);
      expect(parseAxisSuffix(name)?.suffix).toBe(suffix);
      expect(getBaseName(name)).toBe('Izzy Green POV Onlyfans');
    }
  });
});
