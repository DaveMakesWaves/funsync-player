/**
 * @vitest-environment jsdom
 * jsdom on purpose: script-editor.js imports DOM-branching modules, and the
 * key tests dispatch real KeyboardEvents from a canvas up to a real player
 * handler on `document` (notes/CLAUDE.md "Test environments").
 */
// Two editor bugs that no test could see because the tests copied the code
// instead of running it.
//
// 1. The docked editor's key switch had `case 'b'/'B'` and `case 'v'/'V'`
//    TWICE. JavaScript runs the first matching label, so the second copies
//    were dead: Shift+B added a bookmark instead of jumping, Ctrl+B did
//    nothing, bare V never toggled the voice-activity track, and bare V /
//    Shift+V were never stopped, so they reached the player's V / Shift+V
//    (cycle the script variant, no editor gate) while you were editing.
//    Bookmark direction now matches the player: Shift+B previous, Ctrl+B next.
//
// 2. The pop-out's Ctrl+Shift+V sent OP_PASTE_ORIGINAL and the parent called
//    `es.pasteOriginal?.()`. EditableScript has `pasteExact`; the optional
//    call made it a silent no-op. The routing test (editor-popout-edit-ops)
//    runs a COPY of the dispatch switch, and the copy had no such case.
//    These run the REAL `_applyPopoutEdit`.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { KeyboardHandler } = await import('../../renderer/js/keyboard.js');
const PROTOCOL = await import('../../renderer/js/editor-popout-protocol.js');

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 100 : 0 }));
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);

describe('docked editor keys: B and V', () => {
  // ONE player handler for the file: it binds to `document` and cannot be
  // unbound, so a handler per test would multiply the calls.
  const player = {
    onCycleVariant: vi.fn(),
    onJumpBookmark: vi.fn(),
    setLoopPoint: vi.fn(),
  };
  const kb = new KeyboardHandler({
    videoPlayer: { setLoopPoint: player.setLoopPoint },
    scriptEditor: { isOpen: true },
    onJumpBookmark: player.onJumpBookmark,
  });
  kb.onCycleVariant = player.onCycleVariant;

  const editor = Object.create(ScriptEditor.prototype);
  editor.graph = { markInteraction() {} };
  editor.videoPlayer = { currentTime: 1 };
  editor.editableScript = new EditableScript();
  editor._jumpToBookmark = vi.fn();
  editor._addBookmarkAtCursor = vi.fn();
  editor._toggleVADTrack = vi.fn();
  const paste = vi.spyOn(editor.editableScript, 'paste').mockImplementation(() => {});
  const pasteExact = vi.spyOn(editor.editableScript, 'pasteExact').mockImplementation(() => {});

  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  document.body.appendChild(canvas);
  canvas.addEventListener('keydown', (e) => editor._onCanvasKeyDown(e));

  const press = (key, mods = {}) => canvas.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
    shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
  }));

  beforeEach(() => {
    for (const fn of [...Object.values(player), editor._jumpToBookmark, editor._addBookmarkAtCursor,
      editor._toggleVADTrack, paste, pasteExact]) fn.mockClear();
  });

  it('bare V toggles the voice-activity track and never cycles the script variant', () => {
    press('v');
    expect(editor._toggleVADTrack).toHaveBeenCalledTimes(1);
    expect(player.onCycleVariant).not.toHaveBeenCalled();
  });

  it('Shift+V does nothing in the editor and does not reach the player either', () => {
    press('V', { shift: true });
    expect(editor._toggleVADTrack).not.toHaveBeenCalled();
    expect(player.onCycleVariant).not.toHaveBeenCalled();
  });

  it('Ctrl+V pastes at the playhead, Ctrl+Shift+V pastes at the original times', () => {
    press('v', { ctrl: true });
    press('V', { ctrl: true, shift: true });
    expect(paste).toHaveBeenCalledWith(1000);
    expect(pasteExact).toHaveBeenCalledTimes(1);
    expect(editor._toggleVADTrack).not.toHaveBeenCalled();
  });

  it('bare B adds a bookmark and does not set the loop point', () => {
    press('b');
    expect(editor._addBookmarkAtCursor).toHaveBeenCalledTimes(1);
    expect(editor._jumpToBookmark).not.toHaveBeenCalled();
    expect(player.setLoopPoint).not.toHaveBeenCalled();
  });

  it("Shift+B jumps to the PREVIOUS bookmark and Ctrl+B to the NEXT, the player's direction", () => {
    press('B', { shift: true });
    press('b', { ctrl: true });
    expect(editor._jumpToBookmark.mock.calls).toEqual([[-1], [1]]);
    expect(editor._addBookmarkAtCursor).not.toHaveBeenCalled();
    expect(player.onJumpBookmark).not.toHaveBeenCalled();
  });
});

describe('the REAL pop-out dispatch (_applyPopoutEdit)', () => {
  const editorOn = (actions) => {
    const ed = Object.create(ScriptEditor.prototype);
    ed.editableScript = new EditableScript();
    ed.editableScript.loadFromData({ actions });
    return ed;
  };

  it('OP_PASTE_ORIGINAL (Ctrl+Shift+V) pastes at the copied points\' original times', () => {
    const ed = editorOn(zigzag(3, 1000)); // 0:0 1000:100 2000:0
    const es = ed.editableScript;
    es.select(1);
    ed._applyPopoutEdit({ op: PROTOCOL.OP_COPY });
    ed._applyPopoutEdit({ op: PROTOCOL.OP_DELETE });
    expect(pairs(es)).toEqual(['0:0', '2000:0']);
    ed._applyPopoutEdit({ op: PROTOCOL.OP_PASTE_ORIGINAL, at: 5000 });
    expect(pairs(es)).toEqual(['0:0', '1000:100', '2000:0']);
    expect([...es.selectedIndices]).toEqual([1]);
  });

  it('every OP_* the protocol exports reaches a case that calls only methods EditableScript has', () => {
    // An optional call on a method that does not exist (`es.x?.()`) is how
    // the paste bug hid. Record every property the dispatch reads that
    // resolves to nothing, and every op that falls through to `default`.
    const ops = Object.entries(PROTOCOL).filter(([k]) => k.startsWith('OP_')).map(([, v]) => v);
    expect(ops.length).toBeGreaterThan(20);
    const missing = [];
    const unknown = [];
    const debug = vi.spyOn(console, 'debug').mockImplementation((...args) => {
      if (String(args[0]).includes('unknown popout edit-op')) unknown.push(args[1]);
    });
    // A route that throws is caught and logged by the dispatch; count it too.
    const threw = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      if (String(args[0]).includes('edit-op failed')) threw.push(`${args[1]}: ${args[2]?.message}`);
    });
    for (const op of ops) {
      const ed = editorOn(zigzag(6));
      const real = ed.editableScript;
      real.select(1);
      real.copy();
      ed.editableScript = new Proxy(real, {
        get(target, key) {
          const v = Reflect.get(target, key);
          if (v === undefined && typeof key === 'string') missing.push(`${op} → es.${key}`);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      ed._applyPopoutEdit({
        op, at: 1200, pos: 40, idx: 0, fields: { pos: 30 }, indices: [0], time: 1200,
        name: 'doubleSpeed', minPos: 0, maxPos: 100, deltaAt: 0, deltaPos: 5,
      });
    }
    debug.mockRestore();
    warn.mockRestore();
    expect(unknown).toEqual([]);
    expect(missing).toEqual([]);
    expect(threw).toEqual([]);
  });
});
