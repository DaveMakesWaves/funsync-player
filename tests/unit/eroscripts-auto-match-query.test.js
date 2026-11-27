/**
 * @vitest-environment jsdom
 * jsdom on purpose: the auto-match builds its "Script found" toast out of DOM
 * elements, and the test clicks its Get Script button (notes/CLAUDE.md
 * "Test environments").
 */
// v0.10.1, found recording the EroScripts OP clips (2026-11-20): a video opened
// with no script searched the forum for its RAW file name. A slug-style name,
// "anna-claire-clouds-takes-on-a-mouthful-of-cum_1080p", is one long word to
// the forum's search: 0 results, so no "Script found" toast, although the same
// words with spaces find the post first (15 results).
//
// The REAL `_autoMatchEroScripts` (lifted from app.js) with the REAL
// cleanSearchName and a fake search. Asserted: the words it searches for, and
// that the toast's Get Script opens the panel on that same query.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { cleanSearchName, titleMatchesQuery } from '../../renderer/js/search-name-clean.js';

const showToast = vi.fn();
const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const Lifted = liftAppClass(['_autoMatchEroScripts'], { showToast, t, cleanSearchName, titleMatchesQuery });

let app;
beforeEach(() => {
  vi.useFakeTimers();
  showToast.mockClear();
  window.funsync = {
    eroscriptsSearch: vi.fn(async (q) => ({
      results: q === 'anna claire clouds takes on a mouthful of cum' ? [{ id: 1, title: 'Anna Claire Clouds takes on a mouthful' }] : [],
    })),
  };
  app = Object.assign(new Lifted(), {
    funscriptEngine: { isLoaded: false },
    eroscriptsPanel: { isLoggedIn: true, setSearchQuery: vi.fn(), show: vi.fn(), handleSessionExpired: vi.fn() },
  });
});
afterEach(() => {
  vi.useRealTimers();
  delete window.funsync;
});

async function autoMatch(name) {
  const run = app._autoMatchEroScripts(name);
  await vi.advanceTimersByTimeAsync(2000);
  await run;
}

// Found 2026-11-22: the toast offered the search's FIRST result whatever it was ("Invert Test" got "A short
// animation about stamina training!"). Only a post whose title shares the video's words is offered.
describe('only a post that matches the video is offered', () => {
  it('an unrelated first result: no toast; a matching later result is the one offered', async () => {
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [{ id: 9, title: 'A short animation about stamina training!' }] }));
    await autoMatch('Invert Test.mp4');
    expect(showToast).not.toHaveBeenCalled();
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [
      { id: 9, title: 'A short animation about stamina training!' },
      { id: 10, title: 'Invert Test - full script' },
    ] }));
    await autoMatch('Invert Test.mp4');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0].textContent).toContain('Invert Test - full script');
  });

  it('titleMatchesQuery: more than half the 3+ letter words, hyphens and punctuation aside', () => {
    expect(titleMatchesQuery('Anna Claire Clouds - Takes-On A Mouthful!', 'anna claire clouds takes on a mouthful of cum')).toBe(true);
    expect(titleMatchesQuery('Kat Violet: deep throat compilation', 'Kat Violet Deep Throat')).toBe(true);
    expect(titleMatchesQuery('A short animation about stamina training!', 'Invert Test')).toBe(false);
    // Seen live (2026-11-22): one of two words is not enough.
    expect(titleMatchesQuery('BounceX - Anal Dildo Hero (Beta Test)', 'Invert Test')).toBe(false);
    expect(titleMatchesQuery('Anything at all', 'IT 2')).toBe(false);          // no word of 3+ letters: no offer
  });
});

describe('the auto-match searches the cleaned file name (v0.10.1)', () => {
  it('a slug-style name is searched as words; the toast offers the post and Get Script searches the same words', async () => {
    await autoMatch('anna-claire-clouds-takes-on-a-mouthful-of-cum_1080p.mp4');

    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('anna claire clouds takes on a mouthful of cum');
    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0][0];
    expect(toast.textContent).toContain('Anna Claire Clouds takes on a mouthful');

    toast.querySelector('button').click();
    expect(app.eroscriptsPanel.setSearchQuery).toHaveBeenCalledWith('anna claire clouds takes on a mouthful of cum', true);
    expect(app.eroscriptsPanel.show).toHaveBeenCalledTimes(1);
  });

  it('a name that already searched well is unchanged apart from the extension', async () => {
    await autoMatch('Kat Violet Deep Throat.mp4');
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('Kat Violet Deep Throat');
  });

  it('a script that arrived during the 2 s wait: no search at all (unchanged)', async () => {
    const run = app._autoMatchEroScripts('anna-claire-clouds_1080p.mp4');
    app.funscriptEngine.isLoaded = true;
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
  });
});
