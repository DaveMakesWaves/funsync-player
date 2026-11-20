// AudienceBridge — fan-out wrapper around N HandyManager instances.
//
// One streamer's FunSync drives a room of viewers' Handys. Each viewer =
// one HandyManager instance keyed by their Handy connection key. The bridge
// owns the per-viewer lifecycle (connect / set up the script / play / stop /
// disconnect).
//
// SOURCE MODEL (#361, 2026-11-04). Viewers lost sync on every video change
// because nothing told them the script had changed: only play, pause and
// seek reached them, and the bridge's idea of "the current script" was the
// streamer's own cloud URL, which only existed when the streamer's own Handy
// uploaded it. The bridge now owns its own source: a generation counter
// (`_scriptGen`) plus the content for that generation (`_source`). Every
// place in the app that can change the script drives it explicitly:
//
//   const token = bridge.beginSource({ title, player })  // gen++, every viewer stopped
//   bridge.setScript(token, { content, title })  // upload once, set up viewers
//   bridge.setNoScript(token, { reason, failed }) // viewers stay stopped
//   bridge.endSource(player, { reason })          // that player's session ended
//
// A source belongs to the player that loaded it: the local video element,
// the VR headset or the phone (`player`). Viewers only ever play a LOCAL
// source, and when a VR or phone session ends, its source ends with it, so
// the local video can never start viewers on the script of the video the
// headset or the phone was playing (#361 review, 2026-11-04).
//
// A setScript / setNoScript whose token is no longer the latest is dropped,
// so the caller takes its token before its first await and needs no other
// staleness check for the audience. The bridge never reads the streamer's
// funscript engine or the streamer's cloud URL: viewers get the content the
// app hands it (D1: the active script plus the gap filler, never the
// streamer's Range Extender, output limits or Handy invert).
//
// SAFETY INVARIANTS (notes/features/RESEARCH-audience-video-change.md §4.1):
//   S1  One play gate, `_canPlay()`, for every play: room active, viewer
//       still in it and reachable, not muted or errored, a setup for the
//       CURRENT generation succeeded on it, the source is a script, the
//       local player is playing, and the rate is 1x.
//   S2  Stop first. Every source change stops every viewer (muted ones too),
//       and so do pause, ended, a rate other than 1x, a buffering stall past
//       its grace window (FN-06), mute, remove, ending the room and
//       quitting. A stop is skipped only when the viewer is KNOWN stopped:
//       its last command was a stop that returned ok.
//   S3  Status only from results. HandyManager returns booleans and never
//       throws; a result that belongs to an older generation (or was
//       overtaken by a newer command) writes nothing. Errors are sticky
//       until a successful command clears them.
//   S5  A late play is re-stopped. A play whose answer arrives after a stop
//       was issued for that viewer is followed by another stop: a late
//       command is not a failed one.
//   S6  Absence is never destructive. An offline or errored viewer stays in
//       the room and the roster; only the streamer's Remove takes one out.
//       Resend (FT-121) connects it again and starts it over from the
//       room's source.
//
// TEST BUZZ (FT-119) is HDSP: HandyManager.hdspMove, never the SDK's hdsp
// (it scales to the firmware, 0-1 on FW4). HDSP is not in HandyManager's
// HSSP queue, and the SDK's mode switch clears the script setup, which a
// viewer's HandyManager cannot heal from (setupScript never sets its cached
// URL). So a buzz is refused while the viewer plays, shuts the play gate
// from its first move, ends on a stop with its own answer, and arms the
// viewer again (a setup; a play only if the gate passes).
//
// STOPGAP LIMITS (D5 — research §4.12, option C is a later release):
//   - S4 is NOT met. Every viewer's HandyManager re-imports the same SDK
//     module, which has ONE request queue shared with the streamer's own
//     Handy, so viewer setups and the streamer's setups wait in one line
//     (a stop in HSSP mode goes around it since FT-124, 2026-11-19).
//     Aimed at small rooms (#361 runs one viewer).
//   - Plays only follow the LOCAL video element. While VR, the phone or the
//     player pop-out drives playback, viewers stay stopped (safe, not synced).
//     A VR or phone source is never played, and it ends with its session.
//   - The SDK throttles a second call of the same method made while the
//     previous one is out, or within 200 ms of it settling: it returns the
//     PREVIOUS call's promise and sends the new request 200 ms later,
//     unobserved. So:
//       * two setups (and two plays) on one instance are spaced by
//         SDK_THROTTLE_GAP_MS from the previous answer;
//       * a setup that answered false may have hit HandyManager's deadline
//         with its request still registered, so the next setup's ok is not
//         trusted until it has been asked again, past the window;
//       * a stop made inside that window may get the previous stop's
//         answer while its own request leaves later, so its ok is not
//         PROOF. Before a setup or a play goes out after one, the window is
//         waited out and a stop with its own answer is sent first;
//       * that later request is a renderer timer, and the SDK sends nothing
//         for an instance once it is disconnected. So quitting
//         (hsspStopAll) and Remove / End room (before the disconnect) also
//         end on a stop whose answer is its own.
//     What the bridge cannot see is the SDK's module-level request queue:
//     a play bypasses it, so a stop still queued behind other viewers'
//     traffic could land after a later play (the device then ends stopped
//     while its row reads Playing, until the next play or seek). Since
//     FT-124 (2026-11-19) HandyManager sends a stop around that queue too
//     while the SDK is in HSSP mode (_directHsspStop), so this is left for
//     a stop that has to switch the mode first (after a Test buzz).
//
// SCOPE: notes/features/SCOPE-audience-broadcast.md §4 data model + §5.

import { hdspPositionScale } from './handy-manager.js';
import { isPictureStarved, StallGrace, STALL_GRACE_MS, stallSummary } from './playback-stall.js';

const SETTING_VIEWERS = 'audience.viewers';
const SETTING_HIDE_KEYS = 'audience.hideKeys';

/** Spacing between two calls of the same HandyManager method on one viewer.
 *  The SDK's per-instance throttle is 200 ms; 250 leaves a margin. */
export const SDK_THROTTLE_GAP_MS = 250;
/** One retry of a failed upload, after this long. */
export const UPLOAD_RETRY_DELAY_MS = 1000;
/** FT-120: a play request is dropped when the last play already gives it
 *  its anchor: same script, no stop and no other command since, still out
 *  or answered ok less than this long ago, and the video is where that play
 *  anchored it. A seek fires `seeked` and then `playing`, and both ask. */
export const PLAY_COALESCE_MS = 300;
/** How far the video may be from where the last play anchored it (its time
 *  plus the wall time since; plays only go at 1x) for a request to count as
 *  covered. Further means the video stalled since (buffering after the
 *  seek), and the device needs the new anchor. */
export const PLAY_ANCHOR_TOLERANCE_MS = 100;
/** FT-119: Test buzz is the Devices tab's gentle Handy test pulse (app.js
 *  `_testDevice`): to 70 over 500 ms, 550 ms later back to 20 over 500 ms. */
export const TEST_BUZZ_PULSE = Object.freeze({ high: 70, low: 20, moveMs: 500, gapMs: 550 });
/** How long an uploaded URL is reused for the same content. The lifetime of
 *  a Handy temporary URL is documented nowhere (research §2.1). */
const URL_CACHE_TTL_MS = 30 * 60 * 1000;

/** Per-viewer status enum. Display layer renders LED color + label
 *  from this. */
export const VIEWER_STATUS = Object.freeze({
  IDLE:          'idle',
  CONNECTING:    'connecting',
  UPLOADING:     'uploading',      // a setup for the current script is in flight
  CALIBRATING:   'calibrating',
  SYNCED:        'synced',         // connected, no video loaded yet
  WAITING:       'waiting',        // stopped; the new video's script is not set up yet
  READY:         'ready',          // the current script is set up; stopped
  // Set up for a phone's or a headset's script, which viewers never play
  // (the stopgap: they follow only this window's player). Not "Ready": that
  // read as "will play" (verify-2, 2026-11-07).
  REMOTE_HELD:   'remote-held',
  PLAYING:       'playing',
  PAUSED:        'paused',
  SPEED:         'speed',          // stopped because the player is not at 1x
  NO_SCRIPT:     'no-script',      // this video has no script; stopped
  SCRIPT_FAILED: 'script-failed',  // the script could not be loaded or uploaded; stopped
  MUTED:         'muted',
  DISCONNECTED:  'disconnected',
  ERROR:         'error',
});

/** Sticky error codes. The pop-out renders a translated line for each. */
export const VIEWER_ERROR = Object.freeze({
  STOP_FAILED:  'stop-failed',
  SETUP_FAILED: 'setup-failed',
  PLAY_FAILED:  'play-failed',
});

export const SOURCE_KIND = Object.freeze({
  NONE:      'none',
  LOADING:   'loading',
  SCRIPT:    'script',
  NO_SCRIPT: 'no-script',
  FAILED:    'failed',
});

/** The player a source was loaded for. Viewers follow only LOCAL (stopgap). */
export const SOURCE_PLAYER = Object.freeze({
  LOCAL: 'local',
  VR:    'vr',
  PHONE: 'phone',
});

/** Number of actions in a raw funscript, or -1 if it is not readable JSON.
 *  The SDK's CSV conversion refuses fewer than 2 ("Need at least 2 points"),
 *  so a script with fewer counts as no script, not as a failed upload. */
function countActions(content) {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.actions) ? parsed.actions.length : 0;
  } catch {
    return -1;
  }
}

/** FNV-1a over the whole content, plus its length. Identifies "the same
 *  script" so it is uploaded once and its URL reused for every viewer. */
function hashContent(s) {
  const str = String(s ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${str.length}:${(h >>> 0).toString(16)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AudienceBridge {
  /**
   * @param {Object} opts
   * @param {Object} opts.settings — dataService handle (get / set)
   * @param {Object} opts.eventBus — pub/sub for cross-component events
   * @param {Function} opts.HandyManagerCtor — `class` of HandyManager.
   *   Production passes the real one; tests inject a fake.
   * @param {Function} [opts.getCurrentVideoTimeMs] — () => ms of the local
   *   player, read at the moment each play is sent.
   * @param {Function} [opts.isVideoPlaying] — () => bool: the LOCAL player
   *   is the active player and is playing.
   * @param {Function} [opts.getPlaybackRate] — () => the local player's rate.
   * @param {Function} [opts.uploadScript] — async (rawFunscript) => url|null.
   *   Keyless upload to the Handy script host; needs no device.
   * @param {Function} [opts.getStreamerOwnKey] — () => the Handy tab's key.
   */
  constructor({
    settings,
    eventBus,
    HandyManagerCtor,
    getCurrentVideoTimeMs = () => 0,
    isVideoPlaying = () => false,
    getPlaybackRate = () => 1,
    uploadScript = null,
    getStreamerOwnKey = () => null,
  }) {
    this._settings = settings;
    this._bus = eventBus;
    this._HandyManagerCtor = HandyManagerCtor;
    this._getCurrentVideoTimeMs = getCurrentVideoTimeMs;
    this._isVideoPlaying = isVideoPlaying;
    this._getPlaybackRate = getPlaybackRate;
    this._uploadScript = uploadScript;
    // Returns the streamer's OWN Handy key (the one connected via the
    // Handy tab) so addViewer can reject self-collisions. Without this
    // guard, pasting your own key as a viewer creates two HandyManager
    // instances racing each other for the same physical device — last
    // command wins on the Handy server, script playback corrupts.
    this._getStreamerOwnKey = getStreamerOwnKey;

    // Map<key, viewer> — see _newViewer for the runtime fields.
    this._viewers = new Map();
    this._roomActive = false;
    this._ending = false;

    // The room's source. Tracked even while no room is open, so a room
    // opened (or a viewer added) mid-video arms from it. The content is
    // only uploaded once some viewer needs it.
    this._scriptGen = 0;
    this._source = { gen: 0, kind: SOURCE_KIND.NONE, player: SOURCE_PLAYER.LOCAL, title: '', settled: true };
    // content hash -> { url, at }: one upload per script, reused by every
    // viewer and by a later source with the same content.
    this._urlCache = new Map();
    // Last emitted status per key, so repeats do not flood the pop-out.
    this._lastEmitted = new Map();

    // FN-06 (Dave 2026-11-17: viewers SHOULD hold through stalls). A stall
    // of the local video (onStalled) opens the streamer's own grace window
    // (playback-stall.js, FN-05): nothing is sent inside it; past it every
    // viewer stops, as the streamer's Handy does, and stays stopped until
    // the picture moves ('playing'). No play passes the gate while a stall
    // lasts. Before this the viewers' Handys ran on through every buffering
    // stall and were pulled back by the next 'playing' (found while FT-120).
    this._stall = new StallGrace({ onExpire: (reason) => this._holdForStall(reason) });
  }

  // --- Lifecycle ---

  /**
   * Open a room. Loads the saved viewer roster from settings but does
   * NOT auto-connect them — the user explicitly adds viewers via the
   * pop-out UI. Roster is just for "remembered names + keys" so the
   * pop-out can pre-fill the list.
   */
  openRoom() {
    if (this._roomActive) return;
    this._roomActive = true;
    console.log('[Audience] Room opened');
    this._emit('audience:room-opened', {});
  }

  /**
   * End the room. Stops every device, disconnects every viewer, clears
   * runtime state. Roster (settings) persists so next session is
   * pre-populated. Safe to call when no room is open (no-op).
   */
  async endRoom() {
    if (!this._roomActive) return;
    // Before any stop: nothing in flight may lead to a play after teardown.
    this._ending = true;
    this._endStall('room-ended');
    const keys = [...this._viewers.keys()];
    console.log(`[Audience] Ending room — tearing down ${keys.length} viewer(s)`);
    try {
      await Promise.allSettled(keys.map((k) => this._teardownViewer(k)));
    } finally {
      this._viewers.clear();
      this._lastEmitted.clear();
      this._roomActive = false;
      this._ending = false;
    }
    console.log('[Audience] Room ended');
    this._emit('audience:room-ended', {});
  }

  get roomActive() {
    return this._roomActive;
  }

  // --- Source (what viewers should be playing) ---

  /**
   * A new video or script is about to be loaded. Bumps the generation and
   * stops every viewer, muted ones included (skipped only when known
   * stopped). From here no play can pass the gate until a setup for this
   * generation succeeds. Take the token before your first await.
   *
   * `player` is the player this source is loaded for (SOURCE_PLAYER). Only a
   * LOCAL source is ever played; a VR or phone one is set up but stays
   * stopped, and ends with its session (endSource).
   *
   * @param {{title?: string, player?: string}} [opts]
   * @returns {number} token for setScript / setNoScript
   */
  beginSource({ title = '', player = SOURCE_PLAYER.LOCAL } = {}) {
    // The old video's stall (FN-06) is over with it; the stop below holds.
    this._endStall('source');
    const gen = ++this._scriptGen;
    this._source = {
      gen,
      kind: SOURCE_KIND.LOADING,
      // Anything but LOCAL (a typo included) is never played: conservative.
      player,
      title: String(title || ''),
      settled: false,
    };
    if (this._viewers.size > 0) {
      console.log(`[Audience] Source ${gen} begins — stopping ${this._viewers.size} viewer(s)`);
    }
    for (const v of this._viewers.values()) {
      v.loadedGen = null;
      v.setup.wantedGen = null;
      // Per-generation failures belong to the old script; a failed STOP
      // stays until a stop succeeds.
      this._clearError(v, [VIEWER_ERROR.SETUP_FAILED, VIEWER_ERROR.PLAY_FAILED]);
      this._stopViewer(v, 'source');
    }
    return gen;
  }

  /**
   * The script for `token`'s source. Uploaded once (by content), then set
   * up on every connected, unmuted viewer; each plays as soon as its own
   * setup succeeds and the gate passes (staggered start, SCOPE O-1).
   * Content with fewer than 2 actions counts as no script.
   *
   * `content` is the raw funscript, or a function that returns it. A
   * function is only called the first time a viewer needs the script, so a
   * user with no room open pays nothing for it, and a throw in it lands
   * here (as "couldn't load the script"), never in the caller's load path.
   *
   * @returns {boolean} false when dropped (stale or already settled token)
   */
  setScript(token, { content, title } = {}) {
    if (!this._acceptSettle(token, 'setScript')) return false;
    this._source = {
      gen: token,
      kind: SOURCE_KIND.SCRIPT,
      player: this._source.player,
      title: title != null ? String(title) : this._source.title,
      build: content,
      content: null,      // set by _materializeSource
      hash: null,
      url: null,
      uploadPromise: null,
      settled: true,
    };
    // A string costs nothing more to check now; a builder waits for a viewer.
    if (typeof content !== 'function' && !this._materializeSource()) return true;
    for (const v of this._viewers.values()) this._armViewer(v);
    return true;
  }

  /**
   * `token`'s source has no script for viewers (no main script, a companion
   * only, a failed load). Viewers were stopped by beginSource and stay
   * stopped through play and seek until the next source.
   *
   * `failed: true` means the video HAS a script that could not be read or
   * loaded: rows then read "Couldn't load the script", not "No script for
   * this video", so the streamer is not sent looking for a missing file.
   *
   * @returns {boolean} false when dropped (stale or already settled token)
   */
  setNoScript(token, { title, reason = 'none', failed = false } = {}) {
    if (!this._acceptSettle(token, 'setNoScript')) return false;
    return this._settleNoScript(token, { title, reason, failed });
  }

  /**
   * `player` (VR or the phone) stopped driving playback. If the room's
   * source is that player's, viewers stop and the room has no script until
   * the next source: the local video element is the clock again, and that
   * script belongs to the video the headset or the phone was playing. A
   * source still loading for that player is ended too, so its late
   * setScript is dropped. A no-op when the source belongs to another player.
   *
   * @returns {boolean} true when the source was ended
   */
  endSource(player, { reason = 'player-ended' } = {}) {
    if (this._source.player !== player) return false;
    if (this._viewers.size > 0) {
      console.log(`[Audience] ${player} session ended — its source ${this._source.gen} ends with it`);
    }
    const token = this.beginSource({ title: this._source.title, player: SOURCE_PLAYER.LOCAL });
    return this.setNoScript(token, { reason });
  }

  /**
   * Whether the current source already gives viewers exactly `content` (an
   * editor save with nothing edited, FT-094 follow-up). Only a source a
   * viewer has made it build can say: `content` may be a function, and it is
   * called only then, so a room nobody watches still pays nothing.
   */
  sourceCarries(content) {
    const s = this._source;
    if (s.kind !== SOURCE_KIND.SCRIPT || s.content == null) return false;
    let text;
    try {
      text = typeof content === 'function' ? content() : content;
    } catch {
      return false;
    }
    if (typeof text !== 'string') return false;
    if (text === s.content) return true;
    // The editor writes its own JSON, so the same points can come back with
    // other formatting or metadata than the file had. Viewers play points.
    try {
      const a = JSON.parse(text).actions;
      const b = JSON.parse(s.content).actions;
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length
        && a.every((p, i) => p?.at === b[i]?.at && p?.pos === b[i]?.pos);
    } catch {
      return false;
    }
  }

  /** Current source, for diagnostics and tests. No content. */
  get source() {
    const s = this._source;
    return { gen: s.gen, kind: s.kind, player: s.player, title: s.title, reason: s.reason || null };
  }

  // --- Player events (the LOCAL video element; app.js wires them) ---

  /** The local player started playing (`playing`, not `play`). The picture
   *  moves: a stall is over (FN-06), and viewers play from here. */
  onPlaying() {
    this._endStall('playing');
    if (!this._roomActive) return;
    for (const v of this._viewers.values()) this._requestPlay(v);
  }

  onPaused() {
    // A pause is instant and ends any stall window at once (FN-06).
    this._endStall('pause');
    if (!this._roomActive) return;
    for (const v of this._viewers.values()) this._stopViewer(v, 'pause');
  }

  onEnded() {
    this.onPaused();
  }

  /**
   * FN-06: the local picture stopped without a pause: 'waiting' (it has no
   * next frame and owes a 'playing'), or 'stalled' when the element has run
   * out of frames too (a 'stalled' alone is about the network, and the
   * element may still play from its buffer; `video` is the element, to ask).
   * Nothing is sent inside the STALL_GRACE_MS window, so a hiccup of a few
   * frames is not a stop and a play; past it every viewer stops (_holdForStall),
   * muted ones too, and no play goes until the picture moves ('playing').
   * @param {'waiting'|'stalled'} [reason]
   * @param {object|null} [video]
   */
  onStalled(reason = 'waiting', video = null) {
    if (!this._roomActive) return;
    if (reason === 'stalled') {
      if (!isPictureStarved(video)) return;
      reason = 'waiting';
    }
    // A paused (or not the active) player: the pause owns the viewers.
    if (!this._isVideoPlaying()) return;
    if (this._stall.active) {
      this._stall.note(reason);
      return;
    }
    this._stall.begin(reason);
  }

  /** The stall outlasted its grace window (FN-06): hold every viewer. */
  _holdForStall(reason) {
    if (!this._roomActive || this._ending) return;
    if (this._viewers.size > 0) {
      console.log(`[Audience] picture stopped (${reason}) past the ${STALL_GRACE_MS} ms window — holding ${this._viewers.size} viewer(s) until it moves`);
    }
    for (const v of this._viewers.values()) this._stopViewer(v, 'stall');
  }

  /** End a stall (if any), with its one log line. Its owner (a 'playing',
   *  a pause, a new source, the room ending) decides what is sent. */
  _endStall(endedBy) {
    const ep = this._stall.end();
    if (ep && this._viewers.size > 0) console.log(`[Audience] ${stallSummary(ep, { endedBy })}`);
    return ep;
  }

  /** A seek while playing re-anchors (stop, then play at the new time). A
   *  seek while paused sends no play: viewers are already stopped. A seek
   *  inside a stall (FN-06; Chromium fires 'waiting' for a seek while
   *  playing) sends the stop and leaves the play to the 'playing' the
   *  element owes, as the streamer's own Handy does: a play now would anchor
   *  a picture that has not moved yet. */
  onSeeked() {
    if (!this._roomActive) return;
    const playing = this._isVideoPlaying();
    const owed = this._stall.active;
    if (owed) this._stall.note('seeked');
    for (const v of this._viewers.values()) {
      if (playing) {
        this._stopViewer(v, 'seek');
        if (!owed) this._requestPlay(v);
      } else {
        this._stopViewer(v, v.restReason);
      }
    }
  }

  /** HSSP cannot follow a rate other than 1x (video-player.js), so viewers
   *  stop; back at 1x they play again only if the gate passes. */
  onPlaybackRateChanged(rate) {
    if (!this._roomActive) return;
    const r = Number(rate);
    if (Number.isFinite(r) && r !== 1) {
      for (const v of this._viewers.values()) this._stopViewer(v, 'speed');
      return;
    }
    const playing = this._isVideoPlaying();
    for (const v of this._viewers.values()) {
      if (playing) this._requestPlay(v);
      else if (v.knownStopped) this._writeResting(v);
    }
  }

  // --- Viewer management ---

  /**
   * Add a viewer. Creates a HandyManager, connects, syncs its clock, stops
   * it, then arms it from the room's source (set up + play if the gate
   * passes). Works with no streamer Handy. Returns the viewer's snapshot.
   *
   * @param {{key: string, label?: string, offsetMs?: number}} opts
   */
  async addViewer({ key, label = '', offsetMs = 0 }) {
    if (!key || typeof key !== 'string') {
      throw new Error('addViewer: key required');
    }
    // Self-collision guard. If the streamer pastes their own Handy key
    // as a viewer, refuse — two SDK instances controlling the same
    // device fight over HSSP commands (last-write-wins on the Handy
    // server). The Handy tab already drives this device; routing it
    // through Audience too would just create chaos.
    const ownKey = this._getStreamerOwnKey?.();
    if (ownKey && this._normalizeKey(ownKey) === this._normalizeKey(key)) {
      console.warn(`[Audience] Refused self-key add (${this._maskKey(key)}) — already driven by the Handy tab`);
      const err = new Error("This is your own Handy — it's already controlled by the Handy tab.");
      err.code = 'SELF_KEY';
      throw err;
    }
    if (this._viewers.has(key)) {
      // Duplicate — update the label if provided, no-op on offset.
      const existing = this._viewers.get(key);
      if (label && label !== existing.label) {
        existing.label = label;
        this._persistRoster();
      }
      return this._snapshot(key);
    }

    const viewer = this._newViewer({ key, label, offsetMs });
    this._viewers.set(key, viewer);
    this._persistRoster();
    this._emit('audience:viewer-added', { key, label });
    this._setStatus(key, VIEWER_STATUS.CONNECTING);

    const mask = this._maskKey(key);
    const who = label ? `"${label}" (${mask})` : mask;
    console.log(`[Audience] addViewer ${who} — connecting…`);

    if (await this._connectAndArm(viewer) === null) return null;
    return this._snapshot(key);
  }

  /**
   * Connect one viewer (again, for Resend), apply its offset, sync its
   * clock, stop it, then arm it from the room's source. Never throws: a
   * failure leaves the viewer in the room and the roster with Error (S6).
   * @returns {Promise<boolean|null>} null when the viewer was removed meanwhile
   */
  async _connectAndArm(viewer, { again = false } = {}) {
    const key = viewer.key;
    const mask = this._maskKey(key);
    viewer.connecting = true;
    try {
      if (!viewer.manager) viewer.manager = new this._HandyManagerCtor();
      // HandyManager requires init() — it loads the SDK ESM bundle and
      // creates this instance's own Handy object — BEFORE connect() will
      // do anything (connect() returns false while `_handy` is null).
      // Each viewer gets its own connection state, BUT the SDK module (and
      // its single request queue, its client-server offset and its
      // localStorage) is shared with every other viewer and the streamer's
      // own Handy — see STOPGAP LIMITS at the top of this file. Missing this
      // call was the "Audience connects nothing" bug — the test fake didn't
      // model init(), so the unit suite stayed green while production failed.
      // Once per instance: a second init() makes a new Handy object and
      // leaves the first one's listeners behind, so Resend reuses it.
      if (!viewer.inited) {
        if (typeof viewer.manager.init === 'function') await viewer.manager.init();
        viewer.inited = true;
      }
      if (viewer.removed) return null;
      // connect() needs the key as an argument — the constructor does not
      // capture it.
      const ok = await viewer.manager.connect(key);
      if (viewer.removed) return null;
      if (!ok) throw new Error('Connect failed (device offline, in BT mode, or bad key?)');
      viewer.connected = true;
      // A connect failure's message belongs to that attempt.
      if (!viewer.errorCode) viewer.lastError = null;
      console.log(`[Audience] ${mask} ${again ? 'connected again' : 'connected'}`);

      // Apply saved offset if any.
      if (viewer.offsetMs !== 0 && typeof viewer.manager.setOffset === 'function') {
        try {
          await viewer.manager.setOffset(viewer.offsetMs);
          console.log(`[Audience] ${mask} offset applied: ${viewer.offsetMs}ms`);
        } catch (err) {
          console.warn(`[Audience] ${mask} setOffset failed (non-fatal): ${err?.message || err}`);
        }
      }

      // Device clock sync, once on join. The SDK's sync() leaves HSSP
      // unresponsive until it is stopped and replayed
      // (feedback_handy_sync_needs_hssp_restart): the stop below and the
      // gated play after the setup are that restart.
      if (typeof viewer.manager.syncTime === 'function') {
        this._setStatus(key, VIEWER_STATUS.CALIBRATING);
        const sync = await viewer.manager.syncTime();
        if (viewer.removed) return null;
        if (sync?.avgRtd != null) viewer.rtdMs = Math.round(sync.avgRtd);
      }

      // Stop before anything else (S2): the device may still be running
      // whatever it last played.
      await this._stopViewer(viewer, 'join');
      // Arm from the room's source — not from the streamer's own upload —
      // so joining works with no streamer Handy (research §4.11).
      await this._armViewer(viewer);
      await this._playSettled(viewer);
      return true;
    } catch (err) {
      // Not connected unless HandyManager still is: a Resend whose connect
      // fails on a device the SDK still holds must not stop sending stops
      // to it (`_sendStop` skips a viewer that never connected).
      viewer.connected = !!viewer.manager?.connected;
      viewer.lastError = err?.message || String(err);
      console.error(`[Audience] ${mask} FAILED to ${again ? 'connect again' : 'add'}: ${viewer.lastError}`);
      // The viewer stays in the room and the roster (S6).
      this._setStatus(key, VIEWER_STATUS.ERROR, { error: viewer.lastError });
      return false;
    } finally {
      viewer.connecting = false;
    }
  }

  /**
   * Remove a viewer. Stops their device, disconnects, removes from
   * runtime state. Roster entry stays in settings unless `forget` is
   * true.
   */
  async removeViewer(key, { forget = false } = {}) {
    if (!this._viewers.has(key)) return;
    console.log(`[Audience] ${this._maskKey(key)} removed${forget ? ' (forgotten)' : ''}`);
    await this._teardownViewer(key);
    this._viewers.delete(key);
    this._lastEmitted.delete(key);
    if (forget) {
      const roster = this._readRoster().filter((v) => v.key !== key);
      this._writeRoster(roster);
    } else {
      this._persistRoster();
    }
    this._emit('audience:viewer-removed', { key });
  }

  setOffsetForViewer(key, ms) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    const clamped = Math.max(-500, Math.min(500, Math.round(Number(ms) || 0)));
    viewer.offsetMs = clamped;
    if (viewer.manager?.setOffset) {
      Promise.resolve(viewer.manager.setOffset(clamped)).catch(() => {});
    }
    this._persistRoster();
    this._emit('audience:viewer-offset', { key, offsetMs: clamped });
  }

  setLabel(key, label) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    viewer.label = String(label || '');
    this._persistRoster();
  }

  /**
   * Mute stops the device. Unmute sets up the current script if this viewer
   * does not have it (a setup only — no clock sync, which would queue ~30
   * server-time requests in the shared SDK queue), then plays only if the
   * gate passes. So unmute while paused sets up and does not play.
   */
  async setMuted(key, muted) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    const wasMuted = viewer.muted;
    viewer.muted = !!muted;
    if (wasMuted === viewer.muted) return;
    console.log(`[Audience] ${this._maskKey(key)} ${viewer.muted ? 'muted' : 'unmuted'}`);
    // Emit every change, even when the status itself stays the same: the
    // room window learns `muted` only from this event. It never did, so after
    // Mute its button still read "Mute" and pressing it sent "mute" again — a
    // muted viewer could not be unmuted from the room (app test, 2026-11-04).
    this._setStatus(key, viewer.muted ? viewer.status : this._unmutedStatus(viewer));
    if (viewer.muted) {
      viewer.setup.wantedGen = null;
      await this._stopViewer(viewer, 'mute');
      if (!viewer.connected) this._setStatus(key, VIEWER_STATUS.MUTED);
    } else {
      await this._armViewer(viewer);
      await this._playSettled(viewer);
    }
  }

  /**
   * Resend (FT-121): start one viewer over from the room's source, for a
   * viewer that dropped offline, was switched off and on, or shows an error.
   *
   * A viewer that dropped (HandyManager's health check lost it, the bridge
   * saw it unreachable, or it never connected) rejoins as Add does, on the
   * same HandyManager: connect, offset, clock sync, stop. One still
   * reachable is stopped, its clock synced again and stopped again (a power
   * cycle the health check missed looks just like this). Then, as Unmute
   * does: a fresh setup of the current script (whatever the bridge last
   * heard, a device that was switched off has lost it) and a play only if
   * the gate passes (S1). Nothing for a muted viewer, or while it is still
   * connecting, being resent or buzzed. A setup or play error is cleared; a
   * failed stop's error clears only when a stop succeeds. No automatic
   * offline probe: that is phase 2.
   * @returns {Promise<boolean>} false when refused or the connect failed
   */
  async resend(key) {
    const v = this._viewers.get(key);
    const mask = this._maskKey(key);
    if (!this._roomActive || this._ending || !this._isLive(v)) return false;
    if (v.muted || v.connecting || v.resending || v.buzzing) {
      console.log(`[Audience] ${mask} resend refused: ${v.muted ? 'muted' : 'busy'}`);
      return false;
    }
    v.resending = true;
    try {
      const dropped = !v.connected || !this._reachable(v) || v.status === VIEWER_STATUS.DISCONNECTED;
      console.log(`[Audience] ${mask} resend${dropped ? ' — connecting again first' : ''}`);
      v.loadedGen = null;
      v.setup.wantedGen = null;
      this._clearError(v, [VIEWER_ERROR.SETUP_FAILED, VIEWER_ERROR.PLAY_FAILED]);
      if (dropped) {
        // Nothing believed about a device that went away survives it. A
        // command still out on the lost link is no longer the last one, so
        // its answer marks nothing, and the join stop is really sent.
        ++v.cmdSeq;
        v.knownStopped = false;
        v.stopProven = false;
        this._setStatus(key, VIEWER_STATUS.CONNECTING);
        return (await this._connectAndArm(v, { again: true })) === true;
      }
      // Quiet first (S2): what the device is doing is the question.
      await this._stopViewer(v, 'resend');
      if (!this._isLive(v) || v.muted) return false;
      // A Handy switched off and on that the health check never noticed
      // (the SDK reconnects on its own) has lost its clock sync as well as
      // its script, and nothing here can tell: sync again, as Add does. The
      // SDK's sync leaves HSSP deaf until a stop and a play
      // (feedback_handy_sync_needs_hssp_restart), so a stop of its own
      // follows, past the throttle window, before the setup and the play.
      if (typeof v.manager?.syncTime === 'function') {
        this._setStatus(key, VIEWER_STATUS.CALIBRATING);
        const sync = await v.manager.syncTime();
        if (!this._isLive(v)) return false;
        if (sync?.avgRtd != null) v.rtdMs = Math.round(sync.avgRtd);
        v.knownStopped = false;
        v.stopProven = false;
        await this._stopWindowClear(v);
        await this._stopViewer(v, 'resend');
        if (!this._isLive(v) || v.muted) return false;
      }
      await this._armViewer(v);
      await this._playSettled(v);
      return true;
    } finally {
      v.resending = false;
    }
  }

  // --- Fan-out ---

  /**
   * Stop every viewer (quit, relaunch). Resolves when every device is
   * stopped by a stop whose own answer came back; each result is a boolean
   * (false = that device may still be moving).
   */
  async hsspStopAll() {
    if (!this._roomActive) return;
    const results = await Promise.allSettled(
      [...this._viewers.values()].map((v) => this._stopForQuit(v)),
    );
    this._logFanout('hsspStopAll', results);
    return results;
  }

  /**
   * One viewer's stop before the app goes away. The renderer may die the
   * moment hsspStopAll resolves, and every request the SDK still means to
   * send dies with it, so an ok is not enough (#361 review, 2026-11-04):
   *   - a play still out can land after the stop (S5); its answer sends
   *     another stop, so let it answer;
   *   - a stop made inside the SDK throttle window, or skipped because a
   *     stop like that left the viewer "known stopped", was handed an
   *     earlier stop's answer while its own request leaves 200 ms later from
   *     a renderer timer. Wait the window out and send one whose answer is
   *     its own.
   * At most ~250 ms plus one round trip more; main bounds the whole wait.
   */
  async _stopForQuit(v) {
    const ok = await this._stopViewer(v, 'pause');
    if (!this._isLive(v) || !v.manager || !v.connected) return ok;
    if (v.play.inFlight) await v.play.inFlight;
    // A test buzz's move can land after that stop too (FT-119); the buzz
    // skips the rest of its pulse and ends on a stop of its own.
    if (v.buzzing) await v.buzzing;
    if (!this._stoppedForSure(v)) await this._proveStopped(v);
    if (v.stopInFlight) await v.stopInFlight.promise;
    return this._stoppedForSure(v);
  }

  /**
   * Test buzz (FT-119): one gentle stroke on one viewer's device, the pulse
   * the Devices tab's Test sends (TEST_BUZZ_PULSE), so the viewer can say
   * how late it felt against the streamer's screen flash (`onPulse`, called
   * just before the first move). Through HandyManager.hdspMove, which
   * scales to the firmware (0-1 on FW4) and sends nothing while the
   * firmware is unknown. Until FT-119 this called `manager.hdsp()`, which
   * the real HandyManager does not have, so it sent nothing since it
   * shipped (the test fake had one).
   *
   * Refused (false) for a viewer that is not connected, is muted, is playing
   * or about to (a buzz mid-video would stop it for a setup), is being set
   * up (HDSP between setScript's steps loses the mode setup), connected or
   * resent, or whose last stop failed (the device may still be moving). A
   * stop still out answers first.
   *
   * HDSP leaves HSSP: the SDK's mode switch clears the script setup, and a
   * viewer's HandyManager has no cached URL to heal a play from (setupScript
   * never sets `_lastCloudUrl`, research §4.13), so a plain play would fail.
   * From the first move the gate is shut (no setup for the current script).
   * The buzz ends on a stop whose answer is its own (sent after every move
   * answered: HDSP is not in HandyManager's HSSP queue, so a stop made
   * during the buzz may have reached the device before a move), and the
   * viewer is armed again: a setup, and a play only if the gate passes. A
   * stop, Mute or Remove during the buzz skips the rest of the pulse.
   * @returns {Promise<boolean>} whether the pulse was sent
   */
  async testBuzz(key, { onPulse } = {}) {
    const v = this._viewers.get(key);
    const mask = this._maskKey(key);
    let why = this._buzzRefusal(v);
    if (!why && v.stopInFlight) {
      await v.stopInFlight.promise;
      why = this._buzzRefusal(v);
    }
    if (why) {
      console.log(`[Audience] ${mask} test buzz refused: ${why}`);
      return false;
    }
    const m = v.manager;
    const { high, low, moveMs, gapMs } = TEST_BUZZ_PULSE;
    const epoch = v.stopEpoch;
    const still = () => this._isLive(v) && v.manager === m && !v.muted
      && v.stopEpoch === epoch && this._reachable(v);
    const move = async (pos) => {
      ++v.cmdSeq;
      try {
        await m.hdspMove(pos, moveMs);
      } catch (err) {
        console.warn(`[Audience] ${mask} test buzz move failed: ${err?.message || err}`);
      }
    };
    console.log(`[Audience] ${mask} test buzz`);
    v.loadedGen = null;
    v.knownStopped = false;
    v.stopProven = false;
    v.buzzing = (async () => {
      try { onPulse?.(); } catch { /* the screen flash is cosmetic */ }
      await move(high);
      await sleep(gapMs);
      if (still()) {
        await move(low);
        // Let the second move finish: the stop below would cut it short.
        await sleep(gapMs);
      }
      // The last word is a stop sent after every move answered, past the
      // SDK throttle window, so its answer is its own.
      if (!this._isLive(v) || v.manager !== m) return;
      if (v.stopInFlight) await v.stopInFlight.promise;
      const wait = SDK_THROTTLE_GAP_MS - (Date.now() - v.stopSettledAt);
      if (wait > 0) await sleep(wait);
      if (this._isLive(v) && v.manager === m) await this._sendStop(v, { force: true });
    })().finally(() => { v.buzzing = null; });
    await v.buzzing;
    if (this._isLive(v) && v.manager === m) {
      await this._armViewer(v);
      await this._playSettled(v);
    }
    return true;
  }

  /** Test buzz on every viewer that takes one; `onPulse` fires once, with
   *  the first. */
  async testBuzzAll({ onPulse } = {}) {
    if (!this._roomActive) return;
    let pulsed = false;
    const once = () => {
      if (pulsed) return;
      pulsed = true;
      onPulse?.();
    };
    await Promise.allSettled(
      [...this._viewers.keys()].map((k) => this.testBuzz(k, { onPulse: once })),
    );
  }

  /** Why `v` cannot take a test buzz now, or null when it can (FT-119). */
  _buzzRefusal(v) {
    if (!this._roomActive || this._ending || !this._isLive(v)) return 'not in the room';
    if (!this._reachable(v)) return 'not connected';
    if (typeof v.manager.hdspMove !== 'function') return 'no HDSP';
    // hdspMove sends nothing while the firmware is unknown (0-100 on FW4
    // would slam the slider into its end stop), so no pulse could go: no
    // screen flash, no gate shut, no stop and re-arm for nothing (block F
    // review, 2026-11-16).
    if (hdspPositionScale(v.manager.deviceInfo) === null) return 'firmware not known yet';
    if (v.muted) return 'muted';
    if (v.buzzing || v.connecting || v.resending) return 'busy';
    if (v.errorCode === VIEWER_ERROR.STOP_FAILED) return 'its last stop failed';
    if (v.setup.sending != null) return 'its script is being set up';
    const p = v.play;
    if (v.status === VIEWER_STATUS.PLAYING || p.inFlight || p.timer || p.proving || p.wanted
        || this._canPlay(v)) return 'playing';
    return null;
  }

  // --- State accessors ---

  /** Array of plain-object viewer snapshots (no live HandyManager refs). */
  get viewers() {
    return [...this._viewers.keys()].map((k) => this._snapshot(k));
  }

  getViewerStatus(key) {
    const v = this._viewers.get(key);
    return v ? v.status : null;
  }

  /**
   * Aggregate status for the tab LED. Red if any viewer is errored,
   * disconnected or could not get the script; amber while any is
   * connecting, calibrating, waiting for or loading the script (so a row
   * that does not hold the current script is never green); green otherwise;
   * dim with no room. Mirrored by aggregateStatus() in audience-room.js.
   */
  get aggregateStatus() {
    if (!this._roomActive || this._viewers.size === 0) return 'dim';
    const statuses = [...this._viewers.values()].map((v) => v.status);
    if (statuses.some((s) =>
      s === VIEWER_STATUS.ERROR ||
      s === VIEWER_STATUS.DISCONNECTED ||
      s === VIEWER_STATUS.SCRIPT_FAILED,
    )) return 'error';
    if (statuses.some((s) =>
      s === VIEWER_STATUS.CONNECTING ||
      s === VIEWER_STATUS.UPLOADING ||
      s === VIEWER_STATUS.CALIBRATING ||
      s === VIEWER_STATUS.WAITING,
    )) return 'warning';
    return 'connected';
  }

  // --- Internals: source ---

  _acceptSettle(token, op) {
    if (token == null || token !== this._scriptGen) {
      console.debug(`[Audience] ${op} dropped — token ${token} is not the current source (${this._scriptGen})`);
      return false;
    }
    if (this._source.settled) {
      console.debug(`[Audience] ${op} ignored — source ${token} is already settled`);
      return false;
    }
    return true;
  }

  _settleNoScript(token, { title, reason, failed = false }) {
    this._source = {
      gen: token,
      kind: failed ? SOURCE_KIND.FAILED : SOURCE_KIND.NO_SCRIPT,
      player: this._source.player,
      title: title != null ? String(title) : this._source.title,
      reason: reason || 'none',
      settled: true,
    };
    if (this._viewers.size > 0) {
      console.log(`[Audience] Source ${token}: ${failed ? 'script failed to load' : 'no script'} (${this._source.reason}) — viewers stay stopped`);
    }
    // Viewers whose T0 stop is still in flight get the label from its result.
    for (const v of this._viewers.values()) {
      if (v.knownStopped) this._writeResting(v);
    }
    return true;
  }

  /**
   * Turn the current script source's `build` (the raw funscript, or a
   * function returning it) into the content viewers get, once. Fewer than 2
   * actions (the SDK's CSV conversion refuses it) or unreadable JSON settles
   * the source as no script; a builder that throws settles it as failed.
   * @returns {boolean} true while the source is a usable script
   */
  _materializeSource() {
    const s = this._source;
    if (s.kind !== SOURCE_KIND.SCRIPT) return false;
    if (s.content != null) return true;
    let text;
    try {
      text = typeof s.build === 'function' ? s.build() : s.build;
    } catch (err) {
      console.warn(`[Audience] Source ${s.gen}: building the viewers' script failed: ${err?.message || err}`);
      this._settleNoScript(s.gen, { reason: 'build-failed', failed: true });
      return false;
    }
    text = typeof text === 'string' ? text : '';
    const actions = countActions(text);
    if (actions < 2) {
      this._settleNoScript(s.gen, { reason: actions < 0 ? 'unreadable' : 'too-few-actions' });
      return false;
    }
    s.content = text;
    s.build = null;
    s.hash = hashContent(text);
    const cached = this._urlCache.get(s.hash);
    s.url = cached && Date.now() - cached.at < URL_CACHE_TTL_MS ? cached.url : null;
    const targets = [...this._viewers.values()].filter((v) => v.connected && !v.muted);
    if (targets.length > 0) {
      console.log(`[Audience] Source ${s.gen}: script (${actions} actions) — setting up ${targets.length} viewer(s)`);
    }
    return true;
  }

  /** Upload the current source's content once (keyless, no device needed)
   *  and share the URL. One retry; then the source is FAILED, viewers stay
   *  stopped and the app is told (toast). Resolves null when superseded. */
  _ensureUploaded(gen) {
    const s = this._source;
    if (s.gen !== gen || s.kind !== SOURCE_KIND.SCRIPT) return Promise.resolve(null);
    if (!this._materializeSource()) return Promise.resolve(null);
    if (s.url) return Promise.resolve(s.url);
    if (s.uploadPromise) return s.uploadPromise;
    s.uploadPromise = (async () => {
      let url = null;
      for (let attempt = 1; attempt <= 2 && !url; attempt++) {
        url = await this._tryUpload(s.content);
        if (url) this._urlCache.set(s.hash, { url, at: Date.now() });
        if (this._source !== s) return null;
        if (!url && attempt === 1) {
          console.warn(`[Audience] Source ${gen}: script upload failed — retrying in ${UPLOAD_RETRY_DELAY_MS} ms`);
          await sleep(UPLOAD_RETRY_DELAY_MS);
          if (this._source !== s) return null;
        }
      }
      if (!url) {
        s.kind = SOURCE_KIND.FAILED;
        console.warn(`[Audience] Source ${gen}: script upload failed twice — viewers stay stopped`);
        for (const v of this._viewers.values()) {
          if (v.knownStopped) this._writeResting(v);
        }
        this._emit('audience:script-upload-failed', { title: s.title });
        return null;
      }
      s.url = url;
      console.log(`[Audience] Source ${gen}: script uploaded once for every viewer`);
      return url;
    })();
    return s.uploadPromise;
  }

  async _tryUpload(content) {
    if (typeof this._uploadScript !== 'function') {
      console.warn('[Audience] No script uploader configured');
      return null;
    }
    try {
      const url = await this._uploadScript(content);
      return typeof url === 'string' && url ? url : null;
    } catch (err) {
      console.warn(`[Audience] Script upload failed: ${err?.message || err}`);
      return null;
    }
  }

  // --- Internals: per-viewer commands ---

  _newViewer({ key, label, offsetMs }) {
    return {
      key,
      label,
      offsetMs: Number.isFinite(offsetMs) ? offsetMs : 0,
      manager: null,
      status: VIEWER_STATUS.CONNECTING,
      rtdMs: null,
      lastError: null,
      errorCode: null,
      muted: false,
      connected: false,     // connect() succeeded
      inited: false,        // manager.init() ran (once per instance)
      connecting: false,    // a connect is under way (Add, or Resend's reconnect)
      resending: false,     // a Resend is under way (FT-121)
      buzzing: null,        // a test buzz's promise while it runs (FT-119)
      removed: false,       // teardown started: nothing may write or play
      loadedGen: null,      // generation whose setup succeeded on this device
      knownStopped: false,  // last command sent was a stop that returned ok
      stopProven: false,    // ...and that ok was its own (outside the SDK throttle window)
      restReason: 'join',   // why it is stopped: picks Ready vs Paused vs speed
      cmdSeq: 0,            // bumped by every command sent
      lastStopSeq: 0,
      stopEpoch: 0,         // bumped by every stop REQUEST (S5, cancels plays)
      stopInFlight: null,   // { seq, promise, windowed }
      stopSettledAt: -Infinity, // when the last stop answered
      // suspect: the last setup answered false, so the SDK may still hold
      // its request and hand the next setup its answer.
      setup: { inFlight: null, wantedGen: null, sending: null, lastSettledAt: -Infinity, suspect: false },
      // last: the last play sent, { gen, epoch, seq, timeMs, sentAt, ok,
      // settledAt }, for dropping a request it already covers (FT-120).
      play: { inFlight: null, wanted: false, timer: null, proving: null, lastSettledAt: -Infinity, last: null },
    };
  }

  _isLive(v) {
    return !!v && !v.removed && this._viewers.get(v.key) === v;
  }

  /** Connected, and HandyManager's own health check has not lost it. */
  _reachable(v) {
    return !!(v.connected && v.manager && v.manager.connected !== false);
  }

  /** HandyManager's health check reported the device gone. Its HSSP state
   *  cannot be trusted when it comes back, so it needs a fresh setup. */
  _noteUnreachable(v) {
    v.loadedGen = null;
    v.knownStopped = false;
    v.stopProven = false;
    if (v.status !== VIEWER_STATUS.DISCONNECTED) {
      console.warn(`[Audience] ${this._maskKey(v.key)} unreachable — not sending commands`);
      this._setStatus(v.key, VIEWER_STATUS.DISCONNECTED);
    }
  }

  _rate() {
    const r = Number(this._getPlaybackRate?.());
    return Number.isFinite(r) && r > 0 ? r : 1;
  }

  /** S1 — the one play gate. Every play goes through here. */
  _canPlay(v) {
    if (!this._roomActive || this._ending) return false;
    if (!this._isLive(v) || !this._reachable(v)) return false;
    if (v.muted || v.errorCode) return false;
    const s = this._source;
    if (s.kind !== SOURCE_KIND.SCRIPT || s.gen !== this._scriptGen) return false;
    // Stopgap: only a source the LOCAL player loaded is played. A VR or
    // phone script must never run on the local video's timeline, even in
    // the moment between that session ending and endSource (#361 review).
    if (s.player !== SOURCE_PLAYER.LOCAL) return false;
    if (v.loadedGen !== s.gen) return false;
    if (!this._isVideoPlaying()) return false;
    if (this._rate() !== 1) return false;
    // FN-06: the picture is stalled (inside its grace window or held past
    // it). A play now would run the viewer ahead of a frozen picture; the
    // 'playing' that ends the stall asks again.
    if (this._stall.active) return false;
    return true;
  }

  /** Set up the current source's script on this viewer, or relabel it. */
  _armViewer(v) {
    if (!this._isLive(v) || !v.connected || v.muted) return Promise.resolve();
    // The first viewer that needs the script builds it (may settle the
    // source as no script, so read it after).
    this._materializeSource();
    const s = this._source;
    if (s.kind !== SOURCE_KIND.SCRIPT) {
      if (v.knownStopped) this._writeResting(v);
      return Promise.resolve();
    }
    if (v.loadedGen === s.gen) {
      if (v.knownStopped) this._writeResting(v);
      this._requestPlay(v);
      return Promise.resolve();
    }
    v.setup.wantedGen = s.gen;
    return this._pumpSetup(v);
  }

  _setupStillWanted(v, gen) {
    return this._isLive(v) && v.connected && !v.muted
      && v.setup.wantedGen === gen
      && gen === this._scriptGen
      && this._source.kind === SOURCE_KIND.SCRIPT;
  }

  /** One setup at a time per viewer, latest generation wins. Generation
   *  checked before the call and after the result (S3). */
  _pumpSetup(v) {
    if (v.setup.inFlight) return v.setup.inFlight;
    const run = (async () => {
      while (v.setup.wantedGen != null) {
        const gen = v.setup.wantedGen;
        const dropIfStale = () => {
          if (this._setupStillWanted(v, gen)) return false;
          if (v.setup.wantedGen === gen) v.setup.wantedGen = null;
          return true;
        };
        if (dropIfStale()) continue;
        const url = await this._ensureUploaded(gen);
        if (dropIfStale()) continue;
        if (!url) { v.setup.wantedGen = null; break; }
        // SDK throttle: a second setScript within 200 ms of the last one
        // settling would get the PREVIOUS call's result back.
        const wait = SDK_THROTTLE_GAP_MS - (Date.now() - v.setup.lastSettledAt);
        if (wait > 0) await sleep(wait);
        if (dropIfStale()) continue;
        // S2: never set a script up under a device that may still be moving.
        // A play still out can land after any stop, so let it answer first
        // (its S5 re-stop is then queued ahead of this setup).
        if (v.play.inFlight) {
          await v.play.inFlight;
          if (dropIfStale()) continue;
        }
        // ...and the stop under it must be one whose own answer came back:
        // a stop inside the SDK throttle window may have been handed the
        // previous stop's answer, with its own request still to leave, and
        // this setup would queue ahead of it.
        if (this._stopWaitNeeded(v)) {
          await this._stopWindowClear(v);
          if (dropIfStale()) continue;
        }
        // A test buzz still moving the device ends first (it ends on a stop
        // of its own): HDSP sent between setScript's steps would lose the
        // mode setup (FT-119). Then every wait above again.
        if (v.buzzing) {
          await v.buzzing;
          continue;
        }
        if (!this._reachable(v)) { this._noteUnreachable(v); v.setup.wantedGen = null; break; }
        // HandyManager runs this stop (or the one still in flight, which is
        // the last command and has its own answer coming) before the setup
        // below.
        if (!this._stoppedForSure(v)) this._sendStop(v, { force: !v.stopInFlight });
        v.setup.wantedGen = null;
        ++v.cmdSeq;
        v.knownStopped = false;
        v.setup.sending = gen;
        if (!v.errorCode) this._setStatus(v.key, VIEWER_STATUS.UPLOADING);
        let ok = await this._call(v, 'setupScript', url);
        v.setup.lastSettledAt = Date.now();
        // SDK throttle after a HandyManager deadline: the previous setup
        // answered false at HandyManager's deadline while the SDK still held
        // its request, so this call may have been handed THAT request's
        // answer (an older URL) while its own leaves 200 ms later. Its ok is
        // not trusted: ask again past the window and take that answer.
        if (ok && v.setup.suspect && this._isLive(v) && gen === this._scriptGen) {
          console.log(`[Audience] ${this._maskKey(v.key)} script ${gen}: the last setup failed — asking again before trusting this one`);
          await sleep(SDK_THROTTLE_GAP_MS);
          if (this._isLive(v) && gen === this._scriptGen) {
            ok = await this._call(v, 'setupScript', url);
            v.setup.lastSettledAt = Date.now();
          }
        }
        v.setup.suspect = !ok;
        v.setup.sending = null;
        // Stale: a newer source began (or the viewer left) while this ran.
        // Its result says nothing about what viewers should play now.
        if (!this._isLive(v) || gen !== this._scriptGen || this._source.kind !== SOURCE_KIND.SCRIPT) continue;
        if (ok) {
          v.loadedGen = gen;
          if (v.muted) continue;
          console.log(`[Audience] ${this._maskKey(v.key)} script ${gen} set up`);
          this._clearError(v, [VIEWER_ERROR.SETUP_FAILED]);
          v.restReason = 'ready';
          this._writeResting(v);
          this._requestPlay(v);
        } else {
          console.warn(`[Audience] ${this._maskKey(v.key)} script ${gen} setup failed — stays stopped`);
          this._setError(v, VIEWER_ERROR.SETUP_FAILED, 'Script setup failed');
        }
      }
    })().finally(() => { v.setup.inFlight = null; });
    v.setup.inFlight = run;
    return run;
  }

  /** Ask for a play; sent only if (and when) the gate passes. Latest wins:
   *  the time is read when the play is sent, not when it was asked for. */
  _requestPlay(v) {
    if (!this._canPlay(v)) return;
    // FT-120: a seek fires `seeked` and then `playing`, and both ask.
    if (this._lastPlayHolds(v)) {
      console.debug(`[Audience] ${this._maskKey(v.key)} play request covered by the play just sent`);
      return;
    }
    v.play.wanted = true;
    this._pumpPlay(v);
  }

  /**
   * Whether the last play already gives a new request its anchor (FT-120):
   * same script, no stop and no other command since, still out or answered
   * ok under PLAY_COALESCE_MS ago, and the video is where that play anchored
   * it (its time plus the wall time since; plays only go at 1x). A video
   * that stalled since (buffering after the seek) is not, and gets the new
   * play; so does a request after any stop, which is never dropped (S5).
   */
  _lastPlayHolds(v) {
    const p = v.play;
    const last = p.last;
    if (!last || p.wanted || p.timer || p.proving) return false;
    if (last.gen !== this._scriptGen || last.epoch !== v.stopEpoch || last.seq !== v.cmdSeq) return false;
    const out = !!p.inFlight && last.ok === null;
    const fresh = last.ok === true && Date.now() - last.settledAt < PLAY_COALESCE_MS;
    if (!out && !fresh) return false;
    const now = Number(this._getCurrentVideoTimeMs());
    if (!Number.isFinite(now)) return false;
    return Math.abs(now - (last.timeMs + (Date.now() - last.sentAt))) <= PLAY_ANCHOR_TOLERANCE_MS;
  }

  _pumpPlay(v) {
    const p = v.play;
    if (p.inFlight || p.timer || p.proving || !p.wanted) return;
    const wait = SDK_THROTTLE_GAP_MS - (Date.now() - p.lastSettledAt);
    if (wait > 0) {
      p.timer = setTimeout(() => { p.timer = null; this._pumpPlay(v); }, wait);
      return;
    }
    // A stop still out answers before the play goes (FT-120). HandyManager
    // queues a play behind it and reads the server time only when the play
    // runs, so a video time read now would anchor the device behind the
    // video by the stop's round trip (the second play a seek's `playing`
    // used to send made up for it). And a stop that was handed an earlier
    // stop's answer still has its own request to leave: a play sent now
    // would land first and be stopped by it. Get a stop with its own answer
    // first, then play.
    if (this._canPlay(v) && (v.stopInFlight || (v.knownStopped && !v.stopProven))) {
      p.proving = this._stopAnsweredForPlay(v).finally(() => {
        p.proving = null;
        this._pumpPlay(v);
      });
      return;
    }
    p.wanted = false;
    if (!this._canPlay(v)) return;
    const epoch = v.stopEpoch;
    const gen = this._scriptGen;
    const seq = ++v.cmdSeq;
    const timeMs = Math.max(0, Math.round(Number(this._getCurrentVideoTimeMs()) || 0));
    v.knownStopped = false;
    const sent = { gen, epoch, seq, timeMs, sentAt: Date.now(), ok: null, settledAt: null };
    p.last = sent;
    p.inFlight = this._call(v, 'hsspPlay', timeMs).then((ok) => {
      p.inFlight = null;
      p.lastSettledAt = Date.now();
      sent.ok = ok;
      sent.settledAt = p.lastSettledAt;
      // Teardown re-stops after an in-flight play itself (_teardownViewer).
      if (!this._isLive(v)) return ok;
      if (epoch !== v.stopEpoch) {
        // S5: a stop was issued while this play was out. Whatever it
        // answered, it may have reached the device AFTER the stop.
        console.log(`[Audience] ${this._maskKey(v.key)} play answered after a stop — stopping again`);
        this._sendStop(v, { force: true });
        this._pumpPlay(v);
        return ok;
      }
      if (gen !== this._scriptGen || seq !== v.cmdSeq) { this._pumpPlay(v); return ok; }
      if (ok) {
        this._clearError(v, [VIEWER_ERROR.PLAY_FAILED]);
        this._setStatus(v.key, VIEWER_STATUS.PLAYING);
      } else {
        console.warn(`[Audience] ${this._maskKey(v.key)} play at ${timeMs}ms failed`);
        this._setError(v, VIEWER_ERROR.PLAY_FAILED, 'Play failed');
      }
      this._pumpPlay(v);
      return ok;
    });
  }

  /** The device is stopped by a stop whose own answer came back ok, and
   *  nothing was sent after it. */
  _stoppedForSure(v) {
    return v.knownStopped && v.stopProven;
  }

  /** Whether a stop sent now could be handed an earlier stop's answer by
   *  the SDK throttle. A stop in flight that has its own answer coming and
   *  is still the last command is fine as it is: HandyManager runs what
   *  follows after it. */
  _stopWaitNeeded(v) {
    const f = v.stopInFlight;
    if (f) return f.windowed || f.seq !== v.cmdSeq;
    return !this._stoppedForSure(v) && Date.now() - v.stopSettledAt < SDK_THROTTLE_GAP_MS;
  }

  /** Resolves once a stop sent now gets an answer of its own (see
   *  _stopWaitNeeded): lets a doubtful in-flight stop answer, then waits out
   *  the SDK throttle window after the last stop's answer. */
  async _stopWindowClear(v) {
    while (this._isLive(v) && this._stopWaitNeeded(v)) {
      if (v.stopInFlight) await v.stopInFlight.promise;
      else await sleep(SDK_THROTTLE_GAP_MS - (Date.now() - v.stopSettledAt));
    }
  }

  /** Before a play: replace a stop whose ok may have been an earlier
   *  stop's with one whose answer is its own. */
  async _proveStopped(v) {
    await this._stopWindowClear(v);
    if (!this._isLive(v) || !this._reachable(v)) return;
    if (v.knownStopped && !v.stopProven) await this._sendStop(v, { force: true });
  }

  /** Before a play: the stop still out has answered (FT-120), and the last
   *  stop's ok is its own. */
  async _stopAnsweredForPlay(v) {
    const f = v.stopInFlight;
    if (f && !f.windowed) await f.promise;
    await this._proveStopped(v);
  }

  /** Resolves once a play that is due has gone out and answered, or will
   *  not go. */
  async _playSettled(v) {
    if (v.play.proving) await v.play.proving;
    if (v.play.inFlight) await v.play.inFlight;
  }

  _cancelPendingPlay(v) {
    v.play.wanted = false;
    if (v.play.timer) {
      clearTimeout(v.play.timer);
      v.play.timer = null;
    }
  }

  /** S2 — a stop REQUEST: cancels any queued play, marks an in-flight one
   *  for re-stop (S5), then sends the stop unless the viewer is known
   *  stopped. Resolves to the stop's boolean. */
  _stopViewer(v, reason) {
    if (!this._isLive(v)) return Promise.resolve(false);
    v.restReason = reason;
    v.stopEpoch++;
    this._cancelPendingPlay(v);
    return this._sendStop(v);
  }

  _sendStop(v, { force = false } = {}) {
    // Never connected: nothing of ours runs there.
    if (!v.manager || !v.connected) return Promise.resolve(true);
    if (!this._reachable(v)) { this._noteUnreachable(v); return Promise.resolve(false); }
    if (!force) {
      if (v.knownStopped) {
        this._writeResting(v);
        return Promise.resolve(true);
      }
      // A stop that is still the last command sent covers this request too.
      if (v.stopInFlight && v.stopInFlight.seq === v.cmdSeq) return v.stopInFlight.promise;
    }
    // SDK throttle: made while another stop is out, or inside the window
    // after the last one answered, this stop may be handed THAT stop's
    // answer while its own request leaves 200 ms later. Its ok then says
    // the device will be stopped, not that it is.
    const windowed = !!v.stopInFlight || Date.now() - v.stopSettledAt < SDK_THROTTLE_GAP_MS;
    const seq = ++v.cmdSeq;
    v.lastStopSeq = seq;
    v.knownStopped = false;
    const promise = this._call(v, 'hsspStop').then((ok) => {
      if (v.stopInFlight?.seq === seq) v.stopInFlight = null;
      v.stopSettledAt = Date.now();
      if (!this._isLive(v)) return ok;
      if (ok) {
        // Only "known stopped" if nothing was sent after it.
        const last = seq === v.cmdSeq;
        if (last) {
          v.knownStopped = true;
          v.stopProven = !windowed;
        }
        // The latest stop answering ok clears a failed stop's error even
        // when a setup went out after it (the stop before a setup): no play
        // can be sent while that error stands, so nothing since moved it.
        const cleared = seq === v.lastStopSeq && v.errorCode === VIEWER_ERROR.STOP_FAILED;
        if (cleared) this._clearError(v, [VIEWER_ERROR.STOP_FAILED]);
        if (last || cleared) this._writeResting(v);
      } else if (seq === v.lastStopSeq) {
        v.knownStopped = false;
        console.warn(`[Audience] ${this._maskKey(v.key)} stop FAILED — the device may still be moving`);
        this._setError(v, VIEWER_ERROR.STOP_FAILED, 'Stop failed — the device may still be moving');
      }
      return ok;
    });
    v.stopInFlight = { seq, promise, windowed };
    return promise;
  }

  /** HandyManager returns booleans and never throws; a throw (a fake, a
   *  future change) counts as a failure, never as a success. */
  async _call(v, method, ...args) {
    const m = v.manager;
    if (!m || typeof m[method] !== 'function') return false;
    try {
      return (await m[method](...args)) === true;
    } catch (err) {
      console.warn(`[Audience] ${this._maskKey(v.key)} ${method} threw: ${err?.message || err}`);
      return false;
    }
  }

  async _teardownViewer(key) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    // Before the stop: no in-flight result may write status or play.
    viewer.removed = true;
    viewer.stopEpoch++;
    this._cancelPendingPlay(viewer);
    const m = viewer.manager;
    if (m) {
      try {
        if (viewer.connected && typeof m.hsspStop === 'function') {
          await this._teardownStop(viewer, m);
          // S5: a play still in flight can reach the device after that stop,
          // and so can a test buzz's move (FT-119).
          if (viewer.play.inFlight || viewer.buzzing) {
            if (viewer.play.inFlight) await viewer.play.inFlight;
            if (viewer.buzzing) await viewer.buzzing;
            await this._teardownStop(viewer, m);
          }
        }
        if (typeof m.disconnect === 'function') await m.disconnect();
      } catch { /* viewer may already be disconnected — fine */ }
      viewer.manager = null;
    }
    this._setStatus(key, VIEWER_STATUS.DISCONNECTED);
  }

  /** A teardown stop whose answer is its own. The disconnect after it leaves
   *  the SDK with no key, and a deferred request then never leaves: a stop
   *  made inside the throttle window of an earlier one (handed that one's
   *  answer, its own request 200 ms later) was lost, and the device kept
   *  playing after Remove or End room (#361 review, 2026-11-04). So any stop
   *  still out answers first, and the window after the last answer is waited
   *  out. A stop still out would have run first anyway (HandyManager runs
   *  stops one at a time). */
  async _teardownStop(v, m) {
    if (v.stopInFlight) await v.stopInFlight.promise;
    const wait = SDK_THROTTLE_GAP_MS - (Date.now() - v.stopSettledAt);
    if (wait > 0) await sleep(wait);
    const ok = await m.hsspStop();
    v.stopSettledAt = Date.now();
    return ok;
  }

  // --- Internals: status ---

  /** The label of a viewer that is stopped and idle, from the room's
   *  source and the reason it was last stopped. */
  _restingStatus(v) {
    if (v.muted) return VIEWER_STATUS.MUTED;
    const s = this._source;
    switch (s.kind) {
      case SOURCE_KIND.LOADING: return VIEWER_STATUS.WAITING;
      case SOURCE_KIND.NO_SCRIPT: return VIEWER_STATUS.NO_SCRIPT;
      case SOURCE_KIND.FAILED: return VIEWER_STATUS.SCRIPT_FAILED;
      case SOURCE_KIND.SCRIPT:
        if (v.loadedGen !== s.gen) {
          return v.setup.sending === s.gen ? VIEWER_STATUS.UPLOADING : VIEWER_STATUS.WAITING;
        }
        if (s.player !== SOURCE_PLAYER.LOCAL) return VIEWER_STATUS.REMOTE_HELD;
        if (this._rate() !== 1) return VIEWER_STATUS.SPEED;
        // A viewer held on a buffering stall (FN-06) reads as paused, as
        // its Handy is.
        return v.restReason === 'pause' || v.restReason === 'stall' ? VIEWER_STATUS.PAUSED : VIEWER_STATUS.READY;
      default:
        return VIEWER_STATUS.SYNCED;
    }
  }

  /** The label right after an unmute, until the setup or the play that
   *  follows (if any) relabels it. Mute may have written MUTED over a
   *  viewer that never connected; this puts its own status back. */
  _unmutedStatus(v) {
    if (!v.connected) return v.lastError ? VIEWER_STATUS.ERROR : VIEWER_STATUS.CONNECTING;
    if (v.errorCode) return VIEWER_STATUS.ERROR;
    if (!this._reachable(v)) return VIEWER_STATUS.DISCONNECTED;
    return this._restingStatus(v);
  }

  /** Relabel a stopped viewer. A sticky error is never overwritten here. */
  _writeResting(v) {
    if (!this._isLive(v) || v.errorCode || !this._reachable(v)) return;
    this._setStatus(v.key, this._restingStatus(v));
  }

  _setStatus(key, status, extra = {}) {
    const viewer = this._viewers.get(key);
    if (!viewer) return;
    viewer.status = status;
    if (extra.error !== undefined) viewer.lastError = extra.error;
    const rate = status === VIEWER_STATUS.SPEED ? this._rate() : null;
    // `muted` rides along because the room window mirrors it from this event
    // alone: its row and its Mute / Unmute button read it (see setMuted).
    const payload = {
      key,
      status,
      rtdMs: viewer.rtdMs,
      lastError: viewer.lastError,
      errorCode: viewer.errorCode,
      rate,
      muted: viewer.muted,
    };
    const sig = `${status}|${viewer.rtdMs}|${viewer.lastError}|${viewer.errorCode}|${rate}|${viewer.muted}`;
    if (this._lastEmitted.get(key) === sig) return;
    this._lastEmitted.set(key, sig);
    this._emit('audience:viewer-status', payload);
  }

  _setError(v, code, message) {
    v.errorCode = code;
    v.lastError = message;
    this._setStatus(v.key, VIEWER_STATUS.ERROR, { error: message });
  }

  _clearError(v, codes) {
    if (v.errorCode && codes.includes(v.errorCode)) {
      v.errorCode = null;
      v.lastError = null;
    }
  }

  _snapshot(key) {
    const v = this._viewers.get(key);
    if (!v) return null;
    return {
      key: v.key,
      label: v.label,
      offsetMs: v.offsetMs,
      status: v.status,
      rtdMs: v.rtdMs,
      lastError: v.lastError,
      errorCode: v.errorCode,
      rate: v.status === VIEWER_STATUS.SPEED ? this._rate() : null,
      muted: v.muted,
    };
  }

  _emit(event, payload) {
    if (this._bus?.emit) this._bus.emit(event, payload);
  }

  /** Normalize a key for self-collision comparison. Trims whitespace +
   *  case-folds — some scripters paste with surrounding spaces or wrong
   *  case from Discord. */
  _normalizeKey(k) {
    return String(k || '').trim().toLowerCase();
  }

  /** Mask a Handy key for logging. Keys are passwords (SCOPE §2) and logs
   *  get shared publicly when users report problems — never log a full key.
   *  Shows the last 4 chars only, enough to correlate a viewer across lines. */
  _maskKey(k) {
    const s = String(k || '');
    return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
  }

  /**
   * Summarize a fan-out Promise.allSettled result for the log. A command
   * that answered `false` counts as failed, like a rejection. Successes go
   * to console.debug (DevTools only); any failures go to console.warn
   * (forwarded to the file) so a broadcast-wide problem is always captured.
   */
  _logFanout(op, results) {
    if (!Array.isArray(results)) return;
    const failed = results.filter((r) => r.status === 'rejected' || r.value === false);
    const ok = results.length - failed.length;
    if (failed.length) {
      console.warn(`[Audience] ${op}: ${ok}/${results.length} ok, ${failed.length} failed`);
    } else {
      console.debug(`[Audience] ${op}: ${ok}/${results.length} ok`);
    }
  }

  // --- Settings roster ---

  _readRoster() {
    const raw = this._settings?.get?.(SETTING_VIEWERS);
    return Array.isArray(raw) ? raw : [];
  }

  _writeRoster(arr) {
    this._settings?.set?.(SETTING_VIEWERS, arr);
  }

  _persistRoster() {
    // Save a clean array — no live manager refs, no transient runtime
    // state. Just the rejoin-next-session essentials (S6).
    const roster = [...this._viewers.values()].map((v) => ({
      key: v.key,
      label: v.label,
      offsetMs: v.offsetMs,
    }));
    this._writeRoster(roster);
  }
}

