// Check script (editor work list 4.2, 2026-11-24): FunGen 2's "Funscript
// Doctor" for FunSync's editor. Pure: reads an action array, changes nothing,
// and says what a device or a player would trip over. The dialog
// (components/script-check-panel.js) lists the findings, jumps to one, and
// selects every point of one kind.
//
// The speed limits are the editor's own (Settings > Keyboard > Editor speed
// limits: editor.maxSpeed / editor.minSpeed in electron/store.js, units/s,
// 0 = off), compared exactly as the timeline marks them
// (ActionGraph.speedMark): a line FASTER than max is too fast, a MOVING line
// slower than min is too slow, a hold is never slow. So a stroke this check
// lists is a stroke the timeline already draws lilac or dashed.

/** The kinds, in the order the dialog lists them: the file's own faults first. */
export const CHECK_KINDS = Object.freeze([
  'outOfRange',
  'notWhole',
  'sameTime',
  'tooFast',
  'tooSlow',
  'shortStroke',
  'longGap',
]);

/** Defaults: roa's 400 max, kinetics' 33 min for the Handy, a 10 s hole. */
export const CHECK_DEFAULTS = Object.freeze({ maxSpeed: 400, minSpeed: 33, longGapMs: 10000, frameMs: 0 });

const positive = (v, dflt) => {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * @typedef {object} CheckFinding
 * @property {string} kind      one of CHECK_KINDS
 * @property {number[]} indices the points involved, as indices into the
 *   array given (ascending); select these to fix the finding
 * @property {number} at        where to jump, in ms (the first point's time)
 * @property {object} detail    plain data for the text (the dialog words it):
 *   tooFast / tooSlow {speed, limit} units/s; sameTime {count};
 *   outOfRange {pos} (outside 0-100), {at} (a time before 0) or
 *   {invalid: true} (a time or position that is not a number);
 *   notWhole {at, pos};
 *   longGap {gapMs}; shortStroke {ms, frameMs}
 */

/**
 * Check a script.
 *
 * - outOfRange: a position outside 0-100 (or not a number), a time before 0.
 * - notWhole: a time or position with a fraction (a saved file rounds it, so
 *   the point lands a little elsewhere than it shows in another tool).
 * - sameTime: two or more points at one time (only one of them can play).
 * - tooFast: a stroke faster than maxSpeed units/s.
 * - tooSlow: a moving stroke slower than minSpeed units/s (the Handy can stall).
 * - shortStroke: points closer than one video frame (frameMs), when given.
 * - longGap: no point for longGapMs or more while the script moves before
 *   AND after the hole: a missing section, not the quiet start or end. A
 *   gap's own segment is not also listed as too slow (one fault, one row).
 *
 * Points are taken in time order whatever order they come in (the editor's
 * array is sorted; a raw file need not be); indices always refer to the
 * array given. 0 for a limit turns that check off.
 *
 * @param {Array<{at: number, pos: number}>} actions
 * @param {{maxSpeed?: number, minSpeed?: number, longGapMs?: number, frameMs?: number}} [opts]
 * @returns {{total: number, points: number, groups: Array<{kind: string, findings: CheckFinding[]}>}}
 *   groups: only the kinds with findings, in CHECK_KINDS order
 */
export function checkScript(actions, opts = {}) {
  const maxSpeed = positive(opts.maxSpeed, CHECK_DEFAULTS.maxSpeed);
  const minSpeed = positive(opts.minSpeed, CHECK_DEFAULTS.minSpeed);
  const longGapMs = positive(opts.longGapMs, CHECK_DEFAULTS.longGapMs);
  const frameMs = positive(opts.frameMs, CHECK_DEFAULTS.frameMs);

  const list = Array.isArray(actions) ? actions : [];
  const found = Object.fromEntries(CHECK_KINDS.map((k) => [k, []]));
  const add = (kind, indices, at, detail) => found[kind].push({ kind, indices, at, detail });

  // Per point: the file's own faults. Number(null) is 0 and Number('') too:
  // a missing value must read as not a number, not as position 0.
  const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  const timed = [];
  list.forEach((a, i) => {
    const at = num(a?.at);
    const pos = num(a?.pos);
    if (!Number.isFinite(at)) {
      add('outOfRange', [i], 0, { invalid: true });
      return; // no place in time: nothing below can use it
    }
    if (at < 0) add('outOfRange', [i], at, { at });
    if (!Number.isFinite(pos)) add('outOfRange', [i], at, { invalid: true });
    else if (pos < 0 || pos > 100) add('outOfRange', [i], at, { pos });
    if (!Number.isInteger(at) || (Number.isFinite(pos) && !Number.isInteger(pos))) add('notWhole', [i], at, { at, pos });
    timed.push({ i, at, pos });
  });

  // Time order; a stable sort keeps the given order on a tie.
  timed.sort((p, q) => p.at - q.at);

  // Points sharing a time: one finding per time.
  for (let k = 0; k < timed.length;) {
    let e = k + 1;
    while (e < timed.length && timed[e].at === timed[k].at) e++;
    if (e - k > 1) {
      const indices = timed.slice(k, e).map((p) => p.i).sort((x, y) => x - y);
      add('sameTime', indices, timed[k].at, { count: e - k });
    }
    k = e;
  }

  // Segments between neighbours in time. A segment touching a point with no
  // usable position is skipped (its speed means nothing).
  const moves = (p, q) => Number.isFinite(p.pos) && Number.isFinite(q.pos) && p.pos !== q.pos;
  for (let k = 0; k + 1 < timed.length; k++) {
    const p = timed[k];
    const q = timed[k + 1];
    const dt = q.at - p.at;
    if (dt <= 0 || !Number.isFinite(p.pos) || !Number.isFinite(q.pos)) continue;
    const dp = Math.abs(q.pos - p.pos);
    const speed = (dp / dt) * 1000;
    const pair = [p.i, q.i].sort((x, y) => x - y);

    if (maxSpeed > 0 && speed > maxSpeed) {
      add('tooFast', pair, p.at, { speed: Math.round(speed), limit: maxSpeed });
    }
    if (frameMs > 0 && dt < frameMs) {
      add('shortStroke', pair, p.at, { ms: Math.round(dt * 10) / 10, frameMs: Math.round(frameMs * 10) / 10 });
    }

    let gap = false;
    if (longGapMs > 0 && dt >= longGapMs) {
      const before = k > 0 && moves(timed[k - 1], p);
      const after = k + 2 < timed.length && moves(q, timed[k + 2]);
      if (before && after) {
        gap = true;
        add('longGap', pair, p.at, { gapMs: dt });
      }
    }
    if (!gap && minSpeed > 0 && dp > 0 && speed < minSpeed) {
      add('tooSlow', pair, p.at, { speed: Math.round(speed * 10) / 10, limit: minSpeed });
    }
  }

  const groups = CHECK_KINDS
    .filter((kind) => found[kind].length > 0)
    .map((kind) => ({ kind, findings: found[kind].sort((x, y) => x.at - y.at) }));
  const total = groups.reduce((n, g) => n + g.findings.length, 0);
  return { total, points: list.length, groups };
}

/**
 * Every point index of one group, ascending, each once (the dialog's
 * "Select all N": a point in two findings is selected once).
 * @param {{findings: CheckFinding[]}} group
 * @returns {number[]}
 */
export function groupIndices(group) {
  const set = new Set();
  for (const f of group?.findings || []) for (const i of f.indices) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/**
 * A time for a finding row: mm:ss.mmm, or h:mm:ss.mmm from an hour on;
 * negative times keep their sign.
 * @param {number} ms
 * @returns {string}
 */
export function formatCheckTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '--:--.---';
  const sign = n < 0 ? '-' : '';
  const total = Math.round(Math.abs(n));
  const milli = total % 1000;
  const secs = Math.floor(total / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mmm = String(milli).padStart(3, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${ss}.${mmm}`;
  return `${sign}${String(m).padStart(2, '0')}:${ss}.${mmm}`;
}
