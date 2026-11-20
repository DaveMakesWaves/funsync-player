/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// VR detection exists three times: the desktop's isVRVideo (library VR
// filter, VR Format menu), the web remote's vendored copy, and the backend's
// detect_vr_format (the projection HereSphere is told to play, and its VR
// group). They claimed to mirror each other rule for rule and did not: a
// bare `180` made the backend serve "Episode 180" as a 180° stereo dome
// while both JS copies called it flat, and `180_mono` was VR on one side
// only (app test 2026-11-02: V61).
//
// The table lives in tests/fixtures/vr-filename-parity.json and the backend
// suite (backend/tests/test_vr_api.py `test_vr_filename_parity`) runs the
// SAME rows through detect_vr_format, so a rule added to one copy and not
// the others fails one of the two suites.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { isVRVideo as desktopIsVR } from '../../renderer/js/vr-detect.js';
import { isVRVideo as remoteIsVR } from '../../backend/web-remote/vr-detect.js';

const { cases } = JSON.parse(fs.readFileSync('tests/fixtures/vr-filename-parity.json', 'utf8'));

describe('VR filename table (shared with the backend suite)', () => {
  it('has rows on both sides of the bare-180 rule', () => {
    expect(cases.some((c) => c.name === 'Episode 180.mp4' && c.vr === false)).toBe(true);
    expect(cases.some((c) => c.name === 'Scene_180_mono.mp4' && c.vr === true)).toBe(true);
  });

  for (const { name, vr } of cases) {
    it(`${name} → ${vr ? 'VR' : 'flat'} on the desktop and the web remote`, () => {
      expect(desktopIsVR(name)).toBe(vr);
      expect(remoteIsVR(name)).toBe(vr);
    });
  }
});
