// FunSync Player — App Entry Point

import { VideoPlayer } from './video-player.js';
import { ProgressBar } from './progress-bar.js';
import { FunscriptEngine, isAutoMatch } from './funscript-engine.js';
import { HandyManager } from './handy-manager.js';
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
import { matchButtplugRoute } from './custom-routing-match.js';
import { normalizeAssociation, buildAssociationEntry, resolveActiveConfig } from './association-shape.js';
import { pathToFileURL, canonicalPath } from './path-utils.js';
import { Library } from '../components/library.js';
import { NavBar } from '../components/nav-bar.js';
import { Modal } from '../components/modal.js';
import { rankFunscriptMatches } from './fuzzy-match.js';
import { Playlists } from '../components/playlists.js';
import { Categories } from '../components/categories.js';
import { ScriptEditor } from '../components/script-editor.js';
import { DeviceSimulator } from '../components/device-simulator.js';
import { GapSkipEngine } from './gap-skip.js';
import { EroScriptsPanel } from '../components/eroscripts-panel.js';
import {
  createIcons, icon, Play, Pause, Volume2, VolumeX, FolderOpen, Bluetooth,
  Maximize, Minimize, ArrowLeft, Plus, PictureInPicture2, SkipBack, SkipForward,
  Pencil, FileCheck, Captions, RotateCcw,
} from './icons.js';
import { startInit, span, mark, logSummary } from './startup-timer.js';

class App {
  constructor() {
    this.videoPlayer = null;
    this.progressBar = null;
    this.funscriptEngine = null;
    this.handyManager = null;
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
    this._navStack = ['library']; // navigation history stack — current view is last element
    this._scriptCloudUrl = null; // cloud URL of the last uploaded script (for re-setup after HDSP)
    this._waitingForScript = false; // true while funscript is uploading to Handy cloud
    this._scriptLoadingTimeout = null; // fallback timeout for script upload
  }

  async init() {
    startInit();
    // Initialize data service (loads data from main process, handles migration)
    await span('dataService.init', () => dataService.init());

    // Renderer error handlers (electron-log forwards console to main log file)
    window.onerror = (msg, src, line, col, err) => console.error('[Window]', msg, err);
    window.addEventListener('unhandledrejection', (e) => console.error('[Rejection]', e.reason));

    // Replace <i data-lucide="..."> placeholders with SVG icons
    createIcons({
      icons: {
        Play, Pause, Volume2, VolumeX, FolderOpen, Bluetooth,
        Maximize, Minimize, ArrowLeft, Plus, PictureInPicture2, SkipBack, SkipForward,
        Pencil, RotateCcw,
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

    // Initialize core video player (must succeed for anything to work)
    this.videoPlayer = new VideoPlayer({
      videoElement: document.getElementById('video'),
      controlsElement: document.getElementById('controls'),
      containerElement: document.getElementById('player-container'),
    });

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

    // Initialize drag-and-drop EARLY — this must always work
    this.dragDrop = new DragDrop({
      dropZoneElement: null,
      onVideoFile: (file) => this.loadVideo(file),
      onFunscriptFile: (file) => this.loadFunscript(file),
      onSubtitleFile: (file) => this.videoPlayer.loadSubtitles(file),
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
      onSmoothingChanged: (mode) => {
        if (this.buttplugSync) this.buttplugSync.setInterpolationMode(mode);
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
      settings: this.settings,
    });

    // Load saved collections into nav bar + library (must be after library creation)
    await this._refreshCollectionsUI();

    // Playlists
    this.playlists = new Playlists({
      settings: this.settings,
      library: this.library,
      onPlayVideo: (videoData, funscriptData, subtitleData, variants) => this._playFromLibrary(videoData, funscriptData, subtitleData, variants),
      onPlayAll: (videoList) => this._playAll(videoList),
    });

    // Categories
    this.categories = new Categories({
      settings: this.settings,
      library: this.library,
      onPlayVideo: (videoData, funscriptData, subtitleData, variants) => this._playFromLibrary(videoData, funscriptData, subtitleData, variants),
    });

    // Player back button
    const btnPlayerBack = document.getElementById('btn-player-back');
    if (btnPlayerBack) {
      btnPlayerBack.addEventListener('click', () => this._navigateBack());
    }

    // Quick-add to playlist button in player top bar
    const btnAddToPlaylist = document.getElementById('btn-add-to-playlist');
    if (btnAddToPlaylist) {
      btnAddToPlaylist.addEventListener('click', () => this._quickAddToPlaylist());
    }

    // Queue navigation (prev/next)
    document.getElementById('btn-prev')?.addEventListener('click', () => this._playPrev());
    document.getElementById('btn-next')?.addEventListener('click', () => this._playNext());

    // Wire thumbnail preview on progress hover
    this.videoPlayer.onProgressHover = (time) => {
      this.progressBar.updateThumbnailPreview(time);
    };

    // Redraw heatmap on resize
    window.addEventListener('resize', () => this.progressBar.redraw());

    // Gate library hover preview when main video is playing
    this.videoPlayer.video.addEventListener('play', () => {
      if (this.library) this.library._isVideoPlaying = true;
    });
    this.videoPlayer.video.addEventListener('pause', () => {
      if (this.library) this.library._isVideoPlaying = false;
    });
    this.videoPlayer.video.addEventListener('ended', () => {
      if (this.library) this.library._isVideoPlaying = false;
    });

    // Render heatmap once video duration is known
    this.videoPlayer.video.addEventListener('loadedmetadata', () => {
      if (this.funscriptEngine.isLoaded) {
        this.progressBar.renderHeatmap(
          this.funscriptEngine.getActions(),
          this.videoPlayer.duration,
        );
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
      });

      // Load saved smoothing settings into buttplug sync
      if (this.buttplugSync) {
        const savedSmoothing = this.settings.get('player.smoothing') || 'linear';
        const savedSpeedLimit = this.settings.get('player.speedLimit') || 0;
        this.buttplugSync.setInterpolationMode(savedSmoothing);
        this.buttplugSync.setSpeedLimit(savedSpeedLimit);

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
        };

        const panelOnDisconnect = this.handyManager.onDisconnect;
        this.handyManager.onDisconnect = () => {
          if (panelOnDisconnect) panelOnDisconnect();
          console.log('[Handy] Disconnected — stopping sync engine');
          if (this.syncEngine) this.syncEngine.stop();
          this._updateHandyIndicators('disconnected');
          this._updateDeviceIndicators();
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
        };

        const panelTCodeDisconnect = this.tcodeManager.onDisconnect;
        this.tcodeManager.onDisconnect = () => {
          if (panelTCodeDisconnect) panelTCodeDisconnect();
          console.log('[TCode] Disconnected — stopping sync engine');
          if (this.tcodeSync) this.tcodeSync.stop();
          this._updateDeviceIndicators();
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
            showToast(`Downloaded ${fsName} but the file couldn't be read — try a manual load from Library`, 'warn', 6000);
          }
        }).catch((err) => {
          showToast(`Failed to auto-load downloaded script: ${err.message}`, 'error', 5000);
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

    // Wire script editor + device simulator + gap skip + variants into keyboard handler
    if (this._keyboard) {
      this._keyboard.scriptEditor = this.scriptEditor;
      this._keyboard.deviceSimulator = this.deviceSimulator;
      this._keyboard.gapSkipEngine = this.gapSkipEngine;
      this._keyboard.onCycleVariant = (dir) => this._cycleVariant(dir);
    }

    // Editor toggle button
    const btnEditor = document.getElementById('btn-editor');
    if (btnEditor) {
      btnEditor.addEventListener('click', () => this.scriptEditor.toggle());
    }

    // Initialize subtitle badge icon
    const subBadgeInit = document.getElementById('subtitle-badge');
    if (subBadgeInit) {
      subBadgeInit.appendChild(icon(Captions, { width: 20, height: 20, 'stroke-width': 1.75 }));
    }

    // Variant selector button
    const variantBtn = document.getElementById('variant-btn');
    if (variantBtn) {
      variantBtn.addEventListener('click', () => {
        const dropdown = document.getElementById('variant-dropdown');
        if (dropdown && !dropdown.hidden) {
          dropdown.hidden = true;
        } else {
          this._showVariantDropdown();
        }
      });
    }

    // Stop Handy device when app closes
    window.addEventListener('beforeunload', () => {
      try {
        if (this._sourcePollingInterval) clearInterval(this._sourcePollingInterval);
        if (this._vrActivityInterval) clearInterval(this._vrActivityInterval);
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

    // If we have a saved Quest host from a previous session, try to
    // reconnect directly — the in-memory backend _vr_activity record
    // resets to null on app restart, so the polling path can't help
    // until the user navigates a scene on HereSphere. A direct connect
    // using the last-known host closes that gap for the "app restarted
    // while HereSphere is still running" case.
    this._attemptSavedHostReconnect();

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

        // For Handy on a non-main route: upload and start its own sync
        if (route.deviceId === 'handy' && this.handyManager?.connected) {
          await this.handyManager.uploadAndSetScript(content);
          this.syncEngine?._scriptReady && this.syncEngine.start();
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

    // Update editor script list for custom routing
    if (this.scriptEditor) {
      const knownDevices = this.settings.get('knownDevices') || [];
      const scripts = [];
      for (const route of routes) {
        if (!route.scriptPath) continue;
        const device = knownDevices.find(d => d.id === route.deviceId);
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
  _matchButtplugRoute(route) {
    if (!this.buttplugManager?.connected) return null;
    const result = matchButtplugRoute(route, this.buttplugManager.devices);
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

    for (const route of routes) {
      if (!route.deviceId?.startsWith('buttplug:')) continue;
      if (!route._assignedAxis) continue;

      const match = this._matchButtplugRoute(route);
      if (match) {
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
    // even when it wasn't open at the moment the video changed.
    const displayName = rawPath.split(/[\\/]/).pop() || normalizedName;
    if (this.vrBridge) this.vrBridge.__vrModalLastVideo = displayName;

    // Stop existing sync engines (they'll be rebound to VR proxy)
    this._stopVRSync();

    // Ensure the library has scanned at least once — re-uses existing _videos
    // + manual associations instead of duplicating that logic here.
    if (!this.library) {
      showToast('Library unavailable — cannot match VR script', 'warn');
      return;
    }
    await this.library.ensureScanned();

    // Abort if a newer video change arrived while we were scanning
    if (gen !== this._vrMatchGeneration) return;

    if (!this.library._videos?.length) {
      showToast('No library sources configured — cannot match VR script', 'warn');
      return;
    }

    const matched = this.library.findVideoByVRPath(normalizedName, rawPath);

    if (!matched || !matched.hasFunscript) {
      showToast(`No script found for: ${displayName}`, 'info', 4000);
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
      showToast(`VR script loaded: ${fsName}`, 'info', 3000);

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
      showToast('Failed to load VR script', 'error');
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

      const sourceLabel = (src) => src === 'web-remote' ? 'Web Remote' : 'VR Companion';
      showToast(
        `${sourceLabel(incoming?.source)} took over from ${sourceLabel(evicted.source)}`,
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
      showToast(`Remote taken over by ${newIp}`, 'info', 4000);
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
      showToast(`Remote playing ${displayName} — no script`, 'info', 4000);
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
      const actionCount = this.funscriptEngine.getActions().length;
      this.remoteBridge.sendToPhone({
        type: 'script-ready',
        videoId,
        actionCount,
      });
      this.sessionTracker?.markScriptReady(actionCount);
      this._pushRemoteDeviceStatus();

      showToast(`Remote connected from ${ip}`, 'info', 3500);
    } catch (err) {
      console.warn('[Remote] failed to prepare script:', err);
      this.remoteBridge.sendToPhone({ type: 'script-missing', videoId });
      this.sessionTracker?.setState('error');
    }
  }

  _onRemotePhoneDisconnected(_ip) {
    this._remoteActive = false;

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

    showToast('Remote disconnected', 'info', 2500);
  }

  _pushRemoteDeviceStatus() {
    // Build an actual device list, not just four transport booleans —
    // Buttplug's `connected` flag means "connected to Intiface", which
    // stays true even when zero devices are paired; the phone was
    // rendering "Connected: Buttplug" with no actual hardware present.
    const devices = [];

    if (this.handyManager?.connected) {
      devices.push({ kind: 'handy', label: 'The Handy' });
    }
    if (this.buttplugManager?.connected) {
      for (const d of this.buttplugManager.devices || []) {
        devices.push({ kind: 'buttplug', label: d.name });
      }
    }
    if (this.tcodeManager?.connected) {
      const port = this.tcodeManager.portPath || 'serial';
      devices.push({ kind: 'tcode', label: `TCode (${port})` });
    }
    if (this.autoblowManager?.connected) {
      const ab = this.autoblowManager.isUltra ? 'Autoblow Ultra' : 'VacuGlide 2';
      devices.push({ kind: 'autoblow', label: ab });
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
   * Called from a 2s polling tick — the bridge doesn't emit events
   * during backoff retries, so polling is the cheapest way to surface
   * live "Reconnecting... (attempt N)" feedback without opening the VR
   * modal.
   */
  _updateVRTooltip() {
    if (!this.navBar || !this.vrBridge) return;
    if (this.vrBridge.connected) {
      this.navBar.setVRTooltip('connected', { host: this.vrBridge._host });
    } else if (this.vrBridge._reconnecting || this.vrBridge._reconnectTimer) {
      this.navBar.setVRTooltip('reconnecting', { attempt: this.vrBridge._reconnectAttempts });
    } else {
      this.navBar.setVRTooltip('disconnected');
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
      showToast('VR companion reconnected — devices syncing', 'info', 3000);
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

      const isNewActivity = data.timestamp > this._lastVrActivityTs;
      // If bridge is connected and no new activity, skip
      if (!isNewActivity && this.vrBridge.connected) return;
      // If bridge is disconnected, keep retrying every 10s even for same activity
      if (!isNewActivity && (performance.now() - (this._lastVrRetryTime || 0)) < 10000) return;

      this._lastVrActivityTs = data.timestamp;
      this._lastVrRetryTime = performance.now();

      console.log(`[VR] Quest activity detected: ${data.clientIp} playing ${data.videoId}`);

      // Try to connect companion bridge (non-blocking single attempt)
      // If it fails, the next poll cycle (2s) will try again with any new activity
      if (!this.vrBridge.connected) {
        const success = await this.vrBridge.connect('heresphere', data.clientIp, 23554);
        if (success) {
          showToast('VR companion connected — devices syncing', 'info', 3000);
          // Tear down any stale hint toast that's still on screen, and
          // reset the "already hinted" flag so if the Quest later drops
          // and the user closes+reopens HereSphere mid-session, the
          // timestamp-server hint can fire again.
          this._dismissTimestampServerHint();
          this._vrTimestampHintShown = false;
          // Bridge's onConnect callback already drives the nav-bar tint
          // and the VR modal live-updates when open; nothing extra to do.
        } else {
          this._maybeShowTimestampServerHint(this.vrBridge._lastError);
        }
      }
    } catch {
      // Backend not running or fetch failed — ignore
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
  _maybeShowTimestampServerHint(lastError) {
    if (!lastError) return;
    if (this._vrTimestampHintShown) return;
    // Only fire for the specific "server not listening" case — other VR
    // errors (wrong host, DNS, firewall) have different messages and
    // shouldn't get the HereSphere-specific guidance.
    const looksLikeRefused = /ECONNREFUSED/i.test(lastError) && /23554/.test(lastError);
    if (!looksLikeRefused) return;
    this._vrTimestampHintShown = true;

    this._vrTimestampHintToast = showToast(
      "VR companion can't reach HereSphere's timestamp server. " +
      'On the Quest: HereSphere → Settings → Timestamp Server → enable it. ' +
      'If it was already enabled, fully quit HereSphere and reopen — the ' +
      'timestamp server sometimes needs a restart to start listening. ' +
      '(Click to dismiss.)',
      'warn',
      15000,  // 15s — long enough to read + act, short enough to not nag
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
      if (!this.handyManager?.connected) return { ok: false, reason: 'Handy not connected' };
      try {
        // HandyManager wraps the raw SDK hdsp() — use the wrapper, not the
        // private SDK object. Arguments are (position%, durationMs).
        await this.handyManager.hdspMove(70, 500);
        await new Promise(r => setTimeout(r, 550));
        await this.handyManager.hdspMove(20, 500);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || 'Handy test failed' };
      }
    }

    if (deviceId === 'tcode') {
      if (!this.tcodeManager?.connected) return { ok: false, reason: 'TCode device not connected' };
      try {
        // L0 stroke: 700→200 over ~500ms. Value scale is 000–999.
        await this.tcodeManager.send('L0700I500\n');
        await new Promise(r => setTimeout(r, 550));
        await this.tcodeManager.send('L0200I500\n');
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || 'TCode test failed' };
      }
    }

    if (deviceId === 'autoblow') {
      if (!this.autoblowManager?.connected) return { ok: false, reason: 'Autoblow not connected' };
      // No standalone pulse command on the Autoblow cloud API — best we can
      // do is tell the user we know about it but can't test without a script.
      return { ok: false, reason: 'Autoblow has no pulse API — play a video to verify' };
    }

    if (deviceId?.startsWith('buttplug:')) {
      if (!this.buttplugManager?.connected) return { ok: false, reason: 'Intiface not connected' };
      // Match by index first (stable), then name — same priority as routing.
      const bpDevices = this.buttplugManager.devices;
      let dev = null;
      if (Number.isFinite(buttplugIndex)) {
        dev = bpDevices.find(d => d.index === buttplugIndex);
        if (dev && `buttplug:${dev.name}` !== deviceId) dev = null; // name must confirm
      }
      if (!dev) dev = bpDevices.find(d => `buttplug:${d.name}` === deviceId);
      if (!dev) return { ok: false, reason: `Device "${deviceId.replace(/^buttplug:/, '')}" not connected` };

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
          return { ok: false, reason: 'Device has no testable output' };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || 'Buttplug test failed' };
      }
    }

    return { ok: false, reason: `Unknown device id "${deviceId}"` };
  }

  _registerKnownDevice(id, label, type, extras = {}) {
    const devices = this.settings.get('knownDevices') || [];
    const existing = devices.find(d => d.id === id);
    if (existing) {
      // Refresh mutable fields (label may change; buttplugIndex in particular is
      // updated every reconnect so routes can prefer it over the name match).
      let dirty = false;
      if (existing.label !== label) { existing.label = label; dirty = true; }
      for (const [k, v] of Object.entries(extras)) {
        if (v !== undefined && existing[k] !== v) { existing[k] = v; dirty = true; }
      }
      if (dirty) this.settings.set('knownDevices', devices);
      return;
    }
    devices.push({ id, label, type, ...extras });
    this.settings.set('knownDevices', devices);
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
      showToast(`Source disconnected: ${names.join(', ')}`, 'warn', 5000);
      // Invalidate library cache
      if (this.library) this.library._lastScanKey = null;
      // If library is the active view, re-render
      if (this._currentView() === 'library') {
        this.library.show(this._getViewEl('library'));
      }
    }

    if (becameAvailable.length > 0) {
      const names = sources.filter(s => becameAvailable.includes(s.path)).map(s => s.name);
      showToast(`Source reconnected: ${names.join(', ')}`, 'info', 5000);
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
      btn.title = deviceCount === 1 ? 'Device Connection (H)' : 'Devices Connection (H)';
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
      btn.title = deviceCount === 1 ? 'Device Connection (H)' : 'Devices Connection (H)';
    }
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
    if (!this.autoblowSync || !this.autoblowManager?.connected) return;
    if (!this.funscriptEngine.isLoaded) return;

    // Upload the funscript if not already uploaded
    if (!this.autoblowSync.scriptReady) {
      const rawContent = this.funscriptEngine.getRawContent();
      if (!rawContent) return;
      const ok = await this.autoblowSync.uploadScript(rawContent);
      if (!ok) return;
    }

    if (!this.autoblowSync._active) {
      console.log('[Autoblow] Starting sync');
      this.autoblowSync.start();
    }
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
        showToast('Handy auto-connect failed — use H to connect manually', 'warn');
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
  async _uploadAndStartSync() {
    if (!this.handyManager?.connected) {
      console.log('[Handy] Not connected, skipping script upload');
      return;
    }

    const rawContent = this.funscriptEngine.getRawContent();
    if (!rawContent) {
      console.log('[Handy] No raw funscript content available');
      return;
    }

    console.log('[Handy] Uploading funscript to cloud...');
    const setupOk = await this.handyManager.uploadAndSetScript(rawContent);

    if (setupOk) {
      // Store cloud URL for potential re-setup
      this._scriptCloudUrl = this.handyManager._lastCloudUrl || null;
      this.syncEngine._scriptReady = true;

      // If video was waiting for script upload, start playback now
      if (this._waitingForScript) {
        this._waitingForScript = false;
        if (this._scriptLoadingTimeout) {
          clearTimeout(this._scriptLoadingTimeout);
          this._scriptLoadingTimeout = null;
        }
        this._hideScriptLoadingOverlay();
        this.videoPlayer.video.play().catch(() => {});
      }

      this.syncEngine.start();
      console.log('[Handy] Sync engine started — HSSP active');
    } else {
      // Upload failed — play anyway so the user isn't stuck
      if (this._waitingForScript) {
        this._waitingForScript = false;
        if (this._scriptLoadingTimeout) {
          clearTimeout(this._scriptLoadingTimeout);
          this._scriptLoadingTimeout = null;
        }
        this._hideScriptLoadingOverlay();
        this.videoPlayer.video.play().catch(() => {});
      }
      showToast('Failed to upload script to Handy', 'error');
    }
  }

  loadVideo(file, { skipViewSwitch = false, autoPlay = true } = {}) {
    console.log('Loading video:', file.name);

    // Clean up previous video
    if (this._currentVideoUrl) {
      URL.revokeObjectURL(this._currentVideoUrl);
      this._currentVideoUrl = null;
    }
    this.syncEngine?.stop();
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
    this._waitingForScript = false;
    if (this._scriptLoadingTimeout) {
      clearTimeout(this._scriptLoadingTimeout);
      this._scriptLoadingTimeout = null;
    }
    this._hideScriptLoadingOverlay();
    this.progressBar.clearHeatmap();
    this.progressBar.setGaps(null);
    const fsBadge = document.getElementById('funscript-badge');
    if (fsBadge) {
      fsBadge.hidden = true;
      fsBadge.innerHTML = '';
    }
    const subBadge = document.getElementById('subtitle-badge');
    if (subBadge) {
      subBadge.hidden = true;
    }
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

    // Set video source — use file:// URL for local paths, blob URL for File objects
    let videoUrl;
    if (file._isPathBased && file.path) {
      // pathToFileURL percent-encodes `#`, `?`, `%`, spaces etc. — without
      // this, filenames like "Your Step-sister #1.mp4" truncate at the
      // `#` and load fails with "format not supported".
      videoUrl = pathToFileURL(file.path);
    } else {
      videoUrl = URL.createObjectURL(file);
      this._currentVideoUrl = videoUrl;
    }

    this._currentVideoName = file.name;
    this._currentVideoPath = file.path || null;
    this.videoPlayer.loadSource(videoUrl, file.name);
    this.progressBar.setVideoSource(videoUrl);
    this._updateCategoryDots();

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
        showToast('Source disconnected — file no longer available', 'error', 5000);
        // Invalidate library cache so re-scan catches the change
        if (this.library) this.library._lastScanKey = null;
      } else {
        const msgs = {
          1: 'Video loading aborted',
          2: 'Network error loading video',
          3: 'Video decoding failed — unsupported codec?',
          4: 'Video format not supported',
        };
        showToast(msgs[code] || 'Failed to load video', 'error');
      }
    });

    // Set title
    const titleEl = document.getElementById('video-title');
    titleEl.textContent = file.name.replace(/\.[^/.]+$/, '');

    // Track recent file
    if (file.path) {
      this.settings.addRecentFile(file.path);
    }

    // Auto-pair: check pending funscripts for matching name
    const match = this._pendingFunscripts.find((f) => isAutoMatch(file.name, f.name));
    if (match) {
      this._pendingFunscripts = this._pendingFunscripts.filter((f) => f !== match);
      this.loadFunscript(match);
    } else if (!this.funscriptEngine.isLoaded) {
      // No funscript found locally — try auto-matching on EroScripts (background, non-blocking)
      this._autoMatchEroScripts(file.name);
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
      const { results } = await window.funsync.eroscriptsSearch(query);

      if (results && results.length > 0 && !this.funscriptEngine.isLoaded) {
        const top = results[0];
        const container = document.createElement('div');
        container.className = 'update-toast';

        const text = document.createElement('span');
        text.textContent = `Script found: ${top.title}`;
        container.appendChild(text);

        const btn = document.createElement('button');
        btn.className = 'update-toast__btn';
        btn.textContent = 'Get Script';
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
      const info = file.textContent != null
        ? await this.funscriptEngine.loadContent(file.textContent, file.name)
        : await this.funscriptEngine.loadFile(file);
      console.log('Funscript loaded:', info);

      this._showFunscriptBadge(info);

      // Render heatmap if video duration is known
      if (isFinite(this.videoPlayer.duration) && this.videoPlayer.duration > 0) {
        this.progressBar.renderHeatmap(
          this.funscriptEngine.getActions(),
          this.videoPlayer.duration,
        );
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
      showToast('Failed to load funscript: ' + err.message, 'error');
    }
  }

  _showFunscriptBadge(info) {
    const badge = document.getElementById('funscript-badge');
    if (!badge || !info) return;

    let title = `${info.filename} — ${info.actionCount} actions, ${info.durationFormatted}`;

    if (this._currentCustomRoutes && this._currentCustomRoutes.length > 0) {
      const knownDevices = this.settings.get('knownDevices') || [];
      const lines = [title, '— Custom Routing —'];
      for (const route of this._currentCustomRoutes) {
        const scriptName = route.scriptName || route.scriptPath?.split(/[\\/]/).pop() || '(none)';
        const device = knownDevices.find(d => d.id === route.deviceId);
        const deviceLabel = device ? device.label : (route.deviceId || 'Unassigned');
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

    // Hide all view elements
    for (const vid of ['library', 'player', 'playlists', 'categories']) {
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
    if (leavingEl) leavingEl.hidden = true;
    if (targetEl) targetEl.hidden = false;

    this._onEnterView(target);
  }

  /** Hook called when entering a view. */
  _onEnterView(viewId) {
    // Show/hide nav bar (hidden during player)
    if (viewId === 'player') {
      this.navBar.hide();
    } else {
      this.navBar.show();
      this.navBar.setActive(viewId);
    }

    if (viewId === 'library') {
      // Recheck source availability before showing (drive may have been disconnected)
      this._refreshCollectionsUI().then(() => {
        this.library.show(this._getViewEl('library'));
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
      // Pause video first — stops playback immediately in the browser
      this.videoPlayer.video.pause();

      // Stop all sync engines (prevents any new commands from being queued)
      if (this.syncEngine) this.syncEngine.stop();
      if (this.buttplugSync?._active) this.buttplugSync.stop();
      if (this.tcodeSync?._active) this.tcodeSync.stop();
      if (this.autoblowSync?._active) this.autoblowSync.stop();

      // Stop all devices (network calls — async but fire-and-forget)
      if (this.handyManager?.connected) this.handyManager.hsspStop();
      if (this.buttplugManager?.connected) this.buttplugManager.stopAll();
      if (this.tcodeManager?.connected) this.tcodeManager.stop();
      if (this.autoblowManager?.connected) this.autoblowManager.syncStop();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    } else if (viewId === 'library') {
      this.library.hide();
    } else if (viewId === 'playlists') {
      this.playlists.hide();
    } else if (viewId === 'categories') {
      this.categories.hide();
    }
  }

  // --- View Actions ---

  _showLibrary() {
    this._navigateTo('library');
  }

  async _playFromLibrary(videoData, funscriptData, subtitleData, variants) {
    this._navigateTo('player');
    this._playQueue = [];
    this._playQueueIndex = -1;
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

    this.loadVideo(videoData, { skipViewSwitch: true, autoPlay: false });

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
        showToast(`Multi-axis: ${suffix} script failed to load (${err.message})`, 'warn', 5000);
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
      const scripts = [{ label: 'Main (L0)', path: this.scriptEditor?._funscriptPath || '' }];
      for (const [suffix, axisPath] of axisEntries) {
        if (!axisPath) continue;
        const SUFFIX_LABELS = { surge: 'Surge', sway: 'Sway', twist: 'Twist', roll: 'Roll', pitch: 'Pitch', vib: 'Vibe', lube: 'Lube', pump: 'Pump', suction: 'Suction', valve: 'Valve' };
        scripts.push({ label: SUFFIX_LABELS[suffix] || suffix, path: axisPath });
      }
      if (scripts.length > 1) this.scriptEditor.setAvailableScripts(scripts);
    }
  }

  _formatActionsDuration(actions) {
    if (!actions || actions.length === 0) return '0:00';
    const totalMs = actions[actions.length - 1].at - actions[0].at;
    const totalSec = Math.floor(totalMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
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
    this.gapSkipEngine.onShowOverlay = (gap, countdown, gapType) => {
      overlay.hidden = false;
      const label = gapType === 'leading' ? 'Skip to action'
        : gapType === 'trailing' ? 'Skip to end'
        : 'Skip to next action';

      if (countdown !== null) {
        btnSkip.textContent = `${label} in ${countdown}...`;
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
      const gapType = this.gapSkipEngine._currentGapType || 'mid';
      const label = gapType === 'leading' ? 'Skip to action'
        : gapType === 'trailing' ? 'Skip to end'
        : 'Skip to next action';
      btnSkip.textContent = remaining > 0 ? `${label} in ${remaining}...` : 'Skipping...';
    };

    this.gapSkipEngine.onSkipped = (skippedMs) => {
      const sec = Math.round(Math.abs(skippedMs) / 1000);
      const dir = skippedMs > 0 ? 'forward' : 'back';
      const container = document.createElement('div');
      container.className = 'update-toast';
      const text = document.createElement('span');
      text.textContent = `Skipped ${sec}s ${dir}`;
      container.appendChild(text);
      const undoBtn = document.createElement('button');
      undoBtn.className = 'update-toast__btn';
      undoBtn.textContent = 'Undo';
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

  // --- Library Collections ---

  async _refreshCollectionsUI() {
    const collections = this.settings.get('library.collections') || [];
    let activeCollectionId = this.settings.get('library.activeCollectionId') || null;
    let sources = this.settings.get('library.sources') || [];

    // Auto-migrate: if legacy directory exists but not in sources, add it
    const legacyDir = this.settings.get('library.directory');
    if (legacyDir && !sources.some(s => s.path === legacyDir)) {
      const dirName = legacyDir.split(/[\\/]/).pop() || 'Library';
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

    const name = await Modal.prompt('Name this source', 'Source name', dirPath.split(/[\\/]/).pop());
    if (!name) return;

    const sources = this.settings.get('library.sources') || [];
    // Don't add duplicates
    if (sources.some(s => s.path === dirPath)) {
      showToast('This folder is already a source', 'warn');
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
        sourceLabel.textContent = 'Source:';
        sourceLabel.style.marginRight = '6px';

        const sourceSelect = document.createElement('select');
        sourceSelect.className = 'library__sort-select';
        sourceSelect.style.flex = '1';

        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = 'All Sources';
        sourceSelect.appendChild(allOpt);

        for (const src of sources) {
          const opt = document.createElement('option');
          opt.value = src.id;
          const isOffline = unavailable.has(src.path);
          opt.textContent = isOffline ? `${src.name} (disconnected)` : src.name;
          opt.disabled = isOffline;
          sourceSelect.appendChild(opt);
        }

        const browseOpt = document.createElement('option');
        browseOpt.value = '__browse__';
        browseOpt.textContent = '+ Browse for folder...';
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
        syncText.textContent = 'Sync with source — new videos added to the folder will automatically join this collection';
        syncLabel.appendChild(syncCheckbox);
        syncLabel.appendChild(syncText);
        syncRow.appendChild(syncLabel);
        body.appendChild(syncRow);

        // Name input
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'modal-input';
        nameInput.placeholder = 'Collection name...';
        nameInput.value = existingName || '';
        nameInput.style.marginBottom = '8px';
        body.appendChild(nameInput);

        // Search + count
        const toolbar = document.createElement('div');
        toolbar.className = 'library__collection-toolbar';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'library__search-input';
        searchInput.placeholder = 'Search...';
        searchInput.style.flex = '1';

        const countLabel = document.createElement('span');
        countLabel.className = 'library__collection-count';
        countLabel.textContent = `${existingPaths.size} selected`;

        const selectAllBtn = document.createElement('button');
        selectAllBtn.className = 'library__collection-select-all';
        selectAllBtn.textContent = 'Select All';
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
          countLabel.textContent = `${selected.size} selected`;
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
              countLabel.textContent = `${selected.size} selected`;
              // Sync Select All button text
              const allVis = filtered.every(v => selected.has(v.path));
              selectAllBtn.textContent = allVis ? 'Deselect All' : 'Select All';
            });

            grid.appendChild(card);
          }

          if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'library__collection-count';
            empty.style.padding = '20px';
            empty.style.textAlign = 'center';
            empty.textContent = currentVideos.length === 0 ? 'No videos in this source' : 'No matches';
            grid.appendChild(empty);
          }

          // Sync Select All button text
          const allVisible = filtered.length > 0 && filtered.every(v => selected.has(v.path));
          selectAllBtn.textContent = allVisible ? 'Deselect All' : 'Select All';
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
                countLabel.textContent = `${selected.size} selected`;
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
            countLabel.textContent = `${selected.size} selected`;
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
              countLabel.textContent = `${selected.size} selected`;
              renderGrid();
            }, 100);
          }
        });

        // Save/Create button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'library__assoc-save-btn';
        saveBtn.textContent = existingName ? 'Save' : 'Create';
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

    const confirmed = await Modal.confirm('Delete Library', `Delete "${col.name}"? Your videos won't be affected.`);
    if (!confirmed) return;

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
        baseVariants.push({ label: 'Default', path: currentPath || '', name: currentName });
      }
    }

    // Append manually added variants from settings (with filename fallback for drive letter changes)
    const manualVariants = this.settings.get('library.manualVariants') || {};
    let manual = videoPath && manualVariants[videoPath] ? manualVariants[videoPath] : [];
    if (manual.length === 0 && videoPath) {
      const videoName = videoPath.split(/[\\/]/).pop().toLowerCase();
      for (const [oldPath, oldVariants] of Object.entries(manualVariants)) {
        if (oldPath === videoPath) continue;
        if (oldPath.split(/[\\/]/).pop().toLowerCase() === videoName && oldVariants.length > 0) {
          manual = oldVariants;
          manualVariants[videoPath] = manual;
          delete manualVariants[oldPath];
          this.settings.set('library.manualVariants', manualVariants);
          break;
        }
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
      btn.textContent = active ? active.label : 'Default';
    } else {
      selector.hidden = true;
    }

    this._allVariantsWithManual = allVariants;
  }

  _showVariantDropdown() {
    const dropdown = document.getElementById('variant-dropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';
    dropdown.hidden = false;

    const variants = this._allVariantsWithManual || [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const item = document.createElement('button');
      item.className = 'variant-selector__item';
      if (i === this._activeVariantIndex) item.classList.add('variant-selector__item--active');

      const label = document.createElement('span');
      label.className = 'variant-selector__item-label';
      label.textContent = v.label;
      item.appendChild(label);

      item.addEventListener('click', () => {
        this._switchVariant(i);
        dropdown.hidden = true;
      });
      dropdown.appendChild(item);
    }

    // Add variation button
    const addBtn = document.createElement('button');
    addBtn.className = 'variant-selector__add';
    addBtn.textContent = '+ Add variation...';
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
      manageBtn.textContent = 'Manage variations...';
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
      title: 'Name This Variation',
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
          sugLabel.textContent = 'Suggestions:';
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
        customLabel.textContent = 'Custom name:';
        body.appendChild(customLabel);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
        input.placeholder = 'Enter a name...';
        input.style.marginBottom = '12px';
        body.appendChild(input);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'library__assoc-save-btn';
        confirmBtn.style.display = 'block';
        confirmBtn.style.width = '66%';
        confirmBtn.style.margin = '0 auto';
        confirmBtn.textContent = 'OK';
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

    const scanResult = await window.funsync.scanDirectory(dirPath);
    const allScripts = scanResult?.allFunscripts || [];

    if (allScripts.length === 0) {
      const result = await window.funsync.selectFunscript();
      if (result) await this._addManualVariant(result.path, result.name);
      return;
    }

    const videoName = this._currentVideoName || '';
    const ranked = rankFunscriptMatches(videoName, allScripts, 0);

    const chosen = await Modal.open({
      title: 'Add Script Variation',
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
        browseRow.textContent = 'Browse...';
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
      title: 'Manage Variations',
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
            empty.textContent = 'No manual variations';
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
            renameBtn.title = 'Rename';
            renameBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const newName = await Modal.prompt('Rename Variation', 'Name', v.label);
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
            deleteBtn.title = 'Remove';
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
        doneBtn.textContent = 'Done';
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

      // Update heatmap
      if (isFinite(this.videoPlayer.duration) && this.videoPlayer.duration > 0) {
        this.progressBar.renderHeatmap(
          this.funscriptEngine.getActions(),
          this.videoPlayer.duration,
        );
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

      // Re-upload to Handy (stop first so start() doesn't early-return)
      if (this.handyManager?.connected) {
        if (this.syncEngine) this.syncEngine.stop();
        showToast('Switching script...', 'info', 2000);
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

      showToast(`Now playing: ${variant.label}`, 'info', 2000);
    } catch (err) {
      console.warn('[Variants] Switch failed:', err.message);
      showToast('Failed to switch script variant', 'error');
    }
  }

  _cycleVariant(direction) {
    const variants = this._allVariantsWithManual;
    if (!variants || variants.length < 2) return;
    const next = (this._activeVariantIndex + direction + variants.length) % variants.length;
    this._switchVariant(next);
  }

  /** Play a list of videos sequentially (Play All). */
  _playAll(videoList) {
    if (!videoList || videoList.length === 0) return;
    this._playQueue = videoList;
    this._playQueueIndex = 0;
    this._navigateTo('player');
    this._playQueueItem(0);
  }

  _playQueueItem(index) {
    if (index >= this._playQueue.length) return;
    const item = this._playQueue[index];
    this._playQueueIndex = index;

    // If we have a funscript AND Handy is connected, gate autoplay until script is uploaded
    if (item.funscriptPath && this.handyManager?.connected) {
      this._waitingForScript = true;
    }

    const fileData = { name: item.name, path: item.path, _isPathBased: true };
    this.loadVideo(fileData, { skipViewSwitch: true });

    if (item.funscriptPath) {
      window.funsync.readFunscript(item.funscriptPath).then((content) => {
        if (content) {
          const fsName = item.funscriptPath.split(/[\\/]/).pop();
          this.loadFunscript({ name: fsName, textContent: content });
        } else {
          // Silent skip would leave the user wondering why the next
          // video plays with no device sync — surface it.
          const fsName = item.funscriptPath.split(/[\\/]/).pop();
          showToast(`Queue item ${item.name}: script ${fsName} couldn't be read — playing without sync`, 'warn', 5000);
        }
      }).catch((err) => {
        showToast(`Queue item ${item.name}: script read failed (${err.message}) — playing without sync`, 'warn', 5000);
      });
    }

    this._updateQueueUI();

    // Wire auto-advance on ended (remove previous listener if any)
    if (this._queueEndedListener) {
      this.videoPlayer.video.removeEventListener('ended', this._queueEndedListener);
    }
    this._queueEndedListener = () => {
      this.videoPlayer.video.removeEventListener('ended', this._queueEndedListener);
      this._queueEndedListener = null;
      if (this._playQueueIndex + 1 < this._playQueue.length) {
        this._playQueueItem(this._playQueueIndex + 1);
      }
    };
    this.videoPlayer.video.addEventListener('ended', this._queueEndedListener);
  }

  _playPrev() {
    if (this._playQueueIndex > 0) {
      this._playQueueItem(this._playQueueIndex - 1);
    }
  }

  _playNext() {
    if (this._playQueueIndex + 1 < this._playQueue.length) {
      this._playQueueItem(this._playQueueIndex + 1);
    }
  }

  _updateQueueUI() {
    const hasQueue = this._playQueue.length > 1;
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const indicator = document.getElementById('queue-indicator');
    if (btnPrev) {
      btnPrev.hidden = !hasQueue;
      btnPrev.disabled = this._playQueueIndex <= 0;
    }
    if (btnNext) {
      btnNext.hidden = !hasQueue;
      btnNext.disabled = this._playQueueIndex >= this._playQueue.length - 1;
    }
    if (indicator) {
      indicator.hidden = !hasQueue;
      if (hasQueue) {
        indicator.textContent = `${this._playQueueIndex + 1} / ${this._playQueue.length}`;
      }
    }
  }

  async _quickAddToPlaylist() {
    if (!this._currentVideoPath) {
      showToast('Cannot add — video has no file path', 'warn');
      return;
    }
    const playlists = this.settings.getPlaylists();
    if (playlists.length === 0) {
      showToast('No playlists yet — create one from the Playlists view', 'info');
      return;
    }
    const items = playlists.map((p) => ({
      id: p.id,
      label: p.name,
      subtitle: `${p.videoPaths.length} video${p.videoPaths.length !== 1 ? 's' : ''}`,
    }));
    const selectedId = await Modal.selectFromList('Add to Playlist', items);
    if (selectedId) {
      this.settings.addVideoToPlaylist(selectedId, this._currentVideoPath);
      const pl = this.settings.getPlaylist(selectedId);
      showToast(`Added to "${pl.name}"`, 'info');
    }
  }

  _showScriptLoadingOverlay() {
    const overlay = document.getElementById('script-loading-overlay');
    if (overlay) overlay.hidden = false;

    // Fallback timeout — if upload takes too long, play anyway
    this._scriptLoadingTimeout = setTimeout(() => {
      if (this._waitingForScript) {
        console.warn('[Handy] Script upload timeout — playing without sync');
        this._waitingForScript = false;
        this._hideScriptLoadingOverlay();
        this.videoPlayer.video.play().catch(() => {});
        // Surface the failure — without this, the user sees the video play
        // but the Handy stays silent and they have no idea why.
        showToast('Handy script upload timed out — video is playing but the Handy won\'t be in sync. Check your connection and try reloading the video.', 'warn', 8000);
      }
    }, 8000);
  }

  _hideScriptLoadingOverlay() {
    const overlay = document.getElementById('script-loading-overlay');
    if (overlay) overlay.hidden = true;
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
    text.textContent = `Update v${data.version} available`;
    container.appendChild(text);

    const btn = document.createElement('button');
    btn.className = 'update-toast__btn';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      window.funsync.updaterDownload();
      btn.disabled = true;
      btn.textContent = 'Downloading...';
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
    text.textContent = `v${data.version} ready — restart to update`;
    container.appendChild(text);

    const btn = document.createElement('button');
    btn.className = 'update-toast__btn';
    btn.textContent = 'Restart Now';
    btn.addEventListener('click', () => {
      window.funsync.updaterInstall();
    });
    container.appendChild(btn);

    showToast(container, 'info', 0); // Persistent until dismissed
  }
}

// Boot
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
