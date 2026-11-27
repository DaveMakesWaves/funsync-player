/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL drawer (renderer/components/pattern-fill-drawer.js)
 * builds its sliders on the DOM and the test moves them with input events.
 * The Worker module is loaded with a stand-in `self` (no Worker in jsdom).
 */
// Fill with pattern and speed (rewritten 2026-11-24). From 2026-11-17 the
// editor's fill was held to 600 u/s (PATTERN_SPEED_CEILING) everywhere; Dave
// then: "there shouldnt really be a limit, i think some scripts on the forum
// go up to like 2000 even though it wont work its down to the scripters ...
// sometimes going over the limit is a trick people use for unusual
// movements", and "yes lift the fill cap too". So:
//   - the drawer asks the core for NO cap (maxSpeed FILL_NO_CAP, 5000 u/s: Dave, "infinite can be 5000"), and its legs
//     may pass 600 u/s;
//   - the Speed and Ramp sliders reach FILL_SLIDER_MAX (5000) on every pattern;
//   - the preview Worker keeps what it is asked (none = none);
//   - the parent no longer refuses a pop-out fill for its speed;
//   - the live patterns keep the ceiling: PATTERN_SPEED_CEILING = 600 is still
//     the engine default the Orgasm / Edge loops pass, and their slider stays under it.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange) };
});

const { fillRange, FILL_NO_CAP } = await import('../../renderer/js/pattern-fill.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { PatternFillDrawer, FILL_SLIDER_MAX } = await import('../../renderer/components/pattern-fill-drawer.js');
const {
  listPatterns, PATTERN_SPEED_CEILING, DEFAULT_MAX_SPEED,
} = await import('../../renderer/js/pattern-library.js');
const { patternSpeedBounds } = await import('../../renderer/js/pattern-source.js');
const { validFillRange } = await import('../../renderer/js/editor-popout-dispatch.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

const zigzag = (n, step = 500) => Array.from({ length: n }, (_, i) => ({ at: i * step, pos: i % 2 ? 90 : 10 }));
const legSpeeds = (pts) => {
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push((Math.abs(pts[i].pos - pts[i - 1].pos) * 1000) / (pts[i].at - pts[i - 1].at));
  return out;
};
const slide = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };

let frames = [];
const runFrame = () => { const f = frames; frames = []; f.forEach((cb) => cb(performance.now())); };

/** The REAL drawer on a stand-in host: the actions, the selection and a marked range are the test's. */
function makeDrawer({ actions, selected = [], range = null }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const graph = { setGhost: vi.fn(), clearGhost: vi.fn(), draw() {} };
  const host = { actions, selected: new Set(selected), range };
  const drawer = new PatternFillDrawer({
    container,
    graph,
    placement: 'side',
    getActions: () => host.actions,
    getSelectedIndices: () => host.selected,
    getFillRange: () => host.range,
    onApply: () => true,
    raf: (cb) => { frames.push(cb); return frames.length; },
    caf: () => {},
    createWorker: null,
  });
  return { drawer, container, host };
}
const q = (c, sel) => c.querySelector(sel);
const speedInput = (c) => q(c, '.fill-drawer__row--speed input[type="range"]');
const rampInput = (c) => q(c, '.fill-drawer__row--ramp input[type="range"]');
const rampCheck = (c) => q(c, '.fill-drawer__row--ramp input[type="checkbox"]');
const pick = (c, id) => q(c, `[role="option"][data-id="${id}"]`).click();

beforeAll(() => {
  _setBundlesForTests('en', EN, EN);
});
beforeEach(() => {
  frames = [];
  fillRange.mockClear();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('the live patterns keep the ceiling', () => {
  it('PATTERN_SPEED_CEILING is 600 and equals the engine default the Orgasm / Edge loops pass', () => {
    expect(PATTERN_SPEED_CEILING).toBe(600);
    expect(DEFAULT_MAX_SPEED).toBe(PATTERN_SPEED_CEILING);
  });

  it('the Orgasm / Edge loop slider (pattern-source.js) tops out under it for every pattern', () => {
    for (const { id } of listPatterns()) expect(patternSpeedBounds(id).max).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
  });
});

describe('the editor fill has no speed ceiling', () => {
  const ids = listPatterns().map((p) => p.id);

  /** Every pattern with Speed and Ramp at the sliders' tops: the fastest leg, and what the core was asked. */
  function sweep({ actions, selected, range }) {
    const { drawer, container } = makeDrawer({ actions, selected, range });
    drawer.open();
    runFrame();
    let fastest = 0;
    let fills = 0;
    const asked = [];
    for (const id of ids) {
      pick(container, id);
      slide(speedInput(container), speedInput(container).max);
      rampCheck(container).click();
      slide(rampInput(container), rampInput(container).max);
      fillRange.mockClear();
      runFrame();
      expect(fillRange).toHaveBeenCalledTimes(1);
      asked.push(fillRange.mock.calls[0][0].options);
      const { res } = drawer.preview;
      if (!res.inserted.length) continue;
      fills++;
      fastest = Math.max(fastest, ...legSpeeds(res.inserted));
    }
    drawer.destroy();
    return { fastest, fills, asked };
  }

  it('between two anchors: no cap asked, the sliders\' tops asked as they are, legs past 600 u/s land', () => {
    const { fastest, fills, asked } = sweep({ actions: zigzag(25), selected: [2, 20] });
    expect(fills).toBeGreaterThan(70);
    expect(fastest).toBeGreaterThan(PATTERN_SPEED_CEILING);
    for (const o of asked) {
      expect(o.maxSpeed).toBe(FILL_NO_CAP);
      expect(o.speed).toBe(FILL_SLIDER_MAX);
      expect(o.ramp.to).toBe(FILL_SLIDER_MAX);
    }
  }, 60000);

  it('on a marked time range too', () => {
    const actions = [{ at: 0, pos: 20 }, { at: 30000, pos: 80 }];
    const { fills, asked } = sweep({ actions, range: { startMs: 4000, endMs: 12000 } });
    expect(fills).toBeGreaterThan(70);
    for (const o of asked) expect(o.maxSpeed).toBe(FILL_NO_CAP);
  }, 60000);

  it('the Speed and Ramp sliders reach FILL_SLIDER_MAX (5000) on every pattern', () => {
    expect(FILL_SLIDER_MAX).toBe(5000);
    expect(FILL_NO_CAP).toBe(5000);
    const { drawer, container } = makeDrawer({ actions: zigzag(25), selected: [2, 20] });
    drawer.open();
    for (const { id } of listPatterns()) {
      pick(container, id);
      expect(Number(speedInput(container).max)).toBe(FILL_SLIDER_MAX);
      expect(Number(rampInput(container).max)).toBe(FILL_SLIDER_MAX);
    }
    drawer.destroy();
  });

  it('a speed past 600 is asked as it is (946 stays 946)', () => {
    const { drawer, container } = makeDrawer({ actions: zigzag(25), selected: [2, 20] });
    drawer.open();
    pick(container, 'buzz-uneven-long-strokes');
    slide(speedInput(container), 946);
    fillRange.mockClear();
    runFrame();
    expect(fillRange.mock.calls[0][0].options.speed).toBe(946);
    drawer.destroy();
  });

  it('nothing is held to 600 any more: a "held to" warning at the sliders\' tops names 5000', () => {
    const { drawer, container } = makeDrawer({ actions: zigzag(25), selected: [2, 20] });
    drawer.open();
    const named = new Set();
    for (const { id } of listPatterns()) {
      pick(container, id);
      slide(speedInput(container), speedInput(container).max);
      runFrame();
      for (const w of drawer.preview?.res?.warnings || []) if (w.code === 'speed-capped') named.add(w.values?.maxSpeed);
    }
    for (const v of named) expect(v).toBe(FILL_NO_CAP);
    drawer.destroy();
    // Every pattern at 5000 u/s with 17 ms legs: ~1 s alone, it passed 5 s in
    // the full parallel run (2026-11-24); the sweeps above have 60 s too.
  }, 60000);
});

describe('the preview Worker keeps what it is asked', () => {
  let post;
  beforeAll(async () => {
    post = vi.fn();
    globalThis.self = { postMessage: post };
    await import('../../renderer/js/pattern-fill-worker.js');
  });
  afterEach(() => post.mockClear());

  it('no cap asked: none (legs past 600 u/s)', () => {
    globalThis.self.onmessage({ data: { id: 1, actions: zigzag(25), selection: { startMs: 1000, endMs: 10000 }, patternId: 'buzz-uneven-long-strokes', options: { speed: 946 } } });
    const { res } = post.mock.calls[0][0];
    expect(res.inserted.length).toBeGreaterThan(10);
    expect(Math.max(...legSpeeds(res.inserted))).toBeGreaterThan(PATTERN_SPEED_CEILING);
  });

  it('a cap asked is kept, a high one or a low one', () => {
    globalThis.self.onmessage({ data: { id: 2, actions: zigzag(25), selection: { startMs: 1000, endMs: 10000 }, patternId: 'quick-full-strokes', options: { maxSpeed: 2000 } } });
    expect(post.mock.calls[0][0].res.stats.cap).toBe(2000);
    globalThis.self.onmessage({ data: { id: 3, actions: zigzag(25), selection: { startMs: 1000, endMs: 10000 }, patternId: 'quick-full-strokes', options: { maxSpeed: 150 } } });
    expect(post.mock.calls[1][0].res.stats.cap).toBe(150);
  });
});

describe('the pop-out\'s fill is not refused for its speed (validFillRange)', () => {
  const base = { t0: 1000, t1: 5000, mode: 'replace', sig: '9:abc' };
  it('legs of 610 and 1000 u/s pass, between anchors and on a range', () => {
    expect(validFillRange({ ...base, points: [{ at: 1200, pos: 0 }, { at: 1300, pos: 61 }] })).not.toBeNull();
    expect(validFillRange({ ...base, range: true, points: [{ at: 1000, pos: 0 }, { at: 1100, pos: 100 }] })).not.toBeNull();
  });
});
