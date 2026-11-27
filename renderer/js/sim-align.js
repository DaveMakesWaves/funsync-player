// "Align the simulator to the video", the maths (editor work list 5.4,
// 2026-11-24). Pure: no DOM, so node tests run it as it ships. NOT USED
// YET: the UI waits on Dave's look at the mockups.
//
// A scripting aid, as OFS lets you drag and size its simulator over the
// action: the user clicks the stroke's tip, then its base, on the video
// frame, and the simulator's bar is laid along that line (its top end, the
// knob end, at the tip), as long as the line and turned to its angle. The
// place is kept as ONE setting, `player.deviceSimAlign` = { tip, base }, each
// point a fraction of the video PICTURE (the frame as drawn, inside any
// letterbox), so a window resize, the editor opening beside the video or
// another aspect mode keeps the bar on the same spot of the picture.

/** Two clicks closer than this (CSS px) are one point: the second is not taken. */
export const SIM_ALIGN_MIN_PX = 24;

/** The bar is never drawn shorter than this when aligned (CSS px), so it can still be grabbed. */
export const SIM_ALIGN_MIN_LENGTH = 40;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * The stored alignment as the simulator uses it, or null (not aligned).
 * Both points must be numbers; each is held to the picture (0-1); two
 * points on top of each other give no line and count as not aligned.
 * @param {unknown} raw `{ tip: {x, y}, base: {x, y} }`
 * @returns {{tip: {x: number, y: number}, base: {x: number, y: number}}|null}
 */
export function resolveSimAlign(raw) {
  const pt = (p) => (p && finite(p.x) && finite(p.y) ? { x: clamp01(p.x), y: clamp01(p.y) } : null);
  const tip = pt(raw?.tip);
  const base = pt(raw?.base);
  if (!tip || !base) return null;
  if (Math.hypot(tip.x - base.x, tip.y - base.y) < 1e-3) return null;
  return { tip, base };
}

/**
 * Where the picture is drawn inside a <video> box, for its object-fit:
 * `fill` is the box; `cover` overflows it (the box clips it); anything
 * else (`contain`, the player's default, `scale-down`, `none`) is the
 * largest rectangle of the video's shape that fits, centred. The box is
 * the element's bounding rect, so a CSS transform on it (VR flatten's 2x
 * scale) is already in it.
 * @param {{left: number, top: number, width: number, height: number}} box
 * @param {number} videoW intrinsic width
 * @param {number} videoH intrinsic height
 * @param {string} [fit]
 * @returns {{left: number, top: number, width: number, height: number}|null}
 */
export function videoContentRect(box, videoW, videoH, fit = 'contain') {
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  if (fit === 'fill' || !(videoW > 0) || !(videoH > 0)) {
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }
  const sx = box.width / videoW;
  const sy = box.height / videoH;
  const s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const width = videoW * s;
  const height = videoH * s;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/** The overlap of two rects, or null when they do not overlap. */
export function intersectRect(a, b) {
  if (!a || !b) return a || b || null;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** A point on screen as fractions of the picture. */
export function toVideoFraction(rect, x, y) {
  return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
}

/** Fractions of the picture as a point on screen. */
export function fromVideoFraction(rect, p) {
  return { x: rect.left + p.x * rect.width, y: rect.top + p.y * rect.height };
}

/** Whether a point on screen is inside a rect (edges included). */
export function pointInRect(rect, x, y) {
  return !!rect && x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}

/**
 * The bar the alignment draws over this picture: its centre (screen px),
 * its length (px, the distance from the base to the tip) and its turn in
 * degrees clockwise, 0 = the tip straight above the base, as the knob
 * turns it (device-simulator.js rotationFromPointer). No snapping: the
 * clicks are the angle.
 * @param {ReturnType<typeof resolveSimAlign>} align
 * @param {{left: number, top: number, width: number, height: number}} rect the picture
 * @returns {{cx: number, cy: number, length: number, rotation: number}|null}
 */
export function alignedGeometry(align, rect) {
  if (!align || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const tip = fromVideoFraction(rect, align.tip);
  const base = fromVideoFraction(rect, align.base);
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  let rotation = (Math.atan2(dx, -dy) * 180) / Math.PI;
  rotation = Math.round((((rotation % 360) + 360) % 360) * 10) / 10;
  if (rotation >= 360) rotation = 0;
  return { cx: (tip.x + base.x) / 2, cy: (tip.y + base.y) / 2, length, rotation };
}

/**
 * The alignment moved by a drag of (dx, dy) fractions of the picture. The
 * move is held so both ends stay on the picture (the line keeps its length
 * and angle; it stops at the edge rather than bending).
 * @param {NonNullable<ReturnType<typeof resolveSimAlign>>} align
 * @param {number} dx
 * @param {number} dy
 */
export function translateAlign(align, dx, dy) {
  const xs = [align.tip.x, align.base.x];
  const ys = [align.tip.y, align.base.y];
  const mx = Math.min(Math.max(finite(dx) ? dx : 0, -Math.min(...xs)), 1 - Math.max(...xs));
  const my = Math.min(Math.max(finite(dy) ? dy : 0, -Math.min(...ys)), 1 - Math.max(...ys));
  return {
    tip: { x: align.tip.x + mx, y: align.tip.y + my },
    base: { x: align.base.x + mx, y: align.base.y + my },
  };
}
