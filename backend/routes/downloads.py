"""Video downloads for the EroScripts tab (2026-11-22). Desktop app only: the
backend listens on the LAN for the phone, and these routes write files."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException
from fastapi.concurrency import run_in_threadpool

from routes.desktop_gate import DESKTOP_ONLY
from services import video_downloader as vd

router = APIRouter()


@router.post("/classify", dependencies=DESKTOP_ONLY)
async def classify_links(payload: dict = Body(default={})):
    """What each of a post's links is: {links: [{url, kind, host, supported}]}."""
    links = payload.get("links") or []
    if not isinstance(links, list):
        raise HTTPException(status_code=400, detail="links must be a list")
    urls = [str(u) for u in links[:100] if isinstance(u, str)]
    # yt-dlp's extractor match is CPU work: off the event loop.
    return {"links": await run_in_threadpool(lambda: [vd.classify(u) for u in urls])}


@router.post("/check", dependencies=DESKTOP_ONLY)
async def check_links(payload: dict = Body(default={})):
    """Is each video still there? {links: [{url, status: ok|dead|unknown, size, name}]}.
    One small request per link a host can answer; tube sites and Gofile are
    'unknown' (no request). Dave, 2026-11-22: "there should be an indicator
    as to which links work"."""
    links = payload.get("links") or []
    if not isinstance(links, list):
        raise HTTPException(status_code=400, detail="links must be a list")
    urls = [str(u) for u in links[:60] if isinstance(u, str)]
    return {"links": await run_in_threadpool(vd.manager.check, urls)}


@router.post("", dependencies=DESKTOP_ONLY)
async def start_download(payload: dict = Body(default={})):
    """Start one: {url, destDir, stem, allowTube} -> {job}."""
    try:
        job = await run_in_threadpool(
            vd.manager.start,
            str(payload.get("url") or ""),
            str(payload.get("destDir") or ""),
            str(payload.get("stem") or ""),
            payload.get("allowTube") is True,
            # The script with this name is the one this post saved before
            # (its video failed or was cancelled): the video joins it.
            payload.get("scriptIsOurs") is True,
            # A Gofile link: the app's resolution (electron/gofile.js), checked in the service.
            payload.get("resolved") if isinstance(payload.get("resolved"), dict) else None,
            # Several videos behind one link: the one named like this (the script).
            str(payload.get("hint") or "")[:300],
            # The tab's note on it (its post, script, tags), kept with the job
            # so it still finishes as the post's after FunSync closes.
            payload.get("meta") if isinstance(payload.get("meta"), dict) else None,
        )
    except vd.DownloadError as e:
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)})
    return {"job": job.snapshot()}


@router.get("", dependencies=DESKTOP_ONLY)
async def list_downloads():
    return {"jobs": vd.manager.jobs()}


@router.post("/{job_id}/cancel", dependencies=DESKTOP_ONLY)
async def cancel_download(job_id: str):
    """Stop it and delete what it wrote (on a paused one: its partial file)."""
    return {"cancelled": vd.manager.cancel(job_id)}


@router.post("/{job_id}/pause", dependencies=DESKTOP_ONLY)
async def pause_download(job_id: str):
    """Stop it and keep the partial file for Resume (2026-11-22)."""
    return {"paused": vd.manager.pause(job_id)}


@router.post("/{job_id}/resume", dependencies=DESKTOP_ONLY)
async def resume_download(job_id: str, payload: dict = Body(default={})):
    """Continue a paused or failed download where it stopped. {resolved}: a
    Gofile one brought back after a restart, looked up again by the app."""
    resolved = payload.get("resolved") if isinstance(payload, dict) and isinstance(payload.get("resolved"), dict) else None
    try:
        job = await run_in_threadpool(vd.manager.resume, job_id, resolved)
    except vd.DownloadError as e:
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)})
    if not job:
        raise HTTPException(status_code=400, detail={"code": "notResumable", "message": "nothing to resume"})
    return {"job": job.snapshot()}


@router.get("/space", dependencies=DESKTOP_ONLY)
async def disk_space(dir: str = ""):
    """Free bytes on the disk holding `dir` (the download window shows it)."""
    try:
        d = vd.check_dest(dir)
    except vd.DownloadError as e:
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)})
    return {"free": vd.free_space(d), "margin": vd.SPACE_MARGIN}


@router.post("/clear", dependencies=DESKTOP_ONLY)
async def clear_finished():
    return {"cleared": vd.manager.clear_finished()}
