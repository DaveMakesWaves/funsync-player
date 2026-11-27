/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Devices > Sync's per-device offset row named the T-Code device
// "TCode (serial)" whatever its link (E-05, cosmetic, also in v0.9.2; TODO
// triage 2026-11-23): a UDP or WebSocket device is not serial. The row
// names the device, not the link, in every language.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('the T-Code offset row', () => {
  it('says TCode in every locale, never a link type', () => {
    for (const l of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
      expect(j.connection.sync.deviceTcode, l).toBe('TCode');
    }
    const src = fs.readFileSync('renderer/components/connection-panel.js', 'utf8');
    expect(src).toContain("label: t('connection.sync.deviceTcode'),");
  });
});
