'use strict';

// The library scan behind the `scan-directory` IPC (main.js).
//
// Lives in its own module so tests can run the REAL scan against real
// folders. It used to be inline in main.js, where CJS + Electron deps made it
// impossible to import, so the scan tests mirrored the algorithm by hand and
// could not fail when the real code changed (scan-directory-variants.test.js,
// ipc-handlers.test.js). New scan tests belong in library-scan.test.js and
// call this function directly.
//
// Moved here unchanged on 2026-11-02, apart from the two fixes made in the
// same change: the per-directory walk (app test V04, forum #360) and companion
// axis files counting as matched (V34). Registering the result with the
// backend stays in main.js, because it needs Electron.

const fs = require('fs');
const path = require('path');
const { MEDIA_EXTS, isTransportStream } = require('./media-extensions');

/**
 * Hand the main process's event loop back for one turn.
 *
 * The library scan does the directory walk asynchronously, but then runs a
 * dozen SYNCHRONOUS passes over the full entry list. On a large or networked
 * library that is one long block on the main thread, which freezes everything
 * the main process owns — including modal dialogs, which is how Dave hit it
 * (2026-08-11: "everything just freezes, on the modal as well").
 *
 * `setImmediate` yields after I/O callbacks, so pending IPC and window paints
 * get serviced between passes. It converts one long freeze into several short
 * ones; it does not make the scan faster, and it cannot help WITHIN a single
 * pass over a huge list — see the chunked loop below for that.
 */
const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Folders Windows keeps at a drive root. They are never library content, and
 * they are the usual reason a drive-root source has a folder the user cannot
 * open. `$RECYCLE.BIN` is skipped even when it IS readable: the user's own
 * bin holds deleted videos under renamed names ($R1A2B3C.mp4), and those must
 * not turn up in the library. Matched by name, case-insensitively.
 */
const SKIP_DIR_NAMES = new Set(['$recycle.bin', 'system volume information']);

/**
 * Every companion-axis suffix the PLAYER knows (`Clip.<suffix>.funscript`):
 * the union of `axisSuffixVariants()` over AXIS_DEFINITIONS in
 * renderer/js/multi-axis.js, canonical names, aliases and raw T-Code
 * channels. A literal copy because this is CJS in main and multi-axis.js is
 * an ES module for the renderer; library-scan.test.js pins the two equal.
 *
 * The scan used to know ten of these, so `Clip.suck.funscript` or
 * `Clip.R0.funscript` (axis files the player loads as Suck and Twist) were
 * offered as stroke VARIANTS of Clip, and picking one played twist data as
 * strokes (FT-047). Lowercase: the suffix is lowercased before the lookup.
 */
const AXIS_SUFFIXES = new Set([
  'surge', 'forward', 'l1',
  'sway', 'left', 'l2',
  'twist', 'yaw', 'r0',
  'roll', 'r1',
  'pitch', 'r2',
  'vib', 'vibrate', 'vibe', 'v0', // vibe: the RFC's own channel name (multi-axis editing, 2026-11-24)
  'pump', 'v1',
  'valve', 'a0',
  'suck', 'suction', 'a1',
  'lube', 'a2',
]);

/**
 * List every entry under one source folder, reading one directory at a time.
 *
 * This replaced a single `readdir(root, { recursive: true })`. Node rejects
 * that whole call on the first subfolder it cannot open, so ONE
 * permission-denied folder anywhere in the tree made the entire source scan
 * as failed: no videos at all, and a "Source unavailable" toast for a folder
 * that was plainly there (forum #360, app test V04).
 *
 * The order is the same as Node's recursive readdir (it reads each
 * subdirectory as it meets it and pops them off a stack), so a tree with no
 * unreadable folders lists exactly as before, and first-match-wins pairing
 * picks the same scripts.
 *
 * Throws only when the ROOT cannot be read. That is the source failing, and
 * the caller reports it in `failedPaths`. A subfolder that cannot be read is
 * returned in `skipped` and the walk carries on.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {Function} [opts.readdir]  fs.promises.readdir; injectable for tests
 * @returns {Promise<{entries: import('fs').Dirent[], skipped: Array<{path: string, code: string}>}>}
 */
async function walkSource(root, { readdir = fs.promises.readdir } = {}) {
  const opts = { withFileTypes: true };
  const entries = [];
  const skipped = [];
  const stack = [[root, await readdir(root, opts)]];
  while (stack.length > 0) {
    const [dir, dirents] = stack.pop();
    for (const dirent of dirents) {
      entries.push(dirent);
      if (!dirent.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(dirent.name.toLowerCase())) continue;
      const sub = path.join(dir, dirent.name);
      try {
        stack.push([sub, await readdir(sub, opts)]);
      } catch (err) {
        skipped.push({ path: sub, code: err.code || err.message });
      }
    }
  }
  return { entries, skipped };
}

/**
 * Can this source ROOT still be listed? The cheap form of the first thing
 * `walkSource` does, for Settings > Sources > Recheck (V82).
 *
 * The reachability probe is `fs.access`, which passes for a folder that
 * exists but whose listing is denied (measured on Windows with
 * `icacls /deny (RX)`: access passes, opendir and readdir both EPERM). Only
 * the scan used to find that out, so once Recheck stopped rescanning a
 * library whose probe answers had not changed, a folder that was listed fine
 * and then locked read "All sources are reachable." This opens the folder
 * and reads one entry, so it costs the same on a folder of ten files as on
 * one of ten thousand.
 *
 * Three answers, like `pathReachable` in path-status.js: `true` (listed), `false`
 * (opening or reading it failed, which is what fails the source in a scan)
 * and `null` (no answer within the budget: unknown, not a failure). Never
 * throws. A late answer still closes its handle.
 *
 * @param {string} dirPath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.opendir]  fs.promises.opendir; injectable for tests
 * @returns {Promise<true|false|null>}
 */
async function rootListable(dirPath, { timeoutMs = 800, opendir = fs.promises.opendir } = {}) {
  if (typeof dirPath !== 'string' || dirPath.length === 0) return false;
  const attempt = (async () => {
    const dir = await opendir(dirPath);
    try {
      await dir.read();
    } finally {
      await Promise.resolve(dir.close()).catch(() => {});
    }
    return true;
  })().catch(() => false);
  let timer;
  try {
    return await Promise.race([
      attempt,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk every source folder and pair videos with funscripts, subtitles and
 * variants.
 *
 * @param {string|string[]} dirPathOrPaths  one source path or several
 * @param {Object<string,string>} [sourceMap]  source path -> source name
 * @param {object} [opts]
 * @param {object} [opts.log]  logger with info/warn (electron-log in main)
 * @param {Function} [opts.readdir]  fs.promises.readdir; injectable for tests
 * @param {boolean} [opts.folderScriptsAsVariants]  Settings > Library "One-video
 *   folders" (`library.folderScriptsAsVariants`, FT-102): a folder holding
 *   exactly one video offers every script in it as a variant of that video
 * @returns {Promise<{videos, unmatchedFunscripts, unmatchedSubtitles, allFunscripts, failedPaths, skippedPaths}>}
 */
async function scanLibrary(dirPathOrPaths, sourceMap, { log = console, readdir, folderScriptsAsVariants = false, probeTransportStream = isTransportStream } = {}) {
  // Accept a single path or array of paths (multi-source)
  // sourceMap: optional { path: sourceName } mapping for VR content server grouping
  const dirPaths = Array.isArray(dirPathOrPaths) ? dirPathOrPaths : [dirPathOrPaths];
  const dirPath = dirPaths[0]; // for backward compat logging
  const _sourceMap = sourceMap || {};
  // Video and audio types: the main process's one list (media-extensions.js).
  const VIDEO_EXTS = MEDIA_EXTS;
  const FUNSCRIPT_EXT = '.funscript';
  const SUBTITLE_EXTS = ['.srt', '.vtt'];
  // AXIS_SUFFIXES: module level, the player's full set (FT-047).

  // Canonicalise a path for cross-source dedup: forward slashes, lowercased
  // drive letter. Matches renderer/js/path-utils.js::canonicalPath so the
  // settings overlap warning and the scan dedup agree on identity.
  const canonicalise = (p) => {
    if (!p) return '';
    let out = String(p).replace(/\\/g, '/');
    while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
  };

  let entries = [];
  const seenPaths = new Set(); // canonical full paths — drops dupes when sources overlap
  const failedPaths = [];
  // Subfolders of a source that DID scan, but could not be opened themselves.
  // Not a failed source, so no "unavailable" toast. But their files are
  // missing from this scan for a reason other than deletion, so the renderer
  // treats these folders like an unreachable source in every prune and
  // re-home guard (library.js `_isUnderUnavailableSource`). Absence is never
  // destructive: a script in a folder we could not read must not be pruned.
  const skippedPaths = [];
  let rawEntryCount = 0;
  const scanStart = Date.now();
  for (const dp of dirPaths) {
    if (!dp) continue;
    try {
      const { entries: dirEntries, skipped } = await walkSource(dp, { readdir });
      if (skipped.length > 0) {
        skippedPaths.push(...skipped.map((s) => s.path));
        const shown = skipped.slice(0, 5).map((s) => `${s.path} (${s.code})`).join(', ');
        log.warn(`[Library] Skipped ${skipped.length} unreadable folder(s) in ${dp}: ${shown}${skipped.length > 5 ? ', ...' : ''}`);
      }
      rawEntryCount += dirEntries.length;
      for (const entry of dirEntries) {
        const parent = entry.parentPath || entry.path || dp;
        const full = canonicalise(path.join(parent, entry.name));
        if (seenPaths.has(full)) continue;
        seenPaths.add(full);
        entries.push(entry);
      }
    } catch (err) {
      log.warn(`[Library] Failed to scan ${dp}: ${err.message}`);
      failedPaths.push(dp);
    }
  }
  const dupesDropped = rawEntryCount - entries.length;
  if (dupesDropped > 0) {
    log.info(`[Library] Scanned ${entries.length} unique entries (${dupesDropped} duplicates dropped from overlapping sources) in ${Date.now() - scanStart}ms from ${dirPaths.length} source(s)`);
  } else {
    log.info(`[Library] Scanned ${entries.length} entries in ${Date.now() - scanStart}ms from ${dirPaths.length} source(s)`);
  }

  // Normalize a basename for matching: lowercase, replace separators with spaces, collapse
  const normalizeName = (name) => name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

  // Helper: get the full path for a recursive dirent
  const entryPath = (entry) => {
    // Node recursive dirent: entry.parentPath or entry.path contains the parent directory
    const parent = entry.parentPath || entry.path || dirPath;
    return path.join(parent, entry.name);
  };

  // A .ts file is a video only when it is an MPEG transport stream: a
  // TypeScript source in a library folder must not become a "video"
  // (2026-11-26, when the older formats joined the list).
  const tsEntries = entries.filter((e) => e.isFile?.() && path.extname(e.name).toLowerCase() === '.ts');
  if (tsEntries.length > 0) {
    const notVideo = new Set();
    for (const e of tsEntries) {
      if (!(await probeTransportStream(entryPath(e)))) notVideo.add(e);
    }
    if (notVideo.size > 0) entries = entries.filter((e) => !notVideo.has(e));
  }

  // Helper: get the directory of an entry (for same-directory matching)
  const entryDir = (entry) => {
    return entry.parentPath || entry.path || dirPath;
  };

  // Pre-compute the set of video basenames (full, including any
  // parenthetical) so funscript classification can distinguish a
  // real-title parenthetical from a variant suffix. Example:
  //   "Title (Nude).mp4" + "Title (Nude).funscript"  → the "(Nude)" is
  //      part of the title; the funscript is that video's PRIMARY.
  //   "Title.mp4" + "Title (Soft).funscript"         → no "Title (Soft)"
  //      video exists; "(Soft)" is a variant label of "Title".
  // Without this, "Title (Nude).funscript" was always classified as a
  // "(Nude)" variant of "Title" and absorbed into "Title.mp4", leaving
  // "Title (Nude).mp4" script-less and hidden under the Matched tab.
  const videoBaseLocal = new Set();  // dir + '\0' + normalizedBase
  const videoBaseGlobal = new Set(); // normalizedBase
  await yieldTick();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const vext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(vext)) continue;
    const vbase = normalizeName(path.basename(entry.name, vext));
    videoBaseLocal.add(entryDir(entry) + '\0' + vbase);
    videoBaseGlobal.add(vbase);
  }

  // Collect all funscripts with variant/axis classification
  const funscriptList = [];
  await yieldTick();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== FUNSCRIPT_EXT) continue;

    const nameNoExt = path.basename(entry.name, ext);
    const fullPath = entryPath(entry);

    // Check for axis suffix: "video.vib" -> suffix "vib"
    const dotIdx = nameNoExt.lastIndexOf('.');
    const dotSuffix = dotIdx >= 0 ? nameNoExt.slice(dotIdx + 1).toLowerCase() : null;
    const isAxis = dotSuffix && AXIS_SUFFIXES.has(dotSuffix);

    // Check for parenthesized variant: "video (Soft)" -> label "Soft"
    const parenMatch = nameNoExt.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

    let videoBase, variantLabel;
    let isAmbiguousDotVariant = false;
    if (isAxis) {
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = null; // axis, not a variant
    } else if (parenMatch) {
      const fullBase = normalizeName(nameNoExt);
      const fsDir = entryDir(entry);
      if (videoBaseLocal.has(fsDir + '\0' + fullBase) || videoBaseGlobal.has(fullBase)) {
        // A video whose real title includes the parenthetical exists
        // (e.g. "Title (Nude).mp4"). The parens are part of the title,
        // not a variant suffix — treat this funscript as that video's
        // primary so the video isn't left script-less and hidden.
        videoBase = fullBase;
        variantLabel = null;
      } else {
        // Parenthesized variant — `"Title (Soft).funscript"` with only
        // "Title.mp4" present. Unambiguous user intent; treat as variant.
        videoBase = normalizeName(parenMatch[1]);
        variantLabel = parenMatch[2].trim();
      }
    } else if (dotSuffix && dotIdx > 0) {
      // AMBIGUOUS — could be a real variant ("video.intense.funscript")
      // OR just a filename that happens to contain a dot ("S01.E03.funscript",
      // "Title.2024.funscript"). We can't tell from the name in isolation.
      // Classify provisionally as a variant and let the post-pass below
      // demote it to primary if no sibling funscript exists with the
      // dot-stripped base (i.e., nothing for it to be a "variant of").
      videoBase = normalizeName(nameNoExt.slice(0, dotIdx));
      variantLabel = dotSuffix;
      isAmbiguousDotVariant = true;
    } else {
      videoBase = normalizeName(nameNoExt);
      variantLabel = null; // default/primary
    }

    funscriptList.push({
      name: entry.name,
      path: fullPath,
      dir: entryDir(entry),
      videoBase,
      variantLabel,
      isAxis,
      axisSuffix: isAxis ? dotSuffix : null,
      // Set for funscripts whose variant-ness was inferred from a dot
      // in the filename. Post-pass below demotes to primary when no
      // matching primary sibling exists.
      isAmbiguousDotVariant,
      // Cache the full-name normalisation for the demotion path so we
      // don't recompute it after the maps are built.
      fullNormalisedBase: normalizeName(nameNoExt),
      _used: false,
    });
  }

  // Post-pass: demote ambiguous dot-variants to primaries when no
  // sibling exists with the dot-stripped base. This rescues filenames
  // like "S01.E03.funscript" and "Title.2024.funscript" that the
  // classifier above would otherwise route to a non-existent base.
  // A sibling counts if it's a non-axis funscript in the same dir
  // (preferred) or anywhere (fallback) whose `videoBase` matches the
  // ambiguous variant's `videoBase`.
  const siblingBasesLocal = new Set();
  const siblingBasesGlobal = new Set();
  await yieldTick();
  for (const fs of funscriptList) {
    if (fs.isAxis || fs.isAmbiguousDotVariant) continue;
    siblingBasesLocal.add(fs.dir + '\0' + fs.videoBase);
    siblingBasesGlobal.add(fs.videoBase);
  }
  await yieldTick();
  for (const fs of funscriptList) {
    if (!fs.isAmbiguousDotVariant) continue;
    const localKey = fs.dir + '\0' + fs.videoBase;
    if (siblingBasesLocal.has(localKey) || siblingBasesGlobal.has(fs.videoBase)) {
      // Confirmed variant — a real primary exists. Clear the flag so
      // downstream code can treat the classification as settled.
      fs.isAmbiguousDotVariant = false;
      continue;
    }
    // Demote to primary using the full normalised name. "Title.2024"
    // becomes its own thing, matching "Title.2024.mp4".
    fs.videoBase = fs.fullNormalisedBase;
    fs.variantLabel = null;
    fs.isAmbiguousDotVariant = false;
  }

  // Build two maps: same-directory (preferred) and global (fallback)
  const funscriptMapLocal = new Map(); // dir+base → fs
  const funscriptMapGlobal = new Map(); // base → fs
  await yieldTick();
  for (const fs of funscriptList) {
    const localKey = fs.dir + '\0' + fs.videoBase;
    const globalKey = fs.videoBase;
    if (!fs.isAxis && !fs.variantLabel) {
      if (!funscriptMapLocal.has(localKey)) funscriptMapLocal.set(localKey, fs);
      if (!funscriptMapGlobal.has(globalKey)) funscriptMapGlobal.set(globalKey, fs);
    }
  }
  // Fallback: if no default variant, use first matching
  await yieldTick();
  for (const fs of funscriptList) {
    const localKey = fs.dir + '\0' + fs.videoBase;
    const globalKey = fs.videoBase;
    if (!fs.isAxis) {
      if (!funscriptMapLocal.has(localKey)) funscriptMapLocal.set(localKey, fs);
      if (!funscriptMapGlobal.has(globalKey)) funscriptMapGlobal.set(globalKey, fs);
    }
  }

  // Collect subtitle basenames — local (same-dir) and global maps
  const subtitleMapLocal = new Map();
  const subtitleMapGlobal = new Map();
  await yieldTick();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SUBTITLE_EXTS.includes(ext)) {
      const baseName = normalizeName(path.basename(entry.name, ext));
      const dir = entryDir(entry);
      const localKey = dir + '\0' + baseName;
      const sub = { name: entry.name, path: entryPath(entry), dir, _used: false };
      if (!subtitleMapLocal.has(localKey)) subtitleMapLocal.set(localKey, sub);
      if (!subtitleMapGlobal.has(baseName)) subtitleMapGlobal.set(baseName, sub);
    }
  }

  // Companion axis files ("Clip.roll.funscript") grouped by the video base
  // they belong to, so the video loop can claim them with one lookup instead
  // of another pass over every funscript per video.
  const axisByBase = new Map();
  for (const fs of funscriptList) {
    if (!fs.isAxis) continue;
    const bucket = axisByBase.get(fs.videoBase);
    if (bucket) bucket.push(fs);
    else axisByBase.set(fs.videoBase, [fs]);
  }

  // Build video list with funscript + subtitle + variant pairing
  const videos = [];
  // The folder each video sits in, as the funscripts record theirs (the
  // dirent's parent, not a re-joined path), and how many videos each folder
  // holds: the one-video-folder pass below needs both (FT-102).
  const videoDirOf = new Map();
  const videosPerDir = new Map();
  await yieldTick();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) continue;

    const baseName = normalizeName(path.basename(entry.name, ext));
    const dir = entryDir(entry);
    const localKey = dir + '\0' + baseName;

    // Funscript: prefer same directory, fall back to global
    const fsEntry = funscriptMapLocal.get(localKey) || funscriptMapGlobal.get(baseName) || null;
    const funscriptPath = fsEntry ? fsEntry.path : null;
    if (fsEntry) fsEntry._used = true;

    // Subtitle: prefer same directory, fall back to global
    const subEntry = subtitleMapLocal.get(localKey) || subtitleMapGlobal.get(baseName) || null;
    const subtitlePath = subEntry ? subEntry.path : null;
    if (subEntry) subEntry._used = true;

    // Collect variants: same directory first, then global matches
    const variants = [];
    const seenVariantPaths = new Set();
    // Pass 1: same directory
    for (const fs of funscriptList) {
      if (fs.videoBase !== baseName || fs.isAxis || fs.dir !== dir) continue;
      fs._used = true;
      seenVariantPaths.add(fs.path);
      variants.push({ label: fs.variantLabel || 'Default', path: fs.path, name: fs.name });
    }
    // Pass 2: global (other directories) — only if not already found locally
    if (variants.length === 0) {
      for (const fs of funscriptList) {
        if (fs.videoBase !== baseName || fs.isAxis || seenVariantPaths.has(fs.path)) continue;
        fs._used = true;
        variants.push({ label: fs.variantLabel || 'Default', path: fs.path, name: fs.name });
      }
    }
    // Companion axis files belong to this video too. Every pass above skips
    // them, and nothing else marked them, so they all landed in
    // `unmatchedFunscripts` and the Associate modal offered "Clip.roll" as the
    // MAIN script for unrelated videos (app test V34). Same directory first,
    // then anywhere, like the primary script. An axis file whose video does
    // not exist is never claimed, so a genuine orphan stays in the list.
    // Companion detection reads `allFunscripts`, so this changes no pairing.
    const axisFiles = axisByBase.get(baseName);
    if (axisFiles) {
      const local = axisFiles.filter((fs) => fs.dir === dir);
      for (const fs of (local.length > 0 ? local : axisFiles)) fs._used = true;
    }
    // Sort: Default first, then alphabetical
    variants.sort((a, b) => {
      if (a.label === 'Default') return -1;
      if (b.label === 'Default') return 1;
      return a.label.localeCompare(b.label);
    });

    // Resolve source name from sourceMap (match longest prefix)
    const fullPath = entryPath(entry);
    let sourceName = '';
    for (const [srcPath, srcName] of Object.entries(_sourceMap)) {
      if (fullPath.startsWith(srcPath) && srcPath.length > sourceName.length) {
        sourceName = srcName;
      }
    }

    videos.push({
      name: entry.name,
      path: fullPath,
      ext,
      hasFunscript: funscriptPath !== null,
      funscriptPath,
      hasSubtitle: subtitlePath !== null,
      subtitlePath,
      // Pass ALL detected variants through, even a single one. The
      // renderer decides whether to SHOW the switcher (it hides the
      // dropdown when the combined auto+manual count is < 2), and it
      // combines these with manually-associated variants — so dropping a
      // lone auto variant here used to hide the switcher for a video that
      // had 1 auto script + 1 manual variant (2 real scripts). It also
      // preserved the real label/path instead of a synthesised "Default".
      variants,
      sourceName: sourceName || path.basename(path.dirname(fullPath)) || 'Library',
      // `dateAdded` is populated in a batched stat pass below. Using `mtimeMs`
      // as a pragmatic "date added" proxy — cross-platform reliable (unlike
      // birthtimeMs on Linux ext4). Users typically want "recently appeared
      // in my folder", which matches mtime for fresh-dropped files.
      dateAdded: 0,
      // The file's size in bytes, from the same stat (Stash S1: the trust
      // check shows a video's Stash data only while its size is the one it
      // was matched with). null = unknown (the stat failed), which the check
      // treats as trusted.
      size: null,
    });
    videoDirOf.set(videos[videos.length - 1], dir);
    videosPerDir.set(dir, (videosPerDir.get(dir) || 0) + 1);
  }

  // Batched stat pass to fill `dateAdded` and `size`. Runs all stats in
  // parallel (libuv's thread pool naturally caps concurrency). Typical cost
  // for 1000 videos: ~10-50ms on SSD, ~100-500ms on HDD. Failures fall back
  // to 0 which sorts to the "oldest" end of the list, and to an unknown size.
  await Promise.all(videos.map(async (v) => {
    try {
      const st = await fs.promises.stat(v.path);
      v.dateAdded = st.mtimeMs || 0;
      v.size = Number.isSafeInteger(st.size) && st.size >= 0 ? st.size : null;
    } catch {
      v.dateAdded = 0;
      v.size = null;
    }
  }));

  // Fuzzy match pass: pair unmatched videos with high-confidence funscript matches
  // Uses token overlap (Jaccard index) — same logic as renderer fuzzy-match.js
  const fuzzyTokenize = (s) => s.toLowerCase().replace(/[_.\-()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const FUZZY_MIN = 98;
  // Jaccard index of two token SETS, as a whole percentage. Same number the
  // string version always gave: |A ∪ B| = |A| + |B| - |A ∩ B| for sets.
  const fuzzyScoreSets = (tokA, tokB) => {
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let inter = 0;
    for (const t of tokA) if (tokB.has(t)) inter++;
    return Math.round((inter / (tokA.size + tokB.size - inter)) * 100);
  };
  // |A ∩ B| / |A ∪ B| can never beat min(|A|,|B|) / max(|A|,|B|), so a pair
  // whose sizes alone keep it under FUZZY_MIN cannot be a match.
  const canReachMin = (tokA, tokB) => {
    const lo = Math.min(tokA.size, tokB.size);
    const hi = Math.max(tokA.size, tokB.size);
    return hi > 0 && Math.round((lo / hi) * 100) >= FUZZY_MIN;
  };
  // Tokenised once per funscript, not once per (video, funscript) pair. Per
  // pair, this pass was 3.3 s of a 5.1 s scan of 1,547 videos and 2,463
  // scripts on Dave's library, synchronous in the main process (V82).
  const fsTokens = new Map();
  for (const fs of funscriptList) {
    if (!fs.isAxis) fsTokens.set(fs, new Set(fuzzyTokenize(path.basename(fs.name, '.funscript'))));
  }

  for (const video of videos) {
    if (video.hasFunscript) continue; // already matched
    const videoBase = path.basename(video.name, path.extname(video.name));
    const videoTok = new Set(fuzzyTokenize(videoBase));
    let bestFs = null;
    let bestScore = 0;
    for (const fs of funscriptList) {
      if (fs._used || fs.isAxis) continue;
      const fsTok = fsTokens.get(fs);
      // Skipping a pair that cannot reach FUZZY_MIN never changes the
      // outcome: only a best score of FUZZY_MIN or more pairs anything.
      if (!canReachMin(videoTok, fsTok)) continue;
      const score = fuzzyScoreSets(videoTok, fsTok);
      if (score > bestScore) { bestScore = score; bestFs = fs; }
    }
    if (bestFs && bestScore >= FUZZY_MIN) {
      video.hasFunscript = true;
      video.funscriptPath = bestFs.path;
      video._fuzzyMatched = true;
      bestFs._used = true;

      // Also collect variants for this fuzzy match
      const fuzzyVariants = [];
      const seenPaths = new Set();
      for (const fs of funscriptList) {
        if (fs.isAxis) continue;
        const fsTok = fsTokens.get(fs);
        const s = canReachMin(videoTok, fsTok) ? fuzzyScoreSets(videoTok, fsTok) : 0;
        if (s >= FUZZY_MIN && !seenPaths.has(fs.path)) {
          seenPaths.add(fs.path);
          fuzzyVariants.push({ label: fs.variantLabel || 'Default', path: fs.path, name: fs.name });
        }
      }
      if (fuzzyVariants.length > 1) {
        fuzzyVariants.sort((a, b) => a.label === 'Default' ? -1 : b.label === 'Default' ? 1 : a.label.localeCompare(b.label));
        video.variants = fuzzyVariants;
      }
    }
  }

  // One-video folders (FT-102, Pudknocker #372), opt-in: a folder holding
  // exactly one video offers every other script in it as a variant of that
  // video, for journeys and FapLand rounds ("Round 1", "Round 2"... beside
  // one long video). After the name and fuzzy pairing, so the video's own
  // script stays index 0 (what a load plays, variant-select.js) and its own
  // variants keep their labels; the folder's other scripts follow in natural
  // order, labelled by file name. Axis files are never variants. A video with
  // no script of its own plays the first of them (`_folderVariantMain`).
  // Scan-time only: nothing is written, so turning the setting off simply
  // stops offering them, and a user's own association still leads (library.js
  // `_showUserSingle`).
  if (folderScriptsAsVariants) {
    await yieldTick();
    const scriptsByDir = new Map();
    for (const fs of funscriptList) {
      if (fs.isAxis) continue;
      const bucket = scriptsByDir.get(fs.dir);
      if (bucket) bucket.push(fs);
      else scriptsByDir.set(fs.dir, [fs]);
    }
    const byNatural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
    let offered = 0;
    let folders = 0;
    for (const video of videos) {
      const dir = videoDirOf.get(video);
      if (videosPerDir.get(dir) !== 1) continue;
      const inFolder = scriptsByDir.get(dir);
      if (!inFolder) continue;
      const list = Array.isArray(video.variants) ? video.variants.slice() : [];
      // A fuzzy-paired script gets no variant list from the passes above:
      // name it the way they name a video's unlabelled script.
      if (list.length === 0 && video.funscriptPath) {
        list.push({ label: 'Default', path: video.funscriptPath, name: path.basename(video.funscriptPath) });
      }
      const listed = new Set(list.map((v) => v.path));
      const extra = inFolder.filter((fs) => !listed.has(fs.path)).sort((a, b) => byNatural(a.name, b.name));
      if (extra.length === 0) continue;
      // Labels pick the variant (the pinned default, the phone's switch), so
      // they stay unique: a stem that repeats one is shown with its extension.
      const labels = new Set(list.map((v) => String(v.label).toLowerCase()));
      for (const fs of extra) {
        const stem = path.basename(fs.name, path.extname(fs.name));
        const label = labels.has(stem.toLowerCase()) ? fs.name : stem;
        labels.add(label.toLowerCase());
        list.push({ label, path: fs.path, name: fs.name });
        fs._used = true;
      }
      video.variants = list;
      if (!video.funscriptPath) {
        video.hasFunscript = true;
        video.funscriptPath = list[0].path;
        // Not the video's own script, only the folder's first. library.js
        // reads this so nothing it does unasked (the multi-axis auto-promote)
        // stores it as an association, and Assign script still treats the
        // video as having none (block E2 review).
        video._folderVariantMain = true;
      }
      offered += extra.length;
      folders++;
    }
    if (folders > 0) log.info(`[Library] One-video folders: ${offered} script(s) offered as variants in ${folders} folder(s)`);
  }

  // A variant's own axis files belong to its video too: "Title (muted).vib
  // .funscript" beside "Title (muted).funscript", a variant of "Title.mp4".
  // Their base ("title (muted)") names no video, so nothing above claimed
  // them and they were listed as unmatched scripts, offered as the main
  // script of other videos (TODO 2026-11-20). The player plays them with
  // that variant, from the variant's folder and by its exact name
  // (multi-axis.js `sameFolderCompanions`), so the claim follows that rule.
  const stemOf = (name) => String(name).replace(/\.funscript$/i, '').toLowerCase();
  const scriptByPath = new Map(funscriptList.map((fs) => [fs.path, fs]));
  await yieldTick();
  for (const video of videos) {
    for (const variant of video.variants || []) {
      const own = scriptByPath.get(variant.path);
      if (!own || own.isAxis) continue;
      const stem = stemOf(own.name);
      for (const axis of axisByBase.get(own.fullNormalisedBase) || []) {
        if (axis.dir === own.dir && stemOf(axis.name) === `${stem}.${axis.axisSuffix}`) axis._used = true;
      }
    }
  }

  // One collator for the four name sorts below. `a.localeCompare(b, undefined,
  // opts)` is defined as comparing with `new Intl.Collator(undefined, opts)`,
  // so the order is identical; building that collator per COMPARISON was
  // ~230 ms of a 1,547-video scan (V82).
  const byNameBase = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

  // Collect unmatched funscripts (not paired to any video)
  const unmatchedFunscripts = [];
  await yieldTick();
  for (const fs of funscriptList) {
    if (!fs._used) {
      unmatchedFunscripts.push({ name: fs.name, path: fs.path });
    }
  }
  unmatchedFunscripts.sort((a, b) => byNameBase(a.name, b.name));

  // Collect unmatched subtitles
  const unmatchedSubtitles = [];
  for (const subEntry of subtitleMapGlobal.values()) {
    if (!subEntry._used) {
      unmatchedSubtitles.push({ name: subEntry.name, path: subEntry.path });
    }
  }
  unmatchedSubtitles.sort((a, b) => byNameBase(a.name, b.name));

  // Collect all funscripts for multi-axis dropdowns
  const allFunscripts = [];
  await yieldTick();
  for (const fs of funscriptList) {
    allFunscripts.push({ name: fs.name, path: fs.path });
  }
  allFunscripts.sort((a, b) => byNameBase(a.name, b.name));

  // Sort alphabetically
  videos.sort((a, b) => byNameBase(a.name, b.name));
  log.info(`[Library] Result: ${videos.length} videos, ${unmatchedFunscripts.length} unmatched fs, ${allFunscripts.length} total fs (${Date.now() - scanStart}ms total)`);

  return { videos, unmatchedFunscripts, unmatchedSubtitles, allFunscripts, failedPaths, skippedPaths };
}

module.exports = { scanLibrary, walkSource, rootListable, yieldTick, AXIS_SUFFIXES };
