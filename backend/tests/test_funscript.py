"""Tests for funscript parsing and CSV conversion."""

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.funscript import parse_funscript, funscript_to_csv


class TestParseFunscript:
    def test_valid_funscript(self):
        content = '{"version": "1.0", "actions": [{"at": 0, "pos": 50}, {"at": 500, "pos": 100}]}'
        result = parse_funscript(content)
        assert result["version"] == "1.0"
        assert len(result["actions"]) == 2
        assert result["actions"][0]["at"] == 0
        assert result["actions"][1]["pos"] == 100

    def test_sorts_actions_by_timestamp(self):
        content = '{"actions": [{"at": 1000, "pos": 0}, {"at": 0, "pos": 50}, {"at": 500, "pos": 100}]}'
        result = parse_funscript(content)
        timestamps = [a["at"] for a in result["actions"]]
        assert timestamps == [0, 500, 1000]

    def test_defaults_for_missing_optional_fields(self):
        content = '{"actions": [{"at": 0, "pos": 50}]}'
        result = parse_funscript(content)
        assert result["version"] == "1.0"
        assert result["inverted"] is False
        assert result["range"] == 100

    def test_invalid_json_raises(self):
        with pytest.raises(ValueError, match="Invalid JSON"):
            parse_funscript("not json")

    def test_missing_actions_raises(self):
        with pytest.raises(ValueError, match="missing 'actions'"):
            parse_funscript('{"version": "1.0"}')

    def test_actions_not_array_raises(self):
        with pytest.raises(ValueError, match="must be an array"):
            parse_funscript('{"actions": "not an array"}')

    def test_action_missing_at_raises(self):
        with pytest.raises(ValueError, match="missing 'at' or 'pos'"):
            parse_funscript('{"actions": [{"pos": 50}]}')

    def test_action_missing_pos_raises(self):
        with pytest.raises(ValueError, match="missing 'at' or 'pos'"):
            parse_funscript('{"actions": [{"at": 0}]}')


class TestFunscriptToCsv:
    def test_basic_conversion(self):
        actions = [{"at": 0, "pos": 50}, {"at": 500, "pos": 100}, {"at": 1000, "pos": 0}]
        csv = funscript_to_csv(actions)
        assert csv == "0,50\n500,100\n1000,0"

    def test_clamps_position_values(self):
        actions = [{"at": 0, "pos": -10}, {"at": 100, "pos": 150}]
        csv = funscript_to_csv(actions)
        assert csv == "0,0\n100,100"

    def test_empty_actions(self):
        assert funscript_to_csv([]) == ""

    def test_float_values_truncated(self):
        actions = [{"at": 100.7, "pos": 50.9}]
        csv = funscript_to_csv(actions)
        assert csv == "100,50"
