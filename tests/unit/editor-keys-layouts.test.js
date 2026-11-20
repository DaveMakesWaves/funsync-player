/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar and canvas on
 * the DOM and its keys are real KeyboardEvents on the canvas; script-editor.js
 * imports DOM-branching modules (notes/CLAUDE.md "Test environments").
 */
// The docked editor's keys, from carry-over CB-04 and CB-06.
//
// CB-04: the Zoom Out button's tooltip said "(-)", but bare - has placed a
// point at 100 since 2026-05-30 (FT-032). Zoom out by key is Ctrl+-. Every
// locale's tooltip must name a key that zooms out: the chord in its
// parentheses is pressed on the real canvas, with the locale's own Ctrl word
// (Strg, ...) read as Ctrl. (Waits on the strings stage: it fails while a
// locale still says "(-)".)
//
// CB-06: Ctrl+1/2/3 (select the top / middle / bottom third) never fired on
// AZERTY, whose unshifted number row types & é ": they match the key now.
//
// Assertions: the visible time window (zoom), the points (nothing placed),
// and the selection.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const BUNDLE = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));

/** 0, 50, 100, 50, … every 250 ms: all three position thirds have points. */
const ACTIONS = Array.from({ length: 24 }, (_, i) => ({ at: i * 250, pos: [0, 50, 100, 50][i % 4] }));
const pairs = (es) => es.actions.map((a) => `${a.at}:${a.pos}`);
const selectedPositions = (es) => [...es.selectedIndices].sort((a, b) => a - b).map((i) => es.actions[i].pos);

document.body.innerHTML = '<div id="player-container"></div>';

function makeEditor() {
  // The playhead at 3.1 s: a frame with no point on it.
  const video = Object.assign(new EventTarget(), { currentTime: 3.1, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 3.1 });
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed.editableScript.loadFromData({ actions: ACTIONS });
  ed._sendLivePreview = () => {};
  ed.graph.setViewport?.(0, 6000);
  // Open, as the user has it: a closed editor is inert and takes no keys
  // (round 2, editor-closed-not-interactive.test.js).
  ed._panel.removeAttribute('inert');
  return ed;
}
const press = (ed, key, { code, ctrl = false, shift = false, alt = false } = {}) => {
  const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift, altKey: alt });
  ed._canvas.dispatchEvent(e);
  return e;
};

/** The chord in a tooltip's last parentheses as a key event: "Verkleinern (Strg+-)" → Ctrl + '-'. */
function chordOf(label, bundle) {
  const m = /\(([^()]+)\)\s*$/.exec(label);
  if (!m) return null;
  const parts = m[1].split('+').filter((p, i, arr) => p !== '' || i === arr.length - 1);
  // "Ctrl+-" → ['Ctrl', '-'];  "-" → ['-']
  const key = m[1].endsWith('+') && m[1] !== '+' ? '+' : parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const ctrlWords = new Set(['Ctrl', bundle.keys?.ctrl].filter(Boolean));
  return {
    key,
    ctrl: mods.some((w) => ctrlWords.has(w)),
    shift: mods.some((w) => w === 'Shift' || w === bundle.keys?.shift),
    alt: mods.some((w) => w === 'Alt' || w === bundle.keys?.alt),
  };
}

beforeEach(() => {
  _setBundlesForTests('en', BUNDLE.en, BUNDLE.en);
});

describe('zoom out by key (CB-04)', () => {
  it('Ctrl+- zooms the timeline out and places nothing; bare - places a point at 100', () => {
    const ed = makeEditor();
    const es = ed.editableScript;
    const before = ed.graph.viewDurationMs;
    const e = press(ed, '-', { code: 'Minus', ctrl: true });
    expect(e.defaultPrevented).toBe(true); // the View menu's interface zoom does not fire too
    expect(ed.graph.viewDurationMs).toBeGreaterThan(before);
    expect(es.actions).toHaveLength(ACTIONS.length);
    press(ed, '-', { code: 'Minus' });
    expect(pairs(es)).toContain('3100:100'); // FT-032: - is position 100
  });

  // The check below on the wording the strings stage was handed (CB-04),
  // so a red locale case means that locale's text, not this harness.
  it.each([
    ['en', 'Zoom Out (Ctrl+-)', true],
    ['de', 'Verkleinern (Strg+-)', true],
    ['en', 'Zoom Out (-)', false], // the old text: - places a point at 100
  ])('the check itself: %s "%s" → zooms out: %s', (locale, label, zooms) => {
    _setBundlesForTests(locale, BUNDLE[locale], BUNDLE.en);
    const ed = makeEditor();
    const chord = chordOf(label, BUNDLE[locale]);
    const before = { span: ed.graph.viewDurationMs, points: pairs(ed.editableScript) };
    press(ed, chord.key, { code: chord.key === '-' ? 'Minus' : undefined, ctrl: chord.ctrl, shift: chord.shift, alt: chord.alt });
    expect(ed.graph.viewDurationMs > before.span && pairs(ed.editableScript).join() === before.points.join()).toBe(zooms);
  });

  it.each(LOCALES)('%s: the Zoom Out tooltip names a key that zooms out (not bare -, which places 100)', (locale) => {
    _setBundlesForTests(locale, BUNDLE[locale], BUNDLE.en);
    const ed = makeEditor();
    const btn = ed._panel.querySelector('[data-i18n-title="editor.btn.zoomOut"]');
    expect(btn.title || btn.getAttribute('aria-label')).toBe(t('editor.btn.zoomOut'));
    const chord = chordOf(t('editor.btn.zoomOut'), BUNDLE[locale]);
    expect(chord, `no (key) in "${t('editor.btn.zoomOut')}"`).not.toBeNull();
    const before = { span: ed.graph.viewDurationMs, points: pairs(ed.editableScript) };
    press(ed, chord.key, { code: chord.key === '-' ? 'Minus' : undefined, ctrl: chord.ctrl, shift: chord.shift, alt: chord.alt });
    expect(pairs(ed.editableScript)).toEqual(before.points);
    expect(ed.graph.viewDurationMs).toBeGreaterThan(before.span);
  });
});

describe('Ctrl+1/2/3 select a third on any layout (CB-06)', () => {
  it.each([
    ['US', ['1', '2', '3']],
    ['AZERTY', ['&', 'é', '"']],
  ])('%s: Ctrl + the 1 / 2 / 3 keys select the top / middle / bottom third', (_layout, typed) => {
    const ed = makeEditor();
    const es = ed.editableScript;
    press(ed, typed[0], { code: 'Digit1', ctrl: true });
    expect(new Set(selectedPositions(es))).toEqual(new Set([100]));
    press(ed, typed[1], { code: 'Digit2', ctrl: true });
    expect(new Set(selectedPositions(es))).toEqual(new Set([50]));
    press(ed, typed[2], { code: 'Digit3', ctrl: true });
    expect(new Set(selectedPositions(es))).toEqual(new Set([0]));
    expect(es.actions).toHaveLength(ACTIONS.length); // never a point placed at 10/20/30
  });

  it('a bare number-row key on AZERTY still places nothing new by itself (& is not a position key)', () => {
    const ed = makeEditor();
    press(ed, '&', { code: 'Digit1' });
    // The digit POSITION keys run on e.code already (FT-032): Digit1 = 10.
    expect(ed.editableScript.actions.some((a) => a.pos === 10)).toBe(true);
  });
});
