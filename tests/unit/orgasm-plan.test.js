// Tests for orgasm-plan.js — resolution of the orgasm config entry
// (single / multi / custom, association-shape) + device snapshot into a
// drive plan, including the custom→single demotion when routed devices are
// missing and the automatic promotion back once they're all connected.

import { describe, it, expect } from 'vitest';
import {
  parseFinisherActions,
  resolveOrgasmPlan,
  collectOrgasmScriptPaths,
  describeOrgasmEntry,
} from '../../renderer/js/orgasm-plan.js';
import { buildAssociationEntry } from '../../renderer/js/association-shape.js';

const MAIN = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }];
const TWIST = [{ at: 0, pos: 50 }, { at: 1500, pos: 90 }];
const VIB = [{ at: 0, pos: 20 }, { at: 2000, pos: 80 }];
const ROUTED = [{ at: 0, pos: 10 }, { at: 800, pos: 95 }];

const LIB = {
  'C:/f/main.funscript': MAIN,
  'C:/f/main.twist.funscript': TWIST,
  'C:/f/main.vib.funscript': VIB,
  'C:/f/vibe-route.funscript': ROUTED,
};
const getActions = (p) => LIB[p] || null;

// Realistic device snapshot shapes — index/name mirror what
// buttplug-manager exposes and what custom-routing-match.js consumes.
const SNAP_ALL = {
  buttplugDevices: [
    { index: 0, name: 'Stroker', canLinear: true },
    { index: 3, name: 'Hush', canVibrate: true },
  ],
  tcodeConnected: true,
  handyConnected: true,
};
const SNAP_NONE = { buttplugDevices: [], tcodeConnected: false, handyConnected: false };

const customEntry = (routes, single = null) =>
  buildAssociationEntry('custom', single, null, { routes });

const ROUTES = [
  { role: 'main', deviceId: 'buttplug:Stroker', buttplugIndex: 0, scriptPath: 'C:/f/main.funscript' },
  { role: 'axis', deviceId: 'buttplug:Hush', buttplugIndex: 3, scriptPath: 'C:/f/vibe-route.funscript' },
];

describe('parseFinisherActions', () => {
  it('parses, sorts, and strips BOM', () => {
    const raw = '\uFEFF' + JSON.stringify({ actions: [{ at: 1000, pos: 100 }, { at: 0, pos: 0 }] });
    expect(parseFinisherActions(raw)).toEqual([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]);
  });

  it('rejects bad JSON, < 2 actions, and zero-duration scripts', () => {
    expect(parseFinisherActions('nope{')).toBeNull();
    expect(parseFinisherActions(JSON.stringify({ actions: [{ at: 0, pos: 0 }] }))).toBeNull();
    expect(parseFinisherActions(JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 0, pos: 100 }] }))).toBeNull();
  });
});

describe('resolveOrgasmPlan — single', () => {
  it('builds a broadcast plan from the single slot', () => {
    const entry = buildAssociationEntry('single', 'C:/f/main.funscript', null, null);
    const { plan, demotedFrom } = resolveOrgasmPlan(entry, SNAP_NONE, getActions);
    expect(demotedFrom).toBeNull();
    expect(plan.mode).toBe('single');
    expect(plan.main).toBe(MAIN);
    expect(plan.loopMs).toBe(2000);
    expect(plan.tcodeAxes).toEqual({ L0: MAIN });
    expect(plan.bpMode).toBe('broadcast');
    expect(plan.handyPath).toBe('C:/f/main.funscript');
    expect(plan.stopsButtplug).toBe(true);
    expect(plan.stopsTcode).toBe(true);
    expect(plan.stopsHandy).toBe(true);
  });

  it('returns null plan for empty entry / unreadable script', () => {
    expect(resolveOrgasmPlan(null, SNAP_ALL, getActions).plan).toBeNull();
    const entry = buildAssociationEntry('single', 'C:/gone.funscript', null, null);
    expect(resolveOrgasmPlan(entry, SNAP_ALL, getActions).plan).toBeNull();
  });
});

describe('resolveOrgasmPlan — multi', () => {
  const multiEntry = buildAssociationEntry('multi', null, {
    main: 'C:/f/main.funscript',
    axes: { twist: 'C:/f/main.twist.funscript', vib: 'C:/f/main.vib.funscript' },
    buttplugVib: true,
  }, null);

  it('maps suffixes to TCode channels and carries the vib channel', () => {
    const { plan } = resolveOrgasmPlan(multiEntry, SNAP_NONE, getActions);
    expect(plan.mode).toBe('multi');
    expect(plan.tcodeAxes).toEqual({ L0: MAIN, R0: TWIST, V0: VIB });
    expect(plan.vib).toBe(VIB); // buttplugVib=true routes vib to vibe devices
    expect(plan.loopMs).toBe(2000); // main's duration anchors the loop
    expect(plan.handyPath).toBe('C:/f/main.funscript');
  });

  it('without buttplugVib the vib axis stays TCode-only', () => {
    const e = buildAssociationEntry('multi', null, {
      main: 'C:/f/main.funscript', axes: { vib: 'C:/f/main.vib.funscript' }, buttplugVib: false,
    }, null);
    const { plan } = resolveOrgasmPlan(e, SNAP_NONE, getActions);
    expect(plan.vib).toBeNull();
    expect(plan.tcodeAxes.V0).toBe(VIB);
  });

  it('axis-only bundle (no main): longest axis sets loop length, Handy not engaged', () => {
    const e = buildAssociationEntry('multi', null, {
      main: null, axes: { twist: 'C:/f/main.twist.funscript' }, buttplugVib: false,
    }, null);
    const { plan } = resolveOrgasmPlan(e, SNAP_NONE, getActions);
    expect(plan.main).toBeNull();
    expect(plan.loopMs).toBe(1500);
    expect(plan.handyPath).toBeNull();
    expect(plan.stopsHandy).toBe(false);
  });

  it('never gates on connections — a disconnected snapshot still yields a plan', () => {
    expect(resolveOrgasmPlan(multiEntry, SNAP_NONE, getActions).plan).not.toBeNull();
  });
});

describe('resolveOrgasmPlan — custom', () => {
  it('builds a routed plan when ALL routes match', () => {
    const { plan, demotedFrom, missing } = resolveOrgasmPlan(customEntry(ROUTES), SNAP_ALL, getActions);
    expect(demotedFrom).toBeNull();
    expect(missing).toEqual([]);
    expect(plan.mode).toBe('custom');
    expect(plan.bpMode).toBe('routed');
    expect(plan.bpRoutes).toEqual([
      { deviceIndex: 0, actions: MAIN, name: 'Stroker' },
      { deviceIndex: 3, actions: ROUTED, name: 'Hush' },
    ]);
    expect(plan.main).toBe(MAIN);       // main-role route anchors the loop
    expect(plan.loopMs).toBe(2000);
    expect(plan.handyPath).toBeNull();  // no handy route → Handy keeps the main script
    expect(plan.stopsHandy).toBe(false);
    expect(plan.stopsTcode).toBe(false);
    expect(plan.stopsButtplug).toBe(true);
  });

  it('demotes to single (entry.single slot) when a routed device is missing', () => {
    const entry = customEntry(ROUTES, 'C:/f/main.funscript');
    const snap = { ...SNAP_ALL, buttplugDevices: [{ index: 0, name: 'Stroker' }] }; // Hush gone
    const { plan, demotedFrom, missing } = resolveOrgasmPlan(entry, snap, getActions);
    expect(demotedFrom).toBe('custom');
    expect(missing).toEqual(['Hush']);
    expect(plan.mode).toBe('single');
    expect(plan.main).toBe(MAIN);
  });

  it('demotes to the custom MAIN route script when the single slot is empty', () => {
    const { plan, demotedFrom } = resolveOrgasmPlan(customEntry(ROUTES), SNAP_NONE, getActions);
    expect(demotedFrom).toBe('custom');
    expect(plan.mode).toBe('single');
    expect(plan.main).toBe(MAIN); // came from the main-role route's scriptPath
  });

  it('promotes back to custom once the missing device reconnects (same entry, new snapshot)', () => {
    const entry = customEntry(ROUTES);
    const demoted = resolveOrgasmPlan(entry, { ...SNAP_ALL, buttplugDevices: [] }, getActions);
    expect(demoted.plan.mode).toBe('single');
    const promoted = resolveOrgasmPlan(entry, SNAP_ALL, getActions);
    expect(promoted.plan.mode).toBe('custom');
    expect(promoted.demotedFrom).toBeNull();
  });

  it('handy + tcode routes gate on their connected flags', () => {
    const routes = [
      { role: 'main', deviceId: 'handy', scriptPath: 'C:/f/main.funscript' },
      { role: 'axis', deviceId: 'tcode', scriptPath: 'C:/f/vibe-route.funscript' },
    ];
    const ok = resolveOrgasmPlan(customEntry(routes), SNAP_ALL, getActions);
    expect(ok.plan.mode).toBe('custom');
    expect(ok.plan.handyPath).toBe('C:/f/main.funscript');
    expect(ok.plan.tcodeAxes).toEqual({ L0: ROUTED });
    expect(ok.plan.bpMode).toBe('keep'); // no bp routes → bp engine keeps running

    const noTcode = resolveOrgasmPlan(customEntry(routes), { ...SNAP_ALL, tcodeConnected: false }, getActions);
    expect(noTcode.demotedFrom).toBe('custom');
    expect(noTcode.missing).toEqual(['T-Code']);
  });

  it('stale buttplugIndex falls back to name match without driving the wrong device', () => {
    // Stored index 0 now holds a different device; "Hush" lives at index 7.
    const routes = [{ role: 'main', deviceId: 'buttplug:Hush', buttplugIndex: 0, scriptPath: 'C:/f/main.funscript' }];
    const snap = {
      buttplugDevices: [{ index: 0, name: 'Stroker' }, { index: 7, name: 'Hush' }],
      tcodeConnected: false, handyConnected: false,
    };
    const { plan } = resolveOrgasmPlan(customEntry(routes), snap, getActions);
    expect(plan.mode).toBe('custom');
    expect(plan.bpRoutes).toEqual([{ deviceIndex: 7, actions: MAIN, name: 'Hush' }]);
  });

  it('two same-name devices: claim set keeps the fallback from stealing an index-matched device', () => {
    const routes = [
      { role: 'main', deviceId: 'buttplug:The Handy', buttplugIndex: 2, scriptPath: 'C:/f/main.funscript' },
      { role: 'axis', deviceId: 'buttplug:The Handy', scriptPath: 'C:/f/vibe-route.funscript' }, // no index
    ];
    const snap = {
      buttplugDevices: [{ index: 1, name: 'The Handy' }, { index: 2, name: 'The Handy' }],
      tcodeConnected: false, handyConnected: false,
    };
    const { plan } = resolveOrgasmPlan(customEntry(routes), snap, getActions);
    expect(plan.mode).toBe('custom');
    const byIdx = Object.fromEntries(plan.bpRoutes.map((r) => [r.deviceIndex, r.actions]));
    expect(byIdx[2]).toBe(MAIN);    // index-hit claimed 2
    expect(byIdx[1]).toBe(ROUTED);  // fallback took the remaining device
  });

  it('unreadable route script demotes (device connected is not enough)', () => {
    const routes = [{ role: 'main', deviceId: 'buttplug:Stroker', buttplugIndex: 0, scriptPath: 'C:/gone.funscript' }];
    const { plan, demotedFrom, missing } = resolveOrgasmPlan(
      customEntry(routes, 'C:/f/main.funscript'), SNAP_ALL, getActions,
    );
    expect(demotedFrom).toBe('custom');
    expect(missing).toEqual(['gone.funscript']);
    expect(plan.mode).toBe('single'); // single slot saves the hold
  });

  it('unknown deviceIds (e.g. autoblow from a hand-edited config) demote with a label', () => {
    const routes = [{ role: 'main', deviceId: 'autoblow', scriptPath: 'C:/f/main.funscript' }];
    const { demotedFrom, missing } = resolveOrgasmPlan(customEntry(routes), SNAP_ALL, getActions);
    expect(demotedFrom).toBe('custom');
    expect(missing).toEqual(['autoblow']);
  });

  it('does not mutate the routes in the entry (settings-owned objects)', () => {
    const routes = ROUTES.map((r) => ({ ...r }));
    const before = JSON.stringify(routes);
    resolveOrgasmPlan(customEntry(routes), SNAP_ALL, getActions);
    expect(JSON.stringify(routes)).toBe(before);
  });
});

describe('collectOrgasmScriptPaths', () => {
  it('collects every slot, deduped', () => {
    const entry = buildAssociationEntry(
      'custom',
      'C:/f/main.funscript',
      { main: 'C:/f/main.funscript', axes: { twist: 'C:/f/main.twist.funscript' }, buttplugVib: false },
      { routes: ROUTES },
    );
    expect(collectOrgasmScriptPaths(entry).sort()).toEqual([
      'C:/f/main.funscript',
      'C:/f/main.twist.funscript',
      'C:/f/vibe-route.funscript',
    ]);
  });
});

describe('describeOrgasmEntry', () => {
  it('summarises each mode', () => {
    expect(describeOrgasmEntry(buildAssociationEntry('single', 'C:/f/main.funscript', null, null)))
      .toEqual({ mode: 'single', name: 'main.funscript', count: 0 });
    expect(describeOrgasmEntry(buildAssociationEntry('multi', null, {
      main: 'C:/f/main.funscript', axes: { twist: 'x', vib: 'y' }, buttplugVib: true,
    }, null))).toEqual({ mode: 'multi', name: 'main.funscript', count: 2 });
    expect(describeOrgasmEntry(customEntry(ROUTES)))
      .toEqual({ mode: 'custom', name: 'main.funscript', count: 2 });
    expect(describeOrgasmEntry(null)).toBeNull();
    expect(describeOrgasmEntry(buildAssociationEntry(null, null, null, null))).toBeNull();
  });
});
