// Fuzzy matching for funscript ↔ video filename pairing

/**
 * Strip extension, lowercase, replace separators with spaces, collapse whitespace.
 */
export function normalize(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return base
    .toLowerCase()
    .replace(/[_.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
export function tokenOverlapScore(tokensA, tokensB) {
  if (tokensA.length === 0 && tokensB.length === 0) return 100;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return Math.round((intersection / union) * 100);
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
export function fuzzyMatchScore(videoFilename, funscriptFilename) {
  const normV = normalize(videoFilename);
  const normF = normalize(funscriptFilename);

  // Exact normalized match
  if (normV === normF) return 100;

  const tokV = tokenize(normV);
  const tokF = tokenize(normF);

  const tokenScore = tokenOverlapScore(tokV, tokF);
  const lcsLen = longestCommonSubstringLength(normV, normF);
  const maxLen = Math.max(normV.length, normF.length) || 1;
  const lcsScore = Math.round((lcsLen / maxLen) * 100);
  const levScore = levenshteinScore(normV, normF);
  const prefScore = prefixScore(normV, normF);

  return Math.round(
    tokenScore * 0.35 +
    lcsScore * 0.25 +
    levScore * 0.25 +
    prefScore * 0.15
  );
}

/**
 * Rank funscript candidates for a given video name.
 * @param {string} videoName — video filename (e.g. "My Video.mp4")
 * @param {Array<{name: string, path: string}>} funscripts — available funscript files
 * @param {number} [threshold=10] — minimum score to include
 * @returns {Array<{name: string, path: string, score: number}>} sorted descending by score
 */
export function rankFunscriptMatches(videoName, funscripts, threshold = 10) {
  const results = [];
  for (const fs of funscripts) {
    const score = fuzzyMatchScore(videoName, fs.name);
    if (score >= threshold) {
      results.push({ name: fs.name, path: fs.path, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
