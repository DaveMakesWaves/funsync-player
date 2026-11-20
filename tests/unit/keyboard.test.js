// Unit tests for KeyboardHandler — imports from real source
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
  };
}

function fireKey(key) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  document.dispatchEvent(event);
}

describe('KeyboardHandler', () => {
  let player, handler, connectionPanel, onOpenFile, scriptEditor;

  beforeEach(() => {
    player = createMockPlayer();
    connectionPanel = { toggle: vi.fn(), hide: vi.fn() };
    onOpenFile = vi.fn();
    scriptEditor = { toggle: vi.fn(), hide: vi.fn(), isOpen: false };
    handler = new KeyboardHandler({
      videoPlayer: player,
      connectionPanel,
      onOpenFile,
      scriptEditor,
    });
  });

  // --- Play/Pause ---

  it('Space toggles play', () => {
    fireKey(' ');
    expect(player.togglePlay).toHaveBeenCalled();
  });

  it('k toggles play', () => {
    fireKey('k');
    expect(player.togglePlay).toHaveBeenCalled();
  });

  it('K toggles play (uppercase)', () => {
    fireKey('K');
    expect(player.togglePlay).toHaveBeenCalled();
  });

  // --- Seeking ---

  it('ArrowLeft skips back 5s', () => {
    fireKey('ArrowLeft');
    expect(player.skip).toHaveBeenCalledWith(-5);
  });

  it('ArrowRight skips forward 5s', () => {
    fireKey('ArrowRight');
    expect(player.skip).toHaveBeenCalledWith(5);
  });

  it('j skips back 10s', () => {
    fireKey('j');
    expect(player.skip).toHaveBeenCalledWith(-10);
  });

  it('l skips forward 10s', () => {
    fireKey('l');
    expect(player.skip).toHaveBeenCalledWith(10);
  });

  // --- Volume ---

  it('ArrowUp increases volume', () => {
    fireKey('ArrowUp');
    expect(player.setVolume).toHaveBeenCalled();
  });

  it('ArrowDown decreases volume', () => {
    fireKey('ArrowDown');
    expect(player.setVolume).toHaveBeenCalled();
  });

  it('m toggles mute', () => {
    fireKey('m');
    expect(player.toggleMute).toHaveBeenCalled();
  });

  // --- Fullscreen ---

  it('f toggles fullscreen', () => {
    fireKey('f');
    expect(player.toggleFullscreen).toHaveBeenCalled();
  });

  it('F11 toggles fullscreen', () => {
    fireKey('F11');
    expect(player.toggleFullscreen).toHaveBeenCalled();
  });

  // --- Panel toggling ---

  it('h toggles connection panel', () => {
    fireKey('h');
    expect(connectionPanel.toggle).toHaveBeenCalled();
  });

  it('s captures screenshot', () => {
    fireKey('s');
    expect(player.captureScreenshot).toHaveBeenCalled();
  });

  it('i toggles info overlay', () => {
    fireKey('i');
    expect(player.toggleInfoOverlay).toHaveBeenCalled();
  });

  // --- Loop points ---

  it('a sets loop point A', () => {
    fireKey('a');
    expect(player.setLoopPoint).toHaveBeenCalledWith('a');
  });

  it('b sets loop point B', () => {
    fireKey('b');
    expect(player.setLoopPoint).toHaveBeenCalledWith('b');
  });

  // --- Aspect ratio ---

  it('r cycles aspect ratio', () => {
    fireKey('r');
    expect(player.cycleAspectRatio).toHaveBeenCalled();
  });

  // R3 fix-up (real-app verifier 1, also in v0.9.2): in the player view
  // Ctrl+R cycled the aspect ratio and swallowed the key, so View > Reload
  // (and its unsaved-edits question, R3-19) never came there.
  it('Ctrl+R, Cmd+R and Ctrl+Shift+R are left to the Reload menu items', () => {
    handler.onCycleVRFlatten = vi.fn();
    const events = [
      { key: 'r', ctrlKey: true },
      { key: 'r', metaKey: true },
      { key: 'R', ctrlKey: true, shiftKey: true },
    ].map((init) => new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
    for (const ev of events) document.dispatchEvent(ev);
    expect(player.cycleAspectRatio).not.toHaveBeenCalled();
    expect(handler.onCycleVRFlatten).not.toHaveBeenCalled();
    expect(events.map((ev) => ev.defaultPrevented)).toEqual([false, false, false]);
  });

  // --- Editor ---

  it('e toggles script editor', () => {
    fireKey('e');
    expect(scriptEditor.toggle).toHaveBeenCalled();
  });

  // --- File open ---

  it('o calls onOpenFile', () => {
    fireKey('o');
    expect(onOpenFile).toHaveBeenCalled();
  });

  // --- Escape ---

  it('Escape clears A-B loop and hides panels', () => {
    fireKey('Escape');
    expect(player.clearAbLoop).toHaveBeenCalled();
    expect(connectionPanel.hide).toHaveBeenCalled();
  });

  it('Escape hides editor when open', () => {
    scriptEditor.isOpen = true;
    fireKey('Escape');
    expect(scriptEditor.hide).toHaveBeenCalled();
  });

  // --- INPUT guard ---

  it('ignores keystrokes from INPUT elements', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
    Object.defineProperty(event, 'target', { value: input });
    document.dispatchEvent(event);
    expect(player.togglePlay).not.toHaveBeenCalled();
    input.remove();
  });

  // --- Orgasm Switch hold (X) ---

  it('X keydown fires onOrgasmHold(true) once; keyup fires onOrgasmHold(false)', () => {
    const onOrgasmHold = vi.fn();
    handler.onOrgasmHold = onOrgasmHold;
    fireKey('x');
    expect(onOrgasmHold).toHaveBeenLastCalledWith(true);
    // keydown auto-repeats while held — must NOT re-fire activate
    fireKey('x');
    fireKey('x');
    expect(onOrgasmHold).toHaveBeenCalledTimes(1);
    // release
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    expect(onOrgasmHold).toHaveBeenLastCalledWith(false);
    expect(onOrgasmHold).toHaveBeenCalledTimes(2);
  });

  it('a fresh press after release activates again', () => {
    const onOrgasmHold = vi.fn();
    handler.onOrgasmHold = onOrgasmHold;
    fireKey('x');
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    fireKey('X'); // uppercase, second press
    expect(onOrgasmHold).toHaveBeenCalledTimes(3);
    expect(onOrgasmHold).toHaveBeenLastCalledWith(true);
  });

  it('does not activate the hold while the editor is open', () => {
    const onOrgasmHold = vi.fn();
    handler.onOrgasmHold = onOrgasmHold;
    scriptEditor.isOpen = true;
    fireKey('x');
    expect(onOrgasmHold).not.toHaveBeenCalled();
  });

  it('keyup always releases even if a hold was never registered (no throw)', () => {
    const onOrgasmHold = vi.fn();
    handler.onOrgasmHold = onOrgasmHold;
    // keyup with no prior keydown → no-op, no callback
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    expect(onOrgasmHold).not.toHaveBeenCalled();
  });

  // --- Next / previous video (community request, matches the pop-out) ---

  it('n loads the next queue item', () => {
    const onLoadNext = vi.fn();
    handler.onLoadNext = onLoadNext;
    fireKey('n');
    expect(onLoadNext).toHaveBeenCalledTimes(1);
  });

  it('p loads the previous queue item', () => {
    const onLoadPrev = vi.fn();
    handler.onLoadPrev = onLoadPrev;
    fireKey('p');
    expect(onLoadPrev).toHaveBeenCalledTimes(1);
  });

  it('N / P (uppercase) work the same', () => {
    const onLoadNext = vi.fn();
    const onLoadPrev = vi.fn();
    handler.onLoadNext = onLoadNext;
    handler.onLoadPrev = onLoadPrev;
    fireKey('N');
    fireKey('P');
    expect(onLoadNext).toHaveBeenCalledTimes(1);
    expect(onLoadPrev).toHaveBeenCalledTimes(1);
  });

  it('does not change video while the editor is open', () => {
    const onLoadNext = vi.fn();
    const onLoadPrev = vi.fn();
    handler.onLoadNext = onLoadNext;
    handler.onLoadPrev = onLoadPrev;
    scriptEditor.isOpen = true;
    fireKey('n');
    fireKey('p');
    expect(onLoadNext).not.toHaveBeenCalled();
    expect(onLoadPrev).not.toHaveBeenCalled();
  });

  it('n / p are inert when no callback is wired (no queue)', () => {
    handler.onLoadNext = null;
    handler.onLoadPrev = null;
    expect(() => { fireKey('n'); fireKey('p'); }).not.toThrow();
  });

  // --- Script variant (V / Shift+V) ---

  it('v cycles the script variant forward and V backward', () => {
    const onCycleVariant = vi.fn();
    handler.onCycleVariant = onCycleVariant;
    fireKey('v');
    fireKey('V');
    expect(onCycleVariant.mock.calls).toEqual([[1], [-1]]);
  });

  it('v / V do not cycle the variant while the editor is open, even with focus off the canvas', () => {
    // A variant switch swaps the script out from under the editor and drops
    // its unsaved edits. Focus on an editor toolbar button (Fit All) let V
    // through to here (2026-11-04 live check).
    const onCycleVariant = vi.fn();
    handler.onCycleVariant = onCycleVariant;
    scriptEditor.isOpen = true;
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    try {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', shiftKey: true, bubbles: true }));
      fireKey('v');
      expect(onCycleVariant).not.toHaveBeenCalled();
    } finally {
      button.remove();
    }
  });
});

// FT-035: the switch matched e.key only, so on a Russian or Korean layout
// (both have locales) every letter shortcut did nothing: F types 'а', N 'т'.
describe('letter keys on a layout without Latin letters (FT-035)', () => {
  // Not cancelable, like fireKey above: every handler this file built is
  // still bound to document, and one that preventDefaults would make this
  // test's handler skip the key (targetOwnsKey).
  const key = (type, k, code, mods = {}) => document.dispatchEvent(new KeyboardEvent(type, {
    key: k, code, bubbles: true, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl,
  }));
  let player, handler;
  beforeEach(() => {
    player = createMockPlayer();
    handler = new KeyboardHandler({ videoPlayer: player, scriptEditor: { isOpen: false } });
  });

  it('Russian: а (the F key) goes fullscreen, ь (M) mutes, ы (S) takes a screenshot', () => {
    key('keydown', 'а', 'KeyF');
    key('keydown', 'ь', 'KeyM');
    key('keydown', 'ы', 'KeyS');
    expect(player.toggleFullscreen).toHaveBeenCalledTimes(1);
    expect(player.toggleMute).toHaveBeenCalledTimes(1);
    expect(player.captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it('Korean: ㅜ (the N key) loads the next video', () => {
    handler.onLoadNext = vi.fn();
    key('keydown', 'ㅜ', 'KeyN');
    expect(handler.onLoadNext).toHaveBeenCalledTimes(1);
  });

  it('Russian Shift+К (the R key) cycles VR flatten; bare к the aspect ratio (case from Shift)', () => {
    handler.onCycleVRFlatten = vi.fn();
    key('keydown', 'К', 'KeyR', { shift: true });
    key('keydown', 'к', 'KeyR');
    expect(handler.onCycleVRFlatten).toHaveBeenCalledTimes(1);
    expect(player.cycleAspectRatio).toHaveBeenCalledTimes(1);
  });

  it('a hold started on Russian ч (X) ENDS when ч is released, or the device stays on the orgasm loop', () => {
    handler.onOrgasmHold = vi.fn();
    handler.onEdgeHold = vi.fn();
    key('keydown', 'ч', 'KeyX');
    key('keyup', 'ч', 'KeyX');
    key('keydown', 'я', 'KeyZ');
    key('keyup', 'я', 'KeyZ');
    expect(handler.onOrgasmHold.mock.calls).toEqual([[true], [false]]);
    expect(handler.onEdgeHold.mock.calls).toEqual([[true], [false]]);
  });

  it('AZERTY keeps its own letters: the key at KeyQ types a and sets loop point A', () => {
    handler.onToggleQueue = vi.fn();
    key('keydown', 'a', 'KeyQ');
    key('keydown', 'A', 'KeyQ', { shift: true });
    expect(player.setLoopPoint.mock.calls).toEqual([['a'], ['a']]);
    expect(handler.onToggleQueue).not.toHaveBeenCalled();
  });
});
