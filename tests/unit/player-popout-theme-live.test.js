/**
 * @vitest-environment jsdom
 *
 * The player pop-out follows a theme, style or Holiday change while it is
 * open (found 2026-11-22 checking Holiday with the pop-outs open; also in
 * v0.10.0). It only ever got the look in INITIAL_STATE, so Dark / Light,
 * Modern or Holiday chosen with it open left it as it was. theme-manager
 * writes data-theme / data-style / data-season on <html> for every cause,
 * and app.js sends THEME when they change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import * as AUDIENCE from '../../renderer/js/audience-popout-protocol.js';
import { liftAppClass } from './helpers/app-methods.js';

let sent;
let roomSent;
let app;
const Lifted = liftAppClass(['_wirePlayerWindowTheme', '_sendPlayerWindowTheme', '_sendAudienceTheme', '_pushAudienceMessage'], {
  document,
  window: { funsync: {
    playerPopoutRelay: (dir, msg) => sent.push([dir, msg]),
    audiencePopoutRelay: (dir, msg) => roomSent.push([dir, msg]),
  } },
  PLAYERWIN,
  AUDIENCE,
});
const settle = () => new Promise((r) => setTimeout(r, 0));   // MutationObserver records arrive as a microtask

beforeEach(() => {
  sent = [];
  roomSent = [];
  const d = document.documentElement;
  d.dataset.theme = 'dark';
  d.dataset.style = 'classic';
  delete d.dataset.season;
  app = new Lifted();
  app._wirePlayerWindowTheme();
});
// Disconnected here, so a failing case never leaves its observer sending into the next one.
afterEach(() => app._themeObserver?.disconnect());

describe('the Audience room window follows too (it handled THEME; nothing sent it)', () => {
  it('with the Audience bridge up, Holiday reaches the room window', async () => {
    app.audienceBridge = {};
    document.documentElement.dataset.style = 'modern';
    document.documentElement.dataset.season = 'holiday';
    await settle();
    expect(roomSent.at(-1)).toEqual(['to-popout', { type: AUDIENCE.THEME, theme: 'dark', uiStyle: 'modern', season: 'holiday' }]);
  });
});

describe('a look change reaches an open player pop-out', () => {
  it('Holiday, then Classic, then Light: each sends THEME with the new look', async () => {
    app._playerWindowOpen = true;
    const d = document.documentElement;
    d.dataset.style = 'modern';
    d.dataset.season = 'holiday';
    await settle();
    expect(sent.at(-1)).toEqual(['to-popout', { type: PLAYERWIN.THEME, theme: 'dark', uiStyle: 'modern', season: 'holiday' }]);
    d.dataset.style = 'classic';
    delete d.dataset.season;
    await settle();
    expect(sent.at(-1)).toEqual(['to-popout', { type: PLAYERWIN.THEME, theme: 'dark', uiStyle: 'classic', season: null }]);
    d.dataset.theme = 'light';
    await settle();
    expect(sent.at(-1)[1].theme).toBe('light');
  });

  it('with no pop-out open nothing is sent', async () => {
    document.documentElement.dataset.theme = 'light';
    await settle();
    expect(sent).toEqual([]);
  });

  it('another attribute on <html> sends nothing', async () => {
    app._playerWindowOpen = true;
    document.documentElement.setAttribute('lang', 'fr');
    await settle();
    expect(sent).toEqual([]);
  });
});
