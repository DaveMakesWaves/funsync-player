/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js), which builds its toolbar on the DOM of
 * editor-popout.html at import time, and i18n.js walks that document
 * (notes/CLAUDE.md "Test environments").
 */
// FT-103 (also in v0.9.2): the editor pop-out had no translations. Its
// toolbar, menus, Select… / Modify…, Speed, Snap, Curves, Dock, status line
// and Every Nth dialog were English literals in every language, and its ?
// list and a toast's X showed raw keys (the window loaded no bundle at all).
//
// The window now starts in English (its own initI18n, READY only after),
// takes the main window's language from INITIAL_STATE and follows a switch
// there (LOCALE), with the docked editor's keys. Asserted: every word the
// window shows, opened in German, switched live to French (an open Every Nth
// dialog keeps what was typed) and to Japanese (an open ? list is rebuilt),
// with no English (or previous language) left; and that the parent's REAL
// ScriptEditor sends the locale on open and on a switch.
//
// Each bundle is fetched as i18n.js fetches it, a few ms late like file://
// in Electron. Two keys are new in this change (editor.popout.*); until the
// strings stage writes them into the bundles, a marked stand-in is used.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { IntlMessageFormat } from 'intl-messageformat';
import * as P from '../../renderer/js/editor-popout-protocol.js';
import { getCurrentLocale, setLocale, _resetForTests } from '../../renderer/js/i18n.js';

const NEW_KEYS = {
  'editor.popout.dock': 'Dock',
  'editor.popout.waveformTitle': 'Toggle waveform in main window (W)',
};
const get = (o, dotted) => dotted.split('.').reduce((v, p) => v?.[p], o);
function bundle(l) {
  const b = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
  for (const [key, en] of Object.entries(NEW_KEYS)) {
    if (get(b, key) !== undefined) continue;
    const parts = key.split('.');
    let o = b;
    for (const p of parts.slice(0, -1)) o = (o[p] = o[p] || {});
    o[parts.at(-1)] = l === 'en' ? en : `${l}:${en}`;
  }
  return b;
}
const L = Object.fromEntries(['en', 'de', 'fr', 'ja'].map((l) => [l, bundle(l)]));
const val = (l, key) => get(L[l], key);
const fmt = (l, key, params) => new IntlMessageFormat(val(l, key), l).format(params);
const flat = (o, out = new Set()) => {
  for (const v of Object.values(o)) {
    if (typeof v === 'string') out.add(v.trim());
    else if (v && typeof v === 'object') flat(v, out);
  }
  return out;
};
const VALUES = Object.fromEntries(Object.entries(L).map(([l, b]) => [l, flat(b)]));
// What the window said before this fix and en.json does not hold.
const OLD_ENGLISH = [
  'FunSync — Script Editor', 'Script editor toolbar', 'Switch axis', 'Delete selected (Del)',
  'Cut (Ctrl+X)', 'Invert (Ctrl+I)', 'Simplify selected', 'Add bookmark at playhead (B)',
  'Fill gaps', 'Generate from beats', 'Zoom in (+)', 'Zoom out (Ctrl+-)', 'Fit all',
  'Snap timestamps to 30fps frame grid',
  'Render Hermite splines between actions (off = linear segments)',
  'Script Editor — Shortcuts', 'Close Select every Nth point', 'Close', 'Dismiss notification',
];

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const sent = []; // pop-out -> parent
const down = []; // parent -> pop-out (the parent half below)
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const host = () => document.getElementById('editor-popout-host');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const canvas = () => $('canvas.editor__canvas');
const selectMenu = () => $('select.editor__select-menu');
const modifyMenu = () => selectMenu().nextElementSibling;
const dialog = () => $('.modal-panel[role="dialog"]');
const press = (key, init = {}) => canvas().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const choose = (value) => { const m = selectMenu(); m.value = value; m.dispatchEvent(new Event('change')); };
const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function switchTo(locale, how) {
  how();
  expect(getCurrentLocale()).not.toBe(locale); // its bundle is still loading
  await until(() => getCurrentLocale() === locale);
  await flush();
}
const ACTIONS = () => Array.from({ length: 12 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 100 : 0 }));

/** Every word the window shows: text, tooltips, accessible names, its title. */
function chromeStrings() {
  const out = [{ where: 'document.title', s: document.title }];
  const roots = [$('.popout-titlebar'), host(), ...$$('.modal-overlay'), $('#toast-container')];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.closest('.toast__body')) continue; // the parent's own words
      const where = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || el.id}`;
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) out.push({ where, s: n.nodeValue.trim() });
      for (const a of ['title', 'aria-label']) if (el.getAttribute(a)) out.push({ where: `${where}[${a}]`, s: el.getAttribute(a).trim() });
    }
  }
  // Language-neutral: the speed presets.
  return out.filter(({ s }) => !/^\d+(\.\d+)?x$/.test(s));
}
let ENGLISH_SEEN = [];
/** Strings that are another language's and not also this one's. */
function leftovers(locale, others, allowed = []) {
  const ok = new Set([...VALUES[locale], ...allowed]);
  const foreign = new Set(others.flatMap((o) => (o === 'en' ? [...VALUES.en, ...OLD_ENGLISH, ...ENGLISH_SEEN] : [...VALUES[o]])));
  return chromeStrings().filter(({ s }) => foreign.has(s) && !ok.has(s));
}
const rawKeys = () => chromeStrings().filter(({ s }) => /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(s));
const TOOLBAR_BUTTONS = [
  // Multi-axis editing (2026-11-24): Stacked, New axis, Export beside the script list.
  'editor.btn.stacked', 'editor.btn.newAxis', 'editor.btn.exportAxes',
  'editor.btn.undo', 'editor.btn.redo', 'editor.history.button', 'editor.btn.delete', 'editor.btn.cut', 'editor.btn.invert',
  'editor.btn.simplify', 'editor.vibrate.button', 'editor.btn.metadata', 'editor.btn.bookmark', 'editor.btn.fillGaps', 'editor.check.button',
  'editor.popout.waveformTitle', 'editor.btn.beats', 'editor.btn.record', 'editor.gamepad.button', 'editor.btn.zoomIn', 'editor.btn.zoomOut',
  'editor.btn.fitAll', 'editor.btn.save', 'editor.btn.dock',
];
// + the editor work list (2026-11-24): Fade in / out, Ripple delete, Make from the stroke.
const MODIFY = ['placeholder', 'halfSpeed', 'doubleSpeed', 'reverse', 'fadeIn', 'fadeOut', 'rippleDelete', 'fromStroke', 'remapRange', 'offsetTime',
  'removePauses', 'rangeExtend', 'generatePattern', 'fillPattern', 'exportHeatmap'];
const SELECT = ['placeholder', 'all', 'beforePlayhead', 'afterPlayhead', 'topThird', 'middleThird',
  'bottomThird', 'everyNth', 'created', 'none'];

/** The toolbar's words, each against the bundle of `l`. */
function expectToolbarIn(l) {
  expect(document.title).toBe(`FunSync — ${val(l, 'editor.popoutWindowTitle')}`);
  expect($('.popout-titlebar__title').textContent).toBe(val(l, 'editor.popoutWindowTitle'));
  const bar = $('.editor__toolbar', host());
  expect(bar.getAttribute('aria-label')).toBe(val(l, 'editor.toolbarAria'));
  const buttons = $$('button.editor__btn', bar);
  expect(buttons.map((b) => b.title)).toEqual(TOOLBAR_BUTTONS.map((k) => val(l, k)));
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(TOOLBAR_BUTTONS.map((k) => val(l, k)));
  expect($('.editor__btn--dock', bar).textContent).toBe(val(l, 'editor.popout.dock'));
  expect([...modifyMenu().options].map((o) => o.textContent)).toEqual(MODIFY.map((k) => val(l, `editor.modify.${k}`)));
  expect(modifyMenu().getAttribute('aria-label')).toBe(val(l, 'editor.modify.title'));
  expect([...selectMenu().options].map((o) => o.textContent)).toEqual(SELECT.map((k) => val(l, `editor.select.${k}`)));
  expect(selectMenu().title).toBe(val(l, 'editor.select.title'));
  expect($('.editor__script-select', bar).title).toBe(val(l, 'editor.scriptSelectTitle'));
  expect($('.editor__speed-label', bar).textContent).toBe(val(l, 'editor.speedLabel'));
  const [snap, curves] = $$('.editor__toggle-label', bar);
  expect(snap.textContent).toBe(val(l, 'editor.snapLabel'));
  expect(snap.title).toBe(val(l, 'editor.snapTitle'));
  expect(curves.textContent).toBe(val(l, 'editor.curvesLabel'));
  expect(curves.title).toBe(val(l, 'editor.curvesTitle'));
  expect($('.editor__recording-indicator', bar).textContent).toBe(val(l, 'editor.recording'));
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = async (url) => {
    const m = /locales\/(\w+)\.json$/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch ${url}`);
    await new Promise((r) => setTimeout(r, 8));
    return { ok: true, json: async () => (L[m[1]] ? JSON.parse(JSON.stringify(L[m[1]])) : bundle(m[1])) };
  };
  // A fresh window: no bundle loaded until the window loads its own.
  _resetForTests();
  document.body.innerHTML = bodyInner;
  const ctx = document.createElement('canvas').getContext('2d');
  for (const fn of ['setLineDash', 'getLineDash', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'translate']) {
    if (typeof ctx[fn] !== 'function') ctx[fn] = () => [];
  }
  if (typeof ctx.createLinearGradient !== 'function') ctx.createLinearGradient = () => ({ addColorStop() {} });
  window.funsync = {
    editorPopoutRelay: (direction, payload) => (direction === 'to-parent' ? sent : down).push(payload),
    // The pop-out registers first; the parent's ScriptEditor below registers
    // too, for the pop-out's commands, which are not under test here.
    onEditorPopoutEvent: (cb) => { if (!onEvent) onEvent = cb; return () => {}; },
    editorPopoutClose() {},
    updateWindowChrome() {},
    editorDirtyChanged() {},
  };
  await import('../../renderer/editor-popout.js');
}, 20000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('the editor pop-out has words before it asks for anything', () => {
  it('says READY only once its English bundle is in, and never shows a raw key', async () => {
    expect(sent.some((m) => m.type === P.READY)).toBe(false);
    await until(() => sent.some((m) => m.type === P.READY));
    expect(sent.filter((m) => m.type === P.READY)).toHaveLength(1);
    expect(rawKeys()).toEqual([]);
    expectToolbarIn('en');
    ENGLISH_SEEN = chromeStrings().map(({ s }) => s);
  });
});

describe('opened in German (INITIAL_STATE locale)', () => {
  it('every word of its chrome is German, none English', async () => {
    await switchTo('de', () => fromParent({
      type: P.INITIAL_STATE, locale: 'de',
      scripts: [], activePath: 'C:\\s\\a.funscript', actions: ACTIONS(), selectedIndices: [], bookmarks: [],
      videoSrc: '', videoDuration: 60, videoTime: 5, videoPaused: true, videoRate: 1,
      splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
    }));
    expectToolbarIn('de');
    expect($('.editor__status', host()).textContent).toBe(fmt('de', 'editor.status', { count: 12 }));
    fromParent({ type: P.ACTIONS_CHANGED, actions: ACTIONS(), selectedIndices: [1, 2], bookmarks: [] });
    // Two selected: the selection statistics too, in German (editor work list 4.1).
    expect($('.editor__status', host()).textContent).toBe(
      `${fmt('de', 'editor.statusSelected', { count: 12, selected: 2 })} · ${fmt('de', 'editor.statusStats', { seconds: '0.50', avg: 200, top: 200 })}`);
    fromParent({ type: P.ACTIONS_CHANGED, actions: ACTIONS(), selectedIndices: [], bookmarks: [] });
    expect(leftovers('de', ['en'], [fmt('de', 'editor.status', { count: 12 })])).toEqual([]);
    expect(rawKeys()).toEqual([]);
  });

  it('its Every Nth point… dialog is German, the X included', async () => {
    choose('everyNth');
    const d = dialog();
    expect($('.modal-title', d).textContent).toBe(val('de', 'editor.everyNthTitle'));
    expect($$('label', d).map((l) => l.textContent.trim())).toEqual([val('de', 'editor.everyNthEvery'), val('de', 'editor.everyNthStart')]);
    expect($('#nth-scope', d).textContent).toBe(fmt('de', 'editor.everyNthScopeAll', { count: 12 }));
    expect($('#nth-result', d).textContent).toBe(fmt('de', 'editor.everyNthResult', { count: 6 }));
    expect($('#nth-cancel', d).textContent).toBe(val('de', 'common.cancel'));
    expect($('#nth-ok', d).textContent).toBe(val('de', 'editor.everyNthSelect'));
    const closeAria = fmt('de', 'modal.closeAria', { title: val('de', 'editor.everyNthTitle') });
    expect($('.modal-close-btn', d).getAttribute('aria-label')).toBe(closeAria);
    expect(leftovers('de', ['en'], [
      fmt('de', 'editor.status', { count: 12 }), closeAria,
      fmt('de', 'editor.everyNthScopeAll', { count: 12 }), fmt('de', 'editor.everyNthResult', { count: 6 }),
    ])).toEqual([]);
    $('#nth-cancel', d).click();
    await flush();
    expect(dialog()).toBeNull();
  });

  it('its ? list is German: title, groups, keys (Strg, not Ctrl) and button', async () => {
    press('?', { code: 'Slash', shiftKey: true });
    const d = dialog();
    expect($('.modal-title', d).textContent).toBe(val('de', 'editor.keyboardHelpTitle'));
    expect($$('.editor-help__title', d)[0].textContent).toBe(val('de', 'kbd.editorSelection'));
    expect($$('.editor-help__desc', d)[0].textContent).toBe(val('de', 'kbd.editorPrevNextAction'));
    expect($$('kbd', d).some((k) => /Strg/.test(k.textContent))).toBe(true);
    expect($$('kbd', d).filter((k) => /Ctrl/.test(k.textContent))).toEqual([]);
    expect($('.modal-btn--primary', d).textContent).toBe(val('de', 'common.gotIt'));
    expect(rawKeys()).toEqual([]);
    $('.modal-btn--primary', d).click();
    await flush();
    expect(dialog()).toBeNull();
  });

  it('the Dock button keeps its text-button size in German (editor.css matched the English label)', () => {
    const style = document.createElement('style');
    style.textContent = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    document.head.appendChild(style);
    try {
      const dock = $('.editor__btn--dock', host());
      expect(dock.getAttribute('aria-label')).not.toMatch(/^Dock/);
      const cs = getComputedStyle(dock);
      expect(cs.minWidth).toBe('52px');
      expect(cs.paddingLeft).toBe('12px');
      expect(cs.width).toBe('auto');
    } finally {
      style.remove();
    }
  });

  it("a toast's X is labelled in German by the window itself", () => {
    fromParent({ type: P.TOAST, text: 'Ausgewählt: 6 von 12 Punkten.', level: 'info' });
    const x = $('#toast-container .toast__close');
    expect(x.getAttribute('aria-label')).toBe(val('de', 'toast.dismissAria'));
    $$('#toast-container .toast').forEach((el) => el.remove());
  });
});

describe('a live switch in the main window (LOCALE)', () => {
  it('to French: the toolbar, the status line and an open Every Nth dialog follow, and what was typed stays', async () => {
    choose('everyNth');
    const every = $('#nth-every', dialog());
    every.value = '3';
    every.dispatchEvent(new Event('input'));
    await switchTo('fr', () => fromParent({ type: P.LOCALE, locale: 'fr' }));

    expectToolbarIn('fr');
    expect($('.editor__status', host()).textContent).toBe(fmt('fr', 'editor.status', { count: 12 }));
    const d = dialog();
    expect($$('.modal-panel[role="dialog"]')).toHaveLength(1);
    expect($('#nth-every', d)).toBe(every);
    expect(every.value).toBe('3');
    expect($('.modal-title', d).textContent).toBe(val('fr', 'editor.everyNthTitle'));
    expect($$('label', d).map((l) => l.textContent.trim())).toEqual([val('fr', 'editor.everyNthEvery'), val('fr', 'editor.everyNthStart')]);
    expect($('#nth-result', d).textContent).toBe(fmt('fr', 'editor.everyNthResult', { count: 4 }));
    expect($('#nth-cancel', d).textContent).toBe(val('fr', 'common.cancel'));
    expect($('#nth-ok', d).textContent).toBe(val('fr', 'editor.everyNthSelect'));
    const closeAria = fmt('fr', 'modal.closeAria', { title: val('fr', 'editor.everyNthTitle') });
    expect($('.modal-close-btn', d).getAttribute('aria-label')).toBe(closeAria);
    expect(leftovers('fr', ['en', 'de'], [
      fmt('fr', 'editor.status', { count: 12 }), closeAria,
      fmt('fr', 'editor.everyNthScopeAll', { count: 12 }), fmt('fr', 'editor.everyNthResult', { count: 4 }),
    ])).toEqual([]);
    expect(rawKeys()).toEqual([]);

    // Select still sends what was typed.
    sent.length = 0;
    $('#nth-ok', d).click();
    await flush();
    expect(sent).toEqual([P.editOp(P.OP_SELECT_EVERY_NTH, { n: 3, start: 1 })]);
  });

  it('to Japanese with the ? list open: the list is built again in Japanese, once', async () => {
    press('?', { code: 'Slash', shiftKey: true });
    expect($('.modal-title', dialog()).textContent).toBe(val('fr', 'editor.keyboardHelpTitle'));
    await switchTo('ja', () => fromParent({ type: P.LOCALE, locale: 'ja' }));

    expect($$('.modal-panel[role="dialog"]')).toHaveLength(1);
    const d = dialog();
    expect($('.modal-title', d).textContent).toBe(val('ja', 'editor.keyboardHelpTitle'));
    expect($$('.editor-help__title', d)[0].textContent).toBe(val('ja', 'kbd.editorSelection'));
    expect($('.modal-btn--primary', d).textContent).toBe(val('ja', 'common.gotIt'));
    expectToolbarIn('ja');
    const closeAria = fmt('ja', 'modal.closeAria', { title: val('ja', 'editor.keyboardHelpTitle') });
    expect(leftovers('ja', ['en', 'fr'], [fmt('ja', 'editor.status', { count: 12 }), closeAria])).toEqual([]);
    $('.modal-btn--primary', d).click();
    await flush();
  });
});

describe("the parent's half: the REAL ScriptEditor hands over its language", () => {
  let ed;
  beforeAll(async () => {
    const container = document.createElement('div');
    container.id = 'player-container';
    document.body.appendChild(container);
    const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
    const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: true, src: '' });
    ed = new ScriptEditor({
      videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 }),
      funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
      progressBar: { renderHeatmap() {} },
      settings: { get: () => undefined, set() {} },
    });
  });

  it('INITIAL_STATE carries the main window\'s current language', () => {
    ed._popoutOpen = true;
    down.length = 0;
    ed._handlePopoutMessage({ type: P.READY });
    const init = down.find((m) => m.type === P.INITIAL_STATE);
    expect(init.locale).toBe('ja');
  });

  it('a switch while popped out sends LOCALE with the new language; docked it sends nothing', async () => {
    down.length = 0;
    await setLocale('de');
    expect(down.filter((m) => m.type === P.LOCALE)).toEqual([{ type: P.LOCALE, locale: 'de' }]);
    ed._popoutOpen = false;
    down.length = 0;
    await setLocale('fr');
    expect(down).toEqual([]);
  });
});
