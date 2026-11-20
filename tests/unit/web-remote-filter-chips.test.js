/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 * (The phone's i18n `t` touches no DOM; only translatePage does.)
 */
// FT-063: the phone's filter chips were English in every language. The chip
// text came from an English literal map in app.js ("Matched", "Non-VR"), its
// aria-label was the literal "Remove filter: ...", while the filter sheet
// beside them, with the same four words, was translated.
//
// `chipModel` is driven with the REAL phone `t` (backend/web-remote/i18n.js)
// over the REAL locale bundles the backend serves to the phone.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { chipModel, FILTER_DEFAULTS } from '../../backend/web-remote/filter-chips.js';
import { t, _setBundlesForTests, _resetForTests } from '../../backend/web-remote/i18n.js';

const bundle = (lang) => JSON.parse(fs.readFileSync(`renderer/locales/${lang}.json`, 'utf8'));

// The aria-label's key is new in FT-063 and reaches the locale files in the
// strings stage. Until it does, the phone falls back to English for it, so
// the English template stands in for a MISSING key only; a present one is
// always the real value.
function withNewKeys(b) {
  const out = structuredClone(b);
  out.webRemote.filterChips.removeAria ??= 'Remove filter: {label}';
  return out;
}

const ENGLISH = ['Matched', 'Unmatched', 'VR only', 'Non-VR'];

beforeEach(() => { _resetForTests(); });

describe('phone filter chips speak the desktop\'s language (FT-063)', () => {
  it('German: chip text is the filter sheet\'s German, and so is the label in the aria-label', () => {
    const de = withNewKeys(bundle('de'));
    _setBundlesForTests('de', de, withNewKeys(bundle('en')));

    const chips = chipModel({ tab: 'matched', vr: 'flat' }, t);

    expect(chips.map((c) => c.key)).toEqual(['tab', 'vr']);
    expect(chips.map((c) => c.label)).toEqual([de.webRemote.filterSheet.matchMatched, de.webRemote.filterSheet.vrFlat]);
    expect(chips.map((c) => c.label)).toEqual(['Zugeordnet', 'Kein VR']);
    for (const c of chips) {
      expect(ENGLISH).not.toContain(c.label);
      expect(c.ariaLabel).toBe(t('webRemote.filterChips.removeAria', { label: c.label }));
      expect(c.ariaLabel).toContain(c.label);
      for (const word of ENGLISH) expect(c.ariaLabel).not.toContain(word);
    }
  });

  it('the other two values, in French', () => {
    const fr = withNewKeys(bundle('fr'));
    _setBundlesForTests('fr', fr, withNewKeys(bundle('en')));
    const chips = chipModel({ tab: 'unmatched', vr: 'vr' }, t);
    expect(chips.map((c) => c.label)).toEqual([fr.webRemote.filterSheet.matchUnmatched, fr.webRemote.filterSheet.vrOnly]);
    for (const c of chips) expect(ENGLISH).not.toContain(c.label);
  });

  it('English is unchanged: the same words the literal map had', () => {
    _setBundlesForTests('en', withNewKeys(bundle('en')), withNewKeys(bundle('en')));
    const chips = chipModel({ tab: 'matched', vr: 'vr' }, t);
    expect(chips.map((c) => c.label)).toEqual(['Matched', 'VR only']);
    expect(chips[0].ariaLabel).toBe('Remove filter: Matched');
  });

  it('no chip for a filter at its default; nothing at all with none active', () => {
    _setBundlesForTests('en', withNewKeys(bundle('en')), withNewKeys(bundle('en')));
    expect(chipModel({ ...FILTER_DEFAULTS }, t)).toEqual([]);
    expect(chipModel({ tab: 'all', vr: 'flat' }, t).map((c) => c.key)).toEqual(['vr']);
    expect(chipModel(undefined, t)).toEqual([]);
  });
});
