/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The EroScripts tab's own tags and hidden tags (Dave, 2026-11-23: "it would
// be cool if you could search by tag in the eroscripts tab", "and a button
// for no results with for example pmv or animation, we could do the exclude
// tags as a feed option"): renderer/js/eroscripts-browse.js and the feeds.
import { describe, it, expect } from 'vitest';
import { normalizeFilters, filterTags, tagRoom, matchesFilters, passesHidden, decorateQuery, MAX_FILTER_TAGS } from '../../renderer/js/eroscripts-browse.js';
import { normalizeFeed, feedTags, inFeed } from '../../renderer/js/eroscripts-feeds.js';

const topic = (tags) => ({ id: 1, tags, createdAt: '2026-11-23T10:00:00Z', categoryId: 14 });

describe('your own tags', () => {
  it('cleaned to forum slugs, once each, after the choices, within the forum\'s 5', () => {
    const f = normalizeFilters({ video: 'vr', length: 'len-5-10', tags: ['Tentacle', '#pmv', 'pmv', 'vr', 'two words', '!!', 'a', 'b', 'c'] });
    expect(f.tags).toEqual(['tentacle', 'pmv', 'two-words']);
    expect(filterTags(f)).toEqual(['vr', 'len-5-10', 'tentacle', 'pmv', 'two-words']);
    expect(filterTags(f)).toHaveLength(MAX_FILTER_TAGS);
    expect(tagRoom({ video: 'vr', length: 'len-5-10' })).toBe(3);
  });

  it('a search sends the first tag to the forum and checks the rest on the results', () => {
    expect(decorateQuery('goth', { filters: { tags: ['tentacle', 'pmv'] } })).toBe('goth tags:tentacle');
    expect(matchesFilters(topic(['tentacle', 'pmv']), { tags: ['tentacle', 'pmv'] })).toBe(true);
    expect(matchesFilters(topic(['tentacle']), { tags: ['tentacle', 'pmv'] })).toBe(false);
  });
});

describe('hidden tags', () => {
  it('a thread with any hidden tag is left out; a wanted tag wins over a hidden one', () => {
    const f = normalizeFilters({ tags: ['pmv'], hide: ['pmv', 'animation', 'Hentai'] });
    expect(f.hide).toEqual(['animation', 'hentai']);
    expect(matchesFilters(topic(['pmv', 'real']), f)).toBe(true);
    expect(matchesFilters(topic(['pmv', 'animation']), f)).toBe(false);
    expect(passesHidden(topic(['hentai']), f)).toBe(false);
    expect(passesHidden(topic(['real']), f)).toBe(true);
  });

  it('never sent to the forum (it cannot leave several out); a thread with unknown tags is kept', () => {
    expect(filterTags({ hide: ['pmv'] })).toEqual([]);
    expect(decorateQuery('x', { filters: { hide: ['pmv'] } })).toBe('x');
    expect(passesHidden({ id: 2 }, { hide: ['pmv'] })).toBe(true);
  });

  it('the newest list checks only hidden tags (the forum applied the wanted ones, synonyms and all)', () => {
    expect(passesHidden(topic(['vr-synonym']), { video: 'vr', hide: ['pmv'] })).toBe(true);
  });
});

describe('feeds', () => {
  it('a feed made from the tab takes its bar tags as its own tags, and keeps the hidden ones in its filters', () => {
    const feed = normalizeFeed({ name: 'Mine', filters: { video: 'flat', tags: ['tentacle'], hide: ['animation'] }, tags: ['goth'] });
    expect(feed.tags).toEqual(['goth', 'tentacle']);
    expect(feed.filters.tags).toEqual([]);
    expect(feed.filters.hide).toEqual(['animation']);
    expect(feedTags(feed)).toEqual(['non-vr', 'goth', 'tentacle']);
  });

  it('a feed leaves hidden threads out of its list and its new-thread count', () => {
    const feed = normalizeFeed({ name: 'No PMV', filters: { hide: ['pmv', 'animation'] } });
    expect(inFeed(topic(['real']), feed)).toBe(true);
    expect(inFeed(topic(['pmv']), feed)).toBe(false);
    expect(inFeed(topic(['animation', 'real']), feed)).toBe(false);
  });
});
