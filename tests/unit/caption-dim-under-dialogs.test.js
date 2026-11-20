/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Modal builds its dialogs in the document.
 */
// FT-100 (also in v0.9.2): the Windows caption buttons (minimise, maximise,
// close) stayed full brightness over a dimmed window while a dialog was open.
// The backdrop (black at 60%, modal.css) dims the page, but the OS draws the
// caption strip above the page, and nothing told it a dialog was up.
//
// Three real pieces, end to end:
//   1. modal.js says when the first dialog opens and the last one closes
//      ('modal:backdrop'), once each, however many are stacked;
//   2. app.js `_syncCaptionOverlay` (lifted) passes it to the main process,
//      in the library and in the player view, and says when it ends;
//   3. main.js's update-window-chrome handler (lifted verbatim, over a fake
//      BrowserWindow, at the 125% strip height) paints the strip transparent
//      and the symbols as the backdrop blends the page, remembers it for a
//      call that does not say (the theme manager's retint), and restores the
//      themed strip when the dialog closes.
// Asserted: the overlay colours a fake window ends up with.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { liftAppClass } from './helpers/app-methods.js';

const require_ = createRequire(import.meta.url);
const windowBg = require_('../../electron/window-bg.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { Modal } = await import('../../renderer/components/modal.js');

const COLORS = { background: '#1a1a2e', chrome: '#16213e', symbol: '#e0e0e6' };
const TRANSPARENT = '#00000000';

// --- main.js's handler, lifted -------------------------------------------
// LF whatever the checkout: CI's Windows runner checks out with CRLF (v0.10.0 tag, 2026-11-20).
const MAIN_SRC = fs.readFileSync('electron/main.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (start, end) => {
  const i = MAIN_SRC.indexOf(start);
  if (i < 0) throw new Error(`not found in main.js: ${start}`);
  const j = MAIN_SRC.indexOf(end, i);
  return MAIN_SRC.slice(i, j + end.length);
};

/** A BrowserWindow whose overlay keeps what setTitleBarOverlay() is given, as Electron's does. */
function fakeWin() {
  const overlay = { color: COLORS.chrome, symbolColor: COLORS.symbol, height: 60 };
  return {
    id: 1,
    overlay,
    webContents: { getZoomFactor: () => 1.25 },
    isDestroyed: () => false,
    setBackgroundColor() {},
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    setTitleBarOverlay: (o) => Object.assign(overlay, o),
  };
}

function liftHandler(win) {
  const handlers = {};
  const fakeRequire = (id) => {
    if (id === './window-bg') return { colorsForTheme: () => COLORS, dimColor: windowBg.dimColor };
    if (id === 'electron') return { screen: { getCursorScreenPoint: () => ({ x: -1, y: -1 }) } };
    throw new Error(`unexpected require(${id})`);
  };
  const src = [
    'let mainWindow = null;',
    lift('const _captionHoverPolls = new Map();', ';\n'),
    lift('const _captionDimmed = new Map();', ';\n'),
    lift('function _cursorOverCaption(', '\n}\n'),
    lift("ipcMain.handle('update-window-chrome'", '\n});\n'),
    'return _captionHoverPolls;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const polls = new Function('require', 'process', 'BrowserWindow', 'ipcMain', 'uiScale', src)(
    fakeRequire, { platform: 'win32' }, { fromWebContents: () => win },
    { handle: (name, fn) => { handlers[name] = fn; } },
    { titleBarHeightFor: () => 60 },
  );
  return { chrome: (theme, opts) => handlers['update-window-chrome']({ sender: {} }, theme, opts), polls };
}

// --- app.js's caption sync, lifted --------------------------------------
function liftApp(send) {
  const Lifted = liftAppClass(['_syncCaptionOverlay', '_onModalBackdrop'], {
    window: { funsync: { updateWindowChrome: send } },
    document,
  });
  const app = new Lifted();
  app.settings = { get: (k) => (k === 'player.theme' ? 'dark' : undefined) };
  app._view = 'library';
  app._currentView = () => app._view;
  app._captionRect = () => ({ x: 1100, y: 0, width: 180, height: 48 });
  return app;
}

let win;
let main;
let app;
let sent;
let unsubscribe;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  win = fakeWin();
  main = liftHandler(win);
  sent = [];
  // The renderer's IPC call lands in the lifted handler, as preload + main do.
  app = liftApp((theme, opts) => { sent.push(opts ? { theme, ...opts } : { theme }); main.chrome(theme, opts); });
  unsubscribe = eventBus.on('modal:backdrop', (s) => app._onModalBackdrop(s));
  app._syncCaptionOverlay(); // the library view's themed strip
  sent.length = 0;
});

afterEach(() => {
  unsubscribe?.();
  for (const id of main.polls.values()) clearInterval(id);
  document.body.innerHTML = '';
});

/** Open a dialog through the REAL Modal; returns its close(). */
function openDialog(title) {
  let close;
  Modal.open({ title, onRender: (_body, c) => { close = c; } });
  return () => close(null);
}

describe('FT-100: the caption buttons dim under a dialog', () => {
  it('library: a dialog makes the strip transparent and the symbols dimmed; closing it restores the themed strip', () => {
    expect(win.overlay).toMatchObject({ color: COLORS.chrome, symbolColor: COLORS.symbol, height: 60 });
    const close = openDialog('Settings');
    expect(win.overlay).toMatchObject({
      color: TRANSPARENT,
      symbolColor: windowBg.dimColor(COLORS.symbol),
      height: 60, // still at the 125% height
    });
    expect(windowBg.dimColor(COLORS.symbol)).toBe('#5a5a5c'); // 60% toward black
    close();
    expect(win.overlay).toMatchObject({ color: COLORS.chrome, symbolColor: COLORS.symbol, height: 60 });
  });

  it('two stacked dialogs: dimmed once, back once, when the LAST one closes', () => {
    const closeSettings = openDialog('Settings');
    const closeConfirm = openDialog('Remove source?');
    expect(sent).toEqual([{ theme: 'dark', dimmed: true }]);
    closeConfirm();
    expect(win.overlay.color).toBe(TRANSPARENT); // Settings is still open
    closeSettings();
    expect(sent).toEqual([{ theme: 'dark', dimmed: true }, { theme: 'dark', dimmed: false }]);
    expect(win.overlay.color).toBe(COLORS.chrome);
  });

  it('a retint that does not mention the dialog (Settings > theme) keeps the strip dimmed', () => {
    const close = openDialog('Settings');
    main.chrome('dark'); // theme-manager's updateWindowChrome(setting)
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: '#5a5a5c' });
    close();
    expect(win.overlay.color).toBe(COLORS.chrome);
  });

  it('player view: the strip stays over the video, only the white symbols dim', () => {
    app._view = 'player';
    document.body.insertAdjacentHTML('beforeend', '<div class="player-container controls-visible"></div>');
    app._syncCaptionOverlay();
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: '#ffffff' });
    const close = openDialog('Add Variation');
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: '#666666' });
    close();
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: '#ffffff' });
  });

  it('with no dialog, every call is exactly as before (nothing extra sent)', () => {
    app._view = 'player';
    app._syncCaptionOverlay(true);
    app._view = 'library';
    app._syncCaptionOverlay();
    expect(sent).toEqual([
      { theme: 'dark', overVideo: true, hideSymbols: false, captionRect: { x: 1100, y: 0, width: 180, height: 48 } },
      { theme: 'dark' },
    ]);
  });
});

// E2-08 (also in v0.9.2): the Devices panel has its own backdrop
// (`.connection-panel__backdrop`, the same black at 60%), not Modal's, so it
// never said 'modal:backdrop' and the caption buttons stayed bright over it.
// The REAL ConnectionPanel now says it on open and close, as a second source:
// app.js keeps the strip dimmed while either is up, so the Safety Cap
// confirm closing over the still-open panel does not light the buttons.
const { ConnectionPanel } = await import('../../renderer/components/connection-panel.js');

describe('E2-08: the Devices panel\'s own backdrop dims the caption buttons too', () => {
  const settingsFake = () => {
    const map = new Map();
    return {
      get: (k) => map.get(k), set: (k, v) => map.set(k, v),
      getPlaylists: () => [], getPlaylist: () => null,
      getCategories: () => [], getCategory: () => null, getVideosByCategory: () => [],
    };
  };
  const devicesPanel = () => new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });

  it('library: opening the panel dims the strip, closing it restores the themed strip', () => {
    const panel = devicesPanel();
    panel.show();
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: windowBg.dimColor(COLORS.symbol), height: 60 });
    panel.hide();
    expect(win.overlay).toMatchObject({ color: COLORS.chrome, symbolColor: COLORS.symbol, height: 60 });
    expect(sent).toEqual([{ theme: 'dark', dimmed: true }, { theme: 'dark', dimmed: false }]);
  });

  it('a dialog opened from the panel and closed again leaves the strip dimmed until the panel closes', () => {
    const panel = devicesPanel();
    panel.show();
    const closeConfirm = openDialog('Raise the Safety Cap to 100%?');
    closeConfirm();
    expect(win.overlay.color).toBe(TRANSPARENT); // the panel is still open
    panel.hide();
    expect(win.overlay.color).toBe(COLORS.chrome);
    expect(sent).toEqual([{ theme: 'dark', dimmed: true }, { theme: 'dark', dimmed: false }]);
  });

  it('player view: only the white symbols dim, over the video', () => {
    app._view = 'player';
    document.body.insertAdjacentHTML('beforeend', '<div class="player-container controls-visible"></div>');
    app._syncCaptionOverlay();
    const panel = devicesPanel();
    panel.toggle(); // H
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: '#666666' });
    panel.toggle();
    expect(win.overlay).toMatchObject({ color: TRANSPARENT, symbolColor: '#ffffff' });
  });

  it('hide() on a closed panel (every Esc in the player calls it) and a second show() say nothing', () => {
    const panel = devicesPanel();
    panel.hide();
    panel.hide();
    expect(sent).toEqual([]);
    panel.show();
    panel.show();
    expect(sent).toEqual([{ theme: 'dark', dimmed: true }]);
    panel.hide();
    panel.hide();
    expect(sent).toEqual([{ theme: 'dark', dimmed: true }, { theme: 'dark', dimmed: false }]);
  });
});

describe('dimColor', () => {
  it('blends toward black by the backdrop\'s alpha, #rgb too, and leaves a colour it cannot read alone', () => {
    expect(windowBg.dimColor('#ffffff')).toBe('#666666');
    expect(windowBg.dimColor('#333')).toBe('#141414');
    expect(windowBg.dimColor('#16213e', 0)).toBe('#16213e');
    expect(windowBg.dimColor('#16213e', 1)).toBe('#000000');
    expect(windowBg.dimColor('transparent')).toBe('transparent');
  });
});
