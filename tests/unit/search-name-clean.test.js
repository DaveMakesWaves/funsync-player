/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// What the EroScripts searches type for a video (Dave, 2026-11-18: "searches
// might want to take into account that underscores may exist instead of
// spaces and there may be extra words in the search term than there is in
// the forum post title"). renderer/js/search-name-clean.js; the file names
// below are synthetic, shaped like the ones the 2026-11-18 tagging pass met.
import { describe, it, expect } from 'vitest';
import { cleanSearchName, fewerWordsQuery, searchWords } from '../../renderer/js/search-name-clean.js';

describe('cleanSearchName: the query a search starts with', () => {
  it.each([
    ['Some_Scene_Name.mp4', 'Some Scene Name'],
    ['Some.Scene.Name.1080p.mp4', 'Some Scene Name'],
    ['Alessa+Savage+Teaser.mp4', 'Alessa Savage Teaser'],
    ['Darcy - EPORNER 2023-05-12 (1).mp4', 'Darcy'],
    ['[Studio] Big Title Here 4k 60fps.mkv', 'Studio Big Title Here'],
    ['Long Title Here 3840x2160 2160p HQ.webm', 'Long Title Here'],
    ['My Scene - Part 2 [xvideos.com].mp4', 'My Scene Part 2'],
    ['Scene Name (Subbed) bunkr.mp4', 'Scene Name'],
    ['Scene from pornhub 720p (2).mp4', 'Scene from'],
    ['Dated 12.05.2023 Clip.mp4', 'Dated Clip'],
    ['D:/v/sub/Deep_Path_Name.mp4', 'Deep Path Name'],
    ['C:\\Lib\\Win Path.mp4', 'Win Path'],
  ])('%s -> %s', (name, query) => {
    expect(cleanSearchName(name)).toBe(query);
  });

  // v0.10.1: a slug-style name searched as one long word and found nothing
  // (the auto-match and the nav button searched the raw name, 2026-11-20).
  it.each([
    ['anna-claire-clouds-takes-on-a-mouthful-of-cum_1080p.mp4', 'anna claire clouds takes on a mouthful of cum'],
    ['AJVR-142-C_180_LR.mp4', 'AJVR 142 C 180 LR'],
    ['my-scene-part-2-4k.mp4', 'my scene part 2'],
    ['clip-name-2023-05-12.mp4', 'clip name'],
    ['clip-name-12-05-2023.mp4', 'clip name'],
    ['Kat Violet - Deep Throat.mp4', 'Kat Violet Deep Throat'],
    ['Zoë-Ångström-Scene.mp4', 'Zoë Ångström Scene'],
  ])('hyphens joining words: %s -> %s', (name, query) => {
    expect(cleanSearchName(name)).toBe(query);
  });

  it('keeps title words that only look like noise elsewhere, and a name that is all noise', () => {
    expect(cleanSearchName('Final Fantasy Raw Sub Training.mp4')).toBe('Final Fantasy Raw Sub Training');
    expect(cleanSearchName('Scene (1) Remastered.mp4')).toBe('Scene 1 Remastered');   // "(1)" only when trailing
    expect(cleanSearchName('1080p.mp4')).toBe('1080p');
    expect(cleanSearchName('')).toBe('');
    expect(cleanSearchName(null)).toBe('');
  });
});

describe('fewerWordsQuery: one shorter search per press', () => {
  it('5 meaningful words, then 3, then 2, then nothing shorter', () => {
    const steps = [];
    let q = 'The Girl Next Door Part Two With Jane Doe Extra';
    while (q) { steps.push(q); q = fewerWordsQuery(q); }
    expect(steps).toEqual([
      'The Girl Next Door Part Two With Jane Doe Extra',
      'Girl Next Door Part Two',
      'Girl Next Door',
      'Girl Next',
    ]);
  });

  it('noise does not count as a word; two words or fewer has no shorter form', () => {
    expect(fewerWordsQuery('Scene_Name_Here_Again 1080p mp4 bunkr')).toBe('Scene Name Here');
    expect(fewerWordsQuery('Two Words')).toBeNull();
    expect(fewerWordsQuery('the a an')).toBeNull();
    expect(fewerWordsQuery(undefined)).toBeNull();
  });

  it('searchWords leaves out noise but keeps everything else in order', () => {
    expect(searchWords('a_b.c+d 1080p E')).toEqual(['a', 'b', 'c', 'd', 'E']);
  });
});
