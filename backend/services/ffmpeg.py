"""FFmpeg/FFprobe services — metadata extraction and thumbnail generation."""

import subprocess
import json
import os
import hashlib
import sys
import tempfile
import threading
import time
import atexit
import itertools
import re
from typing import Any


def _find_binary(name: str) -> str:
    """Find ffmpeg/ffprobe binary — bundled with the packaged app, or on PATH.

    The packaged branch used to look for `<exe dir>/<name>` and nothing else,
    which was wrong twice over, and the app never said so:

      1. Nothing puts ffmpeg next to the backend exe. electron-builder ships
         the backend to `resources/backend/` via `extraResources`, and ffmpeg
         to `<install root>/ffmpeg/` via `extraFiles` — two different trees.
      2. It omitted the `.exe` suffix, so on Windows the probe could not have
         matched even if the file had been there.

    So every packaged install fell through to a bare `ffmpeg` on PATH, and
    worked only for users who happen to have ffmpeg installed system-wide.
    Sylvain-Et-Un does not: 104 videos, 103 thumbnail requests, 103 backend
    500s, zero successes (log, 2026-08-24). It looked like a portable-mode
    bug and is not — portable and NSIS share the layout. It survived because
    the developer machine has ffmpeg on PATH via WinGet, so the fallback
    quietly did the right thing there, and because the only tests over this
    function exercised the DEV branch.

    `<exe dir>/../../ffmpeg/` is the shipped layout on both Windows targets
    and the Linux AppImage, so one rule covers all three without a packaging
    change. The suffix-less and same-dir probes are kept so a future build
    that DOES place the binaries beside the exe still resolves.
    """
    exe_suffix = ".exe" if os.name == "nt" else ""
    filename = name + exe_suffix

    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        for candidate in (
            os.path.join(exe_dir, filename),
            os.path.join(exe_dir, name),                              # legacy, suffix-less
            os.path.join(exe_dir, "ffmpeg", filename),
            os.path.join(exe_dir, "..", "..", "ffmpeg", filename),    # <root>/ffmpeg — SHIPPED
            os.path.join(exe_dir, "..", "..", filename),
        ):
            if os.path.exists(candidate):
                return os.path.abspath(candidate)

    # Check sibling dev directories. Windows keeps ffmpeg in `ffmpeg/`;
    # Linux keeps it in `ffmpeg-linux/` (the CI build downloads platform-
    # specific static binaries into each). Probe both so dev runs work on
    # either OS without a reshuffle.
    project_root = os.path.join(os.path.dirname(__file__), "..", "..")
    dev_dirs = ("ffmpeg-linux", "ffmpeg") if os.name != "nt" else ("ffmpeg",)
    for d in dev_dirs:
        dev_path = os.path.join(project_root, d, filename)
        if os.path.exists(dev_path):
            return os.path.abspath(dev_path)

    # Fall back to PATH. This is a real fallback, not a resting state — see
    # the startup log below, which says so out loud.
    return name


FFPROBE = _find_binary("ffprobe")
FFMPEG = _find_binary("ffmpeg")


def describe_binaries() -> dict:
    """Where ffmpeg/ffprobe were resolved, and whether that was a real find.

    Logged once at startup. The whole reason this bug cost a user their entire
    thumbnail library in silence is that nothing anywhere recorded which
    binary was going to be used, so a total outage and a working install
    produced identical logs.
    """
    return {
        "ffmpeg": FFMPEG,
        "ffprobe": FFPROBE,
        # `bundled` means we found a file on disk; otherwise we are trusting
        # PATH and will only find out when the first thumbnail fails.
        "ffmpeg_bundled": os.path.isabs(FFMPEG) and os.path.exists(FFMPEG),
        "ffprobe_bundled": os.path.isabs(FFPROBE) and os.path.exists(FFPROBE),
        "frozen": bool(getattr(sys, "frozen", False)),
    }


# Suppress the cmd.exe window that Windows creates for every ffmpeg /
# ffprobe subprocess when the parent is a GUI app. The PyInstaller spec
# ships the backend as `console=False` (windowed exe), and under those
# conditions Windows spawns a fresh console per child. Without this flag
# the user sees hundreds of console windows flashing during library scan
# (one per thumbnail / metadata probe / VR info probe). On non-Windows
# platforms the flag evaluates to 0 and is a no-op.
NO_WINDOW_CREATIONFLAGS = 0x08000000 if sys.platform == "win32" else 0


def run_silent(*args, **kwargs):
    """`subprocess.run` wrapper that hides the Windows console popup for
    GUI-parent subprocess calls. Use for every ffmpeg / ffprobe call
    anywhere in the backend — the default `subprocess.run` flashes a
    console per call in packaged Windows builds."""
    if sys.platform == "win32":
        kwargs.setdefault("creationflags", NO_WINDOW_CREATIONFLAGS)
    return subprocess.run(*args, **kwargs)


# Metadata cache. Keyed by (path, size, mtime) so file edits invalidate
# naturally. The thumbnail-single endpoint calls get_metadata for EVERY
# thumbnail to know the duration; without caching, that doubles the
# per-thumbnail cost (ffprobe + ffmpeg).
#
# PERSISTED TO DISK (2026-08-03): the cache used to be in-memory only, so
# it died with the backend process — i.e. on EVERY app launch. Startup
# profiling on a 420-video library showed each visible card paying a fresh
# ~700ms ffprobe for a video probed dozens of times before (~7s of the
# ~13s startup; the thumbnail JPEGs themselves were disk-cached and
# near-free). The cache now loads lazily from a JSON file in the same
# temp directory as the thumbnail cache (if the OS cleans temp, both die
# together and both rebuild) and is written back with a throttle.
#
# Concurrency: FastAPI runs sync route handlers in a threadpool, so
# get_metadata races with itself — all cache state is guarded by
# _metadata_cache_lock. The disk write is atomic (tmp file + os.replace,
# which is atomic on both Windows and POSIX) so a concurrent second
# backend instance can't observe a torn file.
#
# Loss window: the write-behind throttle means a hard kill (Windows
# taskkill /F skips atexit) can lose the last few seconds of NEW probes.
# Cost: those videos re-probe once next launch. Graceful exits (Linux
# SIGTERM, dev Ctrl-C) flush via atexit.
_metadata_cache: dict[str, dict[str, Any]] = {}
_metadata_cache_lock = threading.Lock()
# Saves run one at a time and each writes a temp file of its own (R3R-5's
# fix in script_meta.py, applied here 2026-11-22): one `.tmp-<pid>` name for
# every thread, written outside any lock, let two saves at once leave a file
# that was not JSON. Lock order: _metadata_cache_save_lock, then
# _metadata_cache_lock; nothing takes them the other way round.
_metadata_cache_save_lock = threading.Lock()
_metadata_cache_tmp_names = itertools.count(1)
_metadata_cache_loaded = False
_metadata_cache_dirty = 0          # new entries since last successful save
_metadata_cache_last_save = 0.0    # time.monotonic() of last save attempt

METADATA_CACHE_VERSION = 1
# ~200 bytes/entry → 5000 entries ≈ 1MB ceiling. Oldest-inserted pruned
# first on save; stale keys (moved/renamed/deleted files) age out this way.
METADATA_CACHE_MAX_ENTRIES = 5000
METADATA_CACHE_SAVE_INTERVAL_SEC = 2.0
METADATA_CACHE_SAVE_BATCH = 16     # force a save every N new entries


def _metadata_cache_path() -> str:
    # Resolved at call time (not import) so tests that monkeypatch
    # `tempfile` on this module isolate the file, mirroring the
    # thumbnail-cache tests.
    return os.path.join(tempfile.gettempdir(), "funsync_thumbs", "metadata-cache-v1.json")


def _load_metadata_cache_locked() -> None:
    """Populate _metadata_cache from disk, once. Caller holds the lock.
    Missing/corrupt/wrong-version files are silently discarded — the cache
    is a pure accelerator and must never block a probe."""
    global _metadata_cache_loaded
    if _metadata_cache_loaded:
        return
    _metadata_cache_loaded = True
    try:
        with open(_metadata_cache_path(), encoding="utf-8") as f:
            payload = json.load(f)
        if (isinstance(payload, dict)
                and payload.get("version") == METADATA_CACHE_VERSION
                and isinstance(payload.get("entries"), dict)):
            for key, value in payload["entries"].items():
                if isinstance(key, str) and isinstance(value, dict):
                    _metadata_cache[key] = value
    except (OSError, ValueError):
        pass  # no cache yet / unreadable / corrupt JSON → start empty


def _save_metadata_cache(force: bool = False) -> None:
    """Write-behind persistence. Throttled so a cold library scan doesn't
    rewrite the file hundreds of times; `force` (atexit) flushes whatever
    is pending. Failures are swallowed — worst case is re-probing later."""
    global _metadata_cache_dirty, _metadata_cache_last_save
    with _metadata_cache_save_lock:
        with _metadata_cache_lock:
            if _metadata_cache_dirty == 0:
                return
            now = time.monotonic()
            if (not force
                    and _metadata_cache_dirty < METADATA_CACHE_SAVE_BATCH
                    and (now - _metadata_cache_last_save) < METADATA_CACHE_SAVE_INTERVAL_SEC):
                return
            # Prune oldest-inserted entries beyond the cap (dict preserves
            # insertion order; disk-loaded entries were inserted first).
            excess = len(_metadata_cache) - METADATA_CACHE_MAX_ENTRIES
            if excess > 0:
                for key in list(_metadata_cache)[:excess]:
                    del _metadata_cache[key]
            snapshot = {"version": METADATA_CACHE_VERSION, "entries": dict(_metadata_cache)}
            dirty_was = _metadata_cache_dirty
            _metadata_cache_dirty = 0
            _metadata_cache_last_save = now
            path = _metadata_cache_path()
            tmp_path = f"{path}.tmp-{os.getpid()}-{next(_metadata_cache_tmp_names)}"
        # Serialize + write outside the cache lock: probes don't wait on disk
        # (only another save waits, on _metadata_cache_save_lock).
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, ensure_ascii=False)
            os.replace(tmp_path, path)  # atomic on Windows AND POSIX
        except (OSError, ValueError):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            with _metadata_cache_lock:
                _metadata_cache_dirty = max(_metadata_cache_dirty, dirty_was)  # the next save tries again


atexit.register(lambda: _save_metadata_cache(force=True))


def _reset_metadata_cache_for_tests() -> None:
    """Test hook: drop all in-memory cache state so a test can simulate a
    backend restart (the disk file is untouched — point the module's
    `tempfile` at a tmp_path to isolate that too)."""
    global _metadata_cache_loaded, _metadata_cache_dirty, _metadata_cache_last_save
    with _metadata_cache_lock:
        _metadata_cache.clear()
        _metadata_cache_loaded = False
        _metadata_cache_dirty = 0
        _metadata_cache_last_save = 0.0

# Per-thumbnail ffmpeg decode budget. With the `-skip_frame nokey` strategy a
# single frame decodes in ~1s (5.7s max in the 8K-HEVC benchmark), stretching
# to ~15-20s only under heavy sibling contention. 25s clears that legitimate
# worst case with headroom, but is 2.4× faster than the old 60s at giving up
# on a slow/disconnected/hung drive (NAS dropout, spun-down HDD) — the report
# was a large multi-drive library freezing, where doomed reads held all four
# worker slots for a full minute each. Tune here if VR/8K thumbnails on very
# slow storage start timing out.
THUMBNAIL_TIMEOUT_SEC = 25


def get_metadata(video_path: str) -> dict[str, Any]:
    """Extract video metadata using ffprobe.

    Args:
        video_path: Absolute path to the video file.

    Returns:
        Dict with keys: duration, width, height, codec, profile, pixFmt,
        format, bitrate, fps.

    Raises:
        FileNotFoundError: If video file doesn't exist.
        RuntimeError: If ffprobe fails.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    # Cache lookup — most callers will hit this for the same files
    # repeatedly during a session (each thumbnail call previously
    # re-ran ffprobe wastefully). First call lazily loads the persisted
    # cache from disk so probes survive backend restarts (app launches).
    stat = os.stat(video_path)
    cache_key = f"{video_path}:{stat.st_size}:{stat.st_mtime}"
    with _metadata_cache_lock:
        _load_metadata_cache_locked()
        cached = _metadata_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        result = run_silent(
            [
                FFPROBE,
                # "error", not "quiet": stdout is the same JSON either way, and
                # a failed probe now says WHY. With "quiet" stderr was empty,
                # so the thumbnail warning read "ffprobe failed:" and nothing
                # after it (verify-2, 2026-11-07; also in v0.9.2).
                "-v", "error",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                video_path,
            ],
            capture_output=True,
            text=True,
            # ffmpeg/ffprobe write UTF-8 to stdout/stderr (file paths, codec
            # messages). Without an explicit encoding here Python's reader
            # thread defaults to the OS locale — cp1252 on Windows — and any
            # byte that doesn't map (smart quotes, accented chars, raw codec
            # output) crashes the reader thread with UnicodeDecodeError.
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except FileNotFoundError:
        raise RuntimeError("ffprobe not found. Install ffmpeg to use metadata features.")

    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {_one_line(result.stderr)}")

    data = json.loads(result.stdout)

    # Find video stream
    video_stream = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    fmt = data.get("format", {})

    metadata = {
        "duration": float(fmt.get("duration", 0)),
        "format": fmt.get("format_name", "unknown"),
        "bitrate": int(fmt.get("bit_rate", 0)),
    }

    if video_stream:
        metadata.update({
            "width": int(video_stream.get("width", 0)),
            "height": int(video_stream.get("height", 0)),
            "codec": video_stream.get("codec_name", "unknown"),
            # profile + pixel format distinguish the variants Chromium
            # can't decode (e.g. H.264 "High 10" / yuv422p / yuv444p) from
            # the ones it can (8-bit "High"/"Main" yuv420p). Surfaced in the
            # renderer's decode-error message so a Linux user sees exactly
            # why one H.264 file plays and another doesn't. Empty string
            # when ffprobe doesn't report them.
            "profile": video_stream.get("profile", "") or "",
            "pixFmt": video_stream.get("pix_fmt", "") or "",
            "fps": _parse_fps(video_stream.get("r_frame_rate", "0/1")),
        })

    global _metadata_cache_dirty
    with _metadata_cache_lock:
        _metadata_cache[cache_key] = metadata
        _metadata_cache_dirty += 1
    _save_metadata_cache()
    return metadata


def _parse_fps(rate_str: str) -> float:
    """Parse ffprobe frame rate string (e.g. '30/1' or '30000/1001')."""
    try:
        num, den = rate_str.split("/")
        return round(int(num) / int(den), 2) if int(den) != 0 else 0
    except (ValueError, ZeroDivisionError):
        return 0


def _get_video_hash(video_path: str) -> str:
    """Generate a short hash from the video file path + modification time for caching."""
    stat = os.stat(video_path)
    key = f"{video_path}:{stat.st_size}:{stat.st_mtime}"
    return hashlib.md5(key.encode()).hexdigest()[:12]


def generate_thumbnails(
    video_path: str,
    output_dir: str | None = None,
    interval: int = 10,
    width: int = 160,
    height: int = 90,
) -> dict[str, Any]:
    """Generate individual thumbnail images from a video at regular intervals.

    Args:
        video_path: Absolute path to the video file.
        output_dir: Directory to save thumbnails. Auto-generated if None.
        interval: Seconds between thumbnails.
        width: Thumbnail width in pixels.
        height: Thumbnail height in pixels.

    Returns:
        Dict with keys:
            - thumbnails: list of {time: float, path: str}
            - interval: seconds between thumbnails
            - count: total number of thumbnails

    Raises:
        FileNotFoundError: If video file doesn't exist.
        RuntimeError: If ffmpeg fails.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    # Determine output directory
    video_hash = _get_video_hash(video_path)
    if output_dir is None:
        output_dir = os.path.join(tempfile.gettempdir(), "funsync_thumbs", video_hash)

    os.makedirs(output_dir, exist_ok=True)

    # Check if thumbnails already exist (cached)
    manifest_path = os.path.join(output_dir, "manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path, "r") as f:
            manifest = json.load(f)
        # Verify files still exist
        if all(os.path.exists(t["path"]) for t in manifest.get("thumbnails", [])):
            return manifest

    # Get video duration first
    metadata = get_metadata(video_path)
    duration = metadata["duration"]

    if duration <= 0:
        return {"thumbnails": [], "interval": interval, "count": 0}

    # Generate thumbnails using ffmpeg
    output_pattern = os.path.join(output_dir, "thumb_%04d.jpg")

    try:
        result = run_silent(
            [
                FFMPEG,
                "-i", video_path,
                "-vf", f"fps=1/{interval},scale={width}:{height}",
                "-q:v", "5",
                "-y",
                output_pattern,
            ],
            capture_output=True,
            text=True,
            # See get_metadata above for why explicit utf-8/replace matters
            # on Windows — ffmpeg's stderr crashes the reader thread under
            # cp1252 when the input path or codec message has unmappable bytes.
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found. Install ffmpeg to use thumbnail features.")

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg thumbnail generation failed: {_one_line(result.stderr, 500)}")

    # Collect generated files
    thumbnails = []
    idx = 1
    while True:
        thumb_path = os.path.join(output_dir, f"thumb_{idx:04d}.jpg")
        if not os.path.exists(thumb_path):
            break
        thumbnails.append({
            "time": (idx - 1) * interval,
            "path": thumb_path,
        })
        idx += 1

    manifest = {
        "thumbnails": thumbnails,
        "interval": interval,
        "count": len(thumbnails),
        "video_hash": video_hash,
    }

    # Cache the manifest
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)

    return manifest


# ---------------------------------------------------------------------------
# Container remux (MKV → MP4)
#
# Chromium's <video> element can't demux the Matroska (.mkv) container even
# when the streams inside are formats it fully supports (H.264 + AAC). The
# user just gets "format not supported". The fix is to repackage the streams
# into an MP4 container WITHOUT re-encoding (`-c copy`) — instant, lossless —
# and play that instead. Only an audio track in a codec MP4/Chromium can't
# carry (AC3/DTS/FLAC/Opus/…) needs a cheap AAC transcode.
#
# Community-reported (2026-06): every H.264/AAC .mkv failed; converting to
# .mp4 by hand fixed it. This makes the app do that automatically on load.
# ---------------------------------------------------------------------------

# Video codecs we can stream-copy into MP4 AND Chromium can then decode.
# Deliberately conservative: e.g. mpeg4 (DivX/Xvid) would copy fine but
# Chromium can't decode it, so remuxing wouldn't actually help — better to
# fail clearly than produce a still-unplayable file.
_REMUX_VIDEO_COPYABLE = {"h264", "hevc", "h265", "av1"}


class RemuxCodecError(RuntimeError):
    """The video codec can't be made playable by a remux (it needs a full
    transcode). Typed, with the codec, so /api/media/remux can say so and the
    app can name the codec instead of "Video format not supported" (test day
    2026-11-24, B027: an MPEG-2 .mkv)."""

    def __init__(self, codec: str):
        self.codec = codec or "unknown"
        super().__init__(
            f"video codec '{self.codec}' can't be remuxed to a "
            f"browser-playable MP4 (would need a full transcode)"
        )
# Audio codecs already MP4/Chromium-friendly → copy as-is. Everything else
# (ac3, eac3, dts, truehd, flac, opus, vorbis, pcm_*) → transcode to AAC.
_REMUX_AUDIO_COPYABLE = {"aac", "mp3"}


def _probe_audio_codec(video_path: str) -> str | None:
    """Return the first audio stream's codec name (lowercase), or None if
    the file has no audio track. Best-effort — returns None on probe error
    so the caller treats it as 'no audio' rather than crashing the remux."""
    try:
        result = run_silent(
            [
                FFPROBE,
                "-v", "quiet",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=nokey=1:noprint_wrappers=1",
                video_path,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    name = (result.stdout or "").strip().lower()
    return name or None


# ---------------------------------------------------------------------------
# Embedded subtitles (#268 thirstyduck500, 2026-11-23). A text stream (SRT,
# ASS/SSA, mov_text, WebVTT) converts to WebVTT for the player's <track>
# (ASS styling and positions are lost). A PICTURE stream (PGS, VobSub, DVB)
# is bitmaps and cannot become text at all: it is listed with text=False so
# the player can say so instead of silently showing nothing.
# ---------------------------------------------------------------------------

TEXT_SUBTITLE_CODECS = {
    "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
    "microdvd", "subviewer", "subviewer1", "jacosub", "realtext", "sami",
    "stl", "mpl2", "pjs", "vplayer",
}

_subtitle_vtt_cache: "dict[tuple, str]" = {}
_SUBTITLE_VTT_CACHE_MAX = 16


def list_subtitle_streams(video_path: str) -> list:
    """Every subtitle stream in the file: index (the file's stream index),
    codec, language, title, default / forced flags, and whether it is text
    the player can show. Raises FileNotFoundError for a missing file."""
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    try:
        result = run_silent(
            [
                FFPROBE,
                "-v", "quiet",
                "-select_streams", "s",
                "-show_entries",
                "stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced",
                "-of", "json",
                video_path,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return []
    try:
        data = json.loads(result.stdout or "{}")
    except ValueError:
        return []
    out = []
    for s in data.get("streams", []) or []:
        if "index" not in s:
            continue
        codec = str(s.get("codec_name") or "").lower()
        tags = {str(k).lower(): v for k, v in (s.get("tags") or {}).items()}
        disp = s.get("disposition") or {}
        out.append({
            "index": int(s["index"]),
            "codec": codec,
            "language": str(tags.get("language") or ""),
            "title": str(tags.get("title") or ""),
            "default": bool(disp.get("default")),
            "forced": bool(disp.get("forced")),
            "text": codec in TEXT_SUBTITLE_CODECS,
        })
    return out


def extract_subtitle_vtt(video_path: str, stream_index: int) -> str:
    """One text subtitle stream as WebVTT. ffmpeg reads the whole file to
    collect a stream's cues, so a result is kept (by path, size, mtime and
    stream) for the session. Raises FileNotFoundError (no file), LookupError
    (no such subtitle stream), ValueError (a picture stream) or RuntimeError
    (ffmpeg failed)."""
    streams = list_subtitle_streams(video_path)
    match = next((s for s in streams if s["index"] == stream_index), None)
    if match is None:
        raise LookupError(f"No subtitle stream {stream_index}")
    if not match["text"]:
        raise ValueError(f"Picture subtitles ({match['codec']}) cannot be shown as text")
    st = os.stat(video_path)
    key = (os.path.normcase(os.path.abspath(video_path)), st.st_size, int(st.st_mtime), stream_index)
    if key in _subtitle_vtt_cache:
        return _subtitle_vtt_cache[key]
    try:
        result = run_silent(
            [
                FFMPEG, "-v", "error", "-nostdin",
                "-i", video_path,
                "-map", f"0:{stream_index}",
                "-f", "webvtt", "-",
            ],
            capture_output=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Reading the subtitles took too long")
    except (FileNotFoundError, subprocess.SubprocessError) as e:
        raise RuntimeError(str(e))
    if result.returncode != 0:
        err = (result.stderr or b"").decode("utf-8", errors="replace")
        raise RuntimeError(_one_line(err) or "ffmpeg failed")
    vtt = (result.stdout or b"").decode("utf-8", errors="replace")
    if len(_subtitle_vtt_cache) >= _SUBTITLE_VTT_CACHE_MAX:
        _subtitle_vtt_cache.pop(next(iter(_subtitle_vtt_cache)))
    _subtitle_vtt_cache[key] = vtt
    return vtt


def remux_out_path(video_path: str) -> str:
    """Where the remuxed MP4 of `video_path` lives (or will): the temp cache."""
    out_dir = os.path.join(tempfile.gettempdir(), "funsync_remux")
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"{_get_video_hash(video_path)}.mp4")


def remux_to_mp4(video_path: str) -> dict[str, Any]:
    """Repackage a video into an MP4 container for browser playback.

    Stream-copies the video (and audio, when already MP4-friendly); only an
    incompatible audio track is transcoded to AAC. Output is cached on disk
    by content hash so re-opening the same file is instant.

    Args:
        video_path: Absolute path to the source video (typically .mkv).

    Returns:
        Dict with keys:
            path:   absolute path to the remuxed MP4
            cached: True if a prior remux was reused
            vcodec / acodec: detected source codecs (for logging)

    Raises:
        FileNotFoundError: source missing or empty.
        RuntimeError: ffmpeg failed, or the video codec can't be made
            playable by remuxing (caller should surface "unsupported").
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    if os.path.getsize(video_path) == 0:
        raise FileNotFoundError(f"Video is empty (0 bytes): {video_path}")

    # Hash includes size+mtime (via _get_video_hash) so an edited/replaced
    # source re-remuxes instead of serving a stale MP4.
    out_path = remux_out_path(video_path)

    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path, "cached": True}

    meta = get_metadata(video_path)
    vcodec = (meta.get("codec") or "").lower()
    if vcodec not in _REMUX_VIDEO_COPYABLE:
        raise RemuxCodecError(vcodec)

    acodec = _probe_audio_codec(video_path)

    args = [
        FFMPEG, "-y",
        "-i", video_path,
        # First video + first audio (if any). `?` makes the audio map
        # optional so audio-less files don't fail the whole command.
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "copy",
    ]
    if acodec is None:
        pass  # no audio track
    elif acodec in _REMUX_AUDIO_COPYABLE:
        args += ["-c:a", "copy"]
    else:
        args += ["-c:a", "aac", "-b:a", "192k"]
    # +faststart relocates the moov atom to the front so the file is
    # seekable/streamable immediately (matters when the same MP4 is later
    # served over HTTP to the VR / web-remote clients).
    args += ["-movflags", "+faststart", out_path]

    try:
        result = run_silent(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Stream-copy is I/O-bound and fast even for multi-GB files, but
            # a large file on slow/NAS storage (plus an AAC audio transcode)
            # can take a while. Generous ceiling; normal case is seconds.
            timeout=600,
        )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found. Install ffmpeg to play this format.")
    except subprocess.TimeoutExpired:
        _safe_unlink(out_path)
        raise RuntimeError("remux timed out")

    if result.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        _safe_unlink(out_path)  # don't leave a half-written file in the cache
        raise RuntimeError(f"ffmpeg remux failed: {_one_line(result.stderr, 500)}")

    return {"path": out_path, "cached": False, "vcodec": vcodec, "acodec": acodec}


# ---------------------------------------------------------------------------
# Convert to play (Dave, 2026-11-26: "fix those"): a video whose codec
# Chromium cannot decode (MPEG-4 Part 2 / Xvid / DivX, MPEG-2, VC-1 / WMV,
# HEVC 4:4:4 ...) played its sound over a black picture. A remux cannot help
# (the codec is the problem), so ffmpeg re-encodes it to H.264 8-bit 4:2:0
# with AAC / MP3 sound into the remux cache. The original is only read.
#
# Minutes, not seconds, so it runs as a background job: the app starts it,
# polls its progress and can cancel it. One job per file (keyed by the same
# size + mtime hash as the remux cache), so a second start while one runs
# answers with the running job. Written to a .part file and renamed when
# complete, so a cancelled or failed run never leaves a half file a later
# start would take for done.
# ---------------------------------------------------------------------------

class TranscodeUnavailable(RuntimeError):
    """This ffmpeg has no H.264 encoder FunSync can use."""


_transcode_jobs: dict[str, dict[str, Any]] = {}
# Where converted copies live: <userData>/converted, set by main.py from
# --user-data-dir, so Windows' temp cleaning cannot take them and Settings >
# Data can show and clear them (Dave: "yes move them to the data folder").
# None (a backend started by hand, tests): the remux cache in temp.
_converted_dir: str | None = None
_transcode_lock = threading.Lock()
_h264_encoder_probe: list = []  # [encoder name or None], filled on first use

# libx264 first (in the bundled build on every platform); the OS encoders only
# when a system ffmpeg lacks it. Settings: visually close to the source at
# about 10x real time for 720p on a desktop CPU (veryfast, CRF 20).
_H264_ENCODER_ARGS = {
    "libx264": ["-preset", "veryfast", "-crf", "20"],
    "h264_mf": ["-b:v", "8M"],
    "h264_videotoolbox": ["-b:v", "8M"],
}


def _h264_encoder() -> str | None:
    """The H.264 encoder to convert with, asked of ffmpeg once per run."""
    if _h264_encoder_probe:
        return _h264_encoder_probe[0]
    found = None
    try:
        result = run_silent(
            [FFMPEG, "-hide_banner", "-encoders"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        )
        names = {line.split()[1] for line in (result.stdout or "").splitlines()
                 if len(line.split()) > 1 and line.strip()[:1] == "V"}
        found = next((name for name in _H264_ENCODER_ARGS if name in names), None)
    except (FileNotFoundError, subprocess.SubprocessError, IndexError):
        found = None
    _h264_encoder_probe.append(found)
    return found


_PART_FILE = re.compile(r"^[0-9a-f]{12}\.h264\.part\.mp4$")


def set_converted_dir(path: str | None) -> None:
    """Called from main.py at startup with <userData>/converted.

    Also removes part files a conversion left when the app closed mid-way
    (ffmpeg goes with the backend, its half-written file stayed: 39 MB on the
    test day, counted nowhere). At startup no conversion of this backend can
    be running, so every part file there is a leftover. Only files named as
    this module writes them are touched."""
    global _converted_dir
    _converted_dir = path or None
    if not _converted_dir or not os.path.isdir(_converted_dir):
        return
    try:
        names = os.listdir(_converted_dir)
    except OSError:
        return
    for name in names:
        if _PART_FILE.match(name):
            _safe_unlink(os.path.join(_converted_dir, name))


def transcode_out_path(video_path: str) -> str:
    """Where the converted copy of `video_path` lives (or will)."""
    out_dir = _converted_dir or os.path.join(tempfile.gettempdir(), "funsync_remux")
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"{_get_video_hash(video_path)}.h264.mp4")


def transcode_args(video_path: str, out_part: str, encoder: str, acodec: str | None) -> list[str]:
    """The ffmpeg command for one conversion (progress on stdout)."""
    args = [
        FFMPEG, "-y", "-nostdin", "-hide_banner",
        "-i", video_path,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", encoder, *_H264_ENCODER_ARGS.get(encoder, []),
        # 8-bit 4:2:0 is what every browser decodes; it needs even sizes, and
        # an odd-sized Xvid would otherwise fail the whole run.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p",
    ]
    if acodec is None:
        pass
    elif acodec in _REMUX_AUDIO_COPYABLE:
        args += ["-c:a", "copy"]
    else:
        args += ["-c:a", "aac", "-b:a", "192k"]
    args += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out_part]
    return args


def _transcode_view(key: str, job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job": key,
        "state": job["state"],
        "progress": round(float(job.get("progress") or 0.0), 4),
        "path": job.get("path"),
        "error": job.get("error"),
    }


def _run_transcode(key: str, out_path: str, args: list[str], duration: float) -> None:
    job = _transcode_jobs[key]
    part = args[-1]
    try:
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = NO_WINDOW_CREATIONFLAGS
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", **kwargs,
        )
        job["proc"] = proc
        tail: list[str] = []

        def drain_stderr():  # a full stderr pipe would stall ffmpeg
            for line in proc.stderr:
                tail.append(line.rstrip())
                del tail[:-20]

        drainer = threading.Thread(target=drain_stderr, daemon=True)
        drainer.start()
        for raw in proc.stdout:
            line = raw.strip()
            # out_time_us, and out_time_ms (also microseconds, despite its name)
            if line.startswith(("out_time_us=", "out_time_ms=")) and duration > 0:
                try:
                    seconds = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                job["progress"] = max(0.0, min(0.999, seconds / duration))
        proc.wait()
        drainer.join(timeout=5)
        if job.get("cancelled"):
            _safe_unlink(part)
            job["state"] = "cancelled"
            return
        if proc.returncode != 0 or not os.path.exists(part) or os.path.getsize(part) == 0:
            _safe_unlink(part)
            job["state"] = "error"
            job["error"] = _one_line(" ".join(tail), 300) or f"ffmpeg exited with {proc.returncode}"
            return
        os.replace(part, out_path)
        job["progress"] = 1.0
        job["path"] = out_path
        job["state"] = "done"
    except Exception as e:  # never leave a job "running" forever
        _safe_unlink(part)
        job["state"] = "error"
        job["error"] = str(e) or e.__class__.__name__
    finally:
        job["proc"] = None


def transcode_start(video_path: str, cached_only: bool = False) -> dict[str, Any]:
    """Start converting `video_path` (or answer with what is there).

    Returns the job view: state 'done' with `path` when a converted copy
    exists (cached), 'running' with progress, or, with `cached_only`, state
    'none' when there is no copy (nothing is started).

    Raises FileNotFoundError (no file) and TranscodeUnavailable (no H.264
    encoder in this ffmpeg).
    """
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    out_path = transcode_out_path(video_path)
    key = os.path.basename(out_path)[: -len(".h264.mp4")]
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"job": key, "state": "done", "progress": 1.0, "path": out_path, "error": None, "cached": True}
    with _transcode_lock:
        job = _transcode_jobs.get(key)
        if job and job["state"] == "running":
            return _transcode_view(key, job)
        if cached_only:
            return {"job": key, "state": "none", "progress": 0.0, "path": None, "error": None}
        encoder = _h264_encoder()
        if not encoder:
            raise TranscodeUnavailable("this ffmpeg has no H.264 encoder")
        try:
            duration = float(get_metadata(video_path).get("duration") or 0)
        except (RuntimeError, ValueError, TypeError):
            duration = 0.0
        acodec = _probe_audio_codec(video_path)
        part = out_path[: -len(".mp4")] + ".part.mp4"
        args = transcode_args(video_path, part, encoder, acodec)
        job = {"state": "running", "progress": 0.0, "path": None, "error": None,
               "cancelled": False, "proc": None, "source": video_path}
        _transcode_jobs[key] = job
        threading.Thread(target=_run_transcode, args=(key, out_path, args, duration), daemon=True).start()
        return _transcode_view(key, job)


def transcode_status(key: str) -> dict[str, Any]:
    """A job's state ('none' when this run has no such job)."""
    job = _transcode_jobs.get(key)
    if not job:
        return {"job": key, "state": "none", "progress": 0.0, "path": None, "error": None}
    return _transcode_view(key, job)


def transcode_cancel(key: str) -> dict[str, Any]:
    """Stop a running job; its part file is removed when ffmpeg has gone."""
    job = _transcode_jobs.get(key)
    if job and job["state"] == "running":
        job["cancelled"] = True
        proc = job.get("proc")
        if proc is not None:
            try:
                proc.terminate()
            except OSError:
                pass
    return transcode_status(key)


def _stop_all_transcodes() -> None:
    """On exit: a converting ffmpeg must not outlive the backend."""
    for job in list(_transcode_jobs.values()):
        proc = job.get("proc")
        if proc is not None and job.get("state") == "running":
            job["cancelled"] = True
            try:
                proc.kill()
            except OSError:
                pass


atexit.register(_stop_all_transcodes)


def _one_line(text, keep: int = 0) -> str:
    """ffmpeg / ffprobe stderr as ONE line, optionally only its last `keep`
    characters (the cause is printed last) (E-11).

    stderr is several lines ("[mov,...] moov atom not found" then
    "<file>: Invalid data found when processing input"), and the message goes
    into a 500's detail that main.js logs as one warning: the second line
    reached main.log with no timestamp or level, so a grep by [warn] missed it.
    """
    flat = " ".join(str(text or "").split())
    return flat[-keep:] if keep and len(flat) > keep else flat


def _safe_unlink(path: str) -> None:
    """Remove a file, swallowing errors (used to clean up partial output)."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def is_complete_jpeg(path: str) -> bool:
    """True when `path` is a non-empty file that starts with a JPEG SOI
    (FF D8) and ends with its EOI (FF D9) (FT-084).

    A thumbnail ffmpeg was killed in the middle of (the subprocess timeout)
    is a cut-off JPEG: it exists, so it used to count as a cache hit and was
    served for good. Every file this is asked about is the app's own cache
    output, which ffmpeg ends exactly at the EOI.
    """
    try:
        size = os.path.getsize(path)
        if size < 4:
            return False
        with open(path, "rb") as f:
            head = f.read(2)
            f.seek(-2, os.SEEK_END)
            tail = f.read(2)
        return head == b"\xff\xd8" and tail == b"\xff\xd9"
    except OSError:
        return False


def _temp_jpeg_path(output_path: str) -> str:
    """A sibling temp name for ffmpeg to write first; it ends in `.jpg` so
    ffmpeg still picks the JPEG muxer from the extension (FT-084)."""
    base = output_path[:-4] if output_path.lower().endswith(".jpg") else output_path
    return f"{base}.part-{os.getpid()}-{threading.get_ident()}.jpg"


def generate_single_thumbnail(
    video_path: str,
    seek_pct: float = 0.1,
    width: int = 320,
    exact: bool = False,
) -> dict[str, Any]:
    """Generate ONE thumbnail frame for a library card. Single ffmpeg
    invocation — much cheaper than the multi-frame preview generator
    above, since library cards only need a single representative image.

    Cached on disk by content hash; subsequent calls return the cached
    path immediately. Auto-rejects audio-only files (no video stream).

    Args:
        video_path: Absolute path to the video file.
        seek_pct: Where in the video to grab (0.0 - 1.0). Default 10%.
        width: Output width in pixels. Height auto-scales.
        exact: Grab the frame AT seek_pct exactly. Used when the user
            explicitly picked a frame ("Set thumbnail frame…") — the
            picker preview shows a frame-accurate seek, so the generated
            tile must match it (WYSIWYG). Disables the two default-path
            heuristics that trade accuracy for speed: the 10s minimum
            seek (studio-ident avoidance) and `-skip_frame nokey`
            (nearest-keyframe decode). Still a single-frame output — the
            extra cost is decoding forward from the previous keyframe to
            the picked timestamp (bounded by one GOP), acceptable for a
            one-off user-triggered request but NOT for the 8-way bulk
            library queue, which stays on the fast default path.

    Returns:
        Dict with:
            path: absolute path to generated JPEG
            duration: video duration in seconds (so caller can cache it)
            width / height: actual dimensions

    Raises:
        FileNotFoundError: video doesn't exist.
        RuntimeError: ffmpeg failed.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    # Skip 0-byte files (typically aborted/incomplete downloads). ffmpeg
    # would otherwise hang for the full subprocess timeout trying to
    # demux an empty MP4 ("moov atom not found") — the renderer's queue
    # then waits on a doomed decode while other thumbnails sit pending.
    # Treat as a missing file so the renderer falls back to its default
    # thumbnail without blocking other requests.
    if os.path.getsize(video_path) == 0:
        raise FileNotFoundError(f"Video is empty (0 bytes): {video_path}")

    video_hash = _get_video_hash(video_path)
    output_dir = os.path.join(tempfile.gettempdir(), "funsync_thumbs", video_hash)
    os.makedirs(output_dir, exist_ok=True)

    # Cache key includes width + seek_pct so different requested sizes
    # don't collide. The `v4` prefix bumps the cache whenever the
    # decode strategy changes — v1 black thumbs, v2 timed-out HEVC
    # stubs, and v3 software-decode versions are all abandoned and
    # regenerated with the current `-skip_frame nokey` strategy on
    # next view.
    # Exact (user-picked) frames get their own cache namespace — a prior
    # default-path generation at the same pct/width is a *keyframe* grab
    # and must not satisfy an exact request.
    marker = "v4e" if exact else "v4"
    cache_name = f"single_{marker}_{int(seek_pct * 1000):04d}_{width}.jpg"
    output_path = os.path.join(output_dir, cache_name)

    # Need duration to compute seek time AND to return alongside the
    # thumbnail (callers cache it on the video object). Cheap when
    # ffprobe-cached.
    metadata = get_metadata(video_path)
    duration = metadata.get("duration") or 0
    out_width = metadata.get("width") or width
    out_height = metadata.get("height") or 0

    # Cache hit — bail early. Only a whole JPEG counts (FT-084): a file a
    # killed ffmpeg left behind (written before this wrote to a temp name
    # first) is removed and generated again.
    if os.path.exists(output_path):
        if is_complete_jpeg(output_path):
            return {
                "path": output_path,
                "duration": duration,
                "width": width,
                "height": (round(width * out_height / out_width)
                           if out_width and out_height else 0),
            }
        _safe_unlink(output_path)

    if duration <= 0:
        raise RuntimeError("Video has no duration; cannot grab thumbnail")

    # Pick a sensible seek time. Studio idents / fade-ins typically run
    # 5-10s, so for anything over a minute we clamp the seek to AT LEAST
    # 10s in (using `seek_pct` if it's later — e.g. 30s into a 5-minute
    # clip). Short clips just take the percentage mark verbatim so we
    # don't seek past the action. Inverted from the previous min(...,5s)
    # cap, which sampled directly INTO the studio ident window and
    # produced black thumbnails for most long videos.
    #
    # Exact mode: the user picked this timestamp on purpose — never
    # second-guess it (the clamp silently overrode any pick inside the
    # first 10s of a longer video).
    if exact:
        seek_time = duration * seek_pct
    else:
        seek_time = max(10.0, duration * seek_pct) if duration > 60 else duration * seek_pct

    tmp_path = _temp_jpeg_path(output_path)

    # `-hide_banner -loglevel error` leave stderr holding only the errors.
    # Without them it opened with the version/build banner, and the banner
    # was all a failure log line ever showed (app test V32).
    cmd = [
        FFMPEG,
        "-hide_banner", "-loglevel", "error",
        # `-skip_frame nokey` tells the decoder to discard all
        # non-keyframe (B/P) data. Combined with `-ss` fast-seek
        # (which already lands on/near a keyframe), this means
        # the decoder produces ONE keyframe near our target
        # instead of decoding forward through expensive B/P
        # frames. For HEVC at 6K-8K (typical for VR libraries)
        # this is a 4-12× speedup vs plain software decode and
        # also beats every hardware-accel variant we benchmarked
        # (cuda, qsv, d3d11va) — those have per-subprocess GPU
        # context init overhead that exceeds the savings on
        # short single-frame jobs, AND they fragment by
        # platform/GPU. `skip_frame nokey` is portable: pure
        # software, works without any GPU, identical behaviour
        # on Windows/Linux/macOS.
        #
        # Trade-off: output is the nearest-keyframe to our seek
        # target, not the exact frame at the seek time. For
        # thumbnails that's fine — keyframes are 1-3 seconds
        # apart in typical encoding, the corrected seek formula
        # above puts us well past studio idents either way.
        #
        # Benchmark on a 32-video VR library (mix of H.264 1080p
        # and HEVC 6K-8K), concurrency 4, NVIDIA + Intel hybrid
        # laptop:
        #   skip_frame nokey:  7.6s total  (0.9s avg, 5.7s max)
        #   hwaccel cuda:     33.6s total  (4.0s avg, 17.6s max)
        #   plain software:   43.8s total  (5.2s avg, 26.1s max)
        #   hwaccel auto:     62.5s total  (7.0s avg, 40.2s max)
        #
        # See bench/bench_thumbnails.py to re-run on other
        # hardware. Must come BEFORE -i (decoder option).
        #
        # Omitted in exact mode: skipping non-keyframes makes the
        # output the nearest KEYFRAME to the seek target (fine
        # for auto thumbs, wrong for a user-picked frame). Without
        # it, `-ss` before `-i` is frame-accurate in modern ffmpeg
        # — it seeks to the prior keyframe and decodes forward to
        # the exact timestamp.
        *([] if exact else ["-skip_frame", "nokey"]),
        # -ss BEFORE -i = fast seek (skips ahead via container
        # index instead of decoding from the start). Order matters.
        "-ss", str(seek_time),
        "-i", video_path,
        "-frames:v", "1",
        # NOTE: an earlier revision used `thumbnail=N` here to
        # auto-reject black/fade frames. Reverted because it
        # forces the decoder to produce N full-resolution frames,
        # which on 8K HEVC content is ~5-10× slower than software
        # can sustain — under the renderer's 8-way concurrent
        # thumbnail queue, the 30s subprocess timeout fired on
        # every 6K/8K HEVC file in a typical VR library. The
        # corrected `seek_time` formula above (10s minimum past
        # the start, past typical studio idents) is the actual
        # fix for the original black-thumbnail bug; the analysis
        # filter was overkill. If we ever need cheaper black
        # detection, do it Python-side after decoding ONE frame
        # (read JPEG, compute mean luma, retry with deeper seek
        # if dark). One decode per attempt instead of N.
        "-vf", f"scale={width}:-2",  # -2 = preserve AR, even-rounded
        "-q:v", "5",
        "-y",
        # A temp name, renamed over `output_path` only once ffmpeg has
        # finished (FT-084). Written straight to the cache name, a run cut
        # off by the timeout left a partial JPEG there that every later
        # request took as a cache hit.
        tmp_path,
    ]
    run_kwargs = dict(
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        # Lowered from 60s so a slow/disconnected drive frees its worker
        # slot sooner (see THUMBNAIL_TIMEOUT_SEC). Genuine 8K-HEVC decode
        # finishes well inside this; truly-broken files (corrupt streams,
        # hung NAS reads, spun-down HDDs) time out ~2.4× faster instead of
        # holding the queue for a full minute.
        timeout=THUMBNAIL_TIMEOUT_SEC,
    )
    try:
        result = run_silent(cmd, **run_kwargs)
        if not exact and (result.returncode != 0 or not os.path.exists(tmp_path)):
            # No keyframe at or after the seek point means no frame at all:
            # `-ss` lands on the keyframe BEFORE seek_time and drops frames
            # before seek_time, and `nokey` drops every other frame. A clip
            # whose only keyframe precedes the seek (shorter than one GOP,
            # ~8 s at x264's default keyint 250 / 30 fps) produced nothing,
            # and every request for it failed again (app test V31). Retry
            # ONCE the way exact mode runs: still a single output frame,
            # decoded forward from that keyframe (at most one GOP), and still
            # no thumbnail/select filter (those break VR libraries).
            _safe_unlink(tmp_path)
            retry = list(cmd)
            i = retry.index("-skip_frame")
            del retry[i:i + 2]
            result = run_silent(retry, **run_kwargs)
    except FileNotFoundError:
        _safe_unlink(tmp_path)
        raise RuntimeError("ffmpeg not found. Install ffmpeg to use thumbnail features.")
    except subprocess.TimeoutExpired:
        # Killed mid-write: whatever it wrote is a partial JPEG. Only the temp
        # file is removed; nothing reaches the cache name (FT-084).
        _safe_unlink(tmp_path)
        raise RuntimeError(
            f"ffmpeg single-thumbnail timed out after {THUMBNAIL_TIMEOUT_SEC}s")

    if result.returncode != 0 or not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
        _safe_unlink(tmp_path)
        # ffmpeg prints the cause LAST, so the tail is the diagnosis.
        raise RuntimeError(f"ffmpeg single-thumbnail failed: {_one_line(result.stderr, 500)}")

    try:
        os.replace(tmp_path, output_path)
    except OSError:
        # The cache name is held open (Windows) or another request finished
        # the same thumbnail first: use theirs if it is whole.
        _safe_unlink(tmp_path)
        if not is_complete_jpeg(output_path):
            raise RuntimeError("ffmpeg single-thumbnail could not be saved to the cache")

    return {
        "path": output_path,
        "duration": duration,
        "width": width,
        "height": (round(width * out_height / out_width)
                   if out_width and out_height else 0),
    }
