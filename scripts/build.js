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

// 2b. PROVE the backend executable exists before packaging anything.
//
// Nothing used to check this, and the failure is silent in both directions:
// `backend-dist/` is created above if absent, so it always exists as a
// (possibly empty) directory, and electron-builder copies an empty
// `extraResources` folder without a word of complaint. The result is an
// installer with no backend in it and a green build log.
//
// It would also never be caught in development, because `app.isPackaged` is
// false there and the app runs the backend from the venv instead — so the
// dev machine works perfectly while every user gets a dead backend.
//
// 4wen hit exactly that shape on 2026-08-13 (`spawn python ENOENT`). His was
// most likely antivirus removing the file post-install, but the build had no
// way of ruling itself out, which is what this closes.
step('Step 2b: Verifying the backend executable was produced');
const backendExe = path.join(
  BACKEND_DIST,
  process.platform === 'win32' ? 'funsync-backend.exe' : 'funsync-backend',
);
if (!fs.existsSync(backendExe)) {
  console.error(`\nFATAL: expected backend executable not found:\n  ${backendExe}`);
  console.error('\nPyInstaller reported success but produced nothing at that path.');
  console.error('Packaging now would ship an installer with no backend, and every');
  console.error('user would see "Backend program is missing".');
  console.error(`\nContents of ${BACKEND_DIST}:`);
  try {
    const entries = fs.readdirSync(BACKEND_DIST);
    console.error(entries.length ? entries.map((e) => `  ${e}`).join('\n') : '  (empty)');
  } catch {
    console.error('  (unreadable)');
  }
  process.exit(1);
}
const exeSize = fs.statSync(backendExe).size;
if (exeSize < 1_000_000) {
  console.error(`\nFATAL: ${backendExe} is only ${exeSize} bytes — that is not a real build.`);
  process.exit(1);
}
console.log(`OK: ${path.basename(backendExe)} (${(exeSize / 1024 / 1024).toFixed(1)} MB)`);

// 2c. Fetch the Twemoji artwork for category icons.
//
// Gitignored rather than committed, same treatment as ffmpeg/ and
// backend-dist/. It is generated third-party art: committing 737 files buys
// nothing, and every regeneration of the catalogue would add another 2.7 MB
// to history permanently. The manifest IS committed so imports resolve in a
// fresh clone, and a missing SVG degrades to font rendering rather than
// breaking, so a dev clone without this step still runs.
step('Step 2c: Fetching Twemoji artwork');
run(`node "${path.join(ROOT, 'scripts', 'fetch-twemoji.mjs')}"`, { cwd: ROOT });

const emojiDir = path.join(ROOT, 'renderer', 'assets', 'emoji');
const emojiCount = fs.existsSync(emojiDir)
  ? fs.readdirSync(emojiDir).filter((f) => f.endsWith('.svg')).length
  : 0;
if (emojiCount < 100) {
  console.error(`\nFATAL: only ${emojiCount} emoji SVGs in ${emojiDir}.`);
  console.error('The fetch did not complete. Category icons would fall back to');
  console.error('OS font rendering, which is the thing bundling them fixed.');
  process.exit(1);
}
console.log(`OK: ${emojiCount} emoji SVGs`);

// 3. Build Electron app with electron-builder
step('Step 3: Building Electron app with electron-builder');
run('npx electron-builder --config electron-builder.yml', { cwd: ROOT });

// 4. And prove it survived into the packaged output.
step('Step 4: Verifying the backend shipped inside the package');
const unpackedDirs = [
  path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'backend'),
  path.join(ROOT, 'dist', 'linux-unpacked', 'resources', 'backend'),
];
const shipped = unpackedDirs.filter((d) => fs.existsSync(d));
if (shipped.length === 0) {
  console.error('\nFATAL: no unpacked output contains resources/backend/.');
  console.error('The extraResources copy did not happen — do NOT publish this build.');
  process.exit(1);
}
for (const dir of shipped) {
  const files = fs.readdirSync(dir);
  if (files.length === 0) {
    console.error(`\nFATAL: ${dir} is EMPTY. The installer would ship without a backend.`);
    process.exit(1);
  }
  console.log(`OK: ${path.relative(ROOT, dir)} contains ${files.length} file(s)`);
}

step('Build complete! Check the dist/ folder.');
