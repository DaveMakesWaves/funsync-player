// A file name taken from the forum, made safe to save under (R3-04).
//
// EroScripts attachment names come from the LINK TEXT of a post's HTML, which
// the poster wrote. The panel joined that text into the save path as it was,
// so `../x.funscript` (or `..\x.funscript`) could leave the chosen folder,
// and a name with `:` or `?` failed on Windows.

const DOWNLOAD_EXT = /\.(funscript|zip)$/i;
// Device names Windows reserves, with or without an extension.
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Most file systems allow 255 BYTES per name; leave room for a " (2)".
const MAX_NAME_BYTES = 240;

const _utf8Length = (s) => new TextEncoder().encode(s).length;

/**
 * The attachment's name, safe to join to a folder:
 *   - the last path segment only (no `/`, `\` or `..` survives);
 *   - control characters removed, Windows' reserved characters `<>:"|?*`
 *     replaced with `_`;
 *   - no leading dots or spaces (no `..`, no hidden file), no trailing dots or
 *     spaces (Windows drops them, so the file would not be found again);
 *   - a reserved Windows device name (`CON`, `NUL`, `COM1` …) gets a `_`;
 *   - at most 240 UTF-8 bytes, cut from the name, never the extension.
 * Returns '' when nothing usable is left: no `.funscript` / `.zip` extension
 * after cleaning, or nothing but dots, spaces and underscores before it. The
 * caller refuses such a download rather than invent a name.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function safeAttachmentName(name) {
  if (typeof name !== 'string') return '';
  let s = name.split(/[\\/]/).pop() || '';
  s = s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const ext = s.match(DOWNLOAD_EXT);
  if (!ext) return '';
  let stem = s.slice(0, s.length - ext[0].length);
  if (!stem.replace(/[.\s_]/g, '')) return '';
  if (RESERVED_WIN.test(stem.split('.')[0].trim())) stem = `_${stem}`;
  while (_utf8Length(stem + ext[0]) > MAX_NAME_BYTES) {
    stem = Array.from(stem).slice(0, -1).join('').replace(/[.\s]+$/, '');
  }
  return stem + ext[0];
}
