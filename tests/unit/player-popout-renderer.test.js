/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its VideoPlayer, ProgressBar and
 * controls on the DOM of player-popout.html at import time.
 */
// The detached player window's own renderer, as main talks to it.
//
//   V17  it opened at full volume with loop off: SET_VOLUME ignored `muted`,
//        and there was no way to hand it the loop flag. It also sent READY
//        twice (from 'opened' and from its i18n init), so main sent the
//        state and the video twice on every open.
//   V13  main's volume keys need the pop-out's real volume to step from: it
//        now reports every volume change up as a VIDEO_EVENT.
//
// Assertions are on the DOM a user sees and the messages main receives.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  // Scripts are imported below, not executed from the markup.
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = []; // messages the pop-out sent to main
let onEvent = null;
const $ = (id) => document.getElementById(id);
const video = () => $('video');
const fromMain = (type, fields) => onEvent({ type: 'message', payload: PLAYERWIN.makeMessage(type, fields) });
const readies = () => up.filter((m) => m.type === PLAYERWIN.READY).length;

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  // jsdom implements no media playback.
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  window.funsync = {
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-parent') up.push(payload); },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
  };
  await import('../../renderer/player-popout.js');
  // Main's 'opened' (sent from did-finish-load) can land before the player
  // is built; a READY then would have its LOAD_VIDEO dropped.
  onEvent({ type: 'opened' });
  await until(() => readies() > 0);
}, 20000);

describe('V17: the pop-out says READY once, when it can take a video', () => {
  it('one READY, however many times main says the window opened', async () => {
    onEvent({ type: 'opened' });
    await new Promise((r) => setTimeout(r, 20));
    expect(readies()).toBe(1);
  });
});

describe('V17: it takes the volume, mute and loop main hands it', () => {
  it('SET_VOLUME sets the volume AND the mute (button included)', () => {
    fromMain(PLAYERWIN.SET_VOLUME, { volume: 0.4, muted: true });
    expect(video().volume).toBeCloseTo(0.4);
    expect(video().muted).toBe(true);
    expect($('btn-mute').getAttribute('aria-label')).toMatch(/unmute/i);

    fromMain(PLAYERWIN.SET_VOLUME, { volume: 0.4, muted: false });
    expect(video().muted).toBe(false);
    expect($('btn-mute').getAttribute('aria-label')).not.toMatch(/unmute/i);
  });

  it('SET_LOOP loops the video and shows it (chip + menu)', () => {
    fromMain(PLAYERWIN.SET_LOOP, { loop: true });
    expect(video().loop).toBe(true);
    expect($('loop-chip').hidden).toBe(false);
    expect($('btn-loop-video').getAttribute('aria-checked')).toBe('true');

    fromMain(PLAYERWIN.SET_LOOP, { loop: false });
    expect(video().loop).toBe(false);
    expect($('loop-chip').hidden).toBe(true);
  });
});

describe('V13: main can step the pop-out\'s volume and speed from the real values', () => {
  it('every volume change is reported up', () => {
    up.length = 0;
    video().volume = 0.25;
    video().dispatchEvent(new Event('volumechange')); // what the element fires
    expect(up).toContainEqual({ type: 'video-event', event: 'volumechange', volume: 0.25, muted: false });
  });

  it('a speed set from main shows on the speed chip', () => {
    fromMain(PLAYERWIN.SET_RATE, { rate: 1.5 });
    video().dispatchEvent(new Event('ratechange'));
    expect($('speed-chip').hidden).toBe(false);
    expect($('speed-chip-label').textContent).toBe('1.5×');
  });

  it('a speed change while paused is reported up at once (no ticks stream while paused)', () => {
    up.length = 0;
    expect(video().paused).toBe(true);
    video().playbackRate = 1.75; // its own speed menu, or a SET_RATE from main
    video().dispatchEvent(new Event('ratechange')); // what the element fires
    const ticks = up.filter((m) => m.type === PLAYERWIN.TIME_TICK);
    expect(ticks.at(-1)).toMatchObject({ rate: 1.75, paused: true });
  });
});

describe('#381: the HM playhead marker follows the main window\'s setting', () => {
  // The pop-out reuses InlineViz; main hands it the setting in INITIAL_STATE.
  const marker = () => document.querySelector('.inline-viz__hm-playhead');
  const actions = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];

  it('shows the marker on the HM strip when the setting is on, and not when it is off', () => {
    fromMain(PLAYERWIN.INITIAL_STATE, { inlineViz: { timeline: false, heatmap: true, playhead: true } });
    fromMain(PLAYERWIN.HEATMAP, { actions, durationMs: 4000 });
    expect(marker()).not.toBeNull();
    expect(marker().hidden).toBe(false);

    fromMain(PLAYERWIN.INITIAL_STATE, { inlineViz: { timeline: false, heatmap: true, playhead: false } });
    expect(marker().hidden).toBe(true);

    // An older main that sends no `playhead` leaves it off.
    fromMain(PLAYERWIN.INITIAL_STATE, { inlineViz: { timeline: false, heatmap: true } });
    expect(marker().hidden).toBe(true);
  });

  // FT-028 (2026-11-05, new since v0.9.2): the setting (and the overlay
  // opacity) reached an open pop-out only when it was reopened. Main now
  // sends INLINE_VIZ_STATE on every change while the pop-out is open.
  it('a change while open (INLINE_VIZ_STATE) shows and hides the marker at once, and nothing is echoed back', () => {
    fromMain(PLAYERWIN.INITIAL_STATE, { inlineViz: { timeline: false, heatmap: true, playhead: false, opacity: 80 } });
    fromMain(PLAYERWIN.HEATMAP, { actions, durationMs: 4000 });
    expect(marker().hidden).toBe(true);
    const sentBefore = up.length;

    fromMain(PLAYERWIN.INLINE_VIZ_STATE, { playhead: true, opacity: 80 });
    expect(marker().hidden).toBe(false);
    fromMain(PLAYERWIN.INLINE_VIZ_STATE, { playhead: false, opacity: 80 });
    expect(marker().hidden).toBe(true);
    expect(up.slice(sentBefore).filter((m) => m.type === PLAYERWIN.SET_INLINE_VIZ)).toEqual([]);
  });

  it('the overlay opacity follows at once: 50 → 0.5, clamped to 20-100 like the main window', () => {
    const opacity = () => document.documentElement.style.getPropertyValue('--inline-viz-opacity');
    fromMain(PLAYERWIN.INITIAL_STATE, { inlineViz: { timeline: false, heatmap: true, playhead: false, opacity: 80 } });
    expect(opacity()).toBe('0.8');
    fromMain(PLAYERWIN.INLINE_VIZ_STATE, { playhead: false, opacity: 50 });
    expect(opacity()).toBe('0.5');
    fromMain(PLAYERWIN.INLINE_VIZ_STATE, { playhead: false, opacity: 5 });
    expect(opacity()).toBe('0.2');
    // A message without a usable opacity leaves the last one.
    fromMain(PLAYERWIN.INLINE_VIZ_STATE, { playhead: true });
    expect(opacity()).toBe('0.2');
    expect(marker().hidden).toBe(false);
  });
});

// E-10 (also in v0.9.2): main's no-frames check skipped the player window,
// whose <video> is the one on screen. Every tick now reports what that check
// needs about THIS window's video.
describe('E-10: each tick reports the window\'s decoded frames, played time and visibility', () => {
  it('frames from getVideoPlaybackQuality, seconds actually played, and not hidden', () => {
    up.length = 0;
    video().getVideoPlaybackQuality = () => ({ totalVideoFrames: 0 });
    Object.defineProperty(video(), 'played', {
      configurable: true,
      value: { length: 2, start: (i) => [0, 30][i], end: (i) => [1.5, 31][i] },
    });
    try {
      video().dispatchEvent(new Event('ratechange')); // sends a tick at once
      const tick = up.filter((m) => m.type === PLAYERWIN.TIME_TICK).at(-1);
      expect(tick).toMatchObject({ frames: 0, playedSec: 2.5, hidden: false });
    } finally {
      delete video().getVideoPlaybackQuality;
      delete video().played;
    }
  });

  it('a browser that cannot say how many frames it decoded reports null, not 0', () => {
    up.length = 0;
    video().dispatchEvent(new Event('ratechange'));
    const tick = up.filter((m) => m.type === PLAYERWIN.TIME_TICK).at(-1);
    expect(tick.frames).toBeNull();
  });
});

// verify-1 (2026-11-16, N-03; also in v0.9.2): after Manage variations > ✕ on
// the variation that plays, no entry plays. Main sends no active label and
// names the script that still plays; the window marks nothing and its chip
// says that name, not the first entry's.
describe('N-03: the window\'s variation chip when no entry plays', () => {
  const list = [
    { label: 'Default', path: 'a.funscript', text: 'Default' },
    { label: 'C', path: 'c.funscript', text: 'C' },
  ];
  const chipText = () => $('variant-btn-label').textContent;
  // FN-03 (2026-11-16): the playing entry is marked as the inline menu marks
  // it (styled class + aria-current); this read `.is-active`, a class no
  // stylesheet styled. tests/unit/variant-names.test.js has the FN-03 rows.
  const marked = () => [...$('variant-dropdown').querySelectorAll('.variant-selector__item--active[aria-current="true"]')]
    .map((b) => b.querySelector('.variant-selector__item-label').textContent);

  it('nothing is marked and the chip names the script that plays', () => {
    fromMain(PLAYERWIN.VARIANTS, { list, activeLabel: '', activeText: 'Second Set B' });
    expect(chipText()).toBe('Second Set B');
    expect(marked()).toEqual([]);
  });

  it('control: an entry that plays is marked and named', () => {
    fromMain(PLAYERWIN.VARIANTS, { list, activeLabel: 'C' });
    expect(chipText()).toBe('C');
    expect(marked()).toEqual(['C']);
  });
});

// FN-03 (Dave 2026-11-16: "the default means nothing, the name of the
// currently assigned script should be highlighted"; also in v0.9.2): the
// window's variation menu names each entry as main sends it (`text`), marks
// the script the video opens on "main" in main's language (`mainTag`), and
// marks the playing entry as the inline menu does: tinted, ticked and
// announced as current. It set `is-active`, which no stylesheet styles, so
// nothing was marked. By place (`activeIndex`) when main says it, so two
// entries with one label are not both marked.
describe('FN-03: the window\'s variation menu names, marks main and highlights what plays', () => {
  const list = [
    { label: 'Default', path: 'C:\v\Clip.funscript', text: 'Clip', main: true },
    { label: 'soft', path: 'C:\v\Clip (soft).funscript', text: 'soft', main: false },
    { label: 'soft', path: 'C:\v\other soft.funscript', text: 'soft', main: false },
  ];
  const rows = () => [...$('variant-dropdown').querySelectorAll('.variant-selector__item')].map((el) => ({
    name: el.querySelector('.variant-selector__item-label').textContent,
    main: el.querySelector('.variant-selector__main-tag')?.textContent ?? null,
    playing: el.getAttribute('aria-current') === 'true' && el.classList.contains('variant-selector__item--active'),
    tick: el.querySelector('.variant-selector__check')?.textContent ?? null,
  }));

  it('the main script is named by its file and marked with main\'s word; the chip names it', () => {
    fromMain(PLAYERWIN.VARIANTS, { list, activeLabel: 'Default', activeIndex: 0, mainTag: 'principal' });
    expect($('variant-btn-label').textContent).toBe('Clip');
    expect(rows()).toEqual([
      { name: 'Clip', main: 'principal', playing: true, tick: '✓' },
      { name: 'soft', main: null, playing: false, tick: '' },
      { name: 'soft', main: null, playing: false, tick: '' },
    ]);
    expect($('variant-dropdown').textContent).not.toContain('Default');
  });

  it('the second of two same-label entries plays: only it is marked', () => {
    fromMain(PLAYERWIN.VARIANTS, { list, activeLabel: 'soft', activeIndex: 2, mainTag: 'main' });
    expect(rows().map((r) => r.playing)).toEqual([false, false, true]);
  });

  it('a pick still sends the label main switches on', () => {
    fromMain(PLAYERWIN.VARIANTS, { list, activeLabel: 'Default', activeIndex: 0, mainTag: 'main' });
    const before = up.length;
    $('variant-dropdown').querySelectorAll('.variant-selector__item')[1].click();
    expect(up.slice(before).filter((m) => m.type === PLAYERWIN.SWITCH_VARIANT).map((m) => m.label)).toEqual(['soft']);
  });
});
