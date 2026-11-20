"""VR activity record expiry (app test 2026-11-02, V21).

A headset's scene request (/deovr/{id}, /heresphere/{id}) is recorded so the
renderer can auto-connect its companion bridge back to that IP. The record
used to live for the backend's lifetime, so one request from a device that
had since left kept the renderer re-dialing it forever. These tests drive the
real routes from a LAN client and age the record, rather than mocking time.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport  # noqa: E402
from main import app  # noqa: E402
from routes import media  # noqa: E402
from routes.media import register_videos, _path_to_id, VR_ACTIVITY_TTL_S  # noqa: E402

VIDEO = "/Videos/Scene1_180_sbs.mp4"
QUEST = "192.168.1.77"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def fresh_record():
    register_videos([
        {"path": VIDEO, "name": "Scene1_180_sbs.mp4", "hasFunscript": False, "duration": 600},
    ])
    media._vr_activity.update({"clientIp": None, "videoId": None, "timestamp": 0})
    yield
    media._vr_activity.update({"clientIp": None, "videoId": None, "timestamp": 0})


def _client(ip):
    transport = ASGITransport(app=app, client=(ip, 50123))
    return AsyncClient(transport=transport, base_url="http://test")


async def _activity():
    async with _client("127.0.0.1") as c:
        res = await c.get("/api/media/vr-activity")
        assert res.status_code == 200
        return res.json()


@pytest.mark.anyio
@pytest.mark.parametrize("route", ["deovr", "heresphere"])
async def test_fresh_scene_request_is_reported(route):
    video_id = _path_to_id(VIDEO)
    async with _client(QUEST) as c:
        assert (await c.get(f"/{route}/{video_id}")).status_code == 200
    data = await _activity()
    assert data["clientIp"] == QUEST
    assert data["videoId"] == video_id
    assert data["timestamp"] > 0


@pytest.mark.anyio
async def test_activity_still_reported_just_inside_the_ttl():
    async with _client(QUEST) as c:
        await c.get(f"/heresphere/{_path_to_id(VIDEO)}")
    media._vr_activity["timestamp"] -= VR_ACTIVITY_TTL_S - 5
    assert (await _activity())["clientIp"] == QUEST


@pytest.mark.anyio
async def test_activity_expires_after_the_ttl():
    async with _client(QUEST) as c:
        await c.get(f"/heresphere/{_path_to_id(VIDEO)}")
    media._vr_activity["timestamp"] -= VR_ACTIVITY_TTL_S + 1
    data = await _activity()
    assert data == {"clientIp": None, "videoId": None, "timestamp": 0}


@pytest.mark.anyio
async def test_a_new_request_after_expiry_is_reported_again():
    async with _client(QUEST) as c:
        await c.get(f"/heresphere/{_path_to_id(VIDEO)}")
        media._vr_activity["timestamp"] -= VR_ACTIVITY_TTL_S + 1
        await c.get(f"/heresphere/{_path_to_id(VIDEO)}")
    assert (await _activity())["clientIp"] == QUEST


@pytest.mark.anyio
async def test_loopback_requests_are_still_not_recorded():
    async with _client("127.0.0.1") as c:
        await c.get(f"/heresphere/{_path_to_id(VIDEO)}")
    assert (await _activity())["clientIp"] is None
