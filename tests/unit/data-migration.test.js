// Unit tests for data-migration — ISOLATED (does not import the real module)
//
// data-migration.js is a thin CJS glue module that require('./logger') and
// require('./store'), which pull in electron-log and electron-conf — Electron
// main-process dependencies that can't run in Vitest's jsdom environment.
//
// Instead we test a local copy of the migrate() logic against mock store/log
// objects. This means changes to data-migration.js must be mirrored here.
// The tradeoff is acceptable because the function is ~20 lines of glue.
import { describe, it, expect, vi } from 'vitest';

describe('data-migration (isolated)', () => {
  function createMockStore(migrated = false) {
    return {
      isMigrated: vi.fn().mockReturnValue(migrated),
      migrateFromLegacy: vi.fn(),
    };
  }

  function createMockLog() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  }

  // Local copy of electron/data-migration.js migrate() — must stay in sync
  function migrate(legacyData, store, log) {
    if (store.isMigrated()) {
      log.info('[Migration] Already migrated, skipping');
      return { success: true, skipped: true };
    }

    if (!legacyData || typeof legacyData !== 'object') {
      log.info('[Migration] No valid legacy data, marking as migrated');
      store.migrateFromLegacy(null);
      return { success: true, empty: true };
    }

    try {
      log.info('[Migration] Migrating localStorage data to config.json...');
      store.migrateFromLegacy(legacyData);
      log.info('[Migration] Migration complete');
      return { success: true };
    } catch (err) {
      log.error('[Migration] Migration failed:', err);
      return { success: false, error: err.message };
    }
  }

  it('skips if already migrated', () => {
    const store = createMockStore(true);
    const log = createMockLog();
    const result = migrate({ player: { volume: 50 } }, store, log);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(store.migrateFromLegacy).not.toHaveBeenCalled();
  });

  it('marks as migrated with null data', () => {
    const store = createMockStore(false);
    const log = createMockLog();
    const result = migrate(null, store, log);
    expect(result.success).toBe(true);
    expect(result.empty).toBe(true);
    expect(store.migrateFromLegacy).toHaveBeenCalledWith(null);
  });

  it('marks as migrated with non-object data', () => {
    const store = createMockStore(false);
    const log = createMockLog();
    const result = migrate('not an object', store, log);
    expect(result.success).toBe(true);
    expect(result.empty).toBe(true);
  });

  it('migrates valid legacy data', () => {
    const store = createMockStore(false);
    const log = createMockLog();
    const legacy = {
      handy: { connectionKey: 'key123' },
      playlists: [{ id: 'p1', name: 'Test' }],
    };
    const result = migrate(legacy, store, log);
    expect(result.success).toBe(true);
    expect(store.migrateFromLegacy).toHaveBeenCalledWith(legacy);
  });

  it('handles migration error gracefully', () => {
    const store = createMockStore(false);
    store.migrateFromLegacy.mockImplementation(() => { throw new Error('disk full'); });
    const log = createMockLog();
    const result = migrate({ player: { volume: 50 } }, store, log);
    expect(result.success).toBe(false);
    expect(result.error).toBe('disk full');
  });

  it('idempotent — second call is no-op when first marks migrated', () => {
    const store = createMockStore(false);
    const log = createMockLog();

    migrate({ player: { volume: 50 } }, store, log);
    expect(store.migrateFromLegacy).toHaveBeenCalledTimes(1);

    // After first migration, isMigrated returns true
    store.isMigrated.mockReturnValue(true);
    const result = migrate({ player: { volume: 50 } }, store, log);
    expect(result.skipped).toBe(true);
    expect(store.migrateFromLegacy).toHaveBeenCalledTimes(1);
  });

  it('handles empty legacy object', () => {
    const store = createMockStore(false);
    const log = createMockLog();
    const result = migrate({}, store, log);
    expect(result.success).toBe(true);
    expect(store.migrateFromLegacy).toHaveBeenCalledWith({});
  });

  it('handles partial legacy data', () => {
    const store = createMockStore(false);
    const log = createMockLog();
    const legacy = { handy: { connectionKey: 'test' } };
    const result = migrate(legacy, store, log);
    expect(result.success).toBe(true);
    expect(store.migrateFromLegacy).toHaveBeenCalledWith(legacy);
  });
});
