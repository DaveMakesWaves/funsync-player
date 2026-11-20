// FT-017 (2026-11-05, new since v0.9.2): the Sync tab's "This video" row
// kept showing the last video after you left the player.
//
// `_videoSyncOffsetPath` falls back to `_currentVideoPath`, which Back never
// clears, and the row refreshed only on `videoSyncOffset:changed`, which a
// view change never sent. So after Back the library's Sync tab still offered
// "This video" for a video that was no longer playing, and − / + saved an
// offset for it. Now the state is null unless the video is really playing
// here (player view, docked mini player, pop-out player window, or a phone /
// headset session), and every view, mini-player and pop-out change re-reads
// the row.
//
// What runs is REAL: app.js's own `_navigateTo`, `_navigateBack`,
// `_onEnterView`, `_onLeaveView`, mini-player methods and sync-offset
// methods, lifted out of app.js, and a REAL ConnectionPanel built from the
// REAL options app.js hands it. Only the views' own components (library
// grid, nav bar, playback teardown) are stubs.
//
// jsdom (no docblock): ConnectionPanel builds DOM and i18n.js branches on
// `typeof window` (notes/CLAUDE.md "Test environments").
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { shouldEnterMiniplayer } from '../../renderer/js/miniplayer.js';
import { videoSyncOffsetOf } from '../../renderer/js/video-sync-offset.js';
import { liftAppClass, liftCtorOptions } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const A = 'C:\\Videos\\Alpha Scene.mp4';

const LiftedApp = liftAppClass([
  '_currentView', '_navigateTo', '_navigateBack', '_onEnterView', '_onLeaveView',
  '_shouldEnterMiniplayer', '_enterMiniplayer', '_clearMiniplayer', '_closeMiniplayer',
  '_videoSyncOffsetPath', '_videoSyncOffsetFor', '_applyVideoSyncOffset',
  '_videoSyncOffsetState', '_videoSyncOffsetLive', '_emitVideoSyncOffsetRowChanged',
  '_setVideoSyncOffset',
], {
  document,
  eventBus,
  shouldEnterMiniplayer,
  exitFullscreenForNav: () => {},
  videoSyncOffsetOf,
  withVideoSyncOffset: (map, path, ms) => ({ ...map, [path]: ms }),
  console: { log() {}, warn() {}, error() {}, debug() {} },
});

function fakeSettings(initial) {
  const store = { ...initial };
  return { store, get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }), getAll: () => ({}) };
}

function build({ miniPlayer = false } = {}) {
  document.body.innerHTML = `
    <div id="app">
      <div id="library-container"></div>
      <div id="player-container" hidden></div>
      <div id="playlists-container" hidden></div>
      <div id="categories-container" hidden></div>
    </div>`;
  const views = {
    library: document.getElementById('library-container'),
    player: document.getElementById('player-container'),
    playlists: document.getElementById('playlists-container'),
    categories: document.getElementById('categories-container'),
  };
  const video = { currentSrc: 'file:///C:/Videos/Alpha%20Scene.mp4', paused: false, ended: false, pause() { this.paused = true; } };
  const app = Object.assign(new LiftedApp(), {
    settings: fakeSettings({ 'player.miniPlayer': miniPlayer, 'library.syncOffsets': { [A]: -40 } }),
    videoPlayer: { video },
    _navStack: ['library'],
    _miniActive: false,
    _playerWindowActive: false,
    _currentVideoPath: null,
    _videoSyncOffsetMs: 0,
    _phoneSyncOffsetActive: false, _phoneSyncOffsetPath: null,
    _vrSyncOffsetActive: false, _vrSyncOffsetPath: null,
    // The views' own components: not under test.
    navBar: { show() {}, hide() {}, setActive() {} },
    library: { show() {}, hide() {} },
    playlists: { show() {}, hide() {}, navigateBack: () => false },
    categories: { show() {}, hide() {}, navigateBack: () => false },
    queuePanel: null,
    upNextCard: null,
    _getViewEl: (v) => views[v] || null,
    _syncCaptionOverlay() {}, _syncBackendBannerOffset() {},
    _refreshCollectionsUI: async () => {},
    _isOurVideoInPip: () => false,
    _beginDeferredPipTeardown() {},
    _teardownPlayback: vi.fn(),
    _updateMiniPlayPauseIcon() {},
    _planLazyRehome: () => null,
    // Disconnected devices: the panel hooks their callbacks, nothing is sent.
    handyManager: { connected: false }, buttplugManager: { connected: false, devices: [] },
    tcodeManager: { connected: false, listPorts: async () => [] }, autoblowManager: { connected: false },
    buttplugSync: null, tcodeSync: null, autoblowSync: null, vrBridge: null, audienceBridge: null,
  });
  // The REAL options app.js hands `new ConnectionPanel({...})`.
  const panel = new ConnectionPanel(liftCtorOptions('ConnectionPanel').call(app));
  app.connectionPanel = panel;
  panel.show();
  panel._switchTab('sync');
  return { app, panel, video };
}

/** What loadVideo does for a library video: the player view, then its delta. */
function openVideo(app, path) {
  app._currentVideoPath = path;
  app._navigateTo('player');
  app._applyVideoSyncOffset();
}

const section = (panel) => panel._panel.querySelector('#sync-video-offset-section');

beforeEach(() => { _setBundlesForTests('en', EN, EN); });
afterAll(() => { _setBundlesForTests('en', EN, EN); });

describe('Sync tab "This video" row follows what is really playing (FT-017)', () => {
  it('playing: shown; Back to the library with no mini player: state null and the section hidden', () => {
    const { app, panel } = build();
    expect(section(panel).hidden).toBe(true);
    openVideo(app, A);
    expect(app._videoSyncOffsetState()).toEqual({ path: A, ms: -40 });
    expect(section(panel).hidden).toBe(false);

    app._navigateBack();
    expect(app._currentView()).toBe('library');
    expect(app._teardownPlayback).toHaveBeenCalled();
    expect(app._videoSyncOffsetState()).toBeNull();
    expect(section(panel).hidden).toBe(true);
    // Only the row went: the saved offset and the applied delta are as they were.
    expect(app.settings.store['library.syncOffsets']).toEqual({ [A]: -40 });
    expect(app._videoSyncOffsetMs).toBe(-40);
    panel.hide?.();
  });

  it('a top-level nav click (Playlists) from the player hides it too', () => {
    const { app, panel } = build();
    openVideo(app, A);
    app._navigateTo('playlists');
    expect(app._videoSyncOffsetState()).toBeNull();
    expect(section(panel).hidden).toBe(true);
    panel.hide?.();
  });

  it('with the mini player on, the row stays while it plays in the corner, and goes when the mini player is closed', () => {
    const { app, panel } = build({ miniPlayer: true });
    openVideo(app, A);
    app._navigateBack();
    expect(app._miniActive).toBe(true);
    expect(app._videoSyncOffsetState()).toEqual({ path: A, ms: -40 });
    expect(section(panel).hidden).toBe(false);

    app._closeMiniplayer();
    expect(app._videoSyncOffsetState()).toBeNull();
    expect(section(panel).hidden).toBe(true);
    panel.hide?.();
  });

  it('coming back to the player shows it again', () => {
    const { app, panel } = build();
    openVideo(app, A);
    app._navigateBack();
    expect(section(panel).hidden).toBe(true);
    app._navigateTo('player');
    expect(section(panel).hidden).toBe(false);
    panel.hide?.();
  });

  it('a phone or headset session keeps its own row whatever the view', () => {
    const { app, panel } = build();
    app._phoneSyncOffsetActive = true;
    app._phoneSyncOffsetPath = A;
    app._applyVideoSyncOffset();
    expect(app._currentView()).toBe('library');
    expect(app._videoSyncOffsetState()).toEqual({ path: A, ms: -40 });
    expect(section(panel).hidden).toBe(false);
    panel.hide?.();
  });

  it('the pop-out player window counts as playing here', () => {
    const { app } = build();
    app._currentVideoPath = A;
    app._applyVideoSyncOffset();
    expect(app._videoSyncOffsetState()).toBeNull();          // library, nothing playing here
    app._playerWindowActive = true;
    expect(app._videoSyncOffsetState()).toEqual({ path: A, ms: -40 });
  });
});
