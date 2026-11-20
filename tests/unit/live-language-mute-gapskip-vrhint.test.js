/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL VideoPlayer is built on the real index.html
 * controls, setLocale() walks that document, and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Three main-window texts that stayed in one language (all also in v0.9.2):
//
// FT-064: the mute button's tooltip was index.html's static English
//   "Mute (M)", muted or not, in every language. _updateMuteButton set only
//   the aria-label; it sets the title too now (player.muteTitle /
//   player.unmuteTitle), and refreshLabels() runs it on a language switch.
// FT-065: the gap-skip button in button mode (no countdown) kept the old
//   language, or worse: setLocale()'s walk put the button's boot key back
//   ("Skip to next action") over a "Skip to action" label, and nothing redrew
//   it until the next gap. It is redrawn from the engine's state on
//   language:changed now, after the walk.
// FT-062: the VR timestamp-server hint toast was an English literal
//   (toast.vrTimestampServerHint / toast.vrQuestIpUnknown now).
//
// Asserted on what the user reads and hovers: the real locale files, the real
// setLocale() and walk, the REAL VideoPlayer, the REAL GapSkipEngine and the
// REAL app.js methods (lifted).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { setLocale, _resetForTests, _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';
import { GapSkipEngine } from '../../renderer/js/gap-skip.js';
import { liftAppClass } from './helpers/app-methods.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');
const FR = bundle('fr');
const ES = bundle('es');

const INDEX_BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(fs.readFileSync('renderer/index.html', 'utf8'))[1];
const $ = (id) => document.getElementById(id);

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

beforeEach(async () => {
  eventBus.removeAll('language:changed');
  _resetForTests();
  await setLocale('en');
  document.body.innerHTML = INDEX_BODY;
});

describe('the mute button\'s tooltip is in the active language and names the state (FT-064)', () => {
  const makePlayer = () => new VideoPlayer({
    videoElement: $('video'),
    controlsElement: $('controls'),
    containerElement: $('player-container'),
  });

  it('German: the mute title, then the unmute title once muted; French after a switch', async () => {
    await setLocale('de');
    const player = makePlayer();
    player.setVolume(0.8); // what app.js does at boot with the saved volume
    expect(DE.player.muteTitle).toBeTruthy();
    expect($('btn-mute').title).toBe(DE.player.muteTitle);
    expect($('btn-mute').title).not.toBe('Mute (M)');

    player.toggleMute();
    expect($('btn-mute').title).toBe(DE.player.unmuteTitle);
    expect($('btn-mute').getAttribute('aria-label')).toBe(DE.player.unmute);

    // The language switch path (app.js _retranslatePlayerChrome → refreshLabels).
    await setLocale('fr');
    player.refreshLabels();
    expect($('btn-mute').title).toBe(FR.player.unmuteTitle);
    player.toggleMute();
    expect($('btn-mute').title).toBe(FR.player.muteTitle);
  });

  it('English keeps the old words', () => {
    const player = makePlayer();
    player.setVolume(0.5);
    expect($('btn-mute').title).toBe('Mute (M)');
    player.toggleMute();
    expect($('btn-mute').title).toBe('Unmute (M)');
  });
});

describe('the gap-skip button follows a language switch (FT-065)', () => {
  // A 60 s video whose script starts at 20 s: 0..20 s is a leading gap.
  const ACTIONS = [{ at: 20000, pos: 0 }, { at: 21000, pos: 100 }, { at: 22000, pos: 0 }, { at: 60000, pos: 50 }];
  function wire(mode) {
    const App = liftAppClass(['_wireGapSkipUI'], { t, eventBus, showToast: () => null });
    const app = new App();
    app.settings = { get: (k) => (k === 'player.gapSkip' ? { mode, threshold: 10000 } : undefined) };
    app._applyFillerSettings = () => {};
    const player = { duration: 60, currentTime: 5, paused: false };
    app.gapSkipEngine = new GapSkipEngine({
      videoPlayer: player,
      funscriptEngine: { isLoaded: true, getActions: () => ACTIONS },
    });
    app._wireGapSkipUI();
    return app.gapSkipEngine;
  }

  it('button mode (no countdown): the label is redrawn in the new language, for the gap it is', async () => {
    const engine = wire('button');
    engine._check(); // the playhead is in the leading gap
    expect($('gap-skip-overlay').hidden).toBe(false);
    expect($('gap-skip-btn').textContent).toBe(EN.gapSkip.skipToAction);

    await setLocale('de');
    expect($('gap-skip-btn').textContent).toBe(DE.gapSkip.skipToAction);
    await setLocale('es');
    expect($('gap-skip-btn').textContent).toBe(ES.gapSkip.skipToAction);
    engine.stop();
  });

  it('a countdown running: the next text is the new language at once', async () => {
    const engine = wire('auto');
    engine._check();
    try {
      expect($('gap-skip-btn').textContent).toBe(`${EN.gapSkip.skipToAction} in 5...`);
      await setLocale('de');
      expect($('gap-skip-btn').textContent).toBe(
        DE.gapSkip.countdown.replace('{label}', DE.gapSkip.skipToAction).replace('{seconds}', '5'));
    } finally {
      engine.stop();
    }
  });

  it('hidden: a switch leaves it alone', async () => {
    const engine = wire('button');
    expect($('gap-skip-overlay').hidden).toBe(true);
    await setLocale('de');
    // The walk's text, untouched by the handler (nothing on screen to redraw).
    expect($('gap-skip-btn').textContent).toBe(DE.player.skipToNextAction);
    engine.stop();
  });
});

describe('the VR timestamp-server hint is in the active language (FT-062)', () => {
  function showHint(err, ip) {
    const toasts = [];
    const App = liftAppClass(['_maybeShowTimestampServerHint'], {
      t,
      showToast: (message, type, duration) => { toasts.push({ message, type, duration }); return { dismiss() {} }; },
    });
    const app = new App();
    app.settings = { get: () => undefined };
    app.vrBridge = { host: null, connect: async () => false };
    app._maybeShowTimestampServerHint(err, ip);
    return toasts;
  }
  const textOf = (toast) => toast.message.querySelector('div').textContent;

  it('German, with the Quest\'s IP and the literal port', async () => {
    await setLocale('de');
    const [toast] = showHint('connect ECONNREFUSED 192.168.1.5:23554', '192.168.1.5');
    expect(DE.toast.vrTimestampServerHint).toBeTruthy();
    expect(textOf(toast)).toBe(DE.toast.vrTimestampServerHint.replace('{ip}', '192.168.1.5'));
    expect(textOf(toast)).toContain('23554');
    expect(textOf(toast)).not.toBe(EN.toast.vrTimestampServerHint.replace('{ip}', '192.168.1.5'));
    expect(toast.message.querySelector('button').textContent).toBe(DE.toast.tryAgain);
    expect(toast.type).toBe('warn');
    expect(toast.duration).toBe(0);
  });

  it('German, IP unknown: the localised stand-in fills the slot', async () => {
    await setLocale('de');
    const [toast] = showHint('connect ECONNREFUSED 10.0.0.2:23554', null);
    expect(textOf(toast)).toBe(DE.toast.vrTimestampServerHint.replace('{ip}', DE.toast.vrQuestIpUnknown));
  });

  it('English reads as before, with the IP', () => {
    const [toast] = showHint('connect ECONNREFUSED 192.168.1.5:23554', '192.168.1.5');
    expect(textOf(toast)).toBe("VR companion can't reach HereSphere's timestamp server. "
      + 'On the Quest: HereSphere → Settings → Timestamp Server. '
      + "Make sure it's enabled, then press the auto-find button next to the IP field — your Quest's IP is 192.168.1.5 and the port should be 23554. "
      + "If that doesn't help, toggle the timestamp server off and back on to force a re-init.");
  });

  it('only for ECONNREFUSED on 23554', () => {
    expect(showHint('getaddrinfo ENOTFOUND quest', '192.168.1.5')).toEqual([]);
  });
});
