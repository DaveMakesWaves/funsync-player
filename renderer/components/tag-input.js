// A tag box: typed words become chips (comma, Enter or Tab), with suggestions
// as you type and a × on each chip, as tagging works on most sites (Dave,
// 2026-11-22: "adding a comma afterward doesn't turn that word tag into a
// block ... i just created a feed for tentacle and it wasn't on the list but
// it exists on eroscripts"). Used by the EroScripts feed window.
//
// Tags are forum slugs (lowercase letters, digits, dashes). `suggest(query)`
// answers [{name}] (sync or a Promise); `exists(tag)` answers true / false /
// null (unknown) for the warning on a chip.

import { t } from '../js/i18n.js';

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SHOW = 8;

/** A typed word as a tag slug, or '' when it cannot be one. */
export function toTag(word) {
  const s = String(word || '').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-');
  return TAG_RE.test(s) ? s : '';
}

/** Suggestions for a query: names starting with it first, then containing it; none already chosen. */
export function rankSuggestions(query, names, chosen = []) {
  const q = toTag(query) || String(query || '').trim().toLowerCase();
  if (!q) return [];
  const seen = new Set(chosen);
  const starts = [];
  const contains = [];
  for (const n of names) {
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (n.startsWith(q)) starts.push(n);
    else if (n.includes(q)) contains.push(n);
  }
  return [...starts, ...contains].slice(0, SHOW);
}

export class TagInput {
  /**
   * @param {object} o
   * @param {string[]} [o.tags]
   * @param {(q: string) => (Array<{name: string}>|Promise<Array<{name: string}>>)} [o.suggest]
   * @param {(tag: string) => (boolean|null|Promise<boolean|null>)} [o.exists]
   * @param {number} [o.max]
   * @param {(tags: string[]) => void} [o.onChange]
   * @param {string} [o.placeholder]
   */
  constructor({ tags = [], suggest = null, exists = null, max = Infinity, onChange = null, placeholder = '' } = {}) {
    this._tags = [];
    this._suggest = suggest;
    this._exists = exists;
    this._max = max;
    this._onChange = onChange;
    this._placeholder = placeholder; // kept: a full box blanks the field's own
    this._disabled = false;
    this._unknown = new Set();
    this._items = [];
    this._active = -1;
    this._token = 0;

    this.el = document.createElement('div');
    this.el.className = 'es-taginput';
    this._chips = document.createElement('span');
    this._chips.className = 'es-taginput__chips';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'es-taginput__input';
    this.input.placeholder = placeholder;
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this._list = document.createElement('ul');
    this._list.className = 'es-taginput__list';
    this._list.setAttribute('role', 'listbox');
    this._list.id = `es-taglist-${Math.random().toString(36).slice(2, 9)}`;
    this._list.hidden = true;
    this.input.setAttribute('aria-controls', this._list.id);
    this.el.append(this._chips, this.input, this._list);

    this.el.addEventListener('click', (e) => { if (e.target === this.el || e.target === this._chips) this.input.focus(); });
    this.input.addEventListener('input', () => this._onInput());
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (!/[,\n]/.test(text)) return;
      e.preventDefault();
      for (const w of text.split(/[,\n]+/)) this.add(w);
    });
    this.input.addEventListener('blur', () => {
      // A word left in the box counts too (a click on a suggestion runs first).
      setTimeout(() => { if (this.input.value.trim()) this._commit(); this._close(); }, 150);
    });
    for (const tag of tags) this.add(tag, { quiet: true });
  }

  get tags() { return [...this._tags]; }

  /** Show these tags (quietly: no onChange), e.g. a feed's while it is open. */
  setTags(list) {
    this._tags = [];
    this._unknown.clear();
    for (const tag of Array.isArray(list) ? list : []) {
      const tg = toTag(tag);
      if (tg && !this._tags.includes(tg)) this._tags.push(tg);
    }
    this._paint();
  }

  /** Read-only (the EroScripts tab while a feed is open: its tags are the feed's). */
  setDisabled(on) {
    this._disabled = !!on;
    this.el.classList.toggle('es-taginput--disabled', this._disabled);
    this._paint();
  }

  setMax(n) {
    this._max = n;
    this._paint();
  }

  /** Add a word as a tag (once, cleaned); false when it is not one or there is no room. */
  add(word, { quiet = false } = {}) {
    const tag = toTag(word);
    if (!tag || this._tags.includes(tag) || this._tags.length >= this._max) return false;
    this._tags.push(tag);
    this._check(tag);
    this._paint();
    if (!quiet) this._onChange?.(this.tags);
    return true;
  }

  remove(tag) {
    const i = this._tags.indexOf(tag);
    if (i < 0) return;
    this._tags.splice(i, 1);
    this._unknown.delete(tag);
    this._paint();
    this._onChange?.(this.tags);
  }

  async _check(tag) {
    if (typeof this._exists !== 'function') return;
    let known = null;
    try { known = await this._exists(tag); } catch { known = null; }
    if (known === false) this._unknown.add(tag); else this._unknown.delete(tag);
    this._paint();
  }

  _commit() {
    const raw = this.input.value;
    const words = raw.split(',');
    let added = false;
    for (const w of words) if (w.trim()) added = this.add(w) || added;
    this.input.value = '';
    this._close();
    return added;
  }

  _onInput() {
    const v = this.input.value;
    // A comma ends the tag (as on most sites).
    if (v.includes(',')) { this._commit(); return; }
    this._refreshList();
  }

  _onKey(e) {
    const open = !this._list.hidden && this._items.length > 0;
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); this._move(1); return; }
    if (e.key === 'ArrowUp' && open) { e.preventDefault(); this._move(-1); return; }
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); this._close(); return; }
    if (e.key === 'Enter' || (e.key === 'Tab' && this.input.value.trim())) {
      if (open && this._active >= 0) {
        e.preventDefault();
        this.add(this._items[this._active]);
        this.input.value = '';
        this._close();
        return;
      }
      if (this.input.value.trim()) {
        e.preventDefault();
        this._commit();
      }
      return;
    }
    if (e.key === 'Backspace' && !this.input.value && this._tags.length) {
      e.preventDefault();
      this.remove(this._tags[this._tags.length - 1]);
    }
  }

  _move(step) {
    const n = this._items.length;
    this._active = (this._active + step + n) % n;
    this._paintList();
  }

  async _refreshList() {
    const q = this.input.value.trim();
    const token = ++this._token;
    if (!q || typeof this._suggest !== 'function') { this._close(); return; }
    let found = [];
    try { found = await this._suggest(q); } catch { found = []; }
    if (token !== this._token) return;
    this._items = rankSuggestions(q, (found || []).map((x) => (typeof x === 'string' ? x : x?.name)), this._tags);
    this._active = this._items.length ? 0 : -1;
    this._paintList();
  }

  _close() {
    this._items = [];
    this._active = -1;
    this._paintList();
  }

  _paintList() {
    this._list.replaceChildren();
    const show = this._items.length > 0;
    this._list.hidden = !show;
    this.input.setAttribute('aria-expanded', String(show));
    this._items.forEach((name, i) => {
      const li = document.createElement('li');
      li.className = `es-taginput__opt${i === this._active ? ' es-taginput__opt--on' : ''}`;
      li.id = `${this._list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this._active));
      li.textContent = name;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();          // keep the focus in the box
        this.add(name);
        this.input.value = '';
        this._close();
        this.input.focus();
      });
      this._list.appendChild(li);
    });
    if (this._active >= 0) this.input.setAttribute('aria-activedescendant', `${this._list.id}-${this._active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  _paint() {
    this._chips.replaceChildren();
    for (const tag of this._tags) {
      if (this._disabled) {
        const chip = document.createElement('span');
        chip.className = 'es-taginput__chip';
        chip.dataset.tag = tag;
        chip.textContent = tag;
        this._chips.appendChild(chip);
        continue;
      }
      const chip = document.createElement('span');
      const unknown = this._unknown.has(tag);
      chip.className = `es-taginput__chip${unknown ? ' es-taginput__chip--unknown' : ''}`;
      chip.dataset.tag = tag;
      if (unknown) chip.title = t('eroscripts.tab.feeds.unknownTag');
      const text = document.createElement('span');
      text.textContent = tag;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'es-taginput__x';
      x.textContent = '×';
      x.setAttribute('aria-label', t('eroscripts.tab.feeds.removeTag', { tag }));
      x.addEventListener('click', (e) => { e.stopPropagation(); this.remove(tag); this.input.focus(); });
      chip.append(text, x);
      this._chips.appendChild(chip);
    }
    const full = this._tags.length >= this._max;
    this.input.disabled = full || this._disabled;
    this.input.hidden = this._disabled;
    this.input.placeholder = full ? '' : this._placeholder;
  }
}
