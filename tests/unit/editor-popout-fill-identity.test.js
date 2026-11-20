/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js) on the DOM of editor-popout.html, and the REAL
 * parent ScriptEditor that lands its OP_FILL_RANGE.
 */
// Fill with pattern in the pop-out: the review-2 fix-up (2026-11-17).
//
//   - The parent lands a pop-out fill only on the script it was built on:
//     the same path, the same points (the signature the pop-out sends), and
//     no script switch under way. Multi-axis scripts share their times, so
//     "both anchors still exist" was also true on another axis (blocker).
//   - The pop-out's drawer closes when the parent switches script (its real
//     message order: scripts-changed, then actions-changed; minor 3) and
//     when the user picks another script in the pop-out's own list.
//   - Apply waits for the parent's answer: a refusal keeps the drawer and
//     the user's settings (minor 7), and fractional times land the same as
//     in the docked editor.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

const { t, _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { windowSignature } = await import('../../renderer/components/pattern-fill-drawer.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const zigzag = (n, step = 500, lo = 10, hi = 90) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? hi : lo }));
const A = 'C:\\s\\scene.funscript';
const B = 'C:\\s\\scene.roll.funscript';
const A_ACTIONS = () => zigzag(17);
const B_ACTIONS = () => zigzag(17, 500, 40, 60); // the roll axis: the same times
const SCRIPTS = [{ label: 'Stroke', path: A }, { label: 'Roll', path: B }];

const sent = []; // pop-out -> parent
const down = []; // parent -> pop-out
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const host = () => document.getElementById('editor-popout-host');
const canvas = () => host().querySelector('canvas.editor__canvas');
const drawer = () => host().querySelector('.fill-drawer');
const isOpen = () => drawer()?.hidden === false;
const take = () => sent.splice(0, sent.length);
const fills = () => sent.filter((m) => m.type === P.EDIT_OP && m.op === P.OP_FILL_RANGE);
const applyBtn = () => drawer().querySelector('.fill-drawer__btn--primary');
const speed = () => drawer().querySelector('.fill-drawer__row--speed input[type="range"]');
const slide = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };
const pressP = () => canvas().dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true, cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };
let realRaf;

/** The parent's script in the pop-out, two points selected (the parent's own order on a switch: scripts, then actions). */
function parentShows(path, actions, selected = [2, 10]) {
  fromParent({ type: P.SCRIPTS_CHANGED, scripts: SCRIPTS, activePath: path });
  fromParent({ type: P.ACTIONS_CHANGED, path, actions, selectedIndices: selected, bookmarks: [] });
}

/** Open the drawer on what the pop-out shows and Apply: the OP_FILL_RANGE it sends. */
function previewAndApply() {
  pressP();
  runFrame();
  expect(isOpen()).toBe(true);
  take();
  applyBtn().click();
  const [op] = fills();
  expect(op).toBeTruthy();
  return op;
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
  await import('../../renderer/editor-popout.js');
  await new Promise((r) => setTimeout(r, 0));
  fromParent({
    type: P.INITIAL_STATE,
    scripts: SCRIPTS, activePath: A,
    actions: A_ACTIONS(), selectedIndices: [], bookmarks: [],
    videoSrc: '', videoDuration: 60, videoTime: 1, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
    patternFill: null,
  });
}, 20000);

beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  frames = [];
  closeContextMenu();
  parentShows(A, A_ACTIONS());
  take();
  down.length = 0;
});
afterEach(() => {
  if (isOpen()) drawer().querySelector('.fill-drawer__close').click();
  globalThis.requestAnimationFrame = realRaf;
  vi.useRealTimers();
});

// ---- the parent ----
let ScriptEditor;
beforeAll(async () => {
  ({ ScriptEditor } = await import('../../renderer/components/script-editor.js'));
});
const parents = [];
afterEach(() => { for (const p of parents.splice(0)) p._panel.remove(); });
function parent(path, actions) {
  const video = Object.assign(new EventTarget(), { currentTime: 1, duration: 60, paused: true, src: '' });
  const store = new Map();
  const ed = new ScriptEditor({
    videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 1 }),
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), store },
  });
  ed.editableScript.loadFromData({ actions });
  ed._funscriptPath = path;
  ed._panel.removeAttribute('inert');
  ed._open = true;
  ed._popoutOpen = true;
  parents.push(ed);
  return ed;
}
const answerOf = (requestId) => down.find((m) => m.type === P.FILL_RESULT && m.requestId === requestId);
const lastToast = () => down.filter((m) => m.type === P.TOAST).at(-1)?.text;

describe('the pop-out drawer follows the parent\'s script (review-2 minor 3)', () => {
  it('a parent switch, in its real order (scripts-changed, then actions-changed), closes the drawer', () => {
    pressP();
    runFrame();
    expect(isOpen()).toBe(true);
    fromParent({ type: P.SCRIPTS_CHANGED, scripts: SCRIPTS, activePath: B });
    expect(isOpen()).toBe(false);
    fromParent({ type: P.ACTIONS_CHANGED, path: B, actions: B_ACTIONS(), selectedIndices: [2, 10], bookmarks: [] });
    runFrame();
    expect(isOpen()).toBe(false);
    expect(take().filter((m) => m.type === P.EDIT_OP)).toEqual([]);
  });

  it('a pick in the pop-out\'s own script list closes it at once (before the parent has read the file)', () => {
    pressP();
    runFrame();
    const select = host().querySelector('select');
    const list = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === B));
    list.value = B;
    list.dispatchEvent(new Event('change'));
    expect(isOpen()).toBe(false);
    expect(take()).toContainEqual(expect.objectContaining({ type: 'script-switch', path: B }));
    expect(select).toBeTruthy();
  });
});

describe('the parent lands a pop-out fill only on the script it was built on (review-2 blocker)', () => {
  it('the op names its script and the signature of what it read', () => {
    const op = previewAndApply();
    expect(op.path).toBe(A);
    expect(op.sig).toBe(windowSignature(A_ACTIONS(), 1000, 5000));
    expect(op.requestId).toEqual(expect.any(Number));
  });

  it('another axis with the same times, loaded meanwhile: nothing lands, the pop-out is told', () => {
    const op = previewAndApply();
    const ed = parent(B, B_ACTIONS());
    const before = JSON.stringify(ed.editableScript.actions);
    ed._handlePopoutMessage(op);
    expect(JSON.stringify(ed.editableScript.actions)).toBe(before);
    expect(ed.editableScript.canUndo).toBe(false);
    expect(lastToast()).toBe(t('editor.patternFill.changed'));
    expect(answerOf(op.requestId)).toEqual({ type: P.FILL_RESULT, requestId: op.requestId, ok: false });
  });

  it('the same points under another path (a copy, an axis written the same): refused on the path', () => {
    const op = previewAndApply();
    const ed = parent(B, A_ACTIONS());
    ed._handlePopoutMessage(op);
    expect(ed.editableScript.canUndo).toBe(false);
    expect(answerOf(op.requestId).ok).toBe(false);
  });

  it('the same path with other points in the window or beside it: refused on the signature', () => {
    const op = previewAndApply();
    const moved = A_ACTIONS().map((a, i) => (i === 11 ? { ...a, pos: 50 } : a)); // the neighbour after t1
    const ed = parent(A, moved);
    ed._handlePopoutMessage(op);
    expect(ed.editableScript.canUndo).toBe(false);
    expect(lastToast()).toBe(t('editor.patternFill.changed'));
  });

  it('while the parent\'s switch is under way (its autosave flush, the path not moved yet): refused, and nothing is lost to the load', async () => {
    const op = previewAndApply();
    const ed = parent(A, A_ACTIONS());
    ed.setAvailableScripts(SCRIPTS);
    ed.editableScript.insertAction(8250, 30); // unsaved, outside the window
    ed.hasUnsavedChanges = () => false; // autosave handles it: no question
    ed._autosaveEnabled = true;
    ed._autosaveTimer = setTimeout(() => {}, 60000);
    let flushDone;
    ed._autosave = vi.fn(() => new Promise((r) => { flushDone = r; }));
    window.funsync.readFunscript = vi.fn(async () => JSON.stringify({ actions: B_ACTIONS() }));
    const switching = ed.selectScript(B);
    await Promise.resolve();
    expect(ed._funscriptPath).toBe(A); // still A, still A's points
    const before = JSON.stringify(ed.editableScript.actions);
    const undo = ed.editableScript._undoStack.length;
    ed._handlePopoutMessage(op);
    expect(JSON.stringify(ed.editableScript.actions)).toBe(before);
    expect(ed.editableScript._undoStack.length).toBe(undo);
    expect(answerOf(op.requestId).ok).toBe(false);
    flushDone();
    await switching;
    expect(ed._funscriptPath).toBe(B);
    delete window.funsync.readFunscript;
  });

  it('on its own script, unchanged, it lands as one undo step and the pop-out hears it landed', () => {
    const op = previewAndApply();
    const ed = parent(A, A_ACTIONS());
    ed._handlePopoutMessage(op);
    expect(ed.editableScript._undoStack.length).toBe(1);
    expect(ed.editableScript.actions.filter((a) => a.at > 1000 && a.at < 5000)).toEqual(op.points);
    expect(answerOf(op.requestId).ok).toBe(true);
  });
});

describe('Apply waits for the parent\'s answer (review-2 minor 7)', () => {
  it('a refusal keeps the drawer open with the user\'s settings; it can apply again', async () => {
    pressP();
    runFrame();
    slide(speed(), 90);
    runFrame();
    take();
    applyBtn().click();
    const [op] = fills();
    expect(op.options).toBeTruthy();
    expect(isOpen()).toBe(true);
    expect(applyBtn().disabled).toBe(true); // busy until the answer
    fromParent({ type: P.TOAST, text: t('editor.patternFill.changed'), level: 'warn' });
    fromParent({ type: P.FILL_RESULT, requestId: op.requestId, ok: false });
    await flush();
    expect(isOpen()).toBe(true);
    expect(speed().value).toBe('90');
    expect(drawer().getAttribute('aria-busy')).toBe('false');
    runFrame();
    expect(applyBtn().disabled).toBe(false);
    take();
    applyBtn().click();
    expect(fills()).toHaveLength(1);
    expect(fills()[0].requestId).not.toBe(op.requestId);
  });

  it('an answer that never comes gives the controls back after a while (as refused)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pressP();
    runFrame();
    applyBtn().click();
    expect(applyBtn().disabled).toBe(true);
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(isOpen()).toBe(true);
    expect(drawer().getAttribute('aria-busy')).toBe('false');
  });

  it('the parent\'s own echo while it waits does not redraw a preview over the fill; the answer closes it', async () => {
    const op = previewAndApply();
    const ed = parent(A, A_ACTIONS());
    down.length = 0;
    ed._handlePopoutMessage(op);
    // What the parent sent, in its order: the echo (ACTIONS_CHANGED), then the answer.
    for (const m of down.filter((x) => x.type === P.ACTIONS_CHANGED || x.type === P.FILL_RESULT)) fromParent(m);
    await flush();
    runFrame();
    expect(isOpen()).toBe(false);
  });
});

describe('fractional times land the same in both editors (review-2 minor 7)', () => {
  it('a script with times like 1000.5: the pop-out\'s Apply lands in the parent exactly as the docked editor\'s own Apply', () => {
    const frac = () => A_ACTIONS().map((a) => ({ at: a.at + 0.5, pos: a.pos }));
    parentShows(A, frac());
    const op = previewAndApply();
    expect(op.t0).toBe(1000.5);
    const popped = parent(A, frac());
    popped._handlePopoutMessage(op);
    expect(answerOf(op.requestId).ok).toBe(true);
    expect(popped.editableScript._undoStack.length).toBe(1);

    const docked = parent(A, frac());
    docked._popoutOpen = false;
    docked.editableScript.select(2);
    docked.editableScript.toggleSelect(10);
    docked._canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true, cancelable: true }));
    runFrame();
    docked._panel.querySelector('.fill-drawer__btn--primary').click();
    expect(docked.editableScript.actions).toEqual(popped.editableScript.actions);
    // The anchors stay.
    expect(popped.editableScript.actions.map((a) => a.at)).toEqual(expect.arrayContaining([1000.5, 5000.5]));
  });
});
