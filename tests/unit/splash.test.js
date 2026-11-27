/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Dave, 2026-11-25: "can we just make it a high res version of the funsync
// logo but the heatmap segment is animated like a playing video instead of
// the loading spinner"; mockup E ("scrolling timeline with lift") chosen.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { frame, HALVES, PLAYHEAD_X, MAX_HALF, X0, X1, SPEED, PLAYED_OPACITY, UPCOMING_OPACITY } from '../../renderer/splash.js';

describe('the splash bars (scrolling timeline with lift)', () => {
  it('the icon\'s 31 bars, drawn twice so the strip wraps without a gap', () => {
    expect(HALVES).toHaveLength(31);
    expect(frame(0)).toHaveLength(62);
  });

  it('they scroll left at a steady pace, and come round again', () => {
    const a = frame(0)[5].x;
    const b = frame(1000)[5].x;
    expect(a - b).toBeCloseTo(SPEED * 1000, 5);
    const loop = (X1 - X0) / SPEED;                       // one strip's length, in ms
    expect(frame(loop)[5].x).toBeCloseTo(frame(0)[5].x, 5);
  });

  it('played bars (left of the playhead) are lit, the ones to come dim', () => {
    for (const b of frame(2345)) {
      expect(b.opacity).toBe(b.x <= PLAYHEAD_X ? PLAYED_OPACITY : UPCOMING_OPACITY);
    }
  });

  it('a bar lifts as it crosses the playhead and settles after; never past 115 % of the tallest', () => {
    // Bar 10 (half 15.5 px) starts left of the playhead: its second copy
    // (index 41, one strip to the right) is the one that scrolls into it.
    const step = (X1 - X0) / HALVES.length;
    const restX = X0 + step * (HALVES.length + 10.5);
    const tAt = (x) => (restX - x) / SPEED;                // when that copy is at x
    const far = frame(tAt(PLAYHEAD_X + 60))[HALVES.length + 10];
    const on = frame(tAt(PLAYHEAD_X))[HALVES.length + 10];
    expect(on.x).toBeCloseTo(PLAYHEAD_X, 5);
    expect(far.half).toBeCloseTo(HALVES[10], 5);
    expect(on.half).toBeGreaterThan(far.half);
    for (let t = 0; t < 8000; t += 37) for (const b of frame(t)) expect(b.half).toBeLessThanOrEqual(MAX_HALF * 1.15 + 1e-9);
  });
});

describe('the splash page and window', () => {
  const html = fs.readFileSync('renderer/splash.html', 'utf8');
  const main = fs.readFileSync('electron/main.js', 'utf8');

  it('the round logo as a vector, the bars from splash.js; no spinner or "Loading..."', () => {
    expect(html).toMatch(/<svg viewBox="0 0 256 256"/);
    expect(html).toMatch(/<circle cx="128" cy="128" r="118"/);
    expect(html).toMatch(/<script type="module" src="splash.js"><\/script>/);
    expect(html).not.toMatch(/spinner|Loading\.\.\./);
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
    expect(html).toMatch(/background: transparent/);
  });

  it('main builds the splash from splash-window.js, hands it its words, and fades it out after the main window shows', () => {
    expect(main).toMatch(/new BrowserWindow\(splashWindowOptions\(process\.platform,/);
    expect(main).toMatch(/query: splashQuery\(\{ locale: store\.getSetting\('player\.language'\), platform: process\.platform \}\)/);
    const ready = main.slice(main.indexOf("mainWindow.once('ready-to-show', () => {"));
    const show = ready.indexOf('mainWindow.show();');
    const fade = ready.indexOf('fadeOutSplash(splash);');
    expect(show).toBeGreaterThan(0);
    expect(fade).toBeGreaterThan(show);                           // shown first: the two cross over
    expect(ready.slice(0, fade)).not.toMatch(/splash\.destroy\(\)/);
  });
});

// Dave, 2026-11-25, polish "1,2,4,5": fade out (1), a slow start says so (2),
// Linux on a solid window (4), fade in (5).
describe('splash polish', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const sw = require('../../electron/splash-window.js');
  const { readSplashQuery } = await import('../../renderer/splash.js');
  const html = fs.readFileSync('renderer/splash.html', 'utf8');

  it('the window: the 300 px circle and a line under it; see-through except on Linux, which gets solid navy', () => {
    const win = sw.splashWindowOptions('win32', 'icon.ico');
    expect([win.width, win.height]).toEqual([300, 340]);
    expect(win).toMatchObject({ frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true });
    expect(win.backgroundColor).toBeUndefined();
    const linux = sw.splashWindowOptions('linux', 'icon.png');
    expect(linux.transparent).toBe(false);
    expect(linux.backgroundColor).toBe('#1a1a2e');
    expect(sw.splashQuery({ locale: 'en', platform: 'linux' }).card).toBe('1');
    expect(sw.splashQuery({ locale: 'en', platform: 'darwin' }).card).toBe('0');
  });

  it('the slow-start line in the saved language; English for one it does not know', () => {
    const fr = JSON.parse(fs.readFileSync('renderer/locales/fr.json', 'utf8')).splash.slow;
    expect(sw.splashSlowText('fr')).toBe(fr);
    expect(sw.splashSlowText('xx')).toBe(JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8')).splash.slow);
    expect(sw.splashQuery({ locale: 'de', platform: 'win32' })).toMatchObject({ slowMs: String(sw.SLOW_MS) });
    expect(sw.SLOW_MS).toBe(4000);
  });

  it('the page reads it from its URL (and survives a bad one)', () => {
    expect(readSplashQuery('?slow=Starting%20FunSync%E2%80%A6&slowMs=4000&card=1')).toEqual({ slow: 'Starting FunSync…', slowMs: 4000, card: true });
    expect(readSplashQuery('')).toEqual({ slow: '', slowMs: 4000, card: false });
    expect(readSplashQuery('?slowMs=-3').slowMs).toBe(4000);
  });

  it('fade out: the page told to leave, the window closed after the fade; a failing page or a gone window is just closed', async () => {
    const timers = [];
    const fake = (ok = true) => {
      const w = { destroyed: false, isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; },
        webContents: { executeJavaScript: (code) => { w.code = code; return ok ? Promise.resolve(true) : Promise.reject(new Error('gone')); } } };
      return w;
    };
    const w = fake();
    sw.fadeOutSplash(w, { setTimer: (fn, ms) => timers.push([fn, ms]) });
    expect(w.code).toContain("classList.add('leaving')");
    expect(w.destroyed).toBe(false);                               // still fading
    expect(timers[0][1]).toBeGreaterThanOrEqual(sw.FADE_MS);
    timers[0][0]();
    expect(w.destroyed).toBe(true);
    const bad = fake(false);
    sw.fadeOutSplash(bad, { setTimer: () => {} });
    await Promise.resolve(); await Promise.resolve();
    expect(bad.destroyed).toBe(true);                              // the page could not fade: closed at once
    const gone = fake();
    gone.destroyed = true;
    expect(() => sw.fadeOutSplash(gone)).not.toThrow();
    expect(() => sw.fadeOutSplash(null)).not.toThrow();
  });

  it('the page fades in, fades out on "leaving", has the slow line (hidden until shown) and the Linux card; still no spinner', () => {
    expect(html).toMatch(/animation: splash-in/);
    // The fade-in lets go of opacity when it ends: held ("both"), it outranked
    // .leaving and the fade-out never showed (live, 2026-11-25).
    expect(html).toMatch(/animation: splash-in \d+ms [a-z-]+ backwards;/);
    expect(html).not.toMatch(/animation: splash-in[^;]*\bboth\b/);
    expect(html).toMatch(/html\.leaving body \{ opacity: 0; \}/);
    expect(html).toMatch(/<div class="slow" role="status"/);
    expect(html).toMatch(/\.slow \{[^}]*opacity: 0;/);
    expect(html).toMatch(/html\.card, html\.card body \{ background: #1a1a2e; \}/);
    expect(html).toMatch(/prefers-reduced-motion: reduce/);
    expect(html).not.toMatch(/spinner/);
  });
});
