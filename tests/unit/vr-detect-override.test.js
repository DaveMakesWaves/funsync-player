import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isVRVideo, setOverrideStore } from '../../renderer/js/vr-detect.js';

describe('isVRVideo — manual override (renderer)', () => {
  afterEach(() => {
    // Reset to default no-op getter so other test files that import
    // vr-detect aren't affected by leaked override state.
    setOverrideStore(() => null);
  });

  it('returns true when override is "vr" even though heuristic says flat', () => {
    setOverrideStore((path) => path === '/foo/Plain.mp4' ? 'vr' : null);
    expect(isVRVideo({ path: '/foo/Plain.mp4', name: 'Plain.mp4' })).toBe(true);
  });

  it('returns false when override is "flat" even though heuristic says VR', () => {
    setOverrideStore((path) => path === '/foo/movie_sbs.mp4' ? 'flat' : null);
    expect(isVRVideo({ path: '/foo/movie_sbs.mp4', name: 'movie_sbs.mp4' })).toBe(false);
  });

  it('falls through to heuristic when override is null', () => {
    setOverrideStore(() => null);
    expect(isVRVideo({ path: '/foo/movie_sbs.mp4', name: 'movie_sbs.mp4' })).toBe(true);
    expect(isVRVideo({ path: '/foo/plain.mp4', name: 'plain.mp4' })).toBe(false);
  });

  it('skips override when called with a raw filename string (no path)', () => {
    // Override store keyed by '/foo/plain.mp4' — but raw-string callers
    // (filename-only checks in tests, web-remote display code) hit the
    // heuristic directly, by design.
    setOverrideStore((path) => path === '/foo/plain.mp4' ? 'vr' : null);
    expect(isVRVideo('plain.mp4')).toBe(false);
    expect(isVRVideo('movie_sbs.mp4')).toBe(true);
  });

  it('treats unknown override values as no override', () => {
    setOverrideStore(() => 'maybe');
    expect(isVRVideo({ path: '/foo/plain.mp4', name: 'plain.mp4' })).toBe(false);
    expect(isVRVideo({ path: '/foo/movie_sbs.mp4', name: 'movie_sbs.mp4' })).toBe(true);
  });

  it('uses video.name fallback when no path key is provided', () => {
    setOverrideStore(() => 'vr'); // would force VR if path were checked
    // Object without `path` skips the override branch — still hits heuristic.
    expect(isVRVideo({ name: 'plain.mp4' })).toBe(false);
  });

  it('reads override fresh each call (closure tracks latest state)', () => {
    let map = { '/v/clip.mp4': 'vr' };
    setOverrideStore((p) => map[p] || null);
    expect(isVRVideo({ path: '/v/clip.mp4', name: 'clip.mp4' })).toBe(true);
    map = {};
    expect(isVRVideo({ path: '/v/clip.mp4', name: 'clip.mp4' })).toBe(false);
  });

  it('non-function getter falls back to no override', () => {
    setOverrideStore(null);
    expect(isVRVideo({ path: '/foo/movie_sbs.mp4', name: 'movie_sbs.mp4' })).toBe(true);
    expect(isVRVideo({ path: '/foo/plain.mp4', name: 'plain.mp4' })).toBe(false);
  });
});
