// ConnectionPanel — UI for connecting to Handy or Buttplug.io devices

import { icon, X, Info } from '../js/icons.js';
import { SUPPORTED_LOCALES, LOCALE_LABELS, setLocale, translatePage, getCurrentLocale, t } from '../js/i18n.js';
import {
  classifyTransport,
  computeSuggestedOffset,
  DEVICE_OFFSET_PRESETS,
} from '../js/auto-offset.js';
import { eventBus } from '../js/event-bus.js';
import { showToast } from '../js/toast.js';
// TCode v0.3 axes exposed in the Axis Ranges UI. Naming + type match the
// multi-axis spec module (renderer/js/multi-axis.js) and the official TCode
// specification. L0 is the main stroke; R0-R2 are rotation, V* are vibration,
// A0 is the first auxiliary channel (typically a valve/aux output on the SR6).
// Order matters — rendered top→bottom.
// Kinematic axis names (Surge/Sway/Twist/Roll/Pitch/Vibe/Lube/Pump/Suction/Valve)
// are international protocol-standard TCode terminology — kept literal in every
// locale so users recognise them across scripts, forums, and other tools.
// Only L0's "Stroke (main)" label is app-flavour framing and gets translated.
const TCODE_UI_AXES = [
  { tcode: 'L0', labelKey: 'connection.tcode.l0Label', type: 'linear'  },
  { tcode: 'L1', label: 'Surge',           type: 'linear'  },
  { tcode: 'L2', label: 'Sway',            type: 'linear'  },
  { tcode: 'R0', label: 'Twist',           type: 'rotate'  },
  { tcode: 'R1', label: 'Roll',            type: 'rotate'  },
  { tcode: 'R2', label: 'Pitch',           type: 'rotate'  },
  { tcode: 'V0', label: 'Vibe',            type: 'vibrate' },
  { tcode: 'V1', label: 'Lube / Pump',     type: 'vibrate' },
  { tcode: 'V2', label: 'Suction',         type: 'vibrate' },
  { tcode: 'A0', label: 'Valve',           type: 'linear'  },
];

export class ConnectionPanel {
  constructor({ handyManager, buttplugManager, buttplugSync, tcodeManager, tcodeSync, autoblowManager, autoblowSync, vrBridge, settings, onResyncComplete }) {
    this.handy = handyManager;
    this.buttplug = buttplugManager || null;
    this.buttplugSync = buttplugSync || null;
    this.tcodeManager = tcodeManager || null;
    this.tcodeSync = tcodeSync || null;
    this.autoblowManager = autoblowManager || null;
    this.autoblowSync = autoblowSync || null;
    this.vrBridge = vrBridge || null;
    this.settings = settings;
    // Called after the Re-sync time button completes a successful sync.
    // App wires this to hsspStop + hsspPlay at the current video position
    // so the device is left in a clean HSSP state. Without it, the SDK's
    // `.sync()` routine can leave the device in maintenance mode and
    // subsequent pause / setScript / next-video commands silently fail.
    // Community-reported bug 2026-06-01: "after Re-sync time, script
    // doesn't pause when video pauses, doesn't switch on new video".
    this.onResyncComplete = onResyncComplete || null;
    this._panel = null;
    this._visible = false;
    this._activeTab = 'handy'; // 'handy' | 'buttplug'

    this._createPanel();
    this._bindEvents();
    this._loadSavedSettings();

    // Initial tab LED state — all four start "not connected" so the
    // strip reads the correct neutral state on first show. Real status
    // updates flow in via SDK callbacks once auto-connect kicks off.
    this._setTabLedState('handy', 'disconnected');
    this._setTabLedState('buttplug', 'disconnected');
    this._setTabLedState('tcode', 'disconnected');
    this._setTabLedState('autoblow', 'disconnected');
  }

  _createPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'connection-panel';
    this._panel.hidden = true;
    this._panel.setAttribute('role', 'dialog');
    this._panel.setAttribute('aria-modal', 'true');
    this._panel.setAttribute('aria-labelledby', 'connection-panel__title');

    this._panel.innerHTML = `
      <div class="connection-panel__header">
        <h2 id="connection-panel__title" class="connection-panel__title" data-i18n="connection.title">${_esc(t('connection.title'))}</h2>
        <button class="connection-panel__close control-btn" data-i18n-aria-label="connection.closeAria" aria-label="${_esc(t('connection.closeAria'))}"><i data-lucide="x"></i></button>
      </div>
      <div class="connection-panel__tabs" role="tablist" data-i18n-aria-label="connection.tabsAria" aria-label="${_esc(t('connection.tabsAria'))}">
        <button class="connection-panel__tab connection-panel__tab--active" role="tab" id="connection-panel__tab-btn-handy" aria-selected="true" aria-controls="tab-handy" data-tab="handy">
          <span class="connection-panel__tab-led" data-tab-led="handy" aria-hidden="true"></span>
          <span class="connection-panel__tab-label">Handy</span>
        </button>
        <button class="connection-panel__tab" role="tab" id="connection-panel__tab-btn-buttplug" aria-selected="false" aria-controls="tab-buttplug" data-tab="buttplug" tabindex="-1">
          <span class="connection-panel__tab-led" data-tab-led="buttplug" aria-hidden="true"></span>
          <span class="connection-panel__tab-label">Buttplug.io</span>
        </button>
        <button class="connection-panel__tab" role="tab" id="connection-panel__tab-btn-tcode" aria-selected="false" aria-controls="tab-tcode" data-tab="tcode" tabindex="-1">
          <span class="connection-panel__tab-led" data-tab-led="tcode" aria-hidden="true"></span>
          <span class="connection-panel__tab-label">TCode</span>
        </button>
        <button class="connection-panel__tab" role="tab" id="connection-panel__tab-btn-autoblow" aria-selected="false" aria-controls="tab-autoblow" data-tab="autoblow" tabindex="-1">
          <span class="connection-panel__tab-led" data-tab-led="autoblow" aria-hidden="true"></span>
          <span class="connection-panel__tab-label">Autoblow</span>
        </button>
        <button class="connection-panel__tab" role="tab" id="connection-panel__tab-btn-sync" aria-selected="false" aria-controls="tab-sync" data-tab="sync" tabindex="-1">
          <span class="connection-panel__tab-label" data-i18n="connection.tabSync">Sync</span>
        </button>
        <button class="connection-panel__tab" role="tab" id="connection-panel__tab-btn-settings" aria-selected="false" aria-controls="tab-settings" data-tab="settings" tabindex="-1">
          <span class="connection-panel__tab-label" data-i18n="settings.title">Settings</span>
        </button>
      </div>

      <div class="connection-panel__tab-content" id="tab-handy" role="tabpanel" aria-labelledby="connection-panel__tab-btn-handy">

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="connection-led"></span>
        <span class="connection-panel__status-text" id="connection-status-text" data-i18n="connection.status.notConnected">${_esc(t('connection.status.notConnected'))}</span>
      </div>

      <div class="connection-panel__form">
        <label for="connection-key-input" class="connection-panel__label" data-i18n="connection.handy.connectionKey">${_esc(t('connection.handy.connectionKey'))}</label>
        <div class="connection-panel__input-row">
          <input type="text" id="connection-key-input"
                 class="connection-panel__input"
                 data-i18n-placeholder="connection.handy.connectionKeyPlaceholder"
                 placeholder="${_esc(t('connection.handy.connectionKeyPlaceholder'))}"
                 maxlength="32"
                 data-i18n-aria-label="connection.handy.connectionKeyAria"
                 aria-label="${_esc(t('connection.handy.connectionKeyAria'))}">
          <button id="btn-connect" class="connection-panel__btn" data-i18n="connection.btn.connect">${_esc(t('connection.btn.connect'))}</button>
        </div>
      </div>

      <div class="connection-panel__info" id="device-info-section" hidden>
        <div class="connection-panel__info-row">
          <span data-i18n="connection.handy.firmware">${_esc(t('connection.handy.firmware'))}</span>
          <span id="device-firmware">—</span>
        </div>
        <div class="connection-panel__info-row">
          <span data-i18n="connection.handy.model">${_esc(t('connection.handy.model'))}</span>
          <span id="device-model">—</span>
        </div>
        <div class="connection-panel__info-row">
          <span data-i18n="connection.handy.rtd">${_esc(t('connection.handy.rtd'))}</span>
          <span id="device-rtd">—</span>
        </div>
        <div id="firmware-warning" class="connection-panel__warning" hidden data-i18n="connection.handy.firmwareUpdate">
          ${_esc(t('connection.handy.firmwareUpdate'))}
        </div>
      </div>

      <div class="connection-panel__sync" id="sync-section" hidden>
        <button id="btn-resync" class="connection-panel__btn connection-panel__btn--secondary" data-i18n="connection.btn.resync">
          ${_esc(t('connection.btn.resync'))}
        </button>
        <span id="sync-quality" class="connection-panel__sync-quality"></span>
      </div>

      <div class="connection-panel__section" id="offset-section" hidden>
        <label class="connection-panel__section-label" data-i18n="connection.handy.syncOffset">${_esc(t('connection.handy.syncOffset'))}</label>
        <div class="connection-panel__offset-row">
          <input type="range" class="connection-panel__offset-slider" id="offset-slider"
                 min="-1000" max="1000" step="10" value="0"
                 data-i18n-aria-label="connection.handy.offsetSliderAria"
                 aria-label="${_esc(t('connection.handy.offsetSliderAria'))}">
          <input type="number" class="connection-panel__offset-number" id="offset-number"
                 min="-1000" max="1000" step="10" value="0"
                 data-i18n-aria-label="connection.handy.offsetValueAria"
                 aria-label="${_esc(t('connection.handy.offsetValueAria'))}">
          <span class="connection-panel__offset-unit">ms</span>
        </div>
      </div>

      <div class="connection-panel__section" id="stroke-section" hidden>
        <label class="connection-panel__section-label" data-i18n="connection.handy.strokeRange">${_esc(t('connection.handy.strokeRange'))}</label>
        <div class="connection-panel__stroke-container">
          <span class="connection-panel__stroke-value" id="stroke-min-val">0</span>
          <div class="connection-panel__stroke-track-wrapper">
            <div class="connection-panel__stroke-track"></div>
            <div class="connection-panel__stroke-fill" id="stroke-fill"></div>
            <input type="range" class="connection-panel__stroke-input" id="stroke-min-slider"
                   min="0" max="100" value="0"
                   data-i18n-aria-label="connection.handy.strokeMinAria"
                   aria-label="${_esc(t('connection.handy.strokeMinAria'))}">
            <input type="range" class="connection-panel__stroke-input" id="stroke-max-slider"
                   min="0" max="100" value="100"
                   data-i18n-aria-label="connection.handy.strokeMaxAria"
                   aria-label="${_esc(t('connection.handy.strokeMaxAria'))}">
          </div>
          <span class="connection-panel__stroke-value" id="stroke-max-val">100</span>
        </div>
        <button id="btn-reset-stroke" class="connection-panel__btn connection-panel__btn--reset" data-i18n="connection.btn.resetStroke">
          ${_esc(t('connection.btn.resetStroke'))}
        </button>
      </div>

      </div><!-- end tab-handy -->

      <div class="connection-panel__tab-content" id="tab-buttplug" role="tabpanel" aria-labelledby="connection-panel__tab-btn-buttplug" hidden>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="bp-connection-led"></span>
        <span class="connection-panel__status-text" id="bp-connection-status-text" data-i18n="connection.status.notConnected">${_esc(t('connection.status.notConnected'))}</span>
      </div>

      <div class="connection-panel__form">
        <label for="bp-port-input" class="connection-panel__label" data-i18n="connection.buttplug.port">${_esc(t('connection.buttplug.port'))}</label>
        <div class="connection-panel__input-row">
          <input type="number" id="bp-port-input"
                 class="connection-panel__input"
                 value="12345" min="1024" max="65535"
                 data-i18n-aria-label="connection.buttplug.portAria"
                 aria-label="${_esc(t('connection.buttplug.portAria'))}">
          <button id="btn-bp-connect" class="connection-panel__btn" data-i18n="connection.btn.connect">${_esc(t('connection.btn.connect'))}</button>
        </div>
      </div>

      <div class="connection-panel__info" id="bp-device-section" hidden>
        <div class="connection-panel__section-label" data-i18n="connection.buttplug.devices">${_esc(t('connection.buttplug.devices'))}</div>
        <div id="bp-device-list" class="connection-panel__device-list">
          <div class="connection-panel__no-devices" data-i18n="connection.buttplug.noDevices">${_esc(t('connection.buttplug.noDevices'))}</div>
        </div>
        <button id="btn-bp-scan" class="connection-panel__btn connection-panel__btn--secondary" data-i18n="connection.btn.scan">
          ${_esc(t('connection.btn.scan'))}
        </button>
      </div>

      </div><!-- end tab-buttplug -->

      <div class="connection-panel__tab-content" id="tab-tcode" role="tabpanel" aria-labelledby="connection-panel__tab-btn-tcode" hidden>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="tcode-led"></span>
        <span class="connection-panel__status-text" id="tcode-status-text" data-i18n="connection.status.notConnected">${_esc(t('connection.status.notConnected'))}</span>
      </div>

      <div class="connection-panel__form">
        <label class="connection-panel__label" data-i18n="connection.tcode.transport">${_esc(t('connection.tcode.transport'))}</label>
        <select id="tcode-transport-select" class="connection-panel__input" data-i18n-aria-label="connection.tcode.transportAria" aria-label="${_esc(t('connection.tcode.transportAria'))}">
          <option value="serial" selected data-i18n="connection.tcode.transportSerial">${_esc(t('connection.tcode.transportSerial'))}</option>
          <option value="udp" data-i18n="connection.tcode.transportUdp">${_esc(t('connection.tcode.transportUdp'))}</option>
          <option value="websocket" data-i18n="connection.tcode.transportWs">${_esc(t('connection.tcode.transportWs'))}</option>
        </select>

        <div id="tcode-serial-fields" class="connection-panel__transport-fields">
          <label class="connection-panel__label" style="margin-top:8px" data-i18n="connection.tcode.serialPort">${_esc(t('connection.tcode.serialPort'))}</label>
          <div class="connection-panel__input-row">
            <select id="tcode-port-select" class="connection-panel__input" style="flex:1" data-i18n-aria-label="connection.tcode.serialPortAria" aria-label="${_esc(t('connection.tcode.serialPortAria'))}"></select>
            <button id="tcode-refresh-btn" class="connection-panel__action connection-panel__action--utility" data-i18n-title="connection.tcode.refreshPortsTitle" title="${_esc(t('connection.tcode.refreshPortsTitle'))}" data-i18n-aria-label="connection.tcode.refreshPortsAria" aria-label="${_esc(t('connection.tcode.refreshPortsAria'))}">↻</button>
          </div>

          <label class="connection-panel__label" style="margin-top:8px" data-i18n="connection.tcode.baudRate">${_esc(t('connection.tcode.baudRate'))}</label>
          <select id="tcode-baud-select" class="connection-panel__input" data-i18n-aria-label="connection.tcode.baudRateAria" aria-label="${_esc(t('connection.tcode.baudRateAria'))}">
            <option value="9600">9600</option>
            <option value="19200">19200</option>
            <option value="38400">38400</option>
            <option value="57600">57600</option>
            <option value="115200" selected>115200</option>
            <option value="250000">250000</option>
          </select>
        </div>

        <div id="tcode-udp-fields" class="connection-panel__transport-fields" hidden>
          <label for="tcode-udp-host" class="connection-panel__label" style="margin-top:8px" data-i18n="connection.tcode.host">${_esc(t('connection.tcode.host'))}</label>
          <input id="tcode-udp-host" type="text" class="connection-panel__input"
                 placeholder="192.168.1.42" data-i18n-aria-label="connection.tcode.hostAria" aria-label="${_esc(t('connection.tcode.hostAria'))}">
          <label for="tcode-udp-port" class="connection-panel__label" style="margin-top:8px" data-i18n="connection.tcode.port">${_esc(t('connection.tcode.port'))}</label>
          <input id="tcode-udp-port" type="number" class="connection-panel__input"
                 min="1" max="65535" placeholder="8080" data-i18n-aria-label="connection.tcode.portAria" aria-label="${_esc(t('connection.tcode.portAria'))}">
        </div>

        <div id="tcode-ws-fields" class="connection-panel__transport-fields" hidden>
          <label for="tcode-ws-url" class="connection-panel__label" style="margin-top:8px" data-i18n="connection.tcode.wsUrl">${_esc(t('connection.tcode.wsUrl'))}</label>
          <input id="tcode-ws-url" type="text" class="connection-panel__input"
                 placeholder="ws://192.168.1.42:81" data-i18n-aria-label="connection.tcode.wsUrlAria" aria-label="${_esc(t('connection.tcode.wsUrlAria'))}">
          <div class="connection-panel__hint" style="margin-top:4px;font-size:11px;color:var(--text-secondary)" data-i18n="connection.tcode.wsHint">
            ${_esc(t('connection.tcode.wsHint'))}
          </div>
        </div>

        <label class="connection-panel__label" style="margin-top:8px" data-i18n="connection.tcode.precision">${_esc(t('connection.tcode.precision'))}</label>
        <select id="tcode-precision-select" class="connection-panel__input" data-i18n-aria-label="connection.tcode.precisionAria" aria-label="${_esc(t('connection.tcode.precisionAria'))}">
          <option value="3" selected data-i18n="settings.tcodePrecision3">${_esc(t('settings.tcodePrecision3'))}</option>
          <option value="4" data-i18n="settings.tcodePrecision4">${_esc(t('settings.tcodePrecision4'))}</option>
        </select>

        <div class="connection-panel__input-row" style="margin-top:10px">
          <button id="tcode-connect-btn" class="connection-panel__btn" style="flex:1" data-i18n="connection.btn.connect">${_esc(t('connection.btn.connect'))}</button>
        </div>
      </div>

      <div id="tcode-axis-settings" class="connection-panel__section" hidden>
        <label class="connection-panel__section-label" data-i18n="connection.tcode.axisRanges">${_esc(t('connection.tcode.axisRanges'))}</label>
        <div id="tcode-axis-list"></div>
      </div>

      </div><!-- end tab-tcode -->

      <div class="connection-panel__tab-content" id="tab-autoblow" role="tabpanel" aria-labelledby="connection-panel__tab-btn-autoblow" hidden>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="ab-led"></span>
        <span class="connection-panel__status-text" id="ab-status-text" data-i18n="connection.status.notConnected">${_esc(t('connection.status.notConnected'))}</span>
      </div>

      <div class="connection-panel__form">
        <label for="ab-token-input" class="connection-panel__label" data-i18n="connection.autoblow.deviceToken">${_esc(t('connection.autoblow.deviceToken'))}</label>
        <div class="connection-panel__input-row">
          <input type="password" id="ab-token-input"
                 class="connection-panel__input"
                 data-i18n-placeholder="connection.autoblow.deviceTokenPlaceholder"
                 placeholder="${_esc(t('connection.autoblow.deviceTokenPlaceholder'))}"
                 data-i18n-aria-label="connection.autoblow.deviceTokenAria"
                 aria-label="${_esc(t('connection.autoblow.deviceTokenAria'))}">
          <button id="ab-connect-btn" class="connection-panel__btn" data-i18n="connection.btn.connect">${_esc(t('connection.btn.connect'))}</button>
        </div>
      </div>

      <div id="ab-device-info" class="connection-panel__section" hidden>
        <label class="connection-panel__section-label" data-i18n="connection.autoblow.device">${_esc(t('connection.autoblow.device'))}</label>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label" data-i18n="connection.autoblow.type">${_esc(t('connection.autoblow.type'))}</span>
          <span id="ab-device-type" class="connection-panel__setting-value">—</span>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label" data-i18n="connection.autoblow.latency">${_esc(t('connection.autoblow.latency'))}</span>
          <span id="ab-latency" class="connection-panel__setting-value">—</span>
          <button id="ab-latency-btn" class="connection-panel__action connection-panel__action--utility" data-i18n="connection.btn.measure">${_esc(t('connection.btn.measure'))}</button>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label" data-i18n="connection.autoblow.offset">${_esc(t('connection.autoblow.offset'))}</span>
          <input type="range" id="ab-offset" min="-1000" max="1000" value="0" class="connection-panel__safety-slider" style="flex:1">
          <span id="ab-offset-value" class="connection-panel__setting-value" style="min-width:40px;text-align:right">0ms</span>
        </div>
      </div>

      </div><!-- end tab-autoblow -->

      <div class="connection-panel__tab-content" id="tab-sync" role="tabpanel" aria-labelledby="connection-panel__tab-btn-sync" hidden>

      <div class="connection-panel__section" style="padding:8px 12px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:10px">
        <span style="font-weight:600;color:#ffc107;font-size:11px;letter-spacing:0.5px" data-i18n="connection.sync.experimental">${_esc(t('connection.sync.experimental'))}</span>
        <span style="font-size:11px;opacity:0.85;margin-left:6px" data-i18n="connection.sync.experimentalNote">${_esc(t('connection.sync.experimentalNote'))}</span>
      </div>

      <div class="connection-panel__section">
        <label class="connection-panel__section-label" data-i18n="connection.sync.measuredLatency">${_esc(t('connection.sync.measuredLatency'))}</label>
        <div class="connection-panel__hint" style="margin-bottom:8px;font-size:11px;opacity:0.7" data-i18n="connection.sync.measuredLatencyHint">
          ${_esc(t('connection.sync.measuredLatencyHint'))}
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label" data-i18n="connection.sync.vrJitter">${_esc(t('connection.sync.vrJitter'))}</span>
          <span id="sync-vr-jitter" class="connection-panel__setting-value">—</span>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label" data-i18n="connection.sync.handyRtd">${_esc(t('connection.sync.handyRtd'))}</span>
          <span id="sync-handy-rtd" class="connection-panel__setting-value">—</span>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label" data-i18n="connection.sync.vrTransport">${_esc(t('connection.sync.vrTransport'))}</span>
          <span id="sync-vr-transport" class="connection-panel__setting-value">—</span>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:6px">
          <button id="sync-refresh-btn" class="connection-panel__action connection-panel__action--utility" data-i18n="connection.btn.refresh">${_esc(t('connection.btn.refresh'))}</button>
        </div>
      </div>

      <div class="connection-panel__section">
        <label class="connection-panel__section-label" data-i18n="connection.sync.perDeviceOffsets">${_esc(t('connection.sync.perDeviceOffsets'))}</label>
        <div class="connection-panel__hint" style="margin-bottom:8px;font-size:11px;opacity:0.7" data-i18n="connection.sync.perDeviceHint">
          ${_esc(t('connection.sync.perDeviceHint'))}
        </div>
        <div id="sync-device-rows"></div>
      </div>

      </div><!-- end tab-sync -->

      <div class="connection-panel__tab-content" id="tab-settings" role="tabpanel" aria-labelledby="connection-panel__tab-btn-settings" hidden>
        <div class="connection-panel__form">
          <label for="settings-language-select" class="connection-panel__label" data-i18n="settings.language">${_esc(t('settings.language'))}</label>
          <select id="settings-language-select" class="connection-panel__input" data-i18n-aria-label="settings.language" aria-label="${_esc(t('settings.language'))}"></select>
        </div>
      </div><!-- end tab-settings -->

    `;

    document.getElementById('app').appendChild(this._panel);

    // Replace the <i data-lucide> placeholder with actual SVG
    const closePlaceholder = this._panel.querySelector('.connection-panel__close i[data-lucide]');
    if (closePlaceholder) {
      closePlaceholder.replaceWith(icon(X, { width: 18, height: 18 }));
    }

    // Fullscreen reparenting. The Fullscreen API only paints the
    // fullscreen element and its descendants on the top layer, so a
    // panel attached to `#app` is invisible (and unclickable) while a
    // sibling video is fullscreened — even though `hidden = false`
    // does set correctly. Move the panel into whichever element is
    // currently fullscreened on every fullscreenchange so it lives in
    // the right subtree whether or not it's currently open. On exit,
    // move back to `#app`. Idempotent — re-appending to the same
    // parent is a no-op.
    document.addEventListener('fullscreenchange', () => {
      const target = document.fullscreenElement || document.getElementById('app');
      if (this._panel.parentElement !== target) {
        target.appendChild(this._panel);
      }
    });
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
      const val = Math.max(-1000, Math.min(1000, parseInt(e.target.value, 10) || 0));
      offsetSlider.value = val;
      offsetNumber.value = val;
      this._onOffsetChange(val);
    });

    // Re-render dynamic strings when the active locale changes. The
    // global translatePage() handles all `data-i18n*` attributes in the
    // static markup, but the per-device rows, status text (set via JS
    // textContent), and Sync tab values bypass that path — so refresh
    // them here. Idempotent — re-rendering doesn't lose user state.
    eventBus.on('language:changed', () => {
      try {
        // Re-derive status text on all four device tabs from current
        // connection state — picks up the new locale immediately.
        if (this.handy) this._updateStatus(this.handy.connected ? 'connected' : 'disconnected');
        if (this.buttplug) this._updateButtplugStatus(this.buttplug.connected ? 'connected' : 'disconnected');
        if (this.tcodeManager) this._updateTCodeStatus(this.tcodeManager.connected ? 'connected' : 'disconnected');
        if (this.autoblowManager) this._updateAutoblowStatus(this.autoblowManager.connected ? 'connected' : 'disconnected');
        if (this.buttplug?.connected) this._updateButtplugDeviceList();
        if (this._activeTab === 'sync') this._refreshSyncTab();
      } catch (err) {
        console.warn('[ConnectionPanel] language re-render failed:', err.message);
      }
    });

    // Keep the Handy tab slider + Sync tab Handy row in sync with each
    // other. Both write the same `handy.defaultOffset` setting, so
    // whichever the user adjusts, the other one mirrors it without
    // needing a panel rebuild. Without this, each view read its value
    // once at panel-show and showed stale numbers after the user moved
    // the other control — confusing and easy to accidentally double-tune.
    eventBus.on('settings:changed', ({ path, value }) => {
      if (path === 'handy.defaultOffset') {
        if (offsetSlider && String(offsetSlider.value) !== String(value)) {
          offsetSlider.value = value;
        }
        if (offsetNumber && String(offsetNumber.value) !== String(value)) {
          offsetNumber.value = value;
        }
      }
      // Refresh the Sync tab if it's the one being viewed — device
      // offsets or VR offset just changed and the row values (plus the
      // "total effective" hint in VR mode) need to reflect it.
      if (this._activeTab === 'sync' && (
        path === 'handy.defaultOffset'
        || path === 'buttplug.defaultOffset'
        || path === 'tcode.defaultOffset'
        || path === 'vr.offset'
      )) {
        this._refreshSyncTab();
      }
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

    // Tab switching — click activates a tab; arrow keys move focus
    // within the tablist per WAI-ARIA APG (Left/Right + Home/End,
    // wrapping at edges).
    const tabButtons = Array.from(this._panel.querySelectorAll('.connection-panel__tab'));
    for (const tab of tabButtons) {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
      tab.addEventListener('keydown', (e) => {
        const idx = tabButtons.indexOf(tab);
        let nextIdx = null;
        if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabButtons.length;
        else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = tabButtons.length - 1;
        if (nextIdx != null) {
          e.preventDefault();
          const next = tabButtons[nextIdx];
          this._switchTab(next.dataset.tab);
          next.focus();
        }
      });
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
      const transportSelect = this._panel.querySelector('#tcode-transport-select');
      if (transportSelect) {
        transportSelect.addEventListener('change', () => this._onTCodeTransportChange());
      }

      // Restore saved settings — both legacy (serial) and new transport-aware.
      const savedTransport = this.settings.get('tcode.transport') || 'serial';
      const savedPort = this.settings.get('tcode.port') || '';
      const savedBaud = this.settings.get('tcode.baudRate') || 115200;
      const savedUdpHost = this.settings.get('tcode.udpHost') || '';
      const savedUdpPort = this.settings.get('tcode.udpPort') || '';
      const savedWsUrl = this.settings.get('tcode.wsUrl') || '';
      const savedPrecision = Number(this.settings.get('tcode.precision')) || 3;

      if (transportSelect) transportSelect.value = savedTransport;
      this._panel.querySelector('#tcode-baud-select').value = String(savedBaud);
      const udpHost = this._panel.querySelector('#tcode-udp-host');
      const udpPort = this._panel.querySelector('#tcode-udp-port');
      const wsUrl = this._panel.querySelector('#tcode-ws-url');
      const precisionSelect = this._panel.querySelector('#tcode-precision-select');
      if (udpHost) udpHost.value = savedUdpHost;
      if (udpPort && savedUdpPort) udpPort.value = String(savedUdpPort);
      if (wsUrl) wsUrl.value = savedWsUrl;
      if (precisionSelect) {
        precisionSelect.value = String(savedPrecision);
        // Apply immediately so the manager emits the right precision even
        // before the user clicks Connect.
        this.tcodeManager.setPrecision?.(savedPrecision);
        precisionSelect.addEventListener('change', () => {
          const digits = parseInt(precisionSelect.value, 10);
          this.tcodeManager.setPrecision?.(digits);
          this.settings.set('tcode.precision', digits);
        });
      }
      this._onTCodeTransportChange();

      this.tcodeManager.onConnect = () => this._updateTCodeStatus('connected');
      this.tcodeManager.onDisconnect = () => this._updateTCodeStatus('disconnected');

      // Push saved axis ranges/enabled state into tcodeSync so they apply
      // as soon as the device connects — no need to open the panel first.
      this._applyTCodeAxisSettings();

      // Initial port scan (only meaningful for serial transport, but cheap)
      this._refreshTCodePorts(savedPort);
    }

    // Settings tab — language dropdown (Phase 4 of the i18n rollout)
    this._wireSettingsTab();

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
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = t('connection.btn.measuring');
        try {
          const latency = await this.autoblowManager.estimateLatency();
          display.textContent = `${latency}ms`;
          showToast(t('connection.autoblow.latencyToast', { ms: latency }), 'info', 2500);
        } catch (err) {
          showToast(t('connection.autoblow.latencyFailed', { error: err?.message || 'unknown error' }), 'error', 4000);
        } finally {
          btn.textContent = originalText;
          btn.disabled = false;
        }
      });

      this.autoblowManager.onConnect = () => this._updateAutoblowStatus('connected');
      this.autoblowManager.onDisconnect = () => this._updateAutoblowStatus('disconnected');
    }

    // VR Bridge UI + offset slider live in components/vr-modal.js now —
    // this panel stays focused on physical devices (Handy / Buttplug /
    // TCode / Autoblow). The bridge itself still runs; only the UI moved.
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
      this._showError(t('error.connectionKeyTooShort'));
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
    syncQuality.textContent = t('connection.handy.syncing');

    const result = await this.handy.syncTime();
    if (result) {
      syncQuality.textContent = t('connection.handy.rtdResult', { rtd: Math.round(result.avgRtd) });
      // Re-engage HSSP playback at the current video position. The SDK's
      // `.sync()` routine leaves the device in a state where the next
      // hsspStop / setScript can be ignored; the app then thinks
      // playback is being controlled but pause / next-video commands
      // never reach the device. Mirrors the auto-drift recovery in
      // sync-engine.js — same fix shape, manual trigger.
      if (this.onResyncComplete) {
        try {
          await this.onResyncComplete();
        } catch (err) {
          console.warn('[ConnectionPanel] onResyncComplete failed:', err?.message || err);
        }
      }
    } else {
      syncQuality.textContent = t('connection.handy.syncFailed');
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

    this._setTabLedState('handy', status);
    led.className = 'connection-panel__led';

    switch (status) {
      case 'connected':
        led.classList.add('connection-panel__led--connected');
        text.textContent = t('connection.status.connected');
        btn.textContent = t('connection.btn.disconnect');
        infoSection.hidden = false;
        syncSection.hidden = false;
        offsetSection.hidden = false;
        strokeSection.hidden = false;
        this._handyEverConnected = true;
        // Apply saved offset and stroke zone to device
        this._applySavedDeviceSettings();
        break;

      case 'connecting':
        led.classList.add('connection-panel__led--connecting');
        text.textContent = t('connection.status.connecting');
        btn.textContent = t('connection.status.connecting');
        btn.disabled = true;
        break;

      case 'error':
        led.classList.add('connection-panel__led--error');
        text.textContent = t('connection.status.failed');
        btn.textContent = t('connection.btn.connect');
        btn.disabled = false;
        break;

      case 'disconnected':
      default:
        // "Disconnected" only when the device was previously connected
        // in this session (real drop-out). On first launch / after error
        // we say "Not connected" — neutral, not failure framing.
        text.textContent = this._handyEverConnected ? t('connection.status.disconnected') : t('connection.status.notConnected');
        btn.textContent = t('connection.btn.connect');
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

  /**
   * Mirror per-tab connection state onto the tab button's LED dot and
   * aria-label. Lets the user see "Handy is connected, Buttplug is not"
   * across the whole tab strip without clicking through. The LED is
   * visual; the aria-label is the canonical semantic value for screen
   * readers (Norman signifier — text canonical, colour secondary).
   * @param {string} tabId — 'handy' | 'buttplug' | 'tcode' | 'autoblow'
   * @param {string} status — 'connected' | 'connecting' | 'error' | 'disconnected'
   */
  _setTabLedState(tabId, status) {
    if (!this._panel) return;
    const led = this._panel.querySelector(`[data-tab-led="${tabId}"]`);
    if (led) {
      led.className = 'connection-panel__tab-led';
      if (status === 'connected') led.classList.add('connection-panel__tab-led--connected');
      else if (status === 'connecting') led.classList.add('connection-panel__tab-led--connecting');
      else if (status === 'error') led.classList.add('connection-panel__tab-led--error');
    }
    const labels = {
      handy: 'Handy', buttplug: 'Buttplug.io',
      tcode: 'TCode', autoblow: 'Autoblow',
    };
    const stateMap = {
      connected: t('connection.status.connected'),
      connecting: t('connection.status.connecting'),
      error: t('connection.status.failed'),
      disconnected: t('connection.status.notConnected'),
    };
    const tabBtn = this._panel.querySelector(`#connection-panel__tab-btn-${tabId}`);
    if (tabBtn) {
      tabBtn.setAttribute('aria-label', `${labels[tabId] || tabId}: ${stateMap[status] || status}`);
    }
  }

  // --- Tab Switching ---

  _switchTab(tabId) {
    this._activeTab = tabId;

    // Update tab buttons: visual --active class + ARIA aria-selected +
    // roving tabindex (only the active tab is reachable via Tab; arrow
    // keys move within the tablist per WAI-ARIA APG).
    for (const tab of this._panel.querySelectorAll('.connection-panel__tab')) {
      const isActive = tab.dataset.tab === tabId;
      tab.classList.toggle('connection-panel__tab--active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.tabIndex = isActive ? 0 : -1;
    }

    this._panel.querySelector('#tab-handy').hidden = tabId !== 'handy';
    this._panel.querySelector('#tab-buttplug').hidden = tabId !== 'buttplug';
    this._panel.querySelector('#tab-tcode').hidden = tabId !== 'tcode';
    this._panel.querySelector('#tab-autoblow').hidden = tabId !== 'autoblow';
    this._panel.querySelector('#tab-sync').hidden = tabId !== 'sync';
    if (tabId === 'sync') this._refreshSyncTab();
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

    this._setTabLedState('buttplug', status);
    led.className = 'connection-panel__led';

    switch (status) {
      case 'connected':
        led.classList.add('connection-panel__led--connected');
        text.textContent = t('connection.status.connectedToIntiface');
        btn.textContent = t('connection.btn.disconnect');
        btn.disabled = false;
        deviceSection.hidden = false;
        this._buttplugEverConnected = true;
        this._updateButtplugDeviceList();
        break;

      case 'connecting':
        led.classList.add('connection-panel__led--connecting');
        text.textContent = t('connection.status.connecting');
        btn.textContent = t('connection.status.connecting');
        btn.disabled = true;
        break;

      case 'error':
        led.classList.add('connection-panel__led--error');
        text.textContent = t('connection.status.failedIntiface');
        btn.textContent = t('connection.btn.connect');
        btn.disabled = false;
        break;

      case 'disconnected':
      default:
        text.textContent = this._buttplugEverConnected ? t('connection.status.disconnected') : t('connection.status.notConnected');
        btn.textContent = t('connection.btn.connect');
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
      list.innerHTML = `<div class="connection-panel__no-devices" data-i18n="connection.buttplug.noDevices">${_esc(t('connection.buttplug.noDevices'))}</div>`;
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
      if (dev.canLinear) badges.appendChild(this._makeBadge(t('connection.buttplug.badgeLinear'), 'linear'));
      if (dev.canVibrate) badges.appendChild(this._makeBadge(t('connection.buttplug.badgeVibrate'), 'vibrate'));
      if (dev.canRotate) badges.appendChild(this._makeBadge(t('connection.buttplug.badgeRotate'), 'rotate'));
      if (dev.canScalar) badges.appendChild(this._makeBadge(t('connection.buttplug.badgeEstim'), 'estim'));
      header.appendChild(badges);

      const testBtn = document.createElement('button');
      testBtn.className = 'connection-panel__action connection-panel__action--utility connection-panel__device-test';
      testBtn.textContent = t('connection.btn.test');
      testBtn.title = t('connection.buttplug.testTitle');
      testBtn.addEventListener('click', () => this._testDevice(dev));
      header.appendChild(testBtn);

      row.appendChild(header);

      // Axis assignment
      const axisRow = document.createElement('div');
      axisRow.className = 'connection-panel__device-axis-row';
      const axisLabel = document.createElement('span');
      axisLabel.className = 'connection-panel__device-axis-label';
      axisLabel.textContent = t('connection.buttplug.source');
      const axisSelect = document.createElement('select');
      axisSelect.className = 'connection-panel__device-select';
      axisSelect.title = t('connection.buttplug.sourceTitle');

      // Per-device axis assignment dropdown. Labels follow "Name (Code)"
      // so the user can recognise both the friendly name AND the TCode
      // identifier they see elsewhere (TCode panel, library cards).
      // Previously L0 was labelled "Main Script" without the code,
      // breaking that recognition pattern.
      // TCode axis names (Surge/Sway/Twist/Roll/Pitch/Vibe/Lube/Pump/Suction/Valve)
      // are standard kinematics terminology in the funscript community across
      // every language — kept as English so users recognise the codes they see
      // in scripts/forums. Only the leading "Main / Stroke" portion of L0 is
      // translated since that's an app-specific framing.
      const axisOptions = [
        { value: 'L0', label: t('connection.buttplug.axisMainStroke') },
        { value: '__custom__', label: t('connection.buttplug.axisCustom') },
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
        controlsRow.appendChild(this._makeModeSelect(dev, 'vibe', t('connection.buttplug.vibrationModeTitle'), 'speed',
          () => this.buttplugSync?.getVibeMode(dev.index) || 'speed',
          (val) => { if (this.buttplugSync) this.buttplugSync.setVibeMode(dev.index, val); }
        ));
      }
      if (dev.canRotate) {
        controlsRow.appendChild(this._makeModeSelect(dev, 'rotate', t('connection.buttplug.rotationModeTitle'), 'speed',
          () => this.buttplugSync?.getRotateMode(dev.index) || 'speed',
          (val) => { if (this.buttplugSync) this.buttplugSync.setRotateMode(dev.index, val); }
        ));
      }
      if (dev.canScalar) {
        controlsRow.appendChild(this._makeModeSelect(dev, 'scalar', t('connection.buttplug.estimModeTitle'), 'position',
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
      invertLabel.appendChild(document.createTextNode(' ' + t('connection.buttplug.invert')));
      controlsRow.appendChild(invertLabel);

      // Info button
      if (dev.canVibrate || dev.canScalar || dev.canRotate) {
        const infoBtn = document.createElement('button');
        infoBtn.className = 'connection-panel__device-info-btn';
        infoBtn.title = t('connection.buttplug.modeHelp');
        infoBtn.appendChild(icon(Info, { width: 14, height: 14 }));
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showVibeModeHelp(infoBtn);
        });
        controlsRow.appendChild(infoBtn);
      }

      row.appendChild(controlsRow);

      // Per-device range — applies to every command type this device
      // supports (linear, vibrate, scalar, rotate). Mirrors the TCode
      // per-axis range pattern so users learn one control surface. The
      // dual slider's clamp logic prevents min >= max which would
      // collapse the range and freeze the device.
      const rangeRow = document.createElement('div');
      rangeRow.className = 'connection-panel__device-safety';
      const rangeMinLabel = document.createElement('span');
      rangeMinLabel.className = 'connection-panel__tcode-range-label';
      rangeMinLabel.textContent = t('connection.buttplug.rangeMin');
      const rangeMinSlider = document.createElement('input');
      rangeMinSlider.type = 'range';
      rangeMinSlider.min = '0';
      rangeMinSlider.max = '99';
      rangeMinSlider.className = 'connection-panel__safety-slider';
      rangeMinSlider.setAttribute('aria-label', t('connection.buttplug.rangeMinAria'));
      const rangeMaxLabel = document.createElement('span');
      rangeMaxLabel.className = 'connection-panel__tcode-range-label';
      rangeMaxLabel.textContent = t('connection.buttplug.rangeMax');
      const rangeMaxSlider = document.createElement('input');
      rangeMaxSlider.type = 'range';
      rangeMaxSlider.min = '1';
      rangeMaxSlider.max = '100';
      rangeMaxSlider.className = 'connection-panel__safety-slider';
      rangeMaxSlider.setAttribute('aria-label', t('connection.buttplug.rangeMaxAria'));
      const rangeReadout = document.createElement('span');
      rangeReadout.className = 'connection-panel__safety-value';

      const currentRange = this.buttplugSync?.getDeviceRange(dev.index) || { min: 0, max: 100 };
      rangeMinSlider.value = String(currentRange.min);
      rangeMaxSlider.value = String(currentRange.max);
      rangeReadout.textContent = `${currentRange.min}-${currentRange.max}%`;

      const commitRange = () => {
        let mn = parseInt(rangeMinSlider.value, 10);
        let mx = parseInt(rangeMaxSlider.value, 10);
        // Prevent collapsed range (min >= max). Same pattern as the
        // TCode per-axis range commit — push whichever slider isn't
        // being dragged out of the way.
        if (mn >= mx) {
          if (document.activeElement === rangeMinSlider) {
            mn = mx - 1;
            rangeMinSlider.value = String(mn);
          } else {
            mx = mn + 1;
            rangeMaxSlider.value = String(mx);
          }
        }
        rangeReadout.textContent = `${mn}-${mx}%`;
        if (this.buttplugSync) this.buttplugSync.setDeviceRange(dev.index, mn, mx);
        this._saveButtplugDeviceSettings();
      };
      rangeMinSlider.addEventListener('input', commitRange);
      rangeMaxSlider.addEventListener('input', commitRange);

      rangeRow.appendChild(rangeMinLabel);
      rangeRow.appendChild(rangeMinSlider);
      rangeRow.appendChild(rangeMaxLabel);
      rangeRow.appendChild(rangeMaxSlider);
      rangeRow.appendChild(rangeReadout);
      row.appendChild(rangeRow);

      // E-stim safety section (only for scalar devices)
      if (dev.canScalar) {
        const safetySection = document.createElement('div');
        safetySection.className = 'connection-panel__device-safety-section';

        const maxRow = document.createElement('div');
        maxRow.className = 'connection-panel__device-safety';
        const maxLabel = document.createElement('span');
        maxLabel.textContent = t('connection.buttplug.max');
        const maxVal = document.createElement('span');
        maxVal.className = 'connection-panel__safety-value';
        const currentMax = this.buttplugSync?.getMaxIntensity(dev.index) ?? 70;
        maxVal.textContent = `${currentMax}%`;
        if (currentMax >= 70) maxVal.classList.add('connection-panel__safety-value--warn');
        const maxSlider = document.createElement('input');
        maxSlider.type = 'range';
        maxSlider.min = '0';
        maxSlider.max = '100';
        maxSlider.value = String(currentMax);
        maxSlider.className = 'connection-panel__safety-slider';
        // Soft visual warn at ≥ 70 % — was 80 %, but for a safety-critical
        // control the user should see the heightened-risk threshold well
        // before the hard confirm at 90 % (Shneiderman #5 prevent errors).
        maxSlider.addEventListener('input', () => {
          const v = parseInt(maxSlider.value, 10);
          maxVal.textContent = `${v}%`;
          if (v >= 70) maxVal.classList.add('connection-panel__safety-value--warn');
          else maxVal.classList.remove('connection-panel__safety-value--warn');
        });
        maxSlider.addEventListener('change', async () => {
          const v = parseInt(maxSlider.value, 10);
          if (v > 90) {
            const { Modal } = await import('./modal.js');
            const confirmed = await Modal.confirm(
              t('connection.buttplug.highIntensityTitle'),
              t('connection.buttplug.highIntensityBody', { percent: v })
            );
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
        rampLabel.appendChild(document.createTextNode(' ' + t('connection.buttplug.rampUp')));
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
      { value: 'speed', label: t('connection.buttplug.modeSpeed') },
      { value: 'position', label: t('connection.buttplug.modePosition') },
      { value: 'intensity', label: t('connection.buttplug.modeHybrid') },
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
      // Don't persist CR-prefixed axes — those are synthetic identifiers
      // belonging to a specific video's custom routing, not a per-device
      // user choice. Persisting them would silently filter the device out
      // of the main-stroke loop on the NEXT video (since assigned !== 'L0').
      const isCustomRouteAxis = typeof axisAssignment === 'string' && axisAssignment.startsWith('CR');
      if (axisAssignment !== 'L0' && !isCustomRouteAxis) {
        settings.axisAssignment = axisAssignment;
      } else if (this.buttplugSync._customRoutingActive && this.buttplugSync._axisAssignmentMap.has(dev.index) && !isCustomRouteAxis) {
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
      // Per-device range: persist only if non-default. Keeps existing
      // user configs lean and means an absent `range` key reliably
      // means "no remap" rather than "missing or defaults".
      const range = this.buttplugSync.getDeviceRange(dev.index);
      if (range && (range.min !== 0 || range.max !== 100)) {
        settings.range = { min: range.min, max: range.max };
      }
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
        // Defensive: ignore stale CR-prefixed assignments that may have
        // been written before the save-side filter existed. Re-applying
        // a synthetic axis here would filter the device out of the main
        // loop on the current (possibly unrouted) video.
        //
        // ALSO skip when custom routing is active for the current video.
        // `_loadCustomRouting` has already called `setAxisAssignment` for
        // every routed device; applying a stale per-device axis here
        // (typically an `L0`/`L1` left over from an earlier multi-axis
        // session) would clobber the route's `CR1`/`CR2`/... assignment
        // and leave the second device in a 2+-device routing setup
        // silently unassigned. This is the "two-Handy custom routing
        // doesn't work for the second device" bug.
        if (
          saved.axisAssignment
          && !String(saved.axisAssignment).startsWith('CR')
          && !this.buttplugSync._customRoutingActive
        ) {
          this.buttplugSync.setAxisAssignment(dev.index, saved.axisAssignment);
        }
        if (saved.inverted) this.buttplugSync.setInverted(dev.index, true);
        if (saved.vibeMode) this.buttplugSync.setVibeMode(dev.index, saved.vibeMode);
        if (saved.scalarMode) this.buttplugSync.setScalarMode(dev.index, saved.scalarMode);
        if (saved.rotateMode) this.buttplugSync.setRotateMode(dev.index, saved.rotateMode);
        if (saved.maxIntensity !== undefined) this.buttplugSync.setMaxIntensity(dev.index, saved.maxIntensity);
        if (saved.rampUp === false) this.buttplugSync.setRampUp(dev.index, false);
        // Per-device range: only apply if both min and max are finite
        // numbers. Defensive against a malformed config where the field
        // exists but the values are NaN / strings / etc.
        if (saved.range
          && Number.isFinite(saved.range.min)
          && Number.isFinite(saved.range.max)) {
          this.buttplugSync.setDeviceRange(dev.index, saved.range.min, saved.range.max);
        }
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
      <div class="connection-panel__vibe-help-title">${t('connection.vibeHelp.title')}</div>
      <div class="connection-panel__vibe-help-section">${t('connection.vibeHelp.speed')}</div>
      <div class="connection-panel__vibe-help-section">${t('connection.vibeHelp.position')}</div>
      <div class="connection-panel__vibe-help-section">${t('connection.vibeHelp.hybrid')}</div>
      <div class="connection-panel__vibe-help-section" style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.1);padding-top:6px;">${t('connection.vibeHelp.invert')}</div>
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

  // --- Settings tab (Phase 4 of i18n rollout) ---

  /**
   * Populate the language dropdown and wire its change handler. Called
   * once during constructor wiring; the dropdown content is the
   * SUPPORTED_LOCALES list with each locale displayed in its OWN script
   * (so a Chinese user sees "中文" rather than "Chinese") — Norman:
   * speak the user's language.
   *
   * On change: setLocale → translatePage → persist → toast confirmation.
   */
  _wireSettingsTab() {
    const select = this._panel?.querySelector('#settings-language-select');
    if (!select) return;
    // Defensive: clear any pre-existing options (in case the panel is
    // rebuilt during a hot reload).
    select.innerHTML = '';
    for (const code of SUPPORTED_LOCALES) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = LOCALE_LABELS[code] || code;
      select.appendChild(opt);
    }
    select.value = getCurrentLocale();
    select.addEventListener('change', async () => {
      const next = select.value;
      await setLocale(next);
      translatePage(document);
      this.settings.set('player.language', next);
      // Mark the offer-toast as already shown for this locale — flipping
      // via the dropdown is an explicit acceptance.
      this.settings.set('player._localeOfferedFor', next);
      const langName = LOCALE_LABELS[next] || next;
      const { showToast } = await import('../js/toast.js');
      showToast(t('i18n.switched', { language: langName }), 'success', 2000);
    });
  }

  // --- TCode (serial / UDP / WebSocket) ---

  /**
   * Show only the input fields relevant to the selected transport. Pure
   * UI concern — no state writes. Wired to the #tcode-transport-select
   * change event in _bindEvents.
   */
  _onTCodeTransportChange() {
    const kind = this._panel.querySelector('#tcode-transport-select')?.value || 'serial';
    const serial = this._panel.querySelector('#tcode-serial-fields');
    const udp = this._panel.querySelector('#tcode-udp-fields');
    const ws = this._panel.querySelector('#tcode-ws-fields');
    if (serial) serial.hidden = kind !== 'serial';
    if (udp) udp.hidden = kind !== 'udp';
    if (ws) ws.hidden = kind !== 'websocket';
  }

  async _onTCodeConnect() {
    if (!this.tcodeManager) return;

    if (this.tcodeManager.connected) {
      await this.tcodeManager.disconnect();
      this._updateTCodeStatus('disconnected');
      return;
    }

    const kind = this._panel.querySelector('#tcode-transport-select')?.value || 'serial';
    const text = this._panel.querySelector('#tcode-status-text');

    let opts;
    if (kind === 'serial') {
      const portSelect = this._panel.querySelector('#tcode-port-select');
      const baudSelect = this._panel.querySelector('#tcode-baud-select');
      const portPath = portSelect?.value || '';
      const baudRate = parseInt(baudSelect?.value, 10) || 115200;
      if (!portPath) {
        this._updateTCodeStatus('disconnected');
        if (text) text.textContent = t('connection.tcode.errSelectPort');
        return;
      }
      opts = { path: portPath, baudRate };
    } else if (kind === 'udp') {
      const host = this._panel.querySelector('#tcode-udp-host')?.value.trim() || '';
      const port = parseInt(this._panel.querySelector('#tcode-udp-port')?.value, 10);
      if (!host) {
        this._updateTCodeStatus('disconnected');
        if (text) text.textContent = t('connection.tcode.errEnterHost');
        return;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this._updateTCodeStatus('disconnected');
        if (text) text.textContent = t('connection.tcode.errInvalidPort');
        return;
      }
      opts = { host, port };
    } else if (kind === 'websocket') {
      const url = this._panel.querySelector('#tcode-ws-url')?.value.trim() || '';
      if (!/^wss?:\/\//.test(url)) {
        this._updateTCodeStatus('disconnected');
        if (text) text.textContent = t('connection.tcode.errInvalidUrl');
        return;
      }
      opts = { url };
    } else {
      return;
    }

    this._updateTCodeStatus('connecting');
    const success = await this.tcodeManager.connect(kind, opts);

    if (success) {
      // Persist per-transport so the next launch restores the right inputs.
      this.settings.set('tcode.transport', kind);
      if (kind === 'serial') {
        this.settings.set('tcode.port', opts.path);
        this.settings.set('tcode.baudRate', opts.baudRate);
      } else if (kind === 'udp') {
        this.settings.set('tcode.udpHost', opts.host);
        this.settings.set('tcode.udpPort', opts.port);
      } else if (kind === 'websocket') {
        this.settings.set('tcode.wsUrl', opts.url);
      }
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
      opt.textContent = t('connection.tcode.noPorts');
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

    this._setTabLedState('tcode', status);
    if (led) {
      led.className = 'connection-panel__led';
      if (status === 'connected') led.classList.add('connection-panel__led--connected');
      else if (status === 'connecting') led.classList.add('connection-panel__led--connecting');
    }
    if (status === 'connected') this._tcodeEverConnected = true;
    if (text) {
      text.textContent = status === 'connected' ? t('connection.status.connected')
        : status === 'connecting' ? t('connection.status.connecting')
        : (this._tcodeEverConnected ? t('connection.status.disconnected') : t('connection.status.notConnected'));
    }
    if (btn) {
      btn.textContent = status === 'connected' ? t('connection.btn.disconnect') : t('connection.btn.connect');
    }
    if (axisSection) {
      axisSection.hidden = status !== 'connected';
      if (status === 'connected') this._renderTCodeAxes();
    }
  }

  /**
   * Read saved `tcode.axes` settings and push each axis's enabled/range into
   * tcodeSync so the engine applies them regardless of whether the panel has
   * been opened. Safe to call multiple times — setAxisRange/setAxisEnabled
   * are idempotent.
   */
  _applyTCodeAxisSettings() {
    if (!this.tcodeSync) return;
    const saved = this.settings.get('tcode.axes') || {};
    for (const { tcode } of TCODE_UI_AXES) {
      const cfg = saved[tcode] || {};
      const enabled = cfg.enabled !== false;  // default on
      const min = Number.isFinite(cfg.min) ? cfg.min : 0;
      const max = Number.isFinite(cfg.max) ? cfg.max : 100;
      const inverted = cfg.inverted === true;  // default false; missing → false
      this.tcodeSync.setAxisEnabled(tcode, enabled);
      this.tcodeSync.setAxisRange(tcode, min, max);
      this.tcodeSync.setAxisInverted(tcode, inverted);
    }
  }

  /**
   * Render the per-axis enable + min/max range controls into #tcode-axis-list.
   * Idempotent — clears the container first, so it's safe to call on every
   * connect. Values reflect saved settings; edits persist immediately and push
   * through to tcodeSync so live playback reflects the new range.
   */
  _renderTCodeAxes() {
    const list = this._panel.querySelector('#tcode-axis-list');
    if (!list) return;

    list.replaceChildren();
    const saved = this.settings.get('tcode.axes') || {};

    for (const axisDef of TCODE_UI_AXES) {
      const { tcode, type } = axisDef;
      const label = axisDef.labelKey ? t(axisDef.labelKey) : axisDef.label;
      const cfg = saved[tcode] || {};
      const enabled = cfg.enabled !== false;
      const min = Number.isFinite(cfg.min) ? cfg.min : 0;
      const max = Number.isFinite(cfg.max) ? cfg.max : 100;
      const inverted = cfg.inverted === true;

      const row = document.createElement('div');
      row.className = 'connection-panel__tcode-axis-row';
      row.dataset.axis = tcode;
      if (!enabled) row.classList.add('connection-panel__tcode-axis-row--disabled');

      // Header: enable toggle + axis code + human label + type pill
      const head = document.createElement('div');
      head.className = 'connection-panel__tcode-axis-head';

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'connection-panel__device-toggle';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = enabled;
      toggleLabel.appendChild(toggle);
      const codeSpan = document.createElement('span');
      codeSpan.className = 'connection-panel__tcode-axis-code';
      codeSpan.textContent = tcode;
      toggleLabel.appendChild(codeSpan);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'connection-panel__tcode-axis-label';
      labelSpan.textContent = label;
      toggleLabel.appendChild(labelSpan);
      head.appendChild(toggleLabel);

      const typePill = document.createElement('span');
      typePill.className = `connection-panel__tcode-axis-type connection-panel__tcode-axis-type--${type}`;
      typePill.textContent = t(`connection.tcode.type.${type}`);
      head.appendChild(typePill);

      // Per-axis invert checkbox — sits in the header next to the type
      // pill, parallel to the Buttplug per-device invert pattern. Common
      // use: physically mounted OSR2/SR6 where one rotation axis reads
      // reversed due to mount orientation. Affects only the current
      // axis's value stream; other axes are independent.
      const invertLabel = document.createElement('label');
      invertLabel.className = 'connection-panel__device-toggle connection-panel__tcode-axis-invert';
      const invertCheck = document.createElement('input');
      invertCheck.type = 'checkbox';
      invertCheck.checked = inverted;
      if (!enabled) invertCheck.disabled = true;
      invertLabel.appendChild(invertCheck);
      invertLabel.appendChild(document.createTextNode(' ' + t('connection.tcode.invert')));
      head.appendChild(invertLabel);

      row.appendChild(head);

      // Range: min slider + max slider + live readout
      const rangeRow = document.createElement('div');
      rangeRow.className = 'connection-panel__device-safety';

      const minLabel = document.createElement('span');
      minLabel.textContent = t('connection.tcode.min');
      minLabel.className = 'connection-panel__tcode-range-label';
      const minSlider = document.createElement('input');
      minSlider.type = 'range';
      minSlider.min = '0';
      minSlider.max = '99';
      minSlider.value = String(min);
      minSlider.className = 'connection-panel__safety-slider';
      if (!enabled) minSlider.disabled = true;

      const maxLabel = document.createElement('span');
      maxLabel.textContent = t('connection.tcode.max');
      maxLabel.className = 'connection-panel__tcode-range-label';
      const maxSlider = document.createElement('input');
      maxSlider.type = 'range';
      maxSlider.min = '1';
      maxSlider.max = '100';
      maxSlider.value = String(max);
      maxSlider.className = 'connection-panel__safety-slider';
      if (!enabled) maxSlider.disabled = true;

      const valReadout = document.createElement('span');
      valReadout.className = 'connection-panel__safety-value';
      valReadout.textContent = `${min}-${max}%`;

      const commit = () => {
        let mn = parseInt(minSlider.value, 10);
        let mx = parseInt(maxSlider.value, 10);
        // Clamp so min < max (prevents collapsed range that would freeze the axis)
        if (mn >= mx) {
          if (document.activeElement === minSlider) {
            mn = mx - 1;
            minSlider.value = String(mn);
          } else {
            mx = mn + 1;
            maxSlider.value = String(mx);
          }
        }
        valReadout.textContent = `${mn}-${mx}%`;
        if (this.tcodeSync) this.tcodeSync.setAxisRange(tcode, mn, mx);
        this._saveTCodeAxis(tcode, {
          enabled: toggle.checked,
          min: mn,
          max: mx,
          inverted: invertCheck.checked,
        });
      };
      minSlider.addEventListener('input', commit);
      maxSlider.addEventListener('input', commit);

      toggle.addEventListener('change', () => {
        const on = toggle.checked;
        minSlider.disabled = !on;
        maxSlider.disabled = !on;
        invertCheck.disabled = !on;
        row.classList.toggle('connection-panel__tcode-axis-row--disabled', !on);
        if (this.tcodeSync) this.tcodeSync.setAxisEnabled(tcode, on);
        this._saveTCodeAxis(tcode, {
          enabled: on,
          min: parseInt(minSlider.value, 10),
          max: parseInt(maxSlider.value, 10),
          inverted: invertCheck.checked,
        });
      });

      invertCheck.addEventListener('change', () => {
        if (this.tcodeSync) this.tcodeSync.setAxisInverted(tcode, invertCheck.checked);
        this._saveTCodeAxis(tcode, {
          enabled: toggle.checked,
          min: parseInt(minSlider.value, 10),
          max: parseInt(maxSlider.value, 10),
          inverted: invertCheck.checked,
        });
      });

      rangeRow.appendChild(minLabel);
      rangeRow.appendChild(minSlider);
      rangeRow.appendChild(maxLabel);
      rangeRow.appendChild(maxSlider);
      rangeRow.appendChild(valReadout);
      row.appendChild(rangeRow);

      list.appendChild(row);
    }
  }

  _saveTCodeAxis(tcode, cfg) {
    const all = { ...(this.settings.get('tcode.axes') || {}) };
    all[tcode] = cfg;
    this.settings.set('tcode.axes', all);
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
      if (text) text.textContent = t('connection.autoblow.errEnterToken');
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

    this._setTabLedState('autoblow', status);
    if (led) {
      led.className = 'connection-panel__led';
      if (status === 'connected') led.classList.add('connection-panel__led--connected');
      else if (status === 'connecting') led.classList.add('connection-panel__led--connecting');
    }
    if (status === 'connected') this._autoblowEverConnected = true;
    if (text) {
      text.textContent = status === 'connected' ? t('connection.status.connected')
        : status === 'connecting' ? t('connection.status.connecting')
        : (this._autoblowEverConnected ? t('connection.status.disconnected') : t('connection.status.notConnected'));
    }
    if (btn) {
      btn.textContent = status === 'connected' ? t('connection.btn.disconnect') : t('connection.btn.connect');
    }
    if (infoSection) {
      infoSection.hidden = status !== 'connected';
    }
    if (typeEl && this.autoblowManager?.deviceType) {
      typeEl.textContent = this.autoblowManager.isUltra ? t('connection.autoblow.deviceUltra') : t('connection.autoblow.deviceVacu2');
    }
  }

  // VR Bridge UI is now in components/vr-modal.js. The panel still
  // accepts `vrBridge` in the constructor but doesn't own any UI for it.

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

    // Stash the previously-focused element so we can restore on hide.
    // Modal contract per DESIGN.md §2.5 — focus trap on Tab/Shift+Tab,
    // Escape close, focus restored on close. Outside-click close is
    // preserved (was the only dismissal path before this contract).
    this._previouslyFocused = document.activeElement;

    // Initial focus — prefer the connection-key input on the active
    // tab; fall back to the active tab button if it's hidden.
    const initialFocus = this._panel.querySelector('#connection-key-input')
      || this._panel.querySelector('.connection-panel__tab--active');
    initialFocus?.focus();

    // Focus trap — Tab cycles within the panel.
    this._boundFocusTrap = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = this._panel.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(el => el.offsetParent !== null);
      if (visible.length === 0) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    this._panel.addEventListener('keydown', this._boundFocusTrap);

    // Escape closes — third dismissal path alongside backdrop click and
    // the X button. DESIGN.md §2.5 contract: three exit paths.
    this._boundEscapeKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    };
    this._panel.addEventListener('keydown', this._boundEscapeKey);

    // Outside-click close (preserved from prior implementation).
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
    if (this._boundFocusTrap) {
      this._panel.removeEventListener('keydown', this._boundFocusTrap);
      this._boundFocusTrap = null;
    }
    if (this._boundEscapeKey) {
      this._panel.removeEventListener('keydown', this._boundEscapeKey);
      this._boundEscapeKey = null;
    }
    if (this._vibeHelpCloseHandler) {
      document.removeEventListener('click', this._vibeHelpCloseHandler);
      this._vibeHelpCloseHandler = null;
    }
    // Remove any open tooltips
    this._panel.querySelector('.connection-panel__vibe-help')?.remove();
    // Restore focus to whatever owned it before show() (Modal contract).
    if (this._previouslyFocused && typeof this._previouslyFocused.focus === 'function') {
      this._previouslyFocused.focus();
    }
    this._previouslyFocused = null;
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
      note.textContent = t('connection.buttplug.vibScriptOverride');
      const deviceList = this._panel.querySelector('.connection-panel__device-list');
      if (deviceList) {
        deviceList.parentElement.appendChild(note);
      }
    } else if (!hasVibScript && existingNote) {
      existingNote.remove();
    }
  }

  // ===== Sync tab — auto-offset diagnostic + per-device offsets =====

  /**
   * Repaint the Sync tab from current latency measurements + per-device
   * offset state. Called when the tab opens and on Refresh button click.
   */
  _refreshSyncTab() {
    if (!this._panel) return;

    // 1) Latency readouts
    const jitter = this.vrBridge?.getNetworkJitterMs?.();
    const handyRtd = this.handy?.syncQuality?.avgRtd
      ?? this.handy?._syncQuality?.avgRtd
      ?? null;
    const transport = jitter != null ? classifyTransport(jitter) : null;

    const set = (id, txt) => {
      const el = this._panel.querySelector(id);
      if (el) el.textContent = txt;
    };
    set('#sync-vr-jitter', jitter != null ? `${jitter} ms` : t('connection.sync.noVrSession'));
    set('#sync-handy-rtd', handyRtd != null ? `${Math.round(handyRtd)} ms` : t('connection.sync.handyNotConnected'));
    set('#sync-vr-transport', transport ?? '—');

    // 2) Per-device offset rows
    const rowsEl = this._panel.querySelector('#sync-device-rows');
    if (!rowsEl) return;
    rowsEl.innerHTML = '';

    const ctx = this.vrBridge?.connected ? 'vr' : 'desktop';
    const vrPlayerType = this.vrBridge?._playerType || null;
    // When VR is driving playback, the VR proxy applies `vr.offset`
    // BEFORE each sync engine reads currentTime, so the per-device
    // offset stacks on top. Pass it into each row so the user sees the
    // total effective fire-time instead of only their device slider.
    // Outside VR the proxy isn't in the pipeline — pass 0 so the row
    // hides the stacking hint.
    const vrOffsetMs = this.vrBridge?.connected
      ? (this.settings.get('vr.offset') || 0)
      : 0;

    // Handy device row (only meaningful when Handy is connected via WiFi API)
    if (this.handy?.connected) {
      const suggested = computeSuggestedOffset({
        device: 'handy', context: ctx,
        handyRtdMs: handyRtd ?? 0,
        vrJitterMs: jitter ?? 0,
        vrPlayerType,
      });
      rowsEl.appendChild(this._buildSyncRow({
        label: t('connection.sync.deviceHandy'),
        currentMs: this.settings.get('handy.defaultOffset') || 0,
        suggestedMs: suggested,
        vrOffsetMs,
        onChange: async (v) => {
          this.settings.set('handy.defaultOffset', v);
          this.settings.set('handy.defaultOffsetSource', 'user');
          if (this.handy.connected) await this.handy.setOffset(v);
        },
        onApply: async (v) => {
          this.settings.set('handy.defaultOffset', v);
          this.settings.set('handy.defaultOffsetSource', 'user');
          if (this.handy.connected) await this.handy.setOffset(v);
          this._refreshSyncTab();
        },
      }));
    }

    // Buttplug device row (single global offset for all Intiface devices)
    if (this.buttplug?.connected) {
      const suggested = computeSuggestedOffset({
        device: 'buttplug', context: ctx,
        // No real BLE-RTT measurement yet — use the device preset as the
        // baseline component so the suggestion still moves with VR
        // jitter + display-lag changes.
        buttplugPingMs: Math.abs(DEVICE_OFFSET_PRESETS.buttplug) * 2,
        vrJitterMs: jitter ?? 0,
        vrPlayerType,
      });
      rowsEl.appendChild(this._buildSyncRow({
        label: t('connection.sync.deviceButtplug'),
        currentMs: this.settings.get('buttplug.defaultOffset') || 0,
        suggestedMs: suggested,
        vrOffsetMs,
        onChange: (v) => {
          this.settings.set('buttplug.defaultOffset', v);
          this.settings.set('buttplug.defaultOffsetSource', 'user');
          if (this.buttplugSync) this.buttplugSync.setOffsetMs(v);
        },
        onApply: (v) => {
          this.settings.set('buttplug.defaultOffset', v);
          this.settings.set('buttplug.defaultOffsetSource', 'user');
          if (this.buttplugSync) this.buttplugSync.setOffsetMs(v);
          this._refreshSyncTab();
        },
      }));
    }

    // TCode device row
    if (this.tcodeManager?.connected) {
      const suggested = computeSuggestedOffset({
        device: 'tcode', context: ctx,
        // TCode is serial so device-side latency is negligible. Suggested
        // value is dominated by VR display lag (when in VR).
        vrJitterMs: jitter ?? 0,
        vrPlayerType,
      });
      rowsEl.appendChild(this._buildSyncRow({
        label: t('connection.sync.deviceTcode'),
        currentMs: this.settings.get('tcode.defaultOffset') || 0,
        suggestedMs: suggested,
        vrOffsetMs,
        onChange: (v) => {
          this.settings.set('tcode.defaultOffset', v);
          this.settings.set('tcode.defaultOffsetSource', 'user');
          if (this.tcodeSync) this.tcodeSync.setOffsetMs(v);
        },
        onApply: (v) => {
          this.settings.set('tcode.defaultOffset', v);
          this.settings.set('tcode.defaultOffsetSource', 'user');
          if (this.tcodeSync) this.tcodeSync.setOffsetMs(v);
          this._refreshSyncTab();
        },
      }));
    }

    if (rowsEl.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'connection-panel__hint';
      empty.style.cssText = 'padding:12px;text-align:center;opacity:0.6';
      empty.textContent = t('connection.sync.connectDeviceHint');
      rowsEl.appendChild(empty);
    }

    // Wire the Refresh button (idempotent — replaceWith strips old listeners)
    const refreshBtn = this._panel.querySelector('#sync-refresh-btn');
    if (refreshBtn && !refreshBtn._wired) {
      refreshBtn._wired = true;
      refreshBtn.addEventListener('click', async () => {
        const originalText = refreshBtn.textContent;
        refreshBtn.disabled = true;
        refreshBtn.textContent = t('connection.btn.refreshing');
        try {
          // Re-measure Handy RTD; the SDK's measurement cycle returns a
          // refreshed avgRtd. Rest is read fresh on every paint.
          if (this.handy?.connected && this.handy.syncTime) {
            await this.handy.syncTime(10);
          }
          this._refreshSyncTab();
          showToast(t('connection.sync.latencyRefreshed'), 'info', 2000);
        } catch (err) {
          showToast(t('connection.sync.refreshFailed', { error: err?.message || 'unknown error' }), 'error', 4000);
        } finally {
          refreshBtn.textContent = originalText;
          refreshBtn.disabled = false;
        }
      });
    }
  }

  /**
   * Build one device's offset control row: label, current value, suggested
   * value with Apply button, and the slider for live tuning. Centralised
   * so adding a new device type is just one more call site.
   */
  _buildSyncRow({ label, currentMs, suggestedMs, onChange, onApply, vrOffsetMs }) {
    const row = document.createElement('div');
    row.className = 'connection-panel__section';
    row.style.cssText = 'padding:10px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;margin-bottom:8px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';
    const labelEl = document.createElement('span');
    labelEl.style.cssText = 'font-size:12px;font-weight:600';
    labelEl.textContent = label;
    const valEl = document.createElement('span');
    valEl.style.cssText = 'font-size:11px;opacity:0.7';
    valEl.textContent = `${currentMs} ms`;
    head.appendChild(labelEl);
    head.appendChild(valEl);
    row.appendChild(head);

    // "Total effective" hint — only when VR is driving playback. The VR
    // proxy offset and the per-device offset stack additively, which is
    // correct per the auto-offset formula but easy to miss when tuning.
    // Surface the stacked total so users don't double-compensate.
    const fmt = (ms) => (ms >= 0 ? `+${ms}` : `${ms}`);
    let totalEl = null;
    if (Number.isFinite(vrOffsetMs) && vrOffsetMs !== 0) {
      totalEl = document.createElement('div');
      totalEl.className = 'connection-panel__sync-row-total';
      totalEl.style.cssText = 'font-size:11px;opacity:0.6;margin-bottom:6px';
      const total = currentMs + vrOffsetMs;
      totalEl.textContent = t('connection.sync.vrModeTotal', { device: fmt(currentMs), vr: fmt(vrOffsetMs), total: fmt(total) });
      row.appendChild(totalEl);
    }

    // Suggested + Apply
    const sugRow = document.createElement('div');
    sugRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px';
    const sugTxt = document.createElement('span');
    sugTxt.style.opacity = '0.7';
    sugTxt.textContent = t('connection.sync.suggested', { ms: suggestedMs });
    const applyBtn = document.createElement('button');
    applyBtn.className = 'connection-panel__action connection-panel__action--utility';
    applyBtn.textContent = t('connection.btn.apply');
    applyBtn.disabled = currentMs === suggestedMs;
    applyBtn.addEventListener('click', () => onApply(suggestedMs));
    sugRow.appendChild(sugTxt);
    sugRow.appendChild(applyBtn);
    row.appendChild(sugRow);

    // Slider
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-1000'; slider.max = '1000'; slider.step = '10';
    slider.value = String(currentMs);
    slider.style.width = '100%';
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10) || 0;
      valEl.textContent = `${v} ms`;
      if (totalEl) {
        const total = v + vrOffsetMs;
        totalEl.textContent = t('connection.sync.vrModeTotal', { device: fmt(v), vr: fmt(vrOffsetMs), total: fmt(total) });
      }
    });
    slider.addEventListener('change', () => {
      const v = parseInt(slider.value, 10) || 0;
      onChange(v);
      // Also disable Apply when slider matches suggested.
      applyBtn.disabled = v === suggestedMs;
    });
    row.appendChild(slider);

    return row;
  }
}

/** Escape HTML special characters. */
function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
