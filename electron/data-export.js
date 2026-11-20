// DataExport — Export and import application data as .funsync-backup (zip) files
// Runs in the main process. Uses JSZip for archive creation/reading.

const fs = require('fs');
const path = require('path');
const { stripBlacklist } = require('./data-backup');
const { SECRET_SETTINGS: SHARED_SECRET_SETTINGS } = require('./secret-settings');
const {
  FILE_NAME: STASH_LIBRARY_FILE,
  MAX_BYTES: STASH_LIBRARY_MAX_BYTES,
  isUsableData: isUsableStashData,
  scrubSecrets: scrubStashSecrets,
} = require('./stash-library-file');

let JSZip = null;

/**
 * Lazily load JSZip (CJS compatible).
 */
async function getJSZip() {
  if (!JSZip) {
    JSZip = require('jszip');
  }
  return JSZip;
}

// Zip folder that carries uploaded poster images (V59).
const CUSTOM_THUMBS_FOLDER = 'custom-thumbs';

// Both platforms' separators: a backup made on Windows can be imported on
// Linux, where path.basename would not split a backslash.
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// Only plain file names come out of a zip into custom-thumbs: no folders,
// no "..", nothing hidden. The app's own names are md5(videoPath).<ext>.
const isSafeThumbName = (name) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');

/**
 * The uploaded-image entries of `settings.library.customThumbnails` whose
 * file lives in `customThumbsDir` (the same guard as read-custom-thumbnail:
 * nothing outside that folder is ever read).
 */
function _customThumbFiles(configData, customThumbsDir) {
  if (!customThumbsDir) return [];
  const map = configData?.settings?.library?.customThumbnails;
  if (!map || typeof map !== 'object') return [];
  const root = path.resolve(customThumbsDir) + path.sep;
  const files = new Map();
  for (const entry of Object.values(map)) {
    if (!entry || entry.type !== 'image' || !entry.imagePath) continue;
    const resolved = path.resolve(String(entry.imagePath));
    if (!resolved.startsWith(root)) continue;
    const name = baseName(resolved);
    if (isSafeThumbName(name)) files.set(name, resolved);
  }
  return [...files.entries()].map(([name, filePath]) => ({ name, filePath }));
}

// The Stash data in a backup (S1, DESIGN-stash-s1.md (c) "Backups and
// import merge"): one entry, stash/library.json. Never stash/key.json (the
// API key) and never stash/fingerprints.json (derived): the export reads one
// fixed file name, and the import reads only this entry.
const STASH_LIBRARY_ENTRY = `stash/${STASH_LIBRARY_FILE}`;

/** userData/stash/library.json as export text, or null (none, unreadable, damaged, too large). */
function _stashLibraryForExport(stashDir) {
  if (!stashDir) return null;
  const file = path.join(stashDir, STASH_LIBRARY_FILE);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > STASH_LIBRARY_MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!isUsableStashData(parsed)) return null;
    // No string carrying `apikey=` leaves in a backup (library-file never stores one either).
    return JSON.stringify(scrubStashSecrets(parsed));
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[DataExport] Skipping the Stash data: ${err.message}`);
    return null;
  }
}

/** The backup's stash/library.json, parsed, or null (absent, damaged, too large, another version). */
async function _stashLibraryFromZip(zip) {
  const entry = zip.file(STASH_LIBRARY_ENTRY);
  if (!entry || entry.dir) return null;
  const size = entry._data && entry._data.uncompressedSize;
  if (Number.isFinite(size) && size > STASH_LIBRARY_MAX_BYTES) return null;
  try {
    const text = await entry.async('string');
    if (Buffer.byteLength(text, 'utf8') > STASH_LIBRARY_MAX_BYTES) return null;
    const parsed = JSON.parse(text.replace(/^﻿/, ''));
    return isUsableStashData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Export application data to a .funsync-backup zip file.
 *
 * @param {object} configData — full config object from store.getAll()
 * @param {string} outputPath — destination file path
 * @param {object} [options]
 * @param {string[]} [options.funscriptPaths] — optional funscript file paths to include
 * @param {string} [options.customThumbsDir] — userData/custom-thumbs; uploaded
 *   poster images referenced by the config are bundled from it
 * @param {string} [options.stashDir] — userData/stash; its library.json (only
 *   that file) is bundled as stash/library.json
 * @returns {Promise<{success: boolean, path: string, error?: string}>}
 */
async function exportData(configData, outputPath, options = {}) {
  try {
    const Zip = await getJSZip();
    const zip = new Zip();

    // Strip the same derived-cache fields that data-backup.js skips on
    // every snapshot (speedStatsCache, durationCache, thumbnailCache).
    // Without this, exports balloon by tens of MB of base64-encoded
    // thumbnails and ship the user's library cache to wherever they
    // share the .funsync-backup file. Single source of truth =
    // data-backup.js::BACKUP_BLACKLIST so both surfaces stay in sync.
    // SCOPE-data-backup.md §4.8 + §7.6a.
    const exportable = stripBlacklist(configData);
    zip.file('config.json', JSON.stringify(exportable, null, 2));

    // Optionally include funscript files
    if (options.funscriptPaths && options.funscriptPaths.length > 0) {
      const funscriptsFolder = zip.folder('funscripts');
      for (const fsPath of options.funscriptPaths) {
        try {
          if (fs.existsSync(fsPath)) {
            const content = fs.readFileSync(fsPath, 'utf-8');
            const name = path.basename(fsPath);
            funscriptsFolder.file(name, content);
          }
        } catch (err) {
          // Skip unreadable files
          console.warn(`[DataExport] Skipping ${fsPath}: ${err.message}`);
        }
      }
    }

    // Uploaded poster images (V59). The config only holds a path into
    // THIS machine's userData/custom-thumbs, so without the files a restore
    // on another machine, or after wiping userData, silently fell back to
    // the auto frame for every uploaded poster.
    const thumbs = _customThumbFiles(configData, options.customThumbsDir);
    if (thumbs.length > 0) {
      const thumbsFolder = zip.folder(CUSTOM_THUMBS_FOLDER);
      for (const { name, filePath } of thumbs) {
        try {
          thumbsFolder.file(name, fs.readFileSync(filePath));
        } catch (err) {
          // Missing or unreadable: the entry falls back to the auto frame,
          // exactly as it does in the app today.
          console.warn(`[DataExport] Skipping custom thumbnail ${name}: ${err.message}`);
        }
      }
    }

    // The Stash data (S1): main writes it on every change, so the file on
    // disk is the current one.
    const stashLibrary = _stashLibraryForExport(options.stashDir);
    if (stashLibrary) zip.file(STASH_LIBRARY_ENTRY, stashLibrary);

    // Add metadata
    zip.file('metadata.json', JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      appVersion: require('../package.json').version || '0.1.0',
    }, null, 2));

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outputPath, buffer);

    return { success: true, path: outputPath };
  } catch (err) {
    return { success: false, path: outputPath, error: err.message };
  }
}

/**
 * Import application data from a .funsync-backup zip file.
 *
 * @param {string} inputPath — path to the backup zip file
 * @param {'merge'|'overwrite'} [mode='merge'] — conflict resolution mode
 * @returns {Promise<{success: boolean, config?: object, funscripts?: Array<{name: string, content: string}>, error?: string}>}
 */
async function importData(inputPath, mode = 'merge') {
  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, error: 'File not found' };
    }

    const Zip = await getJSZip();
    const buffer = fs.readFileSync(inputPath);
    let zip;
    try {
      zip = await Zip.loadAsync(buffer);
    } catch {
      // JSZip's own message is a paragraph with a URL in it; the import
      // toast shows this text to the user.
      return { success: false, error: 'Invalid backup: not a zip file' };
    }

    // Validate: must contain config.json
    const configFile = zip.file('config.json');
    if (!configFile) {
      return { success: false, error: 'Invalid backup: missing config.json' };
    }

    // Parse config
    const configContent = await configFile.async('string');
    let config;
    try {
      config = JSON.parse(configContent);
    } catch (err) {
      return { success: false, error: 'Invalid backup: corrupt config.json' };
    }

    // Extract funscripts if present
    const funscripts = [];
    const funscriptsFolder = zip.folder('funscripts');
    if (funscriptsFolder) {
      const files = [];
      funscriptsFolder.forEach((relativePath, file) => {
        if (!file.dir) files.push(file);
      });
      for (const file of files) {
        const content = await file.async('string');
        funscripts.push({ name: path.basename(file.name), content });
      }
    }

    // Uploaded poster images, if the backup has any (V59).
    const customThumbs = [];
    const thumbsFolder = zip.folder(CUSTOM_THUMBS_FOLDER);
    if (thumbsFolder) {
      const files = [];
      thumbsFolder.forEach((relativePath, file) => {
        if (!file.dir) files.push(file);
      });
      for (const file of files) {
        const name = baseName(file.name);
        if (!isSafeThumbName(name)) continue;
        customThumbs.push({ name, data: await file.async('nodebuffer') });
      }
    }

    // The Stash data (S1), or null. Nothing else under stash/ is read, so a
    // backup can never bring an API key in.
    const stashLibrary = await _stashLibraryFromZip(zip);

    return { success: true, config, funscripts, customThumbs, stashLibrary };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const _isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Settings that hold a credential (FT-008). In a MERGE import, a value that
 * is set here is kept: the backup only fills a slot that is empty here.
 *
 * The plain deep merge let the backup's value win for every key, so a
 * backup made before the key was entered (`connectionKey: ''`), or after a
 * log-out (`session: null`), silently wiped the working Handy key, the
 * Autoblow token or the EroScripts login. And a backup's value that is not
 * empty is still an OLD copy of a credential: an EroScripts cookie from the
 * export date is most likely expired, and the key typed in here is the one
 * the user is using now. Overwrite mode is the user's explicit "replace
 * everything" and is left as it is.
 *
 * `present` says whether a local value is worth keeping. The entries are
 * the 'keep-local' ones of electron/secret-settings.js, the one list shared
 * with log-redact.js (R3-08: each kept its own copy, nothing in step); the
 * 'union-by-key' one (audience.viewers) is `_mergeAudienceViewers` below.
 */
const SECRET_SETTINGS = Object.freeze(
  Object.entries(SHARED_SECRET_SETTINGS)
    .filter(([, def]) => def.import === 'keep-local')
    .map(([p, def]) => Object.freeze({ path: p.split('.'), present: def.present })),
);

const _isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function _getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!_isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function _setPath(obj, path, value) {
  let cur = obj;
  for (const key of path.slice(0, -1)) {
    if (!_isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

/** Put back every credential that is set here (see SECRET_SETTINGS). */
function _keepLocalSecrets(mergedSettings, localSettings) {
  for (const { path, present } of SECRET_SETTINGS) {
    const local = _getPath(localSettings, path);
    if (present(local)) _setPath(mergedSettings, path, JSON.parse(JSON.stringify(local)));
  }
}

const _viewerKey = (v) => (_isPlainObject(v) && _isNonEmptyString(v.key) ? v.key.trim().toLowerCase() : null);

/**
 * The Audience roster (`audience.viewers`, other people's Handy keys) is a
 * union by key: every viewer here stays exactly as it is, and a viewer from
 * the backup is added only when its key is not here yet. Keys compare
 * trimmed and case-folded, the way audience-bridge's _normalizeKey does.
 * The deep merge replaced the whole array, so a backup with an empty roster
 * deleted everyone (FT-008).
 */
function _mergeAudienceViewers(mergedSettings, localSettings, importedSettings) {
  const local = _getPath(localSettings, ['audience', 'viewers']);
  if (!Array.isArray(local) || local.length === 0) return; // nothing here to lose
  const out = JSON.parse(JSON.stringify(local));
  const seen = new Set(out.map(_viewerKey).filter(Boolean));
  const incoming = _getPath(importedSettings, ['audience', 'viewers']);
  if (Array.isArray(incoming)) {
    for (const viewer of incoming) {
      const key = _viewerKey(viewer);
      if (!key || seen.has(key)) continue;
      out.push(JSON.parse(JSON.stringify(viewer)));
      seen.add(key);
    }
  }
  _setPath(mergedSettings, ['audience', 'viewers'], out);
}

// --- Tags (DESIGN-video-options.md (e) "Backups and import merge") ---
//
// The deep merge replaces arrays, merges a post record field by field, and
// lets a backup's `null` replace a whole map. So each tag map has its own
// rule. A map the backup lacks, or holds in the wrong shape, leaves this
// machine's exactly as it is (absence is never destructive), and a path that
// is not in the library here is merged like any other: nothing is pruned.
const TAG_LIST_MAPS = Object.freeze(['userTags', 'hiddenTags']);
const TAG_MAPS = Object.freeze(['userTags', 'hiddenTags', 'scriptTags', 'tagSettings']);

const _clone = (v) => JSON.parse(JSON.stringify(v));
const _isTagItem = (v) => typeof v === 'string' || typeof v === 'number';

/** `local` plus every item of `incoming` it lacks (exact match), local order first. */
function _unionTagList(local, incoming) {
  const out = Array.isArray(local) ? _clone(local) : [];
  if (Array.isArray(incoming)) {
    for (const item of incoming) {
      if (_isTagItem(item) && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

/** When a post record was got: `fetchedAt`, else `savedAt`; unknown is oldest. */
function _recordTime(record) {
  for (const t of [record?.fetchedAt, record?.savedAt]) {
    if (Number.isFinite(t)) return t;
  }
  return -Infinity;
}

/** Plain-object maps merged key by key; `local`'s value wins a clash. */
function _unionLocalWins(local, incoming) {
  return { ...(_isPlainObject(incoming) ? _clone(incoming) : {}), ...(_isPlainObject(local) ? _clone(local) : {}) };
}

/**
 * Merge mode, after the deep merge:
 * - `userTags`, `hiddenTags`: union per path (the videoCategories rule).
 * - `scriptTags`: per path, the newer record (fetchedAt, else savedAt) wins
 *   whole; a tie keeps this machine's.
 * - `tagSettings`: `aliases` and `facetOverrides` union, this machine's
 *   value wins a clash; `hidden` union.
 */
function _mergeTagData(mergedSettings, localSettings, importedSettings) {
  if (!_isPlainObject(mergedSettings) || !_isPlainObject(mergedSettings.library)) return;
  // A copy: when this machine had no library block, the deep merge put the
  // backup's own object here, which must not be written through.
  const lib = { ...mergedSettings.library };
  mergedSettings.library = lib;
  const localLib = _getPath(localSettings, ['library']);
  const importedLib = _getPath(importedSettings, ['library']);
  const localOf = (key) => (_isPlainObject(localLib) ? localLib[key] : undefined);
  const importedOf = (key) => (_isPlainObject(importedLib) ? importedLib[key] : undefined);

  for (const key of TAG_MAPS) {
    const local = localOf(key);
    const incoming = importedOf(key);
    if (!_isPlainObject(incoming)) {
      // Nothing usable in the backup: this machine's value, as it was.
      if (local === undefined) delete lib[key];
      else lib[key] = _clone(local);
      continue;
    }

    if (TAG_LIST_MAPS.includes(key)) {
      const out = _isPlainObject(local) ? _clone(local) : {};
      for (const [videoPath, list] of Object.entries(incoming)) {
        if (!Array.isArray(list)) continue;
        if (out[videoPath] !== undefined && !Array.isArray(out[videoPath])) continue; // never overwrite what we cannot read
        const merged = _unionTagList(out[videoPath], list);
        if (merged.length > 0 || Array.isArray(out[videoPath])) out[videoPath] = merged;
      }
      lib[key] = out;
    } else if (key === 'scriptTags') {
      const out = _isPlainObject(local) ? _clone(local) : {};
      for (const [videoPath, record] of Object.entries(incoming)) {
        if (!_isPlainObject(record)) continue;
        const mine = out[videoPath];
        if (_isPlainObject(mine) && _recordTime(record) <= _recordTime(mine)) continue;
        out[videoPath] = _clone(record);
      }
      lib[key] = out;
    } else {
      // tagSettings: any other field follows the deep merge (the backup's).
      const out = _isPlainObject(lib[key]) ? _clone(lib[key]) : {};
      const mine = _isPlainObject(local) ? local : {};
      for (const field of ['aliases', 'facetOverrides']) {
        if (_isPlainObject(mine[field]) || _isPlainObject(incoming[field])) {
          out[field] = _unionLocalWins(mine[field], incoming[field]);
        } else if (mine[field] !== undefined) {
          out[field] = _clone(mine[field]);
        }
      }
      if (Array.isArray(mine.hidden) || Array.isArray(incoming.hidden)) {
        out.hidden = _unionTagList(mine.hidden, incoming.hidden);
      } else if (mine.hidden !== undefined) {
        out.hidden = _clone(mine.hidden);
      }
      lib[key] = out;
    }
  }
}

/**
 * Overwrite mode replaces everything with the backup, except a tag map the
 * backup does not have at all (a backup from before tags): unknown is not
 * "no tags", so this machine's map is kept. A map the backup has, even an
 * empty one, replaces this machine's.
 */
function _keepLocalTagMapsIfAbsent(out, existing) {
  const localLib = _getPath(existing?.settings, ['library']);
  if (!_isPlainObject(localLib)) return out;
  const importedLib = _getPath(out.settings, ['library']);
  const keep = TAG_MAPS.filter((key) => localLib[key] !== undefined
    && !(_isPlainObject(importedLib) && _isPlainObject(importedLib[key])));
  if (keep.length === 0) return out;
  const lib = _isPlainObject(importedLib) ? { ...importedLib } : {};
  for (const key of keep) lib[key] = _clone(localLib[key]);
  out.settings = { ...(_isPlainObject(out.settings) ? out.settings : {}), library: lib };
  return out;
}

// --- Stash (DESIGN-stash-s1.md (c) "Backups and import merge") ---
//
// Only these four fields of `settings.stash` ever come from a backup. The
// API key is not a setting (electron/stash-secret.js keeps it in its own
// file); a backup that carries one under `stash` anyway, or any other
// field, brings nothing in.
function _stashFieldsOf(block) {
  const out = {};
  if (!_isPlainObject(block)) return out;
  if (typeof block.enabled === 'boolean') out.enabled = block.enabled;
  if (typeof block.url === 'string') out.url = block.url;
  if (typeof block.syncOnStart === 'boolean') out.syncOnStart = block.syncOnStart;
  if (Array.isArray(block.pathRules)) {
    out.pathRules = block.pathRules
      .filter((r) => _isPlainObject(r) && typeof r.local === 'string' && typeof r.stash === 'string')
      .map((r) => ({ local: r.local, stash: r.stash }));
  }
  return out;
}

/**
 * Merge mode, after the deep merge: this machine's `enabled` stays; `url`
 * and `pathRules` fill only an empty local value; `syncOnStart` follows the
 * backup like any other setting. Nothing else under `stash` is taken.
 */
function _mergeStashSettings(mergedSettings, localSettings, importedSettings) {
  if (!_isPlainObject(mergedSettings)) return;
  const local = _getPath(localSettings, ['stash']);
  const incoming = _stashFieldsOf(_getPath(importedSettings, ['stash']));
  if (!_isPlainObject(local) && Object.keys(incoming).length === 0) {
    if (local === undefined) delete mergedSettings.stash;
    else mergedSettings.stash = _clone(local);
    return;
  }
  const out = _isPlainObject(local) ? _clone(local) : {};
  if (typeof out.enabled !== 'boolean' && typeof incoming.enabled === 'boolean') out.enabled = incoming.enabled;
  if (!_isNonEmptyString(out.url) && _isNonEmptyString(incoming.url)) out.url = incoming.url;
  const localRules = Array.isArray(out.pathRules) && out.pathRules.length > 0;
  if (!localRules && Array.isArray(incoming.pathRules) && incoming.pathRules.length > 0) out.pathRules = incoming.pathRules;
  if (typeof incoming.syncOnStart === 'boolean') out.syncOnStart = incoming.syncOnStart;
  mergedSettings.stash = out;
}

/**
 * Overwrite mode: the backup's `stash` block (its four fields only), or,
 * when the backup has none (made before Stash), this machine's block as it
 * is: unknown is not "never set up".
 */
function _keepLocalStashIfAbsent(out, existing) {
  if (!_isPlainObject(out.settings)) return out;
  const imported = out.settings.stash;
  if (_isPlainObject(imported)) {
    out.settings = { ...out.settings, stash: _stashFieldsOf(imported) };
    return out;
  }
  const local = _getPath(existing?.settings, ['stash']);
  if (!_isPlainObject(local)) {
    if (imported !== undefined) {
      out.settings = { ...out.settings };
      delete out.settings.stash;
    }
    return out;
  }
  out.settings = { ...out.settings, stash: _clone(local) };
  return out;
}

/**
 * Merge imported config into existing config.
 * In merge mode: imported settings override, EXCEPT credentials that are set
 * here (kept), the Audience roster (union by key, local wins), the tag
 * maps (_mergeTagData) and `stash` (_mergeStashSettings); imported
 * playlists/categories are added (skip any whose id already exists here,
 * then duplicates by name).
 * In overwrite mode: imported data replaces existing, except a tag map or a
 * `stash` block the backup does not have at all (_keepLocalTagMapsIfAbsent,
 * _keepLocalStashIfAbsent).
 *
 * @param {object} existing — current config from store.getAll()
 * @param {object} imported — config from backup
 * @param {'merge'|'overwrite'} mode
 * @returns {object} merged config
 */
function mergeConfig(existing, imported, mode) {
  if (mode === 'overwrite') {
    return _keepLocalStashIfAbsent(_keepLocalTagMapsIfAbsent({ ...imported }, existing), existing);
  }

  // Merge mode: settings from import override, lists are merged
  const merged = JSON.parse(JSON.stringify(existing));
  if (!Array.isArray(merged.playlists)) merged.playlists = [];
  if (!Array.isArray(merged.categories)) merged.categories = [];
  if (!merged.videoCategories || typeof merged.videoCategories !== 'object') merged.videoCategories = {};

  // Merge settings (imported values override, but an import never removes
  // a credential or an Audience viewer that is set here)
  if (imported.settings) {
    merged.settings = _deepMerge(merged.settings || {}, imported.settings);
    _keepLocalSecrets(merged.settings, existing.settings);
    _mergeAudienceViewers(merged.settings, existing.settings, imported.settings);
    _mergeTagData(merged.settings, existing.settings, imported.settings);
    _mergeStashSettings(merged.settings, existing.settings, imported.settings);
  }

  // Ids are random UUIDs, so an id that already exists here IS that
  // playlist or category, possibly renamed since the export. It is skipped
  // before the name check: pushing it would bring the old name back as a
  // second row with the SAME id, and deleting that row (store and
  // DataService delete by id) would delete the user's renamed one too and,
  // for a category, every assignment to it.
  const hasId = (ids, item) => item?.id != null && ids.has(item.id);

  // Merge playlists (skip the same id, then duplicates by name)
  if (Array.isArray(imported.playlists)) {
    const existingIds = new Set(merged.playlists.map(p => p.id));
    const existingNames = new Set(merged.playlists.map(p => p.name));
    for (const playlist of imported.playlists) {
      if (hasId(existingIds, playlist)) continue;
      if (!existingNames.has(playlist.name)) {
        merged.playlists.push(playlist);
        existingIds.add(playlist.id);
        existingNames.add(playlist.name);
      }
    }
  }

  // Merge categories (skip the same id, then duplicates by name). The
  // same id needs no re-pointing: the backup's assignments already name it.
  // A same-name duplicate keeps THIS machine's id, so the backup's
  // assignments to it are re-pointed below. Without that they would name an
  // id that exists nowhere here and the videos would silently drop out of
  // the category.
  const categoryIdMap = new Map();
  if (Array.isArray(imported.categories)) {
    const existingIds = new Set(merged.categories.map(c => c.id));
    const byName = new Map(merged.categories.map(c => [c.name, c]));
    for (const category of imported.categories) {
      if (hasId(existingIds, category)) continue;
      const same = byName.get(category.name);
      if (!same) {
        merged.categories.push(category);
        existingIds.add(category.id);
        byName.set(category.name, category);
      } else if (same.id !== category.id) {
        categoryIdMap.set(category.id, same.id);
      }
    }
  }

  // Merge video categories (union)
  if (imported.videoCategories && typeof imported.videoCategories === 'object') {
    for (const [videoPath, catIds] of Object.entries(imported.videoCategories)) {
      if (!Array.isArray(catIds)) continue;
      if (!Array.isArray(merged.videoCategories[videoPath])) merged.videoCategories[videoPath] = [];
      const target = merged.videoCategories[videoPath];
      for (const id of catIds) {
        const local = categoryIdMap.get(id) || id;
        if (!target.includes(local)) target.push(local);
      }
    }
  }

  return merged;
}

/**
 * Put a backup's poster images into this machine's custom-thumbs folder and
 * point the backup's `customThumbnails` image entries at them (V59).
 *
 * An existing file is NEVER overwritten: image files are not in any
 * snapshot, so replacing one would destroy something the user cannot get
 * back. The name is md5(videoPath), so a clash is the same video. Identical
 * bytes are simply reused; different bytes are written beside it as
 * `<md5>.imported-<hash>.<ext>`, which the next re-pick of that video's
 * poster cleans up along with every other `<md5>.*` sibling.
 *
 * Entries whose image is not in the backup (exports from before this
 * existed) are left exactly as they were.
 *
 * @param {object} config — the backup's config (not mutated)
 * @param {Array<{name: string, data: Buffer}>} [thumbs]
 * @param {string} [customThumbsDir]
 * @returns {Promise<object>} config to merge, with re-pointed image paths
 */
async function restoreCustomThumbs(config, thumbs, customThumbsDir) {
  if (!customThumbsDir || !Array.isArray(thumbs) || thumbs.length === 0) return config;
  const map = config?.settings?.library?.customThumbnails;
  if (!map || typeof map !== 'object') return config;

  try {
    await fs.promises.mkdir(customThumbsDir, { recursive: true });
  } catch {
    return config;
  }

  // name in the backup → name on this machine
  const placed = new Map();
  const writeNew = async (name, data) => {
    try {
      await fs.promises.writeFile(path.join(customThumbsDir, name), data, { flag: 'wx' });
      return 'written';
    } catch (err) {
      if (err?.code !== 'EEXIST') return 'failed';
      try {
        const existing = await fs.promises.readFile(path.join(customThumbsDir, name));
        return existing.equals(data) ? 'same' : 'different';
      } catch {
        return 'failed';
      }
    }
  };
  for (const { name, data } of thumbs) {
    if (!isSafeThumbName(name) || !Buffer.isBuffer(data)) continue;
    const result = await writeNew(name, data);
    if (result === 'written' || result === 'same') {
      placed.set(name, name);
    } else if (result === 'different') {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      const tag = require('crypto').createHash('sha1').update(data).digest('hex').slice(0, 8);
      const alt = `${stem}.imported-${tag}${ext}`;
      const altResult = await writeNew(alt, data);
      if (altResult === 'written' || altResult === 'same') placed.set(name, alt);
    }
    // 'failed': leave that entry pointing where it did.
  }

  const out = JSON.parse(JSON.stringify(config));
  const outMap = out.settings.library.customThumbnails;
  for (const [videoPath, entry] of Object.entries(outMap)) {
    if (!entry || entry.type !== 'image' || !entry.imagePath) continue;
    const local = placed.get(baseName(entry.imagePath));
    if (local) outMap[videoPath] = { ...entry, imagePath: path.join(customThumbsDir, local) };
  }
  return out;
}

/**
 * Settings → Data → Import Backup File, after the file was picked.
 *
 * Reads the backup, takes the pre-import snapshot, merges the backup into
 * the live config and writes ALL of the merged sections (settings,
 * playlists, categories, category assignments) in one store write, then
 * asks for a relaunch.
 *
 * Both halves were missing before (V02, in v0.9.2 and earlier): only
 * `merged.settings` was written, so deleted playlists and categories never
 * came back, and nothing relaunched, so the renderer kept its boot-time
 * cache. Its next association edit wrote the whole pre-import map back over
 * the imported entries.
 *
 * Nothing is awaited between reading the live config and the relaunch, so
 * no renderer write can land in between and be lost or win.
 *
 * Playback and every device are stopped first, once the file is known to be
 * a backup. The relaunch is app.exit(), which destroys the window without
 * its beforeunload device stop, so a Handy in HSSP would otherwise keep
 * playing the script on its own clock with no app left to stop it.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {object} opts.store              — electron/store.js (getAll, replaceData)
 * @param {() => Promise<void>} [opts.stopPlayback] — pause + stop every device, bounded
 * @param {() => Promise<void>} [opts.beforeWrite] — pre-import snapshot
 * @param {string} [opts.customThumbsDir]  — where bundled poster images go
 * @param {object} [opts.stashLibrary]     — main's stash-library-file instance
 *   (its only writer); the backup's Stash data is merged through it
 * @param {() => void} opts.relaunch       — called after a successful write
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function applyImport({ filePath, store, stopPlayback, beforeWrite, customThumbsDir, stashLibrary, relaunch } = {}) {
  const importResult = await importData(filePath, 'merge');
  if (!importResult.success) return importResult;

  // Before the snapshot and the read of the live config, so whatever the
  // renderer writes while it stops (its resume position) is in both.
  if (stopPlayback) {
    try { await stopPlayback(); } catch { /* a device that will not answer must not block the import */ }
  }

  if (beforeWrite) {
    try { await beforeWrite(); } catch { /* the safety net failing must not block the user's import */ }
  }

  // Done before the config is read, so the read → write → relaunch below
  // stays free of awaits.
  const incoming = await restoreCustomThumbs(importResult.config, importResult.customThumbs, customThumbsDir);

  // The Stash data (S1), merged by main's own instance, also before the
  // config read. A backup without it leaves this machine's file untouched;
  // a merge that fails leaves it as it was (atomic write), and the rest of
  // the import goes on.
  let stash;
  if (importResult.stashLibrary && stashLibrary && typeof stashLibrary.mergeImported === 'function') {
    try {
      const res = await stashLibrary.mergeImported(importResult.stashLibrary);
      stash = { merged: res?.ok === true };
      if (!stash.merged) console.warn(`[DataExport] The backup's Stash data was not merged: ${res?.error || 'unknown'}`);
    } catch (err) {
      stash = { merged: false };
      console.warn(`[DataExport] The backup's Stash data was not merged: ${err.message}`);
    }
  }

  try {
    const merged = mergeConfig(store.getAll(), incoming, 'merge');
    store.replaceData(merged);
  } catch (err) {
    return { success: false, error: err.message };
  }
  relaunch();
  const result = { success: true, funscriptCount: (importResult.funscripts || []).length };
  if (stash) result.stash = stash;
  return result;
}

/**
 * Deep merge two plain objects. Source values override target.
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function _deepMerge(target, source) {
  const result = { ...target };
  if (!_isPlainObject(source)) return result;
  for (const key of Object.keys(source)) {
    if (_isPlainObject(source[key]) && _isPlainObject(target[key])) {
      result[key] = _deepMerge(target[key], source[key]);
    } else if (_isBlock(target[key]) && !_sameShape(target[key], source[key])) {
      // Absence is never destructive (fixup-data 2026-11-18; also in
      // v0.9.2): a block here (an object or a list) is never replaced by a
      // backup's null, missing or wrongly shaped value. `"library": null`
      // in a hand-edited or damaged backup used to wipe every association,
      // variant and resume entry on a merge import.
      continue;
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** An object or a list: a block of settings, not one value. */
function _isBlock(value) {
  return Array.isArray(value) || _isPlainObject(value);
}

/** Both lists, or both plain objects. */
function _sameShape(a, b) {
  return Array.isArray(a) ? Array.isArray(b) : (_isPlainObject(a) && _isPlainObject(b));
}

module.exports = { exportData, importData, mergeConfig, applyImport, restoreCustomThumbs };
