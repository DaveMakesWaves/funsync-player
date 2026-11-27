/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The script player (v0.10.1; powerkool on EroScripts: play "scripts that
// aren't associated with a video", and "keep a script playing while allowing
// one to view other videos without utilizing the normally associated
// script(s)"; Dave: "pill offers the switch, loop off by default, desktop
// only").
//
// REAL ScriptClock, DeviceGate and ScriptPlayer; fake managers and engines
// that record what reaches them. Asserted: the clock's time and end, what the
// gate lets through (and from whom), and the order of a take-over and a
// hand-back. The same on the REAL Handy code is in script-player-handy.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScriptClock } from '../../renderer/js/script-clock.js';
import { DeviceGate, installDeviceGate, ownerFacade, GATED_METHODS, blockedResult } from '../../renderer/js/device-gate.js';
import { ScriptPlayer, SCRIPT_PLAYER_OWNER, isPlayableFunscript } from '../../renderer/js/script-player.js';

const SCRIPT = JSON.stringify({ actions: [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }, { at: 4000, pos: 10 }] });

describe('ScriptClock: the script player\'s stand-in video', () => {
  let now;
  let clock;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    clock = new ScriptClock({ now: () => now });
    clock.duration = 4;
  });
  afterEach(() => vi.useRealTimers());

  const events = () => {
    const seen = [];
    for (const type of ['playing', 'pause', 'seeked', 'ended']) clock.addEventListener(type, () => seen.push(type));
    return seen;
  };

  it('runs on the wall clock while playing, holds while paused, seeks with an event', async () => {
    const seen = events();
    await clock.play();
    now = 1500;
    expect(clock.currentTime).toBeCloseTo(1.5);
    clock.pause();
    now = 3000;
    expect(clock.currentTime).toBeCloseTo(1.5);
    clock.seek(3.25);
    expect(clock.currentTime).toBe(3.25);
    expect(seen).toEqual(['playing', 'pause', 'seeked']);
  });

  it('loop off (the default): at the end it pauses there and fires ended; Play starts again from 0', async () => {
    const seen = events();
    expect(clock.loop).toBe(false);
    await clock.play();
    now = 4000;
    vi.advanceTimersByTime(4100);
    expect(clock.paused).toBe(true);
    expect(clock.ended).toBe(true);
    expect(clock.currentTime).toBe(4);
    expect(seen).toEqual(['playing', 'pause', 'ended']);
    await clock.play();
    expect(clock.currentTime).toBe(0);
  });

  it('loop on: at the end it goes back to 0 with a seeked (the Handy re-anchors) and keeps playing', async () => {
    const seen = events();
    clock.loop = true;
    await clock.play();
    now = 4000;
    vi.advanceTimersByTime(4100);
    expect(clock.paused).toBe(false);
    expect(clock.currentTime).toBe(0);
    expect(seen).toEqual(['playing', 'seeked']);
  });

  it('the wrapper the sync engines read', () => {
    const w = clock.asVideoPlayerWrapper();
    expect(w.video).toBe(clock);
    expect(w.paused).toBe(true);
    expect(w.duration).toBe(4);
    expect(w.playbackRate).toBe(1);
  });
});

describe('DeviceGate: only the owner reaches the devices while it is closed', () => {
  function fakeManager() {
    const sent = [];
    return {
      sent,
      connected: true,
      _lastUrl: null,
      async hsspPlay(at) { sent.push(['hsspPlay', at]); return 'played'; },
      async uploadAndSetScript(c) {
        await Promise.resolve();
        this._lastUrl = `url:${c}`;              // state written through `this`
        return this.setupScript(this._lastUrl);  // an internal call to another gated method, after an await
      },
      async setupScript(url) { sent.push(['setupScript', url]); return 'set'; },
      async stageScript() { sent.push(['stageScript']); return 'staged'; },
      async setOffset(ms) { sent.push(['setOffset', ms]); return 'offset'; },   // a setting: never gated
    };
  }

  it('closed: the app\'s calls get a harmless "done" and reach nothing; the owner\'s facade reaches the device, internal calls and awaits included', async () => {
    const gate = new DeviceGate();
    const m = fakeManager();
    installDeviceGate(gate, 'handy', m);
    gate.close(SCRIPT_PLAYER_OWNER);

    expect(await m.hsspPlay(5)).toBe(true);            // blocked: "done"
    expect(await m.stageScript('x')).toBeNull();
    expect(await m.uploadAndSetScript('A')).toBe(true);
    expect(m.sent).toEqual([]);
    expect(gate.blocked).toBe(3);

    const facade = ownerFacade(m, SCRIPT_PLAYER_OWNER);
    expect(await facade.uploadAndSetScript('B')).toBe('set');
    expect(await facade.hsspPlay(7)).toBe('played');
    expect(m.sent).toEqual([['setupScript', 'url:B'], ['hsspPlay', 7]]);
    expect(m._lastUrl).toBe('url:B');                  // the facade's write is on the real manager

    expect(await m.setOffset(40)).toBe('offset');      // settings pass either way
  });

  it('open: everyone reaches the devices again', async () => {
    const gate = new DeviceGate();
    const m = fakeManager();
    installDeviceGate(gate, 'handy', m);
    gate.close(SCRIPT_PLAYER_OWNER);
    gate.open();
    expect(await m.hsspPlay(1)).toBe('played');
    expect(m.sent).toEqual([['hsspPlay', 1]]);
  });

  it('blocked answers keep their callers on the happy path', () => {
    expect(blockedResult('handy', 'uploadAndSetScript')).toBe(true);
    expect(blockedResult('handy', 'hsspStop')).toBe(true);
    expect(blockedResult('tcode', 'stop')).toEqual([]);
    expect(blockedResult('autoblow', 'uploadScript')).toBe(true);
    expect(blockedResult('buttplug', 'sendLinear')).toBeUndefined();
    expect(GATED_METHODS.handy).not.toContain('setOffset');
    expect(GATED_METHODS.handy).not.toContain('setStrokeZone');
  });

  it('a sync command stays sync when blocked (T-Code send paths)', () => {
    const gate = new DeviceGate();
    const t = { connected: true, sendAxes() { return 'sent'; }, stop() { return ['L0']; }, async send() { return 'ok'; } };
    installDeviceGate(gate, 'tcode', t);
    gate.close('someone');
    expect(t.sendAxes({ L0: 50 })).toBeUndefined();
    expect(t.stop()).toEqual([]);
  });
});

describe('ScriptPlayer: take over, play, hand back', () => {
  let gate;
  let order;
  let managers;
  let engines;
  let hooks;
  let player;
  let clock;
  let upload;   // the Handy's upload before the gate wraps it

  function fakeEngine(kind) {
    return {
      kind, _active: false, _scriptReady: false,
      start: vi.fn(function start() { this._active = true; order.push(`${kind}:start`); }),
      stop: vi.fn(function stop() { this._active = false; order.push(`${kind}:stop`); }),
      reloadActions: vi.fn(),
      uploadScript: vi.fn(async () => true),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    order = [];
    gate = new DeviceGate();
    managers = {
      handy: { connected: true, uploadAndSetScript: (upload = vi.fn(async () => true)) },
      buttplug: { connected: true, devices: [{ name: 'toy' }] },
      tcode: { connected: false },
      autoblow: null,
    };
    installDeviceGate(gate, 'handy', managers.handy);
    clock = new ScriptClock();
    hooks = {
      beforeTakeover: vi.fn(() => { order.push(`beforeTakeover:gate-${gate.closed ? 'closed' : 'open'}`); }),
      afterHandback: vi.fn(() => { order.push(`afterHandback:gate-${gate.closed ? 'closed' : 'open'}`); }),
      configureEngines: vi.fn(),
      handyContent: vi.fn((c) => `[${c}]`),
      onChange: vi.fn(),
    };
    player = new ScriptPlayer({
      gate,
      managers,
      clock,
      createFunscriptEngine: () => {
        let acts = null;
        return {
          async loadContent(c) { acts = JSON.parse(c).actions; },
          getActions: () => acts,
          getInfo: () => ({ durationMs: acts.at(-1).at }),
          get isLoaded() { return !!acts; },
          getPositionAt: (ms) => (ms < 500 ? 10 : 90),
        };
      },
      createEngines: () => (engines = { handy: fakeEngine('handy'), buttplug: fakeEngine('buttplug'), tcode: fakeEngine('tcode') }),
      hooks,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('start: the video lets go first, the gate closes for the script player, the connected devices start, it plays', async () => {
    expect(await player.start({ name: 'Loop.funscript', path: 'C:\\s\\Loop.funscript', content: SCRIPT })).toBe(true);
    expect(order[0]).toBe('beforeTakeover:gate-open');
    expect(gate.closed).toBe(true);
    expect(gate.owner).toBe(SCRIPT_PLAYER_OWNER);
    expect(hooks.configureEngines).toHaveBeenCalledWith(engines);
    expect(engines.buttplug.start).toHaveBeenCalledTimes(1);
    expect(engines.tcode.start).not.toHaveBeenCalled();          // not connected
    expect(hooks.handyContent).toHaveBeenCalledWith(SCRIPT, { durationMs: 4000 });
    expect(upload).toHaveBeenCalledWith(`[${SCRIPT}]`);
    expect(engines.handy._scriptReady).toBe(true);
    expect(engines.handy.start).toHaveBeenCalledTimes(1);
    expect(player.state).toMatchObject({ active: true, name: 'Loop.funscript', paused: false, loop: false, duration: 4, devices: ['buttplug', 'handy'] });
  });

  it('the Handy upload goes through the owner\'s facade: it reaches the device with the gate closed', async () => {
    await player.start({ name: 'a', content: SCRIPT });
    expect(gate.blocked).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('a second start switches scripts without handing the devices back in between', async () => {
    await player.start({ name: 'a', content: SCRIPT });
    hooks.beforeTakeover.mockClear();
    await player.start({ name: 'b', content: SCRIPT });
    expect(hooks.beforeTakeover).not.toHaveBeenCalled();
    expect(hooks.afterHandback).not.toHaveBeenCalled();
    expect(gate.closed).toBe(true);
    expect(engines.buttplug.stop).toHaveBeenCalledTimes(1);
    expect(player.state.name).toBe('b');
  });

  it('stop: its engines send their stops, the gate opens, THEN the video gets the devices back', async () => {
    await player.start({ name: 'a', content: SCRIPT });
    order.length = 0;
    await player.stop();
    expect(order).toEqual(['handy:stop', 'buttplug:stop', 'afterHandback:gate-open']);
    expect(player.state.active).toBe(false);
    expect(clock.paused).toBe(true);
  });

  it('Intiface connected with no toy: its engine runs (for a toy added later) but the bar does not claim a device', async () => {
    managers.buttplug.devices = [];
    await player.start({ name: 'a', content: SCRIPT });
    expect(engines.buttplug.start).toHaveBeenCalled();
    expect(player.state.devices).toEqual(['handy']);
  });

  it('a file that is not a funscript changes nothing: the video keeps the devices', async () => {
    expect(isPlayableFunscript('{"actions": []}')).toBe(false);
    expect(isPlayableFunscript('not json')).toBe(false);
    expect(await player.start({ name: 'bad', content: 'not json' })).toBe(false);
    expect(hooks.beforeTakeover).not.toHaveBeenCalled();
    expect(gate.closed).toBe(false);
    expect(player.state.active).toBe(false);
  });

  it('the page going away: stopForExit opens the gate at once, without a hand-back', async () => {
    await player.start({ name: 'a', content: SCRIPT });
    player.stopForExit();
    expect(gate.closed).toBe(false);
    expect(engines.handy.stop).toHaveBeenCalled();
    expect(hooks.afterHandback).not.toHaveBeenCalled();
  });

  it('loop is off by default and follows setLoop; the simulator reads the script\'s position', async () => {
    await player.start({ name: 'a', content: SCRIPT });
    expect(clock.loop).toBe(false);
    player.setLoop(true);
    expect(clock.loop).toBe(true);
    expect(player.state.loop).toBe(true);
    expect(player.livePosition).toBe(10);
    await player.stop();
    expect(player.livePosition).toBeNull();
  });
});
