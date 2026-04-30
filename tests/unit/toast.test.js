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

  // --- Polish pass 2026-04-27 (SCOPE-desktop-redesign §4.8) ---

  it('error toasts get role="alert" so screen readers announce immediately', () => {
    showToast('Disk full', 'error');
    const toast = document.querySelector('.toast');
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.getAttribute('aria-live')).toBe('assertive');
  });

  it('info / warn toasts get role="status" (polite — non-blocking)', () => {
    showToast('Saved');
    const toast = document.querySelector('.toast');
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
  });

  it('renders an explicit close button with aria-label', () => {
    showToast('Hi');
    const closeBtn = document.querySelector('.toast__close');
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.getAttribute('aria-label')).toBe('Dismiss notification');
    // Focusable as a real button (Shneiderman #2 universal usability —
    // keyboard / screen-reader users get a real target).
    expect(closeBtn.tagName).toBe('BUTTON');
  });

  it('clicking the close button dismisses the toast', () => {
    showToast('Hi');
    const closeBtn = document.querySelector('.toast__close');
    expect(document.querySelector('.toast--out')).toBeFalsy();
    closeBtn.click();
    expect(document.querySelector('.toast--out')).toBeTruthy();
  });

  it('Enter / Space on the focused toast dismisses it', () => {
    showToast('Hi');
    const toast = document.querySelector('.toast');
    toast.focus();
    toast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(toast.classList.contains('toast--out')).toBe(true);
  });

  it('hovering the toast pauses the auto-dismiss timer', () => {
    showToast('Hi');
    const toast = document.querySelector('.toast');

    // 1s in, hover starts. Without pause, dismiss would fire at 3s; we'll
    // hover for 5s and confirm it's still alive at the 5s mark.
    vi.advanceTimersByTime(1000);
    toast.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(5000);
    expect(toast.classList.contains('toast--out')).toBe(false);

    // After mouseleave, the remaining ~2s budget resumes.
    toast.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(2100);
    expect(toast.classList.contains('toast--out')).toBe(true);
  });

  it('clicking the body still dismisses (preserves prior frictionless flow)', () => {
    showToast('Hi');
    const body = document.querySelector('.toast__body');
    body.click();
    expect(document.querySelector('.toast--out')).toBeTruthy();
  });
});
