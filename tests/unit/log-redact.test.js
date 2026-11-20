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
  redactSecrets, registerSecretLiterals, clearSecretLiterals, secretLiteralsFromSetting,
  SECRET_SETTING_PATHS,
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
    // Every store write goes through `_write` (it notifies the auto-save
    // snapshot, V05); the prefix is what this pins, not the call's name.
    expect(storeSrc).toMatch(/(?:conf\.set|_write)\(`settings\.\$\{path\}`/);
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

// Lines lifted verbatim from a real main.log (stingray's paste, 2026-08-22).
//
// The 20 tests above all passed while the toggle did essentially nothing on a
// real log: every one of them fed the redactor a full PATH, and the two most
// revealing lines the app writes carry a BARE FILENAME with no directory at
// all. `PATH_RE` required at least one separator, so those never matched.
// Test the strings the app actually logs, not the strings the regex was
// designed around (Dave, 2026-08-23).
describe('real log lines', () => {
  beforeEach(() => setRedactionEnabled(true));
  afterEach(() => setRedactionEnabled(false));

  it('redacts a bare filename with no directory', () => {
    const out = maybeRedact('Loading video: TAKE IT - PMV (extended mix).mp4');
    expect(out).toBe('Loading video: [hidden].mp4');
  });

  it('keeps the label in front of a bare filename', () => {
    // An optional directory lets the name run backwards over whatever
    // precedes it unless the pattern forbids it — this line redacted to a
    // bare "[hidden].mp4" mid-fix, losing what the line was even about.
    const out = maybeRedact('Loading video: Secret Clip.mp4');
    expect(out.startsWith('Loading video: ')).toBe(true);
  });

  it('redacts the filename field of a Funscript loaded line', () => {
    const out = maybeRedact('Funscript loaded: {"filename":"Good Puss TikTok.funscript","version":"1.0"}');
    expect(out).toContain('"filename":"[hidden].funscript"');
    expect(out).toContain('"version":"1.0"');
  });

  it('still keeps the directory when there is one', () => {
    const line = String.raw`[Remote] phone-connected {"videoPath":"C:\\Users\\user\\Downloads\\Anastasia knight.mp4"}`;
    const out = maybeRedact(line);
    expect(out).toContain(String.raw`C:\\Users\\user\\Downloads\\[hidden].mp4`);
    expect(out).not.toContain('Anastasia');
  });

  it('still keeps an encoded directory', () => {
    const out = maybeRedact('video_path=D%3A%5CVR%5CClip%20Name.mp4&seek_pct=0.1');
    expect(out).toBe('video_path=D%3A%5CVR%5C[hidden].mp4&seek_pct=0.1');
  });

  it('leaves a line with no media reference alone', () => {
    const line = '[Backend] INFO: 127.0.0.1:56372 - "GET /health HTTP/1.1" 200 OK';
    expect(maybeRedact(line)).toBe(line);
  });

  it('does nothing at all while switched off', () => {
    setRedactionEnabled(false);
    const line = 'Loading video: TAKE IT - PMV (extended mix).mp4';
    expect(maybeRedact(line)).toBe(line);
  });
});

// V55 (app test 2026-11-02). Apostrophes and ampersands are legal in Windows
// file names, and the name pattern refused both, so a match could only start
// AFTER the last one. With the toggle on, the tester's main.log read
// `Loading video: Tom & Jerry'[hidden].mp4`: most of the title, in a log the
// user had been told was safe to paste. These are the tester's lines, and
// every assertion is on the WHOLE line, so a partial leak cannot pass.
describe("names with an apostrophe or ampersand (V55)", () => {
  beforeEach(() => setRedactionEnabled(true));
  afterEach(() => setRedactionEnabled(false));

  it('redacts the whole bare name on a Loading video line', () => {
    expect(maybeRedact("Loading video: Tom & Jerry's Clip.mp4"))
      .toBe('Loading video: [hidden].mp4');
  });

  it('redacts the whole filename field of a Funscript loaded line', () => {
    expect(maybeRedact(
      `Funscript loaded: {"filename":"Tom & Jerry's Clip.funscript","version":"1.0","actionCount":33}`))
      .toBe('Funscript loaded: {"filename":"[hidden].funscript","version":"1.0","actionCount":33}');
  });

  it('redacts the whole name in a full path and keeps the message after it', () => {
    const line = String.raw`Single thumbnail failed for C:\Users\user\apptest\library\Tom & Jerry's Clip.mp4: Backend returned 500`;
    expect(maybeRedact(line)).toBe(
      String.raw`Single thumbnail failed for C:\Users\user\apptest\library\[hidden].mp4: Backend returned 500`);
  });

  it('keeps the quotes around a path in a Node error message', () => {
    const line = String.raw`read-funscript failed: ENOENT: no such file or directory, open 'C:\Lib\Tom & Jerry's Clip.funscript'`;
    expect(maybeRedact(line)).toBe(
      String.raw`read-funscript failed: ENOENT: no such file or directory, open 'C:\Lib\[hidden].funscript'`);
  });

  it('keeps the quotes around a Python-repr path', () => {
    expect(maybeRedact(String.raw`'D:\\VR\\Clip.mp4'`)).toBe(String.raw`'D:\\VR\\[hidden].mp4'`);
  });

  it("redacts an apostrophe in the middle of a word and one after a space", () => {
    expect(maybeRedact(String.raw`D:\VR\Don't Stop.mkv`)).toBe(String.raw`D:\VR\[hidden].mkv`);
    expect(maybeRedact("/home/d/Rock 'n' Roll.mp4")).toBe('/home/d/[hidden].mp4');
  });

  it('keeps a directory that itself contains an ampersand', () => {
    expect(maybeRedact(String.raw`D:\Tom & Jerry\Clip.mp4`)).toBe(String.raw`D:\Tom & Jerry\[hidden].mp4`);
  });

  // The query string after the name has `&` in it too. Allowing `&` in a
  // name must not let the match run on past the extension and eat the rest
  // of the request line.
  it('keeps &seek_pct= and the rest of an encoded backend request line', () => {
    expect(maybeRedact(
      'INFO: "POST /thumbnails/single?video_path=D%3A%5CVideos%5CMy Clip.mp4&seek_pct=0.1"'))
      .toBe('INFO: "POST /thumbnails/single?video_path=D%3A%5CVideos%5C[hidden].mp4&seek_pct=0.1"');
    expect(maybeRedact(
      'POST /thumbnails/single?video_path=C%3A%5CLib%5CTom%20%26%20Jerry%27s%20Clip.mp4&seek_pct=0.1&width=320&exact=false HTTP/1.1'))
      .toBe('POST /thumbnails/single?video_path=C%3A%5CLib%5C[hidden].mp4&seek_pct=0.1&width=320&exact=false HTTP/1.1');
  });

  it('does not swallow a query parameter that comes BEFORE the path', () => {
    expect(maybeRedact('GET /x?a=1&video_path=/mnt/nas/Some Name.mkv HTTP/1.1'))
      .toBe('GET /x?a=1&video_path=/mnt/nas/[hidden].mkv HTTP/1.1');
  });
});

// FT-010. Masking secrets used to be the job of each call site that knew it
// held one (handy-manager maskKey, audience-bridge _maskKey); log-redact only
// knew file names, and only while the toggle was on. These lines are the
// shapes a key, a token or a cookie takes on this app's wire, and every one
// must be masked with the file-name toggle OFF (its default). Whole-line
// asserts, so a partial leak cannot pass.
describe('secrets are masked on every line, toggle or not (FT-010)', () => {
  beforeEach(() => {
    setRedactionEnabled(false);
    clearSecretLiterals();
  });
  afterEach(() => clearSecretLiterals());

  const CASES = [
    ['the FT-010 sample line',
      'apikey=SEKRET123 ApiKey: SEKRET456 _t=SEKRET789',
      'apikey=[redacted] ApiKey: [redacted] _t=[redacted]'],
    ['a Handy API URL in a fetch error',
      'fetch failed: GET https://www.handyfeeling.com/api/handy/v2/connected?api_key=SEKRETAAA&timeout=5000',
      'fetch failed: GET https://www.handyfeeling.com/api/handy/v2/connected?api_key=[redacted]&timeout=5000'],
    ['a token query parameter before a fragment',
      'GET /x?token=SEKRETBBB#t=5',
      'GET /x?token=[redacted]#t=5'],
    ['access and refresh tokens',
      'oauth access_token=SEKRETCCC&refresh_token=SEKRETDDD&expires=3600',
      'oauth access_token=[redacted]&refresh_token=[redacted]&expires=3600'],
    ['the Handy SDK header, as util.inspect prints it',
      "request headers { 'X-Connection-Key': 'SEKRETEEE', Accept: 'application/json' }",
      "request headers { 'X-Connection-Key': '[redacted]', Accept: 'application/json' }"],
    ['the Autoblow header, as JSON',
      '{"x-device-token":"SEKRETFFF","content-type":"application/json"}',
      '{"x-device-token":"[redacted]","content-type":"application/json"}'],
    ['a v3 API key header',
      'X-Api-Key: SEKRETGGG',
      'X-Api-Key: [redacted]'],
    ['a bearer token keeps its scheme word',
      'Authorization: Bearer SEKRETHHH',
      'Authorization: Bearer [redacted]'],
    ['the whole EroScripts cookie header',
      'Cookie: _t=SEKRETIII; cf_clearance=SEKRETJJJ; _forum_session=SEKRETKKK',
      'Cookie: [redacted]'],
    ['EroScripts cookies outside a header',
      'retry with _t=SEKRETLLL; cf_clearance=SEKRETMMM',
      'retry with _t=[redacted]; cf_clearance=[redacted]'],
    ['a dumped session object',
      "session { cookie: 'SEKRETNNN', username: 'dave' }",
      "session { cookie: '[redacted]', username: 'dave' }"],
    ['a dumped settings slice with a token',
      '{"autoblow":{"token":"SEKRETOOO","offset":0}}',
      '{"autoblow":{"token":"[redacted]","offset":0}}'],
    ['a connectionKey field',
      "{ connectionKey: 'SEKRETPPP', slideMin: 0 }",
      "{ connectionKey: '[redacted]', slideMin: 0 }"],
    // Next-major P0 item 10: Stash takes its key as an `apikey` query
    // parameter or an `ApiKey` header. Either is masked in any letter case.
    ['a Stash apikey query parameter, in any case',
      'GET http://stash.example:9999/scene/12/stream?APIKEY=SEKRETQQQ&resolution=ORIGINAL ?ApiKey=SEKRETRRR',
      'GET http://stash.example:9999/scene/12/stream?APIKEY=[redacted]&resolution=ORIGINAL ?ApiKey=[redacted]'],
    ['the Stash ApiKey header, in any case and as JSON',
      'apikey: SEKRETSSS APIKEY:SEKRETTTT {"ApiKey":"SEKRETUUU","Content-Type":"application/json"}',
      'apikey: [redacted] APIKEY:[redacted] {"ApiKey":"[redacted]","Content-Type":"application/json"}'],
  ];

  for (const [what, line, want] of CASES) {
    it(`masks ${what}`, () => {
      expect(isRedactionEnabled()).toBe(false);
      expect(redactSecrets(line)).toBe(want);
    });
  }

  it('masks a registered literal wherever it appears, in any shape', () => {
    registerSecretLiterals(['TESTKEY01']);
    expect(redactSecrets('[Handy] key TESTKEY01 rejected; retry TESTKEY01'))
      .toBe('[Handy] key [redacted] rejected; retry [redacted]');
    expect(redactSecrets('POST /api?k=TESTKEY01')).toBe('POST /api?k=[redacted]');
  });

  it('masks the URL-encoded form of a registered literal', () => {
    registerSecretLiterals(['ab/cd+ef=gh']);
    expect(redactSecrets('GET /x?c=ab%2Fcd%2Bef%3Dgh')).toBe('GET /x?c=[redacted]');
  });

  it('ignores literals too short to be a key', () => {
    registerSecretLiterals(['abc', '', null, 42]);
    const line = '[Player] abc 42 frames';
    expect(redactSecrets(line)).toBe(line);
  });

  it('leaves file names alone (that is the toggle\'s job) while masking the secret', () => {
    const line = String.raw`Single thumbnail failed for C:\Lib\Alpha Scene.mp4 (GET /x?apikey=SEKRET1): Backend returned 500`;
    expect(redactSecrets(line)).toBe(
      String.raw`Single thumbnail failed for C:\Lib\Alpha Scene.mp4 (GET /x?apikey=[redacted]): Backend returned 500`);
  });

  it('returns a line with no secret as the very same string', () => {
    registerSecretLiterals(['TESTKEY01']);
    for (const line of [
      '[2026-11-05 10:00:00.000] [info]  [Backend] INFO:     127.0.0.1:63503 - "GET /health HTTP/1.1" 200 OK',
      '[Audience] Source 7: no script (none) — viewers stay stopped',
      '[Handy] connect(••••Y01x) — requesting…',
      'SESSION restored for dave, cookie length: 32',
      'SEARCH cookies sent: 120 bytes',
      'foo_t=1 bar',
      'Loading video: Alpha Scene.mp4',
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it('is idempotent', () => {
    const once = redactSecrets('apikey=SEKRET1 Cookie: _t=SEKRET2');
    expect(redactSecrets(once)).toBe(once);
  });

  it('still masks with the file-name toggle ON, and both run', () => {
    setRedactionEnabled(true);
    expect(maybeRedact(redactSecrets('Loading video: D:\\VR\\Clip.mp4 token=SEKRET1')))
      .toBe('Loading video: D:\\VR\\[hidden].mp4 token=[redacted]');
    setRedactionEnabled(false);
  });
});

describe('secretLiteralsFromSetting (FT-010)', () => {
  it('finds the secret in a write on, above or below the secret path', () => {
    expect(secretLiteralsFromSetting('handy.connectionKey', 'K1234567')).toEqual(['K1234567']);
    expect(secretLiteralsFromSetting('handy', { connectionKey: 'K1234567', slideMin: 0 })).toEqual(['K1234567']);
    expect(secretLiteralsFromSetting('autoblow.token', 'T1234567')).toEqual(['T1234567']);
    expect(secretLiteralsFromSetting('eroscripts.session', { cookie: 'C1234567', username: 'dave' }))
      .toEqual(['C1234567']);
    expect(secretLiteralsFromSetting('eroscripts.session.cookie', 'C7654321')).toEqual(['C7654321']);
    expect(secretLiteralsFromSetting('audience.viewers', [{ key: 'V1234567', label: 'a' }, { key: 'V7654321' }]))
      .toEqual(['V1234567', 'V7654321']);
    expect(secretLiteralsFromSetting('audience', { viewers: [{ key: 'V1111111' }] })).toEqual(['V1111111']);
  });

  it('finds nothing in an unrelated or empty write', () => {
    expect(secretLiteralsFromSetting('player.volume', 80)).toEqual([]);
    expect(secretLiteralsFromSetting('handy.slideMin', 10)).toEqual([]);
    expect(secretLiteralsFromSetting('eroscripts.session', null)).toEqual([]);
    expect(secretLiteralsFromSetting('handy.connectionKey', '')).toEqual([]);
    expect(secretLiteralsFromSetting('', 'x')).toEqual([]);
  });

  it('every secret path names a real setting with an empty default', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    expect(DEFAULTS.settings.handy.connectionKey).toBe('');
    expect(DEFAULTS.settings.autoblow.token).toBe('');
    expect(SECRET_SETTING_PATHS).toEqual(
      ['handy.connectionKey', 'autoblow.token', 'eroscripts.session', 'audience.viewers']);
  });
});
