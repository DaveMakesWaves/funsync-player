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
