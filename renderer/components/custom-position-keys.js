// CustomPositionKeys — settings-modal view for the editor's custom
// position-key bindings. List of (key, position) rows + add-row form +
// reset button. Subscribes to `editor.customPositionKeys` via dataService;
// every mutation persists immediately.
//
// SCOPE: notes/features/SCOPE-editor-custom-position-keys.md

import { KeyCapture, formatBindingLabel } from './key-capture.js';
import { icon, X, RotateCcw } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { showToast } from '../js/toast.js';
import {
  serializeBinding,
  detectConflict,
  isReservedKey,
} from '../js/position-key-resolver.js';

const SETTING_KEY = 'editor.customPositionKeys';

function _esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export class CustomPositionKeys {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element — mount point (replaced).
   * @param {Object} opts.settings — dataService instance.
   */
  constructor({ element, settings }) {
    this._mount = element;
    this._settings = settings;
    this._draft = { binding: null, position: 50 };
    this._captureComponent = null;
    if (!this._mount) return;
    this._build();
  }

  destroy() {
    this._captureComponent?.destroy();
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }

  // --- Internals ---

  _readBindings() {
    const raw = this._settings?.get?.(SETTING_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  _writeBindings(arr) {
    this._settings?.set?.(SETTING_KEY, arr);
  }

  _build() {
    this._root = document.createElement('div');
    this._root.className = 'custom-position-keys';
    this._mount.replaceWith(this._root);
    this._render();
  }

  _render() {
    if (!this._root) return;
    const bindings = this._readBindings();

    this._root.innerHTML = `
      <section class="custom-position-keys__section">
        <h3 class="custom-position-keys__heading">${_esc(t('editor.customKeysDefaultsHeader'))}</h3>
        <p class="custom-position-keys__defaults-body">${_esc(t('editor.customKeysDefaultsBody'))}</p>
      </section>

      <section class="custom-position-keys__section">
        <h3 class="custom-position-keys__heading">${_esc(t('editor.customKeysCustomHeader'))}</h3>
        <ul class="custom-position-keys__list" role="list" data-list>
          ${bindings.length === 0
            ? `<li class="custom-position-keys__empty">${_esc(t('editor.customKeysEmpty'))}</li>`
            : bindings.map((b, idx) => this._rowHtml(b, idx)).join('')}
        </ul>

        <div class="custom-position-keys__add-row" data-add-row>
          <div class="custom-position-keys__cell custom-position-keys__cell--key" data-capture-slot></div>
          <label class="custom-position-keys__cell custom-position-keys__cell--position">
            <span class="custom-position-keys__cell-label">${_esc(t('editor.customKeysPositionLabel'))}</span>
            <input type="number" min="0" max="100" step="1" value="${this._draft.position}"
                   class="custom-position-keys__pos-input" data-pos-input />
          </label>
          <button type="button" class="custom-position-keys__save-btn" data-save-btn disabled>
            ${_esc(t('editor.customKeysSaveBtn'))}
          </button>
        </div>
        <div class="custom-position-keys__warning" data-warning hidden></div>

        <div class="custom-position-keys__actions">
          <button type="button" class="custom-position-keys__reset-btn" data-reset-btn>
            <span data-reset-icon></span>
            ${_esc(t('editor.customKeysResetBtn'))}
          </button>
        </div>

        <p class="custom-position-keys__hint">${_esc(t('editor.customKeysMidiHint'))}</p>
      </section>
    `;

    this._wire();
  }

  _rowHtml(binding, idx) {
    const label = formatBindingLabel(binding);
    const conflict = detectConflict(binding, []);
    const overrideWarn = conflict.kind === 'override-default'
      ? `<span class="custom-position-keys__row-warn">${_esc(
          t('editor.customKeysOverrideWarn', {
            defaultPos: conflict.defaultPosition,
            newPos: binding.position,
          }))}</span>`
      : '';
    return `
      <li class="custom-position-keys__row" data-row-idx="${idx}">
        <span class="custom-position-keys__cell custom-position-keys__cell--key">${_esc(label)}</span>
        <span class="custom-position-keys__cell custom-position-keys__cell--position">${_esc(String(binding.position))}</span>
        ${overrideWarn}
        <button type="button" class="custom-position-keys__remove-btn" data-remove-idx="${idx}"
                aria-label="${_esc(t('queuePanel.removeAria') || 'Remove')}"
                title="${_esc(t('queuePanel.removeAria') || 'Remove')}">
          <span data-remove-icon></span>
        </button>
      </li>
    `;
  }

  _wire() {
    // Mount remove-icon glyphs in each row
    for (const slot of this._root.querySelectorAll('[data-remove-icon]')) {
      slot.appendChild(icon(X, { width: 14, height: 14 }));
    }

    // Remove handlers
    for (const btn of this._root.querySelectorAll('[data-remove-idx]')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const idx = parseInt(btn.dataset.removeIdx, 10);
        this._removeBinding(idx);
      });
    }

    // Reset button
    const resetIcon = this._root.querySelector('[data-reset-icon]');
    if (resetIcon) resetIcon.appendChild(icon(RotateCcw, { width: 14, height: 14 }));
    const resetBtn = this._root.querySelector('[data-reset-btn]');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this._resetAll());
    }

    // Add-row: key capture
    const captureSlot = this._root.querySelector('[data-capture-slot]');
    if (captureSlot) {
      this._captureComponent = new KeyCapture({
        element: captureSlot,
        initial: this._draft.binding,
        onChange: (binding) => {
          this._draft.binding = binding;
          this._refreshAddRowValidity();
        },
      });
    }

    // Add-row: position input
    const posInput = this._root.querySelector('[data-pos-input]');
    if (posInput) {
      posInput.addEventListener('input', () => {
        const v = parseInt(posInput.value, 10);
        this._draft.position = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50;
        this._refreshAddRowValidity();
      });
    }

    // Add-row: save
    const saveBtn = this._root.querySelector('[data-save-btn]');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this._saveDraft());
    }

    this._refreshAddRowValidity();
  }

  _refreshAddRowValidity() {
    const saveBtn = this._root?.querySelector('[data-save-btn]');
    const warnEl = this._root?.querySelector('[data-warning]');
    if (!saveBtn || !warnEl) return;
    const { binding, position } = this._draft;
    let valid = true;
    let warning = '';

    if (!binding) {
      valid = false;
    } else {
      const reserved = isReservedKey(binding.code, binding.mods || {});
      if (reserved.reserved) {
        valid = false;
        warning = t('editor.customKeysReservedWarn', { key: formatBindingLabel(binding) });
      } else {
        const conflict = detectConflict(binding, this._readBindings());
        if (conflict.kind === 'duplicate') {
          // Allowed — last-wins (UI calls it "replace"). No warning.
        } else if (conflict.kind === 'override-default') {
          warning = t('editor.customKeysOverrideWarn', {
            defaultPos: conflict.defaultPosition,
            newPos: position,
          });
        }
      }
    }

    saveBtn.disabled = !valid;
    saveBtn.classList.toggle('custom-position-keys__save-btn--disabled', !valid);
    if (warning) {
      warnEl.textContent = warning;
      warnEl.hidden = false;
    } else {
      warnEl.textContent = '';
      warnEl.hidden = true;
    }
  }

  _saveDraft() {
    const { binding, position } = this._draft;
    if (!binding) return;
    const reserved = isReservedKey(binding.code, binding.mods || {});
    if (reserved.reserved) {
      showToast(t('editor.customKeysReservedWarn', { key: formatBindingLabel(binding) }), 'error', 2500);
      return;
    }
    const current = this._readBindings();
    const key = serializeBinding(binding);
    // Last-wins on duplicate within custom list
    const next = current.filter((b) => serializeBinding(b) !== key);
    next.push({ code: binding.code, mods: binding.mods || {}, position });
    this._writeBindings(next);
    // Reset draft for the next entry
    this._draft = { binding: null, position: 50 };
    this._render();
  }

  _removeBinding(idx) {
    const current = this._readBindings();
    if (idx < 0 || idx >= current.length) return;
    const next = [...current.slice(0, idx), ...current.slice(idx + 1)];
    this._writeBindings(next);
    this._render();
  }

  _resetAll() {
    const current = this._readBindings();
    if (current.length === 0) return;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const ok = window.confirm(t('editor.customKeysResetConfirm'));
      if (!ok) return;
    }
    this._writeBindings([]);
    this._render();
  }
}
