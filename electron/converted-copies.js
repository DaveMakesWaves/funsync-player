// Converted copies (Convert to play, Dave 2026-11-26): the H.264 copies of
// videos the player cannot decode live in `<userData>/converted`, where
// Windows' temp cleaning cannot take them ("yes move them to the data
// folder"). Settings > Data shows how many and how big, and can clear them;
// a cleared copy is made again the next time its video is played.
//
// Only files the backend writes there are touched: `<12 hex>.h264.mp4`
// (a finished copy) and `<12 hex>.h264.part.mp4` (one being written). A copy
// the player has open cannot be deleted on Windows: it is kept and counted.
'use strict';

const fs = require('fs');
const path = require('path');

const COPY = /^[0-9a-f]{12}\.h264\.mp4$/;
const PART = /^[0-9a-f]{12}\.h264\.part\.mp4$/;

/** The folder, under the app's data folder. */
function convertedDir(userDataDir) {
  return path.join(userDataDir, 'converted');
}

/**
 * The finished copies: how many and their total size.
 * @returns {Promise<{count: number, bytes: number}>}
 */
async function convertedInfo(dir) {
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return { count: 0, bytes: 0 }; }
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!COPY.test(name)) continue;
    try {
      const st = await fs.promises.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      count += 1;
      bytes += st.size;
    } catch { /* gone meanwhile */ }
  }
  return { count, bytes };
}

/**
 * Delete the finished copies. A file that cannot be deleted (open in the
 * player) is kept and counted. A part file is never touched: it may be a
 * conversion writing now (on Linux / macOS the delete would succeed and that
 * conversion fail at its end); the backend removes leftovers when it starts.
 * @returns {Promise<{removed: number, bytes: number, kept: number}>}
 */
async function clearConverted(dir) {
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return { removed: 0, bytes: 0, kept: 0 }; }
  let removed = 0;
  let bytes = 0;
  let kept = 0;
  for (const name of names) {
    if (!COPY.test(name)) continue;
    const file = path.join(dir, name);
    let size = 0;
    try { size = (await fs.promises.stat(file)).size; } catch { continue; }
    try {
      await fs.promises.unlink(file);
      removed += 1;
      bytes += size;
    } catch {
      kept += 1; // in use: the player has it open
    }
  }
  return { removed, bytes, kept };
}

/**
 * After Delete video files: remove the converted copies of the videos that
 * really went (`results` from delete-files.js, `copies` video path -> its
 * copy, asked of the backend before the delete). Only a finished copy file
 * directly in `dir` is ever removed; anything else is skipped. A copy left
 * behind otherwise stayed in the folder, counted, with no video to play it
 * (test day 2026-11-26).
 * @param {Array<{path: string, ok: boolean}>} results
 * @param {Map<string, string>} copies
 * @param {string} dir the converted folder
 * @returns {Promise<string[]>} the copies removed
 */
async function removeCopiesOf(results, copies, dir, { unlink = fs.promises.unlink, platform = process.platform } = {}) {
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const removed = [];
  for (const r of Array.isArray(results) ? results : []) {
    const copy = r?.ok ? copies.get(r.path) : null;
    if (typeof copy !== 'string' || !COPY.test(path.basename(copy))) continue;
    if (!same(path.resolve(path.dirname(copy)), path.resolve(dir))) continue;
    try {
      await unlink(copy);
      removed.push(copy);
    } catch { /* in use or gone: Settings > Data can clear it */ }
  }
  return removed;
}

module.exports = { convertedDir, convertedInfo, clearConverted, removeCopiesOf, COPY, PART };
