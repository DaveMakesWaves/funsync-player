// Stash scene markers as seek-bar chapters (Stash S1, Round 2 stage 2d,
// 2026-11-18; notes/features/DESIGN-stash-s1.md (j) row 1, in S1 by Dave's
// answer 3).
//
// stashMarkersForVideo(data, path, {size, enabled}) -> the playing video's
// markers as the seek bar draws them (progress-bar.js setStashMarkers):
// `[{startMs, endMs|null, title}]`, sorted by start. They come from the scene
// the video is LINKED to, read through stash-tags.js stashVideoView, so they
// follow exactly the rules the dialog and the tags follow:
// - Stash on (`enabled === true`), else none;
// - a link whose data counts (state `ok` or `gone`, and the trust check: a
//   file whose scanned size differs from the link's fingerprint shows none of
//   the old file's Stash data);
// - the scene of the link's own server: a Stash scene id is unique only per
//   server, so main's projection keeps Stash's raw id only for its own
//   server's records and gives any other server's `<id>@<server-key>`, with
//   every reference rewritten alike (stage s1-2a-main). `scenes[sceneId]` is
//   therefore always the linked server's scene, never another server's
//   scene with the same number.
// A marker's title is Stash's title, else its main tag's name, else empty
// (the label then says only that it is a Stash marker).
//
// Pure: no DOM, no IPC, nothing written, no module state.

import { stashVideoView } from './stash-tags.js';

const EMPTY = Object.freeze([]);

/** Two Stash addresses name the same server (no trailing slash, any case). */
function sameServer(a, b) {
  const canon = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return canon(a) === canon(b);
}

/**
 * @param {object} data stash-store.js stashData()
 * @param {string} path the playing video's path
 * @param {{size?: number, enabled?: boolean}} [options] `size` the scanned size
 * @returns {ReadonlyArray<{startMs: number, endMs: number|null, title: string}>}
 */
export function stashMarkersForVideo(data, path, { size, enabled } = {}) {
  if (enabled !== true || typeof path !== 'string' || !path) return EMPTY;
  const view = stashVideoView(data, path, { size, enabled });
  if (!view || !view.link || view.hidden || !view.scene) return EMPTY;
  if (view.link.state !== 'ok' && view.link.state !== 'gone') return EMPTY;
  // Every view filters by the linked server (Dave's answers after Round 1,
  // item 3): a stored scene that names another server than the link's is
  // not this link's scene, whatever its id (the opaque ids make that
  // impossible in main's data; this keeps it so for any other data).
  const raw = Object.prototype.hasOwnProperty.call(data?.scenes || {}, view.link.sceneId)
    ? data.scenes[view.link.sceneId] : null;
  const sceneServer = typeof raw?.server === 'string' && raw.server ? raw.server : null;
  if (sceneServer && view.link.server && !sameServer(sceneServer, view.link.server)) return EMPTY;
  const out = [];
  for (const m of view.scene.markers || []) {
    const seconds = Number(m?.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const end = m.endSeconds == null ? null : Number(m.endSeconds);
    out.push(Object.freeze({
      startMs: Math.round(seconds * 1000),
      endMs: Number.isFinite(end) && end > seconds ? Math.round(end * 1000) : null,
      title: m.title || m.tag || '',
    }));
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return Object.freeze(out);
}

/**
 * The starts of every chapter the seek bar shows, for the player's previous
 * / next chapter keys (`,` `.`): the script's chapters and Stash's markers
 * together, sorted, one entry per start.
 *
 * @param {Array<{startMs: number}>} chapters the script's (funscript-engine getChapters)
 * @param {Array<{startMs: number}>} stashMarkers stashMarkersForVideo's
 * @returns {Array<{startMs: number}>}
 */
export function chapterStarts(chapters, stashMarkers) {
  const seen = new Set();
  const out = [];
  for (const list of [chapters, stashMarkers]) {
    for (const c of Array.isArray(list) ? list : []) {
      const ms = Number(c?.startMs);
      if (!Number.isFinite(ms) || ms < 0 || seen.has(ms)) continue;
      seen.add(ms);
      out.push({ startMs: ms });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
