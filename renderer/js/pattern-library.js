// Pattern library engine: renders the library's stroke patterns as funscript
// actions. Pure: no DOM, no Node APIs, no settings, no devices; seeded and
// deterministic (same id + options + seed = the same actions, everywhere).
//
// A port of a private research generator (minus its file and command-line
// parts). Its maths, its seeded random streams (mulberry32 + FNV-1a, one fresh
// stream per cycle), its constants (legs at least 100 ms, buzz legs at least
// 50 ms, a speed cap of 600 u/s or 1.5x the asked speed) are unchanged, so the
// output at the defaults is byte-identical to the generator's; the parity test
// (pattern-library-parity.test.js) holds it to that. The models come from
// pattern-library-data.js; names and descriptions are in the locale files
// under patterns.<id>.name and .desc.
//
// Two options are new: startDir (which way the device is heading at the start)
// and variation (how much the seeded jitter varies the strokes, 0-2). Both
// leave the output untouched at their defaults (no startDir, variation 1).
//
//   renderPattern(id, { durationMs, from, startPos, startDir, speed, ramp: { to },
//                       reversed, range: { min, max }, variation, seed, maxSpeed, allowFast })
//     -> { actions: [{ at, pos }], vib: [bool], stats, warnings: [{ code, values }], params } | null
//   renderLoop(id, { speed, reversed, range, seed, targetMs }) -> { actions, vib, loopMs, fallback, warnings } | null
//     (a range narrower than MIN_LOOP_BAND, 5 units, is widened about its middle: warning range-widened)
//
// Times are ms, positions 0-100, speeds u/s (the FunSync mean: |dpos| / dt over
// the moving legs). vib[i] is true when the leg ENDING at actions[i] is a
// vibration (buzz) leg; those may be as short as 50 ms.
//
// The six simple shapes (pattern-library-shapes.js, family 'simple-shapes',
// ids shape-sine etc.; pattern settings unification 2026-11-19) are merged in
// after the catalogue: listed, described, rendered and looped through this
// API like any pattern. They are drawn exactly as script-modifiers.js
// generatePattern draws them (and loop as the Orgasm Switch's Generated
// pattern did), so the minimum legs and the speed cap above do NOT hold for
// them: square and sawtooth keep their 1 ms instant edges, and a caller that
// needs the limits applies them (fillRange's constraint pass, the gap
// filler's slew limiter).

import { PATTERN_DATA } from './pattern-library-data.js';
import {
  SHAPE_FAMILY, SHAPE_IDS, isShapeId, describeShape, renderShape, renderShapeLoop,
} from './pattern-library-shapes.js';

/** Part of every cache key built from a render: bump it when the output of any render changes. */
export const PATTERN_ENGINE_VERSION = 1;
/** ms: the shortest ordinary leg. */
export const MIN_LEG = 100;
/** ms: the shortest vibration (buzz) leg. */
export const MIN_BUZZ = 50;
/** ms: the shortest leg of any kind with allowFast. */
export const FAST_LEG = 17;
/** u/s: no leg faster, unless 1.5x the asked speed is higher (or maxSpeed says otherwise). */
export const DEFAULT_MAX_SPEED = 600;
/**
 * u/s: the hard ceiling for every pattern the app plays or writes (Dave,
 * 2026-11-17: 600 is reasonable, and it stays the ceiling everywhere;
 * notes/features/device-speed-limits-2026-11-17.md). Callers pass it as
 * maxSpeed, so the 1.5x escape above never applies to them: the Fill drawer
 * (preview, Worker, Apply, the pop-out's check) and the Orgasm / Edge loops
 * (pattern-source.js passes DEFAULT_MAX_SPEED, the same number; a test keeps
 * the two equal).
 */
export const PATTERN_SPEED_CEILING = 600;
/** The variation option's bounds (1 = the generator's own jitter). */
export const VARIATION_MIN = 0;
export const VARIATION_MAX = 2;

const PATTERNS = new Map(PATTERN_DATA.patterns.map((p) => [p.id, p]));

// ---------- small helpers ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, x) => a + (b - a) * x;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
/** A fresh seeded stream for cycle k: the same cycle always gets the same variation, whatever else changes. */
function rngFor(seed, k, salt) { const r = mulberry32(hash32(`${seed}|${salt}|${k}`)); r(); return r; }
const U = (r, a, b) => a + (b - a) * r();
/**
 * A jitter draw, scaled by the variation option around c (the unjittered value; by default the middle of [a, b]).
 * At variation 1 it is exactly U(r, a, b); at every variation it takes exactly one draw, so a seed means the same
 * strokes whatever the variation.
 */
const J = (ctx, r, a, b, c = (a + b) / 2) => { const x = U(r, a, b); return ctx.vari === 1 ? x : c + (x - c) * ctx.vari; };

/** FunSync speed stats: plain mean of |dpos|/dt*1000 over moving legs with dt > 0, the max, and the position range. */
function stats(actions, from = -Infinity, until = Infinity) {
  let n = 0, sum = 0, max = 0, lo = 100, hi = 0, any = false;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.at >= from && a.at <= until) { lo = Math.min(lo, a.pos); hi = Math.max(hi, a.pos); any = true; }
    if (i === 0) continue;
    const p = actions[i - 1];
    if (p.at < from || a.at > until) continue;
    const dt = a.at - p.at, dp = Math.abs(a.pos - p.pos);
    if (dt <= 0 || dp === 0) continue;
    const v = (dp / dt) * 1000; sum += v; n++; if (v > max) max = v;
  }
  return { mean: n ? sum / n : 0, max, lo: any ? lo : null, hi: any ? hi : null, legs: n };
}
/** { mean, max, lo, hi, legs } of an action list, measured the way the engine measures its own renders. */
export function actionStats(actions) { return stats(Array.isArray(actions) ? actions : []); }

// ---------- units: the shape of one cycle ----------
function interpKf(kf, t) {
  if (t <= kf[0].t) return kf[0].p;
  for (let i = 1; i < kf.length; i++) if (t <= kf[i].t) { const a = kf[i - 1], b = kf[i]; return b.t === a.t ? b.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t); }
  return kf[kf.length - 1].p;
}
/** Key points of a keyframe curve: the ends, turning points (hysteresis h) and both ends of any flat stretch (a hold). */
function extremaOf(kf, h = 0.05) {
  const key = new Array(kf.length).fill(false); key[0] = key[kf.length - 1] = true;
  let dir = 0, ext = 0;
  for (let i = 1; i < kf.length; i++) {
    const p = kf[i].p, pe = kf[ext].p;
    if (dir === 0) { if (Math.abs(p - kf[0].p) >= h) { dir = Math.sign(p - kf[0].p); ext = i; } continue; }
    if (dir > 0) { if (p >= pe) ext = i; else if (pe - p >= h) { key[ext] = true; dir = -1; ext = i; } }
    else { if (p <= pe) ext = i; else if (p - pe >= h) { key[ext] = true; dir = 1; ext = i; } }
  }
  for (let i = 0; i < kf.length - 1; i++) if (Math.abs(kf[i + 1].p - kf[i].p) <= 0.02 && kf[i + 1].t - kf[i].t >= 0.08) key[i] = key[i + 1] = true;
  return kf.filter((_, i) => key[i]).map((q) => ({ ...q }));
}
/** Index shape points by their bounding turning points, mark holds and tops. */
function finalizeUnit(pts) {
  const n = pts.length;
  for (let j = 0; j < n; j++) if (!pts[j].tp) { let a = j - 1; while (!pts[a].tp) a--; let b = j + 1; while (!pts[b].tp) b++; pts[j].ia = a; pts[j].ib = b; }
  for (let j = 0; j < n; j++) if (!pts[j].tp) pts[j].p = pts[pts[j].ia].p + pts[j].u * (pts[pts[j].ib].p - pts[pts[j].ia].p);
  for (let j = 0; j < n; j++) {
    const e = pts[j];
    e.top = !!(e.tp && e.p >= 0.95);
    e.holdOf = j > 0 && e.tp && pts[j - 1].tp && Math.abs(e.p - pts[j - 1].p) < 0.03 && e.t - pts[j - 1].t >= 0.06 ? j - 1 : -1;
  }
  return { pts, n };
}
/**
 * A cycle unit: the turning points (stretched to 0-1) plus the keyframe points between them that carry real shape
 * (a stall, a slow start), as progress along their stroke. Points within 0.1 of a cycle and 12% of a turn are
 * corner blur, and points within 0.08 of a straight line add nothing.
 */
function buildCycleUnit(u) {
  const kf = (u.keyframes || []).map(([t, p]) => ({ t, p }));
  const keys = u.turningPoints && u.turningPoints.length >= 3 ? u.turningPoints.map(([t, p]) => ({ t, p })) : extremaOf(kf);
  keys[0].t = 0; keys[keys.length - 1].t = 1;
  const lo = Math.min(...keys.map((q) => q.p)), hi = Math.max(...keys.map((q) => q.p)), span = hi - lo || 1;
  const pts = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    pts.push({ t: a.t, p: (a.p - lo) / span, tp: true });
    const ka = interpKf(kf, a.t), kb = interpKf(kf, b.t);
    if (Math.abs(kb - ka) < 0.05) continue;
    let lastU = 0;
    for (const q of kf) {
      if (q.t <= a.t + 1e-9 || q.t >= b.t - 1e-9) continue;
      const uu = (q.p - ka) / (kb - ka);
      if (uu <= 0.03 || uu >= 0.97 || uu <= lastU + 0.02) continue;
      const w = (q.t - a.t) / (b.t - a.t);
      if (Math.abs(uu - w) < 0.08) continue;
      if ((q.t - a.t < 0.1 && uu < 0.12) || (b.t - q.t < 0.1 && uu > 0.88)) continue;
      pts.push({ t: q.t, u: uu, tp: false }); lastU = uu;
    }
  }
  pts.push({ t: 1, p: pts[0].p, tp: true });
  return finalizeUnit(pts);
}
function maskRegions(b) {
  const out = []; let s = -1;
  for (let i = 0; i <= b.length; i++) { const on = i < b.length && b[i] >= 0.5; if (on && s < 0) s = i; if (!on && s >= 0) { out.push([s / b.length, i / b.length]); s = -1; } }
  return out;
}
function rotateRegions(regs, phi) {
  const out = [];
  for (const [a, b] of regs) {
    let x = a - phi, y = b - phi; if (x < 0) { x += 1; y += 1; }
    if (y <= 1) out.push([x, y]); else { out.push([x, 1]); out.push([0, y - 1]); }
  }
  return out;
}
function rotateUnit(Ubase, r) {
  if (r === 0) return Ubase;
  if (!Ubase.rot) Ubase.rot = new Map();
  if (Ubase.rot.has(r)) return Ubase.rot.get(r);
  const src = Ubase.pts, n = Ubase.n, phi = src[r].t, pts = [];
  for (let j = r; j < n - 1; j++) pts.push({ t: src[j].t - phi, p: src[j].p, u: src[j].u, tp: src[j].tp });
  for (let j = 0; j <= r; j++) pts.push({ t: src[j].t + 1 - phi, p: src[j].p, u: src[j].u, tp: src[j].tp });
  const out = finalizeUnit(pts); out.regions = rotateRegions(Ubase.regions || [], phi); out.ovRegions = rotateRegions(Ubase.ovRegions || [], phi);
  Ubase.rot.set(r, out);
  return out;
}
const BODY_UNIT = Object.assign(finalizeUnit([{ t: 0, p: 0, tp: true }, { t: 0.5, p: 1, tp: true }, { t: 1, p: 0, tp: true }]), { regions: [], ovRegions: [] });
/** Buzz regions long enough (at the pattern's cycle) to hold 3+ zigzag legs get a zigzag; shorter ones are just quick legs. */
function overlayRegions(regs, cycleMs, legMs) {
  if (!regs.length) return [];
  const len = (r) => (r[1] - r[0]) * cycleMs;
  const wrap = regs.length > 1 && regs[0][0] === 0 && regs[regs.length - 1][1] === 1;
  return regs.filter((r, i) => {
    let l = len(r);
    if (wrap && (i === 0 || i === regs.length - 1)) l = len(regs[0]) + len(regs[regs.length - 1]);
    return l >= 3 * legMs;
  });
}
/**
 * Leg times for one cycle. Legs shorter than their minimum get the minimum and borrow the time from the longer
 * legs, so the cycle keeps its length; only when there is not enough to borrow does the cycle grow (capped).
 */
function timeLegs(d, need, st) {
  let deficit = 0, avail = 0;
  for (let i = 0; i < d.length; i++) { if (d[i] < need[i]) deficit += need[i] - d[i]; else avail += d[i] - need[i]; }
  if (deficit <= 0) return d;
  if (avail >= deficit) { const f = deficit / avail; return d.map((x, i) => (x < need[i] ? need[i] : x - (x - need[i]) * f)); }
  st.capped = true;
  return d.map((x, i) => Math.max(x, need[i]));
}

/** A template unit (an uneven phrase): a loop of positions with the share of the pass each leg takes. */
function buildTemplateUnit(u) {
  const kf = u.keyframes.map(([t, p]) => ({ t, p }));
  const lo = Math.min(...kf.map((q) => q.p)), hi = Math.max(...kf.map((q) => q.p)), span = hi - lo || 1;
  const e = kf.map((q) => ({ t: q.t, p: (q.p - lo) / span }));
  const durs = []; for (let i = 0; i < e.length - 1; i++) durs.push(e[i + 1].t - e[i].t);
  let ents, wrap;
  if (Math.abs(e[e.length - 1].p - e[0].p) < 0.08 && e.length > 3) { ents = e.slice(0, -1); wrap = durs.pop(); }
  else { ents = e; wrap = durs.reduce((a, b) => a + b, 0) / durs.length; }
  durs.push(wrap);
  const tot = durs.reduce((a, b) => a + b, 0) || 1;
  const n = ents.length;
  const out = ents.map((q, i) => ({ p: q.p, d: durs[i] / tot }));
  for (let i = 0; i < n; i++) {
    const pv = out[(i - 1 + n) % n].p, nx = out[(i + 1) % n].p, p = out[i].p;
    out[i].tp = Math.sign(p - pv) !== Math.sign(nx - p);
    out[i].high = p >= nx;
  }
  return { ents: out, n };
}

// ---------- the model of one pattern ----------
const MODELS = new Map();
function trendOf(d) {
  const tr = d.trend; if (!tr || ['steady', 'ladder', 'waves'].includes(tr.label)) return null;
  const cr = Math.abs(tr.centreRise || 0) >= 5 ? tr.centreRise : 0;
  const dr = Math.abs(tr.depthRise || 0) >= 5 ? tr.depthRise : 0;
  const tempo = Math.abs(Math.log(tr.tempoRatio || 1)) >= 0.1 ? tr.tempoRatio : 1;
  if (!cr && !dr && tempo === 1) return null;
  return { cr, dr, tempo, label: tr.label };
}
function clipBand(c, w) { return [Math.max(0, c - w / 2), Math.min(100, c + w / 2)]; }
/** The engine's model of a pattern (built once, cached), or null for an unknown id. */
function model(id) {
  if (MODELS.has(id)) return MODELS.get(id);
  const s = typeof id === 'string' ? PATTERNS.get(id) : undefined;
  if (!s) return null;
  const d = s.defaults || {}, r = s.ranges || {}, u = s.unit || {};
  const m = { id, s, d, r, u, kind: s.kind, family: s.family };
  m.buzzShare = d.buzzShare || d.share || 0;
  m.buzzLeg = d.buzzLegMs || d.legMs || 66;
  m.buzzSwing = d.buzzSwing || d.swing || 12;
  m.hasBuzz = m.buzzShare >= 0.15;
  m.jit = clamp(0.5 * (d.regularityCV ?? 0.1), 0.03, 0.07);
  m.phraseMs = (d.phraseSec || 6) * 1000;
  m.speed0 = d.speedMean; m.speedRange = r.speedMean; m.spanRange = r.span || r.depth;
  // frantic: the strokes themselves are the buzz (half a stroke fits in 2.5 buzz legs), so its legs may go to 50 ms
  const strokeMs = d.strokePeriodMs || d.cyclePeriodMs || 1000;
  if (s.kind === 'cycle') {
    m.engine = 'cycle';
    m.frantic = !!(m.hasBuzz && strokeMs / 2 <= 2.5 * m.buzzLeg);
    m.unit = buildCycleUnit(u);
    m.unit.regions = !m.frantic && m.hasBuzz && u.buzz32 ? maskRegions(u.buzz32) : [];
    m.unit.ovRegions = overlayRegions(m.unit.regions, d.cyclePeriodMs || 1000, m.buzzLeg);
    m.overlay = m.unit.ovRegions.length > 0;
    m.kappa = m.overlay && d.strokeSpeed && d.speedMean ? clamp(d.strokeSpeed / d.speedMean, 0.2, 1.2) : 1;
    m.trend = trendOf(d);
    m.env0 = m.trend ? clipBand(d.centre, Math.min(100, d.depth + Math.abs(m.trend.dr) / 2 + Math.abs(m.trend.cr))) : [d.lo, d.hi];
    m.cycleMs = d.cyclePeriodMs;
  } else if (s.kind === 'template') {
    m.engine = 'template';
    m.frantic = !!(m.hasBuzz && strokeMs / 2 <= 2.5 * m.buzzLeg);
    m.tunit = buildTemplateUnit(u);
    m.strokes = u.strokesInTemplate || m.tunit.n / 2;
    m.overlay = m.hasBuzz && !m.frantic;
    m.kappa = m.overlay && d.strokeSpeed && d.speedMean ? clamp(d.strokeSpeed / d.speedMean, 0.2, 1.2) : 1;
    m.env0 = [d.lo, d.hi];
    m.cycleMs = d.cyclePeriodMs;
  } else if (s.kind === 'drone') {
    m.engine = 'drone';
    m.cr = Math.abs(d.centreRise || 0) >= 5 ? d.centreRise : 0;
    m.env0 = clipBand(d.centre, m.buzzSwing + Math.max(d.carrierDepth || 0, Math.abs(m.cr)) + 4);
    m.spanRange = null;
  } else if (s.kind === 'hold') {
    m.engine = 'hold';
    m.speed0 = 150; m.speedRange = [80, 250];
    m.H0 = (d.durationSec || 2) * 1000; m.Hr = (r.durationSec || [1.3, 7.4]).map((x) => x * 1000);
    const p = d.pos ?? 50;
    m.holdType = s.event || (p >= 67 ? 'top' : p <= 33 ? 'bottom' : 'middle');
    m.env0 = m.holdType === 'top' ? [Math.max(0, p - 80), p] : m.holdType === 'bottom' ? [p, Math.min(100, p + 80)] : clipBand(p, 80);
    m.spanRange = [40, 100];
  } else if (s.kind === 'event') {
    m.phraseMs = 6000;
    if (d.drop !== undefined) {
      m.engine = 'drop';
      m.speed0 = d.beforeSpeed; m.speedRange = r.beforeSpeed;
      m.env0 = [d.to ?? 0, d.from ?? 90];
      m.plunge = s.event === 'plunge' || !!(d.ratio && d.ratio > 1.2);
      m.dropRatio = m.plunge ? d.ratio || 1.7 : clamp((d.speed || 1) / (d.beforeSpeed || 1), 0.3, 1);
      m.bodyBand = m.plunge ? [0.4, 0.85] : [0.1, 1];
      // an ending that keeps moving at the base after the drop: small moves of the pattern's size and leg length;
      // legs under 100 ms are buzz legs (50 ms minimum unless allowFast)
      if (d.aftershocks && d.aftershocks.seconds > 0) {
        m.after = d.aftershocks;
        if (m.after.legMs < MIN_LEG) { m.hasBuzz = true; m.buzzLeg = Math.round(m.after.legMs); m.buzzSwing = m.after.firstAmp; }
      }
    } else {
      m.engine = 'envelope';
      m.envShape = u.speedEnvelope || [1, 1, 1, 1, 1, 1, 1, 1];
      m.env0 = [0, 100];
      if (d.startSpeed) { m.speed0 = d.startSpeed; m.speedRange = r.startSpeed; }
      else { m.speed0 = 200; m.speedRange = [120, 320]; }
      m.buzzFinish = d.share !== undefined;
      m.hasBuzz = m.buzzFinish;
    }
    m.spanRange = [60, 100];
  } else return null;
  if (!m.speed0) m.speed0 = 150;
  if (!m.speedRange) m.speedRange = [m.speed0 * 0.5, m.speed0 * 1.6];
  MODELS.set(id, m);
  return m;
}
function envAt(shape, x) { const n = shape.length, f = clamp(x * n - 0.5, 0, n - 1), i = Math.floor(f); return i >= n - 1 ? shape[n - 1] : lerp(shape[i], shape[i + 1], f - i); }

// ---------- option resolution ----------
function fixBand(lo, hi, warn, show = (a, b) => [a, b]) {
  if (lo > hi) [lo, hi] = [hi, lo];
  const l0 = lo, h0 = hi;
  lo = clamp(lo, 0, 100); hi = clamp(hi, 0, 100);
  if (hi - lo < 2) { const c = clamp((lo + hi) / 2, 1, 99); lo = c - 1; hi = c + 1; }
  if (l0 !== lo || h0 !== hi) { const [a, b] = show(l0, h0), [c, d] = show(lo, hi); warn('range-clipped', { from: [a, b], to: [+c.toFixed(1), +d.toFixed(1)] }); }
  return [lo, hi];
}
/**
 * The render context. `o` is already plain numbers (see renderPattern): from, until, startPos?, startDir (-1, 0, 1),
 * speed { a, b } | null, range [lo, hi] | null, seed, variation, maxSpeed?, allowFast.
 */
function resolve(m, o, mir = false) {
  const warnings = [];
  const warn = (code, values) => { const key = code + JSON.stringify(values); if (!warnings.some((w) => w.key === key)) warnings.push({ key, code, values }); };
  // a reversed render runs on mirrored options; positions in warnings are shown in the caller's coordinates
  const showPos = (p) => (mir ? 100 - p : p);
  const showBand = (lo, hi) => (mir ? [100 - hi, 100 - lo] : [lo, hi]);
  const { from, until } = o;
  const allowFast = !!o.allowFast;
  const ctx = { m, from, until, warnings, warn, allowFast, minLeg: allowFast ? FAST_LEG : MIN_LEG, minBuzz: allowFast ? FAST_LEG : MIN_BUZZ, jit: m.jit, mir, showPos, showBand };
  ctx.seed = String(o.seed);
  ctx.vari = o.variation;
  ctx.startDir = o.startDir || 0;
  if (o.startPos !== undefined) ctx.startPos = clamp(o.startPos, 0, 100);
  const xOf = (t) => clamp((t - from) / (until - from), 0, 1);
  ctx.xOf = xOf;
  // where it lives
  const [L0, H0] = m.env0;
  let lo0 = L0, hi0 = H0;
  if (o.range) [lo0, hi0] = fixBand(o.range[0], o.range[1], warn, showBand);
  ctx.rangeAsked = !!o.range;
  ctx.band = { a: [lo0, hi0], b: [lo0, hi0] };
  ctx.lo = () => lo0;
  ctx.hi = () => hi0;
  // how fast
  const shape = m.envShape ? (t) => envAt(m.envShape, xOf(t)) : null;
  let meanShape = 1; if (m.envShape) { let s = 0; for (let i = 0; i < 64; i++) s += envAt(m.envShape, (i + 0.5) / 64); meanShape = s / 64; }
  const sp = o.speed;
  ctx.speedAsked = sp;
  if (sp && sp.a === sp.b) { const v = sp.a; ctx.profile = shape ? (t) => (v * shape(t)) / meanShape : () => v; ctx.objective = { type: 'abs', value: v }; }
  else if (sp) { ctx.profile = (t) => lerp(sp.a, sp.b, xOf(t)); ctx.objective = { type: 'ratio' }; }
  else { const v = m.speed0; ctx.profile = shape ? (t) => v * shape(t) : () => v; ctx.objective = shape ? { type: 'ratio' } : { type: 'abs', value: v }; }
  ctx.knobIsDepth = false;
  ctx.phraseMs = m.phraseMs;
  // the speed cap: no single leg faster than this (zigzags shrink, strokes take longer, the calibration makes up the mean)
  let peak = 0; for (let i = 0; i <= 16; i++) peak = Math.max(peak, ctx.profile(from + ((until - from) * i) / 16));
  if (o.maxSpeed !== undefined) {
    const mx = o.maxSpeed;
    ctx.maxSpeed = mx; ctx.maxSpeedAsked = true;
    if (peak > mx) warn('speed-capped', { speed: Math.round(peak), maxSpeed: mx });
  } else ctx.maxSpeed = Math.max(DEFAULT_MAX_SPEED, 1.5 * peak);
  return ctx;
}

/** The speed knob: k itself, or (when k drives the depth) the speed knob held from the first calibration. */
const speedKnob = (ctx, k) => (ctx.knobIsDepth ? ctx.speedKFixed ?? 1 : k);
/** The depth knob; in floor-tempo mode the depth also follows the speed profile, so ramps still ramp. */
const depthKnob = (ctx, k, t) => (!ctx.knobIsDepth ? 1 : ctx.floorTempo ? (k * ctx.profile(t)) / ctx.profileRef : k);
/**
 * The carrier speed under a buzz overlay. The buzz carries the speed: its swing scales with the asked speed, while
 * the stroke under it only follows the square root, so a fast ask still leaves room for 3+ zigzag legs per stroke.
 */
const overlayCarrier = (ctx, k, t, kap) => kap * ctx.m.speed0 * Math.sqrt(ctx.profile(t) / ctx.m.speed0) * Math.pow(speedKnob(ctx, k), 0.3);
/** Ease-in speed: the pattern's own stroke speed, never more than 1.5x the asked mean. */
const easeSpeed = (ctx, k, kap) => clamp(Math.min(speedKnob(ctx, k) * ctx.profile(ctx.from) * kap, 1.5 * ctx.profile(ctx.from) * kap), 30, 400);

// ---------- buzz: swing and leg length for the current speed ----------
function buzzAt(ctx, k, t, maxSwing = 50) {
  const m = ctx.m;
  const vr = (speedKnob(ctx, k) * ctx.profile(t)) / m.speed0;
  let swing = m.buzzSwing * vr, leg = m.buzzLeg, capped = false;
  if (swing > maxSwing) { leg = (leg * maxSwing) / swing; swing = maxSwing; }
  if (swing < 2) { leg = (leg * 2) / Math.max(0.2, swing); swing = 2; }
  if (leg < ctx.minBuzz) { leg = ctx.minBuzz; capped = true; }
  return { swing, leg: Math.min(leg, 250), capped };
}

// ---------- the start: where in the pattern a render begins ----------
/**
 * startDir: how far a candidate start point is from what the heading asks for. Heading up, the natural start is a
 * top turn (the device carries on up to it, then turns) at least 3 units above startPos; heading down, a bottom
 * turn at least 3 below it. At or past the band's edge no turn is on the right side, so the nearest right-kind
 * turn (the band's top or bottom) wins and the pattern turns there, as a stroke would. 0 without a startDir.
 */
function startDirPenalty(ctx, pos, leavesDown) {
  const dir = ctx.startDir;
  if (!dir) return 0;
  const wrongKind = dir > 0 ? !leavesDown : leavesDown;
  const wrongSide = dir > 0 ? pos < ctx.startPos + 3 : pos > ctx.startPos - 3;
  return (wrongKind ? 1000 : 0) + (wrongSide ? 500 : 0);
}
/** Does the cycle unit leave turning point j going down? (The next point at another height decides; holds skip.) */
function unitLeavesDown(Un, j) {
  const n = Un.n, p = Un.pts[j].p;
  for (let q = 1; q < n; q++) {
    const e = Un.pts[(j + q) % (n - 1)];
    if (Math.abs(e.p - p) >= 0.02) return e.p < p;
  }
  return false;
}

// ---------- engines ----------
/** Ease from startPos to `target` at `v` u/s. Returns the new time. */
function entryLeg(ctx, pts, target, v) {
  const t0 = ctx.from;
  if (ctx.startPos === undefined) { pts.push({ t: t0, p: target, tp: true }); return { t: t0, pos: target }; }
  pts.push({ t: t0, p: ctx.startPos, tp: true });
  const dist = Math.abs(target - ctx.startPos);
  if (dist < 2) return { t: t0, pos: ctx.startPos };
  let dur = Math.max(ctx.minLeg, (dist / clamp(v, 30, 400)) * 1000, (dist / ctx.maxSpeed) * 1000);
  // a short segment: the move in takes at most 30% of it, so the pattern itself gets the rest
  const cap = Math.max(ctx.minLeg, (dist / ctx.maxSpeed) * 1000, 0.3 * (ctx.until - ctx.from));
  if (dur > cap) { ctx.entryCut = { was: dur, now: cap, dist }; dur = cap; } else ctx.entryCut = null;
  pts.push({ t: t0 + dur, p: target, tp: true, entry: true, fixed: true });
  return { t: t0 + dur, pos: target };
}

function cycleEngine(ctx, k, st, ov = {}) {
  const m = ctx.m;
  const base = ov.unit || m.unit;
  const E = ov.E ?? ctx.until;
  const loF = ov.lo || ctx.lo, hiF = ov.hi || ctx.hi;
  const speedK = speedKnob(ctx, k);
  const trend = ov.noTrend ? null : m.trend;
  const kappa = ov.kappa ?? m.kappa ?? 1;
  const frantic = ov.frantic ?? m.frantic;
  const geo = (t) => {
    const Lo = loF(t), Hi = hiF(t), depthK = depthKnob(ctx, k, t);
    let W = Hi - Lo, C = (Lo + Hi) / 2;
    if (depthK !== 1) { const W2 = clamp(W * depthK, 2, 100); if (W * depthK > 100) st.depthMax = true; W = W2; C = clamp(C, W / 2, 100 - W / 2); }
    if (!trend) return { lo: C - W / 2, hi: C + W / 2, pMul: 1 };
    const P = ctx.phraseMs, x = ((((t - ctx.from) % P) + P) % P) / P;
    const d0 = m.d.depth || W, s = W / (d0 + Math.abs(trend.dr) / 2 + Math.abs(trend.cr));
    const dep = s * (d0 + trend.dr * (x - 0.5)), cen = C + s * trend.cr * (x - 0.5);
    return { lo: cen - dep / 2, hi: cen + dep / 2, pMul: Math.pow(trend.tempo, x - 0.5) };
  };
  const overlaid = !!(ov.unit ? false : m.overlay);
  const vAt = (t, kap) => Math.max(1, overlaid ? overlayCarrier(ctx, k, t, kap) : speedK * ctx.profile(t) * kap);
  const pts = [], intervals = [];
  const g0 = geo(ctx.from);
  let r = 0;
  if (ctx.startPos !== undefined) {
    let best = Infinity;
    for (let j = 0; j < base.n - 1; j++) {
      const e = base.pts[j]; if (!e.tp) continue;
      const pj = g0.lo + e.p * (g0.hi - g0.lo);
      const dd = Math.abs(pj - ctx.startPos) + (ctx.startDir ? startDirPenalty(ctx, pj, unitLeavesDown(base, j)) : 0);
      if (dd < best - 1e-9) { best = dd; r = j; }
    }
  }
  const Un = rotateUnit(base, r);
  // the band the start was chosen in: the first cycle's lowest and highest turn (a climb or a sink starts inside
  // its envelope, so this can be narrower than the pattern's whole place)
  { let ulo = Infinity, uhi = -Infinity; for (const e of base.pts) if (e.tp) { ulo = Math.min(ulo, e.p); uhi = Math.max(uhi, e.p); } ctx.startBand = [g0.lo + ulo * (g0.hi - g0.lo), g0.lo + uhi * (g0.hi - g0.lo)]; }
  const n = Un.n;
  let { t, pos } = entryLeg(ctx, pts, g0.lo + Un.pts[0].p * (g0.hi - g0.lo), easeSpeed(ctx, k, kappa));
  const S = t, entry = pos;
  const regs = Un.regions || [];
  const inRegs = (x) => regs.some(([a, b]) => x >= a && x < b);
  let kc = 0, lastP = 0;
  while (t < E && kc < 400000) {
    const rng = rngFor(ctx.seed, kc, ov.salt || 'c');
    const g = geo(t);
    const tf = Un.pts.map((e) => e.t);
    for (let j = 1; j < n - 1; j++) tf[j] = clamp(tf[j] + J(ctx, rng, -0.025, 0.025), tf[j - 1] + 0.012, 1 - 0.012 * (n - 1 - j));
    // each point takes the band (ramp, trend) at its own time, estimated from the last cycle's length
    const Pest = lastP || clamp(((m.cycleMs || 1000) * (m.speed0 || 100)) / Math.max(1, speedK * ctx.profile(t)), 150, 8000);
    const abs = new Array(n); abs[0] = pos;
    for (let j = 1; j < n; j++) {
      const e = Un.pts[j]; if (!e.tp) continue;
      if (e.holdOf >= 0) { abs[j] = abs[e.holdOf]; continue; }
      const gj = geo(t + tf[j] * Pest), D = gj.hi - gj.lo, a = Math.min(5, Math.max(1.5, 0.07 * D), D / 4);
      let p = gj.lo + e.p * D;
      if (e.p >= 0.95) p -= J(ctx, rng, 0, a, 0); else if (e.p <= 0.05) p += J(ctx, rng, 0, a, 0); else p += J(ctx, rng, -a / 2, a / 2);
      abs[j] = clamp(p, Math.max(0, gj.lo), Math.min(100, gj.hi));
    }
    for (let j = 1; j < n; j++) { const e = Un.pts[j]; if (!e.tp) abs[j] = abs[e.ia] + e.u * (abs[e.ib] - abs[e.ia]); }
    const ovPh = ov.overlayFn ? ov.overlayFn(kc, t, rng) : [];
    const kap = ovPh.length && ov.buzzKappa ? ov.buzzKappa : kappa;
    const keep = new Array(n).fill(true);
    const legs = () => { const L = []; let prev = 0; for (let j = 1; j < n; j++) { if (!keep[j]) continue; L.push({ a: prev, b: j, f: tf[j] - tf[prev], dp: Math.abs(abs[j] - abs[prev]), vib: frantic || inRegs((tf[prev] + tf[j]) / 2) }); prev = j; } return L; };
    const solve = (L, v) => { let s = 0, c = 0; for (const l of L) if (l.dp >= 0.5) { s += l.dp / l.f; c++; } return c ? (1000 * s) / c / v : m.cycleMs || 1000; };
    const v = vAt(t, kap);
    const needOf = (l) => (l.vib ? ctx.minBuzz : ctx.minLeg) * 1.08;
    // floor-tempo (the depth fallback): the fastest cycle the turning points allow
    let tpFloor = 0;
    if (ctx.floorTempo) { let prev = 0; for (let j = 1; j < n; j++) { if (!Un.pts[j].tp) continue; const f = tf[j] - tf[prev]; tpFloor = Math.max(tpFloor, (frantic || inRegs((tf[prev] + tf[j]) / 2) ? ctx.minBuzz : ctx.minLeg) * 1.12 / f); prev = j; } }
    let P = 1000, L = legs();
    if (ctx.floorTempo) for (let j = 1; j < n - 1; j++) if (!Un.pts[j].tp) keep[j] = false;
    for (let it = 0; it < 8; it++) {
      L = legs();
      P = ctx.floorTempo ? tpFloor : solve(L, v) * g.pMul;
      let worst = null;
      for (const l of L) {
        if (l.f * P >= needOf(l) * 1.04) continue;
        const cand = !Un.pts[l.b].tp ? l.b : !Un.pts[l.a].tp ? l.a : -1;
        if (cand > 0 && (!worst || l.f < worst.f)) worst = { f: l.f, j: cand };
      }
      if (!worst) break;
      keep[worst.j] = false;
    }
    if (!ctx.floorTempo) P *= 1 + J(ctx, rng, -ctx.jit, ctx.jit);
    const dur = ctx.floorTempo ? L.map((l) => needOf(l) * J(ctx, rng, 1, 1.15, 1)) : timeLegs(L.map((l) => l.f * P), L.map(needOf), st);
    let tt = t;
    L.forEach((l, i) => { tt += dur[i]; pts.push({ t: tt, p: abs[l.b], tp: Un.pts[l.b].tp, top: Un.pts[l.b].top, cyc: l.b === n - 1, vib: l.vib }); });
    const Pt = tt - t;
    for (const [ra, rb] of Un.ovRegions || []) intervals.push([t + clamp(ra + J(ctx, rng, -0.02, 0.02), 0, 1) * Pt, t + clamp(rb + J(ctx, rng, -0.02, 0.02), 0, 1) * Pt]);
    for (const [ra, rb] of ovPh) intervals.push([t + ra * Pt, t + rb * Pt]);
    pos = abs[n - 1]; t = tt; kc++; lastP = Pt;
  }
  return { pts, intervals, S, entry };
}

function templateEngine(ctx, k, st) {
  const m = ctx.m, T = m.tunit, n = T.n, E = ctx.until;
  const speedK = speedKnob(ctx, k);
  const geo = (t) => {
    const Lo = ctx.lo(t), Hi = ctx.hi(t), depthK = depthKnob(ctx, k, t);
    if (depthK === 1) return { lo: Lo, hi: Hi };
    let W = Hi - Lo, C = (Lo + Hi) / 2; if (W * depthK > 100) st.depthMax = true;
    W = clamp(W * depthK, 2, 100); C = clamp(C, W / 2, 100 - W / 2); return { lo: C - W / 2, hi: C + W / 2 };
  };
  const vAt = (t) => Math.max(1, m.overlay ? overlayCarrier(ctx, k, t, m.kappa || 1) : speedK * ctx.profile(t) * (m.kappa || 1));
  const pts = [], intervals = [];
  const g0 = geo(ctx.from);
  let r = 0;
  if (ctx.startPos !== undefined) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const pi = g0.lo + T.ents[i].p * (g0.hi - g0.lo);
      // with a heading, prefer a real turn of the phrase to a point partway along a stroke
      const dd = Math.abs(pi - ctx.startPos) + (ctx.startDir ? startDirPenalty(ctx, pi, T.ents[i].high) + (T.ents[i].tp ? 0 : 250) : 0);
      if (dd < best - 1e-9) { best = dd; r = i; }
    }
  }
  ctx.startBand = [g0.lo, g0.hi];
  let { t, pos } = entryLeg(ctx, pts, g0.lo + T.ents[r].p * (g0.hi - g0.lo), easeSpeed(ctx, k, m.kappa || 1));
  const S = t, entry = pos;
  let kc = 0, lastT = 0;
  // which legs carry the buzz: an even quota (error diffusion from a seeded start) rather than a coin per leg, so
  // every stretch of the render gets close to the pattern's buzz share and speed ramps stay smooth
  let bAcc = rngFor(ctx.seed, 0, 'ba')();
  while (t < E && kc < 200000) {
    const rng = rngFor(ctx.seed, kc, 't');
    if (kc > 0) {
      const cands = []; for (let i = 0; i < n; i++) if (T.ents[i].high === T.ents[r].high && Math.abs(T.ents[i].p - T.ents[r].p) < 0.35) cands.push(i);
      // variation 0 keeps the phrase where it is, so whole passes repeat (the draw is still taken)
      if (cands.length) { const x = rng(); if (ctx.vari > 0) r = cands[Math.floor(x * cands.length)]; }
    }
    const seq = [];
    for (let q = 1; q <= n; q++) {
      const i = (r + q) % n, e = T.ents[i];
      let buzz = false; if (m.overlay) { bAcc += m.buzzShare; if (bAcc >= 1) { buzz = true; bAcc -= 1; } }
      seq.push({ u: clamp(e.p + J(ctx, rng, -0.06, 0.06), 0, 1), f: T.ents[(r + q - 1) % n].d * J(ctx, rng, 0.85, 1.15, 1), tp: e.tp, vib: m.frantic, buzz });
    }
    // each point takes the band at its own (estimated) time
    const Test = lastT || clamp(((m.cycleMs || 1000) * m.strokes * (m.speed0 || 100)) / Math.max(1, speedK * ctx.profile(t)), 300, 20000);
    { const ftot = seq.reduce((s2, q) => s2 + q.f, 0); let c = 0; for (const q of seq) { c += q.f / ftot; const g = geo(t + c * Test); q.p = g.lo + q.u * (g.hi - g.lo); } }
    const keep = seq.map(() => true);
    const legsOf = () => { const L = []; let prev = pos, f = 0; for (let i = 0; i < seq.length; i++) { f += seq[i].f; if (!keep[i]) continue; L.push({ i, f, dp: Math.abs(seq[i].p - prev), vib: seq[i].vib }); prev = seq[i].p; f = 0; } return L; };
    const tot = () => seq.reduce((s, q) => s + q.f, 0);
    const v = vAt(t);
    const needOf = (l) => (l.vib ? ctx.minBuzz : ctx.minLeg) * 1.08;
    let Tp = 1000, L = legsOf();
    for (let it = 0; it < 12; it++) {
      L = legsOf(); const ft = tot();
      let s = 0, c = 0; for (const l of L) if (l.dp >= 0.5) { s += l.dp / (l.f / ft); c++; }
      Tp = ctx.floorTempo ? Math.max(...L.map((l) => needOf(l) / (l.f / ft))) : c ? (1000 * s) / c / v : 2000;
      let worst = null;
      // a leg that cannot reach its minimum and is small (a catch) is merged into the next one
      for (const l of L) { if ((l.f / ft) * Tp < needOf(l) * 0.7 && l.i < seq.length - 1 && (!worst || l.f < worst.f)) worst = l; }
      if (!worst || ctx.floorTempo) break;
      keep[worst.i] = false;
    }
    if (!ctx.floorTempo) Tp *= 1 + J(ctx, rng, -0.04, 0.04);
    const ft = tot();
    // floor tempo (the widened-range fallback): the tightest leg sits at its minimum and the others keep the
    // phrase's unevenness, squeezed (square root, at most 4x the minimum) so the fallback still runs near its fastest
    const rmin = Math.min(...L.map((l) => l.f / ft / needOf(l)));
    const dur = ctx.floorTempo ? L.map((l) => needOf(l) * Math.min(4, Math.sqrt(l.f / ft / needOf(l) / rmin)) * J(ctx, rng, 1, 1.08, 1)) : timeLegs(L.map((l) => (l.f / ft) * Tp), L.map(needOf), st);
    let tt = t;
    for (let li = 0; li < L.length; li++) {
      const l = L[li];
      const t1 = tt + dur[li], q = seq[l.i];
      if (q.buzz) intervals.push([tt, t1]);
      pts.push({ t: t1, p: q.p, tp: q.tp, cyc: l.i === seq.length - 1, vib: l.vib });
      tt = t1;
    }
    lastT = tt - t; pos = seq[seq.length - 1].p; t = tt; kc++;
  }
  return { pts, intervals, S, entry };
}

function droneEngine(ctx, k, st) {
  const m = ctx.m, E = ctx.until, pts = [];
  const r0 = rngFor(ctx.seed, 0, 'dw'), ph1 = r0() * 6.283, ph2 = r0() * 6.283;
  const P = ctx.phraseMs, wanderA = Math.min(3, 0.3 * (m.d.carrierDepth || 6)) * ctx.vari;
  const maxSw = (t) => (ctx.freeBand ? 50 : Math.max(2, Math.min(50, ctx.hi(t) - ctx.lo(t))));
  // freeBand (no range asked, speed out of reach): the band grows around the carrier to fit the swing
  const bandAt = (t, c, s) => (ctx.freeBand ? [Math.max(0, Math.min(ctx.lo(t), c - s / 2)), Math.min(100, Math.max(ctx.hi(t), c + s / 2))] : [ctx.lo(t), ctx.hi(t)]);
  const carrier = (t, sw) => {
    if (ctx.freeBand) sw = Math.min(sw, ctx.hi(t) - ctx.lo(t));
    const Lo = ctx.lo(t) + sw / 2, Hi = ctx.hi(t) - sw / 2, mid = (Lo + Hi) / 2, room = Math.max(0, Hi - Lo);
    let c = mid;
    if (m.cr) { const x = ((((t - ctx.from) % P) + P) % P) / P; const saw = x < 0.85 ? x / 0.85 : 1 - (x - 0.85) / 0.15; c += Math.sign(m.cr) * Math.min(Math.abs(m.cr), room) * (saw - 0.5); }
    const w = Math.min(wanderA, room / 2); c += w * 0.6 * Math.sin(ph1 + t / 1700) + w * 0.4 * Math.sin(ph2 + t / 610);
    return room > 0 ? clamp(c, Lo, Hi) : (ctx.lo(t) + ctx.hi(t)) / 2;
  };
  const b0 = buzzAt(ctx, k, ctx.from, maxSw(ctx.from));
  let { t, pos } = entryLeg(ctx, pts, carrier(ctx.from, b0.swing), Math.min(150, 1.5 * ctx.profile(ctx.from)));
  const S = t, entry = pos;
  let sign = 1, i = 0;
  while (t < E && i < 2000000) {
    const rem = E - t, bz = buzzAt(ctx, k, t, maxSw(t)); if (bz.capped) st.capped = true;
    const rng = rngFor(ctx.seed, i, 'z');
    const L = bz.leg;
    let dt;
    if (rem >= 3 * L) dt = Math.max(ctx.minBuzz, L * J(ctx, rng, 0.9, 1.1, 1));
    else if (rem >= 2 * L) dt = L;
    else if (rem >= 2 * ctx.minBuzz && rem >= 1.5 * L) dt = rem / 2;
    else dt = rem;
    const tn = t + dt, c = carrier(tn, bz.swing), s = Math.min(bz.swing * J(ctx, rng, 0.85, 1.15, 1), maxSw(tn));
    const [lo, hi] = bandAt(tn, c, s);
    let up = c + s / 2, dn = c - s / 2; if (up > hi) { dn -= up - hi; up = hi; } if (dn < lo) { up += lo - dn; dn = lo; }
    const p = clamp(sign > 0 ? up : dn, 0, 100);
    pts.push({ t: tn, p, tp: true, vib: true }); sign = -sign; t = tn; i++;
  }
  return { pts, intervals: [], S, entry, done: true };
}

function holdEngine(ctx, k, st) {
  const m = ctx.m, ht = m.holdType, E = ctx.until, pts = [];
  const vAt = (t) => Math.max(5, k * ctx.profile(t));
  const g0 = { lo: ctx.lo(ctx.from), hi: ctx.hi(ctx.from) }, mid0 = (g0.lo + g0.hi) / 2;
  const tH = ctx.from + m.H0; // the first pause must suit the band at both of its ends
  // a pause halfway starts toward the side the device is heading (startDir), else the side nearer startPos
  const midFirst = ctx.startDir ? (ctx.startDir > 0 ? g0.hi : g0.lo) : ctx.startPos !== undefined && ctx.startPos > mid0 ? g0.hi : g0.lo;
  const first = ht === 'top' ? Math.min(g0.hi, ctx.hi(tH)) : ht === 'bottom' ? Math.max(g0.lo, ctx.lo(tH)) : midFirst;
  let { t, pos } = entryLeg(ctx, pts, first, easeSpeed(ctx, k, 1));
  const S = t, entry = pos;
  const at = (fn, tt) => fn(ctx.lo(tt), ctx.hi(tt));
  const move = (fn, v) => { let p = at(fn, t); let dur = Math.max(ctx.minLeg * 1.05, (Math.abs(p - pos) / v) * 1000); p = at(fn, t + dur); dur = Math.max(ctx.minLeg * 1.05, (Math.abs(p - pos) / v) * 1000); t += dur; pts.push({ t, p, tp: true }); pos = p; };
  const holdFor = (ms) => { t += ms; pts.push({ t, p: pos, tp: true, hold: true }); };
  // move to a pause position that suits the band at both ends of the coming pause (ms long)
  const toPause = (fn, ms, v) => move((l, h) => { const tt = t + ms; const lo = Math.max(l, ctx.lo(tt)), hi = Math.min(h, ctx.hi(tt)); return clamp((fn(l, h) + at(fn, tt)) / 2, lo, Math.max(lo, hi)); }, v);
  let kc = 0;
  while (t < E && kc < 100000) {
    const rng = rngFor(ctx.seed, kc++, 'h');
    const lo = ctx.lo(t), hi = ctx.hi(t), D = hi - lo, a = Math.min(4, 0.06 * D), v = vAt(t);
    const H = clamp(m.H0 * Math.exp(J(ctx, rng, -0.35, 0.35)), m.Hr[0], m.Hr[1]);
    const j1 = J(ctx, rng, 0, 0.12, 0), j2 = J(ctx, rng, 0, a * 0.4, 0), j3 = J(ctx, rng, -a, a), j4 = J(ctx, rng, 0, a, 0);
    if (ht === 'top') { holdFor(H); move((l, h) => l + j1 * (h - l), v); toPause((l, h) => h - j2, H, v); }
    else if (ht === 'bottom') { holdFor(H); move((l, h) => h - j1 * (h - l), v); toPause((l, h) => l + j2, H, v); }
    else {
      const goingUp = pos < (lo + hi) / 2;
      const mid = (l, h) => (l + h) / 2 + j3, far = goingUp ? (l, h) => h - j4 : (l, h) => l + j4, back = goingUp ? (l, h) => l + j2 : (l, h) => h - j2;
      if (rng() < 0.45) { toPause(mid, H, v); holdFor(H); move(far, v); move(back, v); }
      else { move(far, v); toPause(mid, H, v); holdFor(H); move(back, v); }
    }
  }
  // the pattern ends in a pause: the last pause that starts 300 ms or more before `until` runs to `until`
  let cut = -1;
  for (let i = pts.length - 1; i >= 1; i--) if (pts[i].hold && pts[i - 1].t >= S && pts[i - 1].t <= E - Math.min(300, (E - S) * 0.5)) { cut = i; break; }
  if (cut > 0) { const out = pts.slice(0, cut); out.push({ t: E, p: pts[cut - 1].p, tp: true }); return { pts: out, intervals: [], S, entry, done: true }; }
  return { pts, intervals: [], S, entry };
}

function dropEngine(ctx, k, st) {
  const m = ctx.m, from = ctx.from;
  // with aftershocks the strokes and the drop end earlier and the aftershocks fill the time up to `until`
  const tail = m.after ? Math.min(Math.max(1000, m.after.seconds * 1000), 0.45 * (ctx.until - from)) : 0;
  const E = ctx.until - tail;
  const Lo = ctx.lo(E), Hi = ctx.hi(E), D = Hi - Lo;
  const vEnd = Math.max(5, (ctx.knobIsDepth ? 1 : k) * ctx.profile(E));
  const still = m.after ? Math.min(200, 0.05 * (E - from)) : Math.min(1500, 0.25 * (E - from));
  const dropMs = Math.max(ctx.minLeg * 1.05, (D / (vEnd * m.dropRatio)) * 1000);
  const [b0, b1] = m.bodyBand;
  const bodyLo = (t) => ctx.lo(t) + b0 * (ctx.hi(t) - ctx.lo(t)), bodyHi = (t) => ctx.lo(t) + b1 * (ctx.hi(t) - ctx.lo(t));
  const riseMs = m.plunge ? Math.max(ctx.minLeg * 1.05, ((Hi - bodyHi(E)) / vEnd) * 1000) : 0;
  const tDrop = E - still - dropMs, Eb = tDrop - riseMs;
  let pts, entry;
  if (Eb - from >= 700) {
    const res = cycleEngine(ctx, k, st, { unit: BODY_UNIT, E: Eb, lo: bodyLo, hi: bodyHi, noTrend: true, kappa: 1, frantic: false, salt: 'b' });
    const fitted = fitEnd(res, Eb, ctx, (q) => q.top);
    pts = fitted.pts; entry = res.entry;
  } else {
    pts = []; const e = entryLeg(ctx, pts, bodyHi(from), vEnd); entry = e.pos;
  }
  let last = pts[pts.length - 1];
  const push = (t, p) => { if (t > last.t + 0.5) { last = { t, p, tp: true }; pts.push(last); } };
  if (m.plunge) push(Math.max(last.t + ctx.minLeg * 1.05, tDrop), Hi);
  else if (Math.abs(last.p - Hi) > 6) push(Math.max(last.t + ctx.minLeg * 1.05, tDrop), Hi);
  push(Math.max(last.t + ctx.minLeg * 1.05, E - still), Lo);
  push(E, Lo);
  if (m.after && tail > 0) {
    // aftershocks at the base: up and back down, the size going from the first to the middle to the last size
    // (scaled to the band), each leg about the pattern's leg length, seeded jitter; the speed knob makes them bigger
    const af = m.after, U0 = ctx.until, scale = D / Math.max(1, m.env0[1] - m.env0[0]);
    const vib = af.legMs < MIN_LEG, legMin = vib ? ctx.minBuzz : ctx.minLeg;
    const leg = Math.max(legMin, af.legMs);
    const ampAt = (x) => (x < 0.5 ? lerp(af.firstAmp, af.midAmp ?? af.firstAmp, x * 2) : lerp(af.midAmp ?? af.lastAmp, af.lastAmp, (x - 0.5) * 2));
    const kv = Math.pow(ctx.knobIsDepth ? 1 : k, 0.5) * (ctx.profile(U0) / Math.max(1, m.speed0)) ** 0.5;
    let t = Math.max(last.t, E), q = 0;
    while (t < U0 - 0.5 && q < 100000) {
      const rng = rngFor(ctx.seed, q, 'a');
      const dt = Math.min(U0 - t, leg * J(ctx, rng, 0.9, 1.15, 1));
      if (dt < legMin && U0 - t >= legMin) break;
      const x = clamp((t - E) / Math.max(1, U0 - E), 0, 1);
      const up = q % 2 === 0;
      const p = up ? clamp(Lo + ampAt(x) * scale * kv * J(ctx, rng, 0.85, 1.15, 1), Lo, Hi) : Lo;
      t += dt; pts.push({ t, p, tp: true, vib }); last = pts[pts.length - 1]; q++;
      if (U0 - t < legMin) break;
    }
    if (last.t < U0 - 0.5) pts.push({ t: U0, p: Lo, tp: true });
  }
  const res = { pts, intervals: [], S: from, entry, done: true };
  if (last.t > ctx.until + 0.5) return Object.assign(res, { pts: cutAt(pts, ctx.until) });
  return res;
}

function envelopeEngine(ctx, k, st) {
  const m = ctx.m;
  const ov = { unit: BODY_UNIT, noTrend: true, kappa: 1, frantic: false, salt: 'e' };
  if (m.buzzFinish) {
    const share = m.buzzShare;
    ov.overlayFn = (kc, t, rng) => (rng() < clamp(share * (0.4 + 1.2 * ctx.xOf(t)), 0.05, 0.95) ? [[0, 1]] : []);
    ov.buzzKappa = 0.45;
  }
  return cycleEngine(ctx, k, st, ov);
}

const ENGINES = { cycle: cycleEngine, template: templateEngine, drone: droneEngine, hold: holdEngine, drop: dropEngine, envelope: envelopeEngine };

// ---------- ending exactly on `until` ----------
function cutAt(pts, E) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    if (q.t < E) { out.push(q); continue; }
    if (q.t === E || i === 0) { out.push({ ...q, t: E }); return out; }
    const a = pts[i - 1], f = (E - a.t) / (q.t - a.t);
    out.push({ t: E, p: a.p + (q.p - a.p) * f, tp: true, vib: q.vib });
    return out;
  }
  const l = out[out.length - 1]; if (l.t < E) out.push({ t: E, p: l.p, tp: true });
  return out;
}
/**
 * Make the pattern end exactly at E: inside a pause it simply stops there; otherwise the cycles are stretched or
 * squeezed (at most 8%, else 15% to a turning point) so that a cycle or a turn lands on E; failing that it stops at
 * the last turn before E and holds; a render shorter than one stroke ends partway along its first move.
 */
function fitEnd(res, E, ctx, pred) {
  const { pts, S } = res; let intervals = res.intervals || [];
  const trimIv = (lim) => intervals.filter(([a]) => a < lim).map(([a, b]) => [a, Math.min(b, lim)]);
  if (S >= E || pts.length < 2) return { pts: cutAt(pts, E), intervals: trimIv(E) };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.t < E && b.t >= E) {
      if (Math.abs(a.p - b.p) < 0.5 && a.t >= S && E - a.t >= Math.min(300, 0.3 * (b.t - a.t))) return { pts: [...pts.slice(0, i), { ...b, t: E, p: a.p }], intervals: trimIv(E) };
      break;
    }
  }
  const choose = (ok, lim) => {
    let best = null;
    for (let i = 0; i < pts.length; i++) { const q = pts[i]; if (q.t <= S || !ok(q)) continue; const f = (E - S) / (q.t - S), sc = Math.abs(Math.log(f)); if (sc <= lim && (!best || sc < best.sc)) best = { i, f, sc }; }
    return best;
  };
  const okP = (q) => !pred || pred(q);
  // a render with only a few turns may stretch or squeeze further (up to 30%) to land a turn on E: the speed
  // calibration measures the result, so the asked speed still holds
  let turns = 0; for (const q of pts) if (q.tp && q.t > S && q.t < E) turns++;
  const pick = choose((q) => q.cyc && okP(q), 0.08) || choose((q) => (q.cyc || q.tp) && okP(q), 0.15) || (turns < 6 && !pred ? choose((q) => q.tp && okP(q), 0.3) : null);
  if (pick) {
    const f = pick.f, sc = (t) => (t <= S ? t : S + (t - S) * f);
    const out = pts.slice(0, pick.i + 1).map((q) => ({ ...q, t: sc(q.t) }));
    out[out.length - 1].t = E;
    intervals = intervals.map(([a, b]) => [sc(a), sc(b)]);
    return { pts: out, intervals: trimIv(E) };
  }
  // stop at the last turn and wait only when the wait is short (250 ms, or 15% of the next move); a longer wait
  // is a stall, so the pattern ends partway along its next move instead. The start point is never "the last turn".
  for (let j = pts.length - 1; j >= 0; j--) {
    const q = pts[j];
    if ((pred ? q.t >= S : q.t > S) && q.t <= E - ctx.minLeg && q.tp && okP(q)) {
      const nx = pts[j + 1], wait = E - q.t, leg = nx ? nx.t - q.t : Infinity;
      if (pred || wait <= Math.max(250, 0.15 * leg)) { const out = pts.slice(0, j + 1); out.push({ t: E, p: q.p, tp: true }); return { pts: out, intervals: trimIv(q.t) }; }
      break;
    }
  }
  return { pts: cutAt(pts, E), intervals: trimIv(E) };
}

/** The band at t after the depth knob (the same widening the engines apply). */
function effBand(ctx, k, t) {
  const Lo = ctx.lo(t), Hi = ctx.hi(t), dk = depthKnob(ctx, k, t);
  if (dk === 1) return [Lo, Hi];
  const W = clamp((Hi - Lo) * dk, 2, 100), C = clamp((Lo + Hi) / 2, W / 2, 100 - W / 2);
  return [C - W / 2, C + W / 2];
}

// ---------- buzz overlay: a zigzag riding the carrier ----------
function expandOverlay(pts, intervals, ctx, k, st) {
  const S = pts[0].t, E = pts[pts.length - 1].t;
  const iv = intervals.map(([a, b]) => [Math.max(a, S), Math.min(b, E)]).filter(([a, b]) => b - a > 1).sort((x, y) => x[0] - y[0]);
  if (!iv.length) return pts;
  const merged = []; for (const x of iv) { const l = merged[merged.length - 1]; if (l && x[0] <= l[1] + 5) l[1] = Math.max(l[1], x[1]); else merged.push([x[0], x[1]]); }
  const times = pts.map((q) => q.t);
  const cAt = (t) => {
    let lo = 0, hi = pts.length - 1;
    if (t <= times[0]) return pts[0].p; if (t >= times[hi]) return pts[hi].p;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi]; return b.t === a.t ? b.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
  };
  const out = []; let pi = 0, zi = 0;
  for (const [a0, b0] of merged) {
    while (pi < pts.length && pts[pi].t <= a0) out.push(pts[pi++]);
    if (pi >= pts.length) break;
    const prev = out[out.length - 1];
    let a = a0, b = b0;
    if (a - prev.t < ctx.minLeg) a = prev.t;
    let nj = pi; while (nj < pts.length && pts[nj].t < b) nj++;
    const next = pts[nj];
    if (next && next.t - b < ctx.minLeg) b = next.t;
    b = Math.min(b, E);
    const mid = (a + b) / 2, bz = buzzAt(ctx, k, mid, 50);
    if (bz.capped) st.capped = true;
    const nLegs = Math.round((b - a) / bz.leg);
    if (nLegs < 3) continue;
    if (a > prev.t) out.push({ t: a, p: cAt(a), tp: false, vib: pts[pi].vib });
    const sp = (b - a) / nLegs, rng = rngFor(ctx.seed, zi++, 'o');
    const jitMax = Math.max(0, Math.min(0.12 * sp, (sp - ctx.minBuzz) * 0.45));
    let sign = rng() < 0.5 ? 1 : -1;
    const s0 = bz.swing * J(ctx, rng, 0.85, 1.15, 1);
    for (let q = 1; q < nLegs; q++) {
      const tq = a + q * sp + J(ctx, rng, -jitMax, jitMax), c = cAt(tq);
      let [lo, hi] = effBand(ctx, k, tq);
      // freeBand (no range asked, speed out of reach): the band grows around the carrier to fit the swing
      if (ctx.freeBand) { lo = Math.max(0, Math.min(lo, c - s0 / 2)); hi = Math.min(100, Math.max(hi, c + s0 / 2)); }
      const s = Math.min(s0, ctx.freeBand ? 50 : 0.8 * (hi - lo));
      if (s < s0 * 0.9) st.capped = true; // the band is too narrow for the swing this speed needs
      let up = c + s / 2, dn = c - s / 2; if (up > hi) { dn -= up - hi; up = hi; } if (dn < lo) { up += lo - dn; dn = lo; }
      out.push({ t: tq, p: clamp(sign > 0 ? up : dn, 0, 100), vib: true }); sign = -sign;
    }
    while (pi < pts.length && pts[pi].t < b) pi++;
    if (pi < pts.length && pts[pi].t === b) out.push({ ...pts[pi++], vib: true });
    else out.push({ t: b, p: cAt(b), vib: true });
  }
  while (pi < pts.length) out.push(pts[pi++]);
  return out;
}

// ---------- integer actions, minimum legs ----------
function enforceMinLegs(acts, ctx) {
  const need = (i) => (acts[i].vib ? ctx.minBuzz : ctx.minLeg);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 1; i < acts.length; i++) {
      const dt = acts[i].at - acts[i - 1].at, nd = need(i);
      if (dt >= nd) continue;
      const short = nd - dt;
      // the ease-in point (fixed) never moves, so the first move keeps its speed
      if (i < acts.length - 1 && !acts[i].fixed && acts[i + 1].at - acts[i].at - need(i + 1) >= short) { acts[i].at += short; changed = true; continue; }
      if (i - 1 > 0 && !acts[i - 1].fixed && acts[i - 1].at - acts[i - 2].at - need(i - 1) >= short) { acts[i - 1].at -= short; changed = true; continue; }
      if (acts.length <= 2) break;
      if (i < acts.length - 1 && !acts[i].fixed) { acts[i + 1].vib = acts[i + 1].vib && acts[i].vib; acts.splice(i, 1); }
      else if (i - 1 > 0 && !acts[i - 1].fixed) { acts[i].vib = acts[i].vib && acts[i - 1].vib; acts.splice(i - 1, 1); }
      else if (i < acts.length - 1) { acts[i + 1].vib = acts[i + 1].vib && acts[i].vib; acts.splice(i, 1); }
      else if (i - 1 > 0) { acts[i].vib = acts[i].vib && acts[i - 1].vib; acts.splice(i - 1, 1); } // last resort: a render shorter than its ease-in
      else break;
      changed = true; i = Math.max(0, i - 2);
    }
    if (!changed) break;
  }
}
function finish(ctx, res, k, st) {
  let pts = res.pts, intervals = res.intervals || [];
  if (!res.done) ({ pts, intervals } = fitEnd(res, ctx.until, ctx));
  else if (pts[pts.length - 1].t > ctx.until + 0.5) pts = cutAt(pts, ctx.until);
  if (intervals.length) pts = expandOverlay(pts, intervals, ctx, k, st);
  const acts = [];
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i], at = Math.round(q.t), pos = clamp(Math.round(q.p), 0, 100), prev = acts[acts.length - 1];
    if (prev && at <= prev.at) { if (i === pts.length - 1 && acts.length > 1) { acts.pop(); } else continue; }
    acts.push({ at, pos, vib: !!q.vib, fixed: !!q.fixed });
  }
  acts[0].at = ctx.from; acts[0].vib = false;
  const last = acts[acts.length - 1];
  if (last.at < ctx.until) acts.push({ at: ctx.until, pos: last.pos, vib: false });
  else last.at = ctx.until;
  enforceMinLegs(acts, ctx);
  capSpeed(acts, ctx, st);
  return acts;
}
/**
 * No leg faster than ctx.maxSpeed: a leg that is too fast first borrows time from the next one (when that one has
 * room to spare), otherwise its end point is pulled back toward its start (a zigzag gets a smaller swing). Positions
 * stay integers; the first and last times never move.
 */
function capSpeed(acts, ctx, st) {
  const cap = ctx.maxSpeed; if (!(cap > 0)) return;
  const need = (i) => (acts[i].vib ? ctx.minBuzz : ctx.minLeg);
  for (let i = 1; i < acts.length; i++) {
    const a = acts[i - 1], b = acts[i], dt = b.at - a.at, dp = Math.abs(b.pos - a.pos);
    if (dt <= 0 || (dp / dt) * 1000 <= cap + 0.5) continue;
    st.speedCapped = (st.speedCapped || 0) + 1;
    const want = Math.ceil((dp / cap) * 1000), nx = acts[i + 1];
    if (nx && i < acts.length - 1) {
      const extra = want - dt, ndt = nx.at - b.at - extra, ndp = Math.abs(nx.pos - b.pos);
      if (ndt >= need(i + 1) && (ndp / ndt) * 1000 <= cap) { b.at += extra; continue; }
    }
    b.pos = a.pos + Math.sign(b.pos - a.pos) * Math.max(0, Math.floor((cap * dt) / 1000));
  }
}
function expectedMean(acts, ctx) {
  let s = 0, n = 0;
  for (let i = 1; i < acts.length; i++) { const a = acts[i - 1], b = acts[i]; if (b.at > a.at && b.pos !== a.pos) { s += ctx.profile((a.at + b.at) / 2); n++; } }
  return n ? s / n : ctx.profile(ctx.from);
}

function renderCore(m, o, mir) {
  const ctx = resolve(m, o, mir);
  const evalAt = (k) => {
    const st = { capped: false, depthMax: false };
    ctx.entryCut = null; ctx.startBand = null;
    const res = ENGINES[m.engine](ctx, k, st);
    const startBand = ctx.startBand || [ctx.lo(ctx.from), ctx.hi(ctx.from)];
    const acts = finish(ctx, res, k, st);
    if (st.capped) ctx.saw.capped = true;
    if (st.depthMax) ctx.saw.depthMax = true;
    const s = stats(acts);
    // the asked speed is the pattern's: measure it after the move in (on a short segment a fast move in would
    // otherwise make the calibration slow the pattern itself down to make up for it)
    const ie = acts.findIndex((a) => a.fixed);
    const pat = ie > 0 && acts.length - ie >= 3 ? acts.slice(ie) : acts, sCal = pat === acts ? s : stats(pat);
    let ratio = null, want = null;
    if (ctx.objective) { want = ctx.objective.type === 'abs' ? ctx.objective.value : expectedMean(pat, ctx); ratio = want > 0 ? (sCal.legs ? sCal.mean / want : 0) : 1; }
    return { acts, s, sCal, ratio, want, st, k, entry: res.entry, entryCut: ctx.entryCut, startBand };
  };
  // bisection on the knob (speed, or depth when the tempo is fixed): the measured FunSync mean over the target
  const calibrate = () => {
    ctx.saw = { capped: false, depthMax: false };
    let b = evalAt(1);
    if (!ctx.objective || Math.abs(b.ratio - 1) <= 0.004) return b;
    let lo = Math.log(ctx.knobIsDepth ? 0.1 : 0.2), hi = Math.log(ctx.knobIsDepth ? 4 : 5);
    if (b.ratio < 1) lo = 0; else hi = 0;
    for (let i = 0; i < 40 && hi - lo > 1e-4; i++) {
      const mid = (lo + hi) / 2, r = evalAt(Math.exp(mid));
      if (Math.abs(r.ratio - 1) < Math.abs(b.ratio - 1)) b = r;
      if (Math.abs(r.ratio - 1) <= 0.004) break;
      if (r.ratio < 1) lo = mid; else hi = mid;
    }
    // short renders are lumpy (a whole stroke more or less changes the mean): scan around the best knob
    if (Math.abs(b.ratio - 1) > 0.01) {
      const k0 = b.k;
      for (let i = 0; i <= 30; i++) { const r = evalAt(k0 * Math.exp(-0.3 + (0.6 * i) / 30)); if (Math.abs(r.ratio - 1) < Math.abs(b.ratio - 1)) b = r; }
    }
    return b;
  };
  // how far the local speed strays from the asked profile, over 6 windows (0 = perfect)
  const trackErr = (b) => {
    const a = b.acts, n = 6, w = (ctx.until - ctx.from) / n; let err = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const t0 = ctx.from + i * w, t1 = t0 + w; let s1 = 0, s2 = 0, c = 0;
      for (let j = 1; j < a.length; j++) { const p = a[j - 1], q = a[j]; if (p.at < t0 || q.at > t1 || q.at <= p.at || q.pos === p.pos) continue; s1 += (Math.abs(q.pos - p.pos) / (q.at - p.at)) * 1000; s2 += ctx.profile((p.at + q.at) / 2); c++; }
      if (c >= 3) { err += Math.abs(s1 / s2 - 1); cnt++; }
    }
    return (cnt ? err / cnt : 0) + Math.abs((b.ratio ?? 1) - 1);
  };
  let best = calibrate();
  // Out of reach at the default range with legs at their minimum (tiny frantic strokes, a narrow buzz band):
  // widen the range instead. Strokes go to the fastest tempo the minimum legs allow and the depth follows the speed;
  // a buzz overlay keeps its tempo and gets room for a bigger swing; a drone's band grows around it.
  // Only when no range was asked for, and only if it tracks the asked speed better.
  if (ctx.objective && best.s.legs >= 12 && best.st.capped && (Math.abs(best.ratio - 1) > 0.05 || trackErr(best) > 0.08) && !ctx.rangeAsked && !ctx.knobIsDepth && ['cycle', 'template', 'drone'].includes(m.engine)) {
    const before = trackErr(best), save = best, saveSaw = ctx.saw;
    let n = 0, s1 = 0; for (let i = 0; i < 64; i++) { s1 += ctx.profile(ctx.from + ((i + 0.5) / 64) * (ctx.until - ctx.from)); n++; }
    ctx.profileRef = s1 / n;
    if (m.engine === 'drone') ctx.freeBand = true;
    else if (m.overlay) ctx.freeBand = true;
    else { ctx.knobIsDepth = true; ctx.speedKFixed = 1; ctx.floorTempo = true; }
    const wide = calibrate();
    if (trackErr(wide) < before - 0.02) {
      best = wide;
      const [l0, h0] = m.env0, after = best.acts.slice(1).map((q) => q.pos), lo1 = Math.min(...after), hi1 = Math.max(...after);
      const moved = !(hi1 - lo1 > h0 - l0 + 1);
      const [sl0, sh0] = ctx.showBand(Math.round(l0), Math.round(h0)), [slo1, shi1] = ctx.showBand(lo1, hi1);
      ctx.warn('range-widened', { from: [sl0, sh0], to: [slo1, shi1], moved, speed: Math.round(best.want), minLeg: ctx.minLeg, minBuzz: ctx.minBuzz });
    }
    else { best = save; ctx.knobIsDepth = false; ctx.floorTempo = false; ctx.freeBand = false; ctx.speedKFixed = undefined; ctx.saw = saveSaw; }
  }
  if (ctx.objective && best.s.legs && Math.abs(best.ratio - 1) > 0.08) {
    const reason = best.sCal.legs < 24 ? 'lumpy'
      : ctx.knobIsDepth && ctx.saw.depthMax && best.ratio < 1 ? 'depth-max'
      : best.st.speedCapped && best.ratio < 1 ? 'speed-cap'
      : ctx.saw.capped && best.ratio < 1 ? 'min-legs'
      : best.ratio > 1 ? 'too-slow' : 'narrow-range';
    ctx.warn('speed-unreachable', { mean: Math.round(best.sCal.mean), asked: Math.round(best.want), reason, moves: best.sCal.legs, afterEntry: best.sCal !== best.s, maxSpeed: Math.round(ctx.maxSpeed) });
  }
  let acts = best.acts;
  // short segments: say so when the move in was shortened, and when not even one turn of the pattern fits
  const span = ctx.until - ctx.from;
  const ec = best.entryCut;
  if (ec && ec.now < 0.8 * ec.was) ctx.warn('too-short', { part: 'entry', spanMs: span, startPos: Math.round(ctx.showPos(ctx.startPos)), entryMs: Math.round(ec.now), entrySpeed: Math.round((ec.dist / ec.now) * 1000) });
  if (m.engine !== 'hold') {
    let moving = 0, turns = 0, dir = 0;
    for (let i = 1; i < acts.length; i++) { const d = Math.sign(acts[i].pos - acts[i - 1].pos); if (!d) continue; moving++; if (dir && d !== dir) turns++; dir = d; }
    const strokeMs = Math.round((m.d.strokePeriodMs || m.d.cyclePeriodMs || 1000) * clamp((m.speed0 || 100) / Math.max(1, best.want || m.speed0 || 100), 0.25, 4));
    if (!moving) {
      // never hand back a flat line for a moving pattern: one move across the band, as much as fits
      const p0 = acts[0].pos, lo = ctx.lo(ctx.until), hi = ctx.hi(ctx.until), far = p0 > (lo + hi) / 2 ? lo : hi;
      const reach = Math.min(Math.abs(far - p0), (ctx.maxSpeed * span) / 1000);
      acts = [{ at: ctx.from, pos: p0, vib: false }, { at: ctx.until, pos: clamp(Math.round(p0 + Math.sign(far - p0) * reach), 0, 100), vib: false }];
      best.s = stats(acts);
      ctx.warn('too-short', { part: 'single-move', spanMs: span, strokeMs });
    } else if (!turns && span < 4 * strokeMs) ctx.warn('too-short', { part: 'partial-stroke', spanMs: span, strokeMs });
  }
  // a pattern whose buzz legs are under 50 ms is drawn at 50 ms; with allowFast it goes shorter, and says so
  if (ctx.allowFast && m.d.minedBuzzLegMs < MIN_BUZZ) {
    let short = 0, min = Infinity;
    for (let i = 1; i < acts.length; i++) { const dt = acts[i].at - acts[i - 1].at; if (dt < (acts[i].vib ? MIN_BUZZ : MIN_LEG)) { short++; min = Math.min(min, dt); } }
    if (short) ctx.warn('fast-legs', { legs: short, minMs: min, patternMs: m.d.minedBuzzLegMs });
  }
  if (best.st.speedCapped) ctx.warn('speed-capped', { legs: best.st.speedCapped, maxSpeed: Math.round(ctx.maxSpeed), maxSpeedAsked: !!ctx.maxSpeedAsked });
  return {
    actions: acts.map((a) => ({ at: a.at, pos: a.pos })),
    vib: acts.map((a) => a.vib),
    stats: best.s,
    warnings: ctx.warnings.map((w) => ({ code: w.code, values: w.values })),
    params: { from: ctx.from, until: ctx.until, band: [ctx.band.a[0], ctx.band.a[1]], startBand: best.startBand.slice(), seed: ctx.seed, minLeg: ctx.minLeg, minBuzz: ctx.minBuzz, maxSpeed: ctx.maxSpeed, target: best.want },
  };
}

// ---------- public API ----------
const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** A { min, max } (or [lo, hi]) range as [lo, hi], or null when not given. */
function rangeOf(r) {
  if (r === undefined || r === null) return null;
  const lo = Array.isArray(r) ? r[0] : r.min, hi = Array.isArray(r) ? r[1] : r.max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [lo, hi];
}

/**
 * Render pattern `id`. Options (all optional):
 *   durationMs   length (default: the pattern's own typical length); from: start time in ms (default 0)
 *   startPos     where the device is at `from` (0-100); the pattern eases in from it, no jump
 *   startDir     +1 heading up / -1 heading down at `from`: the pattern carries on that way (or turns at the band's edge)
 *   speed        target FunSync mean in u/s (default: the pattern's own); ramp: { to } = a linear build or fade to that
 *   reversed     mirror top for bottom (pos -> 100 - pos); startPos, startDir and range stay in your coordinates
 *   range        { min, max }: where the pattern lives (default: its own place)
 *   variation    0-2, how much the seeded jitter varies the strokes (1 = the pattern's own; 0 = every cycle alike)
 *   seed         any number or string (default 1): same inputs + same seed = same output
 *   maxSpeed     u/s, no leg faster (default 600, or 1.5x the asked speed); allowFast: legs down to 17 ms
 * Returns { actions, vib, stats: { mean, max, lo, hi, legs }, warnings: [{ code, values }], params }, or null for an
 * unknown id. Throws a RangeError for a duration, speed or maxSpeed that is not above 0. The warnings:
 *   range-clipped      { from: [lo, hi], to: [lo, hi] }      the asked range went past 0-100
 *   speed-capped       { speed, maxSpeed }                   the asked speed is above maxSpeed: the cap wins
 *                      { legs, maxSpeed, maxSpeedAsked }     that many legs were held to the cap
 *   range-widened      { from, to, moved, speed, minLeg, minBuzz }  no range asked and the speed did not fit the
 *                                                           pattern's own place with legs at their minimum
 *   speed-unreachable  { mean, asked, reason, moves, afterEntry, maxSpeed }  reason: lumpy (too few moves), depth-max,
 *                                                           speed-cap, min-legs, too-slow, narrow-range
 *   too-short          { part: 'entry', spanMs, startPos, entryMs, entrySpeed }  the move in was shortened
 *                      { part: 'single-move' | 'partial-stroke', spanMs, strokeMs }  not one turn of the pattern fits
 *   fast-legs          { legs, minMs, patternMs }            allowFast drew legs under the usual minimum
 * Positions in warnings are in the caller's coordinates (also when reversed).
 */
export function renderPattern(id, opts = {}) {
  if (isShapeId(id)) return renderShapePattern(id, opts);
  const m = model(id);
  if (!m) return null;
  const o = opts || {};
  const from = Math.round(finiteOr(o.from, 0));
  const dur = o.durationMs !== undefined && o.durationMs !== null ? Number(o.durationMs) : (m.d.durationSec || m.d.phraseSec || 10) * 1000;
  if (!(dur > 0) || !Number.isFinite(dur)) throw new RangeError(`durationMs must be a number above 0 (got ${o.durationMs})`);
  const until = from + Math.round(dur);
  if (!(until > from)) throw new RangeError(`durationMs ${o.durationMs} rounds to nothing`);
  let speed = null;
  const sp = o.speed !== undefined && o.speed !== null ? Number(o.speed) : null;
  const to = o.ramp && o.ramp.to !== undefined && o.ramp.to !== null ? Number(o.ramp.to) : null;
  if (sp !== null || to !== null) {
    const a = sp !== null ? sp : m.speed0, b = to !== null ? to : a;
    if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError('speed must be above 0');
    speed = { a, b };
  }
  let maxSpeed;
  if (o.maxSpeed !== undefined && o.maxSpeed !== null) {
    maxSpeed = Number(o.maxSpeed);
    if (!(maxSpeed > 0) || !Number.isFinite(maxSpeed)) throw new RangeError(`maxSpeed must be a number above 0 (got ${o.maxSpeed})`);
  }
  const startPos = o.startPos !== undefined && o.startPos !== null && Number.isFinite(Number(o.startPos)) ? clamp(Number(o.startPos), 0, 100) : undefined;
  const startDir = Math.sign(finiteOr(o.startDir, 0));
  const seed = o.seed !== undefined && o.seed !== null && o.seed !== '' ? o.seed : 1;
  const variation = clamp(finiteOr(o.variation, 1), VARIATION_MIN, VARIATION_MAX);
  const range = rangeOf(o.range);
  const base = { from, until, speed, maxSpeed, seed, variation, allowFast: !!o.allowFast };
  if (!o.reversed) return renderCore(m, { ...base, startPos, startDir, range }, false);
  // reversed: render the mirror image of the caller's ask (start, heading and range mirrored), then mirror the result
  // back. Every leg keeps its time and its |change in position|, so the speeds, the minimum legs and the speed cap are
  // exactly those of the unreversed render of the mirrored ask, and the render still starts at the caller's startPos.
  const res = renderCore(m, {
    ...base,
    startPos: startPos === undefined ? undefined : 100 - startPos,
    startDir: -startDir,
    range: range ? [100 - range[1], 100 - range[0]] : null,
  }, true);
  const actions = res.actions.map((a) => ({ at: a.at, pos: 100 - a.pos }));
  return Object.assign(res, {
    actions,
    stats: stats(actions),
    params: Object.assign({}, res.params, { band: [100 - res.params.band[1], 100 - res.params.band[0]], startBand: [100 - res.params.startBand[1], 100 - res.params.startBand[0]] }),
  });
}

/** renderPattern's actions only ([{ at, pos }]), or null for an unknown id. */
export function render(id, opts = {}) {
  const res = renderPattern(id, opts);
  return res ? res.actions : null;
}

/**
 * renderPattern for a simple shape: the same refusals (a length, speed or cap that is not above 0), the shape's
 * own render (pattern-library-shapes.js) and the stats measured the way the engine measures its own renders.
 */
function renderShapePattern(id, opts) {
  const o = opts || {};
  if (o.durationMs !== undefined && o.durationMs !== null) {
    const dur = Number(o.durationMs);
    if (!(dur > 0) || !Number.isFinite(dur)) throw new RangeError(`durationMs must be a number above 0 (got ${o.durationMs})`);
    if (!(Math.round(dur) > 0)) throw new RangeError(`durationMs ${o.durationMs} rounds to nothing`);
  }
  const sp = o.speed !== undefined && o.speed !== null ? Number(o.speed) : null;
  const to = o.ramp && o.ramp.to !== undefined && o.ramp.to !== null ? Number(o.ramp.to) : null;
  for (const v of [sp, to]) if (v !== null && (!(v > 0) || !Number.isFinite(v))) throw new RangeError('speed must be above 0');
  if (o.maxSpeed !== undefined && o.maxSpeed !== null) {
    const ms = Number(o.maxSpeed);
    if (!(ms > 0) || !Number.isFinite(ms)) throw new RangeError(`maxSpeed must be a number above 0 (got ${o.maxSpeed})`);
  }
  const res = renderShape(id, o);
  return Object.assign(res, { stats: stats(res.actions) });
}

/** The family the simple shapes are listed under, after the catalogue's. */
const SHAPES_FAMILY_ENTRY = Object.freeze({ id: SHAPE_FAMILY, patterns: SHAPE_IDS });

/** The families in catalogue order, then the simple shapes: [{ id, patternIds, nameKey, descKey }]. */
export function listFamilies() {
  return [...PATTERN_DATA.families, SHAPES_FAMILY_ENTRY].map((f) => ({ id: f.id, patternIds: f.patterns.slice(), nameKey: `patterns.family.${f.id}.name`, descKey: `patterns.family.${f.id}.desc` }));
}

/** Endings (kind 'event') are one-shot shapes: everything else can loop. */
const isLoopable = (kind) => kind !== 'event';

/** The simple shapes as list entries (they are all loopable cycles). */
const SHAPE_ENTRIES = SHAPE_IDS.map((id) => ({ id, family: SHAPE_FAMILY, kind: 'cycle' }));

/**
 * The patterns in catalogue order, then the simple shapes, optionally of one family and/or only the loopable ones:
 * [{ id, family, kind, loopable }].
 */
export function listPatterns({ family, loopable } = {}) {
  return [...PATTERN_DATA.patterns, ...SHAPE_ENTRIES]
    .filter((p) => (family === undefined || family === null || p.family === family) && (loopable === undefined || loopable === null || isLoopable(p.kind) === !!loopable))
    .map((p) => ({ id: p.id, family: p.family, kind: p.kind, loopable: isLoopable(p.kind) }));
}

/** Is `id` a pattern of the library (the catalogue or a simple shape)? */
export function hasPattern(id) { return typeof id === 'string' && (PATTERNS.has(id) || isShapeId(id)); }

/**
 * What a picker or a slider needs to know about a pattern, or null for an unknown id: its own speed (u/s) and the
 * typical speed range, its own place (range [lo, hi], 0-100), one stroke's length (ms), and its string keys.
 */
export function describePattern(id) {
  if (isShapeId(id)) return describeShape(id);
  const m = model(id);
  if (!m) return null;
  return {
    id,
    family: m.family,
    kind: m.kind,
    loopable: isLoopable(m.kind),
    hasBuzz: !!m.hasBuzz,
    speed: m.speed0,
    speedRange: [m.speedRange[0], m.speedRange[1]],
    range: [m.env0[0], m.env0[1]],
    strokeMs: m.d.strokePeriodMs || m.d.cyclePeriodMs || 1000,
    nameKey: `patterns.${id}.name`,
    descKey: `patterns.${id}.desc`,
  };
}

// ---------- a seamless loop ----------
/** ms of lead-in rendered before the loop may start (the move in and the first cycles settle there). */
const LOOP_LEAD_MS = 3000;
/**
 * Units of the 0-100 range: the narrowest band a loop plays in (fix 2026-11-20, device session step 35). Why 5: on
 * Dave's Handy with a 35-65 stroke zone (about 33 mm of its ~110 mm travel, so a unit is ~0.33 mm), Mixed flutters at
 * the tip in 20-25 (5 units, ~1.7 mm) read back as a moving flutter, while Lowest = Highest (22-22, which the engine
 * draws in 2 units, ~0.7 mm) read a flat 46 mm. At a full 0-100 zone 5 units are ~5.5 mm. More would override a band
 * that was seen to move.
 */
export const MIN_LOOP_BAND = 5;

/**
 * [lo, hi] at least `width` units wide (lo <= hi, both 0-100): as given when it is wide enough, else `width` wide
 * about its middle in whole units, moved in from an end of 0-100 (22-22 is 20-25, 0-0 is 0-5, 100-100 is 95-100).
 */
export function widenBand(lo, hi, width = MIN_LOOP_BAND) {
  if (hi - lo >= width) return [lo, hi];
  const w = Math.min(100, width);
  const a = Math.round(clamp((lo + hi) / 2 - w / 2, 0, 100 - w));
  return [a, a + w];
}
/** Units: a loop moves when its positions span at least this (MIN_LOOP_BAND less one unit of whole-unit rounding). */
const MIN_LOOP_SPAN = MIN_LOOP_BAND - 1;
/** How far a loop's positions spread, in units. */
const spanOf = (actions) => {
  let lo = 100, hi = 0;
  for (const a of actions) { if (a.pos < lo) lo = a.pos; if (a.pos > hi) hi = a.pos; }
  return actions.length ? hi - lo : 0;
};

/**
 * A loop of pattern `id` that tiles seamlessly: it starts at 0 on a bottom turn and ends (at loopMs) on a bottom
 * turn at the same position, whole cycles in between, so repeating it (`elapsed % loopMs`, or a tiled upload) has
 * no jump and no V at the wrap. The length is near targetMs (between 0.8x and 2x it); for a pattern that climbs,
 * swells or fades it is also close to a whole number of phrases. The snapped last leg keeps the minimum leg and the
 * speed cap. Options: speed, reversed, range ({ min, max }), seed (default 1), variation, targetMs (default 10000),
 * maxSpeed (u/s, as renderPattern's).
 * Returns { actions, vib, loopMs, fallback, warnings } (fallback true = no clean cut was found, the plain render was
 * cut and its end snapped), or null for an unknown id or an ending (not loopable). An asked range narrower than
 * MIN_LOOP_BAND (5 units) is widened about its middle to it, within 0-100 (fix 2026-11-20: Lowest = Highest played a
 * 2-unit loop that read flat on the Handy); a loop that still does not move (its positions span less than 4 units,
 * or it is one move from end to end) is widened further about the same middle until it does, the pattern's own place
 * last. Either way it says so: warnings [{ code: 'range-widened', values: { from: [lo, hi] asked, to: [lo, hi] played
 * } }] (to: null = its own place). A loop always moves and always has its two ends (fix-up 2026-11-17).
 */
export function renderLoop(id, opts = {}) {
  // A simple shape loops as the Orgasm Switch's Generated pattern did (pattern-library-shapes.js).
  if (isShapeId(id)) return renderShapeLoop(id, opts);
  const m = model(id);
  if (!m || !isLoopable(m.kind)) return null;
  const o = opts || {};
  const playable = (loop) => !!loop && loop.actions.length >= 3 && loop.loopMs > 0;
  // In an asked band a loop must also move: a 10-action loop in 21-23 was "playable" and read a flat 46 mm.
  const moves = (loop) => playable(loop) && spanOf(loop.actions) >= MIN_LOOP_SPAN;
  const asked = rangeOf(o.range);
  if (!asked) {
    // Its own place: as it always was.
    const own = loopIn(id, m, o, undefined);
    return playable(own) ? { ...own, warnings: [] } : null;
  }
  const from = [clamp(Math.min(asked[0], asked[1]), 0, 100), clamp(Math.max(asked[0], asked[1]), 0, 100)];
  const band = widenBand(from[0], from[1]);
  const widened = (to, loop) => ({ ...loop, warnings: [{ code: 'range-widened', values: { from, to } }] });
  const first = loopIn(id, m, o, { min: band[0], max: band[1] });
  if (moves(first)) return band[0] === from[0] && band[1] === from[1] ? { ...first, warnings: [] } : widened(band, first);
  const mid = (from[0] + from[1]) / 2;
  for (const w of [10, 20, 30, 40, 60, 80, 100]) {
    if (w <= band[1] - band[0]) continue;
    const lo = Math.round(clamp(mid - w / 2, 0, 100 - w));
    const loop = loopIn(id, m, o, { min: lo, max: lo + w });
    if (moves(loop)) return widened([lo, lo + w], loop);
  }
  const own = loopIn(id, m, o, undefined);
  if (playable(own)) return widened(null, own);
  return null;
}

/** renderLoop's cut for one range (null when the render is too short to cut anything from). */
function loopIn(id, m, o, range) {
  const target = clamp(finiteOr(o.targetMs, 10000), 2000, 60000);
  const minL = 0.8 * target, maxL = 2 * target;
  const res = renderPattern(id, {
    durationMs: LOOP_LEAD_MS + maxL + 6000, speed: o.speed, reversed: !!o.reversed, range, seed: o.seed ?? 1, variation: o.variation,
    maxSpeed: o.maxSpeed,
  });
  const a = res.actions, vib = res.vib, cap = res.params.maxSpeed;
  const phrase = m.trend ? m.phraseMs : 0;
  const lastLegOk = (j, pos) => {
    const dt = a[j].at - a[j - 1].at;
    return dt >= (vib[j] ? MIN_BUZZ : MIN_LEG) && (Math.abs(pos - a[j - 1].pos) / dt) * 1000 <= cap + 0.5;
  };
  const cut = (i0, j, fallback) => {
    const t0 = a[i0].at;
    const actions = a.slice(i0, j + 1).map((q) => ({ at: q.at - t0, pos: q.pos }));
    actions[actions.length - 1].pos = actions[0].pos;
    const v = vib.slice(i0, j + 1); v[0] = false;
    return { actions, vib: v, loopMs: actions[actions.length - 1].at, fallback };
  };
  // the turns a loop may start and end on: bottom turns first (arrived going down, leaves going up or level), then
  // top turns for a shape that has none
  const kinds = [
    (i) => a[i].pos < a[i - 1].pos && a[i].pos <= a[i + 1].pos,
    (i) => a[i].pos > a[i - 1].pos && a[i].pos >= a[i + 1].pos,
  ];
  for (const isTurn of kinds) {
    const turns = [];
    for (let i = 1; i < a.length - 1; i++) if (isTurn(i)) turns.push(i);
    const i0 = turns.find((i) => a[i].at >= LOOP_LEAD_MS);
    if (i0 === undefined) continue;
    const cands = [];
    for (const j of turns) {
      const L = a[j].at - a[i0].at;
      if (L < minL || L > maxL) continue;
      const ph = phrase ? Math.min(L % phrase, phrase - (L % phrase)) / 1000 : 0;
      cands.push({ j, sc: Math.abs(a[j].pos - a[i0].pos) + (0.2 * Math.abs(L - target)) / 1000 + 4 * ph });
    }
    cands.sort((x, y) => x.sc - y.sc || x.j - y.j);
    for (const c of cands) if (lastLegOk(c.j, a[i0].pos)) return cut(i0, c.j, false);
  }
  // no clean cut: the stretch after the lead-in closest to the target length, its end snapped to its start
  const i0 = Math.max(0, a.findIndex((q) => q.at >= LOOP_LEAD_MS));
  let j = a.findIndex((q) => q.at - a[i0].at >= target);
  if (j <= i0) j = a.length - 1;
  if (j <= i0) return null;
  return cut(i0, j, true);
}
