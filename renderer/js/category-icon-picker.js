// The icon chooser used by both the create-category and edit-category
// modals.
//
// myopiic, thread #270: "it would be cool to select a symbol and a color
// instead of just a color. Or maybe give the option to chose an emoji
// instead?"
//
// Shared rather than duplicated because "you can only set an icon on NEW
// categories" would be a useless feature for anyone who already has some —
// which is everybody.
//
// Three mutually exclusive modes, defaulting to Colour so the existing
// appearance is what you get unless you ask for something else:
//
//   Colour  -> icon: null              (a plain dot, exactly as before)
//   Shape   -> icon: {type:'shape'}    (tinted with the category colour)
//   Emoji   -> icon: {type:'emoji'}    (carries its own colour)

import { t } from './i18n.js';
import {
  CATEGORY_SHAPES,
  SHAPE_KEYS,
  createCategoryMark,
  normaliseIcon,
  firstGrapheme,
  graphemeCount,
  withEmojiPresentation,
} from './category-icon.js';
import { EMOJI_GROUPS, QUICK_EMOJI } from './emoji-catalog.js';
import { emojiAssetPath, createEmojiImage } from './emoji-asset.js';

/**
 * Build the icon picker.
 *
 * @param {object} opts
 * @param {object|null} opts.initialIcon — existing icon, or null
 * @param {string} opts.color — current category colour, for live previews
 * @param {(icon: object|null) => void} [opts.onChange]
 * @returns {{element: HTMLElement, getIcon: () => object|null, setColor: (c:string)=>void}}
 */
export function createCategoryIconPicker({ initialIcon = null, color = '#e94560', onChange } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'categories__icon-picker';

  const label = document.createElement('div');
  label.className = 'categories__color-label';
  label.textContent = t('categories.iconLabel');
  wrap.appendChild(label);

  const start = normaliseIcon(initialIcon);
  let mode = start ? start.type : 'color';
  let shapeKey = start?.type === 'shape' ? start.value : SHAPE_KEYS[0];
  let emojiChar = start?.type === 'emoji' ? start.value : '';
  let currentColor = color;

  const current = () => {
    if (mode === 'shape') return { type: 'shape', value: shapeKey };
    if (mode === 'emoji') return emojiChar ? { type: 'emoji', value: emojiChar } : null;
    return null;
  };

  const emit = () => { if (onChange) onChange(current()); };

  // --- mode tabs ---
  const tabs = document.createElement('div');
  tabs.className = 'categories__icon-modes';
  const modeButtons = {};
  for (const [key, labelKey] of [
    ['color', 'categories.iconModeColor'],
    ['shape', 'categories.iconModeShape'],
    ['emoji', 'categories.iconModeEmoji'],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'categories__icon-mode';
    b.textContent = t(labelKey);
    b.setAttribute('aria-pressed', String(mode === key));
    b.addEventListener('click', () => { mode = key; sync(); emit(); });
    modeButtons[key] = b;
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);

  // --- shape swatches ---
  const shapeRow = document.createElement('div');
  shapeRow.className = 'categories__icon-shapes';
  const shapeButtons = {};
  for (const key of SHAPE_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'categories__icon-shape';
    b.title = key;
    b.setAttribute('aria-label', key);
    b.addEventListener('click', () => { shapeKey = key; mode = 'shape'; sync(); emit(); });
    shapeButtons[key] = b;
    shapeRow.appendChild(b);
  }
  wrap.appendChild(shapeRow);

  // --- emoji input ---
  const emojiRow = document.createElement('div');
  emojiRow.className = 'categories__icon-emoji-row';
  const emojiInput = document.createElement('input');
  emojiInput.type = 'text';
  emojiInput.className = 'modal-input categories__icon-emoji-input';
  emojiInput.placeholder = t('categories.iconEmojiPlaceholder');
  emojiInput.value = emojiChar;
  // Not maxLength=1: an emoji is several code units, so maxLength would
  // truncate mid-surrogate and leave a broken half-character behind.
  emojiInput.addEventListener('input', () => {
    const raw = emojiInput.value.trim();
    const one = firstGrapheme(raw);
    if (graphemeCount(raw) > 1 && one) emojiInput.value = one;
    emojiChar = one;
    mode = 'emoji';
    sync();
    emit();
  });
  const pick = (e) => {
    emojiChar = e;
    emojiInput.value = e;
    mode = 'emoji';
    sync();
    emit();
  };

  // Quick picks stay at the top so the common case needs no scrolling.
  const emojiSuggestions = document.createElement('div');
  emojiSuggestions.className = 'categories__icon-emoji-suggestions';
  for (const e of QUICK_EMOJI.filter((e) => emojiAssetPath(e))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'categories__icon-emoji-suggestion';
    b.appendChild(createEmojiImage(e, { size: 20 }));
    b.addEventListener('click', () => pick(withEmojiPresentation(e)));
    emojiSuggestions.appendChild(b);
  }

  // Search — with a few hundred entries, scrolling alone is not enough.
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'modal-input categories__icon-emoji-search';
  search.placeholder = t('categories.iconEmojiSearch');

  const browser = document.createElement('div');
  browser.className = 'categories__icon-emoji-browser';

  const empty = document.createElement('div');
  empty.className = 'categories__icon-emoji-empty';
  empty.textContent = t('categories.iconEmojiNone');
  empty.hidden = true;

  // Filtered ONCE, to what this machine can actually draw. Windows renders
  // through Segoe UI Emoji and most Linux desktops through Noto Color Emoji,
  // and the two ship different Unicode versions — offering a glyph that
  // shows as tofu is worse than not offering it. See emoji-support.js.
  const supportedGroups = EMOJI_GROUPS
    .map((g) => ({ ...g, emoji: g.emoji.filter((e) => emojiAssetPath(e)) }))
    .filter((g) => g.emoji.length > 0);

  const buildBrowser = (query) => {
    browser.textContent = '';
    const q = (query || '').trim().toLowerCase();
    let shown = 0;

    for (const group of supportedGroups) {
      // Searching filters by the group name, since the catalogue carries no
      // per-emoji keywords — a full keyword table is a lot of data for a
      // category icon, and grouping is what people actually scan by.
      const groupLabel = t(group.labelKey);
      const matches = !q || groupLabel.toLowerCase().includes(q);
      if (!matches) continue;

      const heading = document.createElement('div');
      heading.className = 'categories__icon-emoji-group';
      heading.textContent = groupLabel;
      browser.appendChild(heading);

      const row = document.createElement('div');
      row.className = 'categories__icon-emoji-grid';
      for (const e of group.emoji) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'categories__icon-emoji-suggestion';
        b.appendChild(createEmojiImage(e, { size: 20 }));
        b.addEventListener('click', () => pick(withEmojiPresentation(e)));
        row.appendChild(b);
        shown++;
      }
      browser.appendChild(row);
    }
    empty.hidden = shown > 0;
  };

  search.addEventListener('input', () => buildBrowser(search.value));

  emojiRow.appendChild(emojiInput);
  emojiRow.appendChild(emojiSuggestions);
  emojiRow.appendChild(search);
  emojiRow.appendChild(empty);
  emojiRow.appendChild(browser);
  wrap.appendChild(emojiRow);
  buildBrowser('');

  // --- live preview of the final mark ---
  const previewRow = document.createElement('div');
  previewRow.className = 'categories__icon-preview-row';
  const previewLabel = document.createElement('span');
  previewLabel.className = 'categories__color-label';
  previewLabel.textContent = t('categories.iconPreview');
  const previewHost = document.createElement('span');
  previewHost.className = 'categories__icon-preview';
  previewRow.appendChild(previewLabel);
  previewRow.appendChild(previewHost);
  wrap.appendChild(previewRow);

  function sync() {
    for (const [key, btn] of Object.entries(modeButtons)) {
      const on = key === mode;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('categories__icon-mode--active', on);
    }
    shapeRow.hidden = mode !== 'shape';
    emojiRow.hidden = mode !== 'emoji';

    // Redraw shape swatches in the live colour so the choice is honest.
    for (const [key, btn] of Object.entries(shapeButtons)) {
      btn.textContent = '';
      btn.appendChild(createCategoryMark(
        { color: currentColor, icon: { type: 'shape', value: key } },
        { size: 14 },
      ));
      btn.classList.toggle('categories__icon-shape--selected', mode === 'shape' && key === shapeKey);
    }

    previewHost.textContent = '';
    previewHost.appendChild(createCategoryMark(
      { color: currentColor, icon: current() },
      { size: 16, className: 'categories__icon-preview-mark' },
    ));
  }

  sync();

  return {
    element: wrap,
    getIcon: () => normaliseIcon(current()),
    setColor(next) { currentColor = next; sync(); },
  };
}

export { CATEGORY_SHAPES };
