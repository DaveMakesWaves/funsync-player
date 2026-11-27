"""Convert to play (Dave, 2026-11-26).

A video whose codec the player cannot decode (his 2.5.4_variant1.mp4: MPEG-4
Part 2, "MPEG4 Simple Profile yuv420p") played sound over black, and a remux
cannot help. services.ffmpeg converts it to H.264 8-bit 4:2:0 in the remux
cache as a background job with progress and cancel; the source is only read.
"""
import os
import shutil
import subprocess
import time

import pytest

from services import ffmpeg as f


# --- the command ------------------------------------------------------------

class TestTranscodeArgs:
    def test_h264_8bit_even_sizes_progress_on_stdout(self):
        args = f.transcode_args("in.avi", "out.part.mp4", "libx264", "mp3")
        assert args[args.index("-c:v") + 1] == "libx264"
        assert args[args.index("-pix_fmt") + 1] == "yuv420p"
        assert "scale=trunc(iw/2)*2:trunc(ih/2)*2" in args
        assert args[args.index("-progress") + 1] == "pipe:1"
        assert "+faststart" in args
        assert args[-1] == "out.part.mp4"
        assert "-nostdin" in args
        # the first video and the first audio, if any
        assert "0:v:0" in args and "0:a:0?" in args

    def test_audio_copy_aac_or_none(self):
        assert f.transcode_args("i", "o", "libx264", "aac")[f.transcode_args("i", "o", "libx264", "aac").index("-c:a") + 1] == "copy"
        args = f.transcode_args("i", "o", "libx264", "wmav2")
        assert args[args.index("-c:a") + 1] == "aac"
        assert "-c:a" not in f.transcode_args("i", "o", "libx264", None)


# --- the job ----------------------------------------------------------------

@pytest.fixture
def cache(monkeypatch, tmp_path):
    monkeypatch.setattr(f, "tempfile", type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))}))
    monkeypatch.setattr(f, "_transcode_jobs", {})
    monkeypatch.setattr(f, "_h264_encoder_probe", ["libx264"])
    monkeypatch.setattr(f, "get_metadata", lambda _p: {"duration": 10.0, "codec": "mpeg4"})
    monkeypatch.setattr(f, "_probe_audio_codec", lambda _p: "mp3")
    src = tmp_path / "in.avi"
    src.write_bytes(b"placeholder")
    return src


class FakePopen:
    """ffmpeg as the job sees it: progress lines on stdout, then an exit code;
    writes the part file (the last argument) unless told to fail."""

    def __init__(self, args, lines, code=0, write=True, hold=None):
        self.args = args
        self.returncode = None
        self._code = code
        self.terminated = False
        self.stderr = iter(["frame=1", "some error text"] if code else [])
        out = args[-1]
        def gen():
            for line in lines:
                if hold is not None:
                    hold.wait(5)
                yield line + "\n"
            if write and code == 0:
                with open(out, "wb") as fh:
                    fh.write(b"\x00\x00\x00\x20ftypisom")
        self.stdout = gen()

    def wait(self, timeout=None):
        self.returncode = -15 if self.terminated else self._code
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def _wait_done(key, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        s = f.transcode_status(key)
        if s["state"] != "running":
            return s
        time.sleep(0.02)
    return f.transcode_status(key)


class TestTranscodeJob:
    def test_runs_reports_progress_and_finishes_into_the_cache(self, cache, monkeypatch):
        lines = ["out_time_us=2500000", "progress=continue", "out_time_us=5000000", "progress=end"]
        monkeypatch.setattr(f.subprocess, "Popen", lambda args, **kw: FakePopen(args, lines))
        view = f.transcode_start(str(cache))
        assert view["state"] in ("running", "done")
        done = _wait_done(view["job"])
        assert done["state"] == "done"
        assert done["progress"] == 1.0
        assert done["path"] == f.transcode_out_path(str(cache))
        assert os.path.getsize(done["path"]) > 0
        assert not os.path.exists(done["path"][: -len(".mp4")] + ".part.mp4")
        # the source is only read
        assert cache.read_bytes() == b"placeholder"

    def test_a_second_start_uses_the_copy_without_ffmpeg(self, cache, monkeypatch):
        out = f.transcode_out_path(str(cache))
        with open(out, "wb") as fh:
            fh.write(b"x")
        monkeypatch.setattr(f.subprocess, "Popen", lambda *a, **k: pytest.fail("ffmpeg must not run"))
        view = f.transcode_start(str(cache))
        assert view["state"] == "done" and view["cached"] is True and view["path"] == out

    def test_cached_only_starts_nothing(self, cache, monkeypatch):
        monkeypatch.setattr(f.subprocess, "Popen", lambda *a, **k: pytest.fail("ffmpeg must not run"))
        assert f.transcode_start(str(cache), cached_only=True)["state"] == "none"

    def test_progress_is_a_fraction_of_the_duration(self, cache, monkeypatch):
        import threading
        hold = threading.Event()
        lines = ["out_time_us=4000000", "out_time_us=6000000"]
        monkeypatch.setattr(f.subprocess, "Popen", lambda args, **kw: FakePopen(args, lines, hold=hold))
        view = f.transcode_start(str(cache))
        # while ffmpeg is held, a second start answers with the running job
        again = f.transcode_start(str(cache))
        assert again["job"] == view["job"] and again["state"] == "running"
        hold.set()
        done = _wait_done(view["job"])
        assert done["state"] == "done"

    def test_ffmpeg_failing_leaves_no_file_and_says_why(self, cache, monkeypatch):
        monkeypatch.setattr(f.subprocess, "Popen", lambda args, **kw: FakePopen(args, ["out_time_us=1"], code=1))
        view = f.transcode_start(str(cache))
        s = _wait_done(view["job"])
        assert s["state"] == "error"
        assert "some error text" in s["error"]
        out = f.transcode_out_path(str(cache))
        assert not os.path.exists(out)
        assert not os.path.exists(out[: -len(".mp4")] + ".part.mp4")

    def test_cancel_stops_ffmpeg_and_keeps_nothing(self, cache, monkeypatch):
        import threading
        hold = threading.Event()
        procs = []
        def popen(args, **kw):
            p = FakePopen(args, ["out_time_us=1000000", "out_time_us=2000000"], hold=hold)
            procs.append(p)
            return p
        monkeypatch.setattr(f.subprocess, "Popen", popen)
        view = f.transcode_start(str(cache))
        for _ in range(100):
            if procs and f._transcode_jobs[view["job"]].get("proc") is not None:
                break
            time.sleep(0.01)
        f.transcode_cancel(view["job"])
        hold.set()
        s = _wait_done(view["job"])
        assert s["state"] == "cancelled"
        assert procs[0].terminated is True
        out = f.transcode_out_path(str(cache))
        assert not os.path.exists(out)

    def test_no_h264_encoder_says_so(self, cache, monkeypatch):
        monkeypatch.setattr(f, "_h264_encoder_probe", [None])
        with pytest.raises(f.TranscodeUnavailable):
            f.transcode_start(str(cache))

    def test_missing_file(self, cache, tmp_path):
        with pytest.raises(FileNotFoundError):
            f.transcode_start(str(tmp_path / "nope.avi"))


# --- the real thing, when ffmpeg is here --------------------------------------

def _real_ffmpeg():
    exe = f.FFMPEG
    return exe if exe and (os.path.isfile(exe) or shutil.which(exe)) else None


@pytest.mark.skipif(_real_ffmpeg() is None, reason="needs ffmpeg")
def test_real_mpeg4_part2_becomes_h264(monkeypatch, tmp_path):
    """Dave's case end to end: an MPEG-4 Part 2 file (what Chromium cannot
    decode) comes out H.264 8-bit 4:2:0 that it can."""
    monkeypatch.setattr(f, "tempfile", type("T", (), {"gettempdir": staticmethod(lambda: str(tmp_path))}))
    monkeypatch.setattr(f, "_transcode_jobs", {})
    monkeypatch.setattr(f, "_h264_encoder_probe", [])
    src = tmp_path / "xvid.mp4"
    made = subprocess.run(
        [f.FFMPEG, "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=322x182:rate=25:duration=2",
         "-c:v", "mpeg4", str(src)], capture_output=True)
    if made.returncode != 0 or not src.exists():
        pytest.skip("this ffmpeg cannot make an MPEG-4 Part 2 file")
    if f._h264_encoder() is None:
        pytest.skip("this ffmpeg has no H.264 encoder")
    view = f.transcode_start(str(src))
    s = _wait_done(view["job"], timeout=60)
    assert s["state"] == "done", s
    probe = subprocess.run(
        [f.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt",
         "-of", "csv=p=0", s["path"]], capture_output=True, text=True)
    codec, width, height, pix = probe.stdout.strip().split(",")[:4]
    assert (codec, pix) == ("h264", "yuv420p")
    assert (int(width), int(height)) == (322, 182)
    assert src.exists()  # the source is still there, untouched


# --- where the copies live (Dave: "yes move them to the data folder") --------

def test_copies_go_to_the_data_folder_when_set(monkeypatch, tmp_path):
    monkeypatch.setattr(f, "_converted_dir", None)
    src = tmp_path / "v.avi"
    src.write_bytes(b"x")
    data = tmp_path / "userData" / "converted"
    f.set_converted_dir(str(data))
    try:
        out = f.transcode_out_path(str(src))
        assert os.path.dirname(out) == str(data)
        assert data.is_dir()
        assert out.endswith(".h264.mp4")
    finally:
        f.set_converted_dir(None)


def test_main_points_the_copies_at_user_data(monkeypatch, tmp_path):
    import main as backend_main
    monkeypatch.setattr(f, "_converted_dir", None)
    seen = {}
    monkeypatch.setattr(f, "set_converted_dir", lambda p: seen.setdefault("dir", p))
    backend_main.apply_user_data_dir(str(tmp_path))
    assert seen["dir"] == os.path.join(str(tmp_path), "converted")


def test_startup_removes_part_files_left_by_a_quit_mid_conversion(monkeypatch, tmp_path):
    """Test day 2026-11-26: the app quit while converting; ffmpeg went with the
    backend, its half-written part file (39 MB) stayed in the folder, counted
    nowhere. The next start removes it; copies and anything else stay."""
    monkeypatch.setattr(f, "_converted_dir", None)
    d = tmp_path / "converted"
    d.mkdir()
    (d / "6752a229f87e.h264.part.mp4").write_bytes(b"x" * 100)
    (d / "522da65aed14.h264.mp4").write_bytes(b"copy")
    (d / "notes.txt").write_bytes(b"keep")
    (d / "other.part.mp4").write_bytes(b"not ours")
    f.set_converted_dir(str(d))
    try:
        assert sorted(p.name for p in d.iterdir()) == ["522da65aed14.h264.mp4", "notes.txt", "other.part.mp4"]
    finally:
        f.set_converted_dir(None)
