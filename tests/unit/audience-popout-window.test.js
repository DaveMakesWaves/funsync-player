/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The audience room window's lifecycle in MAIN (electron/audience-popout-window.js),
// loaded for real with `electron` swapped for a BrowserWindow stand-in.
//
// Found by the #361 live verify (2026-11-04): closing the main window with the
// room window open logged "Uncaught exception: TypeError: Object has been
// destroyed" at the pop-out's 'closed' handler. While the main window closes,
// its isDestroyed() can still be false after its webContents is gone, and the
// child pop-out closes in that gap. Real Electron throws from send() on a
// destroyed webContents; the fake below does the same.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// open() requires './window-bg' lazily (config.json + OS theme): stub it.
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
    this.destroyed = false;
    this.sent = [];
  }

  send(channel, msg) {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    this.sent.push([channel, msg]);
  }

  isDestroyed() { return this.destroyed; }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeBrowserWindow.last = this;
  }

  loadFile() {}
  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
  close() { this.destroy(); }
  getBounds() { return { width: 720, height: 600 }; }
  isMinimized() { return false; }
  restore() {}
  focus() {}
}

function fakeParent() {
  const parent = new EventEmitter();
  parent.webContents = new FakeWebContents();
  parent.destroyed = false;
  parent.isDestroyed = () => parent.destroyed;
  return parent;
}

function loadModule() {
  const stubs = { electron: { BrowserWindow: FakeBrowserWindow } };
  const resolved = require_.resolve('../../electron/audience-popout-window.js');
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
let popout;
let parent;
let win;

beforeEach(() => {
  popout = loadModule();
  parent = fakeParent();
  popout.open(parent, store);
  win = FakeBrowserWindow.last;
});

afterEach(() => {
  popout.close();
});

const types = (wc) => wc.sent.map(([, m]) => m.type);

describe('audience room window: sends to the main window', () => {
  it('tells the main window it opened, and that it closed', () => {
    expect(types(parent.webContents)).toEqual(['opened']);
    popout.close();
    expect(types(parent.webContents)).toEqual(['opened', 'closed']);
    expect(popout.isOpen()).toBe(false);
  });

  it('does not throw when the main window\'s webContents is gone before the room window closes', () => {
    // The main window is closing: its webContents is destroyed, the window
    // itself does not read destroyed yet, and the child closes in that gap.
    parent.webContents.destroyed = true;
    expect(() => win.destroy()).not.toThrow();
    expect(popout.isOpen()).toBe(false);
  });

  it('relay() to a main window whose webContents is gone is dropped, not thrown', () => {
    parent.webContents.destroyed = true;
    expect(() => popout.relay('to-parent', { type: 'x' })).not.toThrow();
  });

  it('relay() still reaches both sides while they are alive', () => {
    popout.relay('to-parent', { kind: 'a' });
    popout.relay('to-popout', { kind: 'b' });
    expect(parent.webContents.sent.at(-1)[1]).toEqual({ type: 'message', payload: { kind: 'a' } });
    expect(win.webContents.sent.at(-1)[1]).toEqual({ type: 'message', payload: { kind: 'b' } });
  });
});
