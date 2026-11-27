/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL index.html body, the REAL Devices panel, nav
 * bar, Settings panel and first-launch prompt render into a document, and
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// A live language switch must not put back the boot text of anything a
// component sets from state (app test V69).
//
// setLocale() emitted `language:changed` and resolved; both callers (Settings
// > Appearance and the first-launch prompt) then ran translatePage(document).
// That walk sets every `data-i18n` element to its STATIC key, which only
// knows the boot text. The Devices panel's handler had just re-drawn a
// connected Handy as "Verbunden" / "Trennen"; the walk turned it back into
// "Nicht verbunden" / "Verbinden" until the next status change. Same for the
// Buttplug, T-Code and Autoblow tabs, and for the player's "Loop video" value.
//
// Now setLocale() walks first and emits after, and no caller walks again, so
// a component's handler always has the last word. These tests drive the REAL
// switch (the real select / the real prompt button, the real setLocale
// loading the real locale files) and assert what the user reads afterwards.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { setLocale, getCurrentLocale, _resetForTests, _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { NavBar } from '../../renderer/components/nav-bar.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { openLanguagePromptModal } from '../../renderer/components/language-prompt-modal.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';
import { BackendBannerState } from '../../renderer/js/backend-banner-state.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import * as AUDIENCE from '../../renderer/js/audience-popout-protocol.js';
import { liftAppClass } from './helpers/app-methods.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');
const ES = bundle('es');

// The real index.html body: the static data-i18n keys the walk uses. Scripts
// inserted through innerHTML never run.
const INDEX_BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(fs.readFileSync('renderer/index.html', 'utf8'))[1];

// setLocale() fetches `../locales/<l>.json` relative to i18n.js; serve the
// real files.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = async (url) => {
    const m = /locales\/(\w+)\.json$/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, json: async () => bundle(m[1]) };
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
  _setBundlesForTests('en', EN, EN);
});

let closeModal = null;
beforeEach(async () => {
  // Each test builds its own components; one left subscribed by an earlier
  // test (a lifted app with the pop-out open) must not answer this one's switch.
  eventBus.removeAll('language:changed');
  _resetForTests();
  await setLocale('en');
  document.body.innerHTML = INDEX_BODY;
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});
afterEach(async () => {
  // Close the Settings modal so its language:changed subscription goes.
  document.querySelector('.settings-panel__done-btn')?.click();
  if (closeModal) await closeModal;
  closeModal = null;
});

const settingsFake = () => {
  const values = new Map([['player.language', 'en']]);
  return { get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) };
};

/** A Devices panel with all four families connected through their real callbacks. */
function connectedDevicesPanel() {
  const handy = {
    connected: false, responsive: true, slow: false,
    deviceInfo: { fwVersion: '4.2.1', model: 'H2', fwStatus: 0 },
    setOffset: async () => {}, setStrokeZone: async () => {}, on() {}, off() {},
  };
  const buttplug = { connected: false, devices: [] };
  const tcodeManager = { connected: false, setPrecision() {}, listPorts: async () => [] };
  const autoblowManager = { connected: false, deviceType: null };
  const panel = new ConnectionPanel({
    handyManager: handy, buttplugManager: buttplug, tcodeManager, autoblowManager, settings: settingsFake(),
  });
  for (const m of [handy, buttplug, tcodeManager, autoblowManager]) {
    m.connected = true;
    m.onConnect();
  }
  return { panel, handy };
}

const text = (sel) => document.querySelector(sel)?.textContent.trim();

/** What a connected Devices panel says, in a dictionary. */
const connectedTexts = (D) => ({
  handyStatus: D.connection.status.connected,
  handyBtn: D.connection.btn.disconnect,
  bpStatus: D.connection.status.connectedToIntiface,
  bpBtn: D.connection.btn.disconnect,
  tcodeStatus: D.connection.status.connected,
  tcodeBtn: D.connection.btn.disconnect,
  abStatus: D.connection.status.connected,
  abBtn: D.connection.btn.disconnect,
});
const shownTexts = () => ({
  handyStatus: text('#connection-status-text'),
  handyBtn: text('#btn-connect'),
  bpStatus: text('#bp-connection-status-text'),
  bpBtn: text('#btn-bp-connect'),
  tcodeStatus: text('#tcode-status-text'),
  tcodeBtn: text('#tcode-connect-btn'),
  abStatus: text('#ab-status-text'),
  abBtn: text('#ab-connect-btn'),
});

/** Settings > Appearance > Language, exactly as a user picks it. */
async function switchInSettings(locale) {
  closeModal = new SettingsPanel({ settings: settingsFake() }).show();
  document.querySelector('.settings-panel__rail-item[data-area="appearance"]').click();
  const select = document.querySelector('[data-setting="player.language"]');
  select.value = locale;
  select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(getCurrentLocale()).toBe(locale));
  // Let the change handler finish whatever it does after setLocale resolves.
  await new Promise((r) => setTimeout(r, 0));
}

describe('a live language switch keeps what components set from state (V69)', () => {
  it('Settings: every connected device tab still says connected, in the new language', async () => {
    connectedDevicesPanel();
    expect(shownTexts()).toEqual(connectedTexts(EN));

    await switchInSettings('de');

    expect(shownTexts()).toEqual(connectedTexts(DE));
    // T-Code's port list, drawn by the scan at build time (no ports here).
    expect(text('#tcode-port-select option[value=""]')).toBe(DE.connection.tcode.noPorts);
  });

  it('first-launch prompt: same, through its language button', async () => {
    connectedDevicesPanel();
    const done = openLanguagePromptModal({ settings: settingsFake() });
    document.querySelector('.language-prompt__btn[data-locale="de"]').click();
    await done;
    await new Promise((r) => setTimeout(r, 0));

    expect(getCurrentLocale()).toBe('de');
    expect(shownTexts()).toEqual(connectedTexts(DE));
  });

  it('a Handy that is not responding still says so, with its Reconnect button', async () => {
    const { handy } = connectedDevicesPanel();
    handy.responsive = false;
    handy.onResponsivenessChange(false);
    expect(text('#connection-status-text')).toBe(EN.connection.status.notResponding);

    await switchInSettings('de');

    // Re-deriving from `connected` alone made this "Verbunden" and hid the
    // Reconnect button the user needs.
    expect(text('#connection-status-text')).toBe(DE.connection.status.notResponding);
    expect(document.querySelector('#btn-reconnect').hidden).toBe(false);
    expect(text('#btn-connect')).toBe(DE.connection.btn.disconnect);
  });

  it('a Handy that failed to connect still says it failed', async () => {
    const { panel, handy } = connectedDevicesPanel();
    handy.connected = false;
    panel._updateStatus('error');
    expect(text('#connection-status-text')).toBe(EN.connection.status.failed);

    await switchInSettings('de');

    expect(text('#connection-status-text')).toBe(DE.connection.status.failed);
    expect(text('#btn-connect')).toBe(DE.connection.btn.connect);
  });

  it('a T-Code or Autoblow connect that failed reads "Not connected", before and after a switch', async () => {
    const tcodeManager = {
      connected: false, setPrecision() {}, listPorts: async () => [{ path: 'COM3' }],
      connect: vi.fn(async () => false), // what a refused port / bad token returns
    };
    const autoblowManager = { connected: false, deviceType: null, connect: vi.fn(async () => false) };
    new ConnectionPanel({
      handyManager: { connected: false, setOffset: async () => {}, setStrokeZone: async () => {}, on() {}, off() {} },
      buttplugManager: { connected: false, devices: [] },
      tcodeManager, autoblowManager, settings: settingsFake(),
    });
    await vi.waitFor(() => expect(document.querySelector('#tcode-port-select option[value="COM3"]')).not.toBeNull());
    document.querySelector('#tcode-port-select').value = 'COM3';
    document.querySelector('#tcode-connect-btn').click();
    document.querySelector('#ab-token-input').value = 'tok';
    document.querySelector('#ab-connect-btn').click();
    await vi.waitFor(() => {
      expect(tcodeManager.connect).toHaveBeenCalled();
      expect(autoblowManager.connect).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));
    // Nothing wires onError for these two, so they stayed on "Connecting…".
    expect(text('#tcode-status-text')).toBe(EN.connection.status.notConnected);
    expect(text('#ab-status-text')).toBe(EN.connection.status.notConnected);

    await switchInSettings('de');

    expect(text('#tcode-status-text')).toBe(DE.connection.status.notConnected);
    expect(text('#ab-status-text')).toBe(DE.connection.status.notConnected);
    expect(document.querySelector('#tcode-led').classList.contains('connection-panel__led--connecting')).toBe(false);
    expect(document.querySelector('#ab-led').classList.contains('connection-panel__led--connecting')).toBe(false);
  });

  it('the nav-bar device label follows too', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const bar = new NavBar({ onNavigate: () => {} });
    bar.init(host);
    bar.setDeviceStatus({ devices: [{ label: 'The Handy', state: 'unresponsive' }] });

    await switchInSettings('de');

    expect(getCurrentLocale()).toBe('de');
    expect(host.querySelector('.nav-bar__handy-text').textContent).toBe('The Handy reagiert nicht');
    expect(host.querySelector('.nav-bar__handy').title).toBe('The Handy · ' + DE.nav.notResponding);
  });
});

describe('player chrome app.js owns (V69 / V50)', () => {
  const PLAYER = [
    '_wirePlayerChromeLanguage', '_retranslatePlayerChrome', '_updatePlayerSyncChip',
    '_computeSyncChipState', '_getConnectedDeviceCount', '_updatePlayerWindowButton',
  ];

  function liftedApp({ loop }) {
    const App = liftAppClass(PLAYER, { document, t, eventBus, PLAYERWIN });
    const app = new App();
    app.videoPlayer = { video: { loop, paused: false, ended: false } };
    app.handyManager = { connected: true };
    app.funscriptEngine = { isLoaded: true };
    app._currentVideoPath = 'C:/v/clip.mp4';
    app._wirePlayerChromeLanguage();
    // What the app has painted by the time the user opens Settings: the
    // Loop value (_wireLoopVideo), the sync chip, the badge's script tooltip.
    document.getElementById('loop-video-state').textContent = loop ? t('player.loopVideo.stateOn') : t('player.loopVideo.stateOff');
    app._updatePlayerSyncChip();
    const badge = document.getElementById('funscript-badge');
    badge.setAttribute('aria-label', t('app.openScriptEditor'));
    badge.title = 'clip.funscript — 412 actions, 3:20';
    badge.hidden = false;
    return app;
  }

  it('"Loop video" still reads On with loop on', async () => {
    liftedApp({ loop: true });
    expect(text('#loop-video-state')).toBe(EN.player.loopVideo.stateOn);

    await switchInSettings('de');

    // The static key is the Off string; the walk alone said "Aus".
    expect(text('#loop-video-state')).toBe(DE.player.loopVideo.stateOn);
  });

  it('the sync chip and the funscript badge follow, and the badge keeps its script tooltip', async () => {
    liftedApp({ loop: false });
    expect(text('#player-sync-chip-text')).toBe(EN.syncChip.syncing);

    await switchInSettings('de');

    expect(text('#player-sync-chip-text')).toBe(DE.syncChip.syncing);
    const badge = document.getElementById('funscript-badge');
    expect(badge.getAttribute('aria-label')).toBe(DE.app.openScriptEditor);
    expect(badge.title).toBe('clip.funscript — 412 actions, 3:20');
    expect(text('#loop-video-state')).toBe(DE.player.loopVideo.stateOff);
  });

  it('the transport buttons keep Pause / Unmute for a playing, muted video', async () => {
    const app = liftedApp({ loop: false });
    const video = document.getElementById('video');
    let playing = false;
    // jsdom implements no playback: `paused` is always true.
    Object.defineProperty(video, 'paused', { configurable: true, get: () => !playing });
    app.videoPlayer = new VideoPlayer({
      videoElement: video,
      controlsElement: document.getElementById('controls'),
      containerElement: document.getElementById('player-container'),
    });
    playing = true;
    video.dispatchEvent(new Event('play'));
    app.videoPlayer.toggleMute();
    expect(document.getElementById('btn-mute').getAttribute('aria-label')).toBe(EN.player.unmute);

    await switchInSettings('es');

    // Static keys: Mute and Play. The title has none, so it stayed English.
    expect(document.getElementById('btn-mute').getAttribute('aria-label')).toBe(ES.player.unmute);
    expect(document.getElementById('btn-play').getAttribute('aria-label')).toBe(ES.player.pause);
    expect(document.getElementById('btn-play').title).toBe(ES.player.pauseTitle);
    expect(document.getElementById('center-play-btn').getAttribute('aria-label')).toBe(ES.player.pause);
  });

  it('with the player popped out: the menu still says Pop in, and the pop-out is handed the new locale', async () => {
    const relayed = [];
    window.funsync.playerPopoutRelay = (dir, payload) => relayed.push({ dir, payload });
    const app = liftedApp({ loop: false });
    app._playerWindowOpen = true;
    app._updatePlayerWindowButton(); // what the 'opened' event does
    expect(text('#btn-popout-player span')).toBe(EN.player.popIn);

    await switchInSettings('de');

    // Static key: "Pop out player".
    expect(text('#btn-popout-player span')).toBe(DE.player.popIn);
    expect(document.getElementById('btn-popout-player').getAttribute('aria-label')).toBe(DE.player.popIn);
    // Nothing told the pop-out before: it stayed English until reopened.
    expect(relayed).toContainEqual({ dir: 'to-popout', payload: PLAYERWIN.makeMessage(PLAYERWIN.LOCALE, { locale: 'de' }) });
  });

  it('no pop-out open, no locale message', async () => {
    const relayed = [];
    window.funsync.playerPopoutRelay = (dir, payload) => relayed.push(payload);
    const app = liftedApp({ loop: false });
    app._playerWindowOpen = false;

    await switchInSettings('de');

    expect(relayed.filter((m) => m.type === PLAYERWIN.LOCALE)).toEqual([]);
  });
});

describe('the backend banner keeps its guidance across a switch (V69)', () => {
  // Mirrors BACKEND_MISSING in app.js and electron/python-bridge.js.
  const BACKEND_MISSING = 'backend-executable-missing';
  let pushStatus = null;
  let finishRestart = null;

  function liftedBanner() {
    const App = liftAppClass(['_initBackendBanner'], {
      document, t, eventBus, BackendBannerState, BACKEND_MISSING, showToast: () => {},
    });
    window.funsync.onBackendStatus = (cb) => { pushStatus = cb; };
    window.funsync.getBackendHealth = async () => ({ state: 'unknown' });
    window.funsync.openLogFile = async () => ({ success: true });
    window.funsync.restartBackend = () => new Promise((r) => { finishRestart = () => r({ success: true }); });
    new App()._initBackendBanner();
  }
  const banner = () => document.getElementById('backend-banner');

  it('a missing backend still says it is missing (no Restart), in the new language', async () => {
    liftedBanner();
    // main sends this once, on the transition; a missing exe never transitions again.
    pushStatus({ state: 'down', detail: BACKEND_MISSING });
    expect(text('#backend-banner-title')).toBe(EN.backend.missingTitle);

    await switchInSettings('de');

    // Static keys: "not responding … try Restart below", with Restart hidden.
    expect(text('#backend-banner-title')).toBe(DE.backend.missingTitle);
    expect(text('#backend-banner-detail')).toBe(DE.backend.missingDetail);
    expect(document.getElementById('backend-banner-restart').hidden).toBe(true);
    expect(banner().hidden).toBe(false);
  });

  it('a backend that is down keeps its error text', async () => {
    liftedBanner();
    pushStatus({ state: 'down', detail: 'exit code 3' });

    await switchInSettings('de');

    expect(text('#backend-banner-title')).toBe(DE.backend.title);
    expect(text('#backend-banner-detail')).toBe(t('backend.detailWithError', { error: 'exit code 3' }));
    expect(text('#backend-banner-detail')).toContain('exit code 3');
  });

  it('a Restart in flight still says restarting', async () => {
    liftedBanner();
    pushStatus({ state: 'down', detail: null });
    document.getElementById('backend-banner-restart').click();
    expect(text('#backend-banner-restart')).toBe(EN.backend.restarting);

    await switchInSettings('de');

    // Static key: "Restart Backend".
    expect(text('#backend-banner-restart')).toBe(DE.backend.restarting);
    // Words only: re-running the status render here would re-enable the
    // button mid-restart (the status is still 'down' until main says
    // 'restarting').
    expect(document.getElementById('backend-banner-restart').disabled).toBe(true);
    finishRestart();
    await new Promise((r) => setTimeout(r, 0));
    expect(text('#backend-banner-restart')).toBe(DE.backend.restart);
  });

  it('a dismissed banner stays dismissed (the switch repaints words, not visibility)', async () => {
    liftedBanner();
    pushStatus({ state: 'down', detail: BACKEND_MISSING });
    document.getElementById('backend-banner-dismiss').click();
    expect(banner().hidden).toBe(true);

    await switchInSettings('es');

    expect(banner().hidden).toBe(true);
    expect(text('#backend-banner-title')).toBe(ES.backend.missingTitle);
  });
});

describe('the audience pop-out hears about a switch (V50)', () => {
  it('main re-sends its full state with the new locale (the pop-out takes its locale only from that)', async () => {
    const relayed = [];
    window.funsync.onAudiencePopoutEvent = () => {};
    window.funsync.audiencePopoutRelay = (dir, payload) => relayed.push({ dir, payload });
    const App = liftAppClass(
      ['_wireAudiencePopoutRelay', '_pushAudienceMessage', '_pushAudienceInitialState'],
      { eventBus, AUDIENCE, t, showToast: () => {}, document },
    );
    const app = new App();
    // The app's own settings: the first-launch prompt saves the language only
    // after setLocale resolves, so it can still say 'en' here.
    app.settings = settingsFake();
    app.audienceBridge = { roomActive: true, viewers: [{ key: 'k1', label: 'Sam', status: 'synced' }] };
    app._wireAudiencePopoutRelay();

    await switchInSettings('de');

    const sent = relayed.filter((r) => r.dir === 'to-popout' && r.payload.type === AUDIENCE.INITIAL_STATE);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ locale: 'de', roomActive: true, viewers: app.audienceBridge.viewers });
  });
});
