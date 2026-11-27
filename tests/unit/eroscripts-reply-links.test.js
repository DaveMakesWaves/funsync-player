/**
 * @vitest-environment node
 * No DOM required: extractReplyLinks is a pure function of the topic JSON.
 *
 * Dave, 2026-11-22: "sometimes the original link dies and someone comments a
 * replacement link, so ... a list of the links commented ordered by date".
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractReplyLinks } = require('../../electron/eroscripts-api.js');

const post = (n, created, user, cooked) => ({ post_number: n, created_at: created, username: user, cooked });

describe('links in the replies', () => {
  it('newest first, each once, none the first post has, quotes and forum links left out', () => {
    const posts = [
      post(1, '2025-01-01T00:00:00Z', 'maker', '<a href="https://pixeldrain.com/u/orig">video</a>'),
      post(2, '2025-02-01T00:00:00Z', 'a', '<aside class="quote no-group" data-post="1"><blockquote><a href="https://pixeldrain.com/u/orig">video</a></blockquote></aside>dead?'),
      post(3, '2025-03-01T00:00:00Z', 'b', 'reup <a href="https://mega.nz/file/abc#k">mega</a> and <a href="https://discuss.eroscripts.com/t/5">another post</a>'),
      post(9, '2026-05-03T10:00:00Z', 'c', 'new one <a href="https://pixeldrain.com/u/new">here</a> <a href="https://mega.nz/file/abc#k">same mega</a>'),
    ];
    const links = extractReplyLinks(posts, ['https://pixeldrain.com/u/orig']);
    expect(links.map((l) => [l.url, l.postNumber, l.username])).toEqual([
      ['https://pixeldrain.com/u/new', 9, 'c'],
      ['https://mega.nz/file/abc#k', 9, 'c'],          // its newest mention
    ]);
    expect(links[0].createdAt).toBe('2026-05-03T10:00:00Z');
  });

  it('no replies, or nothing usable: an empty list', () => {
    expect(extractReplyLinks([post(1, '', 'm', '<a href="https://x.example/v.mp4">v</a>')])).toEqual([]);
    expect(extractReplyLinks(null)).toEqual([]);
  });
});

describe('the newest threads list (latestTopicsToResults)', () => {
  const { latestTopicsToResults } = require('../../electron/eroscripts-api.js');
  it('free and paid script threads only, pinned left out, the original poster as creator', () => {
    const data = {
      users: [{ id: 1, username: 'maker', avatar_template: '/user_avatar/x/maker/{size}/1.png' }, { id: 2, username: 'replier' }],
      topic_list: { more_topics_url: '/c/14/l/latest?page=1', topics: [
        { id: 10, title: 'About the Free Scripts category', category_id: 14, pinned: true, posters: [] },
        { id: 11, title: 'A free one', slug: 'a-free-one', category_id: 14, like_count: 3, tags: [{ name: 'pmv' }], image_url: 'https://cdn.example/a.jpg',
          posters: [{ user_id: 2, description: 'Frequent Poster' }, { user_id: 1, description: 'Original Poster' }] },
        { id: 12, title: 'A paid one', category_id: 15, posters: [{ user_id: 1, description: 'Original Poster, Most Recent Poster' }] },
        { id: 13, title: 'A request', category_id: 21, posters: [] },
      ] },
    };
    const out = latestTopicsToResults(data);
    expect(out.map((r) => [r.id, r.categoryId, r.creator])).toEqual([[11, 14, 'maker'], [12, 15, 'maker']]);
    expect(out[0]).toMatchObject({ title: 'A free one', likeCount: 3, tags: ['pmv'], thumbnail: 'https://cdn.example/a.jpg',
      url: 'https://discuss.eroscripts.com/t/a-free-one/11', avatar: 'https://discuss.eroscripts.com/user_avatar/x/maker/90/1.png' });
  });
});

describe('a video embedded in the post (2026-11-22: an erosync.net player, and the tab said "no video")', () => {
  const { extractExternalLinks } = require('../../electron/eroscripts-api.js');
  it('an iframe player counts as one of the post\'s links, in order, once', () => {
    const cooked = '<p>Preview</p><iframe src="https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f" width="640" height="360" frameborder="0" allowfullscreen=""></iframe>'
      + '<p><a href="https://www.pornhub.com/view_video.php?viewkey=x">Pornhub</a></p>'
      + '<iframe src="https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f"></iframe>'
      + '<a class="attachment" href="/uploads/short-url/a.funscript">a.funscript</a>';
    expect(extractExternalLinks(cooked)).toEqual([
      { url: 'https://erosync.net/embed/abc6d128-7035-44d3-88a4-64dd63a2bc5f', text: '' },
      { url: 'https://www.pornhub.com/view_video.php?viewkey=x', text: 'Pornhub' },
    ]);
  });
});
