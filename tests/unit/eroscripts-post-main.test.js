/**
 * @vitest-environment node
 * No DOM required: the main-process client with a fake fetch.
 */
// The EroScripts review's 2.1 / 2.2 / 2.5 in main (2026-11-23): scripts in the
// replies, the post's HTML for the reader, a script's actions before it is
// downloaded, and a post's images as data: URLs. No real forum: fetch is a
// fake throughout.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

const log = (await import('../../electron/logger.js')).default;
const { EroScriptsAPI, extractReplyAttachments, MAX_IMAGE_BYTES } = await import('../../electron/eroscripts-api.js');

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
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function response({ status = 200, body = '', headers = {}, bytes = null } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = bytes || new TextEncoder().encode(text);
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text, json: async () => JSON.parse(text),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    clone() { return this; },
  };
}

const att = (href, name) => `<a class="attachment" href="${href}">${name}</a>`;
const post = (n, user, cooked, extra = {}) => ({ id: 1000 + n, post_number: n, username: user, created_at: `2026-11-${String(n).padStart(2, '0')}T10:00:00Z`, cooked, ...extra });

describe('scripts in the replies (review 2.5)', () => {
  it('each reply\'s .funscript / .zip, newest reply first, each once, none the first post has, quotes dropped, with likes', () => {
    const posts = [
      post(1, 'maker', att('/uploads/short-url/a.funscript', 'A.funscript')),
      post(2, 'fan', `<aside class="quote" data-username="maker"><blockquote>${att('/uploads/short-url/a.funscript', 'A.funscript')}</blockquote></aside>thanks`),
      post(5, 'maker', `fixed: ${att('/uploads/short-url/v2.funscript', 'A v2.funscript')} ${att('/uploads/short-url/pack.zip', 'pack.zip')} ${att('/uploads/short-url/n.txt', 'notes.txt')}`, { like_count: 4 }),
      post(7, 'other', att('https://discuss.eroscripts.com/uploads/short-url/mine.funscript', 'Mine.funscript'), { actions_summary: [{ id: 2, count: 2 }] }),
    ];
    const got = extractReplyAttachments(posts, ['https://discuss.eroscripts.com/uploads/short-url/a.funscript']);
    expect(got.map((a) => [a.name, a.postNumber, a.username, a.likes])).toEqual([
      ['Mine.funscript', 7, 'other', 2],
      ['A v2.funscript', 5, 'maker', 4],
      ['pack.zip', 5, 'maker', 4],
    ]);
    expect(got[1].url).toBe('https://discuss.eroscripts.com/uploads/short-url/v2.funscript');
  });

  it('the topic answer carries them, and their URLs may be downloaded; the reader\'s HTML only for the download window', async () => {
    const api = new EroScriptsAPI();
    const json = {
      id: 5, title: 'T', slug: 't', posts_count: 3, details: { created_by: { username: 'maker' } }, tags: [],
      post_stream: { posts: [post(1, 'maker', `<p>Hi</p>${att('/uploads/short-url/a.funscript', 'A.funscript')}`), post(2, 'maker', att('/uploads/short-url/v2.funscript', 'A v2.funscript'))], stream: [1001, 1002] },
    };
    globalThis.fetch = vi.fn(async () => response({ body: json }));
    const card = await api.getTopicAttachments(5);
    expect(card.replyScripts.map((a) => a.name)).toEqual(['A v2.funscript']);
    expect(card.post).toBeUndefined();                                  // the card check skips the reader's copy
    const full = await api.getTopicAttachments(5, { replies: true });
    expect(full.post).toMatchObject({ postNumber: 1, username: 'maker' });
    expect(full.post.cooked).toContain('<p>Hi</p>');
    expect(full.replies.map((r) => [r.postNumber, r.username])).toEqual([[2, 'maker']]);
    expect(full.replyCount).toBe(2);
    expect(api.checkDownloadRequest('https://discuss.eroscripts.com/uploads/short-url/v2.funscript', 'C:\\x\\a.funscript', { platform: 'win32' })).toBeNull();
  });
});

describe('a script linked as a plain upload (test day 2026-11-24, B002)', () => {
  // "Collect Mandy’s Rent - GTA VI" (topic 350031) links its script as [name](upload://...)
  // without |attachment: Discourse cooks a plain <a href="/uploads/short-url/...">, no class.
  // The window said "No script in this post".
  it('a forum upload ending .funscript / .zip is a script, class or not; its name from the text, else the path; another host\'s link is not', async () => {
    const api = new EroScriptsAPI();
    const cooked = '<p><a href="/uploads/short-url/abcOZ.funscript">GTA 6 - Collect Mandy’s Rent.funscript</a> (24.1 KB)</p>'
      + '<p><a href="https://discuss.eroscripts.com/uploads/short-url/pk.zip?dl=1">the pack</a></p>'
      + '<p><a href="https://mega.nz/file/x#k">Video.funscript</a> <a href="/t/123">other.funscript thread</a></p>'
      + '<p><a class="attachment" href="/uploads/short-url/abcOZ.funscript">GTA 6 - Collect Mandy’s Rent.funscript</a></p>';
    const json = { id: 7, title: 'T', slug: 't', details: { created_by: { username: 'maker' } }, tags: [], post_stream: { posts: [post(1, 'maker', cooked)], stream: [1001] } };
    globalThis.fetch = vi.fn(async () => response({ body: json }));
    const r = await api.getTopicAttachments(7);
    expect(r.attachments).toEqual([
      { name: 'GTA 6 - Collect Mandy’s Rent.funscript', url: 'https://discuss.eroscripts.com/uploads/short-url/abcOZ.funscript' },
      { name: 'pk.zip', url: 'https://discuss.eroscripts.com/uploads/short-url/pk.zip?dl=1' },
    ]);
  });
});

describe('a script before it is downloaded (review 2.2)', () => {
  const URL_OK = 'https://discuss.eroscripts.com/uploads/short-url/a.funscript';

  it('its actions (sorted, bad ones left out), recorded length and channels; a BOM is fine; the bytes are kept for the download', async () => {
    const api = new EroScriptsAPI();
    const body = `\uFEFF${JSON.stringify({ metadata: { duration: 774 }, channels: { roll: {}, twist: {} }, actions: [{ at: 2000, pos: 10 }, { at: 0, pos: 0 }, { at: 'x', pos: 5 }, { at: 1000, pos: 90 }] })}`;
    globalThis.fetch = vi.fn(async () => response({ body }));
    const r = await api.previewScript(URL_OK);
    expect(r).toMatchObject({ ok: true, metaDuration: 774, channels: ['roll', 'twist'], truncated: false });
    expect(r.actions).toEqual([{ at: 0, pos: 0 }, { at: 1000, pos: 90 }, { at: 2000, pos: 10 }]);
    // The download that follows uses the same bytes: no second request.
    await api._fetchDownload(URL_OK);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a URL not on the forum nor issued by it, without a request; says when it is not a script', async () => {
    const api = new EroScriptsAPI();
    globalThis.fetch = vi.fn(async () => response({ body: '<html>nope</html>' }));
    expect(await api.previewScript('https://evil.example/a.funscript')).toMatchObject({ refused: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await api.previewScript(URL_OK)).toMatchObject({ errorCode: 'notScript' });
    globalThis.fetch = vi.fn(async () => response({ status: 404 }));
    expect(await api.previewScript(`${URL_OK}?x`)).toMatchObject({ httpStatus: 404 });
  });
});

describe('a post\'s images (review 2.1)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('a forum image comes with the session, as a data: URL', async () => {
    const api = new EroScriptsAPI();
    api.restoreSession('cookie123', 'dave');
    globalThis.fetch = vi.fn(async () => response({ bytes: PNG, headers: { 'Content-Type': 'image/png' } }));
    const r = await api.fetchImage('https://discuss.eroscripts.com/uploads/default/a.png');
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/png;base64,iVBORw==' });
    expect(globalThis.fetch.mock.calls[0][1].headers.Cookie).toContain('cookie123');
  });

  it('another host\'s only when asked, and never with the cookie', async () => {
    const api = new EroScriptsAPI();
    api.restoreSession('cookie123', 'dave');
    globalThis.fetch = vi.fn(async () => response({ bytes: PNG, headers: { 'Content-Type': 'image/gif' } }));
    expect(await api.fetchImage('https://i.imgur.com/b.gif')).toMatchObject({ notForum: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await api.fetchImage('https://i.imgur.com/b.gif', { external: true })).toMatchObject({ ok: true });
    expect(globalThis.fetch.mock.calls[0][1].headers.Cookie).toBeUndefined();
  });

  it('images only (no SVG, no page), https only, and never past the size cap', async () => {
    const api = new EroScriptsAPI();
    globalThis.fetch = vi.fn(async () => response({ body: '<svg/>', headers: { 'Content-Type': 'image/svg+xml' } }));
    expect(await api.fetchImage('https://discuss.eroscripts.com/a.svg')).toMatchObject({ notImage: true });
    globalThis.fetch = vi.fn(async () => response({ body: '<html>', headers: { 'Content-Type': 'text/html' } }));
    expect(await api.fetchImage('https://discuss.eroscripts.com/a.png')).toMatchObject({ notImage: true });
    expect(await api.fetchImage('http://discuss.eroscripts.com/a.png')).toMatchObject({ error: 'not https' });
    globalThis.fetch = vi.fn(async () => response({ bytes: PNG, headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_IMAGE_BYTES + 1) } }));
    expect(await api.fetchImage('https://discuss.eroscripts.com/big.png')).toMatchObject({ tooBig: true });
  });
});

describe('the IPC and preload wiring', () => {
  it('main answers both channels through the client; preload exposes them', async () => {
    const fs = await import('node:fs');
    const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
    const preload = fs.readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
    expect(main).toContain("ipcMain.handle('eroscripts-script-preview', async (_event, url) => eroScripts.previewScript(url));");
    expect(main).toContain("ipcMain.handle('eroscripts-image', async (_event, url, opts) => eroScripts.fetchImage(url, { external: opts?.external === true }));");
    expect(preload).toContain("eroscriptsScriptPreview: (url) => ipcRenderer.invoke('eroscripts-script-preview', url),");
    expect(preload).toContain("eroscriptsImage: (url, opts) => ipcRenderer.invoke('eroscripts-image', url, opts),");
  });
});

describe('the newest list with ANY of several tags (the Suggested feed, 2026-11-24)', () => {
  it('several tags: every one must match, unless anyTags; the IPC passes anyTags through', async () => {
    const api = new EroScriptsAPI();
    api.restoreSession('cookie123', 'dave');
    globalThis.fetch = vi.fn(async () => response({ body: { topic_list: { topics: [] }, users: [] } }));
    await api.latest('all', 0, { tags: ['pov', 'blowjob'] });
    expect(globalThis.fetch.mock.calls[0][0]).toContain('match_all_tags=true');
    await api.latest('all', 0, { tags: ['pov', 'blowjob'], anyTags: true });
    const url = globalThis.fetch.mock.calls[1][0];
    expect(url).not.toContain('match_all_tags');
    expect(url).toContain('tags%5B%5D=pov');
    expect(url).toContain('tags%5B%5D=blowjob');
    const fs = await import('node:fs');
    const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
    expect(main).toContain('anyTags: o.anyTags === true,');
  });
});
