/**
 * @vitest-environment node
 * main.js's generate-single-thumbnail handler, lifted and run with a fake
 * backend; no DOM. See notes/CLAUDE.md "Test environments".
 */
// App test 2026-11-02:
//   V32: a failed thumbnail logged the first 400 characters of the backend's
//        detail. ffmpeg's stderr OPENS with its version/build banner and ENDS
//        with the error, so every failure line carried the banner and never
//        the reason.
//   V33: "[Thumbnails] N consecutive failures with no successes ... broken for
//        this whole library" fired after any 10 failures in a row, even after
//        hundreds of good thumbnails in the same session.
//
// The handler is lifted verbatim from electron/main.js (it cannot be imported
// without Electron) together with `_errorDetail` and the streak state, and run
// against a fake backend. Assertions are on the log LINES a reader of main.log
// sees, with their level.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realFs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mainSrc = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

function liftThumbnailHandler({ log, fetchWithTimeout }) {
  const start = mainSrc.indexOf('async function _errorDetail(resp)');
  const handlerAt = mainSrc.indexOf("ipcMain.handle('generate-single-thumbnail'");
  if (start < 0 || handlerAt < start) throw new Error('thumbnail handler not found in main.js');
  const end = mainSrc.indexOf('\n});\n', handlerAt) + '\n});\n'.length;
  let handler;
  const ipcMain = { handle: (_name, fn) => { handler = fn; } };
  const requireShim = (id) => {
    if (id === './python-bridge') return { getBackendPort: () => 5123 };
    throw new Error(`unexpected require(${id})`);
  };
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', 'fs', 'log', 'fetchWithTimeout', 'require', mainSrc.slice(start, end))(
    ipcMain, realFs, log, fetchWithTimeout, requireShim,
  );
  return handler;
}

// What a real ffmpeg failure looked like before the backend fix: banner
// first, the cause last.
const BANNER = 'ffmpeg version 8.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\n'
  + '  built with gcc 15.2.0 (Rev8, Built by MSYS2 project)\n'
  + `  configuration: --enable-gpl --enable-version3 --enable-static ${'--enable-libfoo '.repeat(60)}\n`
  + '  libavutil      60.  8.100 / 60.  8.100\n';
const CAUSE = '[out#0/image2] Nothing was written into output file, because at least one of its streams received no packets.\nConversion failed!';

let dir;
let jpeg;
let lines;
let nextResponse;
let thumbnail;

const ok = () => ({ ok: true, status: 200, json: async () => ({ path: jpeg, duration: 5, width: 320, height: 180 }) });
const fail = (detail) => ({ ok: false, status: 500, json: async () => ({ detail }) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funsync-thumblog-'));
  jpeg = join(dir, 'thumb.jpg');
  writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff]));
  lines = [];
  const at = (level) => (...args) => lines.push({ level, text: args.join(' ') });
  nextResponse = ok;
  thumbnail = liftThumbnailHandler({
    log: { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') },
    fetchWithTimeout: async () => nextResponse(),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(n, response) {
  nextResponse = response;
  for (let i = 0; i < n; i++) await thumbnail(null, join(dir, `clip ${i}.mp4`));
}

describe('thumbnail failure log carries the cause, not the banner (V32)', () => {
  it('a long ffmpeg detail keeps its END in the log line', async () => {
    await run(1, () => fail(`ffmpeg single-thumbnail failed: ${BANNER}${CAUSE}`));
    const warns = lines.filter(l => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('Nothing was written into output file');
    expect(warns[0].text).toContain('Conversion failed!');
    expect(warns[0].text).not.toContain('configuration:');
  });

  // E2-04: a detail with line breaks split the warning in main.log; the lines
  // after the first had no timestamp or level, so a grep for [warn] lost the
  // cause. One line now, whatever the backend sends.
  it('a multi-line detail is logged as ONE line, its cause still on it', async () => {
    await run(1, () => fail('ffprobe failed:\r\n  C:\\sandbox\\Corrupt Bytes.mp4:\tInvalid data found when processing input\n\n'));
    const warns = lines.filter(l => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).not.toMatch(/[\r\n\t]/);
    expect(warns[0].text).toContain('Backend returned 500 — ffprobe failed: C:\\sandbox\\Corrupt Bytes.mp4: Invalid data found when processing input');
  });

  it('a short detail is logged whole', async () => {
    await run(1, () => fail('ffmpeg not found. Install ffmpeg to use thumbnail features.'));
    expect(lines[0].text).toContain('Backend returned 500 — ffmpeg not found. Install ffmpeg to use thumbnail features.');
  });

  it('a successful thumbnail still comes back', async () => {
    nextResponse = ok;
    const out = await thumbnail(null, join(dir, 'clip.mp4'));
    expect(out.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(lines).toEqual([]);
  });
});

describe('"no successes" escalation fires only when nothing succeeded (V33)', () => {
  const escalations = () => lines.filter(l => l.level === 'error' && l.text.includes('[Thumbnails]'));

  it('one success, then ten failures: per-file warnings only, no "whole library" error', async () => {
    await run(1, ok);
    await run(10, () => fail(`ffmpeg single-thumbnail failed: ${CAUSE}`));
    expect(lines.filter(l => l.level === 'warn')).toHaveLength(10);
    expect(escalations()).toEqual([]);
  });

  it('hundreds of successes, then a long failing run: still no "no successes" claim', async () => {
    await run(300, ok);
    await run(40, () => fail(`ffmpeg single-thumbnail failed: ${CAUSE}`));
    expect(escalations()).toEqual([]);
  });

  it('a real outage (ten failures, nothing ever succeeded) escalates once, with the last error', async () => {
    await run(25, () => fail('ffmpeg not found. Install ffmpeg to use thumbnail features.'));
    const errs = escalations();
    expect(errs).toHaveLength(1);
    expect(errs[0].text).toContain('10 consecutive failures with no successes');
    expect(errs[0].text).toContain('Last error: Backend returned 500 — ffmpeg not found');
  });

  it('nine failures are not an outage yet', async () => {
    await run(9, () => fail('boom'));
    expect(escalations()).toEqual([]);
  });
});

// verify-2 (2026-11-07; also in v0.9.2): the library asks for a card's
// thumbnail again on every grid render, and nothing remembered a failure, so a
// corrupt clip went to ffprobe 11 times in 6 minutes, each a 500 and a warning.
describe('a thumbnail the backend failed is not asked again for the same file', () => {
  let calls;
  let clip;

  beforeEach(() => {
    calls = 0;
    clip = join(dir, 'Corrupt Bytes.mp4');
    writeFileSync(clip, Buffer.alloc(4096, 7));
    thumbnail = liftThumbnailHandler({
      log: { error: () => {}, warn: (...a) => lines.push({ level: 'warn', text: a.join(' ') }), info: () => {}, debug: () => {} },
      fetchWithTimeout: async () => { calls++; return nextResponse(); },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('a 500: asked once, then the placeholder (null) with no request and no warning', async () => {
    nextResponse = () => fail('ffprobe failed: Invalid data found when processing input');
    for (let i = 0; i < 5; i++) expect(await thumbnail(null, clip)).toBeNull();
    expect(calls).toBe(1);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  });

  it('the same file edited or replaced (new size / mtime) is asked again, and a success comes back', async () => {
    nextResponse = () => fail('ffprobe failed: Invalid data');
    await thumbnail(null, clip);
    writeFileSync(clip, Buffer.alloc(8192, 9));
    nextResponse = ok;
    const out = await thumbnail(null, clip);
    expect(calls).toBe(2);
    expect(out.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('after ten minutes it is asked again', async () => {
    nextResponse = () => fail('ffprobe failed: Invalid data');
    await thumbnail(null, clip);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);
    await thumbnail(null, clip);
    expect(calls).toBe(2);
  });

  it('a backend that did not answer (timeout, not running) is asked every time', async () => {
    nextResponse = () => { throw new Error('fetch failed'); };
    for (let i = 0; i < 3; i++) await thumbnail(null, clip);
    expect(calls).toBe(3);
  });

  it('a user-picked frame (exact) is always asked', async () => {
    nextResponse = () => fail('ffprobe failed: Invalid data');
    await thumbnail(null, clip);
    await thumbnail(null, clip, { exact: true, seekPct: 0.4 });
    await thumbnail(null, clip, { exact: true, seekPct: 0.4 });
    expect(calls).toBe(3);
  });

  it('nothing is written or removed: the clip is still there, unchanged', async () => {
    nextResponse = () => fail('ffprobe failed: Invalid data');
    await thumbnail(null, clip);
    await thumbnail(null, clip);
    expect(readFileSync(clip)).toEqual(Buffer.alloc(4096, 7));
  });
});
