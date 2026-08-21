/**
 * @vitest-environment node
 * Pure string maths. See notes/CLAUDE.md "Test environments".
 */
// Realistic filename scenarios, from WinterReplicate (#286): "it kept trying
// to give me unrelated scripts in the associate menu", and Dave: "even when
// the script is a very near name match I have to manually browse folders".
//
// The old scorer failed four distinct ways, all reproduced here before the
// fix. Measured numbers from the original implementation are quoted on each
// case so a regression is recognisable rather than just red.
//
// WHY THESE ARE HARD: the Associate modal calls rankFunscriptMatches with
// threshold 0, so every script in the library is ranked and the top row is
// presented as the suggestion. Ranking quality IS the feature.
import { describe, it, expect } from 'vitest';
import { fuzzyMatchScore, rankFunscriptMatches, normalize } from '../../renderer/js/fuzzy-match.js';

/** Rank candidates and return the winning name. */
function topPick(video, names) {
  const ranked = rankFunscriptMatches(
    video,
    names.map((n) => ({ name: n, path: `/x/${n}` })),
    0,
  );
  return ranked[0]?.name;
}

describe('near-identical names must score decisively', () => {
  // Dave's complaint. These are the same file to any human, and used to
  // score 56-76 — never confident enough to feel like a match.
  const cases = [
    ['Scene Name.mp4', 'Scene Name (1).funscript', 'duplicate-download suffix (was 70)'],
    ['Cafe Rendezvous.mp4', 'Café Rendezvous.funscript', 'diacritics (was 56)'],
    ['Series Episode 2.mp4', 'Series Episode 02.funscript', 'zero-padded number (was 76)'],
    ['Scene Name.mp4', 'Scene_Name.funscript', 'separator differs'],
    ['Scene Name.mp4', 'scene name.funscript', 'case differs'],
  ];
  for (const [video, script, why] of cases) {
    it(`${why}`, () => {
      expect(fuzzyMatchScore(video, script)).toBeGreaterThanOrEqual(90);
    });
  }
});

describe('release tags must not outrank the title', () => {
  // Scripts are usually named for the scene; videos carry resolution, codec,
  // year and group. Those shared tags used to dominate every component of
  // the score at once.
  it('picks the scene-named script over one sharing every tag', () => {
    expect(topPick('Scene.Name.2024.1080p.WEB-DL.x265-GROUP.mp4', [
      'Scene.Other.2024.1080p.WEB-DL.x265-GROUP.funscript',  // scored 70
      'Scene Name.funscript',                                // scored 26
    ])).toBe('Scene Name.funscript');
  });

  it('picks the right scene when only the resolution tag differs', () => {
    expect(topPick('Studio Scene 4K.mp4', [
      'Studio Scene2 4K.funscript',      // scored 71
      'Studio Scene 1080p.funscript',    // scored 64
    ])).toBe('Studio Scene 1080p.funscript');
  });
});

describe('VR boilerplate must not dominate', () => {
  // The worst case, and the likeliest to be WinterReplicate's: every file in
  // a VR library shares SLR / studio / 1920p / 180x180 / 3dh / LR, so
  // unrelated scripts scored 32-57 against each other on noise alone and the
  // correct scene-named script came THIRD.
  it('ranks the scene-named script above same-studio neighbours', () => {
    expect(topPick('SLR_VRBangers_Beach_Day_1920p_180x180_3dh_LR.mp4', [
      'SLR_VRBangers_Hotel_Night_1920p_180x180_3dh_LR.funscript',   // scored 57
      'SLR_VRBangers_Yoga_Session_1920p_180x180_3dh_LR.funscript',  // scored 56
      'Beach Day.funscript',                                        // scored 22
    ])).toBe('Beach Day.funscript');
  });

  it('still prefers the exact filename when it is present', () => {
    const exact = 'SLR_VRBangers_Beach_Day_1920p_180x180_3dh_LR.funscript';
    expect(topPick('SLR_VRBangers_Beach_Day_1920p_180x180_3dh_LR.mp4', [
      'SLR_VRBangers_Hotel_Night_1920p_180x180_3dh_LR.funscript',
      exact,
    ])).toBe(exact);
  });
});

describe('numeric tokens', () => {
  // The sharpest failure: "Episode 3" (79) beat "Episode 02" (76) for a
  // video called "Episode 2", because 2→3 is one substitution while 2→02 is
  // an insertion that also breaks the token match. The app confidently
  // offered the WRONG episode.
  it('prefers the same episode over a neighbouring one', () => {
    expect(topPick('Series Episode 2.mp4', [
      'Series Episode 3.funscript',
      'Series Episode 02.funscript',
      'Series Episode 12.funscript',
    ])).toBe('Series Episode 02.funscript');
  });

  it('does not treat a different number as near-identical', () => {
    expect(fuzzyMatchScore('Series Episode 2.mp4', 'Series Episode 3.funscript'))
      .toBeLessThan(fuzzyMatchScore('Series Episode 2.mp4', 'Series Episode 02.funscript'));
  });
});

describe('cases that already worked must keep working', () => {
  it('exact match scores 100', () => {
    expect(fuzzyMatchScore('A Video.mp4', 'A Video.funscript')).toBe(100);
  });

  it('handles reordered words', () => {
    expect(topPick('Nicole Aniston - Office Seduction.mp4', [
      'Nicole Aniston - Pool Party.funscript',
      'Office Seduction - Nicole Aniston.funscript',
    ])).toBe('Office Seduction - Nicole Aniston.funscript');
  });

  it('does not match a too-generic single word', () => {
    expect(topPick('Amazing Long Descriptive Title With Lots Of Words 1080p.mp4', [
      'Amazing.funscript',
      'Amazing Long Descriptive Title With Lots Of Words.funscript',
    ])).toBe('Amazing Long Descriptive Title With Lots Of Words.funscript');
  });

  it('keeps genuinely unrelated files far apart', () => {
    expect(fuzzyMatchScore('Scene Name.mp4', 'Totally Different Thing.funscript'))
      .toBeLessThan(35);
  });

  it('normalize still strips the extension and separators', () => {
    expect(normalize('A_Video-Name.mp4')).toBe('a video name');
  });
});
