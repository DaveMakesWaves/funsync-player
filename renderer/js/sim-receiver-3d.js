// The 3D receiver: the device simulator's default look (editor work list
// 2.5, Dave 2026-11-24: "option D as the default"). Ported from the mockup
// Dave picked (notes/features/SIM-multi-axis-options-2026-11-24.html, the
// `option3d` block), then made to look like OFS's own Simulator3D
// (OFS_Simulator3D, Godot: Main.tscn + Simulator3D.cs; Dave: "so people
// moving over to us have less of a visual learning curve"): a sleeve (an
// open top, smooth-shaded, one soft highlight) with two cubes on its sides
// that show the twist, as OFS's two "Twist" cubes, on a base slab with a
// fine grid (no front notch: no edge is the front for every axis), a soft shadow, and the stroke's rail with
// 0 / 50 / 100 ticks. Colours (Dave, 2026-11-24): the sleeve is the theme's
// main colour (--surface-card), lifted toward white when it is dark so it
// reads on the video, with a light 1 px outline; the cubes are
// the theme's --accent; the plate is neutral and see-through, so a navy
// sleeve does not sink into it; Speed colours paints the sleeve by the
// stroke's speed. The caller reads the theme (on a theme change, never per
// frame) and passes the colours to draw(). Plain 2D canvas drawing, no 3D
// library; flat colours, no glow.
//
// Built for a frame loop: every point, normal and draw order lives in typed
// arrays made once, so a frame allocates only the colours and gradients a
// shaded face needs; the base slab (fixed for a view) is drawn into its own
// canvas once per view and copied. The caller draws only when something
// changed (sim-axes-view.js).
//
// Space: x to the right, y up, z toward the camera at rest (OFS's axes); the
// camera sits on +z at SIM3D_MODEL.camDist and is turned by the view's yaw
// (about y) and tilt (about x), as the mockup's.
import { SIM_MOTION, simPose, poseApply } from './sim-axes.js';

const DEG = Math.PI / 180;

/** The two sizes the first build offered on its menu (CSS px); a stored 'small' / 'large' still reads as these. */
export const SIM3D_SIZES = Object.freeze({
  small: Object.freeze({ w: 150, h: 180 }),
  large: Object.freeze({ w: 230, h: 270 }),
});

/**
 * The 3D picture's width is dragged with its corner grip (Dave, 2026-11-24:
 * "why would you need a size option if you should be able to click and drag
 * to increase size"): any width in these limits, the height 1.2x it.
 */
export const SIM3D_WIDTH_LIMITS = Object.freeze({ min: 100, max: 420, def: 150 });

/** A stored size (a width in px, or the old 'small' / 'large') as the width to draw. */
export function sim3dWidth(raw) {
  if (raw === 'large') return SIM3D_SIZES.large.w;
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === null || raw === '' || typeof raw === 'boolean') return SIM3D_WIDTH_LIMITS.def;
  return Math.round(Math.max(SIM3D_WIDTH_LIMITS.min, Math.min(SIM3D_WIDTH_LIMITS.max, n)));
}

/** The picture's size for a stored size. */
export function sim3dSize(raw) {
  const w = sim3dWidth(raw);
  return { w, h: Math.round(w * 1.2) };
}

/**
 * The views on the right-click menu (degrees). Front looks from +z like
 * OFS's camera, tilted 6° down so the base plate still shows; the
 * three-quarter view is the mockup's, which Dave approved.
 */
export const SIM3D_VIEWS = Object.freeze({
  quarter: Object.freeze({ yaw: -35, tilt: 22 }),
  front: Object.freeze({ yaw: 0, tilt: 6 }),
  side: Object.freeze({ yaw: -90, tilt: 6 }),
  above: Object.freeze({ yaw: 0, tilt: 78 }),
});
export const SIM3D_VIEW_NAMES = Object.freeze(Object.keys(SIM3D_VIEWS));
/** Orbiting stops short of looking from straight above or far below. */
export const SIM3D_TILT_LIMITS = Object.freeze({ min: -10, max: 85 });
/** Degrees turned per pixel dragged (the mockup's 0.012 rad). */
export const SIM3D_ORBIT_DEG_PER_PX = (0.012 * 180) / Math.PI;

/** The looks on the right-click menu: the 3D receiver and the three 2D ones. */
export const SIM_LOOKS = Object.freeze(['3d', 'drawing', 'bars', 'gauges']);

/**
 * The model, in the mockup's units. The sleeve keeps the mockup's
 * proportions (Dave approved them); OFS's offsets are scaled to it, so the
 * stroke's travel is to the sleeve's height as OFS's (2 over 1.75).
 */
export const SIM3D_MODEL = Object.freeze({
  segments: 44,       // facets round the sleeve
  radius: 0.24,
  halfHeight: 0.34,
  hole: 0.62,         // the open top's opening, as a share of the radius
  floor: -0.9,        // the base slab's top
  plateHalf: 0.6,
  slab: 0.07,
  camDist: 3.3,
  focal: 2.3,
});
const XZ_SCALE = SIM3D_MODEL.radius / SIM_MOTION.OFS_RADIUS;
const Y_SCALE = SIM3D_MODEL.halfHeight / SIM_MOTION.OFS_HALF_HEIGHT;
/** The stroke's travel each way from the middle, in model units. */
export const SIM3D_TRAVEL = Y_SCALE;

/**
 * The colours when the theme cannot be read (tests, a page without the
 * app's CSS): Dark's --surface-card navy and --accent coral.
 */
export const SIM3D_DEFAULT_COLOURS = Object.freeze({
  sleeve: Object.freeze([28, 42, 74]),
  accent: Object.freeze([233, 69, 96]),
});

/**
 * The twist cues, as OFS has them: two cubes (CubeMesh "Twist1" / "Twist2",
 * 0.25 on a 0.5 radius) centred on the sleeve's surface on its left and
 * right at mid-height, so half of each sticks out; OFS paints them red, ours
 * are the theme's accent (Dave: "the red cubes should be coral"). A list, so
 * another marker drops in: `angle` round the sleeve (degrees, 0 = the front,
 * toward the camera at rest; 90 = the right), `y` its centre's height as a
 * share of the half-height (0 = the middle), `size` its edge as a share of
 * the radius. Each is a real box: six shaded faces, back faces culled,
 * sorted with the sleeve's.
 */
export const SIM3D_MARKERS = Object.freeze([
  Object.freeze({ angle: 90, y: 0, size: 0.5 }),
  Object.freeze({ angle: 270, y: 0, size: 0.5 }),
]);
/** A marker's faces sort this far nearer than their centres, so they win a tie with the sleeve under them. */
const MARKER_DEPTH_BIAS = 0.02;

// The plate is neutral and see-through (white 6% on top, darker sides), so
// it reads over any video and a navy sleeve does not sink into it.
const BASE_SIDE_FILL = 'rgba(0, 0, 0, 0.35)';
const BASE_EDGE = 'rgba(255, 255, 255, 0.08)';
const BASE_TOP_FILL = 'rgba(255, 255, 255, 0.06)';
const BASE_TOP_EDGE = 'rgba(255, 255, 255, 0.22)';
const GRID_MID = 'rgba(255, 255, 255, 0.2)';
const GRID = 'rgba(255, 255, 255, 0.07)';
const RAIL = 'rgba(255, 255, 255, 0.28)';
/** The sleeve's outline (its rims and the edges of its silhouette): light, 1 px. */
const OUTLINE = 'rgba(255, 255, 255, 0.3)';

/**
 * A CSS colour as [r, g, b]: `#rgb`, `#rrggbb` or `rgb()/rgba()` (what
 * getComputedStyle gives for a custom property holding one). Null for
 * anything else.
 */
export function parseCssColour(str) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(Math.min(255, Math.max(0, v))));
  return null;
}

/** Below this luminance (0-1) the sleeve's colour is lifted toward white. */
export const SIM3D_DARK_LUMINANCE = 0.35;
/** How far a dark sleeve is lifted toward white. */
export const SIM3D_LIFT = 0.18;

/**
 * The sleeve's colour as drawn over the video: a dark theme colour (Dark's
 * navy, Holiday's green) mixed 18% toward white so it does not vanish into
 * the footage; a light one as it is.
 */
export function sleeveColourFor(rgb) {
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (lum >= SIM3D_DARK_LUMINANCE) return [rgb[0], rgb[1], rgb[2]];
  return rgb.map((c) => Math.round(c + (255 - c) * SIM3D_LIFT));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const normYaw = (deg) => {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return Math.round(d * 10) / 10;
};

/**
 * A stored view as the receiver uses it: a preset's name, or an orbit
 * `{ yaw, tilt }` in degrees (saved after a drag). `preset` names the menu
 * entry to tick (null after an orbit that is none of them). Anything else
 * is the three-quarter view.
 */
export function resolveView3d(raw) {
  if (typeof raw === 'string' && SIM3D_VIEWS[raw]) return { ...SIM3D_VIEWS[raw], preset: raw };
  if (raw && finite(raw.yaw) && finite(raw.tilt)) {
    const yaw = normYaw(raw.yaw);
    const tilt = Math.round(clamp(raw.tilt, SIM3D_TILT_LIMITS.min, SIM3D_TILT_LIMITS.max) * 10) / 10;
    const preset = SIM3D_VIEW_NAMES.find((n) => SIM3D_VIEWS[n].yaw === yaw && SIM3D_VIEWS[n].tilt === tilt) || null;
    return { yaw, tilt, preset };
  }
  return { ...SIM3D_VIEWS.quarter, preset: 'quarter' };
}

/** The view after dragging the picture by (dx, dy) px: across turns it, up and down tilts it. */
export function orbitView(view, dx, dy) {
  return {
    yaw: normYaw(view.yaw + (finite(dx) ? dx : 0) * SIM3D_ORBIT_DEG_PER_PX),
    tilt: Math.round(clamp(view.tilt + (finite(dy) ? dy : 0) * SIM3D_ORBIT_DEG_PER_PX, SIM3D_TILT_LIMITS.min, SIM3D_TILT_LIMITS.max) * 10) / 10,
  };
}

/**
 * The look settings as the simulator uses them: the look (3D by default),
 * the 3D size and view.
 * @param {{look?: unknown, size?: unknown, view?: unknown}} raw
 */
export function resolveSimLook(raw = {}) {
  return {
    look: SIM_LOOKS.includes(raw?.look) ? raw.look : '3d',
    size: sim3dWidth(raw?.size),
    view: resolveView3d(raw?.view),
  };
}

// The light, in camera space (the mockup's): from the upper left, in front.
const LX = -0.5 / Math.hypot(-0.5, 0.75, 0.55);
const LY = 0.75 / Math.hypot(-0.5, 0.75, 0.55);
const LZ = 0.55 / Math.hypot(-0.5, 0.75, 0.55);
// Blinn's half vector, the viewer on +z.
const HN = Math.hypot(LX, LY, LZ + 1);
const HX = LX / HN; const HY = LY / HN; const HZ = (LZ + 1) / HN;

/** A shaded colour: `rgb` lit by k (0.3 ambient + 0.7 diffuse) plus a white highlight s. */
function paint(rgb, k, s) {
  const r = Math.round(Math.min(255, rgb[0] * k + 255 * s));
  const g = Math.round(Math.min(255, rgb[1] * k + 255 * s));
  const b = Math.round(Math.min(255, rgb[2] * k + 255 * s));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * One receiver drawing on a 2D canvas. setSize / setView / setPose, then
 * draw(ctx, rgb). Layout is redone only after one of those.
 */
export class Receiver3D {
  /**
   * @param {object} [opts]
   * @param {() => HTMLCanvasElement|null} [opts.makeCanvas] for the base slab's cache; without it the slab is drawn each time
   */
  constructor({ makeCanvas = null } = {}) {
    const N = SIM3D_MODEL.segments;
    this.N = N;
    this._sin = new Float64Array(N);
    this._cos = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      this._sin[i] = Math.sin(a);
      this._cos[i] = Math.cos(a);
    }
    // View-space points and normals, and their projections.
    this._bot = new Float64Array(3 * N);
    this._top = new Float64Array(3 * N);
    this._hole = new Float64Array(3 * N);
    this._nrm = new Float64Array(3 * N);
    this._pBot = new Float64Array(2 * N);
    this._pTop = new Float64Array(2 * N);
    this._pHole = new Float64Array(2 * N);
    this._caps = new Float64Array(12);           // top, bottom: normal (3) + centre (3)
    // Markers: 8 corners and 6 face normals each, in the model, then in view.
    const M = SIM3D_MARKERS.length;
    this._mkLocal = new Float64Array(M * 8 * 3);
    this._mkNormLocal = new Float64Array(M * 6 * 3);
    this._mk = new Float64Array(M * 8 * 3);
    this._pMk = new Float64Array(M * 8 * 2);
    this._mkNorm = new Float64Array(M * 6 * 3);
    this._buildMarkers();
    // Which facets and ends face the camera (their light outline goes
    // where a facing one meets one that does not: the silhouette).
    this._facing = new Uint8Array(N);
    this._endFacing = new Uint8Array(2);
    // The draw order: facets, the two ends, the markers' faces.
    const max = N + 2 + M * 6;
    this._depth = new Float64Array(max);
    this._id = new Int32Array(max);
    this._count = 0;
    this._push = (depth, id) => this._pushItem(depth, id);
    // The view (yaw, then tilt).
    this._v = new Float64Array(9);
    this._pose = simPose({}, 50);
    this._tmp = { x: 0, y: 0, z: 0 };
    this._sx = 0;
    this._sy = 0;
    this._makeCanvas = makeCanvas;
    this._baseCanvas = null;
    this._baseKey = '';
    this.setSize(SIM3D_WIDTH_LIMITS.def);
    this.setView(SIM3D_VIEWS.quarter);
  }

  /** @param {number|'small'|'large'} size a width in CSS px (or the old names) */
  setSize(size) {
    const s = sim3dSize(size);
    this.W = s.w;
    this.H = s.h;
    this._dirty = true;
  }

  /** @param {{yaw: number, tilt: number}} view degrees */
  setView(view) {
    this.yaw = view.yaw;
    this.tilt = view.tilt;
    const cy = Math.cos(view.yaw * DEG); const sy = Math.sin(view.yaw * DEG);
    const ct = Math.cos(view.tilt * DEG); const st = Math.sin(view.tilt * DEG);
    // V = Rx(tilt) · Ry(yaw), row-major.
    const v = this._v;
    v[0] = cy; v[1] = 0; v[2] = sy;
    v[3] = st * sy; v[4] = ct; v[5] = -st * cy;
    v[6] = -ct * sy; v[7] = st; v[8] = ct * cy;
    this._dirty = true;
  }

  /**
   * @param {{surge?: number, sway?: number, twist?: number, roll?: number, pitch?: number}} values 0-100
   * @param {number} stroke 0-100, as the bar draws it
   */
  setPose(values, stroke) {
    simPose(values, stroke, this._pose);
    this._dirty = true;
  }

  /** A world point into camera space, into `this._tmp`. */
  _view(x, y, z) {
    const v = this._v;
    const t = this._tmp;
    t.x = v[0] * x + v[1] * y + v[2] * z;
    t.y = v[3] * x + v[4] * y + v[5] * z;
    t.z = v[6] * x + v[7] * y + v[8] * z;
    return t;
  }

  /** A camera-space point onto the canvas, into `this._sx` / `this._sy` (the mockup's projection). */
  _project(x, y, z) {
    const k = (SIM3D_MODEL.focal / (SIM3D_MODEL.camDist - z)) * this.H * 0.66;
    this._sx = this.W / 2 + x * k;
    this._sy = this.H * 0.5 - (y + 0.06) * k;
  }

  /** A model point of the receiver (posed) into camera space, written at `arr[i]`. */
  _posed(px, py, pz, arr, i, move = true) {
    const t = poseApply(this._pose, px, py, pz, this._tmp, XZ_SCALE, Y_SCALE, move);
    const v = this._v;
    const x = t.x; const y = t.y; const z = t.z;
    arr[i] = v[0] * x + v[1] * y + v[2] * z;
    arr[i + 1] = v[3] * x + v[4] * y + v[5] * z;
    arr[i + 2] = v[6] * x + v[7] * y + v[8] * z;
  }

  _buildMarkers() {
    const R = SIM3D_MODEL.radius;
    const HH = SIM3D_MODEL.halfHeight;
    SIM3D_MARKERS.forEach((m, k) => {
      const a = m.angle * DEG;
      const rx = Math.sin(a); const rz = Math.cos(a);   // out of the sleeve
      const tx = Math.cos(a); const tz = -Math.sin(a);  // along it
      const h = (m.size * R) / 2;
      const cx = rx * R; const cy = m.y * HH; const cz = rz * R;
      for (let c = 0; c < 8; c++) {
        const sr = c & 4 ? 1 : -1;
        const st = c & 2 ? 1 : -1;
        const su = c & 1 ? 1 : -1;
        const o = (k * 8 + c) * 3;
        this._mkLocal[o] = cx + h * (sr * rx + st * tx);
        this._mkLocal[o + 1] = cy + h * su;
        this._mkLocal[o + 2] = cz + h * (sr * rz + st * tz);
      }
      const normals = [[rx, 0, rz], [-rx, 0, -rz], [tx, 0, tz], [-tx, 0, -tz], [0, 1, 0], [0, -1, 0]];
      normals.forEach((n, f) => {
        const o = (k * 6 + f) * 3;
        this._mkNormLocal[o] = n[0]; this._mkNormLocal[o + 1] = n[1]; this._mkNormLocal[o + 2] = n[2];
      });
    });
  }

  /** Whether a camera-space face (normal n, centre c) faces the camera. */
  static facing(nx, ny, nz, cx, cy, cz) {
    return nx * -cx + ny * -cy + nz * (SIM3D_MODEL.camDist - cz) > 0;
  }

  /** Recompute every point, normal, projection and the draw order. */
  layout() {
    if (!this._dirty) return;
    this._dirty = false;
    const N = this.N;
    const R = SIM3D_MODEL.radius;
    const HH = SIM3D_MODEL.halfHeight;
    const HOLE = SIM3D_MODEL.hole;
    for (let i = 0; i < N; i++) {
      const s = this._sin[i]; const c = this._cos[i];
      const o = i * 3; const p = i * 2;
      this._posed(R * s, -HH, R * c, this._bot, o);
      this._posed(R * s, HH, R * c, this._top, o);
      this._posed(R * HOLE * s, HH, R * HOLE * c, this._hole, o);
      this._posed(s, 0, c, this._nrm, o, false);
      this._project(this._bot[o], this._bot[o + 1], this._bot[o + 2]);
      this._pBot[p] = this._sx; this._pBot[p + 1] = this._sy;
      this._project(this._top[o], this._top[o + 1], this._top[o + 2]);
      this._pTop[p] = this._sx; this._pTop[p + 1] = this._sy;
      this._project(this._hole[o], this._hole[o + 1], this._hole[o + 2]);
      this._pHole[p] = this._sx; this._pHole[p + 1] = this._sy;
    }
    this._posed(0, 1, 0, this._caps, 0, false);
    this._posed(0, HH, 0, this._caps, 3);
    this._posed(0, -1, 0, this._caps, 6, false);
    this._posed(0, -HH, 0, this._caps, 9);
    const M = SIM3D_MARKERS.length;
    for (let k = 0; k < M; k++) {
      for (let c = 0; c < 8; c++) {
        const o = (k * 8 + c) * 3;
        this._posed(this._mkLocal[o], this._mkLocal[o + 1], this._mkLocal[o + 2], this._mk, o);
        this._project(this._mk[o], this._mk[o + 1], this._mk[o + 2]);
        this._pMk[(k * 8 + c) * 2] = this._sx;
        this._pMk[(k * 8 + c) * 2 + 1] = this._sy;
      }
      for (let f = 0; f < 6; f++) {
        const o = (k * 6 + f) * 3;
        this._posed(this._mkNormLocal[o], this._mkNormLocal[o + 1], this._mkNormLocal[o + 2], this._mkNorm, o, false);
      }
    }
    // What faces the camera, far to near (an insertion sort into the typed
    // arrays: at most ~60 faces, and no array made per frame).
    this._count = 0;
    const push = this._push;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = i * 3; const b = j * 3;
      let nx = this._nrm[a] + this._nrm[b];
      let ny = this._nrm[a + 1] + this._nrm[b + 1];
      let nz = this._nrm[a + 2] + this._nrm[b + 2];
      const m = Math.hypot(nx, ny, nz) || 1;
      nx /= m; ny /= m; nz /= m;
      const cx = (this._bot[a] + this._top[b]) / 2;
      const cy = (this._bot[a + 1] + this._top[b + 1]) / 2;
      const cz = (this._bot[a + 2] + this._top[b + 2]) / 2;
      this._facing[i] = Receiver3D.facing(nx, ny, nz, cx, cy, cz) ? 1 : 0;
      if (this._facing[i]) push(cz, i);
    }
    for (let e = 0; e < 2; e++) {
      const o = e * 6;
      const cp = this._caps;
      this._endFacing[e] = Receiver3D.facing(cp[o], cp[o + 1], cp[o + 2], cp[o + 3], cp[o + 4], cp[o + 5]) ? 1 : 0;
      if (this._endFacing[e]) push(cp[o + 5], N + e);
    }
    for (let k = 0; k < M; k++) {
      for (let f = 0; f < 6; f++) {
        const no = (k * 6 + f) * 3;
        const corners = FACE_CORNERS[f];
        let cx = 0; let cy = 0; let cz = 0;
        for (let q = 0; q < 4; q++) {
          const o = (k * 8 + corners[q]) * 3;
          cx += this._mk[o]; cy += this._mk[o + 1]; cz += this._mk[o + 2];
        }
        cx /= 4; cy /= 4; cz /= 4;
        if (Receiver3D.facing(this._mkNorm[no], this._mkNorm[no + 1], this._mkNorm[no + 2], cx, cy, cz)) {
          push(cz + MARKER_DEPTH_BIAS, N + 2 + k * 6 + f);
        }
      }
    }
  }

  /** Add a face to the draw order, kept sorted far (low z) to near. */
  _pushItem(depth, id) {
    let j = this._count++;
    while (j > 0 && this._depth[j - 1] > depth) {
      this._depth[j] = this._depth[j - 1];
      this._id[j] = this._id[j - 1];
      j--;
    }
    this._depth[j] = depth;
    this._id[j] = id;
  }

  /** Lighting of a camera-space normal: sets this._k (0.3-1) and this._s (the highlight). */
  _lit(nx, ny, nz) {
    const diffuse = Math.max(0, nx * LX + ny * LY + nz * LZ);
    const spec = Math.max(0, nx * HX + ny * HY + nz * HZ) ** 36;
    this._k = 0.3 + 0.7 * diffuse;
    this._s = spec * 0.5;
  }

  /**
   * Draw it all: the base slab, the shadow, the rail, then the receiver's
   * faces far to near.
   * @param {CanvasRenderingContext2D} ctx scaled to CSS px already
   * @param {object} [colours]
   * @param {number[]} [colours.sleeve] [r, g, b] as drawn (sleeveColourFor, or a speed colour)
   * @param {number[]} [colours.accent] [r, g, b] for the cubes
   * @param {number} [colours.dpr] the canvas's pixel ratio (for the slab's cache)
   */
  draw(ctx, { sleeve = SIM3D_DEFAULT_COLOURS.sleeve, accent = SIM3D_DEFAULT_COLOURS.accent, dpr = 1 } = {}) {
    this.layout();
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    this._accent = accent;
    this._drawBaseCached(ctx, dpr);
    this._drawShadow(ctx);
    this._drawRail(ctx);
    for (let k = 0; k < this._count; k++) this._drawItem(ctx, this._id[k], sleeve);
  }

  _drawBaseCached(ctx, dpr) {
    const a = this._accent || SIM3D_DEFAULT_COLOURS.accent;
    // What the cached slab was drawn for, compared as numbers (no key string per frame).
    const bk = this._baseKeyNow || (this._baseKeyNow = new Float64Array(8));
    bk[0] = this.W; bk[1] = this.H; bk[2] = dpr; bk[3] = this.yaw; bk[4] = this.tilt;
    bk[5] = a[0]; bk[6] = a[1]; bk[7] = a[2];
    if (this._makeCanvas && !this._baseCanvas) {
      try { this._baseCanvas = this._makeCanvas(); } catch { this._baseCanvas = null; }
      if (!this._baseCanvas) this._makeCanvas = null;
    }
    const cache = this._baseCanvas;
    const cctx = cache?.getContext?.('2d');
    if (!cctx) {
      this._drawBase(ctx);
      return;
    }
    const was = this._baseKey || (this._baseKey = new Float64Array(8).fill(NaN));
    let same = true;
    for (let i = 0; i < 8; i++) if (was[i] !== bk[i]) { same = false; break; }
    if (!same) {
      cache.width = Math.round(this.W * dpr);
      cache.height = Math.round(this.H * dpr);
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.clearRect(0, 0, this.W, this.H);
      cctx.lineJoin = 'round';
      this._drawBase(cctx);
      was.set(bk);
      this.baseDraws = (this.baseDraws || 0) + 1;
    }
    ctx.drawImage(cache, 0, 0, this.W, this.H);
  }

  _moveTo(ctx, x, y, z) {
    const t = this._view(x, y, z);
    this._project(t.x, t.y, t.z);
    ctx.moveTo(this._sx, this._sy);
  }

  _lineTo(ctx, x, y, z) {
    const t = this._view(x, y, z);
    this._project(t.x, t.y, t.z);
    ctx.lineTo(this._sx, this._sy);
  }

  /** The base slab: its sides that face the camera, its navy top with the grid. */
  _drawBase(ctx) {
    const HALF = SIM3D_MODEL.plateHalf;
    const FLOOR = SIM3D_MODEL.floor;
    const SLAB = SIM3D_MODEL.slab;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = PLATE[i];
      const [bx, bz] = PLATE[(i + 1) % 4];
      const mx = (ax + bx) / 2; const mz = (az + bz) / 2;
      const ml = Math.hypot(mx, mz) || 1;
      const n = this._view(mx / ml, 0, mz / ml);
      const nx = n.x; const ny = n.y; const nz = n.z;
      const c = this._view(mx * HALF, FLOOR - SLAB / 2, mz * HALF);
      if (!Receiver3D.facing(nx, ny, nz, c.x, c.y, c.z)) continue;
      ctx.beginPath();
      this._moveTo(ctx, ax * HALF, FLOOR, az * HALF);
      this._lineTo(ctx, bx * HALF, FLOOR, bz * HALF);
      this._lineTo(ctx, bx * HALF, FLOOR - SLAB, bz * HALF);
      this._lineTo(ctx, ax * HALF, FLOOR - SLAB, az * HALF);
      ctx.closePath();
      ctx.fillStyle = BASE_SIDE_FILL;
      ctx.fill();
      ctx.strokeStyle = BASE_EDGE;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const [x, z] = PLATE[i];
      if (i === 0) this._moveTo(ctx, x * HALF, FLOOR, z * HALF);
      else this._lineTo(ctx, x * HALF, FLOOR, z * HALF);
    }
    ctx.closePath();
    ctx.fillStyle = BASE_TOP_FILL;
    ctx.fill();
    ctx.strokeStyle = BASE_TOP_EDGE;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.lineWidth = 0.75;
    for (let i = 1; i < 8; i++) {
      const u = -HALF + (i / 8) * 2 * HALF;
      ctx.strokeStyle = i === 4 ? GRID_MID : GRID;
      ctx.beginPath();
      this._moveTo(ctx, u, FLOOR, -HALF);
      this._lineTo(ctx, u, FLOOR, HALF);
      ctx.stroke();
      ctx.beginPath();
      this._moveTo(ctx, -HALF, FLOOR, u);
      this._lineTo(ctx, HALF, FLOOR, u);
      ctx.stroke();
    }
    // No 'front' notch (Dave, 2026-11-25): by OFS's motion no edge is the
    // front for every axis (Surge / Forward moves to the right, Pitch tilts
    // toward the camera), so a marker looked wrong for some of them; it sat
    // on the device's right side. The menu turns the base instead.
  }

  /** The soft shadow straight below the receiver, smaller and lighter as it rises. */
  _drawShadow(ctx) {
    const R = SIM3D_MODEL.radius;
    const FLOOR = SIM3D_MODEL.floor;
    const tx = this._pose.x * XZ_SCALE;
    const ty = this._pose.y * Y_SCALE;
    const tz = this._pose.z * XZ_SCALE;
    const lift = (ty - FLOOR) / (SIM3D_TRAVEL - FLOOR + 0.4);
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 2 * Math.PI;
      const t = this._view(tx + R * 1.25 * Math.sin(a), FLOOR, tz + R * 1.25 * Math.cos(a));
      this._project(t.x, t.y, t.z);
      if (this._sx < minX) minX = this._sx;
      if (this._sx > maxX) maxX = this._sx;
      if (this._sy < minY) minY = this._sy;
      if (this._sy > maxY) maxY = this._sy;
    }
    const rx = (maxX - minX) / 2;
    if (!(rx > 0)) return;
    const ry = Math.max(1, (maxY - minY) / 2);
    const r = rx * (1.1 + lift * 0.4);
    ctx.save();
    ctx.translate((minX + maxX) / 2, (minY + maxY) / 2);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(0, 0, 0, ${(0.6 - lift * 0.25).toFixed(2)})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  /** The stroke's rail: a thin rod from the base to the top of the travel, ticks at 0, 50 and 100. */
  _drawRail(ctx) {
    const tx = this._pose.x * XZ_SCALE;
    const tz = this._pose.z * XZ_SCALE;
    ctx.strokeStyle = RAIL;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this._moveTo(ctx, tx, SIM3D_MODEL.floor, tz);
    this._lineTo(ctx, tx, SIM3D_TRAVEL + SIM3D_MODEL.halfHeight + 0.06, tz);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = -1; v <= 1; v++) {
      const y = v * SIM3D_TRAVEL;
      this._moveTo(ctx, tx - 0.06, y, tz);
      this._lineTo(ctx, tx + 0.06, y, tz);
    }
    ctx.stroke();
  }

  _drawItem(ctx, id, rgb) {
    const N = this.N;
    if (id < N) {
      // A sleeve facet, smooth-shaded: the light at each vertical edge, blended across it.
      const j = (id + 1) % N;
      const pa = id * 2; const pb = j * 2;
      const B = this._pBot; const T = this._pTop;
      const g = ctx.createLinearGradient(
        (B[pa] + T[pa]) / 2, (B[pa + 1] + T[pa + 1]) / 2,
        (B[pb] + T[pb]) / 2, (B[pb + 1] + T[pb + 1]) / 2,
      );
      const na = id * 3; const nb = j * 3;
      this._lit(this._nrm[na], this._nrm[na + 1], this._nrm[na + 2]);
      g.addColorStop(0, paint(rgb, this._k, this._s));
      this._lit(this._nrm[nb], this._nrm[nb + 1], this._nrm[nb + 2]);
      g.addColorStop(1, paint(rgb, this._k, this._s));
      ctx.beginPath();
      ctx.moveTo(B[pa], B[pa + 1]);
      ctx.lineTo(B[pb], B[pb + 1]);
      ctx.lineTo(T[pb], T[pb + 1]);
      ctx.lineTo(T[pa], T[pa + 1]);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = g;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // The light outline where this facet is on the silhouette: a side
      // next to a facet turned away, a top or bottom edge whose end is.
      const left = !this._facing[(id - 1 + N) % N];
      const right = !this._facing[j];
      const topOpen = !this._endFacing[0];
      const botOpen = !this._endFacing[1];
      if (left || right || topOpen || botOpen) {
        ctx.beginPath();
        if (left) { ctx.moveTo(B[pa], B[pa + 1]); ctx.lineTo(T[pa], T[pa + 1]); }
        if (right) { ctx.moveTo(B[pb], B[pb + 1]); ctx.lineTo(T[pb], T[pb + 1]); }
        if (topOpen) { ctx.moveTo(T[pa], T[pa + 1]); ctx.lineTo(T[pb], T[pb + 1]); }
        if (botOpen) { ctx.moveTo(B[pa], B[pa + 1]); ctx.lineTo(B[pb], B[pb + 1]); }
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      return;
    }
    if (id < N + 2) {
      // An end: the open top (its rim and the dark opening) or the closed bottom.
      const top = id === N;
      const o = top ? 0 : 6;
      const P = top ? this._pTop : this._pBot;
      this._lit(this._caps[o], this._caps[o + 1], this._caps[o + 2]);
      ringPath(ctx, P, N);
      ctx.fillStyle = paint(rgb, this._k, this._s);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (top) {
        ringPath(ctx, this._pHole, N);
        ctx.fillStyle = paint(rgb, 0.18, 0);
        ctx.fill();
        ctx.strokeStyle = paint(rgb, 0.45, 0);
        ctx.stroke();
      }
      return;
    }
    // A marker's face, flat-shaded in the accent.
    const m = id - N - 2;
    const k = Math.floor(m / 6);
    const f = m % 6;
    const no = (k * 6 + f) * 3;
    this._lit(this._mkNorm[no], this._mkNorm[no + 1], this._mkNorm[no + 2]);
    const colour = paint(this._accent || SIM3D_DEFAULT_COLOURS.accent, this._k, this._s);
    const corners = FACE_CORNERS[f];
    ctx.beginPath();
    for (let c = 0; c < 4; c++) {
      const p = (k * 8 + corners[c]) * 2;
      if (c === 0) ctx.moveTo(this._pMk[p], this._pMk[p + 1]);
      else ctx.lineTo(this._pMk[p], this._pMk[p + 1]);
    }
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // ---- Read-backs (tests, and what a caller may want to know) ----

  /** Whether marker `k`'s outer face (the one away from the sleeve) faces the camera now. */
  markerFacing(k) {
    this.layout();
    const id = this.N + 2 + k * 6;   // face 0 = outer
    for (let i = 0; i < this._count; i++) if (this._id[i] === id) return true;
    return false;
  }

  /** How many faces are drawn now, and which kinds (tests). */
  drawnFaces() {
    this.layout();
    let facets = 0; let ends = 0; let markers = 0;
    for (let i = 0; i < this._count; i++) {
      const id = this._id[i];
      if (id < this.N) facets++;
      else if (id < this.N + 2) ends++;
      else markers++;
    }
    return { facets, ends, markers };
  }

  /** The canvas box the receiver, its markers and the rail take now: {minX, maxX, minY, maxY}. */
  receiverBounds() {
    this.layout();
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    const take = (x, y) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const P of [this._pBot, this._pTop, this._pMk]) {
      for (let i = 0; i < P.length; i += 2) take(P[i], P[i + 1]);
    }
    const tx = this._pose.x * XZ_SCALE;
    const tz = this._pose.z * XZ_SCALE;
    for (const y of [SIM3D_MODEL.floor, SIM3D_TRAVEL + SIM3D_MODEL.halfHeight + 0.06]) {
      const t = this._view(tx, y, tz);
      this._project(t.x, t.y, t.z);
      take(this._sx, this._sy);
    }
    return { minX, maxX, minY, maxY };
  }

  /** The receiver's centre on the canvas now (tests: what a stroke moves). */
  centre() {
    this.layout();
    const cp = this._caps;
    const x = (cp[3] + cp[9]) / 2; const y = (cp[4] + cp[10]) / 2; const z = (cp[5] + cp[11]) / 2;
    this._project(x, y, z);
    return { x: this._sx, y: this._sy };
  }
}

/** The base plate's corners (x, z) as shares of its half-width. */
const PLATE = Object.freeze([[-1, -1], [1, -1], [1, 1], [-1, 1]]);

/**
 * A marker box's faces as its corners (corner index = out << 2 | along << 1
 * | up), in the order of the face normals in _buildMarkers: out, in, along
 * +, along -, up, down.
 */
const FACE_CORNERS = Object.freeze([
  Object.freeze([4, 6, 7, 5]),
  Object.freeze([0, 2, 3, 1]),
  Object.freeze([2, 6, 7, 3]),
  Object.freeze([0, 4, 5, 1]),
  Object.freeze([1, 3, 7, 5]),
  Object.freeze([0, 2, 6, 4]),
]);

function ringPath(ctx, P, N) {
  ctx.beginPath();
  ctx.moveTo(P[0], P[1]);
  for (let i = 1; i < N; i++) ctx.lineTo(P[i * 2], P[i * 2 + 1]);
  ctx.closePath();
}
