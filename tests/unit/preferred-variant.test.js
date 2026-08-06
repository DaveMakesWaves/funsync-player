/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pins the per-video "preferred default variant" resolution logic from
// app.js (_getPreferredVariantLabel + _applyPreferredVariant index pick).
// Those methods live on the App class (full Electron/DOM harness makes a
// direct import hostile), so this mirrors the algorithm 1:1 — if you change
// the logic in app.js, mirror it here and keep these assertions green.
//
// Feature: lr_x3 request — let a user pin a non-default script variant (e.g.
// the "(full)" cock-hero script) as the remembered default for a video.

import { describe, it, expect } from 'vitest';

// Mirror of App._getPreferredVariantLabel (read path + filename fallback).
function getPreferredLabel(map, videoPath) {
  if (!videoPath) return null;
  if (map[videoPath]) return map[videoPath];
  const videoName = videoPath.split(/[\\/]/).pop().toLowerCase();
  for (const [oldPath, label] of Object.entries(map)) {
    if (oldPath === videoPath) continue;
    if (oldPath.split(/[\\/]/).pop().toLowerCase() === videoName && label) {
      return label; // (real code also rehomes the key onto videoPath)
    }
  }
  return null;
}

// Mirror of App._applyPreferredVariant's index decision. Returns the index
// to switch to, or -1 for "leave the auto-default in place".
function resolvePreferredIndex(variants, preferredLabel) {
  if (!variants || variants.length < 2) return -1;
  if (!preferredLabel) return -1;
  const idx = variants.findIndex(v => (v.label || '').trim() === preferredLabel.trim());
  return idx <= 0 ? -1 : idx; // not found, or already the default → no switch
}

describe('Preferred variant — label lookup', () => {
  it('returns the exact-path preference', () => {
    const map = { 'C:/vids/ch.mp4': 'full' };
    expect(getPreferredLabel(map, 'C:/vids/ch.mp4')).toBe('full');
  });

  it('falls back to filename match across a changed path (drive letter)', () => {
    const map = { 'C:/vids/ch.mp4': 'full' };
    expect(getPreferredLabel(map, 'D:/vids/ch.mp4')).toBe('full');
  });

  it('filename fallback is case-insensitive', () => {
    const map = { 'C:/vids/CH.mp4': 'full' };
    expect(getPreferredLabel(map, 'D:/other/ch.mp4')).toBe('full');
  });

  it('returns null when nothing matches', () => {
    const map = { 'C:/vids/other.mp4': 'full' };
    expect(getPreferredLabel(map, 'C:/vids/ch.mp4')).toBe(null);
  });

  it('returns null for an empty path', () => {
    expect(getPreferredLabel({ 'a.mp4': 'x' }, '')).toBe(null);
  });
});

describe('Preferred variant — index resolution', () => {
  const variants = [
    { label: 'Default', path: '/a/ch.funscript' },
    { label: 'full', path: '/a/ch (full).funscript' },
  ];

  it('picks the pinned non-default variant', () => {
    expect(resolvePreferredIndex(variants, 'full')).toBe(1);
  });

  it('no switch when the pinned label is the auto-default (index 0)', () => {
    expect(resolvePreferredIndex(variants, 'Default')).toBe(-1);
  });

  it('no switch when the pinned label is missing (file moved/renamed)', () => {
    expect(resolvePreferredIndex(variants, 'extended')).toBe(-1);
  });

  it('no switch with no preference set', () => {
    expect(resolvePreferredIndex(variants, null)).toBe(-1);
  });

  it('no switch when only one variant exists', () => {
    expect(resolvePreferredIndex([{ label: 'Default' }], 'Default')).toBe(-1);
  });

  it('tolerates surrounding whitespace on the stored label', () => {
    expect(resolvePreferredIndex(variants, '  full ')).toBe(1);
  });
});
