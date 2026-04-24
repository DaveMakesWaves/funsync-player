import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteBridge } from '../../renderer/js/remote-bridge.js';

// Minimal fake WebSocket — supports open/message/close/error event dispatch
// and captures outbound sends for assertions.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this._listeners = { open: [], message: [], close: [], error: [] };
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    (this._listeners[type] || []).push(fn);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._fire('close', {});
  }

  // Test helpers
  _fire(type, evt) {
    for (const fn of this._listeners[type] || []) fn(evt);
  }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this._fire('open', {});
  }
  simulateMessage(obj) {
    this._fire('message', { data: JSON.stringify(obj) });
  }
  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this._fire('close', {});
  }
}
FakeWebSocket.instances = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function latest() { return FakeWebSocket.instances.at(-1); }

describe('RemoteBridge — lifecycle', () => {
  it('connect opens a websocket', () => {
    const b = new RemoteBridge({ port: 5123 });
    b.connect();
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(latest().url).toBe('ws://127.0.0.1:5123/api/remote/sync/observe');
  });

  it('fires onBridgeOpen on socket open', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onBridgeOpen = spy;
    b.connect();
    latest().simulateOpen();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('disconnect closes the socket and stops reconnecting', () => {
    vi.useFakeTimers();
    const b = new RemoteBridge();
    b.connect();
    latest().simulateOpen();
    b.disconnect();
    expect(latest().readyState).toBe(FakeWebSocket.CLOSED);
    // Advance past the reconnect backoff — no new socket should appear.
    vi.advanceTimersByTime(30000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

describe('RemoteBridge — message routing', () => {
  it('routes phone-connected to onPhoneConnected with path', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneConnected = spy;
    b.connect();
    latest().simulateOpen();
    latest().simulateMessage({
      type: 'phone-connected',
      ip: '192.168.1.5',
      videoId: 'abc',
      videoPath: 'D:/VR/x.mp4',
    });
    expect(spy).toHaveBeenCalledWith('192.168.1.5', 'abc', 'D:/VR/x.mp4');
  });

  it('routes phone-disconnected to onPhoneDisconnected', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneDisconnected = spy;
    b.connect();
    latest().simulateOpen();
    latest().simulateMessage({ type: 'phone-disconnected', ip: '1.2.3.4' });
    expect(spy).toHaveBeenCalledWith('1.2.3.4');
  });

  it('routes state to onPhoneState', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneState = spy;
    b.connect();
    latest().simulateOpen();
    const msg = { type: 'state', at: 1000, paused: false };
    latest().simulateMessage(msg);
    expect(spy).toHaveBeenCalledWith(msg, undefined);
  });

  it('routes seek to onPhoneSeek with atMs', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneSeek = spy;
    b.connect();
    latest().simulateOpen();
    latest().simulateMessage({ type: 'seek', at: 5000 });
    expect(spy).toHaveBeenCalledWith(5000, undefined);
  });

  it('routes play/pause/ended', () => {
    const b = new RemoteBridge();
    const play = vi.fn();
    const pause = vi.fn();
    const ended = vi.fn();
    b.onPhonePlay = play;
    b.onPhonePause = pause;
    b.onPhoneEnded = ended;
    b.connect();
    latest().simulateOpen();
    latest().simulateMessage({ type: 'play' });
    latest().simulateMessage({ type: 'pause' });
    latest().simulateMessage({ type: 'ended' });
    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });

  it('phone-replaced fires onPhoneReplaced but NOT a duplicate onPhoneConnected', () => {
    const b = new RemoteBridge();
    const replaced = vi.fn();
    const connected = vi.fn();
    b.onPhoneReplaced = replaced;
    b.onPhoneConnected = connected;
    b.connect();
    latest().simulateOpen();
    // Simulate server sending phone-replaced followed by phone-connected
    latest().simulateMessage({ type: 'phone-replaced', oldIp: '1.1.1.1', newIp: '2.2.2.2' });
    expect(replaced).toHaveBeenCalledWith('1.1.1.1', '2.2.2.2');
    // phone-replaced alone should not fire onPhoneConnected
    expect(connected).not.toHaveBeenCalled();
    // The real phone-connected that follows should fire it
    latest().simulateMessage({ type: 'phone-connected', ip: '2.2.2.2', videoId: 'v' });
    expect(connected).toHaveBeenCalledOnce();
  });

  it('ignores malformed / unknown messages', () => {
    const b = new RemoteBridge();
    const spy = vi.fn();
    b.onPhoneState = spy;
    b.connect();
    latest().simulateOpen();
    latest()._fire('message', { data: 'not valid json' });
    latest().simulateMessage({ type: 'unknown-type', at: 1 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('RemoteBridge — sendToPhone', () => {
  it('sends JSON when the socket is open', () => {
    const b = new RemoteBridge();
    b.connect();
    latest().simulateOpen();
    b.sendToPhone({ type: 'device-status', handy: 'connected' });
    expect(latest().sent.length).toBe(1);
    expect(JSON.parse(latest().sent[0])).toEqual({ type: 'device-status', handy: 'connected' });
  });

  it('drops silently when the socket is not open', () => {
    const b = new RemoteBridge();
    // no connect()
    b.sendToPhone({ type: 'device-status' });
    expect(FakeWebSocket.instances.length).toBe(0);
  });
});

describe('RemoteBridge — reconnect', () => {
  it('schedules a reconnect after close', () => {
    vi.useFakeTimers();
    const b = new RemoteBridge();
    b.connect();
    latest().simulateOpen();
    latest().simulateClose();
    expect(FakeWebSocket.instances.length).toBe(1);
    // Advance past the first backoff
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('backs off exponentially up to 15s cap', () => {
    vi.useFakeTimers();
    const b = new RemoteBridge();
    b.connect();
    // First reconnect after ~1s
    latest().simulateClose();
    vi.advanceTimersByTime(1200);
    expect(FakeWebSocket.instances.length).toBe(2);
    // Second reconnect ~2s
    latest().simulateClose();
    vi.advanceTimersByTime(2200);
    expect(FakeWebSocket.instances.length).toBe(3);
    // Third reconnect ~4s
    latest().simulateClose();
    vi.advanceTimersByTime(4200);
    expect(FakeWebSocket.instances.length).toBe(4);
  });
});
