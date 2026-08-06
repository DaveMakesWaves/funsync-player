// EroScripts search-result parsing, against the REAL response shape.
//
// The fixture below mirrors an actual /search.json payload captured from
// discuss.eroscripts.com (query "sybian", 2026-08-05). That matters: the
// bugs this pins were all "read a field the endpoint doesn't send", which
// an invented fixture would have happily reproduced.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// See eroscripts-auth-expiry.test.js — vi.mock can't silence a CJS require.
const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI } = await import('../../electron/eroscripts-api.js');

let prevFileLevel;
let prevConsoleLevel;
beforeAll(() => {
  prevFileLevel = log.transports.file.level;
  prevConsoleLevel = log.transports.console.level;
  log.transports.file.level = false;
  log.transports.console.level = false;
});
afterAll(() => {
  log.transports.file.level = prevFileLevel;
  log.transports.console.level = prevConsoleLevel;
});

// Note what is ABSENT: no `like_count`, no `views`, no `image_url` on the
// topic. Those omissions are the whole point of the fixture.
const REAL_SHAPE = {
  topics: [{
    id: 300701,
    title: 'Sybian Aiko',
    slug: 'sybian-aiko',
    created_at: '2026-02-17T14:55:35.020Z',
    posts_count: 2,
    tags: [
      { id: 288, name: 'the-handy', slug: 'the-handy' },
      { id: 573, name: 'non-vr', slug: 'non-vr' },
      { id: 435, name: 'len-10-25', slug: 'len-10-25' },
    ],
    thumbnails: [
      { max_width: null, max_height: null, width: 500, height: 250, url: 'https://cdn.example/original.jpeg' },
      { max_width: 400, max_height: 400, width: 400, height: 200, url: 'https://cdn.example/opt_400x200.jpeg' },
      { max_width: 200, max_height: 200, width: 200, height: 100, url: 'https://cdn.example/opt_200x100.jpeg' },
      { max_width: 100, max_height: 100, width: 100, height: 50, url: 'https://cdn.example/opt_100x50.jpeg' },
    ],
    category_id: 14,
  }],
  posts: [{
    id: 709814,
    username: 'Ramie',
    avatar_template: '/letter_avatar_proxy/v4/letter/r/edb3f5/{size}.png',
    created_at: '2026-02-17T14:55:35.570Z',
    like_count: 24,
    post_number: 1,
    topic_id: 300701,
  }],
  users: [],
};

function stubJson(payload) {
  globalThis.fetch = vi.fn(async () => ({
    status: 200,
    ok: true,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    clone() { return this; },
  }));
}

describe('search result parsing (real payload shape)', () => {
  let api;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    stubJson(REAL_SHAPE);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('reads the like count off the POST, not the absent topic field', async () => {
    // Regression: `t.like_count` doesn't exist in a search response, so
    // every result reported 0 likes and the panel (which hides a 0) showed
    // nothing — while the real count sat on the post all along.
    const { results } = await api.search('sybian');
    expect(results[0].likeCount).toBe(24);
  });

  it('normalises tag objects to plain names', async () => {
    const { results } = await api.search('sybian');
    expect(results[0].tags).toEqual(['the-handy', 'non-vr', 'len-10-25']);
  });

  it('takes a thumbnail from thumbnails[], which the topic actually sends', async () => {
    // Regression: this read `t.image_url`, which only exists on the topic
    // endpoint — so search results had no thumbnail and the panel fetched
    // one per row in a second request.
    //
    // Picks the 400px entry: the row renders at 120 CSS px, so 200 would be
    // upscaled on a 2x display.
    const { results } = await api.search('sybian');
    expect(results[0].thumbnail).toBe('https://cdn.example/opt_400x200.jpeg');
  });

  it('falls through to the largest available when nothing meets the floor', async () => {
    // Common in practice — plenty of topics have a ~200px original and no
    // larger derivative.
    stubJson({
      ...REAL_SHAPE,
      topics: [{
        ...REAL_SHAPE.topics[0],
        thumbnails: [
          { width: 200, url: 'https://cdn.example/original_200.jpeg' },
          { width: 100, url: 'https://cdn.example/opt_100.jpeg' },
          { width: 50, url: 'https://cdn.example/opt_50.jpeg' },
        ],
      }],
    });
    const { results } = await api.search('sybian');
    expect(results[0].thumbnail).toBe('https://cdn.example/original_200.jpeg');
  });

  it('leaves views at 0 — the search serializer genuinely omits it', async () => {
    // Documents the limit rather than faking a number. Views live on
    // /t/{id}.json only.
    const { results } = await api.search('sybian');
    expect(results[0].views).toBe(0);
  });

  it('carries through the fields the panel renders', async () => {
    const { results } = await api.search('sybian');
    const r = results[0];
    expect(r.id).toBe(300701);
    expect(r.title).toBe('Sybian Aiko');
    expect(r.creator).toBe('Ramie');
    expect(r.url).toBe('https://discuss.eroscripts.com/t/sybian-aiko/300701');
    // {size} substituted, and the relative path made absolute.
    expect(r.avatar).toBe('https://discuss.eroscripts.com/letter_avatar_proxy/v4/letter/r/edb3f5/90.png');
  });

  it('survives a topic with no thumbnails array', async () => {
    stubJson({ ...REAL_SHAPE, topics: [{ ...REAL_SHAPE.topics[0], thumbnails: undefined }] });
    const { results } = await api.search('sybian');
    expect(results[0].thumbnail).toBeNull();
  });

  it('falls back to the only thumbnail when all are below the size floor', async () => {
    stubJson({
      ...REAL_SHAPE,
      topics: [{ ...REAL_SHAPE.topics[0], thumbnails: [{ width: 60, url: 'https://cdn.example/tiny.jpeg' }] }],
    });
    const { results } = await api.search('sybian');
    expect(results[0].thumbnail).toBe('https://cdn.example/tiny.jpeg');
  });
});

describe('attachment name entity decoding', () => {
  // Attachment names come from the link TEXT of Discourse's rendered HTML,
  // so `&` arrives as `&amp;`. Left encoded, the file saves to disk under
  // the literal `&amp;` AND multi-axis pairing breaks, since that matches a
  // main to its companions by exact base name.
  const cooked = [
    '<a class="attachment" href="/uploads/a.funscript">Luna Snow &amp; Sue Storm.funscript</a>',
    '<a class="attachment" href="/uploads/b.funscript">Luna Snow &amp; Sue Storm.roll.funscript</a>',
    '<a class="attachment" href="/uploads/c.funscript">Caf&#233; &lt;Special&gt;.funscript</a>',
  ].join('');

  let api;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    api = new EroScriptsAPI();
    api.restoreSession('cookie', 'dave');
    stubJson({ post_stream: { posts: [{ cooked }] } });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('decodes named entities so the saved filename is the real one', async () => {
    const { attachments } = await api.getTopicAttachments(1);
    expect(attachments[0].name).toBe('Luna Snow & Sue Storm.funscript');
  });

  it('keeps a main and its axis companion on the same base name', async () => {
    const { attachments } = await api.getTopicAttachments(1);
    expect(attachments[1].name).toBe('Luna Snow & Sue Storm.roll.funscript');
  });

  it('decodes numeric references too', async () => {
    const { attachments } = await api.getTopicAttachments(1);
    expect(attachments[2].name).toBe('Café <Special>.funscript');
  });
});
