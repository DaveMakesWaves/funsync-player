// Free or paid, for the EroScripts tab (Dave, 2026-11-22: "we also need to
// indicate if the script is paid or not and be able to easily filter free
// ones only").
//
// EroScripts files scripts in two categories under Scripts: Free Scripts
// (14, https://discuss.eroscripts.com/c/scripts/free-scripts/14) and Paid
// Scripts (15). A search result and a topic both carry the category number
// (electron/eroscripts-api.js `categoryId`). The forum's search narrows to
// one of them with its category hashtag, so a filtered search returns whole
// pages of that kind instead of a page thinned out after the fact.

export const FREE_SCRIPTS_CATEGORY = 14;
export const PAID_SCRIPTS_CATEGORY = 15;
export const PRICE_FILTERS = Object.freeze(['all', 'free', 'paid']);

/** 'free' | 'paid' | null (another category, or not known). */
export function priceOf(categoryId) {
  const id = Number(categoryId);
  if (id === FREE_SCRIPTS_CATEGORY) return 'free';
  if (id === PAID_SCRIPTS_CATEGORY) return 'paid';
  return null;
}

/** A stored filter, or 'all' for anything else. */
export function normalizePriceFilter(value) {
  return PRICE_FILTERS.includes(value) ? value : 'all';
}

/** The query sent to the forum for a filter: the category's hashtag added. */
export function queryForPrice(query, filter) {
  const q = String(query || '').trim();
  const f = normalizePriceFilter(filter);
  if (!q || f === 'all') return q;
  return `${q} #${f === 'free' ? 'free-scripts' : 'paid-scripts'}`;
}

/**
 * Does a result belong under the filter? A result in the other category is
 * left out; one whose category is not known is kept (the forum's own search
 * already narrowed it).
 */
export function matchesPrice(topic, filter) {
  const f = normalizePriceFilter(filter);
  if (f === 'all') return true;
  const p = priceOf(topic?.categoryId);
  return p === null || p === f;
}
