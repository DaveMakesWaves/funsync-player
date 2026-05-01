"""Tests for web remote routes."""

import pytest
from httpx import AsyncClient, ASGITransport

from main import app
from routes.media import (
    register_videos,
    register_collections,
    register_playlists,
    register_categories,
    register_sources,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def setup_registry():
    register_videos([
        {
            "path": "C:\\Videos\\Alpha.mp4",
            "name": "Alpha.mp4",
            "funscriptPath": "C:\\Videos\\Alpha.funscript",
            "subtitlePath": "C:\\Videos\\Alpha.vtt",
            "hasFunscript": True,
            "hasSubtitle": True,
            "duration": 600,
            "sourceName": "VR Drive",
        },
        {
            "path": "C:\\Videos\\Beta.mp4",
            "name": "Beta.mp4",
            "hasFunscript": False,
            "duration": 300,
        },
    ])
    # Reset groupings between tests — shared module state
    register_collections([])
    register_playlists([])
    register_categories([], {})
    register_sources([])


@pytest.mark.anyio
async def test_remote_videos_returns_library(client):
    response = await client.get("/api/remote/videos")
    assert response.status_code == 200
    data = response.json()
    assert "videos" in data
    assert len(data["videos"]) == 2


@pytest.mark.anyio
async def test_remote_videos_is_sorted(client):
    response = await client.get("/api/remote/videos")
    names = [v["name"] for v in response.json()["videos"]]
    assert names == sorted(names, key=lambda s: s.lower())


@pytest.mark.anyio
async def test_remote_video_has_expected_fields(client):
    response = await client.get("/api/remote/videos")
    first = response.json()["videos"][0]
    for field in ("id", "name", "hasFunscript", "duration", "streamUrl", "thumbUrl", "sourceName"):
        assert field in first


@pytest.mark.anyio
async def test_remote_video_script_url_only_when_funscript_present(client):
    response = await client.get("/api/remote/videos")
    videos = response.json()["videos"]
    by_name = {v["name"]: v for v in videos}
    assert by_name["Alpha"]["scriptUrl"] is not None
    assert by_name["Alpha"]["scriptUrl"].endswith(by_name["Alpha"]["id"])
    assert by_name["Beta"]["scriptUrl"] is None


@pytest.mark.anyio
async def test_remote_video_variants_default_empty(client):
    """Single-variant or no-variant videos surface an empty `variants`
    list — the phone uses that to decide whether to render the variant
    chip (Nielsen #8: chip not rendered when there's nothing to choose)."""
    response = await client.get("/api/remote/videos")
    videos = response.json()["videos"]
    for v in videos:
        assert v["variants"] == []


@pytest.mark.anyio
async def test_remote_video_variants_surface_when_present(client):
    """Multi-variant videos surface each variant with `label` + `scriptUrl`.
    The desktop's scan populates `variants` on each video; the remote API
    just projects them through with a fetchable URL per variant."""
    register_videos([
        {
            "path": "C:\\Videos\\Multi.mp4",
            "name": "Multi.mp4",
            "funscriptPath": "C:\\Videos\\Multi.funscript",
            "hasFunscript": True,
            "variants": [
                {"label": "Default", "path": "C:\\Videos\\Multi.funscript", "name": "Multi.funscript"},
                {"label": "Soft",    "path": "C:\\Videos\\Multi (Soft).funscript", "name": "Multi (Soft).funscript"},
                {"label": "Intense", "path": "C:\\Videos\\Multi (Intense).funscript", "name": "Multi (Intense).funscript"},
            ],
            "duration": 600,
        },
    ])
    response = await client.get("/api/remote/videos")
    videos = response.json()["videos"]
    assert len(videos) == 1
    multi = videos[0]
    labels = [v["label"] for v in multi["variants"]]
    assert labels == ["Default", "Soft", "Intense"]
    for entry in multi["variants"]:
        assert entry["scriptUrl"].startswith(f"/api/media/script/{multi['id']}")
        assert f"variant={entry['label']}" in entry["scriptUrl"]


@pytest.mark.anyio
async def test_remote_video_strips_extension_from_name(client):
    response = await client.get("/api/remote/videos")
    names = [v["name"] for v in response.json()["videos"]]
    assert "Alpha" in names
    assert "Alpha.mp4" not in names


@pytest.mark.anyio
async def test_remote_video_urls_are_relative(client):
    """Relative URLs let the phone resolve against its own origin —
    works regardless of whether user reached the backend via LAN IP,
    mDNS, or a reverse proxy."""
    response = await client.get("/api/remote/videos")
    for v in response.json()["videos"]:
        assert v["streamUrl"].startswith("/api/media/stream/")
        assert v["thumbUrl"].startswith("/api/media/thumb/")


# --- Collections / Playlists / Categories (view-only for the phone) ------

@pytest.mark.anyio
async def test_empty_groupings_return_empty_lists(client):
    """With nothing registered, all three endpoints respond 200 with empty."""
    for path, key in [
        ("/api/remote/collections", "collections"),
        ("/api/remote/playlists", "playlists"),
        ("/api/remote/categories", "categories"),
    ]:
        resp = await client.get(path)
        assert resp.status_code == 200
        assert resp.json() == {key: []}


@pytest.mark.anyio
async def test_collections_converts_paths_to_video_ids(client):
    register_collections([
        {"id": "c1", "name": "Favourites", "videoPaths": ["C:\\Videos\\Alpha.mp4"]},
        {"id": "c2", "name": "Empty",       "videoPaths": []},
    ])
    resp = await client.get("/api/remote/collections")
    cols = resp.json()["collections"]
    # Sort-by-name puts Empty before Favourites
    assert [c["name"] for c in cols] == ["Empty", "Favourites"]
    fav = next(c for c in cols if c["name"] == "Favourites")
    assert fav["videoCount"] == 1
    assert len(fav["videoIds"]) == 1
    # videoIds must match the registry — client can GET /api/remote/videos
    # and cross-reference without knowing about paths
    videos_resp = await client.get("/api/remote/videos")
    alpha_id = next(v["id"] for v in videos_resp.json()["videos"] if v["name"] == "Alpha")
    assert fav["videoIds"] == [alpha_id]


@pytest.mark.anyio
async def test_collections_drops_unregistered_paths(client):
    """Paths pointing at files the backend doesn't know about (disconnected
    source, deleted file) are silently skipped — matches desktop behaviour."""
    register_collections([
        {"id": "c1", "name": "Mixed", "videoPaths": [
            "C:\\Videos\\Alpha.mp4",
            "C:\\Videos\\Missing.mp4",
            "C:\\Videos\\AlsoMissing.mp4",
        ]},
    ])
    resp = await client.get("/api/remote/collections")
    col = resp.json()["collections"][0]
    assert col["videoCount"] == 1  # only Alpha survives


@pytest.mark.anyio
async def test_playlists_payload_shape(client):
    register_playlists([
        {"id": "p1", "name": "Bangers", "videoPaths": ["C:\\Videos\\Alpha.mp4", "C:\\Videos\\Beta.mp4"], "createdAt": 1000},
    ])
    resp = await client.get("/api/remote/playlists")
    pl = resp.json()["playlists"][0]
    assert pl["id"] == "p1"
    assert pl["name"] == "Bangers"
    assert pl["videoCount"] == 2
    assert pl["createdAt"] == 1000
    assert len(pl["videoIds"]) == 2


@pytest.mark.anyio
async def test_groupings_carry_total_duration(client):
    """Mobile shows total runtime per grouping — the backend sums
    durations from the registered videos so the phone can render "3h 42m"
    without having to resolve each videoId itself."""
    register_collections([
        {"id": "c1", "name": "All",   "videoPaths": ["C:\\Videos\\Alpha.mp4", "C:\\Videos\\Beta.mp4"]},
        {"id": "c2", "name": "Empty", "videoPaths": []},
    ])
    register_playlists([
        {"id": "p1", "name": "Alpha only", "videoPaths": ["C:\\Videos\\Alpha.mp4"], "createdAt": 1},
    ])
    register_categories(
        [{"id": "cat1", "name": "Cat", "color": "#fff"}],
        {"C:\\Videos\\Alpha.mp4": ["cat1"], "C:\\Videos\\Beta.mp4": ["cat1"]},
    )

    # Alpha duration=600, Beta=300 (per setup_registry fixture)
    cols = (await client.get("/api/remote/collections")).json()["collections"]
    by_name = {c["name"]: c for c in cols}
    assert by_name["All"]["totalDuration"] == 900
    assert by_name["Empty"]["totalDuration"] == 0

    pls = (await client.get("/api/remote/playlists")).json()["playlists"]
    assert pls[0]["totalDuration"] == 600

    cats = (await client.get("/api/remote/categories")).json()["categories"]
    assert cats[0]["totalDuration"] == 900


@pytest.mark.anyio
async def test_video_payload_includes_path_for_folder_browse(client):
    """The phone's folder-browse tree walker needs the absolute path per
    video. Without it the tree can't figure out which source a video
    belongs to, and subfolder nesting collapses to a flat list."""
    resp = await client.get("/api/remote/videos")
    for v in resp.json()["videos"]:
        assert "path" in v
        assert v["path"]  # non-empty


@pytest.mark.anyio
async def test_sources_endpoint_returns_registered_sources(client):
    register_sources([
        {"id": "s1", "name": "VR Drive", "path": "D:\\VR",      "enabled": True},
        {"id": "s2", "name": "Downloads", "path": "C:\\Users\\x\\Downloads"},
        {"id": "s3", "name": "Disabled",  "path": "E:\\hidden", "enabled": False},
    ])
    resp = await client.get("/api/remote/sources")
    assert resp.status_code == 200
    names = [s["name"] for s in resp.json()["sources"]]
    # Disabled source is filtered out server-side
    assert "Disabled" not in names
    assert set(names) == {"Downloads", "VR Drive"}
    # Response is sorted by name
    assert names == sorted(names)


@pytest.mark.anyio
async def test_sources_drops_entries_without_a_path(client):
    register_sources([
        {"id": "s1", "name": "Good", "path": "D:\\stuff"},
        {"id": "s2", "name": "Pathless"},  # no path key
        {"id": "s3", "name": "Empty path", "path": ""},
    ])
    resp = await client.get("/api/remote/sources")
    names = [s["name"] for s in resp.json()["sources"]]
    assert names == ["Good"]


@pytest.mark.anyio
async def test_video_includes_speed_fields(client):
    """avgSpeed + maxSpeed ride along in the video payload. Values are null
    when the background probe hasn't run yet; the phone treats null as
    'keep polling'."""
    resp = await client.get("/api/remote/videos")
    for v in resp.json()["videos"]:
        assert "avgSpeed" in v
        assert "maxSpeed" in v


@pytest.mark.anyio
async def test_compute_speed_stats_port_matches_desktop():
    """Lock the Python port of computeSpeedStats to the same outputs
    renderer/js/library-search.js produces so desktop + mobile agree on
    which speed band a video sits in."""
    from routes.media import _compute_speed_stats
    # Steady 100 → 0 → 100 every 500ms: 100 units / 500 ms = 200 units/s
    actions = [
        {"at": 0,    "pos": 0},
        {"at": 500,  "pos": 100},
        {"at": 1000, "pos": 0},
        {"at": 1500, "pos": 100},
    ]
    stats = _compute_speed_stats(actions)
    assert stats == {"avgSpeed": 200, "maxSpeed": 200}

    # Empty / too short → zeros
    assert _compute_speed_stats([]) == {"avgSpeed": 0, "maxSpeed": 0}
    assert _compute_speed_stats([{"at": 0, "pos": 0}]) == {"avgSpeed": 0, "maxSpeed": 0}

    # Zero-movement pairs are excluded (matches desktop)
    actions_with_hold = [
        {"at": 0,    "pos": 0},
        {"at": 500,  "pos": 100},
        {"at": 1000, "pos": 100},  # hold — ignored
        {"at": 1500, "pos": 0},
    ]
    stats = _compute_speed_stats(actions_with_hold)
    # Two movement pairs both 200 units/s; avg and max both 200
    assert stats["avgSpeed"] == 200
    assert stats["maxSpeed"] == 200


@pytest.mark.anyio
async def test_total_duration_ignores_videos_with_unknown_length(client):
    """Videos not yet probed by ffprobe have duration=0 (or missing).
    Summing them shouldn't raise — missing durations just don't contribute."""
    # Replace registry with one video missing the duration field entirely
    register_videos([
        {"path": "C:\\Videos\\Alpha.mp4", "name": "Alpha.mp4", "duration": 120},
        {"path": "C:\\Videos\\Unknown.mp4", "name": "Unknown.mp4"},  # no duration key
    ])
    register_collections([
        {"id": "c1", "name": "Mix", "videoPaths": ["C:\\Videos\\Alpha.mp4", "C:\\Videos\\Unknown.mp4"]},
    ])
    resp = await client.get("/api/remote/collections")
    col = resp.json()["collections"][0]
    assert col["totalDuration"] == 120  # Unknown contributes 0
    assert col["videoCount"] == 2       # still counted in the card


@pytest.mark.anyio
async def test_categories_inverts_video_category_map(client):
    """Categories in settings are stored as a map videoPath → [categoryId].
    The endpoint inverts this so each category carries its video IDs."""
    register_categories(
        [{"id": "cat1", "name": "JAV", "color": "#ff5c74"},
         {"id": "cat2", "name": "Anim", "color": "#82b4ff"}],
        {
            "C:\\Videos\\Alpha.mp4": ["cat1", "cat2"],
            "C:\\Videos\\Beta.mp4": ["cat2"],
        },
    )
    resp = await client.get("/api/remote/categories")
    cats = {c["name"]: c for c in resp.json()["categories"]}
    assert cats["JAV"]["videoCount"] == 1
    assert cats["JAV"]["color"] == "#ff5c74"
    assert cats["Anim"]["videoCount"] == 2


@pytest.mark.anyio
async def test_categories_default_color_when_missing(client):
    register_categories(
        [{"id": "cat1", "name": "Uncoloured"}],  # no `color` field
        {},
    )
    resp = await client.get("/api/remote/categories")
    assert resp.json()["categories"][0]["color"] == "#888"


@pytest.mark.anyio
async def test_register_endpoint_accepts_all_groupings(client):
    """The Electron renderer posts everything in one /register call —
    make sure the endpoint propagates each field to its own registry."""
    resp = await client.post("/api/media/register", json={
        "videos": [
            {"path": "C:\\Videos\\Alpha.mp4", "name": "Alpha.mp4", "duration": 1},
        ],
        "collections": [{"id": "c1", "name": "Col", "videoPaths": []}],
        "playlists": [{"id": "p1", "name": "Pl", "videoPaths": []}],
        "categories": [{"id": "cat1", "name": "Cat", "color": "#fff"}],
        "videoCategories": {"C:\\Videos\\Alpha.mp4": ["cat1"]},
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["collections"] == 1
    assert body["playlists"] == 1
    assert body["categories"] == 1


@pytest.mark.anyio
async def test_register_endpoint_backward_compatible(client):
    """Posting just {videos: [...]} (the v1 shape) still works — missing
    keys leave groupings untouched rather than clearing them."""
    register_collections([{"id": "c1", "name": "X", "videoPaths": []}])
    resp = await client.post("/api/media/register", json={
        "videos": [{"path": "C:\\Videos\\Alpha.mp4", "name": "Alpha.mp4"}],
    })
    assert resp.status_code == 200
    # Collections still present — not clobbered by the minimal register
    cols_resp = await client.get("/api/remote/collections")
    assert len(cols_resp.json()["collections"]) == 1
