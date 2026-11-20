/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL index.html body, the REAL NavBar mounted the way
 * app.js mounts it, the REAL stylesheets through jsdom's cascade, a REAL
 * Modal.open(), and app.js's REAL _initBackendBanner / _syncCaptionOverlay.
 */
// The backend banner sat ON the nav bar and under the caption buttons (app
// test V80, reported by Dave from a live screenshot).
//
// #backend-banner was `position: fixed; top: 0; z-index: 9000` with a
// see-through tint (--state-error-soft), outside #app. So it was drawn over
// the nav bar, whose labels showed through its text, and in the Windows
// title-bar strip, where the caption buttons are drawn over its right end
// (its dismiss X sat where the window's close button is).
//
// Now it is a row of #app's flex column under the nav bar, opaque, and what
// is fixed to the window (dialogs, the Devices / EroScripts panels, the
// player-view queue panel) reads its height and bottom edge from two
// custom properties app.js sets while it shows. In the player view it is the
// top row, the player fills the rest, and it reserves the caption strip.
//
// jsdom has no layout, so the banner's box is a stub where it matters
// (getBoundingClientRect), and CSS custom properties are resolved here from
// the real :root rules, the way Chromium would resolve them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { BackendBannerState } from '../../renderer/js/backend-banner-state.js';
import { NavBar } from '../../renderer/components/nav-bar.js';
import { Modal } from '../../renderer/components/modal.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(fs.readFileSync('renderer/index.html', 'utf8'))[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');
const SHEETS = ['player.css', 'nav-bar.css', 'modal.css', 'queue-panel.css', 'eroscripts.css', 'editor.css'];
// Mirrors BACKEND_MISSING in app.js and electron/python-bridge.js.
const BACKEND_MISSING = 'backend-executable-missing';
// What the stubbed layout says the visible banner measures: 66 px tall,
// under the 48 px nav bar.
const BANNER_BOX = { height: 66, top: 48, bottom: 114, left: 0, right: 1280, width: 1280, x: 0, y: 48 };

let styles = [];
let pushStatus;
let chrome;
let app;

const banner = () => document.getElementById('backend-banner');
const root = () => document.documentElement;
const cs = (el) => getComputedStyle(el);

/** Resolve var(--x, fallback) against :root's computed custom properties, as Chromium does. */
function resolve(value) {
  let out = String(value);
  for (let i = 0; i < 10 && out.includes('var('); i++) {
    out = out.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fb) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || (fb ?? '').trim();
    });
  }
  return out;
}
const isOpaque = (color) => {
  const c = resolve(color).trim();
  if (/^#[0-9a-f]{6}$/i.test(c) || /^#[0-9a-f]{3}$/i.test(c)) return true;
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) return false;
  const parts = m[1].split(',').map((s) => s.trim());
  return parts.length === 3 || Number(parts[3]) === 1;
};

function mountApp({ view = 'library', wco = false } = {}) {
  document.body.innerHTML = BODY;
  root().classList.toggle('has-wco', wco);
  root().removeAttribute('style');
  root().classList.remove('backend-banner-shown');
  // app.js: this.navBar.init(document.getElementById('app')), which prepends.
  new NavBar({ onNavigate: () => {} }).init(document.getElementById('app'));
  document.getElementById('app').dataset.view = view;
  const nav = document.querySelector('.nav-bar');
  if (view === 'player') {
    nav.hidden = true;
    document.getElementById('library-container').hidden = true;
    document.getElementById('player-container').hidden = false;
  }
  banner().getBoundingClientRect = () => ({ ...BANNER_BOX, ...(view === 'player' ? { top: 0, y: 0, bottom: 66 } : {}) });

  chrome = [];
  window.funsync = {
    onBackendStatus: (cb) => { pushStatus = cb; },
    getBackendHealth: async () => ({ state: 'unknown' }),
    openLogFile: async () => ({ success: true }),
    restartBackend: async () => ({ success: true }),
    updateWindowChrome: (theme, opts) => chrome.push(opts ? { theme, ...opts } : { theme }),
  };
  const App = liftAppClass(['_initBackendBanner', '_syncCaptionOverlay', '_captionRect'], {
    document, t, eventBus, BackendBannerState, BACKEND_MISSING, showToast: () => {},
  });
  app = new App();
  app.settings = { get: () => 'dark' };
  app._currentView = () => view;
  app._initBackendBanner();
  return app;
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  styles = SHEETS.map((f) => {
    const el = document.createElement('style');
    el.textContent = fs.readFileSync(`renderer/styles/${f}`, 'utf8');
    document.head.appendChild(el);
    return el;
  });
});
afterEach(() => {
  for (const s of styles) s.remove();
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  vi.restoreAllMocks();
});

describe('where the banner is (V80)', () => {
  it('is a row of #app directly under the nav bar, in the flow, not pinned over it', () => {
    mountApp();
    pushStatus({ state: 'down', detail: 'exit code 3' });
    const b = banner();
    expect(b.hidden).toBe(false);
    expect(b.parentElement.id).toBe('app');
    expect(b.previousElementSibling.classList.contains('nav-bar')).toBe(true);
    expect(b.nextElementSibling.id).toBe('library-container');
    // In the flow of #app's flex column: not fixed or absolute, keeps its height.
    expect(['static', 'relative']).toContain(cs(b).position);
    expect(cs(b).flexShrink).toBe('0');
    // Still above a dialog's backdrop (1000) and toasts (2000).
    expect(Number(cs(b).zIndex)).toBeGreaterThan(2000);
  });

  it('is opaque in both states: nothing under it shows through its text', () => {
    mountApp();
    pushStatus({ state: 'down' });
    expect(isOpaque(cs(banner()).backgroundColor)).toBe(true);
    // The tint is a layer over that colour, not the only paint.
    expect(cs(banner()).backgroundImage).toContain('--state-error-soft');
    pushStatus({ state: 'restarting' });
    expect(banner().classList.contains('backend-banner--restarting')).toBe(true);
    expect(isOpaque(cs(banner()).backgroundColor)).toBe(true);
    expect(cs(banner()).backgroundImage).toContain('--state-warning-soft');
    // The light theme's surface is opaque too.
    root().dataset.theme = 'light';
    expect(isOpaque(cs(banner()).backgroundColor)).toBe(true);
    delete root().dataset.theme;
  });

  it('keeps role="alert", and Restart / View Logs / dismiss as they were', () => {
    mountApp();
    pushStatus({ state: 'down', detail: BACKEND_MISSING });
    expect(banner().getAttribute('role')).toBe('alert');
    expect(document.getElementById('backend-banner-title').textContent).toBe(EN.backend.missingTitle);
    expect(document.getElementById('backend-banner-restart').hidden).toBe(true);
    document.getElementById('backend-banner-dismiss').click();
    expect(banner().hidden).toBe(true);
  });

  it('wraps its buttons to their own row rather than crushing the text in a narrow window', () => {
    mountApp();
    pushStatus({ state: 'down' });
    expect(cs(banner().querySelector('.backend-banner__inner')).flexWrap).toBe('wrap');
    expect(cs(banner().querySelector('.backend-banner__actions')).marginLeft).toBe('auto');
  });
});

describe('what it tells the rest of the window', () => {
  it('publishes its height and bottom edge while it shows, and takes them back when it goes', () => {
    mountApp();
    expect(root().classList.contains('backend-banner-shown')).toBe(false);
    pushStatus({ state: 'down' });
    expect(root().classList.contains('backend-banner-shown')).toBe(true);
    expect(root().style.getPropertyValue('--backend-banner-h')).toBe('66px');
    expect(root().style.getPropertyValue('--backend-banner-bottom')).toBe('114px');

    document.getElementById('backend-banner-dismiss').click();
    expect(root().classList.contains('backend-banner-shown')).toBe(false);
    expect(root().style.getPropertyValue('--backend-banner-h')).toBe('');
    expect(root().style.getPropertyValue('--backend-banner-bottom')).toBe('');

    pushStatus({ state: 'restarting' });
    expect(root().classList.contains('backend-banner-shown')).toBe(true);
    pushStatus({ state: 'running' });
    expect(root().classList.contains('backend-banner-shown')).toBe(false);
  });

  it('a dialog opened while it shows (Settings and every Modal) centres below it, with that much less height', async () => {
    mountApp();
    pushStatus({ state: 'down' });
    const closing = Modal.open({ title: 'Settings', body: '<p>x</p>' });
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay.parentElement).toBe(document.body);
    expect(resolve(cs(overlay).paddingTop)).toBe('114px');
    expect(resolve(cs(overlay.querySelector('.modal-panel')).maxHeight)).toBe('calc(85vh - 114px)');
    // The banner stays above the backdrop.
    expect(Number(cs(banner()).zIndex)).toBeGreaterThan(Number(cs(overlay).zIndex));

    // Banner gone: the dialog is centred in the whole window again.
    pushStatus({ state: 'running' });
    expect(resolve(cs(overlay).paddingTop)).not.toBe('114px');
    expect(resolve(cs(overlay.querySelector('.modal-panel')).maxHeight)).toBe('85vh');
    overlay.querySelector('.modal-close-btn').click();
    await closing;
  });

  it('the Devices and EroScripts panels centre below it too', () => {
    mountApp();
    const appEl = document.getElementById('app');
    const devices = document.createElement('div');
    devices.className = 'connection-panel';
    const es = document.createElement('div');
    es.className = 'eroscripts-panel';
    appEl.append(devices, es);
    pushStatus({ state: 'down' });
    expect(resolve(cs(devices).top)).toBe('calc(50% + 114px / 2)');
    expect(resolve(cs(devices).maxHeight)).toBe('calc(90vh - 114px)');
    expect(resolve(cs(es).top)).toBe('calc(50% + 114px / 2)');
    expect(resolve(cs(es).maxHeight)).toBe('calc(80vh - 114px)');
    pushStatus({ state: 'running' });
    expect(cs(devices).top).toBe('50%');
  });
});

// The banner is z-index 9000 in #app's flow, right under the nav bar. What the
// nav bar opens downwards starts at the banner's top edge, and nothing between
// either of them and the root makes a stacking context, so their z-indexes
// decide which one is drawn, and pressed, where they overlap.
const makesStackingContext = (node) => {
  const s = cs(node);
  return (s.position !== 'static' && s.zIndex !== 'auto')
    || (s.opacity !== '' && Number(s.opacity) < 1)
    || (s.transform && s.transform !== 'none')
    || s.isolation === 'isolate';
};
/** Which of `els` the browser hits where they overlap: the higher z-index, then the later one. */
const topmost = (els) => els.reduce((top, el) => {
  const z = (n) => (cs(n).zIndex === 'auto' ? 0 : Number(cs(n).zIndex));
  if (z(el) > z(top)) return el;
  if (z(el) < z(top)) return top;
  // eslint-disable-next-line no-bitwise
  return top.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING ? el : top;
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('what opens over it (V80 review)', () => {
  const dropdown = () => document.querySelector('.nav-bar__library-dropdown');
  const openSwitcher = async () => {
    document.querySelector('.nav-bar__library-arrow').click();
    await settle(); // the outside-click closer is armed on the next tick
    expect(dropdown().hidden).toBe(false);
  };

  it('the library switcher opens above it: its first options are not under the banner, and pressing one picks it', async () => {
    mountApp();
    pushStatus({ state: 'down', detail: BACKEND_MISSING }); // up for the session
    await openSwitcher();
    // One stacking context for both, so the comparison below is the paint order.
    for (let n = dropdown().parentElement; n; n = n.parentElement) {
      expect(makesStackingContext(n), n.className || n.id || n.tagName).toBe(false);
    }
    expect(makesStackingContext(banner())).toBe(true);
    expect(Number(cs(dropdown()).zIndex)).toBeGreaterThan(Number(cs(banner()).zIndex));

    // A press on "All videos", the first option, where the banner's box and
    // the menu's overlap. Under the banner it landed on the banner, and the
    // menu's outside-click closer shut it without a pick.
    const first = dropdown().querySelector('.nav-bar__library-option');
    const hit = topmost([banner(), dropdown()]) === banner() ? banner() : first;
    hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(dropdown().hidden, 'the press closed the menu: it landed on the banner').toBe(false);
    expect(hit).toBe(first);

    // With no banner the menu is as it always was.
    pushStatus({ state: 'running' });
    expect(cs(dropdown()).zIndex).toBe('50');
  });

  it('a dialog or the Devices panel opened while it is open (a key can: ?, H) still covers it, as before', async () => {
    mountApp();
    pushStatus({ state: 'down' });
    await openSwitcher();
    const closing = Modal.open({ title: 'Keyboard shortcuts', body: '<p>x</p>' });
    const overlay = document.querySelector('.modal-overlay');
    expect(topmost([dropdown(), overlay])).toBe(overlay);
    // ... and the banner stays above that backdrop.
    expect(topmost([overlay, banner()])).toBe(banner());
    overlay.querySelector('.modal-close-btn').click();
    await closing;
    expect(topmost([banner(), dropdown()])).toBe(dropdown());

    // ConnectionPanel mounts its backdrop in #app and shows it with `hidden`.
    const backdrop = document.createElement('div');
    backdrop.className = 'connection-panel__backdrop';
    document.getElementById('app').appendChild(backdrop);
    expect(topmost([dropdown(), backdrop])).toBe(backdrop);
    backdrop.hidden = true;
    expect(topmost([banner(), dropdown()])).toBe(dropdown());
  });
});

/** px of a `calc(a - b)` height, for a box `pct` px tall in a `vh` px window. */
function px(value, { pct, vh }) {
  const expr = resolve(value).replace(/^calc\((.*)\)$/, '$1')
    .replace(/(\d+(?:\.\d+)?)%/g, (_, n) => String((Number(n) / 100) * pct))
    .replace(/(\d+(?:\.\d+)?)vh/g, (_, n) => String((Number(n) / 100) * vh))
    .replace(/px/g, '');
  if (!/^[\d.\s+\-*/()]+$/.test(expr)) throw new Error(`cannot evaluate ${value}`);
  // eslint-disable-next-line no-new-func
  return Function(`return (${expr});`)();
}

describe('the player view (no nav bar)', () => {
  it('with the script editor open, the picture ends where the editor starts, not the banner\'s height behind it', () => {
    const WINDOW_H = 800;
    mountApp({ view: 'player' });
    const player = document.getElementById('player-container');
    const wrapper = player.querySelector('.player__video-wrapper');
    // script-editor.js mounts its 250 px panel at the player's bottom and
    // marks the player while it is open. A toolbar that wraps (R3-23) adds
    // its extra rows to the panel and to the picture's offset alike
    // (--editor-toolbar-extra, measured by the editor; 0 with one row).
    const editor = document.createElement('div');
    editor.className = 'script-editor script-editor--open';
    player.appendChild(editor);
    player.classList.add('player-container--editor-open');
    for (const extra of [null, '40px']) {
      if (extra) document.documentElement.style.setProperty('--editor-toolbar-extra', extra);
      const editorH = px(cs(editor).height, { pct: 0, vh: WINDOW_H });
      expect(editorH).toBe(extra ? 290 : 250);
      expect(cs(editor).bottom).toBe('0px');

      // No banner: the player is the whole window.
      pushStatus({ state: 'running' });
      expect(px(cs(wrapper).height, { pct: WINDOW_H, vh: WINDOW_H }) + editorH).toBe(WINDOW_H);

      // Banner up: the player is what is left under it.
      pushStatus({ state: 'down' });
      const playerH = WINDOW_H - BANNER_BOX.height;
      expect(px(cs(wrapper).height, { pct: playerH, vh: WINDOW_H }) + editorH).toBe(playerH);

      // The docked mini-player is not the view's rest, and the editor is not
      // drawn in it: the picture fills the corner (R4 fix-up, real-app
      // verifier 2). This used to assert the 100vh − 250 px rule here, which
      // pinned the bug: the editor's graph filled the 340x191 corner and lay
      // over the mini bar's buttons.
      player.classList.add('player-container--mini');
      expect(cs(editor).display).toBe('none');
      expect(cs(wrapper).height).toBe('100%');
      player.classList.remove('player-container--mini');
    }
    document.documentElement.style.removeProperty('--editor-toolbar-extra');
  });

  it('the banner is the top row and the player takes what is left, not a full 100vh', () => {
    mountApp({ view: 'player' });
    const player = document.getElementById('player-container');
    expect(cs(player).height).toBe('100vh');
    pushStatus({ state: 'down' });
    expect(banner().nextElementSibling.hidden).toBe(true); // library hidden
    expect(cs(player).height).toBe('auto');
    expect(cs(player).minHeight).toBe('0px');
    expect(root().style.getPropertyValue('--backend-banner-bottom')).toBe('66px');
    pushStatus({ state: 'running' });
    expect(cs(player).height).toBe('100vh');
  });

  it('a docked mini-player keeps its corner size', () => {
    mountApp();
    const player = document.getElementById('player-container');
    player.hidden = false;
    player.classList.add('player-container--mini');
    pushStatus({ state: 'down' });
    expect(cs(player).height).toBe('191px');
    expect(cs(player).position).toBe('fixed');
  });

  it('with the Windows caption buttons over its right end, it reserves their strip', () => {
    mountApp({ view: 'player', wco: true });
    pushStatus({ state: 'down' });
    // jsdom reorders env()'s arguments when it serialises a calc(); the
    // declaration is calc(100vw - env(titlebar-area-width, 100vw)).
    expect(cs(banner()).paddingRight).toMatch(/^calc\(100vw - env\(.*titlebar-area-width/);
    // (-webkit-app-region is Chromium-only, jsdom drops it: checked live.)
  });

  it('under the nav bar it needs no reserve: the nav bar holds the caption buttons', () => {
    mountApp({ view: 'library', wco: true });
    pushStatus({ state: 'down' });
    expect(['0', '0px']).toContain(cs(banner()).paddingRight);
  });

  it('the queue panel starts under it', () => {
    mountApp({ view: 'player' });
    // queue-panel.js gives the aside its class.
    const panel = () => {
      const el = document.getElementById('queue-panel');
      el.classList.add('queue-panel');
      return el;
    };
    expect(resolve(cs(panel()).top)).toBe('0px');
    pushStatus({ state: 'down' });
    expect(resolve(cs(panel()).top)).toBe('66px');
    mountApp({ view: 'player', wco: true });
    pushStatus({ state: 'down' });
    const wcoTop = resolve(cs(panel()).top);
    expect(wcoTop).toContain('66px');
    expect(wcoTop).toContain('titlebar-area-height');
  });

  it('the caption strip is themed chrome over the banner, and goes back over the video when it goes', () => {
    mountApp({ view: 'player', wco: true });
    app._syncCaptionOverlay();
    expect(chrome.at(-1)).toMatchObject({ overVideo: true });
    pushStatus({ state: 'down' });
    expect(chrome.at(-1)).toEqual({ theme: 'dark' });
    pushStatus({ state: 'running' });
    expect(chrome.at(-1)).toMatchObject({ overVideo: true });
  });
});
