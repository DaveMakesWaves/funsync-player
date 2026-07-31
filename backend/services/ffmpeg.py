"""FFmpeg/FFprobe services — metadata extraction and thumbnail generation."""

import subprocess
import json
import os
import hashlib
import sys
import tempfile
from typing import Any


def _find_binary(name: str) -> str:
    """Find ffmpeg/ffprobe binary — bundled alongside the backend exe, or on PATH."""
    # Check next to the running executable (PyInstaller bundle)
    if getattr(sys, "frozen", False):
        bundled = os.path.join(os.path.dirname(sys.executable), name)
        if os.path.exists(bundled):
            return bundled
    # Check sibling dev directories. Windows keeps ffmpeg in `ffmpeg/`;
    # Linux keeps it in `ffmpeg-linux/` (the CI build downloads platform-
    # specific static binaries into each). Probe both so dev runs work on
    # either OS without a reshuffle.
    project_root = os.path.join(os.path.dirname(__file__), "..", "..")
    exe_suffix = ".exe" if os.name == "nt" else ""
    dev_dirs = ("ffmpeg-linux", "ffmpeg") if os.name != "nt" else ("ffmpeg",)
    for d in dev_dirs:
        dev_path = os.path.join(project_root, d, name + exe_suffix)
        if os.path.exists(dev_path):
            return os.path.abspath(dev_path)
    # Fall back to PATH
    return name


FFPROBE = _find_binary("ffprobe")
FFMPEG = _find_binary("ffmpeg")


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


# In-memory metadata cache. Keyed by (path, size, mtime) so file edits
# invalidate naturally. The thumbnail-single endpoint calls
# get_metadata for EVERY thumbnail to know the duration; without
# caching, that doubles the per-thumbnail cost (ffprobe + ffmpeg).
# Cache survives the lifetime of the backend process; no need to bound
# growth — entries are tiny dicts and a library of 10k videos is < 1MB.
_metadata_cache: dict[str, dict[str, Any]] = {}

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
    # re-ran ffprobe wastefully).
    stat = os.stat(video_path)
    cache_key = f"{video_path}:{stat.st_size}:{stat.st_mtime}"
    cached = _metadata_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        result = run_silent(
            [
                FFPROBE,
                "-v", "quiet",
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
        raise RuntimeError(f"ffprobe failed: {result.stderr}")

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

    _metadata_cache[cache_key] = metadata
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
        raise RuntimeError(f"ffmpeg thumbnail generation failed: {result.stderr}")

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

    out_dir = os.path.join(tempfile.gettempdir(), "funsync_remux")
    os.makedirs(out_dir, exist_ok=True)
    # Hash includes size+mtime (via _get_video_hash) so an edited/replaced
    # source re-remuxes instead of serving a stale MP4.
    out_path = os.path.join(out_dir, f"{_get_video_hash(video_path)}.mp4")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path, "cached": True}

    meta = get_metadata(video_path)
    vcodec = (meta.get("codec") or "").lower()
    if vcodec not in _REMUX_VIDEO_COPYABLE:
        raise RuntimeError(
            f"video codec '{vcodec or 'unknown'}' can't be remuxed to a "
            f"browser-playable MP4 (would need a full transcode)"
        )

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
        tail = (result.stderr or "")[-500:]
        raise RuntimeError(f"ffmpeg remux failed: {tail}")

    return {"path": out_path, "cached": False, "vcodec": vcodec, "acodec": acodec}


def _safe_unlink(path: str) -> None:
    """Remove a file, swallowing errors (used to clean up partial output)."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def generate_single_thumbnail(
    video_path: str,
    seek_pct: float = 0.1,
    width: int = 320,
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
    cache_name = f"single_v4_{int(seek_pct * 1000):04d}_{width}.jpg"
    output_path = os.path.join(output_dir, cache_name)

    # Need duration to compute seek time AND to return alongside the
    # thumbnail (callers cache it on the video object). Cheap when
    # ffprobe-cached.
    metadata = get_metadata(video_path)
    duration = metadata.get("duration") or 0
    out_width = metadata.get("width") or width
    out_height = metadata.get("height") or 0

    # Cache hit — bail early.
    if os.path.exists(output_path):
        return {
            "path": output_path,
            "duration": duration,
            "width": width,
            "height": (round(width * out_height / out_width)
                       if out_width and out_height else 0),
        }

    if duration <= 0:
        raise RuntimeError("Video has no duration; cannot grab thumbnail")

    # Pick a sensible seek time. Studio idents / fade-ins typically run
    # 5-10s, so for anything over a minute we clamp the seek to AT LEAST
    # 10s in (using `seek_pct` if it's later — e.g. 30s into a 5-minute
    # clip). Short clips just take the percentage mark verbatim so we
    # don't seek past the action. Inverted from the previous min(...,5s)
    # cap, which sampled directly INTO the studio ident window and
    # produced black thumbnails for most long videos.
    seek_time = max(10.0, duration * seek_pct) if duration > 60 else duration * seek_pct

    try:
        result = run_silent(
            [
                FFMPEG,
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
                "-skip_frame", "nokey",
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
                output_path,
            ],
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
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found. Install ffmpeg to use thumbnail features.")

    if result.returncode != 0 or not os.path.exists(output_path):
        raise RuntimeError(f"ffmpeg single-thumbnail failed: {result.stderr}")

    return {
        "path": output_path,
        "duration": duration,
        "width": width,
        "height": (round(width * out_height / out_width)
                   if out_width and out_height else 0),
    }
