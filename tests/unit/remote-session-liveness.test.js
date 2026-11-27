/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// A Web Remote session shown as live is checked (DESIGN.md §2.16, §1.6 S7).
// The full manual test (2026-11-23) found the card on "Paused" for good after
// the phone left: the disconnect message arrived, its handler threw, and
// nothing ever looked again. Now every 10 s the desktop asks the backend
// whether a phone is connected; two "no" answers in a row end the session
// through the normal disconnect path. A failed request is not an answer (a
// busy backend is not a dead one).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';

const App = liftAppClass(['_checkRemoteLiveness'], {});

let answers;
beforeEach(() => {
  answers = [];
  globalThis.fetch = vi.fn(async (url) => {
    expect(url).toBe('http://127.0.0.1:5123/api/remote/sync/status');
    const next = answers.shift();
    if (next instanceof Error) throw next;
    if (next === 500) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => next };
  });
});

function rig(source = 'web-remote') {
  let session = source ? { source, identifier: '192.168.1.20' } : null;
  const app = Object.assign(new App(), {
    sessionTracker: { getSession: () => session },
    _onRemotePhoneDisconnected: vi.fn(() => { session = null; }),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return app;
}

describe('the Web Remote session is checked, not assumed', () => {
  it('two answers in a row with no phone end the session through the disconnect path', async () => {
    const app = rig();
    answers.push({ phoneConnected: false }, { phoneConnected: false });
    await app._checkRemoteLiveness(5123);
    expect(app._onRemotePhoneDisconnected).not.toHaveBeenCalled();
    await app._checkRemoteLiveness(5123);
    expect(app._onRemotePhoneDisconnected).toHaveBeenCalledWith('192.168.1.20');
  });

  it('a phone seen in between resets the count', async () => {
    const app = rig();
    answers.push({ phoneConnected: false }, { phoneConnected: true }, { phoneConnected: false });
    for (let i = 0; i < 3; i++) await app._checkRemoteLiveness(5123);
    expect(app._onRemotePhoneDisconnected).not.toHaveBeenCalled();
  });

  it('a busy or failing backend is not an answer: nothing ends', async () => {
    const app = rig();
    answers.push(new Error('ECONNREFUSED'), 500, { phoneConnected: false }, new Error('timeout'), { nonsense: 1 });
    for (let i = 0; i < 5; i++) await app._checkRemoteLiveness(5123);
    expect(app._onRemotePhoneDisconnected).not.toHaveBeenCalled();
  });

  it('only a Web Remote session is checked (a headset has its own watchdog; none: nothing asked)', async () => {
    for (const source of ['vr', null]) {
      const app = rig(source);
      await app._checkRemoteLiveness(5123);
      expect(fetch).not.toHaveBeenCalled();
      expect(app._onRemotePhoneDisconnected).not.toHaveBeenCalled();
    }
  });

  it('runs every 10 s from the bridge\'s start, and stops on unload', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('const REMOTE_LIVENESS_MS = 10000;');
    expect(src).toContain('this._remoteLivenessTimer = setInterval(() => { this._checkRemoteLiveness?.(backendPort); }, REMOTE_LIVENESS_MS);');
    expect(src).toContain('if (this._remoteLivenessTimer) clearInterval(this._remoteLivenessTimer);');
  });
});
