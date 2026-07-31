# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for FunSync backend

from PyInstaller.utils.hooks import collect_submodules

# yt-dlp loads its hundreds of site extractors LAZILY via importlib, so they're
# invisible to PyInstaller's static analysis. collect_submodules pulls the whole
# package (incl. yt_dlp.extractor.*) into the frozen build — without this the
# remote-video resolve would ImportError in production. See SCOPE-remote-video-url.
_ytdlp_submodules = collect_submodules('yt_dlp')

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    # Bundle the web remote SPA alongside the backend exe so the StaticFiles
    # mount at /remote/ works in the packaged app. `sys._MEIPASS` resolution
    # in main.py picks this up automatically at runtime.
    #
    # Also bundle renderer/locales/ as <_MEIPASS>/locales/ so the web-remote
    # i18n module can fetch /locales/<lang>.json. Source is two dirs up
    # from this spec (../renderer/locales) since we run PyInstaller from
    # backend/.
    datas=[
        ('web-remote', 'web-remote'),
        ('../renderer/locales', 'locales'),
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',  # loaded only when a WS connects
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'websockets',
        'websockets.legacy',
        'websockets.legacy.server',
    ] + _ytdlp_submodules,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='funsync-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX compression OFF. Windows Defender's ML model
    # (Program:Win32/Wacapew.A!ml) treats UPX-compressed PyInstaller
    # binaries as suspicious — UPX is a hallmark of obfuscated malware
    # in the training data. Turning it off costs ~30MB of binary size
    # but eliminates the most common false-positive vector. Reported
    # via community board 2026-05-21. Code-signing is the actual fix;
    # this is the no-cost mitigation while we wait on that.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
