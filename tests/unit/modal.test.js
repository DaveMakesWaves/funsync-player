// Unit tests for Modal — imports from real source with mocked icons
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the icons module (depends on lucide which won't resolve in vitest)
vi.mock('../../renderer/js/icons.js', () => ({
  icon: () => document.createElement('span'),
  X: [],
}));

import { Modal } from '../../renderer/components/modal.js';

describe('Modal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Clean up any remaining modals
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  });

  describe('open', () => {
    it('creates overlay and panel in DOM', async () => {
      let closeRef;
      const promise = Modal.open({
        title: 'Test',
        onRender(body, close) {
          closeRef = close;
        },
      });
      expect(document.querySelector('.modal-overlay')).toBeTruthy();
      expect(document.querySelector('.modal-panel')).toBeTruthy();
      closeRef('done');
      const result = await promise;
      expect(result).toBe('done');
    });

    it('shows title', async () => {
      let closeRef;
      const promise = Modal.open({
        title: 'My Title',
        onRender(body, close) {
          closeRef = close;
        },
      });
      expect(document.querySelector('.modal-title').textContent).toBe('My Title');
      closeRef(null);
      await promise;
    });

    it('close button returns null', async () => {
      const promise = Modal.open({ title: 'Test' });
      const closeBtn = document.querySelector('.modal-close-btn');
      closeBtn.click();
      const result = await promise;
      expect(result).toBeNull();
    });

    it('backdrop click returns null', async () => {
      const promise = Modal.open({ title: 'Test' });
      const overlay = document.querySelector('.modal-overlay');
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const result = await promise;
      expect(result).toBeNull();
    });

    it('Escape key returns null', async () => {
      const promise = Modal.open({ title: 'Test' });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const result = await promise;
      expect(result).toBeNull();
    });

    it('removes overlay from DOM after close', async () => {
      const promise = Modal.open({ title: 'Test' });
      document.querySelector('.modal-close-btn').click();
      await promise;
      expect(document.querySelector('.modal-overlay')).toBeNull();
    });
  });

  describe('prompt', () => {
    it('returns input value on OK', async () => {
      const promise = Modal.prompt('Name?', 'placeholder', 'default');
      const input = document.querySelector('.modal-input');
      expect(input.value).toBe('default');
      input.value = 'my answer';
      document.querySelector('.modal-btn--primary').click();
      const result = await promise;
      expect(result).toBe('my answer');
    });

    it('returns null on Cancel', async () => {
      const promise = Modal.prompt('Name?');
      document.querySelector('.modal-btn--secondary').click();
      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null for empty input on OK', async () => {
      const promise = Modal.prompt('Name?');
      const input = document.querySelector('.modal-input');
      input.value = '   ';
      document.querySelector('.modal-btn--primary').click();
      const result = await promise;
      expect(result).toBeNull();
    });

    it('Enter key submits', async () => {
      const promise = Modal.prompt('Name?');
      const input = document.querySelector('.modal-input');
      input.value = 'enter-value';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const result = await promise;
      expect(result).toBe('enter-value');
    });

    it('Escape key cancels', async () => {
      const promise = Modal.prompt('Name?');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('confirm', () => {
    it('returns true on confirm', async () => {
      const promise = Modal.confirm('Delete?', 'Are you sure?');
      expect(document.querySelector('.modal-message').textContent).toBe('Are you sure?');
      document.querySelector('.modal-btn--danger').click();
      const result = await promise;
      expect(result).toBe(true);
    });

    it('returns false on cancel', async () => {
      const promise = Modal.confirm('Delete?', 'Are you sure?');
      document.querySelector('.modal-btn--secondary').click();
      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('selectFromList', () => {
    it('returns selected item id', async () => {
      const items = [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ];
      const promise = Modal.selectFromList('Pick one', items);
      const buttons = document.querySelectorAll('.modal-list-item');
      expect(buttons.length).toBe(2);
      buttons[1].click();
      const result = await promise;
      expect(result).toBe('b');
    });

    it('shows empty message for no items', async () => {
      const promise = Modal.selectFromList('Pick one', []);
      expect(document.querySelector('.modal-message--muted').textContent).toBe('No items available');
      document.querySelector('.modal-btn--secondary').click();
      const result = await promise;
      expect(result).toBeNull();
    });

    it('shows subtitle when provided', async () => {
      const items = [{ id: 'a', label: 'Alpha', subtitle: '(details)' }];
      const promise = Modal.selectFromList('Pick', items);
      expect(document.querySelector('.modal-list-item-subtitle').textContent).toBe('(details)');
      document.querySelector('.modal-list-item').click();
      await promise;
    });
  });

  // Fullscreen mounting (lr_x3, EroScripts #307). The Fullscreen API paints
  // only the fullscreen element's subtree on the top layer, so a
  // body-mounted overlay opens BEHIND the video and can't be clicked.
  describe('fullscreen mounting', () => {
    let app, player, fsEl;

    const setFullscreen = (el) => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: el, configurable: true, writable: true,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
    };

    beforeEach(() => {
      // Mirror the real tree: body > #app > .player-container > video.
      // Fullscreen is requested on the player container, not on #app.
      document.body.innerHTML = '';
      app = document.createElement('div');
      app.id = 'app';
      player = document.createElement('div');
      player.className = 'player-container';
      const video = document.createElement('video');
      player.appendChild(video);
      app.appendChild(player);
      document.body.appendChild(app);
      const toasts = document.createElement('div');
      toasts.id = 'toasts';
      document.body.appendChild(toasts);
      fsEl = player;
      Object.defineProperty(document, 'fullscreenElement', {
        value: null, configurable: true, writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: null, configurable: true, writable: true,
      });
    });

    it('mounts into the fullscreen element while fullscreen', async () => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: fsEl, configurable: true, writable: true,
      });
      const promise = Modal.open({ title: 'Add Variation' });
      const overlay = document.querySelector('.modal-overlay');
      expect(overlay.parentElement).toBe(fsEl);
      document.querySelector('.modal-close-btn').click();
      await promise;
    });

    it('mounts into body when not fullscreen', async () => {
      const promise = Modal.open({ title: 'Add Variation' });
      expect(document.querySelector('.modal-overlay').parentElement).toBe(document.body);
      document.querySelector('.modal-close-btn').click();
      await promise;
    });

    // The trap: inert propagates to descendants and a descendant can't opt
    // back out, so blanket-inerting body's children would inert the overlay
    // itself once it lives inside the fullscreen element.
    it('leaves no ancestor of the overlay inert', async () => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: fsEl, configurable: true, writable: true,
      });
      const promise = Modal.open({ title: 'Add Variation' });
      const overlay = document.querySelector('.modal-overlay');
      for (let node = overlay; node && node !== document.body; node = node.parentElement) {
        expect(node.hasAttribute('inert')).toBe(false);
      }
      document.querySelector('.modal-close-btn').click();
      await promise;
    });

    it('inerts siblings at every level of the ancestor chain', async () => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: fsEl, configurable: true, writable: true,
      });
      const promise = Modal.open({ title: 'Add Variation' });
      // sibling inside the fullscreen element
      expect(fsEl.querySelector('video').hasAttribute('inert')).toBe(true);
      // sibling of #app at body level
      expect(document.getElementById('toasts').hasAttribute('inert')).toBe(true);
      document.querySelector('.modal-close-btn').click();
      await promise;
      expect(fsEl.querySelector('video').hasAttribute('inert')).toBe(false);
      expect(document.getElementById('toasts').hasAttribute('inert')).toBe(false);
    });

    it('re-homes the overlay when fullscreen is exited while open', async () => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: fsEl, configurable: true, writable: true,
      });
      const promise = Modal.open({ title: 'Add Variation' });
      const overlay = document.querySelector('.modal-overlay');
      expect(overlay.parentElement).toBe(fsEl);

      setFullscreen(null);
      expect(overlay.parentElement).toBe(document.body);
      // ...and the inert walk was redone against the new chain: the video
      // is now covered by #app being inert, not by its own attribute.
      expect(document.getElementById('app').hasAttribute('inert')).toBe(true);

      setFullscreen(fsEl);
      expect(overlay.parentElement).toBe(fsEl);
      expect(document.getElementById('app').hasAttribute('inert')).toBe(false);

      document.querySelector('.modal-close-btn').click();
      await promise;
      expect(document.getElementById('app').hasAttribute('inert')).toBe(false);
    });

    it('stops re-homing after close', async () => {
      const promise = Modal.open({ title: 'Add Variation' });
      const overlay = document.querySelector('.modal-overlay');
      document.querySelector('.modal-close-btn').click();
      await promise;
      setFullscreen(fsEl);
      expect(overlay.parentElement).toBeNull();
      expect(fsEl.querySelector('video').hasAttribute('inert')).toBe(false);
    });
  });

  // The video options dialog (notes/features/DESIGN-video-options.md (f)):
  // two optional Modal.open options. initialFocus starts the dialog on its
  // active rail item instead of Play, its first button; onEscape lets it
  // close a chip menu or the tag suggestions first, since Modal takes Escape
  // in a document capture listener before any control in the dialog sees it.
  // Without either option a dialog behaves exactly as before.
  describe('initialFocus and onEscape (video options dialog)', () => {
    let opener, warn;
    // A real frame: Modal's own first-focus frame was asked for first, so it
    // has run by the time this one does.
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const track = (promise) => {
      const state = { settled: false, value: undefined };
      promise.then((v) => { state.settled = true; state.value = v; });
      return state;
    };
    const escape = (target) => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e;
    };
    // The dialog's shape: Play first, then a rail whose active item is not
    // the first control.
    const BODY = '<button class="vo-play">Play</button>'
      + '<div role="tablist"><button role="tab" class="vo-organise">Organise</button>'
      + '<button role="tab" class="vo-tags" aria-selected="true">Tags</button></div>';
    const openDialog = (extra = {}) => {
      opener.focus();
      const answer = track(Modal.open({ title: 'Video.mp4', body: BODY, ...extra }));
      const overlay = document.querySelector('.modal-overlay');
      return {
        answer,
        overlay,
        play: overlay.querySelector('.vo-play'),
        tags: overlay.querySelector('.vo-tags'),
        closeBtn: overlay.querySelector('.modal-close-btn'),
      };
    };

    beforeEach(() => {
      document.body.innerHTML = '<button id="opener">⋮</button><button id="outside">Behind</button>';
      opener = document.getElementById('opener');
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it('without either option the first input or button has the focus after the frame, else the X (as before)', async () => {
      const d = openDialog();
      await nextFrame();
      expect(document.activeElement).toBe(d.play);
      d.closeBtn.click();
      await flush();
      expect(d.answer).toEqual({ settled: true, value: null });

      opener.focus();
      const empty = track(Modal.open({ title: 'Nothing to press', body: '<p>Text only</p>' }));
      await nextFrame();
      expect(document.activeElement).toBe(document.querySelector('.modal-close-btn'));
      escape(document.activeElement);
      await flush();
      expect(empty).toEqual({ settled: true, value: null });
      expect(document.activeElement).toBe(opener);
    });

    it('initialFocus given: the control it returns has the focus after the frame, not the first button', async () => {
      const initialFocus = vi.fn((body) => body.querySelector('[aria-selected="true"]'));
      const d = openDialog({ initialFocus });
      await nextFrame();
      expect(document.activeElement).toBe(d.tags);
      expect(initialFocus).toHaveBeenCalledTimes(1);
      expect(initialFocus.mock.calls[0][0]).toBe(d.overlay.querySelector('.modal-body'));
      d.closeBtn.click();
      await flush();
      expect(document.activeElement).toBe(opener);
    });

    it('initialFocus returns null: the first input or button has the focus, as without it', async () => {
      const d = openDialog({ initialFocus: () => null });
      await nextFrame();
      expect(document.activeElement).toBe(d.play);
      d.closeBtn.click();
      await flush();
    });

    it('initialFocus that throws, names a control outside the dialog or one that refuses the focus: the usual rule', async () => {
      const outside = document.getElementById('outside');
      const cases = [
        () => { throw new Error('no rail yet'); },
        () => outside,
        (body) => { const b = body.querySelector('.vo-tags'); b.disabled = true; return b; },
        () => ({ focus() {} }),
      ];
      for (const initialFocus of cases) {
        const d = openDialog({ initialFocus });
        await nextFrame();
        expect(document.activeElement).toBe(d.play);
        expect(document.activeElement).not.toBe(outside);
        d.closeBtn.click();
        await flush();
        expect(d.answer.settled).toBe(true);
      }
    });

    it('initialFocus is not asked once the dialog closed before its first frame, and the focus stays on the opener', async () => {
      const initialFocus = vi.fn((body) => body.querySelector('.vo-tags'));
      const d = openDialog({ initialFocus });
      d.closeBtn.click();
      await nextFrame();
      expect(d.answer).toEqual({ settled: true, value: null });
      expect(initialFocus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opener);
    });

    it('onEscape returns true: the dialog stays, its promise unanswered, and the press reaches nothing else', async () => {
      let handled = true;
      const onEscape = vi.fn(() => handled);
      const d = openDialog({ onEscape });
      await nextFrame();
      const inner = vi.fn();
      d.play.addEventListener('keydown', inner);
      const later = vi.fn();
      document.addEventListener('keydown', later, true);
      try {
        escape(d.play);
        await flush();
        expect(onEscape).toHaveBeenCalledTimes(1);
        expect(onEscape.mock.calls[0][0].key).toBe('Escape');
        expect(d.overlay.isConnected).toBe(true);
        expect(d.answer.settled).toBe(false);
        expect(document.activeElement).toBe(d.play);
        expect(inner).not.toHaveBeenCalled();
        expect(later).not.toHaveBeenCalled();

        // Nothing left to close inside: the next Escape closes the dialog.
        handled = false;
        escape(d.play);
        await flush();
        expect(onEscape).toHaveBeenCalledTimes(2);
        expect(d.answer).toEqual({ settled: true, value: null });
        expect(d.overlay.isConnected).toBe(false);
        expect(document.activeElement).toBe(opener);
      } finally {
        document.removeEventListener('keydown', later, true);
      }
    });

    it('onEscape returns false, anything but exactly true, or throws: Escape closes the dialog as always', async () => {
      const cases = [
        () => false,
        () => undefined,
        () => 'yes',
        async () => true, // a Promise is not "handled"
        () => { throw new Error('menu gone'); },
      ];
      for (const onEscape of cases) {
        const d = openDialog({ onEscape });
        await nextFrame();
        escape(d.play);
        await flush();
        expect(d.answer).toEqual({ settled: true, value: null });
        expect(d.overlay.isConnected).toBe(false);
        expect(document.activeElement).toBe(opener);
      }
    });

    it('onEscape is asked about Escape only: Tab, Enter, the X and the backdrop never ask it', async () => {
      const onEscape = vi.fn(() => true);
      const d = openDialog({ onEscape });
      await nextFrame();
      for (const k of ['Tab', 'Enter', 'Esc']) {
        d.play.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      }
      d.closeBtn.click();
      await flush();
      expect(d.answer).toEqual({ settled: true, value: null });

      const d2 = openDialog({ onEscape });
      d2.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      expect(d2.answer).toEqual({ settled: true, value: null });
      expect(onEscape).not.toHaveBeenCalled();
    });
  });
});
