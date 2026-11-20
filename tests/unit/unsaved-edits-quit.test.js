/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R3-19 (data loss, also in v0.9.2): closing the main window, quitting, a
// View > Reload, the update toast's Restart Now and Import / Restore's
// relaunch dropped unsaved editor edits (autosave off) without a word.
//
// Main side, with fakes that keep Electron's contracts (a cancellable
// 'close', ipcMain events carrying their sender):
//   - electron/unsaved-edits-guard.js, the REAL module: holds the close while
//     the main window says dirty, asks, and goes ahead on "go" or when the
//     renderer cannot ask; never traps the user.
//   - electron/main.js, the REAL code lifted verbatim (as ui-scale.test.js
//     does): before-quit, Restart Now, the View menu's Reload items, Import
//     and Restore, and the audience room's close hold next to the question.
// What is asserted is what the user would see: does the window close, does
// the app quit, does the page reload, does the installer start.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  createUnsavedEditsGuard, bringToFront,
  DIRTY_CHANNEL, ASK_CHANNEL, ACK_CHANNEL, ANSWER_CHANNEL, ACK_TIMEOUT_MS, INSTALL_START_WAIT_MS,
} = require_('../../electron/unsaved-edits-guard.js');
const relaunchStop = require_('../../electron/relaunch-stop.js');

afterEach(() => { vi.useRealTimers(); });

const tick = () => new Promise((r) => setImmediate(r));

/** A BrowserWindow stand-in. 'close' is cancellable (Electron's contract);
 *  an uncancelled close destroys the window. `renderer` decides what the
 *  page does when main asks: 'cancel', 'go', 'silent' (no ack: hung) or
 *  'ack-only' (asks the user, who has not answered yet). */
function fakeWindow(ipcMain, { renderer = 'cancel' } = {}) {
  const win = new EventEmitter();
  const wc = new EventEmitter();
  Object.assign(wc, {
    sent: [],
    crashed: false,
    isDestroyed: () => win.destroyed,
    isCrashed: () => wc.crashed,
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    send(channel, ...args) {
      wc.sent.push([channel, ...args]);
      if (channel !== ASK_CHANNEL) return;
      const [token] = args;
      if (win.renderer === 'silent') return;
      setImmediate(() => {
        ipcMain.emit(ACK_CHANNEL, { sender: wc }, token);
        if (win.renderer === 'ack-only') { win.pendingToken = token; return; }
        setImmediate(() => ipcMain.emit(ANSWER_CHANNEL, { sender: wc }, token, win.renderer === 'go'));
      });
    },
  });
  Object.assign(win, {
    renderer,
    webContents: wc,
    destroyed: false,
    minimized: false,
    visible: true,
    closed: 0,
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    isVisible: () => win.visible,
    restore: vi.fn(() => { win.minimized = false; }),
    show: vi.fn(() => { win.visible = true; }),
    focus: vi.fn(),
    close() {
      let prevented = false;
      win.emit('close', { preventDefault: () => { prevented = true; } });
      // A hung page ('silent') holds its own close until it recovers:
      // Chromium runs the page's unload first (R3 fix-up).
      if (!prevented && win.renderer !== 'silent') { win.closed++; win.destroyed = true; }
    },
    destroy: vi.fn(() => { if (!win.destroyed) { win.closed++; win.destroyed = true; } }),
  });
  return win;
}

const asks = (win) => win.webContents.sent.filter(([c]) => c === ASK_CHANNEL).length;
const reportDirty = (ipcMain, win, dirty = true) => ipcMain.emit(DIRTY_CHANNEL, { sender: win.webContents }, dirty);
/** Answer the open question the way the renderer does once the user clicks. */
const userAnswers = (ipcMain, win, go) => ipcMain.emit(ANSWER_CHANNEL, { sender: win.webContents }, win.pendingToken, go);

function setup(opts) {
  const ipcMain = new EventEmitter();
  const log = { info: vi.fn(), warn: vi.fn() };
  const guard = createUnsavedEditsGuard({ ipcMain, log });
  const win = fakeWindow(ipcMain, opts);
  guard.attach(win);
  return { ipcMain, log, guard, win };
}

describe('the unsaved-edits guard (electron/unsaved-edits-guard.js)', () => {
  it('a clean editor: the window closes at once and nothing is asked', () => {
    const { win } = setup();
    win.close();
    expect(win.closed).toBe(1);
    expect(asks(win)).toBe(0);
  });

  it('dirty: the close is held and the main window asked; Cancel keeps the window open', async () => {
    const { ipcMain, win } = setup({ renderer: 'cancel' });
    reportDirty(ipcMain, win);
    win.close();
    expect(win.closed).toBe(0);
    expect(asks(win)).toBe(1);
    await tick(); await tick(); await tick();
    expect(win.closed).toBe(0);
    expect(win.destroyed).toBe(false);
    // Asked again next time: Cancel is "not now".
    win.close();
    expect(asks(win)).toBe(2);
  });

  it('dirty: Save or Don\'t save in the renderer ("go") closes the window, once', async () => {
    const { ipcMain, win } = setup({ renderer: 'go' });
    reportDirty(ipcMain, win);
    win.close();
    await tick(); await tick(); await tick();
    expect(win.closed).toBe(1);
    expect(asks(win)).toBe(1);
  });

  it('the window comes to the front for the question: restored when minimised, focused', () => {
    const { ipcMain, win } = setup({ renderer: 'ack-only' });
    win.minimized = true;
    reportDirty(ipcMain, win);
    win.close();
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalled();
    expect(win.minimized).toBe(false);
  });

  it('never traps the user: a renderer that does not acknowledge within 10 s lets the close go ahead', async () => {
    vi.useFakeTimers();
    const { ipcMain, win, log } = setup({ renderer: 'silent' });
    reportDirty(ipcMain, win);
    win.close();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS - 1);
    expect(win.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    // Destroyed, not closed: a hung page would hold a close until it
    // recovered, a frozen window (R3 fix-up, verifier 1).
    expect(win.closed).toBe(1);
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(ACK_TIMEOUT_MS).toBeLessThanOrEqual(10000);
    expect(log.warn.mock.calls.flat().join(' ')).toMatch(/timeout/);
  });

  it('the user\'s own time to answer is not limited: acknowledged, unanswered for a minute, still open; then Don\'t save closes', async () => {
    vi.useFakeTimers();
    const { ipcMain, win } = setup({ renderer: 'ack-only' });
    reportDirty(ipcMain, win);
    win.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(win.closed).toBe(0);
    userAnswers(ipcMain, win, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(win.closed).toBe(1);
  });

  it('a page that crashes or turns unresponsive while asking lets the close go ahead', async () => {
    for (const event of ['render-process-gone', 'unresponsive']) {
      const { ipcMain, win } = setup({ renderer: 'ack-only' });
      reportDirty(ipcMain, win);
      win.close();
      await tick(); await tick();
      expect(win.closed).toBe(0);
      (event === 'unresponsive' ? win : win.webContents).emit(event, {}, {});
      await tick();
      expect(win.closed, event).toBe(1);
      // An unresponsive page is hung: destroyed. A crashed one closes as usual.
      expect(win.destroy.mock.calls.length, event).toBe(event === 'unresponsive' ? 1 : 0);
    }
  });

  it('a crashed page holds nothing: the close is not held', () => {
    const { ipcMain, win } = setup();
    reportDirty(ipcMain, win);
    win.webContents.crashed = true;
    win.close();
    expect(win.closed).toBe(1);
    expect(asks(win)).toBe(0);
  });

  it('only this window\'s reports and this request\'s answer count', async () => {
    const { ipcMain, win } = setup({ renderer: 'ack-only' });
    const other = { sender: { not: 'the main window' } };
    ipcMain.emit(DIRTY_CHANNEL, other, true);
    win.close();
    expect(win.closed).toBe(1); // a pop-out saying "dirty" holds nothing

    const s = setup({ renderer: 'ack-only' });
    reportDirty(s.ipcMain, s.win);
    s.win.close();
    await tick(); await tick();
    s.ipcMain.emit(ANSWER_CHANNEL, other, s.win.pendingToken, true);   // another window
    s.ipcMain.emit(ANSWER_CHANNEL, { sender: s.win.webContents }, s.win.pendingToken + 99, true); // another request
    await tick();
    expect(s.win.closed).toBe(0);
    userAnswers(s.ipcMain, s.win, true);
    await tick();
    expect(s.win.closed).toBe(1);
  });

  it('one question at a time: a second close, or a quit, while it is open asks nothing more', async () => {
    const { ipcMain, guard, win } = setup({ renderer: 'ack-only' });
    reportDirty(ipcMain, win);
    win.close();
    win.close();
    await expect(guard.confirm('quitting')).resolves.toBe(false);
    expect(asks(win)).toBe(1);
    expect(win.closed).toBe(0);
    await tick(); await tick(); // the page has acknowledged and is asking
    userAnswers(ipcMain, win, true);
    await tick();
    expect(win.closed).toBe(1);
  });

  it('after a "go", a new edit asks again; a clean report asks nothing', async () => {
    const { ipcMain, guard, win } = setup({ renderer: 'go' });
    reportDirty(ipcMain, win);
    await expect(guard.confirm('importing a backup')).resolves.toBe(true);
    // The import failed, the window stayed: Save had cleaned the editor...
    reportDirty(ipcMain, win, false);
    await expect(guard.confirm('reloading the window')).resolves.toBe(true);
    expect(asks(win)).toBe(1);
    // ...and a new edit is asked about again.
    reportDirty(ipcMain, win, true);
    expect(guard.needsAsk()).toBe(true);
  });

  it('a reload (a navigation) starts a clean page', () => {
    const { ipcMain, guard, win } = setup();
    reportDirty(ipcMain, win);
    win.webContents.emit('did-navigate');
    expect(guard.needsAsk()).toBe(false);
  });

  it('bringToFront shows a hidden window and leaves a destroyed one alone', () => {
    const ipcMain = new EventEmitter();
    const win = fakeWindow(ipcMain);
    win.visible = false;
    bringToFront(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    win.destroyed = true;
    bringToFront(win);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// electron/main.js, lifted verbatim.

// LF whatever the checkout: CI's Windows runner checks out with CRLF (v0.10.0 tag, 2026-11-20).
const MAIN_SRC = fs.readFileSync('electron/main.js', 'utf8').replace(/\r\n/g, '\n');
function lift(start, end) {
  const i = MAIN_SRC.indexOf(start);
  if (i < 0) throw new Error(`not found in main.js: ${start}`);
  const j = MAIN_SRC.indexOf(end, i);
  if (j < 0) throw new Error(`no end for: ${start}`);
  return MAIN_SRC.slice(i, j + end.length);
}

/** One main process: the REAL guard and holdCloseForStop, the REAL lifted handlers, fakes around them. */
function bootMain({ renderer = 'cancel', roomOpen = false, deviceStopAnswers = true, importOutcome = { success: true }, install = null } = {}) {
  const ipcMain = new EventEmitter();
  ipcMain.handlers = {};
  ipcMain.handle = (name, fn) => { ipcMain.handlers[name] = fn; };
  const appEvents = new EventEmitter();
  const app = Object.assign(appEvents, {
    quit: vi.fn(),
    getPath: () => 'C:/sandbox/userData',
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mainWindow = fakeWindow(ipcMain, { renderer });
  // The audience room's device stop, answered by the same fake page.
  const origSend = mainWindow.webContents.send;
  mainWindow.webContents.send = (channel, ...args) => {
    origSend(channel, ...args);
    if (channel === relaunchStop.REQUEST_CHANNEL && deviceStopAnswers) {
      setImmediate(() => ipcMain.emit(relaunchStop.DONE_CHANNEL, { sender: mainWindow.webContents }, args[0]));
    }
  };
  const world = {
    snapshots: [],
    installs: 0,
    imports: [],
    restoreSnapshots: [],
    stops: () => mainWindow.webContents.sent.filter(([c]) => c === relaunchStop.REQUEST_CHANNEL).length,
  };
  const dataBackup = {
    cancelScheduled: vi.fn(),
    takeSnapshot: vi.fn(async (o) => { world.snapshots.push(o.trigger); }),
    TRIGGER: { QUIT: 'quit', PRE_ACTION: 'pre-action' },
    resolvePaths: () => { throw new Error('restore went past the question'); },
  };
  const fakeRequire = (id) => {
    if (id === './unsaved-edits-guard') return require_('../../electron/unsaved-edits-guard.js');
    if (id === './data-export') {
      return {
        applyImport: async ({ filePath }) => {
          world.imports.push(filePath);
          if (importOutcome instanceof Error) throw importOutcome;
          return importOutcome;
        },
      };
    }
    throw new Error(`unexpected require(${id})`);
  };
  const src = [
    lift('const { createUnsavedEditsGuard, bringToFront', ';\n'),
    'let _finalSnapshotDone = false;',
    'let _unsubscribeFromStore = null;',
    'let _quitStopGuard = null;',
    lift('const _unsavedEdits = createUnsavedEditsGuard(', ');\n'),
    lift('function _holdMainWindowCloseForAudienceStop() {', '\n}\n'),
    lift('async function _reloadWindow(', '\n}\n'),
    lift('function buildAppMenu() {', '\n}\n'),
    lift("app.on('before-quit', async (event) => {", '\n});\n'),
    lift("ipcMain.handle('updater-install'", '\n});\n'),
    lift("ipcMain.on('main-window:bring-forward'", '\n});\n'),
    lift("ipcMain.handle('import-data'", '\n});\n'),
    lift("ipcMain.handle('backup:restore'", '\n});\n'),
    // The window's creation in whenReady, as main.js orders it: the question's
    // hold first, then the audience room's.
    'function createWindow() { mainWindow = __window; }',
    lift('  createWindow();\n  // Before the audience hold', '_holdMainWindowCloseForAudienceStop();'),
    'return { buildAppMenu, _reloadWindow, guard: _unsavedEdits, snapshotDone: () => _finalSnapshotDone };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const m = new Function(
    'require', 'app', 'ipcMain', 'log', 'mainWindow', '__window', 'holdCloseForStop', 'askRendererToStop', 'QUIT_STOP_TIMEOUT_MS',
    'audiencePopout', 'dataBackup', 'store', 'stopBackend', 'quitAndInstall', 'dialog', 'process', 'uiScale',
    'customThumbsDir', '_stopPlaybackBeforeRelaunch', '_preActionSnapshot', '_relaunchWithConfigOnDisk', 'Menu',
    // Stash S1: before-quit stops a sync; import-data merges the Stash data.
    'stash', 'stashLibrary',
    src,
  )(
    fakeRequire, app, ipcMain, log, null, mainWindow, relaunchStop.holdCloseForStop, relaunchStop.askRendererToStop,
    relaunchStop.QUIT_STOP_TIMEOUT_MS,
    { isOpen: () => roomOpen }, dataBackup, { getAll: () => ({}) }, vi.fn(),
    () => { world.installs++; install?.(); },
    { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/sandbox/backup.zip'] }) },
    { platform: 'win32' }, { menuItems: () => [] },
    () => 'C:/sandbox/thumbs', async () => {}, async () => {}, () => {}, { buildFromTemplate: (t) => t },
    { shutdown: async () => {}, ownsSetting: () => false }, null,
  );
  /** Electron's app.quit(): before-quit listeners, then (unless one prevented it) the windows close. */
  const quit = async () => {
    let prevented = false;
    for (const fn of appEvents.listeners('before-quit')) await fn({ preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const viewMenu = () => m.buildAppMenu().find((menu) => menu.label === 'View').submenu;
  return { ipcMain, app, mainWindow, world, m, quit, viewMenu, log };
}

const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

describe('main.js asks before quitting, reloading, installing an update or relaunching (R3-19)', () => {
  it('quit with unsaved edits, Cancel: the app stays, no quit snapshot, quit not re-fired', async () => {
    const { ipcMain, app, mainWindow, world, m, quit } = bootMain({ renderer: 'cancel' });
    reportDirty(ipcMain, mainWindow);
    await quit();
    await settle();
    expect(asks(mainWindow)).toBe(1);
    expect(world.snapshots).toEqual([]);
    expect(app.quit).not.toHaveBeenCalled();
    expect(m.snapshotDone()).toBe(false);
    expect(mainWindow.destroyed).toBe(false);
  });

  it('quit with unsaved edits, Save / Don\'t save: the quit snapshot, then the real quit, and the close is not asked twice', async () => {
    const { ipcMain, app, mainWindow, world, quit } = bootMain({ renderer: 'go' });
    reportDirty(ipcMain, mainWindow);
    await quit();
    await settle();
    expect(world.snapshots).toEqual(['quit']);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // Electron closes the windows as part of that quit.
    mainWindow.close();
    expect(mainWindow.closed).toBe(1);
    expect(asks(mainWindow)).toBe(1);
  });

  it('quit with a clean editor asks nothing and quits as before', async () => {
    const { app, mainWindow, world, quit } = bootMain({ renderer: 'cancel' });
    await quit();
    await settle();
    expect(asks(mainWindow)).toBe(0);
    expect(world.snapshots).toEqual(['quit']);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('quit with a hung page: after the 10 s the window is destroyed, not left frozen (R3 fix-up)', async () => {
    vi.useFakeTimers();
    const { ipcMain, app, mainWindow, world, quit } = bootMain({ renderer: 'silent' });
    reportDirty(ipcMain, mainWindow);
    const quitting = quit();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await quitting;
    expect(world.snapshots).toEqual(['quit']);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(mainWindow.destroy).toHaveBeenCalledTimes(1);
    expect(mainWindow.destroyed).toBe(true);
  });

  it('quit after a page that answered: the window is left to close as usual, never destroyed', async () => {
    const { ipcMain, mainWindow, quit } = bootMain({ renderer: 'go' });
    reportDirty(ipcMain, mainWindow);
    await quit();
    await settle();
    expect(mainWindow.destroy).not.toHaveBeenCalled();
  });

  it('a second Ctrl+Q while the question is open does not quit behind the user\'s back', async () => {
    const { ipcMain, app, mainWindow, world, quit } = bootMain({ renderer: 'ack-only' });
    reportDirty(ipcMain, mainWindow);
    const first = quit();
    await settle();
    await quit();
    await settle();
    expect(app.quit).not.toHaveBeenCalled();
    expect(world.snapshots).toEqual([]);
    userAnswers(ipcMain, mainWindow, false); // Cancel
    await first;
    await settle();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('Restart Now with unsaved edits: Cancel starts no installer; Save starts it', async () => {
    const a = bootMain({ renderer: 'cancel' });
    reportDirty(a.ipcMain, a.mainWindow);
    await expect(a.ipcMain.handlers['updater-install']()).resolves.toEqual({ cancelled: true });
    expect(a.world.installs).toBe(0);

    const b = bootMain({ renderer: 'go' });
    reportDirty(b.ipcMain, b.mainWindow);
    await b.ipcMain.handlers['updater-install']();
    expect(b.world.installs).toBe(1);
  });

  it('View > Reload (Ctrl+R) and Force Reload: Cancel keeps the page; a clean editor reloads at once', async () => {
    const a = bootMain({ renderer: 'cancel' });
    const items = a.viewMenu();
    const reload = items.find((i) => i.accelerator === 'CmdOrCtrl+R');
    const force = items.find((i) => i.accelerator === 'Shift+CmdOrCtrl+R');
    expect(reload.role).toBeUndefined(); // a role would reload without asking
    expect(force.role).toBeUndefined();
    reportDirty(a.ipcMain, a.mainWindow);
    await reload.click(null, a.mainWindow);
    await force.click(null, a.mainWindow);
    expect(a.mainWindow.webContents.reload).not.toHaveBeenCalled();
    expect(a.mainWindow.webContents.reloadIgnoringCache).not.toHaveBeenCalled();

    const b = bootMain({ renderer: 'cancel' });
    const bItems = b.viewMenu();
    await bItems.find((i) => i.accelerator === 'CmdOrCtrl+R').click(null, b.mainWindow);
    await bItems.find((i) => i.accelerator === 'Shift+CmdOrCtrl+R').click(null, b.mainWindow);
    expect(b.mainWindow.webContents.reload).toHaveBeenCalledTimes(1);
    expect(b.mainWindow.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(asks(b.mainWindow)).toBe(0);
  });

  it('Reload with unsaved edits and Save: the page reloads; a pop-out reloads without asking', async () => {
    const { ipcMain, mainWindow, viewMenu } = bootMain({ renderer: 'go' });
    reportDirty(ipcMain, mainWindow);
    await viewMenu().find((i) => i.accelerator === 'CmdOrCtrl+R').click(null, mainWindow);
    expect(mainWindow.webContents.reload).toHaveBeenCalledTimes(1);
    const popout = fakeWindow(ipcMain);
    await viewMenu().find((i) => i.accelerator === 'CmdOrCtrl+R').click(null, popout);
    expect(popout.webContents.reload).toHaveBeenCalledTimes(1);
    expect(asks(popout)).toBe(0);
  });

  it('Import and Restore (they relaunch with app.exit): Cancel imports and restores nothing', async () => {
    const { ipcMain, mainWindow, world } = bootMain({ renderer: 'cancel' });
    reportDirty(ipcMain, mainWindow);
    await expect(ipcMain.handlers['import-data']()).resolves.toEqual({ success: false, error: 'Cancelled' });
    expect(world.imports).toEqual([]);
    await expect(ipcMain.handlers['backup:restore']({}, { subdir: 'snapshots', filename: 'a.json' }))
      .resolves.toEqual({ success: false, error: 'Cancelled', cancelled: true });
    expect(world.snapshots).toEqual([]); // not even the pre-restore snapshot
    expect(asks(mainWindow)).toBe(2);
  });

  it('Import with unsaved edits and Save goes on with the import', async () => {
    const { ipcMain, mainWindow, world } = bootMain({ renderer: 'go' });
    reportDirty(ipcMain, mainWindow);
    await expect(ipcMain.handlers['import-data']()).resolves.toEqual({ success: true });
    expect(world.imports).toEqual(['C:/sandbox/backup.zip']);
  });

  it('closing with a room open: Cancel at the question stops no viewer\'s device; Save stops them, then closes', async () => {
    const a = bootMain({ renderer: 'cancel', roomOpen: true });
    reportDirty(a.ipcMain, a.mainWindow);
    a.mainWindow.close();
    await settle();
    expect(a.mainWindow.closed).toBe(0);
    expect(a.world.stops()).toBe(0);

    const b = bootMain({ renderer: 'go', roomOpen: true });
    reportDirty(b.ipcMain, b.mainWindow);
    b.mainWindow.close();
    await settle();
    expect(b.world.stops()).toBe(1);
    expect(b.mainWindow.closed).toBe(1);
  });

  it('the renderer\'s bring-forward request raises the main window, and only from the main window', () => {
    const { ipcMain, mainWindow } = bootMain();
    mainWindow.minimized = true;
    ipcMain.emit('main-window:bring-forward', { sender: { other: true } });
    expect(mainWindow.restore).not.toHaveBeenCalled();
    ipcMain.emit('main-window:bring-forward', { sender: mainWindow.webContents });
    expect(mainWindow.restore).toHaveBeenCalledTimes(1);
    expect(mainWindow.focus).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R4-17 (nit, round-3 review): confirm() takes every outcome but Cancel as a
// "go", the page's silence included (hung 10 s). When the action then fails
// (Import or Restore error, an update installer that does not start), the
// edits are still unsaved and nothing reports a change, so the next close or
// quit went through without a question.

/** The page hangs through the question (10 s), then the user closes the window. */
async function hungThenClose(m, run) {
  reportDirty(m.ipcMain, m.mainWindow);
  const action = run();
  await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
  const result = await action;
  m.mainWindow.close();
  return result;
}

describe('a "go" for an action that then failed is taken back: the next close asks again (R4-17)', () => {
  it('Import fails (not a backup file) after a hung page: the next close is held and asked about', async () => {
    vi.useFakeTimers();
    const m = bootMain({ renderer: 'silent', importOutcome: { success: false, error: 'Not a FunSync backup' } });
    const result = await hungThenClose(m, () => m.ipcMain.handlers['import-data']());
    expect(result).toEqual({ success: false, error: 'Not a FunSync backup' });
    expect(m.mainWindow.closed).toBe(0);
    expect(asks(m.mainWindow)).toBe(2);
  });

  it('Import throws after a hung page: the error still reaches the renderer, and the next close asks', async () => {
    vi.useFakeTimers();
    const m = bootMain({ renderer: 'silent', importOutcome: new Error('zip unreadable') });
    reportDirty(m.ipcMain, m.mainWindow);
    const action = m.ipcMain.handlers['import-data']();
    const caught = action.catch((err) => err.message);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await expect(caught).resolves.toBe('zip unreadable');
    m.mainWindow.close();
    expect(m.mainWindow.closed).toBe(0);
    expect(asks(m.mainWindow)).toBe(2);
  });

  it('Restore fails after a hung page: the next close asks again', async () => {
    vi.useFakeTimers();
    const m = bootMain({ renderer: 'silent' });
    const result = await hungThenClose(m, () => m.ipcMain.handlers['backup:restore']({}, { subdir: 'snapshots', filename: 'a.json' }));
    expect(result.success).toBe(false); // the fake snapshot store throws past the question
    expect(m.mainWindow.closed).toBe(0);
    expect(asks(m.mainWindow)).toBe(2);
  });

  it('Restart Now whose installer never starts (no quit within 5 s): the next close asks again', async () => {
    vi.useFakeTimers();
    const m = bootMain({ renderer: 'silent' });
    reportDirty(m.ipcMain, m.mainWindow);
    const action = m.ipcMain.handlers['updater-install']();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await expect(action).resolves.toEqual({ cancelled: false });
    expect(m.world.installs).toBe(1);
    expect(m.m.guard.needsAsk()).toBe(false); // still waiting for the installer's quit
    await vi.advanceTimersByTimeAsync(INSTALL_START_WAIT_MS);
    m.mainWindow.close();
    expect(m.mainWindow.closed).toBe(0);
    expect(asks(m.mainWindow)).toBe(2);
  });

  it('Restart Now whose quitAndInstall throws: the next close asks again at once', async () => {
    vi.useFakeTimers();
    const m = bootMain({ renderer: 'silent', install: () => { throw new Error('no update downloaded'); } });
    reportDirty(m.ipcMain, m.mainWindow);
    const action = m.ipcMain.handlers['updater-install']();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await action;
    m.mainWindow.close();
    expect(m.mainWindow.closed).toBe(0);
    expect(asks(m.mainWindow)).toBe(2);
    expect(m.log.warn.mock.calls.flat().join(' ')).toMatch(/no update downloaded/);
  });

  it('Restart Now whose installer starts (the quit begins): not taken back, so the quit is not asked twice', async () => {
    vi.useFakeTimers();
    const m = bootMain({ renderer: 'silent', install: () => { setTimeout(() => m.app.emit('before-quit', { preventDefault() {} }), 0); } });
    reportDirty(m.ipcMain, m.mainWindow);
    const action = m.ipcMain.handlers['updater-install']();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await action;
    await vi.advanceTimersByTimeAsync(INSTALL_START_WAIT_MS);
    expect(m.m.guard.needsAsk()).toBe(false);
    expect(asks(m.mainWindow)).toBe(1);
  });

  it('Import that succeeds relaunches: nothing is taken back', async () => {
    const m = bootMain({ renderer: 'go' });
    reportDirty(m.ipcMain, m.mainWindow);
    await expect(m.ipcMain.handlers['import-data']()).resolves.toEqual({ success: true });
    expect(m.m.guard.needsAsk()).toBe(false);
  });

  it('reset() while another question is open changes nothing: that question decides', async () => {
    const { ipcMain, guard, win } = setup({ renderer: 'ack-only' });
    reportDirty(ipcMain, win);
    win.close();
    await tick(); await tick();
    guard.reset('Importing a backup');
    userAnswers(ipcMain, win, true);
    await tick();
    expect(win.closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R4-20 (low, developer path): a reload from inside DevTools (Ctrl+R / F5
// with DevTools focused) bypassed the View menu and dropped unsaved editor
// edits without a question. The page now holds such an unload while dirty
// (app.js _onBeforeUnload); Electron reports it to main as
// 'will-prevent-unload', where preventDefault() lets the page go.

/** What Electron emits when the page's beforeunload held an unload. */
function heldUnload(win) {
  const event = { allowed: false, preventDefault() { event.allowed = true; } };
  win.webContents.emit('will-prevent-unload', event);
  return event;
}

describe('an unload main did not start (DevTools reload) asks about unsaved edits too (R4-20)', () => {
  it('dirty: the unload is kept and the question asked; Cancel keeps the page, nothing reloads', async () => {
    const { ipcMain, win } = setup({ renderer: 'cancel' });
    reportDirty(ipcMain, win);
    const event = heldUnload(win);
    expect(event.allowed).toBe(false);
    expect(asks(win)).toBe(1);
    await tick(); await tick(); await tick();
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
  });

  it('dirty, Save or Don\'t save: the page reloads, once', async () => {
    const { ipcMain, win } = setup({ renderer: 'go' });
    reportDirty(ipcMain, win);
    heldUnload(win);
    await tick(); await tick(); await tick();
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    // The reload's own beforeunload, if the page still holds it, goes at once.
    expect(heldUnload(win).allowed).toBe(true);
    expect(asks(win)).toBe(1);
  });

  it('nothing unsaved as far as main knows, or the user already answered: the page goes at once, unasked', async () => {
    const a = setup({ renderer: 'go' });
    expect(heldUnload(a.win).allowed).toBe(true);
    expect(asks(a.win)).toBe(0);

    // A close the user answered "go" for: the page's own hold must not stop it.
    const b = setup({ renderer: 'go' });
    reportDirty(b.ipcMain, b.win);
    await expect(b.guard.confirm('closing the window')).resolves.toBe(true);
    expect(heldUnload(b.win).allowed).toBe(true);
    expect(asks(b.win)).toBe(1);
  });

  it('while the question is open: no second question, the window comes forward, the open one decides', async () => {
    const { ipcMain, win } = setup({ renderer: 'ack-only' });
    reportDirty(ipcMain, win);
    win.close();
    win.minimized = true;
    const event = heldUnload(win);
    expect(event.allowed).toBe(false);
    expect(asks(win)).toBe(1);
    expect(win.restore).toHaveBeenCalled();
  });

  it('never traps the user: a page that does not acknowledge within 10 s is reloaded anyway', async () => {
    vi.useFakeTimers();
    const { ipcMain, win } = setup({ renderer: 'silent' });
    reportDirty(ipcMain, win);
    heldUnload(win);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('a page that crashed holds nothing: its unload goes', () => {
    const { ipcMain, win } = setup();
    reportDirty(ipcMain, win);
    win.webContents.crashed = true;
    expect(heldUnload(win).allowed).toBe(true);
    expect(asks(win)).toBe(0);
  });
});
