#!/usr/bin/env node
/* Release-stats diff — compare two snapshots from release-stats.mjs and
 * report net-new downloads + auto-update-poll velocity (DAU proxy).
 *
 * Usage:
 *   node scripts/release-stats-diff.mjs
 *     # auto-pick: oldest + newest snapshots in notes/release-stats/
 *
 *   node scripts/release-stats-diff.mjs older.json
 *     # diff `release-stats-latest.json` against the given older file
 *
 *   node scripts/release-stats-diff.mjs older.json newer.json
 *     # diff the two explicit files
 *
 *   node scripts/release-stats-diff.mjs --json [...]
 *     # emit JSON to stdout instead of a human-readable table
 *
 * What it shows:
 *   - days_elapsed between the two snapshots
 *   - per-version: Δ installers, Δ auto-update polls, polls/day (DAU proxy),
 *     installers/day (acquisition velocity)
 *   - new versions: any version present in `b` but missing from `a`
 *     (i.e. shipped in the interval), flagged distinctly
 *   - totals row at the bottom (all versions combined)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = 'notes/release-stats';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const fileArgs = args.filter((a) => a !== '--json');

function pad(s, n, right = false) {
  s = String(s);
  const space = ' '.repeat(Math.max(0, n - s.length));
  return right ? space + s : s + space;
}

function fmtSigned(n) {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : `${n}`;
}

function discoverSnapshots() {
  // Find dated snapshots in the default dir. We skip
  // `release-stats-latest.json` because it's a rolling alias of the
  // newest dated file — using it would compare a file with itself.
  let entries;
  try {
    entries = readdirSync(DEFAULT_DIR);
  } catch (err) {
    console.error(`Cannot read ${DEFAULT_DIR}: ${err.message}`);
    console.error('Run `node scripts/release-stats.mjs` at least twice on different days to build up snapshots, or pass file paths explicitly.');
    process.exit(1);
  }
  const dated = entries
    .filter((f) => /^release-stats-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({ path: join(DEFAULT_DIR, f), mtime: statSync(join(DEFAULT_DIR, f)).mtime }))
    .sort((a, b) => a.mtime - b.mtime);
  if (dated.length < 2) {
    console.error(`Need at least 2 dated snapshots in ${DEFAULT_DIR}, found ${dated.length}.`);
    console.error('Run `node scripts/release-stats.mjs` again on a different day to build a baseline, or pass file paths explicitly.');
    process.exit(1);
  }
  return [dated[0].path, dated[dated.length - 1].path];
}

let aPath;
let bPath;
if (fileArgs.length === 0) {
  [aPath, bPath] = discoverSnapshots();
} else if (fileArgs.length === 1) {
  aPath = fileArgs[0];
  bPath = join(DEFAULT_DIR, 'release-stats-latest.json');
} else {
  [aPath, bPath] = fileArgs;
}

function loadSnapshot(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Failed to load ${p}: ${err.message}`);
    process.exit(1);
  }
}

const a = loadSnapshot(aPath);
const b = loadSnapshot(bPath);

// Defensive: detect swapped args. We want `a` to be the older snapshot
// so deltas read as "new since baseline" — if the user passed them in
// the wrong order, swap silently rather than report negative deltas.
let swapped = false;
if (Date.parse(a.fetched_at) > Date.parse(b.fetched_at)) {
  const tmp = a; const tmpPath = aPath;
  // eslint-disable-next-line no-unused-vars
  const _ = tmp;
  // Reassign (declared with const above, so we swap the references via fresh let-bound holders below)
  swapped = true;
}
const older = swapped ? b : a;
const newer = swapped ? a : b;
const olderPath = swapped ? bPath : aPath;
const newerPath = swapped ? aPath : bPath;

const olderTime = Date.parse(older.fetched_at);
const newerTime = Date.parse(newer.fetched_at);
const elapsedDays = Math.max(0.01, (newerTime - olderTime) / 86_400_000);
const elapsedRounded = Math.round(elapsedDays * 10) / 10;

// Build per-version diff. Index by tag_name; b-only versions are "new
// releases shipped during the interval".
const byVersionA = new Map(older.summary.map((s) => [s.version, s]));
const byVersionB = new Map(newer.summary.map((s) => [s.version, s]));

const versions = [...new Set([...byVersionA.keys(), ...byVersionB.keys()])];

const diffRows = versions.map((v) => {
  const av = byVersionA.get(v);
  const bv = byVersionB.get(v);
  const newlyReleased = !av && !!bv;
  // For brand-new releases, the "delta" IS the absolute count — there's
  // no baseline to subtract from.
  const dInstaller = (bv?.installer || 0) - (av?.installer || 0);
  const dPolls = (bv?.auto_update_polls || 0) - (av?.auto_update_polls || 0);
  const dWindows = (bv?.windows || 0) - (av?.windows || 0);
  const dLinux = (bv?.linux || 0) - (av?.linux || 0);
  return {
    version: v,
    published: bv?.published || av?.published,
    newly_released: newlyReleased,
    delta_installer: dInstaller,
    delta_polls: dPolls,
    delta_windows: dWindows,
    delta_linux: dLinux,
    installers_per_day: dInstaller / elapsedDays,
    polls_per_day: dPolls / elapsedDays,
    total_installer_now: bv?.installer || 0,
    total_polls_now: bv?.auto_update_polls || 0,
  };
}).filter((r) => r.delta_installer !== 0 || r.delta_polls !== 0 || r.newly_released);

// Sort: newest published version first, so most-relevant rows are on top
diffRows.sort((x, y) => (x.published < y.published ? 1 : -1));

const totals = diffRows.reduce(
  (acc, r) => ({
    delta_installer: acc.delta_installer + r.delta_installer,
    delta_polls: acc.delta_polls + r.delta_polls,
    delta_windows: acc.delta_windows + r.delta_windows,
    delta_linux: acc.delta_linux + r.delta_linux,
  }),
  { delta_installer: 0, delta_polls: 0, delta_windows: 0, delta_linux: 0 },
);

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    older: { path: olderPath, fetched_at: older.fetched_at },
    newer: { path: newerPath, fetched_at: newer.fetched_at },
    elapsed_days: elapsedDays,
    diff: diffRows,
    totals: {
      ...totals,
      installers_per_day: totals.delta_installer / elapsedDays,
      polls_per_day: totals.delta_polls / elapsedDays,
    },
  }, null, 2) + '\n');
  process.exit(0);
}

// Human-readable output.
console.log('');
console.log(`older  ${olderPath}`);
console.log(`         fetched ${older.fetched_at}`);
console.log(`newer  ${newerPath}`);
console.log(`         fetched ${newer.fetched_at}`);
console.log(`elapsed  ${elapsedRounded} days`);
console.log('');

if (diffRows.length === 0) {
  console.log('No changes between snapshots.');
  process.exit(0);
}

// Column widths picked so the table stays under 80 cols and aligns
// numerals on the right for easy scanning.
console.log('  ' +
  pad('version', 10) + ' ' +
  pad('published ', 12) + ' ' +
  pad('Δinstall', 10, true) + ' ' +
  pad('Δpolls', 10, true) + ' ' +
  pad('inst/day', 10, true) + ' ' +
  pad('polls/day', 10, true) + ' ' +
  'flag',
);
console.log('  ' + '-'.repeat(76));

for (const r of diffRows) {
  const flag = r.newly_released ? 'NEW' : '';
  console.log('  ' +
    pad(r.version, 10) + ' ' +
    pad(r.published, 12) + ' ' +
    pad(fmtSigned(r.delta_installer), 10, true) + ' ' +
    pad(fmtSigned(r.delta_polls), 10, true) + ' ' +
    pad((r.installers_per_day || 0).toFixed(1), 10, true) + ' ' +
    pad((r.polls_per_day || 0).toFixed(1), 10, true) + ' ' +
    flag,
  );
}

console.log('  ' + '-'.repeat(76));
console.log('  ' +
  pad('TOTAL', 10) + ' ' +
  pad('', 12) + ' ' +
  pad(fmtSigned(totals.delta_installer), 10, true) + ' ' +
  pad(fmtSigned(totals.delta_polls), 10, true) + ' ' +
  pad((totals.delta_installer / elapsedDays).toFixed(1), 10, true) + ' ' +
  pad((totals.delta_polls / elapsedDays).toFixed(1), 10, true),
);

const newReleases = diffRows.filter((r) => r.newly_released);
if (newReleases.length > 0) {
  console.log(`\nNew releases shipped in the interval: ${newReleases.map((r) => r.version).join(', ')}`);
}

// Platform split — useful for tracking whether Linux is gaining share.
const platformPct = (n, total) => total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
const totalDownloads = totals.delta_windows + totals.delta_linux;
if (totalDownloads !== 0) {
  console.log(
    `\nPlatform split (net new): Windows ${fmtSigned(totals.delta_windows)} (${platformPct(totals.delta_windows, totalDownloads)})  ` +
    `Linux ${fmtSigned(totals.delta_linux)} (${platformPct(totals.delta_linux, totalDownloads)})`,
  );
}

console.log(
  `\nPolls/day across all versions is your daily-active-users proxy. Auto-update ` +
  `polls happen on each app launch when an installed copy checks for a newer version.`,
);
