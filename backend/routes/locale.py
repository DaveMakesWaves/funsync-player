"""Locale endpoint for web-remote i18n.

The web remote (served at /remote/) needs to know which locale the
desktop is currently using so it can render the same language without
asking the user. The canonical store lives in electron-conf's
`config.json` written by the main process. The backend reads that file
on each request — cheap (file is small), avoids in-memory staleness
when the user switches language on the desktop.

Falls back to 'en' on any read error so the web remote always boots
even if config.json is missing (fresh install before any locale was
written), unreadable (locked / permission), or malformed.
"""

import json
import os
from fastapi import APIRouter

router = APIRouter()

# Set once at backend startup by main.py from the --user-data-dir argv.
# None until that wiring runs — the endpoint handles that case too.
_user_data_dir: str | None = None


def set_user_data_dir(path: str | None) -> None:
    """Called from main.py at startup with the value of --user-data-dir."""
    global _user_data_dir
    _user_data_dir = path


@router.get("/locale")
async def get_locale():
    """Return the locale the desktop is currently using.

    Shape: ``{"locale": "<code>"}`` where code is one of the supported
    languages (en/zh/ja/ko/de/es/fr/ru). Always returns 200; never
    raises. The web-remote treats any failure as 'en'.
    """
    if not _user_data_dir:
        return {"locale": "en"}
    config_path = os.path.join(_user_data_dir, "config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        locale = (
            data.get("settings", {})
            .get("player", {})
            .get("language")
        )
        # Whitelist a sensible shape. Don't validate against the
        # supported-locales set here — the web-remote's i18n module
        # already falls back to English for any unknown bundle. Keeping
        # this lenient also means adding a new locale doesn't require
        # a backend code change.
        if isinstance(locale, str) and 2 <= len(locale) <= 8:
            return {"locale": locale}
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return {"locale": "en"}
