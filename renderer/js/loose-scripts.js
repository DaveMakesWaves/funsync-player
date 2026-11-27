// The library's scripts that no video uses (v0.10.1; Library > Filters >
// Scripts since 2026-11-26, the Library menu's "Scripts without a video"
// before; powerkool on EroScripts: "view (in a folder under
// the library section) ... scripts that aren't associated with a video").
//
// The scan already lists the funscripts it paired with no video
// (`unmatchedFunscripts`); this leaves out what still is not a playable script
// on its own: an axis file (".twist.funscript": it belongs to a main script),
// and anything a video uses after all (a hand pairing, a variant, a multi-axis
// slot), since the scan pairs only by name. Pure.

import { parseAxisSuffix } from './multi-axis.js';

/** A path as the library compares paths (case and slashes). */
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * Which video uses each script: its main script, a variant or an axis slot.
 * @returns {Map<string, string>} the script's path (as compared) -> the video's name
 */
export function scriptUsers(videos) {
  const users = new Map();
  const add = (p, v) => { if (p && !users.has(norm(p))) users.set(norm(p), v?.name || ''); };
  for (const v of videos || []) {
    add(v?.funscriptPath, v);
    for (const vr of v?.variants || []) add(vr?.path, v);
    const axes = v?.multiAxis?.axes || v?.multiAxis || null;
    if (axes && typeof axes === 'object') {
      for (const a of Object.values(axes)) add(typeof a === 'string' ? a : a?.path, v);
    }
  }
  return users;
}

/** A script that plays on its own: a .funscript, not an axis file (it belongs to a main script). */
const playable = (s) => !!s?.path && /\.funscript$/i.test(s.path)
  && !parseAxisSuffix(s.name || s.path.split(/[\\/]/).pop());

/**
 * @param {{ name: string, path: string }[]} unmatched the scan's unmatchedFunscripts
 * @param {object[]} videos the library's videos (funscriptPath, variants[].path, multiAxis…)
 * @returns {{ name: string, path: string }[]} in the order given (the scan sorts by name)
 */
export function looseScripts(unmatched, videos) {
  const users = scriptUsers(videos);
  return (unmatched || []).filter((s) => playable(s) && !users.has(norm(s.path)));
}

/**
 * Every script that plays on its own, each with the video that uses it, if
 * any (the Scripts filter's All, Dave 2026-11-26: "all scripts regardless of
 * whether they have an assigned video or not").
 * @param {{ name: string, path: string }[]} all the scan's allFunscripts
 * @returns {{ name: string, path: string, pairedWith: string|null }[]}
 */
export function allScripts(all, videos) {
  const users = scriptUsers(videos);
  return (all || []).filter(playable).map((s) => ({ ...s, pairedWith: users.get(norm(s.path)) || null }));
}
