"""Desktop-only gate for the endpoints that take a filesystem path or a URL.

The backend listens on 0.0.0.0:5123 because headsets, the phone and the Handy
have to reach it over the LAN. CORS is `*` for the same reason. That left
every route open to every LAN host and to any web page the user had open:
`POST /api/media/register` accepted any path, `/api/media/stream/{id}` then
served it, and `/thumbnails/image?path=` served any file without even a
registration. config.json holds the Handy key, the Autoblow token and the
EroScripts login cookie in plaintext, so one request from the LAN was enough
to read them (FT-009).

The routes below are called ONLY by the desktop app: the Electron main
process (Node fetch, no Origin header) and the desktop renderer (a file://
page). Neither ever leaves the machine. The phone, DeoVR, HereSphere and the
Handy use /api/remote/*, /deovr, /heresphere, /api/media/stream|script|
subtitle|thumb/{id} and /scripts/{hash}.csv, none of which is gated.

A request passes only when ALL hold:
  * it comes from loopback (127.0.0.0/8, ::1, or IPv4-mapped loopback),
  * its Host header names loopback (127.0.0.1, localhost, [::1]), and
  * it carries no Origin header (or `file://`; see DESKTOP_ORIGINS).

The Origin check is what stops a web page in the user's own browser: its
requests come from loopback too, but the browser stamps them with the page's
origin (cross-origin fetch, any POST, sendBeacon), and a page cannot remove
it. A plain <img> GET carries no Origin, but its answer is opaque to the page.
The Host check closes DNS rebinding (see is_loopback_host_header).
"""

import ipaddress

from fastapi import Depends, HTTPException, Request

# Measured in the running app (Electron 41, 2026-11-05, an echo server on
# loopback): the renderer's file:// page sends NO Origin header, not even on
# a JSON POST, and no CORS preflight; Electron main (Node fetch) sends none
# either. So "absent" is what the desktop really sends. "file://" (what
# `location.origin` reads in that page) is accepted too, so an Electron change
# that starts stamping it cannot lock the desktop out of its own backend; no
# browser sends it.
#
# "null" is deliberately NOT accepted: it is what Chrome and Firefox send for
# a local HTML file opened in the browser (a downloaded page, an attachment),
# and with CORS `*` that page could read the answer.
DESKTOP_ORIGINS = frozenset({"file://"})


def is_loopback_host(host) -> bool:
    """True for a loopback client address, in any form uvicorn reports it."""
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(str(host).split("%", 1)[0])
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


def is_loopback_host_header(host_header) -> bool:
    """True when the Host header names this machine by a loopback name.

    DNS rebinding: a page at http://evil.example:5123 can have its name
    re-pointed at 127.0.0.1. Its requests then arrive from loopback and, for a
    same-origin GET, with no Origin header at all, so the two checks above
    would let it read `/thumbnails/image` and see the answer. The Host header
    still says evil.example. Every desktop caller dials 127.0.0.1 or
    localhost. A request with no Host header at all (HTTP/1.0) is not a
    browser's, so it is left to the other two checks.
    """
    if host_header is None:
        return True
    h = str(host_header).strip().lower()
    if h.startswith("["):  # [::1]:5123
        name = h[1:h.find("]")] if "]" in h else h[1:]
    elif h.count(":") == 1:  # 127.0.0.1:5123, localhost:5123
        name = h.split(":", 1)[0]
    else:
        name = h
    return name == "localhost" or is_loopback_host(name)


def is_desktop_caller(client_host, origin, host_header=None) -> bool:
    """The rule itself, separate from FastAPI so it can be read at a glance."""
    if not is_loopback_host(client_host):
        return False
    if not is_loopback_host_header(host_header):
        return False
    return origin is None or origin in DESKTOP_ORIGINS


async def require_desktop_caller(request: Request) -> None:
    """FastAPI dependency: 403 unless the request comes from the desktop app."""
    host = request.client.host if request.client else None
    origin = request.headers.get("origin")
    if not is_desktop_caller(host, origin, request.headers.get("host")):
        raise HTTPException(status_code=403, detail="desktop app only")


# Pass as `dependencies=DESKTOP_ONLY` on a route decorator.
DESKTOP_ONLY = [Depends(require_desktop_caller)]
