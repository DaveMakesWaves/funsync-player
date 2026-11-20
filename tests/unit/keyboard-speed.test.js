// Tests for the playback-speed keyboard shortcuts (< and >).
//
// Convention matches YouTube: Shift+, decreases, Shift+. increases.
// On most layouts the browser reports `<` / `>` as the key when Shift
// is held; on some it reports `,` / `.` with shiftKey=true. We accept
// both forms. Bare `,` / `.` without Shift must NOT fire (would
// interfere with anything else that uses those keys).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';

// One live handler at a time. A KeyboardHandler binds to `document` for
// good, so building one per test used to leave every earlier test's handler
// listening too. These events are cancelable, and the handler leaves alone
// a key something else already preventDefault-ed (V43), so a stale handler
// taking the key first would hide this test's handler. The real app has
// exactly one.
class TestKeyboardHandler extends KeyboardHandler { _bindEvents() {} }
let live = null;
document.addEventListener('keydown', (e) => live?._onKeyDown(e));

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
    handler = live = new TestKeyboardHandler({
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
