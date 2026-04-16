"""Tests for metadata extraction service and route."""

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.ffmpeg import _parse_fps


class TestParseFps:
    def test_simple_fraction(self):
        assert _parse_fps("30/1") == 30.0

    def test_ntsc_fraction(self):
        assert _parse_fps("30000/1001") == 29.97

    def test_24_fps(self):
        assert _parse_fps("24/1") == 24.0

    def test_zero_denominator(self):
        assert _parse_fps("30/0") == 0

    def test_invalid_string(self):
        assert _parse_fps("invalid") == 0

    def test_60_fps(self):
        assert _parse_fps("60/1") == 60.0


class TestGetMetadata:
    def test_nonexistent_file_raises(self):
        from services.ffmpeg import get_metadata
        with pytest.raises(FileNotFoundError):
            get_metadata("/nonexistent/video.mp4")

    def test_real_video_happy_path(self):
        """Test metadata extraction with the real Test.mp4 file."""
        from services.ffmpeg import get_metadata
        project_root = os.path.join(os.path.dirname(__file__), "..", "..")
        test_video = os.path.join(project_root, "Test.mp4")
        if not os.path.exists(test_video):
            pytest.skip("Test.mp4 not found")

        result = get_metadata(test_video)
        assert result["duration"] > 200  # ~220s
        assert result["width"] == 1920
        assert result["height"] == 1080
        assert result["fps"] > 20
        assert result["codec"] in ("h264", "hevc", "av1")
        assert result["bitrate"] > 0

    def test_real_video_has_format(self):
        """Test that format name is returned."""
        from services.ffmpeg import get_metadata
        project_root = os.path.join(os.path.dirname(__file__), "..", "..")
        test_video = os.path.join(project_root, "Test.mp4")
        if not os.path.exists(test_video):
            pytest.skip("Test.mp4 not found")

        result = get_metadata(test_video)
        assert result["format"]  # non-empty format string


class TestGetVideoHash:
    def test_produces_12_char_hex(self):
        from services.ffmpeg import _get_video_hash
        project_root = os.path.join(os.path.dirname(__file__), "..", "..")
        test_video = os.path.join(project_root, "Test.mp4")
        if not os.path.exists(test_video):
            pytest.skip("Test.mp4 not found")

        hash_val = _get_video_hash(test_video)
        assert len(hash_val) == 12
        assert all(c in "0123456789abcdef" for c in hash_val)

    def test_deterministic(self):
        from services.ffmpeg import _get_video_hash
        project_root = os.path.join(os.path.dirname(__file__), "..", "..")
        test_video = os.path.join(project_root, "Test.mp4")
        if not os.path.exists(test_video):
            pytest.skip("Test.mp4 not found")

        hash1 = _get_video_hash(test_video)
        hash2 = _get_video_hash(test_video)
        assert hash1 == hash2
