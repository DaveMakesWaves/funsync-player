// Library — Browse a directory of videos with thumbnail grid

import { Modal } from './modal.js';
import { rankFunscriptMatches } from '../js/fuzzy-match.js';
import { icon, FolderOpen, ArrowLeft, X, Clapperboard, Play, EllipsisVertical, FileCheck, Gauge, Captions, LayoutGrid, LayoutList } from '../js/icons.js';
import { fuzzySearch, sortVideos, computeSpeedStats } from '../js/library-search.js';
import { AXIS_DEFINITIONS, detectCompanionFiles, parseAxisSuffix } from '../js/multi-axis.js';
import * as thumbCache from '../js/thumbnail-cache.js';

const MAX_CONCURRENT_THUMBNAILS = 3;

export class Library {
  constructor({ onPlayVideo, onBack, settings }) {
    this._onPlayVideo = onPlayVideo;
    this._onBack = onBack;
    this._settings = settings;
    this._container = null;
    this._videos = [];
    this._dirPath = null;
    this._observer = null;
    this._pendingThumbnails = [];
    this._activeThumbnails = 0;
    this._openMenu = null;
    this._boundCloseMenu = (e) => this._handleOutsideClick(e);
    this._selectMode = false;
    this._selectedPaths = new Set();
    this._unmatchedFunscripts = [];
    this._unmatchedSubtitles = [];
    this._activeTab = 'matched';
    this._searchQuery = '';
    this._sortKey = 'name:asc';
    this._viewMode = 'grid';

    // Hover preview state (singleton video element — avoids Electron memory leak #18277)
    this._previewVideo = null;
    this._previewCanvas = null;
    this._previewCtx = null;
    this._previewRaf = null;
    this._previewCycleTimer = null;
    this._previewCycleIndex = 0;
    this._previewGeneration = 0;
    this._previewHoverTimer = null;
    this._isVideoPlaying = false; // set by app.js to gate preview
  }

  show(containerEl) {
    this._container = containerEl;
    this._dirPath = this._settings.get('library.directory') || null;

    if (this._dirPath) {
      this._renderWithHeader();
      this._scanDirectory(this._dirPath);
    } else {
      this._renderEmpty();
    }
  }

  hide() {
    this._closeMenu();
    this._exitSelectMode();
    this._stopPreview();
    this._activeTab = 'matched';
    this._searchQuery = '';
    this._sortKey = 'name:asc';
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._pendingThumbnails = [];
    this._activeThumbnails = 0;
    if (this._container) {
      this._container.innerHTML = '';
    }
  }

  _renderEmpty() {
    this._container.innerHTML = `
      <div class="library__empty">
        <div class="library__empty-icon"></div>
        <div class="library__empty-text">Select a folder to browse your video library</div>
        <button class="library__select-dir-btn">Choose Directory</button>
      </div>
    `;
    this._container.querySelector('.library__empty-icon')
      .appendChild(icon(FolderOpen, { width: 48, height: 48 }));
    this._container.querySelector('.library__select-dir-btn')
      .addEventListener('click', () => this._selectDirectory());
  }

  _renderWithHeader() {
    this._container.innerHTML = `
      <div class="library__header">
        <span class="library__title">Library</span>
        <span class="library__dir-path" title="${this._escapeHtml(this._dirPath || '')}">${this._escapeHtml(this._dirPath || '')}</span>
        <span class="library__video-count"></span>
        <div class="library__search">
          <input type="text" class="library__search-input" placeholder="Search..." aria-label="Search videos">
          <button class="library__search-clear" hidden aria-label="Clear search"></button>
        </div>
        <select class="library__sort-select" aria-label="Sort videos">
          <option value="name:asc">Name A-Z</option>
          <option value="name:desc">Name Z-A</option>
          <option value="duration:asc">Duration Short-Long</option>
          <option value="duration:desc">Duration Long-Short</option>
          <option value="avgSpeed:asc">Avg Speed Slow-Fast</option>
          <option value="avgSpeed:desc">Avg Speed Fast-Slow</option>
          <option value="maxSpeed:asc">Max Speed Slow-Fast</option>
          <option value="maxSpeed:desc">Max Speed Fast-Slow</option>
        </select>
        <div class="library__tabs">
          <button class="library__tab library__tab--active" data-tab="matched">Matched</button>
          <button class="library__tab" data-tab="unmatched">Unmatched</button>
        </div>
        <div class="view-toggle-group">
          <button class="view-toggle view-toggle--grid" aria-label="Grid view" title="Grid view"></button>
          <button class="view-toggle view-toggle--list" aria-label="List view" title="List view"></button>
        </div>
        <button class="library__select-mode-btn">Select</button>
        <button class="library__change-dir-btn">Change Directory</button>
      </div>
      <div class="library__selection-bar" hidden>
        <span class="library__selection-count">0 selected</span>
        <button class="library__selection-action" data-action="playlist">Add to Playlist</button>
        <button class="library__selection-action" data-action="category">Assign Category</button>
        <button class="library__selection-cancel">Cancel</button>
      </div>
      <div class="library__grid-wrapper">
        <div class="library__grid"></div>
      </div>
    `;

    this._container.querySelector('.library__change-dir-btn')
      .addEventListener('click', () => this._selectDirectory());

    // Search
    const searchInput = this._container.querySelector('.library__search-input');
    const searchClear = this._container.querySelector('.library__search-clear');
    searchClear.appendChild(icon(X, { width: 14, height: 14 }));
    searchInput.addEventListener('input', () => {
      this._searchQuery = searchInput.value;
      searchClear.hidden = !searchInput.value;
      this._applyFilters();
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      this._searchQuery = '';
      searchClear.hidden = true;
      this._applyFilters();
    });

    // Sort dropdown
    const sortSelect = this._container.querySelector('.library__sort-select');
    sortSelect.value = this._sortKey;
    sortSelect.addEventListener('change', () => {
      this._sortKey = sortSelect.value;
      this._applyFilters();
    });

    // Tab switching
    this._container.querySelectorAll('.library__tab').forEach((tab) => {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    // View toggle
    const btnGrid = this._container.querySelector('.view-toggle--grid');
    const btnList = this._container.querySelector('.view-toggle--list');
    btnGrid.appendChild(icon(LayoutGrid, { width: 16, height: 16 }));
    btnList.appendChild(icon(LayoutList, { width: 16, height: 16 }));
    btnGrid.classList.add('view-toggle--active');
    btnGrid.addEventListener('click', () => this._setViewMode('grid'));
    btnList.addEventListener('click', () => this._setViewMode('list'));

    // Multi-select
    this._container.querySelector('.library__select-mode-btn')
      .addEventListener('click', () => this._toggleSelectMode());
    this._container.querySelector('.library__selection-cancel')
      .addEventListener('click', () => this._exitSelectMode());
    this._container.querySelector('[data-action="playlist"]')
      .addEventListener('click', () => this._bulkAddToPlaylist());
    this._container.querySelector('[data-action="category"]')
      .addEventListener('click', () => this._bulkAssignCategory());
  }

  async _selectDirectory() {
    const dirPath = await window.funsync.selectDirectory();
    if (!dirPath) return;

    this._dirPath = dirPath;
    this._settings.set('library.directory', dirPath);
    this._renderWithHeader();
    this._scanDirectory(dirPath);
  }

  async _scanDirectory(dirPath) {
    const result = await window.funsync.scanDirectory(dirPath);
    // Handle both old (array) and new ({ videos, unmatchedFunscripts }) return shapes
    const videos = Array.isArray(result) ? result : result.videos;
    this._unmatchedFunscripts = Array.isArray(result) ? [] : (result.unmatchedFunscripts || []);
    this._unmatchedSubtitles = Array.isArray(result) ? [] : (result.unmatchedSubtitles || []);
    this._allFunscripts = Array.isArray(result) ? [] : (result.allFunscripts || []);
    this._videos = videos;

    // Apply manual funscript associations from settings
    const associations = this._settings.get('library.associations') || {};
    for (const video of this._videos) {
      const assoc = associations[video.path];
      if (!assoc) continue;
      if (typeof assoc === 'string') {
        // Single axis association
        if (!video.hasFunscript) {
          video.hasFunscript = true;
          video.funscriptPath = assoc;
          video._manualAssociation = true;
        }
      } else if (typeof assoc === 'object') {
        // Multi axis association
        const hasAnyScript = !!assoc.main || Object.values(assoc.axes || {}).some(Boolean);
        if (hasAnyScript) {
          video.hasFunscript = true;
          video.funscriptPath = assoc.main || null;
          video._manualAssociation = true;
          video._multiAxis = assoc;
        }
      }
    }

    // Apply manual subtitle associations from settings
    const subAssociations = this._settings.get('library.subtitleAssociations') || {};
    for (const video of this._videos) {
      if (!video.hasSubtitle && subAssociations[video.path]) {
        video.hasSubtitle = true;
        video.subtitlePath = subAssociations[video.path];
        video._manualSubtitle = true;
      }
    }

    // Compute funscript speed stats for paired videos (non-blocking)
    this._loadSpeedStats(this._videos);

    if (videos.length === 0) {
      const countEl = this._container.querySelector('.library__video-count');
      if (countEl) countEl.textContent = '0 videos';
      const gridWrapper = this._container.querySelector('.library__grid-wrapper');
      if (gridWrapper) {
        gridWrapper.innerHTML = `
          <div class="library__empty">
            <div class="library__empty-text">No video files found in this directory</div>
          </div>
        `;
      }
      return;
    }

    this._applyFilters();
  }

  _renderGrid(videos) {
    const grid = this._container.querySelector('.library__grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Toggle grid/list class
    grid.classList.toggle('library__grid--list', this._viewMode === 'list');

    // Set up IntersectionObserver for lazy thumbnail loading
    if (this._observer) this._observer.disconnect();
    this._pendingThumbnails = [];
    this._activeThumbnails = 0;

    this._observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const card = entry.target;
          const videoPath = card.dataset.videoPath;
          if (videoPath && !card.dataset.loaded) {
            card.dataset.loaded = 'pending';
            this._queueThumbnail(card, videoPath);
          }
          this._observer.unobserve(card);
        }
      }
    }, { rootMargin: '200px' });

    for (const video of videos) {
      const el = this._viewMode === 'list' ? this._createListItem(video) : this._createCard(video);
      grid.appendChild(el);
      this._observer.observe(el);
    }
  }

  _setViewMode(mode) {
    if (this._viewMode === mode) return;
    this._viewMode = mode;

    const btnGrid = this._container.querySelector('.view-toggle--grid');
    const btnList = this._container.querySelector('.view-toggle--list');
    if (btnGrid) btnGrid.classList.toggle('view-toggle--active', mode === 'grid');
    if (btnList) btnList.classList.toggle('view-toggle--active', mode === 'list');

    this._applyFilters();
  }

  _createListItem(video) {
    const row = document.createElement('div');
    row.className = 'library__list-item';
    row.dataset.videoPath = video.path;

    // Small thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'library__list-thumb';
    const placeholder = document.createElement('div');
    placeholder.className = 'library__card-placeholder';
    placeholder.appendChild(icon(Clapperboard, { width: 16, height: 16 }));
    thumb.appendChild(placeholder);
    row.appendChild(thumb);

    // Title
    const title = document.createElement('span');
    title.className = 'library__list-title';
    title.textContent = video.name.replace(/\.[^/.]+$/, '');
    title.title = video.name;
    row.appendChild(title);

    // Badges container
    const badges = document.createElement('div');
    badges.className = 'library__list-badges';

    if (video.hasFunscript) {
      const fsBadge = document.createElement('span');
      fsBadge.className = `library__funscript-badge--inline ${video._manualAssociation ? 'library__funscript-badge--manual' : 'library__funscript-badge--auto'}`;
      fsBadge.title = video._manualAssociation ? 'Funscript (manual)' : 'Funscript (auto-detected)';
      fsBadge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
      badges.appendChild(fsBadge);
    }

    if (video.hasSubtitle) {
      const subBadge = document.createElement('span');
      subBadge.className = `library__subtitle-badge--inline ${video._manualSubtitle ? 'library__subtitle-badge--manual' : 'library__subtitle-badge--auto'}`;
      subBadge.title = video._manualSubtitle ? 'Subtitles (manual)' : 'Subtitles (auto-detected)';
      subBadge.appendChild(icon(Captions, { width: 14, height: 14, 'stroke-width': 2.5 }));
      badges.appendChild(subBadge);
    }

    if (video.avgSpeed > 0 || video.maxSpeed > 0) {
      this._addSpeedBadge(badges, { avgSpeed: video.avgSpeed, maxSpeed: video.maxSpeed });
    }

    // Category dots
    const catIds = this._settings.getVideoCategories(video.path);
    if (catIds.length > 0) {
      const allCats = this._settings.getCategories();
      for (const catId of catIds) {
        const cat = allCats.find((c) => c.id === catId);
        if (cat) {
          const dot = document.createElement('span');
          dot.className = 'library__card-category-dot';
          dot.style.background = cat.color;
          dot.title = cat.name;
          badges.appendChild(dot);
        }
      }
    }

    row.appendChild(badges);

    // Duration
    if (video.duration > 0) {
      const dur = document.createElement('span');
      dur.className = 'library__list-duration';
      dur.textContent = this._formatDuration(video.duration);
      row.appendChild(dur);
    }

    // Kebab button
    const kebab = document.createElement('button');
    kebab.className = 'library__list-kebab';
    kebab.appendChild(icon(EllipsisVertical, { width: 16, height: 16 }));
    kebab.title = 'Options';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showKebabMenu(video, kebab, row);
    });
    row.appendChild(kebab);

    // Select checkbox (hidden unless select mode)
    const checkbox = document.createElement('div');
    checkbox.className = 'library__card-checkbox';
    checkbox.hidden = !this._selectMode;
    row.appendChild(checkbox);

    // Click to play (or toggle select)
    row.addEventListener('click', () => {
      if (this._selectMode) {
        this._toggleCardSelection(row, video.path);
      } else {
        this._playVideo(video);
      }
    });

    return row;
  }

  _createCard(video) {
    const card = document.createElement('div');
    card.className = 'library__card';
    card.dataset.videoPath = video.path;

    const thumbnail = document.createElement('div');
    thumbnail.className = 'library__card-thumbnail';

    // Placeholder
    const placeholder = document.createElement('div');
    placeholder.className = 'library__card-placeholder';
    placeholder.appendChild(icon(Clapperboard, { width: 32, height: 32 }));
    thumbnail.appendChild(placeholder);

    // Hover overlay with play icon
    const overlay = document.createElement('div');
    overlay.className = 'library__card-overlay';
    const playIcon = document.createElement('span');
    playIcon.className = 'library__card-play-icon';
    playIcon.appendChild(icon(Play, { width: 36, height: 36 }));
    overlay.appendChild(playIcon);
    thumbnail.appendChild(overlay);

    // Select checkbox (hidden unless select mode)
    const checkbox = document.createElement('div');
    checkbox.className = 'library__card-checkbox';
    checkbox.hidden = !this._selectMode;
    thumbnail.appendChild(checkbox);

    // Kebab button
    const kebab = document.createElement('button');
    kebab.className = 'library__kebab-btn';
    kebab.appendChild(icon(EllipsisVertical, { width: 16, height: 16 }));
    kebab.title = 'Options';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showKebabMenu(video, kebab, card);
    });
    thumbnail.appendChild(kebab);

    // Funscript badge (icon-based, color reflects auto vs manual)
    if (video.hasFunscript) {
      const badge = document.createElement('span');
      badge.className = `library__funscript-badge ${video._manualAssociation ? 'library__funscript-badge--manual' : 'library__funscript-badge--auto'}`;
      badge.title = video._manualAssociation ? 'Funscript (manual)' : 'Funscript (auto-detected)';
      badge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
      thumbnail.appendChild(badge);
    }

    // Subtitle badge
    if (video.hasSubtitle) {
      const subBadge = document.createElement('span');
      subBadge.className = `library__subtitle-badge ${video._manualSubtitle ? 'library__subtitle-badge--manual' : 'library__subtitle-badge--auto'}`;
      subBadge.title = video._manualSubtitle ? 'Subtitles (manual)' : 'Subtitles (auto-detected)';
      subBadge.appendChild(icon(Captions, { width: 14, height: 14, 'stroke-width': 2.5 }));
      thumbnail.appendChild(subBadge);
    }

    // Category dot badges
    const catIds = this._settings.getVideoCategories(video.path);
    if (catIds.length > 0) {
      const dotsContainer = document.createElement('div');
      dotsContainer.className = 'library__card-category-dots';
      const allCats = this._settings.getCategories();
      for (const catId of catIds) {
        const cat = allCats.find((c) => c.id === catId);
        if (cat) {
          const dot = document.createElement('span');
          dot.className = 'library__card-category-dot';
          dot.style.background = cat.color;
          dot.title = cat.name;
          dotsContainer.appendChild(dot);
        }
      }
      thumbnail.appendChild(dotsContainer);
    }

    // Duration badge on thumbnail (if already known)
    if (video.duration > 0) {
      this._addDurationBadge(thumbnail, video.duration);
    }

    card.appendChild(thumbnail);

    // Info / title
    const info = document.createElement('div');
    info.className = 'library__card-info';
    const title = document.createElement('div');
    title.className = 'library__card-title';
    title.textContent = video.name.replace(/\.[^/.]+$/, '');
    title.title = video.name;
    info.appendChild(title);

    // Speed badge in info bar (if stats already computed)
    if (video.avgSpeed > 0 || video.maxSpeed > 0) {
      this._addSpeedBadge(info, { avgSpeed: video.avgSpeed, maxSpeed: video.maxSpeed });
    }

    card.appendChild(info);

    // Click to play (or toggle select)
    card.addEventListener('click', () => {
      if (this._selectMode) {
        this._toggleCardSelection(card, video.path);
      } else {
        this._playVideo(video);
      }
    });

    // Hover preview (debounced 300ms)
    card.addEventListener('mouseenter', () => {
      this._previewHoverTimer = setTimeout(() => this._startPreview(card, video.path), 300);
    });
    card.addEventListener('mouseleave', () => {
      clearTimeout(this._previewHoverTimer);
      this._stopPreview();
    });

    return card;
  }

  // Thumbnail concurrency limiter
  _queueThumbnail(cardEl, videoPath) {
    this._pendingThumbnails.push({ cardEl, videoPath });
    this._processThumbnailQueue();
  }

  _processThumbnailQueue() {
    while (this._activeThumbnails < MAX_CONCURRENT_THUMBNAILS && this._pendingThumbnails.length > 0) {
      const { cardEl, videoPath } = this._pendingThumbnails.shift();
      this._activeThumbnails++;
      this._loadThumbnail(cardEl, videoPath).finally(() => {
        this._activeThumbnails--;
        this._processThumbnailQueue();
      });
    }
  }

  async _loadThumbnail(cardEl, videoPath) {
    try {
      // Check thumbnail cache first
      let result = thumbCache.get(videoPath, 0);
      let dataUrl, duration;

      if (result) {
        dataUrl = result;
      } else {
        const capture = await this._captureVideoFrame(videoPath);
        dataUrl = capture?.dataUrl || capture;
        duration = capture?.duration;
        if (dataUrl) thumbCache.set(videoPath, 0, dataUrl);

        if (duration) {
          const video = this._videos.find(v => v.path === videoPath);
          if (video) video.duration = duration;
        }
      }

      if (!dataUrl) return;

      const thumbnailContainer = cardEl.querySelector('.library__card-thumbnail') || cardEl.querySelector('.library__list-thumb');
      if (!thumbnailContainer) return;

      const img = document.createElement('img');
      img.alt = '';
      img.src = dataUrl;
      img.addEventListener('load', () => {
        const placeholder = thumbnailContainer.querySelector('.library__card-placeholder');
        if (placeholder) placeholder.remove();
      });
      thumbnailContainer.insertBefore(img, thumbnailContainer.firstChild);
      cardEl.dataset.loaded = 'true';

      // Duration badge
      if (duration) {
        this._addDurationBadge(thumbnailContainer, duration);
      }
    } catch (err) {
      console.warn('Thumbnail capture failed for', videoPath, err.message);
    }
  }

  _captureVideoFrame(videoPath) {
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

      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 10000);

      video.addEventListener('loadedmetadata', () => {
        const seekTo = Math.min(video.duration * 0.1, 5);
        video.currentTime = seekTo;
      }, { once: true });

      video.addEventListener('seeked', () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = Math.round(320 * (video.videoHeight / video.videoWidth)) || 180;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

          const duration = isFinite(video.duration) ? video.duration : 0;
          cleanup();
          resolve({ dataUrl, duration });
        } catch (e) {
          cleanup();
          resolve(null);
        }
      }, { once: true });

      video.addEventListener('error', () => {
        clearTimeout(timeout);
        cleanup();
        resolve(null);
      }, { once: true });

      const normalizedPath = videoPath.replace(/\\/g, '/');
      video.src = `file:///${normalizedPath}`;
    });
  }

  async _loadSpeedStats(videos) {
    for (const video of videos) {
      if (!video.hasFunscript || !video.funscriptPath) continue;
      try {
        const content = await window.funsync.readFunscript(video.funscriptPath);
        if (!content) continue;
        const parsed = JSON.parse(content);
        const actions = parsed?.actions;
        if (actions && actions.length >= 2) {
          const stats = computeSpeedStats(actions);
          video.avgSpeed = stats.avgSpeed;
          video.maxSpeed = stats.maxSpeed;

          // Update badge on card if already rendered
          const card = this._container?.querySelector(`[data-video-path="${CSS.escape(video.path)}"]`);
          if (card) {
            const info = card.querySelector('.library__card-info');
            if (info) this._addSpeedBadge(info, stats);
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  async _loadSpeedStatsForVideo(video, cardEl) {
    if (!video.hasFunscript || !video.funscriptPath) return;
    try {
      const content = await window.funsync.readFunscript(video.funscriptPath);
      if (!content) return;
      const parsed = JSON.parse(content);
      const actions = parsed?.actions;
      if (actions && actions.length >= 2) {
        const stats = computeSpeedStats(actions);
        video.avgSpeed = stats.avgSpeed;
        video.maxSpeed = stats.maxSpeed;
        if (cardEl) {
          const info = cardEl.querySelector('.library__card-info');
          if (info) this._addSpeedBadge(info, stats);
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Add a speed gauge icon to a container element (info bar or thumbnail).
   * Color based on max speed using the OFS heatmap scale (max 400 units/s).
   */
  _addSpeedBadge(containerEl, stats) {
    if (!containerEl || containerEl.querySelector('.library__speed-badge')) return;
    if (!stats.maxSpeed) return;

    let colorClass;
    if (stats.avgSpeed >= 450) colorClass = 'library__speed-badge--insane';
    else if (stats.avgSpeed >= 350) colorClass = 'library__speed-badge--extreme';
    else if (stats.avgSpeed >= 250) colorClass = 'library__speed-badge--fast';
    else if (stats.avgSpeed >= 150) colorClass = 'library__speed-badge--medium';
    else colorClass = 'library__speed-badge--slow';

    const badge = document.createElement('span');
    badge.className = `library__speed-badge ${colorClass}`;
    badge.title = `Avg: ${stats.avgSpeed} units/s — Max: ${stats.maxSpeed} units/s`;
    badge.appendChild(icon(Gauge, { width: 12, height: 12, 'stroke-width': 2.5 }));
    containerEl.appendChild(badge);
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

  // --- Hover Video Preview ---

  _ensurePreviewVideo() {
    if (this._previewVideo) return;

    // Singleton — reuse for all hovers (avoids Electron memory leak #18277)
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(video);

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;

    this._previewVideo = video;
    this._previewCanvas = canvas;
    this._previewCtx = canvas.getContext('2d');
  }

  _startPreview(cardEl, videoPath) {
    // Gate: don't preview if a video is actively playing
    if (this._isVideoPlaying) return;

    this._ensurePreviewVideo();
    this._previewGeneration++;
    const gen = this._previewGeneration;

    const video = this._previewVideo;
    const normalizedPath = videoPath.replace(/\\/g, '/');
    video.src = `file:///${normalizedPath}`;

    video.addEventListener('loadeddata', () => {
      if (gen !== this._previewGeneration) return;

      // Set canvas aspect ratio
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        this._previewCanvas.height = Math.round(320 * (video.videoHeight / video.videoWidth));
      }

      // Seek to 25% of duration
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration * 0.25;
      }
    }, { once: true });

    video.addEventListener('seeked', () => {
      if (gen !== this._previewGeneration) return;
      this._startPreviewLoop(cardEl, gen);
    }, { once: true });

    video.addEventListener('error', () => {
      // Preview failed — silently ignore, static thumbnail stays
    }, { once: true });
  }

  _startPreviewLoop(cardEl, gen) {
    // Find the thumbnail container (grid or list)
    const thumb = cardEl.querySelector('.library__card-thumbnail') || cardEl.querySelector('.library__list-thumb');
    if (!thumb) return;

    // Insert canvas overlay — use opacity, NOT display:none (Electron leak #22417)
    const canvas = this._previewCanvas;
    canvas.className = 'library__preview-canvas';
    thumb.appendChild(canvas);

    // Fade in
    requestAnimationFrame(() => canvas.classList.add('library__preview-canvas--visible'));

    // Start drawing frames
    const video = this._previewVideo;
    const ctx = this._previewCtx;
    const drawFrame = () => {
      if (gen !== this._previewGeneration) return;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch { /* cross-origin or other error */ }
      this._previewRaf = requestAnimationFrame(drawFrame);
    };

    video.play().catch(() => {});
    this._previewRaf = requestAnimationFrame(drawFrame);

    // Auto-cycle through positions every 3 seconds
    const positions = [0.25, 0.45, 0.65, 0.85, 0.1];
    this._previewCycleIndex = 0;
    this._previewCycleTimer = setInterval(() => {
      if (gen !== this._previewGeneration) return;
      this._previewCycleIndex = (this._previewCycleIndex + 1) % positions.length;
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration * positions[this._previewCycleIndex];
      }
    }, 3000);
  }

  _stopPreview() {
    this._previewGeneration++; // invalidate any pending operations

    if (this._previewRaf) {
      cancelAnimationFrame(this._previewRaf);
      this._previewRaf = null;
    }
    if (this._previewCycleTimer) {
      clearInterval(this._previewCycleTimer);
      this._previewCycleTimer = null;
    }
    if (this._previewHoverTimer) {
      clearTimeout(this._previewHoverTimer);
      this._previewHoverTimer = null;
    }

    if (this._previewVideo) {
      this._previewVideo.pause();
      this._previewVideo.removeAttribute('src');
      this._previewVideo.load(); // release media resource
    }

    // Remove canvas from card (fade out then remove)
    if (this._previewCanvas) {
      const canvas = this._previewCanvas;
      canvas.classList.remove('library__preview-canvas--visible');
      setTimeout(() => {
        if (canvas.parentElement) canvas.remove();
      }, 200);
    }
  }

  _showKebabMenu(video, buttonEl, cardEl) {
    // If this button already has the menu open, just close it
    if (this._openMenu && this._openMenuButton === buttonEl) {
      this._closeMenu();
      return;
    }

    this._closeMenu();

    const menu = document.createElement('div');
    menu.className = 'library__kebab-menu';

    const assocBtn = document.createElement('button');
    assocBtn.className = 'library__kebab-menu-item';
    assocBtn.textContent = video.hasFunscript ? 'Change Funscript' : 'Associate Funscript';
    assocBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeMenu();
      this._associateFunscript(video, cardEl);
    });
    menu.appendChild(assocBtn);

    // If manually associated, add option to remove
    if (video._manualAssociation) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'library__kebab-menu-item';
      removeBtn.textContent = 'Remove Funscript';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeMenu();
        this._removeAssociation(video, cardEl);
      });
      menu.appendChild(removeBtn);
    }

    // Subtitle association
    const subBtn = document.createElement('button');
    subBtn.className = 'library__kebab-menu-item';
    subBtn.textContent = video.hasSubtitle ? 'Change Subtitle' : 'Associate Subtitle';
    subBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeMenu();
      this._associateSubtitle(video, cardEl);
    });
    menu.appendChild(subBtn);

    // If manually associated subtitle, add option to remove
    if (video._manualSubtitle) {
      const removeSubBtn = document.createElement('button');
      removeSubBtn.className = 'library__kebab-menu-item';
      removeSubBtn.textContent = 'Remove Subtitle';
      removeSubBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeMenu();
        this._removeSubtitleAssociation(video, cardEl);
      });
      menu.appendChild(removeSubBtn);
    }

    // Add to Playlist
    const playlistBtn = document.createElement('button');
    playlistBtn.className = 'library__kebab-menu-item';
    playlistBtn.textContent = 'Add to Playlist';
    playlistBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeMenu();
      this._addToPlaylist(video.path);
    });
    menu.appendChild(playlistBtn);

    // Assign Category
    const categoryBtn = document.createElement('button');
    categoryBtn.className = 'library__kebab-menu-item';
    categoryBtn.textContent = 'Assign Category';
    categoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeMenu();
      this._assignCategory(video.path, cardEl);
    });
    menu.appendChild(categoryBtn);

    cardEl.appendChild(menu);
    this._openMenu = menu;
    this._openMenuButton = buttonEl;

    // Close on outside click (next tick to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', this._boundCloseMenu, { once: true });
    }, 0);
  }

  _closeMenu() {
    if (this._openMenu) {
      this._openMenu.remove();
      this._openMenu = null;
    }
    this._openMenuButton = null;
    document.removeEventListener('click', this._boundCloseMenu);
  }

  _handleOutsideClick() {
    this._closeMenu();
  }

  async _associateFunscript(video, cardEl) {
    const allScripts = this._allFunscripts;
    const unmatchedScripts = this._unmatchedFunscripts;
    const ranked = unmatchedScripts.length > 0 ? rankFunscriptMatches(video.name, unmatchedScripts) : [];

    // Auto-detect companion files from directory
    const mainFsPath = video.funscriptPath || '';
    const allPaths = allScripts.map(f => f.name);
    const detected = mainFsPath ? detectCompanionFiles(mainFsPath.split(/[\\/]/).pop(), allPaths) : [];

    // Load existing multi-axis config
    const existingAssoc = this._settings.get('library.associations') || {};
    const existing = existingAssoc[video.path];
    const isMulti = existing && typeof existing === 'object';

    const chosen = await Modal.open({
      title: 'Associate Funscript',
      onRender: (body, close) => {
        // --- Mode radio ---
        const modeRow = document.createElement('div');
        modeRow.className = 'library__assoc-mode';

        const radioSingle = document.createElement('input');
        radioSingle.type = 'radio';
        radioSingle.name = 'assoc-mode';
        radioSingle.id = 'assoc-single';
        radioSingle.value = 'single';
        radioSingle.checked = !isMulti;

        const labelSingle = document.createElement('label');
        labelSingle.htmlFor = 'assoc-single';
        labelSingle.textContent = 'Single Axis';

        const radioMulti = document.createElement('input');
        radioMulti.type = 'radio';
        radioMulti.name = 'assoc-mode';
        radioMulti.id = 'assoc-multi';
        radioMulti.value = 'multi';
        radioMulti.checked = isMulti;

        const labelMulti = document.createElement('label');
        labelMulti.htmlFor = 'assoc-multi';
        labelMulti.textContent = 'Multi Axis';

        modeRow.appendChild(radioSingle);
        modeRow.appendChild(labelSingle);
        modeRow.appendChild(radioMulti);
        modeRow.appendChild(labelMulti);
        body.appendChild(modeRow);

        // --- Single axis panel ---
        const singlePanel = document.createElement('div');
        singlePanel.className = 'library__assoc-panel';
        singlePanel.hidden = isMulti;

        // Current script info
        const currentSection = document.createElement('div');
        currentSection.className = 'library__assoc-current';

        if (video.hasFunscript && video.funscriptPath) {
          const currentName = video.funscriptPath.split(/[\\/]/).pop();
          const currentLabel = document.createElement('span');
          currentLabel.className = 'library__assoc-current-label';
          currentLabel.textContent = 'Current:';
          const currentFile = document.createElement('span');
          currentFile.className = 'library__assoc-current-name';
          currentFile.textContent = currentName;
          currentFile.title = video.funscriptPath;
          const currentType = document.createElement('span');
          currentType.className = 'library__assoc-current-type';
          currentType.textContent = video._manualAssociation ? 'manual' : 'auto';
          const clearBtn = document.createElement('button');
          clearBtn.className = 'library__assoc-current-clear';
          clearBtn.textContent = '✕';
          clearBtn.title = 'Remove association';
          clearBtn.addEventListener('click', () => {
            close({ mode: 'remove' });
          });
          currentSection.append(currentLabel, currentFile, currentType, clearBtn);
        } else {
          const noScript = document.createElement('span');
          noScript.className = 'library__assoc-current-none';
          noScript.textContent = 'No script associated';
          currentSection.appendChild(noScript);
        }
        singlePanel.appendChild(currentSection);

        // Change section header
        const changeHeader = document.createElement('div');
        changeHeader.className = 'library__assoc-section-header';
        changeHeader.textContent = video.hasFunscript ? 'Change to:' : 'Select script:';
        singlePanel.appendChild(changeHeader);

        // Fuzzy ranked list
        if (ranked.length > 0) {
          const list = document.createElement('div');
          list.className = 'modal-list';
          for (const match of ranked) {
            const row = document.createElement('button');
            row.className = 'modal-list-item';
            const label = document.createElement('span');
            label.className = 'modal-list-item-label';
            label.textContent = match.name;
            row.appendChild(label);
            const badge = document.createElement('span');
            const scoreClass = match.score >= 70 ? '--high' : match.score >= 40 ? '--medium' : '--low';
            badge.className = `library__match-score library__match-score${scoreClass}`;
            badge.textContent = `${match.score}%`;
            row.appendChild(badge);
            row.addEventListener('click', () => close({ mode: 'single', path: match.path, name: match.name }));
            list.appendChild(row);
          }
          singlePanel.appendChild(list);
        } else {
          const msg = document.createElement('div');
          msg.className = 'modal-message modal-message--muted';
          msg.textContent = 'No funscripts found in directory. Use Browse.';
          singlePanel.appendChild(msg);
        }

        const divider = document.createElement('div');
        divider.className = 'library__suggestion-divider';
        singlePanel.appendChild(divider);

        const browseRow = document.createElement('button');
        browseRow.className = 'modal-list-item library__browse-fallback';
        browseRow.textContent = 'Browse...';
        browseRow.addEventListener('click', async () => {
          const result = await window.funsync.selectFunscript();
          if (result) close({ mode: 'single', path: result.path, name: result.name });
        });
        singlePanel.appendChild(browseRow);

        // Variations section
        const varDivider = document.createElement('div');
        varDivider.className = 'library__suggestion-divider';
        singlePanel.appendChild(varDivider);

        const varSection = document.createElement('div');
        varSection.className = 'library__assoc-variants';

        const varHeader = document.createElement('div');
        varHeader.className = 'library__assoc-section-header';
        const autoVariants = video.variants || [];
        const manualVariants = (this._settings.get('library.manualVariants') || {})[video.path] || [];
        const allVariants = [...autoVariants, ...manualVariants];
        varHeader.textContent = allVariants.length > 0 ? `Variations (${allVariants.length})` : 'Variations';
        varSection.appendChild(varHeader);

        if (allVariants.length > 0) {
          for (const v of allVariants) {
            const vRow = document.createElement('div');
            vRow.className = 'library__assoc-variant-row';
            const vName = document.createElement('span');
            vName.className = 'library__assoc-variant-name';
            vName.textContent = v.label;
            vName.title = v.name || v.path;
            vRow.appendChild(vName);
            varSection.appendChild(vRow);
          }
        }

        const addVarBtn = document.createElement('button');
        addVarBtn.className = 'modal-list-item library__browse-fallback';
        addVarBtn.textContent = '+ Add Variation...';
        addVarBtn.addEventListener('click', async () => {
          const result = await window.funsync.selectFunscript();
          if (result) close({ mode: 'addVariant', path: result.path, name: result.name });
        });
        varSection.appendChild(addVarBtn);

        singlePanel.appendChild(varSection);
        body.appendChild(singlePanel);

        // --- Multi axis panel ---
        const multiPanel = document.createElement('div');
        multiPanel.className = 'library__assoc-panel library__assoc-multi-panel';
        multiPanel.hidden = !isMulti;

        // Build a lookup of detected companions by suffix
        const detectedMap = new Map();
        for (const c of detected) {
          detectedMap.set(c.axis.suffix, c.path);
        }

        // Existing multi config values
        const existingAxes = isMulti ? (existing.axes || {}) : {};

        // Main axis row
        const axisRows = [];
        const mainRow = this._createAxisDropdown('Main (Stroke)', 'main', allScripts, isMulti ? existing.main : (video.funscriptPath || ''), video.name);
        multiPanel.appendChild(mainRow.row);
        axisRows.push(mainRow);

        // Axis rows for relevant axes
        const shownAxes = AXIS_DEFINITIONS.filter(a => ['vib', 'surge', 'sway', 'twist', 'roll', 'pitch'].includes(a.suffix));
        for (const axisDef of shownAxes) {
          // Pre-fill: existing config > detected companion > empty
          const preValue = existingAxes[axisDef.suffix] || '';
          const detectedPath = detectedMap.get(axisDef.suffix);
          const defaultVal = preValue || (detectedPath ? this._findScriptByName(allScripts, detectedPath) : '');

          const axisRow = this._createAxisDropdown(`${axisDef.label} (${axisDef.tcode})`, axisDef.suffix, allScripts, defaultVal, video.name);
          multiPanel.appendChild(axisRow.row);
          axisRows.push(axisRow);
        }

        // Buttplug.io vibration checkbox
        const bpRow = document.createElement('div');
        bpRow.className = 'library__assoc-axis-row library__assoc-bp-row';
        const bpCheck = document.createElement('input');
        bpCheck.type = 'checkbox';
        bpCheck.id = 'assoc-bp-vib';
        bpCheck.checked = isMulti ? !!existing.buttplugVib : false;
        const bpLabel = document.createElement('label');
        bpLabel.htmlFor = 'assoc-bp-vib';
        bpLabel.textContent = 'Use Buttplug.io for vibrations';
        bpRow.appendChild(bpCheck);
        bpRow.appendChild(bpLabel);
        multiPanel.appendChild(bpRow);

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'library__assoc-save-btn';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
          const axes = {};
          for (const ar of axisRows) {
            if (ar.key !== 'main' && ar.select.value) {
              axes[ar.key] = ar.select.value;
            }
          }
          const mainSelect = axisRows.find(r => r.key === 'main');
          close({
            mode: 'multi',
            main: mainSelect?.select.value || '',
            axes,
            buttplugVib: bpCheck.checked,
          });
        });
        multiPanel.appendChild(saveBtn);

        body.appendChild(multiPanel);

        // --- Radio toggle ---
        radioSingle.addEventListener('change', () => {
          singlePanel.hidden = false;
          multiPanel.hidden = true;
        });
        radioMulti.addEventListener('change', () => {
          singlePanel.hidden = true;
          multiPanel.hidden = false;
        });
      },
    });

    if (!chosen) return;

    if (chosen.mode === 'single') {
      this._applyAssociation(video, cardEl, chosen.path, chosen.name);
    } else if (chosen.mode === 'multi') {
      const hasAny = !!chosen.main || Object.values(chosen.axes || {}).some(Boolean);
      if (!hasAny) return;
      this._applyMultiAxisAssociation(video, cardEl, chosen);
    } else if (chosen.mode === 'remove') {
      this._removeAssociation(video, cardEl);
      this._applyFilters();
    } else if (chosen.mode === 'addVariant') {
      // Add a variant without changing the main script
      const nameNoExt = chosen.name.replace(/\.funscript$/i, '');
      const parenMatch = nameNoExt.match(/\(([^)]+)\)/);
      const label = parenMatch ? parenMatch[1].trim() : nameNoExt;
      const manualVariants = this._settings.get('library.manualVariants') || {};
      if (!manualVariants[video.path]) manualVariants[video.path] = [];
      manualVariants[video.path].push({ label, path: chosen.path, name: chosen.name });
      this._settings.set('library.manualVariants', manualVariants);
    }
  }

  _createAxisDropdown(label, key, allScripts, preValue, videoName) {
    const row = document.createElement('div');
    row.className = 'library__assoc-axis-row';

    const lbl = document.createElement('label');
    lbl.className = 'library__assoc-axis-label';
    lbl.textContent = label;
    row.appendChild(lbl);

    const wrapper = document.createElement('div');
    wrapper.className = 'library__searchable-select';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'library__searchable-select-input';
    input.placeholder = key === 'main' ? 'Search or select...' : 'None — type to search...';

    // Hidden value holder
    const valueHolder = { value: '' };

    // Pre-fill
    if (preValue) {
      const match = allScripts.find(s => s.path === preValue || s.name === preValue);
      if (match) {
        input.value = match.name;
        valueHolder.value = match.path;
      }
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'library__searchable-select-dropdown';
    dropdown.hidden = true;

    // Rank scripts by fuzzy match to video name for initial ordering
    const ranked = videoName
      ? rankFunscriptMatches(videoName, allScripts, 0)
      : allScripts.map(s => ({ name: s.name, path: s.path, score: 0 }));

    const renderOptions = (filter) => {
      dropdown.innerHTML = '';
      const query = (filter || '').toLowerCase().trim();

      let items = ranked;
      if (query) {
        items = ranked.filter(s => s.name.toLowerCase().includes(query));
      }

      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'library__searchable-select-empty';
        empty.textContent = 'No matches';
        dropdown.appendChild(empty);
        return;
      }

      for (const item of items.slice(0, 30)) { // cap at 30 visible
        const opt = document.createElement('button');
        opt.className = 'library__searchable-select-option';
        opt.textContent = item.name;
        if (item.path === valueHolder.value) opt.classList.add('library__searchable-select-option--active');
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent input blur
          input.value = item.name;
          valueHolder.value = item.path;
          dropdown.hidden = true;
        });
        dropdown.appendChild(opt);
      }

      // Clear option
      const clearOpt = document.createElement('button');
      clearOpt.className = 'library__searchable-select-option library__searchable-select-clear';
      clearOpt.textContent = key === 'main' ? '— Clear —' : '— None —';
      clearOpt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = '';
        valueHolder.value = '';
        dropdown.hidden = true;
      });
      dropdown.appendChild(clearOpt);
    };

    input.addEventListener('focus', () => {
      renderOptions(input.value);
      dropdown.hidden = false;
    });

    input.addEventListener('input', () => {
      renderOptions(input.value);
      dropdown.hidden = false;
    });

    input.addEventListener('blur', () => {
      // Delay to allow mousedown on option to fire first
      setTimeout(() => { dropdown.hidden = true; }, 150);
    });

    wrapper.appendChild(input);
    wrapper.appendChild(dropdown);
    row.appendChild(wrapper);

    // Expose a select-like interface for the save button
    const select = { get value() { return valueHolder.value; } };
    return { row, select, key };
  }

  _findScriptByName(allScripts, filename) {
    const f = allScripts.find(s => s.name === filename || s.path.endsWith(filename));
    return f ? f.path : '';
  }

  _applyMultiAxisAssociation(video, cardEl, config) {
    const associations = this._settings.get('library.associations') || {};
    associations[video.path] = {
      main: config.main,
      axes: config.axes,
      buttplugVib: config.buttplugVib,
    };
    this._settings.set('library.associations', associations);

    const hasAnyScript = !!config.main || Object.values(config.axes || {}).some(Boolean);
    video.hasFunscript = hasAnyScript;
    video.funscriptPath = config.main || null;
    video._manualAssociation = true;
    video._multiAxis = config;

    // Re-render to update badges in both grid and list views
    this._applyFilters();

    // Compute speed stats for main script (async, updates card when done)
    if (config.main) {
      this._loadSpeedStatsForVideo(video, null);
    }
  }

  async _applyAssociation(video, cardEl, fsPath, fsName) {
    // Save in settings
    const associations = this._settings.get('library.associations') || {};
    associations[video.path] = fsPath;
    this._settings.set('library.associations', associations);

    // Update video object
    video.hasFunscript = true;
    video.funscriptPath = fsPath;
    video._manualAssociation = true;

    // Remove from unmatched list
    this._unmatchedFunscripts = this._unmatchedFunscripts.filter((fs) => fs.path !== fsPath);

    // Update funscript badge on card
    const thumbnailContainer = cardEl.querySelector('.library__card-thumbnail');
    let badge = thumbnailContainer.querySelector('.library__funscript-badge');
    if (!badge) {
      badge = document.createElement('span');
      thumbnailContainer.appendChild(badge);
    }
    badge.className = 'library__funscript-badge library__funscript-badge--manual';
    badge.title = 'Funscript (manual)';
    if (!badge.querySelector('svg')) {
      badge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
    }

    // Compute and show speed badge
    try {
      const content = await window.funsync.readFunscript(fsPath);
      if (content) {
        const parsed = JSON.parse(content);
        const actions = parsed?.actions;
        if (actions && actions.length >= 2) {
          const stats = computeSpeedStats(actions);
          video.avgSpeed = stats.avgSpeed;
          video.maxSpeed = stats.maxSpeed;
          const info = cardEl.querySelector('.library__card-info');
          if (info) this._addSpeedBadge(info, stats);
        }
      }
    } catch { /* ignore */ }

    // Re-apply filters (video now has funscript so it should move between tabs)
    this._applyFilters();
  }

  _switchTab(tab) {
    if (this._activeTab === tab) return;
    this._activeTab = tab;

    this._container.querySelectorAll('.library__tab').forEach((el) => {
      el.classList.toggle('library__tab--active', el.dataset.tab === tab);
    });

    this._applyFilters();
  }

  _applyFilters() {
    let filtered = this._videos;

    // Filter by active tab
    if (this._activeTab === 'matched') {
      filtered = filtered.filter((v) => v.hasFunscript);
    } else if (this._activeTab === 'unmatched') {
      filtered = filtered.filter((v) => !v.hasFunscript);
    }

    // Search: fuzzy matching (replaces simple includes)
    if (this._searchQuery) {
      filtered = fuzzySearch(filtered, this._searchQuery);
    }

    // Sort (format: "field:direction")
    if (!this._searchQuery) {
      const [sortField, sortDir] = (this._sortKey || 'name:asc').split(':');
      filtered = sortVideos(filtered, sortField, sortDir || 'asc');
    }

    // Update count
    const countEl = this._container.querySelector('.library__video-count');
    if (countEl) {
      if (this._searchQuery) {
        countEl.textContent = `${filtered.length} / ${this._videos.length} videos`;
      } else {
        countEl.textContent = `${filtered.length} video${filtered.length !== 1 ? 's' : ''}`;
      }
    }

    this._renderGrid(filtered);
  }

  _removeAssociation(video, cardEl) {
    const associations = this._settings.get('library.associations') || {};
    delete associations[video.path];
    this._settings.set('library.associations', associations);

    video.hasFunscript = false;
    video.funscriptPath = null;
    video._manualAssociation = false;
    video._multiAxis = null;

    // Remove badge
    const badge = cardEl.querySelector('.library__funscript-badge');
    if (badge) badge.remove();
  }

  // --- Subtitle Association ---

  async _associateSubtitle(video, cardEl) {
    if (this._unmatchedSubtitles.length > 0) {
      const ranked = rankFunscriptMatches(video.name, this._unmatchedSubtitles);

      const chosen = await Modal.open({
        title: 'Associate Subtitle',
        onRender: (body, close) => {
          if (ranked.length > 0) {
            const list = document.createElement('div');
            list.className = 'modal-list';

            for (const match of ranked) {
              const row = document.createElement('button');
              row.className = 'modal-list-item';

              const label = document.createElement('span');
              label.className = 'modal-list-item-label';
              label.textContent = match.name;
              row.appendChild(label);

              const badge = document.createElement('span');
              const scoreClass = match.score >= 70 ? '--high' : match.score >= 40 ? '--medium' : '--low';
              badge.className = `library__match-score library__match-score${scoreClass}`;
              badge.textContent = `${match.score}%`;
              row.appendChild(badge);

              row.addEventListener('click', () => close({ path: match.path, name: match.name }));
              list.appendChild(row);
            }

            body.appendChild(list);
          } else {
            const msg = document.createElement('div');
            msg.className = 'modal-message modal-message--muted';
            msg.textContent = 'No good matches found among unmatched subtitles.';
            body.appendChild(msg);
          }

          const divider = document.createElement('div');
          divider.className = 'library__suggestion-divider';
          body.appendChild(divider);

          const browseRow = document.createElement('button');
          browseRow.className = 'modal-list-item library__browse-fallback';
          browseRow.textContent = 'Browse...';
          browseRow.addEventListener('click', async () => {
            const result = await window.funsync.selectSubtitle();
            close(result);
          });
          body.appendChild(browseRow);
        },
      });

      if (!chosen) return;
      this._applySubtitleAssociation(video, cardEl, chosen.path, chosen.name);
    } else {
      const result = await window.funsync.selectSubtitle();
      if (!result) return;
      this._applySubtitleAssociation(video, cardEl, result.path, result.name);
    }
  }

  _applySubtitleAssociation(video, cardEl, subPath, subName) {
    const associations = this._settings.get('library.subtitleAssociations') || {};
    associations[video.path] = subPath;
    this._settings.set('library.subtitleAssociations', associations);

    video.hasSubtitle = true;
    video.subtitlePath = subPath;
    video._manualSubtitle = true;

    // Remove from unmatched list
    this._unmatchedSubtitles = this._unmatchedSubtitles.filter((s) => s.path !== subPath);

    // Update subtitle badge on card
    const thumbnailContainer = cardEl.querySelector('.library__card-thumbnail');
    let badge = thumbnailContainer.querySelector('.library__subtitle-badge');
    if (!badge) {
      badge = document.createElement('span');
      thumbnailContainer.appendChild(badge);
    }
    badge.className = 'library__subtitle-badge library__subtitle-badge--manual';
    badge.title = 'Subtitles (manual)';
    if (!badge.querySelector('svg')) {
      badge.appendChild(icon(Captions, { width: 14, height: 14, 'stroke-width': 2.5 }));
    }
  }

  _removeSubtitleAssociation(video, cardEl) {
    const associations = this._settings.get('library.subtitleAssociations') || {};
    delete associations[video.path];
    this._settings.set('library.subtitleAssociations', associations);

    video.hasSubtitle = false;
    video.subtitlePath = null;
    video._manualSubtitle = false;

    const badge = cardEl.querySelector('.library__subtitle-badge');
    if (badge) badge.remove();
  }

  async _playVideo(video) {
    // Build a file-like object for app.loadVideo
    const fileData = {
      name: video.name,
      path: video.path,
      _isPathBased: true,
    };

    // If funscript is available, read it and build a funscript file-like object
    let funscriptData = null;
    if (video.hasFunscript && video.funscriptPath) {
      try {
        const content = await window.funsync.readFunscript(video.funscriptPath);
        if (content) {
          const fsName = video.funscriptPath.split(/[\\/]/).pop();
          funscriptData = {
            name: fsName,
            textContent: content,
          };

          // Attach multi-axis config if present
          if (video._multiAxis) {
            funscriptData._multiAxis = video._multiAxis;
          }
        }
      } catch (err) {
        console.warn('Failed to read funscript:', err.message);
      }
    }

    // Attach multi-axis config even without a main funscript (vib-only case)
    if (!funscriptData && video._multiAxis) {
      funscriptData = { name: '', textContent: null, _multiAxis: video._multiAxis };
    }

    // If subtitle is available, read it and build a subtitle file-like object
    let subtitleData = null;
    if (video.hasSubtitle && video.subtitlePath) {
      try {
        const content = await window.funsync.readFunscript(video.subtitlePath); // reuse text reader
        if (content) {
          const subName = video.subtitlePath.split(/[\\/]/).pop();
          subtitleData = {
            name: subName,
            textContent: content,
          };
        }
      } catch (err) {
        console.warn('Failed to read subtitle:', err.message);
      }
    }

    this._onPlayVideo(fileData, funscriptData, subtitleData, video.variants || []);
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Playlist / Category integration ---

  async _addToPlaylist(videoPath) {
    const playlists = this._settings.getPlaylists();
    if (playlists.length === 0) {
      const name = await Modal.prompt('Create a Playlist First', 'Playlist name');
      if (!name) return;
      const pl = await this._settings.addPlaylist(name);
      this._settings.addVideoToPlaylist(pl.id, videoPath);
      return;
    }
    const items = playlists.map((p) => ({
      id: p.id,
      label: p.name,
      subtitle: `${p.videoPaths.length} video${p.videoPaths.length !== 1 ? 's' : ''}`,
    }));
    const selectedId = await Modal.selectFromList('Add to Playlist', items);
    if (selectedId) {
      this._settings.addVideoToPlaylist(selectedId, videoPath);
    }
  }

  async _assignCategory(videoPath, cardEl) {
    const categories = this._settings.getCategories();
    if (categories.length === 0) {
      // No categories yet — tell the user
      await Modal.confirm('No Categories', 'Create categories from the Categories view first.');
      return;
    }
    const current = this._settings.getVideoCategories(videoPath);
    const items = categories
      .filter((c) => !current.includes(c.id))
      .map((c) => ({ id: c.id, label: c.name }));

    if (items.length === 0) {
      await Modal.confirm('All Assigned', 'This video already has all categories assigned.');
      return;
    }

    const selectedId = await Modal.selectFromList('Assign Category', items);
    if (selectedId) {
      this._settings.assignCategory(videoPath, selectedId);
      this._updateCardCategoryDots(cardEl, videoPath);
    }
  }

  _updateCardCategoryDots(cardEl, videoPath) {
    const thumbnail = cardEl.querySelector('.library__card-thumbnail');
    if (!thumbnail) return;

    // Remove existing dots
    const existing = thumbnail.querySelector('.library__card-category-dots');
    if (existing) existing.remove();

    const catIds = this._settings.getVideoCategories(videoPath);
    if (catIds.length === 0) return;

    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'library__card-category-dots';
    const allCats = this._settings.getCategories();
    for (const catId of catIds) {
      const cat = allCats.find((c) => c.id === catId);
      if (cat) {
        const dot = document.createElement('span');
        dot.className = 'library__card-category-dot';
        dot.style.background = cat.color;
        dot.title = cat.name;
        dotsContainer.appendChild(dot);
      }
    }
    thumbnail.appendChild(dotsContainer);
  }

  // --- Multi-select mode ---

  _toggleSelectMode() {
    if (this._selectMode) {
      this._exitSelectMode();
    } else {
      this._enterSelectMode();
    }
  }

  _enterSelectMode() {
    this._selectMode = true;
    this._selectedPaths = new Set();

    const btn = this._container.querySelector('.library__select-mode-btn');
    if (btn) btn.textContent = 'Cancel';

    const bar = this._container.querySelector('.library__selection-bar');
    if (bar) bar.hidden = false;

    // Show checkboxes on all cards
    this._container.querySelectorAll('.library__card-checkbox').forEach((cb) => {
      cb.hidden = false;
    });
    this._updateSelectionCount();
  }

  _exitSelectMode() {
    this._selectMode = false;
    this._selectedPaths = new Set();

    if (!this._container) return;

    const btn = this._container.querySelector('.library__select-mode-btn');
    if (btn) btn.textContent = 'Select';

    const bar = this._container.querySelector('.library__selection-bar');
    if (bar) bar.hidden = true;

    // Hide checkboxes and remove selected state
    this._container.querySelectorAll('.library__card-checkbox').forEach((cb) => {
      cb.hidden = true;
      cb.classList.remove('library__card-checkbox--checked');
    });
    this._container.querySelectorAll('.library__card--selected').forEach((card) => {
      card.classList.remove('library__card--selected');
    });
  }

  _toggleCardSelection(card, videoPath) {
    if (this._selectedPaths.has(videoPath)) {
      this._selectedPaths.delete(videoPath);
      card.classList.remove('library__card--selected');
      const cb = card.querySelector('.library__card-checkbox');
      if (cb) cb.classList.remove('library__card-checkbox--checked');
    } else {
      this._selectedPaths.add(videoPath);
      card.classList.add('library__card--selected');
      const cb = card.querySelector('.library__card-checkbox');
      if (cb) cb.classList.add('library__card-checkbox--checked');
    }
    this._updateSelectionCount();
  }

  _updateSelectionCount() {
    const countEl = this._container?.querySelector('.library__selection-count');
    if (countEl) {
      const n = this._selectedPaths.size;
      countEl.textContent = `${n} selected`;
    }
  }

  async _bulkAddToPlaylist() {
    if (this._selectedPaths.size === 0) return;
    const playlists = this._settings.getPlaylists();
    if (playlists.length === 0) {
      const name = await Modal.prompt('Create a Playlist First', 'Playlist name');
      if (!name) return;
      const pl = await this._settings.addPlaylist(name);
      for (const path of this._selectedPaths) {
        this._settings.addVideoToPlaylist(pl.id, path);
      }
      this._exitSelectMode();
      return;
    }
    const items = playlists.map((p) => ({
      id: p.id,
      label: p.name,
      subtitle: `${p.videoPaths.length} video${p.videoPaths.length !== 1 ? 's' : ''}`,
    }));
    const selectedId = await Modal.selectFromList('Add to Playlist', items);
    if (selectedId) {
      for (const path of this._selectedPaths) {
        this._settings.addVideoToPlaylist(selectedId, path);
      }
      this._exitSelectMode();
    }
  }

  async _bulkAssignCategory() {
    if (this._selectedPaths.size === 0) return;
    const categories = this._settings.getCategories();
    if (categories.length === 0) {
      await Modal.confirm('No Categories', 'Create categories from the Categories view first.');
      return;
    }
    const items = categories.map((c) => ({ id: c.id, label: c.name }));
    const selectedId = await Modal.selectFromList('Assign Category', items);
    if (selectedId) {
      for (const path of this._selectedPaths) {
        this._settings.assignCategory(path, selectedId);
        // Update dots on visible cards
        const card = this._container?.querySelector(`[data-video-path="${CSS.escape(path)}"]`);
        if (card) this._updateCardCategoryDots(card, path);
      }
      this._exitSelectMode();
    }
  }
}
