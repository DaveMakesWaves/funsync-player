// Unit tests for EventBus
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../../renderer/js/event-bus.js';

describe('EventBus', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('on()', () => {
    it('registers handler and calls it on emit', () => {
      const handler = vi.fn();
      bus.on('test', handler);
      bus.emit('test', { value: 42 });
      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it('returns an unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = bus.on('test', handler);
      unsub();
      bus.emit('test');
      expect(handler).not.toHaveBeenCalled();
    });

    it('supports multiple handlers for same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('test', h1);
      bus.on('test', h2);
      bus.emit('test', 'data');
      expect(h1).toHaveBeenCalledWith('data');
      expect(h2).toHaveBeenCalledWith('data');
    });
  });

  describe('off()', () => {
    it('unregisters a specific handler', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('test', h1);
      bus.on('test', h2);
      bus.off('test', h1);
      bus.emit('test');
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });

    it('does nothing for unknown handler', () => {
      bus.off('nonexistent', () => {});
      // Should not throw
    });
  });

  describe('once()', () => {
    it('handler is called exactly once', () => {
      const handler = vi.fn();
      bus.once('test', handler);
      bus.emit('test', 'first');
      bus.emit('test', 'second');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('first');
    });

    it('can be unsubscribed before firing', () => {
      const handler = vi.fn();
      const unsub = bus.once('test', handler);
      unsub();
      bus.emit('test');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('emit()', () => {
    it('no-op when no handlers registered', () => {
      // Should not throw
      bus.emit('nonexistent', 'data');
    });

    it('handler exception does not prevent other handlers', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h1 = vi.fn(() => { throw new Error('boom'); });
      const h2 = vi.fn();
      bus.on('test', h1);
      bus.on('test', h2);
      bus.emit('test');
      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('removeAll()', () => {
    it('removes all handlers for a specific event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('test', h1);
      bus.on('other', h2);
      bus.removeAll('test');
      bus.emit('test');
      bus.emit('other');
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });

    it('removes all handlers when called without args', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('test', h1);
      bus.on('other', h2);
      bus.removeAll();
      bus.emit('test');
      bus.emit('other');
      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });
  });
});
