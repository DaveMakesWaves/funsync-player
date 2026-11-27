/**
 * @vitest-environment jsdom
 *
 * Load from URL's window (renderer/components/remote-video-modal.js).
 * Dave, 2026-11-22: "shouldn't load url have a pick funscript browser below it
 * too?" The script row now shows from the first screen and the pick carries
 * through the lookup to Play.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { openRemoteVideoModal } = await import('../../renderer/components/remote-video-modal.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const RV = EN.remoteVideo;

let resolveNext;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  window.funsync = {
    selectFunscript: vi.fn(async () => ({ path: 'C:\\Scripts\\Mix.funscript', name: 'Mix.funscript' })),
    resolveRemoteVideo: vi.fn(() => new Promise((r) => { resolveNext = r; })),
  };
});
afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  delete window.funsync;
});

const q = (sel) => document.querySelector(sel);
const button = (text) => [...document.querySelectorAll('.remote-video-modal button')].find((b) => b.textContent.trim() === text);

describe('Load from URL: the script can be picked from the first screen', () => {
  it('shows the script row under the link, keeps the pick through the lookup, and plays with it', async () => {
    const onPlay = vi.fn();
    openRemoteVideoModal({ onPlay });
    await vi.waitFor(() => expect(q('.remote-video-modal__input')).toBeTruthy());

    // The first screen: link, hint, and the script row with its button.
    expect(q('.remote-video-modal__script-row')).toBeTruthy();
    button(RV.attachScript).click();
    await vi.waitFor(() => expect(q('.remote-video-modal__script-ok')?.textContent).toContain('Mix.funscript'));

    q('.remote-video-modal__input').value = 'https://erosync.net/videos/abc';
    button(RV.load).click();
    // Looking it up: the pick still shows.
    await vi.waitFor(() => expect(q('.remote-video-modal__resolving')).toBeTruthy());
    expect(q('.remote-video-modal__script-ok')?.textContent).toContain('Mix.funscript');

    resolveNext({ ok: true, title: 'A video', proxyUrl: 'http://localhost:5123/api/media/remote/t/master.m3u8', isHls: true });
    await vi.waitFor(() => expect(q('.remote-video-modal__found-title')?.textContent).toBe('A video'));
    expect(q('.remote-video-modal__script-ok')?.textContent).toContain('Mix.funscript');
    button('▶ ' + RV.play).click();
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ title: 'A video' }), 'C:\\Scripts\\Mix.funscript', { save: false });
    expect(window.funsync.selectFunscript).toHaveBeenCalledTimes(1);
  });

  it('the pick survives a failed lookup and "Try another link", and can be removed', async () => {
    openRemoteVideoModal({ onPlay: vi.fn() });
    await vi.waitFor(() => expect(q('.remote-video-modal__input')).toBeTruthy());
    button(RV.attachScript).click();
    await vi.waitFor(() => expect(q('.remote-video-modal__script-ok')).toBeTruthy());
    q('.remote-video-modal__input').value = 'https://www.pornhub.com/view_video.php?viewkey=x';
    button(RV.load).click();
    await vi.waitFor(() => expect(q('.remote-video-modal__resolving')).toBeTruthy());
    resolveNext({ ok: false, kind: 'unavailable' });
    await vi.waitFor(() => expect(q('.remote-video-modal__error')).toBeTruthy());
    button(RV.tryAnother).click();
    await vi.waitFor(() => expect(q('.remote-video-modal__input')?.value).toContain('pornhub'));
    expect(q('.remote-video-modal__script-ok')?.textContent).toContain('Mix.funscript');
    q('.remote-video-modal__script-clear').click();
    expect(q('.remote-video-modal__script-ok')).toBeNull();
    expect(button(RV.attachScript)).toBeTruthy();
  });
});

describe('Load from URL: a failed link offers the page in the browser (2026-11-23)', () => {
  it('Open in browser opens the link that failed', async () => {
    window.funsync.openExternal = vi.fn();
    openRemoteVideoModal({ onPlay: vi.fn() });
    await vi.waitFor(() => expect(q('.remote-video-modal__input')).toBeTruthy());
    q('.remote-video-modal__input').value = 'https://www.pornhub.com/view_video.php?viewkey=x';
    button(RV.load).click();
    await vi.waitFor(() => expect(q('.remote-video-modal__resolving')).toBeTruthy());
    resolveNext({ ok: false, kind: 'refused' });
    await vi.waitFor(() => expect(q('.remote-video-modal__error-detail')?.textContent).toBe(RV.err.refused));
    button(EN.eroscripts.tab.openInBrowser).click();
    expect(window.funsync.openExternal).toHaveBeenCalledWith('https://www.pornhub.com/view_video.php?viewkey=x');
  });
});
