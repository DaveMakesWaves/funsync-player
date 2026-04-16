// FunscriptEngine — Client-side funscript parsing, heatmap data, and backend conversion

export class FunscriptEngine {
  constructor({ backendPort }) {
    this.backendPort = backendPort;
    this._parsed = null;
    this._csvInfo = null;
    this._rawContent = null; // raw funscript JSON string for SDK upload
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
    // Client-side validation first
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
    };

    // Convert to CSV via backend
    try {
      this._csvInfo = await window.funsync.convertFunscript(content);
    } catch (err) {
      console.warn('Backend CSV conversion failed, using client-side data:', err.message);
      this._csvInfo = null;
    }

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
   * Get the actions array for heatmap rendering.
   * @returns {Array|null}
   */
  getActions() {
    return this._parsed?.actions || null;
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
