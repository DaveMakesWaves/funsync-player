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
