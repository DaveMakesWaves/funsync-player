/**
 * @vitest-environment node
 * Real files in a temp dir and main.js handlers lifted with fakes; no DOM.
 * See notes/CLAUDE.md "Test environments".
 */
// V56 (app test 2026-11-02): switching "Hide file names in logs" on left every
// earlier line of main.log and main.old.log in the clear. The hook in
// logger.js redacts lines as they are WRITTEN, and nothing touched the files
// already on disk. The toggle exists for one flow: hit a bug, switch it on,
// open the log, paste it. In that flow the pasted file still held every title
// opened before the click (the tester's log: 26 "Loading video: Alpha
// Scene.mp4" lines, after the toggle was on).
//
// These tests read the files back from disk, and the main.js tests read the
// file at the moment the app hands it to the OS, because "what the user
// opens" is the contract, not which function ran.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodePath from 'node:path';
import { createRequire } from 'node:module';
import {
  applyRedactionSetting, ensureLogFilesRedacted, redactLogFilesSync, rotatedLogPath,
  setRedactionEnabled, redactSecrets, noteSecretSetting, clearSecretLiterals, SECRET_SETTING_PATHS,
} from '../../electron/log-redact.js';

const require = createRequire(import.meta.url);

// The lines a real session writes, CRLF-terminated like electron-log on
// Windows (it writes os.EOL).
const BEFORE_MAIN = [
  '[2026-11-01 21:05:10.101] [info]  Loading video: Alpha Scene.mp4',
  '[2026-11-01 21:05:10.140] [info]  Funscript loaded: {"filename":"Alpha Scene.funscript","version":"1.0","actionCount":33}',
  '[2026-11-01 21:05:12.002] [info]  [Backend] INFO:     127.0.0.1:63503 - "GET /health HTTP/1.1" 200 OK',
  String.raw`[2026-11-01 21:05:13.474] [warn]  Single thumbnail failed for C:\Lib\Alpha Scene.mp4: Backend returned 500`,
  '',
].join('\r\n');
const AFTER_MAIN = [
  '[2026-11-01 21:05:10.101] [info]  Loading video: [hidden].mp4',
  '[2026-11-01 21:05:10.140] [info]  Funscript loaded: {"filename":"[hidden].funscript","version":"1.0","actionCount":33}',
  '[2026-11-01 21:05:12.002] [info]  [Backend] INFO:     127.0.0.1:63503 - "GET /health HTTP/1.1" 200 OK',
  String.raw`[2026-11-01 21:05:13.474] [warn]  Single thumbnail failed for C:\Lib\[hidden].mp4: Backend returned 500`,
  '',
].join('\r\n');
const BEFORE_OLD = "[2026-10-30 09:00:00.000] [info]  Loading video: Tom & Jerry's Clip.mp4\r\n";
const AFTER_OLD = '[2026-10-30 09:00:00.000] [info]  Loading video: [hidden].mp4\r\n';

let dir;
let mainLog;
let oldLog;

beforeEach(() => {
  // Off resets "the files are clean" too, like a fresh boot.
  setRedactionEnabled(false);
  dir = mkdtempSync(join(tmpdir(), 'funsync-logredact-'));
  mainLog = join(dir, 'main.log');
  oldLog = join(dir, 'main.old.log');
  writeFileSync(mainLog, BEFORE_MAIN);
  writeFileSync(oldLog, BEFORE_OLD);
});

afterEach(() => {
  setRedactionEnabled(false);
  rmSync(dir, { recursive: true, force: true });
});

describe('switching the toggle on (V56)', () => {
  it('hides the names already in main.log and main.old.log', () => {
    applyRedactionSetting(true, [mainLog, oldLog]);
    // Whole-file equality: every name gone, every other byte (including the
    // CRLF line endings and the non-media lines) exactly as it was.
    expect(readFileSync(mainLog, 'utf8')).toBe(AFTER_MAIN);
    expect(readFileSync(oldLog, 'utf8')).toBe(AFTER_OLD);
  });

  it('leaves no temp file behind', () => {
    applyRedactionSetting(true, [mainLog, oldLog]);
    expect(readdirSync(dir).sort()).toEqual(['main.log', 'main.old.log']);
  });

  it('hides lines written while it was off when it goes back on', () => {
    applyRedactionSetting(true, [mainLog, oldLog]);
    applyRedactionSetting(false, [mainLog, oldLog]);
    appendFileSync(mainLog, '[2026-11-01 21:10:02.625] [info]  Loading video: Beta Scene.mp4\r\n');

    // Off means off: opening the log changes nothing while it is off.
    ensureLogFilesRedacted([mainLog, oldLog]);
    expect(readFileSync(mainLog, 'utf8')).toContain('Beta Scene');

    applyRedactionSetting(true, [mainLog, oldLog]);
    expect(readFileSync(mainLog, 'utf8')).not.toContain('Beta Scene');
  });

  it('skips a main.old.log that does not exist yet, and does not create one', () => {
    rmSync(oldLog);
    const results = applyRedactionSetting(true, [mainLog, oldLog]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(existsSync(oldLog)).toBe(false);
    expect(readFileSync(mainLog, 'utf8')).toBe(AFTER_MAIN);
  });
});

describe('opening the log with the setting already on (V56)', () => {
  // On at boot: the setting is read from the store long after the log began,
  // and the files may hold lines from an older version whose pattern missed
  // these names entirely.
  it('rewrites the files before they are handed over', () => {
    setRedactionEnabled(true);
    ensureLogFilesRedacted([mainLog, oldLog]);
    expect(readFileSync(mainLog, 'utf8')).toBe(AFTER_MAIN);
    expect(readFileSync(oldLog, 'utf8')).toBe(AFTER_OLD);
  });
});

describe('redactLogFilesSync', () => {
  // Windows refuses a rename over a file another program holds open without
  // delete sharing. The names must still go.
  it('falls back to writing in place when the rename is refused', () => {
    const fsImpl = {
      ...realFs,
      renameSync: () => { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; },
    };
    const results = redactLogFilesSync([mainLog], fsImpl);
    expect(results).toEqual([{ path: mainLog, ok: true, changed: true }]);
    expect(readFileSync(mainLog, 'utf8')).toBe(AFTER_MAIN);
    expect(readdirSync(dir).sort()).toEqual(['main.log', 'main.old.log']);
  });

  it('never lets a name run across a line break', () => {
    // A continuation line with no timestamp (no colon) used to be one
    // candidate "name" with the line above it.
    writeFileSync(mainLog, 'ffmpeg stderr follows\nOpening Clip.mp4\n');
    redactLogFilesSync([mainLog]);
    expect(readFileSync(mainLog, 'utf8')).toBe('ffmpeg stderr follows\n[hidden].mp4\n');
  });
});

describe('rotatedLogPath', () => {
  it('is the file electron-log itself rotates main.log into', async () => {
    const log = (await import('../../electron/logger.js')).default;
    log.transports.file.archiveLogFn({ toString: () => mainLog });
    expect(existsSync(rotatedLogPath(mainLog))).toBe(true);
    expect(readFileSync(rotatedLogPath(mainLog), 'utf8')).toBe(BEFORE_MAIN);
  });
});

// The wiring in electron/main.js, lifted verbatim and driven with fakes. What
// is asserted is the CONTENT of the log at the moment main.js hands it to the
// OS, which is what the user reads and pastes.
describe('main.js hands over a redacted log (V56)', () => {
  // LF whatever the checkout: CI's Windows runner checks out with CRLF (v0.10.0 tag, 2026-11-20).
  const mainSrc = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const lift = (start, end) => {
    const i = mainSrc.indexOf(start);
    if (i < 0) throw new Error(`not found in main.js: ${start}`);
    const j = mainSrc.indexOf(end, i);
    if (j < 0) throw new Error(`no end for: ${start}`);
    return mainSrc.slice(i, j + end.length);
  };

  let handlers;
  let opened;
  let stored;
  let bootRegister;

  beforeEach(() => {
    handlers = {};
    opened = [];
    stored = {};
    clearSecretLiterals();
    const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
    const fakeElectron = {
      shell: {
        openPath: async (p) => {
          // What the user sees: the folder's log files, as they are right now.
          const files = realFs.statSync(p).isDirectory()
            ? [join(p, 'main.log'), join(p, 'main.old.log')]
            : [p];
          opened.push(files.filter(existsSync).map((f) => readFileSync(f, 'utf8')).join(''));
          return '';
        },
      },
    };
    const fakeRequire = (m) => (m === 'electron' ? fakeElectron : require(m));
    const fakeLog = {
      transports: { file: { getFile: () => ({ path: mainLog, reset() {} }) } },
      info() {}, warn() {}, error() {},
    };
    const src = [
      lift('function _logFilePaths()', '\n}\n'),
      lift('function _reportLogRewrite(', '\n}\n'),
      lift("ipcMain.handle('set-setting'", '\n});\n'),
      lift("ipcMain.handle('open-log-file'", '\n});\n'),
      lift("ipcMain.handle('open-log-folder'", '\n});\n'),
      lift("ipcMain.handle('collect-diagnostics'", '\n});\n'),
    ].join('\n');
    const fakeStore = {
      setSetting(p, v) { stored[p] = v; },
      getSetting: (p) => stored[p],
    };
    const injected = {
      ipcMain: fakeIpc, require: fakeRequire, log: fakeLog, path: nodePath, fs: realFs,
      store: fakeStore, app: { getVersion: () => '0.0.0-test' }, getHealthState: () => ({}),
      applyRedactionSetting, ensureLogFilesRedacted, rotatedLogPath, setRedactionEnabled,
      // set-setting also hands the write to the interface-size controller (V79).
      uiScale: { onSettingWritten() {} },
      // Secrets (FT-010): set-setting registers them, the log tail masks them.
      redactSecrets, noteSecretSetting, SECRET_SETTING_PATHS,
      // set-setting hands settings.stash writes to the Stash service (S1).
      stash: { ownsSetting: () => false },
    };
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(injected), src)(...Object.values(injected));
    // The boot-time registration in app.whenReady, lifted the same way.
    // eslint-disable-next-line no-new-func
    const boot = new Function(...Object.keys(injected),
      lift('for (const p of SECRET_SETTING_PATHS)', '\n'));
    bootRegister = () => boot(...Object.values(injected));
  });

  it('turning the toggle on, then Open log file, opens a log with no name in it', async () => {
    await handlers['set-setting'](null, 'security.hideLogFileNames', true);
    await handlers['open-log-file']();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBe(AFTER_MAIN);
  });

  // Not every user opens it through the app: the Help text names the folder,
  // and support threads tell people where it lives.
  it('turning the toggle on rewrites the files on disk at once', async () => {
    await handlers['set-setting'](null, 'security.hideLogFileNames', true);
    expect(readFileSync(mainLog, 'utf8')).toBe(AFTER_MAIN);
    expect(readFileSync(oldLog, 'utf8')).toBe(AFTER_OLD);
  });

  it('with the setting on from boot, Open log file opens a redacted log', async () => {
    setRedactionEnabled(true);
    await handlers['open-log-file']();
    expect(opened[0]).toBe(AFTER_MAIN);
  });

  it('with the setting on from boot, Open log folder shows both files redacted', async () => {
    setRedactionEnabled(true);
    await handlers['open-log-folder']();
    expect(opened[0]).toBe(AFTER_MAIN + AFTER_OLD);
  });

  it('with the setting on from boot, Report a problem gets a redacted log tail', async () => {
    setRedactionEnabled(true);
    const diag = await handlers['collect-diagnostics'](null, {});
    expect(diag.logTail).toContain('Loading video: [hidden].mp4');
    expect(diag.logTail).not.toContain('Alpha Scene');
  });

  it('with the setting off, the log is opened exactly as written', async () => {
    await handlers['open-log-file']();
    expect(opened[0]).toBe(BEFORE_MAIN);
  });

  // FT-010. The tail goes into a GitHub issue body. With the file-name toggle
  // OFF (its default), a key or token in it, including one written by an
  // earlier session or an older version, must not reach the report.
  describe('Report a problem never carries a secret (FT-010)', () => {
    const SECRET_LINES = [
      '[2026-11-04 20:00:00.000] [warn]  fetch failed: GET https://h.example/connected?apikey=SEKRET123',
      '[2026-11-04 20:00:00.100] [info]  ApiKey: SEKRET456 _t=SEKRET789',
      '[2026-11-04 20:00:00.200] [info]  [Handy] old build logged the key TESTKEY01 in full',
      '[2026-11-04 20:00:00.300] [info]  [Audience] viewer VIEWERKEY9 added',
      '',
    ].join('\r\n');

    beforeEach(() => appendFileSync(mainLog, SECRET_LINES));

    it('masks every shape in the tail, toggle off', async () => {
      const diag = await handlers['collect-diagnostics'](null, {});
      expect(diag.logTail).not.toMatch(/SEKRET/);
      expect(diag.logTail).toContain('connected?apikey=[redacted]');
      expect(diag.logTail).toContain('ApiKey: [redacted] _t=[redacted]');
      // The toggle is off, so names stay: only secrets are masked.
      expect(diag.logTail).toContain('Loading video: Alpha Scene.mp4');
    });

    it('masks a key the user saves through set-setting', async () => {
      await handlers['set-setting'](null, 'handy.connectionKey', 'TESTKEY01');
      await handlers['set-setting'](null, 'audience.viewers', [{ key: 'VIEWERKEY9', label: 'friend' }]);
      const diag = await handlers['collect-diagnostics'](null, {});
      expect(diag.logTail).not.toContain('TESTKEY01');
      expect(diag.logTail).not.toContain('VIEWERKEY9');
      expect(diag.logTail).toContain('[Handy] old build logged the key [redacted] in full');
    });

    it('masks a key stored by an earlier session once boot has registered it', async () => {
      stored['handy.connectionKey'] = 'TESTKEY01';
      stored['audience.viewers'] = [{ key: 'VIEWERKEY9' }];
      bootRegister();
      const diag = await handlers['collect-diagnostics'](null, {});
      expect(diag.logTail).not.toContain('TESTKEY01');
      expect(diag.logTail).not.toContain('VIEWERKEY9');
    });
  });
});
