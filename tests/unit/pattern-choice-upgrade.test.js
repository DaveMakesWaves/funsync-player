/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// UPGRADE SAFETY of the pattern settings unification (2026-11-19, release-
// blocking; DESIGN-pattern-settings-unify.md §4, RULES-PF): a config stored by
// v0.9.2 (Gap Filler) or by the 11-17 builds (X's Generated pattern and
// library source, Z's pattern) plays EXACTLY as it did: old render vs new
// render, the same positions on the same timestamps (so the same stroke rate,
// checked within 2% as well), through every path (the tick engines' merged
// actions and the Handy / Autoblow upload). The old keys are never written:
// byte for byte the same after any new write. The new keys survive an export
// and import, and a merge import of an older backup works.
//
// "Old" is frozen: tests/fixtures/pre-unify-engines/ holds the v0.9.2 filler
// (filler-engine, filler-presets, gap-filler, script-modifiers,
// device-transform-stack: `git show v0.9.2:renderer/js/<file>`) and the 11-17
// orgasm-pattern.js, so a later change to the live modules cannot move the
// reference along with it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import * as OLD_FILLER from '../fixtures/pre-unify-engines/filler-engine.js';
import * as OLD_PRESETS from '../fixtures/pre-unify-engines/filler-presets.js';
import * as OLD_ORGASM from '../fixtures/pre-unify-engines/orgasm-pattern.js';
import { buildFillerActions, fillRawScriptContent, applyFiller } from '../../renderer/js/filler-engine.js';
import {
  readPatternChoice, readOrgasmSource, orgasmChoiceInUse, patternChoiceWrites, orgasmSourceWrites, choiceSource,
  resolveGapFillerOptions, quickPickIdFor, normalizePatternChoice, listQuickPicks,
} from '../../renderer/js/pattern-choice.js';
import {
  normalizePatternSource, patternSourceLoop, patternSourceKey, buildPatternSourceContent, clearPatternSourceCache,
  ORGASM_LIBRARY_DEFAULTS, EDGE_PATTERN_DEFAULTS,
} from '../../renderer/js/pattern-source.js';
import { shapeRng } from '../../renderer/js/pattern-library-shapes.js';
import { DataService } from '../../renderer/js/data-service.js';

const require_ = createRequire(import.meta.url);
const dataExport = require_('../../electron/data-export.js');

afterEach(() => { vi.restoreAllMocks(); clearPatternSourceCache(); delete globalThis.window; });

/** Math.random from a seeded stream (the same stream for the old and the new render). */
const stubRandom = (seed) => { const r = shapeRng(seed); return vi.spyOn(Math, 'random').mockImplementation(() => r()); };

/** Strokes (two turns each) a minute; holds and repeated positions are not turns. */
function strokesPerMinute(acts) {
  let turns = 0, dir = 0;
  for (let i = 1; i < acts.length; i++) {
    const d = Math.sign(acts[i].pos - acts[i - 1].pos);
    if (!d) continue;
    if (dir && d !== dir) turns++;
    dir = d;
  }
  return (turns / 2) / ((acts[acts.length - 1].at - acts[0].at) / 60000);
}

/**
 * A realistic script: a 14 s blank intro (a leading gap), stroking in 25-75 with gaps of 11, 23 and 47 s, and a
 * trailing gap to the video's end. Dave's own filler: on, 10 s threshold.
 */
function makeScript() {
  const acts = [];
  let t = 14000, k = 0;
  const gaps = new Map([[60000, 11000], [140000, 23000], [230000, 47000]]);
  while (t < 330000) {
    acts.push({ at: t, pos: k++ % 2 ? 25 + (k % 7) : 75 - (k % 5) });
    t += 380 + (k % 3) * 40;
    for (const [at, len] of gaps) if (t >= at && t < at + 500) t += len;
  }
  return acts;
}
const SCRIPT = makeScript();
const DURATION = 372000;

/** The v0.9.2 engine (frozen) and the new one, from the same `player.gapFiller`. */
function renders(gapFiller, seed = 'filler') {
  const oldOpts = OLD_PRESETS.resolveFillerOptions({
    enabled: true, presetId: gapFiller.presetId, custom: gapFiller.custom || null, thresholdMs: 10000, totalDurationMs: DURATION,
  });
  stubRandom(seed);
  const old = OLD_FILLER.buildFillerActions(SCRIPT, oldOpts);
  vi.restoreAllMocks();
  const newOpts = resolveGapFillerOptions(gapFiller, { enabled: true, thresholdMs: 10000, totalDurationMs: DURATION });
  stubRandom(seed);
  const nw = buildFillerActions(SCRIPT, newOpts);
  vi.restoreAllMocks();
  return { old, nw, oldOpts, newOpts };
}

const FILLERS = [
  ...OLD_PRESETS.FILLER_PRESETS.map((p) => ({ name: `preset ${p.id}`, g: { enabled: true, presetId: p.id, thresholdMs: 10000 } })),
  { name: 'nothing stored but on (the default preset)', g: { enabled: true, thresholdMs: 10000 } },
  { name: 'custom depth', g: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'triangle', bpm: 47, depthPct: 65, absolute: null } } },
  { name: 'custom absolute band', g: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'sawtooth', bpm: 23, depthPct: 100, absolute: { min: 15, max: 80 } } } },
  { name: 'custom centre', g: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'escalating', bpm: 110, depthPct: 40, centrePct: 75 } } },
  { name: 'custom random', g: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'random', bpm: 10, depthPct: 10 } } },
];

describe('Gap Filler: a v0.9.2 filler plays exactly as it did', () => {
  for (const { name, g } of FILLERS) {
    it(`${name}: the same positions on the same timestamps, the same stroke rate`, () => {
      const { old, nw } = renders(g);
      expect(old.length).toBeGreaterThan(5);
      expect(nw).toEqual(old);
      expect(Math.abs(strokesPerMinute(nw) / strokesPerMinute(old) - 1)).toBeLessThan(0.02);
    });
  }

  it('every device path: the merged actions (tick engines) and the upload (Handy, Autoblow) are the old ones', () => {
    const raw = JSON.stringify({ version: '1.0', actions: SCRIPT });
    for (const { g } of FILLERS) {
      const oldOpts = OLD_PRESETS.resolveFillerOptions({ enabled: true, presetId: g.presetId, custom: g.custom || null, thresholdMs: 10000, totalDurationMs: DURATION });
      const newOpts = resolveGapFillerOptions(g, { enabled: true, thresholdMs: 10000, totalDurationMs: DURATION });
      stubRandom(1);
      const oldUpload = OLD_FILLER.fillRawScriptContent(raw, oldOpts);
      const oldMerged = OLD_FILLER.applyFiller(SCRIPT, oldOpts);
      vi.restoreAllMocks();
      stubRandom(1);
      expect(fillRawScriptContent(raw, newOpts)).toBe(oldUpload);
      expect(applyFiller(SCRIPT, newOpts)).toEqual(oldMerged);
      vi.restoreAllMocks();
    }
  });

  it('the quick pick shown for an upgraded preset is that preset', () => {
    for (const p of OLD_PRESETS.FILLER_PRESETS) expect(quickPickIdFor(readPatternChoice('gapFiller', { gapFiller: { presetId: p.id } }))).toBe(p.id);
  });

  it('a quick pick picked in the new build plays the preset it came from', () => {
    for (const q of listQuickPicks()) {
      const oldOpts = OLD_PRESETS.resolveFillerOptions({ enabled: true, presetId: q.id, thresholdMs: 10000, totalDurationMs: DURATION });
      const newOpts = resolveGapFillerOptions({ enabled: true, pattern: q.choice }, { enabled: true, thresholdMs: 10000, totalDurationMs: DURATION });
      stubRandom(2);
      const old = OLD_FILLER.buildFillerActions(SCRIPT, oldOpts);
      vi.restoreAllMocks();
      stubRandom(2);
      expect(buildFillerActions(SCRIPT, newOpts), q.id).toEqual(old);
      vi.restoreAllMocks();
    }
  });
});

describe('X: an 11-17 Generated pattern plays exactly as it did, as the same shape at the same rate', () => {
  const CASES = [];
  for (const type of ['sine', 'triangle', 'sawtooth', 'square', 'escalating', 'random']) {
    CASES.push({ enabled: true, type, bpm: 120, min: 0, max: 100 });   // the defaults
    CASES.push({ enabled: true, type, bpm: 37, min: 10, max: 70 });
    CASES.push({ enabled: true, type, bpm: 300, min: 0, max: 100 });   // its top: 1000 u/s, kept
  }
  for (const op of CASES) {
    it(`${op.type} ${op.bpm} BPM ${op.min}-${op.max}`, () => {
      const player = { orgasmPattern: op, orgasmLibraryPattern: { ...ORGASM_LIBRARY_DEFAULTS } };
      expect(readOrgasmSource(player)).toBe('pattern');
      const choice = orgasmChoiceInUse(player);
      expect(choice.id).toBe(`shape-${op.type}`);
      const src = choiceSource(choice);
      const nw = JSON.parse(src.content).actions;
      expect(src.once).toBe(false);
      stubRandom(op.bpm);
      const old = JSON.parse(OLD_ORGASM.buildOrgasmPatternContent(op)).actions;
      vi.restoreAllMocks();
      if (op.type === 'random') {
        // a seeded stream now (the same strokes every press, the Handy's upload and the local loop alike):
        // the same timestamps (a point every half beat: the same rate), inside the same band
        expect(nw.map((a) => a.at)).toEqual(old.map((a) => a.at));
        expect(nw.every((a) => a.pos >= op.min && a.pos <= op.max)).toBe(true);
      } else {
        expect(nw).toEqual(old);
        expect(Math.abs(strokesPerMinute(nw) / strokesPerMinute(old) - 1)).toBeLessThan(0.02);
      }
    });
  }
});

describe('X and Z: an 11-17 library pattern plays exactly as it did', () => {
  const LIBS = [
    { enabled: true, id: 'quick-full-strokes', speed: null, reversed: false, min: null, max: null },
    { enabled: true, id: 'slow-tip-strokes', speed: 70, reversed: true, min: 30, max: 90 },
    { enabled: true, id: 'mixed-flutters-tip', speed: null, reversed: false, min: 50, max: 50 },   // widened, as before
    { enabled: true, id: 'sprint-finish', speed: null, reversed: false, min: null, max: null },   // an ending: once
  ];
  for (const lib of LIBS) {
    it(`X ${lib.id}: the same key, the same loop, the same once`, () => {
      const player = { orgasmPattern: { enabled: false, type: 'sine', bpm: 120, min: 0, max: 100 }, orgasmLibraryPattern: lib };
      const oldP = normalizePatternSource(lib, ORGASM_LIBRARY_DEFAULTS);
      const old = { key: patternSourceKey(oldP), content: buildPatternSourceContent(oldP), once: patternSourceLoop(oldP).once };
      clearPatternSourceCache();
      expect(readOrgasmSource(player)).toBe('pattern');
      const src = choiceSource(orgasmChoiceInUse(player));
      expect({ key: src.key, content: src.content, once: src.once }).toEqual(old);
    });
    it(`Z ${lib.id}: the same key, the same loop, the same once`, () => {
      const { enabled, ...edge } = lib; // eslint-disable-line no-unused-vars
      const oldP = normalizePatternSource(edge, EDGE_PATTERN_DEFAULTS);
      const old = { key: patternSourceKey(oldP), content: buildPatternSourceContent(oldP), once: patternSourceLoop(oldP).once };
      clearPatternSourceCache();
      const src = choiceSource(readPatternChoice('edge', { edgeHoldAction: 'pattern', edgePattern: edge }));
      expect({ key: src.key, content: src.content, once: src.once }).toEqual(old);
    });
  }

  it('the library source on with no pattern chosen still plays the file (no pattern of its own)', () => {
    const player = { orgasmLibraryPattern: { ...ORGASM_LIBRARY_DEFAULTS, enabled: true }, orgasmPattern: { enabled: false, type: 'square', bpm: 60, min: 0, max: 100 } };
    expect(readOrgasmSource(player)).toBe('pattern');
    expect(orgasmChoiceInUse(player)).toBeNull();
  });
});

describe('the old keys are never written', () => {
  /** A config as v0.9.2 / the 11-17 build stored it. */
  const OLD_CONFIG = {
    settings: {
      player: {
        volume: 80,
        gapFiller: { enabled: true, presetId: 'custom', thresholdMs: 10000, custom: { pattern: 'square', bpm: 25, depthPct: 60, absolute: null } },
        orgasmSwitchMode: 'hold',
        orgasmPattern: { enabled: true, type: 'sawtooth', bpm: 95, min: 5, max: 90 },
        orgasmLibraryPattern: { enabled: false, id: 'slow-tip-strokes', speed: 80, reversed: false, min: null, max: null },
        edgeHoldAction: 'pattern',
        edgePattern: { id: 'quick-full-strokes', speed: 150, reversed: true, min: 20, max: 80 },
      },
    },
    playlists: [], categories: [], videoCategories: {},
  };
  const OLD_KEYS = [['gapFiller', 'presetId'], ['gapFiller', 'custom'], ['gapFiller', 'enabled'], ['gapFiller', 'thresholdMs'], ['orgasmPattern'], ['orgasmLibraryPattern'], ['edgePattern'], ['edgeHoldAction']];
  const at = (cfg, keys) => keys.reduce((o, k) => o?.[k], cfg.settings.player);
  /** electron-conf's write: a dot path into the stored object (main's store.setSetting). */
  const confSet = (cfg, dotPath, value) => {
    const keys = `settings.${dotPath}`.split('.');
    let o = cfg;
    for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
    o[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
  };

  it('every write of all three blocks and of X\'s source, through DataService and main\'s store, leaves them byte for byte', () => {
    const stored = JSON.parse(JSON.stringify(OLD_CONFIG));
    const sent = [];
    globalThis.window = { funsync: { setSetting: (p, v) => { sent.push(p); confSet(stored, p, v); } } };
    const ds = new DataService();
    ds._cache = JSON.parse(JSON.stringify(OLD_CONFIG));
    const before = OLD_KEYS.map((k) => JSON.stringify(at(OLD_CONFIG, k)));
    const player = ds.get('player');
    const writes = [
      ...patternChoiceWrites('gapFiller', { id: 'shape-random', speed: 300, rangeMode: 'exact', min: 0, max: 40 }, player),
      ...patternChoiceWrites('gapFiller', { id: 'slow-tip-strokes', rangeMode: 'script', depthPct: 30 }, player),
      ...patternChoiceWrites('orgasm', { id: 'quick-full-strokes', reversed: true }, player),
      ...orgasmSourceWrites('file'),
      ...orgasmSourceWrites('pattern'),
      ...patternChoiceWrites('edge', { id: 'shape-sine', speed: 45 }, player),
      ...patternChoiceWrites('edge', { id: null }, player),
    ];
    for (const w of writes) ds.set(w.key, w.value);
    expect(sent).toEqual(writes.map((w) => w.key));
    for (const cfg of [ds._cache, stored]) {
      const c = cfg.settings ? cfg : { settings: cfg };
      expect(OLD_KEYS.map((k) => JSON.stringify(at(c, k)))).toEqual(before);
      // and nothing else moved: everything but the new keys is the old config
      const rest = JSON.parse(JSON.stringify(c));
      delete rest.settings.player.gapFiller.pattern;
      delete rest.settings.player.orgasmPatternChoice;
      delete rest.settings.player.orgasmSource;
      delete rest.settings.player.edgePatternChoice;
      expect(JSON.stringify(rest.settings)).toBe(JSON.stringify(OLD_CONFIG.settings));
    }
    // the new build reads the new keys; the old build would read its own, as they were
    expect(readPatternChoice('gapFiller', ds.get('player')).id).toBe('slow-tip-strokes');
    expect(readOrgasmSource(ds.get('player'))).toBe('pattern');
    expect(readPatternChoice('edge', ds.get('player')).id).toBeNull();
    expect(OLD_ORGASM.orgasmPatternSettings(at(stored.settings ? stored : { settings: stored }, ['orgasmPattern']))).toMatchObject({ type: 'sawtooth', bpm: 95 });
  });

  it('a write on a config with no gapFiller at all adds only the new key', () => {
    const stored = { settings: { player: { volume: 80 } } };
    globalThis.window = { funsync: { setSetting: (p, v) => confSet(stored, p, v) } };
    const ds = new DataService();
    ds._cache = JSON.parse(JSON.stringify(stored));
    for (const w of patternChoiceWrites('gapFiller', { id: 'shape-sine' }, ds.get('player'))) ds.set(w.key, w.value);
    expect(Object.keys(stored.settings.player.gapFiller)).toEqual(['pattern']);
    expect(Object.keys(ds._cache.settings.player.gapFiller)).toEqual(['pattern']);
  });
});

describe('export, import and an older backup', () => {
  const NEW = {
    gapFiller: { enabled: true, presetId: 'gentle', thresholdMs: 10000, pattern: normalizePatternChoice({ id: 'slow-tip-strokes', speed: 90, rangeMode: 'script', depthPct: 40, centrePct: 70 }) },
    orgasmSource: 'pattern',
    orgasmPatternChoice: normalizePatternChoice({ id: 'shape-square', speed: 133.33333333333334, rangeMode: 'exact', min: 10, max: 90 }),
    orgasmPattern: { enabled: false, type: 'sine', bpm: 120, min: 0, max: 100 },
    edgeHoldAction: 'pattern',
    edgePatternChoice: normalizePatternChoice({ id: 'quick-full-strokes', reversed: true }),
  };
  const cfg = (player) => ({ settings: { player }, playlists: [], categories: [], videoCategories: {} });

  it('Export then Import Backup File (a real zip) brings every new key back exactly', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-pattern-choice-'));
    try {
      const zip = path.join(tmp, 'b.funsync-backup');
      expect((await dataExport.exportData(cfg(NEW), zip)).success).toBe(true);
      // imported (Import Backup File merges) into a fresh install and into a v0.9.2 config
      for (const [mode, start] of [['fresh', cfg({ volume: 50 })], ['v0.9.2', cfg({ gapFiller: { enabled: false, presetId: 'pulse' }, orgasmPattern: { enabled: true, type: 'sine', bpm: 60, min: 0, max: 100 } })]]) {
        let live = JSON.parse(JSON.stringify(start));
        const store = { getAll: () => JSON.parse(JSON.stringify(live)), replaceData: (d) => { live = { ...live, ...d }; } };
        const res = await dataExport.applyImport({ filePath: zip, store, relaunch: vi.fn() });
        expect(res.success, mode).toBe(true);
        for (const k of ['orgasmSource', 'orgasmPatternChoice', 'edgePatternChoice']) expect(live.settings.player[k], `${mode} ${k}`).toEqual(NEW[k]);
        expect(live.settings.player.gapFiller.pattern, mode).toEqual(NEW.gapFiller.pattern);
        expect(readPatternChoice('orgasm', live.settings.player).speed).toBe(133.33333333333334);
        expect(readOrgasmSource(live.settings.player)).toBe('pattern');
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('a merge import of an older (v0.9.2) backup works: its old keys come in, nothing here is lost', () => {
    const older = cfg({ gapFiller: { enabled: true, presetId: 'pulse', thresholdMs: 12000 }, orgasmPattern: { enabled: true, type: 'triangle', bpm: 80, min: 0, max: 100 } });
    const merged = dataExport.mergeConfig(cfg(NEW), older, 'merge');
    const p = merged.settings.player;
    // the backup's values for its own keys
    expect(p.gapFiller).toMatchObject({ enabled: true, presetId: 'pulse', thresholdMs: 12000 });
    expect(p.orgasmPattern).toEqual(older.settings.player.orgasmPattern);
    // the new keys the backup does not have are kept (absence is never destructive), and they are what plays
    expect(p.gapFiller.pattern).toEqual(NEW.gapFiller.pattern);
    expect(p.orgasmSource).toBe('pattern');
    expect(p.orgasmPatternChoice).toEqual(NEW.orgasmPatternChoice);
    expect(readPatternChoice('gapFiller', p).id).toBe('slow-tip-strokes');
    // ...and into a config that never had the new keys, the backup plays as it did
    const fresh = dataExport.mergeConfig(cfg({ volume: 50 }), older, 'merge');
    expect(quickPickIdFor(readPatternChoice('gapFiller', fresh.settings.player))).toBe('pulse');
    expect(readPatternChoice('orgasm', fresh.settings.player).id).toBe('shape-triangle');
  });

  it('an overwrite import of an older backup is that backup: the derived choices are its old keys', () => {
    const older = cfg({ gapFiller: { enabled: true, presetId: 'drift', thresholdMs: 10000 } });
    const replaced = dataExport.mergeConfig(cfg(NEW), older, 'overwrite');
    expect(replaced.settings.player.gapFiller.pattern).toBeUndefined();
    expect(quickPickIdFor(readPatternChoice('gapFiller', replaced.settings.player))).toBe('drift');
    expect(readOrgasmSource(replaced.settings.player)).toBe('file');
  });
});
