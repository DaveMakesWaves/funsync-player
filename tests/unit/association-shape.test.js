// Tests for the association shape helpers. These guard the parallel-slot
// data model against regression — the "single/multi/custom in parallel
// with an active pointer" model is what makes mode switches lossless,
// and any migration bug here would silently clobber user configs.

import { describe, it, expect } from 'vitest';
import {
  normalizeAssociation,
  buildAssociationEntry,
  resolveActiveConfig,
  hasConfigForMode,
} from '../../renderer/js/association-shape.js';

describe('normalizeAssociation — legacy shape migration', () => {
  it('treats null/undefined as an empty entry with null active', () => {
    expect(normalizeAssociation(null)).toEqual({
      active: null, single: null, multi: null, custom: null,
    });
    expect(normalizeAssociation(undefined)).toEqual({
      active: null, single: null, multi: null, custom: null,
    });
  });

  it('maps a bare string to single-axis active', () => {
    const out = normalizeAssociation('/path/to/script.funscript');
    expect(out.active).toBe('single');
    expect(out.single).toBe('/path/to/script.funscript');
    expect(out.multi).toBeNull();
    expect(out.custom).toBeNull();
  });

  it('maps legacy {mode:"custom", routes} to custom-active', () => {
    const routes = [{ role: 'main', scriptPath: '/a.funscript' }];
    const out = normalizeAssociation({ mode: 'custom', routes });
    expect(out.active).toBe('custom');
    expect(out.custom).toEqual({ routes });
    expect(out.single).toBeNull();
    expect(out.multi).toBeNull();
  });

  it('maps legacy multi-axis object to multi-active', () => {
    const out = normalizeAssociation({
      main: '/main.funscript',
      axes: { vib: '/vib.funscript' },
      buttplugVib: true,
    });
    expect(out.active).toBe('multi');
    expect(out.multi).toEqual({
      main: '/main.funscript',
      axes: { vib: '/vib.funscript' },
      buttplugVib: true,
    });
    expect(out.single).toBeNull();
    expect(out.custom).toBeNull();
  });

  it('trusts the new shape and returns it unchanged structurally', () => {
    const input = {
      active: 'multi',
      single: '/s.funscript',
      multi: { main: '/m.funscript', axes: {}, buttplugVib: false },
      custom: { routes: [] },
    };
    const out = normalizeAssociation(input);
    expect(out.active).toBe('multi');
    expect(out.single).toBe('/s.funscript');
    expect(out.multi).toEqual({ main: '/m.funscript', axes: {}, buttplugVib: false });
    expect(out.custom).toEqual({ routes: [] });
  });
});

describe('buildAssociationEntry — mirror fields for downgrade', () => {
  it('embeds custom mirror fields when active=custom', () => {
    const routes = [{ role: 'main', scriptPath: '/a.funscript' }];
    const entry = buildAssociationEntry('custom', '/s.funscript', null, { routes });
    expect(entry.active).toBe('custom');
    expect(entry.mode).toBe('custom');
    expect(entry.routes).toEqual(routes);
    // single slot still saved — switching back is lossless.
    expect(entry.single).toBe('/s.funscript');
  });

  it('embeds multi mirror fields when active=multi', () => {
    const multi = {
      main: '/m.funscript',
      axes: { vib: '/v.funscript' },
      buttplugVib: true,
    };
    const entry = buildAssociationEntry('multi', null, multi, null);
    expect(entry.active).toBe('multi');
    expect(entry.main).toBe('/m.funscript');
    expect(entry.axes).toEqual({ vib: '/v.funscript' });
    expect(entry.buttplugVib).toBe(true);
  });

  it('does not embed mirror fields when active=single (old code reads string, not object)', () => {
    const entry = buildAssociationEntry('single', '/s.funscript', null, null);
    expect(entry.active).toBe('single');
    expect(entry.mode).toBeUndefined();
    expect(entry.routes).toBeUndefined();
    expect(entry.main).toBeUndefined();
  });

  it('preserves all three slots regardless of which is active', () => {
    const multi = { main: '/m.funscript', axes: {}, buttplugVib: false };
    const custom = { routes: [{ role: 'main', scriptPath: '/c.funscript' }] };
    const entry = buildAssociationEntry('single', '/s.funscript', multi, custom);
    expect(entry.single).toBe('/s.funscript');
    expect(entry.multi).toEqual(multi);
    expect(entry.custom).toEqual(custom);
  });
});

describe('resolveActiveConfig', () => {
  it('returns null when active is null', () => {
    const entry = buildAssociationEntry(null, null, null, null);
    expect(resolveActiveConfig(entry)).toBeNull();
  });

  it('returns single kind + path when active=single', () => {
    const entry = buildAssociationEntry('single', '/s.funscript', null, null);
    expect(resolveActiveConfig(entry)).toEqual({ kind: 'single', config: '/s.funscript' });
  });

  it('returns multi kind + object when active=multi', () => {
    const multi = { main: '/m.funscript', axes: {}, buttplugVib: false };
    const entry = buildAssociationEntry('multi', null, multi, null);
    expect(resolveActiveConfig(entry)).toEqual({ kind: 'multi', config: multi });
  });

  it('returns custom kind + object when active=custom', () => {
    const custom = { routes: [{ role: 'main', scriptPath: '/c.funscript' }] };
    const entry = buildAssociationEntry('custom', null, null, custom);
    expect(resolveActiveConfig(entry)).toEqual({ kind: 'custom', config: custom });
  });

  it('returns null when the active slot is empty', () => {
    // Active says multi but multi slot is null — treat as unconfigured.
    const entry = buildAssociationEntry('multi', null, null, null);
    expect(resolveActiveConfig(entry)).toBeNull();
  });
});

describe('hasConfigForMode', () => {
  it('single slot is usable only with a non-empty path', () => {
    expect(hasConfigForMode(buildAssociationEntry('single', '/s.funscript', null, null), 'single')).toBe(true);
    expect(hasConfigForMode(buildAssociationEntry(null, '', null, null), 'single')).toBe(false);
    expect(hasConfigForMode(buildAssociationEntry(null, null, null, null), 'single')).toBe(false);
  });

  it('multi slot is usable when main or any axis is set', () => {
    const withMain = buildAssociationEntry(null, null, { main: '/m.funscript', axes: {}, buttplugVib: false }, null);
    expect(hasConfigForMode(withMain, 'multi')).toBe(true);

    const withAxisOnly = buildAssociationEntry(null, null, { main: null, axes: { vib: '/v.funscript' }, buttplugVib: false }, null);
    expect(hasConfigForMode(withAxisOnly, 'multi')).toBe(true);

    const empty = buildAssociationEntry(null, null, { main: null, axes: {}, buttplugVib: false }, null);
    expect(hasConfigForMode(empty, 'multi')).toBe(false);
  });

  it('custom slot is usable when any route has a scriptPath', () => {
    const good = buildAssociationEntry(null, null, null, {
      routes: [{ role: 'main', scriptPath: '/c.funscript' }],
    });
    expect(hasConfigForMode(good, 'custom')).toBe(true);

    const empty = buildAssociationEntry(null, null, null, { routes: [] });
    expect(hasConfigForMode(empty, 'custom')).toBe(false);

    const missingScripts = buildAssociationEntry(null, null, null, {
      routes: [{ role: 'main' }],
    });
    expect(hasConfigForMode(missingScripts, 'custom')).toBe(false);
  });
});

describe('switch active preserves other slots', () => {
  // This is THE regression test the whole refactor exists to prevent: user
  // had single + multi + custom saved, switched active, closed app, reopened.
  // Other configs must still be retrievable.
  it('switching single → custom → multi keeps all three slots populated', () => {
    const singleScript = '/single.funscript';
    const multi = { main: '/multi.funscript', axes: { vib: '/v.funscript' }, buttplugVib: true };
    const custom = { routes: [{ role: 'main', scriptPath: '/custom.funscript' }] };

    // Step 1: user saves single.
    let entry = buildAssociationEntry('single', singleScript, null, null);
    expect(resolveActiveConfig(entry).kind).toBe('single');
    expect(entry.single).toBe(singleScript);

    // Step 2: user switches to custom — previous single slot preserved.
    entry = buildAssociationEntry('custom', entry.single, entry.multi, custom);
    expect(resolveActiveConfig(entry).kind).toBe('custom');
    expect(entry.single).toBe(singleScript); // ← lossless
    expect(entry.custom).toEqual(custom);

    // Step 3: user switches to multi — single AND custom preserved.
    entry = buildAssociationEntry('multi', entry.single, multi, entry.custom);
    expect(resolveActiveConfig(entry).kind).toBe('multi');
    expect(entry.single).toBe(singleScript); // ← still there
    expect(entry.custom).toEqual(custom);    // ← still there
    expect(entry.multi).toEqual(multi);
  });

  it('normalize() → buildEntry() round-trip is stable (simulates close + reopen)', () => {
    const original = buildAssociationEntry('custom', '/s.funscript', {
      main: '/m.funscript',
      axes: { vib: '/v.funscript' },
      buttplugVib: false,
    }, {
      routes: [{ role: 'main', scriptPath: '/c.funscript' }],
    });
    // Serialize + parse to simulate electron-conf settings round-trip.
    const restored = normalizeAssociation(JSON.parse(JSON.stringify(original)));
    expect(restored.active).toBe('custom');
    expect(restored.single).toBe('/s.funscript');
    expect(restored.multi.main).toBe('/m.funscript');
    expect(restored.custom.routes).toEqual([{ role: 'main', scriptPath: '/c.funscript' }]);
  });

  it('mirror fields round-trip from legacy → new → legacy-reader view', () => {
    // Downgrade scenario: user on new app writes entry with active=custom.
    // Old pre-refactor code reads `assoc.mode` and `assoc.routes`.
    const routes = [{ role: 'main', scriptPath: '/c.funscript' }];
    const entry = buildAssociationEntry('custom', '/s.funscript', null, { routes });
    // Simulate JSON persistence.
    const persisted = JSON.parse(JSON.stringify(entry));
    // Pre-refactor reader path:
    expect(persisted.mode).toBe('custom');
    expect(persisted.routes).toEqual(routes);
  });
});
