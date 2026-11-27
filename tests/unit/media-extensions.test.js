/**
 * @vitest-environment node
 * Node: real files in a temp folder and the main process's scan. See
 * notes/CLAUDE.md "Test environments".
 */
// Dave, 2026-11-26: "if they can be converted then we should show them". The
// library listed only mp4 / m4v / mkv / webm / avi / mov (and five audio
// types): .wmv, .mpg, .vob, .ts, .flv, .3gp, .ogv... never appeared, so
// Convert to play could not reach them. They are listed now; a .ts file only
// when it really is an MPEG transport stream (a TypeScript source in
// Downloads is not a video).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ext = require('../../electron/media-extensions.js');
const { scanLibrary } = require('../../electron/library-scan.js');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-media-ext-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Two MPEG-TS packets: the sync byte 0x47 at 0 and 188. */
function transportStream(file) {
  const buf = Buffer.alloc(376, 0xff);
  buf[0] = 0x47; buf[188] = 0x47;
  fs.writeFileSync(file, buf);
}

describe('the media types', () => {
  it('the older formats are listed; the renderer\'s drag and drop list is the same', () => {
    for (const e of ['.wmv', '.asf', '.mpg', '.mpeg', '.vob', '.ts', '.m2ts', '.mts', '.flv', '.f4v', '.3gp', '.3g2', '.ogv', '.divx']) {
      expect(ext.VIDEO_EXTS, e).toContain(e);
    }
    const dd = fs.readFileSync('renderer/js/drag-drop.js', 'utf8');
    const list = /const VIDEO_EXTENSIONS = \[([\s\S]*?)\];/.exec(dd)[1].match(/'\.[a-z0-9]+'/g).map((s) => s.slice(1, -1));
    expect([...list].sort()).toEqual([...ext.MEDIA_EXTS].sort());
  });

  it('a .ts transport stream is a video; a TypeScript file, a short file or a missing one is not', async () => {
    transportStream(path.join(dir, 'show.ts'));
    fs.writeFileSync(path.join(dir, 'app.ts'), "import { x } from './y';\nexport const z = 1;\n".repeat(10));
    fs.writeFileSync(path.join(dir, 'tiny.ts'), Buffer.from([0x47, 0x00]));
    expect(await ext.isTransportStream(path.join(dir, 'show.ts'))).toBe(true);
    expect(await ext.isTransportStream(path.join(dir, 'app.ts'))).toBe(false);
    expect(await ext.isTransportStream(path.join(dir, 'tiny.ts'))).toBe(false);
    expect(await ext.isTransportStream(path.join(dir, 'missing.ts'))).toBe(false);
  });
});

describe('the library scan', () => {
  it('lists .wmv, .mpg, .flv and a real .ts; not a TypeScript file; pairs their scripts as before', async () => {
    fs.writeFileSync(path.join(dir, 'Old Clip.wmv'), 'x');
    fs.writeFileSync(path.join(dir, 'Old Clip.funscript'), '{"actions":[]}');
    fs.writeFileSync(path.join(dir, 'Home Movie.mpg'), 'x');
    fs.writeFileSync(path.join(dir, 'Flash.flv'), 'x');
    transportStream(path.join(dir, 'Recording.ts'));
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n'.repeat(20));
    const result = await scanLibrary(dir, {}, { log: { info() {}, warn() {}, error() {} } });
    const videos = Array.isArray(result) ? result : result.videos;
    const names = videos.map((v) => v.name).sort();
    expect(names).toEqual(['Flash.flv', 'Home Movie.mpg', 'Old Clip.wmv', 'Recording.ts']);
    const wmv = videos.find((v) => v.name === 'Old Clip.wmv');
    expect(wmv.hasFunscript).toBe(true);
  });
});
