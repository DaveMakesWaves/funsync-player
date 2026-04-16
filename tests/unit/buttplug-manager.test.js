import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';

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
});
