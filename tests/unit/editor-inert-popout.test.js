/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document
 * and the REAL Modal walks it, and script-editor.js imports DOM-branching
 * modules (notes/CLAUDE.md "Test environments").
 */
// R3-22, the round-2 review's nits on the docked editor:
//   (a) In fullscreen a dialog mounts inside #player-container, beside the
//       docked editor, and inerts it. When the editor was hidden while the
//       dialog was open (a video load after the unsaved-edits question's
//       Save), closing the dialog removed the inert the editor had just set
//       for itself, so Tab reached the closed editor's controls again (the
//       round-2 R2-2 hole, reopened).
//   (b) An editor hidden while popped out (a new video's load) kept
//       `_panel.hidden` for good: once the pop-out closed, the docked editor
//       never showed again. A show() while popped out also squeezed the video
//       for a panel that was not there.
//   (c) The toolbar wraps (R3-23, editor.css); the rows past the first are
//       measured onto #player-container so the panel grows instead of the
//       canvas shrinking.
// jsdom does not enforce `inert` or lay anything out, so what is asserted is
// the attribute that Chromium enforces, the `hidden` and layout classes, and
// the measured custom property.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { Modal } = await import('../../renderer/components/modal.js');

let popoutEvent = null;

function realEditor() {
  document.body.innerHTML = '<div id="app"><div id="player-container" class="player-container"><video></video></div></div>';
  const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  return ed;
}

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const container = () => document.getElementById('player-container');
const setFullscreen = (el) => Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true, writable: true });

beforeEach(() => {
  popoutEvent = null;
  window.funsync = {
    filesExist: async (paths) => paths.map(() => false),
    readFunscript: async () => null,
    writeFunscript: async (_json, p) => p,
    onEditorPopoutEvent: (cb) => { popoutEvent = cb; return () => {}; },
  };
});

afterEach(() => {
  setFullscreen(null);
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('(a) a dialog in fullscreen leaves the editor\'s own inert alone', () => {
  it('the editor hidden while the dialog is open stays inert after the dialog closes', async () => {
    const ed = realEditor();
    ed.show();
    await settle();
    setFullscreen(container());
    const closed = Modal.open({ title: 'Save changes to x.funscript?', onRender: (_b, close) => { ed.__closeDialog = close; } });
    // Mounted beside the editor, which it inerts while open.
    expect(document.querySelector('.modal-overlay').parentElement).toBe(container());
    expect(ed._panel.hasAttribute('inert')).toBe(true);
    // Save, then the next video's load hides the editor.
    ed.hide();
    ed.__closeDialog('save');
    await closed;
    expect(ed.isOpen).toBe(false);
    expect(ed._panel.hasAttribute('inert')).toBe(true);
  });

  it('an editor still open when the dialog closes is live again', async () => {
    const ed = realEditor();
    ed.show();
    await settle();
    setFullscreen(container());
    const closed = Modal.open({ title: 'x', onRender: (_b, close) => { ed.__closeDialog = close; } });
    expect(ed._panel.hasAttribute('inert')).toBe(true);
    ed.__closeDialog(null);
    await closed;
    expect(ed._panel.hasAttribute('inert')).toBe(false);
  });
});

describe('(b) the docked editor after the pop-out window', () => {
  it('hidden while popped out (a new video), it shows again once the pop-out closes', async () => {
    const ed = realEditor();
    ed.show();
    await settle();
    popoutEvent({ type: 'opened' });
    expect(ed._panel.hidden).toBe(true);
    ed.hide();             // a new video's load
    popoutEvent({ type: 'closed' });
    ed.show();
    await settle();
    expect(ed._panel.hidden).toBe(false);
    expect(ed._panel.classList.contains('script-editor--open')).toBe(true);
    expect(container().classList.contains('player-container--editor-open')).toBe(true);
  });

  it('a show() while popped out does not squeeze the video for a panel that is not there', async () => {
    const ed = realEditor();
    ed.show();
    await settle();
    popoutEvent({ type: 'opened' });
    expect(container().classList.contains('player-container--editor-open')).toBe(false);
    ed.hide();
    ed.show();
    expect(ed._panel.hidden).toBe(true);
    expect(container().classList.contains('player-container--editor-open')).toBe(false);
    // Docked again: the layout comes back.
    popoutEvent({ type: 'closed' });
    expect(ed._panel.hidden).toBe(false);
    expect(container().classList.contains('player-container--editor-open')).toBe(true);
  });
});

describe('(c) a wrapped toolbar grows the panel (R3-23)', () => {
  // R3 fix-up (real-app verifier 1): in a wrapped toolbar "Speed:" ended one
  // row and its select started the next. A flex row wraps between its own
  // items only, so the two are ONE item now (editor.css keeps it nowrap).
  it('"Speed:" and its select are one toolbar item, so a wrap never splits them', () => {
    const ed = realEditor();
    const toolbar = ed._panel.querySelector('.editor__toolbar');
    const label = toolbar.querySelector('.editor__speed-label');
    const select = ed._speedSelect; // Select… and Modify… share its class
    expect(label.parentElement).toBe(select.parentElement);
    expect(label.parentElement.parentElement).toBe(toolbar);
    expect(label.parentElement.className).toBe('editor__speed-group');
  });

  // Written in the NEXT frame (R3 fix-up): a write inside the observer's
  // callback resized the canvas container in the same delivery, and Chromium
  // logged 'ResizeObserver loop completed with undelivered notifications'.
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  it('the rows past the first are put on #player-container as --editor-toolbar-extra, in the next frame', async () => {
    // The observer watching the toolbar (the graph has one of its own).
    let observed = null;
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(el) { if (el.classList?.contains('editor__toolbar')) observed = this.cb; }
      unobserve() {} disconnect() {}
    };
    try {
      const ed = realEditor();
      const toolbar = ed._panel.querySelector('.editor__toolbar');
      // Chromium's layout, stood in: 36 px controls, 6 px padding top and
      // bottom, a 1 px bottom border, 4 px between rows.
      const kids = [...toolbar.children];
      for (const el of kids) Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => (el.hidden ? 0 : 36) });
      let rows = 1;
      Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 13 + rows * 36 + (rows - 1) * 4 });
      toolbar.style.padding = '6px 8px';
      toolbar.style.borderBottom = '1px solid black';
      toolbar.style.minHeight = '48px';
      observed();
      await nextFrame();
      expect(container().style.getPropertyValue('--editor-toolbar-extra')).toBe('0px');
      rows = 3; // a narrow window, a longer language
      observed();
      // Not inside the observer's callback: the panel must not grow there.
      expect(container().style.getPropertyValue('--editor-toolbar-extra')).toBe('0px');
      await nextFrame();
      expect(container().style.getPropertyValue('--editor-toolbar-extra')).toBe('80px');
      rows = 1;
      observed();
      await nextFrame();
      expect(container().style.getPropertyValue('--editor-toolbar-extra')).toBe('0px');
    } finally {
      globalThis.ResizeObserver = RO;
    }
  });
});
