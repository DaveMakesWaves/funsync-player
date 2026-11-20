// What the OS calls the place a moved-away file goes (R3-06): "Recycle Bin"
// on Windows, "Trash" on Linux and macOS. The English text said Recycle Bin
// everywhere.
//
// Every string that names it takes an `os` parameter and picks the word with
// ICU select, so each language words both cases its own way:
//   "… goes to the {os, select, win {Recycle Bin} other {Trash}} …"
// Pass `{ os: binOs() }` to every such t() call. A string with a select must
// always be given its params: t() without params returns the raw template.

/**
 * @param {string} [platform] Node's process.platform; defaults to the one the
 *   preload hands the renderer (window.funsync.platform).
 * @returns {'win'|'other'}
 */
export function binOs(platform) {
  const p = platform !== undefined
    ? platform
    : (typeof window !== 'undefined' ? window.funsync?.platform : undefined);
  return p === 'win32' ? 'win' : 'other';
}
