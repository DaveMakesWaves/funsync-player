/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library opens the REAL Associate Funscript
 * dialog (Modal) into the document, and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// CB-17 (2026-11-05, found verifying block B; also in v0.9.2): the Associate
// Funscript dialog said "No funscripts found in directory. Use Browse." with
// 14 .funscript files next to the video. It offered only the library's
// UNMATCHED scripts that fuzzy-match the video's name; one unmatched script
// with another name ('Assoc Test.funscript' next to 'Square OU.mp4') and
// thirteen paired to other videos made "none found".
//
// Now: when nothing matches the name, every script in the video's own
// folder is listed, by name in natural order, under a line saying none
// matches; "No funscripts found" stays for a folder that has none. What is
// asserted is the dialog the user sees and what picking a row saves.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Library, funscriptsInFolderOf } from '../../renderer/components/library.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DIR = 'C:\\Sandbox\\library\\';
const SQUARE = { name: 'Square OU.mp4', path: `${DIR}Square OU.mp4`, hasFunscript: false, funscriptPath: null };
const script = (name, dir = DIR) => ({ name, path: `${dir}${name}` });
// Thirteen paired to other videos, one unmatched with an unrelated name.
const PAIRED = ['Alpha Scene', 'Clip 10', 'Clip 2', 'bravo take', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliet', 'Kilo'].map((n) => script(`${n}.funscript`));
const UNMATCHED = script('Assoc Test.funscript');
const ELSEWHERE = script('Square OU.funscript', 'C:\\Sandbox\\other\\');

let lib;
let store;

beforeAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.body.innerHTML = '';
  store = { 'library.associations': {} };
  lib = new Library({ settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } } });
  lib._videos = [SQUARE];
});

afterEach(() => {
  document.querySelector('.modal-close-btn')?.click();
});

/** Open Associate Funscript on Square OU; return the single-script pane. */
async function openDialog() {
  const done = lib._associateFunscript(SQUARE, null);
  await new Promise((r) => setTimeout(r, 0));
  const pane = document.querySelector('.modal-body .library__assoc-panel');
  return { done, pane };
}
const rowNames = (pane) => [...pane.querySelectorAll('.modal-list-item .modal-list-item-label')].map((el) => el.textContent);

describe('CB-17: Associate Funscript with scripts in the folder but none named like the video', () => {
  it('lists every script in the video\'s folder, by name, under a line saying none matches', async () => {
    lib._allFunscripts = [...PAIRED, UNMATCHED, ELSEWHERE];
    lib._unmatchedFunscripts = [UNMATCHED, ELSEWHERE].filter((s) => s !== ELSEWHERE);
    const { pane } = await openDialog();

    expect(pane.textContent).not.toContain(t('library.assoc.noFunscripts'));
    expect(pane.querySelector('.library__assoc-no-name-match')?.textContent).toBe(t('library.assoc.noNameMatch'));
    expect(rowNames(pane)).toEqual([
      'Alpha Scene.funscript', 'Assoc Test.funscript', 'bravo take.funscript', 'Charlie.funscript',
      'Clip 2.funscript', 'Clip 10.funscript', 'Delta.funscript', 'Echo.funscript', 'Foxtrot.funscript',
      'Golf.funscript', 'Hotel.funscript', 'India.funscript', 'Juliet.funscript', 'Kilo.funscript',
    ]); // 14, natural order, nothing from another folder
  });

  it('picking one associates it, as picking a match does', async () => {
    lib._allFunscripts = [...PAIRED, UNMATCHED];
    lib._unmatchedFunscripts = [UNMATCHED];
    const { done, pane } = await openDialog();
    const row = [...pane.querySelectorAll('.modal-list-item')].find((r) => r.textContent === 'Assoc Test.funscript');
    // The save itself is the one a ranked match goes through.
    let picked = null;
    lib._applyAssociation = (video, _cardEl, path, name) => { picked = { video: video.path, path, name }; };
    row.click();
    await done;
    expect(picked).toEqual({ video: SQUARE.path, path: UNMATCHED.path, name: 'Assoc Test.funscript' });
  });

  it('a name match still shows the ranked matches, as before', async () => {
    const match = script('Square OU (1).funscript');
    lib._allFunscripts = [...PAIRED, match];
    lib._unmatchedFunscripts = [match];
    const { pane } = await openDialog();
    expect(pane.querySelector('.library__assoc-no-name-match')).toBeNull();
    expect(rowNames(pane)).toEqual(['Square OU (1).funscript']);
    expect(pane.querySelector('.library__match-score')).not.toBeNull();
  });

  // R4 fix-up (real-app verifier 2, cosmetic): on a video whose own
  // `<video>.funscript` is paired (and current), the dialog said "No script
  // here is named like this video" over a list holding exactly that script.
  // The paired script is not in the unmatched list the ranking reads.
  it.each([
    ['its own same-name script', 'Square OU.funscript'],
    ['a variant of it', 'Square OU.soft.funscript'],
  ])('a folder holding %s (paired, so not ranked): the list, without the "none named like it" line', async (_label, name) => {
    const own = script(name);
    lib._allFunscripts = [...PAIRED, own];
    lib._unmatchedFunscripts = [];
    const { pane } = await openDialog();
    expect(pane.querySelector('.library__assoc-no-name-match')).toBeNull();
    expect(pane.textContent).not.toContain(t('library.assoc.noNameMatch'));
    expect(rowNames(pane)).toContain(name);
    expect(rowNames(pane)).toHaveLength(14);
  });

  it('a script merely starting with the video\'s name is not "named like it": the line stays', async () => {
    const other = script('Square OUTRO.funscript');
    lib._allFunscripts = [...PAIRED, other];
    lib._unmatchedFunscripts = [];
    const { pane } = await openDialog();
    expect(pane.querySelector('.library__assoc-no-name-match')?.textContent).toBe(t('library.assoc.noNameMatch'));
  });

  it('a folder with no scripts at all still says "No funscripts found"', async () => {
    lib._allFunscripts = [ELSEWHERE];
    lib._unmatchedFunscripts = [];
    const { pane } = await openDialog();
    expect(pane.textContent).toContain(t('library.assoc.noFunscripts'));
    expect(rowNames(pane)).toEqual([]);
  });
});

describe('funscriptsInFolderOf', () => {
  it('only the video\'s own folder, not its subfolders; any separator or case; one row per file', () => {
    const scripts = [
      script('b.funscript'), script('a.funscript', 'c:/sandbox/LIBRARY/'),
      script('deeper.funscript', `${DIR}sub\\`), script('b.funscript'),
    ];
    expect(funscriptsInFolderOf(SQUARE.path, scripts).map((s) => s.name)).toEqual(['a.funscript', 'b.funscript']);
    expect(funscriptsInFolderOf('', scripts)).toEqual([]);
    expect(funscriptsInFolderOf(SQUARE.path, null)).toEqual([]);
  });
});
