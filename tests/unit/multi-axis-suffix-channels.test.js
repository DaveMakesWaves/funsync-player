/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block C fix-up (2026-11-06, real-app verifier 2 on FT-047; also in v0.9.2):
// a `.suck` companion never reached a device. FT-047 made the scan treat
// `Clip.suck.funscript` / `Clip.a1.funscript` as an axis file, keyed by the
// canonical suffix `suck` (multi-axis.js AXIS_DEFINITIONS), but the player's
// loader mapped suffixes with its own hand-written table, which had no
// `suck`: the axis hit `continue` and only "[MultiAxis] Loaded twist (R0)"
// was logged. The same table still put suction on V2 (a channel a stock OSR2
// does not have) and lube on V1, pump's channel, so a lube companion and a
// pump companion overwrote each other. AXIS_DEFINITIONS moved those to A1
// and A2 on 2026-08-16; the loader never followed.
//
// The REAL `_loadMultiAxisScripts` / `_applyEmbeddedAxes` are lifted out of
// app.js and run against the REAL ButtplugSync and TCodeSync. What is
// asserted is what each engine will play, per TCode channel.
import { describe, it, expect, vi } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { extractEmbeddedAxes } from '../../renderer/js/embedded-multi-axis.js';
import { getAxisBySuffix, AXIS_DEFINITIONS, axisSuffixVariants } from '../../renderer/js/multi-axis.js';

const LiftedApp = liftAppClass([
  '_loadMultiAxisScripts',
  '_feedEmbeddedMultiAxis',
  '_applyEmbeddedAxes',
  '_companionAxisSuffixes',
  '_releaseCompanionAxis',
  'getEmbeddedAxes',
  '_refreshEditorScriptList',
], {
  console: { log() {}, warn() {}, error() {} },
  showToast: vi.fn(),
  t: (k) => k,
  stripBOM,
  extractEmbeddedAxes,
  getAxisBySuffix,
});

// Each file gets its own action count, so a channel shows which file it plays.
const actionsOf = (n) => Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: (i * 37) % 100 }));

function makeApp(files) {
  const app = new LiftedApp();
  const player = new EventTarget();
  app.buttplugSync = new ButtplugSync({ videoPlayer: player, buttplugManager: {}, funscriptEngine: {} });
  app.tcodeSync = new TCodeSync({ videoPlayer: player, tcodeManager: {}, funscriptEngine: {} });
  app.funscriptEngine = { isLoaded: true };
  app.videoPlayer = { duration: NaN };
  app.scriptEditor = null;
  app.buttplugManager = { connected: false };
  app._currentVideoPath = 'C:/lib/Alias Clip.mp4';
  app._currentFunscriptPath = 'C:/lib/Alias Clip.funscript';
  app._embeddedAxisTcodes = new Set();
  app._companionAxesFailed = new Set();
  app._readScriptResilient = async (p) => (files[p] ? { content: JSON.stringify({ actions: files[p] }) } : null);
  return app;
}

/** Channel -> action count, as each engine holds it. */
function channels(engine) {
  return Object.fromEntries([...engine._axisActions].map(([tc, s]) => [tc, s.actions.length]).sort());
}

async function openWith(axes, files) {
  const app = makeApp(files);
  const config = { axes };
  app._currentMultiAxis = config;
  await app._loadMultiAxisScripts(config);
  return app;
}

describe('companion axes land on the channel AXIS_DEFINITIONS gives them', () => {
  it('the verifier\'s Alias Clip: a `.suck` companion plays on A1 next to the `.R0` twist', async () => {
    // What the scan + auto-assign hand the loader for Alias Clip.suck / .R0.
    const app = await openWith(
      { twist: 'C:/lib/Alias Clip.R0.funscript', suck: 'C:/lib/Alias Clip.suck.funscript' },
      { 'C:/lib/Alias Clip.R0.funscript': actionsOf(9), 'C:/lib/Alias Clip.suck.funscript': actionsOf(12) },
    );
    expect(channels(app.buttplugSync)).toEqual({ A1: 12, R0: 9 });
    expect(channels(app.tcodeSync)).toEqual({ A1: 12, R0: 9 });
  });

  it('lube and pump no longer share V1: each keeps its own channel', async () => {
    const app = await openWith(
      { pump: 'C:/lib/c.pump.funscript', lube: 'C:/lib/c.lube.funscript' },
      { 'C:/lib/c.pump.funscript': actionsOf(5), 'C:/lib/c.lube.funscript': actionsOf(7) },
    );
    expect(channels(app.tcodeSync)).toEqual({ A2: 7, V1: 5 });
    expect(channels(app.buttplugSync)).toEqual({ A2: 7, V1: 5 });
  });

  it('every spelling the scan accepts (canonical and alias) reaches its channel', async () => {
    for (const axis of AXIS_DEFINITIONS) {
      for (const suffix of axisSuffixVariants(axis)) {
        const p = `C:/lib/c.${suffix}.funscript`;
        const app = await openWith({ [suffix]: p }, { [p]: actionsOf(4) });
        expect(channels(app.tcodeSync), `${suffix}`).toEqual({ [axis.tcode]: 4 });
      }
    }
  });
});

describe('embedded axes use the same channels (the main script\'s `axes` / named channels)', () => {
  it('an embedded V1 stays on V1 (pump), A1 is suction, A2 is lube; a legacy V2 suction plays on A1', async () => {
    const app = makeApp({});
    app._currentMultiAxis = null;
    const main = JSON.stringify({
      actions: actionsOf(20),
      axes: [
        { id: 'V1', actions: actionsOf(3) },
        { id: 'A1', actions: actionsOf(6) },
        { id: 'A2', actions: actionsOf(8) },
      ],
    });
    app._feedEmbeddedMultiAxis(main, 'C:/lib/main.funscript');
    await vi.waitFor(() => expect(channels(app.tcodeSync)).toEqual({ A1: 6, A2: 8, V1: 3 }));
    expect(channels(app.buttplugSync)).toEqual({ A1: 6, A2: 8, V1: 3 });

    const legacy = makeApp({});
    legacy._currentMultiAxis = null;
    legacy._feedEmbeddedMultiAxis(JSON.stringify({ actions: actionsOf(20), axes: [{ id: 'V2', actions: actionsOf(5) }] }), 'C:/lib/old.funscript');
    await vi.waitFor(() => expect(channels(legacy.tcodeSync)).toEqual({ A1: 5 }));
  });

  it('a `.suck` companion keeps the embedded suction off its channel (V11 precedence still holds for A1)', async () => {
    const SUCK = 'C:/lib/Alias Clip.suck.funscript';
    const app = makeApp({ [SUCK]: actionsOf(11) });
    const config = { axes: { suck: SUCK } };
    app._currentMultiAxis = config;
    await app._loadMultiAxisScripts(config);
    app._feedEmbeddedMultiAxis(JSON.stringify({ actions: actionsOf(20), axes: [{ id: 'A1', actions: actionsOf(6) }] }), app._currentFunscriptPath);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(channels(app.tcodeSync)).toEqual({ A1: 11 });
    expect(channels(app.buttplugSync)).toEqual({ A1: 11 });
  });
});
