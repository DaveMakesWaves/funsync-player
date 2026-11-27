/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// In the editor, Up goes to the NEXT action and Down to the PREVIOUS one, as
// in OpenFunscripter (next_action = UpArrow, prev_action = DownArrow, Ctrl
// for every script: OFS src/OpenFunscripter.cpp registerBindings).
// TedBaxter, Discord #bug-reports, 2026-11-22: "pressing the up key selects
// the previous point not the next one along the timeline. In OpenFunScripter,
// if you press the Up key it goes the next point." Both editors, read from
// their REAL source (the copy in editor-improvements.test.js passed with the
// direction wrong).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/** The text of one `case '<key>':` block of a switch, up to the next case. */
function caseBlock(src, key) {
  const start = src.indexOf(`case '${key}':`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = src.slice(start + 6);
  const next = rest.search(/\n\s*case '/);
  return rest.slice(0, next > -1 ? next : undefined);
}

describe('Up = next action, Down = previous (OFS)', () => {
  it('the docked editor', () => {
    const src = fs.readFileSync('renderer/components/script-editor.js', 'utf8').replace(/\r\n/g, '\n');
    const up = caseBlock(src, 'ArrowUp');
    const down = caseBlock(src, 'ArrowDown');
    expect(up).toMatch(/this\._selectAdjacentAction\(1\)/);
    expect(up).toMatch(/this\._selectAdjacentActionAcrossScripts\(1\)/);
    expect(down).toMatch(/this\._selectAdjacentAction\(-1\)/);
    expect(down).toMatch(/this\._selectAdjacentActionAcrossScripts\(-1\)/);
    // Shift still nudges the position up / down.
    expect(up).toMatch(/const delta = ctrl \? 1 : 5;/);
    expect(down).toMatch(/const delta = ctrl \? -1 : -5;/);
  });

  it('the editor pop-out', () => {
    const src = fs.readFileSync('renderer/editor-popout.js', 'utf8').replace(/\r\n/g, '\n');
    expect(caseBlock(src, 'ArrowUp')).toMatch(/selectAdjacentAction\(1\)/);
    expect(caseBlock(src, 'ArrowDown')).toMatch(/selectAdjacentAction\(-1\)/);
  });

  it('the shortcut list says it the same way round', () => {
    const help = fs.readFileSync('renderer/js/keyboard-help.js', 'utf8');
    expect(help).toContain("['Down / Up',           t('kbd.editorPrevNextAction')]");
  });
});
