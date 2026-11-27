/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Edge Hold and the pattern Test run the Orgasm Switch engine, and their log
// lines read "[OrgasmSwitch] Handy finisher looping via HSSP" and
// "[OrgasmSwitch] loop pos=…", as if X were on (device session 2026-11-20).
// Both take a log label now; Orgasm Switch keeps its old prefix.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { engageHandyFinisher } from '../../renderer/js/orgasm-handy-engage.js';
import { OrgasmSwitch } from '../../renderer/js/orgasm-switch.js';

const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }] });

function fakeHandy({ setupOk = true, url = 'https://cloud/x.csv' } = {}) {
  return {
    uploadScriptOnly: vi.fn(async () => url),
    setupScript: vi.fn(async () => setupOk),
    hsspPlay: vi.fn(async () => true),
    hsspStop: vi.fn(async () => {}),
  };
}

/** Every console line the call printed, as one string each. */
function captureConsole() {
  const lines = [];
  const grab = (...a) => lines.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  return lines;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('engageHandyFinisher log label', () => {
  it('logs [EdgeHold] when Edge Hold engages, never [OrgasmSwitch]', async () => {
    const lines = captureConsole();
    const status = await engageHandyFinisher({
      handyManager: fakeHandy(), content: SCRIPT, cachedUrl: null, isCurrent: () => true, logTag: 'EdgeHold',
    });
    expect(status).toBe('looping');
    expect(lines).toContain('[EdgeHold] Handy finisher looping via HSSP');
    expect(lines.join('\n')).not.toContain('[OrgasmSwitch]');
  });

  it('the failure lines carry the label too', async () => {
    const lines = captureConsole();
    await engageHandyFinisher({
      handyManager: fakeHandy({ url: null }), content: SCRIPT, cachedUrl: null, isCurrent: () => true, logTag: 'PatternTest',
    });
    const handy = fakeHandy();
    handy.setupScript = vi.fn(async () => { throw new Error('boom'); });
    await engageHandyFinisher({ handyManager: handy, content: SCRIPT, cachedUrl: null, isCurrent: () => true, logTag: 'PatternTest' });
    expect(lines.some((l) => l.startsWith('[PatternTest] Handy: no finisher cloud URL'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[PatternTest] Handy HSSP-loop engage error:'))).toBe(true);
  });

  it('Orgasm Switch (no label) keeps its old prefix', async () => {
    const lines = captureConsole();
    await engageHandyFinisher({ handyManager: fakeHandy(), content: SCRIPT, cachedUrl: null, isCurrent: () => true });
    expect(lines).toContain('[OrgasmSwitch] Handy finisher looping via HSSP');
  });
});

describe('OrgasmSwitch loop log label', () => {
  function runLoop(extra) {
    const clock = { t: 0 };
    const os = new OrgasmSwitch({
      buttplugManager: { connected: true, devices: [{ index: 0, name: 'Stroker', canLinear: true }], sendLinear: vi.fn(), sendVibrate: vi.fn(), sendRotate: vi.fn() },
      tcodeManager: null,
      handyManager: null,
      now: () => clock.t,
      ...extra,
    });
    os.setTimerImpl(() => 1, () => {});
    os.loadScript(SCRIPT);
    os.activate();
    clock.t = 600; // past the 500 ms log throttle, mid-stroke
    os._tick();
    os.deactivate();
  }

  it('an Edge Hold engine logs its loop as [EdgeHold]', () => {
    const lines = captureConsole();
    runLoop({ logTag: 'EdgeHold' });
    expect(lines.some((l) => l.startsWith('[EdgeHold] loop pos='))).toBe(true);
    expect(lines.join('\n')).not.toContain('[OrgasmSwitch] loop pos=');
  });

  it('the Orgasm Switch engine keeps [OrgasmSwitch]', () => {
    const lines = captureConsole();
    runLoop({});
    expect(lines.some((l) => l.startsWith('[OrgasmSwitch] loop pos='))).toBe(true);
  });
});
