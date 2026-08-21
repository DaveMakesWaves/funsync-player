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
//        deepest path wins.
// name — lazy, allows spaces (real filenames are full of them), but is
//        TEMPERED so it can never step over a separator in either form.
const PATH_RE = new RegExp(
  String.raw`((?:[^\s"'<>|?*&]*?${SEP})+)` +
    String.raw`((?:(?!${SEP})[^"'<>|?*&])+?)` +
    String.raw`\.(` +
    [...SENSITIVE_EXT].join('|') +
    String.raw`)\b`,
  'gi',
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

  // Single pass. `dir` is put back verbatim, in whatever form it arrived —
  // encoded stays encoded — so the line still reads as the backend wrote it.
  return text.replace(PATH_RE, (_match, dir, _name, ext) =>
    `${dir}${PLACEHOLDER}.${ext}`);
}

// Read lazily: logger.js is required before the store exists (see the ordering
// note at the top of main.js), so the setting cannot be captured at load time.
let _enabled = false;

/** @param {boolean} on */
function setRedactionEnabled(on) {
  _enabled = !!on;
}

function isRedactionEnabled() {
  return _enabled;
}

/** Apply redaction only when the user has switched it on. */
function maybeRedact(text) {
  return _enabled ? redactFileNames(text) : text;
}

module.exports = {
  redactFileNames,
  maybeRedact,
  setRedactionEnabled,
  isRedactionEnabled,
  PLACEHOLDER,
  SENSITIVE_EXT,
};
