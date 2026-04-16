// DataExport — Export and import application data as .funsync-backup (zip) files
// Runs in the main process. Uses JSZip for archive creation/reading.

const fs = require('fs');
const path = require('path');

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

/**
 * Export application data to a .funsync-backup zip file.
 *
 * @param {object} configData — full config object from store.getAll()
 * @param {string} outputPath — destination file path
 * @param {object} [options]
 * @param {string[]} [options.funscriptPaths] — optional funscript file paths to include
 * @returns {Promise<{success: boolean, path: string, error?: string}>}
 */
async function exportData(configData, outputPath, options = {}) {
  try {
    const Zip = await getJSZip();
    const zip = new Zip();

    // Always include config.json
    zip.file('config.json', JSON.stringify(configData, null, 2));

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
    const zip = await Zip.loadAsync(buffer);

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

    return { success: true, config, funscripts };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Merge imported config into existing config.
 * In merge mode: imported playlists/categories are added (skip duplicates by name).
 * In overwrite mode: imported data replaces existing.
 *
 * @param {object} existing — current config from store.getAll()
 * @param {object} imported — config from backup
 * @param {'merge'|'overwrite'} mode
 * @returns {object} merged config
 */
function mergeConfig(existing, imported, mode) {
  if (mode === 'overwrite') {
    return { ...imported };
  }

  // Merge mode: settings from import override, lists are merged
  const merged = JSON.parse(JSON.stringify(existing));

  // Merge settings (imported values override)
  if (imported.settings) {
    merged.settings = _deepMerge(merged.settings || {}, imported.settings);
  }

  // Merge playlists (skip duplicates by name)
  if (imported.playlists) {
    const existingNames = new Set((merged.playlists || []).map(p => p.name));
    for (const playlist of imported.playlists) {
      if (!existingNames.has(playlist.name)) {
        merged.playlists.push(playlist);
      }
    }
  }

  // Merge categories (skip duplicates by name)
  if (imported.categories) {
    const existingNames = new Set((merged.categories || []).map(c => c.name));
    for (const category of imported.categories) {
      if (!existingNames.has(category.name)) {
        merged.categories.push(category);
      }
    }
  }

  // Merge video categories (union)
  if (imported.videoCategories) {
    for (const [videoPath, catIds] of Object.entries(imported.videoCategories)) {
      if (!merged.videoCategories[videoPath]) {
        merged.videoCategories[videoPath] = catIds;
      } else {
        const existing = new Set(merged.videoCategories[videoPath]);
        for (const id of catIds) {
          if (!existing.has(id)) merged.videoCategories[videoPath].push(id);
        }
      }
    }
  }

  return merged;
}

/**
 * Deep merge two plain objects. Source values override target.
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function _deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = _deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { exportData, importData, mergeConfig };
