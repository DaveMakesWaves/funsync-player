/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Unit tests for the VR Device-Sync subnet-mismatch guard.
//
// Motivated by a 2026-07 HereSphere support report: user copied the IP
// HereSphere showed for its timestamp server, but that IP belonged to a
// VPN/virtual adapter on a different subnet than the PC's LAN, so FunSync
// couldn't route to it. FunSync already knows its own LAN IP (from
// /network-info), so shouldWarnSubnet() flags the mismatch before the
// user hits Connect.

import { describe, it, expect } from 'vitest';
import { subnet24, shouldWarnSubnet } from '../../renderer/components/vr-modal.js';

describe('subnet24', () => {
  it('returns the /24 prefix of a dotted quad', () => {
    expect(subnet24('192.168.101.5')).toBe('192.168.101');
    expect(subnet24('10.211.1.32')).toBe('10.211.1');
  });

  it('trims surrounding whitespace', () => {
    expect(subnet24('  192.168.1.4 ')).toBe('192.168.1');
  });

  it('returns null for non-dotted-quad or out-of-range input', () => {
    expect(subnet24('')).toBeNull();
    expect(subnet24(null)).toBeNull();
    expect(subnet24('not-an-ip')).toBeNull();
    expect(subnet24('192.168.1')).toBeNull();     // too few octets
    expect(subnet24('999.1.1.1')).toBeNull();      // octet > 255
    expect(subnet24('quest.local')).toBeNull();    // hostname, not IP
  });
});

describe('shouldWarnSubnet', () => {
  it('warns and suggests the PC /24 when host is on a different subnet (the reported bug)', () => {
    // PC on 192.168.101.x, user typed the VPN-adapter IP HereSphere showed.
    expect(shouldWarnSubnet('192.168.101.5', '10.211.1.32')).toBe('192.168.101');
  });

  it('does not warn when host shares the PC subnet', () => {
    expect(shouldWarnSubnet('192.168.101.5', '192.168.101.42')).toBeNull();
  });

  it('does not warn for loopback (PCVR)', () => {
    expect(shouldWarnSubnet('192.168.101.5', '127.0.0.1')).toBeNull();
  });

  it('does not nag when the PC LAN IP could not be detected', () => {
    expect(shouldWarnSubnet('127.0.0.1', '10.211.1.32')).toBeNull();
  });

  it('does not warn when either value is not a comparable IP', () => {
    expect(shouldWarnSubnet('192.168.101.5', '')).toBeNull();
    expect(shouldWarnSubnet('192.168.101.5', 'quest.local')).toBeNull();
    expect(shouldWarnSubnet(null, '10.211.1.32')).toBeNull();
  });

  it('tolerates whitespace around the host', () => {
    expect(shouldWarnSubnet('192.168.101.5', '  10.211.1.32 ')).toBe('192.168.101');
  });
});
