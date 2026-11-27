// Deleting a video's files: what the dialog offers, and what FunSync forgets
// afterwards (2026-11-23, EroScripts #434; DESIGN.md §2.18). Pure: no DOM,
// no IPC.
//
// planDeletion turns main's same-folder list (electron/delete-files.js
// listVideoFiles) plus what the library knows (a hand-paired script in
// another folder, the scan's variations, a paired subtitle) into the rows of
// the dialog:
//   - the video: always, locked (it is what you asked to delete);
//   - its same-name script and axis files in its folder: ticked;
//   - variations, subtitles and anything in another folder: unticked;
//   - anything ANOTHER video also uses: locked, unticked, "kept", with that
//     video's name. Shared is judged generously (paths compared without case),
//     so a doubt keeps the file.
//
// forgetVideo takes a deleted video out of FunSync's records: its per-video
// settings, its playlist entries, its categories and its collections. An
// explicit delete, never an absence (§1.6 S6: a missing file never deletes
// data; this is the user deleting the file on purpose).

/** Per-video maps under settings.library, keyed by the video's path. */
export const PER_VIDEO_SETTING_KEYS = Object.freeze([
  'associations', 'manualVariants', 'manualVRType', 'vrFlatten', 'vrFormat',
  'customThumbnails', 'resumePositions', 'scriptTags', 'userTags', 'hiddenTags',
  'syncOffsets', 'subtitleAssociations', 'preferredVariants', 'disabledVideos',
]);

const fold = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
const nameOf = (p) => String(p || '').split(/[\\/]/).pop();
const dirOf = (p) => { const s = String(p || ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i >= 0 ? s.slice(0, i) : ''; };
const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Every string anywhere inside `value` (an association's shapes vary). */
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (isPlain(value)) for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/**
 * Who else uses each file: folded path → names of the OTHER videos.
 * @param {{ videoPath: string, videos: object[], settings: Record<string, object> }} o
 */
export function referencesByOthers({ videoPath, videos = [], settings = {} }) {
  const me = fold(videoPath);
  const byPath = new Map(videos.map((v) => [fold(v?.path), v]));
  const refs = new Map();
  const add = (file, owner) => {
    if (typeof file !== 'string' || !file) return;
    const k = fold(file);
    if (!refs.has(k)) refs.set(k, new Set());
    refs.get(k).add(owner);
  };
  for (const v of videos) {
    if (!v?.path || fold(v.path) === me) continue;
    const owner = v.name || nameOf(v.path);
    add(v.funscriptPath, owner);
    add(v.subtitlePath, owner);
    for (const variant of v.variants || []) add(variant?.path, owner);
  }
  for (const key of ['associations', 'manualVariants', 'subtitleAssociations']) {
    const map = settings[key];
    if (!isPlain(map)) continue;
    for (const [ownerPath, value] of Object.entries(map)) {
      if (fold(ownerPath) === me) continue;
      const owner = byPath.get(fold(ownerPath))?.name || nameOf(ownerPath);
      for (const s of stringsIn(value)) add(s, owner);
    }
  }
  return refs;
}

/**
 * The dialog's rows.
 * @param {{ video: object, candidates: object[], videos: object[], settings: Record<string, object> }} o
 * @returns {{ path: string, name: string, kind: string, label: string|null, size: number|null,
 *   checked: boolean, locked: boolean, sharedWith: string[], outside: boolean }[]}
 */
export function planDeletion({ video, candidates = [], videos = [], settings = {} }) {
  const videoPath = video?.path;
  if (!videoPath) return [];
  const refs = referencesByOthers({ videoPath, videos, settings });
  const folder = fold(dirOf(videoPath));
  const rows = [];
  const seen = new Set();
  const push = (c, extra = {}) => {
    const k = fold(c.path);
    if (!c.path || seen.has(k)) return;
    seen.add(k);
    const outside = fold(dirOf(c.path)) !== folder;
    const sharedWith = c.kind === 'video' ? [] : [...(refs.get(k) || [])];
    const isVideo = c.kind === 'video';
    const ownScript = !outside && (c.kind === 'script' || c.kind === 'axis');
    rows.push({
      path: c.path,
      name: nameOf(c.path),
      kind: c.kind,
      label: c.label ?? null,
      size: Number.isFinite(c.size) ? c.size : null,
      checked: isVideo || (sharedWith.length === 0 && ownScript),
      locked: isVideo || sharedWith.length > 0,
      subject: isVideo,
      sharedWith,
      outside,
      ...extra,
    });
  };
  // The video first, even if the folder listing missed it.
  push(candidates.find((c) => fold(c.path) === fold(videoPath)) || { path: videoPath, kind: 'video', size: video.size ?? null });
  for (const c of candidates) push(c);
  // What the library knows beyond the folder: a hand-paired script, the
  // scan's variations, a paired subtitle.
  const scriptish = (p) => /\.funscript$/i.test(p);
  for (const s of stringsIn(settings.associations?.[videoPath])) if (scriptish(s)) push({ path: s, kind: 'script' });
  if (video.funscriptPath) push({ path: video.funscriptPath, kind: 'script' });
  for (const v of video.variants || []) if (v?.path) push({ path: v.path, kind: 'variant', label: v.label ?? null });
  for (const s of stringsIn(settings.manualVariants?.[videoPath])) if (scriptish(s)) push({ path: s, kind: 'variant' });
  if (video.subtitlePath) push({ path: video.subtitlePath, kind: 'subtitle' });
  const sub = settings.subtitleAssociations?.[videoPath];
  if (typeof sub === 'string') push({ path: sub, kind: 'subtitle' });
  return rows;
}

/** The paths ticked and allowed: the thing being deleted (`subject`) and unlocked ticked rows. */
export function chosenPaths(rows) {
  return rows.filter((r) => r.checked && (r.subject === true || !r.locked)).map((r) => r.path);
}

/** Bytes of the given rows (unknown sizes count as 0). */
export function totalSize(rows) {
  return rows.reduce((n, r) => n + (Number.isFinite(r.size) ? r.size : 0), 0);
}

/**
 * Take a deleted video out of FunSync's records.
 * @param {object} settings the DataService (get / set / getPlaylists / removeVideoFromPlaylist /
 *   getVideoCategories / unassignCategory)
 * @param {string} videoPath
 * @returns {string[]} what it changed (for the log and the tests)
 */
export function forgetVideo(settings, videoPath) {
  const changed = [];
  if (!settings || typeof videoPath !== 'string' || !videoPath) return changed;
  for (const key of PER_VIDEO_SETTING_KEYS) {
    const map = settings.get?.(`library.${key}`);
    if (!isPlain(map) || !Object.prototype.hasOwnProperty.call(map, videoPath)) continue;
    const next = { ...map };
    delete next[videoPath];
    settings.set(`library.${key}`, next);
    changed.push(key);
  }
  for (const pl of settings.getPlaylists?.() || []) {
    if ((pl.videoPaths || []).includes(videoPath)) {
      settings.removeVideoFromPlaylist?.(pl.id, videoPath);
      changed.push(`playlist:${pl.id}`);
    }
  }
  for (const catId of settings.getVideoCategories?.(videoPath) || []) {
    settings.unassignCategory?.(videoPath, catId);
    changed.push(`category:${catId}`);
  }
  const collections = settings.get?.('library.collections');
  if (Array.isArray(collections)) {
    let touched = false;
    const next = collections.map((c) => {
      if (!isPlain(c)) return c;
      const out = { ...c };
      for (const k of ['videoPaths', 'excludedPaths']) {
        if (Array.isArray(c[k]) && c[k].includes(videoPath)) { out[k] = c[k].filter((p) => p !== videoPath); touched = true; }
      }
      return out;
    });
    if (touched) { settings.set('library.collections', next); changed.push('collections'); }
  }
  return changed;
}

/** The EroScripts tab's record of what it downloaded per post (topic id -> {video, script, scriptUrl, title, at}). */
export const DOWNLOADED_KEY = 'eroscripts.downloaded';

/**
 * The EroScripts posts these files were downloaded from (Dave, 2026-11-25:
 * "if i delete a video and funscript from the libary using the new delete
 * feature, on the eroscripts tab its still showing the video and funscript as
 * downloaded ... give the user the option to delete that too and make it
 * greyed out again on the eroscripts tab as if it were never downloaded").
 * @param {object} downloaded settings[DOWNLOADED_KEY]
 * @param {string[]} paths the files offered for deletion
 * @returns {{topicId: string, title: string}[]}
 */
export function downloadsFor(downloaded, paths) {
  if (!isPlain(downloaded) || !Array.isArray(paths) || !paths.length) return [];
  const set = new Set(paths.map(fold));
  const out = [];
  for (const [topicId, rec] of Object.entries(downloaded)) {
    if (!isPlain(rec)) continue;
    if ((rec.video && set.has(fold(rec.video))) || (rec.script && set.has(fold(rec.script)))) {
      out.push({ topicId, title: typeof rec.title === 'string' ? rec.title : '' });
    }
  }
  return out;
}

/**
 * Forget the download of the deleted files: a post's video and script each
 * go from its record when deleted, the record when neither is left (a script
 * you kept still shows as downloaded). Nothing else is written.
 * @param {{get: Function, set: Function}} settings
 * @param {string[]} deletedPaths the files that really went
 * @returns {string[]} the topic ids whose record changed
 */
export function forgetDownloads(settings, deletedPaths) {
  const downloaded = settings?.get?.(DOWNLOADED_KEY);
  if (!isPlain(downloaded) || !Array.isArray(deletedPaths) || !deletedPaths.length) return [];
  const gone = new Set(deletedPaths.map(fold));
  const next = { ...downloaded };
  const changed = [];
  for (const [topicId, rec] of Object.entries(downloaded)) {
    if (!isPlain(rec)) continue;
    const videoGone = !!rec.video && gone.has(fold(rec.video));
    const scriptGone = !!rec.script && gone.has(fold(rec.script));
    if (!videoGone && !scriptGone) continue;
    const kept = { ...rec };
    if (videoGone) delete kept.video;
    if (scriptGone) { delete kept.script; delete kept.scriptUrl; }
    if (kept.video || kept.script) next[topicId] = kept;
    else delete next[topicId];
    changed.push(topicId);
  }
  if (changed.length) settings.set(DOWNLOADED_KEY, next);
  return changed;
}
