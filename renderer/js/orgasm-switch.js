// OrgasmSwitch — hold-to-activate "orgasm script" override.
//
// Community request (shy4649, 2026-06-08): mirror MultiFunPlayer's "Orgasm
// Switch" — bind a key that, while held, swaps the device(s) onto a short,
// looping orgasm script WITHOUT pausing the video; release snaps back to the
// main script. See SCOPE-orgasm-switch.md.
//
// SCOPE (local-device-first, per the scope's recommendation):
//   - Drives connected devices DIRECTLY via their managers on a dedicated
//     loop clock (decoupled from video time — this is the hard part the
//     scope flagged). The app stops the normal sync engines while held
//     (onActivate) and restarts them on release (onDeactivate) so the two
//     never fight over the same device.
//   - Multi-source plans (2026-08-04, SCOPE-orgasm-multi-axis-routing.md):
//     `loadPlan()` accepts a resolved plan from orgasm-plan.js — single
//     broadcast, multi-axis (per-TCode-channel scripts + vib channel), or
//     custom routing (per-Buttplug-device scripts). `loadScript()` remains
//     the single-mode entry and builds an equivalent single plan.
//   - All channels share ONE loop clock; loop length comes from the plan
//     (main script's duration). Shorter channel scripts clamp-and-hold —
//     interpolatePosition does that natively. Never per-channel modulo:
//     independent wrapping de-phases choreographed axis bundles.
//   - Buttplug + T-Code are the validated paths (local, instant). Handy is
//     best-effort via HDSP direct-drive when a manager is injected; the app
//     instead engages the HSSP tiled loop (orgasm-handy-engage.js).
//
// Pure + dependency-injected so it unit-tests without real devices or timers.

import { stripBOM } from './funscript-engine.js';
import { interpolatePosition } from './handy-hdsp-sync.js';
import { applyCutoff } from './device-transform-stack.js';

const DEFAULT_TICK_MS = 40;   // ~25 Hz, same cadence as the Buttplug engine
const MIN_POS_DELTA = 1;      // skip sends that wouldn't move the device
// The Handy's HDSP move duration. It must be LONGER than the tick so moves
// overlap into smooth continuous motion — matches the working HandyHdspSync
// engine (100ms). At the tick length (40ms) with stopOnTarget the device
// start-stops and just bumps instead of stroking. See handy-hdsp-sync.js.
const HANDY_MOVE_MS = 100;

export class OrgasmSwitch {
  /**
   * @param {object} deps
   * @param {object} [deps.buttplugManager] — needs { connected, devices[], sendLinear(i,pos,ms) }
   * @param {object} [deps.tcodeManager]    — needs { connected, sendAxes({L0}) }
   * @param {object} [deps.handyManager]    — needs { connected, hdspMove(pos,ms) }
   * @param {() => void} [deps.onActivate]   — app stops the normal sync engines here
   * @param {() => void} [deps.onDeactivate] — app restarts them here (re-anchor at video time)
   * @param {() => boolean} [deps.handyReady] — gate for the Handy send; false while
   *   the app is still awaiting the HSSP→HDSP handoff. Buttplug/T-Code are driven
   *   immediately (local, no mode handshake); the Handy waits so its commands
   *   aren't sent before the device is actually in HDSP mode. Default: always ready.
   * @param {() => number} [deps.now]        — monotonic clock (injected for tests)
   * @param {object} [opts]
   * @param {number} [opts.tickIntervalMs=40]
   */
  constructor({ buttplugManager, tcodeManager, handyManager, onActivate, onDeactivate, handyReady, getCutoff, now } = {}, opts = {}) {
    this.buttplugManager = buttplugManager || null;
    this.tcodeManager = tcodeManager || null;
    this.handyManager = handyManager || null;
    this.onActivate = onActivate || null;
    this.onDeactivate = onDeactivate || null;
    this._handyReady = typeof handyReady === 'function' ? handyReady : (() => true);
    // Per-device output cutoff {min,max}|null resolver — so the orgasm loop
    // respects the same floor/ceiling limits the normal sync engines apply
    // (it drives the managers directly, bypassing the engines otherwise, which
    // let it push devices past the user's configured range).
    this._getCutoff = typeof getCutoff === 'function' ? getCutoff : (() => null);
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;

    this._plan = null;          // resolved drive plan (orgasm-plan.js shape)
    this._actions = null;       // main channel actions (mirror of plan.main)
    this._durationMs = 0;       // plan.loopMs — the shared loop length
    this._active = false;
    this._startMs = 0;
    this._lastSentPos = -1;     // main-channel last-sent (single-mode contract)
    this._chanLast = new Map(); // per-channel last-sent — aux channels must
                                // not be starved by a static main (and vice
                                // versa), so the MIN_POS_DELTA skip is
                                // tracked per channel, not globally.
    this._timer = null;
    // Wrap (don't store a bare reference): the browser/Electron `setInterval`
    // and `clearInterval` MUST be invoked with `this === window`. Storing the
    // bare function and later calling `this._setIntervalImpl(...)` invokes it
    // with `this === this OrgasmSwitch`, which throws "Illegal invocation" in
    // V8/Blink — activate() aborted before starting the loop, so the device
    // just stopped (onActivate ran, no ticks ever fired). The arrow forwards to
    // the global with a correct receiver. Tests still override via setTimerImpl.
    this._setIntervalImpl = (typeof setInterval !== 'undefined') ? ((fn, ms) => setInterval(fn, ms)) : null;
    this._clearIntervalImpl = (typeof clearInterval !== 'undefined') ? ((id) => clearInterval(id)) : null;
  }

  /** Inject timer fns (tests drive the loop synchronously). */
  setTimerImpl(setIntervalImpl, clearIntervalImpl) {
    this._setIntervalImpl = setIntervalImpl;
    this._clearIntervalImpl = clearIntervalImpl;
  }

  /**
   * Load the orgasm script's main-axis actions from raw funscript JSON as a
   * SINGLE-mode plan (broadcast to every connected device kind — the
   * original behavior). Returns true if a usable (>= 2 valid actions)
   * script loaded; false (and clears any prior plan) on bad JSON / missing
   * or too-few actions.
   */
  loadScript(rawContent) {
    if (typeof rawContent !== 'string' || rawContent.length === 0) { this.loadPlan(null); return false; }
    let parsed;
    try { parsed = JSON.parse(stripBOM(rawContent)); } catch { this.loadPlan(null); return false; }
    const actions = Array.isArray(parsed?.actions) ? parsed.actions : null;
    if (!actions) { this.loadPlan(null); return false; }
    const clean = actions
      .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
      .sort((a, b) => a.at - b.at);
    if (clean.length < 2) { this.loadPlan(null); return false; }
    this.loadPlan({
      mode: 'single',
      main: clean,
      loopMs: clean[clean.length - 1].at,
      tcodeAxes: { L0: clean },
      vib: null,
      bpMode: 'broadcast',
      bpRoutes: null,
    });
    return true;
  }

  /**
   * Load a resolved drive plan (orgasm-plan.js shape). Pass null to clear.
   *
   * @param {object|null} plan — { mode, main, loopMs, tcodeAxes, vib,
   *   bpMode: 'broadcast'|'routed'|'keep', bpRoutes }
   * @param {object} [opts]
   * @param {boolean} [opts.preserveClock=false] — keep the running loop's
   *   start time (mid-hold plan swap on a device connect/disconnect: local
   *   channels join/leave live without restarting the pattern). Per-channel
   *   last-sent state is reset either way so every channel re-sends.
   */
  loadPlan(plan, opts = {}) {
    if (!plan || !(plan.loopMs > 0)) {
      this._plan = null;
      this._actions = null;
      this._durationMs = 0;
      this._chanLast = new Map();
      return false;
    }
    this._plan = plan;
    // Main-channel mirrors kept for the single-mode contract (and tests):
    // _actions/_durationMs are the main script + loop length.
    this._actions = plan.main || null;
    this._durationMs = plan.loopMs;
    this._chanLast = new Map();
    if (!opts.preserveClock) this._lastSentPos = -1;
    return true;
  }

  get configured() { return !!this._plan && this._durationMs > 0; }
  get active() { return this._active; }

  /**
   * Begin the orgasm-script loop. Returns a short status string:
   *   'activated' | 'already-active' | 'not-configured' | 'no-timer'
   * On success calls onActivate() (app stops the normal sync engines) and
   * starts the loop with an immediate first tick.
   */
  activate() {
    if (this._active) return 'already-active';
    if (!this.configured) return 'not-configured';
    if (!this._setIntervalImpl) return 'no-timer';
    this._active = true;
    this._startMs = this._now();
    this._lastSentPos = -1;
    this._chanLast = new Map();
    try { this.onActivate?.(); } catch { /* swallow — best-effort */ }
    this._timer = this._setIntervalImpl(() => this._tick(), this._tickMs);
    this._tick();  // respond immediately, don't wait a full interval
    return 'activated';
  }

  /** Stop the loop and hand control back to the normal sync engines. */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._timer && this._clearIntervalImpl) this._clearIntervalImpl(this._timer);
    this._timer = null;
    try { this.onDeactivate?.(); } catch { /* swallow */ }
  }

  /** One loop tick. Exposed for tests that drive it directly. */
  _tick() {
    if (!this._active || !this._plan) return;
    // Loop the orgasm plan on its OWN clock — independent of video.currentTime.
    // This is what lets the toy keep riding the orgasm pattern while the
    // (longer) video plays on underneath. ALL channels share this one clock
    // and the plan's loop length (shorter channel scripts clamp-and-hold).
    const elapsed = Math.max(0, this._now() - this._startMs);
    const loopMs = this._durationMs > 0 ? elapsed % this._durationMs : 0;

    // Main channel (absent in axis-only multi plans). Tracked via
    // _lastSentPos, preserving the original single-mode skip contract.
    let pos = null;
    let prev = null;
    let mainMoved = false;
    if (this._actions) {
      pos = interpolatePosition(this._actions, loopMs);
      if (pos !== null) {
        mainMoved = !(this._lastSentPos >= 0 && Math.abs(pos - this._lastSentPos) < MIN_POS_DELTA);
        prev = this._lastSentPos >= 0 ? this._lastSentPos : pos;
        if (mainMoved) this._lastSentPos = pos;
      }
    }
    this._send(pos, prev ?? pos, mainMoved, loopMs);
  }

  /**
   * Per-channel position with its own MIN_POS_DELTA skip. Returns
   * { pos, prev, moved } or null when the channel can't interpolate.
   */
  _chanPos(key, actions, loopMs) {
    const pos = interpolatePosition(actions, loopMs);
    if (pos === null) return null;
    const last = this._chanLast.get(key);
    if (last !== undefined && Math.abs(pos - last) < MIN_POS_DELTA) {
      return { pos, prev: last, moved: false };
    }
    const prev = last !== undefined ? last : pos;
    this._chanLast.set(key, pos);
    return { pos, prev, moved: true };
  }

  _send(pos, prevPos, mainMoved, loopMs) {
    const plan = this._plan;
    const dur = this._tickMs;

    // --- Buttplug ---
    const bp = this.buttplugManager;
    if (bp?.connected && Array.isArray(bp.devices)) {
      if (plan.bpMode === 'routed' && Array.isArray(plan.bpRoutes)) {
        this._sendBpRouted(bp, plan.bpRoutes, loopMs, dur);
      } else if (plan.bpMode === 'broadcast') {
        this._sendBpBroadcast(bp, plan, pos, prevPos, mainMoved, loopMs, dur);
      }
      // 'keep' (custom plan with no Buttplug routes): the main sync engine
      // still owns Buttplug — send nothing from the finisher loop.
    }

    // --- T-Code: ONE sendAxes call carrying every channel that moved ---
    const tc = this.tcodeManager;
    if (tc?.connected && typeof tc.sendAxes === 'function' && plan.tcodeAxes) {
      const axes = {};
      const cutoff = this._getCutoff('tcode');
      for (const [code, actions] of Object.entries(plan.tcodeAxes)) {
        const ch = this._chanPos(`tcode:${code}`, actions, loopMs);
        if (!ch || !ch.moved) continue;
        // The configured floor/ceiling is a STROKE limit — apply it to L0
        // only; rotation/vibe channels pass through raw.
        axes[code] = code === 'L0' ? applyCutoff(ch.pos, cutoff) : ch.pos;
      }
      if (Object.keys(axes).length > 0) {
        try { tc.sendAxes(axes); } catch { /* */ }
      }
    }

    // --- Handy (HDSP direct-drive when a manager is injected; the app
    //     passes null and engages the HSSP tiled loop instead) ---
    const hy = this.handyManager;
    if (hy?.connected && this._handyReady() && typeof hy.hdspMove === 'function'
        && pos !== null && mainMoved) {
      // Longer move window than the tick → overlapping smooth strokes (matches
      // HandyHdspSync). Passing the tick length made the device bump in place.
      try { hy.hdspMove(applyCutoff(pos, this._getCutoff('handy')), HANDY_MOVE_MS); } catch { /* */ }
    }

    // Throttled diagnostic — shows whether the loop is producing a varying
    // stroke (script playing) or a stuck value. ~2 lines/sec, safe for the log.
    if (mainMoved && pos !== null && (!this._lastLogMs || this._now() - this._lastLogMs > 500)) {
      this._lastLogMs = this._now();
      try { console.log(`[OrgasmSwitch] loop pos=${pos.toFixed(1)} (${plan.mode})`); } catch { /* */ }
    }
  }

  /**
   * Broadcast dispatch (single + multi plans): linear devices ride the main
   * stroke; vibe devices take the dedicated vib channel when the plan has
   * one (position IS intensity — it's an intensity script), else the main
   * stroke's speed-formula intensity; rotate devices take the speed formula.
   * E-stim (canScalar-only) is deliberately NEVER driven — its max-cap +
   * ramp-up safety lives in the sync engine and the finisher must not
   * bypass it.
   */
  _sendBpBroadcast(bp, plan, pos, prevPos, mainMoved, loopMs, dur) {
    const cutoff = this._getCutoff('buttplug');
    const p = pos !== null ? applyCutoff(pos, cutoff) : null;
    const pPrev = applyCutoff(prevPos ?? pos ?? 0, cutoff);
    // Speed-mode intensity for vibrate/rotate — SAME formula as
    // ButtplugSync._computeVibeIntensity's 'speed' branch (units/s
    // normalized against 300), so the finisher feels consistent with
    // normal playback. (Vibe support added 2026-08-04: the loop only drove
    // canLinear strokers — a vibe-only device went SILENT for the hold.)
    const speed = p !== null && dur > 0 ? (Math.abs(p - pPrev) / dur) * 1000 : 0;
    const intensity = Math.min(100, (speed / 300) * 100);

    let vibCh = null;
    if (plan.vib) vibCh = this._chanPos('bp:vib', plan.vib, loopMs);

    for (const dev of bp.devices) {
      if (dev?.canLinear) {
        if (p !== null && mainMoved) {
          try { bp.sendLinear(dev.index, p, dur); } catch { /* per-device best-effort */ }
        }
      } else if (dev?.canVibrate) {
        if (vibCh) {
          if (vibCh.moved) {
            try { bp.sendVibrate(dev.index, Math.max(0, Math.min(100, vibCh.pos))); } catch { /* */ }
          }
        } else if (p !== null && mainMoved) {
          try { bp.sendVibrate(dev.index, intensity); } catch { /* */ }
        }
      }
      if (dev?.canRotate && p !== null && mainMoved) {
        try { bp.sendRotate(dev.index, intensity, p >= pPrev); } catch { /* */ }
      }
    }
  }

  /**
   * Custom-routing dispatch: each matched route drives ONLY its device with
   * its OWN script — linear devices by position, vibe-only by the speed
   * formula, rotate alongside. Devices without a route stay silent for the
   * hold (mirrors _customRoutingActive semantics in normal playback).
   * E-stim: never driven (see _sendBpBroadcast).
   */
  _sendBpRouted(bp, routes, loopMs, dur) {
    const cutoff = this._getCutoff('buttplug');
    for (const r of routes) {
      const ch = this._chanPos(`bp:${r.deviceIndex}`, r.actions, loopMs);
      if (!ch || !ch.moved) continue;
      const dev = bp.devices.find((d) => d && d.index === r.deviceIndex);
      if (!dev) continue;
      const p = applyCutoff(ch.pos, cutoff);
      const pPrev = applyCutoff(ch.prev, cutoff);
      const speed = dur > 0 ? (Math.abs(p - pPrev) / dur) * 1000 : 0;
      const intensity = Math.min(100, (speed / 300) * 100);
      if (dev.canLinear) {
        try { bp.sendLinear(dev.index, p, dur); } catch { /* */ }
      } else if (dev.canVibrate) {
        try { bp.sendVibrate(dev.index, intensity); } catch { /* */ }
      }
      if (dev.canRotate) {
        try { bp.sendRotate(dev.index, intensity, p >= pPrev); } catch { /* */ }
      }
    }
  }
}
