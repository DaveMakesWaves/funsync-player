// "Replace <name>?": asked before an EroScripts download replaces an
// existing, different file. One question for everything one click would
// replace (a multi-axis set asks once for its main and axis files, R3-02).
// Replace means: each old file goes to the Recycle Bin / Trash first (the
// download IPC does that), so it can be got back. Cancel writes nothing.
//
// Shared by the EroScripts panel and the search inside Associate Funscript,
// so both ask the same question in the same words.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { binOs } from '../js/recycle-bin.js';

/**
 * @param {string[]} names file names (not paths) that would be replaced
 * @returns {Promise<boolean>} true = Replace; false = Cancel / Escape / close
 */
export async function askReplaceFiles(names) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean);
  if (list.length === 0) return true;
  const os = binOs();
  const one = list.length === 1;
  const answer = await Modal.confirm(
    one
      ? t('eroscripts.replaceTitle', { name: list[0] })
      : t('eroscripts.replaceManyTitle', { count: list.length }),
    one
      ? t('eroscripts.replaceMessage', { os })
      : t('eroscripts.replaceManyMessage', { names: list.join(', '), os }),
    { confirmText: t('eroscripts.replaceBtn') },
  );
  return answer === true;
}

/**
 * No write will come for `url` (the user answered Cancel, or the set
 * stopped): main may drop the bytes the look fetched for it (R4-09; they
 * used to wait there for 5 minutes, a few large .zip files could hold
 * hundreds of MB). Fire and forget; never throws.
 * @param {string} url
 */
export function forgetFetched(url) {
  try {
    Promise.resolve(window.funsync?.eroscriptsForgetDownload?.(url)).catch(() => {});
  } catch { /* nothing to forget */ }
}
