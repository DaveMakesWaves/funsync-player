/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// What a post offers before it is opened (Dave, 2026-11-23: "why wouldn't I
// be able to see this one has no video download available before clicking
// it", "Why can't I filter by that?"): renderer/js/eroscripts-probe.js.
import { describe, it, expect, vi } from 'vitest';
import { summarisePost, passesNeed, normalizeNeed, PostProbe, GAP_MS, BACKOFF_MS } from '../../renderer/js/eroscripts-probe.js';

describe('summarisePost / passesNeed', () => {
  it('a video when any link can be downloaded; a script when a .funscript is attached; a zip is a pack', () => {
    expect(summarisePost({ attachments: [{ name: 'A.funscript' }], links: [{ url: 'x' }] }, [{ supported: false, kind: 'unsupported' }]))
      .toEqual({ video: false, tube: false, script: true, pack: false, paid: false });
    expect(summarisePost({ attachments: [{ name: 'Pack.ZIP' }] }, [{ supported: true, kind: 'filehost' }, { supported: false, kind: 'store' }]))
      .toEqual({ video: true, tube: false, script: false, pack: true, paid: true });
  });

  it('the filter: unknown posts stay shown until their answer; a pack counts as a script', () => {
    expect(passesNeed(null, 'video')).toBe(true);
    expect(passesNeed({ video: false }, 'video')).toBe(false);
    expect(passesNeed({ video: true }, 'video')).toBe(true);
    expect(passesNeed({ script: false, pack: true }, 'script')).toBe(true);
    expect(passesNeed({ video: false, script: false }, 'any')).toBe(true);
    expect(normalizeNeed('nope')).toBe('any');
    // Only a tube site (2026-11-24): a video with the Tube sites switch on, not without.
    const tubeOnly = summarisePost({ attachments: [] }, [{ supported: true, kind: 'tube' }]);
    expect(tubeOnly).toMatchObject({ video: false, tube: true });
    expect(passesNeed(tubeOnly, 'video')).toBe(false);
    expect(passesNeed(tubeOnly, 'video', { tube: true })).toBe(true);
  });
});

describe('PostProbe: one post at a time, gently', () => {
  function rig({ answers = {} } = {}) {
    vi.useFakeTimers();
    let now = 1_000_000;
    const fetchTopic = vi.fn(async (id) => answers[id] ?? { attachments: [{ name: 'S.funscript' }], links: [{ url: 'https://pixeldrain.com/u/x' }], replyLinks: [] });
    const classify = vi.fn(async (urls) => urls.map((u) => ({ supported: /pixeldrain/.test(u), kind: 'filehost' })));
    const results = [];
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const probe = new PostProbe({ fetchTopic, classify, onResult: (id, info) => results.push([id, info]), storage, now: () => now });
    const flush = async (ms) => { await vi.advanceTimersByTimeAsync(ms); };
    return { probe, fetchTopic, classify, results, storage, flush, setNow: (n) => { now = n; } };
  }

  it('asks each post once, GAP_MS apart, and remembers the answer', async () => {
    const r = rig({ answers: { 2: { attachments: [], links: [], replyLinks: [] } } });
    r.probe.enqueue([1, 2, 1]);
    await r.flush(0);
    expect(r.fetchTopic).toHaveBeenCalledTimes(1);
    await r.flush(GAP_MS);
    expect(r.fetchTopic).toHaveBeenCalledTimes(2);
    expect(r.probe.get(1)).toMatchObject({ video: true, script: true });
    expect(r.probe.get(2)).toMatchObject({ video: false, script: false });
    r.probe.enqueue([1, 2]);
    await r.flush(GAP_MS * 3);
    expect(r.fetchTopic).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('"too many requests": waits a minute, then asks the same post again', async () => {
    const r = rig();
    let first = true;
    r.fetchTopic.mockImplementation(async () => {
      if (first) { first = false; return { attachments: [], errorCode: 'rateLimited', error: 'Rate limited' }; }
      return { attachments: [{ name: 'S.funscript' }], links: [], replyLinks: [] };
    });
    r.probe.enqueue([7]);
    await r.flush(0);
    await r.flush(GAP_MS * 2);
    expect(r.fetchTopic).toHaveBeenCalledTimes(1);
    await r.flush(BACKOFF_MS);
    expect(r.fetchTopic).toHaveBeenCalledTimes(2);
    expect(r.probe.get(7)).toMatchObject({ script: true, video: false });
    vi.useRealTimers();
  });

  // Test day 2026-11-24, B029: with the login expired, every card check came
  // back 401 / 403 and the probe went on to the next post every 0.8 s (30
  // refused requests in 23 s), said nothing, and marked each post "not
  // retried this session", so signing in again left the cards unknown.
  const DENIED = { attachments: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true };

  it('an expired login: stops, asks once, waits; signing in again carries on with the same posts', async () => {
    const r = rig();
    const checkSession = vi.fn(async () => 'expired');
    const probe = new PostProbe({ fetchTopic: r.fetchTopic, classify: r.classify, checkSession, now: () => 1_000_000 });
    r.fetchTopic.mockResolvedValueOnce(DENIED);
    probe.enqueue([1, 2, 3]);
    await r.flush(0);
    await r.flush(GAP_MS * 20 + BACKOFF_MS);
    expect(r.fetchTopic).toHaveBeenCalledTimes(1);
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(probe.pending).toBe(3);
    probe.loginChanged(true);
    await r.flush(GAP_MS * 4);
    expect(r.fetchTopic.mock.calls.map((c) => c[0])).toEqual(['1', '1', '2', '3']);
    for (const id of [1, 2, 3]) expect(probe.get(id)).toMatchObject({ script: true });
    vi.useRealTimers();
  });

  it('signed out: no card checks until signed in', async () => {
    const r = rig();
    const probe = new PostProbe({ fetchTopic: r.fetchTopic, classify: r.classify, checkSession: async () => 'loggedOut' });
    probe.loginChanged(false);
    probe.enqueue([1, 2]);
    await r.flush(GAP_MS * 5);
    expect(r.fetchTopic).not.toHaveBeenCalled();
    probe.loginChanged(true);
    await r.flush(GAP_MS * 2);
    expect(r.fetchTopic).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a 403 with the login still good (a post closed to you): that post is skipped, the rest carry on, the login is not asked again for each', async () => {
    const r = rig({ answers: { 1: DENIED, 2: DENIED } });
    const checkSession = vi.fn(async () => 'valid');
    const probe = new PostProbe({ fetchTopic: r.fetchTopic, classify: r.classify, checkSession, now: () => 1_000_000 });
    probe.enqueue([1, 2, 3]);
    await r.flush(0);
    await r.flush(GAP_MS * 4);
    expect(r.fetchTopic.mock.calls.map((c) => c[0])).toEqual(['1', '2', '3']);
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(probe.get(1)).toBeNull();
    expect(probe.get(3)).toMatchObject({ script: true });
    vi.useRealTimers();
  });

  it('the login check itself cannot answer (network): a minute\'s wait, then the same post again', async () => {
    const r = rig();
    const checkSession = vi.fn(async () => 'unknown');
    const probe = new PostProbe({ fetchTopic: r.fetchTopic, classify: r.classify, checkSession });
    r.fetchTopic.mockResolvedValueOnce(DENIED);
    probe.enqueue([5]);
    await r.flush(0);
    await r.flush(GAP_MS * 3);
    expect(r.fetchTopic).toHaveBeenCalledTimes(1);
    await r.flush(BACKOFF_MS);
    expect(r.fetchTopic.mock.calls.map((c) => c[0])).toEqual(['5', '5']);
    expect(probe.get(5)).toMatchObject({ script: true });
    vi.useRealTimers();
  });

  it('paused (the tab is hidden): no request until resumed; the queue is kept; a 429 wait still holds after a resume', async () => {
    // Test day 2026-11-24: leaving the tab kept reading posts (11 in 10 s).
    const r = rig();
    r.probe.pause();
    r.probe.enqueue([1, 2]);
    await r.flush(GAP_MS * 5);
    expect(r.fetchTopic).not.toHaveBeenCalled();
    expect(r.probe.pending).toBe(2);
    r.probe.resume();
    await r.flush(0);
    expect(r.fetchTopic).toHaveBeenCalledTimes(1);
    r.fetchTopic.mockImplementationOnce(async () => ({ attachments: [], errorCode: 'rateLimited', error: 'Rate limited' }));
    await r.flush(GAP_MS);                    // post 2: too many requests, a minute's wait
    expect(r.fetchTopic).toHaveBeenCalledTimes(2);
    r.probe.pause();
    r.probe.resume();                         // a quick hide / show must not skip the wait
    await r.flush(GAP_MS * 2);
    expect(r.fetchTopic).toHaveBeenCalledTimes(2);
    await r.flush(BACKOFF_MS);
    expect(r.fetchTopic).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('answers survive a restart (storage) for 12 hours; a new list clears only the queue', async () => {
    const r = rig();
    r.probe.enqueue([5]);
    await r.flush(0);
    const again = new PostProbe({ fetchTopic: vi.fn(), classify: vi.fn(), storage: r.storage, now: () => 1_000_000 + 60_000 });
    expect(again.get(5)).toMatchObject({ video: true });
    const later = new PostProbe({ fetchTopic: vi.fn(), classify: vi.fn(), storage: r.storage, now: () => 1_000_000 + 13 * 3600_000 });
    expect(later.get(5)).toBeNull();
    r.probe.enqueue([8, 9]);
    r.probe.clearQueue();
    await r.flush(GAP_MS * 4);
    expect(r.fetchTopic).toHaveBeenCalledTimes(1); // only 5: 8 and 9 were queued, not yet asked
    vi.useRealTimers();
  });
});

// Dave, 2026-11-25: "on the filter options the download dropdown there should
// be an option for video and script so that users can filter by the option of
// just being able to download both no faf". 'both': a video this build can
// download AND a script (a .funscript, or a pack).
describe("the Download filter's Video and script", () => {
  const info = (o) => ({ video: false, tube: false, script: false, pack: false, paid: false, ...o });
  it('passes only a post with both; a tube video counts only with the Tube switch on; unknown still shows', async () => {
    const { passesNeed, normalizeNeed, NEEDS } = await import('../../renderer/js/eroscripts-probe.js');
    expect(NEEDS).toEqual(['any', 'video', 'script', 'both']);
    expect(normalizeNeed('both')).toBe('both');
    expect(passesNeed(info({ video: true, script: true }), 'both')).toBe(true);
    expect(passesNeed(info({ video: true, pack: true }), 'both')).toBe(true);
    expect(passesNeed(info({ video: true }), 'both')).toBe(false);
    expect(passesNeed(info({ script: true }), 'both')).toBe(false);
    expect(passesNeed(info({ tube: true, script: true }), 'both')).toBe(false);
    expect(passesNeed(info({ tube: true, script: true }), 'both', { tube: true })).toBe(true);
    expect(passesNeed(null, 'both')).toBe(true);
  });
});
