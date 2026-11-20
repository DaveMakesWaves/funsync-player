/**
 * @vitest-environment jsdom
 * jsdom on purpose: every dialog here is the REAL Modal, opened by the REAL
 * caller (Devices panel, Settings, Library, Categories, Playlists, session
 * history, a method lifted from app.js) into a document, and i18n.js and
 * settings-panel.js branch on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// Every confirm dialog names the action it asks about (app test V74,
// EroScripts #359 a88a88), and the Safety Cap warning is true for every
// device that shows it (V76).
//
// Modal.confirm() defaulted its action button to "Delete", and most callers
// that were not deletions never passed a label. Raising the Safety Cap above
// 90% asked "Cancel / Delete"; so did Restore From Backup, removing a source
// (which deletes no files, as its own message says), both overlapping-source
// questions and even the "All Assigned" notice. The default is now a neutral
// "Confirm" and every caller passes its own verb, deletions included.
//
// The Safety Cap and Ramp-up controls show for any device with an oscillate
// motor (a Svakom Jordan vibrator, a Hismith) as well as e-stim, but the
// warning said "Setting e-stim intensity to 95%".
//
// These open each dialog through the code a click runs and read the button
// and the message the user sees.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Modal } from '../../renderer/components/modal.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import { Library } from '../../renderer/components/library.js';
import { Categories } from '../../renderer/components/categories.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { openSessionHistory } from '../../renderer/components/session-history-modal.js';
import { openVideoOptionsDialog } from '../../renderer/components/video-options-dialog.js';
import { DataService } from '../../renderer/js/data-service.js';
import { liftAppClass } from './helpers/app-methods.js';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const B = Object.fromEntries(LOCALES.map((l) => [l, bundle(l)]));
const EN = B.en;
const useLocale = (l) => _setBundlesForTests(l, B[l], EN);

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const top = () => overlays().at(-1);
/**
 * Wait for the dialog count to reach `n`. Callers open it after an await; the
 * Devices panel's after a dynamic import('./modal.js'), which takes a while
 * under vitest.
 */
async function dialogs(n) {
  const until = Date.now() + 3000;
  while (overlays().length < n && Date.now() < until) await flush();
  expect(overlays().length).toBe(n);
  return top();
}
const actionText = () => top().querySelector('.modal-actions .modal-btn--danger').textContent;
const messageText = () => top().querySelector('.modal-message').textContent;
const cancelTop = async () => { top().querySelector('.modal-actions .modal-btn--secondary').click(); await flush(); };

let closeSettings = null;
beforeEach(() => {
  useLocale('en');
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});
afterEach(async () => {
  while (overlays().length > 0) {
    const close = top().querySelector('.modal-close-btn');
    close.click();
    await flush();
  }
  if (closeSettings) await closeSettings;
  closeSettings = null;
});
afterAll(() => useLocale('en'));

const settingsFake = (entries = []) => {
  const values = new Map([['player.language', 'en'], ...entries]);
  return { values, get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) };
};

// --- The Devices panel's Safety Cap (#359) -------------------------------

/** The Devices panel with one Buttplug device, through the real device-added callback. */
function devicesPanelWith(dev) {
  const buttplug = {
    connected: true, devices: [dev],
    sendLinear() {}, sendVibrate() {}, sendRotate() {}, sendScalar() {}, sendOscillate() {},
    stopAll() {}, stopDevice() {},
  };
  const buttplugSync = new ButtplugSync({
    videoPlayer: { video: { addEventListener() {}, removeEventListener() {} }, currentTime: 0, paused: true, duration: 60 },
    buttplugManager: buttplug,
    funscriptEngine: { isLoaded: false, getActions: () => [] },
  });
  const panel = new ConnectionPanel({
    handyManager: { on() {}, off() {} }, buttplugManager: buttplug, buttplugSync, settings: settingsFake(),
  });
  buttplug.onDeviceAdded(dev);
  return { panel, buttplugSync };
}

/** Drag the device's Safety Cap slider to `v` and let go. */
function setSafetyCap(panel, v) {
  const slider = panel._panel.querySelector('.connection-panel__device-safety-section input[type="range"]');
  expect(slider).toBeTruthy();
  slider.value = String(v);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  return slider;
}

const JORDAN = { index: 0, name: 'Svakom Jordan', canVibrate: true, canOscillate: true };
const HISMITH = { index: 0, name: 'Hismith Pro', canOscillate: true };
const ESTIM = { index: 0, name: 'DG-LAB ESTIM', canScalar: true };

// What the warning said in v0.9.2, in every locale: e-stim only.
const OLD_SAFETY_BODY = {
  en: 'Setting e-stim intensity to {percent}% — high levels can cause discomfort. Continue?',
  de: 'E-Stim-Intensität auf {percent}% setzen — hohe Werte können Unbehagen verursachen. Fortfahren?',
  es: 'Estableciendo la intensidad de e-stim al {percent}% — los niveles altos pueden causar incomodidad. ¿Continuar?',
  fr: "Réglage de l'intensité e-stim à {percent}% — les niveaux élevés peuvent causer de l'inconfort. Continuer ?",
  ja: '電気刺激の強度を {percent}% に設定 — 高レベルは不快感を引き起こす可能性があります。続けますか?',
  ko: '전기 자극 강도를 {percent}%로 설정 — 높은 수준은 불편함을 유발할 수 있습니다. 계속하시겠습니까?',
  ru: 'Установка интенсивности e-stim на {percent}% — высокие уровни могут вызвать дискомфорт. Продолжить?',
  zh: '将电刺激强度设为 {percent}% — 高强度可能引起不适。是否继续?',
};

describe('the Safety Cap warning (V74, V76)', () => {
  for (const locale of LOCALES) {
    it(`asks to set the cap, not to delete, in ${locale}`, async () => {
      useLocale(locale);
      const { panel, buttplugSync } = devicesPanelWith(JORDAN);
      setSafetyCap(panel, 95);
      await dialogs(1);

      expect(actionText()).toBe(t('connection.buttplug.highIntensityConfirm', { percent: 95 }));
      expect(actionText()).not.toBe(B[locale].common.delete);
      expect(actionText()).toContain('95');
      // The message is the reworded one, with the value in it, and no longer
      // the e-stim-only sentence a vibrator owner was shown.
      expect(messageText()).toBe(t('connection.buttplug.highIntensityBody', { percent: 95 }));
      expect(messageText()).not.toBe(OLD_SAFETY_BODY[locale].replace('{percent}', '95'));
      expect(messageText()).toContain('95');

      await cancelTop();
      expect(buttplugSync.getMaxIntensity(0)).toBe(70);
    });
  }

  it('the English text is about "the device", true for a vibrator, a machine and e-stim alike', async () => {
    for (const dev of [JORDAN, HISMITH, ESTIM]) {
      document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
      const { panel, buttplugSync } = devicesPanelWith(dev);
      setSafetyCap(panel, 100);
      await dialogs(1);
      expect(messageText()).toMatch(/^This lets the device run at up to 100% intensity\./);
      expect(messageText()).not.toMatch(/^Setting e-stim intensity/);
      expect(actionText()).toBe('Set to 100%');
      top().querySelector('.modal-btn--danger').click();
      await flush();
      expect(buttplugSync.getMaxIntensity(0)).toBe(100);
    }
  });
});

// --- Settings ---------------------------------------------------------------

/** Open the real Settings modal on an area, as a click on the rail does. */
async function openSettings(settings, area) {
  closeSettings = new SettingsPanel({ settings }).show();
  document.querySelector(`.settings-panel__rail-item[data-area="${area}"]`).click();
  await flush();
}
const SOURCES = [
  { id: 's1', name: 'Movies', path: 'C:/Videos/Movies', enabled: true },
  { id: 's2', name: 'Clips', path: 'C:/Videos/Clips', enabled: true },
];
const addSourceButton = () => [...document.querySelectorAll('.settings-panel__add-btn')]
  .find((b) => b.textContent === t('settingsPanel.sources.add'));

describe('Settings dialogs that are not deletions (V74)', () => {
  it('removing a source says Remove: its files stay on disk', async () => {
    const settings = settingsFake([['library.sources', SOURCES]]);
    await openSettings(settings, 'sources');
    document.querySelector('.settings-panel__source-btn--danger').click();
    await dialogs(2);
    expect(actionText()).toBe(EN.common.remove);
    expect(messageText()).toBe(t('settingsPanel.sources.removeConfirm', { name: 'Movies' }));
    await cancelTop();
    expect(settings.values.get('library.sources')).toHaveLength(2);
  });

  it('Stash (settings-stash.js): Remove Stash data… and removing the API key say Remove', async () => {
    let removed = 0;
    Object.assign(window.funsync, {
      stashStatus: async () => ({
        ok: true, settings: { enabled: true, url: 'http://127.0.0.1:9999' },
        key: { hasKey: true, keyStorage: 'safeStorage', saveStorage: 'safeStorage' }, library: {}, sync: { running: false },
      }),
      stashGetData: async () => ({ links: { 'C:/a.mp4': { sceneId: '1' } } }),
      stashRemoveData: async () => { removed++; return { ok: true, undoId: 'u', undoMs: 8000 }; },
      stashRemoveKey: async () => { removed++; return { ok: true }; },
    });
    await openSettings(settingsFake([['stash.url', 'http://127.0.0.1:9999'], ['stash.enabled', true]]), 'sources');
    await flush();
    document.querySelector('[data-stash-focus="remove"]').click();
    await dialogs(2);
    expect(actionText()).toBe(EN.common.remove);
    expect(messageText()).toBe(t('settingsPanel.stash.removeConfirm', { count: 1 }));
    await cancelTop();
    document.querySelector('[data-stash-focus="key-remove"]').click();
    await dialogs(2);
    expect(actionText()).toBe(EN.common.remove);
    expect(messageText()).toBe(t('settingsPanel.stash.removeKeyBody'));
    await cancelTop();
    expect(removed).toBe(0);
  });

  it('adding a folder inside a source asks to "Add anyway"', async () => {
    window.funsync.selectDirectory = async () => 'C:/Videos/Movies/Extras';
    await openSettings(settingsFake([['library.sources', SOURCES]]), 'sources');
    addSourceButton().click();
    await dialogs(2);
    expect(actionText()).toBe('Add anyway');
  });

  it('adding a folder that holds sources asks to "Remove and add", in words from the locale', async () => {
    window.funsync.selectDirectory = async () => 'C:/Videos';
    await openSettings(settingsFake([['library.sources', SOURCES]]), 'sources');
    addSourceButton().click();
    await dialogs(2);
    expect(actionText()).toBe('Remove and add');
    expect(messageText()).toBe(
      '"C:/Videos" contains 2 sources you already added: "Movies", "Clips". Their files would be scanned twice.\n\n'
      + 'Remove those sources and add this folder instead?',
    );
  });

  it('the same question in German, one source and two (it used to be hard-coded English)', async () => {
    useLocale('de');
    for (const [sources, count] of [[SOURCES.slice(0, 1), 1], [SOURCES, 2]]) {
      window.funsync.selectDirectory = async () => 'C:/Videos';
      await openSettings(settingsFake([['library.sources', sources]]), 'sources');
      addSourceButton().click();
      await dialogs(2);
      expect(actionText()).toBe(B.de.settingsPanel.sources.parentOverlapConfirm);
      expect(messageText()).toBe(t('settingsPanel.sources.parentOverlapBody', {
        path: 'C:/Videos', count, names: sources.map((s) => `"${s.name}"`).join(', '),
      }));
      expect(messageText()).toContain(count === 1 ? 'eine Quelle' : '2 Quellen');
      expect(messageText()).not.toMatch(/existing source|nested source/);
      while (overlays().length > 0) { top().querySelector('.modal-close-btn').click(); await flush(); }
      await closeSettings;
    }
  });

  it('Restore From Backup asks to Restore', async () => {
    const snapshots = [{
      subdir: 'snapshots', filename: 'a.json', timestamp: Date.now(), trigger: 'manual', sizeBytes: 2048, summary: { playlists: 1 },
    }];
    let restored = null;
    window.funsync.backupList = async () => ({ success: true, snapshots });
    window.funsync.backupRestore = async (subdir, filename) => { restored = `${subdir}/${filename}`; return { success: true }; };
    await openSettings(settingsFake(), 'data');
    await flush();
    document.querySelector('#sp-backup-restore').click();
    await dialogs(2);
    top().querySelector('.modal-list-item').click();
    await dialogs(2); // the picker closed, the confirm opened
    expect(actionText()).toBe('Restore');
    top().querySelector('.modal-btn--danger').click();
    await flush();
    expect(restored).toBe('snapshots/a.json');
  });

  it('Import Backup File keeps its own label', async () => {
    window.funsync.importData = async () => ({ success: false, canceled: true });
    await openSettings(settingsFake(), 'data');
    await flush();
    document.querySelector('#sp-import').click();
    await dialogs(2);
    expect(actionText()).toBe(EN.settingsPanel.data.import);
  });
});

// --- The rest -----------------------------------------------------------------

describe('the other non-deletions (V74)', () => {
  // Block C fix-up (2026-11-06, real-app verifier 1): it was a Modal.confirm,
  // so the notice showed Cancel next to a red, danger-style OK. A notice asks
  // nothing: one OK in the primary style (Modal.alert), in every locale.
  it.each(LOCALES)('the "All Assigned" notice is one plain OK, no Cancel and nothing red, in %s', async (locale) => {
    useLocale(locale);
    const lib = {
      _settings: { getCategories: () => [{ id: 'c1', name: 'Fav' }], getVideoCategories: () => ['c1'] },
    };
    const done = Library.prototype._assignCategory.call(lib, 'C:/Videos/a.mp4', null);
    await dialogs(1);
    expect(top().querySelector('.modal-title').textContent).toBe(B[locale].library.allAssignedTitle);
    const buttons = [...top().querySelectorAll('.modal-actions .modal-btn')];
    expect(buttons.map((b) => b.textContent)).toEqual([B[locale].common.ok]);
    expect(buttons[0].classList.contains('modal-btn--primary')).toBe(true);
    expect(top().querySelector('.modal-btn--danger')).toBeNull();
    buttons[0].click();
    await done;
    expect(overlays()).toHaveLength(0);
  });

  // Round 2: an EroScripts download that would land on an existing, different
  // script asks first; the action is Replace (the old file goes to the
  // Recycle Bin), never Delete or the bare Confirm.
  it.each(LOCALES)('an EroScripts download over an existing script asks to Replace, in %s', async (locale) => {
    useLocale(locale);
    document.body.insertAdjacentHTML('beforeend', '<div id="player-container"></div>');
    document.getElementById('player-container').dataset.videoPath = 'C:\\sandbox\\Alpha Scene.mp4';
    window.funsync.platform = 'win32';
    const writes = [];
    // A look (`checkOnly`) finds a different file there; a write would be recorded.
    window.funsync.eroscriptsDownload = async (_url, p, opts = {}) => {
      if (opts.checkOnly) return { success: true, checked: true, exists: true };
      writes.push(!!opts.replace);
      return opts.replace ? { success: true } : { success: false, exists: true };
    };
    const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
    const panel = Object.assign(Object.create(EroScriptsPanel.prototype), { _settings: { get: () => [] }, _setLabel() {} });
    const done = panel._downloadAttachment({ name: 'a.funscript', url: 'https://example.invalid/a' }, null, null);
    await dialogs(1);
    expect(top().querySelector('.modal-title').textContent)
      .toBe(B[locale].eroscripts.replaceTitle.replace('{name}', 'Alpha Scene.funscript'));
    // The message names the bin the platform has (R3-06): formatted, not raw.
    expect(messageText()).toBe(t('eroscripts.replaceMessage', { os: 'win' }));
    expect(messageText()).not.toContain('{os');
    expect(actionText()).toBe(B[locale].eroscripts.replaceBtn);
    await cancelTop();
    await done;
    expect(writes).toEqual([]); // Cancel: nothing written at all
  });

  // R3-02: the search inside Associate Funscript asks the same question, once
  // for a whole multi-axis set (shared askReplaceFiles, replace-question.js).
  it.each(LOCALES)('Associate Funscript\'s EroScripts search asks to Replace a scripted set, in %s', async (locale) => {
    useLocale(locale);
    Object.assign(window.funsync, {
      eroscriptsSearch: async () => ({ results: [{ id: 7, title: 'Alpha', tags: [] }] }),
      eroscriptsTopic: async () => ({ attachments: [
        { name: 'alpha.funscript', url: 'https://discuss.eroscripts.com/uploads/a.funscript' },
        { name: 'alpha.roll.funscript', url: 'https://discuss.eroscripts.com/uploads/a.roll.funscript' },
      ] }),
      eroscriptsTopicImage: async () => null,
      eroscriptsDownload: async (_u, _p, opts = {}) => (opts.checkOnly
        ? { success: true, checked: true, exists: true }
        : { success: false, error: 'a write after Cancel' }),
    });
    const { showEroScriptsSearchModal } = await import('../../renderer/components/eroscripts-inline-search.js');
    const picked = showEroScriptsSearchModal({ path: 'C:\\sandbox\\Alpha Scene.mp4', name: 'Alpha Scene.mp4' });
    await dialogs(1);
    let head;
    await vi.waitFor(() => { head = top().querySelector('.eroscripts-inline__result-head'); expect(head).toBeTruthy(); });
    head.click();
    let all;
    await vi.waitFor(() => { all = top().querySelector('.eroscripts-inline__group-actions .eroscripts-panel__btn'); expect(all).toBeTruthy(); });
    all.click();
    await dialogs(2);
    expect(actionText()).toBe(B[locale].eroscripts.replaceBtn);
    await cancelTop();
    expect(overlays()).toHaveLength(1); // back in the search, nothing closed it
    overlays()[0].querySelector('.modal-close-btn').click();
    await picked;
  });

  // FT-104 (block E2 review): a playlist's Select-mode Remove of two or more
  // videos asks first. It takes playlist entries out, never a file, so the
  // action is Remove and the message says the files are not touched. (In ja
  // the existing common.remove and common.delete are both 削除; the message
  // carries the difference there.)
  it.each(LOCALES)('a playlist\'s Remove of several selected videos asks to Remove, naming how many and the playlist, in %s', async (locale) => {
    useLocale(locale);
    const A = 'C:/V/a.mp4';
    const Bv = 'C:/V/b.mp4';
    const C = 'C:/V/c.mp4';
    const removed = [];
    const pl = { id: 'p1', name: 'Mix', videoPaths: [A, Bv, C] };
    const pls = Object.assign(Object.create(Playlists.prototype), {
      _settings: { getPlaylist: () => pl, removeVideosFromPlaylist: (_id, paths) => removed.push(...paths) },
      _detailPlaylistId: 'p1',
      _selectMode: true,
      _selectedPaths: new Set([A, C]),
    });
    const done = pls._removeSelected();
    await dialogs(1);
    expect(top().querySelector('.modal-title').textContent).toBe(B[locale].playlists.removeFromPlaylist);
    expect(actionText()).toBe(B[locale].common.remove);
    expect(messageText()).toBe(t('playlists.confirmRemoveSelection', { count: 2, name: 'Mix' }));
    expect(messageText()).toContain('Mix');
    expect(messageText()).not.toMatch(/[{}]/);
    await cancelTop();
    await done;
    expect(removed).toEqual([]); // Cancel: nothing taken out
  });

  // Video options (2026-11-18, stage 2a): Unpair funscript and Unpair
  // subtitle ask first, stacked on the dialog. Neither deletes a file (the
  // message says it stays on disk), so the action is Unpair, never Delete
  // or the bare Confirm, and Cancel writes nothing.
  it.each(LOCALES)('Unpair funscript and Unpair subtitle in the video options ask to Unpair, in %s', async (locale) => {
    useLocale(locale);
    const VIDEO = 'C:\\sandbox\\Square Clip.mp4';
    const ZULU = 'C:\\sandbox\\Zulu Last.funscript';
    const SUB = 'C:\\sandbox\\Square Clip.srt';
    const ds = new DataService();
    ds._cache.settings.library = {
      associations: { [VIDEO]: { active: 'single', single: ZULU, multi: null, custom: null } },
      subtitleAssociations: { [VIDEO]: SUB },
    };
    ds._initialized = true;
    const video = {
      name: 'Square Clip.mp4', path: VIDEO, hasFunscript: true, funscriptPath: ZULU, _manualAssociation: true,
      _ownScriptKnown: true, _ownFunscriptPath: null, hasSubtitle: true, subtitlePath: SUB, _manualSubtitle: true, variants: [],
    };
    const before = JSON.stringify(ds.get('library'));
    const done = openVideoOptionsDialog({ settings: ds, getVideo: () => video }, video, { section: 'script' });
    await dialogs(1);
    for (const [section, key, name] of [['script', 'script:unpair', 'Zulu Last.funscript'], ['subtitles', 'subtitles:unpair', 'Square Clip.srt']]) {
      overlays()[0].querySelector(`.video-options__rail-item[data-section="${section}"]`).click();
      overlays()[0].querySelector(`[data-vo-focus="${key}"]`).click();
      await dialogs(2);
      expect(actionText()).toBe(t('videoOptions.script.unpair.confirmButton'));
      expect(actionText()).not.toBe(B[locale].common.delete);
      expect(actionText()).not.toBe(B[locale].common.confirm);
      expect(messageText()).toContain(t('videoOptions.script.unpair.confirmQuestion', { name }));
      expect(messageText()).not.toMatch(/\{(name|count)/);
      await cancelTop();
      expect(overlays()).toHaveLength(1);
    }
    expect(JSON.stringify(ds.get('library'))).toBe(before); // Cancel: nothing unpaired
    overlays()[0].querySelector('.modal-close-btn').click();
    await done;
  });

  it('a bare Modal.confirm() falls back to "Confirm", never "Delete"', async () => {
    const answer = Modal.confirm('Title', 'Message');
    expect(actionText()).toBe(EN.common.confirm);
    top().querySelector('.modal-btn--danger').click();
    expect(await answer).toBe(true);
  });
});

describe('deletions still say Delete (V74)', () => {
  it('Delete Category', async () => {
    let deleted = null;
    const cats = { _settings: { deleteCategory: (id) => { deleted = id; } }, _renderGrid() {} };
    const done = Categories.prototype._deleteCategory.call(cats, { id: 'c1', name: 'Fav' });
    await dialogs(1);
    expect(actionText()).toBe(EN.common.delete);
    top().querySelector('.modal-btn--danger').click();
    await done;
    expect(deleted).toBe('c1');
  });

  it('Delete Playlist', async () => {
    let deleted = null;
    const pls = { _settings: { deletePlaylist: (id) => { deleted = id; } }, _renderGrid() {} };
    const done = Playlists.prototype._deletePlaylist.call(pls, { id: 'p1', name: 'Mix' });
    await dialogs(1);
    expect(actionText()).toBe(EN.common.delete);
    top().querySelector('.modal-btn--danger').click();
    await done;
    expect(deleted).toBe('p1');
  });

  // The title said "Delete Library" while the menu and the create dialog say
  // Collection (block C fix-up, 2026-11-06, real-app verifier 1).
  it('every locale names a collection in its Delete title as its Create dialog does', () => {
    const NOUN = { en: 'Collection', de: 'Sammlung', es: 'colección', fr: 'collection', ja: 'コレクション', ko: '컬렉션', ru: 'коллекци', zh: '合集' };
    for (const l of LOCALES) {
      expect(B[l].collectionModal.titleCreate, l).toContain(NOUN[l]);
      expect(B[l].toast.deleteCollectionTitle, l).toContain(NOUN[l]);
    }
  });

  it('Delete Collection (titled so, not "Delete Library"), from app.js', async () => {
    const LiftedApp = liftAppClass(['_deleteCollection'], { Modal, t });
    const app = new LiftedApp();
    const settings = settingsFake([['library.collections', [{ id: 'col1', name: 'Faves', videoPaths: [] }]]]);
    app.settings = settings;
    app._refreshCollectionsUI = async () => {};
    app._switchCollection = async () => {};
    window.funsync.backupPreAction = async () => {};
    const done = app._deleteCollection('col1');
    await dialogs(1);
    expect(top().querySelector('.modal-title').textContent).toBe('Delete Collection');
    expect(actionText()).toBe(EN.common.delete);
    top().querySelector('.modal-btn--danger').click();
    await done;
    expect(settings.values.get('library.collections')).toEqual([]);
  });

  it('Clear session history', async () => {
    let cleared = false;
    const tracker = {
      getHistory: () => [{ source: 'vr', identifier: 'Quest', startedAt: Date.now() - 60000, endedAt: Date.now(), videos: [] }],
      clearHistory: () => { cleared = true; },
    };
    const done = openSessionHistory(tracker);
    await dialogs(1);
    top().querySelector('.session-history__clear').click();
    await dialogs(2);
    expect(actionText()).toBe(EN.common.delete);
    top().querySelector('.modal-btn--danger').click();
    await done;
    expect(cleared).toBe(true);
  });
});

// --- Import / export text (FT-041) ---------------------------------------------
// The import confirm said nothing about playback and every device stopping
// first (applyImport does that), and since FT-008 "its settings replace your
// current ones" was no longer the whole truth: a key or login set here is
// kept. The export blurb left out custom thumbnails, which the backup now
// carries (V59). The old text of every locale, as v0.9.2 + FT-008 had it:
const OLD_IMPORT_BODY = {
  en: "Choose a FunSync backup file next. Its playlists, categories and associations are added to yours, and its settings replace your current ones. Your current state is saved as a snapshot first, so Restore From Backup can undo this. The app will relaunch to load the result.",
  de: "Wähle als Nächstes eine FunSync-Backup-Datei. Ihre Playlists, Kategorien und Zuordnungen werden zu deinen hinzugefügt, ihre Einstellungen ersetzen deine aktuellen. Dein aktueller Stand wird vorher als Snapshot gespeichert, sodass du den Import mit „Aus Backup wiederherstellen“ rückgängig machen kannst. Die App wird neu gestartet, um das Ergebnis zu laden.",
  es: "A continuación elige un archivo de copia de FunSync. Sus listas, categorías y asociaciones se añaden a las tuyas, y su configuración sustituye a la actual. Tu estado actual se guarda antes como instantánea, así que puedes deshacerlo con «Restaurar desde copia». La app se relanzará para cargar el resultado.",
  fr: "Choisis ensuite un fichier de sauvegarde FunSync. Ses listes, catégories et associations s'ajoutent aux tiennes, et ses paramètres remplacent les tiens. Ton état actuel est d'abord enregistré comme instantané, tu peux donc annuler avec « Restaurer depuis une sauvegarde ». L'application redémarrera pour charger le résultat.",
  ja: "次に FunSync のバックアップファイルを選択します。ファイル内のプレイリスト、カテゴリ、関連付けは現在のものに追加され、設定は現在の設定を置き換えます。現在の状態は先にスナップショットとして保存されるため、「バックアップから復元」で元に戻せます。結果を読み込むためにアプリが再起動します。",
  ko: "다음 단계에서 FunSync 백업 파일을 선택하세요. 파일의 재생 목록, 카테고리, 연결은 현재 항목에 추가되고, 설정은 현재 설정을 대체합니다. 현재 상태는 먼저 스냅샷으로 저장되므로 '백업에서 복원'으로 되돌릴 수 있습니다. 결과를 불러오기 위해 앱이 재시작됩니다.",
  ru: "Далее выберите файл резервной копии FunSync. Его плейлисты, категории и связи добавятся к вашим, а его настройки заменят текущие. Текущее состояние сначала сохраняется как снимок, поэтому импорт можно отменить через «Восстановить из резервной копии». Приложение перезапустится, чтобы загрузить результат.",
  zh: "接下来请选择一个 FunSync 备份文件。其中的播放列表、分类和关联会添加到你现有的数据中，其设置会替换你当前的设置。当前状态会先保存为快照，因此可以通过“从备份恢复”撤销此操作。应用将重新启动以加载结果。",
};
const OLD_EXPORT_BLURB = {
  en: "Save your settings, playlists, categories, and associations to a portable file — useful for moving to another machine or for an extra off-host backup.",
  de: "Speichere deine Einstellungen, Playlists, Kategorien und Zuordnungen in einer portablen Datei — nützlich für den Wechsel auf einen anderen Rechner oder als zusätzliches Off-Host-Backup.",
  es: "Guarda tu configuración, listas, categorías y asociaciones en un archivo portable — útil para mover a otra máquina o como respaldo adicional fuera del host.",
  fr: "Enregistre tes paramètres, listes, catégories et associations dans un fichier portable — utile pour passer à une autre machine ou pour une sauvegarde hors-hôte supplémentaire.",
  ja: "設定、プレイリスト、カテゴリ、関連付けをポータブルファイルに保存します — 別のマシンへの移行や追加のオフホストバックアップに便利です。",
  ko: "설정, 재생 목록, 카테고리 및 연결을 휴대용 파일에 저장 — 다른 컴퓨터로 이동하거나 추가 오프호스트 백업에 유용합니다.",
  ru: "Сохраните настройки, плейлисты, категории и связи в портативный файл — полезно для переноса на другую машину или дополнительного резервного копирования вне хоста.",
  zh: "将设置、播放列表、分类与关联保存为可移植文件 — 便于迁移到其他机器或额外的离机备份。",
};

describe('Import and export say what really happens (FT-041)', () => {
  const dataArea = () => document.querySelector('#settings-tabpanel-data');
  const blurbShown = () => [...dataArea().querySelectorAll('.settings-panel__hint')].map((n) => n.textContent)
    .find((s) => s === t('settingsPanel.data.exportBlurb'));

  it.each(LOCALES)('%s: the import confirm and the export blurb are the new text; Cancel opens no file picker', async (l) => {
    useLocale(l);
    let picked = 0;
    window.funsync.importData = async () => { picked++; return { success: false, error: 'Cancelled' }; };
    await openSettings(settingsFake([['player.language', l]]), 'data');
    await flush();
    expect(blurbShown()).toBe(B[l].settingsPanel.data.exportBlurb);
    expect(blurbShown()).not.toBe(OLD_EXPORT_BLURB[l]);

    document.querySelector('#sp-import').click();
    await dialogs(2);
    expect(messageText()).toBe(B[l].settingsPanel.data.importConfirmBody);
    expect(messageText()).not.toBe(OLD_IMPORT_BODY[l]);
    await cancelTop();
    expect(picked).toBe(0);
  });

  it('English names the device stop, the kept keys and logins, the kept playlist and custom thumbnails', async () => {
    window.funsync.importData = async () => ({ success: false, error: 'Cancelled' });
    await openSettings(settingsFake(), 'data');
    await flush();
    expect(blurbShown()).toMatch(/custom thumbnails/);
    document.querySelector('#sp-import').click();
    await dialogs(2);
    expect(messageText()).toContain('Playback and every device stop first.');
    expect(messageText()).toContain('Keys and logins you already have here are kept.');
    expect(messageText()).toContain('a playlist you already have is kept as it is');
  });

  it('what the text claims is what the merge does (the REAL mergeConfig)', () => {
    const { mergeConfig } = createRequire(import.meta.url)('../../electron/data-export.js');
    const here = {
      settings: { handy: { connectionKey: 'LOCALKEY' }, eroscripts: { session: { cookie: 'c-here', username: 'me' } }, player: { volume: 40 } },
      playlists: [{ id: 'p1', name: 'Favorites', videoPaths: ['/v/a.mp4'] }],
      categories: [], videoCategories: {},
    };
    const backup = {
      settings: { handy: { connectionKey: 'OLDKEY' }, eroscripts: { session: null }, player: { volume: 90 } },
      playlists: [{ id: 'p9', name: 'Favorites', videoPaths: ['/v/a.mp4', '/v/b.mp4'] }, { id: 'p2', name: 'New', videoPaths: [] }],
      categories: [], videoCategories: {},
    };
    const merged = mergeConfig(here, backup, 'merge');
    // "a playlist you already have is kept as it is"
    expect(merged.playlists.find((p) => p.name === 'Favorites')).toEqual(here.playlists[0]);
    expect(merged.playlists.map((p) => p.name)).toEqual(['Favorites', 'New']);
    // "its settings replace your current ones" / "Keys and logins you already have here are kept"
    expect(merged.settings.player.volume).toBe(90);
    expect(merged.settings.handy.connectionKey).toBe('LOCALKEY');
    expect(merged.settings.eroscripts.session).toEqual({ cookie: 'c-here', username: 'me' });
  });
});

// A new Modal.confirm() caller must be opened here too, so its label is read
// by a test rather than left to the default. This counts call sites; the
// assertions above are what prove each label.
describe('coverage', () => {
  it('every Modal.confirm() caller in renderer/ is driven by this file', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.js')) files.push(p);
      }
    };
    walk('renderer');
    const callers = {};
    for (const f of files) {
      const n = (fs.readFileSync(f, 'utf8').match(/Modal\.confirm\(/g) || []).length;
      if (n > 0) callers[f] = n;
    }
    expect(callers).toEqual({
      'renderer/components/categories.js': 1,           // Delete Category
      'renderer/components/connection-panel.js': 1,     // Safety Cap
      'renderer/components/duplicates-modal.js': 1,     // Move to Recycle Bin (duplicates-modal tests)
      'renderer/components/replace-question.js': 1,     // Replace <name>? / Replace N files? (round 2, R3-02: the EroScripts panel and Associate's search)
      'renderer/components/playlists.js': 2,            // Delete Playlist, Remove N selected videos (FT-104)
      'renderer/components/session-history-modal.js': 1, // Clear history
      'renderer/components/settings-panel.js': 5,       // Remove source, Add anyway, Remove and add, Restore, Import
      'renderer/components/settings-stash.js': 2,       // Remove Stash data…, remove the API key (Stash S1)
      'renderer/components/video-options-dialog.js': 1, // Unpair funscript, Unpair subtitle (one helper; stage 2a)
      'renderer/js/app.js': 1,                          // Delete Collection
    });
  });
});
