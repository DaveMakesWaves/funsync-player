/**
 * @vitest-environment jsdom
 *
 * FT-104 (found in a real-app re-check, also in v0.9.2; fixed 2026-11-22): on
 * the phone, a playlist, collection or category page whose videos share a
 * folder showed "In folder: {path}" unfilled. The message held
 * <strong>{path}</strong>; the ICU formatter reads <strong> as a rich-text
 * tag, failed, and the raw pattern showed. The tag is out of all 8 messages
 * and the code puts the path in bold, as text (a folder name is never HTML).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { folderJumpLabelParts } from '../../backend/web-remote/folder-index.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));

describe('the phone folder-jump label', () => {
  it.each(LOCALES)('%s: the message formats (no tag in it) and the path lands in bold, as text', (l) => {
    const b = bundle(l);
    expect(b.webRemote.folderJump.label).not.toMatch(/<\/?\w+>/);
    _setBundlesForTests(l, b, bundle('en'));
    const trail = 'Library › <b>Clips</b> & More';
    const host = document.createElement('span');
    host.replaceChildren(...folderJumpLabelParts(t, trail));
    const strong = host.querySelector('strong');
    expect(strong.textContent).toBe(trail);
    expect(strong.children).toHaveLength(0);                     // the folder name stayed text
    expect(host.textContent).not.toContain('{path}');
    expect(host.textContent).not.toContain('⁣');
    expect(host.textContent).toBe(b.webRemote.folderJump.label.replace('{path}', trail));
  });

  it('a translation without {path} still shows the path', () => {
    const parts = folderJumpLabelParts(() => 'In folder', 'Lib');
    const host = document.createElement('span');
    host.replaceChildren(...parts);
    expect(host.textContent).toBe('In folder Lib');
  });

  it('the phone builds the label with it, not innerHTML', () => {
    const src = fs.readFileSync('backend/web-remote/app.js', 'utf8');
    expect(src).toContain('label.replaceChildren(...folderJumpLabelParts(t, trail));');
    expect(src).not.toContain("label.innerHTML = t('webRemote.folderJump.label'");
  });
});
