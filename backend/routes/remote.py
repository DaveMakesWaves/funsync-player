"""Web remote routes — phone-friendly library listing.

The SPA itself lives in `backend/web-remote/` and is served via a
`StaticFiles` mount on `/remote/` (wired up in `main.py`). This module
exposes the JSON endpoints the SPA calls: the flat video list plus the
read-only collection/playlist/category groupings.

The heavy lifting (video streaming with Range support, funscript and
subtitle serving, ffmpeg thumbnails) is already handled by the existing
`media.py` routes. The remote SPA points at those same URLs — no
duplication.
"""

import os
import uuid

from fastapi import APIRouter, Body

from routes.media import (
    get_video_registry,
    get_collections,
    get_playlists,
    get_categories,
    get_video_categories,
    get_sources,
    bump_rescan_request,
    _path_to_id,
)

router = APIRouter()

# Changes on every app start, appended to the stream URLs the remote uses.
#
# A phone that cached partial responses from a previous run cannot be reached
# by a server-side header change — the entries are already on the device. A
# fresh URL per boot sidesteps them without asking the user to find a "clear
# website data" button on a phone (Dave, 2026-08-21).
_BOOT_TOKEN = uuid.uuid4().hex[:8]


@router.post("/seek-timing")
async def seek_timing(payload: dict = Body(default={})):
    """Record one seek from the web remote, for diagnosis.

    The desktop cannot see the phone's side of a seek, and that is where the
    answer lives: whether the wait was for BYTES (a buffer miss, so network or
    range serving) or for the round trip. The 2026-08-18 stall fix needed wire
    captures for exactly this reason. One small POST per seek puts the numbers
    in main.log instead, where Dave already looks.

    Deliberately print(), not a logger: backend stdout is forwarded into
    main.log with a [Backend] prefix, which is the same path uvicorn's own
    access lines take.
    """
    def _num(key, default=-1.0):
        try:
            return float(payload.get(key, default))
        except (TypeError, ValueError):
            return default

    to_s = _num("to")
    from_s = _num("from")
    seeked_ms = _num("seekedMs")
    playing_ms = _num("playingMs")
    buffered = "hit" if payload.get("buffered") else "miss"
    delta = to_s - from_s if to_s >= 0 and from_s >= 0 else 0.0
    kind = str(payload.get("kind", "?"))[:16]

    print(
        f"[remote-seek] {kind} to={to_s:.1f}s d={delta:+.1f}s buffered={buffered} "
        f"seeked={seeked_ms:.0f}ms playing={playing_ms:.0f}ms",
        flush=True,
    )
    return {"ok": True}


@router.post("/request-rescan")
async def request_rescan():
    """Ask the desktop to rescan its source folders and re-register videos.

    The phone can only see the snapshot the desktop last pushed, so a file the
    user just dropped into a source folder is invisible until the desktop
    rescans. The Refresh button on the web remote calls this; the desktop polls
    the counter (via /api/media/rescan-request) and rescans when it advances.
    Returns the new counter so the phone could correlate if it wanted to.
    """
    return {"seq": bump_rescan_request()}


@router.get("/videos")
async def list_videos():
    """Return every registered video in a phone-friendly JSON shape.

    URLs are returned as relative paths so the phone resolves them against
    whatever origin it reached the backend on (LAN IP, mDNS, reverse proxy).
    """
    registry = get_video_registry()
    out = []
    for vid_id, v in registry.items():
        name = v.get("name", "")
        stem = os.path.splitext(name)[0] or name
        # Surface script variants (`<base> (Soft).funscript`, `<base>.intense
        # .funscript`, etc.) the desktop already detected during library
        # scan. Empty list when the video has 0 or 1 variant — the phone
        # treats that as "no variant chip needed" so single-script videos
        # render exactly as before. Each variant exposes a fetchable
        # `scriptUrl` so the phone can render mini-heatmap previews per
        # variant in the expanded list.
        variants_raw = v.get("variants") or []
        variants_out = []
        for variant in variants_raw:
            label = (variant.get("label") or "").strip()
            if not label:
                continue
            variants_out.append({
                "label": label,
                "scriptUrl": f"/api/media/script/{vid_id}?variant={label}",
            })

        out.append({
            "id": vid_id,
            "name": stem,
            # Absolute path — needed by the phone's folder-browse tree
            # builder. Only exposed on the LAN port where the user has
            # already allowed their video library to be streamed, so no
            # new attack surface.
            "path": v.get("path") or "",
            "hasFunscript": bool(v.get("funscriptPath")),
            "hasSubtitle": bool(v.get("subtitlePath")),
            "duration": v.get("duration") or 0,
            # Speed stats in units/s (0-999 typical). Null = not yet probed;
            # phone treats null same as 0 but can keep polling. 0 = probe
            # ran and the script was empty/unreadable.
            "avgSpeed": v.get("avgSpeed"),
            "maxSpeed": v.get("maxSpeed"),
            # File mtime in ms (populated by the Electron scan). Lets the
            # phone sort by "recently added" without needing its own stat
            # access. Missing → 0, sorts to the "oldest" end.
            "dateAdded": v.get("dateAdded") or 0,
            "sourceName": v.get("sourceName") or "Library",
            "streamUrl": f"/api/media/stream/{vid_id}?v={_BOOT_TOKEN}",
            "scriptUrl": f"/api/media/script/{vid_id}" if v.get("funscriptPath") else None,
            "subtitleUrl": f"/api/media/subtitle/{vid_id}" if v.get("subtitlePath") else None,
            "thumbUrl": f"/api/media/thumb/{vid_id}",
            "variants": variants_out,
            # Manual VR override (`'vr'` or `'flat'`); absent / null = use the
            # filename heuristic. The phone-side `vr-detect.js` consults its
            # override store before the heuristic so the VR filter agrees with
            # the desktop.
            "manualVRType": v.get("manualVRType") or None,
        })
    out.sort(key=lambda v: v["name"].lower())
    return {"videos": out}


def _video_ids_from_paths(paths: list[str]) -> list[str]:
    """Convert a list of absolute file paths into their registered video IDs.

    Paths that aren't in the registry (disconnected source, deleted file)
    are silently dropped — same "view only" behaviour the desktop has when
    a playlist references a missing file.
    """
    registry = get_video_registry()
    out = []
    for p in paths or []:
        if not p:
            continue
        vid_id = _path_to_id(p)
        if vid_id in registry:
            out.append(vid_id)
    return out


def _total_duration(video_ids: list[str]) -> float:
    """Sum the duration (seconds) of the given registered videos.

    Silently ignores IDs missing a duration (not all videos have been
    probed by ffprobe yet when the phone polls). Returns 0 for an empty
    list so clients can treat missing duration the same as "zero".
    """
    registry = get_video_registry()
    total = 0.0
    for vid_id in video_ids:
        v = registry.get(vid_id)
        if not v:
            continue
        dur = v.get("duration") or 0
        try:
            total += float(dur)
        except (TypeError, ValueError):
            continue
    return total


@router.get("/sources")
async def list_sources():
    """Return the enabled library source folders the phone can use to seed
    its folder-browse tree. {id, name, path} per source."""
    out = []
    for s in get_sources():
        out.append({
            "id": s.get("id"),
            "name": s.get("name") or "",
            "path": s.get("path") or "",
        })
    out.sort(key=lambda s: (s["name"] or "").lower())
    return {"sources": out}


@router.get("/collections")
async def list_collections():
    """Return every collection with its video IDs (view-only).

    The desktop shape stores `videoPaths` as absolute file paths; we
    convert to the registry IDs the phone already uses so the client
    doesn't need to know about file paths at all.
    """
    out = []
    for c in get_collections():
        video_ids = _video_ids_from_paths(c.get("videoPaths") or [])
        out.append({
            "id": c.get("id"),
            "name": c.get("name") or "(unnamed)",
            "videoCount": len(video_ids),
            "totalDuration": _total_duration(video_ids),
            "videoIds": video_ids,
        })
    out.sort(key=lambda c: (c["name"] or "").lower())
    return {"collections": out}


@router.get("/playlists")
async def list_playlists():
    """Return every playlist with its video IDs (view-only)."""
    out = []
    for p in get_playlists():
        video_ids = _video_ids_from_paths(p.get("videoPaths") or [])
        out.append({
            "id": p.get("id"),
            "name": p.get("name") or "(unnamed)",
            "videoCount": len(video_ids),
            "totalDuration": _total_duration(video_ids),
            "videoIds": video_ids,
            "createdAt": p.get("createdAt") or 0,
        })
    out.sort(key=lambda p: (p["name"] or "").lower())
    return {"playlists": out}


@router.get("/categories")
async def list_categories():
    """Return every category with its colour + video IDs (view-only).

    Categories are stored as `{id, name, color}` in settings, and the
    videoPath→[categoryId] mapping lives in a separate table. We invert
    it server-side so the phone gets a single hop: category → videoIds.
    """
    # Build categoryId → set(videoPath) from the flat video-categories map
    inverted: dict[str, list[str]] = {}
    for video_path, cat_ids in get_video_categories().items():
        for cat_id in cat_ids or []:
            inverted.setdefault(cat_id, []).append(video_path)

    out = []
    for c in get_categories():
        paths = inverted.get(c.get("id"), [])
        video_ids = _video_ids_from_paths(paths)
        out.append({
            "id": c.get("id"),
            "name": c.get("name") or "(unnamed)",
            "color": c.get("color") or "#888",
            "videoCount": len(video_ids),
            "totalDuration": _total_duration(video_ids),
            "videoIds": video_ids,
        })
    out.sort(key=lambda c: (c["name"] or "").lower())
    return {"categories": out}
