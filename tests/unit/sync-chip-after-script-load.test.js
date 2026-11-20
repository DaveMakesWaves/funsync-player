// Block F verify-1 (2026-11-16, cosmetic, also in v0.9.2): the player's
// top-bar sync chip read "No script" on a just-opened, paused video whose
// script was loaded (the badge beside it said loaded, `_computeSyncChipState`
// said Ready / Syncing). The chip was refreshed only on play / pause / ended
// and on a device change, and a video opened paused (Up Next with autoplay
// off, a reload) had none of those after its script loaded. It now follows
// the script badge: whenever a script is shown as loaded (a video's own, a
// companion standing in, a variation picked), the chip is refreshed too.
//
// The REAL app.js methods (lifted) on a real DOM. jsdom (no docblock): the
// methods read the document.
import { describe, it, expect, beforeEach } from 'vitest';
import { APP_SRC, liftMethod } from './helpers/app-methods.js';

const METHODS = ['_showFunscriptBadge', '_updatePlayerSyncChip', '_computeSyncChipState', '_getConnectedDeviceCount'];
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
const icon = () => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
// eslint-disable-next-line no-new-func
const Lifted = new Function('t', 'icon', 'FileCheck',
  `return class { ${METHODS.map((n) => liftMethod(APP_SRC, n)).join('\n\n')} };`,
)(t, icon, {});

let app;
const chipText = () => document.getElementById('player-sync-chip-text').textContent;
const chipState = () => document.getElementById('player-sync-chip').dataset.state;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="funscript-badge" hidden></div>
    <div id="player-sync-chip" hidden><span id="player-sync-chip-text"></span></div>`;
  app = Object.assign(new Lifted(), {
    _currentVideoPath: 'C:/v/Clip.mp4',
    _currentVideoName: 'Clip.mp4',
    // A paused video, the Handy connected; its script is still loading.
    videoPlayer: { video: { paused: true, ended: false } },
    handyManager: { connected: true },
    buttplugManager: null, tcodeManager: null, autoblowManager: null,
    buttplugSync: null, tcodeSync: null, autoblowSync: null,
    funscriptEngine: { isLoaded: false },
    _currentCustomRoutes: null, _currentMultiAxis: null,
    getEmbeddedAxes: () => null,
  });
});

describe('the sync chip follows the script badge', () => {
  it('opened paused: once the script loads, the chip says Ready, not "No script"', () => {
    app._updatePlayerSyncChip();   // the device connected before the script
    expect(chipText()).toBe('syncChip.noScript');
    app.funscriptEngine.isLoaded = true;
    app._showFunscriptBadge({ filename: 'Clip.funscript', actionCount: 361, durationFormatted: '3:12' });
    expect(document.getElementById('funscript-badge').hidden).toBe(false);
    expect(chipText()).toBe('syncChip.ready');
    expect(chipState()).toBe('ready');
  });

  it('with no device, the refresh says so (the chip is not simply set to Ready)', () => {
    app.handyManager = null;
    app.funscriptEngine.isLoaded = true;
    app._showFunscriptBadge({ filename: 'Clip.funscript', actionCount: 361, durationFormatted: '3:12' });
    expect(chipText()).toBe('syncChip.noDevices');
  });
});
