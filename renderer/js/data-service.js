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
  security: {
    // Hide media file NAMES in main.log (directory and extension stay).
    // Off by default: most users diagnose their own machine, where a
    // redacted log is simply a worse log. This is for the case where a log
    // is about to be pasted somewhere public.
    hideLogFileNames: false,
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

  /**
   * A value MAIN has already saved (the View menu's zoom keys write
   * `player.uiScale`, V79): update the cache and tell listeners, without
   * sending it back. An echo through set() would race a second key press
   * (main at 125%, the echo of 110% arriving after it).
   */
  applySavedSetting(path, value) {
    const keys = path.split('.');
    let obj = this._cache.settings;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in obj) || typeof obj[keys[i]] !== 'object') {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
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

  /**
   * The Favourites playlist (zaikechi #381; renderer/js/favourites.js), made
   * by main the first time it is asked for. `name` names a new one only.
   */
  async ensureFavouritesPlaylist(name) {
    const have = this.getPlaylist('favourites');
    if (have) {
      // Main renames it when it still has a built-in name (B008: made at a
      // first launch before the language was chosen); a user's name stays.
      if (typeof name !== 'string' || !name.trim() || have.name === name.trim()) return have;
      let stored = null;
      try { stored = await window.funsync?.ensureFavouritesPlaylist?.(name); } catch { stored = null; }
      if (stored && typeof stored.name === 'string' && stored.name !== have.name) {
        const cached = this._cache.playlists.find((p) => p.id === 'favourites');
        if (cached) cached.name = stored.name;
        eventBus.emit('playlist:changed', { action: 'rename', playlist: this.getPlaylist('favourites') });
      }
      return this.getPlaylist('favourites');
    }
    let playlist = null;
    try {
      playlist = await window.funsync?.ensureFavouritesPlaylist?.(name);
    } catch (err) {
      console.warn('[DataService] Favourites playlist not made:', err?.message || err);
      return null;
    }
    if (!playlist || typeof playlist !== 'object') return null;
    if (!this.getPlaylist(playlist.id)) {
      this._cache.playlists.unshift(playlist);
      eventBus.emit('playlist:changed', { action: 'add', playlist });
    }
    return this.getPlaylist(playlist.id);
  }

  /**
   * A following playlist's rule (zaikechi #381): `{kind: 'category'|'source'|'folder', …}`
   * or null to stop following. Main checks it and answers with what it kept.
   */
  async setPlaylistFollow(id, follow) {
    let stored;
    try {
      stored = await window.funsync?.setPlaylistFollow?.(id, follow);
    } catch (err) {
      console.warn('[DataService] playlist follow not saved:', err?.message || err);
      return undefined;
    }
    if (stored === undefined) return undefined;
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) {
      if (stored) playlist.follow = stored;
      else { delete playlist.follow; delete playlist.excludedPaths; }
    }
    eventBus.emit('playlist:changed', { action: 'follow', id, follow: stored || null });
    return stored;
  }

  /** The videos taken out of a following playlist by hand (the rule never adds them back). */
  setPlaylistExcluded(id, paths) {
    const clean = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p))];
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) {
      if (clean.length) playlist.excludedPaths = clean;
      else delete playlist.excludedPaths;
    }
    window.funsync?.setPlaylistExcluded?.(id, clean);
    eventBus.emit('playlist:changed', { action: 'excluded', id });
  }

  deletePlaylist(id) {
    if (id === 'favourites') return; // never deleted (store.js)
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

  setPlaylistLoop(id, loop) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) playlist.loop = !!loop;
    window.funsync.setPlaylistLoop(id, !!loop);
    eventBus.emit('playlist:changed', { action: 'setLoop', id, loop: !!loop });
  }

  setPlaylistShuffle(id, shuffle) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) playlist.shuffle = !!shuffle;
    window.funsync.setPlaylistShuffle(id, !!shuffle);
    eventBus.emit('playlist:changed', { action: 'setShuffle', id, shuffle: !!shuffle });
  }

  /** "Balance shuffle by script" per-playlist flag (zaikechi #221). */
  setPlaylistBalance(id, balance) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) playlist.balanceByScript = !!balance;
    window.funsync.setPlaylistBalance(id, !!balance);
    eventBus.emit('playlist:changed', { action: 'setBalance', id, balance: !!balance });
  }

  /** Per-playlist "prefer unwatched" shuffle bias. Mirrors setPlaylistBalance. */
  setPlaylistPreferUnwatched(id, prefer) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) playlist.preferUnwatched = !!prefer;
    window.funsync.setPlaylistPreferUnwatched(id, !!prefer);
    eventBus.emit('playlist:changed', { action: 'setPreferUnwatched', id, prefer: !!prefer });
  }

  /**
   * Replace a playlist's video order (drag / Move reorder). `newVideoPaths`
   * must be a reordering of the existing paths. Updates cache synchronously
   * + fire-and-forget IPC (last write wins; callers debounce rapid moves).
   */
  /**
   * Reorder a playlist. The cache shows the new order at once, as before,
   * and then follows main's answer: store.js accepts only a pure reorder and
   * answers with the order it kept, so a refused write (a stale or partial
   * list) used to leave the cache showing an order config.json never got,
   * until a restart (CB-14). Only the latest write for a playlist is
   * reconciled; an earlier answer is settled by the one after it.
   */
  async setPlaylistVideoPaths(id, newVideoPaths) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist && Array.isArray(newVideoPaths)) {
      playlist.videoPaths = [...newVideoPaths];
    }
    this._playlistWrites = this._playlistWrites || new Map();
    const write = (this._playlistWrites.get(id) || 0) + 1;
    this._playlistWrites.set(id, write);
    const sent = window.funsync.setPlaylistVideoPaths(id, newVideoPaths);
    eventBus.emit('playlist:changed', { action: 'reorder', id });
    let stored;
    try {
      stored = await sent;
    } catch (err) {
      console.warn('[DataService] playlist reorder failed:', err?.message || err);
      return;
    }
    if (this._playlistWrites.get(id) !== write || !Array.isArray(stored)) return;
    const current = this._cache.playlists.find((p) => p.id === id);
    if (!current) return;
    const same = current.videoPaths.length === stored.length
      && current.videoPaths.every((p, i) => p === stored[i]);
    if (same) return;
    current.videoPaths = [...stored];
    eventBus.emit('playlist:changed', { action: 'reorder', id });
  }

  /**
   * A following playlist (zaikechi #381) remembers what the user took out by
   * hand, so its rule never adds it back; adding it by hand again clears
   * that. The rule's own removals (`{ byRule: true }`) are not the user's.
   */
  _followExclude(playlist, paths, { add, byRule = false } = {}) {
    if (!playlist?.follow || byRule) return;
    const before = Array.isArray(playlist.excludedPaths) ? playlist.excludedPaths : [];
    const set = new Set(before);
    let changed = false;
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue;
      if (add && !set.has(p)) { set.add(p); changed = true; }
      if (!add && set.delete(p)) changed = true;
    }
    if (changed) this.setPlaylistExcluded(playlist.id, [...set]);
  }

  addVideoToPlaylist(id, videoPath) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist && !playlist.videoPaths.includes(videoPath)) {
      playlist.videoPaths.push(videoPath);
    }
    this._followExclude(playlist, [videoPath], { add: false });
    window.funsync.addVideoToPlaylist(id, videoPath);
    eventBus.emit('playlist:changed', { action: 'addVideo', id, videoPath });
  }

  removeVideoFromPlaylist(id, videoPath, opts = {}) {
    const playlist = this._cache.playlists.find((p) => p.id === id);
    if (playlist) {
      playlist.videoPaths = playlist.videoPaths.filter((p) => p !== videoPath);
    }
    this._followExclude(playlist, [videoPath], { add: true, byRule: opts.byRule === true });
    window.funsync.removeVideoFromPlaylist(id, videoPath);
    eventBus.emit('playlist:changed', { action: 'removeVideo', id, videoPath });
  }

  /**
   * Several videos added or removed with ONE write in main, where a call per
   * video rewrote config.json once each (a playlist's Select-mode Remove and
   * its Undo, FT-104). Added paths go on the end, as addVideoToPlaylist does.
   */
  addVideosToPlaylist(id, videoPaths, opts = {}) {
    const paths = Array.isArray(videoPaths) ? videoPaths.slice() : [];
    const playlist = this._cache.playlists.find((p) => p.id === id);
    this._followExclude(playlist, paths, { add: false, byRule: opts.byRule === true });
    if (playlist) {
      const have = new Set(playlist.videoPaths);
      for (const p of paths) {
        if (typeof p !== 'string' || have.has(p)) continue; // as store.js
        playlist.videoPaths.push(p);
        have.add(p);
      }
    }
    window.funsync.addVideosToPlaylist(id, paths);
    eventBus.emit('playlist:changed', { action: 'addVideos', id, videoPaths: paths });
  }

  removeVideosFromPlaylist(id, videoPaths, opts = {}) {
    const paths = Array.isArray(videoPaths) ? videoPaths.slice() : [];
    const drop = new Set(paths);
    const playlist = this._cache.playlists.find((p) => p.id === id);
    this._followExclude(playlist, paths, { add: true, byRule: opts.byRule === true });
    if (playlist) {
      playlist.videoPaths = playlist.videoPaths.filter((p) => !drop.has(p));
    }
    window.funsync.removeVideosFromPlaylist(id, paths);
    eventBus.emit('playlist:changed', { action: 'removeVideos', id, videoPaths: paths });
  }

  // --- Categories ---

  getCategories() {
    return this._cache.categories || [];
  }

  async addCategory(name, color, icon) {
    // Async — returns authoritative object from main process
    const category = await window.funsync.addCategory(name, color, icon || null);
    this._cache.categories.push(category);
    eventBus.emit('category:changed', { action: 'add', category });
    return category;
  }

  /**
   * Set or clear a category's icon. `null` clears back to a colour dot.
   * Cache-first so every rendered dot updates on the next repaint without
   * waiting on the IPC round trip.
   */
  setCategoryIcon(id, icon) {
    const category = this._cache.categories.find((c) => c.id === id);
    if (category) {
      if (icon) category.icon = icon;
      else delete category.icon;
    }
    window.funsync.setCategoryIcon(id, icon || null);
    eventBus.emit('category:changed', { action: 'icon', id, icon: icon || null });
  }

  setCategoryColor(id, color) {
    const category = this._cache.categories.find((c) => c.id === id);
    if (category) category.color = color;
    window.funsync.setCategoryColor(id, color);
    eventBus.emit('category:changed', { action: 'color', id, color });
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

  /** assignCategory for many videos in ONE write (store.js assignCategoryToVideos). */
  assignCategoryToVideos(videoPaths, catId) {
    const paths = (Array.isArray(videoPaths) ? videoPaths : []).filter((p) => typeof p === 'string' && p);
    for (const videoPath of paths) {
      if (!this._cache.videoCategories[videoPath]) this._cache.videoCategories[videoPath] = [];
      if (!this._cache.videoCategories[videoPath].includes(catId)) this._cache.videoCategories[videoPath].push(catId);
    }
    window.funsync.assignCategoryToVideos(paths, catId);
    eventBus.emit('category:changed', { action: 'assignMany', videoPaths: paths, catId });
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

  /**
   * Every video's categories, `{ [videoPath]: [catId, ...] }`. A COPY, so a
   * caller cannot edit the cache behind assignCategory/unassignCategory's
   * back (their IPC is what keeps main's store in step). An entry that is not
   * an array (a hand-edited or damaged config) is left out.
   *
   * The map lives at the config ROOT, not under settings, so
   * `get('library.videoCategories')` is always undefined. Used by the scan's
   * re-home of a moved video's categories (FT-005) and the library search's
   * category names (FT-046).
   */
  getAllVideoCategories() {
    const out = {};
    for (const [path, ids] of Object.entries(this._cache.videoCategories || {})) {
      if (Array.isArray(ids)) out[path] = [...ids];
    }
    return out;
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
