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
      recentFiles: [],
      gapSkip: {
        mode: 'off',
        threshold: 10000,
      },
      smoothing: 'linear',
      speedLimit: 0,
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
      collections: [],
      activeCollectionId: null,
    },
    editor: {
      defaultCreator: '',
      patternPresets: [],
    },
    knownDevices: [],
    buttplug: {
      port: 12345,
    },
    tcode: {
      port: '',
      baudRate: 115200,
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

function addVideoToPlaylist(id, videoPath) {
  const playlists = getPlaylists();
  const playlist = playlists.find((p) => p.id === id);
  if (playlist && !playlist.videoPaths.includes(videoPath)) {
    playlist.videoPaths.push(videoPath);
    conf.set('playlists', playlists);
  }
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
  addVideoToPlaylist,
  removeVideoFromPlaylist,
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
