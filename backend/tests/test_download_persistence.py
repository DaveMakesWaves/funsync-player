"""The EroScripts tab's downloads outlive FunSync (Dave, 2026-11-25: "i started
a download closed the app reopened and downloaded again, it seemed to resume
the download but there was no indicator that the download could resume").

Before: the job list lived only in the backend's memory. A download running
when FunSync closed was forgotten; starting it again went to "Name (1)" from
zero (Pixeldrain, Mega, direct links), leaving the old .part behind, or, on a
yt-dlp host, quietly continued the old working files under the same name.
Now the list is saved in <userData>/downloads.json and a running download
comes back paused, `interrupted`, with Resume, at the size on disk."""
import json
import os
import sys
import time

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services import video_downloader as vd  # noqa: E402
from tests.test_video_downloader import GOFILE_RESOLVED, _RangeHost, _manager, _wait, _wait_for  # noqa: E402


def _dirs(tmp_path):
    dest, data = tmp_path / "dl", tmp_path / "userdata"
    dest.mkdir()
    data.mkdir()
    return dest, data / "downloads.json"


def test_a_download_running_when_funsync_closed_comes_back_paused_and_resumes(tmp_path):
    dest, store = _dirs(tmp_path)
    content = os.urandom(4 * vd.CHUNK + 33)
    host = _RangeHost(content, hold=True)
    m1 = _manager(host)
    m1.set_store(str(store))
    job = m1.start("https://pixeldrain.com/u/abc", str(dest), "Clip", meta={"topicId": 350031, "title": "Clip"})
    while m1.get(job.id).bytes == 0:
        time.sleep(0.01)
    # What is on disk the moment FunSync closes: the list says it was downloading.
    saved = json.loads(store.read_text(encoding="utf-8"))
    assert [j["status"] for j in saved["jobs"]] == ["downloading"]
    at_close = tmp_path / "at-close.json"
    at_close.write_text(json.dumps(saved), encoding="utf-8")
    m1.pause(job.id)                                   # stands in for the process that died
    host.release.set()
    _wait_for(m1, job.id, ("paused",))

    host.hold = False
    m2 = _manager(host)
    assert m2.set_store(str(at_close)) == 1
    snap = m2.get(job.id).snapshot()
    assert (snap["status"], snap["interrupted"], snap["resumable"]) == ("paused", True, True)
    assert snap["bytes"] == vd.CHUNK and snap["total"] == len(content)    # how far it got, read from disk
    assert snap["meta"] == {"topicId": 350031, "title": "Clip"}          # still the post's
    assert m2.resume(job.id) is not None
    assert m2.get(job.id).interrupted is False
    done = _wait(m2, job.id)
    assert done.status == "done", done.message
    assert (dest / "Clip.mp4").read_bytes() == content                    # continued, not started over
    assert host.range_headers[-1] == f"bytes={vd.CHUNK}-"
    # Finished: nothing left in the list to bring back.
    assert json.loads(at_close.read_text(encoding="utf-8"))["jobs"] == []


def test_the_saved_list_trusts_only_names_in_its_own_folder(tmp_path):
    dest, _ = _dirs(tmp_path)
    outside = tmp_path / "elsewhere.mp4"
    rec = {"id": "0123456789ab", "url": "https://pixeldrain.com/u/abc", "destDir": str(dest), "stem": "Clip",
           "status": "downloading", "host": "pixeldrain",
           "finalPath": str(outside), "partPath": str(outside) + ".part"}
    job = vd.restore_job(rec)
    assert job.part_path == "" and job.final_path == ""               # never a file outside dest
    assert job._leftovers == (os.path.abspath(str(dest)), "Clip")
    for bad in ({**rec, "stem": os.path.join("..", "Clip")}, {**rec, "stem": ".."}, {**rec, "destDir": "relative"},
                {**rec, "status": "done"}, {**rec, "status": "cancelled"}, "not a dict"):
        assert vd.restore_job(bad) is None, bad
    # A failure with nothing on disk to continue is not brought back.
    assert vd.restore_job({**rec, "status": "error", "finalPath": "", "partPath": ""}) is None
    # A bad id is replaced, not trusted.
    assert vd.restore_job({**rec, "id": "../x"}).id != "../x"


def test_one_that_finished_just_before_funsync_closed_comes_back_done(tmp_path):
    dest, _ = _dirs(tmp_path)
    (dest / "Clip.mp4").write_bytes(b"whole video")
    job = vd.restore_job({"id": "0123456789ab", "url": "https://pixeldrain.com/u/abc", "destDir": str(dest), "stem": "Clip",
                          "status": "downloading", "host": "pixeldrain",
                          "finalPath": str(dest / "Clip.mp4"), "partPath": str(dest / "Clip.mp4.part")})
    assert job.status == "done" and job.path == os.path.abspath(str(dest / "Clip.mp4")) and job.bytes == 11


def test_a_yt_dlp_download_comes_back_with_the_size_of_its_working_files(tmp_path):
    dest, _ = _dirs(tmp_path)
    (dest / "Clip.f2753.mp4.part").write_bytes(b"x" * 300)
    (dest / "Clip.f140.m4a.part").write_bytes(b"y" * 50)
    (dest / "Clip (1).mp4.part").write_bytes(b"z" * 999)                 # another download's
    job = vd.restore_job({"id": "0123456789ab", "url": "https://erosync.net/v/abc", "destDir": str(dest), "stem": "Clip",
                          "status": "downloading", "host": "erosync", "total": 1000})
    snap = job.snapshot()
    assert (snap["status"], snap["interrupted"], snap["resumable"], snap["bytes"]) == ("paused", True, True, 350)


def test_a_new_download_never_continues_an_old_ones_working_files(tmp_path):
    # yt-dlp's parts: a new download under that name made yt-dlp continue them, unasked.
    for i, left in enumerate(("Clip.f2753.mp4.part", "Clip.mp4.part-Frag3", "Clip.mp4.ytdl", "Clip.temp.mp4")):
        d = tmp_path / f"case{i}"
        d.mkdir()
        (d / left).write_bytes(b"x")
        assert vd.unique_stem(str(d), "Clip") == "Clip (1)", left
    # A finished video whose name only looks like one is not a working file.
    d = tmp_path / "finished"
    d.mkdir()
    (d / "Clip.part1.mp4").write_bytes(b"x")
    assert vd.unique_stem(str(d), "Clip") == "Clip"


def test_a_paused_downloads_name_stays_its_own(tmp_path):
    dest, store = _dirs(tmp_path)
    # Interrupted before any of it came: nothing on disk, but the name is its.
    store.write_text(json.dumps({"v": 1, "jobs": [{"id": "0123456789ab", "url": "https://pixeldrain.com/u/abc",
                                                  "destDir": str(dest), "stem": "Clip", "status": "queued",
                                                  "host": "pixeldrain"}]}), encoding="utf-8")
    m = _manager(_RangeHost(os.urandom(vd.CHUNK)))
    assert m.set_store(str(store)) == 1
    assert m.get("0123456789ab").snapshot()["interrupted"] is True
    other = m.start("https://pixeldrain.com/u/xyz", str(dest), "Clip")
    assert other.stem == "Clip (1)"
    _wait(m, other.id)


def test_a_paused_one_stays_paused_and_a_damaged_list_is_an_empty_one(tmp_path):
    dest, store = _dirs(tmp_path)
    (dest / "Clip.mp4.part").write_bytes(b"x" * 10)
    rec = {"id": "0123456789ab", "url": "https://pixeldrain.com/u/abc", "destDir": str(dest), "stem": "Clip",
           "status": "paused", "host": "pixeldrain",
           "finalPath": str(dest / "Clip.mp4"), "partPath": str(dest / "Clip.mp4.part")}
    snap = vd.restore_job(rec).snapshot()
    assert (snap["status"], snap["interrupted"], snap["bytes"]) == ("paused", False, 10)   # you paused it
    store.write_text("{not json", encoding="utf-8")
    m = _manager(_RangeHost(b""))
    assert m.set_store(str(store)) == 0
    assert json.loads(store.read_text(encoding="utf-8")) == {"v": 1, "jobs": []}


def test_the_tabs_note_is_kept_and_an_oversized_one_dropped():
    assert vd.clean_meta({"topicId": 1, "script": {"url": "u"}}) == {"topicId": 1, "script": {"url": "u"}}
    assert vd.clean_meta({"x": "y" * (vd.META_MAX_BYTES + 1)}) is None
    assert vd.clean_meta("text") is None and vd.clean_meta(None) is None


def test_a_gofile_download_brought_back_asks_the_app_again_and_its_cookie_is_never_saved(tmp_path):
    dest, store = _dirs(tmp_path)
    content = os.urandom(2 * vd.CHUNK + 5)

    def handler(request: httpx.Request):
        if request.url.host != "file-na-phx-1.gofile.io":
            return httpx.Response(404)
        rng = request.headers.get("range")
        start = int(rng.split("=")[1].split("-")[0]) if rng else 0
        body = content[start:]
        headers = {"content-length": str(len(body))}
        if start:
            headers["content-range"] = f"bytes {start}-{len(content) - 1}/{len(content)}"
            return httpx.Response(206, content=body, headers=headers)
        return httpx.Response(200, content=body, headers=headers)

    # Part of it on disk under the name the first run reserved.
    (dest / "Clip.mp4.part").write_bytes(content[:vd.CHUNK])
    store.write_text(json.dumps({"v": 1, "jobs": [{
        "id": "0123456789ab", "url": "https://gofile.io/d/UX0LG6wr", "destDir": str(dest), "stem": "Clip",
        "status": "downloading", "host": "gofile", "total": len(content),
        "finalPath": str(dest / "Clip.mp4"), "partPath": str(dest / "Clip.mp4.part")}]}), encoding="utf-8")
    m = _manager(handler)
    m.set_store(str(store))
    assert m.get("0123456789ab").snapshot()["needsResolve"] is True
    with pytest.raises(vd.DownloadError) as e:
        m.resume("0123456789ab")
    assert e.value.code == "needsApp"
    assert m.resume("0123456789ab", {**GOFILE_RESOLVED, "size": len(content)}) is not None
    assert "accountToken" not in store.read_text(encoding="utf-8")
    done = _wait(m, "0123456789ab")
    assert done.status == "done", done.message
    assert (dest / "Clip.mp4").read_bytes() == content


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_resume_route_passes_the_apps_gofile_lookup_and_start_keeps_the_note(monkeypatch, tmp_path):
    from httpx import ASGITransport, AsyncClient
    from main import app
    seen = {}

    def fake_resume(job_id, resolved=None):
        seen["resume"] = (job_id, resolved)
        raise vd.DownloadError("needsApp")

    def fake_start(*args):
        seen["start"] = args

        class _J:
            def snapshot(self):
                return {"id": "x"}
        return _J()
    monkeypatch.setattr(vd.manager, "resume", fake_resume)
    monkeypatch.setattr(vd.manager, "start", fake_start)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:5123") as c:
        r = await c.post("/api/downloads/0123456789ab/resume", json={"resolved": GOFILE_RESOLVED})
        assert seen["resume"] == ("0123456789ab", GOFILE_RESOLVED)
        assert r.status_code == 400 and r.json()["detail"]["code"] == "needsApp"
        r = await c.post("/api/downloads", json={"url": "https://pixeldrain.com/u/a", "destDir": str(tmp_path),
                                                 "stem": "Clip", "meta": {"topicId": 7}})
        assert r.status_code == 200 and seen["start"][-1] == {"topicId": 7}
    # A phone on the LAN gets neither.
    lan = ASGITransport(app=app, client=("192.168.1.50", 50000))
    async with AsyncClient(transport=lan, base_url="http://192.168.1.10:5123") as c:
        assert (await c.post("/api/downloads/0123456789ab/resume", json={})).status_code == 403


def test_resume_into_a_folder_that_is_gone_says_so_and_keeps_the_download(tmp_path):
    """Break-it, 2026-11-25: a download brought back whose folder is gone (a
    drive unplugged) turned into "Something went wrong" (a FileNotFoundError)
    with no Resume and no Discard."""
    dest, store = _dirs(tmp_path)
    gone = tmp_path / "unplugged"
    store.write_text(json.dumps({"v": 1, "jobs": [{"id": "0123456789ab", "url": "https://pixeldrain.com/u/abc",
                                                  "destDir": str(gone), "stem": "Clip", "status": "downloading",
                                                  "host": "pixeldrain"}]}), encoding="utf-8")
    m = _manager(_RangeHost(os.urandom(vd.CHUNK)))
    m.set_store(str(store))
    with pytest.raises(vd.DownloadError) as e:
        m.resume("0123456789ab")
    assert e.value.code == "badFolder"
    snap = m.get("0123456789ab").snapshot()
    assert (snap["status"], snap["interrupted"]) == ("paused", True)          # untouched: Resume / Discard stay
    gone.mkdir()                                                              # the drive is back
    assert m.resume("0123456789ab") is not None
    assert _wait(m, "0123456789ab").status == "done"


def test_a_folder_that_is_gone_when_the_download_runs_is_said_and_can_be_resumed(tmp_path):
    # A drive unplugged under a download: the folder is not there when it writes.
    m = _manager(_RangeHost(os.urandom(vd.CHUNK)))
    job = vd.Job("https://pixeldrain.com/u/abc", str(tmp_path / "gone"), "Clip", False)
    job.host = "pixeldrain"
    m._jobs[job.id] = job
    m._run(job, vd.classify(job.url))
    assert (job.status, job.error, job.resumable) == ("error", "badFolder", True)   # said, and Resume offered


def test_a_folder_gone_failure_survives_a_restart(tmp_path):
    rec = {"id": "0123456789ab", "url": "https://pixeldrain.com/u/abc", "destDir": str(tmp_path / "unplugged"),
           "stem": "Clip", "status": "error", "error": "badFolder", "host": "pixeldrain"}
    job = vd.restore_job(rec)
    assert job is not None and (job.status, job.error, job.resumable) == ("error", "badFolder", True)
