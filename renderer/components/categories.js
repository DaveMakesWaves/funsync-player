// Categories — Grid view of categories with detail view showing videos

import { Modal } from './modal.js';
import { icon, Tag, Plus, Pencil, Trash2, ArrowLeft, X, Clapperboard, Play, FileX, FileCheck, Gauge, LayoutGrid, LayoutList } from '../js/icons.js';
import { computeSpeedStats } from '../js/library-search.js';
import { computeBins, renderBins } from '../js/heatmap-strip.js';
import { normalizeAssociation, resolveActiveConfig } from '../js/association-shape.js';
import { pathToFileURL } from '../js/path-utils.js';

const PRESET_COLORS = [
  '#e94560', '#ff6b81', '#f39c12', '#2ecc71',
  '#3498db', '#9b59b6', '#1abc9c', '#e74c3c',
  '#00cec9', '#fd79a8',
];

export class Categories {
  constructor({ settings, onPlayVideo, library }) {
    this._settings = settings;
    this._onPlayVideo = onPlayVideo;
    this._library = library || null;
    this._container = null;
    this._view = 'grid'; // 'grid' or 'detail'
    this._detailCategoryId = null;
    this._viewMode = 'grid';
    this._binsByPath = new Map();
  }

  _resolveFunscriptPath(videoPath) {
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
    return videoPath.replace(/\.[^/.]+$/, '.funscript');
  }

  show(containerEl) {
    this._container = containerEl;
    if (this._view === 'detail' && this._detailCategoryId) {
      this._renderDetail(this._detailCategoryId);
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
      this._detailCategoryId = null;
      this._renderGrid();
      return true;
    }
    return false;
  }

  _renderGrid() {
    const categories = this._settings.getCategories();
    this._container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'categories__header';
    header.innerHTML = `<span class="categories__title">Categories</span>`;
    this._addViewToggle(header);
    this._container.appendChild(header);

    const wrapper = document.createElement('div');
    wrapper.className = 'categories__grid-wrapper';

    if (categories.length === 0) {
      wrapper.innerHTML = `
        <div class="categories__empty">
          <div class="categories__empty-icon"></div>
          <div class="categories__empty-text">No categories yet</div>
          <button class="categories__empty-cta">Create Your First Category</button>
        </div>
      `;
      wrapper.querySelector('.categories__empty-icon')
        .appendChild(icon(Tag, { width: 48, height: 48 }));
      wrapper.querySelector('.categories__empty-cta')
        .addEventListener('click', () => this._createCategory());
      this._container.appendChild(wrapper);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'categories__grid';
    grid.classList.toggle('categories__grid--list', this._viewMode === 'list');

    for (const cat of categories) {
      const videoCount = this._settings.getVideosByCategory(cat.id).length;
      const el = this._viewMode === 'list' ? this._createCategoryListItem(cat, videoCount) : this._createCategoryCard(cat, videoCount);
      grid.appendChild(el);
    }

    // Create new card (dashed)
    const createCard = document.createElement('div');
    createCard.className = 'categories__card categories__card--create';
    createCard.innerHTML = `
      <div class="categories__card-create-icon"></div>
      <div class="categories__card-create-label">New Category</div>
    `;
    createCard.querySelector('.categories__card-create-icon')
      .appendChild(icon(Plus, { width: 28, height: 28 }));
    createCard.addEventListener('click', () => this._createCategory());
    grid.appendChild(createCard);

    wrapper.appendChild(grid);
    this._container.appendChild(wrapper);
  }

  _createCategoryCard(cat, videoCount) {
    const card = document.createElement('div');
    card.className = 'categories__card';

    // Color stripe at top
    const stripe = document.createElement('div');
    stripe.className = 'categories__card-stripe';
    stripe.style.background = cat.color;
    card.appendChild(stripe);

    const body = document.createElement('div');
    body.className = 'categories__card-body';

    const name = document.createElement('div');
    name.className = 'categories__card-name';
    name.textContent = cat.name;

    const count = document.createElement('div');
    count.className = 'categories__card-count';
    count.textContent = `${videoCount} video${videoCount !== 1 ? 's' : ''}`;

    body.appendChild(name);
    body.appendChild(count);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'categories__card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'categories__card-action-btn';
    renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._renameCategory(cat);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'categories__card-action-btn categories__card-action-btn--danger';
    deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._deleteCategory(cat);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    body.appendChild(actions);

    card.appendChild(body);

    card.addEventListener('click', () => {
      this._view = 'detail';
      this._detailCategoryId = cat.id;
      this._renderDetail(cat.id);
    });

    return card;
  }

  async _renderDetail(categoryId) {
    const cat = this._settings.getCategories().find((c) => c.id === categoryId);
    if (!cat) {
      this._view = 'grid';
      this._renderGrid();
      return;
    }

    const videoPaths = this._settings.getVideosByCategory(categoryId);
    this._container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'categories__header';

    const backBtn = document.createElement('button');
    backBtn.className = 'categories__back-btn';
    backBtn.appendChild(icon(ArrowLeft, { width: 20, height: 20 }));
    backBtn.title = 'Back to categories';
    backBtn.addEventListener('click', () => this.navigateBack());

    const colorDot = document.createElement('span');
    colorDot.className = 'categories__header-dot';
    colorDot.style.background = cat.color;

    const title = document.createElement('span');
    title.className = 'categories__title';
    title.textContent = cat.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'categories__detail-count';
    countSpan.textContent = `${videoPaths.length} video${videoPaths.length !== 1 ? 's' : ''}`;

    header.appendChild(backBtn);
    header.appendChild(colorDot);
    header.appendChild(title);
    header.appendChild(countSpan);
    this._addViewToggle(header);
    this._container.appendChild(header);

    // Video grid
    const wrapper = document.createElement('div');
    wrapper.className = 'categories__grid-wrapper';

    // Filter out videos that no longer exist on disk
    const validPaths = [];
    for (const vp of videoPaths) {
      const exists = await window.funsync.fileExists(vp);
      if (exists) validPaths.push(vp);
    }

    // Clean up dead paths
    if (validPaths.length < videoPaths.length) {
      for (const dead of videoPaths.filter(p => !validPaths.includes(p))) {
        this._settings.unassignCategory(dead, categoryId);
      }
    }

    // Update count display with valid count
    countSpan.textContent = `${validPaths.length} video${validPaths.length !== 1 ? 's' : ''}`;

    if (validPaths.length === 0) {
      wrapper.innerHTML = `
        <div class="categories__empty">
          <div class="categories__empty-text">No videos in this category</div>
          <div class="categories__empty-hint">Assign videos from the Library using the kebab menu</div>
        </div>
      `;
      this._container.appendChild(wrapper);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'categories__grid';
    grid.classList.toggle('categories__grid--list', this._viewMode === 'list');

    for (const videoPath of validPaths) {
      const el = this._viewMode === 'list' ? this._createVideoListItem(videoPath, cat) : this._createVideoCard(videoPath, cat);
      grid.appendChild(el);
    }

    wrapper.appendChild(grid);
    this._container.appendChild(wrapper);
  }

  _createVideoCard(videoPath, category) {
    const card = document.createElement('div');
    card.className = 'categories__video-card';

    const thumbnail = document.createElement('div');
    thumbnail.className = 'categories__video-thumbnail';

    const placeholder = document.createElement('div');
    placeholder.className = 'categories__video-placeholder';
    placeholder.appendChild(icon(Clapperboard, { width: 32, height: 32 }));
    thumbnail.appendChild(placeholder);

    // Play overlay
    const overlay = document.createElement('div');
    overlay.className = 'categories__video-overlay';
    const playIconEl = document.createElement('span');
    playIconEl.className = 'categories__video-play-icon';
    playIconEl.appendChild(icon(Play, { width: 36, height: 36 }));
    overlay.appendChild(playIconEl);
    thumbnail.appendChild(overlay);

    // Unassign button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'categories__video-remove-btn';
    removeBtn.appendChild(icon(X, { width: 12, height: 12 }));
    removeBtn.title = 'Remove from category';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.unassignCategory(videoPath, category.id);
      this._renderDetail(category.id);
    });
    thumbnail.appendChild(removeBtn);

    card.appendChild(thumbnail);

    const info = document.createElement('div');
    info.className = 'categories__video-info';
    const name = videoPath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
    const titleEl = document.createElement('div');
    titleEl.className = 'categories__video-title';
    titleEl.textContent = name;
    titleEl.title = videoPath;
    info.appendChild(titleEl);
    card.appendChild(info);

    // Lazy thumbnail
    this._loadVideoThumbnail(card, thumbnail, videoPath);

    // Check for funscript and show badge
    this._checkFunscriptBadge(card, thumbnail, videoPath);

    card.addEventListener('click', () => {
      if (card.classList.contains('categories__video-card--broken')) return;
      this._playVideo(videoPath);
    });

    return card;
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
        const ph = thumbnailEl.querySelector('.categories__video-placeholder');
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
    const placeholder = thumbnailEl.querySelector('.categories__video-placeholder');
    if (placeholder) {
      placeholder.innerHTML = '';
      placeholder.appendChild(icon(FileX, { width: 32, height: 32 }));
      placeholder.classList.add('categories__video-placeholder--broken');
    }
    cardEl.classList.add('categories__video-card--broken');
    cardEl.title = `File not found: ${videoPath}`;
  }

  /**
   * Get a single representative frame for a card. Routes through the
   * backend's ffmpeg by default — much cheaper than the renderer's old
   * hidden-<video> decode. Falls back to the in-renderer path if the
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

  async _playVideo(videoPath) {
    const fileName = videoPath.split(/[\\/]/).pop();
    const fileData = { name: fileName, path: videoPath, _isPathBased: true };

    // Try to find a matching funscript — prefer library scan (auto-detects
    // + manual associations) over naive extension swap.
    let funscriptData = null;
    const funscriptPath = this._resolveFunscriptPath(videoPath);
    try {
      const content = await window.funsync.readFunscript(funscriptPath);
      if (content) {
        const fsName = funscriptPath.split(/[\\/]/).pop();
        funscriptData = { name: fsName, path: funscriptPath, textContent: content };
      }
    } catch { /* no funscript found — that's fine */ }

    this._onPlayVideo(fileData, funscriptData);
  }

  async _checkFunscriptBadge(cardEl, thumbnailEl, videoPath) {
    const funscriptPath = this._resolveFunscriptPath(videoPath);
    try {
      const content = await window.funsync.readFunscript(funscriptPath);
      if (!content) return;

      // Funscript icon badge on thumbnail
      const badge = document.createElement('span');
      badge.className = 'library__funscript-badge library__funscript-badge--auto';
      badge.title = 'Funscript linked';
      badge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
      thumbnailEl.appendChild(badge);

      // Speed gauge badge on info bar
      try {
        const parsed = JSON.parse(content);
        const actions = parsed?.actions;
        if (actions && actions.length >= 2) {
          const stats = computeSpeedStats(actions);
          if (stats.maxSpeed > 0) {
            const info = cardEl.querySelector('.categories__video-info');
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
    speedBadge.title = `Avg: ${stats.avgSpeed} units/s — Max: ${stats.maxSpeed} units/s`;
    speedBadge.appendChild(icon(Gauge, { width: 12, height: 12, 'stroke-width': 2.5 }));
    containerEl.appendChild(speedBadge);
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

  async _createCategory() {
    const result = await Modal.open({
      title: 'New Category',
      onRender(body, close) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
        input.placeholder = 'Category name';
        body.appendChild(input);

        const colorLabel = document.createElement('div');
        colorLabel.className = 'categories__color-label';
        colorLabel.textContent = 'Color';
        body.appendChild(colorLabel);

        let selectedColor = PRESET_COLORS[0];

        const swatches = document.createElement('div');
        swatches.className = 'categories__color-swatches';

        for (const color of PRESET_COLORS) {
          const swatch = document.createElement('button');
          swatch.className = 'categories__color-swatch';
          if (color === selectedColor) swatch.classList.add('categories__color-swatch--selected');
          swatch.style.background = color;
          swatch.addEventListener('click', () => {
            selectedColor = color;
            swatches.querySelectorAll('.categories__color-swatch').forEach((s) =>
              s.classList.toggle('categories__color-swatch--selected', s === swatch));
          });
          swatches.appendChild(swatch);
        }
        body.appendChild(swatches);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn--secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => close(null));

        const createBtn = document.createElement('button');
        createBtn.className = 'modal-btn modal-btn--primary';
        createBtn.textContent = 'Create';
        createBtn.addEventListener('click', () => {
          const val = input.value.trim();
          if (val) close({ name: val, color: selectedColor });
          else close(null);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(createBtn);
        body.appendChild(actions);

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createBtn.click();
          }
        });
      },
    });

    if (!result) return;
    await this._settings.addCategory(result.name, result.color);
    this._renderGrid();
  }

  async _renameCategory(cat) {
    const name = await Modal.prompt('Rename Category', 'New name', cat.name);
    if (!name) return;
    this._settings.renameCategory(cat.id, name);
    this._renderGrid();
  }

  async _deleteCategory(cat) {
    const confirmed = await Modal.confirm('Delete Category', `Delete "${cat.name}"? This cannot be undone.`);
    if (!confirmed) return;
    this._settings.deleteCategory(cat.id);
    this._renderGrid();
  }

  // --- View toggle ---

  _addViewToggle(header) {
    const group = document.createElement('div');
    group.className = 'view-toggle-group';

    const btnGrid = document.createElement('button');
    btnGrid.className = 'view-toggle view-toggle--grid';
    btnGrid.title = 'Grid view';
    btnGrid.appendChild(icon(LayoutGrid, { width: 16, height: 16 }));
    btnGrid.classList.toggle('view-toggle--active', this._viewMode === 'grid');
    btnGrid.addEventListener('click', () => this._setViewMode('grid'));

    const btnList = document.createElement('button');
    btnList.className = 'view-toggle view-toggle--list';
    btnList.title = 'List view';
    btnList.appendChild(icon(LayoutList, { width: 16, height: 16 }));
    btnList.classList.toggle('view-toggle--active', this._viewMode === 'list');
    btnList.addEventListener('click', () => this._setViewMode('list'));

    group.append(btnGrid, btnList);
    header.appendChild(group);
  }

  _setViewMode(mode) {
    if (this._viewMode === mode) return;
    this._viewMode = mode;
    if (this._view === 'detail' && this._detailCategoryId) {
      this._renderDetail(this._detailCategoryId);
    } else {
      this._renderGrid();
    }
  }

  _createCategoryListItem(cat, videoCount) {
    const row = document.createElement('div');
    row.className = 'categories__list-item';

    const dot = document.createElement('span');
    dot.className = 'categories__list-dot';
    dot.style.background = cat.color;

    const name = document.createElement('span');
    name.className = 'categories__list-name';
    name.textContent = cat.name;

    const count = document.createElement('span');
    count.className = 'categories__list-count';
    count.textContent = `${videoCount} video${videoCount !== 1 ? 's' : ''}`;

    const actions = document.createElement('div');
    actions.className = 'categories__list-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'categories__card-action-btn';
    renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this._renameCategory(cat); });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'categories__card-action-btn categories__card-action-btn--danger';
    deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); this._deleteCategory(cat); });

    actions.append(renameBtn, deleteBtn);
    row.append(dot, name, count, actions);

    row.addEventListener('click', () => {
      this._view = 'detail';
      this._detailCategoryId = cat.id;
      this._renderDetail(cat.id);
    });

    return row;
  }

  _createVideoListItem(videoPath, category) {
    const fileName = videoPath.split(/[\\/]/).pop() || videoPath;
    const row = document.createElement('div');
    row.className = 'categories__list-item';

    const title = document.createElement('span');
    title.className = 'categories__list-name';
    title.textContent = fileName.replace(/\.[^/.]+$/, '');
    title.title = fileName;

    const funscriptPath = this._resolveFunscriptPath(videoPath);
    const heatmap = document.createElement('canvas');
    heatmap.className = 'categories__list-heatmap';

    const badges = document.createElement('div');
    badges.className = 'categories__list-badges';
    const fsBadge = document.createElement('span');
    fsBadge.className = 'library__funscript-badge--inline library__funscript-badge--auto';
    fsBadge.appendChild(icon(FileCheck, { width: 14, height: 14, 'stroke-width': 2.5 }));
    fsBadge.hidden = true;
    badges.appendChild(fsBadge);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'categories__card-action-btn categories__card-action-btn--danger';
    removeBtn.appendChild(icon(X, { width: 14, height: 14 }));
    removeBtn.title = 'Remove from category';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.unassignCategory(videoPath, category.id);
      this._renderDetail(category.id);
    });

    row.append(title, heatmap, badges, removeBtn);

    row.addEventListener('click', () => {
      this._playVideoByPath(videoPath);
    });

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
        if (rowEl) rowEl.classList.add('categories__list-item--no-heatmap');
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
      if (rowEl) rowEl.classList.add('categories__list-item--no-heatmap');
      if (heatmapEl) heatmapEl.remove();
    }
  }
}
