// SessionTracker — unified state for external-controller sessions
// (Web Remote phone + VR companion bridge).
//
// Responsibilities:
//   1. Maintain the *current* session (at most one — mutex below).
//   2. Enforce the last-wins mutex — when a new session starts while
//      another is active, emit a `mutex-takeover` event so the caller can
//      tear down the losing side's bridge.
//   3. Record a capped history of completed sessions for post-hoc review.
//   4. Emit `change` events with a normalised state shape the UI cards bind to.
//
// This is a pure state + event module. It never touches bridges / WebSockets
// / sync engines directly — app.js wires those to the tracker's events.

const HISTORY_KEY = 'sessions.history';
const HISTORY_MAX = 50;

/** @typedef {'web-remote' | 'vr'} SessionSource */
/** @typedef {'idle' | 'preparing' | 'playing' | 'paused' | 'no-script' | 'error'} SessionState */

/**
 * @typedef Session
 * @property {string}         id             uuid for history correlation
 * @property {SessionSource}  source         'web-remote' | 'vr'
 * @property {string}         identifier     ip / host / player name
 * @property {number}         startedAt      ms since epoch
 * @property {number|null}    endedAt        ms since epoch or null
 * @property {SessionState}   state          current state
 * @property {string|null}    videoName      null when idle
 * @property {string|null}    videoId        null when idle
 * @property {number}         currentTime    seconds
 * @property {number}         duration       seconds
 * @property {object}         devices        { handy, buttplug, tcode, autoblow } booleans — true = actively driven
 * @property {number|null}    actionCount    total actions in current script
 * @property {Array<{name:string, startedAt:number, endedAt:number|null, duration:number}>} videos
 */

export class SessionTracker extends EventTarget {
  constructor({ settings } = {}) {
    super();
    this._settings = settings || null;
    /** @type {Session|null} */
    this._session = null;
    this._lastDeviceStatus = {
      handy: false, buttplug: false, tcode: false, autoblow: false,
    };
  }

  // --- Public read API -----------------------------------------------------

  getSession() { return this._session; }

  getHistory() {
    if (!this._settings) return [];
    return this._settings.get(HISTORY_KEY) || [];
  }

  clearHistory() {
    if (this._settings) this._settings.set(HISTORY_KEY, []);
    this._emit('history-changed');
  }

  // --- Public mutation API (called by app.js) ------------------------------

  /**
   * A new session is starting. If another is already active, ends it first
   * and emits `mutex-takeover` so the caller can tell the old bridge to
   * stand down.
   * @returns {Session}
   */
  startSession(source, identifier) {
    if (this._session) {
      // Mutex — different source kicks the old one.
      const evicted = this._session;
      this._finaliseCurrent('idle');
      this._emit('mutex-takeover', {
        evicted: { source: evicted.source, identifier: evicted.identifier },
        incoming: { source, identifier },
      });
    }

    this._session = {
      id: _uuid(),
      source,
      identifier,
      startedAt: Date.now(),
      endedAt: null,
      state: 'idle',
      videoName: null,
      videoId: null,
      videoPath: null,
      currentTime: 0,
      duration: 0,
      devices: { ...this._lastDeviceStatus },
      actionCount: null,
      videos: [],
    };
    this._emit('change');
    return this._session;
  }

  /** End the active session, persist it to history, clear current. */
  endSession() {
    if (!this._session) return;
    this._finaliseCurrent('idle');
    this._session = null;
    this._emit('change');
  }

  /** Update state-tier (playing/paused/preparing/no-script/error/idle). */
  setState(state) {
    if (!this._session) return;
    if (this._session.state === state) return;
    this._session.state = state;
    this._emit('change');
  }

  /** A video starts playing within the current session. */
  setVideo({ name, videoId, videoPath, duration = 0 }) {
    if (!this._session) return;
    // Close the previous video (if any) into history.
    this._closeCurrentVideoEntry();
    this._session.videoName = name || null;
    this._session.videoId = videoId || null;
    this._session.videoPath = videoPath || null;
    this._session.duration = duration || 0;
    this._session.currentTime = 0;
    this._session.actionCount = null;
    if (name) {
      this._session.videos.push({
        name,
        startedAt: Date.now(),
        endedAt: null,
        duration: duration || 0,
      });
    }
    this._emit('change');
  }

  /** Update playback position from the controlling source. */
  setPlayback({ currentTime, duration, paused } = {}) {
    if (!this._session) return;
    let changed = false;
    if (typeof currentTime === 'number' && this._session.currentTime !== currentTime) {
      this._session.currentTime = currentTime;
      changed = true;
    }
    if (typeof duration === 'number' && duration > 0 && this._session.duration !== duration) {
      this._session.duration = duration;
      changed = true;
    }
    if (typeof paused === 'boolean') {
      const next = paused ? 'paused' : 'playing';
      if (this._session.state !== next
          && (this._session.state === 'playing' || this._session.state === 'paused' || this._session.state === 'preparing')) {
        this._session.state = next;
        changed = true;
      }
    }
    if (changed) this._emit('change');
  }

  /** The desktop found the script and started sync. */
  markScriptReady(actionCount) {
    if (!this._session) return;
    this._session.actionCount = actionCount || null;
    // Promote idle → playing (or leave paused alone).
    if (this._session.state === 'preparing' || this._session.state === 'idle') {
      this._session.state = 'playing';
    }
    this._emit('change');
  }

  markScriptMissing() {
    if (!this._session) return;
    this._session.state = 'no-script';
    this._emit('change');
  }

  /**
   * Snapshot of which devices are currently being driven. Set by app.js
   * whenever the sync-engine → device wiring changes.
   * @param {{handy?:boolean,buttplug?:boolean,tcode?:boolean,autoblow?:boolean}} d
   */
  setDeviceStatus(d) {
    this._lastDeviceStatus = { ...this._lastDeviceStatus, ...d };
    if (!this._session) return;
    this._session.devices = { ...this._lastDeviceStatus };
    this._emit('change');
  }

  // --- Internals -----------------------------------------------------------

  _finaliseCurrent(terminalState) {
    if (!this._session) return;
    this._closeCurrentVideoEntry();
    this._session.state = terminalState;
    this._session.endedAt = Date.now();
    this._appendHistory(this._session);
    this._emit('history-changed');
  }

  _closeCurrentVideoEntry() {
    if (!this._session) return;
    const last = this._session.videos[this._session.videos.length - 1];
    if (last && last.endedAt === null) {
      last.endedAt = Date.now();
      last.duration = Math.max(last.duration, this._session.currentTime || 0);
    }
  }

  _appendHistory(session) {
    if (!this._settings) return;
    const entry = {
      id: session.id,
      source: session.source,
      identifier: session.identifier,
      startedAt: session.startedAt,
      endedAt: session.endedAt || Date.now(),
      videos: session.videos.map(v => ({
        name: v.name,
        startedAt: v.startedAt,
        endedAt: v.endedAt || Date.now(),
        duration: v.duration || 0,
      })),
    };
    // Only record sessions that had a video (skip "connected then left") OR
    // lasted longer than 5 s. Avoids log spam from brief page refreshes.
    const durationMs = entry.endedAt - entry.startedAt;
    if (entry.videos.length === 0 && durationMs < 5000) return;

    const history = this._settings.get(HISTORY_KEY) || [];
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    this._settings.set(HISTORY_KEY, history);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function _uuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  // Fallback for odd test environments
  return 'sid-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}
