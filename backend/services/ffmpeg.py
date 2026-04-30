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


def get_metadata(video_path: str) -> dict[str, Any]:
    """Extract video metadata using ffprobe.

    Args:
        video_path: Absolute path to the video file.

    Returns:
        Dict with keys: duration, width, height, codec, format, bitrate, fps.

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
            # 60s timeout (was 30s). Single-frame decode of 8K HEVC takes
            # ~3s standalone but can stretch to ~15-20s under contention
            # from sibling thumbnail processes, even with the renderer's
            # concurrency throttle. 60s is generous enough that genuine
            # progress always finishes; truly-broken files (corrupt
            # streams, hung NAS reads) still time out instead of hanging
            # the queue forever.
            timeout=60,
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
