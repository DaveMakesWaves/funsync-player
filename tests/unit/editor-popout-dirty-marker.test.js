/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js), which builds its toolbar and status line on
 * the DOM of editor-popout.html at import time, and the REAL ScriptEditor.
 */
// R4 fix-up (real-app verifier 2, cosmetic, also in v0.9.2): the pop-out
// editor showed no unsaved marker. With unsaved edits its status line read
// "27 actions · 1 selected" where the docked editor reads
// "23 actions (1 selected) *", so edits made in the pop-out looked saved.
//
// The parent's REAL ScriptEditor owns the script and its saved state; what it
// relays to the pop-out is fed to the REAL pop-out renderer here, and what is
// asserted is the pop-out's status line after an edit, a save and an undo
// back to the saved point (R4-18).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const PATH = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const ACTIONS = () => Array.from({ length: 25 }, (_, i) => ({ at: i * 400, pos: i % 2 ? 90 : 10 }));

let toPopout = null; // the pop-out's onEditorPopoutEvent callback
let ed;
// The pop-out's own status line, not the parent's docked one.
const status = () => [...document.querySelectorAll('.editor__status')].find((el) => !ed?._panel?.contains(el));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  const ctx = document.createElement('canvas').getContext('2d');
  for (const fn of ['setLineDash', 'getLineDash', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'translate']) {
    if (typeof ctx[fn] !== 'function') ctx[fn] = () => [];
  }
  if (typeof ctx.createLinearGradient !== 'function') ctx.createLinearGradient = () => ({ addColorStop() {} });
  // One preload for both windows here: the parent relays 'to-popout', the
  // pop-out's listener gets it (as main's relay does between the windows).
  const writes = [];
  window.funsync = {
    editorPopoutRelay: (direction, payload) => {
      if (direction === 'to-popout') toPopout?.({ type: 'message', payload });
    },
    // The pop-out registers first (its import); the parent's ScriptEditor
    // registers the same name for the pop-out's commands, which are not
    // under test here.
    onEditorPopoutEvent: (cb) => { if (!toPopout) toPopout = cb; },
    editorPopoutClose() {},
    updateWindowChrome() {},
    filesExist: async (paths) => paths.map(() => true),
    readFunscript: async () => JSON.stringify({ version: '1.0', actions: ACTIONS() }),
    writeFunscript: async (json, p) => { writes.push(p); return p; },
    editorDirtyChanged() {},
  };
  await import('../../renderer/editor-popout.js');

  // The parent: a REAL ScriptEditor in another document part, its pop-out open.
  const host = document.createElement('div');
  host.id = 'player-container';
  document.body.appendChild(host);
  const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
  const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: true, src: '' });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 });
  ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  ed._reuploadToHandy = () => {};
  ed.setFunscriptPath(PATH);
  ed.editableScript.loadFromData({ version: '1.0', actions: ACTIONS() });
  ed._popoutOpen = true;
  ed._broadcastInitialState();
  await flush();
}, 20000);

describe('the pop-out editor shows the unsaved marker the docked editor shows (R4 fix-up)', () => {
  it('opened on a saved script: no marker', () => {
    expect(status().textContent).toBe('25 actions');
    expect(status().classList.contains('editor__status--dirty')).toBe(false);
  });

  it('an edit: "*", as the docked editor', async () => {
    ed.editableScript.insertAction(20000, 50);
    await flush();
    expect(status().textContent).toBe('26 actions *');
    expect(status().classList.contains('editor__status--dirty')).toBe(true);
  });

  it('Ctrl+Z back to the saved point (R4-18): the marker goes', async () => {
    ed.editableScript.undo();
    await flush();
    expect(status().textContent).toBe('25 actions');
    expect(status().classList.contains('editor__status--dirty')).toBe(false);
  });

  it('an edit, then Save (no change event of its own): the marker goes', async () => {
    ed.editableScript.insertAction(21000, 40);
    await flush();
    expect(status().textContent).toBe('26 actions *');
    await ed._save({ syncEngine: false });
    await flush();
    expect(ed.hasUnsavedChanges()).toBe(false);
    expect(status().textContent).toBe('26 actions');
  });
});
