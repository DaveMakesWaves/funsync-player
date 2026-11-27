/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The script player on the REAL Handy code (v0.10.1): the REAL HandyManager on
// the fake SDK (helpers/fake-handy-sdk.js), the REAL DeviceGate, two REAL
// SyncEngines: the video's (on the real manager) and the script player's (on
// its owner facade), and REAL FunscriptEngines. Nothing reaches the cloud; the
// key is the fake TESTKEY01.
//
// Asserted on what the device was sent: while the script player plays, the
// video's engine and the video's upload reach nothing (the Handy keeps the
// loose script); the script player's own play and stop do; after ✕ the video's
// upload reaches the device again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHandySdk, attachFakeCloud } from './helpers/fake-handy-sdk.js';

const h = vi.hoisted(() => ({ sdk: null, uploads: [] }));
vi.mock('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js', () => ({
  init: () => h.sdk,
  getEstimatedServerTime: () => 0,
  uploadDataToServer: async (content) => {
    h.uploads.push(content);
    await new Promise((r) => setTimeout(r, 0));
    return `https://scripts.local/${h.uploads.length}.csv`;
  },
}));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (k) => k }));

import { HandyManager } from '../../renderer/js/handy-manager.js';
import { SyncEngine } from '../../renderer/js/sync-engine.js';
import { FunscriptEngine } from '../../renderer/js/funscript-engine.js';
import { DeviceGate, installDeviceGate } from '../../renderer/js/device-gate.js';
import { ScriptPlayer } from '../../renderer/js/script-player.js';
import { ScriptClock } from '../../renderer/js/script-clock.js';

const LOOSE = JSON.stringify({ actions: Array.from({ length: 20 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 95 : 5 })) });
const VIDEO = JSON.stringify({ actions: Array.from({ length: 20 }, (_, i) => ({ at: i * 1000, pos: i % 2 ? 60 : 40 })) });

let manager;
let gate;
let videoClock;
let videoEngine;
let sp;

const sent = (name) => h.sdk.sent(name).length;

beforeEach(async () => {
  h.sdk = createFakeHandySdk();
  h.uploads = [];
  manager = attachFakeCloud(new HandyManager(), h.sdk);
  await manager.init();
  expect(await manager.connect('TESTKEY01')).toBe(true);
  manager._stopHealthCheck();
  manager._hsspSpacingMs = 0;
  manager._setScriptSpacingMs = 0;

  gate = new DeviceGate();
  installDeviceGate(gate, 'handy', manager);

  // "The video": its own clock and engine on the REAL manager, as the app's.
  videoClock = new ScriptClock();
  videoClock.duration = 60;
  const videoScript = new FunscriptEngine({});
  await videoScript.loadContent(VIDEO, 'video.funscript');
  videoEngine = new SyncEngine({ videoPlayer: videoClock.asVideoPlayerWrapper(), handyManager: manager, funscriptEngine: videoScript });

  sp = new ScriptPlayer({
    gate,
    managers: { handy: manager },
    createFunscriptEngine: () => new FunscriptEngine({}),
    createEngines: ({ player, funscriptEngine, managers }) => ({
      handy: new SyncEngine({ videoPlayer: player, handyManager: managers.handy, funscriptEngine }),
    }),
    hooks: { beforeTakeover: () => { if (videoEngine._active) videoEngine.stop(); } },
  });
});

afterEach(async () => {
  videoClock.pause();
  if (sp.active) await sp.stop({ handBack: false });
  if (videoEngine._active) videoEngine.stop();
  manager._stopHealthCheck();
});

describe('the script player owns the Handy until ✕', () => {
  it('its script is uploaded and played; the video\'s play and upload reach nothing meanwhile', async () => {
    await sp.start({ name: 'loose.funscript', content: LOOSE });
    await vi.waitFor(() => expect(sent('hsspPlay')).toBeGreaterThan(0));
    expect(h.uploads).toHaveLength(1);
    expect(JSON.parse(h.uploads[0]).actions[1].pos).toBe(95);       // the loose script went up
    const scriptsSet = sent('setScript');
    const plays = sent('hsspPlay');

    // The user opens and plays a video: the app uploads its script and plays it.
    expect(await manager.uploadAndSetScript(VIDEO)).toBe(true);       // "done", for the app's code path
    videoEngine._scriptReady = true;
    videoEngine.start();
    await videoClock.play();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.uploads).toHaveLength(1);                                // the video's never left
    expect(sent('setScript')).toBe(scriptsSet);
    expect(sent('hsspPlay')).toBe(plays);
    expect(gate.blocked).toBeGreaterThan(0);

    // Pausing the video does not stop the device either: the script keeps playing.
    const stops = sent('hsspStop');
    videoClock.pause();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent('hsspStop')).toBe(stops);
  });

  it('✕: the script player\'s stop reaches the device, and then the video\'s upload does too', async () => {
    await sp.start({ name: 'loose.funscript', content: LOOSE });
    await vi.waitFor(() => expect(sent('hsspPlay')).toBeGreaterThan(0));
    const stops = sent('hsspStop');
    await sp.stop({ handBack: false });
    await vi.waitFor(() => expect(sent('hsspStop')).toBeGreaterThan(stops));
    expect(gate.closed).toBe(false);

    expect(await manager.uploadAndSetScript(VIDEO)).toBe(true);
    expect(h.uploads).toHaveLength(2);
    expect(JSON.parse(h.uploads[1]).actions[1].pos).toBe(60);       // the video's script is on the device now
  });

  it('without the gate (the hole), the video\'s upload would replace the loose script on the device', async () => {
    gate.open();                                                      // as if nothing guarded the devices
    await sp.start({ name: 'loose.funscript', content: LOOSE });
    gate.open();
    await manager.uploadAndSetScript(VIDEO);
    expect(h.uploads).toHaveLength(2);
  });
});
