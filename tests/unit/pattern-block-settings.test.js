/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds its Playback area as DOM, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Settings > Playback > Gap Filler, Orgasm Switch (X) and Edge Hold (Z): ONE
// Pattern block, laid out the same way in all three (Dave, 2026-11-19: "give
// them all the same options laid out the same way"; DESIGN-pattern-settings-
// unify.md §1-§2), in ONE drawer behind a "Set pattern…" button (Dave, ~14:20:
// the sections were "rather big") under a one-line summary and a small graph
// of the applied choice (~14:25). The REAL SettingsPanel over a settings store
// that behaves like DataService (dotted paths into one object);
// pattern-choice.js is the REAL module once pf-engine has filled it in, a fake
// on the real library engine until then (helpers/pattern-choice-fake.js), and
// every expectation goes through the module, never a key name of its own.
//
//   - PARITY: the drawer is identical for all three (same rows, order,
//     controls, in every state; the same clicks give the same choice) and the
//     three sections have the same row structure (their "when" rows, then the
//     same summary row with its graph)
//   - the drawer works on a DRAFT: nothing is written until Apply; Cancel,
//     Escape (the drawer closes, Settings stays), the ✕ and a click outside
//     write nothing; Apply writes only that feature's keys and redraws the
//     summary and its graph (Cancel does not)
//   - no BPM anywhere in the three sections or the drawer, in any of the 8
//     locales, even for a v0.9.2 config that stored BPM
//   - the old keys are never written; opening Settings writes nothing
//   - the summary row shows only while the feature's source is a pattern
//   - Test plays the draft through app.js's REAL path, never while a video
//     drives the devices, and stops when the drawer or Settings closes
//   - keyboard and screen-reader names, focus in and back out; German;
//     light / dark and an 800 x 600 window at 150 % (the CSS; the look itself
//     is checked live)
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/pattern-choice.js', async (importOriginal) => {
  const { contractOrFake } = await import('./helpers/pattern-choice-fake.js');
  return contractOrFake(await importOriginal());
});

import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel, safePatternWrites } from '../../renderer/components/settings-panel.js';
import { summarizePatternChoice, SUMMARY_GRAPH_MS } from '../../renderer/components/pattern-drawer.js';
import {
  readPatternChoice, patternChoiceWrites, listQuickPicks, normalizePatternChoice, renderPatternSample, patternStats,
  CONTRACT_UNDER_TEST,
} from '../../renderer/js/pattern-choice.js';
import { listPatterns } from '../../renderer/js/pattern-library.js';
import { FillerTestPlayer } from '../../renderer/js/filler-test-player.js';
import { liftAppClass } from './helpers/app-methods.js';
import { withPatternBlockStrings, PATTERN_BLOCK_LOCALES } from './helpers/pattern-block-strings.js';
import { withPatternFixupStrings } from './helpers/pattern-fixup-strings.js';

const BUNDLES = Object.fromEntries(PATTERN_BLOCK_LOCALES.map((l) => [
  l, withPatternFixupStrings(withPatternBlockStrings(JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8')), l), l),
]));
const EN = BUNDLES.en;
// LF whatever the checkout: CI's Windows runner checks out with CRLF (v0.10.0 tag, 2026-11-20).
const MODAL_CSS = fs.readFileSync('renderer/styles/modal.css', 'utf8').replace(/\r\n/g, '\n');
const PLAYER_CSS = fs.readFileSync('renderer/styles/player.css', 'utf8').replace(/\r\n/g, '\n');

const FEATURES = ['gapFiller', 'orgasm', 'edge'];
const PREFIX = { gapFiller: 'sp-filler-pattern', orgasm: 'sp-orgasm-pattern', edge: 'sp-edge-pattern' };
const HEADER = { gapFiller: 'fillerHeader', orgasm: 'orgasmHeader', edge: 'edgeHeader' };
const ROWS_ID = { gapFiller: 'sp-filler-pattern-rows', orgasm: 'sp-orgasm-pattern-rows', edge: 'sp-edge-pattern-rows' };
const SECTION = { gapFiller: '#sp-sec-gapfiller', orgasm: '#sp-sec-orgasm', edge: '#sp-sec-edge' };
const OLD_KEYS = ['orgasmPattern', 'orgasmLibraryPattern', 'edgePattern'];
const ENDINGS = listPatterns({ loopable: false }).map((p) => p.id);
const SAMPLE = { durationMs: 8000, scriptRange: { min: 0, max: 100 } };
// Mixed flutters at the tip in a 5-unit band: the engine widens it.
const NARROW = { id: 'mixed-flutters-tip', speed: 172, rangeMode: 'exact', min: 20, max: 25 };

// A v0.9.2 config: Dave's filler (on, 10 s) on a custom BPM shape, a
// Generated orgasm pattern at 150 BPM, an edge pattern from the library.
const V092 = () => ({
  gapSkip: { mode: 'off', threshold: 10000 },
  gapFiller: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'sine', bpm: 45, depthPct: 80, absolute: null } },
  orgasmSwitchMode: 'hold',
  orgasmPattern: { enabled: true, type: 'sawtooth', bpm: 150, min: 0, max: 100 },
  orgasmLibraryPattern: { enabled: false, id: null, speed: null, reversed: false, min: null, max: null },
  edgeHoldAction: 'pattern',
  edgePattern: { id: 'quick-full-strokes', speed: 150, reversed: true, min: null, max: null },
});

/** DataService's get / set: dotted paths into one settings object; every set recorded. */
function makeSettings(player = {}) {
  const data = { player: JSON.parse(JSON.stringify(player)) };
  const writes = [];
  return {
    data,
    writes,
    get(path) {
      let v = data;
      for (const k of path.split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
      return v;
    },
    set(path, value) {
      writes.push({ key: path, value: JSON.parse(JSON.stringify(value ?? null)) });
      const keys = path.split('.');
      let o = data;
      for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
      o[keys.at(-1)] = value;
    },
    getAll: () => data,
  };
}

/** Seed the same choice for all three, written the way the module writes it, sources on. */
function seedAll(choice, extra = {}) {
  const s = makeSettings({ gapFiller: { enabled: true }, orgasmSource: 'pattern', edgeHoldAction: 'pattern', ...extra });
  for (const f of FEATURES) {
    for (const { key, value } of safePatternWrites(patternChoiceWrites(f, normalizePatternChoice(choice), s.data.player), s.data.player)) s.set(key, value);
  }
  s.writes.length = 0;
  return s;
}

// app.js's REAL test path, on fake sync engines (no device).
const LiftedApp = liftAppClass(['_startFillerTest'], { FillerTestPlayer });
function fakeSync() {
  return {
    driving: false,
    sent: [],
    stops: 0,
    isDriving() { return this.driving; },
    sendLinearNow(pos) { this.sent.push(pos); },
    sendPositionNow(pos) { this.sent.push(pos); },
    stopTestOutput() { this.stops++; },
  };
}
function makeApp() {
  const app = new LiftedApp();
  app.buttplugSync = fakeSync();
  app.tcodeSync = fakeSync();
  app.buttplugManager = { connected: true };
  app.tcodeManager = { connected: false };
  app._fillerTest = new FillerTestPlayer({
    buttplugSync: app.buttplugSync, tcodeSync: app.tcodeSync, setInterval: () => 1, clearInterval: () => {},
  });
  return app;
}

/** A recording 2D context per canvas: every stroke the drawing makes. */
let contexts;
function recordingContext() {
  return {
    strokes: [],
    _path: [],
    setTransform() {}, clearRect() {}, save() {}, restore() {}, closePath() {}, fill() {},
    beginPath() { this._path = []; },
    moveTo(x, y) { this._path.push([x, y]); },
    lineTo(x, y) { this._path.push([x, y]); },
    stroke() { this.strokes.push({ style: this.strokeStyle, path: this._path.slice() }); },
  };
}

let showing;
let callbacks;
let tested;
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (sel) => document.querySelector(sel);

async function openPlayback(settings, { app = makeApp(), orgasmSummary = 'finish.funscript' } = {}) {
  tested = [];
  callbacks = {
    onGapFillerChanged: vi.fn(),
    onOrgasmPatternChanged: vi.fn(async () => {}),
    getOrgasmScriptName: vi.fn(() => orgasmSummary),
  };
  const panel = new SettingsPanel({
    settings,
    ...callbacks,
    onTestFillerPattern: (actions, hooks) => { tested.push(actions); return app._startFillerTest(actions, hooks); },
    onStopFillerTest: () => app._fillerTest?.stop(),
  });
  showing = panel.show();
  $('.settings-panel__rail-item[data-area="playback"]').click();
  await flush(); // Playback wires its controls on a 0 ms timer after mount
  // Modal focuses its first control on the next frame; a person cannot open
  // a drawer before that, so neither does the test.
  await new Promise((r) => requestAnimationFrame(() => r()));
  return { panel, app };
}
async function closeSettings() {
  $('.settings-panel__done-btn')?.click();
  await showing;
  showing = null;
}

const ctl = (f, s) => $(`#${PREFIX[f]}-${s}`);
const drawer = (f) => $(`#${PREFIX[f]}-drawer`);
const block = (f) => $(`#${PREFIX[f]}`);
const openDrawer = async (f) => { ctl(f, 'set').click(); await flush(); return drawer(f); };
const applyDrawer = async (f) => { ctl(f, 'drawer-apply').click(); await flush(); };
const cancelDrawer = async (f) => { ctl(f, 'drawer-cancel').click(); await flush(); };
const pressEscape = async () => {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush();
};
const change = async (node, value) => {
  if (value !== undefined) node.value = String(value);
  node.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};
/** Hidden itself or inside something hidden, up to `root`. */
const shown = (node, root) => {
  for (let n = node; n && n !== root.parentElement; n = n.parentElement) if (n.hidden) return false;
  return true;
};
const strip = (f, id) => (id || '').replace(PREFIX[f], '#');

/** Everything a user meets in a feature's drawer: its shell and the block's rows, by role. */
function drawerSignature(f) {
  const root = block(f);
  const rows = [...root.querySelectorAll('[data-row]')].map((row) => ({
    row: row.dataset.row,
    label: row.querySelector('.settings-panel__field-label')?.textContent ?? null,
    shown: shown(row, root),
    controls: [...row.querySelectorAll('input, select, button, canvas')].map((c) => ({
      id: strip(f, c.id),
      tag: c.tagName,
      type: c.getAttribute('type') || '',
      role: c.getAttribute('role') || '',
      value: c.tagName === 'SELECT' || c.type === 'range' ? c.value : (c.getAttribute('aria-checked') ?? c.textContent),
      min: c.getAttribute('min'),
      max: c.getAttribute('max'),
      options: c.tagName === 'SELECT' ? [...c.options].map((o) => `${o.value}=${o.textContent}${o.disabled ? ' (disabled)' : ''}`) : null,
    })),
  }));
  // The lines between the rows (description, stats, notes): present and shown alike.
  const lines = [...root.querySelectorAll('.settings-panel__hint')].map((h) => `${strip(f, h.id)}:${shown(h, root)}`);
  const d = drawer(f);
  const sheet = d.querySelector('.pattern-drawer__sheet');
  const shell = {
    role: sheet.getAttribute('role'),
    modal: sheet.getAttribute('aria-modal'),
    labelledBy: strip(f, sheet.getAttribute('aria-labelledby')),
    buttons: [...d.querySelectorAll('.pattern-drawer__head button, .pattern-drawer__foot button')].map((b) => `${strip(f, b.id)}=${b.textContent}`),
  };
  return { shell, rows, lines };
}

/** A section's summary row, by role (the words of the line differ with the choice, not the feature). */
function summarySignature(f) {
  const row = $(`#${ROWS_ID[f]} [data-row="pattern-summary"]`);
  return {
    label: row.querySelector('.settings-panel__field-label').textContent,
    children: [...row.querySelectorAll('*')].map((n) => `${n.tagName}#${strip(f, n.id)}.${n.className}`),
    button: `${ctl(f, 'set').textContent}|${ctl(f, 'set').getAttribute('aria-haspopup')}|${strip(f, ctl(f, 'set').getAttribute('aria-describedby'))}`,
    graph: `${ctl(f, 'summary-graph').getAttribute('aria-hidden')}|${ctl(f, 'summary-graph').width}x${ctl(f, 'summary-graph').height}|shown:${!ctl(f, 'summary-graph').hidden}`,
    text: ctl(f, 'summary').textContent,
  };
}

beforeEach(() => {
  showing = null;
  document.body.innerHTML = '<div id="toast-container"></div>';
  contexts = new Map();
  HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!contexts.has(this)) contexts.set(this, recordingContext());
    return contexts.get(this);
  };
  _setBundlesForTests('en', EN, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});
afterEach(async () => { if (showing) await closeSettings(); });
afterAll(() => _setBundlesForTests('en', BUNDLES.en, BUNDLES.en));

describe('the contract under test', () => {
  it('is the real pattern-choice.js once pf-engine has filled it in, else the fake on the real engine', () => {
    expect(['real', 'fake']).toContain(CONTRACT_UNDER_TEST);
    expect(listQuickPicks().length).toBeGreaterThan(0);
  });
});

describe('PARITY: one drawer, laid out the same way, for Gap Filler, Orgasm Switch and Edge Hold', () => {
  const ORDER = ['quick', 'family', 'pattern', 'preview', 'speed', 'reverse', 'range', 'min', 'max', 'depth', 'centre', 'test'];

  const states = [
    ['a quick pick', () => listQuickPicks()[0].choice],
    ['Exact range, reversed, own speed', () => ({ id: 'slow-tip-strokes', reversed: true, rangeMode: 'exact', min: 30, max: 70 })],
    ['Follow the script with a centre, a set speed', () => ({ id: 'quick-full-strokes', speed: 150, rangeMode: 'script', depthPct: 60, centrePct: 30 })],
    ['a Simple shape', () => ({ id: 'shape-triangle', speed: 200 })],
    ['an ending', () => ({ id: ENDINGS[0] })],
    ['no pattern chosen', () => ({ id: null })],
  ];
  for (const [name, choice] of states) {
    it(`the same drawer (rows, order, controls) and the same section rows: ${name}`, async () => {
      await openPlayback(seedAll(choice()));
      const sigs = [];
      for (const f of FEATURES) {
        await openDrawer(f);
        sigs.push(drawerSignature(f));
        await cancelDrawer(f);
      }
      const [gap, x, z] = sigs;
      expect(gap.rows.map((r) => r.row)).toEqual(ORDER);
      // The ending hint names what each feature does with an ending (a gap,
      // a held key): its words differ, its place does not.
      expect(x).toEqual(z);
      expect(gap).toEqual(x);
      const [sg, sx, sz] = FEATURES.map(summarySignature);
      expect(sx).toEqual(sz);
      expect(sg).toEqual(sx);
    });
  }

  it('the drawer\'s title names the feature', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes' }));
    for (const f of FEATURES) {
      await openDrawer(f);
      expect(ctl(f, 'drawer-title').textContent).toBe(`${EN.settingsPanel.playback[HEADER[f]]} pattern`);
      expect(drawer(f).querySelector('[role="dialog"]').getAttribute('aria-labelledby')).toBe(`${PREFIX[f]}-drawer-title`);
      await cancelDrawer(f);
    }
  });

  it('the same clicks give each the same choice', async () => {
    const s = seedAll(listQuickPicks()[0].choice);
    await openPlayback(s);
    for (const f of FEATURES) {
      await openDrawer(f);
      await change(ctl(f, 'family'), '');
      await change(ctl(f, 'id'), 'slow-tip-strokes');
      await change(ctl(f, 'speed'), 90);
      ctl(f, 'reverse').click();
      await flush();
      await change(ctl(f, 'range-mode'), 'exact');
      await change(ctl(f, 'min'), 25);
      await applyDrawer(f);
    }
    const [gap, x, z] = FEATURES.map((f) => readPatternChoice(f, s.data.player));
    expect(gap).toMatchObject({ id: 'slow-tip-strokes', speed: 90, reversed: true, rangeMode: 'exact', min: 25 });
    expect(x).toEqual(gap);
    expect(z).toEqual(gap);
    const [sg, sx, sz] = FEATURES.map(summarySignature);
    expect(sx).toEqual(sz);
    expect(sg).toEqual(sx);
  });

  it('each section: its own "when" rows, then the one summary row, in the same row style', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes' }));
    const whenRows = {
      gapFiller: ['#sp-filler-enabled', '#sp-filler-threshold'],
      orgasm: ['#sp-orgasm-mode', '#sp-orgasm-source'],
      edge: ['#sp-edge-mode', '#sp-edge-action'],
    };
    for (const f of FEATURES) {
      const summary = $(`#${ROWS_ID[f]} [data-row="pattern-summary"]`);
      for (const sel of whenRows[f]) {
        const row = $(sel).closest('.settings-panel__field');
        expect(row.querySelector('.settings-panel__field-label').tagName, sel).toBe('LABEL');
        // eslint-disable-next-line no-bitwise
        expect(row.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING, sel).toBeTruthy();
      }
      expect(summary.querySelector('.settings-panel__field')).not.toBeNull();
      // No block in the section any more: it is in the drawer.
      expect($(SECTION[f]).querySelector('.pattern-block')).toBeNull();
      expect($(SECTION[f]).querySelector('[data-row="speed"]')).toBeNull();
    }
    expect([...$('#sp-orgasm-source').options].map((o) => [o.value, o.textContent])).toEqual([['file', 'Script file'], ['pattern', 'Pattern']]);
    expect([...$('#sp-edge-action').options].map((o) => o.value)).toEqual(['stop', 'pattern']);
    expect($('#sp-filler-threshold-row .settings-panel__field-label').textContent).toBe('Fill gaps longer than');
  });
});

describe('the summary row: the applied choice in a line, and its small graph', () => {
  it('says what plays (name, units/s, reversed, range) or "No pattern chosen yet"', async () => {
    const s = makeSettings({ gapFiller: { enabled: true }, orgasmSource: 'pattern', edgeHoldAction: 'pattern' });
    const put = (f, c) => { for (const w of patternChoiceWrites(f, normalizePatternChoice(c), s.data.player)) s.set(w.key, w.value); };
    put('gapFiller', { id: 'quick-full-strokes', speed: 150, rangeMode: 'exact', min: 20, max: 80 });
    put('orgasm', { id: 'slow-tip-strokes', reversed: true, rangeMode: 'script', depthPct: 60 });
    put('edge', { id: null });
    await openPlayback(s);
    expect(ctl('gapFiller', 'summary').textContent).toBe(`${EN.patterns['quick-full-strokes'].name}, 150 units/s, 20 to 80`);
    expect(ctl('orgasm', 'summary').textContent).toMatch(new RegExp(`^${EN.patterns['slow-tip-strokes'].name}, \\d+ units/s, reversed, follows the script at 60%$`));
    expect(ctl('edge', 'summary').textContent).toBe('No pattern chosen yet');
    expect(summarizePatternChoice({ id: 'quick-full-strokes' })).toMatch(/, its own range$/);
  });

  it('the graph draws what the APPLIED choice plays (Gap Filler: its own output), is decorative, and is hidden with no pattern', async () => {
    const choice = normalizePatternChoice({ id: 'shape-square', speed: 200 });
    await openPlayback(seedAll(choice));
    for (const f of FEATURES) {
      const g = ctl(f, 'summary-graph');
      expect(g.getAttribute('aria-hidden')).toBe('true');
      expect(g.hidden).toBe(false);
      const want = renderPatternSample(choice, { durationMs: SUMMARY_GRAPH_MS, scriptRange: { min: 0, max: 100 }, feature: f }).actions;
      const curve = contexts.get(g).strokes.at(-1);
      expect(curve.path.length, f).toBe(want.length);
    }
    await closeSettings();
    await openPlayback(seedAll({ id: null }));
    for (const f of FEATURES) expect(ctl(f, 'summary-graph').hidden, f).toBe(true);
  });

  it('redraws on Apply, never from the draft or on Cancel', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes', speed: 150 }));
    for (const f of FEATURES) {
      const ctx = contexts.get(ctl(f, 'summary-graph'));
      const before = ctx.strokes.length;
      const curve = ctx.strokes.at(-1).path;
      await openDrawer(f);
      await change(ctl(f, 'speed'), 90);
      expect(ctx.strokes.length, `${f} draft`).toBe(before);
      await cancelDrawer(f);
      expect(ctx.strokes.length, `${f} cancel`).toBe(before);
      await openDrawer(f);
      await change(ctl(f, 'speed'), 90);
      await applyDrawer(f);
      expect(ctx.strokes.length, `${f} apply`).toBeGreaterThan(before);
      expect(ctx.strokes.at(-1).path, f).not.toEqual(curve);
      expect(ctl(f, 'summary').textContent).toMatch(/, 90 units\/s, /);
    }
  });
});

describe('the drawer works on a draft', () => {
  for (const f of FEATURES) {
    it(`${f}: nothing is written until Apply; Apply writes only ${f}'s keys, updates the summary and gives focus back`, async () => {
      const s = makeSettings({ ...V092(), orgasmSource: 'pattern' });
      const before = JSON.parse(JSON.stringify(s.data.player));
      const own = new Set(safePatternWrites(patternChoiceWrites(f, normalizePatternChoice({ id: 'quick-full-strokes' }), s.data.player), s.data.player).map((w) => w.key));
      const others = FEATURES.filter((g) => g !== f).flatMap((g) => safePatternWrites(patternChoiceWrites(g, normalizePatternChoice({ id: 'quick-full-strokes' }), s.data.player), s.data.player).map((w) => w.key));
      for (const k of own) expect(others, `${f} and another feature share ${k}`).not.toContain(k);
      await openPlayback(s);
      const summaryBefore = ctl(f, 'summary').textContent;

      await openDrawer(f);
      await change(ctl(f, 'quick'), listQuickPicks()[2].id);
      await change(ctl(f, 'family'), '');
      await change(ctl(f, 'id'), 'slow-tip-strokes');
      await change(ctl(f, 'speed'), 95);
      ctl(f, 'reverse').click();
      await flush();
      await change(ctl(f, 'range-mode'), 'exact');
      await change(ctl(f, 'max'), 80);
      await change(ctl(f, 'range-mode'), 'script');
      await change(ctl(f, 'depth'), 40);
      expect(s.writes).toEqual([]);                                  // the draft only
      expect(ctl(f, 'summary').textContent).toBe(summaryBefore);
      expect(callbacks.onGapFillerChanged).not.toHaveBeenCalled();
      expect(callbacks.onOrgasmPatternChanged).not.toHaveBeenCalled();

      await applyDrawer(f);
      expect(drawer(f)).toBeNull();
      expect(document.activeElement).toBe(ctl(f, 'set'));
      expect(s.writes.length).toBeGreaterThan(0);
      for (const w of s.writes) {
        expect(own.has(w.key), `${f} wrote ${w.key}`).toBe(true);
        expect(OLD_KEYS.map((k) => `player.${k}`)).not.toContain(w.key);
        expect(['player.gapFiller.presetId', 'player.gapFiller.custom']).not.toContain(w.key);
      }
      for (const k of OLD_KEYS) expect(s.data.player[k], k).toEqual(before[k]);
      expect(s.data.player.gapFiller.presetId).toBe(before.gapFiller.presetId);
      expect(s.data.player.gapFiller.custom).toEqual(before.gapFiller.custom);
      const now = readPatternChoice(f, s.data.player);
      expect(now).toMatchObject({ id: 'slow-tip-strokes', speed: 95, reversed: true, rangeMode: 'script', depthPct: 40 });
      expect(ctl(f, 'summary').textContent).toBe(summarizePatternChoice(now));
      for (const g of FEATURES.filter((x) => x !== f)) {
        expect(readPatternChoice(g, s.data.player), g).toEqual(readPatternChoice(g, before));
      }
      // Its callback: Gap Filler and X apply at once; Z reads at each press.
      if (f === 'gapFiller') expect(callbacks.onGapFillerChanged).toHaveBeenCalled();
      else expect(callbacks.onGapFillerChanged).not.toHaveBeenCalled();
      if (f === 'orgasm') expect(callbacks.onOrgasmPatternChanged).toHaveBeenCalled();
      else expect(callbacks.onOrgasmPatternChanged).not.toHaveBeenCalled();
    });
  }

  const discards = [
    ['Cancel', (f) => cancelDrawer(f)],
    ['the ✕', async (f) => { ctl(f, 'drawer-close').click(); await flush(); }],
    ['a click outside it (the dimmed Settings)', async (f) => { drawer(f).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await flush(); }],
    ['Escape', () => pressEscape()],
  ];
  for (const [how, discard] of discards) {
    it(`${how} discards the draft: nothing written, the summary as it was, focus back on "Set pattern…"; Settings stays open`, async () => {
      const s = seedAll({ id: 'quick-full-strokes', speed: 150 });
      await openPlayback(s);
      for (const f of FEATURES) {
        const summary = ctl(f, 'summary').textContent;
        await openDrawer(f);
        await change(ctl(f, 'speed'), 90);
        ctl(f, 'reverse').click();
        await flush();
        await discard(f);
        expect(drawer(f), `${f} closed`).toBeNull();
        expect(s.writes, f).toEqual([]);
        expect(ctl(f, 'summary').textContent).toBe(summary);
        expect(document.activeElement, f).toBe(ctl(f, 'set'));
        expect($('.modal-panel--settings'), f).not.toBeNull();      // Settings itself is still open
        // Opened again, the drawer shows what is saved, not the old draft.
        await openDrawer(f);
        expect(ctl(f, 'speed').value).toBe('150');
        expect(ctl(f, 'reverse').getAttribute('aria-checked')).toBe('false');
        await cancelDrawer(f);
      }
      expect(callbacks.onGapFillerChanged).not.toHaveBeenCalled();
      expect(callbacks.onOrgasmPatternChanged).not.toHaveBeenCalled();
    });
  }

  it('a second Escape, with no drawer open, closes Settings as before', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes' }));
    await openDrawer('edge');
    await pressEscape();
    expect(drawer('edge')).toBeNull();
    expect($('.modal-panel--settings')).not.toBeNull();
    await pressEscape();
    await showing;
    showing = null;
    expect($('.modal-panel--settings')).toBeNull();
  });
});

describe('no BPM in the three sections or the drawer ("Units/s only")', () => {
  const textOf = (roots) => {
    const parts = [];
    for (const root of roots) {
      if (!root) continue;
      parts.push(root.textContent);
      for (const n of root.querySelectorAll('*')) for (const a of n.attributes) parts.push(a.value);
    }
    return parts.join('\n');
  };

  it('a v0.9.2 config that stored BPM opens without a BPM word or control, in every locale', async () => {
    for (const l of PATTERN_BLOCK_LOCALES) {
      _setBundlesForTests(l, BUNDLES[l], BUNDLES.en);
      // What app.js's summary once said for a Generated pattern: never shown while X plays a pattern.
      await openPlayback(makeSettings(V092()), { orgasmSummary: 'Generated: Sawtooth, 150 BPM' });
      const sections = textOf([$('#sp-sec-gapskip'), $('#sp-sec-gapfiller'), $('#sp-sec-orgasm'), $('#sp-sec-edge')]);
      expect(sections, l).not.toMatch(/bpm/i);
      for (const f of FEATURES) {
        await openDrawer(f);
        expect(textOf([drawer(f)]), `${l} ${f}`).not.toMatch(/bpm/i);
        await cancelDrawer(f);
      }
      expect(document.querySelector('[id*="bpm" i]'), l).toBeNull();
      await closeSettings();
    }
    _setBundlesForTests('en', EN, EN);
  });

  it('Speed is units a second in all three', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes', speed: 150 }));
    for (const f of FEATURES) {
      expect(ctl(f, 'summary').textContent).toMatch(/, 150 units\/s, /);
      await openDrawer(f);
      expect(ctl(f, 'speed-val').textContent).toBe('150 units a second');
      await cancelDrawer(f);
    }
  });
});

describe('the summary row shows only while the feature\'s source is a pattern', () => {
  it('Gap Filler off / X on its script file / Z stopping the devices: no row; on / Pattern / Play a pattern: the row', async () => {
    const s = makeSettings({ gapFiller: { enabled: false }, orgasmSource: 'file', edgeHoldAction: 'stop' });
    await openPlayback(s);
    expect($('#sp-filler-pattern-rows').hidden).toBe(true);
    expect($('#sp-filler-threshold-row').hidden).toBe(true);
    expect($('#sp-orgasm-pattern-rows').hidden).toBe(true);
    expect($('#sp-orgasm-file-row').hidden).toBe(false);
    expect($('#sp-edge-pattern-rows').hidden).toBe(true);

    $('#sp-filler-enabled').click();
    await change($('#sp-orgasm-source'), 'pattern');
    await change($('#sp-edge-action'), 'pattern');
    expect($('#sp-filler-pattern-rows').hidden).toBe(false);
    expect($('#sp-filler-threshold-row').hidden).toBe(false);
    expect($('#sp-orgasm-pattern-rows').hidden).toBe(false);
    expect($('#sp-orgasm-file-row').hidden).toBe(true);
    expect($('#sp-orgasm-script-name').hidden).toBe(true);
    expect($('#sp-edge-pattern-rows').hidden).toBe(false);

    $('#sp-filler-enabled').click();
    await change($('#sp-orgasm-source'), 'file');
    await change($('#sp-edge-action'), 'stop');
    expect($('#sp-filler-pattern-rows').hidden).toBe(true);
    expect($('#sp-orgasm-pattern-rows').hidden).toBe(true);
    expect($('#sp-orgasm-file-row').hidden).toBe(false);
    expect($('#sp-orgasm-script-name').hidden).toBe(false);
    expect($('#sp-edge-pattern-rows').hidden).toBe(true);
  });

  it('with no pattern chosen, X and Z say what happens instead; an applied pattern takes the note away', async () => {
    await openPlayback(seedAll({ id: null }));
    expect($('#sp-orgasm-pattern-none').hidden).toBe(false);
    expect($('#sp-orgasm-pattern-none').textContent).toBe(EN.settingsPanel.playback.orgasmLibraryNone);
    expect($('#sp-edge-pattern-none').hidden).toBe(false);
    expect($('#sp-edge-pattern-none').textContent).toBe(EN.settingsPanel.playback.edgePatternNone);
    await openDrawer('edge');
    await change(ctl('edge', 'family'), '');
    await change(ctl('edge', 'id'), 'quick-full-strokes');
    expect($('#sp-edge-pattern-none').hidden).toBe(false);     // only a draft so far
    await applyDrawer('edge');
    expect($('#sp-edge-pattern-none').hidden).toBe(true);
  });
});

describe('the old keys and opening Settings', () => {
  it('opening Settings on a v0.9.2 config writes nothing, and each summary says what plays now', async () => {
    const s = makeSettings(V092());
    await openPlayback(s);
    expect(s.writes).toEqual([]);
    for (const f of FEATURES) {
      expect(ctl(f, 'summary').textContent, f).toBe(summarizePatternChoice(readPatternChoice(f, s.data.player)));
      await openDrawer(f);
      const want = readPatternChoice(f, s.data.player);
      if (want.id !== null) expect(ctl(f, 'id').value, f).toBe(want.id);
      expect(ctl(f, 'range-mode').value, f).toBe(want.rangeMode);
      await cancelDrawer(f);
    }
    expect(s.writes).toEqual([]);
  });

  it('Gap Filler\'s on / off and threshold write the whole object with presetId / custom exactly as read (and never add them)', async () => {
    for (const filler of [V092().gapFiller, { enabled: false }]) {
      const s = makeSettings({ gapFiller: filler, gapSkip: { mode: 'off', threshold: 15000 } });
      const read = JSON.parse(JSON.stringify(filler));
      await openPlayback(s);
      // Shown: the filler's own threshold, else Gap Skip's.
      expect($('#sp-filler-threshold').value).toBe(filler.thresholdMs ? '10' : '15');
      $('#sp-filler-enabled').click();
      await change($('#sp-filler-threshold'), 25);
      expect(s.writes.map((w) => w.key)).toEqual(['player.gapFiller', 'player.gapFiller']);
      const now = s.data.player.gapFiller;
      expect(now.enabled).toBe(!read.enabled);
      expect(now.thresholdMs).toBe(25000);
      expect('presetId' in now).toBe('presetId' in read);
      expect('custom' in now).toBe('custom' in read);
      if ('presetId' in read) expect(now.presetId).toBe(read.presetId);
      if ('custom' in read) expect(now.custom).toEqual(read.custom);
      expect(callbacks.onGapFillerChanged).toHaveBeenCalledTimes(2);
      $('#sp-filler-threshold-reset').click();
      await flush();
      expect(s.data.player.gapFiller.thresholdMs).toBe(10000);
      await closeSettings();
    }
  });

  it('X\'s source writes player.orgasmSource only and reloads the finisher; Z\'s writes player.edgeHoldAction only', async () => {
    const s = makeSettings(V092());
    const before = JSON.parse(JSON.stringify(s.data.player));
    await openPlayback(s);
    await change($('#sp-orgasm-source'), 'file');
    await change($('#sp-edge-action'), 'stop');
    expect(s.writes).toEqual([{ key: 'player.orgasmSource', value: 'file' }, { key: 'player.edgeHoldAction', value: 'stop' }]);
    expect(callbacks.onOrgasmPatternChanged).toHaveBeenCalledTimes(1);
    for (const k of OLD_KEYS) expect(s.data.player[k], k).toEqual(before[k]);
  });

  it('safePatternWrites drops an old key and puts presetId / custom back as read, present or absent', () => {
    const read = { gapFiller: { enabled: true, presetId: 'gentle', custom: { bpm: 30 } } };
    expect(safePatternWrites([
      { key: 'player.orgasmPattern', value: {} },
      { key: 'player.orgasmLibraryPattern', value: {} },
      { key: 'player.edgePattern', value: {} },
      { key: 'player.gapFiller.presetId', value: 'pulse' },
      { key: 'player.gapFiller.custom', value: null },
      { key: 'player.gapFiller', value: { enabled: true, presetId: 'pulse', pattern: { id: 'x' } } },
      { key: 'player.someNewChoice', value: { id: 'y' } },
    ], read)).toEqual([
      { key: 'player.gapFiller', value: { enabled: true, presetId: 'gentle', custom: { bpm: 30 }, pattern: { id: 'x' } } },
      { key: 'player.someNewChoice', value: { id: 'y' } },
    ]);
    expect(safePatternWrites([{ key: 'player.gapFiller', value: { presetId: 'slowTease', custom: {}, pattern: 1 } }], { gapFiller: {} }))
      .toEqual([{ key: 'player.gapFiller', value: { pattern: 1 } }]);
    expect(safePatternWrites(null, {})).toEqual([]);
  });
});

describe('Test plays the DRAFT through app.js\'s path', () => {
  it('the draft\'s own sample, before anything is applied; closing the drawer stops it for real', async () => {
    const app = makeApp();
    const s = seedAll({ id: 'quick-full-strokes', speed: 150 });
    await openPlayback(s, { app });
    for (const [f, close] of [['orgasm', cancelDrawer], ['edge', applyDrawer], ['gapFiller', pressEscape]]) {
      await openDrawer(f);
      await change(ctl(f, 'speed'), 90);
      ctl(f, 'test').click();
      expect(ctl(f, 'test').textContent).toBe('Stop');
      const draft = normalizePatternChoice({ id: 'quick-full-strokes', speed: 90 });
      expect(tested.at(-1)).toEqual(renderPatternSample(draft, { ...SAMPLE, feature: f }).actions);
      const stops = app.buttplugSync.stops;
      await close(f);
      expect(app.buttplugSync.stops, f).toBeGreaterThan(stops);
    }
    expect(s.writes.map((w) => w.key).every((k) => !k.includes('gapFiller') && !k.includes('orgasm'))).toBe(true);
  });

  it('closing Settings with a drawer open stops the test and writes nothing', async () => {
    const app = makeApp();
    const s = seedAll({ id: 'quick-full-strokes' });
    await openPlayback(s, { app });
    await openDrawer('orgasm');
    await change(ctl('orgasm', 'speed'), 90);
    ctl('orgasm', 'test').click();
    const stops = app.buttplugSync.stops;
    await closeSettings();
    expect(app.buttplugSync.stops).toBeGreaterThan(stops);
    expect(s.writes).toEqual([]);
  });

  it('never while a video drives the devices: it says so, nothing is sent; nothing connected says that', async () => {
    const app = makeApp();
    app.buttplugSync.driving = true;
    await openPlayback(seedAll({ id: 'quick-full-strokes' }), { app });
    await openDrawer('gapFiller');
    ctl('gapFiller', 'test').click();
    expect(app.buttplugSync.sent).toEqual([]);
    expect(ctl('gapFiller', 'test').textContent).toBe('Test');
    expect($('#toast-container').textContent).toContain(EN.toast.fillerTestBusy);
    app.buttplugSync.driving = false;
    app.buttplugManager.connected = false;
    ctl('gapFiller', 'test').click();
    expect($('#toast-container').textContent).toContain(EN.toast.fillerTestNoDevices);
    expect(app.buttplugSync.sent).toEqual([]);
  });
});

describe('each preview is what that feature plays', () => {
  it('Gap Filler\'s is the filler\'s own output for a gap (square ramped by its slew limiter); X\'s and Z\'s are their loop', async () => {
    const choice = normalizePatternChoice({ id: 'shape-square', speed: 200 });
    await openPlayback(seedAll(choice));
    const statsFor = (feature) => {
      const { actions } = renderPatternSample(choice, { ...SAMPLE, feature });
      const st = patternStats(actions);
      // pf-fixup (PF-R2): square's instant jumps in X / Z are said to be instant, not given a speed.
      if (st.instant > 0 && !(st.peak > 0)) return 'Instant jumps, as fast as the device can move';
      return `Average ${st.avg} units/s, peak ${st.peak} units/s`;
    };
    for (const f of FEATURES) {
      await openDrawer(f);
      expect(ctl(f, 'stats').textContent, f).toBe(statsFor(f));
      await cancelDrawer(f);
    }
    // The filler never plays square's instant edges; X and Z do.
    expect(statsFor('gapFiller')).not.toBe(statsFor('orgasm'));
  });
});

describe('endings and the too-narrow note, alike in all three', () => {
  it('the endings are marked in every picker; Gap Filler explains them for a gap, X and Z for a held key', async () => {
    await openPlayback(seedAll({ id: ENDINGS[0] }));
    const hints = {};
    for (const f of FEATURES) {
      await openDrawer(f);
      expect(ctl(f, 'once').hidden, f).toBe(false);
      hints[f] = ctl(f, 'once').textContent;
      await change(ctl(f, 'family'), '');   // "All groups": every ending is listed
      for (const e of ENDINGS) {
        expect(ctl(f, 'id').querySelector(`option[value="${e}"]`)?.textContent, `${f} ${e}`).toBe(`${EN.patterns[e].name} (plays once, then holds)`);
      }
      await cancelDrawer(f);
    }
    expect(hints.gapFiller).toBe(EN.settingsPanel.patternBlock.oneShotHintGap);
    expect(hints.orgasm).toBe(EN.patterns.ui.oneShotHint);
    expect(hints.edge).toBe(EN.patterns.ui.oneShotHint);
  });

  it('a range too narrow for the pattern says it plays wider, in each, in the locale in use', async () => {
    _setBundlesForTests('de', BUNDLES.de, EN);
    await openPlayback(seedAll(NARROW));
    const notes = [];
    for (const f of FEATURES) {
      await openDrawer(f);
      const n = ctl(f, 'range-widened');
      expect(n.hidden, f).toBe(false);
      expect(n.textContent).toMatch(/^Dieser Bereich ist für das Muster zu schmal, daher läuft es etwas breiter: \d+ bis \d+\.$/);
      notes.push(n.textContent);
      await cancelDrawer(f);
    }
    expect(new Set(notes).size).toBe(1);
  });
});

describe('keyboard and screen readers', () => {
  it('focus moves into the drawer on open, Tab stays inside it, and the rest of Settings is out of reach', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes' }));
    for (const f of FEATURES) {
      await openDrawer(f);
      const d = drawer(f);
      expect(d.contains(document.activeElement), f).toBe(true);
      expect(document.activeElement).toBe(ctl(f, 'quick'));
      // Everything else in the dialog is inert while it is open.
      const panel = $('.modal-panel--settings');
      for (const child of panel.children) if (child !== d) expect(child.hasAttribute('inert'), child.className).toBe(true);
      const apply = ctl(f, 'drawer-apply');
      apply.focus();
      apply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(ctl(f, 'drawer-close'));
      ctl(f, 'drawer-close').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(apply);
      await cancelDrawer(f);
      for (const child of panel.children) expect(child.hasAttribute('inert'), child.className).toBe(false);
    }
  });

  it('every control has a name; the drawer is a labelled dialog; the button says whose pattern it sets', async () => {
    await openPlayback(seedAll({ id: 'quick-full-strokes', rangeMode: 'script', depthPct: 60 }));
    for (const f of FEATURES) {
      const name = EN.settingsPanel.playback[HEADER[f]];
      expect(ctl(f, 'set').getAttribute('aria-label')).toBe(`Set the ${name} pattern`);
      expect(ctl(f, 'set').getAttribute('aria-describedby')).toBe(`${PREFIX[f]}-summary`);
      expect(ctl(f, 'set').textContent).toBe('Set pattern…');
      await openDrawer(f);
      const sheet = drawer(f).querySelector('.pattern-drawer__sheet');
      expect([sheet.getAttribute('role'), sheet.getAttribute('aria-modal')]).toEqual(['dialog', 'true']);
      expect(document.getElementById(sheet.getAttribute('aria-labelledby')).textContent).toBe(`${name} pattern`);
      expect(ctl(f, 'drawer-close').getAttribute('aria-label')).toBe(`Close ${name} pattern`);
      const root = block(f);
      expect(root.getAttribute('role')).toBe('group');
      expect(root.getAttribute('aria-label')).toBe(`${name}: pattern`);
      for (const c of drawer(f).querySelectorAll('input, select, button')) {
        const label = c.id ? document.querySelector(`label[for="${c.id}"]`) : null;
        const accessible = c.getAttribute('aria-label') || label?.textContent || c.textContent;
        expect((accessible || '').trim(), `${f} ${c.id}`).not.toBe('');
        expect(c.getAttribute('tabindex'), `${f} ${c.id}`).toBeNull();
      }
      for (const r of ['speed', 'depth', 'centre']) {
        expect(ctl(f, r).getAttribute('aria-valuetext'), `${f} ${r}`).toBe(ctl(f, `${r}-val`).textContent);
      }
      expect(ctl(f, 'speed').getAttribute('aria-valuetext')).toMatch(/units a second$/);
      expect(ctl(f, 'preview').getAttribute('aria-label')).toBe(EN.settingsPanel.patternBlock.previewAria);
      expect(document.getElementById(ctl(f, 'preview').getAttribute('aria-describedby')).textContent).toMatch(/^Average \d+ units\/s, peak \d+ units\/s$/);
      expect(document.getElementById(ctl(f, 'test').getAttribute('aria-describedby')).textContent).toBe(EN.settingsPanel.patternBlock.testHint);
      expect(ctl(f, 'reverse').getAttribute('role')).toBe('switch');
      await cancelDrawer(f);
    }
    expect($('#sp-filler-threshold-reset').getAttribute('aria-label')).toBe(EN.settingsPanel.playback.fillerResetThresholdAria);
  });
});

describe('German, light / dark, 800 x 600 at 150 %', () => {
  it('German: the summary rows, the drawers and the "when" rows speak German', async () => {
    _setBundlesForTests('de', BUNDLES.de, EN);
    await openPlayback(seedAll({ id: 'quick-full-strokes' }));
    const de = BUNDLES.de;
    const want = [
      de.settingsPanel.patternBlock.quickPicks, de.patterns.ui.family, de.patterns.ui.pattern,
      de.settingsPanel.patternBlock.preview, de.patterns.ui.speed, de.patterns.ui.reverse, de.patterns.ui.range,
      de.patterns.ui.rangeMin, de.patterns.ui.rangeMax, de.settingsPanel.playback.fillerDepth, de.settingsPanel.patternBlock.centre, '',
    ];
    for (const f of FEATURES) {
      expect(ctl(f, 'set').textContent).toBe('Muster festlegen…');
      expect(ctl(f, 'summary').textContent).toMatch(/Einheiten\/s, eigener Bereich$/);
      await openDrawer(f);
      expect(drawerSignature(f).rows.map((r) => r.label), f).toEqual(want);
      expect(ctl(f, 'drawer-title').textContent).toBe(`Muster für ${de.settingsPanel.playback[HEADER[f]]}`);
      expect([ctl(f, 'drawer-cancel').textContent, ctl(f, 'drawer-apply').textContent]).toEqual([de.common.cancel, 'Übernehmen']);
      expect(ctl(f, 'speed-val').textContent).toMatch(/Einheiten pro Sekunde$/);
      await cancelDrawer(f);
    }
    expect($('#sp-filler-threshold-row label').textContent).toBe('Lücken füllen ab');
    expect($('#sp-orgasm-source option[value="pattern"]').textContent).toBe('Muster');
  });

  it('light and dark: the block\'s, the summary\'s and the drawer\'s CSS use the semantic tokens only, each defined for both themes', () => {
    const start = MODAL_CSS.indexOf('.pattern-block__preview {');
    const end = MODAL_CSS.indexOf('\n.settings-panel__input--range {\n', start);
    const css = MODAL_CSS.slice(start, end);
    expect(css).toContain('.pattern-drawer__sheet');
    expect(css).toContain('.pattern-summary__graph');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const tokens = [...new Set([...css.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))];
    expect(tokens.length).toBeGreaterThan(5);
    const darkAt = /:root,\s*:root\[data-theme="dark"\]\s*\{/.exec(PLAYER_CSS).index;
    const dark = PLAYER_CSS.slice(darkAt, PLAYER_CSS.indexOf('}', darkAt));
    const light = PLAYER_CSS.slice(/:root\[data-theme="light"\]\s*\{/.exec(PLAYER_CSS).index);
    for (const tk of tokens) {
      expect(dark, `${tk} dark`).toContain(`${tk}:`);
      expect(light.slice(0, light.indexOf('}')), `${tk} light`).toContain(`${tk}:`);
    }
  });

  it('800 x 600 at 150 %: the drawer lives inside the dialog (never past the window), its body scrolls between a fixed title and Apply, and the rows wrap', () => {
    const rule = (sel) => {
      const at = MODAL_CSS.indexOf(`${sel} {`);
      return MODAL_CSS.slice(at, MODAL_CSS.indexOf('}', at));
    };
    expect(MODAL_CSS).toMatch(/\.modal-panel--settings\s*\{\s*position: relative;\s*\}/);
    expect(rule('.pattern-drawer')).toMatch(/position: absolute;\s*inset: 0;/);
    expect(rule('.pattern-drawer__sheet')).toMatch(/width: min\(560px, 100%\);\s*height: 100%;\s*min-height: 0;/);
    expect(rule('.pattern-drawer__head')).toMatch(/flex: none;/);
    expect(rule('.pattern-drawer__foot')).toMatch(/flex: none;/);
    expect(rule('.pattern-drawer__body')).toMatch(/flex: 1 1 auto;\s*min-height: 0;\s*overflow-y: auto;/);
    expect(rule('.pattern-drawer__close')).toMatch(/width: 36px;\s*height: 36px;/);
    const media = MODAL_CSS.slice(MODAL_CSS.indexOf('@media (max-width: 900px)', MODAL_CSS.indexOf('.pattern-block__preview {')));
    const wrap = media.slice(0, media.indexOf('\n}\n'));
    expect(wrap).toMatch(/\.pattern-block \.settings-panel__field\s*\{\s*flex-wrap: wrap;/);
    expect(wrap).toMatch(/\.pattern-block \.settings-panel__input--range\s*\{\s*min-width: 120px;/);
    expect(MODAL_CSS).toMatch(/\.settings-panel__field > \.settings-panel__input--select\s*\{\s*min-width: 0;\s*max-width: 100%;/);
  });
});

// ---------- pf-fixup (2026-11-19): Dave's answers and the verify / review minors ----------
describe('pf-fixup: the drawer in all three', () => {
  it('a click outside: the press itself moves no focus (pf-verify: it ended on BODY), focus is back on "Set pattern…"', async () => {
    const s = seedAll({ id: 'quick-full-strokes', speed: 150 });
    await openPlayback(s);
    for (const f of FEATURES) {
      await openDrawer(f);
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      drawer(f).dispatchEvent(press);
      await flush();
      expect(drawer(f), f).toBeNull();
      // jsdom has no default focus action: the browser's is what preventDefault stops.
      expect(press.defaultPrevented, f).toBe(true);
      expect(document.activeElement, f).toBe(ctl(f, 'set'));
      // a press inside the sheet is the user's own: not cancelled, not stopped
      await openDrawer(f);
      const inside = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      ctl(f, 'quick').dispatchEvent(inside);
      expect(inside.defaultPrevented, f).toBe(false);
      expect(drawer(f), f).not.toBeNull();
      await cancelDrawer(f);
    }
    expect(s.writes).toEqual([]);
  });

  it('Changing the Group only filters the list (Dave ~15:05): the pattern stays shown and plays; Apply after it writes nothing', async () => {
    const s = seedAll({ id: 'quick-full-strokes', speed: 150 });
    await openPlayback(s);
    for (const f of FEATURES) {
      const summary = ctl(f, 'summary').textContent;
      await openDrawer(f);
      const stats = ctl(f, 'stats').textContent;
      await change(ctl(f, 'family'), 'simple-shapes');
      expect(ctl(f, 'id').value, f).toBe('quick-full-strokes');
      const ids = [...ctl(f, 'id').options].map((o) => o.value);
      expect(ids, f).toEqual(['', 'quick-full-strokes', ...listPatterns({ family: 'simple-shapes' }).map((p) => p.id)]);
      expect(ctl(f, 'stats').textContent, f).toBe(stats);   // the same pattern still previews
      expect(ctl(f, 'test').disabled, f).toBe(false);
      await applyDrawer(f);
      expect(s.writes, f).toEqual([]);
      expect(ctl(f, 'summary').textContent, f).toBe(summary);
      // picking one from the group is the change
      await openDrawer(f);
      await change(ctl(f, 'family'), 'simple-shapes');
      await change(ctl(f, 'id'), 'shape-triangle');
      await applyDrawer(f);
      expect(readPatternChoice(f, s.data.player).id, f).toBe('shape-triangle');
      s.writes.length = 0;
    }
  });

  it('Apply with nothing changed writes nothing (PF-R6), nor a change undone before Apply', async () => {
    const s = makeSettings({ ...V092(), orgasmSource: 'pattern' });
    await openPlayback(s);
    for (const f of FEATURES) {
      await openDrawer(f);
      await applyDrawer(f);
      await openDrawer(f);
      ctl(f, 'reverse').click();
      await flush();
      ctl(f, 'reverse').click();
      await flush();
      await applyDrawer(f);
    }
    expect(s.writes).toEqual([]);
    expect(callbacks.onGapFillerChanged).not.toHaveBeenCalled();
    expect(callbacks.onOrgasmPatternChanged).not.toHaveBeenCalled();
  });

  it('the summary is one line: cut with an ellipsis where it does not fit, the whole line in its title, kept up to date by Apply', async () => {
    const rule = (sel) => {
      const at = MODAL_CSS.indexOf(`${sel} {`);
      return MODAL_CSS.slice(at, MODAL_CSS.indexOf('}', at));
    };
    const css = rule('.pattern-summary__text');
    expect(css).toMatch(/white-space: nowrap;/);
    expect(css).toMatch(/overflow: hidden;/);
    expect(css).toMatch(/text-overflow: ellipsis;/);
    expect(css).toMatch(/min-width: 0;/);
    expect(css).not.toMatch(/overflow-wrap/);
    for (const l of ['de', 'en']) {
      _setBundlesForTests(l, BUNDLES[l], BUNDLES.en);
      const s = makeSettings({ ...V092(), orgasmSource: 'pattern' });
      await openPlayback(s);
      for (const f of FEATURES) {
        const text = ctl(f, 'summary');
        expect(text.textContent.length, `${l} ${f}`).toBeGreaterThan(10);
        expect(text.title, `${l} ${f}`).toBe(text.textContent);
        await openDrawer(f);
        await change(ctl(f, 'speed'), 77);
        await applyDrawer(f);
        expect(text.title, `${l} ${f}`).toBe(text.textContent);
        expect(text.textContent, `${l} ${f}`).toContain('77');
      }
      await closeSettings();
    }
    _setBundlesForTests('en', EN, EN);
  });

  it('an upgraded speed outside the slider is the speed the drawer says (PF-R5): X at 1000, Gap Filler at 3', async () => {
    const s = makeSettings({
      gapFiller: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'sine', bpm: 10, depthPct: 10, absolute: null } },
      orgasmPattern: { enabled: true, type: 'triangle', bpm: 300, min: 0, max: 100 },
    });
    await openPlayback(s);
    for (const [f, speed] of [['orgasm', 1000], ['gapFiller', 3]]) {
      expect(ctl(f, 'summary').textContent, f).toContain(`${speed} units/s`);
      await openDrawer(f);
      expect(ctl(f, 'speed-val').textContent, f).toBe(`${speed} units a second`);
      expect(ctl(f, 'speed').getAttribute('aria-valuetext'), f).toBe(`${speed} units a second`);
      await applyDrawer(f);                                        // untouched: nothing written, the speed kept
    }
    expect(s.writes).toEqual([]);
  });
});
