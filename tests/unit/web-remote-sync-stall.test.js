/**
 * @vitest-environment jsdom
 * Needs a DOM: remote-sync.js reads the `location` and `document` globals.
 * Do NOT switch this to `node` — see notes/CLAUDE.md "Test environments".
 */
// Pins the 2026-08-18 web-remote sync fixes on RemoteSyncClient:
//
//  1. STALL HONESTY — `state.paused` reports effective playback (element
//     paused OR seeking OR starved buffer), and stall-boundary events each
//     push a state immediately. Regression this pins: during a network seek
//     the element stops firing timeupdate while `paused` stays false, so the
//     desktop proxy extrapolated through the stall and devices played a
//     timeline the video had left ("video takes 4s to jump but the script
//     continues playing", EroScripts thread).
//  2. RECONNECT — capped-backoff reconnect after an unexpected close. The
//     file's header always CLAIMED reconnect; there was no code. One Wi-Fi
//     blip silently ended device sync for the rest of the video.
//  3. HIDDEN-START GUARD — `play` while the page is already hidden pauses
//     instead of starting a session that can never stream state (the
//     visibilitychange guard only fires on a TRANSITION).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteSyncClient } from '../../backend/web-remote/remote-sync.js';

class MockSocket {
  constructor() {
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this._listeners = {};
  }
  addEventListener(name, fn) {
    (this._listeners[name] = this._listeners[name] || []).push(fn);
  }
  removeEventListener(name, fn) {
    const arr = this._listeners[name];
    if (!arr) return;
    this._listeners[name] = arr.filter(f => f !== fn);
  }
  send(data) { this.sent.push(data); }
  close() {
    this.readyState = 3;
    this._fire('close', {});
  }
  _fire(name, evt) {
    for (const fn of this._listeners[name] || []) fn(evt);
  }
  _open() {
    this.readyState = 1;
    this._fire('open', {});
  }
  _message(msg) {
    this._fire('message', { data: JSON.stringify(msg) });
  }
}

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

let sockets;
function FakeWebSocket() {
  const s = new MockSocket();
  sockets.push(s);
  return s;
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

function setHidden(hidden) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

beforeEach(() => {
  sockets = [];
  globalThis.WebSocket = FakeWebSocket;
  setHidden(false);
});
afterEach(() => {
  globalThis.WebSocket = ORIGINAL_WEBSOCKET;
  setHidden(false);
  vi.useRealTimers();
});

function makeVideoStub(over = {}) {
  const listeners = {};
  const stub = {
    paused: false,
    seeking: false,
    readyState: 4, // HAVE_ENOUGH_DATA
    duration: 100,
    currentTime: 10,
    playbackRate: 1,
    pause: vi.fn(),
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    removeEventListener: (n, f) => {
      listeners[n] = (listeners[n] || []).filter(x => x !== f);
    },
    _fire: (n) => { for (const f of listeners[n] || []) f(); },
    _listeners: listeners,
  };
  return Object.assign(stub, over);
}

function startedClient(video) {
  const client = new RemoteSyncClient({ video, videoId: 'vid1' });
  client.start();
  sockets[0]._open();
  return client;
}

function lastStateMsg(socket) {
  const states = socket.sent.map(s => JSON.parse(s)).filter(m => m.type === 'state');
  return states[states.length - 1];
}

describe('RemoteSyncClient — stall-honest state.paused', () => {
  it('reports paused:false during normal playback', () => {
    const video = makeVideoStub();
    const client = startedClient(video);
    expect(lastStateMsg(sockets[0]).paused).toBe(false);
    client.stop();
  });

  it('reports paused:true while the element is seeking, even with paused=false', () => {
    const video = makeVideoStub({ seeking: true });
    const client = startedClient(video);
    expect(video.paused).toBe(false);
    expect(lastStateMsg(sockets[0]).paused).toBe(true);
    client.stop();
  });

  it('reports paused:true while the buffer is starved (readyState < HAVE_FUTURE_DATA)', () => {
    const video = makeVideoStub({ readyState: 2 });
    const client = startedClient(video);
    expect(lastStateMsg(sockets[0]).paused).toBe(true);
    client.stop();
  });

  it('each stall-boundary event pushes a state immediately (timeupdate stops during stalls)', () => {
    const video = makeVideoStub();
    const client = startedClient(video);
    for (const ev of ['seeking', 'waiting', 'stalled', 'playing', 'canplay']) {
      const before = sockets[0].sent.length;
      video._fire(ev);
      expect(sockets[0].sent.length, `${ev} must send`).toBe(before + 1);
      expect(JSON.parse(sockets[0].sent[before]).type).toBe('state');
    }
    client.stop();
  });

  it('stall → recovery round-trips the paused bit (this is what stops and restarts devices)', () => {
    const video = makeVideoStub();
    const client = startedClient(video);
    video.seeking = true;
    video.readyState = 1;
    video._fire('seeking');
    expect(lastStateMsg(sockets[0]).paused).toBe(true);
    video.seeking = false;
    video.readyState = 4;
    video._fire('playing');
    expect(lastStateMsg(sockets[0]).paused).toBe(false);
    client.stop();
  });
});

describe('RemoteSyncClient — reconnect', () => {
  it('reconnects with backoff after an unexpected close', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const client = startedClient(video);
    sockets[0].close();
    expect(sockets.length).toBe(1);
    vi.advanceTimersByTime(1000); // first retry after 1s
    expect(sockets.length).toBe(2);
    client.stop();
  });

  it('doubles the delay per attempt and caps it', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const client = startedClient(video);
    sockets[0].close();
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(2);
    sockets[1].close();           // second failure
    vi.advanceTimersByTime(1999);
    expect(sockets.length).toBe(2); // 2s backoff not yet elapsed
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(3);
    client.stop();
  });

  it('a successful open resets the backoff', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const client = startedClient(video);
    sockets[0].close();
    vi.advanceTimersByTime(1000);
    sockets[1]._open();           // healthy again
    sockets[1].close();           // then drops once more
    vi.advanceTimersByTime(1000); // back to the 1s first-retry delay
    expect(sockets.length).toBe(3);
    client.stop();
  });

  it('re-sends hello on the reconnected socket', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const client = startedClient(video);
    sockets[0].close();
    vi.advanceTimersByTime(1000);
    sockets[1]._open();
    const types = sockets[1].sent.map(s => JSON.parse(s).type);
    expect(types[0]).toBe('hello');
    client.stop();
  });

  it('never reconnects after stop()', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const client = startedClient(video);
    client.stop();
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(1);
  });

  it('never reconnects after a kick', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const onKicked = vi.fn();
    const client = new RemoteSyncClient({ video, videoId: 'vid1', onKicked });
    client.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'kicked', reason: 'replaced' });
    sockets[0].close();
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(1);
    expect(onKicked).toHaveBeenCalled();
  });

  it('waits for visibility instead of reconnecting while hidden, then reconnects on unhide', () => {
    vi.useFakeTimers();
    const video = makeVideoStub();
    const client = startedClient(video);
    setHidden(true);
    sockets[0].close();
    vi.advanceTimersByTime(60000);
    expect(sockets.length).toBe(1); // hidden: no reconnect churn
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sockets.length).toBe(2); // immediate, not backoff-delayed
    client.stop();
  });
});

describe('RemoteSyncClient — hidden-start guard', () => {
  it('pauses instead of reporting play when the page is already hidden', () => {
    const video = makeVideoStub();
    const client = startedClient(video);
    setHidden(true);
    const before = sockets[0].sent.length;
    video._fire('play');
    expect(video.pause).toHaveBeenCalled();
    expect(sockets[0].sent.length).toBe(before); // no play message escaped
    client.stop();
  });

  it('reports play normally when visible', () => {
    const video = makeVideoStub();
    const client = startedClient(video);
    const before = sockets[0].sent.length;
    video._fire('play');
    expect(video.pause).not.toHaveBeenCalled();
    expect(JSON.parse(sockets[0].sent[before]).type).toBe('play');
    client.stop();
  });
});
