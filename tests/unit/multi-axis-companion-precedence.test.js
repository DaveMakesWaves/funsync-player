/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// An assigned companion axis file beats the same axis embedded in the main
// script, whatever order the two loads land in (app test V11).
//
// `_playFromLibrary` starts `loadFunscript` (whose `_feedEmbeddedMultiAxis`
// runs after an await) and `_loadMultiAxisScripts` (one awaited read per
// companion) together and awaits neither. The feed cleared the buttplug
// axes and wrote every embedded axis; each companion wrote as its read
// finished. Whichever landed last won: the tester's edited, extracted twist
// companion lost to the original embedded twist in 6 opens out of 7, on
// both engines.
//
// The REAL methods are lifted out of app.js and run against the REAL
// ButtplugSync and TCodeSync. Companion reads are deferred promises, so each
// test drives one exact interleaving. What is asserted is what the engines
// will play: the action array each holds per TCode channel.
import { describe, it, expect, vi } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';
import { TCodeSync } from '../../renderer/js/tcode-sync.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { extractEmbeddedAxes } from '../../renderer/js/embedded-multi-axis.js';
import { getAxisBySuffix } from '../../renderer/js/multi-axis.js';

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

const ramp = (n, base) => Array.from({ length: n }, (_, i) => ({ at: i * 100, pos: (base + i * 7) % 100 }));

// The main script carries twist/roll/pitch (Format E). The user extracted
// them, then edited twist and pitch, so those companions differ in length
// and content from the embedded copies.
const EMBED = { R0: ramp(12, 10), R1: ramp(14, 20), R2: ramp(16, 30) };
const COMP = { R0: ramp(3, 60), R2: ramp(5, 70) };
const MAIN_PATH = 'C:/lib/Combined Clip.funscript';
const MAIN_RAW = JSON.stringify({
  actions: ramp(20, 0),
  axes: [
    { id: 'R0', actions: EMBED.R0 },
    { id: 'R1', actions: EMBED.R1 },
    { id: 'R2', actions: EMBED.R2 },
  ],
});
const TWIST = 'C:/lib/Combined Clip.twist.funscript';
const PITCH = 'C:/lib/Combined Clip.pitch.funscript';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** An app as `_playFromLibrary` leaves it just before the two loads start. */
function makeApp() {
  const app = new LiftedApp();
  const player = new EventTarget();
  app.buttplugSync = new ButtplugSync({ videoPlayer: player, buttplugManager: {}, funscriptEngine: {} });
  app.tcodeSync = new TCodeSync({ videoPlayer: player, tcodeManager: {}, funscriptEngine: {} });
  app.funscriptEngine = { isLoaded: true };
  app.videoPlayer = { duration: NaN };
  app.scriptEditor = null;
  app.buttplugManager = { connected: false };
  app._currentVideoPath = 'C:/lib/Combined Clip.mp4';
  app._currentFunscriptPath = MAIN_PATH;
  app._embeddedAxisTcodes = new Set();
  app._companionAxesFailed = new Set();
  // One deferred read per companion path, resolved by the test.
  app.reads = new Map();
  app._readScriptResilient = (p) => {
    const d = deferred();
    app.reads.set(p, d);
    return d.promise;
  };
  return app;
}

const file = (actions) => ({ content: JSON.stringify({ actions }) });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** What each engine will play on a channel. */
function playing(app, tcode) {
  return {
    buttplug: app.buttplugSync._axisActions.get(tcode)?.actions ?? null,
    tcode: app.tcodeSync._axisActions.get(tcode)?.actions ?? null,
  };
}

function expectChannel(app, tcode, actions) {
  expect(playing(app, tcode)).toEqual({ buttplug: actions, tcode: actions });
}

/**
 * Start both loads in the given interleaving. `feedAt` is how many companion
 * reads resolve before the embedded feed lands: 0 = before any, 1 = after
 * the twist read (the order the tester saw in 6 of 7 opens), 2 = after all.
 * 'first' = the feed lands before the companion loader even starts.
 */
async function openVideo(app, config, feedAt, contents) {
  app._currentMultiAxis = config;
  if (feedAt === 'first') app._feedEmbeddedMultiAxis(MAIN_RAW, MAIN_PATH);
  const loading = app._loadMultiAxisScripts(config);
  const order = Object.values(config.axes);
  for (let i = 0; i < order.length; i++) {
    if (feedAt === i) app._feedEmbeddedMultiAxis(MAIN_RAW, MAIN_PATH);
    await settle();
    app.reads.get(order[i]).resolve(contents[order[i]]);
    await settle();
  }
  if (feedAt === order.length) app._feedEmbeddedMultiAxis(MAIN_RAW, MAIN_PATH);
  await loading;
}

describe('assigned companions beat embedded axes in every load order (V11)', () => {
  const ORDERS = [
    ['the embedded feed lands before any companion read', 0],
    ['the embedded feed lands between the twist and pitch reads', 1],
    ['the embedded feed lands after every companion read', 2],
    ['the embedded feed lands before the companion loader starts', 'first'],
  ];

  it.each(ORDERS)('%s', async (_label, feedAt) => {
    const app = makeApp();
    const config = { axes: { twist: TWIST, pitch: PITCH } };
    await openVideo(app, config, feedAt, { [TWIST]: file(COMP.R0), [PITCH]: file(COMP.R2) });

    // The edited companions play on both engines...
    expectChannel(app, 'R0', COMP.R0);
    expectChannel(app, 'R2', COMP.R2);
    // ...and roll, which has no companion, still plays from the main file.
    expectChannel(app, 'R1', EMBED.R1);
  });

  it('still lists every embedded axis for the badge and Extract, companion-covered or not', async () => {
    const app = makeApp();
    await openVideo(app, { axes: { twist: TWIST, pitch: PITCH } }, 1,
      { [TWIST]: file(COMP.R0), [PITCH]: file(COMP.R2) });
    expect(app.getEmbeddedAxes(MAIN_PATH).suffixes.sort()).toEqual(['pitch', 'roll', 'twist']);
  });
});

describe('an unreadable companion hands its axis back to the embedded copy', () => {
  it.each([
    ['feed before the failed read', 0],
    ['feed after the failed read', 1],
    ['feed after every read', 2],
  ])('%s', async (_label, feedAt) => {
    const app = makeApp();
    const config = { axes: { twist: TWIST, pitch: PITCH } };
    // twist was moved and could not be recovered: the read gives null.
    await openVideo(app, config, feedAt, { [TWIST]: null, [PITCH]: file(COMP.R2) });

    expectChannel(app, 'R0', EMBED.R0);
    expectChannel(app, 'R2', COMP.R2);
    expectChannel(app, 'R1', EMBED.R1);
  });
});

describe('a companion read that lands after the next video loaded', () => {
  it('writes nothing onto the new video', async () => {
    const app = makeApp();
    const config = { axes: { twist: TWIST } };
    app._currentMultiAxis = config;
    const loading = app._loadMultiAxisScripts(config);
    await settle();

    // loadVideo for another (single-axis) video: engines emptied, config gone.
    app.buttplugSync.clearAxisActions();
    app.tcodeSync.clearAxisActions();
    app._currentMultiAxis = null;

    app.reads.get(TWIST).resolve(file(COMP.R0));
    await loading;
    expect(playing(app, 'R0')).toEqual({ buttplug: null, tcode: null });
  });
});
