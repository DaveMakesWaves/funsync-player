// Deleting a video's files from inside FunSync (2026-11-23; EroScripts #434:
// "would it be possible to delete videos and scripts from within the program
// instead of having to do it through file explorer?"; Dave: "full deletion is
// being asked for ... its ok to be destructive as long as we provide ample
// warning of permanent deletion"). DESIGN.md §2.18.
//
// Main is the only place a file is deleted, and only through deleteFiles:
//   - a regular file (never a folder, never a symlink),
//   - with a video, script or subtitle extension,
//   - inside one of the user's library source folders,
//   - to the Recycle Bin / Trash (the default), or permanently when the
//     renderer's dialog has had the user confirm exactly that.
// A network path (\\server\share) has no Recycle Bin on Windows, so a
// "Recycle Bin" delete there is refused rather than risk a silent permanent
// one; the dialog offers permanent deletion instead.
//
// listVideoFiles says which files belong to a video by name: the video, its
// same-name script, its axis files (Clip.twist.funscript), its variations
// (Clip.soft.funscript) and its subtitles (Clip.srt, Clip.en.srt), in its own
// folder. The renderer adds what the library knows (a hand-paired script
// elsewhere) and marks anything another video also uses.
'use strict';

const path = require('path');
const fsDefault = require('fs');
const { AXIS_SUFFIXES } = require('./library-scan');

// The media types: the main process's one list (media-extensions.js).
const VIDEO_EXTS = require('./media-extensions').MEDIA_EXTS;
const SCRIPT_EXTS = ['.funscript'];
const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa'];
const DELETABLE_EXTS = new Set([...VIDEO_EXTS, ...SCRIPT_EXTS, ...SUBTITLE_EXTS]);

/** The reasons a file was not deleted (the renderer words them). */
const REASONS = Object.freeze({
  INVALID: 'invalid',
  WRONG_TYPE: 'wrong-type',
  OUTSIDE: 'outside-library',
  NOT_FILE: 'not-a-file',
  NO_BIN: 'no-recycle-bin',
  IN_USE: 'in-use',
  GONE: 'not-found',
  FAILED: 'failed',
});

function pathApi(platform) { return platform === 'win32' ? path.win32 : path.posix; }

/** Is `p` inside `root` (not root itself)? Case-insensitive on Windows (path.win32.relative is). */
function isInside(root, p, platform = process.platform) {
  if (typeof root !== 'string' || !root || typeof p !== 'string' || !p) return false;
  const api = pathApi(platform);
  const rel = api.relative(api.resolve(root), api.resolve(p));
  return !!rel && !rel.startsWith('..') && !api.isAbsolute(rel);
}

/** A UNC path (\\server\share\…): no Recycle Bin on Windows. */
function isNetworkPath(p, platform = process.platform) {
  return platform === 'win32' && typeof p === 'string' && /^(\\\\|\/\/)[^\\/]/.test(p);
}

function deletable(p) {
  return DELETABLE_EXTS.has(path.extname(String(p)).toLowerCase());
}

/**
 * The files that belong to a video by name, in its folder.
 * @param {string} videoPath
 * @param {{ fs?: typeof import('fs'), platform?: string }} [deps]
 * @returns {Promise<{ path: string, kind: 'video'|'script'|'axis'|'variant'|'subtitle', label: string|null, size: number|null }[]>}
 */
async function listVideoFiles(videoPath, { fs = fsDefault, platform = process.platform } = {}) {
  if (typeof videoPath !== 'string' || !videoPath) return [];
  const api = pathApi(platform);
  const dir = api.dirname(videoPath);
  const videoName = api.basename(videoPath);
  const base = videoName.slice(0, videoName.length - api.extname(videoName).length);
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    const full = api.join(dir, name);
    let kind = null; let label = null;
    const ext = api.extname(name).toLowerCase();
    const stem = name.slice(0, name.length - ext.length); // "Clip" | "Clip.twist" | "Clip.en"
    if (fold(name) === fold(videoName)) {
      kind = 'video';
    } else if (fold(stem) === fold(base) || fold(stem).startsWith(fold(base) + '.')) {
      const middle = stem.length > base.length ? stem.slice(base.length + 1) : ''; // "" | "twist" | "soft" | "en"
      if (ext === '.funscript') {
        if (!middle) kind = 'script';
        else if (AXIS_SUFFIXES.has(middle.toLowerCase())) { kind = 'axis'; label = middle; }
        else { kind = 'variant'; label = middle; }
      } else if (SUBTITLE_EXTS.includes(ext)) {
        kind = 'subtitle'; label = middle || null;
      }
    }
    if (!kind) continue;
    let size = null;
    try { size = (await fs.promises.stat(full)).size; } catch { size = null; }
    out.push({ path: full, kind, label, size });
  }
  const order = { video: 0, script: 1, axis: 2, variant: 3, subtitle: 4 };
  out.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path, 'en'));
  return out;
}

/**
 * Delete files, each on its own; one that cannot go never stops the rest.
 * @param {string[]} paths
 * @param {{ permanent?: boolean, roots: string[], fs?: typeof import('fs'),
 *   trashItem: (p: string) => Promise<void>, platform?: string, log?: { info: Function, warn: Function } }} opts
 * @returns {Promise<{ path: string, ok: boolean, size?: number, reason?: string, error?: string }[]>}
 */
async function deleteFiles(paths, { permanent = false, roots = [], fs = fsDefault, trashItem, platform = process.platform, log = console } = {}) {
  const results = [];
  const list = Array.isArray(paths) ? paths : [];
  const rootList = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r);
  for (const p of list) {
    if (typeof p !== 'string' || !p) { results.push({ path: String(p), ok: false, reason: REASONS.INVALID }); continue; }
    if (!deletable(p)) { results.push({ path: p, ok: false, reason: REASONS.WRONG_TYPE }); continue; }
    if (!rootList.some((r) => isInside(r, p, platform))) { results.push({ path: p, ok: false, reason: REASONS.OUTSIDE }); continue; }
    let st;
    try { st = await fs.promises.lstat(p); } catch (err) {
      results.push({ path: p, ok: false, reason: err?.code === 'ENOENT' ? REASONS.GONE : REASONS.FAILED, error: err?.message });
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) { results.push({ path: p, ok: false, reason: REASONS.NOT_FILE }); continue; }
    if (!permanent && isNetworkPath(p, platform)) { results.push({ path: p, ok: false, reason: REASONS.NO_BIN }); continue; }
    try {
      if (permanent) await fs.promises.unlink(p);
      else await trashItem(p);
      log.info?.(`[Delete] ${permanent ? 'Deleted permanently' : 'Moved to the bin'}: ${p}`);
      results.push({ path: p, ok: true, size: st.size });
    } catch (err) {
      const inUse = ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code) || /being used|in use|busy/i.test(err?.message || '');
      log.warn?.(`[Delete] Could not delete ${p}: ${err?.message || err}`);
      results.push({ path: p, ok: false, reason: inUse ? REASONS.IN_USE : REASONS.FAILED, error: err?.message });
    }
  }
  const done = results.filter((r) => r.ok).length;
  log.info?.(`[Delete] ${permanent ? 'Permanent' : 'Recycle Bin'} batch: ${done} done, ${results.length - done} not`);
  return results;
}

module.exports = {
  listVideoFiles, deleteFiles, isInside, isNetworkPath, deletable,
  REASONS, VIDEO_EXTS, SCRIPT_EXTS, SUBTITLE_EXTS,
};
