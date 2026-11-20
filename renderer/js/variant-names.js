// What a script variation is CALLED on screen, and the list the phone gets
// (FN-03 / FN-04, Dave 2026-11-16: "the default means nothing, the name of
// the currently assigned script should be highlighted but just showing it as
// default is a pain"; "yes variations should show on phone").
//
// The library scan (electron/library-scan.js) labels a script with no label
// of its own 'Default', in English. That word stays in the DATA: a pin
// (`library.preferredVariants`), the pop-out's switch, the phone's switch and
// the backend's `?variant=` all match on labels. On screen such an entry is
// named after its own file instead, and the script the video opens on (the
// assigned one) carries a small "main" marker beside its name.
//
// Pure: no DOM, no i18n, no settings, nothing written. app.js
// `_variantLabelText` applies the same naming rule inline (its lifted tests
// inject `t` only); tests/unit/variant-names.test.js pins the two together.

/** The scan's word for a script with no label of its own (data, never shown). */
export const UNLABELLED_VARIANT = 'Default';

/** True when the entry has no label of its own (empty, or the scan's word). */
export function isUnlabelledVariant(variant) {
  const label = String(variant?.label ?? '').trim();
  return !label || label === UNLABELLED_VARIANT;
}

/** The entry's file name without `.funscript` ('' when it has neither name nor path). */
export function variantFileStem(variant) {
  const file = String(variant?.name ?? '').trim()
    || String(variant?.path ?? '').split(/[\\/]/).pop() || '';
  return file.replace(/\.funscript$/i, '').trim();
}

/**
 * The name shown for one entry: its own label, or for an unlabelled one its
 * file name. '' only for an entry with no label, name or path (the caller
 * has the last word for that case).
 */
export function variantDisplayName(variant) {
  if (!isUnlabelledVariant(variant)) return String(variant.label);
  return variantFileStem(variant);
}

/**
 * The variation list a library video carries to the phone (FN-04): the
 * desktop menu's own list in its own order (app.js `_updateVariantSelector`):
 * the scan's / association's entries, then the hand-added ones
 * (`library.manualVariants[video.path]`) that list does not already hold (by
 * path). A video whose scan list is empty but that has hand-added ones gets
 * its own script first, as the desktop menu offers it. Each entry is a COPY:
 *   label  what a switch matches on (unchanged data)
 *   path, name
 *   text   what is shown (variantDisplayName)
 *   main   the script the video opens on (`video.funscriptPath`)
 * Nothing is read from disk and nothing is written.
 *
 * @param {{variants?: Array, funscriptPath?: string|null}} video
 * @param {Array<{label: string, path: string, name?: string}>} [manual]
 * @returns {Array<{label: string, path: string, name: string, text: string, main: boolean}>}
 */
export function remoteVariantList(video, manual = []) {
  let base = Array.isArray(video?.variants) ? video.variants.filter(Boolean) : [];
  const own = Array.isArray(manual) ? manual.filter(Boolean) : [];
  const mainPath = video?.funscriptPath || null;
  if (base.length === 0 && own.length > 0 && mainPath) {
    base = [{ label: UNLABELLED_VARIANT, path: mainPath, name: String(mainPath).split(/[\\/]/).pop() }];
  }
  const seen = new Set(base.map((v) => v.path));
  const all = [...base, ...own.filter((v) => !seen.has(v.path))];
  const mainAt = mainPath ? base.findIndex((v) => v.path === mainPath) : -1;
  return all.map((v, i) => ({
    label: v.label,
    path: v.path,
    name: v.name || String(v.path || '').split(/[\\/]/).pop(),
    text: variantDisplayName(v),
    main: i === mainAt,
  }));
}
