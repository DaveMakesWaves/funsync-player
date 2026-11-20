/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL editor pop-out renderer
 * (renderer/editor-popout.js), which builds its toolbar, canvas and
 * ActionGraph on the DOM of editor-popout.html at import time.
 */
// The editor pop-out's side of CB-04 and CB-06.
//
// CB-04: its Zoom out button said "Zoom out (-)", but bare - places a point
// at 100 here too since FT-032. The key the tooltip names must zoom out.
// CB-06: Ctrl+1/2/3 select a third on AZERTY too (& é " unshifted).
//
// Assertions: what the pop-out sends to the parent, and its visible time
// window (the scrubber's viewport box).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

// Since FT-103 the pop-out's tooltips are the docked editor's keys
// (editor.btn.zoomOut: "Zoom Out (Ctrl+-)"); it had its own English
// "Zoom out (Ctrl+-)".
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const sent = [];
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const canvas = () => document.querySelector('canvas.editor__canvas');
const press = (key, mods = {}) => {
  const e = new KeyboardEvent('keydown', {
    key, code: mods.code, bubbles: true, cancelable: true,
    shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
  });
  canvas().dispatchEvent(e);
  return e;
};
const take = () => sent.splice(0, sent.length);
const viewportWidth = () => parseFloat(document.querySelector('.editor__scrubber-viewport').style.width);
const ACTIONS = () => Array.from({ length: 24 }, (_, i) => ({ at: i * 250, pos: [0, 50, 100, 50][i % 4] }));

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  const ctx = document.createElement('canvas').getContext('2d');
  for (const fn of ['setLineDash', 'getLineDash', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'translate']) {
    if (typeof ctx[fn] !== 'function') ctx[fn] = () => [];
  }
  if (typeof ctx.createLinearGradient !== 'function') ctx.createLinearGradient = () => ({ addColorStop() {} });
  window.funsync = {
    editorPopoutRelay: (direction, payload) => { if (direction === 'to-parent') sent.push(payload); },
    onEditorPopoutEvent: (cb) => { onEvent = cb; },
    editorPopoutClose() {},
    updateWindowChrome() {},
  };
  await import('../../renderer/editor-popout.js');
  // Labelled once its i18n is up (FT-103).
  await new Promise((r) => setTimeout(r, 0));
  fromParent({
    type: P.INITIAL_STATE,
    scripts: [], activePath: 'C:\\s\\a.funscript',
    actions: ACTIONS(),
    selectedIndices: [],
    bookmarks: [],
    videoSrc: '', videoDuration: 60, videoTime: 3.1, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
  });
}, 20000);

beforeEach(() => { take(); });

describe('the pop-out\'s Zoom out tooltip names the key that zooms out (CB-04)', () => {
  it('it says Ctrl+-, and Ctrl+- widens the visible window without placing a point', () => {
    const btn = document.querySelector(`button[aria-label="${EN.editor.btn.zoomOut}"]`);
    expect(btn).not.toBeNull();
    const label = btn.getAttribute('aria-label') || btn.title;
    expect(label).toMatch(/\(Ctrl\+-\)$/);
    expect(btn.title).toBe(label);
    const before = viewportWidth();
    const e = press('-', { code: 'Minus', ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(viewportWidth()).toBeGreaterThan(before);
    expect(take().filter((m) => m.type === P.EDIT_OP)).toEqual([]);
  });

  it('bare - is position 100 (FT-032), which is why the tooltip cannot say "-"', () => {
    press('-', { code: 'Minus' });
    const ops = take().filter((m) => m.type === P.EDIT_OP);
    expect(ops).toHaveLength(1);
    expect(ops[0].payload ?? ops[0]).toMatchObject({ op: P.OP_PLACE_AT, pos: 100 });
  });
});

describe('Ctrl+1/2/3 on the number-row key, whatever the layout types (CB-06)', () => {
  it.each([
    ['US', ['1', '2', '3']],
    ['AZERTY', ['&', 'é', '"']],
  ])('%s: the 1 / 2 / 3 keys with Ctrl select the top / middle / bottom third, never place a point', (_layout, typed) => {
    // The select-third commands go to the parent as a selection (OP_SELECT…);
    // what they never do is OP_PLACE_AT.
    const before = sent.length;
    press(typed[0], { code: 'Digit1', ctrl: true });
    press(typed[1], { code: 'Digit2', ctrl: true });
    press(typed[2], { code: 'Digit3', ctrl: true });
    const out = sent.slice(before);
    expect(out.length).toBeGreaterThanOrEqual(3);
    const ops = out.filter((m) => m.type === P.EDIT_OP).map((m) => (m.payload ?? m).op);
    expect(ops).not.toContain(P.OP_PLACE_AT);
    const sel = out.map((m) => JSON.stringify(m));
    // Same three messages as the menu's Top / Middle / Bottom third items.
    take();
    const menu = document.querySelector('select[aria-label="Select points"]');
    for (const v of ['topThird', 'middleThird', 'bottomThird']) {
      menu.value = v;
      menu.dispatchEvent(new Event('change'));
    }
    expect(take().map((m) => JSON.stringify(m))).toEqual(sel);
  });
});
