/**
 * @vitest-environment jsdom
 * jsdom: the REAL dialog on the REAL Modal (focus, Escape, buttons).
 */
// The delete dialog (2026-11-23, EroScripts #434; DESIGN.md §2.18), built to
// the destructive-action rules: the focus starts on Cancel, the Recycle Bin
// is the default, "Delete permanently" shows a red warning with the count and
// size and stays disabled until "I understand they cannot be recovered" is
// ticked, Enter never confirms, a network drive can only be deleted for good.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { openDeleteDialog } from '../../renderer/components/delete-files-dialog.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
afterAll(() => _setBundlesForTests('en', EN, EN));
beforeEach(() => { document.body.innerHTML = ''; _setBundlesForTests('en', EN, EN); });

const frame = () => new Promise((r) => setTimeout(r, 30));
const rows = (over = {}) => [
  { path: 'C:\\Lib\\Clip.mp4', name: 'Clip.mp4', kind: 'video', size: 1048576, checked: true, locked: true, subject: true, sharedWith: [], outside: false },
  { path: 'C:\\Lib\\Clip.funscript', name: 'Clip.funscript', kind: 'script', size: 2048, checked: true, locked: false, sharedWith: [], outside: false },
  { path: 'C:\\Lib\\Clip.pitch.funscript', name: 'Clip.pitch.funscript', kind: 'axis', label: 'pitch', size: 10, checked: false, locked: true, sharedWith: ['Other.mp4'], outside: false },
  ...(over.extra || []),
];
const $ = (s) => document.querySelector(s);
const go = () => $('.delete-files__go');

async function open(r = rows(), platform = 'win32') {
  const result = openDeleteDialog({ title: 'Delete “Clip.mp4”?', intro: 'intro', rows: r, platform });
  await frame();
  return result;
}

describe('the delete dialog', () => {
  it('lists every file with its kind and size; a shared one is kept and says who', async () => {
    open();
    await frame();
    const text = [...document.querySelectorAll('.delete-files__row')].map((li) => li.textContent);
    expect(text[0]).toMatch(/Clip\.mp4.*Video/);
    expect(text[2]).toContain('Also used by “Other.mp4”, so it stays');
    expect(document.querySelectorAll('.delete-files__check')[2].disabled).toBe(true);
    expect($('.delete-files__total').textContent).toMatch(/^2 files, /);
  });

  it('the focus starts on Cancel; Cancel and Escape give null', async () => {
    const p = open();
    await frame(); await frame();
    expect(document.activeElement).toBe($('.delete-files__cancel'));
    $('.delete-files__cancel').click();
    expect(await p).toBeNull();
    const p2 = open();
    await frame();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p2).toBeNull();
  });

  it('the Recycle Bin is the default and says so on its button', async () => {
    const p = open();
    await frame();
    expect(document.querySelector('input[value="bin"]').checked).toBe(true);
    expect(go().textContent).toBe('Move to Recycle Bin');
    expect(go().classList.contains('modal-btn--danger')).toBe(false);
    go().click();
    expect(await p).toEqual({ paths: ['C:\\Lib\\Clip.mp4', 'C:\\Lib\\Clip.funscript'], permanent: false });
  });

  it('Delete permanently: a red warning with the count and size, disabled until the tick box', async () => {
    const p = open();
    await frame();
    const forever = document.querySelector('input[value="permanent"]');
    forever.checked = true;
    forever.dispatchEvent(new Event('change'));
    expect($('.delete-files__warning').hidden).toBe(false);
    expect($('.delete-files__warning-text').textContent).toMatch(/^These 2 files \(.+\) will be deleted permanently\. They will not go to the Recycle Bin, and they cannot be recovered\.$/);
    expect(go().textContent).toBe('Delete permanently');
    expect(go().classList.contains('modal-btn--danger')).toBe(true);
    expect(go().disabled).toBe(true);
    go().click(); // nothing happens
    const understand = $('.delete-files__understand-check');
    understand.checked = true;
    understand.dispatchEvent(new Event('change'));
    expect(go().disabled).toBe(false);
    go().click();
    expect(await p).toEqual({ paths: ['C:\\Lib\\Clip.mp4', 'C:\\Lib\\Clip.funscript'], permanent: true });
  });

  it('one file reads singular all through; the tick box follows the count (test day 2026-11-24, B019)', async () => {
    // Clip 0020 with its script shared (kept): "This file (132.2 kB) will be
    // deleted permanently. They will not go ... they cannot be recovered" and
    // "I understand they cannot be recovered" for a single file.
    open([rows()[0], { ...rows()[1], checked: false, locked: true, sharedWith: ['Clip 0021.mp4'] }]);
    await frame();
    const forever = document.querySelector('input[value="permanent"]');
    forever.checked = true;
    forever.dispatchEvent(new Event('change'));
    expect($('.delete-files__warning-text').textContent).toMatch(/^This file \(.+\) will be deleted permanently\. It will not go to the Recycle Bin, and it cannot be recovered\.$/);
    expect($('.delete-files__understand').textContent).toBe('I understand it cannot be recovered');
  });

  it('two files: the tick box says they', async () => {
    open();
    await frame();
    const forever = document.querySelector('input[value="permanent"]');
    forever.checked = true;
    forever.dispatchEvent(new Event('change'));
    expect($('.delete-files__understand').textContent).toBe('I understand they cannot be recovered');
  });

  it('switching choice clears the tick box (it is asked again)', async () => {
    open();
    await frame();
    const forever = document.querySelector('input[value="permanent"]');
    forever.checked = true; forever.dispatchEvent(new Event('change'));
    const understand = $('.delete-files__understand-check');
    understand.checked = true; understand.dispatchEvent(new Event('change'));
    const bin = document.querySelector('input[value="bin"]');
    bin.checked = true; bin.dispatchEvent(new Event('change'));
    forever.checked = true; forever.dispatchEvent(new Event('change'));
    expect(understand.checked).toBe(false);
    expect(go().disabled).toBe(true);
  });

  it('a network drive: no Recycle Bin choice, the reason shown, nothing preselected', async () => {
    open([{ path: '\\\\nas\\share\\Clip.mp4', name: 'Clip.mp4', kind: 'video', size: 5, checked: true, locked: true, subject: true, sharedWith: [], outside: false }]);
    await frame();
    const bin = document.querySelector('input[value="bin"]');
    expect(bin.disabled).toBe(true);
    expect(bin.checked).toBe(false);
    expect($('.delete-files__note').hidden).toBe(false);
    expect(go().disabled).toBe(true);
  });

  it('Enter on a control never confirms (no default button)', async () => {
    const p = open();
    await frame();
    let settled = false;
    p.then(() => { settled = true; });
    $('.delete-files__check').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await frame();
    expect(settled).toBe(false);
    $('.delete-files__cancel').click();
    await p;
  });
});

// Dave, 2026-11-25: the EroScripts download record of the files, offered.
describe('the offer to forget the EroScripts download', () => {
  it('shown ticked with its words; its answer comes back with the choice; not shown: the answer as before', async () => {
    const rows = [{ path: 'C:/Lib/Clip.mp4', name: 'Clip.mp4', kind: 'video', size: 10, checked: true, locked: true, subject: true, sharedWith: [], outside: false }];
    let result = openDeleteDialog({ title: 't', intro: 'i', rows, platform: 'win32', forget: { label: 'Forget it', hint: 'Post A shows grey', checked: true } });
    const box = document.querySelector('.delete-files__forget-check');
    expect(box.checked).toBe(true);
    expect(document.querySelector('.delete-files__forget').textContent).toContain('Post A shows grey');
    box.click();                                                        // untick
    document.querySelector('.delete-files__go').click();
    expect(await result).toEqual({ paths: ['C:/Lib/Clip.mp4'], permanent: false, forget: false });
    result = openDeleteDialog({ title: 't', intro: 'i', rows, platform: 'win32' });
    expect(document.querySelector('.delete-files__forget')).toBeNull();
    [...document.querySelectorAll('.delete-files__go')].at(-1).click();
    expect(await result).toEqual({ paths: ['C:/Lib/Clip.mp4'], permanent: false });
  });
});
