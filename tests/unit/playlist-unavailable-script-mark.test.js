// Test day 2026-11-26 (B103): a playlist's script entry whose file cannot be
// found (renamed, moved) showed its "unavailable" badge right over the tile's
// "Script" mark: both were placed at top 6px / left 6px. The mark now moves
// beside the badge on an unavailable entry. jsdom has no layout, so this
// reads the two rules' numbers and checks the boxes no longer overlap.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const PLAYLISTS = fs.readFileSync('renderer/styles/playlists.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const TILE = fs.readFileSync('renderer/styles/no-video-tile.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) return null;
  return Object.fromEntries(m[1].split(';').map((d) => d.split(':').map((x) => x.trim())).filter(([k, v]) => k && v));
}
const px = (v) => Number(String(v).replace('px', ''));

describe('an unavailable script entry: badge and "Script" mark side by side (B103)', () => {
  it('the mark starts right of the badge, with a gap', () => {
    const badge = rule(PLAYLISTS, '.playlists__unavailable-badge');
    const mark = rule(TILE, '.library__thumb-novideo-mark');
    const moved = rule(PLAYLISTS, '.playlists__video--unavailable .library__thumb-novideo-mark');
    expect(badge).not.toBeNull();
    expect(mark).not.toBeNull();
    // Without the override both sit in the same corner: the overlap this guards.
    expect(px(mark.left)).toBeLessThan(px(badge.left) + px(badge.width));
    expect(moved).not.toBeNull();
    expect(px(moved.left)).toBeGreaterThanOrEqual(px(badge.left) + px(badge.width) + 4);
  });

  it('vertically centred on the badge (an 18 px mark beside a 22 px badge)', () => {
    const badge = rule(PLAYLISTS, '.playlists__unavailable-badge');
    const moved = rule(PLAYLISTS, '.playlists__video--unavailable .library__thumb-novideo-mark');
    const badgeMid = px(badge.top) + px(badge.height) / 2;
    expect(Math.abs(px(moved.top) + 9 - badgeMid)).toBeLessThanOrEqual(1);
  });
});
