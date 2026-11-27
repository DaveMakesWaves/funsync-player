// ScriptPlayer — play a script on the devices with no video, and keep it
// playing while other videos are watched (v0.10.1; powerkool on EroScripts:
// "the ability to view ... and play ... scripts that aren't associated with a
// video" and "a toggle to keep a script playing while allowing one to view
// other videos without utilizing the normally associated script(s)").
//
// It owns, for as long as it plays:
// - its own FunscriptEngine (the open video keeps the app's, so the video's
//   heatmap, timeline and editor stay the video's),
// - its own clock (ScriptClock, a stand-in <video>),
// - its own sync engines, built on ownerFacade()s of the real managers,
// - the devices: the DeviceGate is closed for everyone else, so the video's
//   engines run on but reach nothing (device-gate.js).
//
// start() takes the devices over (beforeTakeover lets the video's engines
// send their stops first), stop() gives them back (afterHandback puts the open
// video's script back on them). Desktop only (Dave, 2026-11-21).

import { ScriptClock } from './script-clock.js';
import { ownerFacade } from './device-gate.js';

export const SCRIPT_PLAYER_OWNER = 'script-player';

/**
 * Whether `content` is a funscript the player can play, without touching
 * anything (start() checks before it takes the devices). Pure.
 * @param {unknown} content
 * @returns {boolean}
 */
export function isPlayableFunscript(content) {
  if (typeof content !== 'string' || !content.trim()) return false;
  try {
    const data = JSON.parse(content.replace(/^﻿/, ''));
    return Array.isArray(data?.actions) && data.actions.length > 0;
  } catch {
    return false;
  }
}

export class ScriptPlayer {
  /**
   * @param {object} deps
   * @param {import('./device-gate.js').DeviceGate} deps.gate
   * @param {{ handy?: object, buttplug?: object, tcode?: object, autoblow?: object }} deps.managers the REAL managers
   * @param {(o: { player: object, funscriptEngine: object, managers: object }) => { handy?: object, buttplug?: object, tcode?: object, autoblow?: object }} deps.createEngines
   *   sync engines on `player` and `funscriptEngine`, talking to `managers` (the facades)
   * @param {() => object} deps.createFunscriptEngine
   * @param {ScriptClock} [deps.clock]
   * @param {object} [deps.hooks]
   * @param {() => (void|Promise<void>)} [deps.hooks.beforeTakeover] the video's engines send their stops
   * @param {() => (void|Promise<void>)} [deps.hooks.afterHandback] the open video back on the devices
   * @param {(engines: object) => void} [deps.hooks.configureEngines] settings (smoothing, speed limit, offsets)
   * @param {(content: string, o: { durationMs: number }) => string} [deps.hooks.handyContent]
   * @param {(content: string, o: { durationMs: number }) => string} [deps.hooks.autoblowContent]
   * @param {(state: object) => void} [deps.hooks.onChange]
   */
  constructor({ gate, managers = {}, createEngines, createFunscriptEngine, clock = null, hooks = {} }) {
    this.gate = gate;
    this.managers = managers;
    this.hooks = hooks;
    this.clock = clock || new ScriptClock();
    this.player = this.clock.asVideoPlayerWrapper();
    this.engine = createFunscriptEngine();
    this.facades = {
      handy: ownerFacade(managers.handy, SCRIPT_PLAYER_OWNER),
      buttplug: ownerFacade(managers.buttplug, SCRIPT_PLAYER_OWNER),
      tcode: ownerFacade(managers.tcode, SCRIPT_PLAYER_OWNER),
      autoblow: ownerFacade(managers.autoblow, SCRIPT_PLAYER_OWNER),
    };
    this.engines = createEngines({ player: this.player, funscriptEngine: this.engine, managers: this.facades }) || {};
    this._active = false;
    this._name = null;
    this._path = null;
    this._loop = false;          // Dave: "loop off by default"
    this._gen = 0;
    this._devices = [];
    for (const type of ['playing', 'pause', 'seeked', 'ended']) {
      this.clock.addEventListener(type, () => this._emit());
    }
  }

  get active() { return this._active; }

  /** What the bar and the player's pill show. */
  get state() {
    return {
      active: this._active,
      name: this._name,
      path: this._path,
      duration: this.clock.duration,
      time: this.clock.currentTime,
      paused: this.clock.paused,
      ended: this.clock.ended,
      loop: this._loop,
      devices: [...this._devices],
    };
  }

  /** The script's position now (0-100), for the device simulator; null when not playing a script. */
  get livePosition() {
    if (!this._active || !this.engine?.isLoaded) return null;
    return this.engine.getPositionAt(this.clock.currentTime * 1000);
  }

  /**
   * Play `content` on the devices from the start. Called again while playing,
   * it switches scripts without handing the devices back in between.
   * @param {{ name: string, path?: string|null, content: string }} script
   * @returns {Promise<boolean>} false when the file is not a funscript, or a newer start() took over
   */
  async start({ name, path = null, content }) {
    if (!isPlayableFunscript(content)) return false;
    const gen = ++this._gen;
    if (this._active) {
      this.clock.pause();
      this._stopEngines();
    } else {
      await this.hooks.beforeTakeover?.();
      if (gen !== this._gen) return false;
      this.gate.close(SCRIPT_PLAYER_OWNER);
    }
    this.clock.reset();
    this._active = true;
    this._name = name;
    this._path = path;
    this._devices = [];
    this._emit();

    await this.engine.loadContent(content, name);
    if (gen !== this._gen) return false;
    const durationMs = this.engine.getInfo?.()?.durationMs
      || (this.engine.getActions?.() || []).at(-1)?.at || 0;
    this.clock.duration = durationMs / 1000;
    this.clock.loop = this._loop;
    this.hooks.configureEngines?.(this.engines);

    const m = this.managers;
    const e = this.engines;
    if (m.buttplug?.connected && e.buttplug) {
      e.buttplug.reloadActions?.();
      e.buttplug.start();
      // Intiface can be connected with no toy in it: that drives nothing yet
      // (a toy added later is driven, the engine is running).
      if ((m.buttplug.devices?.length || 0) > 0) this._devices.push('buttplug');
    }
    if (m.tcode?.connected && e.tcode) {
      e.tcode.reloadActions?.();
      e.tcode.start();
      this._devices.push('tcode');
    }
    if (m.handy?.connected && e.handy) {
      const upload = this.hooks.handyContent ? this.hooks.handyContent(content, { durationMs }) : content;
      const ok = await this.facades.handy.uploadAndSetScript(upload);
      if (gen !== this._gen) return false;
      if (ok) {
        e.handy._scriptReady = true;
        e.handy.start();
        this._devices.push('handy');
      }
    }
    if (m.autoblow?.connected && e.autoblow) {
      const upload = this.hooks.autoblowContent ? this.hooks.autoblowContent(content, { durationMs }) : content;
      const ok = await e.autoblow.uploadScript(upload);
      if (gen !== this._gen) return false;
      if (ok !== false) {
        e.autoblow.start();
        this._devices.push('autoblow');
      }
    }
    await this.clock.play();
    this._emit();
    return true;
  }

  play() { if (this._active) return this.clock.play(); return Promise.resolve(); }
  pause() { if (this._active) this.clock.pause(); }
  toggle() { return this.clock.paused ? this.play() : this.pause(); }

  /** @param {number} seconds */
  seek(seconds) {
    if (this._active) this.clock.seek(seconds);
  }

  /** @param {boolean} on */
  setLoop(on) {
    this._loop = on === true;
    this.clock.loop = this._loop;
    this._emit();
  }

  /**
   * Stop the script and give the devices back: its engines send their stops
   * (through the facades), the gate opens, then afterHandback puts the open
   * video back on the devices.
   * @param {{ handBack?: boolean }} [opts]
   */
  async stop({ handBack = true } = {}) {
    if (!this._active) return;
    this._gen++;
    this.clock.pause();
    this._stopEngines();
    this._active = false;
    this._devices = [];
    this.gate.open();
    this._emit();
    if (handBack) await this.hooks.afterHandback?.();
  }

  /**
   * The page is going away: stop the engines and open the gate at once, so
   * the app's own exit stops reach the devices. No hand-back.
   */
  stopForExit() {
    if (!this._active) return;
    this._gen++;
    try { this.clock.pause(); this._stopEngines(); } catch { /* the page is going */ }
    this._active = false;
    this.gate.open();
  }

  _stopEngines() {
    for (const eng of Object.values(this.engines)) {
      try { if (eng?._active) eng.stop(); } catch (err) {
        console.warn('[ScriptPlayer] engine stop failed:', err?.message || err);
      }
    }
  }

  _emit() {
    try { this.hooks.onChange?.(this.state); } catch (err) {
      console.warn('[ScriptPlayer] onChange failed:', err?.message || err);
    }
  }
}
