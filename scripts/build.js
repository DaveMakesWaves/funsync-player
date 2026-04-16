#!/usr/bin/env node
// Build script for FunSync Player
// Usage: node scripts/build.js

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const BACKEND_DIST = path.join(ROOT, 'backend-dist');

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function step(msg) {
  console.log(`\n${'='.repeat(60)}\n${msg}\n${'='.repeat(60)}`);
}

// 1. Run tests
step('Step 1: Running tests');
try {
  run('npx vitest run', { cwd: ROOT });
  const venvPython = process.platform === 'win32'
    ? path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(BACKEND_DIR, '.venv', 'bin', 'python');
  run(`"${venvPython}" -m pytest -v`, { cwd: BACKEND_DIR });
} catch (err) {
  console.error('Tests failed! Aborting build.');
  process.exit(1);
}

// 2. Bundle Python backend with PyInstaller
step('Step 2: Building Python backend with PyInstaller');
if (!fs.existsSync(BACKEND_DIST)) {
  fs.mkdirSync(BACKEND_DIST, { recursive: true });
}

const venvPython = process.platform === 'win32'
  ? path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
  : path.join(BACKEND_DIR, '.venv', 'bin', 'python');

run(`"${venvPython}" -m PyInstaller --distpath "${BACKEND_DIST}" --workpath "${path.join(ROOT, 'build', 'pyinstaller')}" --clean funsync-backend.spec`, {
  cwd: BACKEND_DIR,
});

// 3. Build Electron app with electron-builder
step('Step 3: Building Electron app with electron-builder');
run('npx electron-builder --config electron-builder.yml', { cwd: ROOT });

step('Build complete! Check the dist/ folder.');
