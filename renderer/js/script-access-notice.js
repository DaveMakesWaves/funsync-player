// A script the open expected and could not read, because it cannot be
// REACHED rather than because it is gone (R3-18, also in v0.9.2).
//
// Found while checking FT-002: with the script's folder locked (a deny ACL),
// opening the video played it with no script and no word about it, and the
// variant button still named the locked script. `read-funscript` answers
// null for every failure, so the open could not tell "no file" from "no
// access". The existence probe can: `fs.access` on a file inside a denied
// folder fails EPERM, which `files-exist` reports as `null` (unknown, FT-002)
// while the folder itself answers `true`. A missing file is `false` instead,
// and a share that does not answer leaves the folder unanswered too: neither
// of those is "access denied", and neither gets this notice.
//
// One toast per script per session. Nothing is pruned or changed: this only
// says why the video plays without sync (absence is never destructive, and
// an unreadable file is not even absent).
//
// `null` is also the answer for a check that ran out of time, and on a slow
// share the folder can answer in time while the script does not: that is not
// "access denied" (R4-14). `files-exist { why: true }` says which; only a
// permission error is worded as one, anything else (no answer in time, a
// busy file, an I/O error) "can't be read right now".

import { t } from './i18n.js';

const told = new Set();

/** The folder that holds `filePath` (either separator), or '' for a bare name. */
function folderOf(filePath) {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut > 0 ? filePath.slice(0, cut) : '';
}

/** A `files-exist` entry, plain (`true` / `false` / `null`) or `{ status, why }`. */
function statusOf(entry) {
  return entry && typeof entry === 'object' ? entry.status : entry;
}

/**
 * After an open's read of `scriptPath` came back empty: when the file is
 * there but cannot be reached (it answers `null` while its folder answers
 * `true`), say so once: "Can't read <name>: access denied. Playing without
 * sync." for a permission error, "Can't read <name> right now. Playing
 * without sync." for anything else (R4-14). Fire and forget; never throws.
 *
 * @param {string} scriptPath
 * @param {{ filesExist?: Function, toast?: Function }} [deps] test seams
 * @returns {Promise<boolean>} whether the notice was shown
 */
export async function noticeUnreadableScript(scriptPath, deps = {}) {
  try {
    if (typeof scriptPath !== 'string' || !scriptPath || told.has(scriptPath)) return false;
    const dir = folderOf(scriptPath);
    const filesExist = deps.filesExist || window.funsync?.filesExist;
    if (!dir || typeof filesExist !== 'function') return false;
    const answer = await filesExist([scriptPath, dir], undefined, { why: true });
    if (!Array.isArray(answer) || statusOf(answer[0]) !== null || statusOf(answer[1]) !== true) return false;
    if (told.has(scriptPath)) return false; // two opens raced to here
    told.add(scriptPath);
    const name = scriptPath.split(/[\\/]/).pop();
    // A plain `null` (no reason given) is worded as before.
    const why = answer[0] && typeof answer[0] === 'object' ? answer[0].why : 'denied';
    const toast = deps.toast || (await import('./toast.js')).showToast;
    toast(t(why === 'denied' ? 'toast.scriptAccessDenied' : 'toast.scriptUnreadableNow', { name }), 'warn', 6000);
    return true;
  } catch {
    return false;
  }
}

/** Tests only: forget which scripts were reported this session. */
export function _resetUnreadableScriptNotices() {
  told.clear();
}
