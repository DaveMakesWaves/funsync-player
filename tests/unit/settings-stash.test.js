/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds its Sources area (with the Stash block) as DOM, DataService reads
 * localStorage, and i18n.js / settings-panel.js branch on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Settings > Sources > Stash (Stash S1, Round 2 stage s1-2b-settings,
// 2026-11-18; notes/features/DESIGN-stash-s1.md (f) "Settings > Stash", (d),
// (e), and Dave's answers at its end): a "Stash" block at the bottom of
// Sources (not a rail item) with Address, API key (masked, never shown back,
// a plain-text note where the key is saved unencrypted), Test connection,
// Link Stash, the certificate trust step and its pin, Sync now with progress
// and Cancel, Sync on start, the Need-a-check list, path rules, Turn off /
// on, and Remove Stash data… with Undo.
//
// The REAL SettingsPanel over the REAL DataService and store.js defaults; a
// fake window.funsync speaks s1-2a-main's IPC contract (stashStatus,
// stashTest, stashLink, stashSetOptions, stashSync, stashCancel,
// onStashProgress, stashGetData, onStashChanged, onStashSettingsChanged,
// stashRemoveKey, stashRemoveData, stashUndo, stashTrustCertificate,
// stashForgetCertificate). Expected words come from t(), so the checks hold
// before and after the Round 2 strings merge.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { DataService } from '../../renderer/js/data-service.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';
import {
  STASH_IPC, CHECK_ROWS_SHOWN, REMOVE_UNDO_MS, stashErrorText, normalizeStashStatus, stashOrigin,
} from '../../renderer/components/settings-stash.js';

let diskFile = null;
class MockConf {
  constructor({ defaults }) {
    const file = diskFile ? JSON.parse(JSON.stringify(diskFile)) : {};
    this._data = { ...JSON.parse(JSON.stringify(defaults)), ...file };
  }
  get(p) {
    let v = this._data;
    for (const k of p.split('.')) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[k];
    }
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  set(p, value) {
    const keys = p.split('.');
    let o = this._data;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
    o[keys.at(-1)] = JSON.parse(JSON.stringify(value));
  }
}
vi.mock('electron-conf', () => ({ default: MockConf }));
const store = await import('../../electron/store.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

const SAMPLE_KEY = 'sample-stash-key-0123456789abcdef';
const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A fake main process for the Stash IPC (s1-2a-main's contract). */
function fakeMain() {
  const listeners = { progress: new Set(), changed: new Set(), settings: new Set() };
  const state = {
    key: { hasKey: false, keyStorage: null, saveStorage: 'safeStorage', plainReason: null, unreadable: false },
    keyTravelsInClear: false,
    library: { state: 'empty', rev: 0, damaged: null, writable: true, server: null, lastSync: null, counts: { links: 0, check: 0, refused: 0, scenes: 0 } },
    sync: { running: false, kind: null, progress: null },
    data: { v: 1, rev: 0, server: null, lastSync: null, links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {} },
    testReply: { ok: true, address: 'http://127.0.0.1:9999', version: 'v0.32.0', sceneCount: 9, keyTravelsInClear: false },
    syncResolve: null,
  };
  const settingsBlock = () => clone(store.getSetting('stash'));
  const saveSettings = (patch) => { store.setSetting('stash', { ...store.getSetting('stash'), ...patch }); return settingsBlock(); };
  const api = {
    stashStatus: vi.fn(async () => ({
      ok: true, settings: settingsBlock(), key: clone(state.key), keyTravelsInClear: state.keyTravelsInClear,
      library: clone(state.library), sync: clone(state.sync),
    })),
    stashGetData: vi.fn(async () => clone(state.data)),
    stashTest: vi.fn(async () => clone(state.testReply)),
    stashLink: vi.fn(async ({ address, apiKey } = {}) => {
      if (state.testReply.ok !== true) return clone(state.testReply);
      if (typeof apiKey === 'string' && apiKey) state.key = { ...state.key, hasKey: true, keyStorage: state.key.saveStorage };
      const settings = saveSettings({ url: state.testReply.address || address, enabled: true });
      return { ok: true, settings, key: clone(state.key), version: state.testReply.version, sceneCount: state.testReply.sceneCount };
    }),
    stashSetOptions: vi.fn(async (opts) => ({ ok: true, settings: saveSettings(opts) })),
    stashSync: vi.fn(() => new Promise((resolve) => { state.syncResolve = resolve; })),
    stashCancel: vi.fn(async () => ({ ok: true, cancelled: true })),
    onStashProgress: (cb) => { listeners.progress.add(cb); return () => listeners.progress.delete(cb); },
    onStashChanged: (cb) => { listeners.changed.add(cb); return () => listeners.changed.delete(cb); },
    onStashSettingsChanged: (cb) => { listeners.settings.add(cb); return () => listeners.settings.delete(cb); },
    stashRemoveKey: vi.fn(async () => {
      state.key = { ...state.key, hasKey: false, keyStorage: null, unreadable: false };
      return { ok: true, ...clone(state.key) };
    }),
    stashRemoveData: vi.fn(async () => ({ ok: true, undoId: 'undo-remove-1', undoMs: 8000 })),
    stashUndo: vi.fn(async (id) => ({ ok: id === 'undo-remove-1' })),
    stashTrustCertificate: vi.fn(async ({ address, fingerprint256 }) => ({
      ok: true,
      settings: saveSettings({ trustedCert: { origin: new URL(address).origin, sha256: fingerprint256, subject: 'CN=nas.local', at: 1 } }),
    })),
    stashForgetCertificate: vi.fn(async () => ({ ok: true, settings: saveSettings({ trustedCert: null }) })),
  };
  const progress = (p) => { for (const cb of [...listeners.progress]) cb(p); };
  return { api, state, listeners, progress };
}

let main;
let setSetting;
let showing = null;

async function boot(file = null) {
  diskFile = file;
  await store.initStore();
  main = fakeMain();
  setSetting = vi.fn((p, value) => store.setSetting(p, value));
  window.funsync = {
    getAllData: async () => store.getAll(),
    setSetting,
    onGlobalShortcut: () => {},
    setGlobalShortcuts: async () => [],
    ...main.api,
  };
  const settings = new DataService();
  await settings.init();
  return settings;
}

/** Let the block's status / data reads (and any chained awaits) finish. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

async function openSettings(settings, opts = {}) {
  const panel = new SettingsPanel({ settings, ...opts });
  showing = panel.show();
  await settle();
  // The dialog gives its first focus a frame after it opens (Modal:
  // requestAnimationFrame). Wait for that frame: when it came later, it took
  // the focus away from whatever the test had just focused. On Windows the
  // settle above (coarse 15 ms timers) happened to outlast a frame; on Linux
  // (1 ms timers) it did not, and CI's ubuntu job failed on the focus
  // assertions (v0.10.0 tag, 2026-11-20).
  await new Promise((r) => requestAnimationFrame(() => r()));
  await settle();
  return panel;
}

const $ = (sel) => document.querySelector(sel);
const block = () => $('#sp-sec-stash');
const byFocus = (key) => block()?.querySelector(`[data-stash-focus="${key}"]`) || null;
const live = () => block().querySelector('.stash-settings__live-text').textContent;
const visible = (node) => !!node && !node.hidden && !node.closest('[hidden]');

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A user's press: the button takes the focus, then the click. */
async function press(node) {
  node.focus();
  node.click();
  await settle();
}

/** The confirm dialog stacked on Settings: its danger (confirm) or Cancel button. */
async function answerConfirm(yes) {
  await settle();
  const overlays = [...document.querySelectorAll('.modal-overlay')];
  const top = overlays.at(-1);
  const btn = yes ? top.querySelector('.modal-btn--danger') : top.querySelector('.modal-btn--secondary');
  btn.click();
  await settle();
}

async function linkedSettings(file = {}, setup = () => {}) {
  const settings = await boot({ settings: { stash: { enabled: true, url: 'http://127.0.0.1:9999', syncOnStart: false, pathRules: [], ...file } } });
  main.state.key = { hasKey: true, keyStorage: 'safeStorage', saveStorage: 'safeStorage', plainReason: null, unreadable: false };
  main.state.library.server = { url: 'http://127.0.0.1:9999', version: 'v0.32.0' };
  setup(main.state);
  return settings;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="toast-container"></div>';
  localStorage.clear();
  _setBundlesForTests('en', EN, EN);
});

afterEach(async () => {
  vi.useRealTimers();
  // Close Settings (and any confirm left on top) so its listeners are released.
  for (const o of [...document.querySelectorAll('.modal-overlay')].reverse()) {
    o.querySelector('.modal-close-btn')?.click();
  }
  if (showing) await showing;
  showing = null;
});

// ---------------------------------------------------------------------------

describe('where it is: a block at the bottom of Settings > Sources (Dave: not a rail item)', () => {
  it('fresh install: the block sits after the source buttons, with its heading and intro; no rail item', async () => {
    await openSettings(await boot());
    const sources = $('#settings-tabpanel-sources');
    expect(block()).not.toBeNull();
    expect(block().parentElement).toBe(sources);
    expect(sources.lastElementChild).toBe(block());
    expect(block().previousElementSibling.classList.contains('settings-panel__source-buttons')).toBe(true);
    expect(block().getAttribute('aria-labelledby')).toBe('sp-stash-title');
    expect($('#sp-stash-title').textContent).toBe(t('settingsPanel.stash.header'));
    expect(block().querySelector('.stash-settings__intro').textContent).toBe(t('settingsPanel.stash.intro'));
    const rail = [...document.querySelectorAll('.settings-panel__rail-item')].map((b) => b.dataset.area);
    expect(rail).not.toContain('stash');
  });

  it('opening Settings asks main for the status and the data only: nothing goes to Stash', async () => {
    await openSettings(await linkedSettings());
    expect(main.api.stashStatus).toHaveBeenCalled();
    expect(main.api.stashGetData).toHaveBeenCalled();
    for (const name of ['stashTest', 'stashLink', 'stashSync', 'stashSetOptions', 'stashRemoveData', 'stashTrustCertificate']) {
      expect(main.api[name], name).not.toHaveBeenCalled();
    }
  });

  it('a window.funsync without the Stash calls (an older preload) still renders the set-up form', async () => {
    const settings = await boot();
    for (const name of Object.values(STASH_IPC)) delete window.funsync[name];
    await openSettings(settings);
    expect($('#sp-stash-address')).not.toBeNull();
    expect($('#sp-stash-key')).not.toBeNull();
  });
});

describe('set up: Address, API key, Test connection, Link Stash', () => {
  it('the fields: labelled; the address empty with 127.0.0.1:9999 as placeholder; the key masked, no autofill, no spellcheck', async () => {
    await openSettings(await boot());
    const addr = $('#sp-stash-address');
    const key = $('#sp-stash-key');
    expect($('label[for="sp-stash-address"]').textContent).toBe(t('settingsPanel.stash.addressLabel'));
    expect($('label[for="sp-stash-key"]').textContent).toBe(t('settingsPanel.stash.keyLabel'));
    expect(addr.value).toBe('');
    expect(addr.placeholder).toBe('http://127.0.0.1:9999');
    expect(key.type).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('off');
    expect(key.spellcheck).toBe(false);
    expect(key.getAttribute('aria-describedby').split(' ')).toContain('sp-stash-key-hint');
    expect($('#sp-stash-key-hint').textContent).toBe(t('settingsPanel.stash.keyHint'));
  });

  it("Dave's help line: keep Stash on 127.0.0.1, or set a password", async () => {
    await openSettings(await boot());
    expect($('#sp-stash-help').textContent).toBe(t('settingsPanel.stash.help'));
    expect(visible($('#sp-stash-help'))).toBe(true);
  });

  it('Link Stash waits for a good Test of exactly what is typed; editing the address afterwards needs a new Test', async () => {
    await openSettings(await boot());
    const link = byFocus('link');
    expect(link.disabled).toBe(true);
    expect(link.getAttribute('aria-describedby')).toBe('sp-stash-link-hint');
    expect(visible($('#sp-stash-link-hint'))).toBe(true);

    type($('#sp-stash-address'), 'http://127.0.0.1:9999');
    main.state.testReply = { ok: false, code: 'unreachable' };
    await press(byFocus('test'));
    expect(link.disabled).toBe(true);

    main.state.testReply = { ok: true, address: 'http://127.0.0.1:9999', version: 'v0.32.0', sceneCount: 9 };
    await press(byFocus('test'));
    expect(link.disabled).toBe(false);
    expect(visible($('#sp-stash-link-hint'))).toBe(false);

    type($('#sp-stash-address'), 'http://127.0.0.1:9998');
    expect(link.disabled).toBe(true);
    expect(block().querySelector('.stash-settings__result').textContent).toBe('');
  });

  it('a good Test says the version and the scene count in a polite status line, and keeps the focus where it was', async () => {
    await openSettings(await boot());
    type($('#sp-stash-address'), 'http://127.0.0.1:9999');
    const test = byFocus('test');
    test.focus();
    await press(test);
    const result = block().querySelector('.stash-settings__result');
    expect(result.getAttribute('role')).toBe('status');
    expect(result.getAttribute('aria-live')).toBe('polite');
    expect(result.textContent).toBe(t('settingsPanel.stash.connected', { version: 'v0.32.0', count: 9 }));
    expect(document.activeElement).toBe(test);
    expect(main.api.stashTest).toHaveBeenCalledWith({ address: 'http://127.0.0.1:9999' });
  });

  it('every failure has its own words (design (e)), with the address where the words name it', async () => {
    await openSettings(await boot());
    type($('#sp-stash-address'), 'http://127.0.0.1:9999');
    const replies = {
      unreachable: { ok: false, code: 'unreachable' },
      timeout: { ok: false, code: 'timeout' },
      badKey: { ok: false, code: 'badKey', status: 401 },
      needsKey: { ok: false, code: 'needsKey', status: 401 },
      forbidden: { ok: false, code: 'forbidden', status: 403 },
      tooOld: { ok: false, code: 'tooOld', version: 'v0.25.1', minVersion: '0.27.0' },
      notStash: { ok: false, code: 'notStash' },
      redirect: { ok: false, code: 'redirect' },
      certificate: { ok: false, code: 'certificate' },
      http: { ok: false, code: 'http', status: 500 },
    };
    const seen = new Map();
    for (const [code, reply] of Object.entries(replies)) {
      main.state.testReply = reply;
      await press(byFocus('test'));
      seen.set(code, block().querySelector('.stash-settings__result').textContent);
    }
    expect(seen.get('unreachable')).toBe(t('stash.error.unreachable', { address: 'http://127.0.0.1:9999' }));
    expect(seen.get('tooOld')).toBe(t('stash.error.tooOld', { version: 'v0.25.1', minVersion: '0.27.0' }));
    expect(seen.get('http')).toBe(t('stash.error.http', { status: '500' }));
    for (const code of ['timeout', 'badKey', 'needsKey', 'forbidden', 'notStash', 'redirect', 'certificate']) {
      expect(seen.get(code), code).toBe(t(`stash.error.${code}`));
    }
    expect(new Set(seen.values()).size).toBe(Object.keys(replies).length);
  });

  it('the error words are the shared stash.error.* strings: unknownQuery reads as badInput, a missing version as tooOldNoVersion', () => {
    _setBundlesForTests('en', EN, EN);
    expect(stashErrorText({ code: 'unknownQuery' })).toBe(t('stash.error.badInput'));
    expect(stashErrorText({ code: 'tooOld' })).toBe(t('stash.error.tooOldNoVersion', { minVersion: '0.27.0' }));
    expect(stashErrorText({ ok: false, error: { code: 'busy' } })).toBe(t('settingsPanel.stash.errorBusy'));
    expect(stashErrorText({ code: 'notLinked' })).toBe(t('settingsPanel.stash.errorNotLinked'));
  });

  it('the key goes to main only when typed: an empty field sends no apiKey (main then uses the saved key)', async () => {
    await openSettings(await boot());
    type($('#sp-stash-address'), 'http://192.168.1.20:9999');
    await press(byFocus('test'));
    expect(main.api.stashTest).toHaveBeenLastCalledWith({ address: 'http://192.168.1.20:9999' });
    expect(Object.hasOwn(main.api.stashTest.mock.calls.at(-1)[0], 'apiKey')).toBe(false);
    type($('#sp-stash-key'), SAMPLE_KEY);
    await press(byFocus('test'));
    expect(main.api.stashTest).toHaveBeenLastCalledWith({ address: 'http://192.168.1.20:9999', apiKey: SAMPLE_KEY });
  });

  it('Link: main saves the address (the renderer never writes stash.url itself); the key is gone from the page; the linked view opens on Sync now', async () => {
    const settings = await boot();
    await openSettings(settings);
    type($('#sp-stash-address'), ' http://127.0.0.1:9999 ');
    type($('#sp-stash-key'), SAMPLE_KEY);
    await press(byFocus('test'));
    byFocus('link').focus();
    await press(byFocus('link'));

    expect(main.api.stashLink).toHaveBeenCalledWith({ address: 'http://127.0.0.1:9999', apiKey: SAMPLE_KEY });
    expect(settings.get('stash.url')).toBe('http://127.0.0.1:9999');
    expect(settings.get('stash.enabled')).toBe(true);
    expect(setSetting.mock.calls.filter(([p]) => p === 'stash' || String(p).startsWith('stash.'))).toEqual([]);

    expect(block().querySelector('.stash-settings__linked-text').textContent)
      .toBe(t('settingsPanel.stash.linkedVersion', { address: 'http://127.0.0.1:9999', version: 'v0.32.0' }));
    expect(block().querySelector('.stash-settings__key-text').textContent).toBe(t('settingsPanel.stash.keySavedEncrypted'));
    expect(live()).toBe(t('settingsPanel.stash.linkedDone'));
    expect(document.activeElement).toBe(byFocus('sync'));
    // Never shown back: not in any field, text or attribute.
    expect(document.body.innerHTML).not.toContain(SAMPLE_KEY);
    for (const input of document.querySelectorAll('input')) expect(input.value).not.toBe(SAMPLE_KEY);
    // Nothing was read from Stash yet.
    expect(main.api.stashSync).not.toHaveBeenCalled();
  });

  it('a failed Link keeps the set-up form and says why', async () => {
    await openSettings(await boot());
    type($('#sp-stash-address'), 'http://127.0.0.1:9999');
    await press(byFocus('test'));
    main.state.testReply = { ok: false, code: 'unreachable' };
    await press(byFocus('link'));
    expect($('#sp-stash-address')).not.toBeNull();
    expect(block().querySelector('.stash-settings__result').textContent)
      .toBe(t('stash.error.unreachable', { address: 'http://127.0.0.1:9999' }));
  });

  it('http to another PC with a key: the "travels unencrypted" warning names the host', async () => {
    await openSettings(await boot());
    type($('#sp-stash-address'), 'http://192.168.1.20:9999');
    type($('#sp-stash-key'), SAMPLE_KEY);
    main.state.testReply = { ok: true, address: 'http://192.168.1.20:9999', version: 'v0.32.0', sceneCount: 1, keyTravelsInClear: true };
    await press(byFocus('test'));
    const warn = [...block().querySelectorAll('.stash-settings__note--warn')].find(visible);
    expect(warn.textContent).toBe(t('settingsPanel.stash.keyInClear', { host: '192.168.1.20' }));
  });
});

describe('the API key: plain text where it cannot be encrypted, with a note next to the field (Dave)', () => {
  it.each([
    ['portable', 'settingsPanel.stash.keyNotePortable'],
    ['noEncryption', 'settingsPanel.stash.keyNoteNoEncryption'],
    [null, 'settingsPanel.stash.keyNotePlain'],
  ])('saveStorage plain (%s): the note is next to the field and describes it', async (plainReason, key) => {
    const settings = await boot();
    main.state.key = { hasKey: false, keyStorage: null, saveStorage: 'plain', plainReason, unreadable: false };
    await openSettings(settings);
    const note = $('#sp-stash-key-note');
    expect(visible(note)).toBe(true);
    expect(note.textContent).toBe(t(key));
    expect($('#sp-stash-key').getAttribute('aria-describedby').split(' ')).toContain('sp-stash-key-note');
  });

  it('encrypted (safeStorage): no note', async () => {
    await openSettings(await boot());
    expect(visible($('#sp-stash-key-note'))).toBe(false);
  });

  it('a saved plain key says so on its line; an encrypted one says encrypted', async () => {
    await openSettings(await linkedSettings({}, (s) => {
      s.key = { hasKey: true, keyStorage: 'plain', saveStorage: 'plain', plainReason: 'portable', unreadable: false };
    }));
    expect(block().querySelector('.stash-settings__key-text').textContent).toBe(t('settingsPanel.stash.keySavedPlain'));
  });

  it('an unreadable key file asks for the key again', async () => {
    await openSettings(await linkedSettings({}, (s) => {
      s.key = { hasKey: false, keyStorage: null, saveStorage: 'safeStorage', plainReason: null, unreadable: true };
    }));
    expect(block().querySelector('.stash-settings__key-text').textContent).toBe(t('stash.error.keyUnreadable'));
  });

  it('Remove key: asks first, then main forgets it; focus lands on Add key', async () => {
    await openSettings(await linkedSettings());
    byFocus('key-remove').focus();
    byFocus('key-remove').click();
    await answerConfirm(false);
    expect(main.api.stashRemoveKey).not.toHaveBeenCalled();
    byFocus('key-remove').click();
    await answerConfirm(true);
    expect(main.api.stashRemoveKey).toHaveBeenCalledTimes(1);
    expect(block().querySelector('.stash-settings__key-text').textContent).toBe(t('settingsPanel.stash.noKey'));
    expect(live()).toBe(t('settingsPanel.stash.keyRemoved'));
    expect(document.activeElement).toBe(byFocus('key-add'));
  });

  it('Replace opens the fields on the key, with the old address; Cancel goes back unchanged', async () => {
    await openSettings(await linkedSettings());
    await press(byFocus('key-replace'));
    expect($('#sp-stash-address').value).toBe('http://127.0.0.1:9999');
    expect(visible($('#sp-stash-key'))).toBe(true);
    expect($('#sp-stash-key').value).toBe('');
    expect(document.activeElement).toBe($('#sp-stash-key'));
    await press(byFocus('change-cancel'));
    expect(block().querySelector('.stash-settings__linked-text')).not.toBeNull();
    expect(document.activeElement).toBe(byFocus('change'));
  });
});

describe('Trust this certificate (Dave, after Round 1)', () => {
  const CERT = { origin: 'https://nas.local:9999', fingerprint256: FP, subject: { CN: 'nas.local', O: '<img src=x onerror=alert(1)>' }, pinMismatch: false };

  it('Test meets an untrusted certificate: its fingerprint and subject (as text) and a Trust button that pins it for that address, then Tests again', async () => {
    await openSettings(await boot());
    type($('#sp-stash-address'), 'https://nas.local:9999');
    main.state.testReply = { ok: false, code: 'certificate', certificate: CERT };
    await press(byFocus('test'));
    const box = block().querySelector('.stash-settings__cert');
    expect(box).not.toBeNull();
    expect(box.querySelector('.stash-settings__fingerprint').textContent).toBe(FP);
    expect(box.querySelector('.stash-settings__cert-subject').textContent).toBe('CN=nas.local, O=<img src=x onerror=alert(1)>');
    expect(box.querySelector('img')).toBeNull();
    expect(byFocus('cert-trust').textContent).toBe(t('settingsPanel.stash.certTrust'));

    main.state.testReply = { ok: true, address: 'https://nas.local:9999', version: 'v0.32.0', sceneCount: 3 };
    byFocus('cert-trust').focus();
    await press(byFocus('cert-trust'));
    expect(main.api.stashTrustCertificate).toHaveBeenCalledWith({ address: 'https://nas.local:9999', fingerprint256: FP });
    expect(main.api.stashTest).toHaveBeenCalledTimes(2);
    expect(block().querySelector('.stash-settings__cert')).toBeNull();
    expect(block().querySelector('.stash-settings__result').textContent).toBe(t('settingsPanel.stash.connected', { version: 'v0.32.0', count: 3 }));
    expect(document.activeElement).toBe(byFocus('test'));
    // The pin shows, for this address.
    expect(block().querySelector('.stash-settings__pin .stash-settings__fingerprint').textContent).toBe(FP);
  });

  it('the pin shows only for its own address, and Stop trusting removes it', async () => {
    const settings = await boot({ settings: { stash: { enabled: false, url: '', syncOnStart: false, pathRules: [], trustedCert: { origin: 'https://nas.local:9999', sha256: FP, subject: 'CN=nas.local', at: 1 } } } });
    await openSettings(settings);
    type($('#sp-stash-address'), 'http://127.0.0.1:9999');
    expect(block().querySelector('.stash-settings__pin')).toBeNull();
    type($('#sp-stash-address'), 'https://nas.local:9999/stash');
    const pin = block().querySelector('.stash-settings__pin');
    expect(pin).not.toBeNull();
    expect(pin.querySelector('.stash-settings__pin-subject').textContent).toBe('CN=nas.local');
    expect(byFocus('cert-forget').getAttribute('aria-label')).toBe(t('settingsPanel.stash.certForgetAria', { address: 'https://nas.local:9999' }));
    await press(byFocus('cert-forget'));
    expect(main.api.stashForgetCertificate).toHaveBeenCalledTimes(1);
    expect(block().querySelector('.stash-settings__pin')).toBeNull();
    expect(settings.get('stash.trustedCert')).toBeNull();
    expect(live()).toBe(t('settingsPanel.stash.certForgotten'));
  });

  it('a changed certificate at a pinned address shows the trust step again, saying it changed', async () => {
    const settings = await boot({ settings: { stash: { enabled: false, url: '', syncOnStart: false, pathRules: [], trustedCert: { origin: 'https://nas.local:9999', sha256: 'OLD', subject: 'CN=nas.local', at: 1 } } } });
    await openSettings(settings);
    type($('#sp-stash-address'), 'https://nas.local:9999');
    main.state.testReply = { ok: false, code: 'certificate', certificate: { ...CERT, pinMismatch: true } };
    await press(byFocus('test'));
    expect(block().querySelector('.stash-settings__cert-title').textContent).toBe(t('settingsPanel.stash.certChanged'));
  });

  it('a sync that meets an untrusted certificate offers the same trust step in the linked view', async () => {
    await openSettings(await linkedSettings({ url: 'https://nas.local:9999' }, (s) => { s.library.server = { url: 'https://nas.local:9999', version: 'v0.32.0' }; }));
    await press(byFocus('sync'));
    main.state.syncResolve({ ok: false, kind: 'full', written: false, partial: true, cancelled: false, error: { code: 'certificate', certificate: CERT } });
    await settle();
    expect(live()).toBe(t('settingsPanel.stash.syncFailed', { reason: t('stash.error.certificate') }));
    expect(block().querySelector('.stash-settings__cert .stash-settings__fingerprint').textContent).toBe(FP);
    await press(byFocus('cert-trust'));
    expect(main.api.stashTrustCertificate).toHaveBeenCalledWith({ address: 'https://nas.local:9999', fingerprint256: FP });
  });

  it('stashOrigin: scheme, host and port only (a pin is per origin)', () => {
    expect(stashOrigin('https://NAS.local:9999/stash/')).toBe('https://nas.local:9999');
    expect(stashOrigin('ftp://x')).toBe('');
    expect(stashOrigin('not an address')).toBe('');
  });
});

describe('linked: Sync now, its progress and Cancel', () => {
  it('Sync now sends the library videos (path, size, modified time) and nothing else', async () => {
    const videos = [
      { path: 'C:/lib/a.mp4', size: 100, dateAdded: 1700000000000, name: 'a.mp4', funscriptPath: 'C:/lib/a.funscript' },
      { path: 'C:/lib/b.mp4', size: 200, mtimeMs: 1700000000001 },
      { name: 'no path' },
    ];
    await openSettings(await linkedSettings(), { getStashVideos: () => videos });
    await press(byFocus('sync'));
    expect(main.api.stashSync).toHaveBeenCalledWith({
      videos: [
        { path: 'C:/lib/a.mp4', size: 100, mtimeMs: 1700000000000 },
        { path: 'C:/lib/b.mp4', size: 200, mtimeMs: 1700000000001 },
      ],
    });
  });

  it('progress: a labelled <progress> with the step in words; Cancel takes the focus from Sync now and keeps it; the result goes in the polite line', async () => {
    await openSettings(await linkedSettings());
    const sync = byFocus('sync');
    sync.focus();
    await press(sync);
    const cancel = byFocus('sync-cancel');
    expect(visible(cancel)).toBe(true);
    expect(visible(sync)).toBe(false);
    expect(document.activeElement).toBe(cancel);
    const bar = $('#sp-stash-progress');
    expect(bar.tagName).toBe('PROGRESS');
    expect($('#' + bar.getAttribute('aria-labelledby')).textContent).toBe(t('settingsPanel.stash.progressLabel'));
    expect(bar.getAttribute('aria-describedby')).toBe('sp-stash-step');

    main.progress({ kind: 'full', step: 'hash', done: 312, total: 1546 });
    expect(bar.value).toBe(312);
    expect(bar.max).toBe(1546);
    expect($('#sp-stash-step').textContent).toBe(t('settingsPanel.stash.stepHash', { done: 312, total: 1546 }));
    main.progress({ kind: 'full', step: 'list', done: 2, total: 4 });
    expect($('#sp-stash-step').textContent).toBe(t('settingsPanel.stash.stepList', { done: 2, total: 4 }));
    main.progress({ kind: 'full', step: 'details', done: 150, total: 1204 });
    expect($('#sp-stash-step').textContent).toBe(t('settingsPanel.stash.stepDetails', { done: 150, total: 1204 }));
    // "Sync this video" belongs to the dialog.
    main.progress({ kind: 'video', step: 'list', done: 0, total: 1 });
    expect($('#sp-stash-step').textContent).toBe(t('settingsPanel.stash.stepDetails', { done: 150, total: 1204 }));
    // While it runs: no Change…, Turn off or Remove.
    for (const key of ['change', 'turn-off', 'remove']) expect(byFocus(key).disabled, key).toBe(true);

    await press(cancel);
    expect(main.api.stashCancel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(cancel);
    expect(visible(cancel)).toBe(true);
    expect($('#sp-stash-step').textContent).toBe(t('settingsPanel.stash.cancelling'));

    main.state.syncResolve({ ok: false, kind: 'full', written: true, partial: true, cancelled: true, error: { code: 'cancelled' }, counts: { linked: 0, check: 0, notInStash: 0, gone: 0, changed: 0, skipped: 0 } });
    await settle();
    expect(live()).toBe(t('settingsPanel.stash.syncCancelled'));
    expect(visible(byFocus('sync'))).toBe(true);
    expect(document.activeElement).toBe(byFocus('sync'));
    const status = block().querySelector('.stash-settings__live');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('a finished sync: the counts line; the last-sync line from the status', async () => {
    await openSettings(await linkedSettings());
    await press(byFocus('sync'));
    const counts = { linked: 1204, check: 12, notInStash: 330, gone: 0, changed: 0, skipped: 4 };
    main.state.library.lastSync = { at: Date.UTC(2026, 10, 18, 14, 2), kind: 'full', ok: true, partial: false, error: null, counts };
    main.state.syncResolve({ ok: true, kind: 'full', written: true, partial: false, cancelled: false, complete: true, error: null, counts, relinked: [], details: { done: 150, total: 150 } });
    await settle();
    const parts = (videos) => [
      t(videos ? 'settingsPanel.stash.countMatchedVideos' : 'settingsPanel.stash.countMatched', { count: 1204 }),
      t('settingsPanel.stash.countCheck', { count: 12 }),
      t('settingsPanel.stash.countNotInStash', { count: 330 }),
      t('settingsPanel.stash.countSkipped', { count: 4 }),
    ].join(' · ');
    expect(live()).toBe(t('settingsPanel.stash.syncDone', { counts: parts(true) }));
    const date = new Date(main.state.library.lastSync.at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
    expect(block().querySelector('.stash-settings__last').textContent)
      .toBe(t('settingsPanel.stash.lastSync', { date, counts: parts(false) }));
  });

  it('never synced, and a partial last sync, say so', async () => {
    await openSettings(await linkedSettings({}, (s) => {
      s.library.lastSync = { at: 1, kind: 'full', ok: false, partial: true, error: 'timeout', counts: {} };
    }));
    expect(block().querySelector('.stash-settings__last').textContent).toMatch(new RegExp(`${t('settingsPanel.stash.lastSyncPartial').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    main.state.library.lastSync = null;
    for (const cb of main.listeners.changed) cb({ rev: 2 });
    await settle();
    expect(block().querySelector('.stash-settings__last').textContent).toBe(t('settingsPanel.stash.neverSynced'));
  });

  it('a failed or partial sync says what stopped it and that nothing was removed', async () => {
    await openSettings(await linkedSettings());
    await press(byFocus('sync'));
    main.state.syncResolve({ ok: false, kind: 'full', written: true, partial: true, cancelled: false, error: { code: 'timeout' }, counts: {}, details: { done: 600, total: 1204 } });
    await settle();
    expect(live()).toBe(t('settingsPanel.stash.syncPartial', { done: 600, total: 1204, reason: t('stash.error.timeout') }));
    await press(byFocus('sync'));
    main.state.syncResolve({ ok: false, kind: 'full', written: false, partial: true, cancelled: false, error: { code: 'unreachable' } });
    await settle();
    expect(live()).toBe(t('settingsPanel.stash.syncFailed', { reason: t('stash.error.unreachable', { address: 'http://127.0.0.1:9999' }) }));
  });

  it('a sync already running when Settings opens (Sync on start) shows its progress, and its result when it finishes', async () => {
    await openSettings(await linkedSettings({}, (s) => {
      s.sync = { running: true, kind: 'full', progress: { kind: 'full', step: 'hash', done: 5, total: 10 } };
    }));
    expect(visible(byFocus('sync-cancel'))).toBe(true);
    expect($('#sp-stash-step').textContent).toBe(t('settingsPanel.stash.stepHash', { done: 5, total: 10 }));
    main.state.sync = { running: false, kind: null, progress: null };
    main.progress({ kind: 'full', step: 'finished', result: { ok: false, kind: 'full', written: false, cancelled: true, error: { code: 'cancelled' } } });
    await settle();
    expect(visible(byFocus('sync'))).toBe(true);
    expect(live()).toBe(t('settingsPanel.stash.syncCancelled'));
  });

  it('Sync with Stash when FunSync starts: a labelled checkbox, off by default, saved through main', async () => {
    const settings = await linkedSettings();
    await openSettings(settings);
    const box = $('#sp-stash-sync-on-start');
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect($('label[for="sp-stash-sync-on-start"]').textContent).toBe(t('settingsPanel.stash.syncOnStart'));
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
    expect(main.api.stashSetOptions).toHaveBeenCalledWith({ syncOnStart: true });
    expect(settings.get('stash.syncOnStart')).toBe(true);
    expect(main.api.stashSync).not.toHaveBeenCalled();
  });

  // Stash "next" lot (sn-tags, 2026-11-19; Dave: an opt-in, off by default).
  it("Use Stash's tag aliases and sub-tags: a labelled checkbox with its help, off by default, saved through main both ways", async () => {
    const settings = await linkedSettings();
    await openSettings(settings);
    const box = $('#sp-stash-use-tag-rules');
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect($('label[for="sp-stash-use-tag-rules"]').textContent).toBe(t('settingsPanel.stash.useTagRules'));
    expect($(`#${box.getAttribute('aria-describedby')}`).textContent).toBe(t('settingsPanel.stash.useTagRulesHint'));
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
    expect(main.api.stashSetOptions).toHaveBeenLastCalledWith({ useTagRules: true });
    expect(settings.get('stash.useTagRules')).toBe(true);
    expect(box.checked).toBe(true);
    expect(main.api.stashSync).not.toHaveBeenCalled();
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await settle();
    expect(main.api.stashSetOptions).toHaveBeenLastCalledWith({ useTagRules: false });
    expect(settings.get('stash.useTagRules')).toBe(false);
    expect(box.checked).toBe(false);
  });

  it('the tag aliases opt-in: main refusing it puts the box back and says why', async () => {
    const settings = await linkedSettings();
    await openSettings(settings);
    main.api.stashSetOptions.mockResolvedValueOnce({ ok: false, code: 'badInput' });
    const box = $('#sp-stash-use-tag-rules');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
    expect(box.checked).toBe(false);
    expect(settings.get('stash.useTagRules')).not.toBe(true);
    expect(live()).toBe(stashErrorText({ code: 'badInput' }));
  });

  it('the tag aliases opt-in follows the saved setting main reports', async () => {
    const settings = await linkedSettings({ useTagRules: true });
    await openSettings(settings);
    const box = $('#sp-stash-use-tag-rules');
    expect(box.checked).toBe(true);
    for (const cb of [...main.listeners.settings]) cb({ ...store.getSetting('stash'), useTagRules: false });
    await settle();
    expect(box.checked).toBe(false);
  });

  it('damaged Stash data says where it was kept aside', async () => {
    await openSettings(await linkedSettings({}, (s) => {
      s.library.damaged = { as: 'C:/x/stash/library.damaged-2026-11-18.json', reason: 'parse' };
    }));
    const note = block().querySelector('.stash-settings__note--warn');
    expect(note.textContent).toBe(t('settingsPanel.stash.damaged', { name: 'library.damaged-2026-11-18.json' }));
  });
});

describe('Need a check: the videos waiting for you', () => {
  function checks(n) {
    const out = {};
    for (let i = 0; i < n; i++) {
      out[`C:/lib/clip ${String(i).padStart(2, '0')}.mp4`] = { kind: i % 2 ? 'pathChanged' : 'several', sceneIds: i % 2 ? ['4'] : ['1', '2'], fp: null, seenAt: 1, server: 'http://127.0.0.1:9999' };
    }
    return out;
  }

  it('one row per video: its name (as text), the reason, and Choose… named for the video', async () => {
    await openSettings(await linkedSettings({}, (s) => {
      s.data.check = {
        'C:/lib/scene_a.mp4': { kind: 'several', sceneIds: ['1', '2'], fp: null, seenAt: 1 },
        'C:\\lib\\<img src=x onerror=alert(1)> clip 3.mkv': { kind: 'pathChanged', sceneIds: ['4'], fp: null, seenAt: 1 },
      };
    }), { onOpenStashCheck: () => {} });
    expect($('#sp-stash-checks-title').textContent).toBe(t('settingsPanel.stash.checkHeader', { count: 2 }));
    const rows = [...block().querySelectorAll('.stash-settings__check-row')];
    expect(rows.map((r) => r.querySelector('.stash-settings__check-name').textContent))
      .toEqual(['<img src=x onerror=alert(1)> clip 3.mkv', 'scene_a.mp4']);
    expect(rows[0].querySelector('.stash-settings__check-name').title).toBe('C:\\lib\\<img src=x onerror=alert(1)> clip 3.mkv');
    expect(block().querySelector('.stash-settings__check-list img')).toBeNull();
    expect(rows[0].querySelector('.stash-settings__check-reason').textContent).toBe(t('settingsPanel.stash.checkPathChanged'));
    expect(rows[1].querySelector('.stash-settings__check-reason').textContent).toBe(t('settingsPanel.stash.checkSeveral', { count: 2 }));
    expect(rows[1].querySelector('button').getAttribute('aria-label')).toBe(t('settingsPanel.stash.chooseAria', { name: 'scene_a.mp4' }));
  });

  it('Choose… closes Settings, then opens that video (app.js: its dialog at File, on the choice)', async () => {
    const opened = [];
    await openSettings(await linkedSettings({}, (s) => { s.data.check = checks(1); }), {
      onOpenStashCheck: (path) => opened.push({ path, settingsOpen: !!document.querySelector('.modal-panel--settings') }),
    });
    await press(block().querySelector('.stash-settings__check-row button'));
    expect(opened).toEqual([{ path: 'C:/lib/clip 00.mp4', settingsOpen: false }]);
    await showing;
    showing = null;
  });

  it(`${CHECK_ROWS_SHOWN} rows, then Show all (n); Show all moves the focus to the first new row`, async () => {
    await openSettings(await linkedSettings({}, (s) => { s.data.check = checks(25); }), { onOpenStashCheck: () => {} });
    expect(block().querySelectorAll('.stash-settings__check-row')).toHaveLength(CHECK_ROWS_SHOWN);
    const all = byFocus('checks-all');
    expect(all.textContent).toBe(t('settingsPanel.stash.showAll', { count: 25 }));
    await press(all);
    expect(block().querySelectorAll('.stash-settings__check-row')).toHaveLength(25);
    expect(document.activeElement).toBe(byFocus(`check-${CHECK_ROWS_SHOWN}`));
  });

  it('no checks: no list', async () => {
    await openSettings(await linkedSettings());
    expect(block().querySelector('.stash-settings__checks').hidden).toBe(true);
  });
});

describe('path rules (advanced, collapsed)', () => {
  it('collapsed; a rule is saved only with both folders; removing one saves the rest', async () => {
    const settings = await linkedSettings({ pathRules: [{ local: '\\\\NAS\\videos', stash: '/data/videos' }] });
    await openSettings(settings);
    const details = block().querySelector('.stash-settings__rules');
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
    expect(details.querySelectorAll('.stash-settings__rule')).toHaveLength(1);

    await press(byFocus('rule-add'));
    const row = details.querySelectorAll('.stash-settings__rule')[1];
    const local = row.querySelector('[data-rule="local"]');
    const remote = row.querySelector('[data-rule="stash"]');
    expect(document.activeElement).toBe(local);
    expect(details.querySelector(`label[for="${local.id}"]`).textContent).toBe(t('settingsPanel.stash.ruleLocal'));
    local.value = 'C:\\Media';
    local.dispatchEvent(new Event('change'));
    await settle();
    expect(main.api.stashSetOptions).not.toHaveBeenCalled();
    expect(visible(details.querySelector('.stash-settings__note--warn'))).toBe(true);
    remote.value = '/media';
    remote.dispatchEvent(new Event('change'));
    await settle();
    expect(main.api.stashSetOptions).toHaveBeenLastCalledWith({
      pathRules: [{ local: '\\\\NAS\\videos', stash: '/data/videos' }, { local: 'C:\\Media', stash: '/media' }],
    });
    expect(settings.get('stash.pathRules')).toHaveLength(2);

    const rm = details.querySelectorAll('.stash-settings__rule-remove')[0];
    expect(rm.getAttribute('aria-label')).toBe(t('settingsPanel.stash.removeRuleAria', { folder: '\\\\NAS\\videos' }));
    await press(rm);
    expect(main.api.stashSetOptions).toHaveBeenLastCalledWith({ pathRules: [{ local: 'C:\\Media', stash: '/media' }] });
    expect(document.activeElement).toBe(details.querySelector('.stash-settings__rule-remove'));
  });
});

describe('Turn off / Turn on', () => {
  it('Turn off keeps the data and hides Stash; Turn on shows it again at once, with no sync', async () => {
    const settings = await linkedSettings();
    await openSettings(settings);
    const off = byFocus('turn-off');
    off.focus();
    await press(off);
    expect(main.api.stashSetOptions).toHaveBeenLastCalledWith({ enabled: false });
    expect(settings.get('stash.enabled')).toBe(false);
    expect(block().querySelector('.stash-settings__off-text').textContent).toBe(t('settingsPanel.stash.offText', { address: 'http://127.0.0.1:9999' }));
    expect(live()).toBe(t('settingsPanel.stash.turnedOff'));
    expect(document.activeElement).toBe(byFocus('turn-on'));

    await press(byFocus('turn-on'));
    expect(main.api.stashSetOptions).toHaveBeenLastCalledWith({ enabled: true });
    expect(settings.get('stash.enabled')).toBe(true);
    expect(document.activeElement).toBe(byFocus('turn-off'));
    expect(main.api.stashSync).not.toHaveBeenCalled();
    expect(main.api.stashRemoveData).not.toHaveBeenCalled();
  });
});

describe('Remove Stash data… (confirm, then Undo for 8 s)', () => {
  it('asks first; Cancel removes nothing', async () => {
    await openSettings(await linkedSettings({}, (s) => { s.data.links = { 'C:/a.mp4': { sceneId: '1' }, 'C:/b.mp4': { sceneId: '2' } }; }));
    byFocus('remove').click();
    await settle();
    const top = [...document.querySelectorAll('.modal-overlay')].at(-1);
    expect(top.textContent).toContain(t('settingsPanel.stash.removeConfirm', { count: 2 }));
    await answerConfirm(false);
    expect(main.api.stashRemoveData).not.toHaveBeenCalled();
  });

  it('confirmed: main removes it; the Undo (focused) gives main back its exact token; after 8 s the Undo is gone', async () => {
    await openSettings(await linkedSettings());
    byFocus('remove').click();
    await answerConfirm(true);
    expect(main.api.stashRemoveData).toHaveBeenCalledTimes(1);
    expect(live()).toBe(t('settingsPanel.stash.removed'));
    const undo = byFocus('undo');
    expect(visible(undo)).toBe(true);
    expect(document.activeElement).toBe(undo);
    expect(undo.getAttribute('aria-label')).toBe(t('settingsPanel.stash.undoRemoveAria'));
    await press(undo);
    expect(main.api.stashUndo).toHaveBeenCalledWith('undo-remove-1');
    expect(live()).toBe(t('settingsPanel.stash.removeUndone'));
    expect(visible(byFocus('undo'))).toBe(false);
  });

  it('the Undo lasts the window main gives (8 s) and then goes; the focus moves on to Sync now', async () => {
    // Fake clock that still moves with real time, so the awaits settle.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await openSettings(await linkedSettings());
    byFocus('remove').click();
    await answerConfirm(true);
    expect(visible(byFocus('undo'))).toBe(true);
    vi.advanceTimersByTime(REMOVE_UNDO_MS - 1500);
    expect(visible(byFocus('undo'))).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(visible(byFocus('undo'))).toBe(false);
    expect(document.activeElement).toBe(byFocus('sync'));
    vi.useRealTimers();
  });

  it('closing Settings inside the window moves the Undo to a toast', async () => {
    await openSettings(await linkedSettings());
    byFocus('remove').click();
    await answerConfirm(true);
    $('.settings-panel__done-btn').click();
    await showing;
    showing = null;
    const toastUndo = document.querySelector('#toast-container .stash-settings__toast-undo');
    expect(toastUndo).not.toBeNull();
    toastUndo.click();
    await settle();
    expect(main.api.stashUndo).toHaveBeenCalledWith('undo-remove-1');
  });
});

describe('listeners end with Settings', () => {
  it('closing Settings stops listening to main (progress, data changes, settings changes)', async () => {
    await openSettings(await linkedSettings());
    expect(main.listeners.progress.size).toBe(1);
    $('.settings-panel__done-btn').click();
    await showing;
    showing = null;
    expect(main.listeners.progress.size).toBe(0);
    expect(main.listeners.changed.size).toBe(0);
    expect(main.listeners.settings.size).toBe(0);
  });

  it("main's settings report (another window, an import) updates the open block", async () => {
    const settings = await linkedSettings();
    await openSettings(settings);
    const block2 = { ...store.getSetting('stash'), enabled: false };
    for (const cb of main.listeners.settings) cb(block2);
    await settle();
    expect(settings.get('stash.enabled')).toBe(false);
    expect(byFocus('turn-on')).not.toBeNull();
  });
});

describe('the status reply, read defensively', () => {
  it('normalizeStashStatus: an error reply or nothing is an unknown, empty status', () => {
    for (const raw of [null, undefined, { ok: false, code: 'x' }, 'x']) {
      const s = normalizeStashStatus(raw);
      expect(s.known).toBe(false);
      expect(s.hasKey).toBe(false);
      expect(s.syncing).toBeNull();
      expect(s.pin).toBeNull();
    }
  });

  it('a running "Sync this video" is not shown as a full sync', () => {
    expect(normalizeStashStatus({ ok: true, sync: { running: true, kind: 'video', progress: { step: 'list' } } }).syncing).toBeNull();
    expect(normalizeStashStatus({ ok: true, sync: { running: true, kind: 'full', progress: { step: 'list', done: 1, total: 2 } } }).syncing)
      .toEqual({ step: 'list', done: 1, total: 2 });
  });
});

describe('the stylesheet', () => {
  it('index.html links stash.css once, before the modern layer that must stay last', () => {
    const html = fs.readFileSync('renderer/index.html', 'utf8');
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    expect(links.filter((h) => h === 'styles/stash.css')).toHaveLength(1);
    expect(links.at(-1)).toBe('styles/modern.css');
    expect(fs.existsSync('renderer/styles/stash.css')).toBe(true);
  });

  it('stash.css uses the semantic tokens, keeps 36 px targets and the focus ring', () => {
    const css = fs.readFileSync('renderer/styles/stash.css', 'utf8');
    expect(css).toMatch(/\.stash-settings__btn \{[^}]*min-height: 36px/);
    expect(css).toMatch(/\.stash-settings__btn:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--accent\)/);
    expect(css).not.toMatch(/--bg-primary|--bg-secondary|--bg-modal/);
  });
});
