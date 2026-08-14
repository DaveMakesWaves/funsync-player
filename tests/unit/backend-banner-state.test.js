/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The backend banner's dismiss button has to actually dismiss.
//
// 4wen, thread #262: "It's on the top of the app and i can't remove it".
// The X worked, it just did not stay worked: the old wiring cleared the
// dismissal on every `running` event, so any flap brought the banner back.
// Dave's logs have a 3.3 second flap (2026-08-09 14:25:43 down ->
// 14:25:46 running), and because the backend goes quiet during a library
// scan the flapping repeats for as long as the scan runs.
//
// The two things worth pinning, because they pull against each other:
//   1. a dismissal must SURVIVE a flap, however many times it flaps
//   2. a dismissal must NOT be permanent, or one early click silences a
//      real failure for the rest of the session
import { describe, it, expect } from 'vitest';
import { BackendBannerState, REARM_AFTER_MS } from '../../renderer/js/backend-banner-state.js';

describe('showing and hiding', () => {
  it('shows on down, hides on running', () => {
    const s = new BackendBannerState();
    expect(s.onStatus('down').visible).toBe(true);
    expect(s.onStatus('running').visible).toBe(false);
  });

  it('says nothing before a state has been established', () => {
    const s = new BackendBannerState();
    expect(s.onStatus('unknown').visible).toBe(false);
  });

  it('shows the restarting state', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    expect(s.onStatus('restarting').visible).toBe(true);
  });
});

describe('a dismissal survives flapping', () => {
  // THE REGRESSION. This is 4wen's report, replayed.
  it('does not come back after a single down/up/down flap', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    expect(s.onDismiss().visible).toBe(false);

    // The 2026-08-09 flap: recovered after 3.3s, then failed again.
    expect(s.onStatus('running').visible).toBe(false);
    expect(s.onStatus('down').visible).toBe(false);
  });

  it('stays dismissed across many flaps, which is what a scan produces', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    s.onDismiss();
    for (let i = 0; i < 25; i++) {
      expect(s.onStatus('running').visible).toBe(false);
      expect(s.onStatus('down').visible, `flap ${i} resurrected the banner`).toBe(false);
    }
    expect(s.dismissed).toBe(true);
  });

  // The flag itself must not be cleared on `running`. Asserting only on
  // `visible` would pass even with the old bug, because `running` hides
  // the banner anyway -- the damage only shows on the NEXT failure.
  it('keeps the dismissal flag set through a recovery', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    s.onDismiss();
    s.onStatus('running');
    expect(s.dismissed).toBe(true);
  });

  it('cancels the re-arm timer the moment health breaks again', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    s.onDismiss();
    expect(s.onStatus('running').startRearmTimer).toBe(true);
    // Failing before the window elapses means it was the same episode.
    expect(s.onStatus('down').cancelRearmTimer).toBe(true);
  });
});

describe('a dismissal is not permanent', () => {
  it('is forgotten after sustained health, so a new outage can speak up', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    s.onDismiss();
    s.onStatus('running');
    s.onRearmTimerFired();

    expect(s.dismissed).toBe(false);
    expect(s.onStatus('down').visible).toBe(true);
  });

  it('only starts counting sustained health when something was dismissed', () => {
    const s = new BackendBannerState();
    expect(s.onStatus('running').startRearmTimer).toBe(false);
  });

  it('re-arms on a restart request, since the user asked for the outcome', () => {
    const s = new BackendBannerState();
    s.onStatus('down');
    s.onDismiss();
    expect(s.onRestartRequested().visible).toBe(true);
    expect(s.dismissed).toBe(false);
  });

  it('uses a re-arm window long enough to outlast a scan-length flap', () => {
    // The observed flap was 3.3s; scans run tens of seconds.
    expect(REARM_AFTER_MS).toBeGreaterThanOrEqual(30000);
    expect(new BackendBannerState().rearmAfterMs).toBe(REARM_AFTER_MS);
  });
});

describe('the full 4wen sequence, end to end', () => {
  it('scan flaps are silenced, a later genuine death is not', () => {
    const s = new BackendBannerState({ rearmAfterMs: 60000 });

    // Scan starts, backend goes quiet, banner appears.
    expect(s.onStatus('down').visible).toBe(true);
    // User dismisses it.
    s.onDismiss();
    // Scan continues, backend flaps repeatedly. Silent throughout.
    for (let i = 0; i < 5; i++) {
      expect(s.onStatus('running').visible).toBe(false);
      expect(s.onStatus('down').visible).toBe(false);
    }
    // Scan finishes, backend healthy for a full minute.
    s.onStatus('running');
    s.onRearmTimerFired();
    // Hours later the backend genuinely dies. The user hears about it.
    expect(s.onStatus('down').visible).toBe(true);
  });
});
