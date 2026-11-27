/**
 * Settings search (Dave, 2026-11-23: "if someone is looking for a setting
 * pertaining to a specific functionality ... they can type feed or
 * eroscripts ... we need to be forgiving with the search so that if people
 * don't know the name but know what it refers to it still appears").
 *
 * Pure: no DOM. settings-panel.js hands it what each row SAYS (label, hint,
 * the options of its select), the section it sits in, the words people use
 * for that section (the locale's `settingsPanel.search.aliases.*`) and the
 * area; it answers which rows match and how well.
 *
 * Forgiving, in this order:
 *  1. every word typed must be found somewhere in the row's words (AND, so
 *     "gap pattern" narrows instead of widening);
 *  2. a word is found as a whole word, the start of one ("notif"), the end
 *     of one typed in full ("notifications" finds "notify": a shared stem of
 *     4+ letters), or inside one (3+ letters; any length for CJK, which has
 *     no spaces);
 *  3. failing those, one slip in a 4-6 letter word, two in a longer one
 *     ("fulscreen", "notifcations", "hotkye").
 * Rows found only by a slip are dropped when anything matched exactly, so a
 * clean query is never padded with near misses.
 *
 * Accents and case never matter ("theme" finds "Thème" and the reverse).
 */

/** Lowercase, accents off, punctuation to spaces, one space between words. */
export function normalizeText(s) {
  // Only the accents of Latin, Greek and Cyrillic letters come off (é, ü,
  // ё); Japanese voicing marks stay (ド is not ト), and NFC puts Korean
  // syllables back together after NFKD took them apart.
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]+/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function words(s) {
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

// Han, Hiragana, Katakana, Hangul: written without spaces, so a word is
// found anywhere inside the text at any length.
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/u;

/**
 * Optimal string alignment distance, given up past `max` (returns max + 1).
 * One slip is a letter wrong, missing, extra, or two swapped.
 */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** How many slips a typed word may have. */
export function slipsAllowed(word) {
  if (word.length >= 7) return 2;
  if (word.length >= 4) return 1;
  return 0;
}

// The weight of each kind of find; a slip is worth least.
const KIND_SCORE = { exact: 10, prefix: 7, stem: 6, inside: 4, slip: 2 };

/** Longest shared start of two words. */
function sharedStart(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * How one typed word is found in a list of words (and their joined text):
 * 'exact' | 'prefix' | 'stem' | 'inside' | 'slip' | null.
 */
export function findWord(q, hayWords, hayText) {
  if (!q) return 'exact';
  let best = null;
  const better = (kind) => { if (!best || KIND_SCORE[kind] > KIND_SCORE[best]) best = kind; };
  for (const w of hayWords) {
    if (w === q) return 'exact';
    if (w.startsWith(q)) better('prefix');
    // "notifications" / "notify", "colours" / "colour", "shortcuts" /
    // "shortcut": the typed word and the row's word share a start of 4+
    // letters that is most of the shorter one. Both 5+ letters, so
    // "fullscreen" never finds "full".
    else if (q.length >= 5 && w.length >= 5) {
      const shared = sharedStart(q, w);
      if (shared >= 4 && shared >= Math.min(q.length, w.length) - 3) better('stem');
    }
  }
  if (best) return best;
  if ((q.length >= 3 || CJK.test(q)) && hayText.includes(q)) return 'inside';
  const slips = slipsAllowed(q);
  if (slips > 0) {
    for (const w of hayWords) {
      if (editDistance(q, w, slips) <= slips) return 'slip';
      // A word still being typed: compare with the row word's start.
      if (w.length > q.length && editDistance(q, w.slice(0, q.length), slips) <= slips) return 'slip';
    }
  }
  return null;
}

/**
 * Score one row against a query.
 * @param {string} query
 * @param {{ label?: string, text?: string, section?: string, aliases?: string, area?: string }} row
 *   label: the row's own name; text: its hint and options; section: its
 *   section's title; aliases: the words people use for it or its section;
 *   area: the rail area's name.
 * @returns {{ score: number, slipOnly: boolean }|null} null: not a match.
 */
export function scoreRow(query, row) {
  const qWords = words(query);
  if (!qWords.length) return null;
  const fields = [
    ['label', 3], ['section', 2], ['aliases', 2], ['text', 1], ['area', 1],
  ].map(([k, weight]) => {
    const n = normalizeText(row?.[k] ?? '');
    return { weight, text: n, words: n ? n.split(' ') : [] };
  });
  let score = 0;
  let slipOnly = true;
  for (const q of qWords) {
    let bestHere = 0;
    let kindHere = null;
    for (const f of fields) {
      if (!f.words.length) continue;
      const kind = findWord(q, f.words, f.text);
      if (!kind) continue;
      const s = KIND_SCORE[kind] * f.weight;
      if (s > bestHere) { bestHere = s; kindHere = kind; }
    }
    if (!kindHere) return null;
    if (kindHere !== 'slip') slipOnly = false;
    score += bestHere;
  }
  return { score, slipOnly };
}

/**
 * Every row that matches, in the order given (the panel's own order, so the
 * results read like the panel), each with its score. Rows found only by a
 * slip are kept only when nothing matched cleanly.
 * @template T
 * @param {string} query
 * @param {Array<T & { label?: string, text?: string, section?: string, aliases?: string, area?: string }>} rows
 * @returns {Array<{ row: T, score: number }>}
 */
export function searchRows(query, rows) {
  const hits = [];
  for (const row of rows || []) {
    const r = scoreRow(query, row);
    if (r) hits.push({ row, score: r.score, slipOnly: r.slipOnly });
  }
  const clean = hits.filter((h) => !h.slipOnly);
  return (clean.length ? clean : hits).map(({ row, score }) => ({ row, score }));
}
