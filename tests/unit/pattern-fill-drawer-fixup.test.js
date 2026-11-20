/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar, canvas and the
 * drawer on the DOM, keys and clicks are real events, and script-editor.js
 * imports DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// Fill with pattern, the docked editor: the review-2 fix-up (2026-11-17).
//
//   - SCRIPT IDENTITY (blocker): a preview drawn on one script never lands on
//     another. The drawer closes after the waits of a script switch and of
//     Don't save; Apply checks the window and the signature of its points
//     against the script and selection as they are NOW and refuses with the
//     'changed' toast; a load by any route closes it (the script's load id).
//   - Fractional times: the docked Apply keeps a fractional anchor and lands
//     exactly the ghost (minor 7, with the pop-out's check).
//   - The right-click menu in fullscreen, and the focus back on the canvas
//     (minor 4).
//   - Keys: only the edit keys wait while the drawer is open; the player's
//     keys go on; a slider keeps its arrows, a button its Space; the drawer
//     stands on the controls bar (minor 6).
//   - The preview's cost: a slow preview runs in a module Worker with request
//     ids (only the latest answer shows), Apply lands what the controls say,
//     and without a Worker a slow preview waits for the slider to settle
//     (minor 5).
//   - The summary is read out once it settles; the list's observer goes on
//     close (nits).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange), realFillRange: real.fillRange };
});

const { showToast } = await import('../../renderer/js/toast.js');
const { fillRange, realFillRange } = await import('../../renderer/js/pattern-fill.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const {
  PatternFillDrawer, windowSignature, fillBasisRange, fillSelectionOf, fillDrawerKeyVerdict,
} = await import('../../renderer/components/pattern-fill-drawer.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const zigzag = (n, step = 500, lo = 10, hi = 90) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? hi : lo }));
const toasts = () => showToast.mock.calls.map((c) => c[0]);
const CHANGED = () => t('editor.patternFill.changed');

document.body.innerHTML = '<div id="player-container"></div>';
const playerContainer = document.getElementById('player-container');

let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };
let realRaf;
beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  frames = [];
  showToast.mockClear();
  fillRange.mockClear();
  _setBundlesForTests('en', EN, EN);
  closeContextMenu();
});
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.Worker;
});

const editors = [];
function makeEditor(actions = zigzag(17)) {
  for (const old of editors.splice(0)) { old._fillDrawer?.close('cancel'); old._panel.remove(); }
  const video = Object.assign(new EventTarget(), { currentTime: 1, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 1 });
  const store = new Map();
  const settings = { get: (k) => (k === 'editor.customPositionKeys' ? [] : store.get(k)), set: vi.fn((k, v) => store.set(k, v)), store };
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings,
  });
  ed.editableScript.loadFromData({ actions });
  ed._panel.removeAttribute('inert');
  ed._open = true;
  ed.graph.setViewport(0, 10000);
  editors.push(ed);
  return ed;
}
const selectStretch = (ed, first = 2, last = 10) => { ed.editableScript.select(first); ed.editableScript.toggleSelect(last); };
const drawerEl = (ed) => ed._panel.querySelector('.fill-drawer');
const isOpen = (ed) => !!ed._fillDrawer?.isOpen && drawerEl(ed)?.hidden === false;
const applyBtn = (ed) => drawerEl(ed).querySelector('.fill-drawer__btn--primary');
const speedSlider = (ed) => drawerEl(ed).querySelector('.fill-drawer__row--speed input[type="range"]');
const slide = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };
const press = (target, key, mods = {}) => {
  const e = new KeyboardEvent('keydown', {
    key, code: mods.code, bubbles: true, cancelable: true,
    shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
  });
  target.dispatchEvent(e);
  return e;
};
const json = (es) => JSON.stringify(es.actions);
function openOn(ed, first = 2, last = 10) {
  selectStretch(ed, first, last);
  press(ed._canvas, 'p', { code: 'KeyP' });
  runFrame();
  expect(isOpen(ed)).toBe(true);
}

const A = 'C:/v/scene.funscript';
const B = 'C:/v/scene.roll.funscript';
// B: an axis made together with A, so the SAME times, other positions.
const B_ACTIONS = zigzag(17, 500, 40, 60);

describe('script identity (review-2 blocker, docked)', () => {
  it('a script switch: a drawer opened while the new file is read closes when it loads, and nothing lands on it', async () => {
    const ed = makeEditor();
    ed._funscriptPath = A;
    ed.setAvailableScripts([{ label: 'A', path: A }, { label: 'B', path: B }]);
    let resolveRead;
    window.funsync = { readFunscript: vi.fn(() => new Promise((r) => { resolveRead = r; })) };
    selectStretch(ed);
    const switching = ed.selectScript(B);
    await Promise.resolve();
    // A is still on screen: the user presses P and sees A's preview.
    expect(ed._openPatternFill()).toBe(true);
    runFrame();
    expect(ed._fillDrawer.preview.res.inserted.length).toBeGreaterThan(0);
    resolveRead(JSON.stringify({ actions: B_ACTIONS }));
    await switching;
    expect(ed._funscriptPath).toBe(B);
    expect(ed._fillDrawer.isOpen).toBe(false);
    expect(ed.graph.ghost).toBeNull();
    const before = json(ed.editableScript);
    expect(ed._fillDrawer.apply()).toBe(false);
    applyBtn(ed).click();
    expect(json(ed.editableScript)).toBe(before);
    expect(ed.editableScript.dirty).toBe(false);
  });

  it('Don\'t save: a drawer open over the discarded edits closes after the reload, and nothing lands', async () => {
    const ed = makeEditor();
    ed._funscriptPath = A;
    window.funsync = { readFunscript: vi.fn(async () => JSON.stringify({ actions: zigzag(17) })) };
    ed.editableScript.insertAction(1250, 50); // an unsaved edit
    openOn(ed, 2, 11);
    await ed._discardUnsavedChanges();
    expect(ed._fillDrawer.isOpen).toBe(false);
    expect(ed.graph.ghost).toBeNull();
    const before = json(ed.editableScript);
    applyBtn(ed).click();
    expect(json(ed.editableScript)).toBe(before);
    expect(before).toBe(JSON.stringify(zigzag(17)));
  });

  it('Apply checks what the preview was built on: an edit in the window it has not caught up with is refused with "changed", and the drawer previews the new state', () => {
    const ed = makeEditor();
    openOn(ed);
    const shown = ed._fillDrawer.preview;
    ed.editableScript.updateAction(5, { pos: 33 }); // in the window; its frame has not run
    const before = json(ed.editableScript);
    const undo = ed.editableScript._undoStack.length;
    applyBtn(ed).click();
    expect(json(ed.editableScript)).toBe(before);
    expect(ed.editableScript._undoStack.length).toBe(undo);
    expect(toasts()).toContain(CHANGED());
    expect(isOpen(ed)).toBe(true); // the settings stay
    runFrame();
    expect(ed._fillDrawer.preview.sig).not.toBe(shown.sig);
    expect(ed._fillDrawer.preview.sig).toBe(windowSignature(ed.editableScript.actions, 1000, 5000));
    // Now it matches: Apply lands, one undo step.
    applyBtn(ed).click();
    expect(ed.editableScript._undoStack.length).toBe(undo + 1);
    expect(isOpen(ed)).toBe(false);
  });

  it('a selection moved since the preview is refused too (the ghost on screen is not what would land)', () => {
    const ed = makeEditor();
    openOn(ed);
    ed.editableScript.select(4);
    ed.editableScript.toggleSelect(12); // its frame has not run
    const before = json(ed.editableScript);
    applyBtn(ed).click();
    expect(json(ed.editableScript)).toBe(before);
    expect(toasts()).toContain(CHANGED());
    expect(isOpen(ed)).toBe(true);
  });

  it('a load by any route is another script: the drawer closes on the next refresh and never applies across it', () => {
    const ed = makeEditor();
    openOn(ed);
    const id = ed.editableScript.loadId;
    // The same points, reloaded (no route that closes the drawer itself).
    ed.editableScript.loadFromData({ actions: zigzag(17) });
    ed.editableScript._selectedIndices = new Set([2, 10]);
    expect(ed.editableScript.loadId).not.toBe(id);
    const before = json(ed.editableScript);
    applyBtn(ed).click();
    expect(json(ed.editableScript)).toBe(before);
    expect(ed.editableScript.canUndo).toBe(false);
    expect(toasts()).toContain(CHANGED());
    expect(ed._fillDrawer.isOpen).toBe(false);
    // And through refresh (what an onChange does).
    openOn(ed);
    ed.editableScript.loadEmpty();
    ed._fillDrawer.refresh();
    expect(ed._fillDrawer.isOpen).toBe(false);
  });

  it('the load id changes on every load and never on an edit, undo or selection change', () => {
    const es = new EditableScript();
    const ids = [es.loadId];
    es.loadFromData({ actions: zigzag(5) }); ids.push(es.loadId);
    es.insertAction(100, 50); es.undo(); es.selectAll(); ids.push(es.loadId);
    es.loadEmpty(); ids.push(es.loadId);
    es.clear(); ids.push(es.loadId);
    es.loadFromEngine({ getActions: () => zigzag(3), getMetadata: () => null }); ids.push(es.loadId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[1]);
    expect(new Set(ids.slice(2)).size).toBe(4);
  });

  it('the signature covers the window and one neighbour each side, and nothing else', () => {
    const acts = zigzag(17);
    const sig = windowSignature(acts, 1000, 5000);
    const edit = (i, pos) => acts.map((a, k) => (k === i ? { ...a, pos } : a));
    expect(windowSignature(zigzag(17), 1000, 5000)).toBe(sig);
    expect(windowSignature(edit(5, 33), 1000, 5000)).not.toBe(sig); // inside
    expect(windowSignature(edit(1, 33), 1000, 5000)).not.toBe(sig); // the neighbour before (the fill reads it)
    expect(windowSignature(edit(11, 33), 1000, 5000)).not.toBe(sig); // the neighbour after
    expect(windowSignature(edit(0, 33), 1000, 5000)).toBe(sig); // further out: not read
    expect(windowSignature(edit(14, 33), 1000, 5000)).toBe(sig);
    expect(windowSignature(zigzag(17, 500, 40, 60), 1000, 5000)).not.toBe(sig); // another axis, same times
    expect(fillBasisRange(acts, 1000, 5000)).toEqual({ from: 1, to: 12 });
    expect(fillBasisRange(acts, 0, 8000)).toEqual({ from: 0, to: 17 });
  });
});

describe('fractional times (review-2 minor 7, docked side)', () => {
  const frac = () => zigzag(17).map((a) => ({ at: a.at + 0.4, pos: a.pos }));

  it('replaceRange keeps fractional anchors (it rounded them, and the anchor at x.4 counted as inside)', () => {
    const es = new EditableScript();
    es.loadFromData({ actions: frac() });
    es.replaceRange(1000.4, 5000.4, [{ at: 2000, pos: 50 }, { at: 3000, pos: 60 }]);
    const ats = es.actions.map((a) => a.at);
    expect(ats).toContain(1000.4);
    expect(ats).toContain(5000.4);
    expect(ats.filter((at) => at > 1000.4 && at < 5000.4)).toEqual([2000, 3000]);
  });

  it('the docked Apply lands exactly the ghost on a script with fractional times, anchors kept', () => {
    const ed = makeEditor(zigzag(17).map((a) => ({ at: a.at + 0.5, pos: a.pos })));
    openOn(ed);
    const { res, win } = ed._fillDrawer.preview;
    expect(fillRange.mock.calls.at(-1)[0].selection).toEqual(fillSelectionOf(win));
    const ghost = ed.graph.ghost.points.map((a) => ({ at: a.at, pos: a.pos }));
    expect(ghost[0]).toEqual({ at: 1000.5, pos: 10 }); // the fill joins the selected anchor
    applyBtn(ed).click();
    expect(ed.editableScript.actions.map((a) => ({ at: a.at, pos: a.pos }))).toEqual(res.actions);
    const inWindow = ed.editableScript.actions.filter((a) => a.at >= 1000.5 && a.at <= 5000.5);
    expect(inWindow).toEqual(ghost);
  });
});

describe('the right-click menu (review-2 minor 4)', () => {
  const rightClick = (ed) => ed._canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 80, button: 2 }));

  it('opens inside the fullscreen element while one is up (a fixed menu in the body is not drawn over it)', () => {
    const ed = makeEditor();
    selectStretch(ed);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => playerContainer });
    try {
      rightClick(ed);
      const menu = document.querySelector('.editor-context-menu');
      expect(menu.parentElement).toBe(playerContainer);
    } finally {
      delete document.fullscreenElement;
    }
    closeContextMenu();
    rightClick(ed);
    expect(document.querySelector('.editor-context-menu').parentElement).toBe(document.body);
  });

  it('closed by a click elsewhere or the window losing focus, it gives the focus back to the canvas', () => {
    const ed = makeEditor();
    selectStretch(ed);
    rightClick(ed);
    expect(document.activeElement.closest('.editor-context-menu')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.editor-context-menu')).toBeNull();
    expect(document.activeElement).toBe(ed._canvas);
    rightClick(ed);
    window.dispatchEvent(new Event('blur'));
    expect(document.querySelector('.editor-context-menu')).toBeNull();
    expect(document.activeElement).toBe(ed._canvas);
  });
});

describe('keys while the drawer is open (review-2 minor 6)', () => {
  let seen;
  const onDoc = (e) => seen.push({ key: e.key, prevented: e.defaultPrevented });
  beforeEach(() => { seen = []; document.addEventListener('keydown', onDoc); });
  afterEach(() => document.removeEventListener('keydown', onDoc));

  it('on the timeline the player\'s keys go on (F, F11, M, K, J, L, H, S, I); the edit keys wait', () => {
    const ed = makeEditor();
    openOn(ed);
    ed._canvas.focus();
    const before = json(ed.editableScript);
    for (const k of ['f', 'F11', 'm', 'k', 'j', 'l', 'h', 's', 'i']) press(ed._canvas, k);
    expect(seen.map((s) => s.key)).toEqual(['f', 'F11', 'm', 'k', 'j', 'l', 'h', 's', 'i']);
    expect(seen.every((s) => !s.prevented)).toBe(true);
    seen = [];
    for (const [k, m] of [['Delete', {}], ['5', { code: 'Digit5' }], ['z', { ctrl: true }], ['y', { ctrl: true }], ['x', { ctrl: true }],
      ['v', { ctrl: true }], ['i', { ctrl: true }], ['b', {}], ['q', {}], ['e', {}], ['Home', {}], ['End', {}],
      ['ArrowUp', { shift: true }], ['ArrowLeft', { shift: true }], ['ArrowDown', { ctrl: true }]]) {
      const e = press(ed._canvas, k, m);
      expect(e.defaultPrevented).toBe(true);
    }
    expect(seen).toEqual([]);
    expect(json(ed.editableScript)).toBe(before);
    expect(ed.editableScript.getBookmarks()).toEqual([]);
    expect(isOpen(ed)).toBe(true);
  });

  it('the verdict lists only the edit set: an unknown key is allowed', () => {
    const v = (key, m = {}) => fillDrawerKeyVerdict(new KeyboardEvent('keydown', { key, ...m }));
    expect(['f', 'F', 'F11', 'm', 'k', 'j', 'l', 'h', 'g', 'F5', ' ', 'n', 'r', 'w', '?', '[', 'ArrowLeft', 'ArrowUp'].map((k) => v(k))).toEqual(Array(18).fill('allow'));
    expect(v('ArrowLeft', { ctrlKey: true, altKey: true, shiftKey: true })).toBe('allow'); // a selection command
    expect(v('Escape')).toBe('close');
    expect(v('p')).toBe('focus');
    expect(fillDrawerKeyVerdict(new KeyboardEvent('keydown', { key: '7' }), { isPositionKey: true })).toBe('block');
  });

  it('in the drawer: a slider keeps its arrows, Space on it goes to the player; a button and the search box keep their keys', () => {
    const ed = makeEditor();
    openOn(ed);
    const speed = speedSlider(ed);
    speed.focus();
    press(speed, 'ArrowRight');
    press(speed, 'Home');
    expect(seen).toEqual([]);
    press(speed, ' ');
    press(speed, 'f');
    expect(seen.map((s) => s.key)).toEqual([' ', 'f']);
    seen = [];
    const reroll = drawerEl(ed).querySelector('.fill-drawer__row--seed button');
    reroll.focus();
    press(reroll, ' ');
    press(reroll, 'Enter');
    const search = drawerEl(ed).querySelector('.fill-drawer__search');
    search.focus();
    press(search, '5');
    press(search, ' ');
    expect(seen).toEqual([]);
    expect(isOpen(ed)).toBe(true);
  });

  it('the docked drawer stands on the player\'s controls bar (its height measured), not over it', () => {
    const bar = document.createElement('div');
    bar.className = 'player__controls';
    bar.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 800, height: 112 });
    playerContainer.appendChild(bar);
    try {
      const ed = makeEditor();
      openOn(ed);
      expect(drawerEl(ed).style.getPropertyValue('--fill-drawer-lift')).toBe('112px');
    } finally {
      bar.remove();
    }
  });
});

// A stand-in for the module Worker: it records what it is asked; the test
// answers with the REAL fill core, in the order it wants.
class FakeWorker {
  static all = [];
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.posted = [];
    this.terminated = false;
    FakeWorker.all.push(this);
  }
  postMessage(m) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  answer(m = this.posted.at(-1), ms = 50) {
    const res = realFillRange({ actions: m.actions, selection: m.selection, patternId: m.patternId, options: m.options });
    this.onmessage({ data: { id: m.id, res, ms } });
    return res;
  }
}

describe('the preview\'s cost (review-2 minor 5): a module Worker, the latest answer only', () => {
  beforeEach(() => { FakeWorker.all = []; globalThis.Worker = FakeWorker; });

  it('a pattern not measured yet previews in the Worker (the real worker file, as a module), not on this thread', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const [w] = FakeWorker.all;
    expect(w.url).toMatch(/\/renderer\/js\/pattern-fill-worker\.js(\?|$)/);
    expect(w.opts).toEqual({ type: 'module' });
    expect(fillRange).not.toHaveBeenCalled();
    expect(w.posted).toHaveLength(1);
    // Only the part of the script the fill reads goes over.
    expect(w.posted[0].actions).toEqual(zigzag(17).slice(1, 12));
    const updating = drawerEl(ed).querySelector('.fill-drawer__updating');
    expect(updating.hidden).toBe(false);
    expect(updating.textContent).toBe(t('editor.patternFill.updating'));
    const res = w.answer();
    expect(updating.hidden).toBe(true);
    expect(ed._fillDrawer.preview.res.inserted).toEqual(res.inserted);
    expect(ed.graph.ghost.points.length).toBeGreaterThan(0);
  });

  it('one request in flight; moves meanwhile only bump the id; a stale answer is dropped and the latest controls go next', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    for (const v of [60, 90, 120]) { slide(speedSlider(ed), v); runFrame(); }
    expect(w.posted).toHaveLength(1); // still the first in flight
    w.answer(w.posted[0]);
    // Not the latest, but newer than nothing on screen: shown while the
    // latest is on its way (live fix-up 2026-11-17: a heavy preview stood
    // still during a drag; pattern-fill-drawer-live.test.js).
    expect(ed._fillDrawer.preview.reqId).toBe(w.posted[0].id);
    expect(drawerEl(ed).querySelector('.fill-drawer__updating').hidden).toBe(false);
    expect(w.posted).toHaveLength(2);
    expect(w.posted[1].options.speed).toBe(120); // the last value
    const res = w.answer(w.posted[1]);
    expect(ed._fillDrawer.preview.options.speed).toBe(120);
    expect(ed._fillDrawer.preview.res.inserted).toEqual(res.inserted);
    expect(drawerEl(ed).querySelector('.fill-drawer__updating').hidden).toBe(true);
    // An answer after close is dropped too.
    slide(speedSlider(ed), 140); runFrame();
    ed._fillDrawer.close('cancel');
    w.answer(w.posted.at(-1));
    expect(ed.graph.ghost).toBeNull();
  });

  it('Apply lands the Worker\'s fill when it matches the controls and the script, with nothing run on this thread', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    const res = w.answer();
    applyBtn(ed).click();
    expect(fillRange).not.toHaveBeenCalled();
    expect(ed.editableScript._undoStack.length).toBe(1);
    expect(ed.editableScript.actions.filter((a) => a.at > 1000 && a.at < 5000)).toEqual(res.inserted);
    // The same as the core run on the whole script (the Worker read only its part).
    expect(ed.editableScript.actions).toEqual(realFillRange({
      actions: zigzag(17), selection: { startMs: 1000, endMs: 5000 },
      patternId: w.posted[0].patternId, options: w.posted[0].options,
    }).actions);
    expect(isOpen(ed)).toBe(false);
  });

  it('Apply with the controls moved past the Worker\'s answer waits (busy) for the fill of what they say now, then lands it', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    w.answer();
    // The pattern is measured slow (50 ms over 4 s): it stays in the Worker.
    slide(speedSlider(ed), 150);
    applyBtn(ed).click(); // its frame has not run
    runFrame();
    expect(ed.editableScript.canUndo).toBe(false);
    expect(drawerEl(ed).getAttribute('aria-busy')).toBe('true');
    expect(applyBtn(ed).disabled).toBe(true);
    expect(w.posted.at(-1).options.speed).toBe(150);
    const res = w.answer(w.posted.at(-1));
    expect(ed.editableScript._undoStack.length).toBe(1);
    expect(ed.editableScript.actions.filter((a) => a.at > 1000 && a.at < 5000)).toEqual(res.inserted);
    expect(isOpen(ed)).toBe(false);
    expect(fillRange).not.toHaveBeenCalled();
  });

  it('a pattern measured quick on a short window previews on this thread (no round trip)', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    w.answer(w.posted[0], 1); // 1 ms over 4 s
    slide(speedSlider(ed), 90);
    runFrame();
    expect(fillRange).toHaveBeenCalledTimes(1);
    expect(w.posted).toHaveLength(1);
    expect(ed._fillDrawer.preview.options.speed).toBe(90);
  });

  it('a Worker that fails to load: previews run here; a slow one then waits until the slider settles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const [w] = FakeWorker.all;
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 40)); // every fill "takes" 40 ms
    w.onerror({ message: 'blocked', preventDefault() {} });
    expect(w.terminated).toBe(true);
    expect(fillRange).toHaveBeenCalledTimes(1); // the waiting preview, here
    fillRange.mockClear();
    for (const v of [60, 80, 100]) { slide(speedSlider(ed), v); runFrame(); }
    expect(fillRange).not.toHaveBeenCalled();
    expect(drawerEl(ed).querySelector('.fill-drawer__updating').hidden).toBe(false);
    vi.advanceTimersByTime(200);
    expect(fillRange).toHaveBeenCalledTimes(1);
    expect(fillRange.mock.calls[0][0].options.speed).toBe(100);
    expect(drawerEl(ed).querySelector('.fill-drawer__updating').hidden).toBe(true);
    // Apply still lands what the controls say, here and now.
    slide(speedSlider(ed), 130);
    applyBtn(ed).click();
    expect(fillRange.mock.calls.at(-1)[0].options.speed).toBe(130);
    expect(ed.editableScript._undoStack.length).toBe(1);
  });
});

describe('the worker module itself', () => {
  it('answers a request with the fill core\'s result and its id', async () => {
    const posted = [];
    const prev = self.onmessage;
    const spy = vi.spyOn(self, 'postMessage').mockImplementation((m) => posted.push(m));
    try {
      await import('../../renderer/js/pattern-fill-worker.js');
      const actions = zigzag(17).slice(1, 12);
      self.onmessage({ data: { id: 7, actions, selection: { startMs: 1000, endMs: 5000 }, patternId: 'quick-full-strokes', options: {} } });
      const want = realFillRange({ actions, selection: { startMs: 1000, endMs: 5000 }, patternId: 'quick-full-strokes', options: {} });
      expect(posted[0].id).toBe(7);
      expect(posted[0].res.inserted).toEqual(want.inserted);
      expect(Number.isFinite(posted[0].ms)).toBe(true);
    } finally {
      spy.mockRestore();
      self.onmessage = prev;
    }
  });
});

describe('nits', () => {
  it('the summary is read out once it settles, not on every preview frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ed = makeEditor();
    openOn(ed);
    const summary = drawerEl(ed).querySelector('.fill-drawer__summary');
    const live = drawerEl(ed).querySelector('[aria-live="polite"]');
    expect(summary.hasAttribute('aria-live')).toBe(false);
    expect(live.classList.contains('fill-drawer__announce')).toBe(true);
    for (const v of [60, 80, 100, 120]) { slide(speedSlider(ed), v); runFrame(); vi.advanceTimersByTime(100); }
    expect(live.textContent).toBe('');
    vi.advanceTimersByTime(600);
    expect(live.textContent).toContain(drawerEl(ed).querySelector('.fill-drawer__stats').textContent);
  });

  it('closing disconnects the pattern list\'s observer', () => {
    const made = [];
    globalThis.IntersectionObserver = class { constructor() { this.off = 0; made.push(this); } observe() {} unobserve() {} disconnect() { this.off++; } };
    try {
      const ed = makeEditor();
      openOn(ed);
      const last = made.at(-1);
      const before = last.off;
      ed._fillDrawer.close('cancel');
      expect(last.off).toBe(before + 1);
    } finally {
      delete globalThis.IntersectionObserver;
    }
  });

  it('the chosen option uses the accent token, not a colour of its own', () => {
    const css = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    const rule = css.match(/\.fill-drawer__option\[aria-selected="true"\]\s*{([^}]*)}/)[1];
    expect(rule).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(rule).not.toMatch(/rgba?\(/);
  });

  it('a drawer built by hand with no Worker support previews on this thread, as before', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const graph = { setGhost: vi.fn(), clearGhost: vi.fn(), draw() {}, viewStartMs: 0, viewEndMs: 10000, viewDurationMs: 10000, setViewport() {} };
    const d = new PatternFillDrawer({
      container, graph, getActions: () => zigzag(17), getSelectedIndices: () => [2, 10], onApply: () => true, createWorker: null,
    });
    d.open();
    runFrame();
    expect(fillRange).toHaveBeenCalledTimes(1);
    expect(graph.setGhost).toHaveBeenCalled();
    d.destroy();
    container.remove();
  });
});
