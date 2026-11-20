'use strict';

// Stash "next" lot (2026-11-19, DESIGN-stash-s1.md appendix (j) #5; Dave:
// an OPT-IN setting, settings.stash.useTagRules, off by default): Stash's
// tag aliases and tag hierarchy as the rules the renderer's tag engine
// takes (renderer/js/video-tags.js compileTagRules, the stage sn-tags):
//
//   tagRules = {
//     aliases:  { [aliasSlug]: canonicalTagKey },
//     children: { [parentTagKey]: [childTagKey, ...] },
//     names:    { [tagKey]: "Stash's name" },   (sn-tags asked, 2026-11-19)
//   }
//
// `names` holds EVERY tag of the tree (a parent no linked scene carries
// too), so the renderer can show a key it has no video for. Two tags whose
// names fold to one key: the one with the lowest Stash id names it.
//
// A tag's key is tagSlug(its Stash name): the key the engine gives that
// Stash tag. `tagSlug` here is the twin of video-tags.js tagSlug (main
// cannot import the renderer's ES module); tests/unit/stash-next-tag-rules
// .test.js runs both over the same names, so a change to one fails there.
//
// Pure: no I/O, no clock. The rules, each a guard with a test:
//   - An alias that two tags claim (after folding), or that is itself a
//     tag's name, is left out: an alias never relabels a real tag, and an
//     unclear one relabels nothing.
//   - `children` lists EVERY tag below a parent (children, their children,
//     ...), as Stash's "include sub-tags" does; a loop in the data (Stash
//     refuses one, a hand-edited file may not) ends where it repeats. At
//     most MAX_DESCENDANTS per parent.
//   - Two Stash tags whose names fold to one key are one key here: their
//     aliases and children join.

const MAX_TAGS = 20000;
const MAX_DESCENDANTS = 1000;
const COMBINING_RE = /[̀-ͯ]/g; // the combining diacritical marks (video-tags.js)

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** video-tags.js foldForMatch's twin. */
function foldForMatch(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return String(text)
    .normalize('NFKD').replace(COMBINING_RE, '').normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * video-tags.js tagSlug's twin: folded, with spaces and underscores as
 * single dashes. `Blow Job`, `blow_job` and `BLOW-JOB` are all `blow-job`.
 *
 * @param {unknown} text
 * @returns {string}
 */
function tagSlug(text) {
  return foldForMatch(text)
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The renderer's rules from the stored tag tree of ONE server.
 *
 * @param {Object<string, {name: string, aliases?: string[], parentIds?: string[]}>|Array<{id: string, name: string, aliases?: string[], parentIds?: string[]}>} tags
 *   the tree by Stash id (library.json `tagTrees[server].tags`), or a list
 * @returns {{aliases: Object<string, string>, children: Object<string, string[]>, names: Object<string, string>}}
 */
function buildTagRules(tags) {
  const raw = Array.isArray(tags)
    ? tags
    : (isPlainObject(tags) ? Object.entries(tags).map(([id, t]) => (isPlainObject(t) ? { ...t, id: t.id ?? id } : null)) : []);
  // Lowest Stash id first (numeric ids as numbers), so a shared key is named
  // the same way every time.
  const byId = (a, b) => {
    const na = /^\d+$/.test(a.id) ? Number(a.id) : NaN;
    const nb = /^\d+$/.test(b.id) ? Number(b.id) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const list = raw.filter((t) => isPlainObject(t) && typeof t.id === 'string' && t.id).sort(byId);
  const keyOf = new Map();      // Stash id -> key
  const parentsOf = new Map();  // Stash id -> [Stash id]
  const names = new Set();      // every tag's key
  const display = {};           // key -> Stash's name (the lowest id's)
  const claims = new Map();     // alias slug -> Set of keys
  for (const t of list.slice(0, MAX_TAGS)) {
    const name = typeof t.name === 'string' ? t.name : '';
    const key = tagSlug(name);
    if (!key) continue;
    keyOf.set(t.id, key);
    if (!names.has(key)) display[key] = name.normalize('NFC').replace(/\s+/g, ' ').trim();
    names.add(key);
    parentsOf.set(t.id, Array.isArray(t.parentIds) ? t.parentIds.filter((p) => typeof p === 'string' && p) : []);
    for (const alias of Array.isArray(t.aliases) ? t.aliases : []) {
      const slug = tagSlug(typeof alias === 'string' ? alias : '');
      if (!slug || slug === key) continue;
      if (!claims.has(slug)) claims.set(slug, new Set());
      claims.get(slug).add(key);
    }
  }

  const aliases = {};
  for (const slug of [...claims.keys()].sort()) {
    const keys = claims.get(slug);
    // Two tags claim it, or it is a tag's own name: relabel nothing.
    if (keys.size !== 1 || names.has(slug)) continue;
    const [only] = keys;
    aliases[slug] = only;
  }

  // Direct children by key, then every tag below each parent.
  const direct = new Map(); // key -> Set of keys
  for (const [id, parents] of parentsOf) {
    const child = keyOf.get(id);
    for (const pid of parents) {
      const parent = keyOf.get(pid);
      if (!parent || parent === child) continue;
      if (!direct.has(parent)) direct.set(parent, new Set());
      direct.get(parent).add(child);
    }
  }
  const children = {};
  for (const parent of [...direct.keys()].sort()) {
    const out = [];
    const seen = new Set([parent]);
    const queue = [...direct.get(parent)];
    while (queue.length && out.length < MAX_DESCENDANTS) {
      const k = queue.shift();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      for (const next of direct.get(k) || []) if (!seen.has(next)) queue.push(next);
    }
    if (out.length) children[parent] = out;
  }
  return { aliases, children, names: display };
}

module.exports = {
  MAX_TAGS,
  MAX_DESCENDANTS,
  foldForMatch,
  tagSlug,
  buildTagRules,
};
