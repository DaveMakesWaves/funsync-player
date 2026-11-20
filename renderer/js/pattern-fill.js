// Fill with pattern: the pure core of the editor's "Fill with pattern" (the
// pattern library, next major). No DOM, no settings, no devices, no undo: it
// takes a script's actions and a selection and hands back the new action list.
// The drawer, the ghost preview and EditableScript.replaceRange come later
// (Round 2) and call fillRange() on every slider move, so it has to stay fast.
//
// What it does, in short:
//   - The selection's first and last points are kept as the join anchors A and B
//     (an option: anchors 'outside' replaces them too and joins the points
//     around the selection instead). Replace mode drops the points between
//     them; gap mode keeps every point and fills each empty stretch that is
//     long enough on its own. With fewer than two points in the selection its
//     edges stand in for the missing anchors: on the script's own line through
//     the edge when a point lies beyond it (the motion outside the selection does
//     not change), or free (an empty script, past its end) where the pattern
//     starts or stops as it likes.
//   - The pattern starts where A is heading: the engine gets A's position and
//     direction (startDir) and carries on that way, or turns at once when A
//     sits at the edge of the pattern's band. If a render still sets off the
//     wrong way, the start is moved to the first turn that lies ahead of A.
//   - The end lands on B. "stretch" (the default) renders a little past B and
//     picks the point to end on whose position and direction match B, then
//     scales the fill's tempo by 0.87-1.15 so it arrives on time. "partial"
//     keeps the tempo and ends on a part stroke. No fit: partial, with a notice.
//   - Join smoothness blends the first and last part of the fill (up to one
//     stroke, at most a quarter of the window) from the neighbour's own motion
//     into the pattern.
//   - Last, a constraint pass: no leg under its minimum (50 ms between two buzz
//     points of the pattern, else 100 ms) and none over the speed cap; A and B
//     never move. Times are whole ms, positions whole numbers 0-100.
//   - The input array is never changed. Points outside the selection are never
//     touched; in gap mode no existing point is.
//
// The renderer is injected ({ render, describe }); the default is the library
// engine (pattern-library.js). Positions are worked on as offsets from 50 and
// rounded symmetrically, so a reversed fill between mirrored neighbours is the
// exact mirror of the plain one.

import { renderPattern, describePattern } from './pattern-library.js';

/** ms: the shortest ordinary leg a fill makes (also the join legs to A and B). */
export const FILL_MIN_LEG_MS = 100;
/** ms: the shortest leg between two buzz (vibration) points of the pattern. */
export const FILL_MIN_VIB_LEG_MS = 50;
/** u/s: the default speed cap, unless 1.5x the fastest asked speed is higher. */
export const FILL_DEFAULT_CAP = 600;
/** The tempo bounds of the "stretch" end fit. */
export const FILL_TEMPO_MIN = 0.87;
export const FILL_TEMPO_MAX = 1.15;
/** The join blend never takes more than this share of a window. */
export const FILL_MAX_BLEND_SHARE = 0.25;
/** units: an anchor this close to the band edge it heads for may turn at once. */
export const FILL_EDGE_ZONE = 10;
/** ms: the shortest empty stretch gap mode fills (and at least two strokes). */
export const FILL_GAP_MIN_MS = 1000;
/**
 * ms: the move in from an end and the last leg onto a fixed end are held to max(2 x the longest leg of the pattern's
 * own render there, this). Without it a slow ease in, or the landing leg drawn from a hold, glided for a second or two
 * out of or into a kept point (fixup-2, 2026-11-17).
 */
export const FILL_LONG_LEG_MS = 500;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
/** Whole position from an offset from 50, rounded symmetrically (mirror-exact). */
const posOf = (c) => clamp(c < 0 ? 50 - Math.round(-c) : 50 + Math.round(c), 0, 100);
const smoothstep = (u) => u * u * (3 - 2 * u);
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Fill a selection of a script with a library pattern.
 *
 * @param {object} input
 * @param {Array<{at:number,pos:number}>} input.actions  the script (sorted by time, as EditableScript keeps it)
 * @param {{startMs:number,endMs:number}} input.selection
 * @param {string} input.patternId
 * @param {object} [input.options]
 *   speed (u/s, null = the pattern's own), ramp ({ to } u/s, or null), reversed, range ({ min, max } or null),
 *   variation (0-2), seed, joinSmoothness (0-1, default 0.5), endFit ('stretch' | 'partial'),
 *   mode ('replace' | 'gap'), anchors ('keep' | 'outside'), maxSpeed (u/s), minLegMs (default 100),
 *   minVibLegMs (default 50)
 * @param {{render?:Function, describe?:Function}} [deps]  the engine (default: pattern-library.js)
 * @returns {{actions:Array<{at:number,pos:number}>, inserted:Array<{at:number,pos:number}>, removedCount:number,
 *   warnings:Array<{code:string,values?:object}>, stats:object, removed:Array<{at:number,pos:number}>,
 *   stretches:Array<object>}}  removed = the original points the fill replaced (replace mode); stretches = one entry
 *   per filled stretch: { startMs, endMs, points, tempo (stretch fit) | null, endFit: stretch | partial | free }
 */
export function fillRange(input, deps = {}) {
  const inp = input || {};
  const src = Array.isArray(inp.actions) ? inp.actions : [];
  const render = typeof deps.render === 'function' ? deps.render : renderPattern;
  const describe = typeof deps.describe === 'function' ? deps.describe : describePattern;
  const warnings = [];
  const warn = (code, values) => { if (!warnings.some((w) => w.code === code)) warnings.push(values ? { code, values } : { code }); };

  // A sorted working copy; `src` itself is never touched. A point with no usable time or position (dirty input) takes
  // no part: it neither anchors nor bounds a fill, nothing is planned from it, and it comes back as it was.
  const acts = [];
  const broken = [];
  for (const a of src) {
    if (!a) continue;
    const at = Number(a.at), pos = Number(a.pos);
    if (Number.isFinite(at) && Number.isFinite(pos)) acts.push({ at, pos });
    else broken.push({ at: a.at, pos: a.pos });
  }
  for (let i = 1; i < acts.length; i++) if (acts[i].at < acts[i - 1].at) { acts.sort((a, b) => a.at - b.at); break; }
  const timeKey = (a) => (Number.isFinite(Number(a.at)) ? Number(a.at) : Infinity);
  const withBroken = (list) => (broken.length ? [...list, ...broken.map((b) => ({ ...b }))].sort((x, y) => (timeKey(x) - timeKey(y)) || 0) : list);
  const unchanged = (code, values) => {
    warn(code, values);
    return { actions: withBroken(acts.map((a) => ({ at: a.at, pos: a.pos }))), inserted: [], removedCount: 0, warnings, stats: emptyStats(), removed: [], stretches: [] };
  };

  const sel = inp.selection || {};
  const sa = Number(sel.startMs), sb = Number(sel.endMs);
  if (!Number.isFinite(sa) || !Number.isFinite(sb)) return unchanged('no-selection');
  // A script starts at 0: a selection reaching before it is filled from 0.
  const s0 = Math.max(0, Math.round(Math.min(sa, sb))), s1 = Math.max(0, Math.round(Math.max(sa, sb)));

  const desc = describe(inp.patternId);
  if (!desc) return unchanged('unknown-pattern', { id: String(inp.patternId) });
  const cfg = resolveOptions(inp.options || {}, desc);

  // ---- which points stay, and the stretches to fill ----
  const n = acts.length;
  const inSel = [];
  for (let i = 0; i < n; i++) if (acts[i].at >= s0 && acts[i].at <= s1) inSel.push(i);
  const kept = new Array(n).fill(true);
  let removedCount = 0;
  const anchorEnds = cfg.mode === 'gap' || cfg.anchors === 'keep';
  if (cfg.mode === 'replace') {
    if (cfg.anchors === 'keep' && inSel.length >= 2) {
      for (let k = 1; k < inSel.length - 1; k++) { kept[inSel[k]] = false; removedCount++; }
    } else if (cfg.anchors === 'outside') {
      for (const i of inSel) { kept[i] = false; removedCount++; }
    }
  }
  const keptIdx = [];
  for (let i = 0; i < n; i++) if (kept[i]) keptIdx.push(i);

  // The ends, in time order: existing points (anchors) and, where the selection has fewer than two of them (or with
  // anchors 'outside'), its edges.
  const ends = [];
  const useEdges = !(anchorEnds && inSel.length >= 2);
  if (useEdges) ends.push(edgeEnd(acts, keptIdx, s0, 'start', cfg));
  if (anchorEnds) {
    const pts = cfg.mode === 'gap' || inSel.length < 2 ? inSel : [inSel[0], inSel[inSel.length - 1]];
    for (const i of pts) ends.push(pointEnd(acts, i, cfg));
  }
  if (useEdges) ends.push(edgeEnd(acts, keptIdx, s1, 'end', cfg));

  // The ramp runs across the whole fill window.
  const wStart = ends.length ? ends[0].at : s0, wEnd = ends.length ? ends[ends.length - 1].at : s1;
  const speedAt = (t) => (wEnd > wStart ? cfg.speedA + (cfg.speedB - cfg.speedA) * clamp((t - wStart) / (wEnd - wStart), 0, 1) : cfg.speedA);

  const inserted = [];
  const stretches = [];
  const legStats = { sum: 0, n: 0, max: 0 };
  let anyCandidate = false;
  for (let k = 0; k + 1 < ends.length; k++) {
    const L = ends[k], R = ends[k + 1];
    const W = R.at - L.at;
    if (W < 2 * cfg.minLeg) continue;
    if (cfg.mode === 'gap') {
      const need = Math.max(FILL_GAP_MIN_MS, 2 * cfg.strokeAt(speedAt((L.at + R.at) / 2)));
      if (W < need) continue;
    }
    anyCandidate = true;
    const seed = ends.length > 2 ? seedFor(cfg.seed, stretches.length) : cfg.seed;
    const res = fillStretch({ L, R, seed, vA: speedAt(L.at), vB: speedAt(R.at), cfg, render, patternId: inp.patternId, warn });
    if (!res) continue;
    // A stretch counts as filled only when a point of the pattern made it in. The partial end fit and the constraint
    // pass can leave just the two ends; the selected points between them then stay (absence is never destructive),
    // and the edge points of anchors 'outside' are not inserted on their own.
    if (!res.patternPoints) { warn('too-short', { minMs: 2 * cfg.minLeg }); continue; }
    for (const p of res.insert) inserted.push(p);
    for (let i = 1; i < res.chain.length; i++) {
      const a = res.chain[i - 1], b = res.chain[i], dt = b.at - a.at, dp = Math.abs(b.pos - a.pos);
      if (dt > 0 && dp > 0) { const v = (dp / dt) * 1000; legStats.sum += v; legStats.n++; legStats.max = Math.max(legStats.max, v); }
    }
    stretches.push({ startMs: L.at, endMs: R.at, points: res.insert.length, tempo: res.tempo, endFit: res.endFit });
  }
  if (!stretches.length && !anyCandidate) {
    if (cfg.mode === 'gap') warn('no-gap');
    else warn('too-short', { minMs: 2 * cfg.minLeg });
  }

  // ---- the new action list: the kept points (unchanged) plus the fill ----
  // When nothing could be filled, the selection's points stay: absence is never destructive.
  const filled = stretches.length > 0;
  const keep = filled ? keptIdx : acts.map((_, i) => i);
  const out = [];
  let p = 0;
  inserted.sort((a, b) => a.at - b.at);
  for (const i of keep) {
    while (p < inserted.length && inserted[p].at < acts[i].at) out.push(inserted[p++]);
    out.push({ at: acts[i].at, pos: acts[i].pos });
  }
  while (p < inserted.length) out.push(inserted[p++]);

  const tempos = stretches.map((s) => s.tempo).filter((t) => t !== null);
  return {
    actions: withBroken(out),
    inserted: inserted.map((a) => ({ at: a.at, pos: a.pos })),
    removedCount: filled ? removedCount : 0,
    warnings,
    stats: {
      points: inserted.length,
      stretches: stretches.length,
      mean: legStats.n ? Math.round(legStats.sum / legStats.n) : 0,
      max: Math.round(legStats.max),
      tempo: tempos.length === 1 ? tempos[0] : null,
      cap: cfg.cap,
      speed: { from: cfg.speedA, to: cfg.speedB },
    },
    removed: filled ? acts.filter((_, i) => !kept[i]).map((a) => ({ at: a.at, pos: a.pos })) : [],
    stretches,
  };
}

function emptyStats() {
  return { points: 0, stretches: 0, mean: 0, max: 0, tempo: null, cap: null, speed: null };
}

const seedFor = (seed, k) => (k === 0 ? seed : typeof seed === 'number' ? seed + k : `${seed}:${k}`);

/** The options as plain numbers and words, with the pattern's own values filled in. */
function resolveOptions(o, desc) {
  const own = numOr(desc.speed, 0) > 0 ? desc.speed : 120;
  const asked = numOr(o.speed, NaN);
  const speedGiven = asked > 0;
  const rampRaw = o.ramp && typeof o.ramp === 'object' ? o.ramp.to : o.ramp;
  const rampTo = numOr(rampRaw, NaN) > 0 ? Number(rampRaw) : null;
  const speedA = speedGiven ? asked : own;
  const speedB = rampTo !== null ? rampTo : speedA;
  const capAsked = numOr(o.maxSpeed, NaN);
  const cap = capAsked > 0 ? capAsked : Math.max(FILL_DEFAULT_CAP, 1.5 * Math.max(speedA, speedB));
  const minLeg = numOr(o.minLegMs, NaN) > 0 ? Math.round(o.minLegMs) : FILL_MIN_LEG_MS;
  const minVib = Math.min(minLeg, numOr(o.minVibLegMs, NaN) > 0 ? Math.round(o.minVibLegMs) : FILL_MIN_VIB_LEG_MS);
  let range = null;
  if (o.range && typeof o.range === 'object') {
    const lo = Number(Array.isArray(o.range) ? o.range[0] : o.range.min), hi = Number(Array.isArray(o.range) ? o.range[1] : o.range.max);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const a = clamp(Math.round(Math.min(lo, hi)), 0, 100), b = clamp(Math.round(Math.max(lo, hi)), 0, 100);
      range = { min: a, max: b };
    }
  }
  const strokeOwn = numOr(desc.strokeMs, 0) > 0 ? desc.strokeMs : 1000;
  return {
    speedGiven, speedA, speedB, rampTo, cap, minLeg, minVib, range,
    reversed: o.reversed === true,
    variation: numOr(o.variation, 1),
    seed: o.seed !== undefined && o.seed !== null && o.seed !== '' ? o.seed : 1,
    join: clamp(numOr(o.joinSmoothness, 0.5), 0, 1),
    endFit: o.endFit === 'partial' ? 'partial' : 'stretch',
    mode: o.mode === 'gap' ? 'gap' : 'replace',
    anchors: o.anchors === 'outside' ? 'outside' : 'keep',
    strokeAt: (v) => strokeOwn * clamp(own / Math.max(1, v), 0.25, 4),
  };
}

/** A signed leg speed (u/s) and its direction, or null when the leg does not exist. */
function legOf(a, b) {
  if (!a || !b || !(b.at > a.at)) return null;
  const dp = b.pos - a.pos;
  return { dir: Math.abs(dp) >= 1 ? sgn(dp) : 0, vel: (dp / (b.at - a.at)) * 1000 };
}
const capVel = (v, cap) => clamp(v, -cap, cap);

/**
 * An existing point as an end. Its heading (used when a fill starts there): in replace mode the leg to the original
 * next point (the one being replaced), else the leg into it. Its arrival (when a fill ends there): in replace mode
 * the leg from the original previous point, else the leg that leaves it, read as a turn (it goes down after it, so
 * a stroke arrives going up).
 */
/** A point as the fill plans with it: its position held to 0-100 (EditableScript keeps raw positions). */
const planPoint = (a) => (a ? { at: a.at, pos: clamp(a.pos, 0, 100) } : a);

function pointEnd(acts, i, cfg) {
  const a = planPoint(acts[i]), prev = planPoint(acts[i - 1]), next = planPoint(acts[i + 1]);
  const into = legOf(prev, a), out = legOf(a, next);
  let head = null, arr = null;
  if (cfg.mode === 'replace') {
    head = out && out.dir ? out : into && into.dir ? into : null;
    arr = into && into.dir ? into : out && out.dir ? { dir: -out.dir, vel: -out.vel } : null;
  } else {
    head = into && into.dir ? into : null;
    arr = out && out.dir ? { dir: -out.dir, vel: -out.vel } : null;
  }
  return mkEnd(a.at, a.pos, false, false, head, arr, cfg);
}

/**
 * A selection edge as an end. With a kept point on its outer side it sits on the script's own line through the edge
 * (the motion outside the selection is unchanged) and is inserted as a new point; with none it is free (the
 * pattern starts, or stops, as it likes there).
 */
function edgeEnd(acts, keptIdx, t, side, cfg) {
  let pi = -1, ni = -1;
  for (const i of keptIdx) { if (acts[i].at < t) pi = i; else if (acts[i].at > t) { ni = i; break; } }
  const prev = pi >= 0 ? planPoint(acts[pi]) : null, next = ni >= 0 ? planPoint(acts[ni]) : null;
  const outer = side === 'start' ? prev : next;
  if (!outer) return mkEnd(t, null, true, true, null, null, cfg);
  const at = side === 'start' ? Math.max(t, prev.at + cfg.minLeg) : Math.min(t, next.at - cfg.minLeg);
  const c = prev && next ? (prev.pos - 50) + ((next.pos - 50) - (prev.pos - 50)) * ((at - prev.at) / (next.at - prev.at)) : outer.pos - 50;
  const line = prev && next ? legOf(prev, next) : null;
  const ref = line && line.dir ? line : null;
  return mkEnd(at, posOf(c), false, true, ref, ref, cfg);
}

function mkEnd(at, pos, free, virtual, head, arr, cfg) {
  const e = { at, pos, free, virtual, headDir: 0, headVel: 0, arrDir: 0, arrVel: 0 };
  if (head) { e.headDir = head.dir; e.headVel = capVel(head.vel, cfg.cap); }
  if (arr) { e.arrDir = arr.dir; e.arrVel = capVel(arr.vel, cfg.cap); }
  // A direction that cannot be had at an end stop is no direction.
  if (!free) {
    if ((e.headDir > 0 && pos >= 100) || (e.headDir < 0 && pos <= 0)) { e.headDir = 0; }
    if ((e.arrDir > 0 && pos <= 0) || (e.arrDir < 0 && pos >= 100)) { e.arrDir = 0; e.arrVel = 0; }
  }
  return e;
}

/** A node of the working chain: c = position - 50 (float until the end), vib = the leg into it is a buzz leg. */
const node = (at, c, vib, eng, insert) => ({ at, c, vib: !!vib, eng: !!eng, insert: !!insert, pos: 0 });

/**
 * Fill one stretch from L to R. Returns { chain, insert, tempo, endFit, patternPoints } (patternPoints = how many
 * points of the pattern made it in, not counting the two ends) or null when the engine gave nothing.
 */
function fillStretch({ L, R, seed, vA, vB, cfg, render, patternId, warn }) {
  const t0 = L.at, t1 = R.at, W = t1 - t0;
  const strokeMs = cfg.strokeAt((vA + vB) / 2);
  const fixedR = !R.free;

  // Render D ms from t0 and turn it into the head (A, or the render's own first point when the start is free) and the
  // rendered points after it, started the way A is heading.
  const renderFrom = (D) => {
    const opts = { durationMs: D, from: t0, reversed: cfg.reversed, variation: cfg.variation, seed, maxSpeed: cfg.cap };
    if (cfg.range) opts.range = { min: cfg.range.min, max: cfg.range.max };
    if (!L.free) { opts.startPos = L.pos; if (L.headDir) opts.startDir = L.headDir; }
    if (cfg.speedGiven || vA !== vB) {
      opts.speed = vA;
      // the engine ramps over the whole render: carry the selection's ramp on past R at the same slope
      if (vA !== vB) opts.ramp = { to: Math.max(5, vA + ((vB - vA) * D) / W) };
    }
    let res = null;
    try { res = render(patternId, opts); } catch (e) { res = null; }
    if (!res || !Array.isArray(res.actions) || !res.actions.length) return null;
    // The rendered points, sorted, from t0 on (the engine's own first point is A itself when A is fixed).
    let P = [];
    for (let i = 0; i < res.actions.length; i++) {
      const a = res.actions[i];
      const at = Math.round(Number(a.at)), pos = Number(a.pos);
      if (!Number.isFinite(at) || !Number.isFinite(pos) || at < t0) continue;
      if (P.length && at <= P[P.length - 1].at) continue;
      P.push(node(at, clamp(pos, 0, 100) - 50, res.vib && res.vib[i], true, true));
    }
    let head;
    if (L.free) {
      if (!P.length) return null;
      head = P[0]; head.at = t0; head.vib = false;
      P = P.slice(1);
    } else {
      head = node(t0, L.pos - 50, false, false, L.virtual);
      P = P.filter((q) => q.at > t0);
    }
    // ---- the start: carry on the way A is heading ----
    if (!L.free && L.headDir && P.length >= 3) P = alignStart(head, P, L.headDir, cfg, strokeMs);
    // ---- the move in: no slow glide out of A (the rest of the fill moves earlier by the time saved) ----
    let shift = 0;
    if (!L.free && P.length >= 2) ({ P, shift } = quickerEntry(head, P, cfg, vA));
    return { head, P, warnings: res.warnings || [], shift };
  };

  // A fixed end needs room past it: the start may move ahead by a stroke and the last leg runs past B's time. The
  // first render reaches tempo 1 with that room; only when nothing fits there is a second one rendered as far as the
  // 0.87 squeeze can reach (the live preview stays one render in the common case).
  const room = Math.max(300, 2 * strokeMs);
  let r = renderFrom(fixedR ? Math.ceil(W + room) : W);
  if (!r) { warn('render-failed'); return null; }
  let { head, P } = r;
  const engineWarnings = r.warnings;

  // ---- the end ----
  let fill, tempo = null, endFit;
  if (!fixedR) {
    // A free end renders exactly the window, but a start moved ahead to A's heading (alignStart) moves the whole fill
    // earlier with it, and it then stopped short of the selection (by up to several seconds). Rendered again as far
    // as that, and cut at the selection's end.
    const lastAt = P.length ? P[P.length - 1].at : t0;
    if (!L.free && (L.headDir || r.shift > 0) && t1 - lastAt > strokeMs) {
      const r2 = renderFrom(Math.ceil(W + (t1 - lastAt) + room));
      if (r2 && r2.P.length && r2.P[r2.P.length - 1].at > lastAt) ({ head, P } = r2);
    }
    fill = P.filter((q) => q.at <= t1);
    endFit = 'free';
  } else {
    const tail = node(t1, R.pos - 50, false, false, R.virtual);
    let pick = null;
    if (cfg.endFit === 'stretch') {
      pick = pickStretch(head, P, tail, R.arrDir, cfg, vB);
      const far = Math.ceil(W / FILL_TEMPO_MIN + room);
      if (!pick && far > W + room) {
        const r2 = renderFrom(far);
        if (r2) {
          const pick2 = pickStretch(r2.head, r2.P, tail, R.arrDir, cfg, vB);
          if (pick2) { ({ head, P } = r2); pick = pick2; }
        }
      }
    }
    if (pick) {
      fill = P.slice(0, pick.i).map((q) => ({ ...q, at: Math.round(t0 + (q.at - t0) * pick.f) }));
      tempo = Math.round(pick.f * 1000) / 1000;
      endFit = 'stretch';
    } else {
      if (cfg.endFit === 'stretch') warn('end-fit-partial');
      // A start moved earlier (alignStart, quickerEntry) moves the whole render earlier with it: when it now stops
      // short of B, the cut left one long glide onto B. Rendered once more as far as that (fixup-2).
      const lastAt = P.length ? P[P.length - 1].at : t0;
      if (lastAt < t1 + cfg.minLeg) {
        const r3 = renderFrom(Math.ceil(W + room + (t1 + room - lastAt)));
        if (r3 && r3.P.length && r3.P[r3.P.length - 1].at > lastAt) ({ head, P } = r3);
      }
      fill = P.filter((q) => q.at < t1);
      const landV = 0.5 * Math.min(Math.max(1, vB), cfg.cap);
      while (fill.length) {
        const c = fill[fill.length - 1], dt = t1 - c.at;
        const dB = Math.abs(R.pos - 50 - c.c);
        if (dt >= cfg.minLeg && (dB / dt) * 1000 <= cfg.cap + 0.5) break;
        // c is too close to B. Dropping it turned the leg before it (a hold of the pattern, or a crawl) into a glide
        // onto B for seconds (fixup-2): when that glide would be long (over FILL_LONG_LEG_MS) and run under half the
        // fill's speed, c moves earlier instead, just far enough for a legal last leg, if the leg into it allows.
        const p = fill.length >= 2 ? fill[fill.length - 2] : head;
        const at = t1 - Math.ceil(Math.max(cfg.minLeg, (dB / cfg.cap) * 1000)), d0 = at - p.at;
        const glide = (Math.abs(R.pos - 50 - p.c) / (t1 - p.at)) * 1000;
        if (t1 - p.at > FILL_LONG_LEG_MS && glide < landV && d0 >= cfg.minLeg && (Math.abs(c.c - p.c) / d0) * 1000 <= cfg.cap) { c.at = at; break; }
        fill.pop();
      }
      // The cut lies inside a long leg of the render (a hold, or a slow leg of the pattern) and the straight leg from
      // its start onto B would glide (long, under half the fill's speed): the fill follows that leg of the pattern up
      // to just before B and lands from there (fixup-2).
      const c = fill.length ? fill[fill.length - 1] : null;
      const j = c ? P.indexOf(c) : -1;
      const n = j >= 0 ? P[j + 1] : null;
      if (c && n && n.at > t1 && t1 - c.at > FILL_LONG_LEG_MS && (Math.abs(R.pos - 50 - c.c) / (t1 - c.at)) * 1000 < landV) {
        const tm = t1 - Math.ceil(Math.max(cfg.minLeg, (100 / cfg.cap) * 1000));
        if (tm - c.at >= cfg.minLeg) fill.push(node(tm, c.c + ((n.c - c.c) * (tm - c.at)) / (n.at - c.at), false, true, true));
      }
      endFit = 'partial';
    }
    fill.push(tail);
  }
  for (const w of engineWarnings) if (w && typeof w.code === 'string') warn(w.code, w.values);

  const chain = [head, ...fill];
  // ---- the blend: from the neighbour's own motion into the pattern ----
  const blend = Math.min(cfg.join * strokeMs, FILL_MAX_BLEND_SHARE * W);
  if (blend > 0) {
    const last = chain.length - 1;
    for (let i = 1; i < last; i++) {
      const q = chain[i];
      if (!L.free && q.at - t0 < blend) {
        const w = smoothstep((q.at - t0) / blend);
        const line = clamp(L.pos - 50 + (L.headVel * (q.at - t0)) / 1000, -50, 50);
        q.c = line * (1 - w) + q.c * w;
      }
      if (fixedR && t1 - q.at < blend) {
        const w = smoothstep((t1 - q.at) / blend);
        const line = clamp(R.pos - 50 - (R.arrVel * (t1 - q.at)) / 1000, -50, 50);
        q.c = line * (1 - w) + q.c * w;
      }
    }
  }
  for (const q of chain) q.pos = posOf(q.c);
  head.pos = L.free ? head.pos : L.pos;
  if (fixedR) chain[chain.length - 1].pos = R.pos;

  constrain(chain, cfg, warn);
  // Whole ms from 0, whole positions 0-100, whatever the input held.
  const insert = chain.filter((q) => q.insert).map((q) => ({ at: Math.max(0, Math.round(q.at)), pos: clamp(Math.round(q.pos), 0, 100) }));
  const patternPoints = chain.filter((q) => q.eng && q.insert).length;
  return { chain: chain.map((q) => ({ at: q.at, pos: q.pos })), insert, tempo, endFit, patternPoints };
}

/**
 * The render set off away from A's heading (and A is not at the band's edge it heads for): start at the first turn
 * that lies ahead of A in that direction instead, reached at the pattern's own local speed.
 */
function alignStart(head, P, dir, cfg, strokeMs) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < P.length; i++) { lo = Math.min(lo, P[i].c); hi = Math.max(hi, P[i].c); }
  const a = head.c;
  const nearEdge = dir > 0 ? a >= hi - FILL_EDGE_ZONE : a <= lo + FILL_EDGE_ZONE;
  if (nearEdge) return P;
  const j = P.findIndex((q) => Math.abs(q.c - a) >= 1);
  if (j < 0 || sgn(P[j].c - a) === dir) return P;
  for (let k = j + 1; k < P.length; k++) {
    const prev = P[k - 1], q = P[k], nx = P[k + 1];
    const arrives = sgn(q.c - prev.c) === dir;
    const ahead = (q.c - a) * dir >= 1;
    const turns = !nx || sgn(nx.c - q.c) !== dir;
    if (!(arrives && ahead && turns)) continue;
    const dt = q.at - prev.at, dp = Math.abs(q.c - prev.c);
    const v = dt > 0 && dp > 0 ? (dp / dt) * 1000 : 160 / Math.max(1, strokeMs / 1000);
    const dist = Math.abs(q.c - a);
    const ell = Math.ceil(Math.max(cfg.minLeg, (dist / Math.min(v, cfg.cap)) * 1000));
    const shift = head.at + ell - q.at;
    const out = P.slice(k).map((p) => ({ ...p, at: p.at + shift }));
    out[0].vib = false;
    return out;
  }
  return P;
}

/** ms: the longest the move in or the landing leg may take: max(2 x the longest leg between rendered points, 500). */
function longLegLimit(P) {
  let body = 0;
  for (let i = 1; i < P.length; i++) body = Math.max(body, P[i].at - P[i - 1].at);
  return Math.max(2 * body, FILL_LONG_LEG_MS);
}

/**
 * The move in from A (the engine eases into the pattern's band at its entry speed, as low as 30 u/s) takes at most
 * longLegLimit, less the stretch fit's slowest tempo (1.15) that may still scale it: then it runs at the fill's speed
 * v (at least the minimum leg, never over the cap) and the rest of the fill moves earlier by the time saved (shift).
 */
function quickerEntry(head, P, cfg, v) {
  const dt = P[0].at - head.at;
  const lim = longLegLimit(P) / FILL_TEMPO_MAX;
  if (dt <= lim) return { P, shift: 0 };
  const dist = Math.abs(P[0].c - head.c);
  const floor = Math.max(cfg.minLeg, (dist / cfg.cap) * 1000);
  const want = Math.max(floor, (dist / Math.min(Math.max(1, v), cfg.cap)) * 1000);
  const ell = Math.ceil(Math.max(floor, Math.min(want, lim)));
  const shift = dt - ell;
  if (!(shift > 0)) return { P, shift: 0 };
  return { P: P.map((p) => ({ ...p, at: p.at - shift })), shift };
}

/**
 * The stretch end fit. Candidates are rendered points r (i) that stand in for B: the fill ends with the point c before
 * r and then B. The last leg c -> B keeps the local leg speed (at least the minimum leg, never over the cap, never
 * under half the fill's speed at B, never longer than longLegLimit), and the fill before it is scaled by
 * f = (W - last leg) / (c - t0). Accepted when 0.87 <= f <= 1.15, every scaled leg keeps
 * its minimum and the cap, and the last leg arrives the way B wants. Score: position gap + 20 |ln f|.
 */
function pickStretch(head, P, tail, arrDir, cfg, vB) {
  const t0 = head.at, W = tail.at - t0;
  // B outside the pattern's band on the far side of its arrival (no point of the pattern lies on the side it would
  // come from) cannot be reached that way: the pattern then arrives from its own side.
  if (arrDir && !P.some((q) => sgn(tail.c - q.c) === arrDir)) arrDir = 0;
  // The last leg is drawn from r's leg; from a hold or a slow leg it glided onto B: held to the long-leg limit.
  const lim = longLegLimit(P);
  const landV = 0.5 * Math.min(Math.max(1, numOr(vB, 1)), cfg.cap);
  let lower = 0; // the smallest f the legs so far allow (minimum legs, cap)
  let best = null;
  let prev = head;
  for (let i = 0; i < P.length; i++) {
    const q = P[i];
    // leg prev -> q joins the fill if a later point is chosen
    if (i >= 1) {
      const c = P[i - 1];
      const span = c.at - t0;
      if (span * FILL_TEMPO_MIN > W) break;
      const dist = Math.abs(tail.c - c.c);
      const dirOk = !arrDir || dist < 1 || sgn(tail.c - c.c) === arrDir;
      if (dirOk && span > 0) {
        const rDist = Math.abs(q.c - c.c);
        const ratio = rDist >= 1 ? clamp(dist / rDist, 0.5, 2) : 1;
        // r's own leg, but never slower than half the fill's speed at B: from a hold (or a crawl) of the pattern
        // the last leg glided onto B for seconds (fixup-2)
        const lNom = Math.min((q.at - c.at) * ratio, Math.max(cfg.minLeg, (dist / landV) * 1000));
        let f = W / (span + lNom);
        let ell = lNom * f;
        const ellMin = Math.max(cfg.minLeg, (dist / cfg.cap) * 1000);
        if (ell < ellMin) { ell = ellMin; f = (W - ell) / span; }
        else if (ell > lim) { ell = lim; f = (W - ell) / span; }
        if (f >= FILL_TEMPO_MIN && f <= FILL_TEMPO_MAX && f >= lower) {
          const score = Math.abs(q.c - tail.c) + 20 * Math.abs(Math.log(f));
          if (!best || score < best.score - 1e-9) best = { i, f, score };
        }
      }
    }
    // fold the leg prev -> q into the bound
    const dt = q.at - prev.at;
    if (dt > 0) {
      const need = q.vib && q.eng && prev.eng ? cfg.minVib : cfg.minLeg;
      lower = Math.max(lower, need / dt, (Math.abs(q.c - prev.c) / dt) * 1000 / cfg.cap);
    } else lower = Infinity;
    prev = q;
  }
  return best;
}

/**
 * The constraint pass over [A, fill..., B]: drop points that make a leg shorter than its minimum, then hold every leg
 * to the cap by moving inner points toward their neighbours (a forward pass inside the band B can still be reached
 * from). The chain's two ends never move.
 */
function constrain(chain, cfg, warn) {
  const need = (i) => (chain[i].vib && chain[i].eng && chain[i - 1].eng ? cfg.minVib : cfg.minLeg);
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].at - chain[i - 1].at >= need(i)) continue;
    const last = chain.length - 1;
    let victim;
    if (i - 1 === 0 && i === last) break; // A -> B itself (the caller made sure it is long enough)
    else if (i - 1 === 0) victim = i;
    else if (i === last) victim = i - 1;
    else victim = deviation(chain, i - 1) < deviation(chain, i) ? i - 1 : i;
    if (victim + 1 < chain.length) chain[victim + 1].vib = chain[victim + 1].vib && chain[victim].vib;
    chain.splice(victim, 1);
    i = Math.max(0, victim - 1);
  }
  const reach = (dt) => Math.floor(((cfg.cap + 0.5) * dt) / 1000 + 1e-9);
  const back = () => {
    const R = new Array(chain.length).fill(0);
    for (let i = chain.length - 2; i >= 0; i--) R[i] = R[i + 1] + reach(chain[i + 1].at - chain[i].at);
    return R;
  };
  let Rb = back();
  const end = () => chain[chain.length - 1].pos;
  while (Math.abs(chain[0].pos - end()) > Rb[0] && chain.length > 2) {
    chain.splice(chain.length - 2, 1);
    Rb = back();
  }
  if (Math.abs(chain[0].pos - end()) > Rb[0]) { warn('join-too-fast'); return; }
  const B = end();
  for (let i = 1; i < chain.length - 1; i++) {
    const r = reach(chain[i].at - chain[i - 1].at), p0 = chain[i - 1].pos;
    const lo = Math.max(p0 - r, B - Rb[i], 0), hi = Math.min(p0 + r, B + Rb[i], 100);
    chain[i].pos = clamp(chain[i].pos, lo, hi);
  }
}

/** How far point i sits off the line between its neighbours (its weight when one of two must go). */
function deviation(chain, i) {
  const a = chain[i - 1], q = chain[i], b = chain[i + 1];
  if (!a || !b) return Infinity;
  const f = (q.at - a.at) / (b.at - a.at);
  return Math.abs(q.pos - (a.pos + (b.pos - a.pos) * f));
}
