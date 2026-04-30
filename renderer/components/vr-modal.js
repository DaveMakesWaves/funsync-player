// VRModal — dedicated modal for VR setup (library streaming + device sync).
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
//
// 2026-04-29 restructure: section labels were "VR Server (Quest)" + "PCVR
// Companion", which conflated *use case* with *VR platform*. Both
// sections apply to Quest-standalone AND PCVR users — the split is
// actually "FunSync as media server" (top: HereSphere browses your
// library) vs "FunSync as device-sync receiver" (bottom: VR player
// sends timestamps so the toy follows playback). Renamed to "1. Library
// Streaming" + "2. Device Sync" with numbered ordering to convey
// step-1-then-step-2 (Nielsen #2 match real world, Nielsen #4
// consistency, Norman conceptual model). Same restructure also
// retrofits the design backbone established in 2026-04 polish passes
// (semantic state tokens, real h2 section headers, 36 px Fitts floor on
// the info toggle, aria-describedby on form fields, no inline styles).

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
  // Sections numbered 1 / 2 to convey ordering (Nielsen #2 + #4 + Norman
  // conceptual model). Both sections apply to Quest-standalone AND PCVR
  // users — the split is purpose, not platform.
  //
  // ARIA contract:
  //  - vr-host-input + vr-offset both link via aria-describedby to their
  //    explainer hints (WCAG 1.3.1 Info and Relationships).
  //  - vr-video-name is aria-live=polite so a screen reader announces
  //    when HereSphere changes video.
  //  - vr-setup-info-btn is aria-pressed/aria-controls/aria-expanded so
  //    the toggle reads correctly as a disclosure widget.
  //  - vr-now-playing is a sub-cluster, not a section (no nested border).
  return `
    <div class="vr-modal__experimental" role="note" aria-label="Experimental feature notice">
      <span class="vr-modal__experimental-label">EXPERIMENTAL</span>
      <span class="vr-modal__experimental-text">VR streaming and device sync are still being tuned. Expect rough edges around reconnection, sync timing, and player-specific quirks.</span>
    </div>

    <section class="vr-modal__section" aria-labelledby="vr-modal-streaming-h">
      <h2 class="vr-modal__section-header" id="vr-modal-streaming-h">
        <span class="vr-modal__section-num" aria-hidden="true">1</span>
        Library Streaming
      </h2>
      <p class="vr-modal__section-intro">
        Set up HereSphere to browse and stream FunSync's library directly. No file transfers — works on Quest standalone or PCVR.
      </p>

      <div class="connection-panel__setting-row vr-modal__url-row">
        <label class="connection-panel__setting-label" for="vr-server-hs-url">HereSphere URL</label>
        <input type="text" id="vr-server-hs-url" class="connection-panel__input vr-modal__url-input" readonly aria-describedby="vr-server-hs-url-hint">
        <button id="vr-setup-info-btn" class="vr-modal__info-btn" type="button"
                aria-controls="vr-setup-info" aria-expanded="false"
                aria-label="Toggle setup guide" title="Setup guide">i</button>
      </div>
      <p class="vr-modal__hint" id="vr-server-hs-url-hint">
        Type this into the URL bar at the top of HereSphere's home screen on your Quest.
      </p>

      <div id="vr-setup-info" class="vr-modal__setup-info" hidden>
        <div class="vr-modal__setup-info-title">HereSphere Setup Guide</div>

        <div class="vr-modal__setup-info-group-label">First time setup</div>
        <ol class="vr-modal__setup-info-list">
          <li>Open HereSphere on your Quest.</li>
          <li>Type the URL above into HereSphere's <strong>URL bar</strong> (at the top of the home screen) and press Enter.</li>
          <li>Your FunSync library appears — pick a video to play.</li>
          <li><em>Optional:</em> bookmark or favourite the page in HereSphere so you don't have to retype next time.</li>
        </ol>

        <div class="vr-modal__setup-info-group-label">For device sync (Handy via Buttplug, Vorze, etc.)</div>
        <ol class="vr-modal__setup-info-list">
          <li>In HereSphere, open <strong>Settings &gt; Timestamp Server</strong>.</li>
          <li><strong>Enable the timestamp server</strong> — required for FunSync to drive non-Handy devices.</li>
          <li><strong>Fill in BOTH the IP and port fields</strong>: the IP must be your Quest's current IP (visible in the Quest's Wi-Fi settings), and the port should be <strong>23554</strong>. The toggle on its own is not enough — without these fields populated, HereSphere shows "enabled" but never actually opens the listening socket. This catches a lot of users.</li>
          <li>FunSync auto-detects your Quest and connects when you start playback.</li>
        </ol>
        <div class="vr-modal__setup-info-note">
          <strong>Note:</strong> The Handy works in HereSphere even without the timestamp server because HereSphere has its own built-in Handy connection (via the connection-key field in HereSphere's settings). If only the Handy is moving and other devices are silent, the timestamp server isn't actually listening — even if it shows as enabled. See the IP+port step above.
        </div>

        <div class="vr-modal__setup-info-group-label">Troubleshooting</div>
        <ul class="vr-modal__setup-info-list">
          <li><strong>URL bar not visible?</strong> It's at the top of HereSphere's home screen — tap the address area to bring up the keyboard.</li>
          <li><strong>No videos showing?</strong> Make sure FunSync is open with at least one source added.</li>
          <li><strong>Only the Handy moves, other devices silent?</strong> The timestamp server's IP and port fields are probably blank or wrong. Type your Quest's IP and port 23554 explicitly, even if the toggle says "enabled."</li>
          <li><strong>Devices not syncing?</strong> Check that the timestamp server's IP and port fields are filled in (the toggle alone isn't enough — fields are reset each session on some HereSphere versions).</li>
          <li><strong>Can't connect?</strong> Ensure your Quest and PC are on the same Wi-Fi network.</li>
          <li><strong>VPN active?</strong> Disable VPN — it changes your network IP and blocks local connections.</li>
          <li><strong>Video looks wrong?</strong> Adjust projection mode in HereSphere (SBS, fisheye, etc.).</li>
        </ul>
      </div>
    </section>

    <section class="vr-modal__section" aria-labelledby="vr-modal-sync-h">
      <h2 class="vr-modal__section-header" id="vr-modal-sync-h">
        <span class="vr-modal__section-num" aria-hidden="true">2</span>
        Device Sync
      </h2>
      <p class="vr-modal__section-intro">
        Connect FunSync to HereSphere so devices follow playback. Works on Quest standalone, Quest Link, or PCVR.
      </p>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="vr-led"></span>
        <span class="connection-panel__status-text" id="vr-status-text">Disconnected</span>
      </div>

      <div class="connection-panel__form">
        <div class="connection-panel__input-row">
          <label for="vr-host-input" class="vr-modal__sr-only">HereSphere host (Quest IP)</label>
          <input type="text" id="vr-host-input" class="connection-panel__input vr-modal__host-input"
                 placeholder="127.0.0.1" aria-describedby="vr-host-input-hint">
          <button id="vr-connect-btn" class="connection-panel__btn" type="button">Connect</button>
        </div>
        <p class="vr-modal__hint" id="vr-host-input-hint">
          Tip: leave the host field with your Quest's IP — FunSync remembers it and auto-reconnects next launch.
        </p>
      </div>

      <div id="vr-now-playing" class="vr-modal__now-playing" hidden>
        <div class="connection-panel__setting-row vr-modal__now-playing-row">
          <span class="connection-panel__setting-label">Playing</span>
          <span id="vr-video-name" class="connection-panel__setting-value vr-modal__video-name" aria-live="polite">—</span>
        </div>
        <div class="connection-panel__setting-row vr-modal__now-playing-row">
          <label class="connection-panel__setting-label" for="vr-offset">Offset</label>
          <input type="range" id="vr-offset" min="-1000" max="1000" value="0"
                 class="connection-panel__safety-slider vr-modal__offset-slider"
                 aria-describedby="vr-offset-hint vr-offset-value">
          <span id="vr-offset-value" class="connection-panel__setting-value vr-modal__offset-value">0ms</span>
        </div>
        <p class="vr-modal__hint" id="vr-offset-hint">
          Compensates VR display lag. Stacks on top of each device's own offset — see the Sync tab for the combined effective value per device.
        </p>
      </div>
    </section>
  `;
}


function _wire(root, { settings, vrBridge, port }) {
  // Populate server URL
  _loadServerUrl(root, port);

  // Setup guide toggle — disclosure widget pattern. `aria-expanded` is
  // the source of truth for screen readers and the CSS `[aria-expanded="true"]`
  // selector paints the active accent tint (no inline-style hack).
  const infoBtn = root.querySelector('#vr-setup-info-btn');
  const infoPanel = root.querySelector('#vr-setup-info');
  if (infoBtn && infoPanel) {
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = infoPanel.hidden;
      infoPanel.hidden = !open;
      infoBtn.setAttribute('aria-expanded', String(open));
    });
  }

  // Device-Sync form. Player type is hardcoded to 'heresphere' —
  // DeoVR was previously a dropdown option but the timestamp pipeline
  // doesn't actually work with DeoVR today, so the dropdown was removed
  // 2026-04-29 to stop misleading users. Backend `/deovr` endpoint and
  // bridge protocol code are unchanged so a future re-enable is purely
  // a UI restoration.
  const hostInput = root.querySelector('#vr-host-input');
  const connectBtn = root.querySelector('#vr-connect-btn');
  const statusText = root.querySelector('#vr-status-text');
  const led = root.querySelector('#vr-led');
  const nowPlaying = root.querySelector('#vr-now-playing');
  const videoName = root.querySelector('#vr-video-name');
  const offsetSlider = root.querySelector('#vr-offset');
  const offsetValue = root.querySelector('#vr-offset-value');

  // Three-state status painter — distinguishes the silent-failure mode
  // ('waiting': TCP open but no packets in last 5 s) from genuine
  // connectivity. See `vrBridge.linkState` and the connection-reliability
  // SCOPE for rationale (was a Nielsen #1 visibility gap that let the
  // toys sit silent while the UI showed "Connected").
  const paintStatus = (status, detail) => {
    led.className = 'connection-panel__led';
    if (status === 'connected') led.classList.add('connection-panel__led--connected');
    else if (status === 'waiting' || status === 'connecting') {
      led.classList.add('connection-panel__led--connecting');
    }

    let text;
    if (status === 'connected') text = `Connected${detail ? ` (${detail})` : ''} — receiving timestamps`;
    else if (status === 'waiting') {
      text = detail
        ? `Connected (${detail}) — waiting for HereSphere to send timestamps. Check 'Timestamp Server' is on.`
        : "Waiting for HereSphere to send timestamps. Check 'Timestamp Server' is on.";
    }
    else if (status === 'connecting') text = 'Connecting...';
    else text = 'Disconnected';
    statusText.textContent = text;

    // Connect button text: "Disconnect" when the link is up at all
    // (connected or waiting); "Connect" otherwise.
    const linkUp = status === 'connected' || status === 'waiting';
    connectBtn.textContent = linkUp ? 'Disconnect' : 'Connect';
    nowPlaying.hidden = status !== 'connected';
  };

  // Poll the bridge's link-state every 1s while the modal is open. The
  // bridge doesn't emit events for the silent-failure transition
  // (connected & receiving → connected & waiting), so polling is the
  // only way to keep the UI honest.
  const pollStatus = () => {
    const state = vrBridge.linkState; // 'receiving' | 'waiting' | 'disconnected'
    if (state === 'receiving') paintStatus('connected', vrBridge.host);
    else if (state === 'waiting') paintStatus('waiting', vrBridge.host);
    else paintStatus('disconnected');
  };
  const statusPollId = setInterval(pollStatus, 1000);

  // Pre-fill host from the last successful session so the user isn't
  // typing their Quest IP every time. Falls back to the
  // currently-connected bridge (if any), then 127.0.0.1.
  const savedHost = settings.get('vr.lastHost') || vrBridge.host || '127.0.0.1';
  hostInput.value = savedHost;

  // Initial paint + live updates handled by pollStatus above.
  pollStatus();
  if (vrBridge.connected && vrBridge.__vrModalLastVideo) {
    videoName.textContent = vrBridge.__vrModalLastVideo;
  }

  // Connect / disconnect. The bridge no longer self-retries (activity
  // poll is sole driver), so there's no internal reconnect-backoff to
  // cancel before a user-initiated connect — the click fires straight
  // through.
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    try {
      if (vrBridge.connected) {
        await vrBridge.disconnect();
        return;
      }
      const host = hostInput.value.trim() || '127.0.0.1';
      paintStatus('connecting');
      const success = await vrBridge.connect('heresphere', host, 23554);
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
  vrBridge.onVideoChanged = (name, rawPath) => {
    // Forward BOTH args — `_onVRVideoChanged` in app.js needs `rawPath`
    // (the second arg) for library matching and display-name fallback.
    // Dropping it here was the root cause of a silent VR failure where
    // `rawPath.split(...)` would crash inside the app handler, killing
    // script load + proxy arming. The bridge would still connect and
    // poll fine, so the VR panel reported "connected, receiving
    // timestamps" while the device sat silent. Discovered 2026-04-29.
    if (prevOnVideo) prevOnVideo(name, rawPath);
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
