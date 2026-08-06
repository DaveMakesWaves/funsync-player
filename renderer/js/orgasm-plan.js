// Orgasm Switch — plan resolution (multi-axis + custom routing support).
//
// The orgasm script config is a full association entry (association-shape.js
// — the SAME parallel-slot shape videos use: single / multi / custom held
// losslessly with an `active` pointer). This module turns that entry plus a
// snapshot of currently-connected devices into a concrete PLAN the
// OrgasmSwitch tick loop can drive, with graceful degradation:
//
//   active=single → single plan (main stroke broadcast — today's behavior).
//   active=multi  → multi plan. Never gated: a missing axis device is just a
//                   silent channel, exactly like video playback.
//   active=custom → custom plan ONLY when every route's device is connected
//                   (Buttplug routes matched via the shared two-pass
//                   index-then-name matcher). ANY route unmatched → demote to
//                   a single plan (entry.single, else the custom main route's
//                   script) so the finisher always works on whatever IS
//                   connected. The app re-resolves on device connect/
//                   disconnect, so satisfying the routes flips it back to
//                   custom automatically.
//
// Custom-mode kind semantics (mirrors video custom routing where sensible):
//   - A kind (buttplug / tcode / handy) WITH routes: only routed devices are
//     driven, with their routed scripts; unrouted Buttplug devices stay
//     silent for the hold (same as _customRoutingActive in normal playback).
//   - A kind with NO routes: its sync engine is left running, so those
//     devices keep playing the MAIN video script through the hold (the user
//     deliberately scoped the finisher to other hardware). Exposed via
//     `stops*` flags — the app's onActivate consults them.
//
// Pure + injected (`getActions(path)` supplies parsed actions from the app's
// content cache) so resolution is synchronous, cheap to re-run on device
// events, and unit-testable without devices or file I/O.

import { matchButtplugRoute } from './custom-routing-match.js';
import { AXIS_DEFINITIONS } from './multi-axis.js';
import { stripBOM } from './funscript-engine.js';

/** suffix → TCode channel, same table `_loadMultiAxisScripts` uses. */
const SUFFIX_TO_TCODE = Object.fromEntries(
  AXIS_DEFINITIONS.map((a) => [a.suffix, a.tcode]),
);

/**
 * Parse a finisher funscript's raw JSON into clean sorted actions.
 * Same validation rules as OrgasmSwitch.loadScript (BOM strip, finite
 * at/pos, >= 2 actions, positive duration). Returns null when unusable.
 */
export function parseFinisherActions(rawContent) {
  if (typeof rawContent !== 'string' || rawContent.length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(stripBOM(rawContent)); } catch { return null; }
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : null;
  if (!actions) return null;
  const clean = actions
    .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
    .sort((a, b) => a.at - b.at);
  if (clean.length < 2) return null;
  if (!(clean[clean.length - 1].at > 0)) return null;
  return clean;
}

const displayNameOf = (p) => (p ? String(p).split(/[\\/]/).pop() : '');

function durationOf(actions) {
  return actions && actions.length ? actions[actions.length - 1].at : 0;
}

/**
 * Build a single-axis plan: main stroke broadcast to every connected device
 * kind — byte-for-byte today's OrgasmSwitch behavior.
 */
function buildSinglePlan(path, getActions) {
  const main = path ? getActions(path) : null;
  if (!main) return null;
  return {
    mode: 'single',
    main,
    mainPath: path,
    loopMs: durationOf(main),
    tcodeAxes: { L0: main },
    vib: null,
    bpMode: 'broadcast',
    bpRoutes: null,
    handyPath: path,
    stopsButtplug: true,
    stopsTcode: true,
    stopsHandy: true,
  };
}

function buildMultiPlan(multi, getActions) {
  const main = multi.main ? getActions(multi.main) : null;
  const tcodeAxes = {};
  if (main) tcodeAxes.L0 = main;
  let vib = null;
  let longest = durationOf(main);
  for (const [suffix, axisPath] of Object.entries(multi.axes || {})) {
    if (!axisPath) continue;
    const tcode = SUFFIX_TO_TCODE[suffix];
    if (!tcode) continue;
    const actions = getActions(axisPath);
    if (!actions) continue;
    tcodeAxes[tcode] = actions;
    longest = Math.max(longest, durationOf(actions));
    if (suffix === 'vib' && multi.buttplugVib) vib = actions;
  }
  if (Object.keys(tcodeAxes).length === 0) return null;
  return {
    mode: 'multi',
    main,
    mainPath: multi.main || null,
    // No main script → axis-only bundle; the longest axis sets the loop
    // length (all channels share ONE clock; shorter scripts clamp-and-hold
    // — deliberately NOT per-script modulo, which de-phases choreographed
    // axes a little more on every wrap).
    loopMs: main ? durationOf(main) : longest,
    tcodeAxes,
    vib,
    bpMode: 'broadcast',
    bpRoutes: null,
    handyPath: multi.main || null,
    stopsButtplug: true,
    stopsTcode: true,
    stopsHandy: !!multi.main,
  };
}

/**
 * Try to build a custom plan. Returns { plan } on full success or
 * { missing: [labels] } when any route can't be satisfied (device not
 * connected / not matched / script unreadable) — the caller then demotes.
 */
function buildCustomPlan(custom, snapshot, getActions) {
  const routes = (custom.routes || []).filter((r) => r && r.scriptPath);
  if (routes.length === 0) return { missing: [] };

  const missing = [];
  const bpRoutes = [];
  let tcodeActions = null;
  let handyPath = null;
  let mainActions = null;
  let mainPath = null;
  let longest = 0;

  // Two-pass Buttplug matching with a claim set — same strategy as
  // _applyCustomRoutingAssignments: authoritative index-hits claim devices
  // first, then name-fallback for the rest, so two same-name devices can't
  // have one stolen by the other's fallback. Reuses the shared matcher
  // (safety: a stale index after an Intiface restart must never silently
  // drive the wrong hardware).
  const bpDevices = snapshot.buttplugDevices || [];
  const claimed = new Set();
  const resolvedIndex = new Map();  // route → device index (no route mutation — routes belong to settings)
  const bpPending = [];
  const wantedBp = routes.filter((r) => r.deviceId?.startsWith('buttplug:'));
  for (const route of wantedBp) {
    const dev = Number.isFinite(route.buttplugIndex)
      ? bpDevices.find((d) => d.index === route.buttplugIndex)
      : null;
    if (dev && `buttplug:${dev.name}` === route.deviceId) {
      claimed.add(dev.index);
      resolvedIndex.set(route, dev.index);
    } else {
      bpPending.push(route);
    }
  }
  for (const route of bpPending) {
    const match = matchButtplugRoute(route, bpDevices, { excludeIndices: claimed });
    if (match) {
      claimed.add(match.dev.index);
      resolvedIndex.set(route, match.dev.index);
    }
  }

  for (const route of routes) {
    const label = route.scriptName || displayNameOf(route.scriptPath);
    const actions = getActions(route.scriptPath);
    if (!actions) {
      missing.push(label);
      continue;
    }
    let matched = false;
    if (route.deviceId === 'handy') {
      if (snapshot.handyConnected) { handyPath = handyPath || route.scriptPath; matched = true; }
    } else if (route.deviceId === 'tcode') {
      if (snapshot.tcodeConnected) { tcodeActions = tcodeActions || actions; matched = true; }
    } else if (route.deviceId?.startsWith('buttplug:')) {
      const idx = resolvedIndex.get(route);
      if (Number.isFinite(idx)) {
        bpRoutes.push({
          deviceIndex: idx,
          actions,
          name: route.deviceId.slice('buttplug:'.length),
        });
        matched = true;
      }
    }
    // Unknown deviceIds (autoblow, hand-edited configs) are unmatchable —
    // the finisher loop has no drive path for them.
    if (!matched) {
      missing.push(route.deviceId === 'handy' ? 'The Handy'
        : route.deviceId === 'tcode' ? 'T-Code'
        : route.deviceId?.startsWith('buttplug:') ? route.deviceId.slice('buttplug:'.length)
        : (route.deviceId || label));
      continue;
    }
    longest = Math.max(longest, durationOf(actions));
    if (route.role === 'main') { mainActions = actions; mainPath = route.scriptPath; }
  }

  if (missing.length > 0) return { missing };

  return {
    plan: {
      mode: 'custom',
      // Main-role script anchors the loop length; a config without a main
      // role (defensive — the modal always writes one) uses the longest.
      main: mainActions,
      mainPath,
      loopMs: mainActions ? durationOf(mainActions) : longest,
      tcodeAxes: tcodeActions ? { L0: tcodeActions } : {},
      vib: null,
      bpMode: bpRoutes.length > 0 ? 'routed' : 'keep',
      bpRoutes: bpRoutes.length > 0 ? bpRoutes : null,
      handyPath,
      // A kind with no routes keeps its engine running (devices continue
      // the MAIN video script through the hold — the user scoped the
      // finisher to other hardware).
      stopsButtplug: bpRoutes.length > 0,
      stopsTcode: !!tcodeActions,
      stopsHandy: !!handyPath,
    },
  };
}

/**
 * Resolve the orgasm config entry + device snapshot into a drive plan.
 *
 * @param {object|null} entry — normalized association entry (association-shape.js)
 * @param {object} snapshot — { buttplugDevices: [{index,name,...}], tcodeConnected, handyConnected }
 * @param {(path: string) => Array|null} getActions — parsed actions for a
 *   script path (from the app's content cache), null when unavailable
 * @returns {{ plan: object|null, demotedFrom: 'custom'|null, missing: string[] }}
 */
export function resolveOrgasmPlan(entry, snapshot, getActions) {
  const none = { plan: null, demotedFrom: null, missing: [] };
  if (!entry || !entry.active) return none;

  if (entry.active === 'single') {
    return { ...none, plan: buildSinglePlan(entry.single, getActions) };
  }

  if (entry.active === 'multi') {
    return { ...none, plan: entry.multi ? buildMultiPlan(entry.multi, getActions) : null };
  }

  if (entry.active === 'custom') {
    if (!entry.custom) return none;
    const result = buildCustomPlan(entry.custom, snapshot, getActions);
    if (result.plan) return { ...none, plan: result.plan };
    // Demote: single-axis fallback on whatever IS connected. The single
    // slot wins if the user filled it; otherwise the custom MAIN route's
    // script is what "single axis" means for this config.
    const mainRoute = (entry.custom.routes || []).find((r) => r?.role === 'main' && r.scriptPath);
    const fallbackPath = entry.single || mainRoute?.scriptPath || null;
    return {
      plan: buildSinglePlan(fallbackPath, getActions),
      demotedFrom: 'custom',
      missing: result.missing,
    };
  }

  return none;
}

/**
 * Collect every script path an entry references (all slots, not just the
 * active one — mode switches and demotion fallbacks must not wait on I/O).
 * The app preloads these into its content cache.
 */
export function collectOrgasmScriptPaths(entry) {
  const paths = new Set();
  if (!entry) return [];
  if (entry.single) paths.add(entry.single);
  if (entry.multi) {
    if (entry.multi.main) paths.add(entry.multi.main);
    for (const p of Object.values(entry.multi.axes || {})) {
      if (p) paths.add(p);
    }
  }
  for (const r of entry.custom?.routes || []) {
    if (r?.scriptPath) paths.add(r.scriptPath);
  }
  return [...paths];
}

/**
 * Short human summary of an entry for the settings row, e.g.
 * "finisher.funscript · Multi-axis (3 axes)". Locale-free — the caller
 * wraps mode names in i18n.
 */
export function describeOrgasmEntry(entry) {
  if (!entry || !entry.active) return null;
  if (entry.active === 'single') {
    return entry.single ? { mode: 'single', name: displayNameOf(entry.single), count: 0 } : null;
  }
  if (entry.active === 'multi') {
    if (!entry.multi) return null;
    const axes = Object.values(entry.multi.axes || {}).filter(Boolean).length;
    const name = displayNameOf(entry.multi.main) || null;
    if (!name && axes === 0) return null;
    return { mode: 'multi', name: name || '', count: axes };
  }
  if (entry.active === 'custom') {
    const routes = (entry.custom?.routes || []).filter((r) => r?.scriptPath).length;
    if (routes === 0) return null;
    const mainRoute = entry.custom.routes.find((r) => r?.role === 'main');
    return { mode: 'custom', name: displayNameOf(mainRoute?.scriptPath) || '', count: routes };
  }
  return null;
}
