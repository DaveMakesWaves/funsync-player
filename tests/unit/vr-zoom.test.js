/**
 * @vitest-environment node
 * Pure maths — no DOM. See notes/CLAUDE.md "Test environments".
 */
// terijapl, #284: "i'd also throw in zooming in/out if it's possible".
//
// The trap this module exists to avoid: the VR Format panel already had a
// "Zoom" slider, but CSS multiplied it into a ONE-AXIS un-squash
// (`scaleX(calc(2 * var(--vr-flatten-zoom)))`), so raising it stretches a
// normally-packed SBS video horizontally instead of magnifying it. That
// control is a packing-ratio correction, not a viewer zoom. `viewZoom` is
// the real one and is uniform.
import { describe, it, expect } from 'vitest';
import {
  isSpherical, clampViewZoom, clampFov, stepViewZoom, stepFov,
  maxPanFraction, clampPan, applyZoomStep, resetZoomFields, applyPanDelta,
  wheelDirection, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX, FOV_MIN, FOV_MAX,
} from '../../renderer/js/vr-zoom.js';

describe('projection classification', () => {
  it('treats the shipped spherical projections as spherical', () => {
    expect(isSpherical('equirect-180')).toBe(true);
    expect(isSpherical('fisheye-180')).toBe(true);
  });

  it('treats planar packings and absence as not spherical', () => {
    for (const p of ['sbs-half', 'sbs-full', 'tb-half', 'tb-full', 'flat', null, undefined]) {
      expect(isSpherical(p), `${p} should not be spherical`).toBe(false);
    }
  });
});

describe('view zoom stepping', () => {
  it('zooms in and out', () => {
    expect(stepViewZoom(1, 1)).toBeGreaterThan(1);
    expect(stepViewZoom(2, -1)).toBeLessThan(2);
  });

  it('never goes below fit or above the ceiling', () => {
    expect(stepViewZoom(1, -1)).toBe(VIEW_ZOOM_MIN);
    let z = 1;
    for (let i = 0; i < 100; i++) z = stepViewZoom(z, 1);
    expect(z).toBe(VIEW_ZOOM_MAX);
  });

  it('is reversible, so a scroll up then down returns to where it started', () => {
    const z = stepViewZoom(stepViewZoom(2, 1), -1);
    expect(z).toBeCloseTo(2, 10);
  });

  it('clamps junk to fit rather than producing NaN', () => {
    for (const bad of [undefined, null, NaN, 'x', {}]) {
      expect(clampViewZoom(bad)).toBe(VIEW_ZOOM_MIN);
    }
  });
});

describe('FOV stepping', () => {
  // THE bug worth a named test: on a projected sphere, zooming IN means a
  // NARROWER field of view. Getting the sign backwards is the obvious slip
  // and it feels inverted rather than broken, so it would ship.
  it('zooming in NARROWS the field of view', () => {
    expect(stepFov(90, 1)).toBeLessThan(90);
    expect(stepFov(90, -1)).toBeGreaterThan(90);
  });

  it('respects both ends', () => {
    expect(stepFov(FOV_MIN, 1)).toBe(FOV_MIN);
    expect(stepFov(FOV_MAX, -1)).toBe(FOV_MAX);
  });

  it('defaults junk to 90 degrees', () => {
    expect(clampFov(undefined)).toBe(90);
  });
});

describe('pan limits', () => {
  it('allows no pan at all when nothing is hidden', () => {
    expect(maxPanFraction(1)).toBe(0);
    expect(clampPan(0.5, 1)).toBe(0);
  });

  it('allows more pan the further you zoom in', () => {
    expect(maxPanFraction(2)).toBeGreaterThan(maxPanFraction(1.5));
  });

  it('clamps symmetrically', () => {
    const lim = maxPanFraction(2);
    expect(clampPan(99, 2)).toBe(lim);
    expect(clampPan(-99, 2)).toBe(-lim);
  });
});

describe('applyZoomStep', () => {
  it('drives FOV for spherical and viewZoom for planar', () => {
    expect(applyZoomStep({ fov: 90 }, 'equirect-180', 1)).toHaveProperty('fov');
    expect(applyZoomStep({ viewZoom: 1 }, 'sbs-half', 1)).toHaveProperty('viewZoom');
  });

  it('never touches the packing correction', () => {
    // `zoom` is the one-axis packing field. A viewer gesture must not
    // change it, or zooming would distort the picture — the whole reason
    // this module exists as something separate.
    const out = applyZoomStep({ zoom: 1.4, viewZoom: 1 }, 'sbs-half', 1);
    expect(out).not.toHaveProperty('zoom');
  });

  it('returns null at the limit so callers skip a pointless write', () => {
    expect(applyZoomStep({ viewZoom: VIEW_ZOOM_MAX }, 'sbs-half', 1)).toBeNull();
    expect(applyZoomStep({ viewZoom: 1 }, 'sbs-half', -1)).toBeNull();
    expect(applyZoomStep({ fov: FOV_MIN }, 'equirect-180', 1)).toBeNull();
  });

  // Zooming out must pull an off-centre pan back inside the shrinking
  // limit, else you land at zoom 1 lopsided with no way to recentre.
  it('drags pan back inside the limit as you zoom out', () => {
    const zoomed = { viewZoom: 3, panX: maxPanFraction(3), panY: 0 };
    const out = applyZoomStep(zoomed, 'sbs-half', -1);
    expect(Math.abs(out.panX)).toBeLessThanOrEqual(maxPanFraction(out.viewZoom) + 1e-9);
  });

  it('handles a missing entry as fit', () => {
    expect(applyZoomStep(null, 'sbs-half', 1).viewZoom).toBeGreaterThan(1);
    expect(applyZoomStep(undefined, 'sbs-half', -1)).toBeNull();
  });
});

describe('resetZoomFields', () => {
  it('resets the angle for spherical and the scale for planar', () => {
    expect(resetZoomFields('equirect-180')).toEqual({ fov: 90 });
    expect(resetZoomFields('sbs-half')).toEqual({ viewZoom: 1, panX: 0, panY: 0 });
  });
});

describe('applyPanDelta', () => {
  it('refuses to pan when nothing is hidden', () => {
    expect(applyPanDelta({ viewZoom: 1 }, 50, 50, 800, 450)).toBeNull();
  });

  it('tracks the drag as a fraction of the box', () => {
    const out = applyPanDelta({ viewZoom: 3, panX: 0, panY: 0 }, 80, 45, 800, 450);
    expect(out.panX).toBeCloseTo(0.1, 6);
    expect(out.panY).toBeCloseTo(0.1, 6);
  });

  it('stops at the limit instead of running away', () => {
    const out = applyPanDelta({ viewZoom: 2, panX: 0, panY: 0 }, 99999, 0, 800, 450);
    expect(out.panX).toBe(maxPanFraction(2));
  });

  it('survives a zero-sized box rather than dividing by zero', () => {
    expect(applyPanDelta({ viewZoom: 2 }, 10, 10, 0, 0)).toBeNull();
  });
});

describe('wheelDirection', () => {
  // Trackpad pinch and Ctrl+scroll are the SAME event; this is the only
  // place the two are distinguished from each other, i.e. nowhere.
  it('reads scroll-up / pinch-open as zoom in', () => {
    expect(wheelDirection(-120)).toBe(1);
    expect(wheelDirection(120)).toBe(-1);
  });
});
