// Gofile links in the EroScripts tab (Dave, 2026-11-24: "theres a futanari
// post ... I know has a gofile link so why is the ui telling me theres no
// video download", "I need the video downloads thing to be as functional as
// possible especially with things like gofile, mega, pixeldrain").
//
// Gofile's API answers only a request carrying a token its own page makes in
// obfuscated code. We do not imitate that: the app opens the Gofile page the
// way a browser does, in a hidden window of its own (sandboxed, no Node, its
// own session), lets Gofile's page run as it was made to, and reads the
// folder listing that page is given (through the window's DevTools network
// view). The page's guest login leaves an `accountToken` cookie: the file
// links need it, so the download (in the backend) sends it.
//
// Nothing here is used for any other site; the window is closed as soon as
// the listing came (or after TIMEOUT_MS).

const GOFILE_URL_RE = /^https:\/\/(?:www\.)?gofile\.io\/d\/([A-Za-z0-9-]{1,64})\/?(?:[?#].*)?$/i;
const TIMEOUT_MS = 30000;
const CACHE_MS = 10 * 60 * 1000;
const VIDEO_EXT_RE = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpg|mpeg|ts|m2ts)$/i;
const PARTITION = 'persist:gofile';

/** The folder code of a Gofile link, or null. */
function gofileCode(url) {
  const m = GOFILE_URL_RE.exec(String(url || '').trim());
  return m ? m[1] : null;
}

/**
 * The files of a Gofile `contents` answer: [{name, size, link, mimetype}]
 * (files only: a sub-folder has no link), or {error} for its error statuses.
 */
function gofileFiles(json) {
  if (!json || typeof json !== 'object') return { error: 'failed' };
  const status = String(json.status || '');
  if (status !== 'ok') {
    if (/notFound|notExist|deleted/i.test(status)) return { error: 'notFound' };
    if (/password/i.test(status)) return { error: 'password' };
    if (/premium|notPublic|private/i.test(status)) return { error: 'denied' };
    return { error: 'failed' };
  }
  const data = json.data || {};
  const nodes = data.type === 'file' ? [data] : Object.values(data.children || {});
  const files = [];
  for (const n of nodes) {
    if (!n || n.type !== 'file' || typeof n.link !== 'string') continue;
    let link;
    try { link = new URL(n.link); } catch { continue; }
    if (link.protocol !== 'https:' || !/(^|\.)gofile\.io$/i.test(link.hostname)) continue;
    files.push({
      name: String(n.name || '').slice(0, 300),
      size: Number(n.size) > 0 ? Number(n.size) : 0,
      link: link.href,
      mimetype: String(n.mimetype || ''),
    });
  }
  return { files };
}

const HINT_NOISE = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'funscript', 'the', 'and', 'with', 'for', '1080p', '720p', '2160p',
  '480p', '4k', '60fps', 'hevc', 'x264', 'x265', 'h264', 'h265', 'video', 'script', 'full']);
const hintWords = (text) => new Set((String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => (w.length >= 2 || /^\d$/.test(w)) && !HINT_NOISE.has(w)));

/**
 * The file to download: of the videos (else every file), the one whose name
 * shares the most words with `hint` (the script's name: a folder can hold
 * Part 1 and Part 2), when that tells them apart; else the biggest.
 */
function pickGofileVideo(files, hint = '') {
  const list = Array.isArray(files) ? files : [];
  const isVideo = (f) => /^video\//i.test(f.mimetype) || VIDEO_EXT_RE.test(f.name);
  const pool = list.some(isVideo) ? list.filter(isVideo) : list;
  const biggest = pool.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;
  const want = hintWords(hint);
  if (!want.size || pool.length < 2) return biggest;
  const scored = pool.map((f) => ({ f, n: [...hintWords(f.name)].filter((w) => want.has(w)).length }));
  const top = Math.max(...scored.map((s) => s.n));
  if (top < 2 || scored.every((s) => s.n === top)) return biggest;
  return scored.filter((s) => s.n === top).sort((a, b) => (b.f.size || 0) - (a.f.size || 0))[0].f;
}

const cache = new Map();   // folder code -> {at, answer}

/**
 * Open the Gofile page in a hidden window and read its listing:
 * {ok: true, files, cookie} or {error: 'invalid'|'notFound'|'password'|'denied'|'timeout'|'failed'}.
 * `electron` is injected (tests pass a fake).
 */
async function resolveGofile(url, { electron, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
  const code = gofileCode(url);
  if (!code) return { error: 'invalid' };
  const held = cache.get(code);
  if (held && now() - held.at < CACHE_MS) return held.answer;
  const { BrowserWindow, session } = electron;
  const ses = session.fromPartition(PARTITION);
  // The page may not start a download or open anything of its own.
  if (!ses.__funsyncGofileGuard) {
    ses.on('will-download', (e) => e.preventDefault());
    // No video or audio (the page's player, its ads): the link comes from the
    // API's answer. A page's video left FunSync unable to finish quitting
    // (the EroScripts login page, 2026-11-25; page-media-block.js).
    require('./page-media-block').blockPageMedia(ses);
    ses.__funsyncGofileGuard = true;
  }
  const win = new BrowserWindow({
    show: false, width: 1100, height: 800,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted?.(true);
  wc.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, to) => { if (!/^https:\/\/(?:www\.)?gofile\.io\//i.test(to)) e.preventDefault(); });

  const answer = await new Promise((resolve) => {
    let done = false;
    const finish = (a) => { if (!done) { done = true; resolve(a); } };
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
    const wanted = new Map();   // requestId -> true for the contents call
    try {
      wc.debugger.attach('1.3');
    } catch {
      clearTimeout(timer);
      finish({ error: 'failed' });
      return;
    }
    wc.debugger.on('message', async (_e, method, params) => {
      if (method === 'Network.responseReceived' && /^https:\/\/api\.gofile\.io\/contents\//i.test(params?.response?.url || '')) {
        wanted.set(params.requestId, true);
      } else if (method === 'Network.loadingFinished' && wanted.has(params?.requestId)) {
        try {
          const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
          const got = gofileFiles(json);
          clearTimeout(timer);
          finish(got);
        } catch { /* another answer may follow */ }
      }
    });
    // A blank page first: the inspector's commands wait for a renderer, which
    // a window only has once it loads something (live 2026-11-24: enabling
    // first and loading after never started).
    wc.loadURL('about:blank')
      .then(() => wc.debugger.sendCommand('Network.enable'))
      .then(() => wc.loadURL(`https://gofile.io/d/${code}`))
      .catch(() => { /* a load the page itself replaces is fine; the timer ends a real failure */ });
  });

  let cookie = null;
  if (!answer.error) {
    try {
      const found = await ses.cookies.get({ url: 'https://gofile.io', name: 'accountToken' });
      const value = found?.[0]?.value;
      if (typeof value === 'string' && /^[A-Za-z0-9]{8,128}$/.test(value)) cookie = `accountToken=${value}`;
    } catch { cookie = null; }
  }
  try { wc.debugger.detach(); } catch { /* already */ }
  try { win.destroy(); } catch { /* already */ }
  const out = answer.error ? answer : (cookie ? { ok: true, files: answer.files, cookie } : { error: 'failed' });
  if (out.ok || out.error === 'notFound') cache.set(code, { at: now(), answer: out });
  return out;
}

function _clearGofileCache() { cache.clear(); }

module.exports = { GOFILE_URL_RE, gofileCode, gofileFiles, pickGofileVideo, resolveGofile, _clearGofileCache };
