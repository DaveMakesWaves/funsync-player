"""Tests for HLS manifest rewriting (remote-video proxy)."""

from urllib.parse import quote

from services.hls_proxy import rewrite_manifest

TOKEN = "tok123"
BASE = "/api/media/remote"


def _seg(abs_url):
    return f"{BASE}/{TOKEN}/seg?u={quote(abs_url, safe='')}"


def _man(abs_url):
    return f"{BASE}/{TOKEN}/manifest?u={quote(abs_url, safe='')}"


class TestRewriteManifest:
    def test_master_variants_go_to_manifest_endpoint(self):
        manifest = (
            "#EXTM3U\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n"
            "v360/index.m3u8\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n"
            "https://cdn.example.com/v720/index.m3u8?sig=abc\n"
        )
        out = rewrite_manifest(manifest, "https://cdn.example.com/master.m3u8", TOKEN)
        # relative variant resolved against the manifest URL, then proxied as a sub-manifest
        assert _man("https://cdn.example.com/v360/index.m3u8") in out
        # absolute signed variant preserved (incl. query) and proxied
        assert _man("https://cdn.example.com/v720/index.m3u8?sig=abc") in out
        # tags preserved untouched
        assert "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360" in out

    def test_media_segments_go_to_seg_endpoint(self):
        manifest = (
            "#EXTM3U\n"
            "#EXT-X-TARGETDURATION:6\n"
            "#EXTINF:6.0,\n"
            "seg0.ts\n"
            "#EXTINF:6.0,\n"
            "https://cdn.example.com/path/seg1.ts?sig=xyz\n"
            "#EXT-X-ENDLIST\n"
        )
        out = rewrite_manifest(manifest, "https://cdn.example.com/path/index.m3u8", TOKEN)
        assert _seg("https://cdn.example.com/path/seg0.ts") in out
        assert _seg("https://cdn.example.com/path/seg1.ts?sig=xyz") in out
        assert "#EXT-X-ENDLIST" in out

    def test_rewrites_key_and_map_uris(self):
        manifest = (
            "#EXTM3U\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x123\n'
            '#EXT-X-MAP:URI="init.mp4"\n'
            "#EXTINF:4.0,\n"
            "seg0.m4s\n"
        )
        out = rewrite_manifest(manifest, "https://cdn.example.com/v/index.m3u8", TOKEN)
        assert f'URI="{_seg("https://cdn.example.com/v/key.bin")}"' in out
        assert f'URI="{_seg("https://cdn.example.com/v/init.mp4")}"' in out
        assert _seg("https://cdn.example.com/v/seg0.m4s") in out
        # method/iv attributes preserved around the rewritten URI
        assert "METHOD=AES-128" in out and "IV=0x123" in out

    def test_audio_rendition_submanifest_uri_goes_to_manifest_endpoint(self):
        manifest = (
            "#EXTM3U\n"
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"\n'
        )
        out = rewrite_manifest(manifest, "https://cdn.example.com/master.m3u8", TOKEN)
        assert f'URI="{_man("https://cdn.example.com/audio/en.m3u8")}"' in out

    def test_preserves_blank_lines_and_plain_tags(self):
        manifest = "#EXTM3U\n\n#EXT-X-VERSION:3\n"
        out = rewrite_manifest(manifest, "https://x/m.m3u8", TOKEN)
        assert out.splitlines() == ["#EXTM3U", "", "#EXT-X-VERSION:3"]

    def test_empty_uri_attr_left_alone(self):
        manifest = '#EXT-X-KEY:METHOD=NONE,URI=""\n'
        out = rewrite_manifest(manifest, "https://x/m.m3u8", TOKEN)
        assert 'URI=""' in out
