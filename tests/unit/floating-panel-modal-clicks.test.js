/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Devices and EroScripts panels, the REAL Modal and
 * REAL toasts render into one document, and the bug is in how a click travels
 * through it (notes/CLAUDE.md "Test environments").
 */
// A dialog opened from the Devices panel works with one click and leaves the
// panel open (app test V75, EroScripts #359 a88a88).
//
// The panel closes on an outside click with a document-level CAPTURE
// listener that calls preventDefault + stopPropagation. Modal mounts its
// overlay on <body>, outside the panel, so the first click on the Safety Cap
// confirm's button was taken as "outside": the panel closed and the click
// never reached the button. The dialog stayed, and a second click was needed
// to answer it. A toast's X (the panel raises its own, e.g. the Autoblow
// latency reading) did the same: the panel closed and the toast stayed. The
// EroScripts panel already ignored clicks in a dialog; it now ignores toasts
// as well.
//
// Escape: Modal takes it in a document capture listener and stops it, so it
// never reached the panel's own Escape handler even before the fix. The panel
// now also steps aside while a dialog is open (the EroScripts panel's guard).
// The test pins what the user gets: Escape closes the dialog only.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Modal } from '../../renderer/components/modal.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';
import { EroScriptsPanel } from '../../renderer/components/eroscripts-panel.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { showToast } from '../../renderer/js/toast.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));

const flush = () => new Promise((r) => setTimeout(r, 0));
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
async function dialogOpen() {
  const until = Date.now() + 3000;
  while (overlays().length === 0 && Date.now() < until) await flush();
  expect(overlays()).toHaveLength(1);
  return overlays()[0];
}
/** A click as the browser dispatches it: through the document capture phase. */
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
const escapeOn = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"><div id="player-container"></div></div><div id="toast-container" class="toast-container"></div>';
});
afterEach(async () => {
  for (const o of overlays()) o.querySelector('.modal-close-btn')?.click();
  await flush();
});

const JORDAN = { index: 0, name: 'Svakom Jordan', canVibrate: true, canOscillate: true };

/** The Devices panel, open, with one oscillating device, as a user has it. */
async function openDevicesPanel() {
  const buttplug = {
    connected: true, devices: [JORDAN],
    sendLinear() {}, sendVibrate() {}, sendRotate() {}, sendScalar() {}, sendOscillate() {},
    stopAll() {}, stopDevice() {},
  };
  const buttplugSync = new ButtplugSync({
    videoPlayer: { video: { addEventListener() {}, removeEventListener() {} }, currentTime: 0, paused: true, duration: 60 },
    buttplugManager: buttplug,
    funscriptEngine: { isLoaded: false, getActions: () => [] },
  });
  const values = new Map();
  const panel = new ConnectionPanel({
    handyManager: { on() {}, off() {} }, buttplugManager: buttplug, buttplugSync,
    settings: { get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) },
  });
  buttplug.onDeviceAdded(JORDAN);
  panel.show();
  await flush(); // the outside-click listener is armed on the next task
  const slider = panel._panel.querySelector('.connection-panel__device-safety-section input[type="range"]');
  const isOpen = () => panel._visible && !panel._panel.hidden;
  return { panel, buttplugSync, slider, isOpen };
}

async function raiseCap(slider, v) {
  slider.value = String(v);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  return dialogOpen();
}

describe('the Devices panel and a dialog opened from it (V75)', () => {
  it('one click on the Safety Cap confirm confirms it, and the panel stays open', async () => {
    const { buttplugSync, slider, isOpen } = await openDevicesPanel();
    const dialog = await raiseCap(slider, 100);

    click(dialog.querySelector('.modal-actions .modal-btn--danger'));
    await flush();

    expect(overlays()).toHaveLength(0);
    expect(buttplugSync.getMaxIntensity(0)).toBe(100);
    expect(isOpen()).toBe(true);
  });

  it('one click on Cancel cancels it (the cap goes back to 70), and the panel stays open', async () => {
    const { buttplugSync, slider, isOpen } = await openDevicesPanel();
    const dialog = await raiseCap(slider, 95);

    click(dialog.querySelector('.modal-actions .modal-btn--secondary'));
    await flush();

    expect(overlays()).toHaveLength(0);
    expect(buttplugSync.getMaxIntensity(0)).toBe(70);
    expect(slider.value).toBe('70');
    expect(isOpen()).toBe(true);
  });

  it("a click on the dialog's backdrop cancels the dialog only", async () => {
    const { buttplugSync, slider, isOpen } = await openDevicesPanel();
    const dialog = await raiseCap(slider, 95);

    click(dialog); // the overlay itself = the backdrop
    await flush();

    expect(overlays()).toHaveLength(0);
    expect(buttplugSync.getMaxIntensity(0)).toBe(70);
    expect(isOpen()).toBe(true);
  });

  it('Escape closes the dialog only, from the dialog or from the panel behind it; the next Escape closes the panel', async () => {
    const { panel, buttplugSync, slider, isOpen } = await openDevicesPanel();

    let dialog = await raiseCap(slider, 95);
    escapeOn(dialog.querySelector('.modal-btn--danger'));
    await flush();
    expect(overlays()).toHaveLength(0);
    expect(buttplugSync.getMaxIntensity(0)).toBe(70);
    expect(isOpen()).toBe(true);

    // Focus can still be on the slider when the dialog appears (Modal moves
    // it on the next frame), so the key may start inside the panel.
    dialog = await raiseCap(slider, 96);
    escapeOn(slider);
    await flush();
    expect(overlays()).toHaveLength(0);
    expect(isOpen()).toBe(true);

    escapeOn(slider);
    expect(panel._visible).toBe(false);
  });

  it("a toast's X closes the toast, not the panel", async () => {
    const { isOpen } = await openDevicesPanel();
    showToast(t('connection.autoblow.latencyToast', { ms: 42 }), 'info', 0);
    const toast = document.querySelector('#toast-container .toast');

    click(toast.querySelector('.toast__close'));

    expect(toast.classList.contains('toast--out')).toBe(true);
    expect(isOpen()).toBe(true);
  });

  it('a click really outside still closes the panel, and is still taken', async () => {
    const { isOpen } = await openDevicesPanel();
    const outside = document.getElementById('player-container');
    let reached = false;
    outside.addEventListener('click', () => { reached = true; });

    click(outside);

    expect(isOpen()).toBe(false);
    expect(reached).toBe(false);
  });
});

describe('the EroScripts panel (V75)', () => {
  function openEroScripts() {
    window.funsync = {
      eroscriptsSearch: async () => ({ results: [] }),
      eroscriptsTopic: async () => ({ attachments: [] }),
      eroscriptsTopicImage: async () => null,
      openExternal: () => {},
    };
    const values = new Map([['library.sources', [{ path: 'C:/lib', enabled: true }]]]);
    const panel = new EroScriptsPanel({ settings: { get: (k) => values.get(k), set: (k, v) => values.set(k, v) } });
    panel.show();
    return { panel, isOpen: () => panel._visible && !panel._panel.hidden };
  }

  it("a toast's X (its own \"Saved\" toast) closes the toast, not the panel", async () => {
    const { isOpen } = openEroScripts();
    await flush();
    showToast(t('eroscripts.savedToast', { name: 'alpha.funscript' }), 'info', 0);
    const toast = document.querySelector('#toast-container .toast');

    click(toast.querySelector('.toast__close'));

    expect(toast.classList.contains('toast--out')).toBe(true);
    expect(isOpen()).toBe(true);
  });

  it('a dialog opened over it still answers with one click and leaves it open', async () => {
    const { isOpen } = openEroScripts();
    await flush();
    const answer = Modal.confirm('Title', 'Message');
    click(overlays()[0].querySelector('.modal-btn--danger'));
    expect(await answer).toBe(true);
    expect(isOpen()).toBe(true);
  });
});

// FT-036: a mouse press on a toast's X focused it (Chromium focuses a pressed
// button), and once the toast had gone focus was on <body>. Both panels keep
// their Escape listener on the panel element, so the next Escape went
// nowhere and the panel stayed open. jsdom focuses nothing on mousedown, so
// pressLike() does what Chromium does: focus the nearest focusable under the
// pointer unless a listener cancelled the mousedown. A removed focused
// element leaves focus on <body>, as in Chromium.
function pressLike(el) {
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(down);
  if (!down.defaultPrevented) el.closest('button, input, select, textarea, [tabindex]')?.focus();
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
  click(el);
}
/** The toast's exit animation finishing, which jsdom never plays. */
const finishExit = (toast) => toast.dispatchEvent(new Event('animationend'));
/** A key press where the browser sends it: at the focused element. */
const escapeAtFocus = () => escapeOn(document.activeElement || document.body);

describe("after a toast's X, Escape still reaches the panel (FT-036)", () => {
  it('EroScripts: search focused, press the X of its toast: focus stays in search, Escape closes the panel', async () => {
    window.funsync = {
      eroscriptsSearch: async () => ({ results: [] }),
      eroscriptsTopic: async () => ({ attachments: [] }),
      eroscriptsTopicImage: async () => null,
      openExternal: () => {},
    };
    const values = new Map([['library.sources', [{ path: 'C:/lib', enabled: true }]]]);
    const panel = new EroScriptsPanel({ settings: { get: (k) => values.get(k), set: (k, v) => values.set(k, v) } });
    panel.show();
    await flush();
    const search = panel._panel.querySelector('#es-search-input');
    search.focus();
    expect(document.activeElement).toBe(search);

    showToast(t('eroscripts.savedToast', { name: 'alpha.funscript' }), 'info', 8000);
    const toast = document.querySelector('#toast-container .toast');
    pressLike(toast.querySelector('.toast__close'));
    expect(toast.classList.contains('toast--out')).toBe(true);
    finishExit(toast);
    expect(document.querySelector('#toast-container').contains(toast)).toBe(false);

    expect(document.activeElement).toBe(search);
    escapeAtFocus();
    expect(panel._visible).toBe(false);
  });

  it('Devices: a control focused, press the X of a toast: Escape still closes the panel', async () => {
    const { panel, slider, isOpen } = await openDevicesPanel();
    slider.focus();
    expect(document.activeElement).toBe(slider);

    showToast(t('connection.autoblow.latencyToast', { ms: 42 }), 'info', 8000);
    const toast = document.querySelector('#toast-container .toast');
    pressLike(toast.querySelector('.toast__close'));
    finishExit(toast);

    expect(document.activeElement).toBe(slider);
    expect(isOpen()).toBe(true);
    escapeAtFocus();
    expect(panel._visible).toBe(false);
  });

  it('a press on the toast body (which also dismisses) leaves focus where it was too', async () => {
    const { slider, panel } = await openDevicesPanel();
    slider.focus();
    showToast('x', 'info', 8000);
    const toast = document.querySelector('#toast-container .toast');
    pressLike(toast.querySelector('.toast__body'));
    finishExit(toast);
    expect(document.activeElement).toBe(slider);
    escapeAtFocus();
    expect(panel._visible).toBe(false);
  });

  it('the keyboard still reaches the X: Tab focus and Enter work as before', () => {
    showToast('x', 'info', 0);
    const toast = document.querySelector('#toast-container .toast');
    const x = toast.querySelector('.toast__close');
    x.focus();
    expect(document.activeElement).toBe(x);
    click(x); // Enter on a focused button is its click
    expect(toast.classList.contains('toast--out')).toBe(true);
  });
});
