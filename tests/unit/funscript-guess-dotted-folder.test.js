/**
 * @vitest-environment jsdom
 *
 * FT-069 / FT-070 (found by reading, also in v0.9.2; fixed 2026-11-22): the
 * playlist and category views' fallback guess of a video's script, and the
 * editor's own script path, cut `<name>.funscript` with /\.[^/.]+$/. On
 * Windows that cut from a FOLDER's dot when the file had no extension
 * (C:\Lib.d\Clip -> C:\Lib.funscript). They now stop at a backslash too, as
 * library.js resolvePlayData always did.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { Playlists } from '../../renderer/components/playlists.js';
import { Categories } from '../../renderer/components/categories.js';

const host = { _library: null, _settings: { get: () => ({}) } };

describe('the fallback script guess keeps the video\'s folder', () => {
  for (const [name, guess] of [
    ['Playlists', (p) => Playlists.prototype._getFunscriptPath.call(host, p)],
    ['Categories', (p) => Categories.prototype._resolveFunscriptPath.call(host, p)],
  ]) {
    it(`${name}: a dotted folder and a file with no extension`, () => {
      expect(guess('C:\\Lib.d\\Clip')).toBe('C:\\Lib.d\\Clip');            // nothing to swap: the path as it is
      expect(guess('C:\\Lib.d\\Clip.mp4')).toBe('C:\\Lib.d\\Clip.funscript');
      expect(guess('/home/me/lib.d/Clip.mkv')).toBe('/home/me/lib.d/Clip.funscript');
    });
  }

  it('the editor\'s own script path uses the same rule', () => {
    const src = fs.readFileSync('renderer/components/script-editor.js', 'utf8');
    expect(src).toContain("const funscriptPath = videoPath.replace(/\\.[^/\\\\.]+$/, '') + '.funscript';");
    expect(src).not.toContain("videoPath.replace(/\\.[^/.]+$/, '') + '.funscript'");
  });
});
