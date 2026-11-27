// The Pattern block: ONE set of rows, used identically by Settings > Playback
// > Gap Filler, Orgasm Switch (X) and Edge Hold (Z). Dave, 2026-11-19: "give
// them all the same options laid out the same way showing a preview of the
// pattern allowing them to select a pattern, speed, min max range and
// anything else one of those options offers that the other two dont"
// (notes/features/DESIGN-pattern-settings-unify.md §1). Each feature keeps
// its own "when" rows above the block (settings-panel.js), in the same row
// style, and shows the block only while its source is a pattern.
//
//   Quick picks [Slow tease v]           the built-in presets; "Custom" once
//                                        anything is changed by hand
//   Group       [All groups v]           the library's families + Simple shapes
//   Pattern     [Choose a pattern… v]    endings marked ("plays once, then holds")
//               Brisk strokes the whole length.
//   Preview     [~~~~~~~~~~~~~~~~]       8 s of what plays (the Test playhead)
//               Average 120 units/s, peak 180 units/s
//   Speed       [----o----] 200 units a second  [↻]   ↻ = its own speed
//   Reverse     [ o]
//   Range       [Pattern's own v]        Pattern's own / Exact / Follow the script
//     Lowest / Highest                   (Exact)
//     Depth / Centre [↻]                 (Follow the script)
//               (a note when the range is too narrow and plays wider)
//               [Test]                   plays the preview on the devices
//
// Units a second only (Dave: "Units/s only"): there is no BPM anywhere here.
// Dave, 2026-11-17, kept for all three: no default pattern for X and Z (the
// list starts on "Choose a pattern…", id null, and the rows that shape a
// pattern wait for a choice); the endings are offered, not hidden.
//
// The value is pattern-choice.js's shared shape. Every committed change hands
// the new value to `onChange`; the caller saves it through
// patternChoiceWrites (never an old key). The preview and the Test button
// play the SAME rendered sample (renderPatternSample), so what you see is
// what you feel. Built with createElement only: the names come from the
// locale files, never markup.

import { t } from '../js/i18n.js';
import { listFamilies, listPatterns, describePattern } from '../js/pattern-library.js';
import { patternSpeedBounds, isOneShotPattern } from '../js/pattern-source.js';
import {
  normalizePatternChoice, listQuickPicks, quickPickIdFor, renderPatternSample, patternStats, RANGE_MODES, widenedBand,
} from '../js/pattern-choice.js';
import { PREVIEW_WINDOW_MS, PREVIEW_SCRIPT_RANGE, drawSamplePreview } from '../js/filler-preview.js';
import { createToggleSwitch, applyToggleState } from './toggle-switch.js';

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

/** One row in the panel's row style; `row` names it for the parity test and the CSS. */
function field(labelText, forId, row) {
  const node = el('div', { className: 'settings-panel__field', 'data-row': row });
  node.appendChild(el(forId ? 'label' : 'span', { className: 'settings-panel__field-label', for: forId || null }, labelText));
  return node;
}

/** The Speed slider's bounds when the library does not know the id (never NaN). */
const FALLBACK_SPEED = Object.freeze({ min: 10, max: 600, own: 100 });

const DEPTH = Object.freeze({ min: 10, max: 100, step: 5, own: 100 });
const CENTRE = Object.freeze({ min: 0, max: 100, step: 5, mid: 50 });

/** Run `fn` on the next frame where there is one (a slider drag renders once a frame), else now. */
const nextFrame = (fn) => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  fn();
  return null;
};

/**
 * @param {object} o
 * @param {string} o.idPrefix — every control's id starts with it (e.g. 'sp-edge-pattern')
 * @param {'gapFiller'|'orgasm'|'edge'} o.feature — whose block this is (the Test owner)
 * @param {object} [o.value] — the saved choice (readPatternChoice), normalised here
 * @param {(value: object) => void} [o.onChange] — every committed change
 * @param {string} [o.label] — the group's accessible name ("Gap Filler pattern")
 * @param {string} [o.oneShotHint] — what an ending does for this feature
 * @param {{start: Function, stop: Function, activeOwner: any}} [o.testSession] — createPatternTestSession
 * @param {(status: 'busy'|'no-devices') => void} [o.onTestRefused] — the caller says why (a toast)
 * @param {object} [o.sampleOptions] — more for renderPatternSample (Gap Filler: its maxJoinSpeed)
 * @returns {{ element: HTMLElement, getValue: () => object, setValue: (v: object) => void,
 *   refresh: () => void, getSample: () => object, destroy: () => void }}
 */
export function createPatternBlock({
  idPrefix, feature, value, onChange, label, oneShotHint, testSession, onTestRefused, sampleOptions,
} = {}) {
  let current = normalizePatternChoice(value);
  let sample = { actions: [], warnings: [] };
  let head = null; // the Test playhead, 0-1, while this block's test runs
  const testing = () => !!testSession && testSession.activeOwner === feature;
  const id = (s) => `${idPrefix}-${s}`;
  const root = el('div', {
    className: 'pattern-block', id: idPrefix, role: 'group', 'aria-label': label || null, 'data-feature': feature,
  });

  // --- 1. Quick picks ---
  const quickRow = field(t('settingsPanel.patternBlock.quickPicks'), id('quick'), 'quick');
  const quickSel = el('select', { id: id('quick'), className: 'settings-panel__input settings-panel__input--select' });
  quickRow.appendChild(quickSel);
  const picks = (() => { try { return listQuickPicks() || []; } catch { return []; } })();
  // Nothing chosen yet (X / Z start there): the list says so instead of
  // claiming a preset or "Custom".
  const quickNone = el('option', { value: '', disabled: true }, t('patterns.ui.choose'));
  quickSel.appendChild(quickNone);
  for (const p of picks) quickSel.appendChild(el('option', { value: p.id }, t(p.labelKey)));
  // "Custom" is a state, not something to pick: it shows once a value has
  // been changed by hand, and choosing it would change nothing.
  quickSel.appendChild(el('option', { value: 'custom', disabled: true }, t('filler.preset.custom')));

  // --- 2. Group + 3. Pattern ---
  const families = listFamilies().filter((f) => listPatterns({ family: f.id }).length > 0);
  const famRow = field(t('patterns.ui.family'), id('family'), 'family');
  const famSel = el('select', { id: id('family'), className: 'settings-panel__input settings-panel__input--select' });
  famSel.appendChild(el('option', { value: '' }, t('patterns.ui.allFamilies')));
  for (const f of families) famSel.appendChild(el('option', { value: f.id }, t(f.nameKey)));
  famRow.appendChild(famSel);

  const patRow = field(t('patterns.ui.pattern'), id('id'), 'pattern');
  const patSel = el('select', { id: id('id'), className: 'settings-panel__input settings-panel__input--select', 'aria-describedby': id('desc') });
  patRow.appendChild(patSel);
  const desc = el('div', { className: 'settings-panel__hint', id: id('desc') });
  // An ending: what this feature does with a one-shot shape.
  const onceHint = el('div', { className: 'settings-panel__hint', id: id('once') }, oneShotHint || t('patterns.ui.oneShotHint'));

  // --- 4. Preview ---
  const previewRow = field(t('settingsPanel.patternBlock.preview'), null, 'preview');
  const canvas = el('canvas', {
    id: id('preview'), className: 'pattern-block__preview', width: 260, height: 60,
    role: 'img', 'aria-label': t('settingsPanel.patternBlock.previewAria'), 'aria-describedby': id('stats'),
  });
  previewRow.appendChild(canvas);
  const stats = el('div', { className: 'settings-panel__hint pattern-block__stats', id: id('stats') });

  // --- 5. Speed ---
  const speedRow = field(t('patterns.ui.speed'), id('speed'), 'speed');
  const speed = el('input', { type: 'range', id: id('speed'), className: 'settings-panel__input settings-panel__input--range', step: 1 });
  const speedVal = el('span', { id: id('speed-val'), className: 'settings-panel__field-value' });
  const speedReset = el('button', {
    type: 'button', id: id('speed-reset'), className: 'settings-panel__field-reset',
    title: t('patterns.ui.reset'), 'aria-label': t('patterns.ui.reset'),
  }, '↻');
  speedRow.append(speed, speedVal, speedReset);

  // --- 6. Reverse ---
  const revRow = field(t('patterns.ui.reverse'), null, 'reverse');
  const reverse = createToggleSwitch({
    checked: current.reversed,
    label: t('patterns.ui.reverse'),
    onChange: (next) => { commit({ reversed: next }); },
  });
  reverse.id = id('reverse');
  revRow.appendChild(reverse);

  // --- 7. Range ---
  const rangeRow = field(t('patterns.ui.range'), id('range-mode'), 'range');
  const rangeSel = el('select', { id: id('range-mode'), className: 'settings-panel__input settings-panel__input--select' });
  const RANGE_LABELS = {
    own: 'patterns.ui.rangeOwn',
    exact: 'settingsPanel.patternBlock.rangeExact',
    script: 'settingsPanel.patternBlock.rangeScript',
  };
  for (const mode of RANGE_MODES) rangeSel.appendChild(el('option', { value: mode }, t(RANGE_LABELS[mode] || mode)));
  rangeRow.appendChild(rangeSel);

  const slider = (parent, key, labelText, { min, max, step }) => {
    const row = field(labelText, id(key), key);
    const input = el('input', { type: 'range', id: id(key), className: 'settings-panel__input settings-panel__input--range', min, max, step });
    const val = el('span', { id: id(`${key}-val`), className: 'settings-panel__field-value' });
    row.append(input, val);
    parent.appendChild(row);
    return { row, input, val };
  };
  // Exact: Lowest / Highest.
  const exactRows = el('div', { id: id('range-exact'), className: 'pattern-block__sub' });
  const lo = slider(exactRows, 'min', t('patterns.ui.rangeMin'), { min: 0, max: 100, step: 1 });
  const hi = slider(exactRows, 'max', t('patterns.ui.rangeMax'), { min: 0, max: 100, step: 1 });
  // Follow the script: Depth % (and Centre) of the script's own range.
  const scriptRows = el('div', { id: id('range-script'), className: 'pattern-block__sub' });
  const depth = slider(scriptRows, 'depth', t('settingsPanel.playback.fillerDepth'), DEPTH);
  const centre = slider(scriptRows, 'centre', t('settingsPanel.patternBlock.centre'), CENTRE);
  const centreReset = el('button', {
    type: 'button', id: id('centre-reset'), className: 'settings-panel__field-reset',
    title: t('settingsPanel.patternBlock.centreReset'), 'aria-label': t('settingsPanel.patternBlock.centreReset'),
  }, '↻');
  centre.row.appendChild(centreReset);
  scriptRows.appendChild(el('div', { className: 'settings-panel__hint', id: id('range-script-hint') }, t('settingsPanel.patternBlock.rangeScriptHint')));
  // The engine widens a range too narrow for the pattern to move in: said
  // here, under the range rows.
  const widened = el('div', { className: 'settings-panel__hint', id: id('range-widened'), role: 'status' });

  // --- 8. Test / Stop ---
  const testRow = el('div', { className: 'settings-panel__field pattern-block__test-row', 'data-row': 'test' });
  testRow.appendChild(el('span', { className: 'settings-panel__field-label', 'aria-hidden': 'true' }));
  const testBtn = el('button', {
    type: 'button', id: id('test'), className: 'settings-panel__add-btn', 'aria-describedby': id('test-hint'),
  }, t('settingsPanel.playback.fillerTest'));
  const testHint = el('span', { className: 'settings-panel__hint pattern-block__test-hint', id: id('test-hint') }, t('settingsPanel.patternBlock.testHint'));
  testRow.append(testBtn, testHint);

  root.append(
    quickRow, famRow, patRow, desc, onceHint,
    previewRow, stats,
    speedRow, revRow,
    rangeRow, exactRows, scriptRows, widened,
    testRow,
  );

  // --- painting ---
  const patternOption = (p) => {
    const name = t(`patterns.${p.id}.name`);
    return el('option', { value: p.id }, p.loopable ? name : t('patterns.ui.oneShotName', { name }));
  };
  // The Group only filters the list (Dave, 2026-11-19 ~15:05: "Only filter
  // the list"): the pattern chosen stays until another is picked, so a group
  // that leaves it out still shows it, first, above the group's own.
  const fillPatterns = (family) => {
    patSel.replaceChildren();
    patSel.appendChild(el('option', { value: '' }, t('patterns.ui.choosePattern')));
    const list = listPatterns({ family: family || undefined });
    if (current.id !== null && !list.some((p) => p.id === current.id)) {
      const kept = describePattern(current.id);
      if (kept) patSel.appendChild(patternOption(kept));
    }
    for (const p of list) patSel.appendChild(patternOption(p));
  };
  // Where the pattern lives on its own, in the device's coordinates: a
  // range is where the strokes go whichever way up they play, so a
  // reversed pattern's own place is the mirror of its catalogue place.
  const ownPlace = () => {
    const r = describePattern(current.id)?.range || [0, 100];
    const a = Math.round(r[0]);
    const b = Math.round(r[1]);
    return current.reversed ? { min: 100 - b, max: 100 - a } : { min: a, max: b };
  };
  const bounds = () => {
    let b = null;
    try { b = current.id !== null ? patternSpeedBounds(current.id) : null; } catch { b = null; }
    return b || { ...FALLBACK_SPEED, own: Number.isFinite(current.speed) ? current.speed : FALLBACK_SPEED.own };
  };
  const speedText = (v) => t('patterns.ui.speedValue', { speed: v });
  // The speeds as they are (PF-R2): square's and sawtooth's instant jumps in
  // X and Z have no speed, so the line says they are instant instead of a number.
  const statsText = (s) => {
    if (s.instant > 0 && !(s.peak > 0)) return t('settingsPanel.patternBlock.statsInstantOnly');
    if (s.instant > 0) return t('settingsPanel.patternBlock.statsWithInstant', { avg: s.avg, max: s.peak });
    return t('settingsPanel.playback.fillerStats', { avg: s.avg, max: s.peak });
  };
  const depthText = (v) => t('settingsPanel.patternBlock.depthValue', { pct: v });
  // Untouched, the row says the speed that plays, even one the slider cannot
  // hold (pf-review PF-R5: an upgraded 1000 u/s or 3.33 u/s read "600" /
  // "10", the input's clamp, while the summary said 1000 / 3). The slider
  // only clamps it once it is moved.
  const paintSpeedValue = () => {
    const untouched = !speed.dataset.moved && current.speed !== null;
    speedVal.textContent = speedText(untouched ? String(Math.round(current.speed)) : speed.value);
    speed.setAttribute('aria-valuetext', speedVal.textContent);
  };
  const paintRangeValues = () => {
    lo.val.textContent = lo.input.value;
    hi.val.textContent = hi.input.value;
    depth.val.textContent = depthText(depth.input.value);
    depth.input.setAttribute('aria-valuetext', depth.val.textContent);
    const ownCentre = current.centrePct === null && !centre.input.dataset.moved;
    centre.val.textContent = ownCentre ? t('settingsPanel.patternBlock.centreOwn') : centre.input.value;
    centre.input.setAttribute('aria-valuetext', centre.val.textContent);
  };

  /** The choice as the controls show it now (a slider being dragged included). */
  const liveChoice = () => {
    const c = { ...current };
    // A control is being moved by hand: an upgraded Generated pattern's own
    // rate ends there, as at commit.
    delete c.legacyRate;
    if (current.id === null) return c;
    c.speed = speed.dataset.moved ? Number(speed.value) : current.speed;
    if (current.rangeMode === 'exact') { c.min = Number(lo.input.value); c.max = Number(hi.input.value); }
    if (current.rangeMode === 'script') {
      c.depthPct = Number(depth.input.value);
      c.centrePct = centre.input.dataset.moved ? Number(centre.input.value) : current.centrePct;
    }
    return c;
  };

  const drawPreview = () => {
    drawSamplePreview(canvas, sample.actions, { playhead: head });
  };
  const renderPreview = (choice) => {
    let out = null;
    try {
      out = choice.id === null ? null
        // `feature`: Gap Filler's sample is its own output for a gap (the
        // joins, square and sawtooth ramped); X's and Z's is their loop.
        : renderPatternSample(choice, {
          ...(sampleOptions || {}), durationMs: PREVIEW_WINDOW_MS, scriptRange: PREVIEW_SCRIPT_RANGE, feature,
        });
    } catch { out = null; }
    sample = {
      actions: Array.isArray(out?.actions) ? out.actions : [],
      warnings: Array.isArray(out?.warnings) ? out.warnings : [],
    };
    drawPreview();
    let s = null;
    if (sample.actions.length >= 2) {
      try { s = patternStats(sample.actions); } catch { s = null; }
    }
    stats.textContent = s ? statsText(s) : '';
    stats.hidden = !s;
    // Nothing to play, nothing to test; a running test can always be stopped.
    testBtn.disabled = sample.actions.length < 2 && !testing();
    paintWidened(choice);
  };
  // The note names the band that plays: the engine's own numbers when it
  // gives them, else where the rendered sample really goes. The summary row
  // reads it the same way (pattern-choice.js widenedBand): a range under
  // 5 units, Lowest = Highest included, plays 5 wide (fix 2026-11-20).
  const paintWidened = (choice) => {
    const to = widenedBand(choice, sample.warnings, sample.actions);
    widened.hidden = !to;
    widened.textContent = to ? t('settingsPanel.playback.patternRangeWidened', { lo: to[0], hi: to[1] }) : '';
  };

  let pending = false;
  const schedulePreview = () => {
    if (pending) return;
    pending = true;
    nextFrame(() => { pending = false; renderPreview(liveChoice()); });
  };

  const paintQuick = () => {
    if (current.id === null) { quickSel.value = ''; return; }
    let pick = 'custom';
    try { pick = quickPickIdFor(current) || 'custom'; } catch { pick = 'custom'; }
    quickSel.value = picks.some((p) => p.id === pick) ? pick : 'custom';
  };

  const paint = () => {
    delete speed.dataset.moved;
    delete centre.input.dataset.moved;
    paintQuick();
    // No pattern chosen: the list shows "Choose a pattern…" and the rows
    // that shape and play a pattern wait for one.
    const chosen = current.id !== null;
    for (const row of [previewRow, speedRow, revRow, rangeRow, testRow]) row.hidden = !chosen;
    if (!chosen) {
      patSel.value = '';
      desc.textContent = '';
      desc.hidden = true;
      onceHint.hidden = true;
      exactRows.hidden = true;
      scriptRows.hidden = true;
      renderPreview(current);
      return;
    }
    // The list shows the chosen group ("All groups" shows every pattern),
    // and the pattern chosen whatever the group (fillPatterns).
    fillPatterns(famSel.value);
    patSel.value = current.id;
    desc.hidden = false;
    desc.textContent = t(`patterns.${current.id}.desc`);
    onceHint.hidden = !isOneShotPattern(current.id);
    const b = bounds();
    speed.min = String(b.min);
    speed.max = String(b.max);
    speed.value = String(current.speed ?? b.own);
    speedReset.hidden = current.speed === null;
    paintSpeedValue();
    applyToggleState(reverse, { checked: current.reversed, label: t('patterns.ui.reverse') });
    rangeSel.value = RANGE_MODES.includes(current.rangeMode) ? current.rangeMode : 'own';
    exactRows.hidden = rangeSel.value !== 'exact';
    scriptRows.hidden = rangeSel.value !== 'script';
    const place = current.min !== null && current.max !== null ? { min: current.min, max: current.max } : ownPlace();
    lo.input.value = String(place.min);
    hi.input.value = String(place.max);
    depth.input.value = String(current.depthPct ?? DEPTH.own);
    centre.input.value = String(current.centrePct ?? CENTRE.mid);
    centreReset.hidden = current.centrePct === null;
    paintRangeValues();
    renderPreview(current);
  };

  function commit(patch) {
    // Changed by hand: a new choice, under the 600 u/s ceiling (an upgraded
    // Generated pattern kept its own rate only until now; PF-R2).
    current = normalizePatternChoice({ ...current, ...patch, legacyRate: false });
    paint();
    if (onChange) onChange({ ...current });
  }

  // --- events ---
  quickSel.addEventListener('change', () => {
    const pick = picks.find((p) => p.id === quickSel.value);
    if (!pick) { paintQuick(); return; }
    // A quick pick sets pattern, speed and range together.
    current = normalizePatternChoice(pick.choice);
    const fam = describePattern(current.id)?.family || '';
    if (famSel.value && famSel.value !== fam) { famSel.value = fam; fillPatterns(fam); }
    paint();
    if (onChange) onChange({ ...current });
  });
  famSel.addEventListener('change', () => {
    // Only a filter (Dave, 2026-11-19 ~15:05, for all three; it replaces the
    // 11-17 "a group without it clears the choice"): the list narrows, the
    // pattern chosen stays and plays until another is picked. Nothing changes.
    fillPatterns(famSel.value);
    patSel.value = current.id ?? '';
  });
  patSel.addEventListener('change', () => {
    // A new pattern starts at its own speed and, when the range was the
    // old pattern's exact place, at its own place. "Follow the script" is a
    // share of the script, not of the pattern, so it stays.
    commit({
      id: patSel.value || null,
      speed: null,
      ...(current.rangeMode === 'exact' ? { rangeMode: 'own', min: null, max: null } : {}),
    });
  });
  speed.addEventListener('input', () => { speed.dataset.moved = '1'; paintSpeedValue(); speedReset.hidden = false; schedulePreview(); });
  speed.addEventListener('change', () => commit({ speed: Number(speed.value) }));
  speedReset.addEventListener('click', () => {
    commit({ speed: null });
    // The ↻ just hid itself: keep focus in the dialog (Space would play the video).
    speed.focus();
  });
  rangeSel.addEventListener('change', () => {
    const mode = rangeSel.value;
    if (mode === 'exact') {
      const place = current.min !== null && current.max !== null ? { min: current.min, max: current.max } : ownPlace();
      commit({ rangeMode: 'exact', ...place });
    } else if (mode === 'script') {
      commit({ rangeMode: 'script', depthPct: current.depthPct ?? DEPTH.own });
    } else {
      commit({ rangeMode: 'own' });
    }
  });
  // The moved thumb stops at the other one, so Lowest never passes Highest.
  lo.input.addEventListener('input', () => {
    if (Number(lo.input.value) > Number(hi.input.value)) lo.input.value = hi.input.value;
    paintRangeValues();
    schedulePreview();
  });
  hi.input.addEventListener('input', () => {
    if (Number(hi.input.value) < Number(lo.input.value)) hi.input.value = lo.input.value;
    paintRangeValues();
    schedulePreview();
  });
  for (const s of [lo.input, hi.input]) {
    s.addEventListener('change', () => commit({ min: Number(lo.input.value), max: Number(hi.input.value) }));
  }
  depth.input.addEventListener('input', () => { paintRangeValues(); schedulePreview(); });
  depth.input.addEventListener('change', () => commit({ depthPct: Number(depth.input.value) }));
  centre.input.addEventListener('input', () => {
    centre.input.dataset.moved = '1';
    centreReset.hidden = false;
    paintRangeValues();
    schedulePreview();
  });
  centre.input.addEventListener('change', () => commit({ centrePct: Number(centre.input.value) }));
  centreReset.addEventListener('click', () => {
    commit({ centrePct: null });
    centre.input.focus();
  });

  // --- Test ---
  const endTest = () => {
    head = null;
    testBtn.textContent = t('settingsPanel.playback.fillerTest');
    testBtn.disabled = sample.actions.length < 2;
    drawPreview();
  };
  testBtn.addEventListener('click', () => {
    if (!testSession) return;
    if (testing()) { testSession.stop(feature); return; }
    const status = testSession.start(feature, sample.actions, {
      onProgress: (progress) => { head = progress; drawPreview(); },
      onEnd: endTest,
    });
    if (status === 'started') {
      head = 0;
      testBtn.textContent = t('settingsPanel.playback.fillerTestStop');
      drawPreview();
    } else if ((status === 'busy' || status === 'no-devices') && onTestRefused) {
      onTestRefused(status);
    }
  });

  // A preview drawn while hidden (Playback not open yet, the block off) has
  // no width to draw at: draw again once it has one.
  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => drawPreview());
    resizeObserver.observe(canvas);
  }

  famSel.value = (current.id !== null && describePattern(current.id)?.family) || '';
  fillPatterns(famSel.value);
  paint();

  return {
    element: root,
    getValue: () => ({ ...current }),
    setValue: (v) => { current = normalizePatternChoice(v); paint(); },
    /** Draw again (the block was just shown). */
    refresh: () => drawPreview(),
    /** What the preview shows and Test plays. */
    getSample: () => ({ actions: sample.actions.slice(), warnings: sample.warnings.slice() }),
    destroy: () => {
      if (testing()) testSession.stop(feature);
      resizeObserver?.disconnect();
    },
  };
}
