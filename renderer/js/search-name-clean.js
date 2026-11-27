// What the EroScripts searches type for a video (Dave, 2026-11-18: "searches
// might want to take into account that underscores may exist instead of
// spaces and there may be extra words in the search term than there is in
// the forum post title").
//
// - cleanSearchName(name): the query every search FOR A VIDEO starts with (the
//   Associate modal's "Find on EroScripts", the Tags section's "Find the
//   post", the auto-match when a video opens with no script, and the nav
//   bar's EroScripts button with such a video open; the last two since
//   v0.10.1): the video's file name with its extension gone, underscores, dots,
//   + and hyphens joining words as spaces, and the words that are never in a post title left out:
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
  s = s.replace(/\b\d{1,2}[-._ ]\d{1,2}[-._ ](?:19|20)\d{2}\b/g, ' ');            // 12-05-2023 (and 12 05 2023, a de-hyphenated file name)
  s = s.replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ');                                   // 3840x2160
  s = s.replace(/[_.+]+/g, ' ');                                                 // underscores, dots, + as spaces
  s = s.replace(/(?:^|\s)[-–—]+(?=\s|$)/g, ' ');                                 // a lone dash between words
  s = s.replace(/[[\](){}【】|]/g, ' ');                                         // brackets
  return s.split(/\s+/).filter((w) => w && !isNoise(w));
}

/**
 * A file name whose words are joined by hyphens, with spaces in their place
 * (v0.10.1). The forum's search reads "anna-claire-clouds-takes-on-a-mouthful"
 * as ONE word and finds nothing; the same words with spaces find the post
 * first (found recording the EroScripts OP clips, 2026-11-20). Every hyphen
 * touching a word goes ("part-2-4k" -> "part 2 4k", and 4k is then noise);
 * a lone " - " between words is left to searchWords. A date loses its dashes
 * too ("2023 05 12"), which the date rules in searchWords still read as a
 * date. "AJVR-142-C" becomes "AJVR 142 C", which the forum matches the same
 * way (its search splits a hyphenated title word into its parts).
 *
 * @param {string} text
 * @returns {string}
 */
function splitHyphenatedWords(text) {
  return text.replace(/(?<=\S)-+|-+(?=\S)/g, ' ');
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
  const words = searchWords(splitHyphenatedWords(base));
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

/**
 * Is a forum post's title close enough to a video's search query to offer it
 * as "Script found" (app.js `_autoMatchEroScripts`)? MORE than half of the
 * query's words of 3+ letters must be in the title, hyphens and punctuation
 * aside (so both words of a two-word name: "Invert Test" matched "BounceX -
 * Anal Dildo Hero (Beta Test)" on "test" alone at one half, seen live). The toast used to offer the search's FIRST result whatever it was:
 * "Invert Test" got "A short animation about stamina training!" (found
 * 2026-11-22). No such word in the query (all short or noise): no offer, as
 * a wrong suggestion is worse than none.
 *
 * @param {unknown} title
 * @param {unknown} query
 * @returns {boolean}
 */
export function titleMatchesQuery(title, query) {
  const words = (s) => searchWords(String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']+/gu, ' '))
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= 3);
  const q = [...new Set(words(query))];
  if (q.length === 0) return false;
  const inTitle = new Set(words(title));
  const hit = q.filter((w) => inTitle.has(w)).length;
  return hit / q.length > 0.5;
}
