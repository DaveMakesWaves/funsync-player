/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Player pop-out protocol — envelope + classify helpers (Phase 2a shell).
// The message-type set is shared by both renderers, so pin the contract.

import { describe, it, expect } from 'vitest';
import {
  makeMessage, classifyMessage, ALL_MESSAGE_TYPES,
  INITIAL_STATE, READY, TIME_TICK, VIDEO_EVENT, LOAD_VIDEO,
  UP_NEXT, UP_NEXT_ACTION,
} from '../../renderer/js/player-popout-protocol.js';

describe('player-popout protocol', () => {
  it('makeMessage stamps the type and merges fields', () => {
    expect(makeMessage(READY)).toEqual({ type: 'ready' });
    expect(makeMessage(INITIAL_STATE, { theme: 'dark', locale: 'en', video: null }))
      .toEqual({ type: 'initial-state', theme: 'dark', locale: 'en', video: null });
    expect(makeMessage(TIME_TICK, { timeMs: 1200, paused: false, rate: 1 }))
      .toEqual({ type: 'time-tick', timeMs: 1200, paused: false, rate: 1 });
  });

  it('classifyMessage returns the type for valid payloads, null otherwise', () => {
    expect(classifyMessage({ type: 'ready' })).toBe('ready');
    expect(classifyMessage(makeMessage(VIDEO_EVENT, { event: 'play', timeMs: 0 }))).toBe('video-event');
    expect(classifyMessage(null)).toBeNull();
    expect(classifyMessage(undefined)).toBeNull();
    expect(classifyMessage('ready')).toBeNull();
    expect(classifyMessage({})).toBeNull();
    expect(classifyMessage({ type: 42 })).toBeNull();
  });

  it('ALL_MESSAGE_TYPES covers the core handshake + sync types with no dupes', () => {
    for (const t of [INITIAL_STATE, READY, TIME_TICK, VIDEO_EVENT, LOAD_VIDEO]) {
      expect(ALL_MESSAGE_TYPES).toContain(t);
    }
    expect(new Set(ALL_MESSAGE_TYPES).size).toBe(ALL_MESSAGE_TYPES.length);
  });

  it('includes the Up Next mirror types (card down, interaction up)', () => {
    expect(UP_NEXT).toBe('up-next');
    expect(UP_NEXT_ACTION).toBe('up-next-action');
    expect(ALL_MESSAGE_TYPES).toContain(UP_NEXT);
    expect(ALL_MESSAGE_TYPES).toContain(UP_NEXT_ACTION);
    // show / thumb / tick / end / hide all ride the one UP_NEXT type.
    expect(makeMessage(UP_NEXT, { action: 'show', path: '/a.mp4', countdownSec: 10 }))
      .toEqual({ type: 'up-next', action: 'show', path: '/a.mp4', countdownSec: 10 });
    expect(makeMessage(UP_NEXT_ACTION, { action: 'play' }))
      .toEqual({ type: 'up-next-action', action: 'play' });
  });
});
