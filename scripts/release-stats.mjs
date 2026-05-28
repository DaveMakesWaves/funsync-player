#!/usr/bin/env node
/* Release-stats snapshot — pulls GitHub release download counts via the
 * `gh` CLI and writes a structured JSON snapshot. Run periodically to
 * build up a time series; diffing two snapshots gives you per-week net
 * new downloads + auto-update-poll velocity (DAU proxy).
 *
 * Usage:
 *   node scripts/release-stats.mjs                 # default repo + dir
 *   node scripts/release-stats.mjs path/to/outdir  # custom output dir
 *   RELEASE_STATS_REPO=other/repo node scripts/release-stats.mjs
 *
 * Output:
 *   <outdir>/release-stats-YYYY-MM-DD.json
 *   <outdir>/release-stats-latest.json   (copy of newest, stable path)
 *
 * Requirements:
 *   - gh CLI authenticated (`gh auth status`)
 *   - Node 18+ (uses native fetch nothing; spawnSync only)
 *
 * What the JSON contains:
 *   - fetched_at — ISO timestamp of this snapshot
 *   - repo, version_count
 *   - summary[] — per-version totals + bucketed counts:
 *         installer (.exe + .AppImage), blockmap, auto_update_poll
 *         (latest*.yml), windows, linux
 *   - assets[]  — flat list, every asset across every release
 *
 * GitHub doesn't expose per-download timestamps — only the rolling
 * total. So "when" downloads happened can only be inferred by
 * snapshotting periodically and diffing consecutive files.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.env.RELEASE_STATS_REPO || 'DaveMakesWaves/funsync-player';
const OUTDIR = process.argv[2] || 'notes/release-stats';
const TODAY = new Date().toISOString().slice(0, 10);
const OUTFILE = join(OUTDIR, `release-stats-${TODAY}.json`);
const LATEST = join(OUTDIR, 'release-stats-latest.json');

function classify(name) {
  if (name.endsWith('.yml')) return 'auto_update_poll';
  if (name.endsWith('.blockmap')) return 'blockmap';
  if (name.endsWith('.exe') || name.endsWith('.AppImage')) return 'installer';
  return 'other';
}

function daysSince(iso) {
  const ms = Date.now() - Date.parse(iso);
  return Math.floor(ms / 86_400_000);
}

function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - s.length));
}

/** Run `gh api --paginate` and parse all returned pages into one
 *  flattened array of release objects. */
function fetchReleases() {
  console.log(`Fetching releases for ${REPO}...`);
  const result = spawnSync(
    'gh',
    ['api', '--paginate', `repos/${REPO}/releases`],
    { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    console.error('gh api failed:', result.stderr || result.error?.message || 'unknown');
    process.exit(1);
  }
  // --paginate emits pages as concatenated JSON arrays (e.g. "[...][...]").
  // Split on the array boundary `][` and re-bracket so each chunk parses.
  const raw = result.stdout.trim();
  if (!raw) return [];
  const chunks = raw.split('][').map((c, i, arr) => {
    if (arr.length === 1) return c;
    if (i === 0) return c + ']';
    if (i === arr.length - 1) return '[' + c;
    return '[' + c + ']';
  });
  return chunks.flatMap((c) => JSON.parse(c));
}

const releases = fetchReleases();
console.log(`Got ${releases.length} releases.`);

const snapshot = {
  fetched_at: new Date().toISOString(),
  repo: REPO,
  version_count: releases.length,
  summary: releases.map((r) => {
    const published = (r.published_at || r.created_at).slice(0, 10);
    const sum = (pred) => r.assets.filter(pred).reduce((s, a) => s + a.download_count, 0);
    return {
      version: r.tag_name,
      published,
      days_old: daysSince(r.published_at || r.created_at),
      total: r.assets.reduce((s, a) => s + a.download_count, 0),
      installer: sum((a) => classify(a.name) === 'installer'),
      blockmap: sum((a) => classify(a.name) === 'blockmap'),
      auto_update_polls: sum((a) => classify(a.name) === 'auto_update_poll'),
      windows: sum((a) => a.name.endsWith('.exe') || a.name.endsWith('.exe.blockmap')),
      linux: sum((a) => a.name.endsWith('.AppImage')),
    };
  }),
  assets: releases.flatMap((r) => {
    const published = (r.published_at || r.created_at).slice(0, 10);
    return r.assets.map((a) => ({
      version: r.tag_name,
      published,
      name: a.name,
      kind: classify(a.name),
      downloads: a.download_count,
      uploaded: a.created_at.slice(0, 10),
      updated: a.updated_at.slice(0, 10),
      size_mb: Math.floor(a.size / 1_048_576),
    }));
  }),
};

mkdirSync(OUTDIR, { recursive: true });
writeFileSync(OUTFILE, JSON.stringify(snapshot, null, 2) + '\n');
copyFileSync(OUTFILE, LATEST);

// Brief stdout summary so a manual invocation gives immediate signal.
const size = statSync(OUTFILE).size;
console.log(`\nWrote ${OUTFILE} (${size.toLocaleString()} bytes)`);
console.log('\nTop-line summary (newest first):');
console.log('  version    published    age    installers   polls');
console.log('  ' + '-'.repeat(56));
[...snapshot.summary]
  .sort((a, b) => (a.published < b.published ? 1 : -1))
  .forEach((s) => {
    console.log(
      '  ' + pad(s.version, 11) + s.published + '  ' +
      pad(s.days_old + 'd', 6) + ' ' +
      pad(s.installer, 12) + ' ' + s.auto_update_polls,
    );
  });

console.log(
  '\nRun again later to build a time series — diff two snapshots for ' +
  'net-new downloads + auto-update-poll velocity (DAU proxy).',
);
