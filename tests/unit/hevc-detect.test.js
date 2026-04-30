// Unit tests for hevc-detect — the OS HEVC support probe + one-time
// install guidance toast. The interesting behaviours to pin down:
//
//   1. `osHasHevcSupport` reflects what `<video>.canPlayType` returns.
//   2. `maybeShowHevcGuidance` is a no-op when OS supports HEVC.
//   3. `maybeShowHevcGuidance` is a no-op when user has dismissed.
//   4. Within one session, the guidance shows AT MOST ONCE even if
//      maybeShowHevcGuidance is called many times (defends against
//      cross-component duplicate calls e.g. library + drag-drop).
//   5. Clicking "Don't show again" persists `notifications.hevcDismissed`
//      via dataService.set, so the next session stays quiet too.
//
// The toast helper itself is tested in toast.test.js — here we only
// care about the gating logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { osHasHevcSupport, maybeShowHevcGuidance, _resetForTests } from '../../renderer/js/hevc-detect.js';

function makeDataService(initial = {}) {
  const store = { ...initial };
  return {
    get: vi.fn((key) => store[key]),
    set: vi.fn((key, value) => { store[key] = value; }),
    _store: store,
  };
}

/** Stub the preload-injected platform identifier so tests can pick. */
function setPlatform(electronPlatform) {
  if (!window.funsync) window.funsync = {};
  window.funsync.platform = electronPlatform; // 'win32' | 'linux' | 'darwin'
  window.funsync.openExternal = vi.fn();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="toast-container"></div>';
  _resetForTests();
  // Default to Windows for tests that don't explicitly set a platform —
  // matches the original Windows-only test set.
  setPlatform('win32');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('osHasHevcSupport', () => {
  it('returns true when canPlayType says probably', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    expect(osHasHevcSupport()).toBe(true);
  });

  it('returns true when canPlayType says maybe', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    expect(osHasHevcSupport()).toBe(true);
  });

  it('returns false when canPlayType returns empty (no decoder)', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    expect(osHasHevcSupport()).toBe(false);
  });

  it('caches the result — only probes once per session', () => {
    const spy = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    osHasHevcSupport();
    osHasHevcSupport();
    osHasHevcSupport();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('maybeShowHevcGuidance', () => {
  it('shows nothing when OS supports HEVC', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const ds = makeDataService();
    maybeShowHevcGuidance(ds);
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });

  it('shows nothing when user has permanently dismissed', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const ds = makeDataService({ 'notifications.hevcDismissed': true });
    maybeShowHevcGuidance(ds);
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });

  it('shows the toast when OS lacks HEVC and not dismissed', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const ds = makeDataService();
    maybeShowHevcGuidance(ds);
    const toasts = document.querySelectorAll('.toast');
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toContain('HEVC');
  });

  it('shows AT MOST ONCE per session even on repeated calls', () => {
    // Defends against duplicate calls from multiple loadVideo paths
    // (drag-drop, library click, playlist Play All, etc.) — without the
    // session guard, every video load would re-toast.
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const ds = makeDataService();
    maybeShowHevcGuidance(ds);
    maybeShowHevcGuidance(ds);
    maybeShowHevcGuidance(ds);
    expect(document.querySelectorAll('.toast').length).toBe(1);
  });

  it('"Don\'t show again" link persists dismissal via dataService.set', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const ds = makeDataService();
    maybeShowHevcGuidance(ds);

    // Find the dismiss link by its visible text.
    const dismissLink = [...document.querySelectorAll('a')]
      .find(a => a.textContent.includes("Don't show again"));
    expect(dismissLink).toBeTruthy();

    dismissLink.click();
    expect(ds.set).toHaveBeenCalledWith('notifications.hevcDismissed', true);
  });

  it('survives a missing dataService (defensive — the helper should never crash on init order)', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    expect(() => maybeShowHevcGuidance(undefined)).not.toThrow();
    expect(() => maybeShowHevcGuidance(null)).not.toThrow();
  });
});

// --- Platform-aware guidance -----------------------------------------
//
// Each platform gets a different toast body because the install path is
// completely different: Microsoft Store on Windows, package manager on
// Linux, OS update on macOS. Pin which guidance fires per platform so
// a refactor can't silently regress us back to Windows-only copy that
// would confuse Linux/macOS users.

describe('platform-aware HEVC guidance', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
  });

  it('Windows: shows Microsoft Store deep-links (free + paid)', () => {
    setPlatform('win32');
    maybeShowHevcGuidance(makeDataService());
    const toast = document.querySelector('.toast');
    expect(toast.textContent).toContain('Microsoft');
    const links = [...toast.querySelectorAll('a')];
    const freeLink = links.find(a => a.textContent.includes('free version'));
    const paidLink = links.find(a => a.textContent.includes('Paid'));
    expect(freeLink).toBeTruthy();
    expect(paidLink).toBeTruthy();
    // Verify openExternal goes to the right Microsoft Store deep link.
    freeLink.click();
    expect(window.funsync.openExternal).toHaveBeenCalledWith(
      expect.stringContaining('apps.microsoft.com/detail/9n4wgh0z6vhq')
    );
  });

  it('Linux: shows VA-API package install commands per distro', () => {
    setPlatform('linux');
    maybeShowHevcGuidance(makeDataService());
    const toast = document.querySelector('.toast');
    const text = toast.textContent;
    // Should mention VA-API and the major distro package managers, NOT
    // Microsoft Store (which doesn't exist on Linux).
    expect(text).toContain('VA-API');
    expect(text).toContain('apt');
    expect(text).toContain('dnf');
    expect(text).toContain('pacman');
    expect(text).not.toContain('Microsoft');
    expect(text).not.toContain('OEM Windows');
    // Should include a help link (Arch wiki is the canonical reference).
    const link = toast.querySelector('a[href="#"]');
    expect(link).toBeTruthy();
    expect(link.textContent.toLowerCase()).toContain('hardware video acceleration');
  });

  it('macOS: explains the OS-version requirement (HEVC needs 10.13+)', () => {
    setPlatform('darwin');
    maybeShowHevcGuidance(makeDataService());
    const toast = document.querySelector('.toast');
    const text = toast.textContent;
    expect(text).toContain('macOS');
    expect(text).toMatch(/10\.13|VideoToolbox/);
    // No Linux or Windows-specific instructions should leak in.
    expect(text).not.toContain('Microsoft Store');
    expect(text).not.toContain('apt install');
  });

  it('all platforms acknowledge 8K HEVC may still stutter even with hardware decode', () => {
    // Honest expectations matter — no platform's guidance should
    // promise a fix for the 8K HEVC hardware limit.
    for (const plat of ['win32', 'linux', 'darwin']) {
      _resetForTests();
      document.body.innerHTML = '<div id="toast-container"></div>';
      setPlatform(plat);
      maybeShowHevcGuidance(makeDataService());
      const text = document.querySelector('.toast').textContent;
      expect(text, `platform ${plat} should mention 8K limit`).toMatch(/8K/);
    }
  });
});
