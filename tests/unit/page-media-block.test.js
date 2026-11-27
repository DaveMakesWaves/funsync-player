/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Live, 2026-11-25 (Dave's machine, Electron 41): after the EroScripts login
// page had been open, FunSync's quit ran to its end and the process never
// ended (an invisible FunSync holding the single-instance lock and port 5123).
// Bisected in a bare Electron script: the page's ad VIDEOS (resource type
// "media"); refused, the process ends. electron/page-media-block.js, used by
// the login window (main.js) and the hidden Gofile window (gofile.js).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { blockPageMedia, refusePageRequest } = require('../../electron/page-media-block.js');

describe('page windows load no video, audio or forum service worker', () => {
  it('refuses media of any host and the forum\'s service worker; the page and its API pass', () => {
    expect(refusePageRequest({ resourceType: 'media', url: 'https://ads.cdn.ayvasoftware.io/v/ad.mp4' })).toBe(true);
    expect(refusePageRequest({ resourceType: 'media', url: 'https://media.synsual.me/x.webm' })).toBe(true);
    expect(refusePageRequest({ resourceType: 'script', url: 'https://discuss.eroscripts.com/service-worker.js' })).toBe(true);
    expect(refusePageRequest({ resourceType: 'other', url: 'https://discuss.eroscripts.com/service-worker.js?v=2' })).toBe(true);
    for (const ok of [
      { resourceType: 'mainFrame', url: 'https://discuss.eroscripts.com/login' },
      { resourceType: 'xhr', url: 'https://discuss.eroscripts.com/session/csrf' },
      { resourceType: 'script', url: 'https://challenges.cloudflare.com/turnstile/v0/api.js' },
      { resourceType: 'xhr', url: 'https://api.gofile.io/contents/UX0LG6wr' },
      { resourceType: 'image', url: 'https://eroscripts-discourse.eroscripts.com/logo.png' },
    ]) expect(refusePageRequest(ok)).toBe(false);
    expect(refusePageRequest(null)).toBe(false);
  });

  it('is the session\'s one onBeforeRequest, over every URL', () => {
    let filter;
    let listener;
    const ses = { webRequest: { onBeforeRequest: vi.fn((f, l) => { filter = f; listener = l; }) } };
    expect(blockPageMedia(ses)).toBe(true);
    expect(filter).toEqual({ urls: ['*://*/*'] });
    const cb = vi.fn();
    listener({ resourceType: 'media', url: 'https://x/y.mp4' }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    listener({ resourceType: 'xhr', url: 'https://x/y.json' }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
    expect(blockPageMedia(null)).toBe(false);
  });

  it('the login window and the Gofile window use it', () => {
    const main = fs.readFileSync('electron/main.js', 'utf8');
    const login = main.slice(main.indexOf("ipcMain.handle('eroscripts-login-window'"), main.indexOf("ipcMain.handle('eroscripts-logout'"));
    expect(login).toMatch(/require\('\.\/page-media-block'\)\.blockPageMedia\(sess\)/);
    // Before the window loads anything.
    expect(login.indexOf('blockPageMedia(sess)')).toBeLessThan(login.indexOf('new BrowserWindow'));
    expect(fs.readFileSync('electron/gofile.js', 'utf8')).toMatch(/require\('\.\/page-media-block'\)\.blockPageMedia\(ses\)/);
  });
});
