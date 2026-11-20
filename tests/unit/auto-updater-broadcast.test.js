/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-101 (also in v0.9.2): the updater's events reached the main window
// only (_send targeted _mainWindow), so someone watching in the detached
// player window never saw "Update available" or "ready to install".
// electron/auto-updater.js now also tells the windows main.js hands it
// (the player pop-out, through playerPopout.getWindow()).
//
// The REAL module, loaded with electron-updater replaced by an EventEmitter
// that behaves like its autoUpdater (events in, checkForUpdates a no-op).
// Asserted: which windows receive which channel and payload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let updater;
let mod;

function loadModule() {
  updater = new EventEmitter();
  updater.checkForUpdates = vi.fn();
  updater.downloadUpdate = vi.fn();
  updater.quitAndInstall = vi.fn();
  const stubs = {
    'electron-updater': { autoUpdater: updater },
    './logger': { info() {}, warn() {}, error() {} },
  };
  const resolved = require_.resolve('../../electron/auto-updater.js');
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

/** A BrowserWindow stand-in: records what its renderer is sent. */
function fakeWindow(name) {
  return {
    name,
    destroyed: false,
    sent: [],
    isDestroyed() { return this.destroyed; },
    webContents: { send(channel, data) { this.owner.sent.push([channel, data]); } },
  };
}
const win = (name) => { const w = fakeWindow(name); w.webContents.owner = w; return w; };

beforeEach(() => {
  vi.useFakeTimers(); // the 5 s first check
  mod = loadModule();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FT-101: the update notices reach the player window too', () => {
  it('"update available" reaches the main window AND the open player pop-out, same payload', () => {
    const main = win('main');
    const popout = win('popout');
    mod.initAutoUpdater(main, { getExtraWindows: () => [popout] });
    updater.emit('update-available', { version: '9.9.9', releaseDate: '2026-11-07', releaseNotes: 'x' });
    const expected = ['update:available', { version: '9.9.9', releaseDate: '2026-11-07', releaseNotes: 'x' }];
    expect(main.sent).toEqual([expected]);
    expect(popout.sent).toEqual([expected]);
  });

  it('"downloaded" too (the Restart Now toast)', () => {
    const main = win('main');
    const popout = win('popout');
    mod.initAutoUpdater(main, { getExtraWindows: () => [popout] });
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(popout.sent).toEqual([['update:downloaded', { version: '9.9.9' }]]);
    expect(main.sent).toEqual([['update:downloaded', { version: '9.9.9' }]]);
  });

  it('the window is asked for at each send: a pop-out opened later hears the next event, a closed one is skipped', () => {
    const main = win('main');
    let popout = null;
    mod.initAutoUpdater(main, { getExtraWindows: () => [popout] });
    updater.emit('update-available', { version: '9.9.9' }); // no pop-out yet
    popout = win('popout');
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(popout.sent).toEqual([['update:downloaded', { version: '9.9.9' }]]);
    popout.destroyed = true;
    updater.emit('error', new Error('net down'));
    expect(popout.sent).toHaveLength(1);
    expect(main.sent.map((s) => s[0])).toEqual(['update:available', 'update:downloaded', 'update:error']);
  });

  it('no pop-out: the main window only, as before', () => {
    const main = win('main');
    mod.initAutoUpdater(main);
    updater.emit('update-available', { version: '9.9.9' });
    expect(main.sent).toEqual([['update:available', { version: '9.9.9', releaseDate: undefined, releaseNotes: undefined }]]);
  });

  it('a getter that throws never stops the main window hearing it', () => {
    const main = win('main');
    mod.initAutoUpdater(main, { getExtraWindows: () => { throw new Error('gone'); } });
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(main.sent).toEqual([['update:downloaded', { version: '9.9.9' }]]);
  });

  it('the same window listed twice gets each event once', () => {
    const main = win('main');
    mod.initAutoUpdater(main, { getExtraWindows: () => [main] });
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(main.sent).toHaveLength(1);
  });
});

describe('FT-101: main.js hands the updater the player pop-out', () => {
  it('the getter main.js passes returns the pop-out window that is open now', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('electron/main.js', 'utf8');
    const m = /initAutoUpdater\(mainWindow,\s*(\{[\s\S]*?\})\);/.exec(src);
    expect(m, 'initAutoUpdater(mainWindow, { ... }) in main.js').not.toBeNull();
    let open = null;
    const playerPopout = { getWindow: () => open };
    // eslint-disable-next-line no-new-func
    const opts = new Function('playerPopout', `return (${m[1]});`)(playerPopout);
    const main = win('main');
    mod.initAutoUpdater(main, opts);
    open = win('popout');
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(open.sent).toEqual([['update:downloaded', { version: '9.9.9' }]]);
  });
});
