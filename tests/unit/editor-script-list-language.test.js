/**
 * The editor's script list follows a language switch (FT-103, TODO triage
 * 2026-11-23, cosmetic, also in v0.9.2): "Main (L0)" and the embedded-axis
 * entries were built with t() once per video load and kept the old language,
 * docked and in the pop-out (setAvailableScripts broadcasts to it). Only the
 * labels change; the paths, and the script being edited, stay.
 * jsdom: i18n.js branches on `typeof window` (notes/CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { liftAppClass } from './helpers/app-methods.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
const MAIN = 'C:\\V\\Clip.funscript';
const App = liftAppClass(['_retranslateEditorScriptList'], { t });

function editorWith(list) {
  return { _availableScripts: list, setAvailableScripts: vi.fn(function set(l) { this._availableScripts = l; }) };
}

beforeEach(() => _setBundlesForTests('en', EN, EN));

describe('a language switch', () => {
  it('relabels Main and the embedded axes; companion files, paths and order stay', () => {
    const list = [
      { label: t('editor.mainAxisLabel'), path: MAIN },
      { label: 'Pitch', path: 'C:\\V\\Clip.pitch.funscript' },
      { label: t('editor.embeddedAxisLabel', { axis: 'Twist' }), path: `${MAIN}#embedded=twist`, embeddedAxis: 'twist', axisLabel: 'Twist' },
    ];
    const app = Object.assign(new App(), { scriptEditor: editorWith(list) });
    _setBundlesForTests('de', DE, EN);
    app._retranslateEditorScriptList();
    const now = app.scriptEditor._availableScripts;
    expect(now.map((e) => e.label)).toEqual(['Haupt (L0)', 'Pitch', 'Twist (in dieser Datei)']);  // edited in place since multi-axis editing (2026-11-24)
    expect(now.map((e) => e.path)).toEqual(list.map((e) => e.path));
    expect(now[2]).toMatchObject({ embeddedAxis: 'twist', axisLabel: 'Twist' });
  });

  it('nothing to do: no list, a one-entry list, or custom routing (its list has no translated words)', () => {
    const one = editorWith([{ label: 'Main (L0)', path: MAIN }]);
    Object.assign(new App(), { scriptEditor: one })._retranslateEditorScriptList();
    expect(one.setAvailableScripts).not.toHaveBeenCalled();
    const routed = editorWith([{ label: '★ Handy: a', path: 'a' }, { label: 'OSR: b', path: 'b' }]);
    Object.assign(new App(), { scriptEditor: routed, _customRoutingActive: true })._retranslateEditorScriptList();
    expect(routed.setAvailableScripts).not.toHaveBeenCalled();
    expect(() => Object.assign(new App(), {})._retranslateEditorScriptList()).not.toThrow();
  });

  it('wired: the language handler calls it; embedded entries carry their axis name', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/this\._retranslatePlayerChrome\(\);\n\s+this\._retranslateEditorScriptList\?\.\(\); \/\/ FT-103/);
    expect(src).toMatch(/embeddedAxis: suffix,\n\s+axisLabel: label\(suffix\),/);
  });
});
