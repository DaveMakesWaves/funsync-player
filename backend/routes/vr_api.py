"""VR Content API — DeoVR and HereSphere compatible endpoints.

Serves FunSync's library in the JSON format that VR headset players expect.
DeoVR: GET /deovr (library), GET /deovr/{id} (scene detail)
HereSphere: GET /heresphere (library), GET /heresphere/{id} (scene detail)
"""

import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from routes.media import get_video_registry, _path_to_id, record_vr_activity
from services.network import get_local_ip

router = APIRouter()

# --- VR Format Detection ---

VR_PATTERNS = [
    # 360° patterns (must be checked before 180° to avoid false matches)
    (r'_360(?:x180)?_(?:3dh|sbs|LR)', 'sphere', 'sbs'),
    (r'_360(?:x180)?_(?:3dv|TB)', 'sphere', 'tb'),
    (r'(?:_mono360|_360_mono)', 'sphere', 'off'),
    # 180° TB (must be checked before generic 180° SBS)
    (r'(?:_180(?:x180)?_(?:3dv|TB)|_TB_180|_3dv)', 'dome', 'tb'),
    # 180° SBS
    (r'(?:_180(?:x180)?(?:_3dh)?(?:_LR)?|_LR_180|_3dh)', 'dome', 'sbs'),
    # 180° mono
    (r'(?:_mono180|_180_mono)', 'dome', 'off'),
    # Fisheye types
    (r'_MKX200', 'mkx200', 'sbs'),
    (r'_MKX220', 'mkx220', 'sbs'),
    (r'_RF52', 'rf52', 'sbs'),
    (r'_FISHEYE190', 'fisheye', 'sbs'),
    (r'_VRCA220', 'fisheye', 'sbs'),
    # Generic SBS/TB (no FOV specified — assume 180)
    (r'_sbs', 'dome', 'sbs'),
    (r'_(?:tb|ou)', 'dome', 'tb'),
]


def detect_vr_format(filename):
    """Detect VR projection and stereo mode from filename.

    Returns (screenType, stereoMode, is3d).
    """
    name = filename or ''
    for pattern, screen_type, stereo_mode in VR_PATTERNS:
        if re.search(pattern, name, re.IGNORECASE):
            return screen_type, stereo_mode, stereo_mode != 'off'
    return 'flat', 'off', False


def _get_base_url(request: Request):
    """Build base URL from request for constructing media URLs."""
    # Use the request's host header (works behind reverse proxy too)
    host = request.headers.get('host', f'{get_local_ip()}:5123')
    scheme = request.headers.get('x-forwarded-proto', 'http')
    return f'{scheme}://{host}'


def _get_duration(video):
    """Get video duration in seconds (from metadata or estimate)."""
    d = video.get('duration')
    if d and isinstance(d, (int, float)) and d > 0:
        return int(d)
    return 0


def _get_resolution(video):
    """Get video resolution (width, height) via ffprobe if available."""
    path = video.get('path', '')
    if not path or not os.path.isfile(path):
        return 1920, 1080  # fallback

    try:
        from services.ffmpeg import _find_binary
        import subprocess
        ffprobe = _find_binary('ffprobe')
        result = subprocess.run(
            [ffprobe, '-v', 'quiet', '-print_format', 'json',
             '-show_streams', '-select_streams', 'v:0', path],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            import json
            data = json.loads(result.stdout)
            streams = data.get('streams', [])
            if streams:
                w = int(streams[0].get('width', 1920))
                h = int(streams[0].get('height', 1080))
                return w, h
    except Exception:
        pass
    return 1920, 1080


# Cache resolution per video_id to avoid repeated ffprobe calls
_resolution_cache = {}


def _get_cached_resolution(video_id, video):
    if video_id not in _resolution_cache:
        _resolution_cache[video_id] = _get_resolution(video)
    return _resolution_cache[video_id]


# === DeoVR API ===

@router.get("/deovr")
async def deovr_library(request: Request):
    """DeoVR library listing — groups of scenes.

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

        # Add to directory group
        path = video.get('path', '')
        dir_name = os.path.basename(os.path.dirname(path)) or 'Library'
        if dir_name not in groups:
            groups[dir_name] = []
        groups[dir_name].append(item)

    scenes = []

    # VR group first (if any VR videos exist)
    if vr_group and vr_filter != 'flat':
        scenes.append({
            'name': '🥽 VR Videos',
            'list': sorted(vr_group, key=lambda x: x['title'].lower()),
        })

    # Scripted group (if any)
    if scripted_group and vr_filter != 'vr':
        scenes.append({
            'name': '🎮 With Funscript',
            'list': sorted(scripted_group, key=lambda x: x['title'].lower()),
        })

    # Directory groups
    for group_name, items in sorted(groups.items()):
        scenes.append({
            'name': group_name,
            'list': sorted(items, key=lambda x: x['title'].lower()),
        })

    return JSONResponse(
        content={'scenes': scenes, 'authorized': '1'},
        headers={'Access-Control-Allow-Origin': '*'},
    )


@router.get("/deovr/{video_id}")
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

    width, height = _get_cached_resolution(video_id, video)
    res_label = f'{height}p' if height else ''

    encodings = [{
        'name': f'{res_label} - {size_label}',
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

    return JSONResponse(
        content=scene,
        headers={'Access-Control-Allow-Origin': '*'},
    )


# === HereSphere API ===

@router.get("/heresphere")
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
        dir_name = os.path.basename(os.path.dirname(path)) or 'Library'
        if dir_name not in groups:
            groups[dir_name] = []
        groups[dir_name].append(url)

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


@router.get("/heresphere/{video_id}")
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

    width, height = _get_cached_resolution(video_id, video)

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
    dir_name = os.path.basename(os.path.dirname(path))
    if dir_name:
        tags.append({'name': f'Studio:{dir_name}'})
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
