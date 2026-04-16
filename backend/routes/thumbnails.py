"""Thumbnail generation routes — generate and serve video thumbnails."""

import os
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from services.ffmpeg import generate_thumbnails

router = APIRouter()


@router.post("/generate")
async def generate(
    video_path: str = Query(..., description="Absolute path to video file"),
    interval: int = Query(10, description="Seconds between thumbnails"),
):
    """Generate thumbnail images for a video file using ffmpeg."""
    try:
        manifest = generate_thumbnails(video_path, interval=interval)
        return manifest
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/image")
async def get_thumbnail(path: str = Query(..., description="Absolute path to thumbnail file")):
    """Serve a single thumbnail image file."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(path, media_type="image/jpeg")
