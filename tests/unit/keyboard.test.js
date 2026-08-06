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
});
