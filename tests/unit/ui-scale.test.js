/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds the Appearance area as DOM. The main-process half (store.js on the
 * real electron-conf, electron/ui-scale.js) runs in the same file so one
 * test can follow a change from the select to the window and back.
 */
// Settings > Appearance > Interface size (Pudknocker, EroScripts #372; app
// test V79).
//
// One value, settings.player.uiScale (percent, default 100 in store.js), is
// the main window's zoom. Main opens the window at it, the View menu's
// Ctrl+= / Ctrl+- / Ctrl+0 step through the same steps and SAVE them (and
// tell the renderer, so an open Settings panel shows the new size), and the
// Settings select applies at once through set-setting. Pop-outs keep their
// own per-session zoom, as the built-in zoom roles did.
//
// Real code under test: electron/store.js on the REAL electron-conf (a
// config.json in a temp userData dir), electron/ui-scale.js, the REAL
// DataService, the REAL SettingsPanel. Electron's windows are fakes that keep
// its zoom contract: a zoom LEVEL, factor = 1.2^level (setZoomFactor and
// setZoomLevel are two views of one number), and a title-bar overlay whose
// setTitleBarOverlay() changes only the fields it is given.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const require = createRequire(import.meta.url);
const store = await import('../../electron/store.js');
const { createUiScale, UI_SCALE_STEPS, DEFAULT_UI_SCALE, normalizeUiScale } = require('../../electron/ui-scale.js');
// window-bg.js requires electron at load, so its constant is read from the source.
const TITLE_BAR_HEIGHT = Number(/const TITLE_BAR_HEIGHT = (\d+);/.exec(fs.readFileSync('electron/window-bg.js', 'utf8'))[1]);
const { DataService } = await import('../../renderer/js/data-service.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const B = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));

const configPath = () => path.join(h.userData, 'config.json');
const savedOnDisk = () => JSON.parse(fs.readFileSync(configPath(), 'utf8')).settings.player.uiScale;
const seed = (player) => fs.writeFileSync(configPath(), JSON.stringify({
  settings: { player: { volume: 70, theme: 'dark', ...player } },
  playlists: [], categories: [], videoCategories: {}, _migrated: true,
}, null, 2));

/** A BrowserWindow + webContents with Electron's zoom and overlay contract. */
function fakeWindow(name) {
  let level = 0;
  const sent = [];
  const wc = {
    name,
    getZoomLevel: () => level,
    setZoomLevel: (l) => { level = l; },
    getZoomFactor: () => 1.2 ** level,
    setZoomFactor: (f) => {
      if (!(f > 0)) throw new Error('zoom factor must be > 0');
      level = Math.log(f) / Math.log(1.2);
    },
    send: (channel, ...args) => sent.push([channel, ...args]),
  };
  const overlay = { color: '#16213e', symbolColor: '#e0e0e6', height: 48 };
  const win = {
    webContents: wc,
    sent,
    overlay,
    isDestroyed: () => false,
    setTitleBarOverlay: (opts) => Object.assign(overlay, opts),
  };
  return win;
}

const pct = (win) => Math.round(win.webContents.getZoomFactor() * 100);

let main;
let popout;
let focused;
let ui;

/** One app launch: config.json as seeded, the store booted, the controller built. */
async function launch() {
  await store.initStore();
  main = fakeWindow('main');
  popout = fakeWindow('player-popout');
  focused = main.webContents;
  ui = createUiScale({
    store,
    getMainWindow: () => main,
    getFocusedWebContents: () => focused,
    fromWebContents: (wc) => [main, popout].find((w) => w.webContents === wc) || null,
    titleBarHeight: TITLE_BAR_HEIGHT,
    hasTitleBarOverlay: true,
  });
  // What createWindow() does with it: open at the saved zoom, with the
  // overlay at the matching height.
  const opts = ui.windowOptions();
  main.webContents.setZoomFactor(opts.zoomFactor);
  main.overlay.height = opts.titleBarHeight;
  return opts;
}

/** A press of the View menu item with this accelerator, in the focused window. */
function press(accelerator) {
  const item = ui.menuItems().find((i) => i.accelerator === accelerator);
  item.click();
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-ui-scale-'));
  _setBundlesForTests('en', B.en, B.en);
  document.body.innerHTML = '';
});
afterEach(() => {
  try { fs.rmSync(h.userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('the setting (store.js)', () => {
  it('defaults to 100% on a fresh install and on a config from before the setting existed', async () => {
    await store.initStore(); // no config.json: first launch
    expect(store.getSetting('player.uiScale')).toBe(100);
    expect(store.getAll().settings.player.uiScale).toBe(100);
    expect(DEFAULT_UI_SCALE).toBe(100);

    seed({}); // an older config with a player block but no uiScale
    await store.initStore();
    expect(store.getSetting('player.uiScale')).toBe(100);
    expect(store.getAll().settings.player.uiScale).toBe(100);
  });
});

describe('startup applies the saved size (createWindow)', () => {
  it.each([
    [125, 1.25, 60],
    [80, 0.8, 38],
    [150, 1.5, 72],
    [100, 1, 48],
  ])('a saved %i percent opens the window at zoom factor %d with a %i px caption strip', async (saved, factor, height) => {
    seed({ uiScale: saved });
    const opts = await launch();
    expect(opts.zoomFactor).toBeCloseTo(factor, 6);
    expect(opts.titleBarHeight).toBe(height);
    expect(pct(main)).toBe(saved);
  });

  it('a hand-edited or broken value opens at the nearest step, never at a size Settings cannot show', async () => {
    seed({ uiScale: 120 });
    expect((await launch()).scale).toBe(125);
    seed({ uiScale: 9999 });
    expect((await launch()).scale).toBe(150);
    seed({ uiScale: 'big' });
    expect((await launch()).scale).toBe(100);
    seed({ uiScale: null });
    expect((await launch()).scale).toBe(100);
  });
});

describe('the View menu keys keep the setting in step (main window)', () => {
  it('Ctrl+= steps up and SAVES each step, clamped at 150%; the renderer is told every time', async () => {
    seed({});
    await launch();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      press('CommandOrControl+=');
      seen.push([pct(main), savedOnDisk(), main.overlay.height]);
    }
    expect(seen).toEqual([[110, 110, 53], [125, 125, 60], [150, 150, 72], [150, 150, 72]]);
    expect(main.sent).toEqual([
      ['ui-scale-changed', 110], ['ui-scale-changed', 125], ['ui-scale-changed', 150], ['ui-scale-changed', 150],
    ]);
    // The overlay's colours are left alone; only its height follows.
    expect(main.overlay).toMatchObject({ color: '#16213e', symbolColor: '#e0e0e6' });
  });

  it('Ctrl+- steps down to 80% and stops; Ctrl+0 goes back to 100% (the default) and saves it', async () => {
    seed({ uiScale: 110 });
    await launch();
    press('CommandOrControl+-');
    press('CommandOrControl+-');
    press('CommandOrControl+-');
    press('CommandOrControl+-');
    expect([pct(main), savedOnDisk(), main.overlay.height]).toEqual([80, 80, 38]);
    press('CommandOrControl+0');
    expect([pct(main), savedOnDisk(), main.overlay.height]).toEqual([100, 100, 48]);
    expect(main.sent.at(-1)).toEqual(['ui-scale-changed', 100]);
  });

  it('the next launch opens at the size the keys left', async () => {
    seed({});
    await launch();
    press('CommandOrControl+=');
    press('CommandOrControl+=');
    const opts = await launch(); // relaunch, reading the config the last one wrote
    expect(opts.scale).toBe(125);
    expect(pct(main)).toBe(125);
  });

  it('the zoom items are plain menu items: a built-in role would ignore their click', () => {
    seed({});
    const items = createUiScale({ store, getMainWindow: () => null, titleBarHeight: 48 }).menuItems();
    expect(items.map((i) => i.accelerator)).toEqual(['CommandOrControl+0', 'CommandOrControl+=', 'CommandOrControl+-']);
    for (const item of items) {
      expect(item.role).toBeUndefined();
      expect(typeof item.click).toBe('function');
    }
  });
});

describe('a pop-out keeps its own zoom (main window only)', () => {
  it('Ctrl+= in the player pop-out zooms the pop-out half a level, like the built-in role, and saves nothing', async () => {
    seed({ uiScale: 125 });
    await launch();
    focused = popout.webContents;
    press('CommandOrControl+=');
    expect(popout.webContents.getZoomLevel()).toBeCloseTo(0.5, 6);
    expect(popout.overlay.height).toBe(Math.round(48 * 1.2 ** 0.5));
    expect(pct(main)).toBe(125);
    expect(savedOnDisk()).toBe(125);
    expect(main.sent).toEqual([]);
    press('CommandOrControl+0');
    expect(popout.webContents.getZoomLevel()).toBe(0);
    expect(savedOnDisk()).toBe(125);
  });
});

// The wiring in electron/main.js (V79 review). The tests above drive
// ui-scale.js directly, standing in for createWindow and the menu; these
// lift createWindow(), buildAppMenu(), _cursorOverCaption() and the
// set-setting and update-window-chrome handlers out of main.js verbatim (as
// log-redact-files.test.js lifts set-setting) and run them over the REAL
// store and the REAL ui-scale.js, so a revert at any of those sites fails.
// The fakes keep Electron's contracts: webPreferences.zoomFactor is the
// page's zoom from its first commit, a menu item with a `role` runs the role
// and ignores its `click`, setTitleBarOverlay() changes only what it is given.
describe('main.js wires it in (createWindow, the View menu, set-setting, window chrome)', () => {
  const MAIN_SRC = fs.readFileSync('electron/main.js', 'utf8');
  const lift = (start, end) => {
    const i = MAIN_SRC.indexOf(start);
    if (i < 0) throw new Error(`not found in main.js: ${start}`);
    const j = MAIN_SRC.indexOf(end, i);
    if (j < 0) throw new Error(`no end for: ${start}`);
    return MAIN_SRC.slice(i, j + end.length);
  };
  const COLORS = { background: '#0f0f1a', chrome: '#16213e', symbol: '#e0e0e6' };
  // Electron's own accelerators for its zoom roles.
  const ROLE_ACCELERATOR = { resetzoom: 'CommandOrControl+0', zoomin: 'CommandOrControl+Plus', zoomout: 'CommandOrControl+-' };

  let windows;
  let focusedWc;
  let handlers;
  let logged;
  let cursor;
  let m; // the lifted main.js

  function FakeBrowserWindow(opts) {
    const win = fakeWindow(windows.length ? 'main' : 'splash');
    const once = {};
    Object.assign(win, {
      opts,
      id: windows.length + 1,
      loadFile() {}, center() {}, destroy() {}, show() {}, on() {}, setBackgroundColor() {},
      once: (event, cb) => { once[event] = cb; },
      emit: (event) => once[event]?.(),
      getContentBounds: () => ({ x: 100, y: 50, width: 1280, height: 800 }),
    });
    Object.assign(win.webContents, { on() {}, openDevTools() {}, toggleDevTools() {} });
    // Electron: the page's zoom from its first commit, before its first paint.
    if (opts.webPreferences?.zoomFactor !== undefined) win.webContents.setZoomFactor(opts.webPreferences.zoomFactor);
    if (opts.titleBarOverlay) Object.assign(win.overlay, opts.titleBarOverlay);
    windows.push(win);
    return win;
  }
  FakeBrowserWindow.fromWebContents = (wc) => windows.find((w) => w.webContents === wc) || null;

  /** One launch of main.js: config.json read by the store, then main.js's own setup. */
  async function bootMain() {
    await store.initStore();
    windows = [];
    handlers = {};
    logged = [];
    focusedWc = null;
    const fakeRequire = (id) => {
      if (id === './ui-scale') return require('../../electron/ui-scale.js');
      if (id === './window-bg') return { TITLE_BAR_HEIGHT, colorsForTheme: () => COLORS };
      if (id === 'electron') return { screen: { getCursorScreenPoint: () => cursor } };
      throw new Error(`unexpected require(${id})`);
    };
    const src = [
      'let mainWindow = null;',
      'const _captionHoverPolls = new Map();',
      'const _captionDimmed = new Map();', // FT-100: the handler remembers a dialog's dim per window
      lift("const uiScale = require('./ui-scale').createUiScale({", '\n});\n'),
      lift('function createWindow() {', '\n}\n'),
      lift('function buildAppMenu() {', '\n}\n'),
      lift('function _cursorOverCaption(', '\n}\n'),
      lift("ipcMain.handle('set-setting'", '\n});\n'),
      lift("ipcMain.handle('update-window-chrome'", '\n});\n'),
      'return { createWindow, buildAppMenu, mainWindow: () => mainWindow, polls: _captionHoverPolls };',
    ].join('\n');
    // eslint-disable-next-line no-new-func
    m = new Function(
      'require', 'store', 'log', 'path', '__dirname', 'process', 'app', 'IS_PORTABLE', 'initAutoUpdater',
      'BrowserWindow', 'webContents', 'Menu', 'ipcMain', 'resolveWindowColors',
      'applyRedactionSetting', '_reportLogRewrite', '_logFilePaths',
      // set-setting registers stored secrets with the log redactor (FT-010).
      'noteSecretSetting',
      // set-setting hands settings.stash writes to the Stash service (S1).
      'stash',
      src,
    )(
      fakeRequire, store, { info: (msg) => logged.push(msg), warn() {}, error() {} }, path, 'electron',
      { platform: 'win32', argv: [] }, { isPackaged: false }, false, () => {},
      FakeBrowserWindow, { getFocusedWebContents: () => focusedWc }, { buildFromTemplate: (t) => t },
      { handle: (name, fn) => { handlers[name] = fn; } }, () => COLORS,
      () => {}, () => {}, () => [],
      () => {},
      { ownsSetting: () => false },
    );
  }

  /** A key press Electron routes to the View menu item with this accelerator, in the focused window. */
  function pressAccelerator(template, accelerator) {
    const items = template.find((menu) => menu.label === 'View').submenu;
    const item = items.find((i) => (i.accelerator || ROLE_ACCELERATOR[String(i.role).toLowerCase()]) === accelerator);
    if (!item) return;
    const wc = focusedWc;
    if (item.role) {
      const role = item.role.toLowerCase();
      if (role === 'zoomin') wc.setZoomLevel(wc.getZoomLevel() + 0.5);
      if (role === 'zoomout') wc.setZoomLevel(wc.getZoomLevel() - 0.5);
      if (role === 'resetzoom') wc.setZoomLevel(0);
      return;
    }
    item.click({}, FakeBrowserWindow.fromWebContents(wc), {});
  }

  afterEach(() => {
    for (const id of m?.polls?.values() || []) clearInterval(id);
  });

  it.each([
    [125, 60],
    [80, 38],
  ])('createWindow opens the main window at a saved %i percent from its first frame, with a %i px caption strip', async (saved, strip) => {
    seed({ uiScale: saved });
    await bootMain();
    m.createWindow();
    const [splash, main] = windows;
    expect(m.mainWindow()).toBe(main);
    expect(main.opts.webPreferences.zoomFactor).toBeCloseTo(saved / 100, 6);
    // Before ready-to-show: the first paint is already at this size.
    expect(pct(main)).toBe(saved);
    expect(main.overlay.height).toBe(strip);
    expect(pct(splash)).toBe(100);
    main.emit('ready-to-show');
    expect(logged).toContain(`[UI scale] Window shown at ${saved}% (saved ${saved}%)`);
  });

  it('Ctrl+= / Ctrl+- / Ctrl+0 through the built View menu SAVE the size, and the next launch opens at it', async () => {
    seed({});
    await bootMain();
    m.createWindow();
    let main = m.mainWindow();
    focusedWc = main.webContents;
    let menu = m.buildAppMenu();
    pressAccelerator(menu, 'CommandOrControl+=');
    pressAccelerator(menu, 'CommandOrControl+=');
    expect([pct(main), savedOnDisk()]).toEqual([125, 125]);
    expect(main.sent.at(-1)).toEqual(['ui-scale-changed', 125]);
    pressAccelerator(menu, 'CommandOrControl+-');
    expect([pct(main), savedOnDisk()]).toEqual([110, 110]);

    // Relaunch: a fresh main.js over the config the last one wrote.
    await bootMain();
    m.createWindow();
    main = m.mainWindow();
    focusedWc = main.webContents;
    expect(pct(main)).toBe(110);
    menu = m.buildAppMenu();
    pressAccelerator(menu, 'CommandOrControl+0');
    expect([pct(main), savedOnDisk()]).toEqual([100, 100]);
  });

  it('a Settings write reaches the window through set-setting, at once', async () => {
    seed({});
    await bootMain();
    m.createWindow();
    const main = m.mainWindow();
    await handlers['set-setting'](null, 'player.uiScale', 125);
    expect([pct(main), savedOnDisk()]).toEqual([125, 125]);
    // A value that is not a step is saved as the step, and the renderer is told which.
    await handlers['set-setting'](null, 'player.uiScale', 90);
    await handlers['set-setting'](null, 'player.uiScale', 120);
    expect([pct(main), savedOnDisk()]).toEqual([125, 125]);
    expect(main.sent.at(-1)).toEqual(['ui-scale-changed', 125]);
  });

  it('a view change keeps the caption strip at the zoomed height (update-window-chrome), over the video too', async () => {
    seed({ uiScale: 125 });
    await bootMain();
    m.createWindow();
    const main = m.mainWindow();
    expect(main.overlay.height).toBe(60);
    const event = { sender: main.webContents };
    await handlers['update-window-chrome'](event, 'dark');
    expect(main.overlay).toMatchObject({ height: 60, color: COLORS.chrome });
    await handlers['update-window-chrome'](event, 'dark', { overVideo: true });
    expect(main.overlay).toMatchObject({ height: 60, color: '#00000000', symbolColor: '#ffffff' });
    // After a menu zoom, the next view change follows the new size.
    focusedWc = main.webContents;
    pressAccelerator(m.buildAppMenu(), 'CommandOrControl+-');
    await handlers['update-window-chrome'](event, 'dark');
    expect(main.overlay.height).toBe(Math.round(TITLE_BAR_HEIGHT * 1.1));
  });

  it('the cursor over the zoomed caption strip holds its buttons: the renderer\'s CSS px rect is scaled to the screen', async () => {
    seed({ uiScale: 125 });
    await bootMain();
    m.createWindow();
    const main = m.mainWindow();
    const event = { sender: main.webContents };
    // getTitlebarAreaRect() in CSS px; the content area starts at (100, 50)
    // on screen. At 125% the strip is x 1225-1380, y 50-110 on screen.
    const captionRect = { x: 900, y: 0, width: 124, height: 48 };
    const fade = { overVideo: true, hideSymbols: true, captionRect };
    cursor = { x: 1300, y: 100 }; // on the buttons, and outside that rect read as screen px
    await handlers['update-window-chrome'](event, 'dark', fade);
    expect(main.overlay).toMatchObject({ symbolColor: '#ffffff', color: '#000000CC' });
    cursor = { x: 600, y: 400 };
    await handlers['update-window-chrome'](event, 'dark', fade);
    expect(main.overlay.symbolColor).toBe('#00000000');
    expect(m.polls.size).toBe(0);
  });
});

describe('Settings > Appearance > Interface size', () => {
  let ds;
  let ipcOnUiScaleChanged;
  let setSettingCalls;
  let closePanel;

  /** The renderer side: preload bridge, DataService, app.js's subscription, the panel. */
  async function openSettings() {
    setSettingCalls = [];
    window.funsync = {
      // preload.js: the steps and default come from electron/ui-scale.js.
      uiScaleSteps: [...UI_SCALE_STEPS],
      uiScaleDefault: DEFAULT_UI_SCALE,
      getAllData: async () => store.getAll(),
      // ipcMain 'set-setting': store.setSetting, then ui-scale's hook.
      setSetting: async (p, v) => {
        setSettingCalls.push([p, v]);
        store.setSetting(p, v);
        ui.onSettingWritten(p, v);
      },
      onUiScaleChanged: (cb) => { ipcOnUiScaleChanged = cb; return () => {}; },
      onGlobalShortcut: () => () => {},
      setGlobalShortcuts: async () => [],
    };
    ds = new DataService();
    await ds.init();
    // app.js init(): the View menu's saves reach the cache, not an echo.
    window.funsync.onUiScaleChanged((scale) => ds.applySavedSetting('player.uiScale', scale));
    // ui-scale's renderer notice arrives over IPC.
    main.webContents.send = (channel, value) => {
      main.sent.push([channel, value]);
      if (channel === 'ui-scale-changed') ipcOnUiScaleChanged?.(value);
    };

    const panel = new SettingsPanel({ settings: ds });
    const shown = panel.show();
    closePanel = async () => { document.querySelector('.settings-panel__done-btn')?.click(); await shown; };
    document.querySelector('.settings-panel__rail-item[data-area="appearance"]').click();
    return document.querySelector('[data-setting="player.uiScale"]');
  }

  afterEach(async () => { await closePanel?.(); closePanel = null; });

  it('offers the steps main applies, labels store.js\'s default as the default, and shows the saved one', async () => {
    seed({ uiScale: 110 });
    await launch();
    const select = await openSettings();
    const options = [...select.options].map((o) => [Number(o.value), o.textContent.trim()]);
    expect(options.map(([v]) => v)).toEqual([...UI_SCALE_STEPS]);
    const defaults = options.filter(([, label]) => label.includes('(default)')).map(([v]) => v);
    // The option labelled default is store.js's DEFAULT (V37's lesson), and
    // what an unset value opens at.
    expect(defaults).toEqual([store.DEFAULTS.settings.player.uiScale]);
    expect(defaults).toEqual([normalizeUiScale(undefined)]);
    expect(select.value).toBe('110');
    // The rail lists the section.
    expect(document.querySelector('.settings-panel__rail-group[data-section="sp-sec-scale"]')).not.toBeNull();
  });

  it('picking 125% zooms the main window at once and saves it', async () => {
    seed({});
    await launch();
    const select = await openSettings();
    select.value = '125';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    expect(pct(main)).toBe(125);
    expect(main.overlay.height).toBe(60);
    expect(savedOnDisk()).toBe(125);
    expect(ds.get('player.uiScale')).toBe(125);
    // Settings already knows; nothing is sent back to it.
    expect(main.sent).toEqual([]);
  });

  it('Ctrl+= with Settings open updates the select and the cache, and writes nothing back', async () => {
    seed({});
    await launch();
    const select = await openSettings();
    press('CommandOrControl+=');
    expect(select.value).toBe('110');
    expect(ds.get('player.uiScale')).toBe(110);
    press('CommandOrControl+0');
    expect(select.value).toBe('100');
    expect(setSettingCalls).toEqual([]);
    expect(savedOnDisk()).toBe(100);
  });

  it('is translated in every locale', async () => {
    seed({});
    await launch();
    const headers = new Set();
    for (const locale of LOCALES) {
      _setBundlesForTests(locale, B[locale], B.en);
      const select = await openSettings();
      const section = document.getElementById('sp-sec-scale');
      const header = section.querySelector('.settings-panel__section-header').textContent;
      expect(header, locale).toBe(B[locale].settingsPanel.appearance.scaleHeader);
      const def = [...select.options].find((o) => o.value === '100').textContent;
      expect(def, locale).toBe(B[locale].settingsPanel.appearance.scaleOptionDefault.replace('{percent}', '100'));
      headers.add(header);
      await closePanel();
      closePanel = null;
    }
    expect(headers.size).toBe(8);
  });
});
