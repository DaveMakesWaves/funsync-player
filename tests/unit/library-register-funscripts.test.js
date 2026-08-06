/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Registering newly-created funscripts into the cached scan list.
//
// Regression (Dave, live test 2026-08-06): downloading a multi-axis set from
// the inline EroScripts search saved the association correctly, but the
// association modal reopened with EVERY field blank. The modal builds its
// dropdowns from `_allFunscripts` — a scan cached when the library loaded —
// and matches a saved value with `allScripts.find(s => s.path === preValue)`.
// Files written after that scan have no matching option, so the field renders
// empty. Saving from that state would then overwrite the good association
// with blanks.
import { describe, it, expect, beforeEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

function makeLibrary(existing = []) {
  const lib = Object.create(Library.prototype);
  lib._allFunscripts = existing.slice();
  return lib;
}

describe('Library.registerFunscripts', () => {
  let lib;

  beforeEach(() => {
    lib = makeLibrary([{ name: 'Old.funscript', path: 'D:/v/Old.funscript' }]);
  });

  it('adds a downloaded script so the modal can match it', () => {
    lib.registerFunscripts([{ name: 'New.funscript', path: 'D:/v/New.funscript' }]);
    const match = lib.getAllFunscripts().find((s) => s.path === 'D:/v/New.funscript');
    expect(match).toEqual({ name: 'New.funscript', path: 'D:/v/New.funscript' });
  });

  it('adds a whole multi-axis set', () => {
    lib.registerFunscripts([
      { path: 'D:/v/Clip.funscript' },
      { path: 'D:/v/Clip.roll.funscript' },
      { path: 'D:/v/Clip.pitch.funscript' },
    ]);
    const paths = lib.getAllFunscriptPaths();
    expect(paths).toContain('D:/v/Clip.funscript');
    expect(paths).toContain('D:/v/Clip.roll.funscript');
    expect(paths).toContain('D:/v/Clip.pitch.funscript');
  });

  it('derives the display name from the path when not given', () => {
    lib.registerFunscripts([{ path: 'D:/v/Clip.roll.funscript' }]);
    const entry = lib.getAllFunscripts().find((s) => s.path === 'D:/v/Clip.roll.funscript');
    expect(entry.name).toBe('Clip.roll.funscript');
  });

  it('derives the name from a Windows path too', () => {
    lib.registerFunscripts([{ path: 'D:\\v\\Clip.pitch.funscript' }]);
    const entry = lib.getAllFunscripts().find((s) => s.path.endsWith('Clip.pitch.funscript'));
    expect(entry.name).toBe('Clip.pitch.funscript');
  });

  it('is idempotent — re-registering does not duplicate', () => {
    const entry = { name: 'New.funscript', path: 'D:/v/New.funscript' };
    lib.registerFunscripts([entry]);
    lib.registerFunscripts([entry]);
    expect(lib.getAllFunscripts().filter((s) => s.path === 'D:/v/New.funscript')).toHaveLength(1);
  });

  it('preserves entries from the original scan', () => {
    lib.registerFunscripts([{ path: 'D:/v/New.funscript' }]);
    expect(lib.getAllFunscriptPaths()).toContain('D:/v/Old.funscript');
  });

  it('tolerates empty, malformed and missing input', () => {
    expect(() => lib.registerFunscripts([])).not.toThrow();
    expect(() => lib.registerFunscripts(null)).not.toThrow();
    lib.registerFunscripts([null, {}, { path: '' }]);
    expect(lib.getAllFunscripts()).toHaveLength(1);
  });

  it('initialises the list when the library never scanned', () => {
    const bare = Object.create(Library.prototype);
    bare._allFunscripts = undefined;
    bare.registerFunscripts([{ path: 'D:/v/Only.funscript' }]);
    expect(bare.getAllFunscriptPaths()).toEqual(['D:/v/Only.funscript']);
  });
});
