// Association shape helpers.
//
// `library.associations[videoPath]` used to hold a single config whose
// shape was dispatched at read time:
//   string                                     → single-axis
//   object without `mode`, has `main`/`axes`   → multi-axis
//   `{ mode: 'custom', routes: [...] }`        → custom routing
//
// That model lost user data whenever the user switched between modes.
// The new shape keeps all three configs in parallel with an `active`
// pointer so switching is lossless and the last-active mode restores on
// reopen:
//
//   {
//     active: 'single' | 'multi' | 'custom' | null,
//     single: '<path>' | null,
//     multi:  { main, axes, buttplugVib } | null,
//     custom: { routes: [...] } | null,
//
//     // Back-compat mirror fields (so if a user downgrades the app to a
//     // pre-refactor version, the OLD read path still sees the active
//     // config for custom and multi. Single-axis downgrade regresses to
//     // auto-pairing only — old code can't read an object as a string.)
//     mode?: 'custom',
//     routes?: [...],
//     main?: '<path>',
//     axes?: { ... },
//     buttplugVib?: boolean,
//   }
//
// Every read point in the app should go through `normalizeAssociation()`
// first; every write through `buildAssociationEntry()`.

/** @typedef {'single'|'multi'|'custom'|null} ActiveMode */

/**
 * Canonicalise any known association shape into the new multi-slot form.
 * Accepts both old and new shapes and returns a new-shape object with
 * back-compat mirror fields populated. Pure — no settings I/O.
 *
 * @param {*} raw  old string / old multi object / old custom object /
 *                 new multi-slot object / null / undefined
 * @returns {{
 *   active: ActiveMode,
 *   single: string|null,
 *   multi: object|null,
 *   custom: object|null,
 *   [k: string]: unknown
 * }}
 */
export function normalizeAssociation(raw) {
  if (raw == null) return _buildEntry(null, null, null, null);

  // Old single-axis: bare string path.
  if (typeof raw === 'string') {
    return _buildEntry('single', raw, null, null);
  }

  if (typeof raw !== 'object') return _buildEntry(null, null, null, null);

  // New shape detector: the `active` field is our marker. If present we
  // trust the shape (but still normalise nulls + rebuild mirror fields).
  if ('active' in raw) {
    return _buildEntry(
      raw.active ?? null,
      raw.single ?? null,
      raw.multi ?? null,
      raw.custom ?? null,
    );
  }

  // Old custom routing: `{ mode: 'custom', routes: [...] }`.
  if (raw.mode === 'custom') {
    return _buildEntry('custom', null, null, { routes: raw.routes || [] });
  }

  // Old multi-axis: object with main/axes/buttplugVib at top level.
  const multi = {
    main: raw.main || null,
    axes: raw.axes || {},
    buttplugVib: !!raw.buttplugVib,
  };
  return _buildEntry('multi', null, multi, null);
}

/**
 * Build a new-shape entry with mirror fields for downgrade safety.
 * Any slot value of null is preserved verbatim.
 *
 * @param {ActiveMode} active
 * @param {string|null} single
 * @param {object|null} multi
 * @param {object|null} custom
 */
export function buildAssociationEntry(active, single, multi, custom) {
  return _buildEntry(active, single, multi, custom);
}

function _buildEntry(active, single, multi, custom) {
  const entry = { active, single, multi, custom };
  // Mirror the active slot's old-shape fields onto the top level so a
  // user who downgrades to a pre-refactor FunSync version still sees
  // their active config.
  //   - active=custom → {mode:'custom', routes} at top
  //   - active=multi  → {main, axes, buttplugVib} at top
  //   - active=single → can't mirror (old code needs a string, not an
  //                     object) — accept the regression for that case
  if (active === 'custom' && custom) {
    entry.mode = 'custom';
    entry.routes = custom.routes || [];
  } else if (active === 'multi' && multi) {
    entry.main = multi.main || null;
    entry.axes = multi.axes || {};
    entry.buttplugVib = !!multi.buttplugVib;
  }
  return entry;
}

/**
 * Get the active config payload from a normalised entry. Returns null if
 * no slot is active, or the active slot is empty.
 *
 * @returns {{kind: Exclude<ActiveMode, null>, config: *} | null}
 */
export function resolveActiveConfig(entry) {
  if (!entry || !entry.active) return null;
  const value = entry[entry.active];
  if (value == null) return null;
  return { kind: entry.active, config: value };
}

/**
 * Return true if the entry has a usable config at the given slot.
 * "Usable" means: single has a non-empty path; multi has main or any axis;
 * custom has at least one route with a scriptPath.
 */
export function hasConfigForMode(entry, mode) {
  if (!entry) return false;
  const v = entry[mode];
  if (!v) return false;
  if (mode === 'single') return typeof v === 'string' && v.length > 0;
  if (mode === 'multi') {
    return !!v.main || Object.values(v.axes || {}).some(Boolean);
  }
  if (mode === 'custom') {
    return Array.isArray(v.routes) && v.routes.some(r => r?.scriptPath);
  }
  return false;
}
