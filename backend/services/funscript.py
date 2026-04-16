"""Funscript parsing and CSV conversion service."""

import json
from typing import Any


def parse_funscript(content: str) -> dict[str, Any]:
    """Parse a .funscript JSON file and return structured data.

    Args:
        content: Raw JSON string from .funscript file.

    Returns:
        Dict with keys: version, inverted, range, actions.
        Each action has 'at' (ms) and 'pos' (0-100).

    Raises:
        ValueError: If the funscript is invalid or missing required fields.
    """
    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in funscript: {e}")

    if "actions" not in data:
        raise ValueError("Funscript missing 'actions' array")

    actions = data["actions"]
    if not isinstance(actions, list):
        raise ValueError("Funscript 'actions' must be an array")

    for i, action in enumerate(actions):
        if "at" not in action or "pos" not in action:
            raise ValueError(f"Action at index {i} missing 'at' or 'pos'")
        if not isinstance(action["at"], (int, float)):
            raise ValueError(f"Action at index {i}: 'at' must be a number")
        if not isinstance(action["pos"], (int, float)):
            raise ValueError(f"Action at index {i}: 'pos' must be a number")

    # Sort actions by timestamp
    actions.sort(key=lambda a: a["at"])

    return {
        "version": data.get("version", "1.0"),
        "inverted": data.get("inverted", False),
        "range": data.get("range", 100),
        "actions": actions,
    }


def funscript_to_csv(actions: list[dict]) -> str:
    """Convert funscript actions to CSV format for the Handy device.

    Args:
        actions: List of dicts with 'at' (ms) and 'pos' (0-100).

    Returns:
        CSV string with lines of "timestamp_ms,position".
    """
    lines = []
    for action in actions:
        at = int(action["at"])
        pos = max(0, min(100, int(action["pos"])))
        lines.append(f"{at},{pos}")
    return "\n".join(lines)
