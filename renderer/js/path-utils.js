// Pure path-comparison helpers used by library scanning and source-folder
// management. Renderer-side only; electron/main.js inlines the equivalent
// logic so both sides dedupe overlapping sources identically.

/**
 * Convert an absolute filesystem path to a `file://` URL the HTML5 video
 * element (or any browser-side consumer) can load. Handles:
 *   - Backslash → forward slash normalisation (Windows)
 *   - Percent-encoding of `#`, `?`, `%`, spaces, and other reserved chars
 *     via `encodeURI()`. Without this, `Your Step-sister #1.mp4` becomes
 *     a URL whose fragment is `1.mp4` — the file portion truncates at the
 *     `#` and the browser reports "format not supported".
 *   - Windows drive-letter paths (`C:\...` → `file:///C:/...`) vs Unix
 *     absolute paths (`/home/...` → `file:///home/...`).
 *
 * Do NOT hand-roll `file:///${path.replace(/\\/g,'/')}`; always route
 * through this helper.
 *
 * @param {string} absPath — absolute filesystem path
 * @returns {string} `file:///...` URL ready to assign to video.src / fetch()
 */
export function pathToFileURL(absPath) {
  if (!absPath) return '';
  const forward = String(absPath).replace(/\\/g, '/');
  // encodeURI handles spaces, `%`, Unicode, etc. — but DELIBERATELY leaves
  // `#` and `?` alone because they're URL-structural characters. For a
  // file path those characters are just filename bytes, so we need to
  // percent-encode them manually after encodeURI. Without this step,
  // a filename like "Your Step-sister #1.mp4" truncates at the `#` and
  // the browser reports "format not supported".
  const encoded = encodeURI(forward)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  // Unix absolute paths already start with `/`; Windows paths start with a
  // drive letter. Both want `file:///` as the prefix — the third slash
  // merges with the leading `/` on Unix to produce `file:///foo/bar`, and
  // sits before the drive letter on Windows: `file:///C:/foo`.
  return encoded.startsWith('/')
    ? `file://${encoded}`
    : `file:///${encoded}`;
}

/**
 * Normalise a filesystem path for comparison:
 *   - Drop trailing slashes
 *   - Lowercase Windows drive letters
 *   - Convert backslashes to forward slashes
 *
 * Does NOT resolve symlinks / junctions (that requires fs access) — callers
 * in the main process can additionally pass paths through `fs.realpathSync`
 * when they care about that.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalPath(p) {
  if (!p) return '';
  let out = String(p).replace(/\\/g, '/');
  // Strip trailing slashes but preserve a root slash on unix paths
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  // Lowercase a leading Windows drive letter: C:/ → c:/
  if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out;
}

/**
 * Is `child` a strict descendant of `parent`? Returns false when the paths
 * are equal — use `canonicalPath(a) === canonicalPath(b)` for that case.
 */
export function isSubpath(child, parent) {
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  if (!c || !p || c === p) return false;
  return c.startsWith(p + '/');
}

/**
 * Longest folder path shared by every file in `filePaths`. Takes file paths
 * (not directories) and drops the filename segment before comparing. Returns
 * an empty string when there is no shared prefix (e.g., files from different
 * drives). Paths are canonicalised first so separator style doesn't matter.
 *
 * Used when a collection needs a representative "source folder" label —
 * pinning the VR subfolder as a collection should show `d:/VR`, not the
 * library's configured root source.
 *
 * @param {string[]} filePaths
 * @returns {string}
 */
export function commonAncestorOfFiles(filePaths) {
  if (!filePaths || filePaths.length === 0) return '';
  const dirs = filePaths
    .map(p => canonicalPath(p))
    .filter(Boolean)
    .map(p => {
      const idx = p.lastIndexOf('/');
      return idx > 0 ? p.slice(0, idx) : p;
    });
  if (dirs.length === 0) return '';
  if (dirs.length === 1) return dirs[0];

  const parts = dirs.map(d => d.split('/'));
  const minLen = Math.min(...parts.map(p => p.length));
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = parts[0][i];
    if (parts.every(p => p[i] === seg)) common.push(seg);
    else break;
  }
  return common.join('/');
}

/**
 * Classify how a newly-proposed source path relates to a list of existing
 * source paths. Used by the settings UI to show the right warning.
 *
 * @param {string} newPath
 * @param {Array<{path: string, name?: string}>} existing
 * @returns {{kind: 'none'} | {kind: 'exact', source: object} | {kind: 'child', parent: object} | {kind: 'parent', children: object[]}}
 */
export function classifyOverlap(newPath, existing) {
  const canonical = canonicalPath(newPath);
  if (!canonical) return { kind: 'none' };

  for (const src of existing) {
    if (canonicalPath(src.path) === canonical) {
      return { kind: 'exact', source: src };
    }
  }

  for (const src of existing) {
    if (isSubpath(canonical, src.path)) {
      return { kind: 'child', parent: src };
    }
  }

  const children = existing.filter(src => isSubpath(src.path, canonical));
  if (children.length > 0) {
    return { kind: 'parent', children };
  }

  return { kind: 'none' };
}
