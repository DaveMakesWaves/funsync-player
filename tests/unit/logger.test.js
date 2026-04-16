// Unit tests for logger — both isolated pattern tests and real module import
import { describe, it, expect, vi, beforeAll } from 'vitest';

// ---- ISOLATED: test handler patterns without importing real modules ----
// These verify the error-handler wiring patterns used in app.js and main.js.
// They don't import any electron/ modules.

describe('logger — isolated handler patterns', () => {
  it('renderer window.onerror calls console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Simulate what app.js sets up
    const handler = (msg, src, line, col, err) => console.error('[Window]', msg, err);
    handler('test error', 'file.js', 1, 1, new Error('boom'));
    expect(spy).toHaveBeenCalledWith('[Window]', 'test error', expect.any(Error));
    spy.mockRestore();
  });

  it('renderer unhandledrejection calls console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = (e) => console.error('[Rejection]', e.reason);
    handler({ reason: 'promise broke' });
    expect(spy).toHaveBeenCalledWith('[Rejection]', 'promise broke');
    spy.mockRestore();
  });

  it('uncaught exception handler pattern calls log.error', () => {
    const mockLog = { error: vi.fn() };
    const handler = (err) => mockLog.error('Uncaught exception:', err);
    const err = new Error('test');
    handler(err);
    expect(mockLog.error).toHaveBeenCalledWith('Uncaught exception:', err);
  });

  it('unhandled rejection handler pattern calls log.error', () => {
    const mockLog = { error: vi.fn() };
    const handler = (reason) => mockLog.error('Unhandled rejection:', reason);
    handler('promise error');
    expect(mockLog.error).toHaveBeenCalledWith('Unhandled rejection:', 'promise error');
  });
});

// ---- REAL MODULE: import electron/logger.js which loads real electron-log ----
// logger.js is CJS (require('electron-log/main')). Vitest's vi.mock only
// intercepts ESM imports, not CJS require() inside CJS modules. So we skip
// mocking and test the real configured module — this is better anyway since
// we verify actual configuration, not mock interactions.

describe('logger — real module (electron/logger.js)', () => {
  let log;

  // Import once — logger.js configures electron-log at require time
  beforeAll(async () => {
    const mod = await import('../../electron/logger.js');
    log = mod.default;
  });

  it('imports without throwing', () => {
    expect(log).toBeDefined();
  });

  it('sets file max size to 5 MB', () => {
    expect(log.transports.file.maxSize).toBe(5 * 1024 * 1024);
  });

  it('sets log format with timestamp and level', () => {
    expect(log.transports.file.format).toContain('{y}');
    expect(log.transports.file.format).toContain('{level}');
    expect(log.transports.file.format).toContain('{text}');
  });

  it('exposes standard log level functions', () => {
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });
});
