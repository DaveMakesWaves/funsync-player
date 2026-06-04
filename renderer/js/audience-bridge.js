// AudienceBridge — fan-out wrapper around N HandyManager instances.
//
// One streamer's FunSync drives up to ~25 viewers' Handys in parallel.
// Each viewer = one HandyManager instance keyed by their Handy
// connection key. The bridge owns the per-viewer lifecycle (connect /
// upload script / sync / play / drift-recover / disconnect) and exposes
// a flat "do this on every viewer in parallel" API the app's existing
// play/pause/seek/load-video hooks fan out through.
//
// Key design constraints baked in here:
//   - `Promise.allSettled` over `Promise.all` everywhere. One viewer
//     failing must not abort the broadcast for the rest.
//   - Every `syncTime()` call follows up with hsspStop + hsspPlay at
//     the current video time, per the memory feedback
//     `feedback_handy_sync_needs_hssp_restart.md` — failing to do this
//     leaves the device unresponsive to subsequent commands.
//   - HandyManager constructor is injected so tests can pass a fake
//     SDK without booting the real one.
//
// SCOPE: notes/features/SCOPE-audience-broadcast.md §4 data model + §5.

const SETTING_VIEWERS = 'audience.viewers';
const SETTING_HIDE_KEYS = 'audience.hideKeys';

/** Per-viewer status enum. Display layer renders LED color + label
 *  from this. */
export const VIEWER_STATUS = Object.freeze({
  IDLE:         'idle',
  CONNECTING:   'connecting',
  UPLOADING:    'uploading',
  CALIBRATING:  'calibrating',
  SYNCED:       'synced',
  PLAYING:      'playing',
  PAUSED:       'paused',
  MUTED:        'muted',
  DISCONNECTED: 'disconnected',
  ERROR:        'error',
});

export class AudienceBridge {
  /**
   * @param {Object} opts
   * @param {Object} opts.settings — dataService handle (get / set)
   * @param {Object} opts.eventBus — pub/sub for cross-component events
   * @param {Function} opts.HandyManagerCtor — `class` of HandyManager.
   *   Production passes the real one; tests inject a fake.
   * @param {Function} [opts.getCurrentVideoTimeMs] — () => ms. Used
   *   when arming a new viewer mid-playback.
   * @param {Function} [opts.isVideoPlaying] — () => bool.
   * @param {Function} [opts.getCurrentScriptUrl] — () => url|null.
   *   When non-null, newly added viewers auto-upload + hsspPlay.
   */
  constructor({
    settings,
    eventBus,
    HandyManagerCtor,
    getCurrentVideoTimeMs = () => 0,
    isVideoPlaying = () => false,
    getCurrentScriptUrl = () => null,
    getStreamerOwnKey = () => null,
  }) {
    this._settings = settings;
    this._bus = eventBus;
    this._HandyManagerCtor = HandyManagerCtor;
    this._getCurrentVideoTimeMs = getCurrentVideoTimeMs;
    this._isVideoPlaying = isVideoPlaying;
    this._getCurrentScriptUrl = getCurrentScriptUrl;
    // Returns the streamer's OWN Handy key (the one connected via the
    // Handy tab) so addViewer can reject self-collisions. Without this
    // guard, pasting your own key as a viewer creates two HandyManager
    // instances racing each other for the same physical device — last
    // command wins on the Handy server, script playback corrupts.
    this._getStreamerOwnKey = getStreamerOwnKey;

    // Map<key, { key, label, offsetMs, manager, status, rtdMs, lastError, muted }>
    this._viewers = new Map();
    this._roomActive = false;
  }

  // --- Lifecycle ---

  /**
   * Open a room. Loads the saved viewer roster from settings but does
   * NOT auto-connect them — the user explicitly adds viewers via the
   * pop-out UI. Roster is just for "remembered names + keys" so the
   * pop-out can pre-fill the list.
   */
  openRoom() {
    if (this._roomActive) return;
    this._roomActive = true;
    console.log('[Audience] Room opened');
    this._emit('audience:room-opened', {});
  }

  /**
   * End the room. Disconnects every viewer, stops every device, clears
   * runtime state. Roster (settings) persists so next session is
   * pre-populated. Safe to call when no room is open (no-op).
   */
  async endRoom() {
    if (!this._roomActive) return;
    const keys = [...this._viewers.keys()];
    console.log(`[Audience] Ending room — tearing down ${keys.length} viewer(s)`);
    await Promise.allSettled(keys.map((k) => this._teardownViewer(k)));
    this._viewers.clear();
    this._roomActive = false;
    console.log('[Audience] Room ended');
    this._emit('audience:room-ended', {});
  }

  get roomActive() {
    return this._roomActive;
  }

  // --- Viewer management ---

  /**
   * Add a viewer. Creates a HandyManager, connects, optionally uploads
   * the current script and starts HSSP at the current video time.
   * Returns the viewer's settled state.
   *
   * @param {{key: string, label?: string, offsetMs?: number}} opts
   */
  async addViewer({ key, label = '', offsetMs = 0 }) {
    if (!key || typeof key !== 'string') {
      throw new Error('addViewer: key required');
    }
    // Self-collision guard. If the streamer pastes their own Handy key
    // as a viewer, refuse — two SDK instances controlling the same
    // device fight over HSSP commands (last-write-wins on the Handy
    // server). The Handy tab already drives this device; routing it
    // through Audience too would just create chaos.
    const ownKey = this._getStreamerOwnKey?.();
    if (ownKey && this._normalizeKey(ownKey) === this._normalizeKey(key)) {
      console.warn(`[Audience] Refused self-key add (${this._maskKey(key)}) — already driven by the Handy tab`);
      const err = new Error("This is your own Handy — it's already controlled by the Handy tab.");
      err.code = 'SELF_KEY';
      throw err;
    }
    if (this._viewers.has(key)) {
      // Duplicate — update the label if provided, no-op on offset.
      const existing = this._viewers.get(key);
      if (label && label !== existing.label) {
        existing.label = label;
        this._persistRoster();
      }
      return this._snapshot(key);
    }

    const viewer = {
      key,
      label,
      offsetMs: Number.isFinite(offsetMs) ? offsetMs : 0,
      manager: null,
      status: VIEWER_STATUS.CONNECTING,
      rtdMs: null,
      lastError: null,
      muted: false,
    };
    this._viewers.set(key, viewer);
    this._persistRoster();
    this._emit('audience:viewer-added', { key, label });
    this._setStatus(key, VIEWER_STATUS.CONNECTING);

    const mask = this._maskKey(key);
    const who = label ? `"${label}" (${mask})` : mask;
    console.log(`[Audience] addViewer ${who} — connecting…`);

    try {
      viewer.manager = new this._HandyManagerCtor();
      // HandyManager requires init() — it loads the SDK ESM bundle and
      // creates this instance's own Handy object — BEFORE connect() will
      // do anything (connect() returns false while `_handy` is null).
      // The SDK's init() returns a FRESH Handy per call, so every viewer
      // gets independent connection state; nothing is shared with the
      // streamer's own Handy or with other viewers. Missing this call was
      // the "Audience connects nothing" bug — the test fake didn't model
      // init(), so the unit suite stayed green while production failed.
      if (typeof viewer.manager.init === 'function') await viewer.manager.init();
      // connect() needs the key as an argument — the constructor does not
      // capture it.
      const ok = await viewer.manager.connect(key);
      if (!ok) throw new Error('Connect failed (device offline, in BT mode, or bad key?)');
      console.log(`[Audience] ${mask} connected`);

      // Apply saved offset if any.
      if (viewer.offsetMs !== 0 && typeof viewer.manager.setOffset === 'function') {
        try {
          await viewer.manager.setOffset(viewer.offsetMs);
          console.log(`[Audience] ${mask} offset applied: ${viewer.offsetMs}ms`);
        } catch (err) {
          console.warn(`[Audience] ${mask} setOffset failed (non-fatal): ${err?.message || err}`);
        }
      }

      // Auto-arm if a script is loaded.
      const url = this._getCurrentScriptUrl();
      if (url) {
        await this._armViewer(viewer, url);
      } else {
        console.log(`[Audience] ${mask} synced — no script loaded yet`);
        this._setStatus(key, VIEWER_STATUS.SYNCED);
      }
    } catch (err) {
      viewer.lastError = err?.message || String(err);
      console.error(`[Audience] ${mask} FAILED to add: ${viewer.lastError}`);
      this._setStatus(key, VIEWER_STATUS.ERROR, { error: viewer.lastError });
    }

    return this._snapshot(key);
  }

  /**
   * Remove a viewer. Stops their device, disconnects, removes from
   * runtime state. Roster entry stays in settings unless `forget` is
   * true.
   */
  async removeViewer(key, { forget = false } = {}) {
    if (!this._viewers.has(key)) return;
    console.log(`[Audience] ${this._maskKey(key)} removed${forget ? ' (forgotten)' : ''}`);
    await this._teardownViewer(key);
    this._viewers.delete(key);
    if (forget) {
      const roster = this._readRoster().filter((v) => v.key !== key);
      this._writeRoster(roster);
    } else {
      this._persistRoster();
    }
    this._emit('audience:viewer-removed', { key });
  }

  setOffsetForViewer(key, ms) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    const clamped = Math.max(-500, Math.min(500, Math.round(Number(ms) || 0)));
    viewer.offsetMs = clamped;
    if (viewer.manager?.setOffset) {
      Promise.resolve(viewer.manager.setOffset(clamped)).catch(() => {});
    }
    this._persistRoster();
    this._emit('audience:viewer-offset', { key, offsetMs: clamped });
  }

  setLabel(key, label) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    viewer.label = String(label || '');
    this._persistRoster();
  }

  async setMuted(key, muted) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    const wasMuted = viewer.muted;
    viewer.muted = !!muted;
    if (wasMuted !== viewer.muted) {
      console.log(`[Audience] ${this._maskKey(key)} ${viewer.muted ? 'muted' : 'unmuted'}`);
    }
    if (!wasMuted && viewer.muted) {
      if (viewer.manager?.hsspStop) await viewer.manager.hsspStop().catch(() => {});
      this._setStatus(key, VIEWER_STATUS.MUTED);
    } else if (wasMuted && !viewer.muted) {
      const url = this._getCurrentScriptUrl();
      if (url && this._isVideoPlaying()) {
        await this._armViewer(viewer, url);
      } else {
        this._setStatus(key, VIEWER_STATUS.SYNCED);
      }
    }
  }

  // --- Fan-out (called by app.js play/pause/seek/load-video hooks) ---

  async uploadScriptToAll(url) {
    if (!this._roomActive) return;
    const results = await Promise.allSettled(
      [...this._viewers.values()]
        .filter((v) => !v.muted && v.manager)
        .map((v) => this._uploadFor(v, url)),
    );
    this._logFanout('uploadScriptToAll', results);
    return results;
  }

  async hsspPlayAll(timeMs) {
    if (!this._roomActive) return;
    const results = await Promise.allSettled(
      [...this._viewers.values()]
        .filter((v) => !v.muted && v.manager)
        .map(async (v) => {
          try {
            await v.manager.hsspPlay(timeMs);
            this._setStatus(v.key, VIEWER_STATUS.PLAYING);
          } catch (err) {
            this._setError(v.key, err);
            throw err;
          }
        }),
    );
    this._logFanout(`hsspPlayAll(${timeMs}ms)`, results);
    return results;
  }

  async hsspStopAll() {
    if (!this._roomActive) return;
    const results = await Promise.allSettled(
      [...this._viewers.values()]
        .filter((v) => v.manager)
        .map(async (v) => {
          try {
            await v.manager.hsspStop();
            if (!v.muted) this._setStatus(v.key, VIEWER_STATUS.PAUSED);
          } catch (err) {
            this._setError(v.key, err);
            throw err;
          }
        }),
    );
    this._logFanout('hsspStopAll', results);
    return results;
  }

  /**
   * Drift-recovery sync. Per the memory feedback, every syncTime() must
   * follow up with hsspStop + hsspPlay at current video time if HSSP
   * was active. Bridge handles that for every viewer in parallel.
   */
  async syncTimeAll() {
    if (!this._roomActive) return;
    const playing = this._isVideoPlaying();
    const timeMs = this._getCurrentVideoTimeMs();
    const results = await Promise.allSettled(
      [...this._viewers.values()]
        .filter((v) => !v.muted && v.manager)
        .map(async (v) => {
          try {
            this._setStatus(v.key, VIEWER_STATUS.CALIBRATING);
            const result = await v.manager.syncTime();
            if (result?.avgRtd != null) v.rtdMs = Math.round(result.avgRtd);
            if (playing) {
              await v.manager.hsspStop();
              await v.manager.hsspPlay(timeMs);
              this._setStatus(v.key, VIEWER_STATUS.PLAYING);
            } else {
              this._setStatus(v.key, VIEWER_STATUS.SYNCED);
            }
          } catch (err) {
            this._setError(v.key, err);
            throw err;
          }
        }),
    );
    this._logFanout('syncTimeAll', results);
    return results;
  }

  /**
   * Test buzz to a single viewer — 200ms 100% pulse via HDSP. Used
   * with a screen flash on the streamer's side for latency calibration.
   */
  async testBuzz(key) {
    const viewer = this._viewers.get(key);
    if (!viewer?.manager?.hdsp) return;
    console.log(`[Audience] ${this._maskKey(key)} test buzz`);
    try {
      await viewer.manager.hdsp(100, 80, 'percent', 'time', false, false);
      // Settle to bottom 200ms later
      setTimeout(() => {
        viewer.manager.hdsp?.(0, 200, 'percent', 'time', false, false).catch(() => {});
      }, 200);
    } catch { /* swallow — calibration is best-effort */ }
  }

  async testBuzzAll() {
    if (!this._roomActive) return;
    await Promise.allSettled(
      [...this._viewers.keys()].map((k) => this.testBuzz(k)),
    );
  }

  // --- State accessors ---

  /** Array of plain-object viewer snapshots (no live HandyManager refs). */
  get viewers() {
    return [...this._viewers.keys()].map((k) => this._snapshot(k));
  }

  getViewerStatus(key) {
    const v = this._viewers.get(key);
    return v ? v.status : null;
  }

  /**
   * Aggregate status for the tab LED. Green if all viewers SYNCED /
   * PLAYING / PAUSED, yellow if any transitional (CONNECTING / UPLOADING
   * / CALIBRATING), red if any ERROR / DISCONNECTED, dim if no room.
   */
  get aggregateStatus() {
    if (!this._roomActive || this._viewers.size === 0) return 'dim';
    const statuses = [...this._viewers.values()].map((v) => v.status);
    if (statuses.some((s) => s === VIEWER_STATUS.ERROR || s === VIEWER_STATUS.DISCONNECTED)) return 'error';
    if (statuses.some((s) =>
      s === VIEWER_STATUS.CONNECTING ||
      s === VIEWER_STATUS.UPLOADING ||
      s === VIEWER_STATUS.CALIBRATING,
    )) return 'warning';
    return 'connected';
  }

  // --- Internals ---

  /**
   * Arm a viewer: upload script + run sync + start HSSP at current
   * video time. Idempotent — safe to call on a re-arming viewer.
   */
  async _armViewer(viewer, url) {
    const mask = this._maskKey(viewer.key);
    try {
      this._setStatus(viewer.key, VIEWER_STATUS.UPLOADING);
      console.log(`[Audience] ${mask} uploading script…`);
      await viewer.manager.setupScript(url);

      this._setStatus(viewer.key, VIEWER_STATUS.CALIBRATING);
      const sync = await viewer.manager.syncTime();
      if (sync?.avgRtd != null) viewer.rtdMs = Math.round(sync.avgRtd);

      if (this._isVideoPlaying()) {
        const t = this._getCurrentVideoTimeMs();
        await viewer.manager.hsspPlay(t);
        console.log(`[Audience] ${mask} playing at ${t}ms (RTD ${viewer.rtdMs ?? '?'}ms)`);
        this._setStatus(viewer.key, VIEWER_STATUS.PLAYING);
      } else {
        console.log(`[Audience] ${mask} synced + armed (RTD ${viewer.rtdMs ?? '?'}ms)`);
        this._setStatus(viewer.key, VIEWER_STATUS.SYNCED);
      }
    } catch (err) {
      console.error(`[Audience] ${mask} arm failed: ${err?.message || err}`);
      this._setError(viewer.key, err);
      throw err;
    }
  }

  async _uploadFor(viewer, url) {
    try {
      this._setStatus(viewer.key, VIEWER_STATUS.UPLOADING);
      await viewer.manager.setupScript(url);
      this._setStatus(viewer.key, VIEWER_STATUS.SYNCED);
    } catch (err) {
      this._setError(viewer.key, err);
      throw err;
    }
  }

  async _teardownViewer(key) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    if (viewer.manager) {
      try {
        if (typeof viewer.manager.hsspStop === 'function') await viewer.manager.hsspStop();
        if (typeof viewer.manager.disconnect === 'function') await viewer.manager.disconnect();
      } catch { /* viewer may already be disconnected — fine */ }
      viewer.manager = null;
    }
    this._setStatus(key, VIEWER_STATUS.DISCONNECTED);
  }

  _setStatus(key, status, extra = {}) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    viewer.status = status;
    if (extra.error !== undefined) viewer.lastError = extra.error;
    this._emit('audience:viewer-status', {
      key,
      status,
      rtdMs: viewer.rtdMs,
      lastError: viewer.lastError,
    });
  }

  _setError(key, err) {
    const msg = err?.message || String(err);
    const viewer = this._viewers.get(key);
    if (viewer) viewer.lastError = msg;
    this._setStatus(key, VIEWER_STATUS.ERROR, { error: msg });
  }

  _snapshot(key) {
    const v = this._viewers.get(key);
    if (!v) return null;
    return {
      key: v.key,
      label: v.label,
      offsetMs: v.offsetMs,
      status: v.status,
      rtdMs: v.rtdMs,
      lastError: v.lastError,
      muted: v.muted,
    };
  }

  _emit(event, payload) {
    if (this._bus?.emit) this._bus.emit(event, payload);
  }

  /** Normalize a key for self-collision comparison. Trims whitespace +
   *  case-folds — some scripters paste with surrounding spaces or wrong
   *  case from Discord. */
  _normalizeKey(k) {
    return String(k || '').trim().toLowerCase();
  }

  /** Mask a Handy key for logging. Keys are passwords (SCOPE §2) and logs
   *  get shared publicly when users report problems — never log a full key.
   *  Shows the last 4 chars only, enough to correlate a viewer across lines. */
  _maskKey(k) {
    const s = String(k || '');
    return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
  }

  /**
   * Summarize a fan-out Promise.allSettled result for the log. Successes
   * go to console.debug (DevTools only — these fire per play/seek and would
   * flood the file); any failures go to console.warn (forwarded to the file)
   * so a broadcast-wide problem is always captured.
   */
  _logFanout(op, results) {
    if (!Array.isArray(results)) return;
    const failed = results.filter((r) => r.status === 'rejected');
    const ok = results.length - failed.length;
    if (failed.length) {
      const reasons = failed.map((r) => r.reason?.message || String(r.reason)).join('; ');
      console.warn(`[Audience] ${op}: ${ok}/${results.length} ok, ${failed.length} failed — ${reasons}`);
    } else {
      console.debug(`[Audience] ${op}: ${ok}/${results.length} ok`);
    }
  }

  // --- Settings roster ---

  _readRoster() {
    const raw = this._settings?.get?.(SETTING_VIEWERS);
    return Array.isArray(raw) ? raw : [];
  }

  _writeRoster(arr) {
    this._settings?.set?.(SETTING_VIEWERS, arr);
  }

  _persistRoster() {
    // Save a clean array — no live manager refs, no transient runtime
    // state. Just the rejoin-next-session essentials.
    const roster = [...this._viewers.values()].map((v) => ({
      key: v.key,
      label: v.label,
      offsetMs: v.offsetMs,
    }));
    this._writeRoster(roster);
  }
}
