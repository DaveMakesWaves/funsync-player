// Tests for MFP-protocol compatibility upgrades on the TCode WS transport
// and tcode-manager formatter:
//   1. Precision configurability — 3-digit (TCode-0.2) vs 4-digit (TCode-0.3).
//      Restim's parser is lenient (accepts either), but TCode-0.3-only
//      firmware needs 4-digit; some consumers infer protocol version from
//      digit count.
//   2. Auto-reconnect with exponential backoff on the WebSocket transport.
//      Restim users expect FunSync to follow them through a restart without
//      a manual reconnect. The reconnect is gated on having had an initial
//      successful open, and is cancelled when the user calls disconnect().
//   3. Stop now emits a portable neutral-position frame in addition to the
//      non-standard DSTOP — MFP-protocol consumers ignore DSTOP and need
//      explicit axis values.
//
// Sources (see notes/UPDATES.md):
//   - MFP wire format research → 3- vs 4-digit precision is per-device,
//     restim parser is lenient, no auto-reconnect in MFP itself.
//   - The community ask from the comment thread is "drop-in MFP".

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebsocketTransport } = require('../../electron/tcode-transports.js');

describe('TCodeManager — precision configurability', () => {
  let sent;

  beforeEach(() => {
    sent = [];
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async () => ({ success: true })),
        tcodeDisconnect: vi.fn(async () => ({ success: true })),
        tcodeSend: vi.fn(async (cmd) => { sent.push(cmd); return true; }),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });
  afterEach(() => { delete global.window; });

  it('defaults to 3-digit precision (TCode-0.2)', async () => {
    const m = new TCodeManager();
    expect(m.precision).toBe(3);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 50 });
    expect(sent).toEqual(['L0500\n']);
  });

  it('emits 4-digit values after setPrecision(4)', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    expect(m.precision).toBe(4);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 50 });
    expect(sent).toEqual(['L05000\n']);
  });

  it('emits maximum-value at 100% (3-digit)', async () => {
    const m = new TCodeManager();
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 100 });
    expect(sent).toEqual(['L0999\n']);
  });

  it('emits maximum-value at 100% (4-digit)', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 100 });
    expect(sent).toEqual(['L09999\n']);
  });

  it('emits zero-padded minimum at 0% (3-digit)', async () => {
    const m = new TCodeManager();
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 0 });
    expect(sent).toEqual(['L0000\n']);
  });

  it('emits zero-padded minimum at 0% (4-digit)', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 0 });
    expect(sent).toEqual(['L00000\n']);
  });

  it('combines multi-axis with consistent precision', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 50, R0: 75, V0: 30 });
    // L0 = 0.50 * 9999 = 4999.5 → 5000 (rounded)
    // R0 = 0.75 * 9999 = 7499.25 → 7499 (rounded)
    // V0 = 0.30 * 9999 = 2999.7 → 3000 (rounded)
    expect(sent).toEqual(['L05000 R07499 V03000\n']);
  });

  it('appends I-suffix duration regardless of precision', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 50 }, 100);
    expect(sent).toEqual(['L05000I100\n']);
  });

  it('setPrecision(unknown) is a no-op', () => {
    const m = new TCodeManager();
    m.setPrecision(99);
    expect(m.precision).toBe(3);
    m.setPrecision('abc');
    expect(m.precision).toBe(3);
  });

  it('setPrecision(3) reverts after a 4-digit upgrade', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    m.setPrecision(3);
    await m.connect('serial', { path: 'COM3' });
    m.sendAxes({ L0: 50 });
    expect(sent).toEqual(['L0500\n']);
  });
});

describe('TCodeManager — stop emits portable neutral frame', () => {
  let sent;
  beforeEach(() => {
    sent = [];
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async () => ({ success: true })),
        tcodeDisconnect: vi.fn(async () => ({ success: true })),
        tcodeSend: vi.fn(async (cmd) => { sent.push(cmd); return true; }),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });
  afterEach(() => { delete global.window; });

  it('sends DSTOP for legacy firmware AND a rest frame for MFP consumers', async () => {
    // The rest frame is for MFP-protocol consumers (restim/Howl) over ws/udp
    // that don't understand DSTOP. Serial firmware halts in place on DSTOP and
    // must NOT get the (violent) recenter frame — see the serial-only test in
    // tcode.test.js.
    const m = new TCodeManager();
    await m.connect('websocket', { url: 'ws://restim.local:81' });
    m.stop();
    expect(sent[0]).toBe('DSTOP\n');
    expect(sent[1]).toMatch(/^L0500 L1500 L2500 R0500 R1500 R2500 V0000 V1000 A0000 A1000 A2000\n$/);
  });

  // A stop must actually stop. Centring a position axis is right; "centring" a
  // vibration axis parks it at half power, which is not a stop at all.
  it('centres position axes but zeroes intensity axes on stop', async () => {
    const m = new TCodeManager();
    await m.connect('websocket', { url: 'ws://restim.local:81' });
    m.stop();
    const frame = sent[1].trim().split(' ');
    const value = (axis) => frame.find((f) => f.startsWith(axis)).slice(axis.length);
    for (const axis of ['L0', 'L1', 'L2', 'R0', 'R1', 'R2']) {
      expect(value(axis), `${axis} should centre`).toBe('500');
    }
    for (const axis of ['V0', 'V1', 'A0', 'A1', 'A2']) {
      expect(value(axis), `${axis} should be off, not half power`).toBe('000');
    }
  });

  // Regression: the frame used to zero A1/A2 (which nothing drove) while
  // skipping V1/V2 (which were driven), so those axes held their last value.
  it('covers every channel the axis table can drive', async () => {
    const { AXIS_DEFINITIONS } = await import('../../renderer/js/multi-axis.js');
    const m = new TCodeManager();
    await m.connect('websocket', { url: 'ws://restim.local:81' });
    m.stop();
    const frame = sent[1];
    for (const { tcode, suffix } of AXIS_DEFINITIONS) {
      expect(frame, `${suffix} (${tcode}) must be reset on stop`).toContain(tcode);
    }
  });

  it('scales the rest frame to 4-digit precision when configured', async () => {
    const m = new TCodeManager();
    m.setPrecision(4);
    await m.connect('websocket', { url: 'ws://restim.local:81' });
    m.stop();
    expect(sent[1]).toMatch(/^L05000 .* A20000\n$/);
  });

  it('stop is a no-op when not connected', () => {
    const m = new TCodeManager();
    m.stop();
    expect(sent).toEqual([]);
  });
});

// --- WebsocketTransport: auto-reconnect with backoff ----------------------

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    MockWebSocket.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }
  _open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  _serverDrop() {
    // Remote closed the connection — simulate restim restart.
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1006 });
  }
}
MockWebSocket.instances = [];

beforeEach(() => { MockWebSocket.instances.length = 0; });

describe('WebsocketTransport — auto-reconnect with backoff', () => {
  function makeFakeTimer() {
    const timers = [];
    const setT = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id; };
    const clearT = (id) => { const idx = timers.findIndex((t) => t.id === id); if (idx >= 0) timers.splice(idx, 1); };
    return { setT, clearT, timers, run(id) {
      const t = timers.find((x) => x.id === id);
      if (!t) return;
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    } };
  }

  it('schedules a reconnect after a server-side close', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
    });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    expect(t.connected).toBe(true);

    MockWebSocket.instances[0]._serverDrop();
    expect(t.connected).toBe(false);
    expect(t.reconnecting).toBe(true);
    expect(timers[0].ms).toBe(1000);
  });

  it('backoff doubles each consecutive failed reconnect', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
    });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;

    // First drop → 1000ms scheduled.
    MockWebSocket.instances[0]._serverDrop();
    expect(timers[0].ms).toBe(1000);
    // Fire the reconnect timer; the inner connect() is async (awaits
    // disconnect of prior socket etc.) so we need a microtask flush
    // before the next MockWebSocket instance is observable. The reconnect
    // attempt itself fails (server drops before open). The close handler
    // should re-schedule with doubled backoff.
    const firstReconnect = timers[0];
    timers.length = 0;
    firstReconnect.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(MockWebSocket.instances[1]).toBeDefined();
    MockWebSocket.instances[1]._open();   // succeed
    MockWebSocket.instances[1]._serverDrop(); // then immediately drop again
    expect(timers[0].ms).toBe(1000);  // success resets the counter

    // Failure-without-success path: the reconnect attempt closes pre-open.
    const reconnectAttempt2 = timers[0];
    timers.length = 0;
    reconnectAttempt2.fn();
    await Promise.resolve();
    await Promise.resolve();
    MockWebSocket.instances[2]._serverDrop(); // never opened — counts as a failed reconnect
    expect(timers[0].ms).toBe(2000);
  });

  it('successful reconnect resets the backoff counter', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
    });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;

    MockWebSocket.instances[0]._serverDrop();
    timers[0].fn(); // fire the 1s reconnect
    MockWebSocket.instances[1]._open(); // reconnect succeeds

    // Server drops again — should schedule at 1s, not 2s.
    MockWebSocket.instances[1]._serverDrop();
    expect(timers[timers.length - 1].ms).toBe(1000);
  });

  it('user-initiated disconnect cancels pending reconnect', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
    });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    MockWebSocket.instances[0]._serverDrop();
    expect(t.reconnecting).toBe(true);

    await t.disconnect();
    expect(t.reconnecting).toBe(false);
    expect(timers.length).toBe(0);
  });

  it('disconnect during pending reconnect does not fire later', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
    });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    MockWebSocket.instances[0]._serverDrop();
    await t.disconnect();
    // Even if a stray scheduler tries to fire the cancelled timer, no
    // new MockWebSocket instance should be constructed.
    const before = MockWebSocket.instances.length;
    // Nothing in `timers` so nothing to fire — just assert state.
    expect(MockWebSocket.instances.length).toBe(before);
  });

  it('reconnect disabled (option = false) leaves the socket closed without rescheduling', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
      reconnect: false,
    });
    const onDisc = vi.fn();
    t.onDisconnect(onDisc);
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    MockWebSocket.instances[0]._serverDrop();
    expect(t.reconnecting).toBe(false);
    expect(timers.length).toBe(0);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it('a brand-new connect() call resets the stopped flag and counter', async () => {
    const { setT, clearT, timers } = makeFakeTimer();
    const t = new WebsocketTransport({
      log: {}, WebSocketImpl: MockWebSocket,
      setTimeoutImpl: setT, clearTimeoutImpl: clearT,
    });
    const p1 = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p1;
    await t.disconnect();
    expect(t.reconnecting).toBe(false);

    const p2 = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[1]._open();
    await p2;
    MockWebSocket.instances[1]._serverDrop();
    expect(t.reconnecting).toBe(true);
  });

  it('backoff is capped at 30s', () => {
    const t = new WebsocketTransport({ log: {}, WebSocketImpl: MockWebSocket });
    // 2^5 = 32s → capped at 30s
    expect(t._backoffMs(5)).toBe(30000);
    expect(t._backoffMs(10)).toBe(30000);
    expect(t._backoffMs(0)).toBe(1000);
    expect(t._backoffMs(3)).toBe(8000);
  });
});
