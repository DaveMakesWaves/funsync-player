/**
 * @vitest-environment node
 * Pure string work, no DOM. See notes/CLAUDE.md "Test environments".
 */
// Optional log redaction, added 2026-08-16.
//
// FunSync now asks users to paste main.log when reporting a bug. That log
// records the full path of every video opened, and for this app the FILENAME
// is the most revealing thing in it. This is the opt-in that makes pasting
// one a deliberate choice instead of an accident.
//
// The contract, and the reason the tests are shaped this way:
//   * the NAME is hidden
//   * the DIRECTORY survives, because that is what makes a log diagnostic
//     (drive letters, NAS mounts, a source that just went offline)
//   * the EXTENSION survives, because .mkv vs .mp4 is a real distinction
//   * it is OFF unless switched on
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  redactFileNames, maybeRedact, setRedactionEnabled, isRedactionEnabled, PLACEHOLDER,
} from '../../electron/log-redact.js';

describe('redactFileNames', () => {
  it('hides the name but keeps the directory and extension', () => {
    const out = redactFileNames('Loading video: D:\\VR\\SLR_VRBangers_Beach_Day.mp4');
    expect(out).toContain('D:\\VR\\');
    expect(out).toContain('.mp4');
    expect(out).toContain(PLACEHOLDER);
    expect(out).not.toContain('Beach_Day');
    expect(out).not.toContain('VRBangers');
  });

  it('keeps forward-slash paths intact', () => {
    const out = redactFileNames('/home/dave/videos/My Private Clip.mkv');
    expect(out).toContain('/home/dave/videos/');
    expect(out).toContain('.mkv');
    expect(out).not.toContain('Private');
  });

  it('handles UNC and network paths, which are the ones worth diagnosing', () => {
    const out = redactFileNames('\\\\NAS\\media\\Some Scene Name.mp4');
    expect(out).toContain('\\\\NAS\\media\\');
    expect(out).not.toContain('Scene Name');
  });

  it('handles names containing spaces', () => {
    const out = redactFileNames('D:\\A\\Some Long Name With Spaces.mp4');
    expect(out).not.toContain('Long Name With Spaces');
    expect(out).toContain('.mp4');
  });

  // The backend logs paths URL-encoded. Missing this would have made the
  // feature look like it worked while the single most common line in the
  // file leaked anyway.
  it('redacts URL-encoded paths from backend request lines', () => {
    const line = 'INFO: "POST /thumbnails/single?video_path=D%3A%5CVR%5CSecret Clip.mp4&width=320"';
    const out = redactFileNames(line);
    expect(out).not.toContain('Secret Clip');
    expect(out).toContain('.mp4');
  });

  // The encoded DIRECTORY has to survive too, and this is where the first
  // implementation failed: a separate second pass for encoded paths meant
  // the plain pass got there first and ate `video_path=D%3A%5CVideos%5CMy
  // Clip` whole as a "filename". It looked redacted, and it had destroyed
  // exactly the part that makes a log diagnostic. One separator-aware pass,
  // not two competing ones.
  it('keeps the encoded directory, not just the extension', () => {
    const out = redactFileNames(
      'INFO: "POST /thumbnails/single?video_path=D%3A%5CVideos%5CMy Clip.mp4&seek_pct=0.1"');
    expect(out).toContain('video_path=D%3A%5CVideos%5C');
    expect(out).toContain('[hidden].mp4');
    expect(out).toContain('&seek_pct=0.1');
    expect(out).not.toContain('My Clip');
  });

  it('keeps the query parameter name so the line still parses as a request', () => {
    const out = redactFileNames('GET /x?video_path=/mnt/nas/Some Name.mkv HTTP/1.1');
    expect(out).toContain('video_path=/mnt/nas/');
    expect(out).toContain('HTTP/1.1');
  });

  it('redacts funscripts and subtitles too', () => {
    for (const [name, frag] of [
      ['D:\\x\\Scene Name.funscript', 'Scene Name'],
      ['D:\\x\\Scene Name.srt', 'Scene Name'],
    ]) {
      expect(redactFileNames(name)).not.toContain(frag);
    }
  });

  it('redacts every occurrence on a line, not just the first', () => {
    const out = redactFileNames('copy D:\\a\\First One.mp4 to E:\\b\\Second One.mp4');
    expect(out).not.toContain('First One');
    expect(out).not.toContain('Second One');
  });

  // Diagnostic value must survive: these lines are how device and startup
  // problems get solved and contain nothing personal.
  it('leaves non-media lines completely alone', () => {
    for (const line of [
      '[Handy] connect(••••BqeK) — requesting…',
      '[Buttplug] Device added: "Hismith" (index 3) outputs=[Oscillate]',
      'INFO: Uvicorn running on http://0.0.0.0:5123',
      '[Timing main] startBackend (parallel with window): 2784ms',
      'Update for version 0.9.1 is not available',
    ]) {
      expect(redactFileNames(line)).toBe(line);
    }
  });

  it('does not touch source files or logs, which are not user content', () => {
    const line = 'at loadVideo (renderer/js/app.js:4380)';
    expect(redactFileNames(line)).toBe(line);
    expect(redactFileNames('writing main.log')).toBe('writing main.log');
  });

  it('survives junk input', () => {
    for (const v of [null, undefined, '', 123, {}]) {
      expect(() => redactFileNames(v)).not.toThrow();
    }
  });
});

describe('the toggle', () => {
  beforeEach(() => setRedactionEnabled(false));

  it('is off by default, so nothing changes for existing users', () => {
    expect(isRedactionEnabled()).toBe(false);
    const line = 'Loading video: D:\\VR\\Clip Name.mp4';
    expect(maybeRedact(line)).toBe(line);
  });

  it('redacts once switched on', () => {
    setRedactionEnabled(true);
    expect(maybeRedact('Loading video: D:\\VR\\Clip Name.mp4')).not.toContain('Clip Name');
  });

  it('can be switched back off without a restart', () => {
    setRedactionEnabled(true);
    setRedactionEnabled(false);
    const line = 'Loading video: D:\\VR\\Clip Name.mp4';
    expect(maybeRedact(line)).toBe(line);
  });
});

// The wiring, not the logic. This caught a real bug: store.setSetting
// prefixes 'settings.' ITSELF, so the path arriving over IPC is unprefixed.
// The first draft of main.js compared against 'settings.security.…' and read
// the boot value with the same wrong key, which made the toggle a silent
// no-op that still looked saved in the UI. Same shape as every other bug
// this session: a real failure wearing a success costume.
describe('settings wiring', () => {
  const mainSrc = readFileSync(
    new URL('../../electron/main.js', import.meta.url), 'utf8');
  const storeSrc = readFileSync(
    new URL('../../electron/store.js', import.meta.url), 'utf8');
  const dsSrc = readFileSync(
    new URL('../../renderer/js/data-service.js', import.meta.url), 'utf8');

  it('store.setSetting adds the settings prefix, so callers must not', () => {
    expect(storeSrc).toMatch(/conf\.set\(`settings\.\$\{path\}`/);
  });

  it('main compares the UNPREFIXED key', () => {
    expect(mainSrc).toContain("path === 'security.hideLogFileNames'");
    expect(mainSrc).not.toContain("'settings.security.hideLogFileNames'");
  });

  it('the renderer writes the same unprefixed key the panel reads', () => {
    const panel = readFileSync(
      new URL('../../renderer/components/settings-panel.js', import.meta.url), 'utf8');
    expect(panel).toContain("set('security.hideLogFileNames'");
    expect(panel).toContain("get('security.hideLogFileNames')");
  });

  it('the default exists on both sides and is OFF', () => {
    expect(storeSrc).toMatch(/hideLogFileNames:\s*false/);
    expect(dsSrc).toMatch(/hideLogFileNames:\s*false/);
  });

  it('the logger applies redaction through the shared hook', () => {
    const loggerSrc = readFileSync(
      new URL('../../electron/logger.js', import.meta.url), 'utf8');
    expect(loggerSrc).toContain('maybeRedact');
    expect(loggerSrc).toContain('log.hooks.push');
  });
});
