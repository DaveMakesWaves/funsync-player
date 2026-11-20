"""N-05 (Dave 2026-11-08; also in v0.9.2): an audio file's tile is black on
the phone and in the DeoVR / HereSphere lists.

`/api/media/thumb/<id>` (what the phone's tiles, DeoVR's `thumbnailUrl` and
HereSphere's `thumbnailImage` all point at) answered a 1x1 transparent PNG
while it generated the frame in the background. A file with no video stream
never gets a frame, so that 1x1 answer was forever, and the tile showed its
black background. Now, once a generation has failed and ffprobe finds audio
and no video stream, the route answers the app logo in grey
(`web-remote/icons/no-video-thumb.png`, 320x180). A file ffprobe cannot read
(a broken video) is not taken for one, a real video is unaffected, and a
poster the user uploaded still wins.

REAL route, REAL ffmpeg / ffprobe on files this test makes; the caches are
the test's own (`services.ffmpeg` writes under tempfile.gettempdir()).
"""

import asyncio
import os
import shutil
import struct
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport  # noqa: E402
from main import app  # noqa: E402
import routes.media as media  # noqa: E402
from services import ffmpeg as ffmpeg_mod  # noqa: E402


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def env(monkeypatch, tmp_path):
    ffmpeg_bin = ffmpeg_mod.FFMPEG
    if not (os.path.isabs(ffmpeg_bin) and os.path.exists(ffmpeg_bin)) and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not available")
    ffmpeg_mod._reset_metadata_cache_for_tests()
    monkeypatch.setattr(
        ffmpeg_mod, "tempfile",
        type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))}),
    )
    cache = tmp_path / "thumb-cache"
    cache.mkdir()
    monkeypatch.setattr(media, "_thumb_cache_dir", str(cache))
    monkeypatch.setattr(media, "_thumb_failed", {})
    monkeypatch.setattr(media, "_thumb_no_video", {})
    monkeypatch.setattr(media, "_thumb_generating", set())
    monkeypatch.setattr(media, "_custom_thumbs", {})
    yield tmp_path, ffmpeg_bin
    ffmpeg_mod._reset_metadata_cache_for_tests()


def _make(ffmpeg_bin, path, *args):
    subprocess.run([ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y", *args, str(path)],
                   check=True, capture_output=True)


def _register(path, duration):
    # A duration is given so no background ffprobe pass outlives the test.
    media.register_videos([{"path": str(path), "name": path.name, "duration": duration}])
    return media._path_to_id(str(path))


async def _poll(client, vid):
    """One GET, then wait for the background job it may have started."""
    res = await client.get(f"/api/media/thumb/{vid}")
    for _ in range(1000):
        if not media._thumb_generating:
            break
        await asyncio.sleep(0.01)
    assert not media._thumb_generating, "background thumbnail job never finished"
    return res


def _png_size(body):
    assert body[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", body[16:24])


def _client():
    transport = ASGITransport(app=app, client=("192.168.1.50", 50000))  # the phone, on the LAN
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:5123")


@pytest.mark.anyio
@pytest.mark.parametrize("name,args", [
    ("Audio Only.m4a", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac"]),
    ("Audio Track.mp3", ["-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "libmp3lame"]),
])
async def test_an_audio_file_gets_the_grey_logo_not_a_black_tile(env, name, args):
    tmp_path, ffmpeg_bin = env
    audio = tmp_path / name
    _make(ffmpeg_bin, audio, *args)
    vid = _register(audio, 3)

    async with _client() as c:
        first = await _poll(c, vid)
        # The first answer is still the 1x1 placeholder (nothing known yet),
        # which the phone retries on (wireThumb: naturalWidth <= 1).
        assert first.headers["content-type"] == "image/png"
        assert _png_size(first.content) == (1, 1)

        # The retry: the grey logo tile, a real 16:9 image, not cached hard.
        for _ in range(2):
            res = await _poll(c, vid)
            assert res.status_code == 200
            assert res.headers["content-type"] == "image/png"
            assert _png_size(res.content) == (320, 180)
            assert res.headers.get("cache-control") == "no-cache"
            with open(media.NO_VIDEO_THUMB, "rb") as f:
                assert res.content == f.read()
    # Only one ffmpeg attempt: a known audio file is not tried again.
    assert len(media._thumb_failed) == 1


@pytest.mark.anyio
async def test_a_file_ffprobe_cannot_read_is_not_taken_for_audio(env):
    tmp_path, _ = env
    broken = tmp_path / "Broken.mp4"
    broken.write_bytes(b"not really a video")
    vid = _register(broken, 1)
    async with _client() as c:
        for _ in range(3):
            res = await _poll(c, vid)
            assert _png_size(res.content) == (1, 1)
    assert media._thumb_no_video == {}


@pytest.mark.anyio
async def test_a_real_video_still_gets_its_frame(env):
    tmp_path, ffmpeg_bin = env
    clip = tmp_path / "Real Clip.mp4"
    _make(ffmpeg_bin, clip, "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
          "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-shortest")
    vid = _register(clip, 3)
    async with _client() as c:
        await _poll(c, vid)
        res = await _poll(c, vid)
        assert res.headers["content-type"] == "image/jpeg"
    assert media._thumb_no_video == {}


@pytest.mark.anyio
async def test_a_poster_the_user_uploaded_still_wins(env, monkeypatch):
    tmp_path, ffmpeg_bin = env
    audio = tmp_path / "Audio Only.m4a"
    _make(ffmpeg_bin, audio, "-f", "lavfi", "-i", "sine=duration=3", "-c:a", "aac")
    vid = _register(audio, 3)
    async with _client() as c:
        await _poll(c, vid)
        assert _png_size((await _poll(c, vid)).content) == (320, 180)

        posters = tmp_path / "custom-thumbs"
        posters.mkdir()
        poster = posters / "poster.png"
        shutil.copyfile(os.path.join(os.path.dirname(media.NO_VIDEO_THUMB), "icon-256.png"), poster)
        monkeypatch.setattr(media, "_custom_thumbs_dir", str(posters))
        monkeypatch.setattr(media, "_custom_thumbs", {str(audio): {"type": "image", "imagePath": str(poster)}})
        res = await _poll(c, vid)
        assert _png_size(res.content) == (256, 256)


@pytest.mark.anyio
async def test_the_audio_file_changed_into_a_video_is_looked_at_again(env):
    tmp_path, ffmpeg_bin = env
    path = tmp_path / "Swapped.mp4"
    _make(ffmpeg_bin, path, "-f", "lavfi", "-i", "sine=duration=3", "-c:a", "aac")
    vid = _register(path, 3)
    async with _client() as c:
        await _poll(c, vid)
        assert _png_size((await _poll(c, vid)).content) == (320, 180)
        # Replaced by a real video (same name, new size and time).
        _make(ffmpeg_bin, path, "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
              "-c:v", "libx264", "-pix_fmt", "yuv420p")
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        await _poll(c, vid)
        res = await _poll(c, vid)
        assert res.headers["content-type"] == "image/jpeg"
