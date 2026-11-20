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
   * @param {Function} [opts.onChange] — (binding|null, keydownEvent?) => void;
   *   fired on each successful capture (with the KeyboardEvent) and on clear.
   * @param {string} [opts.placeholder] — optional override for the
   *   capture-mode placeholder (defaults to t('editor.customKeysPressKey')).
   * @param {string} [opts.ariaLabel] — what this field binds, for a screen
   *   reader (defaults to the generic "Press a key…"). A page with several
   *   capture fields needs each one named.
   */
  constructor({ element, initial, onChange, placeholder, ariaLabel }) {
    this._mount = element;
    this._binding = initial || null;
    this._onChange = onChange || null;
    this._placeholder = placeholder || null;
    this._ariaLabel = ariaLabel || null;
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
    this._root.setAttribute('aria-label', this._ariaLabel || t('editor.customKeysPressKey'));
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
    // The event goes along for a caller that needs more than the physical
    // key: the global hotkeys read `key` for the layout's letter (FT-012).
    if (this._onChange) this._onChange(binding, e);
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
 * render bindings identically. Modifier and named-key words come from the
 * active locale (`keys.*`, FT-014), so call it at render time.
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
  if (mods.ctrl) parts.push(keyName('ctrl', 'Ctrl'));
  if (mods.alt) parts.push(keyName('alt', 'Alt'));
  if (mods.shift) parts.push(keyName('shift', 'Shift'));
  parts.push(prettyCode(b.code));
  return parts.join('+');
}

// Keys whose name differs by language (FT-014): the modifiers, the media
// and volume keys, and the cursor/editing keys, as the keyboards and OS of
// each locale label them ("Strg+Umschalt+P", "Maj", "Entf", "Pos1"...).
// Display only: stored bindings and accelerators keep the English code.
// Letters, digits and F-keys are the same everywhere; the numpad's NAME is
// not ("Ziffernblock", "Pavé num.", "テンキー"), see numpadKeyName (R3-25).
const NAMED_KEY_IDS = {
  Space: 'space', Enter: 'enter', Tab: 'tab', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageUp', PageDown: 'pageDown', PrintScreen: 'printScreen', Escape: 'escape',
  ArrowLeft: 'arrowLeft', ArrowRight: 'arrowRight', ArrowUp: 'arrowUp', ArrowDown: 'arrowDown',
  MediaPlayPause: 'mediaPlayPause', MediaTrackNext: 'mediaNext',
  MediaTrackPrevious: 'mediaPrevious', MediaStop: 'mediaStop',
  AudioVolumeUp: 'volumeUp', AudioVolumeDown: 'volumeDown', AudioVolumeMute: 'volumeMute',
};

/** `keys.<id>` in the active locale; `fallback` when no bundle has it. */
function keyName(id, fallback) {
  const k = `keys.${id}`;
  const s = t(k);
  return typeof s === 'string' && s && s !== k ? s : fallback;
}

/**
 * A numpad key in the active language (R3-25). `keys.numpad` is a template,
 * "Numpad{key}" in English, "Ziffernblock {key}" in German, "テンキー{key}"
 * in Japanese, so each language puts its word and the key the way it reads.
 * English is unchanged: "Numpad5", "Numpad-", and the `?` list's
 * "Numpad 0 – 9" (whatever follows "Numpad" is passed through as written,
 * then doubled spaces are folded). Without a bundle it reads as English.
 * Exported for the `?` overlay's chord column (keyboard-help.js).
 * @param {string} key — what follows "Numpad": "5", "-", " 0 – 9"
 * @returns {string}
 */
export function numpadKeyName(key) {
  const k = String(key ?? '');
  const s = t('keys.numpad', { key: k });
  if (typeof s !== 'string' || !s || s === 'keys.numpad') return `Numpad${k}`;
  return s.replace(/ {2,}/g, ' ').trim();
}

function prettyCode(code) {
  if (NAMED_KEY_IDS[code]) return keyName(NAMED_KEY_IDS[code], code);
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const tail = code.slice(6);
    if (tail === 'Add') return numpadKeyName('+');
    if (tail === 'Subtract') return numpadKeyName('-');
    if (tail === 'Multiply') return numpadKeyName('*');
    if (tail === 'Divide') return numpadKeyName('/');
    if (tail === 'Decimal') return numpadKeyName('.');
    if (tail === 'Enter') return numpadKeyName(keyName('enter', 'Enter'));
    return numpadKeyName(tail);
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
