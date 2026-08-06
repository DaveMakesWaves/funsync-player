// Grouping EroScripts attachments into script sets.
//
// Fixtures are REAL attachment lists captured from discuss.eroscripts.com
// on 2026-08-06. The awkward one (a 15-file ASMR topic) is the reason this
// module exists — it's the shape that breaks any "one post = one script"
// assumption.
import { describe, it, expect } from 'vitest';
import { groupAttachments, axisLabels, buildMultiAssociation } from '../../renderer/js/eroscripts-groups.js';

const att = (name) => ({ name, url: `https://cdn.example/${encodeURIComponent(name)}` });

// [vESP] Izzy Green POV Onlyfans Blowjob [Multi-Axis] — tagged osr2, multi-axis
const IZZY = [
  att('Izzy Green POV.funscript'),
  att('Izzy Green POV.roll.funscript'),
  att('Izzy Green POV.pitch.funscript'),
];

// VirtualTaboo - Butt Expert Is Here — tagged sr6, vr, multi-axis
const VIRTUALTABOO = [
  att('virtualtaboo-butt-expert-is-here-files.funscript'),
  att('virtualtaboo-butt-expert-is-here-files.twist.funscript'),
  att('virtualtaboo-butt-expert-is-here-files.pitch.funscript'),
  att('virtualtaboo-butt-expert-is-here-files.roll.funscript'),
];

// (multi-axis)(ASMR) レベルアップ式… — 15 attachments, several independent
// scripts, two variants of one scene, ONE axis companion among them.
const ASMR = [
  att('(Randomly)中間地点2.funscript'),
  att('(Stable)中間地点2.funscript'),
  att('中間地点3.funscript'),
  att('レベリングルーム3-1.funscript'),
  att('中間地点4.funscript'),
  att('レベリングルーム4-1.funscript'),
  att('レベリングルーム4-2.funscript'),
  att('中間地点5.funscript'),
  att('中間地点5.pitch.funscript'),
  att('レベリングルーム5.funscript'),
];

describe('groupAttachments — clean multi-axis posts', () => {
  it('groups a main plus its axis companions into one set', () => {
    const { groups } = groupAttachments(IZZY);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.base).toBe('Izzy Green POV');
    expect(g.main.name).toBe('Izzy Green POV.funscript');
    expect(axisLabels(g)).toEqual(['Roll', 'Pitch']);
    expect(g.isMultiAxis).toBe(true);
    expect(g.canAssociateMulti).toBe(true);
  });

  it('orders axes canonically, not by upload order', () => {
    // Uploaded twist, pitch, roll — AXIS_DEFINITIONS order is twist, roll, pitch.
    const { groups } = groupAttachments(VIRTUALTABOO);
    expect(axisLabels(groups[0])).toEqual(['Twist', 'Roll', 'Pitch']);
  });
});

describe('groupAttachments — the messy real post', () => {
  it('splits 10 files into their independent scripts', () => {
    const { groups } = groupAttachments(ASMR);
    // 9 distinct bases: the two 中間地点2 variants differ by prefix.
    expect(groups).toHaveLength(9);
  });

  it('surfaces the one set that actually has an axis companion first', () => {
    const { groups } = groupAttachments(ASMR);
    expect(groups[0].base).toBe('中間地点5');
    expect(axisLabels(groups[0])).toEqual(['Pitch']);
    expect(groups.filter((g) => g.isMultiAxis)).toHaveLength(1);
  });

  it('keeps prefixed variants of one scene as separate scripts', () => {
    const { groups } = groupAttachments(ASMR);
    const bases = groups.map((g) => g.base);
    expect(bases).toContain('(Randomly)中間地点2');
    expect(bases).toContain('(Stable)中間地点2');
  });

  it('leaves single-axis groups marked as such', () => {
    const { groups } = groupAttachments(ASMR);
    const single = groups.find((g) => g.base === '中間地点3');
    expect(single.isMultiAxis).toBe(false);
    expect(single.canAssociateMulti).toBe(false);
    expect(single.main).not.toBeNull();
  });
});

describe('groupAttachments — edge cases', () => {
  it('treats a dotted base that is not an axis suffix as part of the name', () => {
    // `v1.2` must not be read as an axis, and must not split the base.
    const { groups } = groupAttachments([att('My Video v1.2.funscript')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].base).toBe('My Video v1.2');
    expect(groups[0].isMultiAxis).toBe(false);
  });

  it('matches base names case-insensitively but displays the main spelling', () => {
    const { groups } = groupAttachments([
      att('Video.funscript'),
      att('VIDEO.Roll.funscript'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].base).toBe('Video');
    expect(axisLabels(groups[0])).toEqual(['Roll']);
  });

  it('will not offer a multi association for axes with no main', () => {
    // A broken post: companions uploaded without the primary script.
    const { groups } = groupAttachments([
      att('Orphan.roll.funscript'),
      att('Orphan.pitch.funscript'),
    ]);
    expect(groups[0].main).toBeNull();
    expect(groups[0].isMultiAxis).toBe(true);
    expect(groups[0].canAssociateMulti).toBe(false);
  });

  it('reports zips as unsupported rather than dropping or downloading them', () => {
    const { groups, unsupported } = groupAttachments([
      att('Scripts.zip'),
      att('Solo.funscript'),
    ]);
    expect(groups).toHaveLength(1);
    expect(unsupported).toEqual([
      { name: 'Scripts.zip', url: expect.any(String), reason: 'zip' },
    ]);
  });

  it('keeps a duplicate main as an extra instead of silently losing it', () => {
    const { groups } = groupAttachments([att('Dup.funscript'), att('Dup.funscript')]);
    expect(groups[0].main).not.toBeNull();
    expect(groups[0].extras).toHaveLength(1);
  });

  it('handles empty and malformed input', () => {
    expect(groupAttachments([]).groups).toEqual([]);
    expect(groupAttachments(null).groups).toEqual([]);
    expect(groupAttachments([null, {}, { name: '' }]).groups).toEqual([]);
  });
});

describe('buildMultiAssociation', () => {
  const pathFor = (name) => `D:/scripts/${name}`;

  it('builds a main + suffix-keyed axes association', () => {
    const { groups } = groupAttachments(IZZY);
    expect(buildMultiAssociation(groups[0], pathFor)).toEqual({
      main: 'D:/scripts/Izzy Green POV.funscript',
      axes: {
        roll: 'D:/scripts/Izzy Green POV.roll.funscript',
        pitch: 'D:/scripts/Izzy Green POV.pitch.funscript',
      },
    });
  });

  it('skips an axis whose download failed rather than writing a dangling path', () => {
    const { groups } = groupAttachments(IZZY);
    const partial = (name) => (name.includes('.pitch.') ? '' : `D:/scripts/${name}`);
    const assoc = buildMultiAssociation(groups[0], partial);
    expect(Object.keys(assoc.axes)).toEqual(['roll']);
    expect(assoc.main).toBeTruthy();
  });

  it('returns null when the group cannot be a multi association', () => {
    const { groups } = groupAttachments([att('Solo.funscript')]);
    expect(buildMultiAssociation(groups[0], pathFor)).toBeNull();
    expect(buildMultiAssociation(null, pathFor)).toBeNull();
  });

  it('returns null when the main itself failed to download', () => {
    const { groups } = groupAttachments(IZZY);
    expect(buildMultiAssociation(groups[0], () => '')).toBeNull();
  });
});
