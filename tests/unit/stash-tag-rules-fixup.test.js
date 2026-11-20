/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot, stage sn-fixup (2026-11-19): the review's renderer-side
// findings (SCRATCH/report-sn-review.json) for "Use Stash's tag aliases and
// sub-tags" (settings.stash.useTagRules), and the sn-verify observation on
// the opt-in's hint.
//
// Guards checked by reopening their hole (SCRATCH/sn-fixup/holes.jsonl):
//   - SN-R1: a tag removed while the opt-in is on stays removed once the
//     opt-in is off, Stash is off or its data is removed: the hide names the
//     source's own spelling(s) too (hole: only Stash's canonical key stored)
//   - SN-R5: a Stash data change that did not change the rules reuses the
//     compiled rules (and the sub-tag graph); the index it builds is the
//     same as a fresh one (hole: a new rule set per Stash data version)
//   - the opt-in's hint no longer says "Updated with each sync" (it applies
//     at once, from the tag list of the last sync), in all 8 languages
// Pinned (behaviour defined here, the review's note): your alias whose
// TARGET is the text of a Stash alias follows it to Stash's tag, one Stash
// hop: the layers are one alias map read in order (bundled < Stash < yours),
// yours decide every text you name, and Stash's own aliases never chain.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { compileTagRules, classifyTag, effectiveTags } from '../../renderer/js/video-tags.js';
import { planRemoveTag, planShowAgain, planUndo, planAddTag, hiddenOnVideo } from '../../renderer/js/video-tag-edits.js';
import { stashTagRuleSet, tagRuleSetStamp, sameTagRuleSet } from '../../renderer/js/stash-tags.js';
import { LibraryTagIndex, buildLibraryTagIndex, impliedTags } from '../../renderer/js/library-tag-filter.js';
import { remoteTagSliceFromIndex } from '../../renderer/js/remote-tag-slice.js';

const require_ = createRequire(import.meta.url);
const { buildTagRules } = require_('../../electron/stash-tag-rules.js');

const P = 'C:/Library/Video A.mp4';
const ON = { enabled: true, useTagRules: true };
const rulesFrom = (data, opts = ON, settings = {}) => compileTagRules(settings, { stash: stashTagRuleSet(data, opts) });
const shown = (rules, sources, hiddenTags) => effectiveTags(P, sources, { rules, hidden: hiddenTags }).map((t) => t.key);
const hiddenOf = (plan) => plan.writes.find((w) => w.key === 'library.hiddenTags')?.value;

// EroScripts gives the video "outside" and "pov"; Stash's tag "Open Air" lists "outside" as an alias.
const ERO = { eroscripts: { [P]: { tags: ['outside', 'pov'], topicId: 1, source: 'eroscripts', savedAt: 1 } } };
const OPEN_AIR = { tagRules: { aliases: { outside: 'open-air' }, children: {}, names: { 'open-air': 'Open Air' } }, tags: {} };

describe('SN-R1: a tag removed while the opt-in is on stays removed', () => {
  const on = rulesFrom(OPEN_AIR);
  const optInOff = rulesFrom(OPEN_AIR, { enabled: true, useTagRules: false });
  const removedData = rulesFrom({ tags: {} }); // Remove Stash data: no tagRules
  const remove = (sources = ERO, rules = on) => planRemoveTag({ userTags: {}, hiddenTags: {} }, P, 'content:open-air', { sources, rules });

  it('opt-in on: the chip is "Open Air" (from "outside"); removing it hides it', () => {
    expect(effectiveTags(P, ERO, { rules: on }).find((t) => t.key === 'content:open-air')?.label).toBe('Open Air');
    const hidden = hiddenOf(remove());
    expect(shown(on, ERO, hidden)).toEqual(['content:pov']);
  });

  it('the hide survives the opt-in off, Stash off and Remove Stash data', () => {
    const hidden = hiddenOf(remove());
    expect(hidden[P]).toEqual(['content:open-air', 'content:outside']);
    expect(shown(optInOff, ERO, hidden)).toEqual(['content:pov']);
    expect(shown(compileTagRules({}), ERO, hidden)).toEqual(['content:pov']); // Stash off: no layer, no Stash source
    expect(shown(removedData, ERO, hidden)).toEqual(['content:pov']);
  });

  it('with Stash\'s own "Open Air" on the scene too: neither comes back with the opt-in off', () => {
    const sources = { ...ERO, stash: { [P]: { tags: [{ id: '7', name: 'Open Air' }] } } };
    const hidden = hiddenOf(remove(sources));
    expect(shown(optInOff, sources, hidden)).toEqual(['content:pov']);
    expect(shown(compileTagRules({}), ERO, hidden)).toEqual(['content:pov']);
  });

  it('opt-in on: one "Hidden on this video" row; Show again lifts every key it stands for; Undo puts the list back exactly', () => {
    const plan = remove();
    const state = { userTags: {}, hiddenTags: hiddenOf(plan) };
    const ctx = { sources: ERO, rules: on };
    expect(hiddenOnVideo(state.hiddenTags, P, ctx)).toEqual([{ key: 'content:open-air', facet: 'content', label: 'Open Air' }]);
    const again = planShowAgain(state, P, 'content:open-air', ctx);
    expect(hiddenOf(again)).toEqual({});
    const back = planUndo(state, plan.undo);
    expect(back.exact).toBe(true);
    expect(hiddenOf(back)).toEqual({});
    // Adding "Open Air" back yourself also lifts both.
    const add = planAddTag(state, P, 'Open Air', { rules: on });
    expect(hiddenOf(add)).toEqual({});
  });

  it('another chip shown now is never hidden by it (a bundled alias Stash took over: "futa")', () => {
    // Bundled: futa -> futanari. Stash: "Dickgirl" lists "futa" as an alias (Stash's layer wins over the bundled one).
    const data = { tagRules: { aliases: { futa: 'dickgirl' }, children: {}, names: { dickgirl: 'Dickgirl' } }, tags: {} };
    const rules = rulesFrom(data);
    const both = { eroscripts: { [P]: { tags: ['futa', 'futanari'], topicId: 1, source: 'eroscripts', savedAt: 1 } } };
    const plan = planRemoveTag({ userTags: {}, hiddenTags: {} }, P, 'content:dickgirl', { sources: both, rules });
    const hidden = hiddenOf(plan);
    const futanari = classifyTag('futanari').key; // the facet table's key (sexuality:futanari)
    expect(classifyTag('futa').key).toBe(futanari);
    expect(classifyTag('futa', rules).key).toBe('content:dickgirl');
    expect(shown(rules, both, hidden)).toEqual([futanari]);
    expect(shown(compileTagRules({}), both, hidden)).toEqual([futanari]); // you never removed "Futanari"
    // Only "futa" gave the chip: its plain key is hidden too.
    const one = { eroscripts: { [P]: { tags: ['futa'], topicId: 1, source: 'eroscripts', savedAt: 1 } } };
    const hiddenOne = hiddenOf(planRemoveTag({ userTags: {}, hiddenTags: {} }, P, 'content:dickgirl', { sources: one, rules }));
    expect(shown(compileTagRules({}), one, hiddenOne)).toEqual([]);
  });

  it('opt-in off: removing a tag stores only its own key, as before', () => {
    const hidden = hiddenOf(remove(ERO, optInOff));
    expect(hidden).toBeUndefined(); // "open-air" is no chip with the opt-in off: nothing to hide
    const plan = planRemoveTag({ userTags: {}, hiddenTags: {} }, P, 'content:outside', { sources: ERO, rules: optInOff });
    expect(hiddenOf(plan)[P]).toEqual(['content:outside']);
  });
});

describe('your alias whose target is a Stash alias text (the review\'s note)', () => {
  // Stash: "Seaside" lists "sand" as an alias. Yours: beach -> sand.
  const data = { tagRules: { aliases: { sand: 'seaside' }, children: {}, names: { seaside: 'Seaside' } }, tags: {} };
  const src = { eroscripts: { [P]: { tags: ['beach', 'sand'], topicId: 1, source: 'eroscripts', savedAt: 1 } } };

  it('follows it to Stash\'s tag (one Stash hop): "beach" and "sand" are one chip "Seaside"', () => {
    const rules = rulesFrom(data, ON, { aliases: { beach: 'sand' } });
    expect(classifyTag('beach', rules).key).toBe('content:seaside');
    expect(effectiveTags(P, src, { rules }).map((t) => [t.key, t.label])).toEqual([['content:seaside', 'Seaside']]);
  });

  it('opt-in off: your alias as before (beach -> sand)', () => {
    const rules = compileTagRules({ aliases: { beach: 'sand' } });
    expect(effectiveTags(P, src, { rules }).map((t) => t.key)).toEqual(['content:sand']);
  });

  it('yours decide a text you name: your alias of "sand" itself beats Stash\'s', () => {
    const rules = rulesFrom(data, ON, { aliases: { beach: 'sand', sand: 'shore' } });
    expect(classifyTag('beach', rules).key).toBe('content:shore');
    expect(classifyTag('sand', rules).key).toBe('content:shore');
  });

  it('Stash\'s aliases never chain: an alias that is another Stash tag\'s name is left out (main)', () => {
    const rules = buildTagRules({ 1: { name: 'Seaside', aliases: ['sand'], parentIds: [] }, 2: { name: 'Sand', aliases: ['dune'], parentIds: [] } });
    expect(rules.aliases).toEqual({ dune: 'sand' });
  });
});

// A StashDB-like tree: roots with fan-out, `depth` levels, 2 aliases per tag.
function tagTree(n, { depth = 4, fan = 3 } = {}) {
  const tags = {};
  let id = 1;
  const make = (parentId, level) => {
    const my = String(id++);
    tags[my] = { name: `Tag ${my}`, aliases: [`alias ${my}`], parentIds: parentId ? [parentId] : [] };
    if (level < depth) for (let i = 0; i < fan && id <= n; i++) make(my, level + 1);
  };
  while (id <= n) make(null, 1);
  return tags;
}

describe('SN-R5: the same Stash rules are compiled once across Stash data changes', () => {
  const N = 120;
  const tree = tagTree(N);
  const tagRules = buildTagRules(tree);
  const videos = Array.from({ length: 40 }, (_, i) => ({ path: `C:/lib/v${i}.mp4` }));
  const userTags = Object.fromEntries(videos.map((v, i) => [v.path, [`Tag ${1 + ((i * 7) % N)}`, `alias ${1 + ((i * 13) % N)}`]]));

  function setup(data) {
    const state = { data, version: 1, settings: { 'library.userTags': userTags, 'stash.enabled': true, 'stash.useTagRules': true } };
    const memo = new LibraryTagIndex({
      settings: () => ({ get: (k) => state.settings[k] }),
      videos: () => videos,
      stashData: () => state.data,
      stashVersion: () => state.version,
    });
    return { state, memo };
  }

  it('a new copy of the data with the same stamp (a link, an Undo): the compiled rules are reused', () => {
    const stamped = (rules) => ({ tagRules: { ...structuredClone(rules), stamp: 'http://127.0.0.1:9999|1|120' }, tags: {} });
    const { state, memo } = setup(stamped(tagRules));
    const first = memo.get();
    state.data = stamped(tagRules);
    state.version += 1;
    const second = memo.get();
    expect(second).not.toBe(first); // rebuilt (the Stash data changed)
    expect(second.rules).toBe(first.rules); // with the same compiled rules
  });

  it('no stamp, the same content: reused; other content: compiled again', () => {
    const { state, memo } = setup({ tagRules: structuredClone(tagRules), tags: {} });
    const first = memo.get();
    state.data = { tagRules: structuredClone(tagRules), tags: {} };
    state.version += 1;
    expect(memo.get().rules).toBe(first.rules);
    const changed = structuredClone(tagRules);
    changed.aliases['alias 1'] = 'tag-2';
    state.data = { tagRules: changed, tags: {} };
    state.version += 1;
    const third = memo.get();
    expect(third.rules).not.toBe(first.rules);
    expect(third.index.get(videos[0].path).map((t) => t.key)).toEqual(
      buildLibraryTagIndex({ videos, userTags, stashRules: stashTagRuleSet(state.data, ON) }).index.get(videos[0].path).map((t) => t.key),
    );
  });

  it('a reused build gives exactly what a fresh build gives (index, counts, implied parents, the phone\'s slice)', () => {
    const data = { tagRules: { ...structuredClone(tagRules), stamp: 's|1|120' }, tags: {} };
    const { state, memo } = setup(data);
    memo.get();
    state.data = { tagRules: { ...structuredClone(tagRules), stamp: 's|1|120' }, tags: {} };
    state.version += 1;
    const reused = memo.get();
    const fresh = buildLibraryTagIndex({ videos, userTags, stashRules: stashTagRuleSet(data, ON) });
    const plain = (r) => ({
      index: [...r.index].map(([p, tags]) => [p, tags.map((t) => [t.key, t.label])]),
      counts: [...r.counts.values()].map((row) => ({ ...row })),
      implied: [...impliedTags(r.index)].map(([p, tags]) => [p, tags.map((t) => [t.key, t.facet, t.label])]),
      slice: remoteTagSliceFromIndex(r.index),
    });
    expect(plain(reused)).toEqual(plain(fresh));
    expect(plain(reused).implied.length).toBeGreaterThan(0);
  });

  it('tagRuleSetStamp / sameTagRuleSet', () => {
    expect(tagRuleSetStamp({ tagRules: { stamp: 'a' }, tags: { 1: { name: 'X' } } }, ON)).toBe('a\u0001X');
    expect(tagRuleSetStamp({ tagRules: { stamp: 'a' } }, { enabled: true, useTagRules: false })).toBeNull();
    expect(tagRuleSetStamp({ tagRules: {} }, ON)).toBeNull();
    const a = stashTagRuleSet({ tagRules }, ON);
    expect(sameTagRuleSet(a, stashTagRuleSet({ tagRules: structuredClone(tagRules) }, ON))).toBe(true);
    expect(sameTagRuleSet(a, stashTagRuleSet({ tagRules: { ...tagRules, aliases: {} } }, ON))).toBe(false);
    expect(sameTagRuleSet(null, null)).toBe(true);
    expect(sameTagRuleSet(a, null)).toBe(false);
  });
});

describe('the opt-in\'s hint (sn-verify): it applies at once, from the last sync\'s tag list', () => {
  const OLD = {
    en: 'Updated with each sync.',
    de: 'Wird bei jeder Synchronisierung aktualisiert.',
    es: 'Se actualiza con cada sincronización.',
    fr: 'Mis à jour à chaque synchronisation.',
    ja: '同期のたびに更新されます。',
    ko: '동기화할 때마다 업데이트됩니다.',
    ru: 'Обновляется при каждой синхронизации.',
    zh: '每次同步时更新。',
  };
  for (const [lang, old] of Object.entries(OLD)) {
    it(`${lang}: no "updated with each sync"`, () => {
      const json = JSON.parse(fs.readFileSync(new URL(`../../renderer/locales/${lang}.json`, import.meta.url), 'utf8'));
      const hint = json.settingsPanel.stash.useTagRulesHint;
      expect(hint).not.toContain(old);
      expect(hint.length).toBeGreaterThan(40);
    });
  }

  it('en says it applies at once and uses the last sync\'s tag list', () => {
    const json = JSON.parse(fs.readFileSync(new URL('../../renderer/locales/en.json', import.meta.url), 'utf8'));
    expect(json.settingsPanel.stash.useTagRulesHint).toContain('Applies at once, with the tag list from the last sync.');
  });
});
