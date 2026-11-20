// A stand-in for renderer/js/pattern-choice.js while it is still the
// contract stub (pf-engine fills it in at the same time as pf-ui builds the
// Settings block, 2026-11-19). `contractOrFake(real)` returns the REAL module
// as soon as it does something (its quick picks are not empty), so the same
// tests run against the real contract without an edit; until then it fills
// the stub's empty bodies with this fake, built on the REAL library engine
// (renderLoop / renderPattern) so the samples are real ones.
//
// Every test that uses it computes what it expects THROUGH the module
// (patternChoiceWrites, renderPatternSample, patternStats, listQuickPicks),
// never through this file's own key names, so nothing here is pinned.
//
// Usage (hoisted by vitest):
//   vi.mock('../../renderer/js/pattern-choice.js', async (importOriginal) => {
//     const { contractOrFake } = await import('./helpers/pattern-choice-fake.js');
//     return contractOrFake(await importOriginal());
//   });

import { FILLER_PRESETS } from '../../../renderer/js/filler-presets.js';
import { hasPattern, describePattern, renderLoop, renderPattern } from '../../../renderer/js/pattern-library.js';
import { computeSpeedStats } from '../../../renderer/js/library-search.js';

const MODES = ['own', 'exact', 'script'];
const EMPTY = Object.freeze({
  id: null, speed: null, reversed: false, rangeMode: 'own', min: null, max: null, depthPct: null, centrePct: null,
});
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const min = num(r.min);
  const max = num(r.max);
  const rangeMode = MODES.includes(r.rangeMode) ? r.rangeMode : (min === null || max === null ? 'own' : 'exact');
  return {
    id: hasPattern(r.id) ? r.id : null,
    speed: num(r.speed),
    reversed: r.reversed === true,
    rangeMode,
    min,
    max,
    depthPct: num(r.depthPct),
    centrePct: num(r.centrePct),
  };
}

const KEYS = { gapFiller: 'player.gapFiller', orgasm: 'player.orgasmChoiceFake', edge: 'player.edgeChoiceFake' };

function presetChoice(p) {
  // u/s at the preset's depth of a full-range script: one up-and-down per beat.
  return normalize({
    id: `shape-${p.pattern}`,
    speed: Math.round((2 * p.depthPct * p.bpm) / 60),
    rangeMode: 'script',
    depthPct: p.depthPct,
    centrePct: p.centrePct,
  });
}

function fromOldSource(raw) {
  if (!raw || typeof raw !== 'object' || !hasPattern(raw.id)) return null;
  return normalize({ id: raw.id, speed: raw.speed, reversed: raw.reversed, min: raw.min, max: raw.max });
}

const FAKE = {
  normalizePatternChoice: normalize,

  readPatternChoice(feature, player) {
    const p = player && typeof player === 'object' ? player : {};
    if (feature === 'gapFiller') {
      const g = p.gapFiller || {};
      if (g.pattern) return normalize(g.pattern);
      const preset = FILLER_PRESETS.find((x) => x.id === (g.presetId || 'slowTease')) || FILLER_PRESETS[0];
      return presetChoice(preset);
    }
    if (feature === 'orgasm') {
      if (p.orgasmChoiceFake) return normalize(p.orgasmChoiceFake);
      const lib = fromOldSource(p.orgasmLibraryPattern);
      if (lib) return lib;
      if (p.orgasmPattern?.enabled) return normalize({ id: `shape-${p.orgasmPattern.type || 'sine'}` });
      return { ...EMPTY };
    }
    if (p.edgeChoiceFake) return normalize(p.edgeChoiceFake);
    return fromOldSource(p.edgePattern) || { ...EMPTY };
  },

  readOrgasmSource(player) {
    const p = player && typeof player === 'object' ? player : {};
    if (p.orgasmSource === 'file' || p.orgasmSource === 'pattern') return p.orgasmSource;
    return p.orgasmLibraryPattern?.enabled === true || p.orgasmPattern?.enabled === true ? 'pattern' : 'file';
  },

  patternChoiceWrites(feature, choice, player) {
    const value = normalize(choice);
    if (feature === 'gapFiller') {
      // A whole-object write, as settings-panel writes gapFiller today: the
      // old fields ride along exactly as read.
      return [{ key: KEYS.gapFiller, value: { ...((player && player.gapFiller) || {}), pattern: value } }];
    }
    return [{ key: KEYS[feature], value }];
  },

  listQuickPicks() {
    return FILLER_PRESETS.map((p) => ({ id: p.id, labelKey: p.labelKey, choice: presetChoice(p) }));
  },

  quickPickIdFor(choice) {
    const want = JSON.stringify(normalize(choice));
    const hit = FAKE.listQuickPicks().find((q) => JSON.stringify(q.choice) === want);
    return hit ? hit.id : 'custom';
  },

  renderPatternSample(choice, opts = {}) {
    const c = normalize(choice);
    if (c.id === null) return { actions: [], warnings: [] };
    const durationMs = Number.isFinite(opts.durationMs) ? opts.durationMs : 8000;
    const sr = opts.scriptRange || { min: 0, max: 100 };
    let range;
    if (c.rangeMode === 'exact' && c.min !== null && c.max !== null) range = { min: c.min, max: c.max };
    if (c.rangeMode === 'script') {
      const width = sr.max - sr.min;
      const centre = c.centrePct === null ? (sr.min + sr.max) / 2 : sr.min + (width * c.centrePct) / 100;
      const half = (width * (c.depthPct ?? 100)) / 200;
      range = { min: Math.max(0, Math.round(centre - half)), max: Math.min(100, Math.round(centre + half)) };
    }
    const o = { speed: c.speed ?? undefined, reversed: c.reversed, range, seed: 1, maxSpeed: 600 };
    const loopable = describePattern(c.id)?.loopable !== false;
    const res = loopable ? renderLoop(c.id, o) : renderPattern(c.id, o);
    if (!res || !Array.isArray(res.actions) || res.actions.length < 2) return { actions: [], warnings: [] };
    const actions = [];
    if (loopable) {
      const loopMs = res.loopMs || res.actions[res.actions.length - 1].at;
      for (let base = 0; base < durationMs && loopMs > 0; base += loopMs) {
        for (const a of res.actions) {
          if (actions.length && a.at === 0) continue;
          if (base + a.at > durationMs) break;
          actions.push({ at: base + a.at, pos: a.pos });
        }
      }
    } else {
      for (const a of res.actions) if (a.at <= durationMs) actions.push({ at: a.at, pos: a.pos });
    }
    return { actions, warnings: res.warnings || [] };
  },

  patternStats(actions) {
    const s = computeSpeedStats(Array.isArray(actions) ? actions : []);
    return { avg: Math.round(s.avgSpeed || 0), peak: Math.round(s.maxSpeed || 0) };
  },
};

/** The real module once pf-engine has filled it in, else the stub with the fake's bodies. */
export function contractOrFake(real) {
  let stub = true;
  try { stub = !(Array.isArray(real.listQuickPicks()) && real.listQuickPicks().length > 0); } catch { stub = true; }
  if (!stub) return { ...real, CONTRACT_UNDER_TEST: 'real' };
  return { ...real, ...FAKE, CONTRACT_UNDER_TEST: 'fake' };
}
