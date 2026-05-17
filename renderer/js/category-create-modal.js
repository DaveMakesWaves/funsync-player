// Shared "Create category" modal used by both the Categories view and the
// inline "+ New category" affordance in the Library's Assign Category flow.
//
// Lives outside `renderer/components/categories.js` so the Library doesn't
// have to pull in the entire Categories component (and its DOM lifecycle)
// just to open the create-category modal. The colour palette is exported
// here for the same reason — Categories imports from this module too, so
// there's a single source of truth for the preset colours.

import { Modal } from '../components/modal.js';
import { t } from './i18n.js';

export const PRESET_COLORS = [
  '#e94560', '#ff6b81', '#f39c12', '#2ecc71',
  '#3498db', '#9b59b6', '#1abc9c', '#e74c3c',
  '#00cec9', '#fd79a8',
];

/**
 * Open the create-category modal, persist the new category via
 * `settings.addCategory(name, color)`, and return the new category's id.
 *
 * @param {Object} args
 * @param {{ addCategory: (name: string, color: string) => Promise<{id: string}> }} args.settings
 * @returns {Promise<string|null>} new category id, or null if user cancelled / left the field blank.
 */
export async function promptCreateCategory({ settings }) {
  const result = await Modal.open({
    title: t('categories.newCategory'),
    onRender(body, close) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal-input';
      input.placeholder = t('categories.categoryNamePlaceholder');
      body.appendChild(input);

      const colorLabel = document.createElement('div');
      colorLabel.className = 'categories__color-label';
      colorLabel.textContent = t('categories.color');
      body.appendChild(colorLabel);

      let selectedColor = PRESET_COLORS[0];

      const swatches = document.createElement('div');
      swatches.className = 'categories__color-swatches';

      for (const color of PRESET_COLORS) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'categories__color-swatch';
        if (color === selectedColor) swatch.classList.add('categories__color-swatch--selected');
        swatch.style.background = color;
        swatch.addEventListener('click', () => {
          selectedColor = color;
          swatches.querySelectorAll('.categories__color-swatch').forEach((s) =>
            s.classList.toggle('categories__color-swatch--selected', s === swatch));
        });
        swatches.appendChild(swatch);
      }
      body.appendChild(swatches);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn modal-btn--secondary';
      cancelBtn.type = 'button';
      cancelBtn.textContent = t('common.cancel');
      cancelBtn.addEventListener('click', () => close(null));

      const createBtn = document.createElement('button');
      createBtn.className = 'modal-btn modal-btn--primary';
      createBtn.type = 'button';
      createBtn.textContent = t('common.create');
      createBtn.addEventListener('click', () => {
        const val = input.value.trim();
        if (val) close({ name: val, color: selectedColor });
        else close(null);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(createBtn);
      body.appendChild(actions);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          createBtn.click();
        }
      });
      // Focus the name input so the user can start typing immediately —
      // matches the prompt() flow's convention.
      setTimeout(() => input.focus(), 0);
    },
  });

  if (!result) return null;
  const cat = await settings.addCategory(result.name, result.color);
  return cat?.id ?? null;
}
