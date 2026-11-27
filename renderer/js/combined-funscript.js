// The combined multi-axis funscript FunSync WRITES (2026-11-24; Dave: "combined
// as the master copy too might as well use the new format"): one file holding
// the stroke and every other axis, used when a video's script is combined
// (Save writes it back this way) and by Export as combined.
//
// The layout is funscript 2.0 from the EroScripts RFC "Single-file multi-axis"
// (topic 267449, the pre-final draft #64):
//   { version: "2.0", actions: <stroke>, channels: { <name>: { actions } }, ... }
// Root `actions` is the stroke, so a single-axis player still plays it.
//
// The same axes are mirrored as `axes: [{ id: <T-Code id>, actions }]`:
// MultiFunPlayer's reader reads ONLY that array, keyed by T-Code id
// (Source/MultiFunPlayer/Script/IScriptReader.cs, read 2026-11-24), while
// XTPlayer reads `channels` by name (XTEngine src/lib/handler/
// funscripthandler.cpp). Neither checks the version string. A FunSync read
// of the file takes each axis once (embedded-multi-axis.js: `axes` first,
// the same points).
//
// Channel names are our companion-file suffixes (#64: `video.<name>.funscript`
// equals channel <name>), except suction, written `suck` (MFP's file suffix
// and the RFC's list). No `channels.stroke` (the root is the stroke), no
// per-channel `range` (dropped in #64).

import { AXIS_DEFINITIONS, getAxisBySuffix } from './multi-axis.js';

/** The version string written (RFC #64). */
export const COMBINED_VERSION = '2.0';

/** The name a channel is written under, from any spelling of an axis. */
export function channelNameFor(suffix) {
  const axis = getAxisBySuffix(suffix);
  return axis ? axis.suffix : null;
}

/** Every key an older combined layout keeps axes under at the top level. */
const AXIS_CONTAINER_KEYS = new Set(['additional_axes', 'axes', 'channels']);

/** Any spelling of an axis name or T-Code id, for spotting sibling-key axes (Format C). */
function isAxisName(key) {
  return typeof key === 'string' && !!getAxisBySuffix(key.toLowerCase());
}

function cleanActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
    .map((a) => ({ at: Math.round(a.at), pos: Math.max(0, Math.min(100, Math.round(a.pos))) }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Build the combined file.
 * @param {object} main  the main (stroke) script as it would be written alone
 *   (EditableScript.toFunscriptJSON, parsed): its `actions` and every other key
 *   (metadata, bookmarks, inverted ...). Keys of an older combined layout
 *   (additional_axes, axes, channels, sibling axis keys, axis entries in `raw`)
 *   are dropped: the axes are written once, in the new layout.
 * @param {Map<string, Array>|Record<string, Array>} axes  suffix (any spelling) -> actions
 * @returns {object} the file, ready for JSON.stringify
 */
export function buildCombinedFunscript(main, axes) {
  const out = {};
  for (const [key, value] of Object.entries(main || {})) {
    if (AXIS_CONTAINER_KEYS.has(key)) continue;
    if (key === 'actions') continue;
    if (key === 'raw' && value && typeof value === 'object' && !Array.isArray(value)) {
      const rest = Object.fromEntries(Object.entries(value).filter(([k]) => !isAxisName(k)));
      if (Object.keys(rest).length) out.raw = rest;
      continue;
    }
    if (isAxisName(key)) continue;
    out[key] = value;
  }
  out.version = COMBINED_VERSION;
  out.actions = cleanActions(main?.actions);

  const byName = new Map();
  const entries = axes instanceof Map ? [...axes.entries()] : Object.entries(axes || {});
  for (const [suffix, actions] of entries) {
    const name = channelNameFor(suffix);
    const clean = cleanActions(actions);
    if (!name || clean.length === 0) continue;     // an axis with no points has nothing to play
    byName.set(name, clean);
  }
  const channels = {};
  const mirror = [];
  for (const def of AXIS_DEFINITIONS) {             // one fixed order: L1, L2, R0, R1, R2, V0, V1, A0, A1, A2
    const actions = byName.get(def.suffix);
    if (!actions) continue;
    channels[def.suffix] = { actions };
    mirror.push({ id: def.tcode, actions });
  }
  if (mirror.length) {
    out.channels = channels;
    out.axes = mirror;
  }
  return out;
}

/**
 * The separate files for the same set (Export as separate files): the main
 * script under its own name, each axis as `<base>.<suffix>.funscript`.
 * @param {object} main  as for buildCombinedFunscript
 * @param {Map<string, Array>|Record<string, Array>} axes
 * @param {string} base  the file name without `.funscript`
 * @returns {Array<{ name: string, content: object }>}
 */
export function buildSeparateFunscripts(main, axes, base) {
  const files = [];
  const mainOut = {};
  for (const [key, value] of Object.entries(main || {})) {
    if (AXIS_CONTAINER_KEYS.has(key) || isAxisName(key)) continue;
    if (key === 'raw' && value && typeof value === 'object' && !Array.isArray(value)) {
      const rest = Object.fromEntries(Object.entries(value).filter(([k]) => !isAxisName(k)));
      if (Object.keys(rest).length) mainOut.raw = rest;
      continue;
    }
    mainOut[key] = value;
  }
  mainOut.actions = cleanActions(main?.actions);
  if (!mainOut.version || mainOut.version === COMBINED_VERSION) mainOut.version = '1.0';
  files.push({ name: `${base}.funscript`, content: mainOut });
  const entries = axes instanceof Map ? [...axes.entries()] : Object.entries(axes || {});
  const seen = new Set();
  for (const [suffix, actions] of entries) {
    const name = channelNameFor(suffix);
    const clean = cleanActions(actions);
    if (!name || clean.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const content = { version: '1.0', actions: clean };
    if (main?.metadata && typeof main.metadata === 'object') content.metadata = { ...main.metadata };
    files.push({ name: `${base}.${name}.funscript`, content });
  }
  return files;
}
