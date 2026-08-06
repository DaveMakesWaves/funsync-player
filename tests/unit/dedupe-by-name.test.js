// "Hide duplicate names" — collapse videos sharing an identical filename.
//
// Dave, 2026-08-06, prompted by a 1471-video library where the same file
// sits in several source folders.
import { describe, it, expect } from 'vitest';
import { dedupeByName } from '../../renderer/js/library-search.js';

const v = (name, path, hasFunscript = false) => ({ name, path, hasFunscript });

describe('dedupeByName', () => {
  it('keeps one entry when the same filename appears twice', () => {
    const out = dedupeByName([
      v('Clip.mp4', 'D:/a/Clip.mp4'),
      v('Clip.mp4', 'E:/b/Clip.mp4'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('D:/a/Clip.mp4');
  });

  it('never hides a video entirely — one copy always survives', () => {
    // The whole point: this tidies the grid, it does not make content
    // unreachable.
    const out = dedupeByName([
      v('Clip.mp4', 'D:/a/Clip.mp4'),
      v('Clip.mp4', 'E:/b/Clip.mp4'),
      v('Clip.mp4', 'F:/c/Clip.mp4'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('prefers the copy that has a funscript', () => {
    const out = dedupeByName([
      v('Clip.mp4', 'D:/a/Clip.mp4', false),
      v('Clip.mp4', 'E:/b/Clip.mp4', true),
    ]);
    expect(out[0].path).toBe('E:/b/Clip.mp4');
  });

  it('keeps the scripted copy in the position of the first occurrence', () => {
    // Stability matters — the entry must not jump around the grid.
    const out = dedupeByName([
      v('Aaa.mp4', 'D:/Aaa.mp4'),
      v('Clip.mp4', 'D:/a/Clip.mp4', false),
      v('Zzz.mp4', 'D:/Zzz.mp4'),
      v('Clip.mp4', 'E:/b/Clip.mp4', true),
    ]);
    expect(out.map((x) => x.path)).toEqual(['D:/Aaa.mp4', 'E:/b/Clip.mp4', 'D:/Zzz.mp4']);
  });

  it('does not upgrade away from a scripted copy found first', () => {
    const out = dedupeByName([
      v('Clip.mp4', 'D:/a/Clip.mp4', true),
      v('Clip.mp4', 'E:/b/Clip.mp4', true),
    ]);
    expect(out[0].path).toBe('D:/a/Clip.mp4');
  });

  it('treats case differences as the same name', () => {
    // Windows filesystems are case-insensitive; to a user these are one file.
    const out = dedupeByName([v('Clip.mp4', 'D:/Clip.mp4'), v('CLIP.MP4', 'E:/CLIP.MP4')]);
    expect(out).toHaveLength(1);
  });

  it('does NOT merge different containers', () => {
    // `Clip.mp4` and `Clip.mkv` may be different encodes worth telling apart.
    const out = dedupeByName([v('Clip.mp4', 'D:/Clip.mp4'), v('Clip.mkv', 'D:/Clip.mkv')]);
    expect(out).toHaveLength(2);
  });

  it('leaves a list with no duplicates untouched', () => {
    const input = [v('A.mp4', 'D:/A.mp4'), v('B.mp4', 'D:/B.mp4')];
    expect(dedupeByName(input)).toEqual(input);
  });

  it('falls back to the filename from the path when name is absent', () => {
    const out = dedupeByName([
      { path: 'D:/a/Clip.mp4' },
      { path: 'E:/b/Clip.mp4' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('passes through entries with no usable name rather than collapsing them', () => {
    const out = dedupeByName([{}, {}, v('A.mp4', 'D:/A.mp4')]);
    expect(out).toHaveLength(3);
  });

  it('handles empty and malformed input', () => {
    expect(dedupeByName([])).toEqual([]);
    expect(dedupeByName(null)).toEqual([]);
    expect(dedupeByName([v('A.mp4', 'D:/A.mp4')])).toHaveLength(1);
  });
});
