// DataService — renderer-side cached data access (replaces Settings)
// Cache-first pattern: reads are synchronous from in-memory cache,
// writes update cache immediately + fire-and-forget IPC to main process.

import { eventBus } from './event-bus.js';

const SETTINGS_DEFAULTS = {
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
  },
  backend: {
    port: 5123,
    localIp: 'auto',
  },
  library: {
    directory: '',
    associations: {},
  },
  editor: {
    defaultCreator: '',
    patternPresets: [],
    fastStepFrames: 6,
  },
  notifications: {
    // One-time HEVC codec install guidance — set true when the user
    // dismisses the toast permanently. See renderer/js/hevc-detect.js
    // for what the toast does and why it exists.
    hevcDismissed: false,
  },
};

class DataService {
  constructor() {
    this._cache = {
      settings: JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)),
      playlists: [],
      categories: [],
      videoCategories: {},
      _migrated: false,
    };
    this._initialized = false;
  }

  /**
   * Initialize by loading all data from main process.
   * Must be called once before any reads.
   */
  async init() {
    // Check for legacy localStorage data and migrate if needed
    const legacyRaw = localStorage.getItem('funsync-settings');
    if (legacyRaw) {
      try {
        const legacyData = JSON.parse(legacyRaw);
        await window.funsync.migrateLocalStorage(legacyData);
        localStorage.removeItem('funsync-settings');
      } catch (err) {
        console.warn('[DataService] Migration failed:', err.message);
      }
    }

    // Load all data from main process into cache (deep clone to avoid shared references)
    const data = await window.funsync.getAllData();
    if (data) {
      this._cache = JSON.parse(JSON.stringify(data));
    }
    this._initialized = true;
  }

  // --- Settings (get/set) ---

  get(path) {
    const keys = path.split('.');
    let value = this._cache.settings;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return undefined;
      value = value[key];
    }
    return value;
  }

  set(path, value) {
    // Update cache synchronously
    const keys = path.split('.');
    let obj = this._cache.settings;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in obj) || typeof obj[keys[i]] !== 'object') {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;

    // Fire-and-forget IPC
    window.funsync.setSetting(path, value);
    eventBus.emit('settings:changed', { path, value });
  }

  addRecentFile(filePath) {
    const recent = this.get('player.recentFiles') || [];
    const filtered = recent.filter((f) => f !== filePath);
    filtered.unshift(filePath);
    const capped = filtered.slice(0, 20);

    // Update cache
    const keys = 'player.recentFiles'.split('.');
    let obj = this._cache.settings;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    obj[keys[keys.length - 1]] = capped;

    // Fire-and-forget IPC
    window.funsync.addRecentFile(filePath);
  }

  // --- Playlists ---

  getPlaylists() {
    return this._cache.playlists || [];
  }

  getPlaylist(id) {
    return this.getPlaylists().find((p) => p.id === id) || null;
  }

  async addPlaylist(name) {
    // Async — returns authoritative object from main process
    const playlist = await window.funsync.addPlaylist(name);
    this._cache.playlists.push(playlist);
    eventBus.emit('playlist:changed', { action: 'add', playlist });
    return playlist;
  }

  deletePlaylist(id) {
    this._cache.playlists = this._cache.playlists.filter((p) => p.id !== id);
    window.funsync.deletePlaylist(id);
    eventBus.emit('playlist:changed', { action: 'delete', id });
  }

  renamePlaylist(id, name) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) playlist.name = name;
    window.funsync.renamePlaylist(id, name);
    eventBus.emit('playlist:changed', { action: 'rename', id, name });
  }

  addVideoToPlaylist(id, videoPath) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist && !playlist.videoPaths.includes(videoPath)) {
      playlist.videoPaths.push(videoPath);
    }
    window.funsync.addVideoToPlaylist(id, videoPath);
    eventBus.emit('playlist:changed', { action: 'addVideo', id, videoPath });
  }

  removeVideoFromPlaylist(id, videoPath) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) {
      playlist.videoPaths = playlist.videoPaths.filter((p) => p !== videoPath);
    }
    window.funsync.removeVideoFromPlaylist(id, videoPath);
    eventBus.emit('playlist:changed', { action: 'removeVideo', id, videoPath });
  }

  // --- Categories ---

  getCategories() {
    return this._cache.categories || [];
  }

  async addCategory(name, color) {
    // Async — returns authoritative object from main process
    const category = await window.funsync.addCategory(name, color);
    this._cache.categories.push(category);
    eventBus.emit('category:changed', { action: 'add', category });
    return category;
  }

  deleteCategory(id) {
    this._cache.categories = this._cache.categories.filter((c) => c.id !== id);
    // Clean up videoCategories cache
    const mappings = this._cache.videoCategories;
    for (const path of Object.keys(mappings)) {
      mappings[path] = mappings[path].filter((cid) => cid !== id);
      if (mappings[path].length === 0) delete mappings[path];
    }
    window.funsync.deleteCategory(id);
    eventBus.emit('category:changed', { action: 'delete', id });
  }

  renameCategory(id, name) {
    const category = this._cache.categories.find((c) => c.id === id);
    if (category) category.name = name;
    window.funsync.renameCategory(id, name);
    eventBus.emit('category:changed', { action: 'rename', id, name });
  }

  // --- Category Mappings ---

  assignCategory(videoPath, catId) {
    if (!this._cache.videoCategories[videoPath]) {
      this._cache.videoCategories[videoPath] = [];
    }
    if (!this._cache.videoCategories[videoPath].includes(catId)) {
      this._cache.videoCategories[videoPath].push(catId);
    }
    window.funsync.assignCategory(videoPath, catId);
    eventBus.emit('category:changed', { action: 'assign', videoPath, catId });
  }

  unassignCategory(videoPath, catId) {
    if (this._cache.videoCategories[videoPath]) {
      this._cache.videoCategories[videoPath] = this._cache.videoCategories[videoPath].filter((id) => id !== catId);
      if (this._cache.videoCategories[videoPath].length === 0) {
        delete this._cache.videoCategories[videoPath];
      }
    }
    window.funsync.unassignCategory(videoPath, catId);
    eventBus.emit('category:changed', { action: 'unassign', videoPath, catId });
  }

  getVideoCategories(videoPath) {
    return this._cache.videoCategories[videoPath] || [];
  }

  getVideosByCategory(catId) {
    const mappings = this._cache.videoCategories;
    const paths = [];
    for (const [path, catIds] of Object.entries(mappings)) {
      if (catIds.includes(catId)) paths.push(path);
    }
    return paths;
  }
}

export const dataService = new DataService();
export { DataService, SETTINGS_DEFAULTS };
