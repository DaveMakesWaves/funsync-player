/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pattern library privacy guard (next major, 2026-11-17).
//
// renderer/js/pattern-library-data.js was generated from a private research
// catalogue whose other fields hold private file names, folder paths and the
// names of the people who made the scripts. Only the parametric models may
// ship (DESIGN-pattern-library.md section a). This test walks the data and
// fails on any key outside that whitelist, on any string that is not one of a
// few kind / trend / ending words or a library id, and on anything path-like.
// It names no person and no file itself: it allows, it does not deny-list.
// The same checks run over the parity fixture, which must hold generated
// output only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATTERN_DATA } from '../../renderer/js/pattern-library-data.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const DATA_SRC = read('../../renderer/js/pattern-library-data.js');
const FIXTURE_SRC = read('../fixtures/pattern-library-parity.json');

// ---- the whitelist (section a of the design) ----
const KINDS = ['cycle', 'template', 'drone', 'hold', 'event'];
const ENDING_WORDS = ['top', 'bottom', 'middle', 'settle', 'slowdown', 'sprint', 'plunge', 'buzzfinish'];
const TREND_WORDS = ['steady', 'ladder', 'waves', 'climbs', 'falls', 'fades', 'swells', 'speeds up', 'slows'];
const TOP_KEYS = ['version', 'families', 'patterns'];
const FAMILY_KEYS = ['id', 'patterns'];
const PATTERN_KEYS = ['id', 'family', 'kind', 'unit', 'defaults', 'ranges', 'event'];
const UNIT_KEYS = { cycle: ['keyframes', 'turningPoints', 'buzz32'], template: ['keyframes', 'strokesInTemplate'], drone: [], hold: [], event: ['speedEnvelope'] };
const DEFAULT_NUMBERS = ['beforeSpeed', 'buzzLegMs', 'buzzShare', 'buzzSwing', 'carrierDepth', 'centre', 'centreRise', 'cyclePeriodMs', 'depth', 'depthCV', 'drop', 'durationSec', 'endSpeed', 'from', 'hi', 'hitchShare', 'holdShare', 'legMs', 'lo', 'minedBuzzLegMs', 'peakBuzzShare', 'phraseSec', 'pos', 'ratio', 'regularityCV', 'share', 'speed', 'speedMax', 'speedMean', 'startSpeed', 'strokePeriodMs', 'strokeSpeed', 'swing', 'timingCV', 'to', 'upDownRatio'];
const DEFAULT_OBJECTS = { aftershocks: ['firstAmp', 'lastAmp', 'legMs', 'midAmp', 'seconds'], arrivesFrom: ['above', 'below', 'level'], leavesTo: ['down', 'level', 'up'], trend: ['centreRise', 'depthRise', 'tempoRatio', 'label'] };
const RANGE_KEYS = ['beforeSpeed', 'buzzLegMs', 'buzzSwing', 'centre', 'cyclePeriodMs', 'depth', 'drop', 'durationSec', 'endSpeed', 'from', 'legMs', 'pos', 'ratio', 'share', 'shockLegMs', 'shockSeconds', 'span', 'speed', 'speedMean', 'startSpeed', 'strokePeriodMs', 'strokeSpeed', 'swing', 'to'];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isTrendLabel = (s) => s.split(', ').every((w) => TREND_WORDS.includes(w));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
/** Anything that looks like a place on a disk or the web, or a script file. */
const PATHLIKE = [/[A-Za-z]:[\\/]/, /\\/, /\//, /\.[a-z0-9]{2,5}$/i, /funscript/i, /https?:/i, /^~/, /%[A-Z]+%/];
/** Words a leaked catalogue field would carry (generic words, never a name). */
const LEAK_WORDS = /\b(?:creators?|scripters?|authors?|examples?|files?|filenames?|folders?|root|paths?|popularity|nearest|source|description|name|title|code|elasid)\b/i;

/** Every key path and every leaf value of a JSON-like value, arrays indexed as []. */
function walk(v, where, keys, leaves) {
  if (Array.isArray(v)) { v.forEach((x) => walk(x, `${where}[]`, keys, leaves)); return; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { keys.push({ where, key: k }); walk(x, `${where}.${k}`, keys, leaves); } return; }
  leaves.push({ where, value: v });
}

describe('pattern-library-data.js carries only the parametric models', () => {
  const keys = [], leaves = [];
  walk(PATTERN_DATA, 'data', keys, leaves);

  it('every key is on the whitelist', () => {
    const allowedAt = (where, p) => {
      if (where === 'data') return TOP_KEYS;
      if (where === 'data.families[]') return FAMILY_KEYS;
      if (where === 'data.patterns[]') return PATTERN_KEYS;
      if (where === 'data.patterns[].unit') return UNIT_KEYS[p.kind];
      if (where === 'data.patterns[].defaults') return [...DEFAULT_NUMBERS, ...Object.keys(DEFAULT_OBJECTS)];
      const obj = /^data\.patterns\[\]\.defaults\.(\w+)$/.exec(where);
      if (obj && DEFAULT_OBJECTS[obj[1]]) return DEFAULT_OBJECTS[obj[1]];
      if (where === 'data.patterns[].ranges') return RANGE_KEYS;
      return [];
    };
    const outside = [];
    for (const k of keys) if (!['data.patterns[]', 'data.patterns[].unit'].includes(k.where) && !allowedAt(k.where).includes(k.key)) outside.push(`${k.where}.${k.key}`);
    // unit and pattern keys depend on the kind
    for (const p of PATTERN_DATA.patterns) {
      for (const k of Object.keys(p)) if (!PATTERN_KEYS.includes(k)) outside.push(`${p.id}.${k}`);
      for (const k of Object.keys(p.unit)) if (!allowedAt('data.patterns[].unit', p).includes(k)) outside.push(`${p.id}.unit.${k} (${p.kind})`);
      if (p.event !== undefined && !['hold', 'event'].includes(p.kind)) outside.push(`${p.id}.event on a ${p.kind}`);
    }
    expect(outside).toEqual([]);
  });

  it('every string is a kind, a trend or ending word, or a library id; nothing is path-like', () => {
    const bad = [];
    for (const { where, value } of leaves) {
      if (typeof value === 'number') { if (!Number.isFinite(value)) bad.push(`${where}: ${value}`); continue; }
      if (typeof value !== 'string') { bad.push(`${where}: a ${typeof value}`); continue; }
      const ok = (where === 'data.patterns[].kind' && KINDS.includes(value))
        || (where === 'data.patterns[].event' && ENDING_WORDS.includes(value))
        || (where === 'data.patterns[].defaults.trend.label' && isTrendLabel(value))
        || (['data.patterns[].id', 'data.patterns[].family', 'data.families[].id', 'data.families[].patterns[]'].includes(where) && ID.test(value));
      if (!ok) bad.push(`${where}: "${value}"`);
      if (PATHLIKE.some((re) => re.test(value)) || LEAK_WORDS.test(value)) bad.push(`${where}: "${value}" looks like a path or a leaked field`);
    }
    expect(bad).toEqual([]);
  });

  it('holds shapes, not recordings: keyframes and masks are normalised to 0-1, at most 44 points', () => {
    const bad = [];
    for (const p of PATTERN_DATA.patterns) {
      for (const k of ['keyframes', 'turningPoints']) {
        const kf = p.unit[k];
        if (!kf) continue;
        if (kf.length > 44) bad.push(`${p.id}.${k}: ${kf.length} points`);
        for (const pt of kf) if (pt.length !== 2 || !pt.every((x) => isNum(x) && x >= 0 && x <= 1)) bad.push(`${p.id}.${k}: ${JSON.stringify(pt)}`);
      }
      if (p.unit.buzz32 && (p.unit.buzz32.length !== 32 || !p.unit.buzz32.every((x) => isNum(x) && x >= 0 && x <= 1))) bad.push(`${p.id}.buzz32`);
      // the display-only shapes of the endings, holds and drones are not shipped
      if (['drone', 'hold', 'event'].includes(p.kind) && p.unit.keyframes) bad.push(`${p.id}: keyframes on a ${p.kind}`);
      for (const [k, v] of Object.entries(p.ranges)) if (!(Array.isArray(v) && v.length === 2 && v.every(isNum))) bad.push(`${p.id}.ranges.${k}`);
    }
    expect(bad).toEqual([]);
  });

  it('stays small, says in its header what it is, and the module source holds nothing path-like either', () => {
    expect(JSON.stringify(PATTERN_DATA).length).toBeLessThan(80000);
    expect(Buffer.byteLength(DATA_SRC)).toBeLessThan(80000);
    const header = DATA_SRC.slice(0, DATA_SRC.indexOf('function deepFreeze'));
    expect(header).toMatch(/GENERATED, do not edit by hand/);
    expect(header).toMatch(/private research\s+\/\/ catalogue|private research catalogue/);
    expect(header).toMatch(/whitelist/);
    expect(header).toMatch(/carries no names, descriptions, file names, paths/);
    // the whole file: no drive, no backslash, no web address, no script file
    for (const re of [/[A-Za-z]:[\\/]/, /\\/, /https?:/i, /funscript/i, /\.json\b/i]) expect(DATA_SRC).not.toMatch(re);
    // everything after the header is the frozen literal and its helper: no comments that could carry a note
    expect(DATA_SRC.slice(header.length)).not.toMatch(/\/\/|\/\*/);
    // frozen all the way down, so no code can scribble into it
    expect(Object.isFrozen(PATTERN_DATA)).toBe(true);
    expect(Object.isFrozen(PATTERN_DATA.patterns[0].unit.keyframes[0])).toBe(true);
  });
});

describe('the parity fixture holds generated output only', () => {
  const fixture = JSON.parse(FIXTURE_SRC);

  it('has only library ids, numbers, case words and warning codes', () => {
    const keys = [], leaves = [];
    walk({ ...fixture, about: undefined }, 'f', keys, leaves);
    const ids = new Set(PATTERN_DATA.patterns.map((p) => p.id));
    const WARNINGS = ['speed-capped', 'speed-unreachable', 'range-clipped', 'too-short', 'range-widened', 'fast-legs'];
    const bad = [];
    for (const { where, value } of leaves) {
      if (value === undefined || typeof value === 'number' || typeof value === 'boolean') continue;
      const ok = (['f.patterns[].id', 'f.full[].id'].includes(where) && ids.has(value))
        || (where === 'f.patterns[].r[][]' && /^[0-9a-f]{16}$/.test(value))
        || (where === 'f.patterns[].r[][][]' && WARNINGS.includes(value))
        || (/^f\.caseTemplates\[\]\.(speed|ramp\.to)$/.test(where) && ['lo', 'hi'].includes(value))
        || (where === 'f.full[].vib' && /^[01]+$/.test(value));
      if (!ok) bad.push(`${where}: "${value}"`);
    }
    expect(bad).toEqual([]);
    for (const re of [/[A-Za-z]:[\\/]/, /\\/, /https?:/i, /funscript/i]) expect(FIXTURE_SRC).not.toMatch(re);
  });
});
