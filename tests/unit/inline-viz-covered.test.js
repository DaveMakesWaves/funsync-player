/**
 * @vitest-environment jsdom
 * jsdom on purpose: InlineViz builds its overlay as DOM and branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Dave, 2026-11-25: "is there any way to speed up the player when in editor
// especially when its multi axis". Profiled live (Long Test, six axes, 1,000
// points each, stacked tracks + the 3D simulator, 5 s of playback): the
// player's own script strip (TL) drew EVERY frame, 538 ms of the 5 s, while
// it sat entirely under the docked editor (the element on top of it: the
// editor's track). The editor shows the script itself. Covered, the strip's
// loop stops; uncovered, it draws again at once and follows the clock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { InlineViz } from '../../renderer/components/inline-viz.js';
import { APP_SRC } from './helpers/app-methods.js';
// At the top, not inside a test: the editor module is large, and its import
// inside a test ran past the 5 s test timeout under load (the full suite beside).
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const ACTIONS = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 3000, pos: 20 }, { at: 20000, pos: 90 }, { at: 59000, pos: 80 }];

let frames;
beforeEach(() => {
  document.body.innerHTML = '';
  frames = new Map();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb) => { id += 1; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (h) => { frames.delete(h); });
});
afterEach(() => vi.unstubAllGlobals());

function stepFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(performance.now());
}

function makeViz() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const video = document.createElement('video');
  let paused = true;
  let time = 0;
  Object.defineProperty(video, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(video, 'currentTime', { get: () => time, set: (v) => { time = v; }, configurable: true });
  const viz = new InlineViz({ container, video });
  viz.setScript(ACTIONS, 60);
  viz.setTimelineVisible(true);
  viz.setHeatmapVisible(true);
  viz.setHeatmapPlayhead(true);
  const draws = vi.spyOn(viz, '_drawFrame');
  return { viz, draws, play: () => { paused = false; video.dispatchEvent(new Event('play')); }, setTime: (s) => { time = s; } };
}

describe('the script strip under an open editor', () => {
  it('stops drawing while the editor covers it; draws again at once when it is uncovered', () => {
    const { viz, draws, play, setTime } = makeViz();
    play();
    stepFrame();
    expect(draws).toHaveBeenCalled();                       // playing, uncovered: it follows the clock

    viz.setCovered(true);
    draws.mockClear();
    for (let i = 0; i < 5; i++) { setTime(i); stepFrame(); }
    expect(draws).not.toHaveBeenCalled();                   // nothing drawn under the editor
    expect(frames.size).toBe(0);                            // and no frame loop kept running

    setTime(12);
    viz.setCovered(false);
    expect(draws).toHaveBeenCalledTimes(1);                 // the current moment at once
    stepFrame();
    expect(draws).toHaveBeenCalledTimes(2);                 // and the loop is back
  });

  it('app.js stops it under the docked editor and in the mini player (which hides it); a popped-out editor leaves it drawing', () => {
    // LF whatever the checkout: the slices below look for '\n  }\n' (CI's Windows runner is CRLF).
    const LF_SRC = APP_SRC.replace(/\r\n/g, '\n');
    const hook = LF_SRC.slice(LF_SRC.indexOf('this.scriptEditor.onOpenChange = () => {'));
    expect(hook.slice(0, hook.indexOf('};') + 2)).toMatch(/this\._syncInlineVizCovered\(\)/);
    const helper = LF_SRC.slice(LF_SRC.indexOf('  _syncInlineVizCovered() {'));
    const body = helper.slice(0, helper.indexOf('\n  }\n') + 4).trim();
    // The real helper, run on each case.
    const sync = new Function(`return function ${body}`)(); // eslint-disable-line no-new-func
    const run = ({ docked, mini }) => {
      const setCovered = vi.fn();
      sync.call({
        _getViewEl: () => ({ classList: { contains: (c) => c === 'player-container--mini' && mini } }),
        scriptEditor: { dockedOnScreen: docked, isOpen: true },
        inlineViz: { setCovered },
      });
      return setCovered.mock.calls[0][0];
    };
    expect(run({ docked: true, mini: false })).toBe(true);     // under the editor
    // Popped out (break-it, 2026-11-25: with isOpen the strip stopped while visible).
    expect(run({ docked: false, mini: false })).toBe(false);
    // The mini player hides the strip (player.css), the editor or not (break-it, same day).
    expect(run({ docked: true, mini: true })).toBe(true);
    expect(run({ docked: false, mini: true })).toBe(true);
    // Mini on / off changes it too (the hook, entering and leaving the mini player).
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    // (Optional-called in the mini-player methods: tests lift those onto stand-in apps.)
    expect(src.match(/this\._syncInlineVizCovered(\?\.)?\(\);/g).length).toBe(3);
  });

  it('the editor says so when it pops out and when it docks again (onOpenChange), and dockedOnScreen follows', async () => {
    let emit;
    window.funsync = { onEditorPopoutEvent: (cb) => { emit = cb; return () => {}; } };
    try {
      const ed = Object.create(ScriptEditor.prototype);
      const calls = [];
      Object.assign(ed, {
        _open: true, _popoutOpen: false, _panel: document.createElement('div'), _btnPopout: null,
        _setToggleState() {}, _labelPopoutButton() {}, _startPopoutBroadcast() {}, _stopPopoutBroadcast() {},
        onOpenChange: (open) => calls.push(['open', open, ed.dockedOnScreen]),
      });
      ed._bindPopoutLifecycle();
      expect(ed.dockedOnScreen).toBe(true);
      emit({ type: 'opened' });
      expect(calls.at(-1)).toEqual(['open', true, false]);       // still open, no longer docked
      emit({ type: 'closed' });
      expect(calls.at(-1)).toEqual(['open', true, true]);        // docked again
    } finally {
      delete window.funsync;
    }
  });
});
