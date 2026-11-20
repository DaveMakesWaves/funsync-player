/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FT-116, the Autoblow half (block F review, 2026-11-16; also in v0.9.2).
// Each Autoblow upload is its own IPC call and its own HTTP PUT in main, and
// the cloud keeps the LAST one to arrive. With Next pressed (or a variant
// picked) while an upload travelled, the new video's upload could land first
// and start, then the old PUT landed last and left the OLD script in the
// cloud under the new video: wrong motion. The Handy half (uploadSeq in
// HandyManager) was built; this half was filed.
//
// AutoblowSync now sends uploads one at a time, in the order asked for, and
// never sends one that was superseded before it left; app.js reads its
// `uploadSeq` to tell "not mine" from "failed". REAL AutoblowSync over the
// REAL AutoblowManager; the IPC to main is a fake cloud whose PUTs arrive
// when the test says. The REAL `_tryStartAutoblowSync` is lifted from app.js.
// No token, nothing leaves the test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoblowManager } from '../../renderer/js/autoblow-manager.js';
import { AutoblowSync } from '../../renderer/js/autoblow-sync.js';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

let puts;         // [{ content, resolve, reject }] in the order they LEFT
let cloud;        // the script the cloud holds (last PUT to arrive)
let savedWindow;

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  puts = [];
  cloud = null;
  savedWindow = globalThis.window;
  globalThis.window = {
    funsync: {
      autoblowUploadScript: vi.fn((content) => new Promise((resolve) => {
        puts.push({ content, arrive: (ok = true) => { if (ok) cloud = content; resolve(ok ? { success: true } : { success: false, error: 'nope' }); } });
      })),
      autoblowSyncStart: vi.fn(async () => ({ success: true })),
      autoblowSyncStop: vi.fn(async () => ({ success: true })),
    },
  };
});
afterEach(() => { globalThis.window = savedWindow; });

function rig() {
  const manager = new AutoblowManager();
  manager._connected = true;
  const video = Object.assign(new EventTarget(), { paused: true, seeking: false, readyState: 4, error: null, currentTime: 0 });
  const sync = new AutoblowSync({ videoPlayer: { video, get paused() { return video.paused; }, get currentTime() { return video.currentTime; } }, autoblowManager: manager });
  return { manager, sync };
}

describe('AutoblowSync: uploads reach the cloud in the order they were asked for (FT-116)', () => {
  it('the old upload still travelling: the new one leaves only once it has landed, and the cloud ends on the new script', async () => {
    const { sync } = rig();
    const a = sync.uploadScript('A');
    await settle();                    // A has left and is travelling
    const b = sync.uploadScript('B');
    await settle();
    expect(puts.map((p) => p.content), 'B left while A was still travelling').toEqual(['A']);
    puts[0].arrive();
    await settle();
    expect(puts.map((p) => p.content)).toEqual(['A', 'B']);
    puts[1].arrive();
    await expect(a).resolves.toBe(false);   // superseded: not the one to start
    await expect(b).resolves.toBe(true);
    expect(cloud).toBe('B');
    expect(sync.scriptReady).toBe(true);
  });

  it('two asked for while one travels: the middle one is never sent', async () => {
    const { sync } = rig();
    const a = sync.uploadScript('A');
    await settle();                    // A has left
    const b = sync.uploadScript('B');
    const c = sync.uploadScript('C');
    await settle();
    puts[0].arrive();
    await settle();
    expect(puts.map((p) => p.content)).toEqual(['A', 'C']);
    puts[1].arrive();
    expect(await Promise.all([a, b, c])).toEqual([false, false, true]);
    expect(cloud).toBe('C');
  });

  it('one asked for and superseded before it left is never sent', async () => {
    const { sync } = rig();
    const a = sync.uploadScript('A');
    const b = sync.uploadScript('B');
    await settle();
    expect(puts.map((p) => p.content)).toEqual(['B']);
    puts[0].arrive();
    expect(await Promise.all([a, b])).toEqual([false, true]);
    expect(cloud).toBe('B');
  });

  it('a failed upload that nothing superseded still says false and leaves the script not ready', async () => {
    const { sync } = rig();
    const a = sync.uploadScript('A');
    await settle();
    puts[0].arrive(false);
    await expect(a).resolves.toBe(false);
    expect(sync.scriptReady).toBe(false);
    // ...and the next upload is not held back by it.
    const b = sync.uploadScript('B');
    await settle();
    puts[1].arrive();
    await expect(b).resolves.toBe(true);
  });

  it('uploadScript and uploadSeq exist on the real class the app calls', () => {
    expect(typeof AutoblowSync.prototype.uploadScript).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(AutoblowSync.prototype, 'uploadSeq')?.get).toBe('function');
  });
});

describe('app.js _tryStartAutoblowSync: a superseded upload is "not mine", not a failure', () => {
  const Lifted = liftAppClass(['_tryStartAutoblowSync'], {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  });

  it('a variant picked while the first upload travelled: only the newer one starts the engine and resolves the gate', async () => {
    const { manager, sync } = rig();
    let raw = 'A';
    const resolved = [];
    const app = Object.assign(new Lifted(), {
      autoblowSync: sync,
      autoblowManager: manager,
      funscriptEngine: { isLoaded: true, getRawContent: () => raw },
      _videoLoadGen: 1,
      _autoblowUploadContent: (c) => c,
      _uploadDurationMsFor: () => null,
      _resolveCloudUpload: (k) => resolved.push(k),
    });
    const startSpy = vi.spyOn(sync, 'start');
    const first = app._tryStartAutoblowSync();
    await settle();
    raw = 'B';                         // the variant switch
    const second = app._tryStartAutoblowSync();
    await settle();
    puts[0].arrive();                  // A lands first...
    await settle();
    expect(resolved, 'the superseded upload lifted the gate').toEqual([]);
    expect(startSpy, 'the superseded upload started the engine').not.toHaveBeenCalled();
    puts[1].arrive();                  // ...then B, which is the one to start
    await Promise.all([first, second]);
    expect(cloud).toBe('B');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual(['autoblow']);
    sync.stop();
  });
});
