/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * and script-editor.js imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// Round 2 (2026-11-05), also in v0.9.2: editor.css hides the closed docked
// editor with translateY + opacity only. Tab from the player view reached
// its controls (Delete Selected, Zoom Out, the canvas): Enter on a focused
// hidden button, or a digit once the hidden canvas had focus, edited the
// script unseen, and the focus scrolled the page 250 px so the top bar
// vanished. A closed editor is now inert (not focusable, not clickable), and
// its canvas takes no key while closed.
//
// jsdom does not enforce `inert` itself (Chromium does: no focus, no click),
// so what is asserted is the attribute on every control's subtree, and the
// observable effect of a key on the canvas: the script's points.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

function realEditor() {
  document.body.innerHTML = '<div id="player-container"></div>';
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

const controls = (ed) => [...ed._panel.querySelectorAll('button, canvas, select, input, [tabindex]')];
// show() loads the (empty) script asynchronously: let it land first.
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
// The position keys match on the physical key (e.code, CB-06).
const press = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', {
  key, code: `Digit${key}`, bubbles: true, cancelable: true,
}));

beforeEach(() => {
  window.funsync = {
    filesExist: async (paths) => paths.map(() => false),
    readFunscript: async () => null,
    writeFunscript: async (_json, p) => p,
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('a closed docked editor is not focusable and takes no keys (round 2)', () => {
  it('never opened: the panel is inert, and so is every control in it', () => {
    const ed = realEditor();
    expect(ed.isOpen).toBe(false);
    expect(ed._panel.hasAttribute('inert')).toBe(true);
    const all = controls(ed);
    expect(all.length).toBeGreaterThan(10); // the toolbar and the canvas are there
    expect(all.every((el) => el.closest('[inert]') === ed._panel)).toBe(true);
  });

  it('a digit on the closed editor\'s canvas places no point', () => {
    const ed = realEditor();
    press(ed._canvas, '5');
    expect(ed.editableScript.actionCount).toBe(0);
  });

  it('open: not inert, and the same digit places a point', async () => {
    const ed = realEditor();
    ed.show();
    await settle();
    expect(ed._panel.hasAttribute('inert')).toBe(false);
    press(ed._canvas, '5');
    expect(ed.editableScript.actionCount).toBe(1);
  });

  it('closed again: inert again, and a digit places nothing; reopened, it works', async () => {
    const ed = realEditor();
    ed.show();
    await settle();
    press(ed._canvas, '5');
    ed.hide();
    expect(ed._panel.hasAttribute('inert')).toBe(true);
    ed.videoPlayer.currentTime = 4;
    press(ed._canvas, '7');
    expect(ed.editableScript.actionCount).toBe(1);
    ed.show();
    await settle();
    press(ed._canvas, '7');
    expect(ed.editableScript.actionCount).toBe(2);
  });
});
