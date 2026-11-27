"""The EroScripts tab's video downloads (2026-11-22): links, names, the
Pixeldrain and Mega flows end to end against a fake host (no network), cancel,
and the routes' desktop-only gate."""
import base64
import json
import os
import struct
import sys
import threading
import time

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from Cryptodome.Cipher import AES  # noqa: E402

from services import video_downloader as vd  # noqa: E402


# --- links ----------------------------------------------------------------------

@pytest.mark.parametrize("url,kind,host,supported", [
    ("https://pixeldrain.com/u/abc123", "filehost", "pixeldrain", True),
    ("https://pixeldrain.com/l/n3Ux1WVT", "filehost", "pixeldrain", True),
    ("https://mega.nz/file/1TUCTTRQ#Sm_KpTqr0d4OZQBD1E3nMHZ0AM81RT429VovXCkei0A", "filehost", "mega", True),
    ("https://mega.nz/folder/GKA2RbrR#5EtJcvbZHdCQpXYzfGwKyw", "filehost", "mega", True),     # its video (2026-11-24)
    ("https://gofile.io/d/UX0LG6wr", "filehost", "gofile", True),    # resolved by the app (2026-11-24)
    ("https://payhip.com/b/fHucK", "store", "payhip.com", False),          # a paid script (Dave, 2026-11-22)
    ("https://www.patreon.com/someone", "store", "patreon.com", False),
    ("https://www.pornhub.com/view_video.php?viewkey=64e8791e46f17", "tube", "pornhub", True),
    ("https://example.com/videos/clip.mp4", "direct", "example.com", True),
    ("https://example.com/some/page", "unsupported", "example.com", False),
    ("ftp://example.com/clip.mp4", "unsupported", "example.com", False),
])
def test_classify(url, kind, host, supported):
    got = vd.classify(url)
    assert (got["kind"], got["host"], got["supported"]) == (kind, host, supported)


def test_gofile_needs_the_app_and_mega_folders_say_why():
    # Gofile (2026-11-24): the app's own window opens the page (electron/gofile.js).
    assert vd.classify("https://gofile.io/d/x")["needsApp"] is True
    # A folder link with no usable key still says why; a whole one is a download now.
    assert vd.classify("https://mega.nz/folder/a#b")["reason"] == "megaFolder"
    assert vd.classify("https://mega.nz/folder/GKA2RbrR#5EtJcvbZHdCQpXYzfGwKyw")["folder"] is True


# --- names ----------------------------------------------------------------------

def test_clean_stem():
    assert vd.clean_stem('Pmv mix // vol. 12') == "Pmv mix vol. 12"
    assert vd.clean_stem('a<b>c:"d|e?*') == "a b c d e"
    assert vd.clean_stem("   ...  ") == "video"
    assert vd.clean_stem("CON") == "_CON"
    assert len(vd.clean_stem("x" * 400)) == 150


def test_unique_path_never_reuses_a_name(tmp_path):
    (tmp_path / "Clip.mp4").write_bytes(b"old")
    (tmp_path / "Clip (1).mp4.part").write_bytes(b"in progress")
    assert vd.unique_path(str(tmp_path), "Clip", ".mp4") == str(tmp_path / "Clip (2).mp4")
    assert vd.unique_path(str(tmp_path), "Other", "mp4") == str(tmp_path / "Other.mp4")


def test_a_missing_or_relative_folder_is_refused(tmp_path):
    with pytest.raises(vd.DownloadError) as e:
        vd.check_dest(str(tmp_path / "nope"))
    assert e.value.code == "badFolder"
    with pytest.raises(vd.DownloadError):
        vd.check_dest("relative/folder")


# --- Mega crypto ------------------------------------------------------------------

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _mega_fixture(content: bytes, name: str):
    """A fake Mega file: the link key, the encrypted attributes and body."""
    raw = bytes(range(32))
    key, iv = vd.mega_key_iv(_b64url(raw))
    attr = b"MEGA" + json.dumps({"n": name}).encode()
    attr += b"\0" * (-len(attr) % 16)
    at = _b64url(AES.new(key, AES.MODE_CBC, iv=b"\0" * 16).encrypt(attr))
    body = AES.new(key, AES.MODE_CTR, nonce=b"", initial_value=iv).encrypt(content)
    return _b64url(raw), at, body


def test_mega_key_and_name():
    content = os.urandom(1000)
    link_key, at, _ = _mega_fixture(content, "Clip name.mp4")
    key, iv = vd.mega_key_iv(link_key)
    assert len(key) == 16 and len(iv) == 16 and iv[8:] == b"\0" * 8
    assert vd.mega_file_name(at, key) == "Clip name.mp4"
    assert vd.mega_link_parts(f"https://mega.nz/file/AbCdEfGh#{link_key}") == ("AbCdEfGh", link_key)
    assert vd.mega_link_parts(f"https://mega.nz/#!AbCdEfGh!{link_key}") == ("AbCdEfGh", link_key)


# --- whole downloads against a fake host -------------------------------------------

def _manager(handler):
    return vd.DownloadManager(client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True))


def _wait(manager, job_id, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        job = manager.get(job_id)
        if job.status in ("done", "error", "cancelled"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_pixeldrain_download_end_to_end(tmp_path):
    content = os.urandom(3 * vd.CHUNK + 123)

    def handler(req: httpx.Request):
        if req.url.path == "/api/file/abc/info":
            return httpx.Response(200, json={"name": "Clip.mkv", "size": len(content)})
        if req.url.path == "/api/file/abc":
            return httpx.Response(200, content=content, headers={"content-length": str(len(content))})
        return httpx.Response(404)

    m = _manager(handler)
    (tmp_path / "Post title.mkv").write_bytes(b"someone else's file")
    job = _wait(m, m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Post title").id)
    assert job.status == "done", job.message
    assert job.path == str(tmp_path / "Post title (1).mkv")        # never overwrites
    assert (tmp_path / "Post title (1).mkv").read_bytes() == content
    assert (tmp_path / "Post title.mkv").read_bytes() == b"someone else's file"
    assert not [p for p in os.listdir(tmp_path) if p.endswith(".part")]


def test_mega_download_is_decrypted(tmp_path):
    content = os.urandom(2 * vd.CHUNK + 77)
    link_key, at, body = _mega_fixture(content, "Original.mp4")

    def handler(req: httpx.Request):
        if req.url.host == "g.api.mega.co.nz":
            assert json.loads(req.content)[0]["p"] == "AbCdEfGh"
            return httpx.Response(200, json=[{"s": len(body), "at": at, "g": "https://dl.mega.example/file"}])
        if req.url.host == "dl.mega.example":
            return httpx.Response(200, content=body, headers={"content-length": str(len(body))})
        return httpx.Response(404)

    m = _manager(handler)
    job = _wait(m, m.start(f"https://mega.nz/file/AbCdEfGh#{link_key}", str(tmp_path), "Post").id)
    assert job.status == "done", job.message
    assert job.name == "Original.mp4"
    assert (tmp_path / "Post.mp4").read_bytes() == content


# --- Mega public folders (Dave, 2026-11-24: "as functional as possible ... mega") ---

def _mega_folder_fixture(files):
    """A fake public folder: its link key, the API's node list, each file's encrypted body.
    files: [(handle, name, content, parent)]."""
    folder_key = bytes(range(100, 116))
    ecb = AES.new(folder_key, AES.MODE_ECB)
    nodes, bodies = [{"h": "ROOT0001", "t": 1, "p": "", "k": "ROOT0001:" + _b64url(ecb.encrypt(bytes(16))), "a": ""}], {}
    for i, (h, name, content, parent) in enumerate(files):
        raw = bytes((i * 7 + j) % 256 for j in range(32))
        key, iv = vd.mega_key_iv(_b64url(raw))
        attr = b"MEGA" + json.dumps({"n": name}).encode()
        attr += b"\0" * (-len(attr) % 16)
        at = _b64url(AES.new(key, AES.MODE_CBC, iv=b"\0" * 16).encrypt(attr))
        nodes.append({"h": h, "t": 0, "p": parent, "s": len(content), "a": at, "k": "ROOT0001:" + _b64url(ecb.encrypt(raw))})
        bodies[h] = AES.new(key, AES.MODE_CTR, nonce=b"", initial_value=iv).encrypt(content)
    return _b64url(folder_key), nodes, bodies


def _mega_folder_host(nodes, bodies, asked):
    def handler(req: httpx.Request):
        if req.url.host == "g.api.mega.co.nz":
            call = json.loads(req.content)[0]
            asked.append((call["a"], req.url.params.get("n")))
            if req.url.params.get("n") != "FoLdEr01":
                return httpx.Response(200, json=[-9])
            if call["a"] == "f":
                return httpx.Response(200, json=[{"f": nodes}])
            if call["a"] == "g":
                return httpx.Response(200, json=[{"s": len(bodies[call["n"]]), "g": f"https://dl.mega.example/{call['n']}"}])
        if req.url.host == "dl.mega.example":
            body = bodies[req.url.path.strip("/")]
            return httpx.Response(200, content=body, headers={"content-length": str(len(body))})
        return httpx.Response(404)
    return handler


def test_mega_folder_downloads_its_biggest_video_decrypted(tmp_path):
    big = os.urandom(vd.CHUNK + 501)
    key, nodes, bodies = _mega_folder_fixture([
        ("SmAlLvId", "trailer.mp4", os.urandom(300), "ROOT0001"),
        ("BiGvIdEo", "Full scene.mp4", big, "ROOT0001"),
        ("ScRiPt01", "Full scene.funscript", os.urandom(900), "ROOT0001"),
    ])
    asked = []
    m = _manager(_mega_folder_host(nodes, bodies, asked))
    job = _wait(m, m.start(f"https://mega.nz/folder/FoLdEr01#{key}", str(tmp_path), "Post").id)
    assert job.status == "done", job.message
    assert job.name == "Full scene.mp4"
    assert (tmp_path / "Post.mp4").read_bytes() == big
    assert asked == [("f", "FoLdEr01"), ("g", "FoLdEr01")]


def test_mega_folder_link_to_one_file_takes_that_file_and_the_check_names_it(tmp_path):
    small = os.urandom(300)
    key, nodes, bodies = _mega_folder_fixture([
        ("SmAlLvId", "trailer.mp4", small, "ROOT0001"),
        ("BiGvIdEo", "Full scene.mp4", os.urandom(5000), "ROOT0001"),
    ])
    m = _manager(_mega_folder_host(nodes, bodies, []))
    job = _wait(m, m.start(f"https://mega.nz/folder/FoLdEr01#{key}/file/SmAlLvId", str(tmp_path), "Post").id)
    assert job.status == "done" and job.name == "trailer.mp4"
    assert (tmp_path / "Post.mp4").read_bytes() == small
    got = m.check([f"https://mega.nz/folder/FoLdEr01#{key}", f"https://mega.nz/folder/GoNeGoNe#{key}"])
    assert (got[0]["status"], got[0]["name"], got[0]["size"]) == ("ok", "Full scene.mp4", 5000)
    assert got[1]["status"] == "dead"


def test_mega_folder_with_no_video_says_so(tmp_path):
    key, nodes, bodies = _mega_folder_fixture([("ScRiPt01", "only.funscript", os.urandom(90), "ROOT0001")])
    m = _manager(_mega_folder_host(nodes, bodies, []))
    job = _wait(m, m.start(f"https://mega.nz/folder/FoLdEr01#{key}", str(tmp_path), "Post").id)
    assert (job.status, job.error) == ("error", "noVideo")


def test_a_gone_file_is_notFound_and_leaves_nothing(tmp_path):
    m = _manager(lambda req: httpx.Response(404))
    job = _wait(m, m.start("https://example.com/v/clip.mp4", str(tmp_path), "Clip").id)
    assert (job.status, job.error) == ("error", "notFound")
    assert os.listdir(tmp_path) == []


def test_cancel_stops_and_removes_the_part_file(tmp_path):
    release = threading.Event()

    class Slow(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * vd.CHUNK          # one whole read, so it arrives at once
            release.wait(5)
            for _ in range(3):
                yield b"x" * vd.CHUNK

    m = _manager(lambda req: httpx.Response(200, stream=Slow(), headers={"content-length": str(4 * vd.CHUNK)}))
    job = m.start("https://example.com/v/clip.mp4", str(tmp_path), "Clip")
    while m.get(job.id).bytes == 0:
        time.sleep(0.01)
    assert m.cancel(job.id) is True
    release.set()
    job = _wait(m, job.id)
    assert job.status == "cancelled"
    assert os.listdir(tmp_path) == []


def test_tube_needs_the_opt_in(tmp_path):
    m = _manager(lambda req: httpx.Response(404))
    with pytest.raises(vd.DownloadError) as e:
        m.start("https://www.pornhub.com/view_video.php?viewkey=x", str(tmp_path), "x", allow_tube=False)
    assert e.value.code == "tubeOff"
    # Gofile without the app's resolution: refused, never tried blind.
    with pytest.raises(vd.DownloadError) as e:
        m.start("https://gofile.io/d/x", str(tmp_path), "x")
    assert e.value.code == "needsApp"


# --- the routes answer the desktop only -------------------------------------------

@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_routes_answer_the_desktop_only():
    from httpx import ASGITransport, AsyncClient
    from main import app
    lan = ASGITransport(app=app, client=("192.168.1.50", 50000))
    async with AsyncClient(transport=lan, base_url="http://192.168.1.10:5123") as c:
        assert (await c.get("/api/downloads")).status_code == 403
        assert (await c.post("/api/downloads", json={"url": "https://example.com/a.mp4", "destDir": "C:/x"})).status_code == 403
        assert (await c.post("/api/downloads/classify", json={"links": []})).status_code == 403
    desk = ASGITransport(app=app)
    async with AsyncClient(transport=desk, base_url="http://127.0.0.1:5123") as c:
        r = await c.post("/api/downloads/classify", json={"links": ["https://pixeldrain.com/u/abc"]})
        assert r.status_code == 200 and r.json()["links"][0]["host"] == "pixeldrain"
        r = await c.post("/api/downloads", json={"url": "https://example.com/page", "destDir": "C:/does/not/exist"})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "badFolder"


def test_a_cancelled_ytdlp_download_leaves_no_working_files(tmp_path):
    """2026-11-22 (on Dave's VPN): a cancelled Eporner download left eporner.mp4.part."""
    for n in ["clip.mp4.part", "clip.mp4.part-Frag3", "clip.mp4.ytdl", "clip.temp.mp4", "clip.mp4", "other.mp4.part", "clip (1).mp4.part"]:
        (tmp_path / n).write_bytes(b"x")
    gone = vd.remove_partials(str(tmp_path), "clip")
    assert sorted(gone) == ["clip.mp4.part", "clip.mp4.part-Frag3", "clip.mp4.ytdl", "clip.temp.mp4"]
    assert sorted(os.listdir(tmp_path)) == ["clip (1).mp4.part", "clip.mp4", "other.mp4.part"]   # a finished file and other jobs' are kept


# --- PMVHaven and FapTap (Dave, 2026-11-22: "add pmvhaven and faptap support") ---

def _pmvhaven_page(video_id: str, mp4: str) -> str:
    # The shape of a real page's __NUXT_DATA__ (2026-11-22): a flat array,
    # objects hold indexes, values may sit behind a ShallowReactive wrapper.
    data = [["ShallowReactive", 1], {"video": 2}, {"_id": 3, "title": 4, "videoUrl": 5, "related": 6},
            video_id, "COOK", mp4, [7], {"_id": 8, "title": 9}, "0" * 24, "Other video"]
    return f'<html><head></head><body><script type="application/json" id="__NUXT_DATA__" data-ssr="true">{json.dumps(data)}</script></body></html>'


def test_pmvhaven_and_faptap_links_are_video_hosts_not_tube_sites():
    for url, host in [("https://pmvhaven.com/video/cook_6aac134b1d82327005594a39?from=profile-favorites", "pmvhaven"),
                      ("https://faptap.net/v/2107858395183714305", "faptap")]:
        info = vd.classify(url)
        assert (info["kind"], info["host"], info["supported"]) == ("videohost", host, True)
    assert vd.classify("https://pmvhaven.com/profile/somewhatdamaged")["kind"] != "videohost"   # a profile is not a video


def test_pmvhaven_page_names_its_own_video_only():
    vid = "6aac134b1d82327005594a39"
    page = _pmvhaven_page(vid, "https://cdn.example/videos/COOK.mp4")
    assert vd.pmvhaven_video(page, vid) == {"title": "COOK", "videoUrl": "https://cdn.example/videos/COOK.mp4"}
    assert vd.pmvhaven_video(page, "f" * 24) is None                 # another video's id: not this page's video
    assert vd.pmvhaven_video("<html>no data</html>", vid) is None


def test_faptap_page_gives_the_players_stream():
    page = ('<meta property="og:title" content="PMV MIX // VOL. 12 - Faptap">'
            '<meta property="og:image" content="https://vz-3d77bc0a-a87.b-cdn.net/844cbc83-54b0-4bf7-8838-d1d959c4ca6a/thumbnail.jpg">')
    assert vd.faptap_stream(page) == {"title": "PMV MIX // VOL. 12",
                                      "playlist": "https://vz-3d77bc0a-a87.b-cdn.net/844cbc83-54b0-4bf7-8838-d1d959c4ca6a/playlist.m3u8",
                                      # the video's own picture, for a saved stream's card (2026-11-23)
                                      "thumbnail": "https://vz-3d77bc0a-a87.b-cdn.net/844cbc83-54b0-4bf7-8838-d1d959c4ca6a/thumbnail.jpg"}
    assert vd.faptap_stream('<meta property="og:image" content="https://faptap.net/og.png">') is None


def test_pmvhaven_download_end_to_end(tmp_path):
    vid = "6aac134b1d82327005594a39"
    content = os.urandom(2 * vd.CHUNK + 5)

    def handler(req: httpx.Request):
        if req.url.host == "pmvhaven.com":
            return httpx.Response(200, text=_pmvhaven_page(vid, "https://cdn.example/videos/COOK.mp4"))
        if req.url.host == "cdn.example":
            return httpx.Response(200, content=content, headers={"content-length": str(len(content))})
        return httpx.Response(404)

    m = _manager(handler)
    job = _wait(m, m.start(f"https://pmvhaven.com/video/cook_{vid}", str(tmp_path), "Pmv mix vol. 12").id)
    assert job.status == "done", job.message
    assert job.name == "COOK"
    assert (tmp_path / "Pmv mix vol. 12.mp4").read_bytes() == content


def test_pmvhaven_page_without_the_video_says_no_video(tmp_path):
    m = _manager(lambda req: httpx.Response(200, text="<html>removed</html>"))
    job = _wait(m, m.start("https://pmvhaven.com/video/x_6aac134b1d82327005594a39", str(tmp_path), "x").id)
    assert (job.status, job.error) == ("error", "noVideo")


def test_link_check_says_which_links_still_work():
    """Dave, 2026-11-22: "sometimes the original link dies ... there should be an indicator as to which links work"."""
    asked = []

    def handler(req: httpx.Request):
        asked.append(req.url.host)
        if req.url.path == "/api/file/alive/info":
            return httpx.Response(200, json={"name": "Clip.mp4", "size": 1234})
        if req.url.path == "/api/file/gone/info":
            return httpx.Response(404, json={"success": False})
        if req.url.host == "g.api.mega.co.nz":
            return httpx.Response(200, json=[-9])
        if req.url.host == "pmvhaven.com":
            return httpx.Response(404)
        if req.url.host == "flaky.example":
            raise httpx.ConnectError("no route")
        return httpx.Response(500)

    m = _manager(handler)
    got = m.check([
        "https://pixeldrain.com/u/alive",
        "https://pixeldrain.com/u/gone",
        "https://mega.nz/file/abcdefgh#" + "A" * 43,
        "https://pmvhaven.com/video/x_6aac134b1d82327005594a39",
        "https://www.pornhub.com/view_video.php?viewkey=x",     # a tube site: never asked
        "https://gofile.io/d/UX0LG6wr",                         # the app checks it: never asked here
        "https://flaky.example/v.mp4",                          # could not ask: unknown, never dead
    ])
    assert [g["status"] for g in got] == ["ok", "dead", "dead", "dead", "unknown", "unknown", "unknown"]
    assert (got[0]["size"], got[0]["name"]) == (1234, "Clip.mp4")
    assert "www.pornhub.com" not in asked and "gofile.io" not in asked


def test_link_check_route_is_desktop_only():
    from fastapi.testclient import TestClient
    from main import app
    r = TestClient(app, client=("192.168.1.50", 5555)).post("/api/downloads/check", json={"links": []})
    assert r.status_code == 403


def test_the_name_is_reserved_when_a_download_starts(tmp_path):
    """The script is saved beside the video at once, under the name the video will get (2026-11-22)."""
    (tmp_path / "Clip.funscript").write_text("{}")             # another script already has the name
    assert vd.unique_stem(str(tmp_path), "Clip") == "Clip (1)"
    (tmp_path / "Clip (1).mp4.part").write_bytes(b"x")         # a download is writing that one
    assert vd.unique_stem(str(tmp_path), "Clip") == "Clip (2)"
    assert vd.unique_stem(str(tmp_path), "Clip", {"clip (2)"}) == "Clip (3)"   # held by a running download
    assert vd.unique_stem(str(tmp_path), "Other") == "Other"


def test_start_answers_with_the_reserved_name(tmp_path):
    (tmp_path / "Post.funscript").write_text("{}")
    gate = threading.Event()

    def handler(req: httpx.Request):
        gate.wait(5)
        return httpx.Response(404)

    m = _manager(handler)
    a = m.start("https://pixeldrain.com/u/aaa", str(tmp_path), "Post")
    b = m.start("https://pixeldrain.com/u/bbb", str(tmp_path), "Post")
    assert (a.stem, b.stem) == ("Post (1)", "Post (2)")       # never the other's name
    gate.set()


def test_a_used_up_pixeldrain_day_marks_its_links_slow():
    def handler(req: httpx.Request):
        if req.url.path == "/api/misc/rate_limits":
            return httpx.Response(200, json={"transfer_limit": 6000000000, "transfer_limit_used": 6781218980, "speed_limit": 1048576})
        if req.url.path == "/api/file/alive/info":
            return httpx.Response(200, json={"name": "Clip.mp4", "size": 1})
        return httpx.Response(404)

    got = _manager(handler).check(["https://pixeldrain.com/u/alive", "https://pixeldrain.com/u/gone"])
    assert got[0]["status"] == "ok" and got[0].get("slow") is True
    assert got[1]["status"] == "dead" and "slow" not in got[1]


def test_a_locked_working_file_is_tried_again(tmp_path, monkeypatch):
    """Windows: yt-dlp can hold its .part open a moment after a cancel (a FapTap cancel left 114 MB, 2026-11-22)."""
    (tmp_path / "clip.mp4.part").write_bytes(b"x")
    real_remove = os.remove
    tries = {"n": 0}

    def flaky_remove(p):
        if p.endswith("clip.mp4.part") and tries["n"] < 2:
            tries["n"] += 1
            raise PermissionError(32, "in use")
        real_remove(p)

    monkeypatch.setattr(vd.os, "remove", flaky_remove)
    assert vd.remove_partials(str(tmp_path), "clip") == ["clip.mp4.part"]
    assert os.listdir(tmp_path) == []


def test_a_retry_takes_the_name_of_the_script_it_saved_before(tmp_path):
    """The video failed or was cancelled, its script stayed: the next try joins it, no '(1)' pair."""
    (tmp_path / "Post.funscript").write_text("{}")
    assert vd.unique_stem(str(tmp_path), "Post", script_is_ours=True) == "Post"
    (tmp_path / "Post.mp4").write_bytes(b"x")                        # a video has it after all: never overwritten
    assert vd.unique_stem(str(tmp_path), "Post", script_is_ours=True) == "Post (1)"


def test_faptap_check_says_what_faptap_says_about_the_script():
    """Dave, 2026-11-22: "make sure users know the script is not available unless paid for on faptap"."""
    answers = {
        "/api/videos/111": {"data": {"id": "111", "name": "Paid one", "downloadable": False, "script": {"url": "scripts/1.csv"},
                                     "description": "<p>Get Script For This Video: https://www.patreon.com/Maker/posts/funscript-x?pr=true&amp;forSale=true</p>"}},
        "/api/videos/222": {"data": {"id": "222", "name": "Free one", "downloadable": True, "script": {"url": "scripts/2.csv"}, "description": ""}},
        "/api/videos/333": {"data": {"id": "333", "name": "No script", "downloadable": False, "script": None, "description": ""}},
    }
    asked = []

    def handler(req: httpx.Request):
        asked.append(req.url.path)
        if req.url.path in answers:
            return httpx.Response(200, json=answers[req.url.path])
        return httpx.Response(404)

    got = _manager(handler).check([f"https://faptap.net/v/{n}" for n in ("111", "222", "333", "444")])
    assert [g["status"] for g in got] == ["ok", "ok", "ok", "dead"]
    assert got[0]["name"] == "Paid one"
    assert got[0]["script"] == {"exists": True, "downloadable": False, "shops": ["https://www.patreon.com/Maker/posts/funscript-x?pr=true&forSale=true"]}
    assert got[1]["script"] == {"exists": True, "downloadable": True, "shops": []}
    assert got[2]["script"]["exists"] is False
    assert not [p for p in asked if p.endswith("/script")]          # the script itself is never asked for


# --- pause, resume, discard; free space (Dave, 2026-11-22: "do all of those") ---

def _wait_for(manager, job_id, statuses, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        job = manager.get(job_id)
        if job.status in statuses:
            return job
        time.sleep(0.02)
    raise AssertionError(f"job never reached {statuses}: {manager.get(job_id).status}")


class _RangeHost:
    """A host that answers Range requests (206) unless told not to, and can hold
    its stream after the first chunk until `release` is set."""

    def __init__(self, content: bytes, ranges: bool = True, hold: bool = False, drop_after: int | None = None):
        self.content, self.ranges, self.hold, self.drop_after = content, ranges, hold, drop_after
        self.release = threading.Event()
        self.range_headers = []

    def __call__(self, req: httpx.Request):
        if req.url.path.endswith("/info"):
            return httpx.Response(200, json={"name": "Clip.mp4", "size": len(self.content)})
        rng = req.headers.get("range")
        self.range_headers.append(rng)
        start = int(rng.split("=")[1].split("-")[0]) if (rng and self.ranges) else 0
        body = self.content[start:]
        host = self

        class Stream(httpx.SyncByteStream):
            def __iter__(self):
                sent = 0
                for i in range(0, len(body), vd.CHUNK):
                    if host.drop_after is not None and sent >= host.drop_after:
                        host.drop_after = None
                        raise httpx.ReadError("connection dropped")
                    if host.hold and i > 0:
                        host.release.wait(5)
                    yield body[i:i + vd.CHUNK]
                    sent += vd.CHUNK

        headers = {"content-length": str(len(body))}
        if start:
            headers["content-range"] = f"bytes {start}-{len(self.content) - 1}/{len(self.content)}"
            return httpx.Response(206, stream=Stream(), headers=headers)
        return httpx.Response(200, stream=Stream(), headers=headers)


def test_pause_keeps_the_part_and_resume_finishes_it_with_a_range(tmp_path):
    content = os.urandom(4 * vd.CHUNK + 33)
    host = _RangeHost(content, hold=True)
    m = _manager(host)
    job = m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Clip")
    while m.get(job.id).bytes == 0:
        time.sleep(0.01)
    assert m.pause(job.id) is True
    host.release.set()
    job = _wait_for(m, job.id, ("paused",))
    assert job.snapshot()["resumable"] is True
    assert os.path.getsize(tmp_path / "Clip.mp4.part") == vd.CHUNK          # kept
    host.hold = False
    assert m.resume(job.id) is not None
    job = _wait(m, job.id)
    assert job.status == "done", job.message
    assert (tmp_path / "Clip.mp4").read_bytes() == content                    # whole, in order
    assert host.range_headers[-1] == f"bytes={vd.CHUNK}-"
    assert not [n for n in os.listdir(tmp_path) if n.endswith(".part")]


def test_a_server_that_ignores_the_range_starts_over(tmp_path):
    content = os.urandom(3 * vd.CHUNK)
    host = _RangeHost(content, ranges=False, hold=True)
    m = _manager(host)
    job = m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Clip")
    while m.get(job.id).bytes == 0:
        time.sleep(0.01)
    m.pause(job.id)
    host.release.set()
    _wait_for(m, job.id, ("paused",))
    host.hold = False
    m.resume(job.id)
    job = _wait(m, job.id)
    assert job.status == "done"
    assert (tmp_path / "Clip.mp4").read_bytes() == content                    # not the first chunk twice


def test_a_dropped_connection_can_be_resumed(tmp_path):
    content = os.urandom(4 * vd.CHUNK + 7)
    host = _RangeHost(content, drop_after=2 * vd.CHUNK)
    m = _manager(host)
    job = _wait(m, m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Clip").id)
    assert job.status == "error" and job.snapshot()["resumable"] is True
    assert m.resume(job.id) is not None
    job = _wait(m, job.id)
    assert job.status == "done"
    assert (tmp_path / "Clip.mp4").read_bytes() == content


def test_cancel_on_a_paused_download_deletes_its_part(tmp_path):
    content = os.urandom(3 * vd.CHUNK)
    host = _RangeHost(content, hold=True)
    m = _manager(host)
    job = m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Clip")
    while m.get(job.id).bytes == 0:
        time.sleep(0.01)
    m.pause(job.id)
    host.release.set()
    _wait_for(m, job.id, ("paused",))
    assert m.cancel(job.id) is True
    assert m.get(job.id).status == "cancelled"
    assert os.listdir(tmp_path) == []
    assert m.clear_finished() == 1


def test_clear_finished_keeps_what_can_be_resumed(tmp_path):
    content = os.urandom(3 * vd.CHUNK)
    host = _RangeHost(content, drop_after=vd.CHUNK)
    m = _manager(host)
    failed = _wait(m, m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Clip").id)
    assert failed.status == "error" and failed.resumable
    assert m.clear_finished() == 0
    assert m.get(failed.id) is not None


def test_a_mega_download_resumes_on_a_16_byte_block(tmp_path):
    content = os.urandom(3 * vd.CHUNK + 5)
    link_key, at, body = _mega_fixture(content, "Original.mp4")
    host = _RangeHost(body, hold=True)

    def handler(req: httpx.Request):
        if req.url.host == "g.api.mega.co.nz":
            return httpx.Response(200, json=[{"s": len(content), "at": at, "g": "https://dl.mega.example/file"}])
        return host(req)

    m = _manager(handler)
    job = m.start(f"https://mega.nz/file/AbCdEfGh#{link_key}", str(tmp_path), "Clip")
    while m.get(job.id).bytes == 0:
        time.sleep(0.01)
    m.pause(job.id)
    host.release.set()
    _wait_for(m, job.id, ("paused",))
    # A part that does not end on a block: the resume steps back to one.
    with open(tmp_path / "Clip.mp4.part", "ab") as f:
        f.write(b"\0" * 5)
    host.hold = False
    m.resume(job.id)
    job = _wait(m, job.id)
    assert job.status == "done", job.message
    assert (tmp_path / "Clip.mp4").read_bytes() == content                    # decrypted whole


def test_no_space_stops_before_writing(tmp_path, monkeypatch):
    content = os.urandom(2 * vd.CHUNK)
    monkeypatch.setattr(vd, "free_space", lambda path: 1000)
    m = _manager(_RangeHost(content))
    job = _wait(m, m.start("https://pixeldrain.com/u/abc", str(tmp_path), "Clip").id)
    assert (job.status, job.error) == ("error", "noSpace")
    assert os.listdir(tmp_path) == [] and not job.resumable


def test_space_route_is_desktop_only_and_answers_free_bytes(tmp_path):
    from fastapi.testclient import TestClient
    from main import app
    assert TestClient(app, client=("192.168.1.50", 5555)).get("/api/downloads/space", params={"dir": str(tmp_path)}).status_code == 403
    r = TestClient(app, base_url="http://127.0.0.1:5123", client=("127.0.0.1", 5555)).get("/api/downloads/space", params={"dir": str(tmp_path)})
    assert r.status_code == 200 and r.json()["free"] > 0


# --- streaming without downloading (2026-11-22) ------------------------------

def test_stream_source_plays_the_hosts_the_downloader_knows():
    import httpx
    from services import video_downloader as vd

    def handler(request: httpx.Request):
        u = str(request.url)
        if "pixeldrain.com/api/file/abc/info" in u:
            return httpx.Response(200, json={"name": "PMVMIX12.mp4"})
        if "pixeldrain.com/api/list/lst" in u:
            return httpx.Response(200, json={"files": [
                {"id": "s1", "name": "a.mp4", "size": 10}, {"id": "s2", "name": "b.mkv", "size": 99}, {"id": "s3", "name": "c.funscript", "size": 999}]})
        if "pixeldrain.com/api/file/gone/info" in u:
            return httpx.Response(404)
        return httpx.Response(404)
    make = lambda: httpx.Client(transport=httpx.MockTransport(handler))

    one = vd.stream_source("https://pixeldrain.com/u/abc", make)
    assert one["streamUrl"] == "https://pixeldrain.com/api/file/abc" and one["title"] == "PMVMIX12" and one["isHls"] is False
    lst = vd.stream_source("https://pixeldrain.com/l/lst", make)
    assert lst["streamUrl"] == "https://pixeldrain.com/api/file/s2"          # the largest VIDEO, not the script
    direct = vd.stream_source("https://example.com/media/clip.mp4?sig=1", make)
    assert direct["streamUrl"].endswith("clip.mp4?sig=1") and direct["title"] == "clip"
    assert vd.stream_source("https://www.xvideos.com/video.x/y", make) is None   # yt-dlp's
    with pytest.raises(vd.DownloadError):
        vd.stream_source("https://pixeldrain.com/u/gone", make)


# --- rule34video (2026-11-22: yt-dlp's extractor finds no formats) -----------

_R34_PAGE = """<html><head><meta property="og:title" content="Some &amp; Title"><title>x</title></head><body>
<div class="fs-sheet__body vp-sheet__body" role="menu">
  <a class="tag_item tag_item_download vp-sheet__item" href="https://rule34video.com/get_file/1/aa/4742000/4742659/4742659_1080p.mp4/?v-acctoken=A&amp;download=true">MP4 1080p</a>
  <a class="tag_item tag_item_download vp-sheet__item" href="https://rule34video.com/get_file/1/bb/4742000/4742659/4742659_720p.mp4/?v-acctoken=B">MP4 720p</a>
  <a class="tag_item" href="https://rule34video.com/tags/x/">a tag</a>
</div>
<script>var flashvars = { video_url: 'https://rule34video.com/get_file/1/cc/4742000/4742659/4742659_360.mp4/?t=C', video_url_text: '360p' };</script>
</body></html>"""


def test_rule34video_reads_the_pages_download_buttons():
    from services import video_downloader as vd
    links = vd.rule34video_links(_R34_PAGE)
    assert [l["height"] for l in links] == [1080, 720]                       # the buttons, tallest first
    assert links[0]["url"].endswith("?v-acctoken=A&download=true")           # &amp; unescaped
    assert [l["height"] for l in vd.rule34video_links(_R34_PAGE.replace("tag_item_download", "x"))] == [360]
    assert vd.rule34video_title(_R34_PAGE) == "Some & Title"
    assert vd.classify("https://rule34video.com/video/4742659/a-b/")["kind"] == "tube"   # behind the Tube switch


def test_rule34video_streams_from_the_cdn_the_button_redirects_to():
    import httpx
    from services import video_downloader as vd
    calls = []

    def handler(request: httpx.Request):
        u = str(request.url)
        calls.append(u)
        if "/video/" in u:
            return httpx.Response(200, text=_R34_PAGE)
        if "_1080p.mp4" in u and sum("_1080p" in c for c in calls) == 1:
            return httpx.Response(502)                                       # the quick second request
        if "_1080p.mp4" in u:
            return httpx.Response(302, headers={"location": "https://eu-cdn.example/v_1080p.mp4?sig=1"})
        return httpx.Response(404)

    make = lambda: httpx.Client(transport=httpx.MockTransport(handler))
    vd_sleep = vd.time.sleep
    vd.time.sleep = lambda s: None
    try:
        src = vd.stream_source("https://rule34video.com/video/4742659/a-b/", make)
    finally:
        vd.time.sleep = vd_sleep
    assert src["streamUrl"] == "https://eu-cdn.example/v_1080p.mp4?sig=1" and src["height"] == 1080
    assert src["headers"]["Referer"].startswith("https://rule34video.com/video/")
    assert len(calls) == 3                                                    # page, 502, redirect: no more


# --- EroSync (2026-11-22: a post's video embedded from erosync.net) ----------

# --- gofile: the app resolves, the backend downloads with the guest cookie (2026-11-24) ---

GOFILE_RESOLVED = {"link": "https://file-na-phx-1.gofile.io/download/web/b/Clip.mp4", "name": "Clip.mp4",
                   "size": 11, "cookie": "accountToken=abcdefghij0123456789"}


def test_gofile_resolution_is_checked():
    ok = vd.gofile_resolved(GOFILE_RESOLVED)
    assert ok == GOFILE_RESOLVED
    assert vd.gofile_resolved({**GOFILE_RESOLVED, "link": "https://evil.example/Clip.mp4"}) is None
    assert vd.gofile_resolved({**GOFILE_RESOLVED, "link": "http://file.gofile.io/x.mp4"}) is None
    assert vd.gofile_resolved({**GOFILE_RESOLVED, "cookie": "session=steal; accountToken=x"}) is None
    assert vd.gofile_resolved(None) is None


def test_gofile_downloads_the_file_link_with_the_guest_cookie(tmp_path):
    seen = {}

    def handler(request: httpx.Request):
        if request.url.host == "file-na-phx-1.gofile.io":
            seen["cookie"] = request.headers.get("cookie")
            return httpx.Response(200, content=b"hello video", headers={"content-length": "11"})
        return httpx.Response(404)

    m = _manager(handler)
    job = m.start("https://gofile.io/d/UX0LG6wr", str(tmp_path), "Futa post", resolved=GOFILE_RESOLVED)
    job = _wait(m, job.id)
    assert job.status == "done", job.message
    assert seen["cookie"] == "accountToken=abcdefghij0123456789"
    assert job.name == "Clip.mp4" and job.host == "gofile"
    assert open(job.path, "rb").read() == b"hello video"
    assert job.path.endswith("Futa post.mp4")


def _erosync_host(status=200, body=None):
    import httpx

    def handler(request: httpx.Request):
        if "/api/videos/abc6d128-7035-44d3-88a4-64dd63a2bc5f" in str(request.url):
            return httpx.Response(status, json=body if body is not None else {
                "id": "abc6d128-7035-44d3-88a4-64dd63a2bc5f", "title": "POV squat cowgirl", "status": "ready", "duration": 774,
                "streamUrl": "https://cdn.erosync.net/playlists/f4/master.m3u8", "tags": ["cowgirl", 3]})
        return httpx.Response(404)
    return lambda: httpx.Client(transport=httpx.MockTransport(handler))


def test_erosync_embed_and_page_links_are_an_always_on_video_host():
    from services import video_downloader as vd
    for u in ("https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f", "https://erosync.net/videos/abc6d128-7035-44d3-88a4-64dd63a2bc5f"):
        assert {k: vd.classify(u)[k] for k in ("kind", "host", "supported")} == {"kind": "videohost", "host": "erosync", "supported": True}
    assert vd.classify("https://erosync.net/@Strawberry")["host"] != "erosync"


def test_erosync_reads_its_public_api_for_the_stream():
    from services import video_downloader as vd
    u = "https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f"
    with _erosync_host()() as c:
        v = vd.erosync_video(c, u)
    assert v == {"title": "POV squat cowgirl", "streamUrl": "https://cdn.erosync.net/playlists/f4/master.m3u8", "duration": 774, "tags": ["cowgirl"], "thumbnail": None}
    src = vd.stream_source(u, _erosync_host())
    assert src["isHls"] is True and src["site"] == "EroSync" and src["streamUrl"].endswith("master.m3u8")
    with pytest.raises(vd.DownloadError) as e, _erosync_host(404)() as c:
        vd.erosync_video(c, u)
    assert e.value.code == "notFound"
    with pytest.raises(vd.DownloadError) as e, _erosync_host(body={"status": "processing", "streamUrl": None})() as c:
        vd.erosync_video(c, u)
    assert e.value.code == "noVideo"


def test_erosync_check_says_working_or_dead():
    from services import video_downloader as vd
    u = "https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f"
    ok = vd.DownloadManager(client_factory=_erosync_host())._check_one(u)
    assert ok["status"] == "ok" and ok["name"] == "POV squat cowgirl"
    # Its length, for the tab's length check before a download (review 2.3).
    assert ok["duration"] == 774.0
    assert vd.DownloadManager(client_factory=_erosync_host(404))._check_one(u)["status"] == "dead"


# --- one bar for a download in parts (2026-11-22: EroSync's video + audio) ---

def test_parts_progress_is_one_bar_over_video_and_audio():
    from services.video_downloader import PartsProgress
    fmts = [{"format_id": "2753", "filesize_approx": 250}, {"format_id": "audio", "filesize_approx": 13}]
    # As yt-dlp reports a part: its own format, the list of parts removed.
    info = lambda fid: {"format_id": fid}
    p = PartsProgress()
    p.expect(fmts)          # from the before-download step
    # The video: the audio still to come is counted in the total.
    assert p.downloading({"filename": "s.f2753.mp4", "downloaded_bytes": 100, "total_bytes_estimate": 250, "info_dict": info("2753")}) == (100, 263)
    assert p.finished({"filename": "s.f2753.mp4", "total_bytes": 250, "info_dict": info("2753")}) is False   # a part, not the file
    # The audio: the bar carries on from the video, it does not restart.
    b, t = p.downloading({"filename": "s.faudio.m4a", "downloaded_bytes": 3, "total_bytes": 13, "info_dict": info("audio")})
    assert (b, t) == (253, 263)
    # One part: its file is the download.
    q = PartsProgress()
    assert q.downloading({"filename": "v.mp4", "downloaded_bytes": 5, "total_bytes": 10, "info_dict": {}}) == (5, 10)
    assert q.finished({"filename": "v.mp4", "total_bytes": 10, "info_dict": {}}) is True
    assert PartsProgress().downloading({"filename": "x", "downloaded_bytes": 7, "info_dict": {}}) == (7, 0)   # size unknown


def test_parts_progress_guesses_an_unknown_audio_part():
    from services.video_downloader import PartsProgress
    p = PartsProgress()
    p.expect([{"format_id": "v"}, {"format_id": "a"}])          # EroSync's HLS: no sizes up front
    b, t = p.downloading({"filename": "s.fv.mp4", "downloaded_bytes": 200, "total_bytes_estimate": 200, "info_dict": {"format_id": "v"}})
    assert (b, t) == (200, 210) and b < t                       # the video done is not 100 %


# --- a single-file stream's qualities (2026-11-23) ---------------------------

def test_pick_height_takes_the_tallest_under_the_limit_else_the_shortest():
    from services.video_downloader import pick_height
    items = [{"height": 480}, {"height": 1080}, {"height": 360}, {"height": 720}]
    assert pick_height(items)["height"] == 1080
    assert pick_height(items, 720)["height"] == 720
    assert pick_height(items, 600)["height"] == 480
    assert pick_height(items, 200)["height"] == 360
    assert pick_height([]) is None


def test_rule34video_plays_the_asked_height_and_keeps_the_others_for_later():
    import httpx
    from services import video_downloader as vd
    hits = []

    def handler(request: httpx.Request):
        u = str(request.url)
        hits.append(u)
        if "/video/" in u:
            return httpx.Response(200, text=_R34_PAGE)
        if "_720p.mp4" in u:
            return httpx.Response(302, headers={"location": "https://eu-cdn.example/v_720p.mp4"})
        return httpx.Response(404)

    src = vd.stream_source("https://rule34video.com/video/4742659/a-b/", lambda: httpx.Client(transport=httpx.MockTransport(handler)), max_height=720)
    assert src["height"] == 720 and src["streamUrl"] == "https://eu-cdn.example/v_720p.mp4"
    alts = {a["height"]: a for a in src["alternatives"]}
    assert alts[720]["streamUrl"] == "https://eu-cdn.example/v_720p.mp4" and alts[720]["lazyRedirect"] is False
    assert "/get_file/" in alts[1080]["streamUrl"] and alts[1080]["lazyRedirect"] is True
    assert not any("_1080p" in h for h in hits)          # the others are not asked for now (the site 502s quick repeats)


def test_yt_dlp_progressive_files_become_qualities():
    from services import resolver
    info = {"title": "T", "formats": [
        {"url": "https://c/240.mp4", "height": 240, "vcodec": "h264", "acodec": "aac", "protocol": "https", "ext": "mp4"},
        {"url": "https://c/720.mp4", "height": 720, "vcodec": "h264", "acodec": "aac", "protocol": "https", "ext": "mp4", "tbr": 2000},
        {"url": "https://c/720b.mp4", "height": 720, "vcodec": "h264", "acodec": "aac", "protocol": "https", "ext": "mp4", "tbr": 900},
        {"url": "https://c/1080.mp4", "height": 1080, "vcodec": "h264", "acodec": "aac", "protocol": "https", "ext": "mp4"},
    ]}
    pick = resolver._pick_format(info, 720)
    assert pick["url"] == "https://c/720.mp4"                      # the better 720p file
    assert [a["height"] for a in pick["alternatives"]] == [1080, 720, 240]
    assert resolver._pick_format(info)["url"] == "https://c/1080.mp4"
    one = resolver._pick_format({"formats": info["formats"][:1]})
    assert one["alternatives"] == []


def test_resolve_route_gives_a_token_per_quality_and_finds_a_button_link_on_first_play(monkeypatch):
    import httpx
    from fastapi.testclient import TestClient
    from main import app
    from routes import media
    from services import video_downloader as vd
    monkeypatch.setattr(vd, "stream_source", lambda url, client_factory=None, max_height=None: {
        "title": "R", "streamUrl": "https://cdn/720.mp4", "isHls": False, "headers": {}, "site": "x", "height": 720,
        "alternatives": [{"height": 1080, "streamUrl": "https://site/get_file/1080/", "lazyRedirect": True},
                         {"height": 720, "streamUrl": "https://cdn/720.mp4", "lazyRedirect": False}]})
    c = TestClient(app, base_url="http://127.0.0.1:5123", client=("127.0.0.1", 5555))
    r = c.post("/api/media/resolve", params={"url": "https://rule34video.com/video/1/x/", "maxHeight": 720})
    body = r.json()
    assert r.status_code == 200 and [l["height"] for l in body["levels"]] == [1080, 720]
    assert body["levels"][1]["proxyUrl"] == body["proxyUrl"]              # the one playing is the same token
    tok = body["levels"][0]["proxyUrl"].split("/")[4]
    assert media._remote_streams[tok]["lazyRedirect"] is True

    seen = []

    class FakeClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            seen.append(url)
            return httpx.Response(302, headers={"location": "https://cdn/1080.mp4"})

    async def fake_fetch(url, headers, range_header=None):
        from fastapi.responses import Response
        return Response(content=url.encode())

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(media, "_proxy_fetch", fake_fetch)
    assert c.get(f"/api/media/remote/{tok}/file").text == "https://cdn/1080.mp4"
    assert c.get(f"/api/media/remote/{tok}/file").text == "https://cdn/1080.mp4"
    assert seen == ["https://site/get_file/1080/"]                         # resolved once


def test_several_videos_behind_one_link_the_scripts_one_is_taken(tmp_path):
    # A folder holding Part 1 and Part 2, each with its own script (2026-11-24):
    # the one named like the script, not the biggest.
    files = [{"name": "Holo Wulf Part 1.mp4", "size": 900}, {"name": "Holo Wulf Part 2.mp4", "size": 500},
             {"name": "Bonus clip.mp4", "size": 1000}]
    assert vd.pick_by_hint(files, "Holo Wulf Part 2.funscript")["name"] == "Holo Wulf Part 2.mp4"
    # Every name equally close, or no hint: the biggest.
    assert vd.pick_by_hint(files[:2], "Holo Wulf.funscript")["name"] == "Holo Wulf Part 1.mp4"
    assert vd.pick_by_hint(files, "")["name"] == "Bonus clip.mp4"
    part2 = os.urandom(400)
    key, nodes, bodies = _mega_folder_fixture([
        ("PaRt0001", "Scene Two Girls 1080p.mp4", os.urandom(900), "ROOT0001"),
        ("PaRt0002", "Scene Three Girls 1080p.mp4", part2, "ROOT0001"),
    ])
    m = _manager(_mega_folder_host(nodes, bodies, []))
    job = _wait(m, m.start(f"https://mega.nz/folder/FoLdEr01#{key}", str(tmp_path), "Post", hint="Scene Three Girls.funscript").id)
    assert job.status == "done" and job.name == "Scene Three Girls 1080p.mp4"
    assert (tmp_path / "Post.mp4").read_bytes() == part2


# Dave, 2026-11-26: a download's connection stalled; the card froze with nothing
# said, and Cancel (pressed three times) seemed to do nothing until the read's
# timeout. The job now says how long no bytes have come, and that a stop was
# asked for and is waiting on the connection.
def test_a_stalled_download_and_a_stop_waiting_on_it_are_reported(tmp_path, monkeypatch):
    from services import video_downloader as vdm
    job = vdm.Job("https://pixeldrain.com/u/abc", str(tmp_path), "Stem", False)
    clock = {"t": 1000.0}
    monkeypatch.setattr(vdm.time, "monotonic", lambda: clock["t"])
    assert job.snapshot()["stalledFor"] == 0          # queued: never stalled
    job.status = "downloading"
    job.progress_at = clock["t"]
    clock["t"] += 12.4
    snap = job.snapshot()
    assert snap["stalledFor"] == 12
    assert snap["stopping"] is False
    job._cancel.set()                                  # Cancel pressed; the read still waiting
    assert job.snapshot()["stopping"] is True
    job.status = "cancelled"                           # the worker got to it
    assert job.snapshot()["stopping"] is False
    assert job.snapshot()["stalledFor"] == 0
