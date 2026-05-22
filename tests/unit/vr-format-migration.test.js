// Schema migration tests for the new library.vrFormat shape.
//
// Old shape (kept indefinitely for downgrade safety):
//   library.vrFlatten[path] = 'left' | 'right'
//
// New shape:
//   library.vrFormat[path] = {
//     projection: 'sbs-half' | 'sbs-full' | 'tb-half' | 'tb-full' | 'flat',
//     eye:        'left' | 'right' | null,
//     zoom:        1.0,
//     source:      'auto' | 'manual',
//   }
//
// Migration is lazy — happens inside `_applyVRFlattenForCurrent` the
// first time a video is loaded after the upgrade. The old vrFlatten
// entry is NOT deleted (downgrade-safe).
//
// We can't easily import app.js (heavy DOM dependencies); the migration
// logic is mirrored as an inline function below and unit-tested for the
// behaviour the real method should match. The schema description is the
// contract.

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyStereoFormat, isFlattenableStereo } from '../../renderer/js/vr-detect.js';

function makeStore() {
  const data = { library: { vrFlatten: {}, vrFormat: {} } };
  return {
    get(key) {
      const parts = key.split('.');
      let cur = data;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
      }
      return cur;
    },
    set(key, value) {
      const parts = key.split('.');
      let cur = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    },
    _data: data,
  };
}

// Mirror of app.js::_maybeMigrateVRFlattenEntry — kept here as a pure
// function so the test exercises the contract without DOM scaffolding.
function migrate(store, path, detected) {
  if (!path) return;
  const formatMap = store.get('library.vrFormat') || {};
  if (formatMap[path]) return; // already migrated
  const old = (store.get('library.vrFlatten') || {})[path];
  if (old !== 'left' && old !== 'right') return;
  const projection = isFlattenableStereo(detected) ? detected : 'sbs-half';
  const next = { ...formatMap, [path]: {
    projection,
    eye: old,
    zoom: 1,
    source: 'auto',
  } };
  store.set('library.vrFormat', next);
}

describe('VR format migration (vrFlatten → vrFormat)', () => {
  let store;
  beforeEach(() => {
    store = makeStore();
  });

  it("'left' inflates with detected projection", () => {
    store.set('library.vrFlatten', { '/lib/foo_SBS.mp4': 'left' });
    migrate(store, '/lib/foo_SBS.mp4', classifyStereoFormat('/lib/foo_SBS.mp4'));
    expect(store.get('library.vrFormat')['/lib/foo_SBS.mp4']).toEqual({
      projection: 'sbs-half',
      eye: 'left',
      zoom: 1,
      source: 'auto',
    });
  });

  it("'right' inflates with detected projection", () => {
    store.set('library.vrFlatten', { '/lib/foo_TB.mp4': 'right' });
    migrate(store, '/lib/foo_TB.mp4', classifyStereoFormat('/lib/foo_TB.mp4'));
    expect(store.get('library.vrFormat')['/lib/foo_TB.mp4']).toEqual({
      projection: 'tb-half',
      eye: 'right',
      zoom: 1,
      source: 'auto',
    });
  });

  it('falls back to sbs-half when no projection detected', () => {
    store.set('library.vrFlatten', { '/lib/some_video.mp4': 'left' });
    migrate(store, '/lib/some_video.mp4', null);
    expect(store.get('library.vrFormat')['/lib/some_video.mp4'].projection).toBe('sbs-half');
  });

  it('idempotent — re-migration is a no-op', () => {
    store.set('library.vrFlatten', { '/lib/x_SBS.mp4': 'left' });
    migrate(store, '/lib/x_SBS.mp4', 'sbs-half');
    const after1 = store.get('library.vrFormat')['/lib/x_SBS.mp4'];
    migrate(store, '/lib/x_SBS.mp4', 'sbs-half');
    const after2 = store.get('library.vrFormat')['/lib/x_SBS.mp4'];
    expect(after2).toBe(after1); // same reference; map untouched
  });

  it('does not touch the old vrFlatten key (downgrade safety)', () => {
    const old = { '/lib/x_SBS.mp4': 'left', '/lib/y_TB.mp4': 'right' };
    store.set('library.vrFlatten', old);
    migrate(store, '/lib/x_SBS.mp4', 'sbs-half');
    expect(store.get('library.vrFlatten')).toEqual(old);
  });

  it('skips paths that already have a vrFormat entry', () => {
    store.set('library.vrFlatten', { '/lib/x_SBS.mp4': 'left' });
    store.set('library.vrFormat', { '/lib/x_SBS.mp4': {
      projection: 'tb-full', eye: 'right', zoom: 1.5, source: 'manual',
    } });
    migrate(store, '/lib/x_SBS.mp4', 'sbs-half');
    expect(store.get('library.vrFormat')['/lib/x_SBS.mp4'].projection).toBe('tb-full');
    expect(store.get('library.vrFormat')['/lib/x_SBS.mp4'].source).toBe('manual');
  });

  it('skips paths with no legacy entry (no orphan creation)', () => {
    migrate(store, '/lib/fresh.mp4', 'sbs-half');
    expect(store.get('library.vrFormat')['/lib/fresh.mp4']).toBeUndefined();
  });

  it('ignores garbage legacy values (e.g. accidental booleans)', () => {
    store.set('library.vrFlatten', { '/lib/x.mp4': true });
    migrate(store, '/lib/x.mp4', 'sbs-half');
    expect(store.get('library.vrFormat')['/lib/x.mp4']).toBeUndefined();
  });

  it('handles undefined path safely', () => {
    expect(() => migrate(store, undefined, null)).not.toThrow();
    expect(() => migrate(store, '', null)).not.toThrow();
  });

  it('migrates multiple entries independently', () => {
    store.set('library.vrFlatten', {
      '/lib/a_SBS.mp4': 'left',
      '/lib/b_TB.mp4': 'right',
      '/lib/c_LRF.mp4': 'left',
    });
    migrate(store, '/lib/a_SBS.mp4', 'sbs-half');
    migrate(store, '/lib/b_TB.mp4', 'tb-half');
    migrate(store, '/lib/c_LRF.mp4', 'sbs-full');
    const map = store.get('library.vrFormat');
    expect(map['/lib/a_SBS.mp4'].projection).toBe('sbs-half');
    expect(map['/lib/b_TB.mp4'].projection).toBe('tb-half');
    expect(map['/lib/c_LRF.mp4'].projection).toBe('sbs-full');
  });
});
