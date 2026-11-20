/**
 * @vitest-environment node
 * main.js's read-funscript handler, lifted and run against real files; no DOM.
 * See notes/CLAUDE.md "Test environments".
 */
// V57 (app test 2026-11-02): opening a playlist wrote one
// `[error] read-funscript failed: ENOENT ...` line per scriptless video and
// per video on an unplugged drive. Playlist, category and library cards PROBE
// for a sibling `<video>.funscript` to decide on a badge, so a miss there is
// the expected answer, not a failure, and logs are triaged by grepping for
// `[error]`. A real failure (anything but "no such file") must stay an error.
//
// The handler is lifted verbatim from electron/main.js (it cannot be imported
// without Electron) and run against real files, with a logger that records
// the LEVEL of each line, which is what a reader of main.log sees.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as realFs from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mainSrc = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

function liftReadFunscript(log) {
  const start = mainSrc.indexOf("ipcMain.handle('read-funscript'");
  if (start < 0) throw new Error('read-funscript handler not found in main.js');
  const end = mainSrc.indexOf('\n});\n', start) + '\n});\n'.length;
  let handler;
  const ipcMain = { handle: (_name, fn) => { handler = fn; } };
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', 'fs', 'log', mainSrc.slice(start, end))(ipcMain, realFs, log);
  return handler;
}

let dir;
let lines;
let readFunscript;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funsync-readfs-'));
  lines = [];
  const at = (level) => (...args) => lines.push({ level, text: args.join(' ') });
  readFunscript = liftReadFunscript({
    error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('read-funscript log level (V57)', () => {
  it('a scriptless video: no sibling funscript is not an error', async () => {
    const result = await readFunscript(null, join(dir, 'Square OU.funscript'));
    expect(result).toBeNull();
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('a video on an unplugged drive: a missing folder is not an error either', async () => {
    const result = await readFunscript(null, join(dir, 'gone-drive', 'VR', 'Alpha Scene.funscript'));
    expect(result).toBeNull();
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('still records the miss at debug, so a "my script did not load" log shows it', async () => {
    await readFunscript(null, join(dir, 'Square OU.funscript'));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('debug');
    expect(lines[0].text).toContain('ENOENT');
  });

  it('a real failure is still an error', async () => {
    // A directory where a script was expected: EISDIR, not "no such file".
    const notAFile = join(dir, 'Broken.funscript');
    mkdirSync(notAFile);
    const result = await readFunscript(null, notAFile);
    expect(result).toBeNull();
    expect(lines.map((l) => l.level)).toEqual(['error']);
  });

  it('a script that exists still reads, BOM stripped, with nothing logged', async () => {
    const p = join(dir, 'Alpha Scene.funscript');
    writeFileSync(p, '﻿{"actions":[]}');
    expect(await readFunscript(null, p)).toBe('{"actions":[]}');
    expect(lines).toEqual([]);
  });
});
