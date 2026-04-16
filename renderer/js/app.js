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
import { Playlists } from '../components/playlists.js';
import { Categories } from '../components/categories.js';
import { ScriptEditor } from '../components/script-editor.js';
import { DeviceSimulator } from '../components/device-simulator.js';
import {
  createIcons, icon, Play, Pause, Volume2, VolumeX, FolderOpen, Bluetooth,
  Maximize, Minimize, ArrowLeft, Plus, PictureInPicture2, SkipBack, SkipForward,
  Pencil, FileCheck,
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
        Pencil,
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
    });
    this.navBar.init(document.getElementById('app'));
    this.navBar.setActive('library');

    // Library
    this.library = new Library({
      onPlayVideo: (video, funscript) => this._playFromLibrary(video, funscript),
      onBack: () => this._navigateBack(),
      settings: this.settings,
    });

    // Playlists
    this.playlists = new Playlists({
      settings: this.settings,
      onPlayVideo: (videoData, funscriptData) => this._playFromLibrary(videoData, funscriptData),
      onPlayAll: (videoList) => this._playAll(videoList),
    });

    // Categories
    this.categories = new Categories({
      settings: this.settings,
      onPlayVideo: (videoData, funscriptData) => this._playFromLibrary(videoData, funscriptData),
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
        this._updateHandyIndicators('disconnected');
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

    // Wire script editor + device simulator into keyboard handler
    if (this._keyboard) {
      this._keyboard.scriptEditor = this.scriptEditor;
      this._keyboard.deviceSimulator = this.deviceSimulator;
    }

    // Editor toggle button
    const btnEditor = document.getElementById('btn-editor');
    if (btnEditor) {
      btnEditor.addEventListener('click', () => this.scriptEditor.toggle());
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

    // Nav bar LED + text
    if (this.navBar) {
      this.navBar.setHandyStatus(status, deviceCount);
    }

    // Player control button LED
    const led = document.getElementById('handy-led');
    if (led) {
      led.className = 'handy-led';
      if (status === 'connected') {
        led.classList.add('handy-led--connected');
      } else if (status === 'connecting') {
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
    if (!this.funscriptEngine.isLoaded) return;

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
    this.funscriptEngine.clear();
    this._scriptCloudUrl = null;
    this._waitingForScript = false;
    if (this._scriptLoadingTimeout) {
      clearTimeout(this._scriptLoadingTimeout);
      this._scriptLoadingTimeout = null;
    }
    this._hideScriptLoadingOverlay();
    this.progressBar.clearHeatmap();
    const fsBadge = document.getElementById('funscript-badge');
    if (fsBadge) {
      fsBadge.hidden = true;
      fsBadge.innerHTML = ''; // Clear icon so it re-creates fresh
    }

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
    } catch (err) {
      console.error('Failed to load funscript:', err.message);
      showToast('Failed to load funscript: ' + err.message, 'error');
    }
  }

  _showFunscriptBadge(info) {
    const badge = document.getElementById('funscript-badge');
    if (!badge || !info) return;

    badge.title = `${info.filename} — ${info.actionCount} actions, ${info.durationFormatted}`;
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

  _playFromLibrary(videoData, funscriptData) {
    this._navigateTo('player');
    this._playQueue = [];
    this._playQueueIndex = -1;
    this._updateQueueUI();

    this.loadVideo(videoData, { skipViewSwitch: true, autoPlay: false });
    if (funscriptData) {
      this.loadFunscript(funscriptData);
    }
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

    // Wire auto-advance on ended
    const onEnded = () => {
      this.videoPlayer.video.removeEventListener('ended', onEnded);
      if (this._playQueueIndex + 1 < this._playQueue.length) {
        this._playQueueItem(this._playQueueIndex + 1);
      }
    };
    this.videoPlayer.video.addEventListener('ended', onEnded);
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
}

// Boot
const app = new App();
document.addEventListener('DOMContentLoaded', () => {
  app.init().catch((err) => {
    console.error('FATAL: App init failed:', err);
  });
});
