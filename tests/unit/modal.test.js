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
});
