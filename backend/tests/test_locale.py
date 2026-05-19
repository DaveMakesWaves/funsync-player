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
    assert res.json() == {"locale": "en"}


@pytest.mark.anyio
async def test_returns_en_when_config_json_missing(client, tmp_user_data):
    # tmp dir exists but is empty — no config.json.
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en"}


@pytest.mark.anyio
async def test_returns_en_when_config_json_malformed(client, tmp_user_data):
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        f.write("{ not json")
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en"}


@pytest.mark.anyio
async def test_returns_locale_from_config(client, tmp_user_data):
    config = {"settings": {"player": {"language": "zh"}}}
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f)
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "zh"}


@pytest.mark.anyio
async def test_returns_en_when_language_field_missing(client, tmp_user_data):
    # Settings present but no language field at all.
    config = {"settings": {"player": {"speedLimit": 0}}}
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f)
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en"}


@pytest.mark.anyio
async def test_returns_en_when_language_field_wrong_type(client, tmp_user_data):
    # Defensive: someone hand-edited config to put a number in language.
    config = {"settings": {"player": {"language": 42}}}
    with open(os.path.join(tmp_user_data, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f)
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/locale")
    assert res.status_code == 200
    assert res.json() == {"locale": "en"}
