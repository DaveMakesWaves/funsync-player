/**
 * @vitest-environment jsdom
 * jsdom on purpose: video-player.js and script-editor.js import modules that
 * branch on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The editor steps, snaps and places points on the VIDEO'S OWN frames
// (2026-11-24, Dave: "keep an eye out for similar things, small technical
// differences which may annoy users enough to use another tool").
//
// Before: every video was 30 fps (VideoPlayer.setFps was never called, the
// editor's _frameDurationMs returned 1000 / 30) and the grid started at 0.
// The test video (D:, "091 Natsuki Yokoyama", 29.97 fps) has every frame
// 12.711 ms after the 29.97 grid (ffprobe packet pts: 0.112811 +
// n x 1001/30000), so a point snapped there sat up to ~20 ms from the frame
// on screen. OFS steps by the decoder's frame time and places at the time
// shown (OFS_MpvVideoplayer.cpp NextFrame / PreviousFrame, ScriptingMode
// AddEditAction); and it EDITS a point within a frame of a new one
// (Funscript::getActionAtTime) where FunSync stacked a near-duplicate.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { VideoPlayer, frameStepTime, exactFrameRate, FRAME_STEP_MARGIN_SEC } = await import('../../renderer/js/video-player.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');

const NTSC = 30000 / 1001;
const FRAME = 1001 / 30000; // s
const PHASE = 0.012711; // s: Natsuki's frames start 12.711 ms after the 29.97 grid
/** Frame k's real start in Natsuki, seconds. */
const frameStart = (k) => PHASE + k * FRAME;
/** The frame a time shows (the last frame start at or before it). */
const frameAt = (t) => Math.floor((t - PHASE) / FRAME + 1e-9);

function player({ currentTime = 0, paused = true, seeking = false, fps } = {}) {
  const video = { currentTime, duration: 527.906733, paused, seeking, pause: vi.fn(function () { this.paused = true; }) };
  const p = Object.create(VideoPlayer.prototype);
  Object.assign(p, { video, _fps: undefined, _shownFrame: null, _phase: 0, onFrameGridChanged: vi.fn() });
  if (fps) p.setFps(fps);
  return p;
}

describe('exactFrameRate: the probed rate as the real one', () => {
  it('turns the 2-decimal NTSC rates into n x 1000 / 1001', () => {
    expect(exactFrameRate(29.97)).toBe(NTSC);
    expect(exactFrameRate(59.94)).toBe(60000 / 1001);
    expect(exactFrameRate(23.98)).toBe(24000 / 1001);
  });
  it('keeps any other rate, and refuses nothing usable', () => {
    expect(exactFrameRate(25)).toBe(25);
    expect(exactFrameRate(60)).toBe(60);
    for (const bad of [0, -1, NaN, Infinity, undefined, null, 5000]) expect(exactFrameRate(bad)).toBeNull();
  });
});

describe('VideoPlayer: the frame grid', () => {
  it('learns where the grid starts from a presented frame, once the rate is known', () => {
    const p = player({ fps: NTSC });
    p.onFrameGridChanged.mockClear();
    p._onPresentedFrame(frameStart(300));
    expect(p.framePhaseSec()).toBeCloseTo(PHASE, 6);
    expect(p.onFrameGridChanged).toHaveBeenCalledTimes(1);
    p._onPresentedFrame(frameStart(301)); // same grid: no new notice
    expect(p.onFrameGridChanged).toHaveBeenCalledTimes(1);
    expect(p.frameDurationMs()).toBeCloseTo(FRAME * 1000, 9);
  });

  it('a frame presented before the rate arrives still gives the grid when it does', () => {
    const p = player();
    p._onPresentedFrame(frameStart(40));
    expect(p.framePhaseSec()).toBe(0); // 30 assumed: no grid from it
    p.setFps(NTSC);
    expect(p.framePhaseSec()).toBeCloseTo(PHASE, 6);
  });

  it('a step shows the NEXT real frame every time, 600 presses in a row', () => {
    const p = player({ currentTime: frameStart(1000) + FRAME_STEP_MARGIN_SEC, fps: NTSC });
    p._onPresentedFrame(frameStart(1000));
    for (let i = 1; i <= 600; i++) {
      p.stepFrames(1);
      const t = p.video.currentTime;
      expect(frameAt(t)).toBe(1000 + i);
      expect(t - frameStart(1000 + i)).toBeGreaterThanOrEqual(0.0005);
    }
  });

  it('(the old grid from 0 landed before the real frame start: no new frame on screen)', () => {
    const t = frameStepTime(frameStart(1000) + 0.001, 1, NTSC, Infinity, 0);
    expect(frameAt(t)).toBe(1000);
  });

  it('shownFrameTimeMs: the presented frame while paused, never a stale one', () => {
    const p = player({ currentTime: frameStart(500) + 0.020, fps: NTSC });
    p._onPresentedFrame(frameStart(500));
    expect(p.shownFrameTimeMs()).toBeCloseTo(frameStart(500) * 1000, 6);

    // A step forward before the new frame is presented: not the old one.
    p.video.currentTime = frameStart(501) + 0.001;
    expect(p.shownFrameTimeMs()).toBeNull();
    // A step back: the old frame starts after currentTime.
    p.video.currentTime = frameStart(499) + 0.001;
    expect(p.shownFrameTimeMs()).toBeNull();

    p.video.currentTime = frameStart(500) + 0.001;
    p.video.seeking = true;
    expect(p.shownFrameTimeMs()).toBeNull();
    p.video.seeking = false;
    p.video.paused = false;
    expect(p.shownFrameTimeMs()).toBeNull(); // playing: the grid decides
  });
});

function editorOn(p, actions = []) {
  const ed = Object.create(ScriptEditor.prototype);
  ed.videoPlayer = p;
  ed._snapToFrame = true;
  ed._recordingMode = false;
  ed._sendLivePreview = vi.fn();
  ed.editableScript = new EditableScript();
  ed.editableScript.loadFromData({ actions });
  return ed;
}

describe('ScriptEditor: placing on the frame on screen', () => {
  it('uses the video rate, and 1/30 s only while it is unknown', () => {
    expect(editorOn(player())._frameDurationMs()).toBeCloseTo(1000 / 30, 9);
    expect(editorOn(player({ fps: NTSC }))._frameDurationMs()).toBeCloseTo(FRAME * 1000, 9);
    expect(editorOn(player({ fps: 60 }))._frameDurationMs()).toBeCloseTo(1000 / 60, 9);
  });

  it('a position key while paused places at the presented frame start (within 0.5 ms)', () => {
    const p = player({ currentTime: frameStart(2000) + 0.001, fps: NTSC });
    p._onPresentedFrame(frameStart(2000));
    const ed = editorOn(p);
    ed._placeOrTweakAt(70);
    expect(ed.editableScript.actions).toHaveLength(1);
    expect(Math.abs(ed.editableScript.actions[0].at - frameStart(2000) * 1000)).toBeLessThanOrEqual(0.5);
  });

  it('with no presented frame known, the grid frame AT the playhead, not the nearest', () => {
    // Paused 25 ms into frame 2000 (a click on the seek bar): that frame shows.
    const p = player({ currentTime: frameStart(2000) + 0.025, fps: NTSC });
    p._phase = PHASE;
    const ed = editorOn(p);
    expect(ed._playheadMs()).toBeCloseTo(frameStart(2000) * 1000, 6);
    // A mouse placement still snaps to the NEAREST frame start.
    expect(ed.snapTime((frameStart(2000) + 0.025) * 1000)).toBeCloseTo(frameStart(2001) * 1000, 6);
  });

  it('a second key on the same frame edits the point (OFS), even 1 ms off', () => {
    const p = player({ currentTime: frameStart(100) + 0.001, fps: NTSC });
    p._onPresentedFrame(frameStart(100));
    const near = Math.round(frameStart(100) * 1000) + 1;
    const ed = editorOn(p, [{ at: near, pos: 20 }]);
    ed._placeOrTweakAt(90);
    expect(ed.editableScript.actions).toHaveLength(1);
    expect(ed.editableScript.actions[0].pos).toBe(90);
    expect(Math.abs(ed.editableScript.actions[0].at - frameStart(100) * 1000)).toBeLessThanOrEqual(0.5);
  });

  it('the previous frame\'s point is kept: consecutive frames get a point each', () => {
    const p = player({ currentTime: frameStart(101) + 0.001, fps: NTSC });
    p._onPresentedFrame(frameStart(101));
    const ed = editorOn(p, [{ at: Math.round(frameStart(100) * 1000), pos: 20 }]);
    ed._placeOrTweakAt(90);
    expect(ed.editableScript.actions.map((a) => a.pos)).toEqual([20, 90]);
  });

  it('Shift+Right ten times keeps a point on the real frames (no whole-ms drift)', () => {
    const p = player({ fps: NTSC });
    p._phase = PHASE;
    const ed = editorOn(p, [{ at: Math.round(frameStart(10) * 1000), pos: 50 }]);
    ed.editableScript.select(0);
    for (let i = 1; i <= 10; i++) {
      ed.editableScript.moveActions(ed.editableScript.selectedIndices, ed._frameMoveDeltaMs(1), 0);
      expect(Math.abs(ed.editableScript.actions[0].at - frameStart(10 + i) * 1000)).toBeLessThanOrEqual(0.5);
    }
  });
});

// Test day 2026-11-24 (B020), the pop-out on Alpha Scene (30 fps, points every
// 250 ms, not on frame starts): a position key at 1.760 s (the frame 1733.3 -
// 1766.7 ms on screen) ADDED 1733:50 beside 1750:95, two points on one frame.
// OFS's window (a frame before, half after) assumes points on frame starts;
// an imported script's points sit anywhere in a frame.
describe('ScriptEditor: a point later in the SAME frame is edited too (B020)', () => {
  it('a key on the frame 1733.3-1766.7 edits the point at 1750, no second point', () => {
    const p = player({ currentTime: 1.760, fps: 30 });
    p._onPresentedFrame(1733.333 / 1000);
    const ed = editorOn(p, [{ at: 1500, pos: 10 }, { at: 1750, pos: 95 }, { at: 2000, pos: 10 }]);
    ed._placeOrTweakAt(50);
    expect(ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(['1500:10', '1733:50', '2000:10']);
  });

  it('the next frame\'s point (whole-ms rounded) is not taken', () => {
    const p = player({ currentTime: 1.734, fps: 30 });
    p._onPresentedFrame(1733.333 / 1000);
    const ed = editorOn(p, [{ at: 1767, pos: 95 }]);
    ed._placeOrTweakAt(50);
    expect(ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(['1733:50', '1767:95']);
  });
});
