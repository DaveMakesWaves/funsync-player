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
import { createCategoryIconPicker } from './category-icon-picker.js';

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
/**
 * The shared name + colour + icon form, used for BOTH creating and editing.
 *
 * Editing matters more than creating here: an icon picker that only appears
 * on new categories is useless to anyone who already has some, which is
 * everybody.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.confirmLabel
 * @param {{name?:string, color?:string, icon?:object|null}} [args.initial]
 * @returns {Promise<{name:string, color:string, icon:object|null}|null>}
 */
export async function promptCategoryDetails({ title, confirmLabel, initial = {} }) {
  return Modal.open({
    title,
    onRender(body, close) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'modal-input';
      input.placeholder = t('categories.categoryNamePlaceholder');
      input.value = initial.name || '';
      body.appendChild(input);

      const colorLabel = document.createElement('div');
      colorLabel.className = 'categories__color-label';
      colorLabel.textContent = t('categories.color');
      body.appendChild(colorLabel);

      let selectedColor = initial.color || PRESET_COLORS[0];

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
          // Shapes are tinted with the category colour, so the picker has to
          // follow the colour choice or its previews lie.
          picker.setColor(selectedColor);
        });
        swatches.appendChild(swatch);
      }
      body.appendChild(swatches);

      const picker = createCategoryIconPicker({
        initialIcon: initial.icon || null,
        color: selectedColor,
      });
      body.appendChild(picker.element);

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
      createBtn.textContent = confirmLabel;
      createBtn.addEventListener('click', () => {
        const val = input.value.trim();
        if (val) close({ name: val, color: selectedColor, icon: picker.getIcon() });
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
}

/**
 * Open the create-category modal, persist the new category via
 * `settings.addCategory(name, color, icon)`, and return the new id.
 *
 * @param {Object} args
 * @param {{ addCategory: (name: string, color: string, icon?: object|null) => Promise<{id: string}> }} args.settings
 * @returns {Promise<string|null>} new category id, or null if cancelled / blank.
 */
export async function promptCreateCategory({ settings }) {
  const result = await promptCategoryDetails({
    title: t('categories.newCategory'),
    confirmLabel: t('common.create'),
  });
  if (!result) return null;
  const cat = await settings.addCategory(result.name, result.color, result.icon);
  return cat?.id ?? null;
}
