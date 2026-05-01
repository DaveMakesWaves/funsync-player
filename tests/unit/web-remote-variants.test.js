// Regression-style tests for the web-remote variant-switching client.
// These pin the WebSocket protocol contract (`switch-variant` request,
// `variant-changed` reply) on RemoteSyncClient so future refactors of
// app.js or remote-sync.js can't silently break the desktop ↔ remote
// handshake. End-to-end UI rendering is exercised separately in
// integration/manual tests; here we focus on the wire shape.

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
    this.readyState = 1; // OPEN
    this._fire('open', {});
  }
  _message(msg) {
    this._fire('message', { data: JSON.stringify(msg) });
  }
}

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

let lastSocket;
function FakeWebSocket() {
  lastSocket = new MockSocket();
  return lastSocket;
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

beforeEach(() => {
  lastSocket = null;
  globalThis.WebSocket = FakeWebSocket;
});
afterEach(() => {
  globalThis.WebSocket = ORIGINAL_WEBSOCKET;
});

function makeVideoStub() {
  return {
    paused: true,
    duration: 100,
    currentTime: 0,
    playbackRate: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('RemoteSyncClient.switchVariant', () => {
  it('sends a switch-variant message with the label when the socket is open', () => {
    const client = new RemoteSyncClient({ video: makeVideoStub(), videoId: 'abc' });
    client.start();
    lastSocket._open();
    // start() sends `hello` + initial `state`. Drop those before asserting.
    lastSocket.sent.length = 0;

    client.switchVariant('Soft');

    expect(lastSocket.sent.length).toBe(1);
    const payload = JSON.parse(lastSocket.sent[0]);
    expect(payload).toEqual({ type: 'switch-variant', label: 'Soft' });
  });

  it('drops the call silently before the socket opens', () => {
    const client = new RemoteSyncClient({ video: makeVideoStub(), videoId: 'abc' });
    client.start();
    // Don't open — readyState stays at CONNECTING.

    expect(() => client.switchVariant('Soft')).not.toThrow();
    expect(lastSocket.sent.length).toBe(0);
  });

  it('drops the call silently when label is missing or non-string', () => {
    const client = new RemoteSyncClient({ video: makeVideoStub(), videoId: 'abc' });
    client.start();
    lastSocket._open();
    lastSocket.sent.length = 0;

    client.switchVariant('');
    client.switchVariant(undefined);
    client.switchVariant(null);
    client.switchVariant(42);

    expect(lastSocket.sent.length).toBe(0);
  });
});

describe('RemoteSyncClient.onServerMessage — variant-changed dispatch', () => {
  it('passes variant-changed payloads through to onServerMessage', () => {
    const onServerMessage = vi.fn();
    const client = new RemoteSyncClient({
      video: makeVideoStub(),
      videoId: 'abc',
      onServerMessage,
    });
    client.start();
    lastSocket._open();

    lastSocket._message({ type: 'variant-changed', label: 'Soft' });

    // The client doesn't hard-code message types — it just forwards
    // whatever the server sends to onServerMessage. Caller (app.js) is
    // responsible for dispatching by `type`. This test pins that the
    // forward path doesn't filter variant-changed out by accident.
    expect(onServerMessage).toHaveBeenCalledWith({
      type: 'variant-changed',
      label: 'Soft',
    });
  });
});
