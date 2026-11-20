// Fill with pattern: the drawer's live preview off the window's thread
// (pattern library, Round 2 fix-up; review-2 minor 5). A module Worker that
// runs the SAME pure fill core the editor uses (pattern-fill.js, no DOM), so
// a buzz pattern over a long selection (about 1 s a preview over 10 minutes)
// no longer freezes the window or the renderer-side device sync while the
// slider moves.
//
// Message in:  { id, actions, selection, patternId, options }
//              (actions: the part of the script the fill reads, the window
//              plus one neighbour each side; pattern-fill-drawer.js
//              fillBasisRange)
// Message out: { id, res: { actions, inserted, removed, warnings, stats }, ms }
//              or { id, error } when the core threw.
//
// The drawer keeps one request in flight and shows only the answer to its
// latest request (pattern-fill-drawer.js _post / _onWorkerMessage). Apply
// still lands only a fill whose inputs match the script and the controls as
// they are when the user applies.

import { fillRange } from './pattern-fill.js';
import { PATTERN_SPEED_CEILING } from './pattern-library.js';

/**
 * The options with the speed ceiling held: the drawer sends maxSpeed 600
 * (PATTERN_SPEED_CEILING), and nothing that comes in here can lift it.
 */
export function ceiledOptions(options) {
  const o = options && typeof options === 'object' ? options : {};
  const asked = Number(o.maxSpeed);
  return { ...o, maxSpeed: asked > 0 ? Math.min(asked, PATTERN_SPEED_CEILING) : PATTERN_SPEED_CEILING };
}

self.onmessage = (e) => {
  const m = e.data || {};
  const started = performance.now();
  let res;
  try {
    res = fillRange({ actions: m.actions, selection: m.selection, patternId: m.patternId, options: ceiledOptions(m.options) });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
    return;
  }
  self.postMessage({
    id: m.id,
    res: { actions: res.actions, inserted: res.inserted, removed: res.removed, warnings: res.warnings, stats: res.stats },
    ms: performance.now() - started,
  });
};
