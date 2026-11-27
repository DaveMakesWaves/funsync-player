// DeviceSimulator — Visual stroke indicator showing real-time device position
// Animates a marker on a vertical bar based on funscript interpolation
//
// Handled on the widget itself (v0.10.1; powerkool on EroScripts: "a setting
// to invert and modify the device simulator (i.e., change the color,
// position, etc.)"; Dave: make size and position "draggable like ofs", colour
// on a right click, rather than settings clutter):
// - drag the bar to move it, drag its corner grip to resize it, drag the knob
//   on its top end to turn it to any angle, like OFS's simulator (all kept;
//   turning: Dave 2026-11-22, "rotatable similarly to ofs");
// - right-click it for Direction (the Handy's Invert, the default; normal;
//   flipped) and Colour (accent, the heatmap's speed colours, white), and
//   Turn 90°, and Reset size, angle and position.
// Opacity stays in Settings > Playback, where it was. resolveSimOptions turns
// the stored settings into what the widget draws.
//
// Editor work list 2.5 / 5.4, 2026-11-24:
// - the other axes (2.5): beside the bar, in the look chosen under "Look" on
//   the right-click menu (sim-axes-view.js): the 3D receiver by default
//   (sim-receiver-3d.js, after OFS's Simulator3D; drag it to look from
//   another side; Size and View on the menu), or a lighter 2D look for a PC
//   that struggles with 3D (Dave: "the other 2d styles ... should be options
//   with right click on the simulator"). The 3D receiver shows for any
//   video; a 2D look only when the video has another axis, so a stroke-only
//   video keeps exactly today's bar. The points come from
//   `axisSource(suffix)` (app.js: the editor's live points, else what the
//   devices play). Built only when the app passes `look`: a simulator made
//   without it (the tests, any other host) is the bar alone, as before.
// - Align to the video (5.4): from the right-click menu, click the stroke's
//   tip, then its base, on the video; the bar is laid along that line
//   (sim-align-overlay.js, ../js/sim-align.js) and stays on that spot of the
//   picture through a resize. One setting, `player.deviceSimAlign`; Reset
//   clears it.
import { heatmapSpeedToColor } from '../js/heatmap-palette.js';
import { t } from '../js/i18n.js';
import { SIM_AXIS_ORDER, sampleAxisInto, axisSourceFrom } from '../js/sim-axes.js';
import { SIM_LOOKS, SIM3D_VIEW_NAMES, resolveSimLook, sim3dSize } from '../js/sim-receiver-3d.js';
import {
  resolveSimAlign, videoContentRect, intersectRect, alignedGeometry, translateAlign, SIM_ALIGN_MIN_LENGTH,
} from '../js/sim-align.js';
import { SimAxesView } from './sim-axes-view.js';
import { startSimAlign } from './sim-align-overlay.js';

export const SIM_DIRECTIONS = ['device', 'normal', 'flipped'];
/**
 * Solid colours offered as swatches in the right-click menu (Dave 2026-11-22:
 * "more colour options"), beside Accent, Speed colours and White, plus a
 * Custom colour the user picks (`player.deviceSimCustomColor`).
 */
export const SIM_PRESET_COLORS = Object.freeze({
  red: '#ef4444', orange: '#f97316', yellow: '#facc15', green: '#22c55e',
  cyan: '#22d3ee', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899',
});
export const SIM_COLORS = ['accent', 'speed', 'white', ...Object.keys(SIM_PRESET_COLORS), 'custom'];
/** The custom colour before one is picked: the FunSync coral. */
export const SIM_CUSTOM_COLOR_DEFAULT = '#e94560';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** How often the frame loop reads where the docked editor starts (a layout read). */
export const EDITOR_TOP_READ_MS = 250;
/** The bar's size limits in CSS px. Unset, it is CSS's 42 x 200 (thinner than OFS on purpose). */
export const SIM_SIZE_LIMITS = Object.freeze({ minW: 18, maxW: 140, minH: 80, maxH: 640 });

/** The bar's size when no size is saved (player.css .device-sim__track). */
export const SIM_DEFAULT_SIZE = Object.freeze({ w: 42, h: 200 });
/** A turn within this many degrees of upright, sideways or upside down lands on it exactly. */
export const SIM_ROTATE_SNAP_DEG = 6;
/**
 * How often the other axes are asked for (ms). The answer changes only on a
 * new video, a load or an edit, and asking every frame would ask the editor
 * 60 times a second; an edit still shows within a tenth of a second.
 */
export const SIM_AXES_POLL_MS = 100;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The stored simulator settings as the widget uses them. Pure.
 * @param {{ direction?: string, color?: string, size?: unknown, position?: unknown }} raw
 * @param {{ deviceInverted?: boolean }} [ctx] the Handy's Invert, for direction 'device'
 * @returns {{ direction: string, flipped: boolean, color: string, customColor: string, size: {w: number, h: number}|null, position: {x: number, y: number}|null, rotation: number }}
 */
export function resolveSimOptions(raw = {}, { deviceInverted = false } = {}) {
  const direction = SIM_DIRECTIONS.includes(raw?.direction) ? raw.direction : 'device';
  const flipped = direction === 'flipped' || (direction === 'device' && deviceInverted === true);
  const color = SIM_COLORS.includes(raw?.color) ? raw.color : 'accent';
  const customColor = typeof raw?.customColor === 'string' && HEX_COLOR.test(raw.customColor)
    ? raw.customColor.toLowerCase()
    : SIM_CUSTOM_COLOR_DEFAULT;
  const s = raw?.size;
  const L = SIM_SIZE_LIMITS;
  const size = s && finite(s.w) && finite(s.h)
    ? { w: clamp(Math.round(s.w), L.minW, L.maxW), h: clamp(Math.round(s.h), L.minH, L.maxH) }
    : null;
  const p = raw?.position;
  const position = p && finite(p.x) && finite(p.y)
    ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }
    : null;
  const rotation = normalizeRotation(raw?.rotation);
  return { direction, flipped, color, customColor, size, position, rotation };
}

/** The solid colour a colour choice draws with (a swatch or the custom one), or null (accent, speed, white). */
export function simSolidColor(opts) {
  if (SIM_PRESET_COLORS[opts?.color]) return SIM_PRESET_COLORS[opts.color];
  if (opts?.color === 'custom') return HEX_COLOR.test(opts.customColor || '') ? opts.customColor : SIM_CUSTOM_COLOR_DEFAULT;
  return null;
}

/** An angle in degrees as [0, 360), to a tenth of a degree; anything else is 0 (upright). */
export function normalizeRotation(deg) {
  if (!finite(deg)) return 0;
  const r = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
  return r >= 360 ? 0 : r;
}

/**
 * The angle the knob points at, from the bar's centre to the pointer: 0 =
 * straight up (upright), clockwise. Within SIM_ROTATE_SNAP_DEG of a quarter
 * turn it lands on it; with Shift held it moves in 15° steps.
 */
export function rotationFromPointer(cx, cy, px, py, { shift = false } = {}) {
  let deg = (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI;
  deg = normalizeRotation(deg);
  if (shift) return normalizeRotation(Math.round(deg / 15) * 15);
  const quarter = Math.round(deg / 90) * 90;
  if (Math.abs(deg - quarter) <= SIM_ROTATE_SNAP_DEG) return normalizeRotation(quarter);
  return deg;
}

/** The box a w x h bar takes once turned by `deg` (what the panel makes room for). */
export function rotatedBox(w, h, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { w: w * c + h * s, h: w * s + h * c };
}

export class DeviceSimulator {
  /**
   * @param {object} opts
   * @param {import('../js/video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('../js/funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   * @param {object} [opts.orgasmSwitch] — needs `livePosition`. Assigned after
   *   construction in app.js, since the switch is built later.
   * @param {object} [opts.options] resolved options (resolveSimOptions)
   * @param {(pos: {x: number, y: number}) => void} [opts.onMoved] after a drag (fractions of the window)
   * @param {(size: {w: number, h: number}) => void} [opts.onResized] after a resize (CSS px)
   * @param {(deg: number) => void} [opts.onRotated] after a turn with the knob (degrees, 0 = upright)
   * @param {(key: 'direction'|'color'|'customColor'|'reset'|'look'|'size3d'|'view3d'|'align', value?: unknown) => void} [opts.onOption]
   *   a right-click menu choice; 'look' / 'size3d' / 'view3d' carry the new
   *   look, 3D size or 3D view (a preset's name, or { yaw, tilt } after a drag
   *   on the 3D picture); 'align' the new alignment ({ tip, base }, fractions
   *   of the picture) after Align to the video or a drag while aligned
   * @param {(suffix: string) => Array<{at: number, pos: number}>|null} [opts.axisSource]
   *   the points of another axis (canonical suffix: surge, twist, vib …), or
   *   null when the video has none (editor work list 2.5)
   * @param {{look?: string, size?: string, view?: unknown}} [opts.look] the saved
   *   look settings; given, the other axes and the looks are on
   * @param {unknown} [opts.alignment] the saved `player.deviceSimAlign` (work list 5.4)
   */
  constructor({ videoPlayer, funscriptEngine, orgasmSwitch = null, options = {}, onMoved = null, onResized = null, onRotated = null, onOption = null, axisSource = null, look = undefined, alignment = null }) {
    this.player = videoPlayer;
    this.funscript = funscriptEngine;
    this.orgasmSwitch = orgasmSwitch;
    // Edge Hold "Play a pattern" drives the devices with its own loop (an
    // OrgasmSwitch too); app.js assigns it like the switch.
    this.edgeLoop = null;
    // The script player (v0.10.1): app.js assigns it; its livePosition is the
    // devices' while it plays.
    this.scriptPlayer = null;

    this._visible = false;
    this._panel = null;
    this._marker = null;
    this._posLabel = null;
    this._speedLabel = null;
    this._rafId = null;
    this._lastPosition = 50;
    this._lastTimeMs = 0;
    this._menu = null;
    // Called with the new visibility after every show/hide, whoever asked
    // (the D key or the player's ⋮ menu item), so the menu's tick can
    // never disagree with the widget (zaikechi #381).
    this.onVisibilityChange = null;
    this.onMoved = onMoved;
    this.onResized = onResized;
    this.onRotated = onRotated;
    this.onOption = onOption;
    // Already resolved (app.js _deviceSimOptions): resolving again would drop
    // the direction, which only the raw settings carry.
    this._opts = { ...resolveSimOptions(), ...options };

    // The other axes (work list 2.5), on only when the host passes `look`.
    // Their positions and speeds live in arrays made once (by
    // SIM_AXIS_INDEX), and one frame object is reused, so a frame allocates
    // nothing here.
    this._looksOn = look !== undefined;
    this._look = resolveSimLook(look || {});
    this._axisSource = typeof axisSource === 'function' ? axisSource : null;
    this._axisArrays = new Array(SIM_AXIS_ORDER.length).fill(null);
    this._axisMask = 0;
    this._axesPolledAt = -Infinity;
    this._axisVals = new Float64Array(SIM_AXIS_ORDER.length).fill(50);
    this._axisSpeeds = new Float64Array(SIM_AXIS_ORDER.length);
    this._frame = { values: this._axisVals, speeds: this._axisSpeeds, stroke: 50, strokeSpeed: 0, colorMode: 'accent', solid: null };
    // Align to the video (work list 5.4): the saved line, the bar it gives
    // now ({ w, h, rotation }, null when not drawn aligned), the two clicks
    // while they are being made, and the picture last measured.
    this._align = resolveSimAlign(alignment);
    this._alignGeom = null;
    this._aligning = null;
    this._alignKey = null;

    this._placeDue = false;
    this._buildPanel();
    this._reflectAlignment();
    this.applyOptions(this._opts);
    // A new window size, or #app growing or shrinking (the script player's
    // bar coming or going), re-draws the saved place on the next frame.
    if (typeof window !== 'undefined') window.addEventListener('resize', () => { this._placeDue = true; });
    const app = this._panel.parentElement;
    if (app && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { this._placeDue = true; }).observe(app);
    }
  }

  /**
   * Apply resolved options (resolveSimOptions). Forces the next frame to
   * repaint everything, since the direction changes what the same position
   * looks like.
   * @param {ReturnType<typeof resolveSimOptions>} opts
   */
  applyOptions(opts) {
    this._opts = { ...resolveSimOptions(), ...opts };
    const panel = this._panel;
    if (!panel) return;
    // A swatch or the custom colour draws as 'solid' with --sim-color (player.css).
    const solid = simSolidColor(this._opts);
    panel.dataset.color = solid ? 'solid' : this._opts.color;
    if (solid) panel.style.setProperty('--sim-color', solid);
    else panel.style.removeProperty('--sim-color');
    // The other axes' colours follow the same choice (read once here, not per frame).
    if (this._frame) {
      this._frame.colorMode = panel.dataset.color;
      this._frame.solid = solid;
    }
    panel.dataset.direction = this._opts.flipped ? 'flipped' : 'normal';
    this._applySize();
    this._layoutRotation();
    this._place();
    if (this._opts.color !== 'speed') this._fill.style.background = '';
    this._shownPct = null;
    this._shownPos = null;
    this._shownColor = null;
  }

  /**
   * Turn the bar (its body: the bar and the knob) to the saved angle, and
   * make room for it: the body's margins grow or shrink to the turned box,
   * so the read-out sits under the bar at any angle and stays upright. The
   * marker, fill and corner grip turn with the bar, as OFS's do.
   */
  /**
   * Turn to `deg` around the bar's own centre. The panel makes room for the
   * turned bar, so its box changes with the angle; with its top-left held
   * the bar's centre slid while turning and the turn swung about a moving
   * point (Dave 2026-11-22: "the pivot point is wrong"). So the panel is
   * moved by however far the centre went, and pinned there (a panel in the
   * default spot is pinned first, as a resize does). Returns the new place
   * as fractions of the window, or null when nothing moved (hidden, say).
   */
  _turnAroundCentre(deg) {
    const target = this._turnTarget();
    const before = target.getBoundingClientRect();
    this._opts = { ...this._opts, rotation: normalizeRotation(deg) };
    this._layoutRotation();
    const after = target.getBoundingClientRect();
    if (!(before.width > 0) || !(after.width > 0)) return null;
    const dx = (before.left + before.width / 2) - (after.left + after.width / 2);
    const dy = (before.top + before.height / 2) - (after.top + after.height / 2);
    const p = this._panel.getBoundingClientRect();
    const left = p.left + dx;
    const top = p.top + dy;
    this._panel.classList.add('device-sim--placed');
    this._panel.style.left = `${left}px`;
    this._panel.style.top = `${top}px`;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 1;
    const position = { x: left / vw, y: top / vh };
    this._opts = { ...this._opts, position };
    return position;
  }

  /** Save a turn: the place it moved to first, then the angle (both before the next paint). */
  _saveTurn(deg, position) {
    if (position) {
      try { this.onMoved?.(position); } catch (err) { console.warn('[DeviceSimulator] onMoved failed:', err?.message || err); }
    }
    try { this.onRotated?.(normalizeRotation(deg)); } catch (err) { console.warn('[DeviceSimulator] onRotated failed:', err?.message || err); }
    this._placeDue = true;
  }

  /**
   * The bar's size: aligned to the video, the line's length (and the saved
   * width); else the saved size, or CSS's when none is saved.
   */
  _applySize() {
    const g = this._alignGeom;
    const size = g ? { w: g.w, h: g.h } : this._opts.size;
    this._track.style.width = size ? `${size.w}px` : '';
    this._track.style.height = size ? `${size.h}px` : '';
  }

  _layoutRotation(w = null, h = null) {
    // Aligned to the video, the angle and length are the line's (work list 5.4).
    const g = this._alignGeom;
    const deg = g ? g.rotation : (this._opts.rotation || 0);
    const size = g ? { w: g.w, h: g.h } : (this._opts.size || SIM_DEFAULT_SIZE);
    const bw = w ?? size.w;
    const bh = h ?? size.h;
    this._panel.dataset.rotated = deg ? 'true' : 'false';
    if (this._is3dBody()) {
      this._body.style.transform = '';
      this._body.style.margin = '';
      this._axesView.setRotation(deg);
      return;
    }
    this._axesView?.setRotation?.(0);
    const box = rotatedBox(bw, bh, deg);
    this._body.style.transform = deg ? `rotate(${deg}deg)` : '';
    this._body.style.margin = deg
      ? `${((box.h - bh) / 2).toFixed(1)}px ${((box.w - bw) / 2).toFixed(1)}px`
      : '';
  }

  /**
   * Draw the saved place inside the window. The saved place (fractions of
   * the window) is kept as it is; only what is drawn is pulled in, so a bar
   * parked at the right edge stays at the edge when the window shrinks and
   * goes back when it grows (found in the app: after a shrink it hung off
   * the right and bottom). It can only be measured while shown: hidden (off,
   * or another view) it has no size, so it stays due, and the next frame on
   * the player measures it (the animation loop).
   */
  _place() {
    const panel = this._panel;
    // Aligned to the video (work list 5.4): along the line, over the picture
    // as it is drawn now. With no picture (none loaded yet) the saved place
    // is drawn meanwhile, and the frame loop re-places it once one shows.
    if (this._align) {
      const pic = this._videoPicture();
      const geom = pic ? alignedGeometry(this._align, pic.content) : null;
      if (geom) {
        this._placeAligned(geom);
        return;
      }
    }
    if (this._alignGeom) {
      this._alignGeom = null;
      this._axesView?.setDisplaySize?.(null);
      this._applySize();
      this._layoutRotation();
    }
    const pos = this._opts.position;
    const vw = typeof window !== 'undefined' ? window.innerWidth || 0 : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
    if (!pos) {
      panel.classList.remove('device-sim--placed');
      panel.style.left = '';
      panel.style.top = '';
      this._fitToRoom();
      // Centred by CSS on the whole window: over a tall docked editor it went
      // behind it. Past the floor it is placed at the floor instead (nothing
      // is saved; it goes back to the centre when the room comes back).
      const d = panel.getBoundingClientRect();
      const floor = this._bottomLimit();
      if (d.height > 0 && floor > 0 && d.bottom > floor + 1) {
        const left = d.left;
        panel.classList.add('device-sim--placed');
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(Math.max(this._blockAbove(), floor - d.height))}px`;
      }
      this._placeDue = !(d.height > 0);
      return;
    }
    panel.classList.add('device-sim--placed');
    this._fitToRoom();
    let left = pos.x * vw;
    let top = pos.y * vh;
    const r = panel.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      left = Math.max(0, Math.min(left, vw - r.width));
      // The floor (the window, the script bar, the docked editor) wins over
      // room for a tall 3D block above: the bar and its read-out always show;
      // a block too tall for the space is cut at the top (the grip shrinks it).
      top = Math.max(0, Math.min(Math.max(this._blockAbove(), top), this._bottomLimit() - r.height));
      this._placeDue = false;
    } else {
      this._placeDue = true;
    }
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  /**
   * The lowest the panel may reach: the bottom of #app, which ends above the
   * script player's bar while one plays (html.has-script-bar), else the
   * window's. Found in the app: a simulator parked at the bottom went half
   * under the bar. The saved place stays a fraction of the whole window.
   */
  _bottomLimit() {
    const vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
    const b = this._panel?.parentElement?.getBoundingClientRect?.().bottom;
    let limit = b > 0 ? Math.min(vh || b, b) : vh;
    // The docked script editor is the floor while it is open: a simulator
    // parked low went behind it, only a sliver of the 3D block showing above
    // its toolbar (break-it pass, 2026-11-24).
    const ed = this._editorTop();
    if (ed > 0) limit = Math.min(limit, ed);
    return limit;
  }

  /**
   * Too tall for the room above the floor (a docked editor grown by its
   * stacked lanes, a small window): drawn smaller, down to 40 %, instead of
   * going behind the editor with its read-out (fit-on-screen pass,
   * 2026-11-24: 160 px of room for a 246 px bar at 900x600). The CSS `scale`
   * property (it composes with the centring transform) from the top-left, so
   * left / top and the measured box still agree for placing and dragging.
   */
  _fitToRoom() {
    const panel = this._panel;
    const cur = this._fitScale || 1;
    const r = panel.getBoundingClientRect?.();
    if (!r || !(r.height > 0)) return;
    const natural = (r.height + this._blockAbove()) / cur;
    const top = Math.max(0, this._panel.parentElement?.getBoundingClientRect?.().top || 0);
    const room = this._bottomLimit() - top - 4;
    const next = room > 0 && natural > room ? Math.max(0.4, room / natural) : 1;
    if (Math.abs(next - cur) < 0.01) return;
    this._fitScale = next;
    panel.style.transformOrigin = next === 1 ? '' : 'top left';
    panel.style.scale = next === 1 ? '' : next.toFixed(3);
  }

  /** What of the simulator shows on screen (the bar or picture, its block, the read-out), or null. */
  _visibleBox() {
    const p = this._panel;
    if (!p || p.hidden) return null;
    let box = null;
    for (const el of [p, ...p.children]) {
      const b = el.getBoundingClientRect?.();
      if (!b || !(b.width > 0) || !(b.height > 0)) continue;
      box = box
        ? { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) }
        : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    return box;
  }

  /** The docked editor's top edge while it is open, else 0. */
  /** The docked editor opened, closed or resized: read where it starts on the next frame. */
  editorMoved() {
    this._edTopReadAt = undefined;
  }

  _editorTop() {
    if (typeof document === 'undefined') return 0;
    if (!document.getElementById('player-container')?.classList.contains('player-container--editor-open')) return 0;
    const top = document.querySelector('.script-editor.script-editor--open')?.getBoundingClientRect?.().top;
    return top > 0 ? top : 0;
  }

  /** How far the axes block reaches above the panel's own box (it hangs up from the bar's bottom). */
  _blockAbove() {
    const el = this._axesView?.el;
    if (!el || el.hidden) return 0;
    const b = el.getBoundingClientRect();
    const p = this._panel.getBoundingClientRect();
    return b.height > 0 ? Math.max(0, p.top - b.top) : 0;
  }

  /**
   * The video picture on screen (work list 5.4): `content`, the frame as
   * drawn inside the <video> box for its object-fit (the alignment's
   * fractions are of this), and `visible`, the part of it the player shows
   * (its wrapper clips VR flatten's doubled frame). Null with no video, or
   * one with no picture yet (audio, still loading, a headset stream).
   */
  _videoPicture() {
    const v = this.player?.video;
    if (!v || typeof v.getBoundingClientRect !== 'function') return null;
    if (!(v.videoWidth > 0) || !(v.videoHeight > 0)) return null;
    let fit = 'contain';
    try {
      // A computed style is live: kept, it is read again for free each frame.
      if (this._videoStyleOf !== v && typeof getComputedStyle === 'function') {
        this._videoStyle = getComputedStyle(v);
        this._videoStyleOf = v;
      }
      fit = this._videoStyle?.objectFit || 'contain';
    } catch { /* contain, the player's own */ }
    const content = videoContentRect(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, fit);
    if (!content) return null;
    const clip = v.parentElement?.getBoundingClientRect?.();
    const visible = clip && clip.width > 0 && clip.height > 0 ? intersectRect(content, clip) : content;
    if (!visible) return null;
    return { content, visible };
  }

  /** Whether Align to the video can start: there is a picture to click on. */
  _canAlign() {
    return !!this._videoPicture();
  }

  /**
   * Lay the bar along the aligned line: as long as the line (never under
   * SIM_ALIGN_MIN_LENGTH), at its angle, its centre on the line's middle.
   * Where the bar's centre sits inside the panel is measured (the read-out
   * hangs under it, a turn makes room) and the panel moved by however far
   * off it is; twice, as a fixed box near the window's edge can change width
   * with where it is. Hidden, nothing measures: it stays due.
   */
  _placeAligned(geom) {
    const panel = this._panel;
    const w = this._opts.size?.w || SIM_DEFAULT_SIZE.w;
    const h = Math.max(SIM_ALIGN_MIN_LENGTH, Math.round(geom.length));
    this._alignGeom = { w, h, rotation: geom.rotation };
    // The 3D picture takes the stroke's length too (its height; 100-420 wide).
    if (this._is3dBody()) this._axesView.setDisplaySize(Math.max(100, Math.min(420, Math.round(geom.length / 1.2))));
    if (this._fitScale && this._fitScale !== 1) {
      this._fitScale = 1;
      panel.style.scale = '';
      panel.style.transformOrigin = '';
    }
    this._applySize();
    this._layoutRotation();
    panel.classList.add('device-sim--placed');
    for (let i = 0; i < 2; i++) {
      const b = this._turnTarget().getBoundingClientRect();
      if (!(b.width > 0) || !(b.height > 0)) {
        this._placeDue = true;
        return;
      }
      const p = panel.getBoundingClientRect();
      panel.style.left = `${p.left + (geom.cx - (b.left + b.width / 2))}px`;
      panel.style.top = `${p.top + (geom.cy - (b.top + b.height / 2))}px`;
    }
    this._placeDue = false;
  }

  /**
   * Each frame while aligned: a picture that moved or changed size (the
   * window, the editor opening beside the video, another aspect mode, a new
   * video) re-places the bar. Read before the frame writes anything, so the
   * read costs no extra layout.
   */
  _checkAlignedPicture() {
    const c = this._videoPicture()?.content;
    const l = c ? Math.round(c.left) : NaN;
    const tp = c ? Math.round(c.top) : NaN;
    const w = c ? Math.round(c.width) : NaN;
    const h = c ? Math.round(c.height) : NaN;
    const k = this._alignKey;
    if (!k || !(k[0] === l && k[1] === tp && k[2] === w && k[3] === h)) {
      this._alignKey = [l, tp, w, h];
      this._placeDue = true;
    }
  }

  /**
   * The other axes' block hangs beside the panel, out of its layout (so the
   * bar sits exactly where it did without it): on the left, or on the right
   * when the panel is too near the window's left edge for it.
   */
  _placeAxesSide() {
    const el = this._axesView?.el;
    if (!el || el.hidden || this._is3dBody()) return;
    const p = this._panel.getBoundingClientRect();
    if (!(p.width > 0)) return;
    const box = el.getBoundingClientRect();
    const w = box.width || 0;
    // Turned sideways (Turn 90°, or the knob near it), the bar lies flat: the
    // block goes above it (below near the window's top) instead of floating
    // off to its side (break-it pass, 2026-11-24).
    const rad = ((this._opts.rotation || 0) * Math.PI) / 180;
    const flat = Math.abs(Math.sin(rad)) > 0.7;
    const side = flat
      ? (p.top < (box.height || 0) + 12 ? 'below' : 'above')
      : (p.left < w + 12 ? 'right' : 'left');
    if (this._panel.dataset.axesSide !== side) this._panel.dataset.axesSide = side;
  }

  /** The aligned state on the panel: grip and knob go (CSS), and the tooltip says what a drag does now. */
  _reflectAlignment() {
    if (!this._panel) return;
    if (this._align) this._panel.dataset.aligned = 'true';
    else delete this._panel.dataset.aligned;
    this._track.title = t(this._align ? 'deviceSim.tooltipAligned' : 'deviceSim.tooltip');
  }

  /**
   * Dragging an aligned bar moves the line with it, over the picture (the
   * same length and angle); the new line is saved on release.
   */
  _dragAligned(e) {
    const pic = this._videoPicture();
    if (!pic) return;
    const start = this._align;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    this._panel.classList.add('device-sim--dragging');
    this._capture(this._track, e, (ev) => {
      this._align = translateAlign(start, (ev.clientX - x0) / pic.content.width, (ev.clientY - y0) / pic.content.height);
      moved = true;
      const geom = alignedGeometry(this._align, pic.content);
      if (geom) this._placeAligned(geom);
    }, () => {
      this._panel.classList.remove('device-sim--dragging');
      this._placeAxesSide();
      if (!moved) return;
      try { this.onOption?.('align', this._align); } catch (err) { console.warn('[DeviceSimulator] onOption failed:', err?.message || err); }
    });
  }

  /**
   * One pointer gesture: `onMove(ev)` on each move, `onEnd()` once. The
   * moves and the release are heard on the WINDOW, not on the element: the
   * pointer soon leaves a bar that is growing or moving, and when capture is
   * not granted (found in the app: a resize lost the pointer to the video
   * after the first move, never heard the release and stayed "resizing")
   * the element hears nothing more. Losing the window (Alt+Tab) ends it too.
   */
  _capture(el, e, onMove, onEnd) {
    try { el.setPointerCapture?.(e.pointerId); } catch { /* not granted: the window listeners carry it */ }
    const move = (ev) => onMove(ev);
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
      onEnd();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
  }

  /** Drag the bar to move it; drag the corner grip to resize it. */
  _wireDrag() {
    const track = this._track;
    const grip = this._grip;
    if (!track || typeof window === 'undefined') return;

    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === grip) return;
      this._startMove(e, track);
    });

    grip?.addEventListener('pointerdown', (e) => this._startGripResize(e));

    // The knob on the bar's top end turns it, around its centre, to any
    // angle (OFS's simulator turns freely too). Near a quarter turn it lands
    // on it; Shift moves in 15° steps.
    this._knob?.addEventListener('pointerdown', (e) => this._startKnobTurn(e));

    track.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._openMenu(e.clientX, e.clientY);
    });
  }

  /**
   * Move the whole simulator: a drag on the bar or on the axes block beside
   * it (Dave, 2026-11-24: they are one simulator; only the bar dragged them).
   * @param {PointerEvent} e
   * @param {Element} el what captured the pointer
   */
  _startMove(e, el) {
    {
      e.preventDefault();
      e.stopPropagation();
      this._closeMenu();
      // Aligned to the video, a drag moves the line over the picture.
      if (this._align) {
        this._dragAligned(e);
        return;
      }
      const rect = this._panel.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      this._panel.classList.add('device-sim--placed', 'device-sim--dragging');
      const place = (ev) => {
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        const left = clamp(ev.clientX - dx, 0, Math.max(0, w - rect.width));
        const above = this._blockAbove();
        const top = clamp(ev.clientY - dy, above, Math.max(above, (this._bottomLimit() || h) - rect.height));
        this._panel.style.left = `${left}px`;
        this._panel.style.top = `${top}px`;
        return { x: left / w, y: top / h };
      };
      let last = place(e);
      this._capture(el, e, (ev) => { last = place(ev); }, () => {
        this._panel.classList.remove('device-sim--dragging');
        this._placeAxesSide();
        this._opts = { ...this._opts, position: last };
        try { this.onMoved?.(last); } catch (err) { console.warn('[DeviceSimulator] onMoved failed:', err?.message || err); }
      });
    }
  }

  /** The bar's corner grip: resize the bar. */
  _startGripResize(e) {
    const track = this._track;
    const grip = this._grip;
    {
      // Aligned, the line sets the length and angle (the grip is hidden too).
      if (e.button !== 0 || this._align) return;
      e.preventDefault();
      e.stopPropagation();
      this._closeMenu();
      const r = track.getBoundingClientRect();
      const pr = this._panel.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const L = SIM_SIZE_LIMITS;
      // Turned, the pointer moves along the bar's own axes: undo the turn on
      // the drag so dragging the corner outward still grows it. The box on
      // screen is not the bar's size then: take the size it was given.
      const deg = this._opts.rotation || 0;
      const rad = (deg * Math.PI) / 180;
      const start = deg ? (this._opts.size || SIM_DEFAULT_SIZE) : { w: r.width, h: r.height };
      const local = (dx, dy) => (deg
        ? { x: dx * Math.cos(rad) + dy * Math.sin(rad), y: -dx * Math.sin(rad) + dy * Math.cos(rad) }
        : { x: dx, y: dy });
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      // Pin the top-left first, so the corner follows the pointer: in the
      // default spot the panel is anchored right and centred, and it grew
      // left and both ways, away from the pointer (found in the app).
      const wasPlaced = this._panel.classList.contains('device-sim--placed');
      if (!wasPlaced) {
        this._panel.classList.add('device-sim--placed');
        this._panel.style.left = `${pr.left}px`;
        this._panel.style.top = `${pr.top}px`;
      }
      // Not past the window's right edge or the bottom limit (the read-out
      // included; above the script player's bar while one plays).
      // (Turned, the box on screen is no guide to the bar's own edges: the
      // size limits alone apply, and _place keeps the panel in the window.)
      const below = Math.max(0, pr.height - r.height);
      const maxW = deg ? L.maxW : Math.max(L.minW, Math.min(L.maxW, Math.floor(vw - r.left - 4)));
      const maxH = deg ? L.maxH : Math.max(L.minH, Math.min(L.maxH, Math.floor((this._bottomLimit() || vh) - r.top - below - 4)));
      this._panel.classList.add('device-sim--resizing');
      let last = { w: Math.round(start.w), h: Math.round(start.h) };
      this._capture(grip, e, (ev) => {
        const d = local(ev.clientX - x0, ev.clientY - y0);
        last = {
          w: clamp(Math.round(start.w + d.x), L.minW, maxW),
          h: clamp(Math.round(start.h + d.y), L.minH, maxH),
        };
        track.style.width = `${last.w}px`;
        track.style.height = `${last.h}px`;
        this._layoutRotation(last.w, last.h);
      }, () => {
        this._panel.classList.remove('device-sim--resizing');
        this._opts = { ...this._opts, size: last };
        try { this.onResized?.(last); } catch (err) { console.warn('[DeviceSimulator] onResized failed:', err?.message || err); }
        if (!wasPlaced) {
          const position = { x: pr.left / vw, y: pr.top / vh };
          this._opts = { ...this._opts, position };
          try { this.onMoved?.(position); } catch (err) { console.warn('[DeviceSimulator] onMoved failed:', err?.message || err); }
        }
      });
    }
  }

  /** The knob: turn the bar around its centre. */
  _startKnobTurn(e) {
    {
      if (e.button !== 0 || this._align) return;
      e.preventDefault();
      e.stopPropagation();
      this._closeMenu();
      const b = this._turnTarget().getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      this._panel.classList.add('device-sim--rotating');
      let last = this._opts.rotation || 0;
      let moved = null;
      // The bar's knob, or the 3D picture's (the event's own target).
      const knob = e.target?.classList?.contains('device-sim__3d-knob') ? e.target : this._knob;
      this._capture(knob, e, (ev) => {
        last = rotationFromPointer(cx, cy, ev.clientX, ev.clientY, { shift: ev.shiftKey === true });
        moved = this._turnAroundCentre(last) || moved;
      }, () => {
        this._panel.classList.remove('device-sim--rotating');
        this._saveTurn(last, moved);
      });
    }
  }

  /**
   * The right-click menu: Direction and Colour (the current one ticked), and
   * Reset size and position. Arrow keys move, Enter / Space choose, Escape or
   * a click elsewhere closes.
   */
  _openMenu(x, y) {
    this._closeMenu();
    const menu = document.createElement('div');
    menu.className = 'device-sim__menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('deviceSim.menuAria'));
    const items = [];
    const heading = (key) => {
      const h = document.createElement('div');
      h.className = 'device-sim__menu-heading';
      h.setAttribute('role', 'presentation');
      h.textContent = t(key);
      menu.appendChild(h);
    };
    const item = (label, checked, choose, role = 'menuitemradio') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'device-sim__menu-item';
      b.setAttribute('role', role);
      if (role === 'menuitemradio') b.setAttribute('aria-checked', checked ? 'true' : 'false');
      b.textContent = label;
      b.addEventListener('click', () => { this._closeMenu(); choose(); });
      menu.appendChild(b);
      items.push(b);
    };
    const opt = this._opts;
    // A row of small choices: each a radio item, its short word on the
    // button and the full wording as its tooltip and accessible name.
    const segRow = (labelKey, choices, current, choose) => {
      heading(labelKey);
      const row = document.createElement('div');
      row.className = 'device-sim__seg-row';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', t(labelKey));
      for (const [value, shortKey, longKey] of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'device-sim__seg';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', value === current ? 'true' : 'false');
        b.dataset.value = value;
        b.textContent = t(shortKey);
        if (longKey) { b.title = t(longKey); b.setAttribute('aria-label', t(longKey)); }
        b.addEventListener('click', () => { this._closeMenu(); choose(value); });
        row.appendChild(b);
        items.push(b);
      }
      menu.appendChild(row);
    };
    segRow('deviceSim.menuDirection', [
      ['device', 'deviceSim.dirDeviceShort', 'deviceSim.dirDevice'],
      ['normal', 'deviceSim.dirNormalShort', 'deviceSim.dirNormal'],
      ['flipped', 'deviceSim.dirFlippedShort', 'deviceSim.dirFlipped'],
    ], opt.direction, (d) => this.onOption?.('direction', d));
    // Colour: ONE row of swatches: the theme's accent, speed colours (the
    // heatmap's scale), white, the solid colours, then the picker. Not in the
    // 3D look unless it lists other axes (Vibe ...): the bar it coloured is
    // not there, and the picture keeps the theme's colours (2026-11-25).
    const colourApplies = !this._is3dBody() || (this._axesView?._rows?.length || 0) > 0;
    if (colourApplies) {
    heading('deviceSim.menuColor');
    const row = document.createElement('div');
    row.className = 'device-sim__swatches';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', t('deviceSim.menuColor'));
    const swatch = (name, label, paint, choose) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'device-sim__swatch';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', opt.color === name ? 'true' : 'false');
      b.setAttribute('aria-label', label);
      b.title = label;
      b.dataset.color = name;
      paint(b);
      b.addEventListener('click', () => { this._closeMenu(); choose(); });
      row.appendChild(b);
      items.push(b);
      return b;
    };
    swatch('accent', t('deviceSim.colorAccent'), (b) => { b.style.background = 'var(--accent)'; }, () => this.onOption?.('color', 'accent'));
    swatch('speed', t('deviceSim.colorSpeed'), (b) => { b.classList.add('device-sim__swatch--speed'); }, () => this.onOption?.('color', 'speed'));
    swatch('white', t('deviceSim.colorWhite'), (b) => { b.style.background = '#ffffff'; }, () => this.onOption?.('color', 'white'));
    for (const [name, hex] of Object.entries(SIM_PRESET_COLORS)) {
      if (name === 'white') continue;
      swatch(name, t(`deviceSim.color${name[0].toUpperCase()}${name.slice(1)}`), (b) => { b.style.background = hex; }, () => this.onOption?.('color', name));
    }
    swatch('custom', t('deviceSim.colorCustom'), (b) => {
      b.classList.add('device-sim__swatch--custom');
      b.style.setProperty('--custom', opt.customColor || SIM_CUSTOM_COLOR_DEFAULT);
    }, () => this._pickCustomColor());
    menu.appendChild(row);
    }
    // Look (work list 2.5): one row of buttons; View under the 3D one.
    if (this._looksOn) {
      const lk = this._look;
      segRow('deviceSim.menuLook', [
        ['3d', 'deviceSim.look3dShort', 'deviceSim.look3d'],
        ['drawing', 'deviceSim.lookDrawingShort', 'deviceSim.lookDrawing'],
        ['bars', 'deviceSim.lookBarsShort', 'deviceSim.lookBars'],
        ['gauges', 'deviceSim.lookGaugesShort', 'deviceSim.lookGauges'],
      ], lk.look, (l) => this._chooseLook('look', l));
      if (lk.look === '3d') {
        const viewKeys = { quarter: 'deviceSim.viewQuarter', front: 'deviceSim.viewFront', side: 'deviceSim.viewSide', above: 'deviceSim.viewAbove' };
        // After a turn with the wheel none is ticked: the view is the user's own.
        segRow('deviceSim.menuView', SIM3D_VIEW_NAMES.map((n) => [n, viewKeys[n], null]), lk.view.preset, (v) => this._chooseLook('view3d', v));
        // Turn the base a quarter at a time, anticlockwise / clockwise seen
        // from above (Dave, 2026-11-25: "why cant you
        // rotate the base"; the wheel turns it too, but nobody finds that).
        // The menu stays up for the next turn.
        const viewRow = menu.lastElementChild;
        for (const [glyph, key, step] of [['⟲', 'deviceSim.turnBaseCcw', -90], ['⟳', 'deviceSim.turnBaseCw', 90]]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'device-sim__seg device-sim__seg--turn';
          b.setAttribute('role', 'menuitem');
          b.dataset.turn = String(step);
          b.textContent = glyph;
          b.title = t(key);
          b.setAttribute('aria-label', t(key));
          b.addEventListener('click', () => {
            const v = this._look.view;
            this._chooseLook('view3d', { yaw: v.yaw + step, tilt: v.tilt });
            this._openMenu(x, y);
            this._menu?.querySelector(`.device-sim__seg--turn[data-turn="${step}"]`)?.focus();
          });
          viewRow.appendChild(b);
          items.push(b);
        }
      }
    }
    const sep = document.createElement('div');
    sep.className = 'device-sim__menu-sep';
    sep.setAttribute('role', 'separator');
    menu.appendChild(sep);
    // Align to the video (work list 5.4): only with a picture to click on.
    // Aligned, the line sets the angle, so Turn 90° is not offered; Reset
    // (app.js) clears the alignment with the size, angle and place.
    if (this._canAlign()) item(t('deviceSim.align'), false, () => this.startAlign(), 'menuitem');
    if (!this._align) {
      item(t('deviceSim.turn'), false, () => {
        const deg = normalizeRotation((this._opts.rotation || 0) + 90);
        this._saveTurn(deg, this._turnAroundCentre(deg));
      }, 'menuitem');
    }
    item(t('deviceSim.reset'), false, () => this.onOption?.('reset'), 'menuitem');

    document.body.appendChild(menu);
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;
    const r = menu.getBoundingClientRect();
    let left = Math.max(4, Math.min(x, (w || x + r.width) - r.width - 4));
    const top = Math.max(4, Math.min(y, (h || y + r.height) - r.height - 4));
    // Beside the simulator, not on it: everything here changes how it looks
    // (Look, View, the base's turn), and opened on it the menu hid the change
    // (the editor open, 2026-11-25: turning the base, nothing could be seen).
    // To its left if there is room, else to its right; else where it was.
    const sim = this._visibleBox();
    if (sim && r.width > 0 && left < sim.right && left + r.width > sim.left && top < sim.bottom && top + r.height > sim.top) {
      if (sim.left - r.width - 8 >= 4) left = sim.left - r.width - 8;
      else if (w && sim.right + 8 + r.width <= w - 4) left = sim.right + 8;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this._menu = menu;

    menu.addEventListener('keydown', (e) => {
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[n].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._closeMenu();
      }
    });
    this._menuAway = (ev) => { if (this._menu && !this._menu.contains(ev.target)) this._closeMenu(); };
    document.addEventListener('pointerdown', this._menuAway, true);
    (items.find((b) => b.getAttribute('aria-checked') === 'true') || items[0])?.focus();
  }

  /**
   * Custom colour…: the system colour picker, starting at the saved custom
   * colour. The bar follows while the user picks (nothing saved yet); the
   * pick is saved when the picker closes with a colour (onOption
   * 'customColor'), and closing it without one puts the bar back.
   */
  _pickCustomColor() {
    if (typeof document === 'undefined') return;
    if (!this._colorInput) {
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'device-sim__color-input';
      input.tabIndex = -1;
      input.setAttribute('aria-hidden', 'true');
      input.addEventListener('input', () => {
        this._previewing = this._previewing || { ...this._opts };
        this.applyOptions({ ...this._opts, color: 'custom', customColor: input.value });
      });
      input.addEventListener('change', () => {
        this._previewing = null;
        try { this.onOption?.('customColor', input.value.toLowerCase()); } catch (err) { console.warn('[DeviceSimulator] onOption failed:', err?.message || err); }
      });
      input.addEventListener('cancel', () => {
        if (this._previewing) { const back = this._previewing; this._previewing = null; this.applyOptions(back); }
      });
      document.body.appendChild(input);
      this._colorInput = input;
    }
    this._colorInput.value = this._opts.customColor || SIM_CUSTOM_COLOR_DEFAULT;
    this._colorInput.click();
  }

  _closeMenu() {
    if (this._menuAway) document.removeEventListener('pointerdown', this._menuAway, true);
    this._menuAway = null;
    this._menu?.remove();
    this._menu = null;
  }

  _buildPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'device-sim';
    this._panel.hidden = true;

    // Layer order mirrors OpenFunscripter's simulator draw order:
    // background plate, front bar, height lines OVER the bar, then the
    // indicator on top. See OFS_ScriptSimulator.cpp.
    // The body holds the bar and the knob that turns it, and is what turns.
    this._panel.innerHTML = `
      <div class="device-sim__body">
        <div class="device-sim__track">
          <div class="device-sim__fill"></div>
          <div class="device-sim__lines"></div>
          <div class="device-sim__marker"></div>
          <div class="device-sim__grip" aria-hidden="true"></div>
        </div>
        <div class="device-sim__knob" aria-hidden="true"></div>
      </div>
      <div class="device-sim__info">
        <span class="device-sim__pos">50</span>
        <span class="device-sim__speed">0</span>
      </div>
    `;

    this._body = this._panel.querySelector('.device-sim__body');
    this._knob = this._panel.querySelector('.device-sim__knob');
    this._track = this._panel.querySelector('.device-sim__track');
    this._grip = this._panel.querySelector('.device-sim__grip');
    this._marker = this._panel.querySelector('.device-sim__marker');
    this._fill = this._panel.querySelector('.device-sim__fill');
    this._posLabel = this._panel.querySelector('.device-sim__pos');
    this._speedLabel = this._panel.querySelector('.device-sim__speed');
    this._track.title = t('deviceSim.tooltip');
    // The other axes (work list 2.5), when the host asked for them.
    if (this._looksOn) this._makeAxesView();

    document.getElementById('app')?.appendChild(this._panel);
    this._wireDrag();
  }

  /**
   * The other axes' block. A drag on its 3D picture turns the view (with
   * the simulator's own pointer capture), which a drag on the bar never
   * does: the bar still moves the simulator. A right-click on the picture
   * opens the simulator's menu.
   */
  _makeAxesView() {
    this._axesView = new SimAxesView(this._panel, {
      capture: (el, e, onMove, onEnd) => { this._closeMenu(); this._capture(el, e, onMove, onEnd); },
      onOrbitEnd: (view) => this._chooseLook('view3d', view),
      onContextMenu: (x, y) => this._openMenu(x, y),
      onMoveStart: (e, el) => this._startMove(e, el),
      onResizeEnd: (width) => { this._endCornerResize(); this._chooseLook('size3d', width); },
      onResizeStep: (w, w0) => this._keepCornerOnResize(w, w0),
      onKnobStart: (e) => this._startKnobTurn(e),
    });
    this._axesView.setLook(this._look);
    this._syncLookLayout();
  }

  /**
   * The 3D look IS the simulator (Dave, 2026-11-25: "surely both arent
   * required"): the bar and its knob give way to the 3D picture, which takes
   * the bar's place in the panel (its read-out under it), and Turn 90°, the
   * knob and an alignment turn the picture. The 2D looks keep the bar with
   * their block beside it.
   */
  _is3dBody() {
    return !!(this._looksOn && this._look?.look === '3d' && this._axesView?.canvas3d);
  }

  /** What turns: the 3D picture in the 3D look, else the bar's body. */
  _turnTarget() {
    return this._is3dBody() ? this._axesView.canvas3d : this._body;
  }

  _syncLookLayout() {
    if (!this._panel) return;
    this._panel.dataset.look = this._looksOn ? this._look.look : '';
    if (this._is3dBody()) delete this._panel.dataset.axesSide;
    this._layoutRotation();
    this._placeDue = true;
  }

  /**
   * The 3D picture's grip is its top-left corner and the picture now sits in
   * the panel's flow (anchored at its top-left): while it resizes the panel
   * moves by the growth, so the opposite corner stays put and the grip
   * follows the pointer.
   */
  _keepCornerOnResize(w, w0) {
    const p = this._panel;
    if (!p) return;
    if (!this._resizeFrom) {
      const r = p.getBoundingClientRect();
      this._resizeFrom = { left: r.left, top: r.top };
    }
    const k = this._fitScale || 1;
    // The picture as drawn: turned, its width and height trade places.
    const deg = this._alignGeom ? this._alignGeom.rotation : (this._opts.rotation || 0);
    const a = sim3dSize(w0);
    const b = sim3dSize(w);
    const box0 = rotatedBox(a.w, a.h, deg);
    const box1 = rotatedBox(b.w, b.h, deg);
    const dw = (box1.w - box0.w) * k;
    const dh = (box1.h - box0.h) * k;
    p.classList.add('device-sim--placed');
    p.style.left = `${Math.round(this._resizeFrom.left - dw)}px`;
    p.style.top = `${Math.round(this._resizeFrom.top - dh)}px`;
  }

  _endCornerResize() {
    if (!this._resizeFrom) return;
    this._resizeFrom = null;
    const r = this._panel.getBoundingClientRect();
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 1;
    const position = { x: r.left / vw, y: r.top / vh };
    this._opts = { ...this._opts, position };
    try { this.onMoved?.(position); } catch (err) { console.warn('[DeviceSimulator] onMoved failed:', err?.message || err); }
    this._placeDue = true;
  }

  /**
   * A look, 3D size or 3D view chosen on the menu (or a view left by a drag
   * on the 3D picture): shown at once, then handed to the host to save.
   */
  _chooseLook(key, value) {
    const lk = this._look;
    const raw = { look: lk.look, size: lk.size, view: lk.view.preset || { yaw: lk.view.yaw, tilt: lk.view.tilt } };
    if (key === 'look') raw.look = value;
    else if (key === 'size3d') raw.size = value;
    else if (key === 'view3d') raw.view = value;
    this.setLook(raw);
    try { this.onOption?.(key, value); } catch (err) { console.warn('[DeviceSimulator] onOption failed:', err?.message || err); }
  }

  /**
   * Get the current interpolated position (0–100) from the funscript engine.
   * @returns {number}
   */
  getPosition() {
    // The Orgasm Switch runs on its OWN clock and drives the managers directly
    // with the sync engines stopped, so video.currentTime says nothing about
    // what the hardware is doing. While it is active it is the authority.
    // An Edge Hold pattern is the same kind of loop.
    // The script player (v0.10.1) drives the devices on its own clock too.
    const live = this.orgasmSwitch?.livePosition ?? this.edgeLoop?.livePosition ?? this.scriptPlayer?.livePosition;
    if (live !== null && live !== undefined) return live;

    if (!this.funscript.isLoaded) return 50;
    const timeMs = this.player.currentTime * 1000;
    return this.funscript.getPositionAt(timeMs);
  }

  /**
   * Calculate speed as position change per second.
   * @param {number} position — current position (0–100)
   * @param {number} timeMs — current time in ms
   * @returns {number} speed in pos-units/second
   */
  getSpeed(position, timeMs) {
    const dt = timeMs - this._lastTimeMs;
    if (dt <= 0) return 0;
    const dp = Math.abs(position - this._lastPosition);
    return (dp / dt) * 1000; // pos/sec
  }

  // --- Animation ---

  _startAnimation() {
    if (this._rafId) return;

    const loop = () => {
      if (!this._visible) return;
      if (this._align) this._checkAlignedPicture();
      if (this._placeDue) {
        this._place();
        this._placeAxesSide();
      }
      this._update();
      this._rafId = requestAnimationFrame(loop);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  _stopAnimation() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * The clock the speed is measured on: the video's, or the wall clock while
   * a live loop (X, an Edge Hold pattern) drives the devices on its own. On a
   * paused video the video's time stands still, and the read-out said 0/s
   * while the bar moved (live verifier 2026-11-17).
   * @returns {number} ms
   */
  _clockMs() {
    const live = this.orgasmSwitch?.livePosition ?? this.edgeLoop?.livePosition ?? this.scriptPlayer?.livePosition;
    this._liveClock = live !== null && live !== undefined && typeof performance !== 'undefined';
    if (this._liveClock) return performance.now();
    return this.player.currentTime * 1000;
  }

  _update() {
    // Where the docked editor starts moves only when it opens, closes or
    // resizes: read (a query and a layout read) at most 4 times a second, not
    // every frame (Dave, 2026-11-25: "speed up the player when in editor").
    // The first frame, and one after editorMoved(), read at once.
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._edTopReadAt === undefined || nowMs - this._edTopReadAt >= EDITOR_TOP_READ_MS) {
      this._edTopReadAt = nowMs;
      this._edTopCached = this._editorTop();
    }
    const edTop = this._edTopCached;
    if (edTop !== this._lastEditorTop) { this._lastEditorTop = edTop; this._placeDue = true; }
    const timeMs = this._clockMs();
    const position = this.getPosition();
    // A live loop moves its position once per tick (40 ms), so most frames
    // see no change: between its ticks the last measured speed stays.
    const hold = this._liveClock && position === this._lastPosition && timeMs - this._lastTimeMs < 250;
    const speed = hold ? (this._lastSpeed || 0) : this.getSpeed(position, timeMs);

    // Write only what changed (2026-11-20). This runs every frame while the
    // panel is open, paused included, and every write makes the page lay out
    // and paint again: a paused video with the panel open was being redrawn
    // at the display's full rate for nothing.
    // Marker position: 0 at bottom, 100 at top; flipped, 100 at the bottom.
    // The read-out keeps the script's number either way.
    // The fill is the stroke from 0 to the marker: from the bottom, or from the
    // top when flipped (CSS anchors it, data-direction).
    const shown = this._opts?.flipped ? 100 - position : position;
    const pct = `${Math.max(0, Math.min(100, shown))}%`;
    if (pct !== this._shownPct) {
      this._marker.style.bottom = pct;
      this._fill.style.height = `${Math.max(0, Math.min(100, position))}%`;
      this._shownPct = pct;
    }
    const pos = String(Math.round(position));
    if (pos !== this._shownPos) { this._posLabel.textContent = pos; this._shownPos = pos; }
    const spd = String(Math.round(speed));
    if (spd !== this._shownSpeed) { this._speedLabel.textContent = spd; this._shownSpeed = spd; }
    // Speed colours: the heatmap's scale (pos-units per ms), as the seek bar paints it.
    if (this._opts?.color === 'speed') {
      const c = heatmapSpeedToColor(speed / 1000);
      if (c !== this._shownColor) { this._fill.style.background = c; this._shownColor = c; }
    }
    if (this._axesView) this._updateAxes(shown, speed);

    this._lastSpeed = speed;
    if (hold) return;
    this._lastPosition = position;
    this._lastTimeMs = timeMs;
  }

  /**
   * The other axes for this frame (work list 2.5): ask the source every
   * SIM_AXES_POLL_MS, sample each axis at the video's time into the reused
   * arrays, and hand the view one reused frame object. Nothing is drawn
   * while the player is not the view on screen (the simulator is hidden by
   * CSS there, though its loop runs: a video playing in the mini player).
   * @param {number} shown the bar's position as drawn (flipped already)
   * @param {number} speed the stroke's speed, units per second
   */
  _updateAxes(shown, speed) {
    const view = this._panel.parentElement?.dataset?.view;
    if (view && view !== 'player') return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._axesPolledAt >= SIM_AXES_POLL_MS) {
      this._axesPolledAt = now;
      this._pollAxes();
    }
    const timeMs = (Number(this.player?.currentTime) || 0) * 1000;
    const vals = this._axisVals;
    const spds = this._axisSpeeds;
    for (let i = 0; i < SIM_AXIS_ORDER.length; i++) {
      const arr = this._axisArrays[i];
      if (!arr || !sampleAxisInto(arr, timeMs, vals, spds, i)) {
        vals[i] = 50;
        spds[i] = 0;
      }
    }
    const f = this._frame;
    f.stroke = shown;
    f.strokeSpeed = speed;
    this._axesView.update(f);
  }

  /**
   * Ask the source for every axis. The view is rebuilt only when the set of
   * axes the video has changes (a new video, an axis added or removed).
   */
  _pollAxes() {
    let mask = 0;
    for (let i = 0; i < SIM_AXIS_ORDER.length; i++) {
      let arr = null;
      if (this._axisSource) {
        try { arr = this._axisSource(SIM_AXIS_ORDER[i]); } catch { arr = null; }
      }
      this._axisArrays[i] = Array.isArray(arr) && arr.length > 0 ? arr : null;
      if (this._axisArrays[i]) mask |= 1 << i;
    }
    if (mask !== this._axisMask || !this._axesSet) {
      this._axisMask = mask;
      this._axesSet = true;
      const was = this._axesView.shown;
      this._axesView.setAxes(SIM_AXIS_ORDER.filter((_, i) => mask & (1 << i)));
      if (this._axesView.shown && !was) this._placeAxesSide();
    }
  }

  // --- Public API ---

  /**
   * Where the other axes' points come from (work list 2.5): `fn(suffix)`
   * answers an axis's points or null. Asked again at once.
   */
  setAxisSource(fn) {
    this._axisSource = typeof fn === 'function' ? fn : null;
    this.refreshAxes();
  }

  /** Fixed axes instead of a source: a Map or object of suffix (any spelling) → points. */
  setAxes(axes) {
    this.setAxisSource(axes ? axisSourceFrom(axes) : null);
  }

  /** Ask the source again on the next frame (a new video, a load), not a tenth of a second later. */
  refreshAxes() {
    this._axesPolledAt = -Infinity;
  }

  /** The other axes the simulator shows now (canonical suffixes). */
  get axes() {
    return this._axesView ? this._axesView.axes : [];
  }

  /** The look in use: { look, size, view: { yaw, tilt, preset } }, or null when looks are off. */
  get look() {
    return this._looksOn ? { ...this._look, view: { ...this._look.view } } : null;
  }

  /**
   * The saved look settings (`player.deviceSimLook`, `deviceSim3dSize`,
   * `deviceSim3dView`). Turns the looks on if they were off.
   * @param {{look?: unknown, size?: unknown, view?: unknown}} raw
   */
  setLook(raw) {
    const next = resolveSimLook(raw || {});
    this._look = next;
    if (!this._looksOn) {
      this._looksOn = true;
      this._makeAxesView();
      this._axesSet = false;
      this.refreshAxes();
    }
    this._axesView.setLook(next);
    this._syncLookLayout();
    this._placeAxesSide();
  }

  /** The saved alignment ({ tip, base }, fractions of the picture), or null. */
  get alignment() {
    return this._align ? { tip: { ...this._align.tip }, base: { ...this._align.base } } : null;
  }

  /**
   * The saved `player.deviceSimAlign` (work list 5.4): laid along it now,
   * or put back to the saved place when it is cleared (Reset).
   */
  setAlignment(raw) {
    const align = resolveSimAlign(raw);
    const same = JSON.stringify(align) === JSON.stringify(this._align);
    this._align = align;
    this._reflectAlignment();
    if (same && (align ? !!this._alignGeom : !this._alignGeom)) return;
    this._alignKey = null;
    this._place();
    this._placeAxesSide();
  }

  /**
   * Align to the video: the two clicks (sim-align-overlay.js). Returns false
   * when there is no picture to click on, or the clicks are already up.
   */
  startAlign() {
    if (this._aligning?.active || typeof document === 'undefined') return false;
    if (!this._videoPicture()) return false;
    this._closeMenu();
    this._panel.classList.add('device-sim--aligning');
    this._aligning = startSimAlign({
      getRect: () => this._videoPicture(),
      onDone: (raw) => {
        this._aligning = null;
        this._panel.classList.remove('device-sim--aligning');
        const align = resolveSimAlign(raw);
        if (!align) return;
        this.setAlignment(align);
        try { this.onOption?.('align', align); } catch (err) { console.warn('[DeviceSimulator] onOption failed:', err?.message || err); }
      },
      onCancel: () => {
        this._aligning = null;
        this._panel.classList.remove('device-sim--aligning');
      },
    });
    return true;
  }

  /** Stop the two clicks, if they are up (Esc does it too). */
  cancelAlign() {
    this._aligning?.cancel();
  }

  /** Whether the two clicks of Align to the video are up. */
  get isAligning() {
    return !!this._aligning?.active;
  }

  toggle() {
    if (this._visible) this.hide();
    else this.show();
  }

  show() {
    if (this._visible) return;
    this._visible = true;
    this._panel.hidden = false;
    this._placeDue = true;
    // Set on each show, so a language change since the last one is picked up.
    this._track.title = t(this._align ? 'deviceSim.tooltipAligned' : 'deviceSim.tooltip');
    this._lastTimeMs = this.player.currentTime * 1000;
    this._lastPosition = this.getPosition();
    // The other axes: asked for at once, and drawn again in full.
    this._axesPolledAt = -Infinity;
    this._axesView?.invalidate();
    this._startAnimation();
    this._emitVisibility();
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this._closeMenu();
    this.cancelAlign();
    this._panel.hidden = true;
    this._stopAnimation();
    this._emitVisibility();
  }

  _emitVisibility() {
    try {
      this.onVisibilityChange?.(this._visible);
    } catch (err) {
      console.warn('[DeviceSimulator] visibility listener failed:', err?.message || err);
    }
  }

  get isVisible() {
    return this._visible;
  }
}
