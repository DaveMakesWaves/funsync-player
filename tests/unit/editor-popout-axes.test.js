/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL pop-out page (renderer/editor-popout.js) builds
 * its DOM, and i18n.js branches on `typeof window` (notes/CLAUDE.md "Test
 * environments").
 */
// Multi-axis editing in the pop-out (2026-11-24): the docked editor's New
// axis, Export and stacked lanes, in the pop-out window. The parent owns the
// axes; the pop-out asks (axis-create, axes-export, lanes-wanted, a lane's
// script-switch) and draws the lanes it is sent.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import * as P from '../../renderer/js/editor-popout-protocol.js';

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);

const html = fs.readFileSync('renderer/editor-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const MAIN = 'C:\\V\\Clip.funscript';
const TWIST = 'C:\\V\\Clip.twist.funscript';
const SCRIPTS = [
  { label: 'Main (L0)', path: MAIN, kind: 'main' },
  { label: 'Twist', path: TWIST, kind: 'companion', axis: 'twist' },
];
const sent = [];
let onEvent = null;
const fromParent = (payload) => onEvent({ type: 'message', payload });
const take = () => sent.splice(0, sent.length);
const btn = (key) => [...document.querySelectorAll('#editor-popout-host .editor__toolbar .editor__btn')]
  .find((b) => b.getAttribute('aria-label') === t(key));

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
    scripts: SCRIPTS, activePath: MAIN, axisTools: true, axesPresent: ['twist'],
    actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }], selectedIndices: [], bookmarks: [],
    videoSrc: '', videoDuration: 60, videoTime: 1, videoPaused: true, videoRate: 1,
    splineMode: true, snapToFrame: false, recordingMode: false, frameDurationMs: 1000 / 30,
  });
}, 20000);

beforeEach(() => { take(); });

describe('the pop-out\'s axis tools', () => {
  it('New axis, Export and Stacked show as in the docked editor', () => {
    expect(btn('editor.btn.newAxis').hidden).toBe(false);
    expect(btn('editor.btn.exportAxes').hidden).toBe(false);
    expect(btn('editor.btn.stacked').hidden).toBe(false);
  });

  it('New axis: the menu greys the axes the video has; a pick asks the parent to create it', () => {
    btn('editor.btn.newAxis').click();
    const items = [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toContain('Twist / Yaw (R0)');
    expect(items.find((i) => i.textContent === 'Twist / Yaw (R0)').getAttribute('aria-disabled')).toBe('true');
    items.find((i) => i.textContent === 'Roll (R1)').click();
    expect(take().filter((m) => m.type === 'axis-create')).toEqual([expect.objectContaining({ suffix: 'roll' })]);
  });

  // Dave, 2026-11-25 ("how clear is that"): two sections, This script (Save
  // as) and Every axis (combined / separate); Restore moved to History.
  it('Export: Save as, combined or separate, asked of the parent', () => {
    btn('editor.btn.exportAxes').click();
    const heads = [...document.querySelectorAll('.editor-context-menu .editor-context-menu__heading')].map((h) => h.textContent);
    expect(heads).toEqual([t('editor.export.thisScript'), t('editor.export.everyAxis')]);
    const items = [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([t('editor.export.saveAs'), t('editor.export.combined'), t('editor.export.separate')]);
    items[2].click();
    expect(take().filter((m) => m.type === 'axes-export')).toEqual([expect.objectContaining({ kind: 'separate' })]);
    btn('editor.btn.exportAxes').click();
    [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')][0].click();
    expect(take().filter((m) => m.type === 'save-as')).toHaveLength(1);
  });

  it('History: the undo steps, then Saved versions with Restore an earlier version', () => {
    btn('editor.history.button').click();
    const heads = [...document.querySelectorAll('.editor-context-menu .editor-context-menu__heading')].map((h) => h.textContent);
    expect(heads).toEqual([t('editor.history.versionsGroup')]);
    const items = [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')].map((i) => i.textContent);
    expect(items.at(-1)).toBe(t('editor.backups.menuItem'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('Save says what it writes, as the parent tells it', () => {
    fromParent({ type: 'scripts-changed', scripts: [], activePath: null, saveKey: 'editor.btn.saveEach' });
    const save = [...document.querySelectorAll('#editor-popout-host .editor__btn')].find((b) => b.title === t('editor.btn.saveEach'));
    expect(save).toBeTruthy();
    expect(save.getAttribute('aria-label')).toBe(t('editor.btn.saveEach'));
  });

  it('Stacked: asks for the lanes, draws the ones it is sent, and a lane click switches to that axis', () => {
    btn('editor.btn.stacked').click();
    expect(take().filter((m) => m.type === 'lanes-wanted')).toEqual([expect.objectContaining({ on: true })]);
    fromParent({ type: 'lanes', lanes: [{ path: TWIST, label: 'Twist', actions: [{ at: 0, pos: 50 }, { at: 800, pos: 80 }] }] });
    const lanes = [...document.querySelectorAll('#editor-popout-host .editor__stacked-lanes .editor__lane')];
    expect(lanes.map((l) => l.querySelector('.editor__lane-label').textContent)).toEqual(['Twist']);
    lanes[0].click();
    expect(take().filter((m) => m.type === 'script-switch')).toEqual([expect.objectContaining({ path: TWIST })]);
    btn('editor.btn.stacked').click();
    expect(document.querySelectorAll('#editor-popout-host .editor__lane')).toHaveLength(0);
    expect(take().filter((m) => m.type === 'lanes-wanted')).toEqual([expect.objectContaining({ on: false })]);
  });

  it('under Custom Routing (no axis tools) New axis and Export hide', () => {
    fromParent({ type: P.SCRIPTS_CHANGED, scripts: [{ label: 'a', path: 'a', route: true }, { label: 'b', path: 'b', route: true }], activePath: 'a', axisTools: false, axesPresent: [] });
    expect(btn('editor.btn.newAxis').hidden).toBe(true);
    expect(btn('editor.btn.exportAxes').hidden).toBe(true);
    fromParent({ type: P.SCRIPTS_CHANGED, scripts: SCRIPTS, activePath: MAIN, axisTools: true, axesPresent: ['twist'] });
  });
});

describe('hiding a lane (work list 2.2)', () => {
  it('right-click > Hide takes the lane out; "Show 1 hidden lane" brings it back', () => {
    btn('editor.btn.stacked').click();
    const LANES = [
      { path: TWIST, label: 'Twist', actions: [{ at: 0, pos: 50 }] },
      { path: 'C:\V\Clip.roll.funscript', label: 'Roll', actions: [{ at: 0, pos: 20 }] },
    ];
    fromParent({ type: 'lanes', lanes: LANES });
    const laneEls = () => [...document.querySelectorAll('#editor-popout-host .editor__lane')];
    expect(laneEls()).toHaveLength(2);
    laneEls()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    const items = [...document.querySelectorAll('.editor-context-menu [role="menuitem"]')];
    expect(items[0].textContent).toBe(t('editor.lanes.hide', { name: 'Twist' }));
    items[0].click();
    expect(laneEls().map((l) => l.querySelector('.editor__lane-label').textContent)).toEqual(['Roll']);
    const show = document.querySelector('#editor-popout-host .editor__lanes-show-hidden');
    expect(show.textContent).toBe(t('editor.lanes.showHidden', { count: 1 }));
    // A new list from the parent keeps it hidden.
    fromParent({ type: 'lanes', lanes: LANES });
    expect(laneEls()).toHaveLength(1);
    document.querySelector('#editor-popout-host .editor__lanes-show-hidden').click();
    expect(laneEls()).toHaveLength(2);
    btn('editor.btn.stacked').click();
  });

  it('PageDown asks the parent for the next script in the list', () => {
    take();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(take().filter((m) => m.type === 'script-switch')).toEqual([expect.objectContaining({ path: TWIST })]);
  });
});

describe('recording mode on the toolbar (work list 4.6)', () => {
  it('the button asks the parent to turn it on, and is lit while the parent says it is on', () => {
    take();
    btn('editor.btn.record').click();
    expect(take().filter((m) => m.type === P.SET_SETTING)).toEqual([expect.objectContaining({ key: 'recordingMode', value: true })]);
    fromParent({ type: P.SETTINGS, recordingMode: true });
    expect(btn('editor.btn.record').getAttribute('aria-pressed')).toBe('true');
    fromParent({ type: P.SETTINGS, recordingMode: false });
    expect(btn('editor.btn.record').getAttribute('aria-pressed')).toBe('false');
  });
});
