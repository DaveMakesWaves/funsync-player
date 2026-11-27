/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar, canvas and the
 * drawer on the DOM, keys are real events, and script-editor.js imports
 * DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// Fill with pattern: the live verifier's finds (2026-11-17), fixed.
//
//   - PLACE (major): in a short window or at a large interface size the
//     docked drawer went off the top of the window (150 % at 1280x800: top
//     -60 px, body 16 px). dockedDrawerPlacement picks a place that keeps
//     the title in the window and the body at its minimum: on the controls
//     bar when there is room, else on the editor's edge over the bar's right
//     end, else at the side beside the (narrowed) timeline.
//   - KEYS: the focus lands in the pattern list on open, and the list kept
//     every key, so F, M, K did nothing until the timeline was clicked. It
//     keeps only its own keys now (the drawer's rule and keyboard.js's).
//   - WORKER: a heavy preview stood still during a drag (every answer that
//     came while the slider moved was dropped). An answer newer than the one
//     on screen shows; the last one always matches the controls.
//   - Words: "Replaces N points." on its own line; the group's whole name
//     on hover.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange), realFillRange: real.fillRange };
});

const { fillRange, realFillRange } = await import('../../renderer/js/pattern-fill.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const {
  dockedDrawerPlacement, FILL_DRAWER_MIN_BODY_PX, FILL_DRAWER_CHROME_PX, FILL_DRAWER_MAX_PX, drawerControlOwnsKey,
} = await import('../../renderer/components/pattern-fill-drawer.js');
const { targetOwnsKey } = await import('../../renderer/js/keyboard.js');
const { closeContextMenu } = await import('../../renderer/js/editor-context-menu.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];

const zigzag = (n, step = 500, lo = 10, hi = 90) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? hi : lo }));

document.body.innerHTML = '<div id="player-container"><div class="player__top-bar"></div><div class="player__controls"></div></div>';
const playerContainer = document.getElementById('player-container');
const topBar = playerContainer.querySelector('.player__top-bar');
const bar = playerContainer.querySelector('.player__controls');

let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };
let realRaf;
beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  frames = [];
  fillRange.mockClear();
  _setBundlesForTests('en', EN, EN);
  closeContextMenu();
});
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
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
  if (ed._panel.parentElement !== playerContainer) playerContainer.appendChild(ed._panel);
  editors.push(ed);
  return ed;
}
const selectStretch = (ed, first = 2, last = 10) => { ed.editableScript.select(first); ed.editableScript.toggleSelect(last); };
const drawerEl = (ed) => ed._panel.querySelector('.fill-drawer');
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
function openOn(ed, first = 2, last = 10) {
  selectStretch(ed, first, last);
  press(ed._canvas, 'p', { code: 'KeyP' });
  runFrame();
  expect(ed._fillDrawer.isOpen).toBe(true);
}
const rect = (top, bottom, width = 1280) => ({ top, bottom, height: bottom - top, left: 0, right: width, width, x: 0, y: top });

/**
 * A window laid out as the player lays it out, in CSS px (the interface size
 * divides the window's pixels): the editor docked at the bottom, the
 * controls bar standing on it, the top bar (with the queue button) at the top.
 */
function windowOf(w, h, { scale = 1, editorH = 270, barH = 123, topBarBottom = 88 } = {}) {
  const vh = h / scale;
  return { w: w / scale, editorTop: vh - editorH, editorBottom: vh, barTop: vh - editorH - barH, topLimit: topBarBottom + 6 };
}

// ---------------------------------------------------------------------------
describe('where the docked drawer goes (dockedDrawerPlacement)', () => {
  const minH = FILL_DRAWER_CHROME_PX + FILL_DRAWER_MIN_BODY_PX;

  // Every window from 800x600 up, at interface sizes 100 % to 150 %, with
  // the editor as tall as its toolbar makes it (one to three rows).
  const sizes = [[1920, 1080], [1600, 900], [1366, 768], [1280, 800], [1280, 720], [1024, 768], [800, 600]];
  const scales = [1, 1.25, 1.5];
  const editors = [250, 290, 330];
  for (const [w, h] of sizes) {
    for (const scale of scales) {
      for (const editorH of editors) {
        it(`${w}x${h} at ${scale * 100} %, editor ${editorH} px: the title in the window, the body at least ${FILL_DRAWER_MIN_BODY_PX} px`, () => {
          const win = windowOf(w, h, { scale, editorH });
          const p = dockedDrawerPlacement({ ...win, chrome: FILL_DRAWER_CHROME_PX });
          expect(p.top).toBeGreaterThanOrEqual(0);
          expect(p.height - FILL_DRAWER_CHROME_PX).toBeGreaterThanOrEqual(FILL_DRAWER_MIN_BODY_PX);
          expect(p.top + p.height).toBeLessThanOrEqual(win.editorBottom);
          if (p.mode === 'above') expect(p.top + p.height).toBe(win.barTop);       // on the bar: all of it usable
          if (p.mode === 'over-bar') expect(p.top + p.height).toBe(win.editorTop); // the timeline keeps its width
          if (p.mode !== 'side') expect(p.top).toBeGreaterThanOrEqual(win.topLimit); // the queue button stays clear
          if (p.mode === 'side') expect(p.top + p.height).toBe(win.editorBottom);
        });
      }
    }
  }

  it('the verifier\'s windows: each one that failed now has a whole drawer, the bar kept where there is room', () => {
    // 150 % at 1280x800 (was: top -60, body 16), 800x600 (top -12, body 16),
    // 1280x720 (body 76), 150 % at 1920x1080 (body 54), 1920x1080 (fine).
    const cases = [
      [windowOf(1280, 800, { scale: 1.5, editorH: 290 }), 'side'],
      [windowOf(800, 600, { editorH: 310 }), 'side'],
      [windowOf(1280, 720), 'over-bar'],
      [windowOf(1920, 1080, { scale: 1.5 }), 'over-bar'],
      [windowOf(1366, 768, { editorH: 250 }), 'over-bar'],
      [windowOf(1920, 1080, { editorH: 250 }), 'above'],
    ];
    for (const [win, mode] of cases) {
      const p = dockedDrawerPlacement(win);
      expect(p.mode, JSON.stringify(win)).toBe(mode);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.height).toBeGreaterThanOrEqual(minH);
    }
  });

  it('chooses on the bar first, over the end of the bar next, the side last', () => {
    const base = { editorTop: 700, editorBottom: 1000, topLimit: 50 };
    expect(dockedDrawerPlacement({ ...base, barTop: 600 }).mode).toBe('above');               // 550 of room over the bar
    expect(dockedDrawerPlacement({ ...base, barTop: 600 }).height).toBe(550);
    expect(dockedDrawerPlacement({ ...base, editorTop: 400, barTop: 300 }).mode).toBe('over-bar'); // 250 over the bar, 350 over the editor
    // The side: inside the editor when it alone holds a whole drawer (stacked
    // lanes make it that tall; the control bar stays clear), else from under
    // the top bar (a short window).
    const side = dockedDrawerPlacement({ ...base, editorTop: 300, barTop: 200 });
    expect(side.mode).toBe('side');
    expect(side).toEqual({ mode: 'side', top: 300, height: 700 });
    const short = dockedDrawerPlacement({ ...base, editorTop: 800, barTop: 700, topLimit: 650 });
    expect(short.mode).toBe('side');
    expect(short).toEqual({ mode: 'side', top: 650, height: 350 });
  });

  it('never taller than its cap, and never above the window even when the window is tiny', () => {
    expect(dockedDrawerPlacement({ editorTop: 1800, editorBottom: 2100, barTop: 1700, topLimit: 0 }).height).toBe(FILL_DRAWER_MAX_PX);
    const tiny = dockedDrawerPlacement({ editorTop: 100, editorBottom: 300, barTop: 40, topLimit: 94 });
    expect(tiny).toEqual({ mode: 'side', top: 0, height: 300 });
    // Unmeasured numbers do not throw or go negative.
    const odd = dockedDrawerPlacement({ editorTop: NaN, editorBottom: undefined, barTop: null, topLimit: -5 });
    expect(odd.top).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
describe('the docked drawer takes the place it is given', () => {
  let saved;
  function layout(win) {
    saved = saved || [];
    const set = (el, r) => { saved.push(el); el.getBoundingClientRect = () => r; };
    return (ed) => {
      set(ed._panel, rect(win.editorTop, win.editorBottom, win.w));
      set(bar, rect(win.barTop, win.editorTop, win.w));
      set(topBar, rect(0, win.topLimit - 6, win.w));
    };
  }
  afterEach(() => { for (const el of saved || []) delete el.getBoundingClientRect; saved = null; });

  it('a short window: at the side, under the top bar, the timeline narrowed; a tall one: back on the bar', () => {
    const ed = makeEditor();
    layout(windowOf(1280, 800, { scale: 1.5, editorH: 290 }))(ed);
    const resize = vi.spyOn(ed.graph, 'resize');
    openOn(ed);
    const d = drawerEl(ed);
    expect(d.dataset.dock).toBe('side');
    // Measured from the editor's top: never above the window's top.
    const top = parseFloat(d.style.getPropertyValue('--fill-drawer-top'));
    expect(ed._panel.getBoundingClientRect().top + top).toBeGreaterThanOrEqual(0);
    expect(ed._panel.getBoundingClientRect().top + top).toBeGreaterThanOrEqual(94);
    expect(ed._panel.classList.contains('fill-drawer-host--open')).toBe(true);
    expect(resize).toHaveBeenCalled();

    // The window grows: back on the bar, the timeline its full width again.
    layout(windowOf(1920, 1080, { editorH: 250 }))(ed);
    window.dispatchEvent(new Event('resize'));
    expect(d.dataset.dock).toBe('above');
    expect(ed._panel.classList.contains('fill-drawer-host--open')).toBe(false);
    expect(d.style.getPropertyValue('--fill-drawer-lift')).toBe('123px');
    expect(parseFloat(d.style.getPropertyValue('--fill-drawer-h'))).toBe(FILL_DRAWER_MAX_PX);

    // Closing gives the timeline back whatever the place was.
    layout(windowOf(800, 600, { editorH: 310 }))(ed);
    window.dispatchEvent(new Event('resize'));
    expect(ed._panel.classList.contains('fill-drawer-host--open')).toBe(true);
    ed._fillDrawer.close('cancel');
    expect(ed._panel.classList.contains('fill-drawer-host--open')).toBe(false);
  });

  it('the editor growing after the resize (its toolbar wraps) places it again: it never ends up over the queue button (seen live)', () => {
    const observers = [];
    const realObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.els = []; observers.push(this); }
      observe(el) { this.els.push(el); }
      disconnect() { this.els = []; }
    };
    try {
      const ed = makeEditor();
      layout(windowOf(1366, 768, { editorH: 250 }))(ed);
      openOn(ed);
      const d = drawerEl(ed);
      expect(d.dataset.dock).toBe('over-bar');
      const h0 = parseFloat(d.style.getPropertyValue('--fill-drawer-h'));
      const obs = observers.find((o) => o.els.includes(ed._panel) && o.els.includes(bar));
      expect(obs).toBeTruthy();
      // The toolbar wraps: the editor is 19 px taller, the drawer's bottom edge with it.
      const win = windowOf(1366, 768, { editorH: 269 });
      layout(win)(ed);
      obs.cb([]);
      const h1 = parseFloat(d.style.getPropertyValue('--fill-drawer-h'));
      expect(h1).toBe(h0 - 19);
      expect(win.editorTop - h1).toBeGreaterThanOrEqual(win.topLimit); // the top stays under the queue button
      ed._fillDrawer.close('cancel');
      expect(obs.els).toEqual([]); // not watched while closed
    } finally {
      globalThis.ResizeObserver = realObserver;
    }
  });

  it('going to the side while open brings the selected stretch (and its ghost) into the narrower view', () => {
    const ed = makeEditor(zigzag(41));
    layout(windowOf(1920, 1080, { editorH: 250 }))(ed);
    selectStretch(ed, 24, 34);                               // 12-17 s
    press(ed._canvas, 'p', { code: 'KeyP' });
    runFrame();
    ed.graph.setViewport(0, 10000);                          // the user looks elsewhere
    // The window shrinks: the drawer goes to the side.
    layout(windowOf(800, 600, { editorH: 310 }))(ed);
    window.dispatchEvent(new Event('resize'));
    expect(drawerEl(ed).dataset.dock).toBe('side');
    expect(ed.graph.viewStartMs).toBeLessThanOrEqual(12000);
    expect(ed.graph.viewEndMs).toBeGreaterThanOrEqual(17000);
  });

  it('1280x720: over the bar\'s right end, as tall as the room over the editor, under the top bar', () => {
    const ed = makeEditor();
    const win = windowOf(1280, 720);
    layout(win)(ed);
    openOn(ed);
    const d = drawerEl(ed);
    expect(d.dataset.dock).toBe('over-bar');
    expect(d.style.getPropertyValue('--fill-drawer-lift')).toBe('0px');
    expect(parseFloat(d.style.getPropertyValue('--fill-drawer-h'))).toBe(win.editorTop - win.topLimit);
    expect(ed._panel.classList.contains('fill-drawer-host--open')).toBe(false);
  });

  it('the CSS: the side place runs from --fill-drawer-top down to the editor\'s bottom; the height comes from the measure', () => {
    const css = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    expect(css).toMatch(/\.fill-drawer--above\[data-dock="side"\]\s*{[^}]*top:\s*var\(--fill-drawer-top, 0px\);[^}]*bottom:\s*0;[^}]*height:\s*auto;/);
    expect(css).toMatch(/\.fill-drawer--above\s*{[^}]*height:\s*var\(--fill-drawer-h,/);
  });
});

// ---------------------------------------------------------------------------
describe('keys with the focus in the pattern list (where it lands on open)', () => {
  let seen;
  const onDoc = (e) => seen.push({ key: e.key, owned: targetOwnsKey(e) });
  beforeEach(() => { seen = []; document.addEventListener('keydown', onDoc); });
  afterEach(() => document.removeEventListener('keydown', onDoc));

  it('F, M, K and the other player keys go on to the player; the list keeps only its own keys', () => {
    const ed = makeEditor();
    openOn(ed);
    const list = drawerEl(ed).querySelector('[role="listbox"]');
    expect(list.contains(document.activeElement)).toBe(true);
    const before = JSON.stringify(ed.editableScript.actions);
    for (const k of ['f', 'm', 'k', 'j', 'l', 'F11', 'Delete', '5']) press(document.activeElement, k);
    // They reach the document, and the player's handler does not count them as the list's.
    expect(seen.map((s) => s.key)).toEqual(['f', 'm', 'k', 'j', 'l', 'F11', 'Delete', '5']);
    expect(seen.every((s) => s.owned === false)).toBe(true);
    expect(JSON.stringify(ed.editableScript.actions)).toBe(before); // the timeline is not on the way
    seen = [];
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter', ' ']) press(document.activeElement, k);
    expect(seen).toEqual([]); // kept in the list
    press(document.activeElement, 'Home');
    press(document.activeElement, 'ArrowDown');
    expect(document.activeElement).toBe(list.querySelectorAll('[role="option"]')[1]);
    expect(ed._fillDrawer.isOpen).toBe(true);
  });

  it('the rules themselves: the drawer keeps the list\'s keys only; keyboard.js does the same for a list marked so, and still gives any other list every key', () => {
    const ed = makeEditor();
    openOn(ed);
    const opt = drawerEl(ed).querySelector('[role="option"]');
    const ev = (key, target) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true });
      Object.defineProperty(e, 'target', { value: target });
      return e;
    };
    expect(['f', 'm', 'k', 'x', 'Tab'].map((k) => drawerControlOwnsKey(ev(k, opt)))).toEqual([false, false, false, false, false]);
    expect(['ArrowDown', 'Home', 'End', 'PageUp', 'Enter', ' '].every((k) => drawerControlOwnsKey(ev(k, opt)))).toBe(true);
    expect(targetOwnsKey(ev('m', opt))).toBe(false);
    expect(targetOwnsKey(ev('ArrowDown', opt))).toBe(true);
    const other = document.createElement('div');
    other.setAttribute('role', 'listbox');
    const item = document.createElement('div');
    other.appendChild(item);
    document.body.appendChild(other);
    expect(targetOwnsKey(ev('m', item))).toBe(true); // unchanged for every other list
    other.remove();
  });
});

// ---------------------------------------------------------------------------
// A stand-in for the module Worker: it records what it is asked; the test
// answers with the REAL fill core, in the order it wants.
class FakeWorker {
  static all = [];
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.posted = [];
    FakeWorker.all.push(this);
  }
  postMessage(m) { this.posted.push(m); }
  terminate() {}
  answer(m = this.posted.at(-1), ms = 650) {
    const res = realFillRange({ actions: m.actions, selection: m.selection, patternId: m.patternId, options: m.options });
    this.onmessage({ data: { id: m.id, res, ms } });
    return res;
  }
}

describe('a heavy preview moves during a drag (the newest answer shows)', () => {
  beforeEach(() => { FakeWorker.all = []; globalThis.Worker = FakeWorker; });
  const updating = (ed) => drawerEl(ed).querySelector('.fill-drawer__updating');
  /** Four distinct speeds inside the slider's bounds, none of them `not`. */
  const speeds = (ed, not) => {
    const lo = Number(speedSlider(ed).min);
    const out = [];
    for (let v = lo + 7; out.length < 4; v += 7) if (v !== not) out.push(v);
    expect(out.at(-1)).toBeLessThanOrEqual(Number(speedSlider(ed).max));
    return out;
  };

  it('an answer newer than the one on screen shows while a newer request is on its way; the last one matches the controls', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    w.answer(w.posted[0]);
    expect(ed._fillDrawer.preview.options.speed).toBe(w.posted[0].options.speed);
    // A drag: one request in flight, the moves only bump the id. Four speeds
    // inside the pattern's own bounds, none of them the one it opened on.
    const [s1, s2, s3, s4] = speeds(ed, w.posted[0].options.speed);
    slide(speedSlider(ed), s1); runFrame();
    expect(w.posted).toHaveLength(2);
    slide(speedSlider(ed), s2); runFrame();
    slide(speedSlider(ed), s3); runFrame();
    expect(w.posted).toHaveLength(2);
    const ghostBefore = JSON.stringify(ed.graph.ghost.points);
    const res60 = w.answer(w.posted[1]);                      // s1 arrives, the slider is at s3 by now
    expect(ed._fillDrawer.preview.options.speed).toBe(s1);    // shown: the ghost moves
    expect(ed._fillDrawer.preview.res.inserted).toEqual(res60.inserted);
    expect(JSON.stringify(ed.graph.ghost.points)).not.toBe(ghostBefore);
    expect(updating(ed).hidden).toBe(false);                  // still not the latest
    expect(w.posted).toHaveLength(3);                         // the latest went at once
    expect(w.posted[2].options.speed).toBe(s3);
    slide(speedSlider(ed), s4); runFrame();
    w.answer(w.posted[2]);                                    // s3: newer than s1, shown
    expect(ed._fillDrawer.preview.options.speed).toBe(s3);
    const last = w.answer(w.posted[3]);                       // s4: the controls' own
    expect(w.posted[3].options.speed).toBe(s4);
    expect(ed._fillDrawer.preview.options.speed).toBe(s4);
    expect(ed._fillDrawer.preview.res.inserted).toEqual(last.inserted);
    expect(updating(ed).hidden).toBe(true);
  });

  it('an answer about another stretch (the selection moved) is not shown; the new stretch\'s is', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    w.answer(w.posted[0]);
    slide(speedSlider(ed), speeds(ed, w.posted[0].options.speed)[0]); runFrame();
    ed.editableScript.select(4);
    ed.editableScript.toggleSelect(12);
    ed._fillDrawer.refresh(); runFrame();
    const shown = ed._fillDrawer.preview;
    w.answer(w.posted[1]);                                    // about 1-5 s, the selection is 2-6 s now
    expect(ed._fillDrawer.preview).toBe(shown);
    expect(w.posted.at(-1).selection.startMs).toBe(2000);
    w.answer(w.posted.at(-1));
    expect(ed._fillDrawer.preview.win.startMs).toBe(2000);
  });

  it('Apply with a newer-but-not-latest answer on screen waits for the controls\' own fill and lands that (Apply unchanged)', () => {
    const ed = makeEditor();
    openOn(ed);
    const [w] = FakeWorker.all;
    w.answer(w.posted[0]);
    const [s1, , , s4] = speeds(ed, w.posted[0].options.speed);
    slide(speedSlider(ed), s1); runFrame();
    slide(speedSlider(ed), s4); runFrame();
    w.answer(w.posted[1]);                                    // s1 on screen, s4 on its way
    expect(ed._fillDrawer.preview.options.speed).toBe(s1);
    drawerEl(ed).querySelector('.fill-drawer__btn--primary').click();
    expect(ed.editableScript.canUndo).toBe(false);            // busy, nothing landed yet
    const res = w.answer(w.posted.at(-1));
    expect(w.posted.at(-1).options.speed).toBe(s4);
    expect(ed.editableScript._undoStack.length).toBe(1);
    expect(ed.editableScript.actions.filter((a) => a.at > 1000 && a.at < 5000)).toEqual(res.inserted);
    expect(fillRange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('the words', () => {
  it('"Replaces N points." is a sentence on its own line, after the stats\' own full stop', () => {
    const ed = makeEditor();
    globalThis.Worker = undefined;
    openOn(ed);
    runFrame();
    const r = ed._fillDrawer.preview;
    expect(r.res.removed.length).toBeGreaterThan(0);
    const stats = drawerEl(ed).querySelector('.fill-drawer__stats');
    expect(stats.textContent).toBe(`${t('editor.patternFill.stats', { points: r.res.inserted.length, mean: r.res.stats.mean, max: r.res.stats.max })}\n${t('editor.patternFill.replaces', { count: r.res.removed.length })}`);
    const css = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    expect(css).toMatch(/\.fill-drawer__stats\s*{[^}]*white-space:\s*pre-line;/);
  });

  it('in every language the stats end their sentence, and the applied toast quotes the pattern\'s name', () => {
    for (const l of LOCALES) {
      const pf = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8')).editor.patternFill;
      expect(pf.stats, l).toMatch(/[.。]$/);
      expect(pf.applied, l).toMatch(/["“„«「]\s?\{name\}\s?["”“»」]/);
    }
  });

  it('the group list names its group on hover', () => {
    const ed = makeEditor();
    openOn(ed);
    const fam = drawerEl(ed).querySelector('.fill-drawer__family');
    fam.value = fam.options[1].value;
    fam.dispatchEvent(new Event('change'));
    expect(fam.title).toBe(fam.options[1].textContent);
  });
});
