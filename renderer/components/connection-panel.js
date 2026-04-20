// ConnectionPanel — UI for connecting to Handy or Buttplug.io devices

import { icon, X, Info } from '../js/icons.js';

export class ConnectionPanel {
  constructor({ handyManager, buttplugManager, buttplugSync, tcodeManager, tcodeSync, autoblowManager, autoblowSync, vrBridge, settings }) {
    this.handy = handyManager;
    this.buttplug = buttplugManager || null;
    this.buttplugSync = buttplugSync || null;
    this.tcodeManager = tcodeManager || null;
    this.tcodeSync = tcodeSync || null;
    this.autoblowManager = autoblowManager || null;
    this.autoblowSync = autoblowSync || null;
    this.vrBridge = vrBridge || null;
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
          <button class="connection-panel__tab" data-tab="tcode">TCode</button>
          <button class="connection-panel__tab" data-tab="autoblow">Autoblow</button>
          <button class="connection-panel__tab" data-tab="vr">VR</button>
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

      <div class="connection-panel__tab-content" id="tab-tcode" hidden>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="tcode-led"></span>
        <span class="connection-panel__status-text" id="tcode-status-text">Disconnected</span>
      </div>

      <div class="connection-panel__form">
        <label class="connection-panel__label">Serial Port</label>
        <div class="connection-panel__input-row">
          <select id="tcode-port-select" class="connection-panel__input" style="flex:1" aria-label="Serial port"></select>
          <button id="tcode-refresh-btn" class="connection-panel__btn" style="min-width:auto;padding:6px 10px" title="Refresh ports">↻</button>
        </div>

        <label class="connection-panel__label" style="margin-top:8px">Baud Rate</label>
        <select id="tcode-baud-select" class="connection-panel__input" aria-label="Baud rate">
          <option value="9600">9600</option>
          <option value="19200">19200</option>
          <option value="38400">38400</option>
          <option value="57600">57600</option>
          <option value="115200" selected>115200</option>
          <option value="250000">250000</option>
        </select>

        <div class="connection-panel__input-row" style="margin-top:10px">
          <button id="tcode-connect-btn" class="connection-panel__btn" style="flex:1">Connect</button>
        </div>
      </div>

      <div id="tcode-axis-settings" class="connection-panel__section" hidden>
        <label class="connection-panel__section-label">Axis Ranges</label>
        <div id="tcode-axis-list"></div>
      </div>

      </div><!-- end tab-tcode -->

      <div class="connection-panel__tab-content" id="tab-autoblow" hidden>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="ab-led"></span>
        <span class="connection-panel__status-text" id="ab-status-text">Disconnected</span>
      </div>

      <div class="connection-panel__form">
        <label for="ab-token-input" class="connection-panel__label">Device Token</label>
        <div class="connection-panel__input-row">
          <input type="password" id="ab-token-input"
                 class="connection-panel__input"
                 placeholder="Enter device token"
                 aria-label="Autoblow device token">
          <button id="ab-connect-btn" class="connection-panel__btn">Connect</button>
        </div>
      </div>

      <div id="ab-device-info" class="connection-panel__section" hidden>
        <label class="connection-panel__section-label">Device</label>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Type</span>
          <span id="ab-device-type" class="connection-panel__setting-value">—</span>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Latency</span>
          <span id="ab-latency" class="connection-panel__setting-value">—</span>
          <button id="ab-latency-btn" class="connection-panel__btn" style="min-width:auto;padding:4px 10px;font-size:11px">Measure</button>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Offset</span>
          <input type="range" id="ab-offset" min="-500" max="500" value="0" class="connection-panel__safety-slider" style="flex:1">
          <span id="ab-offset-value" class="connection-panel__setting-value" style="min-width:40px;text-align:right">0ms</span>
        </div>
      </div>

      </div><!-- end tab-autoblow -->

      <div class="connection-panel__tab-content" id="tab-vr" hidden>

      <!-- VR Server Mode (Quest standalone) -->
      <div class="connection-panel__section">
        <label class="connection-panel__section-label">VR Server (Quest)</label>
        <div class="connection-panel__vr-help-note" style="margin-bottom:8px">
          Stream your library to DeoVR or HereSphere on Quest. No file transfers needed.
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">DeoVR URL</span>
          <input type="text" id="vr-server-deovr-url" class="connection-panel__input" readonly style="flex:1;font-size:11px;cursor:text">
        </div>
        <div class="connection-panel__setting-row" style="margin-top:4px">
          <span class="connection-panel__setting-label">HereSphere URL</span>
          <input type="text" id="vr-server-hs-url" class="connection-panel__input" readonly style="flex:1;font-size:11px;cursor:text">
        </div>
        <div class="connection-panel__vr-help" style="margin-top:8px">
          <div class="connection-panel__vr-help-step">1. Open DeoVR or HereSphere on your Quest</div>
          <div class="connection-panel__vr-help-step">2. Add the URL above as a <strong>custom server</strong></div>
          <div class="connection-panel__vr-help-step">3. Browse your library and play — videos stream from this PC</div>
          <div class="connection-panel__vr-help-step">4. Funscripts auto-load. Connected devices sync automatically.</div>
        </div>
      </div>

      <div class="connection-panel__vr-divider"></div>

      <!-- PCVR Companion Mode -->
      <div class="connection-panel__section">
        <label class="connection-panel__section-label">PCVR Companion</label>
        <div class="connection-panel__vr-help-note" style="margin-bottom:8px">
          Sync devices with DeoVR or HereSphere running on this PC.
        </div>
        <div class="connection-panel__status">
          <span class="connection-panel__led" id="vr-led"></span>
          <span class="connection-panel__status-text" id="vr-status-text">Disconnected</span>
        </div>
        <div class="connection-panel__form">
          <div class="connection-panel__input-row">
            <select id="vr-player-select" class="connection-panel__input" style="width:auto" aria-label="VR player">
              <option value="deovr">DeoVR</option>
              <option value="heresphere">HereSphere</option>
            </select>
            <input type="text" id="vr-host-input" class="connection-panel__input" value="127.0.0.1" placeholder="127.0.0.1" aria-label="Host" style="flex:1">
            <button id="vr-connect-btn" class="connection-panel__btn">Connect</button>
          </div>
        </div>

        <div id="vr-now-playing" class="connection-panel__section" hidden style="margin-top:8px">
          <div class="connection-panel__setting-row">
            <span class="connection-panel__setting-label">Playing</span>
            <span id="vr-video-name" class="connection-panel__setting-value" style="font-size:11px;word-break:break-all">—</span>
          </div>
          <div class="connection-panel__setting-row">
            <span class="connection-panel__setting-label">Offset</span>
            <input type="range" id="vr-offset" min="-500" max="500" value="0" class="connection-panel__safety-slider" style="flex:1">
            <span id="vr-offset-value" class="connection-panel__setting-value" style="min-width:40px;text-align:right">0ms</span>
          </div>
        </div>
      </div>

      </div><!-- end tab-vr -->

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

    // TCode callbacks + events
    if (this.tcodeManager) {
      this._panel.querySelector('#tcode-connect-btn').addEventListener('click', () => this._onTCodeConnect());
      this._panel.querySelector('#tcode-refresh-btn').addEventListener('click', () => this._refreshTCodePorts());

      // Restore saved settings
      const savedPort = this.settings.get('tcode.port') || '';
      const savedBaud = this.settings.get('tcode.baudRate') || 115200;
      this._panel.querySelector('#tcode-baud-select').value = String(savedBaud);

      this.tcodeManager.onConnect = () => this._updateTCodeStatus('connected');
      this.tcodeManager.onDisconnect = () => this._updateTCodeStatus('disconnected');

      // Initial port scan
      this._refreshTCodePorts(savedPort);
    }

    // Autoblow callbacks + events
    if (this.autoblowManager) {
      this._panel.querySelector('#ab-connect-btn').addEventListener('click', () => this._onAutoblowConnect());

      const savedToken = this.settings.get('autoblow.token') || '';
      if (savedToken) this._panel.querySelector('#ab-token-input').value = savedToken;

      const savedOffset = this.settings.get('autoblow.offset') || 0;
      this._panel.querySelector('#ab-offset').value = String(savedOffset);
      this._panel.querySelector('#ab-offset-value').textContent = `${savedOffset}ms`;

      this._panel.querySelector('#ab-offset').addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        this._panel.querySelector('#ab-offset-value').textContent = `${v}ms`;
      });
      this._panel.querySelector('#ab-offset').addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        this.settings.set('autoblow.offset', v);
        if (this.autoblowManager?.connected) this.autoblowManager.syncOffset(v);
      });

      this._panel.querySelector('#ab-latency-btn')?.addEventListener('click', async () => {
        const btn = this._panel.querySelector('#ab-latency-btn');
        const display = this._panel.querySelector('#ab-latency');
        btn.disabled = true;
        btn.textContent = '...';
        const latency = await this.autoblowManager.estimateLatency();
        display.textContent = `${latency}ms`;
        btn.textContent = 'Measure';
        btn.disabled = false;
      });

      this.autoblowManager.onConnect = () => this._updateAutoblowStatus('connected');
      this.autoblowManager.onDisconnect = () => this._updateAutoblowStatus('disconnected');
    }

    // VR Bridge callbacks + events
    if (this.vrBridge) {
      this._panel.querySelector('#vr-connect-btn').addEventListener('click', () => this._onVRConnect());

      // Offset slider
      this._panel.querySelector('#vr-offset')?.addEventListener('input', (e) => {
        this._panel.querySelector('#vr-offset-value').textContent = `${e.target.value}ms`;
      });
      this._panel.querySelector('#vr-offset')?.addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        this.settings.set('vr.offset', v);
        // Apply offset to VR playback proxy in real-time
        if (this.vrBridge?.proxy) this.vrBridge.proxy.setOffset(v);
      });

      // Restore saved offset and apply to proxy
      const savedOffset = this.settings.get('vr.offset') || 0;
      const offsetSlider = this._panel.querySelector('#vr-offset');
      if (offsetSlider) { offsetSlider.value = String(savedOffset); }
      const offsetVal = this._panel.querySelector('#vr-offset-value');
      if (offsetVal) offsetVal.textContent = `${savedOffset}ms`;
      if (this.vrBridge?.proxy) this.vrBridge.proxy.setOffset(savedOffset);

      this.vrBridge.onConnect = () => this._updateVRStatus('connected');
      this.vrBridge.onDisconnect = () => this._updateVRStatus('disconnected');
    }

    // Populate VR server URLs
    this._updateVRServerUrls();
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
    this._panel.querySelector('#tab-tcode').hidden = tabId !== 'tcode';
    this._panel.querySelector('#tab-autoblow').hidden = tabId !== 'autoblow';
    this._panel.querySelector('#tab-vr').hidden = tabId !== 'vr';

    // Refresh VR server URLs when switching to VR tab
    if (tabId === 'vr') this._updateVRServerUrls();
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
      const row = document.createElement('div');
      row.className = 'connection-panel__device-row';

      // Header: name + badges + test button
      const header = document.createElement('div');
      header.className = 'connection-panel__device-header';

      const nameEl = document.createElement('span');
      nameEl.className = 'connection-panel__device-name';
      nameEl.textContent = dev.name;
      header.appendChild(nameEl);

      const badges = document.createElement('span');
      badges.className = 'connection-panel__device-badges';
      if (dev.canLinear) badges.appendChild(this._makeBadge('Linear', 'linear'));
      if (dev.canVibrate) badges.appendChild(this._makeBadge('Vibrate', 'vibrate'));
      if (dev.canRotate) badges.appendChild(this._makeBadge('Rotate', 'rotate'));
      if (dev.canScalar) badges.appendChild(this._makeBadge('E-Stim', 'estim'));
      header.appendChild(badges);

      const testBtn = document.createElement('button');
      testBtn.className = 'connection-panel__device-test';
      testBtn.textContent = 'Test';
      testBtn.title = 'Send a brief test movement';
      testBtn.addEventListener('click', () => this._testDevice(dev));
      header.appendChild(testBtn);

      row.appendChild(header);

      // Axis assignment
      const axisRow = document.createElement('div');
      axisRow.className = 'connection-panel__device-axis-row';
      const axisLabel = document.createElement('span');
      axisLabel.className = 'connection-panel__device-axis-label';
      axisLabel.textContent = 'Source:';
      const axisSelect = document.createElement('select');
      axisSelect.className = 'connection-panel__device-select';
      axisSelect.title = 'What drives this device';

      const axisOptions = [
        { value: 'L0', label: 'Main Script' },
        { value: '__custom__', label: 'Follow Custom Routing' },
        { value: 'L1', label: 'Surge (L1)' },
        { value: 'L2', label: 'Sway (L2)' },
        { value: 'R0', label: 'Twist (R0)' },
        { value: 'R1', label: 'Roll (R1)' },
        { value: 'R2', label: 'Pitch (R2)' },
        { value: 'V0', label: 'Vibe (V0)' },
        { value: 'V1', label: 'Lube/Pump (V1)' },
        { value: 'V2', label: 'Suction (V2)' },
        { value: 'A0', label: 'Valve (A0)' },
      ];
      for (const opt of axisOptions) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        axisSelect.appendChild(o);
      }

      // Determine current value
      const currentAssignment = this.buttplugSync?.getAxisAssignment(dev.index) || 'L0';
      const isCustomRouted = this.buttplugSync?._customRoutingActive &&
        currentAssignment.startsWith('CR');
      axisSelect.value = isCustomRouted ? '__custom__' : currentAssignment;

      axisSelect.addEventListener('change', () => {
        if (!this.buttplugSync) return;
        const val = axisSelect.value;
        if (val === '__custom__') {
          // Don't change assignment — custom routing manages it per-video
          // Just clear any manual override so custom routing takes effect
          this.buttplugSync.setAxisAssignment(dev.index, null);
        } else {
          this.buttplugSync.setAxisAssignment(dev.index, val);
        }
        this._saveButtplugDeviceSettings();
      });

      // Single controls row: source + mode + invert
      const controlsRow = document.createElement('div');
      controlsRow.className = 'connection-panel__device-controls-row';

      axisRow.appendChild(axisLabel);
      axisRow.appendChild(axisSelect);
      controlsRow.appendChild(axisRow);

      if (dev.canVibrate) {
        controlsRow.appendChild(this._makeModeSelect(dev, 'vibe', 'Vibration mode', 'speed',
          () => this.buttplugSync?.getVibeMode(dev.index) || 'speed',
          (val) => { if (this.buttplugSync) this.buttplugSync.setVibeMode(dev.index, val); }
        ));
      }
      if (dev.canRotate) {
        controlsRow.appendChild(this._makeModeSelect(dev, 'rotate', 'Rotation mode', 'speed',
          () => this.buttplugSync?.getRotateMode(dev.index) || 'speed',
          (val) => { if (this.buttplugSync) this.buttplugSync.setRotateMode(dev.index, val); }
        ));
      }
      if (dev.canScalar) {
        controlsRow.appendChild(this._makeModeSelect(dev, 'scalar', 'E-stim mode', 'position',
          () => this.buttplugSync?.getScalarMode(dev.index) || 'position',
          (val) => { if (this.buttplugSync) this.buttplugSync.setScalarMode(dev.index, val); }
        ));
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
      controlsRow.appendChild(invertLabel);

      // Info button
      if (dev.canVibrate || dev.canScalar || dev.canRotate) {
        const infoBtn = document.createElement('button');
        infoBtn.className = 'connection-panel__device-info-btn';
        infoBtn.title = 'What do these modes do?';
        infoBtn.appendChild(icon(Info, { width: 14, height: 14 }));
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showVibeModeHelp(infoBtn);
        });
        controlsRow.appendChild(infoBtn);
      }

      row.appendChild(controlsRow);

      // E-stim safety section (only for scalar devices)
      if (dev.canScalar) {
        const safetySection = document.createElement('div');
        safetySection.className = 'connection-panel__device-safety-section';

        const maxRow = document.createElement('div');
        maxRow.className = 'connection-panel__device-safety';
        const maxLabel = document.createElement('span');
        maxLabel.textContent = 'Max:';
        const maxVal = document.createElement('span');
        maxVal.className = 'connection-panel__safety-value';
        const currentMax = this.buttplugSync?.getMaxIntensity(dev.index) ?? 70;
        maxVal.textContent = `${currentMax}%`;
        const maxSlider = document.createElement('input');
        maxSlider.type = 'range';
        maxSlider.min = '0';
        maxSlider.max = '100';
        maxSlider.value = String(currentMax);
        maxSlider.className = 'connection-panel__safety-slider';
        maxSlider.addEventListener('input', () => {
          const v = parseInt(maxSlider.value, 10);
          maxVal.textContent = `${v}%`;
          if (v > 80) maxVal.classList.add('connection-panel__safety-value--warn');
          else maxVal.classList.remove('connection-panel__safety-value--warn');
        });
        maxSlider.addEventListener('change', async () => {
          const v = parseInt(maxSlider.value, 10);
          if (v > 90) {
            const { Modal } = await import('./modal.js');
            const confirmed = await Modal.confirm('High Intensity',
              `Setting e-stim intensity to ${v}% — high levels can cause discomfort. Continue?`);
            if (!confirmed) {
              maxSlider.value = '70';
              maxVal.textContent = '70%';
              maxVal.classList.remove('connection-panel__safety-value--warn');
              if (this.buttplugSync) this.buttplugSync.setMaxIntensity(dev.index, 70);
              this._saveButtplugDeviceSettings();
              return;
            }
          }
          if (this.buttplugSync) this.buttplugSync.setMaxIntensity(dev.index, v);
          this._saveButtplugDeviceSettings();
        });
        maxRow.appendChild(maxLabel);
        maxRow.appendChild(maxSlider);
        maxRow.appendChild(maxVal);
        safetySection.appendChild(maxRow);

        const rampLabel = document.createElement('label');
        rampLabel.className = 'connection-panel__device-toggle';
        const rampCheck = document.createElement('input');
        rampCheck.type = 'checkbox';
        rampCheck.checked = this.buttplugSync?.getRampUp(dev.index) ?? true;
        rampCheck.addEventListener('change', () => {
          if (this.buttplugSync) {
            this.buttplugSync.setRampUp(dev.index, rampCheck.checked);
            this._saveButtplugDeviceSettings();
          }
        });
        rampLabel.appendChild(rampCheck);
        rampLabel.appendChild(document.createTextNode(' Ramp-up (2s)'));
        safetySection.appendChild(rampLabel);

        row.appendChild(safetySection);
      }

      list.appendChild(row);
    }

    // Restore saved invert settings
    this._loadButtplugDeviceSettings();

    // Apply vib control disabled state if multi-axis vib is active
    this.updateVibControlState();
  }

  async _testDevice(dev) {
    if (!this.buttplug || this._testingDevice) return;
    this._testingDevice = true;
    const idx = dev.index;
    try {
      if (dev.canLinear) {
        await this.buttplug.sendLinear(idx, 0, 300);
        await new Promise(r => setTimeout(r, 350));
        await this.buttplug.sendLinear(idx, 80, 400);
        await new Promise(r => setTimeout(r, 450));
        await this.buttplug.sendLinear(idx, 20, 400);
        await new Promise(r => setTimeout(r, 450));
        await this.buttplug.sendLinear(idx, 50, 300);
      } else if (dev.canVibrate) {
        await this.buttplug.sendVibrate(idx, 30);
        await new Promise(r => setTimeout(r, 400));
        await this.buttplug.sendVibrate(idx, 70);
        await new Promise(r => setTimeout(r, 400));
        await this.buttplug.sendVibrate(idx, 0);
      } else if (dev.canRotate) {
        await this.buttplug.sendRotate(idx, 40, true);
        await new Promise(r => setTimeout(r, 500));
        await this.buttplug.sendRotate(idx, 40, false);
        await new Promise(r => setTimeout(r, 500));
        await this.buttplug.sendRotate(idx, 0);
      } else if (dev.canScalar) {
        // E-stim test: very gentle pulse, respecting safety cap
        const cap = this.buttplugSync?.getMaxIntensity(idx) ?? 70;
        const testIntensity = Math.min(20, cap);
        await this.buttplug.sendScalar(idx, testIntensity);
        await new Promise(r => setTimeout(r, 500));
        await this.buttplug.sendScalar(idx, 0);
      }
    } catch (err) {
      console.warn('[Test] Device test failed:', err.message);
    } finally {
      this._testingDevice = false;
    }
  }

  _makeBadge(text, variant) {
    const badge = document.createElement('span');
    badge.className = 'connection-panel__device-badge';
    if (variant) badge.classList.add(`connection-panel__device-badge--${variant}`);
    badge.textContent = text;
    return badge;
  }

  _makeModeSelect(dev, type, title, defaultMode, getter, setter) {
    const modeSelect = document.createElement('select');
    modeSelect.className = 'connection-panel__device-select connection-panel__vib-control';
    modeSelect.title = title;
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
    modeSelect.value = getter() || defaultMode;
    modeSelect.addEventListener('change', () => {
      setter(modeSelect.value);
      this._saveButtplugDeviceSettings();
    });
    return modeSelect;
  }

  _saveButtplugDeviceSettings() {
    if (!this.buttplug || !this.buttplugSync) return;
    const perDevice = {};
    for (const dev of this.buttplug.devices) {
      const settings = {};
      if (this.buttplugSync.isInverted(dev.index)) settings.inverted = true;
      const axisAssignment = this.buttplugSync.getAxisAssignment(dev.index);
      if (axisAssignment !== 'L0') {
        settings.axisAssignment = axisAssignment;
      } else if (this.buttplugSync._customRoutingActive && this.buttplugSync._axisAssignmentMap.has(dev.index)) {
        settings.axisAssignment = 'L0';
      }
      const vibeMode = this.buttplugSync.getVibeMode(dev.index);
      if (vibeMode !== 'speed') settings.vibeMode = vibeMode;
      const scalarMode = this.buttplugSync.getScalarMode(dev.index);
      if (scalarMode !== 'position') settings.scalarMode = scalarMode;
      const rotateMode = this.buttplugSync.getRotateMode(dev.index);
      if (rotateMode !== 'speed') settings.rotateMode = rotateMode;
      const maxIntensity = this.buttplugSync.getMaxIntensity(dev.index);
      if (maxIntensity !== 70) settings.maxIntensity = maxIntensity;
      const rampUp = this.buttplugSync.getRampUp(dev.index);
      if (!rampUp) settings.rampUp = false;
      if (Object.keys(settings).length > 0) {
        // Key by index:name — stable across sessions (Intiface preserves device indices)
        // Allows two identical devices to have separate settings
        perDevice[`${dev.index}:${dev.name}`] = settings;
      }
    }
    this.settings.set('buttplug.deviceSettings', perDevice);
  }

  _loadButtplugDeviceSettings() {
    if (!this.buttplug || !this.buttplugSync) return;
    const perDevice = this.settings.get('buttplug.deviceSettings') || {};
    const devices = this.buttplug.devices;

    for (const dev of devices) {
      // Try index:name key first (new format), fall back to name-only (backwards compat)
      const saved = perDevice[`${dev.index}:${dev.name}`] || perDevice[dev.name];
      if (saved) {
        if (saved.axisAssignment) this.buttplugSync.setAxisAssignment(dev.index, saved.axisAssignment);
        if (saved.inverted) this.buttplugSync.setInverted(dev.index, true);
        if (saved.vibeMode) this.buttplugSync.setVibeMode(dev.index, saved.vibeMode);
        if (saved.scalarMode) this.buttplugSync.setScalarMode(dev.index, saved.scalarMode);
        if (saved.rotateMode) this.buttplugSync.setRotateMode(dev.index, saved.rotateMode);
        if (saved.maxIntensity !== undefined) this.buttplugSync.setMaxIntensity(dev.index, saved.maxIntensity);
        if (saved.rampUp === false) this.buttplugSync.setRampUp(dev.index, false);
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

  // --- TCode Serial ---

  async _onTCodeConnect() {
    if (!this.tcodeManager) return;

    if (this.tcodeManager.connected) {
      await this.tcodeManager.disconnect();
      this._updateTCodeStatus('disconnected');
      return;
    }

    const portSelect = this._panel.querySelector('#tcode-port-select');
    const baudSelect = this._panel.querySelector('#tcode-baud-select');
    const portPath = portSelect.value;
    const baudRate = parseInt(baudSelect.value, 10) || 115200;

    if (!portPath) {
      this._updateTCodeStatus('disconnected');
      const text = this._panel.querySelector('#tcode-status-text');
      if (text) text.textContent = 'Select a port';
      return;
    }

    this._updateTCodeStatus('connecting');
    const success = await this.tcodeManager.connect(portPath, baudRate);

    if (success) {
      this.settings.set('tcode.port', portPath);
      this.settings.set('tcode.baudRate', baudRate);
    }
  }

  async _refreshTCodePorts(selectPort) {
    if (!this.tcodeManager) return;
    const ports = await this.tcodeManager.listPorts();
    const select = this._panel.querySelector('#tcode-port-select');
    if (!select) return;

    select.innerHTML = '';
    if (ports.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No ports found';
      select.appendChild(opt);
    } else {
      for (const p of ports) {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.manufacturer ? `${p.path} — ${p.manufacturer}` : p.path;
        select.appendChild(opt);
      }
      if (selectPort) select.value = selectPort;
    }
  }

  _updateTCodeStatus(status) {
    const led = this._panel.querySelector('#tcode-led');
    const text = this._panel.querySelector('#tcode-status-text');
    const btn = this._panel.querySelector('#tcode-connect-btn');
    const axisSection = this._panel.querySelector('#tcode-axis-settings');

    if (led) {
      led.className = 'connection-panel__led';
      if (status === 'connected') led.classList.add('connection-panel__led--connected');
      else if (status === 'connecting') led.classList.add('connection-panel__led--connecting');
    }
    if (text) {
      text.textContent = status === 'connected' ? 'Connected'
        : status === 'connecting' ? 'Connecting...' : 'Disconnected';
    }
    if (btn) {
      btn.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    }
    if (axisSection) {
      axisSection.hidden = status !== 'connected';
    }
  }

  // --- Autoblow ---

  async _onAutoblowConnect() {
    if (!this.autoblowManager) return;

    if (this.autoblowManager.connected) {
      await this.autoblowManager.disconnect();
      return;
    }

    const tokenInput = this._panel.querySelector('#ab-token-input');
    const token = tokenInput.value.trim();
    if (!token) {
      const text = this._panel.querySelector('#ab-status-text');
      if (text) text.textContent = 'Enter device token';
      return;
    }

    this._updateAutoblowStatus('connecting');
    const success = await this.autoblowManager.connect(token);

    if (success) {
      this.settings.set('autoblow.token', token);
    }
  }

  _updateAutoblowStatus(status) {
    const led = this._panel.querySelector('#ab-led');
    const text = this._panel.querySelector('#ab-status-text');
    const btn = this._panel.querySelector('#ab-connect-btn');
    const infoSection = this._panel.querySelector('#ab-device-info');
    const typeEl = this._panel.querySelector('#ab-device-type');

    if (led) {
      led.className = 'connection-panel__led';
      if (status === 'connected') led.classList.add('connection-panel__led--connected');
      else if (status === 'connecting') led.classList.add('connection-panel__led--connecting');
    }
    if (text) {
      text.textContent = status === 'connected' ? 'Connected'
        : status === 'connecting' ? 'Connecting...' : 'Disconnected';
    }
    if (btn) {
      btn.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    }
    if (infoSection) {
      infoSection.hidden = status !== 'connected';
    }
    if (typeEl && this.autoblowManager?.deviceType) {
      typeEl.textContent = this.autoblowManager.isUltra ? 'Autoblow Ultra' : 'VacuGlide 2';
    }
  }

  // --- VR Bridge ---

  async _onVRConnect() {
    if (!this.vrBridge) return;

    const btn = this._panel.querySelector('#vr-connect-btn');
    if (btn) btn.disabled = true;

    if (this.vrBridge.connected) {
      await this.vrBridge.disconnect();
      if (btn) btn.disabled = false;
      return;
    }

    const playerSelect = this._panel.querySelector('#vr-player-select');
    const hostInput = this._panel.querySelector('#vr-host-input');
    const playerType = playerSelect.value;
    const host = hostInput.value.trim() || '127.0.0.1';

    this._updateVRStatus('connecting');
    const success = await this.vrBridge.connect(playerType, host, 23554);

    if (!success) {
      this._updateVRStatus('disconnected');
      const text = this._panel.querySelector('#vr-status-text');
      if (text) text.textContent = 'Failed — check VR player settings';
    }
    if (btn) btn.disabled = false;
  }

  _updateVRStatus(status) {
    const led = this._panel.querySelector('#vr-led');
    const text = this._panel.querySelector('#vr-status-text');
    const btn = this._panel.querySelector('#vr-connect-btn');
    const nowPlaying = this._panel.querySelector('#vr-now-playing');
    const setupHelp = this._panel.querySelector('#vr-setup-help');

    if (led) {
      led.className = 'connection-panel__led';
      if (status === 'connected') led.classList.add('connection-panel__led--connected');
      else if (status === 'connecting') led.classList.add('connection-panel__led--connecting');
    }
    if (text) {
      text.textContent = status === 'connected' ? 'Connected'
        : status === 'connecting' ? 'Connecting...' : 'Disconnected';
    }
    if (btn) {
      btn.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    }
    if (nowPlaying) nowPlaying.hidden = status !== 'connected';
    if (setupHelp) setupHelp.hidden = status === 'connected';
  }

  updateVRVideoName(name) {
    const el = this._panel.querySelector('#vr-video-name');
    if (el) el.textContent = name || '—';
  }

  async _updateVRServerUrls() {
    const port = this.settings.get('backend.port') || 5123;
    const deovrUrl = this._panel.querySelector('#vr-server-deovr-url');
    const hsUrl = this._panel.querySelector('#vr-server-hs-url');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/network-info`);
      if (res.ok) {
        const data = await res.json();
        const ip = data.ip || '127.0.0.1';
        if (deovrUrl) deovrUrl.value = `http://${ip}:${port}/deovr`;
        if (hsUrl) hsUrl.value = `http://${ip}:${port}/heresphere`;
      } else {
        if (deovrUrl) deovrUrl.value = 'Backend not running';
        if (hsUrl) hsUrl.value = 'Backend not running';
      }
    } catch {
      if (deovrUrl) deovrUrl.value = 'Backend not running';
      if (hsUrl) hsUrl.value = 'Backend not running';
    }

    // Click-to-select on readonly inputs
    deovrUrl?.addEventListener('click', () => deovrUrl.select());
    hsUrl?.addEventListener('click', () => hsUrl.select());
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
