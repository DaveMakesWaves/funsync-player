const { spawn } = require('child_process');
const path = require('path');
const log = require('./logger');

let pythonProcess = null;
let backendPort = 5123;

async function startBackend() {
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
  if (pythonProcess) {
    const pid = pythonProcess.pid;
    try {
      // On Windows, .kill() sends SIGTERM which PyInstaller exes can ignore.
      // Use taskkill /T to kill the process tree (includes child processes).
      if (process.platform === 'win32' && pid) {
        require('child_process').execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        pythonProcess.kill('SIGKILL');
      }
    } catch {
      // Process may already be dead
    }
    pythonProcess = null;
  }
}

function getBackendPort() {
  return backendPort;
}

module.exports = { startBackend, stopBackend, getBackendPort };
