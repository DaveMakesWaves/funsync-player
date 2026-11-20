/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL UpNextCard paints into a real element, and
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// CB-13 (2026-11-05, found verifying block B; also in v0.9.2): the End-of-list
// card read "No more videos in this FT034 Two." The sentence was written for a
// kind word ("this playlist"), and Play All hands it the playlist's NAME. The
// other contexts hand it labels that are not names either: 'playlist "X"' and
// 'category "X"' from a card click, 'library' from a library click, all in
// English whatever the language.
//
// What runs is REAL: app.js's `_wireUpNextUI` (the engine -> card wiring),
// `_upNextListName` and `_setUpNextContext`, lifted out of app.js, the REAL
// UpNextEngine and the REAL UpNextCard over the shipped English bundle. A
// fake player sits in the last seconds of the last video of each list.
// Asserted: the sentence the card shows.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { UpNextEngine } from '../../renderer/js/up-next.js';
import { UpNextCard } from '../../renderer/components/up-next-card.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const B = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));

const A = 'D:\\Lib\\Alpha.mp4';
const Z = 'D:\\Lib\\Zulu.mp4';
const PLAYLIST = { id: 'pl-two', name: 'FT034 Two' };
const CATEGORY = { id: 'cat-1', name: 'Favourites' };

let Lifted;
let app;
let playlists;

beforeAll(() => {
  _setBundlesForTests('en', B.en, B.en);
  Lifted = liftAppClass(['_wireUpNextUI', '_upNextListName', '_setUpNextContext', '_syncUpNextSuppression', '_relayUpNext'], {
    document,
    window,
    UpNextCard,
    t,
    PLAYERWIN,
  });
});
afterAll(() => _setBundlesForTests('en', B.en, B.en));

beforeEach(() => {
  document.body.innerHTML = '<div id="up-next-card" hidden></div><div id="gap-skip-overlay"></div>';
  playlists = [{ ...PLAYLIST }];
  const video = new EventTarget();
  Object.assign(video, { currentTime: 118, duration: 120, paused: false, ended: false, loop: false });
  const videoPlayer = {
    video,
    get currentTime() { return video.currentTime; },
    get duration() { return video.duration; },
    get paused() { return video.paused; },
    get ended() { return video.ended; },
  };
  app = Object.assign(new Lifted(), {
    videoPlayer,
    settings: {
      get: (k) => (k === 'player.upNext' ? { mode: 'auto', countdownSec: 10 } : undefined),
      getPlaylist: (id) => playlists.find((p) => p.id === id) || null,
      getCategories: () => [{ ...CATEGORY }],
    },
    library: null,
    queuePanel: null,
    scriptEditor: null,
    _userQueue: [],
    _playerWindowActive: false,
  });
  app.upNextEngine = new UpNextEngine({ videoPlayer, funscriptEngine: { isLoaded: false, getActions: () => [] } });
  app._wireUpNextUI();
});

/** Play the last video of `ctx` near its end: what does the card say? */
function endOfList(ctx) {
  app._currentPlayContext = { list: [A, Z], index: 1, ...ctx };
  app._setUpNextContext(app._currentPlayContext);
  app.upNextEngine.check();
  expect(app.upNextEngine.endOfListShown).toBe(true);
  return document.querySelector('#up-next-card .up-next__end-text')?.textContent;
}

describe('CB-13: the End-of-list card names the list that ended', () => {
  it('Play All of a playlist: the playlist\'s name, in the sentence written for a name', () => {
    expect(endOfList({ source: 'queue', sourceLabel: 'FT034 Two', sourceContext: { kind: 'playlist', id: PLAYLIST.id } }))
      .toBe(t('upNext.endText', { source: 'FT034 Two' }));
  });

  it('a playlist card click: the name, not the context label \'playlist "FT034 Two"\'', () => {
    const text = endOfList({ source: 'playlist', sourceLabel: 'playlist "FT034 Two"', sourceContext: { playlistId: PLAYLIST.id } });
    expect(text).toBe(t('upNext.endText', { source: 'FT034 Two' }));
    expect(text).not.toContain('playlist "');
  });

  it('a playlist renamed while it played is named as it is now', () => {
    playlists[0].name = 'Evening';
    expect(endOfList({ source: 'queue', sourceLabel: 'FT034 Two', sourceContext: { kind: 'playlist', id: PLAYLIST.id } }))
      .toBe(t('upNext.endText', { source: 'Evening' }));
  });

  it('a category, by Play All or a card click: the category\'s name', () => {
    const want = t('upNext.endText', { source: 'Favourites' });
    expect(endOfList({ source: 'queue', sourceLabel: 'Favourites', sourceContext: { kind: 'category', id: CATEGORY.id } })).toBe(want);
    expect(endOfList({ source: 'category', sourceLabel: 'category "Favourites"', sourceContext: { categoryId: CATEGORY.id } })).toBe(want);
  });

  it('the library: "Library" in the user\'s language, not the code word \'library\'', () => {
    expect(endOfList({ source: 'library', sourceLabel: 'library', sourceContext: {} }))
      .toBe(t('upNext.endText', { source: t('nav.library') }));
    expect(endOfList({ source: 'queue', sourceLabel: 'Pinned', sourceContext: { kind: 'library-shuffle' } }))
      .toBe(t('upNext.endText', { source: 'Pinned' }));
  });

  it('a list with no name (a deleted playlist) says "this list"', () => {
    playlists.length = 0;
    expect(endOfList({ source: 'queue', sourceLabel: 'FT034 Two', sourceContext: { kind: 'playlist', id: PLAYLIST.id } }))
      .toBe(t('upNext.endTextGeneric'));
  });

  // These two read the shipped bundles: they pass once the strings stage has
  // applied this item's handoff (strings-playback.json, upNext.endText changed
  // and upNext.endTextGeneric new, in all 8 locales).
  it('the English sentence reads naturally with a name', () => {
    const text = t('upNext.endText', { source: 'FT034 Two' });
    expect(text).toContain('FT034 Two');
    expect(text).not.toMatch(/\bthis FT034 Two\b/i);
  });

  it('"this list" exists in every language, and every language keeps the name whole', () => {
    for (const l of LOCALES) {
      expect(typeof B[l].upNext?.endTextGeneric, l).toBe('string');
      // ICU MessageFormat: an ASCII apostrophe next to {source} would quote it out.
      expect(B[l].upNext.endText, l).toContain('{source}');
      expect(B[l].upNext.endText, l).not.toMatch(/'\{source\}|\{source\}'/);
    }
  });
});
