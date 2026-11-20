/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL dialog (video-options-dialog.js) is built in a
 * document by the REAL Modal and driven by keys and clicks; i18n.js branches
 * on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// The video options dialog on its own (DESIGN-video-options.md (b), (d);
// build stage 2a), with the REAL Modal, the REAL model, the REAL DataService
// (its IPC faked) and a fake library host that records what the dialog asks
// of it. The library side (the ⋮, the card, the polls) is in
// video-options-library.test.js.
//
// Asserted: the focus, which section shows, what the store holds, the words
// on screen (through t(), so the same before and after the locale merge), and
// whether a key ever reaches a document-level listener as the player's own
// handler would see it (keyboard.js listens on document and acts on a key
// `targetOwnsKey` does not give to the focused control).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { targetOwnsKey } from '../../renderer/js/keyboard.js';

// The Tags section (stage 2b) is a fake here: a host element and an Escape
// it may use first, the contract in video-options-tags.js's header.
const tagsFake = vi.hoisted(() => ({ menuOpen: false, mounted: 0, disposed: 0, asked: 0, ctx: null }));
vi.mock('../../renderer/components/video-options-tags.js', () => ({
  mountTagsSection(host, ctx) {
    tagsFake.mounted++;
    tagsFake.ctx = ctx;
    const el = document.createElement('div');
    el.className = 'fake-tags';
    const chip = document.createElement('button');
    chip.className = 'fake-tags__chip';
    chip.textContent = 'pov';
    chip.dataset.voFocus = 'fake:chip';
    el.appendChild(chip);
    host.appendChild(el);
    return {
      dispose() { tagsFake.disposed++; el.remove(); },
      handleEscape() {
        tagsFake.asked++;
        if (!tagsFake.menuOpen) return false;
        tagsFake.menuOpen = false;
        return true;
      },
    };
  },
}));

const { openVideoOptionsDialog, _resetVideoOptionsSessionForTests, SECTIONS } = await import('../../renderer/components/video-options-dialog.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const VIDEO = 'C:\\Lib\\Square Clip.mp4';
const OTHER_A = 'C:\\Lib\\Alpha.mp4';
const OTHER_B = 'C:\\Lib\\Bravo.mp4';
const ZULU = 'C:\\Lib\\Scripts\\Zulu Last.funscript';
const OWN = 'C:\\Lib\\Square Clip.funscript';
const AXIS = 'C:\\Lib\\Scripts\\Zulu Last.twist.funscript';

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const dialogBody = () => document.querySelector('.modal-body.video-options');
const railItem = (id) => dialogBody().querySelector(`.video-options__rail-item[data-section="${id}"]`);
const panel = (id) => dialogBody().querySelector(`.video-options__panel[data-section="${id}"]`);
const activeSection = () => dialogBody().querySelector('.video-options__rail-item[aria-selected="true"]')?.dataset.section;
const liveText = () => dialogBody().querySelector('.video-options__live-text').textContent;
const undoButton = () => dialogBody().querySelector('.video-options__undo');
const press = (target, key, init = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

let ds;
let host;
let video;
let ipc;
let reached;
let onDocKey;

function makeDataService({ associations = {}, playlists = [], categories = [], videoCategories = {}, library = {} } = {}) {
  const d = new DataService();
  d._cache.settings.library = { ...d._cache.settings.library, associations, ...library };
  d._cache.playlists = JSON.parse(JSON.stringify(playlists));
  d._cache.categories = JSON.parse(JSON.stringify(categories));
  d._cache.videoCategories = JSON.parse(JSON.stringify(videoCategories));
  d._initialized = true;
  return d;
}

function makeHost(over = {}) {
  return {
    settings: ds,
    getVideo: (p) => (p === video.path ? video : null),
    libraryVideos: () => [video],
    canQueue: true,
    addToQueue: vi.fn(),
    formatDuration: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    thumbnailUrl: () => null,
    pathStatus: vi.fn(async () => true),
    embeddedAxes: () => null,
    randomVariantOn: () => false,
    collectionContext: () => ({ sources: [], folderIndex: null, descendantsOf: null }),
    changeScript: vi.fn(async () => {}),
    unpairApplied: vi.fn(),
    unpairUndone: vi.fn(),
    dataChanged: vi.fn(),
    categoriesChanged: vi.fn(),
    subtitleChanged: vi.fn(),
    thumbnailChanged: vi.fn(),
    vrChanged: vi.fn(),
    ...over,
  };
}

/** Open the dialog; `done` is its promise (wrapped: an async function would wait for it). */
async function open(opts) {
  const done = openVideoOptionsDialog(host, video, opts);
  await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
  return { done };
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
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
  ipc = [];
  window.funsync = new Proxy({}, {
    get: (_o, k) => vi.fn(async (...args) => {
      ipc.push([k, ...args]);
      if (k === 'addPlaylist') return { id: 'p-new', name: args[0], videoPaths: [] };
      return null;
    }),
  });
  video = {
    name: 'Square Clip.mp4', path: VIDEO, hasFunscript: true, funscriptPath: ZULU,
    _manualAssociation: true, _ownScriptKnown: true, _ownFunscriptPath: null, variants: [], duration: 2052,
  };
  ds = makeDataService({
    associations: { [VIDEO]: { active: 'single', single: ZULU, multi: null, custom: null } },
    playlists: [{ id: 'p1', name: 'Morning', videoPaths: [OTHER_A, VIDEO, OTHER_B] }, { id: 'p2', name: 'Long sessions', videoPaths: [] }],
    categories: [{ id: 'c1', name: 'Kitchen', color: '#e94560' }],
    videoCategories: { [VIDEO]: ['c1'] },
  });
  host = makeHost();
  Object.assign(tagsFake, { menuOpen: false, mounted: 0, disposed: 0, asked: 0, ctx: null });
  // The player's handler, as far as these tests need it: keyboard.js acts
  // on a key that reaches document and that the focused control does not own.
  reached = [];
  onDocKey = (e) => { if (!targetOwnsKey(e)) reached.push(e.key); };
  document.addEventListener('keydown', onDocKey);
});

afterEach(async () => {
  document.removeEventListener('keydown', onDocKey);
  await closeAll();
  vi.unstubAllGlobals();
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('rail keys (as Settings)', () => {
  it('Up / Down move the section and wrap, Home / End jump, the selection follows the focus', async () => {
    await open();
    expect(document.activeElement).toBe(railItem('organise'));
    const e1 = press(railItem('organise'), 'ArrowDown');
    expect(activeSection()).toBe('tags');
    expect(document.activeElement).toBe(railItem('tags'));
    expect(panel('tags').hidden).toBe(false);
    expect(panel('organise').hidden).toBe(true);
    expect(railItem('tags').getAttribute('aria-selected')).toBe('true');
    expect(railItem('tags').tabIndex).toBe(0);
    expect(railItem('organise').tabIndex).toBe(-1);

    press(railItem('tags'), 'ArrowUp');
    const e2 = press(railItem('organise'), 'ArrowUp');           // wraps to the last
    expect(activeSection()).toBe('file');
    press(railItem('file'), 'ArrowDown');                        // and back round to the first
    expect(activeSection()).toBe('organise');
    const e3 = press(railItem('organise'), 'End');
    expect(activeSection()).toBe('file');
    const e4 = press(railItem('file'), 'Home');
    expect(activeSection()).toBe('organise');
    // Handled here (the content column does not scroll, the browser does nothing more).
    for (const e of [e1, e2, e3, e4]) expect(e.defaultPrevented).toBe(true);
  });

  it('none of those keys reaches the player behind: no seek, no volume change, no jump', async () => {
    await open();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) press(document.activeElement, key);
    expect(reached).toEqual([]);
  });

  it('navigation keys on any other control in the dialog stop there too (a focused Play button does not seek the video)', async () => {
    await open();
    const play = dialogBody().querySelector('.video-options__play');
    play.focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      press(play, key);
      press(play, key, { shiftKey: true });
    }
    expect(reached).toEqual([]);
    // A letter still goes on, as from any other dialog (and a text box owns it).
    press(play, 'm');
    expect(reached).toEqual(['m']);
  });

  it('Tab from the rail goes into the active section; the header comes before the rail in the Tab order', async () => {
    await open();
    const body = dialogBody();
    const order = [...body.querySelectorAll('button, input')].filter((n) => !n.closest('[hidden]') && n.tabIndex >= 0);
    const playAt = order.indexOf(body.querySelector('.video-options__play'));
    const railAt = order.indexOf(railItem('organise'));
    const firstInSection = order.findIndex((n) => panel('organise').contains(n));
    expect(playAt).toBeGreaterThanOrEqual(0);
    expect(playAt).toBeLessThan(railAt);
    expect(firstInSection).toBe(railAt + 1);
    // Only the active rail item is a Tab stop, so Shift+Tab from the section lands on it.
    expect([...body.querySelectorAll('.video-options__rail-item')].filter((n) => n.tabIndex === 0)).toEqual([railItem('organise')]);
  });
});

describe('opening', () => {
  it('starts on the active rail item, not on Play, and on the last section opened this session', async () => {
    await open();
    expect(document.activeElement).toBe(railItem('organise'));
    railItem('vr').click();
    await closeAll();
    await open();
    expect(activeSection()).toBe('vr');
    expect(document.activeElement).toBe(railItem('vr'));
  });

  it('the title is the video name (its full name in the title attribute) and the facts describe the panel', async () => {
    await open();
    const panelEl = dialogBody().closest('.modal-panel');
    const title = panelEl.querySelector('.modal-title');
    expect(title.textContent).toBe('Square Clip.mp4');
    expect(title.title).toBe('Square Clip.mp4');
    const facts = document.getElementById(panelEl.getAttribute('aria-describedby'));
    expect(facts).toBeTruthy();
    expect(facts.textContent).toContain('34:12');
  });

  it('writes nothing: opening and visiting every section leave the store and the IPC alone', async () => {
    const set = vi.spyOn(ds, 'set');
    await open();
    for (const id of SECTIONS) railItem(id).click();
    await flush();
    expect(set).not.toHaveBeenCalled();
    expect(ipc.filter(([k]) => k !== 'filesExist' && k !== 'statVideoFiles')).toEqual([]);
  });
});

describe('Escape', () => {
  it('closes an open menu of the Tags section first, then the dialog', async () => {
    const { done } = await open({ section: 'tags' });
    tagsFake.menuOpen = true;
    press(document.activeElement, 'Escape');
    expect(overlays()).toHaveLength(1);                        // the section used it
    expect(tagsFake.asked).toBe(1);
    press(document.activeElement, 'Escape');
    await flush();
    expect(overlays()).toHaveLength(0);
    await expect(done).resolves.toEqual({ kind: 'closed' });
    expect(tagsFake.disposed).toBe(1);
  });

  it('asks the Tags section only while it is the open one', async () => {
    await open({ section: 'tags' });
    railItem('organise').click();
    expect(tagsFake.disposed).toBe(1);                         // switched away: disposed
    tagsFake.menuOpen = true;
    press(document.activeElement, 'Escape');
    await flush();
    expect(tagsFake.asked).toBe(0);
    expect(overlays()).toHaveLength(0);
  });

  // 2b's optional ctx fields (its header): the dialog's own Undo, and the
  // library's EroScripts hooks instead of the panel's private login.
  it('hands the section the dialog\'s Undo (live line, focused) and the library\'s EroScripts hooks', async () => {
    const eroscripts = { isLoggedIn: vi.fn(async () => true), login: vi.fn(async () => true), sessionExpired: vi.fn() };
    host.eroscripts = eroscripts;
    await open({ section: 'tags' });
    expect(tagsFake.ctx.eroscripts).toBe(eroscripts);
    expect(tagsFake.ctx.getScriptMeta).toBeUndefined();       // Round 3
    expect(tagsFake.ctx.showVideosWithTag).toBeUndefined();   // Round 3

    const run = vi.fn(() => ({ message: 'pov is back.' }));
    tagsFake.ctx.announceUndo('Removed pov from this video.', { run, focusKey: 'fake:chip' });
    expect(liveText()).toBe('Removed pov from this video.');
    expect(undoButton().hidden).toBe(false);
    expect(document.activeElement).toBe(undoButton());
    undoButton().click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(liveText()).toBe('pov is back.');
    expect(document.activeElement).toBe(panel('tags').querySelector('[data-vo-focus="fake:chip"]'));
  });

  it('with no EroScripts hooks from the library, the section gets none (its own fallback applies)', async () => {
    await open({ section: 'tags' });
    expect(tagsFake.ctx.eroscripts).toBeUndefined();
    expect(typeof tagsFake.ctx.announceUndo).toBe('function');
  });

  it('hosts the Tags section with the contract\'s ctx', async () => {
    await open({ section: 'tags' });
    expect(tagsFake.mounted).toBe(1);
    expect(panel('tags').querySelector('.fake-tags')).toBeTruthy();
    expect(tagsFake.ctx.video.path).toBe(VIDEO);
    expect(tagsFake.ctx.dataService).toBe(ds);
    expect(tagsFake.ctx.modalBody).toBe(dialogBody());
    expect(tagsFake.ctx.getLibraryVideos()).toEqual([video]);
    tagsFake.ctx.announce('Got 7 tags from EroScripts (2 new).');
    expect(liveText()).toBe('Got 7 tags from EroScripts (2 new).');
    tagsFake.ctx.onDataChanged('tags');
    expect(host.dataChanged).toHaveBeenCalledWith('tags');
  });
});

describe('Organise: a playlist untick and its Undo', () => {
  it('takes the video out of the playlist, and Undo puts it back where it was, not at the end', async () => {
    await open();
    const box = panel('organise').querySelector('[data-vo-focus="playlist:p1"]');
    expect(box.checked).toBe(true);
    box.click();
    expect(ds.getPlaylist('p1').videoPaths).toEqual([OTHER_A, OTHER_B]);
    expect(liveText()).toBe(t('videoOptions.live.removedFrom', { name: 'Morning' }));
    expect(undoButton().hidden).toBe(false);

    undoButton().click();
    expect(ds.getPlaylist('p1').videoPaths).toEqual([OTHER_A, VIDEO, OTHER_B]);
    expect(undoButton().hidden).toBe(true);
    // The box shows it again and has the focus back (the control that removed).
    const again = panel('organise').querySelector('[data-vo-focus="playlist:p1"]');
    expect(again.checked).toBe(true);
    expect(document.activeElement).toBe(again);
  });

  it('a tick adds at once and offers no Undo; a new playlist is made, ticked, and focused', async () => {
    await open();
    panel('organise').querySelector('[data-vo-focus="playlist:p2"]').click();
    expect(ds.getPlaylist('p2').videoPaths).toEqual([VIDEO]);
    expect(undoButton().hidden).toBe(true);

    panel('organise').querySelector('[data-vo-focus="organise:newPlaylist"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));   // stacked on the dialog
    const input = overlays()[1].querySelector('input');
    input.value = 'Evening';
    overlays()[1].querySelector('.modal-btn--primary').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    await vi.waitFor(() => expect(ds.getPlaylist('p-new')?.videoPaths).toEqual([VIDEO]));
    expect(document.activeElement).toBe(panel('organise').querySelector('[data-vo-focus="playlist:p-new"]'));
  });

  it('an Undo still pending when the dialog closes goes on in a toast for 8 s', async () => {
    const { done } = await open();
    panel('organise').querySelector('[data-vo-focus="playlist:p1"]').click();
    await closeAll();
    await done;
    let toastUndo;
    await vi.waitFor(() => { toastUndo = document.querySelector('.video-options__toast-undo'); expect(toastUndo).toBeTruthy(); });
    toastUndo.click();
    expect(ds.getPlaylist('p1').videoPaths).toEqual([OTHER_A, VIDEO, OTHER_B]);
  });
});

describe('Script: Unpair funscript (stacked confirm, UI side)', () => {
  const openUnpair = async () => {
    await open({ section: 'script' });
    const btn = panel('script').querySelector('[data-vo-focus="script:unpair"]');
    expect(btn, 'Unpair is offered for a pairing you made').toBeTruthy();
    btn.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    return overlays()[1];
  };

  it('Cancel changes nothing', async () => {
    const before = JSON.stringify(ds.get('library.associations'));
    const confirm = await openUnpair();
    confirm.querySelector('.modal-btn--secondary').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(JSON.stringify(ds.get('library.associations'))).toBe(before);
    expect(host.unpairApplied).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(panel('script').querySelector('[data-vo-focus="script:unpair"]'));
  });

  it('Escape closes the confirm only; the dialog stays and nothing changed', async () => {
    const before = JSON.stringify(ds.get('library.associations'));
    await openUnpair();
    press(document.activeElement, 'Escape');
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(dialogBody()).toBeTruthy();
    expect(JSON.stringify(ds.get('library.associations'))).toBe(before);
    expect(host.unpairApplied).not.toHaveBeenCalled();
  });

  it('the confirm names the script, says the file stays and what plays next; Unpair removes the whole pairing', async () => {
    const confirm = await openUnpair();
    expect(confirm.querySelector('.modal-message').textContent).toBe([
      t('videoOptions.script.unpair.confirmQuestion', { name: 'Zulu Last.funscript' }),
      t('videoOptions.script.unpair.nextNone'),
    ].join('\n'));
    expect(confirm.querySelector('.modal-btn--danger').textContent).toBe(t('videoOptions.script.unpair.confirmButton'));
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    // A single pairing and nothing else saved: the whole entry goes, every
    // slot and mirror field with it.
    expect(Object.prototype.hasOwnProperty.call(ds.get('library.associations'), VIDEO)).toBe(false);
    expect(host.unpairApplied).toHaveBeenCalledTimes(1);
    expect(liveText()).toBe(t('videoOptions.script.unpair.done', { name: 'Zulu Last.funscript' }));
    expect(document.activeElement).toBe(undoButton());       // the Unpair button went away
  });

  it('a Multi Axis set you saved in another slot is named in the confirm and kept (Dave, answer 1)', async () => {
    const multi = { main: ZULU, axes: { twist: AXIS }, buttplugVib: false };
    ds.set('library.associations', { [VIDEO]: { active: 'single', single: ZULU, multi, custom: null } });
    const confirm = await openUnpair();
    expect(confirm.querySelector('.modal-message').textContent)
      .toContain(t('videoOptions.script.unpair.keepsMulti', { count: 1 }));
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    const entry = ds.get('library.associations')[VIDEO];
    expect(entry.active).toBeNull();
    expect(entry.multi).toEqual(multi);
  });

  it('Undo writes the entry back JSON-equal, every slot and mirror field, and re-applies it', async () => {
    const custom = { routes: [{ role: 'main', scriptPath: ZULU }, { role: 'axis', axis: 'R1', scriptPath: AXIS }] };
    const original = { active: 'single', single: ZULU, multi: { main: ZULU, axes: { twist: AXIS }, buttplugVib: false }, custom, funscriptPath: ZULU };
    ds.set('library.associations', { [VIDEO]: JSON.parse(JSON.stringify(original)) });
    const before = JSON.stringify(ds.get('library.associations')[VIDEO]);
    const confirm = await openUnpair();
    confirm.querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).not.toBe(before);

    undoButton().click();
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).toBe(before);
    // No fallback was on (R4-06), so none goes back on (review-a RA-8).
    expect(host.unpairUndone).toHaveBeenCalledWith(video, { kind: 'single', config: ZULU }, { fallbackFrom: null });
    expect(liveText()).toBe(t('videoOptions.script.unpair.undone', { name: 'Zulu Last.funscript' }));
  });

  it('a pairing FunSync made by name is not offered Unpair; the section says how to undo it', async () => {
    ds.set('library.associations', {});
    Object.assign(video, { funscriptPath: OWN, _manualAssociation: false, _ownFunscriptPath: OWN });
    await open({ section: 'script' });
    expect(panel('script').querySelector('[data-vo-focus="script:unpair"]')).toBeNull();
    expect(panel('script').textContent).toContain(t('videoOptions.script.unpair.byName'));
  });

  it('shows "Script not found" only on proven absence', async () => {
    host.pathStatus = vi.fn(async () => null);                 // offline: unknown, not absent
    await open({ section: 'script' });
    await vi.waitFor(() => expect(panel('script').querySelector('.video-options__status--unknown')).toBeTruthy());
    expect(panel('script').querySelector('.video-options__status--missing')).toBeNull();
    await closeAll();
    host.pathStatus = vi.fn(async () => false);
    await open({ section: 'script' });
    await vi.waitFor(() => expect(panel('script').querySelector('.video-options__status--missing')?.textContent)
      .toBe(t('videoOptions.script.status.missing')));
  });
});

describe('big actions close the dialog, run, and reopen it on the same section and control', () => {
  it('Change…', async () => {
    let ranWhileOpen = null;
    host.changeScript = vi.fn(async () => { ranWhileOpen = overlays().length; });
    const { done } = await open({ section: 'script' });
    panel('script').querySelector('[data-vo-focus="script:change"]').click();
    await vi.waitFor(() => expect(host.changeScript).toHaveBeenCalledTimes(1));
    expect(ranWhileOpen).toBe(0);                               // the dialog was closed while it ran
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
    expect(activeSection()).toBe('script');
    expect(document.activeElement).toBe(panel('script').querySelector('[data-vo-focus="script:change"]'));
    await closeAll();
    await expect(done).resolves.toEqual({ kind: 'closed' });
  });

  it('waits for any dialog the action left open before reopening', async () => {
    let release;
    host.changeScript = vi.fn(async () => {
      // An Associate run that opens itself again and stays open.
      const { Modal } = await import('../../renderer/components/modal.js');
      Modal.open({ title: 'Associate (again)' });
      release = () => overlays()[0].querySelector('.modal-close-btn').click();
    });
    await open({ section: 'script' });
    panel('script').querySelector('[data-vo-focus="script:change"]').click();
    await vi.waitFor(() => expect(release).toBeTruthy());
    await flush();
    expect(dialogBody()).toBeNull();                            // not under the other dialog
    release();
    await vi.waitFor(() => expect(dialogBody()).toBeTruthy());
  });

  it('Play closes the dialog and says so to the library', async () => {
    const { done } = await open();
    dialogBody().querySelector('.video-options__play').click();
    await expect(done).resolves.toEqual({ kind: 'play' });
    expect(overlays()).toHaveLength(0);
  });
});

describe('untrusted text is text', () => {
  it('a playlist, a category and a file name with markup render as text', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    ds._cache.playlists.push({ id: 'p3', name: evil, videoPaths: [] });
    ds._cache.categories.push({ id: 'c2', name: evil, color: '#fff' });
    video.name = `${evil}.mp4`;
    await open();
    const body = dialogBody();
    expect(body.querySelector('img[onerror]')).toBeNull();
    expect(document.querySelector('.modal-title').textContent).toBe(`${evil}.mp4`);
    expect(body.textContent).toContain(evil);
    expect(window.__pwned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fixup-ui (2026-11-18): review-a RA-1, RA-3, RA-4, RA-7; verify-1's phantom
// saved single; the Remove of a set you made that replaces the pair dialog's ✕.
// ---------------------------------------------------------------------------

describe('a pending Undo survives a later message that has no Undo of its own (RA-1)', () => {
  const custom = { routes: [{ role: 'main', scriptPath: ZULU }, { role: 'axis', axis: 'R1', scriptPath: AXIS }] };
  const entryJson = () => JSON.stringify(ds.get('library.associations')[VIDEO]);
  const undoText = () => dialogBody().querySelector('.video-options__live-undo-text');

  beforeEach(() => {
    ds.set('library.associations', { [VIDEO]: { active: 'custom', single: ZULU, multi: null, custom } });
  });

  async function unpairNow() {
    await open({ section: 'script' });
    panel('script').querySelector('[data-vo-focus="script:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.associations')[VIDEO]).toBeUndefined();
  }

  it('Copy path takes the line; the Unpair Undo stays beside its own words and restores the entry exactly', async () => {
    const before = entryJson();
    await unpairNow();
    railItem('file').click();
    panel('file').querySelector('[data-vo-focus="file:copy"]').click();
    await vi.waitFor(() => expect(liveText()).toBe(t('videoOptions.file.copied')));
    expect(undoButton().hidden).toBe(false);
    expect(undoText().hidden).toBe(false);
    expect(undoText().textContent).toBe(t('videoOptions.script.unpair.done', { name: 'Zulu Last.funscript' }));
    undoButton().click();
    expect(entryJson()).toBe(before);
    expect(undoButton().hidden).toBe(true);
    expect(undoText().hidden).toBe(true);
  });

  it('a VR pick and a Tags-section message leave it too; closing the dialog hands it to the toast', async () => {
    const before = entryJson();
    await unpairNow();
    railItem('vr').click();
    panel('vr').querySelector('[data-vo-focus="vr:vr"]').click();
    expect(undoButton().hidden).toBe(false);
    railItem('tags').click();
    tagsFake.ctx.announce('Got 7 tags from EroScripts (2 new).');
    expect(liveText()).toBe('Got 7 tags from EroScripts (2 new).');
    expect(undoButton().hidden).toBe(false);
    await closeAll();
    let toastUndo;
    await vi.waitFor(() => { toastUndo = document.querySelector('.video-options__toast-undo'); expect(toastUndo).toBeTruthy(); });
    toastUndo.click();
    expect(entryJson()).toBe(before);
  });

  it('a newer Undo takes its place (design (d): one Undo, the newest); once used, the older one comes back', async () => {
    const before = entryJson();
    await unpairNow();
    railItem('organise').click();
    panel('organise').querySelector('[data-vo-focus="playlist:p1"]').click();
    expect(liveText()).toBe(t('videoOptions.live.removedFrom', { name: 'Morning' }));
    expect(undoText().hidden).toBe(true);
    undoButton().click();
    expect(ds.getPlaylist('p1').videoPaths).toEqual([OTHER_A, VIDEO, OTHER_B]);
    expect(ds.get('library.associations')[VIDEO]).toBeUndefined();
    // follow-up (2026-11-18): the Unpair's Undo is offered again, with its words.
    expect(undoButton().hidden).toBe(false);
    expect(undoText().textContent).toBe(t('videoOptions.script.unpair.done', { name: 'Zulu Last.funscript' }));
    undoButton().click();
    expect(entryJson()).toBe(before);
    expect(undoButton().hidden).toBe(true);
  });
});

describe('the toast band (verify-1 cosmetic)', () => {
  it('body carries video-options-open from the render to the close, so toasts sit under the dialog', async () => {
    expect(document.body.classList.contains('video-options-open')).toBe(false);
    const { done } = await open();
    expect(document.body.classList.contains('video-options-open')).toBe(true);
    await closeAll();
    await done;
    expect(document.body.classList.contains('video-options-open')).toBe(false);
  });

  it('the live line is marked empty until it says something (a narrow dialog folds it away)', async () => {
    await open();
    const line = dialogBody().querySelector('.video-options__live');
    expect(line.classList.contains('video-options__live--empty')).toBe(true);
    panel('organise').querySelector('[data-vo-focus="playlist:p2"]').click();
    expect(line.classList.contains('video-options__live--empty')).toBe(false);
  });
});

describe('Tab wraps only through controls you can see (RA-3)', () => {
  it('Shift+Tab from the ✕ lands on the last visible control, and Tab from it wraps back to the ✕', async () => {
    await open();
    const closeBtn = document.querySelector('.modal-panel--video-options .modal-close-btn');
    const last = panel('organise').querySelector('[data-vo-focus="organise:newCategory"]');
    closeBtn.focus();
    expect(press(closeBtn, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(press(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn);
  });
});

describe('Alt with a navigation key stops at the dialog too (RA-4)', () => {
  it('Alt+Arrow / Alt+Home on a focused Play button never reaches the player behind', async () => {
    await open();
    const play = dialogBody().querySelector('.video-options__play');
    play.focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      press(play, key, { altKey: true });
    }
    expect(reached).toEqual([]);
    press(play, '1', { altKey: true, code: 'Digit1' });          // Alt+1/2/3 (views) still go on
    expect(reached).toEqual(['1']);
  });
});

describe('the status of your script while the video plays its own meanwhile (RA-7, R4-06)', () => {
  it('"Script not found" shows for YOUR script, the one the section names', async () => {
    Object.assign(video, { funscriptPath: OWN, _ownFunscriptPath: OWN, _assocFallbackFrom: ZULU });
    host.pathStatus = vi.fn(async (p) => (p === ZULU ? false : true));
    await open({ section: 'script' });
    await vi.waitFor(() => expect(panel('script').querySelector('.video-options__status--missing')).toBeTruthy());
    expect(host.pathStatus).toHaveBeenCalledWith(ZULU);
    expect(host.pathStatus).not.toHaveBeenCalledWith(OWN);
    expect(panel('script').querySelector('.video-options__name').textContent).toBe('Zulu Last.funscript');
  });
});

describe('Saved pairings: only what you made, and a set you made can be removed', () => {
  const slotNames = () => [...panel('script').querySelectorAll('.video-options__slot-name')].map((n) => n.textContent);

  it('a single slot a library refresh filled from the set\'s main is not listed as one you saved (verify-1)', async () => {
    const multi = { main: ZULU, axes: { twist: AXIS }, buttplugVib: false };
    ds.set('library.associations', { [VIDEO]: { active: 'multi', single: ZULU, multi, custom: null } });
    Object.assign(video, { _multiAxis: multi });
    await open({ section: 'script' });
    expect(slotNames()).toEqual([t('videoOptions.script.slot.multi', { count: 1 })]);
  });

  it('a Multi Axis set over the video\'s own script: Remove, a confirm that names it, then an exact Undo', async () => {
    const multi = { main: OWN, axes: { twist: AXIS }, buttplugVib: false };
    ds.set('library.associations', { [VIDEO]: { active: 'multi', single: OWN, multi, custom: null, main: OWN, axes: { twist: AXIS }, buttplugVib: false } });
    Object.assign(video, { funscriptPath: OWN, _ownFunscriptPath: OWN, _multiAxis: multi });
    const before = JSON.stringify(ds.get('library.associations')[VIDEO]);
    await open({ section: 'script' });
    expect(panel('script').querySelector('[data-vo-focus="script:unpair"]')).toBeNull();    // Dave R1 answer 2
    const remove = panel('script').querySelector('[data-vo-focus="script:removeSet:multi"]');
    expect(remove.getAttribute('aria-label')).toBe(t('videoOptions.script.removeSet.multiTitle'));
    remove.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    expect(overlays()[1].querySelector('.modal-message').textContent).toBe([
      t('videoOptions.script.removeSet.multiQuestion', { count: 1 }),
      t('videoOptions.script.unpair.nextOwn', { name: 'Square Clip.funscript' }),
    ].join('\n'));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.associations')[VIDEO]).toBeUndefined();
    expect(host.unpairApplied).toHaveBeenCalledTimes(1);
    expect(liveText()).toBe(t('videoOptions.script.removeSet.multiDone'));
    expect(document.activeElement).toBe(undoButton());
    undoButton().click();
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).toBe(before);
    expect(host.unpairUndone).toHaveBeenCalledWith(video, { kind: 'multi', config: multi }, { fallbackFrom: null });
    expect(liveText()).toBe(t('videoOptions.script.removeSet.multiUndone'));
  });

  it('a Custom Routing you saved beside the playing single goes alone; Cancel changes nothing', async () => {
    const custom = { routes: [{ role: 'main', scriptPath: ZULU }, { role: 'axis', axis: 'R1', scriptPath: AXIS }] };
    ds.set('library.associations', { [VIDEO]: { active: 'single', single: ZULU, multi: null, custom } });
    const before = JSON.stringify(ds.get('library.associations')[VIDEO]);
    await open({ section: 'script' });
    panel('script').querySelector('[data-vo-focus="script:removeSet:custom"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--secondary').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).toBe(before);
    expect(document.activeElement).toBe(panel('script').querySelector('[data-vo-focus="script:removeSet:custom"]'));

    panel('script').querySelector('[data-vo-focus="script:removeSet:custom"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    expect(overlays()[1].querySelector('.modal-message').textContent).toContain(t('videoOptions.script.removeSet.playsSame'));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.associations')[VIDEO]).toEqual({ active: 'single', single: ZULU, multi: null, custom: null });
    expect(host.unpairApplied).not.toHaveBeenCalled();                 // nothing that plays changed
    undoButton().click();
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).toBe(before);
    expect(host.unpairUndone).not.toHaveBeenCalled();
  });
});

// fixup-ui follow-up (2026-11-18). Dave: "Yes, add Remove" (a single script
// you saved gets one too), and the Remove and the Unpair cannot leave the
// pairing where neither Undo brings it back: the older Undo waits under the
// newer one. Also fixup-data's TODO: the header count reads an old
// EroScripts record (no scriptPath) as the Tags section does.
describe('Remove on a single script you saved, then Unpair: both undo, in turn', () => {
  const SAVED = 'C:\\Lib\\Scripts\\Saved Take.funscript';
  const custom = { routes: [{ role: 'main', scriptPath: ZULU }, { role: 'axis', axis: 'R1', scriptPath: AXIS }] };
  const undoText = () => dialogBody().querySelector('.video-options__live-undo-text');

  it('the saved single has a Remove (the playing set has Unpair); undo the Unpair, then the Remove: the first entry, exactly', async () => {
    ds.set('library.associations', { [VIDEO]: { active: 'custom', single: SAVED, multi: null, custom, mode: 'custom', routes: custom.routes } });
    Object.assign(video, { _customRouting: custom.routes });
    const first = JSON.stringify(ds.get('library.associations')[VIDEO]);
    await open({ section: 'script' });
    expect(panel('script').querySelector('[data-vo-focus="script:removeSet:custom"]')).toBeNull();
    const remove = panel('script').querySelector('[data-vo-focus="script:removeSet:single"]');
    expect(remove.getAttribute('aria-label')).toBe(t('videoOptions.script.removeSet.singleTitle'));
    remove.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    expect(overlays()[1].querySelector('.modal-message').textContent).toBe([
      t('videoOptions.script.removeSet.singleQuestion', { name: 'Saved Take.funscript' }),
      t('videoOptions.script.removeSet.playsSame'),
    ].join('\n'));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.associations')[VIDEO]).toMatchObject({ active: 'custom', single: null, custom });
    expect(host.unpairApplied).not.toHaveBeenCalled();
    expect(liveText()).toBe(t('videoOptions.script.removeSet.singleDone', { name: 'Saved Take.funscript' }));

    panel('script').querySelector('[data-vo-focus="script:unpair"]').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    overlays()[1].querySelector('.modal-btn--danger').click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    expect(ds.get('library.associations')[VIDEO]).toBeUndefined();

    undoButton().click();                                            // the Unpair's
    expect(ds.get('library.associations')[VIDEO]).toMatchObject({ active: 'custom', single: null, custom });
    expect(undoButton().hidden).toBe(false);                         // the Remove's, back
    expect(undoText().textContent).toBe(t('videoOptions.script.removeSet.singleDone', { name: 'Saved Take.funscript' }));
    undoButton().click();
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).toBe(first);
    expect(liveText()).toBe(t('videoOptions.script.removeSet.singleUndone', { name: 'Saved Take.funscript' }));
    expect(undoButton().hidden).toBe(true);
  });
});

describe('the header tag count reads an old EroScripts record as the Tags section does', () => {
  const OLD_RECORD = { topicId: 880001, tags: ['pov', 'kitchen'] };       // before record v2: no scriptPath
  const railCount = () => railItem('tags').querySelector('.video-options__rail-count');

  it('on a video with NO script it counts none of them', async () => {
    ds = makeDataService({ associations: {}, library: { scriptTags: { [VIDEO]: OLD_RECORD } } });
    host = makeHost();
    Object.assign(video, { hasFunscript: false, funscriptPath: null, _manualAssociation: false, _ownFunscriptPath: null });
    await open();
    expect(railCount().hidden).toBe(true);
  });

  it('control: on the video\'s own same-name script (the one that download saved) it counts them', async () => {
    ds = makeDataService({ associations: {}, library: { scriptTags: { [VIDEO]: OLD_RECORD } } });
    host = makeHost();
    Object.assign(video, { hasFunscript: true, funscriptPath: OWN, _manualAssociation: false, _ownFunscriptPath: OWN });
    await open();
    expect(railCount().hidden).toBe(false);
    expect(railCount().textContent).toBe('2');
  });
});

// followUp3 (Dave, 2026-11-18): "Script not found" opens the file picker
// "to where the path says it should be" and the file picked replaces only
// that path, with an exact Undo; variations say it too and are not offered
// to play first while missing; the header says it.
describe('Locate a script that is not found', () => {
  const NEW = 'C:\\Lib\\Found\\Zulu Moved.funscript';
  const SOFT = 'C:\\Lib\\Scripts\\Zulu Soft.funscript';
  const locate = () => panel('script').querySelector('[data-vo-focus="script:locate"]');

  beforeEach(() => {
    host.pathStatus = vi.fn(async (p) => (p === ZULU || p === SOFT ? false : true));
    host.locateScript = vi.fn(async () => NEW);
    host.pairingChanged = vi.fn();
  });

  it('"Script not found" is the Locate control: the picker opens at the stored path; the file picked replaces only that slot; Undo exact', async () => {
    const custom = { routes: [{ role: 'main', scriptPath: AXIS }] };
    ds.set('library.associations', { [VIDEO]: { active: 'single', single: ZULU, multi: null, custom } });
    const before = JSON.stringify(ds.get('library.associations')[VIDEO]);
    await open({ section: 'script' });
    await vi.waitFor(() => expect(locate()).toBeTruthy());
    expect(locate().textContent).toBe(t('videoOptions.script.status.missing'));
    expect(locate().getAttribute('aria-label')).toBe(t('videoOptions.script.locate.aria', { name: 'Zulu Last.funscript' }));
    locate().click();
    await vi.waitFor(() => expect(host.pairingChanged).toHaveBeenCalledTimes(1));
    expect(host.locateScript).toHaveBeenCalledWith(ZULU);
    expect(ds.get('library.associations')[VIDEO]).toEqual({ active: 'single', single: NEW, multi: null, custom });
    expect(host.pairingChanged).toHaveBeenCalledWith(video, { kind: 'single', config: NEW });
    expect(liveText()).toBe(t('videoOptions.script.locate.done', { name: 'Zulu Last.funscript', newName: 'Zulu Moved.funscript' }));
    undoButton().click();
    expect(JSON.stringify(ds.get('library.associations')[VIDEO])).toBe(before);
    expect(host.pairingChanged).toHaveBeenLastCalledWith(video, { kind: 'single', config: ZULU });
  });

  it('Cancel in the picker changes nothing; the focus comes back to the control', async () => {
    host.locateScript = vi.fn(async () => null);
    const before = JSON.stringify(ds.get('library.associations'));
    await open({ section: 'script' });
    await vi.waitFor(() => expect(locate()).toBeTruthy());
    locate().click();
    await vi.waitFor(() => expect(host.locateScript).toHaveBeenCalledTimes(1));
    await flush();
    expect(JSON.stringify(ds.get('library.associations'))).toBe(before);
    expect(host.pairingChanged).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(locate());
  });

  it('opened for the card\'s red badge (focusKey script:locate), the focus lands on it once the status answers', async () => {
    await open({ section: 'script', focusKey: 'script:locate' });
    await vi.waitFor(() => expect(document.activeElement).toBe(locate()));
  });

  it('the header says "Script not found", not "Chosen by you · Avg …"', async () => {
    Object.assign(video, { avgSpeed: 450, maxSpeed: 500 });
    await open();
    const line = () => dialogBody().querySelector('.video-options__facts-line').textContent;
    await vi.waitFor(() => expect(line()).toContain(t('videoOptions.script.status.missing')));
    expect(line()).not.toContain(t('videoOptions.script.pairing.single'));
    expect(line()).not.toContain('450');
  });

  it('a variation you added that is not found: not offered to play first, and Locate replaces only its path', async () => {
    const variants = { [VIDEO]: [{ label: 'Soft', path: SOFT, name: 'Zulu Soft.funscript' }] };
    ds.set('library.manualVariants', JSON.parse(JSON.stringify(variants)));
    host.pathStatus = vi.fn(async (p) => (p === SOFT ? false : true));
    await open({ section: 'script' });
    // By dataset, not a selector: a path's backslashes are escapes in CSS.
    const focusOf = (key) => [...panel('script').querySelectorAll('[data-vo-focus]')].find((n) => n.dataset.voFocus === key) || null;
    const vLocate = () => focusOf(`variation-locate:${SOFT}`);
    await vi.waitFor(() => expect(vLocate()).toBeTruthy());
    expect(focusOf(`variation:${SOFT}`).disabled).toBe(true);
    expect(locate()).toBeNull();                                         // the main script is there
    vLocate().click();
    await vi.waitFor(() => expect(ds.get('library.manualVariants')[VIDEO][0].path).toBe(NEW));
    expect(host.locateScript).toHaveBeenCalledWith(SOFT);
    expect(ds.get('library.manualVariants')[VIDEO]).toEqual([{ label: 'Soft', path: NEW, name: 'Zulu Moved.funscript' }]);
    expect(host.pairingChanged).not.toHaveBeenCalled();
    undoButton().click();
    expect(ds.get('library.manualVariants')).toEqual(variants);
  });
});
