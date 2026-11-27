// Test day 2026-11-26 (B101): a saved stream's Script section said "Paired
// by name" and "Paired by file name. Rename or move the .funscript to unpair
// it." A stream has no file name to match: its script was picked when the
// link was saved (Load from URL, EroScripts Watch). Renaming that .funscript
// would only have broken the pairing of the video it belongs to.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scriptView } from '../../renderer/js/video-options-model.js';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const SCRIPT = 'C:\\Lib\\Alpha Scene.funscript';

describe('a saved stream\'s script (B101)', () => {
  it('says it was saved with the link; Unpair is not offered, and the note points to Change…, not to renaming a file', () => {
    const v = scriptView({ videoPath: 'stream:example.com/remote-a', funscriptPath: SCRIPT });
    expect(v.pairing).toMatchObject({ kind: 'stream', hand: false, labelKey: 'videoOptions.script.pairing.stream' });
    expect(v.main.path).toBe(SCRIPT);
    expect(v.unpair.offered).toBe(false);
    expect(v.unpair.explanationKey).toBe('videoOptions.script.unpair.stream');
  });

  it('a file with the same script still says "by name"', () => {
    const v = scriptView({ videoPath: 'C:\\Lib\\Alpha Scene.mp4', funscriptPath: SCRIPT });
    expect(v.pairing.kind).toBe('by-name');
    expect(v.unpair.explanationKey).toBe('videoOptions.script.unpair.byName');
  });

  it('a script chosen for the stream with Change… (an association) is yours, and can be unpaired', () => {
    const other = 'C:\\Lib\\Bravo.funscript';
    const v = scriptView({ videoPath: 'stream:example.com/remote-a', association: other, funscriptPath: other });
    expect(v.pairing).toMatchObject({ kind: 'single', hand: true });
    expect(v.unpair.offered).toBe(true);
  });

  it('a stream with no script: "No script"', () => {
    const v = scriptView({ videoPath: 'stream:example.com/remote-a', funscriptPath: null });
    expect(v.pairing.kind).toBe('none');
  });

  it('both lines exist in every language, and the note names that language\'s Change… button', () => {
    for (const loc of LOCALES) {
      const s = JSON.parse(fs.readFileSync(`renderer/locales/${loc}.json`, 'utf8')).videoOptions.script;
      expect(typeof s.pairing.stream, loc).toBe('string');
      expect(s.unpair.stream, loc).toContain(s.change);
    }
  });
});
