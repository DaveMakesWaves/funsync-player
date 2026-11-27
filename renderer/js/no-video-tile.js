// The "no picture" tile: a file with no video track (an audio file, N-05) or
// a saved stream with no picture of its own. The app logo in a muted grey
// and the file's title, the size of a thumbnail (styles/no-video-tile.css).
//
// One builder for every surface (TODO triage 2026-11-23): the Library card
// and list built it themselves, while the queue panel and the Up Next card
// kept their skeleton, and Playlists / Categories drew a blank canvas, a
// black JPEG that went into the shared thumbnail cache.
//
// Shown, never stored: a poster the user uploads replaces it.
import { t } from './i18n.js';
import { isAudioPath } from './video-load-check.js';

/**
 * @param {string} name the file's name (its extension is dropped) or a stream's title
 * @param {{ stream?: boolean, compact?: boolean, script?: boolean }} [opts]
 *   stream: a saved stream (labelled as one, title kept whole);
 *   compact: a small thumb (a list row, a queue row): the logo only;
 *   script: a script with no video (the Library's Scripts filter and a
 *   playlist's script entries, 2026-11-26): labelled as one, with a mark.
 * @returns {HTMLDivElement}
 */
export function buildNoVideoTile(name, { stream = false, compact = false, script = false, audio } = {}) {
  // An audio file (2026-11-26): told from the name's extension when the
  // caller does not say, so every view's tile gets it.
  const isAudio = audio ?? (!stream && !script && isAudioPath(String(name || '')));
  const tile = document.createElement('div');
  tile.className = compact ? 'library__thumb-novideo library__thumb-novideo--compact' : 'library__thumb-novideo';
  if (script) tile.classList.add('library__thumb-novideo--script');
  if (isAudio) tile.classList.add('library__thumb-novideo--audio');
  tile.setAttribute('role', 'img');
  const label = script ? t('library.scripts.tileLabel') : stream ? t('library.streams.badge')
    : isAudio ? t('library.audioTile.label') : t('library.noVideoTrack');
  tile.setAttribute('aria-label', label);
  tile.title = label;
  const logo = document.createElement('span');
  logo.className = 'library__thumb-novideo-logo';
  logo.setAttribute('aria-hidden', 'true');
  tile.appendChild(logo);
  const title = document.createElement('span');
  title.className = 'library__thumb-novideo-title';
  title.setAttribute('aria-hidden', 'true');
  title.textContent = stream ? String(name || '') : String(name || '').replace(/\.[^/.]+$/, '');
  tile.appendChild(title);
  if (script || isAudio) {
    const mark = document.createElement('span');
    mark.className = 'library__thumb-novideo-mark';
    mark.textContent = script ? t('library.scripts.mark') : t('library.audioTile.mark');
    tile.appendChild(mark);
  }
  return tile;
}

/**
 * A script played on its own (no video), as a library or playlist entry: its
 * path is the .funscript itself (Dave, 2026-11-26: "lets have one called
 * scripts which is just scripts so somone can still make playlists etc with
 * them"). Code that treats an entry's path as a video file checks this first.
 */
export function isScriptPath(path) {
  return /\.funscript$/i.test(String(path ?? ''));
}

/**
 * A script that no video uses as a library item: what the Scripts filter
 * lists, `getVideoByPath` finds for a playlist and Next steps through. It is
 * NOT a video: `_script` routes every play to the script player.
 * @param {{name?: string, path: string}} entry the scan's unmatchedFunscripts entry
 */
export function scriptItem(entry) {
  const file = fileNameOf(entry?.path);
  return {
    path: entry.path,
    name: String(entry?.name || file).replace(/\.funscript$/i, ''),
    _script: true,
    hasFunscript: true,
    funscriptPath: entry.path,
    // The video that uses it (the Scripts filter's All), or null.
    pairedWith: entry?.pairedWith || null,
  };
}

/** The file name at the end of a path (either separator). */
export function fileNameOf(path) {
  return String(path || '').split(/[\\/]/).pop();
}
