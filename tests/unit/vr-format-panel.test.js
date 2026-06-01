// Tests for the VR Format panel's pure helpers — buildEntry and
// applyToFolder. The full Modal-rendering panel is exercised manually
// in QA; here we cover the data-shaping and IO-orchestration logic
// that's most likely to harbour subtle bugs.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildEntry, applyToFolder } from '../../renderer/components/vr-format-panel.js';

// Modal.open is called by the confirmation dialog inside applyToFolder.
// Replace it with a controllable double for the duration of the test.
vi.mock('../../renderer/components/modal.js', () => ({
  Modal: {
    _resolveWith: true,
    open(opts) {
      // Simulate the confirm dialog by calling onRender then resolving
      // immediately with the rigged value.
      if (typeof opts.onRender === 'function') {
        const body = document.createElement('div');
        opts.onRender(body, () => {});
      }
      return Promise.resolve(this._resolveWith);
    },
  },
}));

vi.mock('../../renderer/js/toast.js', () => ({
  showToast: vi.fn(),
}));

function makeDataService(initial = {}) {
  const data = { library: { vrFormat: { ...initial } } };
  return {
    get(key) {
      if (key === 'library.vrFormat') return data.library.vrFormat;
      return undefined;
    },
    set(key, value) {
      if (key === 'library.vrFormat') data.library.vrFormat = value;
    },
    _data: data,
  };
}

describe('buildEntry', () => {
  it("'flat' projection clears eye and zoom", () => {
    expect(buildEntry({ projection: 'flat', eye: 'left', zoom: 1.5 })).toEqual({
      projection: 'flat',
      eye: null,
      zoom: 1,
      fov: 90,
      yaw: 0,
      pitch: 0,
      roll: 0,
      source: 'manual',
    });
  });

  it('clamps fov to [30, 160]', () => {
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', fov: 10 }).fov).toBe(30);
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', fov: 90 }).fov).toBe(90);
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', fov: 200 }).fov).toBe(160);
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', fov: NaN }).fov).toBe(90);
  });

  it('clamps pitch to [-85, 85]', () => {
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', pitch: 100 }).pitch).toBe(85);
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', pitch: -100 }).pitch).toBe(-85);
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', pitch: 30 }).pitch).toBe(30);
  });

  it('normalises eye — defaults to left, accepts right', () => {
    expect(buildEntry({ projection: 'sbs-half', eye: 'right', zoom: 1 }).eye).toBe('right');
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: 1 }).eye).toBe('left');
    expect(buildEntry({ projection: 'sbs-half', eye: 'whatever', zoom: 1 }).eye).toBe('left');
  });

  it('clamps zoom to [1, 2]', () => {
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: 0.5 }).zoom).toBe(1);
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: 1.5 }).zoom).toBe(1.5);
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: 3 }).zoom).toBe(2);
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: NaN }).zoom).toBe(1);
  });

  it("source defaults to 'manual'", () => {
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: 1 }).source).toBe('manual');
    expect(buildEntry({ projection: 'sbs-half', eye: 'left', zoom: 1, source: 'auto' }).source).toBe('auto');
  });

  it("roll defaults to 0 and persists supplied value", () => {
    expect(buildEntry({ projection: 'equirect-180', eye: 'left' }).roll).toBe(0);
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', roll: 180 }).roll).toBe(180);
    expect(buildEntry({ projection: 'flat' }).roll).toBe(0);
    // Non-finite -> 0
    expect(buildEntry({ projection: 'equirect-180', eye: 'left', roll: NaN }).roll).toBe(0);
  });
});

describe('applyToFolder', () => {
  let ds, modal;

  beforeEach(async () => {
    ds = makeDataService();
    const m = await import('../../renderer/components/modal.js');
    modal = m.Modal;
    modal._resolveWith = true;
  });

  it('writes the entry to every sibling video in the folder', async () => {
    const enumerate = vi.fn(async () => [
      '/lib/dir/a.mp4',
      '/lib/dir/b.mp4',
      '/lib/dir/c.mp4',
    ]);
    const entry = { projection: 'sbs-half', eye: 'left', zoom: 1, source: 'manual' };

    const result = await applyToFolder({
      path: '/lib/dir/a.mp4',
      entry,
      dataService: ds,
      enumerateFolderVideos: enumerate,
    });

    expect(result.cancelled).toBe(false);
    expect(result.applied).toBe(3);
    const map = ds.get('library.vrFormat');
    expect(map['/lib/dir/a.mp4']).toEqual(entry);
    expect(map['/lib/dir/b.mp4']).toEqual(entry);
    expect(map['/lib/dir/c.mp4']).toEqual(entry);
  });

  it('returns cancelled when the user clicks Cancel', async () => {
    modal._resolveWith = false;
    const enumerate = vi.fn(async () => ['/lib/dir/a.mp4', '/lib/dir/b.mp4']);
    const result = await applyToFolder({
      path: '/lib/dir/a.mp4',
      entry: { projection: 'sbs-half', eye: 'left', zoom: 1, source: 'manual' },
      dataService: ds,
      enumerateFolderVideos: enumerate,
    });
    expect(result.cancelled).toBe(true);
    expect(result.applied).toBe(0);
    expect(ds.get('library.vrFormat')).toEqual({});
  });

  it('overwrites existing entries (default policy, surfaced in confirmation)', async () => {
    ds = makeDataService({
      '/lib/dir/a.mp4': { projection: 'tb-full', eye: 'right', zoom: 1, source: 'manual' },
    });
    const enumerate = vi.fn(async () => ['/lib/dir/a.mp4', '/lib/dir/b.mp4']);
    const entry = { projection: 'sbs-half', eye: 'left', zoom: 1, source: 'manual' };

    await applyToFolder({
      path: '/lib/dir/b.mp4',
      entry,
      dataService: ds,
      enumerateFolderVideos: enumerate,
    });

    expect(ds.get('library.vrFormat')['/lib/dir/a.mp4']).toEqual(entry);
    expect(ds.get('library.vrFormat')['/lib/dir/b.mp4']).toEqual(entry);
  });

  it('chunks writes so a large folder does not freeze the UI', async () => {
    // 150 videos > one 50-batch. We expect at least 3 writes through to
    // the store (batching gives the UI a chance to repaint).
    const paths = Array.from({ length: 150 }, (_, i) => `/lib/dir/v${i}.mp4`);
    const enumerate = vi.fn(async () => paths);
    const setSpy = vi.spyOn(ds, 'set');
    const entry = { projection: 'sbs-half', eye: 'left', zoom: 1, source: 'manual' };

    const result = await applyToFolder({
      path: '/lib/dir/v0.mp4',
      entry,
      dataService: ds,
      enumerateFolderVideos: enumerate,
    });

    expect(result.applied).toBe(150);
    // 3 batches of 50 → 3 store writes (one per batch).
    expect(setSpy).toHaveBeenCalledTimes(3);
    const finalMap = ds.get('library.vrFormat');
    expect(Object.keys(finalMap).length).toBe(150);
  });

  it('returns cancelled when no entry provided (defensive)', async () => {
    const result = await applyToFolder({
      path: '/lib/dir/a.mp4',
      entry: null,
      dataService: ds,
      enumerateFolderVideos: vi.fn(),
    });
    expect(result.cancelled).toBe(true);
  });

  it('returns cancelled when folder enumeration fails', async () => {
    const enumerate = vi.fn(async () => { throw new Error('EACCES'); });
    const result = await applyToFolder({
      path: '/lib/dir/a.mp4',
      entry: { projection: 'sbs-half', eye: 'left', zoom: 1, source: 'manual' },
      dataService: ds,
      enumerateFolderVideos: enumerate,
    });
    expect(result.cancelled).toBe(true);
  });

  it('returns cancelled when the folder is empty', async () => {
    const enumerate = vi.fn(async () => []);
    const result = await applyToFolder({
      path: '/lib/dir/a.mp4',
      entry: { projection: 'sbs-half', eye: 'left', zoom: 1, source: 'manual' },
      dataService: ds,
      enumerateFolderVideos: enumerate,
    });
    expect(result.cancelled).toBe(true);
  });
});
