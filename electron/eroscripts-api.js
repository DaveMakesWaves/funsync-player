// EroScripts API — Discourse REST API client for discuss.eroscripts.com
// Runs in main process (no CORS restrictions).

const log = require('./logger');

const BASE_URL = 'https://discuss.eroscripts.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class EroScriptsAPI {
  constructor() {
    this._cookie = null;
    this._username = null;
    this._csrfToken = null;
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
  }

  /**
   * Step 1: Log in with username and password.
   * Returns { success, requires2FA, nonce, username, cookie, error }
   */
  async login(username, password) {
    try {
      // Get CSRF token
      const csrfResp = await fetch(`${BASE_URL}/session/csrf.json`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      });
      if (!csrfResp.ok) {
        return { success: false, error: `Failed to reach EroScripts (${csrfResp.status})` };
      }

      const csrfData = await this._safeJson(csrfResp);
      if (!csrfData || !csrfData.csrf) {
        return { success: false, error: 'Failed to get CSRF token' };
      }

      this._csrfToken = csrfData.csrf;
      this._sessionCookies = this._extractCookies(csrfResp);

      // Attempt login
      const loginResp = await fetch(`${BASE_URL}/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': this._csrfToken,
          'Cookie': this._sessionCookies,
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
        },
        body: `login=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
        redirect: 'manual',
      });

      const data = await this._safeJson(loginResp);
      if (!data) {
        return { success: false, error: `Unexpected response from EroScripts (${loginResp.status})` };
      }

      log.info('[EroScripts] Login response:', JSON.stringify(data));

      // Merge cookies from login response
      const loginCookies = this._extractCookies(loginResp);
      if (loginCookies) {
        this._sessionCookies = this._mergeCookies(this._sessionCookies, loginCookies);
      }

      // Check for 2FA requirement — Discourse returns this in multiple ways
      const nonce = data.second_factor_challenge_nonce;
      const is2FA = nonce ||
        data.reason === 'invalid_second_factor' ||
        data.reason === 'second_factor_required' ||
        (data.error && (data.error.includes('two-factor') || data.error.includes('2fa') || data.error.includes('second factor')));

      if (is2FA) {
        log.info('[EroScripts] 2FA required, nonce:', nonce ? 'present' : 'missing');
        return {
          success: false,
          requires2FA: true,
          nonce: nonce || null,
          totpEnabled: data.totp_enabled !== false,
          backupEnabled: !!data.backup_enabled,
          securityKeyEnabled: !!data.security_key_enabled,
          error: data.error || '2FA code required',
        };
      }

      // Check for errors
      if (data.error) {
        return { success: false, error: data.error };
      }

      // Success — extract session cookie
      return this._completeLogin(data, username);
    } catch (err) {
      log.error('[EroScripts] Login error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Step 2: Submit 2FA TOTP code.
   * Gets a fresh CSRF token, then re-submits login with the 2FA token included.
   */
  async verify2FA(nonce, token, username, password) {
    try {
      // Always get a fresh CSRF token (the previous one was consumed by the login attempt)
      log.info('[EroScripts] 2FA: fetching fresh CSRF token');
      const csrfResp = await fetch(`${BASE_URL}/session/csrf.json`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Cookie': this._sessionCookies },
      });
      const csrfData = await this._safeJson(csrfResp);
      if (csrfData?.csrf) {
        this._csrfToken = csrfData.csrf;
        this._sessionCookies = this._mergeCookies(this._sessionCookies, this._extractCookies(csrfResp));
      }

      let resp;

      if (nonce) {
        // Nonce-based flow: POST to /session/2fa
        log.info('[EroScripts] 2FA: using nonce-based flow');
        resp = await fetch(`${BASE_URL}/session/2fa`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': this._csrfToken,
            'Cookie': this._sessionCookies,
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            nonce,
            second_factor_token: token,
            second_factor_method: 1,
          }),
          redirect: 'manual',
        });
      } else {
        // No nonce: re-submit full login with 2FA token included
        log.info('[EroScripts] 2FA: re-submitting login with TOTP token');
        resp = await fetch(`${BASE_URL}/session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': this._csrfToken,
            'Cookie': this._sessionCookies,
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
          },
          body: `login=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&second_factor_token=${encodeURIComponent(token)}&second_factor_method=1`,
          redirect: 'manual',
        });
      }

      const data = await this._safeJson(resp);
      log.info('[EroScripts] 2FA response:', JSON.stringify(data));
      log.info('[EroScripts] 2FA response status:', resp.status);

      if (!data) {
        return { success: false, error: `2FA verification failed (${resp.status})` };
      }

      // Merge cookies
      const cookies = this._extractCookies(resp);
      log.info('[EroScripts] 2FA cookies:', cookies ? cookies.substring(0, 100) : 'none');
      if (cookies) {
        this._sessionCookies = this._mergeCookies(this._sessionCookies, cookies);
      }

      if (data.error) {
        return { success: false, error: data.error };
      }

      // Check if this is a successful login response
      if (data.user || data.current_user) {
        return this._completeLogin(data, data.user?.username || '');
      }

      // Some Discourse versions return success differently after 2FA
      // Try extracting the _t cookie
      const tMatch = this._sessionCookies.match(/_t=([^;,\s]+)/);
      if (tMatch) {
        this._cookie = tMatch[1];
        this._username = data.username || '';
        log.info(`[EroScripts] 2FA verified, logged in`);
        return { success: true, username: this._username, cookie: this._cookie };
      }

      return { success: false, error: 'Verification succeeded but session not established' };
    } catch (err) {
      log.error('[EroScripts] 2FA error:', err.message);
      return { success: false, error: err.message };
    }
  }

  _completeLogin(data, fallbackUsername) {
    // Extract _t cookie from accumulated session cookies
    const tMatch = this._sessionCookies.match(/_t=([^;,\s]+)/);
    if (tMatch) {
      this._cookie = tMatch[1];
    }

    this._username = data.user?.username || data.current_user?.username || fallbackUsername;
    log.info(`[EroScripts] Logged in as ${this._username}`);

    return { success: true, username: this._username, cookie: this._cookie };
  }

  logout() {
    this._cookie = null;
    this._username = null;
    this._csrfToken = null;
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

      if (resp.status === 429) {
        return { results: [], error: 'Rate limited — try again in a moment' };
      }

      const data = await this._safeJson(resp);
      if (!data) {
        return { results: [], error: `Search failed (${resp.status})` };
      }

      // Log structure for debugging
      log.info('[EroScripts] Search response: topics=%d, posts=%d, users=%d',
        (data.topics || []).length, (data.posts || []).length, (data.users || []).length);
      if (data.topics?.length > 0) {
        const t = data.topics[0];
        log.info('[EroScripts] Sample topic:', JSON.stringify(t).substring(0, 500));
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
          let thumbnail = t.image_url || null;
          if (thumbnail && !thumbnail.startsWith('http')) thumbnail = `${BASE_URL}${thumbnail}`;

          const post = posts.find(p => p.topic_id === t.id);
          const user = post ? users.get(post.user_id) : null;

          let avatar = post?.avatar_template || null;
          if (avatar) {
            avatar = avatar.replace('{size}', '90');
            if (!avatar.startsWith('http')) avatar = `${BASE_URL}${avatar}`;
          }

          return {
            id: t.id, title: t.title, slug: t.slug,
            createdAt: t.created_at, likeCount: t.like_count || 0,
            views: t.views || 0, tags, thumbnail, avatar,
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
        const name = match[2].trim();
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
    if (this._cookie) {
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
        return null;
      }
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  _extractCookies(response) {
    // Node fetch doesn't expose set-cookie easily, try getSetCookie if available
    if (response.headers.getSetCookie) {
      return response.headers.getSetCookie().join('; ');
    }
    return response.headers.get('set-cookie') || '';
  }

  _mergeCookies(existing, newer) {
    // Simple merge — newer values override
    const map = new Map();
    for (const str of [existing, newer]) {
      for (const part of str.split(/[;,]\s*/)) {
        const eq = part.indexOf('=');
        if (eq > 0) {
          const key = part.slice(0, eq).trim();
          const val = part.slice(eq + 1).trim();
          if (key && !['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'].includes(key.toLowerCase())) {
            map.set(key, val);
          }
        }
      }
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

module.exports = { EroScriptsAPI };
