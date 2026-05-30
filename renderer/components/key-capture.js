// KeyCapture — a single-field component that listens for one keydown
// and emits {code, mods}. Esc cancels capture and re-emits the previous
// value (if any). Modifier-only keypresses (Shift / Ctrl / Alt / Meta
// alone) are ignored — capture continues until a non-modifier key
// settles.
//
// Designed to be reused beyond the position-keys settings — anywhere we
// want "click here then press a key" in the future (custom shortcut
// remap, MIDI translator hint capture, etc.).

import { t } from '../js/i18n.js';
import { parseBinding, serializeBinding } from '../js/position-key-resolver.js';

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
  'OSLeft', 'OSRight',
]);

export class KeyCapture {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element — mount point. Replaced with the
   *   component's own root.
   * @param {{code: string, mods?: object}|null} [opts.initial] — initial
   *   binding to display, or null for the empty placeholder.
   * @param {Function} [opts.onChange] — (binding|null) => void; fired on
   *   each successful capture and on clear.
   * @param {string} [opts.placeholder] — optional override for the
   *   capture-mode placeholder (defaults to t('editor.customKeysPressKey')).
   */
  constructor({ element, initial, onChange, placeholder }) {
    this._mount = element;
    this._binding = initial || null;
    this._onChange = onChange || null;
    this._placeholder = placeholder || null;
    this._capturing = false;
    this._boundKeyHandler = (e) => this._handleKeyDown(e);
    this._boundDocClick = (e) => this._handleDocClick(e);
    if (!this._mount) return;
    this._build();
  }

  // --- Public API ---

  get binding() { return this._binding; }

  setBinding(binding) {
    this._binding = binding || null;
    this._render();
  }

  /** Cancel capture mode (used by the parent on Esc / close). */
  cancel() {
    if (!this._capturing) return;
    this._stopCapture();
    this._render();
  }

  destroy() {
    this._stopCapture();
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }

  // --- Internals ---

  _build() {
    this._root = document.createElement('button');
    this._root.type = 'button';
    this._root.className = 'key-capture';
    this._root.setAttribute('aria-label', t('editor.customKeysPressKey'));
    this._root.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._startCapture();
    });
    this._root.addEventListener('keydown', this._boundKeyHandler);
    this._mount.replaceWith(this._root);
    this._render();
  }

  _render() {
    if (!this._root) return;
    this._root.classList.toggle('key-capture--capturing', this._capturing);
    this._root.classList.toggle('key-capture--empty', !this._binding && !this._capturing);
    if (this._capturing) {
      this._root.textContent = this._placeholder || t('editor.customKeysPressKey');
    } else if (this._binding) {
      this._root.textContent = formatBindingLabel(this._binding);
    } else {
      this._root.textContent = this._placeholder || t('editor.customKeysPressKey');
    }
  }

  _startCapture() {
    if (this._capturing) return;
    this._capturing = true;
    this._render();
    this._root.focus();
    // Document-level click listener so clicks elsewhere on the page
    // cancel capture without committing — matches the "click out to
    // dismiss" expectation users have from form controls.
    setTimeout(() => {
      document.addEventListener('mousedown', this._boundDocClick, true);
    }, 0);
  }

  _stopCapture() {
    if (!this._capturing) return;
    this._capturing = false;
    document.removeEventListener('mousedown', this._boundDocClick, true);
  }

  _handleKeyDown(e) {
    if (!this._capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      this._stopCapture();
      this._render();
      return;
    }
    if (MODIFIER_CODES.has(e.code)) {
      // Wait for the non-modifier key to settle.
      return;
    }
    if (e.metaKey) {
      // Meta combos blocked per SCOPE §2 decision #7. Ignore and stay
      // in capture so the user can try a different key.
      return;
    }
    const binding = {
      code: e.code,
      mods: {
        shift: !!e.shiftKey,
        ctrl: !!e.ctrlKey,
        alt: !!e.altKey,
      },
    };
    this._binding = binding;
    this._stopCapture();
    this._render();
    if (this._onChange) this._onChange(binding);
  }

  _handleDocClick(e) {
    if (!this._capturing) return;
    if (this._root && this._root.contains(e.target)) return;
    this._stopCapture();
    this._render();
  }
}

/**
 * Render a (code, mods) binding into a user-friendly label.
 * Pulls common code prefixes ('Key', 'Digit', 'Numpad') into short forms
 * the user expects: 'KeyA' → 'A', 'Digit5' → '5', 'NumpadAdd' → 'Numpad +'.
 *
 * Exported so the settings list, help overlay, and toast messages
 * render bindings identically.
 *
 * @param {{code: string, mods?: object}|string} bindingOrSerialized
 * @returns {string}
 */
export function formatBindingLabel(bindingOrSerialized) {
  const b = typeof bindingOrSerialized === 'string'
    ? parseBinding(bindingOrSerialized)
    : bindingOrSerialized;
  if (!b || !b.code) return '';
  const mods = b.mods || {};
  const parts = [];
  if (mods.ctrl) parts.push('Ctrl');
  if (mods.alt) parts.push('Alt');
  if (mods.shift) parts.push('Shift');
  parts.push(prettyCode(b.code));
  return parts.join('+');
}

function prettyCode(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const tail = code.slice(6);
    if (tail === 'Add') return 'Numpad+';
    if (tail === 'Subtract') return 'Numpad-';
    if (tail === 'Multiply') return 'Numpad*';
    if (tail === 'Divide') return 'Numpad/';
    if (tail === 'Decimal') return 'Numpad.';
    if (tail === 'Enter') return 'NumpadEnter';
    return `Numpad${tail}`;
  }
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Backslash') return '\\';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  if (code === 'Backquote') return '`';
  // Fall-through: F1-F12, Tab, Enter, etc. render verbatim.
  return code;
}

// Re-export so consumers don't have to import from two places.
export { serializeBinding };
