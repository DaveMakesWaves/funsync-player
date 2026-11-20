/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash "next" lot (2026-11-19, appendix (j) #5; Dave: opt-in): Stash's tag
// aliases and sub-tags as the renderer's rules (electron/stash-tag-rules.js;
// stage sn-main). The keys must be the renderer's own tag keys, so main's
// tagSlug is checked against renderer/js/video-tags.js tagSlug here.
//
// Guards checked by reopening their hole (SCRATCH/sn-main/holes.jsonl):
//   - an alias two tags claim is left out (hole: the last one wins)
//   - children lists every tag below a parent, not only its children (hole:
//     direct children only: the 3-level chain loses the grandchild)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tagSlug as rendererTagSlug } from '../../renderer/js/video-tags.js';

const require_ = createRequire(import.meta.url);
const { tagSlug, buildTagRules, MAX_DESCENDANTS } = require_('../../electron/stash-tag-rules.js');
const { mapTagPage } = require_('../../electron/stash-map.js');

const TAGS = mapTagPage(JSON.parse(fs.readFileSync('tests/fixtures/stash/sn-tag-list.response.json', 'utf8')).body.data.findTags).tags;

describe('main\'s tagSlug is the renderer\'s', () => {
  it.each([
    'Synthetic Tag A', 'Blow Job', 'blow_job', 'BLOW-JOB', '  spaced   out  ', 'Crème Brûlée', 'Ｆｕｌｌｗｉｄｔｈ',
    'Position: Cowgirl', 'a--b__c', '-edge-', 'İstanbul', 'ß', '日本語 タグ', 'emoji 😀 tag', 'tab\tand\nnewline',
    '', '   ', 42, null, 'constructor', '__proto__',
  ])('%j', (text) => {
    expect(tagSlug(text)).toBe(rendererTagSlug(text));
  });
});

describe('the rules from the test Stash\'s tags', () => {
  const rules = buildTagRules(TAGS);

  it('every alias points at its tag\'s key', () => {
    expect(rules.aliases).toEqual({
      'syn-a-two': 'synthetic-tag-a',
      'synthetic-a': 'synthetic-tag-a',
      'synthetic-child': 'synthetic-tag-b',
      'synthetic-parent': 'synthetic-parent-tag',
      'syn-gp': 'synthetic-grandparent-tag',
      'synthetic-grand': 'synthetic-grandparent-tag',
      'synthetic-c': 'synthetic-tag-c',
    });
  });

  it('a parent finds every tag below it: the 3-level chain (guard)', () => {
    expect(rules.children).toEqual({
      'synthetic-grandparent-tag': ['synthetic-parent-tag', 'synthetic-tag-b'],
      'synthetic-parent-tag': ['synthetic-tag-b'],
    });
  });

  it('names every tag of the tree, a parent no scene carries included', () => {
    expect(rules.names).toMatchObject({
      'synthetic-grandparent-tag': 'Synthetic Grandparent Tag',
      'synthetic-tag-b': 'Synthetic Tag B',
      'synthetic-marker-tag': 'Synthetic Marker Tag',
    });
    expect(Object.keys(rules.names)).toHaveLength(6);
  });

  it('the stored tree (by id) gives the same rules as the list', () => {
    const byId = Object.fromEntries(TAGS.map(({ id, ...t }) => [id, t]));
    expect(buildTagRules(byId)).toEqual(rules);
  });

  it('nothing stored: no rules', () => {
    expect(buildTagRules({})).toEqual({ aliases: {}, children: {}, names: {} });
    expect(buildTagRules(null)).toEqual({ aliases: {}, children: {}, names: {} });
  });
});

describe('what never becomes a rule', () => {
  it('an alias two tags claim relabels nothing (guard)', () => {
    const rules = buildTagRules([
      { id: '1', name: 'Cowgirl', aliases: ['CG'], parentIds: [] },
      { id: '2', name: 'Reverse Cowgirl', aliases: ['cg', 'RCG'], parentIds: [] },
    ]);
    expect(rules.aliases).toEqual({ rcg: 'reverse-cowgirl' });
  });

  it('an alias that is another tag\'s name never relabels that tag; one that spells its own tag is no rule', () => {
    const rules = buildTagRules([
      { id: '1', name: 'Blowjob', aliases: ['BJ', 'Deep Throat', 'blow_job'], parentIds: [] },
      { id: '2', name: 'Deep-Throat', aliases: ['blowjob'], parentIds: [] },
    ]);
    expect(rules.aliases).toEqual({ bj: 'blowjob', 'blow-job': 'blowjob' });
  });

  it('a loop in the hierarchy ends where it repeats; a tag is never its own sub-tag', () => {
    const rules = buildTagRules([
      { id: '1', name: 'A', parentIds: ['3'] },
      { id: '2', name: 'B', parentIds: ['1'] },
      { id: '3', name: 'C', parentIds: ['2', '3'] },
    ]);
    expect(rules.children).toEqual({ a: ['b', 'c'], b: ['c', 'a'], c: ['a', 'b'] });
  });

  it('a parent that is not in the tree, or a tag with no usable name, adds nothing', () => {
    const rules = buildTagRules([
      { id: '1', name: 'A', parentIds: ['99'] },
      { id: '2', name: '   ', aliases: ['x'], parentIds: [] },
      { id: '3', name: 'B', parentIds: ['2'] },
    ]);
    expect(rules).toEqual({ aliases: {}, children: {}, names: { a: 'A', b: 'B' } });
  });

  it('two tags folding to one key are one key: their sub-tags join; the lowest id names it', () => {
    const rules = buildTagRules([
      { id: '12', name: 'big_tits', parentIds: [] },
      { id: '3', name: 'Big Tits', parentIds: [] },
      { id: '4', name: 'Huge', parentIds: ['12'] },
      { id: '5', name: 'Natural', parentIds: ['3'] },
    ]);
    expect(rules.children).toEqual({ 'big-tits': ['huge', 'natural'] });
    expect(rules.names['big-tits']).toBe('Big Tits');
  });

  it('at most MAX_DESCENDANTS tags below one parent', () => {
    const tags = [{ id: '1', name: 'Root', parentIds: [] }];
    for (let i = 2; i <= MAX_DESCENDANTS + 50; i++) tags.push({ id: String(i), name: `Leaf ${i}`, parentIds: ['1'] });
    expect(buildTagRules(tags).children.root).toHaveLength(MAX_DESCENDANTS);
  });
});
