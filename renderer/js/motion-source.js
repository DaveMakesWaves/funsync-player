// motion-source — generated motion for axes that have NO script of their own.
//
// dio_likes_jojo (EroScripts #306) asked for what MultiFunPlayer and XTPlayer
// both do: drive a secondary axis (twist/roll/pitch) when the scripter only
// wrote a stroke track. Two modes, deliberately no more:
//
//   'link'   — trace the main axis. XTPlayer's model: take L0's next keyframe
//              position and reuse it on this axis, optionally shaped into the
//              top or bottom half of the axis's travel.
//   'random' — smooth gradient noise. MFP's model, and the reason it uses
//              simplex rather than Math.random(): white noise on a stroker is
//              a jackhammer, band-limited noise is a wander.
//   'pattern' — a chosen waveform. Same six shapes as MFP's Pattern provider,
//              same formulas. Random is a wander you can't predict; a pattern
//              is a shape you pick, which is what you want when the axis
//              should do one specific thing under the stroke.
//
// Both borrow their TIMING from the main script rather than running on their
// own clock — the caller emits one generated value per main keyframe, over
// that keyframe's own interval. That coupling is what stops generated motion
// feeling like a random number generator bolted to the hardware: it starts,
// breathes and stops with the action. MFP arrives at the same place from the
// other direction (its noise clock only advances while the stroke axis is
// dirty); XTPlayer takes the main action's interval verbatim.
//
// Pure module — no engine state, no DOM. tcode-sync.js owns the clock and the
// per-axis output stack (invert → range → cutoff), so a generated value passes
// through exactly the same Safety Cap / Ceiling limits a scripted one does.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Waveform shapes, matching MultiFunPlayer's PatternMotionProvider so a user
 * coming from MFP finds what they expect under the same names.
 */
export const PATTERN_TYPES = [
  'sine', 'triangle', 'doubleBounce', 'sharpBounce', 'saw', 'square',
];

export const DEFAULT_PATTERN = 'sine';

/**
 * Sample a waveform. One full cycle per 4 units of phase (MFP's `_time % 4`),
 * so `speed` reads as cycles-per-4-seconds and 1.0 is a slow, usable default
 * rather than a blur.
 *
 * @param {string} pattern one of PATTERN_TYPES
 * @param {number} phase   monotonic, in the same units the caller advances
 * @returns {number} 0-100
 */
export function patternValue(pattern, phase) {
  const t = clamp(((phase % 4) + 4) % 4 / 4, 0, 1);
  let v;
  switch (pattern) {
    case 'triangle':
      v = Math.abs(Math.abs(t * 2 - 1.5) - 1);
      break;
    case 'doubleBounce': {
      const x = t * Math.PI * 2 - Math.PI / 4;
      v = -(Math.pow(Math.sin(x), 5) + Math.pow(Math.cos(x), 5)) / 2 + 0.5;
      break;
    }
    case 'sharpBounce': {
      const x = (t + 0.41957) * Math.PI / 2;
      const sn = Math.sin(x) * Math.sin(x);
      const cs = Math.cos(x) * Math.cos(x);
      v = Math.sqrt(Math.max(cs - sn, sn - cs));
      break;
    }
    case 'saw':
      v = t;
      break;
    case 'square':
      v = t < 0.5 ? 1 : 0;
      break;
    case 'sine':
    default:
      v = -Math.sin(t * Math.PI * 2) / 2 + 0.5;
      break;
  }
  return clamp(v * 100, 0, 100);
}

/** Deterministic 32-bit PRNG — seeded so a session is reproducible in a bug report. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * 1D gradient (Perlin) noise. Continuous and band-limited — successive samples
 * are close together, which is the whole point: the device is asked to travel
 * to each new value, so an uncorrelated sequence would mean full-throw slams.
 * @param {number} [seed]
 * @returns {(t: number) => number} sample in roughly [-1, 1]
 */
export function createNoise1D(seed = 1337) {
  const rand = mulberry32(seed);
  const grad = new Float64Array(256);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) {
    grad[i] = rand() * 2 - 1;
    perm[i] = i;
  }
  for (let i = 255; i > 0; i--) {           // Fisher-Yates on the permutation
    const j = Math.floor(rand() * (i + 1));
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  return function noise(t) {
    const i0 = Math.floor(t);
    const f = t - i0;
    const g0 = grad[perm[i0 & 255]];
    const g1 = grad[perm[(i0 + 1) & 255]];
    const n0 = g0 * f;
    const n1 = g1 * (f - 1);
    const u = fade(f);
    return clamp(2 * (n0 + u * (n1 - n0)), -1, 1);
  };
}

/**
 * Fractal sum of a noise function. Octaves > 1 add finer detail on top of the
 * slow wander; MFP exposes the same three knobs.
 */
export function fbm(noise, t, { octaves = 1, persistence = 0.5, lacunarity = 2 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < Math.max(1, octaves | 0); o++) {
    sum += amp * noise(t * freq);
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Map noise output [-1, 1] onto an axis percentage [0, 100]. */
export function noiseToPercent(n) {
  return clamp((n + 1) * 50, 0, 100);
}

/**
 * Shape a raw 0-100 value for a generated axis.
 *
 * `half` restricts travel to one side of centre — XTPlayer's +/- channel
 * modifiers, useful when a mounted OSR2 can only usefully roll one way.
 * `depth` scales around centre, so 0% parks the axis at rest and 100% is full
 * travel. Deliberately NOT an invert: axis invert already exists one layer up
 * and applies to scripted and generated values alike.
 *
 * @param {number} pos 0-100
 * @param {{depth?: number, half?: 'off'|'top'|'bottom'}} [opts]
 * @returns {number} 0-100
 */
export function shapeGeneratedValue(pos, { depth = 100, half = 'off' } = {}) {
  let v = clamp(pos, 0, 100);
  if (half === 'top') v = 50 + v / 2;
  else if (half === 'bottom') v = v / 2;
  const d = clamp(depth, 0, 100) / 100;
  return clamp(50 + (v - 50) * d, 0, 100);
}

/**
 * Sample a motion config into a curve, for drawing a preview of what an axis
 * will actually do before the user commits to it.
 *
 * Same functions the engine uses, so the picture can't lie about the shape.
 * The canvas is a fixed WINDOW OF TIME, so Speed changes how many cycles fit
 * in it rather than stretching the drawing — turn it up and the curve gets
 * busier, which is what turning it up does to the axis.
 *
 * What it still can't show is the stroke's own rate: the engine emits on the
 * main script's keyframes, so real motion is this curve sampled at that rate.
 * Link mode is drawn against a synthetic full stroke for the same reason —
 * the actual script isn't knowable here, so the preview shows what Depth and
 * the travel half do to a stroke, not what any particular video will do.
 *
 * @param {{mode: string, depth?: number, half?: 'off'|'top'|'bottom',
 *          speed?: number, pattern?: string}|null} cfg
 * @param {{samples?: number, cycles?: number, noise?: (t:number)=>number}} [opts]
 *        `cycles` is the count at 1x speed; the config's own speed scales it.
 * @returns {number[]} values 0-100, or [] when there is nothing to draw
 */
export function sampleMotion(cfg, { samples = 96, cycles = 2, noise = null } = {}) {
  const norm = normaliseMotionConfig(cfg);
  if (!norm) return [];
  const n = Math.max(2, samples | 0);
  const out = [];
  const noiseFn = noise || createNoise1D();
  const span = cycles * norm.speed;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);                 // 0..1 across the preview width
    let raw;
    if (norm.mode === 'pattern') {
      raw = patternValue(norm.pattern, u * 4 * span);
    } else if (norm.mode === 'random') {
      raw = noiseToPercent(fbm(noiseFn, u * 4 * span));
    } else {
      // Link takes its timing from the script's keyframes, so Speed means
      // nothing to it — draw a plain stroke at the reference rate.
      raw = patternValue('sine', u * 4 * cycles);
    }
    out.push(shapeGeneratedValue(raw, norm));
  }
  return out;
}

/**
 * Stable per-axis phase offset, so R0/R1/R2 sharing one noise clock don't all
 * wander in lockstep (which would read as one coupled motion, not three axes).
 */
export function axisPhase(tcode) {
  let h = 0;
  for (let i = 0; i < String(tcode).length; i++) {
    h = (Math.imul(h, 31) + String(tcode).charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 1000) / 7.3;
}

/** Normalise a stored/incoming motion config. Unknown or absent → null (scripted). */
export function normaliseMotionConfig(cfg) {
  if (!cfg || !cfg.mode || cfg.mode === 'script') return null;
  if (cfg.mode !== 'link' && cfg.mode !== 'random' && cfg.mode !== 'pattern') return null;
  return {
    mode: cfg.mode,
    depth: Number.isFinite(cfg.depth) ? clamp(cfg.depth, 0, 100) : 100,
    half: cfg.half === 'top' || cfg.half === 'bottom' ? cfg.half : 'off',
    speed: Number.isFinite(cfg.speed) ? clamp(cfg.speed, 0.05, 4) : 1,
    pattern: PATTERN_TYPES.includes(cfg.pattern) ? cfg.pattern : DEFAULT_PATTERN,
  };
}
