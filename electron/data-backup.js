// DataBackup — main-process backup, recovery, and integrity for config.json.
//
// Phase 1 of SCOPE-data-backup.md. Implements:
//   - rolling snapshots (24 hourly + 7 daily + 4 weekly + pre-action 30d)
//   - auto-recovery on launch when config.json is missing / unparseable
//   - manifest with self-healing fallback to filesystem listing
//   - SHA-256 integrity field on every snapshot (Phase 1 sets + verifies it
//     on snapshot files; Phase 2 will extend to config.json itself)
//   - 60 s debounced "significant write" snapshot trigger
//   - pre-action snapshot helper for destructive operations
//   - blacklist of derived caches that should never be snapshotted
//
// Module is split into "pure functions" (no I/O — heavily tested) and
// "public API" (uses fs + emits events). The pure layer is the canonical
// reference for retention math, blacklist filtering, summary computation,
// etc.; tests in `tests/unit/data-backup.test.js` exercise it directly.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// === Constants ============================================================

const SCHEMA_VERSION = 1;

// Snapshot is taken at most once per DEBOUNCE_MS after a significant
// write. Coalesces busy edit periods (drag-tuning a slider, bulk import,
// etc.) into one snapshot. SCOPE-data-backup.md §10 locked this at 60 s.
const DEBOUNCE_MS = 60_000;

// Retention pyramid — "many recent, fewer old, never zero." Numbers
// locked in SCOPE §10. Total worst-case ~32 MB for typical configs.
const RETENTION = {
  hourly: 24,    // last 24 hourly buckets (one per hour)
  daily: 7,     // last 7 daily buckets (one per day)
  weekly: 4,     // last 4 weekly buckets (one per week)
  preActionDays: 30, // pre-action snapshots kept 30 days
  // Floor: never prune to fewer than this many snapshots in `snapshots/`.
  // Better to use slightly more disk than risk leaving the user one bad
  // backup from disaster. If pruning would violate this, skip the prune.
  minTotalFloor: 3,
};

// Fields excluded from snapshots. Derived caches that rebuild for free
// at zero user-visible cost — backing them up wastes disk and bloats
// snapshot summaries. Test pins this list (regression guard).
//
// Each entry is a dotted path into the config object.
const BACKUP_BLACKLIST = Object.freeze([
  'settings.library.speedStatsCache',
  'settings.library.durationCache',
  'settings.library.thumbnailCache',
]);

// Snapshot trigger types. Used in metadata.trigger and as filename suffix
// for pre-action snapshots. Not an enum object — we keep it as a free
// string field so future triggers don't need a lockstep code change.
const TRIGGER = Object.freeze({
  STARTUP:     'startup',     // once per app launch, after config load
  DEBOUNCED:   'debounced',   // significant-write coalesced
  PRE_ACTION:  'pre-action',  // before destructive operation
  MANUAL:      'manual',      // user clicked "Snapshot now"
  QUIT:        'quit',        // graceful app quit
  RECOVERY:    'post-recovery', // taken right after auto-recovery completes
  BASELINE:    'baseline',    // first snapshot on existing install
});


// === Pure functions (no I/O) =============================================

/**
 * Strip blacklisted fields from a config object. Pure — does not mutate
 * input. Used both during snapshot writes AND export-zip generation so
 * the same exclusion rules apply everywhere.
 *
 * @param {object} config
 * @returns {object} new config object with blacklisted paths removed
 */
function stripBlacklist(config) {
  if (!config || typeof config !== 'object') return config;
  const out = JSON.parse(JSON.stringify(config));
  for (const dottedPath of BACKUP_BLACKLIST) {
    const parts = dottedPath.split('.');
    let parent = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parent || typeof parent !== 'object') break;
      parent = parent[parts[i]];
    }
    if (parent && typeof parent === 'object') {
      delete parent[parts[parts.length - 1]];
    }
  }
  return out;
}

/**
 * SHA-256 hash of a JSON-stringified payload. Used as the
 * `metadata.sha256` field on snapshots so on-read integrity checks can
 * detect bit-level corruption (T3 in SCOPE §2).
 *
 * @param {object} payload
 * @returns {string} hex digest
 */
function sha256Of(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Compute a small summary object for the snapshot manifest. Renders in
 * the Settings UI so users can recognise a snapshot by content (Nielsen
 * #6 recognition over recall) without opening the full file.
 *
 * @param {object} config — already-blacklist-stripped
 */
function computeSummary(config) {
  const lib = config?.settings?.library || {};
  return {
    sources: Array.isArray(lib.sources) ? lib.sources.length : 0,
    collections: Array.isArray(lib.collections) ? lib.collections.length : 0,
    playlists: Array.isArray(config?.playlists) ? config.playlists.length : 0,
    categories: Array.isArray(config?.categories) ? config.categories.length : 0,
    customRoutings: Object.keys(lib.customRouting || {}).length,
    manualAssociations: Object.keys(lib.associations || {}).length,
    manualVariants: Object.keys(lib.manualVariants || {}).length,
  };
}

/**
 * Build the snapshot file payload (metadata + config). Pure — no I/O.
 * @param {object} config        — raw config (will be blacklist-stripped)
 * @param {string} trigger       — TRIGGER.* value
 * @param {object} [opts]
 * @param {string} [opts.label]  — pre-action label (e.g. "reset-defaults")
 * @param {Date}   [opts.now=new Date()]
 * @returns {{ payload: object, filename: string }}
 */
function buildSnapshot(config, trigger, opts = {}) {
  const now = opts.now || new Date();
  const stripped = stripBlacklist(config);
  // Compute hash AFTER stripping so the integrity check covers exactly
  // the bytes that landed on disk, not the in-memory pre-strip state.
  const sha256 = sha256Of(stripped);

  const payload = {
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      trigger,
      timestamp: now.toISOString(),
      sha256,
      summary: computeSummary(stripped),
      label: opts.label || null,
      // Phase 2 will start writing real WAL seqs here. Phase 1 leaves
      // it 0 so future-self knows "no WAL was active when this was
      // taken" — replay logic ignores it on this version.
      lastWalSeq: 0,
    },
    config: stripped,
  };

  // Filename: ISO timestamp with `:` and `.` replaced by `-` (Windows
  // forbids `:` in filenames; both characters break sortability with
  // some shells). Format sorts lexically by time.
  const tsForFilename = now.toISOString().replace(/[:.]/g, '-');
  const labelSuffix = opts.label ? `-${opts.label}` : '';
  const filename = `${tsForFilename}${labelSuffix}.json`;

  return { payload, filename };
}

/**
 * Decide which snapshots to keep under the retention pyramid. Pure
 * function — takes a list of snapshot manifest entries and returns the
 * subset to KEEP. Caller deletes the others.
 *
 * Algorithm:
 *  1. Pre-action snapshots: keep all from the last preActionDays.
 *  2. Rolling snapshots: bucket each by its age:
 *       <  1h   → "now"          (always kept)
 *       <  24h  → hourly bucket   (1 per hour, max RETENTION.hourly)
 *       <  7d   → daily bucket    (1 per day, max RETENTION.daily)
 *       < 28d   → weekly bucket   (1 per week, max RETENTION.weekly)
 *       ≥ 28d   → outside retention
 *  3. Floor: if applying the above would leave < minTotalFloor in
 *     `snapshots/`, skip pruning entirely and keep everything for now.
 *
 * @param {Array<object>} snapshots — manifest entries
 * @param {Date} [now=new Date()]
 * @returns {Array<object>} subset of snapshots to keep
 */
function applyRetentionPolicy(snapshots, now = new Date()) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return [];
  const nowMs = now.getTime();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  const rolling = snapshots.filter(s => s.subdir === 'snapshots');
  const preAction = snapshots.filter(s => s.subdir === 'pre-action');

  // --- Pre-action: keep < N days, drop older ---
  const preActionKeep = preAction.filter(s => {
    const ageMs = nowMs - new Date(s.timestamp).getTime();
    return ageMs < RETENTION.preActionDays * DAY;
  });

  // --- Rolling: bucket then dedupe ---
  // Sort newest first so when we pick the FIRST entry per bucket, we
  // pick the most recent one in that bucket.
  const rollingSorted = [...rolling].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const seenHourly = new Set();
  const seenDaily = new Set();
  const seenWeekly = new Set();
  let hourlyCount = 0;
  let dailyCount = 0;
  let weeklyCount = 0;
  const rollingKeep = [];

  for (const s of rollingSorted) {
    const ts = new Date(s.timestamp).getTime();
    const ageMs = nowMs - ts;
    if (ageMs < 0) {
      // Future-dated snapshot (clock skew on a different machine, or
      // deliberately tampered file). Keep it — paranoid is cheap here.
      rollingKeep.push(s);
      continue;
    }
    if (ageMs < HOUR) {
      // The "now" bucket — always keep. Doesn't count against the
      // hourly cap because it's protecting the very-recent history.
      rollingKeep.push(s);
    } else if (ageMs < 24 * HOUR) {
      const hourKey = Math.floor(ts / HOUR);
      if (!seenHourly.has(hourKey) && hourlyCount < RETENTION.hourly) {
        seenHourly.add(hourKey);
        hourlyCount++;
        rollingKeep.push(s);
      }
    } else if (ageMs < 7 * DAY) {
      const dayKey = Math.floor(ts / DAY);
      if (!seenDaily.has(dayKey) && dailyCount < RETENTION.daily) {
        seenDaily.add(dayKey);
        dailyCount++;
        rollingKeep.push(s);
      }
    } else if (ageMs < 28 * DAY) {
      const weekKey = Math.floor(ts / WEEK);
      if (!seenWeekly.has(weekKey) && weeklyCount < RETENTION.weekly) {
        seenWeekly.add(weekKey);
        weeklyCount++;
        rollingKeep.push(s);
      }
    }
    // ≥ 28 days: outside retention, dropped.
  }

  // Floor check — paranoid safety against leaving the user one bad
  // backup from disaster (T14 in SCOPE §2). If applying retention
  // would leave fewer than the floor, skip the prune entirely and
  // return everything we had. Better to use slightly more disk than
  // risk leaving the user one bad sector from total loss.
  if (rollingKeep.length < RETENTION.minTotalFloor) {
    return [...rolling, ...preActionKeep];
  }

  return [...rollingKeep, ...preActionKeep];
}


// === Filesystem helpers ===================================================

/**
 * Atomic write — write to a `.tmp` sibling, fsync, rename over the
 * target. Mirrors electron-conf's own pattern. Required so an
 * interrupted write (T2 in SCOPE §2) can never leave a half-written
 * file at the canonical path.
 *
 * @param {string} targetPath
 * @param {string} content     — already serialised JSON
 */
async function atomicWriteFile(targetPath, content) {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  let fh;
  try {
    fh = await fsp.open(tmpPath, 'w');
    await fh.writeFile(content, 'utf8');
    // fsync the tmp file before the rename; otherwise OS-level write
    // buffering can leave the rename pointing at empty/stale content
    // on a power loss.
    await fh.sync();
    await fh.close();
    fh = null;
    // Rename is atomic on POSIX and on NTFS for same-volume moves;
    // both happen here since tmp is the same dir as target.
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    // Best-effort cleanup of orphan tmp file (T2 partial cleanup).
    try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Self-healing manifest read. The manifest is a fast-path index into
 * the snapshot files; if it's missing or unparseable we MUST NOT
 * silently lose visibility of the snapshots that exist on disk —
 * instead, rebuild the manifest from a directory scan.
 *
 * @param {string} backupDir
 * @returns {Promise<{version: number, snapshots: Array<object>}>}
 */
async function loadManifest(backupDir) {
  const manifestPath = path.join(backupDir, 'index.json');
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.snapshots)) return parsed;
  } catch {
    // Fall through to rebuild
  }
  return rebuildManifestFromFs(backupDir);
}

/**
 * Walk `snapshots/` and `pre-action/` and reconstruct a manifest by
 * reading each file's metadata block. Used when index.json is missing
 * or corrupt (T13 in SCOPE §2). Slow path — never called on the
 * happy path.
 */
async function rebuildManifestFromFs(backupDir) {
  const snapshots = [];
  for (const subdir of ['snapshots', 'pre-action']) {
    const fullDir = path.join(backupDir, subdir);
    let entries;
    try {
      entries = await fsp.readdir(fullDir);
    } catch { continue; }
    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;
      const filePath = path.join(fullDir, filename);
      try {
        const stat = await fsp.stat(filePath);
        const raw = await fsp.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const md = parsed?.metadata;
        if (!md || !md.timestamp) continue;
        snapshots.push({
          filename,
          subdir,
          timestamp: md.timestamp,
          trigger: md.trigger || 'unknown',
          label: md.label || null,
          sizeBytes: stat.size,
          sha256: md.sha256 || null,
          summary: md.summary || {},
        });
      } catch {
        // Corrupt individual snapshot — log via console-only and skip.
        // Don't throw; one bad file shouldn't block the whole rebuild.
      }
    }
  }
  return { version: 1, snapshots };
}

async function saveManifest(backupDir, manifest) {
  const manifestPath = path.join(backupDir, 'index.json');
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
}


// === Public API ===========================================================

/** Resolve standard backup paths under a given userData directory. */
function resolvePaths(userDataDir) {
  const backupDir = path.join(userDataDir, 'backups');
  return {
    backupDir,
    snapshotsDir: path.join(backupDir, 'snapshots'),
    preActionDir: path.join(backupDir, 'pre-action'),
    manifestPath: path.join(backupDir, 'index.json'),
    configPath: path.join(userDataDir, 'config.json'),
  };
}

/**
 * Take a snapshot. Writes the snapshot file atomically, updates the
 * manifest, and returns the newly-added entry.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {object} opts.config       — current config to snapshot
 * @param {string} opts.trigger      — TRIGGER.* value
 * @param {string} [opts.label]      — for pre-action: short kebab-case label
 * @returns {Promise<object|null>} manifest entry, or null on failure
 */
async function takeSnapshot({ userDataDir, config, trigger, label } = {}) {
  if (!userDataDir || !config || !trigger) {
    throw new Error('takeSnapshot requires userDataDir, config, trigger');
  }
  const paths = resolvePaths(userDataDir);
  const subdir = trigger === TRIGGER.PRE_ACTION ? 'pre-action' : 'snapshots';
  const subdirFullPath = path.join(paths.backupDir, subdir);
  await ensureDir(subdirFullPath);

  const { payload, filename } = buildSnapshot(config, trigger, { label });
  const snapshotPath = path.join(subdirFullPath, filename);
  const json = JSON.stringify(payload, null, 2);
  await atomicWriteFile(snapshotPath, json);

  const stat = await fsp.stat(snapshotPath);
  const entry = {
    filename,
    subdir,
    timestamp: payload.metadata.timestamp,
    trigger,
    label: payload.metadata.label,
    sizeBytes: stat.size,
    sha256: payload.metadata.sha256,
    summary: payload.metadata.summary,
  };

  // loadManifest is self-healing: if index.json is missing it falls back
  // to scanning `snapshots/` + `pre-action/`. That scan WILL find the
  // file we just wrote, so a naive `.push(entry)` would double-list it.
  // Dedup by `subdir/filename` before saving so the manifest contains
  // exactly one row regardless of which path loadManifest took.
  const manifest = await loadManifest(paths.backupDir);
  const key = `${entry.subdir}/${entry.filename}`;
  const alreadyListed = manifest.snapshots.some(
    s => `${s.subdir}/${s.filename}` === key
  );
  if (!alreadyListed) manifest.snapshots.push(entry);
  await saveManifest(paths.backupDir, manifest);

  return entry;
}

/**
 * Apply retention policy. Reads the manifest, decides what to keep, and
 * deletes everything else from disk. Run AFTER a successful new
 * snapshot, never before — so we never delete the last good backup
 * before the new one is verified.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {Date}   [opts.now=new Date()]
 * @returns {Promise<{kept: number, deleted: number}>}
 */
async function pruneOld({ userDataDir, now } = {}) {
  const paths = resolvePaths(userDataDir);
  const manifest = await loadManifest(paths.backupDir);
  const kept = applyRetentionPolicy(manifest.snapshots, now || new Date());
  const keptKeys = new Set(kept.map(s => `${s.subdir}/${s.filename}`));

  const toDelete = manifest.snapshots.filter(s => !keptKeys.has(`${s.subdir}/${s.filename}`));
  for (const entry of toDelete) {
    const filePath = path.join(paths.backupDir, entry.subdir, entry.filename);
    try { await fsp.unlink(filePath); } catch { /* ignore — best-effort */ }
  }

  await saveManifest(paths.backupDir, { version: 1, snapshots: kept });
  return { kept: kept.length, deleted: toDelete.length };
}

/**
 * Boot-time integrity check + auto-recovery. Runs BEFORE store loads
 * config so if config.json is corrupt, the repaired version is what
 * store.initStore() reads.
 *
 * Decision tree (SCOPE §4.4):
 *   - config.json reads + parses cleanly → return {recovered: false}
 *   - missing / unparseable / 0 bytes → walk snapshots newest-first,
 *     find first one that parses cleanly with matching SHA-256,
 *     copy to config.json, return {recovered: true, fromSnapshot: ...}
 *   - no valid snapshot exists → return {recovered: false, fellBack: true}
 *     (caller falls through to defaults; toast warns user)
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @returns {Promise<{recovered: boolean, fellBack?: boolean, fromSnapshot?: object, reason?: string}>}
 */
async function verifyAndRecover({ userDataDir } = {}) {
  const paths = resolvePaths(userDataDir);

  // 1. Try the live config.
  let liveOk = false;
  let liveReason = null;
  try {
    const raw = await fsp.readFile(paths.configPath, 'utf8');
    if (!raw || raw.length === 0) {
      liveReason = 'empty file';
    } else {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        liveOk = true;
      } else {
        liveReason = 'parsed but not an object';
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') liveReason = 'file missing';
    else if (err instanceof SyntaxError) liveReason = `unparseable JSON (${err.message})`;
    else liveReason = `read error: ${err.message}`;
  }
  if (liveOk) return { recovered: false };

  // 2. Walk snapshots newest-first. Need to verify both that the file
  // parses AND that its SHA-256 matches its declared metadata.sha256.
  // Either failing → skip and try the next.
  const manifest = await loadManifest(paths.backupDir);
  const sorted = [...manifest.snapshots].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  for (const entry of sorted) {
    const filePath = path.join(paths.backupDir, entry.subdir, entry.filename);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.config || !parsed?.metadata) continue;
      const expectedHash = parsed.metadata.sha256;
      const actualHash = sha256Of(parsed.config);
      if (expectedHash && expectedHash !== actualHash) {
        // Snapshot file itself was corrupted post-write (T15). Skip.
        continue;
      }
      // Snapshot is valid — restore it to config.json.
      await atomicWriteFile(paths.configPath, JSON.stringify(parsed.config, null, 2));
      return {
        recovered: true,
        fromSnapshot: entry,
        reason: liveReason,
      };
    } catch {
      // Bad snapshot file — try the next one.
      continue;
    }
  }

  // 3. No valid snapshot found. Caller falls through to defaults.
  return { recovered: false, fellBack: true, reason: liveReason };
}


// === Debounced scheduler ==================================================

let _debounceTimer = null;
let _scheduledOpts = null;

/**
 * Schedule a "debounced" snapshot. Coalesces rapid mutations into one
 * snapshot at most once per DEBOUNCE_MS. Subsequent calls during the
 * window reset the timer (classic debounce). Caller passes the
 * userDataDir + a getConfig callback that returns the current config
 * at the moment the timer fires (NOT the moment it was scheduled),
 * so the snapshot reflects the latest state.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {() => object} opts.getConfig
 * @param {function} [opts.onSnapshot] — fires after each successful snapshot
 */
function scheduleSnapshot({ userDataDir, getConfig, onSnapshot } = {}) {
  if (!userDataDir || typeof getConfig !== 'function') return;
  _scheduledOpts = { userDataDir, getConfig, onSnapshot };
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(_fireScheduled, DEBOUNCE_MS);
  // Don't keep the event loop alive just for the backup timer — if the
  // app is otherwise idle and ready to quit, let it.
  if (_debounceTimer.unref) _debounceTimer.unref();
}

async function _fireScheduled() {
  const opts = _scheduledOpts;
  _debounceTimer = null;
  _scheduledOpts = null;
  if (!opts) return;
  try {
    const config = opts.getConfig();
    if (!config) return;
    const entry = await takeSnapshot({
      userDataDir: opts.userDataDir,
      config,
      trigger: TRIGGER.DEBOUNCED,
    });
    await pruneOld({ userDataDir: opts.userDataDir });
    if (opts.onSnapshot) {
      try { opts.onSnapshot(entry); } catch { /* swallow listener errors */ }
    }
  } catch (err) {
    // Swallow but log — backup failure must NEVER crash the app.
    console.warn('[DataBackup] Scheduled snapshot failed:', err?.message || err);
  }
}

/**
 * Cancel any pending scheduled snapshot. Used on graceful quit so the
 * quit-time snapshot supersedes the pending debounced one without a
 * race. The caller is expected to take a final snapshot afterwards.
 */
function cancelScheduled() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _scheduledOpts = null;
}


// === Exports ==============================================================

module.exports = {
  // Constants — exported so tests can pin them and so other modules
  // (notably `data-export.js` for export-zip generation) reuse the
  // same blacklist.
  SCHEMA_VERSION,
  DEBOUNCE_MS,
  RETENTION,
  BACKUP_BLACKLIST,
  TRIGGER,

  // Pure functions
  stripBlacklist,
  sha256Of,
  computeSummary,
  buildSnapshot,
  applyRetentionPolicy,

  // Filesystem helpers (exported for tests + Phase 2 reuse)
  atomicWriteFile,
  loadManifest,
  saveManifest,
  rebuildManifestFromFs,
  resolvePaths,

  // Public API
  takeSnapshot,
  pruneOld,
  verifyAndRecover,
  scheduleSnapshot,
  cancelScheduled,
};
