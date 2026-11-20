/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// stash-store.js stashGroups(): the projection's `groups` map (Stash "next"
// lot #6, stage sn-main's contract), for the read-only "Stash: <group>"
// playlists. Driven through a fake main, as stash-store.test.js is.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STASH_API, stashGroups, onStashChanged, initStashStore, reloadStash,
  _resetStashStoreForTests, _setStashApiForTests,
} from '../../renderer/js/stash-store.js';

const GROUPS = { 1: { name: 'Synthetic Series A', sceneIds: ['2', '3', '1'], updatedAt: '2026-11-19T09:24:26Z' } };

function projection(rev, extra = {}) {
  return {
    v: 1, rev, server: { url: 'http://127.0.0.1:9999', version: 'v0.32.0' }, lastSync: null,
    links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {},
    ...extra,
  };
}

function fakeMain(data) {
  const main = { data, changed: null };
  const api = {};
  for (const name of Object.values(STASH_API)) api[name] = vi.fn(async () => ({ ok: true }));
  api[STASH_API.data] = vi.fn(async () => main.data);
  api[STASH_API.onChanged] = vi.fn((cb) => { main.changed = cb; return () => { main.changed = null; }; });
  _setStashApiForTests(api);
  return main;
}

beforeEach(() => _resetStashStoreForTests());
afterEach(() => _resetStashStoreForTests());

describe('stashGroups()', () => {
  it('null before anything is loaded', () => {
    expect(stashGroups()).toBeNull();
  });

  it('null for a projection without a groups map (an older library.json: unknown, not "no group")', async () => {
    fakeMain(projection(1));
    await initStashStore({ isEnabled: () => true });
    expect(stashGroups()).toBeNull();
  });

  it('the groups map main sent, frozen with the copy', async () => {
    fakeMain(projection(1, { groups: GROUPS }));
    await initStashStore({ isEnabled: () => true });
    expect(stashGroups()).toEqual(GROUPS);
    expect(Object.isFrozen(stashGroups())).toBe(true);
    expect(Object.isFrozen(stashGroups()['1'].sceneIds)).toBe(true);
  });

  it('a malformed groups map reads as none, and the rest of the projection still applies', async () => {
    fakeMain(projection(1, { groups: ['not', 'a', 'map'], links: { 'C:\\a.mp4': { sceneId: '1', state: 'ok' } } }));
    const changed = await initStashStore({ isEnabled: () => true });
    expect(changed).toBe(true);
    expect(stashGroups()).toBeNull();
  });

  it('follows main\'s next projection (a sync that renamed a group), and listeners are told', async () => {
    const main = fakeMain(projection(1, { groups: GROUPS }));
    await initStashStore({ isEnabled: () => true });
    const told = vi.fn();
    onStashChanged(told);
    main.data = projection(2, { groups: { 1: { ...GROUPS[1], name: 'Renamed in Stash' } } });
    await reloadStash();
    expect(told).toHaveBeenCalledTimes(1);
    expect(stashGroups()['1'].name).toBe('Renamed in Stash');
  });
});
