// Convert to play (Dave, 2026-11-26).
//
// His Downloads\2.5.4_variant1.mp4 is MPEG-4 Part 2 ("MPEG4 Simple Profile
// yuv420p", the Xvid / DivX family). Windows plays it with its own codec;
// the player (Chromium) has no decoder for it and cannot use Windows', so it
// played sound over a black picture, and the toast said the codec "isn't
// supported on this system". A remux cannot help: the codec is the problem.
//
// Now the player offers to convert it: the backend re-encodes it to H.264
// 8-bit 4:2:0 in the remux cache (services/ffmpeg.py transcode_start) while
// a toast shows the progress with Cancel, and the copy plays from where the
// video was. The copy is kept: the next play of that file uses it at once,
// without asking. The original is only ever read.
//
// DOM and timers are passed in so the flow can be tested without app.js.

/**
 * Can this video be converted? A local file (not a saved stream), and a
 * bridge that offers it.
 * @param {string} path
 * @param {object} [bridge] window.funsync
 */
export function canConvert(path, bridge) {
  if (typeof path !== 'string' || !path || path.startsWith('stream:')) return false;
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return false;
  return typeof bridge?.transcodeVideo === 'function' && typeof bridge?.transcodeStatus === 'function';
}

/**
 * The converted copy of `path` made before, if there is one (starts nothing).
 * @returns {Promise<string|null>}
 */
export async function convertedCopy(path, bridge) {
  try {
    const answer = await bridge.transcodeVideo(path, { cachedOnly: true });
    return answer?.state === 'done' && typeof answer.path === 'string' && answer.path ? answer.path : null;
  } catch {
    return null;
  }
}

/** A toast body: a line of text and buttons ([label, onClick] pairs). */
function toastBody(doc, text, buttons) {
  const box = doc.createElement('div');
  box.className = 'toast__row convert-toast';
  const line = doc.createElement('span');
  line.className = 'convert-toast__text';
  line.textContent = text;
  box.appendChild(line);
  for (const [label, onClick, cls] of buttons) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `toast__action${cls ? ` ${cls}` : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    box.appendChild(btn);
  }
  return { box, line };
}

/**
 * The offer: "FunSync can't play {codec} video directly. Convert it to play?
 * Your file stays as it is." with Convert to play. Stays until answered or
 * closed (a decision, not a notice).
 * @returns {{dismiss: () => void}|undefined} the toast
 */
export function offerConversion({ codec, onConvert, t, showToast, doc = document }) {
  let toast;
  const { box } = toastBody(doc, t('player.convert.offer', { codec: codec || t('player.convert.unknownCodec') }), [
    [t('player.convert.button'), () => { toast?.dismiss?.(); onConvert(); }, 'convert-toast__go'],
  ]);
  toast = showToast(box, 'warn', 0);
  return toast;
}

/**
 * Convert `path`, showing the progress with Cancel, until it is done, fails
 * or is cancelled. `onDone(copyPath)` runs when the copy is ready.
 *
 * @returns {Promise<'done'|'error'|'cancelled'|'noEncoder'>}
 */
export async function runConversion({
  path, bridge, t, showToast, onDone,
  doc = document, pollMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let answer;
  try {
    answer = await bridge.transcodeVideo(path);
  } catch (err) {
    answer = { state: 'error', error: err?.message || String(err) };
  }
  if (answer?.kind === 'noEncoder') {
    showToast(t('player.convert.noEncoder'), 'error', 10000);
    return 'noEncoder';
  }
  const fail = (error) => {
    showToast(t('player.convert.failed', { error: error || t('player.convert.unknownError') }), 'error', 10000);
    return 'error';
  };
  if (answer?.state === 'done' && answer.path) {
    onDone?.(answer.path);
    return 'done';
  }
  if (answer?.state !== 'running' || !answer.job) return fail(answer?.error);

  const job = answer.job;
  let cancelling = false;
  const pct = (p) => Math.max(0, Math.min(99, Math.floor((Number(p) || 0) * 100)));
  const { box, line } = toastBody(doc, t('player.convert.progress', { pct: pct(answer.progress) }), [
    [t('common.cancel'), () => {
      if (cancelling) return;
      cancelling = true;
      line.textContent = t('player.convert.stopping');
      Promise.resolve(bridge.transcodeCancel?.(job)).catch(() => {});
    }, 'convert-toast__cancel'],
  ]);
  const progress = showToast(box, 'info', 0);

  for (;;) {
    await sleep(pollMs);
    let s;
    try {
      s = await bridge.transcodeStatus(job);
    } catch (err) {
      s = { state: 'error', error: err?.message || String(err) };
    }
    if (s?.state === 'running') {
      if (!cancelling) line.textContent = t('player.convert.progress', { pct: pct(s.progress) });
      continue;
    }
    progress?.dismiss?.();
    if (s?.state === 'done' && s.path) {
      onDone?.(s.path);
      return 'done';
    }
    if (s?.state === 'cancelled') {
      showToast(t('player.convert.cancelled'), 'info');
      return 'cancelled';
    }
    // 'none': the backend restarted and forgot the job.
    return fail(s?.state === 'none' ? t('player.convert.lost') : s?.error);
  }
}
