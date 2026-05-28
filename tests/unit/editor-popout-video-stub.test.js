import { describe, it, expect, vi } from 'vitest';
import { PopoutVideoPlayerStub } from '../../renderer/js/editor-popout-video-stub.js';
import {
  VIDEO_SEEK, VIDEO_STEP_FRAME, VIDEO_STEP_FRAMES,
} from '../../renderer/js/editor-popout-protocol.js';

describe('PopoutVideoPlayerStub', () => {
  it('exposes the VideoPlayer surface ScriptEditor expects', () => {
    const stub = new PopoutVideoPlayerStub({ send: () => {} });
    // Top-level
    expect(typeof stub.currentTime).toBe('number');
    expect(typeof stub.duration).toBe('number');
    expect(typeof stub.paused).toBe('boolean');
    expect(typeof stub.setPlaybackRate).toBe('function');
    expect(typeof stub.stepFrame).toBe('function');
    expect(typeof stub.stepFrames).toBe('function');
    // .video sub-object
    expect(typeof stub.video.currentTime).toBe('number');
    expect(typeof stub.video.addEventListener).toBe('function');
  });

  it('setting video.currentTime fires VIDEO_SEEK and updates the local cache', () => {
    const send = vi.fn();
    const stub = new PopoutVideoPlayerStub({ send });
    stub.video.currentTime = 12.5;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: VIDEO_SEEK, time: 12.5 }));
    expect(stub.video.currentTime).toBe(12.5);
    expect(stub.currentTime).toBe(12.5);
  });

  it('stepFrame and stepFrames fan out the right messages', () => {
    const send = vi.fn();
    const stub = new PopoutVideoPlayerStub({ send });
    stub.stepFrame(1);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: VIDEO_STEP_FRAME, direction: 1 }));
    stub.stepFrames(-6);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: VIDEO_STEP_FRAMES, frames: -6 }));
  });

  it('applyTimeTick fires timeupdate and play/pause transitions', () => {
    const stub = new PopoutVideoPlayerStub({ send: () => {} });
    const events = [];
    stub.video.addEventListener('timeupdate', (e) => events.push(e.type));
    stub.video.addEventListener('playing', (e) => events.push(e.type));
    stub.video.addEventListener('pause', (e) => events.push(e.type));

    // First tick — starts paused (initial state)
    stub.applyTimeTick({ time: 1.0, paused: true });
    expect(events).toEqual(['timeupdate']); // no transition; was paused, still paused

    // Play tick
    stub.applyTimeTick({ time: 1.1, paused: false });
    expect(events).toEqual(['timeupdate', 'timeupdate', 'playing']);

    // Continue playing — no extra play event
    stub.applyTimeTick({ time: 1.2, paused: false });
    expect(events).toEqual(['timeupdate', 'timeupdate', 'playing', 'timeupdate']);

    // Pause tick
    stub.applyTimeTick({ time: 1.2, paused: true });
    expect(events).toEqual([
      'timeupdate', 'timeupdate', 'playing', 'timeupdate', 'timeupdate', 'pause',
    ]);
  });

  it('applyMeta updates src / duration / rate and fires loadedmetadata on change', () => {
    const stub = new PopoutVideoPlayerStub({ send: () => {} });
    const events = [];
    stub.video.addEventListener('loadedmetadata', (e) => events.push(e.type));

    stub.applyMeta({ src: 'file:///clip.mp4', duration: 120, rate: 1 });
    expect(stub.video.src).toBe('file:///clip.mp4');
    expect(stub.duration).toBe(120);
    expect(events).toEqual(['loadedmetadata']);

    // No-op meta — same values, no extra event
    stub.applyMeta({ src: 'file:///clip.mp4', duration: 120, rate: 1 });
    expect(events).toEqual(['loadedmetadata']);

    // Partial meta — only changes what's provided
    stub.applyMeta({ duration: 150 });
    expect(stub.duration).toBe(150);
    expect(stub.video.src).toBe('file:///clip.mp4'); // untouched
    expect(events).toEqual(['loadedmetadata', 'loadedmetadata']);
  });

  it('removeEventListener removes the listener', () => {
    const stub = new PopoutVideoPlayerStub({ send: () => {} });
    let count = 0;
    const fn = () => { count++; };
    stub.video.addEventListener('timeupdate', fn);
    stub.applyTimeTick({ time: 0.1, paused: true });
    expect(count).toBe(1);
    stub.video.removeEventListener('timeupdate', fn);
    stub.applyTimeTick({ time: 0.2, paused: true });
    expect(count).toBe(1);
  });

  it('listener throw does not break the dispatch loop', () => {
    const stub = new PopoutVideoPlayerStub({ send: () => {} });
    const noisy = () => { throw new Error('boom'); };
    let goodFired = 0;
    stub.video.addEventListener('timeupdate', noisy);
    stub.video.addEventListener('timeupdate', () => { goodFired++; });
    // Should not throw
    stub.applyTimeTick({ time: 0.1, paused: true });
    expect(goodFired).toBe(1);
  });

  it('setPlaybackRate updates the local rate without sending (no message defined yet)', () => {
    const send = vi.fn();
    const stub = new PopoutVideoPlayerStub({ send });
    stub.setPlaybackRate(1.5);
    expect(stub.video.playbackRate).toBe(1.5);
    expect(send).not.toHaveBeenCalled();
  });

  it('initial state — paused true, time 0, duration 0', () => {
    const stub = new PopoutVideoPlayerStub({ send: () => {} });
    expect(stub.currentTime).toBe(0);
    expect(stub.duration).toBe(0);
    expect(stub.paused).toBe(true);
    expect(stub.video.src).toBe('');
    expect(stub.video.playbackRate).toBe(1);
  });
});
