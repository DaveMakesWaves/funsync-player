"""VR Content API — DeoVR and HereSphere compatible endpoints.

Serves FunSync's library in the JSON format that VR headset players expect.
DeoVR: GET /deovr (library), GET /deovr/{id} (scene detail)
HereSphere: GET /heresphere (library), GET /heresphere/{id} (scene detail)
"""

import json
import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.responses import Response

from routes.media import get_video_registry, _path_to_id, record_vr_activity
from services.network import get_local_ip

router = APIRouter()

# --- VR Format Detection ---
#
# Matching strategy mirrors renderer/js/vr-detect.js: any common separator
# (`_ - . space / \ [ ] ( )`) is accepted around tokens so we catch dot-separated,
# bracketed, and space-delimited filenames — not just underscore-delimited ones.

# Character class matching any common filename separator.
SEP = r'[_\-. /\\\[\]()]'

VR_PATTERNS = [
    # 360° patterns (must be checked before 180° to avoid false matches)
    (rf'(?:^|{SEP})360(?:x180)?{SEP}(?:3dh|sbs|LR)(?={SEP}|$)', 'sphere', 'sbs'),
    (rf'(?:^|{SEP})360(?:x180)?{SEP}(?:3dv|TB)(?={SEP}|$)', 'sphere', 'tb'),
    (rf'(?:^|{SEP})(?:mono360|360{SEP}mono)(?={SEP}|$)', 'sphere', 'off'),
    # 180° TB (must be checked before generic 180° SBS)
    (rf'(?:^|{SEP})(?:180(?:x180)?{SEP}(?:3dv|TB)|TB{SEP}180|3dv)(?={SEP}|$)', 'dome', 'tb'),
    # 180° SBS
    (rf'(?:^|{SEP})(?:180(?:x180)?(?:{SEP}3dh)?(?:{SEP}LR)?|LR{SEP}180|3dh)(?={SEP}|$)', 'dome', 'sbs'),
    # 180° mono
    (rf'(?:^|{SEP})(?:mono180|180{SEP}mono)(?={SEP}|$)', 'dome', 'off'),
    # Fisheye types
    (rf'(?:^|{SEP})MKX200(?={SEP}|$)', 'mkx200', 'sbs'),
    (rf'(?:^|{SEP})MKX220(?={SEP}|$)', 'mkx220', 'sbs'),
    (rf'(?:^|{SEP})RF52(?={SEP}|$)', 'rf52', 'sbs'),
    (rf'(?:^|{SEP})FISHEYE190(?={SEP}|$)', 'fisheye', 'sbs'),
    (rf'(?:^|{SEP})VRCA220(?={SEP}|$)', 'fisheye', 'sbs'),
    (rf'(?:^|{SEP})FB360(?={SEP}|$)', 'sphere', 'sbs'),
    (rf'(?:^|{SEP})EAC360(?={SEP}|$)', 'sphere', 'sbs'),
    # Generic SBS/TB/LR/3DH/3DV (no FOV specified — assume 180)
    (rf'(?:^|{SEP})sbs(?={SEP}|$)', 'dome', 'sbs'),
    (rf'(?:^|{SEP})(?:tb|ou)(?={SEP}|$)', 'dome', 'tb'),
    (rf'(?:^|{SEP})lr(?={SEP}|$)', 'dome', 'sbs'),
    (rf'(?:^|{SEP})3dh(?={SEP}|$)', 'dome', 'sbs'),
    (rf'(?:^|{SEP})3dv(?={SEP}|$)', 'dome', 'tb'),
]

# Japanese VR studio catalog prefixes with per-studio projection defaults.
# Value: (screenType, stereoMode) — fed directly into detect_vr_format return.
#
# Most modern FANZA/DMM studios shoot with fisheye lenses (~200° FOV, MKX200-like).
# Older or Western-style studios tend to use equirectangular 180° SBS.
# Mapping based on the dominant format each label ships on DMM/FANZA.
#
# screenType key:
#   'mkx200'  → fisheye 200° SBS (most modern Japanese VR)
#   'fisheye' → generic fisheye SBS
#   'dome'    → equirectangular 180° SBS
VR_STUDIO_FORMATS = {
    # --- Major FANZA labels (fisheye ~200°) ---
    'SIVR':    ('mkx200', 'sbs'),   # S1 VR
    'KAVR':    ('mkx200', 'sbs'),   # Kawaii VR
    'SAVR':    ('mkx200', 'sbs'),   # SOD Create VR
    'DSVR':    ('mkx200', 'sbs'),   # Deeps VR
    'PRVR':    ('mkx200', 'sbs'),   # Premium/Faleno VR
    'IPVR':    ('mkx200', 'sbs'),   # IdeaPocket VR
    'MDVR':    ('mkx200', 'sbs'),   # MOODYZ VR
    'WAVR':    ('mkx200', 'sbs'),   # Wanz Factory VR
    'NHVR':    ('mkx200', 'sbs'),   # Natural High VR
    'EBVR':    ('mkx200', 'sbs'),   # E-Body VR
    'HNVR':    ('mkx200', 'sbs'),   # HonNaka VR
    'MTVR':    ('mkx200', 'sbs'),   # Muteki VR
    'ATVR':    ('mkx200', 'sbs'),   # Attackers VR
    'EXVR':    ('mkx200', 'sbs'),   # EX VR
    'WPVR':    ('mkx200', 'sbs'),   # Waap VR
    'PXVR':    ('mkx200', 'sbs'),   # Pixel VR
    'TMAVR':   ('mkx200', 'sbs'),   # TMA VR
    'FSVR':    ('mkx200', 'sbs'),   # First Star VR
    'UNVR':    ('mkx200', 'sbs'),   # Unfinished VR
    'DOVR':    ('mkx200', 'sbs'),   # Dogma VR
    'JUVR':    ('mkx200', 'sbs'),   # S-Cute VR
    'MXVR':    ('mkx200', 'sbs'),   # MAX-A VR
    # --- KMP group (fisheye) ---
    'KMVR':    ('mkx200', 'sbs'),   # KMP VR
    'VRKM':    ('mkx200', 'sbs'),   # V&R KMP
    'BIKMVR':  ('mkx200', 'sbs'),   # BIK VR
    'CBIKMVR': ('mkx200', 'sbs'),   # CBIK VR
    'KIWVR':   ('mkx200', 'sbs'),   # Kawaii (alt)
    # --- Misc fisheye ---
    'VRSP':    ('mkx200', 'sbs'),   # VR SP
    'URVRSP':  ('mkx200', 'sbs'),   # URER VR SP
    'AVOPVR':  ('mkx200', 'sbs'),   # AVO Premium VR
    'GOPJ':    ('mkx200', 'sbs'),   # GO Pro Japan
    # --- Caribbean/older equirect ---
    'CJVR':    ('dome', 'sbs'),     # Caribbean VR — equirectangular 180°

    # --- Western studios — equirectangular 180° SBS (the vast majority) ---
    # Sourced from XBVR scraper definitions, SLR scene metadata, and
    # studio sample filenames. Most Western VR is shot equirect 180 SBS.
    'WANKZVR':          ('dome', 'sbs'),  # WankzVR
    'NAVR':             ('dome', 'sbs'),  # NaughtyAmericaVR
    'NAUGHTYAMERICAVR': ('dome', 'sbs'),
    'BADOINKVR':        ('dome', 'sbs'),  # BadoinkVR
    'BAVR':             ('dome', 'sbs'),
    'MILFVR':           ('dome', 'sbs'),  # MilfVR (Badoink network)
    'POVR':             ('dome', 'sbs'),  # POVR / POVRfilms
    'SINSVR':           ('dome', 'sbs'),  # SinsVR
    'REALJAMVR':        ('dome', 'sbs'),  # RealJamVR
    'RJVR':             ('dome', 'sbs'),
    'CZECHVR':          ('dome', 'sbs'),  # CzechVR
    'CZECHVRCASTING':   ('dome', 'sbs'),
    'CZECHVRFETISH':    ('dome', 'sbs'),
    'CZECHVRNETWORK':   ('dome', 'sbs'),
    'TMWVRNET':         ('dome', 'sbs'),  # TmwVRnet (TeenMegaWorld)
    'VIRTUALREALPORN':  ('dome', 'sbs'),  # VRP
    'VRP':              ('dome', 'sbs'),
    'LETHALHARDCOREVR': ('dome', 'sbs'),
    'LHVR':             ('dome', 'sbs'),
    'SLRORIGINALS':     ('dome', 'sbs'),  # SLR Originals
    'DARKROOMVR':       ('dome', 'sbs'),
    'SWEETLIFEVR':      ('dome', 'sbs'),
    'HOLOGIRLSVR':      ('dome', 'sbs'),
    'STASYQVR':         ('dome', 'sbs'),
    'VRALLURE':         ('dome', 'sbs'),
    'VRHUSH':           ('dome', 'sbs'),
    'GROOBYVR':         ('dome', 'sbs'),  # GroobyVR — trans
    'GROVR':            ('dome', 'sbs'),  # Alt Grooby code
    'KINKVR':           ('dome', 'sbs'),
    '18VR':             ('dome', 'sbs'),  # 18VR (Badoink network)
    'EVILANGELVR':      ('dome', 'sbs'),
    'EAVR':             ('dome', 'sbs'),
    'METAVERSEVR':      ('dome', 'sbs'),
    'ZEXYVR':           ('dome', 'sbs'),
    'REALHOTVR':        ('dome', 'sbs'),
    'VRLATINA':         ('dome', 'sbs'),
    'PORNHATVR':        ('dome', 'sbs'),
    'COSPLAYBABESVR':   ('dome', 'sbs'),
    'VRTRANSTASTY':     ('dome', 'sbs'),  # VRBangers trans brand

    # --- Western studios — migrated to fisheye (~190–200°) ---
    # VRBangers announced their fisheye migration in 2022; SLR/HereSphere
    # auto-detect MKX200 on newer VRB scenes.
    'VRBANGERS':        ('mkx200', 'sbs'),
    'VRB':              ('mkx200', 'sbs'),  # Primary VRBangers code
    'VRCONK':           ('mkx200', 'sbs'),  # VRBangers network brand

    # --- Rip-group / obfuscated codes sometimes applied to Western
    # equirect content (GroobyVR / VRBTrans / SLR bundles). Mapped to
    # dome based on user testing — if you see these misbehave in future
    # dumps, override via a manual association.
    'VRBTS':            ('dome', 'sbs'),
    'VRBTNS':           ('dome', 'sbs'),
    'VRBS':             ('dome', 'sbs'),
    'VRBANS':           ('dome', 'sbs'),
}

# VR resolution / projection tags (VR180, 8KVR, VR7K, 180VR, ...)
_VR_TAG_RE = re.compile(
    rf'(?:^|{SEP})(?:VR\d{{2,4}}|\d{{2,4}}VR|VR\d+K|\d+KVR)(?={SEP}|$)',
    re.IGNORECASE,
)

# Broad XXVR-### / VRXX-### fallback for unlisted studios (any separator).
_VR_STUDIO_RE = re.compile(
    rf'(?:^|{SEP})(?:[A-Z]{{1,8}}VR[A-Z]{{0,3}}|VR[A-Z]{{1,4}}){SEP}*\d{{2,5}}',
    re.IGNORECASE,
)

# Bare "VR" as its own whitespace/punctuation-delimited token.
_BARE_VR_RE = re.compile(
    rf'(?:^|{SEP})VR(?={SEP}|$)',
    re.IGNORECASE,
)

# Token split (for studio-prefix lookup). Strips all separators.
_SEP_SPLIT_RE = re.compile(rf'{SEP}+')

# Studio code fused to a number: "SIVR178" (no separator).
_STUDIO_COMBO_RE = re.compile(r'^([A-Z]{2,8})(\d{2,5})$')


def detect_vr_format(filename):
    """Detect VR projection and stereo mode from filename.

    Returns (screenType, stereoMode, is3d). Mirrors renderer/js/vr-detect.js —
    optimized for recall so the HereSphere/DeoVR VR group matches the library
    VR filter.

    Priority:
      1. Explicit projection/stereo tags (return accurate defaults)
      2. Known studio prefix — tokenised, separator-agnostic
      3. Broad XXVR-### / VRXX-### fallback
      4. VR resolution tags (VR180, 8KVR, ...)
      5. Bare "VR" token
    """
    name = filename or ''
    if not name:
        return 'flat', 'off', False

    # Strip trailing file extension so regex anchors work on the stem.
    stem = re.sub(r'\.[^./\\]+$', '', name)

    # 1. Explicit projection / stereo tags — most accurate defaults.
    for pattern, screen_type, stereo_mode in VR_PATTERNS:
        if re.search(pattern, stem, re.IGNORECASE):
            return screen_type, stereo_mode, stereo_mode != 'off'

    # 2. Known studio prefix — tokenise to catch both `SIVR-178` and `SIVR178`.
    for tok in _SEP_SPLIT_RE.split(stem):
        if not tok:
            continue
        upper = tok.upper()
        if upper in VR_STUDIO_FORMATS:
            screen_type, stereo_mode = VR_STUDIO_FORMATS[upper]
            return screen_type, stereo_mode, True
        m = _STUDIO_COMBO_RE.match(upper)
        if m and m.group(1) in VR_STUDIO_FORMATS:
            screen_type, stereo_mode = VR_STUDIO_FORMATS[m.group(1)]
            return screen_type, stereo_mode, True

    # 3. Broad XXVR-### / VRXX-### studio fallback.
    if _VR_STUDIO_RE.search(stem):
        return 'mkx200', 'sbs', True

    # 4. VR resolution / projection tags (VR180, 8KVR, ...).
    if _VR_TAG_RE.search(stem):
        return 'mkx200', 'sbs', True

    # 5. Bare "VR" as its own token — weakest signal.
    if _BARE_VR_RE.search(stem):
        return 'mkx200', 'sbs', True

    return 'flat', 'off', False


def _get_base_url(request: Request):
    """Build base URL from request for constructing media URLs."""
    host = request.headers.get('host', f'{get_local_ip()}:5123')
    scheme = 'https' if request.url.scheme == 'https' else 'http'
    return f'{scheme}://{host}'


def _get_duration(video):
    """Get video duration in seconds (from metadata or estimate)."""
    d = video.get('duration')
    if d and isinstance(d, (int, float)) and d > 0:
        return int(d)
    return 0


def _probe_video_info(path):
    """Run ffprobe to get resolution and codec. Blocking — call from background thread."""
    try:
        from services.ffmpeg import _find_binary
        import subprocess
        ffprobe = _find_binary('ffprobe')
        result = subprocess.run(
            [ffprobe, '-v', 'quiet', '-print_format', 'json',
             '-show_streams', '-select_streams', 'v:0', path],
            capture_output=True, text=True,
            # Windows reader-thread crashes with UnicodeDecodeError when it
            # falls back to cp1252 — pin to utf-8 with replacement so
            # unmappable codec/path bytes don't kill the probe.
            encoding='utf-8', errors='replace',
            timeout=10,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            streams = data.get('streams', [])
            if streams:
                w = int(streams[0].get('width', 1920))
                h = int(streams[0].get('height', 1080))
                codec = streams[0].get('codec_name', 'h264')
                if codec in ('hevc', 'h265'):
                    codec = 'h265'
                elif codec in ('h264', 'avc', 'avc1'):
                    codec = 'h264'
                return w, h, codec
    except Exception:
        pass
    return None


# Cache video info per video_id — populated lazily in background
_video_info_cache = {}
_probe_pending = set()  # video_ids currently being probed


def _get_cached_video_info(video_id, video):
    """Return cached info immediately, or defaults while probing in background."""
    if video_id in _video_info_cache:
        return _video_info_cache[video_id]

    # Not cached — return defaults now, probe in background
    path = video.get('path', '')
    if path and os.path.isfile(path) and video_id not in _probe_pending:
        _probe_pending.add(video_id)
        import threading
        def _bg_probe():
            result = _probe_video_info(path)
            if result:
                _video_info_cache[video_id] = result
            else:
                _video_info_cache[video_id] = (1920, 1080, 'h264')
            _probe_pending.discard(video_id)
        threading.Thread(target=_bg_probe, daemon=True).start()

    return _video_info_cache.get(video_id, (1920, 1080, 'h264'))


# === DeoVR API ===

@router.api_route("/deovr", methods=["GET", "POST"])
async def deovr_library(request: Request):
    """DeoVR library listing — groups of scenes.

    DeoVR sends both GET and POST to this endpoint.
    Query params:
      ?filter=vr    — only VR videos
      ?filter=flat  — only flat (non-VR) videos
      ?filter=scripted — only videos with funscripts
    """
    registry = get_video_registry()
    base_url = _get_base_url(request)
    vr_filter = request.query_params.get('filter', '')

    # Group videos: VR and Scripted groups first, then by directory
    groups = {}
    vr_group = []
    scripted_group = []

    for vid_id, video in registry.items():
        name = video.get('name', '')
        _, _, is_3d = detect_vr_format(name)
        has_script = bool(video.get('funscriptPath'))

        # Apply filter
        if vr_filter == 'vr' and not is_3d:
            continue
        if vr_filter == 'flat' and is_3d:
            continue
        if vr_filter == 'scripted' and not has_script:
            continue

        item = {
            'title': os.path.splitext(name)[0],
            'videoLength': _get_duration(video),
            'thumbnailUrl': f'{base_url}/api/media/thumb/{vid_id}',
            'video_url': f'{base_url}/deovr/{vid_id}',
        }

        # Add to VR group
        if is_3d:
            vr_group.append(item)

        # Add to scripted group
        if has_script:
            scripted_group.append(item)

        # Add to source group (uses source name from settings, falls back to parent folder)
        group_name = video.get('sourceName') or os.path.basename(os.path.dirname(video.get('path', ''))) or 'Library'
        if group_name not in groups:
            groups[group_name] = []
        groups[group_name].append(item)

    scenes = []

    # VR group first (if any VR videos exist)
    if vr_group and vr_filter != 'flat':
        scenes.append({
            'name': 'VR Videos',
            'list': sorted(vr_group, key=lambda x: x['title'].lower()),
        })

    # Scripted group (if any)
    if scripted_group and vr_filter != 'vr':
        scenes.append({
            'name': 'With Funscript',
            'list': sorted(scripted_group, key=lambda x: x['title'].lower()),
        })

    # Directory groups
    for group_name, items in sorted(groups.items()):
        scenes.append({
            'name': group_name,
            'list': sorted(items, key=lambda x: x['title'].lower()),
        })

    # DeoVR requires Content-Length (chunked encoding breaks its JSON parser)
    body = json.dumps({'scenes': scenes, 'authorized': '0'}, ensure_ascii=False)
    return Response(
        content=body,
        media_type='application/json',
        headers={
            'Access-Control-Allow-Origin': '*',
            'Content-Length': str(len(body.encode('utf-8'))),
        },
    )


@router.api_route("/deovr/{video_id}", methods=["GET", "POST"])
async def deovr_scene(video_id: str, request: Request):
    """DeoVR scene detail — full metadata for one video."""
    registry = get_video_registry()
    video = registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Scene not found")

    # Record VR activity for auto-connect companion bridge
    client_ip = request.client.host if request.client else None
    if client_ip and client_ip not in ('127.0.0.1', '::1', 'localhost'):
        record_vr_activity(client_ip, video_id)

    base_url = _get_base_url(request)
    name = video.get('name', '')
    title = os.path.splitext(name)[0]
    screen_type, stereo_mode, is_3d = detect_vr_format(name)
    duration = _get_duration(video)
    path = video.get('path', '')

    # Build encodings
    file_size = 0
    try:
        file_size = os.path.getsize(path)
    except OSError:
        pass

    size_label = f'{file_size / (1024**3):.1f} GB' if file_size > 1024**3 else f'{file_size / (1024**2):.0f} MB'

    width, height, codec = _get_cached_video_info(video_id, video)

    encodings = [{
        'name': codec,
        'videoSources': [{
            'resolution': height,
            'height': height,
            'width': width,
            'size': file_size,
            'url': f'{base_url}/api/media/stream/{video_id}',
        }],
    }]

    # Build funscript array
    fleshlight = []
    fs_path = video.get('funscriptPath')
    if fs_path:
        fs_name = os.path.basename(fs_path)
        fleshlight.append({
            'title': fs_name,
            'url': f'{base_url}/api/media/script/{video_id}',
        })

    # Auto-generate chapter timestamps every 5 minutes for navigation
    timestamps = []
    if duration > 300:  # only for videos > 5 min
        interval = 300  # 5 minutes
        t = interval
        while t < duration:
            mins = int(t // 60)
            timestamps.append({'ts': int(t), 'name': f'{mins} min'})
            t += interval

    scene = {
        'id': video_id,
        'title': title,
        'authorized': 1,
        'description': '',
        'date': int(time.time()),
        'is3d': is_3d,
        'screenType': screen_type,
        'stereoMode': stereo_mode,
        'videoLength': duration,
        'thumbnailUrl': f'{base_url}/api/media/thumb/{video_id}',
        'encodings': encodings,
        'fleshlight': fleshlight,
        'timeStamps': timestamps,
        'isScripted': bool(fs_path),
        'isFavorite': False,
        'fullVideoReady': True,
        'fullAccess': True,
    }

    body = json.dumps(scene, ensure_ascii=False)
    return Response(
        content=body,
        media_type='application/json',
        headers={
            'Access-Control-Allow-Origin': '*',
            'Content-Length': str(len(body.encode('utf-8'))),
        },
    )


# === HereSphere API ===

@router.api_route("/heresphere", methods=["GET", "POST"])
async def heresphere_library(request: Request):
    """HereSphere library listing.

    Query params:
      ?filter=vr    — only VR videos
      ?filter=flat  — only flat (non-VR) videos
      ?filter=scripted — only videos with funscripts
    """
    registry = get_video_registry()
    base_url = _get_base_url(request)
    vr_filter = request.query_params.get('filter', '')

    groups = {}
    vr_urls = []
    scripted_urls = []

    for vid_id, video in registry.items():
        name = video.get('name', '')
        _, _, is_3d = detect_vr_format(name)
        has_script = bool(video.get('funscriptPath'))

        if vr_filter == 'vr' and not is_3d:
            continue
        if vr_filter == 'flat' and is_3d:
            continue
        if vr_filter == 'scripted' and not has_script:
            continue

        url = f'{base_url}/heresphere/{vid_id}'

        if is_3d:
            vr_urls.append(url)
        if has_script:
            scripted_urls.append(url)

        path = video.get('path', '')
        group_name = video.get('sourceName') or os.path.basename(os.path.dirname(path)) or 'Library'
        if group_name not in groups:
            groups[group_name] = []
        groups[group_name].append(url)

    library = []

    if vr_urls and vr_filter != 'flat':
        library.append({'name': '🥽 VR Videos', 'list': sorted(vr_urls)})

    if scripted_urls and vr_filter != 'vr':
        library.append({'name': '🎮 With Funscript', 'list': sorted(scripted_urls)})

    for group_name, urls in sorted(groups.items()):
        library.append({'name': group_name, 'list': sorted(urls)})

    return JSONResponse(
        content={'access': 1, 'library': library},
        headers={
            'Access-Control-Allow-Origin': '*',
            'HereSphere-JSON-Version': '1',
        },
    )


@router.api_route("/heresphere/{video_id}", methods=["GET", "POST"])
async def heresphere_scene(video_id: str, request: Request):
    """HereSphere scene detail."""
    registry = get_video_registry()
    video = registry.get(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Scene not found")

    # Record VR activity for auto-connect companion bridge
    client_ip = request.client.host if request.client else None
    if client_ip and client_ip not in ('127.0.0.1', '::1', 'localhost'):
        record_vr_activity(client_ip, video_id)

    base_url = _get_base_url(request)
    name = video.get('name', '')
    title = os.path.splitext(name)[0]
    screen_type, stereo_mode, is_3d = detect_vr_format(name)
    duration = _get_duration(video)
    path = video.get('path', '')

    # Map DeoVR screenType to HereSphere projection
    projection_map = {
        'dome': 'equirectangular',
        'sphere': 'equirectangular360',
        'mkx200': 'fisheye',
        'mkx220': 'fisheye',
        'rf52': 'fisheye',
        'fisheye': 'fisheye',
        'flat': 'perspective',
    }
    projection = projection_map.get(screen_type, 'perspective')

    # Lens for fisheye types
    lens_map = {'mkx200': 'MKX200', 'mkx220': 'MKX220', 'rf52': 'RF52', 'fisheye': 'Linear'}
    lens = lens_map.get(screen_type, 'Linear')

    # FOV
    fov = 180.0 if screen_type in ('dome', 'mkx200', 'mkx220', 'rf52', 'fisheye') else 360.0 if screen_type == 'sphere' else 0.0

    # File info
    file_size = 0
    try:
        file_size = os.path.getsize(path)
    except OSError:
        pass

    size_label = f'{file_size / (1024**3):.1f} GB' if file_size > 1024**3 else f'{file_size / (1024**2):.0f} MB'

    width, height, codec = _get_cached_video_info(video_id, video)

    # Media sources
    media = [{
        'name': f'{height}p - {size_label}',
        'sources': [{
            'resolution': str(height),
            'height': height,
            'width': width,
            'size': file_size,
            'url': f'{base_url}/api/media/stream/{video_id}',
        }],
    }]

    # Scripts
    scripts = []
    fs_path = video.get('funscriptPath')
    if fs_path:
        fs_name = os.path.basename(fs_path)
        scripts.append({
            'name': fs_name,
            'url': f'{base_url}/api/media/script/{video_id}',
        })

    # Tags
    tags = []
    source_name = video.get('sourceName') or os.path.basename(os.path.dirname(path))
    if source_name:
        tags.append({'name': f'Studio:{source_name}'})
    if video.get('hasFunscript'):
        tags.append({'name': 'Feature:Is scripted'})

    # Auto-generate chapter tags for navigation (every 5 min)
    if duration > 300:
        interval = 300
        t = interval
        while t < duration:
            mins = int(t // 60)
            tags.append({
                'name': f'{mins} min',
                'start': int(t * 1000),
                'end': int(min(t + interval, duration) * 1000),
                'track': 0,
            })
            t += interval

    # Subtitles
    subtitles = []
    sub_path = video.get('subtitlePath')
    if sub_path:
        sub_name = os.path.basename(sub_path)
        sub_ext = os.path.splitext(sub_name)[1].lower()
        subtitles.append({
            'name': sub_name,
            'language': 'English',
            'url': f'{base_url}/api/media/subtitle/{video_id}',
        })

    stereo_hs = 'sbs' if stereo_mode == 'sbs' else 'tb' if stereo_mode == 'tb' else 'mono'

    scene = {
        'access': 1,
        'title': title,
        'description': '',
        'thumbnailImage': f'{base_url}/api/media/thumb/{video_id}',
        'dateReleased': '',
        'dateAdded': '',
        'duration': duration * 1000,  # HereSphere uses milliseconds
        'rating': 0,
        'isFavorite': False,
        'projection': projection,
        'stereo': stereo_hs,
        'fov': fov,
        'lens': lens,
        'scripts': scripts,
        'subtitles': subtitles,
        'tags': tags,
        'media': media,
        'writeFavorite': False,
        'writeRating': False,
        'writeTags': False,
        'writeHSP': False,
    }

    return JSONResponse(
        content=scene,
        headers={
            'Access-Control-Allow-Origin': '*',
            'HereSphere-JSON-Version': '1',
        },
    )
