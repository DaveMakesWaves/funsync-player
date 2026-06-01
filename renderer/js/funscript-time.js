// Pure helpers for funscript-metadata time values.
//
// Funscript-in-the-wild is informal — bookmark / chapter `at` and
// `startTime` / `endTime` fields show up as numbers (FunSync / OFS
// convention, integer ms) OR strings (MFP / .NET TimeSpan convention,
// "HH:MM:SS.mmm"). This module is the single source of truth for
// coercing both forms to integer milliseconds; downstream code stays
// uniform and a sixth format only needs to be handled here.
//
// SCOPE: notes/features/SCOPE-chapters-bookmarks.md §2 decision #2.

const TIME_RE = /^(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/;

/**
 * Coerce a funscript-metadata time value into integer ms.
 *
 * Accepts:
 *   - number (finite, >= 0) → rounded to integer
 *   - "HH:MM:SS.mmm" or "HH:MM:SS"
 *   - "MM:SS.mmm" or "MM:SS"
 *   - "12345" (a string-encoded number) → coerced to number
 *
 * Returns null for unparseable input; caller drops the entry. Per the
 * SCOPE's edge-case matrix C-E10, negative values also return null so
 * upstream behaviour (existing editor's bookmark filter) is preserved.
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
export function parseFunscriptTime(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value);
  }

  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;

  // String-encoded number ("12345"). Pure-digit (with optional decimal
  // and sign) detection — anything containing a `:` is a TimeSpan and
  // must hit the regex branch below, not Number().
  if (!s.includes(':')) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n);
  }

  const m = s.match(TIME_RE);
  if (!m) return null;

  // Groups: hours (optional), minutes, seconds, fractional (optional).
  // When the leading "HH:" is absent, group 1 is undefined and the
  // first capture is interpreted as minutes — matching the MM:SS form.
  const hours   = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  // Fractional seconds: pad / truncate to milliseconds (3 digits).
  let fracMs = 0;
  if (m[4] !== undefined) {
    const frac = m[4];
    if (frac.length >= 3) fracMs = parseInt(frac.slice(0, 3), 10);
    else fracMs = parseInt(frac, 10) * (frac.length === 1 ? 100 : 10);
  }

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (minutes >= 60 || seconds >= 60) return null;  // malformed: 90 seconds shouldn't pass

  return hours * 3600000 + minutes * 60000 + seconds * 1000 + fracMs;
}
