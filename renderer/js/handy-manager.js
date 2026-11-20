// HandyManager — Wrapper around @ohdoki/handy-sdk for device connection and control

import { t } from './i18n.js';
import { clampVideoSyncOffset, deviceOffsetWithVideoDelta } from './video-sync-offset.js';

// SDK module reference — loaded dynamically via relative path to the ESM bundle
// (bare specifier '@ohdoki/handy-sdk' fails in Electron renderer with contextIsolation)
let HandySDK = null;

/** Mask a connection key for logging — keys are passwords and logs get
 *  shared when users report problems. Last 4 chars only. */
function maskKey(k) {
  const s = String(k || '');
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

// --- HSSP call timing ------------------------------------------------------
//
// Measured across two user logs: a healthy HSSP round trip lands in 1.4-2.5s.
// Welliambrisk's log (2026-08-27) has an hsspPlay that took 20.59s and an
// hsspStop that took 17.08s — and BOTH eventually returned success, so no
// amount of error handling could have caught them. What is needed is a
// deadline, not a better catch block.
const HSSP_CALL_TIMEOUT_MS = 5000;
// setScript is a genuine multi-step handshake (download + verify on the
// device); the same log shows legitimate ones at 2.4s and 8.1s. Time-boxed
// well above that, purely so a hung one cannot wedge the chain forever.
const HSSP_SETUP_TIMEOUT_MS = 15000;
// A command still unanswered at this point is worth telling the user about,
// well before it times out. "Connected" while nothing lands is the lie that
// made Welliambrisk send a log instead of reading the UI.
const HSSP_SLOW_COMMAND_MS = 3000;
// The SDK throttles each command name (handy.esm.js `#f`, `throttleDelay`
// 200 ms): a call made while the previous call of that name is in flight, or
// within 200 ms of it SETTLING, is handed that call's promise, and its own
// request goes out 200 ms later. The HSSP chain issues the next setScript the
// instant the previous one settles, so a second script set back to back (Next
// pressed during a setScript) was answered with the FIRST script's result
// while its own request had not even left: the caller started playing on the
// old script (FT-116, found with the fake SDK 2026-11-16). setScript waits
// the window out, with a margin for timer order.
const SDK_SETSCRIPT_SPACING_MS = 220;
// The same window for hsspPlay and hsspStop (block F review, 2026-11-16; also
// in v0.9.2). A play inside the last play's window (start() and the
// element's own 'playing' 1 ms apart, a re-anchor right after a play) was
// answered at once with the previous play's result while its own request
// left 200 ms later; a pause in between sent its stop at once, so the device
// got play, stop, PLAY and ran the script under a paused video. A stop inside
// the last stop's window went out after the play queued behind it (two quick
// seeks), stopping a playing device. Each now waits the window out inside the
// HSSP chain, and a play re-checks for a stop after that wait.
const SDK_HSSP_SPACING_MS = 220;
// A play handed to the SDK while the previous hsspPlay is still unanswered
// cannot keep out of that window (a hung play would hold it forever): the
// SDK answers with the old call's promise and sends the new play
// `throttleDelay` later. A stop sent straight to the cloud (FT-124) in
// between left BEFORE that play, so the device got stop, then PLAY, and kept
// playing under a paused video (bf-review BF-R1, 2026-11-19; new since
// v0.9.2, with the direct stop). A stop now waits until such a play has left,
// at most the SDK's throttleDelay plus this margin for timer order, so the
// stop is always the last word and still leaves within ~250 ms.
const SDK_DEFERRED_PLAY_MARGIN_MS = 50;
/** What _sdkHssp answers for a call it dropped after waiting the window out. */
const SDK_CALL_DROPPED = Symbol('sdk-call-dropped');
// HDSP moves go out the same way (fix-up after block F verify-1, 2026-11-16;
// new since v0.9.2 in effect: the HDSP engine only runs since the bare-timer
// fix). The HDSP engine calls hdspMove every ~33 ms without waiting. Handed
// straight to the SDK, each call inside the window got the previous call's
// promise and the SDK kept the newest on a timer of its own, sent 200 ms
// after the ticks stopped: back at 1x it landed AFTER the HSSP setup and
// play, the SDK switched the device to mode 2 for it, and the Handy stopped
// following the script until the 2.5 s correction (~2.2 s on the stub
// cloud); after a pause it sent one move past the stop. hdspMove now sends
// one call at a time, outside the window, with the newest position, and
// drops a move that a halt or any HSSP request overtook. The longest an HSSP
// play / setup waits for an HDSP mode switch of ours still travelling:
const HDSP_QUIET_MAX_MS = 1500;
// Errors the SDK throws from its own checks BEFORE `#f` (handy.esm.js: `#p`
// no key, `#_` firmware, hsspPlay's scriptSet check): no request, no window.
const SDK_LOCAL_REFUSAL = /no device connected|update required|script\s*set\s*is\s*required/i;

/**
 * FNV-1a over the script text. Only ever compared against another hash of the
 * same function, so the choice is about speed and collision-resistance, not
 * interop: a false "same" would silently leave the OLD script on the device,
 * which is why this hashes the whole string rather than sampling it.
 */
function hashScriptContent(s) {
  const str = String(s ?? '');
  if (!str) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Length guards the narrow case where two different scripts collide on the
  // 32-bit hash but differ in size, which is most of them.
  return `${str.length}:${(h >>> 0).toString(16)}`;
}

/**
 * Multiplier from FunSync's 0-100 position to the v2 /hdsp/xpt `position`
 * this device expects: 1 on firmware 1-3 (0-100, as the v2 spec says), 0.01
 * on firmware 4+ (a 0-1 fraction, measured on fw 4.2.1, 2026-11-04). Null
 * when the firmware is unknown — the caller must not guess, since 0-100 on
 * FW4 drives the slider into its end stop.
 * @param {{fwVersion?: string, fwMajor?: number}|null|undefined} info
 * @returns {number|null}
 */
export function hdspPositionScale(info) {
  if (!info) return null;
  let major = Number(info.fwMajor);
  if (!Number.isFinite(major) || major <= 0) {
    const m = /^\s*v?(\d+)/.exec(String(info.fwVersion ?? ''));
    major = m ? Number(m[1]) : NaN;
  }
  if (!Number.isFinite(major) || major <= 0) return null;
  return major >= 4 ? 0.01 : 1;
}

/**
 * Upload a raw funscript to the Handy script host and return its URL, with
 * no device and no connection key (the SDK's free `uploadDataToServer`, a
 * plain multipart POST). The audience room uploads each viewer script ONCE
 * this way and sets that URL on every viewer, so it works with no streamer
 * Handy connected (#361). Same contract as HandyManager: null on failure,
 * never throws.
 * @param {string} funscriptContent - Raw funscript JSON string
 * @returns {Promise<string|null>}
 */
export async function uploadScriptToCloud(funscriptContent) {
  try {
    if (!HandySDK) HandySDK = await import('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js');
    if (!HandySDK?.uploadDataToServer) return null;
    const url = await HandySDK.uploadDataToServer(funscriptContent);
    return typeof url === 'string' && url ? url : null;
  } catch (err) {
    console.warn('[Handy] Keyless script upload failed:', err?.message || err);
    return null;
  }
}

export class HandyManager {
  constructor() {
    this._handy = null;
    this._connectionKey = '';
    this._connected = false;
    this._deviceInfo = null;
    this._syncQuality = null;
    this._lastCloudUrl = null; // last uploaded script URL (for re-setup after mode switch)
    // HSTP offset = the global `handy.defaultOffset` (setOffset) plus the
    // current video's own delta (setVideoOffset, `library.syncOffsets`,
    // #380). The delta is 0 unless a video has one, so the device gets
    // exactly the global value, as before. Its sign on the Handy is the
    // app's convention, pending a hardware check (video-sync-offset.js
    // VIDEO_SYNC_OFFSET_DEVICE_SIGN).
    this._globalOffsetMs = null;
    this._videoOffsetMs = 0;
    // Tracks the device's current SDK mode (0=HAMP, 1=HSSP, 2=HDSP) so hdspMove
    // can lazily switch INTO HDSP before its first send. Without this, driving
    // HDSP straight after an hsspStop (e.g. the Orgasm Switch) left the device
    // in HSSP mode with the HDSP commands ignored — "it just stops the device".
    this._mode = null;
    this._hdspErrorLogged = false;
    // --- HDSP moves (see HDSP_QUIET_MAX_MS above and hdspMove) -----------
    // Bumped by hdspHalt() and by every HSSP request: a move asked for
    // before it is not sent after it.
    this._hdspEpoch = 0;
    // The newest move not sent yet ({devicePosition, durationMs, epoch}).
    this._hdspWanted = null;
    this._hdspPumping = false;
    this._hdspPumpPromise = Promise.resolve();
    // When the last SDK hdsp call settled; the next keeps this far from it.
    this._hdspSettledAt = null;
    this._hdspSpacingMs = SDK_HSSP_SPACING_MS;
    // A setMode(2) of ours still travelling, and when the last one settled:
    // an HSSP play / setup waits it out (SDK's setMode window, _hdspQuiet).
    this._hdspModeStep = null;
    this._hdspModeSettledAt = null;
    this._hdspQuietMaxMs = HDSP_QUIET_MAX_MS;

    // --- HSSP call serialisation ---------------------------------------
    //
    // Every HSSP call is a cloud round trip taking 200-750ms. Mashing X and Z
    // fires an engage/release pair per press, so a few quick presses put
    // several of them in flight at once — and under that pile-up the cloud
    // started returning "Device timeout", after which the device had lost its
    // mode setup and stopped following the video (Dave, 2026-08-21).
    //
    // One at a time, in order. The device has a single state machine and there
    // is no version of "two overlapping mode-setup calls" that is coherent.
    this._hsspChain = Promise.resolve();
    // Bumped by every enqueue. A queued PLAY whose generation is stale by the
    // time it reaches the front is pointless — a newer play or a stop has
    // already superseded it — so it is dropped rather than sent. Stops are
    // never dropped: skipping one leaves the device running.
    this._hsspGen = 0;
    // How many PLAY calls are executing right now (0 or 1 in practice). A stop
    // arriving while a play is in flight jumps the queue instead of waiting
    // for it — see _hsspExclusive.
    this._playInFlight = 0;
    // FT-124 (Dave's Handy 2026-11-17): a stop goes ahead of everything that
    // is only QUEUED, not just ahead of a play in flight (_hsspExclusive).
    // The play or setup executing in the chain now ({ kind, done }), how many
    // chain entries are still waiting their turn, how many stops are asked
    // for and not finished, and a promise that settles once every stop asked
    // for so far has finished (stops run one at a time, in order).
    this._hsspActive = null;
    this._hsspQueued = 0;
    this._stopsPending = 0;
    this._stopTail = Promise.resolve();
    // The stop request itself goes straight to the cloud, not into the SDK's
    // request queue (FT-124, _directHsspStop). Wrapped, never stored bare: a
    // browser fetch called with this object as its receiver throws "Illegal
    // invocation" in Chromium (feedback_bare_browser_timer_illegal_invocation).
    this._fetchImpl = (url, init) => globalThis.fetch(url, init);
    // Bumped by every stop REQUEST, before it is queued or run. A play that
    // was already in flight reads this to find out whether the user has since
    // paused, so its self-heal retry cannot restart a device the user stopped.
    this._stopEpoch = 0;
    // What the last HSSP REQUEST asked the device to do, from any caller:
    // true after a play is asked for, false after a stop, null = unknown (a
    // new connection may find the device still playing from before). Set at
    // request time, so a play still in flight already counts as running.
    // SyncEngine reads it to skip a stall's stop when nothing plays (N-01).
    this._hsspMayRun = null;
    // Deadlines, on the instance so tests can shorten them.
    this._hsspTimeoutMs = HSSP_CALL_TIMEOUT_MS;
    this._hsspSetupTimeoutMs = HSSP_SETUP_TIMEOUT_MS;
    this._slowCommandMs = HSSP_SLOW_COMMAND_MS;
    // When the last SDK setScript settled, and how long to keep the next one
    // back from it (SDK_SETSCRIPT_SPACING_MS above).
    this._setScriptSettledAt = null;
    this._setScriptSpacingMs = SDK_SETSCRIPT_SPACING_MS;
    // Per SDK command name ('hsspPlay', 'hsspStop'): how many calls the SDK
    // has not answered yet, and when the last one settled (SDK_HSSP_SPACING_MS).
    this._sdkSlots = {};
    this._hsspSpacingMs = SDK_HSSP_SPACING_MS;
    // When a play the SDK is holding back (SDK_DEFERRED_PLAY_MARGIN_MS) will
    // have left; a stop is not sent before then (_waitForDeferredSdkPlay).
    this._sdkPlayDeferredUntil = 0;
    // Hash of the funscript last uploaded, so an unchanged script is not
    // re-uploaded and re-set on every pause/resume/variant cycle.
    this._lastScriptHash = null;
    // Bumped by every uploadAndSetScript call before its first await. An
    // upload that finishes after a newer one started is never set (FT-116).
    // app.js reads it through `uploadSeq` to tell "superseded" from "failed".
    this._uploadSeq = 0;
    // FT-118 (new since v0.9.2), OFF until measured on a device: back at 1x
    // after an HDSP excursion, ask the device to play on the HSSP setup it
    // may still hold before re-setting the cached script. See
    // _playOnKeptHsspSetup; Dave's Handy decides whether it goes on.
    this._reuseHsspSetupAfterHdsp = false;
    // Device-info re-reads after a connect that left no firmware (FT-117).
    this._deviceInfoRetries = 3;
    this._deviceInfoRetryMs = 500;
    // Bumped by every connect and disconnect, so a re-read still waiting
    // from an earlier connection stands down.
    this._connectEpoch = 0;
    // What onDeviceInfo last announced, so the SDK's 'connect' event and
    // connect() itself do not announce the same info twice.
    this._announcedInfoKey = null;

    // --- Slow-command tracking -----------------------------------------
    //
    // Distinct from `_responsive`, which is pass/fail. A command that has not
    // answered yet has neither passed nor failed, and that in-between state is
    // exactly the one the user needs to see: the app knew the device had gone
    // quiet for twenty seconds and showed "Connected" throughout.
    this._slow = false;
    this._slowTimer = null;
    this._slowDepth = 0;

    // Cloud-reachability health check. The SDK's 'disconnect' event only
    // fires for client-side socket drops — it does NOT fire when the
    // physical Handy switches to BT mode (the SDK's HTTP session stays
    // alive, only the cloud → device path breaks). Without this poll,
    // `_connected` stayed `true` after a BT-mode switch and the UI kept
    // showing the WiFi connection as live alongside the newly-enumerated
    // Buttplug BT device.
    this._healthCheckInterval = null;
    this._healthCheckIntervalMs = 10000;
    // A poll still unanswered (FT-124): the next tick sends nothing.
    this._healthCheckInFlight = false;

    // --- Responsiveness ------------------------------------------------
    //
    // `_connected` answers "did we ever complete a handshake, and does the
    // 10s cloud poll still say the device is there". It does NOT answer "is
    // this thing actually doing what we tell it", and those come apart
    // constantly: the device rejects every command while `_connected` stays
    // true, so the UI reads Connected and the user's only clue is that
    // nothing moves (Dave, 2026-08-26: "there have been times when its lost
    // connection or something is wrong but the ui just says connected").
    //
    // So track the outcome of real commands separately. `true` until proven
    // otherwise — a device we have not asked to do anything is not broken.
    this._responsive = true;
    // Set by disconnect(), cleared by an explicit connect(). Guards against
    // the SDK bringing its own session back and undoing a deliberate
    // disconnect. See the 'connect' handler in init().
    this._userDisconnected = false;

    // Callbacks
    this.onStateChange = null;   // (state) => {}
    this.onConnect = null;       // () => {}
    this.onDisconnect = null;    // () => {}
    this.onError = null;         // (error) => {}
    // (responsive: boolean) => {} — fired only on a CHANGE, so a run of
    // failures does not spam the UI and a run of successes does not either.
    this.onResponsivenessChange = null;
    // (info) => {} — device info (firmware, model) has arrived. Separate from
    // onConnect because it lands AFTER it; see _fetchDeviceInfo.
    this.onDeviceInfo = null;
    // (slow: boolean) => {} — a command has been in flight longer than
    // `_slowCommandMs`, or everything has caught up again. Fired only on a
    // change, like onResponsivenessChange.
    this.onSlownessChange = null;
  }

  /**
   * Initialize the Handy SDK. Must be called before any other method.
   */
  async init() {
    try {
      // Use relative path to the ESM bundle — bare specifiers don't work in browser context
      HandySDK = await import('../../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js');

      this._handy = HandySDK.init({
        syncClientServerTime: true,
        syncClient: { syncCount: 30, outliers: 10 },
        syncHandy: { syncCount: 30, outliers: 10 },
      });

      // Subscribe to state changes
      this._handy.on('state', ({ state, change }) => {
        if (this.onStateChange) this.onStateChange(state, change);
      });

      this._handy.on('connect', () => {
        // Ignore an SDK-initiated reconnect after the user pressed Disconnect.
        // The SDK keeps its own session and can bring it back on its own;
        // accepting that silently undoes an explicit user action, which is
        // what "it seems to auto reconnect after pressing disconnect" is
        // (Dave, 2026-08-26). Only an explicit `connect()` clears the flag.
        if (this._userDisconnected) {
          console.log('[Handy] Ignoring SDK reconnect — user disconnected on purpose');
          return;
        }
        this._connected = true;
        // The SDK has stored the device info by the time it fires 'connect'
        // (handy.esm.js connect: info read, updateState, then the event), so
        // take it now. The connect log line and the panel read it in
        // onConnect and, before FT-117, always found null: this handler runs
        // inside the SDK's connect, before connect() below reaches its own
        // read, and an SDK-initiated reconnect never reached one at all.
        // No await inside _fetchDeviceInfo: it has finished on return.
        this._fetchDeviceInfo();
        this._startHealthCheck();
        if (this.onConnect) this.onConnect();
      });

      this._handy.on('disconnect', () => {
        this._stopHealthCheck();
        this._connected = false;
        this._deviceInfo = null;
        this._announcedInfoKey = null;
        this._connectEpoch++;   // a device-info re-read still waiting stands down
        if (this.onDisconnect) this.onDisconnect();
      });

      console.log('Handy SDK initialized');
    } catch (err) {
      console.warn('Failed to initialize Handy SDK:', err.message);
      throw err;
    }
  }

  /**
   * Connect to a Handy device using the connection key. One-shot —
   * callers who want retries should handle it themselves. We deliberately
   * don't retry in here because an offline Handy is almost always a
   * device-side or cloud-side issue (LED in wrong mode, WiFi creds stale,
   * handyfeeling down) that the app can't resolve by retrying harder.
   *
   * @param {string} connectionKey
   * @returns {boolean} True if connected successfully
   */
  async connect(connectionKey) {
    if (!this._handy) {
      this._emitError('SDK not initialized');
      return false;
    }

    this._connectionKey = connectionKey;
    // Explicit request — the user wants a connection again.
    this._userDisconnected = false;

    console.log(`[Handy] connect(${maskKey(connectionKey)}) — requesting…`);
    try {
      const result = await this._handy.connect(connectionKey);
      // ConnectResult: 0 = NOT_CONNECTED, 1 = CONNECTED
      const code = typeof result === 'number' ? result : result?.result;
      console.log(`[Handy] connect result code: ${code} (1 = connected, 0 = not connected)`);
      if (code === 1) {
        this._connected = true;
        // After the SDK's connect (and its 'disconnect' event for an old
        // session, which bumps the epoch too), so this re-read is current.
        const epoch = ++this._connectEpoch;
        await this._fetchDeviceInfo();
        // No firmware yet (a manual reconnect read 'unknown', FT-117): read
        // it again in the background, so the panel, the log and hdspMove
        // (which sends nothing on unknown firmware) all get it. Not awaited:
        // the connection itself is fine.
        if (!this._deviceInfo?.fwVersion) {
          this._retryDeviceInfo(epoch).catch((err) => {
            console.warn('[Handy] Device info re-read failed:', err?.message || err);
          });
        }
        this._startHealthCheck();
        // What the device is doing right now, so the first video change
        // after a connect sends no stop to a device standing still (FN-01
        // follow-up). In the background: until it answers, unknown = stop.
        this._readHsspStateAfterConnect(epoch).catch((err) => {
          console.warn('[Handy] Device status read failed:', err?.message || err);
        });
        console.log('[Handy] connected — device reachable via cloud');
        return true;
      } else {
        this._emitError(t('error.handyConnectionFailed'));
        return false;
      }
    } catch (err) {
      this._emitError(`Connection error: ${err.message}`);
      return false;
    }
  }

  /**
   * Disconnect from the device.
   */
  async disconnect() {
    if (!this._handy) return;

    // Remember that the user asked for this. The SDK can re-establish its own
    // session afterwards and fire `connect` again; without this flag we accept
    // that and quietly reconnect a device the user just switched off, which
    // reads as the Disconnect button not working (Dave, 2026-08-26).
    this._userDisconnected = true;

    // Stop polling first so a tick mid-disconnect can't resurrect state.
    this._stopHealthCheck();

    try {
      await this._handy.disconnect();
    } catch (err) {
      console.warn('Disconnect error:', err.message);
    }
    this._connected = false;
    this._deviceInfo = null;
    this._announcedInfoKey = null;
    this._connectEpoch++;   // a device-info re-read still waiting stands down
    // A fresh connection starts from a clean bill of health.
    this._noteCommandResult(true);
    this._resetCommandState();

    // TELL SOMEONE. This used to flip `_connected` and return, so every
    // consumer kept displaying whatever it last saw — measured live: the
    // manager reporting `connected: false` while the panel sat on "Connected"
    // for as long as you cared to watch. That is precisely the "the UI just
    // says connected" complaint, and it was coming from the app, not the
    // device. Callers that already update their own status simply get a
    // harmless second update.
    if (this.onDisconnect) this.onDisconnect();
  }

  /**
   * Fetch device info (firmware, model, etc.)
   */
  async _fetchDeviceInfo() {
    try {
      const state = this._handy.getState();
      this._setDeviceInfo(state?.info || null);
    } catch (err) {
      console.warn('Failed to get device info:', err.message);
    }
  }

  /**
   * Keep `info` and announce it when it says something new. An empty read
   * never wipes info this connection already has (FT-117); a disconnect
   * clears it.
   * @param {object|null} info
   */
  _setDeviceInfo(info) {
    if (info) this._deviceInfo = info;
    const cur = this._deviceInfo;
    if (!cur) return;
    // ANNOUNCE IT. The SDK's `connect` event used to fire before this ran, so
    // any listener that renders device info on connect found `deviceInfo`
    // still null, bailed on its own guard, and was never told when the data
    // landed. Measured 2026-08-26: the panel showed firmware "—" while
    // `handy.deviceInfo.fwVersion` was "4.2.1+ca4dd961" — calling the panel's
    // refresh by hand at that moment populated it instantly, which is what
    // identified this as a race rather than a missing call. Once per change,
    // so the 'connect' event and connect() do not announce it twice.
    const key = `${cur.fwVersion ?? ''}|${cur.model ?? ''}|${cur.fwStatus ?? ''}`;
    if (key === this._announcedInfoKey) return;
    this._announcedInfoKey = key;
    if (this.onDeviceInfo) this.onDeviceInfo(cur);
  }

  /**
   * Read the device info again after a connect that left no firmware
   * version: the SDK's state first, then the SDK's own info call (the one its
   * connect makes; it stores the answer in the state, where the SDK's own
   * firmware check reads it). Stops once the firmware is known, on a
   * disconnect, or when a newer connect has begun. Without the firmware
   * hdspMove sends nothing, so the Test pulse and every non-1x rate stood
   * still, and the connect log said "firmware unknown" (FT-117).
   * @param {number} epoch - `_connectEpoch` of the connect that asked
   */
  async _retryDeviceInfo(epoch) {
    const live = () => epoch === this._connectEpoch && this._connected && !!this._handy;
    for (let i = 0; i < this._deviceInfoRetries; i++) {
      await new Promise((r) => setTimeout(r, this._deviceInfoRetryMs));
      if (!live()) return;
      if (this._deviceInfo?.fwVersion) return;
      let info = this._handy.getState?.()?.info || null;
      if (!info?.fwVersion && this._connectionKey && this._handy.API?.get?.info) {
        try {
          info = (await this._handy.API.get.info(this._connectionKey)) || info;
        } catch (err) {
          console.warn(`[Handy] Device info re-read ${i + 1}/${this._deviceInfoRetries} failed:`, err?.message || err);
        }
        if (!live()) return;
      }
      if (info?.fwVersion) {
        console.log(`[Handy] Device info arrived on re-read ${i + 1} — firmware ${info.fwVersion}`);
        this._setDeviceInfo(info);
        return;
      }
    }
    if (live() && !this._deviceInfo?.fwVersion) {
      console.warn(`[Handy] Firmware version still unknown after ${this._deviceInfoRetries} re-reads — HDSP moves stay off`);
    }
  }

  /**
   * Read the device's status once after a connect and settle what
   * `hsspMayBeRunning` claims (FN-01 follow-up, found reading FN-01).
   *
   * A new connection starts at null (unknown), and a video change stops
   * the Handy whenever that is not false (app.js loadVideo, FN-01), so the
   * first video opened after every connect sent one hsspStop, and with the
   * SDK's mode not known yet that stop was a mode switch plus a stop, ahead
   * of the new video's setScript. The device may really still be playing
   * from an earlier session, so the stop is skipped only on the device's
   * own word: HSSP and not playing (needs sync, needs setup, stopped), or
   * HAMP stopped, read now. HSSP PLAYING makes it true. Anything else (HDSP,
   * no answer, an unknown state) leaves it as it was: unknown = stop.
   *
   * Applied only while nothing has been asked of the device since the read
   * began, and only for this connection: a play or stop asked for meanwhile
   * is newer news than the read.
   * @param {number} epoch - `_connectEpoch` of the connect that asked
   */
  async _readHsspStateAfterConnect(epoch) {
    const read = this._handy?.API?.get?.status;
    if (typeof read !== 'function' || !this._connectionKey) return;
    const gen = this._hsspGen;
    const busy = () => this._hsspActive !== null || this._hsspQueued > 0 || this._stopsPending > 0;
    if (busy()) return;
    // `true`: the SDK's own state is left alone (noStateUpdate).
    const status = await read(this._connectionKey, true);
    if (epoch !== this._connectEpoch || !this._connected || gen !== this._hsspGen || busy()) return;
    const mode = Number(status?.mode);
    const state = Number(status?.state);
    if (mode === 1 && state === 4) {
      this._hsspMayRun = true;
      console.log('[Handy] Device reports HSSP PLAYING from before this connection — the next video change stops it');
      return;
    }
    if ((mode === 1 && (state === 1 || state === 2 || state === 3)) || (mode === 0 && state === 1)) {
      this._hsspMayRun = false;
      console.log(`[Handy] Device reports it is standing still (mode ${mode}, state ${state}) — no stop needed before the first video`);
    }
  }

  /**
   * Run HSTP time synchronization.
   * @param {number} syncCount - Number of sync rounds (default 30)
   * @returns {Object|null} Sync result with RTD and offset
   */
  async syncTime(syncCount = 30) {
    if (!this._handy || !this._connected) return null;

    try {
      await this._handy.sync(
        { syncCount, outliers: Math.floor(syncCount / 3) },
        { syncCount, outliers: Math.floor(syncCount / 3) },
      );

      const latency = this._handy.getClientServerLatency();
      this._syncQuality = {
        avgOffset: latency?.avgOffset || 0,
        avgRtd: latency?.avgRtd || 0,
        lastSyncTime: latency?.lastSyncTime || Date.now(),
      };

      return this._syncQuality;
    } catch (err) {
      this._emitError(`Time sync failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Set up a script on the device from a URL.
   * @param {string} scriptUrl - URL to the CSV script (must be publicly accessible)
   * @returns {boolean} True if setup succeeded
   */
  /**
   * Run an HSSP operation with no other HSSP operation in flight.
   *
   * @param {'play'|'stop'|'setup'} kind — 'play' may be dropped when stale
   * @param {(gen: number) => Promise<any>} fn - called with this request's
   *   own `_hsspGen`, taken when it was ASKED for (a stop may run later,
   *   behind a setup or an earlier stop; bf-review BF-R2)
   * @param {any} skipValue — returned if the call is dropped as superseded
   */
  _hsspExclusive(kind, fn, skipValue) {
    const gen = ++this._hsspGen;
    // An HDSP move asked for before this request is never sent after it
    // (the stray move + mode 2 back at 1x, fix-up after verify-1).
    this.hdspHalt();
    // Announce the stop INTENT before it is queued, not when it runs. An
    // hsspPlay already in flight polls this to find out that the user has
    // paused — see the self-heal branch in _hsspPlayImpl.
    if (kind === 'stop') this._stopEpoch++;

    // A stop must never wait behind a play.
    //
    // The play's command has ALREADY left for the cloud; the promise we would
    // be queueing behind carries no further traffic, only its answer. Waiting
    // for that answer buys nothing and costs the user however long it takes.
    // Welliambrisk's log (2026-08-27): an hsspPlay took 20.59s to answer and
    // held his pause's stop for the whole of it — every `[Sync] hsspPlay at …`
    // line with no `[Handy] hsspPlay(…)` beside it is a call sitting in this
    // queue, and his stop was sitting in it too while the device stroked on.
    //
    // Nor behind anything that is only QUEUED (FT-124, Dave's Handy
    // 2026-11-17, every cloud request 4 s late): a play queued ahead of the
    // stop is dropped as superseded anyway (the gen check below), and a setup
    // queued ahead of it runs after it.
    //
    // Nor behind a setup that is RUNNING (Dave, 2026-11-20: "stop it at
    // once"). Until then a running setup was not pre-empted, for fear of the
    // 2026-08-21 "stopped following the video" (a pile-up of engage/release
    // pairs that left the device without its mode setup). But waiting cost
    // a pause the whole setup: on Dave's Handy, with the setup slowed 4 s,
    // the slider stroked on ~4 s after Space (device session step 43; up to
    // the 15 s setup deadline on a slow cloud). So the stop goes out now. A
    // setup it makes fail answers `false` to its caller as any failed setup
    // does (the Audience bridge sets it again; see _setupScriptImpl), and a
    // device left without its setup is re-set by the main script's next play
    // (_hsspPlayImpl's self-heal). Plays stay queued behind the setup, so
    // none can start the device under it. A stop still waits for an earlier
    // stop (one stop at a time).
    if (kind === 'stop') {
      const active = this._hsspActive;
      if (active?.kind === 'play') console.log('[Handy] hsspStop pre-empting an in-flight play');
      if (active?.kind === 'setup') console.log('[Handy] hsspStop going ahead of a running script setup');
      if (this._hsspQueued > 0) console.log(`[Handy] hsspStop going ahead of ${this._hsspQueued} queued request(s)`);
      const wait = this._stopTail;
      this._stopsPending++;
      const run = wait.then(async () => {
        this._beginCommand();
        try {
          return await fn(gen);
        } finally {
          this._endCommand();
          this._stopsPending--;
        }
      });
      // Never rejects, so one failed stop cannot wedge the next one.
      this._stopTail = run.then(() => {}, () => {});
      return run;
    }

    this._hsspQueued++;
    const run = this._hsspChain.then(async () => {
      this._hsspQueued--;
      // A stop asked for while this waited went ahead of it: let it finish
      // first, so nothing queued races a stop back to the device.
      while (this._stopsPending > 0) await this._stopTail;
      // Only a play is safe to drop: a stop that never runs leaves hardware
      // moving, and a setup that never runs leaves the device unusable.
      if (kind === 'play' && gen !== this._hsspGen) {
        console.log(`[Handy] hsspPlay dropped — superseded while queued`);
        return skipValue;
      }
      let release;
      const entry = { kind, done: new Promise((r) => { release = r; }) };
      this._hsspActive = entry;
      if (kind === 'play') this._playInFlight++;
      this._beginCommand();
      try {
        return await fn(gen);
      } finally {
        this._endCommand();
        if (kind === 'play') this._playInFlight--;
        if (this._hsspActive === entry) this._hsspActive = null;
        release();
      }
    });
    // Keep the chain alive even when a link rejects, or one failure would
    // wedge every later HSSP call in this session.
    this._hsspChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Reject if `promise` has not settled within `ms`.
   *
   * The underlying SDK call keeps running — there is no way to recall a cloud
   * request — this only stops US waiting on it. That distinction is the whole
   * point: the command reached the device long ago, and the only thing the
   * unanswered promise still holds up is the serial chain behind it.
   *
   * `onLate(value)` runs when the call answers AFTER the deadline rejected:
   * a late answer is still an answer (feedback_deadline_before_catch_block).
   */
  _withHsspTimeout(promise, label, ms = this._hsspTimeoutMs, onLate = null) {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        timedOut = true;
        const err = new Error(`${label} timed out after ${ms}ms`);
        // Tagged rather than message-matched: the message is a diagnostic for
        // the log, and the user-facing text must not be derived from it.
        err.hsspTimeout = true;
        reject(err);
      }, ms);
      promise.then(
        (v) => {
          if (timedOut && onLate) {
            try { onLate(v); } catch (err) { console.warn(`[Handy] ${label} late answer handler failed:`, err?.message || err); }
          }
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(v);
        },
        (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
      );
    });
  }

  /** A device command has started. Arms the slow-command watchdog. */
  _beginCommand() {
    this._slowDepth++;
    if (this._slowTimer) return;
    this._slowTimer = setTimeout(() => {
      this._slowTimer = null;
      if (this._slowDepth > 0) this._setSlow(true);
    }, this._slowCommandMs);
  }

  /** A device command has settled. Clears "slow" once nothing is outstanding. */
  _endCommand() {
    this._slowDepth = Math.max(0, this._slowDepth - 1);
    if (this._slowDepth > 0) return;
    clearTimeout(this._slowTimer);
    this._slowTimer = null;
    this._setSlow(false);
  }

  _setSlow(next) {
    const val = !!next;
    if (val === this._slow) return;
    this._slow = val;
    console.log(`[Handy] Device commands are ${val ? 'SLOW to answer' : 'answering normally again'}`);
    if (this.onSlownessChange) this.onSlownessChange(val);
  }

  /** True while a command has been waiting longer than `_slowCommandMs`. */
  get slow() {
    return this._slow;
  }

  /**
   * Forget everything we believe about the device's command state.
   *
   * Called whenever the session ends, deliberately or not. `_lastScriptHash`
   * is the important one: it means "the device is holding this exact script",
   * a claim that cannot survive the device going away — keeping it would let
   * the next session skip an upload the new session never made.
   */
  _resetCommandState() {
    this._lastScriptHash = null;
    this._hsspMayRun = null;
    this._playInFlight = 0;
    this._slowDepth = 0;
    clearTimeout(this._slowTimer);
    this._slowTimer = null;
    this._setSlow(false);
  }

  async setupScript(scriptUrl) {
    return this._hsspExclusive('setup', () => this._setupScriptImpl(scriptUrl), false);
  }

  /**
   * The SDK's setScript, time-boxed, and never inside the SDK's throttle
   * window of the previous one (SDK_SETSCRIPT_SPACING_MS): there it would
   * answer with the PREVIOUS script's result and send this one later.
   * Always called from inside the HSSP chain, so the wait holds the chain.
   * @param {string} scriptUrl
   */
  async _sdkSetScript(scriptUrl) {
    const at = this._setScriptSettledAt;
    const wait = at == null ? 0 : at + this._setScriptSpacingMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await this._withHsspTimeout(
        this._handy.setScript(scriptUrl), 'setScript', this._hsspSetupTimeoutMs,
      );
    } finally {
      this._setScriptSettledAt = Date.now();
    }
  }

  /**
   * The SDK's hsspPlay / hsspStop, time-boxed, and never inside the SDK's
   * throttle window of the previous call of the same name
   * (SDK_HSSP_SPACING_MS): there the SDK answers with that call's promise and
   * sends this one 200 ms later, after anything sent meanwhile. Called from
   * inside the HSSP chain (or a stop pre-empting a play), so the wait holds
   * what queues behind it.
   *
   * A previous call the SDK has not answered yet cannot be waited out (a
   * hung stop would hold its retry forever): the SDK hands that one's promise
   * back as before, and the deadline decides.
   *
   * @param {'hsspPlay'|'hsspStop'} name
   * @param {() => Promise<any>} call - the SDK call itself
   * @param {(() => boolean)|null} [stillWanted] - asked after the wait; false
   *   drops the call (a play a stop overtook while it waited)
   * @param {{direct?: boolean, onLate?: ((value: any) => void)|null}} [opts] -
   *   `direct`: the call does not go through the SDK (_directHsspStop), so
   *   there is no SDK window to keep out of; `onLate`: see _withHsspTimeout
   * @returns {Promise<any>} the SDK's answer, or SDK_CALL_DROPPED
   */
  async _sdkHssp(name, call, stillWanted = null, { direct = false, onLate = null } = {}) {
    if (direct) {
      let p;
      try { p = Promise.resolve(call()); } catch (err) { p = Promise.reject(err); }
      return this._withHsspTimeout(p, name, this._hsspTimeoutMs, onLate);
    }
    const slot = this._sdkSlots[name] || (this._sdkSlots[name] = { pending: 0, settledAt: null });
    const wait = slot.pending > 0 || slot.settledAt == null
      ? 0
      : slot.settledAt + this._hsspSpacingMs - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
      if (stillWanted && !stillWanted()) return SDK_CALL_DROPPED;
    }
    // The previous call of this name is unanswered: the SDK sends this one
    // throttleDelay from now. For a play, a stop must not leave before it
    // (SDK_DEFERRED_PLAY_MARGIN_MS).
    const heldBack = slot.pending > 0;
    let p;
    try { p = Promise.resolve(call()); } catch (err) { p = Promise.reject(err); }
    if (heldBack && name === 'hsspPlay') this._noteDeferredSdkPlay();
    slot.pending++;
    const done = () => { slot.pending = Math.max(0, slot.pending - 1); };
    p.then(() => { done(); slot.settledAt = Date.now(); }, (err) => {
      done();
      // Refused by the SDK's own checks before its throttle (`#p`, `#_`, the
      // scriptSet check): nothing went out and no window opened.
      if (!SDK_LOCAL_REFUSAL.test(err?.message || '')) slot.settledAt = Date.now();
    });
    return this._withHsspTimeout(p, name, this._hsspTimeoutMs, onLate);
  }

  /**
   * A play was just handed to the SDK while the previous one was unanswered,
   * so the SDK sends it throttleDelay from now (SDK_DEFERRED_PLAY_MARGIN_MS).
   */
  _noteDeferredSdkPlay() {
    let delay = 200;   // the SDK's default throttleDelay
    try {
      const d = Number(this._handy?.getConfig?.()?.throttleDelay);
      if (Number.isFinite(d) && d >= 0) delay = d;
    } catch { /* keep the default */ }
    this._sdkPlayDeferredUntil = Math.max(this._sdkPlayDeferredUntil, Date.now() + delay + SDK_DEFERRED_PLAY_MARGIN_MS);
  }

  /**
   * Wait until a play the SDK is holding back has left (bf-review BF-R1). A
   * stop sent before it would be overtaken by it, on the direct path (FT-124)
   * and on the SDK's (its request queue may be empty, so its stop leaves at
   * once too). At most throttleDelay + SDK_DEFERRED_PLAY_MARGIN_MS.
   */
  async _waitForDeferredSdkPlay() {
    const wait = this._sdkPlayDeferredUntil - Date.now();
    if (!(wait > 0)) return;
    console.log(`[Handy] hsspStop waits ${wait} ms for a play the SDK is still holding back, so the stop is the last word`);
    await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * The HSSP stop request sent straight to the Handy cloud (FT-124), or null
   * when it has to go through the SDK.
   *
   * The SDK sends every request but a play through ONE request queue of its
   * own, one at a time (handy.esm.js `z` / `W`), and that queue is shared by
   * every HandyManager in the window: the streamer's Handy and every
   * Audience viewer. On a slow cloud a stop waited there behind the SDK's
   * own requests (a play's state read, our health poll): Dave's Handy
   * 2026-11-17, every request 4 s late, hsspStop asked for at once and put
   * out 8.8 s later, the slider stroking 12.9 s after Space. A play has
   * always gone around that queue (`skip`); now the stop does too, so a
   * stop never waits behind anything.
   *
   * Only while the SDK holds the device in HSSP mode: anywhere else the
   * SDK's own hsspStop switches the mode first (that switch is what stops a
   * HAMP or HDSP movement), and it goes through the SDK as before. The same
   * request the SDK sends (HsspService.hsspStop: PUT {API}/hssp/stop with
   * the connection key), answered the same way: a body with `error` is an
   * error, `{ result }` is the answer.
   * @returns {(() => Promise<any>)|null}
   */
  _directHsspStop() {
    const sdk = this._handy;
    if (!sdk || typeof this._fetchImpl !== 'function') return null;
    let base = null;
    let state = null;
    try {
      base = sdk.getConfig?.()?.API;
      state = sdk.getState?.();
    } catch {
      return null;
    }
    const key = state?.connectionKey || this._connectionKey;
    if (typeof base !== 'string' || !base || !key || state?.mode !== 1) return null;
    return async () => {
      const res = await this._fetchImpl(`${base}/hssp/stop`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'X-Connection-Key': key },
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (body && typeof body === 'object' && body.error) {
        const err = new Error(body.error.message || body.error.name || 'HSSP stop error');
        err.code = body.error.code;
        throw err;
      }
      if (!res.ok) throw new Error(`HSSP stop answered HTTP ${res.status}`);
      return body;
    };
  }

  async _setupScriptImpl(scriptUrl) {
    if (!this._handy || !this._connected) return false;
    // setScript switches to HSSP through the SDK's setMode first: as for a
    // play, never inside the window of an HDSP switch of ours (_hdspQuiet).
    if (this._hdspQuietNeeded()) await this._hdspQuiet();

    try {
      // A DIFFERENT script is being set (the Orgasm Switch finisher, a
      // variant, a cached URL from a previous session). The upload-skip in
      // uploadAndSetScript keys off `_lastScriptHash` meaning "this content is
      // what the device holds", so it has to stop meaning that here — or the
      // next upload of the main script would be skipped while the finisher was
      // still loaded.
      if (scriptUrl !== this._lastCloudUrl) this._lastScriptHash = null;
      // A stop can now go out while this runs (_hsspExclusive, Dave
      // 2026-11-20). A setup it makes fail is NOT set again here: only the
      // caller knows whether that script is still wanted (on a video change
      // the stop interrupts the OLD script's setup, and setting it again
      // landed it on a device already playing the new one, 35 s later:
      // audience-source-change.test.js). The caller sees `false` as for any
      // failed setup, and the main script's next play re-sets `_lastCloudUrl`,
      // recorded before its setup (_hsspPlayImpl's self-heal).
      const result = await this._sdkSetScript(scriptUrl);
      // Logged because both user logs that reached us were read through this
      // line — it is how "the script really was replaced" gets established.
      console.log('[Handy] setScript result:', JSON.stringify(result ?? null));
      // HSSPSetupResult: 0 = USING_CACHED, 1 = DOWNLOADED
      const ok = result?.result === 0 || result?.result === 1;
      if (ok) {
        this._mode = 1; // setScript auto-switches the device to HSSP mode
        this._noteCommandResult(true);
      }
      return ok;
    } catch (err) {
      this._noteCommandResult(false);
      this._emitError(`Script setup failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Upload funscript data to handyfeeling.com and set it on the device.
   * Accepts raw funscript JSON string — the SDK converts to its own CSV format
   * (with proper header) and uploads to the cloud. Localhost URLs don't work
   * because the Handy downloads scripts via the cloud API.
   * @param {string} funscriptContent - Raw funscript JSON string
   * @returns {boolean} True if upload and setup succeeded
   */
  async uploadAndSetScript(funscriptContent) {
    // This call's place in line, taken before anything else so a caller can
    // read it through `uploadSeq` right after the call (FT-116).
    const seq = ++this._uploadSeq;
    if (!this._handy || !this._connected || !HandySDK) return false;

    // Nothing to do when the device already has this exact script.
    //
    // Every caller of this is a "(re)start the sync engine" path — connect,
    // video load, variant switch, script reload — and several of them fire for
    // things that did not change the script at all. Welliambrisk's log has
    // `Sync engine started — HSSP active` three times in 90 seconds, each
    // preceded by a fresh upload + setScript of the SAME script (identical
    // cloud hash), costing ~340ms of upload plus a setScript that measured
    // 2.4s and 8.1s. Those seconds go into the same serial chain as the
    // pause's stop, so redundant work here directly lengthens the window where
    // the device ignores a pause.
    const hash = hashScriptContent(funscriptContent);
    if (hash && hash === this._lastScriptHash && this._lastCloudUrl) {
      const state = this._handy.getState?.();
      if (this._mode === 1 && state?.hssp?.scriptSet) {
        console.log('[Handy] Script unchanged and still set on device — skipping upload + setScript');
        return true;
      }
      // Same script, but the device lost its HSSP setup (an HDSP excursion,
      // or an error nulled `_mode`). It still needs setScript — it does not
      // need the identical bytes pushed to the cloud a second time.
      console.log('[Handy] Script unchanged — reusing cached cloud URL, re-setting on device');
      const reset = await this.setupScript(this._lastCloudUrl);
      if (reset) return true;
      // Fall through to a full re-upload: the cached URL may have expired.
      console.warn('[Handy] Cached cloud URL no longer usable — re-uploading');
    }

    try {
      // Pass raw funscript JSON to SDK — it handles conversion to CSV
      // (adds "#Created by Handy SDK v2" header) and uploads to handyfeeling.com
      const cloudUrl = await HandySDK.uploadDataToServer(funscriptContent);
      console.log('[Handy] Script uploaded to cloud:', cloudUrl);
      // A newer upload started while this one travelled (Next pressed twice,
      // a variant picked during a load): that one owns the device now.
      // Setting this script too would land it whenever its upload happened
      // to finish, and an old upload finishing LAST left the old script on
      // the device (FT-116, also in v0.9.2). Nothing is set and nothing
      // cached is touched.
      if (seq !== this._uploadSeq) {
        console.log('[Handy] Upload superseded by a newer one — not setting it on the device');
        return false;
      }
      this._lastCloudUrl = cloudUrl;
      // The cached URL and hash describe ONE script. Until this setScript
      // lands, the hash still names the previous one, and an upload of that
      // previous script meanwhile would "skip" onto this URL.
      this._lastScriptHash = null;

      // Check device still connected after async upload
      if (!this._handy || !this._connected) return false;

      // setScript auto-switches to HSSP mode and sets the script on the
      // device. Routed through the HSSP chain (as 'setup', which is never
      // dropped and never pre-empted) so it cannot interleave with a pause's
      // stop — in Welliambrisk's log an upload landed in the middle of a
      // burst of draining stops.
      const ok = await this.setupScript(cloudUrl);

      if (ok) {
        // Only while the cache still names this script: a newer upload that
        // landed meanwhile has cached its own URL, and its hash follows.
        if (this._lastCloudUrl === cloudUrl) this._lastScriptHash = hash;
        const state = this._handy.getState?.();
        console.log('[Handy] After setScript — mode:', state?.mode, 'scriptSet:', state?.hssp?.scriptSet);
      }

      // Superseded during the setScript: its own setScript is queued behind
      // this one in the HSSP chain and sets the device last. This one is not
      // the caller's to start (FT-116).
      if (seq !== this._uploadSeq) {
        console.log('[Handy] Upload superseded during its setScript — the newer one sets the device last');
        return false;
      }
      return ok;
    } catch (err) {
      this._emitError(`Script upload failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Upload a script and make it the one the next HSSP (re)setup uses, WITHOUT
   * setting it on the device. For a change made while HDSP drives (non-1x
   * rates): back at 1x, hsspPlay's "setup lost" path then sets THIS script.
   * Without it, the restart re-set the old cached URL while a fresh upload's
   * setScript landed in the same half-second, and the two collided (measured
   * on Dave's Handy 2026-11-04: the wrong direction for ~2.5 s until the next
   * drift correction). Returns the URL, or null on failure.
   * @param {string} funscriptContent - Raw funscript JSON string
   * @returns {Promise<string|null>}
   */
  async stageScript(funscriptContent) {
    if (!this._connected || !HandySDK?.uploadDataToServer) return null;
    try {
      const url = await HandySDK.uploadDataToServer(funscriptContent);
      if (!url || !this._connected) return null;
      this._lastCloudUrl = url;
      // The device does not hold it yet: never let the upload-skip trust it.
      this._lastScriptHash = null;
      console.log('[Handy] Script staged for the next HSSP setup:', url);
      return url;
    } catch (err) {
      console.warn('[Handy] Script staging failed:', err.message);
      return null;
    }
  }

  /**
   * Upload funscript JSON to the cloud and return its URL WITHOUT setting it on
   * the device (so it doesn't disturb the currently-playing main script). Used
   * to pre-cache the Orgasm Switch's finisher script, which is then set + looped
   * via HSSP on activate. Returns null on failure.
   * @param {string} funscriptContent - Raw funscript JSON string
   * @returns {Promise<string|null>}
   */
  async uploadScriptOnly(funscriptContent) {
    if (!this._connected || !HandySDK?.uploadDataToServer) return null;
    try {
      return await HandySDK.uploadDataToServer(funscriptContent);
    } catch (err) {
      console.warn('[Handy] Orgasm script upload failed:', err.message);
      return null;
    }
  }

  /**
   * Start HSSP playback at a given time position.
   * @param {number} startTimeMs - Video current time in milliseconds
   * @returns {boolean} True if play started
   */
  async hsspPlay(startTimeMs = 0) {
    this._hsspMayRun = true;
    return this._hsspExclusive('play', (gen) => this._hsspPlayImpl(startTimeMs, gen), false);
  }

  /**
   * @param {number} [startTimeMs]
   * @param {number} [gen] - this request's `_hsspGen` (_hsspExclusive)
   */
  async _hsspPlayImpl(startTimeMs = 0, gen = this._hsspGen) {
    if (!this._handy || !this._connected) return false;

    const est = HandySDK?.getEstimatedServerTime
      ? HandySDK.getEstimatedServerTime()
      : Date.now();
    // Snapshot BEFORE the call so the self-heal branch below can tell whether
    // the user paused while we were waiting.
    const stopEpoch = this._stopEpoch;

    // An HDSP mode switch of ours still in the SDK's setMode window: the
    // play's own switch back to HSSP would be handed its answer and sent
    // after the play (fix-up after block F verify-1). Waited out here, after
    // the snapshot: a stop asked for meanwhile has gone already, and wins.
    if (this._hdspQuietNeeded()) {
      await this._hdspQuiet();
      if (stopEpoch !== this._stopEpoch) {
        console.log('[Handy] hsspPlay: a stop arrived while an HDSP mode switch settled — not playing');
        return false;
      }
    }

    try {
      // Check SDK internal state before calling
      const state = this._handy.getState();
      console.log(`[Handy] hsspPlay(${startTimeMs}) — mode: ${state?.mode}, scriptSet: ${state?.hssp?.scriptSet}`);

      // FT-118 (new since v0.9.2; OFF until measured on a device). Back at 1x
      // after HDSP drove the Handy, the SDK's own setMode has cleared its
      // scriptSet flag, so the play below throws locally and the self-heal
      // re-sets the cached script: the ~1 s pause. Whether firmware 4 keeps
      // the HSSP setup through an HDSP excursion is not known. With the flag
      // on, ask the device to play on it first; any answer but success falls
      // back to that self-heal. Only when the device's last setScript was
      // this exact cached script (`_lastScriptHash`: a staged invert, a new
      // upload and the Orgasm finisher all clear it).
      if (this._reuseHsspSetupAfterHdsp && this._mode === 2 && !state?.hssp?.scriptSet
          && this._lastCloudUrl && this._lastScriptHash
          && typeof this._handy.updateState === 'function') {
        if (await this._playOnKeptHsspSetup(startTimeMs, est, () => stopEpoch === this._stopEpoch)) return true;
        if (stopEpoch !== this._stopEpoch) {
          console.log('[Handy] hsspPlay: a stop arrived during the kept-setup try — not going on');
          return false;
        }
      }

      // Out of the last play's SDK window first; a stop asked for while this
      // play waited has gone to the device already, so the play is dropped
      // (a stop always wins over a late play; block F review 2026-11-16).
      // A play answered after its deadline still landed (FT-124).
      const onLate = this._lateAnswer('hsspPlay', gen, (r) => r?.result === 0);
      const result = await this._sdkHssp(
        'hsspPlay', () => this._handy.hsspPlay(startTimeMs, est), () => stopEpoch === this._stopEpoch,
        { onLate },
      );
      if (result === SDK_CALL_DROPPED) {
        console.log('[Handy] hsspPlay dropped — a stop arrived while it waited out the SDK throttle window');
        return false;
      }
      console.log('[Handy] hsspPlay result:', JSON.stringify(result));
      const ok = result?.result === 0;
      // A play that lands is proof the device is doing what it is told, and
      // must clear an "unresponsive" flag a previous failure set. Only the
      // stop path reported success here, so a recovered device could stay
      // marked as not responding until the next pause.
      if (ok) this._noteCommandResult(true);
      return ok;
    } catch (err) {
      // Self-heal: HDSP (Orgasm Switch, scrub preview) clears HSSP's scriptSet,
      // so resuming can fail with "Script set is required". Re-set the cached
      // cloud script and retry once — this is the reliable fix for the device
      // going silent after the Orgasm Switch releases.
      // Two different messages mean the same thing — the device no longer has
      // HSSP set up and needs setScript again:
      //   "Script set is required"                        (HDSP cleared it)
      //   "Illegal state. Mode specific setup required first."
      // The second showed up when Dave mashed X and Z: the stacked engage /
      // release cycles timed out against the cloud and left the device
      // without its mode setup, and because only the first message was
      // matched, nothing re-established it — the Handy stopped following the
      // video until the video was reloaded (2026-08-21).
      if (/script\s*set\s*is\s*required|mode\s*specific\s*setup\s*required/i.test(err?.message || '')
          && this._lastCloudUrl) {
        // ...unless the user paused while this play was in flight. Restarting
        // the device now would undo a stop that has already been sent, which
        // is the same "device carries on after pause" failure from the other
        // direction — and here it would be self-inflicted.
        if (stopEpoch !== this._stopEpoch) {
          console.log('[Handy] hsspPlay: a stop arrived while this play was in flight — not retrying');
          this._mode = null;
          return false;
        }
        console.warn('[Handy] hsspPlay: HSSP setup lost — re-setting cached script and retrying');
        try {
          const r = await this._sdkSetScript(this._lastCloudUrl);
          if (r?.result === 0 || r?.result === 1) {
            this._mode = 1;
            // Checked again AFTER the setScript, not only before it (FT-110,
            // new since v0.9.2). setScript is a 2-8 s handshake, and a stop
            // asked for during it has already gone to the device (it
            // pre-empts this in-flight play); the retry play below would
            // then restart a Handy the user has just paused.
            if (stopEpoch !== this._stopEpoch) {
              console.log('[Handy] hsspPlay: a stop arrived during the re-setScript — not retrying the play');
              this._noteCommandResult(true);   // the setScript itself landed
              return false;
            }
            const result = await this._sdkHssp(
              'hsspPlay', () => this._handy.hsspPlay(startTimeMs, est), () => stopEpoch === this._stopEpoch,
              { onLate: this._lateAnswer('hsspPlay', gen, (r) => r?.result === 0) },
            );
            if (result === SDK_CALL_DROPPED) {
              console.log('[Handy] hsspPlay retry dropped — a stop arrived while it waited out the SDK throttle window');
              return false;
            }
            console.log('[Handy] hsspPlay retry result:', JSON.stringify(result));
            const ok = result?.result === 0;
            if (ok) this._noteCommandResult(true);
            return ok;
          }
        } catch (err2) {
          this._mode = null;   // stop claiming a mode the device does not have
          this._emitError(`HSSP re-setScript+play failed: ${err2.message}`);
          return false;
        }
      }
      // Drop the mode cache on ANY failure. It exists to keep steady-state
      // ticks cheap, and holding a stale `_mode = 1` after an error is how the
      // device stays dead: every later call skips the re-setup it needs.
      this._mode = null;
      this._noteCommandResult(false);
      // A deadline is not the same news as a rejection. "hsspPlay timed out
      // after 5000ms" tells the user nothing they can act on; what they need
      // to know is that the device has gone quiet and where to look.
      console.warn(`[Handy] HSSP play failed: ${err.message}`);
      this._emitError(err?.hsspTimeout
        ? t('error.handyNotAnswering')
        : `HSSP play failed: ${err.message}`);
      return false;
    }
  }

  /**
   * FT-118's try: play on the HSSP setup the device may have kept through an
   * HDSP excursion, without a setScript. True when the device played. On
   * anything else the SDK is told no script is set again, so the caller's
   * normal play throws "Script set is required" and self-heals as before.
   * @returns {Promise<boolean>}
   */
  async _playOnKeptHsspSetup(startTimeMs, est, stillWanted = null) {
    try {
      // The SDK refuses a play locally while its scriptSet flag is false, so
      // it has to be told the setup is there for the device to be asked.
      await this._handy.updateState({ hssp: { scriptSet: true } });
      const result = await this._sdkHssp('hsspPlay', () => this._handy.hsspPlay(startTimeMs, est), stillWanted);
      if (result === SDK_CALL_DROPPED) {
        console.log('[Handy] hsspPlay on the kept setup dropped — a stop arrived while it waited out the SDK throttle window');
      } else if (result?.result === 0) {
        // Its setMode(HSSP) on the way cleared the flag again. The device
        // kept the setup, so say so, or the 2.5 s correction play would throw
        // locally and self-heal anyway.
        await this._handy.updateState({ hssp: { scriptSet: true } });
        this._mode = 1;
        this._noteCommandResult(true);
        console.log('[Handy] hsspPlay: the device kept its HSSP setup through HDSP — no setScript');
        return true;
      } else {
        console.log('[Handy] hsspPlay on the kept setup answered', JSON.stringify(result ?? null), '— re-setting the script');
      }
    } catch (err) {
      console.log(`[Handy] hsspPlay on the kept setup failed (${err?.message || err}) — re-setting the script`);
    }
    try { await this._handy.updateState({ hssp: { scriptSet: false } }); } catch { /* the self-heal still runs */ }
    this._mode = null;
    return false;
  }

  /**
   * Stop HSSP playback.
   */
  /** @returns {Promise<boolean>} false = the device may still be moving. */
  async hsspStop() {
    this._hsspMayRun = false;
    return this._hsspExclusive('stop', (gen) => this._hsspStopImpl(gen), true);
  }

  /**
   * @param {number} [gen] - this request's `_hsspGen` (_hsspExclusive)
   * @returns {Promise<boolean>} true if the device acknowledged the stop.
   *   A `false` here means HARDWARE MAY STILL BE MOVING — callers are
   *   expected to tell the user, not swallow it.
   */
  async _hsspStopImpl(gen = this._hsspGen) {
    // Not connected: nothing of ours is running, so this is a no-op success
    // rather than a failure. Reporting false here would toast on every pause
    // with no device attached.
    if (!this._handy || !this._connected) return true;

    // Logged both sides, like hsspPlay. Until 2026-08-16 a successful stop
    // logged NOTHING, so x0193143's report (#288, "Handy keeps working ~15s
    // after pause") could not be diagnosed from his log: the plays were
    // visible with call and result timestamps, the stops were invisible, and
    // the whole bug was about the ORDER the two arrived in.
    //
    // A FAILED stop used to be swallowed: warn to the console and return as
    // though it had worked. That is the worst thing this file can do. The
    // device keeps stroking on its own cloud-scheduled playback, the app
    // shows paused, and the only trace is a line in a log nobody reads —
    // exactly Welliambrisk's report (#328: "if I pause or try to exit that
    // video it just keeps playing the script"), and `HSSP stop error: Update
    // required` is sitting in Sylvain-Et-Un's log too. `hsspPlay` next door
    // has always called `_emitError` and returned false; the stop, where
    // failure actually moves hardware, did neither.
    //
    // The deadline is the other half of that lesson. Welliambrisk's log has a
    // stop that took 17.08s and then returned SUCCESS — no error to catch, no
    // retry to trigger, nothing for the toast above to fire on, and seventeen
    // seconds of hardware moving while the UI said paused. A stop that has not
    // been acknowledged in `_hsspTimeoutMs` is treated as a failed attempt and
    // re-sent, because a second stop costs nothing and a missed one costs the
    // user the only thing they cannot fix from the app.
    console.log('[Handy] hsspStop — requesting…');
    // A stop that answers after its deadline still stopped the device
    // (FT-124): the "not responding" its timeout left is taken back, unless
    // something was asked for after this stop was (its gen, not the one when
    // it ran: a play asked while the stop waited is newer news; BF-R2).
    const onLate = this._lateAnswer('hsspStop', gen, () => true);
    // A play the SDK is still holding back leaves first (BF-R1).
    await this._waitForDeferredSdkPlay();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Straight to the cloud while the SDK is in HSSP mode (FT-124, see
        // _directHsspStop). Otherwise through the SDK, out of the last
        // stop's SDK window first, or this stop's own request would leave
        // after a play queued behind it (block F review).
        const direct = this._directHsspStop();
        const res = direct
          ? await this._sdkHssp('hsspStop', direct, null, { direct: true, onLate })
          : await this._sdkHssp('hsspStop', () => this._handy.hsspStop(), null, { onLate });
        console.log(`[Handy] hsspStop result${direct ? ' (sent directly)' : ''}: ${JSON.stringify(res ?? null)}`);
        this._noteCommandResult(true);
        return true;
      } catch (err) {
        // Same reasoning as hsspPlay: a failed stop means the device is not in
        // the state we think it is, so the cache has to go or the next play
        // will skip its setup.
        this._mode = null;
        // FT-127 (Dave's Handy 2026-11-17): "Illegal state. Mode specific
        // setup required first." is the device saying it holds no HSSP
        // setup (here after an editor save's setScript timed out). With no
        // setup there is nothing for HSSP to run: the device answered, and
        // it is still. That is a stop, not a failed one; the toast and "Not
        // responding" it used to cause were wrong. The next play re-sets the
        // script (hsspPlay's self-heal matches the same message).
        if (/mode\s*specific\s*setup\s*required/i.test(err?.message || '')) {
          console.log('[Handy] hsspStop: the device holds no HSSP setup — nothing can be playing, counted as stopped');
          this._noteCommandResult(true);
          return true;
        }
        console.warn(`[Handy] HSSP stop error (attempt ${attempt}/2):`, err.message);
        // One retry, because a stop is worth a second cloud round trip in a
        // way a play is not — the cost of giving up is a device left running.
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        this._noteCommandResult(false);
        this._emitError(t('error.handyStopFailed'));
        return false;
      }
    }
    return false;
  }

  /**
   * Set HSTP offset (manual sync adjustment).
   * @param {number} offsetMs - Offset in milliseconds
   */
  async setOffset(offsetMs) {
    // The GLOBAL offset. Remembered even while disconnected, so a video's
    // delta can be sent on top of the right value later.
    this._globalOffsetMs = Number(offsetMs) || 0;
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setOffset(deviceOffsetWithVideoDelta('handy', this._globalOffsetMs, this._videoOffsetMs));
    } catch (err) {
      this._emitError(`Set offset failed: ${err.message}`);
    }
  }

  /**
   * The playing video's own delta (Pudknocker #380), sent on top of the
   * global offset. app.js calls this on every video load with the saved
   * global (`handy.defaultOffset`) as `globalMs`. Nothing is sent when the
   * delta did not change, so a library with no per-video offsets makes no
   * extra API call; a disconnected device gets it with the next
   * setOffset (every connect sends the saved global).
   * @param {number} deltaMs
   * @param {number} [globalMs]
   */
  async setVideoOffset(deltaMs, globalMs) {
    if (globalMs != null && Number.isFinite(Number(globalMs))) this._globalOffsetMs = Number(globalMs);
    const delta = clampVideoSyncOffset(deltaMs);
    if (delta === this._videoOffsetMs) return;
    this._videoOffsetMs = delta;
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setOffset(deviceOffsetWithVideoDelta('handy', this._globalOffsetMs, delta));
    } catch (err) {
      this._emitError(`Set offset failed: ${err.message}`);
    }
  }

  /**
   * Get current HSTP offset.
   * @returns {number} Offset in milliseconds
   */
  async getOffset() {
    if (!this._handy || !this._connected) return 0;

    try {
      const result = await this._handy.getOffset();
      return result?.offset || 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Set stroke zone (slide min/max).
   * @param {number} min - Minimum position (0–100)
   * @param {number} max - Maximum position (0–100)
   */
  async setStrokeZone(min, max) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setStrokeZone({ min, max });
    } catch (err) {
      this._emitError(`Set stroke zone failed: ${err.message}`);
    }
  }

  /**
   * Get current stroke zone.
   * @returns {{ min: number, max: number }|null}
   */
  async getStrokeZone() {
    if (!this._handy || !this._connected) return null;

    try {
      return await this._handy.getStrokeZone();
    } catch (err) {
      return null;
    }
  }

  /**
   * Set HSSP loop mode.
   * @param {boolean} loop
   */
  async setLoop(loop) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setHsspLoop(loop);
    } catch (err) {
      console.warn('Set loop failed:', err.message);
    }
  }

  /**
   * Start HAMP (manual alternating motion).
   * @param {number} velocity - Speed 0–100
   */
  async hampStart(velocity = 50) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setMode(0); // HAMP mode
      this._mode = 0;
      await this._handy.setHampVelocity(velocity);
      await this._handy.hampPlay();
    } catch (err) {
      this._emitError(`HAMP start failed: ${err.message}`);
    }
  }

  /**
   * Stop HAMP motion.
   */
  async hampStop() {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.hampStop();
    } catch (err) {
      console.warn('HAMP stop error:', err.message);
    }
  }

  /**
   * Set HAMP velocity.
   * @param {number} velocity - Speed 0–100
   */
  async setHampVelocity(velocity) {
    if (!this._handy || !this._connected) return;

    try {
      await this._handy.setHampVelocity(velocity);
    } catch (err) {
      console.warn('Set HAMP velocity error:', err.message);
    }
  }

  /**
   * Explicitly switch the device into HDSP mode (2) and remember it. Used to
   * SEQUENCE the HSSP→HDSP handoff for the Orgasm Switch: await hsspStop, THEN
   * await enterHdsp, THEN start driving. Without this ordering an un-awaited
   * hsspStop could land after the first hdsp and silently re-stop the device
   * (and the _mode cache would then skip re-switching, so it stays dead).
   * @returns {boolean} true if the mode switch succeeded
   */
  async enterHdsp() {
    if (!this._handy || !this._connected) return false;
    try {
      await this._handy.setMode(2);
      this._mode = 2;
      console.log('[Handy] Entered HDSP mode (2)');
      return true;
    } catch (err) {
      this._mode = null;
      console.warn('[Handy] enterHdsp (setMode 2) failed:', err.message);
      return false;
    } finally {
      this._hdspModeSettledAt = Date.now();
    }
  }

  /**
   * Set HDSP (direct position) — move device to a specific position immediately.
   * Useful for scrub preview during seeking.
   * @param {number} position - Target position 0–100
   * @param {number} durationMs - Time to reach position in ms
   */
  async hdspMove(position, durationMs = 150) {
    if (!this._handy || !this._connected) return;

    // Firmware 4 (every Handy 2, and Handy 1 on FW4) reads the v2 /hdsp/xpt
    // position as a FRACTION 0-1, not the 0-100 the v2 spec documents.
    // Measured on Dave's Handy (fw 4.2.1) 2026-11-04: xpt 0.5 → 49.8%, 0.3 →
    // 29.1%, 0.8 → 79.3%; xpt 30 / 50 / 70 → pinned at the top, the motor
    // pushing against the end stop. The stroke zone (/slide) is still 0-100
    // on FW4, and xpt is relative to it. Unknown firmware: send nothing,
    // because guessing 0-100 on FW4 slams the slider into the end.
    const scale = hdspPositionScale(this._deviceInfo || this._handy.getState?.()?.info);
    if (scale === null) {
      if (!this._hdspUnknownFwLogged) {
        console.warn('[Handy] HDSP move skipped: firmware version not known yet');
        this._hdspUnknownFwLogged = true;
      }
      return;
    }
    const devicePosition = Math.max(0, Math.min(100, Number(position) || 0)) * scale;

    // One SDK call at a time, never inside the SDK's window of the last one
    // (HDSP_QUIET_MAX_MS above says why). A move asked for while one is out
    // or the window is open REPLACES the one waiting: the newest position is
    // what the device should go to, as the SDK's own deferred call was. The
    // promise settles once the sends this call joined are done.
    this._hdspWanted = { devicePosition, durationMs, epoch: this._hdspEpoch };
    if (!this._hdspPumping) {
      this._hdspPumping = true;
      this._hdspPumpPromise = this._runHdspPump();
    }
    return this._hdspPumpPromise;
  }

  /**
   * Send no more HDSP moves: one waiting for the SDK's window is dropped, and
   * a mode switch of ours still travelling is followed by no move. A move
   * whose request has left cannot be called back. The HDSP engine calls this
   * when it stops (back at 1x, a pause, a video change), and every HSSP
   * request does (`_hsspExclusive`).
   */
  hdspHalt() {
    this._hdspEpoch++;
    this._hdspWanted = null;
  }

  /** Sends `_hdspWanted` until none is left; one pump at a time. */
  async _runHdspPump() {
    try {
      while (this._hdspWanted) {
        const at = this._hdspSettledAt;
        const wait = at == null ? 0 : at + this._hdspSpacingMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const want = this._hdspWanted;
        this._hdspWanted = null;
        if (!want || want.epoch !== this._hdspEpoch || !this._handy || !this._connected) continue;
        await this._sendHdspMove(want);
      }
    } finally {
      this._hdspPumping = false;
    }
  }

  /**
   * True while a setMode(2) of ours is still travelling or answered under the
   * SDK's window ago. An HSSP play / setup switches the device back through
   * the SDK's own setMode, which in that window is handed the HDSP switch's
   * answer and sent 200 ms later, after the play. Synchronous, so the common
   * case costs a play nothing.
   */
  _hdspQuietNeeded() {
    const at = this._hdspModeSettledAt;
    return !!this._hdspModeStep || (at != null && Date.now() - at < this._hdspSpacingMs);
  }

  /**
   * Wait out what `_hdspQuietNeeded` saw, at most `_hdspQuietMaxMs`
   * (decided before anything is awaited).
   */
  async _hdspQuiet() {
    if (!this._hdspQuietNeeded()) return;
    const step = this._hdspModeStep;
    const deadline = Date.now() + this._hdspQuietMaxMs;
    if (step) {
      let timer = null;
      await Promise.race([
        step.catch(() => {}),
        new Promise((r) => { timer = setTimeout(r, this._hdspQuietMaxMs); }),
      ]);
      clearTimeout(timer);
    }
    const settled = this._hdspModeSettledAt;
    const wait = settled == null ? 0 : Math.min(settled + this._hdspSpacingMs, deadline) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** One HDSP move through the SDK: the mode switch when needed, then the move. */
  async _sendHdspMove(want) {
    try {
      // Ensure the device is actually in HDSP mode (2) before sending. The SDK
      // does NOT reliably auto-switch when we come straight from a stopped-HSSP
      // state, so an explicit, awaited setMode is required — otherwise the hdsp
      // commands are ignored and the device just sits stopped. Only switched on
      // a real transition (tracked by _mode), so steady-state ticks stay cheap.
      if (this._mode !== 2) {
        const step = Promise.resolve(this._handy.setMode(2)).then(() => { this._mode = 2; });
        this._hdspModeStep = step;
        try {
          await step;
        } finally {
          this._hdspModeSettledAt = Date.now();
          if (this._hdspModeStep === step) this._hdspModeStep = null;
        }
        // Halted, or an HSSP request came in, while the switch travelled: the
        // switch has gone, this move does not follow it.
        if (want.epoch !== this._hdspEpoch) return;
      }
      try {
        // hdsp(position, speed, positionType, speedType, stopOnTarget, immediateResponse)
        await this._handy.hdsp(want.devicePosition, want.durationMs, 'percent', 'time', true, true);
      } finally {
        this._hdspSettledAt = Date.now();
      }
      this._hdspErrorLogged = false;
    } catch (err) {
      // Force a mode re-check next tick. Log once per failure streak at WARN so
      // it reaches the log file (renderer console is forwarded; debug is not) —
      // this path was previously undiagnosable when it silently failed.
      this._mode = null;
      if (!this._hdspErrorLogged) {
        console.warn('[Handy] HDSP move failed (device may not have entered HDSP mode):', err.message);
        this._hdspErrorLogged = true;
      }
    }
  }

  // --- Cloud-reachability health check ---

  _startHealthCheck() {
    if (this._healthCheckInterval) return;
    this._healthCheckInterval = setInterval(
      () => this._healthCheckTick(),
      this._healthCheckIntervalMs,
    );
  }

  _stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Poll faster while a script is actually playing.
   *
   * The command path catches a dead device immediately — but ONLY while
   * commands are being sent, and during HSSP playback almost none are. The
   * script is uploaded once, `hsspPlay` fires once, and the device then plays
   * autonomously from its own clock; the drift monitor ticks every 2s but
   * only reads a cached `syncQuality` and never touches the device. So minutes
   * can pass with nothing asked of it, and the poll is the ONLY thing that
   * would notice it had gone — which is exactly the moment a 10s lie about
   * being connected is least acceptable (Dave, 2026-08-26).
   *
   * 3s while playing, 10s idle. Idle is left slow deliberately: it is a cloud
   * round trip per tick, and nobody is harmed by learning 10s later that a
   * device they are not using has dropped.
   *
   * @param {boolean} playing
   */
  setPlaybackActive(playing) {
    const next = playing ? 3000 : 10000;
    if (next === this._healthCheckIntervalMs) return;
    this._healthCheckIntervalMs = next;
    // Re-arm at the new pace, but only if it was already running — this must
    // never start polling a device we are not connected to.
    if (this._healthCheckInterval) {
      this._stopHealthCheck();
      this._startHealthCheck();
    }
  }

  /**
   * Ask the handyfeeling cloud whether the physical device is currently
   * reachable. Only flips state on an unambiguous `connected: false`.
   * Network errors are treated as transient — state is preserved so a
   * single flaky poll doesn't cause a spurious disconnect UI blip.
   */
  async _healthCheckTick() {
    if (!this._handy || !this._connected || !this._connectionKey) return;
    // Never a second poll while one is unanswered (FT-124). The poll goes
    // through the SDK's one request queue, every 3 s while playing: on a
    // cloud slower than that (Dave's Handy 2026-11-17, every request 4 s
    // late) the polls piled up there, and every setup, every play's state
    // read and, before FT-124, every stop waited behind the pile, which grew
    // for as long as the video played.
    if (this._healthCheckInFlight) return;
    this._healthCheckInFlight = true;
    try {
      const resp = await this._handy.API?.get?.connected?.(this._connectionKey);
      if (resp && resp.connected === false) {
        console.log('[Handy] Cloud reports device unreachable — marking disconnected');
        this._handleDeviceLost();
      }
    } catch (err) {
      // Transient — log once per tick, don't touch state.
      console.debug('[Handy] Health check error:', err?.message || err);
    } finally {
      this._healthCheckInFlight = false;
    }
  }

  /**
   * Device is no longer reachable via WiFi (BT-mode switch, power off,
   * WiFi drop). Mirror the SDK's disconnect cleanup so every consumer
   * reading `handyManager.connected` updates immediately.
   */
  _handleDeviceLost() {
    this._stopHealthCheck();
    this._connected = false;
    this._deviceInfo = null;
    this._announcedInfoKey = null;
    this._connectEpoch++;
    // A device that is gone is not "unresponsive", it is disconnected — and
    // the two must not both be shown at once. Reset so the next connection
    // starts from a clean bill of health.
    this._noteCommandResult(true);
    this._resetCommandState();
    if (this.onDisconnect) this.onDisconnect();
  }

  /**
   * Record whether a real device command worked, and announce a CHANGE.
   *
   * This is the difference between "we shook hands once" and "it is doing what
   * we tell it". Only transitions are emitted: a run of failures must not spam
   * the UI, and a run of successes must not either.
   *
   * @param {boolean} ok
   */
  _noteCommandResult(ok) {
    const next = !!ok;
    if (next === this._responsive) return;
    this._responsive = next;
    console.log(`[Handy] Device is now ${next ? 'responding' : 'NOT RESPONDING'}`);
    if (this.onResponsivenessChange) this.onResponsivenessChange(next);
  }

  /**
   * The handler for a play or stop that answers AFTER its deadline (FT-124;
   * feedback_deadline_before_catch_block: a late command is not a failed
   * one). The deadline already reported the device as not answering; an
   * answer that says it worked takes that back, unless another HSSP request
   * has been asked for since (its own outcome is the newer news).
   * @param {string} label
   * @param {number} gen - `_hsspGen` when the call was made
   * @param {(value: any) => boolean} worked - whether the answer is a success
   */
  _lateAnswer(label, gen, worked) {
    return (value) => {
      const ok = !!worked(value);
      console.log(`[Handy] ${label} answered after its deadline: ${JSON.stringify(value ?? null)}${ok ? ' — it did land' : ''}`);
      if (ok && gen === this._hsspGen) this._noteCommandResult(true);
    };
  }

  /** True while recent commands have been landing. See `_noteCommandResult`. */
  get responsive() {
    return this._responsive;
  }

  // --- Getters ---

  get connected() {
    return this._connected;
  }

  get deviceInfo() {
    return this._deviceInfo;
  }

  get syncQuality() {
    return this._syncQuality;
  }

  /**
   * How many uploadAndSetScript calls have started (FT-116). Read right
   * after a call to get that call's number: when it has moved on by the time
   * the call returns, a newer upload superseded it, and its `false` means
   * "not yours", not "failed".
   */
  get uploadSeq() {
    return this._uploadSeq;
  }

  /**
   * false only when the last HSSP request was a stop, so nothing of ours can
   * be playing, or when the device said after a connect that it stands
   * still and nothing has been asked of it since (_readHsspStateAfterConnect);
   * true after a play request (in flight or landed); null when unknown. A
   * "may", not a reading of the device: a play that failed still leaves it
   * true, which only costs a redundant stop.
   */
  get hsspMayBeRunning() {
    return this._hsspMayRun;
  }

  get connectionKey() {
    return this._connectionKey;
  }

  // --- Internal ---

  _emitError(message) {
    console.error(`[HandyManager] ${message}`);
    if (this.onError) this.onError(message);
  }
}
