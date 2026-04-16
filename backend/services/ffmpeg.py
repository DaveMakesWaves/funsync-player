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
    # Check in a sibling ffmpeg/ directory (dev layout)
    project_root = os.path.join(os.path.dirname(__file__), "..", "..")
    dev_path = os.path.join(project_root, "ffmpeg", name + (".exe" if os.name == "nt" else ""))
    if os.path.exists(dev_path):
        return os.path.abspath(dev_path)
    # Fall back to PATH
    return name


FFPROBE = _find_binary("ffprobe")
FFMPEG = _find_binary("ffmpeg")


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

    try:
        result = subprocess.run(
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
        result = subprocess.run(
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
