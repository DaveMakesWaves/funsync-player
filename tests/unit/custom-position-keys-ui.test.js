// CustomPositionKeys settings view tests.
// SCOPE: notes/features/SCOPE-editor-custom-position-keys.md §6.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomPositionKeys } from '../../renderer/components/custom-position-keys.js';

function makeMount() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

function makeSettings(initial = []) {
  let store = Array.isArray(initial) ? [...initial] : [];
  return {
    get: vi.fn((key) => (key === 'editor.customPositionKeys' ? store : null)),
    set: vi.fn((key, val) => { if (key === 'editor.customPositionKeys') store = val; }),
    _peek: () => store,
  };
}

function fireKey(el, init) {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('CustomPositionKeys — render', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders the empty state when no bindings exist', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    expect(document.querySelector('.custom-position-keys__empty')).toBeTruthy();
  });

  it('renders one row per existing binding', () => {
    const mount = makeMount();
    new CustomPositionKeys({
      element: mount,
      settings: makeSettings([
        { code: 'KeyA', mods: {}, position: 25 },
        { code: 'KeyS', mods: {}, position: 75 },
      ]),
    });
    expect(document.querySelectorAll('.custom-position-keys__row').length).toBe(2);
  });

  it('renders the defaults header + body', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    expect(document.querySelector('.custom-position-keys__defaults-body')).toBeTruthy();
  });

  it('renders the MIDI hint', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    expect(document.querySelector('.custom-position-keys__hint')).toBeTruthy();
  });
});

describe('CustomPositionKeys — add binding', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('save button is disabled until a key is captured', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    const saveBtn = document.querySelector('[data-save-btn]');
    expect(saveBtn.disabled).toBe(true);
  });

  it('capturing a free key enables save', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'KeyJ' });
    const saveBtn = document.querySelector('[data-save-btn]');
    expect(saveBtn.disabled).toBe(false);
  });

  it('saving persists a new binding to settings', () => {
    const mount = makeMount();
    const settings = makeSettings();
    new CustomPositionKeys({ element: mount, settings });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'KeyJ' });
    const posInput = document.querySelector('[data-pos-input]');
    posInput.value = '33';
    posInput.dispatchEvent(new Event('input'));
    document.querySelector('[data-save-btn]').click();
    expect(settings.set).toHaveBeenCalledWith(
      'editor.customPositionKeys',
      [{ code: 'KeyJ', mods: { shift: false, ctrl: false, alt: false }, position: 33 }],
    );
  });

  it('rejects reserved keys (R) with warning + save disabled', () => {
    const mount = makeMount();
    const settings = makeSettings();
    new CustomPositionKeys({ element: mount, settings });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'KeyR' });
    const saveBtn = document.querySelector('[data-save-btn]');
    const warning = document.querySelector('[data-warning]');
    expect(saveBtn.disabled).toBe(true);
    expect(warning.hidden).toBe(false);
    expect(warning.textContent.length).toBeGreaterThan(0);
  });

  it('allows Shift+R (modifier combo on otherwise-reserved bare key)', () => {
    const mount = makeMount();
    const settings = makeSettings();
    new CustomPositionKeys({ element: mount, settings });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'KeyR', shiftKey: true });
    const saveBtn = document.querySelector('[data-save-btn]');
    expect(saveBtn.disabled).toBe(false);
  });

  it('rejects reserved Ctrl+Z but allows bare Z', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'KeyZ', ctrlKey: true });
    expect(document.querySelector('[data-save-btn]').disabled).toBe(true);

    // Restart capture, try bare Z
    capture.click();
    fireKey(capture, { code: 'KeyZ' });
    expect(document.querySelector('[data-save-btn]').disabled).toBe(false);
  });

  it('shows override-default warning when binding to 5', () => {
    const mount = makeMount();
    new CustomPositionKeys({ element: mount, settings: makeSettings() });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'Digit5' });
    const saveBtn = document.querySelector('[data-save-btn]');
    const warning = document.querySelector('[data-warning]');
    expect(saveBtn.disabled).toBe(false);  // override allowed
    expect(warning.hidden).toBe(false);     // but warned
  });

  it('saving last-wins replaces an existing duplicate', () => {
    const mount = makeMount();
    const settings = makeSettings([{ code: 'KeyA', mods: { shift: false, ctrl: false, alt: false }, position: 25 }]);
    new CustomPositionKeys({ element: mount, settings });
    const capture = document.querySelector('.key-capture');
    capture.click();
    fireKey(capture, { code: 'KeyA' });
    const posInput = document.querySelector('[data-pos-input]');
    posInput.value = '75';
    posInput.dispatchEvent(new Event('input'));
    document.querySelector('[data-save-btn]').click();
    expect(settings._peek()).toEqual([
      { code: 'KeyA', mods: { shift: false, ctrl: false, alt: false }, position: 75 },
    ]);
  });
});

describe('CustomPositionKeys — remove binding', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('clicking × removes the row + persists', () => {
    const mount = makeMount();
    const settings = makeSettings([
      { code: 'KeyA', mods: {}, position: 25 },
      { code: 'KeyS', mods: {}, position: 75 },
    ]);
    new CustomPositionKeys({ element: mount, settings });
    const firstRemove = document.querySelector('[data-remove-idx="0"]');
    firstRemove.click();
    expect(settings._peek()).toEqual([{ code: 'KeyS', mods: {}, position: 75 }]);
    expect(document.querySelectorAll('.custom-position-keys__row').length).toBe(1);
  });
});

describe('CustomPositionKeys — reset', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reset button is a no-op when list is already empty', () => {
    const mount = makeMount();
    const settings = makeSettings();
    new CustomPositionKeys({ element: mount, settings });
    document.querySelector('[data-reset-btn]').click();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('reset clears all bindings after confirm', () => {
    const mount = makeMount();
    const settings = makeSettings([{ code: 'KeyA', mods: {}, position: 25 }]);
    new CustomPositionKeys({ element: mount, settings });
    // jsdom window.confirm returns false by default — stub it
    const orig = window.confirm;
    window.confirm = vi.fn(() => true);
    try {
      document.querySelector('[data-reset-btn]').click();
      expect(settings._peek()).toEqual([]);
    } finally {
      window.confirm = orig;
    }
  });

  it('reset is cancelled if user declines confirm', () => {
    const mount = makeMount();
    const settings = makeSettings([{ code: 'KeyA', mods: {}, position: 25 }]);
    new CustomPositionKeys({ element: mount, settings });
    const orig = window.confirm;
    window.confirm = vi.fn(() => false);
    try {
      document.querySelector('[data-reset-btn]').click();
      expect(settings._peek().length).toBe(1);
    } finally {
      window.confirm = orig;
    }
  });
});

describe('CustomPositionKeys — override warning on existing row', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('row that overrides a default shows the override warning text', () => {
    const mount = makeMount();
    new CustomPositionKeys({
      element: mount,
      settings: makeSettings([{ code: 'Digit5', mods: {}, position: 75 }]),
    });
    const warn = document.querySelector('.custom-position-keys__row-warn');
    expect(warn).toBeTruthy();
    expect(warn.textContent.length).toBeGreaterThan(0);
  });
});
