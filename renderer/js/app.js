// FunSync Player — App Entry Point

import { VideoPlayer, PLAYBACK_RATE_PRESETS, frameStepTime } from './video-player.js';
import { eventBus } from './event-bus.js';
import { ProgressBar } from './progress-bar.js';
import { FunscriptEngine, isAutoMatch, stripBOM } from './funscript-engine.js';
import { extractEmbeddedAxes, buildCompanionFiles, companionPathMap } from './embedded-multi-axis.js';
import { getAxisBySuffix } from './multi-axis.js';
import { sourcesToProbe } from './source-state.js';
import { BackendBannerState } from './backend-banner-state.js';

/** Mirrors BACKEND_MISSING in electron/python-bridge.js. */
const BACKEND_MISSING = 'backend-executable-missing';

/**
 * Budget for a single source reachability probe, in ms. Matches the main
 * process default. A dead mapped network drive is the case this exists for:
 * Windows keeps the drive letter after a NAS goes offline so the path looks
 * real and the OS blocks on SMB. Too short and a slow-but-alive NAS gets
 * wrongly marked unreachable.
 */
const SOURCE_PROBE_TIMEOUT_MS = 800;
/**
 * The 30 s source poll's budget (R3-17). Longer than a user action's probe:
 * nothing waits on the poll, and a slow answer that arrives counts, while one
 * that does not is "unknown" and changes nothing. The poll never starts
 * another probe while one is out, so a sleeping network drive gets at most
 * one stat per root at a time.
 */
const SOURCE_POLL_TIMEOUT_MS = 5000;
import { HandyManager, uploadScriptToCloud } from './handy-manager.js';
import { AudienceBridge, SOURCE_PLAYER } from './audience-bridge.js';
import * as AUDIENCE from './audience-popout-protocol.js';
import * as PLAYERWIN from './player-popout-protocol.js';
import { SyncEngine } from './sync-engine.js';
import { ButtplugManager } from './buttplug-manager.js';
import { ButtplugSync } from './buttplug-sync.js';
import { TCodeManager } from './tcode-manager.js';
import { TCodeSync } from './tcode-sync.js';
import { AutoblowManager } from './autoblow-manager.js';
import { AutoblowSync } from './autoblow-sync.js';
import { VRBridge, funsyncVideoIdFromVRPath, vrDisplayName } from './vr-bridge.js';
import { RemoteBridge } from './remote-bridge.js';
import { RemotePlaybackProxy } from './remote-playback-proxy.js';
import { SessionTracker } from './session-tracker.js';
import { SessionCard } from '../components/session-card.js';
import { openSessionHistory } from '../components/session-history-modal.js';
import { SettingsPanel } from '../components/settings-panel.js';
import { ConnectionPanel } from '../components/connection-panel.js';
import { DragDrop } from './drag-drop.js';
import { KeyboardHandler } from './keyboard.js';
import { dataService } from './data-service.js';
import { showToast } from './toast.js';
import { showUpdateAvailableToast, showUpdateReadyToast } from './update-toasts.js';
import { maybeShowHevcGuidance } from './hevc-detect.js';
import { describeVideoCodec, hasRealVideoStream, isAudioPath, playedSeconds, NO_FRAMES_GRACE_SEC } from './video-load-check.js';
import { initTheme } from './theme-manager.js';
import { matchButtplugRoute } from './custom-routing-match.js';
import { extendRawScriptContent, clampRawScriptContent, invertRawScriptContent } from './device-transform-stack.js';
import { fillRawScriptContent } from './filler-engine.js';
import { createCategoryMark } from './category-icon.js';
import { resolveFillerOptions } from './filler-presets.js';
import { FillerTestPlayer } from './filler-test-player.js';
import { normalizeAssociation, buildAssociationEntry, resolveActiveConfig } from './association-shape.js';
import { pathToFileURL, canonicalPath, isSubpath } from './path-utils.js';
import { Library, thumbRequestOpts, customThumbImagePath } from '../components/library.js';
import { QueuePanel } from '../components/queue-panel.js';
import { NavBar } from '../components/nav-bar.js';
import { Modal } from '../components/modal.js';
import { rankFunscriptMatches } from './fuzzy-match.js';
import { Playlists } from '../components/playlists.js';
import { Categories } from '../components/categories.js';
import { ScriptEditor } from '../components/script-editor.js';
import { DeviceSimulator } from '../components/device-simulator.js';
import { GapSkipEngine } from './gap-skip.js';
import { UpNextEngine } from './up-next.js';
import { UpNextCard } from '../components/up-next-card.js';
import { EroScriptsPanel } from '../components/eroscripts-panel.js';
import {
  createIcons, icon, Play, Pause, Volume2, VolumeX, Volume1, FolderOpen, Bluetooth, Cable,
  EllipsisVertical, Keyboard, Gauge, ChevronDown, Goggles, Repeat1,
  Maximize, Maximize2, Minimize, ArrowLeft, Plus, PictureInPicture2, SkipBack, SkipForward,
  Pencil, FileCheck, Captions, RotateCcw, Columns2, X, Activity, Thermometer, MoveVertical,
} from './icons.js';
import { libraryPlayRequest } from './library-play-options.js';
import { compareVideoNames } from './library-search.js';
import { startInit, span, mark, logSummary } from './startup-timer.js';
import { installConsoleForwarding } from './logger.js';
import { watchWcoClass } from './wco.js';
import { isVideoInPip, teardownPlayback, beginDeferredPipTeardown } from './pip-guard.js';
import { shouldEnterMiniplayer, exitFullscreenForNav } from './miniplayer.js';
import { pickRehomeCandidate, findMovedFile } from './association-rehome.js';
import { classifyStereoFormat, isFlattenableStereo, isVRVideo } from './vr-detect.js';
import {
  applyZoomStep, resetZoomFields, applyPanDelta, wheelDirection, isSpherical,
} from './vr-zoom.js';
import { HandyHdspSync } from './handy-hdsp-sync.js';
import { OrgasmSwitch } from './orgasm-switch.js';
import { engageHandyFinisher, releaseHandyFinisher } from './orgasm-handy-engage.js';
import { resolveOrgasmPlan, parseFinisherActions, collectOrgasmScriptPaths, describeOrgasmEntry } from './orgasm-plan.js';
import { edgeHoldAction } from './pattern-source.js';
// The one pattern choice of Gap Filler, X and Z (pattern settings
// unification, 2026-11-19): the new keys, else derived from the old ones
// (orgasmPattern, orgasmLibraryPattern, edgePattern), which are never written.
import {
  patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
} from './pattern-choice.js';
import { videoSyncOffsetOf, withVideoSyncOffset } from './video-sync-offset.js';
import { openOrgasmConfigModal } from '../components/orgasm-config-modal.js';
import { pickVariantIndexOnLoad } from './variant-select.js';
import { planVariantAdds, pickedFiles, showBulkVariantNaming } from './variant-bulk-add.js';
import { remoteVariantList } from './variant-names.js';
import { InlineViz } from '../components/inline-viz.js';
import { shuffle as shuffleArray, reshuffleAvoidingRepeat, balancedShuffle, reshuffleBalancedAvoidingRepeat } from './shuffle.js';
import { partitionByWatched } from './playlist-progress.js';
import { initI18n, setLocale, translatePage, t, LOCALE_LABELS } from './i18n.js';
import {
  shouldRecordPosition,
  shouldOfferResume,
  formatResumeTime,
  makeResumeEntry,
  makeFinishedEntry,
  isFinished,
  endThreshold,
  RESUME_WRITE_INTERVAL_MS,
  RESUME_MIN_DELTA_SECONDS,
} from './resume-position.js';
// The funscript metadata harvest and the phone's tag slice (P1 tags, Round 3).
import { scriptMetaMap, onScriptMetaChanged, refreshScriptMeta, getScriptMeta } from './script-meta-store.js';
import { buildRemoteTagSlice, remoteTagSliceFromIndex, REMOTE_TAG_SETTING_PATHS } from './remote-tag-slice.js';
// Stash S1: the renderer's copy of main's Stash data, and the seek bar's
// Stash markers.
import {
  initStashStore, onStashChanged, onStashSettingsChanged, stashData, stashSyncOnStart, isStashSettingPath,
} from './stash-store.js';
import { stashMarkersForVideo, chapterStarts } from './stash-markers.js';

/** Default opacity (percent) for the inline TL/HM overlays. */
const INLINE_VIZ_OPACITY_DEFAULT = 80;
const DEVICE_SIM_OPACITY_DEFAULT = 80;
/** Quiet time after the last editor save before audience viewers are sent
 *  the edited script (FT-094): each send stops every viewer for a setup, and
 *  autosave writes after every pause in editing. */
const AUDIENCE_EDIT_RESEND_MS = 1500;

class App {
  constructor() {
    this.videoPlayer = null;
    this.progressBar = null;
    this.funscriptEngine = null;
    this.handyManager = null;
    this.audienceBridge = null;
    this.syncEngine = null;
    this.buttplugManager = null;
    this.buttplugSync = null;
    this.tcodeManager = null;
    this.tcodeSync = null;
    this.autoblowManager = null;
    this.autoblowSync = null;
    this.vrBridge = null;
    this.remoteBridge = null;
    this._remoteProxy = null;
    this._remoteActive = false;  // true while a phone is driving devices
    // The shared engine holds a script the phone or a VR headset loaded, not
    // this window's video's; stays true after that session until a local
    // load (R3-20, ScriptEditor.engineHeldByRemote).
    this._engineHeldByRemote = false;
    this._remotePausedDesktop = false;
    // Bumped by every phone disconnect: a phone load still in flight sees it
    // and stops (#361 review). The variant list carries the value of the
    // phone session that filled it, or null when it is the local video's.
    this._remotePhoneEpoch = 0;
    this._variantsPhoneEpoch = null;
    this.connectionPanel = null;
    this.settings = dataService;
    this.scriptEditor = null;
    this.deviceSimulator = null;
    this.library = null;
    this.navBar = null;
    this.playlists = null;
    this.categories = null;
    this.backendPort = null;
    this._currentVideoUrl = null;
    this._currentVideoName = null;
    this._pendingFunscripts = [];
    this._currentVideoPath = null;
    // Per-video sync offset (#380): the delta every device has on top of its
    // own offset right now, and the library video it belongs to while VR or
    // the phone plays one (null = the local player's `_currentVideoPath`).
    // See `_applyVideoSyncOffset`.
    this._videoSyncOffsetMs = 0;
    this._vrSyncOffsetPath = null;
    this._vrSyncOffsetActive = false;
    this._phoneSyncOffsetPath = null;
    this._phoneSyncOffsetActive = false;
    // Path of the funscript currently loaded — the key everything reads
    // embedded-axes state back with. See loadFunscript.
    this._currentFunscriptPath = null;
    this._playQueue = [];
    this._playQueueIndex = -1;
    this._playQueueSource = null; // { sourceLabel, sourceContext } — captured at Play All start
    this._playQueueLoop = false;  // when true, queue wraps after the last item (per-playlist preference)
    this._playQueueShuffle = false; // when true, _playQueue was shuffled at Play All; reshuffle on loop wrap

    // Queue panel state (SCOPE-queue-panel.md). History is session-
    // bounded and resets when the panel is closed; user queue persists
    // via dataService. `_queueHistoryPushedForCurrent` is a one-shot
    // flag per video load so the 5s threshold fires exactly once.
    this._queueHistory = [];
    this._queueHistoryCap = 50;
    this._queueHistoryThresholdMs = 5000;
    this._queueHistoryPushedForCurrent = false;
    this._userQueue = []; // hydrated from settings on boot
    // FN-07: P's way back from a video your queue played. Each entry is
    // { from, fromCtx, to }: `to` came off your queue while `from` (with its
    // play context) was playing. `_userQueueNavPaths` holds the paths a queue
    // jump or a back is loading; any other load ends the way back (loadVideo).
    this._userQueueBack = [];
    this._userQueueNavPaths = new Set();
    // A queued video loading as the current video's advance (R3-15 fix-up,
    // see _jumpToVideoFromQueue): { gen, done } or null.
    this._queueJumpPending = null;

    this._navStack = ['library']; // navigation history stack — current view is last element
    this._miniActive = false; // mini-player docked (video plays in a corner overlay while browsing)
    this._scriptCloudUrl = null; // cloud URL of the last uploaded script (for re-setup after HDSP)
    // Cloud-upload gate. `_pendingUploads` is the set of devices whose
    // funscript upload is currently in flight; `_waitingForScript` is
    // its derived "any of them" flag, kept as a separate variable for
    // back-compat with all the existing readers (loadVideo's loadeddata
    // handler, the variant-switch loading overlay path, the timeout
    // fallback). When the last upload resolves, `_resolveCloudUpload`
    // flips the flag and triggers the deferred `play()`.
    this._pendingUploads = new Set();
    this._waitingForScript = false;
    this._scriptLoadingTimeout = null; // fallback timeout for script upload
  }

  async init() {
    startInit();
    // Initialize data service (loads data from main process, handles migration)
    await span('dataService.init', () => dataService.init());

    // Apply the user's theme preference (or follow the OS) before any
    // visual paint hits the user. Cheap (sets one attribute on <html>)
    // and must happen post-dataService-init since we read the setting.
    initTheme(dataService);

    // i18n — load the active-locale bundle BEFORE any component renders
    // so the initial DOM is in the right language. The first-launch
    // language-offer toast (decision #3) fires later from
    // `_offerLocaleIfApplicable` once toast.js is wired.
    await this._initI18n();

    // Surface the boot-time auto-recovery result if the main process
    // restored config.json from a snapshot during this launch
    // (SCOPE-data-backup.md §4.4 + §8.2). One-shot read — main clears
    // the stored result after we consume it so a renderer reload
    // doesn't replay the toast. After i18n, so the toast is in the
    // user's language.
    this._maybeShowRecoveryToast();

    // Renderer error handlers. These route through console.error, which
    // logger.installConsoleForwarding() (called at boot) forwards into the
    // electron-log file — so uncaught errors land in the user-submittable
    // log. Include source location + stack for diagnosis.
    window.onerror = (msg, src, line, col, err) => {
      const where = src ? ` @ ${src}:${line}:${col}` : '';
      console.error(`[Window]${where} ${msg}`, err?.stack || err || '');
    };
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      console.error('[Rejection]', r?.stack || r?.message || r);
    });

    // Replace <i data-lucide="..."> placeholders with SVG icons.
    // Volume1 added 2026-04-27 for the 3-state mute icon (audible /
    // low-or-zero / explicitly muted). Cable added to replace the
    // misleading bluetooth icon on the device button.
    createIcons({
      icons: {
        Play, Pause, Volume2, Volume1, VolumeX, FolderOpen, Bluetooth, Cable,
        Maximize, Minimize, ArrowLeft, Plus, PictureInPicture2, SkipBack, SkipForward,
        Pencil, RotateCcw, EllipsisVertical,
        // 'keyboard' icon for the overflow menu's help item; lucide
        // ships it as `keyboard.js`. Resolved by createIcons via
        // data-lucide attribute lookup at the placeholder site.
        Keyboard,
        // 'gauge' for the overflow menu's playback-speed item. 'chevron-down'
        // replaces the raw `▾` glyph on the variant-selector button so the
        // toolbar reads consistently as proper SVG iconography.
        // menu's VR Format item — only shown for VR-detected videos.
        //
        // NOTE THE KEY. createIcons looks up icons[toPascalCase(attr)], so
        // `data-lucide="rectangle-goggles"` resolves to `RectangleGoggles`.
        // It was registered as `Goggles` (our import alias, used by
        // nav-bar.js) and therefore never matched — the icon rendered as
        // nothing and logged "icon name was not found" on every boot.
        Gauge, ChevronDown, RectangleGoggles: Goggles,
        // Loop-one icon: the loop-mode button and its overflow-menu twin in
        // index.html. The player pop-out registered this; the main window
        // did not, so it was blank in the main window only.
        Repeat1,
        // Queue panel toggle icon (Android Auto split-screen look).
        Columns2,
        // 'maximize-2' for the "Pop out player" overflow item (detached
        // player window, SCOPE-separate-player-window.md).
        Maximize2,
        // Inline visualisation toggles in the overflow menu: 'activity' for
        // the script timeline (pulse-line reads as a motion trace),
        // 'thermometer' for the heatmap strip.
        Activity, Thermometer,
        // 'move-vertical' (an up/down stroke) for the Device simulator item.
        MoveVertical,
      },
      attrs: { width: 20, height: 20, 'stroke-width': 1.75 },
    });

    // Get backend port from main process
    try {
      this.backendPort = await span('getBackendPort IPC', () => window.funsync.getBackendPort());
      console.log(`Backend running on port ${this.backendPort}`);
    } catch (err) {
      console.warn('Could not get backend port:', err.message);
    }

    // Wire the backend-disconnected banner. State events stream from
    // the main-process health monitor; first paint queries the
    // current state via getBackendHealth. See SCOPE-design-polish-queue
    // / `electron/python-bridge.js` for the failure-mode rationale.
    this._initBackendBanner();
    // The View menu's Ctrl+= / Ctrl+- / Ctrl+0 zoom the window and save the
    // step in MAIN; keep the cached setting (and an open Settings panel) in
    // step without writing it back (V79).
    window.funsync?.onUiScaleChanged?.((scale) => this.settings?.applySavedSetting?.('player.uiScale', scale));
    // A restarted backend is a new process with an empty registry (V22).
    window.funsync.onBackendStatus?.(({ state } = {}) => this._onBackendStatusForRegistry(state));

    // Fire a fast pre-scan register with JUST the collections / playlists /
    // categories / sources so the phone-remote's Groupings tabs populate
    // within ~100 ms of desktop launch. These are already in memory from
    // `dataService.init()` — no filesystem work to wait on. The library
    // scan will later send the `videos` slice via `_registerWithBackend`;
    // the backend's register endpoint treats each key independently, so
    // this early pass leaves the video registry untouched.
    this._registerGroupingsEarly();
    // ...and again after every playlist / category / collection edit (V23).
    this._wireGroupingsRegister();

    // Initialize core video player (must succeed for anything to work)
    this.videoPlayer = new VideoPlayer({
      videoElement: document.getElementById('video'),
      controlsElement: document.getElementById('controls'),
      containerElement: document.getElementById('player-container'),
    });

    // "Remember playback speed" — read live at each video load rather than
    // cached, so toggling it in Settings applies to the very next video with
    // nothing to propagate. Wired here, not in the Handy block below, so a
    // failed Handy init can't leave it unset.
    this.videoPlayer.setRememberRateProvider(
      () => this.settings?.get?.('player.rememberPlaybackSpeed') === true,
    );

    // Initialize progress bar (thumbnails + heatmap)
    this.progressBar = new ProgressBar({
      containerElement: document.getElementById('progress-container'),
      videoPlayer: this.videoPlayer,
      backendPort: this.backendPort,
    });

    // Initialize funscript engine
    this.funscriptEngine = new FunscriptEngine({
      backendPort: this.backendPort,
    });

    // Windows Controls Overlay detection: when the native title bar is
    // replaced by the tinted overlay (titleBarStyle hidden, main.js), the
    // nav bar / player top bar double as the title bar — CSS scoped under
    // html.has-wco adds drag regions + caption-button insets. False on
    // Linux (native frame), so those styles never apply there.
    // watchWcoClass keeps the class in step for the whole session and logs
    // "[WCO] ..." lines: set once at boot, an overlay that turned visible a
    // moment later left no drag region and the Settings button under the
    // caption buttons until a restart (FT-055, a hedge for #381, unproven).
    try {
      this._wco = watchWcoClass();
    } catch { /* older runtime — no overlay */ }

    // Inline script visualization (TL timeline + HM heatmap strip) —
    // read-only overlays during normal playback (zaikechi #209). Visibility
    // restored from settings; the TL/HM control-bar buttons toggle + persist.
    this.inlineViz = new InlineViz({
      container: document.getElementById('player-container'),
      video: this.videoPlayer.video,
    });
    this._wireInlineVizToggles();

    // Initialize drag-and-drop EARLY — this must always work. Omit
    // `dropZoneElement` so the default `#drop-zone-overlay` element
    // resolves automatically (was passed as `null` pre-2026-04-28
    // which silenced all visual feedback).
    this.dragDrop = new DragDrop(this._dragDropOptions());

    // Nav Bar
    this.settingsPanel = new SettingsPanel({
      settings: this.settings,
      // Getter, not a value: a re-probe must be visible without rebuilding
      // the panel. Empty set = everything reachable (fail open).
      getUnreachableSources: () => this._sourceProbeCache || new Set(),
      // Sources whose ROOT could not be read on the last scan. They pass the
      // probe (the folder exists), so Recheck has to count them separately.
      getFailedScanSources: () => this.library?._failedScanPaths || new Set(),
      onRecheckSources: () => this._recheckSources(),
      // Filler test button. The panel has no devices of its own, so it hands
      // the previewed actions back here and app.js drives them through the
      // engines' off-clock send path — the same funnel playback uses, so the
      // user feels what they will actually get, per-device transforms and all.
      onTestFillerPattern: (actions, hooks) => this._startFillerTest(actions, hooks),
      onStopFillerTest: () => this._fillerTest?.stop(),
      onSourcesChanged: () => {
        this._refreshCollectionsUI();
        if (this.library) this.library._lastScanKey = null;
        if (this._currentView() === 'library') this.library.show(this._getViewEl('library'));
        // Any other view: rescan without showing the Library (CB-26). Only
        // the Library view used to rescan, so a source removed from
        // Playlists or Categories stayed in the library, the phone and VR.
        else this._rescanLibraryInBackground();
        // Up Next checks the sources as they are now (_isUpNextPlayable); a
        // card already up re-reads what it names (FT-018).
        this.upNextEngine?.refresh?.();
      },
      onGapSkipChanged: (mode, threshold) => {
        if (this.gapSkipEngine) {
          this.gapSkipEngine.setSettings(mode, threshold);
          if (this.funscriptEngine.isLoaded) this._startGapSkip();
        }
        // Auto-skip suppresses filler, so the two settings are coupled.
        this._applyFillerSettings();
      },
      onGapFillerChanged: () => this._applyFillerSettings(),
      onUpNextChanged: (mode, countdownSec) => {
        if (this.upNextEngine) {
          this.upNextEngine.setSettings(mode, countdownSec);
        }
      },
      onPreferMultiAxisChanged: (mode) => {
        // Confirmation modal already gated this; just trigger the
        // promotion pass on the existing in-memory `_videos`. Setting
        // is already persisted by the time we get called.
        if (mode === 'multi' && this.library?._reapplyAutoPromotion) {
          const promoted = this.library._reapplyAutoPromotion();
          if (promoted > 0) {
            showToast(t('toast.autoPromotedMulti', { count: promoted }), 'info', 4000);
          }
        }
      },
      getMultiAxisEligibleCount: () => {
        // { eligible, assigned }: the confirm needs both to tell "no
        // companions anywhere" from "every one already has a mode" (V39).
        return this.library?._countAutoPromotionEligible?.({ detail: true }) ?? null;
      },
      // Duplicate finder (pallokala2 #330). Lives here rather than in the
      // settings panel because it needs the library's video list, and because
      // removing files has to be followed by a forced rescan — the library
      // still holds entries for files that are now in the Recycle Bin, and a
      // stale entry in a delete UI invites a second delete of a file that is
      // already gone.
      onFindDuplicates: async () => {
        const { DuplicatesModal } = await import('../components/duplicates-modal.js');
        const modal = new DuplicatesModal({
          getVideos: () => this.library?._videos || [],
          onRemoved: () => {
            this.library?.ensureScanned?.({ forceRescan: true })
              .catch((err) => console.warn('[Duplicates] Rescan after removal failed:', err?.message || err));
          },
        });
        await modal.show();
      },
      onSmoothingChanged: (mode) => {
        if (this.buttplugSync) this.buttplugSync.setInterpolationMode(mode);
        // Bug B2 (community report 2026-05-23): tcode-sync has full
        // interpolator plumbing but was never wired to the settings
        // callback — TCode users got linear regardless of choice.
        if (this.tcodeSync) this.tcodeSync.setInterpolationMode(mode);
      },
      onSpeedLimitChanged: (maxSpeed) => {
        if (this.buttplugSync) this.buttplugSync.setSpeedLimit(maxSpeed);
      },
      onLinearStrategyChanged: (strategy) => {
        if (this.buttplugSync) this.buttplugSync.setLinearStrategy(strategy);
      },
      onLinearLookaheadChanged: (ms) => {
        if (this.buttplugSync) this.buttplugSync.setLinearLookaheadMs(ms);
      },
      onMinStrokeChanged: (ms) => {
        if (this.buttplugSync) this.buttplugSync.setMinStrokeMs(ms);
      },
      onRangeExtenderChanged: (enabled) => {
        // Per-tick sync engines cache the flag for performance.
        // Cloud-upload paths (Handy HSSP, Autoblow) read it from
        // settings directly on each upload, so they pick up the new
        // state on the next video load / variant switch without
        // needing the callback. See SCOPE-device-settings-expansion.md
        // §4 for the cloud-upload tradeoff.
        if (this.buttplugSync) this.buttplugSync.setRangeExtenderEnabled(enabled);
        if (this.tcodeSync) this.tcodeSync.setRangeExtenderEnabled(enabled);
      },
      // Inline TL/HM overlay opacity — live-applied while the slider moves.
      // Both also reach an open pop-out at once (FT-028).
      onInlineVizOpacityChanged: (v) => {
        this._applyInlineVizOpacity(v);
        this._sendPlayerWindowInlineVizState?.({ opacity: v });
      },
      // HM strip playhead marker (#381) — applied to the live overlay.
      onInlineHeatmapPlayheadChanged: (on) => {
        this.inlineViz?.setHeatmapPlayhead(on);
        this._sendPlayerWindowInlineVizState?.({ playhead: on });
      },
      onDeviceSimOpacityChanged: (v) => this._applyDeviceSimOpacity(v),
      // Settings > Appearance > Navigation bar (#381).
      onNavHiddenChanged: (hidden) => this.navBar?.setHiddenItems(hidden),
      // Per-card heatmap strip: cards are built once, so the row can only
      // appear/disappear via a re-render of the library view.
      // Any library-display setting that changes WHAT is listed or how a
      // card is built — card heatmap, resume bars, hide-duplicates.
      // Cards are built once, so these need a re-render, not a repaint.
      onLibraryDisplayChanged: () => {
        if (this._currentView() === 'library') {
          this.library.show(this._getViewEl('library'));
        }
      },
      // Orgasm Switch (hold X) — configure / clear / display the global
      // config (single script, multi-axis bundle, or custom routing —
      // same association shape videos use).
      onPickOrgasmScript: () => this._configureOrgasm(),
      onClearOrgasmScript: () => this._clearOrgasmScript(),
      getOrgasmScriptName: () => this._orgasmSummaryText(),
      // Source "Generated pattern" (#373): the panel saved
      // `player.orgasmPattern`; reload so the next X press plays it.
      onOrgasmPatternChanged: () => this._reloadOrgasmScripts(),
      // Snapshot device-connection flags for the "Report a problem"
      // diagnostics bundle. Read defensively — managers may be null
      // (Handy SDK can fail to import; Buttplug isn't always inited).
      getConnectionState: () => ({
        handyConnected: !!this.handyManager?._connected,
        buttplugConnected: !!this.buttplugManager?._connected,
        vrConnected: !!this.vrBridge?.connected,
        deviceCount: this.buttplugManager?._devices?.length || 0,
      }),
      // Settings > Sources > Stash (S1): Sync now sends the library's videos;
      // a Need-a-check row's Choose… opens that video's dialog at File, on
      // its Stash choice (Settings has closed itself first).
      getStashVideos: () => this.library?._videos || [],
      onOpenStashCheck: (videoPath) => {
        const video = this.library?.getVideoByPath?.(videoPath);
        if (video) this.library._openVideoOptions(video, { section: 'file', focusKey: 'stash:choice' });
        else showToast(t('settingsPanel.stash.checkVideoMissing'), 'warn');
      },
    });

    this.navBar = new NavBar({
      onNavigate: (viewId) => this._navigateTo(viewId),
      onHandyClick: () => { if (this.connectionPanel) this.connectionPanel.toggle(); },
      onSettingsClick: () => { this.settingsPanel.show(); },
      onRemoteClick: () => {
        import('../components/web-remote-modal.js').then(mod => {
          mod.openWebRemoteModal({ settings: this.settings });
        });
      },
      onVRClick: () => {
        if (!this.vrBridge) return;
        import('../components/vr-modal.js').then(mod => {
          mod.openVRModal({
            settings: this.settings,
            vrBridge: this.vrBridge,
            // "This video" row (#380), the same delta as the Sync tab's.
            videoSyncOffset: {
              get: () => this._vrVideoSyncOffsetState(),
              set: (ms) => this._setVideoSyncOffset(ms),
            },
          });
        });
      },
      // TEMP DISABLED (2026-07-30): Load-from-URL — see notes/SCRATCHPAD.md.
      // onLoadUrlClick: () => this._openLoadUrlModal(),
      onEroScriptsClick: () => this._onEroScriptsNavClick(),
      onLibraryCollectionChange: (collectionId) => this._switchCollection(collectionId),
      onNewCollection: () => this._showNewCollectionModal(),
      onRenameCollection: (id) => this._renameCollection(id),
      onDeleteCollection: (id) => this._deleteCollection(id),
      onAddSource: () => this._addSource(),
    });
    this.navBar.init(document.getElementById('app'));
    // Buttons hidden in Settings > Appearance > Navigation bar (#381).
    this.navBar.setHiddenItems(this.settings.get('player.navHidden'));
    this.navBar.setActive('library');

    // Library
    this.library = new Library({
      onPlayVideo: (video, funscript, subtitle, variants) => this._playFromLibrary(video, funscript, subtitle, variants),
      onBack: () => this._navigateBack(),
      onAddSource: () => this._addSource(),
      onTestDevice: (deviceId, buttplugIndex) => this._testDevice(deviceId, buttplugIndex),
      onOpenVRFormat: (path) => this._openVRFormatPanel(path),
      // Lookup callback so library cards can show the embedded-multi-axis
      // badge for files that bundle pitch/roll/twist inside the main
      // funscript (HereSphere `additional_axes`, OFS-extended `raw`,
      // sibling-key, inline-TCode). Sync — returns cached data only.
      getEmbeddedAxes: (path) => this.getEmbeddedAxes(path),
      // Async detection — used by the modal-open path to probe a file
      // the user hasn't played yet (cache miss). Populates the cache
      // on success so subsequent sync reads hit it.
      detectEmbeddedAxesForPath: (path) => this.detectEmbeddedAxesForPath(path),
      onExtractEmbeddedAxes: (video) => this._extractEmbeddedAxesToCompanions(video),
      onAddToQueue: (path, position) => this.addToUserQueue(path, position),
      onPlayAll: (videoList, opts) => this._playAll(videoList, opts),
      onToggleQueue: () => this._toggleQueuePanel(),
      isQueueOpen: () => !!this.queuePanel?.visible,
      // The variation playing for a video, when it is the one in this
      // window's player: the Associate dialog marks it (FN-03).
      getPlayingScript: (videoPath) => (videoPath && videoPath === this._currentVideoPath && this._variantsPhoneEpoch == null
        && this.funscriptEngine?.isLoaded
        ? (this._activeVariantPath || this._allVariantsWithManual?.[this._activeVariantIndex]?.path || null)
        : null),
      settings: this.settings,
    });

    // Load saved collections into nav bar + library (must be after library creation)
    await this._refreshCollectionsUI();

    // Playlists
    this.playlists = new Playlists({
      settings: this.settings,
      library: this.library,
      onPlayVideo: (videoData, funscriptData, subtitleData, variants) => this._playFromLibrary(videoData, funscriptData, subtitleData, variants),
      onPlayAll: (videoList, opts) => this._playAll(videoList, opts),
      // The same queue toggle the Library header has (V27, forum #381).
      onToggleQueue: () => this._toggleQueuePanel(),
      isQueueOpen: () => !!this.queuePanel?.visible,
      // A Stash group's Add to queue: its videos in one go.
      onAddPathsToQueue: (paths) => this.addPathsToUserQueue(paths),
    });

    // Categories
    this.categories = new Categories({
      settings: this.settings,
      library: this.library,
      onPlayVideo: (videoData, funscriptData, subtitleData, variants) => this._playFromLibrary(videoData, funscriptData, subtitleData, variants),
      // Play all / Shuffle all in a category's detail (#381), through the
      // same Play All path playlists use.
      onPlayAll: (videoList, opts) => this._playAll(videoList, opts),
      onToggleQueue: () => this._toggleQueuePanel(),
      isQueueOpen: () => !!this.queuePanel?.visible,
    });

    // Queue panel — right-side slide-in showing history, now-playing,
    // user queue (persistent), and upcoming (live from playlist or
    // library). See SCOPE-queue-panel.md. Must come after library so
    // the panel can resolve video metadata via library.getVideoByPath.
    this._initQueuePanel();

    // Resume-position tracking. Bound to the local <video> for the sample
    // triggers, but each sample reads the clock via _resumeClockSource so
    // a detached pop-out is recorded correctly too — while detached the
    // local element is paused and fires nothing, so the periodic tick
    // below is what keeps a popped-out session up to date.
    this._initResumeTracking();

    // Player back button
    const btnPlayerBack = document.getElementById('btn-player-back');
    if (btnPlayerBack) {
      btnPlayerBack.addEventListener('click', () => this._navigateBack());
    }

    // Mini-player controls (only interactive while docked as a corner
    // overlay). Icons are injected programmatically — the shared
    // `createIcons()` registry doesn't include X / Maximize2, so
    // data-lucide placeholders for those would render blank.
    const miniExpand = document.getElementById('miniplayer-expand');
    if (miniExpand) {
      miniExpand.replaceChildren(icon(Maximize2, { width: 16, height: 16 }));
      miniExpand.addEventListener('click', () => this._expandMiniplayer());
    }
    const miniClose = document.getElementById('miniplayer-close');
    if (miniClose) {
      miniClose.replaceChildren(icon(X, { width: 16, height: 16 }));
      miniClose.addEventListener('click', () => this._closeMiniplayer());
    }
    // Detached player window (Phase 2). 2a: open/close + READY handshake.
    document.getElementById('btn-popout-player')?.addEventListener('click', () => {
      this._togglePlayerWindow();
    });
    this._initPlayerWindow();

    const miniPlayPause = document.getElementById('miniplayer-playpause');
    if (miniPlayPause) {
      miniPlayPause.addEventListener('click', () => this.videoPlayer?.togglePlay?.());
      // Keep the icon in sync with the ACTUAL play state. Bind to the
      // stable <video> element by id (survives init order); play/pause
      // events fire from any control (mini button, keyboard, main player).
      const videoEl = document.getElementById('video');
      if (videoEl) {
        videoEl.addEventListener('play', () => this._updateMiniPlayPauseIcon());
        videoEl.addEventListener('pause', () => this._updateMiniPlayPauseIcon());
      }
      this._updateMiniPlayPauseIcon();
    }

    // Quick-add to playlist button in player top bar
    const btnAddToPlaylist = document.getElementById('btn-add-to-playlist');
    if (btnAddToPlaylist) {
      btnAddToPlaylist.addEventListener('click', () => this._quickAddToPlaylist());
    }

    // TEMP DISABLED (2026-07-30): Load-from-URL hidden until it works reliably.
    // Restore alongside the nav-bar button + #btn-load-url in index.html + the
    // onLoadUrlClick nav wiring. See notes/SCRATCHPAD.md.
    // Load from URL — also reachable from the player top bar (for switching
    // to another remote video mid-session). Primary entry is the nav bar.
    // document.getElementById('btn-load-url')?.addEventListener('click', () => this._openLoadUrlModal());

    // Queue navigation (prev/next)
    document.getElementById('btn-prev')?.addEventListener('click', () => this._playPrev());
    document.getElementById('btn-next')?.addEventListener('click', () => this._playNext());

    // Overflow menu — bottom-bar `⋮` opens a small popover with niche
    // actions (PiP, keyboard shortcuts). Closes on item click, outside
    // click, or Escape. Single open-at-a-time policy. The PiP and help
    // items inside use real button IDs so existing click handlers
    // (video-player.js#btn-pip) still work without rewiring.
    const overflowBtn = document.getElementById('btn-overflow');
    const overflowMenu = document.getElementById('controls-overflow-menu');
    if (overflowBtn && overflowMenu) {
      const closeOverflow = () => {
        overflowMenu.hidden = true;
        overflowBtn.setAttribute('aria-expanded', 'false');
      };
      overflowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !overflowMenu.hidden;
        if (isOpen) { closeOverflow(); return; }
        overflowMenu.hidden = false;
        overflowBtn.setAttribute('aria-expanded', 'true');
      });
      // Close after any item click — PiP / help both fire their own
      // handler first, then the menu closes. EXCEPT checkbox items
      // (`--check`): they're paired view toggles, and closing after the
      // first one would mean reopening the menu to set the second.
      // Deliberately scoped to that class so Loop video (also a
      // menuitemcheckbox) keeps its existing close-on-toggle behaviour.
      overflowMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.controls-overflow__item');
        if (item && !item.classList.contains('controls-overflow__item--check')) closeOverflow();
      });
      // Outside-click + Escape dismissal.
      document.addEventListener('click', (e) => {
        if (overflowMenu.hidden) return;
        if (overflowMenu.contains(e.target) || overflowBtn.contains(e.target)) return;
        closeOverflow();
      });
      // preventDefault marks the press as taken, so the player's Esc
      // (keyboard.js) does not also close the queue panel under the menu.
      // Registered before the KeyboardHandler, so this runs first.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overflowMenu.hidden) {
          e.preventDefault();
          closeOverflow();
        }
      });
    }
    // Keyboard-shortcuts item inside the overflow menu — open the
    // shared help overlay. Same content the `?` shortcut shows.
    document.getElementById('btn-help')?.addEventListener('click', () => {
      // Lazy-import to keep startup tree small.
      import('./keyboard-help.js').then(({ openKeyboardHelp, getPlayerShortcutGroups }) => {
        openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups());
      });
    });

    // VR Format item — only present when the current video is detected
    // (or manually flagged) as VR. Since Ctrl+Shift+R was removed
    // (2026-08-14) this and the library kebab are the ONLY ways into the
    // panel, so it must stay discoverable.
    document.getElementById('btn-vr-format-menu')?.addEventListener('click', () => {
      if (this._currentVideoPath) this._openVRFormatPanel(this._currentVideoPath);
    });

    // Queue panel toggle (top bar, far-right).
    document.getElementById('btn-queue-toggle')?.addEventListener('click', () => {
      this._toggleQueuePanel();
    });
    // Defensive refresh on every overflow open — covers the case where
    // the user toggles VR/flat via the library kebab and then navigates
    // back to the player.
    document.getElementById('btn-overflow')?.addEventListener('click', () => {
      this._refreshVRFormatMenuVisibility();
    });
    eventBus.on('vrFormat:changed', () => this._refreshVRFormatMenuVisibility());

    this._wireSpeedControl();
    this._wireControlsPopoverToasts();
    this._wireLoopVideo();
    this._wirePlayerChromeLanguage();

    // Wire thumbnail preview + marker tooltip on progress hover. The
    // marker tooltip resolves the cursor to the nearest chapter / bookmark
    // (or null) and shows the marker's name above the thumbnail.
    this.videoPlayer.onProgressHover = (time, xPx, widthPx) => {
      this.progressBar.updateThumbnailPreview(time);
      const durMs = (this.videoPlayer.duration || 0) * 1000;
      if (Number.isFinite(xPx) && Number.isFinite(widthPx)) {
        this.progressBar.updateMarkerTooltip(xPx, widthPx, durMs);
      }
    };

    // Windows caption buttons follow the player chrome: transparent over the
    // video, and fading out with the seek bar when the controls auto-hide.
    this.videoPlayer.onControlsVisibilityChanged = (visible) => {
      this._syncCaptionOverlay(visible);
    };
    // Fullscreen has no caption strip; re-sync on the way back out so the
    // normal chrome (or the over-video chrome) is restored correctly.
    document.addEventListener('fullscreenchange', () => this._syncCaptionOverlay());
    // ...and dim under a dialog's backdrop, as the page does (FT-100).
    eventBus.on('modal:backdrop', (state) => this._onModalBackdrop(state));

    // Redraw heatmap on resize
    window.addEventListener('resize', () => this.progressBar.redraw());
    // Keep the browse-view queue panel anchored below the view's header as
    // the window (and thus the header height) changes while it's open.
    window.addEventListener('resize', () => {
      if (this.queuePanel?.visible) this._positionQueuePanelForView();
    });

    // Gate library hover preview when main video is playing — and
    // refresh the player top-bar sync chip on every play/pause/ended
    // transition so the chip's "Ready" / "Syncing" state stays
    // honest. Cheap (one DOM dataset write).
    this.videoPlayer.video.addEventListener('play', () => {
      if (this.library) this.library._isVideoPlaying = true;
      this._updatePlayerSyncChip();
    });
    this.videoPlayer.video.addEventListener('pause', () => {
      if (this.library) this.library._isVideoPlaying = false;
      this._updatePlayerSyncChip();
    });
    this.videoPlayer.video.addEventListener('ended', () => {
      if (this.library) this.library._isVideoPlaying = false;
      this._updatePlayerSyncChip();
    });
    // Audience viewers follow the LOCAL video (SCOPE-audience-broadcast.md,
    // #361). Every play goes through the bridge's one play gate: a viewer
    // plays only once the current video's script is set up on it, at 1x,
    // while this element is the active player. `playing`, not `play`: the
    // position is real by then. A seek while paused sends no play.
    this.videoPlayer.video.addEventListener('playing', () => this.audienceBridge?.onPlaying());
    this.videoPlayer.video.addEventListener('pause', () => this.audienceBridge?.onPaused());
    this.videoPlayer.video.addEventListener('ended', () => this.audienceBridge?.onEnded());
    this.videoPlayer.video.addEventListener('seeked', () => this.audienceBridge?.onSeeked());
    // FN-06: viewers hold through a buffering stall like the streamer's own
    // Handy. 'waiting', or a 'stalled' that has run out of frames (the bridge
    // checks the element): nothing is sent inside the 500 ms grace window,
    // past it every viewer stops, and 'playing' plays them again.
    this.videoPlayer.video.addEventListener('waiting', () => this.audienceBridge?.onStalled('waiting'));
    this.videoPlayer.video.addEventListener('stalled', (e) => this.audienceBridge?.onStalled('stalled', e.target));

    // Render heatmap once video duration is known
    this.videoPlayer.video.addEventListener('loadedmetadata', () => {
      if (this.funscriptEngine.isLoaded) {
        this.progressBar.renderHeatmap(
          this.funscriptEngine.getActions(),
          this.videoPlayer.duration,
        );
        this._feedInlineViz();
        // Markers (chapters + bookmarks) can exist even with zero
        // actions (C-E19); push them whenever the engine is loaded,
        // and render the chapter strip against the video's own
        // duration axis. Per SCOPE-chapters-bookmarks.md §4.
        this.progressBar.setMarkers({
          chapters: this.funscriptEngine.getChapters(),
          bookmarks: this.funscriptEngine.getBookmarks(),
        });
        if (this.funscriptEngine.getChapters().length > 0) {
          this.progressBar.renderChapterStrip(this.videoPlayer.duration);
        }
      }
      // Stash S1: the linked scene's markers are drawn against the video's
      // own duration, with or without a script.
      this._applyStashMarkers?.();
    });

    // Apply saved volume
    const savedVolume = this.settings.get('player.volume');
    if (savedVolume != null) {
      this.videoPlayer.setVolume(savedVolume / 100);
    }

    // Save volume on change
    this.videoPlayer.video.addEventListener('volumechange', () => {
      this.settings.set('player.volume', Math.round(this.videoPlayer.video.volume * 100));
    });

    // Initialize Handy integration (non-critical — app works without it)
    try {
      this.handyManager = new HandyManager();
      await span('handyManager.init (SDK import)', () => this.handyManager.init());

      this.syncEngine = new SyncEngine({
        videoPlayer: this.videoPlayer,
        handyManager: this.handyManager,
        funscriptEngine: this.funscriptEngine,
      });
      // A pause that failed to stop the device needs a LOUD signal, not a
      // console warning. The device carries on stroking from its own cloud
      // schedule while the player shows paused, and the only person who can
      // act on that is the user, with the button on the device. Long toast
      // and error styling on purpose — this is the one Handy failure with a
      // physical consequence.
      this.syncEngine.onStopFailed = () => {
        showToast(t('toast.handyStopFailed'), 'error', 10000);
      };

      // Parallel HDSP-polled engine for non-1.0× playback rates. HSSP
      // (used by syncEngine) can't follow rate changes — the cloud
      // schedules the script at 1.0× regardless. HDSP is per-tick and
      // reads video.currentTime so it scales naturally. See
      // notes/UPDATES.md and `renderer/js/handy-hdsp-sync.js`.
      this.handyHdspSync = new HandyHdspSync({
        handyManager: this.handyManager,
        player: this.videoPlayer.video,
      });
      // Saved Handy invert, so a rate change before the panel is ever opened
      // already flips. Back at 1×, re-arm HSSP if the invert was toggled
      // while HDSP was driving (the cached URL is in the old direction).
      this.handyHdspSync.setInverted(this._handyInverted());
      eventBus.on('playback:rate-changed', (rate) => {
        if (rate === 1) {
          this._onHandyRateBackToOne().catch((err) => {
            console.warn('[Handy] Invert re-arm at 1x failed:', err?.message || err);
          });
        }
      });

      // Give the player the refs it needs to manage HSSP↔HDSP on rate
      // changes triggered from any surface (player button, keyboard,
      // editor, web-remote). Single source of truth.
      this.videoPlayer.setHandySyncRefs({
        handyManager: this.handyManager,
        handySyncEngine: this.syncEngine,
        handyHdspSync: this.handyHdspSync,
      });
    } catch (err) {
      console.warn('Handy integration unavailable:', err.message);
    }

    // Initialize Buttplug.io integration (non-critical — works alongside Handy)
    try {
        this.buttplugManager = new ButtplugManager();
        await span('buttplugManager.init (SDK import)', () => this.buttplugManager.init());

        this.buttplugSync = new ButtplugSync({
          videoPlayer: this.videoPlayer,
          buttplugManager: this.buttplugManager,
          funscriptEngine: this.funscriptEngine,
        });

      } catch (err) {
        console.warn('Buttplug.io integration unavailable:', err.message);
      }

      // Initialize TCode serial integration (non-critical)
      try {
        this.tcodeManager = new TCodeManager();
        this.tcodeSync = new TCodeSync({
          videoPlayer: this.videoPlayer,
          tcodeManager: this.tcodeManager,
          funscriptEngine: this.funscriptEngine,
        });
      } catch (err) {
        console.warn('TCode integration unavailable:', err.message);
      }

      // Initialize Autoblow integration (non-critical)
      try {
        this.autoblowManager = new AutoblowManager({
          // Read on every connect (#380): the saved global, and whether a
          // per-video offset may be on the device from an earlier session.
          savedOffsetState: () => ({
            globalMs: this.settings.get('autoblow.offset') || 0,
            videoOffsetsInUse: Object.keys(this.settings.get('library.syncOffsets') || {}).length > 0,
          }),
        });
        this.autoblowSync = new AutoblowSync({
          videoPlayer: this.videoPlayer,
          autoblowManager: this.autoblowManager,
        });
      } catch (err) {
        console.warn('Autoblow integration unavailable:', err.message);
      }

      // Initialize VR bridge (non-critical)
      try {
        this.vrBridge = new VRBridge();
      } catch (err) {
        console.warn('VR bridge unavailable:', err.message);
      }

      // Session tracker — unified state for VR + Web Remote sessions. Mount
      // the status card docked bottom-right.
      this.sessionTracker = new SessionTracker({ settings: this.settings });
      this._wireSessionTracker();
      this.sessionCard = new SessionCard({
        tracker: this.sessionTracker,
        onOpenHistory: () => openSessionHistory(this.sessionTracker),
      });
      this.sessionCard.mount(document.getElementById('app') || document.body);

      // Initialize Web Remote bridge — observer WebSocket to the local backend.
      // Auto-connects and reconnects; no UI-surfaced failure.
      try {
        const backendPort = this.settings.get('backend.port') || 5123;
        this.remoteBridge = new RemoteBridge({ port: backendPort });
        this._wireRemoteBridge();
        this.remoteBridge.onBridgeOpen = () => console.log('[Remote] observer bridge connected');
        this.remoteBridge.onBridgeClose = () => console.log('[Remote] observer bridge closed — will retry');
        this.remoteBridge.connect();
        console.log('[Remote] observer bridge: attempting connect to ws://127.0.0.1:' + backendPort + '/api/remote/sync/observe');
      } catch (err) {
        console.warn('Remote bridge unavailable:', err.message);
      }

      // AudienceBridge — drives N viewer Handys for the broadcast feature
      // (SCOPE-audience-broadcast.md), one HandyManager per viewer. NOT
      // isolated from the streamer's own Handy: every instance shares the
      // SDK module's single request queue (#361 stopgap, see the bridge).
      // The bridge owns its own source (beginSource / setScript /
      // setNoScript, called from every script-changing path below) and never
      // reads the streamer's engine or cloud URL.
      this.audienceBridge = new AudienceBridge({
        settings: this.settings,
        eventBus,
        HandyManagerCtor: HandyManager,
        getCurrentVideoTimeMs: () => Math.round((this.videoPlayer?.video?.currentTime || 0) * 1000),
        isVideoPlaying: () => this._audienceLocalPlayerPlaying(),
        getPlaybackRate: () => this.videoPlayer?.video?.playbackRate || 1,
        // Keyless upload: needs no device, so viewers get the script with
        // no streamer Handy connected.
        uploadScript: uploadScriptToCloud,
        // Self-key collision guard — the streamer's own key is held by
        // handyManager. If they paste it as a viewer, refuse.
        getStreamerOwnKey: () => this.settings?.get?.('handy.connectionKey') || null,
      });
      // HSSP cannot follow a rate other than 1x: viewers stop, and play
      // again back at 1x (only if the play gate passes).
      eventBus.on('playback:rate-changed', (rate) => this.audienceBridge?.onPlaybackRateChanged(rate));
      eventBus.on('audience:script-upload-failed', () => {
        showToast(t('audience.toast.uploadFailed'), 'error', 6000);
      });
      this._wireAudiencePopoutRelay();
      // An editor save of this window's video's script reaches viewers (FT-094).
      this._wireAudienceEditorSaves();

      this.connectionPanel = new ConnectionPanel({
        handyManager: this.handyManager,
        buttplugManager: this.buttplugManager,
        buttplugSync: this.buttplugSync,
        tcodeManager: this.tcodeManager,
        tcodeSync: this.tcodeSync,
        autoblowManager: this.autoblowManager,
        autoblowSync: this.autoblowSync,
        vrBridge: this.vrBridge,
        settings: this.settings,
        audienceBridge: this.audienceBridge,
        onResyncComplete: () => this._restoreHssspAfterResync(),
        // Buttplug "Reload script" — manual re-arm for the reported
        // post-dropout state where the device stays connected but the
        // sync engine sits idle ("ready" but nothing moves) until the
        // user swaps videos. Returns true if a device was available to
        // re-arm so the panel can show success/failure feedback.
        onButtplugResync: () => this._resyncButtplug(),
        // Push a live Handy output-limits (cutoff) change into the per-tick
        // HDSP engine. HSSP bakes the clamp into the next uploaded script,
        // so it applies on the next load / variant switch (Range Extender
        // model) — no disruptive mid-playback re-upload.
        onHandyCutoffChanged: () => {
          this.handyHdspSync?.setCutoff(this._cutoffFromSettings('handy'));
        },
        // Handy invert toggle (#276/#390). Live for HDSP and for the main
        // script on the local player; otherwise from the next load.
        onHandyInvertChanged: () => this._onHandyInvertChanged(),
        // Sync tab "This video" row (#380): the playing video's own delta.
        getVideoSyncOffset: () => this._videoSyncOffsetState(),
        onVideoSyncOffsetChange: (ms) => this._setVideoSyncOffset(ms),
        // T-Code tab "Go home" (#384 uhntiss, #389 kissenpirat).
        onTCodeGoHome: () => this._tcodeGoHome(),
      });

      // Keep the Audience tab's LED in lockstep with the bridge's
      // aggregate state.
      const refreshAudienceLed = () => {
        this.connectionPanel?.setAudienceTabLed?.(this.audienceBridge.aggregateStatus);
      };
      for (const evt of ['audience:room-opened', 'audience:room-ended',
                          'audience:viewer-added', 'audience:viewer-removed',
                          'audience:viewer-status']) {
        eventBus.on(evt, refreshAudienceLed);
      }

      // Load saved smoothing settings into buttplug sync
      if (this.buttplugSync) {
        const savedSmoothing = this.settings.get('player.smoothing') || 'linear';
        const savedSpeedLimit = this.settings.get('player.speedLimit') || 0;
        this.buttplugSync.setInterpolationMode(savedSmoothing);
        this.buttplugSync.setSpeedLimit(savedSpeedLimit);
        // B2 boot path — keep tcodeSync in sync with the saved
        // smoothing mode (parallel to the runtime callback above).
        if (this.tcodeSync) this.tcodeSync.setInterpolationMode(savedSmoothing);

        // Range Extender boot — push the saved state into both per-tick
        // sync engines. Without this, a user with the extender saved as
        // ON would get no stretch until they toggled the setting in the
        // current session (sync engines default to false in constructor).
        const savedExt = !!this.settings.get('player.rangeExtender.enabled');
        this.buttplugSync.setRangeExtenderEnabled(savedExt);
        if (this.tcodeSync) this.tcodeSync.setRangeExtenderEnabled(savedExt);

        // Linear strategy: action-boundary (default) sends one LinearCmd per
        // stroke with the full duration, letting the device's firmware handle
        // in-stroke interpolation — much smoother on BLE (Handy / Kiiroo).
        // interpolated (legacy) re-sends every tick with remaining duration.
        const savedLinearStrategy = this.settings.get('player.linearStrategy') || 'action-boundary';
        const savedLookahead = this.settings.get('player.linearLookaheadMs');
        const savedMinStroke = this.settings.get('player.minStrokeMs');
        this.buttplugSync.setLinearStrategy(savedLinearStrategy);
        if (savedLookahead != null) this.buttplugSync.setLinearLookaheadMs(savedLookahead);
        if (savedMinStroke != null) this.buttplugSync.setMinStrokeMs(savedMinStroke);

        // Per-device sync offset, restored from settings. The offset
        // shifts effective time so device commands fire earlier
        // (negative) or later (positive) than the video time. See
        // buttplug-sync setOffsetMs comment for the formula.
        const savedBpOffset = this.settings.get('buttplug.defaultOffset');
        if (savedBpOffset != null) this.buttplugSync.setOffsetMs(savedBpOffset);
      }
      if (this.tcodeSync) {
        const savedTcOffset = this.settings.get('tcode.defaultOffset');
        if (savedTcOffset != null) this.tcodeSync.setOffsetMs(savedTcOffset);
        // Output rate (advanced) — apply the saved Hz on boot so it's active
        // even if the connection panel is never opened this session.
        const savedTcRate = Number(this.settings.get('tcode.updateRateHz')) || 60;
        this.tcodeSync.setUpdateRate(savedTcRate);
      }

      // Wire command activity indicator (throttled to avoid DOM thrashing)
      if (this.buttplugSync) {
        let activityTimeout = null;
        this.buttplugSync.onCommandSent = () => {
          if (this.navBar?._handyLed) {
            this.navBar._handyLed.classList.add('nav-bar__handy-led--active');
            if (activityTimeout) clearTimeout(activityTimeout);
            activityTimeout = setTimeout(() => {
              this.navBar._handyLed.classList.remove('nav-bar__handy-led--active');
            }, 200);
          }
        };
      }

      // ConnectionPanel sets handyManager.onConnect/onDisconnect for its own UI updates.
      // Wrap them so we also get notified (to upload pending scripts + update indicators).
      if (this.handyManager) {
        const panelOnConnect = this.handyManager.onConnect;
        this.handyManager.onConnect = () => {
          if (panelOnConnect) panelOnConnect();
          // `deviceInfo` is the manager's only firmware field: this read
          // `fwVersion` / `_fwVersion`, which never existed, so every connect
          // logged "firmware unknown" (FT-117). Info that lands later is
          // logged by the onDeviceInfo wrapper below.
          const fw = this.handyManager.deviceInfo?.fwVersion || 'unknown';
          const keySuffix = this.handyManager.connectionKey
            ? this.handyManager.connectionKey.slice(-4)
            : '?';
          console.log(`[Handy] Connected (native WiFi) — key ...${keySuffix}, firmware ${fw}`);
          this._registerKnownDevice('handy', 'The Handy', 'handy');
          this._onHandyConnected();
          this._refreshOrgasmPlan();
        };
        // The firmware as it arrives (once per connection and change; a
        // re-read after a connect that had none lands seconds later). The
        // panel's own handler, built before this like onConnect, still runs.
        const panelOnDeviceInfo = this.handyManager.onDeviceInfo;
        this.handyManager.onDeviceInfo = (info) => {
          if (panelOnDeviceInfo) panelOnDeviceInfo(info);
          console.log(`[Handy] Device info — firmware ${info?.fwVersion || 'unknown'}, model ${info?.model ?? 'unknown'}`);
        };

        // Responsiveness drives the ALWAYS-VISIBLE nav-bar indicator too, not
        // just the connection panel — the whole complaint was noticing a dead
        // device only from its lack of movement, and the panel is shut when
        // that happens. Wrapped here rather than at SyncEngine construction
        // because ConnectionPanel installs its own handler and is built after
        // that point; wrapping there would have been silently overwritten.
        const panelResponsiveness = this.handyManager.onResponsivenessChange;
        this.handyManager.onResponsivenessChange = (responsive) => {
          if (panelResponsiveness) panelResponsiveness(responsive);
          if (!this.handyManager.connected) return;
          this._updateHandyIndicators(
            responsive ? (this.handyManager.slow ? 'slow' : 'connected') : 'unresponsive',
          );
        };

        // Same wrapping for the slow-command signal, and for the same reason:
        // the nav-bar LED is what someone is actually looking at while they
        // wonder why the device has stopped. A hard failure outranks slowness,
        // so an unresponsive device keeps its own status.
        const panelSlowness = this.handyManager.onSlownessChange;
        this.handyManager.onSlownessChange = (slow) => {
          if (panelSlowness) panelSlowness(slow);
          if (!this.handyManager.connected) return;
          if (!this.handyManager.responsive) return;
          this._updateHandyIndicators(slow ? 'slow' : 'connected');
        };

        const panelOnDisconnect = this.handyManager.onDisconnect;
        this.handyManager.onDisconnect = () => {
          if (panelOnDisconnect) panelOnDisconnect();
          console.log('[Handy] Disconnected — stopping sync engine');
          if (this.syncEngine) this.syncEngine.stop();
          this._updateHandyIndicators('disconnected');
          this._updateDeviceIndicators();
          this._refreshOrgasmPlan();
        };
      }

      // Buttplug.io callback wiring (same pattern as Handy — wrap panel callbacks)
      if (this.buttplugManager) {
        const panelBpConnect = this.buttplugManager.onConnect;
        this.buttplugManager.onConnect = () => {
          if (panelBpConnect) panelBpConnect();
          console.log(`[Buttplug] Connected to Intiface on port ${this.buttplugManager.port}`);
          this._updateDeviceIndicators();
          this._tryStartButtplugSync();
        };

        const panelBpDisconnect = this.buttplugManager.onDisconnect;
        this.buttplugManager.onDisconnect = () => {
          if (panelBpDisconnect) panelBpDisconnect();
          console.log('[Buttplug] Disconnected from Intiface — stopping sync engine');
          if (this.buttplugSync) this.buttplugSync.stop();
          this._updateDeviceIndicators();
          this._refreshOrgasmPlan();
        };

        const panelBpDeviceAdded = this.buttplugManager.onDeviceAdded;
        this.buttplugManager.onDeviceAdded = (dev) => {
          if (panelBpDeviceAdded) panelBpDeviceAdded(dev);

          // Rich connection log — dumps everything a debug session would ask
          // for: name, Intiface index, and the capability flags the sync
          // engine actually branches on.
          const caps = [];
          if (dev.canLinear) caps.push('linear');
          if (dev.canVibrate) caps.push('vibrate');
          if (dev.canRotate) caps.push('rotate');
          if (dev.canScalar) caps.push('scalar');
          if (dev.canOscillate) caps.push('oscillate');
          console.log(
            `[Buttplug] Device added: "${dev.name}" (index ${dev.index}, caps: ${caps.join(',') || 'none'})`
          );

          // Track the current Intiface deviceIndex alongside the name — it's
          // stable across Intiface restarts (unless the user resets/reinstalls
          // Intiface Central), so custom routing can prefer it over the
          // rename-sensitive name match.
          this._registerKnownDevice(`buttplug:${dev.name}`, dev.name, 'buttplug', {
            buttplugIndex: dev.index,
          });

          // Re-run route matching — a device that connected after the video
          // loaded would otherwise stay silent until reload.
          if (this._customRoutingActive && this._currentCustomRoutes) {
            const stillUnmatched = this._applyCustomRoutingAssignments();
            const thisDeviceId = `buttplug:${dev.name}`;
            const nowAssignedHere = this._currentCustomRoutes.find(r =>
              r._assignedAxis &&
              (r.deviceId === thisDeviceId || r.buttplugIndex === dev.index) &&
              !stillUnmatched.some(u => u.axis === r._assignedAxis)
            );
            if (nowAssignedHere) {
              console.log(
                `[CustomRouting] Late connect picked up pending route ` +
                `${nowAssignedHere._assignedAxis} → "${dev.name}"`
              );
            }
          }

          this._updateDeviceIndicators();
          this._tryStartButtplugSync();
          if (this.connectionPanel) this.connectionPanel.updateVibControlState();
          // Orgasm custom routing: a newly-connected device may satisfy the
          // last missing route — re-resolve so the finisher promotes back
          // from its single-axis fallback automatically.
          this._refreshOrgasmPlan();
        };

        const panelBpDeviceRemoved = this.buttplugManager.onDeviceRemoved;
        this.buttplugManager.onDeviceRemoved = (dev) => {
          if (panelBpDeviceRemoved) panelBpDeviceRemoved(dev);
          console.log(`[Buttplug] Device removed: "${dev.name}" (index ${dev.index})`);
          // Drop stale per-device state so a later device that happens to
          // reclaim this index (e.g. after an Intiface reconnect) doesn't
          // inherit the removed device's axis / mode flags.
          this.buttplugSync?.clearDeviceState(dev.index);
          this._updateDeviceIndicators();
          this._refreshOrgasmPlan();
        };
      }

      // Wire TCode connect/disconnect callbacks
      if (this.tcodeManager) {
        const panelTCodeConnect = this.tcodeManager.onConnect;
        this.tcodeManager.onConnect = () => {
          if (panelTCodeConnect) panelTCodeConnect();
          // COM port @ baud for serial, host:port for UDP, the URL for a
          // WebSocket: a UDP link logged "Connected on  @ 0 baud" (CB-15).
          console.log(`[TCode] Connected on ${this.tcodeManager.endpointSummary}`);
          this._registerKnownDevice('tcode', `TCode (${this.tcodeManager.endpoint})`, 'tcode');
          this._updateDeviceIndicators();
          this._tryStartTCodeSync();
          this._refreshOrgasmPlan();
        };

        const panelTCodeDisconnect = this.tcodeManager.onDisconnect;
        this.tcodeManager.onDisconnect = () => {
          if (panelTCodeDisconnect) panelTCodeDisconnect();
          console.log('[TCode] Disconnected — stopping sync engine');
          if (this.tcodeSync) this.tcodeSync.stop();
          this._updateDeviceIndicators();
          this._refreshOrgasmPlan();
        };
      }

      // Wire Autoblow connect/disconnect callbacks
      if (this.autoblowManager) {
        const panelAbConnect = this.autoblowManager.onConnect;
        this.autoblowManager.onConnect = () => {
          if (panelAbConnect) panelAbConnect();
          const abLabel = this.autoblowManager.isUltra ? 'Autoblow Ultra' : 'VacuGlide 2';
          console.log(`[Autoblow] Connected — ${abLabel}`);
          this._registerKnownDevice('autoblow', abLabel, 'autoblow');
          this._updateDeviceIndicators();
          this._tryStartAutoblowSync();
        };

        const panelAbDisconnect = this.autoblowManager.onDisconnect;
        this.autoblowManager.onDisconnect = () => {
          if (panelAbDisconnect) panelAbDisconnect();
          console.log('[Autoblow] Disconnected — stopping sync engine');
          if (this.autoblowSync) this.autoblowSync.stop();
          this._updateDeviceIndicators();
        };
      }

      // Wire VR bridge callbacks
      if (this.vrBridge) this._wireVRBridgeCallbacks();

      // Wire HDSP scrub preview — send position to Handy while seeking.
      // IMPORTANT: HDSP switches the SDK to mode 2, which clears the internal
      // scriptSet flag. We must NOT use HDSP while HSSP sync is active, or
      // HSSP will break and the script won't play. Only use HDSP when no
      // HSSP script is set up (i.e. device connected but no funscript loaded).
      this.videoPlayer.onSeekDrag = (timeSeconds) => {
        if (this.handyManager?.connected && this.funscriptEngine.isLoaded) {
          // HSSP is active — DON'T use HDSP (it breaks HSSP scriptSet).
          // The sync engine will handle seeking via hsspStop + hsspPlay.
        }
      };

      // Wire Handy button
      const btnHandy = document.getElementById('btn-handy');
      if (btnHandy) {
        btnHandy.addEventListener('click', () => this.connectionPanel.toggle());
      }

      // Initialize keyboard shortcuts (with connection panel for H key)
      this._keyboard = new KeyboardHandler(this._keyboardOptions());

      // Auto-connect if a key is saved
      const savedKey = this.settings.get('handy.connectionKey');
      if (savedKey) {
        this._autoConnectHandy(savedKey);
      }

      // Auto-connect to Buttplug/Intiface if previously used
      if (this.buttplugManager) {
        this._autoConnectButtplug();
      }

    // Initialize EroScripts panel
    this.eroscriptsPanel = new EroScriptsPanel({ settings: this.settings });
    this.eroscriptsPanel.onLoginStatusChanged = (loggedIn) => {
      if (this.navBar) this.navBar.setEroScriptsStatus(loggedIn);
    };
    this.eroscriptsPanel.confirmBeforeDownload = () => this._confirmBeforeEroScriptsDownload();
    this.eroscriptsPanel.onScriptDownloaded = (fsPath, fsName) => this._onEroScriptDownloaded(fsPath, fsName);
    // Where a download goes: beside the OPEN video only, not one closed (C-05).
    this.eroscriptsPanel.getOpenVideoPath = () => this._openVideoPath();
    // The same two hooks for Associate Funscript's EroScripts search (R4-07).
    this.library.confirmBeforeEroDownload = (videoPath, savePaths) => this._confirmBeforeAssociateDownload(videoPath, savePaths);
    this.library.onEroDownloadWritten = (videoPath, done) => this._onAssociateDownloadWritten(videoPath, done);

    // Initialize script editor (after all dependencies are set up)
    this.scriptEditor = new ScriptEditor({
      videoPlayer: this.videoPlayer,
      funscriptEngine: this.funscriptEngine,
      progressBar: this.progressBar,
      syncEngine: this.syncEngine,
      handyHdspSync: this.handyHdspSync,
      handyManager: this.handyManager,
      settings: this.settings,
      // The phone or a VR headset loaded its own script into the shared
      // engine (R3-20): the editor never shows or saves it as this video's.
      engineHeldByRemote: () => this._engineHeldByRemote === true,
    });
    // Editor save → Handy re-upload through the app's own chain (extend →
    // fill → invert → clamp), so an edit keeps the output limits, filler and
    // invert, and the cached URL stays the one the device actually holds.
    this.scriptEditor.onReuploadHandy = () => this._uploadAndStartSync();
    // Axes embedded in the main script, in the editor's script list (#376, V42).
    this.scriptEditor.onEditEmbeddedAxis = (suffix) => this._editEmbeddedAxis(suffix);
    this.scriptEditor.getEmbeddedAxisActions = (suffix) =>
      this.getEmbeddedAxes(this._currentFunscriptPath)?.axes?.get?.(suffix) || null;
    // The editor pop-out follows the video that plays, and seeks and steps
    // it (D-01): the player window's while it owns playback (V13).
    this.scriptEditor.getPlaybackClock = () =>
      (this._playerWindowActive && this._playerWinProxy ? this._playerWinProxy : null);
    this.scriptEditor.routePlayback = (command, arg) => this._playerWindowPlayback(command, arg);
    // Dock with the player in its own window brings the player back too (E-07).
    this.scriptEditor.onPopoutDocked = () => this._onEditorDocked();
    // E and the player's editor button both call toggle(): with the player in
    // its own window the editor opens in its own window too (E2-01).
    const editorOwnToggle = this.scriptEditor.toggle.bind(this.scriptEditor);
    this.scriptEditor.toggle = () => this._toggleScriptEditor(editorOwnToggle);

    // Auto-minimise the session card when the editor opens (space is scarce;
    // the user can still click the edge tab to re-expand). Wrap show/hide
    // on the editor so this stays in sync regardless of which path triggers.
    if (this.scriptEditor) {
      const origShow = this.scriptEditor.show.bind(this.scriptEditor);
      const origHide = this.scriptEditor.hide.bind(this.scriptEditor);
      this.scriptEditor.show = (...args) => {
        const r = origShow(...args);
        this.sessionCard?.forceMinimised(true);
        return r;
      };
      this.scriptEditor.hide = (...args) => {
        const r = origHide(...args);
        this.sessionCard?.forceMinimised(false);
        return r;
      };
    }

    // Initialize device simulator
    this.deviceSimulator = new DeviceSimulator({
      videoPlayer: this.videoPlayer,
      funscriptEngine: this.funscriptEngine,
    });
    this._wireDeviceSimMenuItem();

    // Initialize gap skip engine
    this.gapSkipEngine = new GapSkipEngine({
      videoPlayer: this.videoPlayer,
      funscriptEngine: this.funscriptEngine,
    });
    this._wireGapSkipUI();

    // Initialize Up Next engine + card
    this.upNextEngine = new UpNextEngine({
      videoPlayer: this.videoPlayer,
      funscriptEngine: this.funscriptEngine,
    });
    // Keep Up Next off videos the library no longer has. The play-context list
    // is a snapshot taken when playback started, so removing a source leaves
    // its paths in it — see UpNextEngine.isPlayable and _isUpNextPlayable.
    this.upNextEngine.isPlayable = (path) => this._isUpNextPlayable(path);
    // What follows a Play All queue item is the app's one decision (CB-10),
    // the same one the queue's advances play, so the card names what plays.
    this.upNextEngine.resolveNext = (ctx) => this._resolveUpNext(ctx);
    // A card for a video that has already ended (a queue change under its
    // End-of-list card) is offered only in the player view on screen, never
    // from the library, the mini player or the pop-out (R4-01).
    this.upNextEngine.canOfferAfterEnd = () => this._upNextMayOfferAfterEnd();
    this._wireUpNextUI();

    // Wire script editor + device simulator + gap skip + variants into keyboard handler
    if (this._keyboard) {
      this._keyboard.scriptEditor = this.scriptEditor;
      this._keyboard.deviceSimulator = this.deviceSimulator;
      this._keyboard.gapSkipEngine = this.gapSkipEngine;
      this._keyboard.upNextEngine = this.upNextEngine;
      this._keyboard.onCycleVariant = (dir) => this._cycleVariant(dir);
      this._keyboard.onCycleVRFlatten = () => {
        const label = this._cycleVRFlatten();
        if (label) showToast(t('toast.vrFlattenLabel', { label }), 'info', 1500);
      };
      this._keyboard.onVRPan = (yawDelta, pitchDelta) => {
        this._stepVRPan(yawDelta, pitchDelta);
      };
      // Ctrl+= / Ctrl+- / Ctrl+0 mirror the scroll gesture for anyone
      // without a wheel or trackpad, and for accessibility.
      this._keyboard.onVRZoom = (direction) => this._stepVRZoom(direction);
      this._keyboard.onVRZoomReset = () => this._resetVRZoom();
      this._wireVRZoomGesture();
      // Orgasm Switch (hold X) — wired below once the controller exists.
      this._keyboard.onOrgasmHold = (active) => this._onOrgasmHold(active);
      this._keyboard.onEdgeHold = (active) => this._onEdgeHold(active);

    // Global hotkeys (Eroto, EroScripts #316) — the same three actions the
    // in-app keys drive, routed through the SAME methods so behaviour cannot
    // drift between focused and unfocused. A global key has no keyup we can
    // rely on (the OS only reports the accelerator firing), so orgasm and
    // edge always behave as press-to-toggle here regardless of the in-app
    // hold/toggle setting — a hold you cannot release would leave a device
    // running with the window not even visible.
    this._wireGlobalShortcuts();
    }

    // --- Orgasm Switch ---
    // Hold X → swap the device(s) onto a short looping orgasm script without
    // pausing the video; release → snap back. The controller drives devices
    // directly while held; onActivate/onDeactivate stop and restart the
    // normal sync engines so the two never both drive a device.
    //
    // Handy: driven via HDSP per-tick (mode 2) while held — same model
    // MultiFunPlayer uses for the Handy, and inherently swap/seek-robust
    // (no cloud re-upload during the loop). HDSP clears HSSP's scriptSet,
    // so on release we re-establish HSSP from scratch (_restoreHandyAfterOrgasm).
    this.orgasmSwitch = new OrgasmSwitch({
      buttplugManager: this.buttplugManager,
      tcodeManager: this.tcodeManager,
      // NOTE: the Handy is deliberately NOT driven by the per-tick loop. It's
      // cloud-connected, and streaming ~25 HDSP commands/sec over the cloud API
      // can't keep up — the device just bumps. Instead the Handy plays the
      // finisher via HSSP LOOP mode (uploaded once, looped device-side), set up
      // in onActivate below. The loop here only drives local Buttplug/T-Code.
      handyManager: null,
      // Respect the per-device output limits the normal engines apply, so the
      // finisher doesn't push the toy past the user's configured floor/ceiling.
      getCutoff: (key) => this._cutoffFromSettings(key),
      // Flywheel machines follow the loop (Dave, 2026-11-17) through the
      // Buttplug engine's own oscillate path: mode, Max cap, ramp-up.
      oscillate: (dev, pos, prevPos, ms, startMs) => this.buttplugSync?.oscillateNow?.(dev.index, pos, prevPos, ms, startMs),
      onActivate: () => {
        // Phone button parity (F2): broadcast the new state so the web
        // remote's button reflects a keyboard-X press too. _active is
        // already true when onActivate runs.
        this._pushRemoteOrgasmState?.();
        // The resolved plan decides which engines the finisher takes over.
        // A custom plan can leave a kind untouched (stops* = false): those
        // devices keep playing the MAIN video script through the hold — the
        // user deliberately routed the finisher to other hardware.
        const plan = this._orgasmPlan || null;
        this._orgasmStoppedEngines = [];
        if ((!plan || plan.stopsButtplug !== false) && this.buttplugSync?._active) {
          this.buttplugSync.stop(); this._orgasmStoppedEngines.push('buttplug');
        }
        if ((!plan || plan.stopsTcode !== false) && this.tcodeSync?._active) {
          this.tcodeSync.stop(); this._orgasmStoppedEngines.push('tcode');
        }
        // Handy: stop the main HSSP + rate-change HDSP engines, then upload the
        // finisher (cached after first time) and LOOP it via HSSP — the same
        // cloud-friendly path the main script uses. Which script the Handy
        // plays comes from the plan (custom routing can give it its own);
        // the target is LOCKED for this activation — a mid-hold plan swap
        // never re-uploads (cloud round-trips would stall the finisher).
        const handyPath = plan?.handyPath || null;
        const handyContent = handyPath ? (this._orgasmContentCache?.get(handyPath) || null) : null;
        if (this.handyManager?.connected && handyPath && handyContent) {
          this._orgasmHandyEngaged = true;
          const activation = (this._orgasmActivationId = (this._orgasmActivationId || 0) + 1);
          // Stop UNCONDITIONALLY — do not gate on `_active`. That flag can
          // drift out of step with the engine's bound video handlers: the
          // web-remote path swaps `syncEngine.player` to the proxy and calls
          // start() again, which early-returns when _active is already true.
          // The logs showed `[Sync] correction hsspPlay` and `[Sync] seeked`
          // firing DURING a finisher hold with no "Sync engine stopped" line,
          // i.e. the guard skipped the stop while the handlers stayed live —
          // so the main script kept yanking the device to video time while it
          // was meant to be looping the finisher (Dave 2026-08-05).
          // stop() is safe to call when already stopped.
          this.syncEngine?.stop();
          if (this.handyHdspSync?.active) this.handyHdspSync.stop();
          // Fire-and-forget; the sequence + stale-activation aborts live in
          // orgasm-handy-engage.js where the order is unit-tested.
          // The output cutoff is baked into the upload (HSSP plays server-
          // side), so a cached URL is only valid for the cutoff it was
          // uploaded with — drop it if the sliders changed since.
          const cutoff = this._cutoffFromSettings('handy');
          // 'tiled-v2' — upload format version + the SCRIPT PATH: with
          // multi/custom configs the Handy's script can differ per plan, so
          // a cached URL is only valid for the exact script it uploaded.
          // The invert is baked into the upload too, so it is part of the key.
          const inverted = this._handyInverted();
          // An ending from the library plays once: uploaded untiled, and
          // its URL is never mixed up with a tiled upload's.
          const once = plan?.once === true;
          const cutoffKey = `${once ? 'once-v1' : 'tiled-v2'}|${handyPath}|${JSON.stringify(cutoff ?? null)}|inv=${inverted ? 1 : 0}`;
          if (this._orgasmCloudUrl && this._orgasmCloudUrlCutoffKey !== cutoffKey) {
            this._orgasmCloudUrl = null;
          }
          // Keep the promise: a quick release awaits it so the restore's
          // setScript can never interleave with an in-flight engage.
          const engage = () => engageHandyFinisher({
            handyManager: this.handyManager,
            content: handyContent,
            cachedUrl: this._orgasmCloudUrl,
            cutoff,
            inverted,
            once,
            onUrlCached: (url) => {
              this._orgasmCloudUrl = url;
              this._orgasmCloudUrlCutoffKey = cutoffKey;
            },
            isCurrent: () => activation === this._orgasmActivationId,
          });
          // An Edge Hold "Play a pattern" release still on its way (X just
          // released it, or Z was let go a moment ago) goes first, so the two
          // Handy sequences never interleave. Its restore may have started
          // the main engine meanwhile: stopped again before the finisher.
          // So does a Settings Test's Handy restore (pf-fixup).
          const priorReleases = [this._edgeReleasePromise, this._patternTestReleasePromise].filter(Boolean);
          const edgeRelease = priorReleases.length ? Promise.all(priorReleases).catch(() => {}) : null;
          this._orgasmEngagePromise = edgeRelease
            ? Promise.resolve(edgeRelease).then(() => {
              if (activation !== this._orgasmActivationId) return 'stale';
              this.syncEngine?.stop();
              if (this.handyHdspSync?.active) this.handyHdspSync.stop();
              return engage();
            })
            : engage();
        }
      },
      onDeactivate: () => {
        this._pushRemoteOrgasmState?.(); // phone button parity (F2)
        this._orgasmActivationId = (this._orgasmActivationId || 0) + 1; // cancel any in-flight engage
        // Finish mode (toggle): the user is "done" — leave the main engines
        // stopped and halt the devices where they are, rather than snapping
        // back to the main funscript.
        if (this._orgasmFinishStop) {
          this._orgasmFinishStop = false;
          this._orgasmStoppedEngines = [];
          this._orgasmHandyEngaged = false;
          // "Finished" means EVERYTHING stops — including engines a custom
          // plan left running on the main script (stops*=false kinds).
          // Idempotent when already stopped by onActivate.
          try { this.buttplugSync?.stop(); } catch { /* best-effort */ }
          try { this.tcodeSync?.stop(); } catch { /* best-effort */ }
          if (this.syncEngine?._active) this.syncEngine.stop();
          this._stopAllDevicesIdle();
          if (this.handyManager?.connected) {
            // Stop the finisher; leave the device idle. Awaits any in-flight
            // engage first so a stop can't land before a late hsspPlay.
            Promise.resolve(this._orgasmEngagePromise)
              .then(() => releaseHandyFinisher({ handyManager: this.handyManager }))
              // Unhandled otherwise: a cloud error here surfaced as
              // "[Rejection] Illegal state…" with no owner (Dave, 2026-08-21).
              .catch((err) => console.warn('[OrgasmSwitch] finisher release failed:', err?.message || err));
          }
          return;
        }
        // Hold mode: restart whichever local engines we stopped — they re-anchor
        // at the current video time automatically on their next tick.
        //
        // "On their next tick" is only true where the script HAS content. In
        // an unscripted zone the tick hits `nextIdx >= actions.length` or
        // `duration > MAX_GAP_MS` — both bare returns — so nothing is
        // commanded and the finisher's last value stays on the device. Two
        // sides each assuming the other would handle it: the finisher never
        // sends a stop on release, and the engine treats silence as safe.
        //
        // So zero the sustained-output actuators here. Linear is left alone
        // (a parked stroker is inert; a buzzing vibrator is not), and the
        // engines re-command within a tick wherever there IS script content,
        // which is imperceptible for vibration. Reported by Dave 2026-08-14:
        // the device "hangs on to the last value played in the orgasm switch
        // script" when releasing into an unscripted section.
        try { this.buttplugManager?.stopSustainedOutputs?.(); } catch { /* best-effort */ }
        if (this._orgasmStoppedEngines?.includes('buttplug')) this.buttplugSync.start();
        if (this._orgasmStoppedEngines?.includes('tcode')) this.tcodeSync.start();
        this._orgasmStoppedEngines = [];
        if (this._orgasmHandyEngaged) {
          this._orgasmHandyEngaged = false;
          // Await any in-flight engage first (a quick tap can release while
          // the engage's setScript is mid-flight — the engage aborts stale,
          // and only then do we stop + restore so the calls never interleave).
          // Kept: an Edge "Play a pattern" press meanwhile waits for it.
          const release = Promise.resolve(this._orgasmEngagePromise)
            .then(() => releaseHandyFinisher({ handyManager: this.handyManager }))
            .then(() => this._restoreHandyAfterOrgasm());
          this._orgasmReleasePromise = release;
          const settled = () => {
            if (this._orgasmReleasePromise === release) this._orgasmReleasePromise = null;
          };
          release.then(settled, (err) => {
            settled();
            console.warn('[OrgasmSwitch] Handy release failed:', err?.message || err);
          });
        }
      },
    });
    // The simulator is built before the switch, so wire it up here. Without
    // this the indicator keeps tracking video time during an orgasm loop,
    // which the loop deliberately ignores.
    if (this.deviceSimulator) this.deviceSimulator.orgasmSwitch = this.orgasmSwitch;
    // Edge Hold "Play a pattern" drives the local devices with its own
    // OrgasmSwitch: built here too, so the simulator follows it the same way.
    this._edgeLoop = this._makeEdgeLoop();

    // Load the saved global orgasm config (if any) into the controller.
    this._reloadOrgasmScripts();

    // Editor toggle button
    const btnEditor = document.getElementById('btn-editor');
    if (btnEditor) {
      btnEditor.addEventListener('click', () => {
        this.scriptEditor.toggle();
        // Editor visibility flips Up Next suppression — sync after the
        // toggle so an open editor never has a stray Up Next card on top.
        this._syncUpNextSuppression();
      });
    }

    // Initialize subtitle badge icon — and wire its click to toggle
    // subtitle visibility. Was a hover-styled but non-interactive badge
    // (Norman affordance violation: looked clickable, did nothing).
    // Now clicking it toggles the active text-track between 'showing'
    // and 'disabled'. If multiple tracks exist, the prior caller's
    // logic still picks the default; future improvement would be a
    // picker for multi-track files.
    const subBadgeInit = document.getElementById('subtitle-badge');
    if (subBadgeInit) {
      subBadgeInit.appendChild(icon(Captions, { width: 20, height: 20, 'stroke-width': 1.75 }));
      // Convert to a real button-equivalent via role + tabindex.
      subBadgeInit.setAttribute('role', 'button');
      subBadgeInit.setAttribute('tabindex', '0');
      subBadgeInit.setAttribute('aria-label', t('app.toggleSubtitles'));
      subBadgeInit.style.cursor = 'pointer';
      const toggleSubs = () => {
        const tracks = this.videoPlayer?.video?.textTracks;
        if (!tracks || tracks.length === 0) return;
        // Find the first track that's currently 'showing' or fall back
        // to track 0. Toggle between 'showing' and 'disabled'.
        let active = null;
        for (let i = 0; i < tracks.length; i++) {
          if (tracks[i].mode === 'showing') { active = tracks[i]; break; }
        }
        if (active) {
          active.mode = 'disabled';
          subBadgeInit.classList.remove('subtitle-badge--active');
        } else {
          tracks[0].mode = 'showing';
          subBadgeInit.classList.add('subtitle-badge--active');
        }
      };
      subBadgeInit.addEventListener('click', toggleSubs);
      subBadgeInit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSubs();
        }
      });
    }

    // Funscript badge — clicking opens the script editor (same as E
    // key). Previously a hover-styled span that did nothing; now a
    // real interactive control matching its affordance (Norman).
    const fsBadgeInit = document.getElementById('funscript-badge');
    if (fsBadgeInit) {
      fsBadgeInit.setAttribute('role', 'button');
      fsBadgeInit.setAttribute('tabindex', '0');
      fsBadgeInit.setAttribute('aria-label', t('app.openScriptEditor'));
      fsBadgeInit.style.cursor = 'pointer';
      const openEditor = () => this.scriptEditor?.toggle?.();
      fsBadgeInit.addEventListener('click', openEditor);
      fsBadgeInit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openEditor();
        }
      });
    }

    // Variant selector button
    const variantBtn = document.getElementById('variant-btn');
    if (variantBtn) {
      variantBtn.addEventListener('click', () => {
        const dropdown = document.getElementById('variant-dropdown');
        if (dropdown && !dropdown.hidden) {
          dropdown.hidden = true;
        } else {
          // Render immediately from cache, then refresh from disk in the
          // background and re-render if the folder gained/lost variants
          // since the last scan (added files, or a reconnected drive).
          this._showVariantDropdown();
          this._refreshCurrentVariantsFromDisk().then((changed) => {
            const dd = document.getElementById('variant-dropdown');
            if (changed && dd && !dd.hidden) this._showVariantDropdown();
          });
        }
      });
    }

    // Stop Handy device when app closes. On beforeunload, unless the page
    // holds the unload for unsaved editor edits (R4-20): then on pagehide, if
    // the page goes after all (_onBeforeUnload).
    this._stopEverythingOnUnload = () => {
      try {
        if (this._sourcePollingInterval) clearInterval(this._sourcePollingInterval);
        if (this._vrActivityInterval) clearInterval(this._vrActivityInterval);
        if (this._rescanPollInterval) clearInterval(this._rescanPollInterval);
        if (this.syncEngine) this.syncEngine.stop();
        if (this.buttplugSync) this.buttplugSync.stop();
        if (this.tcodeSync) this.tcodeSync.stop();
        if (this.autoblowSync) this.autoblowSync.stop();
        if (this.handyManager?.connected) {
          this.handyManager.hsspStop();
          this.handyManager.disconnect();
        }
        if (this.buttplugManager?.connected) {
          this.buttplugManager.stopAll();
          this.buttplugManager.disconnect();
        }
        if (this.tcodeManager?.connected) {
          this.tcodeManager.stop();
          this.tcodeManager.disconnect();
        }
        if (this.autoblowManager?.connected) {
          this.autoblowManager.disconnect();
        }
        // Audience viewers, best effort: the window may be gone before these
        // requests leave. Main holds the close for an awaited stop while a
        // room is open (electron/relaunch-stop.js holdCloseForStop).
        if (this.audienceBridge?.roomActive) this.audienceBridge.hsspStopAll();
      } catch (e) {
        // Fire-and-forget — app is closing
      }
    };
    window.addEventListener('beforeunload', (e) => this._onBeforeUnload(e));
    window.addEventListener('pagehide', () => this._onPageHide());

    // Import Backup File and Restore From Backup relaunch the app with
    // app.exit, which never fires the beforeunload above. Main asks for the
    // stop first and waits for this answer (electron/relaunch-stop.js).
    window.funsync?.onStopForRelaunch?.(async (token) => {
      try {
        await this._stopForRelaunch();
      } catch (err) {
        console.warn('[Relaunch] stop before relaunch failed:', err?.message || err);
      } finally {
        window.funsync?.stoppedForRelaunch?.(token);
      }
    });

    // Closing this window, quitting, a reload, Restart Now for an update and
    // Import / Restore's relaunch ask about unsaved editor edits first: main
    // holds them while the editor is dirty and waits for this answer
    // (R3-19, electron/unsaved-edits-guard.js).
    window.funsync?.onConfirmUnsavedBeforeExit?.((token, reason, expiresAt) => this._answerUnsavedBeforeExit(token, reason, expiresAt));
    window.funsync?.onConfirmUnsavedExpired?.((token) => this._onUnsavedExitAskExpired(token));

    // Listen for auto-update events from main process
    this._initAutoUpdater();

    // Show library as default landing page
    mark('library.show() invoked');
    this._onEnterView('library');

    // Poll source availability every 30s (detect external drive connect/disconnect)
    this._sourcePollingInterval = setInterval(() => this._pollSourceAvailability(), 30000);

    // Poll VR activity every 2s (auto-connect companion bridge when Quest picks a video)
    this._vrActivityInterval = setInterval(() => this._pollVRActivity(), 2000);
    this._lastVrActivityTs = 0;

    // Piggyback the VR nav-bar tooltip off the same 2s tick so the user
    // can see reconnect progress without opening the VR modal. The VR
    // bridge doesn't emit events during backoff retries, so polling is
    // the only way to surface attempt counts live.
    this._vrTooltipInterval = setInterval(() => this._updateVRTooltip(), 2000);
    this._updateVRTooltip();

    // Poll for phone-triggered rescan requests every 3s. The web remote's
    // Refresh button bumps a backend counter; when it advances past what we
    // last saw, force a library rescan + re-register so files the user just
    // added reach the phone without touching the desktop. `_lastRescanSeq`
    // starts null so the first poll only establishes a baseline (no rescan
    // on launch).
    this._lastRescanSeq = null;
    this._rescanPollInterval = setInterval(() => this._pollRescanRequest(), 3000);

    // If we have a saved Quest host from a previous session, try to
    // reconnect directly — the in-memory backend _vr_activity record
    // resets to null on app restart, so the polling path can't help
    // until the user navigates a scene on HereSphere. A direct connect
    // using the last-known host closes that gap for the "app restarted
    // while HereSphere is still running" case.
    this._attemptSavedHostReconnect();

    // First-launch language picker — modal prompts users who have not yet
    // explicitly chosen a language. Replaces the prior offer-toast (which
    // only surfaced for non-English OS locales). Now every existing user
    // also gets prompted on first launch of the update, so the new locales
    // are visible to all (Nielsen #2 match between system and real world —
    // an English-OS user might still prefer another language).
    this._promptLanguageIfApplicable();

    mark('init() complete (library scan + thumbnails still in flight)');
    console.log('FunSync Player initialized');
  }

  /**
   * Read a funscript by absolute path with a stale-path fallback +
   * auto-prune. Both apply to any caller that owns persisted script
   * paths (custom routing, manual variants, multi-axis configs).
   *
   * Recovery: if the stored path can't be read but the same basename
   * exists next to `videoPath`, return that content + the recovered path.
   *
   * Prune: when both the stored path AND the recovery target fail,
   * silently delete any matching entry from `library.manualVariants`
   * (the most common source of stale path spam in the backend log).
   *
   * @param {string} scriptPath  absolute path the caller has stored
   * @param {string|null} videoPath  current video's absolute path
   * @returns {Promise<{content: string, recoveredPath: string|null} | null>}
   */
  async _readScriptResilient(scriptPath, videoPath = null) {
    if (!scriptPath) return null;
    try {
      const c = await window.funsync.readFunscript(scriptPath);
      if (c) return { content: c, recoveredPath: null };
    } catch { /* fall through to recovery */ }

    // Recovery: same basename in the video's directory.
    if (videoPath) {
      const basename = scriptPath.split(/[\\/]/).pop();
      const sep = videoPath.includes('\\') ? '\\' : '/';
      const dirEnd = Math.max(videoPath.lastIndexOf('\\'), videoPath.lastIndexOf('/'));
      if (dirEnd > 0 && basename) {
        const fallback = videoPath.slice(0, dirEnd) + sep + basename;
        if (fallback !== scriptPath) {
          try {
            const c = await window.funsync.readFunscript(fallback);
            if (c) {
              console.log(`[Variants] scriptPath ${scriptPath} not found — recovered via ${fallback}`);
              return { content: c, recoveredPath: fallback };
            }
          } catch { /* both gone — fall through to prune */ }
        }
      }
    }

    // Both reads failed. This script was EXPECTED (a stored variant, route
    // or axis path), but main.js logs a missing file at debug because most
    // reads are badge probes (V57). Say it once per path per session, here,
    // so a "my script didn't load" log shows why (FT-043).
    const missed = (this._expectedScriptMisses ||= new Set());
    if (!missed.has(scriptPath)) {
      missed.add(scriptPath);
      console.warn('[Script] expected script not found:', scriptPath);
    }

    // Nothing stored changes: a variation whose script is missing, even
    // provably gone, is never removed (Dave, 2026-11-18: "Yes, stop those
    // too"). The video options' Variations list says "Script not found"
    // with Locate. This called `_pruneStaleManualVariant` (gone), which
    // dropped it when `library._safeToPrune` approved.
    return null;
  }

  /** @deprecated thin shim around _readScriptResilient — kept for
   *  custom-routing call-site readability. */
  _readRouteScript(route, videoPath) {
    return this._readScriptResilient(route?.scriptPath, videoPath);
  }

  /**
   * Update an existing manualVariants entry to point at a recovered
   * path. Called after _readScriptResilient finds the file at a new
   * location — without this the entry would still point at the dead
   * path and the next render would re-trigger the recovery work.
   */
  _healManualVariantPath(videoPath, variant) {
    if (!videoPath || !variant?.path) return;
    const all = this.settings.get('library.manualVariants') || {};
    const list = all[videoPath];
    if (!list) return;
    let dirty = false;
    for (const v of list) {
      // Match by name (basename is stable across moves) — the path we
      // want to update IS the dead one. After we land here, variant.path
      // is already the recovered value.
      if (v.name === variant.name && v.path !== variant.path) {
        v.path = variant.path;
        dirty = true;
      }
    }
    if (dirty) {
      this.settings.set('library.manualVariants', all);
      console.log(`[Variants] Healed manualVariant ${variant.name} → ${variant.path}`);
    }
  }

  /**
   * Tear down all custom-routing state on the app + sync engines. Safe to
   * call when routing isn't active (cheap no-op). Must run at every
   * video transition BEFORE checking if the new video wants routing,
   * otherwise:
   *   - stale `_customRoutingActive=true` makes `_sendToDevices` filter out
   *     devices that aren't explicitly on L0, so single-axis playback only
   *     fires on whichever device happened to be L0 on the previous video
   *   - stale `setAxisActions` entries keep playing the previous video's
   *     routed scripts on devices that were on CR1/CR2/... last time
   *
   * Used by both the local-playback path and the VR load path.
   */
  _resetCustomRoutingState() {
    if (!this._customRoutingActive) return;
    this._customRoutingActive = false;
    this._currentCustomRoutes = null;
    this._currentCustomRoutingVideoPath = null;
    if (this.buttplugSync) {
      this.buttplugSync._customRoutingActive = false;
      this.buttplugSync._axisAssignmentMap.clear();
      this.buttplugSync.clearAxisActions();
    }
    if (this.tcodeSync) {
      this.tcodeSync.clearAxisActions();
    }
  }

  /**
   * Load custom routing: each route gets a synthetic axis, device is pre-assigned.
   * Main route is already loaded via loadFunscript (L0). Additional routes get CR1, CR2, etc.
   */
  async _loadCustomRouting(routes, videoPath = null) {
    if (!routes || routes.length === 0) return;
    // A route read or upload can outlast the video: Next during Play All, or
    // another click, runs loadVideo (which bumps `_videoLoadGen`) and that
    // video owns the engines and devices now. Nothing read for this one may
    // land there (V72 review).
    const gen = this._videoLoadGen;
    const movedOn = () => this._videoLoadGen !== gen;
    this._currentCustomRoutes = routes;
    this._currentCustomRoutingVideoPath = videoPath;
    console.log(`[CustomRouting] Loading ${routes.length} route(s) for video: ${videoPath || '(unknown)'}`);

    // Tell sync engines that custom routing is active — unassigned devices get nothing
    if (this.buttplugSync) this.buttplugSync._customRoutingActive = true;

    // Track whether any route's scriptPath was rewritten by the
    // stale-path fallback so we can persist the corrections at the end.
    let scriptPathsHealed = false;

    // Collision guard (community report, TODO.md backlog): if main is
    // routed to native Handy AND any CR route ALSO points at Handy,
    // the CR upload races and overwrites the main upload (last call
    // wins, no determinism). Detect once up-front; CR Handy-uploads
    // are skipped when this fires. Main owns the Handy in collision —
    // it was the user's primary choice via the dropdown that maps the
    // main script to native Handy.
    const mainOnHandy = routes.some(r => r.role === 'main' && r.deviceId === 'handy');
    let suppressedHandyUploads = 0;

    let axisCounter = 1;
    for (const route of routes) {
      if (route.role === 'main') {
        // Main route is loaded via loadFunscript; tag its synthetic axis
        // so re-match on hot-plug knows where to reassign it.
        route._assignedAxis = 'L0';
        continue;
      }

      if (!route.scriptPath) continue;

      try {
        const read = await this._readRouteScript(route, videoPath);
        if (movedOn()) return;
        if (!read) continue;
        const content = read.content;
        // Self-heal: if the recovery path differs, persist it back so
        // future plays skip the fallback.
        if (read.recoveredPath) {
          route.scriptPath = read.recoveredPath;
          scriptPathsHealed = true;
        }
        const parsed = JSON.parse(content);
        const actions = parsed?.actions;
        if (!actions || actions.length < 2) continue;

        // Assign to a synthetic axis (CR1, CR2, ...)
        const syntheticAxis = `CR${axisCounter++}`;
        route._assignedAxis = syntheticAxis;

        if (this.buttplugSync) {
          this.buttplugSync.setAxisActions(syntheticAxis, actions);
        }
        if (this.tcodeSync) {
          this.tcodeSync.setAxisActions(syntheticAxis, actions);
        }

        // For Handy on a non-main route: upload and start its own sync.
        // Skipped when main is already on Handy (collision guard above).
        if (route.deviceId === 'handy' && this.handyManager?.connected) {
          if (mainOnHandy) {
            suppressedHandyUploads++;
            console.log('[CustomRouting] Skipping Handy upload for CR route — main already targets Handy (last-write-wins collision avoided).');
          } else {
            // Output limits, filler and extender too, as a local open's
            // upload, on the timeline it plays on (a headset's when VR loads
            // the routes): FT-113, also in v0.9.2 (it sent only the invert).
            // This window's video: once its length is known (FT-113 race).
            const routeDurationMs = this._uploadDurationMsFor(this.syncEngine?.player);
            if (routeDurationMs === undefined && this._localDurationPending?.()) {
              await this._whenLocalDurationKnown();
              if (movedOn()) return;
            }
            const upload = this.handyManager.uploadAndSetScript(this._handyUploadContent(content, this._handyInverted(), {
              durationMs: routeDurationMs,
            }));
            // This call's number (taken before its first await, FT-116).
            const uploadSeq = this.handyManager.uploadSeq;
            const setOk = await upload;
            if (movedOn()) return;
            // The route's script is the one on the device now: mark it ready
            // and start, as _uploadAndStartSync does for the main route.
            // loadVideo sets the old script not ready (FN-01), and nothing
            // else on this path set it again, so a Handy on a route that is
            // not main never played after FN-01 (block F review, 2026-11-16).
            // A newer upload took the device: not ours to start (FT-116).
            const superseded = uploadSeq != null && this.handyManager.uploadSeq !== uploadSeq;
            if (setOk && !superseded && this.syncEngine) {
              const engineWaiting = !!this.syncEngine._active && !this.syncEngine._scriptReady;
              this.syncEngine._scriptReady = true;
              this.syncEngine.start();
              if (engineWaiting && this.syncEngine.player?.paused === false) {
                this.syncEngine.resync().catch((err) => {
                  console.warn('[CustomRouting] Handy anchor after the route upload failed:', err?.message || err);
                });
              }
            }
          }
        }

        // For Autoblow on a non-main route: upload its script and start its
        // sync, as the routed Handy is started above (E-13; also in v0.9.2).
        // loadFunscript leaves an Autoblow that is not on the main route
        // alone, so nothing else ever started it: the script sat uploaded
        // and the device never played. Skipped when main is on the Autoblow
        // too: the main load uploads over it (the Handy's collision rule).
        if (route.deviceId === 'autoblow' && this.autoblowManager?.connected && this.autoblowSync
            && !routes.some((r) => r.role === 'main' && r.deviceId === 'autoblow')) {
          // A script is never swapped under a device mid-play, and start()
          // is a no-op on an engine still active (`_switchVariant`'s rule).
          if (this.autoblowSync._active) this.autoblowSync.stop();
          // Limits, filler and extender too (FT-113: it sent the raw script),
          // for this window's video once its length is known (FT-113 race).
          const routeDurationMs = this._uploadDurationMsFor(this.autoblowSync.player);
          if (routeDurationMs === undefined && this._localDurationPending?.()) {
            await this._whenLocalDurationKnown();
            if (movedOn()) return;
          }
          const ok = await this.autoblowSync.uploadScript(this._autoblowUploadContent(content, {
            durationMs: routeDurationMs,
          }));
          if (movedOn()) return;
          if (ok && !this.autoblowSync._active) this.autoblowSync.start();
        }

        console.log(`[CustomRouting] Loaded ${route.scriptPath.split(/[\\/]/).pop()} → ${syntheticAxis} → ${route.deviceId}`);
      } catch (err) {
        console.warn(`[CustomRouting] Failed to load route:`, err.message);
      }
    }
    // After the last route's upload: the assignments, toasts and editor
    // list below are this video's too.
    if (movedOn()) return;

    // Apply Buttplug device assignments through the shared helper so the
    // same logic runs at initial load and from onDeviceAdded (late connect).
    const totalBpRoutes = routes.filter(r =>
      typeof r.deviceId === 'string' && r.deviceId.startsWith('buttplug:')
    ).length;
    const unmatchedBpRoutes = this._applyCustomRoutingAssignments();
    this._reportCustomRoutingMismatches(unmatchedBpRoutes, totalBpRoutes);

    // Persist any recovered scriptPaths so the user doesn't have to keep
    // paying the fallback cost on every play. _applyCustomRoutingAssignments
    // also persists when buttplug indices self-heal, but its check only
    // covers index changes — explicit call here for the path case.
    if (scriptPathsHealed) this._persistCustomRoutes();

    // One-time toast if the collision guard suppressed any uploads —
    // tell the user the device is bound to main, not to the CR route
    // they configured. Otherwise the CR script appears to be ignored
    // with no visible explanation.
    if (suppressedHandyUploads > 0) {
      showToast(
        `Native Handy is on main (${suppressedHandyUploads} custom-routing upload${suppressedHandyUploads > 1 ? 's' : ''} skipped to avoid collision)`,
        'warn',
        4500,
      );
    }

    // Update editor script list for custom routing
    if (this.scriptEditor) {
      const scripts = [];
      for (const route of routes) {
        if (!route.scriptPath) continue;
        const device = this._findKnownDeviceForRoute(route);
        const deviceLabel = device ? device.label : (route.deviceId || '');
        const prefix = route.role === 'main' ? '★ ' : '';
        const scriptName = route.scriptName || route.scriptPath.split(/[\\/]/).pop();
        scripts.push({ label: `${prefix}${deviceLabel}: ${scriptName}`, path: route.scriptPath });
      }
      if (scripts.length > 1) this.scriptEditor.setAvailableScripts(scripts);
    }
  }

  _isDeviceOnMainRoute(deviceId) {
    if (!this._currentCustomRoutes) return false;
    const mainRoute = this._currentCustomRoutes.find(r => r.role === 'main');
    return mainRoute && mainRoute.deviceId === deviceId;
  }

  /**
   * Match a custom-routing route to a currently-connected Buttplug device.
   *
   * Strategy:
   *   1. Index + name both match → high-confidence hit (stable across
   *      Intiface restarts).
   *   2. Index matches but name differs → Intiface likely reshuffled the
   *      slot to a different physical device. Reject the index hit, try
   *      name-only — prevents silently driving the wrong hardware.
   *   3. Name matches (no usable stored index or the index was stale) →
   *      accept. Caller will refresh the stored index.
   *   4. Nothing matches → null → _reportCustomRoutingMismatches fires
   *      the user-facing toast.
   *
   * @param {{deviceId: string, buttplugIndex?: number}} route
   * @returns {{dev: object, matchedBy: 'index'|'name'} | null}
   */
  _matchButtplugRoute(route, options = {}) {
    if (!this.buttplugManager?.connected) return null;
    const result = matchButtplugRoute(route, this.buttplugManager.devices, options);
    if (result?.indexMismatch) {
      const byIdx = this.buttplugManager.devices.find(d => d.index === route.buttplugIndex);
      console.warn(
        `[CustomRouting] Index ${route.buttplugIndex} is now "${byIdx?.name}" — ` +
        `route wanted ${route.deviceId}. Falling back to name match to avoid driving the wrong device.`
      );
    }
    return result;
  }

  /**
   * Idempotent — walk `this._currentCustomRoutes`, match each buttplug:
   * route to a live device, and write the axis assignment into
   * buttplugSync. Called once during initial `_loadCustomRouting` and then
   * again from `onDeviceAdded` so a device that connects after the video
   * started still gets its route applied (no reload needed).
   *
   * Returns the list of routes that couldn't be matched — caller decides
   * whether to surface them to the user.
   *
   * @returns {Array<{axis: string, role: string, deviceId: string}>}
   */
  _applyCustomRoutingAssignments() {
    const unmatched = [];
    const routes = this._currentCustomRoutes || [];
    if (!this.buttplugManager?.connected || !this.buttplugSync) {
      // Collect unmatched buttplug routes so the caller still reports them.
      for (const route of routes) {
        if (route.deviceId?.startsWith('buttplug:') && route._assignedAxis) {
          unmatched.push({
            axis: route._assignedAxis,
            role: route.role === 'main' ? 'main' : 'axis',
            deviceId: route.deviceId,
          });
        }
      }
      return unmatched;
    }

    let anyHealed = false;

    // Only process routes that target a Buttplug device and have an axis.
    const bpRoutes = routes.filter(r =>
      r.deviceId?.startsWith('buttplug:') && r._assignedAxis
    );

    // Two-pass matching protects the two-same-name-device case:
    //   Pass 1 — authoritative index-hits claim their devices first.
    //   Pass 2 — name-fallback for any remaining route, skipping indices
    //            already claimed by pass 1.
    // Without the claim set, a pass-1 name-fallback could steal a device
    // that a later pass-2 route would legitimately have index-matched.
    const claimedIndices = new Set();
    const pendingNameFallback = [];

    const applyMatch = (route, match) => {
      this.buttplugSync.setAxisAssignment(match.dev.index, route._assignedAxis);
      const prevIdx = route.buttplugIndex;
      console.log(
        `[CustomRouting] ${route._assignedAxis} (${route.role === 'main' ? 'main' : 'axis'}) → ` +
        `"${match.dev.name}" (index ${match.dev.index}) — matched by ${match.matchedBy}` +
        (match.matchedBy === 'name' && Number.isFinite(prevIdx) && prevIdx !== match.dev.index
          ? ` (stored index ${prevIdx} was stale, refreshed to ${match.dev.index})`
          : '')
      );
      if (match.matchedBy === 'name' && match.dev.index !== route.buttplugIndex) {
        route.buttplugIndex = match.dev.index;  // in-memory heal
        anyHealed = true;
      }
      claimedIndices.add(match.dev.index);
    };

    // Pass 1 — direct index hits.
    for (const route of bpRoutes) {
      if (!Number.isFinite(route.buttplugIndex)) {
        pendingNameFallback.push(route);
        continue;
      }
      // Attempt a pure index-match (no name-fallback yet). If the device at
      // the stored index exists AND its name matches, claim it. Anything
      // else defers to pass 2.
      const dev = this.buttplugManager.devices.find(d => d.index === route.buttplugIndex);
      if (dev && `buttplug:${dev.name}` === route.deviceId) {
        applyMatch(route, { dev, matchedBy: 'index' });
      } else {
        pendingNameFallback.push(route);
      }
    }

    // Pass 2 — name-fallback with claim-set protection.
    for (const route of pendingNameFallback) {
      const match = this._matchButtplugRoute(route, { excludeIndices: claimedIndices });
      if (match) {
        applyMatch(route, match);
      } else {
        unmatched.push({
          axis: route._assignedAxis,
          role: route.role === 'main' ? 'main' : 'axis',
          deviceId: route.deviceId,
        });
      }
    }

    if (anyHealed) this._persistCustomRoutes();
    return unmatched;
  }

  /**
   * Write the current in-memory `_currentCustomRoutes` back to settings so
   * index self-heals survive restart. Noop when we don't know which video
   * the routes belong to (e.g. routes injected via funscript data rather
   * than loaded from settings).
   */
  _persistCustomRoutes() {
    const videoPath = this._currentCustomRoutingVideoPath;
    if (!videoPath || !this._currentCustomRoutes) return;

    const associations = this.settings.get('library.associations') || {};
    const entry = normalizeAssociation(associations[videoPath]);
    // Only persist when custom is still the active mode for this video. If
    // the user switched to single/multi while playback was running, we
    // must NOT resurrect the routing config onto the active pointer.
    if (entry.active !== 'custom') return;

    // Strip internal _assignedAxis helper before persisting.
    const cleanRoutes = this._currentCustomRoutes.map(r => {
      const copy = { ...r };
      delete copy._assignedAxis;
      return copy;
    });

    associations[videoPath] = buildAssociationEntry(
      'custom',
      entry.single,
      entry.multi,
      { ...(entry.custom || {}), routes: cleanRoutes },
    );
    this.settings.set('library.associations', associations);
    console.log('[CustomRouting] Persisted refreshed buttplugIndex(es) back to library.associations');
  }

  /**
   * Diagnose + surface custom-routing routes whose stored `buttplug:<name>`
   * doesn't match any currently-connected Buttplug device. Without this, the
   * old code would silently skip the assignment and the device would stay
   * inert (because _customRoutingActive=true means unassigned devices get
   * zero commands). Most common cause: Intiface renames a device between
   * routing setup and playback (e.g. after a version update or pairing reset).
   *
   * @param {Array<{axis: string, role: string, deviceId: string}>} unmatched
   */
  _reportCustomRoutingMismatches(unmatched, totalBpRoutes = 0) {
    if (!unmatched || unmatched.length === 0) return;
    const available = this.buttplugManager?.devices?.map(d => d.name) || [];

    // Always log to console — useful for debugging support requests even
    // when we don't toast.
    console.warn('[CustomRouting] Route(s) reference a Buttplug device that is not currently connected:');
    for (const u of unmatched) {
      const wanted = u.deviceId.replace(/^buttplug:/, '');
      console.warn(`  • ${u.role === 'main' ? 'Main' : u.axis} → buttplug:"${wanted}" (device not found)`);
    }
    console.warn(`[CustomRouting] Currently connected Buttplug devices: ${available.length ? available.map(n => `"${n}"`).join(', ') : '(none)'}`);
    console.warn('[CustomRouting] Affected devices will stay silent until routing is updated or the device reconnects under the saved name.');

    const missingNames = unmatched.map(u => `"${u.deviceId.replace(/^buttplug:/, '')}"`).join(', ');
    const availLabel = available.length ? available.map(n => `"${n}"`).join(', ') : 'no Buttplug devices';
    const allFailed = totalBpRoutes > 0 && unmatched.length >= totalBpRoutes;

    if (allFailed) {
      // Every routed device is missing — the custom routing config is
      // effectively broken. Surface as a persistent error so the user
      // opens the routing modal and fixes it.
      showToast(
        `Custom routing: can't find ${missingNames}. Connected: ${availLabel}. ` +
        `Re-open the routing setup and pick the right device. ` +
        `If you recently reset or reinstalled Intiface, the device needs to be re-picked.`,
        'error',
        0,  // persistent — the user has to act
      );
    } else {
      // Partial mismatch — some routed devices are online, others aren't.
      // Used to be silenced as "noise", but users reported confusion
      // during testing when 1 of N devices stayed quiet with no UI
      // signal. Surface as a dismissable warn that auto-clears — if the
      // device reconnects, onDeviceAdded re-runs the match and the
      // partial-mismatch toast is obsolete.
      this._partialRoutingToast?.dismiss?.();
      this._partialRoutingToast = showToast(
        `Custom routing: ${unmatched.length} of ${totalBpRoutes} routed Buttplug device(s) offline — ${missingNames}. ` +
        `Other devices are playing; this one will pick up when it reconnects.`,
        'warn',
        10000,
      );
    }
  }

  /**
   * Handle VR player reporting a new video. Match to library, load script, start sync.
   */
  async _onVRVideoChanged(normalizedName, rawPath) {
    console.log(`[VR] Video changed: ${rawPath}`);

    // Tell the tracker — fires mutex if Web Remote was active.
    const playerType = this.vrBridge?._playerType || 'vr';
    const host = this.vrBridge?._host || '';
    const id = host ? `${playerType} @ ${host}` : playerType;
    const cur = this.sessionTracker?.getSession();
    if (!cur || cur.source !== 'vr' || cur.identifier !== id) {
      this.sessionTracker?.startSession('vr', id);
    }
    this.sessionTracker?.setVideo({
      name: vrDisplayName(rawPath, normalizedName),
      videoId: null,
      videoPath: rawPath,
    });
    this.sessionTracker?.setState('preparing');

    // Guard against concurrent calls (rapid video browsing in VR player)
    this._vrMatchGeneration = (this._vrMatchGeneration || 0) + 1;
    const gen = this._vrMatchGeneration;

    // Stash the display name on the bridge so the VR modal can render it
    // even when it wasn't open at the moment the video changed. Defensive
    // `|| ''` fallback mirrors line 1423 — without it, an upstream caller
    // that drops `rawPath` crashes the whole handler before script load.
    let displayName = vrDisplayName(rawPath, normalizedName);
    if (this.vrBridge) this.vrBridge.__vrModalLastVideo = displayName;

    // Stop existing sync engines (they'll be rebound to VR proxy). This also
    // ends the previous VR video's audience source. The per-video sync
    // offset (#380) is left as it is: this video settles it once below
    // (`_settleVRVideoSyncOffset`), so a change sends at most one update.
    this._stopVRSync({ keepVideoSyncOffset: true });

    // Audience: the headset's video is a new source; viewers stop now (#361).
    // It is a VR source, so viewers never play it (the stopgap follows only
    // the local player) and it ends with the VR session (_stopVRSync). Taken
    // AFTER _stopVRSync, which would end it, and before the first await.
    // Every return below that is not stale settles it as no script.
    const audienceToken = this.audienceBridge?.beginSource({ title: displayName, player: SOURCE_PLAYER.VR }) ?? null;
    const audienceNoScript = (reason, failed = false) => this.audienceBridge?.setNoScript(audienceToken, { reason, failed });

    // Ensure the library has scanned at least once — re-uses existing _videos
    // + manual associations instead of duplicating that logic here.
    if (!this.library) {
      showToast(t('toast.vrLibraryUnavailable'), 'warn');
      audienceNoScript('vr-no-library');
      this._settleVRVideoSyncOffset?.(null);
      return;
    }
    // A scan or match that throws drives nothing either: the local video's
    // delta goes back on, not the previous headset video's (the stop above
    // kept it), and the error carries on as before.
    const settleThenThrow = (err) => {
      if (gen === this._vrMatchGeneration) this._settleVRVideoSyncOffset?.(null);
      throw err;
    };
    try {
      await this.library.ensureScanned();
    } catch (err) { settleThenThrow(err); }

    // Abort if a newer video change arrived while we were scanning
    if (gen !== this._vrMatchGeneration) return;

    if (!this.library._videos?.length) {
      showToast(t('toast.vrNoSources'), 'warn');
      audienceNoScript('vr-no-sources');
      this._settleVRVideoSyncOffset?.(null);
      return;
    }

    // Resolves FunSync's own stream / scene URLs by id before name matching
    // (V63); that asks the backend, so check for a newer video after it.
    let matched;
    try {
      matched = await this.library.resolveVRVideo(normalizedName, rawPath);
    } catch (err) { settleThenThrow(err); }
    if (gen !== this._vrMatchGeneration) return;

    // Such a URL ends in the id, not a file name: once it resolves, the
    // modal and the toasts name the file instead.
    if (matched && funsyncVideoIdFromVRPath(rawPath)) {
      displayName = matched.name;
      if (this.vrBridge) this.vrBridge.__vrModalLastVideo = displayName;
    }

    if (!matched || !matched.hasFunscript) {
      showToast(t('toast.vrNoScript', { name: displayName }), 'info', 4000);
      audienceNoScript('vr-no-script');
      // Drives nothing: the local video's delta applies, not this one's.
      this._settleVRVideoSyncOffset?.(null);
      return;
    }

    // Set at the takeover below; read by the catch.
    let vrSyncOffsetSettled = false;

    // Load the funscript. Gen-check after EVERY await — rapid video
    // browsing in HereSphere can fire multiple video-changed events
    // before any one finishes loading. Without these checks, an older
    // video's script upload could land on the Handy AFTER a newer
    // video has started its own load, and the two would stomp each
    // other's Handy state mid-async.
    try {
      const content = await window.funsync.readFunscript(matched.funscriptPath);
      if (gen !== this._vrMatchGeneration) return;
      if (!content) {
        audienceNoScript('vr-read-failed', true);
        this._settleVRVideoSyncOffset?.(null);
        return;
      }

      const fsName = matched.funscriptPath.split(/[\\/]/).pop();
      this._stashLocalScriptBeforeRemote?.(); // R4-04
      // Throws on a script that is not a funscript, before the engine
      // changes: this window's routing and axes are still its own then.
      await this.funscriptEngine.loadContent(content, fsName);
      // The headset's script has the engine: this window's custom routing
      // goes now (C-06), not in the _stopVRSync above, so a headset video
      // with no match, no script or an unreadable one leaves it in place.
      // The session's end puts it back (R4-04).
      this._resetCustomRoutingState();
      this._clearLocalAxesForRemote?.();
      // Not this window's video's script: the editor keeps off it (R3-20).
      this._engineHeldByRemote = true;
      if (gen !== this._vrMatchGeneration) return;
      // The headset's script drives the devices from here: its video's
      // per-video sync offset (#380), keyed by the LOCAL path it matched,
      // goes on before any device starts. _stopVRSync takes it off.
      this._settleVRVideoSyncOffset?.(matched.path);
      vrSyncOffsetSettled = true;
      // Built only when a viewer needs it.
      this.audienceBridge?.setScript(audienceToken, {
        content: () => this._audienceScriptContent(content),
        title: fsName,
      });
      showToast(t('toast.vrScriptLoaded', { name: fsName }), 'info', 3000);

      // Build a player-like wrapper around the VR proxy
      // Sync engines read player.video for event binding and player.currentTime/paused/duration for state
      const vrVideo = this.vrBridge.proxy;
      const vrPlayer = { video: vrVideo, get currentTime() { return vrVideo.currentTime; }, get paused() { return vrVideo.paused; }, get duration() { return vrVideo.duration; } };
      this._vrPlayerRef = vrPlayer; // keep reference for cleanup

      // Bind sync engines to VR proxy (stop was already called in _stopVRSync)
      if (this.buttplugSync && this.buttplugManager?.connected) {
        this.buttplugSync.player = vrPlayer;
        this.buttplugSync.reloadActions();
        this.buttplugSync.start();
      }

      if (this.tcodeSync && this.tcodeManager?.connected) {
        this.tcodeSync.player = vrPlayer;
        this.tcodeSync.reloadActions();
        this.tcodeSync.start();
      }

      // The cloud uploads below carry the output limits, the gap filler and
      // the Range Extender, as a local open's do (FT-113; also in v0.9.2:
      // they carried only the invert), and the filler runs to the HEADSET
      // video's end (read at each upload: the headset may report its length
      // only once it has loaded; the library's until then).
      const vrDurationMs = () => this._sessionTimelineMs(vrVideo, matched);

      // Handy: upload and sync to VR proxy timeline
      if (this.handyManager?.connected) {
        await this.handyManager.uploadAndSetScript(this._handyUploadContent(content, this._handyInverted(), {
          durationMs: vrDurationMs(),
        }));
        if (gen !== this._vrMatchGeneration) return;
        if (this.syncEngine) {
          this.syncEngine.player = vrPlayer;
          this.syncEngine._scriptReady = true;
          this.syncEngine.start();
        }
      }

      // Autoblow
      if (this.autoblowManager?.connected && this.autoblowSync) {
        await this.autoblowSync.uploadScript(this._autoblowUploadContent(content, { durationMs: vrDurationMs() }));
        if (gen !== this._vrMatchGeneration) return;
        this.autoblowSync.player = vrPlayer;
        this.autoblowSync.start();
      }

      // Load custom routing if active for this video
      const associations = this.settings.get('library.associations') || {};
      const entry = normalizeAssociation(associations[matched.path]);
      const resolved = resolveActiveConfig(entry);
      if (resolved?.kind === 'custom') {
        this._customRoutingActive = true;
        await this._loadCustomRouting(resolved.config.routes || [], matched.path);
        if (gen !== this._vrMatchGeneration) return;
      }

      // Forward VR proxy state into the session tracker so the card updates.
      const proxy = this.vrBridge?.proxy;
      if (proxy && !proxy._trackerHooked) {
        proxy.addEventListener('playing', () => this.sessionTracker?.setPlayback({ paused: false }));
        proxy.addEventListener('pause',   () => this.sessionTracker?.setPlayback({ paused: true }));
        proxy.addEventListener('seeked',  () => this.sessionTracker?.setPlayback({
          currentTime: proxy.currentTime,
          duration: proxy.duration,
        }));
        // Low-frequency position updates via proxy's internal timer — use a
        // throttled interval tied to this proxy so we don't leak.
        const poll = setInterval(() => {
          if (!this.vrBridge?.connected) { clearInterval(poll); return; }
          this.sessionTracker?.setPlayback({
            currentTime: proxy.currentTime,
            duration: proxy.duration,
          });
        }, 500);
        proxy._trackerHooked = true;
      }

      this.sessionTracker?.markScriptReady(
        this.funscriptEngine?.getActions?.()?.length || 0,
      );
      this._pushRemoteDeviceStatus();  // reuses the status pusher — also updates tracker
    } catch (err) {
      console.warn('[VR] Failed to load script:', err.message);
      // Failed before its script took the devices: the local video's delta.
      if (!vrSyncOffsetSettled && gen === this._vrMatchGeneration) this._settleVRVideoSyncOffset?.(null);
      // A no-op once setScript has settled this source.
      audienceNoScript('vr-load-failed', true);
      showToast(t('toast.vrScriptLoadFailed'), 'error');
      this.sessionTracker?.setState('error');
    }
  }

  // =========================================================================
  // Web Remote — phone controls, desktop drives devices
  // =========================================================================

  _wireSessionTracker() {
    // Last-wins mutex: when a new source starts (either Web Remote or VR
    // bridge), the tracker emits mutex-takeover with the evicted session's
    // source. We tear down that side's bridge so only one is driving devices.
    this.sessionTracker.addEventListener('mutex-takeover', (e) => {
      const { evicted, incoming } = e.detail || {};
      if (!evicted) return;

      const sourceLabel = (src) => src === 'web-remote' ? t('session.source.web-remote') : t('session.source.vr');
      showToast(
        t('toast.mutexTakeover', {
          incoming: sourceLabel(incoming?.source),
          evicted: sourceLabel(evicted.source),
        }),
        'info',
        4000,
      );

      if (evicted.source === 'vr') {
        // VR companion loses — stop its sync, disconnect the bridge so the
        // user reconnects from the VR panel deliberately.
        this._stopVRSync();
        try { this.vrBridge?.disconnect?.(); } catch { /* ignore */ }
      } else if (evicted.source === 'web-remote') {
        // Web remote loses — drop the proxy, stop the sync engines so we
        // aren't driving devices from a stale source. Leaving the observer
        // bridge up is fine; the phone can reconnect later.
        this._onRemotePhoneDisconnected(evicted.identifier);
      }
    });
  }

  _wireRemoteBridge() {
    if (!this.remoteBridge) return;

    this.remoteBridge.onPhoneConnected = (ip, videoId, videoPath) => {
      this._onRemotePhoneConnected(ip, videoId, videoPath).catch(err => {
        console.warn('[Remote] phone-connected handler failed:', err);
      });
    };
    this.remoteBridge.onPhoneReplaced = (oldIp, newIp) => {
      showToast(t('toast.remoteTakenOver', { ip: newIp }), 'info', 4000);
    };
    this.remoteBridge.onPhoneDisconnected = (ip) => {
      this._onRemotePhoneDisconnected(ip);
    };
    this.remoteBridge.onPhoneState = (state) => {
      this._remoteProxy?.updateState(state);
      this.sessionTracker?.setPlayback({
        currentTime: typeof state.at === 'number' ? state.at / 1000 : undefined,
        duration: state.duration,
        paused: state.paused,
      });
    };
    this.remoteBridge.onPhoneSeek = (atMs) => {
      this._remoteProxy?.seek(atMs);
      this.sessionTracker?.setPlayback({ currentTime: atMs / 1000 });
    };
    this.remoteBridge.onPhonePlay = () => {
      this._remoteProxy?.handlePlay();
      this.sessionTracker?.setPlayback({ paused: false });
    };
    this.remoteBridge.onPhonePause = () => {
      this._remoteProxy?.handlePause();
      this.sessionTracker?.setPlayback({ paused: true });
    };
    this.remoteBridge.onPhoneEnded = () => {
      this._remoteProxy?.handleEnded();
      this.sessionTracker?.setPlayback({ paused: true });
    };
    this.remoteBridge.onPhoneSwitchVariant = (label) => {
      this._handlePhoneSwitchVariant(label).catch(err => {
        console.warn('[Remote] switch-variant handler failed:', err);
      });
    };
    // Orgasm Switch remote trigger (SCOPE-web-remote-2.md F2) — routed
    // into the exact keyboard-X path so mode logic (hold vs press-to-
    // finish) lives in ONE place. State is re-broadcast from the
    // controller's activate/deactivate hooks, so the phone button stays
    // truthful regardless of which surface triggered the change.
    this.remoteBridge.onPhoneOrgasmHold = (active) => {
      this._onOrgasmHold(!!active);
    };
    // Edge Hold from the phone (next major): the keyboard-Z path, so hold
    // or toggle, the Edge pattern and X over Z apply as for the key. Its
    // state goes back as `edge-state` (_pushRemoteEdgeState).
    this.remoteBridge.onPhoneEdgeHold = (active) => {
      this._onEdgeHold(active === true);
    };
    // Per-device offset from the phone's sync pill (F4).
    this.remoteBridge.onPhoneSetOffset = (device, ms) => {
      this._applyRemoteOffset(device, ms);
    };
  }

  /**
   * Apply a phone-set per-device offset through the same persist + live
   * paths the Sync tab uses. Clamped — LAN WS input is untrusted.
   */
  _applyRemoteOffset(device, msRaw) {
    const ms = Math.max(-1000, Math.min(1000, Math.round(Number(msRaw) || 0)));
    switch (device) {
      case 'handy':
        this.settings.set('handy.defaultOffset', ms);
        this.settings.set('handy.defaultOffsetSource', 'user');
        if (this.handyManager?.connected) {
          Promise.resolve(this.handyManager.setOffset(ms)).catch(() => {});
        }
        break;
      case 'buttplug':
        this.settings.set('buttplug.defaultOffset', ms);
        this.settings.set('buttplug.defaultOffsetSource', 'user');
        this.buttplugSync?.setOffsetMs(ms);
        break;
      case 'tcode':
        this.settings.set('tcode.defaultOffset', ms);
        this.tcodeSync?.setOffsetMs(ms);
        break;
      case 'autoblow':
        this.settings.set('autoblow.offset', ms);
        // The Devices slider's call (connection-panel.js): the GLOBAL, sent
        // with this video's delta. It used to be `autoblowSync?.setOffsetMs?.`,
        // a method that never existed, so the optional chain did nothing and
        // the phone's slider only saved (FT-052; also in v0.9.2).
        if (this.autoblowManager?.connected) {
          Promise.resolve(this.autoblowManager.syncOffset(ms)).catch(() => {});
        }
        break;
      default:
        return; // unknown device key — ignore
    }
    // Rebroadcast so the phone slider reflects the applied (clamped) value.
    this._pushRemoteDeviceStatus();
  }

  /**
   * Tell the phone the Orgasm Switch's current state (F2): whether a
   * finisher script is configured (shows/hides the button), the mode,
   * and whether it's currently active.
   */
  _pushRemoteOrgasmState() {
    if (!this.remoteBridge?.connected) return;
    this.remoteBridge.sendToPhone({
      type: 'orgasm-state',
      configured: !!this.orgasmSwitch?.configured,
      active: !!this.orgasmSwitch?.active,
      mode: this.settings?.get?.('player.orgasmSwitchMode') === 'toggle' ? 'toggle' : 'hold',
    });
  }

  /**
   * Tell the phone Edge Hold's state (next major): whether Z is on and its
   * mode, so the phone's Edge button reads true whichever surface pressed
   * it. Sent on every change and with the device status.
   */
  _pushRemoteEdgeState() {
    if (!this.remoteBridge?.connected) return;
    this.remoteBridge.sendToPhone({
      type: 'edge-state',
      active: !!this._edgeActive,
      mode: this.settings?.get?.('player.edgeHoldMode') === 'toggle' ? 'toggle' : 'hold',
    });
  }

  /**
   * Phone tapped a variant in the player view. Translate the label into
   * the existing index-based `_switchVariant` flow — that path already
   * loads the script, reloads sync engines, re-uploads to Handy, and
   * (with the additions below) broadcasts `variant-changed` back to the
   * phone so the phone's chip / heatmap update only when the switch
   * actually completes.
   */
  async _handlePhoneSwitchVariant(label) {
    const variants = this._allVariantsWithManual || [];
    if (!variants.length) {
      console.warn('[Remote] switch-variant ignored — no variants loaded for current video');
      return;
    }
    const index = variants.findIndex(v => (v.label || '').trim() === label);
    if (index < 0) {
      console.warn('[Remote] switch-variant ignored — unknown label:', label);
      return;
    }
    await this._switchVariant(index);
  }

  /**
   * The variant a phone session starts on (E-09; also in v0.9.2): the pinned
   * one (`library.preferredVariants`), as a desktop open plays it. The phone
   * opened every video on its first script, its chip said so, and the desktop
   * drove the devices with that script while a desktop open started the
   * star. Only a variant the phone lists, so the chip can name what the
   * devices get: since FN-04 that list holds the hand-added variations too
   * (`_phoneVariantList`), so a pinned manual one starts the session; it
   * used to be the library scan's `variants` only. The desktop's
   * random-variant toggle beats a pin, so with it on the phone keeps the
   * first script, as before (it does not roll one).
   *
   * @returns {{index: number, path: string}|null} null: the video's own script
   */
  _phonePinnedVariant(video, videoPath) {
    const variants = this._phoneVariantList?.(video, videoPath)
      ?? (Array.isArray(video?.variants) ? video.variants : []);
    if (variants.length < 2) return null;
    if (this.settings?.get?.('player.randomVariantOnPlay') === true) return null;
    const index = pickVariantIndexOnLoad(variants, {
      preferredLabel: this._getPreferredVariantLabel?.(videoPath) || null,
    });
    const variant = index > 0 ? variants[index] : null;
    return variant?.path && variant.path !== video.funscriptPath ? { index, path: variant.path } : null;
  }

  /**
   * The variation list of a video a phone plays (FN-04, Dave 2026-11-16:
   * "yes variations should show on phone"): the same list, order and names
   * the phone itself was sent (library.js `_registerWithBackend`, through
   * variant-names.js `remoteVariantList`): the scan's / association's
   * entries, then the hand-added ones (`library.manualVariants`) under the
   * video's own path. A read only: no re-home and no write, so a phone
   * session never moves a stored variation.
   */
  _phoneVariantList(video, videoPath) {
    const manual = (this.settings?.get?.('library.manualVariants') || {})[videoPath] || [];
    const list = remoteVariantList(video, manual);
    if (list.length > 0 || !video?.funscriptPath) return list;
    // Nothing to choose: the phone video's own script is still its one
    // entry, so the desktop's chip names what plays (FN-03), not the file
    // this window's editor holds (`_updateVariantSelector`'s editor rule).
    const name = String(video.funscriptPath).split(/[\\/]/).pop();
    return [{ label: 'Default', path: video.funscriptPath, name, text: name.replace(/\.funscript$/i, ''), main: true }];
  }

  async _onRemotePhoneConnected(ip, videoId, videoPath) {
    console.log('[Remote] phone-connected', { ip, videoId, videoPath });

    // Tell the tracker — also triggers the mutex if VR was active.
    const currentSession = this.sessionTracker?.getSession();
    if (!currentSession || currentSession.source !== 'web-remote' || currentSession.identifier !== ip) {
      this.sessionTracker?.startSession('web-remote', ip);
    }
    // Taken AFTER startSession: a takeover of another phone runs
    // _onRemotePhoneDisconnected inside it. A disconnect from here on means
    // this phone let go mid-load: its teardown put the devices back on the
    // local player, so the load stops at its next await instead of undoing
    // that. It used to carry on and set `_remoteActive`, which left audience
    // rows Ready (green) on every later local video while no viewer was
    // ever played (#361 review, 2026-11-04).
    // A newer connect from the SAME phone (it picked another video before
    // this one was ready) supersedes this load too (FT-092, also in v0.9.2):
    // it skips startSession above, so the epoch alone never moved and both
    // loads ran to the end, the first one's uploads able to land last.
    const phoneEpoch = this._remotePhoneEpoch;
    const phoneLoad = this._remotePhoneLoadGen = (this._remotePhoneLoadGen || 0) + 1;
    const phoneGone = () => this._remotePhoneEpoch !== phoneEpoch || this._remotePhoneLoadGen !== phoneLoad;

    if (!videoPath) {
      console.warn('[Remote] no videoPath from backend — phone videoId', videoId, 'not in registry. Has the library scanned?');
      this.remoteBridge?.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.markScriptMissing();
      return;
    }

    // Per-video sync offset (#380): the phone's video is a library file, so
    // its own delta applies while the phone drives the devices. Set before
    // the first await; _onRemotePhoneDisconnected ends it.
    this._phoneSyncOffsetActive = true;
    this._phoneSyncOffsetPath = videoPath;
    this._applyVideoSyncOffset?.();

    // Pause the desktop player so we're not double-playing audio.
    const desktopVideo = this.videoPlayer?.video;
    if (desktopVideo && !desktopVideo.paused) {
      desktopVideo.pause();
      this._remotePausedDesktop = true;
    }

    // Look up the video object from the library to get its funscript.
    const video = this.library?._videosByPath?.get(videoPath);
    const displayName = (video?.name) || videoPath.split(/[\\/]/).pop();
    // Audience: the phone's video is a new source; viewers stop now and stay
    // stopped while the phone drives playback (#361 stopgap). It is a phone
    // source: never played by viewers, and it ends with the phone session
    // (_onRemotePhoneDisconnected). Settled as no script on every return
    // below that gets no script. There is no generation guard on this path;
    // the token is one.
    const audienceToken = this.audienceBridge?.beginSource({ title: displayName, player: SOURCE_PLAYER.PHONE }) ?? null;
    this.sessionTracker?.setVideo({
      name: displayName,
      videoId,
      videoPath,
      duration: video?.duration || 0,
    });

    // The script the session starts on: the video's own, else, for a video
    // whose only scripts are hand-added variations, the first of them (the
    // pinned one below wins), as the desktop opens it (FN-04 fix-up after
    // block F verify-1; also in v0.9.2: the phone said "No funscript" and
    // listed nothing while /api/remote/videos listed them).
    const ownScript = video?.hasFunscript && video.funscriptPath ? video.funscriptPath : null;
    const startScript = ownScript || (video ? this._phoneVariantList?.(video, videoPath)?.[0]?.path : null) || null;
    if (!video || !startScript) {
      this.audienceBridge?.setNoScript(audienceToken, { reason: 'remote-no-script' });
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.markScriptMissing();
      showToast(t('toast.remoteNoScript', { name: displayName }), 'info', 4000);
      return;
    }

    this.remoteBridge.sendToPhone({ type: 'script-loading', videoId });
    this.sessionTracker?.setState('preparing');

    // Custom routing is torn down below, where the phone's script takes the
    // engine, not here (C-06, 2026-11-06; probably also in v0.9.2): a read
    // that fails never takes it, so nothing at the session's end would put
    // this window's routing back (`_restoreLocalScriptAfterRemote` runs only
    // for a taken engine) and a routed local video played its main stroke
    // only until it was opened again.

    // Load funscript content + spin up the proxy + rebind sync engines.
    // The video's pinned variant plays, as a desktop open plays it (E-09).
    const pinned = this._phonePinnedVariant?.(video, videoPath) || null;
    let scriptPath = pinned ? pinned.path : startScript;
    let activeIdx = pinned ? pinned.index : 0;
    let content;
    try {
      content = await window.funsync.readFunscript(scriptPath);
    } catch { /* ignore */ }
    if (phoneGone()) return;
    if (!content && scriptPath !== startScript) {
      // The pinned file cannot be read now: the video's own script, as before.
      scriptPath = startScript;
      activeIdx = 0;
      try {
        content = await window.funsync.readFunscript(scriptPath);
      } catch { /* ignore */ }
      if (phoneGone()) return;
    }
    if (!content) {
      this.audienceBridge?.setNoScript(audienceToken, { reason: 'remote-read-failed', failed: true });
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      return;
    }

    try {
      const fsName = scriptPath.split(/[\\/]/).pop();
      this._stashLocalScriptBeforeRemote?.(); // R4-04
      // Throws on a script that is not a funscript, before the engine
      // changes: this window's routing and axes are still its own then.
      await this.funscriptEngine.loadContent(content, fsName);
      // The phone's script has the engine: tear down any lingering custom
      // routing from the desktop/VR video that was playing before the phone
      // took over. Same leak pattern as the VR-video-change and
      // local-video-change paths — without this, `_customRoutingActive=true`
      // plus stale CR1/CR2 axis assignments would filter non-L0 devices out
      // of the main stroke loop (single-axis plays on one device instead of
      // fanning out) and the previous video's routed scripts would keep
      // firing on their old axes. The session's end puts it back (R4-04).
      this._resetCustomRoutingState();
      this._clearLocalAxesForRemote?.();
      // Not this window's video's script: the editor keeps off it (R3-20).
      this._engineHeldByRemote = true;
      if (phoneGone()) return;
      // Built only when a viewer needs it.
      this.audienceBridge?.setScript(audienceToken, {
        content: () => this._audienceScriptContent(content),
        title: fsName,
      });

      // Populate the variant state for this phone-driven session so the
      // existing `_switchVariant(index)` flow works when the phone taps
      // a variant. Without this, `_currentVariants` stays empty and the
      // switch handler short-circuits with "no variants loaded". The
      // `_onPlayVideo` desktop path does the same; we mirror it here.
      // This window's video's list (and which one is on) is kept for when
      // the session ends (R4-04, `_restoreLocalScriptAfterRemote`); once per
      // session, while the list is still the local video's.
      if (this._variantsPhoneEpoch == null) {
        this._localVariantsBeforeRemote = {
          videoPath: this._currentVideoPath || null,
          variants: this._currentVariants,
          index: this._activeVariantIndex,
          path: this._activeVariantPath,
        };
      }
      // The phone video's own list, its hand-added variations included
      // (FN-04): the list the phone shows, so a pick there is found here.
      this._currentVariants = this._phoneVariantList?.(video, videoPath) ?? (video.variants || []);
      this._activeVariantIndex = activeIdx;
      this._activeVariantPath = scriptPath || null;
      // The list is this phone session's (see _switchVariant), and whose.
      this._variantsPhoneEpoch = phoneEpoch;
      this._variantsPhoneVideoPath = videoPath;
      this._updateVariantSelector();
      // Tell the phone which variant is active so its chip starts in
      // the right state (the pinned one, E-09). Sent only when the video
      // has multiple variants — single-variant videos don't render a chip.
      // Trimmed: the phone's list carries the backend's trimmed labels.
      const initialVariant = this._currentVariants[activeIdx];
      if (this._currentVariants.length > 1 && initialVariant?.label) {
        this.remoteBridge.sendToPhone({
          type: 'variant-changed',
          label: String(initialVariant.label).trim(),
        });
      }

      if (!this._remoteProxy) this._remoteProxy = new RemotePlaybackProxy();
      this._remoteProxy.reset();
      const proxyPlayer = this._remoteProxy.asVideoPlayerWrapper();

      // Stop any current sync, rebind to the proxy, restart.
      if (this.syncEngine?._active) this.syncEngine.stop();
      if (this.buttplugSync?._active) this.buttplugSync.stop();
      if (this.tcodeSync?._active) this.tcodeSync.stop();
      if (this.autoblowSync?._active) this.autoblowSync.stop();

      if (this.buttplugSync && this.buttplugManager?.connected) {
        this.buttplugSync.player = proxyPlayer;
        this.buttplugSync.reloadActions();
        this.buttplugSync.start();
      }
      if (this.tcodeSync && this.tcodeManager?.connected) {
        this.tcodeSync.player = proxyPlayer;
        this.tcodeSync.reloadActions();
        this.tcodeSync.start();
      }
      // The cloud uploads carry the output limits, the gap filler and the
      // Range Extender, as a local open's do, with the filler run to the
      // PHONE's video's end, not this window's (FT-113; also in v0.9.2:
      // the Handy got only the invert, the Autoblow the raw script).
      if (this.handyManager?.connected) {
        await this.handyManager.uploadAndSetScript(this._handyUploadContent(content, this._handyInverted(), {
          durationMs: this._sessionTimelineMs(this._remoteProxy, video),
        }));
        if (phoneGone()) return;
        if (this.syncEngine) {
          this.syncEngine.player = proxyPlayer;
          this.syncEngine._scriptReady = true;
          this.syncEngine.start();
        }
      }
      if (this.autoblowManager?.connected && this.autoblowSync) {
        await this.autoblowSync.uploadScript(this._autoblowUploadContent(content, {
          durationMs: this._sessionTimelineMs(this._remoteProxy, video),
        }));
        if (phoneGone()) return;
        this.autoblowSync.player = proxyPlayer;
        this.autoblowSync.start();
      }

      this._remoteActive = true;
      this._refreshLoopVideoVisibility?.();
      const actionCount = this.funscriptEngine.getActions().length;
      this.remoteBridge.sendToPhone({
        type: 'script-ready',
        videoId,
        actionCount,
      });
      this.sessionTracker?.markScriptReady(actionCount);
      this._pushRemoteDeviceStatus();

      showToast(t('toast.remoteConnected', { ip }), 'info', 3500);
    } catch (err) {
      console.warn('[Remote] failed to prepare script:', err);
      this.audienceBridge?.setNoScript(audienceToken, { reason: 'remote-load-failed', failed: true });
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.setState('error');
    }
  }

  _onRemotePhoneDisconnected(_ip) {
    // A phone load still in flight stops at its next await (see
    // _onRemotePhoneConnected), and a variant list it filled now belongs to
    // a session that has ended (see _switchVariant).
    this._remotePhoneEpoch++;
    // That list goes back to this window's video's own NOW (FT-092), not
    // after the script restore's first await: a V press or a pick from the
    // variant menu in between, or under a headset that took over, loaded
    // the phone video's variant onto the streamer's own devices.
    this._givePhoneVariantListBack?.();
    // The phone video's per-video sync offset (#380) ends with the session.
    if (this._phoneSyncOffsetActive) {
      this._phoneSyncOffsetActive = false;
      this._phoneSyncOffsetPath = null;
      this._applyVideoSyncOffset?.();
    }
    // Audience: the phone's source ends with its session, so a local play
    // that follows can never start viewers on the phone video's script, nor
    // can a phone load still in flight set it up afterwards (#361 review).
    this.audienceBridge?.endSource(SOURCE_PLAYER.PHONE, { reason: 'remote-ended' });
    this._remoteActive = false;
    this._refreshLoopVideoVisibility?.();

    // SAFETY (F2): a dead phone must never leave a hold-mode finisher
    // running — the hold's release lives on the phone that just vanished.
    // Toggle mode is a deliberate start/stop, so it survives disconnects.
    if (this.orgasmSwitch?.active
        && (this.settings?.get?.('player.orgasmSwitchMode') || 'hold') === 'hold') {
      try { this.orgasmSwitch.deactivate(); } catch { /* best-effort */ }
    }
    // The same for a held Edge (next major: the phone has an Edge button).
    if (this._edgeActive
        && (this.settings?.get?.('player.edgeHoldMode') || 'hold') === 'hold') {
      try { this._onEdgeHold(false); } catch { /* best-effort */ }
    }

    // Stop all device sync engines and rebind to the local player. Which
    // ones ran is kept: a session that never took the engine gives them
    // back to this window's script (`_resumeLocalSyncAfterRemote`).
    this._noteSyncStoppedByRemoteTeardown?.();
    if (this.syncEngine?._active) this.syncEngine.stop();
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    if (this.handyManager?.connected) this.handyManager.hsspStop();
    if (this.buttplugManager?.connected) this.buttplugManager.stopAll();

    const localPlayer = this.videoPlayer;
    if (this.buttplugSync) this.buttplugSync.player = localPlayer;
    if (this.tcodeSync) this.tcodeSync.player = localPlayer;
    if (this.syncEngine) this.syncEngine.player = localPlayer;
    if (this.autoblowSync) this.autoblowSync.player = localPlayer;

    this._remoteProxy?.reset();
    this._remotePausedDesktop = false;

    // End the tracker's session ONLY if the remote was the active one —
    // mutex takeover may have already replaced it with VR.
    const cur = this.sessionTracker?.getSession();
    if (cur && cur.source === 'web-remote') {
      this.sessionTracker?.endSession();
    }

    showToast(t('toast.remoteDisconnected'), 'info', 2500);
    // The engine still holds the PHONE video's script: this window's video
    // gets its own back, or none (R4-04).
    this._restoreLocalScriptAfterRemote?.()?.catch((err) => console.warn('[Remote] restoring this window\'s script failed:', err?.message || err));
  }

  /**
   * Called right before a phone or VR session loads ITS script into the
   * shared engine (R4-04): what the engine held for this window's video, so
   * the session's end can put it back when it cannot be read again (a
   * dropped script has no path). Only the first remote load after a local
   * one: later ones would stash the remote's own script.
   */
  _stashLocalScriptBeforeRemote() {
    if (this._engineHeldByRemote === true) return;
    const engine = this.funscriptEngine;
    const raw = engine?.isLoaded ? (engine.getRawContent?.() || null) : null;
    // The path too: a variant tapped on the phone sets `_currentFunscriptPath`
    // to the PHONE video's variant file (`_switchVariant`).
    this._localScriptBeforeRemote = { gen: this._videoLoadGen, raw, path: this._currentFunscriptPath || null };
  }

  /**
   * The phone's session has ended (FT-092; also in v0.9.2): a variant list
   * it filled (`_variantsPhoneEpoch`) is this window's video's own again, the
   * one kept when the phone took over (R4-04), or none when this window has
   * since moved to another video. Synchronous, so nothing can pick a phone
   * variant after the phone has gone. Nothing is read or written; a no-op
   * when the list is already this window's.
   *
   * @returns {boolean} whether a phone list was given back
   */
  _givePhoneVariantListBack() {
    if (this._variantsPhoneEpoch == null) return false;
    const saved = this._localVariantsBeforeRemote;
    this._localVariantsBeforeRemote = null;
    const own = saved && saved.videoPath === (this._currentVideoPath || null) ? saved : null;
    this._currentVariants = own?.variants || [];
    this._activeVariantIndex = own?.index || 0;
    this._activeVariantPath = own?.path || null;
    this._variantsPhoneEpoch = null;
    this._variantsPhoneVideoPath = null;
    this._updateVariantSelector?.();
    return true;
  }

  /**
   * A phone or VR session's script takes the devices (R4 fix-up, real-app
   * verifier 1; also in v0.9.2): this window's video's own axis feeds come
   * off both engines, its companion files (`.pitch` / `.roll` / `.twist` /
   * `.vib`…), the axes embedded in its main script and the Buttplug vibe
   * script. Only custom routing was cleared (`_resetCustomRoutingState`), so
   * on T-Code / Buttplug the phone's main stroke played with the LOCAL
   * video's R0 / R1 / R2 / vibe. `_currentMultiAxis` stays: it is still this
   * video's (the editor's script list reads it), and the session's end puts
   * the files back from it (`_restoreLocalScriptAfterRemote`). Nothing is
   * read or written here.
   */
  _clearLocalAxesForRemote() {
    if (this.buttplugSync) {
      this.buttplugSync.setVibrationActions?.(null);
      this.buttplugSync.clearAxisActions?.();
      this.connectionPanel?.updateVibControlState?.();
    }
    this.tcodeSync?.clearAxisActions?.();
    this._embeddedAxisTcodes = new Set();
  }

  /**
   * A phone or VR session has ended (R4-04, probably also in v0.9.2): the
   * shared engine still held THAT video's script. The teardown only put the
   * device engines back on this window's player, so the local video (still
   * loaded, paused) showed the phone's heatmap and, on Play, drove the
   * devices with the phone video's script until another video or script
   * was loaded. Now this window's video takes its own script back: the one
   * it was playing (`_currentFunscriptPath`, its active variant), with its
   * embedded axes, its custom routing and its variant list; or the engine is
   * emptied when it has none.
   *
   * Nothing is written. The editor (R3-20) kept off the remote's script and
   * still holds this video's: whatever it holds stays, unsaved edits and undo
   * history included, and when it holds unsaved edits on this script the
   * engine takes those, as local editing pushes them, rather than the file.
   * A session starting meanwhile (a takeover runs this inside the old
   * session's teardown, before the new one is recorded) or a local load
   * wins, and this stops.
   *
   * @returns {Promise<boolean>} whether the engine was given back or emptied
   */
  async _restoreLocalScriptAfterRemote() {
    if (this._engineHeldByRemote !== true) {
      // The session never took the engine (its script could not be read, or
      // it had none, or the headset link dropped first), but its teardown
      // still stopped every sync engine. Nothing restarted them: a local
      // Play drove no device until the video was opened again (block C
      // verifier 2; also in v0.9.2). The engine still holds this window's
      // script, so the engines start again on it, as a load starts them.
      await this._resumeLocalSyncAfterRemote?.();
      // Audience viewers too: the room was left on "no script" (see
      // _restoreLocalAudienceSource).
      this._restoreLocalAudienceSource?.();
      return false;
    }
    const gen = this._videoLoadGen;
    const superseded = () => this._videoLoadGen !== gen
      || this._engineHeldByRemote !== true
      || this._remoteActive === true
      || this._phoneSyncOffsetActive === true
      || !!this.sessionTracker?.getSession?.();
    // Look once the teardown that called this has finished: a takeover
    // records its new session only after the old one's teardown returns.
    await Promise.resolve();
    if (superseded()) return false;
    const stash = this._localScriptBeforeRemote?.gen === gen ? this._localScriptBeforeRemote : null;
    this._localScriptBeforeRemote = null;
    // The load below starts the engines itself.
    this._syncStoppedByRemote = null;

    // The variant list the phone put up goes back to this video's own. The
    // phone's teardown already did (FT-092); a no-op then.
    this._givePhoneVariantListBack?.();

    const hasVideo = !!this._currentVideoName;
    // This video's own script path from before the session (a phone variant
    // switch points `_currentFunscriptPath` at the phone video's file).
    const ownPath = stash ? stash.path : (this._currentFunscriptPath || null);
    const scriptPath = hasVideo ? ownPath : null;
    // A script file to read again. loadFunscript falls back to the VIDEO's
    // path for a dropped script with no path of its own: never read that.
    const onDisk = !!scriptPath && scriptPath !== this._currentVideoPath && /\.funscript$/i.test(scriptPath);
    const ed = this.scriptEditor;
    const es = ed?.editableScript;
    const editorHas = (es?.actionCount || 0) > 0;
    const editorDirty = ed?.hasUnsavedChanges?.() === true;
    // The editor is on this script: its file, or, for a pathless drop, the
    // `<video>.funscript` loadFunscript pointed it at (not a phone variant
    // `_switchVariant` loaded into an open editor).
    const sidecar = this._currentVideoPath ? this._currentVideoPath.replace(/\.[^/.]+$/, '') + '.funscript' : null; // loadFunscript's own derivation
    const editorOnIt = hasVideo && editorHas && ed._funscriptPath === (onDisk ? scriptPath : sidecar);
    let content = null;
    if (editorOnIt && editorDirty) {
      content = es.toFunscriptJSON();
    } else if (onDisk) {
      try { content = await window.funsync.readFunscript(scriptPath); } catch { content = null; }
      if (superseded()) return false;
    }
    if (!content && hasVideo && stash?.raw) content = stash.raw;
    if (!content && editorOnIt) content = es.toFunscriptJSON();

    if (!content) {
      // This video has no script (or it cannot be read now): nothing drives.
      this.funscriptEngine.clear();
      this._engineHeldByRemote = false;
      this._currentFunscriptPath = scriptPath;
      this.handyHdspSync?.setActions?.([]);
      this.progressBar?.clearHeatmap?.();
      this._feedInlineViz?.();
      this.progressBar?.setGaps?.(null);
      this.progressBar?.setMarkers?.({ chapters: [], bookmarks: [] });
      const fsBadge = document.getElementById('funscript-badge');
      if (fsBadge) {
        fsBadge.hidden = true;
        fsBadge.innerHTML = '';
      }
      if (onDisk) showToast(t('toast.funscriptUnreadable', { name: scriptPath.split(/[\\/]/).pop() }), 'warn', 5000);
      // Companion files only (no main script): they went off the devices
      // with the session (`_clearLocalAxesForRemote`) and come back.
      if (hasVideo && this._currentMultiAxis) await this._loadMultiAxisScripts(this._currentMultiAxis);
      return true;
    }

    // Custom routing went with the session (`_resetCustomRoutingState`, and
    // with it every axis file): put this video's back first, as a click
    // loads it, before the main script.
    const libVideo = this._currentVideoPath ? this.library?.getVideoByPath?.(this._currentVideoPath) : null;
    let routed = false;
    if (Array.isArray(libVideo?._customRouting) && libVideo._customRouting.length > 0 && !this._customRoutingActive) {
      routed = true;
      this._customRoutingActive = true;
      await this._loadCustomRouting(libVideo._customRouting, this._currentVideoPath);
      if (superseded()) return false;
      if (libVideo._multiAxis) this._loadMultiAxisScripts(libVideo._multiAxis);
    }
    const name = onDisk
      ? scriptPath.split(/[\\/]/).pop()
      : `${(this._currentVideoName || 'script').replace(/\.[^/.]+$/, '')}.funscript`;
    await this.loadFunscript({
      name,
      textContent: content,
      ...(onDisk ? { path: scriptPath } : {}),
      _keepEditor: editorHas || editorDirty,
    });
    // loadFunscript fed the main script's embedded axes again; this video's
    // companion files went off the devices with the session too
    // (`_clearLocalAxesForRemote`) and come back the same way a load feeds
    // them. A routed video had them put back above.
    if (!routed && this._currentMultiAxis && this._videoLoadGen === gen) {
      await this._loadMultiAxisScripts(this._currentMultiAxis);
    }
    return true;
  }

  /**
   * A phone or VR teardown is about to stop the sync engines: note which
   * ones run, for `_resumeLocalSyncAfterRemote`. Merged with a note already
   * taken for this video, because a headset video change stops them first
   * (`_stopVRSync(true)`) and the session's end finds them stopped.
   */
  _noteSyncStoppedByRemoteTeardown() {
    const gen = this._videoLoadGen;
    const prev = this._syncStoppedByRemote?.gen === gen ? this._syncStoppedByRemote : null;
    this._syncStoppedByRemote = {
      gen,
      handy: !!(prev?.handy || this.syncEngine?._active),
      buttplug: !!(prev?.buttplug || this.buttplugSync?._active),
      tcode: !!(prev?.tcode || this.tcodeSync?._active),
      autoblow: !!(prev?.autoblow || this.autoblowSync?._active),
    };
  }

  /**
   * A phone or VR session that never took the engine has ended (block C
   * fix-up 2026-11-06, real-app verifier 2; also in v0.9.2): the phone's
   * script could not be read, the headset's video had none, or the link
   * dropped first. Its teardown still stopped every sync engine, and the
   * restore (R4-04) returned at once, so a local Play drove nothing until
   * the video was opened again. The engines that ran start again on the
   * script the engine still holds, this window's own; nothing is read, and
   * nothing uploaded but the Autoblow's script, which its stop() drops. A
   * session starting meanwhile, or a local load, wins.
   *
   * @returns {Promise<boolean>} whether any engine was started again
   */
  /**
   * A phone or headset session ended before its script took the engine
   * (verify-2, 2026-11-07; new since v0.9.2). Its end (`endSource`) left the
   * Audience room on "no script", titled with the session's video, while
   * this window's video and its script were still here, and nothing gave
   * viewers that script back: a local Play started the streamer's own
   * devices and no viewer until another video was opened. R4-04 covered
   * only a session that took the engine (its restore loads the script, and
   * the load begins a source). Viewers now get this window's script as a
   * LOCAL source, set up and played when this window plays, as a load gives
   * it. Only while the room is still on the source that end made, and no
   * session or load came since. Nothing is read or written.
   *
   * @returns {boolean} whether a source was begun
   */
  _restoreLocalAudienceSource() {
    const bridge = this.audienceBridge;
    if (!bridge) return false;
    if (this._engineHeldByRemote === true || this._remoteActive || this._vrPlayerRef) return false;
    if (this._phoneSyncOffsetActive === true || this.sessionTracker?.getSession?.()) return false;
    const src = bridge.source;
    if (src?.player !== SOURCE_PLAYER.LOCAL || (src.reason !== 'remote-ended' && src.reason !== 'vr-ended')) return false;
    if (!this._currentVideoPath || !this.funscriptEngine?.isLoaded) return false;
    const raw = this.funscriptEngine.getRawContent?.() || null;
    if (!raw) return false;
    const own = this._currentFunscriptPath && this._currentFunscriptPath !== this._currentVideoPath
      ? this._currentFunscriptPath
      : `${(this._currentVideoName || 'script').replace(/\.[^/.]+$/, '')}.funscript`;
    const title = own.split(/[\\/]/).pop();
    const token = bridge.beginSource({ title, player: SOURCE_PLAYER.LOCAL });
    bridge.setScript(token, { content: () => this._audienceScriptContent(raw), title });
    return true;
  }

  async _resumeLocalSyncAfterRemote() {
    const gen = this._videoLoadGen;
    const superseded = () => this._videoLoadGen !== gen
      || this._engineHeldByRemote === true
      || this._remoteActive === true
      || this._phoneSyncOffsetActive === true
      || !!this.sessionTracker?.getSession?.();
    // As the restore: look once the teardown that called this has finished.
    await Promise.resolve();
    const ran = this._syncStoppedByRemote?.gen === gen ? this._syncStoppedByRemote : null;
    if (superseded()) return false;
    this._syncStoppedByRemote = null;
    if (!ran) return false;
    // The Handy still holds this window's script (the session uploaded
    // none); start() re-anchors on the next play.
    if (ran.handy && this.handyManager?.connected && this.syncEngine && !this.syncEngine._active) {
      this.syncEngine.start();
    }
    if (ran.buttplug) this._tryStartButtplugSync();
    if (ran.tcode) this._tryStartTCodeSync();
    if (ran.autoblow) await this._tryStartAutoblowSync();
    return ran.handy || ran.buttplug || ran.tcode || ran.autoblow;
  }

  _pushRemoteDeviceStatus() {
    // Build an actual device list, not just four transport booleans —
    // Buttplug's `connected` flag means "connected to Intiface", which
    // stays true even when zero devices are paired; the phone was
    // rendering "Connected: Buttplug" with no actual hardware present.
    const devices = [];

    // Per-kind offsets included so the phone's sync-pill sliders (F4)
    // seed from the live values and reflect desktop-side changes.
    const offsetFor = (kind) => {
      const key = kind === 'autoblow' ? 'autoblow.offset' : `${kind}.defaultOffset`;
      const v = Number(this.settings?.get?.(key));
      return Number.isFinite(v) ? v : 0;
    };
    if (this.handyManager?.connected) {
      devices.push({ kind: 'handy', label: 'The Handy', offsetMs: offsetFor('handy') });
    }
    if (this.buttplugManager?.connected) {
      for (const d of this.buttplugManager.devices || []) {
        devices.push({ kind: 'buttplug', label: d.name, offsetMs: offsetFor('buttplug') });
      }
    }
    if (this.tcodeManager?.connected) {
      // The link's own endpoint, as the desktop names the device (E-05; also
      // in v0.9.2): COM port, host:port or the WebSocket URL. `portPath` is
      // serial-only, so a UDP or WebSocket device read "TCode (serial)".
      const port = this.tcodeManager.endpoint || this.tcodeManager.portPath || 'serial';
      devices.push({ kind: 'tcode', label: `TCode (${port})`, offsetMs: offsetFor('tcode') });
    }
    if (this.autoblowManager?.connected) {
      const ab = this.autoblowManager.isUltra ? 'Autoblow Ultra' : 'VacuGlide 2';
      devices.push({ kind: 'autoblow', label: ab, offsetMs: offsetFor('autoblow') });
    }

    // Tracker still expects the four-boolean summary. Derive it from the
    // device list so "Buttplug" only reads true when there's at least one
    // actual paired device under it — matches the phone pill semantics.
    const handy    = devices.some(d => d.kind === 'handy');
    const buttplug = devices.some(d => d.kind === 'buttplug');
    const tcode    = devices.some(d => d.kind === 'tcode');
    const autoblow = devices.some(d => d.kind === 'autoblow');
    this.sessionTracker?.setDeviceStatus({ handy, buttplug, tcode, autoblow });

    if (!this.remoteBridge?.connected) return;
    this.remoteBridge.sendToPhone({
      type: 'device-status',
      // Detailed list for the phone's "Connected devices" dropdown.
      devices,
      // Legacy boolean fields kept for backward compat with any cached
      // older phone client that reconnects before refreshing.
      handy: handy ? 'connected' : 'disconnected',
      buttplug: buttplug ? 'connected' : 'disconnected',
      tcode: tcode ? 'connected' : 'disconnected',
      autoblow: autoblow ? 'connected' : 'disconnected',
    });
    // Piggyback the Orgasm Switch state (F2) — sent whenever device
    // status refreshes so a newly-connected phone learns availability.
    this._pushRemoteOrgasmState();
    this._pushRemoteEdgeState?.(); // and Edge Hold's (next major)
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.keepVideoSyncOffset] — the next VR video
   *   (`_onVRVideoChanged`) settles the per-video sync offset itself, so
   *   the local video's is not put back in between (one update, not two
   *   unordered ones).
   */
  _stopVRSync({ keepVideoSyncOffset = false } = {}) {
    // Audience: a VR video's source ends with the VR session (disconnect,
    // mutex eviction, or the next VR video, which begins its own after
    // this), so a local play afterwards can never start viewers on the
    // headset's script. A no-op when the room's source is not VR's, which
    // includes the phone having taken over (#361 review).
    this.audienceBridge?.endSource(SOURCE_PLAYER.VR, { reason: 'vr-ended' });

    // The headset's per-video sync offset (#380) ends with its video; the
    // local video's (or the phone's) applies again. Before the early return
    // below, so a phone takeover cannot leave the VR path behind.
    if (this._vrSyncOffsetActive && !keepVideoSyncOffset) this._settleVRVideoSyncOffset?.(null);

    // A full stop (disconnect, phone takeover) also ends a headset video
    // still loading: its _onVRVideoChanged sees a newer generation at its
    // next check and returns, so it cannot put its delta on the devices
    // after the session is over, where every later local video would
    // inherit it (verify 2026-11-04). The next VR video's own stop
    // (keepVideoSyncOffset) runs after that video took its generation.
    if (!keepVideoSyncOffset) this._vrMatchGeneration = (this._vrMatchGeneration || 0) + 1;

    // Mutex-takeover race guard: if a non-VR session is already active
    // (web-remote took over), this _stopVRSync invocation is the
    // delayed onDisconnect event firing from the VR bridge AFTER the
    // remote session bound sync engines to its proxy. Running the full
    // teardown here would stop those engines and rebind them to the
    // local video player — clobbering the live remote session. The VR
    // side's state was already cleaned up synchronously by the mutex
    // handler; nothing left for us to do.
    if (this._remoteActive) {
      // Still clear the tracker-hook flag so the next VR video load
      // re-initialises the proxy listeners.
      if (this.vrBridge?.proxy) this.vrBridge.proxy._trackerHooked = false;
      return;
    }

    // Which engines ran is kept, as in `_onRemotePhoneDisconnected`.
    this._noteSyncStoppedByRemoteTeardown?.();
    if (this.syncEngine?._active) this.syncEngine.stop();
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    if (this.handyManager?.connected) this.handyManager.hsspStop();
    if (this.buttplugManager?.connected) this.buttplugManager.stopAll();

    // Tear down custom routing so the next VR video — routed or not —
    // starts with a clean slate. Without this, devices assigned to
    // CR1/CR2 on the previous video stay assigned and either:
    //   - replay the previous routed script (when VR→VR, routed→unrouted)
    //   - get filtered out of the main-stroke fan-out, leaving only the
    //     L0-assigned device firing (single-axis on a later video).
    // Only while a remote's script holds the engine: the routing is then
    // the headset video's (or already gone). Otherwise it is still this
    // window's video's own, which no headset video took, and the session's
    // end would not put it back (C-06): a headset video with no script, or
    // a link that dropped before any, cleared it for good.
    if (this._engineHeldByRemote === true) this._resetCustomRoutingState();

    // Clear the tracker-hooked flag on the VR proxy so the session-
    // tracker poll + listeners re-initialise on next VR video load. The
    // VR proxy is a long-lived singleton (not re-created per video), so
    // without clearing this flag the flag would stay true after a
    // disconnect/reconnect cycle — the poll that self-clears on
    // disconnect would never restart, and session tracker would stop
    // getting playback updates.
    if (this.vrBridge?.proxy) this.vrBridge.proxy._trackerHooked = false;

    // Restore sync engines to local video player (so local playback works after VR disconnect)
    if (this._vrPlayerRef) {
      const localPlayer = this.videoPlayer;
      if (this.buttplugSync) this.buttplugSync.player = localPlayer;
      if (this.tcodeSync) this.tcodeSync.player = localPlayer;
      if (this.syncEngine) this.syncEngine.player = localPlayer;
      if (this.autoblowSync) this.autoblowSync.player = localPlayer;
      this._vrPlayerRef = null;
    }

    // End tracker's session if VR was driving; mutex may have already
    // replaced it with Web Remote, in which case leave the current alone.
    const cur = this.sessionTracker?.getSession();
    if (cur && cur.source === 'vr') {
      this.sessionTracker?.endSession();
    }

    // The session is over (not the next headset video, which loads its own):
    // the engine still holds the headset video's script, and this window's
    // video gets its own back, or none (R4-04).
    if (!keepVideoSyncOffset) {
      this._restoreLocalScriptAfterRemote?.()?.catch((err) => console.warn('[VR] restoring this window\'s script failed:', err?.message || err));
    }
  }

  /**
   * Keep the nav-bar VR button's tooltip in sync with bridge state.
   * Polled every 2s (the bridge doesn't emit events for the silent-
   * failure "connected but no packets" transition, so polling is the
   * cheapest way to surface live state). Three states from the bridge:
   * receiving (green), waiting (yellow — silent-failure mode),
   * disconnected (red).
   */
  _updateVRTooltip() {
    if (!this.navBar || !this.vrBridge) return;
    const state = this.vrBridge.linkState; // 'receiving' | 'waiting' | 'disconnected'
    if (state === 'receiving') {
      this.navBar.setVRTooltip('connected', { host: this.vrBridge.host });
      this.navBar.setVRLinkState('connected');
    } else if (state === 'waiting') {
      this.navBar.setVRTooltip('waiting', { host: this.vrBridge.host });
      this.navBar.setVRLinkState('waiting');
    } else {
      this.navBar.setVRTooltip('disconnected');
      this.navBar.setVRLinkState('disconnected');
    }
  }

  /**
   * Apply the VR offset preset for the connected player + measured
   * transport quality. Respects the source-tag: never overwrites a
   * user-tuned offset, only refreshes the value when the preset key
   * changed (e.g. user moved from cabled link to WiFi).
   *
   * Called on VR connect after a short delay so we have a few packet
   * arrivals to compute jitter from. Quiet on no-op (same preset, or
   * user-tuned).
   */
  async _maybeApplyVrOffsetPreset() {
    if (!this.vrBridge?.connected) return;
    const playerType = this.vrBridge._playerType;
    if (!playerType) return;

    const { lookupVrPreset, decidePresetApply } = await import('./auto-offset.js');
    const jitter = this.vrBridge.getNetworkJitterMs?.() ?? 30; // sane default
    const preset = lookupVrPreset(playerType, jitter);
    if (!preset) return;

    const decision = decidePresetApply(
      {
        source: this.settings.get('vr.offsetSource'),
        presetKey: this.settings.get('vr.offsetPresetKey'),
        value: this.settings.get('vr.offset'),
      },
      preset,
    );

    if (!decision.apply) {
      console.log(`[AutoOffset] VR preset skipped (${decision.reason})`);
      return;
    }

    this.settings.set('vr.offset', preset.value);
    this.settings.set('vr.offsetSource', 'preset');
    this.settings.set('vr.offsetPresetKey', preset.key);
    if (this.vrBridge.proxy?.setOffset) this.vrBridge.proxy.setOffset(preset.value);
    console.log(`[AutoOffset] Applied VR preset ${preset.key} = ${preset.value}ms`);
  }

  /**
   * The app's VR bridge callbacks. A method rather than inline in init so a
   * test can drive the REAL wiring (as with _dragDropOptions).
   *
   * Every successful connect arms the quiet-endpoint retry, whoever made it:
   * the VR modal's Connect, the saved host at startup, the toast's Try
   * again, or the activity poll. Only the poll's activity branch used to set
   * `_vrEverConnected`, so a manual, saved-host or PCVR (loopback, which the
   * backend never records as activity) connection was never re-dialed after
   * a drop (V19). A deliberate Disconnect disarms it, or the retry would
   * undo the user's choice two seconds later; the mutex takeover goes
   * through the same disconnect() and means the same thing.
   */
  _wireVRBridgeCallbacks() {
    const prevVrConnect = this.vrBridge.onConnect;
    this.vrBridge.onConnect = () => {
      if (prevVrConnect) prevVrConnect();
      this._vrEverConnected = true;   // enables the quiet-endpoint retry
      // The backoff reset, the connected / reconnected toast and the saved
      // host wait for the link's FIRST PACKET (onFirstPacket below): a TCP
      // connect only proves something accepted on the port. A host that
      // accepts and never sends used to reset the backoff, toast
      // "reconnected" and be saved here, then drop at the 8 s watchdog and
      // be re-dialed 2 s later, every ~10 s for ever (FT-054; also in v0.9.2).
      // Activity older than this is accounted for (_pollVRActivity, V21).
      this._vrLastConnectAtMs = Date.now();
      this._updateDeviceIndicators();
      this.navBar?.setVRConnected(true);
      // Any timestamp-server hint toast on screen is now obsolete: that
      // hint is about a refused dial, and this one was accepted.
      this._dismissTimestampServerHint();
      this._vrTimestampHintShown = false;
      // Auto-apply the per-player + per-transport offset preset for
      // the VR proxy (the time-shift that compensates for VR display
      // lag). Defers to a slight delay so we have a few packet
      // arrivals to compute jitter from. NEVER overwrites a
      // user-tuned value.
      setTimeout(() => this._maybeApplyVrOffsetPreset(), 3000);
    };

    // The link's first state packet: a working link (FT-054).
    const prevVrFirstPacket = this.vrBridge.onFirstPacket;
    this.vrBridge.onFirstPacket = () => {
      if (prevVrFirstPacket) prevVrFirstPacket();
      this._vrPollFailedAttempts = 0; // a working link resets the backoff
      this._vrSilentLinks = 0;
      // Remember the last WORKING Quest host/port so we can auto-
      // reconnect on next app launch without waiting for HereSphere
      // to re-fetch a scene from the backend (which is the only path
      // that repopulates the in-memory _vr_activity record). A host that
      // accepted and never sent is not one (it would replace a good one).
      this.settings.set('vr.lastHost', this.vrBridge._host);
      this.settings.set('vr.lastPort', this.vrBridge._port);
      this.settings.set('vr.lastPlayerType', this.vrBridge._playerType);
      // The toast the dial that made this link asked for (_announceVRLink).
      const toastKey = this._vrLinkToast;
      this._vrLinkToast = null;
      if (toastKey) showToast(t(toastKey), 'info', 3000);
    };

    const prevVrDisconnect = this.vrBridge.onDisconnect;
    this.vrBridge.onDisconnect = () => {
      if (prevVrDisconnect) prevVrDisconnect();
      // A link that ends before its first packet announces nothing.
      this._vrLinkToast = null;
      // Read from the bridge, not an argument: the VR modal wraps this
      // callback while it is open and forwards no arguments.
      if (this.vrBridge._intentionalDisconnect) {
        this._vrEverConnected = false;
        // Nor may a scene request from before the click undo it (V21);
        // a new one, the user picking a video in the headset, still can.
        this._vrUserDisconnectAtMs = Date.now();
      } else if (!this.vrBridge.received) {
        // It accepted and never sent a packet (watchdog or close): a failed
        // attempt, timed from now, not from its dial 8 s ago (FT-054).
        this._vrPollFailedAttempts = (this._vrPollFailedAttempts || 0) + 1;
        this._vrSilentLinks = (this._vrSilentLinks || 0) + 1;
        this._lastVrRetryTime = performance.now();
      }
      // Always tear down VR sync on disconnect, intentional or not.
      // Without this, sync engines stay bound to the dead VR proxy and
      // local playback after a VR disconnect gets no script events —
      // the local <video>'s play/pause/seeked events reach nothing.
      // Auto-reconnect doesn't need the old state: _onVRVideoChanged
      // runs _stopVRSync() again before re-binding to the new proxy,
      // so re-setup is always from scratch anyway.
      this._stopVRSync();
      this._updateDeviceIndicators();
      this.navBar?.setVRConnected(false);
    };

    this.vrBridge.onVideoChanged = (normalizedName, rawPath) => {
      this._onVRVideoChanged(normalizedName, rawPath);
    };
  }

  /**
   * Try a direct connect to the saved Quest host from a previous session.
   * Called once at startup. If HereSphere is still running from before
   * we restarted, this succeeds immediately and the user doesn't have
   * to navigate a scene to trigger the polling path. If it fails (Quest
   * off, HereSphere closed, IP changed) we fall through silently — the
   * polling loop will pick things up when real activity appears.
   */
  async _attemptSavedHostReconnect() {
    if (!this.vrBridge || this.vrBridge.connected) return;
    const host = this.settings.get('vr.lastHost');
    const port = this.settings.get('vr.lastPort') || 23554;
    const playerType = this.settings.get('vr.lastPlayerType') || 'heresphere';
    if (!host) return;
    console.log(`[VR] Trying saved host ${host}:${port}`);
    const success = await this.vrBridge.connect(playerType, host, port);
    if (success) {
      this._announceVRLink('toast.vrReconnected');
    }
    // Silent on failure — polling takes over.
  }

  /**
   * A dial that connected asks for its toast here; it shows on the link's
   * first state packet (onFirstPacket in _wireVRBridgeCallbacks), so a host
   * that accepts and never sends shows none (FT-054). Shown at once when
   * the packet came first.
   * @param {string} key — 'toast.vrConnected' | 'toast.vrReconnected'
   */
  _announceVRLink(key) {
    if (this.vrBridge?.received && this.vrBridge.connected) {
      this._vrLinkToast = null;
      showToast(t(key), 'info', 3000);
    } else {
      this._vrLinkToast = key;
    }
  }

  /**
   * Gap before the next automatic dial (`_pollVRActivity` without fresh
   * activity, `_retryVRReconnect`): 2 s for the first three failed attempts,
   * then 8 s. A host that keeps ACCEPTING and never sends a packet (each
   * such link also costs the 8 s watchdog) backs off further from its third,
   * doubling from 8 s to a 30 s cap (FT-054). A refused dial stays at 8 s:
   * that is the headset away, and this retry is how it comes back (#320).
   * The first packet of a link resets both counters (onFirstPacket).
   * @returns {number} ms
   */
  _vrRetryBackoffMs() {
    const attempts = this._vrPollFailedAttempts || 0;
    if (attempts < 3) return 2000;
    const silent = this._vrSilentLinks || 0;
    if (silent < 3) return 8000;
    return Math.min(30000, 8000 * 2 ** (silent - 3));
  }

  /**
   * Public "reconnect now" hook. Used by the VR modal's manual Reconnect
   * button so users can force an attempt without waiting for the poll
   * cycle or the backoff timer. Prefers the currently-known host, falling
   * back to the saved host from settings.
   *
   * @param {string} [host] — optional override (e.g. user typed a new IP)
   * @param {number} [port]
   * @returns {Promise<boolean>}
   */
  async reconnectVR(host, port) {
    if (!this.vrBridge) return false;
    const h = host || this.vrBridge._host || this.settings.get('vr.lastHost');
    const p = port || this.vrBridge._port || this.settings.get('vr.lastPort') || 23554;
    if (!h) return false;
    if (this.vrBridge.connected) await this.vrBridge.disconnect();
    return this.vrBridge.connect(
      this.settings.get('vr.lastPlayerType') || 'heresphere',
      h,
      p,
    );
  }

  /**
   * Poll the backend for a phone-triggered rescan request. The web remote's
   * Refresh button bumps a monotonic counter; when it advances past the last
   * value we saw, force a library rescan + re-register so the phone picks up
   * files the user added to a source folder. Cheap local fetch, fire-and-forget
   * on any error (backend not up yet, transient).
   */
  async _pollRescanRequest() {
    if (!this.library) return;
    try {
      const port = this.settings.get('backend.port') || 5123;
      const res = await fetch(`http://127.0.0.1:${port}/api/media/rescan-request`);
      if (!res.ok) return;
      const data = await res.json();
      const seq = data?.seq;
      if (typeof seq !== 'number') return;
      // First successful poll only establishes the baseline — never rescan on
      // launch just because the counter was already non-zero from a prior run.
      if (this._lastRescanSeq === null) {
        this._lastRescanSeq = seq;
        return;
      }
      // Counter went backwards → the backend process restarted and reset it.
      // Re-baseline without rescanning (no user actually asked); a later bump
      // past this fresh baseline still triggers a rescan.
      if (seq < this._lastRescanSeq) {
        this._lastRescanSeq = seq;
        return;
      }
      if (seq === this._lastRescanSeq) return;
      this._lastRescanSeq = seq;
      await this._handleRescanRequest();
    } catch {
      // Backend not reachable yet / transient — next tick retries.
    }
  }

  /**
   * Forced rescan + re-register triggered by the phone. `ensureScanned` replaces
   * `this.library._videos` and re-POSTs the full list to the backend (so the
   * phone's next fetch sees the new files). Quietly re-render the desktop grid
   * too if the library view is currently visible; other views pick up the fresh
   * `_videos` on their next `show()`.
   */
  async _handleRescanRequest() {
    try {
      await this.library.ensureScanned({ forceRescan: true });
      if (this._currentView() === 'library') {
        this.library._applyFilters?.();
      }
    } catch (e) {
      console.warn('[Rescan] phone-triggered rescan failed:', e);
    }
  }

  async _pollVRActivity() {
    if (!this.vrBridge) return;
    // Don't poll if companion bridge is already connected
    if (this.vrBridge.connected) return;
    // One tick at a time. A refused dial to a LAN IP takes about 2 s on
    // Windows, the same as the poll interval, so the next tick used to
    // land on the in-flight dial in most cycles and count it as a second
    // failure, reaching the 8 s backoff after two real attempts (V24).
    if (this._vrPollInFlight) return;
    this._vrPollInFlight = true;

    try {
      const port = this.settings.get('backend.port') || 5123;
      const res = await fetch(`http://127.0.0.1:${port}/api/media/vr-activity`);
      if (!res.ok) return;
      const data = await res.json();

      // No fresh activity. That is EXACTLY the state dio described
      // (EroScripts #320): take the headset off or switch Quest 3 to
      // passthrough, HereSphere goes to the background, its socket drops and
      // it stops touching the backend — so the activity endpoint goes quiet
      // at the same moment we most need to reconnect. Bailing here meant the
      // only way back was pressing Connect by hand, every time.
      //
      // If we have connected to a headset before this session and know its
      // address, keep retrying on the same backoff. Gated on having been
      // connected, so a user who has never used VR is not making pointless
      // TCP attempts every 8 seconds.
      if (!data.clientIp || !data.videoId || !data.timestamp) {
        await this._retryVRReconnect();
        return;
      }

      // Activity from before our last successful connect, or from before
      // the user pressed Disconnect, is already accounted for: that link,
      // or that choice, is newer evidence than the scene request. The
      // record used to win regardless, so one stale request from another
      // IP overwrote vr.lastHost and was re-dialed instead of the host the
      // user had just connected to (V21). Treat it like no activity. (The
      // backend also expires the record after a few minutes.)
      const settledAtMs = Math.max(this._vrLastConnectAtMs || 0, this._vrUserDisconnectAtMs || 0);
      if (data.timestamp * 1000 <= settledAtMs) {
        await this._retryVRReconnect();
        return;
      }

      // vr.lastHost is NOT written here. A scene request proves only that
      // something at that IP fetched a scene; onConnect saves the host once
      // a dial to it actually works, which still covers the "Quest got a new
      // DHCP lease" case and never replaces a known-good host with a dead
      // one (V21).

      // Someone else's dial is in flight (Connect, Try again, the saved
      // host at startup): joining it would count its outcome as ours (V24).
      // Nothing is stamped, so the next tick still sees this activity as new.
      if (this.vrBridge.connecting) return;

      const isNewActivity = data.timestamp > this._lastVrActivityTs;

      // Backoff strategy after a failed connect: count consecutive
      // failed attempts in `_vrPollFailedAttempts`. First three attempts
      // retry every 2 s (matches the poll cadence — no extra delay);
      // after that, back off to 8 s (further for a host that accepts
      // and never sends, `_vrRetryBackoffMs`). **Crucially**, fresh activity
      // (a new timestamp from the backend) bypasses the backoff
      // entirely — that's the strongest signal that the user just did
      // something in HereSphere (toggled a setting, picked a video)
      // and we should retry immediately. Was a 10 s lockout that left
      // the user staring at silent toys after fixing their config.
      if (!isNewActivity) {
        const backoffMs = this._vrRetryBackoffMs();
        const lastTry = this._lastVrRetryTime || 0;
        if (performance.now() - lastTry < backoffMs) return;
      }

      this._lastVrActivityTs = data.timestamp;
      this._lastVrRetryTime = performance.now();

      console.log(`[VR] Quest activity detected: ${data.clientIp} playing ${data.videoId}`);

      // Try to connect companion bridge (non-blocking single attempt)
      // If it fails, the next poll cycle (2s) will try again with any new activity
      if (!this.vrBridge.connected) {
        const success = await this.vrBridge.connect('heresphere', data.clientIp, 23554);
        if (success) {
          // The bridge's onConnect (_wireVRBridgeCallbacks) has already
          // armed the quiet-endpoint retry; the backoff resets, and this
          // toast shows, on the link's first packet (FT-054).
          this._announceVRLink('toast.vrConnected');
          // Tear down any stale hint toast that's still on screen, and
          // reset the "already hinted" flag so if the Quest later drops
          // and the user closes+reopens HereSphere mid-session, the
          // timestamp-server hint can fire again.
          this._dismissTimestampServerHint();
          this._vrTimestampHintShown = false;
          // Bridge's onConnect callback already drives the nav-bar tint
          // and the VR modal live-updates when open; nothing extra to do.
        } else {
          this._vrPollFailedAttempts = (this._vrPollFailedAttempts || 0) + 1;
          // Pass Quest IP through so the toast can suggest the literal
          // value to type into HereSphere's timestamp-server IP field.
          this._maybeShowTimestampServerHint(this.vrBridge._lastError, data.clientIp);
        }
      }
    } catch {
      // Backend not running or fetch failed — ignore
    } finally {
      this._vrPollInFlight = false;
    }
  }

  /**
   * What DragDrop calls for a dropped file, or one picked with Browse or the
   * O key. Both work in any view. A method rather than an inline literal in
   * init so a test can drive the real wiring.
   *
   * While the pop-out owns playback a video goes there, as a library click
   * does (V13): loaded inline without autoplay, then routed. A bare
   * loadVideo autoplayed the hidden inline <video> (which the backstop in
   * _initPlayerWindow then paused, so the new video played nowhere), sent
   * nothing to the pop-out and switched the main window to an empty player.
   * A dropped File with no path (blob:, which the pop-out cannot open)
   * takes the route's other branch: fold back and play inline.
   */
  _dragDropOptions() {
    // Both a video and a funscript replace the script in the editor, so
    // unsaved edits are asked about first (CB-01). ONE question per drop or
    // Browse pick: DragDrop hands over its files in one synchronous loop, and
    // the second file used to find the question already open, get `false`
    // and be dropped whatever the answer (a video + its funscript lost the
    // funscript). The files after the first wait for the same answer, in
    // order, until the loop is done (`batchAnswer` clears in a microtask). A
    // subtitle in the same drop waits too, or it attached to the old video.
    // `go(true)` when it ran after an answer: a funscript is then read again
    // from its path (round 2, see _readFunscriptFileAgain).
    let batchAnswer = null;
    const afterEditorOk = (go) => {
      if (batchAnswer) return batchAnswer.then((ok) => (ok ? go(true) : undefined));
      const editorOk = this._editorAllowsReplace();
      if (editorOk === true) return go(false);
      const answer = Promise.resolve(editorOk);
      batchAnswer = answer;
      queueMicrotask(() => { if (batchAnswer === answer) batchAnswer = null; });
      return answer.then((ok) => (ok ? go(true) : undefined));
    };
    // The script that comes with an opened or dropped video is uploaded to a
    // Handy or an Autoblow before the video may start, as a library open
    // waits (FT-112): O and drag-and-drop played the new video at once and
    // the first ~0.9 s were not stroked (block F, Handy session 2026-11-17).
    // `withScript`: the same pick or drop carries a funscript (DragDrop says
    // so with each video, before handing the script over). A video on its
    // own loads the script a library open of it loads
    // (`_loadOpenedVideoScript`), which holds the same gate while it looks.
    const holdForScript = (file, withScript, pendingBefore) => {
      // A funscript dropped before any video paired with this one in loadVideo.
      const paired = (this._pendingFunscripts?.length || 0) < pendingBefore;
      if (withScript || paired) {
        this._markCloudUploadsPending?.();
        return undefined;
      }
      if (!file?._isPathBased || !file.path || file._remote) return undefined;
      return this._loadOpenedVideoScript?.(file);
    };
    return {
      onVideoFile: (file, { withScript = false } = {}) => afterEditorOk(() => {
        // A dropped or opened file plays on its own: no list after it (FT-074).
        this._clearPlaySession();
        const pendingBefore = this._pendingFunscripts?.length || 0;
        if (!this._playerWindowActive) {
          this.loadVideo(file);
          return holdForScript(file, withScript, pendingBefore);
        }
        this.loadVideo(file, { skipViewSwitch: true, autoPlay: false });
        // Before the route, which loads the pop-out paused while the gate holds.
        const ownScript = holdForScript(file, withScript, pendingBefore);
        return Promise.all([
          this._routeLoadedVideoToPlayerWindow(true)
            .catch((err) => console.warn('[PlayerWindow] could not route the opened file:', err)),
          ownScript,
        ]);
      }),
      onFunscriptFile: (file) => afterEditorOk((asked) => (asked
        ? this._readFunscriptFileAgain(file).then((again) => this.loadFunscript(again))
        : this.loadFunscript(file))),
      onSubtitleFile: (file) => (batchAnswer
        ? batchAnswer.then((ok) => (ok ? this.videoPlayer.loadSubtitles(file) : undefined))
        : this.videoPlayer.loadSubtitles(file)),
      onUnsupported: (msg) => showToast(msg, 'warn', 5000),
    };
  }

  /**
   * A video opened with O / Browse or dropped on its own (no script in the
   * same pick or drop) gets the script a library open of it gets (block F,
   * Handy session 2026-11-17; also in v0.9.2): a video the library holds
   * loads what its card loads (`library.resolvePlayData`: its script or
   * association, companions, routing, subtitle, variants); any other file
   * its `<name>.funscript` beside it, quietly, as the library plays a
   * script added since the last scan (FT-069). O used to play such a video
   * with "No script" although the script sat next to it.
   *
   * The cloud-upload gate is marked first, so the autoplay at `loadeddata`
   * waits while it looks; nothing found lifts it at once. A later video
   * owns the gate and the engines: then this one stops (`_videoLoadGen`).
   */
  async _loadOpenedVideoScript(file) {
    this._markCloudUploadsPending?.();
    const gen = this._videoLoadGen;
    let data = null;
    try {
      const libVideo = this.library?.getVideoByPath?.(file.path) || null;
      if (libVideo && typeof this.library.resolvePlayData === 'function') {
        data = await this.library.resolvePlayData(libVideo);
      } else {
        const sidecar = /\.[^/\\.]+$/.test(file.path)
          ? file.path.replace(/\.[^/\\.]+$/, '.funscript')
          : `${file.path}.funscript`;
        let content = null;
        try { content = await window.funsync?.readFunscript?.(sidecar); } catch { /* quiet: most have none */ }
        if (content) {
          data = { funscriptData: { name: sidecar.split(/[\\/]/).pop(), textContent: content, _funscriptPath: sidecar } };
        }
      }
    } catch (err) {
      console.warn('[Open] Could not look up the opened video\'s script:', err?.message || err);
    }
    if (this._videoLoadGen !== gen) return;
    const funscriptData = data?.funscriptData || null;
    // No main script to upload: an autoplay waiting on one plays now.
    if (!funscriptData?.textContent) {
      this._resolveCloudUpload?.('handy');
      this._resolveCloudUpload?.('autoblow');
    }
    if (!funscriptData && !data?.subtitleData && !data?.variants?.length) return;
    if (funscriptData?.textContent) {
      console.log('[Open] Playing the opened video\'s own script:', funscriptData._funscriptPath || funscriptData.name);
    }
    await this._loadPlayContent(file, funscriptData, data?.subtitleData || null, data?.variants || []);
  }

  /**
   * A file dropped on the window or opened (drag-and-drop, O, Browse) is a
   * video on its own: no Play All and no library, playlist or category list
   * after it (FT-074; also in v0.9.2). Only a library-side play
   * (`_playFromLibrary`) reset these, so a dropped file kept the last list:
   * Up Next offered that list's next video at its end, prev / next stepped
   * through it and the queue panel listed it. Your own queue (`_userQueue`)
   * stays: it is yours, not the list's.
   */
  _clearPlaySession() {
    this._playQueue = [];
    this._playQueueIndex = -1;
    this._playQueueSource = null;
    this._playQueueLoop = false;
    this._playQueueShuffle = false;
    this._playQueueBalance = false;
    this._playQueueFullList = null;
    this._pendingWrapOrder = null;
    this._pendingContextWrap = null;
    this._currentPlayContext = null;
    this._setUpNextContext(null);
    this._updateQueueUI();
    this._updateQueuePanelState();
  }

  /**
   * KeyboardHandler's constructor options. A method rather than an inline
   * literal in init so a test can build the REAL handler with the REAL
   * wiring: the pop-out routes below (V13) are exactly what a test that
   * hand-wires its own copy would not notice being dropped.
   */
  _keyboardOptions() {
    return {
      videoPlayer: this.videoPlayer,
      connectionPanel: this.connectionPanel,
      onOpenFile: () => this.dragDrop._openNativeDialog(),
      scriptEditor: null, // set in init once the ScriptEditor exists
      onNavigate: (viewId) => this._navigateTo(viewId),
      onToggleLoop: () => {
        if (!this._playerWindowPlayback('toggleLoop')) this._toggleVideoLoop?.();
      },
      onToggleQueue: () => { this._toggleQueuePanel(); },
      isQueueOpen: () => !!this.queuePanel?.visible,
      onJumpChapter: (direction) => this._jumpChapter(direction),
      onJumpBookmark: (direction) => this._jumpBookmark(direction),
      onLoadNext: () => this._playNext(),
      onLoadPrev: () => this._playPrev(),
      // Play/pause, seek, volume, mute and speed go to the detached player
      // window while it owns playback (V13).
      onPlaybackCommand: (command, arg) => this._playerWindowPlayback(command, arg),
      // Ctrl+= / Ctrl+- / Ctrl+0 are VR zoom only while a VR video is open
      // in the player; everywhere else they stay the View menu's interface
      // zoom (V45). A VR video docked in the mini-player does not count:
      // the user is looking at the Library, not the video.
      isVRZoomActive: () => this._currentView() === 'player'
        && !!this._currentStereoFormat && !!this._currentVideoPath,
      // Home/End seek only on the player view; in the Library they scroll (V44).
      getView: () => this._currentView(),
      // The playback keys act only while a player is on screen: the player
      // view, the docked mini player or the detached player window. After
      // Back with the mini player off, Space played the hidden video (CB-05).
      hasOffViewPlayer: () => !!this._miniActive || !!this._playerWindowActive,
    };
  }

  /**
   * A global hotkey fired (see the wiring comment in init). Play/pause goes
   * to the pop-out's <video> when detached, never the hidden inline one: it
   * used to start a second, invisible copy while the pop-out and the device
   * kept running (V13).
   */
  _onGlobalShortcut(action) {
    if (action === 'playPause') {
      if (!this._playerWindowPlayback('toggle')) this.videoPlayer?.togglePlay?.();
    } else if (action === 'orgasm') {
      this._onOrgasmHold(true, { forceToggle: true });
    } else if (action === 'edge') {
      this._onEdgeHold(!this._edgeActive, { force: true });
    }
  }

  /**
   * Global hotkeys: route a fired accelerator to its action, register the
   * saved bindings now, and register them again whenever they change. They
   * used to be registered once, at boot, so a binding set in Settings
   * (Settings > Playback > Global hotkeys) did nothing until a restart (V47).
   */
  _wireGlobalShortcuts() {
    window.funsync?.onGlobalShortcut?.((action) => this._onGlobalShortcut(action));
    this._applyGlobalShortcuts();
    eventBus.on('settings:changed', ({ path } = {}) => {
      if (path === 'player.globalShortcuts') this._applyGlobalShortcuts();
    });
  }

  /**
   * Push the saved global-hotkey bindings into the main process, and warn
   * about any the OS refused — another application already owning a
   * combination is the normal failure here, and it is invisible otherwise.
   * A binding Electron cannot parse at all (a hand-edited config.json) is a
   * different failure with a different fix, and used to be reported as
   * "already used by another app" too (V48).
   */
  async _applyGlobalShortcuts() {
    if (!window.funsync?.setGlobalShortcuts) return;
    const bindings = this.settings?.get?.('player.globalShortcuts') || {};
    try {
      const results = await window.funsync.setGlobalShortcuts(bindings);
      // The Settings rows show what the OS answered, not a guess: a refused
      // binding must not read "Still active as saved." (CB-19).
      eventBus.emit('globalShortcuts:registered', { results: Array.isArray(results) ? results : null });
      const failed = (results || []).filter((r) => r && r.ok === false);
      for (const f of failed) {
        const key = f.reason === 'invalid' ? 'toast.globalShortcutInvalid' : 'toast.globalShortcutTaken';
        showToast(t(key, { key: f.accelerator }), 'warn', 5000);
      }
    } catch (err) {
      console.warn('[GlobalShortcut] apply failed:', err?.message || err);
      // No answer: the rows stop claiming anything about registration.
      eventBus.emit('globalShortcuts:registered', { results: null });
    }
  }

  /**
   * Reconnect to a headset we have talked to before, when the activity
   * endpoint has gone quiet.
   *
   * HereSphere backgrounding is invisible to the backend — it simply stops
   * polling — so "no activity" cannot be distinguished from "headset asleep"
   * or "user finished". Retrying costs one TCP attempt on the same backoff
   * the active path uses, and only for someone who has already had a working
   * connection this session.
   */
  async _retryVRReconnect() {
    if (!this.vrBridge || this.vrBridge.connected) return;
    if (!this._vrEverConnected) return;
    const host = this.settings.get('vr.lastHost');
    if (!host) return;
    // Someone else's dial is in flight: not our attempt to count (V24).
    if (this.vrBridge.connecting) return;

    const backoffMs = this._vrRetryBackoffMs();
    if (performance.now() - (this._lastVrRetryTime || 0) < backoffMs) return;
    this._lastVrRetryTime = performance.now();

    const success = await this.vrBridge.connect('heresphere', host, 23554);
    if (success) {
      // The backoff resets, and the toast shows, on the link's first
      // packet: a host that accepts and never sends is a failed attempt
      // when the watchdog drops it (FT-054).
      this._announceVRLink('toast.vrReconnected');
      this._dismissTimestampServerHint();
      this._vrTimestampHintShown = false;
    } else {
      this._vrPollFailedAttempts = (this._vrPollFailedAttempts || 0) + 1;
    }
  }

  /**
   * If the main process recovered config.json from a snapshot during
   * boot (corrupt or missing config — power-loss, disk full at write
   * time, ransomware, etc.), surface that fact to the user. Per
   * SCOPE-data-backup.md §8.2 the user should never see an empty UI
   * with no explanation; one toast at most, never on a healthy boot.
   *
   * Fire-and-forget — backup IPC failures are tolerable; if the result
   * channel isn't reachable we just skip the toast.
   */
  async _maybeShowRecoveryToast() {
    try {
      const result = await window.funsync.backupGetBootResult?.();
      if (!result) return;
      if (result.recovered) {
        // Recovered cleanly from a snapshot — actionable, not alarming.
        showToast(t('toast.settingsRecovered'), 'warn', 10_000);
      } else if (result.fellBack) {
        // config.json was empty, unparseable or unreadable, or missing on a
        // machine with backup history, and no snapshot could stand in. More
        // urgent — direct the user toward the Import flow. A first launch
        // (no config, no backups folder) comes back as `fresh` and shows
        // nothing: it used to land here and greet every new user with this
        // red toast (V06).
        showToast(t('toast.settingsNotRecovered'), 'error', 15_000);
      }
    } catch {
      // IPC channel unavailable (e.g. older preload). Silently skip.
    }
  }

  /**
   * When the VR companion auto-connect fails with ECONNREFUSED on port
   * 23554, the Quest's HereSphere timestamp server isn't listening —
   * either not enabled, or enabled but in a stuck state (the session
   * resets between HereSphere restarts and occasionally needs a reset
   * even within one). Surface a short, dismissable toast with the
   * remediation steps so the user isn't digging through docs.
   *
   * Stashes the toast handle so we can tear it down automatically when
   * the bridge reconnects — otherwise the hint lingers after it's no
   * longer relevant.
   */
  _maybeShowTimestampServerHint(lastError, questIp) {
    if (!lastError) return;
    if (this._vrTimestampHintShown) return;
    // Only fire for the specific "server not listening" case — other VR
    // errors (wrong host, DNS, firewall) have different messages and
    // shouldn't get the HereSphere-specific guidance.
    const looksLikeRefused = /ECONNREFUSED/i.test(lastError) && /23554/.test(lastError);
    if (!looksLikeRefused) return;
    this._vrTimestampHintShown = true;

    // Interactive toast: hint text + "Try again" button. Clicking the
    // button clears the activity-poll backoff and triggers an immediate
    // reconnect, so the user doesn't have to wait out the 8 s backoff
    // window after fixing the HereSphere config. Shneiderman #6
    // reversibility, Nielsen #9 actionable error recovery.
    //
    // Wording rewritten 2026-04-30 after deeper investigation: the
    // earlier "fill in both fields" phrasing was driven by an n=1
    // incident where the user happened to fix things by typing values.
    // The actual root cause when ECONNREFUSED:23554 fires is "HereSphere
    // isn't listening on the address FunSync is connecting to" — which
    // can be a stale IP (DHCP lease renewed), a stuck listener (a known
    // HereSphere bug fixed in v0.11.2), or genuinely-blank fields. ANY
    // action that re-initialises HereSphere's listener fixes it. The
    // cleanest is the auto-find IP button (HereSphere v0.5+ ships one
    // next to the IP field). Toggling off-and-on works too. Manual
    // typing also works but it's the least convenient option, and most
    // users with a working setup never typed anything in the first
    // place — the field was populated by the auto-find button or by
    // HereSphere's own persistence.
    const wrapper = document.createElement('div');
    wrapper.className = 'toast__multiline';

    // In the active language (FT-062): it was an English literal. The port
    // stays a literal in every locale.
    const ipSuggestion = questIp || t('toast.vrQuestIpUnknown');
    const text = document.createElement('div');
    text.textContent = t('toast.vrTimestampServerHint', { ip: ipSuggestion });
    wrapper.appendChild(text);

    const tryAgainBtn = document.createElement('button');
    tryAgainBtn.type = 'button';
    tryAgainBtn.className = 'toast__action';
    tryAgainBtn.textContent = t('toast.tryAgain');
    tryAgainBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't trigger click-to-dismiss on the toast body
      tryAgainBtn.disabled = true;
      tryAgainBtn.textContent = t('toast.connecting');
      // Reset the backoff state so the next activity-poll tick (or the
      // direct attempt below) fires immediately.
      this._vrPollFailedAttempts = 0;
      this._vrSilentLinks = 0;
      this._lastVrRetryTime = 0;
      // Direct connect attempt with the host this hint is about. If it
      // succeeds, the bridge.onConnect callback dismisses the hint via
      // _dismissTimestampServerHint(); if it fails, leave the toast up
      // (the user can hit Try again again or the next activity-poll
      // tick will retry on its own). The poll no longer copies the
      // activity IP into vr.lastHost before a dial has worked (V21), so
      // the saved host is only the fallback here.
      const host = questIp || this.settings.get('vr.lastHost') || this.vrBridge.host || '127.0.0.1';
      const success = await this.vrBridge.connect('heresphere', host, 23554);
      if (!success) {
        tryAgainBtn.disabled = false;
        tryAgainBtn.textContent = t('toast.tryAgain');
      }
    });
    wrapper.appendChild(tryAgainBtn);

    this._vrTimestampHintToast = showToast(
      wrapper,
      'warn',
      0,  // persistent — caller dismisses via _dismissTimestampServerHint()
    );
  }

  /**
   * Tear down the timestamp-server hint toast if one is currently on
   * screen. Called from the VR connect-success path so the warning
   * doesn't linger after the user has actually fixed the problem.
   */
  _dismissTimestampServerHint() {
    if (this._vrTimestampHintToast?.dismiss) {
      this._vrTimestampHintToast.dismiss();
    }
    this._vrTimestampHintToast = null;
  }

  /**
   * Current gap-filler options, resolved from settings.
   *
   * Auto-skip and filler act on the same gaps, so precedence has to be
   * stated somewhere: if a gap is being SKIPPED there is nothing to fill, so
   * skip wins and filler is suppressed entirely. Button-skip leaves the gap
   * playing until the user presses the button, so filler still applies.
   *
   * @param {number} [durationMs] the length of the timeline the script plays
   *   on, for the trailing gap (FT-113): a headset's or a phone's video is
   *   not this window's, so its upload passes its own (0 = unknown, no
   *   trailing filler). Left out: this window's video, as before.
   * @returns {object|null} null when filler should not run
   */
  _fillerOptionsForUpload(durationMs) {
    const filler = this.settings?.get?.('player.gapFiller') || {};
    if (!filler.enabled) return null;

    const gapSettings = this.settings?.get?.('player.gapSkip') || {};
    if ((gapSettings.mode || 'off') === 'auto') return null;   // skip wins

    const totalDurationMs = durationMs === undefined
      ? Math.round((this.videoPlayer?.video?.duration || 0) * 1000)
      : (Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0);
    return resolveFillerOptions({
      enabled: true,
      presetId: filler.presetId,
      custom: filler.custom || null,
      // The shared Pattern block's choice (2026-11-19); absent, presetId /
      // custom are read exactly as before (filler-presets.js).
      pattern: filler.pattern || this.settings?.get?.('player.gapFiller.pattern') || null,
      // Default the filler threshold to the gap-skip threshold so the two
      // features agree on what counts as a gap unless told otherwise.
      thresholdMs: filler.thresholdMs || gapSettings.threshold || 10000,
      totalDurationMs,
      maxJoinSpeed: filler.maxJoinSpeed,
    });
  }

  /**
   * Play a previewed filler pattern through the connected devices.
   *
   * Returns a status rather than a boolean so the panel can say WHY nothing
   * happened — "a video is driving the devices" and "nothing is connected"
   * are different problems with different fixes (Nielsen #9).
   *
   * The Handy plays it too (pf-fixup 2026-11-19; before, a Handy alone was
   * "Connect a device first"): the sample is uploaded once the way the
   * Orgasm Switch engages (engageHandyFinisher: cutoff and invert baked in,
   * an untiled upload), and the playhead, Buttplug and T-Code start when the
   * Handy does. Never while a video plays or X / Z / a phone, the player
   * window or a headset owns the Handy ('busy'); the run ends on Stop, on
   * closing the drawer or Settings, at its end, when a video starts or
   * changes, and when X or Z is pressed. Then the Handy stops and gets this
   * video's script back (_endHandyTest).
   *
   * @returns {'started'|'busy'|'no-devices'}
   */
  _startFillerTest(actions, { onProgress, onEnd } = {}) {
    if (!this._fillerTest) {
      this._fillerTest = new FillerTestPlayer({
        buttplugSync: this.buttplugSync,
        tcodeSync: this.tcodeSync,
      });
    }
    const player = this._fillerTest;
    // A run still going (its Handy part may be uploading): it ends first.
    if (player.running || this._handyTest) player.stop();
    player.onProgress = onProgress || null;
    // Every end of a run (Stop, its end, a restart) ends its Handy part too.
    player.onEnd = () => {
      const why = this._handyTestEndReason || 'end';
      this._handyTestEndReason = null;
      this._endHandyTest?.(why);
      if (onEnd) onEnd();
    };

    if (player.blockedByPlayback) return 'busy';
    const local = !!(this.buttplugManager?.connected || this.tcodeManager?.connected);
    const handy = !!this.handyManager?.connected;
    if (!local && !handy) return 'no-devices';
    if (!handy) return player.play(actions) ? 'started' : 'no-devices';
    if (this._handyTestBusy()) return 'busy';
    return this._startHandyTest(actions, { local }) ? 'started' : 'no-devices';
  }

  /** True while something else owns the Handy: a Settings Test must not take it. */
  _handyTestBusy() {
    if (this.orgasmSwitch?.active || this._edgeActive || this._edgePatternOn) return true;
    if (this._remoteActive || this._playerWindowActive || this._vrPlayerRef) return true;
    if (this.handyHdspSync?.active) return true;
    const video = this.videoPlayer?.video;
    return !!(video && video.paused === false);
  }

  /**
   * The Handy's part of a Settings Test: the sample from its first point,
   * uploaded and played once (HSSP). The main engine is stopped under it (a
   * seek must not send the main script's commands to a device holding the
   * test's) and started again at the end. The local run waits for the Handy
   * to play, so the playhead and every device move together; the Handy
   * failing says so and leaves the others to play it.
   * @returns {boolean} false when there is nothing to play
   */
  _startHandyTest(actions, { local = false } = {}) {
    const list = (Array.isArray(actions) ? actions : [])
      .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
      .sort((a, b) => a.at - b.at);
    if (list.length < 2 || !(list[list.length - 1].at > list[0].at)) return false;
    const player = this._fillerTest;
    const t0 = list[0].at;
    const content = JSON.stringify({
      version: '1.0', inverted: false, range: 100,
      actions: list.map((a) => ({ at: Math.round(a.at - t0), pos: Math.round(a.pos) })),
    });
    const run = { promise: null, video: null, onPlay: null };
    this._handyTest = run;
    const isCurrent = () => this._handyTest === run;
    if (this.syncEngine?._active) {
      this.syncEngine.stop();
      this._handyTestHeldEngine = true;
    }
    const engage = () => engageHandyFinisher({
      handyManager: this.handyManager,
      content,
      cachedUrl: null,
      cutoff: this._cutoffFromSettings('handy'),
      inverted: this._handyInverted(),
      once: true,
      isCurrent,
    });
    // The last Test's Handy restore, still on its way, goes first.
    const prior = this._patternTestReleasePromise;
    run.promise = (prior ? Promise.resolve(prior).catch(() => {}).then(() => (isCurrent() ? engage() : 'stale')) : engage())
      .then((status) => {
        if (!isCurrent()) return status;
        if (status !== 'looping') {
          showToast(t('toast.patternTestHandyFailed'), 'warn', 4000);
          // Buttplug / T-Code still play it; with none, the run ends.
          if (!local || !player.play(list)) player.stop();
          return status;
        }
        if (!player.play(list)) player.stop();
        return status;
      });
    // Never while a video plays: a video started under the test ends it.
    const video = this.videoPlayer?.video;
    if (video?.addEventListener) {
      run.video = video;
      run.onPlay = () => { if (this._handyTest === run) this._fillerTest?.stop(); };
      video.addEventListener('play', run.onPlay);
    }
    return true;
  }

  /**
   * End the Handy's part of a Settings Test (the run ended, for any reason).
   * Once its engage has settled, the Handy stops and gets this video's script
   * back, and the main engine starts again (_restoreHandyAfterTest), unless X
   * or Z playing a pattern took it meanwhile (their release restores it) or
   * a new Test did. 'video-change': loadVideo stops the Handy and the new
   * video sets its own script, so nothing is restored here.
   */
  _endHandyTest(reason = 'end') {
    const run = this._handyTest;
    if (!run) return;
    this._handyTest = null; // an engage still on its way goes stale
    if (run.video && run.onPlay) run.video.removeEventListener('play', run.onPlay);
    if (reason === 'video-change') {
      this._handyTestHeldEngine = false;
      return;
    }
    const takenOver = () => !!(this.orgasmSwitch?.active || this._edgePatternOn);
    const release = Promise.resolve(run.promise).catch(() => {})
      .then(async () => {
        if (this._handyTest) return; // a new Test: it restores at its own end
        if (takenOver()) { this._handyTestHeldEngine = false; return; }
        await releaseHandyFinisher({ handyManager: this.handyManager });
        if (this._handyTest) return;
        if (takenOver()) { this._handyTestHeldEngine = false; return; }
        await this._restoreHandyAfterTest();
      })
      .catch((err) => console.warn('[PatternTest] Handy restore failed:', err?.message || err));
    this._patternTestReleasePromise = release;
    release.then(() => { if (this._patternTestReleasePromise === release) this._patternTestReleasePromise = null; });
  }

  /**
   * After a Settings Test on the Handy: this video's script back on the
   * device (the cached upload, as _restoreHandyAfterOrgasm does, else the
   * full upload), and the main engine started again if the test stopped it.
   * The video is paused (the test never runs under a playing one, and a play
   * ends it), so nothing moves until the next play anchors it.
   */
  async _restoreHandyAfterTest() {
    const held = this._handyTestHeldEngine === true;
    this._handyTestHeldEngine = false;
    if (!this.handyManager?.connected) return;
    if (!this.funscriptEngine?.isLoaded) {
      if (held) this.syncEngine?.start();
      return;
    }
    let ok = false;
    if (this._scriptCloudUrl && this._scriptCloudUrlInverted === this._handyInverted()) {
      ok = await this.handyManager.setupScript(this._scriptCloudUrl);
    }
    if (!ok) {
      await this._uploadAndStartSync();
      return;
    }
    if (this.syncEngine) {
      this.syncEngine._scriptReady = true;
      if (held) this.syncEngine.start();
    }
  }

  /**
   * Push the current filler settings into the funscript engine so the
   * tick-driven devices (T-Code, Buttplug, Handy HDSP) pick filler up via
   * their existing `reloadActions()` path.
   */
  _applyFillerSettings() {
    if (!this.funscriptEngine?.setFillerOptions) return;
    this.funscriptEngine.setFillerOptions(this._fillerOptionsForUpload());
    // Tick-driven engines cache the action list; make them re-read it.
    this.buttplugSync?.reloadActions?.();
    this.tcodeSync?.reloadActions?.();

    // Redraw the heatmap, because the action list it was drawn from has just
    // changed underneath it.
    //
    // The load sequence renders the heatmap from getActions() BEFORE this
    // runs (it is called from _startGapSkip, ~50 lines later, because that is
    // where the video duration is known and deferred if it is not). So on the
    // first play after changing a filler setting the bar showed the OLD
    // actions, and only looked right on the second play — by which point the
    // previous load had already rebuilt the filler. Reported by Dave,
    // 2026-08-14: "displays the heatmap correctly only after 2 separate
    // launches of a video, not on the first launch after the change."
    //
    // Doing it here rather than reordering the load sequence also fixes
    // changing the setting while a video is already playing, which never
    // updated the bar at all.
    //
    // Unconditional on purpose. Gating on "does filler exist now vs before"
    // would miss the commonest case — switching PRESET while filler is
    // already on, where the shape changes completely and the flag does not.
    // This runs on load and on settings change, not per tick, so the extra
    // draw costs nothing worth guarding against.
    this._refreshHeatmap();
  }

  /**
   * Redraw the seek-bar heatmap from the CURRENT action list.
   *
   * No-ops until the duration is known — the same guard every other
   * renderHeatmap call site uses, since the bar is drawn against duration.
   */
  _refreshHeatmap() {
    const duration = this.videoPlayer?.duration;
    if (!isFinite(duration) || duration <= 0) return;
    const actions = this.funscriptEngine?.getActions?.();
    if (!actions) return;
    this.progressBar?.renderHeatmap(actions, duration);
    this._feedInlineViz?.();
  }

  /**
   * Wire the backend-disconnected banner. Subscribes to `backend-status`
   * IPC events and renders / hides the banner based on the current
   * state. Three states from the main-process health monitor:
   *   'running'    → hide banner
   *   'down'       → show error banner with Restart + View Logs actions
   *   'restarting' → show neutral "restarting" banner (no actions)
   * User can dismiss the banner manually; if the backend stays down,
   * the next state-change event will re-show it.
   */
  _initBackendBanner() {
    const banner = document.getElementById('backend-banner');
    if (!banner) return;
    const titleEl = banner.querySelector('#backend-banner-title');
    const detailEl = banner.querySelector('#backend-banner-detail');
    const restartBtn = banner.querySelector('#backend-banner-restart');
    const logsBtn = banner.querySelector('#backend-banner-logs');
    const dismissBtn = banner.querySelector('#backend-banner-dismiss');

    // Every decision about visibility and dismissal lives in this object so
    // it can be tested without a DOM. See backend-banner-state.js for why
    // the dismissal must outlive a flap.
    const bannerState = new BackendBannerState();
    let rearmTimer = null;

    // The banner is a row of #app's flow under the nav bar (index.html,
    // V80), so the views make room for it on their own. What is fixed to the
    // window does not: dialogs, the Devices and EroScripts panels and the
    // player-view queue panel read the banner's height and bottom edge from
    // these two properties, set only while it shows. Re-measured when it
    // shows or hides, when its size changes (wrapping, a language switch)
    // and on a view change (the nav bar comes and goes above it).
    const root = document.documentElement;
    let lastOffset = '';
    const syncOffset = () => {
      const visible = !banner.hidden;
      let next = '';
      if (visible) {
        const r = banner.getBoundingClientRect();
        next = `${Math.round(r.height)}/${Math.round(r.bottom)}`;
        root.style.setProperty('--backend-banner-h', `${Math.round(r.height)}px`);
        root.style.setProperty('--backend-banner-bottom', `${Math.round(r.bottom)}px`);
      } else {
        root.style.removeProperty('--backend-banner-h');
        root.style.removeProperty('--backend-banner-bottom');
      }
      root.classList.toggle('backend-banner-shown', visible);
      if (next === lastOffset) return;
      lastOffset = next;
      // The library-view queue panel is placed under the view's header,
      // which the banner just moved; the caption buttons sit over the
      // banner, not the video, while it is the player view's top row.
      if (this.queuePanel?.visible) this._positionQueuePanelForView?.();
      this._syncCaptionOverlay?.();
    };
    this._syncBackendBannerOffset = syncOffset;
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => syncOffset()).observe(banner);
    }
    window.addEventListener('resize', syncOffset);

    const applyDecision = (decision) => {
      if (decision.cancelRearmTimer && rearmTimer) {
        clearTimeout(rearmTimer);
        rearmTimer = null;
      }
      if (decision.startRearmTimer && !rearmTimer) {
        rearmTimer = setTimeout(() => {
          rearmTimer = null;
          applyDecision(bannerState.onRearmTimerFired());
        }, bannerState.rearmAfterMs);
      }
      banner.hidden = !decision.visible;
      syncOffset();
    };

    // The status the banner last painted, and whether a Restart is in
    // flight, so a language switch can paint the same words again.
    let shown = null;
    let restartInFlight = false;

    // The words for a status, apart from the visibility and button state
    // render() decides.
    const paintText = (state, detail) => {
      if (state === 'restarting') {
        titleEl.textContent = t('backend.restartingTitle');
        detailEl.textContent = t('backend.restartingDetail');
      } else if (state === 'down' && detail === BACKEND_MISSING) {
        titleEl.textContent = t('backend.missingTitle');
        detailEl.textContent = t('backend.missingDetail');
      } else if (state === 'down') {
        titleEl.textContent = t('backend.title');
        detailEl.textContent = detail
          ? t('backend.detailWithError', { error: detail })
          : t('backend.detail');
      }
    };

    const render = (state, detail) => {
      const decision = bannerState.onStatus(state);
      shown = { state, detail };
      paintText(state, detail);

      if (state === 'restarting') {
        banner.classList.add('backend-banner--restarting');
        restartBtn.disabled = true;
      } else if (state === 'down') {
        banner.classList.remove('backend-banner--restarting');
        if (detail === BACKEND_MISSING) {
          // A packaged install whose backend executable has gone. Almost
          // always antivirus quarantine. Restarting cannot help — it would
          // look for the same missing file — so the button is hidden rather
          // than left there to be pressed forever, which is exactly what
          // 4wen did (thread #262).
          restartBtn.hidden = true;
        } else {
          restartBtn.hidden = false;
          restartBtn.disabled = false;
        }
      } else {
        banner.classList.remove('backend-banner--restarting');
      }

      applyDecision(decision);
    };

    // A language switch: the static walk has just put the title, detail and
    // Restart button back to their "not responding" boot text, and main
    // sends backend-status only on a transition, so a missing or stuck
    // backend kept the wrong guidance, without its error text, until a
    // restart (app test V69). Words only: no onStatus / applyDecision, so a
    // dismissed banner stays dismissed.
    eventBus.on('language:changed', () => {
      if (shown) paintText(shown.state, shown.detail);
      if (restartInFlight) restartBtn.textContent = t('backend.restarting');
    });

    restartBtn.addEventListener('click', async () => {
      applyDecision(bannerState.onRestartRequested());
      restartBtn.disabled = true;
      restartInFlight = true;
      restartBtn.textContent = t('backend.restarting');
      try {
        const result = await window.funsync.restartBackend();
        if (!result.success) {
          showToast(t('toast.restartFailed', { error: result.error || 'unknown error' }), 'error', 5000);
        }
      } finally {
        restartInFlight = false;
        restartBtn.textContent = t('backend.restart');
        // The health monitor will emit a state event; render() handles
        // the banner visibility from there.
      }
    });

    logsBtn.addEventListener('click', async () => {
      const result = await window.funsync.openLogFile();
      if (!result.success) {
        showToast(t('toast.logsOpenFailed', { error: result.error || 'unknown error' }), 'warn', 4000);
      }
    });

    dismissBtn.addEventListener('click', () => {
      applyDecision(bannerState.onDismiss());
    });

    // Subscribe to live state transitions.
    window.funsync.onBackendStatus(({ state, detail }) => render(state, detail));

    // First paint — query current state in case the backend died before
    // the renderer had subscribed (subscription is event-only; misses
    // any transition that already happened).
    window.funsync.getBackendHealth?.().then((health) => {
      // Older shape was a bare string; current shape is { state, detail }.
      const state = typeof health === 'string' ? health : health?.state;
      const detail = typeof health === 'string' ? null : health?.detail;
      if (state && state !== 'unknown') render(state, detail);
    }).catch(() => { /* ignore — IPC may not be ready yet */ });
  }


  /**
   * Fire a short test pulse to the given device — called from the custom
   * routing modal's "▶ test" button so users can confirm they picked the
   * right hardware before saving. Each device type gets an appropriate
   * nudge (linear devices stroke, vibrate/scalar devices buzz briefly).
   *
   * @param {string} deviceId — 'handy' | 'tcode' | 'autoblow' | 'buttplug:<name>'
   * @param {number} [buttplugIndex] — when deviceId is a buttplug route,
   *   the stored Intiface index (we match by it first for stability).
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async _testDevice(deviceId, buttplugIndex) {
    console.log(`[TestDevice] Pulse request for ${deviceId}` +
      (Number.isFinite(buttplugIndex) ? ` (index ${buttplugIndex})` : ''));

    if (deviceId === 'handy') {
      if (!this.handyManager?.connected) return { ok: false, reason: t('deviceTest.handyNotConnected') };
      try {
        // HandyManager wraps the raw SDK hdsp() — use the wrapper, not the
        // private SDK object. Arguments are (position%, durationMs).
        await this.handyManager.hdspMove(70, 500);
        await new Promise(r => setTimeout(r, 550));
        await this.handyManager.hdspMove(20, 500);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || t('deviceTest.handyFailed') };
      }
    }

    if (deviceId === 'tcode') {
      if (!this.tcodeManager?.connected) return { ok: false, reason: t('deviceTest.tcodeNotConnected') };
      try {
        // L0 stroke: 700→200 over ~500ms. Value scale is 000–999.
        await this.tcodeManager.send('L0700I500\n');
        await new Promise(r => setTimeout(r, 550));
        await this.tcodeManager.send('L0200I500\n');
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || t('deviceTest.tcodeFailed') };
      }
    }

    if (deviceId === 'autoblow') {
      if (!this.autoblowManager?.connected) return { ok: false, reason: t('deviceTest.autoblowNotConnected') };
      // No standalone pulse command on the Autoblow cloud API — best we can
      // do is tell the user we know about it but can't test without a script.
      return { ok: false, reason: t('deviceTest.autoblowNoPulse') };
    }

    if (deviceId?.startsWith('buttplug:')) {
      if (!this.buttplugManager?.connected) return { ok: false, reason: t('deviceTest.intifaceNotConnected') };
      // Match by index first (stable), then name — same priority as routing.
      const bpDevices = this.buttplugManager.devices;
      let dev = null;
      if (Number.isFinite(buttplugIndex)) {
        dev = bpDevices.find(d => d.index === buttplugIndex);
        if (dev && `buttplug:${dev.name}` !== deviceId) dev = null; // name must confirm
      }
      if (!dev) dev = bpDevices.find(d => `buttplug:${d.name}` === deviceId);
      if (!dev) return { ok: false, reason: t('deviceTest.deviceNotConnected', { name: deviceId.replace(/^buttplug:/, '') }) };

      // Every send* now REPORTS its outcome rather than only logging it, so
      // a failed command can no longer be reported to the user as a passing
      // test. Previously they swallowed into _warnOnce and returned
      // undefined, which is how a device could sit inert while the button
      // said it worked (adventurous1, thread #274).
      const check = (result) => (!result || result.ok !== false)
        ? null
        : { ok: false, reason: result.error || t('deviceTest.buttplugFailed') };

      try {
        let r;
        if (dev.canLinear) {
          r = await this.buttplugManager.sendLinear(dev.index, 70, 500);
          if (check(r)) return check(r);
          await new Promise(res => setTimeout(res, 550));
          r = await this.buttplugManager.sendLinear(dev.index, 20, 500);
        } else if (dev.canOscillate) {
          // Flywheel machines need enough power to break stiction or the
          // test proves nothing — see testOscillate(). Respects the user's
          // safety cap.
          const cap = this.buttplugSync?.getMaxIntensity?.(dev.index) ?? 100;
          r = await this.buttplugManager.testOscillate(dev.index, cap);
        } else if (dev.canScalar) {
          r = await this.buttplugManager.sendScalar(dev.index, 30);
          if (check(r)) return check(r);
          await new Promise(res => setTimeout(res, 500));
          r = await this.buttplugManager.sendScalar(dev.index, 0);
        } else if (dev.canVibrate) {
          r = await this.buttplugManager.sendVibrate(dev.index, 50);
          if (check(r)) return check(r);
          await new Promise(res => setTimeout(res, 500));
          r = await this.buttplugManager.sendVibrate(dev.index, 0);
        } else if (dev.canRotate) {
          r = await this.buttplugManager.sendRotate(dev.index, 50, true);
          if (check(r)) return check(r);
          await new Promise(res => setTimeout(res, 500));
          r = await this.buttplugManager.sendRotate(dev.index, 0, true);
        } else {
          return { ok: false, reason: t('deviceTest.noTestableOutput') };
        }
        return check(r) || { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || t('deviceTest.buttplugFailed') };
      }
    }

    return { ok: false, reason: t('deviceTest.unknownDevice', { id: deviceId }) };
  }

  _registerKnownDevice(id, label, type, extras = {}) {
    const devices = this.settings.get('knownDevices') || [];

    // For Buttplug devices, persist each physical device as a distinct entry
    // by appending the Intiface deviceIndex to the id. Without this, two
    // same-name devices (e.g. two OG Handys, both reported as "The Handy"
    // over BT) collapsed into a single knownDevices entry — the routing
    // modal showed only one option and two-device custom routing couldn't
    // be saved. `route.deviceId` stays name-only (`buttplug:Name`); the
    // `buttplugIndex` field on both the route and the knownDevice carries
    // the disambiguation.
    if (type === 'buttplug' && typeof extras.buttplugIndex === 'number') {
      id = `buttplug:${label}#${extras.buttplugIndex}`;
      extras.name = label;
      // Legacy cleanup: old builds stored a single `buttplug:${name}` entry
      // without an index suffix. Drop it on first composite registration
      // so the routing dropdown doesn't list a ghost option.
      const legacyIdx = devices.findIndex(d => d.id === `buttplug:${label}`);
      if (legacyIdx >= 0) devices.splice(legacyIdx, 1);
    }

    const existing = devices.find(d => d.id === id);
    if (existing) {
      let dirty = false;
      if (existing.label !== label) { existing.label = label; dirty = true; }
      for (const [k, v] of Object.entries(extras)) {
        if (v !== undefined && existing[k] !== v) { existing[k] = v; dirty = true; }
      }
      if (dirty) this.settings.set('knownDevices', devices);
    } else {
      devices.push({ id, label, type, ...extras });
      this.settings.set('knownDevices', devices);
    }

    // Disambiguate labels when 2+ buttplug entries share a name. Each one
    // gets `Name (device #N)` so the routing dropdown is unambiguous. If
    // only one exists, keep the clean bare name.
    if (type === 'buttplug') {
      this._relabelButtplugNameCollisions(devices, label);
    }
  }

  /**
   * Update labels for every `buttplug`-type knownDevice that shares the
   * given name. If 2+ share it, suffix each with `(device #N)`; if only
   * one, clear the suffix and use the plain name. Writes settings only
   * when something changes.
   */
  _relabelButtplugNameCollisions(devices, name) {
    const sameName = devices.filter(d => d.type === 'buttplug' && d.name === name);
    let changed = false;
    if (sameName.length > 1) {
      for (const d of sameName) {
        const want = `${name} (device #${d.buttplugIndex})`;
        if (d.label !== want) { d.label = want; changed = true; }
      }
    } else if (sameName.length === 1) {
      if (sameName[0].label !== name) { sameName[0].label = name; changed = true; }
    }
    if (changed) this.settings.set('knownDevices', devices);
  }

  /**
   * Find the knownDevice entry that corresponds to a given route.
   * Handles both new composite-id format and legacy name-only ids:
   *   - Buttplug + buttplugIndex present → match by name + index.
   *   - Exact id match (handy, tcode, autoblow, legacy buttplug).
   *   - Buttplug fallback by name-only when nothing else matches.
   */
  _findKnownDeviceForRoute(route) {
    const devices = this.settings.get('knownDevices') || [];
    if (!route?.deviceId) return null;

    if (route.deviceId.startsWith('buttplug:') && Number.isFinite(route.buttplugIndex)) {
      const name = route.deviceId.slice('buttplug:'.length);
      const byComposite = devices.find(d =>
        d.type === 'buttplug' && d.name === name && d.buttplugIndex === route.buttplugIndex
      );
      if (byComposite) return byComposite;
    }

    const byExact = devices.find(d => d.id === route.deviceId);
    if (byExact) return byExact;

    if (route.deviceId.startsWith('buttplug:')) {
      const name = route.deviceId.slice('buttplug:'.length);
      return devices.find(d => d.type === 'buttplug' && (d.name === name || d.label === name)) || null;
    }
    return null;
  }

  /**
   * Fire-and-forget early register pass carrying only the in-memory
   * groupings (collections, playlists, categories, videoCategories,
   * sources). Runs right after `dataService.init()` + backend port is
   * known, BEFORE the library scan finishes — so the phone remote's
   * Collections / Playlists / Categories tabs populate quickly instead
   * of waiting for the filesystem walk + funscript matching to settle.
   * The `videos` slice is deliberately omitted; the backend's register
   * endpoint treats each key independently, so this leaves `_video_registry`
   * alone until `library.js::_registerWithBackend` pushes the full
   * payload at scan completion.
   */
  _registerGroupingsEarly() {
    if (!this.backendPort) return;
    // Bounded retry, like _registerWithBackend: the backend may still be
    // starting, or busy. Each attempt reads the groupings afresh, and a newer
    // call supersedes this one, so a late retry never re-sends an older
    // snapshot over a newer one.
    const gen = (this._groupingsRegisterGen = (this._groupingsRegisterGen || 0) + 1);
    const attempt = (tryNo) => {
      if (gen !== this._groupingsRegisterGen) return;
      const payload = {
        sources: this.settings.get('library.sources') || [],
        collections: this.settings.get('library.collections') || [],
        playlists: this.settings.getPlaylists ? this.settings.getPlaylists() : [],
        categories: this.settings.getCategories ? this.settings.getCategories() : [],
        videoCategories: (this.settings._cache && this.settings._cache.videoCategories) || {},
      };
      try {
        fetch(`http://127.0.0.1:${this.backendPort}/api/media/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then((res) => {
          if (!res.ok) throw new Error(`register ${res.status}`);
        }).catch(() => {
          if (tryNo < 5) setTimeout(() => attempt(tryNo + 1), 2000);
        });
      } catch { /* ignore */ }
    };
    attempt(0);
  }

  /**
   * Re-send the groupings whenever one changes (V23). HereSphere's
   * `Category:` / `Playlist:` tags and the phone's Playlists / Categories /
   * Collections tabs are built from the last /api/media/register, and only
   * boot and a library scan sent one, so an assignment made in the app did
   * not reach the headset or the phone until the next scan. Every DataService
   * playlist and category mutator emits on the bus, and collections and
   * sources are settings writes, so listening here covers every edit path,
   * present and future. Debounced: a bulk assign is one send, not one per
   * video.
   *
   * A manual VR / Flat override (`library.manualVRType`) is not a grouping:
   * the projection HereSphere and DeoVR are served is read off the video
   * entries themselves, so Mark as VR / Mark as Flat / Reset VR re-send the
   * video list (V68). Measured on the 316-video sandbox that is one 105 KB
   * POST answered in 7-23 ms, with no probe re-run (the entries carry their
   * durations and speed stats). Debounced the same way, so a bulk mark is
   * one send. Nothing is sent before a scan has listed any videos: an empty
   * list would empty the backend's registry, and the scan's own register
   * reads the override map when it sends.
   */
  _wireGroupingsRegister() {
    const schedule = () => {
      clearTimeout(this._groupingsRegisterTimer);
      this._groupingsRegisterTimer = setTimeout(() => {
        this._groupingsRegisterTimer = null;
        this._registerGroupingsEarly();
      }, 400);
    };
    const scheduleVideos = () => {
      clearTimeout(this._videosRegisterTimer);
      this._videosRegisterTimer = setTimeout(() => {
        this._videosRegisterTimer = null;
        if (this.library?._videos?.length) this.library._registerWithBackend();
      }, 400);
    };
    eventBus.on('playlist:changed', schedule);
    eventBus.on('category:changed', schedule);
    eventBus.on('settings:changed', ({ path } = {}) => {
      if (path === 'library.collections' || path === 'library.sources') schedule();
      // An association (made, changed, removed, healed) changes the video's
      // script: the phone and HereSphere read it off the registered entry
      // (FT-045, also in v0.9.2: a removed script stayed on both).
      // A hand-added variation (added, renamed, removed, healed) is in the
      // video's variation list the phone shows (FN-04).
      else if (path === 'library.manualVRType' || path === 'library.associations'
        || path === 'library.manualVariants') scheduleVideos();
    });
    // The phone's Tags filter and the funscript metadata harvest (Round 3).
    this._wireRemoteTags?.();
    // The Stash link's renderer side (Stash S1).
    this._wireStash?.();
  }

  /**
   * The phone's Tags filter (P1 tags, Round 3, 2026-11-18; design (e) "The
   * phone's filter slice"). The desktop merges every tag source once and
   * sends the phone each video's tags (`videoTags`, hidden ones already
   * removed) in its own /api/media/register, re-sent when a tag input
   * changes: your tags, the tags you hid, the EroScripts records, the tag
   * settings, a pairing (it picks the script), or the funscript harvest.
   * The harvest itself is loaded after each scan's new video list (the scan
   * registers the videos, the backend's speed pass reads their scripts) and
   * after a pairing (its script is read then).
   */
  _wireRemoteTags() {
    const schedule = () => this._scheduleRemoteTags();
    eventBus.on('settings:changed', ({ path } = {}) => {
      if (!REMOTE_TAG_SETTING_PATHS.includes(path)) return;
      schedule();
      // The pairing re-registers the videos (400 ms, above); the backend
      // then reads the new script, so ask for its metadata after that.
      if (path === 'library.associations') refreshScriptMeta({ delayMs: 1500 });
    });
    // A harvest arrives in steps (a first pass over thousands of scripts
    // stores some every few seconds): sent at most every 10 s, not per step.
    onScriptMetaChanged(() => this._scheduleRemoteTags({ harvest: true }));
    // A scan's new list (the library replaces `_videos` per scan).
    eventBus.on('library:filtered', () => {
      const videos = this.library?._videos;
      if (!Array.isArray(videos) || !videos.length || videos === this._remoteTagsScanList) return;
      this._remoteTagsScanList = videos;
      refreshScriptMeta({ delayMs: 500 });
      schedule();
    });
    // A script saved from the editor: its metadata may have changed, and
    // the backend's pass checks the scripts only at a registration (a scan,
    // a Refresh, a pairing; r3-fixup), which a save is not. Ask for that
    // one script (the backend stats it and reads it only when it changed;
    // a script the library does not pair is never read). Debounced per
    // path: autosave writes after every pause in editing.
    this._scriptMetaSaveTimers = new Map();
    eventBus.on('funscript:saved', ({ path } = {}) => {
      if (typeof path !== 'string' || !path) return;
      clearTimeout(this._scriptMetaSaveTimers.get(path));
      this._scriptMetaSaveTimers.set(path, setTimeout(() => {
        this._scriptMetaSaveTimers.delete(path);
        getScriptMeta(path);
      }, 1500));
    });
  }

  /**
   * The Stash link's renderer side (Stash S1, DESIGN-stash-s1.md (c), (f),
   * (a) step 8). Main owns the Stash data; stash-store.js keeps the
   * renderer's copy. At start-up the copy is loaded only when Stash is on,
   * which reads main's file and sends nothing to Stash. When main reports a
   * change (a sync, a link, an Undo, a re-home, Remove) the library
   * re-indexes (library.js), the phone's tag slice is sent again and the
   * playing video's Stash markers are drawn again. Turning Stash on or off
   * does the same. "Sync with Stash when FunSync starts" (off by default)
   * is asked of main once, after the first library scan of the session
   * (main runs it only when that setting is on); nothing else here ever
   * starts one.
   */
  _wireStash() {
    initStashStore({
      isEnabled: () => this.settings?.get?.('stash.enabled') === true,
      isSyncOnStart: () => this.settings?.get?.('stash.syncOnStart') === true,
    });
    // Main is the writer of `settings.stash.url` and `trustedCert` (Link,
    // a trusted certificate, a Settings write it normalised): its block goes
    // into the renderer's settings cache without a write back.
    onStashSettingsChanged((block) => {
      if (block == null || typeof block !== 'object' || Array.isArray(block)) return;
      this.settings?.applySavedSetting?.('stash', block);
    });
    onStashChanged(() => {
      this._scheduleRemoteTags();
      this._applyStashMarkers();
    });
    eventBus.on('settings:changed', ({ path } = {}) => {
      if (!isStashSettingPath(path)) return;
      // `stash.enabled` is one of REMOTE_TAG_SETTING_PATHS already; a
      // write of the whole `stash` object is not.
      if (!REMOTE_TAG_SETTING_PATHS.includes(path)) this._scheduleRemoteTags();
      this._applyStashMarkers();
    });
    // The first scan's list (the library replaces `_videos` per scan).
    eventBus.on('library:filtered', () => {
      const videos = this.library?._videos;
      if (!Array.isArray(videos) || videos.length === 0) return;
      stashSyncOnStart(videos);
    });
  }

  /**
   * The playing video's Stash scene markers on the seek bar's chapter strip
   * (Stash S1, Dave's answer 3), next to the script's chapters. Only while
   * Stash is on and the video is linked, from the scene of the link's own
   * server, with the trust check (stash-markers.js). A remote stream has no
   * path and gets none. Called on a video load, when its duration is
   * known, and when the Stash data or the on/off switch changes.
   */
  _applyStashMarkers() {
    const bar = this.progressBar;
    if (!bar || typeof bar.setStashMarkers !== 'function') return;
    if (typeof bar.stashMarkerLabel !== 'function') {
      bar.stashMarkerLabel = (title) => (title
        ? t('player.stashMarker', { title })
        : t('player.stashMarkerUntitled'));
    }
    const path = this._currentIsRemote ? null : this._currentVideoPath;
    let markers = [];
    if (path) {
      const video = this.library?.getVideoByPath?.(path) || null;
      markers = stashMarkersForVideo(stashData(), path, {
        size: video?.size,
        enabled: this.settings?.get?.('stash.enabled') === true,
      });
    }
    const before = this._stashMarkerList || [];
    this._stashMarkerList = markers;
    bar.setStashMarkers(markers);
    // The detached player window draws its own seek bar: it gets them too.
    if (this._playerWindowOpen && (markers.length > 0 || before.length > 0)) {
      const durationMs = Math.round((this.videoPlayer?.duration || 0) * 1000);
      const loaded = this.funscriptEngine?.isLoaded === true;
      window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.CHAPTERS, {
        chapters: loaded ? this.funscriptEngine.getChapters() : [],
        bookmarks: loaded ? this.funscriptEngine.getBookmarks() : [],
        stashMarkers: markers,
        durationMs,
      }));
    }
  }

  /**
   * Debounced: a bulk edit is one send, 400 ms after the last change. A
   * harvest step (`harvest: true`) is sent at most once every 10 s (R3R-6:
   * every step of a first harvest used to post the whole slice, 2.3 MB on
   * a 6,000-video library); a send already on its way reads the newest
   * harvest anyway, and any other change still goes out after 400 ms.
   */
  _scheduleRemoteTags({ harvest = false } = {}) {
    const HARVEST_MS = 10000;
    let wait = 400;
    if (harvest) {
      if (this._remoteTagsTimer) return;
      const since = Date.now() - (this._remoteTagsPostedAt || 0);
      wait = Math.max(400, HARVEST_MS - since);
    }
    clearTimeout(this._remoteTagsTimer);
    this._remoteTagsTimer = setTimeout(() => {
      this._remoteTagsTimer = null;
      this._registerRemoteTags();
    }, wait);
  }

  /**
   * Send the tag slice, with the groupings' bounded retry: each attempt
   * builds it afresh and a newer send supersedes this one's retries, so a
   * late retry never lands older tags over newer ones. Nothing is sent
   * before a scan has listed videos (an empty slice would empty the phone's
   * tags for nothing: the registry it is read against is empty too).
   *
   * The slice is the library's own memoised index (Library._tagIndexMemo,
   * the one the desktop's Tags filter reads), not a second merge, and it is
   * posted only when its text changed since the last send this backend got
   * (r3-fixup R3R-6). Without a library index (tests' stub library) it is
   * merged here as before.
   */
  _registerRemoteTags() {
    if (!this.backendPort) return;
    const gen = (this._remoteTagsGen = (this._remoteTagsGen || 0) + 1);
    const attempt = (tryNo) => {
      if (gen !== this._remoteTagsGen) return;
      const videos = this.library?._videos;
      if (!Array.isArray(videos) || !videos.length) return;
      let body;
      let result = null;
      try {
        const memo = typeof this.library?._tagIndexMemo === 'function' ? this.library._tagIndexMemo() : null;
        result = memo ? memo.get() : null;
        // The same index object: nothing any tag input reads has changed.
        if (result && result === this._remoteTagsSentIndex) return;
        const videoTags = result
          ? remoteTagSliceFromIndex(result.index)
          : buildRemoteTagSlice(videos, {
            userTags: this.settings.get('library.userTags'),
            hiddenTags: this.settings.get('library.hiddenTags'),
            scriptTags: this.settings.get('library.scriptTags'),
            tagSettings: this.settings.get('library.tagSettings'),
            scriptMeta: scriptMetaMap(),
          });
        body = JSON.stringify({ videoTags });
      } catch (err) {
        console.warn('[RemoteTags] could not build the tag slice', err);
        return;
      }
      this._remoteTagsSentIndex = result;
      if (body === this._remoteTagsSentBody) return;   // rebuilt, same tags: the backend has them
      this._remoteTagsSentBody = body;
      this._remoteTagsPostedAt = Date.now();
      const failed = () => {
        // Not delivered: the next schedule (or the retry) sends it again.
        if (this._remoteTagsSentBody === body) {
          this._remoteTagsSentBody = null;
          this._remoteTagsSentIndex = null;
        }
        if (tryNo < 5) setTimeout(() => attempt(tryNo + 1), 2000);
      };
      try {
        fetch(`http://127.0.0.1:${this.backendPort}/api/media/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          if (!res.ok) throw new Error(`register ${res.status}`);
        }).catch(failed);
      } catch { failed(); }
    };
    attempt(0);
  }

  /** A restarted backend holds no tag slice, and its harvest pass runs again. */
  _remoteTagsAfterRestart() {
    this._remoteTagsSentBody = null;    // the new process has nothing: send even an unchanged slice
    this._remoteTagsSentIndex = null;
    this._scheduleRemoteTags();
    refreshScriptMeta({ delayMs: 1500 });
  }

  /**
   * Re-send the library after a backend RESTART (V22). The new process
   * starts with an empty registry, and the only senders were the scan and
   * boot, so after "Restart backend" the headset and the phone saw an empty
   * library until the next scan. A restart is announced as 'restarting' and
   * counts as done at the next 'running', however many 'down's come between.
   * A 'running' after 'down' alone is the same process recovering from being
   * busy, which still holds its registry: re-sending it would only add work
   * to a backend that was just too busy to answer.
   */
  _onBackendStatusForRegistry(state) {
    if (state === 'restarting') { this._backendRestartPending = true; return; }
    if (state !== 'running' || !this._backendRestartPending) return;
    this._backendRestartPending = false;
    this._registerGroupingsEarly();
    if (this.library?._videos?.length) this.library._registerWithBackend();
    this._remoteTagsAfterRestart?.();
  }

  /**
   * Every 30 s: has a source gone offline or come back? (A drive unplugged or
   * plugged in, a NAS asleep.) Toasts the change and locks / unlocks it.
   *
   * It never asked (R3-17, also in v0.9.2): `_refreshCollectionsUI` probes
   * WITHOUT `force`, which hands back the cached answer while the source list
   * is unchanged, so only Recheck ever re-probed and the disconnect /
   * reconnect toasts and the lock could not fire from here (0 `fs.access`
   * calls from the poll, seen live). Now each poll probes afresh, one check
   * per source root, bounded (`SOURCE_POLL_TIMEOUT_MS`), never while a probe
   * is still out, and fail-safe: no answer keeps the state the source had,
   * and only an explicit "not there" locks. A lock prunes nothing: it guards
   * the source's associations (`_isUnderUnavailableSource`).
   */
  async _pollSourceAvailability() {
    const sources = this.settings.get('library.sources') || [];
    if (sources.length === 0) return;
    if (this._sourcePollBusy || (this._sourceProbesInFlight || 0) > 0) return;
    this._sourcePollBusy = true;
    try {
      await this._pollSourceAvailabilityOnce(sources);
    } finally {
      this._sourcePollBusy = false;
    }
  }

  async _pollSourceAvailabilityOnce(sources) {
    const prevUnavailable = this.library?._unavailablePaths || new Set();
    await this._probeSourceReachability(sources, true, {
      keepUnknown: prevUnavailable,
      timeoutMs: SOURCE_POLL_TIMEOUT_MS,
    });
    // Reads the fresh answer from the probe cache.
    await this._refreshCollectionsUI();
    const nowUnavailable = this.library?._unavailablePaths || new Set();

    // Detect changes
    const becameUnavailable = [...nowUnavailable].filter(p => !prevUnavailable.has(p));
    const becameAvailable = [...prevUnavailable].filter(p => !nowUnavailable.has(p));

    if (becameUnavailable.length > 0) {
      const names = sources.filter(s => becameUnavailable.includes(s.path)).map(s => s.name);
      showToast(t('toast.sourceDisconnected', { names: names.join(', ') }), 'warn', 5000);
      // Invalidate library cache
      if (this.library) this.library._lastScanKey = null;
      // If library is the active view, re-render
      if (this._currentView() === 'library') {
        this.library.show(this._getViewEl('library'));
      }
    }

    if (becameAvailable.length > 0) {
      const names = sources.filter(s => becameAvailable.includes(s.path)).map(s => s.name);
      showToast(t('toast.sourceReconnected', { names: names.join(', ') }), 'info', 5000);
      if (this.library) this.library._lastScanKey = null;
      if (this._currentView() === 'library') {
        this.library.show(this._getViewEl('library'));
      }
    }
  }

  /**
   * Called when the Handy device connects (after ConnectionPanel's handler).
   * If a funscript is already loaded, upload it to the cloud and start sync.
   */
  async _onHandyConnected() {
    console.log('[Handy] Device connected — checking for pending funscript...');
    this._updateHandyIndicators('connected');
    this._updateDeviceIndicators();

    // Apply saved stroke zone and offset immediately after connection
    try {
      const slideMin = this.settings.get('handy.slideMin') ?? 0;
      const slideMax = this.settings.get('handy.slideMax') ?? 100;
      const offset = this.settings.get('handy.defaultOffset') || 0;
      await this.handyManager.setStrokeZone(slideMin, slideMax);
      await this.handyManager.setOffset(offset);
      console.log(`[Handy] Applied stroke zone ${slideMin}-${slideMax}, offset ${offset}ms`);
    } catch (err) {
      console.warn('[Handy] Failed to apply saved settings:', err.message);
    }

    if (!this.funscriptEngine.isLoaded || !this.syncEngine) {
      console.log('[Handy] No funscript loaded yet, will upload when funscript loads');
      return;
    }

    await this._uploadAndStartSync();
  }

  /**
   * Update Handy status indicators in both nav bar and player controls.
   */
  _updateHandyIndicators(status) {
    const deviceCount = this._getConnectedDeviceCount();

    // Check if any actual device is connected (not just Intiface server)
    const buttplugDevices = this.buttplugManager?.connected ? this.buttplugManager.devices.length : 0;
    const anyConnected = status === 'connected' || status === 'connecting'
      || status === 'unresponsive' || status === 'slow' || buttplugDevices > 0;
    // `unresponsive` must survive this mapping intact. Folding it into
    // `connected` would restore the exact lie the state exists to stop, and
    // folding it into `disconnected` would be wrong the other way — the
    // session is still up. `slow` is shown as `connecting` here rather than
    // getting a fourth LED colour: amber already means "in progress, wait",
    // which is exactly the situation, and the panel carries the wording.
    const effectiveStatus = status === 'unresponsive'
      ? 'unresponsive'
      : anyConnected
        ? ((status === 'connecting' || status === 'slow') ? 'connecting' : 'connected')
        : 'disconnected';

    // Nav bar LED + text
    if (this.navBar) {
      this.navBar.setHandyStatus(effectiveStatus, deviceCount);
    }

    // Player control button LED
    const led = document.getElementById('handy-led');
    if (led) {
      led.className = 'handy-led';
      if (effectiveStatus === 'connected') {
        led.classList.add('handy-led--connected');
      } else if (effectiveStatus === 'connecting') {
        led.classList.add('handy-led--connecting');
      } else if (effectiveStatus === 'unresponsive') {
        // Deliberately NOT the connected green — this LED sits in the player
        // control bar, which is the one place someone is looking when they
        // notice the device has gone quiet.
        led.classList.add('handy-led--unresponsive');
      }
    }

    // Player control button tooltip
    const btn = document.getElementById('btn-handy');
    if (btn) {
      btn.title = deviceCount === 1 ? t('player.deviceConnectionShortcut') : t('player.devicesConnectionShortcut');
    }
  }

  /**
   * Update device connection indicators for both Handy and Buttplug.
   * Shows green if either is connected.
   */
  _updateDeviceIndicators() {
    const handyConnected = this.handyManager?.connected;
    const buttplugDevices = this.buttplugManager?.connected ? this.buttplugManager.devices.length : 0;
    const deviceCount = this._getConnectedDeviceCount();
    const anyConnected = deviceCount > 0;

    const led = document.getElementById('handy-led');
    if (led) {
      led.className = 'handy-led';
      if (anyConnected) led.classList.add('handy-led--connected');
    }

    if (this.navBar) {
      this.navBar.setHandyStatus(anyConnected ? 'connected' : 'disconnected', deviceCount);
    }

    // Player control button tooltip
    const btn = document.getElementById('btn-handy');
    if (btn) {
      btn.title = deviceCount === 1 ? t('player.deviceConnectionShortcut') : t('player.devicesConnectionShortcut');
    }

    // Top-bar canonical sync chip — aggregates device + script + play
    // state into a single human-readable label.
    this._updatePlayerSyncChip();
  }

  /**
   * Compute the canonical sync state for the player top-bar chip.
   * Single source of truth for "what's syncing" across Handy +
   * Buttplug + TCode + Autoblow + the various sync engines. Called
   * from `_updateDeviceIndicators` and from play/pause / sync-state
   * transitions so the chip always tells the user what's happening.
   *
   * Returns null when the chip should be hidden (e.g. before a video
   * is loaded — there's nothing to sync TO).
   *
   * @returns {{state: string, label: string} | null}
   */
  _computeSyncChipState() {
    // Hidden when no video loaded (the player view itself is hidden too).
    if (!this._currentVideoPath && !this._currentVideoName) return null;

    const deviceCount = this._getConnectedDeviceCount();
    const hasScript = !!this.funscriptEngine?.isLoaded;

    // Aggregate "any sync engine actively driving" — covers Handy
    // (HSSP, played server-side, no client-side _active flag), Buttplug,
    // TCode, Autoblow.
    const isPlaying = this.videoPlayer?.video && !this.videoPlayer.video.paused
                      && !this.videoPlayer.video.ended;
    const syncActive = !!(this.buttplugSync?._active
                          || this.tcodeSync?._active
                          || this.autoblowSync?._active
                          || (this.handyManager?.connected && hasScript && isPlaying));

    if (deviceCount === 0) {
      return { state: 'idle', label: t('syncChip.noDevices') };
    }
    if (!hasScript) {
      return { state: 'idle', label: t('syncChip.noScript') };
    }
    if (syncActive) {
      const label = deviceCount === 1
        ? t('syncChip.syncing')
        : t('syncChip.syncingDevices', { count: deviceCount });
      return { state: 'syncing', label };
    }
    return { state: 'ready', label: t('syncChip.ready') };
  }

  _updatePlayerSyncChip() {
    const chip = document.getElementById('player-sync-chip');
    const text = document.getElementById('player-sync-chip-text');
    if (!chip || !text) return;
    const compact = this._computeSyncChipState();
    if (!compact) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.dataset.state = compact.state;
    if (text.textContent !== compact.label) text.textContent = compact.label;
  }

  /**
   * Count total connected devices across Handy and Buttplug.
   */
  _getConnectedDeviceCount() {
    let count = 0;
    if (this.handyManager?.connected) count += 1;
    if (this.buttplugManager?.connected) count += this.buttplugManager.devices.length;
    if (this.tcodeManager?.connected) count += 1;
    if (this.autoblowManager?.connected) count += 1;
    return count;
  }

  /**
   * Start Buttplug sync if conditions are met:
   * - Buttplug connected with at least one device
   * - Funscript loaded
   * - Sync not already active
   */
  _tryStartButtplugSync() {
    if (!this.buttplugSync || !this.buttplugManager?.connected) return;
    if (!this.funscriptEngine.isLoaded && !this.buttplugSync.hasVibScript) return;

    const devices = this.buttplugManager.devices;
    if (devices.length === 0) return;

    // If already active, just reload actions (video/script may have changed)
    if (this.buttplugSync._active) {
      this.buttplugSync.reloadActions();
      return;
    }

    // Restore saved per-device settings before starting
    if (this.connectionPanel) {
      this.connectionPanel._loadButtplugDeviceSettings();
    }

    console.log(`[Buttplug] Starting sync — ${devices.length} device(s)`);
    this.buttplugSync.start();
  }

  /**
   * Devices > T-Code > Go home (#384 uhntiss, #389 kissenpirat; Dave
   * 2026-11-20). A playing video is paused first, or its next keyframe takes
   * the axes straight back: the player pop-out through its relay, this
   * window's video directly. A phone or headset driving playback cannot be
   * paused from here, so that is refused with a toast instead of homing
   * under a running engine. The move itself: TCodeSync.goHome.
   * @returns {Promise<{sent: boolean, reason?: string}>}
   */
  async _tcodeGoHome() {
    if (!this.tcodeSync || !this.tcodeManager?.connected) return { sent: false, reason: 'not-connected' };
    const player = this.tcodeSync.player;
    const paused = player ? (player.paused ?? player.video?.paused) : true;
    if (paused === false) {
      if (this._playerWindowActive) {
        this._playerWindowPlayback('pause');
      } else if (player === this.videoPlayer) {
        this.videoPlayer.video?.pause();
      } else {
        showToast(t('toast.tcodeGoHomePauseFirst'), 'warn', 5000);
        return { sent: false, reason: 'driven-elsewhere' };
      }
      // Let the pause reach the engine before the frame goes out.
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.tcodeSync.goHome();
  }

  /**
   * Force a clean re-arm of the Buttplug sync engine at the current
   * playback position. Fixes the community-reported state (VacuGlide2,
   * post internet-dropout) where the device stays connected and the
   * script loads showing "ready", but sits idle until the user swaps
   * videos or reconnects.
   *
   * A plain reloadActions() only resets action indices — it does NOT
   * restart the scheduler, so an engine stuck `_active` with a dead
   * scheduler wouldn't recover. Stopping first guarantees start() takes
   * the fresh-arm path (reset indices + restart scheduler when playing).
   * The engine reads player.currentTime live each tick, so no seek is
   * needed — it re-engages at the current position.
   *
   * @returns {boolean} true if a connected device was available to re-arm.
   */
  _resyncButtplug() {
    if (!this.buttplugSync || !this.buttplugManager?.connected) return false;
    if ((this.buttplugManager.devices?.length || 0) === 0) return false;
    if (this.buttplugSync._active) this.buttplugSync.stop();
    this._tryStartButtplugSync();
    return true;
  }

  _tryStartTCodeSync() {
    if (!this.tcodeSync || !this.tcodeManager?.connected) return;
    if (!this.funscriptEngine.isLoaded) return;

    if (this.tcodeSync._active) {
      this.tcodeSync.reloadActions();
      return;
    }

    console.log('[TCode] Starting sync');
    this.tcodeSync.start();
  }

  async _tryStartAutoblowSync() {
    // Every exit path resolves the gate so a caller that marked
    // 'autoblow' pending (e.g. _playFromLibrary with autoplay-on-advance)
    // isn't stuck behind the loading overlay if the upload short-
    // circuits, disconnects, or fails. Resolve is idempotent; calls
    // when nothing was marked are no-ops.
    const loadGen = this._videoLoadGen;
    if (!this.autoblowSync || !this.autoblowManager?.connected) {
      this._resolveCloudUpload('autoblow');
      return;
    }
    if (!this.funscriptEngine.isLoaded) {
      this._resolveCloudUpload('autoblow');
      return;
    }

    // Upload the funscript if not already uploaded
    if (!this.autoblowSync.scriptReady) {
      const rawContent = this.funscriptEngine.getRawContent();
      if (!rawContent) {
        this._resolveCloudUpload('autoblow');
        return;
      }
      // Apply Range Extender + output cutoff at upload time for Autoblow.
      // Same reason as Handy HSSP: cloud-script-upload model, no per-tick
      // hook. extend → fill → clamp (`_autoblowUploadContent`, which every
      // Autoblow upload goes through since FT-113), on the timeline the
      // engine is bound to (a phone's, while the phone drives it), and for
      // this window's video once its length is known (FT-113 race).
      const durationMs = this._uploadDurationMsFor(this.autoblowSync.player);
      if (durationMs === undefined && this._localDurationPending?.()) {
        await this._whenLocalDurationKnown();
        if (this._videoLoadGen !== loadGen) return;   // that video's own load uploads
      }
      const uploadContent = this._autoblowUploadContent(rawContent, { durationMs });
      const upload = this.autoblowSync.uploadScript(uploadContent);
      // This call's number: uploadScript takes it before its first await.
      const uploadSeq = this.autoblowSync.uploadSeq;
      const ok = await upload;
      // Another video loaded while this uploaded (FN-01, also in v0.9.2):
      // starting now ran the OLD script under the new video, a video with no
      // script too, and resolving lifted the new video's autoplay gate
      // early. That video's own load decides; the old script is not ready
      // for it (unless that load has already started the engine on its own).
      if (this._videoLoadGen !== loadGen) {
        console.log('[Autoblow] Upload finished after the video changed — not starting it');
        if (!this.autoblowSync._active) this.autoblowSync._scriptReady = false;
        return;
      }
      // A newer upload took over (a variant switch; FT-116's Autoblow half):
      // it owns the device and the gate, so this `false` is "not mine", not
      // a failure.
      if (uploadSeq != null && this.autoblowSync.uploadSeq !== uploadSeq) {
        console.log('[Autoblow] Upload superseded by a newer one — leaving the device to it');
        return;
      }
      if (!ok) {
        this._resolveCloudUpload('autoblow');
        return;
      }
    }

    if (!this.autoblowSync._active) {
      console.log('[Autoblow] Starting sync');
      this.autoblowSync.start();
    }
    this._resolveCloudUpload('autoblow');
  }

  /**
   * Auto-connect to Handy using a saved connection key.
   */
  async _autoConnectHandy(key) {
    console.log('[Handy] Auto-connecting with saved key...');
    this._updateHandyIndicators('connecting');

    try {
      const success = await this.handyManager.connect(key);
      if (success) {
        console.log('[Handy] Auto-connect successful');
        // The onConnect callback will handle the rest (indicators + sync)
      } else {
        console.warn('[Handy] Auto-connect failed');
        showToast(t('toast.handyAutoFailed'), 'warn');
        this._updateHandyIndicators('disconnected');
      }
    } catch (err) {
      console.warn('[Handy] Auto-connect error:', err.message);
      this._updateHandyIndicators('disconnected');
    }
  }

  /**
   * Auto-connect to Buttplug/Intiface Central on startup.
   * Silently tries to connect — no error toast if Intiface isn't running.
   */
  async _autoConnectButtplug() {
    const savedPort = this.settings.get('buttplug.port') || 12345;
    console.log(`[Buttplug] Auto-connecting to Intiface on port ${savedPort}...`);

    try {
      const success = await this.buttplugManager.connect(savedPort);
      if (success) {
        console.log('[Buttplug] Auto-connect successful, scanning for devices...');
        this._updateDeviceIndicators();
        // Auto-scan for devices
        await this.buttplugManager.startScanning();
        // The onDeviceAdded callback will handle sync start + indicator updates
      } else {
        console.log('[Buttplug] Intiface not running — skipping auto-connect');
      }
    } catch (err) {
      // Silent failure — Intiface may not be running
      console.log('[Buttplug] Auto-connect skipped:', err.message);
    }
  }

  /**
   * Upload the current funscript to the Handy cloud and start HSSP sync.
   */
  /**
   * Read a single-device output cutoff {min,max} from settings, or null if
   * unset / a no-op (0-100). Used for cloud devices (Handy, Autoblow) that
   * clamp script content pre-upload, and to feed the Handy HDSP per-tick
   * engine. `key` is the settings namespace, e.g. 'handy' or 'autoblow'.
   */
  _cutoffFromSettings(key) {
    const c = this.settings?.get?.(`${key}.cutoff`);
    if (!c || !Number.isFinite(c.min) || !Number.isFinite(c.max)) return null;
    if (c.min === 0 && c.max === 100) return null;  // no-op
    return { min: c.min, max: c.max };
  }

  /**
   * Handy invert (#276 alvinchris, promised in #277; #390 lonelyuber).
   * `handy.inverted` — strictly `true` to flip, so a missing or odd value
   * is off (default false in electron/store.js DEFAULTS).
   */
  _handyInverted() {
    return this.settings?.get?.('handy.inverted') === true;
  }

  /**
   * The Handy invert toggle changed. HDSP flips on its next tick. HSSP plays
   * an uploaded script, so the flip is baked into the upload: re-arm now
   * when the Handy is playing the main script of the local player (stop →
   * upload → start, the editor's re-upload pattern; start() re-anchors at
   * the current time when playing). Anything else (VR, phone, pop-out,
   * a custom-routing route, the Orgasm Switch holding) picks it up on the
   * next load — the Range Extender / output-limits model.
   *
   * At a non-1× rate the per-tick HDSP engine is driving and flips live.
   * The flipped HSSP script is STAGED at once (uploaded and cached, the
   * device untouched), so the 1× restart's "setup lost" path sets it. The
   * `playback:rate-changed` hook re-arms only if staging was still in
   * flight when the rate went back to 1× (the restart then used the old
   * URL). Re-arming after every 1× restart instead raced the restart's own
   * setScript (Dave's Handy, 2026-11-04: ~2.5 s in the old direction).
   * @returns {Promise<'rearmed'|'hdsp-live'|'next-load'|'idle'>}
   */
  async _onHandyInvertChanged() {
    const inverted = this._handyInverted();
    console.log(`[Handy] Invert ${inverted ? 'on' : 'off'}`);
    this.handyHdspSync?.setInverted(inverted);
    if (this.handyHdspSync?.active) {
      const stage = { settled: false, result: null };
      stage.promise = this._stageHandyMainScript(inverted).then((r) => {
        stage.settled = true;
        stage.result = r;
        return r;
      });
      this._handyInvertStage = stage;
      await stage.promise;
      return 'hdsp-live';
    }
    return this._rearmHandyIfInvertStale();
  }

  /** True when the Handy plays the main script of the local player. */
  _handyOnLocalMain() {
    const p = this.syncEngine?.player;
    // The local player comes in two shapes: init() gives SyncEngine the
    // <video> element, the proxy-restore paths hand it the VideoPlayer
    // wrapper (`const localPlayer = this.videoPlayer`). Both are local.
    return !!(this.syncEngine
      && p && (p === this.videoPlayer || p === this.videoPlayer?.video)
      && !this._orgasmHandyEngaged
      && this._scriptCloudUrl
      && this.handyManager?._lastCloudUrl === this._scriptCloudUrl);
  }

  /**
   * Upload the main script in the current invert direction and make it the
   * cached one, without touching the device (it is in HDSP).
   * @returns {Promise<'staged'|'next-load'|'idle'|'failed'>}
   */
  async _stageHandyMainScript(inverted) {
    if (!this.handyManager?.connected || !this.funscriptEngine?.isLoaded) return 'idle';
    if (this._scriptCloudUrlInverted === inverted) return 'idle';
    if (!this._handyOnLocalMain()) return 'next-load';
    const raw = this.funscriptEngine.getRawContent();
    if (!raw) return 'idle';
    const url = await this.handyManager.stageScript?.(this._handyUploadContent(raw, inverted));
    // A second toggle while uploading: keep the cache honest, let the 1×
    // hook (or the next toggle) sort out the newer value.
    if (!url || this._handyInverted() !== inverted) return 'failed';
    this._scriptCloudUrl = url;
    this._scriptCloudUrlInverted = inverted;
    return 'staged';
  }

  /** `playback:rate-changed` → 1×: see `_onHandyInvertChanged`. */
  async _onHandyRateBackToOne() {
    const stage = this._handyInvertStage;
    this._handyInvertStage = null;
    if (stage && !stage.settled) {
      // The 1× restart already re-set the OLD cached URL; once the staged
      // upload lands, re-arm onto it.
      await stage.promise;
    } else if (stage && stage.result === 'staged') {
      return 'staged';  // the restart set the staged script itself
    }
    return this._rearmHandyIfInvertStale({ force: !!stage && stage.result === 'staged' });
  }

  /**
   * Re-upload the main script when the Handy holds it in the other
   * direction. See `_onHandyInvertChanged` for when this is safe.
   * `force`: re-arm even though the cache already matches (a staged upload
   * landed after the 1× restart had re-set the old URL on the device).
   * @returns {Promise<'rearmed'|'next-load'|'idle'>}
   */
  async _rearmHandyIfInvertStale({ force = false } = {}) {
    if (!this.handyManager?.connected || !this.funscriptEngine?.isLoaded) return 'idle';
    if (!this._scriptCloudUrl) return 'idle';
    if (!force && this._scriptCloudUrlInverted === this._handyInverted()) return 'idle';
    if (!this._handyOnLocalMain()) return 'next-load';
    try {
      this.syncEngine.stop();
      await this._uploadAndStartSync();
      return 'rearmed';
    } catch (err) {
      console.warn('[Handy] Invert re-arm failed:', err?.message || err);
      return 'next-load';
    }
  }

  /**
   * Orgasm Switch key callback (keyboard X). active=true on press, false on
   * release. Behaviour depends on `player.orgasmSwitchMode`:
   *   - 'hold'   (default): hold to ride the looping script, release snaps back
   *              to the main funscript (edging model — the original behaviour).
   *   - 'toggle' (finish):  first press starts the looping finisher; a second
   *              press stops the device(s) and does NOT return to the main
   *              script. Key release is ignored.
   */
  _onOrgasmHold(active, { forceToggle = false } = {}) {
    if (!this.orgasmSwitch) return;
    // An Edge hold (Z) must yield before the finisher arms: X's activation
    // records which engines IT stopped so its release can restart exactly
    // those — arming it while Edge already stopped them would record none
    // and strand the engines on release. Restart them here (skipping the
    // Handy resume — the finisher takes the Handy over immediately, and an
    // in-flight resync() racing the engage's script swap could yank the
    // device mid-finisher), then let X's activation stop them properly.
    if (active && this._edgeActive) this._onEdgeHold(false, { skipHandyResume: true, force: true });
    // A Settings Test running (pf-fixup): X takes the devices, the test ends.
    if (active && (this._fillerTest?.running || this._handyTest)) this._fillerTest?.stop();
    // "Follow the script" (2026-11-19): the finisher's band is the script's
    // range around now, rebuilt here when it has moved.
    if (active) this._orgasmFollowScriptNow?.();
    // A GLOBAL hotkey has no reliable key-up — the OS only tells us the
    // accelerator fired — so it always behaves as press-to-toggle whatever
    // the in-app setting says. A hold you cannot release would strand a
    // device running with the window not even on screen (Eroto #316).
    const mode = forceToggle
      ? 'toggle'
      : (this.settings?.get?.('player.orgasmSwitchMode') || 'hold');

    if (mode === 'toggle') {
      if (!active) return; // ignore release — this is a press-to-toggle mode
      if (this.orgasmSwitch.active) {
        this._finishOrgasm();
      } else {
        const result = this.orgasmSwitch.activate();
        if (result === 'not-configured') {
          showToast(t('toast.orgasmNotConfigured'), 'info', 3500);
        } else if (result === 'activated') {
          // Started as a toggle (the setting, or a global hotkey): only
          // another press lets go of it, so a video change ends it
          // (loadVideo, Dave 2026-11-19).
          this._orgasmToggled = true;
          this._maybeToastOrgasmDemotion();
        }
      }
      return;
    }

    // Hold-to-ride (edging) — original behaviour.
    if (active) {
      const result = this.orgasmSwitch.activate();
      if (result === 'not-configured') {
        showToast(t('toast.orgasmNotConfigured'), 'info', 3500);
      } else if (result === 'activated') {
        this._orgasmToggled = false;
        this._maybeToastOrgasmDemotion();
      }
    } else {
      this.orgasmSwitch.deactivate();
    }
  }

  /**
   * Surface the custom→single demotion ONCE per distinct missing-device
   * set, and only at activation (a launch-time toast before the user has
   * even connected their devices would just be noise). The latch clears
   * when the plan promotes back to custom, so a later demotion re-toasts.
   */
  _maybeToastOrgasmDemotion() {
    if (!this._orgasmDemotionKey) return;
    if (this._orgasmDemotionKey === this._orgasmDemotionToastShownKey) return;
    this._orgasmDemotionToastShownKey = this._orgasmDemotionKey;
    showToast(
      t('toast.orgasmRoutingFallback', { devices: (this._orgasmMissingDevices || []).join(', ') }),
      'warn',
      4500,
    );
  }

  /**
   * Finish-mode stop: end the orgasm loop and STOP all devices without handing
   * control back to the main funscript. Sets `_orgasmFinishStop` so the
   * controller's onDeactivate skips the normal main-engine restart.
   */
  _finishOrgasm() {
    this._orgasmFinishStop = true;
    this.orgasmSwitch.deactivate();
  }

  /**
   * Stop all connected devices and leave them idle — used when finishing (the
   * orgasm loop drove Buttplug/T-Code directly, so their last command would
   * otherwise hold at full intensity/position). The Handy is playing the
   * tiled finisher via HSSP and is stopped separately by the sequenced
   * releaseHandyFinisher (hsspStop) in onDeactivate's finish branch.
   */
  _stopAllDevicesIdle() {
    try { if (this.buttplugManager?.connected) this.buttplugManager.stopAll(); } catch { /* best-effort */ }
    try { if (this.tcodeManager?.connected) this.tcodeManager.stop(); } catch { /* best-effort */ }
  }

  /**
   * Main holds a close, quit, reload, update install or relaunch because the
   * editor reported unsaved edits (R3-19, electron/unsaved-edits-guard.js).
   * Acknowledge at once (main lets the action go ahead when no
   * acknowledgement comes within 10 s, so a hung page never traps the user),
   * then ask the CB-01 question (Save / Don't save / Cancel; with autosave
   * on, the pending write is flushed instead) and answer go or not. No
   * engine reload or Handy re-upload on Save: the page is going away.
   * Anything that throws lets the action go ahead, for the same reason.
   *
   * A question main has stopped waiting for is never asked (R4 fix-up,
   * real-app verifier 2): busy past main's 10 s, this page got to it after
   * the action had gone ahead (an Import that had already failed), and
   * Don't save threw the edits away for nothing. Reached after `expiresAt`,
   * it is dropped; withdrawn by main while open
   * (`_onUnsavedExitAskExpired`), it closes as Cancel.
   * @param {number} token — main's request id, echoed back
   * @param {string} [_reason] — main's, for its log
   * @param {number} [expiresAt] — when main stops waiting for the acknowledgement (ms since epoch)
   */
  async _answerUnsavedBeforeExit(token, _reason, expiresAt) {
    if (this._expiredExitAsks?.has(token)
      || (Number.isFinite(expiresAt) && Date.now() > expiresAt)) {
      console.warn('[Editor] unsaved-edits question arrived after main went ahead without it: not asked');
      return;
    }
    try { window.funsync?.confirmUnsavedAck?.(token); } catch { /* main's timeout decides */ }
    let go = true;
    this._exitAskToken = token;
    try {
      go = (await (this.scriptEditor?.confirmUnsavedChanges?.({ syncEngine: false }) ?? true)) !== false;
    } catch (err) {
      console.warn('[Editor] unsaved-edits question before leaving failed:', err?.message || err);
      go = true;
    } finally {
      if (this._exitAskToken === token) this._exitAskToken = null;
    }
    try { window.funsync?.confirmUnsavedAnswer?.(token, go); } catch { /* main's own checks decide */ }
  }

  /**
   * Main went ahead without this page's answer to question `token` (it was
   * busy past main's 10 s, or unresponsive): an open question closes as
   * Cancel (nothing saved, nothing thrown away), and one not reached yet is
   * never opened (R4 fix-up).
   * @param {number} token
   */
  _onUnsavedExitAskExpired(token) {
    (this._expiredExitAsks ||= new Set()).add(token);
    if (this._exitAskToken === token) this.scriptEditor?.withdrawUnsavedQuestion?.();
  }

  /**
   * A reload or navigation that did not come through main's own routes
   * (DevTools' Ctrl+R / F5, a page-side location change) dropped unsaved
   * editor edits without a question (R4-20, also in v0.9.2). While the editor
   * holds unsaved edits the page holds the unload; Electron reports that to
   * main as 'will-prevent-unload', and main lets it go at once when it would
   * not ask (the user already answered, the page could not ask), or asks the
   * same Save / Don't save / Cancel question and reloads on a "go"
   * (electron/unsaved-edits-guard.js). Main's close, quit and View > Reload
   * routes ask before the unload starts, so a held unload is never shown a
   * second question. The device stops wait for pagehide while held: a
   * Cancel keeps the page, its devices and its connections as they were.
   * @param {BeforeUnloadEvent} e
   */
  _onBeforeUnload(e) {
    let hold = false;
    try { hold = this.scriptEditor?.hasUnsavedChanges?.() === true; } catch { hold = false; }
    if (hold) {
      this._unloadStopsHeld = true;
      // Both, as Electron's docs do it: preventDefault() for the spec, a
      // non-empty returnValue for any Chromium that still wants one. Electron
      // shows no dialog; it emits 'will-prevent-unload' in main.
      e.preventDefault();
      e.returnValue = false;
      return;
    }
    this._unloadStopsHeld = false;
    this._stopEverythingOnUnload?.();
  }

  /** The page is going after all (R4-20): the stops a held beforeunload skipped. */
  _onPageHide() {
    if (!this._unloadStopsHeld) return;
    this._unloadStopsHeld = false;
    this._stopEverythingOnUnload?.();
  }

  /**
   * Pause playback and stop every device because main is about to relaunch
   * the app (Import Backup File, Restore From Backup). That relaunch is
   * app.exit(), which destroys this window without beforeunload, so the
   * stops there never ran: a Handy in HSSP kept playing the script on its
   * own clock with no app left to stop it, and the relaunched app's
   * connect() sends no stop.
   *
   * Resolves once every device has answered its stop, or after 3 s: a device
   * that will not answer must not hold the import hostage (main's own wait
   * is longer).
   */
  async _stopForRelaunch() {
    const STOP_WAIT_MS = 3000;
    // Freeze the clock first so nothing re-anchors a device while the stops
    // are in flight. The pop-out owns the playing <video> while it is active.
    try { this.videoPlayer?.video?.pause?.(); } catch { /* best-effort */ }
    if (this._playerWindowActive) {
      try {
        window.funsync?.playerPopoutRelay?.('to-popout',
          PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: true }));
      } catch { /* best-effort */ }
    }
    // The other thing beforeunload does: keep the position to resume at.
    try { this._recordResumePosition?.({ force: true }); } catch { /* best-effort */ }

    // A running Orgasm Switch drives Buttplug/T-Code from its own loop.
    try { if (this.orgasmSwitch?.active) this._finishOrgasm(); } catch { /* best-effort */ }
    // So does an Edge Hold playing a pattern.
    try { this._dropEdgePattern?.('the app relaunches'); } catch { /* best-effort */ }

    // Engines before devices, so no tick sends a position after the stop.
    for (const engine of [this.syncEngine, this.handyHdspSync, this.buttplugSync, this.tcodeSync, this.autoblowSync]) {
      try { engine?.stop?.(); } catch { /* best-effort */ }
    }

    const stops = [];
    const stop = (fn) => {
      try { stops.push(Promise.resolve(fn())); } catch { /* best-effort */ }
    };
    if (this.handyManager?.connected) stop(() => this.handyManager.hsspStop());
    if (this.buttplugManager?.connected) stop(() => this.buttplugManager.stopAll());
    if (this.tcodeManager?.connected) stop(() => this.tcodeManager.stop());
    if (this.autoblowManager?.connected) stop(() => this.autoblowManager.syncStop());
    if (this.audienceBridge?.roomActive) stop(() => this.audienceBridge.hsspStopAll());

    let timer = null;
    const answered = await Promise.race([
      Promise.allSettled(stops).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), STOP_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    console.log(`[Relaunch] playback paused, ${stops.length} device stop(s) ${answered ? 'answered' : 'still pending after 3 s'}`);
  }

  /**
   * The orgasm config as a normalized association entry (same parallel-slot
   * shape videos use). Falls back to the legacy `player.orgasmScript` string
   * (read-through — normalizeAssociation turns a bare string into a single
   * entry), so pre-0.8.1 configs keep working untouched.
   */
  _getOrgasmEntry() {
    const cfg = this.settings?.get?.('player.orgasmConfig');
    if (cfg) {
      const entry = normalizeAssociation(cfg);
      if (entry.active) return entry;
    }
    const legacy = this.settings?.get?.('player.orgasmScript');
    return legacy ? normalizeAssociation(legacy) : null;
  }

  /**
   * The Orgasm Switch's pattern: the shared choice (pattern-choice.js) when
   * X's source is 'pattern' AND a pattern is chosen; else null (the script
   * file(s) set with Configure… play). Since the pattern settings
   * unification (2026-11-19) the old Generated pattern is the same simple
   * shape at the same strokes a minute, and the library source the same
   * pattern, both read from the old keys while the new ones are absent.
   */
  _orgasmLibrarySettings() {
    return orgasmChoiceInUse(patternChoicePlayer((k) => this.settings?.get?.(k)));
  }

  /**
   * The script's range around now, for a pattern in range mode 'script'
   * ("Follow the script": 30 s either side, pattern-choice.js
   * scriptRangeAround); null with no script (the pattern then measures
   * against the whole 0-100 range).
   */
  _patternScriptRange() {
    const actions = this.funscriptEngine?.getAuthoredActions?.() || this.funscriptEngine?.getActions?.() || [];
    // NOW on the clock that drives playback, as the sync engines are bound
    // to it (pf-review PF-R1, 2026-11-19): a phone's, a headset's or the
    // player pop-out's while one of them plays (this window's <video> is
    // paused under them at the moment the session began, the trap
    // _resumeClockSource documents), else this window's video. Their
    // scripts are the one funscriptEngine holds (each session loads its own).
    let clock = this.videoPlayer?.video || null;
    if (this._remoteActive && this._remoteProxy) clock = this._remoteProxy;
    else if (this._vrPlayerRef) clock = this._vrPlayerRef;
    else if (this._playerWindowActive && this._playerWinProxy) clock = this._playerWinProxy;
    const sec = Number(clock?.currentTime);
    const nowMs = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
    return scriptRangeAround(actions, nowMs);
  }

  /**
   * That pattern's loop for the switch's caches: { key, content, once } (the
   * key has the generated pattern's prefix, so nothing treats it as a file),
   * or null when none is in use or it cannot be rendered (the switch then
   * has no finisher: never the file config's, see _reloadOrgasmScripts).
   */
  _orgasmLibrarySource() {
    const choice = this._orgasmLibrarySettings();
    if (!choice) return null;
    let src = null;
    try {
      src = choiceSource(choice, { scriptRange: choice.rangeMode === 'script' ? (this._patternScriptRange?.() || null) : null });
    } catch (err) {
      console.warn('[OrgasmSwitch] the pattern could not be built:', err?.message || err);
    }
    // `once`: an ending plays once and holds its end (pattern-source.js).
    return src ? { key: src.key, content: src.content, once: src.once } : null;
  }

  /**
   * "Follow the script" for X: the band is the script's range around NOW, so
   * the finisher is rebuilt at the press when that has moved (the same band
   * keeps its cached loop and the Handy's cached upload).
   */
  _orgasmFollowScriptNow() {
    if (this._orgasmLibrarySettings?.()?.rangeMode !== 'script') return;
    const src = this._orgasmLibrarySource?.();
    if (src && src.key !== this._orgasmPatternKey) this._reloadOrgasmScripts?.();
  }

  /**
   * (Re)load every script the orgasm config references into the content/
   * actions caches, then resolve the plan. ALL slots preload (not just the
   * active one) so mode switches and demotion fallbacks never wait on I/O —
   * bounded at ~a dozen small JSON files.
   */
  async _reloadOrgasmScripts(allowRecovery = true) {
    // A pattern (Downlow87 #373's Generated pattern, the library source;
    // since 2026-11-19 the one shared choice, pattern-choice.js): both caches
    // get its loop under one synthetic key, as a single-script entry, so the
    // plan, the per-tick loop and the Handy finisher (which uploads the raw
    // JSON) all work unchanged. No file is read, so there is nothing to
    // recover, and the file configuration is left exactly as saved for
    // switching back. A stored Generated pattern is the same simple shape at
    // the same strokes a minute (and still wins over a library source that
    // is on too, as before).
    const library = this._orgasmLibrarySource?.() || null;
    // An ending from the library plays once, then holds (_refreshOrgasmPlan
    // marks the plan; the Handy gets it untiled). Every other source loops.
    this._orgasmOnce = library?.once === true;
    this._orgasmPatternKey = library ? library.key : null;
    if (library) {
      const key = library.key;
      const raw = library.content;
      const actions = parseFinisherActions(raw);
      this._orgasmEntry = normalizeAssociation(key);
      this._orgasmContentCache = new Map();
      this._orgasmActionsCache = new Map();
      if (actions) {
        this._orgasmContentCache.set(key, raw);
        this._orgasmActionsCache.set(key, actions);
      }
      this._orgasmMissingPaths = new Set();
      this._orgasmCloudUrl = null; // a new pattern → stale upload
      this._refreshOrgasmPlan();
      return;
    }
    // The library is the chosen source but its loop could not be built: the
    // switch stays unconfigured (X says no orgasm script is set). It never
    // plays the file configuration's older script instead (fix-up
    // 2026-11-17, review-1). renderLoop widens a range too narrow for the
    // pattern to move in, so this is a last resort for an engine fault.
    if (this._orgasmLibrarySettings?.()) {
      console.warn('[OrgasmSwitch] the library pattern could not be built: no finisher until it is changed');
      this._orgasmEntry = null;
      this._orgasmContentCache = new Map();
      this._orgasmActionsCache = new Map();
      this._orgasmMissingPaths = new Set();
      this._orgasmCloudUrl = null;
      this._refreshOrgasmPlan();
      return;
    }

    const entry = this._getOrgasmEntry();
    this._orgasmEntry = entry;
    this._orgasmContentCache = new Map();
    this._orgasmActionsCache = new Map();
    if (entry) {
      const paths = collectOrgasmScriptPaths(entry);
      await Promise.all(paths.map(async (p) => {
        try {
          const raw = await window.funsync.readFunscript(p);
          const actions = parseFinisherActions(raw);
          if (actions) {
            this._orgasmContentCache.set(p, raw);
            this._orgasmActionsCache.set(p, actions);
          } else if (raw == null) {
            // readFunscript answers null when it could not read the file at
            // all (missing, or its drive is offline). That is not bad JSON,
            // and the log said it was (FT-059; also in v0.9.2). Log only:
            // the missing-path handling below is unchanged.
            console.warn('[OrgasmSwitch] could not read config script (missing, or its drive is offline):', p);
          } else {
            console.warn('[OrgasmSwitch] config script unusable (bad JSON / < 2 actions):', p);
          }
        } catch (err) {
          console.warn('[OrgasmSwitch] could not read config script:', p, err?.message || err);
        }
      }));

      // A finisher script that MOVED used to fail silently: the settings row
      // kept showing its filename (read from the stored path, never checked)
      // while the switch quietly went unconfigured, so pressing X toasted
      // "no orgasm script set" while the panel said otherwise (Dave
      // 2026-08-05). Try to re-point at it before giving up.
      const missing = collectOrgasmScriptPaths(entry)
        .filter((p) => !this._orgasmActionsCache.has(p));
      if (missing.length > 0 && allowRecovery && (await this._recoverOrgasmPaths(missing))) {
        return this._reloadOrgasmScripts(false); // one retry, never loops
      }
      this._orgasmMissingPaths = new Set(missing);
    } else {
      this._orgasmMissingPaths = new Set();
    }
    this._orgasmCloudUrl = null; // scripts may have changed → stale upload
    this._refreshOrgasmPlan();
  }

  /**
   * Re-point orgasm-config paths at moved files. Unlike the video-side
   * recovery there is no owning directory to search beside, so the library
   * scan's funscript list is the candidate pool — and only an unambiguous
   * single filename match is accepted (see findMovedFile). Ambiguous or
   * absent matches are left broken on purpose; the settings row now shows
   * them as missing rather than pretending.
   *
   * Only a script that is PROVABLY gone is re-pointed (`library._safeToPrune`:
   * not on an offline source, its folder answers, and the file is definitely
   * not in it). "Failed to load" also covers an unplugged drive, a locked
   * file and a script with bad JSON, and re-pointing on any of those
   * overwrote the user's chosen path with whatever same-named file the
   * library held — permanently, since the drive coming back could not undo
   * it. Fails closed: no library to ask, no re-point.
   *
   * @param {string[]} missing — paths that failed to load
   * @returns {Promise<boolean>} true if anything was re-pointed (caller re-reads)
   */
  async _recoverOrgasmPaths(missing) {
    const pool = this.library?.getAllFunscriptPaths?.() || [];
    if (pool.length === 0) return false;
    const entry = this._orgasmEntry;
    if (!entry) return false;

    const remap = new Map();
    for (const p of missing) {
      const found = findMovedFile(pool, p);
      if (!found) continue;
      let gone = false;
      try { gone = !!(await this.library?._safeToPrune?.(p)); } catch { gone = false; }
      if (gone) remap.set(p, found);
      else console.warn(`[OrgasmSwitch] Not re-pointing ${p}: its absence is unproven (drive offline, file locked or unreadable)`);
    }
    // The checks above awaited. If the user changed the config meanwhile, a
    // newer reload owns it now — writing `next` would put the old one back.
    if (this._orgasmEntry !== entry) return false;
    if (remap.size === 0) return false;

    const swap = (p) => (p && remap.has(p) ? remap.get(p) : p);
    const next = buildAssociationEntry(
      entry.active,
      swap(entry.single),
      entry.multi
        ? {
          ...entry.multi,
          main: swap(entry.multi.main),
          axes: Object.fromEntries(
            Object.entries(entry.multi.axes || {}).map(([k, v]) => [k, swap(v)]),
          ),
        }
        : entry.multi,
      entry.custom
        ? {
          ...entry.custom,
          routes: (entry.custom.routes || []).map((r) => (
            r?.scriptPath && remap.has(r.scriptPath)
              ? { ...r, scriptPath: remap.get(r.scriptPath) }
              : r
          )),
        }
        : entry.custom,
    );
    this._saveOrgasmConfigQuiet(next);
    for (const [from, to] of remap) {
      console.log(`[OrgasmSwitch] Re-pointed moved finisher script: ${from} → ${to}`);
    }
    showToast(t('toast.orgasmScriptRecovered', { count: remap.size }), 'info', 4000);
    return true;
  }

  /** Persist an orgasm config entry without the "script set" toast or a
   *  reload (the caller re-reads). Used by the moved-file recovery. */
  _saveOrgasmConfigQuiet(entry) {
    this.settings.set('player.orgasmConfig', entry);
    const mainRoute = entry.custom?.routes?.find?.((r) => r?.role === 'main' && r.scriptPath);
    const legacyPath = entry.active === 'single' ? entry.single
      : entry.active === 'multi' ? (entry.multi?.main || null)
        : (entry.single || mainRoute?.scriptPath || null);
    this.settings.set('player.orgasmScript', legacyPath);
  }

  /**
   * Resolve the orgasm entry + current device connections into a drive plan
   * and load it into the controller. Called on config change and on EVERY
   * device connect/disconnect — that's what makes custom routing demote to
   * single-axis while its devices are missing and promote straight back
   * the moment they're all connected again.
   *
   * Mid-hold: local channels swap live on the running clock
   * (preserveClock); the Handy engage target stays locked until release.
   */
  _refreshOrgasmPlan() {
    if (!this.orgasmSwitch) return;
    const snapshot = {
      buttplugDevices: (this.buttplugManager?.connected && this.buttplugManager.devices) || [],
      tcodeConnected: !!this.tcodeManager?.connected,
      handyConnected: !!this.handyManager?.connected,
    };
    const resolved = resolveOrgasmPlan(
      this._orgasmEntry || null,
      snapshot,
      (p) => this._orgasmActionsCache?.get(p) || null,
    );
    const { demotedFrom, missing } = resolved;
    // An ending from the library: the switch plays it once and holds its
    // end instead of looping (OrgasmSwitch plan.once; _reloadOrgasmScripts).
    const plan = resolved.plan && this._orgasmOnce === true ? { ...resolved.plan, once: true } : resolved.plan;
    this._orgasmPlan = plan;
    if (demotedFrom === 'custom') {
      this._orgasmDemotionKey = missing.slice().sort().join('|');
      this._orgasmMissingDevices = missing;
      console.log(`[OrgasmSwitch] custom routing demoted to single-axis — missing: ${missing.join(', ') || '(unknown)'}`);
    } else {
      // Promoted (or not custom): clear the toast latch so a LATER
      // demotion surfaces again.
      if (this._orgasmDemotionKey && plan?.mode === 'custom') {
        console.log('[OrgasmSwitch] custom routing restored — all routed devices connected');
      }
      this._orgasmDemotionKey = null;
      this._orgasmMissingDevices = null;
      this._orgasmDemotionToastShownKey = null;
    }
    this.orgasmSwitch.loadPlan(plan, { preserveClock: this.orgasmSwitch.active });
    this._pushRemoteOrgasmState?.();
  }

  /**
   * Open the orgasm config modal (single / multi-axis / custom routing —
   * assignment parity with videos) and persist the result.
   */
  async _configureOrgasm() {
    const entry = await openOrgasmConfigModal({
      entry: this._getOrgasmEntry(),
      knownDevices: this.settings?.get?.('knownDevices') || [],
    });
    if (entry === undefined) return; // cancelled
    await this._saveOrgasmConfig(entry);
  }

  /** Persist a new orgasm config entry (null clears) and reload. */
  async _saveOrgasmConfig(entry) {
    if (!entry || !entry.active) { this._clearOrgasmScript(); return; }
    this.settings.set('player.orgasmConfig', entry);
    // Downgrade mirror: older builds only read `player.orgasmScript`
    // (string) — keep it pointing at the closest single-axis equivalent,
    // same philosophy as the association-shape mirror fields.
    const mainRoute = entry.custom?.routes?.find?.((r) => r?.role === 'main' && r.scriptPath);
    const legacyPath = entry.active === 'single' ? entry.single
      : entry.active === 'multi' ? (entry.multi?.main || null)
        : (entry.single || mainRoute?.scriptPath || null);
    this.settings.set('player.orgasmScript', legacyPath);
    await this._reloadOrgasmScripts();
    const d = describeOrgasmEntry(entry);
    if (d) showToast(t('toast.orgasmScriptSet', { name: d.name || '' }), 'info', 2500);
  }

  /**
   * Lines for the Settings row's script block, rendered UNDER the Configure
   * button (inline beside it they were squeezed to nothing).
   *
   * Single mode → one bare filename. Multi / custom → a mode summary line
   * followed by one `{label, name}` line per chosen script, so the user can
   * see WHICH scripts are configured without reopening the modal.
   *
   * @returns {Array<string|{label: string, name: string}>}
   */
  _orgasmSummaryText() {
    // A pattern reads "Pattern: Quick full strokes" (a simple shape too:
    // "Pattern: Sine"; units a second only, so no BPM line since 2026-11-19).
    const library = this._orgasmLibrarySettings?.();
    if (library) {
      return [t('settingsPanel.playback.orgasmSummaryLibrary', { name: t(`patterns.${library.id}.name`) })];
    }
    const entry = this._getOrgasmEntry();
    const d = describeOrgasmEntry(entry);
    if (!d) return [];
    const base = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
    // Mark scripts that failed to load. Without this the row shows a stored
    // filename whether or not the file is still there, so a moved script
    // reads as configured while the switch is actually dead.
    const gone = (p) => !!(p && this._orgasmMissingPaths?.has(p));

    if (d.mode === 'single') {
      return [{ label: null, name: d.name, missing: gone(entry.single) }];
    }

    const lines = [
      d.mode === 'multi'
        ? t('settingsPanel.playback.orgasmSummaryMulti', { count: d.count })
        : t('settingsPanel.playback.orgasmSummaryCustom', { count: d.count }),
    ];

    if (d.mode === 'multi' && entry.multi) {
      if (entry.multi.main) {
        lines.push({
          label: t('library.assoc.axisMain'),
          name: base(entry.multi.main),
          missing: gone(entry.multi.main),
        });
      }
      for (const [suffix, p] of Object.entries(entry.multi.axes || {})) {
        if (!p) continue;
        // Alias-aware: older saved configs key axes by a legacy spelling
        // (`suction`), so an exact-suffix match would fall back to the raw key.
        const def = getAxisBySuffix(suffix);
        lines.push({ label: def?.label || suffix, name: base(p), missing: gone(p) });
      }
    } else if (d.mode === 'custom') {
      for (const r of entry.custom?.routes || []) {
        if (!r?.scriptPath) continue;
        // Device label from knownDevices where possible, so the row reads
        // "Hush: finisher.funscript" rather than "buttplug:Hush: ...".
        const known = this._findKnownDeviceForRoute(r);
        const label = known?.label
          || (r.deviceId?.startsWith('buttplug:') ? r.deviceId.slice('buttplug:'.length) : r.deviceId)
          || t('library.assoc.scriptNone');
        lines.push({
          label,
          name: r.scriptName || base(r.scriptPath),
          missing: gone(r.scriptPath),
        });
      }
    }
    return lines;
  }

  /** Clear the configured orgasm script/config entirely. */
  _clearOrgasmScript() {
    this.settings.set('player.orgasmConfig', null);
    this.settings.set('player.orgasmScript', null);
    this._orgasmEntry = null;
    this._orgasmContentCache = new Map();
    this._orgasmActionsCache = new Map();
    this._orgasmPlan = null;
    this._orgasmCloudUrl = null;
    this._orgasmDemotionKey = null;
    this._orgasmDemotionToastShownKey = null;
    if (this.orgasmSwitch) this.orgasmSwitch.loadPlan(null);
    this._pushRemoteOrgasmState?.();
  }

  /** Open the Load-from-URL (remote video) modal. Shared by the nav-bar
   *  action and the player top-bar button. */
  _openLoadUrlModal() {
    import('../components/remote-video-modal.js').then((mod) => {
      mod.openRemoteVideoModal({ onPlay: (result, scriptPath) => this._loadRemoteVideo(result, scriptPath) });
    });
  }

  /**
   * Play a yt-dlp-resolved remote video (from the Load-from-URL dialog), with
   * an optional manually-attached local funscript. Reuses loadVideo's sync /
   * autoplay / error handling via the `_remote` descriptor; the script (if
   * any) loads onto the now-current video exactly like an EroScripts download.
   *
   * @param {{proxyUrl:string, title?:string, isHls?:boolean}} result
   * @param {string|null} [scriptPath] — local funscript to pair (v1: manual)
   */
  async _loadRemoteVideo(result, scriptPath = null) {
    if (!result?.proxyUrl) return;
    const editorOk = this._editorAllowsReplace(); // CB-01
    if (editorOk !== true && !(await editorOk)) return;
    this.loadVideo({
      name: result.title || t('remoteVideo.untitled'),
      path: result.proxyUrl,
      _remote: true,
      isHls: !!result.isHls,
    });
    if (scriptPath) {
      try {
        const content = await window.funsync.readFunscript(scriptPath);
        if (content) {
          const name = scriptPath.split(/[\\/]/).pop() || 'script.funscript';
          this.loadFunscript({ name, textContent: content, path: scriptPath });
        }
      } catch (err) {
        showToast(t('toast.downloadAutoLoadFailed', { error: err?.message || err }), 'error', 5000);
      }
    }
  }

  /**
   * Restore the Handy after an orgasm-switch hold ends. The orgasm loop drove
   * HDSP (mode 2), which clears HSSP's scriptSet, so we can't just hsspPlay.
   *   - At non-1× playback the normal Handy mode IS HDSP, so just restart the
   *     polled engine — it re-drives hdspMove at video time (no scriptSet needed).
   *   - At 1× we re-establish HSSP: re-set the cached cloud script (fast,
   *     USING_CACHED) then resume at the current video time. Falls back to a
   *     full re-upload if no cached URL exists.
   */
  /**
   * Edge Hold (Z) — the Orgasm Switch's inverse (MattWritesNSFW, EroScripts
   * #301): hold to stop ALL device output while the video keeps playing;
   * release resumes the main script in sync at the current position. Unlike
   * the finisher there is no takeover script, so activation is just "stop
   * engines + idle devices" and release is "restart what we stopped".
   *
   * The Handy needs both halves done explicitly: syncEngine.stop() only
   * kills the renderer's correction loop — HSSP playback lives ON the
   * device, so without hsspStop() it strokes on to the end of the script.
   * Release re-anchors via resync() (start() only anchors when the player
   * reads unpaused at that instant — same unreliability the orgasm restore
   * hit). The main script never left the device, so no re-upload is needed.
   *
   * Refuses to arm while the Orgasm Switch is active: X owns the devices
   * during a finisher, and layering "stop everything" over its restore
   * bookkeeping would corrupt whose job it is to restart what.
   */
  _onEdgeHold(active, { skipHandyResume = false, force = false } = {}) {
    // Press-to-toggle (lr_x3, EroScripts #307). Keyboard still reports Z as
    // a hold — press then release — so in toggle mode the release arrives as
    // active=false and must be ignored, or the edge would end the instant
    // the key came up. `force` is the escape hatch for the internal
    // deactivate from _onOrgasmHold: X arming while Z holds MUST actually
    // release Z (that's what restarts the engines Z stopped, so X's own
    // bookkeeping can record them), and a bare active=false would be
    // swallowed here and strand them.
    const mode = this.settings?.get?.('player.edgeHoldMode') || 'hold';
    if (mode === 'toggle' && !force) {
      if (!active) return;               // release — ignored in toggle mode
      active = !this._edgeActive;        // press flips whatever we're in
    }
    if (!!active === !!this._edgeActive) return;
    if (active && this.orgasmSwitch?.active) return;
    // A Settings Test running (pf-fixup): Z takes the devices, the test ends.
    if (active && (this._fillerTest?.running || this._handyTest)) this._fillerTest?.stop();
    this._edgeActive = !!active;
    this._pushRemoteEdgeState?.(); // the phone's Edge button follows (next major)

    if (active) {
      // "Play a pattern" (Settings > Edge Hold, next major) takes the devices
      // over with a looping pattern instead. Not chosen, or no pattern to
      // build: the devices stop, as always (below).
      if (this._edgePatternStart?.()) return;
      this._edgeStoppedEngines = [];
      if (this.buttplugSync?._active) {
        this.buttplugSync.stop(); this._edgeStoppedEngines.push('buttplug');
      }
      if (this.tcodeSync?._active) {
        this.tcodeSync.stop(); this._edgeStoppedEngines.push('tcode');
      }
      if (this.autoblowSync?._active) {
        this._noteAutoblowForEdge?.();
        this.autoblowSync.stop(); this._edgeStoppedEngines.push('autoblow');
      }
      if (this.syncEngine?._active || this.handyHdspSync?.active) {
        this.syncEngine?.stop();
        if (this.handyHdspSync?.active) this.handyHdspSync.stop();
        this._edgeStoppedEngines.push('handy');
        if (this.handyManager?.connected) {
          this.handyManager.hsspStop().catch(() => { /* best-effort */ });
        }
      }
      // Devices to idle NOW — engine stop() alone leaves sustained outputs
      // (vibrate/rotate) holding their last value, the exact failure the
      // orgasm-switch release fixed on 2026-08-14.
      this._stopAllDevicesIdle();
      try { this.buttplugManager?.stopSustainedOutputs?.(); } catch { /* best-effort */ }
    } else {
      // A pattern hold restores the way the Orgasm Switch's release does.
      if (this._edgePatternOn && this._edgePatternStop) {
        this._edgePatternStop({ skipHandyResume });
        return;
      }
      if (this._edgeStoppedEngines?.includes('buttplug')) this.buttplugSync.start();
      if (this._edgeStoppedEngines?.includes('tcode')) this.tcodeSync.start();
      if (this._edgeStoppedEngines?.includes('autoblow')) {
        this._rearmAutoblowAfterEdge?.();
        this.autoblowSync.start();
      }
      if (this._edgeStoppedEngines?.includes('handy') && !skipHandyResume) {
        this._resumeHandyAfterEdge();
      }
      this._edgeStoppedEngines = [];
    }
  }

  /**
   * The local loop Edge Hold "Play a pattern" drives Buttplug and T-Code
   * with: a second OrgasmSwitch with its own clock, the same output limits,
   * and no Handy (the Handy plays the tiled loop through HSSP, as for the
   * finisher). The device simulator follows it while it plays.
   */
  _makeEdgeLoop() {
    const options = {
      buttplugManager: this.buttplugManager,
      tcodeManager: this.tcodeManager,
      handyManager: null,
      getCutoff: (key) => this._cutoffFromSettings(key),
      // Flywheel machines follow the Edge pattern too, as for X.
      oscillate: (dev, pos, prevPos, ms, startMs) => this.buttplugSync?.oscillateNow?.(dev.index, pos, prevPos, ms, startMs),
    };
    const loop = new OrgasmSwitch(options);
    if (this.deviceSimulator) this.deviceSimulator.edgeLoop = loop;
    return loop;
  }

  /**
   * Edge Hold "Play a pattern" (`player.edgeHoldAction: 'pattern'`, next
   * major): while Z is on, the devices play `player.edgePattern` on their
   * own clock instead of stopping, the video paused or not (as X plays).
   * The takeover mirrors the Orgasm Switch's: the running engines are
   * stopped and recorded as in "stop" mode; Buttplug and T-Code ride the
   * edge loop (one broadcast plan: linear and vibrate, T-Code L0; multi-axis
   * channels and custom routes rest, e-stim stays excluded as for the
   * finisher, flywheel machines follow through the Buttplug engine's
   * oscillate path); the Autoblow has no live path and rests; the Handy
   * plays the tiled loop through HSSP with its own upload cache. An ending
   * (Dave, 2026-11-17) plays once and holds its end, and the Handy gets it
   * untiled.
   * @returns {boolean} false when the mode is 'stop', no pattern is chosen
   *   (the default) or none can be
   *   built: Z then stops the devices as always.
   */
  _edgePatternStart() {
    if (edgeHoldAction(this.settings?.get?.('player.edgeHoldAction')) !== 'pattern') return false;
    // The shared choice (pattern-choice.js, 2026-11-19): player.edgePatternChoice,
    // else the old player.edgePattern as it was stored (never written).
    // "Follow the script" measures the script around now, at the press.
    const pattern = readPatternChoice('edge', patternChoicePlayer((k) => this.settings?.get?.(k)));
    let src = null;
    try {
      src = choiceSource(pattern, { scriptRange: pattern.rangeMode === 'script' ? (this._patternScriptRange?.() || null) : null });
    } catch (err) {
      console.warn('[EdgeHold] pattern could not be built, stopping the devices instead:', err?.message || err);
    }
    const content = src ? src.content : null;
    // No pattern chosen (the default since 2026-11-17): Z stops the devices,
    // exactly as in "stop" mode; Settings says why.
    if (pattern.id === null) console.log('[EdgeHold] no pattern chosen: stopping the devices');
    // An ending plays once from the press, then holds its last position.
    const once = src ? src.once : false;
    const loop = content ? (this._edgeLoop || (this._edgeLoop = this._makeEdgeLoop())) : null;
    if (!loop || !loop.loadScript(content, { once })) return false;

    this._edgePatternOn = true;
    this._edgeStoppedEngines = [];
    if (this.buttplugSync?._active) {
      this.buttplugSync.stop(); this._edgeStoppedEngines.push('buttplug');
    }
    if (this.tcodeSync?._active) {
      this.tcodeSync.stop(); this._edgeStoppedEngines.push('tcode');
    }
    if (this.autoblowSync?._active) {
      this._noteAutoblowForEdge?.();
      this.autoblowSync.stop(); this._edgeStoppedEngines.push('autoblow');
    }
    if (this.syncEngine?._active || this.handyHdspSync?.active) {
      this.syncEngine?.stop();
      if (this.handyHdspSync?.active) this.handyHdspSync.stop();
      this._edgeStoppedEngines.push('handy');
    }
    loop.activate();
    console.log(`[EdgeHold] playing pattern ${pattern.id}`);

    if (this.handyManager?.connected) {
      // Stopped unconditionally, as for the finisher (its `_active` can
      // drift from the engine's bound handlers).
      this.syncEngine?.stop();
      if (this.handyHdspSync?.active) this.handyHdspSync.stop();
      this._edgeHandyEngaged = true;
      const activation = (this._edgeActivationId = (this._edgeActivationId || 0) + 1);
      const isCurrent = () => activation === this._edgeActivationId;
      // The upload bakes in the cutoff and the invert: a cached URL is only
      // good for the same loop, cutoff and invert.
      const cutoff = this._cutoffFromSettings('handy');
      const inverted = this._handyInverted();
      const cacheKey = `${once ? 'once-v1' : 'tiled-v2'}|${src.key}|${JSON.stringify(cutoff ?? null)}|inv=${inverted ? 1 : 0}`;
      if (this._edgeCloudUrl && this._edgeCloudUrlKey !== cacheKey) this._edgeCloudUrl = null;
      const engage = () => engageHandyFinisher({
        handyManager: this.handyManager,
        content,
        cachedUrl: this._edgeCloudUrl,
        cutoff,
        inverted,
        once,
        onUrlCached: (url) => {
          this._edgeCloudUrl = url;
          this._edgeCloudUrlKey = cacheKey;
        },
        isCurrent,
      });
      // A quick re-press: the last release's Handy sequence goes first, and
      // so does an Orgasm Switch release still on its way (Z right after X).
      // Either restore may have started the main engine meanwhile (a press
      // during its setScript does not stop it): stopped again before the
      // loop, as X's engage does after a Z release, and again once the loop
      // plays, so no seek or pause drives the main script under it.
      const priors = [this._edgeReleasePromise, this._orgasmReleasePromise, this._patternTestReleasePromise].filter(Boolean);
      const stopMain = () => {
        this.syncEngine?.stop();
        if (this.handyHdspSync?.active) this.handyHdspSync.stop();
      };
      this._edgeEngagePromise = (priors.length
        ? Promise.all(priors).catch(() => {}).then(() => {
          if (!isCurrent()) return 'stale';
          stopMain();
          return engage();
        })
        : engage())
        .then((status) => {
          if (status === 'looping' && isCurrent()) stopMain();
          // The loop did not start on the Handy: it rests, as in "stop"
          // mode, instead of stroking on through the main script.
          if (status !== 'looping' && status !== 'stale' && isCurrent()) {
            return Promise.resolve(this.handyManager?.hsspStop?.()).catch(() => {}).then(() => status);
          }
          return status;
        });
    }
    return true;
  }

  /**
   * Release of a pattern hold, as the Orgasm Switch's hold-mode release:
   * the loop stops, sustained outputs are zeroed (a vibrator must not hold
   * the loop's last value in an unscripted zone), the recorded local engines
   * restart, and the Handy, once any engage in flight has settled, stops the
   * loop and gets the main script back (`_restoreHandyAfterOrgasm`: its
   * script WAS replaced, so `_resumeHandyAfterEdge` would not do). With
   * `skipHandyResume` (X taking over) or once X or a new Edge hold owns the
   * Handy, the restore is skipped. The Handy sequence is kept as
   * `_edgeReleasePromise`: X's engage and the next Edge engage wait for it.
   */
  _edgePatternStop({ skipHandyResume = false } = {}) {
    this._edgePatternOn = false;
    const gen = (this._edgeActivationId = (this._edgeActivationId || 0) + 1); // an engage in flight goes stale
    try { this._edgeLoop?.deactivate(); } catch { /* best-effort */ }
    try { this.buttplugManager?.stopSustainedOutputs?.(); } catch { /* best-effort */ }
    const stopped = this._edgeStoppedEngines || [];
    this._edgeStoppedEngines = [];
    if (stopped.includes('buttplug')) this.buttplugSync.start();
    if (stopped.includes('tcode')) this.tcodeSync.start();
    if (stopped.includes('autoblow')) {
      this._rearmAutoblowAfterEdge?.();
      this.autoblowSync.start();
    }
    if (this._edgeHandyEngaged) {
      this._edgeHandyEngaged = false;
      const release = Promise.resolve(this._edgeEngagePromise)
        .then(() => releaseHandyFinisher({ handyManager: this.handyManager }))
        .then(() => {
          if (skipHandyResume || gen !== this._edgeActivationId || this.orgasmSwitch?.active) return undefined;
          return this._restoreHandyAfterOrgasm();
        })
        .catch((err) => console.warn('[EdgeHold] Handy restore failed:', err?.message || err));
      this._edgeReleasePromise = release;
      release.then(() => { if (this._edgeReleasePromise === release) this._edgeReleasePromise = null; });
    } else if (stopped.includes('handy') && !skipHandyResume) {
      // The Handy was not connected at the press: Edge's own resume.
      this._resumeHandyAfterEdge();
    }
  }

  /**
   * End a pattern hold without restoring anything: the video changed
   * (FN-01: every device stops at once; the new video's load starts its own
   * engines, and loadVideo stops the Handy) or the app relaunches. Z is off
   * afterwards: a held Z's release then does nothing, a toggle's next press
   * starts a new hold.
   */
  _dropEdgePattern(reason = 'the video changed') {
    if (!this._edgePatternOn) return;
    this._edgePatternOn = false;
    this._edgeActive = false;
    this._pushRemoteEdgeState?.(); // the phone's Edge button follows (next major)
    this._edgeActivationId = (this._edgeActivationId || 0) + 1; // an engage in flight goes stale
    this._edgeHandyEngaged = false;
    this._edgeStoppedEngines = [];
    try { this._edgeLoop?.deactivate(); } catch { /* best-effort */ }
    this._stopAllDevicesIdle();
    try { this.buttplugManager?.stopSustainedOutputs?.(); } catch { /* best-effort */ }
    console.log(`[EdgeHold] pattern stopped: ${reason}`);
  }

  /**
   * True when this window's own video drives the Handy and is paused. The
   * releases (X held, Z in either mode) then put the main script back but
   * leave the device stopped: nothing may start under a paused picture
   * (Dave's rule: everything stops on a pause, a stall and a video change),
   * and the engine's next 'playing' anchors it as usual. A proxy (the phone,
   * a headset, the player pop-out) never counts as paused here: its paused
   * flag can lag while it buffers, which is why the restores force their
   * anchor (SyncEngine.resync), and that stays as it was.
   */
  _ownVideoPaused() {
    if (this._remoteActive || this._playerWindowActive || this._vrPlayerRef) return false;
    const vp = this.videoPlayer;
    if (!vp) return false;
    const p = this.syncEngine?.player;
    if (p && p !== vp && p !== vp.video) return false;
    const paused = typeof vp.paused === 'boolean' ? vp.paused : vp.video?.paused;
    return paused === true;
  }

  /**
   * Edge Hold stops the Autoblow with AutoblowSync.stop(), which also
   * forgets that its script is uploaded (`_scriptReady`), so the release's
   * start() sent nothing and the Autoblow sat out the rest of the video
   * (found 2026-11-17, also in v0.9.2). The script stays in the cloud: the
   * press notes which upload it was, and the release marks it ready again
   * when it is still this video's last upload. start() then plays it at the
   * current time, or waits for 'playing' on a paused video, as the Autoblow
   * does after X (which never stops it).
   */
  _noteAutoblowForEdge() {
    const sync = this.autoblowSync;
    this._edgeAutoblowUpload = sync?.scriptReady
      ? { loadGen: this._videoLoadGen, uploadSeq: sync.uploadSeq }
      : null;
  }

  _rearmAutoblowAfterEdge() {
    const kept = this._edgeAutoblowUpload;
    this._edgeAutoblowUpload = null;
    const sync = this.autoblowSync;
    if (!kept || !sync || sync._active || sync.scriptReady) return;
    if (kept.loadGen !== this._videoLoadGen || kept.uploadSeq !== sync.uploadSeq) return;
    sync._scriptReady = true;
  }

  /**
   * Mirror of _restoreHandyAfterOrgasm minus the script restore — Edge never
   * replaced the script on the device, so resume is: HDSP engine at non-1x
   * rates, otherwise HSSP start + a forced resync() anchor at current time.
   */
  async _resumeHandyAfterEdge() {
    if (!this.handyManager?.connected) return;
    const rate = this.videoPlayer?.playbackRate || 1;
    if (rate !== 1) {
      if (this.handyHdspSync && !this.handyHdspSync.active) this.handyHdspSync.start();
      return;
    }
    if (!this.funscriptEngine?.isLoaded) return;  // no script → leave device idle
    try {
      if (this.syncEngine) {
        this.syncEngine.start();
        // On this window's own paused video the device stays stopped and
        // the next 'playing' anchors it (see _restoreHandyAfterOrgasm).
        if (!this._ownVideoPaused?.()) await this.syncEngine.resync();
      }
    } catch (err) {
      console.warn('[EdgeHold] Handy resume failed:', err?.message || err);
    }
  }

  async _restoreHandyAfterOrgasm() {
    if (!this.handyManager?.connected) return;
    const rate = this.videoPlayer?.playbackRate || 1;
    if (rate !== 1) {
      if (this.handyHdspSync && !this.handyHdspSync.active) this.handyHdspSync.start();
      return;
    }
    if (!this.funscriptEngine?.isLoaded) return;  // no script → leave device idle
    try {
      let ok = false;
      // The cached URL is only valid for the invert it was uploaded with:
      // after a toggle mid-video, re-upload instead of restoring the old
      // direction.
      if (this._scriptCloudUrl && this._scriptCloudUrlInverted === this._handyInverted()) {
        ok = await this.handyManager.setupScript(this._scriptCloudUrl);
      }
      if (ok) {
        this.syncEngine._scriptReady = true;
        this.syncEngine.start();
        // start() only anchors when `player.paused` reads false at that
        // instant, which is unreliable here (remote proxy mid-buffer), so
        // force the anchor at the CURRENT time. Without it the Handy stayed
        // where the finisher left it and drifted from the video until the
        // next seek — the "not synced after release" report. See resync().
        // Not on this window's own PAUSED video: the forced anchor started
        // the Handy on the script under a paused picture (found 2026-11-17,
        // also in v0.9.2). The script is back and the engine listens, so
        // the next 'playing' anchors it.
        if (this._ownVideoPaused?.()) {
          console.log('[OrgasmSwitch] Released on a paused video — the Handy waits for play');
        } else {
          await this.syncEngine.resync();
        }
      } else {
        // No cached URL (script never uploaded this session) → full path.
        await this._uploadAndStartSync();
      }
    } catch (err) {
      console.warn('[OrgasmSwitch] Handy HSSP restore failed:', err?.message || err);
    }
  }

  /**
   * What the Handy is sent for the main script (HSSP plays it server-side,
   * so every per-device transform is baked in): extend → fill → invert →
   * clamp, the per-tick stack's order (extender → invert → … → cutoff).
   * Gap filler is baked in because HSSP plays from the device's own clock —
   * without it the Handy at 1x would be the one device with no filler.
   * Invert after the filler (per-tick devices flip filler output too) and
   * before the clamp, so a floor/ceiling still holds on the flipped script.
   *
   * EVERY Handy upload goes through here: this window's video, a headset's,
   * a phone's and a custom route's (FT-113; also in v0.9.2). The VR, phone
   * and route uploads sent the script with only the invert, so a floor or
   * ceiling (a comfort and safety limit), the gap filler and the Range
   * Extender never reached the Handy there. `durationMs`: the timeline it
   * plays on (see `_fillerOptionsForUpload`); left out, this window's video.
   */
  _handyUploadContent(rawContent, inverted = this._handyInverted(), { durationMs } = {}) {
    const extenderEnabled = !!this.settings?.get?.('player.rangeExtender.enabled');
    return clampRawScriptContent(
      invertRawScriptContent(
        fillRawScriptContent(
          extendRawScriptContent(rawContent, extenderEnabled),
          this._fillerOptionsForUpload(durationMs),
        ),
        inverted,
      ),
      this._cutoffFromSettings('handy'),
    );
  }

  /**
   * What the Autoblow is sent: extend → fill → clamp, `_handyUploadContent`
   * without the invert (the Autoblow has none). Its script plays on the
   * device's clock too, so the same transforms are baked in, and every
   * Autoblow upload goes through here (FT-113: the VR, phone and route
   * uploads sent the raw script, no limits, no filler).
   */
  _autoblowUploadContent(rawContent, { durationMs } = {}) {
    const extenderEnabled = !!this.settings?.get?.('player.rangeExtender.enabled');
    return clampRawScriptContent(
      fillRawScriptContent(
        extendRawScriptContent(rawContent, extenderEnabled),
        this._fillerOptionsForUpload(durationMs),
      ),
      this._cutoffFromSettings('autoblow'),
    );
  }

  /**
   * How long a headset's or a phone's video is, in ms, for an upload's
   * trailing filler (FT-113): its proxy's length once the player has said,
   * else the library's for that video, else 0 (no trailing filler; never
   * this window's video's length, which is another video's).
   */
  _sessionTimelineMs(proxy, libraryVideo) {
    for (const seconds of [proxy?.duration, libraryVideo?.duration]) {
      const n = Number(seconds);
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
    }
    return 0;
  }

  /**
   * The timeline an upload plays on, by the player its engine is bound to:
   * the headset's or the phone's when it is their proxy (a phone's variant
   * switch, a route loaded for a headset video), else undefined: this
   * window's video.
   */
  _uploadDurationMsFor(player) {
    if (!player) return undefined;
    const libVideo = (p) => (p ? (this.library?._videosByPath?.get?.(p) || this.library?.getVideoByPath?.(p) || null) : null);
    if (this._vrPlayerRef && player === this._vrPlayerRef) {
      return this._sessionTimelineMs(this.vrBridge?.proxy, libVideo(this._vrSyncOffsetPath));
    }
    if (this._remoteProxy && player.video === this._remoteProxy) {
      return this._sessionTimelineMs(this._remoteProxy, libVideo(this._phoneSyncOffsetPath));
    }
    return undefined;
  }

  /**
   * Is this window's video still loading with its length unknown, while the
   * gap filler would fill to its end? (FT-113 race, Handy session
   * 2026-11-17.) An upload of this window's script measures the trailing gap
   * against `video.duration`, which a <video> reports as NaN until
   * `loadedmetadata`; an upload that left before that (a fast script parse,
   * a plain local open or a custom route) lost the fill to the video's end:
   * 79 actions ending at 29.8 s instead of 107 ending at 39.9 s.
   * False when nothing is loading (no source, an error), when the length is
   * known (Infinity for a live stream counts), or when no filler would run.
   */
  _localDurationPending() {
    const video = this.videoPlayer?.video;
    if (!video || typeof video.duration !== 'number' || !Number.isNaN(video.duration)) return false;
    if (video.error || !(video.currentSrc || video.src)) return false;
    return !!this._fillerOptionsForUpload(0);
  }

  /**
   * Resolves once this window's video knows its length (`loadedmetadata` /
   * `durationchange` with a number), on a load error, or after `timeoutMs`
   * (then the upload goes without the trailing fill, as before, and says
   * so). At once when nothing is pending. One wait per load, shared by every
   * upload that asks (the Handy, the Autoblow, a route, the Audience), so
   * they keep the order they asked in. Callers check afterwards that their
   * video is still the current one (`_videoLoadGen`).
   */
  _whenLocalDurationKnown(timeoutMs = 3000) {
    const video = this.videoPlayer?.video;
    if (!video || !this._localDurationPending()) return Promise.resolve();
    const gen = this._videoLoadGen;
    const held = this._localDurationWait;
    if (held && held.gen === gen && held.video === video) return held.promise;
    const startedAt = Date.now();
    const promise = new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLength);
        video.removeEventListener('durationchange', onLength);
        video.removeEventListener('error', finish);
        if (this._localDurationWait?.promise === promise) this._localDurationWait = null;
        resolve();
      };
      // A durationchange to NaN (a source swap) is not the length yet.
      const onLength = () => {
        if (Number.isNaN(Number(video.duration))) return;
        console.log(`[Upload] Waited ${Date.now() - startedAt} ms for the video's length (${Math.round(video.duration * 1000)} ms) — the gap filler fills to its end`);
        finish();
      };
      video.addEventListener('loadedmetadata', onLength);
      video.addEventListener('durationchange', onLength);
      video.addEventListener('error', finish);
      timer = setTimeout(() => {
        console.warn(`[Upload] The video's length is still unknown after ${timeoutMs} ms — uploading without the gap filler's fill to its end`);
        finish();
      }, timeoutMs);
    });
    this._localDurationWait = { gen, video, promise };
    return promise;
  }

  async _uploadAndStartSync() {
    if (!this.handyManager?.connected) {
      console.log('[Handy] Not connected, skipping script upload');
      this._resolveCloudUpload('handy');
      return;
    }

    const rawContent = this.funscriptEngine.getRawContent();
    if (!rawContent) {
      console.log('[Handy] No raw funscript content available');
      this._resolveCloudUpload('handy');
      return;
    }

    // On the timeline the engine plays it on: a phone's variant switch comes
    // through here with the PHONE's video bound (FT-113). This window's
    // video: once its length is known, or the gap filler's fill to its end
    // is lost (FT-113 race).
    const loadGen = this._videoLoadGen;
    const durationMs = this._uploadDurationMsFor(this.syncEngine?.player);
    if (durationMs === undefined && this._localDurationPending?.()) {
      await this._whenLocalDurationKnown();
      // Another video took over meanwhile: its own load uploads (and owns the gate).
      if (this._videoLoadGen !== loadGen) return;
    }

    // Apply Range Extender at upload time for Handy HSSP. HSSP plays
    // back from a cloud-hosted script — there's no per-tick hook to
    // apply the stretch, so it must happen pre-upload. Returns the
    // original content if extender is off or the script is already
    // wide (no-op short-circuit inside the helper).
    const inverted = this._handyInverted();
    const uploadContent = this._handyUploadContent(rawContent, inverted, { durationMs });

    console.log('[Handy] Uploading funscript to cloud...' + (inverted ? ' (inverted)' : ''));
    const upload = this.handyManager.uploadAndSetScript(uploadContent);
    // This call's number: uploadAndSetScript takes it before its first await.
    const uploadSeq = this.handyManager.uploadSeq;
    const setupOk = await upload;
    // Superseded while it travelled (FT-116, also in v0.9.2): another video
    // loaded (Next, a click, Play All), or a newer upload started (a
    // variant). That one owns the device, the cloud-upload gate and the
    // engine, so this upload is neither a success to start nor a failure to
    // toast. An old video's upload used to lift the NEW video's autoplay
    // gate and start the engine on the old script, on a video with no
    // script too (FN-01).
    if (this._videoLoadGen !== loadGen
        || (uploadSeq != null && this.handyManager.uploadSeq !== uploadSeq)) {
      console.log('[Handy] Upload superseded by a newer video or upload — leaving the device to it');
      return;
    }

    if (setupOk) {
      // Store cloud URL for potential re-setup, with the invert it carries.
      this._scriptCloudUrl = this.handyManager._lastCloudUrl || null;
      this._scriptCloudUrlInverted = inverted;
      // Already running and waiting for this script: the player pop-out
      // starts the engine when a new video is routed to it, before the
      // upload lands, and loadVideo has set the old script not ready. Its
      // start() below then returns at once, so a video already playing is
      // anchored here; a paused one anchors on its own 'playing'.
      const engineWaiting = !!this.syncEngine._active && !this.syncEngine._scriptReady;
      this.syncEngine._scriptReady = true;
      this._resolveCloudUpload('handy');
      this.syncEngine.start();
      if (engineWaiting && this.syncEngine.player?.paused === false) {
        this.syncEngine.resync().catch((err) => {
          console.warn('[Handy] Anchor after the upload failed:', err?.message || err);
        });
      }
      console.log('[Handy] Sync engine started — HSSP active');
    } else {
      // Upload failed — resolve the gate so the user isn't stuck behind
      // the loading overlay; show a toast so they know why the device
      // is silent.
      this._resolveCloudUpload('handy');
      showToast(t('toast.handyUploadFailed'), 'error');
    }
  }

  loadVideo(file, { skipViewSwitch = false, autoPlay = true } = {}) {
    console.log('Loading video:', file.name);

    // Push previous video to queue history if it was watched ≥5s
    // (SCOPE-queue-panel.md §3.5). Must check BEFORE we clear out
    // currentVideoPath / revoke the previous URL — currentTime still
    // reflects the outgoing video at this point.
    this._maybePushCurrentToHistory();
    this._queueHistoryPushedForCurrent = false;
    // FN-07: P goes back through your queue only while you move through it
    // (N, the end of a video, Up Next, a click on a queued row, or P itself).
    // Opening anything else ends the way back.
    {
      const navPaths = this._userQueueNavPaths;
      const loading = file?.path || null;
      if (!(navPaths instanceof Set) || !loading || !navPaths.has(loading)) this._userQueueBack = [];
      if (navPaths instanceof Set && loading) navPaths.delete(loading);
    }
    // Fresh load — allow a remux fallback for this video if its container
    // turns out to be unplayable (see _tryRemuxFallback).
    this._remuxAttemptedForPath = null;
    this._remuxedCopy = null; // FT-076: the playable copy of the PREVIOUS video
    // The load/error listeners are installed ONCE per <video> and read the
    // current file from instance state (V07). They used to be added here on
    // every load, each closing over its own `file`, so one failure ran every
    // stale handler: N toasts naming earlier files' codecs, N device stops.
    this._ensureVideoLoadWatch();
    // Generation token: async work started for an earlier load (an
    // existence probe, an ffprobe) must not act after this one replaced it.
    this._videoLoadGen = (this._videoLoadGen || 0) + 1;
    // Audience: a new video is a new source. Every viewer is stopped now and
    // plays again only after this video's script is set up on it (#361). The
    // token settles in loadFunscript (setScript) or _loadPlayContent
    // (setNoScript); a later source makes it stale.
    this._audienceVideoToken = this.audienceBridge?.beginSource({ title: file?.name || '' }) ?? null;
    this._videoTrackChecked = false;
    // A previous load's autoplay listener is still armed when that load
    // failed (it never reached loadeddata). Left in place it would play the
    // NEXT video the user opens, even one meant to open paused (V10).
    this._disarmLoadAutoplay();
    // Same for a resume seek armed for that load: it must not move the next
    // video to the previous one's position. Callers arm theirs after this.
    if (this._pendingResumeSeek) {
      this.videoPlayer?.video?.removeEventListener('loadedmetadata', this._pendingResumeSeek);
      this._pendingResumeSeek = null;
    }

    // Clean up previous video
    if (this._currentVideoUrl) {
      URL.revokeObjectURL(this._currentVideoUrl);
      this._currentVideoUrl = null;
    }
    // Every device stops at once on a video change, whatever the new video
    // carries (FN-01 / FT-115, also in v0.9.2). The Handy plays the old
    // script from the cloud on its own clock and syncEngine.stop() sends
    // nothing; a source swap fires no `pause`, so the Handy kept stroking the
    // OLD script until the new upload landed, and on and on when the new
    // video had no script (N run verify-2). hsspStop pre-empts a play in
    // flight and queues ahead of the new video's setScript, which keeps that
    // order. Skipped only when the last HSSP request was already a stop. The
    // player pop-out's video changes load through here too.
    // An Edge Hold playing a pattern drives the devices on its own clock:
    // it ends here too, before the Handy's stop below (its engage goes stale).
    this._dropEdgePattern?.();
    // So does a Settings Test (pf-fixup 2026-11-19): every device it drives
    // stops, and its Handy part gives way to the new video's script.
    if (this._fillerTest?.running || this._handyTest) {
      this._handyTestEndReason = 'video-change';
      this._fillerTest?.stop();
    }
    // So does an Orgasm Switch started as a toggle (Dave 2026-11-19, block F
    // decision 4; also in v0.9.2): the Handy's finisher stopped below, but
    // its loop went on driving Buttplug / T-Code on the next video until it
    // was toggled off. Ended as a second press ends it (finish: every device
    // stops, nothing snaps back to the old script). A HELD X ends the same
    // way (Dave 2026-11-19 ~14:52, pf-fixup): its loop no longer rides into
    // the next video, and letting go of the key afterwards does nothing (the
    // switch is off; its release finds nothing to deactivate).
    if (this.orgasmSwitch?.active) {
      console.log(`[OrgasmSwitch] Video changed — ending the ${this._orgasmToggled ? 'toggled' : 'held'} finisher`);
      try { this._finishOrgasm(); } catch (err) { console.warn('[OrgasmSwitch] ending it on a video change failed:', err?.message || err); }
    }
    const handyStop = !!this.handyManager?.connected && this.handyManager.hsspMayBeRunning !== false;
    if (handyStop) {
      console.log('[Handy] Video changed — stopping the old script');
      Promise.resolve(this.handyManager.hsspStop()).then((stopped) => {
        if (stopped === false) this.syncEngine?.onStopFailed?.();
      }).catch((err) => console.warn('[Handy] Stop on video change failed:', err?.message || err));
    }
    // A play of the engine's still in flight re-sends that stop when it lands.
    this.syncEngine?.stop({ deviceStopped: handyStop });
    // The old script is not this video's. Nothing may restart the Handy on
    // it before this video's own upload sets it ready again: the pop-out's
    // take-over and fold-back start the engine, and on a video with no
    // script it played the previous video's script (FN-01).
    if (this.syncEngine) this.syncEngine._scriptReady = false;
    if (this.handyHdspSync?.active) this.handyHdspSync.stop();
    // Each of these engines' stop() stops its own device (stopAll / DSTOP /
    // syncStop), so a video change stops them at once too.
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    this._stopGapSkip();
    if (this._queueEndedListener) {
      this.videoPlayer.video.removeEventListener('ended', this._queueEndedListener);
      this._queueEndedListener = null;
    }
    if (this.buttplugSync) {
      this.buttplugSync.setVibrationActions(null);
      this.buttplugSync.clearAxisActions();
      if (this.connectionPanel) this.connectionPanel.updateVibControlState();
    }
    if (this.tcodeSync) {
      this.tcodeSync.clearAxisActions();
    }
    this._currentMultiAxis = null;
    // Both engines were just emptied: nothing on them comes from an
    // embedded axis or a failed companion any more (V11).
    this._embeddedAxisTcodes = new Set();
    this._companionAxesFailed = new Set();
    this._currentCustomRoutes = null;
    this._customRoutingActive = false;
    if (this.buttplugSync) this.buttplugSync._customRoutingActive = false;
    this.funscriptEngine.clear();
    this._engineHeldByRemote = false; // R3-20: a local video's load
    this._scriptCloudUrl = null;
    // Fresh video — drop any gating from the previous video's load.
    // Per-device resolves only fire as uploads complete; without this
    // force-clear, a video that never finished its prior gate would
    // leak the pending state into this load.
    this._clearCloudUploadGate();
    if (this._scriptLoadingTimeout) {
      clearTimeout(this._scriptLoadingTimeout);
      this._scriptLoadingTimeout = null;
    }
    this._hideScriptLoadingOverlay();
    this.progressBar.clearHeatmap();
    this._feedInlineViz(); // no script yet → clears viz + hides TL/HM buttons
    this.progressBar.setGaps(null);
    this.progressBar.setMarkers({ chapters: [], bookmarks: [] });
    const fsBadge = document.getElementById('funscript-badge');
    if (fsBadge) {
      fsBadge.hidden = true;
      fsBadge.innerHTML = '';
    }
    // Tear down any subtitle track from the previous video. Without this,
    // a <track> attached by loadSubtitles() keeps rendering after switching
    // to a video that has no subtitle of its own (persisted until restart).
    if (this.videoPlayer) this.videoPlayer.clearSubtitles();
    // Reset variant selector
    const variantSelector = document.getElementById('variant-selector');
    if (variantSelector) variantSelector.hidden = true;
    this._currentVariants = [];
    this._allVariantsWithManual = [];
    this._activeVariantIndex = 0;
    this._activeVariantPath = null;
    this._variantsPhoneEpoch = null;   // the list is this local video's from here

    // Hide editor, clear funscript path and script list, show editor toggle button
    if (this.scriptEditor) {
      if (this.scriptEditor.isOpen) this.scriptEditor.hide();
      // Empty, no path: the outgoing video's points never show (or save) as
      // this video's, whoever holds the engine (R3-20 fix-up).
      this.scriptEditor.clearForVideoLoad();
      this.scriptEditor.setAvailableScripts([]);
      this.scriptEditor.clearUndoCache();
    }
    document.getElementById('btn-editor').hidden = false;

    // Switch to player view (unless caller already handled it)
    if (!skipViewSwitch) {
      this._navigateTo('player');
    }

    // Set video source — use file:// URL for local paths, blob URL for File
    // objects, or the localhost proxy URL as-is for remote (yt-dlp-resolved)
    // streams.
    let videoUrl;
    let loadOpts = {};
    if (file._remote && file.path) {
      // file.path is already the playable proxy URL (http://127.0.0.1/...).
      // HLS goes through hls.js (MSE); progressive plays directly.
      videoUrl = file.path;
      loadOpts = { isHls: !!file.isHls, remote: true };
    } else if (file._isPathBased && file.path) {
      // pathToFileURL percent-encodes `#`, `?`, `%`, spaces etc. — without
      // this, filenames like "Your Step-sister #1.mp4" truncate at the
      // `#` and load fails with "format not supported".
      videoUrl = pathToFileURL(file.path);
    } else {
      videoUrl = URL.createObjectURL(file);
      this._currentVideoUrl = videoUrl;
    }

    this._currentVideoName = file.name;
    // Remote streams have no local path — keep _currentVideoPath null so
    // local-only paths (remux-on-error, recent files, library lookup) stay off.
    this._currentVideoPath = file._remote ? null : (file.path || null);
    // A new video with no script yet — drop the previous video's script
    // path so the funscript badge can't attribute its embedded axes here.
    this._currentFunscriptPath = null;
    // A Reset only suppresses the video it was aimed at; loading anything
    // else lifts it so normal recording resumes.
    if (this._resumeSuppressedPath && this._resumeSuppressedPath !== this._currentVideoPath) {
      this._resumeSuppressedPath = null;
    }
    this._currentIsRemote = !!file._remote;
    this.videoPlayer.loadSource(videoUrl, file.name, loadOpts);
    this.progressBar.setVideoSource(videoUrl);
    this._updateCategoryDots();
    // Refresh the queue panel state so the "Now playing" row updates
    // and upcoming re-derives from the new context.
    this._updateQueuePanelState();
    // Prev / next for THIS video: a way back through your queue is this
    // video's only once it is the current one (FN-07).
    this._updateQueueUI?.();

    // Apply any saved VR-as-flat preference for this video. Two inputs:
    //   - per-video saved eye ('left' / 'right' / null) in
    //     `library.vrFlatten[path]`
    //   - per-video format auto-detected by `classifyStereoFormat`
    // No saved preference + a detectable format = leave Off (the user
    // opts in explicitly via Shift+R or the library kebab). This avoids
    // silently squishing every flat-but-VR-tagged video the user opens.
    this._applyVRFlattenForCurrent();

    // This video's own sync offset (#380) on top of every device's, or the
    // previous video's taken off again. No entry = the global offsets alone.
    this._applyVideoSyncOffset?.();

    // Its Stash scene's markers on the seek bar (Stash S1), or the previous
    // video's taken off.
    this._applyStashMarkers?.();

    // One-time HEVC codec install guidance — fires once per session if
    // the OS lacks a hardware HEVC decoder (and the user hasn't
    // permanently dismissed it). Cheap to call on every load; the
    // helper has its own per-session guard. See hevc-detect.js for
    // the full rationale.
    maybeShowHevcGuidance(this.settings);

    // Store video path on player container for editor access
    const pc = document.getElementById('player-container');
    if (pc) pc.dataset.videoPath = file.path || '';

    // Auto-play once video is ready (gated by script upload if applicable).
    // Kept in `_loadAutoplayListener` so a failed load can disarm it: it is
    // {once}, so it only ever cleaned itself up on SUCCESS (V10).
    if (autoPlay) {
      const video = this.videoPlayer.video;
      const autoplayOnLoaded = () => {
        if (this._loadAutoplayListener === autoplayOnLoaded) this._loadAutoplayListener = null;
        if (this._waitingForScript) {
          this._showScriptLoadingOverlay();
          // Don't play yet — _uploadAndStartSync will trigger play when ready
        } else {
          video.play().catch(() => {});
        }
      };
      this._loadAutoplayListener = autoplayOnLoaded;
      video.addEventListener('loadeddata', autoplayOnLoaded, { once: true });
    }

    // Load errors (including a mid-playback drive disconnect) are handled by
    // `_onVideoError`, installed once by `_ensureVideoLoadWatch` above.

    // Set title
    const titleEl = document.getElementById('video-title');
    titleEl.textContent = file.name.replace(/\.[^/.]+$/, '');

    // Track recent file (local only — a localhost proxy URL isn't re-openable).
    if (file.path && !file._remote) {
      this.settings.addRecentFile(file.path);
    }

    // Auto-pair: check pending funscripts for matching name. Skipped for
    // remote streams in v1 (script is attached manually in the Load-from-URL
    // dialog; EroScripts auto-match is a planned follow-up).
    if (!file._remote) {
      const match = this._pendingFunscripts.find((f) => isAutoMatch(file.name, f.name));
      if (match) {
        this._pendingFunscripts = this._pendingFunscripts.filter((f) => f !== match);
        this.loadFunscript(match);
      } else if (!this.funscriptEngine.isLoaded) {
        // No funscript found locally — try auto-matching on EroScripts (background, non-blocking)
        this._autoMatchEroScripts(file.name);
      }
    }
  }

  /**
   * Install the inline <video>'s load-outcome listeners, ONCE per element.
   *
   * V07 (app test 2026-11-02, forum #368): loadVideo used to add an 'error'
   * listener on every load and never remove it, each one closing over the
   * `file` it was added for. One failure after N loads ran N handlers: N
   * toasts, most naming the codec of a video opened EARLIER (the "HEVC Main
   * isn't supported" #368 saw on a file that wasn't HEVC), and N stops sent
   * to every device. These handlers read the current file from instance
   * state instead, so a load never needs to add one.
   */
  _ensureVideoLoadWatch() {
    const video = this.videoPlayer?.video;
    if (!video || this._videoLoadWatchTarget === video) return;
    this._videoLoadWatchTarget = video;
    video.addEventListener('error', () => { this._onVideoError(); });
    // V09: a video track the platform cannot decode, which Chromium drops
    // without raising an error — two checks, see _checkVideoTrackDecodes.
    video.addEventListener('loadedmetadata', () => this._checkVideoTrackDecodes('metadata'));
    video.addEventListener('timeupdate', () => this._checkVideoTrackDecodes('frames'));
    video.addEventListener('loadeddata', () => this._onVideoLoadSucceeded());
  }

  /** Remove the current load's armed autoplay listener, if it has not fired. */
  _disarmLoadAutoplay() {
    const listener = this._loadAutoplayListener;
    if (!listener) return;
    this._loadAutoplayListener = null;
    this.videoPlayer?.video?.removeEventListener('loadeddata', listener);
  }

  /** Stop every sync engine and device after the video failed to load. */
  _stopOutputsForVideoError() {
    if (this.syncEngine) this.syncEngine.stop();
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    if (this.handyManager?.connected) this.handyManager.hsspStop();
    if (this.buttplugManager?.connected) this.buttplugManager.stopAll();
    if (this.tcodeManager?.connected) this.tcodeManager.stop();
    if (this.autoblowManager?.connected) this.autoblowManager.syncStop();
  }

  /**
   * The inline <video> raised an error. Reads the CURRENT file from instance
   * state (`_currentVideoPath` / `_currentVideoName`), never from a closure:
   * see _ensureVideoLoadWatch.
   */
  async _onVideoError() {
    const video = this.videoPlayer?.video;
    if (!video) return;
    const gen = this._videoLoadGen;
    const code = video.error?.code;
    const message = video.error?.message || '';
    const isFileUrl = String(video.src || '').startsWith('file:');
    const path = this._currentVideoPath;
    const name = this._currentVideoName || '';

    // V08: every failure reaches the log, with the MediaError itself. Before
    // this, a decode failure logged nothing and the only trace was a toast.
    console.warn('[Video] load error', { code: code ?? null, message, file: path || name || null });

    // Unsupported container (code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED). The
    // common case is a .mkv holding H.264/AAC — Chromium can't demux
    // Matroska even though it can decode the codecs. Before surfacing any
    // error, try a one-time ffmpeg stream-copy remux to MP4 and reload.
    // Guarded so it only fires once per load (a failed re-load can't loop).
    const remuxCandidate = code === 4 && isFileUrl && !!path
      && this._remuxAttemptedForPath !== path;

    // Stop all sync engines and devices immediately, unless this may yet
    // play after a remux. A mid-playback disconnect (code 2) must not wait
    // for the existence probe below.
    let stopped = false;
    if (!remuxCandidate) {
      this._stopOutputsForVideoError();
      stopped = true;
    }

    // V10: Chromium reports a MISSING file:// source as code 4 "Format
    // error", the same code as an unsupported container. So check the file
    // is there before calling it a format problem (and before asking the
    // backend to remux a file that doesn't exist). Only an explicit `false`
    // counts as missing: a probe that timed out or failed is unknown, and
    // unknown falls through to the old behaviour.
    if (isFileUrl && path && (code === 4 || code === 2)) {
      let exists = null;
      try {
        const answer = await window.funsync?.filesExist?.([path]);
        exists = Array.isArray(answer) ? answer[0] : null;
      } catch { exists = null; }
      if (gen !== this._videoLoadGen) return; // a newer load replaced this one
      if (exists === false) {
        if (!stopped) this._stopOutputsForVideoError();
        this._onCurrentVideoMissing(path, name);
        return;
      }
    }

    if (remuxCandidate) {
      this._tryRemuxFallback(path, name, message);
      return;
    }

    // This load is over: its autoplay listener must not play the next one.
    this._disarmLoadAutoplay();

    // Show appropriate error message
    if (isFileUrl && code === 2) {
      showToast(t('toast.sourceDisconnectedFile'), 'error', 5000);
      // Invalidate library cache so re-scan catches the change
      if (this.library) this.library._lastScanKey = null;
    } else if (code === 3 && isFileUrl && path) {
      // Decode failure on a local file. Most often a codec/profile the
      // OS Chromium build can't decode (e.g. H.264 "High 10" / 4:2:2 /
      // 4:4:4 on Linux) — while a plain 8-bit 4:2:0 file of the same
      // codec plays fine. Name the actual codec via ffprobe so the user
      // knows exactly what to transcode instead of a guess.
      this._showDecodeErrorWithCodec(path);
    } else {
      const msgs = {
        1: t('toast.videoErrorAborted'),
        2: t('toast.videoErrorNetwork'),
        3: t('toast.videoErrorDecode'),
        4: t('toast.videoErrorFormat'),
      };
      showToast(msgs[code] || t('toast.videoErrorGeneric'), 'error');
    }
  }

  /**
   * The current video's file is not there: renamed, moved, or its drive is
   * gone (V10). Says so, instead of "Video format not supported", and keeps
   * a Play All queue moving instead of stalling on the dead item — the same
   * rule the Play All start already applies (playlist-availability.js:
   * unavailable entries are skipped, never removed). Nothing is deleted.
   */
  _onCurrentVideoMissing(path, name) {
    this._disarmLoadAutoplay();
    // Invalidate library cache so the next library visit re-scans
    if (this.library) this.library._lastScanKey = null;
    console.warn('[Video] file not found (moved, renamed or drive offline):', path);

    const item = this._playQueue?.[this._playQueueIndex];
    // A video from your queue played in the middle of Play All (R3-15) counts
    // as the queue's: a missing one is skipped like a missing item.
    const inQueue = (!!item && item.path === path)
      || (this._currentPlayContext?.interlude === true && this._playQueue?.length > 0);
    // Up Next advanced into a playlist / category / library list and found
    // this entry's file gone (still in the last scan, so the advance's own
    // walk past missing entries did not see it). It stopped there, docked
    // and popped out alike, until the user pressed Next (verify-1,
    // 2026-11-07). An unattended advance walks on, as Play All does; a video
    // the user opened is not skipped. Nothing is removed from the list.
    const ctx = this._currentPlayContext;
    const ctxList = Array.isArray(ctx?.list) && ctx.source !== 'queue' ? ctx.list : null;
    const viaAdvance = !inQueue && !!ctxList && this._advanceLoadGen != null
      && this._advanceLoadGen === this._videoLoadGen;
    const walking = inQueue || viaAdvance;
    // Consecutive missing queue items. It bounds the skip chain (a looping
    // queue on an unplugged drive must not spin forever) and keeps it to one
    // toast; _onVideoLoadSucceeded reports the total and resets it.
    const streak = walking ? (this._missingQueueStreak || 0) + 1 : 0;
    this._missingQueueStreak = streak;
    if (streak <= 1) {
      showToast(t('toast.videoFileMissing', { name: name || path }), 'error', 6000);
    }
    if (!walking) return;
    if (streak >= (inQueue ? this._playQueue.length : ctxList.length)) {
      this._missingQueueStreak = 0;
      showToast(t('toast.playlistAllUnavailable'), 'warn');
      return;
    }
    if (inQueue) {
      this._advanceQueueOnEnded();
      return;
    }
    const next = this.upNextEngine?.peekNext?.() || null;
    if (!next) { this._missingQueueStreak = 0; return; } // the end of the list
    this._playUpNext(next);
  }

  /** `loadeddata` on the inline <video>: this load worked. */
  _onVideoLoadSucceeded() {
    const skipped = this._missingQueueStreak || 0;
    this._missingQueueStreak = 0;
    // A single missing item already got its own named toast.
    if (skipped > 1) {
      showToast(t('toast.playlistSkippedUnavailable', { count: skipped }), 'info');
    }
  }

  /**
   * V09: a video track the platform cannot decode. Chromium on Windows
   * drops an HEVC 4:4:4 track WITHOUT raising a MediaError and plays the
   * audio over black, so the error handler never runs. Two checks per load:
   *   - 'metadata' (loadedmetadata): the picture has no size at all;
   *   - 'frames'   (timeupdate): it has a size, but after
   *     NO_FRAMES_GRACE_SEC of real playback not one frame was decoded.
   * Either way the backend's ffprobe decides whether the file HAS a video
   * stream, so a music file (none, or only cover art) is left alone.
   * Informs only: playback and devices carry on, since the audio, and the
   * script synced to it, are still playing correctly.
   */
  _checkVideoTrackDecodes(stage, popout = null) {
    if (this._videoTrackChecked) return;
    const video = this.videoPlayer?.video;
    const path = this._currentVideoPath;
    if (!video || !path || this._currentIsRemote) return;
    if (!String(video.src || '').startsWith('file:') || isAudioPath(path)) {
      this._videoTrackChecked = true;
      return;
    }
    if (stage === 'metadata') {
      if (video.videoWidth > 0) return; // has a picture size: the frame check decides
    } else if (this._playerWindowActive) {
      // The inline copy is hidden while the pop-out plays: judge the player
      // window's own <video> from what its TIME_TICK reports (`popout`).
      // It skipped the check altogether, so a track with a size and no
      // frames played black there with no message (E-10, also in v0.9.2).
      if (!popout || popout.hidden) return;
      if (typeof popout.frames !== 'number' || popout.frames > 0) {
        this._videoTrackChecked = true;
        return;
      }
      if (!(Number(popout.playedSec) >= NO_FRAMES_GRACE_SEC)) return;
    } else {
      // A hidden page may legitimately skip decoding. Judge only what is on screen.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const quality = video.getVideoPlaybackQuality?.();
      if (!quality || quality.totalVideoFrames > 0) {
        this._videoTrackChecked = true;
        return;
      }
      if (playedSeconds(video) < NO_FRAMES_GRACE_SEC) return;
    }
    this._videoTrackChecked = true;
    this._reportUndecodedVideoTrack(path, stage);
  }

  async _reportUndecodedVideoTrack(path, stage) {
    const gen = this._videoLoadGen;
    let meta = null;
    try { meta = await window.funsync?.fetchMetadata?.(path); } catch { meta = null; }
    if (gen !== this._videoLoadGen) return;
    if (meta && !hasRealVideoStream(meta)) return; // audio only, or cover art
    if (!meta && stage === 'metadata') {
      // Without ffprobe an audio-only file looks exactly like this. Log it
      // for a bug report, but don't tell the user their video is broken.
      console.warn('[Video] no picture (videoWidth 0) and the file could not be probed:', path);
      return;
    }
    const reason = stage === 'metadata'
      ? 'video track dropped (videoWidth 0), playing audio only'
      : `no video frames decoded after ${NO_FRAMES_GRACE_SEC}s of playback`;
    this._showDecodeErrorWithCodec(path, { meta, reason });
  }

  /**
   * Turn a bare MEDIA_ERR_DECODE into an actionable message by naming the
   * codec/profile/pixel-format via the backend's ffprobe. This is the
   * difference between "Video decoding failed — unsupported codec?" and
   * "Video decoding failed: H264 High 10 yuv422p — not supported on this
   * system". Community-reported by a Fedora user whose H.264 files played
   * inconsistently (some High 10 / 4:2:2, some 8-bit 4:2:0). Best-effort:
   * falls back to the generic message if ffprobe is unavailable.
   *
   * @param {string} path  local video path that failed to decode
   * @param {object} [opts]
   * @param {object|null} [opts.meta]  metadata already probed by the caller
   * @param {string} [opts.reason]     what went wrong, for the log line
   */
  async _showDecodeErrorWithCodec(path, { meta, reason = 'decode failed' } = {}) {
    const gen = this._videoLoadGen;
    let probed = meta;
    if (probed === undefined) {
      try {
        probed = await window.funsync.fetchMetadata?.(path);
      } catch { probed = null; /* fall through to the generic message */ }
    }
    const detail = describeVideoCodec(probed);
    // V08: the codec belongs in the log as well as the toast. It used to
    // reach only the toast, so a bug report could not say what failed.
    console.warn(`[Video] ${reason}:`, path, detail || 'codec unknown');
    // The user has opened something else while ffprobe ran: a toast naming
    // this file's codec would now describe the wrong video.
    if (gen !== this._videoLoadGen) return;
    if (detail) {
      showToast(t('toast.videoErrorDecodeCodec', { codec: detail }), 'error', 8000);
    } else {
      showToast(t('toast.videoErrorDecode'), 'error');
    }
  }

  /**
   * Container-remux fallback. When a local video fails to load with
   * MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) — typically a .mkv that Chromium
   * can't demux even though it supports the H.264/AAC inside — repackage it
   * to MP4 via the backend's ffmpeg (stream copy, lossless, cached) and
   * reload from the remuxed file. The armed `loadeddata` autoplay listener
   * from loadVideo survives the re-load (same <video> element), so playback
   * resumes automatically.
   *
   * @param {string} originalPath  source path that failed to play
   * @param {string} name          display name for loadSource
   * @param {string} [mediaError]  the MediaError message, for the log
   */
  async _tryRemuxFallback(originalPath, name, mediaError = '') {
    // One attempt per path — set the guard up front so a failed re-load of
    // the same file can't trigger a second remux.
    this._remuxAttemptedForPath = originalPath;

    const ext = (originalPath.split('.').pop() || 'video').toUpperCase();
    const toast = showToast(t('toast.remuxPreparing', { format: ext }), 'info', 0);

    try {
      const result = await window.funsync.remuxVideo?.(originalPath);
      // The user may have loaded a different video while we were remuxing —
      // don't hijack their new playback.
      if (this._currentVideoPath !== originalPath) {
        toast?.dismiss?.();
        return;
      }
      if (!result?.path) throw new Error('remux returned no file');

      const url = pathToFileURL(result.path);
      // The pop-out builds its src from this (FT-076): popping out a video
      // that plays from its remuxed copy must not hand it the original.
      this._remuxedCopy = { original: originalPath, path: result.path };
      // Point playback at the remuxed MP4. Same <video> element is reused,
      // so loadVideo's armed loadeddata→autoplay listener fires.
      this.videoPlayer.loadSource(url, name);
      this.progressBar.setVideoSource(url);
      // FT-076 (also in v0.9.2): with the player popped out, the inline
      // element only holds the file. The pop-out was sent the original,
      // which it cannot open either, so it sat at 0:00 / 0:00 with nothing
      // said. Send it the playable copy, with the play intent it was sent.
      const sent = this._popoutLoadSent;
      if (this._playerWindowActive && sent?.path === originalPath) {
        this._sendLoadVideoToPopout(sent.autoplay || (sent.wanted === true && !this._waitingForScript), {
          timeMs: sent.timeMs,
        });
      }
      console.log(`[Remux] playing remuxed copy of ${originalPath}`);
      toast?.dismiss?.();
    } catch (err) {
      toast?.dismiss?.();
      console.warn('[Remux] fallback failed:', err?.message || err,
        `(original error: ${mediaError || 'none reported'}) for`, originalPath);
      // The load is over; its armed autoplay must not play the next video.
      this._disarmLoadAutoplay();
      // Fall back to the normal "format not supported" message.
      showToast(t('toast.videoErrorFormat'), 'error');
    }
  }

  async _autoMatchEroScripts(videoName) {
    // Don't auto-match if not logged in or no EroScripts panel
    if (!this.eroscriptsPanel?.isLoggedIn) return;

    // Debounce — only one auto-match at a time
    if (this._autoMatchPending) return;
    this._autoMatchPending = true;

    try {
      // Wait a moment for the video to fully load (don't race with funscript loading)
      await new Promise(r => setTimeout(r, 2000));

      // If a funscript was loaded in the meantime, skip
      if (this.funscriptEngine.isLoaded) return;

      const query = videoName.replace(/\.[^/.]+$/, ''); // strip extension
      const { results, authExpired } = await window.funsync.eroscriptsSearch(query);

      // The API reports a dead session; act on it instead of dropping it.
      // This path used to destructure `results` ONLY, so a 403 arrived as an
      // empty array and was indistinguishable from "no script exists for
      // this video" — no toast, no warning, and the panel still claiming to
      // be connected. The symptom was script-found notifications silently
      // never appearing again.
      if (authExpired) {
        await this.eroscriptsPanel?.handleSessionExpired?.();
        return;
      }

      if (results && results.length > 0 && !this.funscriptEngine.isLoaded) {
        const top = results[0];
        const container = document.createElement('div');
        container.className = 'update-toast';

        const text = document.createElement('span');
        text.textContent = t('toast.scriptFound', { title: top.title });
        container.appendChild(text);

        const btn = document.createElement('button');
        btn.className = 'update-toast__btn';
        btn.textContent = t('toast.getScript');
        btn.addEventListener('click', () => {
          if (this.eroscriptsPanel) {
            this.eroscriptsPanel.setSearchQuery(query, true);
            this.eroscriptsPanel.show();
          }
        });
        container.appendChild(btn);

        showToast(container, 'info', 10000);
      }
    } catch (err) {
      console.warn('[AutoMatch] EroScripts search failed:', err.message);
    } finally {
      this._autoMatchPending = false;
    }
  }

  async loadFunscript(file) {
    if (!this._currentVideoName) {
      this._pendingFunscripts.push(file);
      console.log('Funscript queued for auto-pairing:', file.name);
      return;
    }

    // The path this script actually lives at, which is what every
    // embedded-axes consumer keys on (library card badge, kebab,
    // Change-Funscript modal all call `getEmbeddedAxes(funscriptPath)`).
    // Falls back to the video path only so a script with no known path
    // — drag-drop of a File without `path` — still caches under a stable
    // key that `_showFunscriptBadge` reads back with.
    this._currentFunscriptPath = file.path || file._funscriptPath
      || this._currentVideoPath || null;
    // The engine's parse waits on the backend's CSV conversion, which a busy
    // backend can hold for seconds. Next (Play All) or another click meanwhile
    // runs loadVideo and bumps `_videoLoadGen`: this script's embedded axes,
    // badge, heatmap and device starts must not land on that video (V72 review).
    const gen = this._videoLoadGen;
    const movedOn = () => this._videoLoadGen !== gen;
    // Audience: this script is a new source of its own, taken before the
    // first await. Reached without loadVideo too (drag-dropped funscript,
    // EroScripts download), so viewers are stopped here before anything is
    // set up on them; right after loadVideo it costs nothing (#361).
    const audienceToken = this.audienceBridge?.beginSource({ title: file.name || '' }) ?? null;

    try {
      // Use loadContent directly if textContent is already available (from library or IPC),
      // otherwise use loadFile which calls file.text() for real File objects
      const rawContent = file.textContent != null
        ? file.textContent
        : await file.text?.();
      const info = file.textContent != null
        ? await this.funscriptEngine.loadContent(file.textContent, file.name)
        : await this.funscriptEngine.loadFile(file);
      // This window's script from here (R3-20).
      this._engineHeldByRemote = false;
      if (movedOn()) return;
      console.log('Funscript loaded:', info);

      // Viewers get this script whether or not the streamer's own Handy is
      // connected: the bridge uploads it itself (keyless) once for all. The
      // content is built only when a viewer needs it, so a user with no
      // room pays nothing and a filler throw cannot land in this catch.
      const setAudienceScript = () => this.audienceBridge?.setScript(audienceToken, {
        content: () => this._audienceScriptContent(rawContent),
        title: file.name || '',
      });
      // Viewers' script carries the gap filler to this video's end too, so it
      // is set once the length is known (FT-113 race), without holding up
      // the rest of this load; a newer source drops it (a stale token).
      if (this.audienceBridge && this._localDurationPending?.()) {
        this._whenLocalDurationKnown().then(setAudienceScript);
      } else {
        setAudienceScript();
      }

      // Community-driven: many forum funscripts bundle pitch/roll/twist
      // INTO the single main file (HereSphere `additional_axes`, OFS
      // `raw`, sibling-key, or inline TCode formats). FunSync's
      // companion-file detection misses these — the device only gets
      // the L0 main stroke. Detect + auto-feed multi-axis here so OSR2
      // / SR6 owners with combined files get their rotation axes
      // immediately on load, no manual extraction needed.
      this._feedEmbeddedMultiAxis(rawContent, this._currentFunscriptPath);

      this._showFunscriptBadge(info);

      // Feed actions to the parallel HDSP-polled engine — used at
      // non-1.0× playback rates where HSSP can't follow. The engine
      // doesn't start until rate diverges from 1.0× (see _setSpeed in
      // script-editor.js), so this is a cheap cache.
      if (this.handyHdspSync) {
        this.handyHdspSync.setActions(this.funscriptEngine.getActions());
        // HDSP is per-tick, so the cutoff clamps live (HSSP bakes it into
        // the uploaded content instead). Same 'handy' setting drives both.
        this.handyHdspSync.setCutoff(this._cutoffFromSettings('handy'));
        this.handyHdspSync.setInverted(this._handyInverted());
      }

      // Render heatmap if video duration is known
      if (isFinite(this.videoPlayer.duration) && this.videoPlayer.duration > 0) {
        this.progressBar.renderHeatmap(
          this.funscriptEngine.getActions(),
          this.videoPlayer.duration,
        );
        this._feedInlineViz();
        this.progressBar.setMarkers({
          chapters: this.funscriptEngine.getChapters(),
          bookmarks: this.funscriptEngine.getBookmarks(),
        });
        if (this.funscriptEngine.getChapters().length > 0) {
          this.progressBar.renderChapterStrip(this.videoPlayer.duration);
        }
      }

      // Load into script editor if open + set funscript path for autosave.
      // Not when the editor already holds this video's script and must keep
      // it, its unsaved edits and undo history: the engine taking this
      // window's script back after a phone or VR session (R4-04).
      if (this.scriptEditor && !file._keepEditor) {
        // The file this script was read from: a drop or a Browse pick carries
        // `path`, the library, playlist and Play All routes `_funscriptPath`
        // (an association can name any file). Those routes used to get
        // `<video>.funscript` derived here, so a Save wrote the edits of the
        // associated script over a DIFFERENT user file of that name, or into
        // a new sidecar the next open never loaded (R3 fix-up, real-app
        // verifier 2, also in v0.9.2). OFS: Save writes the file that is open.
        const openedFrom = file.path || file._funscriptPath || null;
        if (openedFrom) {
          this.scriptEditor.setFunscriptPath(openedFrom);
        } else if (this._currentVideoPath) {
          // Funscript from library/IPC — derive path from video path
          const fsPath = this._currentVideoPath.replace(/\.[^/.]+$/, '') + '.funscript';
          this.scriptEditor.setFunscriptPath(fsPath);
        }
        this.scriptEditor.loadScript();
        // Now that the editor knows the main path: list the axes embedded
        // in this script next to any companions (#376, V42).
        this._refreshEditorScriptList();
      }

      // If Handy is connected, upload script to cloud and start sync
      // (skip if custom routing is active — routing handles Handy assignment)
      if (!this._customRoutingActive || this._isDeviceOnMainRoute('handy')) {
        await this._uploadAndStartSync();
        if (movedOn()) return;
      } else {
        // Its route's script was uploaded by _loadCustomRouting, before this
        // ran. An autoplay waiting on a main upload plays now, not after the
        // 8 s fallback and its "upload timed out" toast (FT-112).
        this._resolveCloudUpload('handy');
      }

      // If Buttplug is connected, start sync
      this._tryStartButtplugSync();

      // If TCode is connected, start sync
      this._tryStartTCodeSync();

      // If Autoblow is connected, upload script and start sync
      // (skip if custom routing is active — routing handles Autoblow assignment)
      if (!this._customRoutingActive || this._isDeviceOnMainRoute('autoblow')) {
        await this._tryStartAutoblowSync();
        if (movedOn()) return;
      } else {
        this._resolveCloudUpload('autoblow');   // its route's, as for the Handy (FT-112)
      }

      // Start gap skip monitoring (only for single-script playback — multi-device routing
      // has different scripts per device, skipping would desync them)
      if (!this._customRoutingActive) {
        this._startGapSkip();
      }
    } catch (err) {
      console.error('Failed to load funscript:', err.message);
      // Viewers stay stopped rather than wait forever (dropped if setScript
      // already settled this source, or a newer one began).
      this.audienceBridge?.setNoScript(audienceToken, { reason: 'load-failed', failed: true });
      showToast(t('toast.scriptLoadFailed', { error: err.message }), 'error');
      // No script, no upload: an autoplay waiting on one plays now (FT-112).
      // Not when another video has loaded: the gate is that video's.
      if (!movedOn()) {
        this._resolveCloudUpload('handy');
        this._resolveCloudUpload('autoblow');
      }
    }
  }

  _showFunscriptBadge(info) {
    const badge = document.getElementById('funscript-badge');
    if (!badge || !info) return;

    // Stash so `_feedEmbeddedMultiAxis` can re-render the tooltip
    // after embedded axes are detected (axes arrive AFTER the main
    // info via the load flow).
    this._lastFunscriptInfo = info;

    let title = `${info.filename} — ${info.actionCount} actions, ${info.durationFormatted}`;

    if (this._currentCustomRoutes && this._currentCustomRoutes.length > 0) {
      const lines = [title, '— Custom Routing —'];
      for (const route of this._currentCustomRoutes) {
        const scriptName = route.scriptName || route.scriptPath?.split(/[\\/]/).pop() || '(none)';
        const device = this._findKnownDeviceForRoute(route);
        const deviceLabel = device ? device.label : (route.deviceId || t('syncChip.unassigned'));
        const roleLabel = route.role === 'main' ? '★ ' : '';
        lines.push(`${roleLabel}${deviceLabel}: ${scriptName}`);
      }
      title = lines.join('\n');
    } else if (this._currentMultiAxis && this._currentMultiAxis.axes) {
      const axes = this._currentMultiAxis.axes;
      const lines = [title, '— Multi-Axis —'];
      for (const [suffix, path] of Object.entries(axes)) {
        if (!path) continue;
        const name = path.split(/[\\/]/).pop();
        const axisLabel = suffix.charAt(0).toUpperCase() + suffix.slice(1);
        lines.push(`${axisLabel}: ${name}`);
      }
      if (this._currentMultiAxis.buttplugVib) {
        lines.push('Vib → Buttplug.io');
      }
      title = lines.join('\n');
    }

    // Embedded multi-axis (HereSphere / OFS-extended / sibling / inline
    // TCode formats). Surfaces axes that live INSIDE the main file
    // rather than in companion files — otherwise the user has no idea
    // the device is reading more than just L0.
    const embedded = this.getEmbeddedAxes(this._currentFunscriptPath);
    if (embedded && embedded.suffixes.length > 0) {
      const lines = [title, '— Embedded in main —', ...embedded.suffixes.map(s =>
        `${s.charAt(0).toUpperCase() + s.slice(1)} (${embedded.axes.get(s).length} actions)`
      )];
      title = lines.join('\n');
    }

    badge.title = title;
    badge.hidden = false;
    if (!badge.querySelector('svg')) {
      badge.appendChild(icon(FileCheck, { width: 20, height: 20, 'stroke-width': 1.75 }));
    }
    // The top bar's sync chip says what the badge says: a script is loaded.
    // It refreshed only on play / pause / ended or a device change, so a
    // just-opened paused video read "No script" (block F verify-1, cosmetic,
    // also in v0.9.2).
    this._updatePlayerSyncChip?.();
  }

  // --- Navigation Stack ---

  /** Map of view IDs to their container elements. Add new views here. */
  _getViewEl(viewId) {
    const map = {
      'library': document.getElementById('library-container'),
      'player': document.getElementById('player-container'),
      'playlists': document.getElementById('playlists-container'),
      'categories': document.getElementById('categories-container'),
    };
    return map[viewId] || null;
  }

  /** Current view (top of stack). */
  _currentView() {
    return this._navStack[this._navStack.length - 1];
  }

  /** Navigate to a view, pushing the current view onto the history stack. */
  _navigateTo(viewId) {
    const current = this._currentView();
    if (current === viewId) return;

    // Run leave hook for current view
    this._onLeaveView(current);

    // Hide all view elements. Exception: when the mini-player is docked,
    // keep the player container visible (it floats as a fixed corner
    // overlay over the target view) unless we're navigating INTO the
    // player, which expands it back to full and clears mini mode.
    for (const vid of ['library', 'player', 'playlists', 'categories']) {
      if (vid === 'player' && this._miniActive && viewId !== 'player') continue;
      const el = this._getViewEl(vid);
      if (el) el.hidden = true;
    }

    // Show target
    const targetEl = this._getViewEl(viewId);
    if (targetEl) targetEl.hidden = false;

    // For top-level nav-bar views (not player), reset stack to just the target
    if (viewId !== 'player') {
      this._navStack = [viewId];
    } else {
      this._navStack.push(viewId);
    }

    // Run enter hook for new view
    this._onEnterView(viewId);
  }

  /** Go back to the previous view. */
  _navigateBack() {
    // Try component's internal sub-nav first (e.g. detail → grid)
    const current = this._currentView();
    if (current === 'playlists' && this.playlists.navigateBack()) return;
    if (current === 'categories' && this.categories.navigateBack()) return;

    if (this._navStack.length <= 1) return; // nowhere to go

    const leaving = this._navStack.pop();
    const target = this._currentView();

    this._onLeaveView(leaving);

    const leavingEl = this._getViewEl(leaving);
    const targetEl = this._getViewEl(target);
    // Keep the docked mini-player visible when backing out of the player
    // (it floats over the target view); other leaves hide normally.
    if (leavingEl && !(leaving === 'player' && this._miniActive)) leavingEl.hidden = true;
    if (targetEl) targetEl.hidden = false;

    this._onEnterView(target);
  }

  /** Hook called when entering a view. */
  _onEnterView(viewId) {
    // Reflect the active view on #app so CSS can adapt (e.g. the queue panel
    // clears the library filter/sort bar in library view but not in player).
    const appEl = document.getElementById('app');
    if (appEl) appEl.dataset.view = viewId;
    // The Sync tab's "This video" row shows only while a video plays here.
    this._emitVideoSyncOffsetRowChanged?.();

    // Caption strip follows the view: transparent over the player's video,
    // normal themed chrome everywhere else.
    this._syncCaptionOverlay();

    // Show/hide nav bar (hidden during player)
    if (viewId === 'player') {
      // Entering the full player always clears the docked mini-player
      // (whether via Expand or by loading a new video from the library).
      this._clearMiniplayer();
      this.navBar.hide();
      // If a deferred PiP teardown is pending (user navigated away with PiP
      // open and now they're back), signal the leavepictureinpicture handler
      // to NOT run the teardown when PiP eventually closes. They returned
      // to active playback before PiP ended; the normal next-leave will
      // teardown properly.
      if (this._pipTeardownPending) this._pipTeardownCancelled = true;
    } else {
      this.navBar.show();
      this.navBar.setActive(viewId);
    }
    // The nav bar above the backend banner just came or went (V80).
    this._syncBackendBannerOffset?.();

    if (viewId === 'library') {
      // Recheck source availability before showing (drive may have been disconnected)
      this._refreshCollectionsUI().then(() => {
        this.library.show(this._getViewEl('library'));
        // Re-anchor the queue panel below the (now-rendered) filter/sort bar
        // if it's open (e.g. returning to library from the player).
        if (this.queuePanel?.visible) this._positionQueuePanelForView();
      });
      return;
    } else if (viewId === 'playlists') {
      this.playlists.show(this._getViewEl('playlists'));
    } else if (viewId === 'categories') {
      this.categories.show(this._getViewEl('categories'));
    }
    // Same re-anchor for the other browse views: their headers render
    // synchronously in show() (V27).
    if (this.queuePanel?.visible) this._positionQueuePanelForView();
  }

  /** Hook called when leaving a view. */
  _onLeaveView(viewId) {
    if (viewId === 'player') {
      // Drop OS fullscreen FIRST, before any of the branches below. Leaving
      // the player while fullscreen otherwise left the container as
      // `document.fullscreenElement`, so it kept filling the display no
      // matter what CSS said — the mini-player docked at "full screen" with
      // its corner styling ignored, the back arrow hidden with the top bar,
      // and the library unreachable behind it. See exitFullscreenForNav.
      exitFullscreenForNav();
      // An End-of-list card goes with the player view (R4-01). Left up behind
      // the library, a video queued there turned it into a next-up card for a
      // video already at its end, which fired at once: Add to queue switched
      // to the player and loaded the queued video. Dismissed for this video,
      // on every way out (torn down, mini player, PiP). A next-up card is
      // kept: the mini player counts it down and advances in the corner.
      // Except one offered AFTER the video ended (a queue change under End
      // of list in the player view): it has no playing video to ride on, so
      // left up it counted down behind the library and then switched back to
      // the player to load its video (R4-01 fix-up, real-app verifier 1).
      if (this.upNextEngine?.visible
        && (this.upNextEngine.endOfListShown || this.upNextEngine.afterEndShown)) this.upNextEngine.dismiss();
      // The player window owns playback: the inline <video> here only holds
      // the file, and every engine is bound to the window's clock. Leaving
      // this view must not tear that down. Popping out from the player view
      // sends this window to the library (_activatePlayerWindow) right after
      // the engines were restarted on the window's clock, and the teardown
      // below stopped them all again and sent each device a stop: no device
      // followed the detached player at all (verify-1, 2026-11-07; also in
      // v0.9.2).
      if (this._playerWindowActive) return;
      // PiP guard: if the user popped the video into Picture-in-Picture and
      // is navigating away, they explicitly opted into continued playback in
      // a floating window. Tearing the video + sync engines down here breaks
      // that expectation — the video would either freeze (we pause it) or
      // keep playing silently without driving the device (we stop sync).
      // Defer the teardown until PiP actually closes; if the user comes
      // back to the player view first, the deferred teardown is cancelled.
      if (this._isOurVideoInPip()) {
        this._beginDeferredPipTeardown();
        return;
      }
      // Mini-player: if a video is actively playing, keep it alive as a
      // docked corner overlay instead of tearing playback down, so the
      // user can browse the library while it plays (community #181).
      // Phase 1 of SCOPE-separate-player-window.md.
      if (this._shouldEnterMiniplayer()) {
        this._enterMiniplayer();
        return;
      }
      this._teardownPlayback();
    } else if (viewId === 'library') {
      this.library.hide();
    } else if (viewId === 'playlists') {
      this.playlists.hide();
    } else if (viewId === 'categories') {
      this.categories.hide();
    }
  }

  /**
   * Load the active-locale bundle at boot. Order matters:
   *   1. Read saved `settings.player.language` (default 'en').
   *   2. Read system locale via the preload bridge (used later by the
   *      language-prompt modal to highlight the OS-detected option).
   *   3. initI18n() activates the saved locale.
   *   4. translatePage() walks the initial DOM after a microtask so
   *      index.html's data-i18n elements pick up the active strings.
   * The language-prompt modal fires later via `_promptLanguageIfApplicable`
   * once init is otherwise complete (so it lands on top of the rendered UI,
   * not during paint).
   */
  async _initI18n() {
    const savedLocale = dataService.get('player.language') || 'en';
    let systemLocale = 'en';
    try {
      systemLocale = await window.funsync.getSystemLocale();
    } catch { /* preload bridge missing — fall through with 'en' */ }
    this._systemLocale = systemLocale;
    await initI18n({ savedLocale });
    translatePage(document);
  }

  /**
   * Surface the first-launch language picker modal if the user has not
   * yet explicitly chosen a language (i.e. `player.languageSelected` is
   * falsy). If they dismiss the modal without choosing, the flag stays
   * falsy and the modal re-appears on the next launch — they cannot
   * accidentally "miss" the prompt by clicking outside it.
   *
   * Existing 0.5.x users who upgrade to this build will see the modal
   * once on their next launch, regardless of OS locale, because the
   * flag is absent from their config.json until they pick.
   */
  async _promptLanguageIfApplicable() {
    if (dataService.get('player.languageSelected')) return;
    const { openLanguagePromptModal } = await import('../components/language-prompt-modal.js');
    const { locale } = await openLanguagePromptModal({
      settings: dataService,
      systemLocale: this._systemLocale,
    });
    if (locale) {
      const langName = LOCALE_LABELS[locale] || locale;
      showToast(t('i18n.switched', { language: langName }), 'success', 2000);
    }
  }

  /** Thin App method delegating to the pure pip-guard helper for testability. */
  _isOurVideoInPip() {
    return isVideoInPip(this.videoPlayer?.video);
  }

  /** Thin App method delegating to the pure pip-guard helper. */
  _teardownPlayback() {
    teardownPlayback(this);
  }

  /** Thin App method delegating to the pure pip-guard helper. */
  _beginDeferredPipTeardown() {
    beginDeferredPipTeardown(this, this);
  }

  // --- Mini-player (Phase 1 of SCOPE-separate-player-window.md) ---
  //
  // Keeps the video playing in a docked corner overlay while the user
  // browses the library, instead of tearing playback down on leave. No
  // second window, no IPC — the <video> element never moves, so sync
  // engines and every playback feature keep running untouched. Community
  // #181 (belgriffinite) / #189 (deaf).

  /** Decide whether leaving the player should dock into the mini-player. */
  _shouldEnterMiniplayer() {
    const v = this.videoPlayer?.video;
    return shouldEnterMiniplayer({
      // Opt-in since 0.9.3: only an explicit true docks (store.js default).
      enabled: this.settings?.get?.('player.miniPlayer') === true,
      hasVideo: !!(v && (v.currentSrc || v.src)),
      paused: !!v?.paused,
      ended: !!v?.ended,
    });
  }

  /** Dock the player as a fixed corner overlay (playback continues). */
  _enterMiniplayer() {
    const el = this._getViewEl('player');
    if (!el) { this._teardownPlayback(); return; }
    this._miniActive = true;
    el.hidden = false;
    el.classList.add('player-container--mini');
    this.upNextCard?.setMini(true); // compact "Next video starts in Ns" strip
    this._updateMiniPlayPauseIcon();
  }

  /** Point the mini play/pause button icon at the video's actual state. */
  _updateMiniPlayPauseIcon() {
    const btn = document.getElementById('miniplayer-playpause');
    if (!btn) return;
    const paused = !!(this.videoPlayer?.video?.paused ?? true);
    btn.replaceChildren(icon(paused ? Play : Pause, { width: 16, height: 16 }));
  }

  // --- Detached player window (Phase 2 of SCOPE-separate-player-window.md) ---
  //
  // Phase 2a: window lifecycle only — open/close + the READY → INITIAL_STATE
  // handshake (theme + locale). The <video> move (2b) and the IPC playback
  // proxy that keeps device sync following the detached clock (2c) build on
  // this. The window is treated like an external playback source, à la VR.

  _initPlayerWindow() {
    this._playerWindowOpen = false;
    this._playerWindowActive = false; // sync take-over engaged
    this._playerWinProxy = null;
    window.funsync?.onPlayerPopoutEvent?.((evt) => {
      if (!evt) return;
      if (evt.type === 'opened') {
        this._playerWindowOpen = true;
        this._updatePlayerWindowButton();
        return;
      }
      // The window's renderer stopped answering, or answers again (FT-098).
      if (evt.type === 'unresponsive') { this._onPlayerWindowHung(); return; }
      if (evt.type === 'responsive') { this._onPlayerWindowAnswering(); return; }
      if (evt.type === 'closed') {
        this._playerWindowOpen = false;
        this._updatePlayerWindowButton();
        this._playerWindowHeld = false;
        this._playerWindowHungToast?.dismiss?.();
        this._playerWindowHungToast = null;
        // X / Z still held in the window that closed: their key-up will
        // never come, so let go here (a toggle ignores a release anyway).
        this._releasePopoutHoldKeys?.();
        this._deactivatePlayerWindow(); // fold playback back to the inline player
        // Closed from the hung-window toast (FT-098): the video is here now,
        // paused where the window was. Show it.
        if (evt.reason === 'unresponsive' && this._currentView() !== 'player') this._navigateTo('player');
        // Closed for an editor Dock (E-07): show the player view, where the
        // docked editor is, paused or playing.
        if (this._showPlayerAfterFoldBack) {
          this._showPlayerAfterFoldBack = false;
          if (this.scriptEditor?.isOpen && this._currentView() !== 'player') this._navigateTo('player');
        }
        // The window did not close by itself: its renderer died and main
        // destroyed it (V14). Say so, or the window just vanishes.
        if (evt.reason === 'crashed') showToast(t('player.windowCrashed'), 'warn', 8000);
        return;
      }
      if (evt.type === 'message') this._onPlayerWindowMessage(evt.payload);
    });
    // Belt and braces for V13: while the pop-out owns playback the inline
    // <video> only holds the file, and anything that plays it starts a
    // second, hidden copy. The load paths (library click, Play All, a
    // dropped or opened file) and the keys route to the pop-out instead.
    // Anything else that plays the inline element is stopped here,
    // including the mini-player, the VR-flatten click and the editor's
    // play. That is silent, but better than a hidden copy driving nobody
    // knows what. Not for a src the pop-out cannot take (blob:, remote),
    // which folds back and plays inline on purpose.
    const inline = this.videoPlayer?.video;
    inline?.addEventListener?.('play', () => {
      if (!this._playerWindowActive || !this._currentPopoutVideo()) return;
      console.warn('[PlayerWindow] blocked inline play while the pop-out owns playback');
      inline.pause();
    });
  }

  /**
   * The player window stopped answering (FT-098, also in v0.9.2). It was
   * only logged: no clock reaches this window while it hangs, the video in
   * it may play on, and nothing told the user. The devices stop as on a
   * pause (the engines stay bound to the window's clock, so a Play brings
   * them back) plus a stop to each device, and a toast that stays offers to
   * close the window. Nothing is killed on its own: it may recover.
   */
  _onPlayerWindowHung() {
    if (!this._playerWindowOpen) return;
    console.warn('[PlayerWindow] not responding: devices stopped until Play');
    this._playerWindowHeld = true;
    this._playerWinProxy?.handlePause?.();
    if (this.handyManager?.connected) this.handyManager.hsspStop();
    if (this.buttplugManager?.connected) this.buttplugManager.stopAll();
    if (this.tcodeManager?.connected) this.tcodeManager.stop();
    if (this.autoblowManager?.connected) this.autoblowManager.syncStop();
    if (this._playerWindowHungToast) return;
    const box = document.createElement('div');
    box.className = 'update-toast';
    const text = document.createElement('span');
    text.textContent = t('player.windowHung');
    const btn = document.createElement('button');
    btn.className = 'update-toast__btn';
    btn.textContent = t('player.windowHungClose');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.disabled = true;
      Promise.resolve(window.funsync?.playerPopoutClose?.()).catch((err) => {
        btn.disabled = false;
        console.warn('[PlayerWindow] close failed:', err);
      });
    });
    box.append(text, btn);
    this._playerWindowHungToast = showToast(box, 'warn', 0) || null;
  }

  /**
   * The hung player window answers again (FT-098). The toast goes. The
   * devices stay stopped until the user plays: the window is paused too, so
   * what it shows and what the devices do agree, and a Play starts both.
   */
  _onPlayerWindowAnswering() {
    this._playerWindowHungToast?.dismiss?.();
    this._playerWindowHungToast = null;
    if (!this._playerWindowHeld || !this._playerWindowOpen) return;
    console.info('[PlayerWindow] responding again: paused, devices wait for Play');
    window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.SET_PLAY_STATE, { paused: true }));
    showToast(t('player.windowRecovered'), 'info', 6000);
  }

  /**
   * The player window closed (or crashed) with X or Z still held in it:
   * its key-up can never arrive, so the hold is let go here, as the phone's
   * disconnect lets go of its Orgasm hold. In toggle mode the handlers
   * ignore a release, so a toggled X or Z stays as the user left it.
   */
  _releasePopoutHoldKeys() {
    const held = this._popoutHoldKeys || {};
    this._popoutHoldKeys = null;
    if (held.orgasm) {
      try { this._onOrgasmHold(false); } catch (err) { console.warn('[PlayerWindow] X release failed:', err?.message || err); }
    }
    if (held.edge) {
      try { this._onEdgeHold(false); } catch (err) { console.warn('[PlayerWindow] Z release failed:', err?.message || err); }
    }
  }

  _onPlayerWindowMessage(payload) {
    const type = PLAYERWIN.classifyMessage(payload);
    if (type === PLAYERWIN.READY) {
      // Pop-out finished loading → take over sync, then hand it the video.
      this._sendPlayerWindowInitialState(); // theme + locale (video via LOAD_VIDEO)
      this._activatePlayerWindow();
      this._sendLoadVideoToPopout(this._popoutWasPlaying !== false);
      // The rest of what the pop-out cannot read for itself (V17): volume
      // and loop (it opened at full volume and looping off), and the queue
      // (prev/next and "2 / 4" stayed hidden until the first navigation).
      this._sendPlayerWindowPlaybackState();
      this._updateQueueUI();
      return;
    }
    if (type === PLAYERWIN.SWITCH_VARIANT) {
      // Variant clicked in the pop-out → do the real switch in main (loads
      // script + re-uploads to cloud devices), then re-stream fresh data.
      this._handlePhoneSwitchVariant(payload.label)
        .then(() => this._streamPlayerWindowData())
        .catch((err) => console.warn('[PlayerWindow] variant switch failed:', err));
      return;
    }
    if (type === PLAYERWIN.SET_INLINE_VIZ) {
      // Pop-out toggled a TL/HM overlay. Main owns the settings store, so
      // persist it here and mirror it onto the inline player's own overlay
      // and menu items — the two windows stay in step either way round.
      const key = payload.key === 'heatmap' ? 'heatmap' : 'timeline';
      const on = !!payload.on;
      const settingKey = key === 'heatmap' ? 'player.inlineHeatmap' : 'player.inlineTimeline';
      this.settings.set(settingKey, on);
      if (key === 'heatmap') this.inlineViz?.setHeatmapVisible(on);
      else this.inlineViz?.setTimelineVisible(on);
      const btn = document.getElementById(key === 'heatmap' ? 'btn-inline-hm' : 'btn-inline-tl');
      btn?.setAttribute('aria-checked', String(on));
      return;
    }
    if (type === PLAYERWIN.LOAD_PREV) { this._playPrev(); return; }
    if (type === PLAYERWIN.LOAD_NEXT) { this._playNext(); return; }
    if (type === PLAYERWIN.UP_NEXT_ACTION) { this._handlePopoutUpNextAction(payload.action); return; }
    // X / Z pressed and let go in the player window (next major): the
    // handlers this window's own keyboard calls, so hold or toggle, the
    // Edge pattern and every X / Z rule apply as for a key pressed here.
    if (type === PLAYERWIN.ORGASM_HOLD || type === PLAYERWIN.EDGE_HOLD) {
      const active = payload.active === true;
      const which = type === PLAYERWIN.ORGASM_HOLD ? 'orgasm' : 'edge';
      this._popoutHoldKeys = { ...(this._popoutHoldKeys || {}), [which]: active };
      if (which === 'orgasm') this._onOrgasmHold(active);
      else this._onEdgeHold(active);
      return;
    }
    if (!this._playerWindowActive || !this._playerWinProxy) return;
    // The pop-out's <video> is the authority; its clock drives the proxy,
    // which the sync engines read (exactly as the web-remote phone does).
    if (type === PLAYERWIN.TIME_TICK) {
      this._playerWinProxy.updateState({
        // Held after a hang (FT-098): the devices wait for a Play.
        at: payload.timeMs, paused: payload.paused || this._playerWindowHeld === true, rate: payload.rate,
        // A stalled picture (N-01) reaches the engines as a pause and its
        // end as a 'playing' that re-anchors the Handy / Autoblow.
        stalled: payload.stalled === true,
      });
      // The rate a key asked for has arrived: the proxy has it now.
      if (this._popoutRateAsked?.value === payload.rate) this._popoutRateAsked = null;
      // Drive the Up Next engine off the pop-out's clock (its inline event
      // hooks are dead while detached). Looping in the pop-out suppresses
      // it — a looped video should never auto-advance. Editor-open in main
      // still suppresses too (_syncUpNextSuppression reads _popoutLoop
      // while detached).
      this._popoutLoop = !!payload.loop;
      if (this.upNextEngine) {
        this._syncUpNextSuppression();
        this.upNextEngine.check();
      }
      // The no-frames check, on the window's own <video> (E-10).
      if ('frames' in payload) this._checkVideoTrackDecodes?.('frames', payload);
    } else if (type === PLAYERWIN.VIDEO_EVENT) {
      switch (payload.event) {
        case 'play':
          // A Play in the window after a hang ends the hold (FT-098).
          this._playerWindowHeld = false;
          this._playerWinProxy.handlePlay();
          break;
        case 'pause':
          this._playerWinProxy.handlePause();
          // A pause saves the position at once, as an inline pause does
          // (_initResumeTracking). Only the 15 s tick recorded it, so a pause
          // in the window and then closing it lost up to 15 s (verify-1,
          // 2026-11-07; also in v0.9.2).
          this._recordResumePosition?.({ force: true });
          break;
        case 'seeked':
          this._playerWinProxy.seek(payload.timeMs);
          // It reached the last seek a key asked for; an earlier one
          // arriving late leaves the newer target in place.
          if (this._popoutSeekAsked
            && Math.abs(payload.timeMs / 1000 - this._popoutSeekAsked.value) < 0.25) {
            this._popoutSeekAsked = null;
          }
          break;
        case 'ended':
          this._playerWinProxy.handleEnded();
          // The natural end is saved as watched before anything advances, as
          // inline.
          this._recordResumePosition?.({ force: true });
          this._onPopoutVideoEnded();
          break;
        case 'volumechange': this._mirrorPopoutVolume(payload); break;
        default: break;
      }
    } else if (type === PLAYERWIN.VIDEO_META && payload.durationMs) {
      // Proxy duration is in seconds (see _activatePlayerWindow).
      this._playerWinProxy.updateState({ duration: payload.durationMs / 1000 });
    }
  }

  /**
   * The pop-out's <video> finished. Mirror the inline dual-path advance:
   * Up Next (auto/on) drives the countdown + advance via its own timer;
   * when it's off (or has no next), fall back to the Play-All queue advance
   * (the inline `queueEndedListener` equivalent). A recent-advance timestamp
   * (`_lastUpNextAdvanceAt`, stamped when the engine fires onPlayNext)
   * prevents a double advance when both would fire on the same end.
   */
  _onPopoutVideoEnded() {
    // A zero-length trailing zone makes check() fire onPlayNext synchronously.
    this.upNextEngine?.check();
    // Up Next (auto) may have just advanced via its own wall-clock countdown
    // timer a beat before this end arrived over IPC — a timestamp (not a
    // per-call latch) is what survives that cross-renderer window and stops
    // a double-skip. If a card is still counting down, its timer will fire.
    const advancedRecently = this._lastUpNextAdvanceAt
      && (Date.now() - this._lastUpNextAdvanceAt) < 1000;
    const upNextDriving = advancedRecently
      || (this.upNextEngine?.visible && this.upNextEngine?.mode !== 'off');
    if (!upNextDriving) this._advanceQueueOnEnded();
  }

  /** Relay an Up Next card interaction from the pop-out to the one engine. */
  _handlePopoutUpNextAction(action) {
    const eng = this.upNextEngine;
    if (!eng) return;
    switch (action) {
      case 'play': eng.playNext(); break;
      // Same consume-once flag the main-window card sets — the advance
      // itself runs through the identical path either way.
      case 'start-over': this._upNextStartOver = true; eng.playNext(); break;
      case 'dismiss': eng.dismiss(); break;
      case 'pause': eng.pauseCountdown(); break;
      case 'resume': eng.resumeCountdown(); break;
      case 'back': eng.dismiss(); break; // end-of-list CTA: just dismiss (source-nav is a main-window concern, §9.3)
      default: break;
    }
  }

  /**
   * Send a playback command to the detached player window while it owns
   * playback (V13). Its <video> is the only one playing. The inline one is
   * paused and hidden, and the main window's keys and the global play/pause
   * hotkey used to act on it: Space started a second, invisible copy while
   * the pop-out and the device carried on, and that copy's loop flag (off)
   * cancelled the pop-out's loop, so a looping video advanced at its end.
   *
   * Commands: 'toggle', 'play', 'pause', 'seekBy' (s), 'seekTo' (s), 'seekToEnd',
   * 'stepFrames' (frames; the editor's), 'volumeBy' (0-1 step), 'toggleMute',
   * 'rate' (+1 / -1 preset step), 'setRate' (a rate; the editor's Speed list, E-06), 'toggleLoop'. Relative ones resolve against the pop-out's own state:
   * clock, pause and rate from the proxy its TIME_TICKs feed; volume from
   * the inline element, which mirrors every pop-out volume change
   * (_mirrorPopoutVolume) and is what player.volume is saved from.
   *
   * The proxy only learns a seek or a rate over IPC, once the pop-out has
   * made it ('seeked', a TIME_TICK). A key pressed before that would step
   * from the old value: two quick > presses both sent 1.25, and a held
   * arrow key lost steps. So a seek or a rate this sends is remembered
   * (_popoutSeekAsked / _popoutRateAsked) and the next step builds on it,
   * until the pop-out reports that value back or a second passes.
   *
   * @returns {boolean} true when the pop-out took it; false means act inline.
   */
  _playerWindowPlayback(command, arg) {
    if (!this._playerWindowActive) return false;
    const relay = (type, fields) => window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(type, fields));
    const proxy = this._playerWinProxy;
    const duration = proxy?.duration || 0;
    const now = performance.now();
    const asked = (entry) => (entry && now - entry.at < 1000 ? entry.value : null);
    const seekTo = (sec) => {
      const target = duration > 0 ? Math.min(sec, duration) : sec;
      const timeMs = Math.round(Math.max(0, target) * 1000);
      relay(PLAYERWIN.SEEK, { timeMs });
      this._popoutSeekAsked = { value: timeMs / 1000, at: now };
    };
    const inline = this.videoPlayer;
    const relayVolume = () => relay(PLAYERWIN.SET_VOLUME, { volume: inline.video.volume, muted: inline.video.muted });
    switch (command) {
      // The window's own paused flag (N-01): during a stall the proxy reads
      // paused while the video plays on, and a toggle must pause it.
      case 'toggle': relay(PLAYERWIN.SET_PLAY_STATE, { paused: proxy ? !(proxy.sourcePaused ?? proxy.paused) : false }); break;
      case 'play': relay(PLAYERWIN.SET_PLAY_STATE, { paused: false }); break;
      case 'pause': relay(PLAYERWIN.SET_PLAY_STATE, { paused: true }); break; // the editor pop-out's Space
      case 'seekBy': {
        const from = asked(this._popoutSeekAsked) ?? (proxy?.currentTime || 0);
        seekTo(from + (Number(arg) || 0));
        break;
      }
      case 'seekTo': seekTo(Number(arg) || 0); break;
      // The editor's frame step (arg frames, D-01): pause first and step from
      // where the pop-out is, or the step asked before, as the inline
      // VideoPlayer.stepFrames does (same frame rate).
      case 'stepFrames': {
        const frames = Number(arg) || 0;
        if (!frames) break;
        relay(PLAYERWIN.SET_PLAY_STATE, { paused: true });
        const from = asked(this._popoutSeekAsked) ?? (proxy?.currentTime || 0);
        const fps = inline?._estimateFps?.() || 30;
        // Just past the target frame's start: on it, or a hair before (the
        // ms rounding below), showed the previous frame (D-02, verify-1).
        seekTo(frameStepTime(from, frames, fps));
        break;
      }
      // A hair before the end, as the inline End key does: seeking exactly
      // to the duration can fire 'ended' and advance the playlist.
      case 'seekToEnd': if (duration > 0) seekTo(duration - 0.05); break;
      case 'volumeBy':
        if (!inline?.video) break;
        inline.setVolume(inline.video.volume + (Number(arg) || 0));
        relayVolume();
        break;
      case 'toggleMute':
        if (!inline?.video) break;
        inline.toggleMute();
        relayVolume();
        break;
      case 'rate': {
        const from = asked(this._popoutRateAsked) ?? (proxy?.playbackRate || 1);
        const i = PLAYBACK_RATE_PRESETS.indexOf(from);
        const next = i === -1 ? 1 : PLAYBACK_RATE_PRESETS[i + (arg > 0 ? 1 : -1)];
        if (next) {
          relay(PLAYERWIN.SET_RATE, { rate: next });
          this._popoutRateAsked = { value: next, at: now };
        }
        break;
      }
      case 'setRate': {
        const rate = Number(arg);
        if (!(rate > 0)) break;
        relay(PLAYERWIN.SET_RATE, { rate });
        this._popoutRateAsked = { value: rate, at: now };
        break;
      }
      case 'toggleLoop':
        this._popoutLoop = !this._popoutLoop;
        relay(PLAYERWIN.SET_LOOP, { loop: this._popoutLoop });
        this._syncUpNextSuppression();
        this.upNextEngine?.check();
        break;
      default: return false;
    }
    return true;
  }

  /** Start playback where it lives: the pop-out while detached, else the inline <video>. */
  _startPlayback() {
    if (this._playerWindowPlayback('play')) return;
    this.videoPlayer.video.play().catch(() => {});
  }

  /**
   * The pop-out's volume changed (its slider, its M key, or a SET_VOLUME
   * from here). Mirror it onto the inline element: that is what the next
   * volume key steps from, what player.volume is saved from, and what
   * playback folds back to when the window closes (V13).
   */
  _mirrorPopoutVolume({ volume, muted } = {}) {
    const vp = this.videoPlayer;
    if (!vp?.video) return;
    if (typeof volume === 'number' && Math.abs(vp.video.volume - volume) > 0.001) vp.setVolume(volume);
    if (typeof muted === 'boolean' && vp.video.muted !== muted) vp.toggleMute();
  }

  /**
   * Volume, mute and loop for a pop-out that has just taken over (V17). It
   * starts from the element defaults (full volume, loop off), so a video
   * looped inline used to auto-advance as soon as it was popped out.
   */
  _sendPlayerWindowPlaybackState() {
    const vid = this.videoPlayer?.video;
    if (!vid) return;
    const relay = (type, fields) => window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(type, fields));
    relay(PLAYERWIN.SET_VOLUME, { volume: vid.volume, muted: vid.muted });
    this._popoutLoop = !!vid.loop;
    relay(PLAYERWIN.SET_LOOP, { loop: this._popoutLoop });
    this._syncUpNextSuppression();
  }

  /** Build the LOAD_VIDEO payload for the pop-out, or null if unsupported. */
  _currentPopoutVideo() {
    const vid = this.videoPlayer?.video;
    if (!vid) return null;
    // Decided from the path loadVideo sets synchronously, never from the
    // element: `vid.currentSrc` lags a source swap (the browser's resource
    // selection is async), and so does `vid.src` for HLS. On a queue advance
    // it still pointed at the PREVIOUS video for a beat, which made the
    // pop-out replay the same file (title was already new). With no path it
    // still did that: a File dropped over a playing pop-out (blob:) was sent
    // to the pop-out as the previous clip's file:// URL under the new title,
    // instead of folding back (V13 review).
    //
    // 2b supports local files (file://). No local path means a blob: URL
    // (drag-drop of a File with no path, per-renderer) or a remote/HLS
    // stream (needs the proxy pipeline); both keep the inline player.
    if (!this._currentVideoPath || this._currentIsRemote) return null;
    // A container Chromium cannot open plays from its remuxed copy (FT-076).
    const remuxed = this._remuxedCopy?.original === this._currentVideoPath ? this._remuxedCopy.path : null;
    const src = pathToFileURL(remuxed || this._currentVideoPath);
    if (!src.startsWith('file:')) return null;
    return {
      src,
      title: this._currentVideoName || '',
      timeMs: Math.round((vid.currentTime || 0) * 1000),
      autoplay: !vid.paused,
    };
  }

  /**
   * Settings > Playback changed the HM playhead marker or the overlay
   * opacity: tell an open pop-out now (FT-028), not at its next open.
   * `changed` is the value just set; the other comes from settings.
   */
  _sendPlayerWindowInlineVizState(changed = {}) {
    if (!this._playerWindowOpen && !this._playerWindowActive) return;
    const playhead = typeof changed.playhead === 'boolean'
      ? changed.playhead
      : this.settings?.get?.('player.inlineHeatmapPlayhead') === true;
    const opacity = Number.isFinite(Number(changed.opacity))
      ? Number(changed.opacity)
      : (Number(this.settings?.get?.('player.inlineVizOpacity')) || INLINE_VIZ_OPACITY_DEFAULT);
    window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.INLINE_VIZ_STATE, { playhead, opacity }));
  }

  _sendPlayerWindowInitialState() {
    window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.INITIAL_STATE, {
      theme: document.documentElement.dataset.theme || 'dark',
      uiStyle: document.documentElement.dataset.style || 'classic',
      locale: this.settings?.get?.('player.language') || 'en',
      backendPort: this.backendPort || null,
      // Inline TL/HM state so the pop-out opens with the same overlays (and
      // the same opacity) the inline player was showing.
      inlineViz: {
        timeline: this.settings?.get?.('player.inlineTimeline') === true,
        heatmap: this.settings?.get?.('player.inlineHeatmap') === true,
        playhead: this.settings?.get?.('player.inlineHeatmapPlayhead') === true,
        opacity: Number(this.settings?.get?.('player.inlineVizOpacity')) || INLINE_VIZ_OPACITY_DEFAULT,
      },
      video: null, // sent separately via LOAD_VIDEO (unified first-open + re-route)
    }));
  }

  /**
   * Send the current video to the pop-out. `fromStart` forces position 0 —
   * used for a fresh load (queue advance / library click) where the inline
   * <video>'s currentTime still reads the PREVIOUS clip's end for a beat
   * (async resource selection); the first-open take-over preserves position.
   */
  _sendLoadVideoToPopout(autoplay, fromStart = false) {
    const v = this._currentPopoutVideo();
    if (!v) return;
    // `fromStart` may instead carry the position to send ({ timeMs }): the
    // remux re-send (FT-076) repeats the first send's position.
    const timeMs = typeof fromStart === 'object' && fromStart
      ? (fromStart.timeMs || 0)
      : (fromStart ? 0 : v.timeMs);
    // What was asked of the pop-out for this video, so a remux that lands
    // later can send the playable copy with the same intent (FT-076).
    this._popoutLoadSent = { path: this._currentVideoPath, timeMs, autoplay: autoplay !== false };
    window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.LOAD_VIDEO, {
      ...v, timeMs, autoplay: autoplay !== false,
    }));
    this._streamPlayerWindowData();
  }

  /**
   * Route a freshly-loaded video into the open pop-out. The load path set
   * up the inline <video> (hidden) + funscript + cloud uploads with engines
   * on the local player; re-activating rebinds them onto the proxy and
   * hands the video to the pop-out. Unsupported srcs (blob/HLS) fold the
   * pop-out back and play inline so we never strand it. Shared by the
   * library-click and queue-navigation paths.
   *
   * `autoplay` is the caller's decision, exactly as for the inline player:
   * a library click passes player.autoplayOnOpen (it used to take the
   * default and always autoplay, V15). `reveal` raises a minimised or
   * buried window (V16); it defaults to off for an auto-advance.
   */
  async _routeLoadedVideoToPlayerWindow(autoplay = true, { reveal } = {}) {
    if (!this._playerWindowActive) return;
    if (this._currentPopoutVideo()) {
      this._activatePlayerWindow();
      // Cloud-upload gate, as for the inline <video>: with a Handy or
      // Autoblow upload in flight, load paused and let _resolveCloudUpload
      // (or the 8 s fallback) start it, so the video cannot run ahead of a
      // device that has no script yet (V15).
      const gated = autoplay !== false && this._waitingForScript;
      this._sendLoadVideoToPopout(autoplay !== false && !gated, true); // fresh clip → start at 0
      // A gated load still means "play": a remux re-send must not lose it (FT-076).
      if (this._popoutLoadSent) this._popoutLoadSent.wanted = autoplay !== false;
      if (gated) this._showScriptLoadingOverlay();
      // A minimised or buried window plays sound and drives the device with
      // no picture (V16). Bring it up for anything the user asked for; an
      // auto-advance nobody asked to see leaves the window where it is.
      if (reveal ?? !this._autoAdvancing) window.funsync?.playerPopoutReveal?.();
    } else {
      // A src the pop-out cannot open (a dropped File's blob:, a remote
      // stream): fold back and play it inline. The proxy still holds the
      // PREVIOUS clip's clock, and the fold-back would start the new clip
      // at that position. Clear it first.
      this._playerWinProxy?.reset();
      await window.funsync?.playerPopoutClose?.(); // triggers fold-back
      this._navigateTo('player');
      this.videoPlayer?.video?.play?.().catch(() => {});
    }
  }

  /**
   * Stream the funscript-driven overlay data (heatmap, chapters/bookmarks,
   * variant list) to the pop-out so its reused ProgressBar + variant
   * selector render exactly like the inline player. The data lives here in
   * main with the devices; the pop-out is a display of it.
   */
  _streamPlayerWindowData() {
    if (!this._playerWindowOpen) return;
    const relay = (payload) => window.funsync?.playerPopoutRelay?.('to-popout', payload);
    const durationMs = Math.round((this.videoPlayer?.duration || 0) * 1000);
    if (this.funscriptEngine?.isLoaded) {
      relay(PLAYERWIN.makeMessage(PLAYERWIN.HEATMAP, {
        actions: this.funscriptEngine.getActions(), durationMs,
      }));
      relay(PLAYERWIN.makeMessage(PLAYERWIN.CHAPTERS, {
        chapters: this.funscriptEngine.getChapters(),
        bookmarks: this.funscriptEngine.getBookmarks(),
        // Stash S1: the linked scene's markers ride along (drawn next to
        // the script's chapters, never instead of them).
        stashMarkers: this._stashMarkerList || [],
        durationMs,
      }));
    } else if ((this._stashMarkerList || []).length > 0) {
      // No script, but the video's Stash scene has markers (Stash S1).
      relay(PLAYERWIN.makeMessage(PLAYERWIN.CHAPTERS, {
        chapters: [], bookmarks: [], stashMarkers: this._stashMarkerList, durationMs,
      }));
    }
    // `label` is what a switch matches on; `text` is what the window shows;
    // `main` marks the script the video opens on, with the word for it in
    // `mainTag`, this window's language (FN-03).
    const list = (this._allVariantsWithManual || []).map((v, i) => ({
      label: v.label, path: v.path, text: this._variantLabelText(v), main: i === this._mainVariantIndex,
    }));
    const activeIdx = this._activeVariantIndex ?? 0;
    const active = activeIdx >= 0 ? list[activeIdx] : null;
    const activeLabel = active?.label || '';
    // No entry plays (-1, see _showManageVariantsModal): nothing is marked,
    // and `activeText` names the script that still plays for the chip.
    const activeText = !active && this._activeVariantPath
      ? String(this._activeVariantPath).split(/[\\/]/).pop().replace(/\.funscript$/i, '')
      : undefined;
    // `activeIndex` marks the playing entry by place, so two entries with
    // the same label are not both marked (-1: none plays).
    relay(PLAYERWIN.makeMessage(PLAYERWIN.VARIANTS, {
      list, activeLabel, activeText, activeIndex: active ? activeIdx : -1, mainTag: t('variants.mainTag'),
    }));
  }

  /** Send one Up Next card sub-event to the pop-out (no-op if not detached). */
  _relayUpNext(fields) {
    if (!this._playerWindowActive) return;
    window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.UP_NEXT, fields));
  }

  /**
   * Mirror the Up Next "show" into the pop-out with the metadata its reused
   * UpNextCard needs (title/duration/funscript live here with the library,
   * not in the detached renderer), then stream the thumbnail once captured.
   */
  _relayUpNextShow(path, countdownSec) {
    if (!this._playerWindowActive) return;
    const v = this.library?.getVideoByPath?.(path);
    const name = v?.name || String(path || '').split(/[\\/]/).pop() || '';
    // The pop-out's card can't read settings or the play context, so the
    // resume label is resolved here and streamed with the rest of the meta.
    // Absent (null) means the detached card renders no resume row, exactly
    // like the main one.
    const resumeChoice = this._upNextResumeChoice(path);
    this._relayUpNext({
      action: 'show', path, countdownSec, name,
      duration: v?.duration || 0, hasFunscript: !!v?.hasFunscript,
      resumeLabel: resumeChoice?.label || null,
    });
    // Cache-first thumbnail (usually instant); stream it when ready as long
    // as the same card is still up.
    this._captureUpNextThumb(path).then((r) => {
      if (r?.dataUrl && this._playerWindowActive && this._upNextCurrentPath === path) {
        this._relayUpNext({ action: 'thumb', path, thumbDataUrl: r.dataUrl });
      }
    }).catch(() => { /* skeleton stays */ });
  }

  /**
   * Engage the pop-out as the playback authority. Modeled on the web-remote
   * take-over (`_onRemotePhoneConnected`) but lighter: the SAME video/script
   * is already loaded + uploaded, so we only pause the inline <video> and
   * rebind the sync engines to a RemotePlaybackProxy. The proxy is seeded
   * PAUSED so devices idle until the pop-out's <video> actually starts
   * playing (its VIDEO_EVENT 'play' drives the proxy from there).
   *
   * ⚠ HARDWARE-TEST REQUIRED (Handy HSSP re-anchor). SCOPE §9.5.
   */
  _activatePlayerWindow() {
    // Idempotent: safe to call again to re-bind onto a newly-loaded video
    // (library click while the pop-out is already open).
    const vid = this.videoPlayer?.video;
    if (!vid || !this._currentPopoutVideo()) return; // unsupported src — stay inline
    // Don't fight another external source. If VR / web-remote is driving,
    // the local <video> isn't the sync source, so there's nothing to hand off.
    if (this._remoteActive || this.vrBridge?.connected) return;

    const startMs = Math.round((vid.currentTime || 0) * 1000);
    const wasPlayingInline = !vid.paused;
    if (!vid.paused) vid.pause(); // pop-out becomes the audio + clock source
    if (this._miniActive) this._clearMiniplayer(); // no redundant corner overlay

    if (!this._playerWinProxy) this._playerWinProxy = new RemotePlaybackProxy();
    this._playerWinProxy.reset();
    // A seek or rate a key asked of the previous clip means nothing here.
    this._popoutSeekAsked = null;
    this._popoutRateAsked = null;
    // Proxy `duration` is in SECONDS (its internal end-guard compares against
    // currentTime-in-seconds); only `at` is ms. Seeding it in ms broke the
    // Up Next trailing-zone math (card never showed).
    this._playerWinProxy.updateState({ at: startMs, paused: true, duration: vid.duration || 0 });
    const proxyPlayer = this._playerWinProxy.asVideoPlayerWrapper();

    // Stop engines, repoint to the proxy, restart (idle until proxy plays).
    // Same script already set on cloud devices — no re-upload needed.
    //
    // The inline pause above fires its 'pause' AFTER the engine has been
    // unbound from it, and syncEngine.stop() sends nothing, so HSSP played on
    // through the hand-off until the window's first 'playing' (N-01, by
    // reading): seconds ahead on a slow drive, then a jump back. The other
    // engines' stop() already stops their devices. Also whenever the Handy
    // may be running at a re-route (a new video in the open pop-out): an
    // upload that landed before this started the engine on the proxy's
    // OLD clock, and the proxy, reset to paused below, would never send the
    // 'pause' that stops it (FN-01).
    const handyStop = !!this.handyManager?.connected
      && (wasPlayingInline || this.handyManager.hsspMayBeRunning !== false);
    if (this.syncEngine?._active) this.syncEngine.stop({ deviceStopped: handyStop });
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    if (this.handyHdspSync?.active) this.handyHdspSync.stop();
    if (handyStop) this.handyManager.hsspStop();

    if (this.buttplugSync && this.buttplugManager?.connected) {
      this.buttplugSync.player = proxyPlayer; this.buttplugSync.reloadActions(); this.buttplugSync.start();
    }
    if (this.tcodeSync && this.tcodeManager?.connected) {
      this.tcodeSync.player = proxyPlayer; this.tcodeSync.reloadActions(); this.tcodeSync.start();
    }
    if (this.syncEngine && this.handyManager?.connected) {
      this.syncEngine.player = proxyPlayer; this.syncEngine.start();
    }
    if (this.autoblowSync && this.autoblowManager?.connected) {
      this.autoblowSync.player = proxyPlayer; this.autoblowSync.start();
    }

    // Repoint Up Next onto the proxy so its countdown + auto-advance track
    // the POP-OUT's clock (the inline <video> is paused — it never reaches
    // the trailing zone). The card is streamed to the pop-out; the engine
    // fires onPlayNext → _playUpNext which re-routes the next video into it.
    if (this.upNextEngine) this.upNextEngine.player = proxyPlayer;

    this._playerWindowActive = true;
    // Main window goes back to where the player was opened from (the
    // library, or Playlists / Categories) so it stays browseable (deaf
    // #189). It always went to the library, so after a round trip Back from
    // the player landed there even when the user came from Playlists.
    // _onLeaveView leaves the window's playback alone (_playerWindowActive).
    if (this._currentView() === 'player') {
      if (this._navStack?.length > 1) this._navigateBack();
      else this._navigateTo('library');
    } else this._emitVideoSyncOffsetRowChanged?.();   // FT-017
  }

  /**
   * Fold playback back into the main window when the pop-out closes. Mirror
   * of the web-remote disconnect: stop engines, rebind to the local player,
   * resume the inline <video> at the pop-out's last position.
   */
  _deactivatePlayerWindow() {
    if (!this._playerWindowActive) return;
    const proxyMs = Math.round((this._playerWinProxy?.currentTime || 0) * 1000);
    // The window's own flag: a fold-back during a stall (N-01) was playing.
    const wasPlaying = !!(this._playerWinProxy
      && !(this._playerWinProxy.sourcePaused ?? this._playerWinProxy.paused));

    if (this.syncEngine?._active) this.syncEngine.stop();
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    if (this.handyManager?.connected) this.handyManager.hsspStop();

    const localPlayer = this.videoPlayer;
    if (this.buttplugSync) this.buttplugSync.player = localPlayer;
    if (this.tcodeSync) this.tcodeSync.player = localPlayer;
    if (this.syncEngine) this.syncEngine.player = localPlayer;
    if (this.autoblowSync) this.autoblowSync.player = localPlayer;
    // Rebind Up Next to the inline player and drop any card that was
    // streamed to the (now closed) pop-out; check() re-shows it inline if
    // the inline playhead is still in the trailing zone.
    if (this.upNextEngine) { this.upNextEngine.player = localPlayer; this.upNextEngine.hide(); }

    this._playerWinProxy?.reset();
    this._playerWindowActive = false;
    this._emitVideoSyncOffsetRowChanged?.();   // FT-017: a paused fold-back stays in the library
    // Hand the loop flag back: the take-over gave the pop-out the inline
    // loop (V17), so a loop turned on or off over there holds here too.
    const inlineVid = this.videoPlayer?.video;
    if (inlineVid && typeof this._popoutLoop === 'boolean' && inlineVid.loop !== this._popoutLoop) {
      inlineVid.loop = this._popoutLoop;
      this._refreshLoopVideoVisibility?.();
    }

    // Restart every CONNECTED engine against the local <video>, mirroring the
    // take-over in _activatePlayerWindow. This MUST run before vid.play() so
    // the Handy's 'playing'-driven re-anchor (hsspPlay) fires and the per-tick
    // engines pick up the resumed clock. The previous code restarted ONLY
    // Buttplug + T-Code, and only in vid.play()'s .then() — so the Handy
    // (syncEngine) and Autoblow were never restarted and their devices went
    // silent as soon as the pop-out closed.
    if (this.buttplugSync && this.buttplugManager?.connected) {
      this.buttplugSync.reloadActions();
      this.buttplugSync.start();
    }
    if (this.tcodeSync && this.tcodeManager?.connected) {
      this.tcodeSync.reloadActions();
      this.tcodeSync.start();
    }
    if (this.syncEngine && this.handyManager?.connected) this.syncEngine.start();
    if (this.autoblowSync && this.autoblowManager?.connected) this.autoblowSync.start();

    // Resume inline playback where the pop-out left off. The engines are now
    // active + bound to the local player, so the resulting 'playing' event
    // re-anchors the Handy and the per-tick engines follow immediately.
    const vid = this.videoPlayer?.video;
    if (vid && (vid.currentSrc || vid.src)) {
      try { vid.currentTime = proxyMs / 1000; } catch { /* ignore */ }
      if (wasPlaying) {
        this._navigateTo('player');
        vid.play().catch(() => { /* autoplay blocked — user resumes */ });
      }
    }
  }

  /**
   * The editor pop-out docked with the editor open: its Dock button, or its
   * window closed (E-07, also in v0.9.2). The docked editor lives in the
   * player view. With the player in its own window the main window shows the
   * Library and the inline <video> only holds the file, so the docked editor
   * was on screen nowhere, sat at the hidden copy's stale time, and showed
   * again only after the player window was closed by hand. Docking the
   * editor docks the player too: the player window closes, playback folds
   * back here where it was (playing or paused), and the player view opens
   * with the editor under the video.
   */
  _onEditorDocked() {
    if (!this.scriptEditor?.isOpen || !this._playerWindowActive) return;
    this._showPlayerAfterFoldBack = true;
    Promise.resolve(window.funsync?.playerPopoutClose?.()).catch((err) => {
      this._showPlayerAfterFoldBack = false;
      console.warn('[PlayerWindow] close for the editor dock failed:', err);
    });
  }

  /**
   * E, and the player's editor button: open or close the script editor
   * (E2-01, also in v0.9.2). The docked editor lives in the player view, and
   * with the player in its own window the main window shows the Library, so E
   * opened the editor out of sight there (the state E-07 fixed for Dock), and
   * E again only closed that hidden copy while an editor window stayed open.
   * While the player window owns playback the editor opens in ITS own window
   * instead, following the player's (D-01), and E closes that window; the
   * player window stays as it is. Its Dock still docks both (E-07).
   * Everywhere else this is the editor's own toggle.
   * @param {() => void} toggle the editor's own toggle
   */
  _toggleScriptEditor(toggle) {
    const ed = this.scriptEditor;
    if (!ed || !this._playerWindowActive) return toggle();
    if (ed._popoutOpen) {
      // Closed first, so the window's 'closed' finds no open editor to dock
      // (E-07 docks the player back only for an open one).
      ed.hide();
      Promise.resolve(window.funsync?.editorPopoutClose?.()).catch((err) => {
        console.warn('[Editor] closing the editor window failed:', err);
      });
      return;
    }
    // Opened here (or already open in the hidden player view): to its window.
    if (!ed.isOpen) ed.show();
    Promise.resolve(ed._togglePopoutWindow?.()).catch((err) => {
      console.warn('[Editor] opening the editor window failed:', err);
    });
  }

  async _togglePlayerWindow() {
    if (this._playerWindowOpen) {
      await window.funsync?.playerPopoutClose?.();
      return;
    }
    // Guard: only offer pop-out for local library videos driven by the local
    // player (not while VR / web-remote is the source).
    if (this._remoteActive || this.vrBridge?.connected) {
      showToast(t('player.popOutUnavailableRemote'), 'info', 3500);
      return;
    }
    if (!this._currentPopoutVideo()) {
      showToast(t('player.popOutUnavailableSrc'), 'info', 3500);
      return;
    }
    // Pause the inline video BEFORE the pop-out opens so we don't briefly
    // decode the same file in both windows (the startup-jitter cause).
    // Remember whether it was playing so the pop-out autoplays to match.
    const vid = this.videoPlayer?.video;
    this._popoutWasPlaying = !!(vid && !vid.paused);
    if (vid && !vid.paused) vid.pause();
    showToast(t('player.popOutOpening'), 'info', 2500);
    await window.funsync?.playerPopoutOpen?.();
  }

  _updatePlayerWindowButton() {
    const btn = document.getElementById('btn-popout-player');
    if (!btn) return;
    const labelText = this._playerWindowOpen ? t('player.popIn') : t('player.popOut');
    const span = btn.querySelector('span');
    if (span) span.textContent = labelText;
    btn.setAttribute('aria-label', labelText);
  }

  /** Expand the mini-player back to the full player view. */
  _expandMiniplayer() {
    if (!this._miniActive) return;
    // _onEnterView('player') clears the mini class + flag; navigating in
    // pushes 'player' back onto the stack so Back works again.
    this._navigateTo('player');
  }

  /** Close the mini-player: stop playback and hide the player entirely. */
  _closeMiniplayer() {
    this._clearMiniplayer();
    const el = this._getViewEl('player');
    if (el) el.hidden = true;
    this._teardownPlayback();
    this._emitVideoSyncOffsetRowChanged?.();   // FT-017: nothing plays here now
  }

  /** Remove mini-player styling/state (does NOT stop playback). */
  _clearMiniplayer() {
    if (!this._miniActive) return;
    this._miniActive = false;
    this._getViewEl('player')?.classList.remove('player-container--mini');
    this.upNextCard?.setMini(false); // back to the full card in the player view
  }

  // --- VR-as-flat playback (community ask: Monoinc 2026-05-17) ---
  //
  // Two responsibilities:
  //   1. On video load, look up the per-video flatten preference from
  //      `library.vrFlatten[path]` (value: 'left' | 'right' | null) AND
  //      the auto-detected stereo format from filename. If both are
  //      present, apply the corresponding CSS transform.
  //   2. Expose a cycle callback for the Shift+R keyboard shortcut and
  //      the kebab menu entry — cycles Off → Left → Right → Off, mirrors
  //      MPC-HC's Pan&Scan precedent.
  //
  // No-op on non-flattenable formats (fisheye / equirect / mkx) — the
  // CSS crop would still look distorted; v2 would need a WebGL shader
  // pass for those.

  _applyVRFlattenForCurrent() {
    if (!this.videoPlayer) return;
    const path = this._currentVideoPath;
    const name = this._currentVideoName;
    const detected = classifyStereoFormat(path || name || '');

    // Lazy migration: legacy `library.vrFlatten[path] = 'left'|'right'`
    // upgrades to the richer `library.vrFormat` shape on first read. We
    // keep the old key untouched indefinitely for downgrade safety.
    this._maybeMigrateVRFlattenEntry(path, detected);

    const entry = path
      ? (this.settings?.get?.('library.vrFormat') || {})[path] || null
      : null;

    // Cycle target — Shift+R cycles through this projection. Manual
    // entry's projection wins over filename detection; 'flat' means the
    // user explicitly flagged the file as not VR.
    // Both planar and Phase-2a spherical projections are supported here.
    const SUPPORTED = new Set([
      'sbs-half', 'sbs-full', 'tb-half', 'tb-full',
      'equirect-180', 'fisheye-180',
    ]);
    if (entry?.projection === 'flat') {
      this._currentStereoFormat = null;
    } else if (entry?.projection && SUPPORTED.has(entry.projection)) {
      this._currentStereoFormat = entry.projection;
    } else {
      this._currentStereoFormat = isFlattenableStereo(detected) ? detected : null;
    }

    // Apply the saved state. If no manual eye is set the user starts at
    // Off so Shift+R cycles to Left first (matches the existing UX).
    if (entry?.eye && this._currentStereoFormat) {
      const eye = entry.eye === 'right' ? 2 : 1;
      const zoom = Number.isFinite(entry.zoom) ? entry.zoom : 1;
      const fov = Number.isFinite(entry.fov) ? entry.fov : 90;
      const yaw = Number.isFinite(entry.yaw) ? entry.yaw : 0;
      const pitch = Number.isFinite(entry.pitch) ? entry.pitch : 0;
      const roll = Number.isFinite(entry.roll) ? entry.roll : 0;
      const viewZoom = Number.isFinite(entry.viewZoom) ? entry.viewZoom : 1;
      const panX = Number.isFinite(entry.panX) ? entry.panX : 0;
      const panY = Number.isFinite(entry.panY) ? entry.panY : 0;
      this.videoPlayer.setVRFlatten(this._currentStereoFormat, eye, {
        zoom, fov, yaw, pitch, viewZoom, panX, panY,
      });
      // Roll is independent of `setVRFlatten` (which handles projection
      // mount + planar zoom); pushed separately so it applies to the
      // spherical render path as soon as it's mounted.
      this.videoPlayer.updateVRProjection({ roll });
    } else {
      this.videoPlayer.setVRFlatten('off');
    }

    // Hint toast — checked once metadata loads so we can read the
    // aspect ratio. One-shot listener; cleared when the video element
    // is replaced.
    this._scheduleVRHintCheck(path, detected, entry);

    // Drag-to-pan + dblclick recenter — only meaningful while a
    // spherical projection is active.
    if (this.videoPlayer.isVRProjecting) {
      this._wireVRPanForCurrent(path);
    } else {
      this._unwireVRPan();
    }

    // Player overflow menu's "VR Format…" item — visible only for
    // videos detected (or manually flagged) as VR.
    this._refreshVRFormatMenuVisibility();
  }

  /**
   * Merge fields into the current video's vrFormat entry, persist, and
   * apply live. The single write path for the zoom gesture.
   *
   * Emits `vrFormat:changed` so an open VR Format panel tracks the gesture
   * rather than showing a stale slider — the panel writes through the same
   * entry, so the two stay one value.
   */
  _writeVRFormatFields(fields) {
    const path = this._currentVideoPath;
    if (!path || !fields) return;
    const map = { ...(this.settings?.get?.('library.vrFormat') || {}) };
    const next = { ...(map[path] || {}), ...fields, source: 'manual' };
    map[path] = next;
    this.settings?.set?.('library.vrFormat', map);
    eventBus.emit('vrFormat:changed', { path, entry: next });

    if (isSpherical(this._currentStereoFormat)) {
      this.videoPlayer.updateVRProjection({ fov: next.fov });
    } else {
      this.videoPlayer.setVRViewZoom(next.viewZoom, next.panX, next.panY);
    }
  }

  /** One notch of zoom. `direction` is +1 in, -1 out. */
  _stepVRZoom(direction) {
    if (!this._currentStereoFormat || !this._currentVideoPath) return;
    const entry = (this.settings?.get?.('library.vrFormat') || {})[this._currentVideoPath] || null;
    // Returns null at the limits, so holding the keys does not spam writes.
    this._writeVRFormatFields(applyZoomStep(entry, this._currentStereoFormat, direction));
  }

  /** Ctrl+0 — back to fit (planar) or 90° (spherical). */
  _resetVRZoom() {
    if (!this._currentStereoFormat || !this._currentVideoPath) return;
    this._writeVRFormatFields(resetZoomFields(this._currentStereoFormat));
  }

  /**
   * Ctrl+scroll and trackpad pinch on the video.
   *
   * These are the SAME browser event — a pinch arrives as `wheel` with
   * `ctrlKey: true` — so one handler serves both and there is no
   * trackpad-specific branch anywhere.
   *
   * `preventDefault` is not optional: without it Chromium's own page zoom
   * fires and rescales the entire UI. Nothing in this app pinned
   * `zoomFactor`, so that was already happening on any Ctrl+scroll.
   */
  _wireVRZoomGesture() {
    const wrap = document.getElementById('video-wrapper');
    if (!wrap || this._vrZoomWired) return;
    this._vrZoomWired = true;

    wrap.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;               // plain scroll keeps its meaning
      e.preventDefault();                    // ... and page zoom never fires
      if (!this._currentStereoFormat) return;
      this._stepVRZoom(wheelDirection(e.deltaY));
    }, { passive: false });

    // Drag-to-pan for PLANAR only. Spherical already has its own
    // drag-to-pan on the WebGL canvas (`_wireVRPanForCurrent`), which
    // moves the camera rather than the picture.
    let drag = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!this._currentStereoFormat || isSpherical(this._currentStereoFormat)) return;
      if ((this.videoPlayer.vrViewZoom || 1) <= 1) return;   // nothing hidden
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
      const box = wrap.getBoundingClientRect();
      const entry = (this.settings?.get?.('library.vrFormat') || {})[this._currentVideoPath] || null;
      this._writeVRFormatFields(applyPanDelta(entry, dx, dy, box.width, box.height));
    });
    const endDrag = (e) => {
      if (!drag) return;
      // Below the same 6px threshold the spherical pan uses, treat it as a
      // click so play/pause still works while zoomed in.
      const wasClick = drag.moved < 6;
      drag = null;
      if (wasClick) return;
      e.preventDefault();
      e.stopPropagation();
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', () => { drag = null; });
  }

  /**
   * Show / hide the "VR Format…" item in the player overflow menu
   * based on whether the current video is VR. Uses `isVRVideo` which
   * already layers vrFormat → manualVRType → filename heuristic, so
   * this is the single source of truth for "is this a VR video?".
   */
  _refreshVRFormatMenuVisibility() {
    const item = document.getElementById('btn-vr-format-menu');
    if (!item) return;
    const path = this._currentVideoPath;
    // `isVRVideo` is a FILENAME heuristic. The "Looks like VR" toast is not —
    // it fires off the decoded video's own aspect ratio. So a file whose name
    // carries no VR token but whose picture is 2:1 got told it looked like VR
    // and then found no VR Format item in the menu and no response to Shift+R
    // (terijapl, EroScripts #318: `CuddleMocap 038c - ... - 3D (6K-90 75M).mp4`).
    //
    // Offering the panel is not the same claim as detecting a format: the
    // panel is where you SET the format by hand, which is exactly what
    // someone whose file we failed to classify needs. So the measured aspect
    // is enough to show the item, even though it is deliberately not enough
    // to auto-apply a packing (see classifyStereoFormat — a false "this 32:9
    // film is full-SBS" would corrupt ultrawide content).
    const isVR = path ? isVRVideo({ path }) : false;
    item.hidden = !(isVR || this._videoAspectLooksVR());
  }

  /**
   * Does the DECODED video look like VR by its aspect ratio? Same threshold
   * as the hint toast (2:1 and wider), read from the element rather than the
   * filename, plus a square frame: over-under packs two 2:1 eyes into 1:1
   * (1440x1440, 4096x4096), and those files got no VR Format item at all
   * (FT-077, #377; also in v0.9.2). This only OFFERS the panel, where the
   * format is set by hand; nothing is applied from it (a square frame is
   * also an ordinary square video). The hint toast keeps its 2:1 rule.
   */
  _videoAspectLooksVR() {
    const v = this.videoPlayer?.video;
    const w = v?.videoWidth || 0;
    const h = v?.videoHeight || 0;
    if (!w || !h) return false;
    const aspect = w / h;
    return aspect >= 1.9 || Math.abs(aspect - 1) <= 0.02;
  }

  /**
   * Attach pointer + dblclick handlers to the WebGL canvas so the user
   * can drag-to-pan and double-click to recenter. Click-vs-drag
   * disambiguation uses a 6px movement threshold; below that, the
   * click is forwarded to videoPlayer.togglePlay (matching the video
   * element's existing click-to-pause behaviour).
   */
  _wireVRPanForCurrent(path) {
    const canvas = this.videoPlayer.vrProjectionCanvas;
    if (!canvas) return;
    // Idempotent — if we already wired the same canvas, don't double-bind.
    if (this._vrPanState?.canvas === canvas) return;
    this._unwireVRPan();

    const state = {
      canvas,
      path,
      dragging: false,
      startX: 0, startY: 0,
      startYaw: 0, startPitch: 0,
      totalMovement: 0,
      yaw: 0, pitch: 0,
    };
    this._vrPanState = state;

    // Read initial yaw/pitch from the current entry so the gesture
    // accumulates from where the user left off.
    const entry = (this.settings?.get?.('library.vrFormat') || {})[path] || {};
    state.yaw = Number.isFinite(entry.yaw) ? entry.yaw : 0;
    state.pitch = Number.isFinite(entry.pitch) ? entry.pitch : 0;

    const onDown = (e) => {
      if (e.button !== 0) return;
      state.dragging = true;
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.startYaw = state.yaw;
      state.startPitch = state.pitch;
      state.totalMovement = 0;
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e) => {
      if (!state.dragging) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      state.totalMovement = Math.max(state.totalMovement, Math.hypot(dx, dy));
      // 1 pixel of drag = ~0.2° pan — feels natural at default FOV
      // and matches DeoVR convention. Pitch is inverted: drag down →
      // pitch up (looking up).
      state.yaw = state.startYaw - dx * 0.2;
      state.pitch = state.startPitch + dy * 0.2;
      // Clamp pitch to ±85° (renderer also clamps; this keeps the
      // accumulated drag from running away).
      state.pitch = Math.max(-85, Math.min(85, state.pitch));
      this.videoPlayer.updateVRProjection({ yaw: state.yaw, pitch: state.pitch });
      // Keep controls visible while the user is actively dragging.
      this.videoPlayer._showControls?.();
    };

    const onUp = (e) => {
      if (!state.dragging) return;
      state.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* swallow */ }
      // Click vs drag — below threshold, forward to video toggle.
      if (state.totalMovement < 6) {
        this.videoPlayer.togglePlay();
        return;
      }
      this._persistVRPan(state.path, state.yaw, state.pitch);
    };

    const onDblClick = () => {
      state.yaw = 0;
      state.pitch = 0;
      this.videoPlayer.updateVRProjection({ yaw: 0, pitch: 0 });
      this._persistVRPan(state.path, 0, 0);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('dblclick', onDblClick);

    state._teardown = () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }

  _unwireVRPan() {
    if (!this._vrPanState) return;
    try { this._vrPanState._teardown?.(); } catch { /* swallow */ }
    this._vrPanState = null;
  }

  /** Step yaw/pitch by a delta — called by keyboard Shift+Arrow. */
  _stepVRPan(yawDelta, pitchDelta) {
    if (!this.videoPlayer.isVRProjecting || !this._vrPanState) return;
    const s = this._vrPanState;
    s.yaw += yawDelta;
    s.pitch = Math.max(-85, Math.min(85, s.pitch + pitchDelta));
    this.videoPlayer.updateVRProjection({ yaw: s.yaw, pitch: s.pitch });
    this._persistVRPan(s.path, s.yaw, s.pitch);
  }

  _persistVRPan(path, yaw, pitch) {
    if (!path || !this.settings) return;
    const map = { ...(this.settings.get('library.vrFormat') || {}) };
    const existing = map[path];
    if (!existing || existing.projection === 'flat') return;
    map[path] = { ...existing, yaw, pitch, source: 'manual' };
    this.settings.set('library.vrFormat', map);
  }

  /**
   * Lazily upgrade legacy `library.vrFlatten[path] = 'left'|'right'`
   * entries into the richer `library.vrFormat` schema. Old key is left
   * in place so a user reverting to <0.7.x still sees their preference.
   */
  _maybeMigrateVRFlattenEntry(path, detected) {
    if (!path || !this.settings) return;
    const formatMap = this.settings.get('library.vrFormat') || {};
    if (formatMap[path]) return;
    const old = (this.settings.get('library.vrFlatten') || {})[path];
    if (old !== 'left' && old !== 'right') return;
    const projection = isFlattenableStereo(detected) ? detected : 'sbs-half';
    const next = { ...formatMap, [path]: {
      projection,
      eye: old,
      zoom: 1,
      source: 'auto',
    } };
    this.settings.set('library.vrFormat', next);
  }

  /**
   * Schedule the first-time hint toast. Fires once per session per path,
   * only when no override exists, detection failed, and the video
   * aspect-ratio suggests VR (≥1.9:1 mono or ≥3.5:1 SBS).
   */
  _scheduleVRHintCheck(path, detected, entry) {
    if (!this.videoPlayer?.video || !path) return;
    if (entry || detected) return;
    this._vrHintShown = this._vrHintShown || new Set();
    if (this._vrHintShown.has(path)) return;
    const video = this.videoPlayer.video;
    const check = () => {
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      if (!w || !h) return;
      const aspect = w / h;
      const looksVR = aspect >= 3.5 || aspect >= 1.9;
      if (!looksVR) return;
      this._vrHintShown.add(path);
      showToast(t('toast.vrLooksLikeVR'), 'info', 6000);
      // The menu item's visibility now depends on this same measurement, and
      // dimensions are not known when the earlier refresh ran at load time.
      // Without this the toast appears and the menu it points at does not
      // (terijapl #318).
      this._refreshVRFormatMenuVisibility();
    };
    if (video.readyState >= 1) {
      check();
    } else {
      const once = () => {
        video.removeEventListener('loadedmetadata', once);
        check();
      };
      video.addEventListener('loadedmetadata', once);
    }
  }

  /**
   * Cycle the VR-flatten state for the current video and persist the new
   * setting. Called by the keyboard (Shift+R). Writes to the new
   * `library.vrFormat` schema; the old `library.vrFlatten` key is no
   * longer touched (kept indefinitely as a downgrade fallback).
   */
  /**
   * After the manual "Re-sync time" button completes its SDK sync,
   * re-engage HSSP playback at the current video position. Without
   * this, the SDK's `.sync()` routine can leave the device in a state
   * where subsequent hsspStop / setScript calls silently fail — the
   * app then thinks it's controlling playback but pause / next-video
   * never reach the device.
   *
   * Mirrors the auto-drift recovery in sync-engine.js: if video is
   * playing, stop + replay HSSP at current time. If paused, leave
   * device alone (HSSP is already stopped via the pause handler).
   *
   * Community-reported 2026-06-01.
   */
  async _restoreHssspAfterResync() {
    if (!this.handyManager?.connected) return;
    const video = this.videoPlayer?.video;
    if (!video) return;
    if (video.paused) return;  // already stopped, nothing to restore
    // Paused, or held on a stall (N-01): the device should stand, and the
    // engine's re-anchor on 'playing' is the play half, at the time the
    // picture really moves again.
    const shouldStand = () => !!video.paused || !!this.syncEngine?.holding;
    try {
      await this.handyManager.hsspStop();
      // A pause that came in while that stop travelled queued its own stop
      // behind it; a play now would land after both and run the device
      // under a paused picture (fix-up review 2026-11-16; also in v0.9.2).
      if (shouldStand()) return;
      // The position NOW, not before the stop: it can take seconds.
      const timeMs = Math.round(video.currentTime * 1000);
      await this.handyManager.hsspPlay(timeMs);
      // A stop always wins over a late play: a pause or a hold that began
      // while this play travelled has sent a stop it may have overtaken.
      if (shouldStand()) {
        console.log('[Resync] paused or held while the restore play travelled — re-sending stop');
        await this.handyManager.hsspStop();
      }
    } catch (err) {
      console.warn('[Resync] HSSP restore failed:', err?.message || err);
    }
  }

  // ============ Audience broadcast (SCOPE-audience-broadcast.md) ============

  /**
   * Wire the audience pop-out IPC relay. Pop-out renderer sends ops via
   * `audiencePopoutRelay('to-parent', ...)`; we receive them here and
   * dispatch to AudienceBridge. AudienceBridge events fan back out via
   * `audiencePopoutRelay('to-popout', ...)` so the pop-out re-renders.
   */
  _wireAudiencePopoutRelay() {
    if (!window.funsync?.onAudiencePopoutEvent) return;

    // Pop-out → main
    window.funsync.onAudiencePopoutEvent(async (evt) => {
      if (!evt) return;
      // Closing the pop-out window ends the room automatically. The
      // SCOPE originally kept room state alive across pop-out close
      // (Shneiderman #6 reversibility), but Dave reversed that 2026-06-02
      // — explicit "End Room" + confirm was high-friction; closing the
      // window IS the end-room intent. The Audience tab's End Room
      // button now just calls audiencePopoutClose() so both paths
      // funnel through here.
      if (evt.type === 'closed') {
        console.log('[Audience] pop-out window closed');
        if (this.audienceBridge?.roomActive) {
          await this.audienceBridge.endRoom();
        }
        return;
      }
      if (evt.type !== 'message') return;
      const payload = evt.payload;
      // Log the op TYPE only — payloads carry viewer keys (passwords) and
      // must never hit the log file.
      if (payload?.type) console.debug(`[Audience] pop-out → ${payload.type}`);
      switch (payload?.type) {
        case AUDIENCE.READY: {
          // Pop-out is up; push initial state.
          this._pushAudienceInitialState();
          break;
        }
        case AUDIENCE.ADD_VIEWER: {
          try {
            await this.audienceBridge.addViewer({
              key: payload.key,
              label: payload.label,
              offsetMs: payload.offsetMs,
            });
          } catch (err) {
            // SELF_KEY collision or generic add failure — surface to the
            // pop-out as a toast-style status; the bridge already
            // refused the add, so no state change is needed.
            const msg = err?.code === 'SELF_KEY' ? t('audience.toast.selfKey')
                      : err?.message || String(err);
            showToast(msg, 'warn', 3500);
          }
          break;
        }
        case AUDIENCE.REMOVE_VIEWER:
          await this.audienceBridge.removeViewer(payload.key, { forget: !!payload.forget });
          break;
        case AUDIENCE.SET_OFFSET:
          this.audienceBridge.setOffsetForViewer(payload.key, payload.offsetMs);
          break;
        case AUDIENCE.SET_MUTED:
          await this.audienceBridge.setMuted(payload.key, payload.muted);
          break;
        // The flash goes with the pulse (FT-119): a buzz the bridge refuses
        // (the viewer plays, is muted, not connected) flashes nothing.
        case AUDIENCE.TEST_BUZZ:
          await this.audienceBridge.testBuzz(payload.key, { onPulse: () => this._flashScreenForBuzzCalibration() });
          break;
        case AUDIENCE.TEST_BUZZ_ALL:
          await this.audienceBridge.testBuzzAll({ onPulse: () => this._flashScreenForBuzzCalibration() });
          break;
        case AUDIENCE.RESEND:
          // FT-121: connect again if it dropped, then send the current script.
          await this.audienceBridge.resend(payload.key);
          break;
        case AUDIENCE.SET_HIDE_KEYS:
          this.settings?.set?.('audience.hideKeys', !!payload.hideKeys);
          this._pushAudienceMessage(AUDIENCE.HIDE_KEYS_CHANGED, { hideKeys: !!payload.hideKeys });
          break;
        case AUDIENCE.END_ROOM:
          // Single funnel: closing the pop-out triggers the 'closed'
          // event above which calls endRoom. The End Room button in
          // the pop-out or the tab just closes the window.
          await window.funsync.audiencePopoutClose?.();
          break;
      }
    });

    // Bridge → pop-out fan-out
    eventBus.on('audience:viewer-added', ({ key }) => {
      const viewer = this.audienceBridge.viewers.find((v) => v.key === key);
      if (viewer) this._pushAudienceMessage(AUDIENCE.VIEWER_ADDED, { viewer });
    });
    eventBus.on('audience:viewer-removed', ({ key }) => {
      this._pushAudienceMessage(AUDIENCE.VIEWER_REMOVED, { key });
    });
    eventBus.on('audience:viewer-status', (payload) => {
      this._pushAudienceMessage(AUDIENCE.VIEWER_STATUS, payload);
    });
    eventBus.on('audience:viewer-offset', (payload) => {
      this._pushAudienceMessage(AUDIENCE.VIEWER_OFFSET, payload);
    });
    // The pop-out has its own i18n state and takes its locale only from
    // INITIAL_STATE, so a live switch left it in the old language until it
    // was reopened (app test V50). The snapshot is the whole state, so
    // sending it again just re-renders it; main drops it if the window is
    // closed. The event's locale, not the setting: the first-launch prompt
    // saves the setting after setLocale resolves.
    eventBus.on('language:changed', ({ locale } = {}) => {
      if (this.audienceBridge) this._pushAudienceInitialState(locale);
    });
  }

  _pushAudienceMessage(type, fields = {}) {
    window.funsync?.audiencePopoutRelay?.('to-popout', { type, ...fields });
  }

  _pushAudienceInitialState(locale = null) {
    this._pushAudienceMessage(AUDIENCE.INITIAL_STATE, {
      roomActive: this.audienceBridge.roomActive,
      viewers: this.audienceBridge.viewers,
      // Hidden unless the streamer chose to show the keys (store.js
      // default, Dave 2026-11-19): absent reads as hidden here too.
      hideKeys: this.settings?.get?.('audience.hideKeys') !== false,
      theme: document.documentElement.dataset.theme || 'dark',
      uiStyle: document.documentElement.dataset.style || 'classic',
      // Pop-out renderer has its own module-level i18n state. Pass the
      // streamer's chosen locale so the pop-out shows translated UI
      // instead of raw key constants like "audience.room.empty".
      locale: locale || this.settings?.get?.('player.language') || 'en',
    });
  }

  /**
   * Flash the screen white for ~80ms for the buzz-calibration ping
   * (SCOPE §3.4). Viewer sees the flash via Discord screen-share + feels
   * the device pulse a tick later — reports felt-vs-saw delta back in
   * Discord chat so the streamer can dial the per-viewer offset.
   */
  _flashScreenForBuzzCalibration() {
    let overlay = document.getElementById('audience-buzz-flash');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'audience-buzz-flash';
      overlay.className = 'audience-buzz-flash';
      document.body.appendChild(overlay);
    }
    overlay.classList.add('audience-buzz-flash--active');
    setTimeout(() => overlay.classList.remove('audience-buzz-flash--active'), 80);
  }

  /**
   * Whether audience viewers may follow playback right now: the LOCAL
   * <video> is the active player and is playing. While VR, the phone or the
   * player pop-out drives playback the inline element is not the clock, so
   * viewers stay stopped there (#361 stopgap; following those players is
   * phase 2, research §4.7). A source VR or the phone loaded is never played
   * at all (the bridge's SOURCE_PLAYER), and ends with its session.
   */
  _audienceLocalPlayerPlaying() {
    const video = this.videoPlayer?.video;
    if (!video || video.paused || video.ended) return false;
    return !this._remoteActive && !this._playerWindowActive && !this._vrPlayerRef;
  }

  /**
   * The script audience viewers are sent for `rawContent` (Dave, D1
   * 2026-11-04): the active script plus the gap filler when it is on — a
   * content choice. NOT the streamer's device preferences: Range Extender,
   * Handy output limits and Handy invert stay out, unlike
   * `_handyUploadContent`. Viewers' range and speed are their own (SCOPE
   * O-6). Callers hand the bridge `() => this._audienceScriptContent(raw)`:
   * it runs only once a viewer needs the script.
   */
  _audienceScriptContent(rawContent) {
    if (typeof rawContent !== 'string' || !rawContent) return null;
    return fillRawScriptContent(stripBOM(rawContent), this._fillerOptionsForUpload());
  }

  /**
   * Editor saves reach audience viewers (FT-094; also in v0.9.2). A save
   * reloaded the edit into the engine and re-uploaded it to the streamer's
   * own Handy only (`onReuploadHandy`), so viewers played the pre-edit
   * script of the same video until the next video or variant.
   */
  _wireAudienceEditorSaves() {
    eventBus.on('funscript:saved', (payload) => this._onEditorSavedForAudience(payload));
  }

  /**
   * `funscript:saved` from the editor (Ctrl+S, Save As, autosave). When the
   * file is this window's video's playing main script, viewers get the
   * edited script as a new LOCAL source once saves go quiet
   * (AUDIENCE_EDIT_RESEND_MS): stop, set up the edit, play if this window
   * plays. A companion file, a save while the phone or a headset drives, or
   * a load, a variant or a session that began its own source meanwhile
   * sends nothing. The content is the engine's at that moment: the save put
   * the edit there (`_reloadIntoEngineAndSync`), and it is what the
   * streamer's own devices play. Nothing is read or written.
   */
  _onEditorSavedForAudience({ path } = {}) {
    if (!this.audienceBridge || !this._isLocalMainScriptPath(path)) return;
    const gen = this._videoLoadGen;
    const sourceGen = this.audienceBridge.source?.gen;
    clearTimeout(this._audienceEditResendTimer);
    this._audienceEditResendTimer = setTimeout(() => {
      this._audienceEditResendTimer = null;
      if (this._videoLoadGen !== gen || this.audienceBridge?.source?.gen !== sourceGen) return;
      if (!this._isLocalMainScriptPath(path)) return;
      const raw = this.funscriptEngine?.getRawContent?.() || null;
      if (!raw) return;
      // A save with nothing edited (Ctrl+S on an unchanged script) is the
      // script viewers already have: no stop, set-up and replay, a 1-3 s gap
      // on each viewer's device for nothing (verify-2 / review, 2026-11-07).
      if (this.audienceBridge.sourceCarries?.(() => this._audienceScriptContent(raw))) return;
      const title = path.split(/[\\/]/).pop();
      const token = this.audienceBridge.beginSource({ title, player: SOURCE_PLAYER.LOCAL });
      this.audienceBridge.setScript(token, { content: () => this._audienceScriptContent(raw), title });
    }, AUDIENCE_EDIT_RESEND_MS);
  }

  /**
   * Is `path` the main script this window's own video plays right now (not
   * a companion, not the phone's or a headset's)? For a script with no file
   * of its own, loadFunscript points the editor at `<video>.funscript`.
   */
  _isLocalMainScriptPath(path) {
    if (typeof path !== 'string' || !path) return false;
    if (this._engineHeldByRemote === true || this._remoteActive || this._vrPlayerRef) return false;
    if (this.audienceBridge?.source?.player !== SOURCE_PLAYER.LOCAL) return false;
    if (!this._currentVideoPath || !this.funscriptEngine?.isLoaded) return false;
    const own = this._currentFunscriptPath && this._currentFunscriptPath !== this._currentVideoPath
      ? this._currentFunscriptPath
      : this._currentVideoPath.replace(/\.[^/.]+$/, '') + '.funscript';
    return canonicalPath(path) === canonicalPath(own);
  }

  /**
   * Seek to the previous / next chapter relative to the current time.
   * No wrap-around per SCOPE-chapters-bookmarks.md C-E23 — at the last
   * chapter, "next" is a no-op (stays put). Editor-focus guard happens
   * upstream in keyboard.js; this method just does the math + seek.
   *
   * @param {number} direction — -1 (prev) or +1 (next)
   */
  _jumpChapter(direction) {
    // The script's chapters and the linked Stash scene's markers (Stash S1):
    // every chapter the seek bar shows.
    const chapters = chapterStarts(this.funscriptEngine?.getChapters?.() || [], this._stashMarkerList || []);
    if (chapters.length === 0) return;
    if (!this.videoPlayer?.video) return;
    const currentMs = (this.videoPlayer.video.currentTime || 0) * 1000;

    let target = null;
    if (direction < 0) {
      // Previous chapter: the latest start that is strictly before the
      // current time. The 0.5s window prevents the "next" pressed and
      // then "prev" pressed immediately from landing back at the same
      // chapter you came from.
      const PREV_THRESHOLD_MS = 500;
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (chapters[i].startMs < currentMs - PREV_THRESHOLD_MS) {
          target = chapters[i];
          break;
        }
      }
      // Falling off the start: seek to 0 instead of doing nothing —
      // matches YouTube's behaviour.
      if (!target) {
        this.videoPlayer.video.currentTime = 0;
        return;
      }
    } else {
      for (const c of chapters) {
        if (c.startMs > currentMs) {
          target = c;
          break;
        }
      }
      if (!target) return;  // no wrap — stay put
    }
    this.videoPlayer.video.currentTime = target.startMs / 1000;
  }

  /**
   * Seek to the previous / next bookmark relative to the current time.
   * Same semantics as _jumpChapter (no wrap). Editor's Shift+B / Ctrl+B
   * continues to use its own EditableScript bookmark list when the
   * editor is open; this method only fires from the player surface.
   *
   * @param {number} direction — -1 (prev) or +1 (next)
   */
  _jumpBookmark(direction) {
    const bookmarks = this.funscriptEngine?.getBookmarks?.() || [];
    if (bookmarks.length === 0) return;
    if (!this.videoPlayer?.video) return;
    const currentMs = (this.videoPlayer.video.currentTime || 0) * 1000;

    let target = null;
    if (direction < 0) {
      const PREV_THRESHOLD_MS = 500;
      for (let i = bookmarks.length - 1; i >= 0; i--) {
        if (bookmarks[i].at < currentMs - PREV_THRESHOLD_MS) {
          target = bookmarks[i];
          break;
        }
      }
    } else {
      for (const b of bookmarks) {
        if (b.at > currentMs) {
          target = b;
          break;
        }
      }
    }
    if (!target) return;
    this.videoPlayer.video.currentTime = target.at / 1000;
  }

  _cycleVRFlatten() {
    if (!this.videoPlayer) return null;
    if (!this._currentStereoFormat) {
      // No packing known (Shift+R reads the saved format or the name only).
      // A picture whose shape says VR is pointed at the panel where the
      // format is set, instead of being told there is no VR (FT-077, #377).
      // Never a guessed packing, and nothing is saved.
      if (this._videoAspectLooksVR()) showToast(t('toast.vrSetFormatInMenu'), 'info', 5000);
      else showToast(t('toast.noVRDetected'), 'info');
      return null;
    }
    const label = this.videoPlayer.cycleVRFlatten(this._currentStereoFormat);
    const path = this._currentVideoPath;
    if (path && this.settings) {
      const map = { ...(this.settings.get('library.vrFormat') || {}) };
      const next = this.videoPlayer.vrFlattenState;
      if (!next.format) {
        delete map[path];
      } else {
        const existing = map[path] || {};
        map[path] = {
          projection: this._currentStereoFormat,
          eye: next.eye === 2 ? 'right' : 'left',
          zoom: Number.isFinite(existing.zoom) ? existing.zoom : 1,
          source: existing.source || 'auto',
        };
      }
      this.settings.set('library.vrFormat', map);
    }
    return label;
  }

  /**
   * Open the VR Format panel for the given video path. Lazy-imports the
   * component to keep startup tree small. Re-applies the rendered state
   * on every change so the user sees the effect live.
   */
  async _openVRFormatPanel(path) {
    if (!path) {
      showToast(t('toast.noVideoLoaded'), 'info');
      return;
    }
    const { openVRFormatPanel } = await import('../components/vr-format-panel.js');
    await openVRFormatPanel({
      path,
      dataService: this.settings,
      enumerateFolderVideos: (dir) => window.funsync.enumerateFolderVideos(dir),
      onApply: (affectedPath, _entry) => {
        // Re-apply the current video's state so the user sees the new
        // projection / eye / zoom take effect immediately. Affected
        // path can be null for bulk apply-to-folder writes; in that
        // case we always re-apply (it might be the current video).
        if (affectedPath === null || affectedPath === this._currentVideoPath) {
          this._applyVRFlattenForCurrent();
        }
      },
    });
  }

  // --- View Actions ---

  _showLibrary() {
    this._navigateTo('library');
  }

  /**
   * Asked first by every route that replaces the script in the editor (CB-01,
   * also in v0.9.2: with autosave off they dropped unsaved edits silently).
   * `true` at once, synchronously, when nothing is unsaved, so a clean editor
   * changes no caller's timing; otherwise the editor's Save / Don't save /
   * Cancel question (a Promise), and the caller goes on only when it resolves
   * true. The routes are listed on ScriptEditor.confirmBeforeReplace. The
   * phone and VR never touch the editor otherwise (they load their own script
   * into the engine only). Closing, quitting, reloading, installing an update
   * and Import / Restore's relaunch ask through main instead
   * (`_answerUnsavedBeforeExit`, R3-19).
   * @returns {true|Promise<boolean>}
   */
  _editorAllowsReplace() {
    // Is a question already open? Then this call asks nothing: the editor
    // answers it `false` at once ("one question at a time"), and the route
    // whose question IS open decides (R3-11). Read before the call, which
    // opens this route's own question synchronously when there is none.
    const othersQuestion = !!this.scriptEditor?._unsavedPrompt;
    const ok = this.scriptEditor?.confirmBeforeReplace?.() ?? true;
    if (ok === true || !this._autoAdvancing || othersQuestion) return ok;
    // An Up Next (or ended) advance asked. Its advance is one-shot per video,
    // so Cancel left Up Next dead for this video. Cancel means "not now": the
    // card comes back on the next end (round 2). Only the advance whose own
    // question was answered Cancel re-arms: a second route at the same end
    // (the queue's `ended`, while Up Next's question is open) used to re-arm
    // the engine with that question still up (R3-11).
    return Promise.resolve(ok).then((go) => {
      if (!go) this.upNextEngine?.rearm?.();
      return go;
    });
  }

  /**
   * A click route (library, playlist, category, Up Next, prev / next) reads
   * the video's script BEFORE `_playFromLibrary` asks about unsaved edits.
   * When that is the file the editor was on (the same video opened again),
   * a Save has just rewritten it, and the early copy put the old points back
   * into the editor, clean and under the same path, and into the engine: the
   * next save wrote them over the edits the user had chosen to keep (CB-01
   * review). So that file is read again after the answer. Any other script,
   * or a failed read, goes on as the route read it.
   */
  async _rereadAfterEditorAnswer(funscriptData, editedPath) {
    const from = funscriptData?.textContent != null
      ? (funscriptData._funscriptPath || funscriptData.path || null)
      : null;
    const key = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    const same = (a, b) => key(a) === key(b);
    if (!from || !editedPath || !same(from, editedPath)) return funscriptData;
    try {
      const content = await window.funsync.readFunscript(from);
      if (content) return { ...funscriptData, textContent: content };
    } catch (err) {
      console.warn('[Editor] re-reading the saved script failed:', err?.message || err);
    }
    return funscriptData;
  }

  /**
   * A funscript picked with Browse / O was read by main the moment the
   * dialog returned, and a dropped one is a File whose bytes date from the
   * drop: both BEFORE the unsaved-changes question. When it is the script
   * the editor was on, a Save has just rewritten that file, and the early
   * copy put the old points back into the editor (clean, same path) and into
   * the engine; the next save wrote them over the edits (round 2: 38 points
   * on disk, 33 handed to the load). So after an answer the file is read
   * again from its path, whichever script it is. No path, or a failed read:
   * the copy the route already had.
   */
  async _readFunscriptFileAgain(file) {
    const path = file?.path || null;
    if (!path) return file;
    try {
      const content = await window.funsync.readFunscript(path);
      if (content) return { name: file.name, textContent: content, path };
    } catch (err) {
      console.warn('[Editor] re-reading the picked script failed:', err?.message || err);
    }
    return file;
  }

  /**
   * The EroScripts panel asks this BEFORE a download writes anything (round
   * 2). With a video open the download replaces the script in the editor and
   * is usually written to the editor's own <video>.funscript: the question
   * used to come after that write, so Save put the edits over the download
   * and the editor loaded the copy read before the answer.
   * @returns {true|Promise<boolean>}
   */
  /**
   * Is a video open where the user can see it: the player view, the docked
   * mini player, or the detached player window (C-05)? After the mini
   * player's ×, or Back with the mini player off, the video is only paused
   * (teardownPlayback): it stays loaded, and `_currentVideoName` and
   * `#player-container[data-video-path]` still name it, so they cannot say
   * whether it is closed. The same surfaces the playback keys follow
   * (`hasOffViewPlayer`, CB-05).
   */
  _hasOpenVideo() {
    if (!this._currentVideoName) return false;
    return this._currentView() === 'player' || !!this._miniActive || !!this._playerWindowActive;
  }

  /**
   * The nav bar's EroScripts button. With an open video that has no script
   * the panel opens searching for it. Only an OPEN one (`_hasOpenVideo`):
   * after the mini player's ×, the panel still searched for the closed
   * video, whose name `_currentVideoName` keeps (block C verifier 1; also
   * in v0.9.2; C-05 fixed where a download goes, not this).
   */
  _onEroScriptsNavClick() {
    if (!this.eroscriptsPanel) return;
    if (this._hasOpenVideo() && !this.funscriptEngine.isLoaded && !this.eroscriptsPanel._visible) {
      const query = this._currentVideoName.replace(/\.[^/.]+$/, '');
      this.eroscriptsPanel.setSearchQuery(query, true);
    }
    this.eroscriptsPanel.toggle();
  }

  /**
   * The EroScripts panel's target video (C-05): the open video's path, null
   * once it is closed. Closed, a download used to be written as
   * `<that video>.funscript` beside it and loaded into it; now it takes the
   * Save dialog route (or the only source's root), as with no video.
   */
  _openVideoPath() {
    if (!this._hasOpenVideo()) return null;
    return document.getElementById('player-container')?.dataset?.videoPath || null;
  }

  _confirmBeforeEroScriptsDownload() {
    // A closed video's script is not replaced: nothing to ask (C-05).
    if (!(this._hasOpenVideo() && this.funscriptEngine)) return true;
    return this._editorAllowsReplace();
  }

  /**
   * A download landed. With a video open it is loaded, and the file is read
   * only now, after any answer: the question was asked before the download
   * (above), so this one is instant unless the user edited again meanwhile.
   */
  async _onEroScriptDownloaded(fsPath, fsName) {
    // A video that was closed gets neither the association nor the script:
    // the file went where the user picked (C-05).
    if (!this._hasOpenVideo()) return;
    // Persist as a library association so the badge sticks when the user
    // returns to the library. No-op if the current video isn't a library
    // entry (e.g. drag-dropped from outside a scanned source).
    if (this._currentVideoPath && this.library) {
      this.library.associateDownloadedScript(this._currentVideoPath, fsPath);
    }
    if (!(this._currentVideoName && this.funscriptEngine)) return;
    try {
      const editorOk = this._editorAllowsReplace();
      if (editorOk !== true && !(await editorOk)) return;
      const content = await window.funsync.readFunscript(fsPath);
      if (content) {
        await this.loadFunscript({ name: fsName, textContent: content, path: fsPath });
      } else {
        showToast(t('toast.downloadedButUnreadable', { name: fsName }), 'warn', 6000);
      }
    } catch (err) {
      showToast(t('toast.downloadAutoLoadFailed', { error: err.message }), 'error', 5000);
    }
  }

  /**
   * Associate Funscript's EroScripts search (library.js) asks this after its
   * "Replace?" and before it writes anything (R4-07, new since v0.9.2: it
   * asked nothing, so Replace binned the old <video>.funscript and wrote the
   * download while the editor kept its edits under that path and the engine
   * the old script, and the next Ctrl+S wrote the edits over the download).
   * Asked when the editor holds one of the files the set writes, or when the
   * set is for the open video, whose new script the editor then loads.
   * @returns {true|Promise<boolean>}
   */
  _confirmBeforeAssociateDownload(videoPath, savePaths) {
    if (!(this._currentVideoName && this.funscriptEngine)) return true;
    const key = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const editorPath = this.scriptEditor?._funscriptPath || null;
    const forOpen = !!videoPath && !!this._currentVideoPath && key(videoPath) === key(this._currentVideoPath);
    const holdsOne = !!editorPath && (savePaths || []).some((p) => key(p) === key(editorPath));
    if (!forOpen && !holdsOne) return true;
    return this._editorAllowsReplace();
  }

  /**
   * Associate's EroScripts search wrote (R4-07): for the open video, its new
   * main script loads into the engine and the editor, as a panel download for
   * the open video does; a file the engine or the editor holds that it wrote
   * over loads again. Asked again first, which is instant unless the user
   * edited meanwhile.
   */
  async _onAssociateDownloadWritten(videoPath, { mainPath = null, written = [] } = {}) {
    if (!(this._currentVideoName && this.funscriptEngine)) return;
    const key = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const forOpen = !!videoPath && !!this._currentVideoPath && key(videoPath) === key(this._currentVideoPath);
    const held = [this.scriptEditor?._funscriptPath, this._currentFunscriptPath].filter(Boolean);
    const rewrote = held.find((p) => (written || []).some((w) => key(w) === key(p)));
    const path = forOpen ? mainPath : rewrote;
    if (!path) return;
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true && !(await editorOk)) return;
    const name = String(path).split(/[\\/]/).pop();
    try {
      const content = await window.funsync.readFunscript(path);
      if (content) await this.loadFunscript({ name, textContent: content, path });
      else showToast(t('toast.downloadedButUnreadable', { name }), 'warn', 6000);
    } catch (err) {
      showToast(t('toast.downloadAutoLoadFailed', { error: err.message }), 'error', 5000);
    }
  }

  async _playFromLibrary(videoData, funscriptData, subtitleData, variants) {
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true) {
      // The flags an advance holds only until this call returns (Up Next's
      // `_autoAdvancing`, prev/next's `_navigationalArrivals`) are gone by
      // the time the user answers, so the load after the answer runs with
      // the ones it was called with, for its synchronous part, as before.
      const held = [this._autoAdvancing, this._navigationalArrivals];
      const editedPath = this.scriptEditor?._funscriptPath || null; // what a Save writes
      if (!(await editorOk)) return undefined;
      const script = await this._rereadAfterEditorAnswer(funscriptData, editedPath);
      const now = [this._autoAdvancing, this._navigationalArrivals];
      [this._autoAdvancing, this._navigationalArrivals] = held;
      const load = this._playFromLibrary(videoData, script, subtitleData, variants);
      [this._autoAdvancing, this._navigationalArrivals] = now;
      return load;
    }
    // When the detached player window is open, the new video loads into IT,
    // not the main window — main stays on the library so it keeps being
    // browseable (deaf #189). Otherwise, switch to the inline player view —
    // UNLESS an Up Next / queue auto-advance fired while docked in the
    // mini-player, in which case the next video should keep playing in the
    // corner (navigating to the player would expand it to full-screen).
    const keepMini = this._miniActive && this._autoAdvancing;
    if (!this._playerWindowActive && !keepMini) this._navigateTo('player');

    // Flush the OUTGOING video's position before anything swaps it out —
    // `_currentVideoPath` is overwritten inside loadVideo, so this is the
    // last moment the old path and its clock still line up.
    const outgoing = this._currentVideoPath;
    if (outgoing && outgoing !== (videoData?.path || null)) {
      this._recordResumePosition({ force: true, path: outgoing });
    }
    // A video from your queue in the middle of Play All keeps the Play All
    // (R3-15, `_jumpToVideoFromQueue`); anything else opened ends it.
    const interlude = videoData?._playContext?.interlude === true
      && Array.isArray(this._playQueue) && this._playQueue.length > 0;
    if (!interlude) {
      this._playQueue = [];
      this._playQueueIndex = -1;
      this._playQueueSource = null;
      this._playQueueLoop = false;
      this._playQueueShuffle = false;
    }
    this._updateQueueUI();

    // Capture the play context attached by library/playlists/categories
    // so Up Next can advance through the user's filtered/sorted view.
    // Snapshot is immutable for this session — sort/filter changes during
    // playback don't retroactively alter "next" (Norman: conceptual
    // model). Drag-and-drop / Open File launches arrive without a
    // context and Up Next stays silent. A playlist with Shuffle on asks for
    // its order here (`_withShuffledStart`, V29); nothing else changes.
    this._currentPlayContext = this._withShuffledStart(videoData?._playContext || null, videoData);
    this._setUpNextContext(this._currentPlayContext);
    // Re-run now that the context exists: the call above (before the queue
    // reset) can only see `_playQueue`, so without this the prev/next
    // buttons stay hidden for context-driven playback.
    this._updateQueueUI();

    this._currentMultiAxis = null;

    // Reset custom-routing + axis state from any previous video so we
    // don't carry stale assignments across videos. The block below will
    // re-apply routing if the new video has one. Critical for the
    // "switch routed → unrouted video" case — without this, devices
    // assigned to CR1/CR2 on the previous video stay assigned and get
    // filtered out of the main-stroke loop, leaving only one device
    // firing.
    this._resetCustomRoutingState();

    // Up Next-driven advances opt into auto-play via _autoPlayOnLoad
    // when the user enabled player.autoplayOnAdvance. Direct library
    // clicks never set the flag — they always load paused so a click
    // doesn't immediately commit to playback.
    //
    // `player.autoplayOnOpen` opts OUT of that caution for people who
    // find it a wasted click (jwonone, EroScripts #322: "when I select a
    // file from the library, it switches to the player page, but does not
    // start playing"). Off by default — loading paused is the safer
    // default when a click can set a device moving, and it stays the
    // behaviour for anyone who does not go looking for this.
    //
    // Deliberately folded into the SAME flag rather than played
    // separately afterwards: everything below keys off `autoPlayOnLoad`,
    // including the cloud-upload gate that stops the video racing ahead
    // of a Handy or Autoblow script upload. A second `.play()` bolted on
    // later would skip that gate and reintroduce 1-3s of device silence.
    //
    // OPENS only. An unattended Up Next / queue advance reaches this method
    // by the same road as a click (`_playUpNext` -> `library._playVideo`),
    // with `_autoAdvancing` held across the load. Without the guard,
    // autoplayOnOpen played every advance and overrode "Auto-play the next
    // video" = off (app test V25). Advances decide through
    // `_autoPlayOnNextLoad` -> `_autoPlayOnLoad`, from autoplayOnAdvance.
    const autoPlayOnLoad = !!videoData?._autoPlayOnLoad
      || (!this._autoAdvancing && this.settings?.get?.('player.autoplayOnOpen') === true);
    // If we're auto-playing AND there's a funscript to upload, gate
    // playback on every connected cloud-sync device (Handy / Autoblow).
    // Without this, `loadeddata` would fire `.play()` immediately and
    // the video would race ahead while the cloud upload(s) are still
    // in flight (1–3s of device silence). `_resolveCloudUpload` from
    // each device's upload completion path lifts the gate when the
    // last one finishes. Marked right AFTER loadVideo below: loadVideo
    // clears any earlier gate, so marking it here first left nothing
    // waiting by `loadeddata` and autoplay never waited (FT-112, also in
    // v0.9.2).
    const gateCloudUploads = autoPlayOnLoad && !!funscriptData?.textContent;

    // Resume. Two arrival kinds, deliberately different:
    //
    //  - DELIBERATE (clicked this specific video) → ask. The user picked
    //    one thing; a choice about that one thing is proportionate.
    //  - FLOW-THROUGH (next/prev keys or buttons, Play All, Up Next) →
    //    resume silently and say so in a toast. A modal in a repeat-press
    //    path is an obstacle course: press N three times, get three
    //    blocking dialogs. Worse for auto-advance, where a dialog would
    //    strand unattended playback waiting for a click nobody will make.
    //
    // Flow-through resumes rather than restarting for a non-obvious
    // reason: starting at zero would immediately overwrite the stored
    // position with a low one as soon as playback passed the 10s
    // threshold, silently destroying a 40-minute bookmark nobody asked to
    // discard. Resuming preserves it, and the seek bar is a one-gesture
    // undo if the user did want the start.
    // `_currentPlayContext` is already the INCOMING context by this point
    // (assigned above), so this gates on where the new video is being
    // played FROM — playlists only.
    let resumeAt = null;
    const arrivalPath = videoData?.path || null;
    const flowThrough = !!this._autoAdvancing || (this._navigationalArrivals || 0) > 0;
    // Consumed once, and unconditionally, so a Start over chosen on the Up
    // Next card can never leak into the video after it.
    const startOverRequested = this._upNextStartOver === true;
    this._upNextStartOver = false;

    if (!this._isPlaylistContext(this._currentPlayContext)) {
      resumeAt = null;
    } else if (flowThrough) {
      const entry = this.getResumeEntry(arrivalPath);
      if (!startOverRequested && shouldOfferResume(entry, videoData?.duration)) {
        resumeAt = entry.position;
        showToast(t('resume.resumedToast', { time: formatResumeTime(entry.position) }), 'info', 4000);
      }
    } else {
      resumeAt = await this._maybeOfferResume(arrivalPath, videoData?.duration);
    }

    // While the pop-out owns playback the inline <video> only holds the
    // file: the pop-out plays it, from _routeLoadedVideoToPlayerWindow below
    // (V13). Autoplaying here too would start a second, hidden copy.
    this.loadVideo(videoData, {
      skipViewSwitch: true,
      autoPlay: autoPlayOnLoad && !this._playerWindowActive,
    });
    if (gateCloudUploads) this._markCloudUploadsPending();
    // An unattended advance loaded this: a file it finds missing is walked
    // past, not stopped on (_onCurrentVideoMissing).
    this._advanceLoadGen = this._autoAdvancing ? this._videoLoadGen : null;
    // Play All's `ended` advance takes over again after the interlude (R3-15).
    if (interlude) this._armQueueEndedListener();

    // Open straight into fullscreen when the user has asked for it
    // (lr_x3, EroScripts #317 — "so I don't have to press the fullscreen
    // button every time"). Deliberately NOT applied to the detached player
    // window or a docked mini-player: fullscreening either one is the stuck
    // state the toggle already guards against, and an auto-advance into the
    // corner must stay in the corner.
    if (this.settings?.get?.('player.openFullscreen') === true
        && !this._playerWindowActive && !keepMini) {
      // After loadVideo so the container is the current video's, and via
      // toggleFullscreen so the mini-player guard and the denied-by-policy
      // toast both still apply.
      requestAnimationFrame(() => {
        if (!document.fullscreenElement) this.videoPlayer?.toggleFullscreen?.();
      });
    }

    // Seek before playback starts, so the sync engine's play-anchor lands
    // at the resumed position rather than the seek-correction path having
    // to fix it up afterwards (see SCOPE-playlist-resume.md pitfall 4).
    if (resumeAt) this._applyPendingResumeSeek(resumeAt);

    const gen = this._videoLoadGen;
    await this._loadPlayContent(videoData, funscriptData, subtitleData, variants);
    // Another video was opened while this one's scripts loaded. Its own
    // path routes it to the pop-out; routing here too would reload it there
    // from 0 with THIS click's autoplay (a Play All item, paused).
    if (this._videoLoadGen !== gen) return;

    // Detached player is open → route this freshly-loaded video into it,
    // with the same autoplay decision the inline player would have used
    // (a plain click loads paused unless player.autoplayOnOpen is on, V15).
    await this._routeLoadedVideoToPlayerWindow(autoPlayOnLoad);

    // Final queue panel refresh — `loadVideo` already fired one, but
    // by now `_currentPlayContext` is set so `_getUpcoming` can derive
    // the library-context upcoming list correctly. Without this final
    // call the panel would show empty upcoming on the FIRST video play
    // of a session (because the loadVideo refresh fired before
    // `_playFromLibrary` finished setting `_currentPlayContext`).
    this._updateQueuePanelState();
  }

  /**
   * Everything a video carries besides the file: its script variants, the
   * main script with its companion axis files (`_multiAxis`, which win over
   * the axes embedded in the main script, V11) and custom routing
   * (`_customRouting`), its subtitle, and the pinned or random variant.
   * Runs right after `loadVideo`, which resets all of it.
   *
   * Shared by a library click (`_playFromLibrary`) and every Play All item
   * (`_loadQueueItemContent`), so a queued video gets exactly what a click on
   * it gets. Play All used to load the main script only (V72).
   *
   * Each await below can outlast the video: Next during Play All, or another
   * click, runs loadVideo, which bumps `_videoLoadGen`. From then on that
   * video owns the engines, so this one stops without writing anything more
   * (V72 review: a held route or variant read landed on the next item).
   * Hence a `movedOn()` check right after every await here, and the same in
   * `_loadCustomRouting`, `_switchVariant` and `loadFunscript`: add an await,
   * add the check.
   */
  async _loadPlayContent(videoData, funscriptData, subtitleData, variants) {
    const gen = this._videoLoadGen;
    const movedOn = () => this._videoLoadGen !== gen;
    // loadVideo's audience source; settled below when there is no main script.
    const audienceToken = this._audienceVideoToken;
    // T-Code homes the axes the last video moved on this one's first play
    // (FT-095). With companion files, decide only once they have loaded or
    // failed (E2-06): they load one after another below, not awaited, so on a
    // slow drive an axis this video drives was eased to centre first. Set
    // before loadFunscript starts the engine; a video without them drops
    // any hold an earlier load left.
    let companionsSettled = () => {};
    const companionAxes = funscriptData?._multiAxis?.axes;
    this.tcodeSync?.holdHomeUntil?.(companionAxes && Object.values(companionAxes).some(Boolean)
      ? new Promise((resolve) => { companionsSettled = resolve; })
      : null);
    // Set variants AFTER loadVideo (which resets them)
    this._currentVariants = variants || [];
    this._activeVariantIndex = 0;
    this._activeVariantPath = null;
    // The script this video opens on, for the variant menu's own "Default"
    // when the list is empty (N-02, see _updateVariantSelector). Tied to this
    // load: the next loadVideo bumps the generation and it no longer counts.
    this._mainScript = {
      gen,
      path: funscriptData?.textContent ? (funscriptData._funscriptPath || funscriptData.path || null) : null,
    };
    this._updateVariantSelector();
    if (funscriptData) {
      if (funscriptData._multiAxis) {
        this._currentMultiAxis = funscriptData._multiAxis;
      }

      // Custom routing: load additional routes BEFORE main script so device
      // assignments are in place when sync engines start (prevents all devices
      // briefly playing L0)
      if (funscriptData._customRouting) {
        this._customRoutingActive = true;

        // Fallback for the "no auto-paired main .funscript exists" case
        // (e.g. user has only variant files like .anal.funscript on disk).
        // The library passes textContent=null in that case, which would
        // skip loadFunscript and lose badge/heatmap/sync-engine wiring.
        // If the main route in routing config points at a readable file
        // (or one we can recover via _readRouteScript's stale-path
        // fallback), promote it to textContent so loadFunscript runs as
        // if a matching .funscript had been auto-paired.
        if (!funscriptData.textContent) {
          const mainRoute = funscriptData._customRouting.find(r => r.role === 'main');
          if (mainRoute?.scriptPath) {
            const read = await this._readRouteScript(mainRoute, videoData?.path || null);
            if (movedOn()) return;
            if (read) {
              funscriptData.textContent = read.content;
              funscriptData.name = (read.recoveredPath || mainRoute.scriptPath).split(/[\\/]/).pop();
              if (read.recoveredPath) mainRoute.scriptPath = read.recoveredPath;
              console.log(`[CustomRouting] Promoted main route script ${funscriptData.name} into the main funscript slot`);
            } else {
              console.warn('[CustomRouting] Main route scriptPath unreadable:', mainRoute.scriptPath);
            }
          }
        }

        await this._loadCustomRouting(funscriptData._customRouting, videoData?.path || null);
        if (movedOn()) return;
      }
      // No `else` — cleanup of stale routing state already happened in the
      // caller, before loadVideo. Setting `_customRoutingActive` false again
      // here would be redundant.

      // Only load main funscript if it has content
      if (funscriptData.textContent) {
        this.loadFunscript(funscriptData);
      } else {
        // No main script (companion files only, an unreadable main route):
        // viewers get nothing, like the streamer's own Handy, and stay
        // stopped. A pinned variant below begins its own source.
        this.audienceBridge?.setNoScript(audienceToken, { reason: 'no-main-script' });
      }
      // Load multi-axis vibration script for Buttplug.io (works with or without main script)
      if (funscriptData._multiAxis) {
        // Settled or failed, T-Code may decide what to home (E2-06).
        Promise.resolve(this._loadMultiAxisScripts(funscriptData._multiAxis)).finally(companionsSettled);
      }
    } else {
      this.audienceBridge?.setNoScript(audienceToken, { reason: 'no-script' });
    }
    if (subtitleData) {
      this._loadSubtitleFromLibrary(subtitleData);
    }
    // Honor a per-video pinned default variant (lr_x3 request): once the
    // auto-default has loaded, swap to the user's preferred variant for
    // this video if one is set. Falls back silently to the auto-default.
    await this._applyPreferredVariant();
  }

  async _loadMultiAxisScripts(config) {
    if (!config.axes) return;

    const axisEntries = Object.entries(config.axes); // e.g. { vib: 'path', twist: 'path', ... }
    if (axisEntries.length === 0) return;

    // No wholesale clear here: loadVideo already emptied both engines, and
    // this runs alongside loadFunscript, whose embedded feed may already
    // have set the axes no companion covers. Clearing would wipe those on
    // one engine only, depending on which load landed first (V11).
    this._companionAxesFailed = new Set();

    let vibActions = null;
    let firstLoadedScript = null;

    for (const [suffix, axisPath] of axisEntries) {
      if (!axisPath) continue;
      // The channel comes from multi-axis.js AXIS_DEFINITIONS, aliases
      // included, as the scan and auto-assign name the axes. A hand-written
      // map here had no `suck` (the canonical name the scan keys a
      // `.suck` / `.a1` companion by since FT-047), so that axis was dropped
      // without a word, and it still had suction on V2 and lube on V1 (pump's
      // channel), which the 2026-08-16 table moved to A1 and A2 (block C
      // verifier 2; also in v0.9.2).
      const tcode = getAxisBySuffix(suffix)?.tcode;
      if (!tcode) continue;

      try {
        // Resilient read covers users who reorganised their scripts —
        // dead axisPath gets recovered from a sibling-of-video lookup.
        const read = await this._readScriptResilient(axisPath, this._currentVideoPath || null);
        // Another video loaded during the read: this config is not the
        // player's any more, and its axes must not land on the new video.
        if (this._currentMultiAxis !== config) return;
        if (!read) {
          this._releaseCompanionAxis(suffix);
          continue;
        }
        const content = read.content;
        if (read.recoveredPath) config.axes[suffix] = read.recoveredPath;
        const parsed = JSON.parse(content);
        const actions = parsed?.actions;
        if (!actions || actions.length < 2) continue;

        if (suffix === 'vib') {
          vibActions = actions;
        }

        // Load as axis actions into ButtplugSync and TCodeSync
        if (this.buttplugSync) {
          this.buttplugSync.setAxisActions(tcode, actions);
        }
        if (this.tcodeSync) {
          this.tcodeSync.setAxisActions(tcode, actions);
        }
        console.log(`[MultiAxis] Loaded ${suffix} (${tcode}): ${actions.length} actions`);

        if (!firstLoadedScript) {
          firstLoadedScript = { content, name: axisPath.split(/[\\/]/).pop(), actions };
        }
      } catch (err) {
        console.warn(`[MultiAxis] Failed to load ${suffix} script:`, err.message);
        // Tell the user WHICH axis dropped — a multi-axis setup that
        // "sort of works" with one axis missing is confusing without
        // feedback, and the console-only log is invisible to most users.
        showToast(t('toast.multiAxisFailed', { suffix, error: err.message }), 'warn', 5000);
        if (this._currentMultiAxis !== config) return;
        this._releaseCompanionAxis(suffix);
      }
    }
    if (this._currentMultiAxis !== config) return;

    // If no main funscript was loaded, use the first companion for heatmap + badge
    if (!this.funscriptEngine.isLoaded && firstLoadedScript) {
      await this.funscriptEngine.loadContent(firstLoadedScript.content, firstLoadedScript.name);
      this._showFunscriptBadge({
        filename: firstLoadedScript.name,
        actionCount: firstLoadedScript.actions.length,
        durationFormatted: this._formatActionsDuration(firstLoadedScript.actions),
      });
      if (isFinite(this.videoPlayer.duration) && this.videoPlayer.duration > 0) {
        this.progressBar.renderHeatmap(firstLoadedScript.actions, this.videoPlayer.duration);
        this._feedInlineViz(firstLoadedScript.actions, this.videoPlayer.duration);
        this.progressBar.setMarkers({
          chapters: this.funscriptEngine.getChapters(),
          bookmarks: this.funscriptEngine.getBookmarks(),
        });
        if (this.funscriptEngine.getChapters().length > 0) {
          this.progressBar.renderChapterStrip(this.videoPlayer.duration);
        }
      }
    }

    // Route vib axis to Buttplug.io vibrate devices via dedicated path (backwards compat)
    if (vibActions && config.buttplugVib && this.buttplugSync) {
      this.buttplugSync.setVibrationActions(vibActions);
      if (this.connectionPanel) this.connectionPanel.updateVibControlState();
    }

    // Start sync if not already active (multi-axis-only case)
    if (this.buttplugSync && this.buttplugManager?.connected && !this.buttplugSync._active) {
      const devices = this.buttplugManager.devices;
      if (devices.length > 0) {
        if (this.connectionPanel) this.connectionPanel._loadButtplugDeviceSettings();
        this.buttplugSync.start();
      }
    }

    // Update editor script list for multi-axis (companions, plus any
    // embedded axis they do not cover).
    this._refreshEditorScriptList();
  }

  /**
   * Embedded multi-axis fallback. When a funscript bundles
   * pitch/roll/twist into the SINGLE main file (instead of separate
   * `.pitch.funscript` / `.roll.funscript` companion files), the
   * canonical companion-detection in `_loadMultiAxisScripts` finds
   * nothing — the device only gets L0. This method runs the
   * `extractEmbeddedAxes` detector against the raw file content; if
   * any embedded axes are found, they're fed into the multi-axis
   * sync engines (ButtplugSync + TCodeSync) exactly the same way
   * companion-file axes are.
   *
   * Side-effects:
   *   - Sync engines receive `setAxisActions(tcode, actions)` per axis
   *   - `_embeddedAxesByPath` cache populated so the badge tooltip,
   *     library card, and Change-Funscript modal can surface the
   *     embedded axes without re-parsing the file
   *   - First time per video path per session: an info toast tells
   *     the user that embedded axes were detected (suppressed on
   *     subsequent loads of the same path so repeats stay quiet)
   *
   * No persistence to disk — axes only live in memory for this
   * session. The kebab "Extract embedded axes…" action materialises
   * them as proper companion files on the user's request.
   *
   * Surfaced via community report 2026-05-24: OSR2 owner downloaded
   * a combined-format script from the forum; only the up-down motion
   * worked because rotation axes were embedded, not companion-paired.
   */
  _feedEmbeddedMultiAxis(rawContent, funscriptPath = null) {
    if (!rawContent) return;
    let parsed;
    // Drag-drop path can pass content straight from `file.text()` which
    // preserves any leading UTF-8 BOM. Strip defensively — IPC reads
    // already strip at the boundary.
    try { parsed = JSON.parse(stripBOM(rawContent)); } catch { return; }
    const extracted = extractEmbeddedAxes(parsed);

    // Cache (or clear) for this video's funscript path. Other UI
    // surfaces — badge tooltip, library card multi-badge, modal —
    // read this cache so they don't re-parse the file.
    if (!this._embeddedAxesByPath) this._embeddedAxesByPath = new Map();
    if (!this._embeddedAxesToastShown) this._embeddedAxesToastShown = new Set();
    // Key on the FUNSCRIPT path. This used to key on `_currentVideoPath`
    // while every reader — `getEmbeddedAxes(video.funscriptPath)` from
    // the library badge, the kebab, the Change-Funscript modal — looked
    // it up by funscript path, so the cache never once hit and the
    // combined-script badge could not appear even after playing the
    // video (community report 2026-08-29, EroScripts #309393).
    const cacheKey = funscriptPath || this._currentVideoPath || rawContent.slice(0, 64);

    if (extracted.size === 0) {
      this._embeddedAxesByPath.delete(cacheKey);
      return;
    }

    const { embeddedSuffixes, fedSuffixes } = this._applyEmbeddedAxes(extracted);
    if (embeddedSuffixes.length === 0) return;

    // Cache for other surfaces. Store both the suffix list (cheap to
    // iterate) and the full action arrays (so the "Extract to
    // companions" action doesn't need to re-parse the file). Every
    // embedded axis is listed, including the ones a companion plays: the
    // file still carries them.
    this._embeddedAxesByPath.set(cacheKey, {
      suffixes: embeddedSuffixes,
      axes: extracted,
    });

    // Toast only once per video path per session. Repeated plays of
    // the same file stay quiet. Nothing to announce when every embedded
    // axis is covered by a companion.
    if (fedSuffixes.length > 0 && !this._embeddedAxesToastShown.has(cacheKey)) {
      this._embeddedAxesToastShown.add(cacheKey);
      showToast(
        `Multi-axis detected — loaded ${fedSuffixes.length} embedded ${fedSuffixes.length === 1 ? 'axis' : 'axes'}: ${fedSuffixes.join(', ')}`,
        'info',
        4000,
      );
    }

    // Refresh the badge tooltip so the embedded-axes line shows up
    // alongside the main filename. _showFunscriptBadge reads
    // _embeddedAxesByPath, so re-invoking it picks up the new cache.
    if (this._lastFunscriptInfo) this._showFunscriptBadge(this._lastFunscriptInfo);
  }

  /**
   * Put the main script's embedded axes on both engines, except any axis
   * the user assigned a companion file for: that one plays from the file.
   * Both loads run at once from `_playFromLibrary`, and the feed used to
   * clear and overwrite whatever the companion reads had set so far, so an
   * edited extracted twist lost to the original embedded one in 6 opens
   * out of 7 (V11). Skipping by TCode channel makes the precedence hold in
   * any order. Returns every valid embedded suffix (for the cache) and the
   * ones actually fed.
   */
  _applyEmbeddedAxes(extracted) {
    // Same suffix→TCode lookup as `_loadMultiAxisScripts`: multi-axis.js
    // AXIS_DEFINITIONS, aliases included.
    const tcodeOf = (suffix) => getAxisBySuffix(suffix)?.tcode || null;
    const companionTcodes = new Set();
    for (const suffix of this._companionAxisSuffixes()) {
      if (tcodeOf(suffix)) companionTcodes.add(tcodeOf(suffix));
    }

    // Drop what an earlier feed set (a script loaded on top of this
    // video), on BOTH engines, without touching companion axes. This used
    // to be a wholesale buttplug-only clear.
    if (!this._embeddedAxisTcodes) this._embeddedAxisTcodes = new Set();
    for (const tcode of this._embeddedAxisTcodes) {
      if (companionTcodes.has(tcode)) continue;
      this.buttplugSync?.setAxisActions?.(tcode, null);
      this.tcodeSync?.setAxisActions?.(tcode, null);
    }
    this._embeddedAxisTcodes.clear();

    const embeddedSuffixes = [];
    const fedSuffixes = [];
    for (const [suffix, actions] of extracted) {
      const tcode = tcodeOf(suffix);
      if (!tcode) continue;
      if (!Array.isArray(actions) || actions.length < 2) continue;
      embeddedSuffixes.push(suffix);
      if (companionTcodes.has(tcode)) {
        console.log(`[EmbeddedMultiAxis] ${suffix} (${tcode}) skipped: the assigned companion file plays it`);
        continue;
      }
      this.buttplugSync?.setAxisActions?.(tcode, actions);
      this.tcodeSync?.setAxisActions?.(tcode, actions);
      this._embeddedAxisTcodes.add(tcode);
      fedSuffixes.push(suffix);
      console.log(`[EmbeddedMultiAxis] Loaded ${suffix} (${tcode}): ${actions.length} actions`);
    }
    return { embeddedSuffixes, fedSuffixes };
  }

  /**
   * Suffixes the current video plays from an assigned companion file
   * (`_currentMultiAxis.axes`). `_applyEmbeddedAxes` leaves their channels
   * alone (V11). A companion that could not be read has been released by
   * `_releaseCompanionAxis` and is not in the set.
   */
  _companionAxisSuffixes() {
    const out = new Set();
    const axes = this._currentMultiAxis?.axes;
    if (!axes) return out;
    for (const [suffix, axisPath] of Object.entries(axes)) {
      if (axisPath && !this._companionAxesFailed?.has(suffix)) out.add(suffix);
    }
    return out;
  }

  /**
   * An assigned companion could not be read (moved, deleted, unreadable).
   * Absence must not silence an axis the main script still carries: hand
   * the channel back to the embedded copy. If the embedded feed has not
   * run yet, it sees the suffix released and feeds it itself.
   */
  _releaseCompanionAxis(suffix) {
    if (!this._companionAxesFailed) this._companionAxesFailed = new Set();
    this._companionAxesFailed.add(suffix);
    const axes = this.getEmbeddedAxes(this._currentFunscriptPath)?.axes;
    if (!(axes instanceof Map) || axes.size === 0) return;
    const { fedSuffixes } = this._applyEmbeddedAxes(axes);
    console.log(`[MultiAxis] ${suffix} companion unreadable; embedded axes now playing: ${fedSuffixes.join(', ') || 'none'}`);
  }

  /** Read-only accessor for the embedded-axes cache used by library
   *  cards and the Change-Funscript modal. Returns `null` for paths
   *  with no detected embedded axes. */
  getEmbeddedAxes(funscriptPath) {
    if (!this._embeddedAxesByPath) return null;
    return this._embeddedAxesByPath.get(funscriptPath) || null;
  }

  /** On-demand detection — read a funscript file from disk and probe
   *  for embedded axes. Used by the Change-Funscript modal so the
   *  axis dropdowns can show `(embedded in main)` for files the user
   *  hasn't played yet. Populates the same cache so subsequent reads
   *  hit the in-memory copy. */
  async detectEmbeddedAxesForPath(funscriptPath) {
    if (!funscriptPath || typeof funscriptPath !== 'string') return null;
    const cached = this.getEmbeddedAxes(funscriptPath);
    if (cached) return cached;
    try {
      const content = await window.funsync.readFunscript(funscriptPath);
      if (!content) return null;
      const parsed = JSON.parse(content);
      const extracted = extractEmbeddedAxes(parsed);
      if (extracted.size === 0) return null;
      if (!this._embeddedAxesByPath) this._embeddedAxesByPath = new Map();
      const entry = { suffixes: [...extracted.keys()], axes: extracted };
      this._embeddedAxesByPath.set(funscriptPath, entry);
      return entry;
    } catch (err) {
      console.warn('[EmbeddedMultiAxis] detect failed for', funscriptPath, err?.message);
      return null;
    }
  }

  /**
   * Extract embedded axes to disk as companion `.funscript` files.
   * Called from the library kebab "Extract embedded axes…" item.
   *
   * For each detected axis:
   *  1. Build a `.funscript`-shaped JSON via `buildCompanionFiles`
   *  2. Write to `<videoStem>.<suffix>.funscript` via IPC
   *  3. Update `library.associations[videoPath]` to register the new
   *     companion (mode → multi if not already; axes → suffix map)
   *
   * After this completes, the next library scan picks up the new
   * companion files via the standard `detectCompanionFiles` path —
   * which means the multi badge, Stacked Lane View, modal dropdowns,
   * all the existing multi-axis surfaces just work.
   */
  async _extractEmbeddedAxesToCompanions(video) {
    if (!video?.funscriptPath || !video?.path) {
      showToast('Cannot extract — video or funscript path missing', 'error');
      return null;
    }
    const entry = this.getEmbeddedAxes(video.funscriptPath)
      || await this.detectEmbeddedAxesForPath(video.funscriptPath);
    if (!entry || entry.suffixes.length === 0) {
      showToast('No embedded axes detected in this funscript', 'info');
      return null;
    }
    const files = buildCompanionFiles(entry.axes);
    const paths = companionPathMap(video.path, entry.suffixes);

    // Never replace a companion that is already there. An axis that has
    // one assigned keeps it, and a file already at the target path is not
    // overwritten: either may be a companion the user edited after an
    // earlier Extract, and companions now win over the embedded copy (V11).
    // Extract can run again from the kebab, and from the editor's embedded
    // entries (V42) while some axes are already companions. Only a
    // definite "absent" is written; an unknown (timed-out) probe is not.
    const prevAxes = (this.settings?.get?.('library.associations') || {})[video.path]?.multi?.axes || {};
    const assigned = {};
    for (const [suffix, p] of Object.entries(prevAxes)) if (p) assigned[suffix] = p;
    const todo = files.filter((f) => paths[f.suffix] && !assigned[f.suffix]);
    let present = [];
    try {
      present = await window.funsync.filesExist(todo.map((f) => paths[f.suffix]));
    } catch (err) {
      console.warn('[EmbeddedMultiAxis] existence check failed:', err?.message || err);
    }

    let wrote = 0;
    const failed = [];
    // Embedded axes that already have a companion assigned: left as they are.
    const kept = entry.suffixes.filter((s) => assigned[s]).map((s) => assigned[s]);
    const extracted = {};
    for (let i = 0; i < todo.length; i++) {
      const f = todo[i];
      const targetPath = paths[f.suffix];
      if (present[i] === true) {
        kept.push(targetPath);
        extracted[f.suffix] = targetPath;
        continue;
      }
      if (present[i] !== false) {
        failed.push(f.suffix);
        continue;
      }
      try {
        const content = JSON.stringify(f.content);
        const result = await window.funsync.writeFunscript(content, targetPath);
        if (result) {
          wrote++;
          extracted[f.suffix] = targetPath;
        } else {
          failed.push(f.suffix);
        }
      } catch (err) {
        console.warn('[EmbeddedMultiAxis] write failed', f.suffix, err?.message);
        failed.push(f.suffix);
      }
    }

    if (todo.length > 0 && Object.keys(extracted).length === 0) {
      showToast(`Extraction failed (${failed.join(', ')})`, 'error');
      return null;
    }

    // Register the extracted axes as a multi-axis association so the
    // library card, modal, stacked-view all pick them up without a
    // rescan. Preserve any existing `single` slot as the fallback main.
    let multi = null;
    try {
      const assocs = this.settings?.get?.('library.associations') || {};
      const existing = assocs[video.path] || {};
      // The funscript badge keeps saying who chose the scripts (V41): the
      // companions are named by convention, so extracting from a script
      // FunSync paired by name is still FunSync's pairing; extracting from
      // one the user picked by hand stays theirs.
      const autoAssigned = !video._manualAssociation || !!video._autoAssigned;
      const { autoAssigned: _wasAuto, ...prevMulti } = existing.multi || {};
      multi = {
        ...prevMulti,
        main: existing.multi?.main || video.funscriptPath,
        // Assigned companions win over the freshly extracted paths.
        axes: { ...(existing.multi?.axes || {}), ...extracted, ...assigned },
        ...(autoAssigned ? { autoAssigned: true } : {}),
      };
      assocs[video.path] = {
        ...existing,
        active: 'multi',
        single: existing.single || video.funscriptPath,
        multi,
      };
      this.settings?.set?.('library.associations', assocs);
      // What `_applyManualAssociations` would set for this entry, so the
      // card and the next play take the companions at once, even before
      // the rescan below lands (V40).
      video.hasFunscript = true;
      video._multiAxis = multi;
      video._manualAssociation = true;
      video._autoAssigned = autoAssigned;
    } catch (err) {
      console.warn('[EmbeddedMultiAxis] association update failed:', err?.message);
      multi = null;
    }

    if (wrote > 0) {
      showToast(
        `Extracted ${wrote} ${wrote === 1 ? 'axis' : 'axes'} to companion files${failed.length ? ` (${failed.length} failed)` : ''}`,
        'info',
        4500,
      );
    }
    if (kept.length > 0) {
      showToast(t('toast.extractKeptExisting', {
        count: kept.length,
        names: kept.map((p) => p.split(/[\\/]/).pop()).join(', '),
      }), 'info', 6000);
    }

    // Rescan so the new files join `_allFunscripts` (the modal's axis
    // dropdowns) and the scanned video carries the multi config, then
    // re-render so the card's badge moves from "embedded" to companion
    // multi-axis. This used to pass `true`, which `ensureScanned`
    // destructures as `{ forceRescan = false }`: a no-op on any populated
    // library, so nothing changed until a manual Refresh (V40).
    try {
      await this.library?.ensureScanned?.({ forceRescan: true });
      if (this.library && !this.library._scanning && this._currentView() === 'library') {
        this.library._applyFilters?.();
      }
    } catch (err) {
      console.warn('[EmbeddedMultiAxis] rescan after extract failed:', err?.message || err);
    }
    return multi;
  }

  /**
   * The editor's "<axis> (embedded): extract to edit…" entries (#376, V42).
   * An axis embedded in the main script has no file of its own to load or
   * save to, so picking one runs the same Extract as the library kebab
   * (companion files + a multi association, never overwriting one that is
   * there), switches this video over to those companions, and opens the
   * chosen axis in the editor.
   */
  async _editEmbeddedAxis(suffix) {
    const videoPath = this._currentVideoPath;
    const fsPath = this._currentFunscriptPath;
    if (!videoPath || !fsPath || this._editingEmbeddedAxis) return;
    this._editingEmbeddedAxis = true;
    try {
      // The library's own video object when it is this script, so the card
      // and the next play update with it (V40); otherwise (a variant, a
      // dropped file) just the two paths the extract needs.
      const libVideo = this.library?.getVideoByPath?.(videoPath) || null;
      const video = libVideo?.funscriptPath === fsPath
        ? libVideo
        : { ...(libVideo || {}), path: videoPath, funscriptPath: fsPath };
      const multi = await this._extractEmbeddedAxesToCompanions(video);
      // Nothing written, or another video loaded meanwhile: leave it be.
      if (!multi || this._currentVideoPath !== videoPath) return;
      this._currentMultiAxis = multi;
      await this._loadMultiAxisScripts(multi);
      const target = multi.axes?.[suffix];
      if (target && this._currentMultiAxis === multi) {
        await this.scriptEditor?.selectScript?.(target);
      }
    } finally {
      this._editingEmbeddedAxis = false;
    }
  }

  /**
   * The editor's script selector: the main script, every assigned
   * companion file, and every axis embedded in the main script that no
   * companion covers. Built from current state each time, so the two
   * loads that feed it (`loadFunscript`, `_loadMultiAxisScripts`) can land
   * in either order. Embedded entries have no file: picking one runs
   * `_editEmbeddedAxis`, and the stacked view previews them read-only
   * (#376, V42). Custom routing owns the list while it is active.
   */
  _refreshEditorScriptList() {
    if (!this.scriptEditor || this._customRoutingActive) return;
    const SUFFIX_LABELS = { surge: 'Surge', sway: 'Sway', twist: 'Twist', roll: 'Roll', pitch: 'Pitch', vib: 'Vibe', lube: 'Lube', pump: 'Pump', suction: 'Suction', valve: 'Valve' };
    const label = (suffix) => SUFFIX_LABELS[suffix] || suffix;
    const scripts = [{ label: t('editor.mainAxisLabel'), path: this.scriptEditor._funscriptPath || '' }];
    const companions = Object.entries(this._currentMultiAxis?.axes || {}).filter(([, p]) => p);
    for (const [suffix, axisPath] of companions) {
      scripts.push({ label: label(suffix), path: axisPath });
    }
    const covered = new Set(companions.map(([suffix]) => suffix));
    const embedded = this._currentFunscriptPath ? this.getEmbeddedAxes(this._currentFunscriptPath) : null;
    for (const suffix of embedded?.suffixes || []) {
      if (covered.has(suffix)) continue;
      scripts.push({
        label: t('editor.embeddedAxisLabel', { axis: label(suffix) }),
        path: `${this._currentFunscriptPath}#embedded=${suffix}`,
        embeddedAxis: suffix,
      });
    }
    this.scriptEditor.setAvailableScripts(scripts.length > 1 ? scripts : []);
  }

  _formatActionsDuration(actions) {
    if (!actions || actions.length === 0) return '0:00';
    const totalMs = actions[actions.length - 1].at - actions[0].at;
    const totalSec = Math.floor(totalMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * While a menu that opens upward from the control bar is open (the variant
   * dropdown, the speed popover, the overflow menu), the toasts move to the
   * top of the player: `body.controls-popover-open` (player.css). A toast
   * sits at bottom:80px over everything (z-index 2000), so a persistent
   * error toast covered the dropdown's items and they could not be clicked
   * (FT-073; also in v0.9.2). No toast is hidden, they only move.
   *
   * The class follows each menu's `hidden` attribute, so every way one opens
   * or closes (its button, a choice, Esc, an outside click, a re-render, a
   * video load) keeps it right without each of those paths having to say so.
   * Also gives the variant dropdown the Esc the other two menus have, taken
   * (preventDefault) so the press closes only the dropdown (FT-072).
   * @returns {MutationObserver|null}
   */
  _wireControlsPopoverToasts() {
    const menus = ['variant-dropdown', 'speed-popover', 'controls-overflow-menu']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (menus.length === 0) return null;
    const sync = () => {
      const open = menus.some((el) => el.isConnected && !el.hidden);
      document.body.classList.toggle('controls-popover-open', open);
    };
    const variantDropdown = document.getElementById('variant-dropdown');
    if (variantDropdown) {
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || variantDropdown.hidden) return;
        if (document.querySelector('.modal-overlay')) return; // a dialog owns Esc
        e.preventDefault();
        const back = variantDropdown.contains(document.activeElement)
          ? document.getElementById('variant-btn') : null;
        variantDropdown.hidden = true;
        if (back?.isConnected) {
          try { back.focus({ preventScroll: true }); } catch { /* not focusable */ }
        }
      }, true);
    }
    sync();
    if (typeof MutationObserver !== 'function') return null;
    const observer = new MutationObserver(sync);
    for (const el of menus) observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    return observer;
  }

  _wireSpeedControl() {
    const chip = document.getElementById('speed-chip');
    const chipLabel = document.getElementById('speed-chip-label');
    const overflowItem = document.getElementById('btn-speed-menu');
    const overflowCurrent = document.getElementById('speed-menu-current');
    const popover = document.getElementById('speed-popover');
    const overflowBtn = document.getElementById('btn-overflow');
    const overflowMenu = document.getElementById('controls-overflow-menu');
    if (!chip || !chipLabel || !overflowItem || !popover) return;

    let popoverAnchor = null;

    // Build popover items from the canonical preset list.
    const renderPopover = (currentRate) => {
      popover.innerHTML = '';
      for (const rate of PLAYBACK_RATE_PRESETS) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'speed-popover__item';
        item.setAttribute('role', 'menuitem');
        item.dataset.rate = String(rate);
        item.textContent = `${rate}×`;
        if (rate === currentRate) item.classList.add('speed-popover__item--current');
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.videoPlayer.setPlaybackRate(rate);
          closePopover();
        });
        popover.appendChild(item);
      }
    };

    const openPopover = (anchorEl) => {
      popoverAnchor = anchorEl;
      renderPopover(this.videoPlayer.video.playbackRate || 1);
      popover.hidden = false;
      anchorEl?.setAttribute('aria-expanded', 'true');
    };
    const closePopover = () => {
      popover.hidden = true;
      popoverAnchor?.setAttribute('aria-expanded', 'false');
      popoverAnchor = null;
    };

    const closeOverflowMenu = () => {
      if (overflowMenu && !overflowMenu.hidden) {
        overflowMenu.hidden = true;
        overflowBtn?.setAttribute('aria-expanded', 'false');
      }
    };

    // Chip — only present in DOM when rate ≠ 1. Click opens popover
    // anchored to itself. If the overflow menu is open, close it first
    // so we don't end up with two menus on screen at once.
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOverflowMenu();
      popover.hidden ? openPopover(chip) : closePopover();
    });

    // Overflow menu entry — close the overflow menu, then open the
    // popover anchored to the ⋮ trigger so the popover visually
    // replaces the overflow menu in roughly the same spot.
    overflowItem.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOverflowMenu();
      openPopover(overflowBtn || overflowItem);
    });

    // Outside-click dismissal — registered in the CAPTURE phase so we
    // see clicks before other handlers can stopPropagation them. The
    // existing overflow-button handler calls stopPropagation in bubble
    // phase, which used to hide ⋮ clicks from a bubble-phase dismissal
    // listener entirely. Capture phase fires first regardless.
    //
    // Three precedence rules, in order:
    //   1. Click inside the popover → keep it open (item-click handlers
    //      manage the rest).
    //   2. Click on the ⋮ button → always close the popover, even when
    //      ⋮ is the current anchor. Without this, opening the popover
    //      from the overflow menu would trap the user — clicking ⋮ to
    //      "go back" would re-open the overflow menu on top of the
    //      still-visible popover.
    //   3. Click on the current anchor (chip, when applicable) → ignore.
    //      The anchor's own handler is responsible for the toggle.
    //   4. Anything else → close.
    document.addEventListener('click', (e) => {
      if (popover.hidden) return;
      if (popover.contains(e.target)) return;
      if (overflowBtn?.contains(e.target)) {
        closePopover();
        return;
      }
      if (popoverAnchor?.contains(e.target)) return;
      closePopover();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !popover.hidden) {
        e.preventDefault(); // taken: keyboard.js leaves the queue panel open
        closePopover();
      }
    }, true);

    // Keep chip + overflow-menu label in sync with rate changes from
    // any surface (keyboard, editor, web-remote later).
    const updateLabels = (rate) => {
      const text = `${rate}×`;
      chipLabel.textContent = text;
      if (overflowCurrent) overflowCurrent.textContent = text;
      chip.hidden = (rate === 1);
      if (!popover.hidden) renderPopover(rate); // refresh checkmark if open
    };
    eventBus.on('playback:rate-changed', updateLabels);

    // Initialise — covers the path where a video is already loaded.
    updateLabels(this.videoPlayer.video.playbackRate || 1);
  }

  /**
   * Re-translate the player chrome app.js paints itself, on every language
   * switch. Each of these was drawn with t() on a state change and never
   * again, so a switch left it in the old language (app test V50), or the
   * static data-i18n walk reset it to its boot text: the Loop video value
   * read "Off" with loop on (V69). setLocale() walks the static keys BEFORE
   * it emits, so this runs after the walk and has the last word.
   *
   * A detached player is its own renderer with its own i18n state, and
   * nothing told it about a switch: it kept the old language until it was
   * reopened (V50). Hand it the new locale; its own handler re-applies what
   * it paints. The audience pop-out is re-sent its state in
   * _wireAudiencePopoutRelay.
   */
  _wirePlayerChromeLanguage() {
    eventBus.on('language:changed', ({ locale } = {}) => {
      this._retranslatePlayerChrome();
      if (this._playerWindowOpen && locale) {
        window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.LOCALE, { locale }));
        // Its variation menu carries main's word for "main" (`mainTag`,
        // FN-03), so it is sent again in the new language; it kept the old
        // word until the window was reopened (block F verify-1, cosmetic).
        this._streamPlayerWindowData();
      }
    });
  }

  _retranslatePlayerChrome() {
    // Play / mute / fullscreen labels (video-player.js): the walk reset a
    // muted video's button to "Mute" and a playing one's to "Play".
    this.videoPlayer?.refreshLabels?.();
    // "Pop in" while the pop-out is open; its static key is "Pop out".
    this._updatePlayerWindowButton();
    // Set once in init(), with no static key for the aria-label.
    document.getElementById('subtitle-badge')?.setAttribute('aria-label', t('app.toggleSubtitles'));
    const loopState = document.getElementById('loop-video-state');
    if (loopState && this.videoPlayer?.video) {
      loopState.textContent = this.videoPlayer.video.loop
        ? t('player.loopVideo.stateOn')
        : t('player.loopVideo.stateOff');
    }
    // Same choice as _updateDeviceIndicators makes on a device change.
    const handyBtn = document.getElementById('btn-handy');
    if (handyBtn) {
      handyBtn.title = this._getConnectedDeviceCount() === 1
        ? t('player.deviceConnectionShortcut')
        : t('player.devicesConnectionShortcut');
    }
    this._updatePlayerSyncChip();
    // The variant button names a file (FN-03), which has no language; with
    // nothing to name it says "No script", which has.
    const variantBtnLabel = document.getElementById('variant-btn-label');
    const activeVariant = this._allVariantsWithManual?.[this._activeVariantIndex || 0];
    if (variantBtnLabel && activeVariant) variantBtnLabel.textContent = this._variantLabelText(activeVariant);
    // No entry plays and no script either (an empty list, or hand-added
    // variations none of which is loaded yet: index -1).
    else if (variantBtnLabel && !activeVariant && !this._activeVariantPath) {
      variantBtnLabel.textContent = t('syncChip.noScript');
    }
    // Set once in init(); its title (the script's name) is JS-owned and
    // carries no static key, so the walk leaves it alone.
    document.getElementById('funscript-badge')?.setAttribute('aria-label', t('app.openScriptEditor'));
  }

  /**
   * Wire the "Loop video" overflow menu item + the loop chip + the
   * Shift+L shortcut. Session-scoped: `video.loop` resets to `false`
   * on every new video load (the existing reset path in `loadVideo`
   * already does this — HTMLMediaElement's default is `false`, and we
   * set `.src` which reconstructs media state). When loop is on, Up
   * Next stays suppressed via the existing `_syncUpNextSuppression`
   * check (it already reads `video.loop`).
   */
  _wireLoopVideo() {
    const menuItem = document.getElementById('btn-loop-video');
    const stateLabel = document.getElementById('loop-video-state');
    const chip = document.getElementById('loop-chip');
    if (!menuItem || !stateLabel || !chip) return;

    const refresh = () => {
      const on = !!this.videoPlayer.video.loop;
      menuItem.setAttribute('aria-checked', String(on));
      stateLabel.textContent = on
        ? t('player.loopVideo.stateOn')
        : t('player.loopVideo.stateOff');
      chip.hidden = !on;
      // Sync Up Next suppression — engine reads video.loop directly,
      // but only re-evaluates on its own check cadence. Force a check
      // now so the card hides immediately when the user turns loop on.
      this._syncUpNextSuppression();
      this.upNextEngine?.check();
    };

    const toggle = () => {
      // Defensive: ignore toggle requests while a phone is driving
      // playback — control is suppressed in the UI but the keyboard
      // shortcut could still fire it. Phone's <video> doesn't mirror
      // the loop flag, so toggling here would desync the device
      // (looping on desktop's timeline) from the phone's playback.
      if (this._remoteActive) return;
      this.videoPlayer.video.loop = !this.videoPlayer.video.loop;
      refresh();
    };

    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    // Re-paint on every video load so the label/aria stay accurate.
    // The flag itself is reset to `false` by `loadVideo` via the `.src`
    // assignment — we don't carry loop state across videos.
    this.videoPlayer.video.addEventListener('loadedmetadata', refresh);

    refresh();
    this._refreshLoopVideoVisibility = () => this._applyLoopVideoVisibility(menuItem, chip, refresh);
    this._refreshLoopVideoVisibility();

    // Expose the toggle so the keyboard handler can reach it without
    // duplicating the state-sync logic.
    this._toggleVideoLoop = toggle;
  }

  /**
   * Hide the Loop video menu item + chip while a phone is driving
   * playback. Loop only makes sense for the desktop-driven timeline —
   * the phone's <video> doesn't mirror the loop flag, so leaving the
   * control enabled would desync the device (which follows desktop
   * time) from the phone's video. If loop happens to be on when the
   * remote takes over, force it off so the device doesn't keep looping
   * the desktop's timeline while the phone plays straight through.
   */
  _applyLoopVideoVisibility(menuItem, chip, refresh) {
    const suppressed = !!this._remoteActive;
    menuItem.hidden = suppressed;
    if (suppressed && this.videoPlayer.video.loop) {
      this.videoPlayer.video.loop = false;
      refresh();
    } else if (!suppressed) {
      // Chip visibility is owned by `refresh` (mirrors video.loop);
      // re-running it covers both "remote just disconnected" and the
      // initial paint.
      refresh();
    } else {
      // Suppressed AND loop is off — just make sure the chip is hidden.
      chip.hidden = true;
    }
  }

  _wireGapSkipUI() {
    const overlay = document.getElementById('gap-skip-overlay');
    const btnSkip = document.getElementById('gap-skip-btn');
    const btnCancel = document.getElementById('gap-skip-cancel');
    if (!overlay || !btnSkip) return;

    // Load settings
    const gapSettings = this.settings.get('player.gapSkip') || {};
    this.gapSkipEngine.setSettings(gapSettings.mode || 'off', gapSettings.threshold || 10000);
    this._applyFillerSettings();

    // Wire overlay callbacks
    const gapSkipLabel = (gapType) => gapType === 'leading' ? t('gapSkip.skipToAction')
      : gapType === 'trailing' ? t('gapSkip.skipToEnd')
      : t('gapSkip.skipToNextAction');

    this.gapSkipEngine.onShowOverlay = (gap, countdown, gapType) => {
      overlay.hidden = false;
      const label = gapSkipLabel(gapType);

      if (countdown !== null) {
        btnSkip.textContent = t('gapSkip.countdown', { label, seconds: countdown });
        btnCancel.hidden = false;
      } else {
        btnSkip.textContent = label;
        btnCancel.hidden = true;
      }
    };

    this.gapSkipEngine.onHideOverlay = () => {
      overlay.hidden = true;
    };

    this.gapSkipEngine.onCountdownTick = (remaining) => {
      const label = gapSkipLabel(this.gapSkipEngine._currentGapType || 'mid');
      btnSkip.textContent = remaining > 0
        ? t('gapSkip.countdown', { label, seconds: remaining })
        : t('gapSkip.skipping');
    };

    // A language switch while the button shows (FT-065): setLocale's walk
    // puts the button's boot key back (its data-i18n), and in button mode
    // (no countdown) nothing redrew it until the next gap. Redraw it from the
    // engine's state, after the walk (V69).
    const renderGapSkipLabel = () => {
      if (overlay.hidden) return;
      const eng = this.gapSkipEngine;
      const label = gapSkipLabel(eng._currentGapType || 'mid');
      if (eng._countdownTimer) {
        btnSkip.textContent = eng._countdownRemaining > 0
          ? t('gapSkip.countdown', { label, seconds: eng._countdownRemaining })
          : t('gapSkip.skipping');
      } else {
        btnSkip.textContent = label;
      }
    };
    eventBus.on('language:changed', renderGapSkipLabel);

    this.gapSkipEngine.onSkipped = (skippedMs) => {
      const sec = Math.round(Math.abs(skippedMs) / 1000);
      const container = document.createElement('div');
      container.className = 'update-toast';
      const text = document.createElement('span');
      text.textContent = skippedMs > 0
        ? t('toast.gapSkippedForward', { sec })
        : t('toast.gapSkippedBack', { sec });
      container.appendChild(text);
      const undoBtn = document.createElement('button');
      undoBtn.className = 'update-toast__btn';
      undoBtn.textContent = t('toast.undo');
      undoBtn.addEventListener('click', () => this.gapSkipEngine.undo());
      container.appendChild(undoBtn);
      showToast(container, 'info', 4000);
    };

    // Wire buttons
    btnSkip.addEventListener('click', () => this.gapSkipEngine.skipToNextAction());
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        this.gapSkipEngine._clearCountdown();
        this.gapSkipEngine._hideOverlay();
        this.gapSkipEngine._currentGap = null;
      });
    }
  }

  _startGapSkip() {
    if (!this.gapSkipEngine) return;

    // Clean up any pending deferred listener
    if (this._gapSkipMetaListener) {
      this.videoPlayer.video.removeEventListener('loadedmetadata', this._gapSkipMetaListener);
      this._gapSkipMetaListener = null;
    }

    // If video duration isn't available yet, defer until loadedmetadata
    if (!isFinite(this.videoPlayer.duration) || this.videoPlayer.duration <= 0) {
      this._gapSkipMetaListener = () => {
        this._gapSkipMetaListener = null;
        this._startGapSkip();
      };
      this.videoPlayer.video.addEventListener('loadedmetadata', this._gapSkipMetaListener, { once: true });
      return;
    }

    this.gapSkipEngine.loadGaps();
    this.progressBar.setGaps(this.gapSkipEngine.gaps);
    this.gapSkipEngine.start();

    // Filler needs the same two preconditions this method already waits for:
    // a loaded script and a known duration (leading and trailing gaps are
    // undefined without it). Rebuilding here rather than at load time means
    // it inherits the loadedmetadata deferral above for free.
    this._applyFillerSettings();
  }

  _stopGapSkip() {
    if (!this.gapSkipEngine) return;
    this.gapSkipEngine.stop();
    this.progressBar.setGaps(null);
  }

  _wireUpNextUI() {
    const cardEl = document.getElementById('up-next-card');
    if (!cardEl) return;

    // Apply persisted settings.
    const cfg = this.settings.get('player.upNext') || {};
    this.upNextEngine.setSettings(cfg.mode || 'auto', cfg.countdownSec || 10);

    // The card needs library-keyed metadata + a thumbnail. Cache-first
    // (instant for any video the library has already painted) → backend
    // ffmpeg (cheap, on-disk cached by content hash) → null skeleton.
    // Falls back gracefully when the library hasn't initialized yet.
    this.upNextCard = new UpNextCard({
      element: cardEl,
      library: this.library || null,
      captureFrame: (path) => this._captureUpNextThumb(path),
      onPlayNext: () => this.upNextEngine.playNext(),
      onDismiss: () => this.upNextEngine.dismiss(),
      onHoverEnter: () => this.upNextEngine.pauseCountdown(),
      onHoverLeave: () => this.upNextEngine.resumeCountdown(),
      onBackToSource: (sourceContext) => this._upNextBackToSource(sourceContext),
      getResumeChoice: (path) => this._upNextResumeChoice(path),
      onStartOver: () => {
        this._upNextStartOver = true;
        this.upNextEngine.playNext();
      },
    });

    // Engine → card + queue panel chip. With the queue open the card sits
    // left of the panel (up-next.css, R4-03) and the chip carries the same
    // "in Ns + ×" affordance on the row that plays next. Both consumers
    // subscribe to the same engine — no duplicate tickers.
    this.upNextEngine.onShowNext = (path, countdownSec) => {
      this.upNextCard.show(path, countdownSec);
      // Subtitles lifted above the bar go above the card too (R4 fix-up).
      this.videoPlayer?.refreshCuePlacement?.();
      this._upNextCurrentPath = path;
      this.queuePanel?.setAutoAdvanceCountdown(path, countdownSec);
      // Up Next supersedes gap-skip's trailing overlay (SCOPE §3.4).
      const gapEl = document.getElementById('gap-skip-overlay');
      if (gapEl) gapEl.hidden = true;
      this._relayUpNextShow(path, countdownSec); // mirror into the pop-out
    };
    this.upNextEngine.onShowEndOfList = (_engineLabel, sourceContext) => {
      // The card names the list by its own name (CB-13), not the context's
      // label ('playlist "X"', 'library', a Play All's bare name).
      const sourceLabel = this._upNextListName(this._currentPlayContext);
      this.upNextCard.showEndOfList(sourceLabel, sourceContext);
      this.videoPlayer?.refreshCuePlacement?.();
      this._relayUpNext({ action: 'end', sourceLabel });
    };
    this.upNextEngine.onTick = (remaining) => {
      this.upNextCard.tick(remaining);
      if (this._upNextCurrentPath) {
        this.queuePanel?.setAutoAdvanceCountdown(this._upNextCurrentPath, remaining);
      }
      this._relayUpNext({ action: 'tick', remaining });
    };
    this.upNextEngine.onHide = () => {
      this.upNextCard.hide();
      this.videoPlayer?.refreshCuePlacement?.();
      this._upNextCurrentPath = null;
      this.queuePanel?.clearAutoAdvance();
      this._relayUpNext({ action: 'hide' });
    };
    this.upNextEngine.onPlayNext = (path) => {
      // Stamp the advance so the pop-out end-handler knows Up Next consumed
      // this end and doesn't also run the Play-All queue advance. A timestamp
      // (not a boolean) survives the onPlayNext→stray-'ended' IPC race.
      this._lastUpNextAdvanceAt = Date.now();
      this._playUpNext(path);
    };
    // Your own queue (foobar2000-style insert) plays before the context's
    // next, so it IS the real next-up — the engine targets its head for the
    // countdown card + queue-panel chip. `_playUpNext` already honors this
    // priority on advance; this keeps the display in agreement.
    this.upNextEngine.getPriorityNext = () => (
      this._userQueue && this._userQueue.length > 0 ? this._userQueue[0] : null
    );

    // Video events → engine.check(). The engine is idempotent, so it's
    // safe to fire on every event — show/hide transitions are
    // edge-triggered internally. We re-read suppression state on every
    // tick so A-B loop / video.loop changes are honored without needing
    // a separate event hook into the player.
    const checkFn = () => {
      this._syncUpNextSuppression();
      this.upNextEngine.check();
    };
    this.videoPlayer.video.addEventListener('timeupdate', checkFn);
    this.videoPlayer.video.addEventListener('seeked', checkFn);
    this.videoPlayer.video.addEventListener('loadedmetadata', checkFn);
    this.videoPlayer.video.addEventListener('play', checkFn);
    this.videoPlayer.video.addEventListener('pause', checkFn);
    // `ended` is the safety net — when the video finishes naturally the
    // 200 ms tick may not have fired yet, and the queued `pause` would
    // freeze the countdown. Fire next immediately if the card is up.
    // Through playNext (not _playUpNext directly) so the engine's one-shot
    // guard knows this video's advance is spoken for (V18).
    this.videoPlayer.video.addEventListener('ended', () => {
      if (this.upNextEngine.visible && !this.upNextEngine.endOfListShown) {
        this.upNextEngine.playNext();
      }
    });
  }

  /**
   * Sync editor / loop suppression state into the engine. Call after any
   * change to A-B loop, video.loop, or scriptEditor.isOpen.
   */
  _syncUpNextSuppression() {
    if (!this.upNextEngine) return;
    const editorOpen = !!this.scriptEditor?.isOpen;
    // Detached: the pop-out's <video> is the one playing, and its loop flag
    // arrives on every TIME_TICK (_popoutLoop). The inline element is paused
    // and hidden; reading ITS loop (off) here, from an inline event, used to
    // cancel the pop-out's loop, so a looping video advanced at its end (V13).
    if (this._playerWindowActive) {
      this.upNextEngine.setSuppressed(editorOpen || this._popoutLoop === true);
      return;
    }
    const ab = this.videoPlayer?._abLoop;
    const abLoopActive = (ab && ab.a !== null && ab.b !== null)
      || this.videoPlayer?.video?.loop === true;
    this.upNextEngine.setSuppressed(editorOpen || abLoopActive);
  }

  _setUpNextContext(playContext) {
    if (!this.upNextEngine) return;
    this.upNextEngine.setPlayContext(playContext || null);
    this._syncUpNextSuppression();
  }

  /**
   * UpNextEngine.canOfferAfterEnd (R4-01): the full player view is on screen
   * in this window. Not the mini player (the library is what the user is
   * looking at), not the pop-out, not another view.
   */
  _upNextMayOfferAfterEnd() {
    return this._currentView?.() === 'player' && !this._miniActive && !this._playerWindowActive;
  }

  /**
   * The name the End-of-list card gives the list that ended (CB-13): the
   * playlist's or category's own name as it is now (renamed since is fine),
   * the Library for a library list, the Library header's title for its
   * Shuffle All; null when there is no name to give, and the card says
   * "this list". The context's own `sourceLabel` is not a name: a card
   * click labels it 'playlist "X"' / 'category "X"' and a library click
   * 'library', in English, and the old sentence "No more videos in this
   * {source}." wanted a kind word, so a Play All's bare name read "No more
   * videos in this FT034 Two."
   */
  _upNextListName(ctx) {
    if (!ctx) return null;
    const sc = ctx.sourceContext || {};
    const playlistId = sc.playlistId || (sc.kind === 'playlist' ? sc.id : null);
    const categoryId = sc.categoryId || (sc.kind === 'category' ? sc.id : null);
    const named = playlistId
      ? (this.settings?.getPlaylist?.(playlistId)?.name || this.playlists?.playlistName?.(playlistId))
      : categoryId
        ? (this.settings?.getCategories?.() || []).find((c) => c.id === categoryId)?.name
        : null;
    if (named) return named;
    if (sc.kind === 'library-shuffle') return ctx.sourceLabel || t('nav.library');
    if (ctx.source === 'library') return t('nav.library');
    return null;
  }

  /**
   * Sources changed while the Library view is not open (CB-26): rescan the
   * library without showing it, so the library's list, Up Next and the
   * phone and VR (`ensureScanned` re-registers with the backend) all lose a
   * removed or switched-off source's videos now, not when the Library view
   * next opens. Nothing is rendered: `ensureScanned` only reads.
   *
   * The same scan the Library view runs, so the same absence rules: a
   * removed source is not evidence that anything is gone, and nothing
   * stored per video (associations, variants, resume, categories) is
   * pruned for it (`_applyManualAssociations`, `_safeToPrune`).
   *
   * Serialised: one scan at a time, and changes made while one runs fold
   * into a single follow-up that reads the sources as they are then. With
   * no source left switched on the library empties (R3-12; it kept its list
   * before); with sources on but all offline it keeps its list.
   */
  _rescanLibraryInBackground() {
    const lib = this.library;
    if (typeof lib?.ensureScanned !== 'function') return Promise.resolve();
    if (this._bgRescanQueued) return this._bgRescan; // the queued one reads the newest sources
    this._bgRescanQueued = true;
    const run = async () => {
      this._bgRescanQueued = false;
      // What the Library view's show() keys its "already scanned" check on,
      // read from the same settings ensureScanned reads, before it awaits.
      const unavailable = lib._unavailablePaths || new Set();
      const key = (this.settings?.get?.('library.sources') || [])
        .filter((s) => s?.path && s.enabled !== false && !unavailable.has(s.path))
        .map((s) => s.path)
        .sort()
        .join('\0');
      if (!key) {
        // No source switched on at all (the last one removed or switched off):
        // ensureScanned empties the library and the phone / VR list, pruning
        // nothing (R3-12). They used to keep the old videos for the session.
        // Sources that are on but all offline keep the list, as before.
        const anyOn = (this.settings?.get?.('library.sources') || [])
          .some((s) => s?.path && s.enabled !== false);
        if (!anyOn) {
          await lib.ensureScanned({ forceRescan: true });
          this.upNextEngine?.refresh?.();
        }
        return;
      }
      await lib.ensureScanned({ forceRescan: true });
      // The Library view, opened later, shows this scan instead of repeating it.
      if (!this._bgRescanQueued && lib._lastScanKey == null) lib._lastScanKey = key;
      this.upNextEngine?.refresh?.();
    };
    this._bgRescan = Promise.resolve(this._bgRescan)
      .catch(() => {})
      .then(run)
      .catch((err) => console.warn('[Library] background rescan after a source change failed:', err?.message || err));
    return this._bgRescan;
  }

  /**
   * Can Up Next offer `path` from a play context? The library must hold it,
   * AND it must sit under a source that is configured and switched on right
   * now (FT-018). The library's list is only re-read by a scan, and removing
   * or switching off a source from the Playlists or Categories view does not
   * scan until the Library view opens, so until then the removed source's
   * videos are still "held" and Up Next named and played them. Unknown counts
   * as playable: an unscanned library, or no source list to check against.
   * A library EMPTIED because no source is switched on any more is not
   * unknown (R3-12, `Library._forgetVideosNoSource`): nothing is offered, as
   * the old list's videos were not before it was emptied (FT-018).
   */
  _isUpNextPlayable(path) {
    const lib = this.library;
    if (!lib || typeof lib.getVideoByPath !== 'function') return true;
    if (lib._emptiedNoSource) return false;
    if (!lib._videos || lib._videos.length === 0) return true;
    return !!lib.getVideoByPath(path) && this._isUnderEnabledSource(path);
  }

  /**
   * Is `path` inside a source that is configured and enabled now? Compared
   * without case: a stray case difference between a source as typed and a
   * scanned path must not make a real video unplayable (that silently kills
   * the card); the cost is only that a removed source differing from a kept
   * one by case alone stays offered until the next scan, as before FT-018.
   */
  _isUnderEnabledSource(path) {
    const sources = this.settings?.get?.('library.sources');
    if (!Array.isArray(sources)) return true; // nothing to check against
    const target = canonicalPath(path).toLowerCase();
    return sources.some((s) => {
      if (!s?.path || s.enabled === false) return false;
      const root = canonicalPath(s.path).toLowerCase();
      return !!root && (target === root || isSubpath(target, root));
    });
  }

  /**
   * UpNextEngine.resolveNext: the app's answer to "what plays after this"
   * for a context whose advance the app owns. A Play All queue (CB-10): the
   * card, its countdown, the queue's `ended` advance and Next all play
   * `_nextQueueStep`, so what the card names is what plays. A shuffled,
   * looping playlist context at its wrap (R3-14): the first video of the
   * next cycle's order, drawn once (`_reshuffleContextForWrap`) and played by
   * `_playUpNextInner`; the card used to name the OLD order's first entry
   * while the advance drew a new order and played its first. Anything else
   * stays the engine's own list walk (undefined).
   */
  _resolveUpNext(ctx) {
    if (ctx?.source !== 'queue') return this._reshuffleContextForWrap(ctx)?.path;
    return this._nextQueueStep({ from: ctx.index ?? this._playQueueIndex })?.path ?? null;
  }

  /**
   * What a Play All queue plays after slot `from` (CB-10): the first later
   * slot Up Next may offer (`_isUpNextPlayable`: the library holds it and a
   * source that is on holds it), else, when the queue loops, the first such
   * slot of the next cycle's order (`_queueWrapOrder`). The ONE decision for
   * the queue. Before it the card skipped a removed source's videos and the
   * queue's advances played them anyway (slot index+1, whatever it held).
   * Nothing is removed from the queue: a skipped slot stays where it is.
   *
   * @returns {{ index: number, path: string, wrap: boolean } | null}
   *   `index` is in the CURRENT queue, or, when `wrap`, in the next cycle's
   *   order, which `_reshuffleQueueForWrap` makes the queue before playing.
   */
  _nextQueueStep({ from = this._playQueueIndex, loop = !!this._playQueueLoop } = {}) {
    const queue = Array.isArray(this._playQueue) ? this._playQueue : [];
    const pathOf = (entry) => entry?.path || entry;
    for (let i = (from ?? -1) + 1; i < queue.length; i++) {
      const path = pathOf(queue[i]);
      if (path && this._isUpNextPlayable(path)) return { index: i, path, wrap: false };
    }
    if (!loop || queue.length === 0) return null;
    const order = this._queueWrapOrder();
    for (let i = 0; i < order.length; i++) {
      const path = pathOf(order[i]);
      if (path && this._isUpNextPlayable(path)) return { index: i, path, wrap: true };
    }
    return null;
  }

  /**
   * The order the queue's next loop cycle plays: the queue itself, or, when
   * shuffled, a fresh order (V28) decided ONCE per cycle end and kept until
   * the wrap uses it, so the card that names the wrap's first video and the
   * wrap that plays it read the same draw (CB-10). Reset when the queue or
   * its position changes.
   */
  _queueWrapOrder() {
    const queue = Array.isArray(this._playQueue) ? this._playQueue : [];
    if (!this._playQueueShuffle || queue.length < 2) return queue;
    const memo = this._pendingWrapOrder;
    if (memo && memo.queue === queue && memo.index === this._playQueueIndex) return memo.order;
    const order = this._wrapOrder(
      queue,
      this._playQueueBalance ? (this._playQueueFullList || queue) : null,
      queue[this._playQueueIndex],
    );
    this._pendingWrapOrder = { queue, index: this._playQueueIndex, order };
    return order;
  }

  /**
   * Auto-advance triggered when the countdown reaches zero or the user
   * clicks Play. Looks the path up in the current library catalog and
   * routes through library._playVideo so all the existing wiring
   * (funscript, subtitles, variants, multi-axis) runs the same way as
   * a manual library click. Snapshot context is forwarded with index+1
   * via `_playContextOverride` (per SCOPE §3.5 immutability).
   */
  async _playUpNext(path, skipped = 0) {
    if (!path) return;
    // Mark this whole advance as an auto-advance so the downstream load paths
    // keep the mini-player docked instead of expanding to the full player.
    // try/finally keeps the flag set across the async load (during which the
    // navigate decision in _playFromLibrary reads it), then always clears it.
    const prevAuto = this._autoAdvancing;
    this._autoAdvancing = true;
    try {
      return await this._playUpNextInner(path, skipped);
    } finally {
      this._autoAdvancing = prevAuto || false;
    }
  }

  /**
   * @param {string} path  the video Up Next chose
   * @param {number} [skipped]  missing entries this advance has already
   *   walked past (see the missing-file walk below); 0 from the engine
   */
  async _playUpNextInner(path, skipped = 0) {
    // Unsaved editor edits are asked about FIRST, before anything below moves
    // (R3-10). The user queue's head used to come off the queue (and be
    // saved), and a shuffled wrap drew its new order, before the load asked,
    // so Cancel dropped the queued video. Cancel now leaves the queue, history
    // and order as they were, and `_editorAllowsReplace` re-arms Up Next for
    // the next end (round 2). The loads below ask again and get `true` at once.
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true && !(await editorOk)) return;
    // Play All's `ended` already started a video from your queue for this
    // video (it took the queue's head, so the context's next would play on
    // top of it): that load is the advance (R3-15 fix-up).
    const jump = this._queueJumpPending;
    if (jump && jump.gen === this._videoLoadGen) return;
    // User queue priority — if the panel's user queue has items, play
    // the head before falling through to library / playlist context.
    // Mirrors foobar2000's queue priority insert (SCOPE §3.2 #3).
    if (this._userQueue && this._userQueue.length > 0) {
      // An unattended advance like any other: "Auto-play the next video"
      // decides (CB-11; it returned here before the arming below, so a
      // queued video always loaded paused). `_jumpToVideoFromQueue` takes it
      // off the queue once it really plays (R3-10).
      return this._jumpToVideoFromQueue(this._userQueue[0], { autoPlay: this._autoplayOnAdvance() });
    }
    // Queue source: advance through the queue mechanism so prev/next
    // buttons + queue indicator stay live and `_playFromLibrary`'s queue
    // reset doesn't tear down the Play All session mid-stream. What plays is
    // `_nextQueueStep`, the decision the card named (CB-10): this used to
    // play slot index+1 whatever it held, so with a source removed the card
    // said Channels Clip and the removed source's Bulk 003 played.
    if (this._currentPlayContext?.source === 'queue') {
      const step = this._nextQueueStep({ from: this._currentPlayContext.index ?? this._playQueueIndex });
      if (!step) return;
      if (step.wrap) this._reshuffleQueueForWrap();
      return this._playQueueItem(step.index);
    }
    if (!this.library) return;
    // A shuffled playlist context (a card click or Continue with Shuffle on)
    // starts its next cycle in a fresh order, as Play All's queue does: the
    // first entry of that order the library has, preferring one that is not
    // the video that just ended. The SAME draw the card named
    // (`_reshuffleContextForWrap` via `_resolveUpNext`, R3-14). Nothing found
    // falls through to the engine's own pick and the missing-file walk below.
    let ctx = this._currentPlayContext;
    let nextIndex = null;
    const wrap = this._reshuffleContextForWrap(ctx);
    if (wrap) {
      ctx = wrap.ctx;
      path = wrap.path;
      nextIndex = wrap.index;
      this._pendingContextWrap = null; // used: the next cycle end draws again
    }
    const video = this.library.getVideoByPath?.(path);
    if (!video) {
      // File missing from current library scan — try to walk past it.
      //
      // At most one pass over the context. With nothing scanned yet, or every
      // source disabled or offline, `isPlayable` reports every path playable
      // (unknown counts as playable) while `getVideoByPath` finds none. A
      // looping context then wraps forever: advancePastMissing never returns
      // null, and this recursed until "Maximum call stack size exceeded",
      // with no toast and nothing played. A playlist card or Continue reached
      // it once V29 let those contexts carry `loop`. A count, not a set of
      // tried paths, so a list holding the same missing file twice still
      // walks on to what follows it.
      const listLength = this._currentPlayContext?.list?.length || 0;
      const next = skipped < listLength ? this.upNextEngine.advancePastMissing() : null;
      if (next) return this._playUpNext(next, skipped + 1);
      showToast(t('toast.nextNotFound'), 'warn', 3000);
      return;
    }
    if (ctx) {
      video._playContextOverride = {
        ...ctx,
        index: nextIndex ?? this._contextIndexOfNext(ctx, path),
      };
    }
    // When the user opts in, an Up Next-triggered advance auto-plays
    // the next video instead of loading it paused. Default is off so
    // existing behaviour is preserved for everyone who didn't ask.
    // (Queue / Play All already auto-plays via _playQueueItem's default
    // autoPlay:true, so this flag only matters for library / playlist /
    // category sources that route through _playFromLibrary.)
    if (this._autoplayOnAdvance()) {
      video._autoPlayOnNextLoad = true;
    }
    await this.library._playVideo(video);
  }

  /** "Auto-play the next video" (Settings > Playback), for unattended advances. */
  _autoplayOnAdvance() {
    return !!this.settings?.get?.('player.autoplayOnAdvance');
  }

  /**
   * Where `path` sits in the context's list, for the context the advanced-to
   * video carries forward. The engine picked `path` itself (`_nextPath`):
   * the first playable entry after the current one, or, for a looping
   * context, wrapped round from the top. So search forward first, then from
   * the top when the context loops, the same order the engine walked.
   *
   * It used to be `index + 1`, which is right only when nothing was skipped
   * and nothing wrapped. A looping playlist wrapped to item 1 with an index
   * past the end, so the card after it proposed item 1 again, forever (V29),
   * and a skipped stale entry left the index pointing at the skipped one.
   * Falls back to `index + 1` for a path that is not in the list.
   */
  _contextIndexOfNext(ctx, path) {
    const list = Array.isArray(ctx?.list) ? ctx.list : [];
    const from = (ctx?.index || 0) + 1;
    for (let i = from; i < list.length; i++) {
      if (list[i] === path) return i;
    }
    if (ctx?.loop) {
      for (let i = 0; i < Math.min(from, list.length); i++) {
        if (list[i] === path) return i;
      }
    }
    return from;
  }

  // --- Queue panel (SCOPE-queue-panel.md) ---

  /**
   * Initialise the queue panel component, hydrate user queue from
   * settings, subscribe to relevant events. Called once during boot
   * after library / dataService are ready.
   */
  _initQueuePanel() {
    const el = document.getElementById('queue-panel');
    if (!el) return;

    // Hydrate the persistent user queue. Broken-path pruning happens
    // lazily on first surface — we don't want to block boot on
    // fileExists() calls for an arbitrary number of stored entries.
    this._userQueue = (this.settings?.get?.('player.userQueue') || []).filter(
      (p) => typeof p === 'string' && p.length > 0,
    );

    this.queuePanel = new QueuePanel({
      element: el,
      library: this.library,
      settings: this.settings,
      getEmbeddedAxes: (fp) => this.getEmbeddedAxes?.(fp),
      onJump: (path, where) => this._jumpFromQueuePanel(path, where), // R4-02
      onRemoveFromQueue: (path) => this._removeFromUserQueue(path),
      onReorderQueue: (fromIdx, toIdx) => this._reorderUserQueue(fromIdx, toIdx),
      onClearQueue: () => this._clearUserQueue(),
      onShuffleUpcoming: () => this._shuffleUpcoming(),
      onClose: () => this._toggleQueuePanel(),
      onOpenLibrary: () => this._navigateTo('library'),
      onCancelAutoAdvance: () => this.upNextEngine?.dismiss(),
    });

    // Live-update on library sort / filter changes. The panel's
    // upcoming section re-derives from `library._filteredVideos` each
    // render, so we just trigger a render here.
    eventBus.on('library:filtered', () => {
      if (this.queuePanel?.visible) this._updateQueuePanelState();
    });

    // Panel is closed by default each session. The user opens it
    // explicitly via the top-bar button or Shift+Q. No persistence —
    // an auto-open on launch competes with the video for attention
    // and felt intrusive in user testing.
  }

  /**
   * Resolve the "upcoming" list (next 10) from whichever context is
   * driving playback. Returns paths only; the panel resolves metadata
   * per-row via library.getVideoByPath.
   *
   * The SAME walk Up Next's card and the advances make (R4-03), so the
   * section's first row is what the card names (after your own queue, which
   * has its own section): a Play All's later slots that `_isUpNextPlayable`
   * allows, then, when nothing later is left and it loops, the next cycle's
   * order (`_queueWrapOrder`, the draw `_nextQueueStep` plays); a play
   * context's list after its entry, then its wrap (`_reshuffleContextForWrap`
   * for a shuffled one, the top of the list for a plain loop). It listed the
   * queue's raw slots and the library's LIVE filter instead, so at a shuffled
   * looping playlist's wrap the panel had no "Up next" while the card named
   * the next video, a removed source's slot showed first, and a playlist
   * card's context showed none at all.
   *
   * Each row's place is kept in `_upcomingSteps`, for a click on it (R4-02).
   *
   * @returns {{ items: string[], hasContext: boolean }}
   */
  _getUpcoming() {
    const MAX = 10;
    const steps = [];
    const queue = Array.isArray(this._playQueue) ? this._playQueue : [];
    const ctx = this._currentPlayContext;
    const pathOf = (entry) => entry?.path || entry;
    const offer = (path) => !!path && this._isUpNextPlayable(path);
    let hasContext = false;
    if (queue.length > 0) {
      // Play All / queue source.
      hasContext = true;
      for (let i = (this._playQueueIndex ?? -1) + 1; i < queue.length && steps.length < MAX; i++) {
        const path = pathOf(queue[i]);
        if (offer(path)) steps.push({ path, queueIndex: i, wrap: false });
      }
      if (steps.length === 0 && this._playQueueLoop) {
        const order = this._queueWrapOrder();
        for (let i = 0; i < order.length && steps.length < MAX; i++) {
          const path = pathOf(order[i]);
          if (offer(path)) steps.push({ path, queueIndex: i, wrap: true });
        }
      }
    } else if (ctx && ctx.source !== 'queue' && Array.isArray(ctx.list)) {
      // Library / playlist / category context: its snapshot list, which is
      // what plays (sort or filter changes since do not move "next").
      hasContext = true;
      const at = ctx.index ?? -1;
      for (let i = at + 1; i < ctx.list.length && steps.length < MAX; i++) {
        if (offer(ctx.list[i])) steps.push({ path: ctx.list[i], ctxIndex: i });
      }
      if (steps.length === 0 && ctx.loop) {
        const wrap = this._reshuffleContextForWrap(ctx);
        const list = wrap ? wrap.ctx.list : ctx.list;
        const from = wrap ? wrap.index : 0;
        const to = wrap ? list.length : Math.min(at + 1, list.length);
        for (let i = from; i < to && steps.length < MAX; i++) {
          if (offer(list[i])) steps.push({ path: list[i], ctxIndex: i, wrapCtx: wrap ? wrap.ctx : null });
        }
      }
    }
    this._upcomingSteps = steps;
    // Drag-drop / Browse / Open Recent: no context.
    return { items: steps.map((s) => s.path), hasContext };
  }

  /**
   * A click (or Enter) on a queue-panel row (R4-02). An "Up next" row plays
   * where the advances would reach it (`_upcomingSteps`): inside the Play All
   * (`_playQueueItem`, so the Play All goes on from there), or inside the
   * play context (the same list, moved on). It loaded as a library click,
   * which ended the Play All (`_playFromLibrary` clears the queue). Rows of
   * your own queue, History and Now playing go on as before
   * (`_jumpToVideoFromQueue`). Unsaved editor edits are asked about first,
   * before a wrap draws or uses anything; Cancel changes nothing.
   */
  async _jumpFromQueuePanel(path, where = null) {
    const step = where?.kind === 'upcoming' ? this._upcomingSteps?.[where.idx] : null;
    if (!step || step.path !== path || !this.library) return this._jumpToVideoFromQueue(path);
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true && !(await editorOk)) return undefined;
    if (step.queueIndex != null) {
      if (step.wrap) this._reshuffleQueueForWrap();
      // The slot must still hold the clicked video, a wrap row's too (C-07):
      // if the queue or its position moved while the question was open, the
      // card's memo no longer matched, a fresh order was drawn, and another
      // video played than the one clicked.
      if (this._playQueue?.[step.queueIndex]?.path !== path) {
        return this._jumpToVideoFromQueue(path); // the queue changed under the click
      }
      return this._playQueueItem(step.queueIndex);
    }
    const ctx = step.wrapCtx || this._currentPlayContext;
    const video = this.library.getVideoByPath?.(path);
    if (!video || !Array.isArray(ctx?.list) || ctx.list[step.ctxIndex] !== path) {
      return this._jumpToVideoFromQueue(path);
    }
    if (step.wrapCtx) this._pendingContextWrap = null; // used: the next cycle end draws again
    video._playContextOverride = { ...ctx, index: step.ctxIndex };
    return this.library._playVideo(video);
  }

  /**
   * Recompute panel state from current data and push to the component.
   * Cheap — called on every state-changing event.
   */
  _updateQueuePanelState() {
    if (!this.queuePanel) return;
    const upcoming = this._getUpcoming();
    this.queuePanel.setState({
      history: this._queueHistory,
      nowPlaying: this._currentVideoPath || null,
      userQueue: [...this._userQueue],
      upcoming: upcoming.items,
      hasContext: upcoming.hasContext || !!this._currentVideoPath,
    });
  }

  /**
   * Shuffle the not-yet-played "Up next" tail from the queue panel.
   * History and the currently-playing item stay put — only what comes
   * next is re-rolled. Handles both drivers of the upcoming list:
   *   1. An explicit Play-All / playlist / shuffle queue (`_playQueue`) —
   *      shuffle the slice after the current index in place.
   *   2. A passive library-browse context — materialise an explicit
   *      shuffled queue from the current filtered list (current stays at
   *      the head) so "up next" becomes random without reloading the
   *      video that's already playing.
   * @returns {boolean} true if something was shuffled.
   */
  _shuffleUpcoming() {
    // Case 1 — explicit queue is active.
    if (this._playQueue && this._playQueue.length > 1) {
      const idx = (this._playQueueIndex ?? -1) + 1;
      if (idx >= this._playQueue.length) return false; // nothing upcoming
      const tail = shuffleArray(this._playQueue.slice(idx));
      this._playQueue = [...this._playQueue.slice(0, idx), ...tail];
      this._playQueueShuffle = true;
      if (this._currentPlayContext) {
        this._currentPlayContext.list = this._playQueue.map((v) => v.path);
        this._setUpNextContext(this._currentPlayContext);
      }
      this._updateQueueUI();
      this._updateQueuePanelState();
      return true;
    }

    // Case 2 — passive library context: build a queue from the filtered
    // list with the current video pinned to the head.
    if (this._currentPlayContext?.source === 'library'
        && this.library?._filteredVideos?.length > 1
        && this._currentVideoPath) {
      const filtered = this.library._filteredVideos;
      const curIdx = filtered.findIndex((v) => v?.path === this._currentVideoPath);
      if (curIdx < 0) return false;
      const toEntry = (v) => ({
        name: v.name || (v.path ? v.path.split(/[\\/]/).pop() : ''),
        path: v.path,
        funscriptPath: v.funscriptPath || null,
      });
      // The Library's play options (#381), through Play All's own order, so
      // this and the header's Shuffle All build the same queue and cannot
      // drift. All off (the default), `_playAllOrder` is a plain shuffle of
      // the rest: the queue this always built.
      const opts = { shuffle: true, ...libraryPlayRequest(this.settings) };
      const all = filtered.map(toEntry);
      const start = all[curIdx];
      // With Equal turn on, the playing video takes its script group's slot,
      // as a shuffled playlist start does (`_withShuffledStart`), and the
      // WHOLE list is kept for the loop-wrap redraw, as `_playAll` keeps it,
      // so each cycle can pick a different video for a shared script.
      const startKey = opts.balanceByScript ? this._scriptKeyOf(start) : null;
      const rest = all.filter((v, i) => i !== curIdx && !(startKey && this._scriptKeyOf(v) === startKey));
      this._playQueue = [start, ...this._playAllOrder(rest, opts)];
      this._playQueueFullList = all;
      this._playQueueIndex = 0;
      this._playQueueShuffle = true;
      this._playQueueBalance = !!opts.balanceByScript;
      this._playQueueLoop = !!opts.loop;
      this._playQueueSource = {
        sourceLabel: this.library._headerTitle || t('nav.library'),
        sourceContext: { kind: 'library-shuffle' },
      };
      this._currentPlayContext = {
        source: 'queue',
        sourceLabel: this._playQueueSource.sourceLabel,
        sourceContext: this._playQueueSource.sourceContext,
        list: this._playQueue.map((v) => v.path),
        index: 0,
        loop: !!this._playQueueLoop,
      };
      this._setUpNextContext(this._currentPlayContext);
      this._updateQueueUI();
      this._updateQueuePanelState();
      return true;
    }

    return false;
  }

  /**
   * Show / hide the panel. History resets on close per SCOPE §3.5.
   * Panel open/closed state is intentionally session-only — not
   * persisted to settings (see _initQueuePanel comment).
   */
  /**
   * In a browse view (library, playlists, categories) the queue panel starts
   * below the view's header (so its controls stay usable) and runs to the
   * bottom of the window. The header height isn't fixed, so measure its
   * bottom edge (viewport-relative — the panel's containing block is the
   * viewport) into a CSS var the browse-view rule reads. In the player the
   * var is dropped and the player rule keeps the default top:0 /
   * above-controls layout.
   *
   * Library-only until V27: in Playlists and Categories (Shift+Q works in
   * every view) the panel sat at top:0 over the nav bar and stopped 100px
   * short of the window bottom, the player's layout.
   */
  _positionQueuePanelForView() {
    const panel = document.getElementById('queue-panel');
    if (!panel) return;
    const headerSelector = {
      library: '#library-container .library__header',
      playlists: '#playlists-container .playlists__header',
      categories: '#categories-container .categories__header',
    }[this._currentView()];
    if (!headerSelector) {
      panel.style.removeProperty('--queue-lib-top');
      return;
    }
    const header = document.querySelector(headerSelector);
    if (!header) return;
    const top = Math.max(0, Math.round(header.getBoundingClientRect().bottom));
    panel.style.setProperty('--queue-lib-top', `${top}px`);
  }

  _toggleQueuePanel() {
    if (!this.queuePanel) return;
    const opening = !this.queuePanel.visible;
    if (opening) {
      this._updateQueuePanelState();
      this._positionQueuePanelForView();
      this.queuePanel.open();
    } else {
      // History resets on close. Re-render is implicit because the
      // panel won't redraw while hidden.
      this._queueHistory = [];
      this.queuePanel.close();
    }
    this._syncQueueToggles();
  }

  /**
   * Sync every queue toggle's aria-pressed + aria-expanded with the panel.
   * The CSS uses [aria-pressed="true"] to slide the player's button left by
   * the panel width so it lands flush with the panel's left edge. Header
   * toggles (Library, Playlists, Categories) carry `data-queue-toggle`, and
   * ALL of them are synced: the old code took the first `.library__queue-toggle`
   * only (V26).
   */
  _syncQueueToggles() {
    const open = String(!!this.queuePanel?.visible);
    const buttons = [
      document.getElementById('btn-queue-toggle'),        // player top-bar
      ...document.querySelectorAll('[data-queue-toggle]'), // view headers
    ];
    for (const btn of buttons) {
      if (btn) {
        btn.setAttribute('aria-pressed', open);
        btn.setAttribute('aria-expanded', open);
      }
    }
  }

  /**
   * Push the current video path to history if it's been watched long
   * enough (≥ threshold). Called on video transition. Dedups by path:
   * if a video is already in history, its earlier entry is removed and
   * a new one added at the bottom (matches Spotify "Recently played"
   * semantics, SCOPE §3.5).
   */
  _maybePushCurrentToHistory() {
    if (this._queueHistoryPushedForCurrent) return;
    if (!this._currentVideoPath) return;
    const watchedMs = (this.videoPlayer?.video?.currentTime || 0) * 1000;
    if (watchedMs < this._queueHistoryThresholdMs) return;
    // Dedup
    this._queueHistory = this._queueHistory.filter((p) => p !== this._currentVideoPath);
    this._queueHistory.push(this._currentVideoPath);
    // Cap from the front
    if (this._queueHistory.length > this._queueHistoryCap) {
      this._queueHistory = this._queueHistory.slice(-this._queueHistoryCap);
    }
    this._queueHistoryPushedForCurrent = true;
  }

  /**
   * Click-to-play from anywhere in the queue panel. Pushes current to
   * history (if eligible), then routes through library._playVideo
   * which handles all the existing wiring (funscript, subtitles,
   * variants, multi-axis, etc).
   *
   * `autoPlay`: an unattended advance into the user's queue passes
   * "Auto-play the next video" (CB-11); a click on the panel does not, and
   * opens like any click (player.autoplayOnOpen).
   *
   * Asks about unsaved editor edits BEFORE anything moves (R3-10): the queued
   * video came off your queue and the video being left went into history
   * before the load asked, so Cancel dropped the queued video. Cancel now
   * leaves both as they were.
   *
   * A video from YOUR queue played during Play All is an interlude (R3-15,
   * foobar2000's queue, SCOPE §3.2 #3): Play All goes on with its next item
   * after it. It used to load as a library click, which ended the Play All
   * (`_playFromLibrary` clears the queue) and Up Next followed the library
   * instead. It carries the queue's context with `interlude`, which keeps the
   * queue, arms its `ended` advance and records nothing against the playlist.
   *
   * From the answer until its load, this jump IS the advance for the video
   * playing now (`_queueJumpPending`): the queued video comes off your queue
   * at once, but its load waits on file reads, and the other end-of-video
   * route ran meanwhile. Up Next's countdown started this jump and the
   * queue's `ended` then found your queue empty and played Play All's next
   * item too (R3-15 fix-up, real-app verifier 2: Zulu Last loaded, Variant
   * Clip 30 ms later as the interlude, the counter said 2 / 3 and N skipped
   * Zulu Last). `_advanceQueueOnEnded` and `_playUpNextInner` stand down
   * while it is pending.
   */
  async _jumpToVideoFromQueue(path, { autoPlay = false } = {}) {
    if (!path || !this.library) return;
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true && !(await editorOk)) return;
    let settled;
    const pending = { gen: this._videoLoadGen, done: new Promise((resolve) => { settled = resolve; }) };
    this._queueJumpPending = pending;
    try {
      const ctx = this._currentPlayContext;
      const interlude = (this._userQueue.includes(path) && ctx?.source === 'queue'
        && Array.isArray(this._playQueue) && this._playQueue.length > 0)
        ? { ...ctx, index: this._playQueueIndex, interlude: true }
        : null;
      this._maybePushCurrentToHistory();
      // If the jumped-to path is in the user queue, remove it (we're
      // about to play it; no point keeping a duplicate in the queue).
      const queueIdx = this._userQueue.indexOf(path);
      // FN-07: P from the queued video goes back to the one playing now,
      // however the queued one started (N, its end, Up Next, a click).
      let backEntry = null;
      if (queueIdx >= 0 && this._currentVideoPath && this._currentVideoPath !== path) {
        backEntry = { from: this._currentVideoPath, fromCtx: this._currentPlayContext || null, to: path };
        this._userQueueBack = [...(this._userQueueBack || []), backEntry].slice(-50);
        if (!(this._userQueueNavPaths instanceof Set)) this._userQueueNavPaths = new Set();
        this._userQueueNavPaths.add(path);
      }
      if (queueIdx >= 0) {
        this._userQueue.splice(queueIdx, 1);
        this._persistUserQueue();
      }
      const video = this.library.getVideoByPath?.(path);
      if (!video) {
        // Not in the library any more: its source was removed or switched off
        // after it was queued. The user queued it by hand and the card has been
        // naming it (UpNextEngine never filters the queue), so play the file if
        // it is still on disk, the way a playlist entry from a removed source
        // plays (FT-018). Only a file that is really gone gets the toast.
        if (await this._queuedFileOnDisk(path) && this.playlists?._playVideoByPath) {
          await this.playlists._playVideoByPath(path, interlude, { autoPlay });
          this._updateQueuePanelState();
          return;
        }
        showToast(t('toast.nextNotFound'), 'warn', 3000);
        // Nothing loaded: there is no way back from it.
        if (backEntry) {
          this._userQueueBack = (this._userQueueBack || []).filter((e) => e !== backEntry);
          this._userQueueNavPaths?.delete?.(path);
        }
        return;
      }
      if (autoPlay) video._autoPlayOnNextLoad = true;
      if (interlude) video._playContextOverride = interlude;
      await this.library._playVideo(video);
      this._updateQueuePanelState();
    } finally {
      if (this._queueJumpPending === pending) this._queueJumpPending = null;
      settled();
    }
  }

  /**
   * Is a queued path that the library does not hold still on disk? Only an
   * explicit `false` says no: a check that timed out or failed is unknown, and
   * the load's own missing-file handling covers a file that really is gone.
   */
  async _queuedFileOnDisk(path) {
    try {
      const answer = await window.funsync?.filesExist?.([path]);
      return !(Array.isArray(answer) && answer[0] === false);
    } catch {
      return true;
    }
  }

  /**
   * Append a path to the user queue (default) or insert at the head
   * (position = 'next'). Toast confirms. Refuses duplicates.
   */
  addToUserQueue(path, position = 'end') {
    if (!path || typeof path !== 'string') return;
    if (this._userQueue.includes(path)) {
      showToast(t('queuePanel.toastAlreadyQueued'), 'info', 2000);
      return;
    }
    if (position === 'next') {
      this._userQueue.unshift(path);
    } else {
      this._userQueue.push(path);
    }
    this._persistUserQueue();
    this._updateQueuePanelState();
    showToast(t('queuePanel.toastAddedToQueue'), 'info', 1500);
  }

  /**
   * Several paths onto the end of the user queue, in their order, with ONE
   * write (a Stash group playlist's Add to queue). A path already queued is
   * skipped. Returns how many were added; the caller says so (no toast here).
   */
  addPathsToUserQueue(paths) {
    let added = 0;
    for (const path of Array.isArray(paths) ? paths : []) {
      if (!path || typeof path !== 'string' || this._userQueue.includes(path)) continue;
      this._userQueue.push(path);
      added += 1;
    }
    if (added > 0) {
      this._persistUserQueue();
      this._updateQueuePanelState();
    }
    return added;
  }

  _removeFromUserQueue(path) {
    const idx = this._userQueue.indexOf(path);
    if (idx < 0) return;
    this._userQueue.splice(idx, 1);
    this._persistUserQueue();
    this._updateQueuePanelState();
  }

  _clearUserQueue() {
    if (this._userQueue.length === 0) return;
    this._userQueue = [];
    this._persistUserQueue();
    this._updateQueuePanelState();
  }

  _reorderUserQueue(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    if (fromIdx < 0 || fromIdx >= this._userQueue.length) return;
    if (toIdx < 0 || toIdx >= this._userQueue.length) return;
    const [moved] = this._userQueue.splice(fromIdx, 1);
    this._userQueue.splice(toIdx, 0, moved);
    this._persistUserQueue();
    this._updateQueuePanelState();
  }

  _persistUserQueue() {
    this.settings?.set?.('player.userQueue', [...this._userQueue]);
    // A card already up names the queue's head, or End of list (FT-018).
    this.upNextEngine?.refresh?.();
    // Next is live while your queue holds a video (FN-07).
    this._updateQueueUI?.();
  }

  /**
   * Resolve a thumbnail for the Up Next card. Tries (in order):
   *   1. The in-memory thumbnail cache the library already populated.
   *   2. The library's per-card capture (which itself goes backend
   *      ffmpeg → renderer-<video> fallback) — populates the cache as a
   *      side-effect.
   *   3. Backend ffmpeg directly (works even before the library has
   *      ever scanned the path).
   * Returns `{ dataUrl }` or `null`.
   */
  async _captureUpNextThumb(path) {
    if (!path) return null;
    try {
      const mod = await import('./thumbnail-cache.js');
      const cached = mod.get(path, 0);
      if (cached) return { dataUrl: cached };
    } catch { /* cache miss path */ }
    if (this.library?._captureVideoFrame) {
      try {
        const result = await this.library._captureVideoFrame(path);
        if (result?.dataUrl) {
          try {
            const mod = await import('./thumbnail-cache.js');
            mod.set(path, 0, result.dataUrl);
          } catch { /* non-fatal */ }
          return { dataUrl: result.dataUrl };
        }
      } catch { /* fall through */ }
    }
    if (window.funsync?.generateSingleThumbnail) {
      try {
        // Honor a user-pinned thumbnail frame or uploaded poster image
        // (parity with the library path above, which resolves both inside
        // _captureVideoFrame).
        const custom = (this.settings?.get?.('library.customThumbnails') || {})[path];
        const imagePath = customThumbImagePath(custom);
        if (imagePath && window.funsync?.readCustomThumbnail) {
          const img = await window.funsync.readCustomThumbnail(imagePath).catch(() => null);
          if (img?.dataUrl) {
            try {
              const mod = await import('./thumbnail-cache.js');
              mod.set(path, 0, img.dataUrl);
            } catch { /* non-fatal */ }
            return { dataUrl: img.dataUrl };
          }
        }
        const { seekPct, exact } = thumbRequestOpts(custom);
        const result = await window.funsync.generateSingleThumbnail(path, { seekPct, width: 320, exact });
        if (result?.dataUrl) {
          try {
            const mod = await import('./thumbnail-cache.js');
            mod.set(path, 0, result.dataUrl);
          } catch { /* non-fatal */ }
          return { dataUrl: result.dataUrl };
        }
      } catch { /* fall through */ }
    }
    return null;
  }

  _upNextBackToSource(sourceContext) {
    const ctx = sourceContext || {};
    // Two shapes, as in _playlistIdOf: a direct play carries { playlistId }
    // / { categoryId }, Play All's queue carries { kind, id }. Reading only
    // the first sent "Back to <playlist>" after Play All to the Library.
    const playlistId = ctx.playlistId || (ctx.kind === 'playlist' ? ctx.id : null);
    const categoryId = ctx.categoryId || (ctx.kind === 'category' ? ctx.id : null);
    // The detail state goes in FIRST and the detail renders ONCE. Entering
    // the view runs show(), which renders the detail when `_view` is
    // 'detail'; a second `_renderDetail` on top of it raced the first across
    // its availability probe and the videos showed twice (FT-034). Only when
    // the view is already on screen (a mini player over it) does nothing
    // else render it.
    if (playlistId && this.playlists) {
      this.playlists._detailPlaylistId = playlistId;
      this.playlists._view = 'detail';
      if (this._currentView() === 'playlists') this.playlists._renderDetail?.(playlistId);
      else this._navigateTo('playlists');
      return;
    }
    if (categoryId && this.categories) {
      this.categories._detailCategoryId = categoryId;
      this.categories._view = 'detail';
      if (this._currentView() === 'categories') this.categories._renderDetail?.(categoryId);
      else this._navigateTo('categories');
      return;
    }
    this._navigateTo('library');
  }

  // --- Library Collections ---

  /**
   * Probe which source paths answer, cached for the session.
   *
   *   1. DISABLED SOURCES ARE NEVER TOUCHED. The scan already honoured the
   *      toggle; the probe did not, so switching a dead NAS off did nothing
   *      and deleting the source was the only escape.
   *   2. TIME-BOXED in the main process, so a dead mapped drive costs ~800ms
   *      once rather than blocking the UI.
   *   3. CACHED. `_refreshCollectionsUI` runs from nine call sites; without a
   *      cache that is nine probes per user action.
   *
   * A disabled source is reported REACHABLE, not unreachable — "unreachable"
   * drives the LOCKED presentation, and a source the user switched off
   * themselves must read as plainly off, not locked.
   *
   * @param {object[]} sources
   * @param {boolean} [force] bypass the cache (Recheck button, the poll)
   * @param {{ keepUnknown?: Set<string>|null, timeoutMs?: number }} [opts]
   *   `keepUnknown`: the 30 s poll's last answer (R3-17). A path with no
   *   definite answer this time (a timeout, an error, a broken reply) keeps
   *   the state it had there instead of failing open, so a slow network drive
   *   is never toggled locked / unlocked (and toasted) by its own slowness.
   * @returns {Promise<Set<string>>} paths that did not answer
   */
  async _probeSourceReachability(sources, force = false, { keepUnknown = null, timeoutMs = SOURCE_PROBE_TIMEOUT_MS } = {}) {
    const list = Array.isArray(sources) ? sources : [];
    const paths = sourcesToProbe(list).map((s) => s.path);
    const key = paths.join('|');

    if (!force && this._sourceProbeCache && this._sourceProbeKey === key) {
      return this._sourceProbeCache;
    }

    const unreachable = new Set();
    // Without an answer: unknown, so the state the poll last had (R3-17).
    const keepAsWas = (p) => { if (keepUnknown?.has(p)) unreachable.add(p); };
    if (paths.length > 0) {
      // Counted so the poll can skip while any probe is out (R3-17).
      this._sourceProbesInFlight = (this._sourceProbesInFlight || 0) + 1;
      try {
        const results = await window.funsync.filesExist(paths, timeoutMs);
        if (!(Array.isArray(results) && results.length === paths.length)) paths.forEach(keepAsWas);
        else {
          paths.forEach((p, i) => { if (results[i] !== true && results[i] !== false) keepAsWas(p); });
          // ONLY an explicit `false` locks a source. `null` means the check
          // timed out, which is not evidence of anything — and this probe
          // runs on a timeout short enough that ordinary app load can blow
          // it. Measured 2026-08-26: with the app mid-rescan of an 880 GB
          // library, every path timed out and all three sources were locked,
          // including a local folder on C: that obviously existed. The user
          // saw their whole library vanish.
          //
          // The catch below already fails open for a thrown IPC, with a
          // comment saying a wrongly-locked library is far worse than a
          // missing lock state. A timeout resolves rather than throwing, so
          // it slipped past that protection and did the exact thing the
          // comment warns against.
          paths.forEach((p, i) => { if (results[i] === false) unreachable.add(p); });
        }
        // Length mismatch is a contract break, not evidence of dead paths.
      } catch {
        // Fail OPEN. Marking a working library unreachable because an IPC
        // hiccuped is far worse than missing a lock state. (The poll keeps
        // the last state instead: no answer is no news, R3-17.)
        paths.forEach(keepAsWas);
      } finally {
        this._sourceProbesInFlight -= 1;
      }
    }

    this._sourceProbeKey = key;
    this._sourceProbeCache = unreachable;
    return unreachable;
  }

  /**
   * Recheck button: drop the cache, re-probe, repaint, and rescan (rendered
   * in the Library view, headless anywhere else, FT-067). Waits for that
   * rescan, because the panel reports
   * what it found: a folder that exists but cannot be listed passes the probe
   * and then fails the scan, and the panel used to say "All sources are
   * reachable." 50 ms before the scan said "Source unavailable" (app test V04).
   *
   * Rescans only when the answer can have changed (V82). It used to clear the
   * scan key every time, so every Recheck rescanned the whole library even
   * when every source answered exactly as before: 5.5 s on Dave's 939 GB USB
   * drive. Now a change in reachability clears it (`_refreshCollectionsUI`
   * compares the new probe with the last one), and so does a source the last
   * scan could not list, since the probe cannot see that and only a scan can
   * tell whether it is fixed. Otherwise `library.show` keeps the videos it has.
   * A rescan still covers every reachable source, not only the changed one:
   * pairing a script to a video works across sources.
   *
   * The probe also passes a folder that was listed fine and has been locked
   * since (its listing denied): only the scan finds that, and without a scan
   * Recheck said "All sources are reachable." for it (V82 verify). So every
   * other source the probe passed is opened and one entry read
   * (`dirs-listable`, cheap at any folder size), and one that cannot be read,
   * or does not answer, rescans like a reachability change. The rescan is what
   * reports it, through `_failedScanPaths`; a failed root never prunes.
   */
  async _recheckSources() {
    const sources = this.settings.get('library.sources') || [];
    const unreachable = await this._probeSourceReachability(sources, true);
    if (this.library) {
      const failedLastScan = this.library._failedScanPaths || new Set();
      const enabled = sources.filter((s) => s?.path && s.enabled !== false).map((s) => s.path);
      const listedLastScan = enabled.filter((p) => !unreachable.has(p) && !failedLastScan.has(p));
      if (enabled.some((p) => failedLastScan.has(p)) || !(await this._sourceRootsListable(listedLastScan))) {
        this.library._lastScanKey = null;
      }
    }
    await this._refreshCollectionsUI();
    this.settingsPanel?.refreshSources?.();
    const view = this._currentView();
    if (view === 'library') {
      await this.library?.show?.(this._getViewEl('library'));
    } else if (this.library?._lastScanKey == null && typeof this.library?.ensureScanned === 'function') {
      // Recheck from Playlists, Categories or the player (FT-067, V82): the
      // rescan only ran when the Library view showed, so a source whose
      // listing was denied passed the probe, was never scanned, and the
      // panel said "All sources are reachable.". Scan without rendering
      // (it sets `_failedScanPaths`, which the panel counts; prunes go
      // through the same guarded paths as any scan). The key stays null, so
      // the Library view scans for itself when it opens.
      try {
        await this.library.ensureScanned({ forceRescan: true });
      } catch (err) {
        console.warn('[Library] Recheck rescan failed:', err?.message || err);
      }
      if (view === 'playlists') this.playlists?.show?.(this._getViewEl('playlists'));
      else if (view === 'categories') this.categories?.show?.(this._getViewEl('categories'));
    }
  }

  /**
   * Does every one of these source folders still LIST (Recheck, V82 verify)?
   * True only when each answered `true`. A `false`, a timeout (`null`), a
   * malformed answer or a thrown IPC all say "rescan": the scan is the only
   * thing that can tell for sure, and a rescan is slow, never destructive.
   *
   * @param {string[]} paths
   * @returns {Promise<boolean>}
   */
  async _sourceRootsListable(paths) {
    if (paths.length === 0) return true;
    try {
      const answers = await window.funsync.dirsListable(paths, SOURCE_PROBE_TIMEOUT_MS);
      return Array.isArray(answers) && answers.length === paths.length
        && answers.every((a) => a === true);
    } catch {
      return false;
    }
  }

  async _refreshCollectionsUI() {
    const collections = this.settings.get('library.collections') || [];
    let activeCollectionId = this.settings.get('library.activeCollectionId') || null;
    let sources = this.settings.get('library.sources') || [];

    // Auto-migrate: if legacy directory exists but not in sources, add it
    const legacyDir = this.settings.get('library.directory');
    if (legacyDir && !sources.some(s => s.path === legacyDir)) {
      const dirName = legacyDir.split(/[\\/]/).pop() || t('nav.library');
      sources.push({ id: crypto.randomUUID(), name: dirName, path: legacyDir, enabled: true });
      this.settings.set('library.sources', sources);
    }

    // Which source paths are reachable right now.
    //
    // This used to probe EVERY source with a synchronous `existsSync`, which
    // froze the app for ~5s every 20-30s on an offline NAS even after the user
    // switched that source off (lnlytrckr, EroScripts #251/#255). Two things
    // fix it: skip what the user disabled, and never block.
    const unavailablePaths = await this._probeSourceReachability(sources);

    // Determine which collections are unavailable (any video from an unavailable source)
    // Use separator-aware prefix check to avoid false matches (e.g. D:/Videos vs D:/Videos2)
    const unavailableCollectionIds = new Set();
    const unavailableWithSep = [...unavailablePaths].flatMap(sp => [sp + '/', sp + '\\']);
    for (const col of collections) {
      const hasUnavailable = (col.videoPaths || []).some(vp =>
        unavailableWithSep.some(prefix => vp.startsWith(prefix)) ||
        unavailablePaths.has(vp) // exact match (unlikely but safe)
      );
      if (hasUnavailable) unavailableCollectionIds.add(col.id);
    }

    // If active collection is unavailable, fall back to All Videos
    if (activeCollectionId && unavailableCollectionIds.has(activeCollectionId)) {
      activeCollectionId = null;
      this.settings.set('library.activeCollectionId', null);
    }

    this.navBar.setCollections(collections, activeCollectionId, sources, unavailablePaths, unavailableCollectionIds);
    if (this.library) {
      // Invalidate scan cache if availability changed
      const prevUnavail = this.library._unavailablePaths || new Set();
      if (unavailablePaths.size !== prevUnavail.size ||
          [...unavailablePaths].some(p => !prevUnavail.has(p))) {
        this.library._lastScanKey = null;
      }
      this.library._activeCollectionId = activeCollectionId;
      this.library._unavailablePaths = unavailablePaths;
    }
  }

  async _addSource() {
    const dirPath = await window.funsync.selectDirectory();
    if (!dirPath) return;

    const name = await Modal.prompt(t('toast.nameSourcePrompt'), t('toast.nameSourcePlaceholder'), dirPath.split(/[\\/]/).pop());
    if (!name) return;

    const sources = this.settings.get('library.sources') || [];
    // Don't add duplicates
    if (sources.some(s => s.path === dirPath)) {
      showToast(t('toast.folderAlreadySource'), 'warn');
      return;
    }

    sources.push({
      id: crypto.randomUUID(),
      name,
      path: dirPath,
      enabled: true,
    });
    this.settings.set('library.sources', sources);

    // Also set as legacy directory if it's the first source
    if (!this.settings.get('library.directory')) {
      this.settings.set('library.directory', dirPath);
    }

    await this._refreshCollectionsUI();
    if (this.library) this.library._lastScanKey = null;
    if (this._currentView() === 'library') {
      this.library.show(this._getViewEl('library'));
    } else {
      // Any other view (the nav bar's Library ▾ > Add Source Folder… works
      // from all of them): scan in the background, without showing or
      // rendering the Library, as a source added in Settings is (R3-13,
      // CB-26). The new source's videos reached the library, Up Next and the
      // phone / VR only once the Library view was opened.
      this._rescanLibraryInBackground();
    }
  }

  async _switchCollection(collectionId) {
    this.settings.set('library.activeCollectionId', collectionId || null);
    await this._refreshCollectionsUI();
    // Re-render library if it's the active view
    if (this._currentView() === 'library') {
      this.library.show(this._getViewEl('library'));
    } else if (this.library && this.library._lastScanKey == null) {
      // Any other view (R3-13): a collection is a filter the Library view
      // applies when it opens, so nothing is scanned for the switch itself,
      // but a source whose reachability changed (`_refreshCollectionsUI`
      // clears the scan key for it) is rescanned in the background now, as
      // the Library view would, without showing or rendering it.
      this._rescanLibraryInBackground();
    }
  }

  /**
   * Shared modal for creating/editing collections.
   * Shows source picker + name input + searchable video grid with multi-select.
   */
  async _showCollectionModal(title, existingName, existingPaths, existingCol) {
    // existingCol: optional full collection object for edit mode — carries
    // syncSource + excludedPaths when present. New-collection mode passes
    // null/undefined and the modal starts with sync off.
    const sources = this.settings.get('library.sources') || [];
    const legacyDir = this.settings.get('library.directory');
    const unavailable = this.library?._unavailablePaths || new Set();
    const initialSyncSource = existingCol?.syncSource || null;
    const initialExcluded = new Set(existingCol?.excludedPaths || []);

    // Get initial videos from all available sources (or legacy dir)
    let allScanPaths = sources.length > 0
      ? sources.filter(s => s.enabled !== false && !unavailable.has(s.path)).map(s => s.path)
      : (legacyDir && !unavailable.has(legacyDir) ? [legacyDir] : []);

    // Scan to get initial video list
    let videos = [];
    if (allScanPaths.length > 0) {
      const scanResult = await window.funsync.scanDirectory(allScanPaths.length === 1 ? allScanPaths[0] : allScanPaths);
      videos = scanResult?.videos || [];
    }

    return Modal.open({
      title,
      onRender: (body, close) => {
        // Source picker
        const sourceRow = document.createElement('div');
        sourceRow.className = 'library__collection-toolbar';
        sourceRow.style.marginBottom = '8px';

        const sourceLabel = document.createElement('span');
        sourceLabel.className = 'library__collection-count';
        sourceLabel.textContent = t('collectionModal.sourceLabel');
        sourceLabel.style.marginRight = '6px';

        const sourceSelect = document.createElement('select');
        sourceSelect.className = 'library__sort-select';
        sourceSelect.style.flex = '1';

        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = t('collectionModal.allSources');
        sourceSelect.appendChild(allOpt);

        for (const src of sources) {
          const opt = document.createElement('option');
          opt.value = src.id;
          const isOffline = unavailable.has(src.path);
          opt.textContent = isOffline ? t('collectionModal.sourceDisconnected', { name: src.name }) : src.name;
          opt.disabled = isOffline;
          sourceSelect.appendChild(opt);
        }

        const browseOpt = document.createElement('option');
        browseOpt.value = '__browse__';
        browseOpt.textContent = t('collectionModal.browseFolder');
        sourceSelect.appendChild(browseOpt);

        sourceRow.appendChild(sourceLabel);
        sourceRow.appendChild(sourceSelect);
        body.appendChild(sourceRow);

        // "Sync with source" checkbox — when on, the collection tracks
        // the selected source/folder live: new videos dropped into it
        // auto-join the collection on next scan; videos the user
        // unchecks go into excludedPaths. Disabled when the source
        // picker is on "All Sources" (no definite scope to sync with).
        const syncRow = document.createElement('div');
        syncRow.className = 'library__collection-toolbar';
        syncRow.style.cssText = 'margin-bottom:8px;align-items:center';
        const syncLabel = document.createElement('label');
        syncLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer';
        const syncCheckbox = document.createElement('input');
        syncCheckbox.type = 'checkbox';
        syncCheckbox.id = 'col-sync-checkbox';
        const syncText = document.createElement('span');
        syncText.textContent = t('collectionModal.syncLabel');
        syncLabel.appendChild(syncCheckbox);
        syncLabel.appendChild(syncText);
        syncRow.appendChild(syncLabel);
        body.appendChild(syncRow);

        // Name input
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'modal-input';
        nameInput.placeholder = t('collectionModal.namePlaceholder');
        nameInput.value = existingName || '';
        nameInput.style.marginBottom = '8px';
        body.appendChild(nameInput);

        // Search + count
        const toolbar = document.createElement('div');
        toolbar.className = 'library__collection-toolbar';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'library__search-input';
        searchInput.placeholder = t('collectionModal.searchPlaceholder');
        searchInput.style.flex = '1';

        const countLabel = document.createElement('span');
        countLabel.className = 'library__collection-count';
        countLabel.textContent = t('collectionModal.selectionCount', { count: existingPaths.size });

        const selectAllBtn = document.createElement('button');
        selectAllBtn.className = 'library__collection-select-all';
        selectAllBtn.textContent = t('collectionModal.selectAll');
        selectAllBtn.addEventListener('click', () => {
          const query = searchInput.value.toLowerCase().trim();
          const visible = query
            ? currentVideos.filter(v => v.name.toLowerCase().includes(query))
            : currentVideos;
          const allSelected = visible.length > 0 && visible.every(v => selected.has(v.path));
          for (const v of visible) {
            if (allSelected) {
              selected.delete(v.path);
            } else {
              selected.add(v.path);
            }
          }
          countLabel.textContent = t('collectionModal.selectionCount', { count: selected.size });
          renderGrid();
        });

        toolbar.appendChild(searchInput);
        toolbar.appendChild(selectAllBtn);
        toolbar.appendChild(countLabel);
        body.appendChild(toolbar);

        // Video grid
        const grid = document.createElement('div');
        grid.className = 'library__collection-grid';

        const selected = new Set(existingPaths);
        let currentVideos = [...videos];
        const pendingSources = []; // sources added via browse — only saved on confirm

        const renderGrid = () => {
          grid.innerHTML = '';
          const query = searchInput.value.toLowerCase().trim();
          // Name A-Z as the library grid and the phone order it (R3-28): the
          // name without its extension first. The scan's own order put
          // "Alpha Scene (copy)" before "Alpha Scene" here (R3 fix-up,
          // real-app verifier 2).
          const filtered = (query
            ? currentVideos.filter(v => v.name.toLowerCase().includes(query))
            : [...currentVideos]).sort(compareVideoNames);

          for (const video of filtered) {
            const card = document.createElement('div');
            card.className = 'library__collection-card';
            if (selected.has(video.path)) card.classList.add('library__collection-card--selected');

            const checkbox = document.createElement('div');
            checkbox.className = 'library__collection-card-check';
            if (selected.has(video.path)) checkbox.classList.add('library__collection-card-check--on');

            const titleEl = document.createElement('div');
            titleEl.className = 'library__collection-card-title';
            titleEl.textContent = video.name.replace(/\.[^/.]+$/, '');
            titleEl.title = video.name;

            card.appendChild(checkbox);
            card.appendChild(titleEl);

            card.addEventListener('click', () => {
              if (selected.has(video.path)) {
                selected.delete(video.path);
                card.classList.remove('library__collection-card--selected');
                checkbox.classList.remove('library__collection-card-check--on');
              } else {
                selected.add(video.path);
                card.classList.add('library__collection-card--selected');
                checkbox.classList.add('library__collection-card-check--on');
              }
              countLabel.textContent = t('collectionModal.selectionCount', { count: selected.size });
              // Sync Select All button text
              const allVis = filtered.every(v => selected.has(v.path));
              selectAllBtn.textContent = allVis ? t('collectionModal.deselectAll') : t('collectionModal.selectAll');
            });

            grid.appendChild(card);
          }

          if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'library__collection-count';
            empty.style.padding = '20px';
            empty.style.textAlign = 'center';
            empty.textContent = currentVideos.length === 0 ? t('library.emptyTitle') : t('collectionModal.noMatches');
            grid.appendChild(empty);
          }

          // Sync Select All button text
          const allVisible = filtered.length > 0 && filtered.every(v => selected.has(v.path));
          selectAllBtn.textContent = allVisible ? t('collectionModal.deselectAll') : t('collectionModal.selectAll');
          selectAllBtn.hidden = filtered.length === 0;
        };

        searchInput.addEventListener('input', renderGrid);

        // Source change — rescan the selected source
        let previousSourceValue = 'all';
        sourceSelect.addEventListener('change', async () => {
          const val = sourceSelect.value;
          if (val === '__browse__') {
            const dirPath = await window.funsync.selectDirectory();
            if (dirPath) {
              // Add as new source
              const name = dirPath.split(/[\\/]/).pop();
              const newSrc = { id: crypto.randomUUID(), name, path: dirPath, enabled: true };
              const allExisting = [...(this.settings.get('library.sources') || []), ...pendingSources];
              if (!allExisting.some(s => s.path === dirPath)) {
                pendingSources.push(newSrc);
                const opt = document.createElement('option');
                opt.value = newSrc.id;
                opt.textContent = name;
                sourceSelect.insertBefore(opt, browseOpt);
                sourceSelect.value = newSrc.id;
              }
              // Scan new directory
              const result = await window.funsync.scanDirectory(dirPath);
              currentVideos = result?.videos || [];
            } else {
              // User cancelled directory picker — revert dropdown to previous value
              sourceSelect.value = previousSourceValue;
              return;
            }
          } else if (val === 'all') {
            currentVideos = [...videos];
          } else {
            const src = sources.find(s => s.id === val) || pendingSources.find(s => s.id === val);
            if (src) {
              const result = await window.funsync.scanDirectory(src.path);
              currentVideos = result?.videos || [];
            }
          }
          previousSourceValue = sourceSelect.value;
          searchInput.value = '';
          renderGrid();
        });

        renderGrid();
        body.appendChild(grid);

        // --- Sync checkbox wiring ---
        // Helper: derive the current sync scope from the source dropdown.
        // "all" → null (can't sync to the whole library). Named source →
        // { sourceId }. Browse-added folder → { folderPath }.
        const currentSyncScope = () => {
          const val = sourceSelect.value;
          if (val === 'all' || val === '__browse__') return null;
          const src = sources.find(s => s.id === val) || pendingSources.find(s => s.id === val);
          if (!src) return null;
          // Pending sources (browse) are stored as real sources at save
          // time, so we can persist their sourceId.
          return { sourceId: src.id };
        };
        const updateSyncDisabled = () => {
          const scope = currentSyncScope();
          syncCheckbox.disabled = !scope;
          syncLabel.style.opacity = scope ? '' : '0.5';
          syncLabel.style.cursor = scope ? 'pointer' : 'not-allowed';
        };

        // Restore sync state for edit mode. If the existing collection
        // is synced via sourceId, pre-select that source. If synced via
        // folderPath that matches a source's path, pre-select that
        // source (so it tracks by id, more robust). If folderPath is a
        // bare path with no matching source, leave the dropdown on
        // "all" — unusual state, but the frozen videoPaths still apply.
        if (initialSyncSource) {
          syncCheckbox.checked = true;
          if (initialSyncSource.sourceId) {
            sourceSelect.value = initialSyncSource.sourceId;
            const src = sources.find(s => s.id === initialSyncSource.sourceId);
            if (src) {
              // Rescan to populate currentVideos with this source's content.
              // Done async so the initial render still happens with
              // All Sources; the re-render fires when scan returns.
              (async () => {
                const result = await window.funsync.scanDirectory(src.path);
                currentVideos = result?.videos || [];
                // Re-auto-select all auto-members on first paint, minus
                // any excluded.
                selected.clear();
                for (const v of currentVideos) {
                  if (!initialExcluded.has(v.path)) selected.add(v.path);
                }
                // Re-add the additive include list (videos outside the
                // sync scope that the user manually added).
                for (const p of existingPaths) {
                  if (!currentVideos.some(v => v.path === p)) selected.add(p);
                }
                countLabel.textContent = t('collectionModal.selectionCount', { count: selected.size });
                renderGrid();
              })();
            }
          } else if (initialSyncSource.folderPath) {
            const match = sources.find(s => canonicalPath(s.path) === canonicalPath(initialSyncSource.folderPath));
            if (match) sourceSelect.value = match.id;
            // else: stays on 'all' — collection is synced to an orphan
            // folder not covered by any source (source deleted after
            // conversion). User has to add the folder back as a source
            // to resume population.
          }
        }
        updateSyncDisabled();

        // Toggle: when checked ON, auto-select all videos currently
        // visible (scope = current source). When OFF, FREEZE the
        // currently-selected set as the snapshot — no data loss.
        syncCheckbox.addEventListener('change', () => {
          if (syncCheckbox.checked) {
            for (const v of currentVideos) selected.add(v.path);
            countLabel.textContent = t('collectionModal.selectionCount', { count: selected.size });
            renderGrid();
          }
          // When unchecked: selected stays as-is (freeze snapshot).
          // The save handler branches on syncCheckbox.checked.
        });

        // When the source dropdown changes AND sync is on, also
        // rebuild auto-selection for the new scope.
        sourceSelect.addEventListener('change', () => {
          updateSyncDisabled();
          if (!syncCheckbox.disabled && syncCheckbox.checked) {
            // Defer to after the existing source-change handler's scan
            // completes — it updates currentVideos asynchronously.
            setTimeout(() => {
              selected.clear();
              for (const v of currentVideos) selected.add(v.path);
              countLabel.textContent = t('collectionModal.selectionCount', { count: selected.size });
              renderGrid();
            }, 100);
          }
        });

        // Save/Create button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'library__assoc-save-btn';
        saveBtn.textContent = existingName ? t('common.save') : t('common.create');
        saveBtn.style.marginTop = '12px';
        saveBtn.addEventListener('click', () => {
          const name = nameInput.value.trim();
          if (!name) { nameInput.focus(); return; }
          if (selected.size === 0) return;
          // Save any pending sources that were browsed during this modal
          if (pendingSources.length > 0) {
            const srcs = this.settings.get('library.sources') || [];
            for (const ps of pendingSources) {
              if (!srcs.some(s => s.path === ps.path)) srcs.push(ps);
            }
            this.settings.set('library.sources', srcs);
          }

          // Branch on sync state. When synced, split `selected` into
          // auto-members (in sync scope) and additive-include (outside
          // sync scope), and compute excluded = autoMembers − selected.
          if (syncCheckbox.checked && !syncCheckbox.disabled) {
            const syncScope = currentSyncScope();
            const autoSet = new Set(currentVideos.map(v => v.path));
            const include = [];       // selected but outside sync scope
            const excluded = [];      // in sync scope but NOT selected
            for (const p of selected) {
              if (!autoSet.has(p)) include.push(p);
            }
            for (const p of autoSet) {
              if (!selected.has(p)) excluded.push(p);
            }
            close({
              name,
              paths: include,
              syncSource: syncScope,
              excludedPaths: excluded,
            });
          } else {
            // Unsynced (either never synced, or toggle was flipped off
            // = freeze): snapshot the full selected set into videoPaths.
            close({
              name,
              paths: [...selected],
              syncSource: null,
              excludedPaths: null,
            });
          }
        });
        body.appendChild(saveBtn);

        nameInput.focus();
      },
    });
  }

  async _renameCollection(id) {
    const collections = this.settings.get('library.collections') || [];
    const col = collections.find(c => c.id === id);
    if (!col) return;

    // Seed the modal with the FULL current effective membership so the
    // user sees the synced collection's current contents in the grid,
    // not just the additive-include videoPaths list. For unsynced
    // collections this is the same thing.
    const sources = this.settings.get('library.sources') || [];
    const { expandSyncedMembership } = await import('./collection-sync.js');
    const descendantsMod = await import('./folder-index.js');
    const effective = expandSyncedMembership(
      col, sources, this.library?._folderIndex, descendantsMod.descendantsOf,
    );

    const result = await this._showCollectionModal(t('collectionModal.titleEdit', { name: col.name }), col.name, effective, col);
    if (!result) return;

    col.name = result.name;
    col.videoPaths = result.paths;
    // Persist sync state (null means unsynced / frozen).
    if (result.syncSource) {
      col.syncSource = result.syncSource;
      col.excludedPaths = result.excludedPaths || [];
    } else {
      delete col.syncSource;
      delete col.excludedPaths;
    }
    this.settings.set('library.collections', collections);
    await this._refreshCollectionsUI();

    if (this.settings.get('library.activeCollectionId') === id) {
      this.library.show(this._getViewEl('library'));
    }
  }

  async _deleteCollection(id) {
    const collections = this.settings.get('library.collections') || [];
    const col = collections.find(c => c.id === id);
    if (!col) return;

    const confirmed = await Modal.confirm(t('toast.deleteCollectionTitle'), t('toast.deleteCollectionConfirm', { name: col.name }), { confirmText: t('common.delete') });
    if (!confirmed) return;

    // Pre-action snapshot — deleting a collection drops the entire
    // videoPaths array AND any syncSource config. Recoverable from
    // the snapshot if the user immediately regrets it.
    await window.funsync.backupPreAction?.('delete-collection');

    const updated = collections.filter(c => c.id !== id);
    this.settings.set('library.collections', updated);

    // If the deleted collection was active, switch to All
    if (this.settings.get('library.activeCollectionId') === id) {
      await this._switchCollection(null);
    } else {
      await this._refreshCollectionsUI();
    }
  }

  async _showNewCollectionModal() {
    const chosen = await this._showCollectionModal(t('collectionModal.titleCreate'), '', new Set());
    if (!chosen) return;

    const collections = this.settings.get('library.collections') || [];
    const newCol = {
      id: crypto.randomUUID(),
      name: chosen.name,
      videoPaths: chosen.paths,
    };
    if (chosen.syncSource) {
      newCol.syncSource = chosen.syncSource;
      newCol.excludedPaths = chosen.excludedPaths || [];
    }
    collections.push(newCol);
    this.settings.set('library.collections', collections);

    // Switch to the new collection
    await this._switchCollection(newCol.id);
  }

  _loadSubtitleFromLibrary(subtitleData) {
    if (!subtitleData || !subtitleData.textContent || !subtitleData.name) return;
    const file = new File([subtitleData.textContent], subtitleData.name, { type: 'text/plain' });
    this.videoPlayer.loadSubtitles(file);
  }

  // --- Script Variants ---

  _updateVariantSelector() {
    const selector = document.getElementById('variant-selector');
    const btn = document.getElementById('variant-btn');
    if (!selector || !btn) return;

    // Build the full variants list: auto-detected + currently loaded + manual
    const videoPath = this._currentVideoPath;

    // Start with auto-detected variants from library scan
    let baseVariants = [...this._currentVariants];

    // No list from the scan: the script the video opened on is offered as
    // "Default", so it can be picked again. Its path is the one noted when
    // this video's main script loaded (`_mainScript`, _loadPlayContent),
    // never what the editor holds NOW (N-02; new since v0.9.2 with the
    // editor closed, also in v0.9.2 with it open). The editor follows a
    // picked variant (C-02), so after Add variation "Default" became the new
    // variant, its own entry was deduped away, and the script the video
    // opened on was in no entry. A load that noted none (a custom route's
    // script promoted to main) is noted here, from the editor, while that
    // script is still what plays. A phone's list is the phone video's: its
    // "Default" stays the editor's path (the editor keeps off a remote's
    // script, R3-20 / C-11), as before.
    const localList = this._variantsPhoneEpoch == null;
    const scriptLoaded = !!this.funscriptEngine.isLoaded && !!this.funscriptEngine.getRawContent();
    let mainPath = null;
    if (localList && baseVariants.length === 0) {
      mainPath = this._mainScript?.gen === this._videoLoadGen ? this._mainScript.path : null;
      if (!mainPath && scriptLoaded && !this._activeVariantPath && this._engineHeldByRemote !== true
          && this.scriptEditor?._funscriptPath) {
        mainPath = this.scriptEditor._funscriptPath;
        this._mainScript = { gen: this._videoLoadGen, path: mainPath };
      }
    }
    // Never for a script a pick loaded (`_activeVariantPath`): that is one of
    // the hand-added entries below, under its own name. On a video whose only
    // scripts are hand-added the editor follows the pick, so this entry was
    // built from the playing variation and named after the VIDEO with the
    // "main" tag, and the variation was deduped away (block F verify-1).
    if (baseVariants.length === 0 && (mainPath || (scriptLoaded && !this._activeVariantPath))) {
      const currentPath = mainPath || this.scriptEditor?._funscriptPath || null;
      const currentName = mainPath
        ? String(mainPath).split(/[\\/]/).pop()
        : this._currentVideoName
          ? this._currentVideoName.replace(/\.[^/.]+$/, '') + '.funscript'
          : 'current.funscript';
      // Labelled with the scan's data word, in every language: the menu
      // shows its file name (_variantLabelText, FN-03), never the word.
      baseVariants.push({ label: 'Default', path: currentPath || '', name: currentName });
    }

    // Append manually added variants from settings (with filename fallback for drive letter changes).
    // A phone's list already holds the PHONE video's hand-added ones
    // (_phoneVariantList, FN-04): this window's video's are not appended to
    // it (they were, so the phone's menu offered the local video's scripts).
    const manual = localList ? this._manualVariantsFor(videoPath) : [];
    // Merge base + manual, deduplicating by path (manual variants may overlap with auto-detected)
    const seenPaths = new Set(baseVariants.map(v => v.path));
    const deduped = manual.filter(v => !seenPaths.has(v.path));
    const allVariants = [...baseVariants, ...deduped];

    // Resolve active index from stored path (array may have been rebuilt)
    if (this._activeVariantPath) {
      const idx = allVariants.findIndex(v => v.path === this._activeVariantPath);
      if (idx >= 0) this._activeVariantIndex = idx;
    } else {
      // No active path: the video's own script plays, the first entry. A
      // list of hand-added variations only (no script of its own, none picked
      // yet) has no entry that plays: none is marked, the chip says no script,
      // and a click on the first one loads it. It ticked the first one while
      // nothing was loaded, and a click on it did nothing (block F verify-1).
      this._activeVariantIndex = baseVariants.length > 0 ? 0 : -1;
    }

    // Which entry is the script the video opens on, its assigned one: the
    // menu, the pop-out and the phone mark it "main" (FN-03). For this
    // window's video, the one noted at load; none when that script is in no
    // entry (a multi-axis main). A phone's list carries its own mark.
    const opened = localList && this._mainScript && this._mainScript.gen === this._videoLoadGen
      ? this._mainScript.path : null;
    this._mainVariantIndex = !localList
      ? baseVariants.findIndex((v) => v?.main === true)
      : opened ? baseVariants.findIndex((v) => v.path === opened) : (baseVariants.length > 0 ? 0 : -1);

    // Show selector only if there are variants (or always to allow adding)
    if (allVariants.length > 1 || this._currentVideoPath) {
      selector.hidden = false;
      const active = allVariants[this._activeVariantIndex];
      // Target the label span — don't touch button.textContent or
      // we'd wipe the chevron SVG inserted by createIcons().
      const labelEl = document.getElementById('variant-btn-label');
      if (labelEl) {
        // No entry plays (index -1: its variation was removed in Manage
        // variations while it played): the chip names the script that does.
        const playingName = !active && this._activeVariantPath
          ? String(this._activeVariantPath).split(/[\\/]/).pop().replace(/\.funscript$/i, '')
          : '';
        // Nothing to name at all (no script, no variation): it says so, not
        // "Default" (FN-03).
        labelEl.textContent = active ? this._variantLabelText(active) : (playingName || t('syncChip.noScript'));
      }
    } else {
      selector.hidden = true;
    }

    this._allVariantsWithManual = allVariants;
  }

  /**
   * A variant's label as SHOWN. The library scan (electron/library-scan.js)
   * labels a script with no label of its own 'Default', in English, and a pin
   * (library.preferredVariants), the pop-out and the phone match on that
   * word, so the data keeps it and only the words on screen change.
   * Such an entry is shown by its own file name (FN-03, Dave 2026-11-16:
   * "the default means nothing"); it read "Default", translated since
   * verify-1 2026-11-07. Same rule as variant-names.js `variantDisplayName`
   * (tests/unit/variant-names.test.js pins the two together); inline because
   * the lifted tests of this method inject `t` only. The translated word is
   * left only for an entry with no label, name or path, which no list builds.
   */
  _variantLabelText(variant) {
    const label = String(variant?.label ?? '').trim();
    if (label && label !== 'Default') return variant.label;
    const file = String(variant?.name ?? '').trim()
      || String(variant?.path ?? '').split(/[\\/]/).pop() || '';
    return file.replace(/\.funscript$/i, '').trim() || t('variants.defaultLabel');
  }

  /**
   * This video's manually added variants (`library.manualVariants`), re-homed
   * from a moved video's old path when that is safe — see `_planLazyRehome`.
   * This used to take the FIRST basename match and delete it: in a library
   * with two `intro.mp4`s that stole a live video's variants and persisted
   * the mistake straight away, since this path writes settings.
   */
  _manualVariantsFor(videoPath) {
    if (!videoPath) return [];
    const manualVariants = this.settings.get('library.manualVariants') || {};
    const own = manualVariants[videoPath] || [];
    if (own.length > 0) return own;
    const plan = this._planLazyRehome(
      Object.keys(manualVariants).filter((p) => manualVariants[p]?.length > 0),
      videoPath,
    );
    if (!plan) return own;
    const { from, keepSource } = plan;
    // A copy gets its own objects: the heal path edits variant.path in
    // place, and must not silently edit the original's list as well.
    const manual = keepSource
      ? manualVariants[from].map((v) => ({ ...v }))
      : manualVariants[from];
    manualVariants[videoPath] = manual;
    if (!keepSource) delete manualVariants[from];
    this.settings.set('library.manualVariants', manualVariants);
    console.log(
      `[Variants] Re-homed moved video's variants: ${from} → ${videoPath}`
      + (keepSource ? ' (original kept — its absence is unproven)' : ''),
    );
    return manual;
  }

  /**
   * Guarded filename re-home for per-video maps that are read lazily at
   * playback time (`library.manualVariants`, `library.preferredVariants`)
   * rather than during a scan. Same two rules as the scan-time
   * `planAssociationRehome`:
   *
   *  - a path on a source that is OFFLINE right now is not an orphan. Its
   *    video is missing from the library only because the drive is
   *    unplugged, so a same-named copy elsewhere must not take its entry;
   *  - the old key is deleted only when the scan PROVES its file is gone
   *    (`library._isProvablyGone`). Anything less is a copy.
   *
   * Absent library → nothing is provable, so any move is a copy.
   *
   * @param {string[]} storedPaths — keys of the map being searched
   * @param {string} videoPath — the video being looked up
   * @returns {{from: string, keepSource: boolean}|null}
   */
  _planLazyRehome(storedPaths, videoPath) {
    const lib = this.library;
    const from = pickRehomeCandidate({
      storedPaths,
      videoPath,
      isLive: (p) => !!lib?.getVideoByPath?.(p) || !!lib?._isUnderUnavailableSource?.(p),
    });
    if (!from) return null;
    return { from, keepSource: !lib?._isProvablyGone?.(from) };
  }

  /**
   * Re-scan the CURRENT video's own folder for script variants and refresh
   * `_currentVariants` if the set changed. Auto-detected variants are
   * otherwise captured once at library-scan time and cached for the whole
   * session — so a variant dropped in later, or a source drive that came
   * back online after being disconnected, wouldn't show until an app
   * restart / full library refresh. Called on dropdown open (background,
   * non-blocking). Reuses the exact `scan-directory` variant parsing
   * scoped to a single folder — no duplicated filename logic.
   *
   * @returns {Promise<boolean>} true if the variant set changed.
   */
  async _refreshCurrentVariantsFromDisk() {
    const videoPath = this._currentVideoPath;
    if (!videoPath || !window.funsync?.scanDirectory) return false;
    const dir = videoPath.replace(/[\\/][^\\/]*$/, '');
    if (!dir || dir === videoPath) return false;
    try {
      const result = await window.funsync.scanDirectory(dir, this.library?._sourceMap || {});
      const match = result?.videos?.find((v) => v.path === videoPath);
      if (!match) return false; // folder unreadable (offline) — keep cache
      // A user's association over the video's own sidecar leads the list, as
      // at load; the raw scan would put the sidecar at index 0 (R4-06).
      const fresh = this.library?.variantsForVideo?.(videoPath, match.variants || [])
        ?? (match.variants || []);
      const cur = this._currentVariants || [];
      const changed = fresh.length !== cur.length
        || fresh.some((v, i) => v.path !== cur[i]?.path);
      if (changed) {
        this._currentVariants = fresh;
        this._variantsPhoneEpoch = null;   // scanned from the local video's folder
        this._updateVariantSelector();
        return true;
      }
    } catch (err) {
      console.warn('[Variants] refresh-on-open failed:', err?.message || err);
    }
    return false;
  }

  /**
   * Read this video's pinned-default variant label, if any. Stored in
   * `library.preferredVariants` keyed by video path → variant label.
   * Label (not path) is the key so a moved drive / renamed script still
   * resolves — mirrors how the variant chip and manualVariants behave.
   * Includes the same filename-fallback rehoming as manualVariants.
   */
  _getPreferredVariantLabel(videoPath) {
    if (!videoPath) return null;
    const map = this.settings.get('library.preferredVariants') || {};
    if (map[videoPath]) return map[videoPath];
    // Guarded re-home (see _planLazyRehome): refuses when several stored
    // entries share the filename, when the candidate's video is still in the
    // library, or when it sits on an offline source; deletes the old pin only
    // when its file is provably gone. Previously took the first match and
    // deleted it, persisting a wrong pin immediately.
    const plan = this._planLazyRehome(Object.keys(map).filter((p) => map[p]), videoPath);
    if (plan) {
      const { from, keepSource } = plan;
      const label = map[from];
      map[videoPath] = label;
      if (!keepSource) delete map[from];
      this.settings.set('library.preferredVariants', map);
      console.log(
        `[Variants] Re-homed pinned default variant: ${from} → ${videoPath}`
        + (keepSource ? ' (original kept — its absence is unproven)' : ''),
      );
      return label;
    }
    return null;
  }

  /** Pin (label) or clear (null) this video's preferred default variant. */
  _setPreferredVariantLabel(videoPath, label) {
    if (!videoPath) return;
    const map = this.settings.get('library.preferredVariants') || {};
    if (label) map[videoPath] = label;
    else delete map[videoPath];
    this.settings.set('library.preferredVariants', map);
  }

  // ===== Per-video sync offset (Pudknocker #380) =====
  //
  // `library.syncOffsets[path]` is a delta added on top of every device's own
  // offset while that video plays (renderer/js/video-sync-offset.js). The
  // global sliders keep editing the global values; the delta lives in each
  // device object (setVideoOffsetMs / setVideoOffset), so every place that
  // sets a global offset keeps the delta without knowing about it.

  /**
   * The library video whose delta applies now: the phone's while it plays
   * one, else the headset's (its matched LOCAL path) while its script drives
   * the devices, else the local player's. A headset video that drives
   * nothing (no match, no script) leaves the local player's in place.
   */
  _videoSyncOffsetPath() {
    if (this._phoneSyncOffsetActive) return this._phoneSyncOffsetPath || null;
    if (this._vrSyncOffsetActive) return this._vrSyncOffsetPath || null;
    return this._currentVideoPath || null;
  }

  /**
   * This video's delta (0 = none), re-homed from a moved video's old path
   * when that is safe (`_planLazyRehome`: an offline path is never a
   * candidate, the old key goes only when its file is provably gone). A
   * missing file never removes an entry. A stored 0 (a Reset) is this
   * video's own answer, so it is never replaced by a same-named copy's.
   */
  _videoSyncOffsetFor(videoPath) {
    if (!videoPath) return 0;
    const map = this.settings?.get?.('library.syncOffsets') || {};
    if (Object.prototype.hasOwnProperty.call(map, videoPath)) return videoSyncOffsetOf(map, videoPath);
    const plan = this._planLazyRehome(
      Object.keys(map).filter((p) => videoSyncOffsetOf(map, p) !== 0),
      videoPath,
    );
    if (!plan) return 0;
    const { from, keepSource } = plan;
    const next = { ...map, [videoPath]: map[from] };
    if (!keepSource) delete next[from];
    this.settings.set('library.syncOffsets', next);
    console.log(
      `[SyncOffset] Re-homed moved video's offset: ${from} → ${videoPath}`
      + (keepSource ? ' (original kept — its absence is unproven)' : ''),
    );
    return videoSyncOffsetOf(next, videoPath);
  }

  /**
   * Put the current video's delta on every device, on top of its own offset
   * (Handy, Buttplug, T-Code, Autoblow). Not on the VR proxy as well: in VR
   * `vr.offset` already stacks under every device's, so that would add it
   * twice. Called on every load (local, VR, phone) and when a VR or phone
   * session ends, so each video starts from its own value and a video
   * without one plays at the global offsets alone, as before. The Handy and
   * Autoblow make no API call when the delta is unchanged.
   */
  _applyVideoSyncOffset() {
    const path = this._videoSyncOffsetPath();
    const ms = this._videoSyncOffsetFor(path);
    this._videoSyncOffsetMs = ms;
    this.buttplugSync?.setVideoOffsetMs?.(ms);
    this.tcodeSync?.setVideoOffsetMs?.(ms);
    if (this.handyManager?.setVideoOffset) {
      Promise.resolve(this.handyManager.setVideoOffset(ms, this.settings?.get?.('handy.defaultOffset') || 0))
        .catch(() => {});
    }
    if (this.autoblowManager?.setVideoOffset) {
      Promise.resolve(this.autoblowManager.setVideoOffset(ms, this.settings?.get?.('autoblow.offset') || 0))
        .catch(() => {});
    }
    eventBus.emit('videoSyncOffset:changed', { path, ms });
  }

  /**
   * Which video's delta the headset session puts on the devices: `path`
   * (the LOCAL library path it matched) once its script drives them, null
   * when it drives nothing, which puts the local video's (or the phone's)
   * back. Called once per VR video, after the match, and by _stopVRSync.
   */
  _settleVRVideoSyncOffset(path) {
    this._vrSyncOffsetActive = !!path;
    this._vrSyncOffsetPath = path || null;
    this._applyVideoSyncOffset();
  }

  /**
   * The "This video" rows' state; null unless a video is really playing
   * here (FT-017). `_currentVideoPath` outlives Back, so the Sync tab kept
   * offering the last video's row in the library. Saved offsets and the
   * delta on the devices are not touched by this.
   */
  _videoSyncOffsetState() {
    const path = this._videoSyncOffsetPath();
    if (!path || !this._videoSyncOffsetLive()) return null;
    return { path, ms: this._videoSyncOffsetMs };
  }

  /**
   * A phone or headset session's video, or the local video while it is in
   * the player view, the docked mini player or the pop-out player window.
   */
  _videoSyncOffsetLive() {
    if (this._phoneSyncOffsetActive || this._vrSyncOffsetActive) return true;
    return this._currentView?.() === 'player' || !!this._miniActive || !!this._playerWindowActive;
  }

  /** Re-read the "This video" rows after a view, mini-player or pop-out change (FT-017). */
  _emitVideoSyncOffsetRowChanged() {
    eventBus.emit('videoSyncOffset:changed', { path: this._videoSyncOffsetPath(), ms: this._videoSyncOffsetMs });
  }

  /** The VR modal's row: only the headset's own video, never the local one. */
  _vrVideoSyncOffsetState() {
    if (!this._vrSyncOffsetActive || this._phoneSyncOffsetActive) return null;
    return this._videoSyncOffsetState();
  }

  /** A "This video" −, + or Reset press (Sync tab, VR modal). */
  _setVideoSyncOffset(ms) {
    const path = this._videoSyncOffsetPath();
    if (!path) return;
    const map = this.settings.get('library.syncOffsets') || {};
    this.settings.set('library.syncOffsets', withVideoSyncOffset(map, path, ms));
    this._applyVideoSyncOffset();
  }

  /**
   * After a video loads its auto-default script, resolve which variant
   * should actually play (pickVariantIndexOnLoad):
   *   - Random-variant toggle ON (`player.randomVariantOnPlay`, zaikechi
   *     #209/#221): pick one of the variants at random — once per load,
   *     so seeks/pauses never re-roll — and toast which one won. Random
   *     beats a pinned default while the toggle is on (the toggle exists
   *     to inject variety; pins resume when it's turned off).
   *   - Otherwise: switch to the pinned variant if set and present.
   * No-op when the video has fewer than 2 variants, or when the resolved
   * choice is the auto-default that already loaded.
   */
  async _applyPreferredVariant() {
    const videoPath = this._currentVideoPath;
    if (!videoPath) return;
    const variants = this._allVariantsWithManual || [];
    // A video whose only scripts are hand-added variations (no script of its
    // own, no routing) has nothing playing here: it opens on the first of
    // them, or the pinned / random one, as a scanned list opens on its first
    // entry and as the phone starts it (fix-up after block F verify-1; it
    // opened on nothing while the menu ticked the first one).
    const nothingPlays = variants.length > 0 && this._activeVariantIndex < 0
      && !this.funscriptEngine?.isLoaded && !this._customRoutingActive;
    if (variants.length < 2 && !nothingPlays) return;
    const gen = this._videoLoadGen;
    const randomOn = this.settings.get('player.randomVariantOnPlay') === true;
    const idx = pickVariantIndexOnLoad(variants, {
      randomOn,
      preferredLabel: this._getPreferredVariantLabel(videoPath),
    });
    if (idx > 0 || nothingPlays) await this._switchVariant(idx);
    // Moved on to another video meanwhile: this pick is not what plays.
    if (this._videoLoadGen !== gen) return;
    if (randomOn) {
      const label = variants[idx] ? this._variantLabelText(variants[idx]) : t('library.variantDefault');
      showToast(t('toast.randomVariant', { name: label }), 'info', 2500);
    }
  }

  _showVariantDropdown() {
    const dropdown = document.getElementById('variant-dropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';
    dropdown.hidden = false;

    // Closed by a choice made inside it: the focus goes back to the variant
    // button, so a dialog the choice opens (+ Add variation, Manage) gives
    // it back there, not to <body> (block C verifier 1; also in v0.9.2).
    const closeDropdown = () => {
      const back = dropdown.contains(document.activeElement) ? document.getElementById('variant-btn') : null;
      dropdown.hidden = true;
      if (back?.isConnected) {
        try { back.focus({ preventScroll: true }); } catch { /* not focusable */ }
      }
    };

    const variants = this._allVariantsWithManual || [];
    // Per-video pinned default (only meaningful with 2+ variants to pick from).
    const preferredLabel = variants.length > 1
      ? this._getPreferredVariantLabel(this._currentVideoPath)
      : null;
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const item = document.createElement('button');
      item.className = 'variant-selector__item';
      // The one that plays: tinted, ticked, and announced as current, so it
      // is not told by colour alone (FN-03).
      const playing = i === this._activeVariantIndex;
      if (playing) {
        item.classList.add('variant-selector__item--active');
        item.setAttribute('aria-current', 'true');
      }
      // The file behind the name, on hover.
      const fileName = v.name || String(v.path || '').split(/[\\/]/).pop();
      if (fileName) item.title = fileName;

      const check = document.createElement('span');
      check.className = 'variant-selector__check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = playing ? '✓' : '';
      item.appendChild(check);

      const label = document.createElement('span');
      label.className = 'variant-selector__item-label';
      label.textContent = this._variantLabelText(v);
      item.appendChild(label);

      // The script the video opens on, named like the rest and marked
      // "main" (FN-03): no entry reads a bare "Default".
      if (i === this._mainVariantIndex) {
        const main = document.createElement('span');
        main.className = 'variant-selector__main-tag';
        main.textContent = t('variants.mainTag');
        item.appendChild(main);
      }

      // Pin-as-default star. Lives inside the (flex) item; clicking it
      // toggles this video's remembered default WITHOUT switching to the
      // variant. Only shown when there's a real choice (2+ variants).
      if (variants.length > 1) {
        const isPreferred = !!preferredLabel && (v.label || '').trim() === preferredLabel.trim();
        const star = document.createElement('span');
        star.className = 'variant-selector__star';
        if (isPreferred) star.classList.add('variant-selector__star--active');
        star.textContent = isPreferred ? '★' : '☆';
        star.setAttribute('role', 'button');
        star.setAttribute('tabindex', '0');
        star.setAttribute('aria-pressed', isPreferred ? 'true' : 'false');
        const starTitle = isPreferred ? t('variants.unsetDefault') : t('variants.setDefault');
        star.title = starTitle;
        star.setAttribute('aria-label', starTitle);
        const toggleStar = () => {
          const newLabel = isPreferred ? null : v.label;
          this._setPreferredVariantLabel(this._currentVideoPath, newLabel);
          showToast(
            newLabel ? t('variants.defaultSet', { label: this._variantLabelText(v) }) : t('variants.defaultCleared'),
            'info', 2500,
          );
          this._showVariantDropdown(); // re-render so star states refresh
        };
        star.addEventListener('click', (e) => { e.stopPropagation(); toggleStar(); });
        star.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleStar(); }
        });
        item.appendChild(star);
      }

      item.addEventListener('click', () => {
        this._switchVariant(i);
        closeDropdown();
      });
      dropdown.appendChild(item);
    }

    // While a phone's list is shown (its video's variations, FN-04), Add and
    // Manage are left out: they edit THIS window's video's list, so an Add
    // there was stored on the local video and then played on the phone.
    const phoneList = this._variantsPhoneEpoch != null;

    // Add variation button
    if (!phoneList) {
      const addBtn = document.createElement('button');
      addBtn.className = 'variant-selector__add';
      addBtn.textContent = t('variants.addVariation');
      addBtn.addEventListener('click', async () => {
        closeDropdown();
        this._showAddVariantModal();
      });
      dropdown.appendChild(addBtn);
    }

    // Manage variations button (only if there are manual variants)
    const videoPath = this._currentVideoPath;
    const manualVariants = this.settings.get('library.manualVariants') || {};
    const manualForVideo = videoPath && manualVariants[videoPath] ? manualVariants[videoPath] : [];
    if (manualForVideo.length > 0 && !phoneList) {
      const manageBtn = document.createElement('button');
      manageBtn.className = 'variant-selector__add';
      manageBtn.textContent = t('variants.manageVariations');
      manageBtn.addEventListener('click', () => {
        closeDropdown();
        this._showManageVariantsModal();
      });
      dropdown.appendChild(manageBtn);
    }

    // Close on outside click (clean up previous listener)
    if (this._variantDropdownClose) {
      document.removeEventListener('click', this._variantDropdownClose, true);
    }
    this._variantDropdownClose = (e) => {
      if (!dropdown.contains(e.target) && !document.getElementById('variant-btn')?.contains(e.target)) {
        dropdown.hidden = true;
        document.removeEventListener('click', this._variantDropdownClose, true);
        this._variantDropdownClose = null;
      }
    };
    setTimeout(() => document.addEventListener('click', this._variantDropdownClose, true), 0);
  }

  async _addManualVariant(fsPath, fsName) {
    const videoPath = this._currentVideoPath;
    if (!videoPath) return;

    // Extract suggested names from parenthesized parts and dot-separated suffixes
    const nameNoExt = fsName.replace(/\.funscript$/i, '');
    const parenMatches = [...nameNoExt.matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
    const dotParts = nameNoExt.split('.');
    const dotSuffix = dotParts.length > 1 ? dotParts[dotParts.length - 1].trim() : null;

    const suggestions = [];
    const seen = new Set();
    for (const s of parenMatches) {
      const lower = s.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); suggestions.push(s); }
    }
    if (dotSuffix && !seen.has(dotSuffix.toLowerCase())) {
      suggestions.push(dotSuffix);
    }
    // Add full filename as a fallback suggestion
    if (!seen.has(nameNoExt.toLowerCase())) {
      suggestions.push(nameNoExt);
    }

    // Show naming modal
    const label = await Modal.open({
      title: t('variants.nameVariationTitle'),
      onRender: (body, close) => {
        const hint = document.createElement('div');
        hint.className = 'library__collection-count';
        hint.style.marginBottom = '10px';
        hint.textContent = fsName;
        body.appendChild(hint);

        if (suggestions.length > 0) {
          const sugLabel = document.createElement('div');
          sugLabel.className = 'library__collection-count';
          sugLabel.style.marginBottom = '6px';
          sugLabel.textContent = t('variants.suggestions');
          body.appendChild(sugLabel);

          const sugList = document.createElement('div');
          sugList.style.display = 'flex';
          sugList.style.flexWrap = 'wrap';
          sugList.style.gap = '6px';
          sugList.style.marginBottom = '12px';

          for (const sug of suggestions) {
            const btn = document.createElement('button');
            btn.className = 'library__assoc-save-btn';
            btn.style.padding = '6px 14px';
            btn.style.fontSize = '13px';
            btn.textContent = sug;
            btn.addEventListener('click', () => close(sug));
            sugList.appendChild(btn);
          }
          body.appendChild(sugList);
        }

        const divider = document.createElement('div');
        divider.className = 'nav-bar__library-divider';
        divider.style.margin = '8px 0';
        body.appendChild(divider);

        const customLabel = document.createElement('div');
        customLabel.className = 'library__collection-count';
        customLabel.style.marginBottom = '6px';
        customLabel.textContent = t('variants.customName');
        body.appendChild(customLabel);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
        input.placeholder = t('variants.enterNamePlaceholder');
        input.style.marginBottom = '12px';
        body.appendChild(input);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'library__assoc-save-btn';
        confirmBtn.style.display = 'block';
        confirmBtn.style.width = '66%';
        confirmBtn.style.margin = '0 auto';
        confirmBtn.textContent = t('common.ok');
        confirmBtn.addEventListener('click', () => {
          const val = input.value.trim();
          if (val) close(val);
        });
        body.appendChild(confirmBtn);

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const val = input.value.trim();
            if (val) close(val);
          }
        });

        input.focus();
      },
    });

    if (!label) return;

    const variant = { label, path: fsPath, name: fsName };

    // Save to settings
    const manualVariants = this.settings.get('library.manualVariants') || {};
    if (!manualVariants[videoPath]) manualVariants[videoPath] = [];
    manualVariants[videoPath].push(variant);
    this.settings.set('library.manualVariants', manualVariants);

    // Update current variants and switch to the new one: found by its path,
    // not taken to be the last entry (a manual entry the list already holds
    // is deduped away, and the last entry was then another script).
    this._updateVariantSelector();
    const added = this._allVariantsWithManual.findIndex((v) => v.path === fsPath);
    this._switchVariant(added >= 0 ? added : this._allVariantsWithManual.length - 1);
  }

  /**
   * Add the picked script files as variations of the open video (N-04, Dave
   * 2026-11-08: "one at a time is annoying"). One file: the one-file naming
   * dialog, as before. Several: ONE naming step for all of them, each with
   * its suggested name, editable (variant-bulk-add.js). A file the variation
   * list already holds, or picked twice, is skipped and the dialog or a
   * toast says so; a lone pick that is already listed plays that entry.
   * Only `library.manualVariants` is written, appended to; the first new
   * variation then plays.
   */
  async _addManualVariants(files) {
    const videoPath = this._currentVideoPath;
    if (!videoPath) return;
    const listed = this._allVariantsWithManual || [];
    const plan = planVariantAdds(pickedFiles(files), {
      listedPaths: listed.map((v) => v.path),
      listedLabels: listed.map((v) => v.label),
    });
    if (plan.add.length === 0) {
      if (plan.skipped.length === 0) return;
      showToast(t('variants.alreadyListed', {
        count: plan.skipped.length,
        names: plan.skipped.map((s) => s.name).join(', '),
      }), 'info', 4000);
      if (plan.skipped.length === 1) {
        const key = canonicalPath(plan.skipped[0].path);
        const at = listed.findIndex((v) => canonicalPath(v.path) === key);
        if (at >= 0) this._switchVariant(at);
      }
      return;
    }
    if (plan.add.length === 1 && plan.skipped.length === 0) {
      await this._addManualVariant(plan.add[0].path, plan.add[0].name);
      return;
    }
    const named = await showBulkVariantNaming(plan);
    // Another video opened while the dialog was up: these are not its scripts.
    if (!named?.length || this._currentVideoPath !== videoPath) return;
    const manualVariants = this.settings.get('library.manualVariants') || {};
    manualVariants[videoPath] = [...(manualVariants[videoPath] || []), ...named];
    this.settings.set('library.manualVariants', manualVariants);
    this._updateVariantSelector();
    showToast(t('variants.bulkAdded', { count: named.length }), 'success', 2500);
    const first = this._allVariantsWithManual.findIndex((v) => v.path === named[0].path);
    if (first >= 0) await this._switchVariant(first);
  }

  async _showAddVariantModal() {
    // Get all funscripts from library sources
    const sources = this.settings.get('library.sources') || [];
    const dirPath = sources.length > 0
      ? sources.filter(s => s.enabled !== false).map(s => s.path)
      : this.settings.get('library.directory');
    if (!dirPath || (Array.isArray(dirPath) && dirPath.length === 0)) {
      // No library — fall back to file dialog (several files at once, N-04)
      const result = await window.funsync.selectFunscript({ multiple: true });
      if (result) await this._addManualVariants(result);
      return;
    }

    // Reuse the library's cached scan. This used to call scanDirectory()
    // directly on every click, re-walking every source recursively and
    // re-statting every file just to list funscripts the library already
    // had in memory — so opening "Add variation" from the PLAYER froze the
    // app for seconds on a large library, while the same modal in the
    // library view (which reads the cache) was instant. Dave 2026-08-05.
    // ensureScanned() is a no-op once a scan exists.
    let allScripts = this.library?.getAllFunscripts?.() || [];
    if (allScripts.length === 0 && this.library?.ensureScanned) {
      try {
        await this.library.ensureScanned();
        allScripts = this.library.getAllFunscripts() || [];
      } catch { /* fall through to the file dialog below */ }
    }

    if (allScripts.length === 0) {
      const result = await window.funsync.selectFunscript({ multiple: true });
      if (result) await this._addManualVariants(result);
      return;
    }

    const videoName = this._currentVideoName || '';
    const ranked = rankFunscriptMatches(videoName, allScripts, 0);

    const chosen = await Modal.open({
      title: t('variants.addScriptVariation'),
      onRender: (body, close) => {
        if (ranked.length > 0) {
          const list = document.createElement('div');
          list.className = 'modal-list';

          for (const match of ranked.slice(0, 30)) {
            const row = document.createElement('button');
            row.className = 'modal-list-item';

            const label = document.createElement('span');
            label.className = 'modal-list-item-label';
            label.textContent = match.name;
            row.appendChild(label);

            if (match.score > 0) {
              const badge = document.createElement('span');
              const scoreClass = match.score >= 70 ? '--high' : match.score >= 40 ? '--medium' : '--low';
              badge.className = `library__match-score library__match-score${scoreClass}`;
              badge.textContent = `${match.score}%`;
              row.appendChild(badge);
            }

            row.addEventListener('click', () => close({ path: match.path, name: match.name }));
            list.appendChild(row);
          }
          body.appendChild(list);
        }

        const divider = document.createElement('div');
        divider.className = 'library__suggestion-divider';
        body.appendChild(divider);

        const browseRow = document.createElement('button');
        browseRow.className = 'modal-list-item library__assoc-action';
        browseRow.textContent = t('variants.browse');
        browseRow.addEventListener('click', async () => {
          // Several files at once (N-04): named together in one step.
          const result = await window.funsync.selectFunscript({ multiple: true });
          if (result) close(result);
        });
        body.appendChild(browseRow);
      },
    });

    if (!chosen) return;
    await this._addManualVariants(chosen);
  }

  async _showManageVariantsModal() {
    const videoPath = this._currentVideoPath;
    if (!videoPath) return;

    const manualVariants = this.settings.get('library.manualVariants') || {};
    const manualForVideo = manualVariants[videoPath] ? [...manualVariants[videoPath]] : [];
    if (manualForVideo.length === 0) return;
    // The variation that plays now is marked here too (FN-03): this
    // window's video's, not a phone's.
    const playingPath = this._variantsPhoneEpoch == null
      ? (this._activeVariantPath || this._allVariantsWithManual?.[this._activeVariantIndex]?.path || null)
      : null;

    let changed = false;

    await Modal.open({
      title: t('variants.manageVariationsTitle'),
      onRender: (body, close) => {
        const list = document.createElement('div');
        list.className = 'modal-list';

        const renderList = () => {
          list.innerHTML = '';

          if (manualForVideo.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'library__collection-count';
            empty.style.padding = '16px';
            empty.style.textAlign = 'center';
            empty.textContent = t('variants.noManualVariations');
            list.appendChild(empty);
            return;
          }

          for (let i = 0; i < manualForVideo.length; i++) {
            const v = manualForVideo[i];
            const row = document.createElement('div');
            row.className = 'modal-list-item';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.cursor = 'default';
            const playing = !!playingPath && v.path === playingPath;
            if (playing) {
              row.classList.add('variant-selector__item--active');
              row.setAttribute('aria-current', 'true');
            }
            const check = document.createElement('span');
            check.className = 'variant-selector__check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = playing ? '✓' : '';
            row.appendChild(check);

            const label = document.createElement('span');
            label.className = 'modal-list-item-label';
            label.style.flex = '1';
            label.textContent = this._variantLabelText(v);
            label.title = v.name;
            row.appendChild(label);

            const fileName = document.createElement('span');
            fileName.style.fontSize = '11px';
            fileName.style.color = 'var(--text-secondary)';
            fileName.style.maxWidth = '180px';
            fileName.style.overflow = 'hidden';
            fileName.style.textOverflow = 'ellipsis';
            fileName.style.whiteSpace = 'nowrap';
            fileName.textContent = v.name;
            row.appendChild(fileName);

            const renameBtn = document.createElement('button');
            renameBtn.className = 'nav-bar__library-action';
            renameBtn.textContent = '✎';
            renameBtn.title = t('toast.renameTooltip');
            renameBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const newName = await Modal.prompt(t('toast.renameVariationTitle'), t('toast.renameVariationLabel'), v.label);
              if (newName && newName !== v.label) {
                manualForVideo[i].label = newName;
                changed = true;
                renderList();
              }
            });
            row.appendChild(renameBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'nav-bar__library-action nav-bar__library-action--danger';
            deleteBtn.textContent = '✕';
            deleteBtn.title = t('common.remove');
            deleteBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              manualForVideo.splice(i, 1);
              changed = true;
              renderList();
            });
            row.appendChild(deleteBtn);

            list.appendChild(row);
          }
        };

        renderList();
        body.appendChild(list);

        const doneBtn = document.createElement('button');
        doneBtn.className = 'library__assoc-save-btn';
        doneBtn.style.display = 'block';
        doneBtn.style.width = '66%';
        doneBtn.style.margin = '12px auto 0';
        doneBtn.textContent = t('common.done');
        doneBtn.addEventListener('click', () => close());
        body.appendChild(doneBtn);
      },
    });

    if (changed) {
      // What ✕ took out, read before the store is written: `get` can hand
      // back the very object written below.
      const removed = (manualVariants[videoPath] || []).filter((v) => !manualForVideo.includes(v));
      const fresh = this.settings.get('library.manualVariants') || {};
      if (manualForVideo.length === 0) {
        delete fresh[videoPath];
      } else {
        fresh[videoPath] = manualForVideo;
      }
      this.settings.set('library.manualVariants', fresh);
      // ✕ on the variation that PLAYS (verify-1 2026-11-16; also in v0.9.2):
      // its script plays on and its file stays, but no entry is it any more,
      // so none is marked as playing until another is picked. The old index
      // stayed, so the entry that moved into its place was marked as playing
      // and a click on it did nothing. The rebuild below marks it again if
      // the same script is still in the list another way.
      if (this._activeVariantPath && removed.some((v) => v.path === this._activeVariantPath)) {
        this._activeVariantIndex = -1;
      }
      this._updateVariantSelector();
    }
  }

  async _switchVariant(index) {
    const variants = this._allVariantsWithManual || [];
    if (index < 0 || index >= variants.length) return;
    if (index === this._activeVariantIndex) return;
    // The variant replaces the script in the editor: unsaved edits are asked
    // about first, a phone's switch included, which waits for the answer
    // (CB-01; TODO Q12). Same list and still a change after the answer.
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true) {
      if (!(await editorOk)) return;
      if (this._allVariantsWithManual !== variants || index === this._activeVariantIndex) return;
    }

    const variant = variants[index];
    // What played before, for a read that fails below.
    const prevIndex = this._activeVariantIndex;
    const prevPath = this._activeVariantPath;
    this._activeVariantIndex = index;
    this._activeVariantPath = variant.path || null;
    // The read and the uploads below can outlast the video: a pinned variant
    // swaps in during the load, and Next (Play All) or another click runs
    // loadVideo, which bumps `_videoLoadGen` and takes down this switch's
    // overlay and upload gate. That video owns the engines and devices now,
    // so this switch stops without touching them (V72 review).
    const gen = this._videoLoadGen;
    const movedOn = () => this._videoLoadGen !== gen;
    // Whose list this pick came from, taken now: the phone's teardown gives
    // the list back to this window's video at once (FT-092), so a pick from
    // the phone's list still reading when the phone lets go must not then
    // read as a local one.
    const listEpoch = this._variantsPhoneEpoch;
    // Whose variation it is: a phone list's are the PHONE video's (FN-04,
    // its hand-added ones included), so a moved file is looked for, and its
    // stored path healed, under that video, never this window's.
    const listOwner = listEpoch != null ? (this._variantsPhoneVideoPath || null) : (this._currentVideoPath || null);

    // Cloud-sync re-uploads (Handy, Autoblow) have a network leg
    // (1-3s typically) that the local sync engines (Buttplug, T-Code)
    // don't pay. Without a pause the video keeps playing while the
    // device goes silent — Hick's law: unexplained absence of feedback
    // feels like a bug. Pause + overlay gives the user a clear
    // "loading" signal.
    //
    // Two distinct playing surfaces exist in this app:
    //   - Desktop video element (`videoPlayer.video`) — when nothing
    //     else is driving playback.
    //   - Remote proxy (`_remoteProxy`) — when a phone is the controller;
    //     the desktop video is paused intentionally and the phone's
    //     `<video>` is what's actually playing. The proxy mirrors its
    //     state via WebSocket.
    // The pause+overlay logic has to handle both. The desktop overlay
    // covers desktop-driven playback; the phone-side overlay (already
    // wired to `script-loading`/`script-ready` messages in the web
    // remote) covers phone-driven playback. Earlier this branch only
    // checked `videoPlayer.video.paused` so phone-controlled switches
    // ran without any pause/overlay/broadcast — the user saw the phone
    // keep playing through a 1-3s device-silent window with no signal.
    const cloudWillReupload = !!this.handyManager?.connected
      || !!this.autoblowManager?.connected;
    const desktopPlaying = !this.videoPlayer.video.paused;
    const remotePlaying = !!this._remoteActive
      && !!this._remoteProxy
      && !this._remoteProxy.paused;
    const shouldPauseDesktop = cloudWillReupload && desktopPlaying;
    const shouldPauseRemote = cloudWillReupload && remotePlaying;
    const willPauseAny = shouldPauseDesktop || shouldPauseRemote;
    if (shouldPauseDesktop) {
      this.videoPlayer.video.pause();
      this._markCloudUploadsPending();
      this._showScriptLoadingOverlay();
    }
    if (willPauseAny && this.remoteBridge?.connected) {
      // Phone listens for this and pauses its own <video> + shows its
      // overlay. Sent for both desktop-driven (so a connected remote
      // mirrors the desktop's loading state) and phone-driven cases.
      this.remoteBridge.sendToPhone({ type: 'script-loading' });
    }

    // Audience source for the new variant. Begun only once the read has
    // succeeded, so a failed read leaves viewers on the variant the streamer
    // is still playing (#361).
    let audienceToken = null;
    try {
      // Resilient read — recovers from a moved file by trying the same
      // basename in the current video's folder, and prunes the entry
      // from manualVariants if it can't recover at all.
      const read = await this._readScriptResilient(variant.path, listOwner);
      if (movedOn()) return;
      if (!read) {
        // Nothing was loaded: what played before still plays, so it is
        // marked again, and the catch below lifts the overlay, resumes and
        // says so. It returned here (also in v0.9.2): the picked entry stayed
        // marked over the old script, and a video it had paused for a cloud
        // re-upload stayed paused under the overlay. Since the fix-up after
        // block F verify-1 a video whose only scripts are hand-added opens
        // through here, so a missing first file must not leave its chip
        // naming a script that never loaded.
        this._activeVariantIndex = prevIndex;
        this._activeVariantPath = prevPath;
        throw new Error('the variation\'s script could not be read');
      }
      const content = read.content;
      const variantTitle = variant.name || variant.path.split(/[\\/]/).pop();
      // Whose variant this is comes from who filled the list, not from
      // `_remoteActive`: that is false while the phone's session is still
      // being prepared, and again once the phone has let go — and the phone
      // video's list stays on the desktop after that, so a V press then
      // started viewers on the phone video's variant at the local video's
      // time (#361 review, 2026-11-04). A phone list's source ends with its
      // session like the phone's own; one from a session that has already
      // ended belongs to no player. VR does not fill the variant list: a
      // variant there is the local video's.
      const phoneList = listEpoch != null;
      const phoneLeft = () => phoneList && (listEpoch !== this._remotePhoneEpoch || this._variantsPhoneEpoch !== listEpoch);
      if (phoneLeft()) {
        // The phone let go while this was read (FT-092; also in v0.9.2): the
        // variant is the phone video's script, and the phone's teardown has
        // put this window's own list (and script) back. Nothing more is
        // loaded or uploaded, and viewers keep the source this window has
        // now (the phone's ended with it). It used to load into the engine
        // and the streamer's Handy and Autoblow anyway.
        if (shouldPauseDesktop) {
          this._clearCloudUploadGate();
          this._hideScriptLoadingOverlay();
          if (desktopPlaying) this.videoPlayer.video.play().catch(() => {});
        }
        if (willPauseAny && this.remoteBridge?.connected) {
          this.remoteBridge.sendToPhone({ type: 'script-ready' });
        }
        return;
      }
      audienceToken = this.audienceBridge?.beginSource({
        title: variantTitle,
        player: phoneList ? SOURCE_PLAYER.PHONE : SOURCE_PLAYER.LOCAL,
      }) ?? null;
      // Self-heal: update the variant entry + the persisted manualVariants
      // store so subsequent plays use the recovered path directly.
      if (read.recoveredPath) {
        variant.path = read.recoveredPath;
        this._activeVariantPath = read.recoveredPath;
        this._healManualVariantPath(listOwner, variant);
      }

      const fsName = variant.name || variant.path.split(/[\\/]/).pop();
      // Keep the embedded-axes lookup key pointed at the script that is
      // actually loaded, or the badge tooltip below would keep listing
      // the PREVIOUS variant's embedded axes.
      this._currentFunscriptPath = variant.path;
      await this.funscriptEngine.loadContent(content, fsName);
      // The phone let go during the parse: its teardown's restore owns the
      // engine and the devices from here (FT-092).
      if (phoneLeft()) return;
      // A variant of the phone's video is not this window's video's script
      // (R3-20).
      this._engineHeldByRemote = phoneList;
      if (movedOn()) return;
      // Viewers get the new variant (decision 8), streamer Handy or not.
      // Built only when a viewer needs it.
      this.audienceBridge?.setScript(audienceToken, {
        content: () => this._audienceScriptContent(content),
        title: fsName,
      });

      // Update heatmap + markers (C-E20: variant switch replaces markers
      // with whatever the new script carries).
      if (isFinite(this.videoPlayer.duration) && this.videoPlayer.duration > 0) {
        this.progressBar.renderHeatmap(
          this.funscriptEngine.getActions(),
          this.videoPlayer.duration,
        );
        this._feedInlineViz();
        this.progressBar.setMarkers({
          chapters: this.funscriptEngine.getChapters(),
          bookmarks: this.funscriptEngine.getBookmarks(),
        });
        if (this.funscriptEngine.getChapters().length > 0) {
          this.progressBar.renderChapterStrip(this.videoPlayer.duration);
        }
      }

      // Update badge
      const info = {
        filename: fsName,
        actionCount: this.funscriptEngine.getActions().length,
        durationFormatted: this._formatActionsDuration(this.funscriptEngine.getActions()),
      };
      this._showFunscriptBadge(info);

      // Reload all sync engines
      if (this.buttplugSync?._active) this.buttplugSync.reloadActions();
      if (this.tcodeSync?._active) this.tcodeSync.reloadActions();

      // Re-upload to Handy (stop first so start() doesn't early-return).
       // _uploadAndStartSync hides the overlay + resumes playback when
       // _waitingForScript is set, so no toast needed during the wait.
       //
       // hsspStop() is explicit because syncEngine.stop() only unbinds
       // listeners — it does NOT command the device. On the desktop /
       // pause-then-reupload path the video's `pause` event is what
       // triggers the engine's `_handlePause` to call hsspStop; but on
       // the phone-controlled path the desktop video is already paused
       // (so no pause event fires) and the engine is stopped before any
       // playing/paused state change reaches it. Without this explicit
       // stop, `setScript` runs while the device is mid-playback, and
       // the next hsspPlay can no-op (device thinks it's already
       // playing) — so the device keeps streaming the old script even
       // though we uploaded the new one. Same shape as `_handleSeeked`,
       // which has always done stop-then-setScript-then-play for seeks.
      if (this.handyManager?.connected) {
        if (this.syncEngine) this.syncEngine.stop();
        try { await this.handyManager.hsspStop(); } catch { /* ignore */ }
        if (movedOn() || phoneLeft()) return;
        await this._uploadAndStartSync();
        if (movedOn() || phoneLeft()) return;
      }

      // Re-upload to Autoblow. The stop is NOT optional, for two reasons.
      //
      // `_tryStartAutoblowSync` skips the upload entirely when
      // `autoblowSync.scriptReady` is already true — which it is, from the
      // script we are replacing. So without this the new variant was never
      // sent and the device carried on playing the old one, while the
      // heatmap, badge, Buttplug and T-Code all updated correctly and made
      // the switch look like it had worked (lr_x3, EroScripts #333). His
      // workaround was a disconnect/reconnect in the device panel, which is
      // just a longer way of clearing that same flag.
      //
      // And a script should not be swapped underneath a device that is still
      // mid-playback — the same reasoning as the Handy block above, which has
      // done stop-then-upload all along. This path only ever got half of it.
      //
      // `stop()` clears `_scriptReady` and issues `syncStop()` to the device,
      // so the upload below runs for real and lands on an idle device.
      if (this.autoblowManager?.connected && this.autoblowSync) {
        this.autoblowSync.stop();
      }
      await this._tryStartAutoblowSync();
      if (movedOn() || phoneLeft()) return;

      // The editor follows the variant that plays, open or CLOSED (C-02,
      // also in v0.9.2). Only an open editor used to be reloaded, and show()
      // loads only into an empty editor, so after a pick with the editor
      // closed E opened the previous variant: what you edited and saved was
      // not what played. Unsaved edits were asked about above. Never the
      // phone's variant (C-11, R3-20's rule): that is the phone video's
      // script, and the editor stays on this window's video.
      if (this.scriptEditor && this._engineHeldByRemote !== true) {
        this.scriptEditor.setFunscriptPath(variant.path);
        this.scriptEditor.loadScript();
      }

      // Restart gap skip
      this._startGapSkip();

      // Update variant button label
      this._updateVariantSelector();

      // Broadcast to any connected web-remote so its variant chip + heatmap
      // mirror the desktop's state. Covers both phone-initiated switches
      // (desktop is responding to the request) and desktop-initiated ones
      // (so the phone reflects the change without the user re-syncing).
      if (this.remoteBridge?.connected) {
        // Trimmed: the phone's list carries the backend's trimmed labels (a
        // hand-added name renamed with a trailing space did not match).
        this.remoteBridge.sendToPhone({ type: 'variant-changed', label: String(variant.label ?? '').trim() });
        if (willPauseAny) {
          // Hides the phone-side loading overlay + resumes the phone's
          // <video>. Sent in both surface cases so the phone always
          // gets the bookend it expects after a `script-loading`.
          this.remoteBridge.sendToPhone({ type: 'script-ready' });
        }
      }

      showToast(t('toast.nowPlayingVariant', { label: this._variantLabelText(variant) }), 'info', 2000);
    } catch (err) {
      console.warn('[Variants] Switch failed:', err.message);
      // The menu and the chip mark what plays now (a failed read put the
      // entry that played before back).
      this._updateVariantSelector?.();
      // Viewers were stopped for the new variant: keep them stopped rather
      // than waiting forever (a no-op if the read threw before beginSource).
      // `failed`: rows read "Couldn't load the script", not "No script".
      this.audienceBridge?.setNoScript(audienceToken, { reason: 'variant-failed', failed: true });
      // Clear the loading state so the user isn't stranded on a paused
      // video with a stuck overlay if the read/load step threw. Force-
      // clear the gate (vs. per-device resolve) because we don't know
      // how far through the upload pipeline each cloud device got
      // before the throw.
      if (shouldPauseDesktop) {
        this._clearCloudUploadGate();
        this._hideScriptLoadingOverlay();
        if (desktopPlaying) this.videoPlayer.video.play().catch(() => {});
      }
      if (willPauseAny && this.remoteBridge?.connected) {
        this.remoteBridge.sendToPhone({ type: 'script-ready' });
      }
      showToast(t('toast.variantSwitchFailed'), 'error');
    }
  }

  _cycleVariant(direction) {
    const variants = this._allVariantsWithManual;
    if (!variants || variants.length < 2) return;
    // No entry plays (-1): forward starts at the first, back at the last.
    const cur = this._activeVariantIndex ?? 0;
    const from = cur >= 0 ? cur : (direction > 0 ? -1 : variants.length);
    const next = (from + direction + variants.length) % variants.length;
    this._switchVariant(next);
  }

  /**
   * Wire the inline-visualization toggles, which live in the ⋮ overflow
   * menu as `role="menuitemcheckbox"` items (moved out of the control bar
   * 2026-08-04). Restores the persisted state, and on click flips
   * visibility + persists + reflects state via aria-checked (the CSS
   * checkbox tick keys off that attribute).
   */
  _wireInlineVizToggles() {
    const wire = (btnId, settingKey, apply) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const setState = (on) => btn.setAttribute('aria-checked', String(on));
      const initial = this.settings.get(settingKey) === true;
      apply(initial);
      setState(initial);
      btn.addEventListener('click', () => {
        const next = !(this.settings.get(settingKey) === true);
        this.settings.set(settingKey, next);
        apply(next);
        setState(next);
      });
    };
    wire('btn-inline-tl', 'player.inlineTimeline', (on) => this.inlineViz.setTimelineVisible(on));
    wire('btn-inline-hm', 'player.inlineHeatmap', (on) => this.inlineViz.setHeatmapVisible(on));
    // HM playhead marker (#381), Settings > Playback; off unless set.
    this.inlineViz.setHeatmapPlayhead(this.settings.get('player.inlineHeatmapPlayhead') === true);
    this._applyInlineVizOpacity();
    this._applyDeviceSimOpacity();
  }

  /**
   * The ⋮ menu's "Device simulator" item (zaikechi #381): the D key's
   * toggle, as a checkbox item. Its tick is driven by the simulator's own
   * visibility (onVisibilityChange), never by the click, so the D key and
   * the menu cannot disagree. Remembered across restarts like the TL / HM
   * toggles beside it (`player.deviceSimulatorVisible`, off by default;
   * Dave, 2026-11-04): whoever toggles it, the visibility listener saves it.
   */
  _wireDeviceSimMenuItem() {
    const btn = document.getElementById('btn-device-sim');
    const sim = this.deviceSimulator;
    if (!btn || !sim) return;
    const reflect = (on) => btn.setAttribute('aria-checked', String(!!on));
    if (this.settings?.get?.('player.deviceSimulatorVisible') === true) sim.show();
    reflect(sim.isVisible);
    sim.onVisibilityChange = (on) => {
      reflect(on);
      this.settings?.set?.('player.deviceSimulatorVisible', !!on);
    };
    btn.addEventListener('click', () => sim.toggle());
  }

  /**
   * Keep the Windows caption strip in step with the player.
   *
   * In the player view the nav bar is hidden, so a solid nav-bar-coloured
   * caption block sits over the video looking pasted-on. There it goes
   * transparent (white symbols, since the video behind is dark) and the
   * symbols hide entirely while the controls are auto-hidden, so the buttons
   * come and go with the seek bar.
   *
   * No-ops off the player view and outside Windows (the main handler ignores
   * the overlay on other platforms). Fullscreen has no caption strip at all,
   * so it's skipped rather than fighting the OS for it.
   *
   * @param {boolean|null} visible — controls state; null re-reads the DOM.
   */
  _syncCaptionOverlay(visible = null) {
    if (!window.funsync?.updateWindowChrome) return;
    const theme = this.settings?.get?.('player.theme') || 'dark';
    // The backend banner is the player view's top row while it shows, so the
    // caption buttons are over the banner then, not the video (V80).
    const inPlayer = this._currentView?.() === 'player' && !document.fullscreenElement
      && !document.documentElement.classList.contains('backend-banner-shown');
    // Under a dialog's backdrop the caption buttons dim with the page
    // (FT-100). Main remembers it per window, so it is said when it changes
    // and left out otherwise (every other call stays as it was).
    const dimmed = this._captionDimmed === true;
    const dimOpts = (dimmed || this._captionDimSent) ? { dimmed } : null;
    const dimTag = dimmed ? '-dimmed' : '';
    if (!inPlayer) {
      // Back to the normal themed chrome (idempotent).
      if (this._captionOverlayState !== `normal${dimTag}`) {
        this._captionOverlayState = `normal${dimTag}`;
        try {
          if (dimOpts) window.funsync.updateWindowChrome(theme, dimOpts);
          else window.funsync.updateWindowChrome(theme);
          this._captionDimSent = dimmed;
        } catch { /* non-fatal */ }
      }
      return;
    }
    const shown = visible === null
      ? !!document.querySelector('.player-container.controls-visible')
      : !!visible;
    const next = (shown ? 'over-video' : 'over-video-hidden') + dimTag;
    if (this._captionOverlayState === next) return;
    this._captionOverlayState = next;
    try {
      window.funsync.updateWindowChrome(theme, {
        overVideo: true,
        hideSymbols: !shown,
        // Main needs the caption strip's geometry to tell whether the cursor
        // is over the buttons (they're OS-drawn, so the page gets no hover
        // events there). The draggable titlebar area starts at the left edge;
        // whatever is left of the window width is the caption strip.
        captionRect: this._captionRect(),
        ...(dimOpts || {}),
      });
      this._captionDimSent = dimmed;
    } catch { /* non-fatal */ }
  }

  /**
   * A dialog's backdrop came up (the first dialog opened) or went (the last
   * one closed): modal.js 'modal:backdrop' (FT-100). The OS-drawn caption
   * buttons sat bright over the dimmed window.
   *
   * Each backdrop speaks for itself: Modal's dialogs (no `source`) and the
   * Devices panel's own (`source: 'devices'`, E2-08). The strip stays dimmed
   * while any of them is up, so the Safety Cap confirm closing over the
   * still-open Devices panel does not light the buttons.
   */
  _onModalBackdrop({ dimmed, source = 'modal' } = {}) {
    if (!this._captionDimSources) this._captionDimSources = new Set();
    if (dimmed === true) this._captionDimSources.add(source);
    else this._captionDimSources.delete(source);
    const next = this._captionDimSources.size > 0;
    if (next === (this._captionDimmed === true)) return;
    this._captionDimmed = next;
    this._syncCaptionOverlay();
  }

  /**
   * Caption-button strip in CSS px relative to the content area, or null
   * when the Window Controls Overlay isn't active (non-Windows, or a frame
   * fallback build).
   */
  _captionRect() {
    const wco = navigator.windowControlsOverlay;
    if (!wco?.visible) return null;
    try {
      const r = wco.getTitlebarAreaRect();
      const left = r.x + r.width;
      const width = Math.max(0, window.innerWidth - left);
      if (width <= 0) return null;
      return { x: left, y: 0, width, height: r.height || 48 };
    } catch {
      return null;
    }
  }

  /**
   * Push the configured inline-viz opacity onto the overlay. Stored 20-100
   * (percent) under `player.inlineVizOpacity`, defaulting to 80 so the
   * overlays sit over the video without fully obscuring it.
   */
  _applyInlineVizOpacity(value = null) {
    const raw = value !== null ? value : this.settings?.get?.('player.inlineVizOpacity');
    const pct = Number.isFinite(Number(raw)) ? Number(raw) : INLINE_VIZ_OPACITY_DEFAULT;
    const clamped = Math.min(100, Math.max(20, pct));
    document.documentElement.style.setProperty('--inline-viz-opacity', String(clamped / 100));
  }

  /**
   * Push the configured device-simulator opacity onto the widget. Stored
   * 20-100 (percent) under `player.deviceSimOpacity`, defaulting to 80 to
   * match the inline-viz overlay. Clamped rather than trusted: a hand-edited
   * config should not be able to make the indicator invisible.
   */
  _applyDeviceSimOpacity(value = null) {
    const raw = value !== null ? value : this.settings?.get?.('player.deviceSimOpacity');
    const pct = Number.isFinite(Number(raw)) ? Number(raw) : DEVICE_SIM_OPACITY_DEFAULT;
    const clamped = Math.min(100, Math.max(20, pct));
    document.documentElement.style.setProperty('--device-sim-opacity', String(clamped / 100));
  }

  /**
   * Feed the inline viz alongside the seek-bar heatmap (same data), and
   * show/hide the TL/HM buttons with script availability. Optional
   * overrides for paths that render a script not yet in the engine
   * (multi-axis first-loaded script).
   */
  _feedInlineViz(actionsOverride = null, durationOverride = null) {
    if (!this.inlineViz) return;
    const actions = actionsOverride
      || (this.funscriptEngine?.isLoaded ? this.funscriptEngine.getActions() : null);
    const has = !!(actions && actions.length >= 2);
    if (has) {
      this.inlineViz.setScript(actions, durationOverride || this.videoPlayer?.duration || 0);
    } else {
      this.inlineViz.clear();
    }
    const tlBtn = document.getElementById('btn-inline-tl');
    const hmBtn = document.getElementById('btn-inline-hm');
    if (tlBtn) tlBtn.hidden = !has;
    if (hmBtn) hmBtn.hidden = !has;
  }

  /**
   * Grouping key for balance-by-script: the associated funscript path,
   * case-folded (Windows paths are case-insensitive). Scriptless videos
   * return null → they participate individually.
   */
  _scriptKeyOf(item) {
    const p = item?.funscriptPath;
    return p ? String(p).toLowerCase() : null;
  }

  /** Play a list of videos sequentially (Play All). */
  _playAll(videoList, opts = {}) {
    if (!videoList || videoList.length === 0) return;
    // Unsaved editor edits are asked about before the queue is replaced (CB-01).
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true) {
      return editorOk.then((go) => (go ? this._playAll(videoList, opts) : undefined));
    }
    this._playQueueShuffle = !!opts.shuffle;
    // Balance-by-script (zaikechi #221): only meaningful when shuffling —
    // videos sharing an associated script collapse into one slot with a
    // random member drawn per cycle, so a track with 6 matching videos
    // isn't weighted 6×. The FULL list is kept for loop-wrap redraws
    // (fresh representatives each cycle).
    this._playQueueBalance = this._playQueueShuffle && !!opts.balanceByScript;
    this._playQueueFullList = videoList;
    this._playQueue = this._playAllOrder(videoList, opts);
    this._playQueueIndex = 0;
    this._playQueueLoop = !!opts.loop;
    this._playQueueSource = {
      sourceLabel: opts.sourceLabel || t('upNext.sourcePlaylist'),
      sourceContext: opts.sourceContext || {},
    };
    this._navigateTo('player');
    this._playQueueItem(0);
  }

  /**
   * Play All's play order for `videoList`, under the playlist's `opts`
   * (`shuffle`, `balanceByScript`, `preferUnwatched` + `isWatched`). Shared
   * by Play All and by a shuffled card click or Continue
   * (`_withShuffledStart`), so the two cannot drift apart.
   */
  _playAllOrder(videoList, opts = {}) {
    // Balance-by-script only means something when shuffling.
    const balance = !!opts.shuffle && !!opts.balanceByScript;
    // Bag model: shuffle the whole list ONCE at Play All so there are no
    // repeats within a cycle (per-track random would produce back-to-back
    // repeats that read as "broken shuffle"). Reshuffled on each loop wrap
    // (`_reshuffleQueueForWrap`). SCOPE-playlist-shuffle-reorder.md §7.
    const drawShuffled = (list) => (balance
      ? balancedShuffle(list, (v) => this._scriptKeyOf(v))
      : shuffleArray(list));

    if (!opts.shuffle) return videoList;
    if (opts.preferUnwatched && typeof opts.isWatched === 'function') {
      // Unwatched first, each half shuffled independently so the bag model
      // (and balance-by-script within it) still applies. Watched items are
      // moved to the back rather than dropped — a marathon of a fully-seen
      // playlist must still play.
      const { unwatched: unseen, watched: seen } = partitionByWatched(
        videoList,
        (p) => (opts.isWatched(p) ? { finished: true } : null),
        (v) => v.path,
      );
      return [
        ...(unseen.length ? drawShuffled(unseen) : []),
        ...(seen.length ? drawShuffled(seen) : []),
      ];
    }
    return drawShuffled(videoList);
  }

  /**
   * A playlist card click or Continue with the playlist's Shuffle on (V29,
   * Dave's call 2026-11-02): the chosen video plays first, exactly as it
   * would unshuffled, and the rest follow in Play All's order (unwatched
   * first, balance by script). Returns the context to play in; anything
   * else gets `ctx` back unchanged.
   *
   * The order goes into the PLAY CONTEXT rather than a Play All queue, so
   * Shuffle changes the order and nothing else: the advances still go
   * through Up Next and `_playFromLibrary` like an unshuffled click, which
   * keeps "Auto-play the next video" (Play All's `_playQueueItem` always
   * autoplays; since V72 it loads the same scripts and axes as a click).
   *
   * With balance on, the chosen video takes its script group's slot, so
   * the rest of the cycle draws from the other groups. `shufflePool` keeps
   * the whole list for the loop-wrap redraw, as `_playQueueFullList` does.
   * `videoData._shuffle` (from Playlists `_shuffleRequest`) is consumed here.
   */
  _withShuffledStart(ctx, videoData) {
    const req = videoData?._shuffle;
    if (req) delete videoData._shuffle; // rides this one open, never an advance
    if (!ctx || !req || !Array.isArray(req.videoList) || !videoData.path) return ctx;
    const start = req.videoList.find((v) => v.path === videoData.path)
      || { name: videoData.name, path: videoData.path, funscriptPath: null };
    const balance = !!req.balanceByScript;
    const startKey = balance ? this._scriptKeyOf(start) : null;
    const rest = req.videoList.filter((v) => v.path !== start.path
      && !(startKey && this._scriptKeyOf(v) === startKey));
    const order = [start, ...this._playAllOrder(rest, { ...req, shuffle: true })];
    return {
      ...ctx,
      list: order.map((v) => v.path),
      index: 0,
      shuffle: true,
      shuffleBalance: balance,
      shufflePool: req.videoList.map((v) => ({ path: v.path, funscriptPath: v.funscriptPath || null })),
    };
  }

  _playQueueItem(index, { auto = false } = {}) {
    if (index >= this._playQueue.length) return;
    // Unsaved editor edits are asked about first, Next and the ended advance
    // included (CB-01); a Cancel leaves the current item playing.
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true) {
      const options = arguments[1]; // all of them, as called
      return editorOk.then((go) => (go ? this._playQueueItem(index, options) : undefined));
    }
    const item = this._playQueue[index];
    this._playQueueIndex = index;

    // Flush the OUTGOING video's position while `_currentPlayContext` still
    // describes it — the assignment below replaces it. Queue advances do
    // NOT route through `_playFromLibrary` (they call `loadVideo` directly),
    // so without this and the resume application further down, the whole
    // resume feature was dead during Play All: positions accumulated and
    // were never used, and the Up Next card's Resume / Start over buttons
    // silently did nothing.
    const outgoing = this._currentVideoPath;
    if (outgoing && outgoing !== item.path) {
      this._recordResumePosition({ force: true, path: outgoing });
    }

    // Feed the Up Next engine the queue context so the card shows the
    // correct "next" item and only fires end-of-list on the actual last
    // item. SCOPE-up-next.md §5 specified this; the wiring was missed
    // until a community report flagged "no more videos" on a v1-of-2.
    // When the playlist is set to loop, `loop: true` flips the engine
    // into wrap-mode — the last item shows "next: <item 1>" instead of
    // end-of-list, and the queue ended-listener (below) wraps too.
    this._currentPlayContext = {
      source: 'queue',
      sourceLabel: this._playQueueSource?.sourceLabel || t('upNext.sourcePlaylist'),
      sourceContext: this._playQueueSource?.sourceContext || {},
      list: this._playQueue.map((v) => v.path),
      index,
      loop: !!this._playQueueLoop,
    };
    this._setUpNextContext(this._currentPlayContext);

    // Play All always auto-plays each queue item — gate playback on
    // every connected cloud-sync device's upload so the next video
    // doesn't race ahead of Handy / Autoblow re-upload. Marked right
    // after loadVideo below, which clears any earlier gate (FT-112).

    // Resume. A queue advance is always a flow-through arrival — nobody
    // clicked this specific video — so it resumes silently with a toast
    // rather than prompting, matching every other flow-through path.
    // `_upNextStartOver` is consumed unconditionally so a Start over chosen
    // on the Up Next card can't leak into the item after this one.
    const startOverRequested = this._upNextStartOver === true;
    this._upNextStartOver = false;
    let resumeAt = null;
    if (this._isPlaylistContext(this._currentPlayContext)) {
      const entry = this.getResumeEntry(item.path);
      if (!startOverRequested && shouldOfferResume(entry)) {
        resumeAt = entry.position;
        showToast(t('resume.resumedToast', { time: formatResumeTime(entry.position) }), 'info', 4000);
      }
    }

    const fileData = { name: item.name, path: item.path, _isPathBased: true };
    // The previous video's routing goes before loadVideo, as for a library
    // click (`_playFromLibrary`): loadVideo leaves the device assignment map
    // alone, and this item may bring routing of its own now (V72).
    this._resetCustomRoutingState();
    // Play All autoplays every item, but on the surface that owns playback:
    // with the pop-out open the inline <video> only holds the file, and
    // autoplaying it started a hidden copy in lockstep with the pop-out on
    // every item (V13). The route below autoplays the pop-out instead.
    this.loadVideo(fileData, { skipViewSwitch: true, autoPlay: !this._playerWindowActive });
    if (item.funscriptPath) this._markCloudUploadsPending();
    // Before playback starts, so the sync engine anchors at the resumed
    // position instead of the seek-correction path fixing it up after.
    if (resumeAt) this._applyPendingResumeSeek(resumeAt);

    // Scripts, companion axes, routing, variants, subtitle: what a library
    // click on this video loads (V72). Not awaited, as the script read never
    // was: the queue UI, the pop-out route and the ended listener below must
    // not wait on file reads.
    this._loadQueueItemContent(item, fileData).catch((err) => {
      console.warn('[Queue] loading the item\'s scripts failed:', err?.message || err);
    });

    this._updateQueueUI();
    // Queue nav while the pop-out is open → route the new item into it.
    // An end-of-video advance does not raise a minimised window (V16).
    this._routeLoadedVideoToPlayerWindow(true, auto ? { reveal: false } : {});

    this._armQueueEndedListener();
  }

  /**
   * Play All's own advance at the end of the playing video (the inline
   * <video>; the pop-out reports its end through `_onPopoutVideoEnded`).
   * Armed by `_playQueueItem` and by a video from your queue played in the
   * middle of Play All (R3-15); every `loadVideo` disarms it.
   *
   * The local-var supersede guard prevents a stale in-flight listener from
   * double-advancing when Up Next routed the same `ended` event back through
   * `_playQueueItem` (the old listener is captured in the event dispatch
   * loop before `removeEventListener` can take effect).
   *
   * It fires once, then removes itself. When the advance asked about unsaved
   * editor edits and did not go on (Cancel, or Up Next's question already
   * open), it arms again for the same video: Cancel means "not now", and Play
   * All used to stay dead for that video with Up Next off or not driving
   * (R3-09). Not when another video has loaded meanwhile.
   */
  _armQueueEndedListener() {
    const video = this.videoPlayer?.video;
    if (!video) return;
    if (this._queueEndedListener) video.removeEventListener('ended', this._queueEndedListener);
    const gen = this._videoLoadGen;
    const queueEndedListener = () => {
      if (this._queueEndedListener !== queueEndedListener) return; // superseded
      video.removeEventListener('ended', queueEndedListener);
      this._queueEndedListener = null;
      const advanced = this._advanceQueueOnEnded();
      if (advanced && typeof advanced.then === 'function') {
        advanced.then((went) => {
          if (!went && this._queueEndedListener === null && this._videoLoadGen === gen) {
            this._armQueueEndedListener();
          }
        });
      }
    };
    this._queueEndedListener = queueEndedListener;
    video.addEventListener('ended', queueEndedListener);
  }

  /**
   * A Play All item's scripts, exactly as a library click on the same video
   * loads them (V72). The library's record is resolved by the SAME
   * `Library.resolvePlayData` a click uses (main script, companion axis
   * files, custom routing, subtitle, variants) and loaded by the same
   * `_loadPlayContent` (variants, pinned or random variant included). Play
   * All used to read the main script only, so a multi-axis or routed setup
   * played single-axis for the whole playlist. A path the library does not
   * hold (a playlist entry whose source was removed) still gets the queue
   * item's own script, as before.
   *
   * Reads for an item the user already skipped past must not land on the
   * next one: `_videoLoadGen`, bumped by every loadVideo, says which is live.
   */
  async _loadQueueItemContent(item, fileData) {
    const gen = this._videoLoadGen;
    const libVideo = this.library?.getVideoByPath?.(item.path) || null;
    let scriptPath = item.funscriptPath || null;
    let funscriptData = null;
    let subtitleData = null;
    let variants = [];
    let readError = null;
    if (libVideo && typeof this.library.resolvePlayData === 'function') {
      // What a click would read: the record's script, not the queue's guess.
      scriptPath = (libVideo.hasFunscript && libVideo.funscriptPath) || null;
      let triedSidecar = null;
      ({ funscriptData, subtitleData, variants, scriptError: readError, triedSidecar } =
        await this.library.resolvePlayData(libVideo));
      // The record says no script, but the playlist's own pick (an
      // association, else `<name>.funscript`) may find one: a script added
      // since the last scan, which the library has no watcher to notice.
      // Play All loaded it before V72 and a playlist card click still does
      // (`_playVideoByPath`). Read quietly: a video that really has no
      // script must not get a "couldn't be read" toast. `resolvePlayData`
      // already looked for `<name>.funscript` (FT-069): not read twice.
      if (!scriptPath && item.funscriptPath && item.funscriptPath !== triedSidecar
          && !funscriptData?.textContent && !funscriptData?._customRouting) {
        let content = null;
        try { content = await window.funsync.readFunscript(item.funscriptPath); } catch { /* quiet */ }
        if (content) {
          funscriptData = {
            ...funscriptData, // keeps a vib-only `_multiAxis`
            name: item.funscriptPath.split(/[\\/]/).pop(),
            textContent: content,
            _funscriptPath: item.funscriptPath,
          };
        }
      }
    } else if (scriptPath) {
      try {
        const content = await window.funsync.readFunscript(scriptPath);
        if (content) {
          funscriptData = {
            name: scriptPath.split(/[\\/]/).pop(), textContent: content, _funscriptPath: scriptPath,
          };
        }
      } catch (err) {
        readError = err;
      }
      // Only a script the app EXPECTED may warn: an association, or the
      // pairing the library held when the queue was built. `<name>.funscript`,
      // guessed for a video with neither, is usually just not there, and a
      // scriptless video from a removed source toasted "couldn't be read"
      // for a script that never existed (CB-12).
      if (!funscriptData?.textContent && item.scriptExpected === false) {
        console.debug?.('[Queue] no script at the guessed path:', scriptPath, readError?.message || '');
        scriptPath = null;
        readError = null;
      }
    }
    if (this._videoLoadGen !== gen) return; // skipped past while reading

    await this._loadPlayContent(fileData, funscriptData, subtitleData, variants);
    if (this._videoLoadGen !== gen) return;

    // No main script loaded, so no upload will lift the autoplay gate Play
    // All set for this item: it plays now, not after the 8 s fallback and
    // its "upload timed out" toast (FT-112).
    if (!funscriptData?.textContent) {
      this._resolveCloudUpload('handy');
      this._resolveCloudUpload('autoblow');
    }

    // A script was expected and none loaded (custom routing may have
    // promoted its main route meanwhile). Silent skip would leave the user
    // wondering why the next video plays with no device sync — surface it.
    if (scriptPath && !funscriptData?.textContent) {
      const fsName = scriptPath.split(/[\\/]/).pop();
      showToast(readError
        ? t('toast.queueReadError', { name: item.name, error: readError.message })
        : t('toast.queueReadFailed', { name: item.name, script: fsName }), 'warn', 5000);
    }
    // Re-stream now the script is loaded so the pop-out heatmap and
    // variant list fill.
    if (this._playerWindowActive) this._streamPlayerWindowData();
  }

  /**
   * Play-All advance on natural video end. Shared by the inline
   * `queueEndedListener` and the pop-out's `_onPopoutVideoEnded` so both
   * surfaces continue the queue identically. Returns true if it advanced,
   * false when nothing follows, or, when it had to ask about unsaved editor
   * edits first, a Promise of whether it went on: the inline listener re-arms
   * on `false` (R3-09).
   */
  _advanceQueueOnEnded() {
    // A video from your queue is already loading as this video's advance (Up
    // Next's countdown, a beat before `ended`): it is the one advance. This
    // end found your queue empty and played Play All's next item as well
    // (R3-15 fix-up). Only if that jump loaded nothing (the file is gone)
    // does this end go on, as it did before, once the jump has settled.
    const jump = this._queueJumpPending;
    if (jump && jump.gen === this._videoLoadGen) {
      const gen = this._videoLoadGen;
      return jump.done.then(() => (this._videoLoadGen === gen ? this._advanceQueueOnEnded() === true : false));
    }
    const queued = !!(this._userQueue && this._userQueue.length > 0);
    // Decide what follows, then ask, then move anything (R3-10). The user
    // queue's head came off the queue, and a shuffled wrap drew its order,
    // before the load asked; Cancel dropped the queued video. Nothing next:
    // no question for nothing.
    if (!queued && !this._nextQueueStep()) return false;
    const editorOk = this._editorAllowsReplace();
    if (editorOk !== true) {
      // A Cancel (or another route's question already open) changes nothing.
      return Promise.resolve(editorOk)
        .then((go) => (go ? this._advanceQueueOnEnded() === true : false), () => false);
    }
    // User queue priority — when present, intercepts Play All advancement
    // so a queued video plays next rather than the next playlist item.
    // Mirrors the same priority injection in _playUpNext (SCOPE §3.2 #3).
    if (queued) {
      // `_jumpToVideoFromQueue` takes it off the queue once it plays (R3-10).
      const next = this._userQueue[0];
      // Keep the mini-player docked across this auto-advance (see _playUpNext).
      // _jumpToVideoFromQueue is async; hold the flag until its load settles.
      this._autoAdvancing = true;
      Promise.resolve(this._jumpToVideoFromQueue(next, { autoPlay: this._autoplayOnAdvance() })) // CB-11
        .finally(() => { this._autoAdvancing = false; });
      return true;
    }
    // The same decision the Up Next card names (CB-10): the next slot a
    // removed or switched-off source does not hold. This used to play slot
    // index+1 whatever it held.
    const step = this._nextQueueStep();
    if (!step) return false;
    // A wrap (Loop on the playlist: no end-of-list, continuous marathon mode
    // until they pause / navigate away). A shuffled queue gets a fresh order
    // first, the same as an Up Next wrap: this is the advance whenever Up
    // Next is not driving (Up Next off, the pop-out's end), and it used to
    // replay the identical order every cycle (V28).
    if (step.wrap) this._reshuffleQueueForWrap();
    this._playQueueItem(step.index, { auto: true });
    return true;
  }

  /**
   * New loop cycle on a shuffled Play All queue: reshuffle for variety,
   * avoiding an immediate repeat of the item that just played (the last
   * one). Balanced queues redraw from the FULL list so each cycle can pick
   * different representatives of each script group (that's the point:
   * same track, different visuals), avoiding the just-played GROUP.
   *
   * Shared by BOTH wrap paths — `_playUpNextInner` (Up Next drove the
   * advance) and `_advanceQueueOnEnded` (Up Next off, or the pop-out's
   * end). Only the first had it, so with Up Next off every wrap replayed
   * the same order (V28). No-op unless the queue is shuffled and has two
   * or more items.
   */
  _reshuffleQueueForWrap() {
    if (!this._playQueueShuffle || !Array.isArray(this._playQueue) || this._playQueue.length < 2) return;
    // The draw the card already named, when it named one (CB-10).
    this._playQueue = this._queueWrapOrder();
    this._pendingWrapOrder = null;
  }

  /**
   * The next loop cycle's order: `list` reshuffled, or, when `balancedFrom`
   * is given, a balanced redraw from that full list, never starting on
   * `justPlayed` (or its script group). The one rule for both shuffled
   * wraps: Play All's queue and a shuffled playlist context.
   */
  _wrapOrder(list, balancedFrom, justPlayed) {
    return balancedFrom
      ? reshuffleBalancedAvoidingRepeat(balancedFrom, (v) => this._scriptKeyOf(v), justPlayed)
      : reshuffleAvoidingRepeat(list, justPlayed);
  }

  /**
   * The Loop wrap of a shuffled playlist context (`_withShuffledStart`): the
   * same context in a fresh order, from `_wrapOrder` like Play All's queue,
   * and the video it opens on (the first the library holds under a source
   * that is on, preferring one that is not the video that just ended).
   * Without this every cycle replayed the first one's order (V29).
   *
   * Null unless the context is shuffled and looping and nothing after the
   * current entry is left to offer (`_isUpNextPlayable`, the engine's own
   * test), i.e. the next is a wrap; null too when the fresh order has nothing
   * playable (the engine's own pick and the missing-file walk then decide).
   *
   * The ONE wrap decision for the card and the advance (R3-14): the order is
   * drawn once per context and entry (`_pendingContextWrap`) and kept until
   * the advance uses it, so `_resolveUpNext` (what the card names) and
   * `_playUpNextInner` (what plays) read the same draw, the way Play All's
   * queue reads `_queueWrapOrder` (CB-10). It used to be drawn at the advance
   * only, after the card had named the OLD order's first entry. A Cancel at
   * the unsaved-changes question keeps the draw for the next end.
   *
   * @returns {{ ctx: object, path: string, index: number } | null}
   */
  _reshuffleContextForWrap(ctx) {
    if (!ctx?.shuffle || !ctx.loop || !Array.isArray(ctx.list) || ctx.list.length < 2) return null;
    const at = ctx.index || 0;
    for (let i = at + 1; i < ctx.list.length; i++) {
      if (this._isUpNextPlayable(ctx.list[i])) return null; // onward, not a wrap
    }
    let memo = this._pendingContextWrap;
    if (!memo || memo.list !== ctx.list || memo.index !== at) {
      // Items with their script, compared by identity, so the avoid-repeat
      // check recognises the video that just played.
      const pool = Array.isArray(ctx.shufflePool) ? ctx.shufflePool : [];
      const byPath = new Map(pool.map((v) => [v.path, v]));
      const items = ctx.list.map((p) => byPath.get(p) || { path: p, funscriptPath: null });
      const fresh = this._wrapOrder(items, ctx.shuffleBalance && pool.length ? pool : null, items[at]);
      memo = { list: ctx.list, index: at, order: fresh.map((v) => v.path) };
      this._pendingContextWrap = memo;
    }
    const playable = (p) => !!this.library?.getVideoByPath?.(p) && this._isUnderEnabledSource(p);
    const justPlayed = ctx.list[at];
    let first = memo.order.findIndex((p) => p !== justPlayed && playable(p));
    if (first < 0) first = memo.order.findIndex(playable);
    if (first < 0) return null;
    return { ctx: { ...ctx, list: memo.order }, path: memo.order[first], index: first };
  }

  _playPrev() {
    // FN-07 (Dave 2026-11-17, also in v0.9.2): from a video your queue
    // played, back is the video it followed (the Library video the queue
    // started from, or the queued one before it), and the video you leave
    // goes back to the head of your queue, so N plays it again. Unsaved
    // editor edits are asked about first; Cancel changes nothing.
    const back = this._userQueueBackHere?.() || null;
    if (back) {
      const editorOk = this._editorAllowsReplace();
      if (editorOk !== true) {
        return Promise.resolve(editorOk).then((go) => (go ? this._playPrev() : false), () => false);
      }
      this._userQueueBack.pop();
      if (!this._userQueue.includes(back.to)) {
        this._userQueue.unshift(back.to);
        this._persistUserQueue();
        this._updateQueuePanelState?.();
      }
      // In the middle of Play All the item it followed is Play All's own
      // back, below (R3-15).
      if (!this._currentPlayContext?.interlude) return this._playUserQueueBack(back);
    }
    // Step over slots Up Next would not offer (a removed source's videos),
    // as Next does (CB-10). From a video of your queue played in the middle
    // of Play All (R3-15), back is the item it followed.
    const from = this._playQueueIndex + (this._currentPlayContext?.interlude ? 1 : 0);
    for (let i = from - 1; i >= 0; i--) {
      const path = this._playQueue[i]?.path;
      if (path && this._isUpNextPlayable(path)) {
        this._playQueueItem(i);
        return true;
      }
    }
    return this._stepPlayContext(-1);
  }

  _playNext() {
    // Your own queue first (FN-07, Dave 2026-11-17, also in v0.9.2), as the
    // end-of-video advance and Up Next play it and the queue panel lists it:
    // N did nothing with a Library video and "Add to queue" items. A manual
    // Next is an explicit request, so it plays whatever "Auto-play the next
    // video" says, as Next in a playlist does.
    if (Array.isArray(this._userQueue) && this._userQueue.length > 0) {
      this._navigationalArrivals = (this._navigationalArrivals || 0) + 1;
      Promise.resolve(this._jumpToVideoFromQueue(this._userQueue[0], { autoPlay: true }))
        .catch((err) => console.warn('[Queue] Next from your queue failed:', err?.message || err))
        .finally(() => {
          this._navigationalArrivals = Math.max(0, (this._navigationalArrivals || 1) - 1);
        });
      return true;
    }
    // The queue's own next, as the card and the advances pick it (CB-10).
    // A manual Next does not wrap.
    const step = this._nextQueueStep({ loop: false });
    if (step) {
      this._playQueueItem(step.index);
      return true;
    }
    return this._stepPlayContext(+1);
  }

  /**
   * The way back P takes from the video playing now when your queue played
   * it (FN-07), or null: the last entry, if it is this video's.
   */
  _userQueueBackHere() {
    const top = Array.isArray(this._userQueueBack) ? this._userQueueBack[this._userQueueBack.length - 1] : null;
    return top && this._currentVideoPath && top.to === this._currentVideoPath ? top : null;
  }

  /**
   * Play the video a queued video followed (FN-07), with the play context it
   * had (a playlist goes on from it), as a manual Previous: it plays, and a
   * resume is silent. A video the library does not hold (opened with O or
   * dropped) opens by its path.
   */
  _playUserQueueBack(back) {
    if (!(this._userQueueNavPaths instanceof Set)) this._userQueueNavPaths = new Set();
    this._userQueueNavPaths.add(back.from);
    const ctx = back.fromCtx && back.fromCtx.source !== 'queue' && !back.fromCtx.interlude ? back.fromCtx : null;
    this._navigationalArrivals = (this._navigationalArrivals || 0) + 1;
    const done = () => {
      this._navigationalArrivals = Math.max(0, (this._navigationalArrivals || 1) - 1);
    };
    const video = this.library?.getVideoByPath?.(back.from);
    let load;
    if (video) {
      if (ctx) video._playContextOverride = { ...ctx };
      video._autoPlayOnNextLoad = true;
      load = this.library._playVideo(video);
    } else if (this.playlists?._playVideoByPath) {
      load = this.playlists._playVideoByPath(back.from, ctx ? { ...ctx } : null, { autoPlay: true });
    } else {
      this._userQueueNavPaths.delete(back.from);
      done();
      return false;
    }
    Promise.resolve(load)
      .catch((err) => console.warn('[Queue] Back from your queue failed:', err?.message || err))
      .finally(done);
    return true;
  }

  /**
   * Step to the neighbouring video in the current PLAY CONTEXT — the
   * library/playlist/category list snapshot taken when playback started.
   *
   * Without this, prev/next only ever worked inside a Play All queue,
   * because `_playFromLibrary` clears `_playQueue` on every direct click.
   * A user who opened a video from the library had the buttons hidden and
   * (once the N/P keys landed) two dead shortcuts, which is not what
   * "next video" means to anyone.
   *
   * Uses the same override mechanism as an Up Next advance so the snapshot
   * travels with the new video (same list, moved index) rather than being
   * rebuilt from a possibly re-filtered view mid-session.
   *
   * Queue-sourced contexts are skipped: the queue branch above owns those,
   * and their index counts queue slots, not list entries.
   */
  _stepPlayContext(delta) {
    const ctx = this._currentPlayContext;
    if (!ctx || ctx.source === 'queue') return false;
    // PLAYLISTS ONLY (Dave, 2026-08-06). Stepping through a 1471-video
    // library in scan order isn't a real workflow, and an "N / 1471"
    // counter on a plain library play is noise. A playlist is a curated,
    // ordered list where prev/next means something.
    if (!this._isPlaylistContext(ctx)) return false;
    const list = ctx.list;
    if (!Array.isArray(list) || list.length < 2) return false;

    if (!this.library) return false;

    // STEP OVER unreachable entries rather than dead-ending on them.
    //
    // A playlist that spans an external drive keeps every entry when the
    // drive is unplugged (they render greyed — see playlist-availability.js),
    // so N/P must walk past them to the next thing that can actually play.
    // Stopping at the first one would strand the user mid-playlist with a
    // "not found" toast and no way forward.
    //
    // `unavailablePaths` is the snapshot taken when playback started; the
    // library lookup is the live check. Either one disqualifies an entry.
    const skipped = new Set(ctx.unavailablePaths || []);
    let targetIdx = (ctx.index || 0) + delta;
    let video = null;
    let passedOver = 0;

    while (targetIdx >= 0 && targetIdx < list.length) {
      const path = list[targetIdx];
      const candidate = path ? this.library.getVideoByPath?.(path) : null;
      if (path && candidate && !skipped.has(path)) {
        video = candidate;
        break;
      }
      passedOver += 1;
      targetIdx += delta;
    }

    if (!video) {
      // Nothing playable in that direction. Distinguish "the drive is
      // unplugged" from "you're at the end" — they need different actions.
      if (passedOver > 0) showToast(t('toast.nextAllUnavailable'), 'warn', 3000);
      return false;
    }

    video._playContextOverride = { ...ctx, index: targetIdx };
    // Manual prev/next is an explicit request to watch that video, so it
    // auto-plays regardless of the autoplayOnAdvance setting — that
    // setting governs UNATTENDED advances, which this is not.
    video._autoPlayOnNextLoad = true;

    // Mark this as a flow-through arrival so the resume prompt stays out
    // of the way (see _playFromLibrary).
    //
    // A COUNTER, not a boolean: mashing N starts overlapping loads, and
    // with a boolean the first load's `finally` would clear the flag while
    // a later press was still in flight — so a rapid skip would suddenly
    // pop the resume modal, which is exactly the obstacle course this flag
    // exists to prevent.
    this._navigationalArrivals = (this._navigationalArrivals || 0) + 1;
    Promise.resolve(this.library._playVideo(video))
      .finally(() => {
        this._navigationalArrivals = Math.max(0, (this._navigationalArrivals || 1) - 1);
      });
    return true;
  }

  // --- Resume position: "continue where you left off" (community, 2026-08-05) ---

  _initResumeTracking() {
    const video = this.videoPlayer?.video;
    if (!video) return;

    video.addEventListener('timeupdate', () => this._recordResumePosition());
    video.addEventListener('pause', () => this._recordResumePosition({ force: true }));

    // Natural end clears the entry outright — `_recordResumePosition`
    // lands in the trailing zone and deletes it. Explicit rather than
    // implicit because this is the rule that stops finished videos
    // resuming at their own credits.
    video.addEventListener('ended', () => this._recordResumePosition({ force: true }));

    // A detached pop-out owns the only playing <video>, so none of the
    // listeners above fire while it drives. This tick samples the proxy
    // instead. Cheap: one throttled check per interval, and
    // _recordResumePosition no-ops without a loaded video.
    this._resumeTickTimer = setInterval(() => {
      const clock = this._resumeClockSource();
      if (clock && !clock.paused) this._recordResumePosition();
      // A phone or a headset paused: nothing here hears that, so the next
      // tick saves the paused position from the same clock.
      else if (clock && clock === this._resumeTickPlayingClock && this._isSessionResumeClock(clock)) {
        this._recordResumePosition({ force: true });
      }
      this._resumeTickPlayingClock = clock && !clock.paused ? clock : null;
    }, RESUME_WRITE_INTERVAL_MS);

    // This window's element plays or seeks again: its position is the
    // video's again (see _resumeLocalBehindPath in _recordResumePosition).
    const ownAgain = () => { this._resumeLocalBehindPath = null; };
    video.addEventListener('play', ownAgain);
    video.addEventListener('seeked', ownAgain);

    // Last write on the way out — closing mid-video is exactly when a
    // user expects the position to have been kept.
    window.addEventListener('beforeunload', () => {
      this._recordResumePosition({ force: true });
    });

    // A playlist Reset must actually look reset. Without this the tracker
    // rewrites the currently-playing video's position within seconds and
    // the bar reappears, which reads as "the button did nothing".
    // Suppression is per-path and lifts as soon as another video loads, so
    // continuing to watch after a Reset starts recording again normally.
    eventBus.on('playlist:progressReset', ({ videoPaths }) => {
      if (this._currentVideoPath && (videoPaths || []).includes(this._currentVideoPath)) {
        this._resumeSuppressedPath = this._currentVideoPath;
      }
    });
  }

  /**
   * Clock to read position from. Deliberately routed through the Up Next
   * engine's player reference, which `_activatePlayerWindow` /
   * `_deactivatePlayerWindow` already swap between the local `<video>` and
   * the RemotePlaybackProxy. Reading `videoPlayer.video` directly would
   * record zeros the whole time the pop-out is driving playback — the same
   * trap that broke Up Next auto-advance when the pop-out shipped.
   */
  _resumeClockSource() {
    // A phone or a headset plays ITS video, and every sample is written
    // against this window's video. Its clock stands in only when the session
    // plays that same file. A phone playing B while a playlist had A open
    // wrote B's position over A's bookmark, and a glance at B under 10 s
    // deleted it (found 2026-11-07, also in v0.9.2). No clock then: this
    // window's video is paused under the session, so nothing records.
    const local = this._currentVideoPath || null;
    // A phone controlling playback is the third surface (after the desktop
    // element and the pop-out). Unlike the pop-out, the web-remote path
    // does NOT repoint `upNextEngine.player`, so without this branch every
    // sample during a phone session would read the intentionally-paused
    // desktop element: no recording while the phone plays, and a stale
    // position written over a good one at the next video change.
    if (this._remoteActive && this._remoteProxy) {
      if (!local || this._phoneSyncOffsetPath !== local) return null;
      if (!this._remoteResumeClock || this._remoteResumeClockFor !== this._remoteProxy) {
        this._remoteResumeClock = this._remoteProxy.asVideoPlayerWrapper();
        this._remoteResumeClockFor = this._remoteProxy;
      }
      return this._remoteResumeClock;
    }
    // The fourth: a HereSphere / DeoVR headset playing this window's video
    // (FT-097 check 6, verify-1 2026-11-07; also in v0.9.2). The resume
    // clock had no VR branch, so 32 s played in the headset changed
    // nothing. `_vrSyncOffsetPath` is the local file its video matched,
    // set when its script took the devices.
    if (this._vrPlayerRef && local && this._vrSyncOffsetPath === local) return this._vrPlayerRef;
    return this.upNextEngine?.player || this.videoPlayer?.video || null;
  }

  /** Whether `clock` is a phone's or a headset's, not this window's own. */
  _isSessionResumeClock(clock) {
    return !!clock && (clock === this._remoteResumeClock || clock === this._vrPlayerRef);
  }

  /**
   * Resume is a PLAYLIST feature, deliberately. Dave's call: the main
   * library is a browsing surface and shouldn't carry watch-progress
   * marks, so nothing is recorded, displayed or prompted for a plain
   * library or category play.
   *
   * Two shapes count as playlist playback: a direct play from a playlist
   * (`source: 'playlist'`), and a Play All queue started FROM a playlist,
   * which reports `source: 'queue'` but carries the playlist id forward in
   * its sourceContext.
   */
  _isPlaylistContext(ctx) {
    return !!this._playlistIdOf(ctx);
  }

  /**
   * Playlist id behind a play context, or null.
   *
   * Two sourceContext shapes exist and both have to be understood, which
   * is easy to miss: a direct playlist play carries `{ playlistId }`, but
   * Play All builds a QUEUE whose context carries `{ kind: 'playlist', id }`.
   * Reading only the first meant Play All — the main way anyone watches a
   * playlist — recorded nothing at all.
   */
  _playlistIdOf(ctx) {
    if (!ctx) return null;
    // A video from your queue played in the middle of Play All (R3-15) is not
    // one of the playlist's: no resume prompt or Last watched for it there.
    if (ctx.interlude) return null;
    const sc = ctx.sourceContext || {};
    if (ctx.source === 'playlist') return sc.playlistId || sc.id || null;
    if (ctx.source === 'queue') {
      if (sc.playlistId) return sc.playlistId;
      if (sc.kind === 'playlist' && sc.id) return sc.id;
    }
    return null;
  }

  _resumeMap() {
    return this.settings?.get?.('library.resumePositions') || {};
  }

  /** Public-ish read for library / playlists card rendering. */
  getResumeEntry(path) {
    if (!path) return null;
    return this._resumeMap()[path] || null;
  }

  _writeResumeEntry(path, entry) {
    if (!path) return;
    const map = { ...this._resumeMap() };
    if (entry) map[path] = entry;
    else if (!(path in map)) return; // nothing to clear — skip the write
    else delete map[path];
    this.settings?.set?.('library.resumePositions', map);
  }

  /**
   * Sample the current position and persist it if it's worth keeping.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force] bypass the write throttle (pause, ended,
   *   video change, app teardown — the moments where losing the last few
   *   seconds would actually be noticed)
   * @param {string} [opts.path] record against this path instead of the
   *   currently-loaded one, for flushing the OUTGOING video mid-swap
   */
  _recordResumePosition({ force = false, path } = {}) {
    const target = path || this._currentVideoPath;
    if (!target) return;

    // Suppressed by a playlist Reset until this video is swapped out.
    if (this._resumeSuppressedPath && this._resumeSuppressedPath === target) return;

    // Playlist playback only. A library or category play leaves no trace,
    // and critically does NOT overwrite a position saved from a playlist —
    // watching something from the library can't clobber your bookmark.
    if (!this._isPlaylistContext(this._currentPlayContext)) return;

    const now = Date.now();
    if (!force && now - (this._lastResumeWriteAt || 0) < RESUME_WRITE_INTERVAL_MS) return;

    const clock = this._resumeClockSource();
    if (!clock) return;
    // A phone or a headset recorded this video past where this window's own
    // element is paused. That element is stale until it plays or seeks here
    // (_initResumeTracking): a write from it at quit or at the next video
    // change put the old position back over the session's.
    if (this._isSessionResumeClock(clock)) this._resumeLocalBehindPath = target;
    else if (this._resumeLocalBehindPath === target
      && (clock === this.videoPlayer || clock === this.videoPlayer?.video)) return;
    const position = Number(clock.currentTime);
    const duration = Number(clock.duration);

    const prev = this.getResumeEntry(target);

    if (shouldRecordPosition(position, duration)) {
      // Skip a write that wouldn't meaningfully change what's stored. The
      // store rewrites the entire config file per write, so a no-op save is
      // real disk cost for nothing.
      // The watched mark can't change in this branch (it's carried forward
      // from `prev` either way), so position drift is the only thing that
      // decides whether a write is worth making.
      const unchanged = Number.isFinite(prev?.position)
        && Math.abs(prev.position - position) < RESUME_MIN_DELTA_SECONDS;
      if (unchanged && !force) {
        this._lastResumeWriteAt = now;
        return;
      }
      // No watched mark: recording a position means this video is in
      // progress, which clears "watched". Rewatching something and stopping
      // half way must show where you got to, not a tick — and Continue must
      // not skip a video you're actively part-way through.
      this._writeResumeEntry(target, makeResumeEntry(position, duration, now));
      this._markPlaylistLastWatched(target, now);
      this._lastResumeWriteAt = now;
      return;
    }

    if (!Number.isFinite(duration) || duration <= 0) return;

    // Past the tail — watched. The position is dropped (a finished video
    // must not resume at its own credits) but the fact of having watched
    // it is KEPT, which is what drives the watched marks, the playlist
    // summary, unwatched-first shuffle, and Continue skipping past it.
    if (position >= endThreshold(duration)) {
      this._writeResumeEntry(target, makeFinishedEntry(duration, now));
      // The marker still moves here. Finishing is very much "where I got
      // to"; leaving it on an earlier video would point backwards.
      this._markPlaylistLastWatched(target, now);
      this._lastResumeWriteAt = now;
      return;
    }

    // Before the minimum — a glance. Any stored POSITION is stale, but a
    // watched mark must survive: opening something you've seen and closing
    // it after five seconds shouldn't un-watch it.
    if (isFinished(prev)) {
      this._writeResumeEntry(target, makeFinishedEntry(prev.duration || duration, prev.updatedAt || now));
    } else {
      this._writeResumeEntry(target, null);
    }
    this._lastResumeWriteAt = now;
  }

  /**
   * Record which video in the current playlist was last watched. Survives
   * restarts (it's in the store), and drives the playlist's "Last watched"
   * marker and Continue button.
   */
  /**
   * Resume choice for the Up Next card: `{ label }` when the NEXT video has
   * a saved position worth offering, else null (which renders no row).
   *
   * Playlists only, same gate as everything else in this feature — the
   * current context is the right thing to test because Up Next advances
   * within the context it's already playing.
   */
  _upNextResumeChoice(path) {
    if (!path) return null;
    if (!this._isPlaylistContext(this._currentPlayContext)) return null;
    const entry = this.getResumeEntry(path);
    if (!shouldOfferResume(entry)) return null;
    return { label: formatResumeTime(entry.position), position: entry.position };
  }

  _markPlaylistLastWatched(videoPath, now) {
    const playlistId = this._playlistIdOf(this._currentPlayContext);
    if (!playlistId || !videoPath) return;
    // A Stash group's playlist (id 'stash-group:<id>', stash-groups.js) is
    // derived from the Stash data and never stored: nothing in config.json
    // is keyed by it (Stash "next" lot #6).
    if (String(playlistId).startsWith('stash-group:')) return;
    const map = { ...(this.settings?.get?.('library.playlistProgress') || {}) };
    const prev = map[playlistId];
    if (prev?.lastVideoPath === videoPath) return; // no-op write guard
    map[playlistId] = { lastVideoPath: videoPath, updatedAt: now };
    this.settings?.set?.('library.playlistProgress', map);
  }

  /**
   * Ask whether to resume, and return the position to seek to (or null to
   * start from the beginning). Called before the video loads so the seek
   * can be applied on `loadedmetadata`, i.e. BEFORE playback starts — that
   * way the sync engine's normal play-anchor does the work instead of the
   * seek-correction path, which is the fragile one for cloud HSSP devices.
   */
  async _maybeOfferResume(videoPath, knownDuration) {
    if (!videoPath) return null;
    const entry = this.getResumeEntry(videoPath);
    if (!shouldOfferResume(entry, knownDuration)) return null;

    const label = formatResumeTime(entry.position);
    const choice = await Modal.open({
      title: t('resume.title'),
      onRender(body, close) {
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = t('resume.message', { time: label });
        body.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const startOverBtn = document.createElement('button');
        startOverBtn.className = 'modal-btn modal-btn--secondary';
        startOverBtn.textContent = t('resume.startOver');
        startOverBtn.addEventListener('click', () => close('start-over'));

        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'modal-btn';
        resumeBtn.textContent = t('resume.resumeAt', { time: label });
        resumeBtn.addEventListener('click', () => close('resume'));

        actions.appendChild(startOverBtn);
        actions.appendChild(resumeBtn);
        body.appendChild(actions);
        // Resume is the reason they clicked the thing they were watching,
        // so it takes initial focus and Enter picks it.
        requestAnimationFrame(() => resumeBtn.focus());
      },
    });

    // Escape / backdrop / close-button all resolve null. Treat that as
    // resume rather than start-over: dismissing a dialog should not
    // silently discard the position they had.
    if (choice === 'start-over') return null;
    return entry.position;
  }

  /**
   * Apply a pending resume seek once the video knows its own duration.
   * One-shot: the listener removes itself so a later manual seek or a
   * subsequent load can't re-trigger it.
   */
  _applyPendingResumeSeek(seconds) {
    const video = this.videoPlayer?.video;
    if (!video || !Number.isFinite(seconds) || seconds <= 0) return;
    const seek = () => {
      video.removeEventListener('loadedmetadata', seek);
      if (this._pendingResumeSeek === seek) this._pendingResumeSeek = null;
      // Re-validate against the duration we now actually know.
      if (Number.isFinite(video.duration) && video.duration > 0 && seconds < video.duration) {
        video.currentTime = seconds;
      }
    };
    if (Number.isFinite(video.duration) && video.duration > 0) {
      seek();
    } else {
      // Kept so the next loadVideo can drop it: a load that never reaches
      // metadata (a missing file, V10) would otherwise hand this video's
      // resume position to whatever loads next, e.g. Play All's next item.
      this._pendingResumeSeek = seek;
      video.addEventListener('loadedmetadata', seek);
    }
  }

  _updateQueueUI() {
    const hasQueue = this._playQueue.length > 1;
    // Fall back to the play context so prev/next are live during ordinary
    // library playback, not just inside a Play All queue. Queue-sourced
    // contexts are excluded — the queue branch above already describes them.
    const ctx = this._currentPlayContext;
    // Same playlist-only gate as _stepPlayContext: no buttons and no
    // "N / total" indicator for library or category playback.
    const ctxList = (ctx && ctx.source !== 'queue' && this._isPlaylistContext(ctx) && Array.isArray(ctx.list))
      ? ctx.list
      : null;
    const hasContext = !hasQueue && !!ctxList && ctxList.length > 1;
    const ctxIndex = ctx?.index || 0;
    // Your own queue (FN-07): Next plays its head and Prev goes back from a
    // video it played (`_playNext` / `_playPrev`), so both buttons say so.
    const userNext = Array.isArray(this._userQueue) && this._userQueue.length > 0;
    const userBack = !!this._userQueueBackHere?.();
    const counted = hasQueue || hasContext;
    const show = counted || userNext || userBack;
    // A video from your queue in the middle of Play All (R3-15) is no slot of
    // the Play All: the counter showed the item it followed ("1 / 3"), so it
    // is hidden while that video plays (R4-02). Back goes to the item it
    // followed (`_playPrev`), so Prev stays on, even after the first item.
    const interlude = hasQueue && ctx?.interlude === true;

    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const indicator = document.getElementById('queue-indicator');
    if (btnPrev) {
      btnPrev.hidden = !show;
      btnPrev.disabled = !userBack && (hasQueue
        ? (!interlude && this._playQueueIndex <= 0)
        : ctxIndex <= 0);
    }
    if (btnNext) {
      btnNext.hidden = !show;
      btnNext.disabled = !userNext && (hasQueue
        ? this._playQueueIndex >= this._playQueue.length - 1
        : ctxIndex >= (ctxList ? ctxList.length - 1 : 0));
    }
    if (indicator) {
      // "N / total" counts a Play All or a playlist; your queue has no count.
      indicator.hidden = !counted || interlude;
      if (interlude) {
        indicator.textContent = '';
      } else if (hasQueue) {
        indicator.textContent = `${this._playQueueIndex + 1} / ${this._playQueue.length}`;
      } else if (hasContext) {
        indicator.textContent = `${ctxIndex + 1} / ${ctxList.length}`;
      }
    }
    // Mirror the queue state into the detached player window. Context-driven
    // playback counts too — the pop-out relays its prev/next (and its own n/p
    // keys) straight back to _playPrev/_playNext, which now handle both.
    if (this._playerWindowOpen) {
      window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.QUEUE_STATE, {
        hasPrev: userBack || (hasQueue ? (interlude || this._playQueueIndex > 0) : (hasContext && ctxIndex > 0)),
        hasNext: userNext || (hasQueue
          ? this._playQueueIndex < this._playQueue.length - 1
          : (hasContext && ctxIndex < ctxList.length - 1)),
        label: interlude ? '' : (hasQueue
          ? `${this._playQueueIndex + 1} / ${this._playQueue.length}`
          : (hasContext ? `${ctxIndex + 1} / ${ctxList.length}` : '')),
      }));
    }
  }

  async _quickAddToPlaylist() {
    if (!this._currentVideoPath) {
      showToast(t('toast.addNoPath'), 'warn');
      return;
    }
    const playlists = this.settings.getPlaylists();
    if (playlists.length === 0) {
      showToast(t('toast.noPlaylists'), 'info');
      return;
    }
    const items = playlists.map((p) => ({
      id: p.id,
      label: p.name,
      subtitle: t('library.videoCountSubtitle', { count: p.videoPaths.length }),
    }));
    const selectedId = await Modal.selectFromList(t('library.addToPlaylistTitle'), items);
    if (selectedId) {
      this.settings.addVideoToPlaylist(selectedId, this._currentVideoPath);
      const pl = this.settings.getPlaylist(selectedId);
      showToast(t('toast.addedTo', { name: pl.name }), 'info');
    }
  }

  _showScriptLoadingOverlay() {
    const overlay = document.getElementById('script-loading-overlay');
    if (overlay) overlay.hidden = false;

    // Fallback timeout — if any cloud upload takes too long, force-
    // clear the gate and play anyway. We list the stuck devices in the
    // toast so the user knows which device will be silent, not just
    // "Handy" (Autoblow can be the slow one too).
    this._scriptLoadingTimeout = setTimeout(() => {
      if (this._waitingForScript) {
        const stuck = Array.from(this._pendingUploads).join(', ');
        console.warn(`[Cloud] Script upload timeout (${stuck}) — playing without sync`);
        this._clearCloudUploadGate();
        this._hideScriptLoadingOverlay();
        this._startPlayback(); // the pop-out when detached (V15)
        // Surface the failure — without this, the user sees the video play
        // but the device stays silent and they have no idea why.
        showToast(t('toast.handyUploadTimeout'), 'warn', 8000);
      }
    }, 8000);
  }

  _hideScriptLoadingOverlay() {
    const overlay = document.getElementById('script-loading-overlay');
    if (overlay) overlay.hidden = true;
  }

  /**
   * Mark every currently-connected cloud-sync device as having an
   * upload in flight. Callers use this to defer autoplay until all
   * uploads complete — without this, the video would race ahead while
   * Handy / Autoblow are still uploading (1–3s of silent device).
   *
   * Cloud devices today: Handy (HSSP cloud upload), Autoblow
   * Ultra / VacuGlide 2 (cloud sync API). Local devices (Buttplug,
   * TCode serial) don't need gating — their sync engines spin up the
   * instant the funscript parses, well before video's first frame
   * decodes.
   *
   * If a new cloud device class is added later, extend this method
   * AND its upload completion path must call `_resolveCloudUpload`
   * with the same key on every success / failure / early-exit branch.
   */
  _markCloudUploadsPending() {
    if (this.handyManager?.connected) this._pendingUploads.add('handy');
    if (this.autoblowManager?.connected) this._pendingUploads.add('autoblow');
    this._waitingForScript = this._pendingUploads.size > 0;
  }

  /**
   * Resolve one device's pending upload. If the set is now empty AND
   * the video was waiting, clear the gate + hide the overlay + resume
   * playback. Idempotent — calling with a key that isn't pending is a
   * no-op, so upload functions can call this defensively from every
   * exit path without checking whether the caller actually gated.
   */
  _resolveCloudUpload(deviceKey) {
    if (!this._pendingUploads.has(deviceKey)) return;
    this._pendingUploads.delete(deviceKey);
    if (this._pendingUploads.size === 0 && this._waitingForScript) {
      this._waitingForScript = false;
      if (this._scriptLoadingTimeout) {
        clearTimeout(this._scriptLoadingTimeout);
        this._scriptLoadingTimeout = null;
      }
      this._hideScriptLoadingOverlay();
      // The pop-out when detached: playing the inline <video> there started
      // a hidden copy and left the pop-out paused (V15).
      this._startPlayback();
    }
  }

  /**
   * Hard-reset the gate. Used by the 8s timeout (force play through a
   * stuck upload) and by loadVideo (fresh video discards prior gating).
   */
  _clearCloudUploadGate() {
    this._pendingUploads.clear();
    this._waitingForScript = false;
  }

  _updateCategoryDots() {
    const container = document.getElementById('video-category-dots');
    if (!container) return;
    container.innerHTML = '';
    if (!this._currentVideoPath) return;

    const catIds = this.settings.getVideoCategories(this._currentVideoPath);
    const allCats = this.settings.getCategories();
    for (const catId of catIds) {
      const cat = allCats.find((c) => c.id === catId);
      if (cat) {
        const dot = createCategoryMark(cat, { className: 'player__category-dot' });
        dot.title = cat.name;
        container.appendChild(dot);
      }
    }
  }

  // --- Auto-Updater ---

  _initAutoUpdater() {
    if (!window.funsync.onUpdateEvent) return;

    this._updateCleanup = window.funsync.onUpdateEvent((channel, data) => {
      switch (channel) {
        case 'update:available':
          this._showUpdateToast(data);
          break;
        case 'update:download-progress':
          this._updateDownloadProgress(data);
          break;
        case 'update:downloaded':
          this._showUpdateReadyToast(data);
          break;
        case 'update:error':
          console.warn('[AutoUpdater]', data?.message);
          break;
      }
    });
  }

  // The toasts themselves are shared with the player window (FT-101).
  _showUpdateToast(data) {
    showUpdateAvailableToast(data);
  }

  _updateDownloadProgress(data) {
    // Progress is logged; could add a progress bar in future
    console.log(`[AutoUpdater] Download: ${data.percent}%`);
  }

  _showUpdateReadyToast(data) {
    showUpdateReadyToast(data);
  }
}

// Boot
// Route all renderer console.* into the electron-log file (and capture
// uncaught errors) BEFORE anything else runs, so a user-submitted log file
// contains the full renderer-side diagnostic trail. See logger.js.
installConsoleForwarding();
const app = new App();
// Expose on window so components that live in modals (e.g. the library's
// association dialog) can reach back to clear live-session routing state
// when the user edits the currently-playing video.
window.app = app;
document.addEventListener('DOMContentLoaded', () => {
  app.init().catch((err) => {
    console.error('FATAL: App init failed:', err);
    // Paint a visible error overlay — without this, a fatal init failure
    // leaves the user staring at a blank or half-rendered window with no
    // indication that anything went wrong. The message stays until the
    // user restarts the app (no dismiss), and DevTools has the full stack.
    try {
      const existing = document.getElementById('fatal-init-overlay');
      if (existing) return;
      const overlay = document.createElement('div');
      overlay.id = 'fatal-init-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,15,0.95);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;z-index:99999;font-family:system-ui,sans-serif';
      overlay.innerHTML = `
        <div style="font-size:22px;font-weight:600;margin-bottom:12px;color:#ff6b6b">FunSync failed to start</div>
        <div style="font-size:14px;opacity:0.9;max-width:560px;margin-bottom:18px">
          Something went wrong while the app was loading. This usually means the Python backend
          couldn't start, or a core module failed to load.
        </div>
        <div style="font-size:12px;opacity:0.7;font-family:Consolas,monospace;background:rgba(0,0,0,0.4);padding:10px 14px;border-radius:6px;max-width:680px;word-break:break-word;margin-bottom:18px">
          ${String(err?.message || err).replace(/</g, '&lt;')}
        </div>
        <div style="font-size:12px;opacity:0.7">
          Try restarting the app. If the problem persists, check the log file
          (%LOCALAPPDATA%\\funsync-player\\logs\\main.log) and include it in any bug report.
        </div>
      `;
      document.body.appendChild(overlay);
    } catch { /* last-resort — nothing else to do if DOM is also broken */ }
  });
});
