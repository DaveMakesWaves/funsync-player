// Orgasm Switch — Handy engage/release sequences (HSSP LOOP mode).
//
// The Handy is cloud-connected: streaming per-tick HDSP position commands
// over the handyfeeling.com API can't keep up (~25 cmd/s lag/queue at the
// API and the device chases stale targets to an extreme — the on-device
// "crawls to the top and strains" failure). So the finisher plays via HSSP
// LOOP instead: upload once (cached), set + loop + play, and the device
// loops it entirely on its own — the same cloud-friendly path the main
// script uses. The per-tick OrgasmSwitch loop drives only local
// Buttplug/T-Code.
//
// Extracted from app.js so the ORDER of the device handshake is unit-
// testable with a fake that mirrors the real HandyManager contract —
// sequencing bugs here (an un-awaited hsspStop landing after setScript,
// loop mode left ON when the main script is restored) are invisible to
// tests that only assert call presence.
//
// ORDER CONTRACT (engage):  upload? → setupScript → hsspPlay(0), each step
//                           awaited, aborting if the activation went stale.
//                           No hsspStop first: setScript replaces playback
//                           on its own (the normal video-switch flow relies
//                           on exactly that), so the device keeps stroking
//                           the MAIN script through the handoff instead of
//                           going dead for a round-trip — and no setLoop:
//                           see LOOPING below.
// ORDER CONTRACT (release): hsspStop — the finisher must be halted before
//                           the caller re-establishes the main script (the
//                           video may be paused, in which case nothing
//                           replaces the loop).
//
// LOOPING: HSSP loop mode is NOT used — the SDK's setHsspLoop 404s against
// the current handyfeeling API ("Set loop failed: Not Found", on-device log
// 2026-08-03), so the device would play the finisher ONCE and stop at the
// end. Instead the finisher's actions are TILED back-to-back into one long
// script at upload time (tileFinisherContent) — device-side "looping" with
// zero extra API calls and a seamless wrap. A hold longer than the tiled
// length (~10 min) ends with the device stopping; acceptable for a finisher.
//
// CUTOFF: HSSP plays server-side, so the per-device output limit (floor/
// ceiling) must be baked into the uploaded content — same reason the main
// script clamps at upload (_uploadAndStartSync). The caller owns cache
// invalidation: a cached URL was built with a specific cutoff, so changing
// the sliders must drop the cache (keyed on the cutoff at upload time).

import { clampRawScriptContent } from './device-transform-stack.js';

/** Tiled length target (~10 min of finisher) and a hard action-count cap. */
export const TILE_TARGET_MS = 600000;
export const TILE_MAX_ACTIONS = 8000;

/**
 * Tile a finisher funscript's actions back-to-back so the device plays the
 * pattern "looped" without HSSP loop mode. The loop period matches the
 * OrgasmSwitch tick loop's clock (elapsed % lastAction.at), so Buttplug/
 * T-Code (driven live) and the Handy (playing the tiled upload) stay in
 * phase. Boundary-duplicate timestamps (last action at t=D, next rep's
 * first at t=D+0) are dropped. Returns the input unchanged when it can't
 * be parsed, has < 2 actions, or has no positive duration — the upload
 * then behaves exactly as before.
 *
 * @param {string} rawContent — finisher funscript JSON
 * @param {number} [targetMs] — minimum tiled length
 * @param {number} [maxActions] — hard cap on emitted actions
 * @returns {string}
 */
export function tileFinisherContent(rawContent, targetMs = TILE_TARGET_MS, maxActions = TILE_MAX_ACTIONS) {
  if (typeof rawContent !== 'string' || rawContent.length === 0) return rawContent;
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
  const actions = Array.isArray(parsed?.actions) ? parsed.actions
    .filter((a) => a && Number.isFinite(a.at) && Number.isFinite(a.pos))
    .sort((a, b) => a.at - b.at) : null;
  if (!actions || actions.length < 2) return rawContent;
  const period = actions[actions.length - 1].at;
  if (!(period > 0)) return rawContent;
  const reps = Math.max(1, Math.ceil(targetMs / period));
  const tiled = [];
  outer:
  for (let i = 0; i < reps; i++) {
    const offset = i * period;
    for (const a of actions) {
      const at = a.at + offset;
      // Skip boundary duplicates (same timestamp as the previous rep's
      // final action) — two actions at one timestamp confuse firmware.
      if (tiled.length > 0 && at <= tiled[tiled.length - 1].at) continue;
      if (tiled.length >= maxActions) break outer;
      tiled.push({ ...a, at });
    }
  }
  return JSON.stringify({ ...parsed, actions: tiled });
}

/**
 * Engage the Handy finisher loop. Fire-and-forget from onActivate; returns a
 * status string for tests/diagnosis:
 *   'looping'      — device is looping the finisher
 *   'no-url'       — no cached URL and upload failed/no content (device untouched)
 *   'stale'        — the activation was released mid-sequence; aborted cleanly
 *   'setup-failed' — setScript refused (device untouched beyond hsspStop)
 *   'error'        — a step threw (logged, best-effort)
 *
 * @param {object} deps
 * @param {object} deps.handyManager — needs { uploadScriptOnly,
 *   setupScript, hsspPlay } (hsspStop only on release)
 * @param {string|null} deps.content — raw finisher funscript JSON (upload source)
 * @param {string|null} deps.cachedUrl — previously-uploaded cloud URL, skips
 *   upload. Caller must only pass a URL whose upload used the CURRENT cutoff.
 * @param {{min: number, max: number}|null} [deps.cutoff] — per-device output
 *   limit; baked into the upload so the device-side loop respects it
 * @param {(url: string) => void} [deps.onUrlCached] — persist a fresh upload's URL
 * @param {() => boolean} deps.isCurrent — false once the user released this
 *   activation (a stale engage must never clobber the restore)
 * @returns {Promise<string>}
 */
export async function engageHandyFinisher({ handyManager, content, cachedUrl, cutoff, onUrlCached, isCurrent }) {
  try {
    let url = cachedUrl;
    if (!url && content) {
      // Tile first (device-side "loop"), then clamp to the output limit.
      url = await handyManager.uploadScriptOnly(
        clampRawScriptContent(tileFinisherContent(content), cutoff ?? null),
      );
      if (url) onUrlCached?.(url);
    }
    if (!url) {
      console.warn('[OrgasmSwitch] Handy: no finisher cloud URL (upload failed?)');
      return 'no-url';
    }
    if (!isCurrent()) return 'stale'; // released during upload
    // No hsspStop first — setScript replaces playback itself, and skipping
    // the extra round-trip keeps the main script stroking through the
    // handoff instead of leaving a dead gap (community: "delay between the
    // orgasm switch and the script changing").
    const ok = await handyManager.setupScript(url);
    if (!ok) return 'setup-failed';
    if (!isCurrent()) return 'stale'; // released during setup — restore's setScript comes after us, so main wins
    await handyManager.hsspPlay(0);
    console.log('[OrgasmSwitch] Handy finisher looping via HSSP');
    return 'looping';
  } catch (e) {
    console.warn('[OrgasmSwitch] Handy HSSP-loop engage error:', e?.message || e);
    return 'error';
  }
}

/**
 * Stop the finisher. Await this BEFORE re-establishing the main script
 * (hold-mode release) — the video may be paused, in which case nothing else
 * would ever halt the tiled loop. No setLoop(false): loop mode is never set
 * (see LOOPING above — the endpoint 404s; tiling replaces it). Best-effort:
 * a throw is swallowed so the caller's restore always proceeds.
 *
 * @param {object} deps
 * @param {object} deps.handyManager — needs { hsspStop }
 */
export async function releaseHandyFinisher({ handyManager }) {
  try {
    await handyManager.hsspStop?.();
  } catch { /* best-effort */ }
}
