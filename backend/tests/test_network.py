"""Tests for network utilities."""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.network import get_local_ip


class TestGetLocalIp:
    def test_returns_string(self):
        ip = get_local_ip()
        assert isinstance(ip, str)

    def test_returns_valid_ip_format(self):
        ip = get_local_ip()
        parts = ip.split(".")
        assert len(parts) == 4
        for part in parts:
            assert 0 <= int(part) <= 255

    def test_returns_non_empty(self):
        ip = get_local_ip()
        assert len(ip) > 0
