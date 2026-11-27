// SimAxesView: the device simulator's other axes (editor work list 2.5,
// 2026-11-24). DeviceSimulator owns it and feeds it once per frame; the
// maths is in ../js/sim-axes.js and ../js/sim-receiver-3d.js.
//
// A block that hangs beside the stroke bar (outside its layout, so the bar
// stays where it is), in the look chosen on the simulator's right-click menu
// (Dave 2026-11-24: "option D as the default but just in case the user's pc
// struggles with 3d, the other 2d styles ... should be options"):
//   - '3d': the shaded 3D receiver (sim-receiver-3d.js), with the values of
//     the receiver axes the video has under it. Shown for a stroke-only
//     video too: it then just rides up and down. Drag it to look from
//     another side.
//   - 'drawing': a line drawing of the receiver and a row per axis (name,
//     small bar, value);
//   - 'bars': a slim copy of the stroke bar per axis, with its T-Code channel;
//   - 'gauges': twist as a dial seen from above, roll from the front, pitch
//     from the side, surge and sway on a top-down pad.
// Vibe, pump, valve, suction and lube are rows (bars in 'bars'). The 2D
// looks show nothing for a stroke-only video: the simulator is then exactly
// the bar it always was.
//
// Cost (why the 2D looks exist): a canvas is drawn only when what it shows
// changed (values to a tenth, view, size, colour), at most once per frame
// (DeviceSimulator's loop), never while hidden; the DOM writes only what
// changed; the theme's colours are read when the theme changes, not per frame.
// Video-overlay look (notes/DESIGN.md 2.2): dark on both themes, flat, no glow.
import { axisShortLabel, getAxisBySuffix } from '../js/multi-axis.js';
import { t } from '../js/i18n.js';
import {
  SIM_RECEIVER_AXES, SIM_AXIS_INDEX, isCentredAxis, projectReceiver, simPose, heatRgbInto,
} from '../js/sim-axes.js';
import {
  Receiver3D, SIM3D_DEFAULT_COLOURS, parseCssColour, sleeveColourFor, orbitView, resolveSimLook,
  sim3dSize, sim3dWidth, SIM3D_WIDTH_LIMITS,
} from '../js/sim-receiver-3d.js';

/** The line drawing's size (CSS px, square). */
export const SIM_DRAWING_CSS_SIZE = 88;
/** A gauge's size (CSS px, square). */
export const SIM_GAUGE_CSS_SIZE = 56;
const FAINT = 'rgba(255, 255, 255, 0.28)';
const r10 = (v) => Math.round(v * 10) / 10;
const packRgb = (rgb) => (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
const rgbCss = (n) => `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
// Line-colour keys that are not a packed speed colour.
const COLOUR_ACCENT = -1;
const COLOUR_WHITE = -2;
const COLOUR_SOLID = -3;
/** The least time between two 3D pictures that only move the pose: every frame at 60-75 Hz, every 2nd at 120-165 Hz (60-82 a second). */
export const POSE_FRAME_MS = 12;

export class SimAxesView {
  /**
   * @param {HTMLElement} host the simulator panel
   * @param {object} [hooks]
   * @param {(el: Element, e: PointerEvent, onMove: Function, onEnd: Function) => void} [hooks.capture] the simulator's pointer capture
   * @param {(view: {yaw: number, tilt: number}) => void} [hooks.onOrbitEnd] the view after a drag on the 3D picture
   * @param {(x: number, y: number) => void} [hooks.onContextMenu] a right-click on the 3D picture
   */
  constructor(host, { capture = null, onOrbitEnd = null, onContextMenu = null, onMoveStart = null, onResizeEnd = null, onResizeStep = null, onKnobStart = null } = {}) {
    const el = document.createElement('div');
    el.className = 'device-sim__axes';
    el.hidden = true;
    el.setAttribute('role', 'group');
    host.appendChild(el);
    this.el = el;
    this._capture = capture;
    this.onOrbitEnd = onOrbitEnd;
    this.onContextMenu = onContextMenu;
    this.onMoveStart = onMoveStart;
    this.onResizeEnd = onResizeEnd;
    this.onResizeStep = onResizeStep;
    this.onKnobStart = onKnobStart;
    this._rotation = 0;
    this._displaySize = null;
    // One simulator (Dave, 2026-11-24: the bar and the 3D block moved apart,
    // only the bar dragged them): a drag ANYWHERE on this block moves the
    // whole simulator, as one on the bar does; its corner grip resizes the 3D
    // picture; a right-click opens the simulator's menu. Set once here, not
    // per build, so a rebuild never stacks listeners.
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target?.classList?.contains('device-sim__3d-grip')) { this._startResize(e); return; }
      // The 3D picture's own turn knob (the bar's, when the 3D look is the simulator).
      if (e.target?.classList?.contains('device-sim__3d-knob')) { this.onKnobStart?.(e); return; }
      this.onMoveStart?.(e, el);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onContextMenu?.(e.clientX, e.clientY);
    });

    this._opts = resolveSimLook();
    this._view = { yaw: this._opts.view.yaw, tilt: this._opts.view.tilt };
    this._suffixes = [];
    this._built = '';
    this._receiver = new Receiver3D({
      makeCanvas: () => (typeof document !== 'undefined' ? document.createElement('canvas') : null),
    });
    // What the 3D picture was last drawn with (no key string per frame).
    this._last3d = new Float64Array(12).fill(NaN);
    this._now3d = new Float64Array(12);
    this._drawn3dAt = -Infinity;
    this._speedRgb = [0, 0, 0];
    this._theme = null;
    this._dpr = 0;
    this.draws = 0;   // canvases drawn (tests: nothing draws while hidden or unchanged)
    this._watchTheme();
  }

  /** The 3D picture's canvas, or null (another look). */
  get canvas3d() { return this._canvas3d; }

  /**
   * Turn the 3D picture in its frame (the simulator's Turn 90° and knob, the
   * angle of an aligned stroke), room made around it as the bar's is.
   */
  setRotation(deg = 0) {
    this._rotation = Number.isFinite(deg) ? deg : 0;
    this._applyRotation();
  }

  /** The 3D picture's width as drawn: aligned, the stroke's; else the saved size. */
  _size() {
    return this._displaySize ?? this._opts.size;
  }

  /**
   * Aligned to the video the picture takes the stroke's length, as the bar's
   * length does (its saved size stays as it was); null: the saved size again.
   * Kept at the user's size it ran off the window near the top (2026-11-25).
   */
  setDisplaySize(w) {
    const next = Number.isFinite(w) ? Math.round(w) : null;
    if (next === this._displaySize) return;
    this._displaySize = next;
    const size = this._size();
    this._receiver.setSize(size);
    if (this._canvas3d) {
      const { w: cw, h } = sim3dSize(size);
      this._canvas3d.style.width = `${cw}px`;
      this._canvas3d.style.height = `${h}px`;
    }
    this._applyRotation();
    this._dpr = 0;
    this.invalidate();
  }

  _applyRotation() {
    const cv = this._canvas3d;
    if (!cv) return;
    const deg = this._rotation || 0;
    if (!deg) { cv.style.transform = ''; cv.style.margin = ''; return; }
    const { w, h } = sim3dSize(this._size());
    const rad = (deg * Math.PI) / 180;
    const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    cv.style.transform = `rotate(${deg}deg)`;
    cv.style.margin = `${((bh - h) / 2).toFixed(1)}px ${((bw - w) / 2).toFixed(1)}px`;
  }

  /** The look in use, its size and view. */
  get options() { return { ...this._opts, view: { ...this._opts.view, ...this._view } }; }

  /** The canonical suffixes shown, in order. */
  get axes() { return [...this._suffixes]; }

  /** Whether the block is on: the 3D look always, a 2D look only with another axis. */
  get shown() { return !this.el.hidden; }

  /**
   * The look settings (resolveSimLook). A new look or size rebuilds the
   * block; a new view only redraws the 3D picture.
   */
  setLook(raw) {
    const next = resolveSimLook(raw);
    const rebuild = !this._hasBuilt || next.look !== this._opts.look || next.size !== this._opts.size;
    this._opts = next;
    this._view = { yaw: next.view.yaw, tilt: next.view.tilt };
    this._receiver.setSize(this._displaySize ?? next.size);
    if (rebuild) this._build();
    this.invalidate();
  }

  /**
   * Show these axes (canonical suffixes, in SIM_AXIS_ORDER). The block is
   * rebuilt only when the set changes.
   * @returns {boolean} whether anything changed
   */
  setAxes(suffixes) {
    if (suffixes.length === this._suffixes.length && suffixes.every((s, i) => s === this._suffixes[i])) return false;
    this._suffixes = [...suffixes];
    this._build();
    return true;
  }

  /** Draw everything again on the next update (shown again, a language or theme change). */
  invalidate() {
    this._last3d.fill(NaN);
    this._drawn3dAt = -Infinity;
    for (const p of this._canvases || []) {
      p.key = null;
      for (const val of p.vals || []) val.n = undefined;
    }
    for (const r of [...(this._rows || []), ...(this._bars || []), ...(this._readout || [])]) {
      r.pos = undefined; r.n = undefined; r.colour = undefined;
    }
  }

  _hasReceiverAxis() {
    return this._suffixes.some((s) => SIM_RECEIVER_AXES.includes(s));
  }

  _build() {
    const look = this._opts.look;
    const el = this.el;
    this._hasBuilt = true;
    el.replaceChildren();
    el.dataset.look = look;
    el.dataset.size = String(this._opts.size);
    el.title = look === '3d' ? t('deviceSim.axesTip3d') : t('deviceSim.axesTip');
    this._rows = [];
    this._canvases = [];
    this._bars = [];
    this._readout = [];
    this._canvas3d = null;
    const receiverAxes = this._suffixes.filter((s) => SIM_RECEIVER_AXES.includes(s));
    const otherAxes = this._suffixes.filter((s) => !SIM_RECEIVER_AXES.includes(s));
    el.setAttribute('aria-label', t('deviceSim.axesAria'));

    if (look === '3d') {
      const { w, h } = sim3dSize(this._size());
      const cv = document.createElement('canvas');
      cv.className = 'device-sim__3d';
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', t('deviceSim.receiver3dAria'));
      this._wireOrbit(cv);
      el.appendChild(cv);
      this._canvas3d = cv;
      // The resize grip in the top-left corner: the block grows up and to the
      // left of the bar, so that corner is the one that moves outward.
      const grip = document.createElement('div');
      grip.className = 'device-sim__3d-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.title = t('deviceSim.resize3d');
      el.appendChild(grip);
      // The turn knob over the picture (shown on hover), as the bar has one:
      // the 3D look is the whole simulator, and it turns like the bar did.
      const knob = document.createElement('div');
      knob.className = 'device-sim__3d-knob';
      knob.setAttribute('aria-hidden', 'true');
      el.appendChild(knob);
      this._applyRotation();
      if (receiverAxes.length) {
        const read = document.createElement('div');
        read.className = 'device-sim__readout';
        for (const s of receiverAxes) {
          const span = document.createElement('span');
          span.textContent = `${axisShortLabel(s)} `;
          const b = document.createElement('b');
          span.appendChild(b);
          read.appendChild(span);
          this._readout.push({ i: SIM_AXIS_INDEX[s], b, text: undefined });
        }
        el.appendChild(read);
      }
      for (const s of otherAxes) el.appendChild(this._row(s));
    } else if (look === 'drawing') {
      if (receiverAxes.length) el.appendChild(this._canvas('drawing', SIM_DRAWING_CSS_SIZE, t('deviceSim.receiverAria')));
      for (const s of this._suffixes) el.appendChild(this._row(s));
    } else if (look === 'bars') {
      for (const s of this._suffixes) el.appendChild(this._bar(s));
    } else {
      if (receiverAxes.length) {
        const grid = document.createElement('div');
        grid.className = 'device-sim__gauges';
        if (receiverAxes.includes('surge') || receiverAxes.includes('sway')) grid.appendChild(this._gauge('pad'));
        for (const s of ['twist', 'roll', 'pitch']) if (receiverAxes.includes(s)) grid.appendChild(this._gauge(s));
        el.appendChild(grid);
      }
      for (const s of otherAxes) el.appendChild(this._row(s));
    }
    // The 3D receiver shows for any video (Dave 2026-11-24); a 2D look only
    // with another axis, so stroke-only stays exactly today's bar.
    el.hidden = look === '3d' ? false : this._suffixes.length === 0;
    this._dpr = 0;
    this.invalidate();
  }

  _row(suffix) {
    const row = document.createElement('div');
    row.className = 'device-sim__axis-row';
    row.dataset.axis = suffix;
    const centred = isCentredAxis(suffix);
    const name = document.createElement('span');
    name.className = 'device-sim__axis-name';
    name.textContent = axisShortLabel(suffix);
    const bar = document.createElement('span');
    bar.className = centred ? 'device-sim__axis-bar is-centred' : 'device-sim__axis-bar';
    const fill = document.createElement('span');
    fill.className = 'device-sim__axis-fill';
    bar.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'device-sim__axis-val';
    row.append(name, bar, val);
    this._rows.push({ i: SIM_AXIS_INDEX[suffix], centred, fill, val });
    return row;
  }

  _bar(suffix) {
    const centred = isCentredAxis(suffix);
    const col = document.createElement('div');
    col.className = 'device-sim__bar-col';
    col.dataset.axis = suffix;
    col.title = axisShortLabel(suffix);
    const track = document.createElement('div');
    track.className = 'device-sim__bar';
    const fill = document.createElement('div');
    fill.className = 'device-sim__bar-fill';
    track.appendChild(fill);
    for (let k = 1; k < 10; k++) {
      if (centred && k === 5) continue;
      const line = document.createElement('div');
      line.className = 'device-sim__bar-line';
      line.style.bottom = `calc(${k * 10}% - 1px)`;
      track.appendChild(line);
    }
    if (centred) {
      const mid = document.createElement('div');
      mid.className = 'device-sim__bar-mid';
      track.appendChild(mid);
    }
    const marker = document.createElement('div');
    marker.className = 'device-sim__bar-marker';
    track.appendChild(marker);
    const label = document.createElement('div');
    label.className = 'device-sim__bar-label';
    label.textContent = getAxisBySuffix(suffix)?.tcode || suffix;
    const val = document.createElement('span');
    label.appendChild(val);
    col.append(track, label);
    this._bars.push({ i: SIM_AXIS_INDEX[suffix], centred, fill, marker, val });
    return col;
  }

  _canvas(kind, size, label) {
    const cv = document.createElement('canvas');
    cv.className = kind === 'drawing' ? 'device-sim__receiver' : 'device-sim__gauge-canvas';
    cv.style.width = `${size}px`;
    cv.style.height = `${size}px`;
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', label);
    this._canvases.push({ kind, cv, size, key: null });
    return cv;
  }

  _gauge(kind) {
    const wrap = document.createElement('div');
    wrap.className = 'device-sim__gauge';
    wrap.dataset.gauge = kind;
    const label = kind === 'pad' ? `${axisShortLabel('surge')} / ${axisShortLabel('sway')}` : axisShortLabel(kind);
    wrap.appendChild(this._canvas(kind, SIM_GAUGE_CSS_SIZE, label));
    const cap = document.createElement('div');
    cap.className = 'device-sim__gauge-cap';
    const parts = kind === 'pad' ? ['surge', 'sway'] : [kind];
    const holder = this._canvases[this._canvases.length - 1];
    holder.vals = [];
    parts.forEach((s, n) => {
      if (n) cap.appendChild(document.createElement('br'));
      cap.appendChild(document.createTextNode(`${axisShortLabel(s)} `));
      const b = document.createElement('b');
      cap.appendChild(b);
      holder.vals.push({ i: SIM_AXIS_INDEX[s], b, text: undefined });
    });
    wrap.appendChild(cap);
    return wrap;
  }

  /**
   * The 3D picture's view turns with the mouse wheel (Shift: up and down);
   * a drag on it moves the simulator like one on the bar (Dave, 2026-11-24).
   * The view is saved once the wheel rests (a scroll fires many events).
   */
  _wireOrbit(cv) {
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const step = Math.max(-60, Math.min(60, d));
      this._view = e.shiftKey ? orbitView(this._view, 0, step * 0.6) : orbitView(this._view, step * 0.6, 0);
      this.invalidate();
      clearTimeout(this._orbitSave);
      this._orbitSave = setTimeout(() => {
        try { this.onOrbitEnd?.({ ...this._view }); } catch (err) { console.warn('[SimAxesView] onOrbitEnd failed:', err?.message || err); }
      }, 400);
    }, { passive: false });
  }

  /** The corner grip: drag up-left to grow the 3D picture, down-right to shrink it. */
  _startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = sim3dWidth(this._opts.size);
    const L = SIM3D_WIDTH_LIMITS;
    let w = w0;
    this.el.classList.add('is-resizing');
    const move = (ev) => {
      // Outward is up and to the left; the larger of the two pulls wins.
      const grow = Math.max(x0 - ev.clientX, (y0 - ev.clientY) / 1.2);
      w = Math.round(Math.max(L.min, Math.min(L.max, w0 + grow)));
      if (w === this._opts.size) return;
      this._opts = { ...this._opts, size: w };
      this._receiver.setSize(w);
      const { h } = sim3dSize(w);
      if (this._canvas3d) { this._canvas3d.style.width = `${w}px`; this._canvas3d.style.height = `${h}px`; }
      this._applyRotation();
      this._dpr = 0;
      this.invalidate();
      try { this.onResizeStep?.(w, w0); } catch (err) { console.warn('[SimAxesView] onResizeStep failed:', err?.message || err); }
    };
    const end = () => {
      this.el.classList.remove('is-resizing');
      if (w !== w0) {
        try { this.onResizeEnd?.(w); } catch (err) { console.warn('[SimAxesView] onResizeEnd failed:', err?.message || err); }
      }
    };
    if (this._capture) this._capture(this.el, e, move, end);
  }

  /** The theme's colours, read once and again on a theme change (a MutationObserver on <html>). */
  _watchTheme() {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    try {
      this._themeObserver = new MutationObserver(() => { this._theme = null; this.invalidate(); });
      this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style', 'data-season'] });
    } catch { /* colours stay as first read */ }
  }

  _themeColours() {
    if (this._theme) return this._theme;
    let sleeve = null;
    let accent = null;
    try {
      const cs = getComputedStyle(document.documentElement);
      sleeve = parseCssColour(cs.getPropertyValue('--surface-card'));
      accent = parseCssColour(cs.getPropertyValue('--accent'));
    } catch { /* the defaults */ }
    accent = accent || [...SIM3D_DEFAULT_COLOURS.accent];
    sleeve = sleeveColourFor(sleeve || [...SIM3D_DEFAULT_COLOURS.sleeve]);
    this._theme = { sleeve, accent, accentCss: `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})` };
    return this._theme;
  }

  /**
   * One frame. Draws a canvas only when what it shows changed.
   * @param {object} f reused by the caller, frame after frame
   * @param {Float64Array} f.values position (0-100) by SIM_AXIS_INDEX; 50 for an axis the video lacks
   * @param {Float64Array} f.speeds units per ms by SIM_AXIS_INDEX
   * @param {number} f.stroke the bar's position as drawn (flipped already)
   * @param {number} f.strokeSpeed units per second
   * @param {string} f.colorMode the panel's data-color: accent | speed | white | solid
   * @param {string|null} f.solid the colour for 'solid'
   */
  update(f) {
    if (this.el.hidden) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (dpr !== this._dpr) {
      this._dpr = dpr;
      this._sizeCanvases(dpr);
    }
    const speedMode = f.colorMode === 'speed';
    for (const row of this._rows) this._updateRow(row, f, speedMode);
    for (const bar of this._bars) this._updateBar(bar, f, speedMode);
    for (const r of this._readout) {
      const n = Math.round(f.values[r.i]);
      if (n !== r.n) { r.b.textContent = String(n); r.n = n; }
    }
    if (this._canvas3d) this._draw3d(f, dpr);
    for (const c of this._canvases) this._drawCanvas(c, f, dpr);
  }

  _sizeCanvases(dpr) {
    if (this._canvas3d) {
      const { w, h } = sim3dSize(this._size());
      this._canvas3d.width = Math.round(w * dpr);
      this._canvas3d.height = Math.round(h * dpr);
    }
    for (const c of this._canvases) {
      c.cv.width = Math.round(c.size * dpr);
      c.cv.height = Math.round(c.size * dpr);
    }
    this.invalidate();
  }

  /**
   * A row: compared as numbers first, so an unchanged frame makes no
   * string and writes nothing (strings are made only for what changed).
   */
  _updateRow(row, f, speedMode) {
    const pos = r10(f.values[row.i]);
    if (pos !== row.pos) {
      row.pos = pos;
      row.fill.style.left = `${row.centred ? Math.min(50, pos) : 0}%`;
      row.fill.style.width = `${r10(row.centred ? Math.abs(pos - 50) : pos)}%`;
      const n = Math.round(pos);
      if (n !== row.n) { row.val.textContent = String(n); row.n = n; }
    }
    // Speed colours: this axis's own speed; any other choice is the CSS's.
    const colour = speedMode ? packRgb(heatRgbInto(f.speeds[row.i], this._speedRgb)) : -1;
    if (colour !== row.colour) {
      row.fill.style.background = colour >= 0 ? rgbCss(colour) : '';
      row.colour = colour;
    }
  }

  _updateBar(bar, f, speedMode) {
    const pos = r10(f.values[bar.i]);
    if (pos !== bar.pos) {
      bar.pos = pos;
      bar.fill.style.bottom = `${bar.centred ? Math.min(50, pos) : 0}%`;
      bar.fill.style.height = `${r10(bar.centred ? Math.abs(pos - 50) : pos)}%`;
      bar.marker.style.bottom = `${pos}%`;
      const n = Math.round(pos);
      if (n !== bar.n) { bar.val.textContent = String(n); bar.n = n; }
    }
    const colour = speedMode ? packRgb(heatRgbInto(f.speeds[bar.i], this._speedRgb)) : -1;
    if (colour !== bar.colour) {
      bar.fill.style.background = colour >= 0 ? rgbCss(colour) : '';
      bar.colour = colour;
    }
  }

  /** The 3D picture: drawn only when a value (to a tenth), the view, the size or a colour changed. */
  _draw3d(f, dpr) {
    const v = f.values;
    const k = this._now3d;
    const I = SIM_AXIS_INDEX;
    k[0] = r10(f.stroke);
    k[1] = r10(v[I.surge]); k[2] = r10(v[I.sway]); k[3] = r10(v[I.twist]); k[4] = r10(v[I.roll]); k[5] = r10(v[I.pitch]);
    k[6] = this._view.yaw; k[7] = this._view.tilt;
    k[8] = sim3dWidth(this._size());
    k[9] = dpr;
    const theme = this._themeColours();
    let sleeve = theme.sleeve;
    if (f.colorMode === 'speed') {
      sleeve = heatRgbInto((f.strokeSpeed || 0) / 1000, this._speedRgb);
      k[10] = (sleeve[0] << 16) | (sleeve[1] << 8) | sleeve[2];
    } else {
      k[10] = -1;
    }
    k[11] = (theme.accent[0] << 16) | (theme.accent[1] << 8) | theme.accent[2];
    let same = true;
    for (let n = 0; n < 12; n++) if (k[n] !== this._last3d[n]) { same = false; break; }
    if (same) return;
    // Only the pose moved (playback): at most one picture per POSE_FRAME_MS
    // (12 ms: 72 a second at 144 Hz); a 120 / 144 Hz display drew it on every frame (Dave, 2026-11-25:
    // "speed up the player when in editor", the 3D picture was a third of the
    // drawing with six axes). A turn, a size, a colour or an invalidate draws
    // at once; a skipped pose is drawn on a later frame (the loop runs every frame).
    let poseOnly = true;
    for (let n = 6; n < 12; n++) if (k[n] !== this._last3d[n]) { poseOnly = false; break; }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (poseOnly && now - this._drawn3dAt < POSE_FRAME_MS) return;
    this._drawn3dAt = now;
    this._last3d.set(k);
    const ctx = this._canvas3d.getContext?.('2d');
    if (!ctx) return;
    const rc = this._receiver;
    this._pose = this._pose || {};
    const p = this._pose;
    p.surge = v[I.surge]; p.sway = v[I.sway]; p.twist = v[I.twist]; p.roll = v[I.roll]; p.pitch = v[I.pitch];
    rc.setView(this._view);
    rc.setPose(p, f.stroke);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rc.draw(ctx, { sleeve, accent: theme.accent, dpr });
    this.draws++;
  }

  /** A solid colour '#rrggbb' as a number, parsed only when the colour changes. */
  _solidNumber(hex) {
    if (hex !== this._solidHex) {
      this._solidHex = hex;
      this._solidNum = parseInt(String(hex || '').slice(1), 16) || 0;
    }
    return this._solidNum;
  }

  /** The 2D looks' line colour as a number: a packed speed colour, or one of the COLOUR_ keys. */
  _lineColourKey(f, speed) {
    if (f.colorMode === 'speed') return packRgb(heatRgbInto(speed, this._speedRgb));
    if (f.colorMode === 'white') return COLOUR_WHITE;
    if (f.colorMode === 'solid' && f.solid) return COLOUR_SOLID;
    return COLOUR_ACCENT;
  }

  _lineColourCss(key, f) {
    if (key >= 0) return rgbCss(key);
    if (key === COLOUR_WHITE) return '#ffffff';
    if (key === COLOUR_SOLID) return f.solid;
    return this._themeColours().accentCss;
  }

  /**
   * A 2D canvas (the drawing, a gauge): drawn only when what it shows
   * changed, compared as numbers (c.key: a small Float64Array).
   */
  _drawCanvas(c, f, dpr) {
    const v = f.values;
    const I = SIM_AXIS_INDEX;
    const now = c.now || (c.now = new Float64Array(9));
    now.fill(0);
    if (c.kind === 'drawing') {
      now[0] = this._lineColourKey(f, (f.strokeSpeed || 0) / 1000);
      now[1] = r10(f.stroke);
      now[2] = r10(v[I.surge]); now[3] = r10(v[I.sway]); now[4] = r10(v[I.twist]); now[5] = r10(v[I.roll]); now[6] = r10(v[I.pitch]);
    } else if (c.kind === 'pad') {
      now[0] = this._lineColourKey(f, Math.max(f.speeds[I.surge], f.speeds[I.sway]));
      now[1] = r10(v[I.surge]); now[2] = r10(v[I.sway]);
    } else {
      now[0] = this._lineColourKey(f, f.speeds[I[c.kind]]);
      now[1] = r10(v[I[c.kind]]);
    }
    now[7] = dpr;
    now[8] = f.colorMode === 'solid' ? this._solidNumber(f.solid) : 0;
    if (c.vals) {
      for (let k = 0; k < c.vals.length; k++) {
        const val = c.vals[k];
        const n = Math.round(v[val.i]);
        if (n !== val.n) { val.b.textContent = String(n); val.n = n; }
      }
    }
    if (c.key) {
      let same = true;
      for (let k = 0; k < 9; k++) if (c.key[k] !== now[k]) { same = false; break; }
      if (same) return;
    }
    c.key = c.key || new Float64Array(9);
    c.key.set(now);
    const colour = this._lineColourCss(now[0], f);
    const ctx = c.cv.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.size, c.size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pose = simPose({ surge: v[I.surge], sway: v[I.sway], twist: v[I.twist], roll: v[I.roll], pitch: v[I.pitch] }, f.stroke);
    if (c.kind === 'drawing') drawLineReceiver(ctx, c.size, pose, colour);
    else drawGauge(ctx, c.kind, c.size, pose, colour);
    this.draws++;
  }

  destroy() {
    this._themeObserver?.disconnect?.();
  }
}

/** The 'drawing' look: the receiver at rest faint, the live one in the colour, the twist dot. */
function drawLineReceiver(ctx, size, pose, colour) {
  const scale = size / 1.6;
  const c = size / 2;
  const at = (p) => [c + p.x * scale, c + p.y * scale];
  const rest = simPose({}, 0);
  rest.y = pose.y;   // the rest pose at the same stroke: what the other axes move it from
  strokeReceiver(ctx, projectReceiver(rest), at, FAINT, 1);
  strokeReceiver(ctx, projectReceiver(pose), at, colour, 1.5);
}

function strokeReceiver(ctx, g, at, colour, width) {
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = width;
  const ringPass = (pts, front) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.front && b.front) !== front) continue;
      ctx.moveTo(...at(a));
      ctx.lineTo(...at(b));
    }
    ctx.stroke();
  };
  ctx.globalAlpha = 0.35;
  ringPass(g.bottom, false);
  ringPass(g.top, false);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const [a, b] of g.sides) { ctx.moveTo(...at(a)); ctx.lineTo(...at(b)); }
  ctx.stroke();
  ringPass(g.bottom, true);
  ringPass(g.top, true);
  if (!g.marker.front) ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(...at(g.topCentre));
  ctx.lineTo(...at(g.marker));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(...at(g.marker), width + 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function capsule(ctx, len, w) {
  // Upright from the pivot (0, 0) up to -len, rounded top, flat base.
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(-w / 2, -len + w / 2);
  ctx.arc(0, -len + w / 2, w / 2, Math.PI, 0);
  ctx.lineTo(w / 2, 0);
  ctx.closePath();
}

/**
 * The 'gauges' look, each matching the 3D receiver's views (SIM_MOTION's
 * directions): twist seen from above (the front, toward the viewer, at the
 * bottom), roll from the front, pitch from the right side (the viewer on the
 * left, marked), surge and sway on a pad seen from above.
 */
function drawGauge(ctx, kind, size, pose, colour) {
  const c = size / 2;
  ctx.lineWidth = 1;
  if (kind === 'twist') {
    const r = size * 0.36;
    // The travel (SIM_MOTION.TWIST_DEG each way) as a faint arc round the rest mark at the bottom.
    const travel = Math.max(Math.abs(simPose({ twist: 0 }).twist), Math.abs(simPose({ twist: 100 }).twist));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c, c, r, Math.PI / 2 - travel, Math.PI / 2 + travel);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = FAINT;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c, c + r);
    ctx.stroke();
    // From above with the viewer at the bottom: the front (0, 0, 1) turned by twist.
    const ex = c + Math.sin(pose.twist) * r;
    const ey = c + Math.cos(pose.twist) * r;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ex, ey, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'roll' || kind === 'pitch') {
    const px = c;
    const py = size * 0.86;
    const len = size * 0.64;
    const w = size * 0.2;
    // Roll from the front: the top's lean to the right. Pitch from the right
    // side (the viewer on the left): the top toward the viewer leans left.
    // (canvas turns are clockwise: + leans right.)
    const a = kind === 'roll' ? pose.roll : -pose.pitch;
    const limit = kind === 'roll'
      ? Math.max(Math.abs(simPose({ roll: 0 }).roll), Math.abs(simPose({ roll: 100 }).roll))
      : Math.max(Math.abs(simPose({ pitch: 0 }).pitch), Math.abs(simPose({ pitch: 100 }).pitch));
    ctx.strokeStyle = FAINT;
    ctx.beginPath();
    ctx.moveTo(size * 0.14, py + 0.5);
    ctx.lineTo(size * 0.86, py + 0.5);
    ctx.stroke();
    ctx.beginPath();
    for (const lim of [-limit, limit]) {
      ctx.moveTo(px + Math.sin(lim) * (len - 2), py - Math.cos(lim) * (len - 2));
      ctx.lineTo(px + Math.sin(lim) * (len + 4), py - Math.cos(lim) * (len + 4));
    }
    ctx.stroke();
    ctx.save();
    ctx.translate(px, py);
    capsule(ctx, len, w);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    capsule(ctx, len, w);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    if (kind === 'pitch') {
      // Which way the viewer is: a small mark on the left of the side view.
      ctx.fillStyle = FAINT;
      ctx.beginPath();
      ctx.moveTo(size * 0.07, py - 3);
      ctx.lineTo(size * 0.14, py - 6);
      ctx.lineTo(size * 0.14, py);
      ctx.closePath();
      ctx.fill();
    }
  } else if (kind === 'pad') {
    // From above, the viewer at the bottom: x to the right, z (toward the viewer) down.
    const half = size * 0.36;
    ctx.strokeStyle = FAINT;
    ctx.strokeRect(c - half + 0.5, c - half + 0.5, half * 2 - 1, half * 2 - 1);
    ctx.beginPath();
    ctx.moveTo(c, c - half);
    ctx.lineTo(c, c + half);
    ctx.moveTo(c - half, c);
    ctx.lineTo(c + half, c);
    ctx.stroke();
    const reach = half - 3;
    const x = c + (pose.x / 0.5) * reach;
    const y = c + (pose.z / 0.5) * reach;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
