"""Media streaming routes — serve video files and funscripts to VR headsets.

Supports HTTP Range requests for seeking in large VR video files (5-20GB).
Also serves funscript files and generates/caches thumbnails.
"""

import codecs
import hashlib
import mimetypes
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from typing import Optional
from urllib.parse import unquote, urljoin

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse, Response
from starlette.concurrency import run_in_threadpool

from routes.desktop_gate import DESKTOP_ONLY

router = APIRouter()

# Video ID → file path mapping (populated by scan)
_video_registry: dict[str, dict] = {}
# Bumps on every registration of the video list (the phone's tag-slice
# version includes it: /api/remote/tags answers per registered video).
_registry_gen = 0

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

# Phone-triggered rescan handshake. The web remote can only ever see the
# snapshot the desktop last pushed via /register — dropping a new file into a
# source folder registers nothing until the desktop rescans. Rather than add a
# filesystem watcher, the phone's Refresh button POSTs /api/remote/request-rescan
# which bumps this counter; the desktop polls /api/media/rescan-request and, when
# the counter advances, does a forced rescan + re-register. Monotonic so a
# missed poll still converges on the next tick.
_rescan_request_seq = 0


def bump_rescan_request() -> int:
    """Increment the rescan request counter (called by the phone) and return it."""
    global _rescan_request_seq
    _rescan_request_seq += 1
    return _rescan_request_seq


def get_rescan_request_seq() -> int:
    """Current rescan request counter (polled by the desktop renderer)."""
    return _rescan_request_seq


def set_thumb_cache_dir(path: str):
    """Set the thumbnail cache directory."""
    global _thumb_cache_dir
    _thumb_cache_dir = path
    os.makedirs(path, exist_ok=True)


def _ensure_thumb_cache_dir() -> str:
    """The thumbnail cache dir, falling back to a temp folder if none was set.

    main.py sets it from `--user-data-dir` at startup, which every Electron
    spawn passes. A backend started by hand without that flag would otherwise
    answer 500 for every thumbnail until a registration carried
    `thumbCacheDir` (V22); a missing setting is not a reason to fail a request
    that can be served.
    """
    if not _thumb_cache_dir:
        import tempfile
        set_thumb_cache_dir(os.path.join(tempfile.gettempdir(), "funsync_vr_thumbs"))
    return _thumb_cache_dir


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
    # Build off to the side and swap in one rebind.
    #
    # This used to clear the live dict and refill it in place. That was
    # safe only because the whole call ran on the event loop, so nothing
    # else could be served while the registry was half empty. Now that
    # registration runs in a threadpool (so `/health` keeps answering
    # during a scan) other requests genuinely do overlap it, and an
    # in-place rebuild would let `/stream`, `/thumbnail` and the VR
    # endpoints see a partially filled registry and 404 a video that is
    # perfectly fine. Rebinding the name is atomic, and every reader goes
    # through `get_video_registry()`, so a request either sees the entire
    # old registry or the entire new one.
    global _video_registry, _registry_gen
    old_registry = _video_registry
    new_registry: dict[str, dict] = {}
    for v in videos:
        vid_id = _path_to_id(v.get("path", ""))
        _carry_speed_stats(v, old_registry.get(vid_id))
        new_registry[vid_id] = v
    _video_registry = new_registry
    _registry_gen += 1
    # A script paired now that was not before is checked against the
    # metadata harvest again (a stat; a read only if it changed), so the
    # renderer's next "what changed" answer carries its record (P1 tags).
    def _paired(reg):
        return {e.get("funscriptPath") for e in reg.values() if isinstance(e, dict) and e.get("funscriptPath")}
    for newly_paired in _paired(new_registry) - _paired(old_registry):
        _meta_checked.pop(newly_paired, None)
    # New library → stats unknown so far are probed again (a script that
    # could not be read may be readable now). Except the ones a running pass
    # still holds for the same script: re-queuing those would run two passes
    # over them at once (FT-044/FT-045: an association change re-registers).
    _speed_probed.clear()
    _speed_probed.update(
        vid_id for vid_id, fs_path in list(_speed_probe_inflight)
        if (new_registry.get(vid_id) or {}).get("funscriptPath") == fs_path
    )

    _queue_duration_probes()
    _queue_speed_probes()


# --- Background duration probe ------------------------------------------
# Same concurrency-limited pattern as the thumbnail generator further
# down this file. We don't want 900 simultaneous ffprobe processes on a
# big library, but leaving durations at 0 until the desktop gets around
# to scrolling every card is too slow for the phone.

_duration_probing: set = set()   # video IDs currently being probed
_duration_semaphore = None
DURATION_PROBE_WORKERS = 2       # must match the Semaphore below


def _queue_duration_probes():
    """Queue background ffprobe jobs for every registered video missing a
    duration. Idempotent — a video already being probed is skipped.

    FIXED WORKER POOL, not thread-per-video. This used to spawn one OS
    thread for each pending video — 1466 threads on a full library scan,
    every one of them immediately parking on a Semaphore(2). They cost
    little to create but they all contend for the GIL for the entire
    length of the probe pass, which starves the asyncio event loop and
    stops `/health` answering. That is what made the "Backend is not
    responding" banner fire right after a scan on a healthy backend
    (2026-08-09 14:25, 25.8 s blackout). Two workers do the identical
    work at the identical rate — the Semaphore(2) already capped real
    concurrency at two, so the other 1464 threads were pure overhead.
    """
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
    if not pending:
        return
    for vid_id, _path in pending:
        _duration_probing.add(vid_id)

    for _ in range(min(DURATION_PROBE_WORKERS, len(pending))):
        threading.Thread(
            target=_duration_probe_worker, args=(pending,), daemon=True
        ).start()


def _duration_probe_worker(pending: list):
    """Drain the shared pending list. `list.pop()` is atomic under the GIL,
    so no extra lock is needed to hand work out between the workers."""
    while True:
        try:
            vid_id, filepath = pending.pop()
        except IndexError:
            return
        _probe_duration(vid_id, filepath)


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
import logging as _logging
from services import script_meta as _script_meta
_log = _logging.getLogger("funsync.media")
_speed_probed: set = set()   # video IDs already probed (success or fail)
_speed_probe_inflight: set = set()   # (video ID, funscript path) queued, not yet probed
# The funscript metadata harvest (P1 tags, 2026-11-18) rides the same pass:
# a script read for its speed is also handed to services/script_meta.py. A
# script whose speed the desktop already sent (its speedStatsCache) is not
# read for speed, so it is queued as a metadata-only item `(None, path)`:
# the pass stats it and reads it only when the harvest cache holds nothing
# for that exact size and mtime (once per changed file, not per launch).
# Every registration (a scan, a Refresh, a pairing) queues a stat of every
# paired script, so a script edited outside FunSync is read again on the next
# Refresh; an unchanged one is only stat'ed (r3-fixup, r3-verify area 2:
# it used to be checked once per process, and Refresh never saw an edit).
_meta_checked: dict = {}     # script path -> (size, mtime_ns) the harvest last checked, this process
_meta_inflight: set = set()  # script paths queued metadata-only, not yet checked


def _carry_speed_stats(new_entry: dict, old_entry):
    """Keep stats the probe already computed across a re-registration.

    The desktop re-registers the whole library on many edits (an association,
    a VR override, a backend restart), and it sends only the stats IT has
    polled so far. Without this, every value the probe had computed but the
    desktop had not picked up yet was dropped and parsed again. Only for the
    same script: a new association is a different file (FT-044/FT-045).
    """
    if not isinstance(new_entry, dict) or not isinstance(old_entry, dict):
        return
    if new_entry.get("avgSpeed") is not None or old_entry.get("avgSpeed") is None:
        return
    if not new_entry.get("funscriptPath") or new_entry.get("funscriptPath") != old_entry.get("funscriptPath"):
        return
    new_entry["avgSpeed"] = old_entry.get("avgSpeed")
    new_entry["maxSpeed"] = old_entry.get("maxSpeed")


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
    for vid_id, fs_path in pending:
        _speed_probed.add(vid_id)
        _speed_probe_inflight.add((vid_id, fs_path))

    # Metadata-only items, after the speed ones (the badges come first): every
    # associated script, for a stat (a read only when it changed), unless a
    # speed item (this pass or a running one) reads it anyway or it is
    # already queued.
    read_anyway = {p for _vid, p in list(_speed_probe_inflight)}   # list(): the worker discards meanwhile
    for v in _video_registry.values():
        fs_path = v.get("funscriptPath")
        if (not isinstance(fs_path, str) or not fs_path or fs_path in read_anyway
                or fs_path in _meta_inflight):
            continue
        _meta_inflight.add(fs_path)
        pending.append((None, fs_path))
    if not pending:
        return

    threading.Thread(
        target=_speed_probe_worker, args=(pending,), daemon=True
    ).start()


def _speed_probe_worker(pending: list):
    """Sequential loop — reads each funscript, computes speed stats, stores
    back on the registry entry.

    Yields the GIL between files. `json.load` does not release the GIL
    while it parses, and a big funscript (16 930 actions is normal) is
    tens of milliseconds of solid C loop. Back to back across 2318
    scripts that starves the asyncio event loop badly enough that
    `/health` misses its 3 s deadline and the app declares the backend
    dead. A 1 ms sleep every 25 files actually hands the GIL over
    (sleep(0) re-acquires too fast to help); across 2318 scripts that is
    ~0.09 s of added wall-clock on a pass that already takes tens of
    seconds.

    The same single read feeds the funscript metadata harvest
    (services/script_meta.py, P1 tags). An item `(None, path)` is
    metadata-only: the file is read only when the harvest cache has nothing
    for its size and mtime, and its speed is left alone. A file that cannot
    be read keeps its last harvested record (absence is never destructive).
    """
    import time as _time
    try:
        for i, (vid_id, fs_path) in enumerate(pending):
            if i % 25 == 24:
                _time.sleep(0.001)
            _probe_one_script(vid_id, fs_path)
    finally:
        _script_meta.save()


def _probe_one_script(vid_id, fs_path):
    """One item of `_speed_probe_worker`: speed (when `vid_id` is a video) and
    the metadata harvest (when the cache is not fresh for this file).

    The speed and the harvest each have their own try: the harvest is an
    extra and must never cost a video its speed stats (r3-fixup R3R-1: an
    odd string in the metadata block made the harvest raise BEFORE the
    speed was computed, and the video lost its speed badge for good)."""
    try:
        if not fs_path:
            return
        try:
            st = os.stat(fs_path)
        except OSError:
            return
        if not stat.S_ISREG(st.st_mode):
            return
        version = (st.st_size, st.st_mtime_ns)
        if vid_id is None and _meta_checked.get(fs_path) == version:
            return   # this exact file version was checked in this process: a stat, no read
        want_meta = not _script_meta.is_fresh(fs_path, st.st_size, st.st_mtime_ns)
        if not want_meta:
            # Up to date: no read for it, but a renderer that asks only for
            # what changed is sent it again when this process had not
            # checked this version yet (newly paired, or a restart).
            if _meta_checked.get(fs_path) != version:
                _script_meta.touch(fs_path)
            if vid_id is None:
                _meta_checked[fs_path] = version
                return
        # utf-8-sig: a funscript saved with a UTF-8 BOM (Notepad, some
        # editors) is valid JSON once the BOM is gone. Plain utf-8 made
        # json.load raise on it, so every BOM script got speed 0 (FT-044).
        with open(fs_path, encoding="utf-8-sig") as f:
            data = _json.load(f)
        if vid_id is not None:
            _apply_speed_stats(vid_id, fs_path, data)
        if want_meta:
            try:
                _script_meta.put(fs_path, st.st_size, st.st_mtime_ns, _script_meta.harvest_metadata(data))
            except Exception:  # noqa: BLE001 - keeps the last record; never touches the speed
                _log.warning("metadata harvest failed for %s", fs_path, exc_info=True)
        # Checked at this version (a failed harvest too: tried again when the
        # file changes or the backend restarts, not on every registration).
        _meta_checked[fs_path] = version
    except Exception:
        # The file could not be read or parsed. The harvest keeps the
        # script's last record and the version is not marked, so the next
        # registration tries again; the speed stays unknown (below).
        return
    finally:
        if vid_id is None:
            _meta_inflight.discard(fs_path)
        else:
            _speed_probe_inflight.discard((vid_id, fs_path))


def _apply_speed_stats(vid_id, fs_path, data):
    """The speed half of `_probe_one_script`, in its own try.

    Failure: leave the stats UNKNOWN (None). The video stays in
    `_speed_probed`, so this pass does not retry it, and /speed-stats leaves
    it out. Writing 0/0 here used to be read as a real "speed 0": the
    renderer cached it, sent it back on every register, and the probe never
    ran again (FT-044)."""
    try:
        stats = _compute_speed_stats(data.get("actions") or [])
    except Exception:  # noqa: BLE001 - not a funscript's shape: speed unknown
        return
    entry = _video_registry.get(vid_id)
    # Only onto the entry for THIS script: a re-registration since
    # this pass started may have given the video another one (an
    # association), and that one is probed on its own.
    if entry is not None and entry.get("funscriptPath") == fs_path:
        entry["avgSpeed"] = stats["avgSpeed"]
        entry["maxSpeed"] = stats["maxSpeed"]


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


# --- The phone's tag slice (P1 tags, 2026-11-18) ---------------------------
# The desktop merges every tag source once (renderer/js/video-tags.js
# effectiveTags, hidden tags already removed) and sends the result here as
# `videoTags` in /register: `{videoPath: [{key, facet, label}]}`. The phone's
# Tags filter reads it through /api/remote/tags and filters with its copy of
# the desktop's filter (web-remote/tag-filter.js). No merge logic lives here:
# this only checks shapes and caps sizes. View only, like the groupings.

TAG_FACETS = (
    "vr", "display", "length", "device", "axis", "script-type", "sexuality", "threesome",
    "content", "performer", "creator", "studio",
)
_TAG_FACET_SET = frozenset(TAG_FACETS)
# The names a video is found by: never the first to go when a list is cut.
NAME_FACETS = frozenset(("performer", "creator", "studio"))
# One cap on both sides (r3-fixup R3R-2): renderer/js/library-tag-filter.js
# applies the same MAX_TAGS_PER_VIDEO / MAX_TAG_KEY / MAX_TAG_LABEL to the
# desktop's own index (so the desktop's Tags filter and the phone's filter the
# same tags), with the same rule: names first, then the rest in facet order.
# The desktop's slice is already within them; here they are a junk guard.
# Pinned equal by tests/unit/tag-slice-parity.test.js.
MAX_TAGS_PER_VIDEO = 1000
MAX_TAG_KEY = 512
MAX_TAG_LABEL = 512
MAX_TAG_PATH = 4096
_TAG_SCAN = MAX_TAGS_PER_VIDEO * 4   # items looked at per video (a junk list stops here)

_video_tags: dict[str, list[dict]] = {}
_video_tags_seq = 0   # bumps when the slice changes; /api/remote/tags' version


def _text_ok(text) -> bool:
    """Text a JSON answer can carry: a string with no lone UTF-16 surrogate
    (`"\\ud83d"` decodes to one, and would make /api/remote/tags fail whole)."""
    if not isinstance(text, str):
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _clean_tag(item) -> "dict | None":
    if isinstance(item, str):
        item = {"key": item}
    if not isinstance(item, dict):
        return None
    key = item.get("key")
    if not _text_ok(key) or not key.strip() or len(key) > MAX_TAG_KEY:
        return None
    facet = item.get("facet")
    if not isinstance(facet, str) or facet not in _TAG_FACET_SET:
        prefix = key.split(":", 1)[0] if ":" in key else ""
        facet = prefix if prefix in _TAG_FACET_SET else "content"
    label = item.get("label")
    if not _text_ok(label) or not label.strip() or len(label) > MAX_TAG_LABEL:
        label = key.split(":", 1)[1] if ":" in key else key
    return {"key": key, "facet": facet, "label": label}


def cap_video_tags(tags: list) -> list:
    """At most MAX_TAGS_PER_VIDEO tags, the names (performer, creator,
    studio) kept first, then the rest in the order given (facet order);
    the kept ones stay in the order given. Same rule as the desktop's
    library-tag-filter.js capVideoTags."""
    if len(tags) <= MAX_TAGS_PER_VIDEO:
        return tags
    names = [i for i, t in enumerate(tags) if t.get("facet") in NAME_FACETS][:MAX_TAGS_PER_VIDEO]
    room = MAX_TAGS_PER_VIDEO - len(names)
    others = [i for i, t in enumerate(tags) if t.get("facet") not in NAME_FACETS][:room]
    keep = set(names) | set(others)
    return [t for i, t in enumerate(tags) if i in keep]


def register_tags(video_tags) -> None:
    """Replace the tag slice (a whole new map, swapped in one rebind like the
    registry). Anything that is not `{path: [tag, ...]}` is skipped; a video
    keeps each key once and at most MAX_TAGS_PER_VIDEO tags (names first,
    `cap_video_tags`). The version /api/remote/tags reports moves only when
    the slice changed."""
    global _video_tags, _video_tags_seq
    out: dict[str, list[dict]] = {}
    if isinstance(video_tags, dict):
        for path, tags in video_tags.items():
            if (not _text_ok(path) or not path or len(path) > MAX_TAG_PATH
                    or not isinstance(tags, list)):
                continue
            seen: set[str] = set()
            clean: list[dict] = []
            for item in tags[:_TAG_SCAN]:
                tag = _clean_tag(item)
                if tag is None or tag["key"] in seen:
                    continue
                seen.add(tag["key"])
                clean.append(tag)
            clean = cap_video_tags(clean)
            if clean:
                out[path] = clean
    if out != _video_tags:
        _video_tags_seq += 1
    _video_tags = out


def video_tags_seq() -> int:
    """Bumps each time register_tags changed the slice (this process)."""
    return _video_tags_seq


def get_video_tags() -> dict:
    """The last tag slice the desktop sent, `{videoPath: [{key, facet, label}]}`."""
    return _video_tags


def get_video_registry():
    """Return the current video registry."""
    return _video_registry


def registry_gen() -> int:
    """Bumps on every registration of the video list (this process)."""
    return _registry_gen


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


# A scene request is evidence that a headset is in use now, not for the rest
# of the backend's life. Without an expiry, one request (a Quest that has
# since left, or anything on the LAN fetching /deovr/{id}) had the renderer
# re-dialing that IP forever and showing the timestamp-server hint for it
# (V21). Long enough to cover fixing HereSphere's timestamp-server setting
# after a failed auto-connect; a dropped link that has worked is re-dialed by
# the renderer's own retry, which does not depend on this record.
VR_ACTIVITY_TTL_S = 300


@router.get("/vr-activity")
async def get_vr_activity():
    """Get the last VR scene request (polled by renderer for auto-connect).

    Reads as "no activity" once the request is older than VR_ACTIVITY_TTL_S.
    """
    import time
    ts = _vr_activity["timestamp"]
    if not ts or time.time() - ts > VR_ACTIVITY_TTL_S:
        return {"clientIp": None, "videoId": None, "timestamp": 0}
    return dict(_vr_activity)


@router.get("/rescan-request")
async def get_rescan_request():
    """Current phone-triggered rescan counter (polled by the desktop renderer).

    When this advances past the last value the renderer saw, the renderer
    forces a library rescan + re-register so newly-added files reach the phone.
    """
    return {"seq": get_rescan_request_seq()}


@router.post("/remux", dependencies=DESKTOP_ONLY)
def remux(
    video_path: str = Query(..., description="Absolute path to the source video"),
):
    """Repackage a non-browser-playable container (e.g. .mkv) into MP4 via
    ffmpeg stream-copy, so Chromium's <video> can play it. Result is cached
    on disk; repeat calls for the same file return instantly.

    Declared `def` (not `async def`) so FastAPI runs it in its threadpool —
    the ffmpeg subprocess is blocking and shouldn't stall the event loop.
    """
    from services import ffmpeg as ffmpeg_service
    try:
        return ffmpeg_service.remux_to_mp4(video_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ffmpeg_service.RemuxCodecError as e:
        # 422 + a kind the app reads: the codec itself is the problem, so it
        # names the codec and says to transcode (test day B027).
        raise HTTPException(status_code=422, detail={"kind": "codec", "codec": e.codec, "message": str(e)})
    except RuntimeError as e:
        # 422: the file exists but can't be made playable by remuxing
        # (unsupported video codec, or ffmpeg failed).
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/transcode", dependencies=DESKTOP_ONLY)
def transcode(
    video_path: str = Query(..., description="Absolute path to the source video"),
    cached_only: bool = Query(False, description="Only say whether a converted copy exists; start nothing"),
):
    """Convert to play (2026-11-26): start re-encoding a video whose codec the
    player cannot decode (MPEG-4 Part 2, MPEG-2, VC-1 ...) to H.264, or answer
    with the converted copy / the running job. The app polls /transcode/status.
    404: no file. 422 {kind: 'noEncoder'}: this ffmpeg cannot make H.264.
    `def`: ffprobe runs before the job starts."""
    from services import ffmpeg as ffmpeg_service
    try:
        return ffmpeg_service.transcode_start(video_path, cached_only=cached_only)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ffmpeg_service.TranscodeUnavailable as e:
        raise HTTPException(status_code=422, detail={"kind": "noEncoder", "message": str(e)})


@router.get("/transcode/status", dependencies=DESKTOP_ONLY)
def transcode_status(job: str = Query(..., description="The job id /transcode answered with")):
    """A conversion's state: running (with progress 0-1), done (with path),
    error, cancelled, or none."""
    from services import ffmpeg as ffmpeg_service
    return ffmpeg_service.transcode_status(job)


@router.post("/transcode/cancel", dependencies=DESKTOP_ONLY)
def transcode_cancel(job: str = Query(..., description="The job id /transcode answered with")):
    """Stop a conversion; nothing of it is kept."""
    from services import ffmpeg as ffmpeg_service
    return ffmpeg_service.transcode_cancel(job)


@router.get("/subtitle-tracks", dependencies=DESKTOP_ONLY)
def subtitle_tracks(
    video_path: str = Query(..., description="Absolute path to the video"),
):
    """The subtitle streams inside a video file (#268): index, codec,
    language, title, default / forced, and `text` (False: pictures, which
    the player cannot show). `def`, not `async def`: ffprobe blocks."""
    from services.ffmpeg import list_subtitle_streams
    try:
        return {"tracks": list_subtitle_streams(video_path)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/subtitle-track", dependencies=DESKTOP_ONLY)
def subtitle_track(
    video_path: str = Query(..., description="Absolute path to the video"),
    index: int = Query(..., ge=0, description="The file's stream index"),
):
    """One embedded text subtitle stream as WebVTT (#268). 404: no file or
    no such stream; 415: a picture stream (PGS / VobSub), which cannot be
    text; 422: ffmpeg could not read it."""
    from services.ffmpeg import extract_subtitle_vtt
    try:
        vtt = extract_subtitle_vtt(video_path, index)
    except (FileNotFoundError, LookupError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=415, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return Response(content=vtt, media_type="text/vtt; charset=utf-8")


# ---------------------------------------------------------------------------
# Remote video — paste a page URL, play the stream synced with a funscript.
#
# Flow: /resolve runs yt-dlp to turn a page URL into a signed stream URL +
# the headers it needs, stored server-side under a token. The renderer plays
# the returned proxy URL (hls.js for HLS, <video src> for progressive MP4);
# every byte is fetched by US with the right Referer/Cookie/UA (browser JS
# can't set those) and re-served with CORS. See SCOPE-remote-video-url.md.
# ---------------------------------------------------------------------------

# token -> {"streamUrl", "headers", "isHls"}. Bounded; oldest evicted.
_remote_streams: "dict[str, dict]" = {}
_REMOTE_MAX = 64   # a single-file stream adds a token per quality (2026-11-23)


@router.post("/resolve", dependencies=DESKTOP_ONLY)
def resolve_remote(url: str = Query(..., description="Web page URL to resolve"),
                   maxHeight: Optional[int] = Query(None, description="A single-file stream: the tallest file at or under this")):
    """Resolve a page URL to a playable stream via yt-dlp. `def` → threadpool
    (yt-dlp extraction blocks). Returns public metadata + a proxy URL; the
    signed upstream URL + headers are kept server-side under a token."""
    from services.resolver import resolve, ResolveError
    from services import video_downloader as vd
    try:
        # Hosts the downloader knows first (FapTap, PMVHaven, Pixeldrain, a
        # direct link: yt-dlp knows none of them), then yt-dlp (2026-11-22).
        try:
            own = vd.stream_source(url, max_height=maxHeight)
        except vd.DownloadError as e:
            raise ResolveError("unavailable" if e.code == "notFound" else "refused" if e.code == "denied" else "unsupported", str(e))
        info = own and {"duration": None, "thumbnail": None, "webpageUrl": url, "isLive": False, "height": None, **own}
        info = info or resolve(url, maxHeight)
    except ResolveError as e:
        # 422 + a category the UI can turn into a precise message.
        raise HTTPException(status_code=422, detail={"kind": e.kind, "message": str(e)})
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail={"kind": "error", "message": str(e)})

    token = secrets.token_urlsafe(12)
    _remote_streams[token] = {
        "streamUrl": info["streamUrl"],
        "headers": info.get("headers") or {},
        "isHls": info["isHls"],
    }
    # The other files of a single-file stream (its qualities, 2026-11-23): a
    # token each, played only when picked. A Rule34Video button link is
    # resolved to its CDN copy on its first play (remote_file).
    levels = []
    for alt in info.get("alternatives") or []:
        if alt.get("streamUrl") == info["streamUrl"]:
            levels.append({"height": alt.get("height"), "proxyUrl": f"/api/media/remote/{token}/file"})
            continue
        alt_token = secrets.token_urlsafe(12)
        _remote_streams[alt_token] = {
            "streamUrl": alt["streamUrl"],
            "headers": alt.get("headers") or info.get("headers") or {},
            "isHls": False,
            "lazyRedirect": bool(alt.get("lazyRedirect")),
        }
        levels.append({"height": alt.get("height"), "proxyUrl": f"/api/media/remote/{alt_token}/file"})
    levels.sort(key=lambda l: l.get("height") or 0, reverse=True)

    # Evict oldest entries so a long session doesn't grow unbounded.
    while len(_remote_streams) > _REMOTE_MAX:
        _remote_streams.pop(next(iter(_remote_streams)), None)

    proxy_url = (
        f"/api/media/remote/{token}/master.m3u8" if info["isHls"]
        else f"/api/media/remote/{token}/file"
    )
    return {
        "title": info["title"],
        "duration": info["duration"],
        "thumbnail": info["thumbnail"],
        "site": info["site"],
        "isHls": info["isHls"],
        "height": info.get("height"),
        "proxyUrl": proxy_url,
        "token": token,
        "levels": levels if len(levels) > 1 else [],
    }


async def _proxy_fetch(url: str, headers: dict, range_header: "str | None" = None):
    """Stream an upstream URL back to the client, forwarding Range and the
    stored signed headers. Returns a StreamingResponse mirroring the upstream
    status + content headers (so <video> Range seeking + hls.js both work)."""
    import httpx

    req_headers = {k: v for k, v in (headers or {}).items()}
    if range_header:
        req_headers["Range"] = range_header

    client = httpx.AsyncClient(follow_redirects=True, timeout=None)
    try:
        req = client.build_request("GET", url, headers=req_headers)
        resp = await client.send(req, stream=True)
    except Exception as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"upstream fetch failed: {e}")

    async def _body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    passthrough = {}
    for h in ("content-range", "content-length", "accept-ranges", "content-type"):
        if h in resp.headers:
            passthrough[h] = resp.headers[h]
    return StreamingResponse(
        _body(),
        status_code=resp.status_code,
        headers=passthrough,
        media_type=resp.headers.get("content-type"),
    )


@router.get("/remote/{token}/master.m3u8")
async def remote_master(token: str):
    """Fetch + rewrite the top-level HLS manifest for `token`."""
    entry = _remote_streams.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown stream token")
    return await _fetch_and_rewrite_manifest(entry["streamUrl"], entry["headers"], token)


@router.get("/remote/{token}/manifest")
async def remote_submanifest(token: str, u: str = Query(...)):
    """Fetch + rewrite a sub-playlist (variant / audio rendition)."""
    entry = _remote_streams.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown stream token")
    return await _fetch_and_rewrite_manifest(unquote(u), entry["headers"], token)


async def _fetch_and_rewrite_manifest(manifest_url: str, headers: dict, token: str):
    import httpx
    from services.hls_proxy import rewrite_manifest
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
            resp = await client.get(manifest_url, headers=headers or {})
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"manifest fetch failed: {e}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"manifest upstream {resp.status_code}")
    # str(resp.url) reflects redirects, so relative URIs resolve correctly.
    rewritten = rewrite_manifest(resp.text, str(resp.url), token)
    return Response(content=rewritten, media_type="application/vnd.apple.mpegurl")


@router.get("/remote/{token}/seg")
async def remote_segment(token: str, request: Request, u: str = Query(...)):
    """Stream an HLS media segment / key / init map for `token`."""
    entry = _remote_streams.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown stream token")
    return await _proxy_fetch(unquote(u), entry["headers"], request.headers.get("range"))


@router.get("/remote/{token}/file")
async def remote_file(token: str, request: Request):
    """Stream a progressive (non-HLS) remote video file with Range support."""
    entry = _remote_streams.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown stream token")
    if entry.get("lazyRedirect"):
        # A button link (Rule34Video): where it redirects, found once.
        import asyncio
        import httpx
        lock = entry.setdefault("_lock", asyncio.Lock())
        async with lock:
            if entry.get("lazyRedirect"):
                try:
                    async with httpx.AsyncClient(follow_redirects=False, timeout=20) as c:
                        r = await c.get(entry["streamUrl"], headers={**entry["headers"], "Range": "bytes=0-0"})
                        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                            entry["streamUrl"] = urljoin(entry["streamUrl"], r.headers["location"])
                except Exception:
                    pass  # the plain fetch below follows the redirect itself
                entry["lazyRedirect"] = False
    return await _proxy_fetch(entry["streamUrl"], entry["headers"], request.headers.get("range"))


@router.get("/video/{video_id}")
async def get_video_entry(video_id: str):
    """Look a registered video up by its id (V63).

    The URLs this server hands a headset name a video by id, never by file:
    `/api/media/stream/{id}` and `/heresphere/{id}` (`id` = md5(path)[:12]).
    When HereSphere reports one of those as the playing video's path, the
    desktop has no filename to match a script by, so it asks here. Exposes
    nothing new: `/api/remote/videos` already lists every path on this port.
    """
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return {"id": video_id, "name": video.get("name", ""), "path": video.get("path", "")}


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


MAX_SCRIPT_META_PATHS = 50


@router.get("/script-meta", dependencies=DESKTOP_ONLY)
async def get_script_meta(request: Request, since: int = 0, cache: "str | None" = None):
    """The funscript metadata harvest (P1 tags), for the desktop's tag engine.

    Without `path`: the harvested record of every script the registered
    library pairs, `{scriptPath: {metadata, readAt, topicId}}`. `metadata` is
    the file's own `metadata` block, capped (services/script_meta.py), and
    goes straight into renderer/js/video-tags.js `funscriptMetaRecord`; null
    means the file was read and has none. With `since` and the `cache` id of
    an earlier answer, only records stored after it (a backend restart starts
    a new id, and then everything is sent again).

    With `path` (repeatable, at most 50): those scripts' records. A path the
    library pairs is checked against its file first and read again only when
    it changed since (the video options dialog's on-demand read); any other
    path is answered from the cache only, never read.

    `pending` counts the scripts the background pass has still to check, so
    the renderer polls until it is 0. Nothing here deletes a record: a script
    that is missing or unreadable keeps the last one.
    """
    paths = request.query_params.getlist("path")
    return await run_in_threadpool(_script_meta_answer, paths, since, cache)


def _script_meta_answer(paths, since, cache):
    state = _script_meta.state()   # before reading: a later store is sent again, never skipped
    if cache != state["cacheId"] or not isinstance(since, int) or since < 0:
        since = 0
    paired = {
        v.get("funscriptPath") for v in _video_registry.values()
        if isinstance(v.get("funscriptPath"), str) and v.get("funscriptPath")
    }
    if paths:
        wanted = [p for p in paths[:MAX_SCRIPT_META_PATHS] if isinstance(p, str) and p]
        for p in wanted:
            if p in paired:
                try:
                    _script_meta.read_and_store(p)
                except Exception:  # noqa: BLE001 - that script keeps its last record (R3R-1)
                    _log.warning("on-demand script-meta read failed for %s", p, exc_info=True)
        records = _script_meta.records(wanted)
    else:
        records = _script_meta.records(paired, since=since)
    # list(): one C-level copy each, so the worker thread cannot change a set mid-count.
    pending = len(set(list(_meta_inflight)) | {p for _vid, p in list(_speed_probe_inflight)})
    return {
        "records": records,
        "pending": pending,
        "registered": len(_video_registry),
        "cacheId": state["cacheId"],
        "seq": state["seq"],
    }


@router.post("/register", dependencies=DESKTOP_ONLY)
async def register_library(request: Request):
    """Register videos from a library scan (called by Electron main process).

    DESKTOP ONLY (FT-009): a registration decides which files `/stream`
    serves, and where thumbnails and custom posters are read from. It used to
    take any path from any LAN host or web page, which made it a remote read
    of any file on the disk. See routes/desktop_gate.py.

    Also accepts collections/playlists/categories so the web remote can show
    the same groupings the desktop app does. Every field is independent:
    omit a key to leave that slice untouched on the backend. That lets the
    renderer push groupings FAST (in-memory, no filesystem work) ahead of
    the slower video scan — the phone can render Collections / Playlists /
    Categories tabs within ~100 ms of desktop startup instead of waiting
    for the scan to finish.
    """
    data = await request.json()
    await run_in_threadpool(_apply_registration, data)
    return {
        "registered": len(_video_registry),
        "collections": len(_collections),
        "playlists": len(_playlists),
        "categories": len(_categories),
    }


def _apply_registration(data: dict):
    """The body of `register_library`, off the event loop.

    Every one of these calls is synchronous filesystem/CPU work, and on a
    full library it is seconds of it. Run inline on an `async def` handler
    it blocks the loop, `/health` stops answering, and the desktop puts up
    "Backend is not responding" for a backend that is merely busy — which
    is precisely what a user sees after pressing Scan.
    """
    if "videos" in data:
        register_videos(data.get("videos") or [])
        # A Refresh / rescan is the user asking to look again: thumbnails
        # that failed are retried on their next poll (FT-085).
        _thumb_failed.clear()

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
    # The phone's Tags filter (P1): each video's merged tags, as the desktop
    # computed them. Sent on its own, only when a tag input changed.
    if "videoTags" in data:
        register_tags(data.get("videoTags"))

    thumb_dir = data.get("thumbCacheDir")
    if thumb_dir:
        set_thumb_cache_dir(thumb_dir)

    # Custom thumbnails (SCOPE-web-remote-2.md F7): pinned frames / uploaded
    # posters reach the phone too. Map is keyed by video PATH (matching the
    # desktop's `library.customThumbnails` shape); the dir is the desktop's
    # userData/custom-thumbs folder — image entries are served ONLY from
    # inside it (path-validated, same guard as the desktop IPC).
    global _custom_thumbs, _custom_thumbs_dir
    if "customThumbnails" in data:
        ct = data.get("customThumbnails")
        _custom_thumbs = ct if isinstance(ct, dict) else {}
    if data.get("customThumbsDir"):
        _custom_thumbs_dir = str(data["customThumbsDir"])


# --- Video Streaming ---

MIME_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    # The older formats the library lists since 2026-11-26 (Convert to play).
    ".wmv": "video/x-ms-wmv",
    ".asf": "video/x-ms-asf",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".vob": "video/mpeg",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".flv": "video/x-flv",
    ".f4v": "video/mp4",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
    ".ogv": "video/ogg",
    ".divx": "video/x-msvideo",
}


# One byte range: "bytes=N-M", "bytes=N-" or the suffix "bytes=-N" (the last
# N bytes). Range units compare case-insensitively (RFC 9110 14.1).
_SINGLE_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$", re.IGNORECASE)
_RANGE_UNSATISFIABLE = "unsatisfiable"


def _parse_byte_range(header: str, file_size: int):
    """Read a Range header against a file of ``file_size`` bytes (FT-083).

    Returns ``(start, end)`` (inclusive, end clamped to EOF) for a range to
    answer with a 206, ``_RANGE_UNSATISFIABLE`` for one that asks for nothing
    the file has (a 416), or ``None`` when the header is malformed or names
    several ranges: then the Range is ignored and the whole file is the
    answer (a 200), which RFC 9110 14.2 allows.

    The old parser split on "-": "bytes=-100" (the last 100 bytes) became
    0-100, and "bytes=999-0" or a start past EOF promised a negative
    Content-Length.
    """
    m = _SINGLE_RANGE_RE.match((header or "").strip())
    if not m:
        return None
    first, last = m.group(1), m.group(2)
    if first == "" and last == "":
        return None
    if first == "":
        suffix = int(last)
        if suffix == 0 or file_size == 0:
            return _RANGE_UNSATISFIABLE
        return (max(0, file_size - suffix), file_size - 1)
    start = int(first)
    if start >= file_size:
        return _RANGE_UNSATISFIABLE
    end = int(last) if last != "" else file_size - 1
    if end < start:
        return _RANGE_UNSATISFIABLE
    return (start, min(end, file_size - 1))


def _regular_file_size(path):
    """Size of the regular file at ``path``, or None when there is none (E-12).

    A stat, so a route on the event loop runs it in the threadpool: a stat on
    a spun-down USB drive or an offline network share can take seconds, and
    /health must keep answering meanwhile (a busy backend is not a dead one).
    """
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return None
    return st.st_size if stat.S_ISREG(st.st_mode) else None


def _read_whole_file(path):
    """A small file's bytes, or the status to answer instead (E-04).

    Returns ``(data, None)`` or ``(None, status)``: 404 when there is no
    regular file at ``path``, 403 when there is one this process may not
    read (denied, or held by another process). Reading it whole BEFORE the
    response starts is the point: a FileResponse promises a 200 and a
    Content-Length from a stat, then fails on the open, so a phone got a
    cut-off body and uvicorn logged ~80 lines of "Too little data for
    declared Content-Length" per request. Runs in the threadpool.
    """
    if not os.path.isfile(path):
        return None, 404
    try:
        with open(path, "rb") as f:
            return f.read(), None
    except PermissionError:
        return None, 403
    except (OSError, ValueError):
        return None, 404


def _read_text_sig(path):
    """A text file read whole as UTF-8 (BOM stripped); for the threadpool."""
    with open(path, "r", encoding="utf-8-sig") as f:
        return f.read()


def _readable_file_size(path):
    """``(size, None)`` for a regular file this process can open, else
    ``(None, status)``: 404 when there is none, 403 when it cannot be read.

    The video stream's E-04 (found while E-04, verify-2 2026-11-07; also in
    v0.9.2): the stat alone passes for a file with a deny ACL or one held by
    another process, so the response promised a 200 / 206 and a
    Content-Length, then failed on the open with the headers already out: a
    cut-off body and uvicorn's "Too little data for declared Content-Length".
    The open is tried here, before anything is sent. Runs in the threadpool.
    """
    size = _regular_file_size(path)
    if size is None:
        return None, 404
    try:
        with open(path, "rb"):
            pass
    except PermissionError:
        return None, 403
    except (OSError, ValueError):
        return None, 404
    return size, None


class _WholeFileResponse(FileResponse):
    """The whole file as a 200, whatever Range the request carried (FT-083).

    Starlette's FileResponse reads the request's Range header itself (a
    multipart 206 for several ranges, a 400 for a malformed one), so a Range
    `stream_video` has decided to ignore must not reach it.
    """

    async def __call__(self, scope, receive, send):
        headers = [(k, v) for (k, v) in scope.get("headers", []) if k.lower() != b"range"]
        await super().__call__({**scope, "headers": headers}, receive, send)


def _converted_copy_of(path: str) -> str | None:
    """The browser-playable copy the desktop made of `path`, when there is
    one: its converted copy (Convert to play), else its remuxed MP4 (H.264 in
    a .ts / .mkv the desktop played through the remux). Never raises: a
    missing original or any error answers None."""
    from services import ffmpeg as ffmpeg_service
    try:
        if not os.path.isfile(path):
            return None
        for out in (ffmpeg_service.transcode_out_path(path), ffmpeg_service.remux_out_path(path)):
            if os.path.isfile(out) and os.path.getsize(out) > 0:
                return out
        return None
    except OSError:
        return None


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
    # Convert to play (2026-11-26): when the desktop made an H.264 copy of a
    # video the browser cannot decode (WMV, MPEG-2, Xvid...), the phone and
    # the headset are served that copy; the original would only fail there.
    if filepath:
        copy = await run_in_threadpool(_converted_copy_of, filepath)
        if copy:
            filepath = copy
    # Off the event loop (E-12), and opened once before anything is sent:
    # see _readable_file_size.
    file_size, status = (
        await run_in_threadpool(_readable_file_size, filepath) if filepath else (None, 404)
    )
    if file_size is None:
        if status == 403:
            raise HTTPException(status_code=403, detail="This video cannot be read")
        raise HTTPException(status_code=404, detail="File not found on disk")

    ext = os.path.splitext(filepath)[1].lower()
    content_type = MIME_TYPES.get(ext, "application/octet-stream")

    # Parse Range header (FT-083): one range, a suffix, or ignored.
    range_header = request.headers.get("range")
    byte_range = _parse_byte_range(range_header, file_size) if range_header else None
    if byte_range == _RANGE_UNSATISFIABLE:
        return Response(
            status_code=416,
            headers={
                "Content-Range": f"bytes */{file_size}",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            },
        )
    if byte_range is not None:
        start, end = byte_range

        # An open-ended "bytes=X-" is answered to EOF, as nginx and every
        # other conventional file server does.
        #
        # TRIED AND REVERTED, 2026-08-21: capping the open form to a 16MB
        # window, to stop one seek pushing hundreds of MB at a phone over
        # Wi-Fi. It desynced audio from video on a real device — twice, once
        # with a mid-body disconnect check (which truncated a response that
        # had promised a Content-Length, and was a genuine bug) and again
        # with the window alone, on a file that had played correctly before.
        # The mechanism for the second one was never established; windowed
        # 206s are ordinary HTTP and the bytes were proven byte-identical to
        # the file on disk. Do not re-add it without a device to test on and
        # an explanation for that.
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
                    # NO is_disconnected() check here, deliberately.
                    #
                    # It was added on 2026-08-21 to stop an abandoned response
                    # pushing into a dead socket, and it broke audio/video sync
                    # within minutes: breaking out of the loop early ends the
                    # body BEFORE the Content-Length we already promised, so
                    # the client is left with a short read for a range it
                    # believes it has in full. A demuxer handed a truncated
                    # segment does not error — it drifts.
                    #
                    # Starlette already cancels this generator when the client
                    # goes away, which is the correct mechanism: it tears the
                    # response down rather than completing it with a lie.
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
                # no-store, NOT "public, max-age=3600".
                #
                # A cached 206 is a cached SLICE, keyed by URL, and the slice
                # boundaries depend on what the server chose to send. When the
                # 16MB window experiment above was reverted, phones were left
                # holding an hour of cached 16MB slices for a URL that now
                # answers with the whole remainder — seeks landed on stale,
                # differently-shaped entries and the player simply snapped
                # back to where it started (Dave, 2026-08-21).
                #
                # There is nothing to gain here either: the file is on a LAN
                # the client is already talking to, and a browser media cache
                # is the wrong place to put gigabytes of video.
                "Cache-Control": "no-store",
            },
        )
    else:
        # No range, or a malformed / multi-range one (ignored, FT-083) —
        # serve full file
        return _WholeFileResponse(
            filepath,
            media_type=content_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            },
        )


# --- Funscript Serving ---

@router.get("/script/{video_id}")
async def get_funscript(video_id: str, variant: str | None = None):
    """Serve the funscript associated with a video.

    `?variant=<label>` selects a specific variant from the video's
    `variants` list (Default / Soft / Vibe1 / etc.) — populated by the
    desktop's library scan in `electron/main.js`. Without the param the
    response is the video's primary funscript (`funscriptPath`), which
    matches the prior behaviour for single-variant videos and stays
    backward-compatible with the existing remote-side calls that don't
    know about variants yet.
    """
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    fs_path: str | None = None

    if variant:
        # Find the matching variant. Match is exact on `label` —
        # consistent with how the desktop dropdown picks them.
        for entry in video.get("variants") or []:
            if (entry.get("label") or "").strip() == variant:
                fs_path = entry.get("path")
                break
        if not fs_path:
            raise HTTPException(
                status_code=404,
                detail=f"Variant '{variant}' not found for this video",
            )
    else:
        fs_path = video.get("funscriptPath")

    if not fs_path:
        raise HTTPException(status_code=404, detail="No funscript for this video")

    # Read whole, off the event loop, before anything is promised (E-04,
    # E-12): an unreadable script is a 403, never a 200 with a cut-off body.
    data, status = await run_in_threadpool(_read_whole_file, fs_path)
    if data is None:
        if status == 403:
            raise HTTPException(status_code=403, detail="The funscript for this video cannot be read")
        raise HTTPException(status_code=404, detail="No funscript for this video")

    # A leading UTF-8 BOM is not JSON: the phone's res.json() drops it, but a
    # headset's parser (HereSphere, DeoVR) may not (FT-044 follow-up,
    # 2026-11-22). Every desktop read strips it too (stripBOM).
    if data.startswith(codecs.BOM_UTF8):
        data = data[len(codecs.BOM_UTF8):]

    return Response(
        content=data,
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
    if not sub_path:
        raise HTTPException(status_code=404, detail="No subtitle for this video")
    # Read whole, off the event loop (E-12), before anything is sent: an
    # unreadable subtitle is a 403, never a 200 with a cut-off body (as
    # E-04 for the script; found while E-04, also in v0.9.2).
    data, status = await run_in_threadpool(_read_whole_file, sub_path)
    if data is None:
        if status == 403:
            raise HTTPException(status_code=403, detail="The subtitle for this video cannot be read")
        raise HTTPException(status_code=404, detail="No subtitle for this video")

    ext = os.path.splitext(sub_path)[1].lower()

    # Convert SRT to WebVTT on-the-fly — HereSphere handles VTT seeks more reliably
    if ext == ".srt":
        try:
            srt_content = data.decode("utf-8-sig")
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
    return Response(
        content=data,
        media_type=mime,
        headers={"Access-Control-Allow-Origin": "*"},
    )


# --- Subtitles inside the file, by video id (#268, the phone, 2026-11-23) ---
# The phone asks for a registered video's own subtitle streams when it opens
# one with no subtitle file beside it. Keyed by id like /subtitle/{id} above:
# only a video the desktop registered, never a path, so they are open to the
# LAN as that route is. `def`, not `async def`: ffprobe / ffmpeg block.

_EMBEDDED_SUB_EXTS = (".mkv", ".mp4", ".m4v", ".mov", ".webm")


def _registered_video_path(video_id: str) -> str:
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return video.get("path") or ""


@router.get("/subtitle/{video_id}/tracks")
def get_embedded_subtitle_tracks(video_id: str):
    """A registered video's own subtitle streams (the same shape as the
    desktop's /subtitle-tracks). A file that cannot carry any: none."""
    path = _registered_video_path(video_id)
    if not path.lower().endswith(_EMBEDDED_SUB_EXTS):
        return {"tracks": []}
    from services.ffmpeg import list_subtitle_streams
    try:
        return {"tracks": list_subtitle_streams(path)}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No file for this video")


@router.get("/subtitle/{video_id}/track/{index}")
def get_embedded_subtitle_track(video_id: str, index: int):
    """One of a registered video's own text subtitle streams, as WebVTT.
    404: no file or no such stream; 415: pictures (PGS / VobSub); 422: ffmpeg
    could not read it."""
    if index < 0:
        raise HTTPException(status_code=422, detail="A stream index is 0 or more")
    path = _registered_video_path(video_id)
    if not path.lower().endswith(_EMBEDDED_SUB_EXTS):
        raise HTTPException(status_code=404, detail="No such subtitle stream")
    from services.ffmpeg import extract_subtitle_vtt
    try:
        vtt = extract_subtitle_vtt(path, index)
    except (FileNotFoundError, LookupError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=415, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return Response(content=vtt, media_type="text/vtt; charset=utf-8")


# --- Thumbnail Generation ---

# Custom thumbnail overrides pushed by the desktop at register time (F7).
_custom_thumbs: dict = {}
_custom_thumbs_dir: str | None = None

_IMAGE_MIME = {".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def _custom_thumb_for(filepath: str):
    """Return this video's custom-thumbnail entry, or None."""
    entry = _custom_thumbs.get(filepath)
    return entry if isinstance(entry, dict) else None


@router.get("/thumb/{video_id}")
async def get_thumbnail(video_id: str):
    """Serve a thumbnail for a video (generated via ffmpeg, cached).

    Returns cached thumbnail immediately if available. If not cached,
    kicks off background generation and returns a 1x1 transparent placeholder
    so the request doesn't block (VR players will re-request on next load).

    Custom thumbnails (F7): an uploaded poster image is served directly
    (path-validated inside the desktop's custom-thumbs dir); a pinned frame
    generates at the picked timestamp (frame-accurate) under a pin-keyed
    cache name so re-pins bust the phone's cached tile.
    """
    video = _video_registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    filepath = video.get("path", "")
    # Off the event loop (E-12): see _regular_file_size.
    if not filepath or not await run_in_threadpool(os.path.isfile, filepath):
        raise HTTPException(status_code=404, detail="File not found")

    thumb_cache_dir = _ensure_thumb_cache_dir()

    custom = _custom_thumb_for(filepath)

    # Uploaded poster image — serve the cached file itself.
    if custom and custom.get("type") == "image" and custom.get("imagePath") and _custom_thumbs_dir:
        img = os.path.abspath(str(custom["imagePath"]))
        root = os.path.abspath(_custom_thumbs_dir)
        # Untrusted path from a pushed payload — only serve from inside
        # the registered custom-thumbs dir; anything else falls through
        # to the normal auto-thumb path.
        if img.startswith(root + os.sep) and await run_in_threadpool(os.path.isfile, img):
            mime = _IMAGE_MIME.get(os.path.splitext(img)[1].lower(), "image/jpeg")
            return FileResponse(img, media_type=mime,
                                headers={"Access-Control-Allow-Origin": "*",
                                         "Cache-Control": "public, max-age=3600"})

    # Pinned frame — pin-keyed cache name so a re-pin regenerates.
    pin_pct = None
    if custom and isinstance(custom.get("seekPct"), (int, float)):
        pin_pct = min(0.999, max(0.0, float(custom["seekPct"])))

    thumb_name = f"{video_id}.jpg" if pin_pct is None else f"{video_id}_p{int(pin_pct * 1000):04d}.jpg"
    thumb_path = os.path.join(thumb_cache_dir, thumb_name)

    # Return cached thumbnail if it is a whole JPEG (FT-084). Off the event
    # loop: it reads the file's ends and stats the video (FT-085).
    state = await run_in_threadpool(_thumb_cache_lookup, thumb_path, thumb_name, filepath)
    if state == "hit":
        return FileResponse(thumb_path, media_type="image/jpeg",
                            headers={"Access-Control-Allow-Origin": "*",
                                     "Cache-Control": "public, max-age=86400"})

    # The frame the desktop's library already made for this video (R3-30,
    # TODO triage 2026-11-23): the background job below only copies it, so
    # a first phone visit showed each card blank for about a second and
    # asked again. Served now (a stat and a JPEG check, no ffmpeg); the job
    # still copies it into the phone's cache for next time.
    ready = await run_in_threadpool(_desktop_thumb_ready, filepath, pin_pct)
    if ready:
        _queue_thumb_generation(video_id, filepath, thumb_path, seek_pct=pin_pct)
        return FileResponse(ready, media_type="image/jpeg",
                            headers={"Access-Control-Allow-Origin": "*",
                                     "Cache-Control": "no-cache"})

    # No video stream (an audio file, N-05; also in v0.9.2): no frame will
    # ever come, and the 1x1 transparent placeholder below showed the
    # phone's and the headset's tile black. The app logo in grey instead,
    # once a generation has failed for that reason. `no-cache`, so a poster
    # the user uploads later is what the next request gets.
    if await run_in_threadpool(_no_video_known, filepath) and os.path.isfile(NO_VIDEO_THUMB):
        return FileResponse(NO_VIDEO_THUMB, media_type="image/png",
                            headers={"Access-Control-Allow-Origin": "*",
                                     "Cache-Control": "no-cache"})

    # Not cached — generate in background, return placeholder now. A video
    # whose thumbnail failed recently, unchanged since, gets the placeholder
    # without another ffmpeg run on every poll (FT-085).
    if state != "failed-recently":
        _queue_thumb_generation(video_id, filepath, thumb_path, seek_pct=pin_pct)

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

# Thumbnails that failed (FT-085): {thumb_name: (size, mtime_ns, monotonic)}
# of the video when it failed. `_thumb_generating` only dedupes a job in
# flight, so a file that always fails (corrupt, not really a video) spawned
# ffmpeg again on every poll of /thumb. While the video is unchanged and the
# failure is under THUMB_FAILURE_RETRY_SEC old, the placeholder is served
# without a new job. Cleared on success and on a library registration (a
# Refresh is the user asking to look again). Nothing is deleted for it.
_thumb_failed = {}
THUMB_FAILURE_RETRY_SEC = 600

# Files whose thumbnail failed because they have no video stream (N-05):
# {video path: (size, mtime_ns)} when it was found. Kept while the file is
# unchanged (a library registration does not clear it: the file did not
# change), and never written anywhere. The image is the web remote's own.
_thumb_no_video = {}
NO_VIDEO_THUMB = os.path.join(
    getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "web-remote", "icons", "no-video-thumb.png",
)


def _desktop_thumb_ready(filepath, seek_pct=None):
    """The thumbnail the desktop's generator already made for this video, at
    the size and place the phone's job would ask for (320 px; 10 %, or a
    pinned frame, exact), or None. Its cache key is path + size + mtime, so
    this is a stat and a whole-JPEG check: never an ffmpeg run."""
    import tempfile
    from services.ffmpeg import _get_video_hash, is_complete_jpeg
    try:
        video_hash = _get_video_hash(filepath)
    except OSError:
        return None
    pct = seek_pct if seek_pct is not None else 0.1
    marker = "v4e" if seek_pct is not None else "v4"
    path = os.path.join(tempfile.gettempdir(), "funsync_thumbs", video_hash,
                        f"single_{marker}_{int(pct * 1000):04d}_320.jpg")
    return path if os.path.isfile(path) and is_complete_jpeg(path) else None


def _no_video_known(filepath):
    """True when this file, unchanged since, was found to have no video stream."""
    sig = _thumb_no_video.get(filepath)
    return sig is not None and _video_signature(filepath) == sig


def _note_if_no_video(filepath):
    """After a failed thumbnail: remember the file when ffprobe (cached by
    then, the generator probed it first) finds audio and no video stream.
    A file ffprobe cannot read is not marked: it may be a broken video."""
    try:
        from services.ffmpeg import get_metadata
        meta = get_metadata(filepath)
    except Exception:
        return False
    if meta.get("width") or meta.get("height") or not (meta.get("duration") or 0) > 0:
        return False
    sig = _video_signature(filepath)
    if sig is None:
        return False
    _thumb_no_video[filepath] = sig
    return True


def _video_signature(filepath):
    try:
        st = os.stat(filepath)
        return (st.st_size, st.st_mtime_ns)
    except OSError:
        return None


def _thumb_cache_lookup(thumb_path, thumb_name, filepath):
    """'hit' (a whole cached JPEG), 'failed-recently' (FT-085) or 'miss'.

    A cached file that is not a whole JPEG (cut off by a killed copy or
    ffmpeg run) is the backend's own cache output: it is removed and the
    thumbnail generated again (FT-084).
    """
    from services.ffmpeg import is_complete_jpeg, _safe_unlink
    if os.path.isfile(thumb_path):
        if is_complete_jpeg(thumb_path):
            return "hit"
        _safe_unlink(thumb_path)
    failed = _thumb_failed.get(thumb_name)
    if failed:
        size, mtime_ns, at = failed
        if (time.monotonic() - at < THUMB_FAILURE_RETRY_SEC
                and _video_signature(filepath) == (size, mtime_ns)):
            return "failed-recently"
    return "miss"


def _queue_thumb_generation(video_id, filepath, thumb_path, seek_pct=None):
    """Generate thumbnail in background thread (max 2 concurrent).
    `seek_pct` set = a user-pinned frame (F7) → frame-accurate `exact`
    generation at that timestamp; None = the default auto-thumb path."""
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
            # Reuse the desktop library's thumbnail generator instead of a
            # bespoke ffmpeg command. It seeks past studio-ident / fade-in
            # windows (max(10s, 10%)), uses the fast `-skip_frame nokey`
            # decode, and caches on disk by content hash. The old inline
            # command here used `-ss 25%` (ffmpeg can't parse a percentage
            # for -ss) with a `-ss 5` fallback that landed squarely in the
            # black intro of most videos → black thumbnails on the phone.
            from services.ffmpeg import generate_single_thumbnail, _safe_unlink
            import shutil
            result = (
                generate_single_thumbnail(filepath, seek_pct=seek_pct, width=320, exact=True)
                if seek_pct is not None
                else generate_single_thumbnail(filepath, seek_pct=0.1, width=320)
            )
            src = result.get("path") if result else None
            if src and os.path.isfile(src) and os.path.abspath(src) != os.path.abspath(thumb_path):
                # Copy to a temp name and rename, so a copy cut short never
                # sits at the cache name (FT-084).
                tmp = f"{thumb_path}.part-{os.getpid()}-{threading.get_ident()}"
                try:
                    shutil.copyfile(src, tmp)
                    os.replace(tmp, thumb_path)
                finally:
                    _safe_unlink(tmp)
            _thumb_failed.pop(os.path.basename(thumb_path), None)
        except Exception as err:
            # Was a bare `pass`: a VR / phone thumbnail that failed left no
            # trace in main.log (FT-084). "WARNING:" first, so python-bridge
            # logs it at warn (FT-042). One line, the end of the reason.
            detail = " ".join(str(err).split())[-400:] or type(err).__name__
            print(f"WARNING: [Thumb] background thumbnail failed for {video_id}: {detail}", flush=True)
            sig = _video_signature(filepath)
            if sig is not None:
                _thumb_failed[os.path.basename(thumb_path)] = (*sig, time.monotonic())
            # An audio file: its next request gets the logo tile (N-05).
            _note_if_no_video(filepath)
        finally:
            _thumb_generating.discard(video_id)
            _thumb_semaphore.release()

    threading.Thread(target=_generate, daemon=True).start()
