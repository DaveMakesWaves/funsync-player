// Shared toggle switch, with the LOCKED state that is new for the source work.
//
// "Off because I turned it off" and "off because the drive is missing" must be
// distinguishable, and a locked switch must be genuinely inert — not merely
// styled to look inert. A synthetic click, a keyboard activation or a click
// bubbling from the surrounding row must all fail to change it, because the
// user's stored preference is what is being protected.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createToggleSwitch, applyToggleState } from '../../renderer/components/toggle-switch.js';

describe('createToggleSwitch', () => {
  let onChange;
  beforeEach(() => { onChange = vi.fn(); });

  it('renders an accessible switch', () => {
    const el = createToggleSwitch({ checked: true, label: 'My source' });
    expect(el.tagName).toBe('BUTTON');
    expect(el.type).toBe('button');
    expect(el.getAttribute('role')).toBe('switch');
    expect(el.getAttribute('aria-checked')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('My source');
  });

  it('reflects off state', () => {
    const el = createToggleSwitch({ checked: false });
    expect(el.getAttribute('aria-checked')).toBe('false');
    expect(el.classList.contains('toggle-switch--on')).toBe(false);
  });

  it('reports the NEXT value on click', () => {
    const el = createToggleSwitch({ checked: false, onChange });
    el.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps a caller-supplied class so existing CSS still applies', () => {
    const el = createToggleSwitch({ className: 'settings-panel__source-toggle' });
    expect(el.classList.contains('toggle-switch')).toBe(true);
    expect(el.classList.contains('settings-panel__source-toggle')).toBe(true);
  });
});

describe('locked switch', () => {
  it('reads as off even when the stored preference is on', () => {
    // The preference itself is untouched in settings; this is presentation.
    const el = createToggleSwitch({ checked: true, locked: true });
    expect(el.getAttribute('aria-checked')).toBe('false');
    expect(el.classList.contains('toggle-switch--on')).toBe(false);
    expect(el.classList.contains('toggle-switch--locked')).toBe(true);
  });

  it('is inert to clicks', () => {
    const onChange = vi.fn();
    const el = createToggleSwitch({ checked: false, locked: true, onChange });
    el.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is out of the tab order and marked disabled', () => {
    const el = createToggleSwitch({ locked: true });
    expect(el.disabled).toBe(true);
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.getAttribute('tabindex')).toBe('-1');
  });

  it('carries a reason in the tooltip', () => {
    const el = createToggleSwitch({ locked: true, title: 'Not reachable' });
    expect(el.title).toBe('Not reachable');
  });
});

describe('applyToggleState (in-place update)', () => {
  it('updates without rebuilding, so focus is not lost', () => {
    const el = createToggleSwitch({ checked: false });
    applyToggleState(el, { checked: true });
    expect(el.getAttribute('aria-checked')).toBe('true');
    expect(el.classList.contains('toggle-switch--on')).toBe(true);
  });

  it('unlocks cleanly when the drive comes back', () => {
    const onChange = vi.fn();
    const el = createToggleSwitch({ checked: true, locked: true, onChange });
    applyToggleState(el, { checked: true, locked: false });

    expect(el.disabled).toBe(false);
    expect(el.getAttribute('aria-disabled')).toBe('false');
    expect(el.hasAttribute('tabindex')).toBe(false);
    expect(el.getAttribute('aria-checked')).toBe('true');

    el.click();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('survives a null element', () => {
    expect(() => applyToggleState(null, { checked: true })).not.toThrow();
  });
});
