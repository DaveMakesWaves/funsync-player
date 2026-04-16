// Unit tests for showToast — imports from real source
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showToast } from '../../renderer/js/toast.js';

describe('showToast', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-container"></div>';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a toast element in the container', () => {
    showToast('Hello');
    const container = document.getElementById('toast-container');
    expect(container.children.length).toBe(1);
    expect(container.children[0].textContent).toBe('Hello');
  });

  it('applies type class', () => {
    showToast('Error!', 'error');
    const toast = document.querySelector('.toast');
    expect(toast.classList.contains('toast--error')).toBe(true);
  });

  it('defaults to info type', () => {
    showToast('Info');
    const toast = document.querySelector('.toast');
    expect(toast.classList.contains('toast--info')).toBe(true);
  });

  it('adds toast--out class after 3 seconds', () => {
    showToast('Fading');
    const toast = document.querySelector('.toast');
    expect(toast.classList.contains('toast--out')).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(toast.classList.contains('toast--out')).toBe(true);
  });

  it('does nothing if container is missing', () => {
    document.body.innerHTML = '';
    expect(() => showToast('No container')).not.toThrow();
  });

  it('supports multiple toasts', () => {
    showToast('First');
    showToast('Second');
    const container = document.getElementById('toast-container');
    expect(container.children.length).toBe(2);
  });
});
