// log-redact — optionally strip media file NAMES out of log lines.
//
// Why this exists: bug reports are far easier to answer with a log, and
// FunSync now asks for one in #bug-reports on Discord. But `main.log` records
// the full path of every video opened, and for this app a filename is the
// single most revealing thing in the file. Pasting one on a public paste site
// should not be a privacy decision made by accident.
//
// WHAT IT REDACTS, AND WHAT IT DELIBERATELY DOES NOT
//
//   D:\VR\SLR_VRBangers_Beach_Day_1920p_LR.mp4
//   -> D:\VR\[hidden].mp4
//
// The NAME goes, the DIRECTORY and the EXTENSION stay. That split is the
// whole point:
//
//   * the directory is what makes a log diagnostic — drive letters, UNC and
//     NAS mounts, whether two sources overlap, whether a path is on a drive
//     that just went offline. Dave's rule: "file names only though not the
//     path".
//   * the extension matters too. ".mkv" vs ".mp4" is the difference between
//     a subtitle bug and a codec bug.
//
// OFF BY DEFAULT. Most users are diagnosing their own machine and a redacted
// log is a worse log; this is for the moment someone posts one publicly.
//
// SECRETS ARE DIFFERENT, AND ALWAYS ON (FT-010). A device key, a token or a
// login cookie is never diagnostic and is never the user's choice to publish,
// so redactSecrets (bottom of this file) runs on every line whatever the
// toggle says. See there.

const fs = require('fs');
const path = require('path');
const { SECRET_SETTINGS: SHARED_SECRET_SETTINGS } = require('./secret-settings');

/** Extensions worth hiding. Media the user chose, plus their scripts. */
const SENSITIVE_EXT = new Set([
  'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'ts',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac',
  'funscript', 'srt', 'vtt', 'ass', 'ssa',
]);

const PLACEHOLDER = '[hidden]';

// A path separator, in any form a log line actually carries it: Windows
// backslash, forward slash, and the URL-encoded pair the Python backend
// writes into its request lines (`video_path=D%3A%5CVR%5CClip.mp4`).
//
// Handling the encoded form in the SAME expression matters. An earlier
// version ran a second pass for it, and the plain pass got there first and
// swallowed `video_path=D%3A%5CVideos%5CMy Clip` whole as a "filename",
// destroying the directory it was supposed to preserve. Two passes over one
// string will always race like that; one separator-aware pass cannot.
const SEP = String.raw`(?:[\\/]|%5C|%2F)`;

// dir  — everything up to and including the last separator, greedy so the
//        deepest path wins. OPTIONAL (`*`, not `+`): it was required, which
//        meant a bare filename with no directory never matched at all — and
//        the two most revealing lines in the whole log are bare names:
//        `Loading video: My Clip.mp4` and the `"filename"` field of
//        `Funscript loaded: {...}`. The toggle looked like it did nothing
//        because on a typical log it very nearly did (Dave, 2026-08-23).
//        With no directory present there is simply nothing to preserve, so
//        the whole name becomes the placeholder.
// name — lazy, allows spaces (real filenames are full of them), but is
//        TEMPERED so it can never step over a separator in either form.
//        Apostrophes and ampersands are allowed INSIDE it: both are legal in
//        Windows file names and common in real ones ("Tom & Jerry's Clip",
//        "Don't Stop"). They used to be excluded, so the match could only
//        begin after the last one and `Tom & Jerry's Clip.mp4` logged as
//        `Tom & Jerry'[hidden].mp4`, leaking most of the name (V55, app test
//        2026-11-02). They still may not START the name: that keeps a quoted
//        path ('C:\x\Clip.mp4' in a Node error) or a query separator
//        (`&video_path=`) outside the match. The query string AFTER a name
//        (`&seek_pct=0.1`) is safe either way: the lazy match stops at the
//        first `.ext` it reaches.
const PATH_RE = new RegExp(
  String.raw`((?:[^\s"'<>|?*&]*?${SEP})*)` +
    // Must not begin with whitespace, and must not contain a colon. Without
    // both, an optional directory lets the name run BACKWARDS over the label
    // in front of it: `Loading video: My Clip.mp4` matched from after
    // "Loading" and redacted to a bare `[hidden].mp4`, destroying the line's
    // meaning. A colon cannot appear in a Windows filename anyway, and the
    // drive-letter colon lives in `dir`, before a separator. `"` stays out
    // too: it is the JSON string delimiter and illegal in a Windows name.
    String.raw`((?![\s'&])(?:(?!${SEP})[^"<>|?*:])+?)` +
    String.raw`\.(` +
    [...SENSITIVE_EXT].join('|') +
    String.raw`)\b`,
  'gi',
);

// Same extension test with no name or directory around it, and not global, so
// `.test()` keeps no lastIndex between calls.
const EXT_HINT_RE = new RegExp(
  String.raw`\.(?:` + [...SENSITIVE_EXT].join('|') + String.raw`)\b`,
  'i',
);

/**
 * Replace media/script file NAMES with a placeholder, keeping directory and
 * extension.
 *
 * Also handles URL-encoded paths, which is how the backend logs them
 * (`video_path=D%3A%5CVR%5CClip.mp4`) — without that the redaction would
 * appear to work while the most common line in the file leaked anyway.
 *
 * @param {string} text
 * @returns {string}
 */
function redactFileNames(text) {
  if (typeof text !== 'string' || !text) return text;
  // Most lines carry no media extension at all, and PATH_RE cannot match
  // without one. Checking for it first skips the expensive pattern on those
  // lines, which makes a whole 5 MB log about five times faster to redact.
  // That speed is what lets redactLogFilesSync rewrite the files in one
  // synchronous step (see there).
  if (!EXT_HINT_RE.test(text)) return text;

  // Single pass. `dir` is put back verbatim, in whatever form it arrived —
  // encoded stays encoded — so the line still reads as the backend wrote it.
  return text.replace(PATH_RE, (_match, dir, _name, ext) =>
    `${dir}${PLACEHOLDER}.${ext}`);
}

// Read lazily: logger.js is required before the store exists (see the ordering
// note at the top of main.js), so the setting cannot be captured at load time.
let _enabled = false;

// Whether the log files on disk are known to hold no name in the clear. False
// at boot: they hold whatever earlier sessions wrote, including sessions of
// older versions whose pattern missed names (v0.9.2 matched no bare name and
// no name with ' or &). False again whenever the toggle goes off, because
// from then on lines are written in the clear.
let _filesClean = false;

/** @param {boolean} on */
function setRedactionEnabled(on) {
  _enabled = !!on;
  if (!_enabled) _filesClean = false;
}

function isRedactionEnabled() {
  return _enabled;
}

/** Apply redaction only when the user has switched it on. */
function maybeRedact(text) {
  return _enabled ? redactFileNames(text) : text;
}

// --- Log files already on disk (V56) ---------------------------------------
//
// The hook in logger.js redacts each line as it is WRITTEN. Switching the
// toggle on therefore did nothing to the lines already in main.log and
// main.old.log, and the flow the toggle exists for is exactly "hit a bug,
// switch it on, open the log, paste it": the pasted file still held every
// title opened before the click (V56, app test 2026-11-02).

/**
 * The rotated copy electron-log keeps beside the live log. Its default
 * `archiveLogFn` renames `main.log` to `main.old.log`, and keeps only one.
 *
 * @param {string} logPath
 * @returns {string}
 */
function rotatedLogPath(logPath) {
  const inf = path.parse(logPath);
  return path.join(inf.dir, `${inf.name}.old${inf.ext}`);
}

/**
 * Rewrite log files on disk with every file name redacted.
 *
 * SYNCHRONOUS ON PURPOSE. electron-log's file transport appends each line
 * with a synchronous open-append-close (`fs.writeFileSync`, flag 'a') on this
 * same main-process thread, and rotates inside that same call. A
 * read-redact-replace that never yields cannot interleave with either: no
 * line can be appended between the read and the replace and then be lost,
 * and the file cannot rotate out from under it. An async version would need
 * its own catch-up and rotation detection to be safe. The cost is one block
 * of the main thread on a user click: ~0.2 s for a full 5 MB log, thanks to
 * the extension pre-check in redactFileNames.
 *
 * Line by line, so a name can never run across a line break into the next
 * line (timestamps stop it on a normal line, but not on the continuation
 * lines of a multi-line message).
 *
 * Replaced through a temp file and a rename, so a crash mid-write leaves the
 * old file or the new one, never half of each. If the rename is refused
 * (Windows: another program holds the file open without delete sharing) it
 * falls back to writing in place. A missing file is skipped, not an error:
 * main.old.log does not exist until the first rotation.
 *
 * @param {string[]} paths
 * @param {typeof import('fs')} [fsImpl]
 * @returns {{ path: string, ok: boolean, changed: boolean, error?: string }[]}
 */
function redactLogFilesSync(paths, fsImpl = fs) {
  const results = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p) continue;
    let raw;
    try {
      raw = fsImpl.readFileSync(p, 'utf8');
    } catch (err) {
      const missing = err && err.code === 'ENOENT';
      results.push(missing
        ? { path: p, ok: true, changed: false }
        : { path: p, ok: false, changed: false, error: err.message });
      continue;
    }
    // split() with a capturing group keeps each separator at an odd index,
    // so CRLF and LF both come back exactly as they were.
    const redacted = raw.split(/(\r?\n)/)
      .map((part, i) => (i % 2 ? part : redactFileNames(part)))
      .join('');
    if (redacted === raw) {
      results.push({ path: p, ok: true, changed: false });
      continue;
    }
    const tmp = `${p}.redact-tmp`;
    try {
      fsImpl.writeFileSync(tmp, redacted, 'utf8');
      try {
        fsImpl.renameSync(tmp, p);
      } catch {
        fsImpl.writeFileSync(p, redacted, 'utf8');
        try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
      }
      results.push({ path: p, ok: true, changed: true });
    } catch (err) {
      try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
      results.push({ path: p, ok: false, changed: false, error: err.message });
    }
  }
  return results;
}

/**
 * Before the app hands the log to the user (Open log file, Open log folder,
 * Report a problem): with redaction on, rewrite the files once per session.
 * That covers the lines the write hook never saw: anything written before
 * the setting was read at boot, by an older version's weaker pattern, or
 * while the toggle was off.
 *
 * @param {string[]} logPaths
 * @returns {ReturnType<typeof redactLogFilesSync> | null} null when nothing ran
 */
function ensureLogFilesRedacted(logPaths) {
  if (!_enabled || _filesClean) return null;
  const results = redactLogFilesSync(logPaths);
  _filesClean = results.every((r) => r.ok);
  return results;
}

/**
 * The settings toggle. Switching it ON also rewrites what is already in the
 * log files, so the history before the click is hidden too, not just the
 * lines after it. Switching it off rewrites nothing, and cannot bring hidden
 * names back.
 *
 * @param {boolean} on
 * @param {string[]} logPaths
 * @returns {ReturnType<typeof redactLogFilesSync> | null} null when nothing ran
 */
function applyRedactionSetting(on, logPaths) {
  const wasOn = _enabled;
  setRedactionEnabled(on);
  if (!_enabled || wasOn) return null;
  return ensureLogFilesRedacted(logPaths);
}

// --- Secrets (FT-010): always on --------------------------------------------
//
// Masking used to exist only at the call sites that knew they held a key
// (handy-manager.js maskKey, audience-bridge _maskKey). That covers the lines
// someone remembered to write carefully and nothing else: a request URL with
// ?apikey= in a fetch error, a headers object dumped while debugging, the
// backend echoing a query string. This is the net under all of them, and the
// last 80 lines of this log go into a GitHub issue body (Report a problem).
//
// Two layers:
//   * SHAPES, the ways a secret travels on this app's wire: query and cookie
//     pairs (`apikey=`, `api_key=`, `...token=`, `_t=`, `cf_clearance=`,
//     `_forum_session=`), headers and dumped header objects (`ApiKey:`,
//     `X-Api-Key:`, `X-Connection-Key:`, `x-device-token:`,
//     `Authorization: Bearer`, `Cookie:`), and a quoted token value
//     (`token: 'x'`, `"token":"x"`).
//   * LITERALS, the actual values main knows are secret (the Handy key, the
//     Autoblow token, the EroScripts cookie, every Audience viewer's key),
//     masked wherever they appear and in whatever shape. Registered at boot
//     and by every set-setting that carries one, and never dropped during a
//     session, so a key the user has just replaced is still masked.
//
// Fast path: a line with no registered literal and no hint of a shape comes
// back as the SAME string, after one regex test and one includes() per
// literal.

const SECRET_MASK = '[redacted]';

// A cheap pre-test. Every shape below contains one of these.
const SECRET_HINT_RE =
  /apikey|api[_-]key|token|connection[_-]?key|authorization|cookie|_t=|cf_clearance|_forum_session/i;

// `Cookie:` / `Set-Cookie:` carry a whole list of cookies; the value runs to
// the closing quote or the end of the line.
const SECRET_COOKIE_HEADER_RE =
  /(?<![A-Za-z0-9-])(["']?)(set-cookie|cookie)\1(\s*:\s*)(["']?)([^"'\r\n]+)/gi;

// A header, plain (`ApiKey: x`), as JSON (`"X-Connection-Key":"x"`) or as
// util.inspect prints an object (`'x-device-token': 'x'`, `connectionKey: 'x'`).
// An auth scheme word is kept; the credential goes.
const SECRET_HEADER_RE =
  /(?<![A-Za-z0-9-])(["']?)(apikey|api-key|x-api-key|x-connection-key|connectionkey|x-device-token|authorization)\1(\s*:\s*)(["']?)((?:bearer|basic|token)\s+)?([^\s"',;]+)/gi;

// `token: 'x'` / `"token":"x"`, i.e. a dumped object. The value must be
// quoted, which keeps prose ("token: 3") alone.
const SECRET_QUOTED_TOKEN_RE =
  /(?<![A-Za-z0-9-])(["']?)([A-Za-z_-]*token)\1(\s*:\s*)(["'])([^"'\r\n]+)\4/gi;

// name=value in a query string or a cookie list. The name may not follow a
// letter or digit, so `foo_t=` is not the `_t` cookie.
const SECRET_ASSIGN_RE =
  /(?<![A-Za-z0-9])(apikey|api[_-]key|connection[_-]?key|[A-Za-z_-]*token|_t|cf_clearance|_forum_session)=([^\s&#"'<>;,)]+)/gi;

// Shorter strings would mask ordinary text by accident; real keys are longer.
const MIN_SECRET_LITERAL = 6;
// Bounded, oldest out first, in case something registers in a loop.
const MAX_SECRET_LITERALS = 256;
const _secretLiterals = new Set();
let _secretLiteralList = []; // longest first, so a longer secret masks whole

/**
 * Remember values to mask wherever they appear. Adds; never removes.
 * @param {unknown[]|unknown} values
 */
function registerSecretLiterals(values) {
  let changed = false;
  for (const v of Array.isArray(values) ? values : [values]) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length < MIN_SECRET_LITERAL) continue;
    let encoded = s;
    try { encoded = encodeURIComponent(s); } catch { /* lone surrogate: skip the encoded form */ }
    for (const form of [s, encoded]) {
      if (_secretLiterals.has(form)) continue;
      _secretLiterals.add(form);
      changed = true;
    }
  }
  while (_secretLiterals.size > MAX_SECRET_LITERALS) {
    _secretLiterals.delete(_secretLiterals.values().next().value);
  }
  if (changed) _secretLiteralList = [..._secretLiterals].sort((a, b) => b.length - a.length);
}

/** Forget every registered literal. For tests. */
function clearSecretLiterals() {
  _secretLiterals.clear();
  _secretLiteralList = [];
}

/**
 * Mask secrets in one log line (or any text). ALWAYS applied, independent of
 * the file-name toggle.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const lit of _secretLiteralList) {
    if (out.includes(lit)) out = out.split(lit).join(SECRET_MASK);
  }
  if (!SECRET_HINT_RE.test(out)) return out;
  return out
    .replace(SECRET_COOKIE_HEADER_RE, (_m, q1, name, sep, q2) =>
      `${q1}${name}${q1}${sep}${q2}${SECRET_MASK}`)
    .replace(SECRET_HEADER_RE, (_m, q1, name, sep, q2, scheme) =>
      `${q1}${name}${q1}${sep}${q2}${scheme || ''}${SECRET_MASK}`)
    .replace(SECRET_QUOTED_TOKEN_RE, (_m, q1, name, sep, q2) =>
      `${q1}${name}${q1}${sep}${q2}${SECRET_MASK}${q2}`)
    .replace(SECRET_ASSIGN_RE, (_m, name) => `${name}=${SECRET_MASK}`);
}

// The settings that hold a secret, and how to find the secret strings in
// the value stored there. The list is electron/secret-settings.js, shared
// with data-export.js's import merge (R3-08: each kept its own copy).
const SECRET_SETTINGS = Object.fromEntries(
  Object.entries(SHARED_SECRET_SETTINGS).map(([p, def]) => [p, def.literals]),
);
const SECRET_SETTING_PATHS = Object.keys(SECRET_SETTINGS);

/**
 * The secret strings a settings write carries. `path` is the unprefixed
 * set-setting path; the write may sit above a secret (`'handy'` with an
 * object), on it, or below it (`'eroscripts.session.cookie'`).
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {string[]}
 */
function secretLiteralsFromSetting(path, value) {
  if (typeof path !== 'string' || !path) return [];
  const segs = path.split('.');
  const out = [];
  for (const secretPath of SECRET_SETTING_PATHS) {
    const want = secretPath.split('.');
    let v;
    if (segs.length <= want.length) {
      if (!segs.every((s, i) => s === want[i])) continue;
      v = value;
      for (const k of want.slice(segs.length)) {
        v = v != null && typeof v === 'object' ? v[k] : undefined;
      }
    } else {
      if (!want.every((s, i) => s === segs[i])) continue;
      v = segs.slice(want.length).reduceRight((acc, k) => ({ [k]: acc }), value);
    }
    if (v === undefined || v === null) continue;
    out.push(...SECRET_SETTINGS[secretPath](v));
  }
  return out.filter((s) => typeof s === 'string' && s);
}

/** Register whatever secrets a settings write carries. */
function noteSecretSetting(path, value) {
  registerSecretLiterals(secretLiteralsFromSetting(path, value));
}

module.exports = {
  redactSecrets,
  registerSecretLiterals,
  clearSecretLiterals,
  secretLiteralsFromSetting,
  noteSecretSetting,
  SECRET_SETTING_PATHS,
  SECRET_MASK,
  redactFileNames,
  maybeRedact,
  setRedactionEnabled,
  isRedactionEnabled,
  applyRedactionSetting,
  ensureLogFilesRedacted,
  redactLogFilesSync,
  rotatedLogPath,
  PLACEHOLDER,
  SENSITIVE_EXT,
};
