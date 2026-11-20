/**
 * @vitest-environment jsdom
 * jsdom on purpose: the block builds DOM, i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments"), and the preview draws on a canvas.
 */
// The shared Pattern block (pattern-source-rows.js createPatternBlock), the
// component on its own: Gap Filler, Orgasm Switch (X) and Edge Hold (Z) mount
// this one block (Dave, 2026-11-19, DESIGN-pattern-settings-unify.md §1).
// What is asserted is what the user gets: the rows and their order, what each
// control commits, the preview drawn from the SAME sample the Test button
// plays, the "Average N units/s, peak N units/s" line, the too-narrow note,
// and Test / Stop. pattern-choice.js is the REAL module once pf-engine has
// filled it in, a fake built on the real library engine until then
// (helpers/pattern-choice-fake.js); expectations go through the module.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/pattern-choice.js', async (importOriginal) => {
  const { contractOrFake } = await import('./helpers/pattern-choice-fake.js');
  return contractOrFake(await importOriginal());
});

import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { createPatternBlock } from '../../renderer/components/pattern-source-rows.js';
import {
  listQuickPicks, renderPatternSample, patternStats, normalizePatternChoice, quickPickIdFor,
} from '../../renderer/js/pattern-choice.js';
import { listPatterns, describePattern } from '../../renderer/js/pattern-library.js';
import { patternSpeedBounds } from '../../renderer/js/pattern-source.js';
import { PREVIEW_WINDOW_MS, PREVIEW_SCRIPT_RANGE } from '../../renderer/js/filler-preview.js';
import { withPatternBlockStrings } from './helpers/pattern-block-strings.js';

const EN = withPatternBlockStrings(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')), 'en');
const ENDINGS = listPatterns({ loopable: false }).map((p) => p.id);
// Mixed flutters at the tip in a 5-unit band: the engine widens it.
const NARROW = { id: 'mixed-flutters-tip', speed: 172, rangeMode: 'exact', min: 20, max: 25 };

/** A recording 2D context: every path the preview draws, with its colour. */
function recordingContext() {
  const ctx = {
    strokes: [],
    _path: [],
    setTransform() {}, clearRect() {}, save() {}, restore() {}, closePath() {}, fill() {},
    beginPath() { this._path = []; },
    moveTo(x, y) { this._path.push(['M', x, y]); },
    lineTo(x, y) { this._path.push(['L', x, y]); },
    stroke() { this.strokes.push({ style: this.strokeStyle, path: this._path.slice() }); },
  };
  return ctx;
}
let contexts;
beforeEach(() => {
  contexts = new Map();
  HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!contexts.has(this)) contexts.set(this, recordingContext());
    return contexts.get(this);
  };
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
});
afterAll(() => _setBundlesForTests('en', EN, EN));

const sampleOf = (choice) => renderPatternSample(choice, { durationMs: PREVIEW_WINDOW_MS, scriptRange: PREVIEW_SCRIPT_RANGE });
const change = (node, value) => {
  if (value !== undefined) node.value = String(value);
  node.dispatchEvent(new Event('change', { bubbles: true }));
};
const input = (node, value) => {
  node.value = String(value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
};

function mount(over = {}) {
  const onChange = vi.fn();
  const block = createPatternBlock({ idPrefix: 'pb', feature: 'edge', onChange, label: 'Edge Hold: pattern', ...over });
  document.body.appendChild(block.element);
  const $ = (s) => block.element.querySelector(`#pb-${s}`);
  const row = (name) => block.element.querySelector(`[data-row="${name}"]`);
  return { block, onChange, $, row, last: () => onChange.mock.calls.at(-1)?.[0] };
}

describe('the rows, in the design\'s order', () => {
  it('Quick picks, Group, Pattern, Preview, Speed, Reverse, Range (Exact: Lowest / Highest; Follow the script: Depth / Centre), Test', () => {
    const { block } = mount({ value: { id: 'quick-full-strokes' } });
    const rows = [...block.element.querySelectorAll('[data-row]')];
    expect(rows.map((r) => r.dataset.row)).toEqual([
      'quick', 'family', 'pattern', 'preview', 'speed', 'reverse', 'range', 'min', 'max', 'depth', 'centre', 'test',
    ]);
    expect(rows.map((r) => r.querySelector('.settings-panel__field-label').textContent)).toEqual([
      'Quick picks', 'Group', 'Pattern', 'Preview', 'Speed', 'Reverse', 'Range', 'Lowest', 'Highest', 'Depth', 'Centre', '',
    ]);
    // Every row is the panel's own row style.
    for (const r of rows) expect(r.classList.contains('settings-panel__field')).toBe(true);
    expect(block.element.getAttribute('role')).toBe('group');
    expect(block.element.getAttribute('aria-label')).toBe('Edge Hold: pattern');
  });

  it('offers the quick picks (then "Custom"), the three range choices, and units a second only', () => {
    const { $ } = mount({ value: { id: 'quick-full-strokes' } });
    const picks = listQuickPicks();
    expect(picks.length).toBeGreaterThan(0);
    expect([...$('quick').options].map((o) => o.value)).toEqual(['', ...picks.map((p) => p.id), 'custom']);
    expect([...$('quick').options].slice(1).map((o) => o.textContent)).toEqual([...picks.map((p) => t(p.labelKey)), 'Custom']);
    // "Custom" and "Choose…" are states, not something to pick.
    expect($('quick').querySelector('option[value="custom"]').disabled).toBe(true);
    expect($('quick').querySelector('option[value=""]').disabled).toBe(true);
    expect([...$('range-mode').options].map((o) => [o.value, o.textContent])).toEqual([
      ['own', "Pattern's own"], ['exact', 'Exact'], ['script', 'Follow the script'],
    ]);
    expect($('speed-val').textContent).toMatch(/^\d+ units a second$/);
    expect($('speed').getAttribute('aria-valuetext')).toBe($('speed-val').textContent);
  });

  it('no pattern chosen: "Choose…" / "Choose a pattern…", and the rows that shape and play one wait', () => {
    const { $, row, onChange } = mount({ value: null });
    expect($('quick').value).toBe('');
    expect($('quick').selectedOptions[0].textContent).toBe('Choose…');
    expect($('id').value).toBe('');
    expect($('id').selectedOptions[0].textContent).toBe('Choose a pattern…');
    for (const r of ['quick', 'family', 'pattern']) expect(row(r).hidden, r).toBe(false);
    for (const r of ['preview', 'speed', 'reverse', 'range', 'test']) expect(row(r).hidden, r).toBe(true);
    expect($('range-exact').hidden).toBe(true);
    expect($('range-script').hidden).toBe(true);
    expect($('stats').hidden).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('quick picks', () => {
  it('a quick pick sets pattern, speed and range together; changing anything by hand shows "Custom"', () => {
    const { $, last, onChange } = mount({ value: null });
    const pick = listQuickPicks()[1];
    change($('quick'), pick.id);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(last()).toEqual(normalizePatternChoice(pick.choice));
    expect($('quick').value).toBe(pick.id);
    expect($('id').value).toBe(pick.choice.id);
    expect($('range-mode').value).toBe(normalizePatternChoice(pick.choice).rangeMode);

    const b = patternSpeedBounds(pick.choice.id);
    const other = Number($('speed').value) === b.min ? b.min + 1 : b.min;
    change($('speed'), other);
    expect(last().speed).toBe(other);
    expect(quickPickIdFor(last())).toBe('custom');
    expect($('quick').value).toBe('custom');
    expect($('quick').selectedOptions[0].textContent).toBe('Custom');
  });
});

describe('Group and Pattern', () => {
  it('the endings are offered, marked "plays once, then holds", and explained in the feature\'s own words', () => {
    const { $ } = mount({ value: null, oneShotHint: 'An ending: (the feature says what holding does)' });
    for (const e of ENDINGS) {
      expect($('id').querySelector(`option[value="${e}"]`).textContent).toBe(`${EN.patterns[e].name} (plays once, then holds)`);
    }
    change($('id'), ENDINGS[0]);
    expect($('once').hidden).toBe(false);
    expect($('once').textContent).toBe('An ending: (the feature says what holding does)');
    change($('id'), 'quick-full-strokes');
    expect($('once').hidden).toBe(true);
    expect($('desc').textContent).toBe(EN.patterns['quick-full-strokes'].desc);
  });

  it('a chosen ending opens on its own group, which lists all its endings', () => {
    const { $ } = mount({ value: { id: 'sprint-finish' } });
    expect($('family').value).toBe(describePattern('sprint-finish').family);
    expect([...$('id').options].map((o) => o.value)).toEqual(['', ...listPatterns({ family: describePattern('sprint-finish').family }).map((p) => p.id)]);
    expect($('id').value).toBe('sprint-finish');
  });

  it('the Simple shapes are a group of their own, in the same picker', () => {
    const { $ } = mount({ value: null });
    expect([...$('family').options].map((o) => o.value)).toContain('simple-shapes');
    change($('family'), 'simple-shapes');
    expect([...$('id').options].map((o) => o.value)).toEqual(['', ...listPatterns({ family: 'simple-shapes' }).map((p) => p.id)]);
  });

  it('the Group only filters the list: the chosen pattern stays (and stays shown) until another is picked (Dave 2026-11-19 ~15:05)', () => {
    const { $, last } = mount({ value: { id: 'slow-tip-strokes', speed: 90 } });
    change($('family'), describePattern('slow-tip-strokes').family);
    expect($('id').value).toBe('slow-tip-strokes');
    const otherFamily = [...$('family').options].map((o) => o.value).find((f) => f && f !== describePattern('slow-tip-strokes').family);
    change($('family'), otherFamily);
    expect(last()).toBeUndefined();                    // nothing committed (was: the choice cleared)
    expect($('id').value).toBe('slow-tip-strokes');
    expect([...$('id').options].map((o) => o.value))
      .toEqual(['', 'slow-tip-strokes', ...listPatterns({ family: otherFamily }).map((p) => p.id)]);
    const pick = listPatterns({ family: otherFamily })[0].id;
    change($('id'), pick);
    expect(last().id).toBe(pick);
    expect([...$('id').options].map((o) => o.value)).toEqual(['', ...listPatterns({ family: otherFamily }).map((p) => p.id)]);
  });

  it('a new pattern starts at its own speed and, from an exact range, its own place; "Follow the script" stays', () => {
    const { $, last } = mount({ value: { id: 'slow-tip-strokes', speed: 90, rangeMode: 'exact', min: 30, max: 60 } });
    change($('family'), '');                     // "All groups": every pattern is listed
    expect(last()).toBeUndefined();              // browsing commits nothing
    change($('id'), 'quick-full-strokes');
    expect(last()).toMatchObject({ id: 'quick-full-strokes', speed: null, rangeMode: 'own', min: null, max: null });
    change($('range-mode'), 'script');
    change($('depth'), 60);
    change($('id'), 'slow-tip-strokes');
    expect(last()).toMatchObject({ id: 'slow-tip-strokes', speed: null, rangeMode: 'script', depthPct: 60 });
  });
});

describe('Speed, Reverse, Range', () => {
  it('Speed shows units a second, saves on release, and ↻ goes back to the pattern\'s own and keeps focus', () => {
    const { $, last } = mount({ value: { id: 'quick-full-strokes' } });
    const b = patternSpeedBounds('quick-full-strokes');
    expect([$('speed').min, $('speed').max, $('speed').value]).toEqual([String(b.min), String(b.max), String(b.own)]);
    expect($('speed-reset').hidden).toBe(true);
    input($('speed'), 150);
    expect($('speed-val').textContent).toBe('150 units a second');
    change($('speed'));
    expect(last().speed).toBe(150);
    expect($('speed-reset').hidden).toBe(false);
    $('speed-reset').click();
    expect(last().speed).toBeNull();
    expect(document.activeElement).toBe($('speed'));
  });

  it('Reverse saves', () => {
    const { $, last } = mount({ value: { id: 'quick-full-strokes' } });
    $('reverse').click();
    expect(last().reversed).toBe(true);
    expect($('reverse').getAttribute('aria-checked')).toBe('true');
  });

  it('Exact starts at the pattern\'s own place (mirrored when reversed), and Lowest never passes Highest', () => {
    const { $, last } = mount({ value: { id: 'slow-tip-strokes', reversed: true } });
    change($('range-mode'), 'exact');
    const [ownLo, ownHi] = describePattern('slow-tip-strokes').range.map(Math.round);
    expect(last()).toMatchObject({ rangeMode: 'exact', min: 100 - ownHi, max: 100 - ownLo });
    expect($('range-exact').hidden).toBe(false);
    expect($('range-script').hidden).toBe(true);
    input($('min'), 99);
    expect($('min').value).toBe(String(100 - ownLo));
    input($('min'), 10);
    change($('min'));
    expect(last()).toMatchObject({ min: 10, max: 100 - ownLo });
    expect([$('min-val').textContent, $('max-val').textContent]).toEqual(['10', String(100 - ownLo)]);
  });

  it('Follow the script: Depth % and Centre (the script\'s own until moved; ↻ back to it, focus kept)', () => {
    const { $, last } = mount({ value: { id: 'quick-full-strokes' } });
    change($('range-mode'), 'script');
    expect(last()).toMatchObject({ rangeMode: 'script', depthPct: 100, centrePct: null });
    expect($('range-script').hidden).toBe(false);
    expect($('depth-val').textContent).toBe('100%');
    expect($('centre-val').textContent).toBe("Script's own");
    expect($('centre-reset').hidden).toBe(true);
    expect($('range-script-hint').textContent).toBe(EN.settingsPanel.patternBlock.rangeScriptHint);
    change($('depth'), 60);
    expect(last().depthPct).toBe(60);
    input($('centre'), 30);
    expect($('centre-val').textContent).toBe('30');
    change($('centre'));
    expect(last().centrePct).toBe(30);
    $('centre-reset').click();
    expect(last().centrePct).toBeNull();
    expect($('centre-val').textContent).toBe("Script's own");
    expect(document.activeElement).toBe($('centre'));
    // Back to the pattern's own: the other modes' values are kept for next time.
    change($('range-mode'), 'own');
    expect(last()).toMatchObject({ rangeMode: 'own', depthPct: 60 });
  });
});

describe('the preview is what plays', () => {
  it('draws the rendered sample and says "Average N units/s, peak N units/s" from it', () => {
    const { block, $ } = mount({ value: { id: 'quick-full-strokes', speed: 150 } });
    const want = sampleOf({ ...normalizePatternChoice({ id: 'quick-full-strokes', speed: 150 }) });
    expect(want.actions.length).toBeGreaterThan(2);
    expect(block.getSample().actions).toEqual(want.actions);
    const s = patternStats(want.actions);
    expect($('stats').hidden).toBe(false);
    expect($('stats').textContent).toBe(`Average ${s.avg} units/s, peak ${s.peak} units/s`);
    expect($('preview').getAttribute('role')).toBe('img');
    expect($('preview').getAttribute('aria-describedby')).toBe('pb-stats');
    const ctx = contexts.get($('preview'));
    const curve = ctx.strokes.at(-1);
    expect(curve.path.length).toBe(want.actions.length);   // one point per action
  });

  it('a change draws the new sample', () => {
    const { block, $ } = mount({ value: { id: 'quick-full-strokes' } });
    const before = block.getSample().actions;
    change($('speed'), patternSpeedBounds('quick-full-strokes').min);
    expect(block.getSample().actions).not.toEqual(before);
    expect(block.getSample().actions).toEqual(sampleOf(normalizePatternChoice({ id: 'quick-full-strokes', speed: patternSpeedBounds('quick-full-strokes').min })).actions);
  });
});

describe('too narrow, plays wider', () => {
  it('names the band it plays; the pattern\'s own range has no note', () => {
    const { $ } = mount({ value: NARROW });
    const w = sampleOf(normalizePatternChoice(NARROW)).warnings.find((x) => x === 'range-widened' || x?.code === 'range-widened');
    expect(w).toBeTruthy();
    expect($('range-widened').hidden).toBe(false);
    expect($('range-widened').textContent).toMatch(/^This range is too narrow for the pattern, so it plays a little wider: \d+ to \d+\.$/);
    const [, lo, hi] = /: (\d+) to (\d+)\./.exec($('range-widened').textContent).map(Number);
    expect(hi - lo).toBeGreaterThan(5);
    change($('range-mode'), 'own');
    expect($('range-widened').hidden).toBe(true);
  });

  it('no note when nothing was widened: a normal range, or no pattern chosen', () => {
    const { $ } = mount({ value: { id: 'quick-full-strokes', rangeMode: 'exact', min: 10, max: 90 } });
    expect($('range-widened').hidden).toBe(true);
    expect($('range-widened').textContent).toBe('');
    document.body.innerHTML = '';
    const none = mount({ value: null });
    expect(none.$('range-widened').hidden).toBe(true);
  });
});

describe('Test / Stop', () => {
  function fakeSession(status = 'started') {
    const s = {
      activeOwner: null,
      hooks: null,
      start: vi.fn((owner, actions, hooks) => {
        if (status === 'started') { s.activeOwner = owner; s.hooks = hooks; }
        return status;
      }),
      stop: vi.fn(() => { const h = s.hooks; s.activeOwner = null; s.hooks = null; h?.onEnd?.(); }),
    };
    return s;
  }

  it('plays the preview\'s own actions, moves the playhead, and Stop stops it', () => {
    const testSession = fakeSession();
    const { block, $ } = mount({ value: { id: 'quick-full-strokes' }, testSession });
    $('test').click();
    expect(testSession.start).toHaveBeenCalledWith('edge', block.getSample().actions, expect.any(Object));
    expect($('test').textContent).toBe('Stop');
    testSession.hooks.onProgress(0.5);
    const ctx = contexts.get($('preview'));
    const head = ctx.strokes.at(-1);
    expect(head.style).not.toBe(ctx.strokes.at(-2).style);   // the playhead is not the curve's colour
    $('test').click();
    expect(testSession.stop).toHaveBeenCalledWith('edge');
    expect($('test').textContent).toBe('Test');
  });

  it('refused (a video is playing, or nothing is connected): says why, stays on Test', () => {
    for (const status of ['busy', 'no-devices']) {
      document.body.innerHTML = '';
      const onTestRefused = vi.fn();
      const { $ } = mount({ value: { id: 'quick-full-strokes' }, testSession: fakeSession(status), onTestRefused });
      $('test').click();
      expect(onTestRefused).toHaveBeenCalledWith(status);
      expect($('test').textContent).toBe('Test');
    }
  });

  it('described for a screen reader, and destroy() stops its own test', () => {
    const testSession = fakeSession();
    const { block, $ } = mount({ value: { id: 'quick-full-strokes' }, testSession });
    expect($('test').getAttribute('aria-describedby')).toBe('pb-test-hint');
    expect($('test-hint').textContent).toBe('Plays the preview on your connected devices');
    $('test').click();
    block.destroy();
    expect(testSession.stop).toHaveBeenCalledWith('edge');
  });
});

// ---------- pf-fixup (2026-11-19) ----------
describe('the Speed row of an upgraded choice says the speed that plays (PF-R5)', () => {
  it("outside the slider (1000 / 3.33 u/s): the real speed until the slider is moved, then the slider's", () => {
    for (const [speed, shown] of [[1000, '1000'], [3.3333333333333335, '3']]) {
      const { $, last } = mount({ value: { id: 'shape-triangle', speed, rangeMode: 'exact', min: 0, max: 100 } });
      expect($('speed-val').textContent).toBe(`${shown} units a second`);
      expect($('speed').getAttribute('aria-valuetext')).toBe(`${shown} units a second`);
      input($('speed'), 250);
      expect($('speed-val').textContent).toBe('250 units a second');
      expect(last()).toBeUndefined();                    // the drag commits nothing yet
      change($('speed'));
      expect(last().speed).toBe(250);
      document.body.innerHTML = '';
    }
  });

  it('inside the slider: as before', () => {
    const { $ } = mount({ value: { id: 'quick-full-strokes', speed: 150 } });
    expect($('speed-val').textContent).toBe('150 units a second');
    expect($('speed').value).toBe('150');
  });
});

describe('an upgraded Generated pattern keeps its own rate in the drawer until it is changed (PF-R2, pf-engine decision 3)', () => {
  const fastest = (acts) => acts.reduce((m, a, i) => (i && a.at > acts[i - 1].at
    ? Math.max(m, (Math.abs(a.pos - acts[i - 1].pos) / (a.at - acts[i - 1].at)) * 1000) : m), 0);
  it('previews its own legs (over 600 u/s); the first change by hand makes it a new choice under the ceiling', () => {
    const legacy = { id: 'shape-sine', speed: 500, rangeMode: 'exact', min: 0, max: 100, legacyRate: true };
    const { block, $, last } = mount({ value: legacy, feature: 'orgasm' });
    expect(block.getValue().legacyRate).toBe(true);
    expect(fastest(block.getSample().actions)).toBeGreaterThan(600);
    $('reverse').click();
    expect(last()).not.toHaveProperty('legacyRate');
    expect(fastest(block.getSample().actions)).toBeLessThanOrEqual(600);
  });
});
