/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Find duplicates modal, the REAL Settings panel
 * and the REAL Modal render into a document, and i18n.js / settings-panel.js
 * branch on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// R3-06 (round-2 review nit): every string that names the place a removed
// file goes said "Recycle Bin", which is "Trash" on Linux and macOS. Each one
// now picks the word by platform (ICU select on `os`, renderer/js/
// recycle-bin.js): Find duplicates (Settings blurb, button, question, toast)
// and the EroScripts "Replace?" question (eroscripts-save-dialog-route and
// eroscripts-inline-replace cover that one and its failure message).
//
// The English text is pinned here (the strings stage writes it into the 8
// locale files): a call that forgets `{ os }` shows the raw ICU template and
// fails, and so does a string that still says Recycle Bin on Linux.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { DuplicatesModal } = await import('../../renderer/components/duplicates-modal.js');
const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const { binOs } = await import('../../renderer/js/recycle-bin.js');

const BIN = '{os, select, win {Recycle Bin} other {Trash}}';
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
Object.assign(ENX.settingsPanel.duplicates, {
  sectionBlurb: `Look for videos you have more than one copy of, and move the spares to the ${BIN} to get the space back.`,
  remove: `Move to ${BIN}`,
  confirmTitle: `Move to ${BIN}?`,
  confirmBody: `Move {count, plural, one {# file} other {# files}} ({size}) to the ${BIN}? You can get them back from there if you change your mind. The copy marked Keep in each group is not touched.`,
  confirmBtn: `Move to ${BIN}`,
  removedToast: `Moved {count, plural, one {# file} other {# files}} to the ${BIN}, {size} reclaimed`,
});

// Two byte copies: one Identical group, the spare ticked by the tier button.
const VIDEOS = [
  { path: 'C:/sb/Holiday.mp4', name: 'Holiday.mp4', duration: 30, hasFunscript: true },
  { path: 'C:/sb/zz_backup_7731.mp4', name: 'zz_backup_7731.mp4', duration: 30, hasFunscript: false },
];
const SIZES = { 'C:/sb/Holiday.mp4': { size: 5000 }, 'C:/sb/zz_backup_7731.mp4': { size: 5000 } };
const HASHES = { 'C:/sb/Holiday.mp4': { hash: 'cccc' }, 'C:/sb/zz_backup_7731.mp4': { hash: 'cccc' } };

const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  showToast.mockClear();
  document.body.innerHTML = '<div id="app"></div><div id="toast-container"></div>';
});
afterEach(async () => {
  for (const o of overlays()) { o.querySelector('.modal-close-btn')?.click(); await flush(); }
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('binOs', () => {
  it('is "win" only on Windows', () => {
    expect(binOs('win32')).toBe('win');
    expect(binOs('linux')).toBe('other');
    expect(binOs('darwin')).toBe('other');
    window.funsync = { platform: 'win32' };
    expect(binOs()).toBe('win');
    window.funsync = { platform: 'linux' };
    expect(binOs()).toBe('other');
  });
});

describe.each([
  ['win32', 'Recycle Bin'],
  ['linux', 'Trash'],
  ['darwin', 'Trash'],
])('Find duplicates on %s says "%s" (R3-06)', (platform, word) => {
  it('the button, the question, its action and the toast', async () => {
    const trashVideoFiles = vi.fn(async (paths) => paths.map((p) => ({ path: p, ok: true, size: 5000 })));
    window.funsync = {
      platform,
      statVideoFiles: async () => SIZES,
      hashVideoFiles: async () => HASHES,
      trashVideoFiles,
    };
    const modal = new DuplicatesModal({ getVideos: () => VIDEOS, onRemoved: () => {} });
    modal._body = document.createElement('div');
    document.body.appendChild(modal._body);
    await modal._scan();
    modal._body.querySelector('[data-select-tier="identical"]').click();
    const btn = modal._body.querySelector('#dup-remove');
    expect(btn.textContent.trim()).toBe(`Move to ${word}`);
    btn.click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(1));
    const dlg = overlays()[0];
    expect(dlg.querySelector('.modal-title').textContent).toBe(`Move to ${word}?`);
    expect(dlg.querySelector('.modal-message').textContent).toBe(
      `Move 1 file (4.9 KB) to the ${word}? You can get them back from there if you change your mind. The copy marked Keep in each group is not touched.`,
    );
    const action = dlg.querySelector('.modal-actions .modal-btn--danger');
    expect(action.textContent).toBe(`Move to ${word}`);
    action.click();
    await vi.waitFor(() => expect(trashVideoFiles).toHaveBeenCalled());
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast.mock.calls[0][0]).toBe(`Moved 1 file to the ${word}, 4.9 KB reclaimed`);
  });

  it('the Settings > Data blurb', async () => {
    window.funsync = { platform, setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
    const values = new Map([['player.language', 'en']]);
    const settings = { values, get: (k) => values.get(k), set: (k, v) => values.set(k, v), getAll: () => ({}) };
    const closed = new SettingsPanel({ settings }).show();
    document.querySelector('.settings-panel__rail-item[data-area="data"]').click();
    await flush();
    const text = document.querySelector('.modal-overlay').textContent.replace(/\s+/g, ' ');
    expect(text).toContain(`move the spares to the ${word} to get the space back.`);
    expect(text).not.toContain('{os');
    overlays()[0].querySelector('.modal-close-btn').click();
    await closed;
  });
});
