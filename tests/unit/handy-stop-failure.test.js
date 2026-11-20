/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A failed hsspStop means HARDWARE IS STILL MOVING.
//
// It used to be swallowed: `console.warn` and return as though it worked. The
// device carries on stroking from its own cloud-scheduled playback, the player
// shows paused, and the only trace is a line in a log nobody reads.
// Welliambrisk, EroScripts #328: "if I pause or try to exit that video it just
// keeps playing the script". `HSSP stop error: Update required` is also sitting
// in Sylvain-Et-Un's log.
//
// `hsspPlay` next door always called `_emitError` and returned false. The stop —
// the one where failure has a physical consequence — did neither. These pin the
// asymmetry closed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from '../../renderer/js/sync-engine.js';

function makeEngine({ stopResult = true } = {}) {
  const hsspStop = vi.fn(async () => stopResult);
  const player = { paused: true, video: { addEventListener: vi.fn(), removeEventListener: vi.fn() } };
  const engine = new SyncEngine({
    videoPlayer: player,
    handyManager: { connected: true, hsspStop },
    funscriptEngine: { isLoaded: true, getActions: () => [] },
  });
  engine._active = true;
  engine._scriptReady = true;
  return { engine, hsspStop };
}

describe('SyncEngine._handlePause — failed stop is surfaced', () => {
  let onStopFailed;
  beforeEach(() => { onStopFailed = vi.fn(); });

  it('says nothing when the stop lands', async () => {
    const { engine, hsspStop } = makeEngine({ stopResult: true });
    engine.onStopFailed = onStopFailed;
    await engine._handlePause();
    expect(hsspStop).toHaveBeenCalled();
    expect(onStopFailed).not.toHaveBeenCalled();
  });

  it('FIRES when the stop reports failure — the device may still be running', async () => {
    const { engine } = makeEngine({ stopResult: false });
    engine.onStopFailed = onStopFailed;
    await engine._handlePause();
    expect(onStopFailed).toHaveBeenCalledTimes(1);
  });

  it('treats a legacy undefined return as success, not failure', async () => {
    // Only an explicit `false` means "did not stop". Anything else must stay
    // quiet, or every pause on an older/stubbed manager would cry wolf — and a
    // warning that fires when nothing is wrong stops being read.
    const { engine } = makeEngine({ stopResult: undefined });
    engine.onStopFailed = onStopFailed;
    await engine._handlePause();
    expect(onStopFailed).not.toHaveBeenCalled();
  });

  it('does not throw when no handler is wired', async () => {
    const { engine } = makeEngine({ stopResult: false });
    engine.onStopFailed = null;
    await expect(engine._handlePause()).resolves.not.toThrow();
  });

  it('still bumps the generation counters before stopping', async () => {
    // The supersede-then-stop ordering is what stops an in-flight play from
    // restarting the device after the stop lands. A failed stop must not
    // change that.
    const { engine } = makeEngine({ stopResult: false });
    engine.onStopFailed = onStopFailed;
    const playGen = engine._playGen;
    const pauseGen = engine._pauseGen;
    await engine._handlePause();
    expect(engine._playGen).toBe(playGen + 1);
    expect(engine._pauseGen).toBe(pauseGen + 1);
  });

  it('stays silent while inactive or disconnected', async () => {
    const a = makeEngine({ stopResult: false });
    a.engine._active = false;
    a.engine.onStopFailed = onStopFailed;
    await a.engine._handlePause();

    const b = makeEngine({ stopResult: false });
    b.engine.handy.connected = false;
    b.engine.onStopFailed = onStopFailed;
    await b.engine._handlePause();

    expect(onStopFailed).not.toHaveBeenCalled();
  });
});

describe('handy-manager hsspStop contract', () => {
  const src = require('node:fs').readFileSync('renderer/js/handy-manager.js', 'utf8');

  it('reports failure instead of swallowing it', () => {
    const impl = src.slice(src.indexOf('async _hsspStopImpl('), src.indexOf('setOffset(offsetMs)'));
    expect(impl).toContain('_emitError');
    expect(impl).toMatch(/return false/);
    expect(impl).toMatch(/return true/);
  });

  it('retries once before giving up — a stop is worth a second round trip', () => {
    const impl = src.slice(src.indexOf('async _hsspStopImpl('), src.indexOf('setOffset(offsetMs)'));
    expect(impl).toMatch(/attempt\s*<=\s*2/);
  });

  it('treats "not connected" as a no-op success, so pausing without a device is quiet', () => {
    const impl = src.slice(src.indexOf('async _hsspStopImpl('), src.indexOf('setOffset(offsetMs)'));
    expect(impl).toMatch(/if \(!this\._handy \|\| !this\._connected\) return true;/);
  });
});

describe('connection panel — the connect button is re-enabled', () => {
  it('sets disabled=false in the connected branch', () => {
    // `connecting` disables it; nothing put it back, so a MANUAL connect left
    // the button reading "Disconnect" and permanently greyed out — no way to
    // disconnect and no way to retry. Reproduced on-device 2026-08-26.
    const src = require('node:fs').readFileSync('renderer/components/connection-panel.js', 'utf8');
    const from = src.indexOf("case 'connected':");
    const branch = src.slice(from, src.indexOf("case 'connecting':", from));
    expect(branch).toMatch(/btn\.disabled\s*=\s*false/);
  });
});

// Disconnect must be honoured, and must be announced.
//
// Two faults found together on 2026-08-26. `disconnect()` flipped `_connected`
// and told nobody, so every consumer kept showing whatever it last saw —
// measured live: the manager reporting `connected: false` while the panel sat
// on "Connected" indefinitely, which IS the "the UI just says connected"
// complaint, coming from the app rather than the device. And the SDK can
// re-establish its own session afterwards and fire `connect` again, which was
// accepted — so pressing Disconnect appeared to reconnect on its own.
describe('handy-manager disconnect contract', () => {
  const src = require('node:fs').readFileSync('renderer/js/handy-manager.js', 'utf8');
  const disconnectBody = src.slice(src.indexOf('async disconnect()'), src.indexOf('async _fetchDeviceInfo()'));

  it('notifies listeners, so no consumer is left displaying a stale state', () => {
    expect(disconnectBody).toMatch(/if \(this\.onDisconnect\) this\.onDisconnect\(\)/);
  });

  it('records that the user asked for it', () => {
    expect(disconnectBody).toMatch(/this\._userDisconnected = true/);
  });

  it('resets responsiveness, so a new connection starts from a clean slate', () => {
    expect(disconnectBody).toMatch(/_noteCommandResult\(true\)/);
  });

  it('ignores an SDK-initiated reconnect after a deliberate disconnect', () => {
    const onConnect = src.slice(src.indexOf("this._handy.on('connect'"), src.indexOf("this._handy.on('disconnect'"));
    expect(onConnect).toMatch(/if \(this\._userDisconnected\)/);
    // ...and must bail BEFORE marking connected, or the guard is decorative.
    expect(onConnect.indexOf('_userDisconnected')).toBeLessThan(onConnect.indexOf('this._connected = true'));
  });

  it('an explicit connect() clears the guard, so reconnecting still works', () => {
    const connectBody = src.slice(src.indexOf('async connect(connectionKey)'), src.indexOf('async disconnect()'));
    expect(connectBody).toMatch(/this\._userDisconnected = false/);
  });
});

describe('handy-manager health poll pace', () => {
  const src = require('node:fs').readFileSync('renderer/js/handy-manager.js', 'utf8');

  it('polls faster while a script is playing', () => {
    // During HSSP playback the app sends almost no commands and the drift
    // monitor only reads a cached value, so the poll is the ONLY thing that
    // would notice the device had gone — 10s of "Connected" is too long a lie
    // at exactly that moment.
    const body = src.slice(src.indexOf('setPlaybackActive(playing)'), src.indexOf('async _healthCheckTick()'));
    expect(body).toMatch(/playing \? 3000 : 10000/);
  });

  it('never starts polling a device that is not connected', () => {
    const body = src.slice(src.indexOf('setPlaybackActive(playing)'), src.indexOf('async _healthCheckTick()'));
    expect(body).toMatch(/if \(this\._healthCheckInterval\)/);
  });
});

// Device info must be filled in for EVERY connection, not just button clicks.
//
// `_updateDeviceInfo()` was called only from `_onConnect`/`_onReconnect`, both
// of which run when the user clicks in the panel. Auto-connect at launch goes
// through the manager's `onConnect` callback instead, so the panel sat on "—"
// while `handy.deviceInfo.fwVersion` held "4.2.1+ca4dd961" (measured live,
// 2026-08-26). Not cosmetic: Welliambrisk (#328) reads the presence of that
// field as a signal about which kind of connection he got.
describe('connection panel — device info on any connection', () => {
  const src = require('node:fs').readFileSync('renderer/components/connection-panel.js', 'utf8');

  it('refreshes device info from the manager onConnect callback', () => {
    const handler = src.slice(src.indexOf('this.handy.onConnect ='), src.indexOf('this.handy.onDisconnect ='));
    expect(handler).toMatch(/_updateDeviceInfo\(\)/);
  });

  it('still sets the status in that handler', () => {
    const handler = src.slice(src.indexOf('this.handy.onConnect ='), src.indexOf('this.handy.onDisconnect ='));
    expect(handler).toMatch(/_updateStatus\('connected'\)/);
  });
});

// A pause that arrives WHILE a play is travelling takes a different code path.
//
// `_handlePlaying` notices it was superseded and re-sends the stop — and that
// stop's result used to be thrown away, so the one pause most likely to fail
// (the device is already struggling; that is why the play was slow) was the
// one pause that could fail silently. Welliambrisk's log is exactly this
// shape: his pause landed inside a 20.59s hsspPlay.
describe('SyncEngine._handlePlaying — the supersede stop is surfaced too', () => {
  function makeSupersedeEngine({ stopResult = true, stopThrows = false } = {}) {
    const hsspStop = vi.fn(async () => {
      if (stopThrows) throw new Error('Device timeout');
      return stopResult;
    });
    // The pause lands while this play is in flight.
    let engine;
    const hsspPlay = vi.fn(async () => { engine._pauseGen++; return true; });
    const player = {
      paused: false,
      currentTime: 5,
      video: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    };
    engine = new SyncEngine({
      videoPlayer: player,
      handyManager: { connected: true, hsspStop, hsspPlay },
      funscriptEngine: { isLoaded: true, getActions: () => [] },
    });
    engine._active = true;
    engine._scriptReady = true;
    return { engine, hsspStop, hsspPlay };
  }

  it('re-sends the stop when a pause superseded the play', async () => {
    const { engine, hsspStop } = makeSupersedeEngine();
    const onStopFailed = vi.fn();
    engine.onStopFailed = onStopFailed;
    await engine._handlePlaying();
    expect(hsspStop).toHaveBeenCalledTimes(1);
    expect(onStopFailed).not.toHaveBeenCalled();
  });

  it('tells the user when that re-sent stop did not land', async () => {
    const { engine } = makeSupersedeEngine({ stopResult: false });
    const onStopFailed = vi.fn();
    engine.onStopFailed = onStopFailed;
    await engine._handlePlaying();
    expect(onStopFailed).toHaveBeenCalledTimes(1);
  });

  it('tells the user when that re-sent stop threw', async () => {
    const { engine } = makeSupersedeEngine({ stopThrows: true });
    const onStopFailed = vi.fn();
    engine.onStopFailed = onStopFailed;
    // Must not propagate — a device that cannot be stopped is already the
    // worse problem, and throwing would take the event handler down with it.
    await expect(engine._handlePlaying()).resolves.toBeUndefined();
    expect(onStopFailed).toHaveBeenCalledTimes(1);
  });
});

// The drift monitor is allowed to restart the device. It must not do so after
// the user has paused.
//
// `syncTime` and `hsspStop` are both cloud round trips; on the link in
// Welliambrisk's log they could together span seconds. The paused check
// happened once, before all of that, so a pause arriving mid-correction was
// answered with an app-generated hsspPlay — the app itself resuming a device
// the user had stopped.
describe('SyncEngine._checkDrift — a pause mid-correction wins', () => {
  function makeDriftEngine() {
    const hsspStop = vi.fn(async () => true);
    const hsspPlay = vi.fn(async () => true);
    const syncTime = vi.fn(async () => ({ avgRtd: 10 }));
    const player = {
      paused: false,
      currentTime: 5,
      video: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    };
    const engine = new SyncEngine({
      videoPlayer: player,
      handyManager: {
        connected: true, hsspStop, hsspPlay, syncTime,
        syncQuality: { avgRtd: 500 },   // over the 200ms re-anchor threshold
      },
      funscriptEngine: { isLoaded: true, getActions: () => [] },
    });
    engine._active = true;
    engine._scriptReady = true;
    return { engine, player, hsspStop, hsspPlay };
  }

  it('re-anchors normally while playback continues', async () => {
    const { engine, hsspStop, hsspPlay } = makeDriftEngine();
    await engine._checkDrift();
    expect(hsspStop).toHaveBeenCalledTimes(1);
    expect(hsspPlay).toHaveBeenCalledTimes(1);
  });

  it('does NOT replay when the video paused during the correction', async () => {
    const { engine, player, hsspStop, hsspPlay } = makeDriftEngine();
    hsspStop.mockImplementation(async () => { player.paused = true; return true; });
    await engine._checkDrift();
    expect(hsspStop).toHaveBeenCalledTimes(1);
    expect(hsspPlay).not.toHaveBeenCalled();
  });

  it('does NOT replay when a pause event fired during the correction', async () => {
    // The element's `paused` flag can lag behind the pause a RemotePlaybackProxy
    // reports, so the generation counter is checked as well as the flag.
    const { engine, hsspStop, hsspPlay } = makeDriftEngine();
    hsspStop.mockImplementation(async () => { engine._pauseGen++; return true; });
    await engine._checkDrift();
    expect(hsspPlay).not.toHaveBeenCalled();
  });
});
