#!/usr/bin/env node
/**
 * Back up the git-ignored files that CANNOT be recovered from a clone.
 *
 * Goal (Dave, 2026-08-06): `git clone` + this folder = a working setup again.
 *
 * Two deliberate departures from "copy everything git ignores":
 *
 *  1. It COPIES, it does not move. Most ignored paths are load-bearing —
 *     `notes/` holds every planning doc, `ffmpeg/` is what the backend shells
 *     out to. Moving them out of the tree would break the app and the docs,
 *     and a backup you had to move back isn't a backup.
 *
 *  2. It skips what a clone can regenerate. node_modules (800M), .venv
 *     (101M) and dist/build/backend-dist (1.3G+) all come back from
 *     `npm install` / `pip install` / `npm run build`. Copying them would
 *     make the backup ~3GB of material that is stale the moment a dependency
 *     changes, and would bury the 2.8MB of notes that actually matter.
 *
 * Additive by default: files removed from the repo are REPORTED, not deleted
 * from the backup. Pass --prune to mirror deletions. A backup that silently
 * deletes your only remaining copy is worse than one that keeps a stale file.
 *
 * Also covers the two sibling content-pipeline folders (../FunSync-Discord,
 * ../FunSync-Patreon). They are not in this repo and are not git repos of
 * their own, so without this nothing protects them.
 *
 * Usage:  node scripts/backup-ignored.mjs [--prune] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.resolve(REPO, '..', 'funsync-backup');

/**
 * Ignored paths worth keeping. Each carries WHY, because the next person to
 * read this (or the next session) needs to judge additions against the same
 * bar: is it irreplaceable, or does a clone plus a package manager bring it
 * back?
 */
const INCLUDE = [
  { p: 'notes', why: 'every planning//context doc — the whole point of this backup' },
  { p: '.claude', why: 'project agents, settings and skills' },
  { p: 'Logo.ico', why: 'source asset, not in the repo' },
  { p: 'FS(1).png', why: 'source asset, not in the repo' },
  { p: 'Test.mp4', why: 'test media, deliberately too large for git' },
  { p: 'Test-slow.funscript', why: 'test fixture, deliberately not in git' },
  { p: 'ffmpeg', why: 'pinned 8.1 binaries; re-downloadable but a faff to match' },
  // SIBLING folders, not in this repo and not git repos of their own — so
  // nothing else protects them at all. `from` is resolved against the repo's
  // parent; `p` is the name they take inside the backup.
  { p: 'FunSync-Discord', from: '../FunSync-Discord', why: 'Discord content pipeline (drafts/outbox/posted) — no git of its own' },
  { p: 'FunSync-Patreon', from: '../FunSync-Patreon', why: 'Patreon content pipeline (drafts/outbox/posted) — no git of its own' },
];

/** Regenerable — listed so the README can explain the omission honestly. */
const SKIPPED = [
  ['node_modules/', '~800M', 'npm install'],
  ['backend/.venv/', '~101M', 'python -m venv + pip install -r requirements.txt'],
  ['dist/', '~1.3G', 'npm run build'],
  ['build/', '~19M', 'npm run build'],
  ['backend-dist/', '~24M', 'PyInstaller (see notes/RELEASE.md)'],
  ['**/__pycache__/, .pytest_cache/', '-', 'regenerated on next run'],
  ['*.log, eroscripts-debug.log', '-', 'runtime logs, not data'],
  ['thumbs/, scripts_cache/, .funsync/', '-', 'runtime caches, rebuilt on demand'],
];

const args = new Set(process.argv.slice(2));
const PRUNE = args.has('--prune');
const DRY = args.has('--dry-run');

let copied = 0; let skipped = 0; let bytes = 0;
const extras = [];

/** Same size AND mtime is treated as unchanged — ffmpeg is 193MB. */
function unchanged(src, dst) {
  try {
    const a = fs.statSync(src); const b = fs.statSync(dst);
    return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000;
  } catch { return false; }
}

function copyFile(src, dst) {
  if (unchanged(src, dst)) { skipped += 1; return; }
  if (!DRY) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime); // preserve mtime so the next run skips it
  }
  copied += 1;
  bytes += fs.statSync(src).size;
}

function walk(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      walk(src, dst);
    } else if (entry.isFile()) {
      copyFile(src, dst);
    }
  }
  if (!fs.existsSync(dstDir)) return;
  // Report (or prune) anything in the backup that's no longer in the repo.
  for (const entry of fs.readdirSync(dstDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    if (fs.existsSync(src)) continue;
    const rel = path.relative(DEST, path.join(dstDir, entry.name));
    extras.push(rel);
    if (PRUNE && !DRY) fs.rmSync(path.join(dstDir, entry.name), { recursive: true, force: true });
  }
}

console.log(`Backing up ignored files\n  from ${REPO}\n  to   ${DEST}${DRY ? '  (dry run)' : ''}\n`);

for (const { p, from } of INCLUDE) {
  const src = from ? path.resolve(REPO, from) : path.join(REPO, p);
  if (!fs.existsSync(src)) { console.log(`  -- ${p} (absent, skipped)`); continue; }
  const dst = path.join(DEST, p);
  if (fs.statSync(src).isDirectory()) walk(src, dst);
  else copyFile(src, dst);
  console.log(`  ok ${p}`);
}

writeReadme();

console.log(`\n${copied} file(s) copied, ${skipped} unchanged, ${(bytes / 1e6).toFixed(1)} MB written.`);
if (extras.length) {
  console.log(
    `\n${extras.length} file(s) in the backup are no longer in the repo` +
    `${PRUNE ? ' — PRUNED.' : '. Left in place; pass --prune to remove them:'}`
  );
  if (!PRUNE) for (const e of extras.slice(0, 20)) console.log(`  ${e}`);
}

function writeReadme() {
  const lines = [
    '# FunSync backup — git-ignored files',
    '',
    'Regenerate with `node scripts/backup-ignored.mjs` from the repo.',
    'Additive by default; `--prune` mirrors deletions.',
    '',
    '**To restore:** `git clone` the repo, copy these folders back over the',
    'clone, then `npm install` and rebuild the Python venv.',
    '',
    '## What is here',
    '',
    ...INCLUDE.map(({ p, from, why }) => `- \`${p}\`${from ? ` (from \`${from}\`)` : ''} — ${why}`),
    '',
    '## Deliberately NOT here',
    '',
    'These are ignored by git too, but a clone plus a package manager brings',
    'them back. Copying them would add ~3GB that goes stale immediately.',
    '',
    '| Path | Size | Restore with |',
    '|---|---|---|',
    ...SKIPPED.map(([p, s, how]) => `| \`${p}\` | ${s} | \`${how}\` |`),
    '',
    '## Keeping it current',
    '',
    '**If you change `.gitignore`, re-run the script — and if the new entry is',
    "something a clone can't regenerate, add it to `INCLUDE` in",
    '`scripts/backup-ignored.mjs` first.** The script is the source of truth',
    'for what gets backed up; this file is generated from it.',
    '',
    `_Generated ${new Date().toISOString().slice(0, 10)}._`,
    '',
  ];
  if (DRY) return;
  fs.mkdirSync(DEST, { recursive: true });
  fs.writeFileSync(path.join(DEST, 'README.md'), lines.join('\n'), 'utf8');
}
