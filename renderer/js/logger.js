// logger.js — renderer → main log forwarding + uncaught-error capture.
//
// WHY THIS EXISTS: the renderer's `console.*` does NOT reach electron-log's
// file transport by default. Only explicit `window.funsync.logLine(...)`
// calls did (e.g. the startup timer). That meant when a user hit a problem
// and "sent their log file", the file contained main-process + Python lines
// only — none of the renderer-side Handy / Audience / sync diagnostics that
// actually explain device issues.
//
// installConsoleForwarding() routes console.log/info/warn/error through the
// existing `log-line` IPC channel so the user-submitted log file (and the
// "Report a problem" export) contains them. Uncaught errors + unhandled
// promise rejections are covered too: app.js installs window.onerror /
// 'unhandledrejection' handlers that call console.error, which this wrapper
// forwards — so we don't add duplicate listeners here.
//
// console.debug is intentionally NOT forwarded: it's used for per-tick /
// high-frequency traces (HDSP moves, drift checks) that would flood the
// 5 MB file. Developers still see those in DevTools.

let _installed = false;

/** Best-effort stringify of a single console argument for the log file. */
function _serializeArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  if (typeof arg === 'function') return `[function ${arg.name || 'anonymous'}]`;
  try {
    return JSON.stringify(arg);
  } catch {
    // Circular / non-serializable — fall back to coercion.
    try { return String(arg); } catch { return '[unserializable]'; }
  }
}

function _format(args) {
  return args.map(_serializeArg).join(' ');
}

/**
 * Override console.log/info/warn/error so every call ALSO lands in the
 * electron-log file via IPC, and forward uncaught errors + rejections.
 * Idempotent and safe to call before `window.funsync` exists (lines just
 * stay console-only until the bridge is ready).
 */
export function installConsoleForwarding() {
  if (_installed) return;
  if (typeof window === 'undefined') return;
  _installed = true;

  const forward = (level, text) => {
    const bridge = window.funsync?.logLine;
    if (typeof bridge !== 'function') return;
    try {
      const p = bridge(level, text);
      // logLine is ipcRenderer.invoke → returns a promise. Swallow
      // rejections so a logging failure can't become an unhandled
      // rejection (which we also forward → infinite loop).
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* logging must never throw into the caller */
    }
  };

  const wrap = (orig, level) => function (...args) {
    try { orig.apply(console, args); } catch { /* ignore */ }
    forward(level, _format(args));
  };

  console.log = wrap(console.log, 'info');
  console.info = wrap(console.info, 'info');
  console.warn = wrap(console.warn, 'warn');
  console.error = wrap(console.error, 'error');

  // NOTE: uncaught errors + unhandled promise rejections are already
  // captured — app.js installs `window.onerror` and an 'unhandledrejection'
  // listener that route through `console.error`, which the wrapper above now
  // forwards to the file. We deliberately do NOT add our own listeners here:
  // that would double-log every uncaught error and lose the DevTools console
  // print.

  forward('info', '[logger] renderer console forwarding active');
}
