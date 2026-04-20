"""Media streaming routes — serve video files and funscripts to VR headsets.

Supports HTTP Range requests for seeking in large VR video files (5-20GB).
Also serves funscript files and generates/caches thumbnails.
"""

import hashlib
import mimetypes
import os
import stat
import subprocess

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse, Response

router = APIRouter()

# Video ID → file path mapping (populated by scan)
_video_registry: dict[str, dict] = {}

# Thumbnail cache directory
_thumb_cache_dir = None


def set_thumb_cache_dir(path: str):
    """Set the thumbnail cache directory."""
    global _thumb_cache_dir
    _thumb_cache_dir = path
    os.makedirs(path, exist_ok=True)


def register_videos(videos: list[dict]):
    """Register videos from a library scan for streaming.

    Each video dict should have: path, name, funscriptPath (optional).
    Generates a stable ID from the file path hash.
    """
    _video_registry.clear()
    for v in videos:
        vid_id = _path_to_id(v.get("path", ""))
        _video_registry[vid_id] = v


def get_video_registry():
    """Return the current video registry."""
    return _video_registry


def _path_to_id(filepath: str) -> str:
    """Generate a stable short ID from a file path."""
    return hashlib.md5(filepath.encode("utf-8")).hexdigest()[:12]


# VR activity tracking — stores the last scene request from a VR headset
_vr_activity = {"clientIp": None, "videoId": None, "timestamp": 0}


def record_vr_activity(client_ip: str, video_id: str):
    """Record that a VR headset requested a scene."""
    import time
    _vr_activity["clientIp"] = client_ip
    _vr_activity["videoId"] = video_id
    _vr_activity["timestamp"] = time.time()


@router.get("/vr-activity")
async def get_vr_activity():
    """Get the last VR scene request (polled by renderer for auto-connect)."""
    return _vr_activity


@router.post("/register")
async def register_library(request: Request):
    """Register videos from a library scan (called by Electron main process)."""
    data = await request.json()
    videos = data.get("videos", [])
    register_videos(videos)

    thumb_dir = data.get("thumbCacheDir")
    if thumb_dir:
        set_thumb_cache_dir(thumb_dir)

    return {"registered": len(_video_registry)}


# --- Video Streaming ---

MIME_TYPES = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}


@router.get("/stream/{video_id}")
async def stream_video(video_id: str, request: Request):
    """Stream a video file with HTTP Range request support."""
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    filepath = video.get("path", "")
    if not filepath or not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="File not found on disk")

    file_size = os.path.getsize(filepath)
    ext = os.path.splitext(filepath)[1].lower()
    content_type = MIME_TYPES.get(ext, "application/octet-stream")

    # Parse Range header
    range_header = request.headers.get("range")
    if range_header:
        # Parse "bytes=start-end"
        try:
            range_spec = range_header.replace("bytes=", "").strip()
            parts = range_spec.split("-")
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else file_size - 1
        except (ValueError, IndexError):
            start = 0
            end = file_size - 1

        end = min(end, file_size - 1)
        content_length = end - start + 1

        async def range_generator():
            chunk_size = 1024 * 1024  # 1MB chunks
            with open(filepath, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    read_size = min(chunk_size, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            range_generator(),
            status_code=206,
            media_type=content_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
            },
        )
    else:
        # No range — serve full file
        return FileResponse(
            filepath,
            media_type=content_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Access-Control-Allow-Origin": "*",
            },
        )


# --- Funscript Serving ---

@router.get("/script/{video_id}")
async def get_funscript(video_id: str):
    """Serve the funscript associated with a video."""
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    fs_path = video.get("funscriptPath")
    if not fs_path or not os.path.isfile(fs_path):
        raise HTTPException(status_code=404, detail="No funscript for this video")

    return FileResponse(
        fs_path,
        media_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
    )


# --- Thumbnail Generation ---

@router.get("/thumb/{video_id}")
async def get_thumbnail(video_id: str):
    """Serve a thumbnail for a video (generated via ffmpeg, cached)."""
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    filepath = video.get("path", "")
    if not filepath or not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="File not found")

    if not _thumb_cache_dir:
        raise HTTPException(status_code=500, detail="Thumbnail cache not configured")

    thumb_path = os.path.join(_thumb_cache_dir, f"{video_id}.jpg")

    # Return cached thumbnail if exists
    if os.path.isfile(thumb_path):
        return FileResponse(thumb_path, media_type="image/jpeg",
                            headers={"Access-Control-Allow-Origin": "*"})

    # Generate thumbnail via ffmpeg
    from services.ffmpeg import _find_binary
    ffmpeg_path = _find_binary("ffmpeg")

    try:
        # Extract frame at 25% of duration
        result = subprocess.run(
            [ffmpeg_path, "-i", filepath, "-ss", "25%", "-frames:v", "1",
             "-q:v", "5", "-vf", "scale=320:-1", thumb_path, "-y"],
            capture_output=True, timeout=30,
        )
        if result.returncode != 0 or not os.path.isfile(thumb_path):
            # Fallback: try at 5 seconds
            subprocess.run(
                [ffmpeg_path, "-i", filepath, "-ss", "5", "-frames:v", "1",
                 "-q:v", "5", "-vf", "scale=320:-1", thumb_path, "-y"],
                capture_output=True, timeout=30,
            )
    except Exception:
        raise HTTPException(status_code=500, detail="Thumbnail generation failed")

    if not os.path.isfile(thumb_path):
        raise HTTPException(status_code=500, detail="Thumbnail not generated")

    return FileResponse(thumb_path, media_type="image/jpeg",
                        headers={"Access-Control-Allow-Origin": "*"})
