'use strict';

// Where a file picker opens for "Locate" (Dave, 2026-11-18: "Script not
// found" opens the file explorer "to where the path says it should be"):
// the folder of a stored script path, or its nearest parent that exists when
// that folder is gone too. Read-only: it only asks whether folders exist and
// never creates one. Untrusted input (it comes over IPC from the renderer):
// anything but a plain absolute path string is refused, and a folder that
// does not answer in time (a dead network share) counts as not there.

const fs = require('fs');
const path = require('path');

const MAX_PATH_CHARS = 4096;
/** Per folder asked: a dead mapped drive can block for seconds (path-status.js). */
const FOLDER_TIMEOUT_MS = 800;
/** All the folders of one walk together. */
const WALK_BUDGET_MS = 2500;
const MAX_LEVELS = 64;

/** A plain absolute path string, nothing else (no NUL, not too long). */
function isPlainAbsolutePath(p, pathApi = path) {
  return typeof p === 'string'
    && p.length > 0
    && p.length <= MAX_PATH_CHARS
    && !p.includes('\0')
    && pathApi.isAbsolute(p);
}

async function isFolder(dir, timeoutMs = FOLDER_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      fs.promises.stat(dir).then((st) => st.isDirectory(), () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The nearest existing folder for `filePath` (its own folder first), or null
 * (a refused path, no folder up to the root answers, or out of time).
 *
 * @param {string} filePath the stored path of the script that is not found
 * @param {{isFolder?: (dir: string) => Promise<boolean>, pathApi?: object, now?: () => number}} [deps]
 * @returns {Promise<string|null>}
 */
async function nearestExistingFolder(filePath, deps = {}) {
  const pathApi = deps.pathApi || path;
  const ask = deps.isFolder || isFolder;
  const now = deps.now || Date.now;
  if (!isPlainAbsolutePath(filePath, pathApi)) return null;
  const start = now();
  let dir = pathApi.dirname(filePath);
  for (let i = 0; i < MAX_LEVELS; i++) {
    if (now() - start > WALK_BUDGET_MS) return null;
    if (await ask(dir)) return dir;
    const up = pathApi.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

module.exports = { nearestExistingFolder, isPlainAbsolutePath, FOLDER_TIMEOUT_MS, WALK_BUDGET_MS };
