// UpNextCard — view for the Up Next overlay. Paints the countdown card
// (thumbnail + title + meta + countdown + dismiss) and the end-of-list
// state (heading + back CTA). Pure DOM; subscribes to engine callbacks
// in app.js. See `notes/features/SCOPE-up-next.md` for the full spec.

import { icon, X, Play } from '../js/icons.js';
import { t } from '../js/i18n.js';

function _esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function basenameNoExt(path) {
  const base = String(path || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.[^/.]+$/, '');
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

export class UpNextCard {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element - The #up-next-card container.
   * @param {Object} [opts.library] - Library reference for getVideoByPath lookups.
   * @param {Function} [opts.captureFrame] - async (path) => { dataUrl } | null
   *        Used to lazy-load the thumbnail. Falls back to skeleton if omitted or fails.
   * @param {Function} [opts.onPlayNext] - User triggered play immediately.
   * @param {Function} [opts.onDismiss] - User dismissed via × or Esc.
   * @param {Function} [opts.onHoverEnter] - Card hovered/focused (engine pauses).
   * @param {Function} [opts.onHoverLeave] - Card unhovered/blurred (engine resumes).
   * @param {Function} [opts.onBackToSource] - End-of-list CTA clicked.
   */
  constructor({
    element,
    library,
    captureFrame,
    onPlayNext,
    onDismiss,
    onHoverEnter,
    onHoverLeave,
    onBackToSource,
  }) {
    this._el = element;
    this._library = library || null;
    this._captureFrame = captureFrame || null;
    this.onPlayNext = onPlayNext || null;
    this.onDismiss = onDismiss || null;
    this.onHoverEnter = onHoverEnter || null;
    this.onHoverLeave = onHoverLeave || null;
    this.onBackToSource = onBackToSource || null;

    this._countdownLabelEl = null;
    this._currentPath = null;
    this._currentSourceContext = null;
    // Mini-player mode: renders a minimal "Next video starts in Ns" strip and
    // suppresses hover-pause (the corner overlay is glanceable and the user's
    // pointer is usually over it — pausing there froze the countdown).
    this._mini = false;

    if (!this._el) return;

    // Card-level a11y: aria-live on the root so the countdown text
    // change is announced (polite — once, not on every tick).
    this._el.setAttribute('role', 'region');
    this._el.setAttribute('aria-label', t('upNext.regionAria'));
    this._el.setAttribute('aria-live', 'polite');

    // Hover / focus pause-resume — applied at the root so all child
    // events bubble up. Only meaningful when the countdown branch is
    // showing; the end-of-list branch ignores these via the engine.
    this._el.addEventListener('mouseenter', () => {
      if (this._mini) return; // glanceable — never pause on hover in mini
      if (this.onHoverEnter) this.onHoverEnter();
    });
    this._el.addEventListener('mouseleave', () => {
      if (this._mini) return;
      if (this.onHoverLeave) this.onHoverLeave();
    });
    this._el.addEventListener('focusin', () => {
      if (this._mini) return;
      if (this.onHoverEnter) this.onHoverEnter();
    });
    this._el.addEventListener('focusout', (e) => {
      if (this._mini) return;
      // Only resume when focus actually leaves the card subtree.
      if (this._el.contains(e.relatedTarget)) return;
      if (this.onHoverLeave) this.onHoverLeave();
    });
  }

  /** Toggle the compact mini-player rendering. Re-renders if a card is up. */
  setMini(on) {
    const next = !!on;
    if (next === this._mini) return;
    this._mini = next;
    // Re-render an already-visible countdown in the new form.
    if (this._el && !this._el.hidden && this._currentPath && !this._el.classList.contains('up-next--end-of-list')) {
      const secs = parseInt(this._countdownLabelEl?.textContent, 10);
      this.show(this._currentPath, Number.isFinite(secs) ? secs : 10);
    }
  }

  show(nextPath, countdownSec) {
    if (!this._el) return;
    this._currentPath = nextPath;
    this._el.classList.remove('up-next--end-of-list');
    this._el.hidden = false;

    // Mini-player: a single minimal line — "Next video starts in Ns" — no
    // thumbnail, body, or dismiss. Just enough to signal the auto-advance.
    if (this._mini) {
      this._el.innerHTML = `
        <div class="up-next__mini-text">${_esc(t('upNext.miniPrefix'))} <span class="up-next__countdown" aria-label="${_esc(t('upNext.secondsAria'))}">${countdownSec}</span>${_esc(t('upNext.labelSuffix'))}</div>
      `;
      this._countdownLabelEl = this._el.querySelector('.up-next__countdown');
      return;
    }

    const meta = this._resolveMeta(nextPath);

    this._el.innerHTML = `
      <div class="up-next__header">
        <span class="up-next__label">${t('upNext.labelPrefix')} <span class="up-next__countdown" aria-label="${_esc(t('upNext.secondsAria'))}">${countdownSec}</span> ${t('upNext.labelSuffix')}</span>
        <button type="button" class="up-next__dismiss" aria-label="${_esc(t('upNext.dismissAria'))}" title="${_esc(t('upNext.dismissTitle'))}">
        </button>
      </div>
      <div class="up-next__body" tabindex="0" role="button" aria-label="${_esc(t('upNext.playNextAria', { name: meta.name }))}">
        <div class="up-next__thumb">
          <div class="up-next__thumb-skeleton" aria-hidden="true"></div>
          <div class="up-next__thumb-play" aria-hidden="true">
            <span class="up-next__thumb-play-icon"></span>
          </div>
        </div>
        <div class="up-next__info">
          <div class="up-next__title" title="${_esc(meta.name)}">${_esc(meta.name)}</div>
          <div class="up-next__meta">
            ${meta.durationLabel ? `<span class="up-next__duration">${_esc(meta.durationLabel)}</span>` : ''}
            ${meta.hasFunscript ? `<span class="up-next__meta-chip">${_esc(t('upNext.funscriptChip'))}</span>` : ''}
          </div>
        </div>
      </div>
    `;

    // Mount Lucide icons after innerHTML reset.
    const dismissBtn = this._el.querySelector('.up-next__dismiss');
    dismissBtn.appendChild(icon(X, { width: 14, height: 14 }));
    const playIconHost = this._el.querySelector('.up-next__thumb-play-icon');
    playIconHost.appendChild(icon(Play, { width: 18, height: 18 }));

    this._countdownLabelEl = this._el.querySelector('.up-next__countdown');

    // Wire interactions.
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onDismiss) this.onDismiss();
    });
    const body = this._el.querySelector('.up-next__body');
    body.addEventListener('click', () => {
      if (this.onPlayNext) this.onPlayNext();
    });
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (this.onPlayNext) this.onPlayNext();
      }
    });

    // Lazy-load thumbnail (skeleton stays until then).
    this._loadThumbnail(nextPath);
  }

  showEndOfList(sourceLabel, sourceContext) {
    if (!this._el) return;
    this._currentSourceContext = sourceContext || {};
    this._el.classList.add('up-next--end-of-list');
    this._el.hidden = false;

    // Mini-player: just a compact end-of-list line, no CTA.
    if (this._mini) {
      this._el.innerHTML = `<div class="up-next__mini-text">${_esc(t('upNext.endLabel'))}</div>`;
      this._countdownLabelEl = null;
      return;
    }

    const safeSource = _esc(sourceLabel || t('upNext.endSourceFallback'));

    this._el.innerHTML = `
      <div class="up-next__header">
        <span class="up-next__label">${_esc(t('upNext.endLabel'))}</span>
        <button type="button" class="up-next__dismiss" aria-label="${_esc(t('upNext.endDismissAria'))}" title="${_esc(t('upNext.dismissTitle'))}">
        </button>
      </div>
      <div class="up-next__body">
        <div class="up-next__info">
          <div class="up-next__end-text">${_esc(t('upNext.endText', { source: sourceLabel || t('upNext.endSourceFallback') }))}</div>
          <button type="button" class="up-next__end-cta">${_esc(t('upNext.endCta', { source: sourceLabel || t('upNext.endSourceFallback') }))}</button>
        </div>
      </div>
    `;

    const dismissBtn = this._el.querySelector('.up-next__dismiss');
    dismissBtn.appendChild(icon(X, { width: 14, height: 14 }));
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onDismiss) this.onDismiss();
    });

    const cta = this._el.querySelector('.up-next__end-cta');
    cta.addEventListener('click', () => {
      if (this.onBackToSource) this.onBackToSource(this._currentSourceContext);
    });
  }

  tick(remainingSec) {
    if (this._countdownLabelEl) {
      this._countdownLabelEl.textContent = String(remainingSec);
    }
  }

  hide() {
    if (!this._el) return;
    this._el.hidden = true;
    this._el.innerHTML = '';
    this._countdownLabelEl = null;
    this._currentPath = null;
    this._currentSourceContext = null;
  }

  // --- Internal ---

  _resolveMeta(path) {
    const fallback = { name: basenameNoExt(path), durationLabel: '', hasFunscript: false };
    if (!this._library?.getVideoByPath) return fallback;
    const video = this._library.getVideoByPath(path);
    if (!video) return fallback;
    return {
      name: video.name || fallback.name,
      durationLabel: formatDuration(video.duration || 0),
      hasFunscript: !!video.hasFunscript,
    };
  }

  async _loadThumbnail(path) {
    if (!this._captureFrame) return;
    let result = null;
    try {
      result = await this._captureFrame(path);
    } catch {
      return;
    }
    const dataUrl = result?.dataUrl || result;
    this.setThumbnail(path, dataUrl);
  }

  /**
   * Paint a thumbnail into the currently-shown card. Public so an external
   * source can supply the frame (the player pop-out streams it from main
   * rather than re-capturing). Race-guarded against a stale / hidden card.
   */
  setThumbnail(path, dataUrl) {
    if (!this._el || this._el.hidden) return;
    if (this._currentPath !== path || !dataUrl) return;

    const thumb = this._el.querySelector('.up-next__thumb');
    if (!thumb || thumb.querySelector('.up-next__thumb-img')) return;
    const skeleton = thumb.querySelector('.up-next__thumb-skeleton');
    const img = document.createElement('img');
    img.className = 'up-next__thumb-img';
    img.src = dataUrl;
    img.alt = '';
    img.addEventListener('load', () => {
      if (skeleton) skeleton.remove();
    });
    thumb.insertBefore(img, thumb.firstChild);
  }
}
