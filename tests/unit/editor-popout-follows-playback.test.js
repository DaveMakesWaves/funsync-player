/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js), which builds its toolbar, canvas and scroller
 * on the DOM of editor-popout.html at import time, and the REAL ScriptEditor.
 */
// D-01 (Dave 2026-11-06, also in v0.9.2): "when the editor is popped out the
// timeline doesnt follow the playing video like when its docked, the points
// and selection are static and you cant scroll through with the scroller at
// the bottom". Reproduced in the real app 2026-11-07 (block D repro): three
// causes.
//   1. The pop-out never started its graph's animation, and the graph
//      recentres on the playhead only while it animates
//      (ActionGraph.setCursorTime), so the playhead walked off a static view.
//   2. The pop-out's bottom scroller only painted: no mouse handling at all.
//   3. With the PLAYER popped out too, the parent ticked the main window's
//      inline <video>, which is paused and hidden then, so every tick said
//      "paused at 30 s" while the player window played on; and the pop-out's
//      arrows stepped that hidden element.
// Plus D-02 (iii): the pop-out's Ctrl+Left/Right stepped a literal 6 frames
// while the docked editor reads editor.fastStepFrames.
//
// The parent's REAL ScriptEditor relays to the REAL pop-out and the pop-out's
// commands come back to the parent's REAL handler. What is asserted is what
// the pop-out window shows (its scroller's view box and playhead, which move
// only when the graph's view moves) and where seeks and steps land.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { PLAYBACK_RATE_PRESETS, frameStepTime } from '../../renderer/js/video-player.js';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const PATH = 'C:\\sandbox\\library\\Long 30fps.funscript';
// 90 s video, a point every 300 ms (300 points, > 100: the pop-out opens on
// a 10 s window around the playhead, as in the repro).
const DURATION = 90;
const ACTIONS = () => Array.from({ length: 300 }, (_, i) => ({ at: i * 300, pos: i % 2 ? 90 : 10 }));

let toPopout = null;
let ed;
let video;            // the main window's inline <video> stand-in
let playerRelays;     // what the parent sent the PLAYER pop-out
let clockOverride;    // what app.js's getPlaybackClock returns
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

// The pop-out window's own scroller (the docked editor has one too).
const popoutEl = (cls) => document.querySelector(`#editor-popout-host .${cls}`);
const pct = (el, prop) => parseFloat(el.style[prop]);
/** The pop-out's view box and playhead on its scroller, in % of the timeline. */
function popoutView() {
  const vp = popoutEl('editor__scrubber-viewport');
  const cur = popoutEl('editor__scrubber-cursor');
  const left = pct(vp, 'left');
  const width = pct(vp, 'width');
  return { left, width, centre: left + width / 2, cursor: pct(cur, 'left') };
}
const msPct = (ms) => (ms / (DURATION * 1000)) * 100;

/** A tick as the parent's 33 ms interval sends it. */
async function tick() { ed._broadcastTimeTick(); await flush(); }
async function key(init) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  await flush();
}

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  const ctx = document.createElement('canvas').getContext('2d');
  for (const fn of ['setLineDash', 'getLineDash', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'translate']) {
    if (typeof ctx[fn] !== 'function') ctx[fn] = () => [];
  }
  if (typeof ctx.createLinearGradient !== 'function') ctx.createLinearGradient = () => ({ addColorStop() {} });
  // One preload for both windows: 'to-popout' reaches the pop-out's listener,
  // 'to-parent' the parent's handler (main's relay does that between them).
  window.funsync = {
    editorPopoutRelay: (direction, payload) => {
      if (direction === 'to-popout') toPopout?.({ type: 'message', payload });
      else if (direction === 'to-parent') ed?._handlePopoutMessage(payload);
    },
    onEditorPopoutEvent: (cb) => { if (!toPopout) toPopout = cb; },
    editorPopoutClose() {},
    updateWindowChrome() {},
    filesExist: async (paths) => paths.map(() => true),
    readFunscript: async () => JSON.stringify({ version: '1.0', actions: ACTIONS() }),
    writeFunscript: async (json, p) => p,
    editorDirtyChanged() {},
    setSetting() {},
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-popout') playerRelays.push(payload); },
  };
  await import('../../renderer/editor-popout.js');

  const host = document.createElement('div');
  host.id = 'player-container';
  document.body.appendChild(host);
  const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
  video = Object.assign(new EventTarget(), { currentTime: 30, duration: DURATION, paused: true, src: 'file:///x.mp4', playbackRate: 1 });
  // The VideoPlayer surface the editor uses; steps as VideoPlayer.stepFrames
  // does (pause, then n / 30 s).
  const videoPlayer = {
    video,
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
    stepFrame(d) { video.paused = true; video.currentTime += d / 30; },
    stepFrames(n) { if (!n) return; video.paused = true; video.currentTime += n / 30; },
    _estimateFps: () => 30,
    setPlaybackRate() {},
  };
  ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  ed._reuploadToHandy = () => {};

  // app.js's two hooks, as init() sets them, over the REAL lifted
  // _playerWindowPlayback (the player window's command path, V13).
  const Lifted = liftAppClass(['_playerWindowPlayback'], {
    window: { get funsync() { return window.funsync; } },
    PLAYERWIN,
    PLAYBACK_RATE_PRESETS,
    frameStepTime,
    performance,
  });
  const app = new Lifted();
  app.videoPlayer = videoPlayer;
  Object.defineProperty(app, '_playerWindowActive', { get: () => !!clockOverride });
  Object.defineProperty(app, '_playerWinProxy', { get: () => clockOverride });
  ed.getPlaybackClock = () => (app._playerWindowActive && app._playerWinProxy ? app._playerWinProxy : null);
  ed.routePlayback = (command, arg) => app._playerWindowPlayback(command, arg);

  ed.setFunscriptPath(PATH);
  ed.editableScript.loadFromData({ version: '1.0', actions: ACTIONS() });
  ed.editableScript.select(102);
  ed._popoutOpen = true;
  ed._broadcastInitialState();
  await flush();
  // jsdom lays nothing out: give the pop-out's scroller track a width.
  popoutEl('editor__scrubber-track').getBoundingClientRect = () => ({ left: 100, top: 0, width: 800, height: 12, right: 900, bottom: 12, x: 100, y: 0 });
}, 20000);

beforeEach(() => { playerRelays = []; });

describe('the popped-out editor follows the playing video (D-01)', () => {
  it('opened paused at 30 s: the view is around the playhead', () => {
    const v = popoutView();
    expect(v.cursor).toBeCloseTo(msPct(30000), 3);
    expect(v.cursor).toBeGreaterThan(v.left);
    expect(v.cursor).toBeLessThan(v.left + v.width);
  });

  it('playing: every tick keeps the playhead in the middle of the view, the view moves with it', async () => {
    video.paused = false;
    const centres = [];
    for (let t = 30; t <= 40; t += 0.5) {
      video.currentTime = t;
      await tick();
      const v = popoutView();
      expect(v.cursor).toBeCloseTo(msPct(t * 1000), 3);
      // Centred on the playhead, as the docked editor (OFS centred playhead).
      expect(Math.abs(v.centre - v.cursor)).toBeLessThan(0.05);
      centres.push(v.centre);
    }
    // 10 s of playback moved the view 10 s (11.1 % of 90 s).
    expect(centres.at(-1) - centres[0]).toBeCloseTo(msPct(10000), 1);
  });

  it('paused again: the view stops following, as docked', async () => {
    video.paused = true;
    await tick();
    const before = popoutView();
    video.currentTime = 40 + 1 / 30; // a frame step while paused
    await tick();
    const after = popoutView();
    expect(after.left).toBeCloseTo(before.left, 6);
    expect(after.cursor).toBeGreaterThan(before.cursor);
  });
});

describe('the pop-out\'s bottom scroller seeks (D-01)', () => {
  it('a press seeks the video there and centres the view; a drag follows; release ends it', async () => {
    const scroller = popoutEl('editor__scrubber');
    // Track 100..900 px, timeline 90 s: x 500 is 45 s.
    scroller.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 500 }));
    await flush();
    expect(video.currentTime).toBeCloseTo(45, 6);
    expect(popoutView().centre).toBeCloseTo(50, 1);

    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 700 }));
    await flush();
    expect(video.currentTime).toBeCloseTo(67.5, 6);
    expect(popoutView().centre).toBeCloseTo(75, 1);

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 700 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 }));
    await flush();
    expect(video.currentTime).toBeCloseTo(67.5, 6);
  });

  it('while playing too', async () => {
    video.paused = false;
    video.currentTime = 20;
    await tick();
    popoutEl('editor__scrubber').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 300 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(video.currentTime).toBeCloseTo(22.5, 6);
    video.paused = true;
    await tick();
  });
});

describe('with the PLAYER popped out too, the editor pop-out follows the player window (D-01)', () => {
  it('ticks carry the player window\'s clock, not the paused inline <video>', async () => {
    video.currentTime = 30;
    video.paused = true;
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: 35000, paused: false, duration: DURATION });
    clockOverride = proxy;
    try {
      await tick();
      let v = popoutView();
      expect(v.cursor).toBeCloseTo(msPct(35000), 1);
      proxy.updateState({ at: 50000 });
      await tick();
      v = popoutView();
      expect(v.cursor).toBeCloseTo(msPct(50000), 1);
      // Playing in the player window: the view follows it.
      expect(Math.abs(v.centre - v.cursor)).toBeLessThan(0.1);
      expect(video.currentTime).toBe(30);
    } finally {
      proxy.reset();
      clockOverride = null;
    }
  });

  it('the pop-out\'s Right, Ctrl+Right and scroller act on the player window, never the hidden inline video', async () => {
    video.currentTime = 30;
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: 58000, paused: true, duration: DURATION });
    clockOverride = proxy;
    try {
      await tick();
      await key({ key: 'ArrowRight', code: 'ArrowRight' });
      // Frame 1741 (58.0333 s) shows from its start: 58034 ms is past it.
      // This expected 58033 until the fix-up after verify-1: a seek rounded
      // to 58033 ms is BEFORE 1741's start, so the window kept showing 1740
      // (the burned-in counter read 900 at 30.033 s). frameStepTime.
      expect(playerRelays).toEqual([
        PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: true }),
        PLAYERWIN.makeMessage(PLAYERWIN.SEEK, { timeMs: 58034 }),
      ]);
      // A second press before the window reported the first one steps on
      // (frame 1742 starts at 58066.67 ms; it was 58066).
      playerRelays = [];
      await key({ key: 'ArrowRight', code: 'ArrowRight' });
      expect(playerRelays.at(-1)).toEqual(PLAYERWIN.makeMessage(PLAYERWIN.SEEK, { timeMs: 58068 }));
      playerRelays = [];
      popoutEl('editor__scrubber').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 500 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await flush();
      expect(playerRelays).toEqual([PLAYERWIN.makeMessage(PLAYERWIN.SEEK, { timeMs: 45000 })]);
      expect(video.currentTime).toBe(30);
    } finally {
      proxy.reset();
      clockOverride = null;
    }
  });

  it('player docked again: the arrows step the inline video, one frame', async () => {
    video.currentTime = 30;
    await key({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(video.currentTime).toBeCloseTo(30 + 1 / 30, 6);
    expect(playerRelays).toEqual([]);
  });
});

// E-06 (found while D-01, also in v0.9.2): the pop-out's Speed list sent
// VIDEO_SET_RATE, and the parent set the INLINE element's rate even while the
// player window played: the window kept its speed, and the hidden copy took
// the new one. It goes to the video that plays now, as the seeks do.
describe('the pop-out\'s Speed list sets the rate of the video that plays (E-06)', () => {
  // The Speed list, by its group: the Select and Modify menus share its class.
  const speedSelect = () => document.querySelector('#editor-popout-host .editor__speed-group select');
  const pick = async (rate) => {
    speedSelect().value = String(rate);
    speedSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  };

  it('player popped out: the player window gets SET_RATE 1.5; the hidden inline video keeps its rate', async () => {
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: 40000, paused: false, duration: DURATION });
    clockOverride = proxy;
    const inlineRates = [];
    ed.videoPlayer.setPlaybackRate = (r) => inlineRates.push(r);
    try {
      await pick(1.5);
      expect(playerRelays).toEqual([PLAYERWIN.makeMessage(PLAYERWIN.SET_RATE, { rate: 1.5 })]);
      expect(inlineRates).toEqual([]);
      // ...and the docked editor's own list shows it too.
      expect(ed._speedSelect.value).toBe('1.5');
    } finally {
      ed.videoPlayer.setPlaybackRate = () => {};
      proxy.reset();
      clockOverride = null;
    }
  });

  it('a [ / ] step from the pop-out goes to the player window too', async () => {
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: 40000, paused: true, duration: DURATION });
    clockOverride = proxy;
    try {
      await pick(1);
      playerRelays = [];
      await key({ key: ']', code: 'BracketRight' });
      expect(playerRelays).toEqual([PLAYERWIN.makeMessage(PLAYERWIN.SET_RATE, { rate: 1.25 })]);
    } finally {
      proxy.reset();
      clockOverride = null;
    }
  });

  it('player docked: the inline video takes the rate, nothing goes to a player window', async () => {
    const inlineRates = [];
    ed.videoPlayer.setPlaybackRate = (r) => inlineRates.push(r);
    try {
      await pick(0.75);
      expect(inlineRates).toEqual([0.75]);
      expect(playerRelays).toEqual([]);
    } finally {
      ed.videoPlayer.setPlaybackRate = () => {};
      await pick(1);
    }
  });
});

describe('the pop-out\'s Ctrl+Left/Right steps the docked editor\'s editor.fastStepFrames (D-02)', () => {
  it('default 6, and a Settings change reaches the open pop-out', async () => {
    const { dataService } = await import('../../renderer/js/data-service.js');
    video.currentTime = 30;
    await key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    expect(video.currentTime).toBeCloseTo(30 + 6 / 30, 6);
    dataService.set('editor.fastStepFrames', 10);
    try {
      await flush();
      video.currentTime = 30;
      await key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
      expect(video.currentTime).toBeCloseTo(30 + 10 / 30, 6);
      await key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true });
      expect(video.currentTime).toBeCloseTo(30, 6);
    } finally {
      dataService.set('editor.fastStepFrames', 6);
    }
  });
});

// Found by the real-app checks (verify-1, 2026-11-07; both also in v0.9.2).
describe('pop-out mouse and keys the verifiers found', () => {
  const canvasEl = () => document.querySelector('#editor-popout-host canvas.editor__canvas');
  const mouse = (type, x, y, extra = {}) => canvasEl().dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra,
  }));

  it('a rubber band selects and does not seek: the click after its mouseup is not a click', async () => {
    video.paused = true;
    video.currentTime = 30;
    await tick();
    mouse('mousedown', 20, 10);
    mouse('mousemove', 140, 120);
    mouse('mouseup', 140, 120);
    mouse('click', 140, 120); // the browser fires it after any press + release on the canvas
    await flush();
    expect(video.currentTime).toBe(30);
  });

  it('a plain click on empty space still seeks, as before', async () => {
    video.currentTime = 30;
    await tick();
    mouse('mousedown', 140, 120);
    mouse('mouseup', 140, 120);
    mouse('click', 140, 120);
    await flush();
    expect(Number.isFinite(video.currentTime)).toBe(true);
    expect(video.currentTime).not.toBe(30);
    video.currentTime = 30;
    await tick();
  });

  it('Space plays and pauses the inline video (player docked)', async () => {
    const toggles = [];
    ed.videoPlayer.togglePlay = () => { toggles.push(video.paused ? 'play' : 'pause'); video.paused = !video.paused; };
    try {
      video.paused = true;
      await tick();
      await key({ key: ' ', code: 'Space' });
      expect(toggles).toEqual(['play']);
      await tick(); // the parent's tick tells the pop-out it plays now
      await key({ key: ' ', code: 'Space' });
      expect(toggles).toEqual(['play', 'pause']);
      expect(video.paused).toBe(true);
      // A focused toolbar button keeps its own Space.
      const btn = document.querySelector('#editor-popout-host button');
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
      await flush();
      expect(toggles).toEqual(['play', 'pause']);
    } finally {
      delete ed.videoPlayer.togglePlay;
      video.paused = true;
      await tick();
    }
  });

  it('Space pauses the PLAYER window while it owns playback, never the hidden inline video', async () => {
    const proxy = new RemotePlaybackProxy();
    proxy.updateState({ at: 40000, paused: false, duration: DURATION });
    clockOverride = proxy;
    ed.videoPlayer.togglePlay = vi.fn();
    try {
      await tick();
      await key({ key: ' ', code: 'Space' });
      expect(playerRelays).toEqual([PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: true })]);
      proxy.updateState({ paused: true });
      await tick();
      playerRelays = [];
      await key({ key: ' ', code: 'Space' });
      expect(playerRelays).toEqual([PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: false })]);
      expect(ed.videoPlayer.togglePlay).not.toHaveBeenCalled();
    } finally {
      delete ed.videoPlayer.togglePlay;
      proxy.reset();
      clockOverride = null;
    }
  });
});

describe('paused, a seek from the main window brings the pop-out view to the playhead (verify-1)', () => {
  it('a seek-bar click to 4.08 s while the view shows ~25-35 s: the playhead is in view', async () => {
    video.paused = true;
    video.currentTime = 30;
    await tick();
    let v = popoutView();
    expect(v.cursor).toBeGreaterThan(v.left);
    video.currentTime = 4.08; // the main window's seek bar, paused
    await tick();
    v = popoutView();
    expect(v.cursor).toBeCloseTo(msPct(4080), 3);
    expect(v.cursor).toBeGreaterThanOrEqual(v.left);
    expect(v.cursor).toBeLessThanOrEqual(v.left + v.width);
    video.currentTime = 30;
    await tick();
  });
});
