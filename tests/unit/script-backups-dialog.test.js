/**
 * @vitest-environment jsdom
 * jsdom: a real dialog in a real document, clicks and keys on real elements;
 * i18n.js branches on `window` (notes/CLAUDE.md "Test environments").
 */
// "Restore an earlier version…" (editor work list 3.1, 2026-11-24): the
// dialog lists the versions main kept, newest first, and Restore hands the
// chosen version's text to onRestore after the dialog has closed. It never
// writes: restoring is the editor's own undoable edit. Assertions are on what
// the user sees and on what reaches onRestore.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// lucide does not resolve in vitest (same mock as modal.test.js).
vi.mock('../../renderer/js/icons.js', () => ({
  icon: () => document.createElement('span'),
  X: [],
  History: [],
}));

import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { formatFileSize } from '../../renderer/js/format-file-size.js';
import {
  openScriptBackupsDialog, formatBackupWhen, backupRowLabels,
} from '../../renderer/components/script-backups-dialog.js';

// The work list's strings (the lead merges them into the 8 locale files). A
// key en.json already has wins, so once merged the test reads the real text.
const BACKUP_STRINGS = {
  menuItem: 'Restore an earlier version…',
  title: 'Earlier versions',
  intro: 'Restoring puts that version in the editor, where Undo can take it back. Nothing is written until you save.',
  restore: 'Restore',
  restoreAria: 'Restore the version from {when}',
  today: 'Today {time}',
  yesterday: 'Yesterday {time}',
  dateTime: '{date} {time}',
  points: '{count, plural, one {# point} other {# points}}',
  emptyTitle: 'No earlier versions yet.',
  emptyHint: 'FunSync keeps one each time a script is first overwritten in a session, and every 10 minutes after.',
  listFailed: 'The earlier versions could not be listed. Try again in a moment.',
  readFailed: 'That version could not be read. It may have been removed.',
};
// A path, not a URL object: under jsdom the global URL is not Node's.
const realEn = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../renderer/locales/en.json'), 'utf8'));
const en = structuredClone(realEn);
en.editor.backups = { ...BACKUP_STRINGS, ...(realEn.editor?.backups || {}) };
const S = en.editor.backups;

const NOW = new Date(2026, 10, 24, 16, 0, 0).getTime(); // local time: "today" is the 24th
const at = (d, h, m, s = 0) => new Date(2026, 10, d, h, m, s).getTime();
const timeOf = (ms, seconds = false) => new Intl.DateTimeFormat('en', seconds
  ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
  : { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

const PATH = 'C:\\Lib\\VR\\Clip.funscript';
const ENTRIES = [
  { id: '20261124T140200000Z', at: at(24, 14, 2), size: 18 * 1024, points: 412 },
  { id: '20261123T091500000Z', at: at(23, 9, 15), size: 17 * 1024, points: 1 },
  { id: '20261121T080000000Z', at: at(21, 8, 0), size: 900, points: null },
];

const saved = {};
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const overlay = () => document.querySelector('.modal-overlay');
const rows = () => [...document.querySelectorAll('.script-backups__row')];
const errorLine = () => document.querySelector('.script-backups__error');

beforeEach(() => {
  _setBundlesForTests('en', en, en);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="app"><button id="opener">Export</button></div><div id="toast-container"></div>';
  for (const k of ['listScriptBackups', 'readScriptBackup']) saved[k] = window.funsync[k];
  window.funsync.listScriptBackups = vi.fn(async () => ENTRIES.map((e) => ({ ...e })));
  window.funsync.readScriptBackup = vi.fn(async (_p, id) => `{"version":"${id}"}`);
});
afterEach(() => {
  for (let i = 0; i < 5 && overlay(); i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  Object.assign(window.funsync, saved);
  vi.useRealTimers();
});
afterAll(() => { _setBundlesForTests('en', realEn, realEn); });

describe('when a version was kept', () => {
  it('today, yesterday, a date this year, a date with its year', () => {
    expect(formatBackupWhen(at(24, 14, 2), { now: NOW, locale: 'en' })).toBe(`Today ${timeOf(at(24, 14, 2))}`);
    expect(formatBackupWhen(at(23, 9, 15), { now: NOW, locale: 'en' })).toBe(`Yesterday ${timeOf(at(23, 9, 15))}`);
    const nov21 = at(21, 8, 0);
    const date = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(nov21));
    expect(formatBackupWhen(nov21, { now: NOW, locale: 'en' })).toBe(`${date} ${timeOf(nov21)}`);
    const lastYear = new Date(2025, 11, 31, 23, 59).getTime();
    expect(formatBackupWhen(lastYear, { now: NOW, locale: 'en' })).toContain('2025');
    expect(formatBackupWhen(Number.NaN, { now: NOW })).toBe('');
  });

  it("in the app's language: the time as that locale writes it", () => {
    const de = new Intl.DateTimeFormat('de', { hour: 'numeric', minute: '2-digit' }).format(new Date(at(24, 14, 2)));
    expect(formatBackupWhen(at(24, 14, 2), { now: NOW, locale: 'de' })).toBe(`Today ${de}`);
    expect(de).toBe('14:02');
  });

  it('a row reads "when · points · size"; two in the same minute get their seconds', () => {
    const labels = backupRowLabels([
      { id: 'a', at: at(24, 14, 2, 40), size: 18 * 1024, points: 412 },
      { id: 'b', at: at(24, 14, 2, 5), size: 900, points: null },
      { id: 'c', at: at(23, 9, 15), size: 10, points: 1 },
    ], { now: NOW, locale: 'en' });
    expect(labels[0].label).toBe(`Today ${timeOf(at(24, 14, 2, 40), true)} · 412 points · ${formatFileSize(18 * 1024, 'en')}`);
    expect(labels[1].label).toBe(`Today ${timeOf(at(24, 14, 2, 5), true)} · ${formatFileSize(900, 'en')}`);
    expect(labels[2].label).toBe(`Yesterday ${timeOf(at(23, 9, 15))} · 1 point · ${formatFileSize(10, 'en')}`);
  });
});

describe('the dialog', () => {
  it('lists the versions newest first, each with Restore, and says what Restore does', async () => {
    const done = openScriptBackupsDialog({ path: PATH, onRestore: vi.fn() });
    await flush();
    expect(window.funsync.listScriptBackups).toHaveBeenCalledWith(PATH);
    expect(document.querySelector('.modal-title').textContent).toBe(S.title);
    expect(document.querySelector('.script-backups__file').textContent).toBe('Clip.funscript');
    expect(document.querySelector('.script-backups__intro').textContent).toBe(S.intro);
    expect(document.querySelector('.script-backups__status')).toBeNull();
    expect(rows().map((r) => r.dataset.id)).toEqual(ENTRIES.map((e) => e.id));
    expect(rows()[0].querySelector('.script-backups__label').textContent)
      .toBe(`Today ${timeOf(ENTRIES[0].at)} · 412 points · ${formatFileSize(18 * 1024)}`);
    const btn = rows()[0].querySelector('button');
    expect(btn.textContent).toBe(S.restore);
    expect(btn.getAttribute('aria-label')).toBe(`Restore the version from Today ${timeOf(ENTRIES[0].at)}`);
    // The newest version's Restore has the focus once the list is in.
    expect(document.activeElement).toBe(btn);
    expect(errorLine().hidden).toBe(true);
    document.querySelector('.modal-actions .modal-btn').click();
    expect(await done).toBe(false);
  });

  it('Restore reads that version, closes, then hands its text to onRestore', async () => {
    const onRestore = vi.fn();
    const done = openScriptBackupsDialog({ path: PATH, onRestore });
    await flush();
    rows()[1].querySelector('button').click();
    expect(await done).toBe(true);
    expect(window.funsync.readScriptBackup).toHaveBeenCalledWith(PATH, ENTRIES[1].id);
    expect(overlay()).toBeNull();
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore.mock.calls[0][0]).toBe(`{"version":"${ENTRIES[1].id}"}`);
    expect(onRestore.mock.calls[0][1]).toMatchObject({ id: ENTRIES[1].id, points: 1 });
  });

  it('a version that cannot be read: says so, stays open, nothing restored', async () => {
    window.funsync.readScriptBackup = vi.fn(async () => null);
    const onRestore = vi.fn();
    const done = openScriptBackupsDialog({ path: PATH, onRestore });
    await flush();
    const btn = rows()[0].querySelector('button');
    btn.click();
    await flush();
    expect(overlay()).not.toBeNull();
    expect(errorLine().hidden).toBe(false);
    expect(errorLine().textContent).toBe(S.readFailed);
    expect(errorLine().getAttribute('role')).toBe('alert');
    expect(rows().every((r) => !r.querySelector('button').disabled)).toBe(true);
    // A read that throws is the same answer.
    window.funsync.readScriptBackup = vi.fn(async () => { throw new Error('ipc gone'); });
    btn.click();
    await flush();
    expect(errorLine().textContent).toBe(S.readFailed);
    document.querySelector('.modal-actions .modal-btn').click();
    expect(await done).toBe(false);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('closed while a version was being read: nothing is restored', async () => {
    let answer;
    window.funsync.readScriptBackup = vi.fn(() => new Promise((r) => { answer = r; }));
    const onRestore = vi.fn();
    const done = openScriptBackupsDialog({ path: PATH, onRestore });
    await flush();
    rows()[0].querySelector('button').click();
    expect(rows().every((r) => r.querySelector('button').disabled)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await done).toBe(false);
    answer('{"late":true}');
    await flush();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('no versions yet: the empty state says when FunSync keeps one', async () => {
    window.funsync.listScriptBackups = vi.fn(async () => []);
    const done = openScriptBackupsDialog({ path: PATH, onRestore: vi.fn() });
    await flush();
    expect(document.querySelector('.script-backups__empty-title').textContent).toBe(S.emptyTitle);
    expect(document.querySelector('.script-backups__empty-hint').textContent).toBe(S.emptyHint);
    expect(document.querySelector('.script-backups__list')).toBeNull();
    expect(document.querySelector('.script-backups__intro')).toBeNull();
    document.querySelector('.modal-actions .modal-btn').click();
    expect(await done).toBe(false);
  });

  it('a list that cannot be read says so (not "no versions")', async () => {
    window.funsync.listScriptBackups = vi.fn(async () => { throw new Error('ipc gone'); });
    openScriptBackupsDialog({ path: PATH, onRestore: vi.fn() });
    await flush();
    expect(errorLine().hidden).toBe(false);
    expect(errorLine().textContent).toBe(S.listFailed);
    expect(document.querySelector('.script-backups__empty')).toBeNull();
  });

  it('a file name is text, never markup', async () => {
    const odd = 'C:\\Lib\\<img src=x onerror=alert(1)>.funscript';
    openScriptBackupsDialog({ path: odd, onRestore: vi.fn() });
    await flush();
    expect(document.querySelector('.script-backups__file').textContent).toBe('<img src=x onerror=alert(1)>.funscript');
    expect(document.querySelector('.modal-overlay img')).toBeNull();
  });

  it('an onRestore that throws: false, and the dialog is gone', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const done = openScriptBackupsDialog({ path: PATH, onRestore: () => { throw new Error('editor gone'); } });
    await flush();
    rows()[0].querySelector('button').click();
    expect(await done).toBe(false);
    expect(overlay()).toBeNull();
    err.mockRestore();
  });
});
