/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The 3D receiver (editor work list 2.5, 2026-11-24; Dave: "option D as the
// default", then OFS's look: a sleeve with two cubes on its sides,
// renderer/js/sim-receiver-3d.js). Asserted on what it draws: the faces it
// keeps and their order, which cubes face the camera from each view, that
// every extreme stays on the canvas, what a stroke moves, the theme colours,
// the views and the orbit, and that the base slab is drawn once per view.
import { describe, it, expect } from 'vitest';
import {
  Receiver3D, SIM3D_VIEWS, SIM3D_SIZES, SIM3D_MARKERS, SIM3D_TILT_LIMITS, SIM_LOOKS,
  resolveView3d, orbitView, resolveSimLook, parseCssColour, sleeveColourFor,
} from '../../renderer/js/sim-receiver-3d.js';

/** A canvas context that records what is drawn. */
function recordingCtx() {
  const calls = [];
  const fills = [];
  const grad = () => ({ addColorStop() {} });
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad();
      if (prop === 'fill') return () => { fills.push(target.fillStyle); calls.push('fill'); };
      return (...args) => { calls.push(prop); return args; };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, calls, fills };
}

const RIGHT = 0; // SIM3D_MARKERS[0] is the right-hand cube (angle 90)
const LEFT = 1;

describe('the receiver\'s pose and what the stroke moves', () => {
  it('a stroke-only video moves it up and down only', () => {
    const r = new Receiver3D();
    r.setView(SIM3D_VIEWS.front);
    r.setPose({}, 0);
    const low = r.centre();
    r.setPose({}, 100);
    const high = r.centre();
    expect(high.y).toBeLessThan(low.y - 40);       // up the canvas
    expect(high.x).toBeCloseTo(low.x, 6);           // not sideways
  });
  it('surge 100 moves it right in the front view (OFS: x); sway 100 away from the camera (smaller)', () => {
    const r = new Receiver3D();
    r.setView(SIM3D_VIEWS.front);
    r.setPose({}, 50);
    const rest = r.receiverBounds();
    r.setPose({ surge: 100 }, 50);
    expect(r.centre().x).toBeGreaterThan(rest.minX + (rest.maxX - rest.minX) / 2 + 10);
    r.setPose({ sway: 100 }, 50);
    const away = r.receiverBounds();
    r.setPose({ sway: 0 }, 50);
    const near = r.receiverBounds();
    expect(away.maxX - away.minX).toBeLessThan(near.maxX - near.minX);
  });
});

describe('the cubes on its sides (OFS\'s two "Twist" cubes)', () => {
  it('there are two, left and right, at mid-height, half a radius across', () => {
    expect(SIM3D_MARKERS.map((m) => m.angle)).toEqual([90, 270]);
    expect(SIM3D_MARKERS.every((m) => m.y === 0 && m.size === 0.5)).toBe(true);
  });
  it('from the side the right cube faces the camera and the left is culled; from the front neither outer face does', () => {
    const r = new Receiver3D();
    r.setView(SIM3D_VIEWS.side);
    r.setPose({}, 50);
    expect(r.markerFacing(RIGHT)).toBe(true);
    expect(r.markerFacing(LEFT)).toBe(false);
    r.setView(SIM3D_VIEWS.front);
    expect(r.markerFacing(RIGHT)).toBe(false);
    expect(r.markerFacing(LEFT)).toBe(false);
    expect(r.drawnFaces().markers).toBeGreaterThan(0);   // their front faces still show
  });
  it('twist turns them: at twist 100 (the front 120° to the right) the left cube faces a front camera', () => {
    const r = new Receiver3D();
    r.setView(SIM3D_VIEWS.front);
    r.setPose({ twist: 100 }, 50);
    expect(r.markerFacing(LEFT)).toBe(true);
    expect(r.markerFacing(RIGHT)).toBe(false);
    r.setPose({ twist: 0 }, 50);
    expect(r.markerFacing(RIGHT)).toBe(true);
  });
  it('back faces are culled: about half the sleeve is drawn, far to near', () => {
    const r = new Receiver3D();
    for (const v of Object.values(SIM3D_VIEWS)) {
      r.setView(v);
      r.setPose({ twist: 30, roll: 70, pitch: 20 }, 60);
      const { facets, ends } = r.drawnFaces();
      expect(facets).toBeGreaterThan(12);
      expect(facets).toBeLessThan(r.N - 10);
      expect(ends).toBeLessThanOrEqual(1);
      for (let i = 1; i < r._count; i++) expect(r._depth[i]).toBeGreaterThanOrEqual(r._depth[i - 1]);
    }
  });
});

describe('it stays on the canvas', () => {
  it('at every extreme of every axis, in every view, at both sizes', () => {
    const r = new Receiver3D();
    const ends = [0, 100];
    for (const size of Object.keys(SIM3D_SIZES)) {
      r.setSize(size);
      for (const view of Object.values(SIM3D_VIEWS)) {
        r.setView(view);
        for (const stroke of ends) for (const surge of ends) for (const sway of ends) for (const twist of [0, 50, 100]) for (const roll of ends) for (const pitch of ends) {
          r.setPose({ surge, sway, twist, roll, pitch }, stroke);
          const b = r.receiverBounds();
          expect(b.minX).toBeGreaterThanOrEqual(0);
          expect(b.minY).toBeGreaterThanOrEqual(0);
          expect(b.maxX).toBeLessThanOrEqual(r.W);
          expect(b.maxY).toBeLessThanOrEqual(r.H);
        }
      }
    }
  });
});

describe('drawing', () => {
  it('draws the slab, shadow, rail and faces; the cubes in the accent, the sleeve in its colour (no front notch since 2026-11-25)', () => {
    const r = new Receiver3D();
    r.setView(SIM3D_VIEWS.quarter);
    r.setPose({ twist: 70 }, 50);
    const { ctx, calls, fills } = recordingCtx();
    r.draw(ctx, { sleeve: [255, 255, 255], accent: [233, 69, 96], dpr: 1 });
    expect(calls[0]).toBe('clearRect');
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThan(20);
    // Flat-shaded cube faces: shades of the accent's hue only.
    const accentShades = fills.filter((f) => typeof f === 'string' && /^rgb\(/.test(f)).map((f) => f.match(/\d+/g).map(Number))
      .filter(([r0, g, b]) => r0 > g && Math.abs(g - (b * 69) / 96) < 30 && r0 !== g);
    expect(accentShades.length).toBeGreaterThan(0);
  });
  // Dave, 2026-11-25: the red mark on the base "looks like it actually faces
  // the opposite way". It sat on the device's right side (by Surge / Forward
  // and Sway / Left); no edge is the front for every axis in OFS's motion, so
  // the base carries no mark at all now.
  it('the base has no front mark: nothing on it is stroked in the accent', () => {
    const r = new Receiver3D();
    const strokes = [];
    const ctx = new Proxy({}, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (prop === 'stroke') return () => { strokes.push(String(target.strokeStyle)); };
        return () => {};
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
    r._drawBase(ctx);
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.filter((c) => c.replace(/\s/g, '') === 'rgb(233,69,96)')).toEqual([]);
  });
  it('the base slab is drawn once per view into its cache, then copied', () => {
    let made = 0;
    const cacheCtx = recordingCtx().ctx;
    const r = new Receiver3D({ makeCanvas: () => { made++; return { width: 0, height: 0, getContext: () => cacheCtx }; } });
    const { ctx, calls } = recordingCtx();
    r.setPose({}, 10);
    r.draw(ctx);
    r.setPose({}, 90);
    r.draw(ctx);
    expect(made).toBe(1);
    expect(r.baseDraws).toBe(1);
    expect(calls.filter((c) => c === 'drawImage')).toHaveLength(2);
    r.setView(SIM3D_VIEWS.side);
    r.draw(ctx);
    expect(r.baseDraws).toBe(2);
  });
});

describe('colours from the theme', () => {
  it('reads #rgb, #rrggbb and rgb()', () => {
    expect(parseCssColour(' #1c2a4a ')).toEqual([28, 42, 74]);
    expect(parseCssColour('#fff')).toEqual([255, 255, 255]);
    expect(parseCssColour('rgb(226, 63, 85)')).toEqual([226, 63, 85]);
    expect(parseCssColour('var(--x)')).toBeNull();
  });
  it('a dark sleeve (navy, Holiday green) is lifted toward white; a light one is as it is', () => {
    const navy = sleeveColourFor([28, 42, 74]);
    expect(navy[0]).toBeGreaterThan(28);
    expect(navy[2]).toBeGreaterThan(74);
    expect(navy[2]).toBeLessThan(140);
    expect(sleeveColourFor([255, 255, 255])).toEqual([255, 255, 255]);
  });
});

describe('looks, views and the orbit', () => {
  it('the look defaults to 3D, 150 px, three-quarter; junk falls back; a dragged width is held to its limits', () => {
    expect(SIM_LOOKS).toEqual(['3d', 'drawing', 'bars', 'gauges']);
    expect(resolveSimLook({})).toEqual({ look: '3d', size: 150, view: { ...SIM3D_VIEWS.quarter, preset: 'quarter' } });
    expect(resolveSimLook({ look: 'bars', size: 'large', view: 'side' })).toMatchObject({ look: 'bars', size: 230, view: { preset: 'side' } });
    expect(resolveSimLook({ look: 'neon', size: 9, view: { yaw: 'x' } })).toMatchObject({ look: '3d', size: 100 });
    expect(resolveSimLook({ size: 999 }).size).toBe(420);
    expect(resolveSimLook({ size: 'small' }).size).toBe(150);
    expect(resolveSimLook({ size: null }).size).toBe(150);
  });
  it('a saved orbit is kept, held to the tilt limits; one equal to a preset ticks it', () => {
    expect(resolveView3d({ yaw: 400, tilt: 120 })).toEqual({ yaw: 40, tilt: SIM3D_TILT_LIMITS.max, preset: null });
    expect(resolveView3d({ yaw: 0, tilt: 6 }).preset).toBe('front');
  });
  it('dragging across turns it, up and down tilts it, never past the limits', () => {
    const v = orbitView(SIM3D_VIEWS.quarter, 100, 0);
    expect(v.yaw).toBeCloseTo(-35 + 100 * 0.012 * 180 / Math.PI, 0);
    expect(v.tilt).toBe(22);
    expect(orbitView(SIM3D_VIEWS.quarter, 0, 10000).tilt).toBe(SIM3D_TILT_LIMITS.max);
    expect(orbitView(SIM3D_VIEWS.quarter, 0, -10000).tilt).toBe(SIM3D_TILT_LIMITS.min);
  });
});
