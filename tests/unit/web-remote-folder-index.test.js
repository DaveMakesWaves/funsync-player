// Web-remote port of folder-index — parity check against the desktop
// version. The phone's module is a copy of renderer/js/folder-index.js
// (plus the canonicalPath helper inlined). This test locks in the
// contract so if someone edits the desktop module and forgets to port,
// the suite fails loudly instead of drifting silently.

import { describe, it, expect } from 'vitest';
import * as desktop from '../../renderer/js/folder-index.js';
import * as phone from '../../backend/web-remote/folder-index.js';

const sources = [
  { id: 's1', name: 'VR Drive', path: 'D:\\VR', enabled: true },
  { id: 's2', name: 'Downloads', path: 'C:\\Users\\me\\Downloads', enabled: true },
  { id: 's3', name: 'Off', path: 'E:\\hidden', enabled: false },
];

const videos = [
  { name: 'A.mp4', path: 'D:\\VR\\A.mp4' },
  { name: 'B.mp4', path: 'D:\\VR\\japanese\\B.mp4' },
  { name: 'C.mp4', path: 'D:\\VR\\japanese\\studio-x\\C.mp4' },
  { name: 'D.mp4', path: 'D:\\VR\\western\\D.mp4' },
  { name: 'E.mp4', path: 'C:\\Users\\me\\Downloads\\E.mp4' },
];

function snapshot(index) {
  // Serialise the index into a sorted plain-object form so .toEqual works
  // across two Map instances built independently.
  const out = {};
  for (const [k, v] of index) {
    out[k] = {
      path: v.path,
      label: v.label,
      parent: v.parent,
      childFolders: [...v.childFolders].sort(),
      videoNames: v.videos.map(x => x.name).sort(),
      isSourceRoot: v.isSourceRoot,
      sourceId: v.sourceId,
    };
  }
  return out;
}

describe('web-remote folder-index ↔ desktop parity', () => {
  it('buildFolderIndex output matches desktop byte-for-byte', () => {
    const d = snapshot(desktop.buildFolderIndex(videos, sources));
    const p = snapshot(phone.buildFolderIndex(videos, sources));
    expect(p).toEqual(d);
  });

  it('descendantsOf returns the same flat video list on both sides', () => {
    const dIdx = desktop.buildFolderIndex(videos, sources);
    const pIdx = phone.buildFolderIndex(videos, sources);

    for (const folder of ['d:/VR', 'd:/VR/japanese', 'c:/Users/me/Downloads']) {
      const dNames = desktop.descendantsOf(dIdx, folder).map(v => v.name).sort();
      const pNames = phone.descendantsOf(pIdx, folder).map(v => v.name).sort();
      expect(pNames).toEqual(dNames);
    }
  });

  it('breadcrumbOf emits identical trails', () => {
    const dIdx = desktop.buildFolderIndex(videos, sources);
    const pIdx = phone.buildFolderIndex(videos, sources);

    for (const folder of ['d:/VR/japanese/studio-x', 'c:/Users/me/Downloads']) {
      expect(phone.breadcrumbOf(pIdx, folder))
        .toEqual(desktop.breadcrumbOf(dIdx, folder));
    }
  });

  it('phone canonicalPath matches desktop for typical inputs', async () => {
    // The desktop version of this helper lives in path-utils.js — the
    // phone version was inlined into folder-index.js. Double-check they
    // agree on the edge cases folder-browse actually exercises.
    const { canonicalPath: desktopCanon } = await import('../../renderer/js/path-utils.js');
    const cases = [
      'D:\\VR\\japanese\\scene.mp4',
      '/home/user/Videos/',
      'c:/already/normalised/',
      '',
    ];
    for (const c of cases) {
      expect(phone.canonicalPath(c)).toBe(desktopCanon(c));
    }
  });

  it('phone commonAncestorOfFiles matches desktop', async () => {
    const { commonAncestorOfFiles: desktopAncestor } = await import('../../renderer/js/path-utils.js');
    const cases = [
      ['D:\\VR\\A.mp4', 'D:\\VR\\japanese\\B.mp4'],
      ['D:\\VR\\A.mp4', 'D:\\VR\\A.mp4'],  // single file
      ['D:\\VR\\A.mp4', 'C:\\other\\B.mp4'],  // different drives
      [],
      null,
    ];
    for (const c of cases) {
      expect(phone.commonAncestorOfFiles(c)).toBe(desktopAncestor(c));
    }
  });
});
