"""The funscript files' own metadata, harvested for the tag engine (P1 tags).

A funscript can carry a `metadata` block: who made it (`creator` /
`author`), its tags (`tags`, `topic_tags`), its performers, the post it came
from (`script_url`, `topic_url`, a `discuss.eroscripts.com/t/<slug>/<id>`
link in either) and its video (`video_url`, `videoSourceUrl`). FunSync read
none of it for the library (PLAN-next-major-2026-11.md 2.1: 33 of 193
scripts on Dave's C: carry tags).

The backend already parses every associated funscript off the event loop for
its speed stats (`routes/media.py` `_speed_probe_worker`). That pass now also
hands the parsed file to `harvest_metadata` and keeps the result here, so the
metadata costs no second read of the file. The renderer turns each record
into the tag engine's `funscript` source with
`renderer/js/video-tags.js` `funscriptMetaRecord(record.metadata, record.readAt)`
(renderer/js/script-meta-store.js).

Rules:
- The cache is a SEPARATE file next to ffmpeg.py's metadata cache (the temp
  folder `funsync_thumbs`), never config.json, never a backup: it is rebuilt
  from the files (DESIGN-video-options.md (e)).
- An entry is keyed by the script's path and remembers the file's size and
  mtime, so a changed script is read again and an unchanged one never is.
- Absence is never destructive. Only a successful parse writes an entry. A
  script that is missing, unreadable or not JSON keeps its last record, and
  nothing is ever pruned because a file is gone (only the oldest entries past
  CACHE_MAX_ENTRIES, like the metadata cache). A parse that finds no
  metadata block stores `metadata: None`: that is the file's own answer, not
  an absence.
- What a file may put in an entry is capped (lists, text, URLs) with the same
  limits as `funscriptMetaRecord`, which caps again: a file with 200,000 tags
  or a 5 MB title cannot bloat the cache or the renderer.
- A string that is not well-formed text (a lone UTF-16 surrogate such as
  `"\\ud83d"`, valid JSON from a tool that cut an emoji in half) is unusable,
  like a non-string: left out here and in `funscriptMetaRecord` alike, so the
  two ports agree, and it can never reach a JSON answer or the cache file
  (r3-fixup R3R-1, 2026-11-18).
- Saves run one at a time (`_save_lock`) and each writes its own temp file
  before `os.replace`, so two saves at once can never mix their bytes. A
  cache file that is not JSON is reported once in the log and rebuilt from
  the files (r3-fixup R3R-5).
"""

from __future__ import annotations

import atexit
import itertools
import json
import logging
import os
import secrets
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urlsplit

# The renderer's limits (video-tags.js MAX_META_LIST / MAX_META_TEXT /
# MAX_META_URL, and stringList's 4 x MAX_META_LIST scan). Keep in step.
MAX_META_LIST = 200
MAX_META_SCAN = 4 * MAX_META_LIST
MAX_META_TEXT = 200
MAX_META_URL = 2048

TOPIC_HOST = "discuss.eroscripts.com"
_MAX_SAFE_INTEGER = 2 ** 53 - 1   # JS Number.isSafeInteger

CACHE_VERSION = 1
# Entries are small (most scripts carry no metadata: `{"metadata": null}`).
# 20,000 covers ten times Dave's 2,318 scripts; past it the oldest-inserted go
# first on save, as in the metadata cache.
CACHE_MAX_ENTRIES = 20000
CACHE_SAVE_BATCH = 100        # a long first pass saves every N new entries

# What JS String.prototype.trim() removes (WhiteSpace + LineTerminator).
# Python's str.strip() differs (it strips \x1c-\x1f and \x85, keeps ﻿),
# and a value the renderer would keep must never be dropped here.
_JS_WHITESPACE = (
    "\t\n\v\f\r          "
    "        　﻿"
)

# The metadata keys the tag engine reads, by kind.
_LIST_KEYS = ("tags", "topic_tags", "performers")
_TEXT_KEYS = ("creator", "author", "topic_creator", "title")
_URL_KEYS = ("topic_url", "script_url", "video_url", "videoSourceUrl")


log = logging.getLogger("funsync.script_meta")


def _well_formed(text: str) -> bool:
    """JS `String.prototype.isWellFormed()`: no lone UTF-16 surrogate. Python
    decodes a JSON `"\\ud83d"` (half an emoji) to a lone surrogate, which no
    UTF-8 encoder (a JSON answer, the cache file) accepts."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _js_length(text: str) -> int:
    """`text.length` as JavaScript counts it (UTF-16 code units). Never
    raises: a lone surrogate counts as the one unit JS counts."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _js_trim(text: str) -> str:
    return text.strip(_JS_WHITESPACE)


def _ok_item(item: Any) -> bool:
    return (isinstance(item, str) and bool(_js_trim(item)) and _js_length(item) <= MAX_META_TEXT
            and _well_formed(item))


def _string_list(value: Any) -> list[str]:
    """video-tags.js `stringList` + its de-duplication and cap: strings only,
    non-blank, at most MAX_META_TEXT long, the first MAX_META_SCAN items
    looked at, duplicates dropped (first one kept), MAX_META_LIST kept."""
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, list):
        items = value[:MAX_META_SCAN]
    else:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not _ok_item(item) or item in seen:
            continue
        seen.add(item)
        out.append(item)
        if len(out) >= MAX_META_LIST:
            break
    return out


def _short_text(value: Any, limit: int) -> str | None:
    """A non-blank string no longer than `limit`, as the file wrote it (the
    renderer trims); anything else is left out, never cut short."""
    if (not isinstance(value, str) or not _js_trim(value) or _js_length(value) > limit
            or not _well_formed(value)):
        return None
    return value


def topic_id_from(url: Any) -> int | None:
    """The forum topic id of a `discuss.eroscripts.com/t/<id>` or
    `/t/<slug>/<id>` link (a post number after it is fine). The forum's own
    host only, http(s) only, a whole number that fits. Never fetched.
    Port of video-tags.js `topicIdFrom`."""
    if not isinstance(url, str) or _js_length(url) > MAX_META_URL or not _well_formed(url):
        return None
    try:
        parts = urlsplit(_js_trim(url))
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or (host or "").lower() != TOPIC_HOST:
        return None
    segments = [s for s in parts.path.split("/") if s]
    if len(segments) < 2 or segments[0] != "t":
        return None

    def _digits(s: str) -> bool:
        return 1 <= len(s) <= 15 and s.isascii() and s.isdigit()

    raw = segments[1] if _digits(segments[1]) else (segments[2] if len(segments) > 2 and _digits(segments[2]) else None)
    if raw is None:
        return None
    topic_id = int(raw)
    return topic_id if 0 < topic_id <= _MAX_SAFE_INTEGER else None


def harvest_metadata(data: Any) -> dict | None:
    """The tag engine's fields of a parsed funscript's `metadata` block.

    Returns the block's own keys (`tags`, `topic_tags`, `performers`,
    `creator`, `author`, `topic_creator`, `title`, `topic_url`, `script_url`,
    `video_url`, `videoSourceUrl`), each capped and only when usable, so the
    renderer's `funscriptMetaRecord` reads it as it would the file. None when
    the file has no metadata object. A block with none of these fields gives
    `{}`: read, and nothing to say.
    """
    if not isinstance(data, dict):
        return None
    meta = data.get("metadata")
    if not isinstance(meta, dict):
        return None
    out: dict[str, Any] = {}
    for key in _LIST_KEYS:
        values = _string_list(meta.get(key))
        if values:
            out[key] = values
    for key in _TEXT_KEYS:
        text = _short_text(meta.get(key), MAX_META_TEXT)
        if text is not None:
            out[key] = text
    for key in _URL_KEYS:
        text = _short_text(meta.get(key), MAX_META_URL)
        if text is not None:
            out[key] = text
    return out


def record_topic_id(metadata: dict | None) -> int | None:
    """The topic id a harvested block names (`topic_url` first, then
    `script_url`), as funscriptMetaRecord picks it."""
    if not isinstance(metadata, dict):
        return None
    return topic_id_from(metadata.get("topic_url")) or topic_id_from(metadata.get("script_url"))


# ---------------------------------------------------------------------------
# The cache
# ---------------------------------------------------------------------------

_lock = threading.Lock()
# Held across a whole save (snapshot, write, replace) so saves run one at a
# time and a later snapshot is never replaced by an earlier one. Order:
# _save_lock, then _lock; nothing takes them the other way round.
_save_lock = threading.Lock()
_tmp_names = itertools.count(1)   # a temp file name per save, never shared
_corrupt_reported = False
_entries: dict[str, dict] = {}
_loaded = False
_dirty = 0
_seq = 0                     # bumps on every stored change, per process
_cache_id = secrets.token_hex(8)   # a new process starts a new sequence
_cache_path_override: str | None = None


def default_cache_path() -> str:
    """Next to ffmpeg.py's `metadata-cache-v1.json` (same temp folder: if the
    OS cleans temp, both rebuild)."""
    return os.path.join(tempfile.gettempdir(), "funsync_thumbs", "script-meta-cache-v1.json")


def set_cache_path(path: str | None) -> None:
    """Point the cache at another file (tests). None: the default."""
    global _cache_path_override
    _cache_path_override = path


def cache_path() -> str:
    return _cache_path_override or default_cache_path()


def _valid_entry(value: Any) -> bool:
    return (isinstance(value, dict)
            and isinstance(value.get("size"), int)
            and isinstance(value.get("mtime"), int)
            and (value.get("metadata") is None or isinstance(value.get("metadata"), dict)))


def _report_corrupt(reason: str) -> None:
    """Say once per process that the cache file was not usable."""
    global _corrupt_reported
    if _corrupt_reported:
        return
    _corrupt_reported = True
    log.warning("script-meta cache %s is not usable (%s); rebuilding it from the scripts", cache_path(), reason)


def _load_locked() -> None:
    """Fill the cache from disk, once. Missing, unreadable or another
    version: start empty (the files are the truth; the cache only saves
    reads). Corrupt (not JSON, not the cache's shape): start empty, say so
    once, and mark the cache dirty so the next save writes a good file over
    it (rebuilt as the pass reads the scripts again). Never raises."""
    global _loaded, _dirty
    if _loaded:
        return
    _loaded = True
    try:
        with open(cache_path(), encoding="utf-8") as f:
            payload = json.load(f)
    except OSError:
        return
    except (ValueError, RecursionError) as e:   # not JSON (a torn or mixed write), not UTF-8, too deep
        _report_corrupt(type(e).__name__)
        _dirty = max(_dirty, 1)
        return
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), dict):
        _report_corrupt("not a cache object")
        _dirty = max(_dirty, 1)
        return
    if payload.get("version") != CACHE_VERSION:
        return
    for path, value in payload["entries"].items():
        if not (isinstance(path, str) and path and _well_formed(path) and _valid_entry(value)):
            continue
        value = dict(value)
        # The file is outside this process's control: what it holds goes
        # through the harvest's own rules again (caps, well-formed text).
        if isinstance(value.get("metadata"), dict):
            value["metadata"] = harvest_metadata({"metadata": value["metadata"]})
        value["seq"] = 0
        _entries[path] = value


def is_fresh(path: str, size: int, mtime_ns: int) -> bool:
    """True when the cache holds a record read from this exact file version."""
    with _lock:
        _load_locked()
        entry = _entries.get(path)
        return bool(entry) and entry.get("size") == size and entry.get("mtime") == mtime_ns


def put(path: str, size: int, mtime_ns: int, metadata: dict | None, read_at: int | None = None) -> bool:
    """Store a SUCCESSFUL parse of `path`. Returns True when the stored
    record changed (another file version, or other metadata)."""
    global _dirty, _seq
    if not isinstance(path, str) or not path:
        return False
    if metadata is not None and not isinstance(metadata, dict):
        metadata = None
    with _lock:
        _load_locked()
        old = _entries.get(path)
        if (old and old.get("size") == size and old.get("mtime") == mtime_ns
                and old.get("metadata") == metadata):
            return False
        _seq += 1
        _entries[path] = {
            "size": int(size),
            "mtime": int(mtime_ns),
            "readAt": int(read_at if read_at is not None else time.time() * 1000),
            "metadata": metadata,
            "seq": _seq,
        }
        _dirty += 1
        batch = _dirty >= CACHE_SAVE_BATCH
    if batch:
        save()
    return True


def touch(path: str) -> None:
    """Mark a record as news without changing it: a script the library
    pairs again (or for the first time this process) is sent to a reader
    that asks only for what changed since its last answer."""
    global _seq
    with _lock:
        _load_locked()
        entry = _entries.get(path)
        if entry is not None:
            _seq += 1
            entry["seq"] = _seq


def _public(entry: dict) -> dict:
    metadata = entry.get("metadata")
    return {
        "metadata": metadata,
        "readAt": entry.get("readAt"),
        "topicId": record_topic_id(metadata),
    }


def records(paths=None, since: int = 0) -> dict[str, dict]:
    """The stored records `{path: {metadata, readAt, topicId}}` for `paths`
    (any iterable; None: every entry), only those stored after `since`."""
    with _lock:
        _load_locked()
        if paths is None:
            items = list(_entries.items())
        else:
            items = [(p, _entries[p]) for p in paths if isinstance(p, str) and p in _entries]
        return {p: _public(e) for p, e in items if since <= 0 or (e.get("seq") or 0) > since}


def get(path: str) -> dict | None:
    with _lock:
        _load_locked()
        entry = _entries.get(path)
        return _public(entry) if entry else None


def state() -> dict:
    """`{cacheId, seq}`: a reader passes them back to ask only for changes."""
    with _lock:
        return {"cacheId": _cache_id, "seq": _seq}


def cache_id() -> str:
    return _cache_id


def save(force: bool = True) -> None:
    """Write the cache if anything changed. Atomic: the snapshot goes to a
    temp file of its own (`<cache>.tmp-<pid>-<n>`, a new name per save) and
    then replaces the cache in one `os.replace`. Saves run one at a time
    (`_save_lock`), so two threads saving at once (a worker's last save, a
    batch save, the dialog's on-demand read) never write one file together,
    and the newest snapshot is the one left on disk. A failed write is
    dropped and its temp file removed (worst case: files are read again)."""
    global _dirty
    with _save_lock:
        with _lock:
            if _dirty == 0 or (not force and _dirty < CACHE_SAVE_BATCH):
                return
            excess = len(_entries) - CACHE_MAX_ENTRIES
            if excess > 0:
                for key in list(_entries)[:excess]:
                    del _entries[key]
            snapshot = {
                "version": CACHE_VERSION,
                "entries": {
                    p: {k: e.get(k) for k in ("size", "mtime", "readAt", "metadata")}
                    for p, e in _entries.items()
                },
            }
            dirty_was = _dirty
            _dirty = 0
            path = cache_path()
            tmp_path = f"{path}.tmp-{os.getpid()}-{next(_tmp_names)}"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, ensure_ascii=False)
            os.replace(tmp_path, path)
        except (OSError, ValueError):
            # ValueError: text no UTF-8 file can hold (never stored: every
            # put goes through the harvest's well-formed check).
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            with _lock:
                _dirty = max(_dirty, dirty_was)   # the next save tries again


atexit.register(lambda: save(force=True))


def read_and_store(path: str) -> bool:
    """Read one script now and store its metadata (the dialog's on-demand
    read, when the cache has nothing fresh). False, with the old record
    kept, when the file cannot be stat'ed, read or parsed."""
    try:
        st = os.stat(path)
    except OSError:
        return False
    if is_fresh(path, st.st_size, st.st_mtime_ns):
        return True
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError, RecursionError):
        return False
    try:
        metadata = harvest_metadata(data)
    except Exception:  # noqa: BLE001 - an odd file never fails the dialog's read
        log.warning("script-meta harvest failed for %s", path, exc_info=True)
        return False
    put(path, st.st_size, st.st_mtime_ns, metadata)
    return True


def _reset_for_tests(path: str | None = None) -> None:
    """Forget everything in memory (a backend restart) and point the cache
    at `path`. The file on disk is left alone."""
    global _loaded, _dirty, _seq, _cache_id, _corrupt_reported
    with _lock:
        _entries.clear()
        _loaded = False
        _dirty = 0
        _seq = 0
        _cache_id = secrets.token_hex(8)
        _corrupt_reported = False
    set_cache_path(path)
