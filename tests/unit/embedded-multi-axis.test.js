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
