// Which knowledge-base notes have gone stale?
//
// The failure mode of a vault is not being wrong, it is being CONFIDENTLY
// wrong: a well-written stale note is more persuasive than the code, so it
// misleads harder than no note at all. That is exactly how notes/CLAUDE.md
// rotted into something that needs a list of claims to distrust.
//
// Keeping notes current cannot rely on discipline, because the moment you
// forget is precisely the moment the note becomes dangerous. So make
// staleness COMPUTABLE instead:
//
//   each note declares  owns: [glob, ...]  and  verified-against: <sha>
//   → if any owned file has commits newer than that sha, the note is suspect
//
// It reports uncommitted changes to owned files separately, because the vault
// can only ever describe committed state — a note can be perfectly current and
// still not mention what happened an hour ago.
//
// This does NOT check whether a note is CORRECT. It checks whether the ground
// moved under it. That is a much weaker claim and a much more reliable one.
//
//   node scripts/vault-freshness.mjs           # report
//   node scripts/vault-freshness.mjs --quiet   # only stale notes
//   node scripts/vault-freshness.mjs --stamp "Device Layer"   # re-stamp a note

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = path.resolve(ROOT, '..', 'Funsync knowledgebase', 'Player Systems');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const STAMP = args.includes('--stamp') ? args[args.indexOf('--stamp') + 1] : null;

const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim();

/** Minimal frontmatter reader — enough for the keys this uses, no YAML dep. */
function readFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const out = {};
  let key = null;
  for (const line of block.split('\n')) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const val = kv[2].trim();
      // Inline list:  owns: [a, b]
      if (val.startsWith('[') && val.endsWith(']')) {
        out[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else if (val === '' || val === '>-' || val === '|') {
        out[key] = [];   // block scalar or start of a block list
      } else {
        out[key] = val.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    // Block list item:  - value
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(item[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return out;
}

function notes() {
  if (!fs.existsSync(VAULT)) {
    console.error(`Vault not found: ${VAULT}`);
    process.exit(1);
  }
  return fs.readdirSync(VAULT)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const file = path.join(VAULT, f);
      const text = fs.readFileSync(file, 'utf8');
      return { name: f.replace(/\.md$/, ''), file, text, fm: readFrontmatter(text) };
    });
}

/** Commits touching a note's owned paths since its stamp. */
function commitsSince(sha, owns) {
  if (!owns.length) return [];
  const paths = owns.map((p) => `"${p}"`).join(' ');
  try {
    const out = git(`log --oneline ${sha}..HEAD -- ${paths}`);
    return out ? out.split('\n') : [];
  } catch {
    return null;   // bad sha
  }
}

/** Uncommitted changes to a note's owned paths. */
function dirtyFiles(owns) {
  if (!owns.length) return [];
  const paths = owns.map((p) => `"${p}"`).join(' ');
  try {
    const out = git(`status --porcelain -- ${paths}`);
    return out ? out.split('\n').map((l) => l.trim()) : [];
  } catch {
    return [];
  }
}

function stampNote(name) {
  const note = notes().find((n) => n.name === name);
  if (!note) {
    console.error(`No note called "${name}" in ${VAULT}`);
    process.exit(1);
  }
  const sha = git('rev-parse --short HEAD');
  const today = new Date(git('log -1 --format=%cI')).toISOString().slice(0, 10);
  let text = note.text;
  if (/^verified-against:.*$/m.test(text)) {
    text = text.replace(/^verified-against:.*$/m, `verified-against: ${sha}`);
    text = text.replace(/^verified-on:.*$/m, `verified-on: ${today}`);
  } else {
    text = text.replace(/^---\n/, `---\nverified-against: ${sha}\nverified-on: ${today}\n`);
  }
  fs.writeFileSync(note.file, text, 'utf8');
  console.log(`Stamped "${name}" → ${sha} (${today})`);
}

function main() {
  if (STAMP) return stampNote(STAMP);

  const all = notes();
  const stale = [];
  const unstamped = [];
  const dirty = [];
  const fresh = [];

  for (const note of all) {
    const owns = Array.isArray(note.fm.owns) ? note.fm.owns : [];
    const sha = note.fm['verified-against'];

    if (!owns.length) continue;              // note claims no code — nothing to check
    if (!sha) { unstamped.push({ note, owns }); continue; }

    const commits = commitsSince(sha, owns);
    if (commits === null) {
      unstamped.push({ note, owns, reason: `unknown sha ${sha}` });
      continue;
    }
    const pending = dirtyFiles(owns);
    if (pending.length) dirty.push({ note, pending });
    if (commits.length) stale.push({ note, commits, sha });
    // A note can be current against COMMITTED code and still have pending
    // work in its files. Listing it as CURRENT there reads as "nothing to
    // do", so dirty notes are reported once, in the dirty section only.
    else if (!pending.length) fresh.push(note);
  }

  const line = (s) => console.log(s);

  if (stale.length) {
    line(`\n  STALE — owned files changed since the note was verified\n`);
    for (const { note, commits, sha } of stale) {
      line(`  ${note.name}  (verified at ${sha}, ${commits.length} commit(s) since)`);
      for (const c of commits.slice(0, 6)) line(`      ${c}`);
      if (commits.length > 6) line(`      … and ${commits.length - 6} more`);
      line('');
    }
  }

  if (dirty.length) {
    line(`  UNCOMMITTED work in owned files — invisible to the vault by definition\n`);
    for (const { note, pending } of dirty) {
      line(`  ${note.name}  (${pending.length} file(s))`);
      for (const p of pending.slice(0, 5)) line(`      ${p}`);
      if (pending.length > 5) line(`      … and ${pending.length - 5} more`);
      line('');
    }
  }

  if (!QUIET) {
    if (unstamped.length) {
      line(`  NOT STAMPED — add verified-against to enable checking\n`);
      for (const { note, reason } of unstamped) {
        line(`  ${note.name}${reason ? `  (${reason})` : ''}`);
      }
      line('');
    }
    if (fresh.length) {
      line(`  CURRENT (${fresh.length}): ${fresh.map((n) => n.name).join(', ')}\n`);
    }
  }

  if (!stale.length && !dirty.length) line('\n  All stamped notes are current against committed code.\n');

  // Advisory only. A stale note is a prompt to re-read, not a build failure —
  // exiting non-zero here would make it tempting to skip the check entirely.
  process.exit(0);
}

main();
