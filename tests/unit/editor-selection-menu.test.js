/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar and canvas on
 * the DOM, the Every Nth dialog is the REAL Modal, keys are real
 * KeyboardEvents from the canvas up to a real player handler on `document`,
 * and script-editor.js imports DOM-branching modules (notes/CLAUDE.md
 * "Test environments").
 */
// The docked editor's two new selection commands (belgriffinite #261):
//
//   Select… dropdown, just left of Modify…, in OFS's Select-menu order. Every
//   item runs the same code as its key; the labels name the keys.
//   Every Nth point… opens a dialog whose live lines never touch the
//   selection, and whose Select recomputes from the LIVE selection.
//   N (New points only) on the canvas, stopped before the player sees it.
//   The pop-out's two ops and its dialog request, through the parent; their
//   toasts go to the pop-out while it is open (FT-029).
//   The pop-out's position keys (OP_PLACE_AT) place or tweak like the docked
//   ones, and custom position keys reach both (FT-032).
//   Letter keys on a layout that types no Latin letters (FT-035).
//
// Assertions are on what the user sees (menu items, dialog text, toasts) and
// on the resulting selection, undo stack and dirty flag.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { KeyboardHandler } = await import('../../renderer/js/keyboard.js');
const { getEditorShortcutGroups } = await import('../../renderer/js/keyboard-help.js');
const { doubleSpeed } = await import('../../renderer/js/script-modifiers.js');
const PROTOCOL = await import('../../renderer/js/editor-popout-protocol.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 100 : 0 }));
/** 0, 50, 100, 50, … so all three position thirds have points. */
const withMidpoints = (n, step = 250) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: [0, 50, 100, 50][i % 4] }));
const sel = (es) => [...es.selectedIndices].sort((a, b) => a - b);
const toasts = () => showToast.mock.calls.map((c) => c[0]);
const tick = () => new Promise((r) => setTimeout(r, 0));
const REFUSED_DOUBLE_EN =
  'Double Speed needs a continuous selection. Selections with gaps, like Every Nth point, work with move, nudge, invert and remap.';

document.body.innerHTML = '<div id="player-container"></div>';

// ONE player handler for the file: it binds to `document` and cannot be
// unbound. Its editor gate is OFF here on purpose, so a key the canvas
// failed to stop would reach the player's own action and show up below.
const player = { onLoadNext: vi.fn() };
new KeyboardHandler({
  videoPlayer: { setLoopPoint() {} },
  scriptEditor: { isOpen: false },
  onLoadNext: player.onLoadNext,
});
// The player handler also skips any key a control already preventDefault-ed
// (V43), so it cannot tell whether the canvas STOPPED a key. Other document
// listeners do not apply that rule (library.js's Ctrl+A, for one), so record
// what leaves the canvas at all.
const leftCanvas = [];
document.addEventListener('keydown', (e) => leftCanvas.push(e.key));

function makeEditor(actions, { currentTime = 0, customPositionKeys = [] } = {}) {
  const video = Object.assign(new EventTarget(), { currentTime, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: (k) => (k === 'editor.customPositionKeys' ? customPositionKeys : undefined), set() {} },
  });
  ed.editableScript.loadFromData({ actions });
  // Open, as the user has it: a closed editor is inert and takes no keys
  // (round 2, editor-closed-not-interactive.test.js).
  ed._panel.removeAttribute('inert');
  return ed;
}
const selectMenuOf = (ed) => ed._panel.querySelector('select[data-i18n-title="editor.select.title"]');
const modifyMenuOf = (ed) => ed._panel.querySelector('select[data-i18n-title="editor.modify.title"]');
const choose = (menu, value) => { menu.value = value; menu.dispatchEvent(new Event('change')); };
const press = (ed, key, mods = {}) => ed._canvas.dispatchEvent(new KeyboardEvent('keydown', {
  key, code: mods.code, bubbles: true, cancelable: true,
  shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
}));
const dialog = () => document.querySelector('.modal-panel[role="dialog"]');
const typeInto = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input')); };

beforeEach(() => {
  showToast.mockClear();
  player.onLoadNext.mockClear();
  leftCanvas.length = 0;
  _setBundlesForTests('en', EN, EN);
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
});

describe('the Select… dropdown', () => {
  it('sits just left of Modify…, lists OFS\'s Select-menu order with each key, and has two separators', () => {
    const ed = makeEditor(zigzag(4));
    const menu = selectMenuOf(ed);
    expect(menu.nextElementSibling).toBe(modifyMenuOf(ed));
    expect(menu.classList.contains('editor__speed-select')).toBe(true); // styled like Modify…
    expect([...menu.children].map((el) => (el.tagName === 'HR' ? '---' : el.textContent))).toEqual([
      'Select…',
      'Select all (Ctrl+A)',
      'Select before playhead (Ctrl+Alt+Left)',
      'Select after playhead (Ctrl+Alt+Right)',
      'Top third (Ctrl+1)',
      'Middle third (Ctrl+2)',
      'Bottom third (Ctrl+3)',
      '---',
      'Every Nth point…',
      'New points only (N)',
      '---',
      'Deselect all (Esc)',
    ]);
    expect(menu.options[0].disabled).toBe(true);
    expect(menu.title).toBe('Select points');
  });

  it('resets to its placeholder after each choice and hands the keys back to the canvas', () => {
    const ed = makeEditor(zigzag(4));
    const menu = selectMenuOf(ed);
    menu.focus();
    choose(menu, 'all');
    expect(menu.selectedIndex).toBe(0);
    expect(sel(ed.editableScript)).toEqual([0, 1, 2, 3]);
    // A focused <select> owns the arrow keys: Shift+Up would pick another
    // item instead of nudging the points just selected.
    expect(document.activeElement).toBe(ed._canvas);
  });

  it('is capped in width by the real stylesheet (its labels are long, and the toolbar does not wrap)', () => {
    const ed = makeEditor(zigzag(4));
    const style = document.createElement('style');
    style.textContent = fs.readFileSync('renderer/styles/editor.css', 'utf8');
    document.head.appendChild(style);
    try {
      expect(getComputedStyle(selectMenuOf(ed)).maxWidth).toBe('10em');
      expect(getComputedStyle(modifyMenuOf(ed)).maxWidth).not.toBe('10em');
    } finally {
      style.remove();
    }
  });

  it('re-translates with the rest of the toolbar on a language switch', () => {
    const ed = makeEditor(zigzag(4));
    _setBundlesForTests('de', DE, EN);
    eventBus.emit('language:changed', 'de');
    const menu = selectMenuOf(ed);
    expect(menu.title).toBe('Punkte auswählen');
    expect([...menu.options].map((o) => o.textContent)).toContain('Nur neue Punkte (N)');
  });
});

describe('the Modify… dropdown hands the keys back too', () => {
  // Live check 2026-11-04: after Modify → Double Speed the focus stayed on
  // the <select>, so N did nothing and a plain Down picked and RAN Half
  // Speed. The belgriffinite flow is Double Speed → N → nudge, all keys.
  it('after a direct modifier the canvas has focus, so N selects the new points', () => {
    const ed = makeEditor(zigzag(4));
    ed.editableScript.selectAll();
    const menu = modifyMenuOf(ed);
    menu.focus();
    choose(menu, 'doubleSpeed');
    expect(menu.selectedIndex).toBe(0);
    expect(document.activeElement).toBe(ed._canvas);
    const created = ed.editableScript._lastCreated.size;
    expect(created).toBeGreaterThan(0);
    press(ed, 'n');
    expect(sel(ed.editableScript)).toHaveLength(created);
  });

  it('after a refused modifier the canvas has focus as well', () => {
    const ed = makeEditor(zigzag(8));
    ed.editableScript.select(0);
    ed.editableScript.toggleSelect(2);
    ed.editableScript.toggleSelect(4);
    const menu = modifyMenuOf(ed);
    menu.focus();
    choose(menu, 'doubleSpeed');
    expect(toasts().some((s) => /continuous selection/.test(s))).toBe(true);
    expect(document.activeElement).toBe(ed._canvas);
  });
});

describe('every Select… item does exactly what its key does', () => {
  // Same start for both runs: a Double Speed made a created record, the
  // file is saved, and two points are selected.
  const start = () => {
    const ed = makeEditor(withMidpoints(13), { currentTime: 1.3 });
    const es = ed.editableScript;
    es._selectedIndices = new Set([2, 3, 4, 5, 6]);
    es.applyModifier(doubleSpeed);
    es.markSaved();
    es._selectedIndices = new Set([0, 1]);
    showToast.mockClear();
    return ed;
  };
  const outcome = (ed) => ({
    selection: sel(ed.editableScript),
    actions: ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`),
    undo: ed.editableScript._undoStack.length,
    dirty: ed.editableScript.dirty,
    toasts: toasts(),
  });

  it.each([
    ['all', 'a', { ctrl: true }],
    ['beforePlayhead', 'ArrowLeft', { ctrl: true, alt: true }],
    ['afterPlayhead', 'ArrowRight', { ctrl: true, alt: true }],
    ['topThird', '1', { ctrl: true, code: 'Digit1' }],
    ['middleThird', '2', { ctrl: true, code: 'Digit2' }],
    ['bottomThird', '3', { ctrl: true, code: 'Digit3' }],
    ['created', 'n', { code: 'KeyN' }],
    ['none', 'Escape', {}],
  ])('%s = its key (%s)', (value, key, mods) => {
    const viaMenu = start();
    choose(selectMenuOf(viaMenu), value);
    const menuOutcome = outcome(viaMenu);
    showToast.mockClear();

    const viaKey = start();
    press(viaKey, key, mods);
    const keyOutcome = outcome(viaKey);

    expect(menuOutcome).toEqual(keyOutcome);
    expect(menuOutcome.selection).not.toEqual([0, 1]); // it did something
    expect(menuOutcome.dirty).toBe(false);             // selection only (Q4)
    expect(menuOutcome.undo).toBe(1);                  // just the Double Speed
    expect(player.onLoadNext).not.toHaveBeenCalled();
  });

  it('Deselect all only ever clears: with nothing selected it does not close the editor (Esc would)', () => {
    const ed = start();
    ed.editableScript.clearSelection();
    const hide = vi.spyOn(ed, 'hide');
    choose(selectMenuOf(ed), 'none');
    expect(hide).not.toHaveBeenCalled();
    press(ed, 'Escape');
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

describe('N on the editor canvas (New points only)', () => {
  it('selects the points the last modifier created, toasts the count, and never reaches the player', () => {
    const ed = makeEditor(zigzag(5));
    const es = ed.editableScript;
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.markSaved();
    press(ed, 'n', { code: 'KeyN' });
    expect(sel(es)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(toasts()).toEqual(['Selected 6 new points.']);
    expect(es.dirty).toBe(false);
    expect(es._undoStack).toHaveLength(1);
    expect(player.onLoadNext).not.toHaveBeenCalled();
    expect(leftCanvas).toEqual([]); // stopped on the canvas, not just preventDefault-ed
  });

  it('with nothing recorded: says so and leaves the selection alone', () => {
    const ed = makeEditor(zigzag(5));
    ed.editableScript.select(2);
    press(ed, 'n', { code: 'KeyN' });
    expect(sel(ed.editableScript)).toEqual([2]);
    expect(toasts()).toEqual(['No new points to select. Run a modifier or generator first.']);
    expect(player.onLoadNext).not.toHaveBeenCalled();
  });

  it('Ctrl+N and Alt+N are not New points only', () => {
    const ed = makeEditor(zigzag(5));
    const es = ed.editableScript;
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.select(0);
    press(ed, 'n', { ctrl: true, code: 'KeyN' });
    press(ed, 'n', { alt: true, code: 'KeyN' });
    expect(sel(es)).toEqual([0]);
    expect(toasts()).toEqual([]);
  });

  it('a custom position key bound to bare N before this change still wins (Dave, Q2)', () => {
    const ed = makeEditor(zigzag(5), { currentTime: 3, customPositionKeys: [{ code: 'KeyN', mods: {}, position: 35 }] });
    const es = ed.editableScript;
    es.selectAll();
    es.applyModifier(doubleSpeed);
    press(ed, 'n', { code: 'KeyN' });
    expect(es.actions.some((a) => a.pos === 35)).toBe(true); // placed at the custom position
    expect(toasts()).not.toContain('Selected 6 new points.');
  });

  it('is listed in the editor help, in the selection group', () => {
    const group = getEditorShortcutGroups().find((g) => g.title === EN.kbd.editorSelection);
    expect(group.rows).toContainEqual(['N', 'Select only the points the last modifier or generator created']);
  });
});

describe('the Every Nth point… dialog', () => {
  const open = (ed) => { choose(selectMenuOf(ed), 'everyNth'); return dialog(); };
  const field = (id) => dialog().querySelector(`#${id}`);

  it('shows Every 2 / Start at point 1, the scope and a live count; Cancel changes nothing', async () => {
    const ed = makeEditor(zigzag(13));
    ed.editableScript._selectedIndices = new Set([...Array(10).keys()]);
    const d = open(ed);
    expect(d.querySelector('.modal-title').textContent).toBe('Select every Nth point');
    expect(d.textContent).toContain('Every');
    expect(d.textContent).toContain('Start at point');
    expect(field('nth-every').value).toBe('2');
    expect(field('nth-start').value).toBe('1');
    expect(field('nth-scope').textContent).toBe('Counts the 10 selected points in time order.');
    expect(field('nth-result').textContent).toBe('Selects 5 points.');
    expect(field('nth-cancel').textContent).toBe('Cancel');
    expect(field('nth-ok').textContent).toBe('Select');
    field('nth-cancel').click();
    await tick();
    expect(dialog()).toBeNull();
    expect(sel(ed.editableScript)).toEqual([...Array(10).keys()]);
    expect(toasts()).toEqual([]);
  });

  it('with nothing selected it counts the whole script', () => {
    const ed = makeEditor(zigzag(13));
    open(ed);
    expect(field('nth-scope').textContent).toBe('Counts all 13 points in time order.');
    expect(field('nth-result').textContent).toBe('Selects 7 points.');
  });

  it('the live line follows the fields and NEVER changes the selection while the dialog is open', () => {
    const ed = makeEditor(zigzag(13));
    const es = ed.editableScript;
    es._selectedIndices = new Set([...Array(12).keys()]);
    const setBefore = es.selectedIndices;
    const changes = vi.fn();
    const onChange = es.onChange;
    es.onChange = () => { changes(); onChange(); };
    open(ed);
    typeInto(field('nth-every'), 3);
    expect(field('nth-result').textContent).toBe('Selects 4 points.');
    typeInto(field('nth-start'), 2);
    expect(field('nth-result').textContent).toBe('Selects 4 points.');
    typeInto(field('nth-every'), 5);
    expect(field('nth-result').textContent).toBe('Selects 3 points.');
    typeInto(field('nth-every'), 1); // clamped to 2
    expect(field('nth-result').textContent).toBe('Selects 6 points.');
    expect(es.selectedIndices).toBe(setBefore);
    expect(sel(es)).toEqual([...Array(12).keys()]);
    expect(changes).not.toHaveBeenCalled();
  });

  it('Select selects every Nth, toasts "Selected n of k points.", pushes no undo step, leaves dirty alone, and the canvas has focus', async () => {
    const ed = makeEditor(zigzag(13));
    const es = ed.editableScript;
    es._selectedIndices = new Set([...Array(10).keys()]);
    open(ed);
    typeInto(field('nth-every'), 3);
    typeInto(field('nth-start'), 2);
    field('nth-ok').click();
    await tick();
    expect(sel(es)).toEqual([1, 4, 7]);
    expect(toasts()).toEqual(['Selected 3 of 10 points.']);
    expect(es._undoStack).toHaveLength(0);
    expect(es.dirty).toBe(false);
    expect(document.activeElement).toBe(ed._canvas);
  });

  it('Select recomputes from the LIVE selection (the pop-out changed it while the dialog was open)', async () => {
    const ed = makeEditor(zigzag(13));
    ed.editableScript._selectedIndices = new Set([...Array(10).keys()]);
    open(ed);
    expect(field('nth-result').textContent).toBe('Selects 5 points.');
    ed._applyPopoutEdit({ op: PROTOCOL.OP_SELECT, indices: [6, 7, 8, 9, 10, 11] }); // a rubber band in the pop-out
    field('nth-ok').click();
    await tick();
    expect(sel(ed.editableScript)).toEqual([6, 8, 10]);
    expect(toasts()).toEqual(['Selected 3 of 6 points.']);
  });

  it('remembers the last values for the session', async () => {
    const ed = makeEditor(zigzag(13));
    open(ed);
    typeInto(field('nth-every'), 4);
    typeInto(field('nth-start'), 3);
    field('nth-ok').click();
    await tick();
    open(ed);
    expect(field('nth-every').value).toBe('4');
    expect(field('nth-start').value).toBe('3');
    field('nth-cancel').click();
    await tick();
  });

  it('fewer than 2 points to count: says so in the dialog and in the toast, and changes nothing', async () => {
    const ed = makeEditor(zigzag(13));
    ed.editableScript.select(5);
    open(ed);
    expect(field('nth-scope').textContent).toBe('Counts the 1 selected point in time order.');
    expect(field('nth-result').textContent).toBe('Needs at least 2 points to count.');
    field('nth-ok').click();
    await tick();
    expect(sel(ed.editableScript)).toEqual([5]);
    expect(toasts()).toEqual(['Nothing to select: Every Nth point needs at least 2 points.']);
  });

  it('a sequence modifier on an Every Nth selection is refused with the new wording', async () => {
    const ed = makeEditor(zigzag(13));
    ed.editableScript.selectAll();
    open(ed);
    field('nth-ok').click(); // Every 2 from 1
    await tick();
    showToast.mockClear();
    const before = ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`);
    choose(modifyMenuOf(ed), 'doubleSpeed');
    await tick();
    expect(ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(before);
    expect(toasts()).toEqual([
      'Double Speed needs a continuous selection. Selections with gaps, like Every Nth point, work with move, nudge, invert and remap.',
    ]);
  });
});

describe('the pop-out, routed through the REAL parent editor', () => {
  const fromPopout = (ed, payload) => ed._handlePopoutMessage(payload);

  it('OP_SELECT_CREATED (the pop-out\'s N) selects the new points and toasts (no pop-out open: in this window)', () => {
    const ed = makeEditor(zigzag(5));
    const es = ed.editableScript;
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.markSaved();
    fromPopout(ed, PROTOCOL.editOp(PROTOCOL.OP_SELECT_CREATED));
    expect(sel(es)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(toasts()).toEqual(['Selected 6 new points.']);
    expect(es.dirty).toBe(false);
    expect(es._undoStack).toHaveLength(1);
  });

  it('OP_SELECT_EVERY_NTH {n, start} applies the chosen values and toasts the real result', () => {
    const ed = makeEditor(zigzag(13));
    ed.editableScript.selectAll();
    fromPopout(ed, PROTOCOL.editOp(PROTOCOL.OP_SELECT_EVERY_NTH, { n: 4, start: 2 }));
    expect(sel(ed.editableScript)).toEqual([1, 5, 9]);
    expect(toasts()).toEqual(['Selected 3 of 13 points.']);
    expect(ed.editableScript._undoStack).toHaveLength(0);
  });

  it('REQUEST_SELECT_EVERY_NTH (the pop-out\'s menu item) opens the dialog in the parent, which applies to the parent\'s script', async () => {
    const ed = makeEditor(zigzag(13));
    ed.editableScript.selectAll();
    fromPopout(ed, PROTOCOL.msg(PROTOCOL.REQUEST_SELECT_EVERY_NTH));
    expect(dialog().querySelector('.modal-title').textContent).toBe('Select every Nth point');
    dialog().querySelector('#nth-ok').click();
    await tick();
    expect(sel(ed.editableScript)).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });
});

/** An editor whose pop-out is open; returns what it relays to the pop-out. */
function withPopout(ed) {
  const relayed = [];
  window.funsync = { editorPopoutRelay: (direction, payload) => relayed.push({ direction, payload }) };
  ed._popoutOpen = true;
  return relayed;
}
const toastsToPopout = (relayed) => relayed
  .filter((r) => r.direction === 'to-popout' && r.payload.type === PROTOCOL.TOAST)
  .map((r) => r.payload);

describe('toasts for pop-out commands show in the pop-out (FT-029)', () => {
  afterEach(() => { delete window.funsync; });

  it('Every Nth (OP_SELECT_EVERY_NTH): the translated result goes to the pop-out, not this window', () => {
    const ed = makeEditor(zigzag(13));
    const relayed = withPopout(ed);
    ed.editableScript.selectAll();
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_SELECT_EVERY_NTH, { n: 4, start: 2 }));
    expect(sel(ed.editableScript)).toEqual([1, 5, 9]);
    expect(toastsToPopout(relayed)).toEqual([
      { type: PROTOCOL.TOAST, text: 'Selected 3 of 13 points.', level: 'info', dismissLabel: EN.toast.dismissAria },
    ]);
    expect(toasts()).toEqual([]);
  });

  it('N (OP_SELECT_CREATED), and with nothing recorded', () => {
    const ed = makeEditor(zigzag(5));
    const relayed = withPopout(ed);
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_SELECT_CREATED));
    ed.editableScript.selectAll();
    ed.editableScript.applyModifier(doubleSpeed);
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_SELECT_CREATED));
    expect(toastsToPopout(relayed).map((m) => m.text)).toEqual([
      'No new points to select. Run a modifier or generator first.',
      'Selected 6 new points.',
    ]);
    expect(toasts()).toEqual([]);
  });

  it('a refused Modify item (OP_APPLY_MODIFIER) warns in the pop-out, translated by this window', () => {
    _setBundlesForTests('de', DE, EN);
    const ed = makeEditor(zigzag(13));
    const relayed = withPopout(ed);
    ed.editableScript.selectByPositionRange(0, 33);
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_APPLY_MODIFIER, { name: 'doubleSpeed' }));
    const [toast] = toastsToPopout(relayed);
    expect(toast.level).toBe('warn');
    expect(toast.text).toBe(t('editor.toast.needsContinuous', { name: DE.editor.modify.doubleSpeed }));
    expect(toast.text).toContain(DE.editor.modify.doubleSpeed);
    expect(toast.text).not.toBe(REFUSED_DOUBLE_EN);
    expect(toast.dismissLabel).toBe(DE.toast.dismissAria);
    expect(toasts()).toEqual([]);
  });

  it("this window's own commands still toast here", () => {
    const ed = makeEditor(zigzag(5));
    const relayed = withPopout(ed);
    ed._runSelectCommand('created');
    expect(toasts()).toEqual(['No new points to select. Run a modifier or generator first.']);
    expect(toastsToPopout(relayed)).toEqual([]);
  });
});

describe("the pop-out's position keys and custom keys (FT-032)", () => {
  afterEach(() => { delete window.funsync; });

  it('OP_PLACE_AT on the selected point\'s frame moves that point; no duplicate (the old OP_INSERT stacked one)', () => {
    const ed = makeEditor(zigzag(5)); // 0, 500, 1000, 1500, 2000
    const es = ed.editableScript;
    es.select(2);
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PLACE_AT, { at: 1000, pos: 35 }));
    expect(es.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(['0:0', '500:100', '1000:35', '1500:100', '2000:0']);
    expect(sel(es)).toEqual([2]);
    // A different frame inserts and selects the new point, as the docked key.
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PLACE_AT, { at: 1200, pos: 100 }));
    expect(es.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(['0:0', '500:100', '1000:35', '1200:100', '1500:100', '2000:0']);
    expect(sel(es)).toEqual([3]);
    // Then the same key again on that frame tweaks it.
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PLACE_AT, { at: 1200, pos: 60 }));
    expect(es.actions).toHaveLength(6);
    expect(es.actions[3]).toEqual({ at: 1200, pos: 60 });
  });

  it('OP_PLACE_AT clamps a bad position and ignores a missing one', () => {
    const ed = makeEditor(zigzag(2));
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PLACE_AT, { at: 3000, pos: 140 }));
    ed._handlePopoutMessage(PROTOCOL.editOp(PROTOCOL.OP_PLACE_AT, { at: 4000 }));
    expect(ed.editableScript.actions.map((a) => `${a.at}:${a.pos}`)).toEqual(['0:0', '500:100', '3000:100']);
  });

  it('the custom keys go to the pop-out in INITIAL_STATE and in SETTINGS', () => {
    const keys = [{ code: 'KeyJ', mods: {}, position: 35 }];
    const ed = makeEditor(zigzag(4), { customPositionKeys: keys });
    const relayed = withPopout(ed);
    ed._handlePopoutMessage(PROTOCOL.msg(PROTOCOL.READY));
    ed._broadcastSettings();
    const out = relayed.map((r) => r.payload);
    expect(out.find((m) => m.type === PROTOCOL.INITIAL_STATE).customPositionKeys).toEqual(keys);
    expect(out.find((m) => m.type === PROTOCOL.SETTINGS).customPositionKeys).toEqual(keys);
  });

  it('a binding saved in Settings reaches the docked canvas AND the open pop-out without a restart', () => {
    // DataService emits settings:changed as { path, value }. The editor
    // compared that object with the key, so its map was only ever built at
    // construction (found with FT-032).
    let stored = [];
    const ed = makeEditor(zigzag(4), { currentTime: 3 });
    ed.settings = { get: (k) => (k === 'editor.customPositionKeys' ? stored : undefined), set() {} };
    const relayed = withPopout(ed);
    stored = [{ code: 'KeyJ', mods: {}, position: 35 }];
    eventBus.emit('settings:changed', { path: 'editor.customPositionKeys', value: stored });
    press(ed, 'j', { code: 'KeyJ' });
    expect(ed.editableScript.actions.find((a) => a.at === 3000)).toEqual({ at: 3000, pos: 35 });
    const settings = relayed.map((r) => r.payload).filter((m) => m.type === PROTOCOL.SETTINGS);
    expect(settings.at(-1).customPositionKeys).toEqual(stored);
  });

  it('the docked canvas resolves the same keys the pop-out does: Shift+0, -, Numpad- → 100; Shift+5 nothing', () => {
    const ed = makeEditor([], { currentTime: 1 });
    const es = ed.editableScript;
    // Each press lands on the selected point's frame, so it moves that point.
    const after = (key, mods) => { press(ed, key, mods); return es.actions.map((a) => `${a.at}:${a.pos}`); };
    expect(after(')', { shift: true, code: 'Digit0' })).toEqual(['1000:100']);
    expect(after('%', { shift: true, code: 'Digit5' })).toEqual(['1000:100']); // Shift+5: nothing
    expect(after('3', { code: 'Digit3' })).toEqual(['1000:30']);
    expect(after('-', { code: 'Minus' })).toEqual(['1000:100']);
    expect(after('3', { code: 'Numpad3' })).toEqual(['1000:30']);
    expect(after('-', { code: 'NumpadSubtract' })).toEqual(['1000:100']);
  });
});

describe('letter keys on a layout without Latin letters (FT-035)', () => {
  it.each([
    ['Russian т', 'т'],
    ['Korean ㅜ', 'ㅜ'],
  ])('N on %s runs New points only on the docked canvas', (_, key) => {
    const ed = makeEditor(zigzag(5));
    const es = ed.editableScript;
    es.selectAll();
    es.applyModifier(doubleSpeed);
    es.clearSelection();
    press(ed, key, { code: 'KeyN' });
    expect(sel(es)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(toasts()).toEqual(['Selected 6 new points.']);
    expect(player.onLoadNext).not.toHaveBeenCalled();
  });

  it("AZERTY keeps its own letters: the key at KeyQ types a and does NOT insert Q's alternating point", () => {
    const ed = makeEditor(zigzag(3), { currentTime: 5 });
    press(ed, 'a', { code: 'KeyQ' });
    expect(ed.editableScript.actions).toHaveLength(3);
    press(ed, 'q', { code: 'KeyA' }); // AZERTY's Q
    expect(ed.editableScript.actions).toHaveLength(4);
  });
});
