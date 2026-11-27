// Categories — Grid view of categories with detail view showing videos

import { Modal } from './modal.js';
import { createCategoryMark } from '../js/category-icon.js';
import { icon, Tag, Plus, Pencil, Trash2, ArrowLeft, X, Clapperboard, Play, FileX, FileCheck, Gauge, LayoutGrid, LayoutList, Unplug, Shuffle, SlidersHorizontal, Link } from '../js/icons.js';
import { isStreamPath } from '../js/saved-streams.js';
import {
  probeAvailability,
  availabilityPredicate,
  partitionByAvailability,
  groupByVolume,
  foldersPresent,
} from '../js/playlist-availability.js';
import { computeSpeedStats } from '../js/library-search.js';
import { computeBins, queueRenderBins } from '../js/heatmap-strip.js';
import { normalizeAssociation, resolveActiveConfig } from '../js/association-shape.js';
import { pathToFileURL } from '../js/path-utils.js';
import { promptCreateCategory, promptCategoryDetails, PRESET_COLORS } from '../js/category-create-modal.js';
import { t } from '../js/i18n.js';
import { isDisabled } from '../js/disabled-videos.js';
import { applyDisabledMark } from './disabled-mark.js';
import { eventBus } from '../js/event-bus.js';
import { thumbRequestOpts, customThumbImagePath } from './library.js';
import * as thumbCache from '../js/thumbnail-cache.js';
import { buildNoVideoTile, fileNameOf } from '../js/no-video-tile.js';
import { isAudioPath, audioDuration } from '../js/video-load-check.js';
import { dedupeThumbRequest } from '../js/thumb-inflight.js';
import { noticeUnreadableScript } from '../js/script-access-notice.js';
import { createQueueToggleButton } from './queue-panel.js';
import { libraryPlayRequest, anyLibraryPlayOption, readLibraryPlayOptions, setLibraryPlayOption } from '../js/library-play-options.js';
import { openPlayOptionsModal } from './play-options-modal.js';

export class Categories {
  constructor({ settings, onPlayVideo, onPlayAll, library, onToggleQueue, isQueueOpen }) {
    this._settings = settings;
    this._onPlayVideo = onPlayVideo;
    // Play all / Shuffle all in the detail header (#381); app.js `_playAll`.
    this._onPlayAll = onPlayAll || null;
    this._onToggleQueue = onToggleQueue || null;
    this._isQueueOpen = isQueueOpen || null;
    this._library = library || null;
    this._container = null;
    this._view = 'grid'; // 'grid' or 'detail'
    this._detailCategoryId = null;
    this._viewMode = 'grid';
    this._binsByPath = new Map();
  }

  /** A video's shown name: a saved stream's title (2026-11-23), else its file name without the extension. */
  _nameOf(videoPath) {
    const v = isStreamPath(videoPath) ? this._library?.getVideoByPath?.(videoPath) : null;
    return v?.name || String(videoPath).split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
  }

  _resolveFunscriptPath(videoPath) {
    // Library scan is the source of truth — it holds scanner-normalized
    // auto-detects (e.g. "Foo (Part B).mp4" → "Foo (Part B).funscript") AND
    // already-applied manual associations. Naive extension swap misses
    // normalized matches, so try library first.
    const libVideo = this._library?.getVideoByPath(videoPath);
    if (libVideo?.funscriptPath) return libVideo.funscriptPath;
    if (isStreamPath(videoPath)) return null;          // a saved stream's script is on its record

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
    // The FILE's extension only: [^/\\.] also stops at a Windows separator, so
    // C:\Lib.d\Clip never becomes C:\Lib.funscript (FT-069 / FT-070, 2026-11-22).
    return videoPath.replace(/\.[^/\\.]+$/, '.funscript');
  }

  /**
   * Is the script `_resolveFunscriptPath` names one the app EXPECTS (the
   * library's scanned pairing, or an association), rather than the
   * `<name>.funscript` guess for a video with neither? Play All warns only
   * about an expected script it cannot read (app.js `_loadQueueItemContent`,
   * CB-12). Mirrors Playlists `_hasExplicitAssociation`.
   */
  _scriptExpected(videoPath) {
    if (this._library?.getVideoByPath(videoPath)?.funscriptPath) return true;
    const associations = this._settings.get('library.associations') || {};
    const resolved = resolveActiveConfig(normalizeAssociation(associations[videoPath]));
    if (!resolved) return false;
    if (resolved.kind === 'single') return !!resolved.config;
    if (resolved.kind === 'multi') return !!resolved.config.main;
    if (resolved.kind === 'custom') {
      return (resolved.config.routes || []).some((r) => r.role === 'main' && r.scriptPath);
    }
    return false;
  }

  show(containerEl) {
    this._container = containerEl;
    // Re-render on locale change — kebab tooltips, empty-state text,
    // Back-to-categories aria, etc. are all baked via t() into innerHTML
    // at render time, so translatePage() doesn't catch them.
    if (!this._languageListenerAttached) {
      eventBus.on('language:changed', () => {
        if (!this._container) return;
        if (this._view === 'detail' && this._detailCategoryId) {
          this._renderDetail(this._detailCategoryId);
        } else {
          this._renderGrid();
        }
      });
      this._languageListenerAttached = true;
    }
    if (this._view === 'detail' && this._detailCategoryId) {
      this._renderDetail(this._detailCategoryId);
    } else {
      this._view = 'grid';
      this._renderGrid();
    }
  }

  hide() {
    this._supersedeRender();
    if (this._container) {
      this._container.innerHTML = '';
    }
  }

  /**
   * Start a render pass and return its number; any detail render still
   * waiting on its availability probe drops its grid (FT-034). The detail
   * empties the container, awaits the probe, then appends, so two calls in
   * that gap (Back to <category> after Play All rendered from both show()
   * and app.js) each appended a grid: the videos showed twice.
   */
  _supersedeRender() {
    this._renderGen = (this._renderGen || 0) + 1;
    return this._renderGen;
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
    this._supersedeRender();
    const categories = this._settings.getCategories();
    this._container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'categories__header';
    header.innerHTML = `<span class="categories__title">${t('categories.title')}</span>`;
    this._addViewToggle(header);
    this._addQueueToggle(header);
    this._container.appendChild(header);

    const wrapper = document.createElement('div');
    wrapper.className = 'categories__grid-wrapper';

    if (categories.length === 0) {
      wrapper.innerHTML = `
        <div class="categories__empty">
          <div class="categories__empty-icon"></div>
          <div class="categories__empty-text">${t('categories.emptyTitle')}</div>
          <button class="categories__empty-cta">${t('categories.emptyCta')}</button>
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
      <div class="categories__card-create-label">${t('categories.newCategory')}</div>
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
    // Icon in front of the name, so a chosen shape/emoji is visible on the
    // card and not only on video thumbnails.
    name.appendChild(createCategoryMark(cat, {
      className: 'categories__card-name-mark',
      size: 12,
    }));
    name.appendChild(document.createTextNode(cat.name));

    const count = document.createElement('div');
    count.className = 'categories__card-count';
    count.textContent = t('library.videoCount', { count: videoCount }); // in the language chosen (B102)

    body.appendChild(name);
    body.appendChild(count);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'categories__card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'categories__card-action-btn';
    renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
    renameBtn.title = t('common.rename');
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._renameCategory(cat);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'categories__card-action-btn categories__card-action-btn--danger';
    deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
    deleteBtn.title = t('common.delete');
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
    const renderGen = this._supersedeRender();
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
    backBtn.title = t('categories.backToCategories');
    backBtn.addEventListener('click', () => this.navigateBack());

    const colorDot = createCategoryMark(cat, { className: 'categories__header-dot' });

    const title = document.createElement('span');
    title.className = 'categories__title';
    title.textContent = cat.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'categories__detail-count';
    countSpan.textContent = t('library.videoCount', { count: videoPaths.length }); // in the language chosen (B102)

    header.appendChild(backBtn);
    header.appendChild(colorDot);
    header.appendChild(title);
    header.appendChild(countSpan);
    if (this._onPlayAll && videoPaths.length > 0) this._addPlayButtons(header, cat);
    this._addViewToggle(header);
    this._addQueueToggle(header);
    this._container.appendChild(header);

    // Video grid
    const wrapper = document.createElement('div');
    wrapper.className = 'categories__grid-wrapper';

    // Availability, NOT a purge.
    //
    // This block used to probe each path with fileExists and call
    // unassignCategory() on every miss — so opening a category while its
    // drive was unplugged PERMANENTLY stripped every video on that drive out
    // of the category, and reconnecting could not bring them back because
    // config.json had already been rewritten. The identical bug was fixed for
    // playlists on 2026-08-06 (see playlist-availability.js) and missed here
    // (app test V01, 2026-11-02). Absence of a volume is not deletion of a file.
    //
    // Every assignment now stays. Unreachable videos render greyed out, a
    // click on one explains instead of playing, and Up Next walks past them
    // (it only offers what the library holds, and an offline source is not
    // scanned). Category plays have no prev/next — that is playlists-only.
    // Re-probed on each render, so a reconnect just works. Only the user's
    // explicit remove button unassigns.
    const availableSet = await probeAvailability(videoPaths);
    if (renderGen !== this._renderGen) return; // a newer render owns the container
    const isAvailable = availabilityPredicate(availableSet);
    const validPaths = videoPaths.slice();
    const { unavailable } = partitionByAvailability(videoPaths, isAvailable);

    if (validPaths.length === 0) {
      wrapper.innerHTML = `
        <div class="categories__empty">
          <div class="categories__empty-text">${t('categories.detailEmpty')}</div>
          <div class="categories__empty-hint">${t('categories.detailEmptyHint')}</div>
        </div>
      `;
      this._container.appendChild(wrapper);
      return;
    }

    // Explain the greyed tiles rather than leaving the user to wonder why
    // some are dim. Grouped by volume: "3 videos on E: are unavailable" is
    // actionable, three filenames aren't.
    if (unavailable.length > 0) {
      wrapper.appendChild(this._createUnavailableNotice(unavailable));
    }

    const grid = document.createElement('div');
    grid.className = 'categories__grid';
    grid.classList.toggle('categories__grid--list', this._viewMode === 'list');

    // The category's path list as the play context, so Up Next can advance
    // through it: ONE snapshot per render, shared by every card (contexts are
    // never mutated, SCOPE §3.5); each card has its own index. A copy and an
    // indexOf per card was a million steps for a 1,000-video category
    // (DESIGN.md §2.17).
    const contextList = validPaths.slice();
    for (const [index, videoPath] of validPaths.entries()) {
      const playContext = {
        source: 'category',
        sourceLabel: `category "${cat.name}"`,
        sourceContext: { categoryId: cat.id },
        list: contextList,
        index,
      };
      const available = isAvailable(videoPath);
      const el = this._viewMode === 'list'
        ? this._createVideoListItem(videoPath, cat, playContext, available)
        : this._createVideoCard(videoPath, cat, playContext, available);
      if (!available) this._markUnavailable(el, videoPath);
      // Disabled (zaikechi #381): dimmed and marked, still playable by hand.
      if (isDisabled(this._settings, videoPath)) {
        applyDisabledMark(el, true, {
          thumb: el.querySelector('.categories__video-thumbnail'),
          title: el.querySelector('.categories__list-name') || el.querySelector('.categories__video-title'),
        });
      }
      grid.appendChild(el);
    }

    wrapper.appendChild(grid);
    this._container.appendChild(wrapper);
  }

  /**
   * Play all / Shuffle all for this category, plus the play options button
   * (zaikechi #381). Styled with the playlist header's own buttons, since
   * they do the same thing. The options are the Library's (Loop, equal turn
   * per script, prefer unwatched), shared with its Shuffle All.
   */
  _addPlayButtons(header, cat) {
    const playAllBtn = document.createElement('button');
    playAllBtn.type = 'button';
    playAllBtn.className = 'playlists__play-all-btn categories__play-all-btn';
    playAllBtn.appendChild(icon(Play, { width: 14, height: 14 }));
    playAllBtn.appendChild(document.createTextNode(' ' + t('playlists.playAll')));
    playAllBtn.addEventListener('click', () => this._playAllInCategory(cat.id, { shuffle: false }));
    header.appendChild(playAllBtn);

    const shuffleBtn = document.createElement('button');
    shuffleBtn.type = 'button';
    shuffleBtn.className = 'playlists__loop-btn categories__shuffle-all-btn';
    shuffleBtn.title = t('library.shuffleAllTitle');
    shuffleBtn.appendChild(icon(Shuffle, { width: 14, height: 14 }));
    shuffleBtn.appendChild(document.createTextNode(' ' + t('library.shuffleAll')));
    shuffleBtn.addEventListener('click', () => this._playAllInCategory(cat.id, { shuffle: true }));
    header.appendChild(shuffleBtn);

    const optionsBtn = document.createElement('button');
    optionsBtn.type = 'button';
    optionsBtn.className = 'playlists__loop-btn categories__play-options-btn';
    optionsBtn.title = t('library.playOptions.openTitle');
    optionsBtn.setAttribute('aria-label', optionsBtn.title);
    optionsBtn.setAttribute('aria-haspopup', 'dialog');
    optionsBtn.appendChild(icon(SlidersHorizontal, { width: 14, height: 14 }));
    const paint = () => optionsBtn.classList.toggle('is-on', anyLibraryPlayOption(this._settings));
    paint();
    optionsBtn.addEventListener('click', () => openPlayOptionsModal({
      title: t('library.playOptions.title'),
      values: readLibraryPlayOptions(this._settings),
      includeLoop: true,
      shuffleOn: true,
      note: t('library.playOptions.shuffleNote'),
      onChange: (key, on) => { setLibraryPlayOption(this._settings, key, on); paint(); },
    }));
    header.appendChild(optionsBtn);
  }

  /**
   * Hand the category's reachable videos to Play All, in the detail view's
   * order, or shuffled. Unreachable ones are skipped for this queue and stay
   * in the category (absence is never destructive), with the same toasts a
   * playlist's Play All gives.
   */
  async _playAllInCategory(categoryId, { shuffle = false } = {}) {
    if (!this._onPlayAll) return;
    const cat = this._settings.getCategories().find((c) => c.id === categoryId);
    if (!cat) return;
    const paths = this._settings.getVideosByCategory(categoryId);
    const isAvailable = availabilityPredicate(await probeAvailability(paths));
    const { available, unavailable } = partitionByAvailability(paths, isAvailable);
    if (available.length === 0) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.playlistAllUnavailable'), 'warn');
      return;
    }
    if (unavailable.length > 0) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.playlistSkippedUnavailable', { count: unavailable.length }), 'info');
    }
    const videoList = available.map((p) => ({
      name: isStreamPath(p) ? this._nameOf(p) : p.split(/[\\/]/).pop(),
      path: p,
      funscriptPath: this._resolveFunscriptPath(p),
      scriptExpected: this._scriptExpected(p), // CB-12: a guess stays quiet
    }));
    this._onPlayAll(videoList, {
      ...libraryPlayRequest(this._settings),
      shuffle: !!shuffle,
      sourceLabel: cat.name,
      sourceContext: { kind: 'category', id: cat.id },
    });
  }

  /**
   * Banner above the grid: why some tiles are dim. Mirrors playlists.js —
   * same volume grouping, same strings, except the hint says the videos stay
   * in the CATEGORY.
   */
  _createUnavailableNotice(unavailablePaths) {
    const notice = document.createElement('div');
    notice.className = 'categories__unavailable-notice';
    notice.setAttribute('role', 'status');
    const mark = icon(Unplug, { width: 16, height: 16 });
    notice.appendChild(mark);

    const text = document.createElement('span');
    const named = [...groupByVolume(unavailablePaths).entries()].filter(([root]) => root);
    if (named.length === 1 && named[0][1].length === unavailablePaths.length) {
      text.textContent = t('playlists.unavailableOnVolume', { count: unavailablePaths.length, volume: named[0][0] });
    } else {
      text.textContent = t('playlists.unavailableCount', { count: unavailablePaths.length });
    }
    notice.appendChild(text);

    const hint = document.createElement('span');
    hint.className = 'categories__unavailable-hint';
    // The count, so one video reads "play it. It stays" (test day B028).
    hint.textContent = t('categories.unavailableHint', { count: unavailablePaths.length });
    notice.appendChild(hint);
    // Their folders all there: renamed, moved or deleted, not a drive away
    // (test day 2026-11-26, S030). Kept for tests.
    this._unavailableHintCheck = foldersPresent(unavailablePaths).then((present) => {
      if (!present) return false;
      hint.textContent = t('categories.unavailableMovedHint', { count: unavailablePaths.length });
      mark.replaceWith(icon(FileX, { width: 16, height: 16 }));
      return true;
    });
    return notice;
  }

  /**
   * Grey out one card/row and take it out of play. The remove button stays
   * live so a genuinely dead entry can still be cleared BY HAND — that is the
   * only path allowed to unassign.
   */
  _markUnavailable(el, videoPath) {
    el.classList.add('categories__video--unavailable');
    el.dataset.unavailable = 'true';
    el.title = t('playlists.unavailableTooltip', { path: videoPath });

    const badge = document.createElement('span');
    badge.className = 'categories__unavailable-badge';
    badge.appendChild(icon(Unplug, { width: 12, height: 12 }));
    const thumb = el.querySelector('.categories__video-thumbnail');
    if (thumb) {
      thumb.appendChild(badge);
      return;
    }
    // List rows have no thumbnail — put the marker inline before the title.
    badge.classList.add('categories__unavailable-badge--inline');
    const title = el.querySelector('.categories__list-name');
    if (title && title.parentNode) title.parentNode.insertBefore(badge, title);
    else el.insertBefore(badge, el.firstChild);
  }

  /**
   * A click on a greyed tile. Re-probe first: the likeliest reason someone
   * clicks it is that they just plugged the drive back in.
   */
  async _notifyUnavailable(videoPath) {
    const set = await probeAvailability([videoPath]);
    if (set.has(videoPath)) {
      if (this._detailCategoryId) await this._renderDetail(this._detailCategoryId);
      return;
    }
    const { showToast } = await import('../js/toast.js');
    showToast(t('toast.videoUnavailable'), 'warn');
  }

  /**
   * @param {boolean} [available=true] false when the probe says this video's
   *   drive is offline. Such a tile reads NOTHING from disk — see below.
   */
  _createVideoCard(videoPath, category, playContext, available = true) {
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
    removeBtn.title = t('categories.removeFromCategory');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.unassignCategory(videoPath, category.id);
      this._renderDetail(category.id);
    });
    thumbnail.appendChild(removeBtn);

    card.appendChild(thumbnail);

    const info = document.createElement('div');
    info.className = 'categories__video-info';
    const name = this._nameOf(videoPath);
    const titleEl = document.createElement('div');
    titleEl.className = 'categories__video-title';
    titleEl.textContent = name;
    titleEl.title = videoPath;
    info.appendChild(titleEl);
    card.appendChild(info);

    if (available) {
      // Lazy thumbnail
      this._loadVideoThumbnail(card, thumbnail, videoPath);

      // Check for funscript and show badge
      this._checkFunscriptBadge(card, thumbnail, videoPath);
    } else {
      // Offline: the thumbnail CACHE only, no disk or backend I/O. Every
      // request here would fail — a backend thumbnail plus a hidden-<video>
      // fallback, and an error-level read-funscript ENOENT per tile — and ten
      // failed thumbnails trip main's "thumbnail generation is broken for
      // this whole library" error, which is false. A click re-probes and
      // re-renders, so a reconnected drive gets the full load then.
      this._showCachedThumbnail(thumbnail, videoPath);
    }

    card.addEventListener('click', () => {
      // Unreachable right now (drive unplugged): explain instead of opening a
      // player that will fail. Checked before --broken, because a thumbnail
      // capture on an unplugged drive also fails and would mark it broken.
      if (card.dataset.unavailable === 'true') {
        this._notifyUnavailable(videoPath);
        return;
      }
      if (card.classList.contains('categories__video-card--broken')) return;
      this._playVideo(videoPath, playContext);
    });

    return card;
  }

  async _loadVideoThumbnail(cardEl, thumbnailEl, videoPath) {
    try {
      const result = await this._captureFrame(videoPath);
      if (!this._applyThumbnail(thumbnailEl, result)) {
        this._showBrokenLink(cardEl, thumbnailEl, videoPath);
      }
    } catch {
      this._showBrokenLink(cardEl, thumbnailEl, videoPath);
    }
    this._markStreamTile(thumbnailEl, videoPath);
  }

  /** A saved stream's tile (2026-11-23): its link icon and its length, as its library card has. */
  _markStreamTile(thumbnailEl, videoPath) {
    if (!isStreamPath(videoPath) || !thumbnailEl) return;
    const v = this._library?.getVideoByPath?.(videoPath);
    this._addDurationBadge(thumbnailEl, v?.duration);
    if (thumbnailEl.querySelector('.stream-tile-badge')) return;
    const b = document.createElement('span');
    b.className = 'library__stream-badge stream-tile-badge';
    const label = v?.site ? t('library.streams.badgeSite', { site: v.site }) : t('library.streams.badge');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(Link, { width: 13, height: 13, 'stroke-width': 2.5 }));
    thumbnailEl.appendChild(b);
  }

  /**
   * An offline tile: draw it from the shared thumbnail cache if the library
   * or another view already fetched it this session, otherwise keep the
   * placeholder. Never requests anything.
   */
  _showCachedThumbnail(thumbnailEl, videoPath) {
    this._applyThumbnail(thumbnailEl, thumbCache.getEntry(videoPath, 0));
  }

  /** Put a capture result on the tile. False when there is no image. */
  _applyThumbnail(thumbnailEl, result) {
    // No video track (an audio file): the grey logo tile, as the Library
    // shows it (N-05, TODO triage 2026-11-23: a black frame here).
    if (result?.noVideo) {
      thumbnailEl.querySelector('.categories__video-placeholder')?.remove();
      thumbnailEl.querySelector('.library__thumb-novideo')?.remove();
      thumbnailEl.insertBefore(buildNoVideoTile(result.name), thumbnailEl.firstChild);
      if (result.duration) this._addDurationBadge(thumbnailEl, result.duration);
      return true;
    }
    const dataUrl = result?.dataUrl || result;
    if (!dataUrl) return false;
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
    return true;
  }

  _showBrokenLink(cardEl, thumbnailEl, videoPath) {
    // A saved stream with no picture of its own is not broken: the link
    // icon, and it still plays (2026-11-23).
    if (isStreamPath(videoPath)) {
      const ph = thumbnailEl.querySelector('.categories__video-placeholder');
      if (ph) { ph.innerHTML = ''; ph.appendChild(icon(Link, { width: 28, height: 28 })); }
      cardEl.title = t('library.streams.badge');
      return;
    }
    // An unplugged drive also fails the thumbnail capture. Don't relabel an
    // unavailable tile "File not found" — that reads as the file being gone.
    if (cardEl.dataset.unavailable === 'true') return;
    const placeholder = thumbnailEl.querySelector('.categories__video-placeholder');
    if (placeholder) {
      placeholder.innerHTML = '';
      placeholder.appendChild(icon(FileX, { width: 32, height: 32 }));
      placeholder.classList.add('categories__video-placeholder--broken');
    }
    cardEl.classList.add('categories__video-card--broken');
    cardEl.title = t('library.fileNotFound', { path: videoPath });
  }

  /**
   * Get a single representative frame for a card. Routes through the
   * backend's ffmpeg by default — much cheaper than the renderer's old
   * hidden-<video> decode. Falls back to the in-renderer path if the
   * backend isn't reachable. Mirrors the same change in library.js.
   */
  async _captureFrame(videoPath) {
    // Shared in-memory cache FIRST — same rationale as playlists.js: the
    // dedup below only collapses concurrent in-flight requests, so without
    // this every Library → Categories switch re-fetched every visible tile.
    // mtime key 0 matches library.js so all three views share one set of
    // entries, including the library's invalidation on thumbnail changes.
    const cached = thumbCache.getEntry(videoPath, 0);
    if (cached) return cached;
    const known = this._noVideo?.get(videoPath);
    if (known) return known;
    // Deduped: shares in-flight captures with the library/playlists views.
    const result = await dedupeThumbRequest(videoPath, () => this._captureFrameUncached(videoPath));
    const dataUrl = result?.dataUrl || result;
    if (typeof dataUrl === 'string' && dataUrl) {
      thumbCache.set(videoPath, 0, dataUrl, result?.duration);
    } else if (result?.noVideo) {
      (this._noVideo ||= new Map()).set(videoPath, result);
    }
    return result;
  }

  async _captureFrameUncached(videoPath) {
    // Honor a user-pinned thumbnail frame ("Set thumbnail frame…" in the
    // library) so category cards show the same tile as the library grid.
    const custom = (this._settings?.get?.('library.customThumbnails') || {})[videoPath];
    // User-uploaded poster image wins outright (mirrors library.js).
    const imagePath = customThumbImagePath(custom);
    if (imagePath && window.funsync?.readCustomThumbnail) {
      try {
        const img = await window.funsync.readCustomThumbnail(imagePath);
        if (img?.dataUrl) return { dataUrl: img.dataUrl, duration: 0 };
      } catch { /* fall through to frame path */ }
    }
    if (isStreamPath(videoPath)) return null;          // no file to grab a frame from
    // An audio file: its tile, never ffmpeg (a 500 for every one, every
    // launch; Dave's log 2026-11-26) or a hidden <video>.
    if (isAudioPath(videoPath)) {
      return { noVideo: true, audio: true, name: fileNameOf(videoPath), duration: await audioDuration(videoPath, this._library?.getVideoByPath?.(videoPath)?.duration, window.funsync) };
    }
    const { seekPct, exact } = thumbRequestOpts(custom);
    if (window.funsync?.generateSingleThumbnail) {
      try {
        const result = await window.funsync.generateSingleThumbnail(videoPath, { seekPct, width: 320, exact });
        if (result?.dataUrl) return { dataUrl: result.dataUrl, duration: result.duration || 0 };
      } catch { /* fall through */ }
    }
    return this._captureFrameViaVideoElement(videoPath, exact ? seekPct : null);
  }

  _captureFrameViaVideoElement(videoPath, pinnedSeekPct = null) {
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
        // No video track (an audio file, N-05): a blank canvas would encode
        // to a black JPEG, cached and shown for good. Say so instead.
        if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
          clearTimeout(timeout);
          const duration = isFinite(video.duration) ? video.duration : 0;
          cleanup();
          resolve({ dataUrl: null, duration, noVideo: true, name: fileNameOf(videoPath) });
          return;
        }
        video.currentTime = (typeof pinnedSeekPct === 'number' && isFinite(pinnedSeekPct))
          ? video.duration * pinnedSeekPct
          : Math.min(video.duration * 0.1, 5);
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

  async _playVideo(videoPath, playContext) {
    const fileName = videoPath.split(/[\\/]/).pop();
    const fileData = { name: fileName, path: videoPath, _isPathBased: true };
    if (playContext) fileData._playContext = playContext;

    // Prefer the library video record (carries `_multiAxis` /
    // `_customRouting` from explicit or auto-promoted associations).
    // Falls back to path-only resolution when the video has been
    // removed from any active source.
    const libVideo = this._library?.getVideoByPath?.(videoPath);
    // A saved stream: the library plays it, in this category's order (2026-11-23).
    if (libVideo?._stream) {
      return this._library._playVideo({ ...libVideo, _playContextOverride: fileData._playContext || undefined });
    }
    const funscriptPath = (libVideo?.hasFunscript && libVideo.funscriptPath)
      ? libVideo.funscriptPath
      : this._resolveFunscriptPath(videoPath);

    let funscriptData = null;
    let subtitleData = null;
    let variants;
    if (libVideo && typeof this._library.resolvePlayData === 'function') {
      // What a click on the library card loads (FT-070): the script with
      // its companions and routing, the subtitle and the variants. This
      // route passed only the script, so a category click had no subtitle
      // and an empty variant picker.
      let triedSidecar = null;
      ({ funscriptData, subtitleData, variants, triedSidecar } =
        await this._library.resolvePlayData(libVideo));
      // The record has no script: an association, else `<name>.funscript`,
      // quietly, unless that is the file just tried.
      if (!(libVideo.hasFunscript && libVideo.funscriptPath) && funscriptPath
          && funscriptPath !== triedSidecar
          && !funscriptData?.textContent && !funscriptData?._customRouting) {
        let content = null;
        try { content = await window.funsync.readFunscript(funscriptPath); } catch { /* quiet */ }
        if (content) {
          funscriptData = {
            ...funscriptData, // keeps a vib-only `_multiAxis`
            name: funscriptPath.split(/[\\/]/).pop(),
            textContent: content,
            _funscriptPath: funscriptPath,
          };
        }
      }
    } else {
      // Not in the library (its source was removed): path-only, as before.
      // `_funscriptPath`, the field a library click sets (it was `path`
      // here); app.js reads either for the editor's save target.
      try {
        const content = await window.funsync.readFunscript(funscriptPath);
        if (content) {
          const fsName = funscriptPath.split(/[\\/]/).pop();
          funscriptData = { name: fsName, textContent: content, _funscriptPath: funscriptPath };
        }
      } catch { /* no funscript found — that's fine */ }
    }

    this._onPlayVideo(fileData, funscriptData, subtitleData, variants);
    // A script there that cannot be reached (a locked folder): say so once
    // instead of playing without sync in silence (R3-18).
    if (!funscriptData?.textContent) noticeUnreadableScript(funscriptPath);
  }

  async _checkFunscriptBadge(cardEl, thumbnailEl, videoPath) {
    const funscriptPath = this._resolveFunscriptPath(videoPath);
    if (!funscriptPath) return;
    try {
      const content = await window.funsync.readFunscript(funscriptPath);
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
    speedBadge.title = t('library.speedBadgeTitle', { avg: stats.avgSpeed, max: stats.maxSpeed });
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
    const id = await promptCreateCategory({ settings: this._settings });
    if (!id) return;
    this._renderGrid();
  }

  /**
   * Edit an existing category: name, colour AND icon.
   *
   * Was rename-only. An icon picker that only appears when CREATING a
   * category is useless to anyone who already has some, which is everyone
   * who would want this — so the pencil now opens the full form.
   */
  async _renameCategory(cat) {
    const result = await promptCategoryDetails({
      title: t('categories.editCategory'),
      confirmLabel: t('common.save'),
      initial: { name: cat.name, color: cat.color, icon: cat.icon || null },
    });
    if (!result) return;
    if (result.name !== cat.name) this._settings.renameCategory(cat.id, result.name);
    if (result.color !== cat.color) this._settings.setCategoryColor(cat.id, result.color);
    // Compared by value: the picker rebuilds the object each time, so an
    // identity check would write on every save even when nothing changed.
    const before = JSON.stringify(cat.icon || null);
    const after = JSON.stringify(result.icon || null);
    if (before !== after) this._settings.setCategoryIcon(cat.id, result.icon);
    this._renderGrid();
  }

  async _deleteCategory(cat) {
    const confirmed = await Modal.confirm(t('categories.deleteCategory'), t('categories.confirmDelete'), { confirmText: t('common.delete') });
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
    btnGrid.title = t('categories.gridView');
    btnGrid.appendChild(icon(LayoutGrid, { width: 16, height: 16 }));
    btnGrid.classList.toggle('view-toggle--active', this._viewMode === 'grid');
    btnGrid.addEventListener('click', () => this._setViewMode('grid'));

    const btnList = document.createElement('button');
    btnList.className = 'view-toggle view-toggle--list';
    btnList.title = t('categories.listView');
    btnList.appendChild(icon(LayoutList, { width: 16, height: 16 }));
    btnList.classList.toggle('view-toggle--active', this._viewMode === 'list');
    btnList.addEventListener('click', () => this._setViewMode('list'));

    group.append(btnGrid, btnList);
    header.appendChild(group);
  }

  /**
   * Queue panel toggle, far right like the Library header's (V27): the
   * queue opens from every browse view, not only by Shift+Q. Skipped when
   * the app wired no handler.
   */
  _addQueueToggle(header) {
    if (!this._onToggleQueue) return;
    header.appendChild(createQueueToggleButton({
      onToggle: this._onToggleQueue,
      open: !!this._isQueueOpen?.(),
    }));
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

    const dot = createCategoryMark(cat, { className: 'categories__list-dot', size: 10 });

    const name = document.createElement('span');
    name.className = 'categories__list-name';
    name.textContent = cat.name;

    const count = document.createElement('span');
    count.className = 'categories__list-count';
    count.textContent = t('library.videoCount', { count: videoCount }); // in the language chosen (B102)

    const actions = document.createElement('div');
    actions.className = 'categories__list-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'categories__card-action-btn';
    renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
    renameBtn.title = t('common.rename');
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this._renameCategory(cat); });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'categories__card-action-btn categories__card-action-btn--danger';
    deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
    deleteBtn.title = t('common.delete');
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

  /** @param {boolean} [available=true] see `_createVideoCard`. */
  _createVideoListItem(videoPath, category, playContext, available = true) {
    const fileName = videoPath.split(/[\\/]/).pop() || videoPath;
    const shown = this._nameOf(videoPath);
    const row = document.createElement('div');
    row.className = 'categories__list-item';

    const title = document.createElement('span');
    title.className = 'categories__list-name';
    title.textContent = shown;
    title.title = isStreamPath(videoPath) ? shown : fileName;

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
    removeBtn.title = t('categories.removeFromCategory');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.unassignCategory(videoPath, category.id);
      this._renderDetail(category.id);
    });

    row.append(title, heatmap, badges, removeBtn);

    row.addEventListener('click', () => {
      if (row.dataset.unavailable === 'true') {
        this._notifyUnavailable(videoPath);
        return;
      }
      this._playVideo(videoPath, playContext);
    });

    if (available) {
      this._loadListStats(videoPath, funscriptPath, fsBadge, badges, heatmap, row);
    } else {
      // Offline: cached heatmap bins only, no read-funscript (each one would
      // log an error-level ENOENT for a path we already know is unreachable).
      const cachedBins = this._binsByPath.get(videoPath);
      if (cachedBins) {
        queueRenderBins(heatmap, cachedBins);
      } else {
        row.classList.add('categories__list-item--no-heatmap');
        heatmap.remove();
      }
    }

    return row;
  }

  async _loadListStats(videoPath, funscriptPath, fsBadgeEl, badgesEl, heatmapEl, rowEl) {
    const cachedBins = this._binsByPath.get(videoPath);
    if (cachedBins && heatmapEl) {
      queueRenderBins(heatmapEl, cachedBins);
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
        queueRenderBins(heatmapEl, bins);
      }
    } catch {
      if (rowEl) rowEl.classList.add('categories__list-item--no-heatmap');
      if (heatmapEl) heatmapEl.remove();
    }
  }
}
