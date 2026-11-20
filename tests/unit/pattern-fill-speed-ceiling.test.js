/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL drawer (renderer/components/pattern-fill-drawer.js)
 * builds its sliders on the DOM and the test moves them with input events.
 * The Worker module is loaded with a stand-in `self` (no Worker in jsdom).
 */
// Fill with pattern: the 600 u/s speed ceiling (Dave, 2026-11-17: "600 is
// what i would deem as reasonable"; it stays the hard ceiling everywhere,
// the Fill drawer included). Before, the drawer passed no maxSpeed: its
// Speed slider reached a pattern's own top (946 u/s on "buzz-uneven-long-
// strokes") and the fill core's cap then rose to 1.5x the asked speed, so
// legs of about 1,140-1,419 u/s could land in a script
// (notes/features/device-speed-limits-2026-11-17.md, finding 1).
//
//   - every pattern, the drawer's OWN fill call (Speed and Ramp pushed to the
//     sliders' tops): maxSpeed 600 goes to the core and no leg of the result,
//     the joins to the anchors included, is faster than 600 u/s; between two
//     anchors and on a marked time range alike;
//   - the Speed and Ramp sliders stop at min(the pattern's own top, 600);
//   - the preview Worker holds the ceiling whatever it is sent;
//   - the pop-out's fill is refused by the parent when a leg passes it;
//   - the engine's speed-capped warning is shown in plain words;
//   - one shared constant: PATTERN_SPEED_CEILING = DEFAULT_MAX_SPEED = 600,
//     and the Orgasm / Edge loop sliders (pattern-source.js) stay under it.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/pattern-fill.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fillRange: vi.fn(real.fillRange) };
});

const { fillRange } = await import('../../renderer/js/pattern-fill.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { PatternFillDrawer } = await import('../../renderer/components/pattern-fill-drawer.js');
const {
  listPatterns, describePattern, PATTERN_SPEED_CEILING, DEFAULT_MAX_SPEED,
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

describe('one shared ceiling', () => {
  it('PATTERN_SPEED_CEILING is 600 and equals the engine default the Orgasm / Edge loops pass', () => {
    expect(PATTERN_SPEED_CEILING).toBe(600);
    expect(DEFAULT_MAX_SPEED).toBe(PATTERN_SPEED_CEILING);
  });

  it('the Orgasm / Edge loop slider (pattern-source.js) tops out under it for every pattern', () => {
    for (const { id } of listPatterns()) expect(patternSpeedBounds(id).max).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
  });
});

describe('the drawer\'s own fill never writes a leg over 600 u/s', () => {
  const ids = listPatterns().map((p) => p.id);

  /** Every pattern with Speed and Ramp at the sliders' tops: the legs of the stretch as it would land. */
  function sweep({ actions, selected, range }) {
    const { drawer, container } = makeDrawer({ actions, selected, range });
    drawer.open();
    runFrame();
    let worst = { v: 0, id: null };
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
      const call = fillRange.mock.calls[0][0];
      expect(call.patternId).toBe(id);
      asked.push(call.options);
      const { res, win } = drawer.preview;
      if (!res.inserted.length) continue;
      fills++;
      // The stretch as it lands: the anchors (or the edges' line points) and the fill.
      const stretch = res.actions.filter((a) => a.at >= win.startMs - 2000 && a.at <= win.endMs + 2000);
      for (const v of legSpeeds(stretch)) if (v > worst.v) worst = { v, id };
    }
    drawer.destroy();
    return { worst, fills, asked };
  }

  it('between two anchors (every pattern, Speed and Ramp at their tops)', () => {
    const { worst, fills, asked } = sweep({ actions: zigzag(25), selected: [2, 20] });
    expect(fills).toBeGreaterThan(70);
    expect(worst).toEqual({ v: expect.any(Number), id: expect.any(String) });
    expect(worst.v).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
    // What the core was asked: the ceiling, and no speed above it.
    for (const o of asked) {
      expect(o.maxSpeed).toBe(PATTERN_SPEED_CEILING);
      expect(o.speed).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
      expect(o.ramp.to).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
    }
  }, 60000);

  it('on a marked time range (every pattern, joined on the script\'s line)', () => {
    const actions = [{ at: 0, pos: 20 }, { at: 30000, pos: 80 }];
    const { worst, fills, asked } = sweep({ actions, range: { startMs: 4000, endMs: 12000 } });
    expect(fills).toBeGreaterThan(70);
    expect(worst.v).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
    for (const o of asked) expect(o.maxSpeed).toBe(PATTERN_SPEED_CEILING);
  }, 60000);
});

describe('the sliders stop at min(the pattern\'s own top, 600)', () => {
  it('Speed and Ramp, for every pattern', () => {
    const { drawer, container } = makeDrawer({ actions: zigzag(25), selected: [2, 20] });
    drawer.open();
    let capped = 0;
    for (const { id } of listPatterns()) {
      pick(container, id);
      const d = describePattern(id);
      const top = Math.max(Math.ceil(d.speedRange[1]), Math.round(d.speed));
      const want = Math.min(PATTERN_SPEED_CEILING, top);
      expect(Number(speedInput(container).max)).toBe(want);
      expect(Number(rampInput(container).max)).toBe(want);
      expect(Number(speedInput(container).min)).toBeLessThan(want);
      if (top > PATTERN_SPEED_CEILING) capped++;
    }
    // buzz-uneven-long-strokes (946), buzz-long-strokes (683), buzz-short-tip-strokes (626), buzz-uneven-short-base-strokes (603)
    expect(capped).toBeGreaterThanOrEqual(4);
    drawer.destroy();
  });

  it('the slider at its top asks the core for 600, not the pattern\'s 946', () => {
    const { drawer, container } = makeDrawer({ actions: zigzag(25), selected: [2, 20] });
    drawer.open();
    pick(container, 'buzz-uneven-long-strokes');
    slide(speedInput(container), 946);
    fillRange.mockClear();
    runFrame();
    expect(fillRange.mock.calls[0][0].options.speed).toBe(PATTERN_SPEED_CEILING);
    drawer.destroy();
  });
});

describe('the speed-capped warning, in plain words', () => {
  it('a fill whose legs were held to the ceiling says so with 600', () => {
    const { drawer, container } = makeDrawer({ actions: zigzag(25), selected: [2, 20] });
    drawer.open();
    let shown = null;
    for (const { id } of listPatterns()) {
      pick(container, id);
      slide(speedInput(container), speedInput(container).max);
      runFrame();
      if (drawer.preview?.res?.warnings?.some((w) => w.code === 'speed-capped')) { shown = id; break; }
    }
    expect(shown).not.toBeNull();
    const items = [...container.querySelectorAll('.fill-drawer__warnings li')].map((li) => li.textContent);
    expect(items).toContain(t('editor.patternFill.speedCapped', { max: 600 }));
    expect(t('editor.patternFill.speedCapped', { max: 600 })).toBe('Some moves were held to 600 units/s, the top speed for a pattern.');
    drawer.destroy();
  });
});

describe('the preview Worker holds the ceiling whatever it is sent', () => {
  let post;
  beforeAll(async () => {
    post = vi.fn();
    globalThis.self = { postMessage: post };
    await import('../../renderer/js/pattern-fill-worker.js');
  });
  afterEach(() => post.mockClear());

  for (const options of [{ speed: 946 }, { speed: 946, maxSpeed: 2000 }, { speed: 946, maxSpeed: null }]) {
    it(`options ${JSON.stringify(options)}: no leg over 600 u/s`, () => {
      const actions = zigzag(25);
      globalThis.self.onmessage({ data: { id: 1, actions, selection: { startMs: 1000, endMs: 10000 }, patternId: 'buzz-uneven-long-strokes', options } });
      const { res } = post.mock.calls[0][0];
      expect(res.inserted.length).toBeGreaterThan(10);
      expect(Math.max(...legSpeeds(res.actions))).toBeLessThanOrEqual(PATTERN_SPEED_CEILING);
      expect(res.stats.cap).toBe(PATTERN_SPEED_CEILING);
    });
  }

  it('a lower maxSpeed asked is kept (the ceiling only ever lowers it)', () => {
    globalThis.self.onmessage({ data: { id: 2, actions: zigzag(25), selection: { startMs: 1000, endMs: 10000 }, patternId: 'quick-full-strokes', options: { maxSpeed: 150 } } });
    expect(post.mock.calls[0][0].res.stats.cap).toBe(150);
  });
});

describe('the pop-out\'s fill: the parent refuses a leg over the ceiling (validFillRange)', () => {
  const base = { t0: 1000, t1: 5000, mode: 'replace', sig: '9:abc' };
  it('a leg of exactly 600 u/s passes; 610 is refused whole', () => {
    expect(validFillRange({ ...base, points: [{ at: 1200, pos: 0 }, { at: 1300, pos: 60 }] })).not.toBeNull();
    expect(validFillRange({ ...base, points: [{ at: 1200, pos: 0 }, { at: 1300, pos: 61 }] })).toBeNull();
  });
  it('the same on a range fill', () => {
    const r = { ...base, range: true };
    expect(validFillRange({ ...r, points: [{ at: 1000, pos: 0 }, { at: 1100, pos: 60 }] })).not.toBeNull();
    expect(validFillRange({ ...r, points: [{ at: 1000, pos: 0 }, { at: 1100, pos: 100 }] })).toBeNull();
  });
});
