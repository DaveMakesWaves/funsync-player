// A fake @ohdoki/handy-sdk `Handy` instance that keeps the REAL SDK's local
// rules, so the REAL HandyManager meets the state machine it meets on a device
// rather than a bag of vi.fn()s that answer anything. Read from
// node_modules/@ohdoki/handy-sdk/dist/handy.esm.js (v2.3.4), re-checked
// 2026-11-16 (block F; first drafted 2026-11-08):
//
//   - every command first checks its OWN state: a connection key (`#p()`,
//     else "No device connected"), then the firmware (`#_()`:
//     info.fwVersion >= "3", else "Update required"), without sending
//     anything;
//   - setMode(m) clears hssp.scriptSet once it succeeds, for ANY mode;
//   - setScript switches to HSSP first, then sets scriptSet;
//   - hsspPlay throws "Script set is required" LOCALLY while scriptSet is
//     false, before any network call, and switches to HSSP (clearing the
//     flag) when the device is in another mode; hsspStop and hdsp switch
//     mode first the same way;
//   - each command name is throttled (`#f`): a call made while the previous
//     call of that name is in flight (or within `throttleMs` of it settling)
//     gets THAT call's promise back, and its own work runs `throttleMs`
//     later;
//   - connect() emits 'disconnect' first when a session is open, puts the
//     device info into the state, then emits 'connect', then resolves 1
//     (CONNECTED); API.get.info(key) stores its answer in state.info.
//
// Every network leg is appended to `calls` in order as [name, arg]. A leg
// answers on the next macrotask (a cloud round trip is never synchronous)
// unless the test queued something for it with `hold(name)` (a deferred the
// test settles) or `answer(name, valueOrError)`. `throttleMs` defaults to 0:
// on a device every leg is a cloud round trip, far longer than the SDK's
// 200 ms window, so a window shorter than a leg is the faithful ratio here.
//
// The real SDK's Handy always has getConfig() (handy.d.ts), so HandyManager
// sends every stop in HSSP mode straight to the cloud (FT-124). The fake
// mirrors that BY DEFAULT (bf-review BF-R3, 2026-11-19): getConfig() names a
// fake API base on a closed local port, and `sdk.fetch` is its cloud end. A
// test hands that to the manager with `attachFakeCloud(manager, sdk)`
// (never the real fetch); `cloud: false` is an explicit opt-out for a test
// that needs the SDK-path stop, which production takes only outside HSSP
// mode. `sdkMethodsHandyManagerCalls()` lists the real Handy methods
// HandyManager calls, so a test can check the fake has every one of them.
//
// Opt-in, for the slow-cloud tests (FT-124, 2026-11-19; all off by default,
// so every older test meets exactly the fake it was written against):
//
//   - `legMs`: every leg answers after this many ms (a timer, so fake timers
//     drive it) instead of on the next macrotask; `legMsFor(name)` per leg.
//   - `queue`: the SDK's ONE request queue (handy.esm.js `z` / `W` / `Y`):
//     every request but a play's PUT waits there and leaves one at a time,
//     in order. A leg is recorded in `calls` (and `log`, with the time) when
//     it LEAVES, not when it was asked for. With it, as the real SDK does:
//     hsspPlay's PUT goes around the queue (`skip`) and, when it answers ok,
//     a 'hsspState' read goes into the queue before the play resolves;
//     hsspStop and setScript are each followed by a 'hsspState' read too.
//   - `status`: what API.get.status(key) answers ({ mode, state }); without
//     it API.get.status does not exist and HandyManager reads nothing.
//   - `cloud` (ON by default since BF-R3, see above): getConfig() names a
//     fake API base and `sdk.fetch(url, init)` answers the request
//     HandyManager sends straight to the cloud (PUT {API}/hssp/stop,
//     FT-124) as a 'hsspStop' leg (arg 'direct') that is NOT queued: a test
//     injects it with attachFakeCloud(). A queued Error answers with the
//     cloud's `{ error: { message } }` body.
//
// No network, no key: nothing in here reaches handyfeeling.com.
import fs from 'node:fs';

/** The API base getConfig() names with `cloud` (a local, closed port). */
export const FAKE_API = 'http://127.0.0.1:9/fake-handy/api/handy/v2';

export const MODE = { HAMP: 0, HSSP: 1, HDSP: 2 };

export const FW4_INFO = Object.freeze({ fwVersion: '4.2.1+ca4dd961', model: 'H01', fwStatus: 0 });

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const macrotask = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {object} [opts]
 * @param {object|null} [opts.info] - device info connect() stores (FW4 by default)
 * @param {object} [opts.infoLater] - what API.get.info answers (defaults to `info`)
 * @param {number} [opts.throttleMs]
 * @param {number|null} [opts.legMs] - see the opt-in notes above
 * @param {(name: string) => number|undefined} [opts.legMsFor]
 * @param {boolean} [opts.queue]
 * @param {{mode: number, state?: number}} [opts.status]
 * @param {boolean} [opts.cloud] - true by default, as the real SDK; false = no getConfig (SDK-path stops)
 */
export function createFakeHandySdk({
  info = FW4_INFO, infoLater, throttleMs = 0, legMs = null, legMsFor = null, queue = false, status, cloud = true,
} = {}) {
  const listeners = {};
  const queued = {};      // name -> [{ hold } | { value } | { error }]
  const throttle = {};    // name -> { promise, timer }
  const calls = [];
  const log = [];         // { name, at } when each leg left
  let state = { connected: false, hssp: { scriptSet: false } };

  async function leg(name, arg, dflt) {
    calls.push([name, arg]);
    log.push({ name, at: Date.now() });
    const next = queued[name]?.shift();
    if (next?.hold) return next.hold.promise;
    const ms = legMsFor?.(name) ?? legMs;
    if (ms != null) await new Promise((r) => setTimeout(r, ms));
    else await macrotask();
    if (next && 'error' in next) throw next.error;
    if (next && 'value' in next) return next.value;
    return dflt;
  }

  // handy.esm.js `z`: one request at a time, in order, for every instance.
  let line = Promise.resolve();
  function net(name, arg, dflt, { skip = false } = {}) {
    if (!queue || skip) return leg(name, arg, dflt);
    const run = line.then(() => leg(name, arg, dflt));
    line = run.then(() => {}, () => {});
    return run;
  }

  // `#p()` (a connection key in the state) then `#_()` (firmware >= 3).
  function fwCheck(min = '3') {
    if (!state.connectionKey) throw new Error('No device connected');
    if (!(state.info?.fwVersion && state.info.fwVersion >= min)) throw new Error('Update required');
  }

  // handy.esm.js `#f(name, fn)`.
  function throttled(name, fn) {
    const slot = throttle[name] || (throttle[name] = {});
    clearTimeout(slot.timer);
    if (slot.promise) {
      slot.timer = setTimeout(() => { fn().catch(() => {}).finally(() => { slot.timer = undefined; }); }, throttleMs);
      return slot.promise;
    }
    const p = fn().finally(() => setTimeout(() => { slot.promise = undefined; }, throttleMs));
    slot.promise = p;
    return p;
  }

  const sdk = {
    calls,
    /** Legs in the order they LEFT, with the time each left ({ name, at }). */
    log,
    /** Queue a deferred for the next `name` leg; the test settles it. */
    hold(name) {
      const d = deferred();
      (queued[name] ||= []).push({ hold: d });
      return d;
    },
    /** Queue an answer (a value, or an Error to throw) for the next `name` leg. */
    answer(name, valueOrError) {
      (queued[name] ||= []).push(valueOrError instanceof Error ? { error: valueOrError } : { value: valueOrError });
    },
    /** Network legs of one name, in order. */
    sent(name) { return calls.filter(([n]) => n === name); },
    /** Network leg names in order, for asserting call ORDER. */
    order() { return calls.map(([n]) => n); },
    emit(event, payload) { (listeners[event] || []).forEach((cb) => cb(payload)); },

    // --- the real Handy's public surface (handy.d.ts) ---
    on(event, cb) { (listeners[event] ||= []).push(cb); },
    off(event, cb) { listeners[event] = (listeners[event] || []).filter((x) => x !== cb); },
    getState() { return state; },
    async updateState(partial) {
      for (const k of Object.keys(partial || {})) {
        const cur = state[k];
        const val = partial[k];
        state = (cur && typeof cur === 'object' && val && typeof val === 'object')
          ? { ...state, [k]: Object.assign(cur, val) }
          : { ...state, [k]: val };
      }
    },
    async connect(key) {
      if (state.connected) sdk.emit('disconnect');
      await net('connect', key);
      state = { connected: true, connectionKey: key, info, hssp: { scriptSet: false } };
      sdk.emit('connect');
      return 1;
    },
    async disconnect() {
      await net('disconnect');
      state = { connected: false, hssp: { scriptSet: false } };
      sdk.emit('disconnect');
    },
    async setMode(mode) {
      fwCheck();
      return throttled('setMode', async () => {
        const res = await net('setMode', mode, { result: 0 });
        state.mode = mode;
        if (state.hssp?.scriptSet) state.hssp = { ...state.hssp, scriptSet: false };
        return res;
      });
    },
    async setScript(url) {
      fwCheck();
      return throttled('setScript', async () => {
        if (state.mode !== MODE.HSSP) await sdk.setMode(MODE.HSSP);
        const res = await net('setScript', url, { result: 1 });
        if (queue) await net('hsspState', undefined, { state: 3 });
        state.hssp = { ...state.hssp, scriptSet: true };
        return res;
      });
    },
    async hsspPlay(startTime = 0, est = 0) {
      fwCheck();
      if (!state.hssp?.scriptSet) throw new Error('Script set is required');
      const mode = state.mode;
      return throttled('hsspPlay', async () => {
        if (mode !== MODE.HSSP) await sdk.setMode(MODE.HSSP);
        const res = await net('hsspPlay', startTime, { result: 0 }, { skip: true });
        if (queue && res?.result === 0) await net('hsspState', undefined, { state: 4 });
        return res;
      });
    },
    async hsspStop() {
      fwCheck();
      return throttled('hsspStop', async () => {
        if (state.mode !== MODE.HSSP) await sdk.setMode(MODE.HSSP);
        const res = await net('hsspStop', undefined, { result: 0 });
        if (queue && res?.result === 0) await net('hsspState', undefined, { state: 3 });
        return res;
      });
    },
    async hdsp(position, duration) {
      fwCheck();
      return throttled('hdsp', async () => {
        if (position < 0 || position > 100) throw new Error('Position should be in range between 0 and 100');
        if (state.mode !== MODE.HDSP) await sdk.setMode(MODE.HDSP);
        return net('hdsp', position, { result: 0 });
      });
    },
    async sync() {},
    getClientServerLatency() { return { avgOffset: 0, avgRtd: 0, lastSyncTime: 0 }; },
    async setOffset(ms) { return net('setOffset', ms, { result: 0 }); },
    async getOffset() { return { offset: 0 }; },
    async setStrokeZone(slide) { return net('setStrokeZone', slide, { result: 0 }); },
    async getStrokeZone() { return { min: 0, max: 100 }; },
    async setHsspLoop() { throw new Error('Request failed with status code 404'); },
    async setHampVelocity(v) { return net('setHampVelocity', v, { result: 0 }); },
    async hampPlay() { return net('hampPlay', undefined, { result: 0 }); },
    async hampStop() { return net('hampStop', undefined, { result: 0 }); },
    API: {
      get: {
        connected: async (key) => net('API.get.connected', key, { connected: true }),
        info: async (key) => {
          const res = await net('API.get.info', key, infoLater ?? info);
          if (res) state = { ...state, info: res };
          return res;
        },
        // Opt-in (see above). noStateUpdate is what HandyManager passes; the
        // fake never writes the status into its state either way.
        ...(status !== undefined ? { status: async (key) => net('API.get.status', key, status) } : {}),
      },
    },
  };
  if (cloud) {
    sdk.getConfig = () => ({ API: FAKE_API, throttleDelay: throttleMs });
    // The cloud end of a request sent around the SDK (FT-124): only the
    // HSSP stop, the one request HandyManager sends that way.
    sdk.fetch = async (url, init = {}) => {
      if (url !== `${FAKE_API}/hssp/stop` || init.method !== 'PUT') {
        throw new Error(`fake cloud: unexpected request ${init.method || 'GET'} ${url}`);
      }
      if (!init.headers?.['X-Connection-Key']) throw new Error('fake cloud: no connection key');
      let body;
      try {
        body = await leg('hsspStop', 'direct', { result: 0 });
      } catch (err) {
        body = { error: { message: err?.message || String(err), code: err?.code ?? 2000, connected: true } };
      }
      return { ok: true, status: 200, json: async () => body };
    };
  }
  return sdk;
}

/**
 * The method names the REAL SDK's Handy class declares (handy.d.ts), read
 * from node_modules, so a test can check its fake has nothing the real one
 * lacks: a fake method the real class does not have hides bugs.
 */
export function realHandyMethodNames() {
  const dts = fs.readFileSync('node_modules/@ohdoki/handy-sdk/dist/handy.d.ts', 'utf8');
  const body = dts.slice(dts.indexOf('export declare class Handy'), dts.indexOf('export declare function init'));
  return new Set([...body.matchAll(/^\s{4}([A-Za-z]\w*)(?:<[^>]*>)?\(/gm)].map((m) => m[1]));
}

/**
 * Hand the fake cloud to a HandyManager, so its direct stop (FT-124) reaches
 * this fake instead of the real fetch. A no-op for a `cloud: false` fake.
 * @returns the manager
 */
export function attachFakeCloud(manager, sdk) {
  if (typeof sdk?.fetch === 'function') manager._fetchImpl = sdk.fetch;
  return manager;
}

/**
 * The real Handy methods HandyManager calls (`this._handy.x`, `sdk.x`),
 * read from its source: every one must exist on the default fake, or a test
 * runs a branch production never takes (BF-R3: no getConfig, so no direct
 * stop).
 */
export function sdkMethodsHandyManagerCalls() {
  const src = fs.readFileSync('renderer/js/handy-manager.js', 'utf8');
  const real = realHandyMethodNames();
  const used = new Set([...src.matchAll(/(?:this\._handy|\bsdk)\??\.([A-Za-z]\w*)/g)].map((m) => m[1]));
  return [...used].filter((n) => real.has(n)).sort();
}

/** Fake-only helpers, not part of the SDK surface (`API` is a real property). */
export const FAKE_ONLY = new Set(['calls', 'log', 'hold', 'answer', 'sent', 'order', 'emit', 'API', 'fetch']);
