// hevc-detect — HEVC support probe + platform-aware install guidance.
//
// Why this exists:
//   Electron's bundled ffmpeg.dll/.so DOES include software HEVC decode,
//   so HEVC files appear to play in Chromium's <video> element. But for
//   any resolution above 1080p, software HEVC decode on a typical
//   laptop CPU is too slow to sustain 30/60fps — the user sees stutter
//   and freezes.
//
//   Chromium can route HEVC to a hardware decoder (NVDEC/QSV/AMD VCN /
//   VideoToolbox), but each platform has its own gate:
//
//     Windows  — needs Microsoft's HEVC Video Extension AppX package.
//                Free for OEM Windows installs, $0.99 retail otherwise.
//     Linux    — needs working VA-API drivers (intel-media-driver /
//                mesa-va-drivers / nvidia-vaapi-driver) AND Chromium's
//                VaapiVideoDecoder feature flag enabled. We enable the
//                flag for the user in electron/main.js — this module
//                guides them to install the drivers if it's still off.
//     macOS    — VideoToolbox HEVC is built into the OS since 10.13
//                (2017). Should never trigger this code path; if it
//                does, the user is on a very old macOS.
//
// Detection (cross-platform):
//   `<video>.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')`
//   returns "" when no HEVC decoder is available, "probably" or "maybe"
//   otherwise. The codecs string is HEVC Main Profile Level 3.1 — the
//   most basic HEVC profile, supported by every working HEVC decoder.
//
// Benchmark numbers (i7-8750H + GTX 1070 Pascal — see services/ffmpeg.py
// for the full set):
//   4K HEVC software decode:           0.80x realtime → mild stutter
//   4K HEVC NVDEC (with OS codec):     2.44x realtime → smooth ✓
//   8K HEVC software decode:           0.585x realtime → severe stutter
//   8K HEVC NVDEC:                     0.76x realtime → still stutters
//     (Pascal NVDEC is rated for 4K HEVC; 8K is beyond its design —
//      hardware limit, only fix is pre-transcode or upgrade GPU)
//
// 8K HEVC stutter is acknowledged in the toast text on every platform.

import { showToast } from './toast.js';

const HEVC_TEST_TYPE = 'video/mp4; codecs="hev1.1.6.L93.B0"';

// Microsoft Store deep-links — both versions of the HEVC extension.
const STORE_URL_FREE = 'https://apps.microsoft.com/detail/9n4wgh0z6vhq';
const STORE_URL_PAID = 'https://apps.microsoft.com/detail/9nmzlz57r3t7';

// Linux VA-API troubleshooting reference. Chromium's docs page covers
// driver install per distro and how to verify hardware decode is active.
const LINUX_VAAPI_DOCS_URL = 'https://wiki.archlinux.org/title/Hardware_video_acceleration';

let _cachedSupport = null;

/** What platform are we running on? Reads from preload-injected window.funsync.platform. */
function getPlatform() {
  const p = (typeof window !== 'undefined' && window.funsync?.platform) || '';
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'macos';
  return 'unknown';
}

/**
 * Probe whether the current Chromium has a working HEVC decoder.
 * Cached per session — the answer can't change without an app restart.
 * @returns {boolean}
 */
export function osHasHevcSupport() {
  if (_cachedSupport !== null) return _cachedSupport;
  const v = document.createElement('video');
  const result = v.canPlayType(HEVC_TEST_TYPE);
  _cachedSupport = result === 'probably' || result === 'maybe';
  return _cachedSupport;
}

// ---------------- Platform-specific toast bodies ----------------

function _buildWindowsBody() {
  const body = document.createElement('div');
  body.style.cssText = 'font-size:12px;line-height:1.4;color:#e0e0e0';
  body.innerHTML = (
    'Your Windows is missing the HEVC codec, so HEVC files use slow '
    + 'software decode. Installing Microsoft\'s HEVC Video Extension lets '
    + 'your GPU decode them — fixes 4K HEVC. <em>Note: 8K HEVC is beyond '
    + 'most GPUs even with the codec.</em>'
  );

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;font-size:11px;margin-top:6px';
  links.appendChild(_makeLink('Install free version (OEM Windows)', STORE_URL_FREE));
  links.appendChild(_makeLink('Paid ($0.99)', STORE_URL_PAID));

  body.appendChild(links);
  return body;
}

function _buildLinuxBody() {
  const body = document.createElement('div');
  body.style.cssText = 'font-size:12px;line-height:1.4;color:#e0e0e0';
  body.innerHTML = (
    'Your Linux Chromium is using software HEVC decode, which stutters '
    + 'on 4K+ files. To enable hardware decode, install your distro\'s '
    + 'VA-API drivers and restart FunSync:'
    + '<pre style="background:rgba(0,0,0,0.3);padding:6px;border-radius:4px;'
    + 'margin-top:6px;font-size:11px;line-height:1.3;white-space:pre-wrap">'
    + '# Ubuntu / Debian (Intel iGPU)\n'
    + 'sudo apt install intel-media-va-driver mesa-va-drivers\n\n'
    + '# Ubuntu / Debian (AMD GPU)\n'
    + 'sudo apt install mesa-va-drivers\n\n'
    + '# Ubuntu / Debian (NVIDIA, recent drivers)\n'
    + 'sudo apt install nvidia-vaapi-driver\n\n'
    + '# Fedora\n'
    + 'sudo dnf install libva-utils mesa-va-drivers-freeworld\n\n'
    + '# Arch\n'
    + 'sudo pacman -S libva-utils intel-media-driver libva-mesa-driver'
    + '</pre>'
    + '<em>Note: 8K HEVC is beyond most GPUs even with hardware decode.</em>'
  );

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;font-size:11px;margin-top:6px';
  links.appendChild(_makeLink('Hardware video acceleration guide', LINUX_VAAPI_DOCS_URL));
  body.appendChild(links);
  return body;
}

function _buildMacosBody() {
  const body = document.createElement('div');
  body.style.cssText = 'font-size:12px;line-height:1.4;color:#e0e0e0';
  body.innerHTML = (
    'Your macOS Chromium can\'t use VideoToolbox HEVC — this usually means '
    + 'you\'re on macOS 10.12 or older (HEVC requires 10.13+). Update macOS '
    + 'to enable hardware HEVC decode. <em>Note: even on supported macOS, '
    + '8K HEVC needs an Apple Silicon Mac (M1/M2/M3) — older Intel Macs '
    + 'top out around 4K HEVC.</em>'
  );
  return body;
}

function _buildGenericBody() {
  const body = document.createElement('div');
  body.style.cssText = 'font-size:12px;line-height:1.4;color:#e0e0e0';
  body.textContent = (
    'HEVC files in your library will use slow software decode on this '
    + 'platform and may stutter, especially at 4K and above.'
  );
  return body;
}

function _makeLink(text, href) {
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = text;
  a.style.cssText = 'color:#7ec8e3;text-decoration:underline';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.funsync?.openExternal?.(href);
  });
  return a;
}

function _buildToastBody(onDismissForever) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-width:380px';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;color:#ffd166';
  title.textContent = 'HEVC playback may stutter';
  wrap.appendChild(title);

  const platform = getPlatform();
  let body;
  if (platform === 'windows')      body = _buildWindowsBody();
  else if (platform === 'linux')   body = _buildLinuxBody();
  else if (platform === 'macos')   body = _buildMacosBody();
  else                              body = _buildGenericBody();
  wrap.appendChild(body);

  const dismiss = document.createElement('a');
  dismiss.href = '#';
  dismiss.textContent = 'Don\'t show again';
  dismiss.style.cssText = 'font-size:11px;color:#888;text-decoration:underline;align-self:flex-start;margin-top:4px';
  dismiss.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDismissForever();
  });
  wrap.appendChild(dismiss);

  return wrap;
}

/**
 * Single entry point. Shows the guidance toast iff:
 *   (a) OS lacks HEVC support, AND
 *   (b) user hasn't permanently dismissed (`notifications.hevcDismissed`),
 *       AND
 *   (c) we haven't already shown it this session.
 *
 * Safe to call on every video load — the per-session guard means it
 * only fires once. Caller doesn't need to track state.
 *
 * @param {object} dataService — DataService instance (for persistent dismiss)
 */
let _shownThisSession = false;
export function maybeShowHevcGuidance(dataService) {
  if (_shownThisSession) return;
  if (osHasHevcSupport()) return;
  if (dataService?.get?.('notifications.hevcDismissed')) return;

  _shownThisSession = true;

  const handle = showToast(
    _buildToastBody(() => {
      dataService?.set?.('notifications.hevcDismissed', true);
      handle?.dismiss();
    }),
    'warn',
    0, // persistent — let the user click away when ready
  );
}

/** Test-only: reset the per-session guard so each test starts fresh. */
export function _resetForTests() {
  _shownThisSession = false;
  _cachedSupport = null;
}
