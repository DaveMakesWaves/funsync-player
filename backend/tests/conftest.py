"""Shared test setup.

The funscript metadata harvest (services/script_meta.py) keeps its cache in a
file next to the real app's metadata cache, in the system temp folder. Any
test that registers a video with a script can run the speed pass, which now
saves that cache. Point it at the test's own temp folder, and forget what an
earlier test stored, so no test writes beside the installed app's caches or
sees another test's records.
"""

import pytest


@pytest.fixture(autouse=True)
def _isolated_script_meta_cache(tmp_path):
    from services import script_meta
    import routes.media as media
    script_meta._reset_for_tests(str(tmp_path / "script-meta-cache-v1.json"))
    media._meta_checked.clear()
    media._meta_inflight.clear()
    yield
    # The path stays on this test's folder (never back to the real temp
    # one): a pass a test started may still be running and save late.
    media._meta_checked.clear()
    media._meta_inflight.clear()
