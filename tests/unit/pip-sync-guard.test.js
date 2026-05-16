// Tests for the Picture-in-Picture sync-guard pure helpers.
//
// Community feedback (GGEZGitGud, 2026-05-15): "when im playing in
// picture-in-picture mode and i back to the menu, the video can keeps going
// but the script will stop."
//
// Root cause was that `App._onLeaveView('player')` unconditionally paused
// the video and stopped every sync engine + device — regardless of PiP
// state. The fix extracts the lifecycle into pure helpers
// (`renderer/js/pip-guard.js`) and gates the immediate teardown on whether
// our video element is currently the document's PiP element. If it is,
// install a one-shot `leavepictureinpicture` listener that finishes the
// teardown when PiP eventually closes — UNLESS the user returns to the
// player view first, in which case the deferred teardown is cancelled.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isVideoInPip, teardownPlayback, beginDeferredPipTeardown }
  from '../../renderer/js/pip-guard.js';

function makeVideoElement() {
  const listeners = new Map();
  return {
    paused: false,
    pause: vi.fn(),
    addEventListener(type, handler, opts = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ handler, once: !!opts.once });
    },
    removeEventListener(type, handler) {
      const arr = listeners.get(type);
      if (!arr) return;
      const idx = arr.findIndex((e) => e.handler === handler);
      if (idx >= 0) arr.splice(idx, 1);
    },
    _fire(type) {
      const arr = listeners.get(type) || [];
      for (const { handler, once } of [...arr]) {
        handler({ type });
        if (once) this.removeEventListener(type, handler);
      }
    },
    _listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function makeDeps({ syncActive = true } = {}) {
  return {
    videoPlayer: { video: makeVideoElement() },
    syncEngine: { stop: vi.fn() },
    buttplugSync: { _active: syncActive, stop: vi.fn() },
    tcodeSync: { _active: syncActive, stop: vi.fn() },
    autoblowSync: { _active: syncActive, stop: vi.fn() },
    handyManager: { connected: true, hsspStop: vi.fn() },
    buttplugManager: { connected: true, stopAll: vi.fn() },
    tcodeManager: { connected: true, stop: vi.fn() },
    autoblowManager: { connected: true, syncStop: vi.fn() },
  };
}

// Manage document.pictureInPictureElement state across tests so a leak
// from one suite can't poison another (real bug we hit in the first cut).
let _originalPipDescriptor;
function setPipElement(el) {
  Object.defineProperty(document, 'pictureInPictureElement', {
    configurable: true,
    get: () => el,
  });
}
function clearPipElement() {
  Object.defineProperty(document, 'pictureInPictureElement', {
    configurable: true,
    get: () => null,
  });
}

beforeEach(() => {
  _originalPipDescriptor = Object.getOwnPropertyDescriptor(document, 'pictureInPictureElement');
  clearPipElement();
});

afterEach(() => {
  if (_originalPipDescriptor) {
    Object.defineProperty(document, 'pictureInPictureElement', _originalPipDescriptor);
  } else {
    try { delete document.pictureInPictureElement; } catch {}
  }
});

describe('isVideoInPip', () => {
  it('returns false when pictureInPictureElement is null', () => {
    const video = makeVideoElement();
    expect(isVideoInPip(video)).toBe(false);
  });

  it('returns true when the supplied video IS the PiP element', () => {
    const video = makeVideoElement();
    setPipElement(video);
    expect(isVideoInPip(video)).toBe(true);
  });

  it('returns false when ANOTHER element is in PiP', () => {
    const ours = makeVideoElement();
    const theirs = makeVideoElement();
    setPipElement(theirs);
    expect(isVideoInPip(ours)).toBe(false);
  });

  it('returns false defensively when video is null', () => {
    setPipElement(makeVideoElement());
    expect(isVideoInPip(null)).toBe(false);
  });

  it('returns false defensively when document is null', () => {
    const video = makeVideoElement();
    expect(isVideoInPip(video, null)).toBe(false);
  });
});

describe('teardownPlayback — full sequence (no PiP)', () => {
  it('pauses the video', () => {
    const deps = makeDeps();
    teardownPlayback(deps);
    expect(deps.videoPlayer.video.pause).toHaveBeenCalledTimes(1);
  });

  it('stops all four sync engines', () => {
    const deps = makeDeps();
    teardownPlayback(deps);
    expect(deps.syncEngine.stop).toHaveBeenCalledTimes(1);
    expect(deps.buttplugSync.stop).toHaveBeenCalledTimes(1);
    expect(deps.tcodeSync.stop).toHaveBeenCalledTimes(1);
    expect(deps.autoblowSync.stop).toHaveBeenCalledTimes(1);
  });

  it('issues stop commands to all connected devices', () => {
    const deps = makeDeps();
    teardownPlayback(deps);
    expect(deps.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(deps.buttplugManager.stopAll).toHaveBeenCalledTimes(1);
    expect(deps.tcodeManager.stop).toHaveBeenCalledTimes(1);
    expect(deps.autoblowManager.syncStop).toHaveBeenCalledTimes(1);
  });

  it('skips sync.stop on engines that are not active', () => {
    const deps = makeDeps({ syncActive: false });
    teardownPlayback(deps);
    expect(deps.buttplugSync.stop).not.toHaveBeenCalled();
    expect(deps.tcodeSync.stop).not.toHaveBeenCalled();
    expect(deps.autoblowSync.stop).not.toHaveBeenCalled();
    // syncEngine has no _active gate — always stopped.
    expect(deps.syncEngine.stop).toHaveBeenCalled();
  });

  it('skips device stops when manager is disconnected', () => {
    const deps = makeDeps();
    deps.handyManager.connected = false;
    deps.tcodeManager.connected = false;
    teardownPlayback(deps);
    expect(deps.handyManager.hsspStop).not.toHaveBeenCalled();
    expect(deps.tcodeManager.stop).not.toHaveBeenCalled();
    expect(deps.buttplugManager.stopAll).toHaveBeenCalledTimes(1);
    expect(deps.autoblowManager.syncStop).toHaveBeenCalledTimes(1);
  });

  it('is safe with no video element', () => {
    const deps = makeDeps();
    deps.videoPlayer = { video: null };
    expect(() => teardownPlayback(deps)).not.toThrow();
    // The other side-effects still run.
    expect(deps.syncEngine.stop).toHaveBeenCalled();
  });

  it('is safe with no managers attached at all (defensive)', () => {
    const deps = { videoPlayer: { video: makeVideoElement() } };
    expect(() => teardownPlayback(deps)).not.toThrow();
    expect(deps.videoPlayer.video.pause).toHaveBeenCalledTimes(1);
  });
});

describe('beginDeferredPipTeardown — listener semantics', () => {
  it('arms _pipTeardownPending and installs ONE listener', () => {
    const deps = makeDeps();
    const state = {};
    const installed = beginDeferredPipTeardown(state, deps);
    expect(installed).toBe(true);
    expect(state._pipTeardownPending).toBe(true);
    expect(deps.videoPlayer.video._listenerCount('leavepictureinpicture')).toBe(1);
  });

  it('does not re-arm when called twice (idempotent)', () => {
    const deps = makeDeps();
    const state = {};
    beginDeferredPipTeardown(state, deps);
    const second = beginDeferredPipTeardown(state, deps);
    expect(second).toBe(false);
    expect(deps.videoPlayer.video._listenerCount('leavepictureinpicture')).toBe(1);
  });

  it('does not stop anything inline when video is present', () => {
    const deps = makeDeps();
    beginDeferredPipTeardown({}, deps);
    expect(deps.syncEngine.stop).not.toHaveBeenCalled();
    expect(deps.videoPlayer.video.pause).not.toHaveBeenCalled();
  });

  it('falls back to immediate teardown when no video element is present', () => {
    const deps = makeDeps();
    deps.videoPlayer = { video: null };
    const installed = beginDeferredPipTeardown({}, deps);
    expect(installed).toBe(false);
    expect(deps.syncEngine.stop).toHaveBeenCalled();
  });
});

describe('Deferred fire — leavepictureinpicture event', () => {
  it('runs the full teardown when PiP closes', () => {
    const deps = makeDeps();
    const state = {};
    beginDeferredPipTeardown(state, deps);
    deps.videoPlayer.video._fire('leavepictureinpicture');
    expect(deps.videoPlayer.video.pause).toHaveBeenCalledTimes(1);
    expect(deps.syncEngine.stop).toHaveBeenCalledTimes(1);
    expect(deps.handyManager.hsspStop).toHaveBeenCalledTimes(1);
    expect(state._pipTeardownPending).toBe(false);
  });

  it('clears the listener after firing (no double teardown)', () => {
    const deps = makeDeps();
    beginDeferredPipTeardown({}, deps);
    deps.videoPlayer.video._fire('leavepictureinpicture');
    deps.videoPlayer.video._fire('leavepictureinpicture');
    expect(deps.videoPlayer.video.pause).toHaveBeenCalledTimes(1);
    expect(deps.syncEngine.stop).toHaveBeenCalledTimes(1);
  });

  it('skips teardown when _pipTeardownCancelled flag is set', () => {
    const deps = makeDeps();
    const state = {};
    beginDeferredPipTeardown(state, deps);
    // Caller (App._onEnterView) flips the cancellation flag when the
    // user returns to the player view while PiP is still active.
    state._pipTeardownCancelled = true;
    deps.videoPlayer.video._fire('leavepictureinpicture');
    expect(deps.videoPlayer.video.pause).not.toHaveBeenCalled();
    expect(deps.syncEngine.stop).not.toHaveBeenCalled();
    // Cancellation flag itself is consumed so a future PiP session starts clean.
    expect(state._pipTeardownCancelled).toBe(false);
    expect(state._pipTeardownPending).toBe(false);
  });

  it('after a cancelled deferred-fire, a fresh deferred teardown can be armed', () => {
    const deps = makeDeps();
    const state = {};
    beginDeferredPipTeardown(state, deps);
    state._pipTeardownCancelled = true;
    deps.videoPlayer.video._fire('leavepictureinpicture');
    // Now a new PiP session happens; arming should succeed again.
    const installed = beginDeferredPipTeardown(state, deps);
    expect(installed).toBe(true);
    expect(state._pipTeardownPending).toBe(true);
    expect(deps.videoPlayer.video._listenerCount('leavepictureinpicture')).toBe(1);
  });
});

describe('Full lifecycle — community bug repro end-to-end', () => {
  it('reproduces the original bug WITHOUT the guard, fixed WITH the guard', () => {
    // The bug: user PiP's video, leaves player view, video keeps going in
    // the floating window but the sync engine stops driving the device.
    //
    // WITHOUT the guard (simulated as: call teardownPlayback unconditionally
    // on leave): the bug.
    // WITH the guard (call isVideoInPip first, defer if true): fixed.
    const deps = makeDeps();
    const state = {};

    // 1. User enters PiP.
    setPipElement(deps.videoPlayer.video);

    // 2. User leaves the player view. The guard path checks isVideoInPip
    //    and defers the teardown.
    expect(isVideoInPip(deps.videoPlayer.video)).toBe(true);
    beginDeferredPipTeardown(state, deps);

    // 3. The video keeps playing in PiP, devices keep syncing — nothing
    //    has been torn down yet.
    expect(deps.videoPlayer.video.pause).not.toHaveBeenCalled();
    expect(deps.syncEngine.stop).not.toHaveBeenCalled();
    expect(deps.buttplugSync.stop).not.toHaveBeenCalled();
    expect(deps.handyManager.hsspStop).not.toHaveBeenCalled();

    // 4. User eventually closes PiP (or the video ends). The deferred
    //    teardown now runs in full.
    clearPipElement();
    deps.videoPlayer.video._fire('leavepictureinpicture');
    expect(deps.videoPlayer.video.pause).toHaveBeenCalledTimes(1);
    expect(deps.syncEngine.stop).toHaveBeenCalledTimes(1);
    expect(deps.handyManager.hsspStop).toHaveBeenCalledTimes(1);
  });

  it('user returns to the player view while PiP is still active — no teardown', () => {
    const deps = makeDeps();
    const state = {};
    setPipElement(deps.videoPlayer.video);

    // Leave → defer
    beginDeferredPipTeardown(state, deps);

    // Caller (App._onEnterView('player')) sets the cancel flag when the
    // user returns while pending teardown is armed.
    state._pipTeardownCancelled = true;

    // Eventually PiP closes — but the deferred handler now bails because
    // the user came back. The next normal leave-while-NOT-in-PiP will
    // handle teardown the immediate way.
    deps.videoPlayer.video._fire('leavepictureinpicture');
    expect(deps.videoPlayer.video.pause).not.toHaveBeenCalled();
    expect(deps.syncEngine.stop).not.toHaveBeenCalled();
  });
});
