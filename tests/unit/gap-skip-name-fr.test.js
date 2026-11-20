/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds the Playback tab as DOM and
 * i18n.js / settings-panel.js branch on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// CB-21 (block B verification, 2026-11-05): the French Settings rail and
// section header called Gap Skip "Saut d'espace", literally "space jump".
// fr.json had four names for the one feature: "Saut d'espace" (header),
// "Saut de blanc" (the Gap Filler hint that points at it), "saut de vide"
// (the G row of the ? overlay) and "Passer le creux" (the phone's chip),
// while the Gap Filler next to it says "Remplissage des blancs". A script
// gap is now "blanc" throughout Gap Skip, the way the Gap Filler already
// says it, and every string that names the setting uses the header's name.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const FR = bundle('fr');

afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('fr', FR, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

function frenchPlayback() {
  const panel = new SettingsPanel({ settings: { get: () => undefined, set: () => {}, getAll: () => ({}) } });
  const tab = panel._buildPlaybackTab();
  document.body.appendChild(tab);
  return { panel, tab };
}

describe('CB-21: French names Gap Skip as a skip of blanks, one name everywhere', () => {
  it('the Settings rail link and the section header read "Saut des blancs"', () => {
    const { panel, tab } = frenchPlayback();
    const rail = panel._railAreas().find((a) => a.id === 'playback').groups.find((g) => g.id === 'sp-sec-gapskip');
    expect(rail.label).toBe('Saut des blancs');
    expect(tab.querySelector('#sp-sec-gapskip .settings-panel__section-header').textContent).toBe('Saut des blancs');
  });

  it("no French Gap Skip string says 'espace' (space), 'vide' or 'creux' for a script gap", () => {
    const { tab } = frenchPlayback();
    const gapSkip = [
      tab.querySelector('#sp-sec-gapskip .settings-panel__section-header').textContent,
      tab.querySelector('#sp-gap-hint').textContent,
      FR.kbd.skipNextAction,
      FR.webRemote.player.skipGap,
    ];
    for (const s of gapSkip) {
      expect(s, s).not.toMatch(/espace|vide|creux/i);
      expect(s, s).toMatch(/blanc/i);
    }
  });

  it('the Gap Filler hint and the ? overlay name the setting exactly as its header does', () => {
    const { panel, tab } = frenchPlayback();
    const name = tab.querySelector('#sp-sec-gapskip .settings-panel__section-header').textContent;
    expect(tab.querySelector('#sp-filler-hint').textContent).toContain(name);
    expect(FR.kbd.skipNextAction.toLowerCase()).toContain(name.toLowerCase());
    // The Gap Filler header (the section right after it, with its own rail
    // entry since pf-fixup) already said "blancs": the two now agree.
    const headers = [...tab.querySelectorAll('#sp-sec-gapskip .settings-panel__section-header, #sp-sec-gapfiller .settings-panel__section-header')].map((h) => h.textContent);
    expect(headers).toEqual(['Saut des blancs', 'Remplissage des blancs']);
    const rail = panel._railAreas().find((a) => a.id === 'playback').groups.find((g) => g.id === 'sp-sec-gapfiller');
    expect(rail.label).toBe('Remplissage des blancs');
  });
});
