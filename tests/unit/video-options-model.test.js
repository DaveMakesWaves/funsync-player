/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The video options dialog's view models (DESIGN-video-options.md (b), (d)):
// what each section shows for one video, and the small plans with an exact
// Undo (Remove a variation, Reset progress, Reset thumbnail, the VR radios,
// Unpair subtitle). Unpair funscript and the Organise ticks have their own
// files: video-options-unpair.test.js, video-options-organise-undo.test.js.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  SECTIONS, organiseView, scriptView, associationSlots, handMadeSlots, eroscriptsRecordState,
  variationsView, planRemoveVariation, planPlayFirst, progressView, planResetProgress, planResetThumbnail,
  vrView, planSetVRMode, planUnpairSubtitle, fileView, runOps, planEntryChange, planEntryUndo,
} from '../../renderer/js/video-options-model.js';
import { buildAssociationEntry } from '../../renderer/js/association-shape.js';
import { makeFakeStore } from './helpers/video-options-fake-store.js';

const V = 'C:\\Videos\\scene.mp4';
const OWN = 'C:\\Videos\\scene.funscript';
const HAND = 'D:\\Scripts\\hard.funscript';

describe('the module stays pure', () => {
  it('imports only pure renderer/js modules and touches no DOM, IPC or store', () => {
    const src = fs.readFileSync('renderer/js/video-options-model.js', 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.every((p) => /^\.\/[a-z-]+\.js$/.test(p))).toBe(true);
    expect(src).not.toMatch(/\b(document|window|funsync|localStorage|dataService)\./);
  });

  it('has the rail in design order', () => {
    expect(SECTIONS).toEqual(['organise', 'tags', 'script', 'subtitles', 'playback', 'thumbnail', 'vr', 'file']);
  });
});

describe('Organise view', () => {
  it('ticks the playlists and categories that hold the video, with counts', () => {
    const view = organiseView({
      videoPath: V,
      playlists: [{ id: 'p1', name: 'Morning', videoPaths: ['a', V] }, { id: 'p2', name: 'Long', videoPaths: ['a'] }],
      categories: [{ id: 'c1', name: 'A', color: '#f00' }, { id: 'c2', name: 'B', color: '#0f0', icon: 'emoji:🔥' }],
      categoryIds: ['c2'],
      collections: [{ id: 'g', name: 'Gym', videoPaths: [V] }, { id: 'h', name: 'Archive', videoPaths: [] }],
    });
    expect(view.playlists).toEqual([
      { id: 'p1', name: 'Morning', checked: true, index: 1 },
      { id: 'p2', name: 'Long', checked: false, index: -1 },
    ]);
    expect(view.categories.map((c) => [c.id, c.checked, c.icon])).toEqual([['c1', false, null], ['c2', true, 'emoji:🔥']]);
    expect(view.collections.map((c) => [c.id, c.checked, c.synced])).toEqual([['g', true, false], ['h', false, false]]);
    expect(view.counts).toEqual({ playlists: 1, categories: 1, collections: 1 });
  });

  it('missing lists give empty sections, never a throw', () => {
    expect(organiseView({ videoPath: V })).toEqual({
      playlists: [], categories: [], collections: [], counts: { playlists: 0, categories: 0, collections: 0 },
    });
  });
});

describe('Script view: how the script is paired', () => {
  const view = (input) => scriptView({ videoPath: V, ...input });

  it('names every pairing kind', () => {
    expect(view({}).pairing.kind).toBe('none');
    expect(view({ funscriptPath: OWN }).pairing).toMatchObject({ kind: 'by-name', hand: false });
    expect(view({ funscriptPath: 'C:\\Videos\\Round 1.funscript', folderVariantMain: true }).pairing.kind).toBe('folder');
    expect(view({ association: HAND, ownScriptPath: OWN }).pairing).toMatchObject({ kind: 'single', hand: true });
    expect(view({ association: buildAssociationEntry('multi', OWN, { main: OWN, axes: { roll: 'r' }, autoAssigned: true }, null) }).pairing)
      .toMatchObject({ kind: 'auto-multi', hand: false });
    expect(view({ association: buildAssociationEntry('multi', HAND, { main: HAND, axes: { roll: 'r', pitch: 'p' } }, null) }).mode)
      .toEqual({ kind: 'multi', axisCount: 2, routeCount: 0 });
    const custom = view({ association: buildAssociationEntry('custom', null, null, { routes: [{ role: 'main', scriptPath: HAND }, { role: 'axis', scriptPath: 'v' }] }) });
    expect(custom.pairing.kind).toBe('custom');
    expect(custom.mode).toEqual({ kind: 'custom', axisCount: 0, routeCount: 2 });
    expect(custom.pairing.labelKey).toBe('videoOptions.script.pairing.custom');
    // Locale keys are camelCase, the kinds are not.
    expect(view({ funscriptPath: OWN }).pairing.labelKey).toBe('videoOptions.script.pairing.byName');
    expect(view({ association: buildAssociationEntry('multi', OWN, { main: OWN, axes: { roll: 'r' }, autoAssigned: true }, null) }).pairing.labelKey)
      .toBe('videoOptions.script.pairing.autoMulti');
  });

  it('a slot that cannot play (custom with no main script) is not the pairing', () => {
    const v = view({ funscriptPath: OWN, association: buildAssociationEntry('custom', null, null, { routes: [{ role: 'axis', scriptPath: 'x' }] }) });
    expect(v.pairing.kind).toBe('by-name');
    expect(v.unpair.offered).toBe(false);
  });

  it('status is tri-state and shows "not found" only on proven absence', () => {
    expect(view({ association: HAND }).status).toBe(null); // not checked
    expect(view({ association: HAND, mainStatus: true })).toMatchObject({ status: 'present', statusKey: null });
    expect(view({ association: HAND, mainStatus: false })).toMatchObject({ status: 'missing', statusKey: 'videoOptions.script.status.missing' });
    expect(view({ association: HAND, mainStatus: null })).toMatchObject({ status: 'unknown', statusKey: 'videoOptions.script.status.unknown' });
    expect(view({ mainStatus: false }).status).toBe(null); // no script, nothing to report
  });

  it('notes a fallback to the own script while yours cannot be read', () => {
    expect(view({ association: HAND, ownScriptPath: OWN, funscriptPath: OWN, fallbackFrom: HAND }).fallback)
      .toEqual({ from: HAND, playing: OWN });
  });
});

describe('association slots: what each holds and who made it', () => {
  it('the own script carried into single beside a set is FunSync\'s; another script there is yours', () => {
    const carried = associationSlots(buildAssociationEntry('custom', OWN, null, { routes: [{ role: 'main', scriptPath: HAND }] }), { ownScriptPath: OWN });
    expect(carried.map((s) => [s.slot, s.held, s.hand, s.active])).toEqual([
      ['single', true, false, false], ['multi', false, false, false], ['custom', true, true, true],
    ]);
    const saved = associationSlots(buildAssociationEntry('custom', 'E:\\old.funscript', null, { routes: [{ role: 'main', scriptPath: HAND }] }), { ownScriptPath: OWN });
    expect(saved[0].hand).toBe(true);
  });

  it('an auto-paired multi slot and its single carry-over are not yours', () => {
    const auto = buildAssociationEntry('multi', OWN, { main: OWN, axes: { roll: 'r' }, autoAssigned: true }, null);
    expect(handMadeSlots(auto)).toEqual([]);
    expect(associationSlots(auto)[1]).toMatchObject({ held: true, hand: false, auto: true, axisCount: 1 });
  });

  it('every legacy shape is read; nothing gives no slots', () => {
    expect(handMadeSlots(HAND)).toEqual(['single']);
    expect(handMadeSlots({ mode: 'custom', routes: [{ role: 'main', scriptPath: HAND }] })).toEqual(['custom']);
    expect(handMadeSlots({ main: HAND, axes: {} })).toEqual(['multi']);
    expect(handMadeSlots(undefined)).toEqual([]);
    expect(associationSlots(null).every((s) => !s.held && !s.active)).toBe(true);
  });
});

describe('EroScripts record state', () => {
  const rec = { tags: ['pov'], topicId: 1, scriptPath: HAND };
  it('applies, another script, unknown, none', () => {
    expect(eroscriptsRecordState(rec, HAND)).toBe('applies');
    expect(eroscriptsRecordState(rec, 'd:/scripts/HARD.funscript')).toBe('applies');
    expect(eroscriptsRecordState(rec, OWN)).toBe('another-script');
    expect(eroscriptsRecordState(rec, null)).toBe('another-script');
    expect(eroscriptsRecordState({ tags: ['pov'], topicId: 1 }, OWN)).toBe('unknown'); // a record from before v2
    expect(eroscriptsRecordState(undefined, OWN)).toBe('none');
  });
  it('is part of the script view', () => {
    expect(scriptView({ videoPath: V, association: HAND, scriptTagRecord: rec }).eroscripts.state).toBe('applies');
  });
});

describe('Variations', () => {
  const video = {
    path: V,
    funscriptPath: OWN,
    variants: [
      { label: 'Default', path: OWN, name: 'scene.funscript' },
      { label: 'Soft', path: 'C:\\Videos\\scene (Soft).funscript', name: 'scene (Soft).funscript' },
    ],
  };
  const manual = [{ label: 'Hard', path: HAND, name: 'hard.funscript' }];

  it('lists the folder\'s and yours, marks the main one and which plays first', () => {
    const view = variationsView({ video, manual });
    expect(view.items.map((v) => [v.text, v.source, v.main, v.removable, v.playFirst])).toEqual([
      ['scene', 'folder', true, false, true],
      ['Soft', 'folder', false, false, false],
      ['Hard', 'added', false, true, false],
    ]);
    expect(view.pinnedLabel).toBe(null);
  });

  it('a pinned label plays first; random on play overrides it', () => {
    const view = variationsView({ video, manual, preferredLabel: 'Hard', randomOn: true });
    expect(view.playFirst).toBe(2);
    expect(view.items[2]).toMatchObject({ pinned: true, playFirst: true });
    expect(view.randomOverridesPin).toBe(true);
    expect(variationsView({ video, manual, preferredLabel: 'Gone' })).toMatchObject({ pinFound: false, playFirst: 0 });
  });

  it('a video with no scan list but hand-added ones leads with its own script', () => {
    const view = variationsView({ video: { path: V, funscriptPath: OWN, variants: [] }, manual });
    expect(view.items.map((v) => [v.name, v.source, v.removable])).toEqual([
      ['scene.funscript', 'folder', false], ['hard.funscript', 'added', true],
    ]);
  });

  it('Remove takes it out of manualVariants; Undo restores the exact array', () => {
    const list = [manual[0], { label: 'X', path: 'E:\\x.funscript', name: 'x.funscript' }];
    const store = makeFakeStore({ library: { manualVariants: { [V]: list, other: [] } } });
    const mv = () => store.state.library.manualVariants;
    const before = JSON.stringify(mv());
    const plan = planRemoveVariation({ videoPath: V, manualVariants: mv(), path: HAND });
    runOps(plan.ops, store);
    expect(mv()[V]).toEqual([list[1]]);
    runOps(planEntryUndo(plan, mv()).ops, store);
    expect(JSON.stringify(mv())).toBe(before);
  });

  it('removing the last one drops the key, and Undo brings it back', () => {
    const store = makeFakeStore({ library: { manualVariants: { [V]: manual } } });
    const mv = () => store.state.library.manualVariants;
    const plan = planRemoveVariation({ videoPath: V, manualVariants: mv(), path: HAND });
    runOps(plan.ops, store);
    expect(V in mv()).toBe(false);
    runOps(planEntryUndo(plan, mv()).ops, store);
    expect(mv()[V]).toEqual(manual);
    expect(planRemoveVariation({ videoPath: V, manualVariants: mv(), path: 'nope' })).toMatchObject({ changed: false, ops: [] });
  });

  it('Play first pins a label; clearing it deletes the entry', () => {
    expect(planPlayFirst({ videoPath: V, preferredVariants: {}, label: 'Soft' }).ops)
      .toEqual([{ op: 'setEntry', key: 'library.preferredVariants', path: V, value: 'Soft' }]);
    expect(planPlayFirst({ videoPath: V, preferredVariants: { [V]: 'Soft' }, label: null }).ops)
      .toEqual([{ op: 'deleteEntry', key: 'library.preferredVariants', path: V }]);
  });
});

describe('Playback progress', () => {
  it('in progress, watched, not started', () => {
    expect(progressView({ entry: { position: 760, duration: 2052, updatedAt: 1 } })).toMatchObject({
      state: 'in-progress', percent: 37, positionText: '12:40', durationText: '34:12', canReset: true,
    });
    expect(progressView({ entry: { duration: 2052, updatedAt: 1, finished: true } })).toEqual({ state: 'watched', canReset: true });
    expect(progressView({})).toEqual({ state: 'not-started', canReset: false });
  });

  it('Reset progress drops the entry; Undo restores the exact entry', () => {
    const entry = { position: 760.4, duration: 2052.1, updatedAt: 1731900000000 };
    const store = makeFakeStore({ library: { resumePositions: { [V]: entry, other: { finished: true } } } });
    const rp = () => store.state.library.resumePositions;
    const before = JSON.parse(JSON.stringify(rp()));
    const plan = planResetProgress({ videoPath: V, resumePositions: rp() });
    runOps(plan.ops, store);
    expect(V in rp()).toBe(false);
    runOps(planEntryUndo(plan, rp()).ops, store);
    // The entry byte for byte; the map by value (its key order means nothing).
    expect(JSON.stringify(rp()[V])).toBe(JSON.stringify(entry));
    expect(rp()).toEqual(before);
  });

  it('a new position written since (the video was played) is not overwritten by the Undo', () => {
    const plan = planResetProgress({ videoPath: V, resumePositions: { [V]: { position: 10, duration: 100 } } });
    const undo = planEntryUndo(plan, { [V]: { position: 50, duration: 100 } });
    expect(undo).toEqual({ ok: false, reason: 'changed', ops: [] });
  });
});

describe('Thumbnail and subtitles', () => {
  it('Reset thumbnail drops only the map entry; Undo puts it back', () => {
    const map = { [V]: 'custom-thumbs/abc.jpg' };
    const plan = planResetThumbnail({ videoPath: V, customThumbnails: map });
    expect(plan.ops).toEqual([{ op: 'deleteEntry', key: 'library.customThumbnails', path: V }]);
    expect(planEntryUndo(plan, {}).ops).toEqual([{ op: 'setEntry', key: 'library.customThumbnails', path: V, value: 'custom-thumbs/abc.jpg' }]);
    expect(planResetThumbnail({ videoPath: V, customThumbnails: {} })).toMatchObject({ changed: false, ops: [] });
  });

  it('Unpair subtitle is offered for a subtitle you chose, with an exact Undo', () => {
    const store = makeFakeStore({ library: { subtitleAssociations: { [V]: 'D:\\Subs\\scene.en.srt' } } });
    const sa = () => store.state.library.subtitleAssociations;
    const plan = planUnpairSubtitle({ videoPath: V, subtitleAssociations: sa() });
    expect(plan).toMatchObject({ offered: true, name: 'scene.en.srt' });
    runOps(plan.ops, store);
    expect(sa()).toEqual({});
    runOps(planEntryUndo(plan, sa()).ops, store);
    expect(sa()).toEqual({ [V]: 'D:\\Subs\\scene.en.srt' });
    expect(planUnpairSubtitle({ videoPath: V, subtitleAssociations: {} }).offered).toBe(false);
  });
});

describe('VR', () => {
  it('Automatic says what detection decided; VR and Flat override it', () => {
    expect(vrView({ videoPath: 'C:\\VR\\scene_180_LR.mp4' })).toMatchObject({ mode: 'auto', detected: true, isVR: true, format: null });
    expect(vrView({ videoPath: V })).toMatchObject({ mode: 'auto', detected: false, isVR: false });
    expect(vrView({ videoPath: V, manualVRType: { [V]: 'vr' } })).toMatchObject({ mode: 'vr', isVR: true });
    expect(vrView({ videoPath: V, manualVRType: { [V]: 'flat' }, detect: () => true })).toMatchObject({ mode: 'flat', detected: true, isVR: false });
    expect(vrView({ videoPath: V, vrFormat: { [V]: { projection: 'sbs-half', eye: 'right', zoom: 1.2 } } }).format)
      .toEqual({ projection: 'sbs-half', eye: 'right', zoom: 1.2 });
  });

  it('picking Automatic deletes the override; Undo restores it exactly', () => {
    const store = makeFakeStore({ library: { manualVRType: { [V]: 'vr' } } });
    const vr = () => store.state.library.manualVRType;
    const plan = planSetVRMode({ videoPath: V, manualVRType: vr(), mode: 'auto' });
    runOps(plan.ops, store);
    expect(vr()).toEqual({});
    runOps(planEntryUndo(plan, vr()).ops, store);
    expect(vr()).toEqual({ [V]: 'vr' });
    expect(planSetVRMode({ videoPath: V, manualVRType: vr(), mode: 'vr' }).changed).toBe(false);
  });
});

describe('File', () => {
  it('path, name, folder, size', () => {
    expect(fileView({ path: 'C:\\Videos\\Sub\\scene.mp4', size: 1234 })).toEqual({
      path: 'C:\\Videos\\Sub\\scene.mp4', name: 'scene.mp4', folder: 'C:\\Videos\\Sub', size: 1234, source: null,
    });
    expect(fileView({}).size).toBe(null);
  });
});

describe('runOps', () => {
  it('several entry ops on one key are one write, on a copy of the map', () => {
    const store = makeFakeStore({ library: { resumePositions: { a: 1, b: 2 } } });
    const original = store.state.library.resumePositions;
    runOps([
      { op: 'deleteEntry', key: 'library.resumePositions', path: 'a' },
      { op: 'setEntry', key: 'library.resumePositions', path: 'c', value: { x: 1 } },
    ], store);
    expect(store.writes()).toEqual([['set', 'library.resumePositions']]);
    expect(store.state.library.resumePositions).toEqual({ b: 2, c: { x: 1 } });
    expect(original).toEqual({ a: 1, b: 2 });
  });

  it('a damaged map (not an object) is left alone: nothing is written', () => {
    const store = makeFakeStore({ library: { associations: ['oops'] } });
    const res = runOps([{ op: 'deleteEntry', key: 'library.associations', path: V }], store);
    expect(res).toEqual({ applied: 0, skipped: 1 });
    expect(store.writes()).toEqual([]);
    expect(store.state.library.associations).toEqual(['oops']);
  });

  it('an absent map is created for a set', () => {
    const store = makeFakeStore({});
    runOps(planEntryChange({ key: 'library.manualVRType', map: undefined, path: V, next: 'flat' }).ops, store);
    expect(store.state.library.manualVRType).toEqual({ [V]: 'flat' });
  });

  it('an unknown op throws rather than doing something else', () => {
    expect(() => runOps([{ op: 'rm -rf' }], makeFakeStore({}))).toThrow(/unknown op/);
  });
});
