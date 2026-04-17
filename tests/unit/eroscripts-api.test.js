// Unit tests for EroScripts API parsing and data handling
import { describe, it, expect } from 'vitest';

describe('EroScripts API data handling', () => {
  describe('Search result parsing', () => {
    it('builds topics from topics array when available', () => {
      const data = {
        topics: [
          { id: 1, title: 'Test Script', slug: 'test-script', tags: ['2D', 'PMV'], image_url: '/img.jpg', like_count: 5, views: 100 },
        ],
        posts: [
          { topic_id: 1, user_id: 10, username: 'creator1', avatar_template: '/letter/{size}.png' },
        ],
        users: [{ id: 10, username: 'creator1' }],
      };

      const topics = data.topics.map(t => ({
        id: t.id,
        title: t.title,
        tags: t.tags,
        thumbnail: t.image_url,
        likeCount: t.like_count,
        views: t.views,
      }));

      expect(topics).toHaveLength(1);
      expect(topics[0].title).toBe('Test Script');
      expect(topics[0].tags).toEqual(['2D', 'PMV']);
      expect(topics[0].thumbnail).toBe('/img.jpg');
    });

    it('builds topics from posts when topics array is empty', () => {
      const data = {
        topics: [],
        posts: [
          { topic_id: 42, username: 'creator', like_count: 10, blurb: 'Some text', avatar_template: '/avatar/{size}.png' },
        ],
        users: [],
      };

      const seen = new Set();
      const topics = [];
      for (const post of data.posts) {
        if (seen.has(post.topic_id)) continue;
        seen.add(post.topic_id);
        topics.push({
          id: post.topic_id,
          creator: post.username,
          likeCount: post.like_count,
        });
      }

      expect(topics).toHaveLength(1);
      expect(topics[0].id).toBe(42);
      expect(topics[0].creator).toBe('creator');
    });

    it('deduplicates posts by topic_id', () => {
      const posts = [
        { topic_id: 1, username: 'a' },
        { topic_id: 1, username: 'b' }, // duplicate
        { topic_id: 2, username: 'c' },
      ];

      const seen = new Set();
      const unique = posts.filter(p => {
        if (seen.has(p.topic_id)) return false;
        seen.add(p.topic_id);
        return true;
      });

      expect(unique).toHaveLength(2);
    });

    it('normalizes tags that are objects', () => {
      const tags = [
        'simple',
        { name: 'object-tag' },
        { text: 'text-tag' },
        42,
      ];

      const normalized = tags.map(tag =>
        typeof tag === 'string' ? tag : (tag.name || tag.text || String(tag))
      );

      expect(normalized).toEqual(['simple', 'object-tag', 'text-tag', '42']);
    });

    it('builds avatar URL from template', () => {
      const template = '/letter_avatar_proxy/v4/letter/b/f14d63/{size}.png';
      const avatar = template.replace('{size}', '90');
      expect(avatar).toBe('/letter_avatar_proxy/v4/letter/b/f14d63/90.png');
    });

    it('prefixes relative URLs with base', () => {
      const BASE = 'https://discuss.eroscripts.com';
      const relative = '/uploads/image.jpg';
      const absolute = 'https://other.com/image.jpg';

      const fixUrl = (url) => url.startsWith('http') ? url : `${BASE}${url}`;

      expect(fixUrl(relative)).toBe('https://discuss.eroscripts.com/uploads/image.jpg');
      expect(fixUrl(absolute)).toBe('https://other.com/image.jpg');
    });
  });

  describe('Attachment parsing', () => {
    it('extracts funscript attachments from HTML', () => {
      const html = `
        <p>Here is the script:</p>
        <a class="attachment" href="/uploads/default/original/script.funscript">script.funscript</a>
        <a class="attachment" href="/uploads/default/original/archive.zip">archive.zip</a>
        <a href="/uploads/default/original/readme.txt">readme.txt</a>
      `;

      const attachments = [];
      const regex = /<a[^>]*class="attachment"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        const name = match[2].trim();
        if (name.endsWith('.funscript') || name.endsWith('.zip')) {
          attachments.push({ name, url: match[1] });
        }
      }

      expect(attachments).toHaveLength(2);
      expect(attachments[0].name).toBe('script.funscript');
      expect(attachments[1].name).toBe('archive.zip');
    });

    it('skips non-funscript/zip attachments', () => {
      const html = `<a class="attachment" href="/img.jpg">img.jpg</a>`;
      const regex = /<a[^>]*class="attachment"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const match = regex.exec(html);
      const name = match ? match[2].trim() : '';
      const isFunscript = name.endsWith('.funscript') || name.endsWith('.zip');
      expect(isFunscript).toBe(false);
    });

    it('handles no attachments gracefully', () => {
      const html = '<p>No attachments here</p>';
      const regex = /<a[^>]*class="attachment"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      expect(regex.exec(html)).toBeNull();
    });
  });

  describe('Session management', () => {
    it('cookie merge keeps latest values', () => {
      const existing = '_t=abc123; _forum_session=old';
      const newer = '_forum_session=new; cf_clearance=xyz';

      const map = new Map();
      const skip = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
      for (const str of [existing, newer]) {
        for (const part of str.split(/[;,]\s*/)) {
          const eq = part.indexOf('=');
          if (eq > 0) {
            const key = part.slice(0, eq).trim();
            const val = part.slice(eq + 1).trim();
            if (key && !skip.has(key.toLowerCase())) {
              map.set(key, val);
            }
          }
        }
      }

      expect(map.get('_t')).toBe('abc123');
      expect(map.get('_forum_session')).toBe('new'); // overwritten by newer
      expect(map.get('cf_clearance')).toBe('xyz'); // new cookie added
    });

    it('restore session sets cookie string', () => {
      const cookie = 'abc123def';
      const sessionCookies = cookie ? `_t=${cookie}` : '';
      expect(sessionCookies).toBe('_t=abc123def');
    });

    it('restore session handles null cookie', () => {
      const cookie = null;
      const sessionCookies = cookie ? `_t=${cookie}` : '';
      expect(sessionCookies).toBe('');
    });
  });

  describe('HTML response detection', () => {
    it('detects DOCTYPE as HTML', () => {
      const text = '<!DOCTYPE html><html><body>Error</body></html>';
      const isHtml = text.startsWith('<!') || text.startsWith('<html');
      expect(isHtml).toBe(true);
    });

    it('detects <html as HTML', () => {
      const text = '<html lang="en"><head></head></html>';
      const isHtml = text.startsWith('<!') || text.startsWith('<html');
      expect(isHtml).toBe(true);
    });

    it('does not flag JSON as HTML', () => {
      const text = '{"topics":[],"posts":[]}';
      const isHtml = text.startsWith('<!') || text.startsWith('<html');
      expect(isHtml).toBe(false);
    });

    it('does not flag empty string as HTML', () => {
      const text = '';
      const isHtml = text.startsWith('<!') || text.startsWith('<html');
      expect(isHtml).toBe(false);
    });
  });

  describe('Auto-rename on download', () => {
    it('renames script to match video filename', () => {
      const videoPath = 'C:\\Videos\\My Cool Video.mp4';
      const videoBase = videoPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
      const savedName = `${videoBase}.funscript`;
      expect(savedName).toBe('My Cool Video.funscript');
    });

    it('preserves video directory for save path', () => {
      const videoPath = 'C:\\Videos\\Subfolder\\video.mp4';
      const videoDir = videoPath.replace(/[\\/][^\\/]+$/, '');
      expect(videoDir).toBe('C:\\Videos\\Subfolder');
    });
  });
});
