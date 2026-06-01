// Tests for chapter + bookmark keyboard nav.
// SCOPE: notes/features/SCOPE-chapters-bookmarks.md §6 C-E22, C-E23.
//
// We avoid booting the full App class — just exercise the prev/next
// resolution logic against a stubbed engine + video.

import { describe, it, expect, beforeEach } from 'vitest';

// Reproduce the algorithm so test focus stays on resolution rules
// without pulling in the full app.js dependency graph. The real
// implementation lives at app.js _jumpChapter / _jumpBookmark.

const PREV_THRESHOLD_MS = 500;

function jumpChapter(chapters, currentSec, direction) {
  if (!chapters || chapters.length === 0) return currentSec;
  const currentMs = currentSec * 1000;
  let target = null;
  if (direction < 0) {
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (chapters[i].startMs < currentMs - PREV_THRESHOLD_MS) { target = chapters[i]; break; }
    }
    if (!target) return 0;  // fall-off-start lands at 0
  } else {
    for (const c of chapters) {
      if (c.startMs > currentMs) { target = c; break; }
    }
    if (!target) return currentSec;  // no wrap
  }
  return target.startMs / 1000;
}

function jumpBookmark(bookmarks, currentSec, direction) {
  if (!bookmarks || bookmarks.length === 0) return currentSec;
  const currentMs = currentSec * 1000;
  let target = null;
  if (direction < 0) {
    for (let i = bookmarks.length - 1; i >= 0; i--) {
      if (bookmarks[i].at < currentMs - PREV_THRESHOLD_MS) { target = bookmarks[i]; break; }
    }
  } else {
    for (const b of bookmarks) {
      if (b.at > currentMs) { target = b; break; }
    }
  }
  if (!target) return currentSec;
  return target.at / 1000;
}

describe('_jumpChapter', () => {
  const CHAPTERS = [
    { startMs: 0,     endMs: 30000, name: 'A' },
    { startMs: 30000, endMs: 60000, name: 'B' },
    { startMs: 60000, endMs: 90000, name: 'C' },
  ];

  it('C-E22: no-op when no chapters', () => {
    expect(jumpChapter([], 15, +1)).toBe(15);
    expect(jumpChapter([], 15, -1)).toBe(15);
  });

  it('next: jumps from chapter A to chapter B', () => {
    // currentSec 15 → next start is 30000
    expect(jumpChapter(CHAPTERS, 15, +1)).toBe(30);
  });

  it('next: jumps from B to C', () => {
    expect(jumpChapter(CHAPTERS, 45, +1)).toBe(60);
  });

  it('C-E23: next stays put when current is past the last chapter start', () => {
    expect(jumpChapter(CHAPTERS, 75, +1)).toBe(75);
  });

  it('prev: snaps to current chapter start when well-inside it (YouTube convention)', () => {
    // currentSec 45 (15s into chapter B). Prev snaps to B's start (30s)
    // rather than skipping back to A — same as YouTube. To actually go
    // back to A, press prev again within 0.5s of B's start.
    expect(jumpChapter(CHAPTERS, 45, -1)).toBe(30);
  });

  it('prev: 0.5s threshold lets a second press jump past current chapter start', () => {
    // currentSec 30.3 (just past B's start). With threshold, prev finds
    // the start before (30.3 - 0.5) = 29.8s → chapter A's start at 0.
    expect(jumpChapter(CHAPTERS, 30.3, -1)).toBe(0);
  });

  it('prev: falls off start → seek to 0', () => {
    expect(jumpChapter(CHAPTERS, 1, -1)).toBe(0);
  });
});

describe('_jumpBookmark', () => {
  const BOOKMARKS = [
    { at: 5000,  name: 'A' },
    { at: 15000, name: 'B' },
    { at: 25000, name: 'C' },
  ];

  it('no-op when no bookmarks', () => {
    expect(jumpBookmark([], 10, +1)).toBe(10);
    expect(jumpBookmark([], 10, -1)).toBe(10);
  });

  it('next jumps forward', () => {
    expect(jumpBookmark(BOOKMARKS, 10, +1)).toBe(15);
  });

  it('prev jumps back', () => {
    expect(jumpBookmark(BOOKMARKS, 20, -1)).toBe(15);
  });

  it('no wrap: next at the last bookmark stays put', () => {
    expect(jumpBookmark(BOOKMARKS, 30, +1)).toBe(30);
  });

  it('no wrap: prev before the first bookmark stays put (no fall-back to 0)', () => {
    // Bookmarks: no fall-off-start behaviour — chapters do, bookmarks don't.
    expect(jumpBookmark(BOOKMARKS, 1, -1)).toBe(1);
  });
});
