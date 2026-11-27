// DeviceGate — who may send commands to the devices (v0.10.1, the script player).
//
// While the script player plays, it owns the devices: the open video keeps
// playing (and its engines keep running), but nothing they send may reach a
// device, or the video's script would fight the script player's. There are
// about 130 places in app.js that start, stop, upload to or re-bind the
// devices for the video; guarding each one would be a bug farm. The gate sits
// at the four device managers instead:
//
// - installDeviceGate(gate, kind, manager) wraps the manager's COMMAND methods
//   (GATED_METHODS) on that instance. While the gate is closed, a call whose
//   `this` does not carry the owner gets a harmless "done" (blockedResult) and
//   reaches nothing. Settings (offset, stroke zone), connection, health checks
//   and plain cloud uploads are not gated.
// - ownerFacade(manager, owner) is the manager as the owner calls it: a Proxy
//   whose `this` carries the owner through every await and every internal
//   call the method makes, while all state stays on the one real manager.
//
// The script player builds its own sync engines on facades; the app's engines
// keep the real managers. Opening the gate gives the devices back.

/** The `this` property a facade answers with its owner. */
export const GATE_OWNER = Symbol('deviceGateOwner');

/** The command methods, per manager. Nothing else is gated. */
export const GATED_METHODS = Object.freeze({
  handy: ['setupScript', 'uploadAndSetScript', 'stageScript', 'hsspPlay', 'hsspStop',
    'setLoop', 'hampStart', 'hampStop', 'setHampVelocity', 'enterHdsp', 'hdspMove'],
  buttplug: ['sendVibrate', 'sendLinear', 'sendRotate', 'sendOscillate', 'testOscillate',
    'sendHeat', 'sendSpray', 'sendScalar', 'stopDevice', 'stopAll', 'stopSustainedOutputs'],
  tcode: ['send', 'sendAxes', 'stop'],
  autoblow: ['uploadScript', 'syncStart', 'syncStop', 'syncOffset'],
});

/**
 * What a blocked call answers: "done", in the shape its callers expect, so
 * the video's code carries on as if the device had it (an upload that
 * "failed" would toast and stop its autoplay). Pure.
 * @param {string} kind
 * @param {string} name
 */
export function blockedResult(kind, name) {
  if (kind === 'handy') {
    if (name === 'stageScript') return null;          // nothing staged: no URL to remember
    if (['setupScript', 'uploadAndSetScript', 'hsspPlay', 'hsspStop', 'enterHdsp'].includes(name)) return true;
    return undefined;
  }
  if (kind === 'tcode' && name === 'stop') return [];  // the axes it centred: none
  if (kind === 'autoblow' && name === 'uploadScript') return true;
  return undefined;
}

export class DeviceGate {
  constructor() {
    this._owner = null;
    /** Calls blocked since the gate last closed (for the log and the tests). */
    this.blocked = 0;
  }

  get closed() { return this._owner !== null; }
  get owner() { return this._owner; }

  /** Only `owner`'s facades reach the devices from now on. */
  close(owner) {
    this._owner = owner;
    this.blocked = 0;
  }

  /** Everyone again. */
  open() {
    this._owner = null;
  }

  /** @param {unknown} caller the GATE_OWNER of the call's `this` */
  allows(caller) {
    return this._owner === null || caller === this._owner;
  }
}

/**
 * Wrap a manager's command methods on that instance (once).
 * @param {DeviceGate} gate
 * @param {'handy'|'buttplug'|'tcode'|'autoblow'} kind
 * @param {object|null|undefined} manager
 */
export function installDeviceGate(gate, kind, manager) {
  if (!manager || manager.__deviceGate) return;
  for (const name of GATED_METHODS[kind] || []) {
    const orig = manager[name];
    if (typeof orig !== 'function') continue;
    const isAsync = orig.constructor?.name === 'AsyncFunction';
    manager[name] = function gatedDeviceCommand(...args) {
      if (!gate.allows(this?.[GATE_OWNER])) {
        gate.blocked++;
        const v = blockedResult(kind, name);
        return isAsync ? Promise.resolve(v) : v;
      }
      return orig.apply(this, args);
    };
  }
  Object.defineProperty(manager, '__deviceGate', { value: gate, enumerable: false });
}

/**
 * The manager as `owner` calls it. Reads, calls and writes all reach the one
 * real manager; only `this[GATE_OWNER]` differs.
 * @template T
 * @param {T} manager
 * @param {string} owner
 * @returns {T}
 */
export function ownerFacade(manager, owner) {
  if (!manager) return manager;
  return new Proxy(manager, {
    get(target, prop, receiver) {
      if (prop === GATE_OWNER) return owner;
      return Reflect.get(target, prop, receiver);
    },
  });
}
