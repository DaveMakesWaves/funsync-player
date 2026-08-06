// FunSync Player — App Entry Point

import { VideoPlayer, PLAYBACK_RATE_PRESETS } from './video-player.js';
import { eventBus } from './event-bus.js';
import { ProgressBar } from './progress-bar.js';
import { FunscriptEngine, isAutoMatch, stripBOM } from './funscript-engine.js';
import { extractEmbeddedAxes, buildCompanionFiles, companionPathMap } from './embedded-multi-axis.js';
import { AXIS_DEFINITIONS } from './multi-axis.js';
import { HandyManager } from './handy-manager.js';
import { AudienceBridge } from './audience-bridge.js';
import * as AUDIENCE from './audience-popout-protocol.js';
import * as PLAYERWIN from './player-popout-protocol.js';
import { SyncEngine } from './sync-engine.js';
import { ButtplugManager } from './buttplug-manager.js';
import { ButtplugSync } from './buttplug-sync.js';
import { TCodeManager } from './tcode-manager.js';
import { TCodeSync } from './tcode-sync.js';
import { AutoblowManager } from './autoblow-manager.js';
import { AutoblowSync } from './autoblow-sync.js';
import { VRBridge } from './vr-bridge.js';
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
import { maybeShowHevcGuidance } from './hevc-detect.js';
import { initTheme } from './theme-manager.js';
import { matchButtplugRoute } from './custom-routing-match.js';
import { extendRawScriptContent, clampRawScriptContent } from './device-transform-stack.js';
import { normalizeAssociation, buildAssociationEntry, resolveActiveConfig } from './association-shape.js';
import { pathToFileURL, canonicalPath } from './path-utils.js';
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
  EllipsisVertical, Keyboard, Gauge, ChevronDown, Goggles,
  Maximize, Maximize2, Minimize, ArrowLeft, Plus, PictureInPicture2, SkipBack, SkipForward,
  Pencil, FileCheck, Captions, RotateCcw, Columns2, X, Activity, Thermometer,
} from './icons.js';
import { startInit, span, mark, logSummary } from './startup-timer.js';
import { installConsoleForwarding } from './logger.js';
import { isVideoInPip, teardownPlayback, beginDeferredPipTeardown } from './pip-guard.js';
import { shouldEnterMiniplayer, exitFullscreenForNav } from './miniplayer.js';
import { pickRehomeCandidate, findMovedFile } from './association-rehome.js';
import { classifyStereoFormat, isFlattenableStereo, isVRVideo } from './vr-detect.js';
import { HandyHdspSync } from './handy-hdsp-sync.js';
import { OrgasmSwitch } from './orgasm-switch.js';
import { engageHandyFinisher, releaseHandyFinisher } from './orgasm-handy-engage.js';
import { resolveOrgasmPlan, parseFinisherActions, collectOrgasmScriptPaths, describeOrgasmEntry } from './orgasm-plan.js';
import { openOrgasmConfigModal } from '../components/orgasm-config-modal.js';
import { pickVariantIndexOnLoad } from './variant-select.js';
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

/** Default opacity (percent) for the inline TL/HM overlays. */
const INLINE_VIZ_OPACITY_DEFAULT = 80;

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
    this._remotePausedDesktop = false;
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

    // Surface the boot-time auto-recovery result if the main process
    // restored config.json from a snapshot during this launch
    // (SCOPE-data-backup.md §4.4 + §8.2). One-shot read — main clears
    // the stored result after we consume it so a renderer reload
    // doesn't replay the toast.
    this._maybeShowRecoveryToast();

    // Apply the user's theme preference (or follow the OS) before any
    // visual paint hits the user. Cheap (sets one attribute on <html>)
    // and must happen post-dataService-init since we read the setting.
    initTheme(dataService);

    // i18n — load the active-locale bundle BEFORE any component renders
    // so the initial DOM is in the right language. The first-launch
    // language-offer toast (decision #3) fires later from
    // `_offerLocaleIfApplicable` once toast.js is wired.
    await this._initI18n();

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
        // 'rectangle-goggles' (exported as `Goggles`) for the overflow
        // menu's VR Format item — only shown for VR-detected videos.
        Gauge, ChevronDown, Goggles,
        // Queue panel toggle icon (Android Auto split-screen look).
        Columns2,
        // 'maximize-2' for the "Pop out player" overflow item (detached
        // player window, SCOPE-separate-player-window.md).
        Maximize2,
        // Inline visualisation toggles in the overflow menu: 'activity' for
        // the script timeline (pulse-line reads as a motion trace),
        // 'thermometer' for the heatmap strip.
        Activity, Thermometer,
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

    // Fire a fast pre-scan register with JUST the collections / playlists /
    // categories / sources so the phone-remote's Groupings tabs populate
    // within ~100 ms of desktop launch. These are already in memory from
    // `dataService.init()` — no filesystem work to wait on. The library
    // scan will later send the `videos` slice via `_registerWithBackend`;
    // the backend's register endpoint treats each key independently, so
    // this early pass leaves the video registry untouched.
    this._registerGroupingsEarly();

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
    // Linux (native frame) and in pop-outs, so those styles never apply.
    try {
      document.documentElement.classList.toggle(
        'has-wco',
        !!(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible),
      );
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
    this.dragDrop = new DragDrop({
      onVideoFile: (file) => this.loadVideo(file),
      onFunscriptFile: (file) => this.loadFunscript(file),
      onSubtitleFile: (file) => this.videoPlayer.loadSubtitles(file),
      onUnsupported: (msg) => showToast(msg, 'warn', 5000),
    });

    // Nav Bar
    this.settingsPanel = new SettingsPanel({
      settings: this.settings,
      onSourcesChanged: () => {
        this._refreshCollectionsUI();
        if (this.library) this.library._lastScanKey = null;
        if (this._currentView() === 'library') this.library.show(this._getViewEl('library'));
      },
      onGapSkipChanged: (mode, threshold) => {
        if (this.gapSkipEngine) {
          this.gapSkipEngine.setSettings(mode, threshold);
          if (this.funscriptEngine.isLoaded) this._startGapSkip();
        }
      },
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
        return this.library?._countAutoPromotionEligible?.() ?? null;
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
      onInlineVizOpacityChanged: (v) => this._applyInlineVizOpacity(v),
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
      // Snapshot device-connection flags for the "Report a problem"
      // diagnostics bundle. Read defensively — managers may be null
      // (Handy SDK can fail to import; Buttplug isn't always inited).
      getConnectionState: () => ({
        handyConnected: !!this.handyManager?._connected,
        buttplugConnected: !!this.buttplugManager?._connected,
        vrConnected: !!this.vrBridge?.connected,
        deviceCount: this.buttplugManager?._devices?.length || 0,
      }),
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
          mod.openVRModal({ settings: this.settings, vrBridge: this.vrBridge });
        });
      },
      // TEMP DISABLED (2026-07-30): Load-from-URL — see notes/SCRATCHPAD.md.
      // onLoadUrlClick: () => this._openLoadUrlModal(),
      onEroScriptsClick: () => {
        if (!this.eroscriptsPanel) return;
        if (this._currentVideoName && !this.funscriptEngine.isLoaded && !this.eroscriptsPanel._visible) {
          const query = this._currentVideoName.replace(/\.[^/.]+$/, '');
          this.eroscriptsPanel.setSearchQuery(query, true);
        }
        this.eroscriptsPanel.toggle();
      },
      onLibraryCollectionChange: (collectionId) => this._switchCollection(collectionId),
      onNewCollection: () => this._showNewCollectionModal(),
      onRenameCollection: (id) => this._renameCollection(id),
      onDeleteCollection: (id) => this._deleteCollection(id),
      onAddSource: () => this._addSource(),
    });
    this.navBar.init(document.getElementById('app'));
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
    });

    // Categories
    this.categories = new Categories({
      settings: this.settings,
      library: this.library,
      onPlayVideo: (videoData, funscriptData, subtitleData, variants) => this._playFromLibrary(videoData, funscriptData, subtitleData, variants),
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
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overflowMenu.hidden) closeOverflow();
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
    // (or manually flagged) as VR. Single discovery surface inside the
    // player view; users who don't know Ctrl+Shift+R can still reach
    // the panel.
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
    this._wireLoopVideo();

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

    // Redraw heatmap on resize
    window.addEventListener('resize', () => this.progressBar.redraw());
    // Keep the library-view queue panel anchored to the filter/sort bar as
    // the window (and thus the header height) changes while it's open.
    window.addEventListener('resize', () => {
      if (this.queuePanel?.visible) this._positionQueuePanelForLibrary();
    });

    // Gate library hover preview when main video is playing — and
    // refresh the player top-bar sync chip on every play/pause/ended
    // transition so the chip's "Ready" / "Syncing" state stays
    // honest. Cheap (one DOM dataset write).
    this.videoPlayer.video.addEventListener('play', () => {
      if (this.library) this.library._isVideoPlaying = true;
      this._updatePlayerSyncChip();
      // Fan out to audience viewers (SCOPE-audience-broadcast.md). No-op
      // if no room is open.
      this._audienceFanOut('play', Math.round(this.videoPlayer.video.currentTime * 1000));
    });
    this.videoPlayer.video.addEventListener('pause', () => {
      if (this.library) this.library._isVideoPlaying = false;
      this._updatePlayerSyncChip();
      this._audienceFanOut('stop');
    });
    this.videoPlayer.video.addEventListener('ended', () => {
      if (this.library) this.library._isVideoPlaying = false;
      this._updatePlayerSyncChip();
      this._audienceFanOut('stop');
    });
    this.videoPlayer.video.addEventListener('seeked', () => {
      this._audienceFanOut('seek', Math.round(this.videoPlayer.video.currentTime * 1000));
    });

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
      // Parallel HDSP-polled engine for non-1.0× playback rates. HSSP
      // (used by syncEngine) can't follow rate changes — the cloud
      // schedules the script at 1.0× regardless. HDSP is per-tick and
      // reads video.currentTime so it scales naturally. See
      // notes/UPDATES.md and `renderer/js/handy-hdsp-sync.js`.
      this.handyHdspSync = new HandyHdspSync({
        handyManager: this.handyManager,
        player: this.videoPlayer.video,
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
        this.autoblowManager = new AutoblowManager();
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

      // AudienceBridge — fans out HSSP commands to N viewer Handys for
      // the broadcast feature (SCOPE-audience-broadcast.md). Constructed
      // here so it can use the same HandyManager class for each viewer
      // (cloud-fire-and-forget by key; no shared instance contention).
      this.audienceBridge = new AudienceBridge({
        settings: this.settings,
        eventBus,
        HandyManagerCtor: HandyManager,
        getCurrentVideoTimeMs: () => Math.round((this.videoPlayer?.video?.currentTime || 0) * 1000),
        isVideoPlaying: () => !!(this.videoPlayer?.video && !this.videoPlayer.video.paused),
        getCurrentScriptUrl: () => this._scriptCloudUrl || this.funscriptEngine?.getCsvUrl?.() || null,
        // Self-key collision guard — the streamer's own key is held by
        // handyManager. If they paste it as a viewer, refuse.
        getStreamerOwnKey: () => this.settings?.get?.('handy.connectionKey') || null,
      });
      this._wireAudiencePopoutRelay();

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
          const fw = this.handyManager.fwVersion || this.handyManager._fwVersion || 'unknown';
          const keySuffix = this.handyManager.connectionKey
            ? this.handyManager.connectionKey.slice(-4)
            : '?';
          console.log(`[Handy] Connected (native WiFi) — key ...${keySuffix}, firmware ${fw}`);
          this._registerKnownDevice('handy', 'The Handy', 'handy');
          this._onHandyConnected();
          this._refreshOrgasmPlan();
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
          console.log(
            `[TCode] Connected on ${this.tcodeManager.portPath} @ ${this.tcodeManager.baudRate} baud`
          );
          this._registerKnownDevice('tcode', `TCode (${this.tcodeManager.portPath})`, 'tcode');
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
      if (this.vrBridge) {
        const prevVrConnect = this.vrBridge.onConnect;
        this.vrBridge.onConnect = () => {
          if (prevVrConnect) prevVrConnect();
          this._updateDeviceIndicators();
          this.navBar?.setVRConnected(true);
          // Any timestamp-server hint toast on screen is now obsolete —
          // the connection is live.
          this._dismissTimestampServerHint();
          this._vrTimestampHintShown = false;
          // Remember the last successful Quest host/port so we can auto-
          // reconnect on next app launch without waiting for HereSphere
          // to re-fetch a scene from the backend (which is the only path
          // that repopulates the in-memory _vr_activity record).
          this.settings.set('vr.lastHost', this.vrBridge._host);
          this.settings.set('vr.lastPort', this.vrBridge._port);
          this.settings.set('vr.lastPlayerType', this.vrBridge._playerType);
          // Auto-apply the per-player + per-transport offset preset for
          // the VR proxy (the time-shift that compensates for VR display
          // lag). Defers to a slight delay so we have a few packet
          // arrivals to compute jitter from. NEVER overwrites a
          // user-tuned value.
          setTimeout(() => this._maybeApplyVrOffsetPreset(), 3000);
        };

        const prevVrDisconnect = this.vrBridge.onDisconnect;
        this.vrBridge.onDisconnect = () => {
          if (prevVrDisconnect) prevVrDisconnect();
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
      this._keyboard = new KeyboardHandler({
        videoPlayer: this.videoPlayer,
        connectionPanel: this.connectionPanel,
        onOpenFile: () => this.dragDrop._openNativeDialog(),
        scriptEditor: null, // Set after ScriptEditor creation below
        onNavigate: (viewId) => this._navigateTo(viewId),
        onToggleLoop: () => { this._toggleVideoLoop?.(); },
        onToggleQueue: () => { this._toggleQueuePanel(); },
        onJumpChapter: (direction) => this._jumpChapter(direction),
        onJumpBookmark: (direction) => this._jumpBookmark(direction),
        onLoadNext: () => this._playNext(),
        onLoadPrev: () => this._playPrev(),
      });

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
    this.eroscriptsPanel.onScriptDownloaded = (fsPath, fsName) => {
      // If a video is currently playing, load the downloaded script
      if (this._currentVideoName && this.funscriptEngine) {
        window.funsync.readFunscript(fsPath).then((content) => {
          if (content) {
            this.loadFunscript({ name: fsName, textContent: content, path: fsPath });
          } else {
            showToast(t('toast.downloadedButUnreadable', { name: fsName }), 'warn', 6000);
          }
        }).catch((err) => {
          showToast(t('toast.downloadAutoLoadFailed', { error: err.message }), 'error', 5000);
        });
      }

      // Persist as a library association so the badge sticks when the user
      // returns to the library. No-op if the current video isn't a library
      // entry (e.g. drag-dropped from outside a scanned source).
      if (this._currentVideoPath && this.library) {
        this.library.associateDownloadedScript(this._currentVideoPath, fsPath);
      }
    };

    // Initialize script editor (after all dependencies are set up)
    this.scriptEditor = new ScriptEditor({
      videoPlayer: this.videoPlayer,
      funscriptEngine: this.funscriptEngine,
      progressBar: this.progressBar,
      syncEngine: this.syncEngine,
      handyHdspSync: this.handyHdspSync,
      handyManager: this.handyManager,
      settings: this.settings,
    });

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
      this._keyboard.onOpenVRFormat = () => {
        this._openVRFormatPanel(this._currentVideoPath);
      };
      this._keyboard.onVRPan = (yawDelta, pitchDelta) => {
        this._stepVRPan(yawDelta, pitchDelta);
      };
      // Orgasm Switch (hold X) — wired below once the controller exists.
      this._keyboard.onOrgasmHold = (active) => this._onOrgasmHold(active);
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
          const cutoffKey = `tiled-v2|${handyPath}|${JSON.stringify(cutoff ?? null)}`;
          if (this._orgasmCloudUrl && this._orgasmCloudUrlCutoffKey !== cutoffKey) {
            this._orgasmCloudUrl = null;
          }
          // Keep the promise: a quick release awaits it so the restore's
          // setScript can never interleave with an in-flight engage.
          this._orgasmEngagePromise = engageHandyFinisher({
            handyManager: this.handyManager,
            content: handyContent,
            cachedUrl: this._orgasmCloudUrl,
            cutoff,
            onUrlCached: (url) => {
              this._orgasmCloudUrl = url;
              this._orgasmCloudUrlCutoffKey = cutoffKey;
            },
            isCurrent: () => activation === this._orgasmActivationId,
          });
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
              .then(() => releaseHandyFinisher({ handyManager: this.handyManager }));
          }
          return;
        }
        // Hold mode: restart whichever local engines we stopped — they re-anchor
        // at the current video time automatically on their next tick.
        if (this._orgasmStoppedEngines?.includes('buttplug')) this.buttplugSync.start();
        if (this._orgasmStoppedEngines?.includes('tcode')) this.tcodeSync.start();
        this._orgasmStoppedEngines = [];
        if (this._orgasmHandyEngaged) {
          this._orgasmHandyEngaged = false;
          // Await any in-flight engage first (a quick tap can release while
          // the engage's setScript is mid-flight — the engage aborts stale,
          // and only then do we stop + restore so the calls never interleave).
          Promise.resolve(this._orgasmEngagePromise)
            .then(() => releaseHandyFinisher({ handyManager: this.handyManager }))
            .then(() => this._restoreHandyAfterOrgasm());
        }
      },
    });
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

    // Stop Handy device when app closes
    window.addEventListener('beforeunload', () => {
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
      } catch (e) {
        // Fire-and-forget — app is closing
      }
    });

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

    // Both reads failed. Drop any manualVariants entry pointing at the
    // dead path so the backend log stops spamming on the next render
    // pass that touches this video.
    this._pruneStaleManualVariant(scriptPath);
    return null;
  }

  /** @deprecated thin shim around _readScriptResilient — kept for
   *  custom-routing call-site readability. */
  _readRouteScript(route, videoPath) {
    return this._readScriptResilient(route?.scriptPath, videoPath);
  }

  /**
   * Remove any `library.manualVariants` entry pointing at this path.
   * Called when both the stored path and the basename fallback miss —
   * the file is genuinely gone and nothing should keep referring to it.
   */
  _pruneStaleManualVariant(scriptPath) {
    if (!scriptPath) return;
    const all = this.settings.get('library.manualVariants') || {};
    let dirty = false;
    for (const videoPath of Object.keys(all)) {
      const list = all[videoPath] || [];
      const filtered = list.filter(v => v.path !== scriptPath);
      if (filtered.length !== list.length) {
        dirty = true;
        if (filtered.length === 0) delete all[videoPath];
        else all[videoPath] = filtered;
      }
    }
    if (dirty) {
      this.settings.set('library.manualVariants', all);
      console.log(`[Variants] Pruned stale manualVariant ${scriptPath}`);
    }
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
            await this.handyManager.uploadAndSetScript(content);
            this.syncEngine?._scriptReady && this.syncEngine.start();
          }
        }

        // For Autoblow on a non-main route: upload script
        if (route.deviceId === 'autoblow' && this.autoblowManager?.connected) {
          await this.autoblowSync?.uploadScript(content);
        }

        console.log(`[CustomRouting] Loaded ${route.scriptPath.split(/[\\/]/).pop()} → ${syntheticAxis} → ${route.deviceId}`);
      } catch (err) {
        console.warn(`[CustomRouting] Failed to load route:`, err.message);
      }
    }

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
      name: (rawPath || '').split(/[\\/]/).pop() || normalizedName,
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
    const displayName = (rawPath || '').split(/[\\/]/).pop() || normalizedName;
    if (this.vrBridge) this.vrBridge.__vrModalLastVideo = displayName;

    // Stop existing sync engines (they'll be rebound to VR proxy)
    this._stopVRSync();

    // Ensure the library has scanned at least once — re-uses existing _videos
    // + manual associations instead of duplicating that logic here.
    if (!this.library) {
      showToast(t('toast.vrLibraryUnavailable'), 'warn');
      return;
    }
    await this.library.ensureScanned();

    // Abort if a newer video change arrived while we were scanning
    if (gen !== this._vrMatchGeneration) return;

    if (!this.library._videos?.length) {
      showToast(t('toast.vrNoSources'), 'warn');
      return;
    }

    const matched = this.library.findVideoByVRPath(normalizedName, rawPath);

    if (!matched || !matched.hasFunscript) {
      showToast(t('toast.vrNoScript', { name: displayName }), 'info', 4000);
      return;
    }

    // Load the funscript. Gen-check after EVERY await — rapid video
    // browsing in HereSphere can fire multiple video-changed events
    // before any one finishes loading. Without these checks, an older
    // video's script upload could land on the Handy AFTER a newer
    // video has started its own load, and the two would stomp each
    // other's Handy state mid-async.
    try {
      const content = await window.funsync.readFunscript(matched.funscriptPath);
      if (gen !== this._vrMatchGeneration) return;
      if (!content) return;

      const fsName = matched.funscriptPath.split(/[\\/]/).pop();
      await this.funscriptEngine.loadContent(content, fsName);
      if (gen !== this._vrMatchGeneration) return;
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

      // Handy: upload and sync to VR proxy timeline
      if (this.handyManager?.connected) {
        await this.handyManager.uploadAndSetScript(content);
        if (gen !== this._vrMatchGeneration) return;
        if (this.syncEngine) {
          this.syncEngine.player = vrPlayer;
          this.syncEngine._scriptReady = true;
          this.syncEngine.start();
        }
      }

      // Autoblow
      if (this.autoblowManager?.connected && this.autoblowSync) {
        await this.autoblowSync.uploadScript(content);
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
        this.autoblowSync?.setOffsetMs?.(ms);
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

  async _onRemotePhoneConnected(ip, videoId, videoPath) {
    console.log('[Remote] phone-connected', { ip, videoId, videoPath });

    // Tell the tracker — also triggers the mutex if VR was active.
    const currentSession = this.sessionTracker?.getSession();
    if (!currentSession || currentSession.source !== 'web-remote' || currentSession.identifier !== ip) {
      this.sessionTracker?.startSession('web-remote', ip);
    }

    if (!videoPath) {
      console.warn('[Remote] no videoPath from backend — phone videoId', videoId, 'not in registry. Has the library scanned?');
      this.remoteBridge?.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.markScriptMissing();
      return;
    }

    // Pause the desktop player so we're not double-playing audio.
    const desktopVideo = this.videoPlayer?.video;
    if (desktopVideo && !desktopVideo.paused) {
      desktopVideo.pause();
      this._remotePausedDesktop = true;
    }

    // Look up the video object from the library to get its funscript.
    const video = this.library?._videosByPath?.get(videoPath);
    const displayName = (video?.name) || videoPath.split(/[\\/]/).pop();
    this.sessionTracker?.setVideo({
      name: displayName,
      videoId,
      videoPath,
      duration: video?.duration || 0,
    });

    if (!video || !video.hasFunscript || !video.funscriptPath) {
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.markScriptMissing();
      showToast(t('toast.remoteNoScript', { name: displayName }), 'info', 4000);
      return;
    }

    this.remoteBridge.sendToPhone({ type: 'script-loading', videoId });
    this.sessionTracker?.setState('preparing');

    // Tear down any lingering custom routing from the desktop/VR video
    // that was playing before the phone took over. Same leak pattern as
    // the VR-video-change and local-video-change paths — without this,
    // `_customRoutingActive=true` plus stale CR1/CR2 axis assignments
    // would filter non-L0 devices out of the main stroke loop (single-
    // axis plays on one device instead of fanning out) and the previous
    // video's routed scripts would keep firing on their old axes.
    this._resetCustomRoutingState();

    // Load funscript content + spin up the proxy + rebind sync engines.
    let content;
    try {
      content = await window.funsync.readFunscript(video.funscriptPath);
    } catch { /* ignore */ }
    if (!content) {
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      return;
    }

    try {
      const fsName = video.funscriptPath.split(/[\\/]/).pop();
      await this.funscriptEngine.loadContent(content, fsName);

      // Populate the variant state for this phone-driven session so the
      // existing `_switchVariant(index)` flow works when the phone taps
      // a variant. Without this, `_currentVariants` stays empty and the
      // switch handler short-circuits with "no variants loaded". The
      // `_onPlayVideo` desktop path does the same; we mirror it here.
      this._currentVariants = video.variants || [];
      this._activeVariantIndex = 0;
      this._activeVariantPath = video.funscriptPath || null;
      this._updateVariantSelector();
      // Tell the phone which variant is active so its chip starts in
      // the right state. Sent only when the video has multiple variants
      // — single-variant videos don't render a chip.
      const initialVariant = this._currentVariants[0];
      if (this._currentVariants.length > 1 && initialVariant?.label) {
        this.remoteBridge.sendToPhone({
          type: 'variant-changed',
          label: initialVariant.label,
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
      if (this.handyManager?.connected) {
        await this.handyManager.uploadAndSetScript(content);
        if (this.syncEngine) {
          this.syncEngine.player = proxyPlayer;
          this.syncEngine._scriptReady = true;
          this.syncEngine.start();
        }
      }
      if (this.autoblowManager?.connected && this.autoblowSync) {
        await this.autoblowSync.uploadScript(content);
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
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.setState('error');
    }
  }

  _onRemotePhoneDisconnected(_ip) {
    this._remoteActive = false;
    this._refreshLoopVideoVisibility?.();

    // SAFETY (F2): a dead phone must never leave a hold-mode finisher
    // running — the hold's release lives on the phone that just vanished.
    // Toggle mode is a deliberate start/stop, so it survives disconnects.
    if (this.orgasmSwitch?.active
        && (this.settings?.get?.('player.orgasmSwitchMode') || 'hold') === 'hold') {
      try { this.orgasmSwitch.deactivate(); } catch { /* best-effort */ }
    }

    // Stop all device sync engines and rebind to the local player.
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
      const port = this.tcodeManager.portPath || 'serial';
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
  }

  _stopVRSync() {
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
    this._resetCustomRoutingState();

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
      showToast(t('toast.vrReconnected'), 'info', 3000);
    }
    // Silent on failure — polling takes over.
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

    try {
      const port = this.settings.get('backend.port') || 5123;
      const res = await fetch(`http://127.0.0.1:${port}/api/media/vr-activity`);
      if (!res.ok) return;
      const data = await res.json();

      if (!data.clientIp || !data.videoId || !data.timestamp) return;

      // Auto-update saved `vr.lastHost` whenever the activity poll
      // discovers a different IP than what's currently saved. Closes
      // the "Quest got a new DHCP lease and FunSync still tries the
      // old IP next launch" gap. Doesn't substitute for the parked
      // mDNS work (still needed for the "Quest IP changed while
      // FunSync was closed" case), but covers every session where the
      // user has actively used HereSphere at least once.
      const savedHost = this.settings.get('vr.lastHost');
      if (savedHost !== data.clientIp) {
        this.settings.set('vr.lastHost', data.clientIp);
      }

      const isNewActivity = data.timestamp > this._lastVrActivityTs;

      // Backoff strategy after a failed connect: count consecutive
      // failed attempts in `_vrPollFailedAttempts`. First three attempts
      // retry every 2 s (matches the poll cadence — no extra delay);
      // after that, back off to 8 s. **Crucially**, fresh activity
      // (a new timestamp from the backend) bypasses the backoff
      // entirely — that's the strongest signal that the user just did
      // something in HereSphere (toggled a setting, picked a video)
      // and we should retry immediately. Was a 10 s lockout that left
      // the user staring at silent toys after fixing their config.
      if (!isNewActivity) {
        const attempts = this._vrPollFailedAttempts || 0;
        const backoffMs = attempts < 3 ? 2000 : 8000;
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
          this._vrPollFailedAttempts = 0; // reset backoff on success
          showToast(t('toast.vrConnected'), 'info', 3000);
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
        showToast(
          `Settings were recovered from a recent backup. Open Settings → Data to view backup history.`,
          'warn',
          10_000
        );
      } else if (result.fellBack) {
        // No valid snapshot to fall back to. Rare (only on a fresh install
        // where config.json was somehow corrupt before any snapshot was
        // taken). More urgent — direct the user toward the Import flow.
        showToast(
          `Settings could not be recovered. Starting fresh — use Settings → Data → Import to restore from a backup file.`,
          'error',
          15_000
        );
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

    const ipSuggestion = questIp || "your Quest's IP";
    const text = document.createElement('div');
    text.textContent =
      "VR companion can't reach HereSphere's timestamp server. " +
      'On the Quest: HereSphere → Settings → Timestamp Server. ' +
      `Make sure it's enabled, then press the auto-find button next to the IP field — your Quest's IP is ${ipSuggestion} and the port should be 23554. ` +
      "If that doesn't help, toggle the timestamp server off and back on to force a re-init.";
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
      this._lastVrRetryTime = 0;
      // Direct connect attempt with the last-known host. If it succeeds,
      // the bridge.onConnect callback dismisses the hint via
      // _dismissTimestampServerHint(); if it fails, leave the toast up
      // (the user can hit Try again again or the next activity-poll
      // tick will retry on its own).
      const host = this.settings.get('vr.lastHost') || this.vrBridge.host || '127.0.0.1';
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
    let userDismissed = false;

    const render = (state, detail) => {
      if (state === 'running') {
        banner.hidden = true;
        banner.classList.remove('backend-banner--restarting');
        userDismissed = false; // reset for next failure
        return;
      }
      if (state === 'restarting') {
        banner.hidden = false;
        banner.classList.add('backend-banner--restarting');
        titleEl.textContent = t('backend.restartingTitle');
        detailEl.textContent = t('backend.restartingDetail');
        restartBtn.disabled = true;
        return;
      }
      // 'down' (default)
      if (userDismissed) return;
      banner.hidden = false;
      banner.classList.remove('backend-banner--restarting');
      titleEl.textContent = t('backend.title');
      detailEl.textContent = detail
        ? t('backend.detailWithError', { error: detail })
        : t('backend.detail');
      restartBtn.disabled = false;
    };

    restartBtn.addEventListener('click', async () => {
      restartBtn.disabled = true;
      restartBtn.textContent = t('backend.restarting');
      try {
        const result = await window.funsync.restartBackend();
        if (!result.success) {
          showToast(t('toast.restartFailed', { error: result.error || 'unknown error' }), 'error', 5000);
        }
      } finally {
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
      banner.hidden = true;
      userDismissed = true;
    });

    // Subscribe to live state transitions.
    window.funsync.onBackendStatus(({ state, detail }) => render(state, detail));

    // First paint — query current state in case the backend died before
    // the renderer had subscribed (subscription is event-only; misses
    // any transition that already happened).
    window.funsync.getBackendHealth?.().then((state) => {
      if (state && state !== 'unknown') render(state);
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

      try {
        if (dev.canLinear) {
          await this.buttplugManager.sendLinear(dev.index, 70, 500);
          await new Promise(r => setTimeout(r, 550));
          await this.buttplugManager.sendLinear(dev.index, 20, 500);
        } else if (dev.canScalar) {
          await this.buttplugManager.sendScalar(dev.index, 0.3);
          await new Promise(r => setTimeout(r, 500));
          await this.buttplugManager.sendScalar(dev.index, 0);
        } else if (dev.canVibrate) {
          await this.buttplugManager.sendVibrate(dev.index, 0.5);
          await new Promise(r => setTimeout(r, 500));
          await this.buttplugManager.sendVibrate(dev.index, 0);
        } else if (dev.canRotate) {
          await this.buttplugManager.sendRotate(dev.index, 0.5, true);
          await new Promise(r => setTimeout(r, 500));
          await this.buttplugManager.sendRotate(dev.index, 0, true);
        } else {
          return { ok: false, reason: t('deviceTest.noTestableOutput') };
        }
        return { ok: true };
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
      }).catch(() => {}); // backend may still be starting — full register post-scan will retry
    } catch { /* ignore */ }
  }

  async _pollSourceAvailability() {
    const sources = this.settings.get('library.sources') || [];
    if (sources.length === 0) return;

    const prevUnavailable = this.library?._unavailablePaths || new Set();
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
    const anyConnected = status === 'connected' || status === 'connecting' || buttplugDevices > 0;
    const effectiveStatus = anyConnected
      ? (status === 'connecting' ? 'connecting' : 'connected')
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
      // hook. Extender stretches first, then the cutoff clamps.
      const extenderEnabled = !!this.settings?.get?.('player.rangeExtender.enabled');
      const uploadContent = clampRawScriptContent(
        extendRawScriptContent(rawContent, extenderEnabled),
        this._cutoffFromSettings('autoblow'),
      );
      const ok = await this.autoblowSync.uploadScript(uploadContent);
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
   * Orgasm Switch key callback (keyboard X). active=true on press, false on
   * release. Behaviour depends on `player.orgasmSwitchMode`:
   *   - 'hold'   (default): hold to ride the looping script, release snaps back
   *              to the main funscript (edging model — the original behaviour).
   *   - 'toggle' (finish):  first press starts the looping finisher; a second
   *              press stops the device(s) and does NOT return to the main
   *              script. Key release is ignored.
   */
  _onOrgasmHold(active) {
    if (!this.orgasmSwitch) return;
    const mode = this.settings?.get?.('player.orgasmSwitchMode') || 'hold';

    if (mode === 'toggle') {
      if (!active) return; // ignore release — this is a press-to-toggle mode
      if (this.orgasmSwitch.active) {
        this._finishOrgasm();
      } else {
        const result = this.orgasmSwitch.activate();
        if (result === 'not-configured') {
          showToast(t('toast.orgasmNotConfigured'), 'info', 3500);
        } else if (result === 'activated') {
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
   * (Re)load every script the orgasm config references into the content/
   * actions caches, then resolve the plan. ALL slots preload (not just the
   * active one) so mode switches and demotion fallbacks never wait on I/O —
   * bounded at ~a dozen small JSON files.
   */
  async _reloadOrgasmScripts(allowRecovery = true) {
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
      if (missing.length > 0 && allowRecovery && this._recoverOrgasmPaths(missing)) {
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
   * @param {string[]} missing — paths that failed to load
   * @returns {boolean} true if anything was re-pointed (caller re-reads)
   */
  _recoverOrgasmPaths(missing) {
    const pool = this.library?.getAllFunscriptPaths?.() || [];
    if (pool.length === 0) return false;
    const entry = this._orgasmEntry;
    if (!entry) return false;

    const remap = new Map();
    for (const p of missing) {
      const found = findMovedFile(pool, p);
      if (found) remap.set(p, found);
    }
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
    const { plan, demotedFrom, missing } = resolveOrgasmPlan(
      this._orgasmEntry || null,
      snapshot,
      (p) => this._orgasmActionsCache?.get(p) || null,
    );
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
        const def = AXIS_DEFINITIONS.find((a) => a.suffix === suffix);
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
      if (this._scriptCloudUrl) {
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
        await this.syncEngine.resync();
      } else {
        // No cached URL (script never uploaded this session) → full path.
        await this._uploadAndStartSync();
      }
    } catch (err) {
      console.warn('[OrgasmSwitch] Handy HSSP restore failed:', err?.message || err);
    }
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

    // Apply Range Extender at upload time for Handy HSSP. HSSP plays
    // back from a cloud-hosted script — there's no per-tick hook to
    // apply the stretch, so it must happen pre-upload. Returns the
    // original content if extender is off or the script is already
    // wide (no-op short-circuit inside the helper).
    const extenderEnabled = !!this.settings?.get?.('player.rangeExtender.enabled');
    // Extender stretches first, then the hard floor/ceiling cutoff clamps —
    // same order as the per-tick stack (extender → … → cutoff). HSSP plays
    // server-side, so both must be baked into the uploaded content.
    const cutoff = this._cutoffFromSettings('handy');
    const uploadContent = clampRawScriptContent(
      extendRawScriptContent(rawContent, extenderEnabled),
      cutoff,
    );

    console.log('[Handy] Uploading funscript to cloud...');
    const setupOk = await this.handyManager.uploadAndSetScript(uploadContent);

    if (setupOk) {
      // Store cloud URL for potential re-setup
      this._scriptCloudUrl = this.handyManager._lastCloudUrl || null;
      this.syncEngine._scriptReady = true;
      this._resolveCloudUpload('handy');
      this.syncEngine.start();
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
    // Fresh load — allow a remux fallback for this video if its container
    // turns out to be unplayable (see _tryRemuxFallback).
    this._remuxAttemptedForPath = null;

    // Clean up previous video
    if (this._currentVideoUrl) {
      URL.revokeObjectURL(this._currentVideoUrl);
      this._currentVideoUrl = null;
    }
    this.syncEngine?.stop();
    if (this.handyHdspSync?.active) this.handyHdspSync.stop();
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
    this._currentCustomRoutes = null;
    this._customRoutingActive = false;
    if (this.buttplugSync) this.buttplugSync._customRoutingActive = false;
    this.funscriptEngine.clear();
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

    // Hide editor, clear funscript path and script list, show editor toggle button
    if (this.scriptEditor) {
      if (this.scriptEditor.isOpen) this.scriptEditor.hide();
      this.scriptEditor.setFunscriptPath(null);
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

    // Apply any saved VR-as-flat preference for this video. Two inputs:
    //   - per-video saved eye ('left' / 'right' / null) in
    //     `library.vrFlatten[path]`
    //   - per-video format auto-detected by `classifyStereoFormat`
    // No saved preference + a detectable format = leave Off (the user
    // opts in explicitly via Shift+R or the library kebab). This avoids
    // silently squishing every flat-but-VR-tagged video the user opens.
    this._applyVRFlattenForCurrent();

    // One-time HEVC codec install guidance — fires once per session if
    // the OS lacks a hardware HEVC decoder (and the user hasn't
    // permanently dismissed it). Cheap to call on every load; the
    // helper has its own per-session guard. See hevc-detect.js for
    // the full rationale.
    maybeShowHevcGuidance(this.settings);

    // Store video path on player container for editor access
    const pc = document.getElementById('player-container');
    if (pc) pc.dataset.videoPath = file.path || '';

    // Auto-play once video is ready (gated by script upload if applicable)
    if (autoPlay) {
      this.videoPlayer.video.addEventListener('loadeddata', () => {
        if (this._waitingForScript) {
          this._showScriptLoadingOverlay();
          // Don't play yet — _uploadAndStartSync will trigger play when ready
        } else {
          this.videoPlayer.video.play().catch(() => {});
        }
      }, { once: true });
    }

    // Handle video load errors (including mid-playback drive disconnect)
    this.videoPlayer.video.addEventListener('error', () => {
      const code = this.videoPlayer.video.error?.code;
      const src = this.videoPlayer.video.src || '';
      const isFileUrl = src.startsWith('file:');

      // Unsupported container (code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED). The
      // common case is a .mkv holding H.264/AAC — Chromium can't demux
      // Matroska even though it can decode the codecs. Before surfacing any
      // error, try a one-time ffmpeg stream-copy remux to MP4 and reload.
      // Guarded so it only fires for the CURRENT video and only once per
      // load (stale accumulated listeners + a failed re-load can't loop).
      if (code === 4 && isFileUrl && this._currentVideoPath
          && this._currentVideoPath === (file.path || null)
          && this._remuxAttemptedForPath !== this._currentVideoPath) {
        this._tryRemuxFallback(this._currentVideoPath, file.name);
        return;
      }

      // Stop all sync engines and devices immediately
      if (this.syncEngine) this.syncEngine.stop();
      if (this.buttplugSync?._active) this.buttplugSync.stop();
      if (this.tcodeSync?._active) this.tcodeSync.stop();
      if (this.autoblowSync?._active) this.autoblowSync.stop();
      if (this.handyManager?.connected) this.handyManager.hsspStop();
      if (this.buttplugManager?.connected) this.buttplugManager.stopAll();
      if (this.tcodeManager?.connected) this.tcodeManager.stop();
      if (this.autoblowManager?.connected) this.autoblowManager.syncStop();

      // Show appropriate error message
      if (isFileUrl && code === 2) {
        showToast(t('toast.sourceDisconnectedFile'), 'error', 5000);
        // Invalidate library cache so re-scan catches the change
        if (this.library) this.library._lastScanKey = null;
      } else if (code === 3 && isFileUrl && file.path) {
        // Decode failure on a local file. Most often a codec/profile the
        // OS Chromium build can't decode (e.g. H.264 "High 10" / 4:2:2 /
        // 4:4:4 on Linux) — while a plain 8-bit 4:2:0 file of the same
        // codec plays fine. Name the actual codec via ffprobe so the user
        // knows exactly what to transcode instead of a guess.
        this._showDecodeErrorWithCodec(file.path);
      } else {
        const msgs = {
          1: t('toast.videoErrorAborted'),
          2: t('toast.videoErrorNetwork'),
          3: t('toast.videoErrorDecode'),
          4: t('toast.videoErrorFormat'),
        };
        showToast(msgs[code] || t('toast.videoErrorGeneric'), 'error');
      }
    });

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
   * Turn a bare MEDIA_ERR_DECODE into an actionable message by naming the
   * codec/profile/pixel-format via the backend's ffprobe. This is the
   * difference between "Video decoding failed — unsupported codec?" and
   * "Video decoding failed: H264 High 10 yuv422p — not supported on this
   * system". Community-reported by a Fedora user whose H.264 files played
   * inconsistently (some High 10 / 4:2:2, some 8-bit 4:2:0). Best-effort:
   * falls back to the generic message if ffprobe is unavailable.
   *
   * @param {string} path  local video path that failed to decode
   */
  async _showDecodeErrorWithCodec(path) {
    let detail = '';
    try {
      const meta = await window.funsync.fetchMetadata?.(path);
      if (meta) {
        const parts = [];
        if (meta.codec && meta.codec !== 'unknown') parts.push(String(meta.codec).toUpperCase());
        if (meta.profile) parts.push(String(meta.profile));
        if (meta.pixFmt) parts.push(String(meta.pixFmt));
        detail = parts.join(' ').trim();
      }
    } catch { /* fall through to the generic message */ }
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
   */
  async _tryRemuxFallback(originalPath, name) {
    // One attempt per path — set the guard up front so accumulated/stale
    // error listeners calling in can't double-trigger a remux.
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
      // Point playback at the remuxed MP4. Same <video> element is reused,
      // so loadVideo's armed loadeddata→autoplay listener fires.
      this.videoPlayer.loadSource(url, name);
      this.progressBar.setVideoSource(url);
      console.log(`[Remux] playing remuxed copy of ${originalPath}`);
      toast?.dismiss?.();
    } catch (err) {
      toast?.dismiss?.();
      console.warn('[Remux] fallback failed:', err?.message || err);
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

    try {
      // Use loadContent directly if textContent is already available (from library or IPC),
      // otherwise use loadFile which calls file.text() for real File objects
      const rawContent = file.textContent != null
        ? file.textContent
        : await file.text?.();
      const info = file.textContent != null
        ? await this.funscriptEngine.loadContent(file.textContent, file.name)
        : await this.funscriptEngine.loadFile(file);
      console.log('Funscript loaded:', info);

      // Community-driven: many forum funscripts bundle pitch/roll/twist
      // INTO the single main file (HereSphere `additional_axes`, OFS
      // `raw`, sibling-key, or inline TCode formats). FunSync's
      // companion-file detection misses these — the device only gets
      // the L0 main stroke. Detect + auto-feed multi-axis here so OSR2
      // / SR6 owners with combined files get their rotation axes
      // immediately on load, no manual extraction needed.
      this._feedEmbeddedMultiAxis(rawContent);

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

      // Load into script editor if open + set funscript path for autosave
      if (this.scriptEditor) {
        // Derive funscript path from the file info
        if (file.path) {
          this.scriptEditor.setFunscriptPath(file.path);
        } else if (this._currentVideoPath) {
          // Funscript from library/IPC — derive path from video path
          const fsPath = this._currentVideoPath.replace(/\.[^/.]+$/, '') + '.funscript';
          this.scriptEditor.setFunscriptPath(fsPath);
        }
        this.scriptEditor.loadScript();
      }

      // If Handy is connected, upload script to cloud and start sync
      // (skip if custom routing is active — routing handles Handy assignment)
      if (!this._customRoutingActive || this._isDeviceOnMainRoute('handy')) {
        await this._uploadAndStartSync();
      }

      // If Buttplug is connected, start sync
      this._tryStartButtplugSync();

      // If TCode is connected, start sync
      this._tryStartTCodeSync();

      // If Autoblow is connected, upload script and start sync
      // (skip if custom routing is active — routing handles Autoblow assignment)
      if (!this._customRoutingActive || this._isDeviceOnMainRoute('autoblow')) {
        await this._tryStartAutoblowSync();
      }

      // Start gap skip monitoring (only for single-script playback — multi-device routing
      // has different scripts per device, skipping would desync them)
      if (!this._customRoutingActive) {
        this._startGapSkip();
      }
    } catch (err) {
      console.error('Failed to load funscript:', err.message);
      showToast(t('toast.scriptLoadFailed', { error: err.message }), 'error');
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
    const embedded = this.getEmbeddedAxes(this._currentVideoPath);
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

    if (viewId === 'library') {
      // Recheck source availability before showing (drive may have been disconnected)
      this._refreshCollectionsUI().then(() => {
        this.library.show(this._getViewEl('library'));
        // Re-anchor the queue panel below the (now-rendered) filter/sort bar
        // if it's open (e.g. returning to library from the player).
        if (this.queuePanel?.visible) this._positionQueuePanelForLibrary();
      });
      return;
    } else if (viewId === 'playlists') {
      this.playlists.show(this._getViewEl('playlists'));
    } else if (viewId === 'categories') {
      this.categories.show(this._getViewEl('categories'));
    }
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
      enabled: this.settings?.get?.('player.miniPlayer') !== false,
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
      if (evt.type === 'closed') {
        this._playerWindowOpen = false;
        this._updatePlayerWindowButton();
        this._deactivatePlayerWindow(); // fold playback back to the inline player
        return;
      }
      if (evt.type === 'message') this._onPlayerWindowMessage(evt.payload);
    });
  }

  _onPlayerWindowMessage(payload) {
    const type = PLAYERWIN.classifyMessage(payload);
    if (type === PLAYERWIN.READY) {
      // Pop-out finished loading → take over sync, then hand it the video.
      this._sendPlayerWindowInitialState(); // theme + locale (video via LOAD_VIDEO)
      this._activatePlayerWindow();
      this._sendLoadVideoToPopout(this._popoutWasPlaying !== false);
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
    if (!this._playerWindowActive || !this._playerWinProxy) return;
    // The pop-out's <video> is the authority; its clock drives the proxy,
    // which the sync engines read (exactly as the web-remote phone does).
    if (type === PLAYERWIN.TIME_TICK) {
      this._playerWinProxy.updateState({
        at: payload.timeMs, paused: payload.paused, rate: payload.rate,
      });
      // Drive the Up Next engine off the pop-out's clock (its inline event
      // hooks are dead while detached). Looping in the pop-out suppresses
      // it — a looped video should never auto-advance. Editor-open in main
      // still suppresses too.
      if (this.upNextEngine) {
        const editorOpen = !!this.scriptEditor?.isOpen;
        this.upNextEngine.setSuppressed(editorOpen || !!payload.loop);
        this.upNextEngine.check();
      }
    } else if (type === PLAYERWIN.VIDEO_EVENT) {
      switch (payload.event) {
        case 'play': this._playerWinProxy.handlePlay(); break;
        case 'pause': this._playerWinProxy.handlePause(); break;
        case 'seeked': this._playerWinProxy.seek(payload.timeMs); break;
        case 'ended': this._playerWinProxy.handleEnded(); this._onPopoutVideoEnded(); break;
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

  /** Build the LOAD_VIDEO payload for the pop-out, or null if unsupported. */
  _currentPopoutVideo() {
    const vid = this.videoPlayer?.video;
    if (!vid) return null;
    // Prefer the path we set synchronously in loadVideo — `vid.currentSrc`
    // lags a source swap (the browser's resource-selection is async), so on
    // a queue advance it still points at the PREVIOUS video for a beat,
    // which made the pop-out replay the same file (title was already new).
    let src = '';
    if (this._currentVideoPath && !this._currentIsRemote) {
      src = pathToFileURL(this._currentVideoPath);
    } else {
      src = vid.currentSrc || vid.src || '';
    }
    // 2b supports local library files (file://). blob: URLs (drag-drop) are
    // per-renderer and remote/HLS needs the proxy pipeline — both fall back
    // to keeping the inline player (no pop-out take-over).
    if (!src.startsWith('file:')) return null;
    return {
      src,
      title: this._currentVideoName || '',
      timeMs: Math.round((vid.currentTime || 0) * 1000),
      autoplay: !vid.paused,
    };
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
    window.funsync?.playerPopoutRelay?.('to-popout', PLAYERWIN.makeMessage(PLAYERWIN.LOAD_VIDEO, {
      ...v, timeMs: fromStart ? 0 : v.timeMs, autoplay: autoplay !== false,
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
   */
  async _routeLoadedVideoToPlayerWindow(autoplay = true) {
    if (!this._playerWindowActive) return;
    if (this._currentPopoutVideo()) {
      this._activatePlayerWindow();
      this._sendLoadVideoToPopout(autoplay, true); // fresh clip → start at 0
    } else {
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
        durationMs,
      }));
    }
    const list = (this._allVariantsWithManual || []).map((v) => ({ label: v.label, path: v.path }));
    const activeLabel = list[this._activeVariantIndex || 0]?.label || '';
    relay(PLAYERWIN.makeMessage(PLAYERWIN.VARIANTS, { list, activeLabel }));
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
    if (!vid.paused) vid.pause(); // pop-out becomes the audio + clock source
    if (this._miniActive) this._clearMiniplayer(); // no redundant corner overlay

    if (!this._playerWinProxy) this._playerWinProxy = new RemotePlaybackProxy();
    this._playerWinProxy.reset();
    // Proxy `duration` is in SECONDS (its internal end-guard compares against
    // currentTime-in-seconds); only `at` is ms. Seeding it in ms broke the
    // Up Next trailing-zone math (card never showed).
    this._playerWinProxy.updateState({ at: startMs, paused: true, duration: vid.duration || 0 });
    const proxyPlayer = this._playerWinProxy.asVideoPlayerWrapper();

    // Stop engines, repoint to the proxy, restart (idle until proxy plays).
    // Same script already set on cloud devices — no re-upload needed.
    if (this.syncEngine?._active) this.syncEngine.stop();
    if (this.buttplugSync?._active) this.buttplugSync.stop();
    if (this.tcodeSync?._active) this.tcodeSync.stop();
    if (this.autoblowSync?._active) this.autoblowSync.stop();
    if (this.handyHdspSync?.active) this.handyHdspSync.stop();

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
    // Main window returns to the library so it stays browseable (deaf #189).
    if (this._currentView() === 'player') this._navigateTo('library');
  }

  /**
   * Fold playback back into the main window when the pop-out closes. Mirror
   * of the web-remote disconnect: stop engines, rebind to the local player,
   * resume the inline <video> at the pop-out's last position.
   */
  _deactivatePlayerWindow() {
    if (!this._playerWindowActive) return;
    const proxyMs = Math.round((this._playerWinProxy?.currentTime || 0) * 1000);
    const wasPlaying = !!(this._playerWinProxy && !this._playerWinProxy.paused);

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
      this.videoPlayer.setVRFlatten(this._currentStereoFormat, eye, { zoom, fov, yaw, pitch });
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
   * Show / hide the "VR Format…" item in the player overflow menu
   * based on whether the current video is VR. Uses `isVRVideo` which
   * already layers vrFormat → manualVRType → filename heuristic, so
   * this is the single source of truth for "is this a VR video?".
   */
  _refreshVRFormatMenuVisibility() {
    const item = document.getElementById('btn-vr-format-menu');
    if (!item) return;
    const path = this._currentVideoPath;
    const isVR = path ? isVRVideo({ path }) : false;
    item.hidden = !isVR;
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
    if (!this.videoPlayer?.video) return;
    if (this.videoPlayer.video.paused) return;  // already stopped, nothing to restore
    const timeMs = Math.round(this.videoPlayer.video.currentTime * 1000);
    try {
      await this.handyManager.hsspStop();
      await this.handyManager.hsspPlay(timeMs);
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
        case AUDIENCE.TEST_BUZZ:
          this._flashScreenForBuzzCalibration();
          await this.audienceBridge.testBuzz(payload.key);
          break;
        case AUDIENCE.TEST_BUZZ_ALL:
          this._flashScreenForBuzzCalibration();
          await this.audienceBridge.testBuzzAll();
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
  }

  _pushAudienceMessage(type, fields = {}) {
    window.funsync?.audiencePopoutRelay?.('to-popout', { type, ...fields });
  }

  _pushAudienceInitialState() {
    this._pushAudienceMessage(AUDIENCE.INITIAL_STATE, {
      roomActive: this.audienceBridge.roomActive,
      viewers: this.audienceBridge.viewers,
      hideKeys: !!this.settings?.get?.('audience.hideKeys'),
      theme: document.documentElement.dataset.theme || 'dark',
      uiStyle: document.documentElement.dataset.style || 'classic',
      // Pop-out renderer has its own module-level i18n state. Pass the
      // streamer's chosen locale so the pop-out shows translated UI
      // instead of raw key constants like "audience.room.empty".
      locale: this.settings?.get?.('player.language') || 'en',
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
   * Fan-out hook: called from the existing single-Handy play / pause /
   * seek / load-video pipeline to push the same op out to every viewer.
   * Idempotent + safe to call when no room is open (no-op).
   *
   * `op` is one of: 'play', 'stop', 'seek', 'script'.
   */
  async _audienceFanOut(op, ...args) {
    if (!this.audienceBridge?.roomActive) return;
    try {
      switch (op) {
        case 'play':
          await this.audienceBridge.hsspPlayAll(args[0] || 0);
          break;
        case 'stop':
          await this.audienceBridge.hsspStopAll();
          break;
        case 'seek':
          // Stop + replay at new time. Same as auto-drift recovery.
          await this.audienceBridge.hsspStopAll();
          await this.audienceBridge.hsspPlayAll(args[0] || 0);
          break;
        case 'script':
          await this.audienceBridge.uploadScriptToAll(args[0]);
          break;
      }
    } catch (err) {
      console.warn('[Audience] fan-out failed:', err?.message || err);
    }
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
    const chapters = this.funscriptEngine?.getChapters?.() || [];
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
      showToast(t('toast.noVRDetected'), 'info');
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

  async _playFromLibrary(videoData, funscriptData, subtitleData, variants) {
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
    this._playQueue = [];
    this._playQueueIndex = -1;
    this._playQueueSource = null;
    this._playQueueLoop = false;
    this._playQueueShuffle = false;
    this._updateQueueUI();

    // Capture the play context attached by library/playlists/categories
    // so Up Next can advance through the user's filtered/sorted view.
    // Snapshot is immutable for this session — sort/filter changes during
    // playback don't retroactively alter "next" (Norman: conceptual
    // model). Drag-and-drop / Open File launches arrive without a
    // context and Up Next stays silent.
    this._currentPlayContext = videoData?._playContext || null;
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
    const autoPlayOnLoad = !!videoData?._autoPlayOnLoad;
    // If we're auto-playing AND there's a funscript to upload, gate
    // playback on every connected cloud-sync device (Handy / Autoblow).
    // Without this, `loadeddata` would fire `.play()` immediately and
    // the video would race ahead while the cloud upload(s) are still
    // in flight (1–3s of device silence). `_resolveCloudUpload` from
    // each device's upload completion path lifts the gate when the
    // last one finishes.
    if (autoPlayOnLoad && funscriptData?.textContent) {
      this._markCloudUploadsPending();
    }

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

    this.loadVideo(videoData, { skipViewSwitch: true, autoPlay: autoPlayOnLoad });

    // Seek before playback starts, so the sync engine's play-anchor lands
    // at the resumed position rather than the seek-correction path having
    // to fix it up afterwards (see SCOPE-playlist-resume.md pitfall 4).
    if (resumeAt) this._applyPendingResumeSeek(resumeAt);

    // Set variants AFTER loadVideo (which resets them)
    this._currentVariants = variants || [];
    this._activeVariantIndex = 0;
    this._activeVariantPath = null;
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
      }
      // No `else` — cleanup of stale routing state already happened at the
      // top of this method, before loadVideo. Setting `_customRoutingActive`
      // false again here would be redundant.

      // Only load main funscript if it has content
      if (funscriptData.textContent) {
        this.loadFunscript(funscriptData);
      }
      // Load multi-axis vibration script for Buttplug.io (works with or without main script)
      if (funscriptData._multiAxis) {
        this._loadMultiAxisScripts(funscriptData._multiAxis);
      }
    }
    if (subtitleData) {
      this._loadSubtitleFromLibrary(subtitleData);
    }
    // Honor a per-video pinned default variant (lr_x3 request): once the
    // auto-default has loaded, swap to the user's preferred variant for
    // this video if one is set. Falls back silently to the auto-default.
    await this._applyPreferredVariant();

    // Detached player is open → route this freshly-loaded video into it.
    await this._routeLoadedVideoToPlayerWindow();

    // Final queue panel refresh — `loadVideo` already fired one, but
    // by now `_currentPlayContext` is set so `_getUpcoming` can derive
    // the library-context upcoming list correctly. Without this final
    // call the panel would show empty upcoming on the FIRST video play
    // of a session (because the loadVideo refresh fired before
    // `_playFromLibrary` finished setting `_currentPlayContext`).
    this._updateQueuePanelState();
  }

  async _loadMultiAxisScripts(config) {
    if (!config.axes) return;

    const axisEntries = Object.entries(config.axes); // e.g. { vib: 'path', twist: 'path', ... }
    if (axisEntries.length === 0) return;

    // Clear previous axis actions
    if (this.buttplugSync) this.buttplugSync.clearAxisActions();

    // Map axis suffixes to TCode identifiers
    const SUFFIX_TO_TCODE = {
      surge: 'L1', sway: 'L2',
      twist: 'R0', roll: 'R1', pitch: 'R2',
      vib: 'V0', lube: 'V1', pump: 'V1',
      suction: 'V2', valve: 'A0',
    };

    let vibActions = null;
    let firstLoadedScript = null;

    for (const [suffix, axisPath] of axisEntries) {
      if (!axisPath) continue;
      const tcode = SUFFIX_TO_TCODE[suffix];
      if (!tcode) continue;

      try {
        // Resilient read covers users who reorganised their scripts —
        // dead axisPath gets recovered from a sibling-of-video lookup.
        const read = await this._readScriptResilient(axisPath, this._currentVideoPath || null);
        if (!read) continue;
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
      }
    }

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

    // Update editor script list for multi-axis
    if (this.scriptEditor) {
      const scripts = [{ label: t('editor.mainAxisLabel'), path: this.scriptEditor?._funscriptPath || '' }];
      for (const [suffix, axisPath] of axisEntries) {
        if (!axisPath) continue;
        const SUFFIX_LABELS = { surge: 'Surge', sway: 'Sway', twist: 'Twist', roll: 'Roll', pitch: 'Pitch', vib: 'Vibe', lube: 'Lube', pump: 'Pump', suction: 'Suction', valve: 'Valve' };
        scripts.push({ label: SUFFIX_LABELS[suffix] || suffix, path: axisPath });
      }
      if (scripts.length > 1) this.scriptEditor.setAvailableScripts(scripts);
    }
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
  _feedEmbeddedMultiAxis(rawContent) {
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
    const cacheKey = this._currentVideoPath || rawContent.slice(0, 64);

    if (extracted.size === 0) {
      this._embeddedAxesByPath.delete(cacheKey);
      return;
    }

    // Same suffix→TCode map as `_loadMultiAxisScripts`.
    const SUFFIX_TO_TCODE = {
      surge: 'L1', sway: 'L2',
      twist: 'R0', roll: 'R1', pitch: 'R2',
      vib: 'V0', lube: 'V1', pump: 'V1',
      suction: 'V2', valve: 'A0',
    };

    // Clear previous embedded-axis state so a video switch doesn't
    // leak old axes into the new file.
    if (this.buttplugSync?.clearAxisActions) this.buttplugSync.clearAxisActions();

    const fedSuffixes = [];
    for (const [suffix, actions] of extracted) {
      const tcode = SUFFIX_TO_TCODE[suffix];
      if (!tcode) continue;
      if (!Array.isArray(actions) || actions.length < 2) continue;
      this.buttplugSync?.setAxisActions?.(tcode, actions);
      this.tcodeSync?.setAxisActions?.(tcode, actions);
      fedSuffixes.push(suffix);
      console.log(`[EmbeddedMultiAxis] Loaded ${suffix} (${tcode}): ${actions.length} actions`);
    }
    if (fedSuffixes.length === 0) return;

    // Cache for other surfaces. Store both the suffix list (cheap to
    // iterate) and the full action arrays (so the "Extract to
    // companions" action doesn't need to re-parse the file).
    this._embeddedAxesByPath.set(cacheKey, {
      suffixes: fedSuffixes,
      axes: extracted,
    });

    // Toast only once per video path per session. Repeated plays of
    // the same file stay quiet.
    if (!this._embeddedAxesToastShown.has(cacheKey)) {
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
      return;
    }
    const entry = this.getEmbeddedAxes(video.funscriptPath)
      || await this.detectEmbeddedAxesForPath(video.funscriptPath);
    if (!entry || entry.suffixes.length === 0) {
      showToast('No embedded axes detected in this funscript', 'info');
      return;
    }
    const files = buildCompanionFiles(entry.axes);
    const paths = companionPathMap(video.path, entry.suffixes);

    let wrote = 0;
    const failed = [];
    for (const f of files) {
      const targetPath = paths[f.suffix];
      if (!targetPath) continue;
      try {
        const content = JSON.stringify(f.content);
        const result = await window.funsync.writeFunscript(content, targetPath);
        if (result) {
          wrote++;
        } else {
          failed.push(f.suffix);
        }
      } catch (err) {
        console.warn('[EmbeddedMultiAxis] write failed', f.suffix, err?.message);
        failed.push(f.suffix);
      }
    }

    if (wrote === 0) {
      showToast(`Extraction failed (${failed.join(', ')})`, 'error');
      return;
    }

    // Register the extracted axes as a multi-axis association so the
    // library card, modal, stacked-view all pick them up without a
    // rescan. Preserve any existing `single` slot as the fallback main.
    try {
      const assocs = this.settings?.get?.('library.associations') || {};
      const existing = assocs[video.path] || {};
      const multi = {
        ...(existing.multi || {}),
        main: existing.multi?.main || video.funscriptPath,
        axes: { ...(existing.multi?.axes || {}), ...paths },
      };
      assocs[video.path] = {
        ...existing,
        active: 'multi',
        single: existing.single || video.funscriptPath,
        multi,
      };
      this.settings?.set?.('library.associations', assocs);
    } catch (err) {
      console.warn('[EmbeddedMultiAxis] association update failed:', err?.message);
    }

    // Refresh the library so the new companions show up in dropdowns
    // and the multi badge promotes from "embedded" to the standard
    // companion-detected variant. Non-blocking.
    this.library?.ensureScanned?.(true).catch(() => {});

    showToast(
      `Extracted ${wrote} ${wrote === 1 ? 'axis' : 'axes'} to companion files${failed.length ? ` (${failed.length} failed)` : ''}`,
      wrote > 0 ? 'info' : 'error',
      4500,
    );
  }

  _formatActionsDuration(actions) {
    if (!actions || actions.length === 0) return '0:00';
    const totalMs = actions[actions.length - 1].at - actions[0].at;
    const totalSec = Math.floor(totalMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
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
      if (e.key === 'Escape' && !popover.hidden) closePopover();
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

    // Engine → card + queue panel chip. The card is CSS-hidden when the
    // queue is open (DESIGN.md §7 / Nielsen #5), so the chip carries
    // the same "in Ns + ×" affordance into the queue surface. Both
    // consumers subscribe to the same engine — no duplicate tickers.
    this.upNextEngine.onShowNext = (path, countdownSec) => {
      this.upNextCard.show(path, countdownSec);
      this._upNextCurrentPath = path;
      this.queuePanel?.setAutoAdvanceCountdown(path, countdownSec);
      // Up Next supersedes gap-skip's trailing overlay (SCOPE §3.4).
      const gapEl = document.getElementById('gap-skip-overlay');
      if (gapEl) gapEl.hidden = true;
      this._relayUpNextShow(path, countdownSec); // mirror into the pop-out
    };
    this.upNextEngine.onShowEndOfList = (sourceLabel, sourceContext) => {
      this.upNextCard.showEndOfList(sourceLabel, sourceContext);
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
    this.videoPlayer.video.addEventListener('ended', () => {
      if (this.upNextEngine.visible && !this.upNextEngine.endOfListShown) {
        const path = this.upNextEngine._nextPath();
        this.upNextEngine.hide();
        if (path) this._playUpNext(path);
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
   * Auto-advance triggered when the countdown reaches zero or the user
   * clicks Play. Looks the path up in the current library catalog and
   * routes through library._playVideo so all the existing wiring
   * (funscript, subtitles, variants, multi-axis) runs the same way as
   * a manual library click. Snapshot context is forwarded with index+1
   * via `_playContextOverride` (per SCOPE §3.5 immutability).
   */
  async _playUpNext(path) {
    if (!path) return;
    // Mark this whole advance as an auto-advance so the downstream load paths
    // keep the mini-player docked instead of expanding to the full player.
    // try/finally keeps the flag set across the async load (during which the
    // navigate decision in _playFromLibrary reads it), then always clears it.
    const prevAuto = this._autoAdvancing;
    this._autoAdvancing = true;
    try {
      return await this._playUpNextInner(path);
    } finally {
      this._autoAdvancing = prevAuto || false;
    }
  }

  async _playUpNextInner(path) {
    // User queue priority — if the panel's user queue has items, play
    // the head before falling through to library / playlist context.
    // Mirrors foobar2000's queue priority insert (SCOPE §3.2 #3).
    if (this._userQueue && this._userQueue.length > 0) {
      const next = this._userQueue[0];
      this._userQueue = this._userQueue.slice(1);
      this._persistUserQueue();
      return this._jumpToVideoFromQueue(next);
    }
    // Queue source: advance through the queue mechanism so prev/next
    // buttons + queue indicator stay live and `_playFromLibrary`'s queue
    // reset doesn't tear down the Play All session mid-stream.
    if (this._currentPlayContext?.source === 'queue') {
      const rawNext = (this._currentPlayContext.index || 0) + 1;
      const looping = !!this._playQueueLoop;
      const isWrap = looping && this._playQueue.length > 0 && rawNext >= this._playQueue.length;
      if (isWrap && this._playQueueShuffle && this._playQueue.length > 1) {
        // New loop cycle on a shuffled queue → reshuffle for variety, avoiding
        // an immediate repeat of the item that just played (the last one).
        // Balanced queues redraw from the FULL list so each cycle can pick
        // different representatives of each script group (that's the point:
        // same track, different visuals), avoiding the just-played GROUP.
        const justPlayed = this._playQueue[this._playQueueIndex];
        this._playQueue = this._playQueueBalance
          ? reshuffleBalancedAvoidingRepeat(this._playQueueFullList || this._playQueue, (v) => this._scriptKeyOf(v), justPlayed)
          : reshuffleAvoidingRepeat(this._playQueue, justPlayed);
      }
      const wrappedIdx = looping && this._playQueue.length > 0
        ? rawNext % this._playQueue.length
        : rawNext;
      if (wrappedIdx < this._playQueue.length) {
        return this._playQueueItem(wrappedIdx);
      }
      return;
    }
    if (!this.library) return;
    const video = this.library.getVideoByPath?.(path);
    if (!video) {
      // File missing from current library scan — try to walk past it.
      const next = this.upNextEngine.advancePastMissing();
      if (next) return this._playUpNext(next);
      showToast(t('toast.nextNotFound'), 'warn', 3000);
      return;
    }
    if (this._currentPlayContext) {
      const nextIdx = (this._currentPlayContext.index || 0) + 1;
      video._playContextOverride = {
        ...this._currentPlayContext,
        index: nextIdx,
      };
    }
    // When the user opts in, an Up Next-triggered advance auto-plays
    // the next video instead of loading it paused. Default is off so
    // existing behaviour is preserved for everyone who didn't ask.
    // (Queue / Play All already auto-plays via _playQueueItem's default
    // autoPlay:true, so this flag only matters for library / playlist /
    // category sources that route through _playFromLibrary.)
    if (this.settings?.get?.('player.autoplayOnAdvance')) {
      video._autoPlayOnNextLoad = true;
    }
    await this.library._playVideo(video);
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
      onJump: (path) => this._jumpToVideoFromQueue(path),
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
   * @returns {{ items: string[], hasContext: boolean }}
   */
  _getUpcoming() {
    // Play All / queue source — pull remainder of _playQueue
    if (this._playQueue && this._playQueue.length > 0) {
      const idx = (this._playQueueIndex ?? -1) + 1;
      const items = this._playQueue
        .slice(idx, idx + 10)
        .map((entry) => entry?.path || entry)
        .filter(Boolean);
      return { items, hasContext: true };
    }
    // Library context — derive from current filter/sort
    if (this._currentPlayContext?.source === 'library'
      && this.library?._filteredVideos
      && this._currentVideoPath) {
      const filtered = this.library._filteredVideos;
      const currentIdx = filtered.findIndex((v) => v?.path === this._currentVideoPath);
      if (currentIdx < 0) return { items: [], hasContext: true };
      const items = filtered.slice(currentIdx + 1, currentIdx + 11).map((v) => v.path);
      return { items, hasContext: true };
    }
    // Drag-drop / Browse / Open Recent — no library context
    return { items: [], hasContext: false };
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
      const rest = shuffleArray(filtered.filter((_, i) => i !== curIdx));
      this._playQueue = [toEntry(filtered[curIdx]), ...rest.map(toEntry)];
      this._playQueueIndex = 0;
      this._playQueueShuffle = true;
      this._playQueueLoop = false;
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
        loop: false,
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
   * In library view the queue panel starts below the filter/sort bar (so
   * those controls stay usable) and runs to the bottom of the window. The
   * header height isn't fixed, so measure its bottom edge (viewport-relative
   * — the panel's containing block is the viewport) into a CSS var the
   * library-scoped rule reads. No-op outside library view (the player-view
   * rule keeps the default top:0 / above-controls layout).
   */
  _positionQueuePanelForLibrary() {
    const panel = document.getElementById('queue-panel');
    if (!panel) return;
    if (this._currentView() !== 'library') {
      panel.style.removeProperty('--queue-lib-top');
      return;
    }
    const header = document.querySelector('#library-container .library__header');
    if (!header) return;
    const top = Math.max(0, Math.round(header.getBoundingClientRect().bottom));
    panel.style.setProperty('--queue-lib-top', `${top}px`);
  }

  _toggleQueuePanel() {
    if (!this.queuePanel) return;
    const opening = !this.queuePanel.visible;
    if (opening) {
      this._updateQueuePanelState();
      this._positionQueuePanelForLibrary();
      this.queuePanel.open();
    } else {
      // History resets on close. Re-render is implicit because the
      // panel won't redraw while hidden.
      this._queueHistory = [];
      this.queuePanel.close();
    }
    // Sync toggle button aria-pressed + aria-expanded. The CSS uses
    // [aria-pressed="true"] to slide the button left by the panel
    // width so it lands flush with the panel's left edge.
    for (const btn of [
      document.getElementById('btn-queue-toggle'),        // player top-bar
      document.querySelector('.library__queue-toggle'),   // library header
    ]) {
      if (btn) {
        btn.setAttribute('aria-pressed', String(opening));
        btn.setAttribute('aria-expanded', String(opening));
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
   */
  async _jumpToVideoFromQueue(path) {
    if (!path || !this.library) return;
    this._maybePushCurrentToHistory();
    // If the jumped-to path is in the user queue, remove it (we're
    // about to play it; no point keeping a duplicate in the queue).
    const queueIdx = this._userQueue.indexOf(path);
    if (queueIdx >= 0) {
      this._userQueue.splice(queueIdx, 1);
      this._persistUserQueue();
    }
    const video = this.library.getVideoByPath?.(path);
    if (!video) {
      showToast(t('toast.nextNotFound'), 'warn', 3000);
      return;
    }
    await this.library._playVideo(video);
    this._updateQueuePanelState();
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
    if (ctx.playlistId && this.playlists) {
      this._navigateTo('playlists');
      this.playlists._detailPlaylistId = ctx.playlistId;
      this.playlists._view = 'detail';
      this.playlists._renderDetail?.(ctx.playlistId);
      return;
    }
    if (ctx.categoryId && this.categories) {
      this._navigateTo('categories');
      this.categories._detailCategoryId = ctx.categoryId;
      this.categories._view = 'detail';
      this.categories._renderDetail?.(ctx.categoryId);
      return;
    }
    this._navigateTo('library');
  }

  // --- Library Collections ---

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

    // Check which source paths are available (external drives may be disconnected)
    const unavailablePaths = new Set();
    await Promise.all(sources.map(async (s) => {
      try {
        const exists = await window.funsync.fileExists(s.path);
        if (!exists) unavailablePaths.add(s.path);
      } catch {
        unavailablePaths.add(s.path);
      }
    }));

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
    if (this._currentView() === 'library') {
      this.library.show(this._getViewEl('library'));
    }
  }

  async _switchCollection(collectionId) {
    this.settings.set('library.activeCollectionId', collectionId || null);
    await this._refreshCollectionsUI();
    // Re-render library if it's the active view
    if (this._currentView() === 'library') {
      this.library.show(this._getViewEl('library'));
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
          const filtered = query
            ? currentVideos.filter(v => v.name.toLowerCase().includes(query))
            : currentVideos;

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

    const result = await this._showCollectionModal(`Edit — ${col.name}`, col.name, effective, col);
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

    const confirmed = await Modal.confirm(t('toast.deleteCollectionTitle'), t('toast.deleteCollectionConfirm', { name: col.name }));
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
    const chosen = await this._showCollectionModal('Create Collection', '', new Set());
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

    // If a funscript is currently loaded but not in the variants list, add it as "Default"
    if (this.funscriptEngine.isLoaded && baseVariants.length === 0) {
      const rawContent = this.funscriptEngine.getRawContent();
      const currentPath = this.scriptEditor?._funscriptPath || null;
      const currentName = this._currentVideoName
        ? this._currentVideoName.replace(/\.[^/.]+$/, '') + '.funscript'
        : 'current.funscript';
      if (rawContent) {
        baseVariants.push({ label: t('variants.defaultLabel'), path: currentPath || '', name: currentName });
      }
    }

    // Append manually added variants from settings (with filename fallback for drive letter changes)
    const manualVariants = this.settings.get('library.manualVariants') || {};
    let manual = videoPath && manualVariants[videoPath] ? manualVariants[videoPath] : [];
    if (manual.length === 0 && videoPath) {
      // Guarded re-home (see association-rehome.js). This used to take the
      // FIRST basename match and delete it — in a library with two
      // `intro.mp4`s that stole a live video's variants and persisted the
      // mistake straight away, since this path writes settings.
      const from = pickRehomeCandidate({
        storedPaths: Object.keys(manualVariants).filter((p) => manualVariants[p]?.length > 0),
        videoPath,
        isLive: (p) => !!this.library?.getVideoByPath?.(p),
      });
      if (from) {
        manual = manualVariants[from];
        manualVariants[videoPath] = manual;
        delete manualVariants[from];
        this.settings.set('library.manualVariants', manualVariants);
        console.log(`[Variants] Re-homed moved video's variants: ${from} → ${videoPath}`);
      }
    }
    // Merge base + manual, deduplicating by path (manual variants may overlap with auto-detected)
    const seenPaths = new Set(baseVariants.map(v => v.path));
    const deduped = manual.filter(v => !seenPaths.has(v.path));
    const allVariants = [...baseVariants, ...deduped];

    // Resolve active index from stored path (array may have been rebuilt)
    if (this._activeVariantPath) {
      const idx = allVariants.findIndex(v => v.path === this._activeVariantPath);
      if (idx >= 0) this._activeVariantIndex = idx;
    } else {
      // No active path (Default variant) — reset to index 0
      this._activeVariantIndex = 0;
    }

    // Show selector only if there are variants (or always to allow adding)
    if (allVariants.length > 1 || this._currentVideoPath) {
      selector.hidden = false;
      const active = allVariants[this._activeVariantIndex];
      // Target the label span — don't touch button.textContent or
      // we'd wipe the chevron SVG inserted by createIcons().
      const labelEl = document.getElementById('variant-btn-label');
      if (labelEl) {
        labelEl.textContent = active ? active.label : t('variants.defaultLabel');
      }
    } else {
      selector.hidden = true;
    }

    this._allVariantsWithManual = allVariants;
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
      const fresh = match.variants || [];
      const cur = this._currentVariants || [];
      const changed = fresh.length !== cur.length
        || fresh.some((v, i) => v.path !== cur[i]?.path);
      if (changed) {
        this._currentVariants = fresh;
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
    // Guarded re-home (see association-rehome.js): refuses when several
    // stored entries share the filename, or when the candidate's video is
    // still in the library. Previously took the first match and deleted it,
    // persisting a wrong pin immediately.
    const from = pickRehomeCandidate({
      storedPaths: Object.keys(map).filter((p) => map[p]),
      videoPath,
      isLive: (p) => !!this.library?.getVideoByPath?.(p),
    });
    if (from) {
      const label = map[from];
      map[videoPath] = label;
      delete map[from];
      this.settings.set('library.preferredVariants', map);
      console.log(`[Variants] Re-homed pinned default variant: ${from} → ${videoPath}`);
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
    if (variants.length < 2) return;
    const randomOn = this.settings.get('player.randomVariantOnPlay') === true;
    const idx = pickVariantIndexOnLoad(variants, {
      randomOn,
      preferredLabel: this._getPreferredVariantLabel(videoPath),
    });
    if (idx > 0) await this._switchVariant(idx);
    if (randomOn) {
      const label = variants[idx]?.label || t('library.variantDefault');
      showToast(t('toast.randomVariant', { name: label }), 'info', 2500);
    }
  }

  _showVariantDropdown() {
    const dropdown = document.getElementById('variant-dropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';
    dropdown.hidden = false;

    const variants = this._allVariantsWithManual || [];
    // Per-video pinned default (only meaningful with 2+ variants to pick from).
    const preferredLabel = variants.length > 1
      ? this._getPreferredVariantLabel(this._currentVideoPath)
      : null;
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const item = document.createElement('button');
      item.className = 'variant-selector__item';
      if (i === this._activeVariantIndex) item.classList.add('variant-selector__item--active');

      const label = document.createElement('span');
      label.className = 'variant-selector__item-label';
      label.textContent = v.label;
      item.appendChild(label);

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
            newLabel ? t('variants.defaultSet', { label: v.label }) : t('variants.defaultCleared'),
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
        dropdown.hidden = true;
      });
      dropdown.appendChild(item);
    }

    // Add variation button
    const addBtn = document.createElement('button');
    addBtn.className = 'variant-selector__add';
    addBtn.textContent = t('variants.addVariation');
    addBtn.addEventListener('click', async () => {
      dropdown.hidden = true;
      this._showAddVariantModal();
    });
    dropdown.appendChild(addBtn);

    // Manage variations button (only if there are manual variants)
    const videoPath = this._currentVideoPath;
    const manualVariants = this.settings.get('library.manualVariants') || {};
    const manualForVideo = videoPath && manualVariants[videoPath] ? manualVariants[videoPath] : [];
    if (manualForVideo.length > 0) {
      const manageBtn = document.createElement('button');
      manageBtn.className = 'variant-selector__add';
      manageBtn.textContent = t('variants.manageVariations');
      manageBtn.addEventListener('click', () => {
        dropdown.hidden = true;
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

    // Update current variants and switch to the new one
    this._updateVariantSelector();
    this._switchVariant(this._allVariantsWithManual.length - 1);
  }

  async _showAddVariantModal() {
    // Get all funscripts from library sources
    const sources = this.settings.get('library.sources') || [];
    const dirPath = sources.length > 0
      ? sources.filter(s => s.enabled !== false).map(s => s.path)
      : this.settings.get('library.directory');
    if (!dirPath || (Array.isArray(dirPath) && dirPath.length === 0)) {
      // No library — fall back to file dialog
      const result = await window.funsync.selectFunscript();
      if (result) await this._addManualVariant(result.path, result.name);
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
      const result = await window.funsync.selectFunscript();
      if (result) await this._addManualVariant(result.path, result.name);
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
        browseRow.className = 'modal-list-item library__browse-fallback';
        browseRow.textContent = t('variants.browse');
        browseRow.addEventListener('click', async () => {
          const result = await window.funsync.selectFunscript();
          if (result) close(result);
        });
        body.appendChild(browseRow);
      },
    });

    if (!chosen) return;
    await this._addManualVariant(chosen.path, chosen.name);
  }

  async _showManageVariantsModal() {
    const videoPath = this._currentVideoPath;
    if (!videoPath) return;

    const manualVariants = this.settings.get('library.manualVariants') || {};
    const manualForVideo = manualVariants[videoPath] ? [...manualVariants[videoPath]] : [];
    if (manualForVideo.length === 0) return;

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

            const label = document.createElement('span');
            label.className = 'modal-list-item-label';
            label.style.flex = '1';
            label.textContent = v.label;
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
      const fresh = this.settings.get('library.manualVariants') || {};
      if (manualForVideo.length === 0) {
        delete fresh[videoPath];
      } else {
        fresh[videoPath] = manualForVideo;
      }
      this.settings.set('library.manualVariants', fresh);
      this._updateVariantSelector();
    }
  }

  async _switchVariant(index) {
    const variants = this._allVariantsWithManual || [];
    if (index < 0 || index >= variants.length) return;
    if (index === this._activeVariantIndex) return;

    const variant = variants[index];
    this._activeVariantIndex = index;
    this._activeVariantPath = variant.path || null;

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

    try {
      // Resilient read — recovers from a moved file by trying the same
      // basename in the current video's folder, and prunes the entry
      // from manualVariants if it can't recover at all.
      const read = await this._readScriptResilient(variant.path, this._currentVideoPath || null);
      if (!read) return;
      const content = read.content;
      // Self-heal: update the variant entry + the persisted manualVariants
      // store so subsequent plays use the recovered path directly.
      if (read.recoveredPath) {
        variant.path = read.recoveredPath;
        this._activeVariantPath = read.recoveredPath;
        this._healManualVariantPath(this._currentVideoPath, variant);
      }

      const fsName = variant.name || variant.path.split(/[\\/]/).pop();
      await this.funscriptEngine.loadContent(content, fsName);

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
        await this._uploadAndStartSync();
      }

      // Re-upload to Autoblow
      await this._tryStartAutoblowSync();

      // Reload editor if open
      if (this.scriptEditor?.isOpen) {
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
        this.remoteBridge.sendToPhone({ type: 'variant-changed', label: variant.label });
        if (willPauseAny) {
          // Hides the phone-side loading overlay + resumes the phone's
          // <video>. Sent in both surface cases so the phone always
          // gets the bookend it expects after a `script-loading`.
          this.remoteBridge.sendToPhone({ type: 'script-ready' });
        }
      }

      showToast(t('toast.nowPlayingVariant', { label: variant.label }), 'info', 2000);
    } catch (err) {
      console.warn('[Variants] Switch failed:', err.message);
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
    const next = (this._activeVariantIndex + direction + variants.length) % variants.length;
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
    this._applyInlineVizOpacity();
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
    const inPlayer = this._currentView?.() === 'player' && !document.fullscreenElement;
    if (!inPlayer) {
      // Back to the normal themed chrome (idempotent).
      if (this._captionOverlayState !== 'normal') {
        this._captionOverlayState = 'normal';
        try { window.funsync.updateWindowChrome(theme); } catch { /* non-fatal */ }
      }
      return;
    }
    const shown = visible === null
      ? !!document.querySelector('.player-container.controls-visible')
      : !!visible;
    const next = shown ? 'over-video' : 'over-video-hidden';
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
      });
    } catch { /* non-fatal */ }
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
    this._playQueueShuffle = !!opts.shuffle;
    // Balance-by-script (zaikechi #221): only meaningful when shuffling —
    // videos sharing an associated script collapse into one slot with a
    // random member drawn per cycle, so a track with 6 matching videos
    // isn't weighted 6×. The FULL list is kept for loop-wrap redraws
    // (fresh representatives each cycle).
    this._playQueueBalance = this._playQueueShuffle && !!opts.balanceByScript;
    this._playQueueFullList = videoList;
    // Bag model: shuffle the whole list ONCE at Play All so there are no
    // repeats within a cycle (per-track random would produce back-to-back
    // repeats that read as "broken shuffle"). Reshuffled on each loop wrap
    // below. SCOPE-playlist-shuffle-reorder.md §7.
    const drawShuffled = (list) => (this._playQueueBalance
      ? balancedShuffle(list, (v) => this._scriptKeyOf(v))
      : shuffleArray(list));

    if (!this._playQueueShuffle) {
      this._playQueue = videoList;
    } else if (opts.preferUnwatched && typeof opts.isWatched === 'function') {
      // Unwatched first, each half shuffled independently so the bag model
      // (and balance-by-script within it) still applies. Watched items are
      // moved to the back rather than dropped — a marathon of a fully-seen
      // playlist must still play.
      const { unwatched: unseen, watched: seen } = partitionByWatched(
        videoList,
        (p) => (opts.isWatched(p) ? { finished: true } : null),
        (v) => v.path,
      );
      this._playQueue = [
        ...(unseen.length ? drawShuffled(unseen) : []),
        ...(seen.length ? drawShuffled(seen) : []),
      ];
    } else {
      this._playQueue = drawShuffled(videoList);
    }
    this._playQueueIndex = 0;
    this._playQueueLoop = !!opts.loop;
    this._playQueueSource = {
      sourceLabel: opts.sourceLabel || t('upNext.sourcePlaylist'),
      sourceContext: opts.sourceContext || {},
    };
    this._navigateTo('player');
    this._playQueueItem(0);
  }

  _playQueueItem(index) {
    if (index >= this._playQueue.length) return;
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
    // doesn't race ahead of Handy / Autoblow re-upload.
    if (item.funscriptPath) {
      this._markCloudUploadsPending();
    }

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
    this.loadVideo(fileData, { skipViewSwitch: true });
    // Before playback starts, so the sync engine anchors at the resumed
    // position instead of the seek-correction path fixing it up after.
    if (resumeAt) this._applyPendingResumeSeek(resumeAt);

    if (item.funscriptPath) {
      window.funsync.readFunscript(item.funscriptPath).then((content) => {
        if (content) {
          const fsName = item.funscriptPath.split(/[\\/]/).pop();
          this.loadFunscript({ name: fsName, textContent: content });
          // Re-stream now the funscript is loaded so the pop-out heatmap fills.
          if (this._playerWindowActive) this._streamPlayerWindowData();
        } else {
          // Silent skip would leave the user wondering why the next
          // video plays with no device sync — surface it.
          const fsName = item.funscriptPath.split(/[\\/]/).pop();
          showToast(t('toast.queueReadFailed', { name: item.name, script: fsName }), 'warn', 5000);
        }
      }).catch((err) => {
        showToast(t('toast.queueReadError', { name: item.name, error: err.message }), 'warn', 5000);
      });
    }

    this._updateQueueUI();
    // Queue nav while the pop-out is open → route the new item into it.
    this._routeLoadedVideoToPlayerWindow();

    // Wire auto-advance on ended (remove previous listener if any). The
    // local-var supersede guard prevents a stale in-flight listener from
    // double-advancing when Up Next routed the same `ended` event back
    // through `_playQueueItem` (the old listener is captured in the event
    // dispatch loop before `removeEventListener` can take effect).
    if (this._queueEndedListener) {
      this.videoPlayer.video.removeEventListener('ended', this._queueEndedListener);
    }
    const queueEndedListener = () => {
      if (this._queueEndedListener !== queueEndedListener) return; // superseded
      this.videoPlayer.video.removeEventListener('ended', queueEndedListener);
      this._queueEndedListener = null;
      this._advanceQueueOnEnded();
    };
    this._queueEndedListener = queueEndedListener;
    this.videoPlayer.video.addEventListener('ended', queueEndedListener);
  }

  /**
   * Play-All advance on natural video end. Shared by the inline
   * `queueEndedListener` and the pop-out's `_onPopoutVideoEnded` so both
   * surfaces continue the queue identically. Returns true if it advanced.
   */
  _advanceQueueOnEnded() {
    // User queue priority — when present, intercepts Play All advancement
    // so a queued video plays next rather than the next playlist item.
    // Mirrors the same priority injection in _playUpNext (SCOPE §3.2 #3).
    if (this._userQueue && this._userQueue.length > 0) {
      const next = this._userQueue[0];
      this._userQueue = this._userQueue.slice(1);
      this._persistUserQueue();
      // Keep the mini-player docked across this auto-advance (see _playUpNext).
      // _jumpToVideoFromQueue is async; hold the flag until its load settles.
      this._autoAdvancing = true;
      Promise.resolve(this._jumpToVideoFromQueue(next))
        .finally(() => { this._autoAdvancing = false; });
      return true;
    }
    const nextIdx = this._playQueueIndex + 1;
    if (nextIdx < this._playQueue.length) {
      this._playQueueItem(nextIdx);
      return true;
    }
    if (this._playQueueLoop && this._playQueue.length > 0) {
      // Wrap to the start. Persistent loop on the playlist itself — user
      // opted in via the playlist's loop toggle; no end-of-list, just
      // continuous marathon mode until they pause / navigate away.
      this._playQueueItem(0);
      return true;
    }
    return false;
  }

  _playPrev() {
    if (this._playQueueIndex > 0) {
      this._playQueueItem(this._playQueueIndex - 1);
      return true;
    }
    return this._stepPlayContext(-1);
  }

  _playNext() {
    if (this._playQueueIndex + 1 < this._playQueue.length) {
      this._playQueueItem(this._playQueueIndex + 1);
      return true;
    }
    return this._stepPlayContext(+1);
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

    const targetIdx = (ctx.index || 0) + delta;
    if (targetIdx < 0 || targetIdx >= list.length) return false;

    const path = list[targetIdx];
    if (!path || !this.library) return false;

    const video = this.library.getVideoByPath?.(path);
    if (!video) {
      // Present in the snapshot but gone from the current scan (deleted,
      // or an unplugged drive). Say so rather than failing silently.
      showToast(t('toast.nextNotFound'), 'warn', 3000);
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
    }, RESUME_WRITE_INTERVAL_MS);

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
    // A phone controlling playback is the third surface (after the desktop
    // element and the pop-out). Unlike the pop-out, the web-remote path
    // does NOT repoint `upNextEngine.player`, so without this branch every
    // sample during a phone session would read the intentionally-paused
    // desktop element: no recording while the phone plays, and a stale
    // position written over a good one at the next video change.
    if (this._remoteActive && this._remoteProxy) {
      if (!this._remoteResumeClock || this._remoteResumeClockFor !== this._remoteProxy) {
        this._remoteResumeClock = this._remoteProxy.asVideoPlayerWrapper();
        this._remoteResumeClockFor = this._remoteProxy;
      }
      return this._remoteResumeClock;
    }
    return this.upNextEngine?.player || this.videoPlayer?.video || null;
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
      // Re-validate against the duration we now actually know.
      if (Number.isFinite(video.duration) && video.duration > 0 && seconds < video.duration) {
        video.currentTime = seconds;
      }
    };
    if (Number.isFinite(video.duration) && video.duration > 0) seek();
    else video.addEventListener('loadedmetadata', seek);
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
    const show = hasQueue || hasContext;

    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const indicator = document.getElementById('queue-indicator');
    if (btnPrev) {
      btnPrev.hidden = !show;
      btnPrev.disabled = hasQueue
        ? this._playQueueIndex <= 0
        : ctxIndex <= 0;
    }
    if (btnNext) {
      btnNext.hidden = !show;
      btnNext.disabled = hasQueue
        ? this._playQueueIndex >= this._playQueue.length - 1
        : ctxIndex >= (ctxList ? ctxList.length - 1 : 0);
    }
    if (indicator) {
      indicator.hidden = !show;
      if (hasQueue) {
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
        hasPrev: hasQueue ? this._playQueueIndex > 0 : (hasContext && ctxIndex > 0),
        hasNext: hasQueue
          ? this._playQueueIndex < this._playQueue.length - 1
          : (hasContext && ctxIndex < ctxList.length - 1),
        label: hasQueue
          ? `${this._playQueueIndex + 1} / ${this._playQueue.length}`
          : (hasContext ? `${ctxIndex + 1} / ${ctxList.length}` : ''),
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
        this.videoPlayer.video.play().catch(() => {});
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
      this.videoPlayer.video.play().catch(() => {});
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
        const dot = document.createElement('span');
        dot.className = 'player__category-dot';
        dot.style.background = cat.color;
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

  _showUpdateToast(data) {
    const container = document.createElement('div');
    container.className = 'update-toast';

    const text = document.createElement('span');
    text.textContent = t('updater.available', { version: data.version });
    container.appendChild(text);

    const btn = document.createElement('button');
    btn.className = 'update-toast__btn';
    btn.textContent = t('updater.download');
    btn.addEventListener('click', () => {
      window.funsync.updaterDownload();
      btn.disabled = true;
      btn.textContent = t('updater.downloading');
    });
    container.appendChild(btn);

    showToast(container, 'info', 15000);
  }

  _updateDownloadProgress(data) {
    // Progress is logged; could add a progress bar in future
    console.log(`[AutoUpdater] Download: ${data.percent}%`);
  }

  _showUpdateReadyToast(data) {
    const container = document.createElement('div');
    container.className = 'update-toast';

    const text = document.createElement('span');
    text.textContent = t('updater.ready', { version: data.version });
    container.appendChild(text);

    const btn = document.createElement('button');
    btn.className = 'update-toast__btn';
    btn.textContent = t('updater.restartNow');
    btn.addEventListener('click', () => {
      window.funsync.updaterInstall();
    });
    container.appendChild(btn);

    showToast(container, 'info', 0); // Persistent until dismissed
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
