// Pure-JS mirrors of the GLSL projection math.
//
// Since jsdom can't run real shaders, we verify the algorithm by
// implementing it in plain JS and asserting on known points (centre
// pixel, edges, etc.). The GLSL and JS versions live separately —
// they're only kept in sync by code review, but the math is small and
// the tests pin down the contract that the JS mirror MUST hold:
//
//   1. Centre pixel maps to the forward direction in world space.
//   2. Applying yaw + pitch rotates the centre direction correctly.
//   3. Equirect-180 longitude is clipped at ±π/2; rotating yaw +90°
//      moves the centre to longitude +π/2 (edge of visible frame).
//   4. Fisheye-180 maps the centre pixel to (u=0.5, v=0.5) at FOV=180°.

import { describe, it, expect } from 'vitest';
import { VRProjectionRenderer } from '../../renderer/js/vr-projection-renderer.js';

// Mirror of the GLSL viewing-direction computation in both shaders.
function rotateDir(dir, yawRad, pitchRad) {
  const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
  const r1 = {
    x: dir.x * cy + dir.z * sy,
    y: dir.y,
    z: -dir.x * sy + dir.z * cy,
  };
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
  return {
    x: r1.x,
    y: r1.y * cp - r1.z * sp,
    z: r1.y * sp + r1.z * cp,
  };
}

// Equirect lookup (lon/lat → uv). Mirrors equirect.frag.js for the
// VR180 path.
function equirectLookup(dir, { lonRange = Math.PI, stereoMode = 0, eye = 0 } = {}) {
  const lon = Math.atan2(dir.x, dir.z);
  const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  if (lonRange < Math.PI * 2 && Math.abs(lon) > Math.PI * 0.5) return null; // outside VR180 frame
  let u = (lon / lonRange) + 0.5;
  let v = (lat / Math.PI) + 0.5;
  if (stereoMode === 1) u = u * 0.5 + (eye === 1 ? 0.5 : 0);
  else if (stereoMode === 2) v = v * 0.5 + (eye === 1 ? 0 : 0.5);
  return { u, v };
}

// Fisheye lookup. Mirrors fisheye.frag.js for the angular-fisheye path.
function fisheyeLookup(dir, { sourceFov = Math.PI, stereoMode = 0, eye = 0 } = {}) {
  if (dir.z <= 0) return null; // behind
  const theta = Math.acos(Math.max(-1, Math.min(1, dir.z)));
  const r = theta / (sourceFov * 0.5);
  if (r > 1) return null;
  const len = Math.hypot(dir.x, dir.y);
  const ux = len > 1e-6 ? dir.x / len : 0;
  const uy = len > 1e-6 ? dir.y / len : 0;
  let cx = 0.5, ru = 0.5;
  if (stereoMode === 1) {
    ru = 0.25;
    cx = eye === 1 ? 0.75 : 0.25;
  }
  return { u: cx + r * ux * ru, v: 0.5 - r * uy * 0.5 };
}

describe('Viewing direction rotation (centre pixel)', () => {
  it('no rotation: centre maps to forward (+Z)', () => {
    const d = rotateDir({ x: 0, y: 0, z: 1 }, 0, 0);
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(0);
    expect(d.z).toBeCloseTo(1);
  });

  it('yaw +90° rotates forward to +X', () => {
    const d = rotateDir({ x: 0, y: 0, z: 1 }, Math.PI / 2, 0);
    expect(d.x).toBeCloseTo(1);
    expect(d.z).toBeCloseTo(0);
  });

  it('pitch +45° tips forward toward -Y (look down)', () => {
    const d = rotateDir({ x: 0, y: 0, z: 1 }, 0, Math.PI / 4);
    // After +pitch around X: y = sin(-pitch) (camera looking down).
    // Our convention: pitch rotates around X with cos/sin where
    // looking down corresponds to dy < 0 — matches GLSL.
    expect(d.y).toBeCloseTo(-Math.sin(Math.PI / 4));
    expect(d.z).toBeCloseTo(Math.cos(Math.PI / 4));
  });

  it('VRProjectionRenderer.computeCenterDirection mirrors the test math', () => {
    const r = new VRProjectionRenderer();
    r.setYawPitch(0, 0);
    expect(r.computeCenterDirection()).toEqual({ x: 0, y: 0, z: 1 });
    r.setYawPitch(90, 0);
    const d = r.computeCenterDirection();
    expect(d.x).toBeCloseTo(1);
    expect(d.z).toBeCloseTo(0);
  });
});

describe('Equirect-180 lookup', () => {
  it('centre direction maps to (0.5, 0.5) — texture middle', () => {
    const uv = equirectLookup({ x: 0, y: 0, z: 1 });
    expect(uv).not.toBeNull();
    expect(uv.u).toBeCloseTo(0.5);
    expect(uv.v).toBeCloseTo(0.5);
  });

  it('±π/2 yaw lies on the longitude boundary; +π/2 + ε is outside', () => {
    // At yaw exactly +π/2, longitude = +π/2 → just inside.
    const inEdge = equirectLookup({ x: 1, y: 0, z: 0 });
    expect(inEdge).not.toBeNull();
    expect(inEdge.u).toBeCloseTo(1.0, 1);

    // Slightly past the edge → outside the VR180 frame.
    const outside = equirectLookup({ x: 1, y: 0, z: -0.01 });
    expect(outside).toBeNull();
  });

  it('SBS-half: left eye samples u ∈ [0, 0.5]', () => {
    const uv = equirectLookup({ x: 0, y: 0, z: 1 }, { stereoMode: 1, eye: 0 });
    expect(uv.u).toBeGreaterThanOrEqual(0);
    expect(uv.u).toBeLessThanOrEqual(0.5);
  });

  it('SBS-half: right eye samples u ∈ [0.5, 1]', () => {
    const uv = equirectLookup({ x: 0, y: 0, z: 1 }, { stereoMode: 1, eye: 1 });
    expect(uv.u).toBeGreaterThanOrEqual(0.5);
    expect(uv.u).toBeLessThanOrEqual(1.0);
  });
});

describe('Fisheye-180 lookup', () => {
  it('centre direction → texture centre (0.5, 0.5) in mono', () => {
    const uv = fisheyeLookup({ x: 0, y: 0, z: 1 });
    expect(uv).not.toBeNull();
    expect(uv.u).toBeCloseTo(0.5);
    expect(uv.v).toBeCloseTo(0.5);
  });

  it('backwards direction returns null (outside source frame)', () => {
    const uv = fisheyeLookup({ x: 0, y: 0, z: -1 });
    expect(uv).toBeNull();
  });

  it('edge of FOV (θ = π/2) maps to r = 1 — boundary of circle', () => {
    // Direction pointing straight up (y=1) — angle from forward = π/2.
    const uv = fisheyeLookup({ x: 0, y: 1, z: 0.0001 });
    // r ≈ 1.0 → on the circle edge; u stays at 0.5 (because dir.x=0).
    expect(uv).not.toBeNull();
    expect(uv.u).toBeCloseTo(0.5);
    // v = 0.5 - 1 * 0.5 = 0  (top of texture because we flip Y)
    expect(uv.v).toBeLessThan(0.01);
  });

  it('SBS-half: left eye centre is at u ≈ 0.25, right eye at u ≈ 0.75', () => {
    const left = fisheyeLookup({ x: 0, y: 0, z: 1 }, { stereoMode: 1, eye: 0 });
    const right = fisheyeLookup({ x: 0, y: 0, z: 1 }, { stereoMode: 1, eye: 1 });
    expect(left.u).toBeCloseTo(0.25);
    expect(right.u).toBeCloseTo(0.75);
  });
});

describe('Yaw + lookup composition', () => {
  it('equirect: centre + yaw 45° lands at u = 0.5 + 45/180 = 0.75', () => {
    const dir = rotateDir({ x: 0, y: 0, z: 1 }, Math.PI / 4, 0);
    const uv = equirectLookup(dir);
    expect(uv).not.toBeNull();
    expect(uv.u).toBeCloseTo(0.75);
  });

  it('equirect: pitch 45° lands at v = 0.5 - 0.25 = 0.25 (look down)', () => {
    const dir = rotateDir({ x: 0, y: 0, z: 1 }, 0, Math.PI / 4);
    const uv = equirectLookup(dir);
    expect(uv).not.toBeNull();
    expect(uv.v).toBeCloseTo(0.25);
  });
});
