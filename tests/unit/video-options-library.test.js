/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library scans (faked IPC), renders its cards and
 * opens the REAL video options dialog through the REAL Modal; i18n.js
 * branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The video options dialog from the library's side (DESIGN-video-options.md
// (b), (d); build stage 2a): the ⋮ that opens it, the keyboard ways in, the
// quick (right-click) menu, the focus back on the ⋮ after a re-render, the
// card found by path when a write lands, Unpair and its Undo on the card and
// the filters, and the scan's auto-promotion leaving a Multi Axis set that
// Unpair kept alone. The dialog alone is in video-options-dialog.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Library } from '../../renderer/components/library.js';
import { DataService } from '../../renderer/js/data-service.js';
import { _resetVideoOptionsSessionForTests } from '../../renderer/components/video-options-dialog.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const LIB = 'C:\\Lib';
const SQUARE = `${LIB}\\Square Clip.mp4`;             // no script of its own
const ALPHA = `${LIB}\\Alpha Scene.mp4`;              // has its own sidecar
const ALPHA_OWN = `${LIB}\\Alpha Scene.funscript`;
const ZULU = `${LIB}\\Scripts\\Zulu Last.funscript`;  // paired with Square by hand
const ZULU_TWIST = `${LIB}\\Scripts\\Zulu Last.twist.funscript`;
const ALPHA_TWIST = `${LIB}\\Alpha Scene.twist.funscript`;
const SUB = `${LIB}\\Subs\\Square Clip.en.srt`;

const script = (ms) => JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: ms, pos: 100 }, { at: 2 * ms, pos: 0 }] });
const files = new Map([[ZULU, script(400)], [ALPHA_OWN, script(1000)], [ZULU_TWIST, script(500)], [ALPHA_TWIST, script(500)]]);

let lib;
let ds;
let onAddToQueue;

function scanResult() {
  return {
    videos: [
      { name: 'Square Clip.mp4', path: SQUARE, hasFunscript: false, funscriptPath: null, hasSubtitle: false, subtitlePath: null, variants: [] },
      {
        name: 'Alpha Scene.mp4', path: ALPHA, hasFunscript: true, funscriptPath: ALPHA_OWN, hasSubtitle: false, subtitlePath: null,
        variants: [{ label: 'Default', path: ALPHA_OWN, name: 'Alpha Scene.funscript' }],
      },
    ],
    unmatchedFunscripts: [],
    allFunscripts: [...files.keys()].map((p) => ({ name: p.split('\\').pop(), path: p })),
    failedPaths: [],
    skippedPaths: [],
  };
}

async function boot({ library = {}, categories = [], videoCategories = {}, player = {} } = {}) {
  ds = new DataService();
  ds._cache.settings = {
    backend: { port: 5123 },
    player: { ...player },
    library: {
      viewMode: 'grid',
      sources: [{ id: 's1', name: 'Lib', path: LIB, enabled: true }],
      associations: { [SQUARE]: { active: 'single', single: ZULU, multi: null, custom: null } },
      ...library,
    },
  };
  ds._cache.categories = categories;
  ds._cache.videoCategories = videoCategories;
  ds._initialized = true;
  onAddToQueue = vi.fn();
  lib = new Library({ settings: ds, onAddToQueue });
  lib._queueThumbnail = () => {};
  lib._validateAssociationsInBackground = () => {};
  lib._validateManualVariantsInBackground = () => {};
  lib._precomputeSpeedStatsInBackground = async () => {};
  lib._precomputeDurationsInBackground = async () => {};
  const container = document.createElement('div');
  container.innerHTML = '<span class="library__video-count"></span><div class="library__grid-wrapper"><div class="library__grid"></div></div>';
  document.body.appendChild(container);
  const wrapper = container.querySelector('.library__grid-wrapper');
  Object.defineProperty(wrapper, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(wrapper, 'clientWidth', { value: 1700, configurable: true });
  lib._container = container;
  await lib.ensureScanned({ forceRescan: true });
  lib._activeTab = 'matched';
  lib._applyFilters();
  await settle();
  return lib;
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const dialogBody = () => document.querySelector('.modal-body.video-options');
const cardFor = (p) => [...lib._container.querySelectorAll('.library__card')].find((el) => el.dataset.videoPath === p) || null;
const kebabFor = (p) => cardFor(p)?.querySelector('.library__kebab-btn') || null;
const panel = (id) => dialogBody().querySelector(`.video-options__panel[data-section="${id}"]`);
const railItem = (id) => dialogBody().querySelector(`.video-options__rail-item[data-section="${id}"]`);
const quickMenu = () => document.querySelector('.library__queue-context-menu');
const press = (target, key, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const contextMenuOn = (target) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  target.dispatchEvent(e);
  return e;
};

async function openFromKebab(p) {
  kebabFor(p).focus();
  kebabFor(p).click();
  await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
}

async function closeAll() {
  while (overlays().length > 0) {
    overlays().at(-1).querySelector('.modal-close-btn').click();
    await flush();
  }
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetVideoOptionsSessionForTests();
  document.body.innerHTML = '<div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const known = {
    setSetting: vi.fn(),
    scanDirectory: vi.fn(async () => scanResult()),
    readFunscript: vi.fn(async (p) => files.get(p) ?? null),
    filesExist: vi.fn(async (list) => list.map((p) => files.has(p))),
    fileExists: vi.fn(async (p) => files.has(p)),
  };
  window.funsync = new Proxy(known, { get: (o, k) => (k in o ? o[k] : vi.fn(async () => null)) });
});

afterEach(async () => {
  await closeAll();
  lib?._dismissQueueContextMenu?.();
  vi.unstubAllGlobals();
  delete globalThis.fetch;
  delete window.funsync;
  document.body.innerHTML = '';
  lib = null;
});

describe('the ⋮ opens the video options dialog', () => {
  it('says what it opens: aria-haspopup="dialog" and "Options for <name>"', async () => {
    await boot();
    const k = kebabFor(SQUARE);
    expect(k.getAttribute('aria-haspopup')).toBe('dialog');
    expect(k.getAttribute('aria-label')).toBe(t('videoOptions.openAria', { name: 'Square Clip.mp4' }));
    // Hover text names the dialog and its shortcut (Dave, 2026-11-18), not the
    // old menu's bare "Options".
    expect(k.title).toBe(t('videoOptions.openTitle'));
    expect(k.title).toContain('Alt+Enter');
  });

  it('focus starts on the active rail item; Escape gives it back to the ⋮, found again by path after a re-render', async () => {
    await boot();
    const opener = kebabFor(SQUARE);
    await openFromKebab(SQUARE);
    expect(document.activeElement).toBe(railItem('organise'));
    lib._applyFilters();                              // the grid rebuilds under the dialog
    expect(opener.isConnected).toBe(false);
    press(document.activeElement, 'Escape');
    await vi.waitFor(() => expect(overlays()).toHaveLength(0));
    await vi.waitFor(() => expect(document.activeElement).toBe(kebabFor(SQUARE)));
    expect(kebabFor(SQUARE)).not.toBe(opener);
  });
});

describe('keyboard ways in, and the quick menu', () => {
  it('Shift+F10 on a focused ⋮ opens the dialog; a mouse right-click opens the quick menu', async () => {
    await boot();
    kebabFor(SQUARE).focus();
    press(kebabFor(SQUARE), 'F10', { shiftKey: true });
    const e = contextMenuOn(kebabFor(SQUARE));
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    expect(quickMenu()).toBeNull();
    await closeAll();

    // A mouse press, then the right-click: the quick menu at the cursor.
    cardFor(SQUARE).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    contextMenuOn(cardFor(SQUARE));
    await flush();
    expect(quickMenu()).toBeTruthy();
    expect(dialogBody()).toBeNull();
  });

  it('the Menu key does the same as Shift+F10', async () => {
    await boot();
    kebabFor(ALPHA).focus();
    press(kebabFor(ALPHA), 'ContextMenu');
    contextMenuOn(kebabFor(ALPHA));
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    expect(document.querySelector('.modal-title').textContent).toBe('Alpha Scene.mp4');
  });

  it('Alt+Enter on a focused ⋮ opens the dialog', async () => {
    await boot();
    kebabFor(SQUARE).focus();
    press(kebabFor(SQUARE), 'Enter', { altKey: true });
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    expect(document.querySelector('.modal-title').textContent).toBe('Square Clip.mp4');
  });

  // Each step waits as a user does (fixup-ui, 2026-11-18): the menu arms its
  // click-away listeners a tick after it opens, and with no wait they were
  // never on, so this passed while the menu opened once per session
  // (verify-1, review-a RA-5).
  it('the quick menu: Play next first, then Add to queue, then All options…; Escape closes it alone', async () => {
    await boot();
    contextMenuOn(cardFor(SQUARE));
    await flush();
    const items = [...quickMenu().querySelectorAll('[role="menuitem"]')];
    expect(items.map((b) => b.textContent)).toEqual([
      t('queuePanel.contextAddToQueueNext'), t('queuePanel.contextAddToQueue'), t('library.contextAllOptions'),
    ]);
    items[0].click();
    expect(onAddToQueue).toHaveBeenCalledWith(SQUARE, 'next');
    expect(quickMenu()).toBeNull();
    await flush();

    contextMenuOn(cardFor(SQUARE));
    await flush();
    expect(quickMenu()).toBeTruthy();
    const later = vi.fn();
    document.addEventListener('keydown', later);
    press(document.body, 'Escape');
    document.removeEventListener('keydown', later);
    expect(quickMenu()).toBeNull();
    expect(later).not.toHaveBeenCalled();            // the player's own Escape did not see it
    await flush();

    contextMenuOn(cardFor(SQUARE));
    await flush();
    [...quickMenu().querySelectorAll('[role="menuitem"]')].at(-1).click();
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
  });

  it('opens on every right-click: after an item, Escape, a click away, All options…, and one on another card', async () => {
    await boot();
    const open = async (p) => { contextMenuOn(cardFor(p)); await flush(); return quickMenu(); };

    expect(await open(SQUARE)).toBeTruthy();
    quickMenu().querySelector('[role="menuitem"]').click();     // an item
    await flush();
    expect(await open(ALPHA)).toBeTruthy();
    press(document.body, 'Escape');                              // Escape
    await flush();
    expect(await open(SQUARE)).toBeTruthy();
    document.body.click();                                       // a click away
    expect(quickMenu()).toBeNull();
    await flush();
    const first = await open(ALPHA);
    const second = await open(SQUARE);                           // straight onto another card
    expect(second).toBeTruthy();
    expect(first.isConnected).toBe(false);
    [...quickMenu().querySelectorAll('[role="menuitem"]')].at(-1).click();   // All options…
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    await closeAll();
    await settle();
    expect(await open(ALPHA)).toBeTruthy();
  });
});

describe('a category untick lands on the card found by path', () => {
  it('the assignment and the card\'s dot are gone, though the card was re-rendered while the dialog was open', async () => {
    await boot({ categories: [{ id: 'c1', name: 'Kitchen', color: '#e94560' }], videoCategories: { [SQUARE]: ['c1'] } });
    expect(cardFor(SQUARE).querySelector('.library__card-category-dot')).toBeTruthy();
    await openFromKebab(SQUARE);
    lib._applyFilters();                              // a new card element for the same video
    panel('organise').querySelector('[data-vo-focus="category:c1"]').click();
    expect(ds.getVideoCategories(SQUARE)).toEqual([]);
    expect(cardFor(SQUARE).querySelector('.library__card-category-dot')).toBeNull();

    // And Undo puts the dot back on that card.
    dialogBody().querySelector('.video-options__undo').click();
    expect(ds.getVideoCategories(SQUARE)).toEqual(['c1']);
    expect(cardFor(SQUARE).querySelector('.library__card-category-dot')).toBeTruthy();
  });
});

describe('Unpair funscript and its Undo, on the card and the filters', () => {
  async function unpair(p) {
    await openFromKebab(p);
    railItem('script').click();
    panel('script').querySelector('[data-vo-focus="script:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
  }

  it('the card leaves Matched; Undo writes the entry back JSON-equal and the card shows its script again', async () => {
    const custom = { routes: [{ role: 'main', scriptPath: ZULU }, { role: 'axis', axis: 'R1', scriptPath: ZULU_TWIST }] };
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: ZULU, multi: null, custom } } } });
    const before = JSON.stringify(ds.get('library.associations')[SQUARE]);
    expect(cardFor(SQUARE)).toBeTruthy();

    await unpair(SQUARE);
    expect(cardFor(SQUARE)).toBeNull();                 // no script left: out of Matched
    const kept = ds.get('library.associations')[SQUARE];
    expect(kept.active).toBeNull();                      // the Custom Routing you saved stays
    expect(kept.custom).toEqual(custom);

    dialogBody().querySelector('.video-options__undo').click();
    expect(JSON.stringify(ds.get('library.associations')[SQUARE])).toBe(before);
    const video = lib.getVideoByPath(SQUARE);
    expect(video).toMatchObject({ hasFunscript: true, funscriptPath: ZULU, _manualAssociation: true });
    const card = cardFor(SQUARE);                        // back in Matched: the filters ran
    expect(card).toBeTruthy();
    expect(card.querySelector('.library__funscript-badge--manual')).toBeTruthy();
  });

  it('a video with its own script plays it after Unpair, and the dialog says the file stays', async () => {
    await boot({ library: { associations: { [ALPHA]: { active: 'single', single: ZULU, multi: null, custom: null } } } });
    expect(lib.getVideoByPath(ALPHA).funscriptPath).toBe(ZULU);
    await openFromKebab(ALPHA);
    railItem('script').click();
    panel('script').querySelector('[data-vo-focus="script:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    expect(overlays()[1].querySelector('.modal-message').textContent).toBe([
      t('videoOptions.script.unpair.confirmQuestion', { name: 'Zulu Last.funscript' }),
      t('videoOptions.script.unpair.nextOwn', { name: 'Alpha Scene.funscript' }),
    ].join('\n'));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(lib.getVideoByPath(ALPHA).funscriptPath).toBe(ALPHA_OWN);
    expect(ds.get('library.associations')[ALPHA]).toBeUndefined();
  });
});

describe('Unpair subtitle: no card on screen is no crash', () => {
  it('the library\'s own remove with no card drops the entry and does not throw', async () => {
    await boot({ library: { subtitleAssociations: { [SQUARE]: SUB } } });
    const video = lib.getVideoByPath(SQUARE);
    expect(video._manualSubtitle).toBe(true);
    expect(() => lib._removeSubtitleAssociation(video, null)).not.toThrow();
    expect(ds.get('library.subtitleAssociations')[SQUARE]).toBeUndefined();
    expect(video.hasSubtitle).toBe(false);
  });

  it('from the dialog, with the card scrolled away: unpaired, and Undo puts the exact entry and the badge back', async () => {
    await boot({ library: { subtitleAssociations: { [SQUARE]: SUB } } });
    await openFromKebab(SQUARE);
    cardFor(SQUARE).remove();                           // scrolled out of the virtual grid
    railItem('subtitles').click();
    panel('subtitles').querySelector('[data-vo-focus="subtitles:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    expect(overlays()[1].querySelector('.modal-message').textContent)
      .toBe(t('videoOptions.script.unpair.confirmQuestion', { name: 'Square Clip.en.srt' }));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.subtitleAssociations')[SQUARE]).toBeUndefined();
    expect(lib.getVideoByPath(SQUARE).hasSubtitle).toBe(false);

    lib._applyFilters();                                // the card is back on screen
    dialogBody().querySelector('.video-options__undo').click();
    expect(ds.get('library.subtitleAssociations')[SQUARE]).toBe(SUB);
    expect(lib.getVideoByPath(SQUARE)).toMatchObject({ hasSubtitle: true, subtitlePath: SUB, _manualSubtitle: true });
    expect(cardFor(SQUARE).querySelector('.library__subtitle-badge--manual')).toBeTruthy();
  });
});

describe('the Tags section\'s EroScripts hooks come from the library', () => {
  afterEach(() => { delete window.app; });

  it('login is the EroScripts panel\'s PUBLIC login, the expiry its handleSessionExpired, "logged in" main\'s session', async () => {
    await boot();
    const panel = {
      login: vi.fn(async () => true),
      handleSessionExpired: vi.fn(async () => {}),
      _loginViaWindow: vi.fn(async () => {}),
    };
    window.app = { eroscriptsPanel: panel };
    window.funsync.eroscriptsStatus = vi.fn(async () => ({ loggedIn: true }));
    const hooks = lib._videoOptionsHost().eroscripts;
    expect(await hooks.isLoggedIn()).toBe(true);
    expect(await hooks.login()).toBe(true);
    expect(panel.login).toHaveBeenCalledTimes(1);
    expect(panel._loginViaWindow).not.toHaveBeenCalled();   // never the private method
    await hooks.sessionExpired();
    expect(panel.handleSessionExpired).toHaveBeenCalledTimes(1);

    window.funsync.eroscriptsStatus = vi.fn(async () => ({ loggedIn: false }));
    expect(await hooks.isLoggedIn()).toBe(false);
    delete window.app;                                          // no panel: no login, nothing thrown
    expect(await hooks.login()).toBe(false);
    await expect(hooks.sessionExpired()).resolves.toBeUndefined();
  });

  it('the REAL EroScripts panel\'s login() logs in through its window and says whether it worked', async () => {
    await boot();
    const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
    document.body.insertAdjacentHTML('beforeend', '<div id="app"></div>');  // where the panel mounts
    const panel = new EroScriptsPanel({ settings: ds });
    window.funsync.eroscriptsLoginWindow = vi.fn(async () => ({ success: false, error: 'Login cancelled' }));
    expect(await panel.login()).toBe(false);
    expect(panel.isLoggedIn).toBe(false);
    window.funsync.eroscriptsLoginWindow = vi.fn(async () => ({ success: true, cookie: 'fake-cookie', username: 'tester' }));
    expect(await panel.login()).toBe(true);
    expect(panel.isLoggedIn).toBe(true);
    expect(ds.get('eroscripts.session')).toEqual({ cookie: 'fake-cookie', username: 'tester' });
  });
});

describe('a Multi Axis set that Unpair kept survives the scan (Prefer multi-axis on)', () => {
  const keptMulti = { main: ZULU, axes: { twist: ZULU_TWIST }, buttplugVib: false };

  it('is not replaced by an auto-paired set, and is not counted as eligible', async () => {
    await boot({
      player: { preferMultiAxis: 'multi' },
      library: { associations: { [ALPHA]: { active: null, single: null, multi: keptMulti, custom: null } } },
    });
    // Alpha's own script has an axis file beside it, so it would be eligible.
    const entry = ds.get('library.associations')[ALPHA];
    expect(entry.active).toBeNull();
    expect(entry.multi).toEqual(keptMulti);
    expect(lib._countAutoPromotionEligible()).toBe(0);
    expect(lib._autoPromoteEligibleVideos(ds.get('library.associations'))).toBe(0);
    expect(ds.get('library.associations')[ALPHA].multi).toEqual(keptMulti);
  });

  it('a video with nothing of yours is still promoted as before', async () => {
    await boot({ player: { preferMultiAxis: 'multi' }, library: { associations: {} } });
    const entry = ds.get('library.associations')[ALPHA];
    expect(entry.active).toBe('multi');
    expect(entry.multi).toMatchObject({ main: ALPHA_OWN, axes: { twist: ALPHA_TWIST }, autoAssigned: true });
  });
});

// ---------------------------------------------------------------------------
// fixup-ui (2026-11-18): review-a RA-2, RA-6, RA-8; verify-1's prune toast.
// ---------------------------------------------------------------------------

describe('the grid does not rebuild under the dialog on a VR pick (RA-6)', () => {
  it('no render while it is open; the owed one runs on close', async () => {
    await boot();
    await openFromKebab(SQUARE);
    const spy = vi.spyOn(lib, '_renderGrid');
    railItem('vr').click();
    panel('vr').querySelector('[data-vo-focus="vr:vr"]').click();
    expect(ds.get('library.manualVRType')[SQUARE]).toBe('vr');
    expect(spy).not.toHaveBeenCalled();
    await closeAll();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});

describe('the pair dialog has no ✕ that unpairs (Dave, 2026-11-18, RA-2)', () => {
  it('Change… shows the current script with no remove button; a Custom Routing you saved survives the visit', async () => {
    const custom = { routes: [{ role: 'main', scriptPath: ZULU }, { role: 'axis', axis: 'R1', scriptPath: ZULU_TWIST }] };
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: ZULU, multi: null, custom } } } });
    const before = JSON.stringify(ds.get('library.associations')[SQUARE]);
    await openFromKebab(SQUARE);
    railItem('script').click();
    panel('script').querySelector('[data-vo-focus="script:change"]').click();
    await vi.waitFor(() => expect(document.querySelector('.library__assoc-current-name')).toBeTruthy());
    const current = document.querySelector('.library__assoc-current');
    expect(current.querySelector('.library__assoc-current-name').textContent).toBe('Zulu Last.funscript');
    expect(current.querySelector('button')).toBeNull();
    await closeAll();
    await settle();
    expect(JSON.stringify(ds.get('library.associations')[SQUARE])).toBe(before);
  });
});

describe('Undo of an Unpair puts the R4-06 fallback back too (RA-8)', () => {
  it('a video playing its own script for an unreadable pairing does so again after Undo', async () => {
    await boot({ library: { associations: { [ALPHA]: { active: 'single', single: ZULU, multi: null, custom: null } } } });
    const v = lib.getVideoByPath(ALPHA);
    expect(lib._fallBackToOwnScript(v)).toBe(true);              // as the validator does for a script it cannot read
    const before = JSON.stringify(ds.get('library.associations')[ALPHA]);
    await openFromKebab(ALPHA);
    railItem('script').click();
    panel('script').querySelector('[data-vo-focus="script:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(lib.getVideoByPath(ALPHA)).toMatchObject({ funscriptPath: ALPHA_OWN, _assocFallbackFrom: null });
    dialogBody().querySelector('.video-options__undo').click();
    expect(JSON.stringify(ds.get('library.associations')[ALPHA])).toBe(before);
    expect(lib.getVideoByPath(ALPHA)).toMatchObject({ funscriptPath: ALPHA_OWN, _assocFallbackFrom: ZULU, _manualAssociation: true });
  });

  it('a readable pairing is not put on the fallback by its Undo', async () => {
    await boot({ library: { associations: { [ALPHA]: { active: 'single', single: ZULU, multi: null, custom: null } } } });
    await openFromKebab(ALPHA);
    railItem('script').click();
    panel('script').querySelector('[data-vo-focus="script:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    dialogBody().querySelector('.video-options__undo').click();
    expect(lib.getVideoByPath(ALPHA)).toMatchObject({ funscriptPath: ZULU, _assocFallbackFrom: null });
  });
});

describe('Remove a Multi Axis set you made over the video\'s own script, on the card', () => {
  it('the video plays its own script alone after Remove; Undo brings the set back on it', async () => {
    const multi = { main: ALPHA_OWN, axes: { twist: ALPHA_TWIST }, buttplugVib: false };
    await boot({ library: { associations: { [ALPHA]: { active: 'multi', single: ALPHA_OWN, multi, custom: null } } } });
    expect(lib.getVideoByPath(ALPHA)._multiAxis).toEqual(multi);
    const before = JSON.stringify(ds.get('library.associations')[ALPHA]);
    await openFromKebab(ALPHA);
    railItem('script').click();
    expect(panel('script').querySelector('[data-vo-focus="script:unpair"]')).toBeNull();
    panel('script').querySelector('[data-vo-focus="script:removeSet:multi"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.associations')[ALPHA]).toBeUndefined();
    expect(lib.getVideoByPath(ALPHA)).toMatchObject({ funscriptPath: ALPHA_OWN, _multiAxis: null, _manualAssociation: false });
    dialogBody().querySelector('.video-options__undo').click();
    expect(JSON.stringify(ds.get('library.associations')[ALPHA])).toBe(before);
    expect(lib.getVideoByPath(ALPHA)).toMatchObject({ funscriptPath: ALPHA_OWN, _multiAxis: multi, _manualAssociation: true });
  });
});

// Dave, 2026-11-18 (fixup-ui follow-up): "Stop pruning". A pairing is never
// removed because its script file is missing, even when it is provably gone
// (the file absent, its folder answers: the one shape the old check pruned).
// It stays a pairing everywhere: kept in the store, under Matched, its card
// badge says "Script not found", and so does the Script section. While the
// location does not answer the words are "Can't check the script right now".
describe('a pairing whose script is missing is kept, and says so everywhere (Dave: "Stop pruning")', () => {
  const GONE = `${LIB}\\Scripts\\Gone Soon.funscript`;
  const badgeOf = (p) => cardFor(p)?.querySelector('.library__funscript-badge');
  const folderAnswers = () => {
    window.funsync.filesExist = vi.fn(async (list) => list.map((p) => files.has(p) || p === `${LIB}\\Scripts`));
  };

  it('provably gone: the check keeps it byte-identical, says nothing, and the card, Matched and the Script section agree', async () => {
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: GONE, multi: null, custom: null } } } });
    folderAnswers();
    const before = JSON.stringify(ds.get('library.associations'));
    await Library.prototype._validateAssociationsInBackground.call(lib);
    await settle();
    expect(JSON.stringify(ds.get('library.associations'))).toBe(before);
    expect(document.querySelector('#toast-container').textContent).toBe('');
    // The card: still under Matched, its badge marked "Script not found".
    expect(lib.getVideoByPath(SQUARE)).toMatchObject({ hasFunscript: true, funscriptPath: GONE });
    expect(badgeOf(SQUARE).classList.contains('library__funscript-badge--missing')).toBe(true);
    expect(badgeOf(SQUARE).title).toBe(t('videoOptions.script.status.missing'));
    lib._applyFilters();                                     // a re-render keeps the mark
    expect(badgeOf(SQUARE).title).toBe(t('videoOptions.script.status.missing'));
    // The Script section: the same pairing, the same words.
    await openFromKebab(SQUARE);
    railItem('script').click();
    await vi.waitFor(() => expect(panel('script').querySelector('.video-options__status--missing')).toBeTruthy());
    expect(panel('script').querySelector('.video-options__name').textContent).toBe('Gone Soon.funscript');
    expect(panel('script').querySelector('[data-vo-focus="script:unpair"]')).toBeTruthy();   // you can still unpair it
  });

  it('its location does not answer: kept, and the card says "Can\'t check the script right now"', async () => {
    const AWAY = `${LIB}\\Away\\Elsewhere.funscript`;
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: AWAY, multi: null, custom: null } } } });
    const before = JSON.stringify(ds.get('library.associations'));
    await Library.prototype._validateAssociationsInBackground.call(lib);
    expect(JSON.stringify(ds.get('library.associations'))).toBe(before);
    expect(document.querySelector('#toast-container').textContent).toBe('');
    expect(badgeOf(SQUARE).title).toBe(t('videoOptions.script.status.unknown'));
  });

  it('the card\'s own read keeps it too, keeps the video paired on screen and does not read it again', async () => {
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: GONE, multi: null, custom: null } } } });
    folderAnswers();
    const before = JSON.stringify(ds.get('library.associations'));
    const v = lib.getVideoByPath(SQUARE);
    await expect(lib._readFunscriptResilient(v)).resolves.toBeNull();
    expect(JSON.stringify(ds.get('library.associations'))).toBe(before);
    expect(v).toMatchObject({ hasFunscript: true, funscriptPath: GONE, _scriptMissing: GONE });
    expect(badgeOf(SQUARE).title).toBe(t('videoOptions.script.status.missing'));
    window.funsync.readFunscript.mockClear();
    v._statsReadFor = null;
    await lib._loadSpeedStatsForVideo(v, cardFor(SQUARE));
    expect(window.funsync.readFunscript).not.toHaveBeenCalledWith(GONE);
  });

  // followUp3 (Dave: "Script not found" opens the file explorer where the
  // path says it should be). Claude's call: the card's red badge opens the
  // options at Script, on that control, not a file dialog from a card click.
  it('the red badge opens the options on Locate; the picker opens at the stored path; the file picked pairs it; Undo exact', async () => {
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: GONE, multi: null, custom: null } } } });
    folderAnswers();
    await Library.prototype._validateAssociationsInBackground.call(lib);
    const before = JSON.stringify(ds.get('library.associations')[SQUARE]);
    window.funsync.selectFunscript = vi.fn(async () => ({ name: 'Zulu Last.funscript', path: ZULU }));
    const play = vi.spyOn(lib, '_playVideo');
    badgeOf(SQUARE).click();
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    expect(play).not.toHaveBeenCalled();                              // the badge, not the card's play
    const loc = () => panel('script').querySelector('[data-vo-focus="script:locate"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(loc()));
    loc().click();
    await vi.waitFor(() => expect(ds.get('library.associations')[SQUARE].single).toBe(ZULU));
    expect(window.funsync.selectFunscript).toHaveBeenCalledWith({ defaultPath: GONE });
    expect(JSON.parse(JSON.stringify(ds.get('library.associations')[SQUARE]))).toEqual({ ...JSON.parse(before), single: ZULU });
    expect(lib.getVideoByPath(SQUARE)).toMatchObject({ hasFunscript: true, funscriptPath: ZULU });
    expect(lib._scriptMissingStatus(lib.getVideoByPath(SQUARE))).toBeNull();
    dialogBody().querySelector('.video-options__undo').click();
    expect(JSON.stringify(ds.get('library.associations')[SQUARE])).toBe(before);
    expect(lib.getVideoByPath(SQUARE).funscriptPath).toBe(GONE);
  });

  it('the file back: a read that works clears the mark', async () => {
    await boot({ library: { associations: { [SQUARE]: { active: 'single', single: GONE, multi: null, custom: null } } } });
    folderAnswers();
    const v = lib.getVideoByPath(SQUARE);
    await lib._readFunscriptResilient(v);
    expect(lib._scriptMissingStatus(v)).toBe('missing');
    files.set(GONE, script(300));
    try {
      await expect(lib._readFunscriptResilient(v)).resolves.toBeTruthy();
      expect(lib._scriptMissingStatus(v)).toBeNull();
      expect(badgeOf(SQUARE).classList.contains('library__funscript-badge--missing')).toBe(false);
      expect(badgeOf(SQUARE).title).toBe(t('library.funscriptManual'));
    } finally {
      files.delete(GONE);
    }
  });
});
