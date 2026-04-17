// FunSync Player — App Entry Point

import { VideoPlayer } from './video-player.js';
import { ProgressBar } from './progress-bar.js';
import { FunscriptEngine, isAutoMatch } from './funscript-engine.js';
import { HandyManager } from './handy-manager.js';
import { SyncEngine } from './sync-engine.js';
import { ButtplugManager } from './buttplug-manager.js';
import { ButtplugSync } from './buttplug-sync.js';
import { ConnectionPanel } from '../components/connection-panel.js';
import { DragDrop } from './drag-drop.js';
import { KeyboardHandler } from './keyboard.js';
import { dataService } from './data-service.js';
import { showToast } from './toast.js';
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

class App {
  constructor() {
    this.videoPlayer = null;
    this.progressBar = null;
    this.funscriptEngine = null;
    this.handyManager = null;
    this.syncEngine = null;
    this.buttplugManager = null;
    this.buttplugSync = null;
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
    // Initialize data service (loads data from main process, handles migration)
    await dataService.init();

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
      this.backendPort = await window.funsync.getBackendPort();
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
    this.navBar = new NavBar({
      onNavigate: (viewId) => this._navigateTo(viewId),
      onHandyClick: () => { if (this.connectionPanel) this.connectionPanel.toggle(); },
      onEroScriptsClick: () => { if (this.eroscriptsPanel) this.eroscriptsPanel.toggle(); },
    });
    this.navBar.init(document.getElementById('app'));
    this.navBar.setActive('library');

    // Library
    this.library = new Library({
      onPlayVideo: (video, funscript, subtitle, variants) => this._playFromLibrary(video, funscript, subtitle, variants),
      onBack: () => this._navigateBack(),
      settings: this.settings,
    });

    // Playlists
    this.playlists = new Playlists({
      settings: this.settings,
      onPlayVideo: (videoData, funscriptData, subtitleData, variants) => this._playFromLibrary(videoData, funscriptData, subtitleData, variants),
      onPlayAll: (videoList) => this._playAll(videoList),
    });

    // Categories
    this.categories = new Categories({
      settings: this.settings,
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

    // "Open File" button in player controls
    const btnOpen = document.getElementById('btn-open');
    if (btnOpen) {
      btnOpen.addEventListener('click', () => this.dragDrop._openNativeDialog());
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
      await this.handyManager.init();

      this.syncEngine = new SyncEngine({
        videoPlayer: this.videoPlayer,
        handyManager: this.handyManager,
        funscriptEngine: this.funscriptEngine,
      });

      // Initialize Buttplug.io integration (non-critical — works alongside Handy)
      try {
        this.buttplugManager = new ButtplugManager();
        await this.buttplugManager.init();

        this.buttplugSync = new ButtplugSync({
          videoPlayer: this.videoPlayer,
          buttplugManager: this.buttplugManager,
          funscriptEngine: this.funscriptEngine,
        });

      } catch (err) {
        console.warn('Buttplug.io integration unavailable:', err.message);
      }

      this.connectionPanel = new ConnectionPanel({
        handyManager: this.handyManager,
        buttplugManager: this.buttplugManager,
        buttplugSync: this.buttplugSync,
        settings: this.settings,
      });

      // Wire smoothing settings change from connection panel
      this.connectionPanel.onSmoothingChanged = (mode) => {
        if (this.buttplugSync) this.buttplugSync.setInterpolationMode(mode);
      };
      this.connectionPanel.onSpeedLimitChanged = (maxSpeed) => {
        if (this.buttplugSync) this.buttplugSync.setSpeedLimit(maxSpeed);
      };

      // Load saved smoothing settings into buttplug sync
      if (this.buttplugSync) {
        const savedSmoothing = this.settings.get('player.smoothing') || 'linear';
        const savedSpeedLimit = this.settings.get('player.speedLimit') || 0;
        this.buttplugSync.setInterpolationMode(savedSmoothing);
        this.buttplugSync.setSpeedLimit(savedSpeedLimit);
      }

      // Wire gap skip settings change from connection panel
      this.connectionPanel.onGapSkipChanged = (mode, threshold) => {
        if (this.gapSkipEngine) {
          this.gapSkipEngine.setSettings(mode, threshold);
          if (this.funscriptEngine.isLoaded) {
            this._startGapSkip();
          }
        }
      };

      // ConnectionPanel sets handyManager.onConnect/onDisconnect for its own UI updates.
      // Wrap them so we also get notified (to upload pending scripts + update indicators).
      const panelOnConnect = this.handyManager.onConnect;
      this.handyManager.onConnect = () => {
        if (panelOnConnect) panelOnConnect();
        this._onHandyConnected();
      };

      const panelOnDisconnect = this.handyManager.onDisconnect;
      this.handyManager.onDisconnect = () => {
        if (panelOnDisconnect) panelOnDisconnect();
        if (this.syncEngine) this.syncEngine.stop();
        this._updateHandyIndicators('disconnected');
        this._updateDeviceIndicators();
      };

      // Buttplug.io callback wiring (same pattern as Handy — wrap panel callbacks)
      if (this.buttplugManager) {
        const panelBpConnect = this.buttplugManager.onConnect;
        this.buttplugManager.onConnect = () => {
          if (panelBpConnect) panelBpConnect();
          this._updateDeviceIndicators();
          this._tryStartButtplugSync();
        };

        const panelBpDisconnect = this.buttplugManager.onDisconnect;
        this.buttplugManager.onDisconnect = () => {
          if (panelBpDisconnect) panelBpDisconnect();
          if (this.buttplugSync) this.buttplugSync.stop();
          this._updateDeviceIndicators();
        };

        const panelBpDeviceAdded = this.buttplugManager.onDeviceAdded;
        this.buttplugManager.onDeviceAdded = (dev) => {
          if (panelBpDeviceAdded) panelBpDeviceAdded(dev);
          this._updateDeviceIndicators();
          this._tryStartButtplugSync();
          if (this.connectionPanel) this.connectionPanel.updateVibControlState();
        };

        const panelBpDeviceRemoved = this.buttplugManager.onDeviceRemoved;
        this.buttplugManager.onDeviceRemoved = (dev) => {
          if (panelBpDeviceRemoved) panelBpDeviceRemoved(dev);
          this._updateDeviceIndicators();
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
    } catch (err) {
      console.warn('Handy integration unavailable:', err.message);
      showToast('Handy integration unavailable — playback still works', 'warn');

      // Initialize keyboard shortcuts without connection panel
      this._keyboard = new KeyboardHandler({
        videoPlayer: this.videoPlayer,
        onOpenFile: () => this.dragDrop._openNativeDialog(),
        scriptEditor: null, // Set after ScriptEditor creation below
      });
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
          }
        }).catch(() => {});
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
        if (this.syncEngine) this.syncEngine.stop();
        if (this.buttplugSync) this.buttplugSync.stop();
        if (this.handyManager?.connected) {
          this.handyManager.hsspStop();
          this.handyManager.disconnect();
        }
        if (this.buttplugManager?.connected) {
          this.buttplugManager.stopAll();
          this.buttplugManager.disconnect();
        }
      } catch (e) {
        // Fire-and-forget — app is closing
      }
    });

    // Listen for auto-update events from main process
    this._initAutoUpdater();

    // Show library as default landing page
    this._onEnterView('library');

    console.log('FunSync Player initialized');
  }

  /**
   * Called when the Handy device connects (after ConnectionPanel's handler).
   * If a funscript is already loaded, upload it to the cloud and start sync.
   */
  async _onHandyConnected() {
    console.log('[Handy] Device connected — checking for pending funscript...');
    this._updateHandyIndicators('connected');
    this._updateDeviceIndicators();

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

    // Check if any device (Handy OR Buttplug) is connected
    const buttplugConnected = this.buttplugManager?.connected;
    const anyConnected = status === 'connected' || status === 'connecting' || buttplugConnected;
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
    const buttplugConnected = this.buttplugManager?.connected;
    const anyConnected = handyConnected || buttplugConnected;
    const deviceCount = this._getConnectedDeviceCount();

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
    this._stopGapSkip();
    if (this._queueEndedListener) {
      this.videoPlayer.video.removeEventListener('ended', this._queueEndedListener);
      this._queueEndedListener = null;
    }
    if (this.buttplugSync) {
      this.buttplugSync.setVibrationActions(null);
      if (this.connectionPanel) this.connectionPanel.updateVibControlState();
    }
    this._currentMultiAxis = null;
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

    // Hide editor, clear funscript path, and show editor toggle button
    if (this.scriptEditor) {
      if (this.scriptEditor.isOpen) this.scriptEditor.hide();
      this.scriptEditor.setFunscriptPath(null);
    }
    document.getElementById('btn-editor').hidden = false;

    // Switch to player view (unless caller already handled it)
    if (!skipViewSwitch) {
      this._navigateTo('player');
    }

    // Set video source — use file:// URL for local paths, blob URL for File objects
    let videoUrl;
    if (file._isPathBased && file.path) {
      // Convert Windows path to file:// URL
      const normalizedPath = file.path.replace(/\\/g, '/');
      videoUrl = `file:///${normalizedPath}`;
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

    // Handle video load errors
    this.videoPlayer.video.addEventListener('error', () => {
      const code = this.videoPlayer.video.error?.code;
      const msgs = {
        1: 'Video loading aborted',
        2: 'Network error loading video',
        3: 'Video decoding failed — unsupported codec?',
        4: 'Video format not supported',
      };
      showToast(msgs[code] || 'Failed to load video', 'error');
    }, { once: true });

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
            this.eroscriptsPanel.setSearchQuery(query);
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
      await this._uploadAndStartSync();

      // If Buttplug is connected, start sync
      this._tryStartButtplugSync();

      // Start gap skip monitoring
      this._startGapSkip();
    } catch (err) {
      console.error('Failed to load funscript:', err.message);
      showToast('Failed to load funscript: ' + err.message, 'error');
    }
  }

  _showFunscriptBadge(info) {
    const badge = document.getElementById('funscript-badge');
    if (!badge || !info) return;

    let title = `${info.filename} — ${info.actionCount} actions, ${info.durationFormatted}`;

    if (this._currentMultiAxis && this._currentMultiAxis.axes) {
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
      this.library.show(this._getViewEl('library'));
    } else if (viewId === 'playlists') {
      this.playlists.show(this._getViewEl('playlists'));
    } else if (viewId === 'categories') {
      this.categories.show(this._getViewEl('categories'));
    }
  }

  /** Hook called when leaving a view. */
  _onLeaveView(viewId) {
    if (viewId === 'player') {
      this.videoPlayer.video.pause();
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

  _playFromLibrary(videoData, funscriptData, subtitleData, variants) {
    this._navigateTo('player');
    this._playQueue = [];
    this._playQueueIndex = -1;
    this._updateQueueUI();

    this._currentMultiAxis = null;
    this._currentVariants = variants || [];
    this._activeVariantIndex = 0;
    this.loadVideo(videoData, { skipViewSwitch: true, autoPlay: false });
    this._updateVariantSelector();
    if (funscriptData) {
      if (funscriptData._multiAxis) {
        this._currentMultiAxis = funscriptData._multiAxis;
      }
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
    if (!config.axes?.vib) return;

    const vibPath = config.axes.vib;

    try {
      const content = await window.funsync.readFunscript(vibPath);
      if (!content) return;
      const parsed = JSON.parse(content);
      const actions = parsed?.actions;
      if (!actions || actions.length < 2) return;

      // If no main funscript was loaded, use the vib script for heatmap + badge
      if (!this.funscriptEngine.isLoaded) {
        const vibName = vibPath.split(/[\\/]/).pop();
        await this.funscriptEngine.loadContent(content, vibName);
        this._showFunscriptBadge({
          filename: vibName,
          actionCount: actions.length,
          durationFormatted: this._formatActionsDuration(actions),
        });

        if (isFinite(this.videoPlayer.duration) && this.videoPlayer.duration > 0) {
          this.progressBar.renderHeatmap(actions, this.videoPlayer.duration);
        }
      }

      // Route to Buttplug.io vibrate devices if enabled
      if (config.buttplugVib && this.buttplugSync) {
        this.buttplugSync.setVibrationActions(actions);
        console.log(`[MultiAxis] Loaded vibration script: ${actions.length} actions`);
        if (this.connectionPanel) this.connectionPanel.updateVibControlState();

        // Start sync if not already active (vib-only case — _tryStartButtplugSync may have skipped it)
        if (this.buttplugManager?.connected && !this.buttplugSync._active) {
          const devices = this.buttplugManager.devices;
          if (devices.length > 0) {
            if (this.connectionPanel) this.connectionPanel._loadButtplugDeviceSettings();
            this.buttplugSync.start();
          }
        }
      }
    } catch (err) {
      console.warn('[MultiAxis] Failed to load vib script:', err.message);
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

    // Append manually added variants from settings
    const manualVariants = this.settings.get('library.manualVariants') || {};
    const manual = videoPath && manualVariants[videoPath] ? manualVariants[videoPath] : [];
    const allVariants = [...baseVariants, ...manual];

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

    // Close on outside click
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && !document.getElementById('variant-btn')?.contains(e.target)) {
        dropdown.hidden = true;
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  _addManualVariant(fsPath, fsName) {
    const videoPath = this._currentVideoPath;
    if (!videoPath) return;

    // Derive label from filename
    const nameNoExt = fsName.replace(/\.funscript$/i, '');
    const parenMatch = nameNoExt.match(/\(([^)]+)\)/);
    const label = parenMatch ? parenMatch[1].trim() : nameNoExt;

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
    // Get all funscripts from current library directory
    const dirPath = this.settings.get('library.directory');
    if (!dirPath) {
      // No library — fall back to file dialog
      const result = await window.funsync.selectFunscript();
      if (result) this._addManualVariant(result.path, result.name);
      return;
    }

    const scanResult = await window.funsync.scanDirectory(dirPath);
    const allScripts = scanResult?.allFunscripts || [];

    if (allScripts.length === 0) {
      const result = await window.funsync.selectFunscript();
      if (result) this._addManualVariant(result.path, result.name);
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
    this._addManualVariant(chosen.path, chosen.name);
  }

  async _switchVariant(index) {
    const variants = this._allVariantsWithManual || [];
    if (index < 0 || index >= variants.length) return;
    if (index === this._activeVariantIndex) return;

    const variant = variants[index];
    this._activeVariantIndex = index;

    try {
      const content = await window.funsync.readFunscript(variant.path);
      if (!content) return;

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

      // Reload buttplug sync
      if (this.buttplugSync?._active) this.buttplugSync.reloadActions();

      // Re-upload to Handy
      if (this.handyManager?.connected) {
        showToast('Switching script...', 'info', 2000);
        await this._uploadAndStartSync();
      }

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
        }
      }).catch(() => {});
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
document.addEventListener('DOMContentLoaded', () => {
  app.init().catch((err) => {
    console.error('FATAL: App init failed:', err);
  });
});
