// Modal — Promise-based reusable modal dialogs

import { icon, X } from '../js/icons.js';

export class Modal {
  /**
   * Open a custom modal dialog.
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} [opts.body] — HTML string for the modal body
   * @param {Function} [opts.onRender] — called with (bodyEl, resolve, reject) for custom wiring
   * @returns {Promise<*>} resolves with a value when closed, or null on cancel
   */
  static open(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      const panel = document.createElement('div');
      panel.className = 'modal-panel';

      // Header
      const header = document.createElement('div');
      header.className = 'modal-header';
      const titleEl = document.createElement('div');
      titleEl.className = 'modal-title';
      titleEl.textContent = opts.title || '';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'modal-close-btn';
      closeBtn.appendChild(icon(X, { width: 18, height: 18 }));
      closeBtn.title = 'Close';
      header.appendChild(titleEl);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'modal-body';
      if (opts.body) body.innerHTML = opts.body;
      panel.appendChild(body);

      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const close = (value = null) => {
        overlay.remove();
        resolve(value);
      };

      closeBtn.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      const onKeydown = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          document.removeEventListener('keydown', onKeydown, true);
          close(null);
        }
      };
      document.addEventListener('keydown', onKeydown, true);

      // Allow custom wiring
      if (opts.onRender) {
        opts.onRender(body, close);
      }

      // Focus first input or close button
      requestAnimationFrame(() => {
        const firstInput = body.querySelector('input, button');
        if (firstInput) firstInput.focus();
        else closeBtn.focus();
      });
    });
  }

  /**
   * Text input prompt dialog.
   * @param {string} title
   * @param {string} [placeholder]
   * @param {string} [defaultValue]
   * @returns {Promise<string|null>}
   */
  static prompt(title, placeholder = '', defaultValue = '') {
    return Modal.open({
      title,
      onRender(body, close) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
        input.placeholder = placeholder;
        input.value = defaultValue;
        body.appendChild(input);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn--secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => close(null));

        const okBtn = document.createElement('button');
        okBtn.className = 'modal-btn modal-btn--primary';
        okBtn.textContent = 'OK';
        okBtn.addEventListener('click', () => {
          const val = input.value.trim();
          close(val || null);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        body.appendChild(actions);

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            okBtn.click();
          }
        });
      },
    });
  }

  /**
   * Confirmation dialog.
   * @param {string} title
   * @param {string} message
   * @returns {Promise<boolean>}
   */
  static confirm(title, message) {
    return Modal.open({
      title,
      onRender(body, close) {
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = message;
        body.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn--secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => close(false));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn modal-btn--danger';
        confirmBtn.textContent = 'Delete';
        confirmBtn.addEventListener('click', () => close(true));

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        body.appendChild(actions);
      },
    });
  }

  /**
   * Selectable list dialog. Returns selected item's id, or null on cancel.
   * @param {string} title
   * @param {Array<{id: string, label: string, subtitle?: string}>} items
   * @returns {Promise<string|null>}
   */
  static selectFromList(title, items) {
    return Modal.open({
      title,
      onRender(body, close) {
        if (items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'modal-message modal-message--muted';
          empty.textContent = 'No items available';
          body.appendChild(empty);

          const actions = document.createElement('div');
          actions.className = 'modal-actions';
          const closeBtn = document.createElement('button');
          closeBtn.className = 'modal-btn modal-btn--secondary';
          closeBtn.textContent = 'Close';
          closeBtn.addEventListener('click', () => close(null));
          actions.appendChild(closeBtn);
          body.appendChild(actions);
          return;
        }

        const list = document.createElement('div');
        list.className = 'modal-list';

        for (const item of items) {
          const row = document.createElement('button');
          row.className = 'modal-list-item';
          row.dataset.id = item.id;

          const label = document.createElement('span');
          label.className = 'modal-list-item-label';
          label.textContent = item.label;
          row.appendChild(label);

          if (item.subtitle) {
            const sub = document.createElement('span');
            sub.className = 'modal-list-item-subtitle';
            sub.textContent = item.subtitle;
            row.appendChild(sub);
          }

          row.addEventListener('click', () => close(item.id));
          list.appendChild(row);
        }

        body.appendChild(list);
      },
    });
  }
}
