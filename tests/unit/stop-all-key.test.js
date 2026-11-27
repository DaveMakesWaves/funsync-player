/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL KeyboardHandler listens on `document` and
 * targetOwnsKey reads the focused element.
 */
// Shift+Space is Stop all (DESIGN.md §1.6 S1, §2.15), the pause key held
// bigger. It must work in EVERY view: Space is a player-surface key the
// handler drops when no player is on screen (CB-05), so Shift+Space is taken
// before that gate. A focused text field keeps it: someone typing with Shift
// held must still get a space, not a stop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';

const player = { togglePlay: vi.fn() };
let view = 'library';
// ONE handler for the file: it binds to `document` and cannot be unbound.
const keys = new KeyboardHandler({ videoPlayer: player, getView: () => view, hasOffViewPlayer: () => false });
const stopAll = vi.fn();
keys.onStopAll = stopAll;

const press = (init, target = document.body) => {
  const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  stopAll.mockClear();
  player.togglePlay.mockClear();
  document.body.innerHTML = '';
  view = 'library';
});

describe('Shift+Space is Stop all', () => {
  it('in the Library, with no player on screen', () => {
    const e = press({ shiftKey: true });
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(player.togglePlay).not.toHaveBeenCalled();
  });

  it('in the player, instead of play / pause; Space alone still plays / pauses', () => {
    view = 'player';
    press({ shiftKey: true });
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(player.togglePlay).not.toHaveBeenCalled();
    press({});
    expect(player.togglePlay).toHaveBeenCalledTimes(1);
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('a held key stops once, not once per auto-repeat', () => {
    press({ shiftKey: true });
    press({ shiftKey: true, repeat: true });
    press({ shiftKey: true, repeat: true });
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('a focused text field keeps it (typing with Shift held types a space)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const e = press({ shiftKey: true }, input);
    expect(stopAll).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Ctrl / Alt / Meta+Shift+Space are not it', () => {
    press({ shiftKey: true, ctrlKey: true });
    press({ shiftKey: true, altKey: true });
    press({ shiftKey: true, metaKey: true });
    expect(stopAll).not.toHaveBeenCalled();
  });
});
