/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The combined multi-axis file FunSync writes (2026-11-24): funscript 2.0
// `channels` (RFC 267449 #64, read by XTPlayer) plus the same axes as an
// `axes` array by T-Code id (the only layout MultiFunPlayer reads), root
// `actions` the stroke. Our own reader must read it back exactly.
import { describe, it, expect } from 'vitest';
import { buildCombinedFunscript, buildSeparateFunscripts, channelNameFor, COMBINED_VERSION } from '../../renderer/js/combined-funscript.js';
import { extractEmbeddedAxes } from '../../renderer/js/embedded-multi-axis.js';

const STROKE = [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 1000, pos: 0 }];
const TWIST = [{ at: 0, pos: 50 }, { at: 800, pos: 80 }];
const SUCK = [{ at: 100, pos: 20 }, { at: 900, pos: 70 }];

describe('buildCombinedFunscript', () => {
  it('root actions = stroke; channels by name; axes mirror by T-Code id; version 2.0', () => {
    const out = buildCombinedFunscript({ actions: STROKE, metadata: { title: 'T' }, inverted: false }, { twist: TWIST, suction: SUCK });
    expect(out.version).toBe(COMBINED_VERSION);
    expect(out.actions).toEqual(STROKE);
    expect(out.metadata).toEqual({ title: 'T' });
    expect(out.inverted).toBe(false);
    expect(Object.keys(out.channels)).toEqual(['twist', 'suck']);     // suction is written `suck`
    expect(out.channels.twist.actions).toEqual(TWIST);
    expect(out.axes).toEqual([{ id: 'R0', actions: TWIST }, { id: 'A1', actions: SUCK }]);
    expect(out.channels.stroke).toBeUndefined();
  });

  it('our reader reads it back: each axis once, the same points', () => {
    const out = JSON.parse(JSON.stringify(buildCombinedFunscript({ actions: STROKE }, { twist: TWIST, suck: SUCK, roll: [{ at: 0, pos: 10 }, { at: 1, pos: 90 }] })));
    const read = extractEmbeddedAxes(out);
    expect([...read.keys()].sort()).toEqual(['roll', 'suction', 'twist']);
    expect(read.get('twist')).toEqual(TWIST);
    expect(read.get('suction')).toEqual(SUCK);
  });

  it('an older layout is converted, not duplicated: additional_axes, raw axes, sibling keys and an old axes / channels are dropped', () => {
    const old = {
      actions: STROKE,
      additional_axes: [{ axis: 'twist', actions: TWIST }],
      raw: { pitch: { actions: TWIST }, note: 'keep me' },
      roll: [{ at: 0, pos: 1 }, { at: 9, pos: 2 }],
      axes: [{ id: 'R2', actions: TWIST }],
      channels: { stroke: { actions: [{ at: 0, pos: 99 }] }, vibe: { actions: TWIST } },
      metadata: { creator: 'me' },
    };
    const out = buildCombinedFunscript(old, { twist: TWIST, pitch: TWIST });
    expect(out.additional_axes).toBeUndefined();
    expect(out.roll).toBeUndefined();
    expect(out.raw).toEqual({ note: 'keep me' });
    expect(Object.keys(out.channels)).toEqual(['twist', 'pitch']);
    expect(out.axes.map((a) => a.id)).toEqual(['R0', 'R2']);
    expect(out.metadata).toEqual({ creator: 'me' });
  });

  it('whole ms, integer 0-100, sorted; an axis with no points is left out; none at all: no channels / axes keys', () => {
    const out = buildCombinedFunscript({ actions: [{ at: 1000.6, pos: 101 }, { at: 0.2, pos: -3 }] }, { twist: [], roll: null });
    expect(out.actions).toEqual([{ at: 0, pos: 0 }, { at: 1001, pos: 100 }]);
    expect(out.channels).toBeUndefined();
    expect(out.axes).toBeUndefined();
  });
});

describe('buildSeparateFunscripts', () => {
  it('the main file and one file per axis, named <base>.<axis>.funscript, the main metadata on each', () => {
    const files = buildSeparateFunscripts({ actions: STROKE, metadata: { title: 'T' }, channels: { twist: { actions: TWIST } }, version: '2.0' }, { twist: TWIST, suction: SUCK }, 'My Video');
    expect(files.map((f) => f.name)).toEqual(['My Video.funscript', 'My Video.twist.funscript', 'My Video.suck.funscript']);
    expect(files[0].content.channels).toBeUndefined();
    expect(files[0].content.version).toBe('1.0');
    expect(files[1].content).toEqual({ version: '1.0', actions: TWIST, metadata: { title: 'T' } });
  });
});

describe('names', () => {
  it('every spelling maps to the written name', () => {
    expect(channelNameFor('suction')).toBe('suck');
    expect(channelNameFor('R0')).toBe('twist');
    expect(channelNameFor('vibe')).toBe('vib');
    expect(channelNameFor('stroke')).toBeNull();
  });

  it('the RFC\'s own example name `vibe` is read as the vibe axis', () => {
    const read = extractEmbeddedAxes({ version: '2.0', actions: STROKE, channels: { vibe: { actions: TWIST } } });
    expect(read.get('vib')).toEqual(TWIST);
  });
});
