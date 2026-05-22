// Tests for the playback-speed keyboard shortcuts (< and >).
//
// Convention matches YouTube: Shift+, decreases, Shift+. increases.
// On most layouts the browser reports `<` / `>` as the key when Shift
// is held; on some it reports `,` / `.` with shiftKey=true. We accept
// both forms. Bare `,` / `.` without Shift must NOT fire (would
// interfere with anything else that uses those keys).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';

function createMockPlayer() {
  return {
    video: { volume: 0.5, paused: true, currentTime: 0, duration: 300 },
    togglePlay: vi.fn(),
    skip: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleFullscreen: vi.fn(),
    captureScreenshot: vi.fn(),
    toggleInfoOverlay: vi.fn(),
    setLoopPoint: vi.fn(),
    clearAbLoop: vi.fn(),
    cycleAspectRatio: vi.fn(),
    cyclePlaybackRate: vi.fn(),
  };
}

function fireKey(key, opts = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  document.dispatchEvent(event);
  return event;
}

describe('KeyboardHandler — playback speed shortcuts', () => {
  let player, handler;

  beforeEach(() => {
    player = createMockPlayer();
    handler = new KeyboardHandler({
      videoPlayer: player,
      connectionPanel: null,
      onOpenFile: null,
      scriptEditor: { isOpen: false },
    });
  });

  describe('Decrement (Shift+,)', () => {
    it('"<" decrements rate', () => {
      fireKey('<');
      expect(player.cyclePlaybackRate).toHaveBeenCalledWith(-1);
    });

    it('"," with Shift held decrements rate', () => {
      fireKey(',', { shiftKey: true });
      expect(player.cyclePlaybackRate).toHaveBeenCalledWith(-1);
    });

    it('bare "," (no Shift) does NOT decrement', () => {
      fireKey(',');
      expect(player.cyclePlaybackRate).not.toHaveBeenCalled();
    });

    it('calls preventDefault on "<"', () => {
      const e = fireKey('<');
      expect(e.defaultPrevented).toBe(true);
    });
  });

  describe('Increment (Shift+.)', () => {
    it('">" increments rate', () => {
      fireKey('>');
      expect(player.cyclePlaybackRate).toHaveBeenCalledWith(+1);
    });

    it('"." with Shift held increments rate', () => {
      fireKey('.', { shiftKey: true });
      expect(player.cyclePlaybackRate).toHaveBeenCalledWith(+1);
    });

    it('bare "." (no Shift) does NOT increment', () => {
      fireKey('.');
      expect(player.cyclePlaybackRate).not.toHaveBeenCalled();
    });

    it('calls preventDefault on ">"', () => {
      const e = fireKey('>');
      expect(e.defaultPrevented).toBe(true);
    });
  });

  describe('Input/textarea guard', () => {
    it('shortcuts skipped when an INPUT is focused', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      const event = new KeyboardEvent('keydown', { key: '<', bubbles: true });
      Object.defineProperty(event, 'target', { value: input });
      document.dispatchEvent(event);
      expect(player.cyclePlaybackRate).not.toHaveBeenCalled();
      input.remove();
    });

    it('shortcuts skipped when a TEXTAREA is focused', () => {
      const ta = document.createElement('textarea');
      document.body.appendChild(ta);
      ta.focus();
      const event = new KeyboardEvent('keydown', { key: '>', bubbles: true });
      Object.defineProperty(event, 'target', { value: ta });
      document.dispatchEvent(event);
      expect(player.cyclePlaybackRate).not.toHaveBeenCalled();
      ta.remove();
    });
  });
});
