/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its toolbar and Select menu
 * on the DOM, and script-editor.js imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// R3-27 (found while CB-04): the German docked editor named one key two
// ways. Zoom Out read "Verkleinern (Strg+-)" (the `keys.ctrl` word, as the
// `?` list and Settings write it) while Undo, Redo, Invert, Cut, Save and
// the Select menu said "(Ctrl+Z)" and so on; the Select menu's "before /
// after playhead" items also said "Left" / "Right" in English in every
// language. Each tooltip and menu item of the real editor is read in each
// locale: every word of a chord in its parentheses is that locale's own
// `keys.*` word (the `?` overlay's), never the English one it replaces.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const BUNDLE = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));
// The English word for each `keys.*` id a chord can contain.
const EN_WORD = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', arrowLeft: 'Left', arrowRight: 'Right', arrowUp: 'Up', arrowDown: 'Down' };

document.body.innerHTML = '<div id="player-container"></div>';

function texts(locale) {
  _setBundlesForTests(locale, BUNDLE[locale], BUNDLE.en);
  document.getElementById('player-container').innerHTML = '';
  const video = Object.assign(new EventTarget(), { currentTime: 0, duration: 60, paused: true });
  const ed = new ScriptEditor({
    videoPlayer: Object.assign(new EventTarget(), { video, duration: 60, currentTime: 0 }),
    funscriptEngine: { getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  const out = [];
  for (const el of ed._panel.querySelectorAll('[title]')) out.push(el.getAttribute('title'));
  for (const el of ed._panel.querySelectorAll('option')) out.push(el.textContent);
  return out;
}

/** The chord in a label's last parentheses, split into its words: "Strg+Alt+Pfeil links" → ['Strg', 'Alt', 'Pfeil links']. */
function chordWords(label) {
  const m = /\(([^()]*\+[^()]*)\)\s*$/.exec(label);
  if (!m) return null;
  return m[1].split('+').filter(Boolean);
}

describe('editor tooltips name keys with the locale\'s own words (R3-27)', () => {
  it('the check finds the chords it must check (Undo, Save, the Select menu)', () => {
    const labels = texts('de').filter((s) => chordWords(s));
    expect(labels.length).toBeGreaterThanOrEqual(10);
    expect(labels).toContain(BUNDLE.de.editor.btn.undo);
    expect(labels).toContain(BUNDLE.de.editor.select.beforePlayhead);
  });

  // English is the canonical form ("Left" and "Left Arrow" are both its own).
  it.each(LOCALES.filter((l) => l !== 'en'))('%s: no chord mixes in the English word where the locale has its own', (locale) => {
    const keys = BUNDLE[locale].keys;
    const replaced = Object.entries(EN_WORD).filter(([id, en]) => keys[id] && keys[id] !== en).map(([, en]) => en);
    const bad = [];
    for (const label of texts(locale)) {
      const words = chordWords(label);
      if (!words) continue;
      for (const w of words) if (replaced.includes(w)) bad.push(`${label}  [${w}]`);
    }
    expect(bad).toEqual([]);
  });

  // R3 fix-up (real-app verifier 1): a single key in parentheses too. German
  // said "Auswahl löschen (Del)" and Spanish "Eliminar selección (Del)" while
  // their `keys.delete` (the `?` list's word) is Entf / Supr.
  it.each(LOCALES.filter((l) => BUNDLE[l].keys.delete !== BUNDLE.en.keys.delete))('%s: the Delete key is the locale\'s own word in the tooltips too', (locale) => {
    const own = BUNDLE[locale].keys.delete;
    const labels = texts(locale);
    expect(labels.filter((s) => /\((Del|Delete)\)\s*$/.test(s))).toEqual([]);
    expect(labels).toContain(`${BUNDLE[locale].editor.btn.delete}`);
    expect(BUNDLE[locale].editor.btn.delete.endsWith(`(${own})`)).toBe(true);
  });

  it('German reads Strg in every editor tooltip, the arrows as Pfeil links / rechts', () => {
    const de = BUNDLE.de;
    const labels = texts('de');
    expect(labels).toContain(`${de.editor.btn.undo}`);
    expect(de.editor.btn.undo).toBe('Rückgängig (Strg+Z)');
    expect(de.editor.btn.save).toBe('Speichern (Strg+S)');
    expect(de.editor.select.beforePlayhead).toBe(`Vor dem Abspielkopf auswählen (${de.keys.ctrl}+Alt+${de.keys.arrowLeft})`);
    expect(labels.filter((s) => /\(Ctrl\+/.test(s))).toEqual([]);
  });
});
