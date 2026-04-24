import { describe, it, expect } from 'vitest';
import { buildFolderIndex, descendantsOf, breadcrumbOf } from '../../renderer/js/folder-index.js';

const sources = [
  { id: 's1', name: 'VR Drive', path: 'D:\\VR', enabled: true },
  { id: 's2', name: 'Downloads', path: 'C:\\Users\\me\\Downloads', enabled: true },
];

const videos = [
  { name: 'A.mp4', path: 'D:\\VR\\A.mp4' },
  { name: 'B.mp4', path: 'D:\\VR\\japanese\\B.mp4' },
  { name: 'C.mp4', path: 'D:\\VR\\japanese\\studio-x\\C.mp4' },
  { name: 'D.mp4', path: 'D:\\VR\\western\\D.mp4' },
  { name: 'E.mp4', path: 'C:\\Users\\me\\Downloads\\E.mp4' },
];

describe('buildFolderIndex', () => {
  it('creates a node for every source even when empty', () => {
    const index = buildFolderIndex([], sources);
    expect(index.has('d:/VR')).toBe(true);
    expect(index.has('c:/Users/me/Downloads')).toBe(true);
    expect(index.get('d:/VR').isSourceRoot).toBe(true);
    expect(index.get('d:/VR').sourceId).toBe('s1');
    expect(index.get('d:/VR').label).toBe('VR Drive');
  });

  it('places videos in their direct parent folder', () => {
    const index = buildFolderIndex(videos, sources);
    expect(index.get('d:/VR').videos.map(v => v.name)).toContain('A.mp4');
    expect(index.get('d:/VR/japanese').videos.map(v => v.name)).toContain('B.mp4');
    expect(index.get('d:/VR/japanese/studio-x').videos.map(v => v.name)).toContain('C.mp4');
    expect(index.get('d:/VR/western').videos.map(v => v.name)).toContain('D.mp4');
  });

  it('wires child-folder relationships up to the source root', () => {
    const index = buildFolderIndex(videos, sources);
    expect([...index.get('d:/VR').childFolders].sort())
      .toEqual(['d:/VR/japanese', 'd:/VR/western']);
    expect([...index.get('d:/VR/japanese').childFolders])
      .toEqual(['d:/VR/japanese/studio-x']);
  });

  it('records parent backpointers', () => {
    const index = buildFolderIndex(videos, sources);
    expect(index.get('d:/VR/japanese').parent).toBe('d:/VR');
    expect(index.get('d:/VR/japanese/studio-x').parent).toBe('d:/VR/japanese');
    expect(index.get('d:/VR').parent).toBe(null);
  });

  it('ignores sources flagged disabled', () => {
    const extended = [
      ...sources,
      { id: 's3', name: 'Archive', path: 'F:\\Archive', enabled: false },
    ];
    const index = buildFolderIndex([], extended);
    expect(index.has('f:/Archive')).toBe(false);
  });

  it('skips videos that do not belong to any source', () => {
    const orphan = { name: 'X.mp4', path: 'Z:\\Lost\\X.mp4' };
    const index = buildFolderIndex([orphan, ...videos], sources);
    expect(index.has('z:/Lost')).toBe(false);
    expect(descendantsOf(index, 'd:/VR').map(v => v.name)).not.toContain('X.mp4');
  });

  it('handles mixed separator styles identically', () => {
    const mixed = [{ name: 'Y.mp4', path: 'D:/VR/japanese/Y.mp4' }];
    const index = buildFolderIndex(mixed, sources);
    expect(index.get('d:/VR/japanese').videos.map(v => v.name)).toContain('Y.mp4');
  });
});

describe('descendantsOf', () => {
  it('flattens a folder and all its subtrees', () => {
    const index = buildFolderIndex(videos, sources);
    const names = descendantsOf(index, 'd:/VR').map(v => v.name).sort();
    expect(names).toEqual(['A.mp4', 'B.mp4', 'C.mp4', 'D.mp4']);
  });

  it('handles a leaf folder', () => {
    const index = buildFolderIndex(videos, sources);
    expect(descendantsOf(index, 'd:/VR/japanese/studio-x').map(v => v.name))
      .toEqual(['C.mp4']);
  });

  it('returns empty for unknown paths', () => {
    const index = buildFolderIndex(videos, sources);
    expect(descendantsOf(index, 'd:/does-not-exist')).toEqual([]);
  });
});

describe('breadcrumbOf', () => {
  it('builds a trail from source root to leaf', () => {
    const index = buildFolderIndex(videos, sources);
    const trail = breadcrumbOf(index, 'd:/VR/japanese/studio-x');
    expect(trail.map(c => c.label)).toEqual(['VR Drive', 'japanese', 'studio-x']);
    expect(trail[0].path).toBe('d:/VR');
    expect(trail[2].path).toBe('d:/VR/japanese/studio-x');
  });

  it('returns empty for an empty path', () => {
    const index = buildFolderIndex(videos, sources);
    expect(breadcrumbOf(index, '')).toEqual([]);
    expect(breadcrumbOf(index, null)).toEqual([]);
  });

  it('uses the source name at the root, not the filesystem basename', () => {
    const index = buildFolderIndex(videos, sources);
    const trail = breadcrumbOf(index, 'd:/VR');
    expect(trail[0].label).toBe('VR Drive');
  });
});
