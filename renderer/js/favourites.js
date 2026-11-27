// Favourites (zaikechi #381, 2026-11-23: "mark a video as a favorite, both in
// lib, but also during playback ... auto manage a 'Favorites' playlist").
//
// The Favourites playlist IS the favourites: a video is a favourite while it
// is in the playlist with the fixed id 'favourites' (electron/store.js
// ensureFavouritesPlaylist). So there is one truth, no map to keep in step:
// the heart on a card, the heart in the player, Video options ▸ Organise and
// the playlist itself all read and write the same list, and everything a
// playlist already has (play options, cover, the phone, backups, a moved
// video's re-home, a deleted video's clean-up) works for favourites too. An
// older build sees an ordinary playlist. It is never deleted (store.js); it
// can be renamed and reordered like any other.
//
// Pure helpers over the DataService-shaped `settings` (getPlaylist,
// ensureFavouritesPlaylist, addVideoToPlaylist, removeVideoFromPlaylist).

export const FAVOURITES_PLAYLIST_ID = 'favourites';

/** Is this the Favourites playlist? */
export function isFavouritesPlaylist(playlist) {
  return !!playlist && playlist.id === FAVOURITES_PLAYLIST_ID;
}

/** The favourite paths, as a Set (one read per render, not one per card). */
export function favouritePaths(settings) {
  const pl = settings?.getPlaylist?.(FAVOURITES_PLAYLIST_ID);
  return new Set(Array.isArray(pl?.videoPaths) ? pl.videoPaths : []);
}

/** Is this video a favourite? */
export function isFavourite(settings, videoPath) {
  if (typeof videoPath !== 'string' || !videoPath) return false;
  const pl = settings?.getPlaylist?.(FAVOURITES_PLAYLIST_ID);
  return Array.isArray(pl?.videoPaths) && pl.videoPaths.includes(videoPath);
}

/**
 * Make a video a favourite (it goes on the end of the playlist) or not.
 * Makes the playlist first if it does not exist yet. Returns the new state.
 * @param {object} settings DataService
 * @param {string} videoPath
 * @param {boolean} on
 * @param {string} [name] the name a NEW playlist gets (the user's language)
 */
export async function setFavourite(settings, videoPath, on, name) {
  if (typeof videoPath !== 'string' || !videoPath) return false;
  if (on) {
    const pl = await settings?.ensureFavouritesPlaylist?.(name);
    if (!pl) return false;
    if (!isFavourite(settings, videoPath)) settings.addVideoToPlaylist(FAVOURITES_PLAYLIST_ID, videoPath);
    return true;
  }
  if (isFavourite(settings, videoPath)) settings.removeVideoFromPlaylist(FAVOURITES_PLAYLIST_ID, videoPath);
  return false;
}

/** Flip a video's favourite state; returns the new state. */
export async function toggleFavourite(settings, videoPath, name) {
  return setFavourite(settings, videoPath, !isFavourite(settings, videoPath), name);
}
