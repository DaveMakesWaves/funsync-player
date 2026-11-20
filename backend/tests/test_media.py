"""Tests for media streaming routes — video serving, funscripts, thumbnails."""

import os
import hashlib
import sys
import json
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport
from main import app
from routes.media import register_videos, get_video_registry, _path_to_id

PROJECT_ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
TEST_VIDEO = os.path.join(PROJECT_ROOT, "Test.mp4")
TEST_FUNSCRIPT = os.path.join(PROJECT_ROOT, "Test.funscript")


# --- Unit tests ---

class TestPathToId:
    def test_returns_12_char_hex(self):
        vid_id = _path_to_id("C:\\Videos\\test.mp4")
        assert len(vid_id) == 12
        assert all(c in "0123456789abcdef" for c in vid_id)

    def test_deterministic(self):
        a = _path_to_id("C:\\Videos\\test.mp4")
        b = _path_to_id("C:\\Videos\\test.mp4")
        assert a == b

    def test_different_paths_different_ids(self):
        a = _path_to_id("C:\\Videos\\test.mp4")
        b = _path_to_id("C:\\Videos\\other.mp4")
        assert a != b


class TestRegisterVideos:
    def test_register_populates_registry(self):
        register_videos([
            {"path": "C:\\Videos\\a.mp4", "name": "a.mp4"},
            {"path": "C:\\Videos\\b.mp4", "name": "b.mp4"},
        ])
        reg = get_video_registry()
        assert len(reg) == 2

    def test_register_clears_previous(self):
        register_videos([{"path": "C:\\a.mp4", "name": "a.mp4"}])
        register_videos([{"path": "C:\\b.mp4", "name": "b.mp4"}])
        reg = get_video_registry()
        assert len(reg) == 1

    def test_video_lookup_by_id(self):
        register_videos([{"path": "C:\\test.mp4", "name": "test.mp4"}])
        vid_id = _path_to_id("C:\\test.mp4")
        reg = get_video_registry()
        assert vid_id in reg
        assert reg[vid_id]["name"] == "test.mp4"

    def test_empty_list(self):
        register_videos([])
        assert len(get_video_registry()) == 0


# --- Integration tests ---

@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:  # what the desktop dials (FT-009 gate checks Host)
        yield c


@pytest.mark.anyio
async def test_stream_not_found(client):
    response = await client.get("/api/media/stream/nonexistent")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_script_not_found(client):
    response = await client.get("/api/media/script/nonexistent")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_thumb_not_found(client):
    response = await client.get("/api/media/thumb/nonexistent")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_register_endpoint(client):
    response = await client.post("/api/media/register", json={
        "videos": [
            {"path": "C:\\fake\\video.mp4", "name": "video.mp4"},
        ]
    })
    assert response.status_code == 200
    data = response.json()
    assert data["registered"] == 1


@pytest.mark.anyio
async def test_stream_real_video(client):
    """Stream the real Test.mp4 with range request."""
    if not os.path.exists(TEST_VIDEO):
        pytest.skip("Test.mp4 not found")

    vid_id = _path_to_id(TEST_VIDEO)
    register_videos([{"path": TEST_VIDEO, "name": "Test.mp4"}])

    # Full request
    response = await client.get(f"/api/media/stream/{vid_id}")
    assert response.status_code == 200
    assert "Accept-Ranges" in response.headers
    assert response.headers["accept-ranges"] == "bytes"

    # Range request
    response = await client.get(
        f"/api/media/stream/{vid_id}",
        headers={"Range": "bytes=0-1023"}
    )
    assert response.status_code == 206
    assert "Content-Range" in response.headers
    assert len(response.content) == 1024


@pytest.mark.anyio
async def test_serve_real_funscript(client):
    """Serve the real Test.funscript."""
    if not os.path.exists(TEST_FUNSCRIPT):
        pytest.skip("Test.funscript not found")

    vid_id = _path_to_id(TEST_VIDEO)
    register_videos([{
        "path": TEST_VIDEO,
        "name": "Test.mp4",
        "funscriptPath": TEST_FUNSCRIPT,
    }])

    response = await client.get(f"/api/media/script/{vid_id}")
    assert response.status_code == 200
    data = response.json()
    assert "actions" in data


@pytest.mark.anyio
async def test_serve_funscript_variant(client, tmp_path):
    """`?variant=<label>` returns the matching variant's funscript file
    (not the primary). Lets the web-remote fetch any variant for its
    mini-heatmap previews and switch the active variant on the desktop
    without having to change the primary."""
    primary = tmp_path / "video.funscript"
    primary.write_text(json.dumps({"actions": [{"at": 0, "pos": 0}]}))
    soft = tmp_path / "video (Soft).funscript"
    soft.write_text(json.dumps({"actions": [{"at": 0, "pos": 50}]}))

    vid_id = _path_to_id(str(tmp_path / "video.mp4"))
    register_videos([{
        "path": str(tmp_path / "video.mp4"),
        "name": "video.mp4",
        "funscriptPath": str(primary),
        "variants": [
            {"label": "Default", "path": str(primary), "name": "video.funscript"},
            {"label": "Soft", "path": str(soft), "name": "video (Soft).funscript"},
        ],
    }])

    # Default (no variant param) — primary funscript.
    default = await client.get(f"/api/media/script/{vid_id}")
    assert default.status_code == 200
    assert default.json()["actions"][0]["pos"] == 0

    # ?variant=Soft — the soft variant's actions, not the primary.
    soft_resp = await client.get(f"/api/media/script/{vid_id}?variant=Soft")
    assert soft_resp.status_code == 200
    assert soft_resp.json()["actions"][0]["pos"] == 50


@pytest.mark.anyio
async def test_serve_funscript_unknown_variant_404(client, tmp_path):
    """Asking for a variant the video doesn't have returns 404 with a
    helpful message (Nielsen #9). Don't silently fall back to the
    primary — the caller's expectation was specific."""
    primary = tmp_path / "video.funscript"
    primary.write_text(json.dumps({"actions": []}))

    vid_id = _path_to_id(str(tmp_path / "video.mp4"))
    register_videos([{
        "path": str(tmp_path / "video.mp4"),
        "name": "video.mp4",
        "funscriptPath": str(primary),
        "variants": [
            {"label": "Default", "path": str(primary), "name": "video.funscript"},
        ],
    }])

    response = await client.get(f"/api/media/script/{vid_id}?variant=Ghost")
    assert response.status_code == 404
    assert "Ghost" in response.json()["detail"]


@pytest.mark.anyio
async def test_open_ended_range_reaches_the_end_of_the_file(client):
    """An open-ended range must deliver the whole remainder.

    Kept after the 16MB window was reverted (it desynced A/V on a real
    device): this now guards the un-capped path, and would fail again for
    anything that quietly shortens a response.
    """
    if not os.path.exists(TEST_VIDEO):
        pytest.skip("Test.mp4 not found")

    vid_id = _path_to_id(TEST_VIDEO)
    register_videos([{"path": TEST_VIDEO, "name": "Test.mp4"}])
    file_size = os.path.getsize(TEST_VIDEO)

    got = 0
    for _ in range(50):
        response = await client.get(
            f"/api/media/stream/{vid_id}",
            headers={"Range": f"bytes={got}-"},
        )
        assert response.status_code == 206
        got += len(response.content)
        if got >= file_size:
            break
    assert got == file_size


@pytest.mark.anyio
async def test_windowed_range_returns_byte_identical_data(client):
    """Windowed serving must be lossless, not merely well-shaped.

    A short read that still claims a full Content-Length does not make a
    player error — it makes it DRIFT, which is how the first version of this
    (an is_disconnected() check that broke the loop mid-body) desynced audio
    from video within minutes of shipping (Dave, 2026-08-21).
    """
    if not os.path.exists(TEST_VIDEO):
        pytest.skip("Test.mp4 not found")

    vid_id = _path_to_id(TEST_VIDEO)
    register_videos([{"path": TEST_VIDEO, "name": "Test.mp4"}])

    with open(TEST_VIDEO, "rb") as f:
        on_disk = f.read()

    # Pull it the way a browser does: open-ended range, window after window.
    over_http = b""
    for _ in range(200):
        response = await client.get(
            f"/api/media/stream/{vid_id}",
            headers={"Range": f"bytes={len(over_http)}-"},
        )
        assert response.status_code == 206
        body = response.content
        # Every window must deliver exactly what its headers promised.
        assert len(body) == int(response.headers["content-length"])
        over_http += body
        if len(over_http) >= len(on_disk):
            break

    assert len(over_http) == len(on_disk)
    assert hashlib.sha256(over_http).hexdigest() == hashlib.sha256(on_disk).hexdigest()


@pytest.mark.anyio
async def test_explicit_range_is_honoured_exactly(client):
    """A client that names its end gets exactly that, cap or no cap.

    Only the open-ended form is windowed — narrowing an explicit range would
    break byte-exact consumers.
    """
    if not os.path.exists(TEST_VIDEO):
        pytest.skip("Test.mp4 not found")

    vid_id = _path_to_id(TEST_VIDEO)
    register_videos([{"path": TEST_VIDEO, "name": "Test.mp4"}])

    response = await client.get(
        f"/api/media/stream/{vid_id}",
        headers={"Range": "bytes=10-4009"},
    )
    assert response.status_code == 206
    assert len(response.content) == 4000
    assert response.headers["content-range"].startswith("bytes 10-4009/")


@pytest.mark.anyio
async def test_stream_range_middle(client):
    """Range request for middle of file."""
    if not os.path.exists(TEST_VIDEO):
        pytest.skip("Test.mp4 not found")

    vid_id = _path_to_id(TEST_VIDEO)
    register_videos([{"path": TEST_VIDEO, "name": "Test.mp4"}])

    response = await client.get(
        f"/api/media/stream/{vid_id}",
        headers={"Range": "bytes=1000-1999"}
    )
    assert response.status_code == 206
    assert len(response.content) == 1000
    cr = response.headers["content-range"]
    assert cr.startswith("bytes 1000-1999/")


# --- Malformed and suffix ranges (FT-083) ---
#
# The parser split on "-": "bytes=-100" (the last 100 bytes, RFC 9110 14.1.2)
# became 0-100; "bytes=999-0" or a start past EOF promised a negative
# Content-Length; a multi-range fell back to the whole file sent as a 206.
# Run against a file of known bytes, so nothing depends on Test.mp4.

def _known_file(tmp_path, size=5000):
    data = bytes((i * 7 + 3) % 256 for i in range(size))
    path = tmp_path / "known.mp4"
    path.write_bytes(data)
    vid_id = _path_to_id(str(path))
    register_videos([{"path": str(path), "name": "known.mp4"}])
    return vid_id, data


@pytest.mark.anyio
async def test_suffix_range_returns_last_n_bytes(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    size = len(data)
    response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": "bytes=-100"})
    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes {size - 100}-{size - 1}/{size}"
    assert response.headers["content-length"] == "100"
    assert response.content == data[-100:]


@pytest.mark.anyio
async def test_suffix_longer_than_the_file_returns_all_of_it(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    size = len(data)
    response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": "bytes=-999999"})
    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 0-{size - 1}/{size}"
    assert response.content == data


@pytest.mark.anyio
async def test_inverted_range_is_416(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": "bytes=999-0"})
    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{len(data)}"
    assert response.content == b""


@pytest.mark.anyio
async def test_range_past_eof_is_416(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    size = len(data)
    for header in (f"bytes={size}-", f"bytes={size + 10}-{size + 20}", "bytes=-0"):
        response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": header})
        assert response.status_code == 416, header
        assert response.headers["content-range"] == f"bytes */{size}", header


@pytest.mark.anyio
async def test_multi_range_serves_full_200(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": "bytes=0-1,5-6"})
    assert response.status_code == 200
    assert "content-range" not in response.headers
    assert response.content == data


@pytest.mark.anyio
async def test_malformed_range_is_ignored(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    for header in ("bytes=abc-def", "items=0-10", "bytes=-", "bytes 0-10"):
        response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": header})
        assert response.status_code == 200, header
        assert response.content == data, header


@pytest.mark.anyio
async def test_end_past_eof_is_clamped_and_open_range_runs_to_eof(client, tmp_path):
    vid_id, data = _known_file(tmp_path)
    size = len(data)
    response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": "bytes=4900-99999"})
    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 4900-{size - 1}/{size}"
    assert response.content == data[4900:]
    response = await client.get(f"/api/media/stream/{vid_id}", headers={"Range": "BYTES=4990-"})
    assert response.status_code == 206
    assert response.content == data[4990:]


# --- Thumbnail cache dir is the backend's own (V22) ---
#
# The cache dir used to arrive only in the `thumbCacheDir` field of ONE
# fire-and-forget registration at the end of the main-process scan. When the
# boot scan beat uvicorn, that POST was lost, the renderer's retried
# registration never carried the field, and every thumbnail answered 500
# "Thumbnail cache not configured" until the next scan.

def _record_thumb_jobs(monkeypatch):
    """Stub the ffmpeg job queue; return the list of thumb paths it was asked for."""
    import routes.media as media
    jobs = []
    monkeypatch.setattr(
        media, "_queue_thumb_generation",
        lambda video_id, filepath, thumb_path, seek_pct=None: jobs.append(thumb_path),
    )
    return jobs


@pytest.mark.anyio
async def test_thumb_served_when_the_scans_cache_dir_post_was_lost(client, tmp_path, monkeypatch):
    """The losing boot: backend started with --user-data-dir, the scan's POST
    (the only one carrying thumbCacheDir) never arrived, and the renderer's
    retried registration has no thumbCacheDir. Thumbnails must still be served,
    from the same <userData>/thumb-cache the scan would have named."""
    import main
    import routes.locale as locale
    import routes.media as media
    monkeypatch.setattr(media, "_thumb_cache_dir", None)
    monkeypatch.setattr(locale, "_user_data_dir", None)
    jobs = _record_thumb_jobs(monkeypatch)

    user_data = tmp_path / "userData"
    user_data.mkdir()
    main.apply_user_data_dir(str(user_data))   # what `python main.py --user-data-dir` runs

    video = tmp_path / "Clip.mp4"
    video.write_bytes(b"\x00" * 16)
    # The renderer's payload: videos + groupings, no thumbCacheDir.
    res = await client.post("/api/media/register", json={
        "videos": [{"path": str(video), "name": "Clip.mp4"}],
    })
    assert res.status_code == 200

    res = await client.get(f"/api/media/thumb/{_path_to_id(str(video))}")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"   # placeholder while it generates
    assert jobs == [os.path.join(str(user_data), "thumb-cache", f"{_path_to_id(str(video))}.jpg")]
    assert os.path.isdir(user_data / "thumb-cache")


@pytest.mark.anyio
async def test_thumb_never_500s_for_want_of_a_cache_dir(client, tmp_path, monkeypatch):
    """No --user-data-dir and no thumbCacheDir ever (a backend run by hand):
    still a thumbnail, never a 500."""
    import routes.media as media
    import tempfile
    monkeypatch.setattr(media, "_thumb_cache_dir", None)
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    jobs = _record_thumb_jobs(monkeypatch)

    video = tmp_path / "Clip.mp4"
    video.write_bytes(b"\x00" * 16)
    register_videos([{"path": str(video), "name": "Clip.mp4"}])

    res = await client.get(f"/api/media/thumb/{_path_to_id(str(video))}")
    assert res.status_code == 200
    assert len(jobs) == 1
    assert os.path.dirname(jobs[0]) == os.path.join(str(tmp_path), "funsync_vr_thumbs")


# --- /register is desktop-only (FT-009) ---
#
# A registration decides which files /stream serves. It used to take any path
# from any LAN host or web page, so two requests read any file on the disk:
# register it, then stream it by md5(path)[:12]. config.json holds the Handy
# key, the Autoblow token and the EroScripts cookie in plaintext. These tests
# make that exact attempt and assert on what comes back, not on the status
# alone.

def _client_from(host):
    transport = ASGITransport(app=app, client=(host, 50000))
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:5123")


def _secret_file(tmp_path):
    secret = tmp_path / "config.json"
    secret.write_text('{"settings":{"handy":{"connectionKey":"TESTKEY01"}}}', encoding="utf-8")
    return str(secret)


async def _register_then_stream(c, secret, headers=None):
    reg = await c.post("/api/media/register", json={
        "videos": [{"path": secret, "name": "config.json"}],
        "thumbCacheDir": os.path.join(os.path.dirname(secret), "planted-dir"),
    }, headers=headers or {})
    stream = await c.get(f"/api/media/stream/{_path_to_id(secret)}")
    return reg, stream


@pytest.mark.anyio
async def test_register_rejects_lan_client(tmp_path):
    register_videos([{"path": "C:\\lib\\Kept.mp4", "name": "Kept.mp4"}])
    before = dict(get_video_registry())
    secret = _secret_file(tmp_path)

    async with _client_from("192.168.1.50") as c:
        reg, stream = await _register_then_stream(c, secret)

    assert reg.status_code == 403
    assert get_video_registry() == before
    assert stream.status_code == 404
    assert b"TESTKEY01" not in stream.content
    assert not (tmp_path / "planted-dir").exists()


@pytest.mark.anyio
async def test_register_rejects_cross_origin_browser(tmp_path):
    """A web page in the user's own browser: loopback, but its Origin is the
    page's, and a page cannot remove it."""
    register_videos([{"path": "C:\\lib\\Kept.mp4", "name": "Kept.mp4"}])
    before = dict(get_video_registry())
    secret = _secret_file(tmp_path)

    async with _client_from("127.0.0.1") as c:
        reg, stream = await _register_then_stream(
            c, secret, headers={"Origin": "https://evil.example"})

    assert reg.status_code == 403
    assert get_video_registry() == before
    assert stream.status_code == 404
    assert b"TESTKEY01" not in stream.content


@pytest.mark.anyio
@pytest.mark.parametrize("origin", [None, "file://"])
async def test_register_accepts_desktop(tmp_path, origin):
    """Electron main (Node fetch, no Origin) and the renderer (a file:// page)
    still register, and what they register streams."""
    video = tmp_path / "Clip.mp4"
    video.write_bytes(b"\x00\x01\x02\x03")
    headers = {"Origin": origin} if origin else {}

    async with _client_from("127.0.0.1") as c:
        reg = await c.post("/api/media/register", json={
            "videos": [{"path": str(video), "name": "Clip.mp4"}],
        }, headers=headers)
        assert reg.status_code == 200
        assert reg.json()["registered"] == 1
        stream = await c.get(f"/api/media/stream/{_path_to_id(str(video))}")

    assert stream.status_code == 200
    assert stream.content == b"\x00\x01\x02\x03"


# --- FT-044: speed stats for BOM funscripts, and a failed read stays unknown ---

def _write_script(path, actions, bom=False):
    text = json.dumps({"version": "1.0", "actions": actions})
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
    return str(path)


def _register_without_probes(monkeypatch, videos):
    """Register like a scan does, but run the speed probe by hand (no thread)."""
    import routes.media as media
    monkeypatch.setattr(media, "_queue_speed_probes", lambda: None)
    monkeypatch.setattr(media, "_queue_duration_probes", lambda: None)
    register_videos(videos)
    return media


@pytest.mark.anyio
async def test_speed_probe_reads_a_bom_funscript(client, tmp_path, monkeypatch):
    """A funscript saved with a UTF-8 BOM gets its real speed, and
    /speed-stats lists it. It used to fail json.load and get 0/0 for good."""
    # 0 -> 100 in 400 ms, back in 400 ms: 250 units/s every stroke.
    actions = [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}, {"at": 800, "pos": 0}]
    fs_path = _write_script(tmp_path / "Bravo Duplicate.funscript", actions, bom=True)
    video_path = str(tmp_path / "Bravo Duplicate.mp4")
    media = _register_without_probes(monkeypatch, [
        {"path": video_path, "name": "Bravo Duplicate.mp4", "funscriptPath": fs_path},
    ])
    vid_id = _path_to_id(video_path)

    media._speed_probe_worker([(vid_id, fs_path)])

    entry = get_video_registry()[vid_id]
    assert entry["avgSpeed"] == 250
    assert entry["maxSpeed"] == 250
    stats = (await client.get("/api/media/speed-stats")).json()
    assert stats[fs_path] == {"avgSpeed": 250, "maxSpeed": 250}


@pytest.mark.anyio
async def test_speed_probe_failure_stays_unknown(client, tmp_path, monkeypatch):
    """A script the probe cannot parse is left UNKNOWN (None) and is not in
    /speed-stats, so the renderer never caches a fake 0/0 for it."""
    bad = tmp_path / "Broken.funscript"
    bad.write_bytes(b'{"actions": [ {"at": 0, "pos": ')
    fs_path = str(bad)
    video_path = str(tmp_path / "Broken.mp4")
    media = _register_without_probes(monkeypatch, [
        {"path": video_path, "name": "Broken.mp4", "funscriptPath": fs_path},
    ])
    vid_id = _path_to_id(video_path)

    media._speed_probe_worker([(vid_id, fs_path)])

    entry = get_video_registry()[vid_id]
    assert entry.get("avgSpeed") is None
    assert entry.get("maxSpeed") is None
    stats = (await client.get("/api/media/speed-stats")).json()
    assert fs_path not in stats


def test_speed_probe_queues_a_video_registered_without_stats(tmp_path, monkeypatch):
    """The renderer's other half of FT-044: a video registered with no
    avgSpeed (the renderer no longer hydrates a cached 0/0) is probed again,
    and one registered with a real value is not."""
    import routes.media as media
    queued = []
    monkeypatch.setattr(media, "_queue_duration_probes", lambda: None)
    monkeypatch.setattr(media, "_speed_probe_inflight", set())

    class _NoThread:
        def __init__(self, target=None, args=(), daemon=None):
            queued.extend(args[0])

        def start(self):
            pass

    import threading
    monkeypatch.setattr(threading, "Thread", _NoThread)
    unknown = _write_script(tmp_path / "A.funscript", [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}], bom=True)
    known = _write_script(tmp_path / "B.funscript", [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}])
    register_videos([
        {"path": str(tmp_path / "A.mp4"), "name": "A.mp4", "funscriptPath": unknown},
        {"path": str(tmp_path / "B.mp4"), "name": "B.mp4", "funscriptPath": known,
         "avgSpeed": 250, "maxSpeed": 250},
    ])

    # Probed for SPEED: only the unknown one. Since the funscript metadata
    # harvest (P1 tags, 2026-11-18) the known one is still read once, as a
    # metadata-only item `(None, path)` that never touches its speed
    # (test_script_meta.py pins that and the one-read-per-file rule).
    assert [p for vid, p in queued if vid is not None] == [unknown]
    assert [p for vid, p in queued if vid is None] == [known]


# --- FT-044 / FT-045: re-registrations keep what the probe already knows ---
# app.js now re-registers the library on every association change (FT-045),
# so a re-registration must neither throw away computed stats, nor queue a
# second pass over scripts a running pass still holds, nor let a running pass
# write one script's speed onto a video that now has another.

class _RecordingThread:
    """threading.Thread stand-in: records what each pass would probe."""
    passes: list = []

    def __init__(self, target=None, args=(), daemon=None):
        _RecordingThread.passes.append(list(args[0]))

    def start(self):
        pass


@pytest.fixture
def no_probe_threads(monkeypatch):
    import threading
    import routes.media as media
    _RecordingThread.passes = []
    monkeypatch.setattr(threading, "Thread", _RecordingThread)
    monkeypatch.setattr(media, "_queue_duration_probes", lambda: None)
    monkeypatch.setattr(media, "_speed_probe_inflight", set())
    return media


def test_reregister_keeps_computed_stats_for_the_same_script(tmp_path, no_probe_threads):
    media = no_probe_threads
    fs_path = _write_script(tmp_path / "A.funscript", [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}])
    video = {"path": str(tmp_path / "A.mp4"), "name": "A.mp4", "funscriptPath": fs_path}
    register_videos([dict(video)])
    media._speed_probe_worker(_RecordingThread.passes[0])   # the pass runs
    vid_id = _path_to_id(video["path"])
    assert get_video_registry()[vid_id]["avgSpeed"] == 250

    # The desktop has not polled it yet, so its payload carries no stats.
    register_videos([dict(video)])

    assert get_video_registry()[vid_id]["avgSpeed"] == 250
    assert get_video_registry()[vid_id]["maxSpeed"] == 250
    # Not queued for its speed again. Every registration does queue a stat of
    # each paired script for the metadata harvest (r3-fixup, r3-verify area
    # 2), a metadata-only item `(None, path)` that reads nothing unchanged.
    assert len(_RecordingThread.passes) == 2
    assert _RecordingThread.passes[1] == [(None, fs_path)], "a known script was queued for its speed again"


def test_reregister_with_another_script_probes_the_new_one(tmp_path, no_probe_threads):
    media = no_probe_threads
    old = _write_script(tmp_path / "Old.funscript", [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}])
    new = _write_script(tmp_path / "New.funscript", [{"at": 0, "pos": 0}, {"at": 1000, "pos": 100}])
    path = str(tmp_path / "A.mp4")
    register_videos([{"path": path, "name": "A.mp4", "funscriptPath": old}])
    media._speed_probe_worker(_RecordingThread.passes[0])

    register_videos([{"path": path, "name": "A.mp4", "funscriptPath": new}])   # an association
    vid_id = _path_to_id(path)
    assert get_video_registry()[vid_id].get("avgSpeed") is None   # not the old script's 250
    assert _RecordingThread.passes[-1] == [(vid_id, new)]
    media._speed_probe_worker(_RecordingThread.passes[-1])
    assert get_video_registry()[vid_id]["avgSpeed"] == 100


def test_a_running_pass_is_not_doubled_and_does_not_write_a_replaced_script(tmp_path, no_probe_threads):
    media = no_probe_threads
    a = _write_script(tmp_path / "A.funscript", [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}])
    b = _write_script(tmp_path / "B.funscript", [{"at": 0, "pos": 0}, {"at": 400, "pos": 100}])
    b2 = _write_script(tmp_path / "B2.funscript", [{"at": 0, "pos": 0}, {"at": 1000, "pos": 100}])
    va = {"path": str(tmp_path / "A.mp4"), "name": "A.mp4", "funscriptPath": a}
    vb = {"path": str(tmp_path / "B.mp4"), "name": "B.mp4", "funscriptPath": b}
    register_videos([dict(va), dict(vb)])
    first = _RecordingThread.passes[0]                      # queued, not run yet

    # B's association changes while the first pass still holds A and B.
    register_videos([dict(va), dict(vb, funscriptPath=b2)])

    vb_id = _path_to_id(vb["path"])
    assert _RecordingThread.passes[1] == [(vb_id, b2)], "A was queued twice"
    media._speed_probe_worker(first)                        # the old pass finishes
    assert get_video_registry()[_path_to_id(va["path"])]["avgSpeed"] == 250
    assert get_video_registry()[vb_id].get("avgSpeed") is None, "B got its OLD script's speed"
    media._speed_probe_worker(_RecordingThread.passes[1])
    assert get_video_registry()[vb_id]["avgSpeed"] == 100


# --- VR / phone thumbnails: failures are logged, partials never served,
#     a file that always fails is not retried on every poll (FT-084, FT-085) ---
#
# `_generate` swallowed every error with a bare `pass` (nothing in main.log),
# copied into the cache name directly (a cut-off copy was a cache hit for
# good), and only deduped a job in flight: a corrupt file spawned ffmpeg
# again on every /thumb poll.

_WHOLE_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"


@pytest.fixture
def thumb_env(tmp_path, monkeypatch):
    """A registered video, the backend's thumb cache in tmp_path, fresh
    module state, and a counting stand-in for the ffmpeg thumbnailer."""
    import routes.media as media
    import services.ffmpeg as ffmpeg_mod

    cache = tmp_path / "thumb-cache"
    cache.mkdir()
    monkeypatch.setattr(media, "_thumb_cache_dir", str(cache))
    monkeypatch.setattr(media, "_thumb_failed", {}, raising=False)
    monkeypatch.setattr(media, "_thumb_no_video", {}, raising=False)
    monkeypatch.setattr(media, "_thumb_generating", set())
    monkeypatch.setattr(media, "_custom_thumbs", {})
    # A failed thumbnail asks ffprobe whether the file has a video stream
    # (N-05): its metadata cache lives under the test's own temp folder.
    ffmpeg_mod._reset_metadata_cache_for_tests()
    monkeypatch.setattr(ffmpeg_mod, "tempfile",
                        type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))}))
    video = tmp_path / "Broken.mp4"
    video.write_bytes(b"not really a video")
    register_videos([{"path": str(video), "name": "Broken.mp4"}])
    vid = _path_to_id(str(video))

    env = {"calls": 0, "fail": True, "video": video, "id": vid,
           "thumb": cache / f"{vid}.jpg", "media": media}
    src = tmp_path / "generated.jpg"

    def fake_generate(path, **kw):
        env["calls"] += 1
        if env["fail"]:
            raise RuntimeError("ffmpeg single-thumbnail failed: moov atom not found\nboom")
        src.write_bytes(_WHOLE_JPEG)
        return {"path": str(src), "duration": 10}

    monkeypatch.setattr(ffmpeg_mod, "generate_single_thumbnail", fake_generate)
    yield env
    # Test-only entries must not be saved over the machine's real cache.
    ffmpeg_mod._reset_metadata_cache_for_tests()


async def _poll_thumb(client, env):
    """One /thumb GET, then wait for any background job it started."""
    import asyncio
    res = await client.get(f"/api/media/thumb/{env['id']}")
    for _ in range(500):
        if not env["media"]._thumb_generating:
            break
        await asyncio.sleep(0.01)
    assert not env["media"]._thumb_generating, "background thumbnail job never finished"
    return res


@pytest.mark.anyio
async def test_background_thumb_failure_is_reported(client, thumb_env, capsys):
    res = await _poll_thumb(client, thumb_env)
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    out = capsys.readouterr().out
    lines = [ln for ln in out.splitlines() if "[Thumb]" in ln]
    assert len(lines) == 1
    # Starts with the level, so python-bridge logs it at warn (FT-042).
    assert lines[0].startswith(f"WARNING: [Thumb] background thumbnail failed for {thumb_env['id']}:")
    assert "boom" in lines[0] and "moov atom not found" in lines[0]


@pytest.mark.anyio
async def test_failing_thumbnail_is_not_retried_every_poll(client, thumb_env, monkeypatch):
    for _ in range(3):
        res = await _poll_thumb(client, thumb_env)
        assert res.headers["content-type"] == "image/png"   # the placeholder
    assert thumb_env["calls"] == 1

    # The video changed (re-downloaded, repaired): try again at once.
    st = os.stat(thumb_env["video"])
    os.utime(thumb_env["video"], ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    await _poll_thumb(client, thumb_env)
    assert thumb_env["calls"] == 2

    # Ten minutes later, unchanged: one more try.
    import routes.media as media
    real = media.time.monotonic
    monkeypatch.setattr(media.time, "monotonic", lambda: real() + 601)
    await _poll_thumb(client, thumb_env)
    assert thumb_env["calls"] == 3


@pytest.mark.anyio
async def test_a_registration_retries_a_failed_thumbnail(client, thumb_env):
    await _poll_thumb(client, thumb_env)
    await _poll_thumb(client, thumb_env)
    assert thumb_env["calls"] == 1
    res = await client.post("/api/media/register", json={
        "videos": [{"path": str(thumb_env["video"]), "name": "Broken.mp4"}],
    })
    assert res.status_code == 200
    thumb_env["fail"] = False
    await _poll_thumb(client, thumb_env)
    assert thumb_env["calls"] == 2
    res = await _poll_thumb(client, thumb_env)
    assert res.headers["content-type"] == "image/jpeg"
    assert res.content == _WHOLE_JPEG


@pytest.mark.anyio
async def test_cut_off_cached_thumbnail_is_not_served(client, thumb_env):
    thumb_env["fail"] = False
    thumb_env["thumb"].write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 8)   # no EOI
    res = await _poll_thumb(client, thumb_env)
    assert res.headers["content-type"] == "image/png", "a cut-off JPEG was served as the thumbnail"
    assert thumb_env["calls"] == 1
    res = await _poll_thumb(client, thumb_env)
    assert res.headers["content-type"] == "image/jpeg"
    assert res.content == _WHOLE_JPEG
    # The copy went through a temp name; none is left behind.
    assert sorted(p.name for p in thumb_env["thumb"].parent.iterdir()) == [thumb_env["thumb"].name]


@pytest.mark.anyio
async def test_good_thumbnails_are_unaffected(client, thumb_env):
    thumb_env["fail"] = False
    first = await _poll_thumb(client, thumb_env)
    assert first.headers["content-type"] == "image/png"
    for _ in range(3):
        res = await _poll_thumb(client, thumb_env)
        assert res.status_code == 200 and res.headers["content-type"] == "image/jpeg"
    assert thumb_env["calls"] == 1


# --- E-04: an unreadable script is a 403, never a 200 with a cut-off body ---
#
# `get_funscript` checked only `os.path.isfile` and handed the path to a
# FileResponse, which promises a 200 and a Content-Length from a stat and
# opens the file after the headers are out. A script that exists but cannot
# be read (a deny ACL, EPERM) then failed mid-response: the phone got a
# truncated body and uvicorn logged ~80 lines of "Too little data for
# declared Content-Length" per request. A real deny ACL on Windows (read DATA
# only, as in the TODO's repro, so the stat still passes), chmod 000 elsewhere.

def _deny_read(path):
    """Make `path` unreadable for this user; returns an undo, or None if the
    platform or privileges make that impossible."""
    import subprocess
    if os.name == "nt":
        user = os.environ.get("USERNAME")
        if not user:
            return None
        subprocess.run(["icacls", str(path), "/deny", f"{user}:(RD)"], check=True, capture_output=True)
        return lambda: subprocess.run(["icacls", str(path), "/remove:d", user], capture_output=True)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return None
    os.chmod(path, 0)
    return lambda: os.chmod(path, 0o644)


@pytest.mark.anyio
async def test_unreadable_script_is_403_not_a_cut_off_200(tmp_path):
    video = tmp_path / "Locked.mp4"
    video.write_bytes(b"\x00" * 64)
    script = tmp_path / "Locked.funscript"
    script.write_text(json.dumps({"actions": [{"at": 0, "pos": 0}, {"at": 900, "pos": 100}]}))
    register_videos([{"path": str(video), "name": "Locked.mp4", "funscriptPath": str(script)}])
    vid = _path_to_id(str(video))

    undo = _deny_read(script)
    if undo is None:
        pytest.skip("cannot make a file unreadable here")
    try:
        try:
            open(script, "rb").close()
            pytest.skip("the deny did not take (elevated shell?)")
        except PermissionError:
            pass
        assert os.path.isfile(script), "the stat must still pass, as in the field"
        # What a phone sees: the response as sent, not a test-client raise.
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
            res = await c.get(f"/api/media/script/{vid}")
        assert res.status_code == 403
        assert "cannot be read" in res.json()["detail"]
        assert int(res.headers["content-length"]) == len(res.content)
    finally:
        undo()


def _make_unreadable(path):
    """Deny reading `path`; returns the undo, or skips the test where the
    platform, privileges or an elevated shell make that impossible."""
    undo = _deny_read(path)
    if undo is None:
        pytest.skip("cannot make a file unreadable here")
    try:
        open(path, "rb").close()
    except PermissionError:
        return undo
    undo()
    pytest.skip("the deny did not take (elevated shell?)")


# Found while E-04 (verify-2, 2026-11-07; also in v0.9.2): the same cut-off
# 200 for a VIDEO. `stream_video` sized the file with a stat, which a deny ACL
# lets through, then promised a Content-Length and failed on the open: the
# phone got a 200 with Content-Length 1891353 and an aborted body, and
# main.log 8 "Too little data for declared Content-Length" lines.
@pytest.mark.anyio
@pytest.mark.parametrize("headers, ok", [(None, 200), ({"Range": "bytes=0-99"}, 206)])
async def test_unreadable_video_is_403_not_a_cut_off_200(tmp_path, headers, ok):
    video = tmp_path / "Locked.mp4"
    video.write_bytes(b"\x00" * 4096)
    register_videos([{"path": str(video), "name": "Locked.mp4"}])
    vid = _path_to_id(str(video))
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        res = await c.get(f"/api/media/stream/{vid}", headers=headers)
        assert res.status_code == ok, "the readable file streams as before"
        undo = _make_unreadable(video)
        try:
            assert os.path.isfile(video), "the stat must still pass, as in the field"
            res = await c.get(f"/api/media/stream/{vid}", headers=headers)
        finally:
            undo()
    assert res.status_code == 403
    assert "cannot be read" in res.json()["detail"]
    assert int(res.headers["content-length"]) == len(res.content)


@pytest.mark.anyio
@pytest.mark.parametrize("name, body, expect_type", [
    ("Locked.vtt", "WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n", "text/vtt"),
    ("Locked.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi\n", "text/vtt"),
])
async def test_unreadable_subtitle_is_403_not_a_cut_off_200(tmp_path, name, body, expect_type):
    video = tmp_path / "Locked.mp4"
    video.write_bytes(b"\x00" * 64)
    sub = tmp_path / name
    sub.write_text(body, encoding="utf-8")
    register_videos([{"path": str(video), "name": "Locked.mp4", "subtitlePath": str(sub)}])
    vid = _path_to_id(str(video))
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        res = await c.get(f"/api/media/subtitle/{vid}")
        assert res.status_code == 200
        assert res.headers["content-type"].startswith(expect_type)
        assert "hi" in res.text
        assert int(res.headers["content-length"]) == len(res.content)
        undo = _make_unreadable(sub)
        try:
            res = await c.get(f"/api/media/subtitle/{vid}")
        finally:
            undo()
    assert res.status_code == 403
    assert "cannot be read" in res.json()["detail"]
    assert int(res.headers["content-length"]) == len(res.content)


@pytest.mark.anyio
async def test_readable_script_is_served_byte_for_byte(client, tmp_path):
    video = tmp_path / "Fine.mp4"
    video.write_bytes(b"\x00" * 64)
    script = tmp_path / "Fine.funscript"
    raw = b'\xef\xbb\xbf{"actions": [{"at": 0, "pos": 10}, {"at": 750, "pos": 90}]}'
    script.write_bytes(raw)
    register_videos([{"path": str(video), "name": "Fine.mp4", "funscriptPath": str(script)}])
    res = await client.get(f"/api/media/script/{_path_to_id(str(video))}")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert res.headers["access-control-allow-origin"] == "*"
    assert res.content == raw
    assert int(res.headers["content-length"]) == len(raw)


@pytest.mark.anyio
async def test_script_path_that_is_a_folder_is_404(client, tmp_path):
    video = tmp_path / "Odd.mp4"
    video.write_bytes(b"\x00" * 64)
    folder = tmp_path / "Odd.funscript"
    folder.mkdir()
    register_videos([{"path": str(video), "name": "Odd.mp4", "funscriptPath": str(folder)}])
    res = await client.get(f"/api/media/script/{_path_to_id(str(video))}")
    assert res.status_code == 404
