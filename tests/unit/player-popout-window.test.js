/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The detached player window's lifecycle in MAIN (electron/player-popout-window.js),
// loaded for real with `electron` swapped for a BrowserWindow stand-in that
// behaves like Electron's: a crashed renderer leaves the window alive and
// NOT destroyed, destroy() emits 'closed', minimise/restore/raise are state.
//
//   V14  a crashed pop-out renderer was never detected or logged. isOpen()
//        stayed true (the window is not destroyed), relay() kept sending into
//        a disposed frame, and the main renderer kept routing every video into
//        a dead window with no toast.
//   V16  a minimised or buried pop-out was not restored or raised when it got
//        a new video: sound and device motion with no picture.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// open() requires './window-bg' lazily (it reads config.json and the OS
// theme), so stub it in the require cache rather than only during load.
const WINDOW_BG = require_.resolve('../../electron/window-bg.js');
const savedWindowBg = require_.cache[WINDOW_BG];
require_.cache[WINDOW_BG] = {
  id: WINDOW_BG, filename: WINDOW_BG, loaded: true,
  exports: { resolveWindowColors: () => ({ background: '#000' }), winChromeOptions: () => ({}) },
};
afterAll(() => {
  if (savedWindowBg) require_.cache[WINDOW_BG] = savedWindowBg;
  else delete require_.cache[WINDOW_BG];
});

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.crashed = false;
    this.sent = [];
  }

  send(channel, msg) {
    // Electron logs "Render frame was disposed" on stderr and drops it.
    if (this.crashed) { this.sentWhileCrashed = (this.sentWhileCrashed || 0) + 1; return; }
    this.sent.push([channel, msg]);
  }

  isCrashed() { return this.crashed; }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.minimized = false;
    this.visible = true;
    this.focused = false;
    this.onTop = false;
    this.calls = [];
    FakeBrowserWindow.last = this;
  }

  loadFile() {}
  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  // Electron: close() waits for the page's unload, which a HUNG page never
  // runs, so the window stays up (FT-098). destroy() always works.
  close() { if (this.webContents.hung) return; this.destroy(); }
  getBounds() { return { width: 960, height: 540 }; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible && !this.minimized; }
  minimize() { this.minimized = true; this.focused = false; }
  restore() { this.calls.push('restore'); this.minimized = false; this.focused = true; }
  showInactive() { this.calls.push('showInactive'); this.minimized = false; this.visible = true; }
  focus() { this.calls.push('focus'); this.focused = true; }
  moveTop() { this.calls.push('moveTop'); this.onTop = true; }

  /** What Electron does when the renderer dies: the window stays. */
  crashRenderer(details = { reason: 'crashed', exitCode: -1073741819 }) {
    this.webContents.crashed = true;
    this.webContents.emit('render-process-gone', {}, details);
  }
}

function fakeParent() {
  const parent = new EventEmitter();
  parent.webContents = new FakeWebContents();
  parent.isDestroyed = () => false;
  return parent;
}

let popout;
let log;

/** The real module, with electron, window-bg and the logger stubbed. */
function loadModule() {
  log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const stubs = {
    electron: { BrowserWindow: FakeBrowserWindow },
    './logger': log,
  };
  const resolved = require_.resolve('../../electron/player-popout-window.js');
  delete require_.cache[resolved];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return origLoad.call(this, request, ...rest);
  };
  try {
    return require_(resolved);
  } finally {
    Module._load = origLoad;
  }
}

const store = { getSetting: () => null, setSetting: () => {} };
let parent;
let win;

beforeEach(() => {
  popout = loadModule();
  parent = fakeParent();
  popout.open(parent, store);
  win = FakeBrowserWindow.last;
  parent.webContents.sent = []; // drop the 'opened' notice
});

afterEach(() => {
  popout.close();
});

describe('V14: a crashed pop-out renderer', () => {
  it('is logged, with the reason and exit code', () => {
    win.crashRenderer({ reason: 'crashed', exitCode: -1073741819 });
    const line = log.warn.mock.calls.find((c) => String(c[0]).includes('[PlayerPopout] renderer gone'));
    expect(line).toBeDefined();
    expect(line).toContain('crashed');
    expect(line).toContain(-1073741819);
  });

  it('tells the main renderer the window closed, and why, so playback folds back inline', () => {
    win.crashRenderer();
    expect(parent.webContents.sent).toEqual([
      ['player-popout:event', { type: 'closed', reason: 'crashed' }],
    ]);
  });

  it('is no longer "open", and nothing more is sent into the dead frame', () => {
    win.crashRenderer();
    expect(popout.isOpen()).toBe(false);
    popout.relay('to-popout', { type: 'load-video', src: 'file:///D:/Lib/Bravo.mp4' });
    popout.relay('to-popout', { type: 'heatmap', actions: [] });
    expect(win.webContents.sentWhileCrashed || 0).toBe(0);
  });

  it('a pop-out opened after the crash works normally (no stale crash reason)', () => {
    win.crashRenderer();
    popout.open(parent, store);
    const next = FakeBrowserWindow.last;
    expect(next).not.toBe(win);
    parent.webContents.sent = [];
    next.close();
    expect(parent.webContents.sent).toEqual([['player-popout:event', { type: 'closed' }]]);
  });

  it('an ordinary close carries no crash reason', () => {
    popout.close();
    expect(parent.webContents.sent).toEqual([['player-popout:event', { type: 'closed' }]]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a hung renderer is logged but left alone (it may recover)', () => {
    win.webContents.emit('unresponsive');
    expect(log.warn.mock.calls.some((c) => String(c[0]).includes('not responding'))).toBe(true);
    expect(popout.isOpen()).toBe(true);
  });
});

describe('V16: a new video brings the pop-out up', () => {
  it('a minimised window is restored and raised, without taking focus from the main window', () => {
    win.minimize();
    expect(popout.reveal()).toBe(true);
    expect(win.isMinimized()).toBe(false);
    expect(win.isVisible()).toBe(true);
    expect(win.onTop).toBe(true);
    expect(win.focused).toBe(false);
  });

  it('a window buried behind the main one is raised', () => {
    expect(popout.reveal()).toBe(true);
    expect(win.onTop).toBe(true);
    expect(win.calls).not.toContain('focus');
  });

  it('with no window there is nothing to reveal', () => {
    popout.close();
    expect(popout.reveal()).toBe(false);
  });
});

// FT-098 (also in v0.9.2): a hung (not crashed) pop-out was only logged.
// While it hangs no clock reaches the main window, and the user was told
// nothing. Main now tells the main renderer when the window stops and starts
// answering; the main renderer stops the devices and offers "Close player
// window", and that close works on a hung page. Nothing is killed on its own.
describe('FT-098: a hung pop-out renderer', () => {
  const hang = () => { win.webContents.hung = true; win.webContents.emit('unresponsive'); };
  const recover = () => { win.webContents.hung = false; win.webContents.emit('responsive'); };

  it('tells the main renderer it stopped answering, and when it answers again', () => {
    hang();
    expect(parent.webContents.sent).toEqual([['player-popout:event', { type: 'unresponsive' }]]);
    recover();
    expect(parent.webContents.sent.at(-1)).toEqual(['player-popout:event', { type: 'responsive' }]);
    expect(log.info.mock.calls.some((c) => String(c[0]).includes('responding again'))).toBe(true);
  });

  it('is never closed on its own while it hangs', () => {
    hang();
    expect(popout.isOpen()).toBe(true);
    expect(win.destroyed).toBe(false);
  });

  it('a close asked for while it hangs takes the window down, and says why', () => {
    hang();
    parent.webContents.sent = [];
    popout.close();
    expect(win.destroyed).toBe(true);
    expect(popout.isOpen()).toBe(false);
    expect(parent.webContents.sent).toEqual([
      ['player-popout:event', { type: 'closed', reason: 'unresponsive' }],
    ]);
  });

  it('answering again: a close is an ordinary close', () => {
    hang();
    recover();
    parent.webContents.sent = [];
    popout.close();
    expect(win.destroyed).toBe(true);
    expect(parent.webContents.sent).toEqual([['player-popout:event', { type: 'closed' }]]);
  });

  it('the next window opened after a hung one closes normally', () => {
    hang();
    popout.close();
    popout.open(parent, store);
    const next = FakeBrowserWindow.last;
    expect(next).not.toBe(win);
    parent.webContents.sent = [];
    popout.close();
    expect(parent.webContents.sent).toEqual([['player-popout:event', { type: 'closed' }]]);
  });
});
