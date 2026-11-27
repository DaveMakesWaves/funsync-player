/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders its empty state in the
 * document, and library.js imports DOM-branching modules (notes/CLAUDE.md
 * "Test environments").
 */
// R3 fix-up (real-app verifier 2, 2026-11-06): with every source folder
// switched off (not removed), the Library view said "Add a source folder to
// browse your video library", although the user has two. It now says they
// are switched off and where to turn one on. With no source at all, the old
// line stays. The Add Source Folder button is there in both.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { Library } from '../../renderer/components/library.js';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

function libraryWith(sources) {
  document.body.innerHTML = '<div id="lib"></div>';
  const store = { 'library.sources': sources };
  const lib = new Library({ settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } } });
  lib.show(document.getElementById('lib'));
  return {
    text: () => document.querySelector('.library__empty-text')?.textContent,
    button: () => document.querySelector('.library__empty-btn')?.textContent,
  };
}

afterEach(() => { _setBundlesForTests('en', EN, EN); document.body.innerHTML = ''; });

describe('the Library\'s empty state says why it is empty (R3 fix-up)', () => {
  const OFF = [
    { id: 'a', name: 'library', path: 'C:\\sandbox\\library', enabled: false },
    { id: 'b', name: 'bulk', path: 'C:\\sandbox\\bulk', enabled: false },
  ];

  it('every source switched off: "switched off ... Settings > Library", not "Add a source folder"', () => {
    _setBundlesForTests('en', EN, EN);
    const view = libraryWith(OFF);
    // The area is "Library" since the Settings re-sort (2026-11-23).
    expect(view.text()).toBe('Your source folders are all switched off. Turn one on in Settings > Library to browse it.');
    expect(view.text()).not.toBe(EN.library.noSourcesEmpty);
    expect(view.button()).toBe(EN.library.addSourceFolder);
  });

  it('in German, with the German names of Settings and its Sources tab', () => {
    _setBundlesForTests('de', DE, EN);
    const view = libraryWith(OFF);
    expect(view.text()).toBe(DE.library.sourcesAllOff
      .replace('{settings}', DE.settingsPanel.modalTitle).replace('{tab}', DE.settingsPanel.tabLibrary));
  });

  it('no source at all: "Add a source folder", as before', () => {
    _setBundlesForTests('en', EN, EN);
    expect(libraryWith([]).text()).toBe(EN.library.noSourcesEmpty);
  });

  it('the empty library follows a language change (test day 2026-11-24, B007: first launch, German chosen, the empty state stayed English)', async () => {
    const { eventBus } = await import('../../renderer/js/event-bus.js');
    _setBundlesForTests('en', EN, EN);
    const view = libraryWith([]);
    expect(view.button()).toBe(EN.library.addSourceFolder);
    _setBundlesForTests('de', DE, EN);
    eventBus.emit('language:changed', { locale: 'de' });
    expect(view.text()).toBe(DE.library.noSourcesEmpty);
    expect(view.button()).toBe(DE.library.addSourceFolder);
    // The button still adds a source after the repaint.
    expect(document.querySelectorAll('.library__empty').length).toBe(1);
  });
});
