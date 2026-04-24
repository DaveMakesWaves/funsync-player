// VRModal — dedicated modal for VR server + PCVR-companion setup.
//
// Was previously a tab inside the connection panel. Split out so the
// panel stays focused on physical devices (Handy / Buttplug / TCode /
// Autoblow) while "network surfaces" (web remote, VR) live behind their
// own toolbar buttons. Same pattern as web-remote-modal.js.
//
// The VRBridge state is the source of truth — this modal just renders
// against it and wires the connect/disconnect button. Callbacks fire
// regardless of whether the modal is open, so the toolbar's
// connected-state indicator stays accurate.

import { Modal } from './modal.js';

/**
 * @param {object} opts
 * @param {import('../js/data-service.js').DataService|object} opts.settings
 * @param {import('../js/vr-bridge.js').VRBridge} opts.vrBridge
 */
export async function openVRModal({ settings, vrBridge } = {}) {
  if (!vrBridge) return;
  const port = settings?.get?.('backend.port') || 5123;

  await Modal.open({
    title: 'VR',
    onRender: (body, close) => {
      const wrap = document.createElement('div');
      wrap.className = 'vr-modal';
      wrap.innerHTML = _template();
      body.appendChild(wrap);

      _wire(wrap, { settings, vrBridge, port });

      // Modal doesn't have an onClose hook, so intercept the DOM removal
      // via a MutationObserver on the overlay — fires once when the modal
      // is torn down and runs our cleanup. Cheap, self-terminating.
      const overlay = body.closest('.modal-overlay');
      if (overlay) {
        const obs = new MutationObserver(() => {
          if (!document.body.contains(overlay)) {
            if (vrBridge.__vrModalCleanup) {
              vrBridge.__vrModalCleanup();
              delete vrBridge.__vrModalCleanup;
            }
            obs.disconnect();
          }
        });
        obs.observe(document.body, { childList: true });
      }
    },
  });
}


function _template() {
  return `
    <div class="connection-panel__section" style="padding:8px 12px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:10px">
      <span style="font-weight:600;color:#ffc107;font-size:11px;letter-spacing:0.5px">EXPERIMENTAL</span>
      <span style="font-size:11px;opacity:0.85;margin-left:6px">VR streaming + companion sync are still being tuned. Expect rough edges around reconnection, sync timing, and player-specific quirks.</span>
    </div>

    <!-- VR Server Mode (Quest standalone) -->
    <div class="connection-panel__section">
      <label class="connection-panel__section-label">VR Server (Quest)</label>
      <div class="connection-panel__vr-help-note" style="margin-bottom:8px">
        Stream your library to HereSphere on Quest. No file transfers needed.
      </div>
      <div class="connection-panel__setting-row" style="align-items:center">
        <span class="connection-panel__setting-label">HereSphere URL</span>
        <input type="text" id="vr-server-hs-url" class="connection-panel__input" readonly style="flex:1;font-size:11px;cursor:text">
        <button id="vr-setup-info-btn" class="connection-panel__btn" style="min-width:auto;padding:2px 6px;margin-left:4px;font-size:13px;line-height:1" title="Setup guide">i</button>
      </div>

      <div id="vr-setup-info" hidden style="margin-top:8px;padding:8px 10px;background:rgba(124,77,255,0.08);border:1px solid rgba(124,77,255,0.2);border-radius:6px;font-size:11px;line-height:1.5">
        <div style="font-weight:600;margin-bottom:6px;color:#b388ff">HereSphere Setup Guide</div>
        <div style="margin-bottom:6px"><strong>First time setup:</strong></div>
        <div style="padding-left:8px;margin-bottom:4px">1. Open HereSphere on your Quest</div>
        <div style="padding-left:8px;margin-bottom:4px">2. Go to <strong>Settings &gt; External Server</strong></div>
        <div style="padding-left:8px;margin-bottom:4px">3. Paste the URL above and save</div>
        <div style="padding-left:8px;margin-bottom:8px">4. Your library will appear in the HereSphere home screen</div>

        <div style="margin-bottom:6px"><strong>For device sync (Handy, Buttplug, etc.):</strong></div>
        <div style="padding-left:8px;margin-bottom:4px">1. In HereSphere, go to <strong>Settings &gt; Timestamp Server</strong></div>
        <div style="padding-left:8px;margin-bottom:4px">2. <strong>Enable the timestamp server</strong> — this must be on for FunSync to sync devices</div>
        <div style="padding-left:8px;margin-bottom:8px">3. FunSync will auto-detect your Quest and connect when you play a video</div>

        <div style="margin-bottom:6px"><strong>Troubleshooting:</strong></div>
        <div style="padding-left:8px;margin-bottom:4px">- <strong>No videos showing?</strong> Make sure FunSync is open with at least one source added</div>
        <div style="padding-left:8px;margin-bottom:4px">- <strong>Devices not syncing?</strong> Check that the timestamp server is enabled (it resets each session)</div>
        <div style="padding-left:8px;margin-bottom:4px">- <strong>Can't connect?</strong> Ensure your Quest and PC are on the same Wi-Fi network</div>
        <div style="padding-left:8px;margin-bottom:4px">- <strong>VPN active?</strong> Disable VPN — it changes your network IP and blocks local connections</div>
        <div style="padding-left:8px;margin-bottom:4px">- <strong>Video looks wrong?</strong> Adjust projection mode in HereSphere (SBS, fisheye, etc.)</div>
      </div>
    </div>

    <div class="connection-panel__vr-divider"></div>

    <!-- PCVR Companion Mode -->
    <div class="connection-panel__section">
      <label class="connection-panel__section-label">PCVR Companion</label>
      <div class="connection-panel__vr-help-note" style="margin-bottom:8px">
        Sync devices with a VR player running on this PC or Quest.
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
          <input type="text" id="vr-host-input" class="connection-panel__input" placeholder="127.0.0.1" aria-label="Host" style="flex:1">
          <button id="vr-connect-btn" class="connection-panel__btn">Connect</button>
        </div>
        <div class="connection-panel__vr-help-note" style="margin-top:6px;font-size:10px;opacity:0.7">
          Tip: leave the host field with your Quest's IP — FunSync will remember it and auto-reconnect next launch.
        </div>
      </div>

      <div id="vr-now-playing" class="connection-panel__section" hidden style="margin-top:8px">
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Playing</span>
          <span id="vr-video-name" class="connection-panel__setting-value" style="font-size:11px;word-break:break-all">—</span>
        </div>
        <div class="connection-panel__setting-row">
          <span class="connection-panel__setting-label">Offset</span>
          <input type="range" id="vr-offset" min="-1000" max="1000" value="0" class="connection-panel__safety-slider" style="flex:1">
          <span id="vr-offset-value" class="connection-panel__setting-value" style="min-width:40px;text-align:right">0ms</span>
        </div>
        <div class="connection-panel__hint" style="margin-top:4px">
          Compensates VR display lag. Stacks on top of each device's own offset — see the Sync tab for the combined effective value per device.
        </div>
      </div>
    </div>
  `;
}


function _wire(root, { settings, vrBridge, port }) {
  // Populate server URL
  _loadServerUrl(root, port);

  // Setup guide toggle
  const infoBtn = root.querySelector('#vr-setup-info-btn');
  const infoPanel = root.querySelector('#vr-setup-info');
  if (infoBtn && infoPanel) {
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      infoPanel.hidden = !infoPanel.hidden;
      infoBtn.style.background = infoPanel.hidden ? '' : 'rgba(124,77,255,0.3)';
    });
  }

  // PCVR companion form
  const playerSelect = root.querySelector('#vr-player-select');
  const hostInput = root.querySelector('#vr-host-input');
  const connectBtn = root.querySelector('#vr-connect-btn');
  const statusText = root.querySelector('#vr-status-text');
  const led = root.querySelector('#vr-led');
  const nowPlaying = root.querySelector('#vr-now-playing');
  const videoName = root.querySelector('#vr-video-name');
  const offsetSlider = root.querySelector('#vr-offset');
  const offsetValue = root.querySelector('#vr-offset-value');

  const paintStatus = (status, detail) => {
    led.className = 'connection-panel__led';
    if (status === 'connected') led.classList.add('connection-panel__led--connected');
    else if (status === 'connecting' || status === 'reconnecting') {
      led.classList.add('connection-panel__led--connecting');
    }

    let text;
    if (status === 'connected') text = `Connected${detail ? ` (${detail})` : ''}`;
    else if (status === 'connecting') text = 'Connecting...';
    else if (status === 'reconnecting') text = detail ? `Reconnecting... (attempt ${detail})` : 'Reconnecting...';
    else text = 'Disconnected';
    statusText.textContent = text;

    connectBtn.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    nowPlaying.hidden = status !== 'connected';
  };

  // Poll the bridge's internal state while the modal is open so the
  // "Reconnecting... (attempt N)" readout stays current. The bridge
  // doesn't emit events during backoff retries, and polling every 1s is
  // cheap — the modal's lifetime is short.
  const pollStatus = () => {
    if (vrBridge.connected) {
      paintStatus('connected', vrBridge._host);
    } else if (vrBridge._reconnecting || vrBridge._reconnectTimer) {
      paintStatus('reconnecting', vrBridge._reconnectAttempts);
    } else {
      paintStatus('disconnected');
    }
  };
  const statusPollId = setInterval(pollStatus, 1000);

  // Pre-fill host + player type from the last successful session so the
  // user isn't typing their Quest IP every time. Falls back to the
  // currently-connected bridge (if any), then 127.0.0.1.
  const savedHost = settings.get('vr.lastHost') || vrBridge._host || '127.0.0.1';
  const savedPlayer = settings.get('vr.lastPlayerType') || vrBridge._playerType || 'heresphere';
  hostInput.value = savedHost;
  playerSelect.value = savedPlayer;

  // Initial paint + live updates handled by pollStatus above.
  pollStatus();
  if (vrBridge.connected && vrBridge.__vrModalLastVideo) {
    videoName.textContent = vrBridge.__vrModalLastVideo;
  }

  // Connect / disconnect
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    try {
      if (vrBridge.connected) {
        await vrBridge.disconnect();
        return;
      }
      // Cancel any pending auto-reconnect backoff so the user-initiated
      // click fires immediately instead of waiting out the timer.
      if (vrBridge._reconnectTimer) {
        clearTimeout(vrBridge._reconnectTimer);
        vrBridge._reconnectTimer = null;
        vrBridge._reconnecting = false;
        vrBridge._reconnectAttempts = 0;
      }
      const playerType = playerSelect.value;
      const host = hostInput.value.trim() || '127.0.0.1';
      paintStatus('connecting');
      const success = await vrBridge.connect(playerType, host, 23554);
      if (!success) {
        paintStatus('disconnected');
        statusText.textContent = 'Failed — check VR player settings';
      }
    } finally {
      connectBtn.disabled = false;
    }
  });

  // Offset slider — restore saved value, persist on change
  const savedOffset = settings.get('vr.offset') || 0;
  offsetSlider.value = String(savedOffset);
  offsetValue.textContent = `${savedOffset}ms`;
  if (vrBridge.proxy) vrBridge.proxy.setOffset(savedOffset);

  offsetSlider.addEventListener('input', (e) => {
    offsetValue.textContent = `${e.target.value}ms`;
  });
  offsetSlider.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    settings.set('vr.offset', v);
    if (vrBridge.proxy) vrBridge.proxy.setOffset(v);
  });

  // Live status updates — wire temporary listeners for as long as the
  // modal is open. The bridge keeps a single slot per callback so we
  // stash the originals and restore on close.
  const prevOnConnect = vrBridge.onConnect;
  const prevOnDisconnect = vrBridge.onDisconnect;
  const prevOnVideo = vrBridge.onVideoChanged;

  vrBridge.onConnect = () => {
    if (prevOnConnect) prevOnConnect();
    // pollStatus paints "Connected (<host>)"; use it here too so the
    // modal doesn't briefly show "Connected" without the host between
    // the event and the next poll tick.
    pollStatus();
  };
  vrBridge.onDisconnect = () => {
    if (prevOnDisconnect) prevOnDisconnect();
    pollStatus();
  };
  vrBridge.onVideoChanged = (name) => {
    if (prevOnVideo) prevOnVideo(name);
    vrBridge.__vrModalLastVideo = name || '';
    videoName.textContent = name || '—';
  };

  vrBridge.__vrModalCleanup = () => {
    clearInterval(statusPollId);
    vrBridge.onConnect = prevOnConnect;
    vrBridge.onDisconnect = prevOnDisconnect;
    vrBridge.onVideoChanged = prevOnVideo;
  };
}


async function _loadServerUrl(root, port) {
  const hsUrl = root.querySelector('#vr-server-hs-url');
  if (!hsUrl) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/network-info`);
    if (res.ok) {
      const data = await res.json();
      const ip = data.ip || '127.0.0.1';
      hsUrl.value = `http://${ip}:${port}/heresphere`;
    } else {
      hsUrl.value = 'Backend not running';
    }
  } catch {
    hsUrl.value = 'Backend not running';
  }
  hsUrl.addEventListener('click', () => hsUrl.select());
}


/**
 * Expose a module-level helper that app.js can call to get the bridge's
 * current "display name" for the currently-playing VR video even when
 * the modal isn't open — used to keep the toolbar tooltip informative.
 */
export function setVRModalVideoName(vrBridge, name) {
  if (!vrBridge) return;
  vrBridge.__vrModalLastVideo = name || '';
}
