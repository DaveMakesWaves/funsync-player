"""HLS (.m3u8) manifest rewriting for the remote-video proxy.

When we proxy an HLS stream, hls.js fetches the manifest from US, then fetches
each segment / sub-playlist from whatever URLs the manifest lists. Those
upstream URLs are signed + header-locked (Referer/Cookie/UA), so they must come
back through our proxy too. This rewrites every URI in an .m3u8 to point at the
proxy:

  - sub-playlists (.m3u8)  ->  {base}/{token}/manifest?u=<abs>   (rewritten again)
  - everything else        ->  {base}/{token}/seg?u=<abs>        (raw bytes)
    (media segments, EXT-X-KEY keys, EXT-X-MAP init maps, audio renditions)

Each URI is resolved to absolute against the manifest's own URL first, so
relative playlists work. Pure + side-effect-free so it unit-tests without a
network. See SCOPE-remote-video-url.md §6.
"""

import re
from urllib.parse import urljoin, quote

# Matches URI="..." inside tag lines (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, ...).
_ATTR_URI_RE = re.compile(r'URI="([^"]*)"')


def _proxy_for(abs_url: str, token: str, base_path: str) -> str:
    # A sub-playlist (audio/variant) goes back through the rewriting endpoint;
    # anything else is streamed as raw bytes. Detect on the path, ignoring the
    # signed query string.
    path_only = abs_url.split("?", 1)[0]
    kind = "manifest" if path_only.lower().endswith(".m3u8") else "seg"
    return f"{base_path}/{token}/{kind}?u={quote(abs_url, safe='')}"


def rewrite_manifest(text: str, manifest_url: str, token: str,
                     base_path: str = "/api/media/remote") -> str:
    """Rewrite all URIs in an m3u8 manifest to proxy URLs.

    Args:
        text: raw manifest body.
        manifest_url: the absolute URL the manifest was fetched from (for
            resolving relative URIs).
        token: the per-resolve token identifying the stored upstream headers.
        base_path: proxy route prefix.
    """
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith("#"):
            # Rewrite any URI="..." attribute inside the tag.
            def _repl(m):
                ref = m.group(1)
                if not ref:
                    return m.group(0)
                abs_u = urljoin(manifest_url, ref)
                return f'URI="{_proxy_for(abs_u, token, base_path)}"'
            out.append(_ATTR_URI_RE.sub(_repl, line))
        else:
            # A bare URI line — a media segment or a variant sub-playlist.
            abs_u = urljoin(manifest_url, s)
            out.append(_proxy_for(abs_u, token, base_path))
    return "\n".join(out)
