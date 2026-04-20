"""Tests for media streaming routes — video serving, funscripts, thumbnails."""

import os
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
    async with AsyncClient(transport=transport, base_url="http://test") as c:
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
