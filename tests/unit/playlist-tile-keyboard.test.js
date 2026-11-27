/**
 * A playlist tile (grid) or row (list) opens from the keyboard (TODO triage
 * 2026-11-23, also in v0.9.2): a keyboard user could Tab to its Rename and
 * Delete but never open the playlist, while the Stash group tiles already
 * opened on Enter / Space. A key pressed on a button INSIDE the tile is that
 * button's, never also "open".
 * jsdom: DOM elements and i18n.js (notes/CLAUDE.md "Test environments").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { Playlists } from '../../renderer/components/playlists.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PL = { id: 'p1', name: 'Favourites', videoPaths: ['C:\\V\\a.mp4'] };

function view() {
  const v = Object.create(Playlists.prototype);
  v._settings = { get: () => undefined, set: vi.fn(), deletePlaylist: vi.fn() };
  v._renderGrid = vi.fn();
  v._renderDetail = vi.fn();
  v._summariseProgress = () => ({ watched: 0, inProgress: 0, total: 1, remainingSeconds: 0 });
  v._showResumeProgress = () => true;
  v._playlistHasProgress = () => false;
  return v;
}
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  window.funsync = {};
});

for (const [kind, build] of [['grid tile', (v) => v._createPlaylistCard(PL)], ['list row', (v) => v._createPlaylistListItem(PL)]]) {
  describe(`a playlist ${kind}`, () => {
    it('is a tab stop named after the playlist; Enter and Space open it; other keys do not', () => {
      const v = view();
      const el = build(v);
      document.body.appendChild(el);
      expect(el.tabIndex).toBe(0);
      expect(el.getAttribute('role')).toBe('button');
      expect(el.getAttribute('aria-label')).toBe('Favourites');
      key(el, 'a');
      expect(v._renderDetail).not.toHaveBeenCalled();
      key(el, 'Enter');
      key(el, ' ');
      expect(v._renderDetail).toHaveBeenCalledTimes(2);
      expect(v._renderDetail).toHaveBeenCalledWith('p1');
      el.click();
      expect(v._renderDetail).toHaveBeenCalledTimes(3);
    });

    it('Enter on a button inside it (Rename, Delete, cover) is that button\'s, not "open"', () => {
      const v = view();
      const el = build(v);
      document.body.appendChild(el);
      const inner = el.querySelector('button');
      expect(inner).not.toBeNull();
      key(inner, 'Enter');
      expect(v._renderDetail).not.toHaveBeenCalled();
    });
  });
}
