"""Metadata extraction routes — extract video info via ffprobe."""

from fastapi import APIRouter, HTTPException, Query

from routes.desktop_gate import DESKTOP_ONLY
from services.ffmpeg import get_metadata

router = APIRouter()


# Desktop-only (FT-009, routes/desktop_gate.py): runs ffprobe on any path the
# request names. Only Electron main calls it (`fetch-metadata`).
@router.get("/", dependencies=DESKTOP_ONLY)
def metadata(video_path: str = Query(..., description="Absolute path to video file")):
    """Extract metadata from a video file using ffprobe.

    Declared `def` (not `async def`) because `get_metadata` calls
    `subprocess.run(ffprobe, timeout=10)` synchronously. FastAPI runs
    sync handlers in its threadpool, so a slow ffprobe doesn't stall the
    event loop and block concurrent /stream, /register, or VR requests.
    """
    try:
        result = get_metadata(video_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
