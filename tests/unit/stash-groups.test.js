/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash Groups as read-only playlists (Stash "next" lot #6; Dave 2026-11-19:
// "Kept in sync"): renderer/js/stash-groups.js derives the "Stash: <group>"
// playlists from main's projection (stage sn-main's contract: `groups:
// {[groupId]: {name, sceneIds, updatedAt}}`, each scene's `groups:
// [{groupId, sceneIndex}]`). The projection here is built from the local
// test Stash's recordings (tests/fixtures/stash/sn-*.response.json), with
// Group.scenes in the id order Stash answers it in.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  stashGroupPlaylists, stashGroupPlaylist, stashGroupPlaylistId, isStashGroupPlaylistId,
  STASH_GROUP_PLAYLIST_PREFIX,
} from '../../renderer/js/stash-groups.js';

const SERVER = 'http://127.0.0.1:9999';
const read = (name) => JSON.parse(fs.readFileSync(`tests/fixtures/stash/${name}`, 'utf8'));
const SCENES = read('sn-scenes.response.json').data.findScenes.scenes;
const GROUPS = read('sn-groups.response.json').data.findGroups.groups;

/** FunSync's copy of a Stash file: the same name in the user's own library folder. */
const lib = (stashPath) => `C:\\Lib\\${stashPath.split(/[\\/]/).pop()}`;

/**
 * A projection as main sends it: scenes 1-4 (the grouped ones), each linked
 * to its FunSync copy unless `unlinked`; the groups with `sceneIds` in the
 * order Stash's Group.scenes gave them (scene id order, NOT the group's).
 */
function projection({ unlinked = [], linkPatch = {}, groupPatch = {}, sceneIdsOf } = {}) {
  const scenes = {};
  const links = {};
  for (const s of SCENES.filter((x) => ['1', '2', '3', '4'].includes(x.id))) {
    scenes[s.id] = {
      id: s.id,
      title: s.title,
      groups: s.groups.map((g) => ({ groupId: g.group.id, sceneIndex: g.scene_index })),
    };
    if (unlinked.includes(s.id)) continue;
    const path = lib(s.files[0].path);
    links[path] = {
      sceneId: s.id, server: SERVER, by: 'oshash', state: 'ok',
      fp: { size: s.files[0].size ?? 1000, oshash: 'x' }, linkedAt: 1, ...(linkPatch[s.id] || {}),
    };
  }
  const groups = {};
  for (const g of GROUPS) {
    groups[g.id] = {
      name: g.name,
      sceneIds: sceneIdsOf ? sceneIdsOf(g) : g.scenes.map((s) => s.id),
      updatedAt: g.updated_at,
      ...(groupPatch[g.id] || {}),
    };
  }
  return {
    v: 1, rev: 3, server: { url: SERVER, version: 'v0.32.0' }, lastSync: { at: 1, kind: 'full', ok: true },
    links, check: {}, refused: {}, scenes, performers: {}, studios: {}, tags: {}, groups,
  };
}

const pathOf = (id) => lib(SCENES.find((s) => s.id === id).files[0].path);
const order = (pl) => pl.entries.map((e) => e.sceneId);
const ON = { enabled: true };

describe('Stash group playlists: Stash\'s order and the linked videos', () => {
  it('orders each group by scene_index, not by the id order Group.scenes comes in (A: 2, 3, 1; B: 4, 1)', () => {
    // The recording itself says Group.scenes is id order.
    expect(GROUPS.find((g) => g.id === '1').scenes.map((s) => s.id)).toEqual(['1', '2', '3']);
    const [a, b] = stashGroupPlaylists(projection(), ON);
    expect(a.name).toBe('Synthetic Series A');
    expect(order(a)).toEqual(['2', '3', '1']);
    expect(a.videoPaths).toEqual([pathOf('2'), pathOf('3'), pathOf('1')]);
    expect(b.name).toBe('Synthetic Series B');
    expect(order(b)).toEqual(['4', '1']);
    expect(b.videoPaths).toEqual([pathOf('4'), pathOf('1')]);
  });

  it('scene 1 is in both groups, so its video is in both playlists', () => {
    const [a, b] = stashGroupPlaylists(projection(), ON);
    expect(a.videoPaths).toContain(pathOf('1'));
    expect(b.videoPaths).toContain(pathOf('1'));
  });

  it('keeps main\'s order when a member\'s place in the group is unknown', () => {
    const data = projection({ sceneIdsOf: (g) => (g.id === '1' ? ['3', '1', '2'] : ['4', '1']) });
    data.scenes['2'] = { ...data.scenes['2'], groups: [] };
    const a = stashGroupPlaylist(data, stashGroupPlaylistId('1'), ON);
    expect(order(a)).toEqual(['3', '1', '2']);
  });

  it('ids are opaque strings: another server\'s `<id>@<key>` form is a group id like any other', () => {
    const data = projection();
    data.groups['5@http://nas:9999'] = { name: 'Old NAS group', sceneIds: ['1'], updatedAt: null };
    const pl = stashGroupPlaylist(data, 'stash-group:5@http://nas:9999', ON);
    expect(pl?.groupId).toBe('5@http://nas:9999');
    expect(isStashGroupPlaylistId(pl.id)).toBe(true);
  });
});

describe('a scene with no linked library video is shown as missing, never invented', () => {
  it('an unlinked scene keeps its place with no path and its Stash title', () => {
    const b = stashGroupPlaylist(projection({ unlinked: ['4'] }), 'stash-group:2', ON);
    expect(b.entries).toEqual([
      { sceneId: '4', path: null, title: '' },
      { sceneId: '1', path: pathOf('1'), title: 'Synthetic Scene Small' },
    ]);
    expect(b.videoPaths).toEqual([pathOf('1')]);
    expect(b.missing).toBe(1);
  });

  it('a link whose data does not count, of another server, or to a file of another size plays nothing', () => {
    const data = projection({
      linkPatch: {
        2: { state: 'changed' },
        3: { server: 'http://nas:9999' },
        1: { fp: { size: 5, oshash: 'x' } },
      },
    });
    const sizes = SCENES.filter((s) => ['1', '2', '3', '4'].includes(s.id))
      .map((s) => ({ path: lib(s.files[0].path), size: s.files[0].size ?? 1000 }));
    const lists = stashGroupPlaylists(data, { enabled: true, videos: sizes });
    // Group A has none of its videos left: not shown. B keeps scene 4 only.
    expect(lists.map((pl) => pl.groupId)).toEqual(['2']);
    expect(lists[0].entries.map((e) => [e.sceneId, e.path])).toEqual([['4', pathOf('4')], ['1', null]]);
    // Nothing that is not a link's own path ever appears.
    const linkPaths = new Set(Object.keys(data.links));
    for (const pl of lists) for (const p of pl.videoPaths) expect(linkPaths.has(p)).toBe(true);
  });

  it('once the library is scanned, a linked file the library does not hold is missing', () => {
    const videos = [{ path: pathOf('2') }, { path: pathOf('3') }];
    const [a] = stashGroupPlaylists(projection(), { enabled: true, videos });
    expect(a.entries.map((e) => e.path)).toEqual([pathOf('2'), pathOf('3'), null]);
  });

  it('before the first scan (no videos yet) the links are taken as they are', () => {
    const lists = stashGroupPlaylists(projection(), { enabled: true, videos: [] });
    expect(lists[0].videoPaths).toHaveLength(3);
  });

  it('one video per scene: an ok link before a gone one, then path order', () => {
    const data = projection();
    data.links['C:\\Lib\\aaa copy.mp4'] = { ...data.links[pathOf('1')], state: 'gone' };
    data.links['C:\\Lib\\zzz copy.mp4'] = { ...data.links[pathOf('1')] };
    const a = stashGroupPlaylist(data, 'stash-group:1', ON);
    expect(a.entries.find((e) => e.sceneId === '1').path).toBe(pathOf('1')); // 'C:\Lib\Synthetic…' < 'C:\Lib\zzz…'
    expect(a.videoPaths).toHaveLength(3);
  });
});

describe('when there are none', () => {
  it('Stash off: none, whatever the data holds', () => {
    expect(stashGroupPlaylists(projection(), { enabled: false })).toEqual([]);
    expect(stashGroupPlaylists(projection(), {})).toEqual([]);
  });

  it('an older library.json without a groups map: none (unknown), and nothing thrown', () => {
    const data = projection();
    delete data.groups;
    expect(stashGroupPlaylists(data, ON)).toEqual([]);
    expect(stashGroupPlaylists(null, ON)).toEqual([]);
    expect(stashGroupPlaylists({ ...projection(), groups: [] }, ON)).toEqual([]);
  });

  it('a malformed group is skipped, the others stay', () => {
    const data = projection({ groupPatch: { 2: { sceneIds: 'nope' } } });
    data.groups['9'] = 'not a group';
    expect(stashGroupPlaylists(data, ON).map((pl) => pl.groupId)).toEqual(['1']);
  });

  it('a group with no linked video, and a group of another server, are not shown', () => {
    const data = projection({ unlinked: ['4'], groupPatch: { 1: { server: 'http://nas:9999' } } });
    data.groups['3'] = { name: 'Nothing of mine', sceneIds: ['77'], updatedAt: null };
    expect(stashGroupPlaylists(data, ON).map((pl) => pl.groupId)).toEqual(['2']);
  });
});

describe('derived, never stored', () => {
  it('frozen results, sorted by name, and the data is not touched', () => {
    const data = projection();
    const before = JSON.stringify(data);
    const lists = stashGroupPlaylists(data, ON);
    expect(lists.map((pl) => pl.name)).toEqual(['Synthetic Series A', 'Synthetic Series B']);
    expect(Object.isFrozen(lists)).toBe(true);
    expect(Object.isFrozen(lists[0])).toBe(true);
    expect(Object.isFrozen(lists[0].videoPaths)).toBe(true);
    expect(lists.every((pl) => pl.readOnly === true)).toBe(true);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('playlist ids are `stash-group:<groupId>` and never look like a user playlist id', () => {
    expect(STASH_GROUP_PLAYLIST_PREFIX).toBe('stash-group:');
    expect(stashGroupPlaylistId('1')).toBe('stash-group:1');
    expect(stashGroupPlaylistId('')).toBeNull();
    expect(isStashGroupPlaylistId('stash-group:1')).toBe(true);
    expect(isStashGroupPlaylistId('stash-group:')).toBe(false);
    expect(isStashGroupPlaylistId('pl-1700000000000')).toBe(false);
    expect(stashGroupPlaylist(projection(), 'pl-1', ON)).toBeNull();
  });
});
