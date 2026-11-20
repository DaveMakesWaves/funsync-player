/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// FN-06 (block F): the AudienceBridge holds viewers through a buffering
// stall (onStalled, tests/unit/audience-stall-hold.test.js), but only if
// app.js forwards the local <video>'s 'waiting' and 'stalled' to it. It used
// to forward playing / pause / ended / seeked only, so the bridge code was
// unreachable. The listeners sit inside app.js's init(), which cannot run in
// a test, so the REAL listener lines (every `video.addEventListener` that
// calls `this.audienceBridge`) are taken from the source and run against a
// real EventTarget and a recording bridge: what is asserted is what the
// bridge hears when the element fires each event.
import { describe, it, expect } from 'vitest';
import { APP_SRC } from './helpers/app-methods.js';

function wireAudienceListeners(target) {
  const lines = APP_SRC.split(/\r?\n/)
    .filter((l) => /this\.videoPlayer\.video\.addEventListener\('\w+',.*this\.audienceBridge\?\./.test(l));
  // eslint-disable-next-line no-new-func
  new Function(lines.join('\n')).call(target);
  return lines.length;
}

describe('FN-06: app.js forwards the local video\'s stall events to the Audience bridge', () => {
  it('waiting -> onStalled("waiting"); stalled -> onStalled("stalled", the element); the four before are kept', () => {
    const video = new EventTarget();
    const heard = [];
    const record = (name) => (...args) => heard.push([name, ...args]);
    const target = {
      videoPlayer: { video },
      audienceBridge: {
        onPlaying: record('onPlaying'), onPaused: record('onPaused'), onEnded: record('onEnded'),
        onSeeked: record('onSeeked'), onStalled: record('onStalled'),
      },
    };
    expect(wireAudienceListeners(target)).toBe(6);

    video.dispatchEvent(new Event('waiting'));
    video.dispatchEvent(new Event('stalled'));
    for (const type of ['playing', 'pause', 'ended', 'seeked']) video.dispatchEvent(new Event(type));

    expect(heard).toEqual([
      ['onStalled', 'waiting'],
      ['onStalled', 'stalled', video],
      ['onPlaying'], ['onPaused'], ['onEnded'], ['onSeeked'],
    ]);
  });

  it('no room (no bridge): the events are harmless', () => {
    const video = new EventTarget();
    wireAudienceListeners({ videoPlayer: { video }, audienceBridge: null });
    expect(() => {
      video.dispatchEvent(new Event('waiting'));
      video.dispatchEvent(new Event('stalled'));
    }).not.toThrow();
  });
});
