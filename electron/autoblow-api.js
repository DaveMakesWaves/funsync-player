// Autoblow API — main process HTTP client for Ultra and VacuGlide 2
// Uses direct fetch() instead of the SDK to avoid ESM bare specifier issues in renderer

const log = require('./logger.js');

let _cluster = null;
let _token = null;
let _deviceType = null; // 'autoblow-ultra' | 'vacuglide'
let _deviceInfo = null;

async function _request(path, options = {}) {
  if (!_cluster || !_token) throw new Error('Not connected');

  const baseUrl = _cluster.includes('http') ? _cluster : `https://${_cluster}`;
  const url = `${baseUrl}/${path}`;
  const headers = { 'x-device-token': _token, ...options.headers };

  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 429) throw new Error('Rate limited — try again in a moment');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function connect(deviceToken) {
  _token = deviceToken;
  _cluster = null;
  _deviceType = null;
  _deviceInfo = null;

  // Step 1: Check connection and get cluster
  const connRes = await fetch('https://latency.autoblowapi.com/autoblow/connected', {
    headers: { 'x-device-token': deviceToken },
  });

  if (connRes.status === 429) throw new Error('Rate limited');
  const connData = await connRes.json();

  if (!connData.connected || !connData.cluster) {
    throw new Error('Device not connected — check power and WiFi');
  }

  _cluster = connData.cluster.endsWith('/')
    ? connData.cluster.slice(0, -1)
    : connData.cluster;

  // Step 2: Get device info
  _deviceInfo = await _request('autoblow/info');
  _deviceType = _deviceInfo.deviceType; // 'autoblow-ultra' or 'vacuglide'

  log.info(`[Autoblow] Connected: ${_deviceType} via ${_cluster}`);

  return {
    deviceType: _deviceType,
    deviceInfo: _deviceInfo,
  };
}

function disconnect() {
  _cluster = null;
  _token = null;
  _deviceType = null;
  _deviceInfo = null;
  log.info('[Autoblow] Disconnected');
}

function isConnected() {
  return !!_cluster && !!_token;
}

function getDeviceType() {
  return _deviceType;
}

// --- Ultra methods ---

async function goToPosition(position, speed) {
  return _request('autoblow/goto', {
    method: 'PUT',
    body: JSON.stringify({ position, speed }),
  });
}

async function syncScriptUploadFunscript(funscriptContent) {
  const prefix = _deviceType === 'vacuglide' ? 'vacuglide' : 'autoblow';
  const formData = new FormData();
  const blob = new Blob([funscriptContent], { type: 'application/json' });
  formData.append('file', blob, 'funscript.json');
  return _request(`${prefix}/sync-script/upload-funscript`, {
    method: 'PUT',
    body: formData,
  });
}

async function syncScriptStart(startTimeMs) {
  const prefix = _deviceType === 'vacuglide' ? 'vacuglide' : 'autoblow';
  return _request(`${prefix}/sync-script/start`, {
    method: 'PUT',
    body: JSON.stringify({ startTimeMs: Math.round(startTimeMs) }),
  });
}

async function syncScriptStop() {
  const prefix = _deviceType === 'vacuglide' ? 'vacuglide' : 'autoblow';
  return _request(`${prefix}/sync-script/stop`, { method: 'PUT' });
}

async function syncScriptOffset(offsetTimeMs) {
  const prefix = _deviceType === 'vacuglide' ? 'vacuglide' : 'autoblow';
  return _request(`${prefix}/sync-script/offset`, {
    method: 'PUT',
    body: JSON.stringify({ offsetTimeMs }),
  });
}

async function estimateLatency(rounds = 5) {
  if (!_cluster || !_token) return 0;
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const start = Date.now();
    await _request('autoblow/info');
    total += Date.now() - start;
  }
  return Math.round(total / rounds);
}

// --- VacuGlide methods ---

async function targetSpeedSet(speed) {
  return _request('vacuglide/target-speed', {
    method: 'PUT',
    body: JSON.stringify({ targetSpeed: Math.round(Math.max(0, Math.min(100, speed))) }),
  });
}

async function targetSpeedStop() {
  return _request('vacuglide/target-speed/stop', { method: 'PUT' });
}

module.exports = {
  connect,
  disconnect,
  isConnected,
  getDeviceType,
  goToPosition,
  syncScriptUploadFunscript,
  syncScriptStart,
  syncScriptStop,
  syncScriptOffset,
  estimateLatency,
  targetSpeedSet,
  targetSpeedStop,
};
