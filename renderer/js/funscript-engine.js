// FunscriptEngine — Client-side funscript parsing, heatmap data, and backend conversion

import { parseFunscriptTime } from './funscript-time.js';
import { applyFiller } from './filler-engine.js';

/**
 * Strip a leading UTF-8 BOM (U+FEFF) from a JSON string. Some scripting
 * tools (Windows editors, older OFS, hand-saved files) write a leading
 * BOM that JSON.parse rejects. The Electron `read-funscript` IPC strips
 * it at the I/O boundary; this helper is the defence-in-depth layer
 * for content arriving via `file.text()` (drag-and-drop, browse) or
 * other in-process sources.
 *
 * Exported so any module that does its own funscript JSON.parse can
 * stay safe without re-implementing the strip.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripBOM(content) {
  if (typeof content !== 'string') return content;
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

// Auto-palette for chapters that don't carry an author color. Chosen to
// sit alongside the heatmap (which spans cool-to-hot reds/oranges) —
// these are de-saturated mid-tones so the chapter strip reads as
// "metadata" rather than competing with the stroke-density gradient.
const CHAPTER_AUTO_PALETTE = [
  '#5b8def', '#8e6cef', '#22b8a6', '#d97a4d',
  '#6c8a3a', '#c8557a', '#3aa8c8', '#a8783a',
];

/**
 * Parse `metadata.chapters` (or top-level `chapters` for scripts that
 * inline them) into ms-int normalised entries. Reverse chapters
 * (endMs < startMs) are dropped per SCOPE C-E11. Color falls back to
 * the palette by index; both 'color' and 'colour' spellings accepted.
 *
 * @param {Object} data — parsed funscript JSON
 * @returns {Array<{startMs:number,endMs:number,name:string,color:string}>}
 */
function parseChapters(data) {
  const src = data?.metadata?.chapters ?? data?.chapters;
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const c of src) {
    if (!c || typeof c !== 'object') continue;
    const startMs = parseFunscriptTime(c.startTime ?? c.start ?? c.at);
    const endMs   = parseFunscriptTime(c.endTime ?? c.end);
    if (startMs === null || endMs === null) continue;
    if (endMs < startMs) continue;  // C-E11: drop reversed
    const name = typeof c.name === 'string' ? c.name : '';
    const color = (typeof c.color === 'string' && c.color)
      || (typeof c.colour === 'string' && c.colour)
      || CHAPTER_AUTO_PALETTE[out.length % CHAPTER_AUTO_PALETTE.length];
    out.push({ startMs, endMs, name, color });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * Parse `metadata.bookmarks` (or top-level `bookmarks`) into ms-int
 * normalised entries. Accepts both `at: <number>` and `time: "HH:MM:SS"`
 * shapes. Sorted by time.
 *
 * @param {Object} data
 * @returns {Array<{at:number,name:string}>}
 */
function parseBookmarks(data) {
  const src = data?.metadata?.bookmarks ?? data?.bookmarks;
  if (!Array.isArray(src)) return [];
  const out = [];
  for (const b of src) {
    if (!b || typeof b !== 'object') continue;
    const at = parseFunscriptTime(b.at ?? b.time);
    if (at === null) continue;
    const name = typeof b.name === 'string' ? b.name : '';
    out.push({ at, name });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

export class FunscriptEngine {
  constructor({ backendPort }) {
    this.backendPort = backendPort;
    this._parsed = null;
    this._csvInfo = null;
    this._rawContent = null; // raw funscript JSON string for SDK upload
    this._fillerOptions = null;
    this._filledActions = null; // authored + gap filler, or null when off
  }

  /**
   * Parse a .funscript file from a File object.
   * Validates structure, converts to CSV via backend, stores result.
   * @param {File} file
   * @returns {Object} Parsed funscript info
   */
  async loadFile(file) {
    const content = await file.text();
    return this.loadContent(content, file.name);
  }

  /**
   * Parse funscript from raw JSON string.
   * @param {string} content - Raw .funscript JSON
   * @param {string} filename - Original filename
   * @returns {Object} Parsed info with actions, duration, CSV URL
   */
  async loadContent(content, filename = 'unknown.funscript') {
    // Client-side validation first. stripBOM() defends against
    // BOM-prefixed files arriving via drag-and-drop / `file.text()`
    // (the IPC path also strips, so this is the second line).
    content = stripBOM(content);
    let data;
    try {
      data = JSON.parse(content);
    } catch (e) {
      throw new Error(`Invalid funscript JSON: ${e.message}`);
    }

    if (!data.actions || !Array.isArray(data.actions)) {
      throw new Error('Funscript missing "actions" array');
    }

    if (data.actions.length === 0) {
      throw new Error('Funscript has no actions');
    }

    // Sort actions by timestamp
    data.actions.sort((a, b) => a.at - b.at);

    // Store raw content for SDK upload (SDK handles its own conversion)
    this._rawContent = content;

    this._parsed = {
      filename,
      version: data.version || '1.0',
      inverted: data.inverted || false,
      range: data.range || 100,
      actions: data.actions,
      actionCount: data.actions.length,
      durationMs: data.actions[data.actions.length - 1].at,
      // Per SCOPE-chapters-bookmarks.md §3: extract chapters + bookmarks
      // from `metadata` (or the top-level keys some scripts use). Both
      // are normalised to ms-int here so progress-bar / keyboard nav /
      // tooltip code never has to re-parse.
      chapters: parseChapters(data),
      bookmarks: parseBookmarks(data),
    };

    // Convert to CSV via backend
    try {
      this._csvInfo = await window.funsync.convertFunscript(content);
    } catch (err) {
      console.warn('Backend CSV conversion failed, using client-side data:', err.message);
      this._csvInfo = null;
    }

    // A new script invalidates any filler built for the previous one.
    this._rebuildFiller();

    return this.getInfo();
  }

  /**
   * Get funscript summary info.
   */
  getInfo() {
    if (!this._parsed) return null;

    return {
      filename: this._parsed.filename,
      version: this._parsed.version,
      inverted: this._parsed.inverted,
      range: this._parsed.range,
      actionCount: this._parsed.actionCount,
      durationMs: this._parsed.durationMs,
      durationFormatted: this._formatDuration(this._parsed.durationMs),
      localUrl: this._csvInfo?.local_url || null,
      csvHash: this._csvInfo?.hash || null,
      csvSizeBytes: this._csvInfo?.size_bytes || null,
    };
  }

  /**
   * The actions to PLAY: authored content plus any gap filler.
   *
   * Filler points carry `_filler: true`. Callers that need the author's
   * content on its own — anything measuring what the script IS, rather than
   * what to send — must use `getAuthoredActions()` instead. Getting that
   * wrong makes the range extender stretch a script using a factor derived
   * from filler it is not part of.
   *
   * @returns {Array|null}
   */
  getActions() {
    return this._filledActions || this._parsed?.actions || null;
  }

  /**
   * The author's actions, with no filler. Use this for natural-range and
   * anything else that characterises the script itself.
   * @returns {Array|null}
   */
  getAuthoredActions() {
    return this._parsed?.actions || null;
  }

  /**
   * Set (or clear) gap-filler options and rebuild the played action list.
   *
   * Filler is a playback-time transform over a COPY. The authored actions
   * and the file on disk are never modified.
   *
   * @param {object|null} options — see filler-engine.js; `enabled: false`
   *   or null clears any filler.
   */
  setFillerOptions(options) {
    this._fillerOptions = options || null;
    this._rebuildFiller();
  }

  /** @returns {boolean} whether the played list currently contains filler. */
  get hasFiller() {
    return !!this._filledActions;
  }

  _rebuildFiller() {
    const opts = this._fillerOptions;
    if (!this._parsed || !opts || !opts.enabled) {
      this._filledActions = null;
      return;
    }
    const merged = applyFiller(this._parsed.actions, {
      ...opts,
      totalDurationMs: opts.totalDurationMs || 0,
    });
    // Only take the merged list if filler was actually produced, so the
    // common case keeps returning the original array by reference.
    this._filledActions = merged.some((a) => a._filler) ? merged : null;
  }

  /**
   * Get the chapter list (already ms-int normalised + sorted).
   * Returns `[]` (not null) when no chapters present — caller can
   * `length`-check without a null-guard.
   * @returns {Array<{startMs:number,endMs:number,name:string,color:string}>}
   */
  getChapters() {
    return this._parsed?.chapters || [];
  }

  /**
   * Get the bookmark list (already ms-int normalised + sorted).
   * Returns `[]` when no bookmarks present.
   * @returns {Array<{at:number,name:string}>}
   */
  getBookmarks() {
    return this._parsed?.bookmarks || [];
  }

  /**
   * Get the action position at a given time (linear interpolation).
   * @param {number} timeMs - Timestamp in milliseconds
   * @returns {number} Position 0-100
   */
  getPositionAt(timeMs) {
    const actions = this._parsed?.actions;
    if (!actions || actions.length === 0) return 50;

    // Before first action
    if (timeMs <= actions[0].at) return actions[0].pos;

    // After last action
    if (timeMs >= actions[actions.length - 1].at) return actions[actions.length - 1].pos;

    // Binary search for surrounding actions
    let lo = 0;
    let hi = actions.length - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (actions[mid].at <= timeMs) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    // Linear interpolation
    const a = actions[lo];
    const b = actions[hi];
    const t = (timeMs - a.at) / (b.at - a.at);
    return a.pos + t * (b.pos - a.pos);
  }

  /**
   * Get the local URL for the Handy to download the CSV script.
   * @returns {string|null}
   */
  getLocalUrl() {
    return this._csvInfo?.local_url || null;
  }

  /**
   * Get the raw CSV content for cloud upload.
   * @returns {string|null}
   */
  getCsvContent() {
    return this._csvInfo?.csv || null;
  }

  /**
   * Get the raw funscript JSON string for SDK upload.
   * The SDK's uploadDataToServer() handles conversion to its own CSV format.
   * @returns {string|null}
   */
  getRawContent() {
    return this._rawContent;
  }

  /**
   * Check if a funscript is currently loaded.
   */
  get isLoaded() {
    return this._parsed !== null;
  }

  /**
   * Get metadata (everything except actions) for preserving during save.
   * @returns {Object|null}
   */
  getMetadata() {
    if (!this._rawContent) return null;
    try {
      const data = JSON.parse(this._rawContent);
      const { actions, ...metadata } = data;
      return metadata;
    } catch {
      return null;
    }
  }

  /**
   * Replace the parsed actions array (e.g. after editor changes).
   * Also updates _rawContent so Handy SDK re-upload uses the new actions.
   * @param {Array<{at: number, pos: number}>} actions
   */
  reloadActions(actions) {
    if (!this._parsed) return;
    this._parsed.actions = actions.map(a => ({ at: a.at, pos: a.pos }));
    this._parsed.actions.sort((a, b) => a.at - b.at);
    this._parsed.actionCount = this._parsed.actions.length;
    if (this._parsed.actions.length > 0) {
      this._parsed.durationMs = this._parsed.actions[this._parsed.actions.length - 1].at;
    }
    // Rebuild raw content for SDK upload
    const metadata = this.getMetadata() || {};
    metadata.actions = this._parsed.actions;
    this._rawContent = JSON.stringify(metadata);
  }

  /**
   * Clear loaded funscript data.
   */
  clear() {
    this._parsed = null;
    this._csvInfo = null;
    this._rawContent = null;
    this._filledActions = null;
  }

  _formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}

/**
 * Check if a video and funscript file share the same base name.
 * @param {string} videoName - e.g. "my-video.mp4"
 * @param {string} scriptName - e.g. "my-video.funscript"
 * @returns {boolean}
 */
export function isAutoMatch(videoName, scriptName) {
  const normalize = (name) => {
    const dot = name.lastIndexOf('.');
    const base = dot === -1 ? name : name.slice(0, dot);
    return base.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  return normalize(videoName) === normalize(scriptName);
}
