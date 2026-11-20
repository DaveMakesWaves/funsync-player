/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Modal draws the collection dialog in the
 * document (notes/CLAUDE.md "Test environments").
 */
// R3 fix-up (real-app verifier 2, 2026-11-06), the New / Edit Collection
// dialog:
//   - its title was hard-coded English ("Create Collection", "Edit — <name>")
//     in every language (also in v0.9.2);
//   - its grid listed the videos in the scan's order, which put
//     "Alpha Scene (copy)" before "Alpha Scene", while the library grid and
//     the phone now put the shorter name first (R3-28's Name A-Z).
// The REAL app.js methods (lifted) run with the REAL Modal and i18n; what is
// asserted is the title and the order of the cards the user sees. (The Edit
// title, collectionModal.titleEdit, goes through _renameCollection, which
// imports modules dynamically and cannot be lifted.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

const { Modal } = await import('../../renderer/components/modal.js');
const { t, _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { compareVideoNames } = await import('../../renderer/js/library-search.js');

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

const DIR = 'C:\\sandbox\\library\\';
const v = (file) => ({ name: file, path: DIR + file });
// The scan's order: with the extension, "Alpha Scene (copy).mp4" sorts first.
const SCANNED = [v('Alpha Scene (copy).mp4'), v('Alpha Scene.mp4'), v('Bravo Duplicate - renamed.mp4'), v('Bravo Duplicate.mp4')];

function build() {
  const Lifted = liftAppClass(['_showCollectionModal', '_showNewCollectionModal'], {
    Modal, t, compareVideoNames, document, window, console, crypto,
  });
  const settings = new Map([['library.sources', [{ path: 'C:\\sandbox\\library', enabled: true }]], ['library.collections', [{ id: 'c1', name: 'Favs', videoPaths: [] }]]]);
  return Object.assign(new Lifted(), {
    settings: { get: (k) => settings.get(k), set: (k, val) => settings.set(k, val) },
    library: { _unavailablePaths: new Set(), _folderIndex: null, show() {} },
    _refreshCollectionsUI: async () => {},
    _getViewEl: () => null,
  });
}

const dialog = () => document.querySelector('.modal-overlay');
const cards = () => [...document.querySelectorAll('.library__collection-card-title')].map((el) => el.textContent);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  document.body.innerHTML = '';
  window.funsync = { scanDirectory: async () => ({ videos: SCANNED.map((x) => ({ ...x })) }) };
});

afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((d) => d.remove());
  delete window.funsync;
  _setBundlesForTests('en', EN, EN);
});

describe('the collection dialog speaks the user\'s language and sorts like the library (R3 fix-up)', () => {
  it('German: "Sammlung erstellen", not "Create Collection"', async () => {
    _setBundlesForTests('de', DE, EN);
    const app = build();
    app._showNewCollectionModal();
    await settle();
    expect(dialog().querySelector('.modal-title').textContent).toBe(DE.collectionModal.titleCreate);
    expect(dialog().querySelector('.modal-title').textContent).not.toBe('Create Collection');
  });

  it('English reads as before', async () => {
    _setBundlesForTests('en', EN, EN);
    const app = build();
    app._showNewCollectionModal();
    await settle();
    expect(dialog().querySelector('.modal-title').textContent).toBe('Create Collection');
  });

  it('the shorter name first, as the library grid and the phone list them', async () => {
    _setBundlesForTests('en', EN, EN);
    const app = build();
    app._showNewCollectionModal();
    await settle();
    expect(cards()).toEqual(['Alpha Scene', 'Alpha Scene (copy)', 'Bravo Duplicate', 'Bravo Duplicate - renamed']);
  });
});
