"""Embedded subtitles (#268 thirstyduck500, 2026-11-23): list a file's
subtitle streams, convert a text one to WebVTT, and refuse a picture one
(PGS / VobSub) with a clear status instead of returning nothing."""

import os
import shutil
import subprocess

import pytest

from services import ffmpeg as ffmpeg_mod


def _have(binary):
    return (os.path.isabs(binary) and os.path.exists(binary)) or shutil.which(binary)


@pytest.fixture
def mkv_with_srt(tmp_path):
    """A 3 s MKV holding one English SRT stream (default) and one untagged."""
    if not _have(ffmpeg_mod.FFMPEG) or not _have(ffmpeg_mod.FFPROBE):
        pytest.skip("ffmpeg / ffprobe not available")
    srt = tmp_path / "en.srt"
    srt.write_text("1\n00:00:00,500 --> 00:00:01,500\nHello there\n\n2\n00:00:02,000 --> 00:00:02,800\nSecond line\n", encoding="utf-8")
    srt2 = tmp_path / "x.srt"
    srt2.write_text("1\n00:00:01,000 --> 00:00:02,000\nAnother track\n", encoding="utf-8")
    out = tmp_path / "Clip With Subs.mkv"
    subprocess.run(
        [ffmpeg_mod.FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
         # -t BEFORE its -i: an input option, so the generated video ends
         # (after the -i it applied to the next input and this never ended).
         "-t", "3", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10",
         "-i", str(srt), "-i", str(srt2),
         "-map", "0:v", "-map", "1:0", "-map", "2:0",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:s", "srt",
         "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English",
         "-disposition:s:0", "default", "-disposition:s:1", "0",
         str(out)],
        check=True, capture_output=True,
    )
    return out


def test_lists_the_text_streams_with_their_language_title_and_flags(mkv_with_srt):
    tracks = ffmpeg_mod.list_subtitle_streams(str(mkv_with_srt))
    assert [t["codec"] for t in tracks] == ["subrip", "subrip"]
    assert tracks[0]["language"] == "eng" and tracks[0]["title"] == "English"
    assert tracks[0]["default"] is True and tracks[1]["default"] is False
    assert all(t["text"] for t in tracks)
    assert tracks[0]["index"] != tracks[1]["index"]


def test_a_text_stream_becomes_webvtt_and_is_kept_for_the_session(mkv_with_srt, monkeypatch):
    first = ffmpeg_mod.list_subtitle_streams(str(mkv_with_srt))[0]
    vtt = ffmpeg_mod.extract_subtitle_vtt(str(mkv_with_srt), first["index"])
    assert vtt.startswith("WEBVTT")
    assert "Hello there" in vtt and "Second line" in vtt
    assert "00:00.500 --> 00:01.500" in vtt or "00:00:00.500 --> 00:00:01.500" in vtt
    # Asked again: no second ffmpeg run (it reads the whole file).
    calls = []
    real = ffmpeg_mod.run_silent
    monkeypatch.setattr(ffmpeg_mod, "run_silent", lambda *a, **k: (calls.append(a[0][0]), real(*a, **k))[1])
    assert ffmpeg_mod.extract_subtitle_vtt(str(mkv_with_srt), first["index"]) == vtt
    assert calls == [ffmpeg_mod.FFPROBE]   # the listing only


def test_a_picture_stream_is_refused_not_emptied(monkeypatch, tmp_path):
    f = tmp_path / "bd.mkv"
    f.write_bytes(b"x")
    monkeypatch.setattr(ffmpeg_mod, "list_subtitle_streams", lambda p: [
        {"index": 2, "codec": "hdmv_pgs_subtitle", "language": "eng", "title": "", "default": True, "forced": False, "text": False},
    ])
    with pytest.raises(ValueError):
        ffmpeg_mod.extract_subtitle_vtt(str(f), 2)
    with pytest.raises(LookupError):
        ffmpeg_mod.extract_subtitle_vtt(str(f), 7)


def test_picture_codecs_are_not_text():
    for codec in ("hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"):
        assert codec not in ffmpeg_mod.TEXT_SUBTITLE_CODECS
    for codec in ("subrip", "ass", "ssa", "mov_text", "webvtt"):
        assert codec in ffmpeg_mod.TEXT_SUBTITLE_CODECS


def test_the_routes_desktop_only_statuses(mkv_with_srt, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app, base_url="http://127.0.0.1:5123", client=("127.0.0.1", 50000))
    res = client.get("/api/media/subtitle-tracks", params={"video_path": str(mkv_with_srt)})
    assert res.status_code == 200
    tracks = res.json()["tracks"]
    assert len(tracks) == 2
    res = client.get("/api/media/subtitle-track", params={"video_path": str(mkv_with_srt), "index": tracks[0]["index"]})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/vtt")
    assert "Hello there" in res.text
    assert client.get("/api/media/subtitle-tracks", params={"video_path": str(tmp_path / "nope.mkv")}).status_code == 404
    assert client.get("/api/media/subtitle-track", params={"video_path": str(mkv_with_srt), "index": 99}).status_code == 404
    monkeypatch.setattr(ffmpeg_mod, "list_subtitle_streams", lambda p: [
        {"index": 2, "codec": "hdmv_pgs_subtitle", "language": "", "title": "", "default": False, "forced": False, "text": False},
    ])
    assert client.get("/api/media/subtitle-track", params={"video_path": str(mkv_with_srt), "index": 2}).status_code == 415
    # Not the desktop: refused.
    phone = TestClient(app, base_url="http://192.168.1.50:5123", client=("192.168.1.50", 50000))
    assert phone.get("/api/media/subtitle-tracks", params={"video_path": str(mkv_with_srt)}).status_code == 403


def test_the_phone_routes_by_video_id(mkv_with_srt, monkeypatch, tmp_path):
    """The phone (a LAN host) asks by registered video id, as it does for a
    subtitle file beside the video: open to the LAN, never a path."""
    from fastapi.testclient import TestClient
    from main import app
    from routes.media import register_videos, _path_to_id

    plain = tmp_path / "Plain.avi"
    plain.write_bytes(b"\x00" * 16)
    register_videos([{"path": str(mkv_with_srt), "name": mkv_with_srt.name},
                     {"path": str(plain), "name": plain.name}])
    vid = _path_to_id(str(mkv_with_srt))
    phone = TestClient(app, base_url="http://192.168.1.50:5123", client=("192.168.1.50", 50000))

    res = phone.get(f"/api/media/subtitle/{vid}/tracks")
    assert res.status_code == 200
    tracks = res.json()["tracks"]
    assert [t["language"] for t in tracks] == ["eng", ""] and tracks[0]["default"] is True
    res = phone.get(f"/api/media/subtitle/{vid}/track/{tracks[0]['index']}")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/vtt")
    assert "Hello there" in res.text

    # A file that cannot carry subtitle streams: none, and no ffprobe run.
    assert phone.get(f"/api/media/subtitle/{_path_to_id(str(plain))}/tracks").json() == {"tracks": []}
    # Unknown id, no such stream, a negative index.
    assert phone.get("/api/media/subtitle/nope/tracks").status_code == 404
    assert phone.get(f"/api/media/subtitle/{vid}/track/99").status_code == 404
    assert phone.get(f"/api/media/subtitle/{vid}/track/-1").status_code == 422
    # A picture stream: refused, not emptied.
    monkeypatch.setattr(ffmpeg_mod, "list_subtitle_streams", lambda p: [
        {"index": 2, "codec": "hdmv_pgs_subtitle", "language": "", "title": "", "default": False, "forced": False, "text": False},
    ])
    assert phone.get(f"/api/media/subtitle/{vid}/track/2").status_code == 415
    # The sidecar route is unchanged: no file beside it, 404.
    assert phone.get(f"/api/media/subtitle/{vid}").status_code == 404
