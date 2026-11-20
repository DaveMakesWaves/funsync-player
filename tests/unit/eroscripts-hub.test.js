/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A creator's INDEX / hub post on EroScripts (found 2026-11-19 by Dave):
// what says "hub" (title, slug, known id, learned this session), which saved
// records count as "not linked" (a hub you did not pick), and the order Find
// the post shows its results in. Pure module; no forum.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isHubTitle, slugOfTopicUrl, isHubTopic, isAutoHubRecord, isUserPickedMatch, learnHubTopic,
  learnedHubCreator, orderLinkResults, KNOWN_HUB_TOPICS, _forgetLearnedHubsForTests,
} from '../../renderer/js/eroscripts-hub.js';

beforeEach(() => _forgetLearnedHubsForTests());

describe('isHubTitle', () => {
  it('reads the index / hub titles creators use, in titles and in slugs', () => {
    for (const title of [
      'Testmaker - Script Index', 'Testmaker Content Hub', 'testmaker-script-index', 'testmaker-content-hub',
      'Index of my scripts', 'My Scripts', 'All of my scripts (updated)', 'Testmaker’s Scripts [Index]',
      'Script collection', 'Collection of all my scripts', 'Master list', 'Scripts Hub', 'SCRIPT INDEX',
    ]) {
      expect(isHubTitle(title), title).toBe(true);
    }
  });

  it('a video\'s own post is not a hub', () => {
    for (const title of [
      'Lumen Rooftop Sunset', 'Lumen Rooftop Sunset [Multi-Axis]', 'Index finger tease', 'Collection day',
      'Scripted Scene 4', 'PornHub compilation', 'My script for Lumen', 'Hub city nights', '', '   ',
    ]) {
      expect(isHubTitle(title), title).toBe(false);
    }
    expect(isHubTitle(null)).toBe(false);
    expect(isHubTitle(42)).toBe(false);
    expect(isHubTitle(`script index ${'x'.repeat(2000)}`)).toBe(false); // too long to be a title
  });
});

describe('slugOfTopicUrl', () => {
  it('reads the slug of a forum topic link, nothing else', () => {
    expect(slugOfTopicUrl('https://discuss.eroscripts.com/t/testmaker-script-index/900001')).toBe('testmaker-script-index');
    expect(slugOfTopicUrl('https://discuss.eroscripts.com/t/testmaker-script-index/900001/45')).toBe('testmaker-script-index');
    expect(slugOfTopicUrl('https://discuss.eroscripts.com/t/900001')).toBeNull();
    expect(slugOfTopicUrl('https://discuss.eroscripts.com/t/900001/4')).toBeNull();
    expect(slugOfTopicUrl('https://evil.example/t/script-index/900001')).toBeNull();
    expect(slugOfTopicUrl('not a link')).toBeNull();
    expect(slugOfTopicUrl(null)).toBeNull();
  });
});

describe('isHubTopic', () => {
  it('by title, by slug (given or in the link), by known id, by a hub learned this session', () => {
    expect(isHubTopic({ topicId: 900001, title: 'Testmaker - Script Index' })).toBe(true);
    expect(isHubTopic({ topicId: 900001, slug: 'testmaker-content-hub' })).toBe(true);
    expect(isHubTopic({ topicId: 900001, url: 'https://discuss.eroscripts.com/t/testmaker-script-index/900001' })).toBe(true);
    expect(isHubTopic({ topicId: KNOWN_HUB_TOPICS[0], url: `https://discuss.eroscripts.com/t/${KNOWN_HUB_TOPICS[0]}` })).toBe(true);
    expect(isHubTopic({ id: String(KNOWN_HUB_TOPICS[1]) })).toBe(true);

    const bare = { topicId: 900009, url: 'https://discuss.eroscripts.com/t/900009' };
    expect(isHubTopic(bare)).toBe(false);
    learnHubTopic(900009, { creator: '@Testmaker' });
    expect(isHubTopic(bare)).toBe(true);
    expect(learnedHubCreator(900009)).toBe('Testmaker');
    _forgetLearnedHubsForTests();
    expect(isHubTopic(bare)).toBe(false);
  });

  it('a video\'s own post, or nothing, is not a hub', () => {
    expect(isHubTopic({ topicId: 900002, title: 'Lumen Rooftop Sunset', url: 'https://discuss.eroscripts.com/t/lumen-rooftop-sunset/900002' })).toBe(false);
    expect(isHubTopic(null)).toBe(false);
    expect(isHubTopic({})).toBe(false);
  });
});

describe('isAutoHubRecord: a saved record about a hub you did not pick', () => {
  const hub = { topicId: 900001, title: 'Testmaker - Script Index', topicUrl: 'https://discuss.eroscripts.com/t/testmaker-script-index/900001' };

  it('a download from the hub, or a Get tags of the script\'s own hub link: not linked', () => {
    for (const match of ['download', 'topic_url', 'script_url', undefined]) {
      expect(isAutoHubRecord({ ...hub, match }), String(match)).toBe(true);
    }
    // Known by its slug alone (an older record with no title).
    expect(isAutoHubRecord({ topicId: 900001, topicUrl: hub.topicUrl })).toBe(true);
  });

  it('a post you picked (Paste a post link, Find the post) is yours: kept, hub or not', () => {
    expect(isUserPickedMatch('manual')).toBe(true);
    expect(isUserPickedMatch('search')).toBe(true);
    expect(isUserPickedMatch('download')).toBe(false);
    expect(isAutoHubRecord({ ...hub, match: 'manual' })).toBe(false);
    expect(isAutoHubRecord({ ...hub, match: 'search' })).toBe(false);
  });

  it('a record about a video\'s own post, or not a record, is not one', () => {
    expect(isAutoHubRecord({ topicId: 900002, title: 'Lumen Rooftop Sunset', match: 'download' })).toBe(false);
    expect(isAutoHubRecord(null)).toBe(false);
    expect(isAutoHubRecord(['Testmaker - Script Index'])).toBe(false);
  });
});

describe('orderLinkResults (Find the post)', () => {
  const hub = { id: 900001, title: 'Testmaker - Script Index', creator: 'Testmaker' };
  const other = { id: 900003, title: 'Lumen Rooftop Sunset (alt cut)', creator: 'Otherscripter' };
  const own = { id: 900002, title: 'Lumen Rooftop Sunset', creator: 'Testmaker' };
  const fourth = { id: 900004, title: 'Lumen Rooftop Sunset remake', creator: 'Third' };

  it('the script\'s creator first, then the rest in the forum\'s order, hub posts last; nothing left out', () => {
    expect(orderLinkResults([hub, other, own, fourth], 'testmaker').map((r) => r.id))
      .toEqual([900002, 900003, 900004, 900001]);
  });

  it('with no creator named, only the hubs move (to the end)', () => {
    expect(orderLinkResults([hub, other, own], null).map((r) => r.id)).toEqual([900003, 900002, 900001]);
    expect(orderLinkResults([other, own], '  ').map((r) => r.id)).toEqual([900003, 900002]);
  });

  it('not a list: an empty one', () => {
    expect(orderLinkResults(null, 'x')).toEqual([]);
  });
});
