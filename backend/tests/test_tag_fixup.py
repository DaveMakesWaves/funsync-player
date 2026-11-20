"""Round 3 fix-up (r3-fixup, 2026-11-18): the funscript metadata harvest and
the phone's tag slice.

- R3R-1: an odd string in a script's metadata block (a lone UTF-16 surrogate,
  valid JSON from a tool that cut an emoji in half) cost the video its speed
  stats (the harvest raised before the speed was computed) and made the
  dialog's on-demand read (/api/media/script-meta?path=) fail.
- R3R-5: two saves of the harvest cache at once shared one temp file and
  could leave a cache that is not JSON; a corrupt cache must be reported once
  and rebuilt.
- r3-verify area 2: a library Refresh did not see a script edited outside
  FunSync (each script was checked once per backend process).
- R3R-4: the phone asks "changed since version v?" at each filter-sheet open.

Every path is a synthetic file in pytest's tmp_path; the harvest cache is the
test's own (conftest.py).
"""

import builtins
import json
import logging
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport  # noqa: E402
from main import app  # noqa: E402
import routes.media as media  # noqa: E402
from routes.media import register_videos, get_video_registry, _path_to_id  # noqa: E402
from services import script_meta  # noqa: E402

ACTIONS = [{"at": 0, "pos": 0}, {"at": 500, "pos": 100}, {"at": 1000, "pos": 0}]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        yield c


def _script(path, metadata_json, actions=ACTIONS):
    """A funscript whose metadata block is raw JSON text, so an escape like
    \\ud83d stays in the file as a tool would have written it."""
    path.write_text('{"actions": %s, "metadata": %s}' % (json.dumps(actions), metadata_json), encoding="utf-8")
    return str(path)


class _NoThread:
    passes: list = []

    def __init__(self, target=None, args=(), daemon=None):
        _NoThread.passes.append(list(args[0]))

    def start(self):
        pass


@pytest.fixture
def passes(monkeypatch):
    _NoThread.passes = []
    monkeypatch.setattr(threading, "Thread", _NoThread)
    monkeypatch.setattr(media, "_queue_duration_probes", lambda: None)
    monkeypatch.setattr(media, "_speed_probe_inflight", set())
    return _NoThread.passes


def _run_all(passes):
    while passes:
        media._speed_probe_worker(passes.pop(0))


@pytest.fixture
def open_count(monkeypatch):
    counts = {}
    real_open = builtins.open

    def counting_open(file, mode="r", *args, **kwargs):
        if "r" in mode and isinstance(file, str) and file.endswith(".funscript"):
            counts[file] = counts.get(file, 0) + 1
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", counting_open)
    return counts


# --- R3R-1: the harvest never costs a video its speed ------------------------

def test_a_lone_surrogate_in_the_metadata_keeps_the_speed_and_drops_only_that_value(tmp_path, passes):
    fs = _script(tmp_path / "Cut.funscript",
                 r'{"title": "Scene \ud83d", "creator": "Scripter One", "tags": ["pov", "x\udc00"]}')
    video = str(tmp_path / "Cut.mp4")
    register_videos([{"path": video, "name": "Cut.mp4", "funscriptPath": fs}])
    _run_all(passes)
    entry = get_video_registry()[_path_to_id(video)]
    assert entry["avgSpeed"] is not None and entry["maxSpeed"] is not None
    assert script_meta.get(fs)["metadata"] == {"tags": ["pov"], "creator": "Scripter One"}
    # The cache file is written and is JSON (a lone surrogate cannot be
    # written as UTF-8; it never got in).
    script_meta.save()
    with open(script_meta.cache_path(), encoding="utf-8") as f:
        assert json.load(f)["entries"][fs]["metadata"] == {"tags": ["pov"], "creator": "Scripter One"}


def test_a_harvest_that_raises_keeps_the_speed_and_the_last_record(tmp_path, passes, monkeypatch):
    fs_file = tmp_path / "Raise.funscript"
    fs = _script(fs_file, '{"tags": ["first"]}')
    first = {"path": str(tmp_path / "Raise.mp4"), "name": "Raise.mp4", "funscriptPath": fs}
    register_videos([dict(first)])
    _run_all(passes)
    before = script_meta.get(fs)
    assert before["metadata"] == {"tags": ["first"]}

    # The file changes and the harvest itself fails on it (any bug at all);
    # a second video paired with it now has its speed probed for the first time.
    _script(fs_file, '{"tags": ["second"]}', actions=ACTIONS + [{"at": 1500, "pos": 100}])
    later = time.time() + 5
    os.utime(fs, (later, later))

    def broken(_data):
        raise RuntimeError("harvest bug")

    monkeypatch.setattr(script_meta, "harvest_metadata", broken)
    second = {"path": str(tmp_path / "Raise Copy.mp4"), "name": "Raise Copy.mp4", "funscriptPath": fs}
    register_videos([dict(first), dict(second)])
    _run_all(passes)
    entry = get_video_registry()[_path_to_id(second["path"])]
    assert entry["avgSpeed"] is not None and entry["maxSpeed"] is not None
    assert script_meta.get(fs) == before


@pytest.mark.anyio
async def test_the_dialogs_on_demand_read_answers_for_a_lone_surrogate_file(tmp_path, client, passes):
    fs = _script(tmp_path / "Cut2.funscript", r'{"tags": ["pov", "x\udc00"], "performers": ["\ud83dJane"]}')
    await client.post("/api/media/register", json={"videos": [
        {"path": str(tmp_path / "Cut2.mp4"), "name": "Cut2.mp4", "funscriptPath": fs, "avgSpeed": 1, "maxSpeed": 1},
    ]})
    resp = await client.get("/api/media/script-meta", params={"path": fs})
    assert resp.status_code == 200
    assert resp.json()["records"][fs]["metadata"] == {"tags": ["pov"]}


@pytest.mark.anyio
async def test_an_on_demand_read_that_raises_answers_the_others(tmp_path, client, monkeypatch, passes):
    good = _script(tmp_path / "Good.funscript", '{"tags": ["ok"]}')
    bad = _script(tmp_path / "Bad.funscript", '{"tags": ["x"]}')
    await client.post("/api/media/register", json={"videos": [
        {"path": str(tmp_path / "Good.mp4"), "name": "Good.mp4", "funscriptPath": good, "avgSpeed": 1, "maxSpeed": 1},
        {"path": str(tmp_path / "Bad.mp4"), "name": "Bad.mp4", "funscriptPath": bad, "avgSpeed": 1, "maxSpeed": 1},
    ]})
    real = script_meta.read_and_store

    def flaky(path):
        if path == bad:
            raise OSError("the drive went away mid-read")
        return real(path)

    monkeypatch.setattr(script_meta, "read_and_store", flaky)
    resp = await client.get("/api/media/script-meta", params=[("path", bad), ("path", good)])
    assert resp.status_code == 200
    assert resp.json()["records"][good]["metadata"] == {"tags": ["ok"]}


# --- R3R-5: saves never mix, a corrupt cache is rebuilt ----------------------

def _fill(n):
    for i in range(n):
        script_meta.put(f"C:/lib/s{i}.funscript", i, i, {"tags": [f"t{i}"], "title": "x" * 100})


def test_two_saves_at_once_write_two_temp_files_one_at_a_time(monkeypatch):
    _fill(500)
    opened = []
    inside = []
    real_open = open

    def spy_open(file, mode="r", *a, **kw):
        if "w" in mode and str(file).startswith(script_meta.cache_path()):
            opened.append(str(file))
            inside.append(threading.get_ident())
            time.sleep(0.05)              # hold the write open: a second save would overlap here
        return real_open(file, mode, *a, **kw)

    monkeypatch.setattr("builtins.open", spy_open)
    started = threading.Barrier(2)

    def one():
        started.wait(5)
        with script_meta._lock:
            script_meta._dirty = max(script_meta._dirty, 1)
        script_meta.save()

    threads = [threading.Thread(target=one) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    monkeypatch.setattr("builtins.open", real_open)
    assert len(opened) == 2 and opened[0] != opened[1], opened
    with open(script_meta.cache_path(), encoding="utf-8") as f:
        assert len([p for p in json.load(f)["entries"] if p.startswith("C:/lib/s")]) == 500
    assert not [p for p in os.listdir(os.path.dirname(script_meta.cache_path())) if ".tmp-" in p]


def test_a_save_that_starts_while_another_writes_leaves_the_newest_cache(monkeypatch):
    """Save A is half way through writing when a put and save B come: B waits
    for A, and the file left is JSON and holds B's entry."""
    import json as real_json
    _fill(300)
    script_meta.save()
    a_half = threading.Event()
    who = threading.local()

    class Shim:
        load = staticmethod(real_json.load)

        @staticmethod
        def dump(obj, f, **kw):
            text = real_json.dumps(obj, **kw)
            if getattr(who, "name", "") == "A":
                f.write(text[: len(text) // 2]); f.flush()
                a_half.set()
                time.sleep(0.2)             # B tries to save meanwhile
                f.write(text[len(text) // 2:]); f.flush()
            else:
                f.write(text)

    monkeypatch.setattr(script_meta, "json", Shim)

    def a():
        who.name = "A"
        with script_meta._lock:
            script_meta._dirty = max(script_meta._dirty, 1)
        script_meta.save()

    def b():
        who.name = "B"
        a_half.wait(5)
        script_meta.put("C:/lib/zz-new.funscript", 1, 1, {"tags": ["new"]})
        script_meta.save()

    ta, tb = threading.Thread(target=a), threading.Thread(target=b)
    ta.start(); tb.start(); ta.join(); tb.join()
    monkeypatch.setattr(script_meta, "json", real_json)
    with open(script_meta.cache_path(), encoding="utf-8") as f:
        entries = real_json.load(f)["entries"]
    assert "C:/lib/zz-new.funscript" in entries
    assert len([p for p in entries if p.startswith("C:/lib/")]) == 301


def test_a_corrupt_cache_is_reported_once_and_rebuilt(tmp_path, caplog):
    path = tmp_path / "cache.json"
    path.write_text('{"version": 1, "entries": {"a": {"size": 1, "mti', encoding="utf-8")   # a torn write
    script_meta._reset_for_tests(str(path))
    with caplog.at_level(logging.WARNING, logger="funsync.script_meta"):
        assert script_meta.records() == {}
        assert script_meta.records() == {}
        assert script_meta.get("a") is None
    reports = [r for r in caplog.records if "not usable" in r.getMessage()]
    assert len(reports) == 1
    # Rebuilt: the next save writes a good file over it, even with nothing new.
    script_meta.save()
    with open(path, encoding="utf-8") as f:
        assert json.load(f) == {"version": 1, "entries": {}}
    script_meta.put("C:/lib/a.funscript", 1, 2, {"tags": ["back"]})
    script_meta.save()
    script_meta._reset_for_tests(str(path))
    assert script_meta.get("C:/lib/a.funscript")["metadata"] == {"tags": ["back"]}


def test_a_cache_too_deep_or_holding_lone_surrogates_never_crashes(tmp_path):
    path = tmp_path / "deep.json"
    path.write_text("[" * 100000 + "]" * 100000, encoding="utf-8")
    script_meta._reset_for_tests(str(path))
    assert script_meta.records() == {}
    # A hand-edited cache with a lone surrogate: loaded through the harvest's
    # rules, so it can be served and saved again.
    path.write_text(json.dumps({"version": 1, "entries": {
        "C:/lib/x.funscript": {"size": 1, "mtime": 2, "readAt": 3, "metadata": {"tags": ["ok", "bad\ud83d"], "title": "\udc00"}},
    }}), encoding="utf-8")
    script_meta._reset_for_tests(str(path))
    assert script_meta.get("C:/lib/x.funscript")["metadata"] == {"tags": ["ok"]}
    json.dumps(script_meta.records()).encode("utf-8")


# --- r3-verify area 2: a Refresh sees a script edited outside FunSync -------

def test_a_refresh_reads_an_edited_script_again_without_a_restart(tmp_path, passes, open_count):
    fs_file = tmp_path / "Edit.funscript"
    fs = _script(fs_file, '{"tags": ["before"]}')
    video = {"path": str(tmp_path / "Edit.mp4"), "name": "Edit.mp4", "funscriptPath": fs, "avgSpeed": 5, "maxSpeed": 9}
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs)["metadata"] == {"tags": ["before"]}
    assert open_count[fs] == 1

    # A Refresh with nothing changed: a stat, no read.
    register_videos([dict(video)])
    _run_all(passes)
    assert open_count[fs] == 1

    # Edited in another tool, then Refresh (same backend process).
    _script(fs_file, '{"tags": ["after", "edited"]}')
    later = time.time() + 5
    os.utime(fs, (later, later))
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs)["metadata"] == {"tags": ["after", "edited"]}
    assert open_count[fs] == 2


@pytest.mark.anyio
async def test_the_edit_reaches_a_reader_asking_only_for_changes(tmp_path, passes, client):
    fs_file = tmp_path / "Seen.funscript"
    fs = _script(fs_file, '{"tags": ["one"]}')
    video = {"path": str(tmp_path / "Seen.mp4"), "name": "Seen.mp4", "funscriptPath": fs, "avgSpeed": 5, "maxSpeed": 9}
    register_videos([dict(video)])
    _run_all(passes)
    first = (await client.get("/api/media/script-meta")).json()
    since, cache = first["seq"], first["cacheId"]

    register_videos([dict(video)])                    # unchanged: nothing new to send
    _run_all(passes)
    same = (await client.get("/api/media/script-meta", params={"since": since, "cache": cache})).json()
    assert same["records"] == {}

    _script(fs_file, '{"tags": ["two"]}')
    later = time.time() + 5
    os.utime(fs, (later, later))
    register_videos([dict(video)])
    _run_all(passes)
    changed = (await client.get("/api/media/script-meta", params={"since": since, "cache": cache})).json()
    assert changed["records"][fs]["metadata"] == {"tags": ["two"]}


# --- R3R-2 / R3R-1 on the slice: junk text never breaks the phone's answer ---

@pytest.mark.anyio
async def test_a_lone_surrogate_in_the_slice_never_breaks_the_phones_answer(tmp_path, client):
    a = str(tmp_path / "A.mp4")
    await client.post("/api/media/register", json={"videos": [{"path": a, "name": "A.mp4"}]})
    body = '{"videoTags": {"%s": [{"key": "content:x\\ud83d"}, {"key": "content:ok", "facet": "content", "label": "o\\udc00k"}]}}' % a.replace("\\", "\\\\")
    resp = await client.post("/api/media/register", content=body, headers={"Content-Type": "application/json"})
    assert resp.status_code == 200
    tags = await client.get("/api/remote/tags")
    assert tags.status_code == 200
    assert tags.json()["videoTags"] == {a: ["content:ok"]}
    assert tags.json()["tags"][0]["label"] == "ok"


# --- R3R-4: the phone's version check --------------------------------------

@pytest.mark.anyio
async def test_the_phone_asks_whether_the_slice_changed(tmp_path, client):
    a = str(tmp_path / "A.mp4")
    await client.post("/api/media/register", json={"videos": [{"path": a, "name": "A.mp4"}]})
    await client.post("/api/media/register", json={"videoTags": {a: [{"key": "content:pov"}]}})
    first = (await client.get("/api/remote/tags")).json()
    v1 = first["version"]
    assert first["videoTags"] == {a: ["content:pov"]}

    # Nothing changed: a few bytes, no slice.
    assert (await client.get("/api/remote/tags", params={"version": v1})).json() == {"version": v1, "unchanged": True}
    # The same slice sent again changes nothing either.
    await client.post("/api/media/register", json={"videoTags": {a: [{"key": "content:pov"}]}})
    assert (await client.get("/api/remote/tags", params={"version": v1})).json()["unchanged"] is True

    # A tag added on the desktop: the full answer, with a new version.
    await client.post("/api/media/register", json={"videoTags": {a: [{"key": "content:pov"}, {"key": "content:solo"}]}})
    second = (await client.get("/api/remote/tags", params={"version": v1})).json()
    assert second["videoTags"] == {a: ["content:pov", "content:solo"]} and second["version"] != v1

    # A new registration (a scan): the answer may differ, so the version moves.
    await client.post("/api/media/register", json={"videos": [{"path": a, "name": "A.mp4"}]})
    third = (await client.get("/api/remote/tags", params={"version": second["version"]})).json()
    assert "videoTags" in third and third["version"] != second["version"]
    # An unknown or junk version is a full answer.
    assert "videoTags" in (await client.get("/api/remote/tags", params={"version": "nope"})).json()
