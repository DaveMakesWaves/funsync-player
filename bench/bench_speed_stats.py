"""Benchmark for computing average funscript speed across a large library.

Question: if the web remote started showing per-video average speed on
mobile cards, how much would it add to library load time for 3000+
videos? Answer by actually doing it — generate a realistic spread of
fake funscripts, then measure the read + parse + compute pipeline under
sequential and parallel-worker schedules.

Realistic action counts come from the typical funscript distribution on
community sites:
  - 60% short scripts (200–800 actions, ~3–15 min content)
  - 30% medium scripts (800–2000 actions, ~15–40 min)
  - 10% long scripts (2000–5000 actions, ~40+ min, edging/compilations)
"""

import json
import os
import random
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor


def compute_speed_stats(actions):
    """Port of renderer/js/library-search.js::computeSpeedStats."""
    if not actions or len(actions) < 2:
        return {"avg": 0, "max": 0}
    total = 0.0
    max_speed = 0.0
    count = 0
    for i in range(1, len(actions)):
        dt = actions[i]["at"] - actions[i - 1]["at"]
        if dt <= 0:
            continue
        dp = abs(actions[i]["pos"] - actions[i - 1]["pos"])
        if dp == 0:
            continue
        speed = (dp / dt) * 1000
        total += speed
        if speed > max_speed:
            max_speed = speed
        count += 1
    return {
        "avg": round(total / count) if count > 0 else 0,
        "max": round(max_speed),
    }


def make_funscript(n_actions):
    actions = []
    t = 0
    last_pos = 50
    for _ in range(n_actions):
        t += random.randint(50, 500)
        # Bias toward alternating — mimics real stroke patterns
        last_pos = 100 - last_pos + random.randint(-20, 20)
        last_pos = max(0, min(100, last_pos))
        actions.append({"at": t, "pos": last_pos})
    return {"version": "1.0", "actions": actions}


def realistic_action_count():
    r = random.random()
    if r < 0.60:
        return random.randint(200, 800)
    elif r < 0.90:
        return random.randint(800, 2000)
    else:
        return random.randint(2000, 5000)


def bench(n_videos):
    random.seed(42)  # stable distribution across runs

    action_counts = [realistic_action_count() for _ in range(n_videos)]

    print(f"\n=== {n_videos} videos ===")
    print(f"  Total actions across library: {sum(action_counts):,}")
    print(f"  Avg actions per video: {sum(action_counts) / n_videos:.0f}")

    with tempfile.TemporaryDirectory() as tmp:
        # 1. Write fake funscripts to disk (not timed — setup)
        paths = []
        for i, n in enumerate(action_counts):
            fs = make_funscript(n)
            path = os.path.join(tmp, f"video_{i:04d}.funscript")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(fs, f, separators=(",", ":"))
            paths.append(path)

        total_bytes = sum(os.path.getsize(p) for p in paths)
        print(f"  Total on-disk size: {total_bytes / 1024 / 1024:.1f} MB")

        # 2. Compute-only (actions already in memory)
        funscripts = []
        for p in paths:
            with open(p, encoding="utf-8") as f:
                funscripts.append(json.load(f))

        t0 = time.perf_counter()
        for fs in funscripts:
            compute_speed_stats(fs["actions"])
        compute_only = time.perf_counter() - t0
        print(f"  compute only (in-memory): {compute_only*1000:.0f} ms")

        # 3. Sequential read + parse + compute (simulates single-threaded)
        t0 = time.perf_counter()
        for p in paths:
            with open(p, encoding="utf-8") as f:
                fs = json.load(f)
            compute_speed_stats(fs["actions"])
        sequential = time.perf_counter() - t0
        print(f"  sequential read+parse+compute: {sequential*1000:.0f} ms")

        # 4. Thread pool (4 workers — common semaphore size for FS I/O)
        def process(p):
            with open(p, encoding="utf-8") as f:
                fs = json.load(f)
            return compute_speed_stats(fs["actions"])

        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(process, paths))
        parallel_4 = time.perf_counter() - t0
        print(f"  parallel (4 workers): {parallel_4*1000:.0f} ms")

        # 5. Thread pool (8 workers)
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(process, paths))
        parallel_8 = time.perf_counter() - t0
        print(f"  parallel (8 workers): {parallel_8*1000:.0f} ms")


if __name__ == "__main__":
    for n in (1000, 3000, 5000):
        bench(n)
