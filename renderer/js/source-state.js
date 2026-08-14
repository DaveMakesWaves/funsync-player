// Library source state: what the USER wants vs what is actually REACHABLE.
//
// Community report (lnlytrckr, EroScripts #251/#255, 2026-08-11): a source on
// an offline NAS froze the app every 20-30 seconds even with the source
// switched OFF, because the availability probe ignored the toggle and used a
// blocking `existsSync` on a dead `Z:` mapping.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
//
//   `enabled` is written by the USER and NOBODY ELSE.
//
// It is tempting to "auto-disable" an unreachable source by setting
// `enabled = false`. That destroys the user's intent: reconnect the drive and
// we have no idea whether they wanted it on. Dave's requirement was explicit —
// enabled, then a session where it was unreachable, then reachable again,
// must come back ENABLED.
//
// So there are two separate things, and only one of them is persisted:
//
//   enabled    persisted   user intent, "I want this source active"
//   reachable  runtime     "the path answered just now"
//
// and everything downstream keys off the DERIVED value:
//
//   effectiveActive = enabled && reachable
//
// Nothing in this file writes `enabled`. `setUserEnabled` is the single place
// it changes, and it is only ever called from a click handler.

/** A source with no explicit flag is enabled — that is the historical default. */
export function isUserEnabled(source) {
  return !!source && source.enabled !== false;
}

/**
 * Is the path currently reachable?
 *
 * Unknown (not yet probed) counts as REACHABLE, deliberately. A source must not
 * flash as locked-and-unavailable during the first probe, and if the probe
 * never completes we fail open rather than hiding a working library.
 *
 * @param {object} source
 * @param {Set<string>|null} unreachablePaths paths the probe found dead
 */
export function isReachable(source, unreachablePaths) {
  if (!source) return false;
  if (!unreachablePaths || typeof unreachablePaths.has !== 'function') return true;
  return !unreachablePaths.has(source.path);
}

/**
 * The only question the rest of the app should ask: should this source be
 * scanned, counted, and shown right now?
 */
export function isEffectivelyActive(source, unreachablePaths) {
  return isUserEnabled(source) && isReachable(source, unreachablePaths);
}

/**
 * How the row should present. Three states, not two — "off because I turned it
 * off" and "off because the drive is missing" need to look and behave
 * differently, or the user thinks the app forgot their setting.
 *
 * @returns {'active'|'off'|'unreachable'}
 */
export function toggleState(source, unreachablePaths) {
  if (!isReachable(source, unreachablePaths)) return 'unreachable';
  return isUserEnabled(source) ? 'active' : 'off';
}

/** Unreachable sources cannot be toggled — there is nothing to turn on. */
export function isToggleLocked(source, unreachablePaths) {
  return !isReachable(source, unreachablePaths);
}

/**
 * Apply a user toggle. Returns a NEW array; never mutates the input, so a
 * caller cannot accidentally persist a half-applied change.
 *
 * Refuses to change an unreachable source. That refusal is what makes the
 * "remember the last user-set state" requirement hold: while the drive is
 * away, `enabled` is frozen at whatever the user last chose.
 *
 * @returns {{sources: object[], changed: boolean, enabled: boolean|null}}
 */
export function setUserEnabled(sources, sourceId, nextEnabled, unreachablePaths) {
  const list = Array.isArray(sources) ? sources : [];
  const target = list.find((s) => s && s.id === sourceId);
  if (!target) return { sources: list, changed: false, enabled: null };
  if (isToggleLocked(target, unreachablePaths)) {
    return { sources: list, changed: false, enabled: isUserEnabled(target) };
  }
  const value = nextEnabled === undefined ? !isUserEnabled(target) : !!nextEnabled;
  if (value === isUserEnabled(target)) {
    return { sources: list, changed: false, enabled: value };
  }
  return {
    sources: list.map((s) => (s && s.id === sourceId ? { ...s, enabled: value } : s)),
    changed: true,
    enabled: value,
  };
}

/**
 * Which sources are worth probing.
 *
 * THE FIX for the reported freeze: a source the user switched off is never
 * touched at all. Previously the scan honoured the toggle but the probe did
 * not, so a disabled dead NAS still blocked the main process on every refresh
 * and deleting the source was the only escape.
 */
export function sourcesToProbe(sources) {
  return (Array.isArray(sources) ? sources : []).filter(
    (s) => s && typeof s.path === 'string' && s.path && isUserEnabled(s),
  );
}
