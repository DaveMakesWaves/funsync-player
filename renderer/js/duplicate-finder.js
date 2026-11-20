// duplicate-finder — group library videos that look like copies of each other.
//
// Asked for by pallokala2 (EroScripts #330), and his reason shapes the whole
// design: "anyone who has a big collection also knows we are always out of
// space, so finding duplicates helps get some space back". The goal is
// RECLAIMING DISK, not tidying the grid — so this reports real byte sizes, and
// the thing it feeds ends in a deletion.
//
// That makes a wrong answer expensive, so the evidence is graded rather than
// pooled. Three tiers, strongest first:
//
//   identical — same byte size, the same sampled content hash
//               (`contentHash`, from the main process), and same duration
//               where both are known. This is the tier people act on without
//               thinking, so it needs proof of the BYTES: size and runtime
//               alone once listed two different 720,304-byte, 8 s videos as
//               Identical (FT-B01). A pair without matching hashes earns
//               nothing here and is judged on runtime and name below.
//   likely    — same duration, different size, and a name that agrees —
//               including its episode/part numbers. A re-encode of the same
//               content. Worth showing, worth looking at before deleting.
//   possible  — neither, but the names are close. Weakest evidence by far,
//               and included only because a renamed re-encode leaves nothing
//               else to go on.
//
// And one tier from the user's own Stash (Stash "next" lot, 2026-11-19;
// DESIGN-stash-s1.md (j) #2), between identical and likely:
//
//   stash     — "Looks the same (Stash)": two LINKED videos whose Stash
//               scenes have the same picture fingerprint (phash), or that
//               Stash's own duplicate check put in one set. A re-encode of
//               one scene, named or sized however it likes. It is Stash's
//               judgement of the picture, not proof of the bytes, so it is
//               never Identical. The phashes come from data FunSync already
//               synced (the caller passes `stashPhash` per video); nothing
//               here, and nothing for this tier, asks Stash anything.
//
// Mixing those in one undifferentiated list is how a tool like this stops
// being trusted: one bad suggestion and the user stops believing the good
// ones. Every group carries its tier so the UI can say WHY it grouped them.
//
// Nothing here touches the filesystem. It takes plain objects and returns
// plain objects, so the matching rules can be tested without deleting
// anyone's videos.

import { fuzzyMatchScore, normalize, tokenize, isNoiseToken } from './fuzzy-match.js';

// Durations within this many seconds count as the same runtime.
//
// Was 2s, tightened to 1s after testing against a real 61-video library: two
// unrelated videos matched inside the old window purely by coincidence, and in
// a library of a few hundred that stops being a coincidence and becomes a
// steady stream of false pairs. Runtime is a weak fingerprint — there are only
// so many minutes a video can be.
export const DURATION_TOLERANCE_SEC = 1;

/** Name similarity (0-100) at or above this is worth grouping on alone. */
export const NAME_SIMILARITY_THRESHOLD = 82;

/**
 * Lower bar used ONLY to corroborate a matching runtime.
 *
 * A shared duration plus a partly-matching name is worth surfacing as a
 * "possible"; a shared duration and nothing else is not evidence at all and is
 * dropped entirely. Two unrelated videos of the same length is an everyday
 * coincidence in any real library.
 */
export const WEAK_NAME_THRESHOLD = 55;

export const TIER = {
  IDENTICAL: 'identical',
  STASH: 'stash',
  LIKELY: 'likely',
  POSSIBLE: 'possible',
};

/** Rank a tier for sorting — strongest evidence first. */
const TIER_RANK = { identical: 0, stash: 1, likely: 2, possible: 3 };

// A Stash phash as main projects it: 16 hex digits.
const PHASH = /^[0-9a-f]{16}$/i;

/** The video's Stash phash (lower case), or null. */
function phashOf(v) {
  return typeof v?.stashPhash === 'string' && PHASH.test(v.stashPhash) ? v.stashPhash.toLowerCase() : null;
}

function sameDuration(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= DURATION_TOLERANCE_SEC;
}

/**
 * Proof of the same bytes: both files carry a content hash and they match.
 * A missing hash (unreadable file, offline drive, no IPC) is NOT a match, so
 * it can never make a pair Identical (FT-B01).
 */
function sameContent(a, b) {
  return typeof a.contentHash === 'string' && a.contentHash.length > 0
    && a.contentHash === b.contentHash;
}

/**
 * Paths worth hashing: those whose exact byte size is shared with at least one
 * other file. Only these can ever be Identical, so the main process reads
 * nothing else. Missing or zero sizes are never candidates.
 *
 * @param {Array<{path:string,size?:number|null}>} entries
 * @returns {string[]}
 */
export function sameSizeCandidates(entries) {
  const bySize = new Map();
  for (const e of entries || []) {
    if (!e || !e.path || !Number.isFinite(e.size) || e.size <= 0) continue;
    if (!bySize.has(e.size)) bySize.set(e.size, []);
    bySize.get(e.size).push(e.path);
  }
  const out = [];
  for (const paths of bySize.values()) {
    if (paths.length >= 2) out.push(...paths);
  }
  return out;
}

// Numbered tokens that describe the ENCODE rather than which video this is.
// fuzzy-match's noise list already drops resolution (1080p, 4k), codec
// (x265), fps and years; these are the other numbers a re-encode's name
// tends to pick up, and they must not read as "a different episode".
const ENCODE_NUMBER_TOKEN = /^(\d+bits?|\d+[km]bps|crf\d+|\d+hz)$/;

// A real resolution tag ("4k", "1080p", "uhd"), and a bare frame height
// ("film-1080") that may be one written without its "p".
const RESOLUTION_TAG = /^(\d{3,4}p|\d+k|uhd|fhd)$/;
const BARE_HEIGHT = /^(360|480|540|576|720|1080|1440|2160|2880|4320)$/;

// Numbering that fuzzy-match's noise list swallows, but which says WHICH
// video a file is:
//   - "1x03" season-x-episode. The noise list drops it as a WxH size, but a
//     real WxH ("1920x1080", "180x180") has three or four digits a side.
//   - years ("Christmas Party 2019" vs "2020") and the VR markers 180 / 360
//     ("Long Scene Title 180" vs "360"). These two ARE noise when only one
//     name carries them ("Film" vs "Film 2019 4K" is one film), so they are
//     compared only when both names have one, and then they must agree.
const SEASON_EPISODE = /^\d{1,2}x\d{1,3}$/;
const YEAR = /^(19|20)\d{2}$/;
const VR_MARKER = /^(180|360)$/;

/**
 * The trailing "(n)" that fuzzy-match's normalize() drops, or null.
 *
 * normalize() strips it because "Scene (1).funscript" is the script for
 * "Scene.mp4" (a browser's duplicate-download marker), and funscript pairing
 * depends on that, so normalize() itself must not change. Here it is the
 * opposite: "Clip (1)".."Clip (8)" is what Windows Explorer names a batch
 * rename (select files, F2), and the number is the only thing that tells them
 * apart. Mirrors normalize()'s extension strip and pattern exactly, so the
 * number is recovered whenever, and only when, normalize() removed it.
 */
function trailingCopyNumber(name) {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).normalize('NFKD');
  const m = base.match(/\((\d+)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * The numbers in a file name that say WHICH video it is: episode, part,
 * scene, take, "E03", "S01E04", "1x03", "Bulk 001", "Clip (3)". In order,
 * leading zeros dropped ("01" and "1" are the same episode), as strings so a
 * long ID never loses digits to float rounding. Years and 180/360 are kept
 * apart, in `paired`, because they only count when both names have one.
 */
function identityNumbers(name) {
  const raw = String(name || '');
  const nums = [];
  const bareHeight = [];
  const paired = { year: [], vr: [] };
  let resolutionTag = false;
  const tokens = tokenize(normalize(raw));
  const copyNumber = trailingCopyNumber(raw);
  if (copyNumber !== null) tokens.push(copyNumber);
  for (const tok of tokens) {
    if (RESOLUTION_TAG.test(tok)) resolutionTag = true;
    if (YEAR.test(tok)) { paired.year.push(tok); continue; }
    if (VR_MARKER.test(tok)) { paired.vr.push(tok); continue; }
    if (!SEASON_EPISODE.test(tok) && (isNoiseToken(tok) || ENCODE_NUMBER_TOKEN.test(tok))) continue;
    for (const run of tok.match(/\d+/g) || []) {
      nums.push(run.replace(/^0+(?=\d)/, ''));
      bareHeight.push(BARE_HEIGHT.test(tok));
    }
  }
  return { nums, bareHeight, resolutionTag, paired };
}

const sameSeq = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

/** A year or 180/360 on BOTH names that differs — one-sided says nothing. */
const pairedDisagree = (x, y) => x.length > 0 && y.length > 0 && !sameSeq(x, y);

/**
 * True when two names carry different identity numbers — "Episode 01" vs
 * "Episode 02", "Part 1" vs "Part 2", "Scene 12" vs "Scene 47", "Film" vs
 * "Film 2". That is CONTRARY evidence: a series is the place a run of
 * equal-length files with near-identical names comes from, and the one token
 * that differs is exactly the one saying they are different videos (app test
 * V03: 300 equal-length "Bulk 001..300" files grouped as one LIKELY re-encode
 * and offered for the Recycle Bin).
 *
 * One exception: "film-4k" vs "film-1080". A bare frame height is read as a
 * resolution tag, but only on a name with no resolution tag of its own and
 * only opposite one that has one. "Bulk 720" vs "Bulk 1080" stays vetoed.
 */
function numbersDisagree(a, b) {
  if (pairedDisagree(a.paired.year, b.paired.year) || pairedDisagree(a.paired.vr, b.paired.vr)) return true;
  if (sameSeq(a.nums, b.nums)) return false;
  const asIdentity = (x, other) => ((other.resolutionTag && !x.resolutionTag)
    ? x.nums.filter((_, k) => !x.bareHeight[k])
    : x.nums);
  return !sameSeq(asIdentity(a, b), asIdentity(b, a));
}

/**
 * Which copy should we suggest keeping?
 *
 * Order matters and is deliberately conservative:
 *   1. Has a funscript. Scripts are often hand-made and always harder to
 *      replace than the video; deleting the scripted copy orphans it. This
 *      alone decides most real groups.
 *   2. Bigger file. Between two copies of the same thing, the larger is the
 *      less-compressed one.
 *   3. Longer duration, for the case where one copy is truncated.
 *   4. Shorter path, as a stable tiebreak so the suggestion never flickers
 *      between runs.
 *
 * This is a SUGGESTION. Nothing is preselected for deletion anywhere.
 */
export function pickKeeper(members) {
  return [...members].sort((a, b) => {
    if (!!b.hasFunscript !== !!a.hasFunscript) return (b.hasFunscript ? 1 : 0) - (a.hasFunscript ? 1 : 0);
    if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
    if ((b.duration || 0) !== (a.duration || 0)) return (b.duration || 0) - (a.duration || 0);
    return String(a.path || '').length - String(b.path || '').length;
  })[0];
}

/** Bytes that would come back if every non-keeper in the group went away. */
export function reclaimableBytes(group) {
  const keeperPath = group.keeperPath;
  return group.members
    .filter((m) => m.path !== keeperPath)
    .reduce((sum, m) => sum + (m.size || 0), 0);
}

/**
 * Find duplicate groups.
 *
 * @param {Array<{path:string,name:string,size?:number,duration?:number,hasFunscript?:boolean,contentHash?:string|null,stashPhash?:string|null,stashSceneId?:string|null}>} videos
 *   `contentHash` is the main process's sampled sha256 (hash-video-files);
 *   without it no pair can be Identical. `stashPhash` / `stashSceneId`: the
 *   phash and id of the Stash scene a video is linked to (stash-scene-
 *   fields.js; only while Stash is on and the link counts), for the Stash
 *   tier; without them a video is never in it.
 * @param {{nameThreshold?:number, stashSceneSets?:string[][]}} [opts]
 *   `stashSceneSets`: Stash's own duplicate sets (findDuplicateScenes), as
 *   scene ids, when the synced data carries them; videos linked to scenes
 *   of one set are "Looks the same (Stash)".
 * @returns {Array<{id:string,tier:string,members:Array,keeperPath:string,reclaimable:number}>}
 */
export function findDuplicates(videos, opts = {}) {
  const list = (videos || []).filter((v) => v && v.path);
  if (list.length < 2) return [];
  const nameThreshold = Number.isFinite(opts.nameThreshold)
    ? opts.nameThreshold
    : NAME_SIMILARITY_THRESHOLD;

  // Union-find. A connected component is the pool a group is cut from: if A
  // matches B and B matches C, all three land in one pool even when A and C
  // were never compared. Partitioning into pools first is what guarantees no
  // file ever appears in two groups — overlapping groups in a delete UI are
  // how someone removes the same file twice, or removes every copy because
  // each pairing "kept one". A pool is NOT a group, though: see "Assemble
  // groups" below for why a chain is never offered as one.
  const parent = list.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  // Strongest DIRECT evidence for each pair that was actually compared.
  const pairKey = (i, j) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const pairTier = new Map();
  const noteTier = (i, j, tier) => {
    const key = pairKey(i, j);
    const prev = pairTier.get(key);
    if (prev === undefined || TIER_RANK[tier] < TIER_RANK[prev]) pairTier.set(key, tier);
  };

  // Identity numbers per file, computed once (see numbersDisagree).
  const nums = list.map((v) => identityNumbers(v.name));

  // --- Pass 1: exact byte size AND the same content. Bucketed by size, so
  // this is O(n) not O(n^2). ---
  const bySize = new Map();
  list.forEach((v, i) => {
    if (!Number.isFinite(v.size) || v.size <= 0) return;
    if (!bySize.has(v.size)) bySize.set(v.size, []);
    bySize.get(v.size).push(i);
  });
  for (const idxs of bySize.values()) {
    if (idxs.length < 2) continue;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const va = list[idxs[a]]; const vb = list[idxs[b]];
        // Same size is NOT the same file (FT-B01): two different videos of
        // 720,304 bytes and 8 s were listed as Identical and one went to the
        // Recycle Bin preselected. Without matching content hashes the pair
        // gets no evidence here; passes 2 and 3 judge it on runtime and name
        // like any other pair, so it can never be preselected as Identical.
        if (!sameContent(va, vb)) continue;
        // Same bytes and same duration is as certain as this gets. Same bytes
        // with a duration missing is still identical: the hash is the proof,
        // and an un-probed library must not lose its byte copies.
        const bothKnown = Number.isFinite(va.duration) && Number.isFinite(vb.duration)
          && va.duration > 0 && vb.duration > 0;
        const tier = (!bothKnown || sameDuration(va.duration, vb.duration))
          ? TIER.IDENTICAL
          : TIER.LIKELY;
        union(idxs[a], idxs[b]);
        noteTier(idxs[a], idxs[b], tier);
      }
    }
  }

  // --- Pass 1b: Stash says the picture is the same. ----------------------
  // Equal phashes of the linked scenes (bucketed, so near-linear), and the
  // sets of Stash's own duplicate check when the caller has them. Stash's
  // judgement of the picture, never of the bytes: the pair is STASH, which
  // an Identical pair (pass 1, or pass 2's reassertion) outranks.
  const stashBuckets = new Map();
  list.forEach((v, i) => {
    const ph = phashOf(v);
    if (!ph) return;
    if (!stashBuckets.has(ph)) stashBuckets.set(ph, []);
    stashBuckets.get(ph).push(i);
  });
  const sceneSets = Array.isArray(opts.stashSceneSets) ? opts.stashSceneSets : [];
  if (sceneSets.length > 0) {
    const bySceneId = new Map();
    list.forEach((v, i) => {
      const id = typeof v.stashSceneId === 'string' && v.stashSceneId ? v.stashSceneId : null;
      if (!id) return;
      if (!bySceneId.has(id)) bySceneId.set(id, []);
      bySceneId.get(id).push(i);
    });
    sceneSets.forEach((set, k) => {
      if (!Array.isArray(set)) return;
      const ids = [...new Set(set.filter((id) => typeof id === 'string' && id))];
      const idxs = ids.flatMap((id) => bySceneId.get(id) || []);
      if (idxs.length >= 2) stashBuckets.set(`set:${k}`, idxs);
    });
  }
  for (const idxs of stashBuckets.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        union(idxs[a], idxs[b]);
        noteTier(idxs[a], idxs[b], TIER.STASH);
      }
    }
  }

  // --- Pass 2: same duration, different size (a re-encode). --------------
  // Bucketed to the second so this stays near-linear; the tolerance is then
  // applied within neighbouring buckets rather than across the whole list.
  const byDurBucket = new Map();
  list.forEach((v, i) => {
    if (!Number.isFinite(v.duration) || v.duration <= 0) return;
    const bucket = Math.round(v.duration);
    if (!byDurBucket.has(bucket)) byDurBucket.set(bucket, []);
    byDurBucket.get(bucket).push(i);
  });
  const span = Math.ceil(DURATION_TOLERANCE_SEC);
  for (const [bucket, idxs] of byDurBucket) {
    const candidates = [];
    for (let d = -span; d <= span; d++) {
      const near = byDurBucket.get(bucket + d);
      if (near) candidates.push(...near);
    }
    for (const i of idxs) {
      for (const j of candidates) {
        if (i >= j) continue;
        if (!sameDuration(list[i].duration, list[j].duration)) continue;

        // Same size AND same content: already IDENTICAL from pass 1, but
        // reassert it here so ordering can never downgrade it. Same size
        // without content proof falls through to the name check below, the
        // same as any other same-runtime pair (FT-B01).
        if (list[i].size != null && list[i].size === list[j].size && sameContent(list[i], list[j])) {
          union(i, j);
          noteTier(i, j, TIER.IDENTICAL);
          continue;
        }

        // Same runtime, different size. This is the pairing that produced
        // false matches on a real library — two unrelated videos of the same
        // length. Runtime alone is NOT enough to call something a re-encode,
        // so it needs corroboration from the name before it earns "likely".
        // Without that it is a guess, and it is labelled as one.
        // A moderate name match is enough HERE, because the runtime already
        // agrees — the two together are decent evidence even though neither
        // is on its own. The bar is lower than the name-only pass on purpose:
        // real re-encodes are named things like "Film 4K" and "Film 1080p",
        // which differ in exactly the token that describes the re-encode and
        // so score well below a strict threshold.
        //
        // But a name that differs in its episode/part/scene NUMBER is the
        // opposite of corroboration: "Episode 01" and "Episode 02" score 81
        // precisely because everything except the part that tells them apart
        // matches, and a series of equal-length clips is the commonest way
        // to hit this branch at all. That pair is not grouped (V03).
        if (numbersDisagree(nums[i], nums[j])) continue;
        const nameScore = fuzzyMatchScore(list[i].name || '', list[j].name || '');
        if (nameScore >= WEAK_NAME_THRESHOLD) {
          union(i, j);
          noteTier(i, j, TIER.LIKELY);
        }
        // Otherwise: not grouped at all. Two files sharing only a runtime
        // are not evidence of anything, and listing them as duplicates
        // teaches people to ignore the whole screen.
      }
    }
  }

  // --- Pass 3: similar names. -------------------------------------------
  //
  // The weakest signal and the expensive one. Comparing every name against
  // every other is O(n^2) fuzzy scores: on a real 1,532-video library that
  // measured **95 SECONDS** of blocked main thread, with the UI showing a
  // motionless "Checking your library…" the whole time (2026-08-26).
  //
  // Fixed by BLOCKING rather than by giving up on recall. Two names can only
  // score highly if they share a real word, so build an inverted index of
  // token → files and only compare pairs that share at least one token. That
  // turns ~1.17M comparisons into a small fraction of them without changing
  // which pairs can match: anything the full sweep would have found still
  // gets compared, because a high fuzzy score with zero shared tokens is not
  // reachable.
  //
  // Very short tokens are dropped — "the", "a", "1" join half a library to
  // the other half and would rebuild the quadratic blowup one bucket at a
  // time. So is any token appearing in a huge share of the library, for the
  // same reason.
  const tokensOf = (name) => String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')      // strip extension
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 4);

  const tokenIndex = new Map();
  list.forEach((item, i) => {
    for (const tok of new Set(tokensOf(item.name))) {
      if (!tokenIndex.has(tok)) tokenIndex.set(tok, []);
      tokenIndex.get(tok).push(i);
    }
  });

  // A token carried by a large fraction of the library says nothing about any
  // particular pair and costs the most to expand.
  const MAX_BUCKET = Math.max(24, Math.ceil(list.length * 0.05));

  const comparedPairs = new Set();
  for (const idxs of tokenIndex.values()) {
    if (idxs.length < 2 || idxs.length > MAX_BUCKET) continue;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a]; const j = idxs[b];
        const key = pairKey(i, j);
        // Skip a pair that already has evidence of its own — not merely a
        // pair in the same pool. Groups need DIRECT evidence against the
        // keeper, so a pool-mate's name match still has to be recorded.
        if (pairTier.has(key)) continue;
        if (comparedPairs.has(key)) continue;   // shared several tokens
        comparedPairs.add(key);
        // Same veto as pass 2: "Long Title Part 1" vs "Part 2" scores 90 on
        // name alone, and the number is the only part that matters.
        if (numbersDisagree(nums[i], nums[j])) continue;
        const score = fuzzyMatchScore(list[i].name || '', list[j].name || '');
        if (score < nameThreshold) continue;
        union(i, j);
        noteTier(i, j, TIER.POSSIBLE);
      }
    }
  }

  // --- Assemble groups -------------------------------------------------
  //
  // Every file offered for removal must have DIRECT evidence against the
  // file being kept. "Likely" and "possible" are not transitive: A~B and B~C
  // say nothing about A and C, and a pool built by chaining them is how 300
  // numbered clips became one "300 copies" group whose keeper ("Bulk 300")
  // shared nothing with most of what it offered to delete (V03 — "Bulk 001"
  // vs "Bulk 300" scores 51, under even the weak bar).
  //
  // Byte-identical files ARE transitive — same bytes is the same content —
  // so they travel together as one unit: evidence against any member of a
  // unit is evidence against all of it, and a renamed byte copy is never
  // split from its twin.
  const unitParent = list.map((_, i) => i);
  const findUnit = (i) => { while (unitParent[i] !== i) { unitParent[i] = unitParent[unitParent[i]]; i = unitParent[i]; } return i; };
  for (const [key, tier] of pairTier) {
    if (tier !== TIER.IDENTICAL) continue;
    const [a, b] = key.split('|').map(Number);
    const ra = findUnit(a); const rb = findUnit(b);
    if (ra !== rb) unitParent[rb] = ra;
  }

  const pools = new Map();
  list.forEach((v, i) => {
    const root = find(i);
    if (!pools.has(root)) pools.set(root, []);
    pools.get(root).push(i);
  });

  const groups = [];
  for (const pool of pools.values()) {
    // Cut each pool into keeper-anchored groups: the best copy in what is
    // left, plus every unit with direct evidence against the keeper's unit.
    // Whatever is left over had evidence only against something else, and
    // gets its own keeper on the next round — never this one's.
    let remaining = pool;
    while (remaining.length >= 2) {
      const keeper = pickKeeper(remaining.map((i) => list[i]));
      const keeperIdx = remaining.find((i) => list[i] === keeper);
      const keeperUnit = findUnit(keeperIdx);
      const keeperUnitIdxs = remaining.filter((i) => findUnit(i) === keeperUnit);
      const vouched = new Set([keeperUnit]);
      for (const i of remaining) {
        if (findUnit(i) === keeperUnit) continue;
        if (keeperUnitIdxs.some((k) => pairTier.has(pairKey(i, k)))) vouched.add(findUnit(i));
      }
      const idxs = remaining.filter((i) => vouched.has(findUnit(i)));
      remaining = remaining.filter((i) => !vouched.has(findUnit(i)));
      if (idxs.length < 2) continue;

      // A group's tier is its WEAKEST link. A group held together by one
      // fuzzy name match is a "possible" group even if two of its members
      // are byte-identical — claiming otherwise would overstate the evidence
      // for the member that only matched on its name, and that member is
      // exactly the one someone might wrongly delete.
      let tier = TIER.IDENTICAL;
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          const t = pairTier.get(pairKey(idxs[a], idxs[b]));
          if (t && TIER_RANK[t] > TIER_RANK[tier]) tier = t;
        }
      }
      const members = idxs.map((i) => list[i]);
      const group = {
        id: `dup-${keeperIdx}-${members.length}`,
        tier,
        members,
        keeperPath: keeper.path,
      };
      group.reclaimable = reclaimableBytes(group);
      groups.push(group);
    }
  }

  // Biggest win first within each tier — the point is disk space, so the
  // group that gives back the most should be the one you see first.
  groups.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.reclaimable - a.reclaimable));
  return groups;
}

/** Total bytes recoverable across every group, if each keeper is kept. */
export function totalReclaimable(groups) {
  return (groups || []).reduce((sum, g) => sum + (g.reclaimable || 0), 0);
}

/** Human-readable bytes. Deliberately terse — it sits inside buttons. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
