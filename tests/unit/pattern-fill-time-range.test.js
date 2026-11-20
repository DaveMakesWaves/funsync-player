/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its canvas, toolbar and the
 * drawer on the DOM; the rubber band, P, Esc and the right-click menu are
 * real events (notes/CLAUDE.md "Test environments").
 */
// Fill with pattern on a plain time range (Dave, 2026-11-17: "fill with
// fewer than two selected points: allowed on a plain time range"). Docked
// editor:
//
//   - a rubber band over an empty stretch (0 points, or 1) marks its time
//     span as the fill range: shaded on the graph, the selection as the band
//     made it; right-click, P and Modify then open the drawer on it;
//   - the fill joins at the range's edges on the script's own line (or free
//     where no point lies beyond) and keeps the one point the range may hold;
//     Apply is ONE undo step and lands exactly the preview;
//   - Esc (never closing the editor then), a left click on the timeline, any
//     other selection and any edit end the range; right-click keeps it;
//   - two or more selected points: as before (the selection's anchors); a
//     band that spans two or more points in time marks no range;
//   - neither a range nor two points: the action is off and says what to do
//     (the new reason, 8 locales).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange) };
});

const { showToast } = await import('../../renderer/js/toast.js');
const { fillRange } = await import('../../renderer/js/pattern-fill.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const {
  fillWindowOf, rangeFromBand, fillLanding, fillRangeKey, FILL_RANGE_MIN_MS,
} = await import('../../renderer/components/pattern-fill-drawer.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

// Points every 500 ms up to 4 s, nothing from 4 s to 12 s, points again after.
const withGap = () => [
  ...Array.from({ length: 9 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 90 : 10 })),
  ...Array.from({ length: 9 }, (_, i) => ({ at: 12000 + i * 500, pos: i % 2 ? 10 : 80 })),
];
const sel = (es) => [...es.selectedIndices].sort((a, b) => a - b);
const toasts = () => showToast.mock.calls.map((c) => c[0]);

document.body.innerHTML = '<div id="player-container"></div>';

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
});

const editors = [];
function makeEditor(actions = withGap()) {
  for (const old of editors.splice(0)) old._panel.remove();
  const video = Object.assign(new EventTarget(), { currentTime: 1, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 1 });
  const store = new Map();
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: (k) => store.get(k), set: vi.fn((k, v) => store.set(k, v)), store },
  });
  ed.editableScript.loadFromData({ actions });
  ed._panel.removeAttribute('inert');
  ed._open = true;
  ed.graph.setViewport(0, 20000);
  editors.push(ed);
  return ed;
}
const mouse = (ed, type, x, y, o = {}) => ed._canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...o }));
/** A rubber band from time t1 to t2, over positions pos1..pos2 (the whole height by default). */
function band(ed, t1, t2, pos1 = 100, pos2 = 0, o = {}) {
  const g = ed.graph;
  const x1 = g.timeToX(t1), x2 = g.timeToX(t2);
  const y1 = g.posToY(pos1) - 2, y2 = g.posToY(pos2) + 2;
  mouse(ed, 'mousedown', x1, y1, o);
  mouse(ed, 'mousemove', (x1 + x2) / 2, (y1 + y2) / 2, o);
  mouse(ed, 'mousemove', x2, y2, o);
  mouse(ed, 'mouseup', x2, y2, o);
}
const press = (target, key, mods = {}) => {
  const e = new KeyboardEvent('keydown', { key, code: mods.code, bubbles: true, cancelable: true, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift });
  target.dispatchEvent(e);
  return e;
};
const drawer = (ed) => ed._panel.querySelector('.fill-drawer');
const isOpen = (ed) => !!ed._fillDrawer?.isOpen && drawer(ed)?.hidden === false;
const applyBtn = (ed) => drawer(ed).querySelector('.fill-drawer__btn--primary');
const rightClick = (ed) => ed._canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 60, button: 2 }));
const menuItem = () => document.querySelector('.editor-context-menu [role="menuitem"]');
const range = (ed) => ed.graph.timeRange;
/** The script's own line at time t between two points. */
const lineAt = (a, b, t) => a.pos + ((b.pos - a.pos) * (t - a.at)) / (b.at - a.at);

describe('the pure parts', () => {
  const acts = withGap();
  it('rangeFromBand: whole ms, any direction, long enough, at most one point', () => {
    expect(rangeFromBand(acts, 10999.6, 5000.4)).toEqual({ startMs: 5000, endMs: 11000 });
    expect(rangeFromBand(acts, 4100, 4100 + FILL_RANGE_MIN_MS - 1)).toBeNull(); // too short to fill
    expect(rangeFromBand(acts, 3900, 9000)).toEqual({ startMs: 3900, endMs: 9000 }); // one point (4000)
    expect(rangeFromBand(acts, 3400, 9000)).toBeNull(); // two points in it: not a plain range
    expect(rangeFromBand(acts, NaN, 9000)).toBeNull();
    expect(rangeFromBand(acts, -300, 2000 - 1600)).toEqual({ startMs: 0, endMs: 400 }); // never before 0
  });

  it('fillWindowOf: two selected points win; else the range; else nothing', () => {
    const r = { startMs: 5000, endMs: 11000 };
    expect(fillWindowOf(acts, [2, 5], r)).toEqual({ startMs: 1000, endMs: 2500, selected: 2, points: 4 });
    expect(fillWindowOf(acts, [], r)).toEqual({ startMs: 5000, endMs: 11000, selected: 0, points: 0, range: true });
    expect(fillWindowOf(acts, [8], { startMs: 3900, endMs: 9000 })).toEqual({ startMs: 3900, endMs: 9000, selected: 1, points: 1, range: true });
    expect(fillWindowOf(acts, [8], null)).toBeNull();
    expect(fillWindowOf(acts, [], { startMs: 3000, endMs: 9000 })).toBeNull(); // three points in it
  });

  it('fillLanding: a range lands as an insert over a window one ms wider; anchors as before', () => {
    expect(fillLanding({ t0: 5000, t1: 11000, mode: 'replace', range: true })).toEqual({ t0: 4999, t1: 11001, mode: 'gap' });
    expect(fillLanding({ t0: 1000, t1: 2500, mode: 'replace' })).toEqual({ t0: 1000, t1: 2500, mode: 'replace' });
    expect(fillLanding({ t0: 1000, t1: 2500, mode: 'gap' })).toEqual({ t0: 1000, t1: 2500, mode: 'gap' });
  });

  it('fillRangeKey: the selection in any order, plus what the host adds', () => {
    expect(fillRangeKey(new Set([3, 1]), 'x')).toBe(fillRangeKey([1, 3], 'x'));
    expect(fillRangeKey([1, 3], 'x')).not.toBe(fillRangeKey([1, 3], 'y'));
  });
});

describe('a band over an empty stretch marks a time range to fill', () => {
  it('shaded, nothing selected; P opens the drawer on it; Apply is ONE undo step and lands exactly the preview', () => {
    const ed = makeEditor();
    const es = ed.editableScript;
    const json0 = es.toFunscriptJSON();
    band(ed, 5000, 11000);
    expect(sel(es)).toEqual([]);
    const r = range(ed);
    expect(r).not.toBeNull();
    expect(Math.abs(r.from - 5000)).toBeLessThanOrEqual(100);
    expect(Math.abs(r.to - 11000)).toBeLessThanOrEqual(100);
    expect(es.toFunscriptJSON()).toBe(json0); // marking changes nothing

    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(isOpen(ed)).toBe(true);
    runFrame();
    const call = fillRange.mock.calls.at(-1)[0];
    expect(call.selection).toEqual({ startMs: r.from, endMs: r.to });
    expect(drawer(ed).querySelector('.fill-drawer__sel').textContent)
      .toBe(t('editor.patternFill.rangeSelection', { seconds: ((r.to - r.from) / 1000).toFixed(1), count: 0 }));
    expect(t('editor.patternFill.rangeSelection', { seconds: '6.0', count: 0 })).toBe('Time range: 6.0 s, no points');
    const preview = ed._fillDrawer.preview.res;
    expect(preview.inserted.length).toBeGreaterThan(5);
    expect(applyBtn(ed).disabled).toBe(false);

    applyBtn(ed).click();
    expect(isOpen(ed)).toBe(false);
    expect(es._undoStack.length).toBe(1);
    expect(es.actions).toEqual(preview.actions); // exactly the preview, nothing else
    // Every point that was there is still there, untouched.
    for (const a of withGap()) expect(es.actions).toContainEqual(a);
    // Nothing outside the range was added.
    const added = es.actions.filter((a) => !withGap().some((b) => b.at === a.at));
    expect(added.every((a) => a.at >= r.from && a.at <= r.to)).toBe(true);
    // The joins sit on the script's own line (the motion outside does not change).
    const before = { at: 4000, pos: 10 };
    const after = { at: 12000, pos: 80 };
    expect(Math.abs(added[0].pos - lineAt(before, after, added[0].at))).toBeLessThanOrEqual(1);
    expect(Math.abs(added.at(-1).pos - lineAt(before, after, added.at(-1).at))).toBeLessThanOrEqual(1);
    // The new points are the selection now, so the range is over.
    expect(sel(es).length).toBe(added.length);
    expect(range(ed)).toBeNull();

    es.undo();
    expect(es.toFunscriptJSON()).toBe(json0);
  });

  it('one point in the band: it is selected, the range is the band, and the point stays (the fill passes through it)', () => {
    const acts = withGap();
    acts.splice(9, 0, { at: 8000, pos: 50 }); // the stretch's one point
    const ed = makeEditor(acts);
    const es = ed.editableScript;
    band(ed, 5000, 11000);
    expect(sel(es).map((i) => es.actions[i])).toEqual([{ at: 8000, pos: 50 }]);
    expect(range(ed)).not.toBeNull();
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    expect(drawer(ed).querySelector('.fill-drawer__sel').textContent).toContain('1 point');
    const preview = ed._fillDrawer.preview.res;
    expect(preview.removed).toEqual([]);
    applyBtn(ed).click();
    expect(es.actions).toEqual(preview.actions);
    expect(es.actions).toContainEqual({ at: 8000, pos: 50 });
    expect(es.actions.filter((a) => a.at > 5000 && a.at < 8000).length).toBeGreaterThan(1);
    expect(es.actions.filter((a) => a.at > 8000 && a.at < 11000).length).toBeGreaterThan(1);
  });

  it('an empty script: the band marks a range and the fill starts and ends free', () => {
    const ed = makeEditor([]);
    band(ed, 2000, 8000);
    expect(range(ed)).not.toBeNull();
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    const res = ed._fillDrawer.preview.res;
    expect(res.inserted.length).toBeGreaterThan(5);
    applyBtn(ed).click();
    expect(ed.editableScript.actions).toEqual(res.actions);
  });

  it('the right-click menu item is on with a range, says nothing of a reason, and opens the drawer on it', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    ed._canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 200, clientY: 60 }));
    rightClick(ed);
    expect(range(ed)).not.toBeNull(); // right-click keeps it
    const item = menuItem();
    expect(item.hasAttribute('aria-disabled')).toBe(false);
    item.click();
    expect(isOpen(ed)).toBe(true);
    runFrame();
    expect(ed._fillDrawer.preview.win.range).toBe(true);
  });

  it('Modify > Fill with Pattern… opens the drawer on it', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    const modify = ed._panel.querySelector('select[data-i18n-title="editor.modify.title"]');
    modify.value = 'fillPattern';
    modify.dispatchEvent(new Event('change'));
    expect(isOpen(ed)).toBe(true);
  });
});

describe('the range ends', () => {
  it('Esc ends it (and the editor stays open); a second Esc closes the editor as before', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    press(ed._canvas, 'Escape');
    expect(range(ed)).toBeNull();
    expect(ed._open).toBe(true);
    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(isOpen(ed)).toBe(false);
    press(ed._canvas, 'Escape');
    expect(ed._open).toBe(false);
  });

  it('Esc with the one point selected: both go', () => {
    const acts = withGap();
    acts.splice(9, 0, { at: 8000, pos: 50 });
    const ed = makeEditor(acts);
    band(ed, 5000, 11000);
    expect(sel(ed.editableScript).length).toBe(1);
    press(ed._canvas, 'Escape');
    expect(range(ed)).toBeNull();
    expect(sel(ed.editableScript)).toEqual([]);
    expect(ed._open).toBe(true);
  });

  it('a left click on the timeline ends it', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    const x = ed.graph.timeToX(16000);
    mouse(ed, 'mousedown', x, 60);
    mouse(ed, 'mouseup', x, 60);
    expect(range(ed)).toBeNull();
    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(isOpen(ed)).toBe(false);
  });

  it('any other selection ends it (Ctrl+A, a point picked by a command)', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    ed.editableScript.select(3);
    expect(range(ed)).toBeNull();
    band(ed, 5000, 11000);
    expect(range(ed)).not.toBeNull();
    press(ed._canvas, 'a', { ctrl: true });
    expect(range(ed)).toBeNull();
  });

  it('an edit ends it (a point placed, undo)', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    ed.editableScript.insertAction(15500, 40);
    expect(range(ed)).toBeNull();
  });

  it('another script loaded ends it, and the band is not drawn again', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000);
    ed.editableScript.loadFromData({ actions: withGap() });
    expect(ed._currentFillRange()).toBeNull();
    ed.graph.draw();
    expect(range(ed)).toBeNull();
  });

  it('the drawer open on a range: a click elsewhere ends it, the drawer says what to do and Apply is off', () => {
    const ed = makeEditor();
    const json0 = ed.editableScript.toFunscriptJSON();
    band(ed, 5000, 11000);
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    expect(applyBtn(ed).disabled).toBe(false);
    const x = ed.graph.timeToX(16000);
    mouse(ed, 'mousedown', x, 60);
    mouse(ed, 'mouseup', x, 60);
    runFrame();
    expect(isOpen(ed)).toBe(true);
    expect(drawer(ed).querySelector('.fill-drawer__sel').textContent).toBe(t('editor.patternFill.needSelection'));
    expect(applyBtn(ed).disabled).toBe(true);
    applyBtn(ed).click();
    expect(ed.editableScript.toFunscriptJSON()).toBe(json0);
  });
});

describe('with points selected, as before', () => {
  it('a band that selects two or more points marks no range; the fill uses the first and last selected as anchors', () => {
    const ed = makeEditor();
    band(ed, 900, 3100);
    expect(sel(ed.editableScript)).toEqual([2, 3, 4, 5, 6]);
    expect(range(ed)).toBeNull();
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    expect(fillRange.mock.calls.at(-1)[0].selection).toEqual({ startMs: 1000, endMs: 3000 });
    expect(ed._fillDrawer.preview.win.range).toBeUndefined();
  });

  it('a thin band that catches no point but spans two or more in time marks no range', () => {
    const ed = makeEditor();
    band(ed, 900, 3100, 60, 40); // between the 10s and the 90s
    expect(sel(ed.editableScript)).toEqual([]);
    expect(range(ed)).toBeNull();
  });

  it('a Ctrl band (it adds to the selection) marks no range', () => {
    const ed = makeEditor();
    band(ed, 5000, 11000, 100, 0, { ctrlKey: true });
    expect(range(ed)).toBeNull();
  });
});

describe('neither a range nor two points: off, with the new reason', () => {
  it('P toasts it; the menu item is off and says it', () => {
    const ed = makeEditor();
    ed.editableScript.select(3);
    press(ed._canvas, 'p', { code: 'KeyP' });
    expect(isOpen(ed)).toBe(false);
    expect(toasts()).toEqual([t('editor.patternFill.needSelection')]);
    rightClick(ed);
    const item = menuItem();
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(item.getAttribute('aria-describedby')).textContent).toBe(t('editor.patternFill.needSelection'));
    closeContextMenu();
  });

  it('the reason names both ways in, in all 8 languages', () => {
    expect(EN.editor.patternFill.needSelection).toBe('Select at least two points, or drag across an empty stretch of the timeline. The pattern fills the time between.');
    const all = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'].map((l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8')).editor.patternFill);
    for (const pf of all) {
      expect(typeof pf.needSelection).toBe('string');
      expect(typeof pf.rangeSelection).toBe('string');
      expect(pf.rangeSelection).toContain('{seconds}');
      expect(pf.rangeSelection).toContain('=0');
    }
    // No language keeps the old two-points-only wording.
    const old = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')).editor.patternFill.needSelection;
    expect(old).not.toBe('Select at least two points. The pattern fills the time between the first and the last.');
  });
});
