// EroScripts API — Discourse REST API client for discuss.eroscripts.com
// Runs in main process (no CORS restrictions).

const log = require('./logger');

const BASE_URL = 'https://discuss.eroscripts.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Diagnostic logging — routes through electron-log so entries land in the
// rotating main log under %APPDATA%/funsync-player/logs/ (5MB cap) instead
// of a hand-rolled file in the install dir that silently fails to write on
// packaged Windows builds (Program Files is read-only).
function _debugLog(msg) {
  try { log.debug(`[EroScripts] ${msg}`); } catch { /* log unavailable */ }
}

/**
 * Pick a thumbnail from a Discourse `thumbnails[]` array.
 *
 * Entries come in several sizes (typically 1366/1920, 1024, 800, 400, 200,
 * 100, 50 px wide, the smaller ones as `optimized/` derivatives). The
 * smallest entry at least `MIN_THUMB_WIDTH` wins — big enough not to look
 * soft, small enough not to pull a full-size image per row.
 *
 * 400 because the row renders the thumbnail at 120 CSS px, which is 240
 * device px on a 2x display: a 200px source would be upscaled and visibly
 * soft there, while 1024+ is wasteful for a 120px slot. Topics whose
 * original is smaller than 400 (plenty are ~200) have no such entry and
 * fall through to the largest they do offer.
 *
 * @param {Array<{width?: number, url?: string}>} thumbnails
 * @returns {string|null}
 */
const MIN_THUMB_WIDTH = 400;

/**
 * Decode the HTML entities Discourse emits inside post markup.
 *
 * Attachment names come from the link TEXT of the rendered `cooked` HTML,
 * so a script called `Luna Snow & Sue Storm.funscript` arrives as
 * `Luna Snow &amp; Sue Storm.funscript` and would be saved to disk under
 * that literal name. That also breaks multi-axis pairing, which matches a
 * main against its companions by exact base name.
 *
 * Deliberately a small explicit table plus numeric refs rather than a DOM
 * round-trip: this runs in the main process, where there is no document.
 */
const _ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(_ENTITIES, key)) return _ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    // Unknown entity — leave it alone rather than mangling the name.
    return whole;
  });
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  const usable = thumbnails.filter(x => x && typeof x.url === 'string' && x.url);
  if (usable.length === 0) return null;
  const big = usable
    .filter(x => Number(x.width) >= MIN_THUMB_WIDTH)
    .sort((a, b) => Number(a.width) - Number(b.width));
  return (big[0] || usable[0]).url;
}

class EroScriptsAPI {
  constructor() {
    this._cookie = null;
    this._username = null;
    this._sessionCookies = '';
  }

  get isLoggedIn() {
    return !!this._cookie;
  }

  get username() {
    return this._username;
  }

  restoreSession(cookie, username) {
    this._cookie = cookie;
    this._username = username;
    this._sessionCookies = cookie ? `_t=${cookie}` : '';
    _debugLog(`SESSION restored for ${username}, cookie length: ${(cookie || '').length}`);
  }

  /**
   * Validate the current session is still active.
   * Makes a lightweight request to check if authenticated.
   * @returns {{ valid: boolean }}
   */
  async validateSession() {
    if (!this._cookie) return { valid: false };

    try {
      // Use the session/current endpoint — lightweight, returns user info if logged in
      const resp = await fetch(`${BASE_URL}/session/current.json`, {
        headers: this._headers(),
      });
      _debugLog(`VALIDATE session status: ${resp.status}`);

      if (resp.status === 403 || resp.status === 401) {
        return { valid: false };
      }
      if (!resp.ok) {
        // Server error (503 etc.) — don't invalidate on transient failures
        return { valid: true };
      }

      const data = await this._safeJson(resp);
      if (!data) {
        // HTML response (Cloudflare) — session likely expired
        return { valid: false };
      }

      // If we get user data back, session is valid
      return { valid: !!data.current_user };
    } catch {
      // Network error — assume valid, don't log out on connectivity issues
      return { valid: true };
    }
  }

  logout() {
    this._cookie = null;
    this._username = null;
    this._sessionCookies = '';
  }

  /**
   * Search for funscript topics.
   */
  async search(query, page = 1) {
    try {
      const params = new URLSearchParams({
        q: `${query} #scripts`,
        page: String(page),
      });

      const resp = await fetch(`${BASE_URL}/search.json?${params}`, {
        headers: this._headers(),
      });

      log.info(`[EroScripts] Search status: ${resp.status} for query: ${query}`);
      _debugLog(`SEARCH query="${query}" status=${resp.status}`);
      _debugLog(`SEARCH cookies sent: ${(this._headers().Cookie || '').length} bytes`);
      if (resp.status !== 200) {
        const bodyPreview = await resp.clone().text();
        _debugLog(`SEARCH error body: ${bodyPreview.substring(0, 500)}`);
      }

      if (resp.status === 429) {
        return { results: [], error: 'Rate limited — try again in a moment' };
      }
      if (resp.status === 403 || resp.status === 401) {
        // `authExpired` is the machine-readable half of this. The message
        // alone forced every caller to string-match, and the auto-match
        // path simply ignored it — so a dead session looked exactly like
        // "this video has no script", silently, for weeks.
        return { results: [], error: 'Access denied — try logging in again', authExpired: true };
      }

      const data = await this._safeJson(resp);
      if (!data) {
        return { results: [], error: `Search failed (${resp.status}) — try logging out and back in` };
      }

      // Log structure for debugging
      log.info('[EroScripts] Search response: topics=%d, posts=%d, users=%d',
        (data.topics || []).length, (data.posts || []).length, (data.users || []).length);
      if (data.topics?.length > 0) {
        const t = data.topics[0];
        // Field list and tags called out on their own lines. The truncated
        // dump below used to cut at 500 chars, which lands before `tags` on
        // almost every topic — so "does search actually return tags?" was
        // unanswerable from the logs, despite the parser and the panel both
        // being wired for them.
        log.info('[EroScripts] Topic fields: %s', Object.keys(t).join(','));
        log.info('[EroScripts] Topic tags: %s', JSON.stringify(t.tags ?? null));
        log.info('[EroScripts] Sample topic:', JSON.stringify(t).substring(0, 1500));
      }
      if (data.posts?.length > 0) {
        const p = data.posts[0];
        log.info('[EroScripts] Sample post:', JSON.stringify(p).substring(0, 500));
      }

      const users = new Map((data.users || []).map(u => [u.id, u]));
      const topicsMap = new Map((data.topics || []).map(t => [t.id, t]));
      const posts = data.posts || [];

      // Build results from whichever is available — topics or posts
      let topics;

      if (data.topics && data.topics.length > 0) {
        // Topics available (some Discourse versions return these)
        topics = data.topics.map(t => {
          const tags = (t.tags || []).map(tag => typeof tag === 'string' ? tag : (tag.name || tag.text || String(tag)));

          const post = posts.find(p => p.topic_id === t.id);
          const user = post ? users.get(post.user_id) : null;

          // Search topics carry `thumbnails[]` (several sizes), NOT the
          // `image_url` this used to read — that field only exists on the
          // topic endpoint, so every search result came back with a null
          // thumbnail and the panel paid for a second request per row to
          // fetch one. Prefer an entry near the rendered size.
          let thumbnail = pickThumbnail(t.thumbnails) || t.image_url || null;
          if (thumbnail && !thumbnail.startsWith('http')) thumbnail = `${BASE_URL}${thumbnail}`;

          let avatar = post?.avatar_template || null;
          if (avatar) {
            avatar = avatar.replace('{size}', '90');
            if (!avatar.startsWith('http')) avatar = `${BASE_URL}${avatar}`;
          }

          return {
            id: t.id, title: t.title, slug: t.slug,
            createdAt: t.created_at,
            // Like count lives on the POST in a search response, not the
            // topic — `t.like_count` doesn't exist there, so this read 0 for
            // every result and the panel (which hides a 0) showed nothing.
            // The post was already being looked up two lines above for the
            // avatar.
            likeCount: post?.like_count ?? t.like_count ?? 0,
            // `views` genuinely isn't in the search serializer — not on the
            // topic and not on the post. It only exists on /t/{id}.json.
            // Left at 0 rather than faked; the panel hides a 0 view count.
            views: t.views || 0,
            tags, thumbnail, avatar,
            creator: post?.username || user?.username || null,
            url: `${BASE_URL}/t/${t.slug || t.id}/${t.id}`,
          };
        });
      } else {
        // No topics — build from posts (EroScripts returns results this way)
        const seen = new Set();
        topics = [];

        for (const post of posts) {
          if (seen.has(post.topic_id)) continue;
          seen.add(post.topic_id);

          const rawTopic = topicsMap.get(post.topic_id);
          const user = users.get(post.user_id);

          // Extract thumbnail from post blurb HTML
          let thumbnail = rawTopic?.image_url || null;
          if (!thumbnail && post.blurb) {
            const imgMatch = post.blurb.match(/<img[^>]+src="([^"]+)"/i);
            if (imgMatch) {
              thumbnail = imgMatch[1];
            }
          }
          if (thumbnail && !thumbnail.startsWith('http')) thumbnail = `${BASE_URL}${thumbnail}`;

          const tags = rawTopic?.tags || [];
          const normTags = tags.map(tag => typeof tag === 'string' ? tag : (tag.name || tag.text || String(tag)));

          // Build avatar URL from template
          let avatar = post.avatar_template || null;
          if (avatar) {
            avatar = avatar.replace('{size}', '90');
            if (!avatar.startsWith('http')) avatar = `${BASE_URL}${avatar}`;
          }

          topics.push({
            id: post.topic_id,
            title: rawTopic?.title || post.name || post.topic?.title || `Topic ${post.topic_id}`,
            slug: rawTopic?.slug || null,
            createdAt: post.created_at,
            likeCount: post.like_count || rawTopic?.like_count || 0,
            views: rawTopic?.views || 0,
            tags: normTags,
            thumbnail,
            avatar,
            creator: post.username || user?.username || null,
            url: `${BASE_URL}/t/${rawTopic?.slug || post.topic_id}/${post.topic_id}`,
          });
        }
      }

      return { results: topics };
    } catch (err) {
      log.error('[EroScripts] Search error:', err.message);
      return { results: [], error: err.message };
    }
  }

  /**
   * Get attachments from a topic's first post.
   */
  async getTopicAttachments(topicId) {
    try {
      const resp = await fetch(`${BASE_URL}/t/${topicId}.json`, {
        headers: this._headers(),
      });

      if (resp.status === 429) {
        return { attachments: [], error: 'Rate limited' };
      }
      if (resp.status === 403 || resp.status === 401) {
        return { attachments: [], error: 'Access denied — try logging in again', authExpired: true };
      }

      const data = await this._safeJson(resp);
      if (!data) {
        return { attachments: [], error: `Failed to load topic (${resp.status})` };
      }

      const firstPost = data.post_stream?.posts?.[0];
      if (!firstPost) {
        return { attachments: [], error: 'No posts found' };
      }

      const attachments = [];
      const html = firstPost.cooked || '';

      // Match Discourse attachment links
      const attachRegex = /<a[^>]*class="attachment"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      let match;
      while ((match = attachRegex.exec(html)) !== null) {
        const href = match[1];
        const name = decodeEntities(match[2].trim());
        if (name.endsWith('.funscript') || name.endsWith('.zip')) {
          const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          attachments.push({ name, url });
        }
      }

      // Also check for upload:// short URLs
      const shortUrlRegex = /href="(upload:\/\/[^"]+)"/gi;
      const shortUrls = [];
      while ((match = shortUrlRegex.exec(html)) !== null) {
        shortUrls.push(match[1]);
      }

      if (shortUrls.length > 0) {
        try {
          const lookupResp = await fetch(`${BASE_URL}/uploads/lookup-urls`, {
            method: 'POST',
            headers: { ...this._headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ short_urls: shortUrls }),
          });
          if (lookupResp.ok) {
            const resolved = await lookupResp.json();
            for (const item of resolved) {
              if (item.url && (item.url.endsWith('.funscript') || item.url.endsWith('.zip'))) {
                attachments.push({
                  name: item.url.split('/').pop(),
                  url: item.url.startsWith('http') ? item.url : `${BASE_URL}${item.url}`,
                });
              }
            }
          }
        } catch { /* ignore */ }
      }

      return { attachments };
    } catch (err) {
      log.error('[EroScripts] Topic error:', err.message);
      return { attachments: [], error: err.message };
    }
  }

  /**
   * Fetch the first image URL from a topic's first post.
   * Used for lazy thumbnail loading in search results.
   */
  async getTopicImage(topicId) {
    try {
      const resp = await fetch(`${BASE_URL}/t/${topicId}.json`, {
        headers: this._headers(),
      });
      const data = await this._safeJson(resp);
      if (!data) return null;

      const html = data.post_stream?.posts?.[0]?.cooked || '';
      const imgMatch = html.match(/<img[^>]+src="([^"]+\.(jpg|jpeg|png|gif|webp)(\?[^"]*)?)"/i);
      if (imgMatch) {
        let url = imgMatch[1];
        if (!url.startsWith('http')) url = `${BASE_URL}${url}`;
        return url;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Download a file from a URL.
   */
  async downloadFile(url, savePath) {
    const fs = require('fs');
    try {
      const resp = await fetch(url, { headers: this._headers() });
      if (!resp.ok) {
        return { success: false, error: `Download failed (${resp.status})` };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(savePath, buffer);
      log.info(`[EroScripts] Downloaded: ${savePath}`);
      return { success: true };
    } catch (err) {
      log.error('[EroScripts] Download error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // --- Internal ---

  _headers() {
    const h = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
    // Send all session cookies (includes _t + Cloudflare cf_clearance etc.)
    if (this._sessionCookies) {
      h['Cookie'] = this._sessionCookies;
    } else if (this._cookie) {
      h['Cookie'] = `_t=${this._cookie}`;
    }
    return h;
  }

  async _safeJson(resp) {
    try {
      const text = await resp.text();
      // Guard against HTML responses (DOCTYPE, login redirects, etc.)
      if (text.startsWith('<!') || text.startsWith('<html')) {
        log.warn('[EroScripts] Received HTML instead of JSON');
        _debugLog(`HTML response (${resp.status}): ${text.substring(0, 300)}`);
        return null;
      }
      return JSON.parse(text);
    } catch (err) {
      _debugLog(`JSON parse error: ${err.message}`);
      return null;
    }
  }

}

module.exports = { EroScriptsAPI };
