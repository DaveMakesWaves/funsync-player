/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Playlists component renders its detail view
 * (header buttons, video cards) and is clicked like a user would.
 */
// App test 2026-11-02, V29: a playlist's Loop flag reached only Play All.
// Continue (and clicking any video in the playlist) built a play context with
// no `loop`, and UpNextEngine wraps to item 1 only when the context says so,
// so the last video ended on "End of list" with Loop on. The Loop button's
// own title promises "restart from item 1 after the last video", with no
// Play-All-only caveat.
//
// These drive the real Playlists component and capture what it hands the
// player (`onPlayVideo`). The engine-side half (that a looping context then
// wraps and KEEPS going past item 1) is in up-next-queue-advance.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Playlists } from '../../renderer/components/playlists.js';

const A = 'D:\\PL\\A.mp4';
const B = 'D:\\PL\\B.mp4';
const C = 'D:\\PL\\C.mp4';

let playlist;
let settings;
let played;
let playlists;
let container;
let savedFunsync;

function makeSettings() {
  const store = {
    'library.playlistProgress': { p1: { lastVideoPath: C } },
    'library.resumePositions': { [C]: { position: 40, duration: 100, updatedAt: 1 } },
  };
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    getPlaylists: () => [playlist],
    getPlaylist: (id) => (id === playlist.id ? playlist : null),
    setPlaylistLoop: vi.fn((id, v) => { if (id === playlist.id) playlist.loop = !!v; }),
    setPlaylistShuffle: vi.fn((id, v) => { if (id === playlist.id) playlist.shuffle = !!v; }),
  };
}

beforeEach(() => {
  playlist = { id: 'p1', name: 'P', videoPaths: [A, B, C], loop: false, shuffle: false };
  settings = makeSettings();
  played = [];
  savedFunsync = window.funsync;
  window.funsync = {
    ...savedFunsync,
    filesExist: vi.fn(async (paths) => paths.map(() => true)),
    readFunscript: vi.fn(async () => null),
    getThumbnail: vi.fn(async () => null),
  };
  playlists = new Playlists({
    settings,
    library: { getVideoByPath: () => null },
    onPlayVideo: (fileData) => played.push(fileData),
    onPlayAll: vi.fn(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  playlists._container = container;
});

afterEach(() => {
  window.funsync = savedFunsync;
  container.remove();
  vi.restoreAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('V29: Continue carries the playlist\'s Loop flag', () => {
  it('with Loop on, Continue plays the marked video in a context that loops', async () => {
    playlist.loop = true;
    await playlists._continueFromLastWatched(playlist);
    await flush();

    expect(played).toHaveLength(1);
    expect(played[0].path).toBe(C);
    expect(played[0]._playContext).toMatchObject({
      source: 'playlist', sourceContext: { playlistId: 'p1' }, list: [A, B, C], index: 2, loop: true,
    });
  });

  it('with Loop off, the context does not loop', async () => {
    await playlists._continueFromLastWatched(playlist);
    await flush();
    expect(played[0]._playContext.loop).toBe(false);
  });
});

describe('V29: clicking a video in the playlist carries the Loop flag too, as it is NOW', () => {
  async function renderDetail() {
    playlists._view = 'detail';
    playlists._detailPlaylistId = playlist.id;
    await playlists._renderDetail(playlist.id);
    await flush();
  }

  function clickCard(path) {
    const name = path.split('\\').pop().replace(/\.[^.]+$/, '');
    const card = [...container.querySelectorAll('.playlists__video-card')]
      .find((el) => el.textContent.includes(name));
    expect(card, `no card for ${name}`).toBeTruthy();
    card.click();
  }

  it('Loop switched on in the header AFTER the cards rendered still loops', async () => {
    await renderDetail();
    const loopBtn = container.querySelector('.playlists__loop-btn:not(.playlists__shuffle-btn):not(.playlists__advanced-btn)');
    expect(loopBtn.getAttribute('aria-pressed')).toBe('false');
    loopBtn.click();
    expect(loopBtn.getAttribute('aria-pressed')).toBe('true');

    clickCard(C);
    await flush();

    expect(played.at(-1).path).toBe(C);
    expect(played.at(-1)._playContext).toMatchObject({ index: 2, loop: true });
  });

  it('a playlist without Loop stays a list that ends', async () => {
    await renderDetail();
    clickCard(B);
    await flush();
    expect(played.at(-1)._playContext).toMatchObject({ index: 1, loop: false });
  });
});
