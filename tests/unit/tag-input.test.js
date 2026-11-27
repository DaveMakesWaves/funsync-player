/**
 * @vitest-environment jsdom
 *
 * The tag box (Dave, 2026-11-22: "adding a comma afterward doesn't turn that
 * word tag into a block ... like it would when tagging generally anything
 * online").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { TagInput, toTag, rankSuggestions } = await import('../../renderer/components/tag-input.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '';
});

const chips = (ti) => [...ti.el.querySelectorAll('.es-taginput__chip')].map((c) => c.dataset.tag);
const type = (ti, text) => { ti.input.value = text; ti.input.dispatchEvent(new Event('input')); };
const key = (ti, k) => ti.input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('tag words', () => {
  it('a word as a forum tag slug', () => {
    expect(toTag(' #Tentacle ')).toBe('tentacle');
    expect(toTag('big tits')).toBe('big-tits');
    expect(toTag('no!')).toBe('');
  });
  it('suggestions: starting with it first, then containing it; none already chosen', () => {
    expect(rankSuggestions('vr', ['non-vr', 'vr', 'vrchat', 'jav-vr', 'vr'], ['vrchat'])).toEqual(['vr', 'non-vr', 'jav-vr']);
  });
});

describe('the box', () => {
  it('a comma, Enter or Tab makes a chip; Backspace on an empty box takes the last off; × removes one', () => {
    const onChange = vi.fn();
    const ti = new TagInput({ onChange });
    document.body.appendChild(ti.el);
    type(ti, 'tentacle,');
    expect(chips(ti)).toEqual(['tentacle']);
    expect(ti.input.value).toBe('');
    type(ti, 'hentai');
    key(ti, 'Enter');
    type(ti, 'pmv');
    key(ti, 'Tab');
    expect(chips(ti)).toEqual(['tentacle', 'hentai', 'pmv']);
    key(ti, 'Backspace');
    expect(chips(ti)).toEqual(['tentacle', 'hentai']);
    ti.el.querySelector('.es-taginput__chip[data-tag=tentacle] .es-taginput__x').click();
    expect(chips(ti)).toEqual(['hentai']);
    expect(onChange).toHaveBeenLastCalledWith(['hentai']);
    type(ti, 'hentai,');                                     // once only
    expect(chips(ti)).toEqual(['hentai']);
  });

  it('a pasted list becomes chips; no room past the limit', () => {
    const ti = new TagInput({ max: 2 });
    document.body.appendChild(ti.el);
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: () => 'a1, b2, c3' } });
    ti.input.dispatchEvent(e);
    expect(chips(ti)).toEqual(['a1', 'b2']);
    expect(ti.input.disabled).toBe(true);
  });

  it('suggestions as you type: arrows move, Enter picks; Escape closes without closing the window', async () => {
    const ti = new TagInput({ suggest: async () => [{ name: 'tentacle' }, { name: 'tentacles-hentai' }, { name: 'content' }] });
    document.body.appendChild(ti.el);
    type(ti, 'tent');
    await vi.waitFor(() => expect(ti.el.querySelectorAll('.es-taginput__opt')).toHaveLength(3));
    expect(ti.input.getAttribute('aria-expanded')).toBe('true');
    key(ti, 'ArrowDown');
    key(ti, 'Enter');
    expect(chips(ti)).toEqual(['tentacles-hentai']);
    type(ti, 'tent');
    await vi.waitFor(() => expect(ti.el.querySelectorAll('.es-taginput__opt')).toHaveLength(2));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    ti.input.dispatchEvent(esc);
    expect(outer).not.toHaveBeenCalled();                    // the dialog under it stays open
    expect(ti.el.querySelector('.es-taginput__list').hidden).toBe(true);
  });

  it('a tag the forum does not have is marked', async () => {
    const ti = new TagInput({ exists: async (tg) => tg !== 'tentacel' });
    document.body.appendChild(ti.el);
    type(ti, 'tentacel,');
    await vi.waitFor(() => expect(ti.el.querySelector('.es-taginput__chip--unknown')).toBeTruthy());
    expect(ti.el.querySelector('.es-taginput__chip--unknown').title).toBe(EN.eroscripts.tab.feeds.unknownTag);
  });
});
