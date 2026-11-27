// The new English strings of the editor work list's Check script (4.2) and
// undo history (4.5), 2026-11-24, for the tests to render with until the
// merge step adds them (all 8 locales) to renderer/locales/*.json. Once
// merged, `withEditorToolsStrings` changes nothing: the values are the same.

export const EDITOR_TOOLS_EN = {
  'editor.check.title': 'Check script',
  'editor.check.button': 'Check script for problems',
  'editor.check.summary': '{count, plural, one {# problem found} other {# problems found}}',
  'editor.check.allGood': 'All good',
  'editor.check.allGoodHint': '{count, plural, one {Checked # point, nothing to fix.} other {Checked # points, nothing to fix.}}',
  'editor.check.emptyTitle': 'No points to check',
  'editor.check.emptyHint': 'Add some points, then check again.',
  'editor.check.changed': 'The script changed while this was open, so it was checked again.',
  'editor.check.selectAll': '{count, plural, one {Select # point} other {Select all # points}}',
  'editor.check.more': '{count, plural, one {…and # more, included in the selection above.} other {…and # more, included in the selection above.}}',
  'editor.check.limitsHint': 'Speed limits come from Settings ▸ Keyboard ▸ Editor speed limits.',
  'editor.check.kind.outOfRange': 'Outside 0–100, or before the start',
  'editor.check.kind.notWhole': 'Not whole numbers',
  'editor.check.kind.sameTime': 'Points at the same time',
  'editor.check.kind.tooFast': 'Faster than {limit} units/s',
  'editor.check.kind.tooSlow': 'Slower than {limit} units/s',
  'editor.check.kind.shortStroke': 'Closer than one video frame',
  'editor.check.kind.longGap': 'No points for {seconds} s or more',
  'editor.check.hint.outOfRange': 'Devices only use positions 0 to 100 and times from 0.',
  'editor.check.hint.notWhole': 'Saving rounds these, so the point moves slightly.',
  'editor.check.hint.sameTime': 'Only one point per time can play; the others are skipped.',
  'editor.check.hint.tooFast': "A device can't move this fast: the stroke ends short or late.",
  'editor.check.hint.tooSlow': 'The Handy can stop on a moving stroke this slow.',
  'editor.check.hint.shortStroke': "Points closer than one frame can't sit on separate frames.",
  'editor.check.hint.longGap': 'A long stretch with no points between moving parts. A missing section?',
  'editor.check.detail.speed': '{speed} units/s',
  'editor.check.detail.sameTime': '{count, plural, one {# point} other {# points}}',
  'editor.check.detail.invalid': 'Not a valid point',
  'editor.check.detail.pos': 'Position {pos}',
  'editor.check.detail.time': 'Time {at} ms',
  'editor.check.detail.notWhole': 'Time {at}, position {pos}',
  'editor.check.detail.gap': '{seconds} s without a point',
  'editor.check.detail.short': '{ms} ms apart (a frame is {frame} ms)',
  'editor.history.insert': 'Add point',
  'editor.history.editPoint': 'Change point',
  'editor.history.delete': '{count, plural, one {Delete # point} other {Delete # points}}',
  'editor.history.cut': '{count, plural, one {Cut # point} other {Cut # points}}',
  'editor.history.rippleDelete': '{count, plural, one {Ripple delete # point} other {Ripple delete # points}}',
  'editor.history.move': '{count, plural, one {Move # point} other {Move # points}}',
  'editor.history.drag': 'Drag points',
  'editor.history.moveToPlayhead': 'Move point to playhead',
  'editor.history.paste': '{count, plural, one {Paste # point} other {Paste # points}}',
  'editor.history.pasteExact': '{count, plural, one {Paste # point at its own time} other {Paste # points at their own times}}',
  'editor.history.equalize': 'Equalize spacing',
  'editor.history.invert': '{count, plural, one {Invert # point} other {Invert # points}}',
  'editor.history.simplify': '{count, plural, one {Simplify (# point removed)} other {Simplify (# points removed)}}',
  'editor.history.modify': 'Modify',
  'editor.history.insertPoints': '{count, plural, one {Add # point} other {Add # points}}',
  'editor.history.generatePattern': 'Generate pattern',
  'editor.history.beats': 'Generate from beats',
  'editor.history.fillGaps': 'Fill gaps',
  'editor.history.fill': 'Fill with pattern',
  'editor.history.metadata': 'Edit metadata',
  'editor.history.addBookmark': 'Add bookmark',
  'editor.history.removeBookmark': 'Remove bookmark',
  'editor.history.restore': 'Restore an earlier version',
  'editor.history.edit': 'Edit',
  'editor.history.menuAria': 'Undo history',
  'editor.history.button': 'Undo history',
  'editor.history.undoSteps': '{count, plural, one {Undo # step} other {Undo # steps}}',
  'editor.history.redoSteps': '{count, plural, one {Redo # step} other {Redo # steps}}',
  'editor.history.redoGroup': 'Redo',
  'editor.history.nothing': 'Nothing to undo or redo',
  'editor.history.toastUndone': '{count, plural, one {Undid # step} other {Undid # steps}}',
  'editor.history.toastRedone': '{count, plural, one {Redid # step} other {Redid # steps}}',
};

/** The en bundle with these strings added where it has none (a copy). */
export function withEditorToolsStrings(bundle) {
  const out = JSON.parse(JSON.stringify(bundle || {}));
  for (const [key, text] of Object.entries(EDITOR_TOOLS_EN)) {
    const parts = key.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = (node[p] ||= {});
    const leaf = parts[parts.length - 1];
    if (node[leaf] === undefined) node[leaf] = text;
  }
  return out;
}
