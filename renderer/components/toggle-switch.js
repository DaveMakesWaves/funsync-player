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
 * @param {(next: boolean) => void} [o.onChange] not called while locked
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
    if (onChange) onChange(next);
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
