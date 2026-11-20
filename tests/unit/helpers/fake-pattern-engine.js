// A tiny stand-in for pattern-library.js's renderPattern / describePattern, for the fill core's tests
// (pattern-fill*.test.js). Same contract: renderPattern(id, { durationMs, from, startPos, startDir, speed, ramp,
// reversed, range, variation, seed, maxSpeed }) -> { actions, vib, stats, warnings } | null, starting at startPos at
// `from` and ending exactly at from + durationMs, legs at least 100 ms (50 ms for buzz legs), never over the cap.
// Plain strokes only, so a test can say exactly what a render looks like.
//
//   tri        strokes between the band's bottom and top (10-90), 200 u/s; honours startDir like the engine
//              (heading up: carry on up to the top, or turn at once when already there)
//   naive-tri  the same, but ignores startDir: it heads for the turn nearest startPos (the catalogue's old rule)
//   buzz       a steady zigzag at the base (0-30) with 60 ms buzz legs (vib)
//   hold-top   strokes that wait 2 s at the top (a flat leg), for fits that cannot land

const SPECS = {
  tri: { lo: 10, hi: 90, speed: 200, strokeMs: 800 },
  'naive-tri': { lo: 10, hi: 90, speed: 200, strokeMs: 800, naive: true },
  buzz: { lo: 0, hi: 30, speed: 300, strokeMs: 120, buzz: true },
  'hold-top': { lo: 10, hi: 90, speed: 200, strokeMs: 2800, holdMs: 2000 },
};

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

export function fakeDescribe(id) {
  const s = SPECS[id];
  if (!s) return null;
  return { id, family: 'fake', kind: 'cycle', loopable: true, hasBuzz: !!s.buzz, speed: s.speed, speedRange: [s.speed / 2, s.speed * 2], range: [s.lo, s.hi], strokeMs: s.strokeMs };
}

export function fakeRender(id, opts = {}) {
  const s = SPECS[id];
  if (!s) return null;
  const o = opts || {};
  const from = Math.round(o.from || 0), until = from + Math.round(o.durationMs);
  if (!(until > from)) throw new RangeError('durationMs must be above 0');
  const mir = !!o.reversed;
  let lo = o.range ? o.range.min : s.lo, hi = o.range ? o.range.max : s.hi;
  if (mir) [lo, hi] = [100 - hi, 100 - lo];
  const sp = o.startPos === undefined || o.startPos === null ? undefined : (mir ? 100 - o.startPos : o.startPos);
  const dir = (mir ? -1 : 1) * Math.sign(o.startDir || 0);
  const v = o.speed > 0 ? o.speed : s.speed;
  const cap = o.maxSpeed > 0 ? o.maxSpeed : Math.max(600, 1.5 * v);
  const rng = mulberry32(hash32(`${o.seed ?? 1}|fake|${id}`));
  const vari = o.variation === undefined ? 1 : o.variation;
  const minLeg = s.buzz ? 50 : 100;
  const pts = [];
  const legMs = (d) => Math.max(minLeg, Math.round((d / Math.min(v, cap)) * 1000));
  let t = from, pos;
  // the first target: a turn ahead in the heading (or the nearer turn without one, or always for naive-tri)
  let target;
  if (sp === undefined) { pos = lo; target = hi; }
  else {
    pos = sp;
    if (s.naive || !dir) target = Math.abs(sp - lo) <= Math.abs(sp - hi) ? lo : hi;
    else if (dir > 0) target = sp >= hi - 2 ? lo : hi;
    else target = sp <= lo + 2 ? hi : lo;
  }
  pts.push({ t, p: pos, vib: false });
  let k = 0;
  while (t < until + 4 * minLeg && k < 100000) {
    const jit = s.buzz ? 0 : (rng() - 0.5) * 4 * vari;
    const p = Math.min(hi, Math.max(lo, target + jit));
    const d = Math.abs(p - pos);
    if (d >= 2 || k > 0) {
      t += legMs(Math.max(d, 1));
      pts.push({ t, p, vib: !!s.buzz && k > 0 });
      pos = p;
      if (s.holdMs && target === hi) { t += s.holdMs; pts.push({ t, p, vib: false }); }
    }
    target = target === hi ? lo : hi;
    k++;
  }
  // end exactly at `until`: the position there on the path, after the last point at least a leg before it
  let posAt = pts[pts.length - 1].p;
  for (let i = 1; i < pts.length; i++) if (pts[i].t >= until) { const a = pts[i - 1], b = pts[i]; posAt = a.p + ((b.p - a.p) * (until - a.t)) / (b.t - a.t); break; }
  const out = pts.filter((q) => q.t < until);
  while (out.length > 1 && until - out[out.length - 1].t < minLeg) out.pop();
  out.push({ t: until, p: posAt, vib: false });
  const actions = out.map((q) => ({ at: Math.round(q.t), pos: Math.round(mir ? 100 - q.p : q.p) }));
  // integer positions can nudge a leg past the cap by rounding: pull it back like the engine does
  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1], b = actions[i], dt = b.at - a.at, reach = Math.floor((cap * dt) / 1000);
    if (Math.abs(b.pos - a.pos) > reach) b.pos = a.pos + Math.sign(b.pos - a.pos) * reach;
  }
  return { actions, vib: out.map((q) => q.vib), stats: {}, warnings: [] };
}
