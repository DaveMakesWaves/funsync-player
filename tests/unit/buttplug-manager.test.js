import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugManager, _describeError } from '../../renderer/js/buttplug-manager.js';

// Mock devices using v4 API pattern (hasOutput + runOutput)
const mockVibeDevice = {
  index: 0,
  name: 'Test Vibrator',
  hasOutput: vi.fn((type) => type === 'Vibrate'),
  runOutput: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockLinearDevice = {
  index: 1,
  name: 'Test Stroker',
  hasOutput: vi.fn((type) => type === 'Position'),
  runOutput: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockRotateDevice = {
  index: 2,
  name: 'Test Rotator',
  hasOutput: vi.fn((type) => type === 'Rotate'),
  runOutput: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockBareDevice = {
  index: 3,
  name: 'Bare Device',
  hasOutput: vi.fn(() => false),
  runOutput: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

describe('ButtplugManager', () => {
  let manager;

  describe('_serializeDevice', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
    });

    it('detects vibrate capability', () => {
      const s = manager._serializeDevice(mockVibeDevice);
      expect(s.canVibrate).toBe(true);
      expect(s.canLinear).toBe(false);
      expect(s.canRotate).toBe(false);
      expect(s.name).toBe('Test Vibrator');
      expect(s.index).toBe(0);
    });

    it('detects linear/position capability', () => {
      const s = manager._serializeDevice(mockLinearDevice);
      expect(s.canLinear).toBe(true);
      expect(s.canVibrate).toBe(false);
    });

    it('detects rotate capability', () => {
      const s = manager._serializeDevice(mockRotateDevice);
      expect(s.canRotate).toBe(true);
      expect(s.canVibrate).toBe(false);
      expect(s.canLinear).toBe(false);
    });

    it('handles device with no capabilities', () => {
      const s = manager._serializeDevice(mockBareDevice);
      expect(s.canVibrate).toBe(false);
      expect(s.canLinear).toBe(false);
      expect(s.canRotate).toBe(false);
    });

    it('handles device where hasOutput throws', () => {
      const broken = { index: 5, name: 'Broken', hasOutput: () => { throw new Error('nope'); } };
      const s = manager._serializeDevice(broken);
      expect(s.canVibrate).toBe(false);
      expect(s.canLinear).toBe(false);
      expect(s.canRotate).toBe(false);
    });
  });

  describe('state', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
    });

    it('starts disconnected', () => {
      expect(manager.connected).toBe(false);
    });

    it('has empty device list initially', () => {
      expect(manager.devices).toEqual([]);
    });

    it('default port is 12345', () => {
      expect(manager.port).toBe(12345);
    });

    it('primaryDevice returns null when no devices', () => {
      expect(manager.primaryDevice).toBeNull();
    });
  });

  describe('sendVibrate', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
      manager._devices.set(0, mockVibeDevice);
      mockVibeDevice.runOutput.mockClear();
    });

    it('no-op for unknown device index', async () => {
      await manager.sendVibrate(99, 50);
      expect(mockVibeDevice.runOutput).not.toHaveBeenCalled();
    });

    it('no-op when SDK not loaded', async () => {
      await manager.sendVibrate(0, 50);
      // ButtplugSDK is null (not initialized) — should silently return
      expect(mockVibeDevice.runOutput).not.toHaveBeenCalled();
    });
  });

  describe('sendLinear', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
      manager._devices.set(1, mockLinearDevice);
      mockLinearDevice.runOutput.mockClear();
    });

    it('no-op for unknown device index', async () => {
      await manager.sendLinear(99, 50, 200);
      expect(mockLinearDevice.runOutput).not.toHaveBeenCalled();
    });
  });

  describe('sendRotate', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
      manager._devices.set(2, mockRotateDevice);
      mockRotateDevice.runOutput.mockClear();
    });

    it('no-op for unknown device index', async () => {
      await manager.sendRotate(99, 50);
      expect(mockRotateDevice.runOutput).not.toHaveBeenCalled();
    });
  });

  describe('stopDevice', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
      manager._devices.set(0, mockVibeDevice);
      mockVibeDevice.stop.mockClear();
    });

    it('calls device.stop()', async () => {
      await manager.stopDevice(0);
      expect(mockVibeDevice.stop).toHaveBeenCalled();
    });

    it('no-op for unknown device', async () => {
      await manager.stopDevice(99);
      expect(mockVibeDevice.stop).not.toHaveBeenCalled();
    });
  });

  describe('devices getter', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
    });

    it('returns serialized device list', () => {
      manager._devices.set(0, mockVibeDevice);
      manager._devices.set(1, mockLinearDevice);

      const devices = manager.devices;
      expect(devices.length).toBe(2);
      expect(devices[0].name).toBe('Test Vibrator');
      expect(devices[0].canVibrate).toBe(true);
      expect(devices[1].name).toBe('Test Stroker');
      expect(devices[1].canLinear).toBe(true);
    });

    it('returns empty array when no devices', () => {
      expect(manager.devices).toEqual([]);
    });
  });

  describe('primaryDevice', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
    });

    it('returns first vibrate device index', () => {
      manager._devices.set(0, mockVibeDevice);
      expect(manager.primaryDevice).toBe(0);
    });

    it('returns first linear device index', () => {
      manager._devices.set(1, mockLinearDevice);
      expect(manager.primaryDevice).toBe(1);
    });

    it('returns null when no compatible devices', () => {
      manager._devices.set(3, mockBareDevice);
      expect(manager.primaryDevice).toBeNull();
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      manager = new ButtplugManager();
    });

    it('calls onError callback', () => {
      const onError = vi.fn();
      manager.onError = onError;
      manager._emitError('test error');
      expect(onError).toHaveBeenCalledWith('test error');
    });

    it('does not throw without onError callback', () => {
      expect(() => manager._emitError('test')).not.toThrow();
    });
  });

  // Community report (NylonBorg, via TODO.md backlog): pre-fix,
  // `_attemptReconnect` only ran once per disconnect — the setTimeout
  // callback didn't recurse on failure, so `_maxReconnectAttempts = 3`
  // was effectively dead. Now we chain until the configured max.
  describe('_attemptReconnect chain', () => {
    it('chains setTimeout reconnects until max attempts on continued failure', async () => {
      vi.useFakeTimers();
      const m = new ButtplugManager();
      m._maxReconnectAttempts = 3;
      // Force every connect attempt to fail so we hit the recursion path.
      m.connect = vi.fn().mockResolvedValue(false);

      m._attemptReconnect();
      expect(m._reconnectAttempts).toBe(1);

      // 2000ms backoff for attempt 1 → fires + fails → schedules #2
      await vi.advanceTimersByTimeAsync(2100);
      expect(m._reconnectAttempts).toBe(2);

      // 4000ms backoff for attempt 2 → fires + fails → schedules #3
      await vi.advanceTimersByTimeAsync(4100);
      expect(m._reconnectAttempts).toBe(3);

      // 8000ms backoff for attempt 3 → fires + fails → hits max, resets.
      await vi.advanceTimersByTimeAsync(8100);
      expect(m._reconnectAttempts).toBe(0); // reset on max-reached
      expect(m.connect).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('successful reconnect breaks the chain and resets the counter', async () => {
      vi.useFakeTimers();
      const m = new ButtplugManager();
      m._maxReconnectAttempts = 3;
      // Fail once, then succeed.
      let calls = 0;
      m.connect = vi.fn().mockImplementation(async () => { calls++; return calls >= 2; });
      m.startScanning = vi.fn().mockResolvedValue(undefined);

      m._attemptReconnect();
      await vi.advanceTimersByTimeAsync(2100);   // attempt 1 fails → chains
      await vi.advanceTimersByTimeAsync(4100);   // attempt 2 succeeds → break
      expect(m._reconnectAttempts).toBe(0);
      expect(m.connect).toHaveBeenCalledTimes(2);
      // Confirm no further reconnect runs after success.
      await vi.advanceTimersByTimeAsync(20000);
      expect(m.connect).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('intentional disconnect prevents the reconnect from firing', () => {
      vi.useFakeTimers();
      const m = new ButtplugManager();
      m._intentionalDisconnect = true;
      m.connect = vi.fn();
      m._attemptReconnect();
      expect(m._reconnectAttempts).toBe(0);
      expect(m._intentionalDisconnect).toBe(false); // flag was consumed
      expect(m.connect).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});

// Regression: WebSocket Event objects (Intiface not running, port
// closed, etc.) previously stringified to "[object Event]" in the
// user-visible status text via `String(err)`. _describeError guards
// against that and similar coercion leaks across the manager's error
// surfaces (Connection failed, Scan failed).
describe('_describeError — never leaks [object Event] / [object Object]', () => {
  it('Error with message → returns the message', () => {
    expect(_describeError(new Error('boom'))).toBe('boom');
  });

  it('object with .message → returns the message', () => {
    expect(_describeError({ message: 'cloud rejected' })).toBe('cloud rejected');
  });

  it('object with .reason → returns the reason (WebSocket close with reason)', () => {
    expect(_describeError({ reason: 'going away', code: 1001 })).toBe('going away');
  });

  it('plain string → returns the string', () => {
    expect(_describeError('Nope')).toBe('Nope');
  });

  it('null / undefined → "Unknown error" (never crashes)', () => {
    expect(_describeError(null)).toBe('Unknown error');
    expect(_describeError(undefined)).toBe('Unknown error');
  });

  it('WebSocket-style Event (browser) → user-friendly Intiface hint, NEVER [object Event]', () => {
    // Simulate the actual WebSocket open-error case: an Event-like
    // object with .type but no .message / .reason. Pre-fix this was
    // the bug — `String(err)` returned "[object Event]" which leaked
    // straight to the status bar.
    const fakeWsEvent = { type: 'error', target: { readyState: 3 } };
    const out = _describeError(fakeWsEvent);
    expect(out).not.toContain('[object');
    expect(out).toContain('Intiface');
  });

  it('real DOM Event instance → user-friendly hint (instanceof Event branch)', () => {
    // jsdom provides Event. This branch ensures we catch native
    // Event instances even if their `.type` somehow evaluates falsy.
    if (typeof Event === 'undefined') return; // node-only environment
    const e = new Event('error');
    const out = _describeError(e);
    expect(out).not.toContain('[object');
    expect(out).toContain('Intiface');
  });

  it('arbitrary object with no useful fields → "Unknown error" (NEVER [object Object])', () => {
    // Defensive last-resort: `String({})` produces "[object Object]"
    // which would also be useless to a user. Filter that out too.
    expect(_describeError({})).toBe('Unknown error');
    expect(_describeError({ foo: 'bar' })).toBe('Unknown error');
  });

  it('object that custom-toStrings to a sensible value → uses the toString', () => {
    // Some SDK errors override toString. Honour that.
    const customErr = { toString: () => 'custom-error-text' };
    expect(_describeError(customErr)).toBe('custom-error-text');
  });

  it('empty .message string → falls through to next branch', () => {
    // err.message = "" shouldn't be returned (would render blank).
    // Falls through to .reason → Event check → toString chain.
    expect(_describeError({ message: '' })).toBe('Unknown error');
  });
});
