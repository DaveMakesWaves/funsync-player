/**
 * @vitest-environment node
 * No DOM required: electron/gofile.js with a fake Electron.
 */
// Gofile in the EroScripts tab (Dave, 2026-11-24: "I know has a gofile link so
// why is the ui telling me theres no video download"). The app opens the
// Gofile page in a hidden window of its own and reads the listing that page
// is given; the guest cookie goes with the file link. Live the same day: a
// 350 MB file resolved in 0.8 s and downloaded whole.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gofileCode, gofileFiles, pickGofileVideo, resolveGofile, _clearGofileCache } = require('../../electron/gofile.js');

const LISTING = {
  status: 'ok',
  data: { id: 'f1', type: 'folder', name: 'UX0LG6wr', children: {
    a: { id: 'a', type: 'file', name: 'preview.jpg', size: 200000, mimetype: 'image/jpeg', link: 'https://file-na-phx-1.gofile.io/download/web/a/preview.jpg' },
    b: { id: 'b', type: 'file', name: 'Clip.mp4', size: 350603988, mimetype: 'video/mp4', link: 'https://file-na-phx-1.gofile.io/download/web/b/Clip.mp4' },
    c: { id: 'c', type: 'file', name: 'Clip.funscript', size: 9000, mimetype: 'application/json', link: 'https://file-na-phx-1.gofile.io/download/web/c/Clip.funscript' },
    d: { id: 'd', type: 'folder', name: 'extras' },
    e: { id: 'e', type: 'file', name: 'evil.mp4', size: 999999999, mimetype: 'video/mp4', link: 'https://evil.example/download/evil.mp4' },
  } },
};

describe('reading a Gofile listing', () => {
  it('the folder code; files only, on gofile.io over https; the biggest video is the one', () => {
    expect(gofileCode('https://gofile.io/d/UX0LG6wr')).toBe('UX0LG6wr');
    expect(gofileCode('https://www.gofile.io/d/UX0LG6wr/')).toBe('UX0LG6wr');
    expect(gofileCode('http://gofile.io/d/UX0LG6wr')).toBeNull();
    expect(gofileCode('https://evil.example/d/UX0LG6wr')).toBeNull();
    const { files } = gofileFiles(LISTING);
    expect(files.map((f) => f.name)).toEqual(['preview.jpg', 'Clip.mp4', 'Clip.funscript']);   // not the folder, not another host
    expect(pickGofileVideo(files).name).toBe('Clip.mp4');
    expect(pickGofileVideo([{ name: 'a.zip', size: 5, mimetype: '', link: 'x' }]).name).toBe('a.zip');   // no video: the biggest file
  });

  it('several videos: the one named like the script (Part 2 for a Part 2 script); equally close or no hint: the biggest', () => {
    const files = [
      { name: 'Holo Wulf Part 1.mp4', size: 900, mimetype: 'video/mp4', link: 'x' },
      { name: 'Holo Wulf Part 2.mp4', size: 500, mimetype: 'video/mp4', link: 'y' },
    ];
    expect(pickGofileVideo(files, 'Holo Wulf Part 2.funscript').name).toBe('Holo Wulf Part 2.mp4');
    expect(pickGofileVideo(files, 'Holo Wulf.funscript').name).toBe('Holo Wulf Part 1.mp4');
    expect(pickGofileVideo(files).name).toBe('Holo Wulf Part 1.mp4');
  });

  it('Gofile\'s error statuses as our codes', () => {
    expect(gofileFiles({ status: 'error-notFound' })).toEqual({ error: 'notFound' });
    expect(gofileFiles({ status: 'error-passwordRequired' })).toEqual({ error: 'password' });
    expect(gofileFiles({ status: 'error-notPremium' })).toEqual({ error: 'denied' });
    expect(gofileFiles(null)).toEqual({ error: 'failed' });
  });
});

/** A fake Electron: a window whose page, once on gofile.io, gets `answer` from the contents API. */
function fakeElectron({ answer = LISTING, cookie = 'abcdefghij0123456789ABCDEFGHIJ12', silent = false } = {}) {
  const calls = [];
  let listener = null;
  let enabled = false;
  let blankLoaded = false;
  const handlers = {};
  const wc = {
    setAudioMuted: vi.fn(), setWindowOpenHandler: vi.fn(),
    on: vi.fn((ev, fn) => { handlers[ev] = fn; }),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      on: (ev, fn) => { if (ev === 'message') listener = fn; },
      sendCommand: vi.fn(async (method, params) => {
        calls.push(method);
        if (method === 'Network.enable') {
          if (!blankLoaded) await new Promise(() => {});          // the real thing waits for a renderer
          enabled = true;
          return {};
        }
        if (method === 'Network.getResponseBody') return { body: JSON.stringify(answer), base64Encoded: false };
        return {};
      }),
    },
    loadURL: vi.fn(async (u) => {
      calls.push(`load ${u}`);
      if (u === 'about:blank') { blankLoaded = true; return; }
      if (!enabled || silent) return;
      listener?.({}, 'Network.responseReceived', { requestId: 'r1', response: { url: 'https://api.gofile.io/contents/UX0LG6wr?x=1' } });
      listener?.({}, 'Network.loadingFinished', { requestId: 'r1' });
    }),
  };
  const win = { webContents: wc, destroy: vi.fn() };
  const ses = { on: vi.fn(), cookies: { get: vi.fn(async () => (cookie ? [{ value: cookie }] : [])) } };
  return {
    calls, win, ses, handlers,
    electron: { BrowserWindow: vi.fn(function FakeWindow() { return win; }), session: { fromPartition: vi.fn(() => ses) } },
  };
}

describe('resolving through the app\'s own window', () => {
  beforeEach(() => _clearGofileCache());

  it('a blank page, then the inspector, then the Gofile page; the listing and the guest cookie; the window closed', async () => {
    const f = fakeElectron();
    const r = await resolveGofile('https://gofile.io/d/UX0LG6wr', { electron: f.electron, timeoutMs: 2000 });
    expect(r.ok).toBe(true);
    expect(r.files.map((x) => x.name)).toContain('Clip.mp4');
    expect(r.cookie).toBe('accountToken=abcdefghij0123456789ABCDEFGHIJ12');
    expect(f.calls.slice(0, 3)).toEqual(['load about:blank', 'Network.enable', 'load https://gofile.io/d/UX0LG6wr']);
    expect(f.electron.BrowserWindow.mock.calls[0][0]).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    expect(f.win.destroy).toHaveBeenCalled();
    // Somewhere else than gofile.io: not navigated to; a popup: refused; a download the page starts: stopped.
    const nav = { preventDefault: vi.fn() };
    f.handlers['will-navigate'](nav, 'https://ads.example/x');
    expect(nav.preventDefault).toHaveBeenCalled();
    expect(f.win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    expect(f.ses.on).toHaveBeenCalledWith('will-download', expect.any(Function));
  });

  it('kept 10 minutes (one window for the post\'s check and its download)', async () => {
    const f = fakeElectron();
    await resolveGofile('https://gofile.io/d/UX0LG6wr', { electron: f.electron, timeoutMs: 2000 });
    await resolveGofile('https://gofile.io/d/UX0LG6wr', { electron: f.electron, timeoutMs: 2000 });
    expect(f.electron.BrowserWindow).toHaveBeenCalledTimes(1);
  });

  it('no listing in time: timeout, window closed; no guest cookie: failed; not a Gofile link: invalid, no window', async () => {
    const quiet = fakeElectron({ silent: true });
    expect(await resolveGofile('https://gofile.io/d/AAA', { electron: quiet.electron, timeoutMs: 50 })).toEqual({ error: 'timeout' });
    expect(quiet.win.destroy).toHaveBeenCalled();
    const noCookie = fakeElectron({ cookie: null });
    expect(await resolveGofile('https://gofile.io/d/BBB', { electron: noCookie.electron, timeoutMs: 2000 })).toEqual({ error: 'failed' });
    const gone = fakeElectron({ answer: { status: 'error-notFound' } });
    expect(await resolveGofile('https://gofile.io/d/CCC', { electron: gone.electron, timeoutMs: 2000 })).toEqual({ error: 'notFound' });
    const none = fakeElectron();
    expect(await resolveGofile('https://evil.example/d/x', { electron: none.electron })).toEqual({ error: 'invalid' });
    expect(none.electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it('main answers the renderer with the one file to fetch; preload exposes it', async () => {
    const fs = await import('node:fs');
    const main = fs.readFileSync('electron/main.js', 'utf8');
    const preload = fs.readFileSync('electron/preload.js', 'utf8');
    expect(main).toContain("ipcMain.handle('gofile-resolve', async (_event, url, hint) => {");
    expect(main).toContain("const file = pickGofileVideo(r.files, typeof hint === 'string' ? hint.slice(0, 300) : '');");
    expect(preload).toContain("gofileResolve: (url, hint) => ipcRenderer.invoke('gofile-resolve', url, hint),");
  });
});
