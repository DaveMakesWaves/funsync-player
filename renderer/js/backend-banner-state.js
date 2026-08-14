// When the "backend is not responding" banner may show, and when a
// dismissal is allowed to expire.
//
// Reported by 4wen (thread #262): "It's on the top of the app and i can't
// remove it". The X worked; it just did not stay worked.
//
// The health monitor emits ONLY on state transitions, and the old wiring
// cleared the dismissal flag on every `running`. So the moment the backend
// flapped -- down, recovered, down again -- the dismissal was wiped and the
// banner came straight back. Dave's own logs caught a flap lasting 3.3
// seconds (2026-08-09 14:25:43 down, 14:25:46 running), and because the
// backend goes quiet during a library scan, the flap tends to repeat for as
// long as the scan runs. Dismissal was therefore permanent only in the one
// case where it did not matter (a backend that stayed dead), and useless in
// the case where it did.
//
// A dismissal now survives a flap, but is NOT permanent: after the backend
// has been continuously healthy for a while, a genuinely new outage is
// allowed to speak up again. Otherwise one early dismissal would silence
// the warning for the rest of the session.
//
// The timer is not owned here. Each call returns what the caller should do
// with it, which keeps every rule in this file directly testable without
// fake clocks or a DOM.

/** Continuous healthy time before a dismissal is forgotten. */
export const REARM_AFTER_MS = 60000;

/**
 * @typedef {{visible: boolean, startRearmTimer: boolean, cancelRearmTimer: boolean}} BannerDecision
 */

export class BackendBannerState {
  constructor({ rearmAfterMs = REARM_AFTER_MS } = {}) {
    this.rearmAfterMs = rearmAfterMs;
    this._dismissed = false;
    this._status = 'unknown';
  }

  get dismissed() { return this._dismissed; }
  get status() { return this._status; }

  /**
   * A state transition arrived from the health monitor.
   * @param {'running'|'down'|'restarting'|'unknown'} status
   * @returns {BannerDecision}
   */
  onStatus(status) {
    this._status = status;

    if (status === 'running') {
      // Healthy. Hide it, and if a dismissal is outstanding start counting
      // sustained health towards forgetting it. Crucially the flag is NOT
      // cleared here -- that is the bug this class exists to prevent.
      return {
        visible: false,
        startRearmTimer: this._dismissed,
        cancelRearmTimer: false,
      };
    }

    if (status === 'restarting') {
      // User-initiated and transient. Always worth showing: the only way to
      // reach it is to have pressed the button on a visible banner.
      return { visible: true, startRearmTimer: false, cancelRearmTimer: true };
    }

    if (status === 'down') {
      // Health broke before the re-arm window elapsed, so this is the same
      // episode the user already dismissed, not a new one.
      return {
        visible: !this._dismissed,
        startRearmTimer: false,
        cancelRearmTimer: true,
      };
    }

    // 'unknown' -- nothing has been established yet, say nothing.
    return { visible: false, startRearmTimer: false, cancelRearmTimer: true };
  }

  /**
   * The user pressed the X.
   * @returns {BannerDecision}
   */
  onDismiss() {
    this._dismissed = true;
    return { visible: false, startRearmTimer: false, cancelRearmTimer: true };
  }

  /**
   * The backend stayed healthy for the full window, so a future failure is
   * a new problem rather than the one already waved away.
   * @returns {BannerDecision}
   */
  onRearmTimerFired() {
    this._dismissed = false;
    return { visible: false, startRearmTimer: false, cancelRearmTimer: false };
  }

  /**
   * The user pressed Restart Backend. They are asking to be told how it
   * goes, so any standing dismissal is dropped.
   * @returns {BannerDecision}
   */
  onRestartRequested() {
    this._dismissed = false;
    return { visible: true, startRearmTimer: false, cancelRearmTimer: true };
  }
}
