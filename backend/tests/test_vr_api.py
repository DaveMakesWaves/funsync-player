"""Tests for VR Content API — DeoVR and HereSphere endpoints."""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport
from main import app
from routes.media import register_videos, _path_to_id
from routes.vr_api import detect_vr_format


# --- VR Format Detection ---

class TestVRFormatDetection:
    def test_180_sbs(self):
        st, sm, is3d = detect_vr_format("Scene_180_sbs.mp4")
        assert st == 'dome'
        assert sm == 'sbs'
        assert is3d is True

    def test_180x180_3dh_lr(self):
        st, sm, _ = detect_vr_format("Video_180x180_3dh_LR.mp4")
        assert st == 'dome'
        assert sm == 'sbs'

    def test_360_sbs(self):
        st, sm, _ = detect_vr_format("Scene_360x180_3dh.mp4")
        assert st == 'sphere'
        assert sm == 'sbs'

    def test_180_tb(self):
        st, sm, _ = detect_vr_format("Scene_180_3dv.mp4")
        assert st == 'dome'
        assert sm == 'tb'

    def test_mono360(self):
        st, sm, is3d = detect_vr_format("Scene_mono360.mp4")
        assert st == 'sphere'
        assert sm == 'off'
        assert is3d is False

    def test_mkx200(self):
        st, sm, _ = detect_vr_format("Scene_MKX200.mp4")
        assert st == 'mkx200'
        assert sm == 'sbs'

    def test_mkx220(self):
        st, sm, _ = detect_vr_format("Scene_MKX220.mp4")
        assert st == 'mkx220'

    def test_rf52(self):
        st, sm, _ = detect_vr_format("Scene_RF52.mp4")
        assert st == 'rf52'

    def test_fisheye190(self):
        st, sm, _ = detect_vr_format("Scene_FISHEYE190.mp4")
        assert st == 'fisheye'

    def test_flat_video(self):
        st, sm, is3d = detect_vr_format("Regular Video.mp4")
        assert st == 'flat'
        assert sm == 'off'
        assert is3d is False

    def test_generic_sbs(self):
        st, sm, _ = detect_vr_format("Scene_sbs.mp4")
        assert st == 'dome'
        assert sm == 'sbs'

    def test_case_insensitive(self):
        st, sm, _ = detect_vr_format("scene_180_SBS.mp4")
        assert st == 'dome'
        assert sm == 'sbs'

    def test_empty_filename(self):
        st, sm, is3d = detect_vr_format("")
        assert st == 'flat'

    def test_none_filename(self):
        st, sm, is3d = detect_vr_format(None)
        assert st == 'flat'


# --- DeoVR API ---

@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def setup_registry():
    register_videos([
        {"path": "C:\\Videos\\Scene1_180_sbs.mp4", "name": "Scene1_180_sbs.mp4",
         "funscriptPath": "C:\\Videos\\Scene1.funscript", "hasFunscript": True, "duration": 600},
        {"path": "C:\\Videos\\Scene2.mp4", "name": "Scene2.mp4",
         "hasFunscript": False, "duration": 300},
        {"path": "D:\\Other\\Scene3_MKX200.mp4", "name": "Scene3_MKX200.mp4",
         "hasFunscript": False, "duration": 900},
    ])


@pytest.mark.anyio
async def test_deovr_library(client):
    response = await client.get("/deovr")
    assert response.status_code == 200
    data = response.json()
    assert "scenes" in data
    assert data["authorized"] == "1"
    assert len(data["scenes"]) >= 1

    # Check scenes have required fields
    for group in data["scenes"]:
        assert "name" in group
        assert "list" in group
        for item in group["list"]:
            assert "title" in item
            assert "video_url" in item
            assert "thumbnailUrl" in item


@pytest.mark.anyio
async def test_deovr_scene(client):
    vid_id = _path_to_id("C:\\Videos\\Scene1_180_sbs.mp4")
    response = await client.get(f"/deovr/{vid_id}")
    assert response.status_code == 200
    data = response.json()

    assert data["title"] == "Scene1_180_sbs"
    assert data["is3d"] is True
    assert data["screenType"] == "dome"
    assert data["stereoMode"] == "sbs"
    assert data["authorized"] == 1
    assert data["fullVideoReady"] is True
    assert data["isScripted"] is True

    # Encodings
    assert len(data["encodings"]) == 1
    assert "url" in data["encodings"][0]["videoSources"][0]

    # Funscript
    assert len(data["fleshlight"]) == 1
    assert "url" in data["fleshlight"][0]


@pytest.mark.anyio
async def test_deovr_scene_not_found(client):
    response = await client.get("/deovr/nonexistent")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_deovr_flat_video(client):
    vid_id = _path_to_id("C:\\Videos\\Scene2.mp4")
    response = await client.get(f"/deovr/{vid_id}")
    data = response.json()

    assert data["is3d"] is False
    assert data["screenType"] == "flat"
    assert data["isScripted"] is False
    assert len(data["fleshlight"]) == 0


@pytest.mark.anyio
async def test_deovr_groups_by_directory(client):
    response = await client.get("/deovr")
    data = response.json()
    group_names = [g["name"] for g in data["scenes"]]
    assert "Videos" in group_names
    assert "Other" in group_names


# --- HereSphere API ---

@pytest.mark.anyio
async def test_heresphere_library(client):
    response = await client.get("/heresphere")
    assert response.status_code == 200
    assert response.headers.get("heresphere-json-version") == "1"
    data = response.json()
    assert data["access"] == 1
    assert "library" in data

    for group in data["library"]:
        assert "name" in group
        assert "list" in group
        # HereSphere list contains URLs (strings)
        for item in group["list"]:
            assert isinstance(item, str)
            assert "/heresphere/" in item


@pytest.mark.anyio
async def test_heresphere_scene(client):
    vid_id = _path_to_id("C:\\Videos\\Scene1_180_sbs.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    assert response.status_code == 200
    assert response.headers.get("heresphere-json-version") == "1"
    data = response.json()

    assert data["title"] == "Scene1_180_sbs"
    assert data["projection"] == "equirectangular"
    assert data["stereo"] == "sbs"
    assert data["fov"] == 180.0
    assert data["duration"] == 600000  # milliseconds

    # Scripts
    assert len(data["scripts"]) == 1
    assert "url" in data["scripts"][0]

    # Media
    assert len(data["media"]) == 1
    assert "url" in data["media"][0]["sources"][0]


@pytest.mark.anyio
async def test_heresphere_scene_not_found(client):
    response = await client.get("/heresphere/nonexistent")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_heresphere_fisheye(client):
    vid_id = _path_to_id("D:\\Other\\Scene3_MKX200.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    data = response.json()

    assert data["projection"] == "fisheye"
    assert data["lens"] == "MKX200"
    assert data["stereo"] == "sbs"


@pytest.mark.anyio
async def test_heresphere_tags(client):
    vid_id = _path_to_id("C:\\Videos\\Scene1_180_sbs.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    data = response.json()

    tag_names = [t["name"] for t in data["tags"]]
    assert any(t.startswith("Studio:") for t in tag_names)
    assert "Feature:Is scripted" in tag_names
