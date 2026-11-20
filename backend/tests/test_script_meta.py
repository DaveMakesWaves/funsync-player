"""The funscript metadata harvest (P1 tags, Round 3, 2026-11-18).

The backend's speed pass (`routes/media.py` `_speed_probe_worker`) already
parses every associated funscript off the event loop. It now also keeps each
file's own metadata (creator, tags, the post link) in a separate cache file,
keyed by the script's path, size and mtime, and `/api/media/script-meta`
hands it to the desktop's tag engine. These tests assert what reaches that
endpoint and the cache file: the records, what a changed / missing / broken
script does to them, and how many times a file is opened.

Every file name here is synthetic. The cache file is the test's own
(conftest.py points it at tmp_path).
"""

import builtins
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport  # noqa: E402
from main import app  # noqa: E402
import routes.media as media  # noqa: E402
from routes.media import register_videos, get_video_registry, _path_to_id  # noqa: E402
from services import script_meta  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "script-meta-harvest.json")
PLACEHOLDERS = {
    "@@LONG201@@": "x" * 201,
    "@@LONG200@@": "y" * 200,
    "@@EMOJI100@@": "\U0001F600" * 100,
    "@@EMOJI101@@": "\U0001F600" * 101,
}


def _expand(value):
    if isinstance(value, str):
        return PLACEHOLDERS.get(value, value)
    if isinstance(value, list):
        return [_expand(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    return value


with open(FIXTURE, encoding="utf-8") as _f:
    CASES = [_expand(c) for c in json.load(_f)["cases"]]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        yield c


def _lan_client():
    transport = ASGITransport(app=app, client=("192.168.1.50", 50000))
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:5123")


def _write(path, metadata=None, bom=False, actions=None, raw=None):
    if raw is None:
        body = {"version": "1.0", "actions": actions or [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}]}
        if metadata is not None:
            body["metadata"] = metadata
        raw = json.dumps(body)
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + raw.encode("utf-8"))
    return str(path)


class _NoThread:
    """threading.Thread stand-in: records each pass; the test runs it."""
    passes: list = []

    def __init__(self, target=None, args=(), daemon=None):
        _NoThread.passes.append(list(args[0]))

    def start(self):
        pass


@pytest.fixture
def passes(monkeypatch):
    import threading
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
    """How many times each path was opened for reading."""
    counts = {}
    real_open = builtins.open

    def counting_open(file, mode="r", *args, **kwargs):
        if "r" in mode and isinstance(file, str) and file.endswith(".funscript"):
            counts[file] = counts.get(file, 0) + 1
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", counting_open)
    return counts


# --- The harvest of one parsed file (shared fixture with the renderer) -------

@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_harvest_matches_the_shared_table(case):
    harvested = script_meta.harvest_metadata(case["file"])
    assert harvested == case["harvested"]
    assert script_meta.record_topic_id(harvested) == case["topicId"]


def test_a_huge_tag_list_is_capped_and_only_its_first_items_are_looked_at():
    tags = [f"tag-{i}" for i in range(200_000)]
    out = script_meta.harvest_metadata({"metadata": {"tags": tags, "topic_tags": ["a"] * 5000}})
    assert out["tags"] == tags[:script_meta.MAX_META_LIST]
    assert out["topic_tags"] == ["a"]          # 5,000 copies of one tag are one tag
    # Past the first 800 nothing is read, even when those were all junk.
    junk_first = [None] * script_meta.MAX_META_SCAN + ["late"]
    assert "tags" not in script_meta.harvest_metadata({"metadata": {"tags": junk_first}})


def test_non_dict_files_have_no_metadata():
    for data in ([], "text", 3, None, [{"metadata": {"tags": ["x"]}}]):
        assert script_meta.harvest_metadata(data) is None


# --- The speed pass harvests from the same read -------------------------------

@pytest.mark.anyio
async def test_a_bom_script_is_harvested_and_served(tmp_path, passes, client):
    fs = _write(tmp_path / "Scene One.funscript", {
        "creator": "Scripter One", "tags": ["POV", "Blowjob"],
        "script_url": "https://discuss.eroscripts.com/t/scene-one/321",
    }, bom=True)
    video = str(tmp_path / "Scene One.mp4")
    register_videos([{"path": video, "name": "Scene One.mp4", "funscriptPath": fs}])
    _run_all(passes)

    assert get_video_registry()[_path_to_id(video)]["avgSpeed"] == 250   # speed still works
    body = (await client.get("/api/media/script-meta")).json()
    rec = body["records"][fs]
    assert rec["metadata"] == {
        "tags": ["POV", "Blowjob"], "creator": "Scripter One",
        "script_url": "https://discuss.eroscripts.com/t/scene-one/321",
    }
    assert rec["topicId"] == 321
    assert isinstance(rec["readAt"], int) and rec["readAt"] > 0
    assert body["pending"] == 0
    assert body["registered"] == 1


def test_one_read_per_script_for_speed_and_tags(tmp_path, passes, open_count):
    fs = _write(tmp_path / "A.funscript", {"tags": ["x"]})
    register_videos([{"path": str(tmp_path / "A.mp4"), "name": "A.mp4", "funscriptPath": fs}])
    _run_all(passes)
    assert open_count.get(fs) == 1
    assert script_meta.get(fs)["metadata"] == {"tags": ["x"]}


def test_a_video_with_known_speed_is_read_once_for_its_tags_and_its_speed_is_kept(tmp_path, passes, open_count):
    """The desktop sends cached speed stats, so the speed pass skips the
    video; the harvest still needs the file once. Its speed is not touched."""
    fs = _write(tmp_path / "B.funscript", {"tags": ["pov"]})
    video = str(tmp_path / "B.mp4")
    register_videos([{"path": video, "name": "B.mp4", "funscriptPath": fs, "avgSpeed": 77, "maxSpeed": 99}])
    assert passes == [[(None, fs)]]            # metadata-only
    _run_all(passes)
    entry = get_video_registry()[_path_to_id(video)]
    assert (entry["avgSpeed"], entry["maxSpeed"]) == (77, 99)
    assert script_meta.get(fs)["metadata"] == {"tags": ["pov"]}
    assert open_count.get(fs) == 1

    # Registered again (an association elsewhere, a VR mark, a Refresh): a
    # stat of the script (r3-fixup: an edit made outside FunSync is seen on
    # the next Refresh), and no read while it is unchanged.
    register_videos([{"path": video, "name": "B.mp4", "funscriptPath": fs, "avgSpeed": 77, "maxSpeed": 99}])
    assert passes == [[(None, fs)]]
    _run_all(passes)
    assert open_count.get(fs) == 1
    entry = get_video_registry()[_path_to_id(video)]
    assert (entry["avgSpeed"], entry["maxSpeed"]) == (77, 99)


def test_an_unchanged_script_is_not_read_again_after_a_restart(tmp_path, passes, open_count):
    fs = _write(tmp_path / "C.funscript", {"tags": ["kept"]})
    video = {"path": str(tmp_path / "C.mp4"), "name": "C.mp4", "funscriptPath": fs, "avgSpeed": 10, "maxSpeed": 20}
    register_videos([dict(video)])
    _run_all(passes)
    assert open_count.get(fs) == 1
    assert os.path.isfile(script_meta.cache_path())          # saved after the pass

    # A new backend process: memory empty, the cache file read back.
    script_meta._reset_for_tests(script_meta.cache_path())
    media._meta_checked.clear()
    register_videos([dict(video)])
    _run_all(passes)
    assert open_count.get(fs) == 1, "an unchanged script was read again"
    assert script_meta.get(fs)["metadata"] == {"tags": ["kept"]}


def test_a_changed_script_is_read_again(tmp_path, passes):
    fs_file = tmp_path / "D.funscript"
    fs = _write(fs_file, {"tags": ["old"]})
    video = {"path": str(tmp_path / "D.mp4"), "name": "D.mp4", "funscriptPath": fs, "avgSpeed": 1, "maxSpeed": 1}
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs)["metadata"] == {"tags": ["old"]}

    _write(fs_file, {"tags": ["new", "more"]})
    later = time.time() + 5
    os.utime(fs, (later, later))
    script_meta._reset_for_tests(script_meta.cache_path())   # restart: the cache holds the old version
    media._meta_checked.clear()
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs)["metadata"] == {"tags": ["new", "more"]}


def test_a_missing_or_broken_script_keeps_its_last_record(tmp_path, passes):
    fs_file = tmp_path / "E.funscript"
    fs = _write(fs_file, {"tags": ["survives"], "creator": "Someone"})
    video = {"path": str(tmp_path / "E.mp4"), "name": "E.mp4", "funscriptPath": fs, "avgSpeed": 1, "maxSpeed": 1}
    register_videos([dict(video)])
    _run_all(passes)
    before = script_meta.get(fs)

    # Broken: not JSON any more (a half-written save), and a newer mtime.
    fs_file.write_bytes(b'{"actions": [ {"at": 0, ')
    later = time.time() + 5
    os.utime(fs, (later, later))
    media._meta_checked.clear()
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs) == before

    # Missing: the drive is unplugged.
    fs_file.unlink()
    media._meta_checked.clear()
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs) == before
    script_meta.save()
    on_disk = json.loads(open(script_meta.cache_path(), encoding="utf-8").read())
    assert on_disk["entries"][fs]["metadata"] == {"tags": ["survives"], "creator": "Someone"}


def test_a_script_read_with_no_metadata_says_so(tmp_path, passes):
    """The file's own answer ("none") is stored as `metadata: None`, so a
    script whose tags were removed stops giving them."""
    fs_file = tmp_path / "F.funscript"
    fs = _write(fs_file, {"tags": ["gone-soon"]})
    video = {"path": str(tmp_path / "F.mp4"), "name": "F.mp4", "funscriptPath": fs, "avgSpeed": 1, "maxSpeed": 1}
    register_videos([dict(video)])
    _run_all(passes)
    _write(fs_file, None)
    later = time.time() + 5
    os.utime(fs, (later, later))
    media._meta_checked.clear()
    register_videos([dict(video)])
    _run_all(passes)
    assert script_meta.get(fs)["metadata"] is None


def test_a_corrupt_cache_file_starts_empty(tmp_path):
    path = tmp_path / "corrupt.json"
    path.write_text("{not json", encoding="utf-8")
    script_meta._reset_for_tests(str(path))
    assert script_meta.records() == {}
    path.write_text(json.dumps({"version": 99, "entries": {"x": {}}}), encoding="utf-8")
    script_meta._reset_for_tests(str(path))
    assert script_meta.records() == {}
    path.write_text(json.dumps({"version": 1, "entries": {
        "ok.funscript": {"size": 1, "mtime": 2, "readAt": 3, "metadata": {"tags": ["a"]}},
        "bad.funscript": {"size": "1", "mtime": 2, "metadata": {}},
        "worse.funscript": "junk",
    }}), encoding="utf-8")
    script_meta._reset_for_tests(str(path))
    assert list(script_meta.records()) == ["ok.funscript"]


# --- The endpoint --------------------------------------------------------------

@pytest.mark.anyio
async def test_since_and_cache_id_send_only_what_changed(tmp_path, passes, client):
    a = _write(tmp_path / "A.funscript", {"tags": ["a"]})
    b = _write(tmp_path / "B.funscript", {"tags": ["b"]})
    register_videos([
        {"path": str(tmp_path / "A.mp4"), "name": "A.mp4", "funscriptPath": a},
        {"path": str(tmp_path / "B.mp4"), "name": "B.mp4", "funscriptPath": b},
    ])
    first_pass = passes.pop(0)
    media._speed_probe_worker(first_pass[:1])          # A only, so far
    first = (await client.get("/api/media/script-meta")).json()
    assert set(first["records"]) == {a}
    assert first["pending"] == 1

    media._speed_probe_worker(first_pass[1:])
    params = {"since": first["seq"], "cache": first["cacheId"]}
    second = (await client.get("/api/media/script-meta", params=params)).json()
    assert set(second["records"]) == {b}
    assert second["pending"] == 0

    # A restarted backend has a new cache id: the old `since` means nothing.
    script_meta._reset_for_tests(script_meta.cache_path())
    third = (await client.get("/api/media/script-meta", params=params)).json()
    assert third["cacheId"] != first["cacheId"]
    assert set(third["records"]) == {a, b}


@pytest.mark.anyio
async def test_a_script_paired_again_is_sent_to_a_reader_asking_for_changes(tmp_path, passes, client, open_count):
    """A script harvested earlier, unpaired, then paired again: its record
    did not change, but a renderer that asks only for news must get it."""
    x = _write(tmp_path / "X.funscript", {"tags": ["x-tag"]})
    y = _write(tmp_path / "Y.funscript", {"tags": ["y-tag"]})
    video = {"path": str(tmp_path / "V.mp4"), "name": "V.mp4", "avgSpeed": 5, "maxSpeed": 5}
    register_videos([dict(video, funscriptPath=x)])
    _run_all(passes)
    register_videos([dict(video, funscriptPath=y)])
    _run_all(passes)
    seen = (await client.get("/api/media/script-meta")).json()
    assert set(seen["records"]) == {y}                     # X is not paired now

    register_videos([dict(video, funscriptPath=x)])        # paired again
    _run_all(passes)
    news = (await client.get("/api/media/script-meta",
                             params={"since": seen["seq"], "cache": seen["cacheId"]})).json()
    assert news["records"][x]["metadata"] == {"tags": ["x-tag"]}
    assert open_count.get(x) == 1, "an unchanged script was read again"


@pytest.mark.anyio
async def test_a_path_query_reads_a_paired_script_on_demand_and_nothing_else(tmp_path, passes, client, open_count):
    paired = _write(tmp_path / "Paired.funscript", {"creator": "Me"})
    stranger = _write(tmp_path / "Stranger.funscript", {"creator": "Nobody"})
    register_videos([{"path": str(tmp_path / "Paired.mp4"), "name": "Paired.mp4", "funscriptPath": paired}])
    passes.clear()                                     # the background pass has not run yet

    body = (await client.get("/api/media/script-meta", params=[("path", paired), ("path", stranger)])).json()
    assert body["records"][paired]["metadata"] == {"creator": "Me"}
    assert stranger not in body["records"]
    assert open_count.get(stranger) is None, "a path the library does not pair was read"

    # Asked again, unchanged: answered from the cache.
    await client.get("/api/media/script-meta", params={"path": paired})
    assert open_count.get(paired) == 1


@pytest.mark.anyio
async def test_the_harvest_is_desktop_only():
    async with _lan_client() as c:
        resp = await c.get("/api/media/script-meta")
    assert resp.status_code == 403


# --- The phone's tag slice -----------------------------------------------------

@pytest.mark.anyio
async def test_register_tags_reaches_the_phone_for_registered_videos_only(tmp_path, client):
    a, b, gone = (str(tmp_path / n) for n in ("A.mp4", "B.mp4", "Gone.mp4"))
    reg = await client.post("/api/media/register", json={"videos": [
        {"path": a, "name": "A.mp4"}, {"path": b, "name": "B.mp4"},
    ]})
    assert reg.status_code == 200
    await client.post("/api/media/register", json={"videoTags": {
        a: [{"key": "device:the-handy", "facet": "device", "label": "the handy"},
            {"key": "content:pov", "facet": "content", "label": "POV"}],
        b: [{"key": "content:pov", "facet": "content", "label": "pov"},
            {"key": "length:10-25", "facet": "length", "label": "10-25"}],
        gone: [{"key": "content:stale", "facet": "content", "label": "stale"}],
    }})
    body = (await client.get("/api/remote/tags")).json()
    assert body["videoTags"] == {a: ["device:the-handy", "content:pov"], b: ["content:pov", "length:10-25"]}
    assert body["tags"] == [   # facet order (length before device before content), then label
        {"key": "length:10-25", "facet": "length", "label": "10-25", "count": 1},
        {"key": "device:the-handy", "facet": "device", "label": "the handy", "count": 1},
        {"key": "content:pov", "facet": "content", "label": "POV", "count": 2},
    ]
    # The video list does not carry tags: search on the phone cannot match them.
    videos = (await client.get("/api/remote/videos")).json()["videos"]
    assert all("tags" not in v for v in videos)


@pytest.mark.anyio
async def test_the_slice_is_view_only_and_checked(tmp_path, client):
    a = str(tmp_path / "A.mp4")
    await client.post("/api/media/register", json={"videos": [{"path": a, "name": "A.mp4"}]})
    junk = [None, 3, {"key": ""}, {"key": 5}, {"key": "x" * 600}, ["list"],
            "content:plain-string", {"key": "made-up:thing", "facet": "nope"},
            {"key": "performer:Jane", "facet": "performer", "label": {"no": 1}}]
    junk += [{"key": f"content:t{i}", "facet": "content", "label": f"t{i}"} for i in range(media.MAX_TAGS_PER_VIDEO + 300)]
    await client.post("/api/media/register", json={"videoTags": {a: junk, "": [{"key": "x"}], 7: [], a + "2": "nope"}})
    body = (await client.get("/api/remote/tags")).json()
    keys = body["videoTags"][a]
    assert keys[:3] == ["content:plain-string", "made-up:thing", "performer:Jane"]
    assert len(keys) == media.MAX_TAGS_PER_VIDEO
    tags = {t["key"]: t for t in body["tags"]}
    assert tags["made-up:thing"]["facet"] == "content"
    assert tags["performer:Jane"] == {"key": "performer:Jane", "facet": "performer", "label": "Jane", "count": 1}

    # The slice is replaced whole, and only by the desktop.
    await client.post("/api/media/register", json={"videoTags": {}})
    emptied = (await client.get("/api/remote/tags")).json()
    assert (emptied["videoTags"], emptied["tags"]) == ({}, [])
    async with _lan_client() as c:
        refused = await c.post("/api/media/register", json={"videoTags": {a: [{"key": "content:x"}]}})
    assert refused.status_code == 403
    assert (await client.get("/api/remote/tags")).json()["videoTags"] == {}


@pytest.mark.anyio
async def test_a_registration_without_tags_leaves_the_slice_alone(tmp_path, client):
    a = str(tmp_path / "A.mp4")
    await client.post("/api/media/register", json={"videos": [{"path": a, "name": "A.mp4"}]})
    await client.post("/api/media/register", json={"videoTags": {a: [{"key": "content:pov"}]}})
    await client.post("/api/media/register", json={"videos": [{"path": a, "name": "A.mp4"}], "playlists": []})
    assert (await client.get("/api/remote/tags")).json()["videoTags"] == {a: ["content:pov"]}
