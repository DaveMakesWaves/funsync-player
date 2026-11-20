/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash's tag aliases and sub-tags (Stash "next" lot, stage sn-tags,
// 2026-11-19; DESIGN-stash-s1.md (j) row 5 and Dave's answer: an OPT-IN,
// "Use Stash's tag aliases and sub-tags" (settings.stash.useTagRules), off
// by default; until it is on nothing about existing tags changes).
//
// Pinned here, each by what a user sees:
//   - Off (or Stash off, or no `tagRules` from main): exactly today's keys,
//     labels, counts and filter, even with tagRules in the data;
//   - On: an alias from ANY source (yours, the script file's, the forum's,
//     Stash's, a stash-box's) shows as Stash's tag, in Stash's spelling;
//   - yours always win: your alias of the same text, your facet override,
//     your alias of the key, a cycle through your aliases, your hides;
//   - a Stash tag's own name is never renamed by another tag's alias; no
//     Stash alias touches a performer, creator or studio; identity keys
//     (performer/studio #id) are unchanged;
//   - sub-tags: picking a parent finds its children, all levels, cycle-safe;
//     the parent's count is what picking it shows; "includes N sub-tags";
//     the implied parents never show on a card or chip; a tag hidden on every
//     video is never a parent; a parent hidden on a video is not implied there;
//   - the phone: the slice carries the implied parents, so its unchanged
//     filter finds what the desktop's finds;
//   - the seeded test Stash's tag chain (tests/fixtures/stash/sn-tags
//     .response.json) through main's own builder (electron/stash-tag-rules.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  compileTagRules, classifyTag, classifyTypedTag, effectiveTags, filterByTags as desktopFilter,
} from '../../renderer/js/video-tags.js';
import {
  LibraryTagIndex, buildLibraryTagIndex, applyTagFilter, keySetsFor, impliedTags, subTagNoteText,
  STASH_TAG_RULES_KEY, TAG_DATA_KEYS, MAX_TAGS_PER_VIDEO,
} from '../../renderer/js/library-tag-filter.js';
import {
  stashTagRuleSet, MAX_TAG_RULE_ALIASES, MAX_TAG_RULE_CHILDREN,
} from '../../renderer/js/stash-tags.js';
import { remoteTagSliceFromIndex, buildRemoteTagSlice, REMOTE_TAG_SETTING_PATHS } from '../../renderer/js/remote-tag-slice.js';
import { filterByTags as phoneFilter } from '../../backend/web-remote/tag-filter.js';

const require = createRequire(import.meta.url);
const { buildTagRules } = require('../../electron/stash-tag-rules.js');

// The seeded test Stash (sn-seed, 2026-11-19): Grandparent > Parent > Tag B;
// Tag A with the aliases syn-a-two and synthetic-a; Tag C with synthetic-c.
const SEEDED = JSON.parse(fs.readFileSync('tests/fixtures/stash/sn-tags.response.json', 'utf8')).data.findTags.tags;
const SEEDED_TREE = SEEDED.map((t) => ({ id: t.id, name: t.name, aliases: t.aliases, parentIds: t.parents.map((p) => p.id) }));
// main's own projection of that tree (the contract's `tagRules`).
const TAG_RULES = buildTagRules(SEEDED_TREE);

const SERVER = 'http://127.0.0.1:9999';
const V1 = 'C:/Lib/One Scene.mp4';
const V1_S = 'C:/Lib/One Scene.funscript';
const V2 = 'C:/Lib/Two Scene.mp4';
const V3 = 'C:/Lib/Three Scene.mp4';
const V4 = 'C:/Lib/Four Scene.mp4';
const V5 = 'C:/Lib/Five Scene.mp4';
const VIDEOS = [
  { path: V1, funscriptPath: V1_S, size: 100 },
  { path: V2, funscriptPath: 'C:/Lib/Two Scene.funscript', size: 200 },
  { path: V3, funscriptPath: null, size: 300 },
  { path: V4, funscriptPath: null, size: 400 },
  { path: V5, funscriptPath: null, size: 500 },
];

/** Main's projection: V1 is linked to a scene tagged "Synthetic Tag B". */
function stashData({ tagRules = TAG_RULES } = {}) {
  return {
    v: 1,
    rev: 1,
    server: { url: SERVER, version: 'v0.32.0' },
    lastSync: { at: 1, kind: 'full', ok: true, partial: false },
    links: { [V1]: { sceneId: '7', server: SERVER, by: 'oshash', fp: { size: 100, oshash: 'aa' }, linkedAt: 1, state: 'ok' } },
    check: {},
    refused: {},
    scenes: { 7: { id: '7', title: 'Seven', performerIds: ['p1'], tagIds: ['2'], markers: [], files: [] } },
    performers: { p1: { id: 'p1', name: 'Jane Doe', stashIds: [{ endpoint: 'https://stashdb.org/graphql', stashId: '0b5e1c9a-0000-4000-8000-00000000aaaa' }] } },
    studios: {},
    // The tags the linked scenes carry (main stores those).
    tags: { 2: { id: '2', name: 'Synthetic Tag B' }, 1: { id: '1', name: 'Synthetic Tag A' } },
    ...(tagRules ? { tagRules } : {}),
  };
}

const STORE = () => ({
  'library.userTags': { [V3]: ['syn-gp'], [V5]: ['Synthetic-A'] },
  'library.hiddenTags': {},
  'library.scriptTags': { [V2]: { tags: ['synthetic-parent', 'pov'], topicId: 1, source: 'eroscripts', savedAt: 1 } },
  'library.tagSettings': {},
  'stash.enabled': true,
  [STASH_TAG_RULES_KEY]: true,
});
const META = () => ({ [V1_S]: { tags: ['synthetic-a', 'Synthetic Tag C'], topicTags: [], performers: [], creator: null } });

function setup({ store = {}, data = stashData() } = {}) {
  const state = { settings: { ...STORE(), ...store }, videos: VIDEOS, meta: META(), data, version: 1 };
  const memo = new LibraryTagIndex({
    settings: () => ({ get: (k) => state.settings[k] }),
    videos: () => state.videos,
    scriptMeta: () => state.meta,
    scriptMetaVersion: () => 1,
    stashData: () => state.data,
    stashVersion: () => state.version,
  });
  return { state, memo };
}

const keysOf = (result, path) => (result.index.get(path) || []).map((t) => t.key);
const paths = (list) => list.map((v) => v.path);
const pick = (result, include, extra = {}) => paths(applyTagFilter(VIDEOS, { include, exclude: [], categories: [], sources: [], ...extra }, { index: result.index }));
const ruleSet = (data = stashData(), opts = {}) => stashTagRuleSet(data, { enabled: true, useTagRules: true, ...opts });

const A = 'content:synthetic-tag-a';
const B = 'content:synthetic-tag-b';
const C = 'content:synthetic-tag-c';
const P = 'content:synthetic-parent-tag';
const G = 'content:synthetic-grandparent-tag';

describe('the contract: main\'s tagRules for the seeded chain', () => {
  it('aliases point at their tag\'s key; children list every tag below a parent', () => {
    expect(TAG_RULES.aliases).toMatchObject({
      'synthetic-a': 'synthetic-tag-a', 'syn-a-two': 'synthetic-tag-a', 'syn-gp': 'synthetic-grandparent-tag',
      'synthetic-parent': 'synthetic-parent-tag', 'synthetic-child': 'synthetic-tag-b', 'synthetic-c': 'synthetic-tag-c',
    });
    expect(TAG_RULES.children['synthetic-grandparent-tag'].sort()).toEqual(['synthetic-parent-tag', 'synthetic-tag-b']);
    expect(TAG_RULES.children['synthetic-parent-tag']).toEqual(['synthetic-tag-b']);
  });
});

describe('stashTagRuleSet: only with Stash on AND the opt-in on AND tagRules sent', () => {
  it('off, Stash off, no tagRules, or a damaged one: null (nothing changes)', () => {
    const data = stashData();
    expect(stashTagRuleSet(data, { enabled: true, useTagRules: false })).toBeNull();
    expect(stashTagRuleSet(data, { enabled: false, useTagRules: true })).toBeNull();
    expect(stashTagRuleSet(data, { enabled: true })).toBeNull();
    expect(stashTagRuleSet(data, { enabled: 'true', useTagRules: 'true' })).toBeNull();
    expect(stashTagRuleSet(stashData({ tagRules: null }), { enabled: true, useTagRules: true })).toBeNull();
    expect(stashTagRuleSet({ ...data, tagRules: ['x'] }, { enabled: true, useTagRules: true })).toBeNull();
    expect(stashTagRuleSet(null, { enabled: true, useTagRules: true })).toBeNull();
  });

  it('on: the aliases, the children and Stash\'s tag names, sorted and frozen', () => {
    const set = ruleSet();
    expect(set.aliases).toContainEqual(['synthetic-a', 'synthetic-tag-a']);
    expect(set.children).toContainEqual(['synthetic-parent-tag', ['synthetic-tag-b']]);
    // main's names (every tag of the tree) and the data's own.
    expect(set.names).toEqual(['Synthetic Grandparent Tag', 'Synthetic Marker Tag', 'Synthetic Parent Tag',
      'Synthetic Tag A', 'Synthetic Tag B', 'Synthetic Tag C']);
    const unnamed = ruleSet(stashData({ tagRules: { aliases: TAG_RULES.aliases, children: TAG_RULES.children } }));
    expect(unnamed.names).toEqual(['Synthetic Tag A', 'Synthetic Tag B']);
    expect(Object.isFrozen(set) && Object.isFrozen(set.aliases) && Object.isFrozen(set.children)).toBe(true);
    expect(set.aliases.map((a) => a[0])).toEqual([...set.aliases.map((a) => a[0])].sort());
  });

  it('main\'s names (tagRules.names, a map or a list) join the data\'s', () => {
    const map = ruleSet(stashData({ tagRules: { aliases: {}, children: {}, names: { 'synthetic-grandparent-tag': 'Synthetic Grandparent Tag' } } }));
    expect(map.names).toContain('Synthetic Grandparent Tag');
    const listed = ruleSet(stashData({ tagRules: { aliases: {}, children: {}, names: ['Synthetic Parent Tag'] } }));
    expect(listed.names).toContain('Synthetic Parent Tag');
  });

  it('junk is left out: non-strings, lone surrogates, blanks, too long, a parent as its own child; caps hold', () => {
    const set = ruleSet(stashData({
      tagRules: {
        aliases: { ok: 'fine', bad: 42, '\ud83d': 'x', y: '\ud83d', z: ' ', long: 'x'.repeat(513) },
        children: { p: ['p', 'c', 'c', 7, '\ud83d'], q: 'not-a-list', r: [] },
      },
    }));
    expect(set.aliases).toEqual([['ok', 'fine']]);
    expect(set.children).toEqual([['p', ['c']]]);
    const many = {};
    for (let i = 0; i < MAX_TAG_RULE_ALIASES + 5; i += 1) many[`a${i}`] = 'b';
    const kids = Array.from({ length: MAX_TAG_RULE_CHILDREN + 5 }, (_, i) => `k${i}`);
    const capped = ruleSet(stashData({ tagRules: { aliases: many, children: { p: kids } } }));
    expect(capped.aliases).toHaveLength(MAX_TAG_RULE_ALIASES);
    expect(capped.children[0][1]).toHaveLength(MAX_TAG_RULE_CHILDREN);
  });
});

describe('compileTagRules: Stash\'s aliases as a layer between the bundled table and yours', () => {
  const stash = ruleSet();

  it('without the layer the rules are today\'s, value for value', () => {
    const today = compileTagRules({ aliases: { bj: 'blowjob' } });
    for (const off of [compileTagRules({ aliases: { bj: 'blowjob' } }, undefined), compileTagRules({ aliases: { bj: 'blowjob' } }, { stash: null })]) {
      expect([...off.slugAliases]).toEqual([...today.slugAliases]);
      expect([...off.keyAliases]).toEqual([...today.keyAliases]);
      expect([...off.facetOf]).toEqual([...today.facetOf]);
      expect(off.stashNames).toBeUndefined();
    }
  });

  it('an alias from every source (yours, the file, the forum, Stash, a stash-box) is Stash\'s tag, in Stash\'s spelling', () => {
    const rules = compileTagRules({}, { stash });
    const sources = {
      user: { V: ['syn-a-two'] },
      funscript: { S: { tags: ['synthetic-a'] } },
      eroscripts: { V: { tags: ['synthetic-a'], scriptPath: 'S' } },
      stash: { V: { tags: [{ id: '1', name: 'Synthetic Tag A' }] } },
      stashbox: { V: { tags: ['Syn A Two'] } },
    };
    const tags = effectiveTags('V', sources, { rules, scriptPath: 'S' });
    expect(tags.map((t) => t.key)).toEqual([A]);
    expect(tags[0].sources).toEqual(['user', 'stash', 'stashbox', 'funscript', 'eroscripts']);
    expect(tags[0].label).toBe('Synthetic Tag A');
    const off = effectiveTags('V', sources, { rules: compileTagRules({}), scriptPath: 'S' });
    expect(off.map((t) => t.key)).toEqual(['content:syn-a-two', 'content:synthetic-a', A]);
  });

  it('Stash\'s alias wins over a bundled alias of the same text', () => {
    const own = ruleSet(stashData({ tagRules: { aliases: { futa: 'futa-scene' }, children: {} } }));
    expect(classifyTag('futa', compileTagRules({}))?.key).toBe('sexuality:futanari');
    expect(classifyTag('futa', compileTagRules({}, { stash: own }))?.key).toBe('content:futa-scene');
  });

  it('yours win: your alias of the same text, your facet override, your alias of the key', () => {
    expect(classifyTag('synthetic-a', compileTagRules({ aliases: { 'synthetic-a': 'my-a' } }, { stash }))?.key).toBe('content:my-a');
    expect(classifyTag('synthetic-a', compileTagRules({ facetOverrides: { 'synthetic-a': 'device' } }, { stash }))?.key).toBe('device:synthetic-a');
    const keyed = compileTagRules({ facetOverrides: { 'synthetic-a': 'device' }, aliases: { 'device:synthetic-a': 'device:my-toy' } }, { stash });
    expect(classifyTag('synthetic-a', keyed)?.key).toBe('device:my-toy');
    // Your alias of the key the bundled table gives (osr2 is a device there).
    const bundled = ruleSet(stashData({ tagRules: { aliases: { osr2: 'stroker-tag' }, children: {} } }));
    expect(classifyTag('osr2', compileTagRules({}, { stash: bundled }))?.key).toBe('content:stroker-tag');
    expect(classifyTag('osr2', compileTagRules({ aliases: { 'device:osr2': 'device:my-osr' } }, { stash: bundled }))?.key).toBe('device:my-osr');
    // Your rename of Stash's own tag is followed.
    expect(classifyTag('syn-a-two', compileTagRules({ aliases: { 'synthetic-tag-a': 'my-a' } }, { stash }))?.key).toBe('content:my-a');
  });

  it('a cycle through your aliases: yours win, every spelling ends at your target', () => {
    const rules = compileTagRules({ aliases: { 'synthetic-tag-a': 'synthetic-a' } }, { stash });
    for (const text of ['synthetic-a', 'Synthetic Tag A', 'syn-a-two']) expect(classifyTag(text, rules)?.key, text).toBe('content:synthetic-a');
  });

  it('a Stash tag\'s own name is never renamed by another tag\'s alias', () => {
    const clash = ruleSet(stashData({ tagRules: { aliases: { 'synthetic-tag-b': 'synthetic-tag-a', other: 'synthetic-tag-a' }, children: {} } }));
    const rules = compileTagRules({}, { stash: clash });
    expect(classifyTag('Synthetic Tag B', rules)?.key).toBe(B);
    expect(classifyTag('other', rules)?.key).toBe(A);
  });

  it('no Stash alias touches a performer, creator or studio; identity keys are unchanged', () => {
    const names = ruleSet(stashData({ tagRules: { aliases: { 'performer:jane-doe': 'someone', 'jane-doe': 'performer:other', 'studio:x': 'y' }, children: {} } }));
    const rules = compileTagRules({}, { stash: names });
    expect(classifyTag('performer:jane-doe', rules)?.key).toBe('performer:jane-doe');
    expect(classifyTag('jane-doe', rules)?.key).toBe('content:jane-doe');
    expect(classifyTag('studio:x', rules)?.key).toBe('studio:x');
    const id = 'performer:jane-doe#0b5e1c9a-0000-4000-8000-00000000aaaa';
    expect(classifyTag(id, compileTagRules({}, { stash }))?.key).toBe(id);
    const person = { V: { performers: [{ id: 'p1', name: 'Jane Doe', identity: '0b5e1c9a-0000-4000-8000-00000000aaaa' }] } };
    expect(effectiveTags('V', { stash: person }, { rules: compileTagRules({}, { stash: names }) }).map((t) => t.key)).toEqual([id]);
  });

  it('your typed tag is read the way your stored tags are', () => {
    const rules = compileTagRules({}, { stash });
    expect(classifyTypedTag('synthetic-a', rules)?.key).toBe(A);
  });

  it('your hides win: a spelling you hid stays hidden once it is Stash\'s tag', () => {
    const rules = compileTagRules({}, { stash });
    const sources = { funscript: { S: { tags: ['synthetic-a'] } } };
    expect(effectiveTags('V', sources, { rules, scriptPath: 'S', hidden: ['content:synthetic-a'] })).toEqual([]);
    expect(effectiveTags('V', sources, { rules, scriptPath: 'S', hiddenEverywhere: ['synthetic-a'] })).toEqual([]);
  });
});

describe('the library index with the opt-in on', () => {
  it('the aliases: one key per Stash tag across sources, in Stash\'s spelling', () => {
    const r = setup().memo.get();
    expect(keysOf(r, V1)).toEqual(expect.arrayContaining([A, B, C]));
    expect(keysOf(r, V2)).toEqual(['content:pov', P]);
    expect(keysOf(r, V3)).toEqual([G]);
    expect(keysOf(r, V5)).toEqual([A]);
    expect(r.counts.get(A)).toMatchObject({ label: 'Synthetic Tag A', count: 2 });
  });

  it('picking a parent finds its sub-tags, all levels down', () => {
    const r = setup().memo.get();
    expect(pick(r, [G])).toEqual([V1, V2, V3]);
    expect(pick(r, [P])).toEqual([V1, V2]);
    expect(pick(r, [B])).toEqual([V1]);
    // A bare value matches the implied parent too, as any key.
    expect(pick(r, ['synthetic-parent-tag'])).toEqual([V1, V2]);
    // Exclude a parent: its sub-tags go too.
    expect(paths(applyTagFilter(VIDEOS, { include: [], exclude: [P], categories: [], sources: [] }, { index: r.index }))).toEqual([V3, V4, V5]);
  });

  it('counts are what picking shows; a parent says how many sub-tags it has', () => {
    const r = setup().memo.get();
    for (const row of r.counts.values()) expect(pick(r, [row.key]).length, row.key).toBe(row.count);
    expect(r.counts.get(G)).toMatchObject({ count: 3, subTags: 2 });
    expect(r.counts.get(P)).toMatchObject({ count: 2, subTags: 1 });
    expect(r.counts.get(B).subTags).toBeUndefined();
    expect(r.counts.get('content:pov').subTags).toBeUndefined();
  });

  it('a parent no video has gets its row, in Stash\'s spelling when main names it', () => {
    const plain = setup({ data: stashData({ tagRules: { aliases: TAG_RULES.aliases, children: TAG_RULES.children } }) }).memo.get();
    expect(plain.counts.get(G).label).toBe('synthetic grandparent tag');
    expect(plain.counts.get(P).label).toBe('synthetic parent tag');
    const named = setup().memo.get();
    expect(named.counts.get(G).label).toBe('Synthetic Grandparent Tag');
    expect(named.counts.get(P).label).toBe('Synthetic Parent Tag');
    expect(named.index.get(V2).find((t) => t.key === P).label).toBe('Synthetic Parent Tag');
  });

  it('implied parents never show on a card or a chip: the index holds each video\'s own tags', () => {
    const r = setup().memo.get();
    expect(keysOf(r, V1)).not.toContain(P);
    expect(keysOf(r, V1)).not.toContain(G);
    expect(impliedTags(r.index).get(V1).map((t) => t.key)).toEqual([G, P]);
    expect(impliedTags(r.index).get(V3)).toBeUndefined();
  });

  it('a tag you hid on every video is never a parent (its sub-tags still roll up to the next one)', () => {
    const r = setup({ store: { 'library.tagSettings': { hidden: ['synthetic-parent-tag'] } } }).memo.get();
    expect(impliedTags(r.index).get(V1).map((t) => t.key)).toEqual([G]);
    expect(r.counts.get(P)).toBeUndefined();
    expect(pick(r, [P])).toEqual([]);
    // Two Scene's own tag was that hidden parent: it has nothing under G now.
    expect(keysOf(r, V2)).toEqual(['content:pov']);
    expect(pick(r, [G])).toEqual([V1, V3]);
  });

  it('a parent you hid on one video is not implied on it', () => {
    const r = setup({ store: { 'library.hiddenTags': { [V1]: ['content:synthetic-grandparent-tag'] } } }).memo.get();
    expect(impliedTags(r.index).get(V1).map((t) => t.key)).toEqual([P]);
    expect(pick(r, [G])).toEqual([V2, V3]);
  });

  it('cycle-safe: two tags that are each other\'s sub-tag', () => {
    const loop = stashData({ tagRules: { aliases: {}, children: { 'loop-a': ['loop-b'], 'loop-b': ['loop-a'] } } });
    const { memo } = setup({ data: loop, store: { 'library.userTags': { [V4]: ['loop-a'], [V5]: ['loop-b'] } } });
    const r = memo.get();
    expect(pick(r, ['content:loop-a'])).toEqual([V4, V5]);
    expect(pick(r, ['content:loop-b'])).toEqual([V4, V5]);
    expect(r.counts.get('content:loop-a')).toMatchObject({ count: 2, subTags: 1 });
  });

  it('a video at the cap keeps its own tags; implied parents fill only the room left', () => {
    const many = Array.from({ length: MAX_TAGS_PER_VIDEO - 1 }, (_, i) => `t${String(i).padStart(4, '0')}`);
    const { memo } = setup({ store: { 'library.userTags': { [V4]: [...many, 'Synthetic Tag B'] } } });
    const r = memo.get();
    expect(r.index.get(V4)).toHaveLength(MAX_TAGS_PER_VIDEO);
    expect(impliedTags(r.index).get(V4)).toBeUndefined();
  });

  it('subTagNoteText: "includes N sub-tags" on a parent\'s row, nothing on another', () => {
    const t = (key, p) => `${key}|${p.count}`;
    const r = setup().memo.get();
    expect(subTagNoteText(r.counts.get(G), t)).toBe('library.filterTagIncludesSubTags|2');
    expect(subTagNoteText(r.counts.get(B), t)).toBe('');
    expect(subTagNoteText(null, t)).toBe('');
    expect(subTagNoteText({ subTags: 2 }, null)).toBe('');
  });
});

describe('off: exactly today\'s tags', () => {
  const plain = (r) => ({
    index: [...r.index].map(([p, tags]) => [p, tags.map((t) => ({ ...t }))]),
    counts: [...r.counts.values()].map((row) => ({ ...row })),
    slice: remoteTagSliceFromIndex(r.index),
  });

  it('the opt-in off, Stash off, or no tagRules: the same index, counts and slice as a library that never had them', () => {
    const never = plain(setup({ store: { [STASH_TAG_RULES_KEY]: undefined }, data: stashData({ tagRules: null }) }).memo.get());
    for (const variant of [
      { store: { [STASH_TAG_RULES_KEY]: false } },
      { store: { [STASH_TAG_RULES_KEY]: undefined } },
      { store: { [STASH_TAG_RULES_KEY]: 'true' } },
      { data: stashData({ tagRules: null }) },
    ]) {
      expect(plain(setup(variant).memo.get())).toEqual(never);
    }
    expect(never.index.find(([p]) => p === V2)[1].map((t) => t.key)).toEqual(['content:pov', 'content:synthetic-parent']);
  });

  it('turning it off restores today\'s labels at once (the memo rebuilds on the setting)', () => {
    const { state, memo } = setup();
    const on = memo.get();
    expect(keysOf(on, V5)).toEqual([A]);
    state.settings[STASH_TAG_RULES_KEY] = false;
    const off = memo.get();
    expect(off).not.toBe(on);
    expect(keysOf(off, V5)).toEqual(['content:synthetic-a']);
    expect(off.index.get(V5)[0].label).toBe('Synthetic-A');
    expect(impliedTags(off.index).size).toBe(0);
    expect(pick(off, ['content:synthetic-grandparent-tag'])).toEqual([]);
    state.settings[STASH_TAG_RULES_KEY] = true;
    expect(keysOf(memo.get(), V5)).toEqual([A]);
    expect(memo.builds).toBe(3);
  });

  it('Stash turned off takes the rules with it', () => {
    const { state, memo } = setup();
    state.settings['stash.enabled'] = false;
    expect(keysOf(memo.get(), V5)).toEqual(['content:synthetic-a']);
  });

  it('the setting is an input of the index and of the phone\'s slice', () => {
    expect(TAG_DATA_KEYS).toContain(STASH_TAG_RULES_KEY);
    expect(REMOTE_TAG_SETTING_PATHS).toContain(STASH_TAG_RULES_KEY);
    expect(STASH_TAG_RULES_KEY).toBe('stash.useTagRules');
  });

  it('the memo reuses its result while nothing changed', () => {
    const { memo } = setup();
    const r = memo.get();
    expect(memo.get()).toBe(r);
    expect(memo.builds).toBe(1);
  });
});

describe('the phone: the slice carries the implied parents', () => {
  it('after each video\'s own tags, with the picker\'s labels', () => {
    const r = setup().memo.get();
    const slice = remoteTagSliceFromIndex(r.index);
    const own = keysOf(r, V1);
    expect(slice[V1].map((t) => t.key)).toEqual([...own, G, P]);
    expect(slice[V1].at(-1)).toEqual({ key: P, facet: 'content', label: r.counts.get(P).label });
  });

  it('the phone\'s unchanged filter finds what the desktop\'s finds, for every row and both directions', () => {
    const r = setup().memo.get();
    const keys = Object.fromEntries(Object.entries(remoteTagSliceFromIndex(r.index)).map(([p, tags]) => [p, tags.map((t) => t.key)]));
    for (const row of r.counts.values()) {
      for (const q of [{ include: [row.key] }, { exclude: [row.key] }, { include: [row.key, 'content:pov'], mode: 'all' }, { include: [row.key, 'content:pov'], mode: 'any' }]) {
        const desktop = paths(desktopFilter(VIDEOS, q, keySetsFor(r.index)));
        if (!q.mode) expect(paths(applyTagFilter(VIDEOS, { categories: [], sources: [], include: [], exclude: [], ...q }, { index: r.index }))).toEqual(desktop);
        expect(paths(phoneFilter(VIDEOS, q, keys)), `${row.key} ${JSON.stringify(q)}`).toEqual(desktop);
      }
    }
  });

  it('the backend\'s per-key count (videos whose list has the key) is the picker\'s count', () => {
    const r = setup().memo.get();
    const slice = remoteTagSliceFromIndex(r.index);
    const backend = new Map();
    for (const tags of Object.values(slice)) for (const t of tags) backend.set(t.key, (backend.get(t.key) || 0) + 1);
    for (const row of r.counts.values()) expect(backend.get(row.key), row.key).toBe(row.count);
  });

  it('buildRemoteTagSlice takes the rule set too', () => {
    const slice = buildRemoteTagSlice(VIDEOS, {
      userTags: STORE()['library.userTags'], scriptTags: STORE()['library.scriptTags'], scriptMeta: META(), stashRules: ruleSet(),
    });
    expect(slice[V2].map((t) => t.key)).toEqual(['content:pov', P, G]);
  });

  it('keySetsFor: a video\'s parsed set holds its implied parents', () => {
    const r = setup().memo.get();
    expect(keySetsFor(r.index).get(V2).keys.has(G)).toBe(true);
    expect(keySetsFor(new Map(r.index)).get(V2).keys.has(G)).toBe(false);
  });
});

describe('buildLibraryTagIndex returns the rules it used (the dialog\'s chips read them)', () => {
  it('with Stash\'s layer while on; plain rules while off', () => {
    const on = buildLibraryTagIndex({ videos: VIDEOS, userTags: { [V5]: ['synthetic-a'] }, stashRules: ruleSet() });
    expect(classifyTag('synthetic-a', on.rules)?.key).toBe(A);
    const off = buildLibraryTagIndex({ videos: VIDEOS, userTags: { [V5]: ['synthetic-a'] } });
    expect(classifyTag('synthetic-a', off.rules)?.key).toBe('content:synthetic-a');
  });
});
