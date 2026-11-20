/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// pf-review PF-R6 (2026-11-19): upgrade -> Apply -> downgrade to v0.9.2 ->
// change the Gap Filler there -> upgrade again: the new key won and the
// change made in v0.9.2 was silently ignored (and a merge import of an older
// backup had the same precedence). Now each new value carries `basis`, a
// fingerprint of the old keys it was written over; old keys changed since
// (by an older build or an import) win. Only a real change counts: v0.9.2
// rewrites `custom` from its form and writes the default preset out at every
// save, which changes nothing here.
//
// The v0.9.2 save is v0.9.2's own settings-panel.js persistFiller, as it
// writes (`git show v0.9.2:renderer/components/settings-panel.js`):
//   { ...get('player.gapFiller'), enabled, presetId: select || DEFAULT_PRESET_ID, custom: readCustom() }
// readCustom(): the Custom form's { pattern, bpm, depthPct, absolute }, filled
// from the stored custom (or its defaults: sine, 20, 100, null).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as OLD_PRESETS from '../fixtures/pre-unify-engines/filler-presets.js';
import {
  readPatternChoice, readOrgasmSource, orgasmChoiceInUse, patternChoiceWrites, orgasmSourceWrites, quickPickIdFor,
  oldKeysBasis, normalizePatternChoice,
} from '../../renderer/js/pattern-choice.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';

const dataExport = createRequire(import.meta.url)('../../electron/data-export.js');

/** v0.9.2's persistFiller, on a stored gapFiller, with the form showing `form`. */
function v092Save(gapFiller, { enabled, presetId, custom } = {}) {
  const stored = gapFiller.custom || {};
  const form = custom || {
    pattern: stored.pattern || 'sine',
    bpm: Number.isFinite(stored.bpm) ? stored.bpm : 20,
    depthPct: Number.isFinite(stored.depthPct) ? stored.depthPct : 100,
    absolute: stored.absolute || null,
  };
  return {
    ...gapFiller,
    enabled: enabled !== undefined ? enabled : !!gapFiller.enabled,
    presetId: presetId || gapFiller.presetId || OLD_PRESETS.DEFAULT_PRESET_ID,
    custom: form,
  };
}
/** The new build's Apply: the writes for that choice, as settings-panel.js makes them. */
function apply(feature, choice, player) {
  const next = JSON.parse(JSON.stringify(player));
  for (const { key, value } of patternChoiceWrites(feature, choice, player)) {
    const path = key.split('.').slice(1);
    let node = next;
    for (const k of path.slice(0, -1)) node = (node[k] ||= {});
    node[path[path.length - 1]] = JSON.parse(JSON.stringify(value));
  }
  return next;
}
/** What app.js plays for the Gap Filler (_fillerOptionsForUpload). */
const fillerPlays = (g) => resolveFillerOptions({
  enabled: true, presetId: g.presetId, custom: g.custom || null, pattern: g.pattern || null, thresholdMs: 10000,
});
const QUICK = normalizePatternChoice({ id: 'quick-full-strokes', speed: 200 });

describe('Gap Filler: a change made in v0.9.2 after a downgrade wins after the next upgrade (PF-R6)', () => {
  it('Slow tease -> new build: Quick full strokes -> v0.9.2: Pulse -> upgrade: Pulse shows and plays', () => {
    let player = { gapFiller: { enabled: true, presetId: 'slowTease', thresholdMs: 10000 } };
    player = apply('gapFiller', QUICK, player);
    expect(readPatternChoice('gapFiller', player).id).toBe('quick-full-strokes');
    expect(fillerPlays(player.gapFiller).library.id).toBe('quick-full-strokes');
    player.gapFiller = v092Save(player.gapFiller, { presetId: 'pulse' });          // the downgrade's edit
    expect(OLD_PRESETS.resolveFillerOptions(player.gapFiller).pattern).toBe('square');
    expect(quickPickIdFor(readPatternChoice('gapFiller', player))).toBe('pulse');
    expect(fillerPlays(player.gapFiller).pattern).toBe('square');
    expect(fillerPlays(player.gapFiller).library).toBeUndefined();
    // the new key is left as it was (absence is never destructive): unused until the next Apply
    expect(player.gapFiller.pattern.id).toBe('quick-full-strokes');
  });

  it('only switched on / off in v0.9.2 (its save rewrites custom from the form and writes the preset out): the new choice still wins', () => {
    for (const start of [{ enabled: true, presetId: 'slowTease' }, { enabled: true }, { enabled: false, presetId: 'drift', custom: null }]) {
      let player = { gapFiller: { thresholdMs: 10000, ...start } };
      player = apply('gapFiller', QUICK, player);
      player.gapFiller = v092Save(player.gapFiller, { enabled: !player.gapFiller.enabled });
      expect(readPatternChoice('gapFiller', player).id, JSON.stringify(start)).toBe('quick-full-strokes');
      expect(fillerPlays(player.gapFiller).library?.id).toBe('quick-full-strokes');
    }
  });

  it('Custom: a changed BPM in v0.9.2 wins; the same values saved again do not', () => {
    const custom = { pattern: 'triangle', bpm: 30, depthPct: 70, absolute: null };
    let player = { gapFiller: { enabled: true, presetId: 'custom', custom, thresholdMs: 10000 } };
    player = apply('gapFiller', QUICK, player);
    const same = { ...player, gapFiller: v092Save(player.gapFiller) };
    expect(readPatternChoice('gapFiller', same).id).toBe('quick-full-strokes');
    const changed = { ...player, gapFiller: v092Save(player.gapFiller, { custom: { ...custom, bpm: 45 } }) };
    const c = readPatternChoice('gapFiller', changed);
    expect(c.id).toBe('shape-triangle');
    expect(fillerPlays(changed.gapFiller)).toMatchObject({ pattern: 'triangle', bpm: 45, depthPct: 70 });
  });

  it('a value written before this rule (no basis) wins as before', () => {
    const player = { gapFiller: { enabled: true, presetId: 'pulse', pattern: normalizePatternChoice(QUICK) } };
    expect(readPatternChoice('gapFiller', player).id).toBe('quick-full-strokes');
    expect(fillerPlays(player.gapFiller).library.id).toBe('quick-full-strokes');
  });
});

describe('X and Z: old keys changed by an older build win too (PF-R6)', () => {
  const GEN = { enabled: true, type: 'sine', bpm: 60, min: 10, max: 90 };

  it('X: the 11-17 Generated pattern changed after the new choice was written: it plays again, source and all', () => {
    let player = { orgasmPattern: { ...GEN } };
    player = apply('orgasm', QUICK, player);
    for (const w of orgasmSourceWrites('pattern')) player.orgasmSource = w.value;
    expect(orgasmChoiceInUse(player).id).toBe('quick-full-strokes');
    // an 11-17 build: the Generated pattern's BPM changed there
    const changed = { ...player, orgasmPattern: { ...GEN, bpm: 90 } };
    expect(orgasmChoiceInUse(changed)).toMatchObject({ id: 'shape-sine', rangeMode: 'exact', min: 10, max: 90 });
    // ...and switched off there (both off: the script file plays)
    const off = { ...player, orgasmPattern: { ...GEN, enabled: false } };
    expect(readOrgasmSource(off)).toBe('file');
    // unchanged: the new keys win
    expect(readOrgasmSource(player)).toBe('pattern');
  });

  it('X: absent old keys and the same keys written out as their defaults are the same old keys', () => {
    const player = apply('orgasm', QUICK, {});
    const written = {
      ...player,
      orgasmPattern: { enabled: false, type: 'sine', bpm: 60, min: 0, max: 100 },
      orgasmLibraryPattern: { enabled: false, id: null, speed: null, reversed: false, min: null, max: null },
    };
    expect(oldKeysBasis('orgasm', {})).toBe(oldKeysBasis('orgasm', { orgasmLibraryPattern: written.orgasmLibraryPattern }));
    expect(readPatternChoice('orgasm', { ...player, orgasmLibraryPattern: written.orgasmLibraryPattern }).id).toBe('quick-full-strokes');
  });

  it('Z: edgePattern changed after edgePatternChoice was written: it plays', () => {
    let player = { edgePattern: { id: 'slow-base-grind', speed: null, reversed: false, min: null, max: null } };
    player = apply('edge', QUICK, player);
    expect(readPatternChoice('edge', player).id).toBe('quick-full-strokes');
    const changed = { ...player, edgePattern: { ...player.edgePattern, id: 'fast-tip-flicks' } };
    expect(readPatternChoice('edge', changed).id).toBe('fast-tip-flicks');
  });
});

describe('a merge import follows the same rule (PF-R6)', () => {
  const cfg = (player) => ({ settings: { player }, playlists: [], categories: [], videoCategories: {} });

  it('an older backup whose old keys differ from what this machine\'s choice was written over: the backup\'s keys play', () => {
    const here = apply('gapFiller', QUICK, { gapFiller: { enabled: true, presetId: 'slowTease', thresholdMs: 10000 } });
    const older = cfg({ gapFiller: { enabled: true, presetId: 'pulse', thresholdMs: 12000 } });
    const merged = dataExport.mergeConfig(cfg(here), older, 'merge').settings.player;
    expect(merged.gapFiller.pattern.id).toBe('quick-full-strokes');            // kept, not deleted
    expect(quickPickIdFor(readPatternChoice('gapFiller', merged))).toBe('pulse');
    expect(fillerPlays(merged.gapFiller).pattern).toBe('square');
  });

  it('an older backup with the same old keys: this machine\'s choice stays', () => {
    const here = apply('gapFiller', QUICK, { gapFiller: { enabled: true, presetId: 'slowTease', thresholdMs: 10000 } });
    const older = cfg({ gapFiller: { enabled: false, presetId: 'slowTease', thresholdMs: 12000 } });
    const merged = dataExport.mergeConfig(cfg(here), older, 'merge').settings.player;
    expect(readPatternChoice('gapFiller', merged).id).toBe('quick-full-strokes');
  });
});
