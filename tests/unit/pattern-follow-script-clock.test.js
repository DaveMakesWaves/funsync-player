/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// pf-review PF-R1 (2026-11-19): X / Z "Follow the script" measure the script
// around NOW. With the player in its own window, a phone or a headset playing,
// this window's <video> is paused at the moment the session began and the
// engines run on that session's clock; the band was measured around the
// paused local element. Now it is the clock that drives playback.
//
// The REAL _reloadOrgasmScripts / _orgasmLibrarySource / _patternScriptRange /
// _orgasmFollowScriptNow / _edgePatternStart (lifted), a real
// RemotePlaybackProxy for the pop-out and the phone, a headset player wrapper
// as app.js builds it. No devices.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import {
  patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
} from '../../renderer/js/pattern-choice.js';
import { edgeHoldAction, clearPatternSourceCache } from '../../renderer/js/pattern-source.js';
import { parseFinisherActions, collectOrgasmScriptPaths } from '../../renderer/js/orgasm-plan.js';
import { normalizeAssociation } from '../../renderer/js/association-shape.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';

afterEach(() => { clearPatternSourceCache(); delete globalThis.window; });

const Lifted = liftAppClass(
  ['_reloadOrgasmScripts', '_orgasmLibrarySource', '_orgasmLibrarySettings', '_patternScriptRange',
    '_orgasmFollowScriptNow', '_edgePatternStart'],
  {
    patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround, edgeHoldAction,
    parseFinisherActions, collectOrgasmScriptPaths, normalizeAssociation,
    engageHandyFinisher: vi.fn(), OrgasmSwitch: class {},
  },
);

// High and narrow (70-90) for the first minute, the whole range after.
const SCRIPT = [];
for (let t = 0; t < 60000; t += 500) SCRIPT.push({ at: t, pos: (t / 500) % 2 ? 90 : 70 });
for (let t = 60000; t < 180000; t += 500) SCRIPT.push({ at: t, pos: (t / 500) % 2 ? 100 : 0 });

const X_STORE = {
  'player.orgasmSource': 'pattern',
  'player.orgasmPatternChoice': { id: 'shape-triangle', speed: 120, rangeMode: 'script', depthPct: 100 },
};

function makeApp(store) {
  const app = new Lifted();
  app.settings = { get: (k) => store[k] };
  app.funscriptEngine = { getAuthoredActions: () => SCRIPT, getActions: () => SCRIPT };
  // The local element, paused at 0:10 under the session (as the sessions leave it).
  app.videoPlayer = { video: { currentTime: 10, paused: true, duration: 180 } };
  app._refreshOrgasmPlan = vi.fn();
  app._getOrgasmEntry = vi.fn(() => null);
  app._recoverOrgasmPaths = vi.fn(async () => false);
  app._edgeLoop = { loadScript: vi.fn(() => true), activate: vi.fn() };
  app._pushRemoteEdgeState = vi.fn();
  globalThis.window = { funsync: { readFunscript: vi.fn(async () => null) } };
  return app;
}
const band = (actions) => [Math.min(...actions.map((a) => a.pos)), Math.max(...actions.map((a) => a.pos))];
const proxyAt = (ms) => {
  const p = new RemotePlaybackProxy();
  p.updateState({ at: ms, paused: false, duration: 180 });
  return p;
};

async function pressX(app) {
  await app._reloadOrgasmScripts();
  app._orgasmFollowScriptNow();
  return band(app._orgasmActionsCache.get(app._orgasmPatternKey));
}

describe('Follow the script reads the clock that drives playback (PF-R1)', () => {
  it('control: this window\'s own video at 0:10 gives the band around 0:10 (70-90)', async () => {
    expect(await pressX(makeApp(X_STORE))).toEqual([70, 90]);
  });

  it('the player in its own window at 2:00: X plays the band around 2:00 (0-100)', async () => {
    const app = makeApp(X_STORE);
    app._playerWindowActive = true;
    app._playerWinProxy = proxyAt(120000);
    expect(await pressX(app)).toEqual([0, 100]);
  });

  it('a phone at 2:00: X plays the band around 2:00', async () => {
    const app = makeApp(X_STORE);
    app._remoteActive = true;
    app._remoteProxy = proxyAt(120000);
    expect(await pressX(app)).toEqual([0, 100]);
  });

  it('the pop-out moving back to the start: the next press measures there', async () => {
    const app = makeApp({ ...X_STORE, 'player.orgasmPatternChoice': { ...X_STORE['player.orgasmPatternChoice'] } });
    app.videoPlayer.video.currentTime = 150;            // the local element paused in the wide part
    app._playerWindowActive = true;
    app._playerWinProxy = proxyAt(5000);                // the pop-out plays the narrow intro
    expect(await pressX(app)).toEqual([70, 90]);
  });

  it('a headset at 2:00: Z plays the band around 2:00', () => {
    const app = makeApp({
      'player.edgeHoldAction': 'pattern',
      'player.edgePatternChoice': { id: 'shape-triangle', speed: 120, rangeMode: 'script', depthPct: 100 },
    });
    const vrVideo = { currentTime: 120, paused: false, duration: 180 };
    app._vrPlayerRef = { video: vrVideo, get currentTime() { return vrVideo.currentTime; }, get paused() { return vrVideo.paused; } };
    expect(app._edgePatternStart()).toBe(true);
    expect(band(parseFinisherActions(app._edgeLoop.loadScript.mock.calls[0][0]))).toEqual([0, 100]);
  });
});
