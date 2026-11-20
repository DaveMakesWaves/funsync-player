// Unsaved script-editor edits on the way out (R3-19, also in v0.9.2).
//
// Closing the main window (its X, Alt+F4), quitting (File > Exit, Cmd+Q, the
// last window closing), View > Reload / Force Reload, the update toast's
// Restart Now (quitAndInstall) and Import / Restore's relaunch (app.exit)
// dropped unsaved editor edits (autosave off) without a word. Every in-app
// route that replaces the script asks the CB-01 question (Save / Don't save /
// Cancel, ScriptEditor.confirmUnsavedChanges); these routes leave the page
// instead, so main holds them and asks the main window first.
//
// A renderer `beforeunload` guard alone is not the fix: in Electron a
// cancelled unload shows no dialog, it silently blocks the close, the quit,
// the reload and the updater. The page does hold its unload while dirty
// since R4-20, for the unloads that bypass these routes (DevTools' Ctrl+R /
// F5), but only main decides: its 'will-prevent-unload' handler (attach)
// lets every held unload go unless main itself would ask.
//
// The handshake:
//   - The main window reports every change of "the editor holds unsaved
//     edits" (DIRTY_CHANNEL). Nothing is held while it is clean, so a clean
//     close costs no round trip, and a hung renderer with nothing unsaved
//     still closes at once.
//   - While dirty, main sends ASK_CHANNEL with a token. The renderer
//     acknowledges at once (ACK_CHANNEL), then asks the user (with autosave
//     on it flushes the pending write instead, no question) and answers
//     (ANSWER_CHANNEL, go or not).
//   - Never trap the user: no acknowledgement within ACK_TIMEOUT_MS (a hung
//     or broken renderer), the page crashing or going away, or the window
//     turning unresponsive: the action goes ahead. The USER's time to answer
//     is not limited, only the renderer's time to start asking. A page that
//     timed out or went unresponsive also holds its window's close until it
//     recovers, so a close or quit then DESTROYS the window (`rendererHung`).
//     The ASK carries the time main stops waiting for the acknowledgement,
//     and a timed-out or unresponsive question is withdrawn (EXPIRED_CHANNEL):
//     a page that recovers later never asks about an action that already
//     went ahead (R4 fix-up).
//   - One question at a time. An action asked for while the question is open
//     does nothing (`confirm()` resolves false at once) and the window comes
//     to the front; the action that asked goes on with the answer.
//   - A "go" that did not lead anywhere (Import / Restore failed, the update
//     installer did not start) is taken back with `reset()`, so the next
//     close or quit asks again while the edits are unsaved (R4-17).

const DIRTY_CHANNEL = 'editor:dirty-state';
const ASK_CHANNEL = 'app:confirm-unsaved';
const ACK_CHANNEL = 'app:confirm-unsaved-ack';
const ANSWER_CHANNEL = 'app:confirm-unsaved-answer';
// Main went ahead without an answer (no acknowledgement in time, or the
// window turned unresponsive): the page withdraws that question (R4 fix-up).
const EXPIRED_CHANNEL = 'app:confirm-unsaved-expired';
const ACK_TIMEOUT_MS = 10000;
// Restart Now: how long the app has to start quitting once the installer is
// asked to run (electron-updater quits on the next tick when it starts).
const INSTALL_START_WAIT_MS = 5000;

let _seq = 0;

/**
 * Bring a window to the front so a question in it is seen: restore it when
 * minimised, show it when hidden, focus it.
 * @param {object|null} win — BrowserWindow
 */
function bringToFront(win) {
  if (!win || win.isDestroyed?.()) return;
  try {
    if (win.isMinimized?.()) win.restore();
    if (win.isVisible && !win.isVisible()) win.show();
    win.focus();
  } catch { /* the window went away mid-call */ }
}

/**
 * @param {object} opts
 * @param {object} opts.ipcMain — electron's ipcMain (on / removeListener)
 * @param {object} [opts.log] — electron-log (info / warn)
 * @param {number} [opts.ackTimeoutMs]
 */
function createUnsavedEditsGuard({ ipcMain, log = null, ackTimeoutMs = ACK_TIMEOUT_MS } = {}) {
  let win = null;       // the main window the guard is attached to
  let dirty = false;    // what that window last reported
  let allowed = false;  // the user answered "go" (or the renderer could not ask): don't ask again
  let pending = null;   // the open question: Promise<outcome>
  // The last question found the page hung: no acknowledgement in time, or
  // the window turned unresponsive. Its window is then destroyed, not closed.
  let hung = false;

  const alive = () => !!win && !win.isDestroyed?.() && !!win.webContents
    && !win.webContents.isDestroyed?.() && !win.webContents.isCrashed?.();

  ipcMain.on(DIRTY_CHANNEL, (event, value) => {
    if (!win || win.isDestroyed?.() || event?.sender !== win.webContents) return;
    const next = value === true;
    // A new edit after a "go" (a Save or Don't save that left the window
    // open, a failed import) asks again next time.
    if (next && !dirty) allowed = false;
    dirty = next;
  });

  const note = (reason, outcome, startedAt) => {
    const line = `[Editor] Unsaved edits before ${reason}: ${outcome} (${Date.now() - startedAt} ms)`;
    try {
      if (outcome === 'cancel' || outcome === 'proceed') log?.info?.(line);
      else log?.warn?.(line);
    } catch { /* logging only */ }
  };

  /**
   * Ask the main window and wait for its answer.
   * @returns {Promise<'proceed'|'cancel'|'timeout'|'gone'|'unresponsive'|'no-window'>}
   */
  function ask(reason) {
    if (!alive()) return Promise.resolve('no-window');
    const w = win;
    const wc = w.webContents;
    const token = ++_seq;
    bringToFront(w);
    return new Promise((resolve) => {
      let ackTimer = null;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(ackTimer);
        ipcMain.removeListener(ACK_CHANNEL, onAck);
        ipcMain.removeListener(ANSWER_CHANNEL, onAnswer);
        wc.removeListener?.('render-process-gone', onGone);
        wc.removeListener?.('destroyed', onGone);
        w.removeListener?.('unresponsive', onUnresponsive);
        // The page may still get to this question once it recovers (R4 fix-up,
        // real-app verifier 2: after a 14 s busy loop it opened "Save changes
        // to …?" for an Import that had already failed, and Don't save threw
        // the edits away for nothing). Tell it the question is over: it never
        // opens it, or closes it as Cancel (nothing changes).
        if (outcome === 'timeout' || outcome === 'unresponsive') {
          try { if (!wc.isDestroyed?.()) wc.send(EXPIRED_CHANNEL, token); } catch { /* the page went away */ }
        }
        resolve(outcome);
      };
      // Only this request's messages, from this window, count.
      function onAck(event, ackToken) {
        if (ackToken !== token || event?.sender !== wc) return;
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      function onAnswer(event, answerToken, go) {
        if (answerToken !== token || event?.sender !== wc) return;
        finish(go === false ? 'cancel' : 'proceed');
      }
      function onGone() { finish('gone'); }
      function onUnresponsive() { finish('unresponsive'); }
      ipcMain.on(ACK_CHANNEL, onAck);
      ipcMain.on(ANSWER_CHANNEL, onAnswer);
      wc.on?.('render-process-gone', onGone);
      wc.on?.('destroyed', onGone);
      w.on?.('unresponsive', onUnresponsive);
      ackTimer = setTimeout(() => finish('timeout'), ackTimeoutMs);
      try {
        // When main stops waiting for the acknowledgement: a page that gets
        // to the question only after this does not open it (R4 fix-up).
        wc.send(ASK_CHANNEL, token, reason, Date.now() + ackTimeoutMs);
      } catch {
        finish('no-window');
      }
    });
  }

  /** True when an action that leaves the page must ask first. */
  function needsAsk() {
    return alive() && dirty && !allowed;
  }

  /**
   * Ask before `reason` (a close, quit, reload, update or relaunch) when the
   * editor holds unsaved edits. Resolves true when the action may go ahead:
   * nothing unsaved, the user saved or chose Don't save, or the renderer
   * could not ask (hung, crashed, gone). False on Cancel, a failed save, or
   * while another question is open (that one decides).
   * @param {string} reason — for the log
   * @returns {Promise<boolean>}
   */
  async function confirm(reason) {
    if (!needsAsk()) return true;
    if (pending) {
      bringToFront(win);
      return false;
    }
    const startedAt = Date.now();
    pending = ask(reason);
    let outcome;
    try {
      outcome = await pending;
    } finally {
      pending = null;
    }
    note(reason, outcome, startedAt);
    if (outcome === 'cancel') return false;
    hung = outcome === 'timeout' || outcome === 'unresponsive';
    allowed = true;
    return true;
  }

  /**
   * Guard `w` (the main window): hold its close while the editor is dirty,
   * ask, and close it for real on a "go". Call once per created window,
   * BEFORE any other close hold (the audience room's device stop), so a
   * Cancel here never stops devices for a close that does not happen.
   */
  function attach(w) {
    win = w;
    dirty = false;
    allowed = false;
    pending = null;
    hung = false;
    const wc = w.webContents;
    // A crashed page holds nothing any more; a navigation (a reload) starts
    // a fresh, clean page.
    wc.on?.('render-process-gone', () => { if (win === w) dirty = false; });
    wc.on?.('did-navigate', () => {
      if (win !== w) return;
      dirty = false;
      allowed = false;
      hung = false;
    });
    // A reload or navigation that did not come through main's own routes
    // (DevTools' Ctrl+R / F5, a page-side location change) reaches the page's
    // beforeunload first, which holds it while the editor is dirty (R4-20,
    // app.js _onBeforeUnload). Electron reports that here; preventDefault()
    // lets the page go. Let it go whenever main would not ask (nothing
    // unsaved as far as main knows, the user already answered "go", the page
    // could not ask): never a second question for one action, and never a
    // trap. Otherwise this unload is dropped and the question asked; a "go"
    // reloads the page (the only page this window shows), Cancel keeps it.
    wc.on?.('will-prevent-unload', (event) => {
      if (win !== w || !needsAsk()) {
        event?.preventDefault?.();
        return;
      }
      if (pending) {
        bringToFront(w);
        return;
      }
      confirm('reloading or leaving the page').then((go) => {
        if (!go || w.isDestroyed?.() || wc.isDestroyed?.()) return;
        try { wc.reload(); } catch { /* the page went away meanwhile */ }
      });
    });
    w.on('close', (event) => {
      if (win !== w || !needsAsk()) return;
      event.preventDefault();
      if (pending) {
        bringToFront(w);
        return;
      }
      confirm('closing the window').then((go) => {
        if (!go || w.isDestroyed?.()) return;
        // A hung page holds its own close until it recovers (Chromium runs
        // its unload first): a frozen window, open for as long as the page
        // is busy, or for good (R3 fix-up, verifier 1: 26 s after a 25 s
        // busy loop, the backend long stopped). Closed for good instead.
        if (hung) w.destroy();
        else w.close();
      });
    });
  }

  /**
   * The action a "go" was given for did not happen after all: an Import or
   * Restore that failed, an update installer that did not start (R4-17).
   * When the page never answered (hung, 10 s), the edits are still unsaved
   * and nothing reports a change, so without this a later close or quit went
   * through without a question. Asks again next time, and forgets the hang
   * (the next question finds out afresh). A question open right now decides
   * for itself: nothing changes.
   * @param {string} [reason] — for the log
   */
  function reset(reason) {
    if (pending || (!allowed && !hung)) return;
    allowed = false;
    hung = false;
    if (reason && dirty) {
      try { log?.info?.(`[Editor] ${reason} did not happen: unsaved edits are asked about again`); } catch { /* logging only */ }
    }
  }

  return {
    attach,
    confirm,
    needsAsk,
    reset,
    /** A question is open right now. */
    asking: () => !!pending,
    /** The last question found the page hung: destroy its window, don't close it. */
    rendererHung: () => hung,
  };
}

/**
 * Restart Now went ahead (R4-17): the installer quits the app on the next
 * tick when it starts. When no quit has begun within `ms` (no downloaded
 * update, the installer would not start, quitAndInstall threw), the app is
 * still open with whatever is unsaved: reset the guard so the next close or
 * quit asks again.
 * @param {object} guard — createUnsavedEditsGuard()
 * @param {object} app — electron's app (once / removeListener 'before-quit')
 * @param {{ms?: number, reason?: string}} [opts]
 */
function resetUnlessQuitStarts(guard, app, { ms = INSTALL_START_WAIT_MS, reason = 'Installing the update' } = {}) {
  let quitting = false;
  const onQuit = () => { quitting = true; };
  app.once('before-quit', onQuit);
  const timer = setTimeout(() => {
    app.removeListener('before-quit', onQuit);
    if (!quitting) guard.reset(reason);
  }, ms);
  timer.unref?.();
}

module.exports = {
  createUnsavedEditsGuard, bringToFront, resetUnlessQuitStarts,
  DIRTY_CHANNEL, ASK_CHANNEL, ACK_CHANNEL, ANSWER_CHANNEL, EXPIRED_CHANNEL, ACK_TIMEOUT_MS, INSTALL_START_WAIT_MS,
};
