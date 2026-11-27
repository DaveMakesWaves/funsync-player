/**
 * @vitest-environment jsdom
 * jsdom: the Settings > Data row is DOM; i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// Settings > Data > Converted copies (Dave, 2026-11-26: "yes move them to the
// data folder"): how many and how big; Clear asks first with both, then says
// what went and what was kept (a copy in use).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const confirmSpy = vi.fn(async () => true);
vi.mock('../../renderer/components/modal.js', async (orig) => {
  const real = await orig();
  return { ...real, Modal: Object.assign(real.Modal, { confirm: (...a) => confirmSpy(...a) }) };
});
const toasts = [];
vi.mock('../../renderer/js/toast.js', () => ({ showToast: (text, type) => { toasts.push({ text, type }); return { dismiss() {} }; } }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

let panel;
let ctx;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  toasts.length = 0;
  confirmSpy.mockClear();
  panel = document.createElement('div');
  panel.innerHTML = '<div id="sp-converted-status"></div><button id="sp-converted-clear" disabled></button>';
  document.body.appendChild(panel);
  ctx = Object.create(SettingsPanel.prototype);
});
afterEach(() => { panel.remove(); delete window.funsync; });

describe('Settings > Data > Converted copies', () => {
  it('none: says so, Clear disabled', async () => {
    window.funsync = { convertedCopiesInfo: vi.fn(async () => ({ count: 0, bytes: 0 })) };
    await ctx._refreshConvertedStatus(panel);
    expect(panel.querySelector('#sp-converted-status').textContent).toBe(EN.settingsPanel.data.convertedNone);
    expect(panel.querySelector('#sp-converted-clear').disabled).toBe(true);
  });

  it('some: their count and size, Clear enabled', async () => {
    window.funsync = { convertedCopiesInfo: vi.fn(async () => ({ count: 3, bytes: 1.5 * 1024 ** 3 })) };
    await ctx._refreshConvertedStatus(panel);
    const text = panel.querySelector('#sp-converted-status').textContent;
    expect(text).toMatch(/^3 copies, 1[.,]5 GB in total\.$/);
    expect(panel.querySelector('#sp-converted-clear').disabled).toBe(false);
  });

  it('Clear asks with the count and size first; then says what went and what was kept', async () => {
    let count = 2;
    window.funsync = {
      convertedCopiesInfo: vi.fn(async () => ({ count, bytes: count * 1024 ** 2 })),
      clearConvertedCopies: vi.fn(async () => { count = 1; return { removed: 1, bytes: 1024 ** 2, kept: 1 }; }),
    };
    expect(await ctx._clearConvertedCopies(panel)).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][1]).toMatch(/Delete 2 converted copies \(2 MB\)\?/);
    expect(window.funsync.clearConvertedCopies).toHaveBeenCalledTimes(1);
    expect(toasts.at(-1).text).toMatch(/^Cleared 1 copy \(1 MB\)\. 1 copy is in use and was kept\.$/);
    expect(panel.querySelector('#sp-converted-status').textContent).toMatch(/^1 copy, 1 MB in total\.$/);
  });

  it('Cancel at the question: nothing is deleted', async () => {
    confirmSpy.mockResolvedValueOnce(false);
    window.funsync = {
      convertedCopiesInfo: vi.fn(async () => ({ count: 2, bytes: 100 })),
      clearConvertedCopies: vi.fn(),
    };
    expect(await ctx._clearConvertedCopies(panel)).toBe(false);
    expect(window.funsync.clearConvertedCopies).not.toHaveBeenCalled();
  });
});
