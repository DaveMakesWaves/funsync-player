// The forum's and the file hosts' own pages, opened in app windows (the
// EroScripts login window, the hidden Gofile window), never load video or
// audio, nor the forum's service worker.
//
// Found live on 2026-11-25 (Dave's machine, Electron 41): after the
// EroScripts login page had been open, FunSync's quit ran to its end
// (will-quit, Node's 'exit') and the process then never ended: an invisible
// FunSync that held the single-instance lock (the next launch just exits) and
// port 5123. Bisected in a bare Electron script, no FunSync code and no test
// driver: the login page loads ad VIDEOS (ads.cdn.ayvasoftware.io,
// media.synsual.me, resource type "media"); with them refused the process
// ends at once (example.com: 8 s; the login page: hung until killed at 30 s
// and 40 s; media refused: ends). Blocking Cloudflare or the service worker
// alone did not help. Logging in, and reading a Gofile page, need neither.
//
// One onBeforeRequest per session (Electron keeps one listener per event), so
// this is THE listener for these sessions.

/** Should this request be refused in a page window? */
function refusePageRequest(details) {
  if (!details) return false;
  if (details.resourceType === 'media') return true;
  // Discourse's service worker: starts with the page and outlives the window
  // (Electron 41 cannot stop one).
  return /^https?:\/\/[^/]*eroscripts\.com\/service-worker/i.test(String(details.url || ''));
}

/** Refuse media (and the forum's service worker) in `ses`. */
function blockPageMedia(ses) {
  if (!ses?.webRequest?.onBeforeRequest) return false;
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: refusePageRequest(details) });
  });
  return true;
}

module.exports = { blockPageMedia, refusePageRequest };
