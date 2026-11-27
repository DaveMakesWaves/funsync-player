// RemoteVideoModal — "Load from URL". Paste a video page link (or direct
// video URL); the backend resolves it via yt-dlp and we play the stream
// (hls.js for HLS) synced with an optionally-attached funscript.
//
// States: input → resolving → found → (play) | error. The modal owns a single
// body container and swaps its contents per state. All user-supplied text
// (URL, resolved title) is set via textContent — never innerHTML — so a
// crafted title can't inject markup.
//
// The script is picked by hand (the row shows from the first screen since
// 2026-11-22); the EroScripts tab's Watch brings a post's own script.

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
/**
 * @param {object} [opts.save]      {initial: boolean, onChange(bool)}: the "Save to library" tick (none without)
 * @param {Function} [opts.onQueue] (result, scriptPath): "Add to queue" (none without)
 */
/**
 * What was typed into Load from URL, as an address to look up, or why it is
 * not one (test day 2026-11-26, S029: "not a url" went to the resolver and
 * came back as "the site may be unsupported, or the video needs a login").
 * http(s) links pass as they are; "site.com/page" (no scheme, a dot in the
 * host, no spaces) gets https://; anything else, another scheme or a file
 * path included, is not a web address.
 * @param {string} text
 * @returns {{url: string}|{error: 'notUrl'}}
 */
export function webAddressFrom(text) {
  const s = String(text ?? '').trim();
  const ok = (u) => {
    try {
      const url = new URL(u);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return { url: u };
    } catch { /* not a URL */ }
    return { error: 'notUrl' };
  };
  if (/^https?:\/\//i.test(s)) return /\s/.test(s) ? { error: 'notUrl' } : ok(s);
  // "site.com/page" or "site.com:8080/page": a host with a dot (no colon in
  // it, so "javascript:…" and "C:\…" are not hosts), then a port and a path.
  if (/^[^\s/\\:]+\.[^\s/\\:]+(:\d+)?(\/\S*)?$/.test(s)) return ok('https://' + s);
  return { error: 'notUrl' }; // another scheme, a file path, words
}

export async function openRemoteVideoModal({ onPlay, resolve = null, save = null, onQueue = null } = {}) {
  await Modal.open({
    title: t('remoteVideo.title'),
    onRender: (body, close) => {
      const root = document.createElement('div');
      root.className = 'remote-video-modal';
      body.appendChild(root);

      // Shared state across the modal's lifetime.
      const state = { result: null, scriptPath: null, scriptName: null, cancelled: false, save: save?.initial !== false };

      const clear = () => { root.textContent = ''; };

      // The script row: on every screen, from the first (Dave, 2026-11-22:
      // "shouldn't load url have a pick funscript browser below it too?").
      // It used to appear only once the link had resolved, so nothing said a
      // script could go with the video. The pick survives a lookup, an error
      // and "Try another link".
      const scriptRow = () => {
        const row = document.createElement('div');
        row.className = 'remote-video-modal__script-row';
        const render = () => {
          row.textContent = '';
          const lbl = document.createElement('span');
          lbl.className = 'remote-video-modal__script-label';
          lbl.textContent = t('remoteVideo.script');
          row.appendChild(lbl);
          if (state.scriptName) {
            const ok = document.createElement('span');
            ok.className = 'remote-video-modal__script-ok';
            ok.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
            const name = document.createElement('span');
            name.textContent = ' ' + state.scriptName;
            ok.appendChild(name);
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'remote-video-modal__script-clear';
            clearBtn.title = t('remoteVideo.removeScript');
            clearBtn.setAttribute('aria-label', t('remoteVideo.removeScript'));
            clearBtn.appendChild(icon(X, { width: 13, height: 13 }));
            clearBtn.addEventListener('click', () => {
              state.scriptPath = null; state.scriptName = null; render();
            });
            row.append(ok, clearBtn);
          } else {
            const attach = document.createElement('button');
            attach.type = 'button';
            attach.className = 'remote-video-modal__btn remote-video-modal__btn--small';
            attach.textContent = t('remoteVideo.attachScript');
            attach.addEventListener('click', async () => {
              const picked = await window.funsync.selectFunscript();
              if (picked?.path) { state.scriptPath = picked.path; state.scriptName = picked.name; render(); }
            });
            row.appendChild(attach);
          }
        };
        render();
        return row;
      };

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
        root.appendChild(scriptRow());

        const footer = document.createElement('div');
        footer.className = 'remote-video-modal__footer';
        const cancel = document.createElement('button');
        cancel.className = 'remote-video-modal__btn';
        cancel.textContent = t('common.cancel');
        cancel.addEventListener('click', () => close());
        footer.appendChild(cancel);
        root.appendChild(footer);

        const submit = () => {
          if (!input.value.trim()) { input.focus(); return; }
          // Not a web address: said here, under the box, with what was typed
          // kept to fix; nothing is sent (S029).
          const address = webAddressFrom(input.value);
          if (address.error) {
            hint.textContent = t('remoteVideo.err.notUrl');
            hint.classList.add('remote-video-modal__hint--error');
            hint.setAttribute('role', 'alert');
            input.setAttribute('aria-invalid', 'true');
            input.focus();
            return;
          }
          renderResolving(address.url);
        };
        input.addEventListener('input', () => {
          if (!hint.classList.contains('remote-video-modal__hint--error')) return;
          hint.textContent = t('remoteVideo.inputHint');
          hint.classList.remove('remote-video-modal__hint--error');
          hint.removeAttribute('role');
          input.removeAttribute('aria-invalid');
        });
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
        root.appendChild(scriptRow());

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
          res = await (resolve ? resolve(url) : window.funsync.resolveRemoteVideo(url));
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

        root.appendChild(scriptRow());

        // Save to library (2026-11-23, SCOPE-saved-streams.md): on unless
        // turned off, and remembered either way.
        if (save) {
          const tick = document.createElement('label');
          tick.className = 'remote-video-modal__save';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'remote-video-modal__save-box';
          box.checked = state.save;
          box.addEventListener('change', () => { state.save = box.checked; save.onChange?.(box.checked); });
          const text = document.createElement('span');
          text.textContent = t('remoteVideo.saveToLibrary');
          tick.append(box, text);
          root.appendChild(tick);
        }

        const footer = document.createElement('div');
        footer.className = 'remote-video-modal__footer';
        const cancel = document.createElement('button');
        cancel.className = 'remote-video-modal__btn';
        cancel.textContent = t('common.cancel');
        cancel.addEventListener('click', () => close());
        footer.appendChild(cancel);
        // For later: saved and put at the end of the queue, not played.
        if (onQueue) {
          const later = document.createElement('button');
          later.type = 'button';
          later.className = 'remote-video-modal__btn remote-video-modal__queue';
          later.textContent = t('remoteVideo.addToQueue');
          later.addEventListener('click', () => {
            onQueue(state.result, state.scriptPath);
            close();
          });
          footer.appendChild(later);
        }
        const play = document.createElement('button');
        play.className = 'remote-video-modal__btn remote-video-modal__btn--primary';
        play.textContent = '▶ ' + t('remoteVideo.play');
        play.addEventListener('click', () => {
          onPlay?.(state.result, state.scriptPath, { save: !!save && state.save });
          close();
        });
        footer.appendChild(play);
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
        // The page in the browser: what a refusing site, a login or a
        // region block leaves (2026-11-23: the error was a dead end).
        if (/^https?:\/\//i.test(url)) {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'remote-video-modal__btn';
          open.textContent = t('eroscripts.tab.openInBrowser');
          open.addEventListener('click', () => window.funsync.openExternal?.(url));
          footer.appendChild(open);
        }
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
