// Audience room — pop-out renderer entry point.
//
// Thin client to the main renderer's AudienceBridge. Sends user
// commands (add / remove / mute / set-offset / test-buzz / resend) via the
// popout protocol; receives state updates via INITIAL_STATE and the
// VIEWER_* / HIDE_KEYS_CHANGED messages.
//
// Architectural contract:
//   - Authoritative state lives in the main renderer's AudienceBridge.
//   - This window is a re-renderable mirror. Closing + reopening just
//     re-fetches state via the next INITIAL_STATE on READY.
//   - User actions never mutate local state directly — they send ops
//     to main, main updates the bridge, the bridge emits VIEWER_STATUS,
//     this window re-renders.

import { t, initI18n, setLocale } from './js/i18n.js';
import { icon, X, Volume2, VolumeX, Eye, EyeOff, Bell, Users, RotateCcw } from './js/icons.js';
import { watchWcoClass } from './js/wco.js';
import { applySeason } from './js/holiday.js';
import {
  INITIAL_STATE, VIEWER_ADDED, VIEWER_REMOVED, VIEWER_STATUS, VIEWER_OFFSET,
  HIDE_KEYS_CHANGED, THEME,
  READY, ADD_VIEWER, REMOVE_VIEWER, SET_OFFSET, SET_MUTED, TEST_BUZZ,
  TEST_BUZZ_ALL, RESEND, SET_HIDE_KEYS, END_ROOM,
  makeMessage, classifyMessage,
} from './js/audience-popout-protocol.js';

// Frameless window → the page owns the drag region (.popout-titlebar).
// Kept in step with the overlay for the whole session, not just at boot (FT-055).
watchWcoClass({ where: 'audience room' });

const HOST_ID = 'audience-room-host';
const host = document.getElementById(HOST_ID);
if (!host) throw new Error('[audience-room] missing host #' + HOST_ID);

// --- Local mirror of authoritative state ---

const state = {
  roomActive: false,
  viewers: [],          // array of viewer snapshots from main
  hideKeys: true,       // masked until main says otherwise (store.js default)
  theme: 'dark',
  locale: 'en',         // updated from INITIAL_STATE
};

// Pop-out is a separate renderer with its own module-level i18n state.
// Without initI18n, `t()` returns the raw key string (constants in the
// UI). We initialise to English on load so the first paint is sane,
// then re-locale to whatever the main app's user picked once
// INITIAL_STATE arrives. `_i18nReady` gates the first render.
let _i18nReady = false;

// --- Wire helpers ---

const send = (payload) => window.funsync.audiencePopoutRelay('to-parent', payload);

function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  // Retint this window's native chrome too, or the caption strip keeps the
  // colours it was CREATED with while the main window follows the theme.
  if (t === 'dark' || t === 'light' || t === 'system') {
    try { window.funsync?.updateWindowChrome?.(t); } catch { /* non-fatal */ }
  }
}
function applyStyle(s) {
  // No-op on undefined so a theme-only sync can't reset the style.
  if (s === 'classic' || s === 'modern') document.documentElement.dataset.style = s;
}

// The Holiday style's palette (v0.10.1): the main window sends its season with
// the style. No snow in a pop-out. No-op on undefined, like applyStyle.
function applyPopoutSeason(season) {
  if (season === undefined) return;
  applySeason(season === 'holiday' ? 'holiday' : null, document, { snow: false });
}
applyTheme('dark');

// --- Render ---

function render() {
  // Don't render until the i18n bundle is loaded — otherwise every
  // `t()` call returns the raw key and the UI shows constants like
  // "audience.room.empty" instead of human text.
  if (!_i18nReady) return;
  host.innerHTML = '';
  host.classList.add('audience-room');

  // Header — status + Hide-keys + Test buzz all
  const header = document.createElement('div');
  header.className = 'audience-room__header';

  const statusLine = document.createElement('div');
  statusLine.className = 'audience-room__status';
  const dot = document.createElement('span');
  dot.className = `audience-room__status-dot audience-room__status-dot--${aggregateStatus()}`;
  statusLine.appendChild(dot);
  const statusText = document.createElement('span');
  statusText.textContent = state.viewers.length === 0
    ? t('audience.room.empty')
    : t('audience.room.activeCount', { count: state.viewers.length });
  statusLine.appendChild(statusText);
  header.appendChild(statusLine);

  // Right side of header: Hide-keys + Test-buzz-all
  const actions = document.createElement('div');
  actions.className = 'audience-room__header-actions';

  const hideKeysBtn = document.createElement('button');
  hideKeysBtn.type = 'button';
  hideKeysBtn.className = 'audience-room__hide-keys-btn';
  hideKeysBtn.setAttribute('aria-pressed', state.hideKeys ? 'true' : 'false');
  hideKeysBtn.title = t('audience.room.hideKeysTitle');
  hideKeysBtn.appendChild(icon(state.hideKeys ? EyeOff : Eye, { width: 16, height: 16 }));
  const hkLabel = document.createElement('span');
  hkLabel.textContent = t('audience.room.hideKeys');
  hideKeysBtn.appendChild(hkLabel);
  hideKeysBtn.addEventListener('click', () => {
    send(makeMessage(SET_HIDE_KEYS, { hideKeys: !state.hideKeys }));
  });
  actions.appendChild(hideKeysBtn);

  const buzzAllBtn = document.createElement('button');
  buzzAllBtn.type = 'button';
  buzzAllBtn.className = 'audience-room__buzz-all-btn';
  buzzAllBtn.disabled = !state.viewers.some(canTestBuzz);
  // Greyed out while the video plays: say so (TODO triage 2026-11-23).
  buzzAllBtn.title = buzzAllBtn.disabled && state.viewers.some((v) => !v.muted && v.status === 'playing')
    ? t('audience.room.testBuzzPauseTitle')
    : t('audience.room.testBuzzAllTitle');
  buzzAllBtn.appendChild(icon(Bell, { width: 16, height: 16 }));
  const baLabel = document.createElement('span');
  baLabel.textContent = t('audience.room.testBuzzAll');
  buzzAllBtn.appendChild(baLabel);
  buzzAllBtn.addEventListener('click', () => send(makeMessage(TEST_BUZZ_ALL)));
  actions.appendChild(buzzAllBtn);

  header.appendChild(actions);
  host.appendChild(header);

  const divider = document.createElement('div');
  divider.className = 'audience-room__divider';
  host.appendChild(divider);

  // Viewer cards
  if (state.viewers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'audience-room__empty';
    empty.appendChild(icon(Users, { width: 32, height: 32 }));
    const emptyText = document.createElement('p');
    emptyText.textContent = t('audience.room.emptyHint');
    empty.appendChild(emptyText);
    host.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'audience-room__list';
    list.setAttribute('role', 'list');
    for (const v of state.viewers) list.appendChild(renderViewerCard(v));
    host.appendChild(list);
  }

  // Add-viewer form
  host.appendChild(renderAddForm());
}

function renderViewerCard(viewer) {
  const li = document.createElement('li');
  li.className = 'audience-room__card';
  li.dataset.viewerKey = viewer.key;

  // Top row: name, status dot, key
  const topRow = document.createElement('div');
  topRow.className = 'audience-room__card-top';

  const dot = document.createElement('span');
  dot.className = `audience-room__card-dot audience-room__card-dot--${viewerLedState(viewer)}`;
  topRow.appendChild(dot);

  const nameKey = document.createElement('div');
  nameKey.className = 'audience-room__card-name-key';
  const name = document.createElement('div');
  name.className = 'audience-room__card-name';
  name.textContent = viewer.label || t('audience.room.unlabeled');
  nameKey.appendChild(name);
  const keyEl = document.createElement('div');
  keyEl.className = 'audience-room__card-key';
  keyEl.textContent = state.hideKeys ? '••••••••' : viewer.key;
  if (!state.hideKeys) keyEl.title = viewer.key;
  nameKey.appendChild(keyEl);
  topRow.appendChild(nameKey);

  const statusEl = document.createElement('div');
  statusEl.className = 'audience-room__card-status';
  statusEl.textContent = viewerStatusLabel(viewer);
  topRow.appendChild(statusEl);

  li.appendChild(topRow);

  // Offset row
  const offsetRow = document.createElement('div');
  offsetRow.className = 'audience-room__card-offset';
  const offsetLabel = document.createElement('label');
  offsetLabel.className = 'audience-room__card-offset-label';
  offsetLabel.textContent = t('audience.room.offsetLabel');
  offsetRow.appendChild(offsetLabel);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '-500';
  slider.max = '500';
  slider.step = '10';
  slider.value = String(viewer.offsetMs || 0);
  slider.className = 'audience-room__card-slider';
  slider.addEventListener('input', () => {
    const ms = parseInt(slider.value, 10) || 0;
    valueEl.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    send(makeMessage(SET_OFFSET, { key: viewer.key, offsetMs: ms }));
  });
  offsetRow.appendChild(slider);

  const valueEl = document.createElement('span');
  valueEl.className = 'audience-room__card-offset-value';
  valueEl.textContent = `${viewer.offsetMs > 0 ? '+' : ''}${viewer.offsetMs || 0} ms`;
  offsetRow.appendChild(valueEl);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'audience-room__card-offset-reset';
  resetBtn.textContent = '↻';
  resetBtn.title = t('audience.room.offsetReset');
  resetBtn.disabled = viewer.offsetMs === 0;
  resetBtn.addEventListener('click', () => {
    slider.value = '0';
    valueEl.textContent = '0 ms';
    send(makeMessage(SET_OFFSET, { key: viewer.key, offsetMs: 0 }));
  });
  offsetRow.appendChild(resetBtn);
  li.appendChild(offsetRow);

  // Action row: Test buzz, Resend, Mute, Remove
  const actions = document.createElement('div');
  actions.className = 'audience-room__card-actions';

  const buzzBtn = document.createElement('button');
  buzzBtn.type = 'button';
  buzzBtn.className = 'audience-room__card-buzz-btn';
  buzzBtn.disabled = !canTestBuzz(viewer);
  const buzzWhyNot = buzzBtn.disabled ? buzzBlockedTitle(viewer) : '';
  if (buzzWhyNot) buzzBtn.title = buzzWhyNot;
  buzzBtn.appendChild(icon(Bell, { width: 14, height: 14 }));
  const buzzLabel = document.createElement('span');
  buzzLabel.textContent = t('audience.room.testBuzz');
  buzzBtn.appendChild(buzzLabel);
  buzzBtn.addEventListener('click', () => send(makeMessage(TEST_BUZZ, { key: viewer.key })));
  actions.appendChild(buzzBtn);

  // Resend (FT-121): connect again if the device dropped, then send the
  // current script again. Nothing goes to a muted viewer.
  const resendBtn = document.createElement('button');
  resendBtn.type = 'button';
  resendBtn.className = 'audience-room__card-resend-btn';
  resendBtn.title = t('audience.room.resendTitle');
  resendBtn.disabled = !canResend(viewer);
  resendBtn.appendChild(icon(RotateCcw, { width: 14, height: 14 }));
  const resendLabel = document.createElement('span');
  resendLabel.textContent = t('audience.room.resend');
  resendBtn.appendChild(resendLabel);
  resendBtn.addEventListener('click', () => send(makeMessage(RESEND, { key: viewer.key })));
  actions.appendChild(resendBtn);

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'audience-room__card-mute-btn';
  muteBtn.setAttribute('aria-pressed', viewer.muted ? 'true' : 'false');
  muteBtn.appendChild(icon(viewer.muted ? VolumeX : Volume2, { width: 14, height: 14 }));
  const muteLabel = document.createElement('span');
  muteLabel.textContent = viewer.muted ? t('audience.room.unmute') : t('audience.room.mute');
  muteBtn.appendChild(muteLabel);
  muteBtn.addEventListener('click', () => send(makeMessage(SET_MUTED, { key: viewer.key, muted: !viewer.muted })));
  actions.appendChild(muteBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'audience-room__card-remove-btn';
  removeBtn.title = t('audience.room.remove');
  removeBtn.setAttribute('aria-label', t('audience.room.remove'));
  removeBtn.appendChild(icon(X, { width: 16, height: 16 }));
  removeBtn.addEventListener('click', () => {
    const confirmText = t('audience.room.removeConfirm', { label: viewer.label || viewer.key });
    if (window.confirm(confirmText)) {
      send(makeMessage(REMOVE_VIEWER, { key: viewer.key, forget: false }));
    }
  });
  actions.appendChild(removeBtn);

  li.appendChild(actions);

  // Error footer if any. A known error code gets its translated line; the
  // raw message is the fallback (connect failures).
  const errorText = viewerErrorText(viewer);
  if (errorText && (viewer.status === 'error' || viewer.status === 'disconnected')) {
    const errFoot = document.createElement('div');
    errFoot.className = 'audience-room__card-error';
    errFoot.textContent = errorText;
    li.appendChild(errFoot);
  }

  return li;
}

function renderAddForm() {
  const wrap = document.createElement('form');
  wrap.className = 'audience-room__add-form';
  wrap.addEventListener('submit', (e) => {
    e.preventDefault();
    onAddSubmit();
  });

  const keyInput = document.createElement('input');
  keyInput.type = state.hideKeys ? 'password' : 'text';
  keyInput.className = 'audience-room__add-key';
  keyInput.placeholder = t('audience.room.addKeyPlaceholder');
  keyInput.id = 'audience-room-add-key';
  keyInput.required = true;
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  wrap.appendChild(keyInput);

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'audience-room__add-label';
  labelInput.placeholder = t('audience.room.addLabelPlaceholder');
  labelInput.id = 'audience-room-add-label';
  labelInput.autocomplete = 'off';
  wrap.appendChild(labelInput);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'audience-room__add-submit';
  submit.textContent = t('audience.room.addSubmit');
  wrap.appendChild(submit);

  function onAddSubmit() {
    const key = keyInput.value.trim();
    const label = labelInput.value.trim();
    if (!key) return;
    send(makeMessage(ADD_VIEWER, { key, label, offsetMs: 0 }));
    keyInput.value = '';
    labelInput.value = '';
    keyInput.focus();
  }

  return wrap;
}

// --- Helpers ---

// Statuses mirror VIEWER_STATUS in renderer/js/audience-bridge.js. A row
// that does not hold the current video's script (waiting / uploading) is
// never green, and neither is the header while any row is like that.
const RED_STATUSES = new Set(['error', 'disconnected', 'script-failed']);
const AMBER_STATUSES = new Set(['connecting', 'uploading', 'calibrating', 'waiting']);
// Stopped on purpose, nothing wrong: grey.
const GREY_STATUSES = new Set(['no-script', 'speed', 'muted', 'remote-held']);

function aggregateStatus() {
  if (state.viewers.length === 0) return 'dim';
  const statuses = state.viewers.map((v) => v.status);
  if (statuses.some((s) => RED_STATUSES.has(s))) return 'error';
  if (statuses.some((s) => AMBER_STATUSES.has(s))) return 'warning';
  return 'connected';
}

function viewerLedState(v) {
  if (RED_STATUSES.has(v.status)) return 'error';
  if (AMBER_STATUSES.has(v.status)) return 'warning';
  if (v.muted || GREY_STATUSES.has(v.status)) return 'muted';
  return 'connected';
}

// The bridge refuses a test buzz while a viewer plays, is muted, is not
// connected, is being connected or set up, or its last stop failed
// (AudienceBridge._buzzRefusal, FT-119); its button says so by being off.
// An 'error' row with no error code is a connect that failed.
const NO_BUZZ_STATUSES = new Set(['playing', 'connecting', 'calibrating', 'uploading', 'disconnected']);
function canTestBuzz(v) {
  if (v.muted || NO_BUZZ_STATUSES.has(v.status)) return false;
  if (v.status === 'error') return v.errorCode === 'setup-failed' || v.errorCode === 'play-failed';
  return true;
}

/**
 * Why a greyed-out Test buzz is greyed out, for its tooltip (TODO triage
 * 2026-11-23: it said nothing). '' when the status beside it already says
 * (Connecting, Uploading, Disconnected, an error).
 */
export function buzzBlockedTitle(v) {
  if (v.muted) return t('audience.room.testBuzzUnmuteTitle');
  if (v.status === 'playing') return t('audience.room.testBuzzPauseTitle');
  return '';
}

// Resend (FT-121): nothing for a muted viewer, or while it is connecting.
function canResend(v) {
  return !v.muted && v.status !== 'connecting' && v.status !== 'calibrating';
}

const ERROR_TEXT_KEYS = {
  'stop-failed': 'audience.room.errorStopFailed',
  'setup-failed': 'audience.room.errorSetupFailed',
  'play-failed': 'audience.room.errorPlayFailed',
};

function viewerErrorText(v) {
  const key = v.errorCode && ERROR_TEXT_KEYS[v.errorCode];
  return key ? t(key) : (v.lastError || '');
}

function viewerStatusLabel(v) {
  if (v.muted) return t('audience.room.statusMuted');
  switch (v.status) {
    case 'connecting':   return t('audience.room.statusConnecting');
    case 'uploading':    return t('audience.room.statusUploading');
    case 'calibrating':  return t('audience.room.statusCalibrating');
    case 'synced':       return t('audience.room.statusSynced');
    case 'waiting':      return t('audience.room.statusWaiting');
    case 'ready':        return t('audience.room.statusReady');
    case 'remote-held':  return t('audience.room.statusRemoteHeld');
    case 'no-script':    return t('audience.room.statusNoScript');
    case 'speed':        return t('audience.room.statusSpeed', { rate: v.rate ?? '' });
    case 'script-failed': return t('audience.room.statusScriptFailed');
    case 'playing':
      return v.rtdMs != null
        ? t('audience.room.statusPlayingWithRtd', { rtd: v.rtdMs })
        : t('audience.room.statusPlaying');
    case 'paused':       return t('audience.room.statusPaused');
    case 'muted':        return t('audience.room.statusMuted');
    case 'error':        return t('audience.room.statusError');
    case 'disconnected': return t('audience.room.statusDisconnected');
    default:             return v.status;
  }
}

// --- Message dispatch from main ---

function onMessage(payload) {
  const type = classifyMessage(payload);
  if (!type) return;

  switch (type) {
    case INITIAL_STATE: {
      state.roomActive = !!payload.roomActive;
      state.viewers = Array.isArray(payload.viewers) ? payload.viewers : [];
      state.hideKeys = payload.hideKeys !== false;
      state.theme = payload.theme || 'dark';
      state.locale = payload.locale || 'en';
      applyTheme(state.theme);
      applyStyle(payload.uiStyle); applyPopoutSeason(payload.season);
      // (Re-)load the locale bundle for the pop-out. If we picked the
      // same locale we already have, this is a quick no-op.
      setLocale(state.locale).then(() => {
        _i18nReady = true;
        render();
      }).catch((err) => {
        // Fallback so the UI isn't blocked forever if a locale fetch fails.
        // eslint-disable-next-line no-console
        console.warn('[audience-room] setLocale failed:', err);
        _i18nReady = true;
        render();
      });
      break;
    }
    case VIEWER_ADDED: {
      if (!state.viewers.find((v) => v.key === payload.viewer.key)) {
        state.viewers.push(payload.viewer);
      }
      render();
      break;
    }
    case VIEWER_REMOVED: {
      state.viewers = state.viewers.filter((v) => v.key !== payload.key);
      render();
      break;
    }
    case VIEWER_STATUS: {
      const v = state.viewers.find((vv) => vv.key === payload.key);
      if (v) {
        v.status = payload.status;
        if (payload.rtdMs !== undefined) v.rtdMs = payload.rtdMs;
        if (payload.lastError !== undefined) v.lastError = payload.lastError;
        if (payload.errorCode !== undefined) v.errorCode = payload.errorCode;
        if (payload.rate !== undefined) v.rate = payload.rate;
        // The row and the Mute / Unmute button read `muted`. Never mirrored
        // until 2026-11-04 (since v0.9.2), so after Mute the button still
        // said "Mute", sent mute again, and the viewer could not be unmuted.
        if (payload.muted !== undefined) v.muted = !!payload.muted;
        render();
      }
      break;
    }
    case VIEWER_OFFSET: {
      const v = state.viewers.find((vv) => vv.key === payload.key);
      if (v) {
        v.offsetMs = payload.offsetMs;
        render();
      }
      break;
    }
    case HIDE_KEYS_CHANGED: {
      state.hideKeys = !!payload.hideKeys;
      render();
      break;
    }
    case THEME: {
      applyTheme(payload.theme);
      applyStyle(payload.uiStyle); applyPopoutSeason(payload.season);
      break;
    }
  }
}

// --- Bootstrap ---

window.funsync.onAudiencePopoutEvent((evt) => {
  if (!evt) return;
  if (evt.type === 'opened') {
    send(makeMessage(READY));
    return;
  }
  if (evt.type === 'closed') return;
  if (evt.type === 'message') onMessage(evt.payload);
});

// Boot-time i18n init — sets a sane English baseline so the first
// paint doesn't show raw key constants. INITIAL_STATE will switch to
// the streamer's chosen locale shortly after.
initI18n({ savedLocale: 'en' }).then(() => {
  _i18nReady = true;
  // Initial READY in case the opened event fired before this listener
  // registered (race-safe).
  send(makeMessage(READY));
  // Defer first render — onMessage will trigger it once INITIAL_STATE
  // arrives with the real locale. If INITIAL_STATE never arrives (main
  // window crash or relay broken), we still want SOMETHING visible.
  render();
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.warn('[audience-room] initI18n failed, using raw keys:', err);
  _i18nReady = true;
  send(makeMessage(READY));
  render();
});
