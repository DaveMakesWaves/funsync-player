// Mini-player enter/skip decision (Phase 1 of the separate-player-window
// feature). When the user leaves the player view, should playback dock into
// a corner mini-player (keep playing) or tear down? Only when actively
// playing, and only when the setting is on.

import { describe, it, expect } from 'vitest';
import { shouldEnterMiniplayer } from '../../renderer/js/miniplayer.js';

const base = { enabled: true, hasVideo: true, paused: false, ended: false };

describe('shouldEnterMiniplayer', () => {
  it('docks when a video is actively playing and the setting is on', () => {
    expect(shouldEnterMiniplayer(base)).toBe(true);
  });

  it('does not dock when the setting is off (user opted out)', () => {
    expect(shouldEnterMiniplayer({ ...base, enabled: false })).toBe(false);
  });

  it('does not dock when the video is paused (user is done watching)', () => {
    expect(shouldEnterMiniplayer({ ...base, paused: true })).toBe(false);
  });

  it('does not dock when the video has ended', () => {
    expect(shouldEnterMiniplayer({ ...base, ended: true })).toBe(false);
  });

  it('does not dock when no video is loaded', () => {
    expect(shouldEnterMiniplayer({ ...base, hasVideo: false })).toBe(false);
  });

  it('ended takes precedence even if not paused', () => {
    expect(shouldEnterMiniplayer({ ...base, paused: false, ended: true })).toBe(false);
  });
});
