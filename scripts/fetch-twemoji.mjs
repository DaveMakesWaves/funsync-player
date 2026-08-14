// Vendor the Twemoji SVGs our category-icon catalogue uses.
//
// Dave: "can we not use the same emoji pack as eroscripts does for user
// parity?"
//
// EroScripts is Discourse, and Discourse's default emoji set is Twemoji —
// confirmed by the images it serves: /images/emoji/twitter/heart.png. Font
// rendering can never match that, because it hands the decision to whatever
// emoji font the OS happens to ship. Bundling the same artwork means every
// user sees the same emoji as the forum, on every platform.
//
// Source: https://github.com/jdecked/twemoji — the maintained fork, after
// Twitter abandoned the original. Graphics are CC-BY 4.0 (see the NOTICE
// written alongside the assets); the code is MIT and we use none of it.
//
// Re-run with:  node scripts/fetch-twemoji.mjs
// Add emoji to renderer/js/emoji-catalog.js first; this only fetches what
// the catalogue references, not all ~3,800 Twemoji files.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'renderer', 'assets', 'emoji');
const BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg';
const CONCURRENCY = 12;

/**
 * Twemoji's filename convention: lowercase hex code points joined by '-'.
 *
 * U+FE0F (the variation selector we add to force colour presentation) is
 * STRIPPED from the filename — Twemoji assets are colour by definition, so
 * the selector is redundant there. Keycaps are the exception and we have
 * none, but the fetch falls back to the unstripped name anyway rather than
 * assuming.
 */
export function twemojiCandidates(emoji) {
  const cps = [...emoji].map((c) => c.codePointAt(0).toString(16));
  const stripped = cps.filter((c) => c !== 'fe0f');
  const names = [stripped.join('-')];
  if (stripped.length !== cps.length) names.push(cps.join('-'));
  return names;
}

/**
 * Strip import declarations, and any top-level statement that uses what they
 * bound, from an ES module's source.
 *
 * The catalogue is evaluated below as a `data:` URL, which CANNOT resolve
 * relative specifiers — `./emoji-asset.js` throws ERR_UNSUPPORTED_RESOLVE_REQUEST
 * because a data: URL has no hierarchical base to resolve against. That is not
 * an accident to work around by importing the file directly: this script must
 * run on a FRESH CLONE, where `emoji-assets-manifest.js` does not exist yet
 * because this script is what generates it. Loading the real module would be a
 * chicken-and-egg failure, and would drag browser-side code into a build step.
 *
 * We only want the plain data (EMOJI_GROUPS / ALL_EMOJI), so dropping the
 * imports and their call sites is sound. Generic rather than hardcoding the
 * current two, so adding an import to the catalogue doesn't break the build
 * again — which is exactly how v0.9.1 failed CI on both platforms.
 */
export function stripImports(src) {
  const bound = new Set();
  // import ... from '...';  — may span lines, e.g. a multi-name brace list.
  const withoutImports = src.replace(
    /^import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?[ \t]*$/gm,
    (_m, clause) => {
      for (const name of clause.replace(/[{}]/g, ' ').split(',')) {
        const id = name.trim().split(/\s+as\s+/).pop().trim();
        if (id) bound.add(id);
      }
      return '';
    },
  );
  if (bound.size === 0) return withoutImports;
  // Drop top-level statements that reference an imported binding, e.g. the
  // `registerAvailableAssets(BUNDLED_EMOJI_ASSETS);` side-effect call.
  const uses = new RegExp(`\\b(?:${[...bound].join('|')})\\b`);
  return withoutImports
    .split('\n')
    .filter((line) => !(uses.test(line) && !line.trim().startsWith('//')))
    .join('\n');
}

export async function loadCatalogue() {
  const src = await fs.readFile(
    path.join(ROOT, 'renderer', 'js', 'emoji-catalog.js'),
    'utf8',
  );
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(stripImports(src)).toString('base64')}`
  );
  return mod.ALL_EMOJI;
}

async function fetchOne(emoji) {
  for (const name of twemojiCandidates(emoji)) {
    const res = await fetch(`${BASE}/${name}.svg`);
    if (res.ok) {
      const svg = await res.text();
      await fs.writeFile(path.join(OUT_DIR, `${name}.svg`), svg, 'utf8');
      return { emoji, name, ok: true };
    }
  }
  return { emoji, name: twemojiCandidates(emoji)[0], ok: false };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const all = await loadCatalogue();
  console.log(`Catalogue references ${all.length} emoji.`);

  const results = [];
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const batch = all.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map(fetchOne)));
    process.stdout.write(`\r  fetched ${Math.min(i + CONCURRENCY, all.length)}/${all.length}`);
  }
  process.stdout.write('\n');

  const missing = results.filter((r) => !r.ok);
  console.log(`Saved ${results.length - missing.length} SVGs to ${path.relative(ROOT, OUT_DIR)}`);
  if (missing.length) {
    console.log(`\n${missing.length} NOT AVAILABLE in Twemoji — remove these from the catalogue:`);
    for (const m of missing) console.log(`  ${m.emoji}  (${m.name})`);
  }

  // Regenerate the manifest the renderer reads. It cannot look at the
  // filesystem, so this is how it knows which artwork actually shipped.
  const shipped = (await fs.readdir(OUT_DIR))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.replace(/\.svg$/, ''))
    .sort();
  await fs.writeFile(
    path.join(ROOT, 'renderer', 'js', 'emoji-assets-manifest.js'),
    [
      '// AUTO-GENERATED by scripts/fetch-twemoji.mjs — do not edit by hand.',
      '//',
      '// The Twemoji basenames actually bundled in renderer/assets/emoji/. Used so',
      "// the renderer can tell 'we have artwork for this' without touching the",
      '// filesystem, which it cannot do.',
      'export const BUNDLED_EMOJI_ASSETS = [',
      ...shipped.map((n) => `  "${n}",`),
      '];',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log(`Manifest updated: ${shipped.length} assets`);

  await fs.writeFile(
    path.join(OUT_DIR, 'NOTICE.txt'),
    [
      'Twemoji graphics bundled with FunSync Player.',
      '',
      'Source:  https://github.com/jdecked/twemoji',
      'Licence: CC-BY 4.0  https://creativecommons.org/licenses/by/4.0/',
      '',
      'Bundled so category emoji match the EroScripts forum (Discourse uses',
      'the same set) and look identical on every OS, rather than depending on',
      'whichever emoji font the system happens to ship.',
      '',
      'Regenerate with: node scripts/fetch-twemoji.mjs',
    ].join('\n'),
    'utf8',
  );
}

// Only fetch when run as a script. Without this guard, importing the module to
// test its helpers downloads 737 SVGs as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
