"""Script hosting routes — serve CSV scripts to Handy device."""

import hashlib
import os
import tempfile

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from services.funscript import parse_funscript, funscript_to_csv
from services.network import get_local_ip

router = APIRouter()

# In-memory store of available scripts (hash -> csv path)
_script_store: dict[str, str] = {}


def register_script(script_hash: str, csv_path: str):
    """Register a CSV script file for serving."""
    _script_store[script_hash] = csv_path


@router.get("/{script_hash}.csv")
async def get_script(script_hash: str):
    """Serve a CSV script file by its hash."""
    csv_path = _script_store.get(script_hash)
    if csv_path is None or not os.path.exists(csv_path):
        raise HTTPException(status_code=404, detail="Script not found")

    with open(csv_path, "r") as f:
        content = f.read()

    return PlainTextResponse(content, media_type="text/csv")


@router.post("/convert")
async def convert_funscript(request: Request):
    """Parse a funscript JSON and convert to CSV. Returns the CSV content,
    a hash for caching, and a local download URL for the Handy device."""
    body = await request.body()
    content = body.decode("utf-8")

    try:
        parsed = parse_funscript(content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    csv_content = funscript_to_csv(parsed["actions"])

    # Check CSV size (Handy limit: 512 KiB)
    csv_size = len(csv_content.encode("utf-8"))
    if csv_size > 512 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"CSV too large for Handy ({csv_size} bytes, limit 524288)",
        )

    # Save CSV to temp file and register for serving
    csv_hash = hashlib.md5(csv_content.encode()).hexdigest()[:12]
    csv_dir = os.path.join(tempfile.gettempdir(), "funsync_scripts")
    os.makedirs(csv_dir, exist_ok=True)
    csv_path = os.path.join(csv_dir, f"{csv_hash}.csv")

    with open(csv_path, "w") as f:
        f.write(csv_content)

    register_script(csv_hash, csv_path)

    # Build local URL for Handy download
    local_ip = get_local_ip()
    # Port will be from the server's actual port, default 5123
    local_url = f"http://{local_ip}:5123/scripts/{csv_hash}.csv"

    return {
        "hash": csv_hash,
        "csv": csv_content,
        "size_bytes": csv_size,
        "action_count": len(parsed["actions"]),
        "duration_ms": parsed["actions"][-1]["at"] if parsed["actions"] else 0,
        "local_url": local_url,
        "version": parsed["version"],
        "inverted": parsed["inverted"],
        "range": parsed["range"],
    }
