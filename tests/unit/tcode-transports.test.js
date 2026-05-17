// Tests for the main-process TCode transport classes.
//
// Community feedback (GGEZGitGud, 2026-05-15) drove two new transports
// alongside the existing serial path: UDP (for 2.4GHz wireless TCode
// receivers — "should be more stable than Bluetooth") and WebSocket.
//
// These tests exercise the UdpTransport and WebsocketTransport classes
// via injected socket factories so we don't actually open ports during
// CI. SerialTransport is exercised indirectly via the IPC handler
// integration tests; the heart of the change is the transport contract.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const transportsPath = require.resolve('../../electron/tcode-transports.js');
// eslint-disable-next-line import/no-dynamic-require
const { UdpTransport, WebsocketTransport, createTransport } = require(transportsPath);

function makeFakeUdpSocket() {
  const handlers = new Map();
  const sent = [];
  return {
    bind(cb) { setImmediate(cb); },
    on(event, fn) { handlers.set(event, fn); },
    send(buf, _offset, _len, port, host, cb) {
      sent.push({ data: buf.toString('utf8'), host, port });
      if (cb) cb(null);
    },
    close(cb) { if (cb) setImmediate(cb); },
    _fire(event, payload) { handlers.get(event)?.(payload); },
    _sent: sent,
  };
}

describe('UdpTransport — connect contract', () => {
  it('rejects without a host', async () => {
    const t = new UdpTransport({ log: { warn: () => {} } });
    const result = await t.connect({ port: 9000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/host/i);
  });

  it('rejects without a port', async () => {
    const t = new UdpTransport({ log: { warn: () => {} } });
    const result = await t.connect({ host: '1.2.3.4' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/port/i);
  });

  it('rejects a port outside 1-65535', async () => {
    const t = new UdpTransport({ log: { warn: () => {} } });
    expect((await t.connect({ host: '1.2.3.4', port: 0 })).success).toBe(false);
    expect((await t.connect({ host: '1.2.3.4', port: 70000 })).success).toBe(false);
    expect((await t.connect({ host: '1.2.3.4', port: -1 })).success).toBe(false);
  });

  it('rejects a non-integer port', async () => {
    const t = new UdpTransport({ log: { warn: () => {} } });
    expect((await t.connect({ host: '1.2.3.4', port: 12.5 })).success).toBe(false);
    expect((await t.connect({ host: '1.2.3.4', port: 'abc' })).success).toBe(false);
  });

  it('resolves with success after binding the socket', async () => {
    const fake = makeFakeUdpSocket();
    const t = new UdpTransport({
      log: { info: () => {} },
      dgramFactory: () => fake,
    });
    const result = await t.connect({ host: '1.2.3.4', port: 8080 });
    expect(result.success).toBe(true);
    expect(t.connected).toBe(true);
  });

  it('tears down any previous socket on reconnect', async () => {
    const first = makeFakeUdpSocket();
    const second = makeFakeUdpSocket();
    const sockets = [first, second];
    const closeSpy = vi.spyOn(first, 'close');
    const t = new UdpTransport({
      log: { info: () => {} },
      dgramFactory: () => sockets.shift(),
    });
    await t.connect({ host: '1.2.3.4', port: 8080 });
    await t.connect({ host: '5.6.7.8', port: 9090 });
    expect(closeSpy).toHaveBeenCalled();
  });
});

describe('UdpTransport — send', () => {
  it('returns false when not connected', () => {
    const t = new UdpTransport({ log: {} });
    expect(t.send('L0500\n')).toBe(false);
  });

  it('writes the encoded command to the configured host:port', async () => {
    const fake = makeFakeUdpSocket();
    const t = new UdpTransport({
      log: { info: () => {} },
      dgramFactory: () => fake,
    });
    await t.connect({ host: '1.2.3.4', port: 8080 });
    expect(t.send('L0500 R0750\n')).toBe(true);
    expect(fake._sent).toEqual([{ data: 'L0500 R0750\n', host: '1.2.3.4', port: 8080 }]);
  });

  it('returns false after disconnect', async () => {
    const fake = makeFakeUdpSocket();
    const t = new UdpTransport({
      log: { info: () => {} },
      dgramFactory: () => fake,
    });
    await t.connect({ host: '1.2.3.4', port: 8080 });
    await t.disconnect();
    expect(t.send('L0500\n')).toBe(false);
    expect(t.connected).toBe(false);
  });
});

describe('UdpTransport — disconnect / errors', () => {
  it('fires onDisconnect when the socket errors', async () => {
    const fake = makeFakeUdpSocket();
    const onDisc = vi.fn();
    const t = new UdpTransport({
      log: { warn: () => {} },
      dgramFactory: () => fake,
    });
    t.onDisconnect(onDisc);
    await t.connect({ host: '1.2.3.4', port: 8080 });
    fake._fire('error', new Error('EHOSTUNREACH'));
    expect(onDisc).toHaveBeenCalledTimes(1);
    expect(t.connected).toBe(false);
  });

  it('destroy() is idempotent', async () => {
    const fake = makeFakeUdpSocket();
    const t = new UdpTransport({
      log: { info: () => {} },
      dgramFactory: () => fake,
    });
    await t.connect({ host: '1.2.3.4', port: 8080 });
    expect(() => { t.destroy(); t.destroy(); t.destroy(); }).not.toThrow();
    expect(t.connected).toBe(false);
  });

  it('destroy() detaches the onDisconnect callback', async () => {
    const fake = makeFakeUdpSocket();
    const onDisc = vi.fn();
    const t = new UdpTransport({
      log: { warn: () => {} },
      dgramFactory: () => fake,
    });
    t.onDisconnect(onDisc);
    await t.connect({ host: '1.2.3.4', port: 8080 });
    t.destroy();
    fake._fire('error', new Error('post-destroy'));
    expect(onDisc).not.toHaveBeenCalled();
  });
});

// --- WebSocket transport ---------------------------------------------------

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    MockWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }
  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  _failConnect(message = 'connect error') {
    if (this.onerror) this.onerror({ message });
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1006 });
  }
}
MockWebSocket.instances = [];

beforeEach(() => { MockWebSocket.instances.length = 0; });

describe('WebsocketTransport — connect contract', () => {
  it('rejects without a url', async () => {
    const t = new WebsocketTransport({ log: {}, WebSocketImpl: MockWebSocket });
    expect((await t.connect({})).success).toBe(false);
  });

  it('rejects urls that are not ws:// or wss://', async () => {
    const t = new WebsocketTransport({ log: {}, WebSocketImpl: MockWebSocket });
    expect((await t.connect({ url: 'http://x' })).success).toBe(false);
    expect((await t.connect({ url: 'tcp://x' })).success).toBe(false);
    expect((await t.connect({ url: '' })).success).toBe(false);
    expect((await t.connect({ url: 'ws/x' })).success).toBe(false);
  });

  it('accepts wss:// for TLS receivers', async () => {
    const t = new WebsocketTransport({ log: { info: () => {} }, WebSocketImpl: MockWebSocket });
    const p = t.connect({ url: 'wss://device.local:443/tcode' });
    MockWebSocket.instances[0]._open();
    expect((await p).success).toBe(true);
    expect(t.connected).toBe(true);
  });

  it('returns failure when the socket closes before opening', async () => {
    const t = new WebsocketTransport({ log: { warn: () => {} }, WebSocketImpl: MockWebSocket });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._failConnect();
    expect((await p).success).toBe(false);
    expect(t.connected).toBe(false);
  });

  it('reports unavailable when no WebSocket runtime is present', async () => {
    const t = new WebsocketTransport({ log: {}, WebSocketImpl: null });
    const result = await t.connect({ url: 'ws://x' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/runtime/i);
  });
});

describe('WebsocketTransport — send', () => {
  it('returns false before the socket opens', async () => {
    const t = new WebsocketTransport({ log: {}, WebSocketImpl: MockWebSocket });
    // Kick off the connect but do not open — readyState stays 0
    const p = t.connect({ url: 'ws://x' });
    expect(t.send('L0500\n')).toBe(false);
    MockWebSocket.instances[0]._open();
    await p;
    expect(t.send('L0500\n')).toBe(true);
  });

  it('sends the formatted command string to the socket', async () => {
    const t = new WebsocketTransport({ log: { info: () => {} }, WebSocketImpl: MockWebSocket });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    t.send('L0500 R0750\n');
    expect(MockWebSocket.instances[0].sent).toEqual(['L0500 R0750\n']);
  });

  it('returns false after disconnect', async () => {
    const t = new WebsocketTransport({ log: { info: () => {} }, WebSocketImpl: MockWebSocket });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    await t.disconnect();
    expect(t.send('X')).toBe(false);
  });

  it('reports connected=false if readyState is not OPEN', async () => {
    const t = new WebsocketTransport({ log: { info: () => {} }, WebSocketImpl: MockWebSocket });
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    // Simulate a transient state change where readyState flips to CLOSING.
    MockWebSocket.instances[0].readyState = 2;
    expect(t.connected).toBe(false);
    expect(t.send('X')).toBe(false);
  });
});

describe('WebsocketTransport — disconnect / errors', () => {
  it('fires onDisconnect when the socket closes after opening (reconnect off)', async () => {
    // Disable the auto-reconnect path so the close handler routes to the
    // onDisconnect callback directly. The reconnect-on behaviour is
    // covered by `tcode-mfp-compat.test.js`.
    const t = new WebsocketTransport({
      log: { info: () => {} }, WebSocketImpl: MockWebSocket,
      reconnect: false,
    });
    const onDisc = vi.fn();
    t.onDisconnect(onDisc);
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    MockWebSocket.instances[0].close();
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it('destroy() does not fire onDisconnect', async () => {
    const t = new WebsocketTransport({ log: { info: () => {} }, WebSocketImpl: MockWebSocket });
    const onDisc = vi.fn();
    t.onDisconnect(onDisc);
    const p = t.connect({ url: 'ws://x' });
    MockWebSocket.instances[0]._open();
    await p;
    t.destroy();
    expect(onDisc).not.toHaveBeenCalled();
  });
});

// --- createTransport registry ----------------------------------------------

describe('createTransport — registry dispatch', () => {
  it('creates a UdpTransport for kind "udp"', () => {
    const t = createTransport('udp', { dgramFactory: () => makeFakeUdpSocket() });
    expect(t).toBeInstanceOf(UdpTransport);
  });

  it('creates a WebsocketTransport for kind "websocket" and "ws"', () => {
    const a = createTransport('websocket', { WebSocketImpl: MockWebSocket });
    const b = createTransport('ws', { WebSocketImpl: MockWebSocket });
    expect(a).toBeInstanceOf(WebsocketTransport);
    expect(b).toBeInstanceOf(WebsocketTransport);
  });

  it('throws for an unknown kind', () => {
    expect(() => createTransport('bluetooth')).toThrow(/unknown/i);
  });
});
