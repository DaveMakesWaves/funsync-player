/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL pop-out page (renderer/editor-popout.js) builds
 * its DOM, and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// The pop-out's Shift+Left/Right (test day 2026-11-24, B031): it sent a bare
// frames x frame duration, rounded to the ms by each move, so at 29.97 fps
// the points drifted off the frames, about 1 ms every 3 presses (six presses
// from 1001 ms landed on 1199, two ms short of the frame at 1201.2). The
// docked editor was fixed the same morning (_frameMoveDeltaMs); the pop-out
// now lands the first selected point on the frame start as well.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { EditableScript } = await import('../../renderer/js/editable-script.js');
const { applyPopoutEdit } = await import('../../renderer/js/editor-popout-dispatch.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const FRAME = 1000 / (30000 / 1001);           // 29.97 fps
const PATH = 'C:\\s\\a.funscript';
const START = [{ at: 0, pos: 0 }, { at: 1001, pos: 50 }, { at: 9000, pos: 0 }];
const sent = [];
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const canvas = () => document.querySelector('#editor-popout-host canvas.editor__canvas');

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
    editorPopoutRelay: (direction, payload) => { if (direction === 'to-parent') sent.push(payload); },
    onEditorPopoutEvent: (cb) => { if (!onEvent) onEvent = cb; return () => {}; },
    editorPopoutClose() {},
    updateWindowChrome() {},
    editorDirtyChanged() {},
  };
  await import('../../renderer/editor-popout.js');
  await new Promise((r) => setTimeout(r, 0));
  fromParent({
    type: P.INITIAL_STATE,
    scripts: [], activePath: PATH,
    actions: START, selectedIndices: [1], bookmarks: [],
    videoSrc: '', videoDuration: 60, videoTime: 1, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: true, recordingMode: false, frameDurationMs: FRAME, framePhaseMs: 0,
  });
}, 20000);

describe('pop-out Shift+Right with Snap to frame on (B031)', () => {
  it('six presses at 29.97 fps land on the frame six frames on, not 2 ms short', () => {
    // The parent applies each op and sends the result back, as in the app.
    const es = new EditableScript();
    es.loadFromData({ actions: START });
    es._selectedIndices = new Set([1]);
    for (let i = 0; i < 6; i++) {
      sent.length = 0;
      canvas().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
      const op = sent.find((m) => m.type === P.EDIT_OP && m.op === P.OP_MOVE_ACTIONS);
      expect(op, `press ${i + 1}`).toBeTruthy();
      applyPopoutEdit(es, op);
      fromParent({ type: P.ACTIONS_CHANGED, path: PATH, actions: es.actions.map((a) => ({ ...a })), selectedIndices: [...es.selectedIndices], bookmarks: [] });
    }
    expect(es.actions[1].at).toBe(Math.round(1001 + 6 * FRAME));   // 1201
  });
});
