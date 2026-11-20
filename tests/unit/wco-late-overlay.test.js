/**
 * @vitest-environment jsdom
 * jsdom on purpose: the class lives on the real <html> element, and wco.js
 * reads `navigator`, `document` and `window` (notes/CLAUDE.md "Test
 * environments").
 */
// FT-055, a HEDGE for #381 (zaikechi, also in v0.9.2): on the first launch
// after a reboot or sleep, no title-bar drag and no Settings button; a restart
// fixes it. All the drag-region and caption-inset CSS is scoped under
// html.has-wco, and the class was set ONCE at boot from
// navigator.windowControlsOverlay.visible, with no listener for a change. An
// overlay that becomes visible a moment after that check would leave the
// window without a drag region for the session. That timing is not proven;
// the shipped code re-checks and logs, and the item stays open until his log
// says what happened.
//
// The overlay here is a fake with the real API's shape: an EventTarget with a
// `visible` flag that fires `geometrychange` when it changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyWcoClass, watchWcoClass } from '../../renderer/js/wco.js';
import { APP_SRC, liftMethod } from './helpers/app-methods.js';

const hasWco = () => document.documentElement.classList.contains('has-wco');

/** A Windows Controls Overlay: an EventTarget whose `visible` can flip. */
function fakeOverlay(visible) {
  const overlay = new EventTarget();
  overlay.visible = visible;
  overlay.flip = (next) => {
    overlay.visible = next;
    overlay.dispatchEvent(new Event('geometrychange'));
  };
  return overlay;
}

let watcher = null;
beforeEach(() => {
  document.documentElement.classList.remove('has-wco');
});
afterEach(() => {
  watcher?.stop();
  watcher = null;
  delete navigator.windowControlsOverlay;
  document.documentElement.classList.remove('has-wco');
  vi.restoreAllMocks();
});

function install(overlay) {
  Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay, configurable: true });
}

describe('FT-055: html.has-wco follows the overlay for the whole session', () => {
  it('an overlay that turns visible after boot gets the class (drag region, caption insets), and loses it again when hidden', () => {
    const overlay = fakeOverlay(false);
    install(overlay);
    const log = { info: vi.fn() };
    watcher = watchWcoClass({ log });
    expect(hasWco()).toBe(false); // what the first launch after a reboot would have shown

    overlay.flip(true);
    expect(hasWco()).toBe(true);
    overlay.flip(false);
    expect(hasWco()).toBe(false);
  });

  it('visible at boot: the class is set at once, as before', () => {
    install(fakeOverlay(true));
    watcher = watchWcoClass({ log: { info: () => {} } });
    expect(hasWco()).toBe(true);
    expect(watcher.visible).toBe(true);
  });

  it('logs the boot state once and, once, how late the overlay turned visible', () => {
    const overlay = fakeOverlay(false);
    install(overlay);
    const log = { info: vi.fn() };
    watcher = watchWcoClass({ log });
    overlay.flip(true);
    overlay.flip(false);
    overlay.flip(true);
    const lines = log.info.mock.calls.map(([l]) => l);
    expect(lines[0]).toBe('[WCO] overlay visible=false at boot');
    expect(lines.filter((l) => l.startsWith('[WCO] became visible after '))).toHaveLength(1);
    expect(lines[1]).toMatch(/^\[WCO\] became visible after \d+ ms$/);
    expect(lines).toHaveLength(2);
  });

  it('a pop-out names itself in the lines, and an overlay visible from the start logs no late line', () => {
    const overlay = fakeOverlay(true);
    install(overlay);
    const log = { info: vi.fn() };
    watcher = watchWcoClass({ where: 'player pop-out', log });
    overlay.flip(true);
    expect(log.info.mock.calls.map(([l]) => l)).toEqual(['[WCO] overlay visible=true at boot (player pop-out)']);
  });

  it('the re-check after the first frame catches an overlay that turned visible without a geometrychange', () => {
    const raf = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { raf.push(cb); return raf.length; });
    const overlay = fakeOverlay(false);
    install(overlay);
    watcher = watchWcoClass({ log: { info: () => {} } });
    overlay.visible = true; // no event
    expect(hasWco()).toBe(false);
    for (const cb of raf.splice(0)) cb(0);
    expect(hasWco()).toBe(true);
  });

  it('no overlay at all (Linux, older runtime): no class, nothing thrown', () => {
    expect(() => { watcher = watchWcoClass({ log: { info: () => {} } }); }).not.toThrow();
    expect(hasWco()).toBe(false);
    expect(applyWcoClass()).toBe(false);
  });

  it('stop() removes the listener', () => {
    const overlay = fakeOverlay(false);
    install(overlay);
    watcher = watchWcoClass({ log: { info: () => {} } });
    watcher.stop();
    overlay.flip(true);
    expect(hasWco()).toBe(false);
  });
});

describe('FT-055 seam: every window that can run frameless watches, not checks once', () => {
  it('the main window\'s boot (app.js init) calls watchWcoClass and no longer toggles has-wco itself', () => {
    const init = liftMethod(APP_SRC, 'init');
    expect(init).toMatch(/watchWcoClass\(/);
    expect(init).not.toMatch(/classList\.toggle\(\s*'has-wco'/);
  });

  it('the three pop-out windows call watchWcoClass at load', async () => {
    const fs = await import('node:fs');
    for (const file of ['renderer/player-popout.js', 'renderer/editor-popout.js', 'renderer/audience-room.js']) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, file).toMatch(/^watchWcoClass\(\{ where: '[^']+' \}\);$/m);
      expect(src, file).not.toMatch(/^applyWcoClass\(\);$/m);
    }
  });
});
