/**
 * @vitest-environment node
 * No DOM: the pure modifiers, EditableScript and the pop-out dispatch only.
 * See notes/CLAUDE.md "Test environments".
 */
// Editor work list (notes/features/PLAN-editor-work-2026-11.md), 2026-11-24:
// Fade in / Fade out (4.4) and Ripple delete (4.3), docked and from the pop-out.
import { describe, it, expect, vi } from 'vitest';
import { fadeIn, fadeOut, fadeDepth } from '../../renderer/js/script-modifiers.js';
import { EditableScript } from '../../renderer/js/editable-script.js';
import { applyPopoutEdit } from '../../renderer/js/editor-popout-dispatch.js';
import { EDIT_OP, OP_RIPPLE_DELETE, OP_APPLY_MODIFIER } from '../../renderer/js/editor-popout-protocol.js';

const zigzag = [
  { at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }, { at: 3000, pos: 100 }, { at: 4000, pos: 0 },
];
const script = (actions) => {
  const es = new EditableScript();
  es._actions = actions.map((a) => ({ ...a }));
  return es;
};

describe('Fade in / Fade out (4.4)', () => {
  it('fade in: the depth grows from nothing at the start to full at the end, times kept', () => {
    expect(fadeIn(zigzag)).toEqual([
      { at: 0, pos: 50 }, { at: 1000, pos: 63 }, { at: 2000, pos: 25 }, { at: 3000, pos: 88 }, { at: 4000, pos: 0 },
    ]);
  });

  it('fade out: full at the start, nothing at the end', () => {
    expect(fadeOut(zigzag)).toEqual([
      { at: 0, pos: 0 }, { at: 1000, pos: 88 }, { at: 2000, pos: 25 }, { at: 3000, pos: 63 }, { at: 4000, pos: 50 },
    ]);
  });

  it('fades around the stretch\'s own centre line (a stroke between 20 and 60 fades to 40)', () => {
    const out = fadeOut([{ at: 0, pos: 20 }, { at: 1000, pos: 60 }, { at: 2000, pos: 20 }]);
    expect(out[2].pos).toBe(40);
    expect(out[0].pos).toBe(20);
  });

  it('one point, or no time span, comes back unchanged; the input is never changed', () => {
    expect(fadeDepth([{ at: 5, pos: 70 }], 'in')).toEqual([{ at: 5, pos: 70 }]);
    expect(fadeDepth([{ at: 5, pos: 70 }, { at: 5, pos: 10 }], 'in')).toEqual([{ at: 5, pos: 70 }, { at: 5, pos: 10 }]);
    const input = zigzag.map((a) => ({ ...a }));
    fadeIn(input);
    expect(input).toEqual(zigzag);
  });

  it('on a selection only, as one undo step', () => {
    const es = script(zigzag);
    es._selectedIndices = new Set([2, 3, 4]);
    expect(es.applyModifier(fadeOut).changed).toBe(true);
    expect(es.actions.map((a) => a.pos)).toEqual([0, 100, 0, 75, 50]);
    es.undo();
    expect(es.actions.map((a) => a.pos)).toEqual([0, 100, 0, 100, 0]);
  });
});

describe('Ripple delete (4.3)', () => {
  const six = [0, 1000, 2000, 3000, 4000, 5000].map((at, i) => ({ at, pos: i % 2 ? 100 : 0 }));

  it('cuts the selected run out and moves everything after it earlier by its span', () => {
    const es = script(six);
    es._selectedIndices = new Set([2, 3]);                 // 2000 and 3000
    expect(es.rippleDeleteSelected()).toEqual({ changed: true, refused: false, count: 2, shiftMs: 1000 });
    expect(es.actions).toEqual([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 3000, pos: 0 }, { at: 4000, pos: 100 }]);
    expect(es.selectedIndices.size).toBe(0);
    es.undo();
    expect(es.actions).toEqual(six);
  });

  it('a gap in the selection is refused (a point inside would land after the moved ones); nothing changes', () => {
    const es = script(six);
    es._selectedIndices = new Set([1, 3]);
    expect(es.rippleDeleteSelected()).toMatchObject({ changed: false, refused: true });
    expect(es.actions).toEqual(six);
    expect(es.canUndo).toBe(false);
  });

  it('nothing selected: nothing changes', () => {
    const es = script(six);
    expect(es.rippleDeleteSelected()).toMatchObject({ changed: false, refused: false, count: 0 });
    expect(es.actions).toEqual(six);
  });

  it('one point: deleted, nothing moves', () => {
    const es = script(six);
    es._selectedIndices = new Set([5]);
    expect(es.rippleDeleteSelected()).toMatchObject({ changed: true, shiftMs: 0 });
    expect(es.actions.map((a) => a.at)).toEqual([0, 1000, 2000, 3000, 4000]);
  });
});

describe('from the pop-out', () => {
  it('Shift+Del / Modify > Ripple delete asks the parent\'s host (its toast goes to the pop-out)', () => {
    const host = { rippleDelete: vi.fn(), reportModifierResult: vi.fn() };
    applyPopoutEdit(script(zigzag), { type: EDIT_OP, op: OP_RIPPLE_DELETE }, host);
    expect(host.rippleDelete).toHaveBeenCalledTimes(1);
  });

  it('Fade in / Fade out run on the parent\'s script', () => {
    const es = script(zigzag);
    const host = { reportModifierResult: vi.fn() };
    applyPopoutEdit(es, { type: EDIT_OP, op: OP_APPLY_MODIFIER, name: 'fadeIn' }, host);
    expect(es.actions[0].pos).toBe(50);
    expect(host.reportModifierResult).toHaveBeenCalledWith(expect.objectContaining({ changed: true }), 'fadeIn');
    applyPopoutEdit(es, { type: EDIT_OP, op: OP_APPLY_MODIFIER, name: 'fadeOut' }, host);
    expect(host.reportModifierResult).toHaveBeenLastCalledWith(expect.objectContaining({ changed: true }), 'fadeOut');
  });
});

describe('selection statistics (4.1)', async () => {
  const { selectionStats, selectionStatsText } = await import('../../renderer/js/selection-stats.js');
  const acts = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 100 }, { at: 1250, pos: 0 }, { at: 3000, pos: 50 }];

  it('span, average and top speed of the strokes inside the selection (holds skipped)', () => {
    expect(selectionStats(acts, new Set([0, 1, 2, 3]))).toEqual({ count: 4, spanMs: 1250, avgSpeed: 300, maxSpeed: 400, strokes: 2 });
  });

  it('only neighbours in the script are strokes: every other point gives the span only', () => {
    expect(selectionStats(acts, new Set([0, 2, 4]))).toMatchObject({ spanMs: 3000, strokes: 0, avgSpeed: 0 });
    const t = (key, v) => `${key}:${JSON.stringify(v)}`;
    expect(selectionStatsText(acts, new Set([0, 2, 4]), t)).toBe('editor.statusSpan:{"seconds":"3.00"}');
    expect(selectionStatsText(acts, new Set([0, 1]), t)).toBe('editor.statusStats:{"seconds":"0.50","avg":200,"top":200}');
  });

  it('fewer than two selected: nothing', () => {
    expect(selectionStats(acts, new Set([1]))).toBeNull();
    expect(selectionStatsText(acts, new Set(), () => 'x')).toBe('');
  });
});

describe('Make from the stroke (2.4)', async () => {
  const { axisFromStroke, quarterCycleMs } = await import('../../renderer/js/script-modifiers.js');
  const stroke = [{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }, { at: 1200, pos: 100 }];

  it('as is with no options; shifted, scaled around a centre, upside down', () => {
    expect(axisFromStroke(stroke)).toEqual(stroke);
    expect(axisFromStroke(stroke, { shiftMs: 200 }).map((a) => a.at)).toEqual([200, 600, 1000, 1400]);
    expect(axisFromStroke(stroke, { scalePct: 50 }).map((a) => a.pos)).toEqual([25, 75, 25, 75]);
    expect(axisFromStroke(stroke, { scalePct: 40, centre: 70 }).map((a) => a.pos)).toEqual([50, 90, 50, 90]);
    expect(axisFromStroke(stroke, { invert: true }).map((a) => a.pos)).toEqual([100, 0, 100, 0]);
  });

  it('points shifted before 0 go; positions stay whole and inside 0-100', () => {
    expect(axisFromStroke(stroke, { shiftMs: -500 }).map((a) => a.at)).toEqual([300, 700]);
    expect(axisFromStroke(stroke, { scalePct: 200 }).map((a) => a.pos)).toEqual([0, 100, 0, 100]);
    expect(axisFromStroke([{ at: 0, pos: 33 }], { scalePct: 33 })[0].pos).toBe(44);
  });

  it('a quarter of the cycle: half the typical time between points', () => {
    expect(quarterCycleMs(stroke)).toBe(200);
    expect(quarterCycleMs([{ at: 0, pos: 0 }])).toBe(0);
  });
});

describe('Fill tempo (4.7)', async () => {
  const { speedForBpm, bpmFromBeats } = await import('../../renderer/js/fill-tempo.js');
  it('one stroke per beat over the depth, inside the slider; out-of-range BPM refused', () => {
    expect(speedForBpm(120, 100)).toBe(200);
    expect(speedForBpm(120, 50)).toBe(100);
    expect(speedForBpm(300, 100, { max: 400 })).toBe(400);
    expect(speedForBpm(10, 100)).toBeNull();
    expect(speedForBpm('x', 100)).toBeNull();
  });
  it('the median gap of the beats inside the stretch; fewer than three beats: none', () => {
    expect(bpmFromBeats([0, 500, 1000, 1500, 2600, 3100], 0, 3100)).toBe(120);
    expect(bpmFromBeats([0, 500, 1000, 1500], 900, 1600)).toBeNull();
    expect(bpmFromBeats(null, 0, 1)).toBeNull();
  });
});

describe('Vibrate between points (Dave, 2026-11-24)', async () => {
  const { vibrateBetween, vibrateSpacingMs } = await import('../../renderer/js/script-modifiers.js');
  const two = [{ at: 0, pos: 20 }, { at: 1000, pos: 80 }];

  it('fills the gap with moves around the line, both ends kept, whole numbers, inside 0-100', () => {
    const out = vibrateBetween(two, { size: 20, rate: 10, taper: false });
    expect(out[0]).toEqual(two[0]);
    expect(out[out.length - 1]).toEqual(two[1]);
    expect(out.length).toBe(11);                                   // 9 added at 100 ms
    for (const p of out) { expect(Number.isInteger(p.at) && Number.isInteger(p.pos)).toBe(true); expect(p.pos).toBeGreaterThanOrEqual(0); expect(p.pos).toBeLessThanOrEqual(100); }
    const mid = out[5];                                            // 500 ms: the line is at 50
    expect(Math.abs(mid.pos - 50)).toBe(10);
    expect(Math.sign(out[1].pos - 26)).toBe(-Math.sign(out[2].pos - 32));   // alternates around the line
  });

  it('the size slider makes the moves larger or smaller', () => {
    const swing = (size) => { const o = vibrateBetween(two, { size, rate: 10, taper: false }); return Math.abs(o[5].pos - 50) * 2; };
    expect(swing(10)).toBe(10);
    expect(swing(40)).toBe(40);
  });

  it('taper: no swing at the ends, full in the middle', () => {
    const o = vibrateBetween(two, { size: 40, rate: 10, taper: true });
    const line = (p) => 20 + 60 * (p.at / 1000);
    expect(Math.abs(o[1].pos - line(o[1]))).toBeLessThan(Math.abs(o[5].pos - line(o[5])));
  });

  it('the speed cap spaces the moves out so none is faster than the max', () => {
    expect(vibrateSpacingMs(40, 20, 400)).toBe(100);               // 50 ms asked, 100 needed for 40 units at 400/s
    const o = vibrateBetween(two, { size: 40, rate: 20, taper: false, maxSpeed: 400 });
    for (let i = 2; i < o.length - 1; i++) expect(Math.abs(o[i].pos - o[i - 1].pos) / (o[i].at - o[i - 1].at) * 1000).toBeLessThanOrEqual(400 + 70);
  });

  it('on the editor: one undo step, a run only', () => {
    const es = script([{ at: 0, pos: 20 }, { at: 1000, pos: 80 }, { at: 2000, pos: 20 }]);
    es._selectedIndices = new Set([0, 1]);
    expect(es.applyModifier(vibrateBetween, { size: 20, rate: 10 }).changed).toBe(true);
    expect(es.actions.length).toBeGreaterThan(3);
    es.undo();
    expect(es.actions.length).toBe(3);
    es._selectedIndices = new Set([0, 2]);
    expect(es.applyModifier(vibrateBetween, { size: 20, rate: 10 })).toMatchObject({ refused: true });
  });

  it('from the pop-out, with its options', () => {
    const es = script(two);
    es._selectedIndices = new Set([0, 1]);
    const host = { reportModifierResult: vi.fn() };
    applyPopoutEdit(es, { type: EDIT_OP, op: OP_APPLY_MODIFIER, name: 'vibrate', args: [{ size: 30, rate: 5 }] }, host);
    expect(es.actions.length).toBe(two.length + 4);                // 200 ms spacing over 1 s
    expect(host.reportModifierResult).toHaveBeenCalledWith(expect.objectContaining({ changed: true }), 'vibrate');
  });
});
