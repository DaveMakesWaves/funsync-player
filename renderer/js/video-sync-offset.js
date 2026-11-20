// Per-video sync offset (Pudknocker #380: "HereSphere sync timing varies per
// file").
//
// `library.syncOffsets` maps a VIDEO PATH to a delta in ms. While that video
// plays, every device's own offset (Handy, Buttplug, T-Code, Autoblow) has the
// delta added on top. The delta's sign means the same on every device:
// negative = the device fires earlier. A device whose own offset runs the
// other way is sent it negated (`deviceOffsetWithVideoDelta`). It is applied
// once per device and never to the VR proxy as well: in VR the proxy's
// `vr.offset` already stacks under every device's offset, so adding the
// delta there too would apply it twice.
//
// A missing entry or 0 is today's behaviour. A Reset stores 0 rather than
// deleting the key: a video with no key of its own looks for a moved video's
// entry (app.js `_planLazyRehome`, like `library.preferredVariants`), and a
// same-named copy kept there must not undo the reset. Nothing ever deletes an
// entry because a file is missing (absence is never destructive).
//
// Pure: no DOM, no settings, no devices.

/** One − / + press. Matches the global sliders' 10 ms step. */
export const VIDEO_SYNC_OFFSET_STEP_MS = 10;

/** Same ±1000 ms range as the global offset sliders and the phone's. */
export const VIDEO_SYNC_OFFSET_LIMIT_MS = 1000;

/**
 * A stored or typed value as a whole number of ms in range. Anything that is
 * not a finite number is 0 (today's behaviour), never an error.
 * @param {*} value
 * @returns {number}
 */
export function clampVideoSyncOffset(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  // `|| 0` turns -0 into 0, so a reset compares equal to "no entry".
  return Math.max(-VIDEO_SYNC_OFFSET_LIMIT_MS, Math.min(VIDEO_SYNC_OFFSET_LIMIT_MS, n)) || 0;
}

/**
 * How the delta goes into the offset value a device is SENT: +1 when that
 * value fires the device earlier as it goes more negative (the delta's own
 * meaning), -1 when it fires it earlier as it goes more positive. One shared
 * delta has to move every device the same way, and no per-video value could
 * fix a video for two devices pulled in opposite directions.
 *
 * - Buttplug and T-Code need no entry: the app schedules them itself at
 *   `currentTime - offset - delta`, so a negative delta is earlier by code.
 * - Autoblow -1: its API adds the offset to the script's current time
 *   ("will get added to syncScriptCurrentTime", vendored Autoblow API v1),
 *   so a positive offset plays the script ahead, earlier. The Autoblow tab's
 *   latency Apply already relies on that: it stores +measured ms to cancel
 *   the delay. Unverified on hardware, like that button.
 * - Handy -1, MEASURED on Dave's Handy (fw 4.2.1, 2026-11-05, position read
 *   back over a hold clip): a +1000 ms HSTP offset played the script 1000 ms
 *   EARLIER, -1000 ms played it 1025 ms later, +500 ms 475 ms earlier
 *   (baseline +25). That is the vendored v2 spec's reading of /hstp/offset,
 *   not the app's older assumption (the -50 ms "early-fire" preset and the
 *   Sync tab's "Negative values fire commands earlier"), which were written
 *   for the scheduled devices and are wrong for the Handy's own global.
 */
export const VIDEO_SYNC_OFFSET_DEVICE_SIGN = Object.freeze({ handy: -1, autoblow: -1 });

/**
 * The offset value to send a device: its global plus this video's delta in
 * that device's own direction. A 0 delta sends exactly the global.
 * @param {'handy'|'autoblow'} device
 * @param {number} globalMs
 * @param {number} deltaMs
 * @returns {number}
 */
export function deviceOffsetWithVideoDelta(device, globalMs, deltaMs) {
  const sign = VIDEO_SYNC_OFFSET_DEVICE_SIGN[device] ?? 1;
  return (Number(globalMs) || 0) + sign * clampVideoSyncOffset(deltaMs);
}

/**
 * The delta stored for `path` (0 when there is none).
 * @param {object|null|undefined} map — `library.syncOffsets`
 * @param {string|null|undefined} path
 * @returns {number}
 */
export function videoSyncOffsetOf(map, path) {
  if (!path || !map || typeof map !== 'object') return 0;
  if (!Object.prototype.hasOwnProperty.call(map, path)) return 0;
  return clampVideoSyncOffset(map[path]);
}

/**
 * A copy of `map` with `path` set to `ms` (0 included, see above); every
 * other entry is kept exactly as it was.
 * @param {object|null|undefined} map
 * @param {string} path
 * @param {number} ms
 * @returns {object}
 */
export function withVideoSyncOffset(map, path, ms) {
  const next = { ...((map && typeof map === 'object') ? map : {}) };
  if (!path) return next;
  next[path] = clampVideoSyncOffset(ms);
  return next;
}

/**
 * "+20 ms" / "-30 ms" / "0 ms" for the "This video" row.
 * @param {number} ms
 * @returns {string}
 */
export function formatVideoSyncOffset(ms) {
  const v = clampVideoSyncOffset(ms);
  return `${v > 0 ? '+' : ''}${v} ms`;
}
