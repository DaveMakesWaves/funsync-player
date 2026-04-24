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

# Collections / playlists / categories — populated alongside the video
# registry when the renderer registers its library. Kept as lists of dicts
# (the Electron renderer's native shape) so the remote routes can project
# them without mutating. "View only" on the phone — no create/edit/delete.
_collections: list[dict] = []
_playlists: list[dict] = []
_categories: list[dict] = []
# videoPath → [categoryId, ...]
_video_categories: dict[str, list[str]] = {}
# library.sources from settings — {id, name, path, enabled} per source.
# Web remote's folder-browse tree needs these so it knows where to stop
# walking parent directories (a source root has no parent in the tree).
_sources: list[dict] = []

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

    Kicks off a background ffprobe pass to fill in missing durations —
    the Electron renderer populates durations lazily during thumbnail
    scroll, so videos the user hasn't scrolled past yet arrive here with
    duration=0. The web remote (and VR content server) would otherwise
    show "0" runtime on grouping rows and no duration badge on cards.
    """
    _video_registry.clear()
    _speed_probed.clear()  # new library scan → re-compute speed stats
    for v in videos:
        vid_id = _path_to_id(v.get("path", ""))
        _video_registry[vid_id] = v

    _queue_duration_probes()
    _queue_speed_probes()


# --- Background duration probe ------------------------------------------
# Same concurrency-limited pattern as the thumbnail generator further
# down this file. We don't want 900 simultaneous ffprobe processes on a
# big library, but leaving durations at 0 until the desktop gets around
# to scrolling every card is too slow for the phone.

_duration_probing: set = set()   # video IDs currently being probed
_duration_semaphore = None


def _queue_duration_probes():
    """Spawn background ffprobe jobs for every registered video missing a
    duration. Idempotent — a video already being probed is skipped."""
    import threading
    global _duration_semaphore
    if _duration_semaphore is None:
        _duration_semaphore = threading.Semaphore(2)

    # Snapshot the IDs that need probing before spawning threads so we
    # don't read the registry from multiple threads while iterating.
    pending = [
        (vid_id, v.get("path"))
        for vid_id, v in _video_registry.items()
        if (v.get("duration") or 0) == 0 and v.get("path")
        and vid_id not in _duration_probing
    ]
    for vid_id, _path in pending:
        _duration_probing.add(vid_id)

    for vid_id, filepath in pending:
        threading.Thread(
            target=_probe_duration, args=(vid_id, filepath), daemon=True
        ).start()


def _probe_duration(vid_id: str, filepath: str):
    """Run ffprobe for a single file and store the duration back onto the
    registry entry. Fails silently — a missing duration just means the
    phone shows "N videos" without a runtime, which is fine."""
    if _duration_semaphore is None:
        return
    _duration_semaphore.acquire()
    try:
        if not filepath or not os.path.isfile(filepath):
            return
        from services.ffmpeg import get_metadata
        meta = get_metadata(filepath)
        dur = meta.get("duration") or 0
        entry = _video_registry.get(vid_id)
        if entry is not None and dur:
            entry["duration"] = dur
    except Exception:
        pass
    finally:
        _duration_probing.discard(vid_id)
        _duration_semaphore.release()


# --- Background funscript speed-stats probe ------------------------------
# Computes avg + max speed (units/s) per video from its funscript. The
# desktop does this lazily during thumbnail scroll; the phone needs the
# stats up-front to colour speed badges. Single-threaded — this workload
# is CPU-bound (JSON parse) under Python's GIL, so threading actually
# hurts throughput (benched at bench/bench_speed_stats.py).

import json as _json
_speed_probed: set = set()   # video IDs already probed (success or fail)


def _compute_speed_stats(actions):
    """Port of renderer/js/library-search.js::computeSpeedStats.

    Returns {avgSpeed, maxSpeed} in units/s (pos range 0-100). Zero-movement
    pairs (consecutive same position) are excluded so held positions don't
    drag the average down."""
    if not actions or len(actions) < 2:
        return {"avgSpeed": 0, "maxSpeed": 0}
    total = 0.0
    max_speed = 0.0
    count = 0
    for i in range(1, len(actions)):
        dt = actions[i].get("at", 0) - actions[i - 1].get("at", 0)
        if dt <= 0:
            continue
        dp = abs(actions[i].get("pos", 0) - actions[i - 1].get("pos", 0))
        if dp == 0:
            continue
        speed = (dp / dt) * 1000
        total += speed
        if speed > max_speed:
            max_speed = speed
        count += 1
    return {
        "avgSpeed": round(total / count) if count > 0 else 0,
        "maxSpeed": round(max_speed),
    }


def _queue_speed_probes():
    """Spawn ONE background thread that walks the registry and computes
    speed stats for every video with a funscript. Sequential because of
    the GIL — threads don't help JSON-parse CPU work."""
    import threading

    pending = [
        (vid_id, v.get("funscriptPath"))
        for vid_id, v in _video_registry.items()
        if v.get("funscriptPath")
        and v.get("avgSpeed") is None
        and vid_id not in _speed_probed
    ]
    if not pending:
        return
    for vid_id, _p in pending:
        _speed_probed.add(vid_id)

    threading.Thread(
        target=_speed_probe_worker, args=(pending,), daemon=True
    ).start()


def _speed_probe_worker(pending: list):
    """Sequential loop — reads each funscript, computes speed stats, stores
    back on the registry entry."""
    for vid_id, fs_path in pending:
        try:
            if not fs_path or not os.path.isfile(fs_path):
                continue
            with open(fs_path, encoding="utf-8") as f:
                data = _json.load(f)
            stats = _compute_speed_stats(data.get("actions") or [])
            entry = _video_registry.get(vid_id)
            if entry is not None:
                entry["avgSpeed"] = stats["avgSpeed"]
                entry["maxSpeed"] = stats["maxSpeed"]
        except Exception:
            # Failure: mark as probed but with 0 speeds so we don't retry.
            entry = _video_registry.get(vid_id)
            if entry is not None and entry.get("avgSpeed") is None:
                entry["avgSpeed"] = 0
                entry["maxSpeed"] = 0


def register_collections(collections: list[dict]):
    """Register user collections (library.collections from settings)."""
    _collections.clear()
    _collections.extend(collections or [])


def register_playlists(playlists: list[dict]):
    """Register user playlists."""
    _playlists.clear()
    _playlists.extend(playlists or [])


def register_categories(categories: list[dict], video_categories: dict):
    """Register user categories + the videoPath→[categoryId] map."""
    _categories.clear()
    _categories.extend(categories or [])
    _video_categories.clear()
    if video_categories:
        _video_categories.update(video_categories)


def register_sources(sources: list[dict]):
    """Register the library source folders (id/name/path per source).
    Filters out disabled sources — they don't belong in folder browse."""
    _sources.clear()
    for s in sources or []:
        if s and s.get("enabled") is not False and s.get("path"):
            _sources.append(s)


def get_video_registry():
    """Return the current video registry."""
    return _video_registry


def get_collections() -> list[dict]:
    return list(_collections)


def get_playlists() -> list[dict]:
    return list(_playlists)


def get_categories() -> list[dict]:
    return list(_categories)


def get_video_categories() -> dict:
    return dict(_video_categories)


def get_sources() -> list[dict]:
    return list(_sources)


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


@router.get("/durations")
async def get_durations():
    """Return all known video durations, keyed by absolute video path.

    The renderer's scan doesn't capture durations (no ffprobe pass) —
    thumbnail capture populates them lazily, but only for cards the user
    has actually scrolled past, and only via the capture path (not the
    thumbnail cache hit path). That left Sort-by-Duration effectively
    broken: most videos had `duration = 0` and sorted to one end.

    The backend's `_queue_duration_probes` worker (fired by
    `register_videos`) computes these in the background via ffprobe.
    This endpoint surfaces the results so the renderer can hydrate its
    `_durationCache` + in-memory video objects and on-disk settings cache.

    Returns:
        { "<videoPath>": <durationSeconds>, ... }  —  only entries where
        a duration has been computed (duration > 0). Renderer uses the
        absence of an entry to know it still needs to wait.
    """
    out: dict[str, float] = {}
    for v in _video_registry.values():
        path = v.get("path")
        dur = v.get("duration") or 0
        if path and dur > 0:
            out[path] = dur
    return out


@router.get("/speed-stats")
async def get_speed_stats():
    """Return all computed avgSpeed/maxSpeed for the registered videos.

    The renderer's startup pass used to read every funscript itself
    over IPC, which dominated startup on big libraries (~30s for 962
    videos). The backend ALREADY computes these in the background via
    `_queue_speed_probes` after every register; this endpoint simply
    surfaces the results so the renderer can hydrate its in-memory
    video objects + on-disk cache without doing the work twice.

    Returns a map keyed by funscriptPath (matching the renderer's
    `library.speedStatsCache` shape) so it can be merged in directly:
        { "<funscriptPath>": { "avgSpeed": int, "maxSpeed": int } }

    Includes only entries where stats have actually been computed
    (avgSpeed != None) so the renderer can tell which ones still need
    waiting on. Cheap — pure dict scan.
    """
    out: dict[str, dict[str, int]] = {}
    for v in _video_registry.values():
        fs_path = v.get("funscriptPath")
        if not fs_path:
            continue
        if v.get("avgSpeed") is None:
            continue
        out[fs_path] = {
            "avgSpeed": int(v.get("avgSpeed") or 0),
            "maxSpeed": int(v.get("maxSpeed") or 0),
        }
    return out


@router.post("/register")
async def register_library(request: Request):
    """Register videos from a library scan (called by Electron main process).

    Also accepts collections/playlists/categories so the web remote can show
    the same groupings the desktop app does. Every field is independent:
    omit a key to leave that slice untouched on the backend. That lets the
    renderer push groupings FAST (in-memory, no filesystem work) ahead of
    the slower video scan — the phone can render Collections / Playlists /
    Categories tabs within ~100 ms of desktop startup instead of waiting
    for the scan to finish.
    """
    data = await request.json()
    if "videos" in data:
        register_videos(data.get("videos") or [])

    # Groupings — view-only on the phone, but they follow the desktop's
    # settings shape so no translation is needed.
    if "collections" in data:
        register_collections(data.get("collections") or [])
    if "playlists" in data:
        register_playlists(data.get("playlists") or [])
    if "categories" in data or "videoCategories" in data:
        register_categories(
            data.get("categories") or [],
            data.get("videoCategories") or {},
        )
    if "sources" in data:
        register_sources(data.get("sources") or [])

    thumb_dir = data.get("thumbCacheDir")
    if thumb_dir:
        set_thumb_cache_dir(thumb_dir)

    return {
        "registered": len(_video_registry),
        "collections": len(_collections),
        "playlists": len(_playlists),
        "categories": len(_categories),
    }


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
    """Stream a video file with HTTP Range request support.

    File reads run in a threadpool so they don't block the async event loop.
    Uses 512KB chunks for fast initial response on seeks.
    """
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

        import asyncio

        async def range_generator():
            chunk_size = 512 * 1024  # 512KB — faster first-byte for seeks
            loop = asyncio.get_event_loop()
            f = await loop.run_in_executor(None, open, filepath, "rb")
            try:
                await loop.run_in_executor(None, f.seek, start)
                remaining = content_length
                while remaining > 0:
                    read_size = min(chunk_size, remaining)
                    data = await loop.run_in_executor(None, f.read, read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data
            finally:
                await loop.run_in_executor(None, f.close)

        return StreamingResponse(
            range_generator(),
            status_code=206,
            media_type=content_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
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


# --- Subtitle Serving ---

@router.get("/subtitle/{video_id}")
async def get_subtitle(video_id: str):
    """Serve the subtitle file associated with a video."""
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    sub_path = video.get("subtitlePath")
    if not sub_path or not os.path.isfile(sub_path):
        raise HTTPException(status_code=404, detail="No subtitle for this video")

    ext = os.path.splitext(sub_path)[1].lower()

    # Convert SRT to WebVTT on-the-fly — HereSphere handles VTT seeks more reliably
    if ext == ".srt":
        try:
            with open(sub_path, "r", encoding="utf-8-sig") as f:
                srt_content = f.read()
            # SRT uses comma for ms separator, VTT uses dot.
            # `str.replace(old, new)` with no count argument already
            # replaces every occurrence — the `99999` cap was misleading.
            vtt = "WEBVTT\n\n" + srt_content.replace(",", ".")
            from starlette.responses import Response as RawResponse
            return RawResponse(
                content=vtt,
                media_type="text/vtt",
                headers={"Access-Control-Allow-Origin": "*",
                         "Content-Length": str(len(vtt.encode("utf-8")))},
            )
        except Exception:
            pass  # Fall through to serve raw file

    mime = "text/vtt" if ext == ".vtt" else "text/plain"
    return FileResponse(
        sub_path,
        media_type=mime,
        headers={"Access-Control-Allow-Origin": "*"},
    )


# --- Thumbnail Generation ---

@router.get("/thumb/{video_id}")
async def get_thumbnail(video_id: str):
    """Serve a thumbnail for a video (generated via ffmpeg, cached).

    Returns cached thumbnail immediately if available. If not cached,
    kicks off background generation and returns a 1x1 transparent placeholder
    so the request doesn't block (VR players will re-request on next load).
    """
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
                            headers={"Access-Control-Allow-Origin": "*",
                                     "Cache-Control": "public, max-age=86400"})

    # Not cached — generate in background, return placeholder now
    _queue_thumb_generation(video_id, filepath, thumb_path)

    # 1x1 transparent PNG placeholder (67 bytes)
    import base64
    PLACEHOLDER = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB"
        "Nl7BcQAAAABJRU5ErkJggg=="
    )
    from starlette.responses import Response
    return Response(content=PLACEHOLDER, media_type="image/png",
                    headers={"Access-Control-Allow-Origin": "*",
                             "Cache-Control": "no-cache"})


# Background thumbnail generation — limits concurrency to avoid thrashing I/O
_thumb_generating = set()
_thumb_semaphore = None


def _queue_thumb_generation(video_id, filepath, thumb_path):
    """Generate thumbnail in background thread (max 2 concurrent)."""
    global _thumb_semaphore
    if video_id in _thumb_generating:
        return
    if _thumb_semaphore is None:
        import threading
        _thumb_semaphore = threading.Semaphore(2)

    _thumb_generating.add(video_id)

    import threading
    def _generate():
        _thumb_semaphore.acquire()
        try:
            from services.ffmpeg import _find_binary, run_silent
            ffmpeg_path = _find_binary("ffmpeg")
            result = run_silent(
                [ffmpeg_path, "-i", filepath, "-ss", "25%", "-frames:v", "1",
                 "-q:v", "5", "-vf", "scale=320:-1", thumb_path, "-y"],
                capture_output=True, timeout=30,
            )
            if result.returncode != 0 or not os.path.isfile(thumb_path):
                run_silent(
                    [ffmpeg_path, "-i", filepath, "-ss", "5", "-frames:v", "1",
                     "-q:v", "5", "-vf", "scale=320:-1", thumb_path, "-y"],
                    capture_output=True, timeout=30,
                )
        except Exception:
            pass
        finally:
            _thumb_generating.discard(video_id)
            _thumb_semaphore.release()

    threading.Thread(target=_generate, daemon=True).start()
