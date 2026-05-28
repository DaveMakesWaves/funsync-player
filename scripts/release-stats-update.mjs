#!/usr/bin/env node
/* Release-stats update — one-shot wrapper that pulls a fresh snapshot
 * AND prints the diff against the previous snapshot. Use this as the
 * single command for a weekly / daily check-in:
 *
 *   node scripts/release-stats-update.mjs
 *
 * What it does:
 *   1. Captures the most recent dated snapshot BEFORE pulling — this
 *      becomes the baseline. If today's file already exists (you ran
 *      the script earlier today), the baseline is the most recent
 *      file that is NOT today's.
 *   2. Runs `release-stats.mjs` to fetch a fresh snapshot from GitHub.
 *   3. If a baseline exists, runs `release-stats-diff.mjs <baseline>
 *      <new>` so the diff is "since the last time you ran this", NOT
 *      "since the very first snapshot ever".
 *   4. If no baseline exists (first ever run), tells you so and exits.
 *
 * Why the wrapper exists:
 *   The auto-discover in `release-stats-diff.mjs` picks the OLDEST and
 *   NEWEST dated files — useful for "all-time growth" but the wrong
 *   read for incremental tracking. This wrapper picks the "previous
 *   run" baseline so the diff reads as "what changed this week".
 *
 * Pass-through args:
 *   Any args you give this script are forwarded to both child scripts.
 *   For instance, `--json` makes the diff emit JSON instead of a table:
 *     node scripts/release-stats-update.mjs --json > weekly.json
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'notes/release-stats';
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_PATH = join(DIR, `release-stats-${TODAY}.json`);
const FORWARD_ARGS = process.argv.slice(2);
const JSON_MODE = FORWARD_ARGS.includes('--json');

/**
 * Find the dated snapshot we should use as the baseline. Run BEFORE
 * the pull so today's file (if it exists) doesn't get picked as its
 * own baseline.
 */
function findBaseline() {
  if (!existsSync(DIR)) return null;
  const dated = readdirSync(DIR)
    .filter((f) => /^release-stats-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({ path: join(DIR, f), file: f, mtime: statSync(join(DIR, f)).mtime }))
    // Skip today's file — we want the snapshot from BEFORE this run.
    // If we picked today, we'd be diffing the file against itself
    // after the pull overwrites it.
    .filter((entry) => entry.file !== `release-stats-${TODAY}.json`)
    .sort((a, b) => b.mtime - a.mtime); // newest first
  return dated[0]?.path || null;
}

function run(script, args = []) {
  const result = spawnSync('node', [script, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const baseline = findBaseline();

if (!JSON_MODE) {
  if (baseline) {
    console.log(`Baseline (previous run): ${baseline}`);
  } else {
    console.log('No previous snapshot found — this is your first run.');
  }
  console.log('');
}

// Step 1: pull a fresh snapshot. Forward only non-diff-specific args.
run('scripts/release-stats.mjs');

if (!baseline) {
  console.log('');
  console.log('Saved your first snapshot. Run this command again next week ' +
              'to see a diff and start a trend.');
  process.exit(0);
}

if (!JSON_MODE) {
  console.log('');
  console.log('--- Diff vs. previous run ---');
}

// Step 2: diff baseline against today's new snapshot.
run('scripts/release-stats-diff.mjs', [baseline, TODAY_PATH, ...FORWARD_ARGS]);
