const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const log = require('./logger');

let pythonProcess = null;
let backendPort = 5123;

// --- Health monitor ---
//
// The backend is launched at app startup but can die mid-session
// (Python crash, OOM, user killed it from Task Manager, FastAPI worker
// hung, etc.). Pre-2026-04-28 this surfaced as silent IPC failures —
// thumbnails stopped loading, library scans failed, but the user got
// no signal that the cause was the backend dying. Now we poll the
// `/health` endpoint and notify the renderer on state changes so it
// can surface a banner with a Restart action.
//
// Polling cadence: 5 s (fast enough that the user sees the banner
// within ~10 s of a death; slow enough that a steady-state idle app
// doesn't spend cycles on health checks).
//
// Failure threshold: 2 consecutive failures = `down`. A single failure
// might be a transient timeout under load. Two in a row at 5 s spacing
// is a real death.
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_FAIL_THRESHOLD = 2;

let healthState = 'unknown';   // 'unknown' | 'running' | 'down' | 'restarting'
let healthConsecutiveFailures = 0;
let healthIntervalHandle = null;
let healthListener = null;     // callback: (state, detail) => void

/**
 * Kill anything currently holding `port` so we don't fight an orphan backend
 * from a previous session. Cross-platform best-effort: swallows errors, logs
 * what it killed. Called on both startBackend (defensive) and stopBackend
 * (catches children that taskkill/SIGKILL on the parent PID missed).
 */
function killProcessesOnPort(port) {
  try {
    if (process.platform === 'win32') {
      // Find PIDs in LISTENING state on the given port.
      const output = execSync(`netstat -ano -p tcp`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        // "  TCP    0.0.0.0:5123    0.0.0.0:0    LISTENING   12345"
        if (!line.includes('LISTENING')) continue;
        if (!line.includes(`:${port} `) && !line.endsWith(`:${port}`)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          log.info(`[Backend] killed orphan PID ${pid} holding port ${port}`);
        } catch { /* already gone */ }
      }
    } else {
      // Unix: try lsof → ss → fuser in order. lsof is the cleanest output
      // but isn't installed by default on every distro (e.g. minimal
      // Debian, NixOS, some container images). ss (iproute2) and fuser
      // (psmisc) are near-universal fallbacks.
      const pids = new Set();
      for (const { cmd, parse } of [
        {
          cmd: `lsof -ti tcp:${port}`,
          parse: out => out.trim().split(/\s+/).filter(Boolean),
        },
        {
          cmd: `ss -ltnp 'sport = :${port}'`,
          // "... users:(("uvicorn",pid=12345,fd=3))"
          parse: out => Array.from(out.matchAll(/pid=(\d+)/g), m => m[1]),
        },
        {
          cmd: `fuser -n tcp ${port} 2>/dev/null`,
          parse: out => out.trim().split(/\s+/).filter(s => /^\d+$/.test(s)),
        },
      ]) {
        try {
          const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
          for (const pid of parse(out)) pids.add(pid);
          if (pids.size > 0) break;
        } catch { /* tool missing or no match — try next */ }
      }
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
          log.info(`[Backend] killed orphan PID ${pid} holding port ${port}`);
        } catch { /* already gone */ }
      }
    }
  } catch { /* all tools failed — nothing to do */ }
}

async function startBackend() {
  // Defensive: clear any stale backend from a previous session (crash / kill -9)
  // that would otherwise make uvicorn fail with "address in use".
  killProcessesOnPort(backendPort);

  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const backendDir = path.join(__dirname, '..', 'backend');

    // In packaged app, look for the bundled executable in resources/backend
    const isPackaged = require('electron').app.isPackaged;
    const bundledBackend = isPackaged
      ? path.join(process.resourcesPath, 'backend', 'funsync-backend' + (process.platform === 'win32' ? '.exe' : ''))
      : null;

    let cmd, args, cwd;

    if (bundledBackend && fs.existsSync(bundledBackend)) {
      // Production: use PyInstaller-bundled executable
      cmd = bundledBackend;
      args = ['--port', String(backendPort)];
      cwd = path.dirname(bundledBackend);
    } else {
      // Development: use venv Python or system Python
      const venvPython = process.platform === 'win32'
        ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
        : path.join(backendDir, '.venv', 'bin', 'python');

      cmd = fs.existsSync(venvPython)
        ? venvPython
        : (process.platform === 'win32' ? 'python' : 'python3');
      args = ['main.py', '--port', String(backendPort)];
      cwd = backendDir;
    }

    pythonProcess = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // detached on Linux for process group kill
    });

    let started = false;

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      log.info(`[Backend] ${output}`);
      if (!started && output.includes('Uvicorn running')) {
        started = true;
        resolve();
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString();
      log.error(`[Backend] ${output}`);
      // Uvicorn logs startup to stderr
      if (!started && output.includes('Uvicorn running')) {
        started = true;
        resolve();
      }
    });

    pythonProcess.on('error', (err) => {
      log.error('Failed to start Python backend:', err.message);
      if (!started) {
        started = true;
        // Don't reject — app can still work without backend for basic playback
        resolve();
      }
    });

    pythonProcess.on('close', (code) => {
      log.info(`Python backend exited with code ${code}`);
      pythonProcess = null;
      if (!started) {
        started = true;
        resolve();
      }
    });

    // Timeout — don't block app startup forever
    setTimeout(() => {
      if (!started) {
        started = true;
        log.warn('Python backend startup timed out, continuing without it');
        resolve();
      }
    }, 10000);
  });
}

function stopBackend() {
  stopHealthMonitor();
  if (pythonProcess) {
    const pid = pythonProcess.pid;
    try {
      // On Windows, .kill() sends SIGTERM which PyInstaller exes can ignore.
      // Use taskkill /T to kill the process tree (includes child processes).
      if (process.platform === 'win32' && pid) {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else if (pid) {
        // Kill process group on Linux (spawned with detached: true)
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      // Process may already be dead
    }
    pythonProcess = null;
  }

  // Belt-and-braces: sweep anything still holding the backend port. Covers
  // detached children, stale processes from earlier sessions, and the case
  // where taskkill on a parent didn't propagate to its uvicorn worker.
  killProcessesOnPort(backendPort);
}

function getBackendPort() {
  return backendPort;
}

/**
 * Subscribe to backend health state transitions. The callback fires on
 * every state change with `(state, detail)` where state is one of
 * `'running'`, `'down'`, `'restarting'`. main.js sets this up to
 * forward events to all renderer windows via IPC.
 */
function setHealthListener(cb) {
  healthListener = cb || null;
}

function getHealthState() {
  return healthState;
}

/**
 * Single non-blocking GET to /health. Resolves with `true` on 200,
 * `false` on any other outcome (network error, timeout, non-2xx).
 */
function probeHealth() {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: backendPort,
      path: '/health',
      method: 'GET',
      timeout: HEALTH_TIMEOUT_MS,
    }, (res) => {
      // Drain response body — leaving it open holds the socket.
      res.on('data', () => { /* ignore */ });
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function _emitHealthState(newState, detail) {
  if (newState === healthState) return; // no-op when state didn't change
  healthState = newState;
  log.info(`[Backend] health state → ${newState}${detail ? ` (${detail})` : ''}`);
  if (healthListener) {
    try { healthListener(newState, detail); }
    catch (err) { log.warn('[Backend] health listener threw:', err.message); }
  }
}

function startHealthMonitor() {
  stopHealthMonitor(); // idempotent
  healthConsecutiveFailures = 0;
  healthIntervalHandle = setInterval(async () => {
    const ok = await probeHealth();
    if (ok) {
      healthConsecutiveFailures = 0;
      _emitHealthState('running');
    } else {
      healthConsecutiveFailures++;
      if (healthConsecutiveFailures >= HEALTH_FAIL_THRESHOLD) {
        _emitHealthState('down', `no /health response in ${healthConsecutiveFailures} attempts`);
      }
    }
  }, HEALTH_INTERVAL_MS);
}

function stopHealthMonitor() {
  if (healthIntervalHandle) {
    clearInterval(healthIntervalHandle);
    healthIntervalHandle = null;
  }
}

/**
 * Stop the existing backend (if any) and start a new one. Used by the
 * "Restart Backend" affordance in the disconnected banner. Emits
 * `'restarting'` immediately so the UI can show transitional state.
 */
async function restartBackend() {
  _emitHealthState('restarting', 'user-initiated');
  stopHealthMonitor();
  stopBackend();
  // Brief breather to let the OS reap the killed PID before respawn —
  // Windows in particular can take a moment to release the port.
  await new Promise(r => setTimeout(r, 500));
  await startBackend();
  startHealthMonitor();
  // First probe after restart — if it succeeds, the next interval tick
  // will emit 'running'. If it fails, threshold logic kicks in.
  const ok = await probeHealth();
  if (ok) {
    healthConsecutiveFailures = 0;
    _emitHealthState('running');
  }
}

module.exports = {
  startBackend,
  stopBackend,
  getBackendPort,
  setHealthListener,
  getHealthState,
  startHealthMonitor,
  stopHealthMonitor,
  restartBackend,
};
