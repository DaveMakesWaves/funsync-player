/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The pure maths behind the simulator's other axes and "Align to the video"
// (editor work list 2.5 / 5.4, 2026-11-24): renderer/js/sim-axes.js and
// renderer/js/sim-align.js. The ranges and directions are OFS's
// (OFS_Simulator3D's Simulator3D.cs, SIM_MOTION), so people moving from OFS
// see the same motion.
import { describe, it, expect } from 'vitest';
import {
  sampleAxis, sampleAxisInto, collectSimAxes, axisSourceFrom, isCentredAxis, simPose, poseApply, projectReceiver,
  heatRgbInto, SIM_AXIS_ORDER, SIM_MOTION,
} from '../../renderer/js/sim-axes.js';
import { heatmapSpeedToColor } from '../../renderer/js/heatmap-palette.js';
import {
  resolveSimAlign, videoContentRect, intersectRect, toVideoFraction, fromVideoFraction, alignedGeometry, translateAlign,
} from '../../renderer/js/sim-align.js';

const pts = [{ at: 1000, pos: 0 }, { at: 2000, pos: 100 }, { at: 3000, pos: 40 }];
const DEG = Math.PI / 180;

describe('sampleAxis: the position at a time, as the stroke is interpolated', () => {
  it('linear between points, the first before, the last after, with the stretch speed', () => {
    expect(sampleAxis(pts, 1500)).toEqual({ pos: 50, speed: 0.1 });
    expect(sampleAxis(pts, 2500)).toEqual({ pos: 70, speed: 0.06 });
    expect(sampleAxis(pts, 0)).toEqual({ pos: 0, speed: 0 });
    expect(sampleAxis(pts, 9000)).toEqual({ pos: 40, speed: 0 });
    expect(sampleAxis([{ at: 5, pos: 77 }], 1)).toEqual({ pos: 77, speed: 0 });
  });
  it('no points or no time is no sample; a junk position rests at 50', () => {
    expect(sampleAxis([], 10)).toBeNull();
    expect(sampleAxis(null, 10)).toBeNull();
    expect(sampleAxis(pts, NaN)).toBeNull();
    expect(sampleAxis([{ at: 0, pos: 'x' }], 0).pos).toBe(50);
  });
  it('the per-frame form writes into the arrays it is given', () => {
    const pos = new Float64Array(3);
    const spd = new Float64Array(3);
    expect(sampleAxisInto(pts, 1500, pos, spd, 2)).toBe(true);
    expect([pos[2], spd[2]]).toEqual([50, 0.1]);
    expect(sampleAxisInto([], 1500, pos, spd, 0)).toBe(false);
  });
});

describe('which axes a video has', () => {
  it('asks once per axis, in the AXIS_DEFINITIONS order, and keeps the ones with points', () => {
    const asked = [];
    const got = collectSimAxes((s) => { asked.push(s); return s === 'twist' || s === 'vib' ? pts : (s === 'roll' ? [] : null); });
    expect(asked).toEqual([...SIM_AXIS_ORDER]);
    expect(got.map((a) => a.suffix)).toEqual(['twist', 'vib']);
  });
  it('a source that throws has no axes; fixed data answers under any spelling', () => {
    expect(collectSimAxes(() => { throw new Error('x'); })).toEqual([]);
    const source = axisSourceFrom({ R0: pts, vibe: pts, suction: pts });
    expect(collectSimAxes(source).map((a) => a.suffix)).toEqual(['twist', 'vib', 'suck']);
    expect(isCentredAxis('R1')).toBe(true);
    expect(isCentredAxis('pump')).toBe(false);
  });
});

describe('the pose: OFS\'s ranges and directions (SIM_MOTION)', () => {
  it('50 everywhere is the rest; 0 and 100 are the ends of each OFS range', () => {
    const rest = simPose({}, 50);
    for (const k of ['x', 'y', 'z', 'pitch', 'roll', 'twist']) expect(rest[k]).toBeCloseTo(0, 12);
    const lo = simPose({ surge: 0, sway: 0, twist: 0, roll: 0, pitch: 0 }, 0);
    const hi = simPose({ surge: 100, sway: 100, twist: 100, roll: 100, pitch: 100 }, 100);
    expect([lo.y, hi.y]).toEqual([...SIM_MOTION.STROKE_Y]);
    expect([lo.x, hi.x]).toEqual([...SIM_MOTION.SURGE_X]);
    expect([lo.z, hi.z]).toEqual([...SIM_MOTION.SWAY_Z]);          // reversed: 100 = away
    expect(lo.pitch / DEG).toBeCloseTo(45, 9);
    expect(hi.pitch / DEG).toBeCloseTo(-45, 9);
    expect(lo.roll / DEG).toBeCloseTo(-45, 9);
    expect(hi.roll / DEG).toBeCloseTo(45, 9);
    expect(lo.twist / DEG).toBeCloseTo(-120, 9);
    expect(hi.twist / DEG).toBeCloseTo(120, 9);
  });
  it('roll 100 leans the top to the right; pitch 0 leans it toward the camera; twist 100 turns the front to the right', () => {
    const top = (values) => poseApply(simPose(values, 50), 0, 1, 0, {}, 1, 1, false);
    expect(top({ roll: 100 }).x).toBeGreaterThan(0.6);
    expect(top({ roll: 0 }).x).toBeLessThan(-0.6);
    expect(top({ pitch: 0 }).z).toBeGreaterThan(0.6);
    expect(top({ pitch: 100 }).z).toBeLessThan(-0.6);
    const front = poseApply(simPose({ twist: 100 }, 50), 0, 0, 1, {}, 1, 1, false);
    expect(front.x).toBeGreaterThan(0.8);   // sin 120°
  });
  it('the offsets move it, scaled to the look\'s own model', () => {
    const p = poseApply(simPose({ surge: 100 }, 100), 0, 0, 0, {}, 2, 3);
    expect(p.x).toBeCloseTo(1, 12);
    expect(p.y).toBeCloseTo(3, 12);
    expect(p.z).toBeCloseTo(0, 12);
  });
});

describe('the line drawing (the "Drawing and numbers" look)', () => {
  const tilt = (g) => (g.topCentre.x - g.bottomCentre.x);
  it('roll 100 tilts the top to the right of rest, roll 0 to the left', () => {
    const rest = tilt(projectReceiver(simPose({}, 50)));
    expect(tilt(projectReceiver(simPose({ roll: 100 }, 50)))).toBeGreaterThan(rest);
    expect(tilt(projectReceiver(simPose({ roll: 0 }, 50)))).toBeLessThan(rest);
  });
  it('the stroke moves it up the screen (canvas y down); surge 100 moves it right', () => {
    const y = (stroke) => projectReceiver(simPose({}, stroke)).topCentre.y;
    expect(y(100)).toBeLessThan(y(0));
    const x = (surge) => projectReceiver(simPose({ surge }, 50)).topCentre.x;
    expect(x(100)).toBeGreaterThan(x(0));
  });
  it('twist moves only the dot on the top ring: the outline stays put', () => {
    const a = projectReceiver(simPose({ twist: 50 }, 50));
    const b = projectReceiver(simPose({ twist: 100 }, 50));
    expect(Math.hypot(b.marker.x - a.marker.x, b.marker.y - a.marker.y)).toBeGreaterThan(0.1);
    expect(b.topCentre.x).toBeCloseTo(a.topCentre.x, 9);
    expect(b.sides).toHaveLength(2);
  });
});

describe('the speed colours as numbers (the 3D receiver shades them)', () => {
  it('match the heatmap palette at every speed', () => {
    const out = [0, 0, 0];
    for (let s = 0; s <= 0.6; s += 0.013) {
      heatRgbInto(s, out);
      expect(`rgb(${out[0]}, ${out[1]}, ${out[2]})`).toBe(heatmapSpeedToColor(s));
    }
  });
});

describe('Align to the video: the stored line', () => {
  it('two points on the picture, or nothing', () => {
    expect(resolveSimAlign({ tip: { x: 0.5, y: 0.2 }, base: { x: 0.4, y: 0.8 } })).toEqual({ tip: { x: 0.5, y: 0.2 }, base: { x: 0.4, y: 0.8 } });
    expect(resolveSimAlign({ tip: { x: 2, y: -1 }, base: { x: 0.4, y: 0.8 } }).tip).toEqual({ x: 1, y: 0 });
    expect(resolveSimAlign({ tip: { x: 0.5, y: 0.5 }, base: { x: 0.5, y: 0.5 } })).toBeNull();
    expect(resolveSimAlign({ tip: { x: 'a', y: 0 } })).toBeNull();
    expect(resolveSimAlign(null)).toBeNull();
  });
  it('the picture inside the <video> box: letterboxed for contain, the box for fill, overflowing for cover', () => {
    const box = { left: 0, top: 0, width: 1000, height: 1000 };
    const contain = videoContentRect(box, 1920, 1080, 'contain');
    expect(contain.left).toBeCloseTo(0, 6);
    expect(contain.top).toBeCloseTo(218.75, 6);
    expect(contain.width).toBeCloseTo(1000, 6);
    expect(contain.height).toBeCloseTo(562.5, 6);
    expect(videoContentRect(box, 1920, 1080, 'fill')).toEqual(box);
    expect(videoContentRect(box, 1920, 1080, 'cover').height).toBe(1000);
    expect(videoContentRect({ ...box, width: 0 }, 1920, 1080)).toBeNull();
    expect(intersectRect({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 0, width: 5, height: 5 })).toBeNull();
  });
  it('the bar: centre on the middle, length of the line, 0° with the tip straight above the base, 90° to its right', () => {
    const rect = { left: 100, top: 50, width: 800, height: 450 };
    const up = alignedGeometry({ tip: { x: 0.5, y: 0.2 }, base: { x: 0.5, y: 0.6 } }, rect);
    expect(up).toEqual({ cx: 500, cy: 230, length: 180, rotation: 0 });
    const right = alignedGeometry({ tip: { x: 0.75, y: 0.5 }, base: { x: 0.25, y: 0.5 } }, rect);
    expect(right.rotation).toBe(90);
    expect(right.length).toBe(400);
    // A resize keeps the same spot of the picture.
    const p = toVideoFraction(rect, 300, 200);
    expect(fromVideoFraction({ left: 0, top: 0, width: 1600, height: 900 }, p)).toEqual({ x: 400, y: 300 });
  });
  it('a drag moves the line, stopping at the picture\'s edge without bending it', () => {
    const a = { tip: { x: 0.8, y: 0.2 }, base: { x: 0.7, y: 0.6 } };
    const moved = translateAlign(a, 0.5, 0);
    expect(moved.tip.x).toBeCloseTo(1, 9);
    expect(moved.base.x).toBeCloseTo(0.9, 9);
    expect(moved.tip.y).toBe(0.2);
  });
});
