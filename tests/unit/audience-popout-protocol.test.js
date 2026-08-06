/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Audience pop-out protocol — message-type constants, envelope shape,
// classifier.
// SCOPE: notes/features/SCOPE-audience-broadcast.md §3.3 + §5.

import { describe, it, expect } from 'vitest';
import * as P from '../../renderer/js/audience-popout-protocol.js';

describe('makeMessage', () => {
  it('returns the envelope with type + merged fields', () => {
    expect(P.makeMessage(P.READY)).toEqual({ type: 'ready' });
    expect(P.makeMessage(P.SET_OFFSET, { key: 'A', offsetMs: 120 })).toEqual({
      type: 'set-offset', key: 'A', offsetMs: 120,
    });
  });

  it('preserves the type field when fields also include `type` (caller wins)', () => {
    // Defensive: caller's overriding type is allowed — we deliberately
    // merge in the named type first so a buggy call that passes `type`
    // in fields gets a predictable last-wins behavior.
    const msg = P.makeMessage(P.READY, { type: 'override', extra: 1 });
    expect(msg.type).toBe('override');
    expect(msg.extra).toBe(1);
  });
});

describe('classifyMessage', () => {
  it('returns the type string for a valid message', () => {
    expect(P.classifyMessage({ type: P.READY })).toBe('ready');
    expect(P.classifyMessage({ type: P.ADD_VIEWER, key: 'A' })).toBe('add-viewer');
  });

  it('returns null for malformed input', () => {
    expect(P.classifyMessage(null)).toBeNull();
    expect(P.classifyMessage(undefined)).toBeNull();
    expect(P.classifyMessage('not-an-object')).toBeNull();
    expect(P.classifyMessage({})).toBeNull();
    expect(P.classifyMessage({ type: 42 })).toBeNull();
  });
});

describe('message-type constants', () => {
  it('exports every advertised constant with a string value', () => {
    const expected = [
      'INITIAL_STATE', 'VIEWER_ADDED', 'VIEWER_REMOVED', 'VIEWER_STATUS', 'VIEWER_OFFSET',
      'HIDE_KEYS_CHANGED', 'THEME',
      'READY', 'ADD_VIEWER', 'REMOVE_VIEWER', 'SET_OFFSET', 'SET_MUTED',
      'TEST_BUZZ', 'TEST_BUZZ_ALL', 'SET_HIDE_KEYS', 'END_ROOM',
      'OP_BEGIN_BATCH', 'OP_END_BATCH',
    ];
    for (const name of expected) {
      expect(typeof P[name]).toBe('string');
      expect(P[name].length).toBeGreaterThan(0);
    }
  });

  it('constants are unique (no two names share the same wire value)', () => {
    const values = new Set();
    for (const v of P.ALL_MESSAGE_TYPES) {
      expect(values.has(v)).toBe(false);
      values.add(v);
    }
  });

  it('ALL_MESSAGE_TYPES is frozen', () => {
    expect(Object.isFrozen(P.ALL_MESSAGE_TYPES)).toBe(true);
  });
});
