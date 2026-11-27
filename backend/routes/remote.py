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
from urllib.parse import quote

from fastapi import APIRouter, Body, Query

from routes.media import (
    get_video_registry,
    get_collections,
    get_playlists,
    get_categories,
    get_video_categories,
    get_sources,
    get_video_tags,
    video_tags_seq,
    registry_gen,
    bump_rescan_request,
    TAG_FACETS,
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

# The library scan's label for a script with no label of its own. Data only:
# it is never shown (FN-03); renderer/js/variant-names.js has the same rule.
_UNLABELLED_VARIANT = "Default"


def _variant_text(variant: dict, label: str) -> str:
    """The name the phone shows for one variation (FN-03).

    The desktop sends it (`text`, the name its own menu shows). A registry
    filled by an older desktop has none: then the label, or for the scan's
    unlabelled script its file name without `.funscript`.
    """
    text = str(variant.get("text") or "").strip()
    if text:
        return text
    if label != _UNLABELLED_VARIANT:
        return label
    file_name = str(variant.get("name") or "").strip() or os.path.basename(
        str(variant.get("path") or "").replace("\\", "/"))
    stem = file_name[:-len(".funscript")] if file_name.lower().endswith(".funscript") else file_name
    return stem.strip() or label


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
        #
        # FN-04 (2026-11-16): the desktop sends the list its menu shows, the
        # hand-added variations included, in its order, and with each entry
        # the name it shows (`text`, FN-03: an unlabelled script by its file,
        # never "Default") and whether it is the script the video opens on
        # (`main`). `label` stays what a switch matches on. The label is
        # URL-quoted: a hand-added name is free text ("Soft & Slow", "A+B").
        variants_raw = v.get("variants") or []
        variants_out = []
        for variant in variants_raw:
            label = (variant.get("label") or "").strip()
            if not label:
                continue
            variants_out.append({
                "label": label,
                "text": _variant_text(variant, label),
                "main": bool(variant.get("main")),
                "scriptUrl": f"/api/media/script/{vid_id}?variant={quote(label, safe='')}",
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
            # The desktop's saved spherical VR format for the phone's Flat
            # view (#426): projection, eye, fov, yaw, pitch, roll; absent when
            # none is saved (the phone then uses Equirectangular 180, left eye).
            "vrFormat": v.get("vrFormat") if isinstance(v.get("vrFormat"), dict) else None,
            # Disabled on the desktop (zaikechi #381): shown dimmed, never in
            # the phone's Play all, Shuffle or Up Next.
            "disabled": v.get("disabled") is True,
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


def tags_version() -> str:
    """What /tags answers from: this process (the boot token), the slice the
    desktop last sent and the registered video list. Any of them moving
    moves it."""
    return f"{_BOOT_TOKEN}.{video_tags_seq()}.{registry_gen()}"


@router.get("/tags")
async def list_tags(version: "str | None" = Query(None)):
    """The phone's Tags filter (P1 tags, 2026-11-18): view only.

    `version` (r3-fixup R3R-4): the phone asks again each time its filter
    sheet opens, passing the version of the answer it holds. While nothing
    changed the answer is just `{"version": v, "unchanged": true}` (a few
    bytes, no slice), so a tag the desktop added, hid or harvested since
    reaches the phone at the next sheet open without a polling loop.

    `videoTags` is `{videoPath: [key, ...]}` for the registered videos, the
    keys the desktop's own merge gave each one (hidden tags already removed),
    for the phone's copy of the desktop filter (web-remote/tag-filter.js).
    `tags` lists each key once, `{key, facet, label, count}`, with the label
    the desktop shows and how many registered videos have it, for the filter
    sheet's groups. Facet names and the length unit are translated on the
    phone, from the shared locale bundles. Paths the registry does not hold
    (a stale slice, a source gone offline) are left out. Nothing here is
    searched: library search does not match tags (Dave, 2026-11-17).
    """
    current = tags_version()
    if version is not None and version == current:
        return {"version": current, "unchanged": True}
    registry = get_video_registry()
    registered = {v.get("path") for v in registry.values() if v.get("path")}
    facet_rank = {f: i for i, f in enumerate(TAG_FACETS)}
    video_tags: dict[str, list[str]] = {}
    catalog: dict[str, dict] = {}
    for path, tags in get_video_tags().items():
        if path not in registered:
            continue
        keys = []
        for tag in tags:
            key = tag["key"]
            keys.append(key)
            known = catalog.get(key)
            if known:
                known["count"] += 1
            else:
                catalog[key] = {"key": key, "facet": tag["facet"], "label": tag["label"], "count": 1}
        if keys:
            video_tags[path] = keys
    ordered = sorted(
        catalog.values(),
        key=lambda t: (facet_rank.get(t["facet"], len(TAG_FACETS)), t["label"].casefold(), t["key"]),
    )
    return {"videoTags": video_tags, "tags": ordered, "version": current}
