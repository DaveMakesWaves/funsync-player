/**
 * @vitest-environment jsdom
 * jsdom: the REAL dialog on the REAL Modal.
 */
// The Bluetooth sync test (brokenobj #431, 2026-11-23): renderer/js/bt-sync-test.js
// (the measurement summed up, when each command goes, the beat), the
// manager's round trip, and the dialog (Measure, Feel it, Save; the beat
// always stops: Cancel, Escape, Stop all).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { summariseRoundTrips, beatCommands, pulseKind, clampOffset, SyncPulser, STROKE_UP_MS, PULSE_MS, BEAT_MS } from '../../renderer/js/bt-sync-test.js';
import { ButtplugManager } from '../../renderer/js/buttplug-manager.js';
import { openBtSyncTestDialog, stopBtSyncTest, isBtSyncTestRunning } from '../../renderer/components/bt-sync-test-dialog.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

describe('the model', () => {
  it('a measurement: median, spread, and an offset that fires earlier by half the round trip', () => {
    const s = summariseRoundTrips([80, 90, 100, 85, 95, NaN, -3]);
    expect(s).toMatchObject({ median: 90, min: 80, max: 100, spread: 20, count: 5, suggested: -50 });
    expect(summariseRoundTrips([])).toBeNull();
  });

  it('a vibrator buzzes AT the beat; a stroker ARRIVES at the top at the beat; the offset moves both', () => {
    expect(beatCommands('vibrate', 5000, 0)).toEqual([
      { at: 5000, cmd: 'vibrate', value: 100 },
      { at: 5000 + PULSE_MS, cmd: 'vibrate', value: 0 },
    ]);
    const lin = beatCommands('linear', 5000, -80);
    expect(lin[0]).toEqual({ at: 5000 - STROKE_UP_MS - 80, cmd: 'linear', value: 100, durationMs: STROKE_UP_MS });
    expect(lin[1].value).toBe(0);
  });

  it('what each toy can do in the test: strokers, vibrators; a flywheel machine is left out', () => {
    expect(pulseKind({ canLinear: true, canVibrate: true })).toBe('linear');
    expect(pulseKind({ canVibrate: true })).toBe('vibrate');
    expect(pulseKind({ canOscillate: true })).toBeNull();
    expect(clampOffset(-999)).toBe(-400);
    expect(clampOffset(37)).toBe(40);
  });

  it('the beat: a flash each second, every command at its time, stop() stops the toys and nothing more is sent', () => {
    vi.useFakeTimers();
    let now = 0;
    const sent = [];
    const manager = {
      sendVibrate: (i, v) => sent.push([now, 'vib', i, v]),
      sendLinear: (i, v) => sent.push([now, 'lin', i, v]),
      stopDevice: vi.fn(),
    };
    const beats = [];
    const p = new SyncPulser({
      manager,
      devices: [{ index: 1, canVibrate: true }, { index: 2, canOscillate: true }],
      onBeat: (at) => beats.push(at),
      now: () => now,
      setTimer: (fn, ms) => setTimeout(() => { now += 0; fn(); }, ms),
    });
    p.setOffset(-100);
    expect(p.start()).toBe(true);
    const step = (ms) => { for (let i = 0; i < ms; i += 10) { now += 10; vi.advanceTimersByTime(10); } };
    step(3000);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[1] - beats[0]).toBe(BEAT_MS);
    // Each buzz went 100 ms before its beat (offset -100), to the vibrator only.
    const ons = sent.filter((s) => s[1] === 'vib' && s[3] === 100);
    expect(ons.length).toBeGreaterThanOrEqual(2);
    expect(ons[0][0]).toBe(beats[0] - 100);
    expect(sent.every((s) => s[2] === 1)).toBe(true);
    expect(p.stop()).toBe(true);
    const n = sent.length;
    step(3000);
    expect(sent.length).toBe(n);
    expect(manager.stopDevice).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});

describe('ButtplugManager.measureRoundTrip', () => {
  it('times each stop; a failed one is left out', async () => {
    const m = new ButtplugManager();
    let t = 0;
    let n = 0;
    m._devices.set(3, { name: 'Toy', stop: async () => { n += 1; t += n === 2 ? 0 : 40; if (n === 2) throw new Error('gone'); } });
    const out = await m.measureRoundTrip(3, { count: 3, gapMs: 0, now: () => t });
    expect(out).toEqual([40, 40]);
    expect(await m.measureRoundTrip(99)).toEqual([]);
  });
});

describe('the dialog', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="toast-container"></div>'; _setBundlesForTests('en', EN, EN); });
  const frame = () => new Promise((r) => setTimeout(r, 30));
  function deps(extra = {}) {
    const store = { 'buttplug.defaultOffset': -60 };
    return {
      manager: {
        connected: true,
        devices: [{ index: 1, name: 'Lush', canVibrate: true }],
        measureRoundTrip: vi.fn(async () => [70, 80, 90]),
        sendVibrate: vi.fn(), sendLinear: vi.fn(), stopDevice: vi.fn(),
      },
      settings: { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) },
      sync: { setOffsetMs: vi.fn() },
      pausePlayback: vi.fn(),
      store,
      ...extra,
    };
  }

  it('pauses playback, measures, offers the suggestion, and Save writes and applies the offset', async () => {
    const d = deps();
    const p = openBtSyncTestDialog(d);
    await frame();
    expect(d.pausePlayback).toHaveBeenCalled();
    expect(document.querySelector('.bt-sync-test__value').textContent).toBe('60 ms earlier');
    document.querySelector('.bt-sync-test__measure').click();
    await frame();
    expect(document.querySelector('.bt-sync-test__result').textContent).toBe('Round trip 80 ms (from 70 to 90 ms)');
    expect(d.store['buttplug.measuredRoundTripMs']).toBe(80);
    const use = document.querySelector('.bt-sync-test__use');
    expect(use.hidden).toBe(false);
    use.click();
    expect(document.querySelector('.bt-sync-test__value').textContent).toBe('40 ms earlier');
    document.querySelector('.bt-sync-test__save').click();
    expect(await p).toEqual({ saved: true, offsetMs: -40 });
    expect(d.store['buttplug.defaultOffset']).toBe(-40);
    expect(d.store['buttplug.defaultOffsetSource']).toBe('user');
    expect(d.sync.setOffsetMs).toHaveBeenCalledWith(-40);
  });

  it('the beat runs from Start and always ends: Stop all, then Escape', async () => {
    const d = deps();
    const p = openBtSyncTestDialog(d);
    await frame();
    document.querySelector('.bt-sync-test__go').click();
    expect(isBtSyncTestRunning()).toBe(true);
    expect(stopBtSyncTest()).toBe(true);
    expect(isBtSyncTestRunning()).toBe(false);
    expect(d.manager.stopDevice).toHaveBeenCalledWith(1);
    expect(document.querySelector('.bt-sync-test__go').textContent).toBe('Start'); // the dialog follows
    document.querySelector('.bt-sync-test__go').click(); // Start again
    expect(isBtSyncTestRunning()).toBe(true);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBeNull();
    expect(isBtSyncTestRunning()).toBe(false);
    expect(d.store['buttplug.defaultOffset']).toBe(-60);
  });

  it('no toy connected: says how to connect one, nothing else', async () => {
    const d = deps({ manager: { connected: false, devices: [] } });
    const p = openBtSyncTestDialog(d);
    await frame();
    expect(document.querySelector('.bt-sync-test__none')).not.toBeNull();
    expect(document.querySelector('.bt-sync-test__measure')).toBeNull();
    document.querySelector('.modal-actions button').click();
    expect(await p).toBeNull();
  });
});

// Found on Dave's Lovense Edge via Intiface (2026-11-25): every stop answered
// in 1-2 ms, before the toy had it. That is the local link to Intiface, not
// the Bluetooth delay: it must not be saved, nor turned into a suggestion
// (which would replace the Sync tab's preset-based one with ~0 ms).
describe('a round trip faster than Bluetooth can answer is not the toy\'s', () => {
  it('1-2 ms: not plausible, no suggestion; 60-90 ms: plausible, suggested as before', () => {
    const fast = summariseRoundTrips([1, 1, 1, 2, 1, 1, 2, 2, 2, 2]);
    expect(fast.median).toBeLessThan(15);
    expect(fast.plausible).toBe(false);
    expect(fast.suggested).toBeNull();
    const ble = summariseRoundTrips([60, 70, 80, 90, 75]);
    expect(ble.plausible).toBe(true);
    expect(ble.suggested).toBeLessThan(0);
  });
  it('the dialog says so, saves nothing and offers no offset', async () => {
    const store = {};
    const d = {
      manager: {
        connected: true,
        devices: [{ index: 1, name: 'Lovense Edge', canVibrate: true }],
        measureRoundTrip: vi.fn(async () => [1, 2, 1, 2, 1]),
        sendVibrate: vi.fn(), sendLinear: vi.fn(), stopDevice: vi.fn(),
      },
      settings: { get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) },
      sync: { setOffsetMs: vi.fn() },
      pausePlayback: vi.fn(),
    };
    openBtSyncTestDialog(d);
    await new Promise((r) => setTimeout(r, 30));
    document.querySelector('.bt-sync-test__measure').click();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('.bt-sync-test__result').textContent).toMatch(/Intiface answered in 1 ms/);
    expect(store['buttplug.measuredRoundTripMs']).toBeUndefined();
    expect(document.querySelector('.bt-sync-test__use').hidden).toBe(true);
    stopBtSyncTest();
  });
});
