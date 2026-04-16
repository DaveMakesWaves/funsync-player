// ButtplugSync — Reliable sync engine for Buttplug.io devices
// Uses setInterval (not RAF) so it survives tab backgrounding.
// Rate-limited to avoid overwhelming Bluetooth, with dirty-check to skip redundant sends.

const TICK_INTERVAL_MS = 40;     // ~25Hz polling — safe for BLE
const MIN_SEND_INTERVAL_MS = 50; // Don't send commands faster than this
const MAX_GAP_MS = 5000;         // Don't send commands for actions more than 5s away
const MIN_POS_DELTA = 0.5;       // Skip sends when position change is < 0.5 (out of 100)

export class ButtplugSync {
  /**
   * @param {object} opts
   * @param {import('./video-player.js').VideoPlayer} opts.videoPlayer
   * @param {import('./buttplug-manager.js').ButtplugManager} opts.buttplugManager
   * @param {import('./funscript-engine.js').FunscriptEngine} opts.funscriptEngine
   */
  constructor({ videoPlayer, buttplugManager, funscriptEngine }) {
    this.player = videoPlayer;
    this.buttplug = buttplugManager;
    this.funscript = funscriptEngine;

    this._active = false;
    this._intervalId = null;
    this._lastActionIndex = -1;
    this._lastSendTime = 0;       // timestamp of last command sent
    this._lastSentPos = -1;       // last position sent (for dirty check)
    this._actions = null;
    this._invertedDevices = new Set();
    this._vibeModeMap = new Map();

    // Callbacks
    this.onSyncStatus = null; // (status: 'synced'|'idle') => {}
  }

  /**
   * Start the sync engine. Call after video and funscript are loaded
   * and a Buttplug device is connected.
   */
  start() {
    if (this._active) return;

    this._active = true;
    this._cacheActions();
    this._bindVideoEvents();

    if (!this.player.paused) {
      this._startScheduler();
    }

    console.log('[ButtplugSync] Started');
  }

  /**
   * Stop the sync engine.
   */
  stop() {
    this._active = false;
    this._unbindVideoEvents();
    this._stopScheduler();
    this._lastActionIndex = -1;
    this._lastSentPos = -1;
    this._lastSendTime = 0;

    console.log('[ButtplugSync] Stopped');
  }

  /**
   * Reload cached actions (e.g. after editor changes).
   */
  reloadActions() {
    this._cacheActions();
    this._lastActionIndex = -1;
    this._lastSentPos = -1;
  }

  // --- Action cache ---

  _cacheActions() {
    if (this.funscript.isLoaded) {
      this._actions = this.funscript.getActions();
    } else {
      this._actions = null;
    }
  }

  // --- Video event wiring ---

  _bindVideoEvents() {
    const video = this.player.video;
    this._onPlaying = () => this._handlePlaying();
    this._onPause = () => this._handlePause();
    this._onSeeked = () => this._handleSeeked();
    this._onEnded = () => this._handleEnded();

    video.addEventListener('playing', this._onPlaying);
    video.addEventListener('pause', this._onPause);
    video.addEventListener('seeked', this._onSeeked);
    video.addEventListener('ended', this._onEnded);
  }

  _unbindVideoEvents() {
    const video = this.player.video;
    if (this._onPlaying) video.removeEventListener('playing', this._onPlaying);
    if (this._onPause) video.removeEventListener('pause', this._onPause);
    if (this._onSeeked) video.removeEventListener('seeked', this._onSeeked);
    if (this._onEnded) video.removeEventListener('ended', this._onEnded);
  }

  _handlePlaying() {
    if (!this._active) return;
    this._resetIndex();
    this._startScheduler();
    this._emitStatus('synced');
  }

  _handlePause() {
    if (!this._active) return;
    this._stopScheduler();
    this.buttplug.stopAll();
    this._lastSentPos = -1;
    this._emitStatus('idle');
  }

  _handleSeeked() {
    if (!this._active) return;
    this._resetIndex();
    this._lastSentPos = -1;
  }

  _handleEnded() {
    if (!this._active) return;
    this._stopScheduler();
    this.buttplug.stopAll();
    this._lastSentPos = -1;
    this._emitStatus('idle');
  }

  // --- Scheduler (setInterval — survives tab backgrounding) ---

  /**
   * Find the action index just before the current video time.
   */
  _resetIndex() {
    if (!this._actions || this._actions.length === 0) {
      this._lastActionIndex = -1;
      return;
    }

    const timeMs = this.player.currentTime * 1000;

    let lo = 0;
    let hi = this._actions.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this._actions[mid].at <= timeMs) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    this._lastActionIndex = result;
  }

  _startScheduler() {
    if (this._intervalId) return;

    this._intervalId = setInterval(() => {
      if (!this._active || this.player.paused) return;
      this._sendPendingActions();
    }, TICK_INTERVAL_MS);
  }

  _stopScheduler() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Core scheduling loop — runs every TICK_INTERVAL_MS.
   *
   * Checks current video time against the action list, catches up if behind,
   * rate-limits to avoid overwhelming BLE, and skips redundant sends.
   */
  _sendPendingActions() {
    if (!this._actions || this._actions.length < 2) return;
    if (!this.buttplug.connected) return;

    const now = performance.now();
    const timeMs = this.player.currentTime * 1000;

    // Rate limit — don't send faster than MIN_SEND_INTERVAL_MS
    if (now - this._lastSendTime < MIN_SEND_INTERVAL_MS) return;

    // Catch up: skip past any actions we've already passed
    while (this._lastActionIndex + 1 < this._actions.length &&
           this._actions[this._lastActionIndex + 1].at <= timeMs) {
      this._lastActionIndex++;
    }

    const nextIdx = this._lastActionIndex + 1;
    if (nextIdx >= this._actions.length) return;

    const currentAction = this._lastActionIndex >= 0 ? this._actions[this._lastActionIndex] : null;
    const nextAction = this._actions[nextIdx];

    if (!currentAction || timeMs < currentAction.at) return;

    const duration = Math.max(MIN_SEND_INTERVAL_MS, nextAction.at - timeMs);

    // Skip if next action is too far away (avoids very slow moves)
    if (duration > MAX_GAP_MS) return;

    // Dirty check — skip if position barely changed
    if (Math.abs(nextAction.pos - this._lastSentPos) < MIN_POS_DELTA) return;

    this._sendToDevices(nextAction.pos, duration, currentAction.pos);
    this._lastActionIndex = nextIdx;
    this._lastSendTime = now;
    this._lastSentPos = nextAction.pos;
  }

  /**
   * Send commands to all connected devices.
   * @param {number} position — target position 0–100
   * @param {number} durationMs — time to reach position
   * @param {number} prevPosition — previous position 0–100
   */
  _sendToDevices(position, durationMs, prevPosition) {
    const devices = this.buttplug.devices;

    for (const dev of devices) {
      const inverted = this._invertedDevices.has(dev.index);
      const pos = inverted ? 100 - position : position;
      const prevPos = inverted ? 100 - prevPosition : prevPosition;

      if (dev.canLinear) {
        this.buttplug.sendLinear(dev.index, pos, durationMs);
      }
      if (dev.canVibrate) {
        const mode = this._vibeModeMap.get(dev.index) || 'speed';
        const intensity = this._computeVibeIntensity(mode, pos, prevPos, durationMs);
        this.buttplug.sendVibrate(dev.index, intensity);
      }
    }
  }

  // --- Per-device settings ---

  setInverted(deviceIndex, inverted) {
    if (inverted) this._invertedDevices.add(deviceIndex);
    else this._invertedDevices.delete(deviceIndex);
  }

  isInverted(deviceIndex) {
    return this._invertedDevices.has(deviceIndex);
  }

  setVibeMode(deviceIndex, mode) {
    this._vibeModeMap.set(deviceIndex, mode);
  }

  getVibeMode(deviceIndex) {
    return this._vibeModeMap.get(deviceIndex) || 'speed';
  }

  /**
   * Compute vibration intensity based on the selected mapping mode.
   * @param {'speed'|'position'|'intensity'} mode
   * @param {number} pos — current position 0–100
   * @param {number} prevPos — previous position 0–100
   * @param {number} durationMs — time between actions
   * @returns {number} intensity 0–100
   */
  _computeVibeIntensity(mode, pos, prevPos, durationMs) {
    switch (mode) {
      case 'position':
        return Math.max(0, Math.min(100, pos));

      case 'intensity': {
        const base = pos * 0.4;
        const posDelta = Math.abs(pos - prevPos);
        const speed = durationMs > 0 ? (posDelta / durationMs) * 1000 : 0;
        const speedComponent = Math.min(100, (speed / 300) * 100) * 0.6;
        return Math.min(100, base + speedComponent);
      }

      case 'speed':
      default: {
        const posDelta = Math.abs(pos - prevPos);
        const speed = durationMs > 0 ? (posDelta / durationMs) * 1000 : 0;
        return Math.min(100, (speed / 300) * 100);
      }
    }
  }

  // --- Internal ---

  _emitStatus(status) {
    if (this.onSyncStatus) this.onSyncStatus(status);
  }
}
