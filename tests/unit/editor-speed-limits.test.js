/**
 * @vitest-environment jsdom
 * jsdom on purpose: settings-panel.js and script-editor.js import modules
 * that branch on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Editor speed limits (2026-11-24, notes/scripting-research-2026-11-24.md):
// the timeline marks a stroke faster than the max lilac (OFS's max speed
// highlight; roa scripts to 400 units/s) and a MOVING stroke slower than the
// min dashed (kinetics: the Handy stops under about 33). Settings > Keyboard >
// Editor speed limits; 0 turns a mark off.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { SettingsPanel } = await import('../../renderer/components/settings-panel.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');
const { ActionGraph } = await import('../../renderer/js/action-graph.js');

function fakeSettings(values = {}) {
  const store = { ...values };
  return { store, get: (k) => store[k], set: vi.fn((k, v) => { store[k] = v; }) };
}

afterEach(() => ActionGraph.setSpeedLimits({ max: 400, min: 33 }));

describe('Settings > Editor speed limits', () => {
  // The max's default is the fastest any supported toy moves (an overclocked
  // Handy 2 Pro, 640 u/s; Dave, 2026-11-24), no longer roa's 400.
  it('shows the stored limits, the fastest toy\'s 640 and kinetics\' 33 when none are stored', () => {
    const panel = Object.create(SettingsPanel.prototype);
    panel._settings = fakeSettings();
    const sec = panel._buildEditorSpeedSection();
    expect(sec.id).toBe('sp-sec-editor-speed');
    expect(sec.querySelector('#sp-editor-max-speed').value).toBe('640');
    expect(sec.querySelector('#sp-editor-min-speed').value).toBe('33');

    panel._settings = fakeSettings({ 'editor.maxSpeed': 600, 'editor.minSpeed': 0 });
    const sec2 = panel._buildEditorSpeedSection();
    expect(sec2.querySelector('#sp-editor-max-speed').value).toBe('600');
    expect(sec2.querySelector('#sp-editor-min-speed').value).toBe('0');
  });

  it('writes a whole, non-negative number on change; nonsense gives the default back', () => {
    const panel = Object.create(SettingsPanel.prototype);
    panel._settings = fakeSettings();
    const sec = panel._buildEditorSpeedSection();
    const max = sec.querySelector('#sp-editor-max-speed');
    max.value = '450.6';
    max.dispatchEvent(new Event('change'));
    expect(panel._settings.set).toHaveBeenLastCalledWith('editor.maxSpeed', 451);
    max.value = '-5';
    max.dispatchEvent(new Event('change'));
    expect(panel._settings.set).toHaveBeenLastCalledWith('editor.maxSpeed', 640);
    expect(max.value).toBe('640');
  });

  it('the section is placed in the Keyboard area, after the position keys', () => {
    const panel = Object.create(SettingsPanel.prototype);
    const kb = panel._railAreas().find((a) => a.id === 'keyboard');
    const ids = kb.sections.map((s) => s.id);
    expect(ids.indexOf('sp-sec-editor-speed')).toBe(ids.indexOf('sp-sec-position-keys') + 1);
  });
});

describe('ScriptEditor applies the limits to the graph', () => {
  it('reads the settings, defaults when unset', () => {
    const ed = Object.create(ScriptEditor.prototype);
    ed.settings = fakeSettings();
    expect(ed._speedLimits()).toEqual({ max: 640, min: 33 });
    ed.settings = fakeSettings({ 'editor.maxSpeed': 0, 'editor.minSpeed': 40 });
    expect(ed._speedLimits()).toEqual({ max: 0, min: 40 });
    ActionGraph.setSpeedLimits(ed._speedLimits());
    expect(ActionGraph.speedMark(9)).toBeNull(); // max off
    expect(ActionGraph.speedMark(0.035)).toBe('slow');
  });
});
