"""Video downloads for the EroScripts tab (2026-11-22; scope in
notes/features/SCOPE-eroscripts-tab.md).

A forum post links its video somewhere: a file host the script maker uploaded
to, or a tube site. This module turns such a link into a file in a folder the
user chose, in the background, with progress, one job per video.

Hosts:
  - pixeldrain   (own code: its public API; a list takes its largest video)
  - mega         (own code: a public FILE link; the file is AES-CTR encrypted
                  with the key after '#', decrypted while it downloads)
  - direct       (a URL that is itself a video file)
  - gofile, yandex disk (yt-dlp's extractors: they keep up with the hosts)
  - tube sites   (yt-dlp, only when the caller allows it: experimental, may be
                  left out of a public release)

Safety: the destination must be an existing absolute folder; the name is
cleaned; a file is written as `<name>.part` and renamed when whole; nothing
is ever overwritten (" (1)" instead). The routes that drive this answer only
the desktop app (routes/downloads.py, DESKTOP_ONLY).
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import struct
import threading
import time
import uuid
from typing import Any, Callable, Optional
from html import unescape as html_unescape
from urllib.parse import urljoin, urlparse

import httpx

VIDEO_EXTS = (".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".wmv")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
CHUNK = 1024 * 1024
MAX_PARALLEL = 2
# yt-dlp extractors that are FILE hosts (allowed without the tube opt-in).
YTDLP_FILE_HOSTS = {"YandexDisk": "yandex"}
# Gofile (2026-11): its API now wants a token made by an obfuscated script on
# its own page (wt.obf.js); yt-dlp's Gofile extractor fails with 401 too. Not
# worked around (that would be defeating its anti-automation): shown, opened
# in the browser.
# Where paid scripts are sold (Dave, 2026-11-22: "there's no attached script because
# this is a paid script which is why you're getting the payhip link").
SCRIPT_SHOPS = {"payhip.com", "patreon.com", "gumroad.com", "ko-fi.com", "subscribestar.adult", "subscribestar.com"}
_GOFILE_RE = re.compile(r"^https?://(?:www\.)?gofile\.io/d/", re.I)
# One progressive file where the site offers it (no merge step), at most 1080p.
YTDLP_FORMAT = "b[ext=mp4][height<=1080]/b[height<=1080]/bv*[height<=1080]+ba/b"


class DownloadError(Exception):
    """A failure with a short code the UI words (unsupported, notFound, ...)."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class Cancelled(Exception):
    pass


class Paused(Cancelled):
    """Stopped by Pause: the partial file is kept for Resume."""


# Never fill a disk to the last byte: a download needs its size plus this.
SPACE_MARGIN = 200 * 1024 * 1024


def free_space(path: str) -> Optional[int]:
    """Bytes free on the disk holding `path`, or None when it cannot be told."""
    try:
        import shutil
        return shutil.disk_usage(path).free
    except OSError:
        return None


def check_space(dest_dir: str, need: int):
    """Raise noSpace when `need` bytes (plus a margin) will not fit."""
    if need <= 0:
        return
    free = free_space(dest_dir)
    if free is not None and free < need + SPACE_MARGIN:
        raise DownloadError("noSpace", f"{need} bytes needed, {free} free")


# --- links --------------------------------------------------------------------

_PIXELDRAIN_RE = re.compile(r"^https?://(?:www\.)?(?:pixeldrain\.(?:com|net)|pixeldra\.in)/(u|l|api/file)/([A-Za-z0-9]+)", re.I)
_MEGA_FILE_RE = re.compile(r"^https?://(?:www\.)?mega\.(?:nz|co\.nz|io)/(?:file/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]{43})|#!([A-Za-z0-9_-]{8})!([A-Za-z0-9_-]{43}))", re.I)
_MEGA_FOLDER_RE = re.compile(r"^https?://(?:www\.)?mega\.(?:nz|co\.nz|io)/(?:folder/|#F!)", re.I)
# A public folder: its id, its 128-bit key, and a file or sub-folder inside it
# the link points at (".../folder/ID#KEY/file/NODE" or the old "#F!ID!KEY!NODE").
_MEGA_FOLDER_PARTS_RE = re.compile(
    r"^https?://(?:www\.)?mega\.(?:nz|co\.nz|io)/(?:folder/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]{22})(?:/(?:file|folder)/([A-Za-z0-9_-]{8}))?"
    r"|#F!([A-Za-z0-9_-]{8})!([A-Za-z0-9_-]{22})(?:!([A-Za-z0-9_-]{8}))?)", re.I)
# The two sites script makers put their videos on (Dave, 2026-11-22: "add
# pmvhaven and faptap support"). Both serve the video openly: PMVHaven's page
# carries the MP4's address, FapTap's video is the HLS stream its own player
# plays (a Bunny CDN, found from the page's og:image).
_PMVHAVEN_RE = re.compile(r"^https?://(?:www\.)?pmvhaven\.com/video/[^?#]*?([0-9a-f]{24})(?:[/?#]|$)", re.I)
_FAPTAP_RE = re.compile(r"^https?://(?:www\.)?faptap\.net/v/(\d+)", re.I)
# EroSync (2026-11-22: a script post embeds its video from erosync.net): the
# embed and the video page carry the same id.
_EROSYNC_RE = re.compile(r"^https?://(?:www[.])?erosync[.]net/(?:embed|videos?)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.I)
_RULE34VIDEO_RE = re.compile(r"^https?://(?:www\.)?rule34video\.(?:com|party)/video/(\d+)", re.I)


def _ytdlp_extractor_for(url: str) -> Optional[str]:
    """The yt-dlp extractor that claims `url` (not the generic one), or None."""
    try:
        from yt_dlp.extractor import gen_extractor_classes
    except Exception:  # pragma: no cover - yt-dlp is a dependency
        return None
    for ie in gen_extractor_classes():
        key = ie.ie_key()
        if key == "Generic":
            continue
        try:
            if ie.suitable(url):
                return key
        except Exception:
            continue
    return None


_GOFILE_LINK_RE = re.compile(r"^https://[a-z0-9-]+.gofile.io/", re.I)
_GOFILE_COOKIE_RE = re.compile(r"^accountToken=[A-Za-z0-9]{8,128}$")


def gofile_resolved(resolved) -> Optional[dict]:
    """The app's answer for a Gofile link, checked: {link, name, size, cookie}
    with the link on a gofile.io host over https and the guest cookie only;
    else None (the backend never fetches anything else with it)."""
    if not isinstance(resolved, dict):
        return None
    link = str(resolved.get("link") or "")
    cookie = str(resolved.get("cookie") or "")
    name = str(resolved.get("name") or "")[:300]
    try:
        size = int(resolved.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if not _GOFILE_LINK_RE.match(link) or not _GOFILE_COOKIE_RE.match(cookie) or len(link) > 2048:
        return None
    return {"link": link, "name": name, "size": max(0, size), "cookie": cookie}


def classify(url: str) -> dict:
    """What a link is, for the post view: {url, kind, host, supported}.

    kind: 'filehost' | 'tube' | 'direct' | 'unsupported'. `supported` is
    False for a tube site (allowed only with the opt-in) and for a host this
    build cannot fetch (a Mega folder, an unknown page)."""
    u = (url or "").strip()
    parsed = urlparse(u)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        return {"url": u, "kind": "unsupported", "host": host, "supported": False}
    if _PIXELDRAIN_RE.match(u):
        return {"url": u, "kind": "filehost", "host": "pixeldrain", "supported": True}
    if _MEGA_FILE_RE.match(u):
        return {"url": u, "kind": "filehost", "host": "mega", "supported": True}
    if _PMVHAVEN_RE.match(u):
        return {"url": u, "kind": "videohost", "host": "pmvhaven", "supported": True}
    if _FAPTAP_RE.match(u):
        return {"url": u, "kind": "videohost", "host": "faptap", "supported": True}
    if _EROSYNC_RE.match(u):
        return {"url": u, "kind": "videohost", "host": "erosync", "supported": True}
    if host.removeprefix("www.") in SCRIPT_SHOPS:
        return {"url": u, "kind": "store", "host": host.removeprefix("www."), "supported": False, "reason": "paid"}
    if _GOFILE_RE.match(u):
        # The app resolves it (its own window opens the Gofile page: electron/gofile.js)
        # and hands the file link and guest cookie over; see start(resolved=...).
        return {"url": u, "kind": "filehost", "host": "gofile", "supported": True, "needsApp": True}
    if _MEGA_FOLDER_RE.match(u):
        # A public folder (2026-11-24, Dave: "as functional as possible ... gofile,
        # mega, pixeldrain"): its biggest video, or the file the link points at.
        if _MEGA_FOLDER_PARTS_RE.match(u):
            return {"url": u, "kind": "filehost", "host": "mega", "supported": True, "folder": True}
        return {"url": u, "kind": "filehost", "host": "mega", "supported": False, "reason": "megaFolder"}
    if parsed.path.lower().endswith(VIDEO_EXTS):
        return {"url": u, "kind": "direct", "host": host, "supported": True}
    key = _ytdlp_extractor_for(u)
    if key in YTDLP_FILE_HOSTS:
        return {"url": u, "kind": "filehost", "host": YTDLP_FILE_HOSTS[key], "supported": True}
    if key:
        return {"url": u, "kind": "tube", "host": key.lower(), "supported": True}
    return {"url": u, "kind": "unsupported", "host": host, "supported": False}


# --- names and paths ----------------------------------------------------------

_BAD_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def clean_stem(name: str, fallback: str = "video") -> str:
    """A file name stem safe on Windows and Linux (no extension)."""
    s = _BAD_NAME_CHARS.sub(" ", str(name or ""))
    s = re.sub(r"\s+", " ", s).strip().strip(".").strip()
    if not s:
        s = fallback
    # Windows reserved device names.
    if s.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        s = f"_{s}"
    return s[:150].rstrip(" .") or fallback


def unique_path(dest_dir: str, stem: str, ext: str) -> str:
    """`<dest>/<stem><ext>`, or `<stem> (1)<ext>` ... when taken (never overwrite).
    A name whose `.part` exists is taken too (another download is writing it)."""
    ext = ext if ext.startswith(".") else f".{ext}"
    for i in range(0, 1000):
        name = stem if i == 0 else f"{stem} ({i})"
        p = os.path.join(dest_dir, name + ext)
        if not os.path.exists(p) and not os.path.exists(p + ".part"):
            return p
    raise DownloadError("nameTaken")


def unique_stem(dest_dir: str, stem: str, taken: set[str] | frozenset = frozenset(), script_is_ours: bool = False) -> str:
    """A name no video, part file or script in `dest_dir` has yet, and no other
    running download there holds (`taken`, lower case): `stem`, `stem (1)`...
    Reserved when a download starts, so the script saved beside it at once
    (the EroScripts tab, 2026-11-22: Dave wants the script and the video
    shown separately) and the video that lands later share the name."""
    try:
        names = {n.lower() for n in os.listdir(dest_dir)}
    except OSError:
        names = set()
    for i in range(0, 1000):
        name = stem if i == 0 else f"{stem} ({i})"
        low = name.lower()
        if low in taken or (f"{low}.funscript" in names and not (i == 0 and script_is_ours)):
            continue
        if any(f"{low}{ext}" in names or f"{low}{ext}.part" in names for ext in VIDEO_EXTS):
            continue
        # yt-dlp's working files too (<stem>.f2753.mp4.part, .part-Frag3,
        # .ytdl): a new download under that name made yt-dlp continue an older
        # one's file, unasked (Dave, 2026-11-25: a download started again after
        # FunSync closed "seemed to resume"). Resume is the way to continue it.
        prefix = low + "."
        if any(n.startswith(prefix) and _is_partial_rest("." + n[len(prefix):]) for n in names):
            continue
        return name
    raise DownloadError("nameTaken")


def _is_partial_rest(rest: str) -> bool:
    """`rest` (what follows a stem, from its dot) names a working file, never a
    finished one. Any case: unique_stem compares lower-cased names."""
    r = rest.lower()
    return r.endswith(".part") or ".part-frag" in r or r.endswith(".ytdl") or ".temp." in r


def check_dest(dest_dir: str) -> str:
    d = os.path.abspath(dest_dir or "")
    if not dest_dir or not os.path.isabs(dest_dir) or not os.path.isdir(d):
        raise DownloadError("badFolder", "the folder does not exist")
    return d


def _ext_of(name: str, default: str = ".mp4") -> str:
    ext = os.path.splitext(name or "")[1].lower()
    return ext if ext in VIDEO_EXTS else default


# --- jobs ---------------------------------------------------------------------

class Job:
    def __init__(self, url: str, dest_dir: str, stem: str, allow_tube: bool):
        self.id = uuid.uuid4().hex[:12]
        self.url = url
        self.dest_dir = dest_dir
        self.stem = stem
        self.allow_tube = allow_tube
        self.status = "queued"          # queued | resolving | downloading | paused | done | error | cancelled
        self.host = ""
        self.name = ""                  # the source's own file name, when known
        self.bytes = 0
        self.total = 0
        self.speed = 0.0                # bytes/s, smoothed
        # time.monotonic() when bytes last arrived: a stalled connection shows in
        # the app (Dave, 2026-11-26: the card froze with nothing said while a read
        # waited out its timeout, and Cancel seemed to do nothing).
        self.progress_at = 0.0
        self.path = ""                  # the final file, once done
        self.error = ""                 # a code (see DownloadError)
        self.message = ""
        self.created = time.time()
        self.finished = 0.0
        self._cancel = threading.Event()
        self._pause = threading.Event()
        # yt-dlp's working files once the job has ended: (dir, stem). Cleared
        # after a cancel, kept after a pause or a failure (Resume uses them).
        self._leftovers: tuple[str, str] | None = None
        # A direct stream's planned file and its partial (Resume continues it).
        self.final_path = ""
        self.part_path = ""
        self.resumable = False
        self._hint = ""
        self._gofile = None
        # The renderer's own note on the job (the post, its script, the tags to
        # record when the video lands), kept with it so a download that comes
        # back after FunSync closed still finishes as its post's (2026-11-25).
        self.meta: dict | None = None
        # Stopped because FunSync closed (or the backend stopped) part-way: it
        # came back paused from the saved list, and the tab says so.
        self.interrupted = False

    def stalled_for(self) -> int:
        """Whole seconds since bytes last arrived, while downloading (else 0)."""
        if self.status != "downloading" or not self.progress_at:
            return 0
        return int(max(0.0, time.monotonic() - self.progress_at))

    def stopping(self) -> bool:
        """Pause or Cancel asked for, the download not stopped yet: a read waiting
        on a stalled connection only ends at its timeout."""
        return self.status in ("queued", "resolving", "downloading") and (self._cancel.is_set() or self._pause.is_set())

    def snapshot(self) -> dict:
        return {
            "id": self.id, "url": self.url, "destDir": self.dest_dir, "stem": self.stem,
            "status": self.status, "host": self.host, "name": self.name,
            "bytes": self.bytes, "total": self.total, "speed": round(self.speed),
            "path": self.path, "error": self.error, "message": self.message[:300],
            "created": self.created, "finished": self.finished,
            "resumable": self.resumable,
            "interrupted": self.interrupted,
            "stalledFor": self.stalled_for(),
            "stopping": self.stopping(),
            # A Gofile link's file link and guest cookie are never saved: one
            # brought back after a restart is looked up again on Resume.
            "needsResolve": self.host == "gofile" and not self._gofile,
            "meta": self.meta,
        }

    def to_record(self) -> dict:
        """What the saved list keeps (never the Gofile cookie)."""
        return {
            "id": self.id, "url": self.url, "destDir": self.dest_dir, "stem": self.stem,
            "allowTube": self.allow_tube, "status": self.status, "host": self.host, "name": self.name,
            "bytes": self.bytes, "total": self.total, "created": self.created,
            "error": self.error, "message": self.message[:300], "interrupted": self.interrupted,
            "finalPath": self.final_path, "partPath": self.part_path,
            "hint": self._hint, "meta": self.meta,
        }

    def partial_bytes(self) -> int:
        """How much of it is on disk: its .part, else yt-dlp's working files."""
        try:
            if self.part_path and os.path.exists(self.part_path):
                return os.path.getsize(self.part_path)
        except OSError:
            return 0
        if not self._leftovers:
            return 0
        d, stem = self._leftovers
        total = 0
        try:
            for n in os.listdir(d):
                if n.startswith(stem + ".") and _is_partial_rest("." + n[len(stem) + 1:]):
                    try:
                        total += os.path.getsize(os.path.join(d, n))
                    except OSError:
                        pass
        except OSError:
            return 0
        return total

    def check(self):
        if self._pause.is_set():
            raise Paused()
        if self._cancel.is_set():
            raise Cancelled()

    def has_partial(self) -> bool:
        """Is there anything on disk a Resume would continue?"""
        try:
            if self.part_path and os.path.getsize(self.part_path) > 0:
                return True
        except OSError:
            pass
        if self._leftovers:
            d, stem = self._leftovers
            try:
                return any(n.startswith(stem + ".") and (n.endswith(".part") or ".part-Frag" in n or n.endswith(".ytdl"))
                           for n in os.listdir(d))
            except OSError:
                return False
        return False

    def discard_partial(self):
        """Delete what a Resume would have continued (Cancel on a paused job)."""
        try:
            if self.part_path and os.path.exists(self.part_path):
                os.remove(self.part_path)
        except OSError:
            pass
        if self._leftovers:
            import gc
            gc.collect()
            remove_partials(*self._leftovers)
        self.resumable = False


META_MAX_BYTES = 64 * 1024
_JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
# Kept in the saved list: what a Resume can still continue.
_RUNNING = ("queued", "resolving", "downloading")


def clean_meta(meta) -> dict | None:
    """The renderer's note on a job: a JSON object of at most META_MAX_BYTES, else None."""
    if not isinstance(meta, dict):
        return None
    try:
        text = json.dumps(meta)
    except (TypeError, ValueError):
        return None
    return json.loads(text) if len(text.encode("utf-8")) <= META_MAX_BYTES else None


def _inside(path: str, folder: str) -> bool:
    return bool(path) and os.path.normcase(os.path.dirname(os.path.abspath(path))) == os.path.normcase(os.path.abspath(folder))


def restore_job(rec) -> Optional[Job]:
    """A job from the saved list, or None. A download that was running when
    FunSync closed comes back paused and `interrupted` (2026-11-25: Dave
    started one, closed the app, and nothing said it could be resumed). Only
    names inside its own folder are trusted; the bytes are read from disk."""
    if not isinstance(rec, dict):
        return None
    url, dest, stem = str(rec.get("url") or ""), str(rec.get("destDir") or ""), str(rec.get("stem") or "")
    if not url or not dest or not os.path.isabs(dest) or not stem or os.path.basename(stem) != stem or stem in (".", ".."):
        return None
    was = rec.get("status")
    if was not in (*_RUNNING, "paused", "error"):
        return None
    job = Job(url, os.path.abspath(dest), stem, rec.get("allowTube") is True)
    rid = str(rec.get("id") or "")
    if _JOB_ID_RE.match(rid):
        job.id = rid
    job.host = str(rec.get("host") or "")[:40]
    job.name = str(rec.get("name") or "")[:300]
    try:
        job.total = max(0, int(rec.get("total") or 0))
        job.created = float(rec.get("created") or job.created)
    except (TypeError, ValueError):
        pass
    job._hint = str(rec.get("hint") or "")[:300]
    job.meta = clean_meta(rec.get("meta"))
    final, part = str(rec.get("finalPath") or ""), str(rec.get("partPath") or "")
    if final and part == final + ".part" and _inside(final, job.dest_dir):
        job.final_path, job.part_path = os.path.abspath(final), os.path.abspath(part)
    else:
        # yt-dlp's working files sit under the job's reserved name.
        job._leftovers = (job.dest_dir, stem)
    # It finished, and FunSync closed before the list was saved again.
    if was in _RUNNING and job.final_path and os.path.isfile(job.final_path) and not os.path.exists(job.part_path):
        job.status, job.path = "done", job.final_path
        job.bytes = os.path.getsize(job.final_path)
        job.final_path = job.part_path = ""
        job.finished = time.time()
        return job
    if was == "error":
        job.status, job.error, job.message = "error", str(rec.get("error") or "failed")[:40], str(rec.get("message") or "")[:300]
    else:
        job.status = "paused"
        job.interrupted = was in _RUNNING or rec.get("interrupted") is True
    job.bytes = job.partial_bytes()
    # A folder that was gone can be tried again once it is back.
    job.resumable = job.has_partial() or (job.status == "error" and job.error == "badFolder")
    if was == "error" and not job.resumable:
        return None
    return job


class DownloadManager:
    """The one queue: at most MAX_PARALLEL downloads at a time, the rest wait."""

    def __init__(self, client_factory: Callable[[], httpx.Client] | None = None):
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._slots = threading.Semaphore(MAX_PARALLEL)
        # <userData>/downloads.json once the backend knows userData (main.py):
        # the downloads a Resume can still continue, so they outlive FunSync.
        self._store_path: str | None = None
        self._save_lock = threading.Lock()
        self._client_factory = client_factory or (lambda: httpx.Client(
            follow_redirects=True, timeout=httpx.Timeout(30.0, read=60.0),
            headers={"User-Agent": USER_AGENT},
        ))

    def start(self, url: str, dest_dir: str, stem: str, allow_tube: bool = False, script_is_ours: bool = False,
              resolved: dict | None = None, hint: str = "", meta: dict | None = None) -> Job:
        d = check_dest(dest_dir)
        info = classify(url)
        if not info["supported"]:
            raise DownloadError(info.get("reason") or "unsupported")
        gofile = None
        if info["host"] == "gofile":
            gofile = gofile_resolved(resolved)
            if not gofile:
                raise DownloadError("needsApp")
        if info["kind"] == "tube" and not allow_tube:
            raise DownloadError("tubeOff")
        with self._lock:
            # The name is reserved now: the renderer saves the script under it
            # straight away; another running download into the folder keeps its own.
            # A paused one keeps its name too: its Resume continues under it.
            taken = {j.stem.lower() for j in self._jobs.values()
                     if j.dest_dir == d and (j.status in (*_RUNNING, "paused") or (j.status == "error" and j.resumable))}
            job = Job(info["url"], d, unique_stem(d, clean_stem(stem), taken, script_is_ours), allow_tube)
            job.host = info["host"]
            job._gofile = gofile
            # Which of several videos (a Mega folder, a Pixeldrain list): the script's name.
            job._hint = str(hint or "")[:300]
            job.meta = clean_meta(meta)
            self._jobs[job.id] = job
        self._save()
        threading.Thread(target=self._run, args=(job, info), daemon=True, name=f"download-{job.id}").start()
        return job

    # --- the saved list (2026-11-25) ---

    def set_store(self, path: str) -> int:
        """Keep the list in `path` and bring back what it holds: a download
        that was running when FunSync closed comes back paused, interrupted,
        with Resume. Returns how many came back."""
        self._store_path = path
        try:
            with open(path, "r", encoding="utf-8") as f:
                recs = json.load(f).get("jobs") or []
        except (OSError, ValueError, AttributeError):
            recs = []
        n = 0
        with self._lock:
            for rec in recs if isinstance(recs, list) else []:
                job = restore_job(rec)
                if job and job.id not in self._jobs:
                    self._jobs[job.id] = job
                    n += 1
        self._save()
        return n

    def _save(self):
        """Write the downloads a Resume can still continue (never a Gofile cookie). Never throws."""
        path = self._store_path
        if not path:
            return
        with self._lock:
            recs = [j.to_record() for j in sorted(self._jobs.values(), key=lambda j: j.created)
                    if j.status in (*_RUNNING, "paused") or (j.status == "error" and j.resumable)]
        with self._save_lock:
            tmp = f"{path}.tmp-{os.getpid()}"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"v": 1, "jobs": recs}, f)
                os.replace(tmp, path)
            except OSError:
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    # --- is the link alive? (Dave, 2026-11-22: links die, replies carry new ones)

    def check(self, urls: list[str]) -> list[dict]:
        """One answer per url, in order: {url, status: 'ok'|'dead'|'unknown', size, name}.
        At most 4 at once; any failure to ask is 'unknown', never 'dead'."""
        from concurrent.futures import ThreadPoolExecutor
        if not urls:
            return []
        with ThreadPoolExecutor(max_workers=4) as pool:
            out = list(pool.map(self._check_one, urls))
        # Pixeldrain slows a connection to 1 MB/s for the rest of the day once
        # its free 6 GB is used (seen live 2026-11-22: 15 MB/s fell to 300 KB/s
        # at 51 %). Said on its links, so a full-speed one can be offered first.
        if any(o["status"] == "ok" and classify(o["url"])["host"] == "pixeldrain" for o in out) and self.pixeldrain_slow():
            for o in out:
                if o["status"] == "ok" and classify(o["url"])["host"] == "pixeldrain":
                    o["slow"] = True
        return out

    def pixeldrain_slow(self) -> bool:
        """Has this connection used up Pixeldrain's free daily transfer? Never throws."""
        try:
            with self._client_factory() as client:
                r = client.get("https://pixeldrain.com/api/misc/rate_limits", timeout=10)
                if r.status_code != 200:
                    return False
                j = r.json()
                limit, used = int(j.get("transfer_limit") or 0), int(j.get("transfer_limit_used") or 0)
                return limit > 0 and used >= limit
        except Exception:
            return False

    def _check_one(self, url: str) -> dict:
        info = classify(url)
        out = {"url": info["url"], "status": "unknown", "size": 0, "name": ""}
        host, kind = info["host"], info["kind"]
        if not info["supported"] or kind in ("tube", "store", "unsupported") or host not in ("pixeldrain", "mega", "pmvhaven", "faptap", "erosync") and kind != "direct":
            return out
        try:
            with self._client_factory() as client:
                if host == "pixeldrain":
                    m = _PIXELDRAIN_RE.match(info["url"])
                    kind_, ident = m.group(1), m.group(2)
                    if kind_ == "l":
                        r = client.get(f"https://pixeldrain.com/api/list/{ident}", timeout=10)
                        if r.status_code == 404:
                            return {**out, "status": "dead"}
                        if r.status_code == 200:
                            files = [x for x in (r.json().get("files") or []) if _ext_of(x.get("name", ""), "") in VIDEO_EXTS]
                            if not files:
                                return {**out, "status": "dead"}
                            pick = max(files, key=lambda x: x.get("size") or 0)
                            return {**out, "status": "ok", "size": pick.get("size") or 0, "name": pick.get("name", "")}
                    else:
                        r = client.get(f"https://pixeldrain.com/api/file/{ident}/info", timeout=10)
                        if r.status_code == 404:
                            return {**out, "status": "dead"}
                        if r.status_code == 200:
                            meta = r.json()
                            return {**out, "status": "ok", "size": meta.get("size") or 0, "name": meta.get("name", "")}
                elif host == "mega" and info.get("folder"):
                    # A public folder: alive with a video in it (its name and size).
                    folder_id, folder_key, inside = mega_folder_parts(info["url"])
                    try:
                        node = mega_folder_pick(mega_folder_nodes(client, folder_id, folder_key), inside)
                    except DownloadError as e:
                        return {**out, "status": "dead"} if e.code == "notFound" else out
                    if node:
                        return {**out, "status": "ok", "size": node["size"], "name": node["name"]}
                    return out
                elif host == "mega":
                    file_id, key = mega_link_parts(info["url"])
                    r = client.post("https://g.api.mega.co.nz/cs", params={"id": str(int(time.time()))},
                                    content=json.dumps([{"a": "g", "p": file_id}]), timeout=10)
                    answer = r.json()
                    item = answer[0] if isinstance(answer, list) and answer else answer
                    if isinstance(item, int):
                        return {**out, "status": "dead" if item in (-9, -2, -16) else "unknown"}
                    if isinstance(item, dict) and item.get("s") is not None:
                        aes_key, _ = mega_key_iv(key)
                        return {**out, "status": "ok", "size": int(item.get("s") or 0),
                                "name": mega_file_name(item.get("at", ""), aes_key) or ""}
                elif host == "faptap":
                    # FapTap's own public answer for the video: its name, and
                    # what it says about the script (Dave, 2026-11-22: "make
                    # sure users know the script is not available unless paid
                    # for"). The page is the fallback.
                    m = _FAPTAP_RE.match(info["url"])
                    r = client.get(f"https://faptap.net/api/videos/{m.group(1)}", timeout=10, headers={"Accept": "application/json"})
                    if r.status_code in (404, 410):
                        return {**out, "status": "dead"}
                    if r.status_code == 200:
                        data = (r.json() or {}).get("data") or {}
                        if data.get("id"):
                            return {**out, "status": "ok", "name": data.get("name") or "", "script": faptap_script_info(data)}
                    r = client.get(info["url"], timeout=10)
                    if r.status_code in (404, 410):
                        return {**out, "status": "dead"}
                    if r.status_code == 200:
                        stream = faptap_stream(r.text)
                        return {**out, "status": "ok" if stream else "dead", "name": (stream or {}).get("title", "")}
                elif host == "erosync":
                    try:
                        video = erosync_video(client, info["url"])
                    except DownloadError as e:
                        return {**out, "status": "dead"} if e.code == "notFound" else out
                    # Its length too: the tab compares it with the script's before a
                    # download (EroScripts review 2.3, 2026-11-23).
                    dur = video.get("duration")
                    extra = {"duration": float(dur)} if isinstance(dur, (int, float)) and dur > 0 else {}
                    return {**out, "status": "ok", "name": video["title"], **extra}
                elif host == "pmvhaven":
                    r = client.get(info["url"], timeout=10)
                    if r.status_code in (404, 410):
                        return {**out, "status": "dead"}
                    if r.status_code == 200:
                        if host == "pmvhaven":
                            m = _PMVHAVEN_RE.match(info["url"])
                            video = pmvhaven_video(r.text, m.group(1) if m else "")
                            return {**out, "status": "ok" if video else "dead", "name": (video or {}).get("title", "")}
                        stream = faptap_stream(r.text)
                        return {**out, "status": "ok" if stream else "dead", "name": (stream or {}).get("title", "")}
                else:  # a direct video link
                    r = client.head(info["url"], timeout=10)
                    if r.status_code in (404, 410):
                        return {**out, "status": "dead"}
                    if 200 <= r.status_code < 300:
                        return {**out, "status": "ok", "size": int(r.headers.get("content-length") or 0)}
        except Exception:
            return out
        return out

    def jobs(self) -> list[dict]:
        with self._lock:
            return [j.snapshot() for j in sorted(self._jobs.values(), key=lambda j: j.created)]

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        """Stop a download and delete what it wrote; on a paused or failed one,
        delete the partial file it kept for Resume."""
        job = self.get(job_id)
        if not job or job.status in ("done", "cancelled"):
            return False
        if job.status in ("paused", "error"):
            job.discard_partial()
            job.status = "cancelled"
            self._save()
            return True
        job._cancel.set()
        if job.status == "queued":
            job.status = "cancelled"
            self._save()
        return True

    def pause(self, job_id: str) -> bool:
        """Stop a download and keep its partial file for Resume."""
        job = self.get(job_id)
        if not job or job.status not in ("queued", "resolving", "downloading"):
            return False
        job._pause.set()
        if job.status == "queued":
            job.status = "paused"
            self._save()
        return True

    def resume(self, job_id: str, resolved: dict | None = None) -> Optional[Job]:
        """Continue a paused or failed download where it stopped. A Gofile one
        brought back after a restart needs the app's lookup again (`resolved`:
        its file link and guest cookie are never saved)."""
        job = self.get(job_id)
        if not job or job.status not in ("paused", "error"):
            return None
        info = classify(job.url)
        if not info["supported"]:
            return None
        # Its folder is not there (a drive unplugged): said, and the download
        # stays as it was, Resume and Discard with it (break-it, 2026-11-25: it
        # became "Something went wrong" with no buttons at all).
        if not os.path.isdir(job.dest_dir):
            raise DownloadError("badFolder", "the folder does not exist")
        if job.host == "gofile" and not job._gofile:
            job._gofile = gofile_resolved(resolved)
            if not job._gofile:
                raise DownloadError("needsApp")
        job._pause.clear()
        job._cancel.clear()
        job.status, job.error, job.message, job.finished, job.speed = "queued", "", "", 0.0, 0.0
        job.interrupted = False
        self._save()
        threading.Thread(target=self._run, args=(job, info), daemon=True, name=f"download-{job.id}").start()
        return job

    def clear_finished(self) -> int:
        """Remove finished rows: done, cancelled, and failures with nothing to
        resume. A paused download, or a failure that can be resumed, stays."""
        with self._lock:
            gone = [k for k, j in self._jobs.items()
                    if j.status in ("done", "cancelled") or (j.status == "error" and not j.resumable)]
            for k in gone:
                del self._jobs[k]
        return len(gone)

    # -- the work --

    def _run(self, job: Job, info: dict):
        with self._slots:
            if job._pause.is_set():
                job.status = "paused"
                return
            if job._cancel.is_set():
                job.status = "cancelled"
                job.finished = time.time()
                return
            try:
                job.status = "resolving"
                kind, host = info["kind"], info["host"]
                if host == "pixeldrain":
                    self._pixeldrain(job)
                elif host == "mega":
                    self._mega(job)
                elif host == "pmvhaven":
                    self._pmvhaven(job)
                elif host == "faptap":
                    self._faptap(job)
                elif host == "rule34video":
                    self._rule34video(job)
                elif host == "erosync":
                    self._erosync(job)
                elif host == "gofile":
                    self._gofile(job)
                elif kind == "direct":
                    self._direct(job)
                else:
                    self._ytdlp(job)
                job.status = "done"
            except Paused:
                job.status = "paused"
            except Cancelled:
                job.status = "cancelled"
            except DownloadError as e:
                job.status, job.error, job.message = "error", e.code, str(e)
            except Exception as e:  # network, host changes: shown, never raised
                job.status, job.error, job.message = "error", "failed", f"{type(e).__name__}: {e}"
                # The folder went away under it (a drive unplugged): say that.
                if isinstance(e, OSError) and not os.path.isdir(job.dest_dir):
                    job.error, job.message = "badFolder", "the folder does not exist"
            finally:
                job.finished = time.time()
        # Out of every except block: the failure's traceback is no longer being
        # handled, so collecting it closes the file yt-dlp still had open (a
        # cancelled FapTap download's .part stayed locked while the clean-up ran
        # inside the handler, 2026-11-22).
        if job.status == "cancelled" and job._leftovers:
            import gc
            gc.collect()
            remove_partials(*job._leftovers)
        # Paused, or failed part-way: what is on disk can be continued. A folder
        # that went away can be tried again once it is back (Resume checks it).
        job.resumable = (job.status in ("paused", "error") and job.has_partial()) or (
            job.status == "error" and job.error == "badFolder")
        self._save()

    def _stream_to_file(self, job: Job, client: httpx.Client, url: str, ext: str,
                        headers: dict | None = None, transform: Callable[[bytes], bytes] | None = None,
                        transform_at: Callable[[int], Callable[[bytes], bytes]] | None = None, align: int = 1):
        """GET `url` into `<stem><ext>.part`, then rename to a free final name.

        A paused or failed download keeps its .part: Resume continues it with
        an HTTP Range request (from a multiple of `align` bytes: Mega's
        AES-CTR works in 16-byte blocks, `transform_at(offset)` gives the
        decryptor for that offset). A server that ignores the Range starts it
        over. Cancel deletes it."""
        offset = 0
        if job.final_path and job.part_path and os.path.exists(job.part_path):
            final, part = job.final_path, job.part_path
            offset = os.path.getsize(part)
            offset -= offset % max(1, align)
            with open(part, "r+b") as f:
                f.truncate(offset)
        else:
            final = unique_path(job.dest_dir, job.stem, ext)
            part = final + ".part"
            job.final_path, job.part_path = final, part
        req_headers = dict(headers or {})
        if offset:
            req_headers["Range"] = f"bytes={offset}-"
        try:
            with client.stream("GET", url, headers=req_headers) as resp:
                if resp.status_code == 404:
                    raise DownloadError("notFound")
                if resp.status_code in (401, 403):
                    raise DownloadError("denied", f"HTTP {resp.status_code}")
                if resp.status_code == 429:
                    raise DownloadError("rateLimited")
                if resp.status_code >= 400:
                    raise DownloadError("failed", f"HTTP {resp.status_code}")
                length = int(resp.headers.get("content-length") or 0)
                if offset and resp.status_code == 206:
                    m = re.search(r"/(\d+)\s*$", resp.headers.get("content-range", ""))
                    job.total = int(m.group(1)) if m else offset + length
                else:
                    offset = 0                  # the server sent the whole file: start over
                    if length:
                        job.total = length
                check_space(job.dest_dir, (job.total or 0) - offset)
                job.status = "downloading"
                job.bytes = offset
                job.progress_at = time.monotonic()
                # Its .part is known now: saved, so a Resume after FunSync
                # closes continues it instead of starting over.
                self._save()
                decrypt = transform_at(offset) if transform_at else transform
                last_t, last_b = time.monotonic(), offset
                with open(part, "ab" if offset else "wb") as f:
                    for chunk in resp.iter_bytes(CHUNK):
                        job.check()
                        f.write(decrypt(chunk) if decrypt else chunk)
                        job.bytes += len(chunk)
                        now = time.monotonic()
                        job.progress_at = now
                        if now - last_t >= 0.5:
                            rate = (job.bytes - last_b) / (now - last_t)
                            job.speed = rate if not job.speed else job.speed * 0.6 + rate * 0.4
                            last_t, last_b = now, job.bytes
            if job.total and job.bytes < job.total:
                raise DownloadError("incomplete", f"{job.bytes} of {job.total} bytes")
            # Another download may have taken the name meanwhile: re-check.
            if os.path.exists(final):
                final = unique_path(job.dest_dir, job.stem, ext)
            os.replace(part, final)
            job.path = final
            job.final_path = job.part_path = ""
        except BaseException as e:
            # Kept for Resume: a pause, and a failure part-way (the connection
            # dropped, the file came short). Deleted: a cancel, and a refusal
            # that a Resume would only meet again.
            keep = isinstance(e, Paused) or (
                not isinstance(e, Cancelled)
                and not (isinstance(e, DownloadError) and e.code in ("noSpace", "notFound", "denied", "rateLimited"))
                and os.path.exists(part) and os.path.getsize(part) > 0)
            if not keep:
                try:
                    if os.path.exists(part):
                        os.remove(part)
                except OSError:
                    pass
                job.final_path = job.part_path = ""
            raise

    # pixeldrain: /u/<id> one file, /l/<id> a list (its largest video).
    def _pixeldrain(self, job: Job):
        m = _PIXELDRAIN_RE.match(job.url)
        kind, ident = m.group(1).lower(), m.group(2)
        with self._client_factory() as client:
            if kind == "l":
                r = client.get(f"https://pixeldrain.com/api/list/{ident}")
                if r.status_code == 404:
                    raise DownloadError("notFound")
                files = [x for x in (r.json().get("files") or []) if _ext_of(x.get("name", ""), "") in VIDEO_EXTS]
                if not files:
                    raise DownloadError("noVideo")
                pick = pick_by_hint(files, getattr(job, "_hint", ""))
                ident, name, size = pick["id"], pick.get("name", ""), pick.get("size") or 0
            else:
                r = client.get(f"https://pixeldrain.com/api/file/{ident}/info")
                if r.status_code == 404:
                    raise DownloadError("notFound")
                meta = r.json()
                name, size = meta.get("name", ""), meta.get("size") or 0
            job.name, job.total = name, size
            job.check()
            self._stream_to_file(job, client, f"https://pixeldrain.com/api/file/{ident}?download", _ext_of(name))

    # rule34video: the page's own Download buttons (yt-dlp's extractor no
    # longer finds them, 2026-11-22). Behind the Tube switch like any tube site.
    def _rule34video(self, job: Job):
        with self._client_factory() as client:
            src = rule34video_source(client, job.url)
            job.name = src["title"]
            job.check()
            self._stream_to_file(job, client, src["streamUrl"], ".mp4")

    # gofile: the app resolved the folder (its own window, the Gofile page);
    # the file link wants the guest cookie that page was given.
    def _gofile(self, job: Job):
        g = getattr(job, "_gofile", None)
        if not g:
            raise DownloadError("needsApp")
        job.name = g["name"]
        job.total = g["size"]
        job.check()
        with self._client_factory() as client:
            self._stream_to_file(job, client, g["link"], _ext_of(g["name"]) or ".mp4", headers={"Cookie": g["cookie"]})

    def _direct(self, job: Job):
        job.name = os.path.basename(urlparse(job.url).path)
        with self._client_factory() as client:
            self._stream_to_file(job, client, job.url, _ext_of(job.name))

    # mega: a public file link. The key after '#' gives the AES key and the
    # counter; the attributes (the file name) are AES-CBC with the same key.
    def _mega(self, job: Job):
        from Cryptodome.Cipher import AES
        if _MEGA_FOLDER_PARTS_RE.match(job.url):
            return self._mega_folder(job)
        file_id, key = mega_link_parts(job.url)
        aes_key, iv = mega_key_iv(key)
        with self._client_factory() as client:
            r = client.post("https://g.api.mega.co.nz/cs", params={"id": str(int(time.time()))},
                            content=json.dumps([{"a": "g", "g": 1, "p": file_id}]))
            answer = r.json()
            item = answer[0] if isinstance(answer, list) and answer else answer
            if isinstance(item, int):
                raise DownloadError("notFound" if item in (-9, -2) else "failed", f"Mega error {item}")
            job.total = int(item.get("s") or 0)
            job.name = mega_file_name(item.get("at", ""), aes_key) or ""
            job.check()
            start = int.from_bytes(iv, "big")

            def decryptor(offset: int):
                # CTR counts 16-byte blocks: a resumed download starts at its block.
                return AES.new(aes_key, AES.MODE_CTR, nonce=b"", initial_value=(start + offset // 16) % (1 << 128)).decrypt

            self._stream_to_file(job, client, item["g"], _ext_of(job.name), transform_at=decryptor, align=16)

    # mega folder: list it with its key, take the video, download and decrypt
    # it like a single file (Mega's public folder API: "f" to list, "g" with
    # the folder as n to fetch one of its files).
    def _mega_folder(self, job: Job):
        from Cryptodome.Cipher import AES
        folder_id, folder_key, inside = mega_folder_parts(job.url)
        with self._client_factory() as client:
            node = mega_folder_pick(mega_folder_nodes(client, folder_id, folder_key), inside, getattr(job, "_hint", ""))
            if not node:
                raise DownloadError("noVideo")
            r = client.post("https://g.api.mega.co.nz/cs", params={"id": str(int(time.time())), "n": folder_id},
                            content=json.dumps([{"a": "g", "g": 1, "n": node["h"]}]))
            answer = r.json()
            item = answer[0] if isinstance(answer, list) and answer else answer
            if isinstance(item, int) or not isinstance(item, dict) or not item.get("g"):
                raise DownloadError("notFound" if item in (-9, -2) else "failed", f"Mega error {item}")
            job.name = node["name"]
            job.total = int(item.get("s") or node["size"] or 0)
            job.check()
            aes_key, start = node["aes_key"], int.from_bytes(node["iv"], "big")

            def decryptor(offset: int):
                return AES.new(aes_key, AES.MODE_CTR, nonce=b"", initial_value=(start + offset // 16) % (1 << 128)).decrypt

            self._stream_to_file(job, client, item["g"], _ext_of(job.name), transform_at=decryptor, align=16)

    # pmvhaven: the video page's own data names the MP4.
    def _pmvhaven(self, job: Job):
        m = _PMVHAVEN_RE.match(job.url)
        with self._client_factory() as client:
            r = client.get(job.url)
            if r.status_code in (404, 410):
                raise DownloadError("notFound")
            if r.status_code >= 400:
                raise DownloadError("denied" if r.status_code in (401, 403) else "failed", f"HTTP {r.status_code}")
            video = pmvhaven_video(r.text, m.group(1) if m else "")
            if not video or not video.get("videoUrl"):
                raise DownloadError("noVideo")
            job.name = video.get("title") or ""
            job.check()
            self._stream_to_file(job, client, video["videoUrl"], _ext_of(video["videoUrl"]))

    # faptap: the page's og:image is on the video's CDN folder; its
    # playlist.m3u8 is the stream the site's player plays (yt-dlp joins it).
    def _faptap(self, job: Job):
        with self._client_factory() as client:
            r = client.get(job.url)
            if r.status_code in (404, 410):
                raise DownloadError("notFound")
            if r.status_code >= 400:
                raise DownloadError("denied" if r.status_code in (401, 403) else "failed", f"HTTP {r.status_code}")
            stream = faptap_stream(r.text)
        if not stream:
            raise DownloadError("noVideo")
        job.name = stream["title"]
        job.check()
        self._ytdlp(job, stream["playlist"])

    # erosync: its API gives the HLS stream (video and audio apart; yt-dlp
    # joins them with ffmpeg).
    def _erosync(self, job: Job):
        with self._client_factory() as client:
            video = erosync_video(client, job.url)
        job.name = video["title"]
        job.check()
        self._ytdlp(job, video["streamUrl"])

    # gofile, yandex disk and (opt-in) tube sites; faptap's stream.
    def _ytdlp(self, job: Job, url: str | None = None):
        import yt_dlp

        source = url or job.url
        # The name reserved at the start (unique_stem): a resumed download
        # finds its own .part under it and yt-dlp continues it.
        stem = job.stem

        parts = PartsProgress()

        saved = {"status": None, "total": None, "at": 0.0}

        def hook(d):
            job.check()
            if d.get("status") == "downloading":
                job.status = "downloading"
                job.progress_at = time.monotonic()
                job.bytes, total = parts.downloading(d)
                job.total = total or job.total or 0
                job.speed = float(d.get("speed") or 0)
                # Saved when it starts, and when its size changes (a second
                # part; an HLS estimate, at most every 5 s): Resume after a
                # restart shows how far it got.
                now = time.monotonic()
                if saved["status"] != job.status or (saved["total"] != job.total and now - saved["at"] >= 5):
                    saved.update(status=job.status, total=job.total, at=now)
                    self._save()
            elif d.get("status") == "finished":
                # A part of a video joined later (<stem>.f2753.mp4) is not the
                # file: the list showed its name (EroSync, 2026-11-22).
                if parts.finished(d):
                    job.path = d.get("filename") or job.path

        opts = {
            "quiet": True, "no_warnings": True, "noplaylist": True, "noprogress": True,
            "format": YTDLP_FORMAT,
            "outtmpl": {"default": os.path.join(job.dest_dir, stem + ".%(ext)s")},
            "progress_hooks": [hook],
            "overwrites": False,
            "retries": 3,
            # A stalled read gives up after this, so a cancel waiting for the
            # next progress call is never held longer (2026-11-22).
            "socket_timeout": 15,
            "http_headers": {"User-Agent": USER_AGENT},
        }
        try:
            from services.ffmpeg import FFMPEG
            if FFMPEG and os.path.isfile(FFMPEG):
                opts["ffmpeg_location"] = FFMPEG
        except Exception:
            pass
        try:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.add_post_processor(_ExpectParts(parts), when="before_dl")
                    # One video per job: a profile, channel or playlist page would
                    # download every video on it. Looked at first, unprocessed.
                    first = ydl.extract_info(source, download=False, process=False) or {}
                    if first.get("_type") in ("playlist", "multi_video"):
                        raise DownloadError("playlist", "a page of several videos, not one video")
                    job.check()
                    info = ydl.process_ie_result(first, download=True)
                    job.name = job.name or (info or {}).get("title") or ""
                    downloads = (info or {}).get("requested_downloads") or []
                    if downloads and downloads[-1].get("filepath"):
                        job.path = downloads[-1]["filepath"]
            except Cancelled:
                raise
            except yt_dlp.utils.DownloadError as e:
                if job._cancel.is_set():
                    raise Cancelled()
                text = str(e)
                low = text.lower()
                code = ("login" if "login" in low or "sign in" in low or "account" in low else
                        "notFound" if "404" in low or "not found" in low or "unavailable" in low else
                        "denied" if "403" in low or "forbidden" in low else
                        "geo" if "geo" in low or "country" in low else "failed")
                raise DownloadError(code, text)
            if not job.path or not os.path.isfile(job.path):
                raise DownloadError("failed", "yt-dlp reported no file")
        except BaseException:
            # A cancelled or failed yt-dlp download leaves its working files
            # (<stem>.mp4.part, .ytdl, HLS fragments): found when a cancelled
            # Eporner download left eporner.mp4.part (2026-11-22). Cleared now,
            # and again by _run once the job has ended (a file still open now).
            job._leftovers = (job.dest_dir, stem)
            if isinstance(sys.exc_info()[1], Cancelled) and not isinstance(sys.exc_info()[1], Paused):
                remove_partials(job.dest_dir, stem, wait_s=0)
            raise


def _ExpectParts(parts: "PartsProgress"):
    """A yt-dlp step that runs once the formats are chosen and before any
    download: hands PartsProgress the parts to come."""
    from yt_dlp.postprocessor.common import PostProcessor

    class _Expect(PostProcessor):
        def run(self, info):
            parts.expect(info.get("requested_formats") or [])
            return [], info

    return _Expect()


class PartsProgress:
    """yt-dlp's progress for a download that may come in parts (a video and
    its separate audio, joined after: EroSync, 2026-11-22) as ONE bar: the
    bar went back to 0 % for the audio and read "24 % of 13 MB"."""

    def __init__(self):
        self._done: dict[str, int] = {}
        self._parts: list = []

    def expect(self, formats) -> None:
        """The parts yt-dlp chose, before it starts (its 'before_dl' step:
        each part's own progress report no longer lists the others)."""
        self._parts = [f for f in (formats or []) if isinstance(f, dict)]

    def downloading(self, d: dict) -> tuple[int, int]:
        """(bytes so far, total) over every part; total 0 when unknown."""
        name = d.get("filename") or ""
        now = int(d.get("downloaded_bytes") or 0)
        size = int(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
        done = sum(v for k, v in self._done.items() if k != name)
        later = 0
        parts = self._parts
        if len(parts) > 1:
            ids = [p.get("format_id") for p in parts]
            fid = (d.get("info_dict") or {}).get("format_id")
            if fid in ids:
                # A part still to come with no size known (EroSync's HLS gives
                # none): an audio track is about 5 % of its video, so the bar
                # does not reach 100 % before the audio has started.
                later = sum(int(p.get("filesize") or p.get("filesize_approx") or 0) or max(size, now) // 20
                            for p in parts[ids.index(fid) + 1:])
        total = done + max(size, now) + later if (size or later) else 0
        return done + now, total

    def finished(self, d: dict) -> bool:
        """Note a part done; True when it is the whole download (one part)."""
        name = d.get("filename") or ""
        self._done[name] = int(d.get("total_bytes") or d.get("downloaded_bytes") or 0)
        return len(self._parts) <= 1


def remove_partials(dest_dir: str, stem: str, wait_s: float = 3.0) -> list[str]:
    """Delete yt-dlp's working files for `stem` in `dest_dir` (never a finished
    file): `<stem>.<ext>.part`, `.part-Frag<n>`, `.ytdl`, `.temp.<ext>`.

    On Windows a file yt-dlp has just stopped writing can still be open for a
    moment after a cancel (a cancelled FapTap download left its 114 MB
    `.mp4.part`, 2026-11-22): a locked one is tried again for up to `wait_s`."""
    import gc
    gone = []
    try:
        names = os.listdir(dest_dir)
    except OSError:
        return gone
    prefix = stem + "."
    left = []
    for n in names:
        if not n.startswith(prefix):
            continue
        if _is_partial_rest("." + n[len(prefix):]):
            left.append(n)
    deadline = time.time() + wait_s
    while left:
        locked = []
        for n in left:
            try:
                os.remove(os.path.join(dest_dir, n))
                gone.append(n)
            except FileNotFoundError:
                pass
            except OSError:
                locked.append(n)
        left = locked
        if not left or time.time() >= deadline:
            break
        gc.collect()           # a handle yt-dlp dropped but did not close
        time.sleep(0.2)
    return gone


# --- streaming without downloading (2026-11-22) ---------------------------------

def stream_source(url: str, client_factory: Callable[[], httpx.Client] | None = None,
                  max_height: Optional[int] = None) -> Optional[dict]:
    """A link this module knows how to fetch, as something to PLAY (Load from
    URL / the EroScripts tab's Watch): {title, streamUrl, isHls, headers, site}.
    PMVHaven: its MP4; FapTap: the HLS stream its player plays; Pixeldrain: the
    file (a list: its largest video); a direct video link: itself. None for
    anything else (yt-dlp's resolver takes it) and for Mega (encrypted).
    Raises DownloadError when the host says the video is gone."""
    info = classify(url)
    if not info["supported"]:
        return None
    host, kind = info["host"], info["kind"]
    if host not in ("pmvhaven", "faptap", "pixeldrain", "rule34video", "erosync") and kind != "direct":
        return None
    headers = {"User-Agent": USER_AGENT}
    make = client_factory or (lambda: httpx.Client(follow_redirects=True, timeout=20, headers=headers))
    with make() as client:
        if host == "pmvhaven":
            r = client.get(info["url"])
            if r.status_code in (404, 410):
                raise DownloadError("notFound")
            m = _PMVHAVEN_RE.match(info["url"])
            video = pmvhaven_video(r.text, m.group(1) if m else "")
            if not video:
                raise DownloadError("noVideo")
            return {"title": video["title"] or "PMVHaven", "streamUrl": video["videoUrl"], "isHls": False, "headers": headers, "site": "PMVHaven"}
        if host == "faptap":
            r = client.get(info["url"])
            if r.status_code in (404, 410):
                raise DownloadError("notFound")
            stream = faptap_stream(r.text)
            if not stream:
                raise DownloadError("noVideo")
            return {"title": stream["title"] or "FapTap", "streamUrl": stream["playlist"], "isHls": True, "headers": headers, "site": "FapTap",
                    "thumbnail": stream.get("thumbnail")}
        if host == "erosync":
            video = erosync_video(client, info["url"])
            return {"title": video["title"], "streamUrl": video["streamUrl"], "isHls": True, "headers": headers, "site": "EroSync",
                    "thumbnail": video.get("thumbnail"), "duration": video.get("duration")}
        if host == "rule34video":
            src = rule34video_source(client, info["url"], max_height)
            return {"title": src["title"], "streamUrl": src["streamUrl"], "isHls": False,
                    "headers": {**headers, "Referer": info["url"]}, "site": "Rule34Video", "height": src["height"],
                    "thumbnail": src.get("thumbnail"),
                    "alternatives": src["alternatives"]}
        if host == "pixeldrain":
            m = _PIXELDRAIN_RE.match(info["url"])
            kind_, ident = m.group(1).lower(), m.group(2)
            if kind_ == "l":
                r = client.get(f"https://pixeldrain.com/api/list/{ident}")
                if r.status_code == 404:
                    raise DownloadError("notFound")
                files = [x for x in (r.json().get("files") or []) if _ext_of(x.get("name", ""), "") in VIDEO_EXTS]
                if not files:
                    raise DownloadError("noVideo")
                pick = max(files, key=lambda x: x.get("size") or 0)
                ident, name = pick["id"], pick.get("name", "")
            else:
                r = client.get(f"https://pixeldrain.com/api/file/{ident}/info")
                if r.status_code == 404:
                    raise DownloadError("notFound")
                name = (r.json() or {}).get("name", "")
            return {"title": os.path.splitext(name)[0] or "Pixeldrain", "streamUrl": f"https://pixeldrain.com/api/file/{ident}", "isHls": False, "headers": headers, "site": "Pixeldrain"}
    # A link to a video file.
    return {"title": os.path.splitext(os.path.basename(urlparse(info["url"]).path))[0] or "Video", "streamUrl": info["url"], "isHls": info["url"].lower().split("?")[0].endswith(".m3u8"), "headers": headers, "site": info["host"]}


# --- EroSync (2026-11-22) --------------------------------------------------------

def erosync_video(client: httpx.Client, url: str) -> dict:
    """{title, streamUrl, duration, tags} from EroSync's public video API (the
    one its own embed reads). DownloadError notFound / noVideo."""
    m = _EROSYNC_RE.match(url or "")
    if not m:
        raise DownloadError("unsupported")
    r = client.get(f"https://erosync.net/api/videos/{m.group(1).lower()}", headers={"Accept": "application/json"}, timeout=15)
    if r.status_code in (404, 410):
        raise DownloadError("notFound")
    if r.status_code >= 400:
        raise DownloadError("denied" if r.status_code in (401, 403) else "failed", f"HTTP {r.status_code}")
    data = r.json() or {}
    stream = data.get("streamUrl") or ""
    if data.get("status") not in (None, "ready") or not stream.startswith("https://"):
        raise DownloadError("noVideo")
    thumb = data.get("thumbnailUrl")
    return {"title": str(data.get("title") or "EroSync").strip(), "streamUrl": stream,
            "duration": data.get("duration"), "tags": [t for t in data.get("tags") or [] if isinstance(t, str)],
            "thumbnail": thumb if isinstance(thumb, str) and thumb.startswith("https://") else None}


# --- rule34video (2026-11-22) -----------------------------------------------------
# Its page carries the site's own Download buttons (360p to 1080p MP4s on
# rule34video.com/get_file/..., which redirect to the CDN copy). The site
# answers quick repeat requests with 502, so: one page, one link, then the CDN.

_R34_LINK_RE = re.compile(r'<a\b[^>]*class="[^"]*\btag_item_download\b[^"]*"[^>]*href="([^"]+)"', re.I)
_R34_FLASHVAR_RE = re.compile(r"\b(video(?:_alt)?_url\d*)\s*:\s*'((?:function/0/)?https?://[^']+)'")
_R34_HEIGHT_RE = re.compile(r"_(\d{3,4})p?\.mp4", re.I)


def rule34video_links(html: str) -> list[dict]:
    """The page's video files as [{url, height}], tallest first, one per height."""
    found: dict[int, str] = {}
    for href in _R34_LINK_RE.findall(html or ""):
        url = href.replace("&amp;", "&")
        m = _R34_HEIGHT_RE.search(url)
        if "/get_file/" in url and m:
            found.setdefault(int(m.group(1)), url)
    if not found:
        # The player's own list (plain addresses only).
        for _key, url in _R34_FLASHVAR_RE.findall(html or ""):
            m = _R34_HEIGHT_RE.search(url)
            if m and not url.startswith("function/"):
                found.setdefault(int(m.group(1)), url)
    return [{"url": u, "height": h} for h, u in sorted(found.items(), reverse=True)]


def rule34video_title(html: str) -> str:
    m = re.search(r'<meta\s+property="og:title"\s+content="([^"]*)"', html or "", re.I)         or re.search(r"<title>([^<]*)</title>", html or "", re.I)
    return html_unescape(m.group(1)).strip() if m else ""


def pick_height(items: list, max_height: Optional[int] = None) -> Optional[dict]:
    """The tallest of `items` ({height}, any order) at or under `max_height`,
    else the shortest; the tallest when there is no limit. None when empty."""
    items = [i for i in items or [] if isinstance(i, dict)]
    if not items:
        return None
    tall = sorted(items, key=lambda i: i.get("height") or 0, reverse=True)
    if not max_height:
        return tall[0]
    under = [i for i in tall if (i.get("height") or 0) <= max_height]
    return under[0] if under else tall[-1]


def rule34video_source(client: httpx.Client, page_url: str, max_height: Optional[int] = None) -> dict:
    """{title, streamUrl, height, alternatives}: the file for `max_height` (the
    tallest without one), at the CDN it redirects to; `alternatives` are every
    file's own button link, resolved by the proxy only when played (the site
    502s quick repeats, so they are not all resolved now)."""
    r = client.get(page_url)
    if r.status_code in (404, 410):
        raise DownloadError("notFound")
    if r.status_code >= 400:
        raise DownloadError("failed", f"HTTP {r.status_code}")
    links = rule34video_links(r.text)
    if not links:
        raise DownloadError("noVideo")
    best = pick_height(links, max_height)
    where = best["url"]
    for attempt in range(2):
        hop = client.get(best["url"], headers={"Referer": page_url, "Range": "bytes=0-0"}, follow_redirects=False)
        if hop.status_code in (301, 302, 303, 307, 308) and hop.headers.get("location"):
            where = urljoin(best["url"], hop.headers["location"])
            break
        if hop.status_code in (200, 206):
            break
        if attempt == 0:
            time.sleep(2)            # a 502 for a quick second request: once more
    alternatives = [{"height": l["height"], "streamUrl": where if l is best else l["url"], "lazyRedirect": l is not best}
                    for l in links]
    og = re.search(r'<meta\s+property="og:image"\s+content="(https://[^"]+)"', r.text or "", re.I)
    return {"title": rule34video_title(r.text) or "rule34video", "streamUrl": where, "height": best["height"],
            "thumbnail": html_unescape(og.group(1)) if og else None,
            "alternatives": alternatives}


# --- PMVHaven / FapTap page helpers (pure, unit-tested) ------------------------

_NUXT_DATA_RE = re.compile(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', re.S)
_NUXT_WRAPPERS = {"ShallowReactive", "Reactive", "Ref", "ShallowRef"}


def _nuxt_value(data: list, index, depth: int = 0):
    """One value of a Nuxt payload (a flat array where objects hold indexes)."""
    if not isinstance(index, int) or index < 0 or index >= len(data) or depth > 8:
        return None
    v = data[index]
    if isinstance(v, list):
        if len(v) == 2 and v[0] in _NUXT_WRAPPERS:
            return _nuxt_value(data, v[1], depth + 1)
        return [_nuxt_value(data, x, depth + 1) for x in v]
    if isinstance(v, dict):
        return {k: _nuxt_value(data, x, depth + 1) for k, x in v.items()}
    return v


def pmvhaven_video(html: str, video_id: str) -> Optional[dict]:
    """The page's video {title, videoUrl} from its __NUXT_DATA__: the object
    with a `videoUrl` whose `_id` is `video_id` (the one in the link)."""
    m = _NUXT_DATA_RE.search(html or "")
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    if not isinstance(data, list):
        return None
    for v in data:
        if isinstance(v, dict) and "videoUrl" in v and "_id" in v:
            if video_id and _nuxt_value(data, v["_id"]) != video_id:
                continue
            url = _nuxt_value(data, v["videoUrl"])
            if isinstance(url, str) and url.startswith("https://"):
                title = _nuxt_value(data, v.get("title"))
                return {"title": title if isinstance(title, str) else "", "videoUrl": url}
    return None


_OG_IMAGE_RE = re.compile(r'<meta[^>]+property="og:image"[^>]+content="(https://(vz-[a-z0-9-]+\.b-cdn\.net)/([0-9a-f-]{36})/[^"]*)"', re.I)
_OG_TITLE_RE = re.compile(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', re.I)


_HREF_RE = re.compile(r"""https?://[^\s"'<>]+""", re.I)


def faptap_script_info(data: dict) -> dict:
    """What FapTap's public video answer says about the script:
    {exists, downloadable, shops}. `shops` are the links in the description to
    where scripts are sold (Patreon, Payhip ...): FapTap itself never hands a
    script out unless the video is marked downloadable (seen 2026-11-22: a
    paid script's video says downloadable: false, and its script endpoint
    answers 401 without a login). Nothing here fetches the script."""
    script = data.get("script")
    desc = str(data.get("description") or "").replace("&amp;", "&")
    shops = []
    for url in _HREF_RE.findall(desc):
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        if host in SCRIPT_SHOPS and url not in shops:
            shops.append(url)
    return {"exists": bool(script), "downloadable": data.get("downloadable") is True, "shops": shops[:5]}


def faptap_stream(html: str) -> Optional[dict]:
    """{title, playlist} from a FapTap video page: the og:image sits in the
    video's CDN folder, beside the playlist.m3u8 the site's player plays."""
    m = _OG_IMAGE_RE.search(html or "")
    if not m:
        return None
    t = _OG_TITLE_RE.search(html or "")
    title = (t.group(1) if t else "").replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')
    title = re.sub(r"\s+-\s+Faptap$", "", title).strip()
    return {"title": title, "playlist": f"https://{m.group(2)}/{m.group(3)}/playlist.m3u8",
            "thumbnail": m.group(1)}


# --- Mega helpers (pure, unit-tested) ------------------------------------------

def _b64url(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/").replace(",", "")
    return base64.b64decode(s + "=" * (-len(s) % 4))


def mega_link_parts(url: str) -> tuple[str, str]:
    m = _MEGA_FILE_RE.match(url or "")
    if not m:
        raise DownloadError("unsupported", "not a Mega file link")
    file_id = m.group(1) or m.group(3)
    key = m.group(2) or m.group(4)
    return file_id, key


def mega_key_iv(key_b64: str) -> tuple[bytes, bytes]:
    """The 256-bit link key -> (AES-128 key, 16-byte CTR start)."""
    raw = _b64url(key_b64)
    if len(raw) != 32:
        raise DownloadError("badKey", "the Mega link's key is not 32 bytes")
    a = struct.unpack(">8I", raw)
    k = struct.pack(">4I", a[0] ^ a[4], a[1] ^ a[5], a[2] ^ a[6], a[3] ^ a[7])
    iv = struct.pack(">4I", a[4], a[5], 0, 0)
    return k, iv


def mega_folder_parts(url: str) -> tuple[str, bytes, Optional[str]]:
    """A public folder link -> (folder id, 16-byte folder key, a node inside it or None)."""
    m = _MEGA_FOLDER_PARTS_RE.match(url or "")
    if not m:
        raise DownloadError("unsupported", "not a Mega folder link")
    folder_id = m.group(1) or m.group(4)
    key = _b64url(m.group(2) or m.group(5))
    if len(key) != 16:
        raise DownloadError("badKey", "the Mega folder key is not 16 bytes")
    return folder_id, key, (m.group(3) or m.group(6) or None)


def mega_folder_nodes(client, folder_id: str, folder_key: bytes) -> list[dict]:
    """The files of a public folder: [{h, parent, name, size, aes_key, iv}].
    Each node's key is AES-ECB under the folder key; a file's 256-bit key gives
    its AES key and CTR start as a file link's does."""
    from Cryptodome.Cipher import AES
    r = client.post("https://g.api.mega.co.nz/cs", params={"id": str(int(time.time())), "n": folder_id},
                    content=json.dumps([{"a": "f", "c": 1, "r": 1, "ca": 1}]))
    answer = r.json()
    item = answer[0] if isinstance(answer, list) and answer else answer
    if isinstance(item, int):
        raise DownloadError("notFound" if item in (-9, -2, -16) else "failed", f"Mega error {item}")
    ecb = AES.new(folder_key, AES.MODE_ECB)
    out = []
    for n in (item or {}).get("f") or []:
        if not isinstance(n, dict) or n.get("t") != 0:
            continue                                   # files only (t 0); folders are 1
        enc = None
        for share in str(n.get("k") or "").split("/"):
            if ":" in share:
                enc = share.split(":", 1)[1]
                break
        if not enc:
            continue
        try:
            raw = ecb.decrypt(_b64url(enc))
        except Exception:
            continue
        if len(raw) != 32:
            continue
        a = struct.unpack(">8I", raw)
        aes_key = struct.pack(">4I", a[0] ^ a[4], a[1] ^ a[5], a[2] ^ a[6], a[3] ^ a[7])
        iv = struct.pack(">4I", a[4], a[5], 0, 0)
        out.append({"h": n.get("h"), "parent": n.get("p"), "name": mega_file_name(n.get("a", ""), aes_key) or "",
                    "size": int(n.get("s") or 0), "aes_key": aes_key, "iv": iv})
    return out


_HINT_NOISE = {"mp4", "mkv", "webm", "mov", "avi", "funscript", "the", "and", "with", "for", "1080p", "720p", "2160p",
               "480p", "4k", "60fps", "hevc", "x264", "x265", "h264", "h265", "video", "script", "full"}


def _hint_words(text: str) -> set:
    # Numbers count, one digit too: they tell Part 1 from Part 2.
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if (len(w) >= 2 or w.isdigit()) and w not in _HINT_NOISE}


def pick_by_hint(files: list[dict], hint: str = "") -> Optional[dict]:
    """Of several videos, the one whose name shares the most words with
    `hint` (the script's name; 2026-11-24: a folder can hold Part 1 and
    Part 2, each with its own script); none sharing 2 words: the biggest."""
    if not files:
        return None
    want = _hint_words(hint)
    if want:
        scored = [(len(want & _hint_words(f.get("name", ""))), f.get("size") or 0, f) for f in files]
        best = max(scored, key=lambda x: (x[0], x[1]))
        if best[0] >= 2 and sum(1 for s in scored if s[0] == best[0]) < len(scored):
            return best[2]
    return max(files, key=lambda f: f.get("size") or 0)


def mega_folder_pick(files: list[dict], inside: Optional[str] = None, hint: str = "") -> Optional[dict]:
    """The file to fetch: the one the link points at; else, in the sub-folder it
    points at (or the whole folder), the video named most like `hint`, else the
    biggest; no video: None."""
    if inside:
        for f in files:
            if f["h"] == inside:
                return f
        files = [f for f in files if f["parent"] == inside] or files
    videos = [f for f in files if _ext_of(f["name"], "") in VIDEO_EXTS]
    return pick_by_hint(videos, hint)


def mega_file_name(attr_b64: str, aes_key: bytes) -> Optional[str]:
    """The file name from Mega's encrypted attributes ('MEGA{"n": ...}')."""
    try:
        from Cryptodome.Cipher import AES
        data = _b64url(attr_b64)
        data += b"\0" * (-len(data) % 16)
        plain = AES.new(aes_key, AES.MODE_CBC, iv=b"\0" * 16).decrypt(data).rstrip(b"\0")
        if not plain.startswith(b"MEGA"):
            return None
        return json.loads(plain[4:].decode("utf-8", "replace")).get("n")
    except Exception:
        return None


manager = DownloadManager()
