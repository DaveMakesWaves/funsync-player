import { describe, it, expect, beforeEach } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';
import { generatePattern } from '../../renderer/js/script-modifiers.js';
import { detectGaps, fillGaps } from '../../renderer/js/gap-filler.js';

describe('Pattern stamp workflow', () => {
  let script;

  beforeEach(() => {
    script = new EditableScript();
  });

  it('inserts generated pattern via insertActions', () => {
    const pattern = generatePattern('sine', 0, 2000, 60, 0, 100);
    script.insertActions(pattern);
    expect(script.actionCount).toBe(pattern.length);
    expect(script.dirty).toBe(true);
  });

  it('selects inserted actions after pattern stamp', () => {
    script.insertAction(5000, 50); // existing action
    const pattern = generatePattern('sawtooth', 0, 2000, 60, 0, 100);
    script.insertActions(pattern);
    expect(script.selectedIndices.size).toBe(pattern.length);
  });

  it('is undoable as a single operation', () => {
    script.insertAction(0, 50);
    script.markSaved();
    const pattern = generatePattern('triangle', 1000, 3000, 120, 0, 100);
    script.insertActions(pattern);
    const countAfterStamp = script.actionCount;
    expect(countAfterStamp).toBeGreaterThan(1);
    script.undo();
    expect(script.actionCount).toBe(1);
    expect(script.actions[0]).toEqual({ at: 0, pos: 50 });
  });
});

describe('Fill gaps workflow', () => {
  let script;

  beforeEach(() => {
    script = new EditableScript();
    // Create a script with a gap
    script.insertAction(0, 0);
    script.insertAction(1000, 100);
    // Gap: 1000 to 10000
    script.insertAction(10000, 0);
    script.insertAction(11000, 100);
  });

  it('detects and fills gaps', () => {
    const gaps = detectGaps(script.actions, 2000);
    expect(gaps.length).toBe(1);

    const filled = fillGaps(gaps, 'sine', 120, 0, 100);
    expect(filled.length).toBeGreaterThan(0);

    script.insertActions(filled);
    expect(script.actionCount).toBeGreaterThan(4);
  });

  it('fill gaps is undoable', () => {
    const gaps = detectGaps(script.actions, 2000);
    const filled = fillGaps(gaps, 'sine', 120, 0, 100);
    script.insertActions(filled);
    const filledCount = script.actionCount;
    script.undo();
    expect(script.actionCount).toBe(4);
  });

  it('applyModifier works with halfSpeed on selection', () => {
    const { halfSpeed } = require('../../renderer/js/script-modifiers.js');
    script.selectAll();
    script.applyModifier(halfSpeed);
    expect(script.actionCount).toBeLessThan(4);
    expect(script.dirty).toBe(true);
  });

  it('applyModifier works with reverseActions on all', () => {
    const { reverseActions } = require('../../renderer/js/script-modifiers.js');
    script.applyModifier(reverseActions);
    // After reverse, first action should have mirrored pos
    expect(script.actions[0].pos).toBe(0); // was 100 at end → 100-100=0
    expect(script.actions[script.actionCount - 1].pos).toBe(100); // was 0 at start → 100-0=100
  });
});
