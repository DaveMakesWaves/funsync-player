/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js), which builds its toolbar, canvas and
 * ActionGraph on the DOM of editor-popout.html at import time.
 */
// The editor pop-out's side of the two selection commands (belgriffinite
// #261). Until now no test loaded this window at all, so its key switch was
// only ever checked by hand.
//
//   - its Select… list has the docked editor's items, order and labels
//     (here in English; since FT-103 they come from the locale bundle, see
//     editor-popout-language.test.js for German and French);
//   - every item sends exactly what its key sends;
//   - Every Nth point… opens a dialog IN THE POP-OUT, whose Select sends the
//     values as OP_SELECT_EVERY_NTH; it used to ask the parent to open its
//     dialog in the main window (FT-029);
//   - a parent TOAST shows in the pop-out (FT-029);
//   - N sends OP_SELECT_CREATED (the record lives in the parent);
//   - Shift+B / Ctrl+B run the player's direction (Dave, 2026-11-04), which
//     the core fix changed here with no test to hold it;
//   - its own Ctrl+Shift+V / Ctrl+V / V (FT-030);
//   - position keys resolve as in the docked editor, custom keys included,
//     and go as OP_PLACE_AT (FT-032);
//   - letter keys work on a layout that types no Latin letters (FT-035).
//
// Assertions are on the messages the pop-out sends to the parent and on
// what the pop-out's DOM shows.
import { describe, it, expect, beforeAll, beforeEach, onTestFinished } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';
import { t, _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
// The English the docked dialog shows, from en.json through the real i18n.
// The bundle stays loaded: since FT-103 the pop-out window has its own i18n
// and starts in English (initI18n). This file used to clear the bundles
// first, because the window had none and a loaded bundle would have hidden
// the raw keys it showed.
_setBundlesForTests('en', EN, EN);
const EN_TEXT = {
  scopeAll12: t('editor.everyNthScopeAll', { count: 12 }),
  scopeSel1: t('editor.everyNthScopeSelected', { count: 1 }),
  scopeSel4: t('editor.everyNthScopeSelected', { count: 4 }),
  result6: t('editor.everyNthResult', { count: 6 }),
  result1: t('editor.everyNthResult', { count: 1 }),
  result4: t('editor.everyNthResult', { count: 4 }),
  closeAria: t('modal.closeAria', { title: EN.editor.everyNthTitle }),
};
const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const sent = []; // what the pop-out sent to the parent
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const selectMenu = () => document.querySelector('select[aria-label="Select points"]');
const canvas = () => document.querySelector('canvas.editor__canvas');
const choose = (value) => { const m = selectMenu(); m.value = value; m.dispatchEvent(new Event('change')); };
const press = (key, mods = {}) => canvas().dispatchEvent(new KeyboardEvent('keydown', {
  key, code: mods.code, bubbles: true, cancelable: true,
  shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
}));
const take = () => sent.splice(0, sent.length);
// The parent's script: 12 points, 500 ms apart, and three bookmarks.
const ACTIONS = () => Array.from({ length: 12 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 100 : 0 }));
const BOOKMARKS = [{ at: 1000, name: 'a' }, { at: 4000, name: 'b' }, { at: 9000, name: 'c' }];
const selectInParent = (selectedIndices) =>
  fromParent({ type: P.ACTIONS_CHANGED, actions: ACTIONS(), selectedIndices, bookmarks: BOOKMARKS });
const dialog = () => document.querySelector('.modal-panel[role="dialog"]');
const inDialog = (sel) => dialog()?.querySelector(sel);
const typeInto = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input')); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const toastEls = () => [...document.querySelectorAll('#toast-container .toast')];

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  // The pop-out draws its graph on hydrate; tests/setup.js's 2D context mock
  // has no dash or curve calls. Topped up for this file only.
  const ctx = document.createElement('canvas').getContext('2d');
  for (const fn of ['setLineDash', 'getLineDash', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'translate']) {
    if (typeof ctx[fn] !== 'function') ctx[fn] = () => [];
  }
  if (typeof ctx.createLinearGradient !== 'function') ctx.createLinearGradient = () => ({ addColorStop() {} });
  window.funsync = {
    editorPopoutRelay: (direction, payload) => { if (direction === 'to-parent') sent.push(payload); },
    onEditorPopoutEvent: (cb) => { onEvent = cb; },
    editorPopoutClose() {},
    updateWindowChrome() {},
  };
  await import('../../renderer/editor-popout.js');
  // Labelled once its i18n is up, then it says READY (FT-103).
  await new Promise((r) => setTimeout(r, 0));
  fromParent({
    type: P.INITIAL_STATE,
    scripts: [], activePath: 'C:\\s\\a.funscript',
    actions: ACTIONS(),
    selectedIndices: [],
    bookmarks: BOOKMARKS,
    videoSrc: '', videoDuration: 60, videoTime: 5, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
  });
}, 20000);

beforeEach(() => {
  take();
  // A dialog left open would swallow the next test's keys (and give jsdom
  // two elements with one id): close it the user's way.
  while (inDialog('#nth-cancel')) inDialog('#nth-cancel').click();
  document.querySelectorAll('#toast-container .toast').forEach((el) => el.remove());
});

// R3 fix-up (real-app verifier 1): at 1100x700 the pop-out's "Speed:" ended
// toolbar row 1 and its select started row 2. One toolbar item now.
describe('the pop-out toolbar', () => {
  it('"Speed:" and its select are one toolbar item, so a wrap never splits them', () => {
    // The playback-speed select (Select… and Modify… share its class).
    const select = [...document.querySelectorAll('.editor__speed-select')]
      .find((el) => [...el.options].some((o) => o.value === '1'));
    const label = document.querySelector('.editor__speed-label');
    expect(select.parentElement).toBe(label.parentElement);
    expect(select.parentElement.className).toBe('editor__speed-group');
    expect(select.parentElement.parentElement.classList.contains('editor__toolbar')).toBe(true);
  });
});

describe('the pop-out Select… list', () => {
  it('has the docked editor\'s items in the same order, with the same (English) labels, beside Modify…', () => {
    const m = selectMenu();
    expect(m).not.toBeNull();
    expect(m.nextElementSibling.getAttribute('aria-label')).toBe('Modify script');
    const S = EN.editor.select;
    expect([...m.children].map((el) => (el.tagName === 'HR' ? '---' : el.textContent))).toEqual([
      S.placeholder, S.all, S.beforePlayhead, S.afterPlayhead, S.topThird, S.middleThird, S.bottomThird,
      '---', S.everyNth, S.created, '---', S.none,
    ]);
    expect(m.options[0].disabled).toBe(true);
  });

  it('resets to its placeholder after a choice and puts focus back on the canvas', () => {
    selectMenu().focus();
    choose('all');
    expect(selectMenu().selectedIndex).toBe(0);
    expect(document.activeElement).toBe(canvas());
  });

  it.each([
    ['all', 'a', { ctrl: true }],
    ['beforePlayhead', 'ArrowLeft', { ctrl: true, alt: true }],
    ['afterPlayhead', 'ArrowRight', { ctrl: true, alt: true }],
    ['topThird', '1', { ctrl: true, code: 'Digit1' }],
    ['middleThird', '2', { ctrl: true, code: 'Digit2' }],
    ['bottomThird', '3', { ctrl: true, code: 'Digit3' }],
    ['created', 'n', { code: 'KeyN' }],
    ['none', 'Escape', {}],
  ])('%s sends exactly what its key (%s) sends', (value, key, mods) => {
    choose(value);
    const viaMenu = take();
    press(key, mods);
    const viaKey = take();
    expect(viaMenu.length).toBe(1);
    expect(viaMenu).toEqual(viaKey);
  });

  it('the item names: N is OP_SELECT_CREATED, the thirds are the docked bands, the playhead commands carry the time', () => {
    choose('created');
    choose('topThird');
    choose('beforePlayhead');
    expect(take()).toEqual([
      P.editOp(P.OP_SELECT_CREATED),
      P.editOp(P.OP_SELECT_BY_POSITION, { minPos: 67, maxPos: 100 }),
      P.editOp(P.OP_SELECT_LEFT_OF, { time: 5000 }),
    ]);
  });

  // FT-029. This test used to pin the old route as correct: "Every Nth
  // point… asks the parent to open its dialog" (REQUEST_SELECT_EVERY_NTH),
  // so the dialog and its toast appeared in the main window.
  it('Every Nth point… opens a dialog in the POP-OUT and sends nothing until Select (no key, Dave Q3)', () => {
    choose('everyNth');
    expect(dialog()).not.toBeNull();
    expect(dialog().querySelector('.modal-title').textContent).toBe(EN.editor.everyNthTitle);
    expect([...dialog().querySelectorAll('label')].map((l) => l.textContent.trim()))
      .toEqual([EN.editor.everyNthEvery, EN.editor.everyNthStart]);
    expect(inDialog('#nth-every').value).toBe('2');
    expect(inDialog('#nth-start').value).toBe('1');
    expect(inDialog('#nth-scope').textContent).toBe(EN_TEXT.scopeAll12); // nothing selected: the whole script
    expect(inDialog('#nth-result').textContent).toBe(EN_TEXT.result6);
    expect(inDialog('#nth-ok').textContent).toBe(EN.editor.everyNthSelect);
    expect(inDialog('#nth-cancel').textContent).toBe(EN.common.cancel);
    // Its X says what it closes, not the raw i18n key.
    expect(dialog().querySelector('.modal-close-btn').getAttribute('aria-label')).toBe(EN_TEXT.closeAria);
    expect(take()).toEqual([]);
  });

  it('Every 3 from point 2 + Select sends OP_SELECT_EVERY_NTH {n: 3, start: 2}, closes, and remembers 3 / 2', async () => {
    choose('everyNth');
    typeInto(inDialog('#nth-every'), 3);
    typeInto(inDialog('#nth-start'), 2);
    expect(inDialog('#nth-result').textContent).toBe(EN_TEXT.result4); // points 2, 5, 8, 11
    inDialog('#nth-ok').click();
    await tick();
    expect(dialog()).toBeNull();
    const out = take();
    expect(out).toEqual([P.editOp(P.OP_SELECT_EVERY_NTH, { n: 3, start: 2 })]);
    expect(out.some((m) => m.type === P.REQUEST_SELECT_EVERY_NTH)).toBe(false);
    choose('everyNth');
    expect(inDialog('#nth-every').value).toBe('3');
    expect(inDialog('#nth-start').value).toBe('2');
  });

  it('the live lines count the selection mirrored from the parent, and never change it', () => {
    onTestFinished(() => selectInParent([]));
    selectInParent([7]);
    choose('everyNth');
    expect(inDialog('#nth-scope').textContent).toBe(EN_TEXT.scopeSel1);
    expect(inDialog('#nth-result').textContent).toBe('Needs at least 2 points to count.');
    // The selection changes under the open dialog (an ACTIONS_CHANGED from
    // the parent): the lines follow it on the next input, as in the docked one.
    selectInParent([8, 9, 10, 11]);
    typeInto(inDialog('#nth-every'), 2);
    expect(inDialog('#nth-scope').textContent).toBe(EN_TEXT.scopeSel4);
    expect(take()).toEqual([]); // counting sends nothing
    selectInParent([]);
  });

  it('Cancel sends nothing; keys typed into the dialog never reach the graph behind it', async () => {
    choose('everyNth');
    const every = inDialog('#nth-every');
    for (const [key, code] of [['3', 'Digit3'], ['Delete', 'Delete'], ['n', 'KeyN'], ['q', 'KeyQ']]) {
      every.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
    }
    inDialog('#nth-cancel').click();
    await tick();
    expect(dialog()).toBeNull();
    expect(take()).toEqual([]);
  });
});

describe("the pop-out's own toasts (FT-029)", () => {
  it('a TOAST from the parent shows in the pop-out with its level, and its X carries the parent\'s label', () => {
    fromParent({ type: P.TOAST, text: 'Selected 4 of 12 points.', level: 'info', dismissLabel: 'Notification schließen' });
    fromParent({ type: P.TOAST, text: 'Double Speed needs a continuous selection.', level: 'warn' });
    const [info, warn] = toastEls();
    expect(info.querySelector('.toast__body').textContent).toBe('Selected 4 of 12 points.');
    expect(info.classList.contains('toast--info')).toBe(true);
    expect(info.querySelector('.toast__close').getAttribute('aria-label')).toBe('Notification schließen');
    expect(warn.classList.contains('toast--warn')).toBe(true);
    // No label sent: toast.js's own, in this window's language (FT-103; it was
    // an English literal standing in for the raw key toast.js put there).
    expect(warn.querySelector('.toast__close').getAttribute('aria-label')).toBe(EN.toast.dismissAria);
  });

  it('a TOAST without text, or with an unknown level, shows nothing odd', () => {
    fromParent({ type: P.TOAST });
    fromParent({ type: P.TOAST, text: 'x', level: 'nonsense' });
    const els = toastEls();
    expect(els).toHaveLength(1);
    expect(els[0].classList.contains('toast--info')).toBe(true);
  });
});

describe('the pop-out keys', () => {
  it('bare N sends New points only; Ctrl+N, Shift+N and Alt+N do not', () => {
    press('n', { code: 'KeyN' });
    expect(take()).toEqual([P.editOp(P.OP_SELECT_CREATED)]);
    press('n', { ctrl: true, code: 'KeyN' });
    press('N', { shift: true, code: 'KeyN' });
    press('n', { alt: true, code: 'KeyN' });
    expect(take()).toEqual([]);
  });

  it('Ctrl+1 / 2 / 3 select the thirds and place nothing; a bare digit still places a point (v0.9.2: Ctrl+1 placed one at 10)', () => {
    press('1', { ctrl: true, code: 'Digit1' });
    press('2', { ctrl: true, code: 'Digit2' });
    press('3', { ctrl: true, code: 'Numpad3' });
    expect(take()).toEqual([
      P.editOp(P.OP_SELECT_BY_POSITION, { minPos: 67, maxPos: 100 }),
      P.editOp(P.OP_SELECT_BY_POSITION, { minPos: 34, maxPos: 66 }),
      P.editOp(P.OP_SELECT_BY_POSITION, { minPos: 0, maxPos: 33 }),
    ]);
    press('1', { code: 'Digit1' });
    expect(take()).toEqual([P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 10 })]);
  });

  it("Shift+B seeks to the PREVIOUS bookmark and Ctrl+B to the NEXT, the player's direction", () => {
    press('B', { shift: true });
    press('b', { ctrl: true });
    expect(take()).toEqual([
      P.msg(P.VIDEO_SEEK, { time: 4 }),
      P.msg(P.VIDEO_SEEK, { time: 9 }),
    ]);
  });
});

describe("the pop-out's own Ctrl+Shift+V (FT-030)", () => {
  it('Ctrl+Shift+V sends OP_PASTE_ORIGINAL at the snapped playhead; Ctrl+V OP_PASTE; bare V the voice-activity toggle', () => {
    // Snap on and a playhead between frames, so "snapped" is visible.
    fromParent({ type: P.SETTINGS, snapToFrame: true });
    fromParent({ type: P.TIME_TICK, time: 5.02, paused: true });
    try {
      const frame = 1000 / 30;
      const snapped = Math.round(Math.round(5020 / frame) * frame); // 5033, not 5020
      press('V', { ctrl: true, shift: true, code: 'KeyV' });
      press('v', { ctrl: true, code: 'KeyV' });
      press('v', { code: 'KeyV' });
      expect(take()).toEqual([
        P.editOp(P.OP_PASTE_ORIGINAL, { at: snapped }),
        P.editOp(P.OP_PASTE, { at: snapped }),
        { type: 'request-vad-toggle' },
      ]);
      press('V', { shift: true, code: 'KeyV' }); // no editor action
      expect(take()).toEqual([]);
    } finally {
      // The later tests place at 5000 with snap off.
      fromParent({ type: P.SETTINGS, snapToFrame: false });
      fromParent({ type: P.TIME_TICK, time: 5, paused: true });
    }
  });
});

describe('pop-out position keys = the docked editor\'s (FT-032)', () => {
  const placed = () => take().filter((m) => m.op === P.OP_PLACE_AT || m.op === P.OP_INSERT);

  it('Shift+0, - and Numpad- place at 100; 3 places at 30; all as OP_PLACE_AT', () => {
    press(')', { shift: true, code: 'Digit0' });
    press('-', { code: 'Minus' });
    press('-', { code: 'NumpadSubtract' });
    press('3', { code: 'Digit3' });
    expect(placed()).toEqual([
      P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 100 }),
      P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 100 }),
      P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 100 }),
      P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 30 }),
    ]);
  });

  it('Shift+1..9 place nothing (the pop-out placed Shift+5 at 50, Shift+0 at 0)', () => {
    for (let d = 1; d <= 9; d++) press('!@#$%^&*('[d - 1], { shift: true, code: `Digit${d}` });
    expect(placed()).toEqual([]);
  });

  it('a custom position key from the parent places where the user bound it, and wins over a default', () => {
    onTestFinished(() => fromParent({ type: P.SETTINGS, customPositionKeys: [] }));
    fromParent({ type: P.SETTINGS, customPositionKeys: [
      { code: 'KeyJ', mods: {}, position: 35 },
      { code: 'Digit5', mods: {}, position: 75 },
    ] });
    press('j', { code: 'KeyJ' });
    press('5', { code: 'Digit5' });
    expect(placed()).toEqual([
      P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 35 }),
      P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 75 }),
    ]);
    fromParent({ type: P.SETTINGS, customPositionKeys: [] });
    press('5', { code: 'Digit5' });
    expect(placed()).toEqual([P.editOp(P.OP_PLACE_AT, { at: 5000, pos: 50 })]);
  });
});

describe('letter keys on a layout without Latin letters (FT-035)', () => {
  it.each([
    ['Russian т', 'т'],
    ['Korean ㅜ', 'ㅜ'],
  ])('N on %s sends New points only', (_, key) => {
    press(key, { code: 'KeyN' });
    expect(take()).toEqual([P.editOp(P.OP_SELECT_CREATED)]);
  });

  it('Russian Ctrl+С copies and Q (й) inserts the alternating point', () => {
    press('с', { ctrl: true, code: 'KeyC' });
    press('й', { code: 'KeyQ' });
    expect(take()).toEqual([
      P.editOp(P.OP_COPY),
      P.editOp(P.OP_INSERT_ALTERNATING, { at: 5000 }),
    ]);
  });

  it("AZERTY keeps its own letters: the key at KeyQ types a and is NOT Q; AZERTY's Q (at KeyA) is", () => {
    press('a', { code: 'KeyQ' });
    expect(take()).toEqual([]);
    press('q', { code: 'KeyA' });
    expect(take()).toEqual([P.editOp(P.OP_INSERT_ALTERNATING, { at: 5000 })]);
  });
});
