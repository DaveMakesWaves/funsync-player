/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The embedded-axes cache must be WRITTEN and READ under the same key.
//
// `_feedEmbeddedMultiAxis` cached under `this._currentVideoPath` (a .mp4),
// while every consumer looked the entry up with a funscript path:
//   library.js  `this._getEmbeddedAxes?.(video.funscriptPath)`   (card badge)
//   library.js  same call again                                   (kebab item)
//   app.js      `detectEmbeddedAxesForPath(video.funscriptPath)`  (modal)
// The two key spaces never intersect, so the cache scored a hit only when a
// video and its script shared a path — never. Reported 2026-08-29 on
// EroScripts #309393: combined multi-axis scripts showed no badge, and playing
// the video first did not help, which is what pointed at the key rather than
// at the detection.
//
// app.js self-instantiates `new App()` at import, so it cannot be imported
// into a test. These assertions read the source, but each one is anchored to
// the write-key/read-key contract rather than to any particular phrasing.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const appSrc = fs.readFileSync('renderer/js/app.js', 'utf8');
const librarySrc = fs.readFileSync('renderer/components/library.js', 'utf8');

function bodyOf(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('_feedEmbeddedMultiAxis writes under the funscript path', () => {
  const feed = bodyOf(appSrc, '_feedEmbeddedMultiAxis(rawContent', 'getEmbeddedAxes(funscriptPath)');

  it('takes the funscript path as a parameter', () => {
    expect(appSrc).toMatch(/_feedEmbeddedMultiAxis\(rawContent, funscriptPath/);
  });

  it('prefers that path over the video path when building the cache key', () => {
    const key = feed.match(/const cacheKey = ([^;]+);/);
    expect(key).not.toBeNull();
    const parts = key[1].split('||').map(s => s.trim());
    expect(parts[0]).toBe('funscriptPath');
    // The video path stays as a fallback for a dropped-in File with no path,
    // which is the one case `_showFunscriptBadge` also falls back to.
    expect(parts).toContain('this._currentVideoPath');
  });

  it('is called with the resolved funscript path, not bare', () => {
    expect(appSrc).toMatch(/this\._feedEmbeddedMultiAxis\(rawContent, this\._currentFunscriptPath\)/);
  });
});

describe('readers use the same key', () => {
  it('the funscript badge tooltip reads by funscript path', () => {
    expect(appSrc).toMatch(/getEmbeddedAxes\(this\._currentFunscriptPath\)/);
    // The old video-path read is what made the tooltip silently empty.
    expect(appSrc).not.toMatch(/getEmbeddedAxes\(this\._currentVideoPath\)/);
  });

  it('loadFunscript resolves the path the same way for write and read', () => {
    const load = bodyOf(appSrc, 'async loadFunscript(file)', 'this._showFunscriptBadge(info)');
    expect(load).toMatch(/this\._currentFunscriptPath = file\.path \|\| file\._funscriptPath/);
  });

  it('a variant switch repoints the key at the newly loaded script', () => {
    const sw = bodyOf(appSrc, 'async _switchVariant(index)', '_updateVariantSelector()');
    expect(sw).toMatch(/this\._currentFunscriptPath = variant\.path/);
  });

  it('is cleared when a new video loads, so axes cannot be misattributed', () => {
    expect(appSrc).toMatch(/this\._currentFunscriptPath = null/);
  });
});

describe('the library hands the funscript path to the player', () => {
  it('attaches _funscriptPath when building the play payload', () => {
    // Without this the library play path had no funscript path at all, which
    // is why the original code reached for the video path in the first place.
    expect(librarySrc).toMatch(/_funscriptPath: video\.funscriptPath/);
  });

  it('does not repurpose `path`, which drives script-editor autosave', () => {
    // `file.path` is what app.js feeds to `scriptEditor.setFunscriptPath`,
    // i.e. where edits get written. Carrying the funscript path on its own
    // field keeps this fix out of the editor's write target.
    const at = librarySrc.indexOf('_funscriptPath: video.funscriptPath');
    expect(at).toBeGreaterThan(-1);
    const payload = librarySrc.slice(librarySrc.lastIndexOf('funscriptData = {', at), at);
    expect(payload).not.toMatch(/^\s*path:/m);
  });

  it('the queue play path attaches it too', () => {
    // Since V72 a Play All item the library holds is resolved by the same
    // `resolvePlayData` as a click (the payload asserted above); a path the
    // library does not hold attaches the queue item's own script path.
    // play-all-loads-axes.test.js checks the effect: the badge's cache hits.
    const queue = bodyOf(appSrc, 'async _loadQueueItemContent(item, fileData)', '_loadPlayContent(fileData');
    expect(queue).toMatch(/this\.library\.resolvePlayData\(libVideo\)/);
    expect(queue).toMatch(/_funscriptPath: scriptPath/);
  });
});
