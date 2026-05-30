import { describe, it, expect } from 'vitest';
import {
  extractEmbeddedAxes,
  buildCompanionFiles,
  companionPathMap,
} from '../../renderer/js/embedded-multi-axis.js';

describe('extractEmbeddedAxes', () => {
  describe('Format A — HereSphere `additional_axes`', () => {
    it('extracts each axis entry into the suffix map', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }, { at: 500, pos: 80 }],
        additional_axes: [
          { axis: 'twist', actions: [{ at: 0, pos: 50 }, { at: 500, pos: 30 }] },
          { axis: 'pitch', actions: [{ at: 0, pos: 50 }, { at: 500, pos: 70 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(2);
      expect(map.get('twist')).toHaveLength(2);
      expect(map.get('pitch')).toHaveLength(2);
    });

    it('case-insensitive axis names', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        additional_axes: [{ axis: 'ROLL', actions: [{ at: 0, pos: 50 }, { at: 100, pos: 70 }] }],
      };
      expect(extractEmbeddedAxes(parsed).has('roll')).toBe(true);
    });

    it('accepts alias names (rotate → twist, vibrate → vib)', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        additional_axes: [
          { axis: 'rotate', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 70 }] },
          { axis: 'vibrate', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 70 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.has('twist')).toBe(true);
      expect(map.has('vib')).toBe(true);
    });

    it('skips entries with unknown axis names', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        additional_axes: [
          { axis: 'mystery', actions: [{ at: 0, pos: 50 }] },
          { axis: 'roll', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 70 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(1);
      expect(map.has('roll')).toBe(true);
    });

    it('skips entries with malformed action arrays', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        additional_axes: [
          { axis: 'twist', actions: 'not-an-array' },
          { axis: 'pitch', actions: [{ pos: 50 }] }, // no `at`
          { axis: 'roll',  actions: [{ at: 0, pos: 50 }, { at: 100, pos: 70 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(1);
      expect(map.has('roll')).toBe(true);
    });
  });

  describe('Format B — OFS-extended `raw`', () => {
    it('extracts axes nested under raw.<axisName>.actions', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        raw: {
          twist: { actions: [{ at: 0, pos: 50 }, { at: 500, pos: 80 }] },
          pitch: { actions: [{ at: 0, pos: 50 }, { at: 500, pos: 20 }] },
        },
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(2);
      expect(map.get('twist')[1].pos).toBe(80);
      expect(map.get('pitch')[1].pos).toBe(20);
    });

    it('Format A wins when both A and B are present for the same axis', () => {
      const aActions = [{ at: 0, pos: 50 }, { at: 1, pos: 60 }];
      const bActions = [{ at: 0, pos: 50 }, { at: 1, pos: 90 }];
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        additional_axes: [{ axis: 'twist', actions: aActions }],
        raw: { twist: { actions: bActions } },
      };
      expect(extractEmbeddedAxes(parsed).get('twist')).toBe(aActions);
    });
  });

  describe('Format C — direct sibling keys', () => {
    it('extracts axes from a sibling key holding an actions array', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        twist: [{ at: 0, pos: 50 }, { at: 100, pos: 70 }],
        pitch: [{ at: 0, pos: 50 }, { at: 100, pos: 30 }],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(2);
    });

    it('extracts axes from a sibling key holding { actions: [...] }', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        twist: { actions: [{ at: 0, pos: 50 }, { at: 100, pos: 70 }] },
      };
      expect(extractEmbeddedAxes(parsed).has('twist')).toBe(true);
    });

    it('skips reserved top-level keys (version / metadata / raw / etc)', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        version: '1.0',
        inverted: false,
        range: 100,
        metadata: { creator: 'test' },
      };
      expect(extractEmbeddedAxes(parsed).size).toBe(0);
    });
  });

  describe('Format D — inline TCode keys per action', () => {
    it('pivots inline TCode keys into per-axis action arrays', () => {
      const parsed = {
        tcode: '0.3',
        actions: [
          { at: 0,   pos: 50, R0: 50, R1: 30, R2: 70 },
          { at: 500, pos: 80, R0: 60, R1: 40, R2: 80 },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(3);
      // R0 → twist, R1 → roll, R2 → pitch
      expect(map.get('twist')[0]).toEqual({ at: 0, pos: 50 });
      expect(map.get('twist')[1]).toEqual({ at: 500, pos: 60 });
      expect(map.get('roll')[1]).toEqual({ at: 500, pos: 40 });
      expect(map.get('pitch')[1]).toEqual({ at: 500, pos: 80 });
    });

    it('ignores actions that lack any TCode axis keys', () => {
      const parsed = {
        actions: [
          { at: 0, pos: 50 },          // main only
          { at: 1, pos: 60, R0: 70 },  // has twist
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      // Only one twist sample → can't form a valid 2+ action axis
      expect(map.has('twist')).toBe(false);
    });

    it('sorts pivoted actions even if input order is jumbled', () => {
      const parsed = {
        actions: [
          { at: 500, pos: 80, R1: 90 },
          { at: 0,   pos: 50, R1: 50 },
          { at: 250, pos: 65, R1: 70 },
        ],
      };
      const roll = extractEmbeddedAxes(parsed).get('roll');
      expect(roll.map(a => a.at)).toEqual([0, 250, 500]);
    });

    it('skips L0 (it IS the main stroke)', () => {
      const parsed = {
        actions: [
          { at: 0, pos: 50, L0: 50 },
          { at: 1, pos: 80, L0: 80 },
        ],
      };
      // L0 == pos by definition; we don't emit it as a separate axis.
      expect(extractEmbeddedAxes(parsed).size).toBe(0);
    });

    it('Format A wins over Format D for the same axis', () => {
      const aActions = [{ at: 0, pos: 99 }, { at: 1, pos: 11 }];
      const parsed = {
        additional_axes: [{ axis: 'twist', actions: aActions }],
        actions: [
          { at: 0, pos: 50, R0: 0 },
          { at: 1, pos: 60, R0: 100 },
        ],
      };
      expect(extractEmbeddedAxes(parsed).get('twist')).toBe(aActions);
    });
  });

  describe('Format E — `axes` array keyed by TCode id (99DM / Iwara convention)', () => {
    it('extracts each axis entry into the suffix map', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }, { at: 500, pos: 80 }],
        axes: [
          { id: 'R1', actions: [{ at: 0, pos: 50 }, { at: 500, pos: 30 }] },
          { id: 'R2', actions: [{ at: 0, pos: 50 }, { at: 500, pos: 70 }] },
        ],
        version: '1.1',
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(2);
      expect(map.get('roll')).toHaveLength(2);     // R1 → roll
      expect(map.get('pitch')).toHaveLength(2);    // R2 → pitch
    });

    it('extracts every TCode-mapped id (full coverage of R0/R1/R2/V0/L1/L2/A0)', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [
          { id: 'R0', actions: [{ at: 0, pos: 10 }, { at: 1, pos: 20 }] },
          { id: 'R1', actions: [{ at: 0, pos: 20 }, { at: 1, pos: 30 }] },
          { id: 'R2', actions: [{ at: 0, pos: 30 }, { at: 1, pos: 40 }] },
          { id: 'L1', actions: [{ at: 0, pos: 40 }, { at: 1, pos: 50 }] },
          { id: 'L2', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 60 }] },
          { id: 'V0', actions: [{ at: 0, pos: 60 }, { at: 1, pos: 70 }] },
          { id: 'A0', actions: [{ at: 0, pos: 70 }, { at: 1, pos: 80 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.has('twist')).toBe(true);    // R0
      expect(map.has('roll')).toBe(true);     // R1
      expect(map.has('pitch')).toBe(true);    // R2
      expect(map.has('surge')).toBe(true);    // L1
      expect(map.has('sway')).toBe(true);     // L2
      expect(map.has('vib')).toBe(true);      // V0
      expect(map.has('valve')).toBe(true);    // A0
      expect(map.size).toBe(7);
    });

    it('silently skips an L0 entry in the axes array (main stroke, not a separate axis)', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }, { at: 1, pos: 80 }],
        axes: [
          { id: 'L0', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 80 }] },
          { id: 'R1', actions: [{ at: 0, pos: 40 }, { at: 1, pos: 60 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(1);
      expect(map.has('roll')).toBe(true);
    });

    it('case-insensitive id (defensive — hand-edited files use lowercase)', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [
          { id: 'r1', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 30 }] },
        ],
      };
      expect(extractEmbeddedAxes(parsed).has('roll')).toBe(true);
    });

    it('skips entries with unknown TCode ids', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [
          { id: 'X9', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 50 }] },  // unknown
          { id: 'R1', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 30 }] },  // valid
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(1);
      expect(map.has('roll')).toBe(true);
    });

    it('skips entries with malformed actions array', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [
          { id: 'R1', actions: 'not-an-array' },
          { id: 'R2', actions: [{ pos: 50 }] },                        // missing `at`
          { id: 'R0', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 30 }] }, // valid
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(1);
      expect(map.has('twist')).toBe(true);    // R0
    });

    it('skips entries that are null / missing id / wrong shape', () => {
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [
          null,
          undefined,
          { actions: [{ at: 0, pos: 50 }, { at: 1, pos: 50 }] },   // no id
          { id: null, actions: [{ at: 0, pos: 50 }, { at: 1, pos: 50 }] },
          { id: 'R1', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 30 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      expect(map.size).toBe(1);
      expect(map.has('roll')).toBe(true);
    });

    it('Format A wins over Format E for the same axis (precedence)', () => {
      const aActions = [{ at: 0, pos: 99 }, { at: 1, pos: 11 }];
      const eActions = [{ at: 0, pos: 50 }, { at: 1, pos: 60 }];
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        additional_axes: [{ axis: 'roll', actions: aActions }],
        axes: [{ id: 'R1', actions: eActions }],
      };
      expect(extractEmbeddedAxes(parsed).get('roll')).toBe(aActions);
    });

    it('Format B wins over Format E for the same axis (precedence)', () => {
      const bActions = [{ at: 0, pos: 80 }, { at: 1, pos: 20 }];
      const eActions = [{ at: 0, pos: 50 }, { at: 1, pos: 60 }];
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        raw: { roll: { actions: bActions } },
        axes: [{ id: 'R1', actions: eActions }],
      };
      expect(extractEmbeddedAxes(parsed).get('roll')).toBe(bActions);
    });

    it('Format E wins over Format C — `axes` is more explicit than loose sibling sniffing', () => {
      const eActions = [{ at: 0, pos: 50 }, { at: 1, pos: 60 }];
      const cActions = [{ at: 0, pos: 10 }, { at: 1, pos: 20 }];
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [{ id: 'R1', actions: eActions }],
        roll: cActions,
      };
      expect(extractEmbeddedAxes(parsed).get('roll')).toBe(eActions);
    });

    it('does NOT accidentally pick up `axes` as a Format-C sibling key', () => {
      // Regression: pre-fix, the Format C loop would have considered
      // `axes` as a potential axis-name siblings (it's not — it's a
      // structural container). The SKIP list now includes it.
      const parsed = {
        actions: [{ at: 0, pos: 50 }],
        axes: [
          { id: 'R1', actions: [{ at: 0, pos: 50 }, { at: 1, pos: 60 }] },
        ],
      };
      const map = extractEmbeddedAxes(parsed);
      // The roll axis should come from Format E parsing, not Format C
      // misinterpreting `axes`. Either way the result is the same here,
      // but the test pins the parser's choice via knowing there's exactly
      // one extracted axis (roll).
      expect(map.size).toBe(1);
      expect(map.has('roll')).toBe(true);
    });
  });

  describe('Defensive', () => {
    it('null / undefined / non-object input → empty map', () => {
      expect(extractEmbeddedAxes(null).size).toBe(0);
      expect(extractEmbeddedAxes(undefined).size).toBe(0);
      expect(extractEmbeddedAxes('not json').size).toBe(0);
      expect(extractEmbeddedAxes(42).size).toBe(0);
    });

    it('plain single-axis funscript → empty map (no axes)', () => {
      const parsed = {
        version: '1.0',
        actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }],
      };
      expect(extractEmbeddedAxes(parsed).size).toBe(0);
    });
  });
});

describe('buildCompanionFiles', () => {
  it('returns a `funscript`-shaped content blob per axis', () => {
    const map = new Map([
      ['twist', [{ at: 0, pos: 50 }, { at: 100, pos: 60 }]],
      ['pitch', [{ at: 0, pos: 50 }, { at: 100, pos: 70 }]],
    ]);
    const files = buildCompanionFiles(map);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      suffix: 'twist',
      content: {
        version: '1.0',
        actions: [{ at: 0, pos: 50 }, { at: 100, pos: 60 }],
      },
    });
  });

  it('strips extra action fields (only at + pos survive)', () => {
    const map = new Map([
      ['roll', [{ at: 0, pos: 50, extra: 'junk' }, { at: 100, pos: 70 }]],
    ]);
    const files = buildCompanionFiles(map);
    expect(files[0].content.actions[0]).toEqual({ at: 0, pos: 50 });
  });
});

describe('companionPathMap', () => {
  it('builds <stem>.<suffix>.funscript per suffix', () => {
    const map = companionPathMap('C:/v/scene.mp4', ['twist', 'pitch']);
    expect(map).toEqual({
      twist: 'C:/v/scene.twist.funscript',
      pitch: 'C:/v/scene.pitch.funscript',
    });
  });

  it('handles paths without an extension', () => {
    const map = companionPathMap('C:/v/scene', ['roll']);
    expect(map.roll).toBe('C:/v/scene.roll.funscript');
  });

  it('empty videoPath → empty map', () => {
    expect(companionPathMap('', ['twist'])).toEqual({});
  });
});
