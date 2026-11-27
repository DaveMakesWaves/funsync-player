// The gamepad recording menu and live readout (editor work list 2.6,
// 2026-11-24). OFS's recording mode panel has a Controller source, a "Two
// axes" switch that records stick X into roll and Y into pitch, an Invert
// box and two greyed sliders showing where the stick is. FunSync's version:
//
//   openGamepadRecordMenu   a short menu on the editor's own context menu
//                           (editor-context-menu.js), so keys, focus,
//                           fullscreen and closing behave like the rest of
//                           the editor: which pad, which axis each stick
//                           direction records into, the two flips, Start /
//                           Stop. Choosing an axis opens the axis list in the
//                           same place; choosing from it comes back here.
//   createGamepadRecordHud  two small bars (one per axis) for the toolbar
//                           while recording, as OFS's two sliders.
//
// Only axes that sit at 50 at rest are offered: a stick springs back to the
// centre, and an axis whose rest is 0 (vibration, pump, suction, lube) would
// buzz at half power whenever the stick is let go.

import { openContextMenu, activeContextMenu } from '../js/editor-context-menu.js';
import { t } from '../js/i18n.js';
import { AXIS_DEFINITIONS } from '../js/multi-axis.js';
import { cleanPadName, DEFAULT_GAMEPAD_MAPPING } from '../js/gamepad-recorder.js';

/** The axes a stick can record into, in the order offered (OFS's pair first). */
export const GAMEPAD_TARGET_SUFFIXES = Object.freeze(['roll', 'pitch', 'twist', 'surge', 'sway']);
/** The stroke (the main script) as a target. */
export const MAIN_TARGET = 'main';

/**
 * The target list for the menu.
 * @param {object} [o]
 * @param {Set<string>} [o.present] — canonical suffixes the video has (ScriptEditor._axesPresent())
 * @param {boolean} [o.withMain] — offer the stroke too (false when there is no main script)
 * @returns {Array<{id:string,label:string,missing:boolean}>}
 */
export function gamepadTargetAxes({ present = new Set(), withMain = true } = {}) {
  const out = [];
  for (const suffix of GAMEPAD_TARGET_SUFFIXES) {
    const def = AXIS_DEFINITIONS.find((d) => d.suffix === suffix);
    if (!def) continue;
    // The New axis menu's own label ("Roll (R1)", script-editor.js _openNewAxisMenu).
    out.push({ id: def.suffix, label: `${def.label} (${def.tcode})`, missing: !present.has(def.suffix) });
  }
  if (withMain) out.push({ id: MAIN_TARGET, label: t('editor.mainAxisLabel'), missing: false });
  return out;
}

// The pad watch of the menu that is open (one menu at a time).
let _padWatch = null;

function stopPadWatch() {
  if (!_padWatch) return;
  _padWatch.win.removeEventListener('gamepadconnected', _padWatch.fn);
  _padWatch.win.removeEventListener('gamepaddisconnected', _padWatch.fn);
  _padWatch = null;
}

function normalizeMapping(current) {
  return { ...DEFAULT_GAMEPAD_MAPPING, ...(current || {}) };
}

/**
 * Open the gamepad recording menu at (x, y) in viewport pixels.
 *
 * @param {object} o
 * @param {number} o.x
 * @param {number} o.y
 * @param {Array<{id:string,label:string,missing?:boolean}>} o.axes — gamepadTargetAxes()
 * @param {{x:string,y:string,invertX?:boolean,invertY?:boolean}} [o.current] — the mapping now
 * @param {string|null} [o.padName] — the connected pad's name (GamepadRecorder.padName())
 * @param {(mapping: object) => void} [o.onPick] — after every change, with the whole new mapping
 * @param {(mapping: object) => void} [o.onStart] — "Start recording" chosen (offered only when given)
 * @param {() => void} [o.onStop] — "Stop recording" chosen (offered while `recording`)
 * @param {boolean} [o.recording]
 * @param {() => string|null} [o.getPadName] — read again when a pad connects or goes while the menu is open
 * @param {HTMLElement|null} [o.returnFocus]
 * @param {Document} [o.doc]
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openGamepadRecordMenu({
  x, y, axes = [], current, padName = null, onPick, onStart, onStop, recording = false,
  getPadName, returnFocus = null, doc = document,
}) {
  stopPadWatch();
  const mapping = normalizeMapping(current);
  const labelOf = (id) => {
    const ax = axes.find((a) => a.id === id);
    if (!ax) return String(id || '');
    return ax.missing ? t('editor.gamepad.axisNew', { axis: ax.label }) : ax.label;
  };
  const again = (next, name = padName) => openGamepadRecordMenu({
    x, y, axes, current: next, padName: name, onPick, onStart, onStop, recording, getPadName, returnFocus, doc,
  });
  const change = (next) => {
    try { onPick?.({ ...next }); } catch { /* the caller's problem; the menu still follows */ }
    again(next);
  };

  const items = [
    {
      label: padName ? t('editor.gamepad.pad', { name: padName }) : t('editor.gamepad.noPad'),
      disabled: true,
      role: 'status',
    },
    {
      label: t('editor.gamepad.stickX', { axis: labelOf(mapping.x) }),
      onSelect: () => openAxisPicker('x'),
    },
    {
      label: t('editor.gamepad.stickY', { axis: labelOf(mapping.y) }),
      onSelect: () => openAxisPicker('y'),
    },
    {
      label: t('editor.gamepad.invertX'),
      checked: !!mapping.invertX,
      onSelect: () => change({ ...mapping, invertX: !mapping.invertX }),
    },
    {
      label: t('editor.gamepad.invertY'),
      checked: !!mapping.invertY,
      onSelect: () => change({ ...mapping, invertY: !mapping.invertY }),
    },
  ];
  if (recording && typeof onStop === 'function') {
    items.push({ label: t('editor.gamepad.stop'), onSelect: () => onStop(), role: 'action' });
  } else if (!recording && typeof onStart === 'function') {
    items.push({
      label: t('editor.gamepad.start'),
      disabled: !padName,
      hint: padName ? t('editor.gamepad.startHint') : t('editor.gamepad.needPad'),
      onSelect: () => onStart({ ...mapping }),
      role: 'action',
    });
  }

  const handle = openContextMenu({ x, y, items, ariaLabel: t('editor.gamepad.menu'), returnFocus, doc });
  decorate(handle.el, items, 'gamepad-record-menu');

  // Chromium shows a pad to the page only after one of its buttons is
  // pressed, so "press a button" must turn into the pad's name while the
  // menu is open (the event fires on that press).
  const win = doc.defaultView;
  if (win?.addEventListener) {
    const fn = (e) => {
      if (activeContextMenu() !== handle.el) { stopPadWatch(); return; }
      let name = null;
      try { name = typeof getPadName === 'function' ? getPadName() : null; } catch { name = null; }
      if (name == null && e?.type === 'gamepadconnected' && e.gamepad?.id) name = cleanPadName(e.gamepad.id);
      if ((name || null) !== (padName || null)) again(mapping, name || null);
    };
    win.addEventListener('gamepadconnected', fn);
    win.addEventListener('gamepaddisconnected', fn);
    _padWatch = { win, fn };
  }

  function openAxisPicker(which) {
    stopPadWatch();
    const other = which === 'x' ? mapping.y : mapping.x;
    const pickItems = axes.map((ax) => ({
      label: ax.missing ? t('editor.gamepad.axisNew', { axis: ax.label }) : ax.label,
      // One axis cannot take both directions: the second take would
      // replace the first over the same stretch.
      disabled: ax.id === other,
      hint: ax.id === other ? t(which === 'x' ? 'editor.gamepad.onOtherY' : 'editor.gamepad.onOtherX') : '',
      checked: ax.id === mapping[which],
      radio: true,
      onSelect: () => change({ ...mapping, [which]: ax.id }),
    }));
    const picker = openContextMenu({
      x, y, items: pickItems, returnFocus, doc,
      ariaLabel: t(which === 'x' ? 'editor.gamepad.pickX' : 'editor.gamepad.pickY'),
    });
    decorate(picker.el, pickItems, 'gamepad-record-menu gamepad-record-menu--axes');
    // The focus starts on the axis chosen now, as a select list does.
    const btns = picker.el.querySelectorAll('.editor-context-menu__item');
    const at = pickItems.findIndex((it) => it.checked && !it.disabled);
    if (at >= 0 && btns[at]) btns[at].focus();
    return picker;
  }

  return handle;
}

/**
 * Give the generic menu's buttons the roles a checkbox / radio / status line
 * needs: openContextMenu makes every row a plain menuitem.
 */
function decorate(menuEl, items, className) {
  for (const c of className.split(/\s+/)) if (c) menuEl.classList.add(c);
  const btns = menuEl.querySelectorAll('.editor-context-menu__item');
  items.forEach((item, i) => {
    const btn = btns[i];
    if (!btn) return;
    if (typeof item.checked === 'boolean') {
      btn.setAttribute('role', item.radio ? 'menuitemradio' : 'menuitemcheckbox');
      btn.setAttribute('aria-checked', String(item.checked));
      btn.classList.add('gamepad-record-menu__check');
    }
    if (item.role === 'status') btn.classList.add('gamepad-record-menu__status');
    if (item.role === 'action') btn.classList.add('gamepad-record-menu__action');
  });
}

/**
 * Two small bars, one per recorded axis, for the editor toolbar while a
 * gamepad records (OFS shows the same as two greyed sliders). Each bar fills
 * from the centre (50) toward where the stick is.
 *
 * @param {object} [o]
 * @param {Document} [o.doc]
 * @returns {{ el: HTMLElement, update: (f: {a?:number|null,b?:number|null,labelA?:string,labelB?:string,recording?:boolean,playing?:boolean}) => void, destroy: () => void }}
 */
export function createGamepadRecordHud({ doc = document } = {}) {
  const el = doc.createElement('span');
  el.className = 'gamepad-hud';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', t('editor.gamepad.hud'));
  el.hidden = true;

  const rows = ['a', 'b'].map((key) => {
    const row = doc.createElement('span');
    row.className = 'gamepad-hud__axis';
    const label = doc.createElement('span');
    label.className = 'gamepad-hud__label';
    const track = doc.createElement('span');
    track.className = 'gamepad-hud__track';
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = doc.createElement('span');
    fill.className = 'gamepad-hud__fill';
    track.appendChild(fill);
    const value = doc.createElement('span');
    value.className = 'gamepad-hud__value';
    row.append(label, track, value);
    el.appendChild(row);
    return { key, label, track, fill, value, shown: null, name: '' };
  });

  function update({ a = null, b = null, labelA, labelB, recording = false, playing = false } = {}) {
    el.hidden = false;
    el.classList.toggle('gamepad-hud--live', !!(recording && playing));
    const vals = { a, b };
    const names = { a: labelA, b: labelB };
    for (const r of rows) {
      if (typeof names[r.key] === 'string' && names[r.key] !== r.name) {
        r.name = names[r.key];
        r.label.textContent = r.name;
        r.track.setAttribute('aria-label', r.name);
      }
      const v = vals[r.key];
      const whole = Number.isFinite(v) ? Math.round(Math.max(0, Math.min(100, v))) : null;
      if (whole === r.shown) continue; // 60 updates a second: touch the DOM only on a change
      r.shown = whole;
      if (whole === null) {
        r.fill.style.left = '50%';
        r.fill.style.width = '0%';
        r.value.textContent = '–';
        r.track.removeAttribute('aria-valuenow');
      } else {
        r.fill.style.left = `${Math.min(50, whole)}%`;
        r.fill.style.width = `${Math.abs(whole - 50)}%`;
        r.value.textContent = String(whole);
        r.track.setAttribute('aria-valuenow', String(whole));
      }
    }
  }

  return {
    el,
    update,
    destroy() { el.remove(); },
  };
}
