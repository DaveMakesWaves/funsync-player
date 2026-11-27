/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL bar, the REAL "Scripts without a video" dialog
 * (a REAL Modal) and the player's pill are DOM (notes/CLAUDE.md "Test
 * environments").
 */
// The script player's UI (v0.10.1). Asserted: which scripts the Library
// menu's list shows, what Play and Pair… do, what the bar shows and does, the
// player's pill and its "Use this video's script", that X and Z do not take
// over from it, and that a funscript dropped with no video open plays on its
// own while one dropped onto an open video still loads into it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { looseScripts } = await import('../../renderer/js/loose-scripts.js');
const { showLooseScriptsDialog, matchVideos, folderOf } = await import('../../renderer/components/loose-scripts-dialog.js');
const { ScriptPlayerBar, formatClock, actionWindow, positionAt, GRAPH_HALF_MS } = await import('../../renderer/components/script-player-bar.js');
const { isPlayableFunscript } = await import('../../renderer/js/script-player.js');
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  document.documentElement.classList.remove('has-script-bar');
  showToast.mockClear();
});

describe('looseScripts: the scripts no video uses (Filters > Scripts; Pair with a video…)', () => {
  const unmatched = [
    { name: 'Loop A.funscript', path: 'C:\\L\\Loop A.funscript' },
    { name: 'Loop A.twist.funscript', path: 'C:\\L\\Loop A.twist.funscript' },       // an axis file: not on its own
    { name: 'Paired By Hand.funscript', path: 'C:\\L\\Paired By Hand.funscript' },   // a hand pairing uses it
    { name: 'Variant.funscript', path: 'c:/l/variant.funscript' },                    // a variant uses it (other case/slashes)
    { name: 'notes.txt', path: 'C:\\L\\notes.txt' },
  ];
  const videos = [
    { name: 'V1.mp4', path: 'C:\\L\\V1.mp4', funscriptPath: 'C:\\L\\Paired By Hand.funscript' },
    { name: 'V2.mp4', path: 'C:\\L\\V2.mp4', variants: [{ path: 'C:\\L\\Variant.funscript' }] },
  ];
  it('keeps the playable ones nothing uses', () => {
    expect(looseScripts(unmatched, videos).map((s) => s.name)).toEqual(['Loop A.funscript']);
    expect(looseScripts(null, null)).toEqual([]);
  });
  it('helpers: video search by every word; the folder line', () => {
    const vids = [{ name: 'Kat Violet Deep Throat.mp4', path: 'a' }, { name: 'Kat Other.mp4', path: 'b' }];
    expect(matchVideos(vids, 'kat deep').map((v) => v.path)).toEqual(['a']);
    expect(matchVideos(vids, '  ')).toEqual([]);
    expect(folderOf('C:\\L\\sub\\x.funscript')).toBe('C:\\L\\sub');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

describe('the dialog: Play and Pair…', () => {
  const scripts = [{ name: 'Loop A.funscript', path: 'C:\\L\\Loop A.funscript' }, { name: 'Loop B.funscript', path: 'C:\\L\\Loop B.funscript' }];
  const videos = [{ name: 'Kat Violet Deep Throat.mp4', path: 'C:\\L\\kat.mp4' }];

  it('Play closes the dialog and plays that script', async () => {
    const onPlay = vi.fn();
    const closed = showLooseScriptsDialog({ scripts, videos, onPlay, onPair: vi.fn() });
    await vi.waitFor(() => expect(document.querySelectorAll('.loose-scripts__row')).toHaveLength(2));
    expect(document.querySelector('.modal-title').textContent).toBe(EN.scriptPlayer.looseTitle);
    expect(document.querySelector('.loose-scripts__count').textContent).toBe('2 scripts no video uses');
    document.querySelectorAll('.loose-scripts__play')[1].click();
    await closed;
    expect(onPlay).toHaveBeenCalledWith(scripts[1]);
    expect(document.querySelector('.loose-scripts__row')).toBeNull();
  });

  it('Pair…: find a video, pick it; the row goes and the count follows', async () => {
    const onPair = vi.fn(() => true);
    showLooseScriptsDialog({ scripts, videos, onPlay: vi.fn(), onPair });
    await vi.waitFor(() => expect(document.querySelectorAll('.loose-scripts__row')).toHaveLength(2));
    const row = document.querySelectorAll('.loose-scripts__row')[0];
    row.querySelector('.loose-scripts__pair').click();
    const input = row.querySelector('.loose-scripts__find');
    expect(row.querySelector('.loose-scripts__finder').hidden).toBe(false);
    input.value = 'nothing like it';
    input.dispatchEvent(new Event('input'));
    expect(row.querySelector('.loose-scripts__none').textContent).toBe(EN.scriptPlayer.noVideoMatches);
    input.value = 'kat deep';
    input.dispatchEvent(new Event('input'));
    row.querySelector('.loose-scripts__match').click();
    expect(onPair).toHaveBeenCalledWith('C:\\L\\kat.mp4', scripts[0]);
    expect(document.querySelectorAll('.loose-scripts__row')).toHaveLength(1);
    expect(document.querySelector('.loose-scripts__count').textContent).toBe('1 script no video uses');
    document.querySelector('.modal-close-btn').click();
  });

  // Test day 2026-11-26, T310 (B095): opened for one script from its card's
  // "Pair with a video…", the dialog stayed open and empty after the pair.
  it('opened for one script: paired, it closes (the full list stays open as before)', async () => {
    const closed = showLooseScriptsDialog({ scripts: [scripts[0]], videos, onPlay: vi.fn(), onPair: vi.fn(() => true), closeWhenEmpty: true });
    await vi.waitFor(() => expect(document.querySelectorAll('.loose-scripts__row')).toHaveLength(1));
    const row = document.querySelector('.loose-scripts__row');
    row.querySelector('.loose-scripts__pair').click();
    const input = row.querySelector('.loose-scripts__find');
    input.value = 'kat deep';
    input.dispatchEvent(new Event('input'));
    row.querySelector('.loose-scripts__match').click();
    await closed;
    expect(document.querySelector('.loose-scripts__count')).toBeNull();
  });

  it('none left: it says so', async () => {
    showLooseScriptsDialog({ scripts: [], videos, onPlay: vi.fn(), onPair: vi.fn() });
    await vi.waitFor(() => expect(document.querySelector('.loose-scripts__count')).toBeTruthy());
    expect(document.querySelector('.loose-scripts__count').textContent).toBe(EN.scriptPlayer.looseEmpty);
    document.querySelector('.modal-close-btn').click();
  });
});

describe('the bar\'s stroke graph: what it shows around the playhead', () => {
  const acts = [{ at: 0, pos: 15 }, { at: 4000, pos: 15 }, { at: 4500, pos: 85 }, { at: 8500, pos: 85 }, { at: 9000, pos: 15 }, { at: 20000, pos: 15 }];
  it('the actions in the window, one either side so the lines run off the edges', () => {
    expect(actionWindow(acts, 4200, 8800)).toEqual([1, 4]);
    expect(actionWindow(acts, -5000, 1000)).toEqual([0, 1]);
    expect(actionWindow([], 0, 1)).toEqual([0, -1]);
    expect(GRAPH_HALF_MS).toBe(5000);
  });
  it('the position now, between actions', () => {
    expect(positionAt(acts, 4250)).toBe(50);
    expect(positionAt(acts, 6000)).toBe(85);
    expect(positionAt(acts, -1)).toBe(15);
    expect(positionAt(acts, 99999)).toBe(15);
    expect(positionAt([], 0)).toBeNull();
  });
});

describe('the bar', () => {
  function fakePlayer(state) {
    return {
      state: { active: true, name: 'Loop A.funscript', path: 'C:\\L\\Loop A.funscript', duration: 120, time: 30, paused: false, loop: false, devices: ['handy'], ...state },
      engine: { getActions: () => [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
      toggle: vi.fn(), setLoop: vi.fn(), seek: vi.fn(),
    };
  }

  it('shows while a script plays, takes room at the bottom, and each control does its job', () => {
    vi.useFakeTimers();
    const sp = fakePlayer();
    const onClose = vi.fn();
    const bar = new ScriptPlayerBar({ scriptPlayer: sp, onClose });
    bar.update(sp.state);
    const el = document.querySelector('.script-bar');
    expect(el.hidden).toBe(false);
    expect(document.documentElement.classList.contains('has-script-bar')).toBe(true);
    expect(el.querySelector('.script-bar__name').textContent).toBe('Loop A');   // shown without .funscript
    expect(el.querySelector('.script-bar__time').textContent).toBe('0:30 / 2:00');
    expect(el.querySelector('.script-bar__play').getAttribute('aria-label')).toBe(EN.scriptPlayer.pause);
    expect(el.querySelector('.script-bar__devices').textContent).toBe(EN.scriptPlayer.devicesOn);
    expect(el.querySelector('.script-bar__loop').getAttribute('aria-pressed')).toBe('false');

    el.querySelector('.script-bar__play').click();
    expect(sp.toggle).toHaveBeenCalled();
    el.querySelector('.script-bar__loop').click();
    expect(sp.setLoop).toHaveBeenCalledWith(true);
    const seek = el.querySelector('.script-bar__seek');
    seek.value = '500';
    seek.dispatchEvent(new Event('change'));
    expect(sp.seek).toHaveBeenCalledWith(60);
    el.querySelector('.script-bar__close').click();
    expect(onClose).toHaveBeenCalled();

    sp.state = { ...sp.state, time: 31.4 };
    vi.advanceTimersByTime(260);
    expect(el.querySelector('.script-bar__time').textContent).toBe('0:31 / 2:00');

    bar.update({ ...sp.state, active: false });
    expect(el.hidden).toBe(true);
    expect(document.documentElement.classList.contains('has-script-bar')).toBe(false);
    vi.useRealTimers();
  });

  it('no device connected: it says so', () => {
    const sp = fakePlayer({ devices: [], paused: true });
    const bar = new ScriptPlayerBar({ scriptPlayer: sp, onClose: vi.fn() });
    bar.update(sp.state);
    expect(document.querySelector('.script-bar__devices').textContent).toBe(EN.scriptPlayer.noDevices);
    expect(document.querySelector('.script-bar__play').getAttribute('aria-label')).toBe(EN.scriptPlayer.play);
  });
});

describe('app.js: the pill, X and Z, playing a file, a drop', () => {
  const PILL = `<div id="player-script-pill" hidden><span id="player-script-pill-text"></span><button id="btn-script-pill-use-video"></button></div>`;

  it('the pill says what the devices follow and offers this video\'s script', () => {
    document.body.innerHTML = `<div id="app"></div>${PILL}`;
    const Lifted = liftAppClass(['_onScriptPlayerChange'], { t });
    const app = Object.assign(new Lifted(), { scriptPlayerBar: { update: vi.fn() } });
    app._onScriptPlayerChange({ active: true, name: 'Loop A.funscript' });
    expect(document.getElementById('player-script-pill').hidden).toBe(false);
    expect(document.getElementById('player-script-pill-text').textContent).toBe('Devices: following “Loop A.funscript”');
    expect(document.getElementById('btn-script-pill-use-video').textContent).toBe(EN.scriptPlayer.useVideoScript);
    app._onScriptPlayerChange({ active: false });
    expect(document.getElementById('player-script-pill').hidden).toBe(true);
  });

  it('X and Z say why they do nothing while the script player holds the devices', () => {
    const Lifted = liftAppClass(['_onOrgasmHold', '_onEdgeHold'], { t, showToast });
    const app = Object.assign(new Lifted(), { orgasmSwitch: { active: false }, scriptPlayer: { active: true } });
    app._onOrgasmHold(true);
    app._onEdgeHold(true);
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith(EN.scriptPlayer.xzUnavailable, 'info', 4000);
  });

  it('_playScriptOnly: a funscript starts the script player; anything else says it cannot, and changes nothing', async () => {
    const Lifted = liftAppClass(['_playScriptOnly'], { t, showToast, isPlayableFunscript });
    const start = vi.fn(async () => true);
    const app = Object.assign(new Lifted(), { scriptPlayer: { start, state: { devices: ['handy'] } } });
    const good = { name: 'a.funscript', text: async () => '{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}]}' };
    expect(await app._playScriptOnly({ name: 'a.funscript', file: good })).toBe(true);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.funscript' }));
    const bad = { name: 'b.funscript', text: async () => 'oops' };
    expect(await app._playScriptOnly({ name: 'b.funscript', file: bad })).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenLastCalledWith('Couldn\'t play b.funscript: it isn\'t a funscript, or it can\'t be read.', 'error', 5000);
  });

  it('a funscript dropped with no video open plays on its own; onto an open video it loads into it, as before', async () => {
    const Lifted = liftAppClass(['_dragDropOptions'], { t, showToast });
    const app = Object.assign(new Lifted(), {
      scriptPlayer: {},
      _playScriptOnly: vi.fn(async () => true),
      loadFunscript: vi.fn(),
      _editorAllowsReplace: () => true,
      _hasOpenVideo: () => false,
      videoPlayer: { loadSubtitles: vi.fn() },
    });
    const file = { name: 'drop.funscript', path: 'C:\\D\\drop.funscript' };
    await app._dragDropOptions().onFunscriptFile(file);
    expect(app._playScriptOnly).toHaveBeenCalledWith({ name: 'drop.funscript', path: 'C:\\D\\drop.funscript', file });
    expect(app.loadFunscript).not.toHaveBeenCalled();

    app._hasOpenVideo = () => true;
    await app._dragDropOptions().onFunscriptFile(file);
    expect(app.loadFunscript).toHaveBeenCalledWith(file);
    expect(app._playScriptOnly).toHaveBeenCalledTimes(1);
  });
});
