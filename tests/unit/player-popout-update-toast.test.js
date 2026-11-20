/**
 * @vitest-environment jsdom
 * jsdom on purpose: this imports the REAL pop-out renderer
 * (renderer/player-popout.js), which builds its player on the DOM of
 * player-popout.html at import time, and the toasts are real DOM.
 */
// FT-101 (also in v0.9.2): the detached player window had no toast container
// and no update handler, so the updater's notices never showed there even
// once main sent them (auto-updater-broadcast.test.js). It now shows the same
// two toasts as the main window (renderer/js/update-toasts.js).
//
// Asserted: what the window shows and what its buttons ask main to do. The
// preload's updaterDownload / updaterInstall are recording fakes here.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const html = fs.readFileSync('renderer/player-popout.html', 'utf8');
const bodyInner = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const up = [];
let onEvent = null;
let onUpdate = null;
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const toasts = () => [...document.querySelectorAll('#toast-container .toast')];

beforeAll(async () => {
  document.body.innerHTML = bodyInner;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  window.funsync = {
    playerPopoutRelay: (direction, payload) => { if (direction === 'to-parent') up.push(payload); },
    onPlayerPopoutEvent: (cb) => { onEvent = cb; },
    onUpdateEvent: (cb) => { onUpdate = cb; return () => {}; },
    updaterDownload: vi.fn(),
    updaterInstall: vi.fn(),
  };
  await import('../../renderer/player-popout.js');
  onEvent({ type: 'opened' });
  await until(() => up.some((m) => m.type === PLAYERWIN.READY));
}, 20000);

describe('FT-101: the player window shows the update notices', () => {
  it('it has a toast container and listens for the updater (preconditions)', () => {
    expect(document.getElementById('toast-container')).not.toBeNull();
    expect(typeof onUpdate).toBe('function');
  });

  it('"update available": a toast naming the version, whose Download asks main to download', () => {
    onUpdate('update:available', { version: '9.9.9' });
    const toast = toasts().at(-1);
    expect(toast).toBeDefined();
    expect(toast.textContent).toContain(EN.updater.available.replace('{version}', '9.9.9'));
    const btn = toast.querySelector('.update-toast__btn');
    expect(btn.textContent).toBe(EN.updater.download);
    btn.click();
    expect(window.funsync.updaterDownload).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe(EN.updater.downloading);
  });

  it('"downloaded": a toast that stays, with Restart Now', async () => {
    onUpdate('update:downloaded', { version: '9.9.9' });
    const toast = toasts().at(-1);
    expect(toast.textContent).toContain(EN.updater.ready.replace('{version}', '9.9.9'));
    expect(toast.querySelector('.update-toast__btn').textContent).toBe(EN.updater.restartNow);
    await new Promise((r) => setTimeout(r, 50));
    expect(toast.isConnected).toBe(true); // persistent until dismissed
    expect(window.funsync.updaterInstall).not.toHaveBeenCalled();
  });

  it('progress and errors show nothing', () => {
    const before = toasts().length;
    onUpdate('update:download-progress', { percent: 40 });
    onUpdate('update:error', { message: 'net down' });
    onUpdate('update:checking');
    expect(toasts()).toHaveLength(before);
  });
});
