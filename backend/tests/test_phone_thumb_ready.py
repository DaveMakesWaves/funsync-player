"""A first phone visit gets the frame the desktop already made (R3-30, TODO
triage 2026-11-23): /api/media/thumb/{id} answered a 1x1 placeholder on a
miss even when the desktop's generator had that exact frame on disk (the
background job only copies it), so every card was blank for about a second
and asked again. Now the ready frame is served at once; no ffmpeg runs for
it, and a cut-off file is never served."""

import os
import tempfile

from fastapi.testclient import TestClient

from main import app
from routes import media as media_routes
from routes.media import register_videos, _path_to_id
from services.ffmpeg import _get_video_hash

JPEG = b"\xff\xd8" + b"\x00" * 64 + b"\xff\xd9"


def _desktop_cache_file(video_path, name="single_v4_0100_320.jpg"):
    d = os.path.join(tempfile.gettempdir(), "funsync_thumbs", _get_video_hash(str(video_path)))
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, name)


def _setup(tmp_path, monkeypatch, name):
    video = tmp_path / name
    video.write_bytes(os.urandom(256))
    register_videos([{"path": str(video), "name": video.name}])
    queued = []
    monkeypatch.setattr(media_routes, "_queue_thumb_generation", lambda *a, **k: queued.append(a))
    phone = TestClient(app, base_url="http://192.168.1.50:5123", client=("192.168.1.50", 50000))
    return video, _path_to_id(str(video)), queued, phone


def test_the_desktops_ready_frame_is_served_on_the_first_request(tmp_path, monkeypatch):
    video, vid, queued, phone = _setup(tmp_path, monkeypatch, "Ready Clip.mp4")
    cached = _desktop_cache_file(video)
    with open(cached, "wb") as f:
        f.write(JPEG)
    try:
        res = phone.get(f"/api/media/thumb/{vid}")
        assert res.status_code == 200
        assert res.headers["content-type"] == "image/jpeg"
        assert res.content == JPEG
        assert len(queued) == 1          # still copied into the phone's cache for next time
    finally:
        os.remove(cached)


def test_no_ready_frame_or_a_cut_off_one_still_gets_the_placeholder(tmp_path, monkeypatch):
    video, vid, queued, phone = _setup(tmp_path, monkeypatch, "Fresh Clip.mp4")
    res = phone.get(f"/api/media/thumb/{vid}")
    assert res.headers["content-type"] == "image/png" and len(res.content) < 100
    cached = _desktop_cache_file(video)
    with open(cached, "wb") as f:
        f.write(JPEG[:-2])             # no EOI: ffmpeg was cut off
    try:
        res = phone.get(f"/api/media/thumb/{vid}")
        assert res.headers["content-type"] == "image/png"
    finally:
        os.remove(cached)


def test_a_pinned_frame_only_takes_the_desktops_exact_grab_of_that_frame(tmp_path, monkeypatch):
    video, vid, queued, phone = _setup(tmp_path, monkeypatch, "Pinned Clip.mp4")
    monkeypatch.setattr(media_routes, "_custom_thumb_for", lambda p: {"seekPct": 0.25})
    keyframe = _desktop_cache_file(video)                       # the 10 % auto frame: not it
    exact = _desktop_cache_file(video, "single_v4e_0250_320.jpg")
    with open(keyframe, "wb") as f:
        f.write(JPEG)
    try:
        assert phone.get(f"/api/media/thumb/{vid}").headers["content-type"] == "image/png"
        with open(exact, "wb") as f:
            f.write(JPEG)
        assert phone.get(f"/api/media/thumb/{vid}").content == JPEG
    finally:
        for p in (keyframe, exact):
            if os.path.exists(p):
                os.remove(p)
