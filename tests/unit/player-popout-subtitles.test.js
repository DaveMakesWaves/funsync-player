/**
 * @vitest-environment jsdom
 *
 * The detached player window showed no subtitles at all (found R4-05 by
 * reading, probably also in v0.9.2; fixed 2026-11-22). The main player now
 * reports every subtitle load and clear (`onSubtitlesChanged`), app.js sends
 * them to an open pop-out (SUBTITLE) and again with every video it hands over,
 * and the pop-out loads them into its own player.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { VideoPlayer } from '../../renderer/js/video-player.js';
import * as PLAYERWIN from '../../renderer/js/player-popout-protocol.js';
import { liftAppClass } from './helpers/app-methods.js';

const SRT = '1\r\n00:00:00,000 --> 00:00:10,000\r\nPOPOUT SUBTITLE TEST\r\n';

describe('the main player says when its subtitles change', () => {
  let player;
  let seen;
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="player-container">
        <video id="video"></video>
        <div id="center-play-btn">
          <span class="center-play__icon--play"></span>
          <span class="center-play__icon--pause"></span>
          <span class="center-play__icon--replay" hidden></span>
        </div>
        <div id="player-controls">
          <button id="btn-play">
            <span class="icon-play"></span>
            <span class="icon-pause"></span>
            <span class="icon-replay" hidden></span>
          </button>
          <button id="btn-mute"><span class="icon-volume"></span><span class="icon-muted"></span></button>
          <input id="volume-slider" type="range" min="0" max="100" value="80" />
          <button id="btn-fullscreen"><span class="icon-expand"></span><span class="icon-compress"></span></button>
          <button id="btn-pip"></button>
          <span id="time-current">0:00</span>
          <span id="time-duration">0:00</span>
          <div id="progress-container" role="slider" aria-valuenow="0">
            <div id="buffered-bar"></div>
            <div id="progress-bar"></div>
            <div id="progress-thumb"></div>
            <div id="progress-tooltip"><span id="tooltip-time"></span></div>
          </div>
        </div>
        <span id="subtitle-badge" hidden></span>
      </div>
    `;
  
    // jsdom has no blob URLs.
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => {};
    player = new VideoPlayer({
      videoElement: document.getElementById('video'),
      controlsElement: document.getElementById('player-controls'),
      containerElement: document.getElementById('player-container'),
    });
    seen = [];
    player.onSubtitlesChanged = (sub) => seen.push(sub);
  });

  it('a load reports the file as read (an .srt before its conversion); a clear reports null', async () => {
    await player.loadSubtitles({ name: 'Clip.srt', textContent: SRT });
    expect(seen.at(-1)).toEqual({ name: 'Clip.srt', text: SRT, show: true });
    player.clearSubtitles();
    expect(seen.at(-1)).toBeNull();
  });

  it('a track loaded switched off (an embedded one not marked default, #268) says so', async () => {
    await player.loadSubtitles({ name: 'English.vtt', textContent: 'WEBVTT\n' }, { show: false });
    expect(seen.at(-1)).toEqual({ name: 'English.vtt', text: 'WEBVTT\n', show: false });
  });
});

describe('app.js sends them to an open pop-out', () => {
  let sent;
  let app;
  beforeEach(() => {
    sent = [];
    const Lifted = liftAppClass(['_sendPlayerWindowSubtitle'], {
      window: { funsync: { playerPopoutRelay: (dir, msg) => sent.push(msg) } },
      PLAYERWIN,
    });
    app = new Lifted();
  });

  it('the current subtitles, or { name: null } for none; nothing while no pop-out is open', () => {
    app._currentSubtitle = { name: 'Clip.srt', text: SRT };
    app._sendPlayerWindowSubtitle();
    expect(sent).toEqual([]);
    app._playerWindowOpen = true;
    app._sendPlayerWindowSubtitle();
    expect(sent.at(-1)).toEqual({ type: PLAYERWIN.SUBTITLE, name: 'Clip.srt', text: SRT, show: true });
    // Loaded switched off in the main window: off in the pop-out too (#268).
    app._currentSubtitle = { name: 'English.vtt', text: 'WEBVTT\n', show: false };
    app._sendPlayerWindowSubtitle();
    expect(sent.at(-1)).toEqual({ type: PLAYERWIN.SUBTITLE, name: 'English.vtt', text: 'WEBVTT\n', show: false });
    app._currentSubtitle = null;
    app._sendPlayerWindowSubtitle();
    expect(sent.at(-1)).toEqual({ type: PLAYERWIN.SUBTITLE, name: null });
  });

  it('wired at start-up, and sent again with every video handed over', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/this\.videoPlayer\.onSubtitlesChanged = \(sub\) => \{\n\s+this\._currentSubtitle = sub \|\| null;\n\s+this\._sendPlayerWindowSubtitle\(\);/);
    const stream = src.slice(src.indexOf('  _streamPlayerWindowData() {'));
    expect(stream.slice(0, 600)).toContain('this._sendPlayerWindowSubtitle?.();');
    expect(PLAYERWIN.ALL_MESSAGE_TYPES).toContain(PLAYERWIN.SUBTITLE);
  });
});

describe('the pop-out\'s CC button (full manual test, 2026-11-23)', () => {
  // A blank square that did nothing: the main window gives its badge the
  // Captions icon and a toggle (app.js), the pop-out never did. Checked live:
  // icon shown, "Toggle subtitles", a click hides the track, another shows it.
  it('gets the Captions icon, a button role and label, and switches the NEWEST track on and off', () => {
    const src = fs.readFileSync('renderer/player-popout.js', 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/Activity, Thermometer, Captions, icon,\n\} from '\.\/js\/icons\.js';/);
    expect(src).toMatch(/containerElement: containerEl,\n {2}\}\);\n {2}wireSubtitleButton\(\);/);
    const fn = src.slice(src.indexOf('function wireSubtitleButton()'), src.indexOf('// --- build the reused player once i18n is ready ---'));
    expect(fn).toContain("badge.appendChild(icon(Captions, { width: 20, height: 20, 'stroke-width': 1.75 }));");
    expect(fn).toContain("badge.setAttribute('role', 'button');");
    expect(fn).toContain("badge.setAttribute('data-i18n-aria-label', 'app.toggleSubtitles');");
    expect(fn).toContain("if (!showing) tracks[tracks.length - 1].mode = 'showing';");
    expect(fn).toMatch(/addEventListener\('keydown'/);
  });
});

describe('the pop-out loads them into its own player', () => {
  it('SUBTITLE with a file loads it; { name: null } clears', () => {
    const src = fs.readFileSync('renderer/player-popout.js', 'utf8').replace(/\r\n/g, '\n');
    const handler = src.slice(src.indexOf('    case SUBTITLE:'), src.indexOf('    case SUBTITLE:') + 400);
    expect(handler).toMatch(/videoPlayer\?\.loadSubtitles\(\{ name: payload\.name, textContent: payload\.text \}, \{ show: payload\.show !== false \}\)/);
    expect(handler).toMatch(/videoPlayer\?\.clearSubtitles\(\)/);
  });
});
