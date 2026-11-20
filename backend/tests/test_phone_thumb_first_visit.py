"""R3-30: why the phone asks for every thumbnail twice on a first visit.

A verifier saw the phone page request all 19 thumbnails twice, the second
time with `?_r=1` about 1 s after the first, and asked whether the first
answers were failures (app test V31 regressing on the short fixtures, whose
only keyframe is at t=0). They are not: on a cold phone cache
(`<userData>/thumb-cache/<id>.jpg`) the route answers a 200 1x1 PNG
placeholder and generates the frame in the background; the phone's
`wireThumb` (backend/web-remote/app.js) re-requests a 1x1 answer after 1 s
with a cache-buster, and that request gets the JPEG. Every later visit is
served from the cache at once, with no retry.

This drives the REAL route with the REAL ffmpeg on a clip shaped like the
sandbox fixtures, from a LAN client as the phone is. Temp folders are the
test's own (`services.ffmpeg` writes its cache under tempfile.gettempdir()).
"""

import asyncio
import os
import shutil
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
def _isolated(monkeypatch, tmp_path):
    ffmpeg_mod._reset_metadata_cache_for_tests()
    monkeypatch.setattr(
        ffmpeg_mod, "tempfile",
        type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))}),
    )
    cache = tmp_path / "thumb-cache"
    cache.mkdir()
    monkeypatch.setattr(media, "_thumb_cache_dir", str(cache))
    yield tmp_path
    ffmpeg_mod._reset_metadata_cache_for_tests()


@pytest.mark.anyio
async def test_cold_cache_placeholder_first_then_jpeg_then_cached(_isolated):
    tmp_path = _isolated
    ffmpeg_bin = ffmpeg_mod.FFMPEG
    if not (os.path.isabs(ffmpeg_bin) and os.path.exists(ffmpeg_bin)) and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not available")

    # 8 s, one keyframe at t=0: what fixtures.cjs makes for "Alpha Scene.mp4".
    clip = tmp_path / "Alpha Scene.mp4"
    subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=8",
         "-c:v", "libx264", "-g", "1000", "-pix_fmt", "yuv420p", str(clip)],
        check=True, capture_output=True,
    )
    # A duration is given so no background ffprobe pass outlives the test.
    media.register_videos([{"path": str(clip), "name": clip.name, "duration": 8}])
    vid = media._path_to_id(str(clip))

    transport = ASGITransport(app=app, client=("192.168.1.50", 50000))  # the phone, on the LAN
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        first = await c.get(f"/api/media/thumb/{vid}")
        assert first.status_code == 200, "the first answer is not a failure"
        assert first.headers["content-type"] == "image/png"
        assert len(first.content) == 67  # the 1x1 placeholder the phone retries on
        assert first.headers.get("cache-control") == "no-cache"

        # The phone's retries (?_r=1, 2, ...) until the frame is in.
        got = None
        for attempt in range(1, 41):
            await asyncio.sleep(0.25)
            r = await c.get(f"/api/media/thumb/{vid}?_r={attempt}")
            assert r.status_code == 200
            if r.headers["content-type"] == "image/jpeg":
                got = r
                break
        assert got is not None, "the one-keyframe clip never got a thumbnail (V31)"
        assert got.content[:2] == b"\xff\xd8"

        # A later visit: the JPEG straight away, nothing for the phone to retry.
        again = await c.get(f"/api/media/thumb/{vid}")
        assert again.status_code == 200
        assert again.headers["content-type"] == "image/jpeg"
        assert again.content == got.content
