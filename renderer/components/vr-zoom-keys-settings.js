// VRZoomKeysSettings — Settings > Keyboard > VR zoom keys: the keys that zoom
// a VR video with no Ctrl (Buck Nakkidd, Discord #feature-requests,
// 2026-11-27; Dave: "make a setting where users can choose a non coliding
// hotkey for these").
//
// Two rows, Zoom in and Zoom out, each a KeyCapture plus "back to the default
// key" and "no key". A key the player already uses, a key for moving around
// or the system, a Ctrl shortcut or the other zoom key is refused with a toast
// saying why (vr-zoom-keys.js vrZoomKeyClash) and the row keeps its key.
// Written to `player.vrZoomKeys` straight away; the keyboard handler reads it
// on every key, so no restart.

import { KeyCapture, formatBindingLabel } from './key-capture.js';
import { t } from '../js/i18n.js';
import { showToast } from '../js/toast.js';
import {
  VR_ZOOM_ACTIONS, VR_ZOOM_KEY_DEFAULTS, VR_ZOOM_KEYS_SETTING,
  readVRZoomKeys, vrZoomKeyClash, sameVRZoomKey,
} from '../js/vr-zoom-keys.js';

const LABEL_KEYS = {
  in: 'settingsPanel.vrZoomKeys.in',
  out: 'settingsPanel.vrZoomKeys.out',
};

export class VRZoomKeysSettings {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element — mount point, replaced by the rows
   * @param {{get: Function, set: Function}} opts.settings — DataService
   */
  constructor({ element, settings }) {
    this._mount = element;
    this._settings = settings;
    this._rows = {};
    if (!this._mount) return;
    this._build();
  }

  _keys() {
    return readVRZoomKeys(this._settings?.get?.(VR_ZOOM_KEYS_SETTING));
  }

  _save(action, binding) {
    const next = { ...this._keys(), [action]: binding };
    this._settings?.set?.(VR_ZOOM_KEYS_SETTING, next);
    this._refresh();
  }

  _build() {
    this._root = document.createElement('div');
    this._root.className = 'vr-zoom-keys';
    for (const action of VR_ZOOM_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'settings-panel__field vr-zoom-keys__row';
      row.dataset.action = action;

      const label = document.createElement('span');
      label.className = 'settings-panel__field-label';
      label.textContent = t(LABEL_KEYS[action]);

      const slot = document.createElement('span');

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'settings-panel__field-reset vr-zoom-keys__reset';
      reset.textContent = '↺';
      const resetText = t('settingsPanel.vrZoomKeys.reset', {
        action: label.textContent, key: formatBindingLabel(VR_ZOOM_KEY_DEFAULTS[action]),
      });
      reset.title = resetText;
      reset.setAttribute('aria-label', resetText);
      reset.addEventListener('click', () => this._onCaptured(action, VR_ZOOM_KEY_DEFAULTS[action]));

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'settings-panel__field-reset vr-zoom-keys__clear';
      clear.textContent = '✕';
      const clearText = t('settingsPanel.vrZoomKeys.clear', { action: label.textContent });
      clear.title = clearText;
      clear.setAttribute('aria-label', clearText);
      clear.addEventListener('click', () => this._save(action, null));

      row.append(label, slot, reset, clear);
      this._root.appendChild(row);

      const capture = new KeyCapture({
        element: slot,
        initial: null,
        onChange: (binding) => this._onCaptured(action, binding),
        ariaLabel: label.textContent,
      });
      this._rows[action] = { capture, reset, clear };
    }
    this._mount.replaceWith(this._root);
    this._refresh();
  }

  /** A key pressed in a row (or its default chosen): saved, or refused with why. */
  _onCaptured(action, binding) {
    if (!binding) return;
    const keys = this._keys();
    const other = keys[action === 'in' ? 'out' : 'in'];
    const clash = vrZoomKeyClash(binding, { other });
    if (clash) {
      showToast(t(`settingsPanel.vrZoomKeys.clash.${clash}`, { key: formatBindingLabel(binding) }), 'error', 5000);
      this._refresh();
      return;
    }
    this._save(action, { code: binding.code, mods: { shift: !!binding.mods?.shift, ctrl: false, alt: !!binding.mods?.alt } });
  }

  /** Paint every row from the saved keys. */
  _refresh() {
    const keys = this._keys();
    for (const action of VR_ZOOM_ACTIONS) {
      const row = this._rows[action];
      if (!row) continue;
      row.capture.setBinding(keys[action]);
      row.reset.hidden = !!keys[action] && sameVRZoomKey(keys[action], VR_ZOOM_KEY_DEFAULTS[action]);
      row.clear.hidden = !keys[action];
    }
  }
}
