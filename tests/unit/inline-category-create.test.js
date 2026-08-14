// Tests for the inline category-create affordance.
//
// Community feedback (GGEZGitGud, 2026-05-15): "the Category function, it
// will be better to let user add a new one while assign category". Today's
// kebab → Assign Category surfaces a list of existing categories; if none
// exist, it tells the user to go create one in the Categories view, then
// come back. That round-trip is friction. The fix:
//
//   1. `Modal.selectFromList` gains an optional `onCreateNew` callback. When
//      provided, a "+ Create new" button renders at the top of the list (or
//      AS the empty-state when there are no items, replacing the bail-out
//      message).
//   2. `library._assignCategory` and `library._bulkAssignCategory` pass the
//      shared `promptCreateCategory` helper as the callback.
//   3. Categories component uses the same helper so there's one create flow.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Modal } from '../../renderer/components/modal.js';

function mountContainer() {
  // Modal renders into document.body by default.
  document.body.innerHTML = '';
}

function getModalEl() {
  return document.querySelector('.modal-overlay');
}

function getCreateBtn() {
  return document.querySelector('.modal-list-create');
}

function getListItems() {
  return Array.from(document.querySelectorAll('.modal-list-item'));
}

describe('Modal.selectFromList — onCreateNew option', () => {
  beforeEach(() => { mountContainer(); });

  it('renders the create button at the top when items + onCreateNew', () => {
    const items = [
      { id: '1', label: 'A' },
      { id: '2', label: 'B' },
    ];
    Modal.selectFromList('Pick', items, { onCreateNew: () => '99' });
    const btn = getCreateBtn();
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('modal-list-create--top')).toBe(true);
    expect(btn.textContent).toBe('+ Create new');
    // Listed items still render below.
    expect(getListItems().length).toBe(2);
  });

  it('uses the createLabel override when provided', () => {
    Modal.selectFromList('Pick', [{ id: '1', label: 'A' }], {
      onCreateNew: () => '99',
      createLabel: '+ New category',
    });
    expect(getCreateBtn().textContent).toBe('+ New category');
  });

  it('renders the create button in empty-state placement when items.length === 0', () => {
    Modal.selectFromList('Pick', [], { onCreateNew: () => '99' });
    const btn = getCreateBtn();
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('modal-list-create--empty')).toBe(true);
    // The default "No items available" bail-out copy is suppressed when a
    // create affordance is available — the button IS the next action.
    expect(document.querySelector('.modal-message')).toBeNull();
  });

  it('falls back to "No items available" copy when no items AND no onCreateNew', () => {
    Modal.selectFromList('Pick', []);
    expect(getCreateBtn()).toBeNull();
    expect(document.querySelector('.modal-message')?.textContent).toBe('No items available');
  });

  it('clicking create resolves the modal with the returned id', async () => {
    const items = [{ id: '1', label: 'A' }];
    const onCreateNew = vi.fn(() => '99');
    const promise = Modal.selectFromList('Pick', items, { onCreateNew });
    getCreateBtn().click();
    await new Promise(setImmediate);
    const result = await promise;
    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(result).toBe('99');
    // Modal closed.
    expect(getModalEl()).toBeNull();
  });

  it('supports async onCreateNew that resolves to an id', async () => {
    const onCreateNew = vi.fn(async () => {
      await Promise.resolve();
      return 'async-99';
    });
    const promise = Modal.selectFromList('Pick', [{ id: '1', label: 'A' }], { onCreateNew });
    getCreateBtn().click();
    const result = await promise;
    expect(result).toBe('async-99');
  });

  it('keeps the modal open and re-enables the button when onCreateNew returns null', async () => {
    const onCreateNew = vi.fn(async () => null);
    const promise = Modal.selectFromList('Pick', [{ id: '1', label: 'A' }], { onCreateNew });
    const btn = getCreateBtn();
    btn.click();
    // After the async no-op, the modal is still mounted.
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    expect(getModalEl()).not.toBeNull();
    expect(btn.disabled).toBe(false);
    // Cancel via Escape so the test resolves the promise.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await promise).toBeNull();
  });

  it('disables the button during the create flow so double-clicks dont double-fire', async () => {
    let resolveCreate;
    const onCreateNew = vi.fn(() => new Promise((r) => { resolveCreate = r; }));
    const promise = Modal.selectFromList('Pick', [{ id: '1', label: 'A' }], { onCreateNew });
    const btn = getCreateBtn();
    btn.click();
    // Synchronously: button disabled, callback called once.
    expect(btn.disabled).toBe(true);
    btn.click(); // would-be double-click is now inert.
    expect(onCreateNew).toHaveBeenCalledTimes(1);
    resolveCreate('99');
    expect(await promise).toBe('99');
  });

  it('clicking an existing item still resolves with that id (create-affordance does not steal events)', async () => {
    const onCreateNew = vi.fn(() => '99');
    const promise = Modal.selectFromList(
      'Pick',
      [{ id: '1', label: 'A' }, { id: '2', label: 'B' }],
      { onCreateNew },
    );
    getListItems()[1].click();
    expect(await promise).toBe('2');
    expect(onCreateNew).not.toHaveBeenCalled();
  });
});

describe('promptCreateCategory — shared helper', () => {
  let module;

  beforeEach(async () => {
    mountContainer();
    module = await import('../../renderer/js/category-create-modal.js');
  });

  it('opens the name + colour modal and persists via settings.addCategory', async () => {
    const settings = {
      addCategory: vi.fn(async (name, color) => ({ id: 'cat-new', name, color })),
    };
    const promise = module.promptCreateCategory({ settings });
    const input = document.querySelector('.modal-input');
    expect(input).not.toBeNull();
    input.value = 'Hardcore';
    document.querySelector('.modal-btn--primary').click();
    const id = await promise;
    expect(id).toBe('cat-new');
    expect(settings.addCategory).toHaveBeenCalledTimes(1);
    // Third arg is the icon: null means 'plain colour dot', i.e. the
    // default the picker starts on.
    expect(settings.addCategory).toHaveBeenCalledWith('Hardcore', module.PRESET_COLORS[0], null);
  });

  it('returns null when the user cancels', async () => {
    const settings = { addCategory: vi.fn() };
    const promise = module.promptCreateCategory({ settings });
    document.querySelector('.modal-btn--secondary').click();
    expect(await promise).toBeNull();
    expect(settings.addCategory).not.toHaveBeenCalled();
  });

  it('returns null when the user clicks Create with a blank name', async () => {
    const settings = { addCategory: vi.fn() };
    const promise = module.promptCreateCategory({ settings });
    const input = document.querySelector('.modal-input');
    input.value = '   '; // whitespace only — should be treated as empty
    document.querySelector('.modal-btn--primary').click();
    expect(await promise).toBeNull();
    expect(settings.addCategory).not.toHaveBeenCalled();
  });

  it('uses the selected colour when the user clicks a swatch', async () => {
    const settings = {
      addCategory: vi.fn(async (name, color) => ({ id: 'cat', name, color })),
    };
    const promise = module.promptCreateCategory({ settings });
    const swatches = document.querySelectorAll('.categories__color-swatch');
    swatches[3].click();
    const input = document.querySelector('.modal-input');
    input.value = 'POV';
    document.querySelector('.modal-btn--primary').click();
    await promise;
    expect(settings.addCategory).toHaveBeenCalledWith('POV', module.PRESET_COLORS[3], null);
  });

  it('returns null if settings.addCategory resolves without an object', async () => {
    const settings = { addCategory: vi.fn(async () => null) };
    const promise = module.promptCreateCategory({ settings });
    document.querySelector('.modal-input').value = 'X';
    document.querySelector('.modal-btn--primary').click();
    expect(await promise).toBeNull();
  });

  it('Enter key in the name field submits the create', async () => {
    const settings = {
      addCategory: vi.fn(async (name, color) => ({ id: 'cat', name, color })),
    };
    const promise = module.promptCreateCategory({ settings });
    const input = document.querySelector('.modal-input');
    input.value = 'Foot';
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    input.dispatchEvent(evt);
    const id = await promise;
    expect(id).toBe('cat');
    expect(settings.addCategory).toHaveBeenCalledWith('Foot', module.PRESET_COLORS[0], null);
  });

  it('exports the PRESET_COLORS palette for Categories component reuse', () => {
    expect(Array.isArray(module.PRESET_COLORS)).toBe(true);
    expect(module.PRESET_COLORS.length).toBeGreaterThanOrEqual(6);
    // Every colour is a valid CSS hex literal.
    for (const c of module.PRESET_COLORS) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('Integration: end-to-end inline category creation flow', () => {
  beforeEach(() => { mountContainer(); });

  it('selectFromList + onCreateNew + promptCreateCategory composes correctly', async () => {
    const { promptCreateCategory } = await import('../../renderer/js/category-create-modal.js');
    const settings = {
      addCategory: vi.fn(async (name, color) => ({ id: 'cat-inline', name, color })),
    };
    // Start with no categories — empty state.
    const promise = Modal.selectFromList('Assign Category', [], {
      createLabel: '+ New category',
      onCreateNew: () => promptCreateCategory({ settings }),
    });
    // Click "+ New category" — opens the create modal in place of the list.
    getCreateBtn().click();
    // Wait a microtask for the chained promptCreateCategory modal to mount.
    await new Promise(setImmediate);
    const input = document.querySelector('.modal-input');
    expect(input).not.toBeNull();
    input.value = 'Inline-created';
    document.querySelector('.modal-btn--primary').click();
    const selectedId = await promise;
    expect(selectedId).toBe('cat-inline');
    expect(settings.addCategory).toHaveBeenCalledWith('Inline-created', expect.stringMatching(/^#/), null);
  });

  it('cancelling the inner create modal leaves the outer selectFromList open', async () => {
    const { promptCreateCategory } = await import('../../renderer/js/category-create-modal.js');
    const settings = { addCategory: vi.fn() };
    const promise = Modal.selectFromList('Assign Category', [{ id: 'a', label: 'A' }], {
      createLabel: '+ New category',
      onCreateNew: () => promptCreateCategory({ settings }),
    });
    getCreateBtn().click();
    await new Promise(setImmediate);
    // Cancel the inner create modal.
    document.querySelector('.modal-btn--secondary').click();
    await new Promise(setImmediate);
    // Outer selectFromList is still mounted.
    expect(getModalEl()).not.toBeNull();
    // User then picks an existing one.
    document.querySelector('.modal-list-item').click();
    expect(await promise).toBe('a');
  });
});
