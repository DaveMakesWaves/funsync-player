// The player's audio tile (S033; Dave, 2026-11-26: "Show the audio tile
// instead"). An audio file played over a plain black screen: the title only
// showed while the controls were up. Now the player shows the library's
// audio tile (the logo, the title, the "Audio" chip) as a card over the
// black. It sits right after the <video> in the page, so the centre play
// button, the controls and every overlay stay above it, and it lets clicks
// through to the player. The main player (and the mini player, the same
// element) and the pop-out player use it.
import { buildNoVideoTile } from './no-video-tile.js';

/**
 * Show the audio tile for `name` in the player's video wrapper, or remove it
 * (`name` null / empty).
 * @param {HTMLElement|null} wrapper the player's #video-wrapper
 * @param {string|null} name the file's name (its extension is dropped)
 * @returns {HTMLElement|null} the tile's host, when shown
 */
export function setPlayerAudioTile(wrapper, name) {
  if (!wrapper || typeof wrapper.querySelector !== 'function') return null;
  let host = wrapper.querySelector(':scope > .player__audio-tile');
  if (!name) {
    host?.remove();
    return null;
  }
  if (!host) {
    host = wrapper.ownerDocument.createElement('div');
    host.className = 'player__audio-tile';
    const video = wrapper.querySelector(':scope > video');
    if (video) video.after(host);
    else wrapper.prepend(host);
  }
  host.replaceChildren(buildNoVideoTile(String(name), { audio: true }));
  return host;
}
