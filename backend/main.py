"""FunSync Player — Python Backend (FastAPI)"""

import argparse
import os
import sys
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routes.scripts import router as scripts_router
from routes.thumbnails import router as thumbnails_router
from routes.metadata import router as metadata_router
from routes.media import router as media_router, set_thumb_cache_dir
from routes.vr_api import router as vr_api_router
from routes.remote import router as remote_router
from routes.remote_sync import router as remote_sync_router
from routes.locale import router as locale_router, set_user_data_dir
from routes.downloads import router as downloads_router

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
app.include_router(downloads_router, prefix="/api/downloads", tags=["downloads"])

# Web remote SPA served at /remote/ — static files live in backend/web-remote/.
# Resolve relative to this file so it works both in dev (python main.py) and
# packaged (PyInstaller rewrites __file__ to the temp bundle root).
_remote_base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
_remote_dir = os.path.join(_remote_base, "web-remote")
if os.path.isdir(_remote_dir):
    app.mount("/remote", StaticFiles(directory=_remote_dir, html=True), name="web-remote")


# Stale-asset guard for the web remote (2026-08-04): after an app update the
# phone would mix cached index.html/style.css with freshly-fetched app.js —
# broken hybrid UI until a manual reload (bit Dave live on the 0.9 remote
# rework; versioned URLs wouldn't fully fix it because app.js's sibling ES-
# module imports cache independently). `no-cache` forces revalidation on
# every /remote/ asset: StaticFiles serves ETags, so unchanged files are
# 304s — trivial on LAN — and changed files are always picked up.
@app.middleware("http")
async def _remote_no_stale_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/remote" or path.startswith("/remote/") or path.startswith("/locales/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

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


# The phone's "Flat view" (#426, 2026-11-22) runs the desktop's own VR
# un-projection: renderer/js/vr-projection-renderer.js and its shaders, served
# here so there is one copy of the GLSL. Only these four files, never the rest
# of renderer/js. In packaged builds the spec ships them as <_MEIPASS>/vr-flatten/.
VR_FLATTEN_FILES = frozenset({
    "vr-projection-renderer.js",
    "shaders/_passthrough.vert.js",
    "shaders/equirect.frag.js",
    "shaders/fisheye.frag.js",
})


def _resolve_vr_flatten_dir() -> str | None:
    candidates = []
    if hasattr(sys, "_MEIPASS"):
        candidates.append(os.path.join(sys._MEIPASS, "vr-flatten"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.abspath(os.path.join(here, "..", "renderer", "js")))
    for c in candidates:
        if os.path.isfile(os.path.join(c, "vr-projection-renderer.js")):
            return c
    return None


_vr_flatten_dir = _resolve_vr_flatten_dir()


@app.get("/vr-flatten/{name:path}")
async def vr_flatten_file(name: str):
    if name not in VR_FLATTEN_FILES or not _vr_flatten_dir:
        raise HTTPException(status_code=404)
    return FileResponse(
        os.path.join(_vr_flatten_dir, *name.split("/")),
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache"},
    )


def apply_user_data_dir(user_data_dir: str) -> None:
    """Point the backend's per-user state at Electron's userData dir.

    The VR / web-remote thumbnail cache used to be set ONLY by the
    `thumbCacheDir` field of a library registration, and the only sender was
    a single fire-and-forget POST at the end of the main-process scan. The
    window and the backend boot in parallel, so when the scan beat uvicorn
    that POST was lost and every `/api/media/thumb/{id}` answered 500
    "Thumbnail cache not configured" until the next scan; after a backend
    restart nothing sent it at all (V22). The backend now owns the path from
    the moment it starts: the same `<userData>/thumb-cache` Electron sends,
    so a later registration carrying it changes nothing.
    """
    set_user_data_dir(user_data_dir)
    set_thumb_cache_dir(os.path.join(user_data_dir, "thumb-cache"))
    # Convert to play's copies: kept with the app's data, not in temp (2026-11-26).
    from services import ffmpeg as ffmpeg_service
    ffmpeg_service.set_converted_dir(os.path.join(user_data_dir, "converted"))
    # The EroScripts tab's downloads outlive FunSync: one running when it
    # closed comes back paused, with Resume (2026-11-25).
    from services import video_downloader
    video_downloader.manager.set_store(os.path.join(user_data_dir, "downloads.json"))


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
        apply_user_data_dir(args.user_data_dir)

    # Say which ffmpeg we are about to use, BEFORE anything needs it. A
    # packaged build that silently fell back to PATH produced a log
    # indistinguishable from a healthy one, and the first sign of trouble was
    # a hundred identical "Backend returned 500" lines with no reason attached
    # (Sylvain-Et-Un, 2026-08-24). This line makes the difference visible in
    # the first second of every log.
    from services.ffmpeg import describe_binaries
    _bins = describe_binaries()
    print(f"[ffmpeg] ffmpeg={_bins['ffmpeg']} (bundled={_bins['ffmpeg_bundled']}) "
          f"ffprobe={_bins['ffprobe']} (bundled={_bins['ffprobe_bundled']}) "
          f"frozen={_bins['frozen']}", flush=True)
    if not (_bins["ffmpeg_bundled"] and _bins["ffprobe_bundled"]):
        print("[ffmpeg] WARNING: falling back to PATH for at least one binary. "
              "If ffmpeg is not installed system-wide, thumbnails and metadata "
              "will fail for EVERY video.", flush=True)

    uvicorn.run(app, host=args.host, port=args.port)
