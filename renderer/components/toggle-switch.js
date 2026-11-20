// Shared toggle switch.
//
// Extracted from `.settings-panel__source-toggle`, which was already a proper
// switch (track + thumb, role="switch", 36px hit area) but was named for and
// coupled to the settings panel and defined in modal.css. Promoted here so the
// next feature that needs a switch does not copy-paste it.
//
// What is NEW versus the old one: a LOCKED state. "Off because I turned it off"
// and "off because the drive is missing" must not look identical, or the user
// concludes the app forgot their setting.

/**
 * @param {object} o
 * @param {boolean} o.checked
 * @param {boolean} [o.locked]   forced off and not interactive, with a reason
 * @param {string}  [o.label]    accessible name
 * @param {string}  [o.title]    tooltip; for a locked switch, say WHY
 * @param {(next: boolean) => boolean|void} [o.onChange] not called while
 *        locked. Return `false` to REJECT the change — the switch springs
 *        back. Any other return (including undefined) accepts it.
 * @param {string}  [o.className] extra class, e.g. the old BEM name
 * @returns {HTMLButtonElement}
 */
export function createToggleSwitch({
  checked = false,
  locked = false,
  label = '',
  title = '',
  onChange = null,
  className = '',
} = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `toggle-switch${className ? ` ${className}` : ''}`;
  el.setAttribute('role', 'switch');

  applyToggleState(el, { checked, locked, label, title });

  el.addEventListener('click', () => {
    // Guard in JS as well as via `disabled`: the row around this is clickable
    // and a synthetic click could otherwise flip a locked switch.
    if (el.dataset.locked === 'true') return;
    const next = el.getAttribute('aria-checked') !== 'true';

    // MOVE THE SWITCH. This used to call `onChange` and nothing else, so the
    // control never changed state on click — it only appeared to work where
    // the caller happened to rebuild the row afterwards (the sources list
    // calls renderSources()). Anywhere that did not, the switch sat visually
    // unchanged while the setting behind it flipped: "hide file names in logs
    // toggle just doesnt work when clicked" (Dave, 2026-08-25), reported
    // twice, because the redaction really was saving each time.
    //
    // Worse than cosmetic. `next` is derived from `aria-checked`, which never
    // updated, so every subsequent click recomputed the SAME value and wrote
    // it again — the switch could be turned on and then never off.
    //
    // Optimistic, then reverted if the handler returns false, so a caller that
    // refuses a change (an unreachable source) still gets the last word.
    // `locked` is false here by definition — we returned above otherwise.
    applyToggleState(el, { checked: next, locked: false, label, title });

    let accepted = true;
    try {
      if (onChange) accepted = onChange(next) !== false;
    } catch (err) {
      accepted = false;
      console.error('[toggle-switch] onChange threw, reverting:', err);
    }
    if (!accepted) applyToggleState(el, { checked: !next, locked: false, label, title });
  });

  return el;
}

/**
 * Re-apply state to an existing switch, so callers can update in place instead
 * of rebuilding the row (which would lose focus).
 */
export function applyToggleState(el, { checked = false, locked = false, label = '', title = '' } = {}) {
  if (!el) return;
  // A locked switch always READS as off: it is not active, whatever the user's
  // stored preference is. The preference itself is untouched in settings — see
  // source-state.js — this is presentation only.
  const on = !!checked && !locked;

  el.setAttribute('aria-checked', String(on));
  el.classList.toggle('toggle-switch--on', on);
  el.classList.toggle('toggle-switch--locked', !!locked);

  el.dataset.locked = String(!!locked);
  el.disabled = !!locked;
  el.setAttribute('aria-disabled', String(!!locked));
  // Keep it out of the tab order when locked — a control that cannot act
  // should not be a stop for keyboard users.
  if (locked) el.setAttribute('tabindex', '-1');
  else el.removeAttribute('tabindex');

  if (label) el.setAttribute('aria-label', label);
  if (title) el.title = title;
  else el.removeAttribute('title');
}
