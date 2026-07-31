// Store — main process data store wrapping electron-conf
const { randomUUID } = require('crypto');

let Conf = null;
let conf = null;

const DEFAULTS = {
  settings: {
    handy: {
      connectionKey: '',
      defaultOffset: 0,
      slideMin: 0,
      slideMax: 100,
      scriptHostMode: 'local',
      syncRounds: 30,
    },
    player: {
      volume: 80,
      theme: 'dark',
      // Interface style — 'classic' (current look) or 'modern' (same palette,
      // modernised depth/spacing/motion). Orthogonal to `theme`. See
      // notes/features/SCOPE-modern-theme.md.
      uiStyle: 'classic',
      recentFiles: [],
      gapSkip: {
        mode: 'off',
        threshold: 10000,
      },
      upNext: {
        mode: 'auto',
        countdownSec: 10,
      },
      preferMultiAxis: 'single',
      smoothing: 'linear',
      speedLimit: 0,
      // Keep the video playing in a docked corner overlay while browsing
      // the library, instead of stopping on leave (mini-player). Default on.
      miniPlayer: true,
      // i18n — locked decisions in notes/features/IMPL-multi-language.md
      // #2: default is English, not 'auto'.
      // #3: _localeOfferedFor tracks the locale that's already been
      //     surfaced via the first-launch toast so we don't re-offer.
      language: 'en',
      _localeOfferedFor: null,
    },
    backend: {
      port: 5123,
      localIp: 'auto',
    },
    library: {
      directory: '',
      sources: [],
      associations: {},
      manualVariants: {},
      // Per-path manual VR-classification override. Value is `'vr'` or
      // `'flat'`; absent means use the auto-detection heuristic.
      // Tri-state covers both flipping a missed VR file → VR and
      // clearing a false-positive on a flat file with a VR-like token.
      manualVRType: {},
      // Per-path VR-as-flat playback override. Legacy two-string shape
      // — value was `'left'` or `'right'`. Kept indefinitely as a read
      // fallback for downgrade safety (a user reverting to <0.7.x still
      // sees their saved eye preference). New writes go to vrFormat
      // below; this key is not updated post-migration.
      vrFlatten: {},
      // Phase 1 of VR-flatten expansion (2026-05-21). Per-path richer
      // schema:
      //   { projection: 'sbs-half'|'sbs-full'|'tb-half'|'tb-full'|'flat',
      //     eye: 'left'|'right'|null,
      //     zoom: 1.0,
      //     source: 'auto'|'manual' }
      // Old vrFlatten entries lazy-migrate on read; no batch migration.
      // Non-planar projections (fisheye/equirect/MKX/RF52/EAC) reserved
      // for Phase 2a/2b — they appear disabled in the panel dropdown.
      vrFormat: {},
      // Per-path custom thumbnail override. Value is `{ seekPct: 0..1 }` —
      // the user picked a specific frame for the library tile instead of
      // the auto-generated 10%-mark frame. Absent means auto.
      customThumbnails: {},
      collections: [],
      activeCollectionId: null,
    },
    editor: {
      defaultCreator: '',
      patternPresets: [],
      // Pop-out window — size only, not position. Multi-monitor users
      // move setups around; restoring at last-saved coords on a setup
      // that no longer has that monitor lands the window off-screen.
      popoutBounds: null,
    },
    knownDevices: [],
    buttplug: {
      port: 12345,
    },
    tcode: {
      transport: 'serial',  // 'serial' | 'udp' | 'websocket'
      port: '',             // serial port path (legacy field, still in use)
      baudRate: 115200,
      udpHost: '',          // 2.4 GHz wireless ESP-NOW bridge etc.
      udpPort: 0,
      wsUrl: '',            // ws://device.local:81  (also restim/MFP-consumer URLs)
      precision: 3,         // 3 = TCode-0.2 (L0500), 4 = TCode-0.3 (L05000)
      updateRateHz: 25,     // output rate; higher = smoother on wired OSR2+/SR6 (advanced)
      axisRanges: {},
      axisEnabled: {},
    },
    autoblow: {
      token: '',
      offset: 0,
    },
  },
  playlists: [],
  categories: [],
  videoCategories: {},
  _migrated: false,
};

async function initStore() {
  // electron-conf is ESM-only, so we use dynamic import
  const mod = await import('electron-conf');
  Conf = mod.default || mod.Conf;
  conf = new Conf({ defaults: DEFAULTS });
  return conf;
}

/**
 * Subscribe to every config write. Used by data-backup to schedule a
 * debounced snapshot after significant mutations. Returns the
 * unsubscribe function from electron-conf.
 *
 * Called by main.js right after initStore() so the very first write
 * (which is often the migration) is observed too.
 */
function subscribe(callback) {
  if (!conf || typeof conf.onDidAnyChange !== 'function') {
    return () => {};
  }
  return conf.onDidAnyChange(callback);
}

function getAll() {
  return JSON.parse(JSON.stringify({
    settings: conf.get('settings'),
    playlists: conf.get('playlists'),
    categories: conf.get('categories'),
    videoCategories: conf.get('videoCategories'),
    _migrated: conf.get('_migrated'),
  }));
}

function getSetting(path) {
  return conf.get(`settings.${path}`);
}

function setSetting(path, value) {
  conf.set(`settings.${path}`, value);
}

function addRecentFile(filePath) {
  const recent = conf.get('settings.player.recentFiles') || [];
  const filtered = recent.filter((f) => f !== filePath);
  filtered.unshift(filePath);
  conf.set('settings.player.recentFiles', filtered.slice(0, 20));
}

// --- Playlists ---

function getPlaylists() {
  return conf.get('playlists') || [];
}

function getPlaylist(id) {
  const playlists = getPlaylists();
  return playlists.find((p) => p.id === id) || null;
}

function addPlaylist(name) {
  const playlists = getPlaylists();
  const playlist = {
    id: randomUUID(),
    name,
    createdAt: Date.now(),
    videoPaths: [],
  };
  playlists.push(playlist);
  conf.set('playlists', playlists);
  return playlist;
}

function deletePlaylist(id) {
  const playlists = getPlaylists().filter((p) => p.id !== id);
  conf.set('playlists', playlists);
}

function renamePlaylist(id, name) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (playlist) {
    playlist.name = name;
    conf.set('playlists', playlists);
  }
}

function setPlaylistLoop(id, loop) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (playlist) {
    playlist.loop = !!loop;
    conf.set('playlists', playlists);
  }
}

function setPlaylistShuffle(id, shuffle) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (playlist) {
    playlist.shuffle = !!shuffle;
    conf.set('playlists', playlists);
  }
}

function addVideoToPlaylist(id, videoPath) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (playlist && !playlist.videoPaths.includes(videoPath)) {
    playlist.videoPaths.push(videoPath);
    conf.set('playlists', playlists);
  }
}

/**
 * Replace a playlist's videoPaths with a new ordering. Used by drag/Move
 * reorder. Validates that `newVideoPaths` is the same SET as the current
 * paths (a reorder, not an add/remove) — defends against a stale renderer
 * array silently dropping or duplicating entries.
 */
function setPlaylistVideoPaths(id, newVideoPaths) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (!playlist || !Array.isArray(newVideoPaths)) return;
  const before = [...playlist.videoPaths].sort();
  const after = [...newVideoPaths].sort();
  if (before.length !== after.length || before.some((p, i) => p !== after[i])) {
    return; // not a pure reorder — refuse rather than corrupt the playlist
  }
  playlist.videoPaths = [...newVideoPaths];
  conf.set('playlists', playlists);
}

function removeVideoFromPlaylist(id, videoPath) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (playlist) {
    playlist.videoPaths = playlist.videoPaths.filter((p) => p !== videoPath);
    conf.set('playlists', playlists);
  }
}

// --- Categories ---

function getCategories() {
  return conf.get('categories') || [];
}

function addCategory(name, color) {
  const categories = getCategories();
  const category = {
    id: randomUUID(),
    name,
    color,
  };
  categories.push(category);
  conf.set('categories', categories);
  return category;
}

function deleteCategory(id) {
  const categories = getCategories().filter((c) => c.id !== id);
  conf.set('categories', categories);
  // Clean up videoCategories references
  const mappings = conf.get('videoCategories') || {};
  for (const path of Object.keys(mappings)) {
    mappings[path] = mappings[path].filter((cid) => cid !== id);
    if (mappings[path].length === 0) delete mappings[path];
  }
  conf.set('videoCategories', mappings);
}

function renameCategory(id, name) {
  const categories = getCategories();
  const category = categories.find((c) => c.id === id);
  if (category) {
    category.name = name;
    conf.set('categories', categories);
  }
}

// --- Category Mappings ---

function assignCategory(videoPath, catId) {
  const mappings = conf.get('videoCategories') || {};
  if (!mappings[videoPath]) mappings[videoPath] = [];
  if (!mappings[videoPath].includes(catId)) {
    mappings[videoPath].push(catId);
    conf.set('videoCategories', mappings);
  }
}

function unassignCategory(videoPath, catId) {
  const mappings = conf.get('videoCategories') || {};
  if (mappings[videoPath]) {
    mappings[videoPath] = mappings[videoPath].filter((id) => id !== catId);
    if (mappings[videoPath].length === 0) delete mappings[videoPath];
    conf.set('videoCategories', mappings);
  }
}

function getVideoCategories(videoPath) {
  const mappings = conf.get('videoCategories') || {};
  return mappings[videoPath] || [];
}

function getVideosByCategory(catId) {
  const mappings = conf.get('videoCategories') || {};
  const paths = [];
  for (const [path, catIds] of Object.entries(mappings)) {
    if (catIds.includes(catId)) paths.push(path);
  }
  return paths;
}

// --- Migration helper (direct conf access for root-level keys) ---

function isMigrated() {
  return conf.get('_migrated') === true;
}

function migrateFromLegacy(legacyData) {
  if (!legacyData || typeof legacyData !== 'object') return;

  // Settings
  const settingKeys = ['handy', 'player', 'backend', 'library'];
  for (const key of settingKeys) {
    if (legacyData[key] && typeof legacyData[key] === 'object') {
      for (const [subKey, value] of Object.entries(legacyData[key])) {
        conf.set(`settings.${key}.${subKey}`, value);
      }
    }
  }

  // Playlists
  if (Array.isArray(legacyData.playlists)) {
    const valid = legacyData.playlists
      .filter((p) => p && p.id && p.name)
      .map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt || Date.now(),
        videoPaths: Array.isArray(p.videoPaths) ? p.videoPaths : [],
      }));
    conf.set('playlists', valid);
  }

  // Categories
  if (Array.isArray(legacyData.categories)) {
    const valid = legacyData.categories
      .filter((c) => c && c.id && c.name)
      .map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color || '#3498db',
      }));
    conf.set('categories', valid);
  }

  // Video category mappings
  if (legacyData.videoCategories && typeof legacyData.videoCategories === 'object') {
    const clean = {};
    for (const [path, catIds] of Object.entries(legacyData.videoCategories)) {
      if (Array.isArray(catIds) && catIds.length > 0) {
        clean[path] = catIds;
      }
    }
    conf.set('videoCategories', clean);
  }

  conf.set('_migrated', true);
}

module.exports = {
  DEFAULTS,
  initStore,
  subscribe,
  getAll,
  getSetting,
  setSetting,
  addRecentFile,
  getPlaylists,
  getPlaylist,
  addPlaylist,
  deletePlaylist,
  renamePlaylist,
  setPlaylistLoop,
  setPlaylistShuffle,
  addVideoToPlaylist,
  removeVideoFromPlaylist,
  setPlaylistVideoPaths,
  getCategories,
  addCategory,
  deleteCategory,
  renameCategory,
  assignCategory,
  unassignCategory,
  getVideoCategories,
  getVideosByCategory,
  isMigrated,
  migrateFromLegacy,
};
