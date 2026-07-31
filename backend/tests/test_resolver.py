"""Tests for the remote-video resolver (page URL -> stream URL + headers).

All tests monkeypatch `resolver._extract_info` so the suite NEVER hits the
network or needs yt-dlp's extractors — we're testing our format-selection +
error-categorisation logic, not yt-dlp itself.
"""

import pytest

from services import resolver
from services.resolver import resolve, ResolveError


def _patch_info(monkeypatch, info):
    monkeypatch.setattr(resolver, "_extract_info", lambda _url: info)


def _patch_raise(monkeypatch, exc):
    def boom(_url):
        raise exc
    monkeypatch.setattr(resolver, "_extract_info", boom)


class TestFormatSelection:
    def test_prefers_progressive_mp4(self, monkeypatch):
        _patch_info(monkeypatch, {
            "title": "Clip",
            "duration": 1453,
            "thumbnail": "http://t/thumb.jpg",
            "extractor_key": "Example",
            "webpage_url": "http://example.com/v/1",
            "formats": [
                {"url": "http://cdn/360.mp4", "ext": "mp4", "vcodec": "h264", "acodec": "aac", "protocol": "https", "height": 360},
                {"url": "http://cdn/1080.mp4", "ext": "mp4", "vcodec": "h264", "acodec": "aac", "protocol": "https", "height": 1080,
                 "http_headers": {"Referer": "http://example.com/"}},
                {"url": "http://cdn/master.m3u8", "protocol": "m3u8_native", "height": 1080},
            ],
        })
        out = resolve("http://example.com/v/1")
        assert out["streamUrl"] == "http://cdn/1080.mp4"  # best height, progressive wins over HLS
        assert out["isHls"] is False
        assert out["headers"] == {"Referer": "http://example.com/"}
        assert out["title"] == "Clip"
        assert out["duration"] == 1453
        assert out["site"] == "Example"

    def test_falls_back_to_hls_master_manifest(self, monkeypatch):
        _patch_info(monkeypatch, {
            "title": "HLS only",
            "http_headers": {"User-Agent": "UA"},
            "formats": [
                {"protocol": "m3u8_native", "height": 720,
                 "url": "http://cdn/variant-720.m3u8",
                 "manifest_url": "http://cdn/master.m3u8"},
            ],
        })
        out = resolve("http://x")
        assert out["isHls"] is True
        assert out["streamUrl"] == "http://cdn/master.m3u8"  # master preferred over variant
        assert out["headers"] == {"User-Agent": "UA"}  # falls back to info-level headers

    def test_hls_variant_url_when_no_manifest_url(self, monkeypatch):
        _patch_info(monkeypatch, {
            "title": "HLS variant",
            "formats": [
                {"protocol": "m3u8_native", "height": 480, "url": "http://cdn/var-480.m3u8"},
            ],
        })
        out = resolve("http://x")
        assert out["isHls"] is True
        assert out["streamUrl"] == "http://cdn/var-480.m3u8"

    def test_top_level_url_fallback(self, monkeypatch):
        _patch_info(monkeypatch, {"title": "Direct", "url": "http://cdn/file.mp4", "protocol": "https"})
        out = resolve("http://x")
        assert out["streamUrl"] == "http://cdn/file.mp4"
        assert out["isHls"] is False

    def test_top_level_m3u8_marked_hls(self, monkeypatch):
        _patch_info(monkeypatch, {"title": "D", "url": "http://cdn/x.m3u8", "protocol": "m3u8"})
        out = resolve("http://x")
        assert out["isHls"] is True

    def test_no_playable_format_raises_unsupported(self, monkeypatch):
        _patch_info(monkeypatch, {"title": "Nope", "formats": []})
        with pytest.raises(ResolveError) as ei:
            resolve("http://x")
        assert ei.value.kind == "unsupported"

    def test_unwraps_first_playlist_entry(self, monkeypatch):
        _patch_info(monkeypatch, {
            "_type": "playlist",
            "entries": [
                None,
                {"title": "First", "url": "http://cdn/a.mp4", "protocol": "https"},
            ],
        })
        out = resolve("http://x")
        assert out["title"] == "First"


class TestErrorHandling:
    def test_empty_url(self):
        with pytest.raises(ResolveError) as ei:
            resolve("   ")
        assert ei.value.kind == "error"

    def test_live_stream_refused(self, monkeypatch):
        _patch_info(monkeypatch, {"title": "Live", "is_live": True, "url": "http://x/live.m3u8"})
        with pytest.raises(ResolveError) as ei:
            resolve("http://x")
        assert ei.value.kind == "live"

    @pytest.mark.parametrize("msg,kind", [
        ("This video is DRM protected", "drm"),
        ("Please log in to access this content", "login"),
        ("Sign in to confirm your age", "login"),
        ("Video unavailable", "unavailable"),
        ("Unsupported URL: http://foo", "unsupported"),
        ("Unable to extract video data", "unsupported"),
        ("This video is not available in your country", "geo"),
        ("Some totally novel failure", "error"),
    ])
    def test_categorises_yt_dlp_errors(self, monkeypatch, msg, kind):
        _patch_raise(monkeypatch, Exception(msg))
        with pytest.raises(ResolveError) as ei:
            resolve("http://x")
        assert ei.value.kind == kind
