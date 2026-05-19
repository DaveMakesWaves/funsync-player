"""FunSync Player — Python Backend (FastAPI)"""

import argparse
import os
import sys
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routes.scripts import router as scripts_router
from routes.thumbnails import router as thumbnails_router
from routes.metadata import router as metadata_router
from routes.media import router as media_router
from routes.vr_api import router as vr_api_router
from routes.remote import router as remote_router
from routes.remote_sync import router as remote_sync_router
from routes.locale import router as locale_router, set_user_data_dir

app = FastAPI(title="FunSync Backend", version="0.1.0")

# Allow Electron renderer to call the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scripts_router, prefix="/scripts", tags=["scripts"])
app.include_router(thumbnails_router, prefix="/thumbnails", tags=["thumbnails"])
app.include_router(metadata_router, prefix="/metadata", tags=["metadata"])
app.include_router(media_router, prefix="/api/media", tags=["media"])
app.include_router(vr_api_router, tags=["vr"])
app.include_router(remote_router, prefix="/api/remote", tags=["remote"])
app.include_router(remote_sync_router, prefix="/api/remote", tags=["remote-sync"])
app.include_router(locale_router, prefix="/api/remote", tags=["locale"])

# Web remote SPA served at /remote/ — static files live in backend/web-remote/.
# Resolve relative to this file so it works both in dev (python main.py) and
# packaged (PyInstaller rewrites __file__ to the temp bundle root).
_remote_base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
_remote_dir = os.path.join(_remote_base, "web-remote")
if os.path.isdir(_remote_dir):
    app.mount("/remote", StaticFiles(directory=_remote_dir, html=True), name="web-remote")

# Locale bundles for the web-remote i18n module. In packaged builds
# PyInstaller's spec ships renderer/locales/ as <_MEIPASS>/locales/.
# In dev they live at <project>/renderer/locales/ (two dirs up from
# backend/main.py). Web-remote fetches `/locales/<lang>.json` at boot.
def _resolve_locales_dir() -> str | None:
    candidates = []
    if hasattr(sys, "_MEIPASS"):
        candidates.append(os.path.join(sys._MEIPASS, "locales"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.abspath(os.path.join(here, "..", "renderer", "locales")))
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None

_locales_dir = _resolve_locales_dir()
if _locales_dir:
    app.mount("/locales", StaticFiles(directory=_locales_dir), name="locales")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def root():
    """Root URL — simple text so DeoVR's auto-discovery requests /deovr instead.

    DeoVR only enters 'Json mode' when the URL path contains '/deovr'.
    Returning JSON here would cause DeoVR to display raw text.
    """
    return {"status": "FunSync VR Server", "deovr": "/deovr", "heresphere": "/heresphere"}


@app.get("/network-info")
async def network_info():
    """Return the local network IP for VR server URL display."""
    from services.network import get_local_ip
    return {"ip": get_local_ip()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5123)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    # Path to electron-conf's userData dir (contains config.json). Used
    # by the web-remote locale endpoint to mirror the desktop's chosen
    # language. Optional — endpoint falls back to 'en' if not provided.
    parser.add_argument("--user-data-dir", type=str, default=None)
    args = parser.parse_args()

    if args.user_data_dir:
        set_user_data_dir(args.user_data_dir)

    uvicorn.run(app, host=args.host, port=args.port)
