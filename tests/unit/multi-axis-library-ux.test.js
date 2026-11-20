/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library renders cards, the REAL SettingsPanel
 * builds its Playback tab and confirm dialog, the REAL QueuePanel renders
 * rows (notes/CLAUDE.md "Test environments").
 */
// Turning on the multi-axis default, end to end, as the user sees it
// (app test V38, V39, V41).
//
//   V39  The confirm said "No videos in your library currently have detected
//        companion files" whenever nothing was left to assign, including in
//        a library whose companion videos were all assigned already.
//   V38  Confirming assigned the videos and persisted it, but no card showed
//        the multi badge: Settings is a modal over the library and closing
//        it re-renders nothing.
//   V41  An auto-promoted video wore the blue "Funscript (manual)" badge, on
//        the card, in list view, in the queue, and again after a relaunch,
//        although the user had picked nothing.
//
// The callbacks app.js hands the Settings panel are lifted from its source
// and run against the REAL Library, so the whole road from the select's
// `change` to the card is real. What is asserted is the dialog text and the
// badges on screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { APP_SRC } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { QueuePanel } from '../../renderer/components/queue-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const DIR = 'C:\\Lib';
const COMPANION = `${DIR}\\Companion Clip.mp4`;
const COMPANION_FS = `${DIR}\\Companion Clip.funscript`;
const PLAIN = `${DIR}\\Plain Clip.mp4`;
const PLAIN_FS = `${DIR}\\Plain Clip.funscript`;
const AXES = ['twist', 'roll', 'pitch'].map((s) => `${DIR}\\Companion Clip.${s}.funscript`);

/** The body of an object-literal arrow callback in app.js, e.g. `name: (mode) => {…}`. */
function liftCallback(name, params) {
  const at = APP_SRC.indexOf(`${name}: (${params}) => {`);
  expect(at, `${name} not found in app.js`).toBeGreaterThan(-1);
  const open = APP_SRC.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}' && --depth === 0) {
      // eslint-disable-next-line no-new-func
      return new Function('showToast', 't', `return function (${params}) {${APP_SRC.slice(open + 1, i)}};`);
    }
  }
  throw new Error('unbalanced braces');
}

const onPreferMultiAxisChanged = liftCallback('onPreferMultiAxisChanged', 'mode');
const getMultiAxisEligibleCount = liftCallback('getMultiAxisEligibleCount', '');

let store;
let settings;
let lib;
let libContainer;
const toasts = [];

function makeSettings() {
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getVideoCategories: () => [],
    getCategories: () => [],
  };
}

/** The real scan result for the sandbox's two clips. */
function scanResult({ withCompanions = true } = {}) {
  const scripts = [COMPANION_FS, PLAIN_FS, ...(withCompanions ? AXES : [])];
  return {
    videos: [
      { name: 'Companion Clip.mp4', path: COMPANION, hasFunscript: true, funscriptPath: COMPANION_FS, variants: [] },
      { name: 'Plain Clip.mp4', path: PLAIN, hasFunscript: true, funscriptPath: PLAIN_FS, variants: [] },
    ],
    allFunscripts: scripts.map((p) => ({ name: p.split('\\').pop(), path: p })),
    unmatchedFunscripts: [],
    failedPaths: [],
    skippedPaths: [],
  };
}

/** Boot the library the way app start does: scan, overlay associations, render. */
async function bootLibrary(opts) {
  window.funsync.scanDirectory = vi.fn(async () => scanResult(opts));
  lib = new Library({ settings });
  lib._lazyLoadVisibleThumbnails = () => {};
  lib._drainPendingThumbnailsOnScrollEnd = () => {};
  lib._registerWithBackend = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  libContainer = document.createElement('div');
  libContainer.innerHTML = '<div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(libContainer);
  lib._container = libContainer;
  const wrapper = libContainer.querySelector('.library__grid-wrapper');
  Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });
  await lib.ensureScanned({ forceRescan: true });
  lib._applyFilters();
}

/** The app.js side of the wiring: `this.library` and toasts. */
function appCallbacks() {
  const app = { library: lib };
  const show = (msg) => toasts.push(msg);
  return {
    onPreferMultiAxisChanged: onPreferMultiAxisChanged(show, t).bind(app),
    getMultiAxisEligibleCount: getMultiAxisEligibleCount(show, t).bind(app),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Pick Multi in Settings ▸ Playback and return the confirm dialog's text. */
async function chooseMulti() {
  const panel = new SettingsPanel({ settings: makeSettingsPanelStore(), ...appCallbacks() });
  const tab = panel._buildPlaybackTab();
  document.body.appendChild(tab);
  await flush(); // the tab wires its controls after mount
  const select = tab.querySelector('#sp-prefer-multi');
  select.value = 'multi';
  select.dispatchEvent(new Event('change'));
  for (let i = 0; i < 5 && !document.querySelector('.modal-overlay'); i++) await flush();
  const body = [...document.querySelectorAll('.modal-overlay .modal-message')].map((n) => n.textContent);
  return {
    body,
    async confirm() {
      [...document.querySelectorAll('.modal-overlay .modal-btn')]
        .find((b) => !b.classList.contains('modal-btn--secondary')).click();
      for (let i = 0; i < 5; i++) await flush();
    },
  };
}

/** Settings writes go to the same store the library reads. */
function makeSettingsPanelStore() {
  return { ...settings, getAll: () => store };
}

function cardFor(path) {
  return [...libContainer.querySelectorAll('.library__card')].find((el) => el.dataset.videoPath === path) || null;
}

function fsBadge(path) {
  return cardFor(path).querySelector('.library__funscript-badge');
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
  toasts.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(0), 0));
  store = {
    'library.viewMode': 'grid',
    'library.sources': [{ id: 's1', name: 'Lib', path: DIR, enabled: true }],
    'library.associations': {},
    'player.preferMultiAxis': 'single',
  };
  settings = makeSettings();
  window.funsync = {
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (list) => list.map(() => true)),
    setSetting: () => {},
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('V39: the confirm tells "no companions" from "all already assigned"', () => {
  it('companions exist but every one is assigned: says so, not "no companion files"', async () => {
    store['library.associations'] = {
      [COMPANION]: { active: 'single', single: COMPANION_FS, multi: null, custom: null },
    };
    await bootLibrary();
    const { body } = await chooseMulti();
    expect(body[0]).toBe(EN.settingsPanel.multiAxisConfirm.bodyAllAssigned);
    expect(body[0]).not.toBe(EN.settingsPanel.multiAxisConfirm.bodyNone);
  });

  it('no companion files anywhere: the "none" line is still the one shown', async () => {
    await bootLibrary({ withCompanions: false });
    const { body } = await chooseMulti();
    expect(body[0]).toBe(EN.settingsPanel.multiAxisConfirm.bodyNone);
  });

  it('one unassigned companion video: counts it', async () => {
    await bootLibrary();
    const { body } = await chooseMulti();
    expect(body[0]).toBe(t('settingsPanel.multiAxisConfirm.bodyCount', { count: 1 }));
  });
});

describe('V38: confirming Multi badges the promoted cards at once', () => {
  it('the Companion card shows the multi badge without any other re-render', async () => {
    await bootLibrary();
    expect(cardFor(COMPANION).querySelector('.library__multi-badge')).toBeNull();

    const dialog = await chooseMulti();
    await dialog.confirm();

    expect(toasts).toEqual([t('toast.autoPromotedMulti', { count: 1 })]);
    const badge = cardFor(COMPANION).querySelector('.library__multi-badge');
    expect(badge).toBeTruthy();
    expect(badge.title).toBe(t('library.multiAxisCount', { count: 4 }));
    expect(cardFor(PLAIN).querySelector('.library__multi-badge')).toBeNull();
  });
});

describe('V41: an auto-promoted video keeps the auto funscript badge', () => {
  it('right after promotion, on the card', async () => {
    await bootLibrary();
    const dialog = await chooseMulti();
    await dialog.confirm();

    expect(fsBadge(COMPANION).classList.contains('library__funscript-badge--auto')).toBe(true);
    expect(fsBadge(COMPANION).title).toBe(t('library.funscriptAuto'));
  });

  it('after a relaunch (the association comes back from config), in grid, list and the queue', async () => {
    store['player.preferMultiAxis'] = 'multi';
    await bootLibrary(); // promotes on scan and persists
    expect(store['library.associations'][COMPANION].active).toBe('multi');

    document.body.innerHTML = '';
    await bootLibrary(); // the relaunch: same config, fresh scan

    expect(fsBadge(COMPANION).classList.contains('library__funscript-badge--auto')).toBe(true);

    lib._viewMode = 'list';
    lib._applyFilters();
    const row = [...libContainer.querySelectorAll('[data-video-path]')].find((el) => el.dataset.videoPath === COMPANION);
    expect(row.querySelector('.library__funscript-badge--inline').classList.contains('library__funscript-badge--auto')).toBe(true);

    const qEl = document.createElement('div');
    document.body.appendChild(qEl);
    const queue = new QueuePanel({ element: qEl, library: lib, settings });
    queue.open();
    queue.setState({ nowPlaying: COMPANION, hasContext: true });
    expect(qEl.querySelector('[data-queue-badge="fs"]').classList.contains('queue-panel__badge--fs-auto')).toBe(true);
  });

  // Was "Remove funscript stays available for it". Dave, 2026-11-17 (video
  // options, answer 1): Unpair is for a script you added by hand as the main
  // one, and an auto-promoted set is FunSync's pairing by name (V41). So the
  // ⋮'s options dialog says how it was paired and how to undo that, and
  // keeps Change… (where the user takes it over), with no Unpair.
  it('its options say FunSync paired it by name with its axis files, and offer Change…, not Unpair', async () => {
    store['player.preferMultiAxis'] = 'multi';
    await bootLibrary();
    cardFor(COMPANION).querySelector('.library__kebab-btn').click();
    let body;
    await vi.waitFor(() => { body = document.querySelector('.modal-body.video-options'); expect(body).toBeTruthy(); });
    body.querySelector('.video-options__rail-item[data-section="script"]').click();
    const script = body.querySelector('.video-options__panel[data-section="script"]');
    expect(script.textContent).toContain(t('videoOptions.script.pairing.autoMulti'));
    expect(script.textContent).toContain(t('videoOptions.script.unpair.autoMulti'));
    expect(script.querySelector('[data-vo-focus="script:unpair"]')).toBeNull();
    expect(script.querySelector('[data-vo-focus="script:change"]')).toBeTruthy();
    document.querySelector('.modal-overlay .modal-close-btn').click();
    await flush();
  });

  it('a multi-axis setup the user saves in the association dialog is manual', async () => {
    store['player.preferMultiAxis'] = 'multi';
    await bootLibrary();
    const video = lib._videosByPath.get(COMPANION);
    lib._applyMultiAxisAssociation(video, cardFor(COMPANION), {
      main: COMPANION_FS, axes: { twist: AXES[0] }, buttplugVib: false,
    });
    expect(fsBadge(COMPANION).classList.contains('library__funscript-badge--manual')).toBe(true);

    document.body.innerHTML = '';
    await bootLibrary(); // and it stays manual across a relaunch
    expect(fsBadge(COMPANION).classList.contains('library__funscript-badge--manual')).toBe(true);
  });
});
