/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// E-09 (2026-11-07; also in v0.9.2): the phone ignored the desktop's starred
// (pinned) variant. A phone session loaded the video's first script and told
// the phone so, while a desktop open of the same video starts the pinned one
// (`library.preferredVariants`, `_applyPreferredVariant`). In a phone session
// the DESKTOP drives the devices, so the fix is there: the session starts on
// the pinned variant and the phone's chip is told which one that is (the
// phone's `variant-changed` handler already follows it), so the chip and the
// script the devices get agree.
//
// The REAL app.js `_onRemotePhoneConnected` (lifted) with a fake streamer
// Handy (no key, nothing leaves the test). Asserted on what the engine and the
// Handy were given and what the phone was told.
import { describe, it, expect, vi } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { pickVariantIndexOnLoad } from '../../renderer/js/variant-select.js';
import { stripBOM } from '../../renderer/js/funscript-engine.js';
import { fillRawScriptContent } from '../../renderer/js/filler-engine.js';
import { resolveFillerOptions } from '../../renderer/js/filler-presets.js';
import {
  extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
} from '../../renderer/js/device-transform-stack.js';
import { RemotePlaybackProxy } from '../../renderer/js/remote-playback-proxy.js';
import { SOURCE_PLAYER } from '../../renderer/js/audience-bridge.js';

const METHODS = [
  '_onRemotePhoneConnected', '_phonePinnedVariant', '_getPreferredVariantLabel',
  '_handlePhoneSwitchVariant', '_switchVariant', '_editorAllowsReplace',
  '_audienceScriptContent', '_fillerOptionsForUpload', '_handyInverted', '_cutoffFromSettings',
  '_uploadAndStartSync', '_handyUploadContent',
  '_autoblowUploadContent', '_sessionTimelineMs', '_uploadDurationMsFor', // FT-113
];

const IP = '192.168.1.5';
const VIDEO = 'C:\\v\\clip.mp4';
const MAIN = 'C:\\v\\clip.funscript';
const SOFT = 'C:\\v\\clip (soft).funscript';
const VARIANTS = [
  { label: 'Default', path: MAIN, name: 'clip.funscript' },
  { label: 'soft', path: SOFT, name: 'clip (soft).funscript' },
];
const script = (label) => JSON.stringify({ version: '1.0', _label: label, actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] });
const labelOf = (c) => { try { return JSON.parse(c)._label; } catch { return null; } };

function build({ settings = {}, disk = { [MAIN]: script('main'), [SOFT]: script('soft') } } = {}) {
  const S = {
    'library.preferredVariants': {},
    'player.gapFiller': { enabled: false },
    'player.rangeExtender.enabled': false,
    ...settings,
  };
  const reads = [];
  const fakeWindow = { funsync: { readFunscript: vi.fn(async (p) => { reads.push(p); return disk[p] ?? null; }) } };
  const Lifted = liftAppClass(METHODS, {
    window: fakeWindow, document: { getElementById: () => null },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    showToast: () => ({ dismiss() {} }), t: (k) => k,
    pickVariantIndexOnLoad, stripBOM, fillRawScriptContent, resolveFillerOptions,
    extendRawScriptContent, clampRawScriptContent, invertRawScriptContent,
    RemotePlaybackProxy, SOURCE_PLAYER,
  });
  const engineLoads = [];
  const handyUploads = [];
  const toPhone = [];
  const app = Object.assign(new Lifted(), {
    settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; } },
    videoPlayer: { video: { paused: true, pause() {} }, duration: NaN },
    funscriptEngine: {
      isLoaded: false, _raw: null,
      loadContent: vi.fn(async function (c) { this.isLoaded = true; this._raw = c; engineLoads.push(labelOf(c)); return { filename: 'x', actionCount: 2 }; }),
      getRawContent() { return this._raw; },
      getActions: () => [{ at: 0, pos: 10 }, { at: 500, pos: 90 }], getChapters: () => [], getBookmarks: () => [],
    },
    // The streamer's own Handy, a fake: what it was given to play.
    handyManager: {
      connected: true,
      uploadAndSetScript: vi.fn(async (c) => { handyUploads.push(labelOf(c)); return true; }),
      hsspStop: vi.fn(async () => true),
    },
    syncEngine: { _active: false, _scriptReady: false, player: null, start() { this._active = true; }, stop() { this._active = false; } },
    autoblowManager: null, autoblowSync: null, buttplugSync: null, tcodeSync: null, buttplugManager: null, tcodeManager: null,
    audienceBridge: null, scriptEditor: null, sessionTracker: null, progressBar: { renderHeatmap() {}, setMarkers() {} },
    remoteBridge: { connected: true, sendToPhone: (m) => toPhone.push(m) },
    library: { _videosByPath: new Map([[VIDEO, { name: 'clip', hasFunscript: true, funscriptPath: MAIN, variants: VARIANTS }]]) },
    _videoLoadGen: 0, _remotePhoneEpoch: 0, _variantsPhoneEpoch: null,
    _currentVariants: [], _allVariantsWithManual: [], _activeVariantIndex: 0, _activeVariantPath: null,
    _currentVideoPath: null, _remoteActive: false,
    // As the real one builds it (no manual variants here).
    _updateVariantSelector() { this._allVariantsWithManual = [...this._currentVariants]; },
    _planLazyRehome: () => null,
    _applyVideoSyncOffset() {}, _resetCustomRoutingState() {}, _clearLocalAxesForRemote() {},
    _stashLocalScriptBeforeRemote() {}, _refreshLoopVideoVisibility() {}, _pushRemoteDeviceStatus() {},
    _markCloudUploadsPending() {}, _showScriptLoadingOverlay() {}, _hideScriptLoadingOverlay() {}, _clearCloudUploadGate() {},
    _readScriptResilient: async (p) => (disk[p] ? { content: disk[p] } : null),
    _healManualVariantPath() {}, _feedInlineViz() {}, _showFunscriptBadge() {}, _formatActionsDuration: () => '0:00',
    _tryStartAutoblowSync: async () => {}, _startGapSkip() {}, _resolveCloudUpload() {},
    _variantLabelText: (v) => v.label,
  });
  return { app, reads, engineLoads, handyUploads, toPhone, S };
}

const chip = (ctx) => ctx.toPhone.filter((m) => m.type === 'variant-changed').map((m) => m.label);

describe('E-09: a phone session starts on the desktop\'s pinned variant, and the phone is told', () => {
  it('pinned "soft": the engine and the Handy get the soft script, and the phone\'s chip names it', async () => {
    const ctx = build({ settings: { 'library.preferredVariants': { [VIDEO]: 'soft' } } });
    await ctx.app._onRemotePhoneConnected(IP, 'id1', VIDEO);
    expect(ctx.engineLoads).toEqual(['soft']);
    expect(ctx.handyUploads).toEqual(['soft']);
    expect(chip(ctx)).toEqual(['soft']);
    expect(ctx.app._activeVariantIndex).toBe(1);
    expect(ctx.app._activeVariantPath).toBe(SOFT);
    expect(ctx.toPhone.some((m) => m.type === 'script-ready')).toBe(true);
  });

  it('the phone then taps Default: the devices go to the default script', async () => {
    const ctx = build({ settings: { 'library.preferredVariants': { [VIDEO]: 'soft' } } });
    await ctx.app._onRemotePhoneConnected(IP, 'id1', VIDEO);
    await ctx.app._handlePhoneSwitchVariant('Default');
    expect(ctx.engineLoads.at(-1)).toBe('main');
    expect(ctx.handyUploads.at(-1)).toBe('main');
    expect(chip(ctx).at(-1)).toBe('Default');
  });

  it('no pin: the first script, as before', async () => {
    const ctx = build();
    await ctx.app._onRemotePhoneConnected(IP, 'id1', VIDEO);
    expect(ctx.engineLoads).toEqual(['main']);
    expect(chip(ctx)).toEqual(['Default']);
    expect(ctx.app._activeVariantIndex).toBe(0);
  });

  it('a pin the phone does not list (a manual variant): the first script, and the chip says so', async () => {
    const ctx = build({ settings: { 'library.preferredVariants': { [VIDEO]: 'my manual one' } } });
    await ctx.app._onRemotePhoneConnected(IP, 'id1', VIDEO);
    expect(ctx.engineLoads).toEqual(['main']);
    expect(chip(ctx)).toEqual(['Default']);
  });

  it('the pinned file cannot be read now: the video\'s own script plays and the chip names it', async () => {
    const ctx = build({
      settings: { 'library.preferredVariants': { [VIDEO]: 'soft' } },
      disk: { [MAIN]: script('main') },
    });
    await ctx.app._onRemotePhoneConnected(IP, 'id1', VIDEO);
    expect(ctx.reads).toEqual([SOFT, MAIN]);
    expect(ctx.engineLoads).toEqual(['main']);
    expect(chip(ctx)).toEqual(['Default']);
    expect(ctx.app._activeVariantIndex).toBe(0);
  });

  it('random variant on (it beats a pin on the desktop): the first script, as before', async () => {
    const ctx = build({ settings: { 'library.preferredVariants': { [VIDEO]: 'soft' }, 'player.randomVariantOnPlay': true } });
    await ctx.app._onRemotePhoneConnected(IP, 'id1', VIDEO);
    expect(ctx.engineLoads).toEqual(['main']);
    expect(chip(ctx)).toEqual(['Default']);
  });
});
