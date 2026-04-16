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
});
