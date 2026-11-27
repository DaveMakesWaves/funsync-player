/**
 * @vitest-environment jsdom
 *
 * The player's variation menu marks a variation whose file is gone, as the
 * video options dialog does (fixup-ui followUp3, 2026-11-18; also in v0.9.2).
 * It used to list it and only find out on the pick: `_switchVariant` put back
 * what played and toasted. Only a definite "absent" marks it; a check that
 * cannot answer (a spun-down drive) leaves the row as it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const LIB = 'C:\Lib';
const MAIN = `${LIB}\Clip.funscript`;
const GONE = `${LIB}\Clip (soft).funscript`;
const UNKNOWN = `${LIB}\Clip (hard).funscript`;

function setup(statusOf) {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<button id="variant-btn"></button><div id="variant-dropdown" hidden></div>';
  const Lifted = liftAppClass(['_showVariantDropdown', '_markVariantItemIfMissing', '_variantLabelText'], { document, t, showToast: () => {} });
  const app = Object.assign(new Lifted(), {
    _allVariantsWithManual: [
      { label: 'Default', path: MAIN },
      { label: 'soft', path: GONE },
      { label: 'hard', path: UNKNOWN },
      { label: 'pasted' },                       // no file of its own: never checked
    ],
    _activeVariantIndex: 0,
    _currentVideoPath: `${LIB}\Clip.mp4`,
    settings: { get: () => ({}) },
    _getPreferredVariantLabel: () => null,
    _switchVariant: vi.fn(),
    library: { _pathStatus: vi.fn(async (p) => statusOf(p)) },
  });
  return app;
}
const items = () => [...document.querySelectorAll('#variant-dropdown .variant-selector__item')];

describe('the player\'s variation menu and a missing file', () => {
  let app;
  beforeEach(() => {
    app = setup((p) => (p === GONE ? false : p === UNKNOWN ? null : true));
    app._showVariantDropdown();
  });

  it('a variation whose file is gone is dimmed, says "Script not found" and cannot be picked', async () => {
    await vi.waitFor(() => expect(items()[1].classList.contains('variant-selector__item--missing')).toBe(true));
    expect(items()[1].disabled).toBe(true);
    expect(items()[1].querySelector('.variant-selector__missing-tag').textContent).toBe(EN.videoOptions.script.status.missing);
    items()[1].click();
    expect(app._switchVariant).not.toHaveBeenCalled();
  });

  it('one that exists, one the check cannot answer for, and one with no file stay as they were', async () => {
    await vi.waitFor(() => expect(items()[1].disabled).toBe(true));
    for (const i of [0, 2, 3]) {
      expect(items()[i].disabled).toBe(false);
      expect(items()[i].classList.contains('variant-selector__item--missing')).toBe(false);
    }
    expect(app.library._pathStatus).not.toHaveBeenCalledWith(undefined);
    items()[2].click();
    expect(app._switchVariant).toHaveBeenCalledWith(2);
  });

  it('an answer that comes after the menu was drawn again marks only the new menu', async () => {
    app._showVariantDropdown();                // drawn again: its answers are still on the way
    const stale = items()[1];
    app._showVariantDropdown();                // and again, before they come
    await vi.waitFor(() => expect(items()[1].disabled).toBe(true));
    expect(stale.isConnected).toBe(false);
    expect(stale.querySelector('.variant-selector__missing-tag')).toBeNull();
  });
});
