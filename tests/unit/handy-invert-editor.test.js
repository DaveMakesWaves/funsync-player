/**
 * @vitest-environment jsdom
 * jsdom on purpose: script-editor.js imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// Handy invert in the script editor (#276/#390): the live preview (HDSP
// nudges while you drag a point) must go where the device will really go,
// and an editor save must re-upload through the app's own chain so it keeps
// the invert AND the output limits / filler. It used to upload the raw
// script, which silently dropped the output limits on every autosave.
import { describe, it, expect } from 'vitest';
import { ScriptEditor } from '../../renderer/components/script-editor.js';

const settingsWith = (o) => ({ get: (k) => o[k] });

describe('editor live preview', () => {
  const preview = (inverted, position) => {
    const sent = [];
    const fake = {
      handyManager: { connected: true, hdspMove: (p, d) => sent.push([p, d]) },
      syncEngine: { _active: false },
      settings: settingsWith({ 'handy.inverted': inverted }),
    };
    ScriptEditor.prototype._sendLivePreview.call(fake, position);
    return sent;
  };

  it('is flipped when the Handy is inverted', () => {
    expect(preview(true, 30)).toEqual([[70, 150]]);
  });

  it('is unchanged when not inverted (or the key is missing)', () => {
    expect(preview(false, 30)).toEqual([[30, 150]]);
    expect(preview(undefined, 30)).toEqual([[30, 150]]);
  });

  it('still never fires while HSSP sync is running', () => {
    const sent = [];
    ScriptEditor.prototype._sendLivePreview.call({
      handyManager: { connected: true, hdspMove: (p) => sent.push(p) },
      syncEngine: { _active: true },
      settings: settingsWith({ 'handy.inverted': true }),
    }, 30);
    expect(sent).toEqual([]);
  });
});

describe('editor save → Handy re-upload', () => {
  const RAW = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }] });
  const makeFake = (o = {}) => {
    const log = [];
    return {
      log,
      handyManager: {
        connected: true,
        uploadAndSetScript: async (c) => { log.push(['upload', JSON.parse(c).actions.map((a) => a.pos)]); return true; },
      },
      syncEngine: { _scriptReady: false, stop: () => log.push('stop'), start: () => log.push('start') },
      funscriptEngine: { getRawContent: () => RAW },
      settings: settingsWith({ 'handy.inverted': true }),
      ...o,
    };
  };

  it("goes through the app's chain when wired (stop, then the app path)", async () => {
    const fake = makeFake();
    fake.onReuploadHandy = async () => fake.log.push('app chain');
    await ScriptEditor.prototype._reuploadToHandy.call(fake);
    expect(fake.log).toEqual(['stop', 'app chain']);
  });

  it('falls back to a direct upload that still honours the invert', async () => {
    const fake = makeFake();
    await ScriptEditor.prototype._reuploadToHandy.call(fake);
    expect(fake.log).toEqual(['stop', ['upload', [100, 0]], 'start']);
  });

  it('does nothing with no Handy', async () => {
    const fake = makeFake();
    fake.handyManager.connected = false;
    fake.onReuploadHandy = async () => fake.log.push('app chain');
    await ScriptEditor.prototype._reuploadToHandy.call(fake);
    expect(fake.log).toEqual([]);
  });
});
