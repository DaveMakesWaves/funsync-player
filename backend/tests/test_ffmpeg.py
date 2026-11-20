"""Tests for ffmpeg binary finding and video hash utilities."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.ffmpeg import _find_binary, _get_video_hash


@pytest.fixture
def _isolated_metadata_cache():
    """Reset the persisted-metadata-cache module state before AND after a
    test. The after-reset is load-bearing: a test that lazily loaded from
    its tmp_path cache leaves `loaded=True` with only-test entries in
    memory — if a later test then probes a real file, the write-behind
    save would snapshot that test-only state over the developer's REAL
    cache file in the machine temp dir."""
    import services.ffmpeg as ffmpeg_mod
    ffmpeg_mod._reset_metadata_cache_for_tests()
    yield
    ffmpeg_mod._reset_metadata_cache_for_tests()


class TestFindBinary:
    def test_finds_ffprobe_in_project_dir(self):
        """ffprobe should be found in the project ffmpeg/ directory."""
        result = _find_binary("ffprobe")
        assert result.endswith("ffprobe.exe") or result.endswith("ffprobe")
        if not os.path.exists(result):
            import pytest
            pytest.skip("ffprobe binary not present (CI/Linux)")

    def test_finds_ffmpeg_in_project_dir(self):
        """ffmpeg should be found in the project ffmpeg/ directory."""
        result = _find_binary("ffmpeg")
        assert result.endswith("ffmpeg.exe") or result.endswith("ffmpeg")
        if not os.path.exists(result):
            import pytest
            pytest.skip("ffmpeg binary not present (CI/Linux)")

    def test_nonexistent_binary_falls_back_to_name(self):
        """Unknown binary name should just return the name (for PATH lookup)."""
        result = _find_binary("nonexistent_binary_xyz")
        assert result == "nonexistent_binary_xyz"

    def test_returns_absolute_path(self):
        """Found binary should be an absolute path."""
        result = _find_binary("ffprobe")
        if result != "ffprobe":  # If not falling back to PATH
            assert os.path.isabs(result)

    def test_linux_dev_probes_ffmpeg_linux_directory(self, monkeypatch, tmp_path):
        """On Linux dev (no frozen bundle), `_find_binary` must check
        `ffmpeg-linux/` since the CI build puts static Linux binaries there.
        The Windows-only `ffmpeg/` directory would miss it."""
        # Pretend we're on Linux
        monkeypatch.setattr(os, "name", "posix")

        # Simulate a project layout where ffmpeg-linux/ has the binary
        fake_root = tmp_path
        (fake_root / "ffmpeg-linux").mkdir()
        fake_bin = fake_root / "ffmpeg-linux" / "ffmpeg"
        fake_bin.write_text("")  # just needs to exist
        fake_bin.chmod(0o755)

        # Point _find_binary's project_root at our fake tree by monkeypatching
        # the module's __file__ to point inside fake_root/backend/services/
        from services import ffmpeg as ffmpeg_mod
        fake_file = fake_root / "backend" / "services" / "ffmpeg.py"
        fake_file.parent.mkdir(parents=True)
        fake_file.touch()
        monkeypatch.setattr(ffmpeg_mod, "__file__", str(fake_file))

        result = ffmpeg_mod._find_binary("ffmpeg")
        assert result == str(fake_bin.resolve())

    def test_windows_does_not_probe_ffmpeg_linux(self, monkeypatch, tmp_path):
        """Symmetric: on Windows, the Linux dir is not probed. Catches the
        reverse mistake (accidentally picking up a stale ffmpeg-linux/
        binary on a Windows dev checkout)."""
        monkeypatch.setattr(os, "name", "nt")

        fake_root = tmp_path
        (fake_root / "ffmpeg-linux").mkdir()
        (fake_root / "ffmpeg-linux" / "ffmpeg").write_text("")  # Linux stub — should be ignored

        from services import ffmpeg as ffmpeg_mod
        fake_file = fake_root / "backend" / "services" / "ffmpeg.py"
        fake_file.parent.mkdir(parents=True)
        fake_file.touch()
        monkeypatch.setattr(ffmpeg_mod, "__file__", str(fake_file))

        result = ffmpeg_mod._find_binary("ffmpeg")
        # No ffmpeg.exe in ffmpeg/ → falls back to PATH lookup (returns "ffmpeg")
        assert result == "ffmpeg"


class TestFindBinaryPackaged:
    """The FROZEN branch — the one that ships, and the one nothing tested.

    Sylvain-Et-Un, 2026-08-24: 104 videos, 103 thumbnail requests, 103 backend
    500s, zero successes. The packaged backend looked for ffmpeg beside its own
    exe, where nothing puts it, without the `.exe` suffix it would need on
    Windows anyway — so it always fell through to PATH and worked only on
    machines with a system-wide ffmpeg. Every test above exercises the dev
    branch, which is why they were all green while this shipped.
    """

    @staticmethod
    def _fake_install(tmp_path, exe_name, ffmpeg_names):
        """Build the layout electron-builder actually produces:

            <root>/ffmpeg/ffmpeg.exe          <- extraFiles
            <root>/resources/backend/<exe>    <- extraResources
        """
        backend_dir = tmp_path / "resources" / "backend"
        backend_dir.mkdir(parents=True)
        exe = backend_dir / exe_name
        exe.write_text("")
        ff_dir = tmp_path / "ffmpeg"
        ff_dir.mkdir()
        for n in ffmpeg_names:
            (ff_dir / n).write_text("")
        return exe, ff_dir

    def test_windows_packaged_finds_ffmpeg_in_the_install_root(self, monkeypatch, tmp_path):
        monkeypatch.setattr(os, "name", "nt")
        exe, ff_dir = self._fake_install(
            tmp_path, "funsync-backend.exe", ["ffmpeg.exe", "ffprobe.exe"])

        from services import ffmpeg as ffmpeg_mod
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe))

        assert ffmpeg_mod._find_binary("ffmpeg") == str((ff_dir / "ffmpeg.exe").resolve())
        assert ffmpeg_mod._find_binary("ffprobe") == str((ff_dir / "ffprobe.exe").resolve())

    def test_linux_packaged_finds_ffmpeg_in_the_install_root(self, monkeypatch, tmp_path):
        """The AppImage uses the same relative layout, suffix aside."""
        monkeypatch.setattr(os, "name", "posix")
        exe, ff_dir = self._fake_install(
            tmp_path, "funsync-backend", ["ffmpeg", "ffprobe"])

        from services import ffmpeg as ffmpeg_mod
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe))

        assert ffmpeg_mod._find_binary("ffmpeg") == str((ff_dir / "ffmpeg").resolve())

    def test_packaged_still_finds_a_binary_sitting_beside_the_exe(self, monkeypatch, tmp_path):
        """Kept so a future build that DOES colocate them keeps working."""
        monkeypatch.setattr(os, "name", "nt")
        backend_dir = tmp_path / "resources" / "backend"
        backend_dir.mkdir(parents=True)
        exe = backend_dir / "funsync-backend.exe"
        exe.write_text("")
        beside = backend_dir / "ffmpeg.exe"
        beside.write_text("")

        from services import ffmpeg as ffmpeg_mod
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe))

        assert ffmpeg_mod._find_binary("ffmpeg") == str(beside.resolve())

    def test_packaged_with_nothing_bundled_falls_back_to_path(self, monkeypatch, tmp_path):
        """The fallback is legitimate — it just must not be the only outcome."""
        monkeypatch.setattr(os, "name", "nt")
        backend_dir = tmp_path / "resources" / "backend"
        backend_dir.mkdir(parents=True)
        exe = backend_dir / "funsync-backend.exe"
        exe.write_text("")

        from services import ffmpeg as ffmpeg_mod
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe))
        # Neutralise the dev-tree probe, which would find the developer's own
        # ffmpeg/ directory and mask the fallback.
        fake_file = tmp_path / "nowhere" / "services" / "ffmpeg.py"
        fake_file.parent.mkdir(parents=True)
        fake_file.touch()
        monkeypatch.setattr(ffmpeg_mod, "__file__", str(fake_file))

        assert ffmpeg_mod._find_binary("ffmpeg") == "ffmpeg"


class TestDescribeBinaries:
    """A total ffmpeg outage and a healthy install used to produce identical
    logs. `describe_binaries` is what makes them different."""

    def test_reports_resolved_paths_and_whether_they_are_real(self):
        from services.ffmpeg import describe_binaries
        info = describe_binaries()
        assert set(info) == {
            "ffmpeg", "ffprobe", "ffmpeg_bundled", "ffprobe_bundled", "frozen"}
        assert isinstance(info["ffmpeg_bundled"], bool)
        assert isinstance(info["ffprobe_bundled"], bool)

    def test_bundled_is_false_when_we_are_only_trusting_PATH(self, monkeypatch):
        import services.ffmpeg as ffmpeg_mod
        monkeypatch.setattr(ffmpeg_mod, "FFMPEG", "ffmpeg")
        monkeypatch.setattr(ffmpeg_mod, "FFPROBE", "ffprobe")
        info = ffmpeg_mod.describe_binaries()
        assert info["ffmpeg_bundled"] is False
        assert info["ffprobe_bundled"] is False


class TestGetVideoHash:
    def test_hash_format(self):
        """Hash should be 12 hex characters."""
        project_root = os.path.join(os.path.dirname(__file__), "..", "..")
        test_video = os.path.join(project_root, "Test.mp4")
        if not os.path.exists(test_video):
            import pytest
            pytest.skip("Test.mp4 not found")

        h = _get_video_hash(test_video)
        assert len(h) == 12
        assert all(c in "0123456789abcdef" for c in h)

    def test_nonexistent_file_raises(self):
        import pytest
        with pytest.raises(FileNotFoundError):
            _get_video_hash("/nonexistent/file.mp4")


# --- Single-thumbnail generation: seek logic + ffmpeg filter ---
#
# Pre-fix the seek formula was `min(duration * seek_pct, 5.0)` for any
# video over 50s — capping the sample at 5 seconds in, which is exactly
# when most studio idents / fade-ins play, producing black thumbnails for
# most long videos. Post-fix: clamp at AT LEAST 10s past the start for
# anything over a minute, and use ffmpeg's `thumbnail` filter to pick
# the most representative frame from a window (skips remaining black /
# fades / monochrome title cards). These tests pin down both behaviours
# so a refactor can't silently regress to the old sample point.

class TestGenerateSingleThumbnail:
    def _patch_ffmpeg(self, monkeypatch, tmp_path, duration=120.0):
        """Stub out get_metadata + run_silent so we can inspect the
        arg list without actually invoking ffmpeg."""
        from services import ffmpeg as ffmpeg_mod
        from unittest.mock import MagicMock

        monkeypatch.setattr(ffmpeg_mod, "get_metadata", lambda _p: {
            "duration": duration,
            "width": 1920,
            "height": 1080,
        })
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )

        captured = {"args": None, "kwargs": None}

        def fake_run(args, **kw):
            captured["args"] = args
            captured["kwargs"] = kw
            # Materialise the output file so the post-call existence check passes.
            out_path = args[args.index("-y") + 1]
            with open(out_path, "wb") as f:
                f.write(b"\xff\xd8\xff")  # JPEG magic, enough to "exist"
            return MagicMock(returncode=0, stderr="")

        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)
        return captured

    def test_long_video_seeks_past_studio_ident_window(self, monkeypatch, tmp_path):
        """30-min video at seek_pct=0.1 must NOT sample at the 5s mark
        (pre-fix bug). The post-fix formula `max(10, duration * 0.1)`
        produces 180s for a 1800s video."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "long.mp4"
        video.write_bytes(b"placeholder")  # non-zero so size guard passes
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=1800.0)

        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        seek_arg = captured["args"][captured["args"].index("-ss") + 1]
        assert float(seek_arg) == 180.0  # 10% of 1800s

    def test_medium_video_clamps_at_10s_minimum(self, monkeypatch, tmp_path):
        """A 90s video at seek_pct=0.1 would naively sample at 9s — still
        inside the typical 10s studio-ident window. Post-fix: clamp to
        10s minimum for anything over 60s."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "medium.mp4"
        video.write_bytes(b"placeholder")  # non-zero so size guard passes
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=90.0)

        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        seek_arg = captured["args"][captured["args"].index("-ss") + 1]
        assert float(seek_arg) == 10.0

    def test_thumbnail_uses_lowered_timeout_for_slow_drives(self, monkeypatch, tmp_path):
        """The single-thumbnail decode runs with the reduced budget so a
        slow/disconnected drive frees its worker slot quickly instead of
        holding the queue for a full minute."""
        from services.ffmpeg import generate_single_thumbnail, THUMBNAIL_TIMEOUT_SEC

        assert THUMBNAIL_TIMEOUT_SEC <= 30  # meaningfully below the old 60s
        video = tmp_path / "clip.mp4"
        video.write_bytes(b"placeholder")
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=120.0)

        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        assert captured["kwargs"]["timeout"] == THUMBNAIL_TIMEOUT_SEC

    def test_short_clip_uses_raw_percentage(self, monkeypatch, tmp_path):
        """For clips under 60s the 10s clamp is skipped — we don't want
        to seek past the action on a 30s clip. Raw `duration * seek_pct`."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "short.mp4"
        video.write_bytes(b"placeholder")  # non-zero so size guard passes
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=30.0)

        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        seek_arg = captured["args"][captured["args"].index("-ss") + 1]
        assert float(seek_arg) == 3.0  # 10% of 30s, no clamp

    def test_vf_chain_is_simple_scale_only(self, monkeypatch, tmp_path):
        """The -vf chain must be `scale=W:-2` and nothing else. An earlier
        revision added `thumbnail=N` for black-frame rejection but had to
        be reverted — the filter forces N full-resolution decodes per
        thumbnail, which on 8K HEVC content (typical for VR libraries)
        timed out the 30s subprocess budget under the renderer's 8-way
        concurrent queue. The seek-time fix in `seek_time` above is the
        actual fix for studio-ident black thumbnails; this test pins the
        revert so a well-meaning refactor can't reintroduce the perf
        regression."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")  # non-zero so size guard passes
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=300.0)

        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        vf_arg = captured["args"][captured["args"].index("-vf") + 1]
        assert vf_arg == "scale=320:-2", (
            f"-vf must be simple scale only (no thumbnail/select filters that "
            f"force multi-frame decode); got {vf_arg!r}. See the comment in "
            f"generate_single_thumbnail explaining why the thumbnail filter "
            f"was reverted."
        )

    def test_uses_skip_frame_nokey(self, monkeypatch, tmp_path):
        """`-skip_frame nokey` is the cross-platform performance win that
        gets HEVC 6K-8K thumbnails generating in ~1s instead of 5-25s.
        It tells the decoder to discard non-keyframe data, so combined
        with `-ss` fast-seek (which lands on/near a keyframe anyway)
        the decoder produces ONE keyframe near the seek target instead
        of decoding through expensive B/P frames. Pure software, works
        without any GPU — that's what makes it portable across all
        users' hardware. MUST come BEFORE -i (decoder option, not a
        per-stream filter)."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=300.0)

        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        args = captured["args"]
        assert "-skip_frame" in args, (
            "Lost the -skip_frame nokey decoder option — see "
            "bench/bench_thumbnails.py and the comment in "
            "generate_single_thumbnail for why it's load-bearing."
        )
        skip_idx = args.index("-skip_frame")
        assert args[skip_idx + 1] == "nokey"
        # And it MUST come before -i (it's a decoder option, not an output filter).
        assert skip_idx < args.index("-i"), (
            "-skip_frame must appear before -i to apply to the input "
            "decoder; placing it after -i would silently make it a no-op."
        )

    def test_exact_mode_skips_keyframe_only_decode(self, monkeypatch, tmp_path):
        """User-picked frames (`exact=True`) must NOT use `-skip_frame
        nokey` — it makes the output the nearest KEYFRAME to the seek
        target, which is visibly a different frame than the one the
        picker's frame-accurate <video> preview showed (community
        report: 'the selected frame isn't the one that shows as the
        thumbnail'). Without it, `-ss` before `-i` decodes forward from
        the prior keyframe to the exact timestamp."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=300.0)

        generate_single_thumbnail(str(video), seek_pct=0.5, width=320, exact=True)
        assert "-skip_frame" not in captured["args"], (
            "exact mode must decode the exact picked frame, not the "
            "nearest keyframe — the WYSIWYG picker bug."
        )

    def test_exact_mode_honors_picks_inside_first_10s(self, monkeypatch, tmp_path):
        """The 10s minimum-seek clamp (studio-ident avoidance) is a
        default-path heuristic. An EXPLICIT user pick in the first 10s
        of a long video must be honored verbatim, not silently moved
        to the 10s mark."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "long.mp4"
        video.write_bytes(b"placeholder")
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=1800.0)

        generate_single_thumbnail(str(video), seek_pct=0.002, width=320, exact=True)
        seek_arg = captured["args"][captured["args"].index("-ss") + 1]
        assert float(seek_arg) == 3.6  # 0.2% of 1800s — NOT clamped to 10

    def test_exact_mode_has_its_own_cache_namespace(self, monkeypatch, tmp_path):
        """A default-path generation is a keyframe grab; it must not
        satisfy a later exact request at the same pct/width from cache
        (the user would keep seeing the old keyframe frame). The cache
        filenames must differ."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=300.0)

        default = generate_single_thumbnail(str(video), seek_pct=0.5, width=320)
        exact = generate_single_thumbnail(str(video), seek_pct=0.5, width=320, exact=True)
        assert default["path"] != exact["path"]
        assert "_v4e_" in os.path.basename(exact["path"])
        # And the exact call actually re-ran ffmpeg (not a cache hit on
        # the default file): its output is the exact-namespace one. ffmpeg
        # writes a `.jpg` temp beside it that is renamed onto it (FT-084;
        # this asserted `-y` named the cache file itself).
        out_arg = captured["args"][captured["args"].index("-y") + 1]
        assert os.path.dirname(out_arg) == os.path.dirname(exact["path"])
        assert os.path.basename(out_arg).startswith(os.path.basename(exact["path"])[:-4] + ".part-")
        assert out_arg.endswith(".jpg")
        assert os.path.exists(exact["path"]) and not os.path.exists(out_arg)

    # --- App test V31 / V32: no keyframe after the seek point ---------------

    _BANNER = (
        "ffmpeg version 8.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\n"
        "  built with gcc 15.2.0 (Rev8, Built by MSYS2 project)\n"
        "  configuration: --enable-gpl --enable-version3 --enable-static " + "--enable-lib" * 120 + "\n"
        "  libavutil      60.  8.100 / 60.  8.100\n"
    )
    _NO_FRAME = (
        "[vost#0:0/mjpeg] Could not open encoder before EOF\n"
        "[out#0/image2] Nothing was written into output file, because at least one "
        "of its streams received no packets.\n"
        "Conversion failed!\n"
    )

    def _patch_failing_keyframe_decode(self, monkeypatch, tmp_path, retry_works=True):
        """run_silent fake: the keyframe-only decode writes nothing (what real
        ffmpeg does when no keyframe sits at/after the seek point); a decode
        without `-skip_frame` writes the frame, unless `retry_works` is off."""
        from services import ffmpeg as ffmpeg_mod
        from unittest.mock import MagicMock

        monkeypatch.setattr(ffmpeg_mod, "get_metadata", lambda _p: {
            "duration": 5.0, "width": 1920, "height": 1080,
        })
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )
        calls = []

        def fake_run(args, **kw):
            calls.append({"args": list(args), "kwargs": kw})
            if "-skip_frame" in args or not retry_works:
                return MagicMock(returncode=234, stderr=self._BANNER + self._NO_FRAME)
            with open(args[args.index("-y") + 1], "wb") as f:
                f.write(b"\xff\xd8\xff")
            return MagicMock(returncode=0, stderr="")

        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)
        return calls

    def test_no_frame_from_keyframe_decode_retries_once_without_skip_frame(self, monkeypatch, tmp_path):
        """V31: a clip whose only keyframe is before the seek point produced
        NO frame under `-skip_frame nokey`, ffmpeg exited non-zero, and the
        thumbnail failed on every request forever. One retry without
        `-skip_frame` (exact mode's argv) gets the frame. The retry must stay
        a single-frame decode at the same seek with the plain scale filter:
        thumbnail/select filters break VR libraries."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "short-one-gop.mp4"
        video.write_bytes(b"placeholder")
        calls = self._patch_failing_keyframe_decode(monkeypatch, tmp_path)

        result = generate_single_thumbnail(str(video), seek_pct=0.1, width=320)

        assert os.path.exists(result["path"])
        assert len(calls) == 2
        first, retry = calls[0]["args"], calls[1]["args"]
        assert "-skip_frame" in first
        assert "-skip_frame" not in retry
        assert retry[retry.index("-ss") + 1] == first[first.index("-ss") + 1] == "0.5"
        assert retry.index("-ss") < retry.index("-i")
        assert retry[retry.index("-frames:v") + 1] == "1"
        assert retry[retry.index("-vf") + 1] == "scale=320:-2"
        # Both runs write the same temp, renamed onto the cache name (FT-084;
        # this asserted `-y` named the cache file itself).
        assert retry[retry.index("-y") + 1] == first[first.index("-y") + 1]
        assert not os.path.exists(retry[retry.index("-y") + 1])
        assert calls[1]["kwargs"]["timeout"] == calls[0]["kwargs"]["timeout"]

    def test_a_working_keyframe_decode_runs_ffmpeg_once(self, monkeypatch, tmp_path):
        """The retry is for the no-frame case only: a normal file must not
        pay for a second decode."""
        from services import ffmpeg as ffmpeg_mod
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=300.0)
        fake = ffmpeg_mod.run_silent
        calls = []

        def counting(args, **kw):
            calls.append(args)
            return fake(args, **kw)

        monkeypatch.setattr(ffmpeg_mod, "run_silent", counting)
        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        assert len(calls) == 1
        assert "-skip_frame" in captured["args"]

    def test_exact_mode_failure_is_not_retried(self, monkeypatch, tmp_path):
        """Exact mode already decodes without `-skip_frame`; a failure there
        is a real failure, reported once."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        calls = self._patch_failing_keyframe_decode(monkeypatch, tmp_path, retry_works=False)
        with pytest.raises(RuntimeError):
            generate_single_thumbnail(str(video), seek_pct=0.5, width=320, exact=True)
        assert len(calls) == 1

    def test_failure_message_carries_the_error_not_the_banner(self, monkeypatch, tmp_path):
        """V32: the raised message (which becomes the HTTP 500 detail and the
        main.log line) used to be the FULL stderr, which opens with the
        version/build banner; main.js kept the first 400 characters, so the
        log showed only the banner. Ask ffmpeg for errors only, and raise
        with the stderr TAIL, where ffmpeg prints the cause."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "broken.mp4"
        video.write_bytes(b"placeholder")
        calls = self._patch_failing_keyframe_decode(monkeypatch, tmp_path, retry_works=False)

        with pytest.raises(RuntimeError) as exc:
            generate_single_thumbnail(str(video), seek_pct=0.1, width=320)

        msg = str(exc.value)
        assert "Nothing was written into output file" in msg
        assert "configuration:" not in msg
        assert len(msg) < 600
        for call in calls:
            args = call["args"]
            assert "-hide_banner" in args
            assert args[args.index("-loglevel") + 1] == "error"
            assert args.index("-loglevel") < args.index("-i")

    def test_real_ffmpeg_single_keyframe_clip_gets_a_thumbnail(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """V31 against the REAL ffmpeg: a 5 s clip encoded with one keyframe
        (-g 1000), thumbnailed at 10% (0.5 s). The keyframe-only decode gives
        no frame; the retry must produce a real JPEG."""
        import shutil
        import subprocess
        from services import ffmpeg as ffmpeg_mod
        from services.ffmpeg import generate_single_thumbnail

        ffmpeg_bin = ffmpeg_mod.FFMPEG
        if not (os.path.isabs(ffmpeg_bin) and os.path.exists(ffmpeg_bin)) and not shutil.which(ffmpeg_bin):
            pytest.skip("ffmpeg not available")

        clip = tmp_path / "one-keyframe.mp4"
        subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "5",
             "-c:v", "libx264", "-g", "1000", "-pix_fmt", "yuv420p", str(clip)],
            check=True, capture_output=True,
        )
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )
        real_run = ffmpeg_mod.run_silent
        codes = []

        def spy(args, **kw):
            r = real_run(args, **kw)
            if "-frames:v" in args:  # the thumbnail runs, not get_metadata's ffprobe
                codes.append(("-skip_frame" in args, r.returncode))
            return r

        monkeypatch.setattr(ffmpeg_mod, "run_silent", spy)

        result = generate_single_thumbnail(str(clip), seek_pct=0.1, width=160)

        with open(result["path"], "rb") as f:
            assert f.read(2) == b"\xff\xd8", "not a JPEG"
        # The reproduction itself: keyframe-only decode failed, retry worked.
        assert codes[0][0] is True and codes[0][1] != 0
        assert codes[-1] == (False, 0)

    # --- FT-084: a cut-off JPEG is never a cache hit ---------------------------
    #
    # ffmpeg wrote straight to the cache name, a run killed by the 25 s
    # timeout left a partial JPEG there (TimeoutExpired was not even caught),
    # and every later request took "the file exists" as a cache hit: the
    # same broken image, for good.

    _WHOLE_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"

    def _patch_writing(self, monkeypatch, tmp_path, write=None, raise_timeout=False):
        """Stub get_metadata + run_silent; the fake ffmpeg writes `write`
        (default: a whole JPEG) to its `-y` target, then optionally times out."""
        import subprocess
        from services import ffmpeg as ffmpeg_mod
        from unittest.mock import MagicMock

        monkeypatch.setattr(ffmpeg_mod, "get_metadata", lambda _p: {
            "duration": 120.0, "width": 1920, "height": 1080,
        })
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )
        calls = []

        def fake_run(args, **kw):
            out = args[args.index("-y") + 1]
            calls.append(out)
            with open(out, "wb") as f:
                f.write(self._WHOLE_JPEG if write is None else write)
            if raise_timeout:
                raise subprocess.TimeoutExpired(args, kw.get("timeout", 25))
            return MagicMock(returncode=0, stderr="")

        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)
        return calls

    def _cache_path_for(self, monkeypatch, tmp_path, video):
        """Where generate_single_thumbnail caches `video` at 10% / 320."""
        from services.ffmpeg import generate_single_thumbnail
        calls = self._patch_writing(monkeypatch, tmp_path)
        path = generate_single_thumbnail(str(video), seek_pct=0.1, width=320)["path"]
        assert len(calls) == 1
        return path

    def test_truncated_cached_thumbnail_is_regenerated(self, monkeypatch, tmp_path):
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        cache = self._cache_path_for(monkeypatch, tmp_path, video)
        with open(cache, "wb") as f:   # what a killed ffmpeg left: SOI, no EOI
            f.write(b"\xff\xd8\xff\xe0" + b"\x00" * 16)

        calls = self._patch_writing(monkeypatch, tmp_path)
        result = generate_single_thumbnail(str(video), seek_pct=0.1, width=320)

        assert len(calls) == 1, "a cut-off JPEG was taken as a cache hit"
        assert result["path"] == cache
        with open(cache, "rb") as f:
            data = f.read()
        assert data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9")

    def test_whole_cached_thumbnail_is_still_a_hit(self, monkeypatch, tmp_path):
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")
        cache = self._cache_path_for(monkeypatch, tmp_path, video)

        calls = self._patch_writing(monkeypatch, tmp_path)
        assert generate_single_thumbnail(str(video), seek_pct=0.1, width=320)["path"] == cache
        assert calls == []

    def test_timeout_leaves_no_cached_partial(self, monkeypatch, tmp_path):
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "slow.mp4"
        video.write_bytes(b"placeholder")
        cache = self._cache_path_for(monkeypatch, tmp_path, video)
        os.remove(cache)

        calls = self._patch_writing(monkeypatch, tmp_path, write=b"\xff\xd8\xff\xe0half", raise_timeout=True)
        with pytest.raises(RuntimeError, match="timed out"):
            generate_single_thumbnail(str(video), seek_pct=0.1, width=320)

        assert not os.path.exists(cache), "the partial JPEG reached the cache name"
        assert all(not os.path.exists(p) for p in calls), "the temp file was left behind"
        # And the next request runs ffmpeg again instead of serving a stub.
        calls = self._patch_writing(monkeypatch, tmp_path)
        generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        assert len(calls) == 1
        assert os.path.exists(cache)

    def test_failed_run_leaves_no_temp_file(self, monkeypatch, tmp_path):
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "broken.mp4"
        video.write_bytes(b"placeholder")
        calls = self._patch_failing_keyframe_decode(monkeypatch, tmp_path, retry_works=False)
        with pytest.raises(RuntimeError):
            generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        outs = {c["args"][c["args"].index("-y") + 1] for c in calls}
        assert all(not os.path.exists(p) for p in outs)

    def test_metadata_cache_survives_backend_restart(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """THE startup fix (2026-08-03): the ffprobe metadata cache used to
        be in-memory only, so every app launch re-probed every visible
        library card (~700ms each — 7s of a 13s startup on a 420-video
        library). It must now persist to disk and serve a warm hit after a
        backend restart WITHOUT invoking ffprobe."""
        import services.ffmpeg as ffmpeg_mod
        from services.ffmpeg import get_metadata

        video, probes = self._patch_probe(monkeypatch, tmp_path)

        first = get_metadata(str(video))
        assert first["duration"] == 120.0
        assert probes["count"] == 1

        # Simulate an app relaunch: flush to disk, drop ALL in-memory state.
        ffmpeg_mod._save_metadata_cache(force=True)
        ffmpeg_mod._reset_metadata_cache_for_tests()

        second = get_metadata(str(video))
        assert second == first
        assert probes["count"] == 1, (
            "get_metadata re-ran ffprobe after a restart — the persisted "
            "cache was not loaded (or not written). This regresses the "
            "~700ms-per-thumbnail startup cost."
        )

    def test_metadata_cache_invalidates_when_file_changes(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """The disk cache is keyed path:size:mtime like the in-memory one —
        an edited file must re-probe, not serve stale metadata."""
        import services.ffmpeg as ffmpeg_mod
        from services.ffmpeg import get_metadata

        video, probes = self._patch_probe(monkeypatch, tmp_path)
        get_metadata(str(video))
        ffmpeg_mod._save_metadata_cache(force=True)
        ffmpeg_mod._reset_metadata_cache_for_tests()

        video.write_bytes(b"different bytes entirely")  # size + mtime change
        get_metadata(str(video))
        assert probes["count"] == 2

    def test_corrupt_or_wrong_version_cache_file_is_discarded(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """A corrupt/foreign cache file must never break probing — start
        empty and re-probe."""
        import services.ffmpeg as ffmpeg_mod
        from services.ffmpeg import get_metadata

        video, probes = self._patch_probe(monkeypatch, tmp_path)
        cache_file = ffmpeg_mod._metadata_cache_path()
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)

        with open(cache_file, "w", encoding="utf-8") as f:
            f.write("{ not json !!!")
        get_metadata(str(video))
        assert probes["count"] == 1

        ffmpeg_mod._reset_metadata_cache_for_tests()
        with open(cache_file, "w", encoding="utf-8") as f:
            f.write('{"version": 999, "entries": {"x": {"duration": 1}}}')
        get_metadata(str(video))
        assert probes["count"] == 2

    def test_first_probe_writes_the_cache_file(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """The write-behind throttle must still flush promptly on the first
        insert (interval measured from 0), so even a single-probe session
        persists something."""
        import services.ffmpeg as ffmpeg_mod
        from services.ffmpeg import get_metadata

        video, _probes = self._patch_probe(monkeypatch, tmp_path)
        get_metadata(str(video))
        cache_file = ffmpeg_mod._metadata_cache_path()
        assert os.path.exists(cache_file)
        with open(cache_file, encoding="utf-8") as f:
            payload = json.load(f)
        assert payload["version"] == ffmpeg_mod.METADATA_CACHE_VERSION
        assert len(payload["entries"]) == 1

    def test_real_ffprobe_failure_says_why(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """verify-2 (2026-11-07; also in v0.9.2): ffprobe ran with -v quiet, so
        a file it cannot read failed with an EMPTY stderr and the FT-084
        warning read 'ffprobe failed:' with nothing after it. Against the
        REAL ffprobe: random bytes named .mp4 must fail with the reason."""
        import shutil
        from services import ffmpeg as ffmpeg_mod
        from services.ffmpeg import get_metadata

        probe_bin = ffmpeg_mod.FFPROBE
        if not (os.path.isabs(probe_bin) and os.path.exists(probe_bin)) and not shutil.which(probe_bin):
            pytest.skip("ffprobe not available")
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )
        corrupt = tmp_path / "Corrupt Bytes.mp4"
        corrupt.write_bytes(os.urandom(4096))

        with pytest.raises(RuntimeError) as err:
            get_metadata(str(corrupt))
        message = str(err.value)
        assert message.startswith("ffprobe failed:")
        reason = message[len("ffprobe failed:"):].strip()
        assert reason, "ffprobe failed with no reason (the -v quiet stderr)"
        assert "Invalid data" in reason or "moov" in reason or "Corrupt Bytes" in reason

    def test_thumbnail_failure_reason_is_one_line(self, monkeypatch, tmp_path, _isolated_metadata_cache):
        """E-11 (2026-11-07): ffprobe's stderr for a cut-off MP4 is two lines
        ("[mov,...] moov atom not found", then "<file>: Invalid data found
        when processing input"). It went into the 500's detail as it was, and
        main.js logs that detail in one warning, so the second line landed in
        main.log with no timestamp or level. Against the REAL ffprobe, through
        the route the desktop library calls: the detail is one line and still
        carries both halves."""
        import shutil
        from fastapi.testclient import TestClient
        from services import ffmpeg as ffmpeg_mod
        from main import app

        probe_bin = ffmpeg_mod.FFPROBE
        if not (os.path.isabs(probe_bin) and os.path.exists(probe_bin)) and not shutil.which(probe_bin):
            pytest.skip("ffprobe not available")
        test_mp4 = os.path.join(os.path.dirname(__file__), "..", "..", "Test.mp4")
        if not os.path.exists(test_mp4):
            pytest.skip("Test.mp4 not found")
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )
        cut = tmp_path / "Corrupt Bytes.mp4"
        with open(test_mp4, "rb") as f:
            cut.write_bytes(f.read(65536))   # the header, no moov atom

        # The desktop's own address: the route is DESKTOP_ONLY (FT-009).
        client = TestClient(app, base_url="http://127.0.0.1:5123", client=("127.0.0.1", 50000))
        res = client.post("/thumbnails/single", params={"video_path": str(cut)})
        assert res.status_code == 500
        detail = res.json()["detail"]
        assert "\n" not in detail and "\r" not in detail, detail
        assert "moov atom not found" in detail
        assert "Invalid data found" in detail

    def test_one_line_keeps_the_end(self):
        from services.ffmpeg import _one_line
        assert _one_line("a\n  b\r\n\tc\n") == "a b c"
        assert _one_line(None) == ""
        assert _one_line("x" * 600 + "\nthe cause", 20) == "x" * 10 + " the cause"

    def _patch_probe(self, monkeypatch, tmp_path):
        """Point the module's tempfile at tmp_path (isolates the cache
        file) and stub run_silent with a counting fake ffprobe."""
        import services.ffmpeg as ffmpeg_mod
        from unittest.mock import MagicMock

        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )
        video = tmp_path / "clip.mp4"
        video.write_bytes(b"placeholder")

        probes = {"count": 0}

        def fake_probe(args, **kw):
            probes["count"] += 1
            return MagicMock(returncode=0, stdout=json.dumps({
                "format": {"duration": "120.0", "format_name": "mp4", "bit_rate": "1000"},
                "streams": [{"codec_type": "video", "width": 1920, "height": 1080,
                             "codec_name": "h264", "r_frame_rate": "30/1"}],
            }))

        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_probe)
        return video, probes

    def test_zero_byte_file_raises_before_invoking_ffmpeg(self, monkeypatch, tmp_path):
        """Aborted/incomplete downloads (0-byte files) used to hang
        ffmpeg for the full subprocess timeout — it can't demux an
        empty MP4 ('moov atom not found') but doesn't always exit fast.
        Now we short-circuit at the start of generate_single_thumbnail
        and never spawn the subprocess. Without this guard, a single
        empty file in a library can occupy a thumbnail-queue slot for
        60s on every startup."""
        from services.ffmpeg import generate_single_thumbnail
        import pytest

        empty = tmp_path / "empty.mp4"
        empty.write_bytes(b"")  # 0 bytes
        ffmpeg_called = {"yes": False}

        def fake_run(*_a, **_kw):
            ffmpeg_called["yes"] = True
            raise AssertionError("ffmpeg should never be called for 0-byte file")

        from services import ffmpeg as ffmpeg_mod
        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)

        with pytest.raises(FileNotFoundError, match="0 bytes"):
            generate_single_thumbnail(str(empty))
        assert ffmpeg_called["yes"] is False

    def test_subprocess_timeout_matches_thumbnail_budget(self, monkeypatch, tmp_path):
        """The single-thumbnail subprocess timeout tracks THUMBNAIL_TIMEOUT_SEC.
        Lowered from 60s so a slow/disconnected drive frees its worker slot
        quickly; still comfortably above the ~15-20s worst case for genuine
        8K HEVC decode under thumbnail-queue contention."""
        from services.ffmpeg import generate_single_thumbnail, THUMBNAIL_TIMEOUT_SEC

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")  # non-zero so size guard passes
        captured_kwargs = {}

        def fake_run(args, **kw):
            captured_kwargs.update(kw)
            from unittest.mock import MagicMock
            out_path = args[args.index("-y") + 1]
            with open(out_path, "wb") as f:
                f.write(b"\xff\xd8\xff")
            return MagicMock(returncode=0, stderr="")

        from services import ffmpeg as ffmpeg_mod
        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)
        monkeypatch.setattr(ffmpeg_mod, "get_metadata", lambda _p: {
            "duration": 300.0, "width": 1920, "height": 1080,
        })
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )

        generate_single_thumbnail(str(video))
        assert captured_kwargs.get("timeout") == THUMBNAIL_TIMEOUT_SEC
        assert THUMBNAIL_TIMEOUT_SEC < 60  # meaningfully lowered for slow drives

    def test_cache_key_uses_v4_prefix(self, monkeypatch, tmp_path):
        """Bumping the cache prefix to `v4` evicts every prior generation:
        v1 black-frame thumbs, v2 timed-out-on-HEVC stubs, and v3 plain
        software-decode versions. After the `-skip_frame nokey` switch
        the decoder produces a different (nearest-keyframe) frame than
        plain software decode, so the visual content can differ —
        regenerating ensures users see the new behaviour immediately."""
        from services.ffmpeg import generate_single_thumbnail

        video = tmp_path / "v.mp4"
        video.write_bytes(b"placeholder")  # non-zero so size guard passes
        captured = self._patch_ffmpeg(monkeypatch, tmp_path, duration=300.0)

        result = generate_single_thumbnail(str(video), seek_pct=0.1, width=320)
        assert "single_v4_" in os.path.basename(result["path"])


# --- Container remux (MKV → MP4) ---
#
# Chromium can't demux .mkv even with H.264/AAC inside; remux_to_mp4
# repackages the streams into MP4 (stream-copy, lossless) so playback
# works. These tests pin the codec-decision logic (copy vs transcode vs
# refuse) and the caching, all without invoking real ffmpeg.

class TestRemuxToMp4:
    def _patch(self, monkeypatch, tmp_path, vcodec="h264", acodec="aac"):
        """Stub get_metadata + _probe_audio_codec + run_silent. Returns the
        captured ffmpeg arg list. run_silent materialises the output so the
        post-call existence/size checks pass."""
        from services import ffmpeg as ffmpeg_mod
        from unittest.mock import MagicMock

        monkeypatch.setattr(ffmpeg_mod, "get_metadata", lambda _p: {"codec": vcodec})
        monkeypatch.setattr(ffmpeg_mod, "_probe_audio_codec", lambda _p: acodec)
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )

        captured = {"args": None, "called": False}

        def fake_run(args, **_kw):
            captured["args"] = args
            captured["called"] = True
            out_path = args[-1]  # output is always the last arg
            with open(out_path, "wb") as f:
                f.write(b"\x00\x00\x00\x20ftyp")  # non-empty MP4-ish
            return MagicMock(returncode=0, stderr="")

        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)
        return captured

    def test_h264_aac_stream_copies_both(self, monkeypatch, tmp_path):
        from services.ffmpeg import remux_to_mp4
        video = tmp_path / "in.mkv"
        video.write_bytes(b"placeholder")
        captured = self._patch(monkeypatch, tmp_path, vcodec="h264", acodec="aac")

        result = remux_to_mp4(str(video))
        args = captured["args"]
        # video + audio both copied
        assert args[args.index("-c:v") + 1] == "copy"
        assert args[args.index("-c:a") + 1] == "copy"
        # faststart for seekable/streamable output, MP4 out
        assert "+faststart" in args
        assert result["path"].endswith(".mp4")
        assert result["cached"] is False

    def test_incompatible_audio_transcodes_to_aac(self, monkeypatch, tmp_path):
        """AC3/DTS/etc. can't sit in MP4 for Chromium → transcode audio to
        AAC, but still stream-copy the (H.264) video."""
        from services.ffmpeg import remux_to_mp4
        video = tmp_path / "in.mkv"
        video.write_bytes(b"placeholder")
        captured = self._patch(monkeypatch, tmp_path, vcodec="h264", acodec="ac3")

        remux_to_mp4(str(video))
        args = captured["args"]
        assert args[args.index("-c:v") + 1] == "copy"
        assert args[args.index("-c:a") + 1] == "aac"

    def test_no_audio_track_omits_audio_codec(self, monkeypatch, tmp_path):
        from services.ffmpeg import remux_to_mp4
        video = tmp_path / "in.mkv"
        video.write_bytes(b"placeholder")
        captured = self._patch(monkeypatch, tmp_path, vcodec="hevc", acodec=None)

        remux_to_mp4(str(video))
        args = captured["args"]
        assert args[args.index("-c:v") + 1] == "copy"
        assert "-c:a" not in args
        # optional audio map keeps audio-less files from failing
        assert "0:a:0?" in args

    def test_unsupported_video_codec_refuses_without_running_ffmpeg(self, monkeypatch, tmp_path):
        """mpeg4 (DivX/Xvid) etc. would copy fine but Chromium still can't
        decode it — so remuxing wouldn't help. Refuse clearly instead of
        producing a still-unplayable file, and never spawn ffmpeg."""
        import pytest
        from services.ffmpeg import remux_to_mp4
        video = tmp_path / "in.avi"
        video.write_bytes(b"placeholder")
        captured = self._patch(monkeypatch, tmp_path, vcodec="mpeg4", acodec="mp3")

        with pytest.raises(RuntimeError, match="remux"):
            remux_to_mp4(str(video))
        assert captured["called"] is False

    def test_cache_hit_skips_ffmpeg(self, monkeypatch, tmp_path):
        from services import ffmpeg as ffmpeg_mod
        from services.ffmpeg import remux_to_mp4, _get_video_hash
        video = tmp_path / "in.mkv"
        video.write_bytes(b"placeholder")
        captured = self._patch(monkeypatch, tmp_path, vcodec="h264", acodec="aac")

        # Pre-create the cached output so the second call is a hit.
        out_dir = os.path.join(str(tmp_path), "funsync_remux")
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{_get_video_hash(str(video))}.mp4")
        with open(out_path, "wb") as f:
            f.write(b"\x00\x00\x00\x20ftyp")

        result = remux_to_mp4(str(video))
        assert result["cached"] is True
        assert captured["called"] is False

    def test_ffmpeg_failure_raises_and_cleans_partial(self, monkeypatch, tmp_path):
        import pytest
        from services import ffmpeg as ffmpeg_mod
        from services.ffmpeg import remux_to_mp4
        from unittest.mock import MagicMock

        video = tmp_path / "in.mkv"
        video.write_bytes(b"placeholder")
        monkeypatch.setattr(ffmpeg_mod, "get_metadata", lambda _p: {"codec": "h264"})
        monkeypatch.setattr(ffmpeg_mod, "_probe_audio_codec", lambda _p: "aac")
        monkeypatch.setattr(
            ffmpeg_mod, "tempfile",
            type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))})
        )

        def fake_run(args, **_kw):
            out_path = args[-1]
            with open(out_path, "wb") as f:  # write a partial file...
                f.write(b"partial")
            return MagicMock(returncode=1, stderr="boom")  # ...then "fail"

        monkeypatch.setattr(ffmpeg_mod, "run_silent", fake_run)

        with pytest.raises(RuntimeError, match="remux failed"):
            remux_to_mp4(str(video))
        # partial output must not linger in the cache
        out_dir = os.path.join(str(tmp_path), "funsync_remux")
        leftovers = os.listdir(out_dir) if os.path.isdir(out_dir) else []
        assert leftovers == []
