/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL variant dropdown, speed popover and toast
 * container render into a document, the REAL player.css is applied so
 * getComputedStyle reads where the toasts sit, and the class follows the
 * menus through a MutationObserver (notes/CLAUDE.md "Test environments").
 */
// FT-073 (also in v0.9.2): a persistent error toast covered the player's
// variant dropdown. Toasts are fixed at bottom:80px, centred, z-index 2000;
// the dropdown opens upward from the control bar (z-index 20), so its items
// sat under the toast and could not be clicked.
//
// While the variant dropdown, the speed popover or the overflow menu is open,
// `body.controls-popover-open` moves the toast container to the top of the
// player (top:56px). No toast is hidden. The REAL app.js methods are lifted
// (helpers/app-methods.js): _wireControlsPopoverToasts, _showVariantDropdown
// and _wireSpeedControl, with the REAL showToast.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { showToast } from '../../renderer/js/toast.js';
// _wireSpeedControl moves focus into its popover with these (menu-keys.js, 2026-11-25).
import { wireMenuKeys, moveMenuFocus, focusMenuFromKeyboard } from '../../renderer/js/menu-keys.js';

const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

let Lifted;
let app;
let observer;

beforeAll(() => {
  Lifted = liftAppClass(['_wireControlsPopoverToasts', '_showVariantDropdown', '_markVariantItemIfMissing', '_variantLabelText', '_wireSpeedControl'], {
    document, window, t: (k) => k, showToast,
    eventBus: { on() {} }, PLAYBACK_RATE_PRESETS: [0.5, 1, 1.5],
    wireMenuKeys, moveMenuFocus, focusMenuFromKeyboard,
  });
});

beforeEach(() => {
  document.head.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  // The control bar's three menus and the toast container, as index.html has them.
  document.body.className = '';
  document.body.innerHTML = `
    <div id="app" data-view="player">
      <div id="player-controls">
        <div id="variant-selector" class="variant-selector">
          <button id="variant-btn" class="variant-selector__btn"><span id="variant-btn-label"></span></button>
          <div id="variant-dropdown" class="variant-selector__dropdown" hidden></div>
        </div>
        <button id="speed-chip" hidden><span id="speed-chip-label"></span></button>
        <button id="btn-overflow" aria-haspopup="menu" aria-expanded="false"></button>
        <div id="controls-overflow-menu" class="controls-overflow__menu" role="menu" hidden>
          <button id="btn-speed-menu" class="controls-overflow__item"><span id="speed-menu-current"></span></button>
        </div>
        <div id="speed-popover" class="speed-popover" role="menu" hidden></div>
      </div>
      <div id="outside"></div>
    </div>
    <div id="toast-container" class="toast-container" aria-live="polite"></div>`;
  const values = new Map();
  app = Object.assign(new Lifted(), {
    settings: { get: (k) => values.get(k), set: (k, v) => values.set(k, v) },
    _allVariantsWithManual: [{ label: 'Default' }, { label: 'Soft' }, { label: 'Intense' }],
    _activeVariantIndex: 0,
    _currentVideoPath: 'D:\\Lib\\Variant Clip.mp4',
    _getPreferredVariantLabel: () => null,
    _setPreferredVariantLabel: () => {},
    _switchVariant: vi.fn(),
    _showAddVariantModal: vi.fn(),
    videoPlayer: { video: { playbackRate: 1 }, setPlaybackRate: vi.fn() },
  });
  app._wireSpeedControl();
  observer = app._wireControlsPopoverToasts();
});

afterEach(() => {
  observer?.disconnect();
  if (app._variantDropdownClose) document.removeEventListener('click', app._variantDropdownClose, true);
});

const raised = () => document.body.classList.contains('controls-popover-open');
const toastBox = () => getComputedStyle(document.getElementById('toast-container'));
const dropdown = () => document.getElementById('variant-dropdown');
const press = (key, target = document.body) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('toasts move off the control bar while one of its menus is open (FT-073)', () => {
  it('the variant dropdown: open -> class on, toasts at top:56px; a choice closes it -> back at bottom:80px', async () => {
    showToast('x'.repeat(200), 'error', 0);    // persistent, as the report had it
    expect(toastBox().bottom).toBe('80px');

    app._showVariantDropdown();
    await flush();
    expect(dropdown().hidden).toBe(false);
    expect(raised()).toBe(true);
    expect(toastBox().top).toBe('56px');
    expect(toastBox().bottom).toBe('auto');
    // The toast is still there: moved, never hidden.
    expect(document.querySelectorAll('#toast-container .toast--error')).toHaveLength(1);

    dropdown().querySelectorAll('.variant-selector__item')[1].click();
    await flush();
    expect(app._switchVariant).toHaveBeenCalledWith(1);
    expect(dropdown().hidden).toBe(true);
    expect(raised()).toBe(false);
    expect(toastBox().bottom).toBe('80px');
  });

  it('the variant dropdown closed by Esc: class off, and the press is taken (the A-B loop is not cleared)', async () => {
    app._showVariantDropdown();
    await flush();
    expect(raised()).toBe(true);

    const item = dropdown().querySelector('button');
    item.focus();
    const e = press('Escape', item);
    await flush();

    expect(dropdown().hidden).toBe(true);
    expect(e.defaultPrevented).toBe(true);   // keyboard.js stops there (FT-072)
    expect(raised()).toBe(false);
    expect(document.activeElement?.id).toBe('variant-btn');
  });

  it('the variant dropdown closed by an outside click: class off', async () => {
    app._showVariantDropdown();
    await flush();                              // the outside-click listener arms on the next tick
    expect(raised()).toBe(true);

    document.getElementById('outside').click();
    await flush();
    expect(dropdown().hidden).toBe(true);
    expect(raised()).toBe(false);
  });

  it('the speed popover: open from the overflow menu, then close by Esc, a choice or an outside click', async () => {
    const popover = document.getElementById('speed-popover');
    const open = async () => {
      document.getElementById('btn-speed-menu').click();
      await flush();
      expect(popover.hidden).toBe(false);
      expect(raised()).toBe(true);
    };

    await open();
    press('Escape', popover.querySelector('button'));
    await flush();
    expect(raised()).toBe(false);

    await open();
    popover.querySelector('.speed-popover__item').click();
    await flush();
    expect(app.videoPlayer.setPlaybackRate).toHaveBeenCalled();
    expect(raised()).toBe(false);

    await open();
    document.getElementById('outside').click();
    await flush();
    expect(popover.hidden).toBe(true);
    expect(raised()).toBe(false);
  });

  it('the overflow menu open counts too', async () => {
    const menu = document.getElementById('controls-overflow-menu');
    menu.hidden = false;
    await flush();
    expect(raised()).toBe(true);
    expect(toastBox().top).toBe('56px');
    menu.hidden = true;
    await flush();
    expect(raised()).toBe(false);
  });

  it('nothing open: the toasts stay where they always were', () => {
    expect(raised()).toBe(false);
    expect(toastBox().bottom).toBe('80px');
  });
});
