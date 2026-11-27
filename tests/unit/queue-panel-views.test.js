/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL QueuePanel, KeyboardHandler, Library header,
 * Playlists/Categories headers, device panel (ConnectionPanel) and speed menu
 * render into a document and are clicked and keyed like a user would; the CSS
 * check runs queue-panel.css through jsdom's cascade.
 */
// The queue panel outside the player. App test 2026-11-02 (forum #381):
//
//   V26  Esc did not close the panel in any view; the Library header's
//        toggle read unpressed while the panel was open (the header is
//        rebuilt on every show() with a hard-coded aria-pressed="false");
//        and the Up Next countdown chip appeared twice when the next video
//        was also in History, with only the History copy counting down.
//   V27  Playlists and Categories had no queue toggle at all (Shift+Q was
//        the only way in), and Shift+Q there opened the panel at top:0 over
//        the nav bar, 100px short of the window bottom: the player's layout.
//
// Real app.js methods are lifted (helpers/app-methods.js) and wired to the
// real components. Assertions are on what the user sees: is the panel open,
// what does each toggle announce, which rows carry a chip and what it says,
// and where the panel sits.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
// _wireSpeedControl moves focus into its popover with these (menu-keys.js, 2026-11-25);
// without them each test that opened the speed menu threw an uncaught ReferenceError.
import { wireMenuKeys, moveMenuFocus, focusMenuFromKeyboard } from '../../renderer/js/menu-keys.js';
import { QueuePanel } from '../../renderer/components/queue-panel.js';
import { KeyboardHandler } from '../../renderer/js/keyboard.js';
import { Library } from '../../renderer/components/library.js';
import { Playlists } from '../../renderer/components/playlists.js';
import { Categories } from '../../renderer/components/categories.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const A = 'D:\\Lib\\A.mp4';
const B = 'D:\\Lib\\B.mp4';
const C = 'D:\\Lib\\C.mp4';
const D = 'D:\\Lib\\D.mp4';

// The REAL KeyboardHandler would bind to `document` for good, so it binds
// nothing and one pair of listeners forwards to the current test's handler.
class TestKeyboardHandler extends KeyboardHandler { _bindEvents() {} }
let keys = null;
document.addEventListener('keydown', (e) => keys?._onKeyDown(e));
function press(key, target = document.body) {
  // cancelable like a real key press, so a handler's preventDefault() shows.
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

let Lifted;
let app;
let panelEl;

beforeAll(() => {
  Lifted = liftAppClass([
    '_toggleQueuePanel', '_syncQueueToggles', '_positionQueuePanelForView', '_applyQueueDock', '_toggleQueueDock',
    '_updateQueuePanelState', '_getUpcoming', '_keyboardOptions', '_currentView',
    '_wireSpeedControl',
  ], { document, window, eventBus: { on() {} }, PLAYBACK_RATE_PRESETS: [0.5, 1, 1.5], wireMenuKeys, moveMenuFocus, focusMenuFromKeyboard });
});

function settingsFake(extra = {}) {
  const map = new Map(Object.entries(extra));
  return {
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    getPlaylists: () => [],
    getPlaylist: () => null,
    getCategories: () => [],
    getCategory: () => null,
    getVideosByCategory: () => [],
  };
}

function view(id) {
  document.getElementById('app').dataset.view = id;
  app._navStack = [id];
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="app" data-view="player">
      <div id="library-container"></div>
      <div id="playlists-container"></div>
      <div id="categories-container"></div>
      <div id="player-container">
        <button id="btn-queue-toggle" class="player__queue-toggle" aria-pressed="false" aria-expanded="false"></button>
      </div>
      <aside id="queue-panel"></aside>
    </div>`;
  panelEl = document.getElementById('queue-panel');
  app = Object.assign(new Lifted(), {
    _navStack: ['player'],
    _queueHistory: [],
    _userQueue: [],
    _playQueue: [],
    _playQueueIndex: -1,
    _currentVideoPath: A,
    _currentPlayContext: null,
    videoPlayer: { video: { volume: 0.5 }, clearAbLoop: vi.fn(), togglePlay: vi.fn() },
    connectionPanel: { hide: vi.fn() },
    _playerWindowPlayback: () => false,
  });
  app.queuePanel = new QueuePanel({
    element: panelEl,
    library: null,
    settings: settingsFake(),
    onClose: () => app._toggleQueuePanel(),
  });
  keys = new TestKeyboardHandler(app._keyboardOptions());
});

afterEach(() => {
  keys = null;
  vi.restoreAllMocks();
});

const toggles = () => [...document.querySelectorAll('#btn-queue-toggle, [data-queue-toggle]')];
const pressedStates = () => toggles().map((b) => b.getAttribute('aria-pressed'));

describe('V26: Esc closes the queue panel', () => {
  it('Esc closes an open panel, and that press leaves the A-B loop alone', () => {
    app._toggleQueuePanel();
    expect(app.queuePanel.visible).toBe(true);

    press('Escape');

    expect(app.queuePanel.visible).toBe(false);
    expect(app.videoPlayer.clearAbLoop).not.toHaveBeenCalled();
    expect(pressedStates()).toEqual(['false']);
  });

  it('with focus on a row inside the panel', () => {
    app._updateQueuePanelState = function () {
      this.queuePanel.setState({ history: [], nowPlaying: A, userQueue: [B], upcoming: [], hasContext: true });
    };
    app._toggleQueuePanel();
    const row = panelEl.querySelector('.queue-panel__row');
    row.focus();

    press('Escape', row);

    expect(app.queuePanel.visible).toBe(false);
  });

  it('with the panel already closed, Esc does what it always did', () => {
    press('Escape');
    expect(app.videoPlayer.clearAbLoop).toHaveBeenCalledTimes(1);
    expect(app.connectionPanel.hide).toHaveBeenCalledTimes(1);
  });

  it('an Up Next card on screen is dismissed first; the next Esc closes the panel', () => {
    app._toggleQueuePanel();
    const engine = { visible: true, dismiss: vi.fn(() => { engine.visible = false; }) };
    keys.upNextEngine = engine;

    press('Escape');
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
    expect(app.queuePanel.visible).toBe(true);

    press('Escape');
    expect(app.queuePanel.visible).toBe(false);
  });

  // A surface on top that takes the Esc (calls preventDefault) closes itself
  // and nothing else: the queue panel under it stays open.
  it('Esc inside the open device panel closes that panel, not the queue under it', () => {
    app._toggleQueuePanel();
    const settings = settingsFake();
    const devices = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings });
    devices.show();
    // Focus on a tab, not the key input (keyboard.js ignores keys typed in inputs).
    const tab = devices._panel.querySelector('.connection-panel__tab--active');
    tab.focus();

    press('Escape', tab);

    expect(devices._panel.hidden).toBe(true);
    expect(app.queuePanel.visible).toBe(true);
    expect(pressedStates()).toEqual(['true']);
  });

  it('Esc with the speed menu open closes the menu, not the queue under it', () => {
    document.getElementById('player-container').insertAdjacentHTML('beforeend', `
      <button id="btn-overflow" aria-expanded="false"></button>
      <div id="controls-overflow-menu" hidden><button id="btn-speed-menu"><span id="speed-menu-current"></span></button></div>
      <button id="speed-chip" hidden><span id="speed-chip-label"></span></button>
      <div id="speed-popover" hidden></div>`);
    app.videoPlayer.setPlaybackRate = vi.fn();
    app._wireSpeedControl();
    app._toggleQueuePanel();
    document.getElementById('btn-speed-menu').click();
    const popover = document.getElementById('speed-popover');
    expect(popover.hidden).toBe(false);

    press('Escape', popover.querySelector('button'));

    expect(popover.hidden).toBe(true);
    expect(app.queuePanel.visible).toBe(true);
    // The next Esc, with nothing else on top, closes the queue.
    press('Escape');
    expect(app.queuePanel.visible).toBe(false);
  });
});

// FT-072 (also in v0.9.2): the Esc that closed a menu or a panel also
// cleared the A-B loop. With the queue panel closed (or open), a surface on
// top that takes the Esc closes itself and nothing else; the next Esc clears
// the loop as it always did.
describe('FT-072: Esc that closes a menu or panel keeps the A-B loop', () => {
  function speedMenu() {
    document.getElementById('player-container').insertAdjacentHTML('beforeend', `
      <button id="btn-overflow" aria-expanded="false"></button>
      <div id="controls-overflow-menu" hidden><button id="btn-speed-menu"><span id="speed-menu-current"></span></button></div>
      <button id="speed-chip" hidden><span id="speed-chip-label"></span></button>
      <div id="speed-popover" hidden></div>`);
    app.videoPlayer.setPlaybackRate = vi.fn();
    app._wireSpeedControl();
    document.getElementById('btn-speed-menu').click();
    const popover = document.getElementById('speed-popover');
    expect(popover.hidden).toBe(false);
    return popover;
  }

  it('speed menu open: Esc closes it and the loop stays; the next Esc clears the loop', () => {
    const popover = speedMenu();

    press('Escape', popover.querySelector('button'));

    expect(popover.hidden).toBe(true);
    expect(app.videoPlayer.clearAbLoop).not.toHaveBeenCalled();
    press('Escape');
    expect(app.videoPlayer.clearAbLoop).toHaveBeenCalledTimes(1);
  });

  it('device panel open: Esc closes it and the loop stays; the next Esc clears the loop', () => {
    const devices = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });
    devices.show();
    const tab = devices._panel.querySelector('.connection-panel__tab--active');
    tab.focus();

    press('Escape', tab);

    expect(devices._panel.hidden).toBe(true);
    expect(app.videoPlayer.clearAbLoop).not.toHaveBeenCalled();
    press('Escape');
    expect(app.videoPlayer.clearAbLoop).toHaveBeenCalledTimes(1);
  });

  // verify-1 (2026-11-07): opened with H while the panel last showed another
  // tab, show() focused the Handy key input on the HIDDEN Handy tab. In
  // Chromium that focus() fails silently, so the focus stayed on <body>, the
  // panel never saw the Esc and keyboard.js cleared the loop as it closed it.
  for (const tabId of ['autoblow', 'tcode', 'buttplug', 'sync']) {
    it(`device panel opened on the ${tabId} tab: focus moves into it, and Esc keeps the loop`, () => {
      const devices = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });
      devices._switchTab(tabId);
      document.body.focus();
      devices.show(); // what H does: no click, no explicit focus

      const focused = document.activeElement;
      expect(devices._panel.contains(focused)).toBe(true);
      expect(focused.closest('[hidden]')).toBeNull(); // focusable on screen, not on the Handy tab
      expect(focused.dataset.tab).toBe(tabId);

      press('Escape', focused);
      expect(devices._panel.hidden).toBe(true);
      expect(app.videoPlayer.clearAbLoop).not.toHaveBeenCalled();
    });
  }

  it('device panel opened on the Handy tab still focuses the connection key', () => {
    const devices = new ConnectionPanel({ handyManager: { on() {}, off() {} }, settings: settingsFake() });
    devices.show();
    expect(document.activeElement.id).toBe('connection-key-input');
  });

  it('with the queue panel open under the speed menu: one layer per Esc (menu, queue, loop)', () => {
    app._toggleQueuePanel();
    const popover = speedMenu();

    press('Escape', popover.querySelector('button'));
    expect(popover.hidden).toBe(true);
    expect(app.queuePanel.visible).toBe(true);
    expect(app.videoPlayer.clearAbLoop).not.toHaveBeenCalled();

    press('Escape');
    expect(app.queuePanel.visible).toBe(false);
    expect(app.videoPlayer.clearAbLoop).not.toHaveBeenCalled();

    press('Escape');
    expect(app.videoPlayer.clearAbLoop).toHaveBeenCalledTimes(1);
  });
});

describe('V26: every queue toggle says whether the panel is open', () => {
  function showLibraryHeader() {
    const lib = new Library({
      settings: settingsFake(),
      onToggleQueue: () => app._toggleQueuePanel(),
      isQueueOpen: () => !!app.queuePanel?.visible,
    });
    // Header-only render: the pickers and chips are not under test.
    lib._renderBreadcrumb = () => {};
    lib._buildSortPicker = () => {};
    lib._buildFiltersPicker = () => {};
    lib._renderFilterChips = () => {};
    lib._syncSortForActiveTab = () => {};
    lib._container = document.getElementById('library-container');
    lib._renderWithHeader();
    return lib;
  }

  it('a panel opened in the player shows as pressed on the Library header rebuilt after it', () => {
    app._toggleQueuePanel(); // Shift+Q in the player
    view('library');
    showLibraryHeader();

    const libToggle = document.querySelector('.library__queue-toggle');
    expect(libToggle.getAttribute('aria-pressed')).toBe('true');
    expect(libToggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('closing it un-presses every toggle on the page, the Library one included', () => {
    view('library');
    showLibraryHeader();
    document.querySelector('.library__queue-toggle').click();
    expect(pressedStates()).toEqual(['true', 'true']);

    document.querySelector('.queue-panel__close').click();

    expect(app.queuePanel.visible).toBe(false);
    expect(pressedStates()).toEqual(['false', 'false']);
  });
});

describe('V26: the countdown chip sits on the one row that will play next', () => {
  const chips = () => [...panelEl.querySelectorAll('[data-queue-auto-count]')];
  const chipRow = (chip) => chip.closest('.queue-panel__row').dataset.queueKind;

  function openWith(state) {
    app._updateQueuePanelState = function () { this.queuePanel.setState(state); };
    app._toggleQueuePanel();
  }

  it('a looping playlist\'s next video is also in History: one chip, on Up next, and it counts', () => {
    openWith({ history: [A], nowPlaying: B, userQueue: [], upcoming: [C, A], hasContext: true });

    app.queuePanel.setAutoAdvanceCountdown(A, 3);
    expect(chips().map(chipRow)).toEqual(['upcoming']);
    expect(chips()[0].textContent).toBe('3s');

    app.queuePanel.setAutoAdvanceCountdown(A, 2); // a tick
    expect(chips().map((c) => c.textContent)).toEqual(['2s']);
  });

  it('the next video is the head of your queue AND in Up next: the chip is on your queue', () => {
    openWith({ history: [], nowPlaying: A, userQueue: [D], upcoming: [B, D], hasContext: true });
    app.queuePanel.setAutoAdvanceCountdown(D, 5);
    expect(chips().map(chipRow)).toEqual(['user-queue']);
  });

  it('the same video twice in a row: the chip is on the next one, not Now playing', () => {
    openWith({ history: [], nowPlaying: A, userQueue: [], upcoming: [A, B], hasContext: true });
    app.queuePanel.setAutoAdvanceCountdown(A, 4);
    expect(chips().map(chipRow)).toEqual(['upcoming']);
  });
});

describe('V27: the queue opens from Playlists and Categories, below their header', () => {
  function playlistsView() {
    view('playlists');
    const pls = new Playlists({
      settings: settingsFake(),
      library: null,
      onPlayVideo: () => {},
      onPlayAll: () => {},
      onToggleQueue: () => app._toggleQueuePanel(),
      isQueueOpen: () => !!app.queuePanel?.visible,
    });
    pls.show(document.getElementById('playlists-container'));
    return pls;
  }

  function categoriesView() {
    view('categories');
    const cats = new Categories({
      settings: settingsFake(),
      library: null,
      onPlayVideo: () => {},
      onToggleQueue: () => app._toggleQueuePanel(),
      isQueueOpen: () => !!app.queuePanel?.visible,
    });
    cats.show(document.getElementById('categories-container'));
    return cats;
  }

  it('the Playlists header has a queue toggle that opens the panel and shows it pressed', () => {
    playlistsView();
    const toggle = document.querySelector('#playlists-container .playlists__header [data-queue-toggle]');
    expect(toggle).toBeTruthy();
    // The same label as the Library header's and the player's toggle.
    expect(toggle.getAttribute('aria-label')).toBe('Toggle queue panel');

    toggle.click();

    expect(app.queuePanel.visible).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('the Categories header has one too', () => {
    categoriesView();
    const toggle = document.querySelector('#categories-container .categories__header [data-queue-toggle]');
    expect(toggle).toBeTruthy();
    toggle.click();
    expect(app.queuePanel.visible).toBe(true);
  });

  it('a Playlists header rebuilt while the panel is open (grid -> detail) renders pressed', () => {
    app._toggleQueuePanel();
    playlistsView();
    expect(document.querySelector('#playlists-container [data-queue-toggle]').getAttribute('aria-pressed')).toBe('true');
  });

  it('opened in Playlists, the panel is anchored below the Playlists header', () => {
    playlistsView();
    const header = document.querySelector('#playlists-container .playlists__header');
    header.getBoundingClientRect = () => ({ top: 64, bottom: 118, left: 0, right: 0, width: 0, height: 54 });

    app._toggleQueuePanel(); // Shift+Q

    expect(panelEl.style.getPropertyValue('--queue-lib-top')).toBe('118px');
  });

  it('opened in Categories, below the Categories header; back in the player, the player layout', () => {
    categoriesView();
    const header = document.querySelector('#categories-container .categories__header');
    header.getBoundingClientRect = () => ({ top: 64, bottom: 121, left: 0, right: 0, width: 0, height: 57 });
    app._toggleQueuePanel();
    expect(panelEl.style.getPropertyValue('--queue-lib-top')).toBe('121px');

    view('player');
    app._positionQueuePanelForView();
    expect(panelEl.style.getPropertyValue('--queue-lib-top')).toBe('');
  });

  it('queue-panel.css gives every browse view the full-height layout, and the player its own', () => {
    const style = document.createElement('style');
    style.textContent = fs.readFileSync('renderer/styles/queue-panel.css', 'utf8');
    document.head.appendChild(style);
    try {
      const bottomIn = (id) => {
        document.getElementById('app').dataset.view = id;
        return getComputedStyle(panelEl).bottom;
      };
      expect(bottomIn('library')).toMatch(/^0(px)?$/);
      expect(bottomIn('playlists')).toMatch(/^0(px)?$/);
      expect(bottomIn('categories')).toMatch(/^0(px)?$/);
      // 100 px above the control bar, plus the TL / HM strip's height when
      // it sits under the video and lifts the bar (0 otherwise; 2026-11-23).
      expect(bottomIn('player')).toBe('calc(100px + var(--inline-viz-band-root, 0px))');
    } finally {
      style.remove();
    }
  });
});

// R4-03 (2026-11-06, cosmetic): with the queue panel open the Up Next card
// was drawn UNDER the panel (only the "U" of "UP NEXT" showed). The rule that
// meant to hide it, `.player-container:has(.queue-panel--open) .up-next`,
// never matched: the panel is the player container's sibling. The card now
// sits left of the panel. jsdom's cascade runs the real stylesheets against
// the real structure (the panel a sibling, then inside the player in
// fullscreen); jsdom does no layout, so the pixels were measured in a
// headless Electron window (no overlap at 1280, 1920 and 900 px wide).
describe('R4-03: the Up Next card sits left of the open queue panel', () => {
  let style;
  let card;
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = fs.readFileSync('renderer/styles/queue-panel.css', 'utf8')
      + fs.readFileSync('renderer/styles/up-next.css', 'utf8');
    document.head.appendChild(style);
    card = document.createElement('div');
    card.id = 'up-next-card';
    card.className = 'up-next';
    const player = document.getElementById('player-container');
    player.classList.add('player-container'); // as index.html has it
    player.appendChild(card);
  });
  afterEach(() => style.remove());

  const right = () => getComputedStyle(card).right.replace(/\s+/g, '');

  it('panel closed: the card in its corner', () => {
    expect(right()).toBe('20px');
    expect(getComputedStyle(card).display).not.toBe('none');
  });

  it('panel open: the card moves left by the panel width, still shown', () => {
    panelEl.classList.add('queue-panel--open');
    expect(right()).toBe('calc(var(--queue-panel-width,360px)+20px)');
    expect(getComputedStyle(card).display).not.toBe('none');
  });

  it('fullscreen (the panel moved into the player container): the same', () => {
    document.getElementById('player-container').appendChild(panelEl);
    panelEl.classList.add('queue-panel--open');
    expect(right()).toBe('calc(var(--queue-panel-width,360px)+20px)');
  });

  it('the mini player\'s corner strip stays where it is', () => {
    panelEl.classList.add('queue-panel--open');
    document.getElementById('player-container').classList.add('player-container--mini');
    expect(right()).toBe('8px');
  });
});

// zaikechi #381 (2026-11-22): the queue docked beside the video, which gets smaller. The panel's own dock
// button; the choice is saved; only in the player view while the panel is open.
describe('the queue docked beside the video (#381)', () => {
  function dockedApp(saved) {
    const settings = settingsFake({ 'player.queueDocked': saved });
    app.settings = settings;
    app.queuePanel = new QueuePanel({
      element: panelEl,
      library: null,
      settings,
      onClose: () => app._toggleQueuePanel(),
      isDocked: () => settings.get('player.queueDocked') === true,
      onToggleDock: () => app._toggleQueueDock(),
    });
    return settings;
  }
  const docked = () => document.getElementById('app').classList.contains('app--queue-docked');
  const dockBtn = () => panelEl.querySelector('.queue-panel__dock');

  it('the dock button docks it and says so; a second press floats it again; the choice is saved', () => {
    const settings = dockedApp(false);
    app._toggleQueuePanel();
    expect(docked()).toBe(false);
    expect(dockBtn().getAttribute('aria-pressed')).toBe('false');
    dockBtn().focus();
    dockBtn().click();
    expect(settings.get('player.queueDocked')).toBe(true);
    expect(docked()).toBe(true);
    expect(dockBtn().getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(dockBtn());           // the redraw keeps the focus on it
    dockBtn().click();
    expect(settings.get('player.queueDocked')).toBe(false);
    expect(docked()).toBe(false);
  });

  it('docked is only while the panel is open, and only in the player view', () => {
    dockedApp(true);
    expect(docked()).toBe(false);
    app._toggleQueuePanel();                                    // open
    expect(docked()).toBe(true);
    app._toggleQueuePanel();                                    // closed: the video gets its width back
    expect(docked()).toBe(false);
    app._toggleQueuePanel();
    view('library');
    app._positionQueuePanelForView();                           // what a view change runs while it is open
    expect(docked()).toBe(false);
    view('player');
    app._positionQueuePanelForView();
    expect(docked()).toBe(true);
  });

  it('the CSS gives the video and the strip the width the panel does not take, and hides the button outside the player', () => {
    const css = fs.readFileSync('renderer/styles/queue-panel.css', 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/#app\.app--queue-docked \.player-container:not\(\.player-container--mini\) \.player__video-wrapper \{\n  width: calc\(100% - var\(--queue-panel-width\)\);/);
    expect(css).toMatch(/#app\.app--queue-docked \.player-container:not\(\.player-container--mini\) \.inline-viz \{\n  right: var\(--queue-panel-width\);/);
    expect(css).toMatch(/#app:not\(\[data-view="player"\]\) \.queue-panel__dock \{\n  display: none;/);
    expect(fs.readFileSync('electron/store.js', 'utf8')).toMatch(/queueDocked: false,/);
  });
});
