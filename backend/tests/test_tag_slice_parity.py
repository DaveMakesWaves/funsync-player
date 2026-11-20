"""The phone's leg of the desktop/phone tag parity (r3-fixup R3R-2, 2026-11-18).

tests/fixtures/tag-slice-parity.json holds the slice the desktop's REAL
merge sends for a small library (tests/unit/tag-slice-parity.test.js checks
it is current, and that the desktop filter over its index and the phone
filter over `phoneVideoTags` agree on every query). Here that slice goes
through the REAL /api/media/register (register_tags: shape checks, the
per-video cap, the key limit) and /api/remote/tags must serve the phone
exactly `phoneVideoTags`: nothing the desktop filters on is dropped on the
way. Before the fix the backend kept 500 tags per video and cut the creator,
the last tag in facet order, which the desktop still matched.

Synthetic paths only; nothing is read from disk but the fixture.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport  # noqa: E402
from main import app  # noqa: E402
import routes.media as media  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "tag-slice-parity.json")
with open(FIXTURE, encoding="utf-8") as _f:
    DATA = json.load(_f)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:5123") as c:
        yield c


@pytest.mark.anyio
async def test_the_phone_is_served_exactly_what_the_desktop_filters(client):
    videos = [{"path": v["path"], "name": os.path.basename(v["path"])} for v in DATA["input"]["videos"]]
    assert (await client.post("/api/media/register", json={"videos": videos})).status_code == 200
    assert (await client.post("/api/media/register", json={"videoTags": DATA["slice"]})).status_code == 200
    body = (await client.get("/api/remote/tags")).json()
    assert body["videoTags"] == DATA["phoneVideoTags"]
    # The catalog's labels are the desktop's (one form per key).
    labels = {t["key"]: t["label"] for tags in DATA["slice"].values() for t in tags}
    assert {t["key"]: t["label"] for t in body["tags"]} == labels


def test_register_tags_keeps_the_slice_as_the_desktop_built_it():
    media.register_tags(DATA["slice"])
    assert media.get_video_tags() == DATA["slice"]


def test_over_the_cap_the_names_go_last_not_first():
    """A client sending more than MAX_TAGS_PER_VIDEO (never the desktop: its
    index applies the same cap) loses tags from the end of the facet order,
    the names kept."""
    path = "C:/Sandbox/Library/Junk.mp4"
    tags = [{"key": f"content:t{i}", "facet": "content", "label": f"t{i}"} for i in range(media.MAX_TAGS_PER_VIDEO + 50)]
    tags += [{"key": "creator:zed", "facet": "creator", "label": "Zed"},
             {"key": "performer:jane", "facet": "performer", "label": "Jane"}]
    media.register_tags({path: tags})
    kept = [t["key"] for t in media.get_video_tags()[path]]
    assert len(kept) == media.MAX_TAGS_PER_VIDEO
    assert kept[-2:] == ["creator:zed", "performer:jane"]
    assert kept[0] == "content:t0"
