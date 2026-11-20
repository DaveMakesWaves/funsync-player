/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Unpair funscript, the data side (DESIGN-video-options.md (d), test plan
// rows "Unpair confirm", "Unpair Undo", "Unpair and EroScripts tags"), with
// Dave's answer 1 (2026-11-17): Unpair is offered only for a separate script
// added by hand as the main script; a custom routing or a multi-axis set you
// made is never cleared silently; Undo restores every slot exactly.
//
// Every test runs the plan's ops through a fake store with dataService's
// get/set, then reads the store back: what was written, not what was planned.

import { describe, it, expect } from 'vitest';
import {
  planUnpair, planUnpairUndo, unpairConfirmMessages, scriptView, runOps,
  eroscriptsRecordForTags, handMadeSlots, associationSlots,
  planRemoveSet, planRemoveSetUndo, removeSetConfirmMessages,
  canLocateMain, planLocateMain, planLocateVariation, planLocateUndo,
} from '../../renderer/js/video-options-model.js';
import { buildAssociationEntry } from '../../renderer/js/association-shape.js';
import { effectiveTags } from '../../renderer/js/video-tags.js';
import { makeFakeStore } from './helpers/video-options-fake-store.js';

const V = 'C:\\Videos\\scene.mp4';
const OWN = 'C:\\Videos\\scene.funscript';
const HAND = 'D:\\Scripts\\hard.funscript';
const OTHER_V = 'C:\\Videos\\other.mp4';
const OTHER_ENTRY = buildAssociationEntry('single', 'C:\\x\\other.funscript', null, null);

const userMulti = () => ({
  main: HAND,
  axes: { pitch: 'D:\\Scripts\\hard.pitch.funscript', roll: 'D:\\Scripts\\hard.roll.funscript' },
  buttplugVib: false,
});
const autoMulti = () => ({
  main: OWN,
  axes: { twist: 'C:\\Videos\\scene.twist.funscript' },
  buttplugVib: false,
  autoAssigned: true,
});
const userCustom = (main = HAND) => ({
  routes: [
    { role: 'main', scriptPath: main, deviceId: 'handy' },
    { role: 'axis', scriptPath: 'D:\\Scripts\\vib.funscript', deviceId: 'buttplug:Lush 3', buttplugIndex: 0 },
  ],
});

function storeWith(entry, extra = {}) {
  return makeFakeStore({
    library: {
      associations: { [V]: entry, [OTHER_V]: OTHER_ENTRY },
      scriptTags: {},
      ...extra,
    },
  });
}

const assocOf = (store) => store.state.library.associations;
const json = (v) => JSON.stringify(v);

/** Plan with the store's current entry, as the dialog does on the confirm. */
function plan(store, input = {}) {
  return planUnpair({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V], ...input });
}

describe('Unpair is offered only for a separate script you added as the main script', () => {
  it('a script paired by file name gets the rename-or-move line instead', () => {
    const p = planUnpair({ videoPath: V, association: undefined, funscriptPath: OWN });
    expect(p.offered).toBe(false);
    expect(p.reason).toBe('by-name');
    expect(p.explanationKey).toBe('videoOptions.script.unpair.byName');
    expect(p.ops).toEqual([]);
  });

  it('an auto-promoted multi-axis pairing (FunSync paired the axis files by name) is not offered', () => {
    const entry = buildAssociationEntry('multi', OWN, autoMulti(), null);
    const p = planUnpair({ videoPath: V, association: entry, ownScriptPath: OWN });
    expect(p.offered).toBe(false);
    expect(p.reason).toBe('auto-multi');
    expect(p.explanationKey).toBe('videoOptions.script.unpair.autoMulti');
  });

  it('the first script of a one-video folder is not a pairing to undo', () => {
    const p = planUnpair({ videoPath: V, funscriptPath: 'C:\\Videos\\Round 1.funscript', folderVariantMain: true });
    expect(p).toMatchObject({ offered: false, reason: 'folder', explanationKey: 'videoOptions.script.unpair.folder' });
  });

  it('a video with no script says nothing', () => {
    const p = planUnpair({ videoPath: V });
    expect(p).toMatchObject({ offered: false, reason: 'none', explanationKey: null });
  });

  it('choosing the video\'s own script by hand is not a separate script', () => {
    const p = planUnpair({ videoPath: V, ownScriptPath: OWN, association: buildAssociationEntry('single', OWN, null, null) });
    expect(p).toMatchObject({ offered: false, reason: 'own-script' });
    // Same file, other spelling (drive letter case, slashes): still the own one.
    const q = planUnpair({ videoPath: V, ownScriptPath: OWN, association: 'c:/Videos/scene.funscript' });
    expect(q.offered).toBe(false);
  });

  it('a multi-axis set you made over the own script as main: not offered; Change… edits it', () => {
    const entry = buildAssociationEntry('multi', OWN, { ...userMulti(), main: OWN }, null);
    expect(planUnpair({ videoPath: V, ownScriptPath: OWN, association: entry }))
      .toMatchObject({ offered: false, reason: 'own-script', explanationKey: 'videoOptions.script.unpair.ownScript' });
  });

  it('a separate script you added is offered, in every stored shape', () => {
    for (const entry of [
      HAND, // the oldest shape: a bare string from the first manual Associate
      buildAssociationEntry('single', HAND, null, null),
      buildAssociationEntry('multi', OWN, userMulti(), null),
      buildAssociationEntry('custom', OWN, null, userCustom()),
      { mode: 'custom', routes: userCustom().routes }, // legacy custom
      { main: HAND, axes: { pitch: 'p.funscript' } }, // legacy multi
    ]) {
      const p = planUnpair({ videoPath: V, ownScriptPath: OWN, association: entry });
      expect(p.offered, JSON.stringify(entry)).toBe(true);
      expect(p.target.path).toBe(HAND);
      expect(p.target.name).toBe('hard.funscript');
    }
  });

  it('the Script section says the same as the plan', () => {
    const view = scriptView({ videoPath: V, ownScriptPath: OWN, association: buildAssociationEntry('single', HAND, null, null) });
    expect(view.pairing).toMatchObject({ kind: 'single', hand: true });
    expect(view.unpair).toEqual({ offered: true, reason: 'hand-added', explanationKey: null });
  });
});

describe('Unpair confirm (data side)', () => {
  it('planning writes nothing and leaves its input alone, so Cancel and Escape change nothing', () => {
    const entry = buildAssociationEntry('single', HAND, userMulti(), userCustom());
    const store = storeWith(entry);
    const before = json(store.state);
    const input = { videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V] };
    const p = planUnpair(input);
    const msgs = unpairConfirmMessages(p);
    expect(p.offered).toBe(true);
    expect(msgs.lines.length).toBeGreaterThan(1);
    // The confirm was cancelled: the ops are never run.
    expect(json(store.state)).toBe(before);
    expect(store.writes()).toEqual([]);
    expect(json(input.association)).toBe(json(entry));
  });

  it('Unpair of a plain pairing removes all three slots and the mirrors: the entry is gone', () => {
    // A hand-added single, FunSync's auto multi-axis slot beside it.
    const store = storeWith(buildAssociationEntry('single', HAND, autoMulti(), null));
    const p = plan(store);
    expect(p.slots.map((s) => [s.slot, s.change])).toEqual([
      ['single', 'remove'], ['multi', 'remove'], ['custom', 'empty'],
    ]);
    expect(p.deletesEntry).toBe(true);
    runOps(p.ops, store);
    expect(Object.prototype.hasOwnProperty.call(assocOf(store), V)).toBe(false);
    // Another video's pairing is untouched.
    expect(json(assocOf(store)[OTHER_V])).toBe(json(OTHER_ENTRY));
    // Only the associations map was written, once.
    expect(store.writes()).toEqual([['set', 'library.associations']]);
    expect(p.writes).toEqual(['library.associations']);
  });

  it('a multi-axis set and a custom routing you saved in the other slots are kept, and the confirm says so', () => {
    const store = storeWith(buildAssociationEntry('single', HAND, userMulti(), userCustom('D:\\Scripts\\c.funscript')));
    const p = plan(store);
    expect(p.slots.map((s) => [s.slot, s.hand, s.change])).toEqual([
      ['single', true, 'remove'], ['multi', true, 'keep'], ['custom', true, 'keep'],
    ]);
    expect(p.keeps).toEqual(['multi', 'custom']);
    expect(unpairConfirmMessages(p).lines.map((l) => l.key)).toEqual([
      'videoOptions.script.unpair.confirmQuestion',
      'videoOptions.script.unpair.nextOwn',
      'videoOptions.script.unpair.keepsMulti',
      'videoOptions.script.unpair.keepsCustom',
    ]);
    runOps(p.ops, store);
    const after = assocOf(store)[V];
    expect(after.active).toBe(null);
    expect(after.single).toBe(null);
    expect(after.multi).toEqual(userMulti());
    expect(after.custom).toEqual(userCustom('D:\\Scripts\\c.funscript'));
    // Nothing kept plays: no mirror fields of an active slot.
    expect(after.mode).toBeUndefined();
    expect(after.main).toBeUndefined();
    // The video plays its own script now.
    const view = scriptView({ videoPath: V, ownScriptPath: OWN, association: after });
    expect(view.pairing.kind).toBe('by-name');
    expect(view.main.path).toBe(OWN);
  });

  it('a single script you saved before switching to custom routing is kept too', () => {
    const OLD = 'E:\\Old\\earlier.funscript';
    const store = storeWith(buildAssociationEntry('custom', OLD, null, userCustom()));
    const p = plan(store);
    expect(p.slots.map((s) => [s.slot, s.change])).toEqual([['single', 'keep'], ['multi', 'empty'], ['custom', 'remove']]);
    const keys = unpairConfirmMessages(p).lines.map((l) => [l.key, l.params]);
    expect(keys).toContainEqual(['videoOptions.script.unpair.keepsSingle', { name: 'earlier.funscript' }]);
    expect(keys).toContainEqual(['videoOptions.script.unpair.removesCustom', { count: 2 }]);
  });

  it('the multi-axis set that plays is removed by name in the confirm, never silently', () => {
    // Active: a multi-axis set you made; the single slot carries its main.
    const store = storeWith(buildAssociationEntry('multi', HAND, userMulti(), null));
    const p = plan(store);
    expect(p.removesHandMadeSet).toBe(true);
    expect(p.slots.map((s) => [s.slot, s.change])).toEqual([['single', 'remove'], ['multi', 'remove'], ['custom', 'empty']]);
    expect(unpairConfirmMessages(p).lines).toContainEqual({ key: 'videoOptions.script.unpair.removesMulti', params: { count: 2 } });
    runOps(p.ops, store);
    expect(assocOf(store)[V]).toBeUndefined();
  });

  it('a custom routing that plays: removed by name; the own script carried into single goes with it', () => {
    const store = storeWith(buildAssociationEntry('custom', OWN, null, userCustom()));
    const p = plan(store);
    expect(p.slots.map((s) => [s.slot, s.hand, s.change])).toEqual([
      ['single', false, 'remove'], ['multi', false, 'empty'], ['custom', true, 'remove'],
    ]);
    expect(unpairConfirmMessages(p).lines).toContainEqual({ key: 'videoOptions.script.unpair.removesCustom', params: { count: 2 } });
  });

  it('says what plays next: the video\'s own script, or none', () => {
    const own = planUnpair({ videoPath: V, ownScriptPath: OWN, association: HAND });
    expect(own.playsNext).toEqual({ kind: 'own', path: OWN, name: 'scene.funscript' });
    expect(unpairConfirmMessages(own).lines[1]).toEqual({ key: 'videoOptions.script.unpair.nextOwn', params: { name: 'scene.funscript' } });
    const none = planUnpair({ videoPath: V, ownScriptPath: null, association: HAND });
    expect(none.playsNext.kind).toBe('none');
    expect(unpairConfirmMessages(none).lines[1].key).toBe('videoOptions.script.unpair.nextNone');
    expect(unpairConfirmMessages(none).lines[0]).toEqual({ key: 'videoOptions.script.unpair.confirmQuestion', params: { name: 'hard.funscript' } });
  });

  it('a missing script file is display only: the plan is the same, and only the confirm runs it', () => {
    const view = scriptView({ videoPath: V, ownScriptPath: OWN, association: HAND, mainStatus: false });
    expect(view.status).toBe('missing');
    const offline = scriptView({ videoPath: V, ownScriptPath: OWN, association: HAND, mainStatus: null });
    expect(offline.status).toBe('unknown');
    expect(planUnpair({ videoPath: V, ownScriptPath: OWN, association: HAND, mainStatus: false }).ops)
      .toEqual(planUnpair({ videoPath: V, ownScriptPath: OWN, association: HAND }).ops);
  });
});

describe('Unpair Undo restores associations[path] exactly', () => {
  const shapes = {
    'legacy string': HAND,
    'single with nothing else': buildAssociationEntry('single', HAND, null, null),
    'single beside an auto multi-axis slot': buildAssociationEntry('single', HAND, autoMulti(), null),
    'single beside sets you saved': buildAssociationEntry('single', HAND, userMulti(), userCustom('D:\\c.funscript')),
    'multi-axis you made (mirrors)': buildAssociationEntry('multi', HAND, userMulti(), userCustom('D:\\c.funscript')),
    'custom routing (mirrors)': buildAssociationEntry('custom', OWN, userMulti(), userCustom()),
    'legacy custom': { mode: 'custom', routes: userCustom().routes },
    'legacy multi': { main: HAND, axes: { pitch: 'D:\\p.funscript' }, buttplugVib: true },
  };

  for (const [name, entry] of Object.entries(shapes)) {
    it(`${name}: JSON-equal after Unpair then Undo`, () => {
      const store = storeWith(entry);
      const before = json(assocOf(store)[V]);
      const p = plan(store);
      expect(p.offered).toBe(true);
      runOps(p.ops, store);
      expect(json(assocOf(store)[V])).not.toBe(before);
      const undo = planUnpairUndo(p, assocOf(store));
      expect(undo.ok).toBe(true);
      runOps(undo.ops, store);
      expect(json(assocOf(store)[V])).toBe(before);
      expect(json(assocOf(store)[OTHER_V])).toBe(json(OTHER_ENTRY));
    });
  }

  it('hands back the active config for the library\'s apply path, so the card shows the script again', () => {
    const store = storeWith(buildAssociationEntry('custom', OWN, null, userCustom()));
    const p = plan(store);
    runOps(p.ops, store);
    const undo = planUnpairUndo(p, assocOf(store));
    expect(undo.reapply).toEqual({ kind: 'custom', config: userCustom() });
    expect(undo.message).toEqual({ key: 'videoOptions.script.unpair.undone', params: { name: 'hard.funscript' } });
    runOps(undo.ops, store);
    const view = scriptView({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V] });
    expect(view.pairing.kind).toBe('custom');
    expect(view.main.path).toBe(HAND);
    expect(view.unpair.offered).toBe(true);
  });

  it('a pairing you made after the Unpair wins: Undo refuses and writes nothing', () => {
    const store = storeWith(buildAssociationEntry('single', HAND, null, null));
    const p = plan(store);
    runOps(p.ops, store);
    // Change… → another script, before pressing the old Undo.
    store.state.library.associations[V] = buildAssociationEntry('single', 'E:\\new.funscript', null, null);
    const now = json(store.state);
    const undo = planUnpairUndo(p, assocOf(store));
    expect(undo).toMatchObject({ ok: false, reason: 'changed', ops: [] });
    expect(undo.message.key).toBe('videoOptions.script.unpair.undoChanged');
    runOps(undo.ops, store);
    expect(json(store.state)).toBe(now);
  });

  it('FunSync re-pairing the own script since (auto multi-axis) does not block Undo', () => {
    const entry = buildAssociationEntry('single', HAND, null, null);
    const store = storeWith(entry);
    const p = plan(store);
    runOps(p.ops, store);
    store.state.library.associations[V] = buildAssociationEntry('multi', OWN, autoMulti(), null);
    const undo = planUnpairUndo(p, assocOf(store));
    expect(undo.ok).toBe(true);
    runOps(undo.ops, store);
    expect(json(assocOf(store)[V])).toBe(json(entry));
  });

  it('a kept multi-axis set overwritten by the auto-promote is still brought back by Undo', () => {
    const entry = buildAssociationEntry('single', HAND, userMulti(), userCustom('D:\\c.funscript'));
    const store = storeWith(entry);
    const p = plan(store);
    runOps(p.ops, store);
    // `_autoPromoteEligibleVideos` on an `active: null` entry keeps custom, replaces multi.
    const left = assocOf(store)[V];
    store.state.library.associations[V] = buildAssociationEntry('multi', OWN, autoMulti(), left.custom);
    expect(handMadeSlots(assocOf(store)[V], { ownScriptPath: OWN })).toEqual(['custom']);
    const undo = planUnpairUndo(p, assocOf(store));
    expect(undo.ok).toBe(true);
    runOps(undo.ops, store);
    expect(json(assocOf(store)[V])).toBe(json(entry));
  });
});

describe('Unpair and EroScripts tags', () => {
  const RECORD = {
    tags: ['pov', 'cosplay'], topicId: 1234, topicUrl: 'https://discuss.eroscripts.com/t/x/1234',
    source: 'eroscripts', savedAt: 1, scriptPath: HAND,
  };

  /** The tags the Tags section would show, from the store as it is. */
  function eroTags(store, ownScriptPath) {
    const view = scriptView({
      videoPath: V, ownScriptPath, association: assocOf(store)[V],
      scriptTagRecord: store.state.library.scriptTags[V],
    });
    const scriptPath = view.main?.path ?? null;
    const record = eroscriptsRecordForTags(store.state.library.scriptTags[V], scriptPath);
    const tags = effectiveTags(V, { eroscripts: { [V]: record } }, { scriptPath });
    return { state: view.eroscripts.state, tags: tags.filter((t) => t.sources.includes('eroscripts')) };
  }

  for (const [label, own] of [['the video has its own script', OWN], ['the video is left with no script', null]]) {
    it(`${label}: the old post's tags vanish after Unpair and come back on Undo, with no write to scriptTags`, () => {
      const store = storeWith(buildAssociationEntry('single', HAND, null, null), { scriptTags: { [V]: RECORD } });
      const tagsJson = json(store.state.library.scriptTags);

      const shown = eroTags(store, own);
      expect(shown.state).toBe('applies');
      expect(shown.tags.length).toBe(2);

      const p = planUnpair({ videoPath: V, ownScriptPath: own, association: assocOf(store)[V] });
      expect(p.ops.every((op) => op.key === 'library.associations')).toBe(true);
      runOps(p.ops, store);
      const gone = eroTags(store, own);
      expect(gone.state).toBe('another-script');
      expect(gone.tags).toEqual([]);

      runOps(planUnpairUndo(p, assocOf(store)).ops, store);
      const back = eroTags(store, own);
      expect(back.state).toBe('applies');
      expect(back.tags.length).toBe(2);

      expect(json(store.state.library.scriptTags)).toBe(tagsJson);
      expect(store.writes().filter((w) => w[1] === 'library.scriptTags')).toEqual([]);
    });
  }

  it('why the record filter exists: the tag merge alone shows the tags of a video with no script', () => {
    // effectiveTags takes a missing scriptPath as unknown.
    const tags = effectiveTags(V, { eroscripts: { [V]: RECORD } }, { scriptPath: null });
    expect(tags.some((t) => t.sources.includes('eroscripts'))).toBe(true);
    expect(eroscriptsRecordForTags(RECORD, null)).toBe(null);
  });
});

// fixup-ui (2026-11-18). Dave removed the pair dialog's ✕ (review-a RA-2): it
// deleted every slot with no confirm and no Undo. A Multi Axis set or Custom
// Routing you made must still be removable, with a confirm that names it and
// an exact Undo, also when its main script is the video's own (verify-1's
// first question: Unpair is not offered there, Dave's Round 1 answer 2).
describe('Remove a set you made (Saved pairings)', () => {
  const SAVED = 'E:\\Scripts\\saved.funscript';
  const NEWER = 'E:\\Scripts\\newer.funscript';
  const removal = (store, slot, input = {}) =>
    planRemoveSet({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V], ...input }, slot);

  it('the playing Multi Axis set over the own script: offered, removed with FunSync\'s carry-over, Undo exact', () => {
    // The scan back-fills single with the set's main (the own script here).
    const store = storeWith(buildAssociationEntry('multi', OWN, { ...userMulti(), main: OWN }, null));
    const before = json(assocOf(store)[V]);
    expect(planUnpair({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V] }).offered).toBe(false);
    const p = removal(store, 'multi');
    expect(p).toMatchObject({ offered: true, playing: true, deletesEntry: true, playsNext: { kind: 'own', name: 'scene.funscript' } });
    const words = removeSetConfirmMessages(p);
    expect(words.titleKey).toBe('videoOptions.script.removeSet.multiTitle');
    expect(words.lines).toEqual([
      { key: 'videoOptions.script.removeSet.multiQuestion', params: { count: 2 } },
      { key: 'videoOptions.script.unpair.nextOwn', params: { name: 'scene.funscript' } },
    ]);
    runOps(p.ops, store);
    expect(Object.prototype.hasOwnProperty.call(assocOf(store), V)).toBe(false);
    expect(json(assocOf(store)[OTHER_V])).toBe(json(OTHER_ENTRY));
    const undo = planRemoveSetUndo(p, assocOf(store));
    expect(undo).toMatchObject({ ok: true, reapply: { kind: 'multi' }, message: { key: 'videoOptions.script.removeSet.multiUndone' } });
    runOps(undo.ops, store);
    expect(json(assocOf(store)[V])).toBe(before);
  });

  it('a Custom Routing you saved beside the playing single: only that slot goes, what plays does not change', () => {
    const store = storeWith(buildAssociationEntry('single', HAND, null, userCustom(SAVED)));
    const before = json(assocOf(store)[V]);
    const p = removal(store, 'custom');
    expect(p).toMatchObject({ offered: true, playing: false, deletesEntry: false, playsNext: { kind: 'same' } });
    expect(removeSetConfirmMessages(p).lines.map((l) => l.key)).toEqual([
      'videoOptions.script.removeSet.customQuestion', 'videoOptions.script.removeSet.playsSame',
    ]);
    runOps(p.ops, store);
    expect(assocOf(store)[V]).toEqual(buildAssociationEntry('single', HAND, null, null));
    const undo = planRemoveSetUndo(p, assocOf(store));
    runOps(undo.ops, store);
    expect(json(assocOf(store)[V])).toBe(before);
  });

  it('a set kept by an Unpair (entry left with active: null) can be removed: the empty entry goes', () => {
    const store = storeWith(buildAssociationEntry(null, null, userMulti(), null));
    const p = removal(store, 'multi');
    expect(p).toMatchObject({ offered: true, playing: false, deletesEntry: true });
    runOps(p.ops, store);
    expect(Object.prototype.hasOwnProperty.call(assocOf(store), V)).toBe(false);
  });

  it('the playing Custom Routing over the own script keeps a single script you saved, and says so', () => {
    const store = storeWith(buildAssociationEntry('custom', HAND, null, userCustom(OWN)));
    const p = removal(store, 'custom');
    expect(p.offered).toBe(true);
    expect(removeSetConfirmMessages(p).lines).toContainEqual(
      { key: 'videoOptions.script.unpair.keepsSingle', params: { name: 'hard.funscript' } });
    runOps(p.ops, store);
    expect(assocOf(store)[V]).toEqual(buildAssociationEntry(null, HAND, null, null));
  });

  it('not offered where Unpair already covers it, for FunSync\'s own set, or for an empty slot', () => {
    const playingHand = storeWith(buildAssociationEntry('multi', HAND, userMulti(), null));
    expect(removal(playingHand, 'multi').offered).toBe(false);          // Unpair funscript names and removes it
    const auto = storeWith(buildAssociationEntry('multi', OWN, autoMulti(), null));
    expect(removal(auto, 'multi').offered).toBe(false);                 // not yours
    const single = storeWith(buildAssociationEntry('single', HAND, null, null));
    expect(removal(single, 'custom').offered).toBe(false);
    expect(removal(single, 'single').offered).toBe(false);              // the playing single is Unpair's
    expect(removal(single, 'multi').ops).toEqual([]);
  });

  it('a pairing you made after the removal wins: Undo refuses and writes nothing', () => {
    const store = storeWith(buildAssociationEntry('multi', OWN, { ...userMulti(), main: OWN }, null));
    const p = removal(store, 'multi');
    runOps(p.ops, store);
    store.state.library.associations[V] = buildAssociationEntry('single', NEWER, null, null);
    const now = json(store.state);
    const undo = planRemoveSetUndo(p, assocOf(store));
    expect(undo).toMatchObject({ ok: false, reason: 'changed', ops: [] });
    expect(json(store.state)).toBe(now);
  });
});

// fixup-ui follow-up (2026-11-18, Dave: "Yes, add Remove"): a single script
// you saved by hand gets a Remove too. It differs from Unpair: Unpair removes
// the pairing that PLAYS (and FunSync's leftovers) and the video then plays
// its own script or none; Remove on the single slot takes out only a single
// script you saved that does NOT play, so what plays does not change.
describe('Remove on a single script you saved (Dave: "Yes, add Remove")', () => {
  const SAVED = 'E:\\Scripts\\saved.funscript';
  const removal = (store, slot) =>
    planRemoveSet({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V] }, slot);

  it('a saved single beside the playing Custom Routing: only it goes, what plays does not change, Undo exact', () => {
    const store = storeWith(buildAssociationEntry('custom', SAVED, null, userCustom()));
    const before = json(assocOf(store)[V]);
    const p = removal(store, 'single');
    expect(p).toMatchObject({ offered: true, playing: false, deletesEntry: false, playsNext: { kind: 'same' } });
    const words = removeSetConfirmMessages(p);
    expect(words.titleKey).toBe('videoOptions.script.removeSet.singleTitle');
    expect(words.lines).toEqual([
      { key: 'videoOptions.script.removeSet.singleQuestion', params: { name: 'saved.funscript' } },
      { key: 'videoOptions.script.removeSet.playsSame', params: {} },
    ]);
    expect(words.doneMessage).toEqual({ key: 'videoOptions.script.removeSet.singleDone', params: { name: 'saved.funscript' } });
    runOps(p.ops, store);
    expect(assocOf(store)[V]).toEqual(buildAssociationEntry('custom', null, null, userCustom()));
    const undo = planRemoveSetUndo(p, assocOf(store));
    expect(undo.message).toEqual({ key: 'videoOptions.script.removeSet.singleUndone', params: { name: 'saved.funscript' } });
    runOps(undo.ops, store);
    expect(json(assocOf(store)[V])).toBe(before);
  });

  it('not offered for the single that plays (that is Unpair), the video\'s own script, or a set\'s carry-over', () => {
    expect(removal(storeWith(buildAssociationEntry('single', HAND, null, null)), 'single').offered).toBe(false);
    expect(removal(storeWith(buildAssociationEntry('single', OWN, null, null)), 'single').offered).toBe(false);
    expect(removal(storeWith(buildAssociationEntry('multi', HAND, userMulti(), null)), 'single').offered).toBe(false);
    expect(removal(storeWith(buildAssociationEntry('custom', OWN, null, userCustom())), 'single').offered).toBe(false);
  });

  it('Remove then Unpair: undone in turn they give back the first entry exactly; out of turn the older Undo refuses', () => {
    const E0 = buildAssociationEntry('custom', SAVED, null, userCustom());
    const run = () => {
      const store = storeWith(E0);
      const a = removal(store, 'single');
      runOps(a.ops, store);
      const b = planUnpair({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V] });
      expect(b.offered).toBe(true);
      runOps(b.ops, store);
      expect(Object.prototype.hasOwnProperty.call(assocOf(store), V)).toBe(false);   // nothing left to keep
      return { store, a, b };
    };
    // In turn: the Unpair's Undo, then the Remove's.
    let { store, a, b } = run();
    runOps(planUnpairUndo(b, assocOf(store)).ops, store);
    const ua = planRemoveSetUndo(a, assocOf(store));
    expect(ua.ok).toBe(true);
    runOps(ua.ops, store);
    expect(json(assocOf(store)[V])).toBe(json(E0));
    // Out of turn (an older Undo still in a toast): the entry the Remove left
    // was removed by the Unpair since, so its Undo refuses and writes nothing;
    // the Unpair's Undo still works.
    ({ store, a, b } = run());
    const now = json(store.state);
    const early = planRemoveSetUndo(a, assocOf(store));
    expect(early).toMatchObject({ ok: false, reason: 'changed', ops: [] });
    expect(json(store.state)).toBe(now);
    const ub = planUnpairUndo(b, assocOf(store));
    expect(ub.ok).toBe(true);
    runOps(ub.ops, store);
    expect(assocOf(store)[V]).toEqual(buildAssociationEntry('custom', null, null, userCustom()));
  });
});

// fixup-ui (2026-11-18), verify-1 "Phantom saved single script": a library
// refresh back-fills an empty single slot with the playing set's main script
// (library.js `_applyManualAssociations`). That copy is not a pairing you
// saved: the Script section does not list it, the confirm does not name it.
// Display only: `hand` (and every plan built on it) is unchanged.
describe('a back-filled single slot is the set\'s carry-over, not a pairing of its own', () => {
  const MAIN = 'E:\\Scripts\\main.funscript';

  it('marked carryOver when it repeats a set\'s main and does not play; hand is unchanged', () => {
    const backFilled = buildAssociationEntry('multi', HAND, userMulti(), null);
    const single = associationSlots(backFilled, { ownScriptPath: OWN })[0];
    expect(single).toMatchObject({ slot: 'single', held: true, hand: true, carryOver: true });
    expect(associationSlots(buildAssociationEntry('custom', HAND, null, userCustom()), { ownScriptPath: OWN })[0].carryOver).toBe(true);
    // Its own pairing: it plays, or it is another script.
    expect(associationSlots(buildAssociationEntry('single', HAND, userMulti(), null))[0].carryOver).toBe(false);
    expect(associationSlots(buildAssociationEntry('custom', MAIN, null, userCustom()))[0].carryOver).toBe(false);
    expect(handMadeSlots(backFilled, { ownScriptPath: OWN })).toEqual(['single', 'multi']);
  });

  it('the Unpair confirm does not name it as a script you saved', () => {
    const entry = buildAssociationEntry('custom', MAIN, { ...userMulti(), main: MAIN }, userCustom());
    const p = planUnpair({ videoPath: V, ownScriptPath: OWN, association: entry });
    const keys = unpairConfirmMessages(p).lines.map((l) => l.key);
    expect(keys).toContain('videoOptions.script.unpair.keepsMulti');
    expect(keys).not.toContain('videoOptions.script.unpair.keepsSingle');
    // The data is untouched: the copy is kept with the set, as before.
    expect(p.next.single).toBe(MAIN);
  });
});

// followUp3 (Dave, 2026-11-18: "Script not found" opens the file explorer
// "to where the path says it should be" and lets you pick a new path): the
// picked file replaces only that path, every other field kept, exact Undo.
describe('Locate a script that is not found (the data side)', () => {
  const NEW = 'E:\\Found\\moved.funscript';
  const locate = (store, to = NEW) => planLocateMain({ videoPath: V, ownScriptPath: OWN, association: assocOf(store)[V] }, to);

  it('a single pairing: only `single` changes; Undo writes the entry back JSON-equal', () => {
    const entry = buildAssociationEntry('single', HAND, userMulti(), userCustom('E:\\c.funscript'));
    const store = storeWith(entry);
    const before = json(assocOf(store)[V]);
    const p = locate(store);
    expect(p).toMatchObject({ offered: true, slot: 'single', name: 'hard.funscript', newName: 'moved.funscript', reapply: { kind: 'single', config: NEW } });
    runOps(p.ops, store);
    expect(assocOf(store)[V]).toEqual({ ...JSON.parse(before), single: NEW });
    expect(json(assocOf(store)[OTHER_V])).toBe(json(OTHER_ENTRY));
    const undo = planLocateUndo(p, assocOf(store));
    expect(undo).toMatchObject({ ok: true, reapply: { kind: 'single', config: HAND }, message: { key: 'videoOptions.script.locate.undone', params: { name: 'hard.funscript' } } });
    runOps(undo.ops, store);
    expect(json(assocOf(store)[V])).toBe(before);
  });

  it('a Multi Axis set: its main and the mirror; the axes, the single slot and the rest are kept', () => {
    const store = storeWith(buildAssociationEntry('multi', HAND, userMulti(), null));
    const p = locate(store);
    runOps(p.ops, store);
    const now = assocOf(store)[V];
    expect(now.multi).toEqual({ ...userMulti(), main: NEW });
    expect(now.main).toBe(NEW);                            // the mirror follows
    expect(now.axes).toEqual(userMulti().axes);
    expect(now.single).toBe(HAND);                         // the carry-over is another slot: kept
    expect(p.reapply).toEqual({ kind: 'multi', config: { ...userMulti(), main: NEW } });
  });

  it('a Custom Routing: the main route (its name follows its file), not the other routes', () => {
    const custom = { routes: [
      { role: 'main', scriptPath: HAND, scriptName: 'hard.funscript', deviceId: 'handy' },
      { role: 'axis', scriptPath: 'E:\\vib.funscript', scriptName: 'vib.funscript', deviceId: 'bp' },
    ] };
    const store = storeWith(buildAssociationEntry('custom', null, null, custom));
    runOps(locate(store).ops, store);
    const now = assocOf(store)[V];
    expect(now.custom.routes[0]).toEqual({ role: 'main', scriptPath: NEW, scriptName: 'moved.funscript', deviceId: 'handy' });
    expect(now.custom.routes[1]).toEqual(custom.routes[1]);
    expect(now.routes[0].scriptPath).toBe(NEW);            // the mirror follows
  });

  it('the oldest shape (a bare string) becomes the new path', () => {
    const store = storeWith(HAND);
    runOps(locate(store).ops, store);
    expect(assocOf(store)[V]).toBe(NEW);
  });

  it('not offered for a pairing by file name (nothing stored), nor for the same file', () => {
    expect(canLocateMain({ videoPath: V, association: undefined, funscriptPath: OWN })).toBe(false);
    expect(planLocateMain({ videoPath: V, association: undefined, funscriptPath: OWN }, NEW).offered).toBe(false);
    const store = storeWith(buildAssociationEntry('single', HAND, null, null));
    expect(locate(store, HAND).offered).toBe(false);
    expect(locate(store, 'd:/Scripts/hard.funscript').offered).toBe(false);   // same file, other spelling
  });

  it('Undo refuses (writes nothing) when the pairing changed since', () => {
    const store = storeWith(buildAssociationEntry('single', HAND, null, null));
    const p = locate(store);
    runOps(p.ops, store);
    store.state.library.associations[V] = buildAssociationEntry('single', 'E:\\newer.funscript', null, null);
    const now = json(store.state);
    const undo = planLocateUndo(p, assocOf(store));
    expect(undo).toMatchObject({ ok: false, reason: 'changed', ops: [], message: { key: 'videoOptions.live.undoChanged' } });
    expect(json(store.state)).toBe(now);
  });

  it('a variation you added: its path (and its file name) change, its label and the others stay; Undo exact', () => {
    const GONE = 'E:\\Old\\scene.soft.funscript';
    const variants = { [V]: [
      { label: 'Soft', path: GONE, name: 'scene.soft.funscript' },
      { label: 'Hard', path: 'E:\\Old\\scene.hard.funscript', name: 'scene.hard.funscript' },
    ] };
    const store = makeFakeStore({ library: { manualVariants: structuredClone(variants) } });
    const p = planLocateVariation({ videoPath: V, manualVariants: store.state.library.manualVariants, from: GONE, to: NEW });
    expect(p).toMatchObject({ offered: true, what: 'variation', name: 'scene.soft.funscript', newName: 'moved.funscript' });
    runOps(p.ops, store);
    expect(store.state.library.manualVariants[V]).toEqual([
      { label: 'Soft', path: NEW, name: 'moved.funscript' },
      variants[V][1],
    ]);
    const undo = planLocateUndo(p, store.state.library.manualVariants);
    expect(undo.ok).toBe(true);
    runOps(undo.ops, store);
    expect(store.state.library.manualVariants).toEqual(variants);
    expect(planLocateVariation({ videoPath: V, manualVariants: variants, from: 'E:\\none.funscript', to: NEW }).offered).toBe(false);
  });
});
