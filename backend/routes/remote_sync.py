"""Web remote device sync — phone-as-controller, desktop-drives-devices.

Two WebSocket endpoints:

- `/api/remote/sync`          — the phone connects here when it plays a video.
                                 Sends hello/state/seek/play/pause/ended/bye.
- `/api/remote/sync/observe`  — the Electron renderer connects here once and
                                 stays open. Receives everything the phone
                                 sends; also sends device-status / script-*
                                 messages back, which the server forwards to
                                 the phone.

Design notes:
- Exactly one phone may be active at a time. A second phone triggers
  "last-wins" arbitration: the old connection is sent a `kicked` payload,
  force-closed, and the new one becomes active. The observer is notified via
  a `phone-replaced` synthetic message.
- Exactly one observer at a time (the Electron renderer is a singleton).
  Fresh observer connections receive the current phone state for catch-up.
- Malformed JSON is silently ignored; the socket stays open.
- Server never crashes on a bad payload — any exception in the message loop
  is logged and the offending socket is closed.

State lives at module scope (process-level singleton). For a future
multi-phone / multi-observer design see SCOPE-web-remote-v1.1.md.
"""

import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from routes.media import get_video_registry

router = APIRouter()
log = logging.getLogger("funsync.remote")


def _resolve_video_path(video_id):
    """Look up the filesystem path for a `video_id` from the media registry.
    Returns None when unknown (observer will fall back to showing the raw id
    and the renderer logs 'script-missing' in that case)."""
    if not video_id:
        return None
    registry = get_video_registry()
    entry = registry.get(video_id)
    return entry.get("path") if entry else None

# --- Module-level session state -------------------------------------------

_active_phone: WebSocket | None = None
_active_phone_ip: str | None = None
_active_phone_video_id: str | None = None
_last_state: dict | None = None  # last `state` event for observer catch-up

_observer: WebSocket | None = None

KICK_REPLACED = "Another device took over this session."
KICK_OBSERVER_REPLACED = "Replaced by a newer observer."


async def _safe_send(ws: WebSocket | None, payload: dict) -> bool:
    """Send JSON, swallow errors. Returns False on failure."""
    if ws is None:
        return False
    try:
        await ws.send_text(json.dumps(payload))
        return True
    except Exception:
        return False


async def _safe_close(ws: WebSocket | None, code: int = 1000, reason: str = "") -> None:
    if ws is None:
        return
    try:
        await ws.close(code=code, reason=reason)
    except Exception:
        pass


async def _notify_observer(payload: dict) -> None:
    """Forward a payload to the observer if one is connected."""
    global _observer
    if _observer is None:
        return
    if not await _safe_send(_observer, payload):
        # Observer socket is dead — clear the slot so a future reconnect works.
        _observer = None


# --- Phone endpoint -------------------------------------------------------

@router.websocket("/sync")
async def phone_sync(ws: WebSocket) -> None:
    """Phone controller endpoint. Last-wins arbitration for multiple phones."""
    global _active_phone, _active_phone_ip, _active_phone_video_id, _last_state

    await ws.accept()
    client_ip = ws.client.host if ws.client else "unknown"
    query_video_id = ws.query_params.get("videoId")

    # --- Kick an existing phone (last-wins) ---
    if _active_phone is not None and _active_phone is not ws:
        old = _active_phone
        old_ip = _active_phone_ip
        _active_phone = None   # clear early so the kicked socket's disconnect
                               # handler doesn't double-clear
        await _safe_send(old, {"type": "kicked", "reason": KICK_REPLACED})
        await _safe_close(old, code=4000, reason=KICK_REPLACED)
        await _notify_observer({
            "type": "phone-replaced",
            "oldIp": old_ip,
            "newIp": client_ip,
        })
        log.info("[remote] Phone %s replaced by %s", old_ip, client_ip)

    _active_phone = ws
    _active_phone_ip = client_ip
    _active_phone_video_id = query_video_id
    _last_state = None

    await _notify_observer({
        "type": "phone-connected",
        "ip": client_ip,
        "videoId": query_video_id,
        "videoPath": _resolve_video_path(query_video_id),
    })
    log.info("[remote] Phone connected from %s (videoId=%s)", client_ip, query_video_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue  # tolerate garbage
            if not isinstance(msg, dict):
                continue
            msg_type = msg.get("type")
            if not isinstance(msg_type, str):
                continue

            # Capture / update context
            if msg_type == "hello" and msg.get("videoId"):
                _active_phone_video_id = msg["videoId"]
            if msg_type == "state":
                _last_state = msg  # cache for late observer connects

            # Forward to observer with provenance, enriching hello with path.
            enriched = {**msg, "from": "phone", "ip": client_ip}
            if msg_type == "hello" and msg.get("videoId"):
                enriched["videoPath"] = _resolve_video_path(msg["videoId"])
                log.info(
                    "[remote] hello from %s videoId=%s → path=%s (observer=%s)",
                    client_ip, msg["videoId"], enriched["videoPath"],
                    "connected" if _observer else "NONE",
                )
            await _notify_observer(enriched)

            if msg_type == "bye":
                break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("[remote] phone socket error: %s", e)
    finally:
        # Only clear state if THIS ws is still the active phone (last-wins
        # arbitration may have already rotated it out and a new one is live).
        if _active_phone is ws:
            departing_ip = _active_phone_ip
            _active_phone = None
            _active_phone_ip = None
            _active_phone_video_id = None
            _last_state = None
            await _notify_observer({"type": "phone-disconnected", "ip": departing_ip})
            log.info("[remote] Phone disconnected: %s", departing_ip)
        await _safe_close(ws)


# --- Observer endpoint (renderer) -----------------------------------------

@router.websocket("/sync/observe")
async def observer_sync(ws: WebSocket) -> None:
    """Electron renderer's observer socket. Singleton.

    Receives everything the phone sends. Sends device-status / script-ready /
    script-missing / script-loading payloads back, which the server forwards
    to the active phone.
    """
    global _observer

    await ws.accept()

    # Replace any prior observer — there should be exactly one Electron
    # instance at a time. Old one gets closed without fuss.
    if _observer is not None and _observer is not ws:
        old = _observer
        _observer = None  # clear so the old socket's disconnect doesn't clobber
        await _safe_close(old, code=4001, reason=KICK_OBSERVER_REPLACED)

    _observer = ws
    log.info("[remote] Observer connected")

    # Catch-up snapshot so the renderer knows the current state even if it
    # connected after the phone did.
    if _active_phone is not None:
        await _safe_send(ws, {
            "type": "phone-connected",
            "ip": _active_phone_ip,
            "videoId": _active_phone_video_id,
            "videoPath": _resolve_video_path(_active_phone_video_id),
        })
        if _last_state:
            await _safe_send(ws, {
                **_last_state,
                "from": "phone",
                "ip": _active_phone_ip,
            })

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue

            # Forward to phone if one is connected
            if _active_phone is not None:
                await _safe_send(_active_phone, msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("[remote] observer socket error: %s", e)
    finally:
        if _observer is ws:
            _observer = None
            log.info("[remote] Observer disconnected")
        await _safe_close(ws)


# --- Test-only helpers ----------------------------------------------------

def _reset_state_for_tests() -> None:
    """Reset module state between tests. Not part of the public API."""
    global _active_phone, _active_phone_ip, _active_phone_video_id
    global _last_state, _observer
    _active_phone = None
    _active_phone_ip = None
    _active_phone_video_id = None
    _last_state = None
    _observer = None


def _get_state_for_tests() -> dict:
    """Introspect internal state from tests."""
    return {
        "has_phone": _active_phone is not None,
        "phone_ip": _active_phone_ip,
        "phone_video_id": _active_phone_video_id,
        "has_observer": _observer is not None,
        "last_state": _last_state,
    }
