#!/usr/bin/env node
// npm run test:crlf — run the JS tests the way CI's Windows runner checks the
// repo out: a fresh clone with core.autocrlf=true, so every file arrives CRLF.
//
// Why: the first v0.10.0 tag (2026-11-20) failed 68 tests on windows-latest
// and 4 on ubuntu-latest while everything was green locally, because the
// working tree is mostly LF. This catches the CRLF class with no push. It
// cannot reproduce Linux (finer timers, posix path rules): that is what the
// Tests workflow (.github/workflows/test.yml) is for. Push the commit, wait for
// it to go green, then tag.
//
// It clones COMMITTED HEAD (what a tag would point at), not uncommitted edits;
// it says so when the working tree has tracked changes.
//
// Safety: node_modules in the clone is a JUNCTION to this repo's
// node_modules. A recursive delete through it would empty the real one, so the
// junction is removed on its own first (cmd rmdir, which removes the link and
// nothing behind it), and the clone is deleted only if that succeeded.
//
//   npm run test:crlf                 the whole suite
//   npm run test:crlf -- <filters>    vitest filters, e.g. tests/unit/tcode
//   npm run test:crlf -- --keep       keep the clone for a look afterwards
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const filters = args.filter((a) => a !== '--keep');
const isWin = process.platform === 'win32';

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: false, ...opts });
  if (r.error) throw r.error;
  return r;
}

const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo }).stdout.trim();
if (dirty) {
  const n = dirty.split('\n').length;
  console.log(`[test:crlf] Note: ${n} tracked file(s) have uncommitted changes. This checks committed HEAD, not them.`);
}

const nodeModules = path.join(repo, 'node_modules');
if (!fs.existsSync(nodeModules)) {
  console.error('[test:crlf] No node_modules in the repo: run npm install first.');
  process.exit(2);
}

const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-crlf-'));
let exitCode = 1;
let linkMade = false;
try {
  console.log(`[test:crlf] Cloning HEAD with core.autocrlf=true into ${clone}`);
  const c = run('git', ['clone', '--quiet', '--no-hardlinks', '-c', 'core.autocrlf=true', repo, clone], { stdio: 'inherit' });
  if (c.status !== 0) throw new Error('git clone failed');

  const pkg = path.join(clone, 'package.json');
  const crlf = fs.readFileSync(pkg, 'utf8').includes('\r\n');
  if (isWin && !crlf) console.log('[test:crlf] Warning: package.json came out LF; a .gitattributes rule may be overriding autocrlf.');

  const link = path.join(clone, 'node_modules');
  if (isWin) {
    const j = run('cmd', ['/c', 'mklink', '/J', link, nodeModules]);
    if (j.status !== 0) throw new Error(`mklink /J failed: ${j.stderr || j.stdout}`);
  } else {
    fs.symlinkSync(nodeModules, link, 'dir');
  }
  linkMade = true;

  console.log(`[test:crlf] Running vitest in the CRLF clone${filters.length ? ` (${filters.join(' ')})` : ''}...`);
  const v = run(process.execPath, [path.join(nodeModules, 'vitest', 'vitest.mjs'), 'run', '--retry=0', ...filters], { cwd: clone, stdio: 'inherit' });
  exitCode = v.status ?? 1;
  console.log(exitCode === 0
    ? '[test:crlf] PASSED with a CRLF checkout. Linux is checked by the Tests workflow on push.'
    : '[test:crlf] FAILED with a CRLF checkout: these would fail on CI\'s Windows runner.');
} catch (err) {
  console.error(`[test:crlf] ${err.message || err}`);
  exitCode = 2;
} finally {
  cleanUp();
}
process.exit(exitCode);

function cleanUp() {
  const link = path.join(clone, 'node_modules');
  if (linkMade) {
    let isLink = false;
    try { isLink = fs.lstatSync(link).isSymbolicLink(); } catch { /* gone */ }
    // Node reports a Windows junction as a symbolic link. Anything else means
    // something is wrong: touch nothing, and say where the clone is.
    if (!isLink) {
      console.error(`[test:crlf] ${link} is not a link any more; NOT deleting the clone. Remove ${clone} by hand, junction first.`);
      return;
    }
    const r = isWin ? run('cmd', ['/c', 'rmdir', link]) : { status: (fs.unlinkSync(link), 0) };
    if (r.status !== 0 || fs.existsSync(link)) {
      console.error(`[test:crlf] Could not remove the node_modules link; NOT deleting the clone. Remove ${clone} by hand, junction first.`);
      return;
    }
  }
  if (keep) { console.log(`[test:crlf] Kept the clone at ${clone} (its node_modules link is already removed).`); return; }
  fs.rmSync(clone, { recursive: true, force: true });
}
