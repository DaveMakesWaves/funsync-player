import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionTracker } from '../../renderer/js/session-tracker.js';

/** Minimal in-memory settings stub matching dataService's surface. */
function makeSettings() {
  const store = {};
  return {
    _store: store,
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
  };
}

describe('SessionTracker — session lifecycle', () => {
  let settings, tracker;
  beforeEach(() => {
    settings = makeSettings();
    tracker = new SessionTracker({ settings });
  });

  it('starts with no current session', () => {
    expect(tracker.getSession()).toBe(null);
  });

  it('startSession creates a session with identifier + idle state', () => {
    const s = tracker.startSession('web-remote', '192.168.1.5');
    expect(s.source).toBe('web-remote');
    expect(s.identifier).toBe('192.168.1.5');
    expect(s.state).toBe('idle');
    expect(tracker.getSession()).toBe(s);
  });

  it('emits change event on startSession', () => {
    const spy = vi.fn();
    tracker.addEventListener('change', spy);
    tracker.startSession('vr', 'Quest');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('endSession clears the current session', () => {
    tracker.startSession('vr', 'Quest');
    tracker.endSession();
    expect(tracker.getSession()).toBe(null);
  });

  it('endSession is a no-op when nothing is active', () => {
    expect(() => tracker.endSession()).not.toThrow();
    expect(tracker.getSession()).toBe(null);
  });
});

describe('SessionTracker — mutex (last-wins)', () => {
  let settings, tracker;
  beforeEach(() => {
    settings = makeSettings();
    tracker = new SessionTracker({ settings });
  });

  it('emits mutex-takeover when a second source starts', () => {
    tracker.startSession('vr', 'Quest');
    const spy = vi.fn();
    tracker.addEventListener('mutex-takeover', spy);
    tracker.startSession('web-remote', '192.168.1.5');
    expect(spy).toHaveBeenCalledOnce();
    const ev = spy.mock.calls[0][0];
    expect(ev.detail.evicted.source).toBe('vr');
    expect(ev.detail.incoming.source).toBe('web-remote');
  });

  it('new session replaces the old one', () => {
    tracker.startSession('vr', 'Quest');
    const second = tracker.startSession('web-remote', '192.168.1.5');
    expect(tracker.getSession()).toBe(second);
    expect(tracker.getSession().source).toBe('web-remote');
  });

  it('same source restarting still fires mutex takeover (graceful handover)', () => {
    tracker.startSession('web-remote', '192.168.1.5');
    const spy = vi.fn();
    tracker.addEventListener('mutex-takeover', spy);
    tracker.startSession('web-remote', '192.168.1.9'); // different phone
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('SessionTracker — video + playback state', () => {
  let settings, tracker;
  beforeEach(() => {
    settings = makeSettings();
    tracker = new SessionTracker({ settings });
    tracker.startSession('web-remote', '192.168.1.5');
  });

  it('setVideo populates video fields', () => {
    tracker.setVideo({ name: 'Scene.mp4', videoId: 'abc', duration: 600 });
    const s = tracker.getSession();
    expect(s.videoName).toBe('Scene.mp4');
    expect(s.videoId).toBe('abc');
    expect(s.duration).toBe(600);
  });

  it('setPlayback with paused=false moves state to playing', () => {
    tracker.setVideo({ name: 'X', videoId: 'x' });
    tracker.setState('preparing');
    tracker.setPlayback({ currentTime: 10, paused: false });
    expect(tracker.getSession().state).toBe('playing');
  });

  it('setPlayback with paused=true moves state to paused', () => {
    tracker.setVideo({ name: 'X', videoId: 'x' });
    tracker.markScriptReady(100);
    tracker.setPlayback({ paused: true });
    expect(tracker.getSession().state).toBe('paused');
  });

  it('setPlayback does not override no-script or error states', () => {
    tracker.setVideo({ name: 'X', videoId: 'x' });
    tracker.markScriptMissing();
    tracker.setPlayback({ currentTime: 10, paused: false });
    expect(tracker.getSession().state).toBe('no-script');
  });

  it('markScriptReady promotes from preparing to playing', () => {
    tracker.setVideo({ name: 'X', videoId: 'x' });
    tracker.setState('preparing');
    tracker.markScriptReady(123);
    expect(tracker.getSession().state).toBe('playing');
    expect(tracker.getSession().actionCount).toBe(123);
  });
});

describe('SessionTracker — device status', () => {
  let settings, tracker;
  beforeEach(() => {
    settings = makeSettings();
    tracker = new SessionTracker({ settings });
  });

  it('setDeviceStatus is remembered across session start', () => {
    tracker.setDeviceStatus({ handy: true });
    const s = tracker.startSession('web-remote', 'x');
    expect(s.devices.handy).toBe(true);
  });

  it('setDeviceStatus updates the current session', () => {
    tracker.startSession('web-remote', 'x');
    tracker.setDeviceStatus({ handy: true, buttplug: true });
    expect(tracker.getSession().devices).toMatchObject({ handy: true, buttplug: true });
  });

  it('partial updates merge with prior state', () => {
    tracker.setDeviceStatus({ handy: true });
    tracker.setDeviceStatus({ buttplug: true });
    tracker.startSession('web-remote', 'x');
    expect(tracker.getSession().devices.handy).toBe(true);
    expect(tracker.getSession().devices.buttplug).toBe(true);
  });
});

describe('SessionTracker — history', () => {
  let settings, tracker;
  beforeEach(() => {
    settings = makeSettings();
    tracker = new SessionTracker({ settings });
  });

  it('persists a completed session with a video', () => {
    tracker.startSession('web-remote', '192.168.1.5');
    tracker.setVideo({ name: 'Scene.mp4', videoId: 'abc' });
    tracker.endSession();
    const hist = tracker.getHistory();
    expect(hist.length).toBe(1);
    expect(hist[0].videos[0].name).toBe('Scene.mp4');
  });

  it('does not persist a brief idle-only session', () => {
    tracker.startSession('web-remote', '192.168.1.5');
    tracker.endSession();
    expect(tracker.getHistory().length).toBe(0);
  });

  it('caps history at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      tracker.startSession('web-remote', String(i));
      tracker.setVideo({ name: 'X' + i, videoId: String(i) });
      tracker.endSession();
    }
    expect(tracker.getHistory().length).toBe(50);
  });

  it('orders history newest first', () => {
    tracker.startSession('web-remote', 'first');
    tracker.setVideo({ name: 'A', videoId: '1' });
    tracker.endSession();
    tracker.startSession('web-remote', 'second');
    tracker.setVideo({ name: 'B', videoId: '2' });
    tracker.endSession();
    const hist = tracker.getHistory();
    expect(hist[0].identifier).toBe('second');
    expect(hist[1].identifier).toBe('first');
  });

  it('records mutex-evicted sessions too', () => {
    tracker.startSession('vr', 'Quest');
    tracker.setVideo({ name: 'vr-scene', videoId: '1' });
    tracker.startSession('web-remote', '1.2.3.4'); // kicks VR
    const hist = tracker.getHistory();
    expect(hist.length).toBe(1);
    expect(hist[0].source).toBe('vr');
  });

  it('clearHistory wipes the store', () => {
    tracker.startSession('web-remote', 'x');
    tracker.setVideo({ name: 'X', videoId: '1' });
    tracker.endSession();
    tracker.clearHistory();
    expect(tracker.getHistory().length).toBe(0);
  });
});

describe('SessionTracker — without settings', () => {
  it('works as an in-memory tracker when settings is omitted', () => {
    const tracker = new SessionTracker();
    tracker.startSession('web-remote', 'x');
    tracker.setVideo({ name: 'Y', videoId: '1' });
    tracker.endSession();
    expect(tracker.getHistory()).toEqual([]);
    // No crash — history just isn't persisted.
  });
});
