// RemoteVideoModal — "Load from URL". Paste a video page link (or direct
// video URL); the backend resolves it via yt-dlp and we play the stream
// (hls.js for HLS) synced with an optionally-attached funscript.
//
// States: input → resolving → found → (play) | error. The modal owns a single
// body container and swaps its contents per state. All user-supplied text
// (URL, resolved title) is set via textContent — never innerHTML — so a
// crafted title can't inject markup.
//
// v1 is VIDEO-ONLY for auto-pairing: the user attaches a local funscript
// manually here; EroScripts auto-match is a planned follow-up.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { icon, X, FileCheck } from '../js/icons.js';

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * @param {object} opts
 * @param {(result:object, scriptPath:string|null)=>void} opts.onPlay
 */
export async function openRemoteVideoModal({ onPlay } = {}) {
  await Modal.open({
    title: t('remoteVideo.title'),
    onRender: (body, close) => {
      const root = document.createElement('div');
      root.className = 'remote-video-modal';
      body.appendChild(root);

      // Shared state across the modal's lifetime.
      const state = { result: null, scriptPath: null, scriptName: null, cancelled: false };

      const clear = () => { root.textContent = ''; };

      // --- INPUT ------------------------------------------------------------
      const renderInput = (prefillUrl = '') => {
        clear();
        const label = document.createElement('div');
        label.className = 'remote-video-modal__label';
        label.textContent = t('remoteVideo.inputLabel');
        root.appendChild(label);

        const row = document.createElement('div');
        row.className = 'remote-video-modal__input-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'remote-video-modal__input';
        input.placeholder = 'https://…';
        input.value = prefillUrl;
        const loadBtn = document.createElement('button');
        loadBtn.className = 'remote-video-modal__btn remote-video-modal__btn--primary';
        loadBtn.textContent = t('remoteVideo.load');
        row.append(input, loadBtn);
        root.appendChild(row);

        const hint = document.createElement('div');
        hint.className = 'remote-video-modal__hint';
        hint.textContent = t('remoteVideo.inputHint');
        root.appendChild(hint);

        const footer = document.createElement('div');
        footer.className = 'remote-video-modal__footer';
        const cancel = document.createElement('button');
        cancel.className = 'remote-video-modal__btn';
        cancel.textContent = t('common.cancel');
        cancel.addEventListener('click', () => close());
        footer.appendChild(cancel);
        root.appendChild(footer);

        const submit = () => {
          const url = input.value.trim();
          if (!url) { input.focus(); return; }
          renderResolving(url);
        };
        loadBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        setTimeout(() => input.focus(), 0);
      };

      // --- RESOLVING --------------------------------------------------------
      const renderResolving = async (url) => {
        clear();
        state.cancelled = false;
        const wrap = document.createElement('div');
        wrap.className = 'remote-video-modal__resolving';
        const spinner = document.createElement('div');
        spinner.className = 'remote-video-modal__spinner';
        const msg = document.createElement('div');
        msg.className = 'remote-video-modal__resolving-text';
        msg.textContent = t('remoteVideo.finding');
        wrap.append(spinner, msg);
        root.appendChild(wrap);

        const footer = document.createElement('div');
        footer.className = 'remote-video-modal__footer';
        const cancel = document.createElement('button');
        cancel.className = 'remote-video-modal__btn';
        cancel.textContent = t('common.cancel');
        cancel.addEventListener('click', () => { state.cancelled = true; renderInput(url); });
        footer.appendChild(cancel);
        root.appendChild(footer);

        let res;
        try {
          res = await window.funsync.resolveRemoteVideo(url);
        } catch (err) {
          res = { ok: false, kind: 'error', message: err?.message || String(err) };
        }
        if (state.cancelled) return; // user backed out while resolving
        if (res?.ok) {
          state.result = res;
          renderFound();
        } else {
          renderError(res?.kind || 'error', url);
        }
      };

      // --- FOUND ------------------------------------------------------------
      const renderFound = () => {
        clear();
        const r = state.result;

        const card = document.createElement('div');
        card.className = 'remote-video-modal__found';

        if (r.thumbnail) {
          const thumb = document.createElement('img');
          thumb.className = 'remote-video-modal__thumb';
          thumb.src = r.thumbnail;
          thumb.referrerPolicy = 'no-referrer';
          thumb.addEventListener('error', () => thumb.remove());
          card.appendChild(thumb);
        }

        const meta = document.createElement('div');
        meta.className = 'remote-video-modal__meta';
        const title = document.createElement('div');
        title.className = 'remote-video-modal__found-title';
        title.textContent = r.title || t('remoteVideo.untitled');
        const sub = document.createElement('div');
        sub.className = 'remote-video-modal__found-sub';
        sub.textContent = [r.site, fmtDuration(r.duration), r.isHls ? 'HLS' : null]
          .filter(Boolean).join(' · ');
        meta.append(title, sub);
        card.appendChild(meta);
        root.appendChild(card);

        // Script-pairing row (manual attach in v1).
        const scriptRow = document.createElement('div');
        scriptRow.className = 'remote-video-modal__script-row';
        const renderScript = () => {
          scriptRow.textContent = '';
          const lbl = document.createElement('span');
          lbl.className = 'remote-video-modal__script-label';
          lbl.textContent = t('remoteVideo.script');
          scriptRow.appendChild(lbl);
          if (state.scriptName) {
            const ok = document.createElement('span');
            ok.className = 'remote-video-modal__script-ok';
            ok.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
            const name = document.createElement('span');
            name.textContent = ' ' + state.scriptName;
            ok.appendChild(name);
            const clearBtn = document.createElement('button');
            clearBtn.className = 'remote-video-modal__script-clear';
            clearBtn.title = t('remoteVideo.removeScript');
            clearBtn.appendChild(icon(X, { width: 13, height: 13 }));
            clearBtn.addEventListener('click', () => {
              state.scriptPath = null; state.scriptName = null; renderScript();
            });
            scriptRow.append(ok, clearBtn);
          } else {
            const attach = document.createElement('button');
            attach.className = 'remote-video-modal__btn remote-video-modal__btn--small';
            attach.textContent = t('remoteVideo.attachScript');
            attach.addEventListener('click', async () => {
              const picked = await window.funsync.selectFunscript();
              if (picked?.path) { state.scriptPath = picked.path; state.scriptName = picked.name; renderScript(); }
            });
            scriptRow.appendChild(attach);
          }
        };
        renderScript();
        root.appendChild(scriptRow);

        const footer = document.createElement('div');
        footer.className = 'remote-video-modal__footer';
        const cancel = document.createElement('button');
        cancel.className = 'remote-video-modal__btn';
        cancel.textContent = t('common.cancel');
        cancel.addEventListener('click', () => close());
        const play = document.createElement('button');
        play.className = 'remote-video-modal__btn remote-video-modal__btn--primary';
        play.textContent = '▶ ' + t('remoteVideo.play');
        play.addEventListener('click', () => {
          onPlay?.(state.result, state.scriptPath);
          close();
        });
        footer.append(cancel, play);
        root.appendChild(footer);
      };

      // --- ERROR ------------------------------------------------------------
      const renderError = (kind, url) => {
        clear();
        const box = document.createElement('div');
        box.className = 'remote-video-modal__error';
        const head = document.createElement('div');
        head.className = 'remote-video-modal__error-head';
        head.textContent = '⚠ ' + t('remoteVideo.errorHead');
        const detailKey = `remoteVideo.err.${kind}`;
        const detailMsg = t(detailKey);
        const detail = document.createElement('div');
        detail.className = 'remote-video-modal__error-detail';
        // Fall back to the generic message if no specific string for the kind.
        detail.textContent = detailMsg === detailKey ? t('remoteVideo.err.error') : detailMsg;
        box.append(head, detail);
        root.appendChild(box);

        const footer = document.createElement('div');
        footer.className = 'remote-video-modal__footer';
        const back = document.createElement('button');
        back.className = 'remote-video-modal__btn';
        back.textContent = t('remoteVideo.tryAnother');
        back.addEventListener('click', () => renderInput(url));
        footer.appendChild(back);
        root.appendChild(footer);
      };

      renderInput();
    },
  });
}
