#!/usr/bin/env node
// Check the vendored device specs in the knowledge base against upstream.
//
// FunSync talks to four device ecosystems and Dave owns a fraction of the
// hardware. The vendor documentation is therefore the only way to know what a
// device can do before a user reports that it does not work — see
// `Device Reference/Device Specs.md` for what each file is and why it matters.
//
// Specs move. This tells you when, by comparing a SHA-256 of the live file
// against the one recorded when it was vendored.
//
//   npm run specs:check     report drift
//   npm run specs:update    re-download anything that drifted, restamp
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(HERE, '..', '..', 'Funsync knowledgebase', 'Device Reference');
const SPECS = path.join(VAULT, 'specs');
const MANIFEST = path.join(SPECS, 'manifest.json');
const UPDATE = process.argv.includes('--update');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** developers.autoblow.com serves rendered HTML, not a spec file. */
function htmlToText(buf, title) {
  let t = buf.toString('utf8');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return Buffer.from(`# ${title}\n\n${t}\n`, 'utf8');
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let drifted = 0;
  let failed = 0;

  for (const entry of manifest.specs) {
    const local = path.join(SPECS, entry.file);
    process.stdout.write(`  ${entry.file.padEnd(42)}`);
    let live;
    try {
      live = await fetchText(entry.url);
    } catch (err) {
      console.log(`UNREACHABLE (${err.message})`);
      failed++;
      continue;
    }
    if (entry.transform === 'html-to-text') live = htmlToText(live, entry.title);

    const liveHash = sha(live);
    if (liveHash === entry.sha256) {
      console.log('unchanged');
      continue;
    }

    drifted++;
    const oldSize = fs.existsSync(local) ? fs.statSync(local).size : 0;
    console.log(`CHANGED  (${oldSize} -> ${live.length} bytes)`);
    if (UPDATE) {
      fs.writeFileSync(local, live);
      entry.sha256 = liveHash;
      entry.fetched = new Date().toISOString().slice(0, 10);
      console.log(`      updated and restamped`);
    }
  }

  if (UPDATE && drifted) {
    manifest.checked = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  }

  console.log(`\n  ${manifest.specs.length} specs, ${drifted} changed, ${failed} unreachable`);
  if (drifted && !UPDATE) {
    console.log('  Run `npm run specs:update` to pull the new versions,');
    console.log('  then re-read Device Reference/Device Specs.md and note what actually changed.');
  }
  // Never fail the build on this: an upstream outage is not our problem, and
  // a spec change is news to read, not an error to block on.
  process.exit(0);
}

main();
