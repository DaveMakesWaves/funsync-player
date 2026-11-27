"""The phone's Flat view (#426, 2026-11-22).

The backend serves the desktop's VR renderer and its three shaders at
/vr-flatten/ (only those four files, never the rest of renderer/js), and
passes each video's saved spherical VR format (`vrFormat`) to the phone.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from main import app, VR_FLATTEN_FILES
from routes.media import register_videos


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        yield c


@pytest.mark.anyio
async def test_the_renderer_and_its_shaders_are_served_as_javascript(client):
    assert VR_FLATTEN_FILES == {
        "vr-projection-renderer.js",
        "shaders/_passthrough.vert.js",
        "shaders/equirect.frag.js",
        "shaders/fisheye.frag.js",
    }
    for name in sorted(VR_FLATTEN_FILES):
        r = await client.get(f"/vr-flatten/{name}")
        assert r.status_code == 200, name
        assert r.headers["content-type"].startswith("text/javascript"), name
        assert len(r.content) > 100, name
    r = await client.get("/vr-flatten/vr-projection-renderer.js")
    assert b"export class VRProjectionRenderer" in r.content


@pytest.mark.anyio
@pytest.mark.parametrize("name", [
    "app.js",                                   # another renderer file
    "vr-detect.js",
    "shaders/../app.js",
    "../../backend/main.py",
    "..%2F..%2Fbackend%2Fmain.py",
    "",
])
async def test_nothing_else_is_served(client, name):
    r = await client.get(f"/vr-flatten/{name}")
    assert r.status_code == 404


@pytest.mark.anyio
async def test_the_phone_gets_each_videos_saved_vr_format(client):
    fmt = {"projection": "fisheye-180", "eye": "right", "fov": 100, "yaw": -24, "pitch": 4, "roll": 0}
    register_videos([
        {"path": "C:\\Videos\\VR_180_LR.mp4", "name": "VR_180_LR.mp4", "duration": 60, "vrFormat": fmt},
        {"path": "C:\\Videos\\Flat.mp4", "name": "Flat.mp4", "duration": 60},
    ])
    videos = {v["name"]: v for v in (await client.get("/api/remote/videos")).json()["videos"]}
    assert videos["VR_180_LR"]["vrFormat"] == fmt          # the phone list names a video without its extension
    assert videos["Flat"]["vrFormat"] is None
