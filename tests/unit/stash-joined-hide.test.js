/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A hide made on a JOINED chip outlives the join (Stash fix-up 2026-11-19,
// s1-review-a RA-S1-2), and "Hidden on this video" names Stash people the way
// the chips do (RA-S1-5). DESIGN-stash-s1.md (a) 10 (Turn off: "your own tags
// and hides are never touched"), (f) ("the hide outlives every re-sync"),
// (c) "Performers and studios split by Stash ID".
//
// The chip: the script says "Jane Doe" and the linked Stash scene has the one
// Jane Doe (Stash ID AAAA-3F2A), so the two are ONE chip,
// `performer:jane-doe#aaaa-3f2a`. Removing it hides that key AND the bare
// name, so the script's "Jane Doe" stays hidden when the join breaks:
//   1. Stash turned off;  2. Stash data removed;  3. a sync brings a second
//   Jane Doe. Undo puts the hidden list back exactly; Show again lifts both.
// Real video-tags.js, video-tag-edits.js, stash-tags.js.
import { describe, it, expect } from 'vitest';
import { effectiveTags, compileTagRules, withNameIds } from '../../renderer/js/video-tags.js';
import { planRemoveTag, planShowAgain, planUndo, hiddenOnVideo } from '../../renderer/js/video-tag-edits.js';
import { stashTagRecords, nameIdentities } from '../../renderer/js/stash-tags.js';

const VIDEO = 'C:/Lib/Clip.mp4';
const SCRIPT = 'C:/Lib/Clip.funscript';
const SERVER = 'http://127.0.0.1:9999';
const BOX = 'https://stash-box.invalid/graphql';
const KEY_A = 'performer:jane-doe#aaaa-3f2a';
const KEY_B = 'performer:jane-doe#bbbb-9c1d';
const BARE = 'performer:jane-doe';

function stashFile({ secondJane = false, secondOnThisVideo = false, removed = false } = {}) {
  if (removed) {
    return { v: 1, rev: 9, server: null, lastSync: null, links: {}, check: {}, refused: {}, scenes: {}, performers: {}, studios: {}, tags: {} };
  }
  return {
    v: 1, rev: 1, server: { url: SERVER, version: 'v0.32.0' }, lastSync: { at: 1 },
    links: { [VIDEO]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, oshash: 'aaaa' }, linkedAt: 1, state: 'ok' } },
    check: {}, refused: {},
    scenes: {
      1: { id: '1', title: 'S1', performerIds: secondOnThisVideo ? ['p1', 'p2'] : ['p1'], tagIds: ['t1'], markers: [], files: [], server: SERVER },
      ...(secondJane ? { 2: { id: '2', title: 'S2', performerIds: ['p2'], tagIds: [], markers: [], files: [], server: SERVER } } : {}),
    },
    performers: {
      p1: { id: 'p1', name: 'Jane Doe', disambiguation: 'blonde', stashIds: [{ endpoint: BOX, stashId: 'AAAA-3F2A' }] },
      ...(secondJane || secondOnThisVideo ? { p2: { id: 'p2', name: 'Jane Doe', disambiguation: null, stashIds: [{ endpoint: BOX, stashId: 'BBBB-9C1D' }] } } : {}),
    },
    studios: {},
    tags: { t1: { id: 't1', name: 'POV' } },
  };
}

const videos = [{ path: VIDEO, size: 1000 }];
const funscript = { [SCRIPT]: { performers: ['Jane Doe'] } };

/** The sources and rules the dialog and the index use for this video. */
function ctxFor({ stashOn = true, file = stashFile() } = {}) {
  const stash = stashTagRecords(file, { videos, enabled: stashOn });
  const rules = withNameIds(compileTagRules({}), nameIdentities(file, { enabled: stashOn }));
  return { sources: { stash, funscript }, scriptPath: SCRIPT, rules };
}

function people(hiddenTags, opts) {
  const ctx = ctxFor(opts);
  return effectiveTags(VIDEO, ctx.sources, { scriptPath: SCRIPT, hidden: hiddenTags, rules: ctx.rules })
    .filter((t) => t.facet === 'performer')
    .map((t) => ({ key: t.key, sources: t.sources }));
}

const hiddenOf = (plan) => plan.writes.find((w) => w.key === 'library.hiddenTags')?.value;

/** Remove the joined chip with Stash on, from `hiddenTags`. */
function removeJoined(hiddenTags = {}) {
  const ctx = ctxFor();
  const chip = effectiveTags(VIDEO, ctx.sources, { scriptPath: SCRIPT, hidden: hiddenTags, rules: ctx.rules })
    .find((t) => t.facet === 'performer');
  expect(chip).toMatchObject({ key: KEY_A, sources: ['stash', 'funscript'] });
  const plan = planRemoveTag({ userTags: {}, hiddenTags }, VIDEO, chip.key, ctx);
  expect(plan.ok).toBe(true);
  return plan;
}

describe('removing a joined chip hides the identity AND the bare name', () => {
  it('both keys are stored; while the join holds nothing else changes (one chip gone, the rest stays)', () => {
    const plan = removeJoined();
    expect(plan.hidden).toBe(true);
    expect(hiddenOf(plan)).toEqual({ [VIDEO]: [KEY_A, BARE] });
    expect(people(hiddenOf(plan))).toEqual([]);
  });

  it('1. Stash turned off: the script\'s "Jane Doe" stays hidden', () => {
    const hidden = hiddenOf(removeJoined());
    expect(people({}, { stashOn: false })).toEqual([{ key: BARE, sources: ['funscript'] }]); // the chip the user removed
    expect(people(hidden, { stashOn: false })).toEqual([]);
  });

  it('2. Stash data removed (Remove Stash data…, Stash still on): it stays hidden', () => {
    const hidden = hiddenOf(removeJoined());
    expect(people(hidden, { file: stashFile({ removed: true }) })).toEqual([]);
  });

  it('3. a sync brings a second Jane Doe: the script\'s bare name stays hidden; the other Jane Doe is her own chip', () => {
    const hidden = hiddenOf(removeJoined());
    expect(people(hidden, { file: stashFile({ secondJane: true }) })).toEqual([]);
    // The second Jane Doe on THIS video's scene: a person the user never hid.
    expect(people(hidden, { file: stashFile({ secondOnThisVideo: true }) })).toEqual([{ key: KEY_B, sources: ['stash'] }]);
  });

  it('Undo puts the hidden list back exactly (absent stays absent; earlier hides kept)', () => {
    const fresh = removeJoined();
    expect(planUndo({ userTags: {}, hiddenTags: hiddenOf(fresh) }, fresh.undo).writes)
      .toEqual([{ key: 'library.hiddenTags', value: {} }]);
    const before = { [VIDEO]: ['content:outdoor'], 'C:/Lib/Other.mp4': [KEY_A] };
    const plan = removeJoined(before);
    expect(hiddenOf(plan)[VIDEO]).toEqual(['content:outdoor', KEY_A, BARE]);
    const undo = planUndo({ userTags: {}, hiddenTags: hiddenOf(plan) }, plan.undo);
    expect(undo.exact).toBe(true);
    expect(undo.writes).toEqual([{ key: 'library.hiddenTags', value: before }]);
  });

  it('a Stash-only person (no other source names her) still hides just her key', () => {
    const file = stashFile();
    const ctx = { sources: { stash: stashTagRecords(file, { videos, enabled: true }) }, rules: withNameIds(compileTagRules({}), nameIdentities(file, { enabled: true })) };
    const plan = planRemoveTag({ userTags: {}, hiddenTags: {} }, VIDEO, KEY_A, ctx);
    expect(hiddenOf(plan)).toEqual({ [VIDEO]: [KEY_A] });
  });

  it('a joined name you typed: your copy goes, and only the Stash identity is hidden (no bare chip is left to hide)', () => {
    const file = stashFile();
    const rules = withNameIds(compileTagRules({}), nameIdentities(file, { enabled: true }));
    const sources = { stash: stashTagRecords(file, { videos, enabled: true }) };
    const plan = planRemoveTag({ userTags: { [VIDEO]: ['performer:Jane Doe'] }, hiddenTags: {} }, VIDEO, KEY_A, { sources, rules });
    expect(plan.writes.find((w) => w.key === 'library.userTags').value).toEqual({});
    expect(hiddenOf(plan)).toEqual({ [VIDEO]: [KEY_A] });
  });
});

describe('Show again lifts the whole hide', () => {
  it('while the join holds: one row, and Show again lifts both keys', () => {
    const hidden = hiddenOf(removeJoined());
    const ctx = ctxFor();
    expect(hiddenOnVideo(hidden, VIDEO, ctx)).toEqual([{ key: KEY_A, facet: 'performer', label: 'Jane Doe' }]);
    expect(hiddenOf(planShowAgain({ hiddenTags: hidden }, VIDEO, KEY_A, ctx))).toEqual({});
  });

  it('Stash off: one row "Jane Doe" (the identity no source gives folds into it); Show again lifts both, so Stash on again shows the chip', () => {
    const hidden = hiddenOf(removeJoined());
    const off = ctxFor({ stashOn: false });
    expect(hiddenOnVideo(hidden, VIDEO, off)).toEqual([{ key: BARE, facet: 'performer', label: 'Jane Doe' }]);
    const after = hiddenOf(planShowAgain({ hiddenTags: hidden }, VIDEO, BARE, off));
    expect(after).toEqual({});
    expect(people(after)).toEqual([{ key: KEY_A, sources: ['stash', 'funscript'] }]);
  });

  it('two Jane Does after a sync: two rows that read apart; each Show again lifts only its own', () => {
    const hidden = hiddenOf(removeJoined());
    const ctx = ctxFor({ file: stashFile({ secondOnThisVideo: true }) });
    const rows = hiddenOnVideo(hidden, VIDEO, ctx);
    expect(rows).toEqual([
      { key: KEY_A, facet: 'performer', label: 'Jane Doe (blonde)' },
      { key: BARE, facet: 'performer', label: 'Jane Doe' },
    ]);
    expect(hiddenOf(planShowAgain({ hiddenTags: hidden }, VIDEO, BARE, ctx))).toEqual({ [VIDEO]: [KEY_A] });
  });
});

describe('"Hidden on this video" names Stash people as the chips do (RA-S1-5)', () => {
  const both = { [VIDEO]: [KEY_A, KEY_B] };

  it('Stash on: two same-name people read apart (Stash\'s disambiguation, else the Stash ID\'s last 4 characters)', () => {
    const labels = hiddenOnVideo(both, VIDEO, ctxFor({ file: stashFile({ secondOnThisVideo: true }) })).map((r) => r.label);
    expect(labels).toEqual(['Jane Doe (blonde)', 'Jane Doe · 9c1d']);
  });

  it('Stash off: a name, never the raw key; two of one name still read apart', () => {
    const labels = hiddenOnVideo(both, VIDEO, ctxFor({ stashOn: false })).map((r) => r.label);
    expect(labels).toEqual(['jane doe · 3f2a', 'jane doe · 9c1d']);
    for (const l of labels) expect(l).not.toMatch(/#|aaaa|bbbb/);
    expect(hiddenOnVideo({ [VIDEO]: [KEY_A] }, VIDEO, ctxFor({ stashOn: false })).map((r) => r.label)).toEqual(['jane doe']);
  });

  it('without sources (no Stash data at all): the name part only', () => {
    expect(hiddenOnVideo({ [VIDEO]: [KEY_A] }, VIDEO).map((r) => r.label)).toEqual(['jane doe']);
  });
});
