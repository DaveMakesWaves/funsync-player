// The phone's "Flat view" for VR videos (#426, Fistemo 2026-11-22: watches VR
// on an Android phone, can't wear a headset). The desktop already shows a VR
// video as one flat view (VR Format: Equirectangular 180 / Fisheye 180, one
// eye, drag to look around); this is the same on the phone, with the
// desktop's own WebGL renderer (served by the backend at /vr-flatten/, one
// copy of the shaders).
//
// On the phone: one finger drags to look around, two fingers pinch to zoom
// (field of view). A tap still shows the controls and a double-tap still
// skips: a press that moves less than DRAG_SLOP_PX is left to them.

import { isVRVideo } from './vr-detect.js';

export const RENDERER_URL = '/vr-flatten/vr-projection-renderer.js';
export const DRAG_SLOP_PX = 8;
export const FOV_MIN = 30;
export const FOV_MAX = 160;
const FLAT_PROJECTIONS = new Set(['equirect-180', 'fisheye-180']);

/**
 * The flat view a video opens with, or null when it is not a VR video: the
 * desktop's saved spherical format when it sent one (`video.vrFormat`), else
 * Equirectangular 180, left eye, looking straight ahead (most VR180 rips).
 */
export function flatViewFormat(video) {
  if (!video) return null;
  const f = video.vrFormat;
  if (f && FLAT_PROJECTIONS.has(f.projection)) {
    return {
      projection: f.projection,
      eye: f.eye === 'right' ? 'right' : 'left',
      fov: Number.isFinite(f.fov) ? f.fov : 90,
      yaw: Number.isFinite(f.yaw) ? f.yaw : 0,
      pitch: Number.isFinite(f.pitch) ? f.pitch : 0,
      roll: Number.isFinite(f.roll) ? f.roll : 0,
    };
  }
  if (!isVRVideo(video)) return null;
  return { projection: 'equirect-180', eye: 'left', fov: 90, yaw: 0, pitch: 0, roll: 0 };
}

/**
 * Look-around from a drag: the picture follows the finger, so dragging right
 * turns the view left. One screen width of drag is one field of view.
 */
export function lookFromDrag(start, dxPx, dyPx, widthPx, fovDeg) {
  const degPerPx = (fovDeg || 90) / Math.max(1, widthPx || 1);
  return {
    yaw: start.yaw - dxPx * degPerPx,
    pitch: Math.max(-85, Math.min(85, start.pitch + dyPx * degPerPx)),
  };
}

/** Field of view from a pinch: fingers apart zoom in (a narrower view). */
export function fovFromPinch(startFov, startDist, dist) {
  if (!(startDist > 0) || !(dist > 0)) return startFov;
  return Math.max(FOV_MIN, Math.min(FOV_MAX, startFov * (startDist / dist)));
}

export class PhoneFlatView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.videoWrap  the player's wrap (gestures land here)
   * @param {HTMLVideoElement} opts.videoEl
   * @param {object} opts.format          from flatViewFormat()
   * @param {Function} [opts.importRenderer]  () => import(RENDERER_URL) (tests swap it)
   */
  constructor({ videoWrap, videoEl, format, importRenderer } = {}) {
    this.videoWrap = videoWrap;
    this.videoEl = videoEl;
    this.format = { ...format };
    this._import = importRenderer || (() => import(RENDERER_URL));
    this._renderer = null;
    this._on = false;
    this._pointers = new Map();
    this._gesture = null;
    this._unwire = null;
  }

  get on() { return this._on; }

  /** Show the flat view. False when it cannot (no WebGL2, the renderer did not load). */
  async enable() {
    if (this._on) return true;
    let Renderer;
    try {
      ({ VRProjectionRenderer: Renderer } = await this._import());
    } catch (err) {
      console.warn('[FlatView] renderer did not load:', err?.message || err);
      return false;
    }
    const r = new Renderer();
    try {
      r.mount(this.videoEl, this.videoWrap);
    } catch (err) {
      console.warn('[FlatView] no flat view here:', err?.message || err);
      return false;
    }
    // Right after the video, so the controls overlay stays on top of it.
    if (r.canvas && this.videoEl.nextSibling !== r.canvas) this.videoEl.after(r.canvas);
    const f = this.format;
    r.setProjection(f.projection);
    r.setEye(f.eye);
    r.setStereoMode(1);          // side by side, as the desktop's flat view
    r.setFov(f.fov);
    r.setYawPitch(f.yaw, f.pitch);
    r.setRoll(f.roll);
    this._renderer = r;
    this._on = true;
    this.videoWrap.classList.add('player__video-wrap--flat');
    this._unwire = this._wireGestures();
    return true;
  }

  /** Back to the video as it is. */
  disable() {
    if (!this._on) return;
    this._unwire?.();
    this._unwire = null;
    try { this._renderer?.unmount(); } catch { /* already gone */ }
    this._renderer = null;
    this._on = false;
    this._pointers.clear();
    this._gesture = null;
    this.videoWrap.classList.remove('player__video-wrap--flat');
  }

  _wireGestures() {
    const wrap = this.videoWrap;
    const isControl = (t) => t && t !== this.videoEl && t !== wrap && !t.classList?.contains('pcx')
      && t !== this._renderer?.canvas;
    const down = (e) => {
      if (isControl(e.target)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._startGesture();
    };
    const move = (e) => {
      if (!this._pointers.has(e.pointerId) || !this._gesture) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this._gesture;
      const pts = [...this._pointers.values()];
      if (g.kind === 'pinch' && pts.length >= 2) {
        const fov = fovFromPinch(g.fov, g.dist, distance(pts[0], pts[1]));
        this.format.fov = fov;
        this._renderer?.setFov(fov);
        g.moved = true;
      } else if (g.kind === 'drag' && pts.length === 1) {
        const dx = pts[0].x - g.x;
        const dy = pts[0].y - g.y;
        if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
        g.moved = true;
        const look = lookFromDrag(g, dx, dy, wrap.clientWidth, this.format.fov);
        this.format.yaw = look.yaw;
        this.format.pitch = look.pitch;
        this._renderer?.setYawPitch(look.yaw, look.pitch);
      }
      if (g.moved) e.preventDefault();
    };
    const up = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const moved = !!this._gesture?.moved;
      this._pointers.delete(e.pointerId);
      // A drag or pinch is not a tap: the controls' tap and double-tap
      // handlers on the wrap never see its pointerup.
      if (moved) e.stopImmediatePropagation();
      if (this._pointers.size === 0) this._gesture = null;
      else this._startGesture(moved);
    };
    wrap.addEventListener('pointerdown', down, true);
    wrap.addEventListener('pointermove', move, true);
    wrap.addEventListener('pointerup', up, true);
    wrap.addEventListener('pointercancel', up, true);
    return () => {
      wrap.removeEventListener('pointerdown', down, true);
      wrap.removeEventListener('pointermove', move, true);
      wrap.removeEventListener('pointerup', up, true);
      wrap.removeEventListener('pointercancel', up, true);
    };
  }

  /** A drag with one finger, a pinch with two; restarted when a finger lifts or lands. */
  _startGesture(moved = false) {
    const pts = [...this._pointers.values()];
    if (pts.length >= 2) {
      this._gesture = { kind: 'pinch', fov: this.format.fov, dist: distance(pts[0], pts[1]), moved };
    } else if (pts.length === 1) {
      this._gesture = { kind: 'drag', x: pts[0].x, y: pts[0].y, yaw: this.format.yaw, pitch: this.format.pitch, moved };
    }
  }
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
