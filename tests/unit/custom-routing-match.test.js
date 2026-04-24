// Tests for the pure buttplug-route matcher used by custom routing.
// The logic is non-trivial: prefer Intiface's deviceIndex (stable across
// Intiface restarts), but require the name to confirm — otherwise an
// Intiface slot reshuffle would silently drive the wrong hardware.

import { describe, it, expect } from 'vitest';
import { matchButtplugRoute } from '../../renderer/js/custom-routing-match.js';

const dev = (index, name) => ({ index, name });

describe('matchButtplugRoute', () => {
  describe('index + name both match (happy path)', () => {
    it('returns matchedBy:index when stored index points to the right-named device', () => {
      const devices = [dev(0, 'The Handy'), dev(1, 'Lovense')];
      const route = { deviceId: 'buttplug:The Handy', buttplugIndex: 0 };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('index');
      expect(result.dev.index).toBe(0);
      expect(result.indexMismatch).toBeUndefined();
    });

    it('picks the correct device when multiple share a partial name', () => {
      const devices = [dev(0, 'Lovense Nora'), dev(1, 'Lovense Max'), dev(2, 'Lovense Nora')];
      const route = { deviceId: 'buttplug:Lovense Nora', buttplugIndex: 2 };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('index');
      expect(result.dev.index).toBe(2);
    });
  });

  describe('name-only fallback (no stored index)', () => {
    it('matches by name when route has no buttplugIndex', () => {
      const devices = [dev(0, 'Lovense'), dev(1, 'The Handy')];
      const route = { deviceId: 'buttplug:The Handy' };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('name');
      expect(result.dev.index).toBe(1);
    });

    it('matches by name when buttplugIndex is explicitly undefined', () => {
      const devices = [dev(0, 'The Handy')];
      const route = { deviceId: 'buttplug:The Handy', buttplugIndex: undefined };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('name');
    });

    it('matches by name when stored index points to a vanished device', () => {
      const devices = [dev(0, 'Lovense')]; // index 3 no longer exists
      const route = { deviceId: 'buttplug:Lovense', buttplugIndex: 3 };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('name');
      expect(result.dev.index).toBe(0);
    });
  });

  describe('name confirms index (safety rule)', () => {
    it('rejects an index hit when the name at that slot differs, and falls back to name', () => {
      // Scenario: route saved with OG Handy at index 0. User removed OG Handy
      // from Intiface; Intiface now has Handy 2 at slot 0 and the real OG
      // Handy reconnected at index 3.
      const devices = [dev(0, 'Handy 2'), dev(3, 'OG Handy')];
      const route = { deviceId: 'buttplug:OG Handy', buttplugIndex: 0 };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('name');
      expect(result.dev.index).toBe(3);          // correctly finds real OG Handy
      expect(result.indexMismatch).toBe(true);    // signals that we rejected the index hit
    });

    it('returns null when index-hit name mismatches and stored name is not connected anywhere', () => {
      const devices = [dev(0, 'Handy 2')];
      const route = { deviceId: 'buttplug:OG Handy', buttplugIndex: 0 };
      // Slot 0 is now Handy 2, OG Handy nowhere to be found
      const result = matchButtplugRoute(route, devices);
      expect(result).toBeNull();
    });

    it('prefers index when name matches even if another device shares the same name', () => {
      // Both slots are "The Handy" (two OG Handys in Intiface); stored index
      // must win over picking the first one by name.
      const devices = [dev(0, 'The Handy'), dev(1, 'The Handy')];
      const route = { deviceId: 'buttplug:The Handy', buttplugIndex: 1 };
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('index');
      expect(result.dev.index).toBe(1);
    });
  });

  describe('no match', () => {
    it('returns null when neither index nor name is found', () => {
      const devices = [dev(0, 'Lovense')];
      const route = { deviceId: 'buttplug:OG Handy', buttplugIndex: 5 };
      expect(matchButtplugRoute(route, devices)).toBeNull();
    });

    it('returns null when bpDevices is empty', () => {
      const route = { deviceId: 'buttplug:Anything', buttplugIndex: 0 };
      expect(matchButtplugRoute(route, [])).toBeNull();
    });

    it('returns null when route is missing', () => {
      expect(matchButtplugRoute(null, [dev(0, 'x')])).toBeNull();
      expect(matchButtplugRoute(undefined, [dev(0, 'x')])).toBeNull();
    });

    it('returns null when bpDevices is not an array', () => {
      const route = { deviceId: 'buttplug:x', buttplugIndex: 0 };
      expect(matchButtplugRoute(route, null)).toBeNull();
      expect(matchButtplugRoute(route, undefined)).toBeNull();
    });

    it('returns null when route has no deviceId', () => {
      expect(matchButtplugRoute({ buttplugIndex: 0 }, [dev(0, 'x')])).toBeNull();
    });
  });

  describe('backwards compat — legacy routes without buttplugIndex', () => {
    it('matches legacy routes by name exactly like pre-fix behaviour', () => {
      // Route saved before we started storing buttplugIndex
      const devices = [dev(0, 'The Handy'), dev(1, 'Lovense')];
      const route = { deviceId: 'buttplug:The Handy' };  // no index field
      const result = matchButtplugRoute(route, devices);
      expect(result?.matchedBy).toBe('name');
      expect(result.dev.index).toBe(0);
    });
  });
});
