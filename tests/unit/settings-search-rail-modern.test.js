/**
 * @vitest-environment node
 * No DOM required: reads the stylesheet text (see below).
 */
// Test day 2026-11-24 (S002): with a Settings search running, the rail still
// looked like it marked the area Settings opened on (Library), while the
// only result was under Appearance. The plain style clears the mark while
// searching (modal.css); the Modern style's background for the current area
// (modern-polish.css, more specific) was never cleared.
//
// jsdom cannot paint this: it resolves no var() and its CSS parser stops
// after two rules of modern-polish.css. So the text is read: the Modern
// style must undo, while searching, every property it sets on the current
// area, later in the file (seen live in the app on 2026-11-24).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../../renderer/styles/modern-polish.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector) {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const props = {};
  for (const decl of m[2].split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) props[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return { at: m.index, props };
}

describe('the Settings rail while searching (S002)', () => {
  it('Modern: whatever marks the current area is undone while searching, later in the file', () => {
    const mark = block(':root[data-style="modern"] .settings-panel__rail-item--active');
    const undo = block(':root[data-style="modern"] .settings-panel__layout--searching .settings-panel__rail-item--active');
    expect(mark).toBeTruthy();
    expect(undo).toBeTruthy();
    for (const prop of Object.keys(mark.props)) expect(undo.props[prop], prop).toBeTruthy();
    expect(undo.props.background).toBe('transparent');
    expect(undo.at).toBeGreaterThan(mark.at);
  });
});
