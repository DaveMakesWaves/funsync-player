// QueuePanel — right-side slide-in showing playback context as 4 sections:
// History (session-bounded), Now playing, User queue (persistent, drag-
// reorderable), Up next (live-derived from playlist or library).
//
// See notes/features/SCOPE-queue-panel.md for the design contract.
//
// Single responsibility: render the panel + emit events. Data lives on
// the App class (history, user queue, upcoming derivation). Persistence
// lives on dataService. This component is purely a view + interaction
// surface.

import { icon, X, Trash2, GripVertical, ListVideo, FileCheck, Captions, Gauge, Layers2, Cable } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';

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
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

export class QueuePanel {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.element — root container (#queue-panel)
   * @param {Object} opts.library — library reference for getVideoByPath / capture
   * @param {Function} opts.onJump — (path) => void; play this video, current → history
   * @param {Function} opts.onRemoveFromQueue — (path) => void; remove from user queue
   * @param {Function} opts.onReorderQueue — (fromIdx, toIdx) => void
   * @param {Function} opts.onClearQueue — () => void
   * @param {Function} opts.onClose — () => void; user clicked × or pressed Esc
   * @param {Function} opts.onOpenLibrary — () => void; navigate to library
   */
  constructor({
    element,
    library,
    settings,
    getEmbeddedAxes,
    onJump,
    onRemoveFromQueue,
    onReorderQueue,
    onClearQueue,
    onClose,
    onOpenLibrary,
    onCancelAutoAdvance,
  }) {
    this._el = element;
    this._library = library || null;
    this._settings = settings || null;
    this._getEmbeddedAxes = getEmbeddedAxes || null;
    this.onJump = onJump || null;
    this.onRemoveFromQueue = onRemoveFromQueue || null;
    this.onReorderQueue = onReorderQueue || null;
    this.onClearQueue = onClearQueue || null;
    this.onClose = onClose || null;
    this.onOpenLibrary = onOpenLibrary || null;
    this.onCancelAutoAdvance = onCancelAutoAdvance || null;

    this._state = {
      history: [],
      nowPlaying: null,
      userQueue: [],
      upcoming: [],
      hasContext: false,
    };
    this._visible = false;
    this._dragSourceIdx = null;
    // Auto-advance countdown — sourced from UpNextEngine. When the
    // up-next card is hidden (because the queue panel is open), this
    // gives the user the same "in Ns" + cancel affordance, attached
    // to the actual row that will play next. Lightweight DOM updates
    // so the countdown ticks don't re-render the whole panel.
    this._autoAdvance = { path: null, seconds: 0 };

    if (!this._el) return;
    this._buildShell();

    // Re-render on locale change so section labels update without a
    // panel re-instantiation.
    eventBus.on('language:changed', () => this._render());
  }

  // --- Public API ---

  /** Show the panel (slide in). */
  open() {
    if (!this._el) return;
    this._visible = true;
    this._el.hidden = false;
    // Render with the latest state — setState() while hidden updates
    // the stored state but skips render, so we re-render here to pick
    // up everything that happened while the panel was closed.
    this._render();
    // Force reflow then add class for transition
    void this._el.offsetWidth;
    this._el.classList.add('queue-panel--open');
  }

  /** Hide the panel (slide out). History resets on close per SCOPE §3.5. */
  close() {
    if (!this._el) return;
    this._visible = false;
    this._el.classList.remove('queue-panel--open');
    // Hide after transition for accessibility (no focus into hidden content)
    setTimeout(() => {
      if (!this._visible) this._el.hidden = true;
    }, 220);
  }

  toggle() {
    if (this._visible) this.close();
    else this.open();
  }

  get visible() { return this._visible; }

  /**
   * Update the rendered state. Called by the app on every relevant
   * change (video load, library sort/filter change, user queue mutation,
   * etc.). Idempotent.
   *
   * @param {Object} state
   * @param {string[]} state.history — paths, oldest first
   * @param {string|null} state.nowPlaying — path or null
   * @param {string[]} state.userQueue — paths, ordered as the user
   *        wants them played (head plays next)
   * @param {string[]} state.upcoming — paths from playlist or library,
   *        head plays after user queue
   * @param {boolean} state.hasContext — false when no library / playlist
   *        is driving (drag-drop, Browse, Open Recent)
   */
  setState(state) {
    this._state = {
      history: Array.isArray(state.history) ? state.history : [],
      nowPlaying: state.nowPlaying || null,
      userQueue: Array.isArray(state.userQueue) ? state.userQueue : [],
      upcoming: Array.isArray(state.upcoming) ? state.upcoming : [],
      hasContext: !!state.hasContext,
    };
    if (this._visible) this._render();
  }

  /**
   * Mark a row as the auto-advance target and show its countdown chip.
   * Called by the app on UpNextEngine onShowNext / onTick.
   *
   * Initial assignment (path change) triggers a full re-render so the
   * chip enters with the row markup. Subsequent tick updates patch the
   * number in place — no re-render, no DOM churn during the countdown.
   */
  setAutoAdvanceCountdown(path, seconds) {
    const pathChanged = path !== this._autoAdvance.path;
    this._autoAdvance = { path: path || null, seconds: Number(seconds) || 0 };
    if (!this._visible) return;
    if (pathChanged) {
      this._render();
    } else {
      this._patchAutoAdvanceCount();
    }
  }

  /** Drop the auto-advance marker — UpNextEngine onHide. */
  clearAutoAdvance() {
    if (!this._autoAdvance.path) return;
    this._autoAdvance = { path: null, seconds: 0 };
    if (this._visible) this._render();
  }

  _patchAutoAdvanceCount() {
    const el = this._el?.querySelector('[data-queue-auto-count]');
    if (el) el.textContent = `${this._autoAdvance.seconds}s`;
  }

  // --- Internal ---

  _buildShell() {
    this._el.classList.add('queue-panel');
    this._el.setAttribute('role', 'complementary');
    this._el.setAttribute('aria-label', t('queuePanel.title'));
    this._el.hidden = true;
    this._render();
  }

  _render() {
    if (!this._el) return;
    const { history, nowPlaying, userQueue, upcoming, hasContext } = this._state;

    const sections = [];

    // History — only render if non-empty (SCOPE §3.7)
    if (history.length > 0) {
      sections.push(this._renderSection({
        label: t('queuePanel.sectionHistory'),
        items: history,
        kind: 'history',
      }));
    }

    // Now playing — only if something is actually playing
    if (nowPlaying) {
      sections.push(this._renderSection({
        label: t('queuePanel.sectionNowPlaying'),
        items: [nowPlaying],
        kind: 'now-playing',
      }));
    }

    // User queue — only if non-empty (SCOPE §3.7), with Clear action
    if (userQueue.length > 0) {
      sections.push(this._renderSection({
        label: t('queuePanel.sectionUserQueue'),
        items: userQueue,
        kind: 'user-queue',
        action: {
          label: t('queuePanel.clearQueue'),
          handler: () => this.onClearQueue?.(),
        },
      }));
    }

    // Upcoming — only if context exists and there are upcoming items
    if (hasContext && upcoming.length > 0) {
      sections.push(this._renderSection({
        label: t('queuePanel.sectionUpcoming'),
        items: upcoming,
        kind: 'upcoming',
      }));
    }

    // Body content — if no sections at all and no context, show empty state
    const body = (!hasContext && !nowPlaying && userQueue.length === 0)
      ? this._renderEmptyState()
      : (sections.length > 0
          ? `<div class="queue-panel__sections">${sections.join('')}</div>`
          : `<div class="queue-panel__empty"><p>${_esc(t('queuePanel.emptyEndOfList'))}</p></div>`);

    this._el.innerHTML = `
      <div class="queue-panel__header">
        <h2 class="queue-panel__title">${_esc(t('queuePanel.title'))}</h2>
        <button type="button" class="queue-panel__close" aria-label="${_esc(t('queuePanel.closeAria'))}" title="${_esc(t('queuePanel.closeAria'))}"></button>
      </div>
      <div class="queue-panel__body">
        ${body}
      </div>
    `;

    // Wire close button + mount X icon
    const closeBtn = this._el.querySelector('.queue-panel__close');
    if (closeBtn) {
      closeBtn.appendChild(icon(X, { width: 16, height: 16 }));
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onClose?.();
      });
    }

    // Wire section actions (currently just "Clear")
    for (const actionBtn of this._el.querySelectorAll('[data-queue-action="clear"]')) {
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onClearQueue?.();
      });
    }

    // Wire open-library button on empty state
    const openLibBtn = this._el.querySelector('[data-queue-action="open-library"]');
    if (openLibBtn) {
      openLibBtn.appendChild(icon(ListVideo, { width: 14, height: 14 }));
      openLibBtn.addEventListener('click', () => this.onOpenLibrary?.());
    }

    // Wire row click + remove + drag handles
    this._wireRows();
  }

  _renderEmptyState() {
    return `
      <div class="queue-panel__empty">
        <p>${_esc(t('queuePanel.emptyNoLibrary'))}</p>
        <button type="button" class="queue-panel__open-library" data-queue-action="open-library">
          <span>${_esc(t('queuePanel.openLibrary'))}</span>
        </button>
      </div>
    `;
  }

  _renderSection({ label, items, kind, action }) {
    const rows = items.map((path, idx) => this._renderRow(path, kind, idx)).join('');
    const actionMarkup = action
      ? `<button type="button" class="queue-panel__section-action" data-queue-action="clear">${_esc(action.label)}</button>`
      : '';
    return `
      <section class="queue-panel__section queue-panel__section--${kind}">
        <div class="queue-panel__section-head">
          <span class="queue-panel__section-label">${_esc(label)}</span>
          ${actionMarkup}
        </div>
        <ul class="queue-panel__list" role="list">${rows}</ul>
      </section>
    `;
  }

  _renderRow(path, kind, idx) {
    const meta = this._resolveMeta(path);
    const isUserQueue = kind === 'user-queue';
    const isNowPlaying = kind === 'now-playing';
    const isHistory = kind === 'history';

    const dragHandle = isUserQueue
      ? `<button type="button" class="queue-panel__drag-handle" aria-label="${_esc(t('queuePanel.dragHandleAria'))}" data-queue-drag-handle></button>`
      : '';
    const removeBtn = isUserQueue
      ? `<button type="button" class="queue-panel__remove" aria-label="${_esc(t('queuePanel.removeAria'))}" data-queue-remove></button>`
      : '';

    // Badges — mirror library card affordances. Color tokens reuse the
    // same --state-*/--badge-* vars so the icons read the same across
    // the library, the queue, and any future surface. Order matches the
    // library card sub-row: meta strip first (FS, subtitle, multi/custom),
    // then VR/category markers.
    const badgeBits = [];
    if (meta.hasFunscript) {
      const cls = meta.fsManual ? 'queue-panel__badge--fs-manual' : 'queue-panel__badge--fs-auto';
      badgeBits.push(`<span class="queue-panel__badge ${cls}" data-queue-badge="fs" title="${_esc(meta.fsManual ? t('library.funscriptManual') : t('library.funscriptAuto'))}"></span>`);
    }
    if (meta.hasSubtitle) {
      const cls = meta.subManual ? 'queue-panel__badge--sub-manual' : 'queue-panel__badge--sub-auto';
      badgeBits.push(`<span class="queue-panel__badge ${cls}" data-queue-badge="sub" title="${_esc(meta.subManual ? t('library.subtitlesManual') : t('library.subtitlesAuto'))}"></span>`);
    }
    if (meta.multiAxis) {
      badgeBits.push(`<span class="queue-panel__badge queue-panel__badge--multi" data-queue-badge="multi" title="${_esc(t('library.multiAxis'))}"></span>`);
    } else if (meta.customRouting) {
      badgeBits.push(`<span class="queue-panel__badge queue-panel__badge--custom" data-queue-badge="custom" title="${_esc(t('library.customRoutingTitle', { count: '' }))}"></span>`);
    }
    if (meta.vrOverride) {
      const txt = meta.vrOverride === 'vr' ? t('library.vrBadge') : t('library.flatBadge');
      badgeBits.push(`<span class="queue-panel__vr-pill queue-panel__vr-pill--${meta.vrOverride}">${_esc(txt)}</span>`);
    }
    if (meta.speedTier) {
      const title = meta.speedStats
        ? t('library.speedBadgeTitle', { avg: meta.speedStats.avg, max: meta.speedStats.max })
        : '';
      badgeBits.push(`<span class="queue-panel__badge queue-panel__badge--speed queue-panel__badge--speed-${meta.speedTier}" data-queue-badge="speed" title="${_esc(title)}"></span>`);
    }

    const categoryDots = meta.categories.length > 0
      ? `<div class="queue-panel__category-dots">${meta.categories
          .map((c) => `<span class="queue-panel__category-dot" style="background:${_esc(c.color)}" title="${_esc(c.name)}"></span>`)
          .join('')}</div>`
      : '';

    // Auto-advance countdown chip — only on the row UpNextEngine will
    // jump to next. Pill with live count + × to dismiss; click outside
    // the × still falls through to the row's normal jump-to handler.
    const isAutoAdvance = !!this._autoAdvance.path && path === this._autoAdvance.path;
    const autoAdvanceChip = isAutoAdvance
      ? `<button type="button" class="queue-panel__auto-chip" data-queue-auto-cancel
              aria-label="${_esc(t('queuePanel.cancelAutoAdvance') || 'Cancel auto-play')}"
              title="${_esc(t('queuePanel.cancelAutoAdvance') || 'Cancel auto-play')}">
           <span class="queue-panel__auto-count" data-queue-auto-count>${this._autoAdvance.seconds}s</span>
           <span class="queue-panel__auto-x" data-queue-auto-x aria-hidden="true"></span>
         </button>`
      : '';

    return `
      <li class="queue-panel__row queue-panel__row--${kind}${isNowPlaying ? ' queue-panel__row--current' : ''}${isHistory ? ' queue-panel__row--dim' : ''}${isAutoAdvance ? ' queue-panel__row--auto-advance' : ''}"
          data-queue-path="${_esc(path)}"
          data-queue-kind="${kind}"
          data-queue-idx="${idx}"
          ${isUserQueue ? 'draggable="true"' : ''}
          role="listitem"
          tabindex="0">
        ${dragHandle}
        <div class="queue-panel__thumb" data-queue-thumb>
          <div class="queue-panel__thumb-skel" aria-hidden="true"></div>
          ${categoryDots}
        </div>
        <div class="queue-panel__meta">
          <div class="queue-panel__title-row" title="${_esc(meta.name)}">${_esc(meta.name)}</div>
          <div class="queue-panel__sub-row">
            ${meta.durationLabel ? `<span class="queue-panel__duration">${_esc(meta.durationLabel)}</span>` : ''}
            ${badgeBits.join('')}
            ${autoAdvanceChip}
          </div>
        </div>
        ${removeBtn}
      </li>
    `;
  }

  _wireRows() {
    const rows = this._el.querySelectorAll('.queue-panel__row');
    rows.forEach((row) => {
      const path = row.dataset.queuePath;
      const kind = row.dataset.queueKind;

      // Click to jump (excluding clicks on remove + drag handle)
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-queue-remove], [data-queue-drag-handle]')) return;
        this.onJump?.(path);
      });

      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onJump?.(path);
        }
      });

      // Remove button (user-queue only)
      const removeBtn = row.querySelector('[data-queue-remove]');
      if (removeBtn) {
        removeBtn.appendChild(icon(X, { width: 12, height: 12 }));
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onRemoveFromQueue?.(path);
        });
      }

      // Drag handle visual (user-queue only)
      const dragHandle = row.querySelector('[data-queue-drag-handle]');
      if (dragHandle) {
        dragHandle.appendChild(icon(GripVertical, { width: 14, height: 14 }));
      }

      // Mount badge icons. Each mirrors its library-card counterpart —
      // same Lucide glyph + same stroke weight so the indicators read
      // identically across surfaces.
      const badgeIconMap = {
        fs: FileCheck,
        sub: Captions,
        multi: Layers2,
        custom: Cable,
        speed: Gauge,
      };
      row.querySelectorAll('[data-queue-badge]').forEach((badge) => {
        const kind = badge.getAttribute('data-queue-badge');
        const Icon = badgeIconMap[kind];
        if (Icon) badge.appendChild(icon(Icon, { width: 12, height: 12, 'stroke-width': 2.5 }));
      });

      // Auto-advance chip — × icon + click cancels the countdown.
      const autoChip = row.querySelector('[data-queue-auto-cancel]');
      if (autoChip) {
        const xSlot = autoChip.querySelector('[data-queue-auto-x]');
        if (xSlot) xSlot.appendChild(icon(X, { width: 11, height: 11, 'stroke-width': 2.5 }));
        autoChip.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onCancelAutoAdvance?.();
        });
      }

      // Drag-to-reorder (user-queue only)
      if (kind === 'user-queue') {
        row.addEventListener('dragstart', (e) => {
          this._dragSourceIdx = parseInt(row.dataset.queueIdx, 10);
          row.classList.add('queue-panel__row--dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            // Required for Firefox to start the drag
            e.dataTransfer.setData('text/plain', path);
          }
        });
        row.addEventListener('dragover', (e) => {
          // Only accept reorder within the user-queue section
          if (this._dragSourceIdx === null) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          row.classList.add('queue-panel__row--drop-target');
        });
        row.addEventListener('dragleave', () => {
          row.classList.remove('queue-panel__row--drop-target');
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('queue-panel__row--drop-target');
          if (this._dragSourceIdx === null) return;
          const toIdx = parseInt(row.dataset.queueIdx, 10);
          if (toIdx !== this._dragSourceIdx) {
            this.onReorderQueue?.(this._dragSourceIdx, toIdx);
          }
          this._dragSourceIdx = null;
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('queue-panel__row--dragging');
          this._dragSourceIdx = null;
        });
      }

      // Lazy thumbnail
      this._loadThumbnail(row, path);
    });

    // Clear remove icon mount in section-action button (Clear)
    const clearBtn = this._el.querySelector('[data-queue-action="clear"]');
    if (clearBtn && !clearBtn.querySelector('svg')) {
      // Section action is text-only per the SCOPE — no icon, keeps the
      // tap target light. Left here for future iteration.
    }
  }

  _resolveMeta(path) {
    const fallback = {
      name: basenameNoExt(path),
      durationLabel: '',
      hasFunscript: false,
      fsManual: false,
      hasSubtitle: false,
      subManual: false,
      vrOverride: null,
      multiAxis: false,
      customRouting: false,
      speedTier: null,
      speedStats: null,
      categories: [],
    };
    if (!this._library?.getVideoByPath) return fallback;
    const video = this._library.getVideoByPath(path);
    if (!video) return fallback;

    // VR override and category dots live in settings (same source the
    // library card uses — see library.js _createVideoCard).
    let vrOverride = null;
    let categories = [];
    if (this._settings) {
      const vrMap = this._settings.get?.('library.manualVRType') || {};
      const v = vrMap[path];
      if (v === 'vr' || v === 'flat') vrOverride = v;
      const catIds = this._settings.getVideoCategories?.(path) || [];
      const allCats = this._settings.getCategories?.() || [];
      categories = catIds
        .map((id) => allCats.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, color: c.color }));
    }

    // Multi-axis detection mirrors library._addPlaybackModeBadge logic:
    // explicit _multiAxis > _customRouting > embedded-axis fallback.
    let multiAxis = false;
    let customRouting = false;
    if (video._multiAxis) multiAxis = true;
    else if (Array.isArray(video._customRouting) && video._customRouting.length > 0) customRouting = true;
    else if (video.funscriptPath && this._getEmbeddedAxes) {
      const embedded = this._getEmbeddedAxes(video.funscriptPath);
      if (embedded?.suffixes?.length > 0) multiAxis = true;
    }

    // Speed tier — same thresholds as library._addSpeedBadge.
    let speedTier = null;
    if (video.maxSpeed && video.avgSpeed > 0) {
      if (video.avgSpeed >= 450) speedTier = 'insane';
      else if (video.avgSpeed >= 350) speedTier = 'extreme';
      else if (video.avgSpeed >= 250) speedTier = 'fast';
      else if (video.avgSpeed >= 150) speedTier = 'medium';
      else speedTier = 'slow';
    }

    return {
      name: video.name || fallback.name,
      durationLabel: formatDuration(video.duration || 0),
      hasFunscript: !!video.hasFunscript,
      fsManual: !!video._manualAssociation,
      hasSubtitle: !!video.hasSubtitle,
      subManual: !!video._manualSubtitle,
      vrOverride,
      multiAxis,
      customRouting,
      speedTier,
      speedStats: speedTier ? { avg: video.avgSpeed, max: video.maxSpeed } : null,
      categories,
    };
  }

  async _loadThumbnail(row, path) {
    const thumb = row.querySelector('[data-queue-thumb]');
    if (!thumb) return;
    // Use the existing in-memory thumbnail cache first.
    try {
      const mod = await import('../js/thumbnail-cache.js');
      const cached = mod.get(path, 0);
      if (cached) {
        this._applyThumb(thumb, cached);
        return;
      }
    } catch { /* cache miss */ }
    // Fall back to library's capture helper if available.
    if (this._library?._captureVideoFrame) {
      try {
        const result = await this._library._captureVideoFrame(path);
        if (result?.dataUrl) this._applyThumb(thumb, result.dataUrl);
      } catch { /* missing file / cross-origin / etc — leave skeleton */ }
    }
  }

  _applyThumb(thumb, dataUrl) {
    if (!thumb) return;
    const skeleton = thumb.querySelector('.queue-panel__thumb-skel');
    const img = document.createElement('img');
    img.className = 'queue-panel__thumb-img';
    img.src = dataUrl;
    img.alt = '';
    img.addEventListener('load', () => {
      if (skeleton) skeleton.remove();
    });
    thumb.insertBefore(img, thumb.firstChild);
  }
}
