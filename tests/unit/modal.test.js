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
});
