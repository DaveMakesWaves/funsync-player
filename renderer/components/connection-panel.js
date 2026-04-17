// ConnectionPanel — UI for connecting to Handy or Buttplug.io devices

import { icon, X, Info } from '../js/icons.js';

export class ConnectionPanel {
  constructor({ handyManager, buttplugManager, buttplugSync, settings }) {
    this.handy = handyManager;
    this.buttplug = buttplugManager || null;
    this.buttplugSync = buttplugSync || null;
    this.settings = settings;
    this._panel = null;
    this._visible = false;
    this._activeTab = 'handy'; // 'handy' | 'buttplug'

    this._createPanel();
    this._bindEvents();
    this._loadSavedSettings();
  }

  _createPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'connection-panel';
    this._panel.hidden = true;
    this._panel.setAttribute('role', 'dialog');
    this._panel.setAttribute('aria-label', 'Handy Connection');

    this._panel.innerHTML = `
      <div class="connection-panel__header">
        <div class="connection-panel__tabs">
          <button class="connection-panel__tab connection-panel__tab--active" data-tab="handy">Handy</button>
          <button class="connection-panel__tab" data-tab="buttplug">Buttplug.io</button>
          <button class="connection-panel__tab" data-tab="settings">Settings</button>
        </div>
        <button class="connection-panel__close control-btn" aria-label="Close"><i data-lucide="x"></i></button>
      </div>

      <div class="connection-panel__tab-content" id="tab-handy">

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="connection-led"></span>
        <span class="connection-panel__status-text" id="connection-status-text">Disconnected</span>
      </div>

      <div class="connection-panel__form">
        <label for="connection-key-input" class="connection-panel__label">Connection Key</label>
        <div class="connection-panel__input-row">
          <input type="text" id="connection-key-input"
                 class="connection-panel__input"
                 placeholder="Enter connection key"
                 maxlength="32"
                 aria-label="Connection key">
          <button id="btn-connect" class="connection-panel__btn">Connect</button>
        </div>
      </div>

      <div class="connection-panel__info" id="device-info-section" hidden>
        <div class="connection-panel__info-row">
          <span>Firmware</span>
          <span id="device-firmware">—</span>
        </div>
        <div class="connection-panel__info-row">
          <span>Model</span>
          <span id="device-model">—</span>
        </div>
        <div class="connection-panel__info-row">
          <span>RTD</span>
          <span id="device-rtd">—</span>
        </div>
        <div id="firmware-warning" class="connection-panel__warning" hidden>
          Firmware update available. Visit handyfeeling.com to update.
        </div>
      </div>

      <div class="connection-panel__sync" id="sync-section" hidden>
        <button id="btn-resync" class="connection-panel__btn connection-panel__btn--secondary">
          Re-sync Time
        </button>
        <span id="sync-quality" class="connection-panel__sync-quality"></span>
      </div>

      <div class="connection-panel__section" id="offset-section" hidden>
        <label class="connection-panel__section-label">Sync Offset</label>
        <div class="connection-panel__offset-row">
          <input type="range" class="connection-panel__offset-slider" id="offset-slider"
                 min="-500" max="500" step="10" value="0"
                 aria-label="Script offset in milliseconds">
          <input type="number" class="connection-panel__offset-number" id="offset-number"
                 min="-500" max="500" step="10" value="0"
                 aria-label="Script offset value">
          <span class="connection-panel__offset-unit">ms</span>
        </div>
      </div>

      <div class="connection-panel__section" id="stroke-section" hidden>
        <label class="connection-panel__section-label">Stroke Range</label>
        <div class="connection-panel__stroke-container">
          <span class="connection-panel__stroke-value" id="stroke-min-val">0</span>
          <div class="connection-panel__stroke-track-wrapper">
            <div class="connection-panel__stroke-track"></div>
            <div class="connection-panel__stroke-fill" id="stroke-fill"></div>
            <input type="range" class="connection-panel__stroke-input" id="stroke-min-slider"
                   min="0" max="100" value="0"
                   aria-label="Minimum stroke position">
            <input type="range" class="connection-panel__stroke-input" id="stroke-max-slider"
                   min="0" max="100" value="100"
                   aria-label="Maximum stroke position">
          </div>
          <span class="connection-panel__stroke-value" id="stroke-max-val">100</span>
        </div>
        <button id="btn-reset-stroke" class="connection-panel__btn connection-panel__btn--reset">
          Reset Stroke
        </button>
      </div>

      </div><!-- end tab-handy -->

      <div class="connection-panel__tab-content" id="tab-buttplug" hidden>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="bp-connection-led"></span>
        <span class="connection-panel__status-text" id="bp-connection-status-text">Disconnected</span>
      </div>

      <div class="connection-panel__form">
        <label for="bp-port-input" class="connection-panel__label">Intiface Port</label>
        <div class="connection-panel__input-row">
          <input type="number" id="bp-port-input"
                 class="connection-panel__input"
                 value="12345" min="1024" max="65535"
                 aria-label="Intiface WebSocket port">
          <button id="btn-bp-connect" class="connection-panel__btn">Connect</button>
        </div>
      </div>

      <div class="connection-panel__info" id="bp-device-section" hidden>
        <div class="connection-panel__section-label">Devices</div>
        <div id="bp-device-list" class="connection-panel__device-list">
          <div class="connection-panel__no-devices">No devices found</div>
        </div>
        <button id="btn-bp-scan" class="connection-panel__btn connection-panel__btn--secondary">
          Scan for Devices
        </button>
      </div>

      </div><!-- end tab-buttplug -->

      <div class="connection-panel__tab-content" id="tab-settings" hidden>

      <div class="connection-panel__section">
        <label class="connection-panel__section-label">Gap Skip</label>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Mode</span>
          <select id="gap-skip-mode" class="connection-panel__device-select connection-panel__setting-select">
            <option value="off">Off</option>
            <option value="auto">Auto (countdown)</option>
            <option value="button">Show Skip Button</option>
          </select>
        </div>
        <div class="connection-panel__setting-row" id="gap-skip-threshold-row" hidden>
          <span class="connection-panel__setting-label">Threshold</span>
          <input type="range" id="gap-skip-threshold" class="connection-panel__setting-slider"
                 min="5" max="60" value="10" aria-label="Gap skip threshold">
          <span id="gap-skip-threshold-val" class="connection-panel__setting-value">10s</span>
        </div>
        <div class="connection-panel__setting-hint" id="gap-skip-hint" hidden>
          Gaps shorter than the threshold are ignored. Press G to skip manually anytime.
        </div>
      </div>

      <div class="connection-panel__section">
        <label class="connection-panel__section-label">Motion Smoothing</label>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Interpolation</span>
          <select id="smoothing-mode" class="connection-panel__device-select connection-panel__setting-select">
            <option value="linear">Linear (default)</option>
            <option value="pchip">Smooth (PCHIP)</option>
            <option value="makima">Extra Smooth (Makima)</option>
          </select>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Speed Limit</span>
          <input type="range" id="speed-limit-slider" class="connection-panel__setting-slider"
                 min="0" max="500" value="0" step="10" aria-label="Speed limit">
          <span id="speed-limit-val" class="connection-panel__setting-value">Off</span>
        </div>
        <div class="connection-panel__setting-hint">
          Smoothing affects Buttplug.io linear devices. Handy uses its own interpolation.
        </div>
      </div>

      <div class="connection-panel__section">
        <label class="connection-panel__section-label">Data</label>
        <div class="connection-panel__data-row">
          <button id="btn-export-data" class="connection-panel__btn connection-panel__btn--secondary">Export Backup</button>
          <button id="btn-import-data" class="connection-panel__btn connection-panel__btn--secondary">Import Backup</button>
        </div>
      </div>

      </div><!-- end tab-settings -->
    `;

    document.getElementById('app').appendChild(this._panel);

    // Replace the <i data-lucide> placeholder with actual SVG
    const closePlaceholder = this._panel.querySelector('.connection-panel__close i[data-lucide]');
    if (closePlaceholder) {
      closePlaceholder.replaceWith(icon(X, { width: 18, height: 18 }));
    }
  }

  _bindEvents() {
    // Close button
    this._panel.querySelector('.connection-panel__close').addEventListener('click', () => {
      this.hide();
    });

    // Connect button
    const btnConnect = this._panel.querySelector('#btn-connect');
    const keyInput = this._panel.querySelector('#connection-key-input');

    btnConnect.addEventListener('click', () => this._onConnect());
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._onConnect();
    });

    // Re-sync button
    this._panel.querySelector('#btn-resync').addEventListener('click', () => this._onResync());

    // Offset slider + number input
    const offsetSlider = this._panel.querySelector('#offset-slider');
    const offsetNumber = this._panel.querySelector('#offset-number');

    offsetSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      offsetNumber.value = val;
      this._onOffsetChange(val);
    });

    offsetNumber.addEventListener('change', (e) => {
      const val = Math.max(-500, Math.min(500, parseInt(e.target.value, 10) || 0));
      offsetSlider.value = val;
      offsetNumber.value = val;
      this._onOffsetChange(val);
    });

    // Stroke range sliders (dual-thumb)
    const minSlider = this._panel.querySelector('#stroke-min-slider');
    const maxSlider = this._panel.querySelector('#stroke-max-slider');
    const minVal = this._panel.querySelector('#stroke-min-val');
    const maxVal = this._panel.querySelector('#stroke-max-val');
    const trackWrapper = this._panel.querySelector('.connection-panel__stroke-track-wrapper');

    // Click anywhere on track to move nearest thumb
    trackWrapper.addEventListener('click', (e) => {
      const rect = trackWrapper.getBoundingClientRect();
      const pct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      const minV = parseInt(minSlider.value, 10);
      const maxV = parseInt(maxSlider.value, 10);
      const distToMin = Math.abs(pct - minV);
      const distToMax = Math.abs(pct - maxV);

      if (distToMin <= distToMax) {
        const clamped = Math.min(pct, maxV - 1);
        minSlider.value = clamped;
        minVal.textContent = clamped;
        this._updateStrokeFill();
        this._onStrokeChange(clamped, maxV);
      } else {
        const clamped = Math.max(pct, minV + 1);
        maxSlider.value = clamped;
        maxVal.textContent = clamped;
        this._updateStrokeFill();
        this._onStrokeChange(minV, clamped);
      }
    });

    minSlider.addEventListener('input', (e) => {
      let val = parseInt(e.target.value, 10);
      const maxV = parseInt(maxSlider.value, 10);
      if (val >= maxV) {
        val = maxV - 1;
        e.target.value = val;
      }
      minVal.textContent = val;
      this._updateStrokeFill();
      this._onStrokeChange(val, maxV);
    });

    maxSlider.addEventListener('input', (e) => {
      let val = parseInt(e.target.value, 10);
      const minV = parseInt(minSlider.value, 10);
      if (val <= minV) {
        val = minV + 1;
        e.target.value = val;
      }
      maxVal.textContent = val;
      this._updateStrokeFill();
      this._onStrokeChange(minV, val);
    });

    // Reset stroke button
    this._panel.querySelector('#btn-reset-stroke').addEventListener('click', () => this._onResetStroke());

    // Tab switching
    for (const tab of this._panel.querySelectorAll('.connection-panel__tab')) {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    }

    // SDK callbacks
    this.handy.onConnect = () => this._updateStatus('connected');
    this.handy.onDisconnect = () => this._updateStatus('disconnected');
    this.handy.onError = (msg) => this._showError(msg);

    // Buttplug callbacks + events
    if (this.buttplug) {
      this._panel.querySelector('#btn-bp-connect').addEventListener('click', () => this._onButtplugConnect());
      this._panel.querySelector('#btn-bp-scan').addEventListener('click', () => this._onButtplugScan());

      this.buttplug.onConnect = () => this._updateButtplugStatus('connected');
      this.buttplug.onDisconnect = () => this._updateButtplugStatus('disconnected');
      this.buttplug.onDeviceAdded = (dev) => this._updateButtplugDeviceList();
      this.buttplug.onDeviceRemoved = (dev) => this._updateButtplugDeviceList();
      this.buttplug.onError = (msg) => this._showButtplugError(msg);
    }

    // Export/Import buttons
    this._panel.querySelector('#btn-export-data')?.addEventListener('click', () => this._onExportData());
    this._panel.querySelector('#btn-import-data')?.addEventListener('click', () => this._onImportData());

    // Gap skip settings
    const gapModeSelect = this._panel.querySelector('#gap-skip-mode');
    const gapThresholdSlider = this._panel.querySelector('#gap-skip-threshold');
    const gapThresholdVal = this._panel.querySelector('#gap-skip-threshold-val');
    const gapThresholdRow = this._panel.querySelector('#gap-skip-threshold-row');
    const gapHint = this._panel.querySelector('#gap-skip-hint');

    if (gapModeSelect) {
      // Load saved settings
      const saved = this.settings.get('player.gapSkip') || {};
      gapModeSelect.value = saved.mode || 'off';
      if (gapThresholdSlider) gapThresholdSlider.value = Math.round((saved.threshold || 10000) / 1000);
      if (gapThresholdVal) gapThresholdVal.textContent = `${gapThresholdSlider?.value || 10}s`;

      const showThreshold = saved.mode && saved.mode !== 'off';
      if (gapThresholdRow) gapThresholdRow.hidden = !showThreshold;
      if (gapHint) gapHint.hidden = !showThreshold;

      gapModeSelect.addEventListener('change', () => {
        const mode = gapModeSelect.value;
        const threshold = (parseInt(gapThresholdSlider?.value, 10) || 10) * 1000;
        this.settings.set('player.gapSkip', { mode, threshold });
        if (gapThresholdRow) gapThresholdRow.hidden = mode === 'off';
        if (gapHint) gapHint.hidden = mode === 'off';
        if (this.onGapSkipChanged) this.onGapSkipChanged(mode, threshold);
      });
    }

    if (gapThresholdSlider) {
      gapThresholdSlider.addEventListener('input', () => {
        const seconds = parseInt(gapThresholdSlider.value, 10) || 10;
        if (gapThresholdVal) gapThresholdVal.textContent = `${seconds}s`;
        const mode = gapModeSelect?.value || 'off';
        const threshold = seconds * 1000;
        this.settings.set('player.gapSkip', { mode, threshold });
        if (this.onGapSkipChanged) this.onGapSkipChanged(mode, threshold);
      });
    }

    // Smoothing settings
    const smoothingSelect = this._panel.querySelector('#smoothing-mode');
    const speedLimitSlider = this._panel.querySelector('#speed-limit-slider');
    const speedLimitVal = this._panel.querySelector('#speed-limit-val');

    if (smoothingSelect) {
      const savedSmoothing = this.settings.get('player.smoothing') || 'linear';
      smoothingSelect.value = savedSmoothing;

      smoothingSelect.addEventListener('change', () => {
        this.settings.set('player.smoothing', smoothingSelect.value);
        if (this.onSmoothingChanged) this.onSmoothingChanged(smoothingSelect.value);
      });
    }

    if (speedLimitSlider) {
      const savedLimit = this.settings.get('player.speedLimit') || 0;
      speedLimitSlider.value = savedLimit;
      speedLimitVal.textContent = savedLimit > 0 ? `${savedLimit}` : 'Off';

      speedLimitSlider.addEventListener('input', () => {
        const val = parseInt(speedLimitSlider.value, 10) || 0;
        speedLimitVal.textContent = val > 0 ? `${val}` : 'Off';
        this.settings.set('player.speedLimit', val);
        if (this.onSpeedLimitChanged) this.onSpeedLimitChanged(val);
      });
    }
  }

  _loadSavedSettings() {
    const savedKey = this.settings.get('handy.connectionKey');
    if (savedKey) {
      this._panel.querySelector('#connection-key-input').value = savedKey;
    }

    const savedOffset = this.settings.get('handy.defaultOffset');
    if (savedOffset != null) {
      this._panel.querySelector('#offset-slider').value = savedOffset;
      this._panel.querySelector('#offset-number').value = savedOffset;
    }

    const savedMin = this.settings.get('handy.slideMin');
    const savedMax = this.settings.get('handy.slideMax');
    if (savedMin != null) {
      this._panel.querySelector('#stroke-min-slider').value = savedMin;
      this._panel.querySelector('#stroke-min-val').textContent = savedMin;
    }
    if (savedMax != null) {
      this._panel.querySelector('#stroke-max-slider').value = savedMax;
      this._panel.querySelector('#stroke-max-val').textContent = savedMax;
    }
    this._updateStrokeFill();

    // Load saved Buttplug port
    const savedPort = this.settings.get('buttplug.port');
    if (savedPort != null) {
      const portInput = this._panel.querySelector('#bp-port-input');
      if (portInput) portInput.value = savedPort;
    }
  }

  async _onConnect() {
    const keyInput = this._panel.querySelector('#connection-key-input');
    const key = keyInput.value.trim();

    if (!key || key.length < 5) {
      this._showError('Connection key must be at least 5 characters');
      return;
    }

    if (this.handy.connected) {
      await this.handy.disconnect();
      this._updateStatus('disconnected');
      return;
    }

    this._updateStatus('connecting');
    const success = await this.handy.connect(key);

    if (success) {
      // Save key
      this.settings.set('handy.connectionKey', key);

      // Update device info display
      this._updateDeviceInfo();

      // Run time sync
      await this._onResync();

      this._updateStatus('connected');
    } else {
      this._updateStatus('error');
    }
  }

  async _onResync() {
    const syncQuality = this._panel.querySelector('#sync-quality');
    syncQuality.textContent = 'Syncing...';

    const result = await this.handy.syncTime();
    if (result) {
      syncQuality.textContent = `RTD: ${Math.round(result.avgRtd)}ms`;
    } else {
      syncQuality.textContent = 'Sync failed';
    }
  }

  _updateStatus(status) {
    const led = this._panel.querySelector('#connection-led');
    const text = this._panel.querySelector('#connection-status-text');
    const btn = this._panel.querySelector('#btn-connect');
    const infoSection = this._panel.querySelector('#device-info-section');
    const syncSection = this._panel.querySelector('#sync-section');
    const offsetSection = this._panel.querySelector('#offset-section');
    const strokeSection = this._panel.querySelector('#stroke-section');

    led.className = 'connection-panel__led';

    switch (status) {
      case 'connected':
        led.classList.add('connection-panel__led--connected');
        text.textContent = 'Connected';
        btn.textContent = 'Disconnect';
        infoSection.hidden = false;
        syncSection.hidden = false;
        offsetSection.hidden = false;
        strokeSection.hidden = false;
        // Apply saved offset and stroke zone to device
        this._applySavedDeviceSettings();
        break;

      case 'connecting':
        led.classList.add('connection-panel__led--connecting');
        text.textContent = 'Connecting...';
        btn.textContent = 'Connecting...';
        btn.disabled = true;
        break;

      case 'error':
        led.classList.add('connection-panel__led--error');
        text.textContent = 'Connection Failed';
        btn.textContent = 'Connect';
        btn.disabled = false;
        break;

      case 'disconnected':
      default:
        text.textContent = 'Disconnected';
        btn.textContent = 'Connect';
        btn.disabled = false;
        infoSection.hidden = true;
        syncSection.hidden = true;
        offsetSection.hidden = true;
        strokeSection.hidden = true;
        break;
    }
  }

  _updateDeviceInfo() {
    const info = this.handy.deviceInfo;
    if (!info) return;

    this._panel.querySelector('#device-firmware').textContent = info.fwVersion || '—';
    this._panel.querySelector('#device-model').textContent = info.model || '—';

    // Check firmware status
    const fwWarning = this._panel.querySelector('#firmware-warning');
    if (info.fwStatus && info.fwStatus !== 0) {
      fwWarning.hidden = false;
    } else {
      fwWarning.hidden = true;
    }
  }

  _showError(message) {
    console.error('[ConnectionPanel]', message);
    const text = this._panel.querySelector('#connection-status-text');
    text.textContent = message;
  }

  async _onOffsetChange(value) {
    this.settings.set('handy.defaultOffset', value);
    if (this.handy.connected) {
      await this.handy.setOffset(value);
    }
  }

  async _onStrokeChange(min, max) {
    this.settings.set('handy.slideMin', min);
    this.settings.set('handy.slideMax', max);
    if (this.handy.connected) {
      await this.handy.setStrokeZone(min, max);
    }
  }

  async _onResetStroke() {
    this._panel.querySelector('#stroke-min-slider').value = 0;
    this._panel.querySelector('#stroke-max-slider').value = 100;
    this._panel.querySelector('#stroke-min-val').textContent = '0';
    this._panel.querySelector('#stroke-max-val').textContent = '100';
    this._updateStrokeFill();
    await this._onStrokeChange(0, 100);
  }

  _updateStrokeFill() {
    const min = parseInt(this._panel.querySelector('#stroke-min-slider').value, 10);
    const max = parseInt(this._panel.querySelector('#stroke-max-slider').value, 10);
    const fill = this._panel.querySelector('#stroke-fill');
    if (fill) {
      fill.style.left = `${min}%`;
      fill.style.width = `${max - min}%`;
    }
  }

  async _applySavedDeviceSettings() {
    const offset = this.settings.get('handy.defaultOffset') || 0;
    const min = this.settings.get('handy.slideMin') ?? 0;
    const max = this.settings.get('handy.slideMax') ?? 100;

    try {
      await this.handy.setOffset(offset);
      await this.handy.setStrokeZone(min, max);
    } catch (err) {
      console.warn('[ConnectionPanel] Failed to apply saved device settings:', err.message);
    }
  }

  // --- Tab Switching ---

  _switchTab(tabId) {
    this._activeTab = tabId;

    for (const tab of this._panel.querySelectorAll('.connection-panel__tab')) {
      tab.classList.toggle('connection-panel__tab--active', tab.dataset.tab === tabId);
    }

    this._panel.querySelector('#tab-handy').hidden = tabId !== 'handy';
    this._panel.querySelector('#tab-buttplug').hidden = tabId !== 'buttplug';
    this._panel.querySelector('#tab-settings').hidden = tabId !== 'settings';
  }

  // --- Buttplug ---

  async _onButtplugConnect() {
    if (!this.buttplug) return;

    if (this.buttplug.connected) {
      await this.buttplug.disconnect();
      this._updateButtplugStatus('disconnected');
      return;
    }

    const port = parseInt(this._panel.querySelector('#bp-port-input').value, 10) || 12345;
    this.settings.set('buttplug.port', port);

    this._updateButtplugStatus('connecting');
    const success = await this.buttplug.connect(port);

    if (success) {
      this._updateButtplugStatus('connected');
      // Auto-scan after connect
      await this.buttplug.startScanning();
    } else {
      this._updateButtplugStatus('error');
    }
  }

  async _onButtplugScan() {
    if (!this.buttplug?.connected) return;
    await this.buttplug.startScanning();
  }

  _updateButtplugStatus(status) {
    const led = this._panel.querySelector('#bp-connection-led');
    const text = this._panel.querySelector('#bp-connection-status-text');
    const btn = this._panel.querySelector('#btn-bp-connect');
    const deviceSection = this._panel.querySelector('#bp-device-section');

    led.className = 'connection-panel__led';

    switch (status) {
      case 'connected':
        led.classList.add('connection-panel__led--connected');
        text.textContent = 'Connected to Intiface';
        btn.textContent = 'Disconnect';
        btn.disabled = false;
        deviceSection.hidden = false;
        this._updateButtplugDeviceList();
        break;

      case 'connecting':
        led.classList.add('connection-panel__led--connecting');
        text.textContent = 'Connecting...';
        btn.textContent = 'Connecting...';
        btn.disabled = true;
        break;

      case 'error':
        led.classList.add('connection-panel__led--error');
        text.textContent = 'Connection Failed — is Intiface running?';
        btn.textContent = 'Connect';
        btn.disabled = false;
        break;

      case 'disconnected':
      default:
        text.textContent = 'Disconnected';
        btn.textContent = 'Connect';
        btn.disabled = false;
        deviceSection.hidden = true;
        break;
    }
  }

  _updateButtplugDeviceList() {
    if (!this.buttplug) return;

    const list = this._panel.querySelector('#bp-device-list');
    const devices = this.buttplug.devices;

    if (devices.length === 0) {
      list.innerHTML = '<div class="connection-panel__no-devices">No devices found — click Scan</div>';
      return;
    }

    list.innerHTML = '';
    for (const dev of devices) {
      const caps = [];
      if (dev.canLinear) caps.push('Linear');
      if (dev.canVibrate) caps.push('Vibrate');
      if (dev.canRotate) caps.push('Rotate');

      const row = document.createElement('div');
      row.className = 'connection-panel__device-row';

      const info = document.createElement('div');
      info.className = 'connection-panel__device-info';
      info.innerHTML = `<span class="connection-panel__device-name">${_esc(dev.name)}</span><span class="connection-panel__device-caps">${caps.join(', ')}</span>`;

      const controls = document.createElement('div');
      controls.className = 'connection-panel__device-controls';

      // Vibe mode selector (only for vibrate-capable devices)
      if (dev.canVibrate) {
        const modeSelect = document.createElement('select');
        modeSelect.className = 'connection-panel__device-select connection-panel__vib-control';
        modeSelect.title = 'Vibration mapping mode';
        const modes = [
          { value: 'speed', label: 'Speed' },
          { value: 'position', label: 'Position' },
          { value: 'intensity', label: 'Hybrid' },
        ];
        for (const m of modes) {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.label;
          modeSelect.appendChild(opt);
        }
        modeSelect.value = this.buttplugSync?.getVibeMode(dev.index) || 'speed';
        modeSelect.addEventListener('change', () => {
          if (this.buttplugSync) {
            this.buttplugSync.setVibeMode(dev.index, modeSelect.value);
            this._saveButtplugDeviceSettings();
          }
        });
        controls.appendChild(modeSelect);

        // Info button
        const infoBtn = document.createElement('button');
        infoBtn.className = 'connection-panel__device-info-btn';
        infoBtn.title = 'What do these modes do?';
        infoBtn.appendChild(icon(Info, { width: 14, height: 14 }));
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showVibeModeHelp(infoBtn);
        });
        controls.appendChild(infoBtn);
      }

      // Invert toggle
      const invertLabel = document.createElement('label');
      invertLabel.className = 'connection-panel__device-toggle connection-panel__vib-control';
      const invertCheck = document.createElement('input');
      invertCheck.type = 'checkbox';
      invertCheck.checked = this.buttplugSync?.isInverted(dev.index) || false;
      invertCheck.addEventListener('change', () => {
        if (this.buttplugSync) {
          this.buttplugSync.setInverted(dev.index, invertCheck.checked);
          this._saveButtplugDeviceSettings();
        }
      });
      invertLabel.appendChild(invertCheck);
      invertLabel.appendChild(document.createTextNode(' Invert'));
      controls.appendChild(invertLabel);

      row.appendChild(info);
      row.appendChild(controls);
      list.appendChild(row);
    }

    // Restore saved invert settings
    this._loadButtplugDeviceSettings();

    // Apply vib control disabled state if multi-axis vib is active
    this.updateVibControlState();
  }

  _saveButtplugDeviceSettings() {
    if (!this.buttplug || !this.buttplugSync) return;
    const perDevice = {};
    for (const dev of this.buttplug.devices) {
      const settings = {};
      if (this.buttplugSync.isInverted(dev.index)) settings.inverted = true;
      const mode = this.buttplugSync.getVibeMode(dev.index);
      if (mode !== 'speed') settings.vibeMode = mode;
      if (Object.keys(settings).length > 0) {
        perDevice[dev.name] = settings;
      }
    }
    this.settings.set('buttplug.deviceSettings', perDevice);
  }

  _loadButtplugDeviceSettings() {
    if (!this.buttplug || !this.buttplugSync) return;
    const perDevice = this.settings.get('buttplug.deviceSettings') || {};
    const devices = this.buttplug.devices;

    for (const dev of devices) {
      const saved = perDevice[dev.name];
      if (saved) {
        if (saved.inverted) this.buttplugSync.setInverted(dev.index, true);
        if (saved.vibeMode) this.buttplugSync.setVibeMode(dev.index, saved.vibeMode);
      }
    }

    // Update UI controls to match loaded settings
    const rows = this._panel.querySelectorAll('.connection-panel__device-row');
    rows.forEach((row, i) => {
      if (i >= devices.length) return;
      const dev = devices[i];
      const invertCb = row.querySelector('.connection-panel__device-toggle input');
      if (invertCb) invertCb.checked = this.buttplugSync.isInverted(dev.index);
      const modeSelect = row.querySelector('.connection-panel__device-select');
      if (modeSelect) modeSelect.value = this.buttplugSync.getVibeMode(dev.index);
    });
  }

  _showVibeModeHelp(anchorEl) {
    // Remove any existing tooltip
    this._panel.querySelector('.connection-panel__vibe-help')?.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'connection-panel__vibe-help';
    tooltip.innerHTML = `
      <div class="connection-panel__vibe-help-title">Vibration Mapping Modes</div>
      <div class="connection-panel__vibe-help-section">
        <strong>Speed</strong> — Intensity follows how fast the script moves.
        Fast strokes = strong vibration, pauses = none.
      </div>
      <div class="connection-panel__vibe-help-section">
        <strong>Position</strong> — Intensity matches the script position directly.
        High position (100) = full power, low (0) = off.
      </div>
      <div class="connection-panel__vibe-help-section">
        <strong>Hybrid</strong> — Blends both: 40% from position + 60% from speed.
        Feels active during movement but maintains a base level.
      </div>
      <div class="connection-panel__vibe-help-section" style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.1);padding-top:6px;">
        <strong>Invert</strong> — Flips the script values (0 becomes 100, 100 becomes 0).
        In Speed mode this has no effect on vibration strength (speed is absolute).
        In Position/Hybrid modes, low positions become strong and high become weak.
      </div>
    `;

    // Close on click anywhere
    this._vibeHelpCloseHandler = () => {
      tooltip.remove();
      document.removeEventListener('click', this._vibeHelpCloseHandler);
      this._vibeHelpCloseHandler = null;
    };
    setTimeout(() => document.addEventListener('click', this._vibeHelpCloseHandler), 0);

    // Append to panel (not parent) so it isn't clipped by overflow
    this._panel.appendChild(tooltip);

    // Position to the left of the info button, vertically centered
    const btnRect = anchorEl.getBoundingClientRect();
    const panelRect = this._panel.getBoundingClientRect();
    const tooltipWidth = 260;

    let left = btnRect.left - panelRect.left - tooltipWidth - 8;
    let top = btnRect.top - panelRect.top - 40;

    // If it would go off the left edge, flip to the right
    if (left < 0) {
      left = btnRect.right - panelRect.left + 8;
    }

    // Clamp vertically so it doesn't overflow the panel bottom
    const maxTop = panelRect.height - tooltip.offsetHeight - 8;
    if (maxTop > 0 && top > maxTop) top = maxTop;
    if (top < 4) top = 4;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  _showButtplugError(message) {
    console.error('[ConnectionPanel/Buttplug]', message);
    const text = this._panel.querySelector('#bp-connection-status-text');
    if (text) text.textContent = message;
  }

  // --- Data Export/Import ---

  async _onExportData() {
    const btn = this._panel.querySelector('#btn-export-data');
    btn.disabled = true;
    btn.textContent = 'Exporting...';

    try {
      const result = await window.funsync.exportData();
      if (result.success) {
        btn.textContent = 'Exported!';
        setTimeout(() => { btn.textContent = 'Export Backup'; btn.disabled = false; }, 2000);
      } else {
        btn.textContent = result.error || 'Export failed';
        setTimeout(() => { btn.textContent = 'Export Backup'; btn.disabled = false; }, 2000);
      }
    } catch (err) {
      btn.textContent = 'Export failed';
      setTimeout(() => { btn.textContent = 'Export Backup'; btn.disabled = false; }, 2000);
    }
  }

  async _onImportData() {
    const btn = this._panel.querySelector('#btn-import-data');
    btn.disabled = true;
    btn.textContent = 'Importing...';

    try {
      const result = await window.funsync.importData();
      if (result.success) {
        btn.textContent = 'Imported!';
        setTimeout(() => { btn.textContent = 'Import Backup'; btn.disabled = false; }, 2000);
      } else {
        btn.textContent = result.error || 'Import failed';
        setTimeout(() => { btn.textContent = 'Import Backup'; btn.disabled = false; }, 2000);
      }
    } catch (err) {
      btn.textContent = 'Import failed';
      setTimeout(() => { btn.textContent = 'Import Backup'; btn.disabled = false; }, 2000);
    }
  }

  // --- Public API ---

  toggle() {
    if (this._visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    this._panel.hidden = false;
    this._visible = true;
    this._panel.querySelector('#connection-key-input')?.focus();

    // Clean up previous listener before adding new one
    if (this._boundOutsideClick) {
      document.removeEventListener('click', this._boundOutsideClick, true);
    }
    this._boundOutsideClick = (e) => {
      if (!this._panel.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', this._boundOutsideClick, true);
    }, 0);
  }

  hide() {
    this._panel.hidden = true;
    this._visible = false;
    if (this._boundOutsideClick) {
      document.removeEventListener('click', this._boundOutsideClick, true);
      this._boundOutsideClick = null;
    }
    if (this._vibeHelpCloseHandler) {
      document.removeEventListener('click', this._vibeHelpCloseHandler);
      this._vibeHelpCloseHandler = null;
    }
    // Remove any open tooltips
    this._panel.querySelector('.connection-panel__vibe-help')?.remove();
  }

  /**
   * Update the disabled state of vibration controls based on whether
   * a dedicated vib script is loaded (multi-axis).
   */
  updateVibControlState() {
    const hasVibScript = !!this.buttplugSync?.hasVibScript;
    const controls = this._panel.querySelectorAll('.connection-panel__vib-control');

    for (const el of controls) {
      if (el.tagName === 'SELECT') {
        el.disabled = hasVibScript;
      } else if (el.tagName === 'LABEL') {
        const cb = el.querySelector('input[type="checkbox"]');
        if (cb) cb.disabled = hasVibScript;
      }
      el.classList.toggle('connection-panel__vib-control--disabled', hasVibScript);
    }

    // Add or remove the explanation text
    const existingNote = this._panel.querySelector('.connection-panel__vib-override-note');
    if (hasVibScript && !existingNote) {
      const note = document.createElement('div');
      note.className = 'connection-panel__vib-override-note';
      note.textContent = 'Vibration controlled by dedicated script — mode and invert settings have no effect.';
      const deviceList = this._panel.querySelector('.connection-panel__device-list');
      if (deviceList) {
        deviceList.parentElement.appendChild(note);
      }
    } else if (!hasVibScript && existingNote) {
      existingNote.remove();
    }
  }
}

/** Escape HTML special characters. */
function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
