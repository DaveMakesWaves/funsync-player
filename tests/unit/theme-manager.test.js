// Tests for theme-manager — the desktop's light/dark/system theme
// resolver and applier. The interesting behaviours to pin down:
//
//   1. resolveEffectiveTheme is pure and respects the three valid
//      values (system / dark / light), defaulting on garbage input.
//   2. 'system' branches on prefersDark; defaults to dark when the
//      preference is undefined (safer than light — pre-redesign UI
//      was always dark).
//   3. applyTheme writes data-theme on <html>; doesn't run on bad
//      input.
//   4. initTheme sets the right initial theme based on stored setting
//      + matchMedia, and reapplies on settings:changed.
//   5. When setting is 'system', a matchMedia change event re-applies.
//
// We mock matchMedia so the tests are deterministic across environments.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveEffectiveTheme, applyTheme, initTheme, _resetForTests } from '../../renderer/js/theme-manager.js';
import { eventBus } from '../../renderer/js/event-bus.js';

function mockMatchMedia(prefersDark) {
  let listener = null;
  const mq = {
    matches: prefersDark,
    addEventListener: vi.fn((_, cb) => { listener = cb; }),
    removeEventListener: vi.fn(),
    /** Test helper to fire the listener as if the OS theme flipped. */
    _fire: () => listener?.({ matches: !prefersDark }),
  };
  window.matchMedia = vi.fn(() => mq);
  return mq;
}

function makeDataService(initial = {}) {
  const store = { ...initial };
  return {
    get: vi.fn((key) => store[key]),
    set: vi.fn((key, value) => { store[key] = value; }),
  };
}

beforeEach(() => {
  _resetForTests();
  document.documentElement.removeAttribute('data-theme');
  // Reset eventBus listeners between tests so theme-manager re-init
  // doesn't accumulate handlers from prior runs.
  if (eventBus._events) eventBus._events.clear();
});

describe('resolveEffectiveTheme', () => {
  it('returns "dark" when setting is "dark"', () => {
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('dark', true)).toBe('dark');
  });

  it('returns "light" when setting is "light"', () => {
    expect(resolveEffectiveTheme('light', false)).toBe('light');
    expect(resolveEffectiveTheme('light', true)).toBe('light');
  });

  it('returns OS preference when setting is "system"', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });

  it('defaults to dark on garbage / unknown setting', () => {
    expect(resolveEffectiveTheme('purple', true)).toBe('dark');
    expect(resolveEffectiveTheme(undefined, false)).toBe('light');
  });

  it('"system" with undefined prefersDark falls back to dark (safer than light)', () => {
    // Pre-redesign default was dark; first-frame fallback should match
    // so cold starts don't flash light then dark.
    expect(resolveEffectiveTheme('system', undefined)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme="dark" on <html>', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('sets data-theme="light" on <html>', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('does nothing on invalid input (defensive against typos)', () => {
    applyTheme('dark');
    applyTheme('invalid');
    // Stays as the previous valid value — no clobber to undefined.
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('initTheme', () => {
  it('applies dark when stored setting is "dark" regardless of OS', () => {
    mockMatchMedia(false); // OS is light
    const ds = makeDataService({ 'player.theme': 'dark' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies light when stored setting is "light" regardless of OS', () => {
    mockMatchMedia(true); // OS is dark
    const ds = makeDataService({ 'player.theme': 'light' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies OS preference when stored setting is "system" or missing', () => {
    mockMatchMedia(true);
    const ds = makeDataService({ 'player.theme': 'system' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('dark');

    _resetForTests();
    mockMatchMedia(false);
    const ds2 = makeDataService(); // no stored setting → defaults to system
    initTheme(ds2);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reapplies on settings:changed when path is player.theme', () => {
    mockMatchMedia(true);
    const ds = makeDataService({ 'player.theme': 'dark' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('dark');

    // Simulate a settings panel change.
    ds.set('player.theme', 'light');
    eventBus.emit('settings:changed', { path: 'player.theme', value: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores settings:changed for unrelated paths', () => {
    mockMatchMedia(true);
    const ds = makeDataService({ 'player.theme': 'dark' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('dark');

    eventBus.emit('settings:changed', { path: 'player.volume', value: 50 });
    // Theme didn't reapply (no change to OS / setting).
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('reacts to OS theme changes when setting is "system"', () => {
    const mq = mockMatchMedia(true); // start dark
    const ds = makeDataService({ 'player.theme': 'system' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('dark');

    // OS flips to light. The MQ listener is wired by initTheme; firing
    // it should re-resolve via the same code path.
    mq.matches = false;
    mq._fire();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('does NOT react to OS changes when setting is fixed (dark/light)', () => {
    const mq = mockMatchMedia(true);
    const ds = makeDataService({ 'player.theme': 'dark' });
    initTheme(ds);
    expect(document.documentElement.dataset.theme).toBe('dark');

    // OS flips. Theme should stay dark because user explicitly chose dark.
    mq.matches = false;
    mq._fire();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('returns a cleanup function that detaches the OS listener', () => {
    const mq = mockMatchMedia(true);
    const ds = makeDataService({ 'player.theme': 'system' });
    const cleanup = initTheme(ds);
    expect(mq.addEventListener).toHaveBeenCalledTimes(1);

    cleanup();
    expect(mq.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
