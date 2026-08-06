// Thumbnail <img> for an EroScripts search result.
//
// Extracted so the standalone panel and the Associate-modal search share
// one implementation. The ordering here is load-bearing and was a live bug
// (2026-08-05): the `error` listener MUST be attached before `src` is
// assigned, because a synchronous failure — a CSP block, a cached 404 —
// fires before a listener added afterwards exists, leaving Chromium's
// broken-image glyph on screen permanently.

/**
 * @param {object} opts
 * @param {string|null} opts.thumbnail preferred image
 * @param {string|null} opts.avatar poster's avatar, used when the
 *   thumbnail is absent or fails to load
 * @param {string} [opts.className]
 * @returns {HTMLImageElement}
 */
export function createResultThumb({ thumbnail, avatar, className = '' }) {
  const img = document.createElement('img');
  if (className) img.className = className;
  // Decorative: the result's title sits right beside it.
  img.alt = '';

  let triedAvatar = false;
  img.addEventListener('error', () => {
    // A dead thumbnail shouldn't mean a blank row — fall back to the
    // poster's avatar, and only hide when that fails too.
    if (!triedAvatar && avatar && img.src !== avatar) {
      triedAvatar = true;
      img.src = avatar;
      return;
    }
    img.style.display = 'none';
  });

  // Test the INPUT, not `img.src`. Assigning '' makes the reflected `src`
  // resolve to the document URL, so `!img.src` is never true — the original
  // panel code had this check and it never once fired. In a browser the
  // element then tries to load the page as an image and only hides once
  // that request fails, which is a wasted request and a visible flash.
  const initial = thumbnail || avatar || '';
  if (!initial) {
    img.style.display = 'none';
    return img;
  }

  img.src = initial;
  return img;
}
