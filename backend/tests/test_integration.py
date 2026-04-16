"""Integration tests using real test files from the project root."""

import json
import os
import pytest
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport
from main import app
from services.funscript import parse_funscript, funscript_to_csv

# Paths to test files in the project root
PROJECT_ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
TEST_VIDEO = os.path.join(PROJECT_ROOT, "Test.mp4")
TEST_FUNSCRIPT = os.path.join(PROJECT_ROOT, "Test.funscript")


class TestRealFunscript:
    """Tests using the actual Test.funscript file."""

    @pytest.fixture
    def funscript_content(self):
        with open(TEST_FUNSCRIPT, "r") as f:
            return f.read()

    def test_parse_real_funscript(self, funscript_content):
        result = parse_funscript(funscript_content)
        assert result["version"] == "1.0"
        assert result["inverted"] is False
        assert result["range"] == 100
        assert len(result["actions"]) > 100  # Should have many actions

    def test_actions_sorted_by_time(self, funscript_content):
        result = parse_funscript(funscript_content)
        timestamps = [a["at"] for a in result["actions"]]
        assert timestamps == sorted(timestamps)

    def test_all_positions_in_range(self, funscript_content):
        result = parse_funscript(funscript_content)
        for action in result["actions"]:
            assert 0 <= action["pos"] <= 100, f"Position {action['pos']} out of range at {action['at']}ms"

    def test_csv_conversion_size(self, funscript_content):
        result = parse_funscript(funscript_content)
        csv = funscript_to_csv(result["actions"])
        csv_bytes = len(csv.encode("utf-8"))
        # Must be under 512 KiB for Handy
        assert csv_bytes < 512 * 1024, f"CSV too large: {csv_bytes} bytes"

    def test_csv_line_count_matches_actions(self, funscript_content):
        result = parse_funscript(funscript_content)
        csv = funscript_to_csv(result["actions"])
        lines = csv.strip().split("\n")
        assert len(lines) == len(result["actions"])

    def test_csv_format_valid(self, funscript_content):
        result = parse_funscript(funscript_content)
        csv = funscript_to_csv(result["actions"])
        for line in csv.strip().split("\n"):
            parts = line.split(",")
            assert len(parts) == 2, f"Invalid CSV line: {line}"
            ts, pos = int(parts[0]), int(parts[1])
            assert ts >= 0
            assert 0 <= pos <= 100

    def test_funscript_duration(self, funscript_content):
        result = parse_funscript(funscript_content)
        last_action = result["actions"][-1]
        # Test.funscript metadata says duration is 220s (~195s of actions)
        assert last_action["at"] > 100000  # At least 100 seconds of content


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_convert_real_funscript(client):
    """Convert the real Test.funscript through the API."""
    with open(TEST_FUNSCRIPT, "r") as f:
        content = f.read()

    response = await client.post("/scripts/convert", content=content.encode())
    assert response.status_code == 200
    data = response.json()

    assert data["action_count"] > 100
    assert data["duration_ms"] > 100000
    assert data["size_bytes"] < 512 * 1024  # Under Handy limit
    assert data["version"] == "1.0"
    assert data["hash"]
    assert data["local_url"]


@pytest.mark.anyio
async def test_serve_converted_real_funscript(client):
    """Convert then serve the real funscript CSV."""
    with open(TEST_FUNSCRIPT, "r") as f:
        content = f.read()

    # Convert
    convert_resp = await client.post("/scripts/convert", content=content.encode())
    assert convert_resp.status_code == 200
    script_hash = convert_resp.json()["hash"]

    # Serve
    csv_resp = await client.get(f"/scripts/{script_hash}.csv")
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-type"] == "text/csv; charset=utf-8"

    # Validate CSV content
    lines = csv_resp.text.strip().split("\n")
    assert len(lines) > 100
    for line in lines[:5]:
        parts = line.split(",")
        assert len(parts) == 2
