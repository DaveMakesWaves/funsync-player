/**
 * @vitest-environment jsdom
 * jsdom: the real Load from URL window; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Test day 2026-11-26 (S029; Dave: "fix those 3"): text that is not a web
// address ("not a url") went to the resolver, came back 422 from yt-dlp, and
// the window said "the site may be unsupported, or the video needs a login".
// Now it says what is wrong under the box, keeps the text to fix, and sends
// nothing; "site.com/page" gets https:// in front.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { openRemoteVideoModal, webAddressFrom } = await import('../../renderer/components/remote-video-modal.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const RV = EN.remoteVideo;

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  window.funsync = { resolveRemoteVideo: vi.fn(() => new Promise(() => {})) };
});
afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  delete window.funsync;
});

const q = (sel) => document.querySelector(sel);
const loadBtn = () => [...document.querySelectorAll('.remote-video-modal button')].find((b) => b.textContent.trim() === RV.load);

describe('webAddressFrom (S029)', () => {
  it('http(s) links as they are', () => {
    expect(webAddressFrom(' https://pixeldrain.com/u/abc ')).toEqual({ url: 'https://pixeldrain.com/u/abc' });
    expect(webAddressFrom('http://127.0.0.1:8765/v.mp4')).toEqual({ url: 'http://127.0.0.1:8765/v.mp4' });
  });
  it('a site without https:// gets it', () => {
    expect(webAddressFrom('pixeldrain.com/u/abc')).toEqual({ url: 'https://pixeldrain.com/u/abc' });
    expect(webAddressFrom('www.example.com')).toEqual({ url: 'https://www.example.com' });
    expect(webAddressFrom('example.com:8080/v.mp4')).toEqual({ url: 'https://example.com:8080/v.mp4' });
  });
  it('words, a file path, another scheme or a broken link: not a web address', () => {
    for (const s of ['not a url', 'hello', 'C:\\Videos\\a.mp4', 'javascript:alert(1)', 'file:///C:/a.mp4', 'ftp://x.com/a', 'https://', 'https://exa mple.com']) {
      expect(webAddressFrom(s), s).toEqual({ error: 'notUrl' });
    }
  });
});

describe('the Load from URL window (S029)', () => {
  it('"not a url": the reason under the box, the text kept, nothing sent; typing clears it', async () => {
    openRemoteVideoModal({ onPlay: vi.fn() });
    await vi.waitFor(() => expect(q('.remote-video-modal__input')).toBeTruthy());
    const input = q('.remote-video-modal__input');
    input.value = 'not a url';
    loadBtn().click();
    const hint = q('.remote-video-modal__hint');
    expect(hint.textContent).toBe(RV.err.notUrl);
    expect(hint.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe('not a url');
    expect(q('.remote-video-modal__resolving')).toBeNull();
    expect(window.funsync.resolveRemoteVideo).not.toHaveBeenCalled();

    input.value = 'not a url!';
    input.dispatchEvent(new Event('input'));
    expect(hint.textContent).toBe(RV.inputHint);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('"site.com/page": looked up as https://site.com/page', async () => {
    openRemoteVideoModal({ onPlay: vi.fn() });
    await vi.waitFor(() => expect(q('.remote-video-modal__input')).toBeTruthy());
    q('.remote-video-modal__input').value = 'pixeldrain.com/u/abc';
    loadBtn().click();
    await vi.waitFor(() => expect(window.funsync.resolveRemoteVideo).toHaveBeenCalled());
    expect(window.funsync.resolveRemoteVideo.mock.calls[0][0]).toBe('https://pixeldrain.com/u/abc');
  });
});
