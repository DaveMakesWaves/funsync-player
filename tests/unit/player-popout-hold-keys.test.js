/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer and controls on
 * the DOM of player-popout.html at import time.
 */
// X and Z in the popped-out player (next major, Dave 2026-11-17: "yes").
// The player window had no X / Z: while it had the focus, only the global
// hotkeys reached the Orgasm Switch and Edge Hold. Now the window sends the
// press and the release up the pop-out protocol, the way the main window's
// keyboard.js reports them to _onOrgasmHold / _onEdgeHold:
//   - the press once (keydown auto-repeats while a key is held),
//   - the release on keyup, not gated on focus (a started hold must end),
//   - a focused text field keeps its X / Z (targetOwnsKey, as every key here),
//   - the Latin letter on the key (layoutKey): a Russian layout's ч / я.
// The main window's half (the message reaching the handlers) is in
// player-popout-hold-keys-main.test.js.
//
// Assertions: the messages the pop-out sends to main.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];
let onEvent = null;
const holds = () => up.filter((m) => m.type === PLAYERWIN.ORGASM_HOLD || m.type === PLAYERWIN.EDGE_HOLD);

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const key = (type, k, code, target = window, extra = {}) => target.dispatchEvent(new KeyboardEvent(type, {
  key: k, code, bubbles: true, cancelable: true, ...extra,
}));
const down = (k, code, target, extra) => key('keydown', k, code, target, extra);
const upKey = (k, code, target, extra) => key('keyup', k, code, target, extra);

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  HTMLMediaElement.prototype.play = vi.fn(function play() {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  });
  HTMLMediaElement.prototype.pause = vi.fn(function pause() {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
  HTMLMediaElement.prototype.load = vi.fn();
  window.funsync = {
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-parent') up.push(payload); },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
  };
  await import('../../renderer/player-popout.js');
  onEvent({ type: 'opened' });
  await until(() => up.some((m) => m.type === PLAYERWIN.READY));
}, 20000);

beforeEach(() => {
  // A hold left over by a failed test would swallow the next press.
  upKey('x', 'KeyX');
  upKey('z', 'KeyZ');
  up.length = 0;
  document.activeElement?.blur?.();
});

describe('the protocol carries X and Z up', () => {
  it('two pop-out → main types with an active flag, both known', () => {
    expect(PLAYERWIN.ORGASM_HOLD).toBe('orgasm-hold');
    expect(PLAYERWIN.EDGE_HOLD).toBe('edge-hold');
    expect(PLAYERWIN.ALL_MESSAGE_TYPES).toContain(PLAYERWIN.ORGASM_HOLD);
    expect(PLAYERWIN.ALL_MESSAGE_TYPES).toContain(PLAYERWIN.EDGE_HOLD);
    expect(new Set(PLAYERWIN.ALL_MESSAGE_TYPES).size).toBe(PLAYERWIN.ALL_MESSAGE_TYPES.length);
  });
});

describe('X in the player window', () => {
  it('a press sends the Orgasm hold once, however long the key auto-repeats; the release lets go', () => {
    down('x', 'KeyX');
    down('x', 'KeyX', window, { repeat: true });
    down('x', 'KeyX', window, { repeat: true });
    expect(holds()).toEqual([{ type: 'orgasm-hold', active: true }]);
    upKey('x', 'KeyX');
    expect(holds()).toEqual([
      { type: 'orgasm-hold', active: true },
      { type: 'orgasm-hold', active: false },
    ]);
  });

  it('the press is the page\'s: the default is prevented (no typing, no menu key)', () => {
    const ev = new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Shift or Caps Lock (X) works too, and a second hold starts after the release', () => {
    down('X', 'KeyX', window, { shiftKey: true });
    upKey('X', 'KeyX', window, { shiftKey: true });
    down('x', 'KeyX');
    upKey('x', 'KeyX');
    expect(holds().map((m) => m.active)).toEqual([true, false, true, false]);
  });

  it('a key-up with no hold sends nothing', () => {
    upKey('x', 'KeyX');
    upKey('z', 'KeyZ');
    expect(holds()).toEqual([]);
  });
});

describe('Z in the player window', () => {
  it('a press sends the Edge hold once; the release lets go', () => {
    down('z', 'KeyZ');
    down('z', 'KeyZ', window, { repeat: true });
    upKey('z', 'KeyZ');
    expect(holds()).toEqual([
      { type: 'edge-hold', active: true },
      { type: 'edge-hold', active: false },
    ]);
  });

  it('X and Z held together are two holds, each with its own release', () => {
    down('z', 'KeyZ');
    down('x', 'KeyX');
    upKey('z', 'KeyZ');
    upKey('x', 'KeyX');
    expect(holds()).toEqual([
      { type: 'edge-hold', active: true },
      { type: 'orgasm-hold', active: true },
      { type: 'edge-hold', active: false },
      { type: 'orgasm-hold', active: false },
    ]);
  });
});

describe('the main window\'s rules', () => {
  it('a Russian layout (ч on X, я on Z) holds and lets go by the key, as keyboard.js does', () => {
    down('ч', 'KeyX');
    upKey('ч', 'KeyX');
    down('я', 'KeyZ');
    upKey('я', 'KeyZ');
    expect(holds()).toEqual([
      { type: 'orgasm-hold', active: true },
      { type: 'orgasm-hold', active: false },
      { type: 'edge-hold', active: true },
      { type: 'edge-hold', active: false },
    ]);
  });

  it('a focused text field keeps its X and Z (nothing is sent)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    down('x', 'KeyX', input);
    down('z', 'KeyZ', input);
    upKey('x', 'KeyX', input);
    expect(holds()).toEqual([]);
    input.remove();
  });

  it('a hold that started still ends when a field took the focus meanwhile (keyup is not gated)', () => {
    down('x', 'KeyX');
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    upKey('x', 'KeyX', input);
    expect(holds()).toEqual([
      { type: 'orgasm-hold', active: true },
      { type: 'orgasm-hold', active: false },
    ]);
    input.remove();
  });

  it('the other keys are unchanged: N still asks for the next video, and sends no hold', () => {
    down('n', 'KeyN');
    expect(up.filter((m) => m.type === PLAYERWIN.LOAD_NEXT)).toHaveLength(1);
    expect(holds()).toEqual([]);
  });
});
