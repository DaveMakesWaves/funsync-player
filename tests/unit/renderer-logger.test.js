// renderer/js/logger.js — renderer console forwarding to the electron-log
// file via IPC. Guards the diagnostic pipe that lets users send a useful
// log file (or copy the console) when a problem occurs.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { installConsoleForwarding } from '../../renderer/js/logger.js';

// Capture the real console methods so we can both spy on them (to assert the
// wrapper still calls through) and restore them after the suite — the module
// monkeypatches the global console process-wide.
const ORIG = {
  log: console.log, info: console.info, warn: console.warn,
  error: console.error, debug: console.debug,
};

let logLine;
let logSpy; // the original console.log spy the wrapper calls through to

beforeAll(() => {
  // Replace console with spies BEFORE install, so the wrapper captures the
  // spies as its "original" — keeps test output quiet and lets us assert
  // pass-through. After install, console.log IS the wrapper, so we keep a
  // reference to the underlying spy for the pass-through assertion.
  logSpy = vi.fn();
  console.log = logSpy;
  console.info = vi.fn();
  console.warn = vi.fn();
  console.error = vi.fn();
  console.debug = vi.fn();

  logLine = vi.fn(() => Promise.resolve());
  window.funsync = { logLine };

  installConsoleForwarding();
});

afterAll(() => {
  Object.assign(console, ORIG);
  delete window.funsync;
});

describe('installConsoleForwarding', () => {
  it('forwards console.log as info to the IPC log channel', () => {
    logLine.mockClear();
    console.log('hello', 'world');
    expect(logLine).toHaveBeenCalledWith('info', 'hello world');
  });

  it('maps warn → warn and error → error', () => {
    logLine.mockClear();
    console.warn('careful');
    console.error('boom');
    expect(logLine).toHaveBeenCalledWith('warn', 'careful');
    expect(logLine).toHaveBeenCalledWith('error', 'boom');
  });

  it('does NOT forward console.debug (high-frequency, would flood the file)', () => {
    logLine.mockClear();
    console.debug('per-tick noise');
    expect(logLine).not.toHaveBeenCalled();
  });

  it('still calls through to the original console method', () => {
    logSpy.mockClear();
    console.log('passthrough');
    expect(logSpy).toHaveBeenCalledWith('passthrough');
  });

  it('serializes an Error to its stack/message', () => {
    logLine.mockClear();
    console.error(new Error('kaboom'));
    const [, text] = logLine.mock.calls[0];
    expect(text).toContain('kaboom');
  });

  it('serializes objects without throwing', () => {
    logLine.mockClear();
    console.log('obj', { a: 1, b: [2, 3] });
    expect(logLine).toHaveBeenCalledWith('info', 'obj {"a":1,"b":[2,3]}');
  });

  it('survives a circular object (falls back, no throw)', () => {
    const circ = {};
    circ.self = circ;
    expect(() => console.log('c', circ)).not.toThrow();
  });

  it('is idempotent — a second install does not double-forward', () => {
    installConsoleForwarding();
    logLine.mockClear();
    console.log('once');
    expect(logLine).toHaveBeenCalledTimes(1);
  });
});
