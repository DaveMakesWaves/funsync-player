// Unit tests for fuzzy matching — imports from real source
import { describe, it, expect } from 'vitest';
import {
  normalize,
  tokenize,
  tokenOverlapScore,
  longestCommonSubstringLength,
  levenshteinScore,
  prefixScore,
  fuzzyMatchScore,
  rankFunscriptMatches,
} from '../../renderer/js/fuzzy-match.js';

describe('normalize', () => {
  it('strips extension and lowercases', () => {
    expect(normalize('MyVideo.mp4')).toBe('myvideo');
  });

  it('replaces underscores with spaces', () => {
    expect(normalize('my_cool_video.mkv')).toBe('my cool video');
  });

  it('replaces hyphens with spaces', () => {
    expect(normalize('my-cool-video.avi')).toBe('my cool video');
  });

  it('replaces dots in name with spaces', () => {
    expect(normalize('my.cool.video.mp4')).toBe('my cool video');
  });

  it('collapses multiple spaces', () => {
    expect(normalize('my__cool___video.mp4')).toBe('my cool video');
  });

  it('handles no extension', () => {
    expect(normalize('noextension')).toBe('noextension');
  });

  it('handles funscript extension', () => {
    expect(normalize('My_Video.funscript')).toBe('my video');
  });
});

describe('tokenize', () => {
  it('splits on spaces', () => {
    expect(tokenize('my cool video')).toEqual(['my', 'cool', 'video']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles single token', () => {
    expect(tokenize('video')).toEqual(['video']);
  });
});

describe('tokenOverlapScore', () => {
  it('returns 100 for identical token sets', () => {
    expect(tokenOverlapScore(['a', 'b'], ['a', 'b'])).toBe(100);
  });

  it('returns 0 for completely different sets', () => {
    expect(tokenOverlapScore(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('returns partial score for overlap', () => {
    // Jaccard: intersection=2, union=3 → 67
    expect(tokenOverlapScore(['a', 'b', 'c'], ['a', 'b'])).toBe(67);
  });

  it('returns 100 for two empty sets', () => {
    expect(tokenOverlapScore([], [])).toBe(100);
  });

  it('returns 0 when one set is empty', () => {
    expect(tokenOverlapScore(['a'], [])).toBe(0);
  });
});

describe('longestCommonSubstringLength', () => {
  it('finds exact match', () => {
    expect(longestCommonSubstringLength('abcdef', 'abcdef')).toBe(6);
  });

  it('finds substring', () => {
    expect(longestCommonSubstringLength('xxabcxx', 'yyabcyy')).toBe(3);
  });

  it('returns 0 for no common chars', () => {
    expect(longestCommonSubstringLength('abc', 'xyz')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(longestCommonSubstringLength('', 'abc')).toBe(0);
  });
});

describe('levenshteinScore', () => {
  it('returns 100 for identical strings', () => {
    expect(levenshteinScore('hello', 'hello')).toBe(100);
  });

  it('returns 0 for empty vs non-empty', () => {
    expect(levenshteinScore('', 'abc')).toBe(0);
  });

  it('returns high score for one char difference', () => {
    expect(levenshteinScore('hello', 'hallo')).toBe(80);
  });

  it('returns low score for very different strings', () => {
    expect(levenshteinScore('abc', 'xyz')).toBeLessThan(20);
  });
});

describe('prefixScore', () => {
  it('returns 100 for identical strings', () => {
    expect(prefixScore('abc', 'abc')).toBe(100);
  });

  it('returns high score when one contains the other', () => {
    expect(prefixScore('video', 'video extra')).toBeGreaterThan(40);
  });

  it('returns 0 for empty strings', () => {
    expect(prefixScore('', 'abc')).toBe(0);
  });

  it('rewards shared prefix', () => {
    expect(prefixScore('abcdef', 'abcxyz')).toBeGreaterThan(30);
  });
});

describe('fuzzyMatchScore', () => {
  it('returns 100 for identical filenames', () => {
    expect(fuzzyMatchScore('video.mp4', 'video.funscript')).toBe(100);
  });

  it('returns 100 for separator-only differences', () => {
    expect(fuzzyMatchScore('my_video.mp4', 'my-video.funscript')).toBe(100);
  });

  it('returns high score for one extra word', () => {
    const score = fuzzyMatchScore('cool video scene.mp4', 'cool video scene jane.funscript');
    expect(score).toBeGreaterThan(50);
  });

  it('returns low score for completely unrelated names', () => {
    const score = fuzzyMatchScore('vacation.mp4', 'cooking recipe.funscript');
    expect(score).toBeLessThan(20);
  });

  it('handles case differences', () => {
    expect(fuzzyMatchScore('MyVideo.mp4', 'myvideo.funscript')).toBe(100);
  });
});

describe('rankFunscriptMatches', () => {
  const funscripts = [
    { name: 'unrelated.funscript', path: '/fs/unrelated.funscript' },
    { name: 'cool_video.funscript', path: '/fs/cool_video.funscript' },
    { name: 'cool video extra.funscript', path: '/fs/cool video extra.funscript' },
  ];

  it('ranks exact match first', () => {
    const results = rankFunscriptMatches('cool_video.mp4', funscripts);
    expect(results[0].name).toBe('cool_video.funscript');
    expect(results[0].score).toBe(100);
  });

  it('sorts by descending score', () => {
    const results = rankFunscriptMatches('cool_video.mp4', funscripts);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('filters out below threshold', () => {
    const results = rankFunscriptMatches('cool_video.mp4', funscripts, 50);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(50);
    }
  });

  it('returns empty array when nothing matches', () => {
    const results = rankFunscriptMatches('zzz_unique.mp4', funscripts, 80);
    expect(results).toEqual([]);
  });

  it('includes path in results', () => {
    const results = rankFunscriptMatches('cool_video.mp4', funscripts);
    const exact = results.find((r) => r.name === 'cool_video.funscript');
    expect(exact.path).toBe('/fs/cool_video.funscript');
  });
});
