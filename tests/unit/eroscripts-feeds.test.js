/**
 * @vitest-environment node
 * No DOM required: the feed rules and the background checker take their
 * settings and forum calls injected. See notes/CLAUDE.md "Test environments".
 *
 * Feeds (Dave, 2026-11-22: "custom queues based on tags and other things ...
 * a badge for new ones showing the number"; notes/features/SCOPE-eroscripts-feeds.md).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseTags, normalizeFeed, feedTags, feedRequest, inFeed, countNew, badgeText, defaultFeedName,
  FeedChecker, SETTING_FEEDS, MAX_TAGS, CHECK_GAP_MS,
} from '../../renderer/js/eroscripts-feeds.js';

const label = (kind, v) => `${kind}:${v}`;

describe('feed rules', () => {
  it('tags are forum slugs, each once', () => {
    expect(parseTags('pmv, #Hentai  multi-axis,pmv, bad tag!, ')).toEqual(['pmv', 'hentai', 'multi-axis', 'bad']);   // 'tag!' is not a tag
    expect(parseTags('')).toEqual([]);
  });

  it('a stored feed is made whole; odd values fall back', () => {
    const f = normalizeFeed({ price: 'nope', filters: { video: 'vr', length: 'len-9-9' }, tags: ['vr', 'pmv'], words: '  two   words ', notify: 'yes', newCount: -3 }, Date.UTC(2026, 10, 22));
    expect(f).toMatchObject({ price: 'all', filters: { video: 'vr', length: 'any', device: 'any' }, tags: ['pmv'], words: 'two words', notify: false, newCount: 0 });
    expect(f.id).toMatch(/^f/);
    expect(f.lastSeenAt).toBe(f.createdAt);
  });

  it('at most 5 tags in all, the filters\' first', () => {
    const f = normalizeFeed({ filters: { video: 'vr', length: 'len-10-25', device: 'multi' }, tags: ['a1', 'b2', 'c3', 'd4'] });
    expect(feedTags(f)).toEqual(['vr', 'len-10-25', 'multi-axis', 'a1', 'b2']);
    expect(feedTags(f)).toHaveLength(MAX_TAGS);
  });

  it('a feed without words reads the newest list with its tags; with words, a search newest first', () => {
    const latest = normalizeFeed({ price: 'free', filters: { video: 'vr' }, tags: ['pmv'] });
    expect(feedRequest(latest)).toEqual({ kind: 'latest', price: 'free', opts: { sort: 'newest', period: 'all', tags: ['vr', 'pmv'] }, tags: ['vr', 'pmv'] });
    const search = normalizeFeed({ price: 'paid', tags: ['pmv', 'hmv'], words: 'cock hero' });
    expect(feedRequest(search)).toEqual({ kind: 'search', query: 'cock hero #paid-scripts in:title tags:pmv order:latest_topic', tags: ['pmv', 'hmv'] });
  });

  it('a search result belongs when it carries every tag and the price', () => {
    const feed = normalizeFeed({ price: 'free', tags: ['pmv', 'hmv'] });
    expect(inFeed({ categoryId: 14, tags: ['pmv', 'hmv', 'x'] }, feed)).toBe(true);
    expect(inFeed({ categoryId: 14, tags: ['pmv'] }, feed)).toBe(false);
    expect(inFeed({ categoryId: 15, tags: ['pmv', 'hmv'] }, feed)).toBe(false);
  });

  it('new = started after it was last opened; a whole page new reads "30+"', () => {
    const since = '2026-11-22T10:00:00Z';
    const page = [{ createdAt: '2026-11-22T11:00:00Z' }, { createdAt: '2026-11-22T09:00:00Z' }, { createdAt: 'bad' }];
    expect(countNew(page, since, 30)).toEqual({ count: 1, full: false });
    const full = Array.from({ length: 30 }, () => ({ createdAt: '2026-11-22T12:00:00Z' }));
    expect(countNew(full, since, 30)).toEqual({ count: 30, full: true });
    expect(badgeText({ newCount: 30, full: true })).toBe('30+');
    expect(badgeText({ newCount: 2 })).toBe('2');
    expect(badgeText({ newCount: 0 })).toBe('');
  });

  it('a feed saved without a name is named after its parts', () => {
    expect(defaultFeedName(normalizeFeed({ words: 'pmv', tags: ['hmv'], filters: { video: 'vr' }, price: 'free' }), label)).toBe('"pmv" · hmv · video:vr · price:free');
    expect(defaultFeedName(normalizeFeed({}), label)).toBe('all:');
  });
});

describe('the background checker', () => {
  function setup(feeds, answers) {
    const store = new Map([[SETTING_FEEDS, feeds]]);
    const settings = { get: (k) => store.get(k), set: vi.fn((k, v) => store.set(k, v)) };
    const latest = vi.fn(async (price, page, opts) => answers.latest?.(price, page, opts) ?? { results: [] });
    const search = vi.fn(async (q, page) => answers.search?.(q, page) ?? { results: [] });
    const waits = [];
    const checker = new FeedChecker({
      settings, latest, search, onMore: vi.fn(), onChange: vi.fn(),
      now: () => Date.UTC(2026, 10, 22, 12), wait: async (ms) => { waits.push(ms); },
    });
    return { store, settings, latest, search, checker, waits };
  }
  const NEW = '2026-11-22T11:00:00Z';
  const OLD = '2026-11-20T11:00:00Z';

  it('each feed in turn, a gap between; counts what came since it was last opened; notifies only when it grows', async () => {
    const feeds = [
      { id: 'a', name: 'PMV', tags: ['pmv'], lastSeenAt: '2026-11-21T00:00:00Z', notify: true },
      { id: 'b', name: 'Quiet', words: 'cock hero', lastSeenAt: '2026-11-21T00:00:00Z' },
    ];
    const { store, latest, search, checker, waits } = setup(feeds, {
      latest: () => ({ results: [{ id: 1, createdAt: NEW, tags: ['pmv'] }, { id: 2, createdAt: OLD, tags: ['pmv'] }] }),
      search: () => ({ results: [{ id: 3, createdAt: NEW, categoryId: 14, tags: [] }] }),
    });
    await checker.checkAll();
    expect(latest).toHaveBeenCalledWith('all', 0, { sort: 'newest', period: 'all', tags: ['pmv'] });
    expect(search).toHaveBeenCalledWith('cock hero in:title order:latest_topic', 1);
    expect(waits).toEqual([CHECK_GAP_MS]);
    const saved = store.get(SETTING_FEEDS);
    expect(saved.map((f) => [f.id, f.newCount])).toEqual([['a', 1], ['b', 1]]);
    expect(checker.totalNew()).toBe(2);
    expect(checker._onMore).toHaveBeenCalledTimes(1);                      // only 'a' asked to be told
    expect(checker._onMore.mock.calls[0][1]).toBe(1);
    await checker.checkAll();                                              // the same count: not again
    expect(checker._onMore).toHaveBeenCalledTimes(1);
  });

  it('a feed opened while its check was out keeps its new "last opened" time (and 0 new)', async () => {
    const { store, checker } = setup([{ id: 'a', tags: ['pmv'], lastSeenAt: '2026-11-21T00:00:00Z' }], {
      latest: () => {
        // The user opens the feed meanwhile.
        checker.update('a', { lastSeenAt: '2026-11-22T11:30:00Z', newCount: 0 });
        return { results: [{ createdAt: NEW, tags: ['pmv'] }] };
      },
    });
    await checker.checkOne('a');
    const f = store.get(SETTING_FEEDS)[0];
    expect(f.lastSeenAt).toBe('2026-11-22T11:30:00.000Z');
    expect(f.newCount).toBe(0);                                            // 11:00 is before 11:30
  });

  it('a failed answer changes nothing; logged out, nothing is asked', async () => {
    const { store, latest, checker } = setup([{ id: 'a', tags: ['pmv'], newCount: 4 }], { latest: () => ({ error: 'x', results: [] }) });
    await checker.checkAll();
    expect(store.get(SETTING_FEEDS)[0].newCount).toBe(4);
    checker._loggedIn = () => false;
    latest.mockClear();
    await checker.checkAll();
    expect(latest).not.toHaveBeenCalled();
  });

  it('checks when stale only; never two runs at once', async () => {
    const { latest, checker } = setup([{ id: 'a', tags: ['pmv'], checkedAt: new Date(Date.UTC(2026, 10, 22, 11, 58)).toISOString() }], {});
    await checker.checkIfStale();
    expect(latest).not.toHaveBeenCalled();                                 // checked 2 minutes ago
    checker._settings.set(SETTING_FEEDS, [{ id: 'a', tags: ['pmv'], checkedAt: '2026-11-22T10:00:00Z' }]);
    const one = checker.checkAll();
    const two = checker.checkAll();
    expect(one).toBe(two);
    await one;
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
