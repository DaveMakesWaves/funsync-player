// OrgasmSwitch — hold-to-activate "orgasm script" override.
//
// Community request (shy4649, 2026-06-08): mirror MultiFunPlayer's "Orgasm
// Switch" — bind a key that, while held, swaps the device(s) onto a short,
// looping orgasm script WITHOUT pausing the video; release snaps back to the
// main script. See SCOPE-orgasm-switch.md.
//
// PROTOTYPE SCOPE (local-device-first, per the scope's recommendation):
//   - Drives connected devices DIRECTLY via their managers on a dedicated
//     loop clock (decoupled from video time — this is the hard part the
//     scope flagged). The app stops the normal sync engines while held
//     (onActivate) and restarts them on release (onDeactivate) so the two
//     never fight over the same device.
//   - Main stroke axis only. Multi-axis orgasm scripts (companion files /
//     embedded axes) are a follow-up.
//   - Buttplug + T-Code are the validated paths (local, instant). Handy is
//     best-effort via HDSP direct-drive; HSSP re-anchor cost on release is a
//     known limitation (SCOPE §5 pre-cache is the future optimisation).
//
// Pure + dependency-injected so it unit-tests without real devices or timers.

import { stripBOM } from './funscript-engine.js';
import { interpolatePosition } from './handy-hdsp-sync.js';

const DEFAULT_TICK_MS = 40;   // ~25 Hz, same cadence as the Buttplug engine
const MIN_POS_DELTA = 1;      // skip sends that wouldn't move the device

export class OrgasmSwitch {
  /**
   * @param {object} deps
   * @param {object} [deps.buttplugManager] — needs { connected, devices[], sendLinear(i,pos,ms) }
   * @param {object} [deps.tcodeManager]    — needs { connected, sendAxes({L0}) }
   * @param {object} [deps.handyManager]    — needs { connected, hdspMove(pos,ms) }
   * @param {() => void} [deps.onActivate]   — app stops the normal sync engines here
   * @param {() => void} [deps.onDeactivate] — app restarts them here (re-anchor at video time)
   * @param {() => number} [deps.now]        — monotonic clock (injected for tests)
   * @param {object} [opts]
   * @param {number} [opts.tickIntervalMs=40]
   */
  constructor({ buttplugManager, tcodeManager, handyManager, onActivate, onDeactivate, now } = {}, opts = {}) {
    this.buttplugManager = buttplugManager || null;
    this.tcodeManager = tcodeManager || null;
    this.handyManager = handyManager || null;
    this.onActivate = onActivate || null;
    this.onDeactivate = onDeactivate || null;
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;

    this._actions = null;       // sorted [{at,pos}]
    this._durationMs = 0;       // last action's `at` — the loop length
    this._active = false;
    this._startMs = 0;
    this._lastSentPos = -1;
    this._timer = null;
    this._setIntervalImpl = (typeof setInterval !== 'undefined') ? setInterval : null;
    this._clearIntervalImpl = (typeof clearInterval !== 'undefined') ? clearInterval : null;
  }

  /** Inject timer fns (tests drive the loop synchronously). */
  setTimerImpl(setIntervalImpl, clearIntervalImpl) {
    this._setIntervalImpl = setIntervalImpl;
    this._clearIntervalImpl = clearIntervalImpl;
  }

  /**
   * Load the orgasm script's main-axis actions from raw funscript JSON.
   * Returns true if a usable (>= 2 valid actions) script loaded; false (and
   * clears any prior script) on bad JSON / missing or too-few actions.
   */
  loadScript(rawContent) {
    this._actions = null;
    this._durationMs = 0;
    if (typeof rawContent !== 'string' || rawContent.length === 0) return false;
    let parsed;
    try { parsed = JSON.parse(stripBOM(rawContent)); } catch { return false; }
    const actions = Array.isArray(parsed?.actions) ? parsed.actions : null;
    if (!actions) return false;
    const clean = actions
      .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
      .sort((a, b) => a.at - b.at);
    if (clean.length < 2) return false;
    this._actions = clean;
    this._durationMs = clean[clean.length - 1].at;
    return true;
  }

  get configured() { return !!this._actions && this._durationMs > 0; }
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
    if (!this._active || !this._actions) return;
    // Loop the orgasm script on its OWN clock — independent of video.currentTime.
    // This is what lets the toy keep riding the orgasm pattern while the
    // (longer) video plays on underneath.
    const elapsed = Math.max(0, this._now() - this._startMs);
    const loopMs = this._durationMs > 0 ? elapsed % this._durationMs : 0;
    const pos = interpolatePosition(this._actions, loopMs);
    if (pos === null) return;
    if (this._lastSentPos >= 0 && Math.abs(pos - this._lastSentPos) < MIN_POS_DELTA) return;
    this._lastSentPos = pos;
    this._send(pos);
  }

  _send(pos) {
    const dur = this._tickMs;
    const bp = this.buttplugManager;
    if (bp?.connected && Array.isArray(bp.devices)) {
      for (const dev of bp.devices) {
        if (dev?.canLinear) {
          try { bp.sendLinear(dev.index, pos, dur); } catch { /* per-device best-effort */ }
        }
      }
    }
    const tc = this.tcodeManager;
    if (tc?.connected && typeof tc.sendAxes === 'function') {
      try { tc.sendAxes({ L0: pos }); } catch { /* */ }
    }
    const hy = this.handyManager;
    if (hy?.connected && typeof hy.hdspMove === 'function') {
      try { hy.hdspMove(pos, dur); } catch { /* */ }
    }
  }
}
