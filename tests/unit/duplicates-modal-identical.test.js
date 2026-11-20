// FT-B01 (2026-11-05, new since v0.9.2): what "Select spares in Identical"
// actually ticks.
//
// jsdom (the default environment): the real DuplicatesModal renders into a
// real element and its real batch button is clicked. window.funsync is the
// preload bridge, stubbed with the answers the main process gives.
//
// Block A's sandbox: "Untagged Wide.mp4" and "VR Tagged_180_LR.mp4", both
// 720,304 bytes and 8 s but different videos, were one Identical group, and
// the batch button ticked the unscripted one for the Recycle Bin. The modal
// now asks the main process for a sampled content hash of every same-size
// file (and ONLY those), and Identical needs the hashes to match.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DuplicatesModal } from '../../renderer/components/duplicates-modal.js';
import { TIER } from '../../renderer/js/duplicate-finder.js';

const VIDEOS = [
  { path: 'C:/sb/Untagged Wide.mp4', name: 'Untagged Wide.mp4', duration: 8, hasFunscript: false },
  { path: 'C:/sb/VR Tagged_180_LR.mp4', name: 'VR Tagged_180_LR.mp4', duration: 8, hasFunscript: true },
  { path: 'C:/sb/Holiday.mp4', name: 'Holiday.mp4', duration: 30, hasFunscript: true },
  { path: 'C:/sb/zz_backup_7731.mp4', name: 'zz_backup_7731.mp4', duration: 30, hasFunscript: false },
  { path: 'C:/sb/Unique.mp4', name: 'Unique.mp4', duration: 50, hasFunscript: false },
];
const SIZES = {
  'C:/sb/Untagged Wide.mp4': { size: 720_304 },
  'C:/sb/VR Tagged_180_LR.mp4': { size: 720_304 },
  'C:/sb/Holiday.mp4': { size: 5000 },
  'C:/sb/zz_backup_7731.mp4': { size: 5000 },
  'C:/sb/Unique.mp4': { size: 999 },
};
const HASHES = {
  'C:/sb/Untagged Wide.mp4': { hash: 'aaaa' },
  'C:/sb/VR Tagged_180_LR.mp4': { hash: 'bbbb' },      // different bytes
  'C:/sb/Holiday.mp4': { hash: 'cccc' },
  'C:/sb/zz_backup_7731.mp4': { hash: 'cccc' },        // a renamed byte copy
};

let modal;
let origFunsync;

async function scan(funsync) {
  window.funsync = funsync;
  modal = new DuplicatesModal({ getVideos: () => VIDEOS });
  modal._body = document.createElement('div');
  document.body.appendChild(modal._body);
  await modal._scan();
  return modal;
}

function clickSelectTier(tier) {
  const btn = modal._body.querySelector(`[data-select-tier="${tier}"]`);
  if (btn) btn.click();
  return btn;
}

const ticked = () => [...modal._body.querySelectorAll('.duplicates__check')]
  .filter((cb) => cb.checked).map((cb) => cb.dataset.path).sort();

beforeEach(() => { origFunsync = window.funsync; });
afterEach(() => {
  window.funsync = origFunsync;
  document.body.innerHTML = '';
});

describe('Find duplicates: Identical needs matching content (FT-B01)', () => {
  it('hashes only the files that share a size, and Select spares in Identical ticks only the byte copy', async () => {
    const hashVideoFiles = vi.fn(async () => HASHES);
    await scan({ statVideoFiles: async () => SIZES, hashVideoFiles });

    expect(hashVideoFiles).toHaveBeenCalledTimes(1);
    expect([...hashVideoFiles.mock.calls[0][0]].sort()).toEqual([
      'C:/sb/Holiday.mp4', 'C:/sb/Untagged Wide.mp4', 'C:/sb/VR Tagged_180_LR.mp4', 'C:/sb/zz_backup_7731.mp4',
    ]);

    const identical = modal._groups.filter((g) => g.tier === TIER.IDENTICAL);
    expect(identical).toHaveLength(1);
    expect(identical[0].members.map((m) => m.path).sort()).toEqual(['C:/sb/Holiday.mp4', 'C:/sb/zz_backup_7731.mp4']);

    expect(clickSelectTier(TIER.IDENTICAL)).toBeTruthy();
    expect(ticked()).toEqual(['C:/sb/zz_backup_7731.mp4']);
    expect([...modal._selected]).toEqual(['C:/sb/zz_backup_7731.mp4']);
    // The different video of the same size and length is nowhere on screen
    // as a spare, so no button can tick it.
    expect(modal._body.querySelector('[data-path="C:/sb/Untagged Wide.mp4"]')).toBeNull();
    expect(modal._body.querySelector('[data-path="C:/sb/VR Tagged_180_LR.mp4"]')).toBeNull();
  });

  it('when hashing fails nothing is Identical and there is no Select spares in Identical button', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scan({
      statVideoFiles: async () => SIZES,
      hashVideoFiles: async () => { throw new Error('EBUSY'); },
    });
    warn.mockRestore();
    expect(modal._groups.some((g) => g.tier === TIER.IDENTICAL)).toBe(false);
    expect(modal._body.querySelector(`[data-select-tier="${TIER.IDENTICAL}"]`)).toBeNull();
    expect(ticked()).toEqual([]);
  });

  it('files the main process could not read (hash null) are never Identical', async () => {
    await scan({
      statVideoFiles: async () => SIZES,
      hashVideoFiles: async () => ({
        'C:/sb/Untagged Wide.mp4': { hash: null },
        'C:/sb/VR Tagged_180_LR.mp4': { hash: null },
        'C:/sb/Holiday.mp4': { hash: 'cccc' },
        'C:/sb/zz_backup_7731.mp4': { hash: null },
      }),
    });
    expect(modal._groups.some((g) => g.tier === TIER.IDENTICAL)).toBe(false);
  });

  it('nothing is ticked until a button is pressed', async () => {
    await scan({ statVideoFiles: async () => SIZES, hashVideoFiles: async () => HASHES });
    expect(ticked()).toEqual([]);
  });

  it('a library with no shared sizes never calls the hash IPC', async () => {
    const hashVideoFiles = vi.fn(async () => ({}));
    await scan({
      statVideoFiles: async () => ({
        'C:/sb/Untagged Wide.mp4': { size: 1 }, 'C:/sb/VR Tagged_180_LR.mp4': { size: 2 },
        'C:/sb/Holiday.mp4': { size: 3 }, 'C:/sb/zz_backup_7731.mp4': { size: 4 }, 'C:/sb/Unique.mp4': { size: 5 },
      }),
      hashVideoFiles,
    });
    expect(hashVideoFiles).not.toHaveBeenCalled();
  });

  it('the Identical reason line says content was compared (en and de)', async () => {
    const fs = await import('node:fs');
    const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
    const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
    const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
    const why = () => modal._body.querySelector(`.duplicates__tier-badge--${TIER.IDENTICAL}`)
      ?.closest('.duplicates__tier-head')?.querySelector('.duplicates__tier-why')?.textContent.trim();
    try {
      _setBundlesForTests('en', EN, EN);
      await scan({ statVideoFiles: async () => SIZES, hashVideoFiles: async () => HASHES });
      expect(why()).toBe('Same file size, length and content');
      document.body.innerHTML = '';
      _setBundlesForTests('de', DE, EN);
      await scan({ statVideoFiles: async () => SIZES, hashVideoFiles: async () => HASHES });
      expect(why()).toBe('Gleiche Dateigröße und Länge, gleicher Inhalt');
    } finally {
      _setBundlesForTests('en', {}, {});
    }
  });
});
