/**
 * The Chromium switches FunSync sets at launch, from the user's settings.
 *
 * Chromium reads these once, before app.whenReady(), and the store is not
 * ready that early, so main.js reads config.json directly and passes the
 * `settings.player` object here. Pure: no Electron, no fs.
 *
 * - Linux, `player.hwVideoDecode` (default on): VA-API hardware decode, or
 *   software decode when it is off (a broken VA-API driver errors instead of
 *   falling back; Galm's NVIDIA/Linux box).
 * - Windows, `player.smoothOverlays` (default OFF, opt-in): turn off DirectComposition.
 *   With it on, a visible <video> under anything that redraws every frame
 *   (the TL timeline, the HM marker, the device simulator, a cursor, any
 *   animation) froze the whole window for ~160 ms about every 10.4 s.
 *   Measured 2026-11-20 on Dave's laptop (Intel UHD 630 + GTX 1070) in a bare
 *   Electron 41 page with only a <video> and a text counter: 2 freezes per
 *   23 s with it, none with `disable-direct-composition` (4 runs), and fewer
 *   dropped video frames (2 vs 6 at 1080p). No JS ran in the frozen frames
 *   (long-animation-frame: renderStart late, no scripts), and the main
 *   process event loop was free. Off means Chromium composites video itself
 *   instead of in a DirectComposition overlay.
 *   BUT the same evening a desktop capture still froze on the same ~10.4 s
 *   rhythm with it off (FunSync's own frames smooth), and a non-Chromium
 *   window froze too: the pause looks system-wide on that laptop (DWM /
 *   driver), and turning DirectComposition off only stops Chromium waiting
 *   for it. So it is opt-in, not a default: no rendering change for anyone
 *   who does not turn it on.
 *
 * @param {string} platform  process.platform
 * @param {object} [player]  config.json's settings.player (may be missing)
 * @returns {Array<[string, string?]>} [switch, value] pairs for app.commandLine.appendSwitch
 */
function gpuSwitches(platform, player) {
  const p = (player && typeof player === 'object') ? player : {};
  if (platform === 'linux') {
    return p.hwVideoDecode === false
      ? [['disable-accelerated-video-decode']]
      : [['enable-features', 'VaapiVideoDecoder,VaapiIgnoreDriverChecks']];
  }
  if (platform === 'win32') {
    return p.smoothOverlays === true ? [['disable-direct-composition']] : [];
  }
  return [];
}

module.exports = { gpuSwitches };
