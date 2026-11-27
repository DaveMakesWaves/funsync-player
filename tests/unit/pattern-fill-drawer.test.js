/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar, canvas and the
 * drawer on the DOM, keys and clicks are real events, and script-editor.js
 * imports DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// Fill with pattern, the docked editor's drawer (pattern library, Round 2;
// notes/features/DESIGN-pattern-library.md §f). Asserted on what the user
// does and sees, and on the script it leaves:
//
//   - three ways in: right-click (a small menu, keyboard and Esc friendly,
//     that changes no selection), P on the canvas, Modify > Fill with
//     Pattern…; fewer than two selected points: the action is off and says why;
//     a custom position key bound to P still wins;
//   - LIVE: a slider's `input` events redraw the ghost, at most one fill per
//     animation frame, with the last value;
//   - Esc, Cancel, the X and closing the editor leave the script
//     byte-identical (and clear the ghost); Esc closes the drawer before it
//     would clear the selection;
//   - Apply is exactly one undo step, undo restores exactly, the new points
//     are the selection (N selects them again), and it is an ordinary edit
//     (dirty, autosave);
//   - gap mode keeps every existing point;
//   - the edit keys and the mouse edits wait while the drawer is open, the
//     selection keys work and the preview follows;
//   - the options it remembers (editor.patternFill) are saved on Apply and
//     come back on the next open;
//   - no right-click or left-click behaviour of the canvas changed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
// The REAL fill core, watched: the drawer must call it at most once a frame.
vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange) };
});

const { showToast } = await import('../../renderer/js/toast.js');
const { fillRange } = await import('../../renderer/js/pattern-fill.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { KeyboardHandler } = await import('../../renderer/js/keyboard.js');
const { describePattern } = await import('../../renderer/js/pattern-library.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 90 : 10 }));
const sel = (es) => [...es.selectedIndices].sort((a, b) => a - b);
const toasts = () => showToast.mock.calls.map((c) => c[0]);
const tick = () => new Promise((r) => setTimeout(r, 0));

document.body.innerHTML = '<div id="player-container"></div>';
// The player's own handler, editor gate OFF: a key the editor failed to stop
// would reach the player's action (P = previous video) and show up here.
const player = { onLoadPrev: vi.fn(), onLoadNext: vi.fn() };
new KeyboardHandler({
  videoPlayer: { setLoopPoint() {} },
  scriptEditor: { isOpen: false },
  onLoadPrev: player.onLoadPrev,
  onLoadNext: player.onLoadNext,
});

// Frames run when the test says so: the drawer's throttle is observable.
let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };
let realRaf;
beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  frames = [];
  showToast.mockClear();
  fillRange.mockClear();
  player.onLoadPrev.mockClear();
  _setBundlesForTests('en', EN, EN);
  closeContextMenu();
});
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
});

const editors = [];
function makeEditor(actions = zigzag(17), { customPositionKeys = [], stored = {} } = {}) {
  for (const old of editors.splice(0)) old._panel.remove();
  const video = Object.assign(new EventTarget(), { currentTime: 1, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 1 });
  const store = new Map(Object.entries(stored));
  const settings = {
    get: (k) => (k === 'editor.customPositionKeys' ? customPositionKeys : store.get(k)),
    set: vi.fn((k, v) => store.set(k, v)),
    store,
  };
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings,
  });
  ed.editableScript.loadFromData({ actions });
  ed._panel.removeAttribute('inert');
  ed._open = true; // as after show(); show() itself needs a laid-out window
  ed.graph.setViewport(0, 10000);
  editors.push(ed);
  return ed;
}
/** Select the first and last of a stretch (the anchors). */
function selectStretch(ed, first = 2, last = 10) {
  ed.editableScript.select(first);
  ed.editableScript.toggleSelect(last);
}
const drawer = (ed) => ed._panel.querySelector('.fill-drawer');
const isOpen = (ed) => !!ed._fillDrawer?.isOpen && drawer(ed)?.hidden === false;
const press = (target, key, mods = {}) => {
  const e = new KeyboardEvent('keydown', {
    key, code: mods.code, bubbles: true, cancelable: true,
    shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
  });
  target.dispatchEvent(e);
  return e;
};
const rightClick = (ed) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 80, button: 2 });
  ed._canvas.dispatchEvent(e);
  return e;
};
const menu = () => document.querySelector('.editor-context-menu');
const modifyMenuOf = (ed) => ed._panel.querySelector('select[data-i18n-title="editor.modify.title"]');
const choose = (select, value) => { select.value = value; select.dispatchEvent(new Event('change')); };
const slide = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };
const speedSlider = (ed) => drawer(ed).querySelector('.fill-drawer__row--speed input[type="range"]');
const applyBtn = (ed) => drawer(ed).querySelector('.fill-drawer__btn--primary');
/** Everything a fill could disturb, as plain data. */
const scriptState = (es) => JSON.stringify({
  json: es.toFunscriptJSON(), sel: sel(es), created: es.getCreatedIndices(),
  undo: es._undoStack.length, redo: es._redoStack.length, dirty: es.dirty, revision: es.revision,
});

describe('ways in', () => {
  it('right-click opens a small menu at the pointer that changes no selection; its item opens the drawer', () => {
    const ed = makeEditor();
    selectStretch(ed);
    const before = sel(ed.editableScript);
    // The press itself (button 2) starts nothing.
    ed._canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 300, clientY: 80 }));
    expect(ed._dragMode).toBeNull();
    const e = rightClick(ed);
    expect(e.defaultPrevented).toBe(true); // no browser menu over it
    const m = menu();
    expect(m).not.toBeNull();
    expect(m.getAttribute('role')).toBe('menu');
    expect(m.getAttribute('aria-label')).toBe(t('editor.patternFill.contextMenu'));
    expect(m.style.left).toBe('300px');
    const item = m.querySelector('[role="menuitem"]');
    expect(item.textContent).toBe(t('editor.patternFill.menu'));
    expect(item.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(item); // keyboard-ready
    expect(sel(ed.editableScript)).toEqual(before);
    item.click();
    expect(menu()).toBeNull();
    expect(isOpen(ed)).toBe(true);
    expect(sel(ed.editableScript)).toEqual(before);
  });

  it('the menu is keyboard friendly: Enter chooses, Esc closes it and hands the focus back to the canvas', () => {
    const ed = makeEditor();
    selectStretch(ed);
    rightClick(ed);
    press(document.activeElement, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(ed._canvas);
    expect(isOpen(ed)).toBe(false);
    rightClick(ed);
    press(document.activeElement, 'Enter');
    expect(isOpen(ed)).toBe(true);
  });

  it('with fewer than two selected points the item is off and says why; choosing it does nothing', () => {
    const ed = makeEditor();
    ed.editableScript.select(3);
    rightClick(ed);
    const item = menu().querySelector('[role="menuitem"]');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(item.getAttribute('aria-describedby'));
    expect(hint.textContent).toBe(t('editor.patternFill.needSelection'));
    item.click();
    expect(isOpen(ed)).toBe(false);
    closeContextMenu();
  });

  it('P on the canvas opens it, and never reaches the player (previous video)', () => {
    const ed = makeEditor();
    selectStretch(ed);
    const e = press(ed._canvas, 'p', { code: 'KeyP' });
    expect(e.defaultPrevented).toBe(true);
    expect(isOpen(ed)).toBe(true);
    expect(player.onLoadPrev).not.toHaveBeenCalled();
  });

  it('P with fewer than two selected points: no drawer, a toast that says what to do', () => {
    const ed = makeEditor();
    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(isOpen(ed)).toBe(false);
    expect(toasts()).toEqual([t('editor.patternFill.needSelection')]);
  });

  it('a custom position key bound to P wins: it places a point, no drawer', () => {
    const ed = makeEditor(zigzag(17), { customPositionKeys: [{ code: 'KeyP', mods: {}, position: 35 }] });
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(isOpen(ed)).toBe(false);
    // Placed (or, on the playhead's own point, tweaked) at the key's 35.
    expect(ed.editableScript.actions.some((a) => a.pos === 35)).toBe(true);
  });

  it('Modify > Fill with Pattern… opens it', () => {
    const ed = makeEditor();
    selectStretch(ed);
    const m = modifyMenuOf(ed);
    const opt = [...m.options].find((o) => o.value === 'fillPattern');
    expect(opt.textContent).toBe(t('editor.modify.fillPattern'));
    choose(m, 'fillPattern');
    expect(m.selectedIndex).toBe(0);
    expect(isOpen(ed)).toBe(true);
  });

  it('opens as a non-modal panel and takes the focus (the chosen pattern)', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    const d = drawer(ed);
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('false');
    expect(document.getElementById(d.getAttribute('aria-labelledby')).textContent).toBe(t('editor.patternFill.title'));
    expect(d.contains(document.activeElement)).toBe(true);
    expect(document.activeElement.getAttribute('role')).toBe('option');
    expect(document.activeElement.getAttribute('aria-selected')).toBe('true');
    expect(d.querySelector('.fill-drawer__close').getAttribute('aria-label')).toBe(t('modal.closeAria', { title: t('editor.patternFill.title') }));
    // No modal overlay, the editor stays usable.
    expect(document.querySelector('.modal-overlay')).toBeNull();
    expect(ed._panel.hasAttribute('inert')).toBe(false);
  });
});

describe('the live preview', () => {
  it('slider input events redraw the ghost: one fill per frame, with the last value', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    expect(fillRange).toHaveBeenCalledTimes(1); // the first preview
    expect(ed.graph.ghost).not.toBeNull();
    const first = ed.graph.ghost.points.map((p) => `${p.at}:${p.pos}`).join();

    fillRange.mockClear();
    const s = speedSlider(ed);
    for (const v of [120, 160, 220, 300]) slide(s, v); // a drag: 4 input events in one frame
    expect(fillRange).not.toHaveBeenCalled(); // nothing until the frame
    expect(frames.length).toBe(1); // one frame asked for, not four
    runFrame();
    expect(fillRange).toHaveBeenCalledTimes(1);
    expect(fillRange.mock.calls[0][0].options.speed).toBe(300); // the last value wins
    const second = ed.graph.ghost.points.map((p) => `${p.at}:${p.pos}`).join();
    expect(second).not.toBe(first); // the ghost moved with the slider
    // The read-out follows each input at once.
    expect(drawer(ed).querySelector('.fill-drawer__row--speed output').textContent).toBe(t('editor.patternFill.speedValue', { speed: 300 }));
  });

  it('the ghost is the fill core\'s result over the selected stretch; the script does not change', () => {
    const ed = makeEditor();
    selectStretch(ed);
    const before = scriptState(ed.editableScript);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const res = fillRange.mock.results[0].value;
    const t0 = ed.editableScript.actions[2].at;
    const t1 = ed.editableScript.actions[10].at;
    expect(fillRange.mock.calls[0][0].selection).toEqual({ startMs: t0, endMs: t1 });
    expect(ed.graph.ghost.points).toEqual(res.actions.filter((a) => a.at >= t0 && a.at <= t1));
    expect(ed.graph.ghost.from).toBe(t0);
    expect(ed.graph.ghost.to).toBe(t1);
    expect(scriptState(ed.editableScript)).toBe(before);
    // The summary says it in words: the selection, the result.
    expect(drawer(ed).querySelector('.fill-drawer__sel').textContent)
      .toBe(t('editor.patternFill.selection', { seconds: '4.0', count: 9 }));
    expect(drawer(ed).querySelector('.fill-drawer__stats').textContent)
      .toContain(t('editor.patternFill.stats', { points: res.inserted.length, mean: res.stats.mean, max: res.stats.max }));
  });

  it('every control previews live: pattern, reverse, ramp, range, variation, re-roll, join, end fit, mode', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const d = drawer(ed);
    const last = () => fillRange.mock.calls.at(-1)[0];
    const step = (fn) => { fillRange.mockClear(); fn(); runFrame(); expect(fillRange).toHaveBeenCalledTimes(1); return last(); };

    let call = step(() => d.querySelector('.fill-drawer__row--ramp input[type="checkbox"]').click());
    expect(call.options.ramp).toEqual({ to: Math.round(describePattern(call.patternId).speed) });
    call = step(() => slide(d.querySelector('.fill-drawer__row--ramp input[type="range"]'), 250));
    expect(call.options.ramp).toEqual({ to: 250 });
    call = step(() => d.querySelector('.fill-drawer__check--reverse input').click());
    expect(call.options.reversed).toBe(true);
    call = step(() => d.querySelector('.fill-drawer__check--range-own input').click());
    expect(call.options.range).not.toBeNull();
    call = step(() => slide(d.querySelector('.fill-drawer__range-pair input:first-child'), 30));
    expect(call.options.range.min).toBe(30);
    call = step(() => slide(d.querySelector('.fill-drawer__row--variation input'), 0.4));
    expect(call.options.variation).toBeCloseTo(0.4);
    const seed = call.options.seed;
    call = step(() => d.querySelector('.fill-drawer__row--seed button').click());
    expect(call.options.seed).not.toBe(seed);
    call = step(() => slide(d.querySelector('.fill-drawer__row--join input'), 0.2));
    expect(call.options.joinSmoothness).toBeCloseTo(0.2);
    call = step(() => d.querySelector('input[type="radio"][value="partial"]').click());
    expect(call.options.endFit).toBe('partial');
    call = step(() => d.querySelector('input[type="radio"][value="gap"]').click());
    expect(call.options.mode).toBe('gap');
    // Another pattern: speed, ramp and range go back to its own (design §f).
    const other = d.querySelector('[role="option"][data-id="slow-tip-strokes"]');
    call = step(() => other.click());
    expect(call.patternId).toBe('slow-tip-strokes');
    expect(call.options.speed).toBeNull();
    expect(call.options.ramp).toBeNull();
    expect(call.options.range).toBeNull();
    expect(call.options.reversed).toBe(true); // reverse stays
  });

  it('the pattern list: search and group filter it, arrows move through it and preview as they go', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const d = drawer(ed);
    const names = () => [...d.querySelectorAll('[role="option"]')].map((o) => o.dataset.id);
    expect(names().length).toBe(84); // the 78 of the catalogue and the 6 simple shapes (2026-11-19)
    const family = d.querySelector('.fill-drawer__family');
    choose(family, 'tip-work');
    expect(names().length).toBe(10);
    choose(family, '');
    const search = d.querySelector('.fill-drawer__search');
    search.value = t(describePattern('slow-base-grind').nameKey);
    search.dispatchEvent(new Event('input'));
    expect(names()).toContain('slow-base-grind');
    search.value = 'zzzz-no-such-pattern';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual([]);
    expect(d.querySelector('.fill-drawer__empty').hidden).toBe(false);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    const opts = [...d.querySelectorAll('[role="option"]')];
    opts[0].focus();
    fillRange.mockClear();
    press(opts[0], 'ArrowDown');
    runFrame();
    expect(document.activeElement).toBe(opts[1]);
    expect(opts[1].getAttribute('aria-selected')).toBe('true');
    expect(fillRange.mock.calls.at(-1)[0].patternId).toBe(opts[1].dataset.id);
  });

  it('follows the selection: a new selection previews there; under two points it says so and Apply is off', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    // ArrowDown on the canvas (select the next point) works while open.
    ed.editableScript.select(4);
    ed.editableScript.toggleSelect(14);
    runFrame();
    expect(fillRange.mock.calls.at(-1)[0].selection).toEqual({ startMs: 2000, endMs: 7000 });
    press(ed._canvas, 'ArrowDown');
    runFrame();
    expect(sel(ed.editableScript).length).toBe(1);
    expect(ed.graph.ghost).toBeNull();
    expect(applyBtn(ed).disabled).toBe(true);
    expect(drawer(ed).querySelector('.fill-drawer__sel').textContent).toBe(t('editor.patternFill.needSelection'));
    expect(isOpen(ed)).toBe(true);
  });
});

describe('leaving without applying', () => {
  for (const [how, leave] of [
    ['Esc in the drawer', (ed) => press(document.activeElement, 'Escape')],
    ['Cancel', (ed) => drawer(ed).querySelector('.fill-drawer__footer .fill-drawer__btn:not(.fill-drawer__btn--primary)').click()],
    ['the X', (ed) => drawer(ed).querySelector('.fill-drawer__close').click()],
    ['closing the editor', (ed) => ed.hide()],
  ]) {
    it(`${how} leaves the script byte-identical and clears the ghost`, () => {
      const ed = makeEditor();
      selectStretch(ed);
      const before = scriptState(ed.editableScript);
      press(ed._canvas, 'p', { code: 'KeyP' });
      runFrame();
      slide(speedSlider(ed), 300);
      runFrame();
      expect(ed.graph.ghost).not.toBeNull();
      leave(ed);
      expect(ed._fillDrawer.isOpen).toBe(false);
      expect(drawer(ed).hidden).toBe(true);
      expect(ed.graph.ghost).toBeNull();
      expect(scriptState(ed.editableScript)).toBe(before);
      runFrame(); // nothing pending redraws it
      expect(ed.graph.ghost).toBeNull();
    });
  }

  it('Esc on the canvas closes the drawer first and keeps the selection; the next Esc clears it', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    ed._canvas.focus();
    press(ed._canvas, 'Escape');
    expect(isOpen(ed)).toBe(false);
    expect(sel(ed.editableScript)).toEqual([2, 10]);
    press(ed._canvas, 'Escape');
    expect(sel(ed.editableScript)).toEqual([]);
  });
});

describe('Apply', () => {
  it('is exactly one undo step; undo restores exactly; the new points are the selection; N selects them again', () => {
    const ed = makeEditor();
    selectStretch(ed);
    const es = ed.editableScript;
    const before = scriptState(es);
    const undoDepth = es._undoStack.length;
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const res = fillRange.mock.results.at(-1).value;
    applyBtn(ed).click();
    expect(es._undoStack.length).toBe(undoDepth + 1);
    expect(es.actions).toEqual(res.actions); // what the preview showed
    expect(es.dirty).toBe(true);
    const inserted = new Set(res.inserted.map((p) => p.at));
    expect(sel(es).map((i) => es.actions[i].at)).toEqual([...inserted].sort((a, b) => a - b));
    expect(isOpen(ed)).toBe(false); // the drawer closes on Apply
    expect(ed.graph.ghost).toBeNull();
    expect(toasts().at(-1)).toBe(t('editor.patternFill.applied', {
      name: t(describePattern('quick-full-strokes').nameKey), count: res.inserted.length,
    }));
    es.clearSelection();
    press(ed._canvas, 'n', { code: 'KeyN' });
    expect(sel(es).map((i) => es.actions[i].at)).toEqual([...inserted].sort((a, b) => a - b));
    es.undo();
    // Undo goes back to the state before the fill (the selection N changed
    // after it is not part of that state).
    const after = JSON.parse(scriptState(es));
    const was = JSON.parse(before);
    expect(after.json).toBe(was.json);
    expect(after.sel).toEqual(was.sel);
    expect(after.dirty).toBe(false);
  });

  it('applies the controls as they are NOW even if their frame has not run yet', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    slide(speedSlider(ed), 300); // no frame yet
    applyBtn(ed).click();
    expect(fillRange.mock.calls.at(-1)[0].options.speed).toBe(300);
    expect(ed.editableScript.actions).toEqual(fillRange.mock.results.at(-1).value.actions);
  });

  it('is an ordinary edit: autosave is scheduled like any other', () => {
    const ed = makeEditor();
    ed._autosaveEnabled = true;
    ed._funscriptPath = 'C:\\x\\a.funscript';
    const spy = vi.spyOn(ed, '_triggerAutosave');
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    spy.mockClear();
    applyBtn(ed).click();
    expect(spy).toHaveBeenCalled();
    clearTimeout(ed._autosaveTimer);
  });

  it('gap mode keeps every existing point', () => {
    // Points with a 6 s hole between 2000 and 8000.
    const actions = [...zigzag(5), ...zigzag(5).map((a) => ({ at: a.at + 8000, pos: a.pos }))];
    const ed = makeEditor(actions);
    selectStretch(ed, 1, 8);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    drawer(ed).querySelector('input[type="radio"][value="gap"]').click();
    runFrame();
    applyBtn(ed).click();
    const now = ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`);
    for (const a of actions) expect(now).toContain(`${a.at}:${a.pos}`);
    expect(now.length).toBeGreaterThan(actions.length);
    expect(ed.editableScript.actions.filter((a) => a.at > 2000 && a.at < 8000).length).toBeGreaterThan(0);
  });

  it('remembers the pattern, end fit, mode, join and variation (editor.patternFill) and opens with them next time', () => {
    // A 6 s hole between 2000 and 8000, so gap mode has a gap to fill.
    const ed = makeEditor([...zigzag(5), ...zigzag(5).map((a) => ({ at: a.at + 8000, pos: a.pos }))]);
    selectStretch(ed, 1, 8);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const d = drawer(ed);
    d.querySelector('[role="option"][data-id="slow-tip-strokes"]').click();
    d.querySelector('input[type="radio"][value="partial"]').click();
    d.querySelector('input[type="radio"][value="gap"]').click();
    slide(d.querySelector('.fill-drawer__row--join input'), 0.3);
    slide(d.querySelector('.fill-drawer__row--variation input'), 1.4);
    slide(speedSlider(ed), 100); // not remembered: speed starts at the pattern's own
    runFrame();
    applyBtn(ed).click();
    const saved = ed.settings.store.get('editor.patternFill');
    expect(saved).toEqual({ id: 'slow-tip-strokes', endFit: 'partial', mode: 'gap', join: 0.3, variation: 1.4 });

    const ed2 = makeEditor(zigzag(17), { stored: { 'editor.patternFill': saved } });
    selectStretch(ed2);
    press(ed2._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const call = fillRange.mock.calls.at(-1)[0];
    expect(call.patternId).toBe('slow-tip-strokes');
    expect(call.options).toMatchObject({ endFit: 'partial', mode: 'gap', joinSmoothness: 0.3, variation: 1.4, speed: null });
    const d2 = drawer(ed2);
    expect(d2.querySelector('input[type="radio"][value="gap"]').checked).toBe(true);
    expect(d2.querySelector('[aria-selected="true"]').dataset.id).toBe('slow-tip-strokes');
  });

  it('the store\'s default (electron/store.js) is the design\'s, the drawer\'s own, and today\'s behaviour (nothing chosen yet)', async () => {
    const { DEFAULTS } = await import('../../electron/store.js');
    const { PATTERN_FILL_DEFAULTS } = await import('../../renderer/components/pattern-fill-drawer.js');
    expect(DEFAULTS.settings.editor.patternFill).toEqual({ id: null, endFit: 'stretch', mode: 'replace', join: 0.5, variation: 1 });
    expect({ ...PATTERN_FILL_DEFAULTS }).toEqual(DEFAULTS.settings.editor.patternFill);
  });

  it('a stored value that makes no sense opens with the defaults (absence is never an error)', () => {
    const ed = makeEditor(zigzag(17), { stored: { 'editor.patternFill': { id: 'no-such', mode: 'x', join: 7, variation: 'a' } } });
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const call = fillRange.mock.calls.at(-1)[0];
    expect(call.patternId).toBe('quick-full-strokes');
    expect(call.options).toMatchObject({ endFit: 'stretch', mode: 'replace', joinSmoothness: 1, variation: 1 });
  });
});

describe('editing pauses while the drawer is open', () => {
  it('Delete, position keys, nudges, undo and Alt+click insert do nothing; the script is unchanged', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    const before = scriptState(ed.editableScript);
    for (const [key, mods] of [
      ['Delete', {}], ['5', { code: 'Digit5' }], ['-', { code: 'Minus' }], ['ArrowUp', { shift: true }],
      ['ArrowLeft', { shift: true }], ['z', { ctrl: true, code: 'KeyZ' }], ['q', { code: 'KeyQ' }],
      ['e', { code: 'KeyE' }], ['b', { code: 'KeyB' }], ['End', {}], ['Home', {}], ['x', { ctrl: true, code: 'KeyX' }],
    ]) {
      const e = press(ed._canvas, key, mods);
      expect(e.defaultPrevented, key).toBe(true);
    }
    ed._canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, altKey: true, clientX: 100, clientY: 50 }));
    expect(scriptState(ed.editableScript)).toBe(before);
    expect(isOpen(ed)).toBe(true);
  });

  it('a key typed in the drawer stays there (the search box takes "5", nothing is placed)', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    const before = scriptState(ed.editableScript);
    const search = drawer(ed).querySelector('.fill-drawer__search');
    search.focus();
    for (const [key, code] of [['5', 'Digit5'], ['p', 'KeyP'], ['n', 'KeyN'], ['Delete', 'Delete'], [' ', 'Space']]) {
      press(search, key, { code });
    }
    expect(scriptState(ed.editableScript)).toBe(before);
    expect(player.onLoadPrev).not.toHaveBeenCalled();
    expect(isOpen(ed)).toBe(true);
  });

  it('after Apply or Cancel the keys edit again', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    drawer(ed).querySelector('.fill-drawer__close').click();
    const count = ed.editableScript.actionCount;
    press(ed._canvas, 'Delete');
    expect(ed.editableScript.actionCount).toBe(count - 2);
  });
});

describe('its words', () => {
  const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
  /** Every word the drawer shows: text, tooltips, accessible names, placeholders. */
  const words = (root) => {
    const out = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim());
      for (const a of ['title', 'aria-label', 'placeholder']) if (el.getAttribute(a)) out.push(el.getAttribute(a).trim());
    }
    return out;
  };
  const englishOnly = (s) => {
    const flat = [];
    (function walk(o) { for (const v of Object.values(o)) { if (typeof v === 'string') flat.push(v); else if (v && typeof v === 'object') walk(v); } })(EN.editor.patternFill);
    return flat.includes(s);
  };

  it('in German every word is German (no raw key, no English), and a live switch follows', async () => {
    const { eventBus } = await import('../../renderer/js/event-bus.js');
    _setBundlesForTests('de', DE, EN);
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const d = drawer(ed);
    const w = words(d);
    expect(w.filter((s) => /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/.test(s))).toEqual([]);
    expect(w.filter((s) => englishOnly(s) && !Object.values(DE.editor.patternFill).includes(s))).toEqual([]);
    expect(d.querySelector('.fill-drawer__title').textContent).toBe(DE.editor.patternFill.title);
    expect(applyBtn(ed).textContent).toBe(DE.editor.patternFill.apply);
    // Back to English while it is open: the stamped words and the written ones follow.
    _setBundlesForTests('en', EN, EN);
    eventBus.emit('language:changed', 'en');
    const { translatePage } = await import('../../renderer/js/i18n.js');
    translatePage(ed._panel); // what the editor's own language:changed listener does
    expect(d.querySelector('.fill-drawer__title').textContent).toBe(EN.editor.patternFill.title);
    // The unit as the rest of en.json writes it (review-2 nit: it said "u/s").
    expect(d.querySelector('.fill-drawer__row--speed output').textContent).toMatch(/ units\/s$/);
    expect(d.querySelector('.fill-drawer__close').getAttribute('aria-label')).toBe(t('modal.closeAria', { title: EN.editor.patternFill.title }));
  });
});

describe('the drawer and the rest of the editor', () => {
  it('sits over the video above the docked editor and the controls bar (the timeline keeps its width and does not move)', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(drawer(ed).classList.contains('fill-drawer--above')).toBe(true);
    expect(ed._panel.classList.contains('fill-drawer-host--open')).toBe(false);
    const css = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    // On the player's controls bar, not over it (review-2 minor 6; the lift
    // itself: pattern-fill-drawer-fixup.test.js).
    expect(css).toMatch(/\.fill-drawer--above\s*{[^}]*bottom:\s*calc\(100% \+ var\(--fill-drawer-lift, 0px\)\)/);
  });

  it('is listed in the ? overlay as P', async () => {
    const { getEditorShortcutGroups } = await import('../../renderer/js/keyboard-help.js');
    const rows = getEditorShortcutGroups().flatMap((g) => g.rows);
    expect(rows).toContainEqual(['P', t('kbd.editorFillPattern')]);
  });

  it('a pop-out taking over cancels an open drawer here', () => {
    const ed = makeEditor();
    selectStretch(ed);
    const before = scriptState(ed.editableScript);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    ed._fillDrawer.close('cancel'); // what the pop-out 'opened' event does first
    expect(ed.graph.ghost).toBeNull();
    expect(scriptState(ed.editableScript)).toBe(before);
  });

  it('loading another script cancels it (nothing previewed on the old one lands)', () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    ed.loadScript();
    expect(ed._fillDrawer.isOpen).toBe(false);
    expect(ed.graph.ghost).toBeNull();
  });

  it('the selection commands still work with the drawer open (Ctrl+A here), and the preview follows', async () => {
    const ed = makeEditor();
    selectStretch(ed);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    press(ed._canvas, 'a', { ctrl: true, code: 'KeyA' });
    runFrame();
    expect(fillRange.mock.calls.at(-1)[0].selection).toEqual({ startMs: 0, endMs: 8000 });
    await tick();
  });
});

// Editor work list 4.7 (2026-11-24): Tempo sets the Speed from a BPM, or from
// the beat markers inside the stretch.
describe('Fill with pattern: Tempo (work list 4.7)', () => {
  it('a BPM sets the Speed to one stroke per beat over the depth; From the beats reads the markers', () => {
    const ed = makeEditor();
    selectStretch(ed, 2, 10);
    press(ed._canvas, 'p');
    expect(isOpen(ed)).toBe(true);
    const fd = ed._fillDrawer;
    const s = fd._state;
    const depth = Math.abs(s.rangeMax - s.rangeMin) || 100;
    fd._bpm.value = '120';
    fd._bpm.dispatchEvent(new Event('change'));
    const want = Math.max(s.speedMin, Math.min(s.speedMax, Math.round(depth * 2)));
    expect(s.speed).toBe(want);
    expect(Number(fd._speed.input.value)).toBe(want);
    // Beats every 600 ms inside the stretch: 100 BPM.
    const acts = ed.editableScript.actions;
    const from = acts[2].at;
    const beats = Float64Array.from({ length: 8 }, (_, i) => from + i * 600);
    ed.graph.setBeatMarkers(beats);
    fd._bpmBeats.click();
    expect(fd._bpm.value).toBe('100');
    // Out of range: says so, the speed stays.
    const before = s.speed;
    fd._bpm.value = '900';
    fd._bpm.dispatchEvent(new Event('change'));
    expect(s.speed).toBe(before);
    expect(fd._tempoNote.textContent).toContain('300');
  });
});
