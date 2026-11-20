// "This video" sync-offset row (Pudknocker #380): − / value / + / Reset for
// the playing video's own delta (`library.syncOffsets`). One builder for the
// Devices > Sync tab and the VR modal, so the two can never drift.
//
// The row owns no state. `getState()` is app.js `_videoSyncOffsetState()`
// (null while no library video is loaded, which hides the row) and
// `onChange(ms)` is `_setVideoSyncOffset`, which saves and re-applies.
// `refresh()` re-reads both the value and every string, so a caller can call
// it after a video change or a language switch.

import { t } from '../js/i18n.js';
import {
  VIDEO_SYNC_OFFSET_STEP_MS,
  VIDEO_SYNC_OFFSET_LIMIT_MS,
  clampVideoSyncOffset,
  formatVideoSyncOffset,
} from '../js/video-sync-offset.js';

/**
 * @param {object} o
 * @param {() => ({path: string, ms: number}|null)} o.getState
 * @param {(ms: number) => void} o.onChange
 * @returns {{ el: HTMLElement, refresh: () => void }}
 */
export function createVideoSyncOffsetRow({ getState, onChange } = {}) {
  const el = document.createElement('div');
  el.className = 'video-sync-offset';
  el.hidden = true;

  const row = document.createElement('div');
  row.className = 'connection-panel__setting-row video-sync-offset__row';

  const label = document.createElement('span');
  label.className = 'connection-panel__setting-label';

  const button = (cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `connection-panel__action connection-panel__action--utility ${cls}`;
    return b;
  };
  const minus = button('video-sync-offset__earlier');
  minus.textContent = '−';
  const value = document.createElement('span');
  value.className = 'connection-panel__setting-value video-sync-offset__value';
  value.setAttribute('aria-live', 'polite');
  const plus = button('video-sync-offset__later');
  plus.textContent = '+';
  const reset = button('video-sync-offset__reset');

  row.append(label, minus, value, plus, reset);

  const hint = document.createElement('p');
  hint.className = 'connection-panel__hint video-sync-offset__hint';

  el.append(row, hint);

  const current = () => {
    const s = typeof getState === 'function' ? getState() : null;
    return s && s.path ? s : null;
  };

  const refresh = () => {
    const s = current();
    el.hidden = !s;
    const ms = s ? clampVideoSyncOffset(s.ms) : 0;
    label.textContent = t('videoSyncOffset.label');
    const step = VIDEO_SYNC_OFFSET_STEP_MS;
    minus.setAttribute('aria-label', t('videoSyncOffset.earlier', { ms: step }));
    minus.title = t('videoSyncOffset.earlier', { ms: step });
    plus.setAttribute('aria-label', t('videoSyncOffset.later', { ms: step }));
    plus.title = t('videoSyncOffset.later', { ms: step });
    reset.textContent = t('videoSyncOffset.reset');
    hint.textContent = t('videoSyncOffset.hint');
    value.textContent = formatVideoSyncOffset(ms);
    minus.disabled = ms <= -VIDEO_SYNC_OFFSET_LIMIT_MS;
    plus.disabled = ms >= VIDEO_SYNC_OFFSET_LIMIT_MS;
    reset.disabled = ms === 0;
  };

  const change = (next) => {
    if (!current()) return;
    if (typeof onChange === 'function') onChange(clampVideoSyncOffset(next));
    refresh();
  };
  minus.addEventListener('click', () => change((current()?.ms || 0) - VIDEO_SYNC_OFFSET_STEP_MS));
  plus.addEventListener('click', () => change((current()?.ms || 0) + VIDEO_SYNC_OFFSET_STEP_MS));
  reset.addEventListener('click', () => change(0));

  refresh();
  return { el, refresh };
}
