// Playlists — Grid view of playlists with detail view for individual playlist

import { Modal } from './modal.js';
import { icon, Play, Plus, Pencil, Trash2, ArrowLeft, X, Clapperboard, FileX, FileCheck, Gauge, LayoutGrid, LayoutList, Repeat, Shuffle, GripVertical, ChevronUp, ChevronDown } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { computeSpeedStats } from '../js/library-search.js';
import { computeBins, renderBins } from '../js/heatmap-strip.js';
import { normalizeAssociation, resolveActiveConfig } from '../js/association-shape.js';
import { pathToFileURL } from '../js/path-utils.js';

export class Playlists {
  constructor({ settings, onPlayVideo, onPlayAll, library }) {
    this._settings = settings;
    this._onPlayVideo = onPlayVideo;
    this._onPlayAll = onPlayAll;
    this._library = library || null;
    this._container = null;
    this._view = 'grid'; // 'grid' or 'detail'
    this._detailPlaylistId = null;
    this._viewMode = 'grid'; // 'grid' or 'list'
    this._binsByPath = new Map();
  }

  show(containerEl) {
    this._container = containerEl;
    // Re-render on locale change — most strings are baked via t() into
    // innerHTML at render time, so translatePage() alone doesn't catch
    // them (kebab tooltips, empty-state, Play All label, etc.).
    if (!this._languageListenerAttached) {
      eventBus.on('language:changed', () => {
        if (!this._container) return;
        if (this._view === 'detail' && this._detailPlaylistId) {
          this._renderDetail(this._detailPlaylistId);
        } else {
          this._renderGrid();
        }
      });
      this._languageListenerAttached = true;
    }
    if (this._view === 'detail' && this._detailPlaylistId) {
      this._renderDetail(this._detailPlaylistId);
    } else {
      this._view = 'grid';
      this._renderGrid();
    }
  }

  hide() {
    if (this._container) {
      this._container.innerHTML = '';
    }
  }

  /** Returns true if handled internally (detail → grid), false if app should pop nav stack. */
  navigateBack() {
    if (this._view === 'detail') {
      this._view = 'grid';
      this._detailPlaylistId = null;
      this._renderGrid();
      return true;
    }
    return false;
  }

  _renderGrid() {
    const playlists = this._settings.getPlaylists();
    this._container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'playlists__header';
    header.innerHTML = `<span class="playlists__title">${t('playlists.title')}</span>`;

    this._addViewToggle(header);
    this._container.appendChild(header);

    const wrapper = document.createElement('div');
    wrapper.className = 'playlists__grid-wrapper';

    if (playlists.length === 0) {
      wrapper.innerHTML = `
        <div class="playlists__empty">
          <div class="playlists__empty-icon"></div>
          <div class="playlists__empty-text">${t('playlists.emptyTitle')}</div>
          <button class="playlists__empty-cta">${t('playlists.emptyCta')}</button>
        </div>
      `;
      wrapper.querySelector('.playlists__empty-icon')
        .appendChild(icon(Play, { width: 48, height: 48 }));
      wrapper.querySelector('.playlists__empty-cta')
        .addEventListener('click', () => this._createPlaylist());
      this._container.appendChild(wrapper);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'playlists__grid';
    grid.classList.toggle('playlists__grid--list', this._viewMode === 'list');

    // Playlist cards
    for (const pl of playlists) {
      const card = this._viewMode === 'list' ? this._createPlaylistListItem(pl) : this._createPlaylistCard(pl);
      grid.appendChild(card);
    }

    // Create new card (dashed)
    const createCard = document.createElement('div');
    createCard.className = 'playlists__card playlists__card--create';
    createCard.innerHTML = `
      <div class="playlists__card-create-icon"></div>
      <div class="playlists__card-create-label">${t('playlists.newPlaylist')}</div>
    `;
    createCard.querySelector('.playlists__card-create-icon')
      .appendChild(icon(Plus, { width: 28, height: 28 }));
    createCard.addEventListener('click', () => this._createPlaylist());
    grid.appendChild(createCard);

    wrapper.appendChild(grid);
    this._container.appendChild(wrapper);
  }

  _createPlaylistCard(pl) {
    const card = document.createElement('div');
    card.className = 'playlists__card';

    const body = document.createElement('div');
    body.className = 'playlists__card-body';

    const name = document.createElement('div');
    name.className = 'playlists__card-name';
    name.textContent = pl.name;

    const count = document.createElement('div');
    count.className = 'playlists__card-count';
    count.textContent = `${pl.videoPaths.length} video${pl.videoPaths.length !== 1 ? 's' : ''}`;

    body.appendChild(name);
    body.appendChild(count);

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'playlists__card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'playlists__card-action-btn';
    renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
    renameBtn.title = t('common.rename');
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._renamePlaylist(pl);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'playlists__card-action-btn playlists__card-action-btn--danger';
    deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
    deleteBtn.title = t('common.delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._deletePlaylist(pl);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    body.appendChild(actions);

    card.appendChild(body);

    card.addEventListener('click', () => {
      this._view = 'detail';
      this._detailPlaylistId = pl.id;
      this._renderDetail(pl.id);
    });

    return card;
  }

  async _renderDetail(playlistId) {
    const pl = this._settings.getPlaylist(playlistId);
    if (!pl) {
      this._view = 'grid';
      this._renderGrid();
      return;
    }

    this._container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'playlists__header';

    const backBtn = document.createElement('button');
    backBtn.className = 'playlists__back-btn';
    backBtn.appendChild(icon(ArrowLeft, { width: 20, height: 20 }));
    backBtn.title = t('playlists.backToPlaylists');
    backBtn.addEventListener('click', () => this.navigateBack());

    const title = document.createElement('span');
    title.className = 'playlists__title';
    title.textContent = pl.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'playlists__detail-count';
    countSpan.textContent = `${pl.videoPaths.length} video${pl.videoPaths.length !== 1 ? 's' : ''}`;

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(countSpan);

    if (pl.videoPaths.length > 0) {
      const playAllBtn = document.createElement('button');
      playAllBtn.className = 'playlists__play-all-btn';
      playAllBtn.appendChild(icon(Play, { width: 14, height: 14 }));
      playAllBtn.appendChild(document.createTextNode(' ' + t('playlists.playAll')));
      playAllBtn.addEventListener('click', () => this._playAll(pl));
      header.appendChild(playAllBtn);

      // Loop toggle — adjacent to Play All because it's a "play
      // behaviour modifier" (Norman conceptual model: a control next
      // to the thing it modifies). Pressed state = aria-pressed AND
      // the .is-on class for the visual checkmark glow. State persists
      // to the playlist itself (per-playlist preference) so users can
      // mark certain playlists as marathon loops without affecting
      // every other Play All they ever run.
      const loopBtn = document.createElement('button');
      loopBtn.type = 'button';
      loopBtn.className = 'playlists__loop-btn';
      loopBtn.appendChild(icon(Repeat, { width: 14, height: 14 }));
      const setLoopVisualState = (on) => {
        loopBtn.classList.toggle('is-on', !!on);
        loopBtn.setAttribute('aria-pressed', String(!!on));
        loopBtn.title = on
          ? t('playlists.loopOnTitle')
          : t('playlists.loopOffTitle');
        loopBtn.setAttribute('aria-label', loopBtn.title);
      };
      setLoopVisualState(!!pl.loop);
      loopBtn.addEventListener('click', () => {
        const next = !pl.loop;
        pl.loop = next;
        this._settings.setPlaylistLoop(pl.id, next);
        setLoopVisualState(next);
      });
      header.appendChild(loopBtn);

      // Shuffle toggle — grouped with Loop (both are play-behaviour
      // modifiers; users expect them adjacent). Per-playlist preference,
      // same persist + aria-pressed + .is-on pattern as Loop. Active state
      // must be obvious (Nielsen #1) — accent fill via .is-on + tooltip
      // naming the state. Shuffle order is decided at Play All time (bag
      // model: shuffle once, reshuffle on loop wrap) — see app._playAll.
      const shuffleBtn = document.createElement('button');
      shuffleBtn.type = 'button';
      shuffleBtn.className = 'playlists__loop-btn playlists__shuffle-btn';
      shuffleBtn.appendChild(icon(Shuffle, { width: 14, height: 14 }));
      const setShuffleVisualState = (on) => {
        shuffleBtn.classList.toggle('is-on', !!on);
        shuffleBtn.setAttribute('aria-pressed', String(!!on));
        shuffleBtn.title = on
          ? t('playlists.shuffleOnTitle')
          : t('playlists.shuffleOffTitle');
        shuffleBtn.setAttribute('aria-label', shuffleBtn.title);
      };
      setShuffleVisualState(!!pl.shuffle);
      shuffleBtn.addEventListener('click', () => {
        const next = !pl.shuffle;
        pl.shuffle = next;
        this._settings.setPlaylistShuffle(pl.id, next);
        setShuffleVisualState(next);
      });
      header.appendChild(shuffleBtn);
    }

    this._addViewToggle(header);
    this._container.appendChild(header);

    // Video grid
    const wrapper = document.createElement('div');
    wrapper.className = 'playlists__grid-wrapper';

    // Filter out videos that no longer exist on disk
    const validPaths = [];
    for (const vp of pl.videoPaths) {
      const exists = await window.funsync.fileExists(vp);
      if (exists) validPaths.push(vp);
    }

    // Clean up dead paths from the playlist data
    if (validPaths.length < pl.videoPaths.length) {
      for (const dead of pl.videoPaths.filter(p => !validPaths.includes(p))) {
        this._settings.removeVideoFromPlaylist(pl.id, dead);
      }
    }

    if (validPaths.length === 0) {
      wrapper.innerHTML = `
        <div class="playlists__empty">
          <div class="playlists__empty-text">${t('playlists.detailEmpty')}</div>
          <div class="playlists__empty-hint">${t('playlists.detailEmptyHint')}</div>
        </div>
      `;
      this._container.appendChild(wrapper);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'playlists__grid';
    grid.classList.toggle('playlists__grid--list', this._viewMode === 'list');

    for (const videoPath of validPaths) {
      const playContext = {
        source: 'playlist',
        sourceLabel: `playlist "${pl.name}"`,
        sourceContext: { playlistId: pl.id },
        list: validPaths.slice(),
        index: validPaths.indexOf(videoPath),
      };
      const el = this._viewMode === 'list'
        ? this._createVideoListItem(videoPath, pl, playContext)
        : this._createVideoCard(videoPath, pl, playContext);
      grid.appendChild(el);
    }

    wrapper.appendChild(grid);

    // Visually-hidden polite live region — announces reorder moves to screen
    // readers (native HTML5 DnD is silent to them). SCOPE §7 / WCAG.
    const live = document.createElement('div');
    live.className = 'playlists__sr-only';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    wrapper.appendChild(live);
    this._reorderLive = live;

    this._container.appendChild(wrapper);
  }

  /** Announce a reorder to the aria-live region (screen-reader feedback). */
  _announceReorder(name, pos, total) {
    if (this._reorderLive) {
      this._reorderLive.textContent = t('playlists.reorderAnnounce', { name, pos, total });
    }
  }

  /** Persist the playlist's order from the current DOM row order (no re-render). */
  _persistOrderFromDom(grid, playlistId) {
    const order = [...grid.children]
      .map((r) => r.dataset.videoPath)
      .filter(Boolean);
    if (order.length) this._settings.setPlaylistVideoPaths(playlistId, order);
  }

  /**
   * Move a list-item row up (-1) or down (+1) in the DOM, persist the new
   * order, and announce it. No-op at the edges. Doesn't re-render, so focus
   * stays on the move button (keyboard reorder stays fluid) and heatmaps
   * aren't re-read. Single-pointer + keyboard path (WCAG 2.5.7).
   */
  _moveRow(row, dir, playlistId) {
    const grid = row.parentElement;
    if (!grid) return;
    if (dir < 0 && row.previousElementSibling) {
      grid.insertBefore(row, row.previousElementSibling);
    } else if (dir > 0 && row.nextElementSibling) {
      grid.insertBefore(row.nextElementSibling, row);
    } else {
      return; // already at the edge
    }
    this._persistOrderFromDom(grid, playlistId);
    const name = (row.dataset.videoName || '').trim();
    const pos = [...grid.children].indexOf(row) + 1;
    this._announceReorder(name, pos, grid.children.length);
  }

  _createVideoCard(videoPath, playlist, playContext) {
    const card = document.createElement('div');
    card.className = 'playlists__video-card';

    const thumbnail = document.createElement('div');
    thumbnail.className = 'playlists__video-thumbnail';

    const placeholder = document.createElement('div');
    placeholder.className = 'playlists__video-placeholder';
    placeholder.appendChild(icon(Clapperboard, { width: 32, height: 32 }));
    thumbnail.appendChild(placeholder);

    // Play overlay
    const overlay = document.createElement('div');
    overlay.className = 'playlists__video-overlay';
    const playIconEl = document.createElement('span');
    playIconEl.className = 'playlists__video-play-icon';
    playIconEl.appendChild(icon(Play, { width: 36, height: 36 }));
    overlay.appendChild(playIconEl);
    thumbnail.appendChild(overlay);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'playlists__video-remove-btn';
    removeBtn.appendChild(icon(X, { width: 12, height: 12 }));
    removeBtn.title = t('playlists.removeFromPlaylist');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.removeVideoFromPlaylist(playlist.id, videoPath);
      this._renderDetail(playlist.id);
    });
    thumbnail.appendChild(removeBtn);

    card.appendChild(thumbnail);

    const info = document.createElement('div');
    info.className = 'playlists__video-info';
    const name = videoPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
    const titleEl = document.createElement('div');
    titleEl.className = 'playlists__video-title';
    titleEl.textContent = name;
    titleEl.title = videoPath;
    info.appendChild(titleEl);
    card.appendChild(info);

    // Lazy-load thumbnail
    this._loadVideoThumbnail(card, thumbnail, videoPath);

    // Check for funscript and show badge
    this._checkFunscriptBadge(card, thumbnail, videoPath);

    card.addEventListener('click', () => {
      if (card.classList.contains('playlists__video-card--broken')) return;
      this._playVideoByPath(videoPath, playContext);
    });

    return card;
  }

  async _playVideoByPath(videoPath, playContext) {
    const fileName = videoPath.split(/[\\/]/).pop();
    const fileData = { name: fileName, path: videoPath, _isPathBased: true };
    if (playContext) fileData._playContext = playContext;

    // Prefer the library's full video record when available — that's
    // where `_multiAxis` and `_customRouting` live for videos with
    // explicit (or auto-promoted) associations. Falling back to the
    // path-only resolution covers playlist items whose source has been
    // removed since the entry was added.
    const libVideo = this._library?.getVideoByPath?.(videoPath);
    const fsPath = (libVideo?.hasFunscript && libVideo.funscriptPath)
      ? libVideo.funscriptPath
      : this._getFunscriptPath(videoPath);

    const isExplicit = this._hasExplicitAssociation(videoPath);
    let funscriptData = null;
    let readFailed = false;
    try {
      const content = await window.funsync.readFunscript(fsPath);
      if (content) {
        funscriptData = { name: fsPath.split(/[\\/]/).pop(), textContent: content };
        if (libVideo?._multiAxis) funscriptData._multiAxis = libVideo._multiAxis;
        if (libVideo?._customRouting) funscriptData._customRouting = libVideo._customRouting;
      } else if (isExplicit) {
        readFailed = true;
      }
    } catch {
      if (isExplicit) readFailed = true;
    }
    // Vib-only / no-main fallthrough — mirrors library._playVideo so
    // multi-axis and custom-routing setups work even when the main file
    // can't be read.
    if (!funscriptData && libVideo?._multiAxis) {
      funscriptData = { name: '', textContent: null, _multiAxis: libVideo._multiAxis };
    }
    if (!funscriptData && libVideo?._customRouting) {
      funscriptData = { name: '', textContent: null, _customRouting: libVideo._customRouting };
    }
    if (readFailed) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.funscriptUnreadable', { name: fileName }), 'warn', 4000);
    }
    this._onPlayVideo(fileData, funscriptData);
  }

  async _loadVideoThumbnail(cardEl, thumbnailEl, videoPath) {
    try {
      const result = await this._captureFrame(videoPath);
      const dataUrl = result?.dataUrl || result;
      if (!dataUrl) {
        this._showBrokenLink(cardEl, thumbnailEl, videoPath);
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.src = dataUrl;
      img.addEventListener('load', () => {
        const ph = thumbnailEl.querySelector('.playlists__video-placeholder');
        if (ph) ph.remove();
      });
      thumbnailEl.insertBefore(img, thumbnailEl.firstChild);

      // Duration badge
      if (result?.duration) {
        this._addDurationBadge(thumbnailEl, result.duration);
      }
    } catch {
      this._showBrokenLink(cardEl, thumbnailEl, videoPath);
    }
  }

  _showBrokenLink(cardEl, thumbnailEl, videoPath) {
    const placeholder = thumbnailEl.querySelector('.playlists__video-placeholder');
    if (placeholder) {
      placeholder.innerHTML = '';
      placeholder.appendChild(icon(FileX, { width: 32, height: 32 }));
      placeholder.classList.add('playlists__video-placeholder--broken');
    }
    cardEl.classList.add('playlists__video-card--broken');
    cardEl.title = t('library.fileNotFound', { path: videoPath });
  }

  /**
   * Get a single representative frame for a card. Routes through the
   * backend's ffmpeg by default — much cheaper than the renderer's old
   * hidden-<video> decode. Falls back to in-renderer decode if the
   * backend isn't reachable. Mirrors the same change in library.js.
   */
  async _captureFrame(videoPath) {
    if (window.funsync?.generateSingleThumbnail) {
      try {
        const result = await window.funsync.generateSingleThumbnail(videoPath, { seekPct: 0.1, width: 320 });
        if (result?.dataUrl) return { dataUrl: result.dataUrl, duration: result.duration || 0 };
      } catch { /* fall through */ }
    }
    return this._captureFrameViaVideoElement(videoPath);
  }

  _captureFrameViaVideoElement(videoPath) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.style.position = 'fixed';
      video.style.left = '-9999px';
      video.style.width = '1px';
      video.style.height = '1px';
      document.body.appendChild(video);

      const cleanup = () => {
        video.removeAttribute('src');
        video.load();
        video.remove();
      };

      const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);

      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(video.duration * 0.1, 5);
      }, { once: true });

      video.addEventListener('seeked', () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = Math.round(320 * (video.videoHeight / video.videoWidth)) || 180;
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          const duration = isFinite(video.duration) ? video.duration : 0;
          cleanup();
          resolve({ dataUrl, duration });
        } catch { cleanup(); resolve(null); }
      }, { once: true });

      video.addEventListener('error', () => { clearTimeout(timeout); cleanup(); resolve(null); }, { once: true });
      video.src = pathToFileURL(videoPath);
    });
  }

  _addDurationBadge(thumbnailEl, durationSec) {
    if (!thumbnailEl || thumbnailEl.querySelector('.library__duration-badge')) return;
    if (!durationSec || durationSec <= 0) return;
    const badge = document.createElement('span');
    badge.className = 'library__duration-badge';
    badge.textContent = this._formatDuration(durationSec);
    thumbnailEl.appendChild(badge);
  }

  _formatDuration(sec) {
    const totalSec = Math.floor(sec);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async _createPlaylist() {
    const name = await Modal.prompt(t('playlists.newPlaylist'), t('playlists.playlistNamePlaceholder'));
    if (!name) return;
    await this._settings.addPlaylist(name);
    this._renderGrid();
  }

  async _renamePlaylist(pl) {
    const name = await Modal.prompt(t('playlists.renamePlaylist'), t('playlists.playlistNamePlaceholder'), pl.name);
    if (!name) return;
    this._settings.renamePlaylist(pl.id, name);
    this._renderGrid();
  }

  async _deletePlaylist(pl) {
    const confirmed = await Modal.confirm(t('playlists.deletePlaylist'), t('playlists.confirmDelete'));
    if (!confirmed) return;
    this._settings.deletePlaylist(pl.id);
    this._renderGrid();
  }

  async _checkFunscriptBadge(cardEl, thumbnailEl, videoPath) {
    const fsPath = this._getFunscriptPath(videoPath);
    try {
      const content = await window.funsync.readFunscript(fsPath);
      if (!content) return;

      // Funscript icon badge on thumbnail
      const badge = document.createElement('span');
      badge.className = 'library__funscript-badge library__funscript-badge--auto';
      badge.title = t('playlists.funscriptLinked');
      badge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
      thumbnailEl.appendChild(badge);

      // Speed gauge badge on info bar
      try {
        const parsed = JSON.parse(content);
        const actions = parsed?.actions;
        if (actions && actions.length >= 2) {
          const stats = computeSpeedStats(actions);
          if (stats.maxSpeed > 0) {
            const info = cardEl.querySelector('.playlists__video-info');
            if (info) this._addSpeedBadge(info, stats);
          }
        }
      } catch { /* parse error */ }
    } catch { /* no funscript */ }
  }

  _addSpeedBadge(containerEl, stats) {
    if (!containerEl || containerEl.querySelector('.library__speed-badge')) return;

    let colorClass;
    if (stats.avgSpeed >= 450) colorClass = 'library__speed-badge--insane';
    else if (stats.avgSpeed >= 350) colorClass = 'library__speed-badge--extreme';
    else if (stats.avgSpeed >= 250) colorClass = 'library__speed-badge--fast';
    else if (stats.avgSpeed >= 150) colorClass = 'library__speed-badge--medium';
    else colorClass = 'library__speed-badge--slow';

    const speedBadge = document.createElement('span');
    speedBadge.className = `library__speed-badge ${colorClass}`;
    speedBadge.title = t('library.speedBadgeTitle', { avg: stats.avgSpeed, max: stats.maxSpeed });
    speedBadge.appendChild(icon(Gauge, { width: 12, height: 12, 'stroke-width': 2.5 }));
    containerEl.appendChild(speedBadge);
  }

  _getFunscriptPath(videoPath) {
    // Library scan is the source of truth — it holds scanner-normalized
    // auto-detects (e.g. "Foo (Part B).mp4" → "Foo (Part B).funscript") AND
    // already-applied manual associations. Naive extension swap misses
    // normalized matches, so try library first.
    const libVideo = this._library?.getVideoByPath(videoPath);
    if (libVideo?.funscriptPath) return libVideo.funscriptPath;

    const associations = this._settings.get('library.associations') || {};
    const resolved = resolveActiveConfig(normalizeAssociation(associations[videoPath]));
    if (resolved) {
      if (resolved.kind === 'single') return resolved.config;
      if (resolved.kind === 'multi' && resolved.config.main) return resolved.config.main;
      if (resolved.kind === 'custom') {
        const mainRoute = (resolved.config.routes || []).find(r => r.role === 'main');
        if (mainRoute?.scriptPath) return mainRoute.scriptPath;
      }
    }
    // Basename fallback — swap extension to .funscript
    return videoPath.replace(/\.[^/.]+$/, '.funscript');
  }

  /**
   * Does this video have a user-set (or auto-detected) association that
   * resolves to a real script path? Used to distinguish "script path was
   * expected and failed to read" from "no script was ever configured" —
   * only the former is a failure worth surfacing.
   */
  _hasExplicitAssociation(videoPath) {
    // Auto-detected scripts live on the library's scanned video record.
    const libVideo = this._library?.getVideoByPath(videoPath);
    if (libVideo?.funscriptPath) return true;

    const associations = this._settings.get('library.associations') || {};
    const resolved = resolveActiveConfig(normalizeAssociation(associations[videoPath]));
    if (!resolved) return false;
    if (resolved.kind === 'single') return !!resolved.config;
    if (resolved.kind === 'multi') return !!resolved.config.main;
    if (resolved.kind === 'custom') {
      return (resolved.config.routes || []).some(r => r.role === 'main' && r.scriptPath);
    }
    return false;
  }

  async _playAll(pl) {
    // Filter out broken/missing files before building queue
    const validPaths = [];
    for (const p of pl.videoPaths) {
      const exists = await window.funsync.fileExists(p);
      if (exists) validPaths.push(p);
    }

    if (validPaths.length === 0) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.playlistNoPlayable'), 'warn');
      return;
    }

    const videoList = validPaths.map((p) => {
      const name = p.split(/[\\/]/).pop();
      const funscriptPath = this._getFunscriptPath(p);
      return { name, path: p, funscriptPath };
    });
    this._onPlayAll(videoList, {
      sourceLabel: pl.name,
      sourceContext: { kind: 'playlist', id: pl.id },
      loop: !!pl.loop,
      shuffle: !!pl.shuffle,
    });
  }

  // --- View toggle ---

  _addViewToggle(header) {
    const group = document.createElement('div');
    group.className = 'view-toggle-group';

    const btnGrid = document.createElement('button');
    btnGrid.className = 'view-toggle view-toggle--grid';
    btnGrid.title = t('playlists.gridView');
    btnGrid.appendChild(icon(LayoutGrid, { width: 16, height: 16 }));
    btnGrid.classList.toggle('view-toggle--active', this._viewMode === 'grid');
    btnGrid.addEventListener('click', () => this._setViewMode('grid'));

    const btnList = document.createElement('button');
    btnList.className = 'view-toggle view-toggle--list';
    btnList.title = t('playlists.listView');
    btnList.appendChild(icon(LayoutList, { width: 16, height: 16 }));
    btnList.classList.toggle('view-toggle--active', this._viewMode === 'list');
    btnList.addEventListener('click', () => this._setViewMode('list'));

    group.append(btnGrid, btnList);
    header.appendChild(group);
  }

  _setViewMode(mode) {
    if (this._viewMode === mode) return;
    this._viewMode = mode;
    // Re-render current view
    if (this._view === 'detail' && this._detailPlaylistId) {
      this._renderDetail(this._detailPlaylistId);
    } else {
      this._renderGrid();
    }
  }

  _createPlaylistListItem(pl) {
    const row = document.createElement('div');
    row.className = 'playlists__list-item';

    const name = document.createElement('span');
    name.className = 'playlists__list-name';
    name.textContent = pl.name;

    const count = document.createElement('span');
    count.className = 'playlists__list-count';
    count.textContent = `${pl.videoPaths.length} video${pl.videoPaths.length !== 1 ? 's' : ''}`;

    const actions = document.createElement('div');
    actions.className = 'playlists__list-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'playlists__card-action-btn';
    renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
    renameBtn.title = t('common.rename');
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this._renamePlaylist(pl); });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'playlists__card-action-btn playlists__card-action-btn--danger';
    deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
    deleteBtn.title = t('common.delete');
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); this._deletePlaylist(pl); });

    actions.append(renameBtn, deleteBtn);
    row.append(name, count, actions);

    row.addEventListener('click', () => {
      this._view = 'detail';
      this._detailPlaylistId = pl.id;
      this._renderDetail(pl.id);
    });

    return row;
  }

  _createVideoListItem(videoPath, playlist, playContext) {
    const fileName = videoPath.split(/[\\/]/).pop() || videoPath;
    const displayName = fileName.replace(/\.[^/.]+$/, '');
    const row = document.createElement('div');
    row.className = 'playlists__list-item';
    // Identity for reorder: derive order from the DOM, key by path.
    row.dataset.videoPath = videoPath;
    row.dataset.videoName = displayName;

    // --- Reorder controls (list view only — natural for an ordered list) ---
    // Drag handle = visual signifier (decorative; keyboard uses the buttons).
    const handle = document.createElement('span');
    handle.className = 'playlists__drag-handle';
    handle.appendChild(icon(GripVertical, { width: 16, height: 16 }));
    handle.setAttribute('aria-hidden', 'true');
    handle.title = t('playlists.dragToReorder');

    // Move ↑/↓ buttons — the accessible, single-pointer + keyboard path
    // (WCAG 2.5.7). No-op at edges; no re-render so focus stays put.
    const moveUp = document.createElement('button');
    moveUp.type = 'button';
    moveUp.className = 'playlists__move-btn playlists__move-up';
    moveUp.appendChild(icon(ChevronUp, { width: 14, height: 14 }));
    moveUp.title = t('playlists.moveUp');
    moveUp.setAttribute('aria-label', t('playlists.moveUpNamed', { name: displayName }));
    moveUp.addEventListener('click', (e) => { e.stopPropagation(); this._moveRow(row, -1, playlist.id); });

    const moveDown = document.createElement('button');
    moveDown.type = 'button';
    moveDown.className = 'playlists__move-btn playlists__move-down';
    moveDown.appendChild(icon(ChevronDown, { width: 14, height: 14 }));
    moveDown.title = t('playlists.moveDown');
    moveDown.setAttribute('aria-label', t('playlists.moveDownNamed', { name: displayName }));
    moveDown.addEventListener('click', (e) => { e.stopPropagation(); this._moveRow(row, +1, playlist.id); });

    // Native HTML5 drag-and-drop on the row (mouse power-user layer). A drag
    // suppresses the row's click, so click-to-play still works. Insertion is
    // decided by whether the pointer is past the target row's centre (NN/g).
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      this._dragRow = row;
      row.classList.add('playlists__list-item--dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', videoPath); // Firefox needs data set
      }
    });
    row.addEventListener('dragover', (e) => {
      if (!this._dragRow || this._dragRow === row) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      row.classList.toggle('playlists__list-item--drop-after', after);
      row.classList.toggle('playlists__list-item--drop-before', !after);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('playlists__list-item--drop-before', 'playlists__list-item--drop-after');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('playlists__list-item--drop-before', 'playlists__list-item--drop-after');
      const dragged = this._dragRow;
      if (!dragged || dragged === row) return;
      const grid = row.parentElement;
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      grid.insertBefore(dragged, after ? row.nextElementSibling : row);
      this._persistOrderFromDom(grid, playlist.id);
      const pos = [...grid.children].indexOf(dragged) + 1;
      this._announceReorder(dragged.dataset.videoName || '', pos, grid.children.length);
    });
    row.addEventListener('dragend', () => {
      this._dragRow?.classList.remove('playlists__list-item--dragging');
      this._dragRow = null;
      row.parentElement?.querySelectorAll('.playlists__list-item--drop-before, .playlists__list-item--drop-after')
        .forEach((r) => r.classList.remove('playlists__list-item--drop-before', 'playlists__list-item--drop-after'));
    });

    const title = document.createElement('span');
    title.className = 'playlists__list-name';
    title.textContent = displayName;
    title.title = fileName;

    const heatmap = document.createElement('canvas');
    heatmap.className = 'playlists__list-heatmap';

    const badges = document.createElement('div');
    badges.className = 'playlists__list-badges';

    const fsBadge = document.createElement('span');
    fsBadge.className = 'library__funscript-badge--inline library__funscript-badge--auto';
    fsBadge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
    fsBadge.hidden = true;
    badges.appendChild(fsBadge);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'playlists__card-action-btn playlists__card-action-btn--danger';
    removeBtn.appendChild(icon(X, { width: 14, height: 14 }));
    removeBtn.title = t('playlists.removeFromPlaylist');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.removeVideoFromPlaylist(playlist.id, videoPath);
      this._renderDetail(playlist.id);
    });

    const moveGroup = document.createElement('div');
    moveGroup.className = 'playlists__move-group';
    moveGroup.append(moveUp, moveDown);

    row.append(handle, title, heatmap, badges, moveGroup, removeBtn);

    row.addEventListener('click', () => {
      this._playVideoByPath(videoPath, playContext);
    });

    const funscriptPath = this._getFunscriptPath(videoPath);
    this._loadListStats(videoPath, funscriptPath, fsBadge, badges, heatmap, row);

    return row;
  }

  async _loadListStats(videoPath, funscriptPath, fsBadgeEl, badgesEl, heatmapEl, rowEl) {
    const cachedBins = this._binsByPath.get(videoPath);
    if (cachedBins && heatmapEl) {
      requestAnimationFrame(() => renderBins(heatmapEl, cachedBins));
    }
    try {
      const content = await window.funsync.readFunscript(funscriptPath);
      if (!content) {
        if (rowEl) rowEl.classList.add('playlists__list-item--no-heatmap');
        if (heatmapEl) heatmapEl.remove();
        return;
      }

      if (fsBadgeEl) fsBadgeEl.hidden = false;

      const parsed = JSON.parse(content);
      const actions = parsed?.actions;
      if (!actions || actions.length < 2) return;

      if (badgesEl) {
        const stats = computeSpeedStats(actions);
        if (stats.maxSpeed > 0) this._addSpeedBadge(badgesEl, stats);
      }

      if (heatmapEl) {
        const bins = cachedBins || computeBins(actions);
        if (!cachedBins) this._binsByPath.set(videoPath, bins);
        renderBins(heatmapEl, bins);
      }
    } catch {
      if (rowEl) rowEl.classList.add('playlists__list-item--no-heatmap');
      if (heatmapEl) heatmapEl.remove();
    }
  }
}
