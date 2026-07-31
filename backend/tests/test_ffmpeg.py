"""Tests for ffmpeg binary finding and video hash utilities."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.ffmpeg import _find_binary, _get_video_hash


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
