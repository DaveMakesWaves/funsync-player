"""The backend must stay answerable while it is busy.

INCIDENT, 2026-08-09 14:25 (Dave's own logs, and the cause of 4wen's
"Can someone explain to me this new backend thing?" report):

    14:25:20.664  last successful GET /health
    14:25:35.131  [Library] Result: 1466 videos, 2318 total fs (17109ms)
    14:25:43.205  health state -> down ("no /health response in 2 attempts")
    14:25:46.475  POST /api/media/register  200 OK
    14:25:46.509  GET /health 200 OK          <-- 34 ms after register returned
    14:25:46.511  health state -> running

A 25.8 second /health blackout that ended the instant library
registration finished. The backend was never dead. It was doing exactly
the work the user had just asked for, on the asyncio event loop, and the
desktop's health monitor cannot tell "busy" from "dead" -- so it put up a
red "Backend is not responding" banner in the middle of a successful
scan.

Two causes, one test file:

  1. `register_library` was an `async def` that called straight into
     synchronous filesystem/CPU work. Nothing else could be served for
     the whole call.
  2. `_queue_duration_probes` spawned ONE OS THREAD PER VIDEO -- 1466 of
     them -- each immediately parking on a Semaphore(2). Cheap to create,
     but they contend for the GIL for the entire probe pass.

The rule these tests defend: NO REQUEST HANDLER MAY MONOPOLISE THE EVENT
LOOP. A slow endpoint is fine; an unanswerable server is not.
"""

import asyncio
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import ASGITransport, AsyncClient  # noqa: E402

from main import app  # noqa: E402
from routes import media  # noqa: E402

# Captured before the autouse fixture below can stub them out, so the
# thread-pool tests exercise the real thing rather than the no-op.
_REAL_QUEUE_DURATION_PROBES = media._queue_duration_probes


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _library(n):
    """A registration payload shaped like a real scan of `n` videos."""
    return {
        "videos": [
            {"path": f"C:\\videos\\clip{i}.mp4", "name": f"clip{i}.mp4", "duration": 0}
            for i in range(n)
        ]
    }


@pytest.fixture(autouse=True)
def _no_real_probes(monkeypatch):
    """Neutralise the background passes.

    They spawn threads that outlive the test and would run ffprobe against
    paths that do not exist. What is under test here is the event loop, not
    ffprobe.
    """
    monkeypatch.setattr(media, "_queue_duration_probes", lambda: None)
    monkeypatch.setattr(media, "_queue_speed_probes", lambda: None)


@pytest.mark.anyio
async def test_health_answers_while_a_large_registration_is_in_flight(client):
    """The regression test for the 25.8 second blackout.

    A registration that takes real wall-clock time must not stop /health
    responding. Before the fix this timed out: `register_library` held the
    loop for the whole call and the concurrent /health never got scheduled.
    """
    slow_calls = []
    real_register = media.register_videos

    def slow_register(videos):
        # Stands in for the seconds of synchronous work a full library does.
        slow_calls.append(len(videos))
        time.sleep(2.0)
        return real_register(videos)

    media.register_videos = slow_register
    try:
        register = asyncio.create_task(
            client.post("/api/media/register", json=_library(50))
        )
        # Measure WALL-CLOCK FROM THE START OF THE SCAN to /health being
        # answered. Two more obvious metrics both fail to discriminate:
        #   * /health's own latency -- a blocked loop just runs the whole
        #     registration first, so the stopwatch starts afterwards and
        #     /health looks instant either way.
        #   * which task completes first -- httpx's own async overhead
        #     gets /health to the handler before the blocking call starts.
        # Total elapsed is the honest measure: blocked, nothing can come
        # back until the 2 s call returns.
        started = time.perf_counter()
        await asyncio.sleep(0.2)  # let the registration reach the slow work
        health = await client.get("/health")
        elapsed = time.perf_counter() - started

        assert health.status_code == 200
        assert health.json() == {"status": "ok"}
        assert elapsed < 1.0, (
            f"/health came back {elapsed:.2f}s after the scan began; the 2 s "
            f"registration was holding the event loop for its whole run"
        )

        result = await register
        assert result.status_code == 200
        assert slow_calls == [50], "the slow path really did run"
    finally:
        media.register_videos = real_register


@pytest.mark.anyio
async def test_registration_still_returns_the_counts(client):
    """The threadpool hop must not change the response contract."""
    r = await client.post("/api/media/register", json=_library(3))
    assert r.status_code == 200
    body = r.json()
    assert body["registered"] == 3
    assert set(body) == {"registered", "collections", "playlists", "categories"}


@pytest.mark.anyio
async def test_partial_payloads_still_leave_other_slices_untouched(client):
    """Every key independent -- the documented contract of this endpoint."""
    await client.post("/api/media/register", json=_library(4))
    r = await client.post("/api/media/register", json={"playlists": []})
    assert r.status_code == 200
    # videos were NOT in the second payload, so they survive it
    assert r.json()["registered"] == 4


def test_the_registry_is_never_observable_half_built(monkeypatch):
    """Moving registration off the event loop introduced a new hazard.

    In-place rebuilding (`clear()` then refill) was safe only because
    nothing else could be served during the call. Now that other requests
    genuinely overlap it, a half-filled registry would 404 videos that are
    perfectly fine. A reader must see the whole old registry or the whole
    new one, never a snapshot in between.
    """
    media.register_videos([{"path": f"C:\\old{i}.mp4"} for i in range(50)])
    assert len(media.get_video_registry()) == 50

    seen = []
    real_path_to_id = media._path_to_id

    def spy(path):
        # Sampled once per video WHILE the new registry is being built.
        seen.append(len(media.get_video_registry()))
        return real_path_to_id(path)

    monkeypatch.setattr(media, "_path_to_id", spy)
    media.register_videos([{"path": f"C:\\new{i}.mp4"} for i in range(30)])

    assert seen, "the spy never ran, the test proves nothing"
    assert set(seen) == {50}, (
        f"registry was observable mid-rebuild at sizes {sorted(set(seen))}; "
        f"a concurrent /stream or /thumbnail would have 404'd"
    )
    assert len(media.get_video_registry()) == 30

    media._video_registry.clear()


def test_duration_probes_use_a_bounded_pool_not_one_thread_per_video(monkeypatch):
    """1466 videos must not mean 1466 threads.

    The Semaphore(2) already capped real ffprobe concurrency at two, so
    every thread beyond the second was pure GIL contention.
    """
    spawned = []

    class _CountingThread(threading.Thread):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            spawned.append(self)

        def start(self):  # never actually run ffprobe
            pass

    monkeypatch.setattr(threading, "Thread", _CountingThread)

    media._video_registry.clear()
    media._duration_probing.clear()
    for i in range(500):
        media._video_registry[f"id{i}"] = {
            "path": f"C:\\videos\\clip{i}.mp4",
            "duration": 0,
        }

    _REAL_QUEUE_DURATION_PROBES()

    assert len(spawned) == media.DURATION_PROBE_WORKERS, (
        f"spawned {len(spawned)} threads for 500 videos; expected "
        f"{media.DURATION_PROBE_WORKERS}"
    )
    media._video_registry.clear()
    media._duration_probing.clear()


def test_duration_workers_drain_every_pending_item():
    """Bounding the pool must not silently drop work."""
    probed = []
    pending = [(f"id{i}", f"C:\\videos\\clip{i}.mp4") for i in range(200)]

    original = media._probe_duration
    media._probe_duration = lambda vid, path: probed.append(vid)
    try:
        workers = [
            threading.Thread(target=media._duration_probe_worker, args=(pending,))
            for _ in range(media.DURATION_PROBE_WORKERS)
        ]
        for w in workers:
            w.start()
        for w in workers:
            w.join(timeout=10)
    finally:
        media._probe_duration = original

    assert len(probed) == 200
    assert len(set(probed)) == 200, "an item was handed to two workers"
    assert pending == [], "the queue was not drained"


def test_speed_probe_worker_yields_the_gil():
    """The pass must contain scheduling points.

    json.load holds the GIL for the whole parse; 2318 of them back to back
    starves the loop. Without a yield the event loop thread can wait many
    seconds for a slot, which is how a 3 s probe deadline gets missed.
    """
    sleeps = []
    import time as time_mod

    real_sleep = time_mod.sleep
    time_mod.sleep = lambda s: (sleeps.append(s), real_sleep(0))[1]
    try:
        # Paths do not exist -> each iteration takes the `continue` branch,
        # which is enough to prove the yield is on the loop itself and not
        # buried inside the success path.
        media._speed_probe_worker(
            [(f"id{i}", f"C:\\nope\\{i}.funscript") for i in range(100)]
        )
    finally:
        time_mod.sleep = real_sleep

    assert sleeps, "the speed probe never yields the GIL"
    assert all(s > 0 for s in sleeps), "sleep(0) does not hand the GIL over"
