// Group a topic's funscript attachments into downloadable script sets.
//
// EroScripts posts follow the same `<base>.<suffix>.funscript` convention
// the app already parses, so a multi-axis post arrives as a main script plus
// axis companions:
//
//   Izzy Green POV.funscript
//   Izzy Green POV.roll.funscript
//   Izzy Green POV.pitch.funscript
//
// But a post is NOT reliably one set. Real example, a 15-attachment ASMR
// topic: several independent scripts for different scenes, two variants of
// one scene, and exactly one axis companion buried among them. Presenting
// that as a flat file list — or auto-picking a "the" script — gets it wrong
// in several directions at once, so grouping happens here, in a pure module,
// where the awkward shapes can be tested.
//
// Community request, 2026-08-06.

import { parseAxisSuffix, getBaseName, AXIS_DEFINITIONS } from './multi-axis.js';

/** Canonical axis ordering, so display never depends on upload order. */
const _axisOrder = new Map(AXIS_DEFINITIONS.map((a, i) => [a.suffix, i]));

/**
 * @typedef {{name: string, url: string}} Attachment
 * @typedef {{axis: object, name: string, url: string}} AxisFile
 * @typedef {{
 *   base: string,
 *   main: Attachment|null,
 *   axes: AxisFile[],
 *   extras: Attachment[],
 *   isMultiAxis: boolean,
 *   canAssociateMulti: boolean
 * }} ScriptGroup
 */

/**
 * Group attachments by base name.
 *
 * @param {Attachment[]} attachments as returned by `getTopicAttachments`
 * @returns {{groups: ScriptGroup[], unsupported: Array<{name: string, url: string, reason: string}>}}
 */
export function groupAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const unsupported = [];
  /** @type {Map<string, ScriptGroup & {_order: number}>} */
  const byBase = new Map();
  let order = 0;

  for (const att of list) {
    if (!att || typeof att.name !== 'string' || !att.name) continue;
    const name = att.name;

    if (/\.zip$/i.test(name)) {
      // Collected by the API but nothing extracts them. Surfaced so the UI
      // can say so, rather than downloading an archive the app can't use.
      unsupported.push({ name, url: att.url, reason: 'zip' });
      continue;
    }
    if (!/\.funscript$/i.test(name)) continue;

    const base = getBaseName(name);
    // Case-insensitive key so `Video.funscript` and `Video.Roll.funscript`
    // land together, while the displayed base keeps its original casing.
    const key = base.toLowerCase();

    let group = byBase.get(key);
    if (!group) {
      group = { base, main: null, axes: [], extras: [], isMultiAxis: false, canAssociateMulti: false, _order: order++ };
      byBase.set(key, group);
    }

    const axis = parseAxisSuffix(name);
    if (axis) {
      group.axes.push({ axis, name, url: att.url });
    } else if (!group.main) {
      group.main = { name, url: att.url };
      // The main file is the authority on how the base is spelled.
      group.base = base;
    } else {
      // A second suffix-less file for the same base. Shouldn't normally
      // happen, but dropping it silently would lose a script — surface it.
      group.extras.push({ name, url: att.url });
    }
  }

  const groups = [...byBase.values()].map((g) => {
    g.axes.sort((a, b) => (_axisOrder.get(a.axis.suffix) ?? 99) - (_axisOrder.get(b.axis.suffix) ?? 99));
    g.isMultiAxis = g.axes.length > 0;
    // A multi-axis association needs a main to hang the axes off. An axis
    // file with no main is a broken post, not a multi set.
    g.canAssociateMulti = g.isMultiAxis && !!g.main;
    return g;
  });

  // Multi-axis sets first — in a 15-attachment post the one set with
  // companions is what the user came for. Ties keep first-appearance order,
  // which is the scripter's own ordering.
  groups.sort((a, b) => (Number(b.isMultiAxis) - Number(a.isMultiAxis)) || (a._order - b._order));
  for (const g of groups) delete g._order;

  return { groups, unsupported };
}

/**
 * Axis labels for a group, in canonical order — e.g. `['Roll', 'Pitch']`.
 * The UI joins and localises around these; the labels themselves are the
 * axis names from AXIS_DEFINITIONS.
 */
export function axisLabels(group) {
  return (group?.axes || []).map((a) => a.axis.label);
}

/**
 * Build the `multi` half of an association from a group.
 *
 * Shape matches `association-shape.js`: `{ main, axes }` where `axes` is
 * keyed by axis suffix. Paths are supplied by the caller after download,
 * since this module never touches the filesystem.
 *
 * @param {ScriptGroup} group
 * @param {(attachmentName: string) => string} pathFor resolves a downloaded
 *   file's on-disk path from its attachment name
 * @returns {{main: string, axes: Record<string, string>}|null}
 */
export function buildMultiAssociation(group, pathFor) {
  if (!group?.canAssociateMulti || typeof pathFor !== 'function') return null;
  const main = pathFor(group.main.name);
  if (!main) return null;

  const axes = {};
  for (const entry of group.axes) {
    const p = pathFor(entry.name);
    // Skip an axis whose download failed rather than writing a dangling
    // path — a partial multi set still drives its remaining axes.
    if (p) axes[entry.axis.suffix] = p;
  }
  return { main, axes };
}
