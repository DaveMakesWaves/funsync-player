/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Library source state: user intent vs runtime reachability.
//
// Community report (lnlytrckr, EroScripts #251/#255): a source on an offline
// NAS froze the app every 20-30s even with the source switched OFF, because
// the availability probe ignored the toggle and used a blocking existsSync on
// a dead Z: mapping. Deleting the source was the only escape.
//
// The invariant these tests exist to hold, and the one that is easiest to
// break later: **`enabled` is written by the user and nobody else.** Auto
// disabling an unreachable source by writing `enabled = false` would destroy
// the user's intent, and reconnecting the drive could not restore it.
import { describe, it, expect } from 'vitest';
import {
  isUserEnabled,
  isReachable,
  isEffectivelyActive,
  toggleState,
  isToggleLocked,
  setUserEnabled,
  sourcesToProbe,
} from '../../renderer/js/source-state.js';

const src = (id, path, enabled) => ({ id, name: id, path, ...(enabled === undefined ? {} : { enabled }) });
const NAS = 'Z:\\media';
const LOCAL = 'C:\\videos';

describe('isUserEnabled', () => {
  it('treats a missing flag as enabled (historical default)', () => {
    expect(isUserEnabled(src('a', LOCAL))).toBe(true);
  });
  it('honours an explicit false', () => {
    expect(isUserEnabled(src('a', LOCAL, false))).toBe(false);
  });
});

describe('isReachable', () => {
  // Fail open: a source must not flash as locked during the first probe, and
  // a probe that never lands must not hide a working library.
  it('treats unknown (not yet probed) as reachable', () => {
    expect(isReachable(src('a', LOCAL), null)).toBe(true);
  });
  it('is false only when the path is in the unreachable set', () => {
    const out = new Set([NAS]);
    expect(isReachable(src('a', NAS), out)).toBe(false);
    expect(isReachable(src('b', LOCAL), out)).toBe(true);
  });
});

describe('isEffectivelyActive', () => {
  const out = new Set([NAS]);
  it('needs both enabled AND reachable', () => {
    expect(isEffectivelyActive(src('a', LOCAL), out)).toBe(true);
    expect(isEffectivelyActive(src('b', LOCAL, false), out)).toBe(false);
    expect(isEffectivelyActive(src('c', NAS), out)).toBe(false);
    expect(isEffectivelyActive(src('d', NAS, false), out)).toBe(false);
  });
});

describe('toggleState', () => {
  const out = new Set([NAS]);
  // Three states, not two. "Off because I chose that" and "off because the
  // drive is missing" must not present identically.
  it('distinguishes off from unreachable', () => {
    expect(toggleState(src('a', LOCAL), out)).toBe('active');
    expect(toggleState(src('b', LOCAL, false), out)).toBe('off');
    expect(toggleState(src('c', NAS), out)).toBe('unreachable');
  });
  it('reports unreachable even when the user had it enabled', () => {
    expect(toggleState(src('c', NAS, true), out)).toBe('unreachable');
  });
});

describe('setUserEnabled', () => {
  it('does not mutate the input array', () => {
    const list = [src('a', LOCAL)];
    const res = setUserEnabled(list, 'a', false, new Set());
    expect(list[0].enabled).toBeUndefined();
    expect(res.sources[0].enabled).toBe(false);
  });

  it('toggles when no explicit value is given', () => {
    const res = setUserEnabled([src('a', LOCAL)], 'a', undefined, new Set());
    expect(res.enabled).toBe(false);
    expect(res.changed).toBe(true);
  });

  it('reports no change when the value already matches', () => {
    const res = setUserEnabled([src('a', LOCAL, true)], 'a', true, new Set());
    expect(res.changed).toBe(false);
  });

  it('is a no-op for an unknown id', () => {
    const res = setUserEnabled([src('a', LOCAL)], 'nope', false, new Set());
    expect(res.changed).toBe(false);
  });

  // THE regression guard.
  it('REFUSES to change an unreachable source', () => {
    const list = [src('a', NAS, true)];
    const res = setUserEnabled(list, 'a', false, new Set([NAS]));
    expect(res.changed).toBe(false);
    expect(res.sources[0].enabled).toBe(true);
  });
});

describe('the user setting survives an unreachable session', () => {
  // Dave's requirement, spelled out: enabled -> unreachable session ->
  // reachable again must come back ENABLED, not disabled.
  it('enabled, then unreachable, then reachable again = still enabled', () => {
    let sources = [src('a', NAS, true)];

    // Session 2: drive is gone. Nothing may write `enabled`.
    const gone = new Set([NAS]);
    expect(isEffectivelyActive(sources[0], gone)).toBe(false);
    expect(toggleState(sources[0], gone)).toBe('unreachable');
    const attempted = setUserEnabled(sources, 'a', false, gone); // e.g. a stray click
    sources = attempted.sources;
    expect(sources[0].enabled).toBe(true); // untouched

    // Session 3: drive is back.
    expect(isEffectivelyActive(sources[0], new Set())).toBe(true);
    expect(toggleState(sources[0], new Set())).toBe('active');
  });

  it('user-disabled, then unreachable, then reachable again = still disabled', () => {
    let sources = [src('a', NAS, true)];
    sources = setUserEnabled(sources, 'a', false, new Set()).sources; // user turns it off
    expect(sources[0].enabled).toBe(false);

    const gone = new Set([NAS]);
    sources = setUserEnabled(sources, 'a', true, gone).sources; // cannot be re-enabled while away
    expect(sources[0].enabled).toBe(false);

    expect(toggleState(sources[0], new Set())).toBe('off'); // back, still off
  });
});

describe('sourcesToProbe', () => {
  // The actual fix for the reported freeze.
  it('never probes a source the user disabled', () => {
    const list = [src('a', LOCAL), src('b', NAS, false)];
    expect(sourcesToProbe(list).map((s) => s.id)).toEqual(['a']);
  });

  it('skips entries with no usable path', () => {
    const list = [src('a', ''), { id: 'b' }, null, src('c', LOCAL)];
    expect(sourcesToProbe(list).map((s) => s.id)).toEqual(['c']);
  });

  it('handles a missing list', () => {
    expect(sourcesToProbe(undefined)).toEqual([]);
  });
});
