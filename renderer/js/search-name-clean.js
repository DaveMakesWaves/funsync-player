// What the EroScripts searches type for a video (Dave, 2026-11-18: "searches
// might want to take into account that underscores may exist instead of
// spaces and there may be extra words in the search term than there is in
// the forum post title").
//
// - cleanSearchName(name): the query the inline search starts with (the
//   Associate modal's "Find on EroScripts" and the Tags section's "Find the
//   post"): the video's file name with its extension gone, underscores, dots
//   and + as spaces, and the words that are never in a post title left out:
//   resolutions and frame rates (1080p, 4k, 60fps, 3840x2160), the site or
//   host a file came from (bunkr, eporner, xvideos, pornhub...), file types
//   (mp4), "subbed", dates (2023-05-12) and a trailing copy counter "(1)".
// - fewerWordsQuery(query): what "Search with fewer words" searches when a
//   search found nothing: the first few meaningful words (5, then 3, then 2
//   on later presses), or null when the query is that short already. One
//   search per press; nothing here searches.
//
// The word list started as the one SCRATCH tagging/search2.cjs tested on
// Dave's library (2026-11-18); words that also name real titles (final,
// flat, sub, raw, vip, check) were left out of it.
//
// Pure: strings in, strings out.

/** Words never in a post title: hosts, file types, quality marks. */
const NOISE = new Set([
  // sites and hosts a file was saved from
  'bunkr', 'bunk', 'eporner', 'xvideos', 'xvideo', 'pornhub', 'xhamster', 'spankbang', 'redgifs',
  'www', 'com', 'net', 'org',
  // file types
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'funscript',
  // quality and subtitles
  'hd', 'uhd', 'fhd', 'fullhd', 'hq', 'subbed', 'download', 'dl',
]);

/** Quality marks by shape: 1080p, 2160i, 60fps, 4k, 8k. */
const NOISE_SHAPES = [/^\d{3,4}[pi]$/, /^\d{2,3}fps$/, /^[1-8]k$/];

/** Short words that do not count toward the "first few" of a shorter search. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'my', 'your', 'you', 'me', 'is', 'it',
]);

function isNoise(word) {
  const w = word.toLowerCase();
  return NOISE.has(w) || NOISE_SHAPES.some((re) => re.test(w));
}

/**
 * The words of a name or query with the noise left out (the extension is
 * NOT removed here: cleanSearchName does that for a file name).
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function searchWords(text) {
  if (typeof text !== 'string') return [];
  let s = text;
  s = s.replace(/\s*\(\d{1,2}\)\s*$/, ' ');                                    // a trailing copy counter "(1)"
  s = s.replace(/\b(?:19|20)\d{2}[-._ ]\d{1,2}[-._ ]\d{1,2}\b/g, ' ');            // 2023-05-12, 2023.05.12
  s = s.replace(/\b\d{1,2}[-._]\d{1,2}[-._](?:19|20)\d{2}\b/g, ' ');              // 12-05-2023
  s = s.replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ');                                   // 3840x2160
  s = s.replace(/[_.+]+/g, ' ');                                                 // underscores, dots, + as spaces
  s = s.replace(/(?:^|\s)[-–—]+(?=\s|$)/g, ' ');                                 // a lone dash between words
  s = s.replace(/[[\](){}【】|]/g, ' ');                                         // brackets
  return s.split(/\s+/).filter((w) => w && !isNoise(w));
}

/**
 * The query a search starts with for a video's file name (or path).
 *
 * @param {unknown} name `Some_Scene.1080p.mp4`, or a whole path
 * @returns {string} `Some Scene`; '' when nothing is left
 */
export function cleanSearchName(name) {
  if (typeof name !== 'string') return '';
  const base = name.split(/[\\/]/).pop().replace(/\.[^/.\s]{1,5}$/, '');
  const words = searchWords(base);
  // Everything was "noise" (a file named 1080p.mp4): the bare name is better than nothing.
  return words.length ? words.join(' ') : base.replace(/[_.+]+/g, ' ').trim();
}

/**
 * What "Search with fewer words" searches after `query` found nothing: its
 * first 5 meaningful words, or 3 when it had 5 or fewer, or 2 when it had 3
 * or fewer. Null when there is nothing shorter to try (2 words or fewer).
 *
 * @param {unknown} query
 * @returns {string|null}
 */
export function fewerWordsQuery(query) {
  const words = searchWords(typeof query === 'string' ? query : '')
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  if (words.length <= 2) return null;
  const keep = words.length > 5 ? 5 : (words.length > 3 ? 3 : 2);
  return words.slice(0, keep).join(' ');
}
