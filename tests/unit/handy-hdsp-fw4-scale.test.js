/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Firmware 4 reads the v2 /hdsp/xpt `position` as a 0-1 FRACTION, not the
// 0-100 the v2 spec documents. Measured on Dave's Handy (fw 4.2.1+ca4dd961)
// on 2026-11-04 with position read back from /slide/position/absolute:
//   xpt 0.5 → 49.8 %, 0.3 → 29.1 %, 0.8 → 79.3 %, 1 → 99 %
//   xpt 30 / 50 / 70 → pinned at the top, motor pushing against the end stop
// The stroke zone (/slide) is still 0-100 on FW4 (20-80 → 20.2 % / 79.3 %).
// Every FunSync HDSP move (rate engine, editor preview, Test pulse) sent
// 0-100, so on FW4 anything above 1 % drove the slider into its end.
import { describe, it, expect } from 'vitest';
import { HandyManager, hdspPositionScale } from '../../renderer/js/handy-manager.js';

describe('hdspPositionScale', () => {
  it('FW4 and later: 0-1 fraction', () => {
    expect(hdspPositionScale({ fwVersion: '4.2.1+ca4dd961' })).toBe(0.01);
    expect(hdspPositionScale({ fwVersion: '4.0.0' })).toBe(0.01);
    expect(hdspPositionScale({ fwVersion: '5.1' })).toBe(0.01);
    expect(hdspPositionScale({ fwMajor: 4 })).toBe(0.01);
  });

  it('FW1-3: 0-100 as the v2 spec says', () => {
    expect(hdspPositionScale({ fwVersion: '3.2.3' })).toBe(1);
    expect(hdspPositionScale({ fwVersion: 'v3.1.0' })).toBe(1);
    expect(hdspPositionScale({ fwMajor: 3, fwVersion: '' })).toBe(1);
  });

  it('unknown firmware: null, never a guess', () => {
    expect(hdspPositionScale(null)).toBeNull();
    expect(hdspPositionScale(undefined)).toBeNull();
    expect(hdspPositionScale({})).toBeNull();
    expect(hdspPositionScale({ fwVersion: '' })).toBeNull();
    expect(hdspPositionScale({ fwVersion: 'unknown' })).toBeNull();
  });
});

describe('HandyManager.hdspMove sends what the device expects', () => {
  const make = (info) => {
    const m = new HandyManager();
    const sent = [];
    m._handy = {
      setMode: async () => {},
      hdsp: async (...a) => { sent.push(a); },
      getState: () => ({ info }),
    };
    m._connected = true;
    m._deviceInfo = info;
    return { m, sent };
  };

  it('FW4: 30 % goes out as 0.3 (and the duration is unchanged)', async () => {
    const { m, sent } = make({ fwVersion: '4.2.1+ca4dd961' });
    await m.hdspMove(30, 500);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBeCloseTo(0.3, 10);
    expect(sent[0].slice(1)).toEqual([500, 'percent', 'time', true, true]);
  });

  it('FW4: the ends stay the ends, out-of-range input is clamped', async () => {
    const { m, sent } = make({ fwVersion: '4.2.1' });
    for (const p of [0, 100, 150, -20]) await m.hdspMove(p, 200);
    expect(sent.map((a) => a[0])).toEqual([0, 1, 1, 0]);
  });

  it('FW3: 30 % goes out as 30', async () => {
    const { m, sent } = make({ fwVersion: '3.2.3' });
    await m.hdspMove(30, 500);
    expect(sent[0][0]).toBe(30);
  });

  it('firmware not known yet: nothing is sent', async () => {
    const { m, sent } = make(null);
    await m.hdspMove(30, 500);
    expect(sent).toEqual([]);
  });

  it('falls back to the SDK state when deviceInfo has not landed yet', async () => {
    const { m, sent } = make({ fwVersion: '4.2.1' });
    m._deviceInfo = null; // the race the device-info comment describes
    await m.hdspMove(50, 500);
    expect(sent[0][0]).toBeCloseTo(0.5, 10);
  });
});
