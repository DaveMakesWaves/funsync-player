// GlobalHotkeysSettings — the Settings > Playback rows that bind the three
// global hotkeys (play/pause, Orgasm Switch, Edge Hold).
//
// The feature shipped with main-process registration and the renderer
// handler, but nothing in Settings could set a binding: the only way in was
// hand-editing config.json, and even then it applied only at the next launch
// (V47). Each row here is a KeyCapture plus a remove button. A change is
// written to `player.globalShortcuts` straight away; app.js listens for that
// setting and re-registers with the OS, so it works without a restart.
//
// The store holds Electron accelerators ('Ctrl+Alt+Shift+P'), the form
// main.js registers. KeyCapture speaks {code, mods}; renderer/js/global-hotkeys.js
// converts between the two and decides what may be bound (`hotkeyRisk`,
// V73: a key other apps or typing would lose is refused with a toast saying
// why). A binding saved before that rule, or hand-edited, that breaks it is
// NOT removed or rewritten: the row shows it with a warning line naming the
// reason, and app.js still registers it, so nothing changes silently.
//
// A letter is saved as the letter the keyboard layout puts on the pressed
// key (FT-012): KeyboardEvent.code is the US position, so on German QWERTZ
// the key labelled Z arrives as 'KeyY'. See letterForCode.
//
// What a row says about a saved binding is what the OS answered, not a
// guess (CB-19): app.js emits 'globalShortcuts:registered' with the main
// process's per-binding results after every registration. Refused (Windows
// owns Ctrl+Esc, or another app holds the combination) reads "Not active";
// a risky binding the OS took reads "Still active as saved."; with no answer
// yet a risky one shows only its reason.

import { KeyCapture, formatBindingLabel } from './key-capture.js';
import { t } from '../js/i18n.js';
import { showToast } from '../js/toast.js';
import { eventBus } from '../js/event-bus.js';
import { icon, TriangleAlert } from '../js/icons.js';
import {
  GLOBAL_HOTKEY_ACTIONS, bindingToAccelerator, acceleratorToBinding,
  hotkeyRisk, HOTKEY_RISK_KEYS, sameAccelerator, letterForCode, registrationOf,
} from '../js/global-hotkeys.js';

const SETTING = 'player.globalShortcuts';

// The main process's answer to the last registration, kept here because
// the rows are rebuilt every time Settings opens, long after the boot
// registration answered. Rows on screen repaint when a new answer lands;
// each root maps to its instance weakly, so a closed Settings leaks nothing.
let lastRegistration = null;
const liveRows = new WeakMap();
eventBus.on('globalShortcuts:registered', ({ results } = {}) => {
  lastRegistration = Array.isArray(results) ? results : null;
  if (typeof document === 'undefined') return;
  for (const root of document.querySelectorAll('.global-hotkeys')) liveRows.get(root)?._refresh();
});

/** Forget the last registration answer (tests: each starts with none). */
export function _resetRegistrationForTests() {
  lastRegistration = null;
}

const LABEL_KEYS = {
  playPause: 'settingsPanel.playback.globalHotkeyPlayPause',
  orgasm: 'settingsPanel.playback.globalHotkeyOrgasm',
  edge: 'settingsPanel.playback.globalHotkeyEdge',
  stopAll: 'settingsPanel.playback.globalHotkeyStopAll',
};

export class GlobalHotkeysSettings {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element — mount point, replaced by the rows
   * @param {{get: Function, set: Function}} opts.settings — DataService
   */
  constructor({ element, settings }) {
    this._mount = element;
    this._settings = settings;
    this._rows = {};
    this._layoutMap = null;
    this._layoutReady = null;
    if (!this._mount) return;
    this._loadLayoutMap();
    this._build();
  }

  /**
   * The active keyboard layout's map of physical key → character, read once
   * when the section builds (FT-012). Optional: without the Keyboard API, or
   * if it refuses, a capture falls back to the event's `key`.
   */
  _loadLayoutMap() {
    let pending = null;
    try {
      const kb = typeof navigator !== 'undefined' ? navigator.keyboard : null;
      pending = typeof kb?.getLayoutMap === 'function' ? kb.getLayoutMap() : null;
    } catch { pending = null; }
    if (!pending || typeof pending.then !== 'function') return;
    this._layoutReady = pending.then(
      (map) => { this._layoutMap = map || null; },
      () => { this._layoutMap = null; },
    );
  }

  /** The saved bindings, as a fresh object safe to modify. */
  _read() {
    const raw = this._settings?.get?.(SETTING);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  }

  _write(next) {
    // Replaced whole, so a removed action really is gone from config.json.
    this._settings?.set?.(SETTING, next);
    this._refresh();
  }

  _build() {
    this._root = document.createElement('div');
    this._root.className = 'global-hotkeys';
    liveRows.set(this._root, this);
    for (const action of GLOBAL_HOTKEY_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'settings-panel__field global-hotkeys__row';
      row.dataset.action = action;

      const label = document.createElement('span');
      label.className = 'settings-panel__field-label global-hotkeys__label';
      label.textContent = t(LABEL_KEYS[action]);

      const slot = document.createElement('span');

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'settings-panel__field-reset global-hotkeys__clear';
      clear.textContent = '✕';
      const clearText = t('settingsPanel.playback.globalHotkeyClear', { action: label.textContent });
      clear.title = clearText;
      clear.setAttribute('aria-label', clearText);
      clear.addEventListener('click', () => this._clear(action));

      row.append(label, slot, clear);
      this._root.appendChild(row);

      // A saved binding that takes an everyday key (kept and registered),
      // or one the OS refused, is said so here (see the header).
      const warning = document.createElement('div');
      warning.className = 'global-hotkeys__warning';
      warning.id = `global-hotkeys-warning-${action}`;
      warning.hidden = true;
      warning.appendChild(icon(TriangleAlert, { width: 14, height: 14, 'aria-hidden': 'true' }));
      const warningText = document.createElement('span');
      warning.appendChild(warningText);
      this._root.appendChild(warning);

      const capture = new KeyCapture({
        element: slot,
        initial: null,
        onChange: (binding, event) => this._onCaptured(action, binding, event),
        // Three capture boxes on one page: each says which action it binds.
        ariaLabel: label.textContent,
      });
      this._rows[action] = { capture, clear, warning, warningText, box: row.querySelector('.key-capture') };
    }
    this._mount.replaceWith(this._root);
    this._refresh();
  }

  /** Paint every row from the saved bindings. */
  _refresh() {
    const saved = this._read();
    for (const action of GLOBAL_HOTKEY_ACTIONS) {
      const row = this._rows[action];
      if (!row) continue;
      const accel = typeof saved[action] === 'string' && saved[action].trim() ? saved[action] : null;
      const binding = accel ? acceleratorToBinding(accel) : null;
      row.capture.setBinding(binding);
      row.clear.hidden = !accel;
      const message = binding ? this._statusLine(action, accel, binding) : '';
      row.warning.hidden = !message;
      row.warningText.textContent = message;
      if (row.box) {
        if (message) row.box.setAttribute('aria-describedby', row.warning.id);
        else row.box.removeAttribute('aria-describedby');
      }
    }
  }

  /**
   * The warning line for a saved binding, or '' for none. A refusal wins:
   * a binding the OS did not take is taken from no other app, so its risk
   * no longer applies, and "Not active" is what the user must know (CB-19).
   * "Still active" is said only when the OS answered that it registered.
   */
  _statusLine(action, accel, binding) {
    const shown = formatBindingLabel(binding);
    const state = registrationOf(lastRegistration, action, accel);
    if (state === 'taken') return t('settingsPanel.playback.globalHotkeyNotActiveTaken', { key: shown });
    if (state === 'invalid') return t('settingsPanel.playback.globalHotkeyNotActiveInvalid', { key: shown });
    const risk = hotkeyRisk(binding);
    if (!risk) return '';
    const reason = t(HOTKEY_RISK_KEYS[risk], { key: shown });
    return state === 'active' ? t('settingsPanel.playback.globalHotkeyKeptRisky', { reason }) : reason;
  }

  _onCaptured(action, captured, event) {
    // The letter the layout puts on the pressed key, not the US-position
    // letter in `code`: on QWERTZ the key labelled Z is code 'KeyY', and
    // 'Y' would register the key labelled Y (FT-012). Everything below,
    // the risk rule included, then judges the key that is actually taken.
    const letter = letterForCode(captured?.code, this._layoutMap, event?.key);
    const binding = letter ? { ...captured, code: `Key${letter}` } : captured;
    const accel = bindingToAccelerator(binding);
    const shown = formatBindingLabel(binding);
    if (!accel) {
      // No accelerator form: saving it would only fail at registration.
      showToast(t('toast.globalShortcutInvalid', { key: shown }), 'warn', 5000);
      this._refresh();
      return;
    }
    const risk = hotkeyRisk(binding);
    if (risk) {
      // Refused, not saved: the row goes back to what was saved before.
      showToast(t(HOTKEY_RISK_KEYS[risk], { key: shown }), 'warn', 8000);
      this._refresh();
      return;
    }
    const next = this._read();
    // One key, one action. The OS gives a combination to one registration
    // only, so the same key on two rows would leave one of them dead.
    // Binding it here moves it, and the other row visibly empties.
    for (const other of GLOBAL_HOTKEY_ACTIONS) {
      if (other !== action && sameAccelerator(next[other], accel)) delete next[other];
    }
    next[action] = accel;
    this._write(next);
  }

  _clear(action) {
    const next = this._read();
    if (!(action in next)) return;
    delete next[action];
    this._write(next);
  }
}
