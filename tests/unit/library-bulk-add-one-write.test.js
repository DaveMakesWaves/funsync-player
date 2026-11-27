/**
 * The Library's bulk "Add to playlist" writes the whole selection in ONE
 * write (TODO triage 2026-11-23, perf, also in v0.9.2): one
 * addVideoToPlaylist per selected video rewrote config.json in main each
 * time, 7-14 ms apiece, so seconds for a few hundred. Both branches: an
 * existing playlist, and "create one first" when there are none.
 * jsdom: library.js imports DOM-touching modules (notes/CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { Modal } from '../../renderer/components/modal.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const PATHS = ['C:\\V\\a.mp4', 'C:\\V\\b.mp4', 'C:\\V\\c.mp4'];

function lib(playlists) {
  const l = Object.create(Library.prototype);
  l._selectedPaths = new Set(PATHS);
  l._settings = {
    getPlaylists: () => playlists,
    addPlaylist: vi.fn(async (name) => ({ id: 'new', name, videoPaths: [] })),
    addVideoToPlaylist: vi.fn(),
    addVideosToPlaylist: vi.fn(),
  };
  l._exitSelectMode = vi.fn();
  return l;
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  vi.restoreAllMocks();
});

describe('bulk Add to playlist', () => {
  it('an existing playlist: one batch write of the whole selection, never one per video', async () => {
    const l = lib([{ id: 'p1', name: 'Mix', videoPaths: [] }]);
    vi.spyOn(Modal, 'selectFromList').mockResolvedValue('p1');
    await l._bulkAddToPlaylist();
    expect(l._settings.addVideosToPlaylist).toHaveBeenCalledTimes(1);
    expect(l._settings.addVideosToPlaylist).toHaveBeenCalledWith('p1', PATHS);
    expect(l._settings.addVideoToPlaylist).not.toHaveBeenCalled();
    expect(l._exitSelectMode).toHaveBeenCalled();
  });

  it('no playlists yet: the new one gets the selection in one write too', async () => {
    const l = lib([]);
    vi.spyOn(Modal, 'prompt').mockResolvedValue('Fresh');
    await l._bulkAddToPlaylist();
    expect(l._settings.addVideosToPlaylist).toHaveBeenCalledWith('new', PATHS);
    expect(l._settings.addVideoToPlaylist).not.toHaveBeenCalled();
  });

  it('cancelled: nothing written, still selecting', async () => {
    const l = lib([{ id: 'p1', name: 'Mix', videoPaths: [] }]);
    vi.spyOn(Modal, 'selectFromList').mockResolvedValue(null);
    await l._bulkAddToPlaylist();
    expect(l._settings.addVideosToPlaylist).not.toHaveBeenCalled();
    expect(l._exitSelectMode).not.toHaveBeenCalled();
  });
});
