// The multi-axis badge must appear for COMBINED scripts, without playing them.
//
// Community report 2026-08-29 (EroScripts #309393, Hikikomori / lnlytrckr):
// "I have a few multiaxis scripts but i dont see theam". Every one of them was
// a combined file — pitch/roll/twist embedded INSIDE the single .funscript
// rather than sitting in companion `*.pitch.funscript` files. Two separate
// faults kept the badge off:
//
//  1. Nothing looked inside a funscript until the user PLAYED the video, so
//     the grid could never distinguish a combined script from a plain one.
//  2. `_feedEmbeddedMultiAxis` cached its findings under the VIDEO path while
//     every reader (`getEmbeddedAxes(video.funscriptPath)`) looked them up by
//     the FUNSCRIPT path — so even after playing, the cache never hit.
//
// These tests drive the real prototype methods against a hand-rolled `this`,
// matching the pattern in library-selection-state.test.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { Library } from '../../renderer/components/library.js';

const VIDEO = 'C:\\v\\clip.mp4';
const SCRIPT = 'C:\\v\\clip.funscript';

/** A combined script in HereSphere `additional_axes` shape. */
function combinedScript() {
  return {
    actions: [{ at: 0, pos: 50 }, { at: 500, pos: 80 }],
    additional_axes: [
      { axis: 'twist', actions: [{ at: 0, pos: 50 }, { at: 500, pos: 30 }] },
      { axis: 'pitch', actions: [{ at: 0, pos: 50 }, { at: 500, pos: 70 }] },
    ],
  };
}

function plainScript() {
  return { actions: [{ at: 0, pos: 50 }, { at: 500, pos: 80 }] };
}

function makeGridCard() {
  const card = document.createElement('div');
  card.className = 'library__card';
  const info = document.createElement('div');
  info.className = 'library__card-info';
  card.appendChild(info);
  return card;
}

function makeListRow() {
  const row = document.createElement('div');
  row.className = 'library__list-item';
  const badges = document.createElement('div');
  badges.className = 'library__list-badges';
  row.appendChild(badges);
  return row;
}

function makeHost({ getEmbeddedAxes = () => null, fileContent = null } = {}) {
  return {
    _getEmbeddedAxes: getEmbeddedAxes,
    _noteEmbeddedAxes: Library.prototype._noteEmbeddedAxes,
    _addPlaybackModeBadge: Library.prototype._addPlaybackModeBadge,
    _countMultiAxisScripts: Library.prototype._countMultiAxisScripts,
    _loadSpeedStatsForVideo: Library.prototype._loadSpeedStatsForVideo,
    _addSpeedBadge: Library.prototype._addSpeedBadge,
    _readFunscriptResilient: async () => fileContent,
  };
}

function makeVideo(extra = {}) {
  return { path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT, ...extra };
}

describe('_noteEmbeddedAxes — badge from the per-card funscript read', () => {
  let host;
  beforeEach(() => { host = makeHost(); });

  it('badges a combined script with no companion files and no play', () => {
    const video = makeVideo();
    const card = makeGridCard();

    host._noteEmbeddedAxes(video, combinedScript(), card);

    expect(video._embeddedAxes.suffixes.sort()).toEqual(['pitch', 'twist']);
    expect(card.querySelector('.library__multi-badge')).toBeTruthy();
  });

  it('leaves a plain single-axis script unbadged', () => {
    const video = makeVideo();
    const card = makeGridCard();

    host._noteEmbeddedAxes(video, plainScript(), card);

    expect(video._embeddedAxes).toBeNull();
    expect(card.querySelector('.library__multi-badge')).toBeNull();
  });

  it('uses the inline badge variant for a list row', () => {
    const video = makeVideo();
    const row = makeListRow();

    host._noteEmbeddedAxes(video, combinedScript(), row);

    expect(row.querySelector('.library__multi-badge--inline')).toBeTruthy();
    expect(row.querySelector('.library__multi-badge')).toBeNull();
  });

  it('names the detected axes in the tooltip, so "which axes" is answerable', () => {
    const video = makeVideo();
    const card = makeGridCard();

    host._noteEmbeddedAxes(video, combinedScript(), card);

    const title = card.querySelector('.library__multi-badge').title;
    expect(title).toContain('twist');
    expect(title).toContain('pitch');
  });

  it('detects axes even when the main stroke track is missing', () => {
    // A vib-only or rotation-only combined file has no usable top-level
    // `actions`. The speed-stats gate this rides on skips those entirely,
    // so the detection has to run BEFORE that gate.
    const video = makeVideo();
    const card = makeGridCard();

    host._noteEmbeddedAxes(video, {
      additional_axes: [{ axis: 'vib', actions: [{ at: 0, pos: 10 }, { at: 90, pos: 90 }] }],
    }, card);

    expect(video._embeddedAxes.suffixes).toEqual(['vib']);
    expect(card.querySelector('.library__multi-badge')).toBeTruthy();
  });

  it('does not override an explicit companion-file multi-axis config', () => {
    const video = makeVideo({ _multiAxis: { main: SCRIPT, axes: { roll: 'C:\\v\\clip.roll.funscript' } } });
    const card = makeGridCard();

    host._noteEmbeddedAxes(video, combinedScript(), card);

    expect(video._embeddedAxes).toBeUndefined();
  });

  it('does not override an explicit custom-routing config', () => {
    const video = makeVideo({ _customRouting: [{ deviceId: 'a', scriptPath: SCRIPT }] });
    const card = makeGridCard();

    host._noteEmbeddedAxes(video, combinedScript(), card);

    expect(video._embeddedAxes).toBeUndefined();
    expect(card.querySelector('.library__multi-badge')).toBeNull();
  });

  it('survives a funscript shape the extractor chokes on', () => {
    const video = makeVideo();
    expect(() => host._noteEmbeddedAxes(video, null, makeGridCard())).not.toThrow();
  });
});

describe('_loadSpeedStatsForVideo — the path the grid actually takes', () => {
  // The reported symptom end to end: scroll a combined script into view,
  // never press play, and the badge has to be there.
  it('badges a combined script off the deferred per-card read alone', async () => {
    const host = makeHost({ fileContent: JSON.stringify(combinedScript()) });
    const video = makeVideo();
    const card = makeGridCard();

    await host._loadSpeedStatsForVideo(video, card);

    expect(card.querySelector('.library__multi-badge')).toBeTruthy();
    expect(video._embeddedAxes.suffixes.sort()).toEqual(['pitch', 'twist']);
  });

  it('leaves a plain script with only its speed badge', async () => {
    const host = makeHost({ fileContent: JSON.stringify(plainScript()) });
    const video = makeVideo();
    const card = makeGridCard();

    await host._loadSpeedStatsForVideo(video, card);

    expect(card.querySelector('.library__multi-badge')).toBeNull();
    expect(card.querySelector('.library__speed-badge')).toBeTruthy();
  });

  it('still badges when the file is unreadable JSON, without throwing', async () => {
    const host = makeHost({ fileContent: 'not json' });
    const video = makeVideo();
    const card = makeGridCard();

    await expect(host._loadSpeedStatsForVideo(video, card)).resolves.toBeUndefined();
    expect(card.querySelector('.library__multi-badge')).toBeNull();
  });
});

describe('_addPlaybackModeBadge', () => {
  it('is idempotent — the deferred read cannot double up the badge', () => {
    // The badge is added once when the card is built and again when the
    // per-card funscript read lands. Two icons in the info bar is the
    // visible failure.
    const host = makeHost();
    const video = makeVideo({ _embeddedAxes: { suffixes: ['twist'] } });
    const card = makeGridCard();
    const info = card.querySelector('.library__card-info');

    host._addPlaybackModeBadge(info, video);
    host._addPlaybackModeBadge(info, video);

    expect(info.querySelectorAll('.library__multi-badge')).toHaveLength(1);
  });

  it('never shows the custom-routing badge alongside a multi badge', () => {
    const host = makeHost();
    const video = makeVideo({
      _multiAxis: { main: SCRIPT, axes: { roll: 'C:\\v\\clip.roll.funscript' } },
      _customRouting: [{ deviceId: 'a', scriptPath: SCRIPT }],
    });
    const card = makeGridCard();
    const info = card.querySelector('.library__card-info');

    host._addPlaybackModeBadge(info, video);

    expect(info.querySelector('.library__multi-badge')).toBeTruthy();
    expect(info.querySelector('.library__custom-badge')).toBeNull();
  });

  it('still reads the app play-time cache, keyed by FUNSCRIPT path', () => {
    // Regression guard for fault 2: a cache keyed by video path made this
    // lookup miss every time.
    const host = makeHost({
      getEmbeddedAxes: (p) => (p === SCRIPT ? { suffixes: ['roll'] } : null),
    });
    const video = makeVideo();
    const card = makeGridCard();

    host._addPlaybackModeBadge(card.querySelector('.library__card-info'), video);

    expect(card.querySelector('.library__multi-badge')).toBeTruthy();
  });

  it('ignores an entry keyed by the video path — that shape is the bug', () => {
    const host = makeHost({
      getEmbeddedAxes: (p) => (p === VIDEO ? { suffixes: ['roll'] } : null),
    });
    const video = makeVideo();
    const card = makeGridCard();

    host._addPlaybackModeBadge(card.querySelector('.library__card-info'), video);

    expect(card.querySelector('.library__multi-badge')).toBeNull();
  });
});
