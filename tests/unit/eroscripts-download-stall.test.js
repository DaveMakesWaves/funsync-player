/**
 * @vitest-environment jsdom
 * jsdom: i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Dave, 2026-11-26: mid-download the connection stalled; the card froze with
// nothing said, and Cancel (pressed three times) seemed to do nothing until the
// read's timeout (15 s a try). The card now says it is waiting for the network,
// and, once a Pause / Cancel is waiting on that read, "Stopping…".
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { EroScriptsView, STALL_SECONDS } from '../../renderer/components/eroscripts-view.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const text = (job) => EroScriptsView.prototype._statusText.call({}, job, 42);

beforeEach(() => _setBundlesForTests('en', EN, EN));

describe('the card while a download waits on the network', () => {
  const base = { status: 'downloading', bytes: 1e6, total: 3e8, speed: 0 };

  it('a few seconds without data: still the progress', () => {
    expect(text({ ...base, stalledFor: STALL_SECONDS - 1 })).not.toMatch(/network/i);
  });

  it(`${STALL_SECONDS} s or more without data: it says it is waiting for the network, and for how long`, () => {
    expect(text({ ...base, stalledFor: 12 })).toBe('Waiting for the network: no data for 12 s');
  });

  it('Pause or Cancel asked for and still waiting: "Stopping…" (pressing again is not needed)', () => {
    expect(text({ ...base, stalledFor: 12, stopping: true })).toBe(EN.eroscripts.tab.status.stopping);
    expect(text({ status: 'resolving', stopping: true })).toBe(EN.eroscripts.tab.status.stopping);
  });

  it('a paused or finished job is never "stopping" or "stalled"', () => {
    expect(text({ status: 'paused', bytes: 5, total: 10, stopping: true, stalledFor: 30 })).not.toMatch(/Stopping|network/);
  });

  it('every language has both lines', () => {
    for (const loc of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${loc}.json`, 'utf8'));
      expect(j.eroscripts.tab.status.stalled, loc).toContain('{seconds}');
      expect(j.eroscripts.tab.status.stopping, loc).toBeTruthy();
    }
  });
});
