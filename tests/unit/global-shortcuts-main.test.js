/**
 * @vitest-environment jsdom
 * jsdom on purpose: the renderer half runs app.js's REAL toast choice with
 * the real i18n.js, which branches on `typeof window` (notes/CLAUDE.md
 * "Test environments"). The main-process half needs no DOM.
 */
// V48 (app test 2026-11-02): a global hotkey that Electron cannot parse was
// reported to the user as "already used by another app", and logged twice.
//
// globalShortcut.register THROWS for an accelerator it cannot parse (a gin
// argument-conversion TypeError) and RETURNS false when another application
// owns the combination. Both came back as a bare ok:false, so the renderer
// showed the "taken" toast for a typo, and the catch's log line was followed
// by the "rejected — another app likely owns it" line for the same binding.
//
// electron/global-shortcuts.js runs for real against a fake globalShortcut
// that keeps Electron's contract (throw vs false, one owner per
// accelerator), and its results go through app.js's REAL
// `_applyGlobalShortcuts` (lifted) to the toast the user sees.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { liftAppClass } from './helpers/app-methods.js';

const require = createRequire(import.meta.url);
const { createGlobalShortcuts } = require('../../electron/global-shortcuts.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
beforeAll(() => _setBundlesForTests('en', EN, EN));

/**
 * Electron's globalShortcut, as far as this module relies on it: register()
 * throws a TypeError for an accelerator it cannot convert, returns false
 * for one another application holds, and true otherwise.
 */
function fakeGlobalShortcut({ heldElsewhere = [], unparsable = [] } = {}) {
  const owned = new Map();
  return {
    owned,
    register: vi.fn((accel, cb) => {
      if (unparsable.includes(accel)) {
        throw new TypeError(`Error processing argument at index 0, conversion failure from ${accel}`);
      }
      if (heldElsewhere.includes(accel) || owned.has(accel)) return false;
      owned.set(accel, cb);
      return true;
    }),
    unregister: vi.fn((accel) => { owned.delete(accel); }),
  };
}

function setup(opts) {
  const globalShortcut = fakeGlobalShortcut(opts);
  const log = { warn: vi.fn() };
  const fired = [];
  const hotkeys = createGlobalShortcuts({ globalShortcut, log, onFire: (a) => fired.push(a) });
  return { globalShortcut, log, fired, hotkeys };
}

describe('V48: main process tells an invalid accelerator from a taken one', () => {
  it('reports why each binding failed', () => {
    const { hotkeys } = setup({ heldElsewhere: ['Ctrl+Alt+M'], unparsable: ['Ctrl+Foo'] });
    const results = hotkeys.apply({ playPause: 'Ctrl+Foo', orgasm: 'Ctrl+Alt+M', edge: 'F9' });
    expect(results).toEqual([
      { action: 'playPause', accelerator: 'Ctrl+Foo', ok: false, reason: 'invalid' },
      { action: 'orgasm', accelerator: 'Ctrl+Alt+M', ok: false, reason: 'taken' },
      { action: 'edge', accelerator: 'F9', ok: true },
    ]);
  });

  it('logs each failure once, saying which failure it was', () => {
    const { hotkeys, log } = setup({ heldElsewhere: ['Ctrl+Alt+M'], unparsable: ['Ctrl+Foo'] });
    hotkeys.apply({ playPause: 'Ctrl+Foo', orgasm: 'Ctrl+Alt+M', edge: 'F9' });
    const lines = log.warn.mock.calls.map((c) => c[0]);
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.includes('Ctrl+Foo'))).toEqual([
      expect.stringMatching(/playPause \(Ctrl\+Foo\) is not a valid accelerator/),
    ]);
    expect(lines.filter((l) => l.includes('Ctrl+Alt+M'))).toEqual([
      expect.stringMatching(/orgasm \(Ctrl\+Alt\+M\) rejected — another app likely owns it/),
    ]);
  });

  it('a registered key fires its action; applying again replaces the old set', () => {
    const { hotkeys, globalShortcut, fired } = setup();
    hotkeys.apply({ playPause: 'Ctrl+Alt+P', edge: 'F9' });
    globalShortcut.owned.get('Ctrl+Alt+P')();
    expect(fired).toEqual(['playPause']);

    hotkeys.apply({ edge: 'F10' });
    expect([...globalShortcut.owned.keys()]).toEqual(['F10']);
    hotkeys.unregisterAll();
    expect(globalShortcut.owned.size).toBe(0);
  });

  it('a failed binding is never left registered, so re-applying does not trip over it', () => {
    const { hotkeys, globalShortcut } = setup({ unparsable: ['Ctrl+Foo'] });
    hotkeys.apply({ playPause: 'Ctrl+Foo', edge: 'F9' });
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
    hotkeys.apply({ edge: 'F9' });
    expect(globalShortcut.unregister.mock.calls.map((c) => c[0])).toEqual(['F9']);
    expect([...globalShortcut.owned.keys()]).toEqual(['F9']);
  });
});

describe('V48: the user is told the right thing', () => {
  function appWith(bindings, opts) {
    const { hotkeys } = setup(opts);
    const toasts = [];
    const Lifted = liftAppClass(['_applyGlobalShortcuts'], {
      // The IPC hop is a pass-through (preload invoke → ipcMain.handle).
      window: { funsync: { setGlobalShortcuts: async (b) => hotkeys.apply(b) } },
      showToast: (message, type) => toasts.push({ message, type }),
      t,
      // The answer also goes to the Settings rows (CB-19).
      eventBus,
      console: { warn: () => {} },
    });
    const app = new Lifted();
    app.settings = { get: (k) => (k === 'player.globalShortcuts' ? bindings : undefined) };
    return { app, toasts };
  }

  it('an accelerator Electron cannot parse says so, not "used by another app"', async () => {
    const { app, toasts } = appWith({ playPause: 'Ctrl+Foo' }, { unparsable: ['Ctrl+Foo'] });
    await app._applyGlobalShortcuts();
    expect(toasts).toEqual([
      { message: "Ctrl+Foo isn't a valid key combination — pick a different hotkey", type: 'warn' },
    ]);
  });

  it('a combination another app holds still says that', async () => {
    const { app, toasts } = appWith({ orgasm: 'Ctrl+Alt+M' }, { heldElsewhere: ['Ctrl+Alt+M'] });
    await app._applyGlobalShortcuts();
    expect(toasts).toEqual([
      { message: 'Ctrl+Alt+M is already used by another app — pick a different hotkey', type: 'warn' },
    ]);
  });

  it('nothing to say when everything registered', async () => {
    const { app, toasts } = appWith({ edge: 'F9' });
    await app._applyGlobalShortcuts();
    expect(toasts).toEqual([]);
  });
});
