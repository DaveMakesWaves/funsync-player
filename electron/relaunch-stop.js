// Stop playback and every device before an app-initiated relaunch.
//
// Import Backup File and Restore From Backup replace config.json and then
// relaunch with app.exit(0) (main.js `_relaunchWithConfigOnDisk`). app.exit
// destroys the windows WITHOUT running the renderer's beforeunload, and that
// is where the devices are stopped on an ordinary close. A Handy in HSSP
// plays the script on its own clock, so it kept stroking with no app left to
// stop it, and the relaunched app's connect() sends no stop. Buttplug
// vibrate/rotate and audience-room devices held their last output the same
// way.
//
// So main asks the main window to stop first and waits for its answer. The
// wait is bounded: a renderer that is hung, or a device that will not
// answer, must not hold the user's import hostage. The renderer bounds its
// own device waits below this (app.js `_stopForRelaunch`).

const REQUEST_CHANNEL = 'app:stop-for-relaunch';
const DONE_CHANNEL = 'app:stopped-for-relaunch';
const STOP_TIMEOUT_MS = 5000;

let _seq = 0;

/**
 * Ask a renderer to pause playback and stop every device, and wait until it
 * says it has, or until `timeoutMs` passes.
 *
 * @param {object} opts
 * @param {object|null} opts.webContents — the main window's webContents
 * @param {object} opts.ipcMain          — electron's ipcMain (on/removeListener)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<'stopped'|'timeout'|'no-window'>}
 */
function askRendererToStop({ webContents, ipcMain, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  if (!webContents || webContents.isDestroyed?.() || !ipcMain) return Promise.resolve('no-window');
  const token = ++_seq;
  return new Promise((resolve) => {
    let timer = null;
    const finish = (outcome) => {
      clearTimeout(timer);
      ipcMain.removeListener(DONE_CHANNEL, onDone);
      resolve(outcome);
    };
    // Only this request's answer, from this window, counts.
    function onDone(event, doneToken) {
      if (doneToken !== token) return;
      if (event?.sender && event.sender !== webContents) return;
      finish('stopped');
    }
    ipcMain.on(DONE_CHANNEL, onDone);
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      webContents.send(REQUEST_CHANNEL, token);
    } catch {
      finish('no-window');
    }
  });
}

// --- Quitting with an audience room open (#361, research §4.11) ------------
//
// An audience viewer's Handy plays its HSSP script on its own clock, so a
// FunSync that quits without stopping it leaves that device running in
// someone else's room, with nothing left to stop it. The renderer's
// beforeunload only fires the stops; the window may be gone before the
// requests leave (every viewer's HandyManager shares one SDK request
// queue). So while a room is open, main holds the quit, and the main
// window's close, for the same stop handshake as a relaunch, bounded below
// the relaunch's wait: a hung renderer or a device that will not answer
// must not stop the app from closing. With no room open nothing changes.
const QUIT_STOP_TIMEOUT_MS = 3500;

/**
 * Hold `win`'s first close while `shouldStop()` says a room is open: ask the
 * renderer to stop (bounded), then close it for real. Closes after a stop
 * already ran (`markStopped`) pass straight through, so a quit that stopped
 * in before-quit is not held twice.
 *
 * @param {object} opts
 * @param {object} opts.win            — BrowserWindow (on, close, isDestroyed, webContents)
 * @param {object} opts.ipcMain
 * @param {() => boolean} opts.shouldStop
 * @param {number} [opts.timeoutMs]
 * @param {(outcome: string, ms: number) => void} [opts.onOutcome]
 * @returns {{ markStopped: () => void, stopped: () => boolean }}
 */
function holdCloseForStop({ win, ipcMain, shouldStop, timeoutMs = QUIT_STOP_TIMEOUT_MS, onOutcome } = {}) {
  let done = false;
  win.on('close', (event) => {
    if (done || !shouldStop?.()) return;
    event.preventDefault();
    done = true;
    const startedAt = Date.now();
    askRendererToStop({ webContents: win.webContents, ipcMain, timeoutMs }).then((outcome) => {
      try { onOutcome?.(outcome, Date.now() - startedAt); } catch { /* logging only */ }
      if (!win.isDestroyed()) win.close();
    });
  });
  return {
    markStopped: () => { done = true; },
    stopped: () => done,
  };
}

module.exports = {
  askRendererToStop, holdCloseForStop,
  REQUEST_CHANNEL, DONE_CHANNEL, STOP_TIMEOUT_MS, QUIT_STOP_TIMEOUT_MS,
};
