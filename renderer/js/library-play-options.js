// Play options for the Library's Shuffle All and a category's Play all /
// Shuffle all (zaikechi #381): the same three a playlist carries (Loop,
// "Give every script an equal turn", Prefer unwatched), held once in
// `library.playOptions` because the library and categories have no per-list
// record to put them on. Defaults live in electron/store.js DEFAULTS.
//
// Every caller builds its Play All request from libraryPlayRequest(), so the
// header's Shuffle All, the queue panel's Shuffle (app.js `_shuffleUpcoming`)
// and a category's buttons read the same flags the same way and cannot
// drift. All off, the request reproduces the queues those buttons always
// built (pinned by library-play-options.test.js).

import { isFinished } from './resume-position.js';

export const LIBRARY_PLAY_OPTIONS_KEY = 'library.playOptions';

/** The three flags, each `=== true`, so a missing or partial map is "off". */
export function readLibraryPlayOptions(settings) {
  const raw = settings?.get?.(LIBRARY_PLAY_OPTIONS_KEY);
  const map = (raw && typeof raw === 'object') ? raw : {};
  return {
    loop: map.loop === true,
    balanceByScript: map.balanceByScript === true,
    preferUnwatched: map.preferUnwatched === true,
  };
}

/** True when any option is on (the header button shows it is in use). */
export function anyLibraryPlayOption(settings) {
  const o = readLibraryPlayOptions(settings);
  return o.loop || o.balanceByScript || o.preferUnwatched;
}

/**
 * The options as a Play All request, plus the watched lookup "Prefer
 * unwatched" needs: the same mark the playlists use (a video finished while
 * playing from a playlist, `library.resumePositions`). Read at click time.
 */
export function libraryPlayRequest(settings) {
  return {
    ...readLibraryPlayOptions(settings),
    isWatched: (path) => {
      const map = settings?.get?.('library.resumePositions') || {};
      return isFinished(path ? map[path] : null);
    },
  };
}

/** Write one flag, keeping the other two. Returns the new map. */
export function setLibraryPlayOption(settings, key, on) {
  const next = { ...readLibraryPlayOptions(settings), [key]: !!on };
  settings?.set?.(LIBRARY_PLAY_OPTIONS_KEY, next);
  return next;
}
