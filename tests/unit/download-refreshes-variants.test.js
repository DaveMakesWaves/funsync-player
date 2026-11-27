/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// An EroScripts download for the OPEN video (the panel, or Associate's
// search) refreshes its variation menu (N-02 note, TODO triage 2026-11-23,
// also in v0.9.2): loadFunscript ran but `_currentVariants` stayed the old
// list, so the chip named the previous script and the download was in no
// entry until the video was opened again. The list comes from the library,
// which rebuilt it when it recorded the association.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

const VIDEO = 'C:\\V\\Clip.mp4';
const DL = 'C:\\V\\Clip (EroScripts).funscript';
const OWN = 'C:\\V\\Clip.funscript';
const App = liftAppClass(['_refreshVariantsAfterDownload'], {});

function app(libVariants, extra = {}) {
  const a = new App();
  Object.assign(a, {
    _currentVideoPath: VIDEO,
    _videoLoadGen: 7,
    _variantsPhoneEpoch: null,
    _currentVariants: [{ label: 'Default', path: OWN }],
    _activeVariantIndex: 0,
    _activeVariantPath: null,
    library: { _videos: [{ path: VIDEO, variants: libVariants }] },
    _updateVariantSelector: vi.fn(function rebuild() { this._allVariantsWithManual = [...this._currentVariants]; }),
  }, extra);
  return a;
}

describe('after a download for the open video', () => {
  it('the list is the library\'s new one, led by the download, which is the one playing', () => {
    const a = app([{ label: 'EroScripts', path: DL }, { label: 'Default', path: OWN }]);
    a._refreshVariantsAfterDownload(DL);
    expect(a._currentVariants.map((v) => v.path)).toEqual([DL, OWN]);
    expect(a._activeVariantIndex).toBe(0);
    expect(a._activeVariantPath).toBeNull();
    expect(a._mainScript).toEqual({ gen: 7, path: DL });
    expect(a._updateVariantSelector).toHaveBeenCalled();
  });

  it('a download that sits further down the list (it replaced the video\'s own script) is picked there', () => {
    const a = app([{ label: 'Pinned', path: 'C:\\V\\Clip.soft.funscript' }, { label: 'Default', path: DL }]);
    a._refreshVariantsAfterDownload(DL.toUpperCase().replace(/\\/g, '/'));
    expect(a._activeVariantIndex).toBe(1);
    expect(a._activeVariantPath).toBe(DL);
  });

  it('a phone session\'s list is the phone video\'s: left alone', () => {
    const a = app([{ label: 'EroScripts', path: DL }], { _variantsPhoneEpoch: 3 });
    a._refreshVariantsAfterDownload(DL);
    expect(a._currentVariants.map((v) => v.path)).toEqual([OWN]);
    expect(a._updateVariantSelector).not.toHaveBeenCalled();
  });

  it('wired into both download handlers, after the script loads', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/await this\.loadFunscript\(\{ name: fsName, textContent: content, path: fsPath \}\);\n\s+this\._refreshVariantsAfterDownload\?\.\(fsPath\);/);
    // Download all for the open video also loads its new axes now (editor work list 6.4).
    expect(src).toMatch(/await this\.loadFunscript\(\{ name, textContent: content, path \}\);\n\s+if \(forOpen\) \{\n\s+this\._refreshVariantsAfterDownload\?\.\(path\);\n\s+await this\._loadDownloadedAxes\?\.\(path, written\);/);
  });
});
