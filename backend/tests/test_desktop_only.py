"""The desktop-only gate (FT-009): routes that take a path or a URL answer
only the desktop app, and every route the phone, the headsets and the Handy
use stays open to the LAN.

Before the gate, any LAN host could read any file in one GET
(`/thumbnails/image?path=`) or two requests (`/api/media/register` then
`/api/media/stream/{id}`). The tests read a real file through each route and
assert on the bytes that come back.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport  # noqa: E402
from main import app  # noqa: E402
from routes.desktop_gate import (  # noqa: E402
    is_desktop_caller, is_loopback_host, is_loopback_host_header,
)
from routes.media import register_videos, _path_to_id  # noqa: E402

LAN_HOST = "192.168.1.50"
FUNSCRIPT = json.dumps({"version": "1.0", "actions": [{"at": 0, "pos": 0}, {"at": 500, "pos": 100}]})


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(host, base_url="http://127.0.0.1:5123"):
    """`host` is the client address; `base_url` sets the Host header."""
    transport = ASGITransport(app=app, client=(host, 50000))
    return AsyncClient(transport=transport, base_url=base_url)


@pytest.fixture
def secret(tmp_path):
    p = tmp_path / "config.json"
    p.write_text('{"settings":{"autoblow":{"token":"TESTKEY01"}}}', encoding="utf-8")
    return str(p)


def _desktop_only_requests(secret_path):
    """(method, url, kwargs) for every desktop-only route. The paths name a
    real file or a missing one; neither may matter to a caller that is not
    the desktop."""
    missing = os.path.join(os.path.dirname(secret_path), "missing.mp4")
    return [
        ("POST", "/api/media/register", {"json": {"videos": [{"path": secret_path, "name": "x"}]}}),
        ("POST", "/api/media/remux", {"params": {"video_path": missing}}),
        ("POST", "/api/media/transcode", {"params": {"video_path": missing}}),
        ("GET", "/api/media/transcode/status", {"params": {"job": "x"}}),
        ("POST", "/api/media/transcode/cancel", {"params": {"job": "x"}}),
        ("POST", "/api/media/resolve", {"params": {"url": "http://example.invalid/v"}}),
        ("POST", "/thumbnails/generate", {"params": {"video_path": missing}}),
        ("POST", "/thumbnails/single", {"params": {"video_path": missing}}),
        ("GET", "/thumbnails/image", {"params": {"path": secret_path}}),
        ("POST", "/scripts/convert", {"content": FUNSCRIPT}),
        ("GET", "/metadata/", {"params": {"video_path": missing}}),
    ]


def _ids(secret_path="x"):
    return [f"{m} {u}" for m, u, _ in _desktop_only_requests(secret_path)]


@pytest.fixture(autouse=True)
def _no_network_resolve(monkeypatch):
    # /resolve would run yt-dlp; the desktop case only needs to get past the
    # gate, so answer as yt-dlp would for an unsupported page.
    from services import resolver as resolver_mod
    from services.resolver import ResolveError

    def _boom(_url, _max_height=None):
        raise ResolveError("unsupported", "unsupported page")

    monkeypatch.setattr(resolver_mod, "resolve", _boom)


# --- the arbitrary file read, end to end ---

@pytest.mark.anyio
async def test_lan_host_cannot_read_a_file_through_thumbnails_image(secret):
    async with _client(LAN_HOST) as c:
        res = await c.get("/thumbnails/image", params={"path": secret})
    assert res.status_code == 403
    assert b"TESTKEY01" not in res.content


@pytest.mark.anyio
async def test_web_page_cannot_read_a_file_through_thumbnails_image(secret):
    async with _client("127.0.0.1") as c:
        res = await c.get("/thumbnails/image", params={"path": secret},
                          headers={"Origin": "http://evil.example"})
    assert res.status_code == 403
    assert b"TESTKEY01" not in res.content


@pytest.mark.anyio
async def test_desktop_still_reads_its_thumbnail_image(secret):
    async with _client("127.0.0.1") as c:
        res = await c.get("/thumbnails/image", params={"path": secret})
    assert res.status_code == 200
    assert b"TESTKEY01" in res.content


@pytest.mark.anyio
async def test_lan_host_cannot_publish_a_script_for_download():
    async with _client(LAN_HOST) as c:
        res = await c.post("/scripts/convert", content=FUNSCRIPT)
    assert res.status_code == 403
    assert "csv" not in res.text


# --- every desktop-only route, three callers ---

@pytest.mark.anyio
@pytest.mark.parametrize("index", range(len(_ids())), ids=_ids())
async def test_lan_host_is_refused(secret, index):
    method, url, kwargs = _desktop_only_requests(secret)[index]
    async with _client(LAN_HOST) as c:
        res = await c.request(method, url, **kwargs)
    assert res.status_code == 403
    assert b"TESTKEY01" not in res.content


@pytest.mark.anyio
# "null" is a local HTML file opened in Chrome or Firefox (a downloaded page).
@pytest.mark.parametrize("origin", ["https://evil.example", "http://192.168.1.50:5123",
                                    "http://127.0.0.1:5123", "http://localhost:3000", "null"])
@pytest.mark.parametrize("index", range(len(_ids())), ids=_ids())
async def test_browser_page_on_this_machine_is_refused(secret, index, origin):
    method, url, kwargs = _desktop_only_requests(secret)[index]
    async with _client("127.0.0.1") as c:
        res = await c.request(method, url, headers={"Origin": origin}, **kwargs)
    assert res.status_code == 403
    assert b"TESTKEY01" not in res.content


@pytest.mark.anyio
@pytest.mark.parametrize("origin", [None, "file://"])
@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
@pytest.mark.parametrize("index", range(len(_ids())), ids=_ids())
async def test_desktop_app_gets_through(secret, index, host, origin):
    method, url, kwargs = _desktop_only_requests(secret)[index]
    headers = {"Origin": origin} if origin else {}
    async with _client(host) as c:
        res = await c.request(method, url, headers=headers, **kwargs)
    # Past the gate: the route's own answer (200, 404 for the missing file,
    # 422 for the refused page), never the gate's 403.
    assert res.status_code != 403, res.text
    assert res.status_code in (200, 404, 422)


@pytest.mark.anyio
@pytest.mark.parametrize("index", range(len(_ids())), ids=_ids())
async def test_dns_rebound_page_is_refused(secret, index):
    """A page at evil.example:5123 whose name was re-pointed at 127.0.0.1: it
    arrives from loopback, and a same-origin GET carries no Origin at all.
    Only the Host header still says who it is."""
    method, url, kwargs = _desktop_only_requests(secret)[index]
    async with _client("127.0.0.1", base_url="http://evil.example:5123") as c:
        res = await c.request(method, url, **kwargs)
    assert res.status_code == 403
    assert b"TESTKEY01" not in res.content


@pytest.mark.anyio
@pytest.mark.parametrize("base_url", ["http://127.0.0.1:5123", "http://localhost:5123", "http://[::1]:5123"])
async def test_desktop_reads_through_every_loopback_name(secret, base_url):
    """main.js dials localhost, the renderer 127.0.0.1."""
    async with _client("127.0.0.1", base_url=base_url) as c:
        res = await c.get("/thumbnails/image", params={"path": secret})
    assert res.status_code == 200
    assert b"TESTKEY01" in res.content


# --- the LAN routes stay open ---

@pytest.mark.anyio
async def test_phone_headset_and_handy_routes_answer_a_lan_host(tmp_path):
    video = tmp_path / "Scene_180_sbs.mp4"
    video.write_bytes(b"\x00" * 64)
    script = tmp_path / "Scene_180_sbs.funscript"
    script.write_text(FUNSCRIPT, encoding="utf-8")
    register_videos([{"path": str(video), "name": video.name, "funscriptPath": str(script),
                      "hasFunscript": True, "duration": 10}])
    vid = _path_to_id(str(video))

    # The Handy's CSV is published by the desktop, then fetched from the LAN.
    async with _client("127.0.0.1") as desk:
        csv_hash = (await desk.post("/scripts/convert", content=FUNSCRIPT)).json()["hash"]

    async with _client(LAN_HOST) as c:
        lan_origin = {"Origin": f"http://{LAN_HOST}:5123"}
        assert (await c.get("/health")).status_code == 200
        assert (await c.get("/remote/")).status_code == 200
        listed = await c.get("/api/remote/videos", headers=lan_origin)
        assert listed.status_code == 200
        assert any(v.get("id") == vid for v in listed.json().get("videos", listed.json()))
        assert (await c.post("/api/remote/request-rescan", headers=lan_origin)).status_code == 200
        assert (await c.get(f"/api/media/stream/{vid}", headers={"Range": "bytes=0-7"})).status_code == 206
        assert (await c.get(f"/api/media/script/{vid}")).status_code == 200
        assert (await c.get(f"/api/media/thumb/{vid}")).status_code == 200
        assert (await c.get("/deovr")).status_code == 200
        assert (await c.post("/heresphere", json={})).status_code == 200
        assert (await c.post(f"/heresphere/{vid}", json={})).status_code == 200
        assert (await c.get(f"/scripts/{csv_hash}.csv")).status_code == 200


# --- the rule ---

@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"])
def test_loopback_hosts(host):
    assert is_loopback_host(host)


@pytest.mark.parametrize("host", [None, "", "testclient", "0.0.0.0", "192.168.1.50",
                                  "10.0.0.2", "::ffff:192.168.1.50", "fe80::1"])
def test_non_loopback_hosts(host):
    assert not is_loopback_host(host)


@pytest.mark.parametrize("value", [None, "127.0.0.1:5123", "127.0.0.1", "localhost:5123",
                                   "LOCALHOST", "[::1]:5123", "[::1]"])
def test_loopback_host_headers(value):
    assert is_loopback_host_header(value)


@pytest.mark.parametrize("value", ["", "test", "evil.example:5123", "192.168.1.200:5123",
                                   "localhost.evil.example:5123", "127.0.0.1.evil.example",
                                   "[::ffff:192.168.1.5]:5123"])
def test_non_loopback_host_headers(value):
    assert not is_loopback_host_header(value)


def test_origin_rule():
    assert is_desktop_caller("127.0.0.1", None)
    assert is_desktop_caller("127.0.0.1", "file://")
    assert not is_desktop_caller("127.0.0.1", "null")
    assert not is_desktop_caller("127.0.0.1", "")
    assert not is_desktop_caller("127.0.0.1", "https://evil.example")
    assert not is_desktop_caller("127.0.0.1", "file://evil")
    assert not is_desktop_caller(LAN_HOST, None)
    assert not is_desktop_caller(LAN_HOST, "file://")
