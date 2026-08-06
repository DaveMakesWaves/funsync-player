"""Tests for API routes."""

import json
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport
from main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_health(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_script_not_found(client):
    response = await client.get("/scripts/nonexistent.csv")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_metadata_not_found(client):
    response = await client.get("/metadata/?video_path=/nonexistent/video.mp4")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_convert_funscript_valid(client):
    funscript = json.dumps({
        "version": "1.0",
        "actions": [
            {"at": 0, "pos": 50},
            {"at": 500, "pos": 100},
            {"at": 1000, "pos": 0},
        ],
    })
    response = await client.post("/scripts/convert", content=funscript)
    assert response.status_code == 200
    data = response.json()
    assert data["action_count"] == 3
    assert data["duration_ms"] == 1000
    assert data["csv"] == "0,50\n500,100\n1000,0"
    assert "local_url" in data
    assert data["hash"]  # non-empty hash


@pytest.mark.anyio
async def test_convert_funscript_invalid(client):
    response = await client.post("/scripts/convert", content=b"not json")
    assert response.status_code == 400


@pytest.mark.anyio
async def test_convert_funscript_missing_actions(client):
    response = await client.post("/scripts/convert", content=b'{"version": "1.0"}')
    assert response.status_code == 400


@pytest.mark.anyio
async def test_thumbnails_bad_path(client):
    response = await client.post(
        "/thumbnails/generate?video_path=/nonexistent/video.mp4",
    )
    assert response.status_code == 404


@pytest.mark.anyio
async def test_thumbnail_image_bad_path(client):
    response = await client.get("/thumbnails/image?path=/nonexistent/thumb.jpg")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_metadata_with_real_video(client):
    """Test metadata endpoint with real Test.mp4 (if available)."""
    import os
    project_root = os.path.join(os.path.dirname(__file__), "..", "..")
    test_video = os.path.join(project_root, "Test.mp4")
    if not os.path.exists(test_video):
        pytest.skip("Test.mp4 not found")

    response = await client.get(f"/metadata/?video_path={test_video}")
    assert response.status_code == 200
    data = response.json()
    assert data["duration"] > 200
    assert data["width"] == 1920
    assert data["height"] == 1080


@pytest.mark.anyio
async def test_converted_script_is_servable(client):
    """After converting a funscript, the resulting CSV should be servable."""
    funscript = json.dumps({
        "actions": [{"at": 0, "pos": 50}, {"at": 500, "pos": 100}],
    })
    convert_resp = await client.post("/scripts/convert", content=funscript)
    assert convert_resp.status_code == 200
    script_hash = convert_resp.json()["hash"]

    # Now fetch the CSV via the serve endpoint
    csv_resp = await client.get(f"/scripts/{script_hash}.csv")
    assert csv_resp.status_code == 200
    assert csv_resp.text == "0,50\n500,100"


# --- Remote video resolve route ---

@pytest.mark.anyio
async def test_resolve_remote_returns_proxy_url(client, monkeypatch):
    """A successful resolve returns public metadata + a proxy URL + token."""
    from services import resolver as resolver_mod
    monkeypatch.setattr(resolver_mod, "resolve", lambda _url: {
        "title": "Clip", "duration": 120, "thumbnail": "http://t/x.jpg",
        "site": "Example", "webpageUrl": "http://example.com/v",
        "isLive": False, "streamUrl": "http://cdn/master.m3u8",
        "isHls": True, "headers": {"Referer": "http://example.com/"}, "height": 720,
    })
    resp = await client.post("/api/media/resolve", params={"url": "http://example.com/v"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "Clip"
    assert body["isHls"] is True
    assert body["proxyUrl"].endswith("/master.m3u8")
    assert body["token"]
    # The signed URL + headers are NOT leaked to the client.
    assert "streamUrl" not in body
    assert "headers" not in body


@pytest.mark.anyio
async def test_resolve_remote_progressive_returns_file_proxy(client, monkeypatch):
    from services import resolver as resolver_mod
    monkeypatch.setattr(resolver_mod, "resolve", lambda _url: {
        "title": "Direct", "duration": None, "thumbnail": None, "site": None,
        "webpageUrl": "http://x", "isLive": False, "streamUrl": "http://cdn/f.mp4",
        "isHls": False, "headers": {}, "height": 1080,
    })
    resp = await client.post("/api/media/resolve", params={"url": "http://x"})
    assert resp.status_code == 200
    assert resp.json()["proxyUrl"].endswith("/file")


@pytest.mark.anyio
async def test_resolve_remote_error_returns_422_with_kind(client, monkeypatch):
    from services import resolver as resolver_mod
    from services.resolver import ResolveError
    def boom(_url):
        raise ResolveError("drm", "DRM protected")
    monkeypatch.setattr(resolver_mod, "resolve", boom)
    resp = await client.post("/api/media/resolve", params={"url": "http://x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["kind"] == "drm"


@pytest.mark.anyio
async def test_remote_proxy_unknown_token_404(client):
    resp = await client.get("/api/media/remote/nope/file")
    assert resp.status_code == 404
    resp2 = await client.get("/api/media/remote/nope/master.m3u8")
    assert resp2.status_code == 404


# --- Phone-triggered rescan handshake ---

@pytest.mark.anyio
async def test_request_rescan_bumps_counter_desktop_sees_it(client):
    """The phone's POST /api/remote/request-rescan advances the counter that the
    desktop polls via GET /api/media/rescan-request, so the desktop knows to
    rescan + re-register newly-added files."""
    before = (await client.get("/api/media/rescan-request")).json()["seq"]

    bumped = (await client.post("/api/remote/request-rescan")).json()["seq"]
    assert bumped == before + 1

    # The desktop-facing poll now reports the advanced value.
    after = (await client.get("/api/media/rescan-request")).json()["seq"]
    assert after == bumped

    # Monotonic — a second request advances again.
    again = (await client.post("/api/remote/request-rescan")).json()["seq"]
    assert again == bumped + 1


def test_remote_assets_are_no_cache():
    """Stale-asset guard (2026-08-04): every /remote/ + /locales/ response
    carries Cache-Control: no-cache so a phone can never mix a cached
    index.html/style.css with a freshly-updated app.js after an app
    update — the broken-hybrid-UI bug required a manual reload to clear."""
    from fastapi.testclient import TestClient
    from main import app
    client = TestClient(app)
    res = client.get("/remote/")
    assert res.status_code == 200
    assert res.headers.get("cache-control") == "no-cache"
    res = client.get("/remote/app.js")
    assert res.status_code == 200
    assert res.headers.get("cache-control") == "no-cache"
    # Non-remote routes keep their own caching policies.
    res = client.get("/health")
    assert res.headers.get("cache-control") != "no-cache"
