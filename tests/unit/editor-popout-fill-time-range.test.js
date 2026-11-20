/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js) on the DOM of editor-popout.html, and the REAL
 * parent ScriptEditor that lands its OP_FILL_RANGE.
 */
// Fill with pattern on a plain time range, in the pop-out (Dave,
// 2026-11-17: fewer than two selected points are allowed on a plain range).
//
//   - a rubber band over an empty stretch asks the parent for its selection
//     (OP_SELECT) and marks its time span once that selection is back
//     (ACTIONS_CHANGED): shaded, then P opens the pop-out's drawer on it;
//   - Apply sends OP_FILL_RANGE with range: true, the path and the
//     signature; the parent lands it as ONE undo step, the same script as
//     the docked editor's own Apply on the same range (parity);
//   - the parent's identity check still holds for a range fill: another
//     path, or other points in the window, and nothing lands;
//   - Esc and any other selection end the range here too.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

const { t, _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { windowSignature } = await import('../../renderer/components/pattern-fill-drawer.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');
const { ActionGraph } = await import('../../renderer/js/action-graph.js');
const { validFillRange } = await import('../../renderer/js/editor-popout-dispatch.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const withGap = () => [
  ...Array.from({ length: 9 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 90 : 10 })),
  ...Array.from({ length: 9 }, (_, i) => ({ at: 12000 + i * 500, pos: i % 2 ? 10 : 80 })),
];
const A = 'C:\\s\\scene.funscript';
const SCRIPTS = [{ label: 'Stroke', path: A }];

const sent = [];
const down = [];
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const host = () => document.getElementById('editor-popout-host');
const canvas = () => host().querySelector('canvas.editor__canvas');
const drawer = () => host().querySelector('.fill-drawer');
const isOpen = () => drawer()?.hidden === false;
const take = () => sent.splice(0, sent.length);
const fills = () => sent.filter((m) => m.type === P.EDIT_OP && m.op === P.OP_FILL_RANGE);
const applyBtn = () => drawer().querySelector('.fill-drawer__btn--primary');
const pressKey = (key, code) => canvas().dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
const lastToast = () => [...document.querySelectorAll('#toast-container .toast')].at(-1)?.textContent || '';

let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };
let realRaf;
let drawSpy;
let popGraph;

/** The parent shows its script with this selection (ACTIONS_CHANGED). */
function parentShows(actions, selected = []) {
  fromParent({ type: P.ACTIONS_CHANGED, path: A, actions, selectedIndices: selected, bookmarks: [] });
}
const mouse = (type, x, y) => canvas().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
/** A rubber band in the pop-out from t1 to t2 over the whole height. */
function band(t1, t2) {
  const x1 = popGraph.timeToX(t1), x2 = popGraph.timeToX(t2);
  const y1 = popGraph.posToY(100) - 2, y2 = popGraph.posToY(0) + 2;
  mouse('mousedown', x1, y1);
  mouse('mousemove', x2, y2);
  mouse('mouseup', x2, y2);
}
/** The parent's answer to the band's OP_SELECT: it selects what was asked and echoes it. */
function echoSelect() {
  const op = sent.filter((m) => m.type === P.EDIT_OP && m.op === P.OP_SELECT).at(-1);
  expect(op).toBeTruthy();
  parentShows(withGap(), op.indices);
  return op.indices;
}

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
    onEditorPopoutEvent: (cb) => { if (!onEvent) onEvent = cb; return () => {}; },
    editorPopoutClose() {},
    updateWindowChrome() {},
    editorDirtyChanged() {},
  };
  drawSpy = vi.spyOn(ActionGraph.prototype, 'draw');
  await import('../../renderer/editor-popout.js');
  await new Promise((r) => setTimeout(r, 0));
  fromParent({
    type: P.INITIAL_STATE,
    scripts: SCRIPTS, activePath: A,
    actions: withGap(), selectedIndices: [], bookmarks: [],
    videoSrc: '', videoDuration: 60, videoTime: 1, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
    patternFill: null,
  });
  popGraph = drawSpy.mock.contexts.find((g) => g?.canvas === canvas());
  expect(popGraph).toBeTruthy();
}, 20000);

beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  frames = [];
  closeContextMenu();
  if (isOpen()) drawer().querySelector('.fill-drawer__close').click();
  pressKey('Escape', 'Escape'); // no range left from the last test
  parentShows(withGap(), []);
  popGraph.setViewport(0, 20000);
  take();
  down.length = 0;
});
afterEach(() => {
  if (isOpen()) drawer().querySelector('.fill-drawer__close').click();
  globalThis.requestAnimationFrame = realRaf;
});

describe('a band in the pop-out marks a time range', () => {
  it('it holds once the parent has the band\'s selection back; then P opens the drawer on it', () => {
    band(5000, 11000);
    const op = sent.find((m) => m.type === P.EDIT_OP && m.op === P.OP_SELECT);
    expect(op.indices).toEqual([]);
    // Not before the parent's answer: the selection is the parent's to make.
    expect(popGraph.timeRange).toBeNull();
    echoSelect();
    const r = popGraph.timeRange;
    expect(r).not.toBeNull();
    expect(Math.abs(r.from - 5000)).toBeLessThanOrEqual(100);
    pressKey('p', 'KeyP');
    expect(isOpen()).toBe(true);
    runFrame();
    expect(drawer().querySelector('.fill-drawer__sel').textContent)
      .toBe(t('editor.patternFill.rangeSelection', { seconds: ((r.to - r.from) / 1000).toFixed(1), count: 0 }));
  });

  it('Esc ends it; P then says what to do', () => {
    band(5000, 11000);
    echoSelect();
    expect(popGraph.timeRange).not.toBeNull();
    pressKey('Escape', 'Escape');
    expect(popGraph.timeRange).toBeNull();
    pressKey('p', 'KeyP');
    expect(isOpen()).toBe(false);
    expect(lastToast()).toContain(t('editor.patternFill.needSelection'));
  });

  it('any other selection from the parent ends it', () => {
    band(5000, 11000);
    echoSelect();
    parentShows(withGap(), [3]);
    expect(popGraph.timeRange).toBeNull();
  });

  it('an answer with another selection than the band asked for marks nothing', () => {
    band(5000, 11000);
    parentShows(withGap(), [4]);
    expect(popGraph.timeRange).toBeNull();
    parentShows(withGap(), []);
    expect(popGraph.timeRange).toBeNull();
  });

  it('the right-click menu item is on with it', () => {
    band(5000, 11000);
    echoSelect();
    canvas().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 60, button: 2 }));
    const item = document.querySelector('.editor-context-menu [role="menuitem"]');
    expect(item.hasAttribute('aria-disabled')).toBe(false);
    item.click();
    expect(isOpen()).toBe(true);
  });
});

// ---- the parent ----
let ScriptEditor;
const parents = [];
afterEach(() => { for (const p of parents.splice(0)) p._panel.remove(); });
function parent(path = A, actions = withGap()) {
  const video = Object.assign(new EventTarget(), { currentTime: 1, duration: 60, paused: true, src: '' });
  const store = new Map();
  const ed = new ScriptEditor({
    videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 1 }),
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), store },
  });
  ed.editableScript.loadFromData({ actions });
  ed._panel.removeAttribute('inert');
  ed._open = true;
  ed._popoutOpen = true;
  ed._funscriptPath = path;
  ed.graph.setViewport(0, 20000);
  parents.push(ed);
  return ed;
}

describe('Apply: OP_FILL_RANGE with range: true, landed by the parent', () => {
  beforeAll(async () => {
    ({ ScriptEditor } = await import('../../renderer/components/script-editor.js'));
  });

  function rangeFill() {
    band(5000, 11000);
    echoSelect();
    pressKey('p', 'KeyP');
    runFrame();
    take();
    applyBtn().click();
    const [op] = fills();
    expect(op).toBeTruthy();
    return op;
  }

  it('the payload: the range, its path and signature, edge points ON its edges', () => {
    const op = rangeFill();
    const r = popGraph.timeRange;
    expect(op.range).toBe(true);
    expect(op.path).toBe(A);
    expect([op.t0, op.t1]).toEqual([r.from, r.to]);
    expect(op.sig).toBe(windowSignature(withGap(), op.t0, op.t1));
    expect(op.points[0].at).toBe(op.t0); // the join on the script's line, at the edge
    expect(op.points.at(-1).at).toBe(op.t1);
    expect(validFillRange(op)).not.toBeNull();
    // Without range: true the same points are refused (an anchor fill keeps strictly inside).
    expect(validFillRange({ ...op, range: false })).toBeNull();
  });

  it('the parent lands it as ONE undo step, every point kept, the same as the docked editor\'s own Apply (parity)', () => {
    const op = rangeFill();
    const popped = parent();
    const json0 = popped.editableScript.toFunscriptJSON();
    down.length = 0;
    popped._handlePopoutMessage(op);
    const es = popped.editableScript;
    expect(down.find((m) => m.type === P.FILL_RESULT)).toEqual({ type: P.FILL_RESULT, requestId: op.requestId, ok: true });
    expect(es._undoStack.length).toBe(1);
    for (const a of withGap()) expect(es.actions).toContainEqual(a);
    expect(es.actions.length).toBe(withGap().length + op.points.length);

    // The docked editor: the same band, the same (default) options, its own drawer.
    const docked = parent();
    docked._popoutOpen = false;
    const g = docked.graph;
    const md = (type, x, y) => docked._canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    md('mousedown', g.timeToX(op.t0), g.posToY(100) - 2);
    md('mousemove', g.timeToX(op.t1), g.posToY(0) + 2);
    md('mouseup', g.timeToX(op.t1), g.posToY(0) + 2);
    expect(g.timeRange).toEqual({ from: op.t0, to: op.t1 });
    docked._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true, cancelable: true }));
    runFrame();
    docked._panel.querySelector('.fill-drawer__btn--primary').click();
    expect(docked.editableScript.actions).toEqual(es.actions);

    es.undo();
    expect(es.toFunscriptJSON()).toBe(json0);
  });

  it('another path: nothing lands, the pop-out is told', () => {
    const op = rangeFill();
    const other = parent('C:\\s\\other.funscript');
    const json0 = other.editableScript.toFunscriptJSON();
    down.length = 0;
    other._handlePopoutMessage(op);
    expect(other.editableScript.toFunscriptJSON()).toBe(json0);
    expect(down.find((m) => m.type === P.FILL_RESULT)?.ok).toBe(false);
    expect(down.find((m) => m.type === P.TOAST)?.text).toBe(t('editor.patternFill.changed'));
  });

  it('a point added in the range since the preview: nothing lands (the signature)', () => {
    const op = rangeFill();
    const changed = parent(A, [...withGap(), { at: 8000, pos: 50 }].sort((a, b) => a.at - b.at));
    const json0 = changed.editableScript.toFunscriptJSON();
    down.length = 0;
    changed._handlePopoutMessage(op);
    expect(changed.editableScript.toFunscriptJSON()).toBe(json0);
    expect(down.find((m) => m.type === P.FILL_RESULT)?.ok).toBe(false);
  });
});

describe('validFillRange with range: true', () => {
  const base = { t0: 5000, t1: 11000, mode: 'replace', sig: '2:ab', range: true };
  it('takes points on and between the edges, sorted; refuses one outside', () => {
    expect(validFillRange({ ...base, points: [{ at: 5000, pos: 40 }, { at: 8000, pos: 60 }, { at: 11000, pos: 50 }] })).toMatchObject({ range: true });
    expect(validFillRange({ ...base, points: [{ at: 4999, pos: 40 }] })).toBeNull();
    expect(validFillRange({ ...base, points: [{ at: 11001, pos: 40 }] })).toBeNull();
    expect(validFillRange({ ...base, points: [{ at: 8000, pos: 40 }, { at: 8000, pos: 41 }] })).toBeNull();
  });
  it('an anchor fill (no range) is checked as before and carries no range flag', () => {
    const anchor = { ...base, range: undefined, points: [{ at: 8000, pos: 40 }] };
    expect(validFillRange(anchor)).not.toHaveProperty('range');
    expect(validFillRange({ ...anchor, points: [{ at: 5000, pos: 40 }] })).toBeNull();
  });
});
