"""Tests for VR Content API — DeoVR and HereSphere endpoints."""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport
from main import app
from routes.media import (
    register_videos, _path_to_id, register_categories, register_playlists,
)
from routes.vr_api import detect_vr_format, detect_vr_format_for_video


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


class TestBare180AndMono:
    """V61 (app test 2026-11-02). A bare `180` used to match the 180° SBS
    pattern on its own, so a flat "Episode 180" went to the headset as a
    stereo dome, and `X_180_mono` matched it before the mono pattern could."""

    def test_bare_180_alone_is_flat(self):
        for name in ("Episode 180.mp4", "Top 180 Moments.mp4", "Room_180.mp4", "Bulk 180.mp4"):
            assert detect_vr_format(name) == ('flat', 'off', False), name

    def test_180_mono_is_mono_not_stereo(self):
        assert detect_vr_format("Scene_180_mono.mp4") == ('dome', 'off', False)
        assert detect_vr_format("Scene 180 mono.mp4") == ('dome', 'off', False)
        assert detect_vr_format("Scene_mono180.mp4") == ('dome', 'off', False)

    def test_180_with_a_stereo_tag_is_still_sbs(self):
        for name in ("Scene_180_LR.mp4", "Scene_LR_180.mp4", "Scene_180_3dh.mp4",
                     "Scene_180x180.mp4", "Scene_180_3dh_LR.mp4", "Scene_180_sbs.mp4"):
            assert detect_vr_format(name) == ('dome', 'sbs', True), name

    def test_bare_180_still_names_the_projection_of_a_vr_file(self):
        # VR by another signal: the 180 keeps saying "180° dome", as before.
        assert detect_vr_format("Title VR 180.mp4") == ('dome', 'sbs', True)
        assert detect_vr_format("SIVR-178 180.mp4") == ('dome', 'sbs', True)
        # Without the 180 the same signals keep their own defaults.
        assert detect_vr_format("Title VR.mp4") == ('mkx200', 'sbs', True)
        assert detect_vr_format("SIVR-178.mp4") == ('mkx200', 'sbs', True)

    def test_an_explicit_lens_beats_a_bare_180(self):
        assert detect_vr_format("Scene_180_MKX200.mp4") == ('mkx200', 'sbs', True)

    def test_full_resolution_suffixes_after_180_are_still_stereo(self):
        # HereSphere's full-SBS / full-TB suffixes. Each was a 180° dome on
        # the headset before V61 (via the bare 180), and an 11520x2880 LRF
        # is 4:1, so the dims fallback cannot rescue it.
        for name in ("Scene_180_LRF.mp4", "Scene_180_SBSF.mp4",
                     "Scene_180_fullsbs.mp4", "Scene_180_sbs_full.mp4"):
            assert detect_vr_format(name) == ('dome', 'sbs', True), name
        for name in ("Scene_180_TBF.mp4", "Scene_180_OUF.mp4"):
            assert detect_vr_format(name) == ('dome', 'tb', True), name

    def test_mono_written_before_the_fov_is_mono(self):
        assert detect_vr_format("Scene_mono_180.mp4") == ('dome', 'off', False)
        assert detect_vr_format("Scene_MONO_180.mp4") == ('dome', 'off', False)
        assert detect_vr_format("Scene mono 360.mp4") == ('sphere', 'off', False)

    def test_a_bare_180_marked_vr_by_hand_is_a_dome_not_a_fisheye(self):
        # The desktop always called "Title_180" flat, so this is the file a
        # user marks VR. Before V61 the bare 180 made it a 180° dome; the
        # override's MKX200 default would serve an equirect file as fisheye.
        assert detect_vr_format_for_video(
            {"name": "Title_180.mp4", "manualVRType": "vr"}) == ('dome', 'sbs', True)
        # Without a 180 the override keeps its own default.
        assert detect_vr_format_for_video(
            {"name": "Plain.mp4", "manualVRType": "vr"}) == ('mkx200', 'sbs', True)

    def test_a_bare_180_with_a_vr_shaped_frame_is_a_dome_not_a_fisheye(self):
        assert detect_vr_format_for_video(
            {"name": "Title_180.mp4"}, dims=(5760, 2880)) == ('dome', 'sbs', True)
        assert detect_vr_format_for_video(
            {"name": "Title_180_8K.mp4"}, dims=(8192, 4096)) == ('dome', 'sbs', True)
        assert detect_vr_format_for_video(
            {"name": "Plain.mp4"}, dims=(5760, 2880)) == ('mkx200', 'sbs', True)
        # A 16:9 frame stays flat whatever the name says.
        assert detect_vr_format_for_video(
            {"name": "Episode 180.mp4"}, dims=(1920, 1080)) == ('flat', 'off', False)

    def test_override_and_dims_never_turn_a_mono_file_into_stereo(self):
        # Mono is VR with is3d False. Gating the fallbacks on is3d sent these
        # to the headset as MKX200 side-by-side.
        assert detect_vr_format_for_video(
            {"name": "Scene_180_mono.mp4", "manualVRType": "vr"}) == ('dome', 'off', False)
        assert detect_vr_format_for_video(
            {"name": "Scene_mono360.mp4"}, dims=(5760, 2880)) == ('sphere', 'off', False)


def _parity_cases():
    import json
    table = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures",
                         "vr-filename-parity.json")
    with open(table, encoding="utf-8") as f:
        return json.load(f)["cases"]


def test_vr_filename_parity():
    """The rows tests/unit/vr-detect-parity.test.js runs through both JS
    copies of isVRVideo. VR here = any projection other than flat (what the
    headset is told to render)."""
    cases = _parity_cases()
    assert len(cases) > 10
    wrong = [(c["name"], c["vr"]) for c in cases
             if (detect_vr_format(c["name"])[0] != 'flat') != c["vr"]]
    assert wrong == []


@pytest.mark.anyio
async def test_headset_vr_group_and_filter_match_the_parity_table(client):
    """The headset's "VR Videos" group and ?filter=vr|flat use the table's
    meaning of VR (any projection but flat), so a mono 180 / 360 file is in
    them exactly as it is in the desktop's VR filter. They used `is3d`,
    which is False for mono (V61 review)."""
    cases = _parity_cases()
    register_videos([{"path": f"/Parity/{c['name']}", "name": c["name"], "duration": 60}
                     for c in cases])
    want_vr = {_path_to_id(f"/Parity/{c['name']}") for c in cases if c["vr"]}
    want_flat = {_path_to_id(f"/Parity/{c['name']}") for c in cases if not c["vr"]}
    assert any("mono" in c["name"] and c["vr"] for c in cases)

    def ids(urls):
        return {u.rsplit("/", 1)[-1] for u in urls}

    hs = (await client.get("/heresphere")).json()["library"]
    assert ids(next(s for s in hs if "VR Videos" in s["name"])["list"]) == want_vr
    hs_vr = (await client.get("/heresphere?filter=vr")).json()["library"]
    assert ids(u for s in hs_vr for u in s["list"]) == want_vr
    hs_flat = (await client.get("/heresphere?filter=flat")).json()["library"]
    assert ids(u for s in hs_flat for u in s["list"]) == want_flat

    deo = (await client.get("/deovr")).json()["scenes"]
    vr_group = next(s for s in deo if s["name"] == "VR Videos")
    assert ids(i["video_url"] for i in vr_group["list"]) == want_vr
    deo_vr = (await client.get("/deovr?filter=vr")).json()["scenes"]
    assert ids(i["video_url"] for s in deo_vr for i in s["list"]) == want_vr


class TestVRFormatOverride:
    """`detect_vr_format_for_video` applies the per-video manualVRType
    override before the filename heuristic — same precedence as the
    renderer's `isVRVideo({path,...})`."""

    def test_no_override_falls_through_to_heuristic(self):
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Scene_180_sbs.mp4"}
        )
        assert st == 'dome' and sm == 'sbs' and is3d is True

    def test_override_flat_forces_non_vr(self):
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Scene_180_sbs.mp4", "manualVRType": "flat"}
        )
        assert st == 'flat' and sm == 'off' and is3d is False

    def test_override_vr_forces_vr_on_flat_filename(self):
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Plain.mp4", "manualVRType": "vr"}
        )
        assert is3d is True
        # Default projection when heuristic gives no signal — fisheye SBS
        # so HereSphere has something playable to lean on.
        assert st == 'mkx200' and sm == 'sbs'

    def test_override_vr_keeps_specific_projection_when_heuristic_matches(self):
        # If the filename already screams "180 SBS", we shouldn't downgrade
        # it to the generic mkx200 default just because someone re-confirmed
        # it as VR.
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Scene_180_sbs.mp4", "manualVRType": "vr"}
        )
        assert st == 'dome' and sm == 'sbs' and is3d is True

    def test_unknown_override_value_falls_through(self):
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Plain.mp4", "manualVRType": "maybe"}
        )
        assert is3d is False

    def test_none_video_treated_as_flat(self):
        st, sm, is3d = detect_vr_format_for_video(None)
        assert st == 'flat' and is3d is False


class TestVRDimsFallback:
    """`detect_vr_format_for_video` upgrades an untagged file to VR when its
    dimensions look like a stereoscopic master (~2:1 and high-res).
    Community-reported: VR files with no filename token were served flat and
    HereSphere played them in 2D."""

    def test_untagged_2to1_highres_detected_as_vr(self):
        # 3840x1920 = 2.0 aspect, 4K wide — classic VR180 SBS master.
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Plain.mp4"}, dims=(3840, 1920)
        )
        assert is3d is True and st == 'mkx200' and sm == 'sbs'

    def test_untagged_8k_2to1_detected_as_vr(self):
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Untagged.mp4"}, dims=(7680, 3840)
        )
        assert is3d is True

    def test_normal_16by9_not_misfired(self):
        # 3840x2160 = 1.78 aspect — a 4K flat video must stay flat.
        _, _, is3d = detect_vr_format_for_video(
            {"name": "Movie.mp4"}, dims=(3840, 2160)
        )
        assert is3d is False

    def test_cinemascope_not_misfired(self):
        # 3840x1600 = 2.4 aspect — an ultrawide 2D film stays flat.
        _, _, is3d = detect_vr_format_for_video(
            {"name": "Film.mp4"}, dims=(3840, 1600)
        )
        assert is3d is False

    def test_low_res_2to1_not_misfired(self):
        # 1920x960 = 2.0 aspect but low-res — below the width floor, stays flat.
        _, _, is3d = detect_vr_format_for_video(
            {"name": "Clip.mp4"}, dims=(1920, 960)
        )
        assert is3d is False

    def test_manual_flat_override_beats_dims(self):
        # User explicitly said flat — dimensions must not override that.
        _, _, is3d = detect_vr_format_for_video(
            {"name": "Plain.mp4", "manualVRType": "flat"}, dims=(3840, 1920)
        )
        assert is3d is False

    def test_filename_tag_wins_over_dims(self):
        # A tagged 180 SBS keeps its specific projection even with VR-ish dims.
        st, sm, is3d = detect_vr_format_for_video(
            {"name": "Scene_180_sbs.mp4"}, dims=(3840, 1920)
        )
        assert st == 'dome' and sm == 'sbs' and is3d is True

    def test_no_dims_falls_through_to_flat(self):
        _, _, is3d = detect_vr_format_for_video({"name": "Plain.mp4"})
        assert is3d is False

    def test_zero_dims_safe(self):
        _, _, is3d = detect_vr_format_for_video(
            {"name": "Plain.mp4"}, dims=(0, 0)
        )
        assert is3d is False


@pytest.mark.anyio
async def test_heresphere_scene_respects_manual_override_flat(client):
    """A filename that the heuristic flags as VR but the user has marked
    flat should serve perspective (non-VR) projection metadata."""
    register_videos([
        {"path": "/Videos/Scene1_180_sbs.mp4", "name": "Scene1_180_sbs.mp4",
         "manualVRType": "flat", "duration": 600},
    ])
    vid_id = _path_to_id("/Videos/Scene1_180_sbs.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["projection"] == "perspective"
    assert data["stereo"] == "mono"


@pytest.mark.anyio
async def test_heresphere_scene_respects_manual_override_vr(client):
    """A filename the heuristic misses but the user has marked VR should
    serve a VR projection (fisheye fallback)."""
    register_videos([
        {"path": "/Videos/Plain.mp4", "name": "Plain.mp4",
         "manualVRType": "vr", "duration": 600},
    ])
    vid_id = _path_to_id("/Videos/Plain.mp4")
    response = await client.get(f"/heresphere/{vid_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["projection"] == "fisheye"
    assert data["stereo"] == "sbs"


@pytest.mark.anyio
async def test_heresphere_scene_bare_180_marked_vr_is_an_equirect_dome(client):
    """V61 review: the desktop calls "Title_180" flat, so this is the file a
    user marks VR. The headset must get the 180° dome it got before V61, not
    the override's MKX200 fisheye default (visibly distorted on an equirect
    file)."""
    register_videos([
        {"path": "/Videos/Title_180.mp4", "name": "Title_180.mp4",
         "manualVRType": "vr", "duration": 600},
    ])
    data = (await client.get(f"/heresphere/{_path_to_id('/Videos/Title_180.mp4')}")).json()
    assert data["projection"] == "equirectangular"
    assert data["stereo"] == "sbs"
    assert data["fov"] == 180.0


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


# HereSphere's `list` is a bare array of URLs (spec: "list: (string array with
# urls to video data)"), unlike DeoVR's, whose entries are objects carrying a
# `title`. So DeoVR's `sorted(..., key=title)` had an obvious key and this did
# not — and `sorted()` over the URLs looked equivalent. It was not: every URL
# ends in `_path_to_id(path)`, an md5 hex digest, so the whole library came
# back in HASH order. Stable, arbitrary, and unreadable as anything but
# "sorting is broken" (pallokala2, thread #338). Measured against Dave's live
# library before the fix, the first eight titles served were S, T, S, C, H, B,
# X, A.
@pytest.mark.anyio
async def test_heresphere_library_is_ordered_by_title_not_by_id(client):
    # These three names are chosen deliberately: their md5 order (apple,
    # Mango, banana) DIFFERS from their title order (apple, banana, Mango),
    # so the assertion below can actually tell the two apart. Most name sets
    # cannot — with three items the two orders agree one time in six, and a
    # test that passes on hash luck pins nothing.
    register_videos([
        {"path": "/Videos/banana.mp4", "name": "banana.mp4", "duration": 100},
        {"path": "/Videos/apple.mp4", "name": "apple.mp4", "duration": 100},
        {"path": "/Videos/Mango.mp4", "name": "Mango.mp4", "duration": 100},
    ])
    response = await client.get("/heresphere")
    assert response.status_code == 200

    section = next(s for s in response.json()["library"] if s["name"] == "Videos")
    ids = [url.rsplit("/", 1)[-1] for url in section["list"]]

    titles = []
    for vid_id in ids:
        scene = await client.get(f"/heresphere/{vid_id}")
        titles.append(scene.json()["title"])

    assert titles == ["apple", "banana", "Mango"]
    # The fixtures guarantee this: id order would have given apple, Mango,
    # banana. Reopening the hole (sorting the urls) fails here.
    assert ids != sorted(ids), "served in id order — the exact bug this pins"


@pytest.mark.anyio
async def test_heresphere_title_order_is_case_insensitive(client):
    register_videos([
        {"path": "/Videos/beta.mp4", "name": "beta.mp4", "duration": 100},
        {"path": "/Videos/Alpha.mp4", "name": "Alpha.mp4", "duration": 100},
    ])
    section = next(
        s for s in (await client.get("/heresphere")).json()["library"]
        if s["name"] == "Videos"
    )
    titles = []
    for url in section["list"]:
        scene = await client.get(f"/heresphere/{url.rsplit('/', 1)[-1]}")
        titles.append(scene.json()["title"])
    # Capital A must not sort ahead of everything lowercase, which is what a
    # bare ASCII sort would do.
    assert titles == ["Alpha", "beta"]


@pytest.mark.anyio
async def test_heresphere_derived_sections_are_also_title_ordered(client):
    # The "With Funscript" / "VR Videos" sections are built from the same
    # entries and had the identical bug.
    register_videos([
        {"path": "/Videos/zulu.mp4", "name": "zulu.mp4",
         "funscriptPath": "/Videos/zulu.funscript", "hasFunscript": True, "duration": 100},
        {"path": "/Videos/alfa.mp4", "name": "alfa.mp4",
         "funscriptPath": "/Videos/alfa.funscript", "hasFunscript": True, "duration": 100},
    ])
    section = next(
        s for s in (await client.get("/heresphere")).json()["library"]
        if "Funscript" in s["name"]
    )
    titles = []
    for url in section["list"]:
        scene = await client.get(f"/heresphere/{url.rsplit('/', 1)[-1]}")
        titles.append(scene.json()["title"])
    assert titles == ["alfa", "zulu"]


# --- /heresphere/scan -------------------------------------------------------
#
# HereSphere fills its library UI by GETting every scene url one at a time
# ("These requests occur very rapidly"), and until it has finished it has
# nothing to sort, filter or search on. The spec's answer is /heresphere/scan,
# returning `scanData`. FunSync did not implement it, which is the half of
# pallokala2's "sorting/listing features not working correctly" (#338) that
# the listing-order fix does not address.
#
# What these pin, in order of how easily each would regress:
#   1. the route is reachable at all (it sits in front of /heresphere/{id})
#   2. duration is MILLISECONDS, not the seconds every other caller uses
#   3. fields we cannot answer are ABSENT, not zero
#   4. scan and the scene endpoint never disagree about the same video

@pytest.fixture
def scan_registry():
    register_videos([
        {"path": "/Videos/zulu.mp4", "name": "zulu.mp4", "sourceName": "Videos",
         "funscriptPath": "/Videos/zulu.funscript", "hasFunscript": True, "duration": 120},
        {"path": "/Videos/alfa.mp4", "name": "alfa.mp4", "sourceName": "Videos",
         "hasFunscript": False, "duration": 60},
    ])
    register_categories(
        [{"id": "c1", "name": "Favourites"}],
        {"/Videos/alfa.mp4": ["c1"]},
    )
    register_playlists([{"id": "p1", "name": "Evening", "videoPaths": ["/Videos/zulu.mp4"]}])
    yield
    register_categories([], {})
    register_playlists([])


@pytest.mark.anyio
async def test_scan_is_not_swallowed_by_the_scene_route(client, scan_registry):
    # /heresphere/{video_id} is a catch-all; declared first it answers
    # 404 "Scene not found" for /scan and the endpoint is invisible.
    response = await client.post("/heresphere/scan")
    assert response.status_code == 200
    assert response.headers.get("heresphere-json-version") == "1"
    assert "scanData" in response.json()


@pytest.mark.anyio
async def test_scan_covers_every_video_and_links_to_its_scene(client, scan_registry):
    data = (await client.post("/heresphere/scan")).json()["scanData"]
    assert len(data) == 2
    for item in data:
        assert item["link"].startswith("http")
        vid_id = item["link"].rsplit("/", 1)[-1]
        scene = await client.get(f"/heresphere/{vid_id}")
        assert scene.status_code == 200


@pytest.mark.anyio
async def test_scan_duration_is_milliseconds(client, scan_registry):
    # The registry stores seconds and every other consumer reads seconds.
    # The spec is explicit: "duration: 120000.0 (decimal number with the
    # duration of the video in milliseconds)". A seconds value here sorts
    # correctly and displays as two minutes of nothing.
    data = (await client.post("/heresphere/scan")).json()["scanData"]
    by_title = {i["title"]: i for i in data}
    assert by_title["zulu"]["duration"] == 120000.0
    assert by_title["alfa"]["duration"] == 60000.0


@pytest.mark.anyio
async def test_scan_omits_fields_we_cannot_answer(client, scan_registry):
    # FunSync has no ratings, favourites or comments, and no notion of a
    # studio release date. Sending zeros would sort as real values and a
    # made-up dateReleased gives an order that looks right and is not.
    data = (await client.post("/heresphere/scan")).json()["scanData"]
    for item in data:
        for absent in ("rating", "favorites", "comments", "isFavorite", "dateReleased"):
            assert absent not in item, f"{absent} should be omitted, not invented"


@pytest.mark.anyio
async def test_scan_tags_carry_studio_script_category_and_playlist(client, scan_registry):
    data = (await client.post("/heresphere/scan")).json()["scanData"]
    by_title = {i["title"]: i for i in data}
    zulu = {t["name"] for t in by_title["zulu"]["tags"]}
    alfa = {t["name"] for t in by_title["alfa"]["tags"]}

    assert "Studio:Videos" in zulu
    assert "Feature:Is scripted" in zulu
    assert "Feature:Is scripted" not in alfa      # no funscript
    assert "Playlist:Evening" in zulu
    assert "Category:Favourites" in alfa
    assert "Category:Favourites" not in zulu


@pytest.mark.anyio
async def test_scan_and_scene_agree_on_tags(client, scan_registry):
    # Two code paths reporting different tags for one video is worse than
    # either being wrong — they share `_library_tags` for this reason.
    data = (await client.post("/heresphere/scan")).json()["scanData"]
    item = next(i for i in data if i["title"] == "zulu")
    scene = (await client.get(f"/heresphere/{item['link'].rsplit('/', 1)[-1]}")).json()

    scan_tags = {t["name"] for t in item["tags"]}
    scene_tags = {t["name"] for t in scene["tags"]}
    # The scene adds timestamped chapter markers; every untimed tag must match.
    assert scan_tags <= scene_tags
    assert "Playlist:Evening" in scene_tags


@pytest.mark.anyio
async def test_scan_is_title_ordered(client, scan_registry):
    data = (await client.post("/heresphere/scan")).json()["scanData"]
    assert [i["title"] for i in data] == ["alfa", "zulu"]


@pytest.mark.anyio
async def test_scan_survives_a_video_whose_file_is_missing(client, scan_registry):
    # dateAdded comes from mtime, and none of these fixture paths exist on
    # disk. A stat failure must drop the field, not 500 the whole library.
    response = await client.post("/heresphere/scan")
    assert response.status_code == 200
    for item in response.json()["scanData"]:
        assert "dateAdded" not in item
        assert item["title"]


@pytest.mark.anyio
async def test_scan_reports_an_empty_library_as_empty(client):
    register_videos([])
    data = (await client.post("/heresphere/scan")).json()
    assert data["scanData"] == []


# --- The URLs a headset reports resolve back to the file (V63) ---
#
# Everything this server hands a headset names a video by id only. When
# HereSphere reports one of those URLs as the playing path, the desktop asks
# /api/media/video/{id} which file it is, so its script can be loaded.

@pytest.mark.anyio
async def test_scene_media_and_scene_urls_resolve_back_to_the_file(client):
    import re
    path = "/Videos/Scene1_180_sbs.mp4"
    scene_url = f"http://test/heresphere/{_path_to_id(path)}"
    scene = (await client.get(scene_url)).json()
    stream_url = scene["media"][0]["sources"][0]["url"]

    # The same shape renderer/js/vr-bridge.js `funsyncVideoIdFromVRPath` reads.
    pattern = re.compile(r"/(?:api/media/stream|heresphere|deovr)/([0-9a-f]{12})(?=[/?#]|$)", re.I)
    for reported in (stream_url, scene_url):
        vid_id = pattern.search(reported).group(1)
        res = await client.get(f"/api/media/video/{vid_id}")
        assert res.status_code == 200
        assert res.json() == {"id": vid_id, "name": "Scene1_180_sbs.mp4", "path": path}


@pytest.mark.anyio
async def test_unknown_video_id_is_404(client):
    res = await client.get("/api/media/video/0123456789ab")
    assert res.status_code == 404


# --- The scene and /scan describe a video the same way (V64) ---
#
# The scene used to hard-code dateAdded '', dateReleased '', rating 0 and
# isFavorite False while /scan sent the real dateAdded and omitted the rest,
# so a video's date and rating depended on whether HereSphere had opened it.

@pytest.fixture
def dated_registry(tmp_path):
    import time
    clip = tmp_path / "Dated Clip.mp4"
    clip.write_bytes(b"\x00" * 16)
    noon = time.mktime((2026, 1, 15, 12, 0, 0, 0, 0, -1))   # local noon: no TZ edge
    os.utime(clip, (noon, noon))
    register_videos([{"path": str(clip), "name": "Dated Clip.mp4", "duration": 90}])
    yield str(clip)


@pytest.mark.anyio
async def test_scene_and_scan_agree_on_date_title_and_duration(client, dated_registry):
    scan = (await client.post("/heresphere/scan")).json()["scanData"]
    assert len(scan) == 1
    item = scan[0]
    scene = (await client.get(f"/heresphere/{_path_to_id(dated_registry)}")).json()

    assert item["dateAdded"] == "2026-01-15"
    assert scene["dateAdded"] == item["dateAdded"]
    assert scene["title"] == item["title"] == "Dated Clip"
    assert scene["duration"] == item["duration"] == 90000.0


@pytest.mark.anyio
async def test_scene_omits_fields_we_cannot_answer(client, dated_registry):
    scene = (await client.get(f"/heresphere/{_path_to_id(dated_registry)}")).json()
    for absent in ("rating", "favorites", "comments", "isFavorite", "dateReleased"):
        assert absent not in scene, f"{absent} should be omitted, not invented"


@pytest.mark.anyio
async def test_scene_for_a_missing_file_omits_date_added(client):
    # The autouse registry's paths do not exist: no mtime, so no dateAdded,
    # and certainly not an empty string.
    scene = (await client.get(f"/heresphere/{_path_to_id('/Videos/Scene2.mp4')}")).json()
    assert "dateAdded" not in scene
    assert scene["title"] == "Scene2"
