/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Rate limiter behind the live range preview (stingray, 2026-08-24).
//
// The contract that matters is not "sends fewer commands" — it is "the device
// ends up where the slider ended up". A plain throttle passes the first half
// and strands the device somewhere the user is no longer pointing at, which is
// indistinguishable from the feature being broken. So the trailing send is
// tested harder than the leading one.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRangePreview, DEFAULT_PREVIEW_INTERVAL_MS } from '../../renderer/js/range-preview.js';

/** Deterministic clock + timer queue — no real time anywhere in this file. */
function harness() {
  let now = 1000;
  let nextId = 1;
  const timers = new Map();
  const sent = [];

  const preview = createRangePreview((v) => sent.push(v), {
    intervalMs: 100,
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
  });

  return {
    preview,
    sent,
    get pendingTimers() { return timers.size; },
    /** Advance the clock, firing anything due. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, tmr] of timers) {
          if (tmr.at <= target && (!due || tmr.at < due.tmr.at)) due = { id, tmr };
        }
        if (!due) break;
        timers.delete(due.id);
        now = due.tmr.at;
        due.tmr.fn();
      }
      now = target;
    },
  };
}

describe('createRangePreview', () => {
  let h;
  beforeEach(() => { h = harness(); });

  it('sends the first value immediately — the device responds as the drag starts', () => {
    h.preview.request('a');
    expect(h.sent).toEqual(['a']);
  });

  it('coalesces a burst of drag events into one leading send', () => {
    for (const v of ['a', 'b', 'c', 'd', 'e']) h.preview.request(v);
    expect(h.sent).toEqual(['a']);
  });

  it('ALWAYS delivers the last value — where you let go is where it ends up', () => {
    for (const v of ['a', 'b', 'c', 'd', 'e']) h.preview.request(v);
    h.advance(100);
    expect(h.sent).toEqual(['a', 'e']);
  });

  it('schedules exactly one trailing send no matter how many requests queue', () => {
    h.preview.request('a');
    for (let i = 0; i < 50; i++) h.preview.request(`v${i}`);
    expect(h.pendingTimers).toBe(1);
    h.advance(100);
    expect(h.sent).toEqual(['a', 'v49']);
    expect(h.pendingTimers).toBe(0);
  });

  it('a request after the interval has elapsed goes straight out', () => {
    h.preview.request('a');
    h.advance(150);
    h.preview.request('b');
    expect(h.sent).toEqual(['a', 'b']);
  });

  it('the newest queued value wins — an older one is never sent late', () => {
    h.preview.request('a');       // leading, at t
    h.preview.request('stale');   // queued, trailing due at t+100
    h.advance(50);                // still queued
    h.preview.request('fresh');   // replaces the queued value in place
    h.advance(50);                // trailing fires
    expect(h.sent).toEqual(['a', 'fresh']);
  });

  it('a trailing send restarts the interval, so it cannot double up', () => {
    h.preview.request('a');
    h.preview.request('b');
    h.advance(100);               // 'b' goes out here, and resets the clock
    h.preview.request('c');       // only 0ms after 'b' → queued, not sent
    expect(h.sent).toEqual(['a', 'b']);
    h.advance(100);
    expect(h.sent).toEqual(['a', 'b', 'c']);
  });

  it('cancel() drops a queued send — the panel closed mid-drag', () => {
    h.preview.request('a');
    h.preview.request('b');
    h.preview.cancel();
    h.advance(500);
    expect(h.sent).toEqual(['a']);
    expect(h.pendingTimers).toBe(0);
  });

  it('passes falsy values through — position 0 is a real boundary', () => {
    h.preview.request(0);
    expect(h.sent).toEqual([0]);
    h.preview.request(0);
    h.advance(100);
    expect(h.sent).toEqual([0, 0]);
  });

  it('defaults to a rate a device can actually keep up with', () => {
    const p = createRangePreview(() => {});
    expect(p.intervalMs).toBe(DEFAULT_PREVIEW_INTERVAL_MS);
    expect(DEFAULT_PREVIEW_INTERVAL_MS).toBeGreaterThanOrEqual(50);
  });
});
