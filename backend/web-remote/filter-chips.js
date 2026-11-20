// Phone filter chips: which chips show, with what text (FT-063).
//
// Pure: no DOM, no module state. app.js `renderFilterChips` draws what this
// returns. The labels were an English literal map, so the chip text and its
// "Remove filter: ..." aria-label stayed English in every language although
// the filter sheet, with the same four words, was translated. They come from
// the filter sheet's own keys now, through the phone's `t`.

/** The "no filter" value per filter; a chip shows only for anything else. */
export const FILTER_DEFAULTS = { tab: 'all', vr: 'all' };

/** The filter sheet's key for each filter value, so chip and sheet agree. */
const LABEL_KEYS = {
  tab: {
    matched: 'webRemote.filterSheet.matchMatched',
    unmatched: 'webRemote.filterSheet.matchUnmatched',
  },
  vr: {
    vr: 'webRemote.filterSheet.vrOnly',
    flat: 'webRemote.filterSheet.vrFlat',
  },
};

/**
 * @param {{tab?: string, vr?: string, tags?: string[]}} state the phone's `uiState`
 * @param {(key: string, params?: object) => string} t the phone's i18n `t`
 * @param {{tagLabel?: (key: string) => string}} [options] `tagLabel` gives a
 *   picked tag's chip text (app.js: "Device: the handy", translated); without
 *   it the key is shown
 * @returns {{key: string, value?: string, label: string, ariaLabel: string}[]}
 *   in display order: the match and VR chips, then one chip per picked tag
 *   (`key: 'tag'`, `value`: the tag's key, P1 tags 2026-11-18)
 */
export function chipModel(state, t, { tagLabel } = {}) {
  const chips = [];
  for (const key of ['tab', 'vr']) {
    const value = state?.[key];
    if (!value || value === FILTER_DEFAULTS[key]) continue;
    const labelKey = LABEL_KEYS[key]?.[value];
    const label = labelKey ? t(labelKey) : String(value);
    chips.push({ key, label, ariaLabel: t('webRemote.filterChips.removeAria', { label }) });
  }
  const seen = new Set();
  for (const value of Array.isArray(state?.tags) ? state.tags : []) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    const label = typeof tagLabel === 'function' ? String(tagLabel(value)) : value;
    chips.push({ key: 'tag', value, label, ariaLabel: t('webRemote.filterChips.removeAria', { label }) });
  }
  return chips;
}
