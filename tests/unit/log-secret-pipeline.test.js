/**
 * @vitest-environment node
 * The REAL electron/logger.js writing a real file in a temp dir; no DOM.
 * See notes/CLAUDE.md "Test environments".
 */
// FT-010. Secrets used to be masked only at the call sites that knew they
// held one, and log-redact.js ran only while "Hide file names in logs" was on
// (default off) and only knew file names. These tests log through the real
// configured logger with that toggle OFF and read the file back, because what
// lands in main.log (and from there in a GitHub issue body) is the contract,
// not which function ran.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// The SAME module instances main uses: logger.js require()s log-redact, so an
// ESM import of log-redact here would be a second copy whose registered
// literals the logger never sees.
const require = createRequire(import.meta.url);
const {
  setRedactionEnabled, isRedactionEnabled, clearSecretLiterals, noteSecretSetting,
} = require('../../electron/log-redact.js');

let log;
let dir;
let file;
let restore;

beforeAll(() => {
  log = require('../../electron/logger.js');
  dir = mkdtempSync(join(tmpdir(), 'funsync-logsecret-'));
  file = join(dir, 'main.log');
  const prevResolve = log.transports.file.resolvePathFn;
  const prevConsole = log.transports.console.level;
  log.transports.file.resolvePathFn = () => file;
  log.transports.console.level = false;
  restore = () => {
    log.transports.file.resolvePathFn = prevResolve;
    log.transports.console.level = prevConsole;
  };
});

afterAll(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setRedactionEnabled(false);
  clearSecretLiterals();
  writeFileSync(file, '');
});

const written = () => readFileSync(file, 'utf8');

describe('every line written to main.log is masked, toggle off (FT-010)', () => {
  it('the toggle really is off for these tests', () => {
    expect(isRedactionEnabled()).toBe(false);
  });

  it('masks the shapes in a plain string line (main, renderer and backend lines are strings)', () => {
    log.info('apikey=SEKRET123 ApiKey: SEKRET456 _t=SEKRET789');
    log.warn('[Backend] INFO: "GET /x?api_key=SEKRETBK1&y=1 HTTP/1.1" 200 OK');
    const out = written();
    expect(out).not.toContain('SEKRET');
    expect(out).toContain('apikey=[redacted] ApiKey: [redacted] _t=[redacted]');
    expect(out).toContain('api_key=[redacted]&y=1');
  });

  it('masks a secret inside an object argument', () => {
    log.info('[Autoblow] request', { url: '/autoblow/state', headers: { 'x-device-token': 'SEKRETOBJ1' } });
    log.info('[EroScripts]', { Cookie: '_t=SEKRETOBJ2; cf_clearance=SEKRETOBJ3' });
    expect(written()).not.toContain('SEKRET');
  });

  it('masks a secret inside an Error argument', () => {
    log.error('[Handy] status failed:', new Error('request to https://h.example/connected?apikey=SEKRETERR1 failed'));
    const out = written();
    expect(out).not.toContain('SEKRETERR1');
    expect(out).toContain('apikey=[redacted]');
  });

  it('masks a stored key wherever it appears once main has registered it', () => {
    noteSecretSetting('handy.connectionKey', 'TESTKEY01');
    noteSecretSetting('audience.viewers', [{ key: 'VIEWERKEY9', label: 'friend' }]);
    log.info('[Handy] saved key TESTKEY01');
    log.info('[Audience] roster', [{ key: 'VIEWERKEY9' }]);
    const out = written();
    expect(out).not.toContain('TESTKEY01');
    expect(out).not.toContain('VIEWERKEY9');
    expect(out).toContain('[Handy] saved key [redacted]');
  });

  it('leaves file names and lines with no secret exactly as written', () => {
    log.info('Loading video: Alpha Scene.mp4');
    log.info('[Audience] Source 7: no script (none) — viewers stay stopped');
    const out = written();
    expect(out).toContain('[info]  Loading video: Alpha Scene.mp4');
    expect(out).toContain('[info]  [Audience] Source 7: no script (none) — viewers stay stopped');
  });
});
