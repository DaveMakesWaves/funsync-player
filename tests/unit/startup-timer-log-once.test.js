/**
 * @vitest-environment jsdom
 * jsdom on purpose: logger.js and startup-timer.js branch on
 * `typeof window !== 'undefined'` and take their non-DOM path under node
 * (notes/CLAUDE.md "Test environments"), which never forwards anything.
 */
// FT-086 (also in v0.9.2): every [Timing] line and the startup summary were
// written to main.log twice. startup-timer's _emit called console.log, which
// installConsoleForwarding() (logger.js) forwards over the `log-line` IPC,
// AND window.funsync.logLine directly, the same IPC. Live, in the block D
// repro sandbox's main.log, only those lines doubled: "[Timing]
// dataService.init: 12ms (at 12ms)" at 09:26:03.284 and again at .286, while
// every other renderer line appeared once.
//
// What is asserted is what reaches the bridge main writes to the file from
// (`window.funsync.logLine`): each line exactly once, with forwarding
// installed (the app) and without it (the EPIPE fallback the direct call
// was written for).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const LEVELS = ['log', 'info', 'warn', 'error'];
let saved;
let written;

beforeEach(() => {
  vi.resetModules(); // a fresh logger.js: its `_installed` flag starts false
  saved = Object.fromEntries(LEVELS.map((l) => [l, console[l]]));
  // The DevTools print: silent here, the bridge is what is under test.
  for (const l of LEVELS) console[l] = () => {};
  written = [];
  window.funsync = { logLine: (level, text) => { written.push(`${level} ${text}`); return Promise.resolve(); } };
});

afterEach(() => {
  for (const l of LEVELS) console[l] = saved[l];
  delete window.funsync;
});

/** Run a startup as app.init() does: spans, a record, a mark, the summary. */
async function runStartup(timer) {
  timer.startInit();
  await timer.span('dataService.init', async () => {});
  timer.record('getBackendPort IPC', 3);
  timer.mark('window shown');
  timer.logSummary();
}

const counts = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());

describe('startup timing lines reach main.log once (FT-086)', () => {
  it('with console forwarding installed (the app, the player pop-out): every line once', async () => {
    const { installConsoleForwarding } = await import('../../renderer/js/logger.js');
    installConsoleForwarding();
    written = []; // drop the "[logger] renderer console forwarding active" line
    const timer = await import('../../renderer/js/startup-timer.js');
    await runStartup(timer);

    const timing = written.filter((l) => /\[Timing\]|Startup timings|SORTED BY|====|dataService\.init|window shown/.test(l));
    expect(timing.length).toBeGreaterThanOrEqual(8);
    for (const [line, n] of counts(written)) expect({ line, n }).toEqual({ line, n: 1 });
    expect(written.some((l) => /^info \[Timing\] dataService\.init: \d+ms \(at \d+ms\)$/.test(l))).toBe(true);
  });

  it('a plain renderer console line also lands once', async () => {
    const { installConsoleForwarding } = await import('../../renderer/js/logger.js');
    installConsoleForwarding();
    written = [];
    console.info('dup-probe-1');
    expect(written).toEqual(['info dup-probe-1']);
  });

  it('without forwarding (its fallback): the timer still writes every line itself, once', async () => {
    const timer = await import('../../renderer/js/startup-timer.js');
    await runStartup(timer);
    expect(written.length).toBeGreaterThanOrEqual(8);
    for (const [line, n] of counts(written)) expect({ line, n }).toEqual({ line, n: 1 });
  });
});
