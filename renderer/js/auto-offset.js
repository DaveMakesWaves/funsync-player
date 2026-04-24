// Auto-offset helpers — pure functions for the Diagnostic + Presets sync
// calibration system. UI shells in connection-panel.js (Sync tab) and the
// per-device sync engines call into these.
//
// Two layers:
//   1. Diagnostic: measure latencies we can (Handy RTD, network jitter,
//      BLE ping) and surface them. Doesn't auto-apply.
//   2. Presets: per-player + per-transport defaults. Apply on connect,
//      respect user-tuned overrides via a 'source' tag stored alongside
//      each device's offset value.
//
// Sign convention: NEGATIVE offset means fire device commands EARLIER
// (compensate for downstream latency). Matches the rest of the codebase.

// =============================================================================
// PRESETS
// =============================================================================

/**
 * Per-(player × transport-quality) offset defaults. Values are PLACEHOLDERS
 * that need real-world testing to dial in — start here, refine later.
 *
 * Keys: `${playerType}:${transport}` where playerType is the VR bridge's
 * `_playerType` and transport is derived from network jitter (see
 * `classifyTransport` below).
 *
 * The number is the TOTAL offset for the VR proxy (`vr.offset`) — i.e.
 * what compensates for VR display lag. Per-device offsets stack on top
 * to compensate for the device's own command latency (Handy RTD, BLE).
 */
export const VR_OFFSET_PRESETS = {
  'heresphere:cable':       -100,
  'heresphere:wifi-fast':   -200,
  'heresphere:wifi-slow':   -350,
  'heresphere:wifi-slowest': -500,
  'deovr:cable':            -80,
  'deovr:wifi-fast':        -180,
  'deovr:wifi-slow':        -320,
  'deovr:wifi-slowest':     -480,
};

/**
 * Per-device offset defaults — applied on top of the VR offset (or alone
 * for desktop / web remote playback). Compensate for the device's own
 * command latency, which is independent of the playback context.
 */
export const DEVICE_OFFSET_PRESETS = {
  // Handy via native WiFi API: HSSP latency is mostly absorbed by the
  // device's clock-sync, but a small early-fire helps in practice.
  handy:    -50,
  // Buttplug devices over BLE: ~50-80ms BLE round-trip, fire that early.
  buttplug: -80,
  // TCode over USB serial: very low latency, minor adjustment.
  tcode:    -20,
  // Autoblow — already has its own offset model; preset is conservative.
  autoblow: -50,
};

/**
 * Web remote (mobile phone on the same LAN) — no VR display lag, just
 * network. Single value applied to all device sync engines on the host.
 */
export const REMOTE_OFFSET_PRESET_LAN = -50;

// =============================================================================
// TRANSPORT CLASSIFICATION
// =============================================================================

/**
 * Classify network transport quality from measured jitter (in ms). Used
 * to look up the right preset key when only the player type is known.
 *
 * Thresholds picked from typical home WiFi behaviour — wired/cabled
 * connections show <5ms jitter, WiFi 6 in good conditions <20ms, WiFi
 * 5 in normal conditions <50ms, congested WiFi above that.
 *
 * @param {number} jitterMs — observed packet arrival jitter
 * @returns {'cable'|'wifi-fast'|'wifi-slow'|'wifi-slowest'}
 */
export function classifyTransport(jitterMs) {
  if (jitterMs == null || jitterMs < 0) return 'wifi-slow'; // safe default
  if (jitterMs < 5) return 'cable';
  if (jitterMs < 20) return 'wifi-fast';
  if (jitterMs < 50) return 'wifi-slow';
  return 'wifi-slowest';
}

/**
 * Get the VR offset preset for a player + measured transport quality.
 * Returns null when the combination has no preset (unknown player).
 *
 * @param {string} playerType — 'heresphere' | 'deovr'
 * @param {number} jitterMs
 * @returns {{ key: string, value: number } | null}
 */
export function lookupVrPreset(playerType, jitterMs) {
  const transport = classifyTransport(jitterMs);
  const key = `${playerType}:${transport}`;
  const value = VR_OFFSET_PRESETS[key];
  if (value == null) return null;
  return { key, value };
}

// =============================================================================
// SUGGESTED OFFSET COMPUTATION
// =============================================================================

/**
 * Compute a suggested offset for a device, given measured latencies and
 * the playback context. Used by the diagnostic UI to populate the
 * "Suggested: -426ms" display.
 *
 * Formula:
 *   suggested = -( deviceOneWay + networkOneWay + displayLag )
 *
 * Where:
 *   deviceOneWay  = handyRtd/2  for Handy; buttplugPing/2  for Buttplug
 *   networkOneWay = vrJitter    (jitter ≈ one-way variance, best proxy
 *                                we have given the one-way protocol)
 *   displayLag    = the unmeasurable VR display lag, taken from the
 *                   matching VR preset for the current player/transport
 *
 * For non-VR contexts (desktop, web remote), displayLag is omitted.
 *
 * @param {object} opts
 * @param {'handy'|'buttplug'|'tcode'|'autoblow'} opts.device
 * @param {'desktop'|'vr'|'remote'} opts.context
 * @param {number} [opts.handyRtdMs]    — device round-trip, when device='handy'
 * @param {number} [opts.buttplugPingMs] — device round-trip, when device='buttplug'
 * @param {number} [opts.vrJitterMs]    — network jitter, when context='vr'
 * @param {number} [opts.wsRttMs]       — WS round-trip, when context='remote'
 * @param {string} [opts.vrPlayerType]  — needed to look up display-lag preset
 * @returns {number} suggested offset in ms (typically negative)
 */
export function computeSuggestedOffset(opts) {
  let total = 0;

  // Device-side one-way latency.
  if (opts.device === 'handy' && opts.handyRtdMs != null) {
    total += opts.handyRtdMs / 2;
  } else if (opts.device === 'buttplug' && opts.buttplugPingMs != null) {
    total += opts.buttplugPingMs / 2;
  }

  // Network-side one-way latency.
  if (opts.context === 'vr' && opts.vrJitterMs != null) {
    total += opts.vrJitterMs;
  } else if (opts.context === 'remote' && opts.wsRttMs != null) {
    total += opts.wsRttMs / 2;
  }

  // Display lag (VR only — not measurable, take from preset).
  if (opts.context === 'vr' && opts.vrPlayerType) {
    const preset = lookupVrPreset(opts.vrPlayerType, opts.vrJitterMs ?? 30);
    if (preset) total += Math.abs(preset.value); // preset is already negative; use magnitude
  }

  // Round to 10ms — sub-10ms precision is below human perception threshold
  // and keeps the suggested value tidy. `|| 0` normalises the JS -0 quirk
  // (negating zero yields -0 which is === 0 but !== 0 with Object.is).
  return -Math.round(total / 10) * 10 || 0;
}

// =============================================================================
// SOURCE-TAG LOGIC (the dangerous bit — never overwrite a user value)
// =============================================================================

/**
 * Decide whether to apply a preset value, given the current saved state.
 *
 * Rules:
 *   - source 'user' → never overwrite (user explicitly tuned it)
 *   - source 'preset' AND key changed → apply the new preset
 *     (e.g. user moved from WiFi to USB cable; transport classification
 *     bumped the preset to a more appropriate value)
 *   - source 'preset' AND key unchanged → no-op
 *   - source undefined (legacy / first connect) → apply preset
 *
 * @param {object} current
 * @param {string} [current.source] — 'user' | 'preset' | undefined
 * @param {string} [current.presetKey]
 * @param {number} [current.value]
 * @param {object} incoming
 * @param {string} incoming.key — the new preset key
 * @param {number} incoming.value — the new preset value
 * @returns {{ apply: boolean, reason: string }}
 */
export function decidePresetApply(current, incoming) {
  if (!current || current.source == null) {
    return { apply: true, reason: 'no-saved-source' };
  }
  if (current.source === 'user') {
    return { apply: false, reason: 'user-tuned' };
  }
  if (current.source === 'preset') {
    if (current.presetKey !== incoming.key) {
      return { apply: true, reason: 'preset-key-changed' };
    }
    return { apply: false, reason: 'same-preset' };
  }
  // Unknown source value — be conservative, don't touch.
  return { apply: false, reason: 'unknown-source' };
}
