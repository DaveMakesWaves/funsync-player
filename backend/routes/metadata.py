"""Metadata extraction routes — extract video info via ffprobe."""

from fastapi import APIRouter, HTTPException, Query

from services.ffmpeg import get_metadata

router = APIRouter()


@router.get("/")
async def metadata(video_path: str = Query(..., description="Absolute path to video file")):
    """Extract metadata from a video file using ffprobe."""
    try:
        result = get_metadata(video_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
