// Tests for the renderer-side TCode manager's multi-transport connect()
// signature. The manager always speaks the same protocol (LXXXX RXXXX
// formatter unchanged); only the IPC payload differs by transport.
//
// Existing call sites use the legacy two-arg form
// `connect(portPath, baudRate)` — those tests pin back-compat so the
// connection-panel doesn't regress for users on serial.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TCodeManager } from '../../renderer/js/tcode-manager.js';
import { liftAppClass } from './helpers/app-methods.js';

describe('TCodeManager.connect — back-compat legacy serial form', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async (kind, opts) => {
          calls.push([kind, opts]);
          return { success: true };
        }),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });

  afterEach(() => { delete global.window; });

  it('two-arg call dispatches as serial', async () => {
    const m = new TCodeManager();
    const ok = await m.connect('COM3', 115200);
    expect(ok).toBe(true);
    expect(calls).toEqual([['serial', { path: 'COM3', baudRate: 115200 }]]);
  });

  it('two-arg call without baud defaults to 115200', async () => {
    const m = new TCodeManager();
    await m.connect('/dev/ttyUSB0');
    expect(calls[0]).toEqual(['serial', { path: '/dev/ttyUSB0', baudRate: 115200 }]);
  });

  it('legacy fields _portPath / _baudRate stay populated for serial', async () => {
    const m = new TCodeManager();
    await m.connect('COM5', 38400);
    expect(m._portPath).toBe('COM5');
    expect(m._baudRate).toBe(38400);
  });
});

describe('TCodeManager.connect — UDP transport', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async (kind, opts) => {
          calls.push([kind, opts]);
          return { success: true };
        }),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });
  afterEach(() => { delete global.window; });

  it('passes the host+port options through unchanged', async () => {
    const m = new TCodeManager();
    const ok = await m.connect('udp', { host: '192.168.1.42', port: 8080 });
    expect(ok).toBe(true);
    expect(calls).toEqual([['udp', { host: '192.168.1.42', port: 8080 }]]);
  });

  it('clears legacy serial fields when using UDP', async () => {
    const m = new TCodeManager();
    await m.connect('udp', { host: '1.2.3.4', port: 1000 });
    expect(m._portPath).toBe('');
    expect(m._baudRate).toBe(0);
  });

  it('sets _transportKind to udp', async () => {
    const m = new TCodeManager();
    await m.connect('udp', { host: '1.2.3.4', port: 1000 });
    expect(m._transportKind).toBe('udp');
  });
});

describe('TCodeManager.connect — WebSocket transport', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async (kind, opts) => {
          calls.push([kind, opts]);
          return { success: true };
        }),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });
  afterEach(() => { delete global.window; });

  it('accepts kind="websocket" and passes the url', async () => {
    const m = new TCodeManager();
    await m.connect('websocket', { url: 'ws://device.local:81' });
    expect(calls).toEqual([['websocket', { url: 'ws://device.local:81' }]]);
  });

  it('accepts kind="ws" as alias', async () => {
    const m = new TCodeManager();
    await m.connect('ws', { url: 'ws://device.local:81' });
    expect(calls).toEqual([['ws', { url: 'ws://device.local:81' }]]);
  });
});

describe('TCodeManager.connect — failure paths', () => {
  beforeEach(() => {
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async () => ({ success: false, error: 'EHOSTUNREACH' })),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });
  afterEach(() => { delete global.window; });

  it('returns false when main-process returns success=false', async () => {
    const m = new TCodeManager();
    const ok = await m.connect('udp', { host: '0.0.0.0', port: 80 });
    expect(ok).toBe(false);
    expect(m.connected).toBe(false);
  });

  it('emits error via onError callback', async () => {
    const m = new TCodeManager();
    const errs = [];
    m.onError = (e) => errs.push(e);
    await m.connect('udp', { host: '0.0.0.0', port: 80 });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/EHOSTUNREACH/);
  });
});

describe('TCodeManager._describeTransport', () => {
  let m;
  beforeEach(() => { m = new TCodeManager(); });

  it('renders serial transport summary', () => {
    expect(m._describeTransport('serial', { path: 'COM3', baudRate: 115200 }))
      .toBe('COM3 @ 115200');
  });

  it('renders UDP transport summary', () => {
    expect(m._describeTransport('udp', { host: '1.2.3.4', port: 8080 }))
      .toBe('1.2.3.4:8080');
  });

  it('renders WebSocket transport summary', () => {
    expect(m._describeTransport('websocket', { url: 'ws://x:81' }))
      .toBe('ws://x:81');
    expect(m._describeTransport('ws', { url: 'ws://x:81' }))
      .toBe('ws://x:81');
  });

  it('falls back to JSON for unknown transports', () => {
    expect(m._describeTransport('zigbee', { mesh: true }))
      .toBe('{"mesh":true}');
  });
});

describe('TCodeManager.connect — disconnect-before-reconnect', () => {
  beforeEach(() => {
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async () => ({ success: true })),
        tcodeDisconnect: vi.fn(async () => ({ success: true })),
        onTcodeDisconnected: vi.fn(() => () => {}),
      },
    };
  });
  afterEach(() => { delete global.window; });

  it('disconnects before reconnecting if already connected', async () => {
    const m = new TCodeManager();
    await m.connect('serial', { path: 'COM3' });
    expect(m.connected).toBe(true);
    await m.connect('udp', { host: '1.2.3.4', port: 5000 });
    expect(window.funsync.tcodeDisconnect).toHaveBeenCalledTimes(1);
    expect(m._transportKind).toBe('udp');
  });
});

// CB-15 (2026-11-05, found verifying block B; also in v0.9.2): after the user
// pressed Disconnect on T-Code, the nav bar kept saying "Device 1 Connected"
// and the T-Code sync engine kept running. disconnect() never fired
// onDisconnect, which only a DROPPED link did, so the app's teardown (stop
// tcodeSync, repaint the indicators) never ran. The nav bar here is the REAL
// `_updateDeviceIndicators` / `_getConnectedDeviceCount` lifted from app.js,
// fed by the manager's real `connected`; the onDisconnect body is app.js's.
describe('TCodeManager.disconnect — a user disconnect tears down like a dropped link (CB-15)', () => {
  let dropLink; // main's 'tcode-disconnected' broadcast to this window
  let Indicators;

  beforeEach(() => {
    dropLink = null;
    global.window = {
      funsync: {
        tcodeConnect: vi.fn(async () => ({ success: true })),
        tcodeDisconnect: vi.fn(async () => ({ success: true })),
        onTcodeDisconnected: vi.fn((cb) => {
          dropLink = cb;
          return () => { if (dropLink === cb) dropLink = null; };
        }),
      },
    };
    Indicators ||= liftAppClass(['_updateDeviceIndicators', '_getConnectedDeviceCount'], {
      document: { getElementById: () => null },
      t: (k) => k,
    });
  });
  afterEach(() => { delete global.window; });

  /** The app around one T-Code manager: its nav bar and its sync engine. */
  function appWith(manager) {
    const app = Object.assign(new Indicators(), {
      tcodeManager: manager,
      navBar: { said: null, setHandyStatus(state, count) { this.said = `${state} (${count})`; } },
      tcodeSync: { stop: vi.fn() },
      _updatePlayerSyncChip() {},
    });
    // app.js's T-Code wiring
    manager.onConnect = () => app._updateDeviceIndicators();
    manager.onDisconnect = () => {
      if (app.tcodeSync) app.tcodeSync.stop();
      app._updateDeviceIndicators();
    };
    return app;
  }

  it('Disconnect: the nav bar stops saying connected and the sync engine stops, once', async () => {
    const m = new TCodeManager();
    const app = appWith(m);
    await m.connect('udp', { host: '127.0.0.1', port: 8000 });
    expect(app.navBar.said).toBe('connected (1)');

    await m.disconnect();
    expect(app.navBar.said).toBe('disconnected (0)');
    expect(app.tcodeSync.stop).toHaveBeenCalledTimes(1);

    // A late notice from main, or a second press, does not tear down again.
    dropLink?.();
    await m.disconnect();
    expect(app.tcodeSync.stop).toHaveBeenCalledTimes(1);
  });

  it('a dropped link still tears down once, even if main says so twice', async () => {
    const m = new TCodeManager();
    const app = appWith(m);
    await m.connect('serial', { path: 'COM3', baudRate: 115200 });
    const drop = dropLink;
    drop();
    drop();
    expect(app.navBar.said).toBe('disconnected (0)');
    expect(app.tcodeSync.stop).toHaveBeenCalledTimes(1);
    await m.disconnect(); // the user presses Disconnect on the dead link
    expect(app.tcodeSync.stop).toHaveBeenCalledTimes(1);
  });

  it('Disconnect while not connected tears nothing down', async () => {
    const m = new TCodeManager();
    const app = appWith(m);
    await m.disconnect();
    expect(app.tcodeSync.stop).not.toHaveBeenCalled();
    expect(app.navBar.said).toBeNull();
  });

  it('the connect log and the device label name the real endpoint for every transport', async () => {
    const m = new TCodeManager();
    await m.connect('udp', { host: '192.168.1.42', port: 8000 });
    expect(m.endpointSummary).toBe('192.168.1.42:8000'); // was " @ 0 baud"
    expect(m.endpoint).toBe('192.168.1.42:8000');
    await m.connect('serial', { path: 'COM3', baudRate: 115200 });
    expect(m.endpointSummary).toBe('COM3 @ 115200 baud');
    expect(m.endpoint).toBe('COM3');
    await m.connect('websocket', { url: 'ws://10.0.0.5:81' });
    expect(m.endpointSummary).toBe('ws://10.0.0.5:81');
    expect(m.endpoint).toBe('ws://10.0.0.5:81');
  });
});
