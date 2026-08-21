#!/usr/bin/env node
// Archive notes/UPDATES.md into per-release files.
//
// UPDATES.md is the append-at-top working changelog and the source for
// release notes. The convention has always been "cleared per release"; it
// never was, so by 2026-08-16 it held 143 entries and 5,750 lines still
// headed "Changes since v0.1.0". Dave: "archive updates.md per release".
//
// Entries move to notes/updates/v<X.Y.Z>.md, matched to the release they
// shipped in by date. What remains in UPDATES.md is genuinely unreleased.
//
// SAFETY
//   * Dry run by default. Pass --write to actually move anything.
//   * Writes notes/UPDATES.md.bak before touching the original.
//   * 37 of the entries carry no date. Because the file is newest-first,
//     each undated entry is BOUNDED by the nearest dated entry above and
//     below. When both bounds land in the same release it is filed with
//     confidence; when they straddle a boundary the entry is LEFT IN PLACE
//     and reported, because silently misfiling someone's changelog is worse
//     than leaving it for a human.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'notes', 'UPDATES.md');
const OUT_DIR = path.join(ROOT, 'notes', 'updates');
const WRITE = process.argv.includes('--write');

/** Release tags, oldest first, with their dates. */
function releases() {
  const raw = execSync(
    'git for-each-ref --sort=creatordate --format="%(refname:short)|%(creatordate:short)" refs/tags',
    { cwd: ROOT, encoding: 'utf8' },
  );
  return raw
    .split('\n')
    .map((l) => l.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((l) => {
      const [tag, date] = l.split('|');
      return { tag, date };
    })
    // Pre-releases share a window with their final; keep the finals only.
    .filter((r) => /^v\d+\.\d+\.\d+$/.test(r.tag));
}

/** Split the body into entries, preserving the header above the first one. */
function splitEntries(text) {
  const lines = text.split('\n');
  const firstEntry = lines.findIndex((l) => l.startsWith('## '));
  if (firstEntry === -1) return { header: text, entries: [] };
  const header = lines.slice(0, firstEntry).join('\n');
  const entries = [];
  let cur = null;
  for (const line of lines.slice(firstEntry)) {
    if (line.startsWith('## ')) {
      if (cur) entries.push(cur);
      cur = { head: line, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) entries.push(cur);
  return { header, entries };
}

const dateOf = (head) => (head.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;

/** Which release shipped a given date? Returns the tag, or null if after the last. */
function releaseFor(date, rels) {
  for (const r of rels) if (date <= r.date) return r.tag;
  return null; // after the newest tag = unreleased
}

function main() {
  const rels = releases();
  const text = fs.readFileSync(SRC, 'utf8');
  const { header, entries } = splitEntries(text);

  // Bound undated entries by their dated neighbours (file is newest-first).
  const dates = entries.map((e) => dateOf(e.head));
  const upper = [];   // nearest dated entry ABOVE (newer)
  let seen = null;
  for (let i = 0; i < entries.length; i++) { upper[i] = dates[i] || seen; if (dates[i]) seen = dates[i]; }
  const lower = [];   // nearest dated entry BELOW (older)
  seen = null;
  for (let i = entries.length - 1; i >= 0; i--) { lower[i] = dates[i] || seen; if (dates[i]) seen = dates[i]; }

  const buckets = new Map();
  const keep = [];
  const ambiguous = [];

  entries.forEach((e, i) => {
    const hi = upper[i];
    const lo = lower[i];
    if (!hi && !lo) { keep.push(e); return; }           // no evidence at all
    const relHi = releaseFor(hi || lo, rels);
    const relLo = releaseFor(lo || hi, rels);
    if (relHi !== relLo) { ambiguous.push({ e, relHi, relLo }); keep.push(e); return; }
    if (relHi === null) { keep.push(e); return; }        // unreleased
    if (!buckets.has(relHi)) buckets.set(relHi, []);
    buckets.get(relHi).push(e);
  });

  console.log(`entries: ${entries.length}`);
  console.log(`staying in UPDATES.md (unreleased): ${keep.length - ambiguous.length}`);
  console.log(`ambiguous, left in place for review: ${ambiguous.length}`);
  for (const a of ambiguous) console.log(`   ${a.relLo} .. ${a.relHi}  ${a.e.head.slice(0, 78)}`);
  console.log('\narchive:');
  for (const [tag, list] of [...buckets].sort()) console.log(`   ${tag.padEnd(10)} ${list.length} entries`);

  if (!WRITE) {
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  fs.copyFileSync(SRC, SRC + '.bak');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const [tag, list] of buckets) {
    const rel = rels.find((r) => r.tag === tag);
    const body = [
      `# ${tag} — engineering notes`,
      '',
      `Entries archived from \`notes/UPDATES.md\` that shipped **in or before ${tag}**`,
      `(tagged ${rel.date}). The oldest file necessarily absorbs everything written`,
      'before it, including releases that produced no entries of their own.',
      '',
      'Newest first, as written. The per-version index in the knowledge base',
      '(`Releases/`) is the short form; this is the long-form reasoning behind it.',
      '',
      '---',
      '',
      ...list.map((e) => e.lines.join('\n').replace(/\n+$/, '')),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, `${tag}.md`), body, 'utf8');
  }

  const remaining = [
    header.replace(/Changes since v[\d.]+ for the next release\./, `Changes since ${rels[rels.length - 1].tag} for the next release.`),
    ...keep.map((e) => e.lines.join('\n').replace(/\n+$/, '')),
    '',
  ].join('\n');
  fs.writeFileSync(SRC, remaining, 'utf8');

  console.log(`\nwrote ${buckets.size} archive file(s) to notes/updates/`);
  console.log(`UPDATES.md trimmed; original saved as UPDATES.md.bak`);
}

main();
