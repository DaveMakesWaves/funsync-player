// The file types FunSync lists as media: ONE list for the main process (the
// library scan, Open File, a folder's videos, Delete video files).
// renderer/js/drag-drop.js keeps its twin (media-extensions.test.js checks
// they match: change one, change both).
//
// Older formats (Dave, 2026-11-26: "if they can be converted then we should
// show them"): the player opens some of them as they are, others after a
// remux (H.264 in .ts / .flv / .mpg), and the rest through Convert to play
// (WMV / VC-1, MPEG-1/2, Theora, DivX...). Before, they never reached the
// library at all.
'use strict';

const fs = require('fs');

const VIDEO_EXTS = Object.freeze([
  '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov',
  '.wmv', '.asf', '.mpg', '.mpeg', '.vob', '.ts', '.m2ts', '.mts',
  '.flv', '.f4v', '.3gp', '.3g2', '.ogv', '.divx',
]);
const AUDIO_EXTS = Object.freeze(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);
const MEDIA_EXTS = Object.freeze([...VIDEO_EXTS, ...AUDIO_EXTS]);

/**
 * Is this `.ts` file an MPEG transport stream (a video) rather than a
 * TypeScript source? A library folder (Downloads, say) can hold code. A
 * transport stream starts every 188-byte packet with the sync byte 0x47, so
 * the first two packets are checked. Unreadable or shorter than two
 * packets: not a video.
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function isTransportStream(file, { open = fs.promises.open } = {}) {
  let handle = null;
  try {
    handle = await open(file, 'r');
    const buf = Buffer.alloc(189);
    const { bytesRead } = await handle.read(buf, 0, 189, 0);
    return bytesRead === 189 && buf[0] === 0x47 && buf[188] === 0x47;
  } catch {
    return false;
  } finally {
    try { await handle?.close(); } catch { /* closed */ }
  }
}

module.exports = { VIDEO_EXTS, AUDIO_EXTS, MEDIA_EXTS, isTransportStream };
