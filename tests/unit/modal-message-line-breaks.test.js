/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Modal renders into a document with the REAL
 * modal.css applied, so getComputedStyle reads the cascade the message gets
 * (notes/CLAUDE.md "Test environments").
 */
// FT-080 (also in v0.9.2): confirm dialogs lost their line breaks. Modal sets
// the message with textContent, and `.modal-message` had no white-space rule,
// so the two paragraphs of the overlapping-source questions ("... will
// double-count every video.\n\nAdd anyway?") ran together on one line.
// `white-space: pre-line` keeps a message's own breaks; runs of spaces still
// collapse, so a message with none looks exactly as before.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { Modal } from '../../renderer/components/modal.js';

const CSS = fs.readFileSync('renderer/styles/modal.css', 'utf8');
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const B = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'))]));

const flush = () => new Promise((r) => setTimeout(r, 0));
const top = () => [...document.querySelectorAll('.modal-overlay')].at(-1);
const message = () => top().querySelector('.modal-message');

beforeEach(() => {
  _setBundlesForTests('en', B.en, B.en);
  document.head.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(async () => {
  while (top()) {
    top().querySelector('.modal-close-btn').click();
    await flush();
  }
});
afterAll(() => _setBundlesForTests('en', B.en, B.en));

describe('a dialog message keeps its own line breaks (FT-080)', () => {
  it('Modal.confirm: the message keeps "\\n\\n" and is laid out pre-line', async () => {
    Modal.confirm('Title', 'first paragraph\n\nsecond paragraph');
    await flush();
    expect(message().textContent).toBe('first paragraph\n\nsecond paragraph');
    expect(getComputedStyle(message()).whiteSpace).toBe('pre-line');
  });

  it('Modal.alert too (same class)', async () => {
    Modal.alert('Title', 'a\nb');
    await flush();
    expect(getComputedStyle(message()).whiteSpace).toBe('pre-line');
  });

  for (const locale of LOCALES) {
    it(`the overlapping-source questions keep two paragraphs in ${locale}`, async () => {
      _setBundlesForTests(locale, B[locale], B.en);
      Modal.confirm(
        t('settingsPanel.sources.childOverlapTitle'),
        t('settingsPanel.sources.childOverlapBody', { path: 'E:\\Lib\\Sub', parentName: 'Lib', parentPath: 'E:\\Lib' }),
        { confirmText: t('settingsPanel.sources.addAnyway') },
      );
      await flush();
      expect(message().textContent.split('\n\n')).toHaveLength(2);
      expect(getComputedStyle(message()).whiteSpace).toBe('pre-line');
      Modal.confirm(
        t('settingsPanel.sources.parentOverlapTitle'),
        t('settingsPanel.sources.parentOverlapBody', { path: 'E:\\', count: 2, names: '"A", "B"' }),
        { confirmText: t('settingsPanel.sources.parentOverlapConfirm') },
      );
      await flush();
      expect(message().textContent).toMatch(/\n\n/);
      expect(getComputedStyle(message()).whiteSpace).toBe('pre-line');
    });
  }
});
