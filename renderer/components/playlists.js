// Playlists — Grid view of playlists with detail view for individual playlist

import { Modal } from './modal.js';
import { icon, Play, Plus, Pencil, Trash2, ArrowLeft, X, Clapperboard, FileX, FileCheck, Gauge, LayoutGrid, LayoutList, Repeat, Shuffle, SlidersHorizontal, GripVertical, ChevronUp, ChevronDown, History, RotateCcw, Check, Unplug } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { computeSpeedStats } from '../js/library-search.js';
import { computeBins, renderBins } from '../js/heatmap-strip.js';
import { normalizeAssociation, resolveActiveConfig } from '../js/association-shape.js';
import { pathToFileURL } from '../js/path-utils.js';
import { thumbRequestOpts, customThumbImagePath } from './library.js';
import * as thumbCache from '../js/thumbnail-cache.js';
import { dedupeThumbRequest } from '../js/thumb-inflight.js';
import { applyResumeBar, createResumeBar } from './resume-bar.js';
import { isFinished } from '../js/resume-position.js';
import {
  pickContinueTarget,
  summarisePlaylistProgress,
  formatRemaining,
} from '../js/playlist-progress.js';
import {
  probeAvailability,
  availabilityPredicate,
  partitionByAvailability,
  groupByVolume,
} from '../js/playlist-availability.js';

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
    // Fresh memo per render pass: durations can change when a scan
    // completes, and a stale memo would pin an old "time left".
    this._resetDurationMemo();
    // Probe every playlist's paths in ONE batch, off the render path. Tiles
    // render immediately using whatever the last probe knew (all-available on
    // first paint); when the answer lands we re-render so counts settle. Doing
    // it inline would make the whole grid wait on a possibly-spun-down drive.
    this._refreshGridAvailability(playlists);
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

  /**
   * Batch-probe every path across every playlist, then re-render once if the
   * answer changed. Kept off the synchronous render path deliberately: an
   * unplugged or spun-down volume can make a stat call slow, and the grid must
   * not block on it.
   *
   * `_availabilityProbeToken` guards against overlapping probes racing each
   * other into a re-render loop when the user flips views quickly.
   */
  _refreshGridAvailability(playlists) {
    const paths = [...new Set((playlists || []).flatMap((pl) => pl.videoPaths || []))];
    if (paths.length === 0) return;
    const token = (this._availabilityProbeToken || 0) + 1;
    this._availabilityProbeToken = token;

    probeAvailability(paths).then((set) => {
      if (this._availabilityProbeToken !== token) return; // superseded
      const before = this._availablePaths;
      const changed = !before
        || before.size !== set.size
        || [...set].some((p) => !before.has(p));
      this._availablePaths = set;
      // Only re-render when the picture actually changed, and only while the
      // grid is still the visible view.
      if (changed && this._container && this._view === 'grid') this._renderGrid();
    }).catch(() => { /* fail open — predicate stays permissive */ });
  }

  /** Predicate over the last probe. Permissive until one has completed. */
  _isAvailable() {
    return availabilityPredicate(this._availablePaths);
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
    count.textContent = t('playlists.videoCount', { count: pl.videoPaths.length });

    body.appendChild(name);
    body.appendChild(count);

    // Progress summary — "4 of 12 watched · 2h 15m left". Rendered only
    // once something has actually been watched, so untouched playlists
    // look exactly as they did and the tile doesn't grow a permanent
    // "0 of 12" that says nothing.
    const summary = this._summariseProgress(pl);
    if (this._showResumeProgress() && (summary.watched > 0 || summary.inProgress > 0)) {
      const progressEl = document.createElement('div');
      progressEl.className = 'playlists__card-progress';

      const parts = [t('playlists.watchedCount', { watched: summary.watched, total: summary.total })];
      const left = formatRemaining(summary.remainingSeconds);
      if (left) parts.push(t('playlists.timeLeft', { time: left }));
      progressEl.textContent = parts.join(' · ');
      body.appendChild(progressEl);

      // Progress bar across the tile — the same at-a-glance read as the
      // per-video bar, one level up.
      const track = document.createElement('div');
      track.className = 'playlists__card-progress-track';
      const fill = document.createElement('div');
      fill.className = 'playlists__card-progress-fill';
      fill.style.width = `${summary.total > 0 ? Math.round((summary.watched / summary.total) * 100) : 0}%`;
      track.appendChild(fill);
      body.appendChild(track);
    }

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'playlists__card-actions';

    // Continue, right on the tile. The header button inside the detail
    // view takes two clicks to reach; the grid is where you land.
    // Deliberately NOT gated on _showResumeProgress: that setting hides the
    // progress BARS, it doesn't disable resuming. Hiding the button too
    // would remove functionality the user didn't ask to lose, and would
    // disagree with the header Continue, which stays.
    if (this._playlistHasProgress(pl) && pl.videoPaths.length > 0) {
      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.className = 'playlists__card-action-btn playlists__card-action-btn--continue';
      continueBtn.appendChild(icon(History, { width: 14, height: 14 }));
      continueBtn.title = t('playlists.continueWatching');
      continueBtn.setAttribute('aria-label', t('playlists.continueNamed', { name: pl.name }));
      continueBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also open the playlist detail view
        this._continueFromLastWatched(pl);
      });
      actions.appendChild(continueBtn);
    }

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
    countSpan.textContent = t('playlists.videoCount', { count: pl.videoPaths.length });

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

      // Continue from last watched — only rendered when there IS one, and
      // only when that video is still in the playlist. A button that
      // sometimes does nothing is worse than no button (Nielsen #1:
      // visibility of system status; its presence IS the status).
      // Gate on "has any progress" rather than "has a marker": Continue is
      // also meaningful with no marker at all (first unwatched), and with a
      // marker on a FINISHED video (skip past it). The tooltip names the
      // video it will actually land on, resolved by the same targeting the
      // click uses, so the two can't disagree.
      const continueTarget = this._playlistHasProgress(pl)
        ? pickContinueTarget(
          pl.videoPaths,
          this._playlistProgress(pl.id)?.lastVideoPath || null,
          (p) => this._resumeEntryFor(p),
        )
        : null;
      if (continueTarget) {
        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'playlists__continue-btn';
        continueBtn.appendChild(icon(History, { width: 14, height: 14 }));
        continueBtn.appendChild(document.createTextNode(' ' + t('playlists.continueWatching')));
        const targetName = continueTarget.path.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        continueBtn.title = t('playlists.continueWatchingNamed', { name: targetName });
        continueBtn.setAttribute('aria-label', continueBtn.title);
        continueBtn.addEventListener('click', () => this._continueFromLastWatched(pl));
        header.appendChild(continueBtn);
      }

      // Reset — clears the marker and every member video's saved position.
      // Only shown when there's something to clear.
      if (this._playlistHasProgress(pl)) {
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'playlists__reset-btn';
        resetBtn.appendChild(icon(RotateCcw, { width: 14, height: 14 }));
        resetBtn.appendChild(document.createTextNode(' ' + t('playlists.resetProgress')));
        resetBtn.title = t('playlists.resetProgressHint');
        resetBtn.setAttribute('aria-label', resetBtn.title);
        resetBtn.addEventListener('click', () => this._confirmResetProgress(pl));
        header.appendChild(resetBtn);
      }

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

      // Advanced settings (Dave 2026-08-04) — balance-by-script moved off the
      // header into here. As a bare icon toggle it was undiscoverable and
      // unexplainable: nothing on a 14px scale glyph can convey "collapses
      // videos sharing a script into one shuffle slot", and it silently does
      // nothing while Shuffle is off. A modal gives it a real name, a plain
      // explanation, and somewhere to say that out loud.
      const advancedBtn = document.createElement('button');
      advancedBtn.type = 'button';
      advancedBtn.className = 'playlists__loop-btn playlists__advanced-btn';
      advancedBtn.appendChild(icon(SlidersHorizontal, { width: 14, height: 14 }));
      advancedBtn.title = t('playlists.advanced.openTitle');
      advancedBtn.setAttribute('aria-label', advancedBtn.title);
      advancedBtn.addEventListener('click', () => this._openAdvancedSettings(pl));
      header.appendChild(advancedBtn);
    }

    this._addViewToggle(header);
    this._container.appendChild(header);

    // Video grid
    const wrapper = document.createElement('div');
    wrapper.className = 'playlists__grid-wrapper';

    // Availability, NOT a purge.
    //
    // This block used to call removeVideoFromPlaylist() on every path that
    // failed fileExists — so opening a playlist with its external drive
    // unplugged PERMANENTLY DELETED every entry, and reconnecting the drive
    // could not bring them back because config.json had already been
    // rewritten. Absence of a volume is not deletion of a file.
    //
    // Now every path keeps its slot, order, resume position and watched mark.
    // Unreachable ones render greyed out and are skipped by anything that
    // would play them. Re-probed on each render, so a reconnect just works.
    const availableSet = await probeAvailability(pl.videoPaths);
    const isAvailable = availabilityPredicate(availableSet);
    this._availablePaths = availableSet;
    const validPaths = pl.videoPaths.slice();
    const { unavailable } = partitionByAvailability(pl.videoPaths, isAvailable);

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

    // Explain the greyed rows rather than leaving the user to wonder why some
    // tiles are dim and Play All is short. Grouped by volume, because "3
    // videos on E: are unavailable" is actionable and three filenames aren't.
    if (unavailable.length > 0) {
      wrapper.appendChild(this._createUnavailableNotice(unavailable));
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
        // Snapshot of what was reachable when playback started. app.js's
        // prev/next stepping reads this so N/P skip over an unplugged drive
        // instead of dead-ending on it.
        unavailablePaths: unavailable.slice(),
      };
      const el = this._viewMode === 'list'
        ? this._createVideoListItem(videoPath, pl, playContext)
        : this._createVideoCard(videoPath, pl, playContext);
      if (!isAvailable(videoPath)) this._markUnavailable(el, videoPath);
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

  /**
   * Banner above the grid: why some tiles are dim and why Play All is short.
   *
   * Grouped by volume so the message names the thing the user can act on —
   * "3 videos on E: are unavailable" — instead of listing filenames they'd
   * have to decode. Falls back to a count-only message when the paths don't
   * yield a recognisable root, rather than inventing a location.
   */
  _createUnavailableNotice(unavailablePaths) {
    const notice = document.createElement('div');
    notice.className = 'playlists__unavailable-notice';
    notice.setAttribute('role', 'status');

    notice.appendChild(icon(Unplug, { width: 16, height: 16 }));

    const text = document.createElement('span');
    const groups = groupByVolume(unavailablePaths);
    const named = [...groups.entries()].filter(([root]) => root);
    if (named.length === 1 && named[0][1].length === unavailablePaths.length) {
      text.textContent = t('playlists.unavailableOnVolume', {
        count: unavailablePaths.length,
        volume: named[0][0],
      });
    } else {
      text.textContent = t('playlists.unavailableCount', { count: unavailablePaths.length });
    }
    notice.appendChild(text);

    const hint = document.createElement('span');
    hint.className = 'playlists__unavailable-hint';
    hint.textContent = t('playlists.unavailableHint');
    notice.appendChild(hint);

    return notice;
  }

  /**
   * Grey out one card/row and take it out of play.
   *
   * Deliberately keeps the thumbnail, the resume bar and the watched tick —
   * the entry is still yours, it's just not reachable right now, and blanking
   * it would look like the data loss this whole change exists to prevent.
   * The remove button stays live so a genuinely dead entry can still be
   * cleared by hand.
   */
  _markUnavailable(el, videoPath) {
    el.classList.add('playlists__video--unavailable');
    el.dataset.unavailable = 'true';
    el.title = t('playlists.unavailableTooltip', { path: videoPath });

    const badge = document.createElement('span');
    badge.className = 'playlists__unavailable-badge';
    badge.appendChild(icon(Unplug, { width: 12, height: 12 }));

    // Grid tiles have a thumbnail to overlay. LIST ROWS DO NOT — they are
    // handle + title + badges, with no image — so the badge goes inline
    // before the title instead. Without this branch the marker silently
    // vanished in list view, leaving a dimmed row with no explanation.
    const thumb = el.querySelector('.playlists__video-thumbnail');
    if (thumb) {
      thumb.appendChild(badge);
      return;
    }
    badge.classList.add('playlists__unavailable-badge--inline');
    const title = el.querySelector('.playlists__list-name')
      || el.querySelector('.playlists__video-title');
    if (title && title.parentNode) {
      title.parentNode.insertBefore(badge, title);
    } else {
      el.insertBefore(badge, el.firstChild);
    }
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

    // Resume progress along the bottom of the thumbnail (see resume-bar.js).
    if (this._showResumeProgress()) {
      applyResumeBar(thumbnail, this._resumeEntryFor(videoPath));
    }

    // Watched check — set once a video has been played to the end, and
    // sticky until Reset. Distinct from the resume bar: the bar says "part
    // way through", this says "seen it".
    if (this._showResumeProgress() && isFinished(this._resumeEntryFor(videoPath))) {
      card.classList.add('playlists__video-card--watched');
      const check = document.createElement('span');
      check.className = 'playlists__watched-check';
      check.title = t('playlists.watched');
      check.setAttribute('aria-label', t('playlists.watched'));
      check.appendChild(icon(Check, { width: 12, height: 12 }));
      thumbnail.appendChild(check);
    }

    // "Last watched" marker — which video in THIS playlist you were on.
    // Card-level class as well as the pill, so the marker survives being
    // read at a glance across a grid (the pill alone is easy to miss).
    if (this._playlistProgress(playlist.id)?.lastVideoPath === videoPath) {
      card.classList.add('playlists__video-card--last-watched');
      const marker = document.createElement('span');
      marker.className = 'playlists__last-watched';
      marker.textContent = t('playlists.lastWatched');
      thumbnail.appendChild(marker);
    }

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
      // Unreachable right now (drive unplugged). Explain instead of opening a
      // player that will fail — the entry is intact, just not loadable.
      if (card.dataset.unavailable === 'true') {
        this._notifyUnavailable(videoPath);
        return;
      }
      this._playVideoByPath(videoPath, playContext);
    });

    return card;
  }

  /**
   * Tell the user why a click did nothing. Re-probes first: the most likely
   * reason someone clicks a greyed tile is that they just plugged the drive
   * back in, and refusing at that point would be plainly wrong.
   */
  async _notifyUnavailable(videoPath) {
    const set = await probeAvailability([videoPath]);
    if (set.has(videoPath)) {
      // It's back — re-render so the whole playlist un-greys, then play it.
      if (this._detailPlaylistId) await this._renderDetail(this._detailPlaylistId);
      return;
    }
    const { showToast } = await import('../js/toast.js');
    showToast(t('toast.videoUnavailable'), 'warn');
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
    // Shared in-memory cache FIRST (module-level map in thumbnail-cache.js).
    // Without this, every switch from the Library into a playlist re-fetched
    // every visible tile: the dedup below only collapses requests that are
    // in flight at the same moment, it stores nothing between view switches.
    // On a large library that meant a burst of simultaneous requests each
    // time, which is what ProfKiwi reported as thumbnails "repopulating and
    // often failing" (EroScripts #225).
    //
    // mtime key 0 matches library.js exactly, so all three views share the
    // SAME entries — and the library's invalidation on a custom thumbnail or
    // pin change (thumbCache.remove) clears them for every view at once.
    const cached = thumbCache.getEntry(videoPath, 0);
    if (cached) return cached;
    // Deduped: shares in-flight captures with the library/categories views.
    const result = await dedupeThumbRequest(videoPath, () => this._captureFrameUncached(videoPath));
    const dataUrl = result?.dataUrl || result;
    if (typeof dataUrl === 'string' && dataUrl) {
      thumbCache.set(videoPath, 0, dataUrl, result?.duration);
    }
    return result;
  }

  async _captureFrameUncached(videoPath) {
    // Honor a user-pinned thumbnail frame ("Set thumbnail frame…" in the
    // library) so playlist cards show the same tile as the library grid.
    const custom = (this._settings?.get?.('library.customThumbnails') || {})[videoPath];
    // User-uploaded poster image wins outright (mirrors library.js).
    const imagePath = customThumbImagePath(custom);
    if (imagePath && window.funsync?.readCustomThumbnail) {
      try {
        const img = await window.funsync.readCustomThumbnail(imagePath);
        if (img?.dataUrl) return { dataUrl: img.dataUrl, duration: 0 };
      } catch { /* fall through to frame path */ }
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
    // Unreachable files are excluded from the QUEUE but never removed from the
    // playlist — see playlist-availability.js for why that distinction is the
    // whole point. One batch probe instead of one invoke per video.
    const isAvailable = availabilityPredicate(await probeAvailability(pl.videoPaths));
    const { available: validPaths, unavailable } =
      partitionByAvailability(pl.videoPaths, isAvailable);

    if (validPaths.length === 0) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.playlistAllUnavailable'), 'warn');
      return;
    }

    // Silently playing a short queue looks like data loss — which is exactly
    // the bug this change fixes. Say what was skipped and why.
    if (unavailable.length > 0) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.playlistSkippedUnavailable', { count: unavailable.length }), 'info');
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
      balanceByScript: !!pl.balanceByScript,
      preferUnwatched: !!pl.preferUnwatched,
      // Watched lookup travels with the request: app.js owns the queue
      // build but has no reason to know how playlist entries are stored.
      isWatched: (path) => isFinished(this._resumeEntryFor(path)),
    });
  }

  // --- View toggle ---

  /**
   * Advanced playlist settings modal. Currently one option (balance by
   * script), but it exists so shuffle-modifying behaviour has a home with
   * room to explain itself rather than living as an unlabelled header icon.
   *
   * The balance option is disabled while Shuffle is off, with the reason
   * stated inline — it genuinely has no effect on a fixed order, and a
   * toggle that silently does nothing is worse than one you can't press.
   */
  _openAdvancedSettings(pl) {
    Modal.open({
      title: t('playlists.advanced.title'),
      onRender: (body, close) => {
        const shuffleOn = !!pl.shuffle;

        const section = document.createElement('div');
        section.className = 'playlists__advanced-option';

        // --- Balance by script ---
        const row = document.createElement('label');
        row.className = 'playlists__advanced-row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!pl.balanceByScript;
        check.disabled = !shuffleOn;
        const label = document.createElement('span');
        label.className = 'playlists__advanced-label';
        label.textContent = t('playlists.advanced.balanceLabel');
        row.appendChild(check);
        row.appendChild(label);
        section.appendChild(row);

        // Plain-language explanation. Two short paragraphs: what goes wrong
        // without it, then what it does about it.
        const why = document.createElement('p');
        why.className = 'playlists__advanced-desc';
        why.textContent = t('playlists.advanced.balanceWhy');
        section.appendChild(why);

        const how = document.createElement('p');
        how.className = 'playlists__advanced-desc';
        how.textContent = t('playlists.advanced.balanceHow');
        section.appendChild(how);

        const note = document.createElement('p');
        note.className = 'playlists__advanced-note';
        note.textContent = shuffleOn
          ? t('playlists.advanced.balanceNeedsShuffleOn')
          : t('playlists.advanced.balanceNeedsShuffleOff');
        section.appendChild(note);

        check.addEventListener('change', () => {
          pl.balanceByScript = check.checked;
          this._settings.setPlaylistBalance(pl.id, check.checked);
        });

        // --- Prefer unwatched ---
        // Same shuffle-only gating as balance above, for the same reason:
        // it has no meaning on a fixed order.
        const unwatchedRow = document.createElement('label');
        unwatchedRow.className = 'playlists__advanced-row';
        unwatchedRow.style.marginTop = '14px';
        const unwatchedCheck = document.createElement('input');
        unwatchedCheck.type = 'checkbox';
        unwatchedCheck.checked = !!pl.preferUnwatched;
        unwatchedCheck.disabled = !shuffleOn;
        const unwatchedLabel = document.createElement('span');
        unwatchedLabel.className = 'playlists__advanced-label';
        unwatchedLabel.textContent = t('playlists.advanced.unwatchedLabel');
        unwatchedRow.appendChild(unwatchedCheck);
        unwatchedRow.appendChild(unwatchedLabel);
        section.appendChild(unwatchedRow);

        const unwatchedWhy = document.createElement('p');
        unwatchedWhy.className = 'playlists__advanced-desc';
        unwatchedWhy.textContent = t('playlists.advanced.unwatchedWhy');
        section.appendChild(unwatchedWhy);

        unwatchedCheck.addEventListener('change', () => {
          pl.preferUnwatched = unwatchedCheck.checked;
          this._settings.setPlaylistPreferUnwatched(pl.id, unwatchedCheck.checked);
        });

        body.appendChild(section);

        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'library__assoc-save-btn';
        done.style.marginTop = '12px';
        done.textContent = t('common.close');
        done.addEventListener('click', () => close(null));
        body.appendChild(done);
      },
    });
  }

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
    count.textContent = t('playlists.videoCount', { count: pl.videoPaths.length });

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

  /** Default ON, switchable in Settings ▸ Appearance. Playlists only. */
  _showResumeProgress() {
    return this._settings.get('library.showResumeProgress') !== false;
  }

  _resumeEntryFor(path) {
    if (!path) return null;
    return (this._settings.get('library.resumePositions') || {})[path] || null;
  }

  /**
   * Play the last-watched video, picking up where it left off. Builds the
   * same playContext a card click would, so prev/next, Up Next and the
   * resume path all behave identically to arriving there by hand.
   */
  async _continueFromLastWatched(pl) {
    const validPaths = (pl.videoPaths || []).slice();
    if (validPaths.length === 0) return;

    // Probe fresh rather than trusting the grid's last snapshot: this is a
    // deliberate click, and landing the user on a video that can't open is
    // worse than the round trip. Also covers "drive reconnected since the
    // grid rendered", which is the whole point of the fix.
    const isAvailable = availabilityPredicate(await probeAvailability(validPaths));

    // Targeting lives in playlist-progress.js — notably it skips PAST a
    // marked video that was watched to the end, rather than replaying it,
    // and now also past anything unreachable.
    const target = pickContinueTarget(
      validPaths,
      this._playlistProgress(pl.id)?.lastVideoPath || null,
      (p) => this._resumeEntryFor(p),
      isAvailable,
    );
    if (!target) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.playlistAllUnavailable'), 'warn');
      return;
    }

    this._playVideoByPath(target.path, {
      source: 'playlist',
      sourceLabel: `playlist "${pl.name}"`,
      sourceContext: { playlistId: pl.id },
      list: validPaths,
      index: target.index,
      unavailablePaths: validPaths.filter((p) => !isAvailable(p)),
    });
  }

  /**
   * Summary counts for a playlist, used by the grid tile.
   *
   * `library.getVideoByPath` is a linear scan over every scanned video, and
   * this runs once per video per playlist on every grid render — on a big
   * library with many playlists that multiplies into real work, and the
   * same video appearing in several playlists paid for it each time. The
   * memo below collapses it to one scan per distinct path per render pass.
   */
  _summariseProgress(pl) {
    if (!this._durationMemo) this._durationMemo = new Map();
    const memo = this._durationMemo;
    return summarisePlaylistProgress(
      pl.videoPaths || [],
      (p) => this._resumeEntryFor(p),
      (p) => {
        if (memo.has(p)) return memo.get(p);
        const d = this._library?.getVideoByPath?.(p)?.duration || 0;
        memo.set(p, d);
        return d;
      },
      this._isAvailable(),
    );
  }

  /** Drop the per-render duration memo so a re-render sees fresh scans. */
  _resetDurationMemo() {
    this._durationMemo = null;
  }

  async _confirmResetProgress(pl) {
    const ok = await Modal.open({
      title: t('playlists.resetProgressTitle'),
      onRender(body, close) {
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = t('playlists.resetProgressConfirm', { name: pl.name });
        body.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn--secondary';
        cancelBtn.textContent = t('common.cancel');
        cancelBtn.addEventListener('click', () => close(false));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn modal-btn--danger';
        confirmBtn.textContent = t('playlists.resetProgress');
        confirmBtn.addEventListener('click', () => close(true));

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        body.appendChild(actions);
      },
    });

    if (!ok) return;
    this._resetPlaylistProgress(pl);
    this._renderDetail(pl.id);
  }

  /** `{ lastVideoPath, updatedAt }` for a playlist, or null. */
  _playlistProgress(playlistId) {
    if (!playlistId) return null;
    return (this._settings.get('library.playlistProgress') || {})[playlistId] || null;
  }

  /**
   * Does this playlist carry any state a Reset would clear? True if there's
   * a last-watched marker OR any member video has a stored position — the
   * button is pointless otherwise, so it's only rendered when this is true.
   */
  _playlistHasProgress(pl) {
    if (!pl) return false;
    if (this._playlistProgress(pl.id)) return true;
    const positions = this._settings.get('library.resumePositions') || {};
    return (pl.videoPaths || []).some((p) => positions[p]);
  }

  /**
   * Clear the last-watched marker and every member video's stored
   * position. Scoped to this playlist: a video that also lives in another
   * playlist keeps its position there... except it can't, because
   * positions are keyed by video path and shared. That's the deliberate
   * trade — one position per video everywhere — so resetting a playlist
   * does drop positions for videos shared with another playlist. Called
   * out in the confirm text rather than hidden.
   */
  _resetPlaylistProgress(pl) {
    const progressMap = { ...(this._settings.get('library.playlistProgress') || {}) };
    delete progressMap[pl.id];
    this._settings.set('library.playlistProgress', progressMap);

    const positions = { ...(this._settings.get('library.resumePositions') || {}) };
    for (const p of pl.videoPaths || []) delete positions[p];
    this._settings.set('library.resumePositions', positions);

    // If a video from this playlist is playing RIGHT NOW, the tracker would
    // write its position straight back within seconds and the bar would
    // reappear — the Reset would look broken. Tell app.js to stop recording
    // the current video until it changes.
    eventBus.emit('playlist:progressReset', { playlistId: pl.id, videoPaths: (pl.videoPaths || []).slice() });
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

    // Resume progress. List rows have no thumbnail, so this is the inline
    // variant sitting between the heatmap strip and the badges. Absent
    // entirely when there's no stored position, like everywhere else.
    const resumeBar = this._showResumeProgress()
      ? createResumeBar(this._resumeEntryFor(videoPath), undefined, { inline: true })
      : null;

    // Watched check, same rule as the grid card.
    if (this._showResumeProgress() && isFinished(this._resumeEntryFor(videoPath))) {
      row.classList.add('playlists__list-item--watched');
      const check = document.createElement('span');
      check.className = 'playlists__watched-check playlists__watched-check--inline';
      check.title = t('playlists.watched');
      check.setAttribute('aria-label', t('playlists.watched'));
      check.appendChild(icon(Check, { width: 12, height: 12 }));
      badges.appendChild(check);
    }

    // Last-watched marker, same rule as the grid card.
    if (this._playlistProgress(playlist.id)?.lastVideoPath === videoPath) {
      row.classList.add('playlists__list-item--last-watched');
      const marker = document.createElement('span');
      marker.className = 'playlists__last-watched playlists__last-watched--inline';
      marker.textContent = t('playlists.lastWatched');
      badges.appendChild(marker);
    }

    row.append(handle, title, heatmap, ...(resumeBar ? [resumeBar] : []), badges, moveGroup, removeBtn);

    row.addEventListener('click', () => {
      // Same rule as the grid tile: unreachable explains, it doesn't open.
      if (row.dataset.unavailable === 'true') {
        this._notifyUnavailable(videoPath);
        return;
      }
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
