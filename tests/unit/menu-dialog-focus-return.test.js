/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library ⋮ and its video options dialog, the REAL
 * NavBar Library menu and the REAL Modal are built in a document and driven
 * by focus and clicks;
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Block C fix-up (2026-11-06, real-app verifier 1; low, also in v0.9.2): a
// dialog opened from a menu item gave the focus to <body> when it closed,
// not back to the menu button. The item that had the focus was removed (or
// hidden) with its menu, and modal.js restores focus only to an opener still
// in the document. Keyboard users lost their place: card kebab > Add to
// Playlist / Assign Category, the nav Library menu > Delete collection, the
// player's variant menu > + Add variation.
//
// Now a menu closed by a choice made inside it hands the focus back to the
// button that opened it (the WAI-ARIA menu-button pattern), so the dialog the
// choice opens returns it there. Asserted: document.activeElement after the
// dialog closes.
//
// 2026-11-18 (video options, stage 2a): a video's ⋮ opens the video options
// dialog instead of the menu. Its New playlist and New category stack on it
// and give the focus back to the button that asked; closing the dialog gives
// it back to the ⋮. The folder ⋮ keeps the small menu, and its outside click
// still leaves the focus where the click put it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { NavBar } from '../../renderer/components/nav-bar.js';
import { Modal } from '../../renderer/components/modal.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
});
afterEach(() => {
  for (const o of overlays()) o.querySelector('.modal-close-btn')?.click();
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('library card ⋮ (the video options dialog)', () => {
  const PATH = 'C:\\Lib\\Zulu Last.mp4';
  function cardWithKebab() {
    const settings = {
      get: () => undefined, set: () => {},
      getPlaylists: () => playlists,
      getPlaylist: (id) => playlists.find((p) => p.id === id) || null,
      addPlaylist: async (name) => { const pl = { id: 'p2', name, videoPaths: [] }; playlists.push(pl); return pl; },
      addVideoToPlaylist: (id, p) => playlists.find((pl) => pl.id === id)?.videoPaths.push(p),
      getCategories: () => [{ id: 'c1', name: 'Kitchen' }],
      getVideoCategories: () => ['c1'],
      addCategory: vi.fn(),
    };
    const playlists = [{ id: 'p1', name: 'Evening', videoPaths: [] }];
    const lib = new Library({ settings });
    const container = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'library__card';
    card.dataset.videoPath = PATH;
    const kebab = document.createElement('button');
    kebab.className = 'library__kebab-btn';
    card.appendChild(kebab);
    container.appendChild(card);
    document.body.appendChild(container);
    lib._container = container;
    const video = { name: 'Zulu Last.mp4', path: PATH, hasFunscript: true, funscriptPath: 'C:\\Lib\\Zulu Last.funscript', variants: [] };
    lib._videos = [video];
    kebab.focus();
    lib._openVideoOptions(video);
    return { lib, kebab, playlists };
  }
  const dialogBody = () => document.querySelector('.modal-body.video-options');
  // Open, and past its first frame (the focus is on the rail): where a user starts.
  const opened = async () => {
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    await vi.waitFor(() => expect(document.activeElement?.classList.contains('video-options__rail-item')).toBe(true));
  };
  const control = (key) => dialogBody().querySelector(`[data-vo-focus="${key}"]`);

  it('New playlist… (stacked on the dialog): closing it puts the focus back on that button', async () => {
    cardWithKebab();
    await opened();
    const btn = control('organise:newPlaylist');
    btn.focus();
    btn.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    await flush();
    expect(document.activeElement).toBe(control('organise:newPlaylist'));
  });

  it('New playlist… with a name: the new playlist is ticked and has the focus', async () => {
    const { playlists } = cardWithKebab();
    await opened();
    control('organise:newPlaylist').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays().at(-1).querySelector('input').value = 'Night';
    overlays().at(-1).querySelector('.modal-btn--primary').click();
    await vi.waitFor(() => expect(document.activeElement).toBe(control('playlist:p2')));
    expect(playlists[1].videoPaths).toEqual([PATH]);
  });

  it('closing the dialog puts the focus back on the ⋮', async () => {
    const { kebab } = cardWithKebab();
    await opened();
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await flush();
    expect(overlays()).toHaveLength(0);
    await vi.waitFor(() => expect(document.activeElement).toBe(kebab));
  });

  it('the folder ⋮ menu: a click elsewhere that closes it leaves the focus where the click put it', () => {
    const lib = new Library({ settings: { get: () => undefined, set: () => {} } });
    const card = document.createElement('div');
    const kebab = document.createElement('button');
    card.appendChild(kebab);
    document.body.appendChild(card);
    kebab.focus();
    lib._showFolderKebabMenu({ path: 'C:\\Lib', name: 'Lib' }, kebab, card);
    expect(document.querySelector('.library__kebab-menu')).toBeTruthy();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    lib._closeMenu();
    expect(document.querySelector('.library__kebab-menu')).toBeNull();
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(kebab);
  });
});

describe('nav bar Library menu', () => {
  it('Delete collection: Cancel puts the focus back on the menu arrow', async () => {
    const bar = new NavBar({
      onNavigate: () => {},
      onDeleteCollection: () => Modal.confirm(t('toast.deleteCollectionTitle'), 'x', { confirmText: t('common.delete') }),
    });
    bar.init(document.getElementById('app'));
    bar.setCollections([{ id: 'col1', name: 'Test Coll', videoPaths: [] }], null, [], new Set(), new Set());
    const arrow = document.querySelector('.nav-bar__library-arrow');
    arrow.focus();
    arrow.click();
    const del = document.querySelector('.nav-bar__library-action--danger');
    expect(del).toBeTruthy();
    del.focus();
    del.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    overlays()[0].querySelector('.modal-btn--secondary').click();
    await flush();
    expect(overlays()).toHaveLength(0);
    expect(document.activeElement).toBe(arrow);
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('player variant menu', () => {
  it('+ Add variation: closing the dialog puts the focus back on the variant button', async () => {
    document.body.innerHTML = '<button id="variant-btn"></button><div id="variant-dropdown" hidden></div>';
    const Lifted = liftAppClass(['_showVariantDropdown', '_variantLabelText'], { document, t, showToast: () => {} });
    const app = Object.assign(new Lifted(), {
      _allVariantsWithManual: [{ label: 'Default' }, { label: 'soft' }],
      _activeVariantIndex: 0,
      _currentVideoPath: 'C:\\Lib\\Variant Clip.mp4',
      settings: { get: () => ({}) },
      _getPreferredVariantLabel: () => null,
      _switchVariant: vi.fn(),
      _showAddVariantModal: () => Modal.open({ title: t('variants.addVariation') }),
    });
    const variantBtn = document.getElementById('variant-btn');
    variantBtn.focus();
    app._showVariantDropdown();
    const add = document.querySelector('.variant-selector__add');
    add.focus();
    add.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    overlays()[0].querySelector('.modal-close-btn').click();
    await flush();
    expect(document.getElementById('variant-dropdown').hidden).toBe(true);
    expect(document.activeElement).toBe(variantBtn);
    document.removeEventListener('click', app._variantDropdownClose, true);
  });
});
