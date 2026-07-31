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
import { t } from '../js/i18n.js';

/**
 * @param {object} opts
 * @param {import('../js/data-service.js').DataService|object} opts.settings
 * @param {import('../js/vr-bridge.js').VRBridge} opts.vrBridge
 */
export async function openVRModal({ settings, vrBridge } = {}) {
  if (!vrBridge) return;
  const port = settings?.get?.('backend.port') || 5123;

  await Modal.open({
    title: t('vrModal.title'),
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
    <div class="vr-modal__experimental" role="note" aria-label="${t('vrModal.experimentalAria')}">
      <span class="vr-modal__experimental-label">${t('vrModal.experimentalLabel')}</span>
      <span class="vr-modal__experimental-text">${t('vrModal.experimentalText')}</span>
    </div>

    <section class="vr-modal__section" aria-labelledby="vr-modal-streaming-h">
      <h2 class="vr-modal__section-header" id="vr-modal-streaming-h">
        <span class="vr-modal__section-num" aria-hidden="true">1</span>
        ${t('vrModal.streamingHeader')}
      </h2>
      <p class="vr-modal__section-intro">
        ${t('vrModal.streamingIntro')}
      </p>

      <div class="connection-panel__setting-row vr-modal__url-row">
        <label class="connection-panel__setting-label" for="vr-server-hs-url">${t('vrModal.hsUrlLabel')}</label>
        <input type="text" id="vr-server-hs-url" class="connection-panel__input vr-modal__url-input" readonly aria-describedby="vr-server-hs-url-hint">
        <button id="vr-setup-info-btn" class="vr-modal__info-btn" type="button"
                aria-controls="vr-setup-info" aria-expanded="false"
                aria-label="${t('vrModal.setupToggleAria')}" title="${t('vrModal.setupToggleTitle')}">i</button>
      </div>
      <p class="vr-modal__hint" id="vr-server-hs-url-hint">
        ${t('vrModal.hsUrlHint')}
      </p>

      <div id="vr-setup-info" class="vr-modal__setup-info" hidden>
        <div class="vr-modal__setup-info-title">${t('vrModal.setupTitle')}</div>

        <div class="vr-modal__setup-info-group-label">${t('vrModal.setupFirstTime')}</div>
        <ol class="vr-modal__setup-info-list">
          <li>${t('vrModal.setupFirstTimeStep1')}</li>
          <li>${t('vrModal.setupFirstTimeStep2')}</li>
          <li>${t('vrModal.setupFirstTimeStep3')}</li>
          <li>${t('vrModal.setupFirstTimeStep4')}</li>
        </ol>

        <div class="vr-modal__setup-info-group-label">${t('vrModal.setupDeviceSync')}</div>
        <ol class="vr-modal__setup-info-list">
          <li>${t('vrModal.setupSyncStep1')}</li>
          <li>${t('vrModal.setupSyncStep2')}</li>
          <li>${t('vrModal.setupSyncStep3')}</li>
          <li>${t('vrModal.setupSyncStep4')}</li>
        </ol>

        <div class="vr-modal__setup-info-group-label">${t('vrModal.setupTroubleshooting')}</div>
        <ul class="vr-modal__setup-info-list">
          <li>${t('vrModal.setupTrUrlBar')}</li>
          <li>${t('vrModal.setupTrNoVideos')}</li>
          <li>${t('vrModal.setupTrUnreachable')}
            <ol>
              <li>${t('vrModal.setupTrUnreachableStep1')}</li>
              <li>${t('vrModal.setupTrUnreachableStep2')}</li>
            </ol>
            ${t('vrModal.setupTrUnreachableTail')}
          </li>
          <li>${t('vrModal.setupTrWaiting')}</li>
          <li>${t('vrModal.setupTrNoConnect')}</li>
          <li>${t('vrModal.setupTrVpn')}</li>
          <li>${t('vrModal.setupTrProjection')}</li>
        </ul>
      </div>
    </section>

    <section class="vr-modal__section" aria-labelledby="vr-modal-sync-h">
      <h2 class="vr-modal__section-header" id="vr-modal-sync-h">
        <span class="vr-modal__section-num" aria-hidden="true">2</span>
        ${t('vrModal.syncHeader')}
      </h2>
      <p class="vr-modal__section-intro">
        ${t('vrModal.syncIntro')}
      </p>

      <div class="connection-panel__status">
        <span class="connection-panel__led" id="vr-led"></span>
        <span class="connection-panel__status-text" id="vr-status-text">${t('vrModal.statusDisconnected')}</span>
      </div>

      <div class="connection-panel__form">
        <div class="connection-panel__input-row">
          <label for="vr-host-input" class="vr-modal__sr-only">${t('vrModal.hostSrLabel')}</label>
          <input type="text" id="vr-host-input" class="connection-panel__input vr-modal__host-input"
                 placeholder="127.0.0.1" aria-describedby="vr-host-input-hint">
          <button id="vr-connect-btn" class="connection-panel__btn" type="button">${t('vrModal.connect')}</button>
        </div>
        <p class="vr-modal__hint" id="vr-host-input-hint">
          ${t('vrModal.hostHint')}
        </p>
        <p class="vr-modal__subnet-warning" id="vr-subnet-warning" role="alert" hidden></p>
      </div>

      <div id="vr-now-playing" class="vr-modal__now-playing" hidden>
        <div class="connection-panel__setting-row vr-modal__now-playing-row">
          <span class="connection-panel__setting-label">${t('vrModal.playing')}</span>
          <span id="vr-video-name" class="connection-panel__setting-value vr-modal__video-name" aria-live="polite">—</span>
        </div>
        <div class="connection-panel__setting-row vr-modal__now-playing-row">
          <label class="connection-panel__setting-label" for="vr-offset">${t('vrModal.offset')}</label>
          <input type="range" id="vr-offset" min="-1000" max="1000" value="0"
                 class="connection-panel__safety-slider vr-modal__offset-slider"
                 aria-describedby="vr-offset-hint vr-offset-value">
          <span id="vr-offset-value" class="connection-panel__setting-value vr-modal__offset-value">0ms</span>
        </div>
        <p class="vr-modal__hint" id="vr-offset-hint">
          ${t('vrModal.offsetHint')}
        </p>
      </div>
    </section>
  `;
}


function _wire(root, { settings, vrBridge, port }) {
  // Populate server URL and remember this PC's LAN IP so we can flag a
  // subnet mismatch on the Device-Sync host below (see _checkSubnet).
  let pcIp = null;
  _loadServerUrl(root, port).then((ip) => {
    pcIp = ip;
    _checkSubnet(root, pcIp, root.querySelector('#vr-host-input')?.value);
  });

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
    if (status === 'connected') text = detail ? t('vrModal.statusConnectedDetail', { detail }) : t('vrModal.statusConnected');
    else if (status === 'waiting') {
      text = detail
        ? t('vrModal.statusWaitingDetail', { detail })
        : t('vrModal.statusWaiting');
    }
    else if (status === 'connecting') text = t('vrModal.statusConnecting');
    else text = t('vrModal.statusDisconnected');
    statusText.textContent = text;

    // Connect button text: "Disconnect" when the link is up at all
    // (connected or waiting); "Connect" otherwise.
    const linkUp = status === 'connected' || status === 'waiting';
    connectBtn.textContent = linkUp ? t('vrModal.disconnect') : t('vrModal.connect');
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

  // Re-evaluate the subnet warning as the user edits the host. `pcIp` may
  // still be null on the first keystrokes (network-info fetch in flight);
  // _checkSubnet no-ops until it resolves, then paints via the .then above.
  hostInput.addEventListener('input', () => _checkSubnet(root, pcIp, hostInput.value));

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
        statusText.textContent = t('vrModal.statusFailed');
        // A failed dial is exactly when a subnet mismatch matters — make
        // sure the hint is showing even if the field was pre-filled and
        // never edited this session.
        _checkSubnet(root, pcIp, host);
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
  if (!hsUrl) return null;
  let ip = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/network-info`);
    if (res.ok) {
      const data = await res.json();
      ip = data.ip || '127.0.0.1';
      hsUrl.value = `http://${ip}:${port}/heresphere`;
    } else {
      hsUrl.value = t('vrModal.backendNotRunning');
    }
  } catch {
    hsUrl.value = t('vrModal.backendNotRunning');
  }
  hsUrl.addEventListener('click', () => hsUrl.select());
  return ip;
}


// IPv4 /24 subnet ('192.168.101.5' -> '192.168.101'), or null if not a
// dotted-quad address we can compare.
export function subnet24(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const oct = m.slice(1).map(Number);
  if (oct.some((o) => o > 255)) return null;
  return oct.slice(0, 3).join('.');
}

/**
 * Pure decision for the subnet-mismatch warning. Returns the PC's /24 to
 * suggest (truthy) when the host is on a different network and worth
 * warning about, or null when it's fine / undeterminable. Extracted so it
 * can be unit-tested without DOM.
 */
export function shouldWarnSubnet(pcIp, host) {
  const h = String(host || '').trim();
  const pcNet = subnet24(pcIp);
  const hostNet = subnet24(h);
  if (!pcNet || !hostNet) return null;         // can't compare
  if (hostNet === pcNet) return null;          // same subnet — fine
  if (h.startsWith('127.')) return null;       // loopback = PCVR, always fine
  if (pcIp === '127.0.0.1') return null;       // no LAN IP detected — don't nag
  return pcNet;
}


/**
 * Warn when the Device-Sync host is on a different /24 than this PC.
 *
 * The #1 support failure (2026-07 HereSphere report) is a user copying the
 * IP HereSphere shows for its timestamp server while that IP belongs to a
 * VPN / virtual adapter — a different subnet than the PC's LAN, so FunSync
 * can't route to it. FunSync already knows its own LAN IP (the Library
 * Streaming URL), so we can catch this before the user hits Connect.
 *
 * Soft, non-blocking: cross-subnet setups with real routing exist, so this
 * is a hint, not a hard stop. Skipped for loopback (PCVR) and until the
 * network-info fetch resolves.
 */
function _checkSubnet(root, pcIp, host) {
  const warnEl = root.querySelector('#vr-subnet-warning');
  if (!warnEl) return;
  const pcNet = shouldWarnSubnet(pcIp, host);
  if (pcNet) {
    warnEl.textContent = t('vrModal.subnetWarning', { host: String(host).trim(), pcIp, pcNet });
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
    warnEl.textContent = '';
  }
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
