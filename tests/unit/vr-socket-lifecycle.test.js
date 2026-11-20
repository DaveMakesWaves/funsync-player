/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A dead connect attempt must never touch a live connection's state.
//
// The VR socket handler in main.js kept `vrSocket` and `vrKeepAliveTimer` as
// module globals and let every socket's listeners write to them by name, with
// no check that the socket firing the event was still the current one. Two
// holes fell out of that:
//
//   * `error` nulled the global and resolved but never destroyed the socket
//     or unbound its listeners, leaving a live handler attached to a dead
//     attempt.
//   * `close` then cleared the keep-alive timer unconditionally, so a stale
//     socket closing could clear the timer belonging to a NEWER, working
//     connection.
//
// The second one is the dangerous half. Keep-alive silence for ~3s is exactly
// how HereSphere drops a link, so the symptom is a connection that dies a few
// seconds after being made with nothing in the log to explain it. Reported
// shape: pallokala2, EroScripts #338/#343.
//
// These assert the OBSERVABLE effect — is the keep-alive still ticking, did a
// stale socket get destroyed, did a spurious vr-disconnected reach the
// renderer — rather than the shape of the code, so a rewrite that keeps the
// behaviour keeps the tests.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { VRSocketLink } = require_('../../electron/vr-socket.js');

// A net.Socket stand-in with the bits the link actually uses. Events are
// fired by the test, so "a late close from a dead attempt" is expressible.
function makeFakeSocket() {
  const listeners = new Map();
  return {
    destroyed: false,
    timeoutMs: null,
    written: [],
    connectArgs: null,
    _connectCb: null,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },
    removeAllListeners() { listeners.clear(); return this; },
    setTimeout(ms) { this.timeoutMs = ms; return this; },
    connect(port, host, cb) { this.connectArgs = { port, host }; this._connectCb = cb; return this; },
    write(buf) { this.written.push(buf); return true; },
    destroy() { this.destroyed = true; return this; },
    // Test-side triggers
    fire(event, arg) { for (const fn of listeners.get(event) || []) fn(arg); },
    // Real net.Socket ALWAYS emits 'close' after 'error'. A fake that lets a
    // test fire 'error' alone is a fake that can hide a missing disconnect
    // notification — which is exactly what it did hide, until this class was
    // driven against a real socket. Use this, not a bare fire('error').
    fireErrorThenClose(err) { this.fire('error', err); this.fire('close'); },
    openIt() { this._connectCb?.(); },
    listenerCount(event) { return (listeners.get(event) || []).length; },
  };
}

function makeLink(sockets) {
  const broadcasts = [];
  const timers = new Map();
  let nextTimerId = 1;
  let queue = [...sockets];

  const link = new VRSocketLink({
    createSocket: () => queue.shift(),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    setIntervalFn: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearIntervalFn: (id) => { timers.delete(id); },
  });

  return {
    link,
    broadcasts,
    // Run every live interval once — the observable "is keep-alive alive".
    tickKeepAlives() { for (const { fn } of timers.values()) fn(); },
    liveTimerCount() { return timers.size; },
  };
}

describe('a stale attempt cannot clear a live connection keep-alive', () => {
  it('keeps sending keep-alive packets after a dead socket closes late', async () => {
    const dead = makeFakeSocket();
    const live = makeFakeSocket();
    const { link, tickKeepAlives, liveTimerCount } = makeLink([dead, live]);

    // Attempt 1 fails the way an unreachable headset does.
    const first = link.connect('192.168.1.50', 23554);
    dead.fireErrorThenClose({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    await expect(first).resolves.toMatchObject({ success: false });

    // Attempt 2 succeeds and starts its keep-alive.
    const second = link.connect('192.168.1.50', 23554);
    live.openIt();
    await expect(second).resolves.toEqual({ success: true });
    expect(liveTimerCount()).toBe(1);

    // The dead socket's close already landed as part of its error pair, and
    // its listeners are gone. Fire a second one anyway: a retired socket must
    // stay inert no matter how often it twitches.
    dead.fire('close');

    expect(liveTimerCount()).toBe(1);
    const before = live.written.length;
    tickKeepAlives();
    expect(live.written.length).toBe(before + 1);
    expect(link.connected).toBe(true);
  });

  it('does not report a disconnect to the renderer when a dead socket closes', async () => {
    const dead = makeFakeSocket();
    const live = makeFakeSocket();
    const { link, broadcasts } = makeLink([dead, live]);

    const first = link.connect('10.0.0.9', 23554);
    dead.fireErrorThenClose({ code: 'ECONNREFUSED', message: 'refused' });
    await first;

    const second = link.connect('10.0.0.9', 23554);
    live.openIt();
    await second;

    dead.fire('close');

    // A phantom vr-disconnected tells the renderer to tear down a link that
    // is actually fine, which is its own user-visible bug.
    expect(broadcasts.filter((b) => b.channel === 'vr-disconnected')).toHaveLength(0);
  });

  it('does not let a dead socket steal the live socket reference', async () => {
    const dead = makeFakeSocket();
    const live = makeFakeSocket();
    const { link } = makeLink([dead, live]);

    const first = link.connect('10.0.0.9', 23554);
    dead.fireErrorThenClose({ code: 'ECONNREFUSED', message: 'refused' });
    await first;

    const second = link.connect('10.0.0.9', 23554);
    live.openIt();
    await second;

    dead.fire('close');
    expect(link.connected).toBe(true);
    expect(link.send('{"currentTime":1}')).toBe(true);
    expect(live.written.length).toBeGreaterThan(0);
  });
});

describe('a failed attempt cleans up after itself', () => {
  it('destroys the socket on error rather than leaving it open', async () => {
    const sock = makeFakeSocket();
    const { link } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.fire('error', { code: 'ECONNREFUSED', message: 'refused' });
    await p;

    expect(sock.destroyed).toBe(true);
    expect(link.connected).toBe(false);
  });

  it('keeps the current socket listening after error so close can report it', async () => {
    // Node emits 'error' then 'close'. 'close' is the one place that releases
    // state and tells the renderer, so stripping listeners on 'error' silently
    // swallows a real mid-session drop. Caught against a real net.Socket.
    const sock = makeFakeSocket();
    const { link } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.fire('error', { code: 'ECONNREFUSED', message: 'refused' });
    await p;

    expect(sock.listenerCount('close')).toBeGreaterThan(0);
  });

  it('tells the renderer when a live connection is reset mid-session', async () => {
    // The headset hanging up raises ECONNRESET, not a clean close. Without a
    // vr-disconnected the renderer sits on a dead link until vr-bridge's 8s
    // liveness watchdog notices.
    const sock = makeFakeSocket();
    const { link, broadcasts, liveTimerCount } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;
    expect(link.connected).toBe(true);

    sock.fireErrorThenClose({ code: 'ECONNRESET', message: 'read ECONNRESET' });

    expect(broadcasts.filter((b) => b.channel === 'vr-disconnected')).toHaveLength(1);
    expect(link.connected).toBe(false);
    expect(liveTimerCount()).toBe(0);
    expect(sock.destroyed).toBe(true);
  });

  it('destroys the socket on connect timeout', async () => {
    const sock = makeFakeSocket();
    const { link } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.fire('timeout');
    await expect(p).resolves.toMatchObject({ success: false, error: 'Connection timed out' });
    expect(sock.destroyed).toBe(true);
  });

  it('abandons a socket that finishes its handshake after being superseded', async () => {
    const slow = makeFakeSocket();
    const live = makeFakeSocket();
    const { link, liveTimerCount } = makeLink([slow, live]);

    const first = link.connect('192.168.1.50', 23554);

    // Second attempt supersedes the first while its handshake is in flight.
    const second = link.connect('192.168.1.50', 23554);
    live.openIt();
    await expect(second).resolves.toEqual({ success: true });

    // The abandoned handshake completes now.
    slow.openIt();
    await expect(first).resolves.toMatchObject({ success: false });

    expect(slow.destroyed).toBe(true);
    // One keep-alive, belonging to the live socket.
    expect(liveTimerCount()).toBe(1);
    expect(link.connected).toBe(true);
  });
});

describe('the connect deadline does not outlive the handshake', () => {
  it('disarms the socket timeout once connected', async () => {
    const sock = makeFakeSocket();
    const { link } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    expect(sock.timeoutMs).toBe(5000);

    sock.openIt();
    await p;

    // Left armed, a paused video (a legitimately idle socket) would trip the
    // inactivity timeout and tear down a working link.
    expect(sock.timeoutMs).toBe(0);
  });
});

describe('a real disconnect still reaches the renderer', () => {
  it('broadcasts vr-disconnected and stops the keep-alive when the live socket closes', async () => {
    const sock = makeFakeSocket();
    const { link, broadcasts, liveTimerCount } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;
    expect(liveTimerCount()).toBe(1);

    sock.fire('close');

    expect(broadcasts.filter((b) => b.channel === 'vr-disconnected')).toHaveLength(1);
    expect(liveTimerCount()).toBe(0);
    expect(link.connected).toBe(false);
  });

  it('forwards parsed state packets and stamps arrival', async () => {
    const sock = makeFakeSocket();
    const { link, broadcasts } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;

    const payload = Buffer.from(JSON.stringify({ currentTime: 12.5, playerState: 0 }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    sock.fire('data', Buffer.concat([header, payload]));

    const state = broadcasts.filter((b) => b.channel === 'vr-state');
    expect(state).toHaveLength(1);
    expect(state[0].payload.currentTime).toBe(12.5);
    expect(typeof state[0].payload._arrivalMs).toBe('number');
  });

  it('reassembles a packet split across two chunks', async () => {
    const sock = makeFakeSocket();
    const { link, broadcasts } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;

    const payload = Buffer.from(JSON.stringify({ currentTime: 3 }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const whole = Buffer.concat([header, payload]);

    sock.fire('data', whole.subarray(0, 6));
    expect(broadcasts.filter((b) => b.channel === 'vr-state')).toHaveLength(0);
    sock.fire('data', whole.subarray(6));
    expect(broadcasts.filter((b) => b.channel === 'vr-state')).toHaveLength(1);
  });

  it('ignores data arriving on a socket that is no longer current', async () => {
    const dead = makeFakeSocket();
    const live = makeFakeSocket();
    const { link, broadcasts } = makeLink([dead, live]);

    const first = link.connect('10.0.0.9', 23554);
    dead.fireErrorThenClose({ code: 'ECONNREFUSED', message: 'refused' });
    await first;

    const second = link.connect('10.0.0.9', 23554);
    live.openIt();
    await second;

    const payload = Buffer.from(JSON.stringify({ currentTime: 99 }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    dead.fire('data', Buffer.concat([header, payload]));

    expect(broadcasts.filter((b) => b.channel === 'vr-state')).toHaveLength(0);
  });
});

describe('explicit disconnect', () => {
  it('destroys the socket, clears the keep-alive and refuses further sends', async () => {
    const sock = makeFakeSocket();
    const { link, liveTimerCount } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;

    expect(link.disconnect()).toEqual({ success: true });
    expect(sock.destroyed).toBe(true);
    expect(liveTimerCount()).toBe(0);
    expect(link.connected).toBe(false);
    expect(link.send('{"currentTime":1}')).toBe(false);
  });

  it('survives a close arriving after an explicit disconnect', async () => {
    const sock = makeFakeSocket();
    const { link, broadcasts } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;
    link.disconnect();

    sock.fire('close');
    // The user asked for the disconnect; the renderer already knows.
    expect(broadcasts.filter((b) => b.channel === 'vr-disconnected')).toHaveLength(0);
  });
});

describe('framing on send', () => {
  it('prefixes the payload with its little-endian length', async () => {
    const sock = makeFakeSocket();
    const { link } = makeLink([sock]);

    const p = link.connect('192.168.1.50', 23554);
    sock.openIt();
    await p;
    sock.written.length = 0;

    const json = '{"currentTime":42}';
    expect(link.send(json)).toBe(true);
    const sent = sock.written[0];
    expect(sent.readUInt32LE(0)).toBe(Buffer.byteLength(json));
    expect(sent.subarray(4).toString('utf-8')).toBe(json);
  });
});
