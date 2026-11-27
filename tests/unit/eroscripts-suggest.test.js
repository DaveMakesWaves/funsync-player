/**
 * @vitest-environment node
 * No DOM required: pure ranking and filtering.
 */
// "Suggested for you" (Dave, 2026-11-24): the library's taste tags, ranked by
// how much more often they show in the library than on the forum; length,
// devices, price and format left out; posts the user has or linked, the
// other format, Hide tags and Not interested left out.
import { describe, it, expect } from 'vitest';
import {
  NOT_TASTE, isNotTaste, GENRES, tagSlug, libraryTagCounts, baselineCounts, avoidTags, readAllowed, setAllowed, formatPreference, rankTasteTags, suggestionReason, passesSuggested,
  readDismissed, dismissTopic, readLeftOut, setLeftOut,
} from '../../renderer/js/eroscripts-suggest.js';

// The trailer sandbox's real tags (22 linked posts) were near-universal at
// the top: non-vr 22, real 21, action-based 20, straight 18, the-handy 17.
function sampleLibrary() {
  const scriptTags = {};
  for (let i = 0; i < 20; i++) {
    const tags = ['non-vr', 'real', 'straight', 'the-handy', 'len-10-25'];
    if (i < 12) tags.push('blowjob');
    if (i < 6) tags.push('pov');
    if (i < 4) tags.push('riding');
    scriptTags[`C:\\v\\${i}.mp4`] = { topicId: 1000 + i, tags };
  }
  scriptTags['C:\\v\\unlinked.mp4'] = { topicId: null, tags: ['femdom'] };   // not linked: not counted
  return { scriptTags, userTags: { 'C:\\v\\0.mp4': ['Big Ass', 'blowjob'] } };
}
// The forum's newest script posts (60): real and straight on most, the rest rarer.
const FORUM_POSTS = Array.from({ length: 60 }, (_, i) => ({ id: i, tags: [
  'non-vr', ...(i < 40 ? ['real', 'straight'] : []), ...(i < 15 ? ['blowjob'] : []), ...(i < 6 ? ['pov'] : []), ...(i < 4 ? ['riding'] : []),
] }));
const KNOWN = new Set(['non-vr', 'real', 'straight', 'blowjob', 'pov', 'riding', 'big-ass']);

describe('the library\'s taste', () => {
  it('counts each linked video once per tag, its own tags as slugs too; an unlinked post is not counted', () => {
    const { scriptTags, userTags } = sampleLibrary();
    const lib = libraryTagCounts(scriptTags, userTags);
    expect(lib.videos).toBe(20);
    expect(lib.counts.get('blowjob')).toBe(12);          // video 0 has it twice: once
    expect(lib.counts.get('big-ass')).toBe(1);
    expect(lib.counts.has('femdom')).toBe(false);
    expect(tagSlug('  #Big Ass ')).toBe('big-ass');
  });

  it('length, devices, price and format are never taste tags', () => {
    for (const t of ['len-10-25', 'the-handy', 'osr2', 'multi-axis', 'free', 'paid', 'vr', 'non-vr', 'ai-assisted', 'action-based']) expect(NOT_TASTE.has(t)).toBe(true);
    for (const t of ['blowjob', 'pov', 'real', 'straight']) expect(NOT_TASTE.has(t)).toBe(false);
    // By shape too (live 2026-11-24: "the-handy-2-pro" was taken for a taste).
    for (const t of ['the-handy-2-pro', 'osr2-plus', 'multi-device', 'hybrid-based', 'len-0-2']) expect(isNotTaste(t)).toBe(true);
    for (const t of ['handjob', 'blowjob', 'cosplay']) expect(isNotTaste(t)).toBe(false);
  });

  it('ranked by "more than usual" against the forum\'s own script posts: tags nearly every post has drop', () => {
    const lib = libraryTagCounts(sampleLibrary().scriptTags, {});
    const baseline = baselineCounts(FORUM_POSTS);
    expect(baseline.posts).toBe(60);
    const top = rankTasteTags(lib, { baseline, known: KNOWN }).map((x) => x.tag);
    expect(top.slice(0, 3)).toEqual(['pov', 'riding', 'blowjob']);
    expect(top.indexOf('real')).toBeGreaterThan(top.indexOf('blowjob'));
    expect(top).not.toContain('the-handy');
    expect(top).not.toContain('len-10-25');
    // Without a baseline: by count (real, straight lead).
    expect(rankTasteTags(lib).map((x) => x.tag).slice(0, 2)).toEqual(['real', 'straight']);
    // A tag the forum does not have is skipped; one the user left out too; at most 5.
    expect(rankTasteTags(lib, { known: new Set(['real']) }).map((x) => x.tag)).toEqual(['real']);
    expect(rankTasteTags(lib, { baseline, known: KNOWN }, { leftOut: ['pov'] }).map((x) => x.tag)).not.toContain('pov');
    expect(rankTasteTags(lib, { baseline }).length).toBeLessThanOrEqual(5);
  });

  it('format: the library\'s own when 60% or more is one, else none', () => {
    expect(formatPreference(libraryTagCounts(sampleLibrary().scriptTags, {}))).toBe('flat');
    expect(formatPreference({ counts: new Map([['vr', 7], ['non-vr', 3]]), videos: 10 })).toBe('vr');
    expect(formatPreference({ counts: new Map([['vr', 5], ['non-vr', 5]]), videos: 10 })).toBeNull();
    expect(formatPreference({ counts: new Map(), videos: 0 })).toBeNull();
  });
});

describe('what the library has none of (live 2026-11-24: animated posts offered to a "real" library)', () => {
  it('a GENRE common on the forum and (almost) absent from the library: left out; an act never; allowed back by the user; a small library says nothing', () => {
    const { scriptTags } = sampleLibrary();
    scriptTags['C:\\v\\0.mp4'].tags.push('animation');            // one animated video of 20 (5%)
    const lib = libraryTagCounts(scriptTags, {});
    const forum = baselineCounts([
      ...Array.from({ length: 37 }, (_, i) => ({ id: i, tags: ['animation', 'blowjob', 'osr2', 'doggy'] })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, tags: ['hentai', 'real', 'osr2'] })),
      ...Array.from({ length: 11 }, (_, i) => ({ id: 200 + i, tags: ['real'] })),
      { id: 999, tags: ['furry'] },
    ]);
    // animation: 5% of the library vs 61% of the forum: out. hentai: none vs 20%: out.
    // doggy: an act; osr2: a device; furry: too rare to say; real: the library is all real.
    expect(avoidTags(lib, forum).map((x) => x.tag)).toEqual(['animation', 'hentai']);
    expect(GENRES.has('doggy')).toBe(false);
    expect(avoidTags(lib, forum, { allowed: ['hentai'] }).map((x) => x.tag)).toEqual(['animation']);
    expect(avoidTags({ counts: new Map(), videos: 4 }, forum)).toEqual([]);
    const store = new Map();
    const settings = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    setAllowed(settings, 'Hentai');
    expect(readAllowed(settings)).toEqual(['hentai']);
  });
});

describe('which posts are suggested', () => {
  const tags = [{ tag: 'blowjob' }, { tag: 'pov' }];
  const post = (id, t) => ({ id, tags: t });

  it('one of the tags; not had or linked; the library\'s format; no Hide tag; not dismissed', () => {
    const ctx = { tags, format: 'flat', hide: ['animated'], dismissed: { 7: 1 }, have: (tp) => tp.id === 5 };
    expect(passesSuggested(post(1, ['blowjob', 'non-vr']), ctx)).toBe(true);
    expect(passesSuggested(post(2, ['riding']), ctx)).toBe(false);                 // none of the tags
    expect(passesSuggested(post(3, ['pov', 'vr']), ctx)).toBe(false);              // the other format
    expect(passesSuggested(post(4, ['pov', 'animated']), ctx)).toBe(false);        // hidden
    expect(passesSuggested(post(5, ['pov']), ctx)).toBe(false);                    // had / linked
    expect(passesSuggested(post(7, ['pov']), ctx)).toBe(false);                    // Not interested
    expect(passesSuggested(post(8, ['pov', 'vr']), { ...ctx, format: 'vr' })).toBe(true);
    expect(suggestionReason(post(9, ['pov', 'x', 'blowjob']), tags)).toEqual(['blowjob', 'pov']);
    // What the library has none of: out.
    expect(passesSuggested(post(10, ['pov', 'hentai']), { ...ctx, avoid: [{ tag: 'hentai' }] })).toBe(false);
  });

  it('a broad tag alone is not a suggestion; with another, or a specific one, it is', () => {
    const broad = [{ tag: 'real', broad: true }, { tag: 'blowjob' }, { tag: 'straight', broad: true }];
    expect(passesSuggested(post(1, ['real']), { tags: broad })).toBe(false);
    expect(passesSuggested(post(2, ['real', 'straight']), { tags: broad })).toBe(true);
    expect(passesSuggested(post(3, ['blowjob']), { tags: broad })).toBe(true);
  });

  it('Not interested and left-out tags are kept in settings, and can be undone', () => {
    const store = new Map();
    const settings = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    dismissTopic(settings, 42);
    expect(Object.keys(readDismissed(settings))).toEqual(['42']);
    dismissTopic(settings, 42, false);
    expect(readDismissed(settings)).toEqual({});
    setLeftOut(settings, 'Big Ass');
    expect(readLeftOut(settings)).toEqual(['big-ass']);
    setLeftOut(settings, 'big-ass', false);
    expect(readLeftOut(settings)).toEqual([]);
  });
});
