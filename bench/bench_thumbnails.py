"""Benchmark thumbnail-generation strategies under realistic concurrent load.

Mimics the renderer's thumbnail queue (`MAX_CONCURRENT_THUMBNAILS = 4`)
firing N parallel ffmpeg subprocesses against a real video library.

Compares strategies head-to-head:
    A. Baseline           — current code (`scale=W:-2`, software decode)
    B. hwaccel auto       — let ffmpeg pick the best hardware decoder
    C. hwaccel cuda       — explicitly use NVDEC (NVIDIA only)
    D. hwaccel qsv        — explicitly use Intel Quick Sync
    E. skip_frame nokey   — software decode, only emit keyframes

Each strategy gets its own temp dir so the disk cache doesn't lie about
warm runs. Reports total wall-clock + per-file timing + failure counts.

Usage:
    python bench_thumbnails.py <library_dir> [--concurrency 4]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Resolve project paths.
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
FFMPEG = PROJECT_ROOT / "ffmpeg" / "ffmpeg.exe"
FFPROBE = PROJECT_ROOT / "ffmpeg" / "ffprobe.exe"

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".avi", ".mov"}
THUMBNAIL_WIDTH = 320
SEEK_PCT = 0.1
SUBPROCESS_TIMEOUT = 60

# Suppress Windows console popups when spawning ffmpeg from a windowed app.
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
SUBPROCESS_FLAGS = {"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {}


def probe_duration(video_path: Path) -> float:
    """Return duration in seconds via ffprobe; 0 on failure."""
    try:
        result = subprocess.run(
            [
                str(FFPROBE),
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            **SUBPROCESS_FLAGS,
        )
        return float(result.stdout.strip()) if result.returncode == 0 else 0.0
    except Exception:
        return 0.0


def probe_codec(video_path: Path) -> str:
    """Return primary video codec name (e.g. 'h264', 'hevc'); '?' on failure."""
    try:
        result = subprocess.run(
            [
                str(FFPROBE),
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            **SUBPROCESS_FLAGS,
        )
        return result.stdout.strip() or "?"
    except Exception:
        return "?"


def seek_time(duration: float) -> float:
    """Match the production seek formula in services/ffmpeg.py."""
    return max(10.0, duration * SEEK_PCT) if duration > 60 else duration * SEEK_PCT


def gen_thumbnail(
    video_path: Path,
    output_dir: Path,
    duration: float,
    extra_input_args: list[str] | None = None,
    extra_filter: str = "",
) -> tuple[bool, float, str]:
    """Generate one thumbnail with the given strategy. Returns (ok, elapsed_s, error)."""
    if duration <= 0 or video_path.stat().st_size == 0:
        return False, 0.0, "empty/unprobable"

    output = output_dir / f"{video_path.stem[:50]}.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    seek = seek_time(duration)
    vf_chain = f"scale={THUMBNAIL_WIDTH}:-2"
    if extra_filter:
        vf_chain = f"{extra_filter},{vf_chain}"

    cmd = [str(FFMPEG), "-v", "error"]
    if extra_input_args:
        cmd += extra_input_args
    cmd += [
        "-ss", str(seek),
        "-i", str(video_path),
        "-frames:v", "1",
        "-vf", vf_chain,
        "-q:v", "5",
        "-y",
        str(output),
    ]

    start = time.perf_counter()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SUBPROCESS_TIMEOUT,
            **SUBPROCESS_FLAGS,
        )
        elapsed = time.perf_counter() - start
        if result.returncode != 0 or not output.exists():
            return False, elapsed, (result.stderr or "").strip()[:200]
        return True, elapsed, ""
    except subprocess.TimeoutExpired:
        return False, time.perf_counter() - start, f"timeout (>{SUBPROCESS_TIMEOUT}s)"
    except Exception as e:
        return False, time.perf_counter() - start, str(e)[:200]


# ---------------- Strategies under test ----------------

STRATEGIES = {
    "A_baseline":       {"input_args": [],                                          "filter": ""},
    "B_hwaccel_auto":   {"input_args": ["-hwaccel", "auto"],                       "filter": ""},
    "C_hwaccel_cuda":   {"input_args": ["-hwaccel", "cuda"],                       "filter": ""},
    "D_hwaccel_qsv":    {"input_args": ["-hwaccel", "qsv"],                        "filter": ""},
    "E_skip_nokey":     {"input_args": ["-skip_frame", "nokey"],                   "filter": ""},
    "F_hwaccel_d3d11":  {"input_args": ["-hwaccel", "d3d11va"],                    "filter": ""},
}


def run_strategy(
    strategy_name: str,
    videos: list[tuple[Path, float, str]],
    concurrency: int,
) -> dict:
    """Run one strategy across all videos with the given concurrency. Returns summary dict."""
    cfg = STRATEGIES[strategy_name]
    output_root = Path(tempfile.mkdtemp(prefix=f"bench_{strategy_name}_"))

    per_file = []
    failures = []

    overall_start = time.perf_counter()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        future_to_video = {
            pool.submit(
                gen_thumbnail,
                vp,
                output_root,
                dur,
                cfg["input_args"],
                cfg["filter"],
            ): (vp, dur, codec)
            for vp, dur, codec in videos
        }
        for future in as_completed(future_to_video):
            vp, dur, codec = future_to_video[future]
            ok, elapsed, err = future.result()
            per_file.append((vp.name, codec, dur, elapsed, ok))
            if not ok:
                failures.append((vp.name, err))

    total_wall = time.perf_counter() - overall_start

    # Cleanup output dir
    shutil.rmtree(output_root, ignore_errors=True)

    return {
        "strategy": strategy_name,
        "total_wall_s": total_wall,
        "files": len(videos),
        "ok": sum(1 for *_, ok in per_file if ok),
        "fail": len(failures),
        "failures": failures,
        "per_file": per_file,
    }


def print_summary(results: list[dict]) -> None:
    print()
    print("=" * 84)
    print(f"{'STRATEGY':<22}{'WALL':>10}{'FILES':>8}{'OK':>6}{'FAIL':>6}{'AVG/FILE':>12}{'MAX':>10}")
    print("-" * 84)
    for r in sorted(results, key=lambda x: x["total_wall_s"]):
        avg = sum(e for *_, e, ok in r["per_file"] if ok) / max(r["ok"], 1)
        max_e = max((e for *_, e, _ in r["per_file"]), default=0.0)
        print(f"{r['strategy']:<22}{r['total_wall_s']:>9.2f}s{r['files']:>8}{r['ok']:>6}{r['fail']:>6}{avg:>11.2f}s{max_e:>9.2f}s")
    print("=" * 84)
    print()
    for r in results:
        if r["failures"]:
            print(f"  [{r['strategy']}] FAILURES:")
            for name, err in r["failures"]:
                print(f"    - {name}: {err}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("library_dir", help="Directory of video files (recursed)")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--strategies", nargs="+", default=list(STRATEGIES.keys()),
                        help="Subset of strategy names to run")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limit to first N videos for quick iteration")
    args = parser.parse_args()

    lib = Path(args.library_dir)
    if not lib.is_dir():
        print(f"ERROR: not a directory: {lib}")
        sys.exit(1)

    print(f"Scanning {lib} ...")
    videos_paths = sorted(
        p for p in lib.rglob("*")
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    )
    if args.limit:
        videos_paths = videos_paths[:args.limit]
    print(f"Found {len(videos_paths)} video files. Probing...")

    # Probe metadata once (shared across strategies for fairness).
    videos = []
    for vp in videos_paths:
        dur = probe_duration(vp)
        codec = probe_codec(vp)
        videos.append((vp, dur, codec))
        marker = "!" if dur == 0 else " "
        print(f"  {marker} {codec:>6}  {dur:>7.1f}s  {vp.name}")

    print()
    print(f"Concurrency: {args.concurrency}")
    print(f"Strategies:  {', '.join(args.strategies)}")
    print(f"Each strategy makes a fresh thumbnail set in its own temp dir (no cache reuse).")
    print()

    results = []
    for sname in args.strategies:
        if sname not in STRATEGIES:
            print(f"  skip unknown strategy: {sname}")
            continue
        print(f"--- Running {sname} ---")
        r = run_strategy(sname, videos, args.concurrency)
        print(f"    total wall: {r['total_wall_s']:.2f}s  ok: {r['ok']}/{r['files']}  fail: {r['fail']}")
        results.append(r)

    print_summary(results)


if __name__ == "__main__":
    main()
