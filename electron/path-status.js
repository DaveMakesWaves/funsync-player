'use strict';

// Does a path exist? Three answers, because absence is acted on.
//
// `pathReachable` behind the `file-exists` / `files-exist` IPCs (main.js).
// Lives in its own module so tests can run the REAL check against real
// folders, including a real deny ACL, rather than asserting main.js's source
// text (FT-002, 2026-11-05). Moved out of main.js unchanged apart from the
// FT-002 fix: which errors count as "absent".

const fs = require('fs');

/**
 * Default budget for an existence check, in ms.
 *
 * A DEAD MAPPED NETWORK DRIVE is the case this exists for. Windows keeps the
 * drive letter after a NAS goes offline, so the path looks real and the OS
 * blocks on an SMB round trip that can take seconds. lnlytrckr (EroScripts
 * #251/#255) saw the whole app freeze for ~5s every 20-30s because of it.
 *
 * External drives do NOT hit this: Windows removes the letter entirely, so the
 * check fails immediately.
 */
const EXISTS_TIMEOUT_MS = 800;

/**
 * The only errors that say "this path does not exist": nothing at that name
 * (ENOENT), or a parent that is a file (ENOTDIR). Measured on Windows: a
 * missing drive letter, a missing file and a missing file inside a folder
 * whose listing is DENIED all give ENOENT.
 *
 * Everything else is about REACHING the path, not about whether it is there:
 * EPERM / EACCES (a deny ACL: measured, a file inside a folder denied with
 * `icacls /deny (OI)(CI)(RX)` fails `fs.access` with EPERM while the folder
 * itself passes), EBUSY, EIO, ELOOP, a share that refuses (`UNKNOWN` on
 * Windows for a UNC path to a missing share), and so on. Those are UNKNOWN.
 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** An `fs.access` rejection mapped to the tri-state answer. */
function statusForError(err) {
  return ABSENT_CODES.has(err?.code) ? false : null;
}

/** Permission errors: the path is there but this user may not reach it. */
const DENIED_CODES = new Set(['EPERM', 'EACCES']);

/**
 * WHY an answer is unknown (R4-14), for a caller that words it: 'denied'
 * (EPERM / EACCES), 'timeout' (no answer within the budget), 'error'
 * (anything else: busy, I/O, a share that refuses). null for a known answer.
 */
function whyForError(err) {
  if (ABSENT_CODES.has(err?.code)) return null;
  return DENIED_CODES.has(err?.code) ? 'denied' : 'error';
}

/**
 * One `fs.access` per path at a time (R4-15). The budget below ends the WAIT,
 * not the syscall: on a NAS or dead SMB host an access can hang 30-60 s, each
 * holding one of libuv's 4 threadpool slots, and the 30 s source poll asked
 * again every time, so two or three such roots filled the pool and stalled
 * main's async fs work (read-funscript, thumbnails, cache writes, the scan).
 * A check of a path whose last access has not settled waits on that one
 * instead of starting another; the entry goes when it settles. Keyed by the
 * access function too, so a test seam never shares a real call.
 */
const inFlight = new WeakMap(); // access fn → Map(path → Promise<{ ok: true } | { err }>)

function sharedAccess(filePath, access) {
  let byPath = inFlight.get(access);
  if (!byPath) {
    byPath = new Map();
    inFlight.set(access, byPath);
  }
  const held = byPath.get(filePath);
  if (held) return held;
  // `.then(() => access(...))` so an access that throws synchronously lands
  // in the same mapping as one that rejects.
  const settled = Promise.resolve()
    .then(() => access(filePath))
    .then(() => ({ ok: true }), (err) => ({ err }));
  byPath.set(filePath, settled);
  settled.then(() => {
    if (byPath.get(filePath) === settled) byPath.delete(filePath);
  });
  return settled;
}

/** Tests only: how many accesses are still unsettled for `access`. */
function unsettledCount(access = fs.promises.access) {
  return inFlight.get(access)?.size || 0;
}

/**
 * Async, time-boxed existence check.
 *
 * Two deliberate changes from the old `fs.existsSync`:
 *
 *  1. ASYNC. `existsSync` runs on the main process's JS thread, so a blocking
 *     network stat froze the entire UI, not just the library. `fs.promises`
 *     work happens on libuv's threadpool and leaves the app responsive.
 *
 *  2. TIME-BOXED. We stop WAITING after the budget and report "unknown".
 *     Note this does not cancel the underlying syscall — it cannot be
 *     cancelled — so the threadpool slot stays occupied until the OS gives up.
 *     So a path whose last access has not settled is never accessed again
 *     until it does: the next check waits on the same one (`sharedAccess`,
 *     R4-15), and a hung share holds at most one slot per path whatever the
 *     poll does.
 *
 * @param {string} filePath
 * @param {number} [timeoutMs]
 * @param {{access?: (p: string) => Promise<void>}} [deps] test seam
 * @returns {Promise<boolean|null>} true = present, false = definitely absent
 *   (ENOENT / ENOTDIR only), **null = unknown** (the check timed out, or
 *   failed for any other reason: permission denied, busy, I/O error).
 *
 * The third state is the whole point. This used to return `false` on timeout,
 * so "I could not answer in time" was indistinguishable from "this path does
 * not exist" — and callers act on absence. Measured 2026-08-26: with the app
 * busy (statting 1,532 files and rescanning 880 GB), the probe timed out on
 * every source and the app locked the user's ENTIRE library as unreachable,
 * including a local folder on C: that plainly existed.
 *
 * It ALSO returned `false` for every other error (FT-002, in v0.9.2 too). A
 * script in a folder whose listing is denied fails `fs.access` with EPERM
 * while its folder passes, so `library._safeToPrune` read "file absent,
 * folder answers" as a proven deletion and pruned the association. Paths
 * under a source were covered by the scan's `skippedPaths` (V04); a script
 * OUTSIDE every source was not. A permission error is not evidence of absence.
 *
 * A slow or refused answer is not evidence of absence, and absence is never
 * treated gently by the things downstream of it. Callers that only want a
 * boolean can still collapse null however suits them — but they have to
 * choose, rather than having the choice made for them here.
 */
async function pathReachable(filePath, timeoutMs = EXISTS_TIMEOUT_MS, deps = {}) {
  return (await pathStatusDetail(filePath, timeoutMs, deps)).status;
}

/**
 * `pathReachable` with the reason for an unknown answer (R4-14): `status` is
 * exactly what `pathReachable` answers, and `why` is null for a known answer
 * or 'denied' / 'timeout' / 'error' for `status: null` (see `whyForError`).
 * Lets `files-exist { why: true }` tell a share that is slow from a folder
 * that is locked, so a notice can say which.
 *
 * @returns {Promise<{status: boolean|null, why: null|'denied'|'timeout'|'error'}>}
 */
async function pathStatusDetail(filePath, timeoutMs = EXISTS_TIMEOUT_MS, { access = fs.promises.access } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { status: false, why: null };
  let timer;
  try {
    return await Promise.race([
      sharedAccess(filePath, access).then((r) => (r.ok
        ? { status: true, why: null }
        : { status: statusForError(r.err), why: whyForError(r.err) })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: null, why: 'timeout' }), timeoutMs);
      }),
    ]);
  } catch {
    // Nothing above should throw; if it does, we know nothing.
    return { status: null, why: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  pathReachable, pathStatusDetail, statusForError, whyForError, unsettledCount,
  ABSENT_CODES, DENIED_CODES, EXISTS_TIMEOUT_MS,
};
