/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A phone that leaves a window where no video was ever opened (full manual
// test, 2026-11-23; in v0.10.0). `_updateVariantSelector` tested
// `this._mainScript?.gen === this._videoLoadGen`: with both undefined that is
// true, and `this._mainScript.path` threw. The phone's goodbye
// (`_onRemotePhoneDisconnected`) calls it first (`_givePhoneVariantListBack`),
// so the throw skipped EVERYTHING after it: the devices were not stopped,
// the session never ended (the card said "Paused" for good) and this
// window's script was not given back. Seen live: open the app, use only
// the phone, close the phone.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

const doc = { getElementById: () => ({ hidden: false, textContent: '', classList: { toggle() {}, add() {}, remove() {} }, replaceChildren() {}, appendChild() {} }) };

describe('no video opened in this window yet', () => {
  const Menu = liftAppClass(['_updateVariantSelector', '_variantLabelText', '_givePhoneVariantListBack', '_multiAxisForScript'], {
    t: (k) => k, document: doc,
    canonicalPath: (p) => p, sameFolderCompanions: () => ({}), getAxisBySuffix: () => null,
  });
  const fresh = () => Object.assign(new Menu(), {
    // What a window that never opened a video has: no _mainScript, no _videoLoadGen.
    _currentVideoPath: null, _currentVariants: [], _activeVariantPath: null, _activeVariantIndex: 0,
    _variantsPhoneEpoch: 3, _localVariantsBeforeRemote: null, _engineHeldByRemote: false,
    funscriptEngine: { isLoaded: true, getRawContent: () => '{}' },
    scriptEditor: { _funscriptPath: 'C:\\V\\phone.funscript' },
    _manualVariantsFor: () => [],
  });

  it('giving the phone\'s variation list back does not throw', () => {
    const app = fresh();
    expect(app._mainScript).toBeUndefined();
    expect(app._videoLoadGen).toBeUndefined();
    expect(() => app._givePhoneVariantListBack()).not.toThrow();
    expect(app._variantsPhoneEpoch).toBeNull();
  });

  it('the variation axes lookup does not throw either', () => {
    const app = fresh();
    app._currentMultiAxis = null;
    app.settings = { get: () => 'single' };
    expect(() => app._multiAxisForScript('C:\\V\\a.funscript')).not.toThrow();
  });
});

describe('the phone\'s goodbye', () => {
  it('a failure giving the list back can never skip stopping the devices and ending the session', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    const fn = src.slice(src.indexOf('  _onRemotePhoneDisconnected(_ip) {'), src.indexOf('  _onRemotePhoneDisconnected(_ip) {') + 6000);
    const tryAt = fn.indexOf('try {\n      this._givePhoneVariantListBack?.();\n    } catch (err) {');
    expect(tryAt).toBeGreaterThan(0);
    expect(fn.indexOf('if (this.syncEngine?._active) this.syncEngine.stop();')).toBeGreaterThan(tryAt);
    expect(fn.indexOf('this.sessionTracker?.endSession();')).toBeGreaterThan(tryAt);
    expect(src).not.toMatch(/this\._mainScript\?\.gen === this\._videoLoadGen \? this\._mainScript\.path/);
  });
});
