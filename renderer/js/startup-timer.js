// Startup timing instrumentation. Lightweight — wraps awaits in named
// spans, dumps a sorted summary at end of init. Always-on; cheap enough
// to leave in. Toggle the summary via `STARTUP_TIMING` global if needed.
//
// Usage:
//   import { startInit, span, record, logSummary } from './startup-timer.js';
//   startInit();
//   await span('dataService.init', () => dataService.init());
//   record('something', 42);
//   logSummary();

const spans = [];
let initStart = null;

// Write timing lines through both console.log AND the IPC log-line
// bridge. The latter writes directly to electron-log's file transport
// in main, so timing data still lands in main.log even if the renderer
// console forwarding transport is broken (e.g. when the parent process
// closed stdout, which causes the EPIPE flood we hit during automated
// launches).
function _emit(line) {
  console.log(line);
  if (typeof window !== 'undefined' && window.funsync?.logLine) {
    try { window.funsync.logLine('info', line); } catch { /* ignore */ }
  }
}

export function startInit() {
  initStart = performance.now();
  spans.length = 0;
}

/** Wrap an awaitable function with a timed span. */
export async function span(name, fn) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    const completedAt = performance.now() - initStart;
    spans.push({ name, ms, completedAt });
    _emit(`[Timing] ${name}: ${ms.toFixed(0)}ms (at ${completedAt.toFixed(0)}ms)`);
  }
}

/** Record a manually-measured duration (e.g. from outside the await chain). */
export function record(name, ms) {
  const completedAt = performance.now() - initStart;
  spans.push({ name, ms, completedAt });
  _emit(`[Timing] ${name}: ${ms.toFixed(0)}ms (at ${completedAt.toFixed(0)}ms)`);
}

/** Mark an event happening "now" (zero-duration milestone). */
export function mark(name) {
  if (initStart == null) return;
  const completedAt = performance.now() - initStart;
  spans.push({ name, ms: 0, completedAt });
  _emit(`[Timing] mark ${name} (at ${completedAt.toFixed(0)}ms)`);
}

/** Dump a sorted summary. Call at the end of your startup chain. */
export function logSummary(title = 'Startup timings') {
  if (initStart == null) return;
  const total = performance.now() - initStart;
  const sorted = [...spans].sort((a, b) => b.ms - a.ms);

  _emit(`========== ${title} (total: ${total.toFixed(0)}ms) ==========`);
  _emit('SORTED BY DURATION (slowest first):');
  for (const s of sorted) {
    if (s.ms === 0) {
      _emit(`  ${'mark'.padStart(10)}  ${s.name} (at ${s.completedAt.toFixed(0)}ms)`);
    } else {
      _emit(`  ${(s.ms.toFixed(0) + 'ms').padStart(10)}  ${s.name} (completed at ${s.completedAt.toFixed(0)}ms)`);
    }
  }
  _emit('========================================');
}

/**
 * For external observers (e.g. tests, devtools) — return the recorded
 * spans without printing.
 */
export function getSpans() {
  return [...spans];
}
