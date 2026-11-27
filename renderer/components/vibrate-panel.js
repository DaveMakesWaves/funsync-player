// Vibrate panel (Dave, 2026-11-24: "ofs has a plugin for adding vibration
// between two points, can we one up them and add it to the quick options at
// the top with a slider to make the vibration movements larger or smaller").
//
// A small panel under the toolbar's Vibrate button, in both editors: Size
// (how big each vibration move is), Rate (moves per second) and Taper (eases
// in and out at the ends). The result is previewed LIVE on the graph (its
// ghost, as Fill with pattern does) while a slider moves; Apply lands it as
// one undo step through the editor's own route; Esc, Cancel or a click
// outside closes it and the script is untouched. The device limit: the moves
// are spaced so none is faster than the editor's max speed, and the line says
// so when that slowed them down. The editors pass no cap (Dave: scripters
// go over it on purpose for unusual movements); the panel only says when
// the result is faster than the user's speed limit (Settings).

import { t } from '../js/i18n.js';
import { vibrateBetween, vibrateSpacingMs } from '../js/script-modifiers.js';

export const VIBRATE_DEFAULTS = Object.freeze({ size: 12, rate: 8, taper: true });

let _open = null;

/** Close the open panel, if any (Cancel). */
export function closeVibratePanel() {
  _open?.close(false);
}

/** The run the panel works on: the selected points, if they are one run of 2+. */
export function selectedRun(actions, selected) {
  const idx = [...(selected || [])].filter((i) => i >= 0 && i < (actions?.length || 0)).sort((a, b) => a - b);
  if (idx.length < 2) return null;
  if (idx[idx.length - 1] - idx[0] + 1 !== idx.length) return null;   // gaps: not one run
  return idx.map((i) => actions[i]);
}

/** Top speed (units/s) of a list of points in time order. */
function topSpeed(points) {
  let top = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].at - points[i - 1].at;
    if (dt > 0) top = Math.max(top, (Math.abs(points[i].pos - points[i - 1].pos) / dt) * 1000);
  }
  return Math.round(top);
}

/**
 * @param {object} o
 * @param {HTMLElement} o.anchor — the Vibrate button (the panel opens under it)
 * @param {{setGhost:Function, clearGhost:Function, draw:Function}} o.graph — the preview
 * @param {() => Array} o.getActions
 * @param {() => Set<number>} o.getSelected
 * @param {() => number} o.getMaxSpeed — the hard cap: the fastest a device can move (device-speed-caps.js)
 * @param {() => number} [o.getMarkSpeed] — the user's own limit (Settings), only warned about
 * @param {object} [o.initial] — the last choices ({size, rate, taper})
 * @param {(opts:{size:number, rate:number, taper:boolean, maxSpeed:number}) => void} o.onApply
 * @param {(opts:object) => void} [o.onRemember] — the choices, on Apply
 * @param {HTMLElement} [o.returnFocus]
 * @returns {{close:Function, el:HTMLElement}}
 */
export function openVibratePanel(o) {
  if (_open) { _open.close(false); }
  const doc = o.anchor?.ownerDocument || document;
  const opts = { ...VIBRATE_DEFAULTS, ...(o.initial || {}) };
  const root = doc.createElement('div');
  root.className = 'vibrate-panel';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('editor.vibrate.title'));

  const title = doc.createElement('div');
  title.className = 'vibrate-panel__title';
  title.textContent = t('editor.vibrate.title');

  const slider = (name, labelKey, min, max, step, value) => {
    const row = doc.createElement('label');
    row.className = 'vibrate-panel__row';
    const lab = doc.createElement('span');
    lab.textContent = t(labelKey);
    const input = doc.createElement('input');
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.name = name;
    const out = doc.createElement('output');
    out.className = 'vibrate-panel__value';
    row.append(lab, input, out);
    return { row, input, out };
  };
  const size = slider('size', 'editor.vibrate.size', 2, 60, 1, opts.size);
  const rate = slider('rate', 'editor.vibrate.rate', 2, 20, 1, opts.rate);
  const taperRow = doc.createElement('label');
  taperRow.className = 'vibrate-panel__check';
  const taper = doc.createElement('input');
  taper.type = 'checkbox';
  taper.checked = !!opts.taper;
  const taperText = doc.createElement('span');
  taperText.textContent = t('editor.vibrate.taper');
  taperRow.append(taper, taperText);

  const summary = doc.createElement('div');
  summary.className = 'vibrate-panel__summary';
  summary.setAttribute('aria-live', 'polite');

  const actions = doc.createElement('div');
  actions.className = 'vibrate-panel__actions';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'modal-btn modal-btn--secondary';
  cancel.textContent = t('common.cancel');
  const apply = doc.createElement('button');
  apply.type = 'button';
  apply.className = 'modal-btn modal-btn--primary';
  apply.textContent = t('editor.vibrate.apply');
  actions.append(cancel, apply);

  const warn = doc.createElement('div');
  warn.className = 'vibrate-panel__summary vibrate-panel__warn';
  warn.hidden = true;

  root.append(title, size.row, rate.row, taperRow, summary, warn, actions);
  doc.body.appendChild(root);

  // Under the button, kept inside the window.
  const r = o.anchor?.getBoundingClientRect?.() || { left: 8, bottom: 8 };
  const w = root.offsetWidth || 260;
  const vw = doc.defaultView?.innerWidth || 1024;
  root.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
  root.style.top = `${Math.round(r.bottom + 6)}px`;

  const read = () => ({
    size: Number(size.input.value), rate: Number(rate.input.value), taper: taper.checked,
    maxSpeed: Number(o.getMaxSpeed?.()) || 0,
  });

  let frame = 0;
  const update = () => {
    frame = 0;
    const cur = read();
    size.out.textContent = String(cur.size);
    rate.out.textContent = t('editor.vibrate.rateValue', { rate: cur.rate });
    const run = selectedRun(o.getActions?.() || [], o.getSelected?.());
    if (!run) {
      summary.textContent = t('editor.vibrate.needRun');
      warn.hidden = true;
      apply.disabled = true;
      o.graph?.clearGhost?.();
      o.graph?.draw?.();
      return;
    }
    const made = vibrateBetween(run, cur);
    const added = made.length - run.length;
    apply.disabled = added < 1;
    const slowed = cur.maxSpeed > 0 && vibrateSpacingMs(cur.size, cur.rate, cur.maxSpeed) > 1000 / cur.rate + 0.5;
    const top = topSpeed(made);
    // Faster than the user's own limit (Settings): say so; a stock Handy cuts these short.
    const mark = Number(o.getMarkSpeed?.()) || 0;
    summary.textContent = added < 1
      ? t('editor.vibrate.noRoom')
      : `${t('editor.vibrate.summary', { count: added, top })}`
        + `${slowed ? ` ${t('editor.vibrate.slowed', { max: cur.maxSpeed })}` : ''}`;
    // The note on its own line: run on after "units/s" it read as one sentence
    // (hands-on pass, 2026-11-24).
    warn.textContent = added >= 1 && mark > 0 && top > mark ? t('editor.vibrate.overMark', { limit: mark }) : '';
    warn.hidden = !warn.textContent;
    o.graph?.setGhost?.(made, { from: run[0].at, to: run[run.length - 1].at });
    o.graph?.draw?.();
  };
  const schedule = () => {
    if (frame) return;
    const raf = doc.defaultView?.requestAnimationFrame;
    if (typeof raf === 'function') frame = raf(update); else update();
  };
  size.input.addEventListener('input', schedule);
  rate.input.addEventListener('input', schedule);
  taper.addEventListener('change', schedule);

  let closed = false;
  const onDocDown = (e) => { if (!root.contains(e.target) && e.target !== o.anchor && !o.anchor?.contains?.(e.target)) close(false); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    else if (e.key === 'Enter' && !apply.disabled && e.target?.tagName !== 'BUTTON') { e.preventDefault(); e.stopPropagation(); close(true); }
  };
  function close(applied) {
    if (closed) return;
    closed = true;
    if (frame) doc.defaultView?.cancelAnimationFrame?.(frame);
    doc.removeEventListener('mousedown', onDocDown, true);
    root.removeEventListener('keydown', onKey);
    o.graph?.clearGhost?.();
    o.graph?.draw?.();
    const cur = read();
    root.remove();
    _open = null;
    if (applied) {
      o.onRemember?.({ size: cur.size, rate: cur.rate, taper: cur.taper });
      o.onApply?.(cur);
    }
    o.returnFocus?.focus?.({ preventScroll: true });
  }
  cancel.addEventListener('click', () => close(false));
  apply.addEventListener('click', () => close(true));
  root.addEventListener('keydown', onKey);
  doc.addEventListener('mousedown', onDocDown, true);

  update();
  size.input.focus({ preventScroll: true });
  _open = { close, el: root, update };
  return _open;
}

/** The open panel's preview again (the selection changed under it). */
export function refreshVibratePanel() {
  _open?.update();
}
