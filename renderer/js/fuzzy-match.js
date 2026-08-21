// Fuzzy matching for funscript ↔ video filename pairing

/**
 * Strip extension, lowercase, replace separators with spaces, collapse whitespace.
 */
export function normalize(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return base
    .toLowerCase()
    // Fold diacritics: "Café" and "Cafe" are the same file to a human, and
    // scored 56 before this. The library search already folded them
    // (library-search.js), so the two systems disagreed about the same
    // filename — search would find it, matching would not.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Browser duplicate-download marker: "Scene Name (1).funscript" is the
    // same scene as "Scene Name.mp4", and used to score 70.
    .replace(/\s*\(\d+\)\s*$/, '')
    // Brackets and parens are separators, not characters.
    .replace(/[_.\-()\[\]{}]/g, ' ')
    // Drop leading zeros inside numeric runs so "02" and "2" are one token.
    // Without this "Episode 3" (one substitution) outscored "Episode 02"
    // (an insertion that also breaks the token match) for "Episode 2" — the
    // app confidently offered the WRONG episode.
    .replace(/(^|\s)0+(\d)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokens that say nothing about WHICH scene a file is: resolution, codec,
 * source, container, VR packing and projection markers, years.
 *
 * These are the reason unrelated files matched. A VR library shares
 * `slr` / `1920p` / `180x180` / `3dh` / `lr` across every single filename,
 * and because they are long and numerous they dominated all four scoring
 * components at once — two unrelated scripts scored 32-57 on noise alone,
 * and a correctly-named script came third.
 *
 * Deliberately a fixed list rather than a frequency heuristic: it behaves
 * identically for a library of 5 files and 5,000, and it is inspectable.
 */
const NOISE_TOKENS = new Set([
  // source / container / codec
  'web', 'webdl', 'webrip', 'bluray', 'brrip', 'bdrip', 'dvdrip', 'hdtv', 'dl',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'dts', 'mp4', 'mkv', 'avi', 'wmv', 'm4v',
  'hdr', 'sdr', 'hq', 'uhd', 'fhd', 'remux', 'proper', 'repack',
  // VR packing / projection
  'lr', 'rl', 'tb', 'bt', 'sbs', 'ou', 'mono', '3dh', '3dv', '2d', '3d',
  'vr', '180', '360', 'fisheye', 'equirect', 'mkx200', 'mkx220', 'rf52',
  'vrca220', 'oculus', 'quest', 'smartphone',
  // misc
  'funscript', 'script',
]);

/** True when a token carries no scene information. */
export function isNoiseToken(t) {
  if (!t) return true;
  if (NOISE_TOKENS.has(t)) return true;
  if (/^\d{3,4}p$/.test(t)) return true;        // 720p 1080p 1920p 2160p
  if (/^\d+k$/.test(t)) return true;            // 4k 8k
  if (/^\d+x\d+$/.test(t)) return true;         // 180x180, 1920x1080
  if (/^(19|20)\d{2}$/.test(t)) return true;    // release years
  if (/^\d+fps$/.test(t)) return true;
  return false;
}

/**
 * Drop noise tokens, but NEVER strip a name to nothing — a file called
 * "1080p.mp4" must still be comparable to itself.
 */
export function stripNoise(normalized) {
  const kept = tokenize(normalized).filter((t) => !isNoiseToken(t));
  return kept.length ? kept.join(' ') : normalized;
}

/**
 * How completely the smaller token set sits inside the larger, tempered by
 * how different the two lengths are.
 *
 * This is the "script is named for the scene, video carries release tags"
 * case — the commonest real pairing and previously the worst scoring one
 * (26 against a decoy's 70). Pure containment is not enough on its own:
 * "Amazing" is fully contained in "Amazing Long Descriptive Title…" too, so
 * the length ratio keeps a single generic word from beating the real title.
 */
export function tokenContainmentScore(tokensA, tokensB, idf = null) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const small = setA.size <= setB.size ? setA : setB;
  const large = small === setA ? setB : setA;
  const w = (t) => (idf ? (idf.get(t) ?? 1) : 1);

  let hit = 0;
  let total = 0;
  for (const t of small) {
    total += w(t);
    if (large.has(t)) hit += w(t);
  }
  if (total === 0) return 0;
  const coverage = hit / total;
  const ratio = small.size / large.size;
  return Math.round(coverage * 100 * (0.5 + 0.5 * ratio));
}

/**
 * Split normalized string into word tokens.
 */
export function tokenize(normalized) {
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

/**
 * Jaccard index of two token sets, scaled 0-100.
 */
export function tokenOverlapScore(tokensA, tokensB, idf = null) {
  if (tokensA.length === 0 && tokensB.length === 0) return 100;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  // Weight 1 per token unless an IDF map is supplied, so the unweighted
  // behaviour (and every test pinning it) is unchanged.
  const w = (t) => (idf ? (idf.get(t) ?? 1) : 1);

  let inter = 0;
  let union = 0;
  for (const t of setA) {
    union += w(t);
    if (setB.has(t)) inter += w(t);
  }
  for (const t of setB) if (!setA.has(t)) union += w(t);

  if (union === 0) return 0;
  return Math.round((inter / union) * 100);
}

/**
 * Inverse document frequency over a set of candidate names.
 *
 * A token in every filename says nothing about WHICH file you want. In a VR
 * library `slr`, the studio name, and the packing markers appear everywhere,
 * and no fixed noise list can know the studios. IDF handles them for free,
 * and adapts to whatever a given user's library actually looks like.
 *
 * Ubiquitous tokens land on 0 and drop out of scoring entirely; a token
 * unique to one candidate gets the highest weight.
 *
 * @param {Array<string>} names — candidate filenames
 * @returns {Map<string, number>} token → weight
 */
export function buildIdf(names) {
  const df = new Map();
  for (const name of names) {
    for (const t of new Set(tokenize(stripNoise(normalize(name))))) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const n = Math.max(1, names.length);
  const idf = new Map();
  for (const [t, freq] of df) idf.set(t, Math.log(n / freq));
  return idf;
}

/**
 * Length of the longest common substring between two strings.
 */
export function longestCommonSubstringLength(a, b) {
  if (!a || !b) return 0;
  let max = 0;
  // DP row-by-row to save memory
  const prev = new Uint16Array(b.length + 1);
  const curr = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > max) max = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    prev.set(curr);
    curr.fill(0);
  }
  return max;
}

/**
 * Normalized Levenshtein distance → score 0-100 (100 = identical).
 */
export function levenshteinScore(a, b) {
  if (a === b) return 100;
  if (!a || !b) return 0;

  const m = a.length;
  const n = b.length;
  const dp = new Uint16Array(n + 1);

  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  const maxLen = Math.max(m, n);
  return Math.round((1 - dp[n] / maxLen) * 100);
}

/**
 * Rewards shared prefix and containment, 0-100.
 */
export function prefixScore(a, b) {
  if (!a || !b) return 0;

  // Shared prefix length
  let shared = 0;
  const minLen = Math.min(a.length, b.length);
  while (shared < minLen && a[shared] === b[shared]) shared++;

  const maxLen = Math.max(a.length, b.length);
  let score = Math.round((shared / maxLen) * 100);

  // Bonus if one contains the other
  if (a.includes(b) || b.includes(a)) {
    const containScore = Math.round((minLen / maxLen) * 100);
    score = Math.max(score, containScore);
  }

  return score;
}

/**
 * Weighted composite score for matching a video filename to a funscript filename.
 * Returns 0-100.
 */
function scorePair(a, b, idf = null) {
  if (a === b) return 100;

  const tokA = tokenize(a);
  const tokB = tokenize(b);

  const tokenScore = tokenOverlapScore(tokA, tokB, idf);
  const lcsLen = longestCommonSubstringLength(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  const lcsScore = Math.round((lcsLen / maxLen) * 100);
  const levScore = levenshteinScore(a, b);
  const prefScore = prefixScore(a, b);

  const weighted = Math.round(
    tokenScore * 0.35 +
    lcsScore * 0.25 +
    levScore * 0.25 +
    // prefixScore was 0.15 and is now 0.05. It rewards a shared leading
    // substring, which for media filenames is almost always the studio
    // ("SLR_VRBangers_") — pure noise, scored as signal.
    prefScore * 0.05 +
    tokenContainmentScore(tokA, tokB, idf) * 0.10
  );

  // A fully-contained shorter name is a strong standalone signal, so it can
  // carry the score by itself when the weighted blend misses it.
  return Math.min(100, Math.max(weighted, tokenContainmentScore(tokA, tokB, idf)));
}

/**
 * Weighted composite score for matching a video filename to a funscript
 * filename. Returns 0-100.
 *
 * Scored TWICE: once on the normalized names, once with release/VR noise
 * tokens removed, taking the better. Scoring only the stripped form would
 * lose the exact-filename case (two files that differ solely by a tag are
 * not the same scene); scoring only the raw form is what let boilerplate
 * outrank titles. The pair covers both.
 */
export function fuzzyMatchScore(videoFilename, funscriptFilename, idf = null) {
  const normV = normalize(videoFilename);
  const normF = normalize(funscriptFilename);

  if (normV === normF) return 100;

  const coreV = stripNoise(normV);
  const coreF = stripNoise(normF);

  // Nothing to strip: score the names as they are.
  if (coreV === normV && coreF === normF) return scorePair(normV, normF, idf);

  // Score the STRIPPED forms, not the better of the two.
  //
  // An earlier draft took max(raw, core) to protect exact matches. It does
  // not: an exact match already returned 100 above. What max() actually did
  // was let a decoy keep the score it earned from shared boilerplate — two
  // VR files differing only in scene name still shared ~14 characters of
  // studio and packing markers, which the character-level components (LCS,
  // Levenshtein, prefix — 55% of the weight) cannot see past and IDF cannot
  // reach. Comparing the stripped names is the honest comparison: files
  // that differ only by a tag score high, files that differ by SCENE do not.
  return scorePair(coreV, coreF, idf);
}

/**
 * Rank funscript candidates for a given video name.
 * @param {string} videoName — video filename (e.g. "My Video.mp4")
 * @param {Array<{name: string, path: string}>} funscripts — available funscript files
 * @param {number} [threshold=10] — minimum score to include
 * @returns {Array<{name: string, path: string, score: number}>} sorted descending by score
 */
export function rankFunscriptMatches(videoName, funscripts, threshold = 10) {
  // IDF over the candidate set plus the query, so tokens shared by
  // everything (studio, site prefix, packing markers) stop counting as
  // evidence. The Associate modal passes threshold 0 and shows the top row
  // as its suggestion, so ranking quality IS the feature here.
  const idf = buildIdf([videoName, ...funscripts.map((f) => f.name)]);

  const results = [];
  for (const fs of funscripts) {
    const score = fuzzyMatchScore(videoName, fs.name, idf);
    if (score >= threshold) {
      results.push({ name: fs.name, path: fs.path, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
