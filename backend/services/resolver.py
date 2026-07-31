"""Remote-video resolver — turn a web *page* URL into a directly-playable
stream URL (+ the HTTP headers it needs), the way yt-downloader sites do.

Uses yt-dlp's Python API (NOT a subprocess) so it works the same in the dev
venv and in the PyInstaller-frozen backend, and so we get the structured info
dict (formats, per-format http_headers, title, duration, thumbnail) directly.

This module only RESOLVES. The actual byte-streaming is done by the proxy in
routes/media.py, because the extracted URL is usually signed + header-locked
(Referer / Cookie / User-Agent) and those are browser "forbidden headers" the
renderer can't set — so the backend has to fetch on its behalf. See
SCOPE-remote-video-url.md §6.

Errors are categorised into a small set of `kind`s so the UI can show a
precise, plain-language message (Nielsen #9) instead of a raw yt-dlp dump.
"""

from __future__ import annotations

from typing import Any, Optional


class ResolveError(Exception):
    """A resolve failure with a UI-facing category.

    kind ∈ {unsupported, login, drm, geo, live, unavailable, error}
    """

    def __init__(self, kind: str, message: str = ""):
        super().__init__(message or kind)
        self.kind = kind


# yt-dlp options: quiet, no playlist expansion, metadata-only (no download).
_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    # Don't let yt-dlp print to stderr / call os.exit on errors.
    "ignoreerrors": False,
    "extract_flat": False,
}


def _extract_info(page_url: str) -> dict:
    """Run yt-dlp metadata extraction. Isolated for test monkeypatching so the
    test-suite never hits the network. Raises the raw yt_dlp DownloadError."""
    import yt_dlp  # imported lazily so the backend boots even if yt-dlp is absent

    with yt_dlp.YoutubeDL(_YDL_OPTS) as ydl:
        return ydl.extract_info(page_url, download=False)


def _categorise(message: str) -> str:
    """Map a yt-dlp error message to a UI category."""
    m = (message or "").lower()
    if "drm" in m or "widevine" in m or "fairplay" in m or "playready" in m:
        return "drm"
    if any(s in m for s in ("login", "log in", "sign in", "account", "private", "members-only", "premium", "subscribe")):
        return "login"
    if any(s in m for s in ("not available in your country", "geo", "region", "blocked in your")):
        return "geo"
    if "unsupported url" in m or "no video" in m or "unable to extract" in m or "no media found" in m:
        return "unsupported"
    if "is live" in m or "livestream" in m or "live event" in m:
        return "live"
    if "unavailable" in m or "removed" in m or "deleted" in m or "404" in m:
        return "unavailable"
    return "error"


def _is_http(proto: Optional[str]) -> bool:
    return bool(proto) and proto.startswith("http") and "m3u8" not in proto and "dash" not in proto


def _pick_format(info: dict) -> Optional[dict]:
    """Choose the best directly-playable format.

    Priority:
      1. Progressive MP4 (single file, both audio+video) over plain HTTP — plays
         in a bare <video> with NO hls.js. Best UX when available.
      2. HLS (m3u8) — needs hls.js in the renderer. We return the *master*
         manifest (`manifest_url`) when present so hls.js can do its own ABR;
         falling back to the variant `url`.
      3. Top-level `url` fallback.

    Returns {url, isHls, headers, height, ext} or None.
    """
    formats = info.get("formats") or []

    def both_av(f: dict) -> bool:
        return f.get("vcodec") not in (None, "none") and f.get("acodec") not in (None, "none")

    progressive = [
        f for f in formats
        if f.get("url") and both_av(f) and _is_http(f.get("protocol")) and f.get("ext") == "mp4"
    ]
    if progressive:
        best = max(progressive, key=lambda f: f.get("height") or 0)
        return {
            "url": best["url"],
            "isHls": False,
            "headers": best.get("http_headers") or info.get("http_headers") or {},
            "height": best.get("height"),
            "ext": "mp4",
        }

    hls = [f for f in formats if "m3u8" in (f.get("protocol") or "")]
    if hls:
        best = max(hls, key=lambda f: f.get("height") or 0)
        return {
            "url": best.get("manifest_url") or best.get("url"),
            "isHls": True,
            "headers": best.get("http_headers") or info.get("http_headers") or {},
            "height": best.get("height"),
            "ext": "m3u8",
        }

    url = info.get("url")
    if url:
        proto = info.get("protocol") or ""
        is_hls = ".m3u8" in url or "m3u8" in proto
        return {
            "url": url,
            "isHls": is_hls,
            "headers": info.get("http_headers") or {},
            "height": info.get("height"),
            "ext": info.get("ext"),
        }
    return None


def resolve(page_url: str) -> dict[str, Any]:
    """Resolve a page URL to a playable stream.

    Returns a dict:
        title, duration (sec|None), thumbnail (url|None), site (extractor),
        webpageUrl, isLive, streamUrl, isHls, headers (dict), height
    Raises ResolveError(kind, message) on any failure.
    """
    if not page_url or not page_url.strip():
        raise ResolveError("error", "Empty URL")

    try:
        info = _extract_info(page_url.strip())
    except ResolveError:
        raise
    except Exception as e:  # yt_dlp.utils.DownloadError + anything unexpected
        raise ResolveError(_categorise(str(e)), str(e))

    if not info:
        raise ResolveError("unsupported", "No video found on that page")

    # Some extractors return a playlist-ish dict with 'entries' despite noplaylist.
    if info.get("_type") == "playlist" and info.get("entries"):
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise ResolveError("unsupported", "No playable entry found")
        info = entries[0]

    if info.get("is_live"):
        raise ResolveError("live", "Live streams can't be synced")

    chosen = _pick_format(info)
    if not chosen or not chosen.get("url"):
        raise ResolveError("unsupported", "Couldn't find a playable stream")

    return {
        "title": info.get("title") or "Untitled",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "site": info.get("extractor_key") or info.get("extractor"),
        "webpageUrl": info.get("webpage_url") or page_url,
        "isLive": bool(info.get("is_live")),
        "streamUrl": chosen["url"],
        "isHls": chosen["isHls"],
        "headers": chosen["headers"] or {},
        "height": chosen.get("height"),
    }
