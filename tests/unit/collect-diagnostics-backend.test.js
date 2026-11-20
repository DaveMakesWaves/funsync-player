/**
 * @vitest-environment node
 * main.js's collect-diagnostics handler, lifted and run; no DOM.
 * See notes/CLAUDE.md "Test environments".
 */
// R3-07 (also in v0.9.2): "Report a problem" always said "Backend: not
// running". collect-diagnostics read `getHealthState()?.healthy`, but
// python-bridge's getHealthState() returns a STRING ('unknown' | 'running' |
// 'down' | 'restarting'), so `backend.running` was false whatever the state.
//
// The REAL handler (lifted from electron/main.js) feeds the REAL report
// formatter (feedback-modal.js formatDiagnostics, the text the user pastes),
// so what is asserted is the line the report shows.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { liftMainHandler } from './helpers/main-handlers.js';
import { formatDiagnostics } from '../../renderer/components/feedback-modal.js';

const require = createRequire(import.meta.url);

function collectWith(state) {
  return liftMainHandler('collect-diagnostics', {
    require,
    // No log file: the tail is "(log unavailable)" and no sweep runs.
    log: { transports: { file: { getFile: () => null } } },
    getHealthState: () => state,
    app: { getVersion: () => '0.0.0-test' },
  });
}

describe('Report a problem says whether the backend is running (R3-07)', () => {
  it('running: "Backend: running"', async () => {
    const d = await collectWith('running')(null, {});
    expect(d.backend.running).toBe(true);
    expect(formatDiagnostics(d)).toContain('Backend: running (port 5123)');
  });

  it.each(['down', 'restarting', 'unknown', undefined])('%s: "Backend: not running"', async (state) => {
    const d = await collectWith(state)(null, {});
    expect(d.backend.running).toBe(false);
    expect(formatDiagnostics(d)).toContain('Backend: not running (port 5123)');
  });
});
