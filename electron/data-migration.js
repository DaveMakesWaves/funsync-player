// DataMigration — one-time migration from renderer localStorage to main process store
const log = require('./logger');
const store = require('./store');

/**
 * Migrate legacy localStorage data to the main process store.
 * Called from the renderer via IPC when it detects old localStorage data.
 * @param {object} legacyData — parsed JSON from localStorage['funsync-settings']
 */
function migrate(legacyData) {
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

module.exports = { migrate };
