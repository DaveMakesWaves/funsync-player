// Z (Edge Hold) and X (Orgasm Switch) across a video change (lr_x3,
// EroScripts #447; Dave, 2026-11-26; X: "apply the same rule and options").
// With Z set to toggle, Z on, then another video: the device
// moved again on the new video while the app still thought Z was on, so the
// next press "released" it (nothing seemed to happen) and only a second
// press stopped the device.
//
// Two behaviours, chosen in Settings > Edge Hold:
//   - off (the default): a new video resets Z. It starts with Z off and its
//     script plays; the next press stops the device, as on any video.
//   - on (`player.edgeHoldAcrossVideos`): Z stays on into the next video (a
//     queue playing on while you edge). The new video's script waits, and a
//     note flashes on the video at 50 % opacity: "Release Z to start the
//     script" (hold) or "Press Z to resume the script" (toggle).
//
// X the same (`player.orgasmAcrossVideos`): by default a video change ends
// the finisher (as since 2026-11-19); kept on, the finisher plays on into the
// next video, its script waits, and the note says "Release X to start the
// script" (hold) or "Press X to stop the device" (toggle: a press finishes).
//
// The wait is a gate on the sync engines' start(): while Z is on, a start
// from anywhere (a new video's script load, a playback-rate change, a phone
// session handing the devices back) is held and noted as one of the engines
// Z stopped, so Z's release starts it. Z's own releases turn Z off first,
// so they pass through.

/** On only when the setting literally says so (off by default). */
export function carriesAcrossVideos(raw) {
  return raw === true;
}
export const edgeCarriesAcrossVideos = carriesAcrossVideos;

/** The note's locale key for the Z mode (`player.edgeHoldMode`). */
export function edgeCarryNoticeKey(mode) {
  return mode === 'toggle' ? 'player.edgeCarry.press' : 'player.edgeCarry.release';
}

/** The note's locale key for X: started as a toggle (a press finishes) or held. */
export function orgasmCarryNoticeKey(toggled) {
  return toggled ? 'player.orgasmCarry.stop' : 'player.orgasmCarry.release';
}

/**
 * Hold `engine.start()` while `held(name)` is true: `onHeld(name)` is told
 * instead, and the engine is not started. Installed once per engine.
 * @param {{start: Function}|null} engine
 * @param {string} name the name Z's release knows it by ('handy', 'buttplug', …)
 * @param {{held: (name: string) => boolean, onHeld: (name: string) => void}} hooks
 * @returns {boolean} true when the gate is in place
 */
export function gateEngineStart(engine, name, { held, onHeld }) {
  if (!engine || typeof engine.start !== 'function') return false;
  if (engine.__edgeStartGate) return true;
  const start = engine.start;
  engine.start = function gatedStart(...args) {
    if (held(name)) {
      onHeld(name);
      return undefined;
    }
    return start.apply(this, args);
  };
  Object.defineProperty(engine, '__edgeStartGate', { value: true });
  return true;
}

/**
 * Show the note `text` in the player's video wrapper, or remove it (`text`
 * null / empty). It sits right after the <video> (and the audio tile), so
 * the controls and the centre play button stay above it, and lets clicks
 * through.
 * @param {HTMLElement|null} wrapper the player's #video-wrapper
 * @param {string|null} text
 * @returns {HTMLElement|null} the note, when shown
 */
export function setEdgeCarryNotice(wrapper, text) {
  if (!wrapper || typeof wrapper.querySelector !== 'function') return null;
  let note = wrapper.querySelector(':scope > .player__edge-notice');
  if (!text) {
    note?.remove();
    return null;
  }
  if (!note) {
    note = wrapper.ownerDocument.createElement('div');
    note.className = 'player__edge-notice';
    note.setAttribute('role', 'status');
    const after = wrapper.querySelector(':scope > .player__audio-tile') || wrapper.querySelector(':scope > video');
    if (after) after.after(note);
    else wrapper.prepend(note);
  }
  if (note.textContent !== text) note.textContent = String(text);
  return note;
}
