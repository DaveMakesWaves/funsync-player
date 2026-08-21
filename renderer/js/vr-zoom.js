// vr-zoom — viewer zoom + pan for VR video shown on a flat screen.
//
// Requested by terijapl (#284): "i'd also throw in zooming in/out if it's
// possible". It already half-existed, and badly:
//
//   * The VR Format panel had a "Zoom" slider (1.0-2.0) writing `entry.zoom`,
//     which CSS multiplied into the ONE-AXIS un-squash:
//       transform: scaleX(calc(2 * var(--vr-flatten-zoom, 1)))
//     For a normally-packed SBS video that stretches the picture
//     horizontally rather than magnifying it. It is a PACKING-RATIO
//     CORRECTION for non-standard sources wearing the name "Zoom".
//   * The only way to reach it was Ctrl+Shift+R, which is also how terijapl
//     hit the drag-and-drop path bug — so for him the control was both
//     mislabelled and unreachable.
//
// So `zoom` keeps its old meaning (packing correction, planar only) and this
// module adds a real uniform VIEW zoom on top, driven by direct manipulation:
// Ctrl+scroll, trackpad pinch and Ctrl+= / Ctrl+- / Ctrl+0.
//
// Trackpad pinch needs no separate code path: browsers report it as a `wheel`
// event with `ctrlKey: true`, which is exactly what Ctrl+scroll sends. One
// handler covers both, and it MUST call preventDefault or Chromium's own page
// zoom fires and rescales the whole UI.
//
// Spherical projections do not use view zoom at all — narrowing the field of
// view is the physically correct way to zoom a projected sphere, and those
// already have drag-to-pan and double-click-recenter.

/** Uniform view zoom applied on top of the projection. 1 = fit. */
export const VIEW_ZOOM_MIN = 1;
export const VIEW_ZOOM_MAX = 4;

/** Field of view, degrees. LOWER is more zoomed in. */
export const FOV_MIN = 30;
export const FOV_MAX = 120;

/** One notch of the wheel, or one Ctrl+= press. Multiplicative so each */
/** step feels the same at 1.1x as it does at 3x. */
export const ZOOM_STEP = 1.1;
/** Degrees of FOV per notch. Linear: FOV is already an angle. */
export const FOV_STEP = 5;

const SPHERICAL = new Set(['equirect-180', 'fisheye-180', 'equirect-360']);

/** Does this projection zoom by field of view rather than by scaling? */
export function isSpherical(projection) {
  return SPHERICAL.has(projection);
}

export function clampViewZoom(z) {
  if (!Number.isFinite(z)) return VIEW_ZOOM_MIN;
  return Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, z));
}

export function clampFov(f) {
  if (!Number.isFinite(f)) return 90;
  return Math.min(FOV_MAX, Math.max(FOV_MIN, f));
}

/**
 * Next view zoom for a scroll/keypress.
 *
 * @param {number} current
 * @param {number} direction  +1 to zoom in, -1 to zoom out
 */
export function stepViewZoom(current, direction) {
  const base = clampViewZoom(current);
  return clampViewZoom(direction > 0 ? base * ZOOM_STEP : base / ZOOM_STEP);
}

/**
 * Next FOV. Inverted deliberately: scrolling UP (direction +1, "zoom in")
 * must NARROW the field of view. Getting this backwards is the obvious bug
 * and it is why there is a test named after it.
 */
export function stepFov(current, direction) {
  const base = clampFov(current);
  return clampFov(direction > 0 ? base - FOV_STEP : base + FOV_STEP);
}

/**
 * How far the picture may be panned, as a fraction of the element box, so
 * the user cannot drag the image completely out of view.
 *
 * At zoom 1 there is nothing hidden, so no pan is allowed at all — this is
 * what stops a stray drag from sliding an un-zoomed video off screen.
 */
export function maxPanFraction(viewZoom) {
  const z = clampViewZoom(viewZoom);
  return Math.max(0, (z - 1) / (2 * z));
}

export function clampPan(pan, viewZoom) {
  const limit = maxPanFraction(viewZoom);
  const v = Number.isFinite(pan) ? pan : 0;
  return Math.min(limit, Math.max(-limit, v));
}

/**
 * Fold a zoom gesture into a vrFormat entry, returning ONLY the changed
 * fields. Returns null when nothing would change, so callers can skip a
 * persist + repaint on every no-op notch at the limit.
 *
 * @param {object|null} entry       current `library.vrFormat[path]` entry
 * @param {string|null} projection  active projection
 * @param {number} direction        +1 in, -1 out
 */
export function applyZoomStep(entry, projection, direction) {
  if (isSpherical(projection)) {
    const cur = clampFov(entry?.fov);
    const next = stepFov(cur, direction);
    return next === cur ? null : { fov: next };
  }
  const cur = clampViewZoom(entry?.viewZoom);
  const next = stepViewZoom(cur, direction);
  if (next === cur) return null;
  // Zooming back out must drag the pan back inside the shrinking limit,
  // or the picture stays lopsided at zoom 1 with no way to recentre.
  return {
    viewZoom: next,
    panX: clampPan(entry?.panX, next),
    panY: clampPan(entry?.panY, next),
  };
}

/** Reset fields for Ctrl+0. Spherical resets the angle, planar the scale. */
export function resetZoomFields(projection) {
  return isSpherical(projection)
    ? { fov: 90 }
    : { viewZoom: 1, panX: 0, panY: 0 };
}

/**
 * Pan delta in pixels → new clamped pan fractions.
 *
 * Divided by the element box so a drag tracks the cursor at zoom 1:1
 * regardless of window size.
 */
export function applyPanDelta(entry, dxPx, dyPx, boxW, boxH) {
  const z = clampViewZoom(entry?.viewZoom);
  if (z <= 1) return null;              // nothing hidden, nothing to pan
  if (!(boxW > 0) || !(boxH > 0)) return null;
  const panX = clampPan((entry?.panX || 0) + dxPx / boxW, z);
  const panY = clampPan((entry?.panY || 0) + dyPx / boxH, z);
  if (panX === (entry?.panX || 0) && panY === (entry?.panY || 0)) return null;
  return { panX, panY };
}

/**
 * Direction from a wheel event. Trackpad pinch and Ctrl+scroll both arrive
 * here; `deltaY < 0` is "away from the user" / "pinch open" = zoom in.
 */
export function wheelDirection(deltaY) {
  return deltaY < 0 ? 1 : -1;
}
