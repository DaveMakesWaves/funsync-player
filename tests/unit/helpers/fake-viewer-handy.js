// A fake HandyManager for AudienceBridge tests that mirrors the REAL contract
// (renderer/js/handy-manager.js), not a convenient one. The fake that used to
// live in audience-bridge.test.js threw on failure; the real class never
// throws, so the suite tested a path production never takes
// (feedback_injected_fake_must_mirror_handymanager_contract).
//
// What is mirrored:
//   - `new Ctor()` takes no arguments; `init()` must run before `connect(key)`
//     does anything (connect answers false otherwise).
//   - Every command answers a boolean and NEVER throws. Not connected: a stop
//     answers true and does nothing, a play or a setup answers false.
//   - hsspStop / hsspPlay / setupScript run one at a time per instance, in
//     order (HandyManager._hsspExclusive): a stop pre-empts an in-flight play
//     and goes ahead of anything queued (FT-124), waiting only for a setup
//     that is running, and a queued play superseded by a later command is
//     dropped (false).
//   - FT-124: while the SDK is in HSSP mode a stop goes straight to the
//     cloud (HandyManager._directHsspStop), with no SDK throttle and no mode
//     switch; `opts.sdkStops` sends every stop through the SDK as before.
//   - Deadlines: 5 s for play and stop (a stop is retried once, 250 ms
//     later), 15 s for a setup. A command past its deadline answers false
//     while the command itself still lands on the device later: a late
//     command is not a failed one.
//   - Under all that, the SDK's per-instance throttle (`#f`, 200 ms): a call
//     of the same method while the previous call's promise is registered (in
//     flight, or settled under 200 ms ago) gets the PREVIOUS call's promise
//     back, and its own request is sent 200 ms later with nobody watching.
//     That deferred request is a renderer timer running the SDK's call
//     against the instance's state THEN: after a disconnect the SDK has no
//     key (`setMode` -> "No device connected"), so it never leaves; and once
//     the renderer is gone (`world.rendererGone`, the app quit) nothing the
//     renderer would still send leaves either. Both land in `world.dropped`.
//   - HDSP (FT-119): hdspMove answers nothing and never throws, sends nothing
//     unconnected or while the firmware is unknown (deviceInfo null), scales
//     to the firmware with the REAL hdspPositionScale (0-1 on FW4), switches
//     the mode itself the first time (HandyManager's `_mode` cache), and is
//     NOT in the HSSP chain. Under it, the SDK: a call of the other family
//     switches the mode first (`setMode`, a 'mode' request, throttled like any
//     method), and a mode switch that answers clears the SDK's script setup
//     (`hssp.scriptSet`). A play with no script set is refused before
//     anything is sent ("Script set is required"); a viewer's HandyManager
//     has no cached URL to heal that from (setupScript never sets
//     `_lastCloudUrl`), so it answers false. The real hdsp() is the SDK's,
//     not HandyManager's: the old fake's `withHdsp` option gave it one, and
//     Test buzz passed here while it sent nothing in production.
//   - The device refuses a play while it holds no script (a mode switch, or
//     `powerCycle`): it answers false and never lands.
//   - `_handleDeviceLost()` is the real class's health-check verdict
//     (connected false, deviceInfo null), for a test to call.
//
// Each command lands on a per-key "device" at its own moment, and every
// landing goes on a shared timeline, so a test asserts what a viewer's Handy
// actually did, in order, instead of which methods were called.

import { hdspPositionScale } from '../../../renderer/js/handy-manager.js';

export const PLAY_DEADLINE_MS = 5000;
export const SETUP_DEADLINE_MS = 15000;
export const SDK_THROTTLE_MS = 200;
/** What a fake device reports at connect unless `opts.fwVersion` says. */
export const DEFAULT_FW = '4.2.1+ca4dd961';

export function makeWorld() {
  return {
    devices: new Map(),   // key -> { url, playing, playUrl, playTimeMs }
    timeline: [],         // { at, key, kind, url?, timeMs?, deferred? }
    sent: [],             // { at, key, kind, url?, timeMs? } — requests issued to the "cloud"
    replies: [],          // { at, key, kind, ok, deferred } — when each request answered
    dropped: [],          // { at, key, kind, why } — requests that never left
    rendererGone: false,  // set by a test: the app quit, nothing more is sent
    violations: [],       // filled by checks a test installs
    onSent: null,         // (fake, entry) => void
    onLanded: null,       // (fake, entry) => void
    managers: [],
  };
}

export function deviceOf(world, key) {
  if (!world.devices.has(key)) {
    world.devices.set(key, { url: null, playing: false, playUrl: null, playTimeMs: null, mode: 'hssp', position: null });
  }
  return world.devices.get(key);
}

/** The viewer's Handy was switched off and on: it forgot its script and
 *  stopped. HandyManager and the SDK know nothing of it. */
export function powerCycle(world, key) {
  Object.assign(deviceOf(world, key), { url: null, playing: false, mode: 'hssp', position: null });
  world.timeline.push({ at: Date.now(), key, kind: 'power-cycle' });
}

/** Commands that reached `key`'s device, in order (kinds only by default). */
export function landed(world, key, { full = false } = {}) {
  const rows = world.timeline.filter((e) => e.key === key);
  return full ? rows : rows.map((e) => e.kind);
}

function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
    promise.then((v) => { if (!done) { done = true; clearTimeout(timer); resolve({ value: v }); } });
  });
}

/**
 * @param {object} world
 * @param {object} [opts]
 * @param {boolean} [opts.failConnect]
 * @param {number} [opts.latency] — default ms for a command to land + answer
 * @param {(kind, args, fake) => ({replyMs?, landMs?, ok?})|void} [opts.behave]
 *   per-command override. `ok: false` = the cloud refused it (never lands);
 *   `landMs` > `replyMs` = it answers first and lands later.
 * @param {boolean} [opts.sdkStops] — every stop through the SDK and its
 *   throttle, as before FT-124 (default: straight to the cloud while the
 *   SDK is in HSSP mode, as HandyManager sends it)
 * @param {string|null} [opts.fwVersion] — what the device reports at connect
 *   (default DEFAULT_FW); null = unknown, so hdspMove sends nothing.
 *   `failConnect` and `fwVersion` are read at each call, so a test can
 *   change them on the opts object it passed.
 */
export function makeFakeHandyCtor(world, opts = {}) {
  return class FakeHandyManager {
    constructor(...args) {
      if (args.length) throw new Error('HandyManager takes no constructor arguments');
      this.calls = [];
      this._handy = null;
      this._connected = false;
      this._deviceInfo = null;
      this.connectionKey = '';
      this._chain = Promise.resolve();
      this._gen = 0;
      this._playInFlight = 0;
      this._active = null;          // the play / setup running in the chain
      this._stopsPending = 0;       // stops asked for and not finished
      this._stopTail = Promise.resolve();
      this._thr = {};
      this.throttled = [];
      // HandyManager's mode cache (null until a mode is set, as in the real
      // constructor), and the SDK's own state (`#t`): its mode, and whether a
      // setup answered since the last mode switch (`hssp.scriptSet`).
      this._mode = null;
      this._sdkMode = 1;
      this._scriptSet = false;
      this.refusedPlays = 0;   // plays the SDK refused client-side
      world.managers.push(this);
    }

    get connected() { return this._connected; }

    get deviceInfo() { return this._deviceInfo; }

    async init() {
      this.calls.push({ kind: 'init' });
      this._handy = {};
    }

    async connect(key) {
      this.calls.push({ kind: 'connect', key });
      if (!this._handy) return false;
      if (opts.connectMs) await new Promise((r) => setTimeout(r, opts.connectMs));
      if (opts.failConnect) return false;
      this.connectionKey = key;
      this._connected = true;
      const fw = opts.fwVersion === undefined ? DEFAULT_FW : opts.fwVersion;
      this._deviceInfo = fw ? { fwVersion: fw } : null;
      return true;
    }

    async disconnect() {
      this.calls.push({ kind: 'disconnect' });
      this._connected = false;
      this._deviceInfo = null;
    }

    // HandyManager._handleDeviceLost: the health check's verdict.
    _handleDeviceLost() {
      this._connected = false;
      this._deviceInfo = null;
    }

    // HandyManager.hdspMove: no answer, never throws, not in the HSSP chain.
    // Since the fix-up after block F verify-1 the real one sends one SDK call
    // at a time, never inside the SDK's window of the last one, with the
    // newest position (a move asked for meanwhile replaces the waiting one),
    // and drops a move that hdspHalt() or any HSSP request overtook; so does
    // this one. The promise settles once the sends it joined are done.
    hdspMove(position, durationMs = 150) {
      this.calls.push({ kind: 'hdspMove', position, durationMs });
      if (!this._handy || !this._connected) return Promise.resolve();
      const scale = hdspPositionScale(this._deviceInfo);
      if (scale === null) return Promise.resolve();
      const pos = Math.max(0, Math.min(100, Number(position) || 0));
      this._hdspWanted = { pos, scale, durationMs, epoch: this._hdspEpoch || 0 };
      if (!this._hdspPumping) {
        this._hdspPumping = true;
        this._hdspPump = this._runHdspPump();
      }
      return this._hdspPump;
    }

    // HandyManager.hdspHalt.
    hdspHalt() {
      this._hdspEpoch = (this._hdspEpoch || 0) + 1;
      this._hdspWanted = null;
    }

    async _runHdspPump() {
      try {
        while (this._hdspWanted) {
          const at = this._hdspSettledAt;
          const wait = at == null ? 0 : at + SDK_THROTTLE_MS + 20 - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          const w = this._hdspWanted;
          this._hdspWanted = null;
          if (!w || w.epoch !== (this._hdspEpoch || 0) || !this._connected) continue;
          try {
            if (this._mode !== 2) {
              await this._sdkSetMode(2);
              this._hdspModeSettledAt = Date.now();
              this._mode = 2;
              if (w.epoch !== (this._hdspEpoch || 0)) continue;
            }
            // The SDK's hdsp(): its own mode check, then the request.
            if (this._sdkMode !== 2) await this._sdkSetMode(2);
            try {
              await this._throttled('hdsp', { position: w.pos, xpt: w.pos * w.scale, durationMs: w.durationMs });
            } finally {
              this._hdspSettledAt = Date.now();
            }
          } catch {
            this._mode = null;
          }
        }
      } finally {
        this._hdspPumping = false;
      }
    }

    // HandyManager._hdspQuiet: a play / setup waits out the SDK's setMode
    // window after an HDSP switch of ours (one window, no travelling switch
    // modelled: the fake's switch is awaited inside the pump).
    async _hdspQuiet() {
      const at = this._hdspModeSettledAt;
      const wait = at == null ? 0 : at + SDK_THROTTLE_MS + 20 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    // The SDK's setMode: one 'mode' request through the throttle; the SDK
    // state changes when that request answers (see _send).
    _sdkSetMode(mode) {
      return this._throttled('mode', { mode });
    }

    // The SDK's HSSP calls switch to HSSP first when the SDK is elsewhere.
    async _toHssp() {
      if (this._sdkMode !== 1) await this._sdkSetMode(1);
    }

    async setOffset(ms) {
      this.calls.push({ kind: 'setOffset', ms });
    }

    async syncTime() {
      this.calls.push({ kind: 'syncTime' });
      if (!this._connected) return null;
      world.timeline.push({ at: Date.now(), key: this.connectionKey, kind: 'sync' });
      return { avgRtd: opts.rtdMs ?? 50, avgOffset: 0, lastSyncTime: Date.now() };
    }

    setupScript(url) {
      this.calls.push({ kind: 'setupScript', url });
      return this._exclusive('setup', async () => {
        if (!this._connected) return false;
        await this._hdspQuiet();
        const r = await withDeadline(
          this._toHssp().then(() => this._throttled('setup', { url })),
          SETUP_DEADLINE_MS,
        );
        if (!r.timedOut && r.value) this._mode = 1;
        return r.timedOut ? false : r.value;
      }, false);
    }

    hsspPlay(timeMs = 0) {
      this.calls.push({ kind: 'hsspPlay', timeMs });
      return this._exclusive('play', async () => {
        if (!this._connected) return false;
        // The SDK: "Script set is required", thrown before anything is sent;
        // HandyManager has no cached URL for a viewer, so it answers false.
        if (!this._scriptSet) {
          this.refusedPlays++;
          this._mode = null;
          return false;
        }
        // HandyManager._hsspPlayImpl: an HDSP switch's window is waited out
        // after the stop snapshot; a stop asked for meanwhile wins.
        const stopEpoch = this._stopEpoch || 0;
        await this._hdspQuiet();
        if (stopEpoch !== (this._stopEpoch || 0)) return false;
        const r = await withDeadline(
          this._toHssp().then(() => this._throttled('play', { timeMs })),
          PLAY_DEADLINE_MS,
        );
        return r.timedOut ? false : r.value;
      }, false);
    }

    hsspStop() {
      this.calls.push({ kind: 'hsspStop' });
      return this._exclusive('stop', async () => {
        if (!this._connected) return true;
        for (let attempt = 1; attempt <= 2; attempt++) {
          // HandyManager._directHsspStop (FT-124, 2026-11-19): while the SDK
          // is in HSSP mode the stop goes straight to the cloud, so there is
          // no SDK throttle and no mode switch. Elsewhere (after a Test
          // buzz's HDSP), or with `opts.sdkStops` (every stop as it went
          // before FT-124), through the SDK as before.
          const send = this._sdkMode === 1 && !opts.sdkStops
            ? this._send('stop', {})
            : this._toHssp().then(() => this._throttled('stop', {}));
          const r = await withDeadline(send, PLAY_DEADLINE_MS);
          if (!r.timedOut && r.value) return true;
          if (attempt === 1) await new Promise((res) => setTimeout(res, 250));
        }
        return false;
      }, true);
    }

    // HandyManager._hsspExclusive, line for line where it matters. Since
    // FT-124 (2026-11-19) a stop goes ahead of everything QUEUED and never
    // waits for a play, and since 2026-11-20 (Dave: "stop it at once") not
    // for a running setup either: it waits only for an earlier stop;
    // anything queued lets a stop asked for meanwhile go first, and a play
    // queued before it is dropped.
    _exclusive(kind, fn, skipValue) {
      const gen = ++this._gen;
      this.hdspHalt();   // no HDSP move asked for before this goes after it
      if (kind === 'stop') {
        this._stopEpoch = (this._stopEpoch || 0) + 1;
        const active = this._active;
        this._stopsPending = (this._stopsPending || 0) + 1;
        const tail = this._stopTail || Promise.resolve();
        void active;   // a running setup is not waited for (2026-11-20)
        const wait = tail;
        const run = wait.then(async () => {
          try {
            return await fn();
          } finally {
            this._stopsPending--;
          }
        });
        this._stopTail = run.then(() => {}, () => {});
        return run;
      }
      const run = this._chain.then(async () => {
        while (this._stopsPending > 0) await this._stopTail;
        if (kind === 'play' && gen !== this._gen) return skipValue;
        let release;
        const entry = { kind, done: new Promise((r) => { release = r; }) };
        this._active = entry;
        if (kind === 'play') this._playInFlight++;
        try {
          return await fn();
        } finally {
          if (kind === 'play') this._playInFlight--;
          if (this._active === entry) this._active = null;
          release();
        }
      });
      this._chain = run.then(() => {}, () => {});
      return run;
    }

    // The SDK's `#f` throttle, per method.
    _throttled(kind, args) {
      const slot = this._thr[kind] || (this._thr[kind] = {});
      clearTimeout(slot.timer);
      if (slot.promise) {
        this.throttled.push(kind);
        slot.timer = setTimeout(() => {
          slot.timer = undefined;
          if (!this._connected) {
            world.dropped.push({ at: Date.now(), key: this.connectionKey, kind, why: 'disconnected' });
            return;
          }
          this._send(kind, args, { deferred: true });
        }, SDK_THROTTLE_MS);
        return slot.promise;
      }
      const r = this._send(kind, args).finally(() => setTimeout(() => { slot.promise = undefined; }, SDK_THROTTLE_MS));
      slot.promise = r;
      return r;
    }

    // One request to the cloud: lands on the device at `landMs`, answers at
    // `replyMs`.
    _send(kind, args, { deferred = false } = {}) {
      const key = this.connectionKey;
      if (world.rendererGone) {
        world.dropped.push({ at: Date.now(), key, kind, why: 'renderer-gone' });
        return new Promise(() => {});
      }
      const lat = opts.latency ?? 20;
      const b = { replyMs: lat, landMs: lat, ok: true, ...(opts.behave?.(kind, args, this) || {}) };
      // The device plays nothing it holds no script for.
      if (kind === 'play' && deviceOf(world, key).url == null) b.ok = false;
      const entry = { at: Date.now(), key, kind, ...args, deferred };
      world.sent.push(entry);
      world.onSent?.(this, entry);
      return new Promise((resolve) => {
        if (b.ok !== false) setTimeout(() => this._land(kind, args, deferred), b.landMs);
        setTimeout(() => {
          const ok = b.ok !== false;
          world.replies.push({ at: Date.now(), key, kind, ok, deferred });
          // The SDK's state, as the call that really ran updates it.
          if (ok && kind === 'mode') {
            this._sdkMode = args.mode;
            this._scriptSet = false;
          }
          if (ok && kind === 'setup') this._scriptSet = true;
          resolve(ok);
        }, b.replyMs);
      });
    }

    _land(kind, args, deferred) {
      const key = this.connectionKey;
      const dev = deviceOf(world, key);
      const entry = { at: Date.now(), key, kind, deferred };
      if (kind === 'setup') {
        entry.url = args.url;
        entry.whileMoving = dev.playing;
        dev.url = args.url;
      } else if (kind === 'play') {
        entry.url = dev.url;
        entry.timeMs = args.timeMs;
        dev.playing = true;
        dev.playUrl = dev.url;
        dev.playTimeMs = args.timeMs;
      } else if (kind === 'stop') {
        dev.playing = false;
      } else if (kind === 'mode') {
        // A mode switch ends HSSP playback and the device's script setup.
        entry.mode = args.mode;
        dev.mode = args.mode === 2 ? 'hdsp' : 'hssp';
        dev.playing = false;
        dev.url = null;
      } else if (kind === 'hdsp') {
        Object.assign(entry, { position: args.position, xpt: args.xpt, durationMs: args.durationMs });
        dev.position = args.xpt;
      }
      world.timeline.push(entry);
      world.onLanded?.(this, entry);
    }
  };
}

/** A raw funscript whose content identifies it (`label`), with n actions. */
export function scriptContent(label, { n = 6, positions = null } = {}) {
  const actions = [];
  for (let i = 0; i < n; i++) {
    actions.push({ at: i * 500, pos: positions ? positions[i % positions.length] : (i % 2 ? 90 : 10) });
  }
  return JSON.stringify({ version: '1.0', _label: label, actions });
}

export const urlFor = (label) => `https://scripts.example/${label}.csv`;

/** A keyless uploader standing in for uploadScriptToCloud. Never touches
 *  the network. `latencyFor(label)` / `failFor(label, attempt)` script it. */
export function makeUploader({ latencyFor = () => 30, failFor = () => false } = {}) {
  const uploads = [];
  const attempts = new Map();
  const upload = async (content) => {
    const label = JSON.parse(content)._label;
    const n = (attempts.get(label) || 0) + 1;
    attempts.set(label, n);
    uploads.push({ label, content });
    await new Promise((r) => setTimeout(r, latencyFor(label, n)));
    if (failFor(label, n)) return null;
    return urlFor(label);
  };
  return { upload, uploads };
}
