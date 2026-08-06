"""Tests for /api/remote/locale — the web-remote locale endpoint.

Covers the four shapes:
  - userDataDir not configured -> 'en'
  - config.json missing         -> 'en'
  - config.json malformed       -> 'en'
  - config.json valid           -> reflects settings.player.language
"""

import json
import os
import tempfile

import pytest
from httpx import AsyncClient, ASGITransport

from main import app
from routes.locale import set_user_data_dir


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def tmp_user_data():
    with tempfile.TemporaryDirectory() as td:
        yield td


@pytest.fixture(autouse=True)
def reset_user_data_dir():
    # Ensure each test starts from a known state.
    set_user_data_dir(None)
    yield
    set_user_data_dir(None)


@pytest.mark.anyio
async def test_returns_en_when_user_data_dir_not_set(client):
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en", "theme": "dark"}


@pytest.mark.anyio
async def test_returns_en_when_config_json_missing(client, tmp_user_data):
    # tmp dir exists but is empty — no config.json.
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en", "theme": "dark"}


@pytest.mark.anyio
async def test_returns_en_when_config_json_malformed(client, tmp_user_data):
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        f.write("{ not json")
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en", "theme": "dark"}


@pytest.mark.anyio
async def test_returns_locale_from_config(client, tmp_user_data):
    config = {"settings": {"player": {"language": "zh"}}}
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f)
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "zh", "theme": "dark"}


@pytest.mark.anyio
async def test_returns_en_when_language_field_missing(client, tmp_user_data):
    # Settings present but no language field at all.
    config = {"settings": {"player": {"speedLimit": 0}}}
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f)
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en", "theme": "dark"}


@pytest.mark.anyio
async def test_returns_en_when_language_field_wrong_type(client, tmp_user_data):
    # Defensive: someone hand-edited config to put a number in language.
    config = {"settings": {"player": {"language": 42}}}
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f)
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en", "theme": "dark"}


@pytest.mark.anyio
async def test_returns_saved_theme(client, tmp_user_data):
    """Theme mirroring (SCOPE-web-remote-2.md F5): the endpoint carries the
    desktop's saved theme; invalid values fall back to dark."""
    import json as _json, os as _os
    cfg = _os.path.join(tmp_user_data, "config.json")
    with open(cfg, "w", encoding="utf-8") as f:
        f.write(_json.dumps({"settings": {"player": {"language": "de", "theme": "light"}}}))
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.json() == {"locale": "de", "theme": "light"}

    with open(cfg, "w", encoding="utf-8") as f:
        f.write(_json.dumps({"settings": {"player": {"theme": "neon"}}}))
    res = await client.get("/api/remote/locale")
    assert res.json()["theme"] == "dark"
