/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Backend output was logged at the level of the STREAM it arrived on, not the
// level Python meant.
//
// Python's logging writes INFO to stderr by default and uvicorn follows suit,
// so `pythonProcess.stderr -> log.error` turned the entire access log into
// error lines. Welliambrisk's log (2026-08-27) has six [error] entries and
// four of them are uvicorn reporting that it had started successfully:
//
//   [error] [Backend] INFO:     Started server process [11116]
//   [error] [Backend] INFO:     Application startup complete.
//
// A log where routine success is an error is a log nobody can grep, and these
// reports are read by grepping. The level prefix is the signal; the stream is
// noise. What must NOT change: an unprefixed stderr line — which is what a
// Python traceback looks like — stays an error.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

// Required, not imported: python-bridge is CommonJS, and `vi.mock` cannot
// intercept the `require('./logger')` inside it — hence the injectable sink
// rather than a mocked logger. See notes/CLAUDE.md and the vitest gotchas note.
const require_ = createRequire(import.meta.url);
const { logBackendChunk } = require_('../../electron/python-bridge.js');

const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();
const sink = { info, warn, error };

beforeEach(() => {
  info.mockClear();
  warn.mockClear();
  error.mockClear();
});

const levelsOf = () => ({
  info: info.mock.calls.map((c) => c[0]),
  warn: warn.mock.calls.map((c) => c[0]),
  error: error.mock.calls.map((c) => c[0]),
});

describe('uvicorn chatter on stderr is not an error', () => {
  it('logs the two lines from the report at info, not error', () => {
    logBackendChunk('INFO:     Started server process [11116]', 'error', sink);
    logBackendChunk('INFO:     Application startup complete.', 'error', sink);
    const l = levelsOf();
    expect(l.error).toEqual([]);
    expect(l.info).toHaveLength(2);
    expect(l.info[0]).toContain('Started server process');
  });

  it('routes an access-log line to info', () => {
    logBackendChunk('INFO:     127.0.0.1:53134 - "WebSocket /api/remote/sync/observe" [accepted]', 'error', sink);
    expect(levelsOf().error).toEqual([]);
    expect(levelsOf().info).toHaveLength(1);
  });

  it('routes WARNING to warn and ERROR to error, whichever stream they came on', () => {
    logBackendChunk('WARNING:  ffmpeg not found on PATH', 'info', sink);
    logBackendChunk('ERROR:    thumbnail generation failed', 'info', sink);
    const l = levelsOf();
    expect(l.warn).toHaveLength(1);
    expect(l.error).toHaveLength(1);
    expect(l.info).toEqual([]);
  });

  it('treats CRITICAL and FATAL as errors', () => {
    logBackendChunk('CRITICAL: unrecoverable', 'info', sink);
    logBackendChunk('FATAL: gone', 'info', sink);
    expect(levelsOf().error).toHaveLength(2);
  });
});

describe('real failures stay loud', () => {
  it('keeps an unprefixed stderr line at error — that is what a traceback is', () => {
    logBackendChunk('Traceback (most recent call last):', 'error', sink);
    logBackendChunk('  File "main.py", line 12, in <module>', 'error', sink);
    logBackendChunk('ZeroDivisionError: division by zero', 'error', sink);
    const l = levelsOf();
    expect(l.error).toHaveLength(3);
    expect(l.info).toEqual([]);
  });

  it('keeps an unprefixed stdout line at info', () => {
    logBackendChunk('[ffmpeg] bundled=true', 'info', sink);
    expect(levelsOf().info).toHaveLength(1);
    expect(levelsOf().error).toEqual([]);
  });
});

// FT-042: backend/main.py prints its PATH-fallback warning to STDOUT behind a
// `[ffmpeg]` tag, so the start-of-line anchor never saw the level and the one
// line that explains "thumbnails fail for every video" landed at [info].
describe('a level after a leading [tag]', () => {
  it('routes the PATH-fallback warning from stdout to warn', () => {
    logBackendChunk(
      '[ffmpeg] WARNING: falling back to PATH for at least one binary. If ffmpeg is not installed system-wide, thumbnails and metadata will fail for EVERY video.',
      'info',
      sink,
    );
    const l = levelsOf();
    expect(l.warn).toHaveLength(1);
    expect(l.warn[0]).toContain('[Backend] [ffmpeg] WARNING: falling back to PATH');
    expect(l.info).toEqual([]);
  });

  it('keeps the ffmpeg banner line at info', () => {
    logBackendChunk(
      '[ffmpeg] ffmpeg=C:\\FunSync\\ffmpeg\\ffmpeg.exe (bundled=True) ffprobe=C:\\FunSync\\ffmpeg\\ffprobe.exe (bundled=True) frozen=True',
      'info',
      sink,
    );
    expect(levelsOf().info).toHaveLength(1);
    expect(levelsOf().warn).toEqual([]);
    expect(levelsOf().error).toEqual([]);
  });

  it('routes a tagged ERROR to error and a tagged INFO on stderr to info', () => {
    logBackendChunk('[Thumb] ERROR: ffmpeg exited 1', 'info', sink);
    logBackendChunk('[Scan] INFO: 12 files', 'error', sink);
    const l = levelsOf();
    expect(l.error).toHaveLength(1);
    expect(l.error[0]).toContain('[Thumb] ERROR');
    expect(l.info).toHaveLength(1);
  });

  it('does not promote a tagged line whose next word only spells a level', () => {
    // `[remote-seek] <kind> ...` carries a label the phone sends.
    logBackendChunk('[remote-seek] error to=12.0s d=+3.0s buffered=miss', 'info', sink);
    expect(levelsOf().info).toHaveLength(1);
    expect(levelsOf().error).toEqual([]);
  });

  it('still keeps an unprefixed traceback line on stderr at error', () => {
    logBackendChunk('[WinError 2] The system cannot find the file specified', 'error', sink);
    expect(levelsOf().error).toHaveLength(1);
  });
});

describe('chunking', () => {
  it('classifies each line of a multi-line chunk separately', () => {
    // A single stderr `data` event routinely carries several lines, and the
    // old code stamped one level on the whole blob.
    logBackendChunk(
      'INFO:     Application startup complete.\nERROR:    something broke\nWARNING:  and something else\n',
      'error',
      sink,
    );
    const l = levelsOf();
    expect(l.info).toHaveLength(1);
    expect(l.error).toHaveLength(1);
    expect(l.warn).toHaveLength(1);
  });

  it('handles CRLF and drops blank lines', () => {
    logBackendChunk('INFO:     one\r\n\r\nINFO:     two\r\n', 'error', sink);
    expect(levelsOf().info).toHaveLength(2);
  });

  it('logs nothing at all for an empty or whitespace chunk', () => {
    logBackendChunk('', 'error', sink);
    logBackendChunk('   \n\n', 'error', sink);
    const l = levelsOf();
    expect(l.info).toEqual([]);
    expect(l.warn).toEqual([]);
    expect(l.error).toEqual([]);
  });

  it('prefixes every line with [Backend] so the source stays greppable', () => {
    logBackendChunk('INFO:     hello', 'error', sink);
    expect(levelsOf().info[0]).toMatch(/^\[Backend\] /);
  });
});
