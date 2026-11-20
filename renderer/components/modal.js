// Modal — Promise-based reusable modal dialogs

import { icon, X } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';

// The dialogs open right now, bottom first (FT-048). Each open dialog has its
// own document-level keydown, mousedown and focusin listeners, and the lower
// dialog's run first. Without a stack, one Escape closed every stacked dialog
// (stopPropagation does not stop other listeners on the same node), and Tab
// in the top dialog was dead: the lower dialog saw focus outside its own
// panel, cancelled the Tab and pulled focus back to a control under the
// backdrop. Real stacks: Settings + Rename / Remove source, the Restore list
// + its confirm, Devices + the Safety Cap confirm. Also in v0.9.2.
const openStack = [];

/**
 * The dialog on top, or null. A dialog whose overlay left the page without
 * close() (a test teardown, a view rebuilt under it) is no longer on screen,
 * so it is dropped here and never takes a key again.
 */
function topDialog() {
  for (let i = openStack.length - 1; i >= 0; i--) {
    if (!openStack[i].overlay.isConnected) openStack.splice(i, 1);
  }
  return openStack[openStack.length - 1] || null;
}

// Is a dialog's backdrop on screen? Said once when the first dialog opens and
// once when the last one closes, as 'modal:backdrop' {dimmed}, so app.js can
// dim the Windows caption buttons with the page: the OS draws them above the
// page, out of the backdrop's reach (FT-100, also in v0.9.2).
let backdropShown = false;
function setBackdrop(shown) {
  if (shown === backdropShown) return;
  backdropShown = shown;
  try { eventBus.emit('modal:backdrop', { dimmed: shown }); } catch { /* cosmetic only */ }
}

/** True when `overlay` belongs to a dialog stacked above `entry`. */
function isAbove(overlay, entry) {
  const at = openStack.indexOf(entry);
  if (at === -1) return false;
  return openStack.some((other, i) => i > at && other.overlay === overlay);
}

export class Modal {
  /**
   * Open a custom modal dialog.
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} [opts.body] — HTML string for the modal body
   * @param {Function} [opts.onRender] — called with (bodyEl, resolve, reject) for custom wiring
   * @param {string} [opts.panelClass] — extra class(es) on `.modal-panel`
   * @param {(body: HTMLElement) => (Element|null)} [opts.initialFocus] — the
   *   control to start on, asked after the first frame (the video options
   *   dialog: its active rail item, not Play). A control inside this dialog
   *   that takes the focus gets it; null, anything outside the dialog, a
   *   throw or a control that refuses the focus leaves the usual rule (the
   *   first input or button, else the X)
   * @param {(event: KeyboardEvent) => boolean} [opts.onEscape] — asked when
   *   Escape reaches this dialog on top of the stack, before it closes.
   *   Exactly `true` means "handled, stay open" (the dialog closed a menu of
   *   its own); anything else, or a throw, closes the dialog as usual. A
   *   dialog under another one is never asked
   * @returns {Promise<*>} resolves with a value when closed, or null on cancel
   */
  static open(opts) {
    return new Promise((resolve) => {
      // Capture the focused element BEFORE we add the modal to the DOM —
      // we'll restore focus to it on close (Shneiderman #7 user control —
      // predictable; user came from there).
      const previouslyFocused = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      // role="dialog" + aria-modal="true" so screen readers announce
      // the modal context. aria-labelledby links to the title element
      // (Nielsen #4 standards; a11y).
      const panel = document.createElement('div');
      panel.className = 'modal-panel';
      // A dialog with its own layout (Settings: FT-039) styles the panel
      // through one extra class instead of overriding every dialog.
      if (typeof opts.panelClass === 'string' && opts.panelClass.trim()) {
        panel.classList.add(...opts.panelClass.trim().split(/\s+/));
      }
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
      panel.setAttribute('aria-labelledby', titleId);

      // Header
      const header = document.createElement('div');
      header.className = 'modal-header';
      const titleEl = document.createElement('h2');
      titleEl.className = 'modal-title';
      titleEl.id = titleId;
      titleEl.textContent = opts.title || '';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'modal-close-btn';
      closeBtn.setAttribute('aria-label', t('modal.closeAria', { title: opts.title || t('modal.dialogFallback') }));
      closeBtn.appendChild(icon(X, { width: 18, height: 18 }));
      closeBtn.title = t('common.close');
      header.appendChild(titleEl);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'modal-body';
      if (opts.body) body.innerHTML = opts.body;
      panel.appendChild(body);

      overlay.appendChild(panel);

      // Mount point. The Fullscreen API paints ONLY the fullscreen element
      // and its descendants on the top layer, so an overlay attached to
      // <body> is invisible AND unclickable while the player is
      // fullscreened — the dialog opens behind the video and the page
      // underneath is inert, which reads as a frozen player (lr_x3,
      // EroScripts #307: Add Variation. The `?` shortcut list, the VR
      // format panel and the orgasm config had the same fault).
      // connection-panel and queue-panel each solve this locally; doing it
      // here covers every Modal.* call site at once.
      const mountTarget = () => document.fullscreenElement || document.body;

      // `inert` on the rest of the page so AT/keyboard can't reach it
      // while the modal is open. Modern Electron supports `inert`
      // natively. This can NOT be a flat pass over document.body.children:
      // once the overlay lives inside the fullscreen element, inerting
      // that element's body-level ancestor would inert the overlay too —
      // inert propagates to descendants and a descendant can't opt back
      // out, so the modal would be visible but dead. Walk from the overlay
      // up to <body> instead, inerting siblings at each level and leaving
      // the ancestor chain itself alone. Stash only what we actually set,
      // so a host page that intentionally inerted something keeps it.
      //
      // Toasts are left live (V70). They paint above every backdrop
      // (z-index 2000 against 1000), but the browser skips an inert element
      // when it works out what the pointer is over, so a press on a toast's
      // X landed on the backdrop underneath and closed the dialog, and
      // hovering a toast did not pause it. They still never take focus from
      // the dialog: see onToastMouseDown and onToastFocusIn below.
      //
      // What this dialog set carries its own value, INERT_MARK, and close
      // takes off only an inert that still has it (R3-22). A sibling the page
      // inerts itself while the dialog is open is the page's from then on:
      // in fullscreen the dialog mounts beside the docked editor, and an
      // editor hidden meanwhile (a video load after Save) writes its own
      // inert="", which close used to remove, so Tab reached the closed
      // editor's controls again.
      const INERT_EXEMPT = '#toast-container';
      const INERT_MARK = 'modal';
      const inertedSiblings = [];
      // This dialog's place in the open stack (FT-048).
      const entry = { overlay };
      const applyInert = () => {
        for (let node = overlay; node && node !== document.body; node = node.parentElement) {
          const parent = node.parentElement;
          if (!parent) break;
          for (const sib of [...parent.children]) {
            if (sib === node || sib.hasAttribute('inert') || sib.matches(INERT_EXEMPT)) continue;
            // Never a dialog stacked on top of this one: a fullscreen change
            // re-homes the lower dialog first, and inerting the top one then
            // left it on screen but dead (FT-048).
            if (isAbove(sib, entry)) continue;
            sib.setAttribute('inert', INERT_MARK);
            inertedSiblings.push(sib);
          }
        }
      };
      const clearInert = () => {
        for (const sib of inertedSiblings) {
          if (sib.getAttribute('inert') === INERT_MARK) sib.removeAttribute('inert');
        }
        inertedSiblings.length = 0;
      };

      mountTarget().appendChild(overlay);
      openStack.push(entry);
      setBackdrop(true);
      applyInert();
      const isTop = () => topDialog() === entry;

      // Entering or leaving fullscreen with a modal open moves the top
      // layer out from under it. Re-home the overlay and redo the inert
      // walk against the new ancestor chain. Moving a node in the DOM
      // blurs any focused descendant, so restore focus afterwards.
      const onFullscreenChange = () => {
        const target = mountTarget();
        if (overlay.parentElement === target) return;
        const focused = panel.contains(document.activeElement) ? document.activeElement : null;
        clearInert();
        target.appendChild(overlay);
        applyInert();
        if (focused) {
          try { focused.focus({ preventScroll: true }); }
          catch { /* ignore — element may be unfocusable now */ }
        }
      };
      document.addEventListener('fullscreenchange', onFullscreenChange);

      const close = (value = null) => {
        const at = openStack.indexOf(entry);
        if (at !== -1) openStack.splice(at, 1);
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('mousedown', onToastMouseDown, true);
        document.removeEventListener('focusin', onToastFocusIn, true);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        // Restore inert state of siblings before removal so focus can
        // legitimately land on the previously-focused element.
        clearInert();
        overlay.remove();
        // The last dialog on the page closed: the backdrop is gone (FT-100).
        // topDialog() also drops any dialog that left the page without close().
        setBackdrop(topDialog() !== null);
        if (previouslyFocused && document.contains(previouslyFocused)) {
          try { previouslyFocused.focus({ preventScroll: true }); }
          catch { /* ignore — element may be unfocusable now */ }
        }
        resolve(value);
      };

      closeBtn.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      // Focus trap on Tab key. Cycle focus inside the panel; Shift+Tab
      // wraps to the last focusable element. Without this a Tab from
      // the last button would land on browser chrome / page content,
      // confusing keyboard users (Nielsen #3 user control + a11y).
      const FOCUSABLE_SELECTOR = (
        'a[href], button:not([disabled]), textarea:not([disabled]), ' +
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
        '[tabindex]:not([tabindex="-1"])'
      );
      // opts.onEscape: the dialog may use an Escape itself first (a chip menu
      // or a suggestion list inside it closes; the dialog stays). This
      // listener runs in the capture phase on document, so a control inside
      // the panel never sees the Escape before the dialog closes: hence the
      // hook. Only exactly `true` keeps the dialog open, so a slip (a
      // Promise from an async handler, a throw) can never make a dialog
      // that Escape does not close.
      const onEscape = typeof opts.onEscape === 'function' ? opts.onEscape : null;
      const escapeHandled = (e) => {
        try { return onEscape(e) === true; }
        catch (err) {
          console.warn('[Modal] onEscape threw; closing the dialog', err);
          return false;
        }
      };
      const onKeydown = (e) => {
        // Only the dialog on top answers a key (FT-048). A lower one stays
        // open, its promise pending, until the dialog above it closes.
        if (!isTop()) return;
        if (e.key === 'Escape') {
          // Immediate: no other document listener (another dialog, a panel
          // under the dialogs) acts on the same press.
          e.stopImmediatePropagation();
          e.stopPropagation();
          if (onEscape && escapeHandled(e)) return;
          close(null);
          return;
        }
        if (e.key !== 'Tab') return;
        // A control under a [hidden] ancestor (or hidden itself) cannot take
        // the focus in Chromium: as "first" or "last" it made the wrap a dead
        // key. The video options dialog's hidden Undo button and the buttons
        // of its hidden sections came last (review-a RA-3).
        const items = [...panel.querySelectorAll(FOCUSABLE_SELECTOR)].filter((n) => !n.closest('[hidden]'));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (!panel.contains(active)) {
          // Defensive — focus drifted outside (e.g. devtools). Bring it
          // back so Tab continues to cycle within the modal.
          e.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', onKeydown, true);

      // A press on a toast keeps focus where it is in the dialog; the click
      // itself still lands, so the X closes the toast. Without this the
      // browser focuses the pressed X, and once the toast has gone focus is
      // on <body>, outside the dialog, where Space plays the video behind it.
      const inToast = (el) => !!(el && typeof el.closest === 'function' && el.closest(INERT_EXEMPT));
      const onToastMouseDown = (e) => {
        if (!isTop()) return; // the top dialog guards the toasts (FT-048)
        if (inToast(e.target)) e.preventDefault();
      };
      // Focus that reaches a toast anyway goes back into the dialog. The
      // toast container sits before the overlay in the document, so a Tab
      // past a control the trap above does not list wraps round to it.
      const onToastFocusIn = (e) => {
        // The top dialog takes the focus back, never one under it (FT-048).
        if (!isTop() || !inToast(e.target)) return;
        // Stop this focusin here (FT-037). Moving focus below fires the
        // toast's focusout at once, while its timer is still running, so
        // that resume does nothing; then this event went on to the toast,
        // whose focusin paused the timer, and nothing ever resumed it.
        e.stopPropagation();
        const first = panel.querySelector(FOCUSABLE_SELECTOR) || closeBtn;
        first.focus({ preventScroll: true });
      };
      document.addEventListener('mousedown', onToastMouseDown, true);
      document.addEventListener('focusin', onToastFocusIn, true);

      // Allow custom wiring
      if (opts.onRender) {
        opts.onRender(body, close);
      }

      // Focus first input or close button. preventScroll: a dialog opens at
      // its top. When the first focusable sits below the fold, a plain
      // focus() scrolls the (overflow: auto) body down to it — the `?`
      // shortcut list's only button is "Got it" at the very end, so the
      // list opened scrolled past Navigation and Playback (V46).
      // opts.initialFocus goes first: only a control inside this dialog that
      // really takes the focus counts, anything else leaves the rule below.
      // Not asked once the dialog has closed.
      const focusInitial = () => {
        if (typeof opts.initialFocus !== 'function' || !overlay.isConnected) return false;
        let el;
        try { el = opts.initialFocus(body); }
        catch (err) {
          console.warn('[Modal] initialFocus threw; focusing the first control', err);
          return false;
        }
        if (!el || el.nodeType !== 1 || typeof el.focus !== 'function' || !panel.contains(el)) return false;
        try { el.focus({ preventScroll: true }); }
        catch { return false; }
        return document.activeElement === el;
      };
      requestAnimationFrame(() => {
        if (focusInitial()) return;
        const firstInput = body.querySelector('input, button');
        if (firstInput) firstInput.focus({ preventScroll: true });
        else closeBtn.focus({ preventScroll: true });
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
        cancelBtn.textContent = t('common.cancel');
        cancelBtn.addEventListener('click', () => close(null));

        const okBtn = document.createElement('button');
        okBtn.className = 'modal-btn modal-btn--primary';
        okBtn.textContent = t('common.ok');
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
   * @param {{confirmText?: string}} [opts] the action label. Pass the verb
   *   the dialog asks about: `t('common.delete')` for a deletion, "Restore",
   *   "Remove", "Move to Recycle Bin" and so on otherwise. The fallback is a
   *   neutral "Confirm". It used to be "Delete", and every caller that was
   *   not a deletion and forgot the option showed Delete: the Safety Cap
   *   warning, Restore From Backup, removing a source (which deletes no
   *   files), even the "All Assigned" notice (V74, EroScripts #359).
   * @returns {Promise<boolean>}
   */
  static confirm(title, message, opts = {}) {
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
        cancelBtn.textContent = t('common.cancel');
        cancelBtn.addEventListener('click', () => close(false));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn modal-btn--danger';
        confirmBtn.textContent = opts.confirmText || t('common.confirm');
        confirmBtn.addEventListener('click', () => close(true));

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        body.appendChild(actions);
      },
    });
  }

  /**
   * An information notice: one OK button in the primary style, no Cancel and
   * nothing red, for a message that asks nothing. "All Assigned" was a
   * Modal.confirm, so it showed Cancel next to a red, danger-style OK for
   * what is only information (block C verifier 1; also in v0.9.2).
   * Resolves true on OK, null on Escape, the X or the backdrop; either way
   * it only closes.
   */
  static alert(title, message, opts = {}) {
    return Modal.open({
      title,
      onRender(body, close) {
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = message;
        body.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const okBtn = document.createElement('button');
        okBtn.className = 'modal-btn modal-btn--primary';
        okBtn.textContent = opts.okText || t('common.ok');
        okBtn.addEventListener('click', () => close(true));
        actions.appendChild(okBtn);
        body.appendChild(actions);
      },
    });
  }

  /**
   * Selectable list dialog. Returns selected item's id, or null on cancel.
   *
   * Optionally supports an inline "+ Create new" affordance: pass
   * `options.onCreateNew` (a function returning the id of the newly-created
   * item, or null if creation was cancelled). When provided, a button is
   * rendered at the top of the list — and in the empty state too, so the
   * surface still has a primary action when there's nothing to pick.
   *
   * @param {string} title
   * @param {Array<{id: string, label: string, subtitle?: string}>} items
   * @param {Object} [options]
   * @param {() => Promise<string|null>|string|null} [options.onCreateNew]
   * @param {string} [options.createLabel='+ Create new']
   * @returns {Promise<string|null>}
   */
  static selectFromList(title, items, options = {}) {
    const { onCreateNew, createLabel = '+ Create new' } = options;
    return Modal.open({
      title,
      onRender(body, close) {
        const renderCreateButton = (placement) => {
          if (!onCreateNew) return;
          const btn = document.createElement('button');
          btn.className = `modal-btn modal-btn--secondary modal-list-create modal-list-create--${placement}`;
          btn.type = 'button';
          btn.textContent = createLabel;
          btn.addEventListener('click', async () => {
            // Disable while running so a double-click doesn't fire twice.
            btn.disabled = true;
            try {
              const newId = await onCreateNew();
              if (newId) {
                close(newId);
              } else {
                btn.disabled = false;
              }
            } catch (err) {
              btn.disabled = false;
              throw err;
            }
          });
          body.appendChild(btn);
        };

        if (items.length === 0) {
          if (onCreateNew) {
            // Empty + creatable: lead with the create button. No bail-out
            // copy; the affordance IS the next action.
            renderCreateButton('empty');
            return;
          }
          const empty = document.createElement('div');
          empty.className = 'modal-message modal-message--muted';
          empty.textContent = t('modal.noItemsAvailable');
          body.appendChild(empty);

          const actions = document.createElement('div');
          actions.className = 'modal-actions';
          const closeBtn = document.createElement('button');
          closeBtn.className = 'modal-btn modal-btn--secondary';
          closeBtn.textContent = t('common.close');
          closeBtn.addEventListener('click', () => close(null));
          actions.appendChild(closeBtn);
          body.appendChild(actions);
          return;
        }

        renderCreateButton('top');

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
