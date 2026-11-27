// What the phone's Flat view (#426, 2026-11-22) is told about a video's VR
// format: the desktop's saved spherical projection (VR Format: Equirectangular
// 180 or Fisheye 180), its eye and its view (field of view, look-around,
// roll), so the phone opens the flat view as the desktop shows it. A planar
// or "not VR" entry, or none, sends nothing: the phone then uses its own
// default (Equirectangular 180, left eye) for a video it counts as VR.

export const REMOTE_FLAT_PROJECTIONS = new Set(['equirect-180', 'fisheye-180']);

const num = (v, fallback) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

/**
 * @param {object|null|undefined} entry  a `library.vrFormat[path]` entry
 * @returns {{projection: string, eye: 'left'|'right', fov: number, yaw: number, pitch: number, roll: number}|null}
 */
export function remoteVRFormat(entry) {
  if (!entry || !REMOTE_FLAT_PROJECTIONS.has(entry.projection)) return null;
  return {
    projection: entry.projection,
    eye: entry.eye === 'right' ? 'right' : 'left',
    fov: num(entry.fov, 90),
    yaw: num(entry.yaw, 0),
    pitch: num(entry.pitch, 0),
    roll: num(entry.roll, 0),
  };
}
