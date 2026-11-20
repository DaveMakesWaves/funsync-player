// "Set pattern…": the Pattern block in a drawer, the SAME for Gap Filler,
// Orgasm Switch (X) and Edge Hold (Z). Dave, 2026-11-19 (~14:20): "the gap
// filler edge hold and orgasm switch sections are rather big, can there be a
// set pattern button on the setting menu in place of those and instead have
// all the guff open up in a drawer with an apply button or something then we
// can reuse the same component for all without the settings menu being overly
// busy".
//
// Settings keeps each feature's short "when" rows and ONE summary row
// (createPatternSummaryRow): what is chosen, in a line, and "Set pattern…".
// The button opens the drawer (openPatternDrawer) over the Settings dialog:
//
//   ┌ Orgasm Switch pattern ─────────────── ✕ ┐
//   │ Quick picks / Group / Pattern / Preview │  the block (pattern-source-rows.js)
//   │ Speed / Reverse / Range / Test          │  scrolls on its own
//   ├─────────────────────────────────────────┤
//   │                       [Cancel] [Apply]  │
//   └─────────────────────────────────────────┘
//
// It works on a DRAFT: the block's changes stay in the drawer; Apply hands
// the draft to `onApply` (the caller saves it through patternChoiceWrites)
// when it differs from what was saved (an unchanged Apply writes nothing);
// Cancel, Escape (the caller's Modal onEscape asks `cancel()`), the ✕ and a
// click on the dimmed Settings around it discard it, nothing written. Test
// plays the draft; closing the drawer stops a running test (the block's
// destroy). Focus moves into the drawer on open, Tab stays inside it, and
// goes back to the "Set pattern…" button on close. Built with createElement
// only: every word comes from the locale files.

import { t } from '../js/i18n.js';
import { patternSpeedBounds } from '../js/pattern-source.js';
import { normalizePatternChoice, renderPatternSample, sameChoice } from '../js/pattern-choice.js';
import { PREVIEW_SCRIPT_RANGE, drawSamplePreview } from '../js/filler-preview.js';
import { createPatternBlock } from './pattern-source-rows.js';

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** ms of the applied choice the summary's small graph shows. */
export const SUMMARY_GRAPH_MS = 4000;

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

/**
 * The choice in one line: "Quick full strokes, 150 units/s, reversed, 20 to 80",
 * or "No pattern chosen yet". The speed shown is the one that plays (the
 * pattern's own when none is set). Units a second only.
 * @param {object} choice — pattern-choice.js shared shape
 * @returns {string}
 */
export function summarizePatternChoice(choice) {
  const c = normalizePatternChoice(choice);
  if (c.id === null) return t('settingsPanel.patternBlock.summaryNone');
  let own = null;
  try { own = patternSpeedBounds(c.id)?.own ?? null; } catch { own = null; }
  const speed = Math.round(c.speed ?? own ?? 0);
  let range;
  if (c.rangeMode === 'exact') range = t('settingsPanel.patternBlock.summaryRangeExact', { lo: c.min, hi: c.max });
  else if (c.rangeMode === 'script') range = t('settingsPanel.patternBlock.summaryRangeScript', { pct: Math.round(c.depthPct ?? 100) });
  else range = t('settingsPanel.patternBlock.summaryRangeOwn');
  const key = c.reversed ? 'settingsPanel.patternBlock.summaryReversed' : 'settingsPanel.patternBlock.summary';
  return t(key, { name: t(`patterns.${c.id}.name`), speed, range });
}

/**
 * The one summary row a feature's Settings section shows in place of the block:
 * the choice in a line, "Set pattern…", and under the line a small still graph
 * of what the APPLIED choice plays (Dave, ~14:25: "a visual represntation of
 * the pattern they created in the setting menu under the description"). The
 * graph is decorative (the line says it in words), drawn again only by
 * setValue (after Apply, never from the drawer's draft), and hidden while no
 * pattern is chosen.
 * @param {object} o
 * @param {string} o.idPrefix — '<idPrefix>-summary', '<idPrefix>-set', '<idPrefix>-summary-graph'
 * @param {string} o.featureName — "Gap Filler" etc., for the button's accessible name
 * @param {'gapFiller'|'orgasm'|'edge'} [o.feature] — whose output the graph draws (Gap Filler: its own)
 * @param {object} [o.sampleOptions] — more for renderPatternSample (Gap Filler: maxJoinSpeed)
 * @param {object} [o.value] — the saved choice
 * @param {() => void} [o.onSet] — "Set pattern…" pressed
 * @returns {{ element: HTMLElement, button: HTMLButtonElement, setValue: (v: object) => void, refresh: () => void, destroy: () => void }}
 */
export function createPatternSummaryRow({ idPrefix, featureName, feature, sampleOptions, value, onSet } = {}) {
  const wrap = el('div', { className: 'pattern-summary', 'data-row': 'pattern-summary', id: `${idPrefix}-summary-row` });
  const row = el('div', { className: 'settings-panel__field pattern-summary__line' });
  row.appendChild(el('span', { className: 'settings-panel__field-label', id: `${idPrefix}-summary-label` }, t('patterns.ui.pattern')));
  const text = el('span', { className: 'pattern-summary__text', id: `${idPrefix}-summary` });
  const button = el('button', {
    type: 'button',
    id: `${idPrefix}-set`,
    className: 'settings-panel__add-btn pattern-summary__set',
    'aria-label': t('settingsPanel.patternBlock.setPatternAria', { feature: featureName }),
    'aria-describedby': `${idPrefix}-summary`,
    'aria-haspopup': 'dialog',
  }, t('settingsPanel.patternBlock.setPattern'));
  row.append(text, button);
  const graph = el('canvas', {
    id: `${idPrefix}-summary-graph`, className: 'pattern-summary__graph', width: 240, height: 32, 'aria-hidden': 'true',
  });
  wrap.append(row, graph);
  let actions = [];
  const draw = () => { if (!graph.hidden) drawSamplePreview(graph, actions); };
  const setValue = (v) => {
    const c = normalizePatternChoice(v);
    text.textContent = summarizePatternChoice(c);
    // One line, cut with an ellipsis where it does not fit (German at
    // 1280x800, any language at 800x600 / 150 %: pf-verify); the whole line
    // on hover, and in full for a screen reader (the button's description).
    text.title = text.textContent;
    text.classList.toggle('pattern-summary__text--none', c.id === null);
    let out = null;
    try {
      out = c.id === null ? null : renderPatternSample(c, {
        ...(sampleOptions || {}), durationMs: SUMMARY_GRAPH_MS, scriptRange: PREVIEW_SCRIPT_RANGE, feature,
      });
    } catch { out = null; }
    actions = Array.isArray(out?.actions) ? out.actions : [];
    graph.hidden = actions.length < 2;
    draw();
  };
  setValue(value);
  button.addEventListener('click', () => { if (onSet) onSet(); });
  // Drawn while Playback was hidden it had no width: draw again once it has one.
  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(graph);
  }
  return {
    element: wrap,
    button,
    setValue,
    refresh: draw,
    destroy: () => resizeObserver?.disconnect(),
  };
}

/**
 * Open the drawer over `host` (the Settings dialog's panel).
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {string} o.idPrefix — the block's ids (as in Settings before the drawer)
 * @param {'gapFiller'|'orgasm'|'edge'} o.feature
 * @param {string} o.title — "Orgasm Switch pattern"
 * @param {object} o.value — the saved choice: the draft starts as a copy of it
 * @param {(choice: object) => void} o.onApply — save the draft
 * @param {(how: 'apply'|'cancel') => void} [o.onClose] — after it closed (focus back to the button)
 * @param {string} [o.label] [o.oneShotHint] [o.sampleOptions] [o.testSession] [o.onTestRefused] — for the block
 * @returns {{ element: HTMLElement, block: object, getDraft: () => object, apply: () => void,
 *   cancel: () => true, isOpen: () => boolean }}
 */
export function openPatternDrawer({
  host, idPrefix, feature, title, value, onApply, onClose,
  label, oneShotHint, sampleOptions, testSession, onTestRefused,
} = {}) {
  let draft = normalizePatternChoice(value);
  // What was saved when it opened: Apply with nothing changed writes nothing
  // (pf-review PF-R6: an unchanged Apply pinned a value derived from the old
  // keys, so a later change of those in an older build was ignored).
  const opened = { ...draft };
  let open = true;
  const titleId = `${idPrefix}-drawer-title`;

  // The dimmed Settings behind it: a click there discards the draft.
  const root = el('div', { className: 'pattern-drawer', id: `${idPrefix}-drawer`, 'data-feature': feature });
  const sheet = el('div', {
    className: 'pattern-drawer__sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
  });
  const head = el('div', { className: 'pattern-drawer__head' });
  const heading = el('h2', { className: 'pattern-drawer__title', id: titleId }, title);
  const closeBtn = el('button', {
    type: 'button', className: 'pattern-drawer__close', id: `${idPrefix}-drawer-close`,
    'aria-label': t('modal.closeAria', { title }), title: t('common.close'),
  }, '✕');
  head.append(heading, closeBtn);
  const body = el('div', { className: 'pattern-drawer__body' });
  const foot = el('div', { className: 'pattern-drawer__foot' });
  const cancelBtn = el('button', { type: 'button', className: 'modal-btn modal-btn--secondary', id: `${idPrefix}-drawer-cancel` }, t('common.cancel'));
  const applyBtn = el('button', { type: 'button', className: 'modal-btn modal-btn--primary', id: `${idPrefix}-drawer-apply` }, t('settingsPanel.patternBlock.apply'));
  foot.append(cancelBtn, applyBtn);
  sheet.append(head, body, foot);
  root.appendChild(sheet);

  const block = createPatternBlock({
    idPrefix, feature, value: draft, label, oneShotHint, sampleOptions, testSession, onTestRefused,
    // The draft only: nothing is saved until Apply.
    onChange: (v) => { draft = normalizePatternChoice(v); },
  });
  body.appendChild(block.element);

  // Everything else in the Settings dialog is out of reach while it is open.
  const inerted = [];
  for (const sib of host ? [...host.children] : []) {
    if (sib === root || sib.hasAttribute('inert')) continue;
    sib.setAttribute('inert', '');
    inerted.push(sib);
  }
  if (host) host.appendChild(root);

  const close = (how) => {
    if (!open) return;
    open = false;
    block.destroy(); // a running test stops with the drawer
    root.remove();
    for (const sib of inerted) sib.removeAttribute('inert');
    if (onClose) onClose(how);
  };
  const cancel = () => { close('cancel'); return true; };
  const apply = () => {
    if (!open) return;
    const chosen = { ...draft };
    if (onApply && !sameChoice(chosen, opened)) onApply(chosen);
    close('apply');
  };

  closeBtn.addEventListener('click', cancel);
  cancelBtn.addEventListener('click', cancel);
  applyBtn.addEventListener('click', apply);
  root.addEventListener('mousedown', (e) => {
    if (e.target !== root) return;
    // The press's own focus change (to the page, as nothing under it takes
    // focus) would land after the close and take focus off "Set pattern…"
    // (pf-verify 2026-11-19: it ended on BODY; Cancel and Esc were right).
    e.preventDefault();
    cancel();
  });
  // Tab stays in the drawer (the Settings dialog's own trap only knows its
  // first and last control, which are behind the drawer now).
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((n) => !n.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && e.target === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
  });

  block.refresh();
  // Into the drawer: its first choice, so the keyboard starts where the work is.
  (body.querySelector(FOCUSABLE) || closeBtn).focus();

  return {
    element: root,
    block,
    getDraft: () => ({ ...draft }),
    apply,
    cancel,
    isOpen: () => open,
  };
}
