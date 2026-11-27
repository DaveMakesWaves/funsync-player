// The two clicks of "Align to the video" (editor work list 5.4, 2026-11-24):
// the stroke's tip, then its base, on the video frame. DeviceSimulator
// starts it from its right-click menu and lays its bar along the line
// (../js/sim-align.js has the maths).
//
// A see-through layer over the whole window takes every pointer event while
// it is up, so the player's own handlers never see the two clicks (a click on
// the video plays or pauses it, a double click goes full screen, a wheel
// seeks): the layer is what is under the pointer, and it stops each event
// from bubbling on to the document's listeners. A click counts only on the
// picture (a dashed frame shows where). After the tip, a line follows the
// pointer to show the bar to be. Esc, or the Cancel button, cancels; Esc is
// heard first, on the window, so it does not also leave the player.
// Keys other than Esc pass: Space still pauses, to find the frame.
import { t } from '../js/i18n.js';
import { SIM_ALIGN_MIN_PX, fromVideoFraction, pointInRect, toVideoFraction } from '../js/sim-align.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * The layer stays this long after the second click, still taking events:
 * removing it at once would hand the end of the click (and a fast double
 * click's second half) to the video under the pointer.
 */
export const SIM_ALIGN_LINGER_MS = 250;

/**
 * Start the two clicks.
 * @param {object} opts
 * @param {() => ({content: {left: number, top: number, width: number, height: number}, visible?: object}|null)} opts.getRect
 *   the picture now (`content`, what the fractions are of) and the part of it
 *   on screen (`visible`, where a click counts); null while there is none
 * @param {(align: {tip: {x: number, y: number}, base: {x: number, y: number}}) => void} opts.onDone
 * @param {() => void} [opts.onCancel]
 * @returns {{cancel: () => void, el: HTMLElement, readonly active: boolean}}
 */
export function startSimAlign({ getRect, onDone, onCancel = null }) {
  let tip = null;           // fractions of the picture
  let pointer = null;       // last pointer position on screen
  let active = true;

  const el = document.createElement('div');
  el.className = 'sim-align';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('deviceSim.alignAria'));

  const frame = document.createElement('div');
  frame.className = 'sim-align__frame';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sim-align__svg');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'sim-align__line');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'sim-align__dot');
  dot.setAttribute('r', '5');
  svg.append(line, dot);

  const hint = document.createElement('div');
  hint.className = 'sim-align__hint';
  const step = document.createElement('span');
  step.className = 'sim-align__step';
  step.setAttribute('aria-live', 'polite');
  const keys = document.createElement('span');
  keys.className = 'sim-align__keys';
  keys.textContent = t('deviceSim.alignEsc');
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'sim-align__cancel';
  cancelBtn.textContent = t('common.cancel');
  hint.append(step, keys, cancelBtn);

  el.append(frame, svg, hint);

  const rects = () => {
    const r = getRect?.() || null;
    if (!r?.content) return null;
    return { content: r.content, visible: r.visible || r.content };
  };

  const render = () => {
    if (!active) return;
    step.textContent = t(tip ? 'deviceSim.alignBase' : 'deviceSim.alignTip');
    const r = rects();
    frame.hidden = !r;
    if (r) {
      const v = r.visible;
      frame.style.left = `${v.left}px`;
      frame.style.top = `${v.top}px`;
      frame.style.width = `${v.width}px`;
      frame.style.height = `${v.height}px`;
      hint.style.left = `${v.left + v.width / 2}px`;
      hint.style.top = `${v.top + 12}px`;
    }
    const t0 = tip && r ? fromVideoFraction(r.content, tip) : null;
    svg.style.display = t0 ? '' : 'none';
    if (t0) {
      dot.setAttribute('cx', String(t0.x));
      dot.setAttribute('cy', String(t0.y));
      const end = pointer || t0;
      line.setAttribute('x1', String(t0.x));
      line.setAttribute('y1', String(t0.y));
      line.setAttribute('x2', String(end.x));
      line.setAttribute('y2', String(end.y));
    }
  };

  const teardown = () => {
    active = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', render);
  };
  const removeSoon = () => {
    el.classList.add('sim-align--done');
    setTimeout(() => el.remove(), SIM_ALIGN_LINGER_MS);
  };

  const cancel = () => {
    if (!active) return;
    teardown();
    el.remove();
    try { onCancel?.(); } catch (err) { console.warn('[SimAlign] onCancel failed:', err?.message || err); }
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };

  // Every pointer event stops here: none bubbles on to the document's
  // listeners. The point itself is taken on `click` (down AND up on the
  // layer), so the release never lands on the video either.
  const swallow = (e) => {
    e.stopPropagation();
    if (e.type === 'contextmenu' || e.type === 'mousedown' || e.type === 'dblclick') e.preventDefault();
  };
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'wheel', 'auxclick']) {
    el.addEventListener(type, swallow);
  }
  el.addEventListener('pointermove', (e) => {
    e.stopPropagation();
    if (!active || !tip) return;
    pointer = { x: e.clientX, y: e.clientY };
    render();
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!active || e.button !== 0) return;
    if (e.target?.closest?.('.sim-align__hint')) return;   // the Cancel button's own
    const r = rects();
    if (!r || !pointInRect(r.visible, e.clientX, e.clientY)) return;
    const f = toVideoFraction(r.content, e.clientX, e.clientY);
    if (!tip) {
      tip = f;
      pointer = { x: e.clientX, y: e.clientY };
      render();
      return;
    }
    const t0 = fromVideoFraction(r.content, tip);
    if (Math.hypot(e.clientX - t0.x, e.clientY - t0.y) < SIM_ALIGN_MIN_PX) return;
    teardown();
    removeSoon();
    try { onDone?.({ tip, base: f }); } catch (err) { console.warn('[SimAlign] onDone failed:', err?.message || err); }
  });
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cancel();
  });

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', render);
  document.body.appendChild(el);
  render();

  return {
    cancel,
    el,
    get active() { return active; },
  };
}
