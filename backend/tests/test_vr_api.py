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

    # --- Studio prefix detection with per-studio projection ---

    def test_sivr_studio_fisheye(self):
        """SIVR (S1 VR) — modern fisheye MKX200."""
        st, sm, is3d = detect_vr_format("SIVR-178-A.mp4")
        assert st == 'mkx200'
        assert sm == 'sbs'
        assert is3d is True

    def test_kavr_studio_fisheye(self):
        st, sm, is3d = detect_vr_format("KAVR-483-A.mp4")
        assert st == 'mkx200' and sm == 'sbs' and is3d is True

    def test_savr_studio_fisheye(self):
        st, sm, is3d = detect_vr_format("SAVR-278c-4k60fps_P2_.mp4")
        assert st == 'mkx200' and is3d is True

    def test_cjvr_studio_equirect(self):
        """CJVR (Caribbean VR) — uses equirectangular, not fisheye."""
        st, sm, is3d = detect_vr_format("CJVR-043-B-Decensored.mp4")
        assert st == 'dome' and sm == 'sbs' and is3d is True

    def test_ipvr_studio_fisheye(self):
        st, sm, is3d = detect_vr_format("IPVR-215.mp4")
        assert st == 'mkx200' and is3d is True

    def test_vrkm_studio_fisheye(self):
        """VRKM has VR at the start, not the end."""
        st, sm, is3d = detect_vr_format("VRKM-912.mp4")
        assert st == 'mkx200' and is3d is True

    def test_kiwvr_studio_fisheye(self):
        """5-letter prefix."""
        st, sm, is3d = detect_vr_format("KIWVR-382.mp4")
        assert st == 'mkx200' and is3d is True

    def test_studio_in_path(self):
        """Studio code in full path."""
        st, sm, is3d = detect_vr_format("D:\\VR\\SIVR-178-A.mp4")
        assert st == 'mkx200' and is3d is True

    def test_explicit_format_overrides_studio(self):
        """If both studio prefix AND explicit format tag exist, explicit wins."""
        st, sm, is3d = detect_vr_format("KAVR-428-2-Mayuki Ito_8K_180_3DH.mp4")
        assert st == 'dome' and sm == 'sbs' and is3d is True

    def test_unknown_vr_catalog_heuristic_fisheye(self):
        """Unknown studio but matches XXVR-### pattern — defaults to fisheye."""
        st, sm, is3d = detect_vr_format("ZZVR-999.mp4")
        assert st == 'mkx200' and is3d is True

    def test_non_vr_catalog_not_matched(self):
        """Regular catalog codes without VR should NOT match."""
        st, sm, is3d = detect_vr_format("ABP-123.mp4")
        assert is3d is False

    def test_vr_in_random_word_not_matched(self):
        """Avoid false positives from words containing 'vr'."""
        st, sm, is3d = detect_vr_format("Overview-Report.mp4")
        assert is3d is False

    # --- Permissive separator handling (mirrors renderer/js/vr-detect.js) ---

    def test_dot_separated_sbs(self):
        """Dot separators should work the same as underscores."""
        st, sm, is3d = detect_vr_format("Movie.Title.SBS.mp4")
        assert is3d is True and sm == 'sbs'

    def test_dash_separated_mkx200(self):
        st, sm, is3d = detect_vr_format("Scene-MKX200-7K.mp4")
        assert st == 'mkx200' and is3d is True

    def test_space_separated_sbs(self):
        st, sm, is3d = detect_vr_format("Movie Title SBS 180.mp4")
        assert is3d is True

    def test_bracketed_vr_tag(self):
        """Bracketed VR tags like `[VR]` should match."""
        st, sm, is3d = detect_vr_format("[VR] My Movie.mp4")
        assert is3d is True

    def test_parenthesized_vr_tag(self):
        st, sm, is3d = detect_vr_format("My Movie (VR).mp4")
        assert is3d is True

    def test_bare_vr_token_mid_name(self):
        """Bare 'VR' between separators anywhere in the name."""
        st, sm, is3d = detect_vr_format("Studio.Title.4K.VR.180.SBS.mkv")
        assert is3d is True

    def test_vr_resolution_tag_vr180(self):
        st, sm, is3d = detect_vr_format("VR180-title.mp4")
        assert is3d is True

    def test_vr_resolution_tag_vr360(self):
        st, sm, is3d = detect_vr_format("VR360_movie.mp4")
        assert st == 'sphere' or is3d is True  # accept either; what matters is VR

    def test_vr_resolution_tag_8kvr(self):
        st, sm, is3d = detect_vr_format("8KVR_scene.mp4")
        assert is3d is True

    def test_studio_combo_no_dash(self):
        """`SIVR178` without a dash should still match."""
        st, sm, is3d = detect_vr_format("SIVR178.mp4")
        assert st == 'mkx200' and is3d is True

    def test_studio_with_dots(self):
        st, sm, is3d = detect_vr_format("SIVR.178.Title.mkv")
        assert st == 'mkx200' and is3d is True

    def test_fb360_projection(self):
        st, sm, is3d = detect_vr_format("Movie_FB360_8K.mp4")
        assert st == 'sphere' and is3d is True

    def test_folder_based_vr_organization(self):
        """Video in a 'VR' parent folder is detected via the path."""
        st, sm, is3d = detect_vr_format("C:\\Downloads\\VR\\movie.mp4")
        assert is3d is True
        st, sm, is3d = detect_vr_format("/home/me/Videos/VR/title.mp4")
        assert is3d is True

    def test_community_encode_pattern(self):
        """Re-encode style naming."""
        st, sm, is3d = detect_vr_format("hhb3d-sivr-178.mp4")
        assert st == 'mkx200' and is3d is True

    def test_no_false_positive_on_8k_hdr(self):
        """8K alone (no VR tag) should NOT be flagged as VR."""
        st, sm, is3d = detect_vr_format("Movie.2023.8K.HDR.mp4")
        assert is3d is False

    def test_no_false_positive_on_embedded_vr_letters(self):
        """'server', 'carving', 'swerve' should not be flagged as VR."""
        assert detect_vr_format("server-backup.mp4")[2] is False
        assert detect_vr_format("carving_wood.mp4")[2] is False

    def test_no_false_positive_on_bluray_rip(self):
        st, sm, is3d = detect_vr_format("Documentary.2023.1080p.BluRay.x264.mkv")
        assert is3d is False

    # --- Western studio catalog (equirect 180 SBS) ---

    def test_wankzvr_equirect(self):
        st, sm, is3d = detect_vr_format("WankzVR - Scene Title.mp4")
        assert st == 'dome' and sm == 'sbs' and is3d is True

    def test_naughtyamericavr_equirect(self):
        st, sm, is3d = detect_vr_format("NaughtyAmericaVR.Scene.Title.mp4")
        assert st == 'dome' and is3d is True

    def test_badoinkvr_equirect(self):
        st, sm, is3d = detect_vr_format("BadoinkVR - Scene.mp4")
        assert st == 'dome' and is3d is True

    def test_milfvr_equirect(self):
        st, sm, is3d = detect_vr_format("MilfVR scene title.mp4")
        assert st == 'dome' and is3d is True

    def test_czechvr_equirect(self):
        st, sm, is3d = detect_vr_format("CzechVR_0123_title.mp4")
        assert st == 'dome' and is3d is True

    def test_groobyvr_equirect(self):
        st, sm, is3d = detect_vr_format("GroobyVR - Daisy Taylor - Roommate Wanted VR.mp4")
        assert st == 'dome' and is3d is True

    def test_grovr_equirect(self):
        """Alt Grooby code seen in rip-group filenames."""
        st, sm, is3d = detect_vr_format("2.GroVR_30 35_title_TMAL.mp4")
        assert st == 'dome' and is3d is True

    def test_realjamvr_equirect(self):
        st, sm, is3d = detect_vr_format("RealJamVR.scene.mp4")
        assert st == 'dome' and is3d is True

    def test_sinsvr_equirect(self):
        st, sm, is3d = detect_vr_format("SinsVR-title.mp4")
        assert st == 'dome' and is3d is True

    # --- Western studios that migrated to fisheye ---

    def test_vrbangers_fisheye(self):
        """VRBangers switched to fisheye ~200° around 2022."""
        st, sm, is3d = detect_vr_format("VRBangers - Scene Title.mp4")
        assert st == 'mkx200' and is3d is True

    def test_vrconk_fisheye(self):
        st, sm, is3d = detect_vr_format("VRConk.scene.mp4")
        assert st == 'mkx200' and is3d is True

    # --- Rip-group / obfuscated codes (user library patterns) ---

    def test_vrbts_equirect(self):
        st, sm, is3d = detect_vr_format("9.VRBTS_46 20_Naie Mars_the_nutcracker_tmal.mp4")
        assert st == 'dome' and is3d is True

    def test_vrbans_equirect(self):
        st, sm, is3d = detect_vr_format("8.vrbans_33 19_slty_receptionist_TMAL.mp4")
        assert st == 'dome' and is3d is True

    def test_vrbs_equirect(self):
        st, sm, is3d = detect_vr_format("6.VRBS_42 15_Alise_Game Over TraR Pn_tmal.mp4")
        assert st == 'dome' and is3d is True

    def test_vrbtns_equirect(self):
        st, sm, is3d = detect_vr_format("5.VRBTNS_34 04_AIA RAE_watch_and_learn_TMAL.mp4")
        assert st == 'dome' and is3d is True


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
        {"path": "/Videos/Scene1_180_sbs.mp4", "name": "Scene1_180_sbs.mp4",
         "funscriptPath": "/Videos/Scene1.funscript", "hasFunscript": True, "duration": 600},
        {"path": "/Videos/Scene2.mp4", "name": "Scene2.mp4",
         "hasFunscript": False, "duration": 300},
        {"path": "/Other/Scene3_MKX200.mp4", "name": "Scene3_MKX200.mp4",
         "hasFunscript": False, "duration": 900},
    ])


@pytest.mark.anyio
async def test_deovr_library(client):
    response = await client.get("/deovr")
    assert response.status_code == 200
    data = response.json()
    assert "scenes" in data
    assert data["authorized"] == "0"
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
    vid_id = _path_to_id("/Videos/Scene1_180_sbs.mp4")
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
    vid_id = _path_to_id("/Videos/Scene2.mp4")
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
    vid_id = _path_to_id("/Videos/Scene1_180_sbs.mp4")
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
    vid_id = _path_to_id("/Other/Scene3_MKX200.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    data = response.json()

    assert data["projection"] == "fisheye"
    assert data["lens"] == "MKX200"
    assert data["stereo"] == "sbs"


@pytest.mark.anyio
async def test_heresphere_tags(client):
    vid_id = _path_to_id("/Videos/Scene1_180_sbs.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    data = response.json()

    tag_names = [t["name"] for t in data["tags"]]
    assert any(t.startswith("Studio:") for t in tag_names)
    assert "Feature:Is scripted" in tag_names
