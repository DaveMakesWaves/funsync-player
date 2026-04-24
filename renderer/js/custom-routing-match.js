// Pure matching logic for custom-routing Buttplug routes.
//
// Extracted from app.js so it's unit-testable without spinning up the
// whole renderer. Two-layer strategy:
//
//   1. Index hit + name confirms → 'index' (stable across Intiface restarts)
//   2. Index hit + name differs → reject (Intiface reshuffled the slot to a
//      different physical device — don't drive the wrong hardware silently)
//   3. Name match as fallback → 'name' (caller refreshes the stored index)
//   4. Neither → null
//
// Rule (2) is the "safety" that keeps us from driving the wrong device when
// Intiface reassigns an index after a device removal/re-add sequence.

/**
 * @param {{deviceId: string, buttplugIndex?: number}} route
 * @param {Array<{index: number, name: string}>} bpDevices
 * @returns {{dev: object, matchedBy: 'index'|'name', indexMismatch?: boolean} | null}
 */
export function matchButtplugRoute(route, bpDevices) {
  if (!route || !route.deviceId || !Array.isArray(bpDevices)) return null;
  const wantedId = route.deviceId;

  if (Number.isFinite(route.buttplugIndex)) {
    const byIdx = bpDevices.find(d => d.index === route.buttplugIndex);
    if (byIdx) {
      if (`buttplug:${byIdx.name}` === wantedId) {
        return { dev: byIdx, matchedBy: 'index' };
      }
      // Index hit, name miss — the slot now holds a different device. Fall
      // through to name lookup so we try to find the *correct* device by
      // its stored name.
      const byName = bpDevices.find(d => `buttplug:${d.name}` === wantedId);
      if (byName) return { dev: byName, matchedBy: 'name', indexMismatch: true };
      return null;
    }
  }

  const byName = bpDevices.find(d => `buttplug:${d.name}` === wantedId);
  if (byName) return { dev: byName, matchedBy: 'name' };

  return null;
}
