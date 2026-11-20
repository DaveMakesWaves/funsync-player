/**
 * eroscripts-error-text.js — the words to SHOW for a failed EroScripts call.
 *
 * electron/eroscripts-api.js answers a failure with an English `error`
 * sentence (kept for the log) and an `errorCode` (+ the HTTP `status` where
 * it matters). The panel and the Associate search used to print `error`
 * as-is, so a French or Japanese user read "Access denied — try logging in
 * again" and "Rate limited — try again in a moment" in English (verify-2,
 * 2026-11-07; also in v0.9.2). Shown text goes through t(); an answer with no
 * code we know (an older main, a download error) keeps its own text.
 */
import { t } from './i18n.js';

const KEYS = {
  rateLimited: 'eroscripts.error.rateLimited',
  accessDenied: 'eroscripts.error.accessDenied',
  searchFailed: 'eroscripts.error.searchFailed',
  topicFailed: 'eroscripts.error.topicFailed',
  noPosts: 'eroscripts.error.noPosts',
  network: 'eroscripts.error.network',
};

/**
 * @param {{error?: string, errorCode?: string, status?: number}|null|undefined} answer
 * @param {(key: string, params?: object) => string} [translate]
 * @returns {string}
 */
export function eroscriptsErrorText(answer, translate = t) {
  const key = KEYS[answer?.errorCode];
  if (key) return translate(key, { status: answer.status ?? '' });
  return String(answer?.error || '');
}

export const EROSCRIPTS_ERROR_KEYS = Object.freeze({ ...KEYS });
