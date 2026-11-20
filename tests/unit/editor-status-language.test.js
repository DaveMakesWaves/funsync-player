/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel (and its status
 * line) in the document, and script-editor.js imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// R3 fix-up (real-app verifier 1, 2026-11-06): the docked editor's status
// line kept the language it was last written in. "44 actions" stayed English
// after a switch to German, and "44 Aktionen" stayed German after a switch to
// French, until the next edit wrote it again. The toolbar's tagged strings
// were re-translated on `language:changed`; the status line is written by
// `_updateStatus()` only, which nothing called there.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests, t } = await import('../../renderer/js/i18n.js');
const { eventBus } = await import('../../renderer/js/event-bus.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

describe('the editor\'s status line follows a language switch (R3 fix-up)', () => {
  it('"3 actions" reads "3 Aktionen" after a switch to German, with no edit in between', () => {
    _setBundlesForTests('en', EN, EN);
    document.body.innerHTML = '<div id="player-container"></div>';
    const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 60, paused: true });
    const ed = new ScriptEditor({
      videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 0 }),
      funscriptEngine: { getActions: () => [], getMetadata: () => null },
      progressBar: { renderHeatmap() {} },
      settings: { get: () => undefined, set() {} },
    });
    ed.editableScript.loadFromData({ version: '1.0', actions: [{ at: 0, pos: 0 }, { at: 500, pos: 100 }, { at: 900, pos: 20 }] });
    ed._updateStatus();
    expect(ed._statusEl.textContent).toBe('3 actions');

    _setBundlesForTests('de', DE, EN);
    eventBus.emit('language:changed', { locale: 'de' });
    expect(ed._statusEl.textContent).toBe(t('editor.status', { count: 3 }));
    expect(ed._statusEl.textContent).toBe('3 Aktionen');
    ed._unsubscribeLanguage?.();
  });
});
