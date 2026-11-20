/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-107 finding (block E1, 2026-11-07; also in v0.9.2): every session of
// the PACKAGED app left a ~25 MB `_MEIxxxxx` folder in %TEMP%. verify-2 found
// 148 of them, 415 MB, in one user's TEMP, dated May to November.
//
// The PyInstaller one-file exe is a bootloader: it unpacks itself into
// %TEMP%\_MEIxxxxx, runs the app as its CHILD, and deletes that folder when
// the child exits. stopBackend ran `taskkill /pid <bootloader> /T /F`, which
// killed both at once, so the bootloader never got to clean up. Measured in
// scratch with the real exe: 4 launches stopped that way left 4 folders;
// killing only the child left none.
//
// stopBundledBackend now stops the child (the process listening on the
// port) first, waits for the bootloader to exit on its own, and kills the
// tree only if it is still there, so a stop never leaves a backend running.
// Asserted on the commands that would run, against a fake process table
// that behaves as the bootloader does.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Required, not imported: python-bridge is CommonJS (see backend-log-level.test.js).
const require_ = createRequire(import.meta.url);
const { stopBundledBackend } = require_('../../electron/python-bridge.js');

const BOOT = 4100;  // the spawned exe: the bootloader
const CHILD = 4200; // the app it runs, which listens on the port

/**
 * A process table with the one-file exe running. The bootloader exits by
 * itself `cleanupMs` after its child dies (it deletes _MEI first), unless it
 * `hangs`; a tree kill takes both at once and leaves the folder.
 */
function rig({ cleanupMs = 200, hangs = false, listening = [CHILD] } = {}) {
  const procs = new Set([BOOT, CHILD]);
  const ran = [];
  let clock = 0;
  let childDiedAt = null;
  let meiLeft = true;
  const deps = {
    exec: (cmd) => {
      ran.push(cmd);
      const m = /\/pid (\d+)/i.exec(cmd);
      const pid = Number(m[1]);
      if (pid === BOOT && /\/T/.test(cmd)) { procs.delete(BOOT); procs.delete(CHILD); return; }
      if (pid === CHILD) { procs.delete(CHILD); childDiedAt = clock; }
    },
    listenerPids: () => listening.map(String),
    isAlive: (pid) => {
      if (pid === BOOT && procs.has(BOOT) && !hangs && childDiedAt !== null && clock - childDiedAt >= cleanupMs) {
        procs.delete(BOOT);
        meiLeft = false; // it cleaned up on its way out
      }
      return procs.has(pid);
    },
    sleep: (ms) => { clock += ms; },
  };
  return { deps, ran, get meiLeft() { return meiLeft; }, get clock() { return clock; }, procs };
}

describe('the packaged backend stops child-first so its _MEI folder goes', () => {
  it('kills the listening child, never the bootloader, which cleans up and exits by itself', () => {
    const r = rig({ cleanupMs: 300 });
    expect(stopBundledBackend(BOOT, 5123, r.deps)).toBe('clean');
    expect(r.ran).toEqual([`taskkill /PID ${CHILD} /T /F`]);
    expect(r.meiLeft).toBe(false);
    expect(r.procs.size).toBe(0);
    expect(r.clock).toBeLessThan(1000);
  });

  it('a bootloader that does not exit in time: the tree is killed, so nothing keeps running', () => {
    const r = rig({ hangs: true });
    expect(stopBundledBackend(BOOT, 5123, { ...r.deps, waitMs: 3000 })).toBe('tree');
    expect(r.ran).toEqual([`taskkill /PID ${CHILD} /T /F`, `taskkill /pid ${BOOT} /T /F`]);
    expect(r.procs.size).toBe(0);
    expect(r.clock).toBeGreaterThanOrEqual(3000);
    expect(r.clock).toBeLessThan(3200);
  });

  it('nothing listening yet (stopped while starting): the tree kill, at once', () => {
    const r = rig({ listening: [] });
    expect(stopBundledBackend(BOOT, 5123, r.deps)).toBe('tree');
    expect(r.ran).toEqual([`taskkill /pid ${BOOT} /T /F`]);
    expect(r.clock).toBe(0);
    expect(r.procs.size).toBe(0);
  });

  it('netstat failing is the tree kill, never a backend left behind', () => {
    const r = rig();
    const deps = { ...r.deps, listenerPids: () => { throw new Error('netstat missing'); } };
    expect(stopBundledBackend(BOOT, 5123, deps)).toBe('tree');
    expect(r.procs.size).toBe(0);
  });

  it('the bootloader itself listed as the listener is not the child: the tree kill', () => {
    const r = rig({ listening: [BOOT] });
    expect(stopBundledBackend(BOOT, 5123, r.deps)).toBe('tree');
    expect(r.ran).toEqual([`taskkill /pid ${BOOT} /T /F`]);
  });
});
