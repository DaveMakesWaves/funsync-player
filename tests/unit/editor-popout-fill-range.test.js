/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js), which builds its toolbar, canvas and the
 * drawer on the DOM of editor-popout.html, and the REAL parent ScriptEditor.
 */
// Fill with pattern in the editor pop-out (pattern library, Round 2): the
// same drawer, beside the pop-out's timeline. The preview is rendered in the
// pop-out (the fill core is pure); Apply sends OP_FILL_RANGE through the
// existing protocol and the PARENT lands it, so its script, undo stack and
// autosave stay the only ones. Asserted:
//
//   - P, the right-click menu and Modify > Fill with Pattern… open it in the
//     pop-out (beside the timeline, which makes room);
//   - slider input: one fill per frame, the last value;
//   - Esc / Cancel send nothing; the edit keys send nothing while it is open;
//   - Apply sends exactly the previewed fill;
//   - the parent applies it as ONE undo step and the result equals the docked
//     editor's own Apply on the same script and options (parity);
//   - the parent remembers the options and sends them back (SETTINGS);
//   - a fill whose anchors are gone, or that is not a valid fill, lands nothing.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange) };
});
const { fillRange } = await import('../../renderer/js/pattern-fill.js');
const { t, _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { validFillRange, MAX_FILL_POINTS } = await import('../../renderer/js/editor-popout-dispatch.js');
const { windowSignature } = await import('../../renderer/components/pattern-fill-drawer.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 90 : 10 }));
const ACTIONS = () => zigzag(17);
const sent = []; // pop-out -> parent
const down = []; // parent -> pop-out
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const host = () => document.getElementById('editor-popout-host');
const canvas = () => host().querySelector('canvas.editor__canvas');
const drawer = () => host().querySelector('.fill-drawer');
const isOpen = () => drawer()?.hidden === false;
const take = () => sent.splice(0, sent.length);
const press = (target, key, mods = {}) => {
  const e = new KeyboardEvent('keydown', {
    key, code: mods.code, bubbles: true, cancelable: true,
    shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
  });
  target.dispatchEvent(e);
  return e;
};
const slide = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };
const selectInParent = (selectedIndices, actions = ACTIONS()) =>
  fromParent({ type: P.ACTIONS_CHANGED, path: 'C:\\s\\a.funscript', actions, selectedIndices, bookmarks: [] });
const fills = () => sent.filter((m) => m.type === P.EDIT_OP && m.op === P.OP_FILL_RANGE);

let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };
let realRaf;

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  const pc = document.createElement('div');
  pc.id = 'player-container';
  document.body.appendChild(pc);
  const ctx = document.createElement('canvas').getContext('2d');
  for (const fn of ['setLineDash', 'getLineDash', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'translate']) {
    if (typeof ctx[fn] !== 'function') ctx[fn] = () => [];
  }
  if (typeof ctx.createLinearGradient !== 'function') ctx.createLinearGradient = () => ({ addColorStop() {} });
  window.funsync = {
    editorPopoutRelay: (direction, payload) => (direction === 'to-parent' ? sent : down).push(payload),
    // The pop-out registers first; the parents below register too.
    onEditorPopoutEvent: (cb) => { if (!onEvent) onEvent = cb; return () => {}; },
    editorPopoutClose() {},
    updateWindowChrome() {},
    editorDirtyChanged() {},
  };
  await import('../../renderer/editor-popout.js');
  await new Promise((r) => setTimeout(r, 0));
  fromParent({
    type: P.INITIAL_STATE,
    scripts: [], activePath: 'C:\\s\\a.funscript',
    actions: ACTIONS(), selectedIndices: [], bookmarks: [],
    videoSrc: '', videoDuration: 60, videoTime: 1, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
    patternFill: { id: 'slow-tip-strokes', endFit: 'stretch', mode: 'replace', join: 0.4, variation: 1 },
  });
}, 20000);

beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  frames = [];
  fillRange.mockClear();
  closeContextMenu();
  selectInParent([2, 10]);
  take();
});
afterEach(() => {
  if (isOpen()) press(document.activeElement || drawer(), 'Escape');
  globalThis.requestAnimationFrame = realRaf;
});

describe('the drawer in the pop-out', () => {
  it('P opens it beside the timeline (the pop-out\'s own), with the remembered options', () => {
    press(canvas(), 'p', { code: 'KeyP' });
    expect(isOpen()).toBe(true);
    expect(drawer().classList.contains('fill-drawer--side')).toBe(true);
    expect(host().classList.contains('fill-drawer-host--open')).toBe(true);
    expect(drawer().contains(document.activeElement)).toBe(true);
    runFrame();
    const call = fillRange.mock.calls.at(-1)[0];
    expect(call.patternId).toBe('slow-tip-strokes');
    expect(call.options.joinSmoothness).toBe(0.4);
    expect(call.selection).toEqual({ startMs: 1000, endMs: 5000 });
    expect(take()).toEqual([]); // previewing sends nothing
  });

  it('the right-click menu and Modify > Fill with Pattern… open it too', () => {
    canvas().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 60, button: 2 }));
    const item = document.querySelector('.editor-context-menu [role="menuitem"]');
    expect(item.textContent).toBe(t('editor.patternFill.menu'));
    item.click();
    expect(isOpen()).toBe(true);
    press(document.activeElement, 'Escape');
    expect(isOpen()).toBe(false);
    const modify = document.querySelector('select.editor__select-menu').nextElementSibling;
    modify.value = 'fillPattern';
    modify.dispatchEvent(new Event('change'));
    expect(isOpen()).toBe(true);
  });

  it('fewer than two selected points: no drawer, a toast in the pop-out', () => {
    selectInParent([3]);
    press(canvas(), 'p', { code: 'KeyP' });
    expect(isOpen()).toBe(false);
    const toast = [...document.querySelectorAll('#toast-container .toast')].at(-1);
    expect(toast?.textContent).toContain(t('editor.patternFill.needSelection'));
  });

  it('slider input: at most one fill per frame, with the last value', () => {
    press(canvas(), 'p', { code: 'KeyP' });
    runFrame();
    fillRange.mockClear();
    const speed = drawer().querySelector('.fill-drawer__row--speed input[type="range"]');
    for (const v of [50, 70, 90, 110]) slide(speed, v);
    expect(fillRange).not.toHaveBeenCalled();
    runFrame();
    expect(fillRange).toHaveBeenCalledTimes(1);
    expect(fillRange.mock.calls[0][0].options.speed).toBe(110);
  });

  it('Esc and Cancel send nothing; the edit keys send nothing while it is open', () => {
    press(canvas(), 'p', { code: 'KeyP' });
    runFrame();
    canvas().focus();
    for (const [key, mods] of [['5', { code: 'Digit5' }], ['Delete', {}], ['z', { ctrl: true, code: 'KeyZ' }], ['ArrowUp', { shift: true }]]) {
      press(canvas(), key, mods);
    }
    expect(take()).toEqual([]);
    press(canvas(), 'Escape'); // closes the drawer, keeps the selection
    expect(isOpen()).toBe(false);
    expect(take()).toEqual([]); // no OP_CLEAR_SELECTION
    press(canvas(), 'p', { code: 'KeyP' });
    drawer().querySelector('.fill-drawer__footer .fill-drawer__btn:not(.fill-drawer__btn--primary)').click();
    expect(isOpen()).toBe(false);
    expect(take()).toEqual([]);
    expect(host().classList.contains('fill-drawer-host--open')).toBe(false);
  });

  it('Apply sends exactly the fill it previewed (OP_FILL_RANGE), with what it was built on, and closes when the parent says it landed', async () => {
    press(canvas(), 'p', { code: 'KeyP' });
    runFrame();
    const res = fillRange.mock.results.at(-1).value;
    drawer().querySelector('.fill-drawer__btn--primary').click();
    const [op] = fills();
    expect(op).toMatchObject({ type: P.EDIT_OP, op: P.OP_FILL_RANGE, t0: 1000, t1: 5000, mode: 'replace', patternId: 'slow-tip-strokes' });
    expect(op.points).toEqual(res.inserted);
    expect(op.options).toEqual({ id: 'slow-tip-strokes', endFit: 'stretch', mode: 'replace', join: 0.4, variation: 1 });
    // The script it was built on (review-2 blocker): the path and the signature.
    expect(op.path).toBe('C:\\s\\a.funscript');
    expect(op.sig).toBe(windowSignature(ACTIONS(), 1000, 5000));
    expect(validFillRange(op)).not.toBeNull();
    // Open (busy) until the parent answers (review-2 minor 7).
    expect(isOpen()).toBe(true);
    fromParent({ type: P.FILL_RESULT, requestId: op.requestId, ok: true });
    await Promise.resolve();
    expect(isOpen()).toBe(false);
  });
});

describe('the parent lands it (OP_FILL_RANGE)', () => {
  let ScriptEditor;
  beforeAll(async () => {
    ({ ScriptEditor } = await import('../../renderer/components/script-editor.js'));
  });
  function parent(stored = {}) {
    const video = Object.assign(new EventTarget(), { currentTime: 1, duration: 60, paused: true, src: '' });
    const store = new Map(Object.entries(stored));
    const ed = new ScriptEditor({
      videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 1 }),
      funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
      progressBar: { renderHeatmap() {} },
      settings: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), store },
    });
    ed.editableScript.loadFromData({ actions: ACTIONS() });
    ed.editableScript.select(2);
    ed.editableScript.toggleSelect(10);
    ed._panel.removeAttribute('inert');
    ed._open = true;
    return ed;
  }

  it('one undo step, the same script as the docked editor\'s own Apply (parity), options remembered and sent back', () => {
    // The pop-out's fill, with a slider moved.
    press(canvas(), 'p', { code: 'KeyP' });
    runFrame();
    slide(drawer().querySelector('.fill-drawer__row--speed input[type="range"]'), 90);
    drawer().querySelector('input[type="radio"][value="partial"]').click();
    runFrame();
    drawer().querySelector('.fill-drawer__btn--primary').click();
    const [op] = fills();

    // The parent, popped out, on the script the pop-out shows: it applies and tells the pop-out.
    const popped = parent();
    popped._popoutOpen = true;
    popped._funscriptPath = 'C:\\s\\a.funscript';
    const before = popped.editableScript.toFunscriptJSON();
    down.length = 0;
    popped._handlePopoutMessage(op);
    const es = popped.editableScript;
    expect(es._undoStack.length).toBe(1);
    expect(es.dirty).toBe(true);
    expect(popped.settings.store.get('editor.patternFill')).toEqual(op.options);
    expect(down.find((m) => m.type === P.SETTINGS)?.patternFill).toEqual(op.options);
    expect(down.find((m) => m.type === P.ACTIONS_CHANGED)?.actions).toEqual(es.actions);
    expect(down.find((m) => m.type === P.FILL_RESULT)).toEqual({ type: P.FILL_RESULT, requestId: op.requestId, ok: true });
    const toast = down.find((m) => m.type === P.TOAST);
    expect(toast.text).toBe(t('editor.patternFill.applied', { name: t('patterns.slow-tip-strokes.name'), count: op.points.length }));

    // The docked editor, same script, same options, its own drawer.
    const docked = parent({ 'editor.patternFill': op.options });
    docked._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true, cancelable: true }));
    runFrame();
    const d = docked._panel.querySelector('.fill-drawer');
    slide(d.querySelector('.fill-drawer__row--speed input[type="range"]'), 90);
    runFrame();
    d.querySelector('.fill-drawer__btn--primary').click();
    expect(docked.editableScript.actions).toEqual(es.actions);

    // And undo there gives the script back exactly.
    es.undo();
    expect(es.toFunscriptJSON()).toBe(before);
    docked._panel.remove();
    popped._panel.remove();
  });

  it('anchors gone from the parent\'s script (it changed on the way): nothing lands, the pop-out is told', () => {
    const ed = parent();
    ed._popoutOpen = true;
    ed._funscriptPath = 'C:\\s\\a.funscript';
    const sig = windowSignature(ed.editableScript.actions, 1000, 5000); // what the pop-out previewed on
    ed.editableScript.deleteActions(new Set([2])); // the point at 1000 goes
    const before = ed.editableScript.toFunscriptJSON();
    const undo = ed.editableScript._undoStack.length;
    down.length = 0;
    ed._handlePopoutMessage({ type: P.EDIT_OP, op: P.OP_FILL_RANGE, t0: 1000, t1: 5000, mode: 'replace', points: [{ at: 1500, pos: 40 }], path: 'C:\\s\\a.funscript', sig, requestId: 7 });
    expect(ed.editableScript.toFunscriptJSON()).toBe(before);
    expect(ed.editableScript._undoStack.length).toBe(undo);
    expect(down.find((m) => m.type === P.TOAST)?.text).toBe(t('editor.patternFill.changed'));
    expect(down.find((m) => m.type === P.FILL_RESULT)).toEqual({ type: P.FILL_RESULT, requestId: 7, ok: false });
    ed._panel.remove();
  });

  it('a payload that is not a valid fill lands nothing, and the pop-out is told', () => {
    const ed = parent();
    ed._popoutOpen = true;
    const before = ed.editableScript.toFunscriptJSON();
    down.length = 0;
    ed._handlePopoutMessage({ type: P.EDIT_OP, op: P.OP_FILL_RANGE, t0: 1000, t1: 5000, mode: 'replace', points: [{ at: 6000, pos: 40 }], sig: 'x', requestId: 8 });
    expect(ed.editableScript.toFunscriptJSON()).toBe(before);
    expect(ed.editableScript.canUndo).toBe(false);
    expect(down.find((m) => m.type === P.TOAST)?.text).toBe(t('editor.patternFill.failed'));
    expect(down.find((m) => m.type === P.FILL_RESULT)).toEqual({ type: P.FILL_RESULT, requestId: 8, ok: false });
    ed._panel.remove();
  });
});

describe('validFillRange (the parent\'s check)', () => {
  const ok = { t0: 1000, t1: 5000, mode: 'replace', points: [{ at: 1200, pos: 0 }, { at: 1500, pos: 100 }], sig: '9:abc' };
  it('takes a sorted fill of whole ms strictly inside (t0, t1) with positions 0-100', () => {
    expect(validFillRange(ok)).toEqual({ ...ok, patternId: null, options: null, path: null, requestId: null });
    expect(validFillRange({ ...ok, mode: 'gap', patternId: 'x', options: { a: 1 }, path: 'C:\\s\\a.funscript', requestId: 3 }))
      .toMatchObject({ mode: 'gap', patternId: 'x', options: { a: 1 }, path: 'C:\\s\\a.funscript', sig: '9:abc', requestId: 3 });
  });
  it('takes fractional anchors, as the docked editor does (review-2 minor 7)', () => {
    expect(validFillRange({ ...ok, t0: 999.5, t1: 5000.4 })).toMatchObject({ t0: 999.5, t1: 5000.4 });
  });
  it.each([
    ['no points', { points: [] }],
    ['not an array', { points: 'x' }],
    ['unsorted', { points: [{ at: 1500, pos: 1 }, { at: 1200, pos: 1 }] }],
    ['a duplicate time', { points: [{ at: 1500, pos: 1 }, { at: 1500, pos: 2 }] }],
    ['on t0', { points: [{ at: 1000, pos: 1 }] }],
    ['on t1', { points: [{ at: 5000, pos: 1 }] }],
    ['outside', { points: [{ at: 6000, pos: 1 }] }],
    ['a fractional time', { points: [{ at: 1200.5, pos: 1 }] }],
    ['a position over 100', { points: [{ at: 1200, pos: 101 }] }],
    ['a position under 0', { points: [{ at: 1200, pos: -1 }] }],
    ['an unknown mode', { mode: 'merge' }],
    ['t1 before t0', { t0: 5000, t1: 1000 }],
    ['a t0 that is not a number', { t0: NaN }],
    ['an infinite t1', { t1: Infinity }],
    ['no signature (what the preview was built on)', { sig: undefined }],
    ['an empty signature', { sig: '' }],
    ['a path that is not text', { path: 5 }],
    ['too many points', { t1: 10 ** 9, points: Array.from({ length: MAX_FILL_POINTS + 1 }, (_, i) => ({ at: 1001 + i, pos: 1 })) }],
  ])('refuses %s', (_, change) => {
    expect(validFillRange({ ...ok, ...change })).toBeNull();
  });
});
