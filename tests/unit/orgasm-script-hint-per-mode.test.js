/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel builds its tab as DOM and
 * i18n.js / settings-panel.js branch on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// The Orgasm Switch's script hint read "Hold X during playback … then release
// to snap back" whichever X mode was chosen, so under "Press to finish" it
// described the other mode (design review, 2026-11-23; DESIGN.md §1.8: a hint
// describes the mode chosen). It now follows the mode, at render and on change.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel, orgasmScriptHintKey } from '../../renderer/components/settings-panel.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');

let showing = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(async () => {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
  showing = null;
});
afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});

// The whole dialog, as the app opens it: the select's change handler is wired in show().
async function playback(mode) {
  const store = { 'player.orgasmSwitchMode': mode };
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getAll: () => ({}) };
  const panel = new SettingsPanel({ settings });
  showing = panel.show();
  document.querySelector('.settings-panel__rail-item[data-area="playback"]')?.click();
  await flush();
  return { tab: document, store };
}

const hint = (tab) => tab.querySelector('#sp-orgasm-script-hint').textContent;

describe('the X script hint describes the chosen X mode', () => {
  it('hold (and the default) says hold and release', async () => {
    expect(hint((await playback('hold')).tab)).toBe(EN.settingsPanel.playback.orgasmScriptHint);
    document.querySelector('.settings-panel__done-btn')?.click(); await showing;
    expect(hint((await playback(undefined)).tab)).toBe(EN.settingsPanel.playback.orgasmScriptHint);
    expect(EN.settingsPanel.playback.orgasmScriptHint).toMatch(/Hold X/);
  });

  it('press to finish says tap, and tap again to stop: never "release to snap back"', async () => {
    const text = hint((await playback('toggle')).tab);
    expect(text).toBe(EN.settingsPanel.playback.orgasmScriptHintToggle);
    expect(text).toMatch(/Tap X/);
    expect(text).not.toMatch(/release|snap back/i);
  });

  it('changing the mode changes the hint at once', async () => {
    const { tab, store } = await playback('hold');
    const select = tab.querySelector('#sp-orgasm-mode');
    select.value = 'toggle';
    select.dispatchEvent(new Event('change'));
    expect(store['player.orgasmSwitchMode']).toBe('toggle');
    expect(hint(tab)).toBe(EN.settingsPanel.playback.orgasmScriptHintToggle);
    select.value = 'hold';
    select.dispatchEvent(new Event('change'));
    expect(hint(tab)).toBe(EN.settingsPanel.playback.orgasmScriptHint);
  });

  it('every locale has both wordings, and they differ', () => {
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const p = bundle(l).settingsPanel.playback;
      expect(p.orgasmScriptHintToggle, l).toBeTruthy();
      expect(p.orgasmScriptHintToggle, l).not.toBe(p.orgasmScriptHint);
    }
    expect(orgasmScriptHintKey('toggle')).toBe('settingsPanel.playback.orgasmScriptHintToggle');
    expect(orgasmScriptHintKey('hold')).toBe('settingsPanel.playback.orgasmScriptHint');
  });
});
