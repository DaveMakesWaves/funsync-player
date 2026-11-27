/**
 * @vitest-environment jsdom
 * jsdom: the tile is DOM; i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// S033 (Dave, 2026-11-26: "Show the audio tile instead"): an audio file played
// over a plain black screen. The player shows the library's audio tile over
// the black: right after the <video> (so the centre play button and the
// controls stay above it), clicks passing through.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { setPlayerAudioTile } from '../../renderer/js/player-audio-tile.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { liftAppClass } from './helpers/app-methods.js';
import { describeVideoCodec, hasRealVideoStream } from '../../renderer/js/video-load-check.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const CSS = fs.readFileSync('renderer/styles/player.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let wrapper;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="video-wrapper" class="player__video-wrapper"><video id="video"></video><button id="center-play-btn"></button></div>';
  wrapper = document.getElementById('video-wrapper');
});
const tile = () => wrapper.querySelector('.player__audio-tile');

describe('the player\'s audio tile', () => {
  it('shows the library tile with the title and the "Audio" chip, right after the <video>', () => {
    setPlayerAudioTile(wrapper, 'Airport Lounge.mp3');
    expect(tile()).not.toBeNull();
    expect(tile().previousElementSibling.tagName).toBe('VIDEO');
    expect(tile().nextElementSibling.id).toBe('center-play-btn'); // the play button stays above it
    expect(tile().querySelector('.library__thumb-novideo-title').textContent).toBe('Airport Lounge');
    expect(tile().querySelector('.library__thumb-novideo-mark').textContent).toBe(EN.library.audioTile.mark);
  });

  it('one tile, replaced on the next audio file; gone for a video', () => {
    setPlayerAudioTile(wrapper, 'One.mp3');
    setPlayerAudioTile(wrapper, 'Two.m4a');
    expect(wrapper.querySelectorAll('.player__audio-tile')).toHaveLength(1);
    expect(tile().querySelector('.library__thumb-novideo-title').textContent).toBe('Two');
    setPlayerAudioTile(wrapper, null);
    expect(tile()).toBeNull();
  });

  it('lets clicks through to the player', () => {
    const rule = /\.player__audio-tile\s*\{([^}]*)\}/.exec(CSS)?.[1] || '';
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/position:\s*absolute/);
  });

  it('an audio-only file its extension did not tell (no real video stream): the tile too', async () => {
    const Lifted = liftAppClass(['_reportUndecodedVideoTrack', '_showAudioTileFor'], {
      window: { funsync: { fetchMetadata: async () => ({ codec: null, width: 0, hasVideo: false }) } },
      console: { warn() {}, log() {} },
      document, setPlayerAudioTile, isAudioPath: () => false, hasRealVideoStream, describeVideoCodec, NO_FRAMES_GRACE_SEC: 2,
    });
    const app = Object.assign(new Lifted(), { _videoLoadGen: 1, _currentVideoName: 'Voice Note.mp4' });
    app._showDecodeErrorWithCodec = () => { throw new Error('not a decode error'); };
    await app._reportUndecodedVideoTrack('C:\\Lib\\Voice Note.mp4', 'metadata');
    expect(tile()?.querySelector('.library__thumb-novideo-title').textContent).toBe('Voice Note');
  });
});
