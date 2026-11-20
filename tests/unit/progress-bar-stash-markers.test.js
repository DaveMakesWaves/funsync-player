/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ProgressBar finds its strip, canvas and tooltip
 * elements in a DOM and builds the Stash hover line there (notes/CLAUDE.md
 * "Test environments").
 */
// Stash scene markers on the seek bar's chapter strip (Stash S1, Dave's
// answer 3; DESIGN-stash-s1.md (j) row 1; SCOPE-chapters-bookmarks.md §4.2,
// §4.3). They are drawn ALONGSIDE the script's chapters (never instead of
// them), say on hover that they are from Stash, and go away with an empty
// list. Asserted: what the strip canvas is asked to paint, the strip's
// visibility and the tooltip's text.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { ProgressBar, STASH_MARKER_COLOR, STASH_MARKER_RANGE_COLOR } from '../../renderer/js/progress-bar.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

function dom() {
  document.body.innerHTML = `
    <div id="progress-container">
      <canvas id="heatmap-canvas"></canvas>
      <div id="chapter-strip-container" hidden>
        <canvas id="chapter-strip-canvas"></canvas>
      </div>
      <div id="progress-tooltip">
        <div class="tooltip__marker" id="tooltip-marker" hidden>
          <span class="tooltip__marker-swatch" id="tooltip-marker-swatch"></span>
          <span class="tooltip__marker-name" id="tooltip-marker-name"></span>
        </div>
        <div id="tooltip-thumbnail"></div>
      </div>
    </div>`;
}

/** A 2D context that records each fillRect with the colour it was painted in. */
function recordingCtx() {
  const ctx = {
    fills: [],
    fillStyle: '',
    scale() {},
    clearRect() {},
    fillRect(x, y, w, h) { ctx.fills.push({ style: ctx.fillStyle, x, y, w, h }); },
  };
  return ctx;
}

const CHAPTERS = [
  { startMs: 0, endMs: 30000, name: 'Scene 1', color: '#ff0000' },
  { startMs: 30000, endMs: 60000, name: 'Scene 2', color: '#00ff00' },
];
const MARKERS = [
  { startMs: 15000, endMs: null, title: 'Position change' },
  { startMs: 40000, endMs: 50000, title: 'Synthetic marker one' },
];

let bar;
let ctx;
let player;

beforeEach(() => {
  dom();
  player = { duration: 60 };
  bar = new ProgressBar({
    containerElement: document.getElementById('progress-container'),
    videoPlayer: player,
    backendPort: 5123,
  });
  ctx = recordingCtx();
  bar.chapterStripCtx = ctx;
  bar.chapterStripCanvas.parentElement.getBoundingClientRect = () => ({ width: 600, height: 4 });
});

const stashFills = () => ctx.fills.filter((f) => f.style === STASH_MARKER_COLOR || f.style === STASH_MARKER_RANGE_COLOR);
const chapterFills = () => ctx.fills.filter((f) => f.style === '#ff0000' || f.style === '#00ff00');

describe('the strip shows while either kind is there', () => {
  it('Stash markers alone show the strip; an empty list hides it again', () => {
    expect(bar.chapterStripContainer.hidden).toBe(true);
    bar.setStashMarkers(MARKERS);
    expect(bar.chapterStripContainer.hidden).toBe(false);
    bar.setStashMarkers([]);
    expect(bar.chapterStripContainer.hidden).toBe(true);
  });

  it('the script paths clearing their chapters (setMarkers) keep the Stash markers and the strip', () => {
    bar.setStashMarkers(MARKERS);
    bar.setMarkers({ chapters: [], bookmarks: [] });
    expect(bar.chapterStripContainer.hidden).toBe(false);
    expect(bar._stashMarkers).toHaveLength(2);
  });

  it('Stash markers going away keep the script\'s chapters and the strip', () => {
    bar.setMarkers({ chapters: CHAPTERS, bookmarks: [] });
    bar.setStashMarkers(MARKERS);
    bar.setStashMarkers([]);
    expect(bar.chapterStripContainer.hidden).toBe(false);
    expect(bar._chapters).toEqual(CHAPTERS);
  });
});

describe('drawing: alongside the script\'s chapters, never instead of them', () => {
  it('Stash alone: full height; a point is a 2px tick, a range a segment plus its tick', () => {
    bar.setStashMarkers(MARKERS);
    // 600 px for 60 s: 10 px per second.
    expect(stashFills()).toEqual([
      { style: STASH_MARKER_COLOR, x: 149, y: 0, w: 2, h: 4 },
      { style: STASH_MARKER_RANGE_COLOR, x: 400, y: 0, w: 100, h: 4 },
      { style: STASH_MARKER_COLOR, x: 399, y: 0, w: 2, h: 4 },
    ]);
  });

  it('with the script\'s chapters: the chapters keep the top half, Stash takes the bottom half', () => {
    bar.setMarkers({ chapters: CHAPTERS, bookmarks: [] });
    bar.setStashMarkers(MARKERS);
    ctx.fills = [];
    bar.redraw();
    expect(chapterFills()).toEqual([
      { style: '#ff0000', x: 0, y: 0, w: 300, h: 2 },
      { style: '#00ff00', x: 300, y: 0, w: 300, h: 2 },
    ]);
    expect(stashFills().map(({ y, h }) => ({ y, h }))).toEqual([{ y: 2, h: 2 }, { y: 2, h: 2 }, { y: 2, h: 2 }]);
  });

  it('the script\'s chapters alone are drawn exactly as before (full height, nothing of Stash)', () => {
    bar.setMarkers({ chapters: CHAPTERS, bookmarks: [] });
    expect(chapterFills()).toEqual([
      { style: '#ff0000', x: 0, y: 0, w: 300, h: 4 },
      { style: '#00ff00', x: 300, y: 0, w: 300, h: 4 },
    ]);
    expect(stashFills()).toEqual([]);
  });

  it('a video with no script still gets its Stash markers drawn (the duration comes from the player)', () => {
    bar._heatmapData = null;
    bar.setStashMarkers([{ startMs: 30000, title: 'Mid' }]);
    expect(stashFills()).toEqual([{ style: STASH_MARKER_COLOR, x: 299, y: 0, w: 2, h: 4 }]);
  });

  it('no duration yet: nothing drawn, nothing thrown', () => {
    player.duration = NaN;
    expect(() => bar.setStashMarkers(MARKERS)).not.toThrow();
    expect(stashFills()).toEqual([]);
  });

  it('bad entries are left out; an end before the start is a point', () => {
    bar.setStashMarkers([{ startMs: -5 }, { startMs: 'x' }, null, { startMs: 1000, endMs: 500, title: 7 }]);
    expect(bar._stashMarkers).toEqual([{ startMs: 1000, endMs: null, title: '', source: 'stash' }]);
  });
});

describe('hover: the title, marked as from Stash', () => {
  beforeEach(() => {
    bar.stashMarkerLabel = (title) => (title ? `Stash marker: ${title}` : 'Stash marker');
  });

  const stashLine = () => document.getElementById('tooltip-marker-stash');

  it('over a marker tick: its own line says "Stash marker: <title>"', () => {
    bar.setStashMarkers(MARKERS);
    bar.updateMarkerTooltip(152, 600, 60000);
    expect(stashLine().hidden).toBe(false);
    expect(stashLine().textContent).toBe('Stash marker: Position change');
  });

  it('inside a range marker: that marker; away from every marker: the line hides', () => {
    bar.setStashMarkers(MARKERS);
    bar.updateMarkerTooltip(460, 600, 60000);
    expect(stashLine().textContent).toBe('Stash marker: Synthetic marker one');
    bar.updateMarkerTooltip(250, 600, 60000);
    expect(stashLine().hidden).toBe(true);
  });

  it('a script chapter and a Stash marker at one spot: both labels show', () => {
    bar.setMarkers({ chapters: CHAPTERS, bookmarks: [] });
    bar.setStashMarkers(MARKERS);
    bar.updateMarkerTooltip(150, 600, 60000);
    expect(bar.tooltipMarker.hidden).toBe(false);
    expect(bar.tooltipMarkerName.textContent).toBe('Scene 1');
    expect(stashLine().hidden).toBe(false);
    expect(stashLine().textContent).toBe('Stash marker: Position change');
  });

  it('the title from the user\'s Stash is text, never HTML', () => {
    bar.setStashMarkers([{ startMs: 15000, title: '<img src=x onerror="window.__pwned=1">' }]);
    bar.updateMarkerTooltip(150, 600, 60000);
    expect(stashLine().querySelector('img')).toBeNull();
    expect(stashLine().textContent).toBe('Stash marker: <img src=x onerror="window.__pwned=1">');
  });

  it('a marker with no title still says it is a Stash marker', () => {
    bar.setStashMarkers([{ startMs: 15000, title: '' }]);
    bar.updateMarkerTooltip(150, 600, 60000);
    expect(stashLine().textContent).toBe('Stash marker');
  });

  // s1-fixup-renderer (RA-S1-6): a bar whose window set no label (the
  // pop-out's, before the fix-up) speaks the loaded language too; the plain
  // English words are only for a window with none loaded.
  it('without the app\'s words (the label is not set): the loaded language\'s words; none loaded: "Stash: <title>"', () => {
    bar.stashMarkerLabel = null;
    bar.setStashMarkers(MARKERS);
    bar.updateMarkerTooltip(150, 600, 60000);
    expect(stashLine().textContent).toBe('Stash marker: Position change');
    const de = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
    const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
    try {
      _setBundlesForTests('de', de, en);
      bar.updateMarkerTooltip(150, 600, 60000);
      expect(stashLine().textContent).toBe('Stash-Marker: Position change');
      bar.setStashMarkers([{ startMs: 15000, title: '' }]);
      bar.updateMarkerTooltip(150, 600, 60000);
      expect(stashLine().textContent).toBe(de.player.stashMarkerUntitled);
      _setBundlesForTests('en', {}, {});
      bar.setStashMarkers(MARKERS);
      bar.updateMarkerTooltip(150, 600, 60000);
      expect(stashLine().textContent).toBe('Stash: Position change');
    } finally {
      _setBundlesForTests('en', en, en);
    }
  });

  it('no Stash markers: no Stash line is ever made, the script\'s label works as before', () => {
    bar.setMarkers({ chapters: CHAPTERS, bookmarks: [] });
    bar.updateMarkerTooltip(150, 600, 60000);
    expect(stashLine()).toBeNull();
    expect(bar.tooltipMarkerName.textContent).toBe('Scene 1');
  });

  it('resolveStashMarker: the nearest tick within 6 px wins over a range', () => {
    bar.setStashMarkers([{ startMs: 10000, endMs: 30000, title: 'Range' }, { startMs: 20000, title: 'Point' }]);
    expect(bar.resolveStashMarker(203, 600, 60000).data.title).toBe('Point');
    expect(bar.resolveStashMarker(250, 600, 60000).data.title).toBe('Range');
    expect(bar.resolveStashMarker(350, 600, 60000)).toBeNull();
    expect(bar.resolveStashMarker(200, 0, 60000)).toBeNull();
    expect(bar.resolveStashMarker(200, 600, 0)).toBeNull();
  });
});
