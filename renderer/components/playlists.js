// Playlists — Grid view of playlists with detail view for individual playlist

import { Modal } from './modal.js';
import { icon, Play, Plus, Pencil, Trash2, ArrowLeft, X, Clapperboard, FileX, FileCheck, Gauge, LayoutGrid, LayoutList, Repeat, Shuffle, SlidersHorizontal, GripVertical, ChevronUp, ChevronDown, History, RotateCcw, Check, Unplug, ArrowDownAZ, ArrowDownZA, Link, ListVideo } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { computeSpeedStats, compareNames } from '../js/library-search.js';
import { computeBins, queueRenderBins } from '../js/heatmap-strip.js';
import { normalizeAssociation, resolveActiveConfig } from '../js/association-shape.js';
import { pathToFileURL } from '../js/path-utils.js';
import { thumbRequestOpts, customThumbImagePath, dockedEditorOnScreen } from './library.js';
import * as thumbCache from '../js/thumbnail-cache.js';
import { dedupeThumbRequest } from '../js/thumb-inflight.js';
import { noticeUnreadableScript } from '../js/script-access-notice.js';
import { applyResumeBar, createResumeBar } from './resume-bar.js';
import { createQueueToggleButton } from './queue-panel.js';
import { isFinished } from '../js/resume-position.js';
import { openPlayOptionsModal } from './play-options-modal.js';
import { rangeBetween, nextAnchor } from '../js/selection-range.js';
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
import { stashData, onStashChanged, isStashSettingPath } from '../js/stash-store.js';
import { stashGroupPlaylists, isStashGroupPlaylistId } from '../js/stash-groups.js';
import { anyLibraryPlayOption, readLibraryPlayOptions, setLibraryPlayOption } from '../js/library-play-options.js';

/** The name a playlist card shows for a path: the file name without its extension. */
const shownName = (videoPath) => String(videoPath).split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');

/**
 * `paths` ordered by the name each card shows, A-Z (`'asc'`) or Z-A
 * (`'desc'`), with the library's natural collator ("Clip 2" before
 * "Clip 10", case ignored; never bare localeCompare). Ties fall back to the
 * full file name, then the full path, so the result never depends on the
 * order it started in, and Z-A is exactly A-Z reversed. EroScripts #370 (V78).
 */
export function sortPlaylistPathsByName(paths, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const codepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return (paths || [])
    .map((p) => ({ p, name: shownName(p), file: String(p).split(/[\\/]/).pop() }))
    .sort((a, b) => sign * (compareNames(a.name, b.name)
      || compareNames(a.file, b.file)
      || compareNames(a.p, b.p)
      || codepoint(a.p, b.p)))
    .map((x) => x.p);
}

/**
 * The order an Undo puts back. With the same videos as when the order was
 * saved this is `previous` exactly; a video removed since is left out and one
 * added since keeps its place at the end, so the result is always a pure
 * reorder of `current` (store.js refuses anything else, and the renderer's
 * cache would then disagree with config.json).
 */
export function restorePlaylistOrder(previous, current) {
  const now = new Set(current || []);
  const before = new Set(previous || []);
  return [
    ...(previous || []).filter((p) => now.has(p)),
    ...(current || []).filter((p) => !before.has(p)),
  ];
}

const sameOrder = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);

// Select mode's moves (GuthixUnsigned, EroScripts #370: "select multiple
// videos to move around the playlist at once"; FT-104). Each takes the
// playlist's order and the selected paths (a Set) and returns an order of
// exactly the same paths, so store.js takes it as a pure reorder. The
// selected videos keep their order among themselves.

/** The selection as one block at the top (`'top'`) or the bottom (`'bottom'`). */
export function moveSelectedToEdge(order, selected, edge) {
  const list = order || [];
  const sel = list.filter((p) => selected.has(p));
  const rest = list.filter((p) => !selected.has(p));
  return edge === 'bottom' ? [...rest, ...sel] : [...sel, ...rest];
}

/**
 * Every selected video one place up (`dir` < 0) or down. A selected video
 * already at that end, or right behind another selected one that cannot
 * move, stays put, so a block moves as a block and never overtakes itself.
 */
export function moveSelectedByOne(order, selected, dir) {
  const out = (order || []).slice();
  const swap = (i, j) => { [out[i], out[j]] = [out[j], out[i]]; };
  if (dir < 0) {
    for (let i = 1; i < out.length; i++) {
      if (selected.has(out[i]) && !selected.has(out[i - 1])) swap(i, i - 1);
    }
  } else {
    for (let i = out.length - 2; i >= 0; i--) {
      if (selected.has(out[i]) && !selected.has(out[i + 1])) swap(i, i + 1);
    }
  }
  return out;
}

/**
 * The selection as one block, dropped into the gap before the video at
 * `dropIndex` in the current order (`order.length` is the end). Selected
 * videos before the gap do not count, so the block lands where it was aimed.
 */
export function moveSelectedTo(order, selected, dropIndex) {
  const list = order || [];
  const at = Math.max(0, Math.min(list.length, dropIndex));
  const sel = list.filter((p) => selected.has(p));
  const rest = list.filter((p) => !selected.has(p));
  const before = list.slice(0, at).filter((p) => !selected.has(p)).length;
  return [...rest.slice(0, before), ...sel, ...rest.slice(before)];
}

/**
 * What an Undo of Remove puts back: the playlist as it is now, with each
 * removed video back right after the video it followed before (first, when
 * none of those is still there). A reorder made since is kept, and a video
 * already back in the playlist is not added twice.
 */
export function reinsertRemoved(before, current, removed) {
  const out = (current || []).slice();
  const have = new Set(out);
  const prev = before || [];
  prev.forEach((p, i) => {
    if (!removed.has(p) || have.has(p)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (have.has(prev[j])) { at = out.indexOf(prev[j]) + 1; break; }
    }
    out.splice(at, 0, p);
    have.add(p);
  });
  return out;
}

/**
 * What a render of the Stash group playlists showed: each group's id, name
 * and scenes in order with the video each plays (or the title of a missing
 * one). The same string again means nothing on screen would change.
 */
export function stashGroupSignature(groups) {
  return JSON.stringify((groups || []).map((g) => [
    g.id, g.name, g.entries.map((e) => (e.path ? [e.sceneId, e.path] : [e.sceneId, null, e.title])),
  ]));
}

export class Playlists {
  /**
   * `onAddPathsToQueue(paths)`: puts several videos on the end of the user's
   * queue in one go and returns how many it added (a Stash group's Add to
   * queue; app.js `addPathsToUserQueue`). Without it that button is not shown.
   */
  constructor({ settings, onPlayVideo, onPlayAll, library, onToggleQueue, isQueueOpen, onAddPathsToQueue }) {
    this._settings = settings;
    this._onPlayVideo = onPlayVideo;
    this._onPlayAll = onPlayAll;
    this._onToggleQueue = onToggleQueue || null;
    this._isQueueOpen = isQueueOpen || null;
    this._onAddPathsToQueue = typeof onAddPathsToQueue === 'function' ? onAddPathsToQueue : null;
    this._library = library || null;
    this._container = null;
    this._view = 'grid'; // 'grid' or 'detail'
    this._detailPlaylistId = null;
    this._viewMode = 'grid'; // 'grid' or 'list'
    this._binsByPath = new Map();
    // The last Sort by name and the order its Undo puts back (V78).
    this._sortUndo = null;
    // Select mode in a playlist's detail (FT-104, #370): the selected paths,
    // the Shift+click anchor and the playlist they belong to. Leaving the
    // detail (Back, another playlist, another view) ends it.
    this._selectMode = false;
    this._selectedPaths = new Set();
    this._selectionAnchor = null;
    this._selectPlaylistId = null;
    this._detailGrid = null;
    this._selectionBar = null;
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
    // Esc leaves Select mode and Ctrl+A selects every video (FT-104). In
    // the capture phase: the player's own handler takes every Esc.
    if (!this._selectKeysAttached) {
      this._onSelectKey = (e) => this._onSelectKeyDown(e);
      document.addEventListener('keydown', this._onSelectKey, true);
      this._selectKeysAttached = true;
    }
    // The Stash group playlists follow the Stash data: main's change report
    // after a sync, a link or Remove (stash-store notify), Stash turned on or
    // off, and a library scan (which videos the library holds).
    if (!this._stashListenersAttached) {
      onStashChanged(() => this._onStashGroupsChanged());
      eventBus.on('settings:changed', ({ path } = {}) => {
        if (isStashSettingPath(path)) this._onStashGroupsChanged();
      });
      eventBus.on('library:filtered', () => this._onStashGroupsChanged());
      this._stashListenersAttached = true;
    }
    this._shown = true;
    if (this._view === 'detail' && this._detailPlaylistId) {
      this._renderDetail(this._detailPlaylistId);
    } else {
      this._view = 'grid';
      this._renderGrid();
    }
  }

  hide() {
    this._shown = false;
    this._supersedeRender();
    this._clearSelectState();
    this._detailGrid = null;
    if (this._container) {
      this._container.innerHTML = '';
    }
  }

  /**
   * Start a render pass and return its number; any detail render still
   * waiting on its availability probe drops its grid (FT-034). The detail
   * empties the container, awaits the probe, then appends, so two calls in
   * that gap (Back to <playlist> after Play All rendered from both show()
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
      this._detailPlaylistId = null;
      this._renderGrid();
      return true;
    }
    return false;
  }

  _renderGrid() {
    this._supersedeRender();
    this._clearSelectState();
    this._detailGrid = null;
    const playlists = this._settings.getPlaylists();
    // Fresh memo per render pass: durations can change when a scan
    // completes, and a stale memo would pin an old "time left".
    this._resetDurationMemo();
    // Probe every playlist's paths in ONE batch, off the render path. Tiles
    // render immediately using whatever the last probe knew (all-available on
    // first paint); when the answer lands we re-render so counts settle. Doing
    // it inline would make the whole grid wait on a possibly-spun-down drive.
    this._refreshGridAvailability(playlists);
    // Stash's groups, read-only, in their own section under the user's own
    // playlists (derived now from the Stash data; none while Stash is off).
    const stashGroups = this._stashGroupPlaylists();
    this._stashGroupSig = stashGroupSignature(stashGroups);
    this._container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'playlists__header';
    header.innerHTML = `<span class="playlists__title">${t('playlists.title')}</span>`;

    this._addViewToggle(header);
    this._addQueueToggle(header);
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
      if (stashGroups.length > 0) wrapper.appendChild(this._createStashGroupSection(stashGroups));
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
    if (stashGroups.length > 0) wrapper.appendChild(this._createStashGroupSection(stashGroups));
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
    const renderGen = this._supersedeRender();
    // A Stash group's playlist: its own read-only detail (never a user playlist).
    if (isStashGroupPlaylistId(playlistId)) return this._renderStashGroupDetail(playlistId, renderGen);
    const pl = this._settings.getPlaylist(playlistId);
    if (!pl) {
      this._view = 'grid';
      this._renderGrid();
      return;
    }

    // Select mode belongs to one playlist; a selected video that left the
    // playlist (the X on its card) leaves the selection.
    if (this._selectPlaylistId !== null && this._selectPlaylistId !== playlistId) this._clearSelectState();
    if (pl.videoPaths.length === 0) this._clearSelectState();
    if (this._selectMode) {
      const have = new Set(pl.videoPaths);
      for (const p of [...this._selectedPaths]) if (!have.has(p)) this._selectedPaths.delete(p);
    }
    this._detailGrid = null;
    this._selectionBar = null;

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
      // naming the state. Shuffle order is decided when playback starts,
      // from Play All, a video card or Continue (bag model: shuffle once,
      // reshuffle on loop wrap) — see app._playAllOrder.
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

      // Sort by name (GuthixUnsigned, EroScripts #370; V78). One button that
      // says what it will do: A-Z, or Z-A once the list already reads A-Z,
      // so both directions cost no menu. It replaces the hand-made order,
      // so the toast it raises carries an Undo that puts that order back.
      if (pl.videoPaths.length > 1) {
        const az = sameOrder(pl.videoPaths, sortPlaylistPathsByName(pl.videoPaths, 'asc'));
        const dir = az ? 'desc' : 'asc';
        const sortBtn = document.createElement('button');
        sortBtn.type = 'button';
        sortBtn.className = 'playlists__loop-btn playlists__sort-btn';
        sortBtn.dataset.sortDir = dir;
        sortBtn.appendChild(icon(dir === 'asc' ? ArrowDownAZ : ArrowDownZA, { width: 14, height: 14 }));
        sortBtn.title = t(dir === 'asc' ? 'playlists.sortAzTitle' : 'playlists.sortZaTitle');
        sortBtn.setAttribute('aria-label', sortBtn.title);
        // The direction is read at the click: a move reorders the cards in
        // place and updates the button (`_syncSortButton`) without a render.
        sortBtn.addEventListener('click', () => this._sortByName(pl.id, sortBtn.dataset.sortDir === 'desc' ? 'desc' : 'asc'));
        header.appendChild(sortBtn);
      }

      // Select (FT-104, #370): pick several videos, then move or remove them
      // together. The Library's word for its own multi-select.
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'playlists__select-btn';
      selectBtn.textContent = t('library.selectModeEnter');
      selectBtn.title = t('playlists.selectModeTitle');
      selectBtn.setAttribute('aria-pressed', String(this._selectMode));
      selectBtn.classList.toggle('is-on', this._selectMode);
      selectBtn.addEventListener('click', () => {
        if (this._selectMode) this._exitSelectMode();
        else this._enterSelectMode();
      });
      header.appendChild(selectBtn);
    }

    this._addViewToggle(header);
    this._addQueueToggle(header);
    this._container.appendChild(header);
    if (pl.videoPaths.length > 0) this._container.appendChild(this._createSelectionBar());

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
    if (renderGen !== this._renderGen) return; // a newer render owns the container
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
      // An offline entry reads nothing from disk or the backend (FT-071, as
      // categories.js since V01): the card used to request its thumbnail
      // and read its script BEFORE it was marked unavailable.
      const available = isAvailable(videoPath);
      const el = this._viewMode === 'list'
        ? this._createVideoListItem(videoPath, pl, playContext, available)
        : this._createVideoCard(videoPath, pl, playContext, available);
      if (!available) this._markUnavailable(el, videoPath);
      grid.appendChild(el);
    }

    wrapper.appendChild(grid);
    this._detailGrid = grid;
    this._paintSelection();

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
    this._syncSortButton(this._settings.getPlaylist(playlistId));
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

  /**
   * Sort a playlist by name (V78) through the same write as a drag or Move:
   * DataService.setPlaylistVideoPaths, which store.js accepts only as a pure
   * reorder. Resume positions, watched marks and the Last watched marker are
   * keyed by path, not position, so they move with their videos. A session
   * already playing keeps the order it started with, as after a drag.
   *
   * The toast carries an Undo. A second sort while that toast is still up
   * (A-Z, then Z-A) shares its Undo, which goes back to the order before the
   * FIRST sort: the hand-made order is the one worth getting back.
   */
  async _sortByName(playlistId, dir) {
    const pl = this._settings.getPlaylist(playlistId);
    if (!pl || !Array.isArray(pl.videoPaths) || pl.videoPaths.length < 2) return;
    const before = pl.videoPaths.slice();
    const sorted = sortPlaylistPathsByName(before, dir);
    if (sameOrder(before, sorted)) return;

    const undo = this._takeOrderUndo(playlistId, before);
    this._settings.setPlaylistVideoPaths(playlistId, sorted);
    if (this._container && this._view === 'detail' && this._detailPlaylistId === playlistId) {
      this._renderDetail(playlistId);
    }
    await this._offerOrderUndo(undo,
      t(dir === 'desc' ? 'playlists.sortedZa' : 'playlists.sortedAz', { name: pl.name }));
  }

  /**
   * The Undo for an order change about to be made: a Sort by name, or a
   * Select-mode move or drag (FT-104). While the toast of the last one for
   * this playlist is still up, the new change shares its Undo, which goes
   * back to the order before the FIRST change: the hand-made order is the
   * one worth getting back, and pressing Move up five times is one Undo.
   */
  _takeOrderUndo(playlistId, before) {
    const pending = this._sortUndo;
    const pendingUp = pending && !pending.done && pending.playlistId === playlistId
      && (!pending.toast || (pending.toast.el?.isConnected && !pending.toast.el.classList.contains('toast--out')));
    const undo = { playlistId, order: pendingUp ? pending.order : before, toast: null, done: false };
    if (pendingUp) {
      pending.done = true;
      pending.toast?.dismiss();
    }
    this._sortUndo = undo;
    return undo;
  }

  /** The toast saying what changed, with the Undo `_takeOrderUndo` made. */
  async _offerOrderUndo(undo, message) {
    const { showToast } = await import('../js/toast.js');
    if (undo.done) return; // undone or superseded while the module loaded
    const body = document.createElement('div');
    body.className = 'update-toast';
    const text = document.createElement('span');
    text.textContent = message;
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'update-toast__btn playlists__sort-undo';
    undoBtn.textContent = t('toast.undo');
    // The click goes on to the toast body, which dismisses the toast.
    undoBtn.addEventListener('click', () => this._undoSortByName(undo));
    body.append(text, undoBtn);
    undo.toast = showToast(body, 'info', 8000) || null;
  }

  /** Put back the order a Sort by name or a move replaced (the toast's Undo). */
  _undoSortByName(undo) {
    if (!undo || undo.done) return;
    undo.done = true;
    if (this._sortUndo === undo) this._sortUndo = null;
    const pl = this._settings.getPlaylist(undo.playlistId);
    if (!pl) return; // deleted since
    const restored = restorePlaylistOrder(undo.order, pl.videoPaths);
    if (!sameOrder(pl.videoPaths, restored)) {
      this._settings.setPlaylistVideoPaths(undo.playlistId, restored);
    }
    this._showOrder(undo.playlistId);
  }

  /**
   * Show the playlist's current order in the open detail view. The cards
   * are put in that order where they are, so the scroll position, the
   * focus and every loaded thumbnail and heatmap stay; a card set that no
   * longer matches the playlist (a video added or removed since) renders
   * again instead.
   */
  _showOrder(playlistId) {
    if (!this._container || this._view !== 'detail' || this._detailPlaylistId !== playlistId) return;
    const pl = this._settings.getPlaylist(playlistId);
    const grid = this._detailGrid;
    const order = pl?.videoPaths || [];
    const els = grid?.isConnected ? [...grid.children].filter((el) => el.dataset.videoPath) : [];
    const byPath = new Map(els.map((el) => [el.dataset.videoPath, el]));
    if (!grid?.isConnected || byPath.size !== els.length || order.length !== els.length
        || !order.every((p) => byPath.has(p))) {
      this._renderDetail(playlistId);
      return;
    }
    const focused = document.activeElement;
    const keep = focused && grid.contains(focused) ? focused : null;
    for (const p of order) grid.appendChild(byPath.get(p));
    if (keep && document.activeElement !== keep) keep.focus?.();
    this._syncSortButton(pl);
  }

  /** The Sort button offers Z-A once the list reads A-Z, after any reorder. */
  _syncSortButton(pl) {
    const btn = this._container?.querySelector('.playlists__sort-btn');
    if (!btn || !pl || !Array.isArray(pl.videoPaths)) return;
    const az = sameOrder(pl.videoPaths, sortPlaylistPathsByName(pl.videoPaths, 'asc'));
    const dir = az ? 'desc' : 'asc';
    if (btn.dataset.sortDir === dir) return;
    btn.dataset.sortDir = dir;
    btn.replaceChildren(icon(dir === 'asc' ? ArrowDownAZ : ArrowDownZA, { width: 14, height: 14 }));
    btn.title = t(dir === 'asc' ? 'playlists.sortAzTitle' : 'playlists.sortZaTitle');
    btn.setAttribute('aria-label', btn.title);
  }

  // --- Select mode (FT-104, GuthixUnsigned #370) ---------------------------
  //
  // The Library's multi-select, in a playlist's detail: a click (or
  // Ctrl+click) toggles a video, Shift+click adds the range from the last
  // click, Ctrl+A / Select all / Deselect all, Esc or Done leaves. The bar
  // moves the selection to the top or bottom, one place up or down, or
  // removes it from the playlist (never a file); a selected card dragged
  // takes the whole selection with it. Every order change is one write
  // through setPlaylistVideoPaths, the same as Move ↑/↓ and Sort, so the
  // saved playlist, Play All and the phone follow, and its toast carries
  // the shared Undo.

  /** The open playlist's order, which is also the order on screen. */
  _currentOrder() {
    return this._settings.getPlaylist(this._detailPlaylistId)?.videoPaths || [];
  }

  _clearSelectState() {
    this._selectMode = false;
    this._selectPlaylistId = null;
    this._selectedPaths = new Set();
    this._selectionAnchor = null;
  }

  _enterSelectMode() {
    if (this._selectMode) return;
    this._selectMode = true;
    this._selectPlaylistId = this._detailPlaylistId;
    this._selectedPaths = new Set();
    this._selectionAnchor = null;
    this._paintSelection();
  }

  /** Leave Select mode. Focus on a control that hides goes to Select. */
  _exitSelectMode() {
    const focused = document.activeElement;
    const losesFocus = !!focused && (!!this._selectionBar?.contains(focused)
      || !!focused.classList?.contains('playlists__select-check'));
    this._clearSelectState();
    this._paintSelection();
    if (losesFocus) this._container?.querySelector('.playlists__select-btn')?.focus();
  }

  /**
   * A click on a card or row while selecting, or a Shift / Ctrl+click from
   * browsing, which starts Select mode as the Library's Shift+click does.
   * Shift adds the range from the anchor (the anchor stays, so the range
   * can be re-extended); a plain or Ctrl+click toggles and moves the anchor.
   */
  _onSelectClick(videoPath, e) {
    if (!this._selectMode) {
      this._selectMode = true;
      this._selectPlaylistId = this._detailPlaylistId;
      this._selectedPaths = new Set();
      this._selectionAnchor = null;
    }
    if (e?.shiftKey) {
      const items = this._currentOrder().map((path) => ({ path }));
      for (const p of rangeBetween(items, this._selectionAnchor, videoPath)) this._selectedPaths.add(p);
      this._selectionAnchor = nextAnchor(this._selectionAnchor, videoPath, true);
    } else {
      if (this._selectedPaths.has(videoPath)) this._selectedPaths.delete(videoPath);
      else this._selectedPaths.add(videoPath);
      this._selectionAnchor = nextAnchor(this._selectionAnchor, videoPath, false);
    }
    this._paintSelection();
  }

  _selectAll() {
    if (!this._selectMode) this._enterSelectMode();
    this._selectedPaths = new Set(this._currentOrder());
    this._paintSelection();
  }

  _selectNone() {
    this._selectedPaths = new Set();
    this._selectionAnchor = null;
    this._paintSelection();
  }

  /**
   * Push the selection state onto the header button, the bar and every card
   * or row: one place, so a card rebuilt for any reason cannot disagree
   * (the Library's `_applySelectionState` lesson).
   */
  _paintSelection() {
    const on = this._selectMode;
    const n = on ? this._selectedPaths.size : 0;
    const toggle = this._container?.querySelector('.playlists__select-btn');
    if (toggle) {
      toggle.classList.toggle('is-on', on);
      toggle.setAttribute('aria-pressed', String(on));
    }
    const bar = this._selectionBar;
    if (bar) {
      bar.hidden = !on;
      const count = bar.querySelector('.playlists__selection-count');
      if (count) count.textContent = t('library.selectionCount', { count: n });
      bar.querySelectorAll('[data-needs-selection]').forEach((b) => { b.disabled = n === 0; });
    }
    const grid = this._detailGrid;
    if (!grid) return;
    grid.classList.toggle('playlists__grid--selecting', on);
    for (const el of grid.children) {
      const p = el.dataset.videoPath;
      if (!p) continue;
      const selected = on && this._selectedPaths.has(p);
      el.classList.toggle('playlists__item--selected', selected);
      const cb = el.querySelector('.playlists__select-check');
      if (cb) {
        cb.hidden = !on;
        cb.setAttribute('aria-checked', String(selected));
      }
      // Grid tiles drag only while selecting; list rows always could.
      if (el.classList.contains('playlists__video-card')) el.draggable = on;
      // A tile's or row's own X removes that video at once, with no question
      // and no Undo. Next to the tick, a missed click lost a playlist entry,
      // and Tab reached the X before each tick (block E2 verify-1). Out of
      // the way while selecting: the bar's Remove asks and can be undone.
      for (const x of el.querySelectorAll('.playlists__remove-one')) x.hidden = on;
    }
  }

  /** A card's or row's tick: a real button, so Tab reaches it (WCAG 2.1.1). */
  _createSelectCheck(videoPath, name) {
    const cb = document.createElement('button');
    cb.type = 'button';
    cb.className = 'playlists__select-check';
    cb.setAttribute('role', 'checkbox');
    cb.setAttribute('aria-checked', 'false');
    cb.setAttribute('aria-label', t('playlists.selectVideoNamed', { name }));
    cb.hidden = !this._selectMode;
    // Space / Enter toggle it, Shift with either adds the range. Taken here,
    // so Space does not also play / pause the player under the playlist.
    // A mouse click goes on to the card, which toggles it.
    cb.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      this._onSelectClick(videoPath, e);
    });
    return cb;
  }

  /** The bar under the header while selecting: the count and what to do with it. */
  _createSelectionBar() {
    const bar = document.createElement('div');
    bar.className = 'playlists__selection-bar';
    bar.setAttribute('role', 'group');
    const count = document.createElement('span');
    count.className = 'playlists__selection-count';
    count.id = `playlists-selection-count-${Math.random().toString(36).slice(2, 9)}`;
    count.setAttribute('aria-live', 'polite');
    bar.setAttribute('aria-labelledby', count.id);
    bar.appendChild(count);

    const add = (action, label, run, { needsSelection = false, variant = '' } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `playlists__selection-action${variant ? ` playlists__selection-action--${variant}` : ''}`;
      b.dataset.action = action;
      if (needsSelection) b.dataset.needsSelection = '';
      b.textContent = t(label);
      b.addEventListener('click', run);
      bar.appendChild(b);
      return b;
    };
    add('select-all', 'collectionModal.selectAll', () => this._selectAll(), { variant: 'quiet' });
    add('select-none', 'collectionModal.deselectAll', () => this._selectNone(), { variant: 'quiet' });
    add('move-top', 'playlists.moveToTop', () => this._moveSelection('top'), { needsSelection: true });
    add('move-up', 'playlists.moveUp', () => this._moveSelection('up'), { needsSelection: true });
    add('move-down', 'playlists.moveDown', () => this._moveSelection('down'), { needsSelection: true });
    add('move-bottom', 'playlists.moveToBottom', () => this._moveSelection('bottom'), { needsSelection: true });
    add('remove', 'playlists.removeFromPlaylist', () => this._removeSelected(), { needsSelection: true, variant: 'danger' });
    add('done', 'common.done', () => this._exitSelectMode(), { variant: 'quiet' });
    bar.hidden = !this._selectMode;
    this._selectionBar = bar;
    return bar;
  }

  /** Move to top / up / down / bottom on the bar. */
  _moveSelection(kind) {
    const pl = this._settings.getPlaylist(this._detailPlaylistId);
    if (!pl || !this._selectMode || this._selectedPaths.size === 0) return;
    const before = pl.videoPaths.slice();
    const next = (kind === 'top' || kind === 'bottom')
      ? moveSelectedToEdge(before, this._selectedPaths, kind)
      : moveSelectedByOne(before, this._selectedPaths, kind === 'up' ? -1 : 1);
    this._applyMove(pl, before, next, before.filter((p) => this._selectedPaths.has(p)).length);
  }

  /**
   * Write a move, show it in place and offer its Undo. Nothing is written
   * or toasted when the order would not change (Move up at the top).
   */
  _applyMove(pl, before, next, count) {
    if (sameOrder(before, next)) return false;
    const undo = this._takeOrderUndo(pl.id, before);
    this._settings.setPlaylistVideoPaths(pl.id, next);
    this._showOrder(pl.id);
    this._offerOrderUndo(undo, t('playlists.movedSelection', { count, name: pl.name }));
    return true;
  }

  /** What a drag that starts on `videoPath` carries: the selection if it is in it. */
  _dragSet(videoPath) {
    return this._selectMode && this._selectedPaths.has(videoPath)
      ? new Set(this._currentOrder().filter((p) => this._selectedPaths.has(p)))
      : new Set([videoPath]);
  }

  /** Drop past the middle of a row (down) or a tile (across) means after it. */
  _dropAfter(el, e) {
    const rect = el.getBoundingClientRect();
    return el.classList.contains('playlists__list-item')
      ? e.clientY > rect.top + rect.height / 2
      : e.clientX > rect.left + rect.width / 2;
  }

  /** Drop `paths` as one block before or after `targetPath`. */
  _dropMove(paths, targetPath, after, playlistId) {
    const pl = this._settings.getPlaylist(playlistId);
    if (!pl) return;
    const before = pl.videoPaths.slice();
    const at = before.indexOf(targetPath);
    if (at < 0) return;
    this._applyMove(pl, before, moveSelectedTo(before, paths, at + (after ? 1 : 0)), paths.size);
  }

  /** Mark (or unmark) everything a drag carries, so the whole block reads as moving. */
  _markDragging(paths, on) {
    for (const el of this._detailGrid?.children || []) {
      if (paths.has(el.dataset.videoPath)) el.classList.toggle('playlists__item--dragging', on);
    }
  }

  _clearDropMarks() {
    this._detailGrid?.querySelectorAll('.playlists__item--drop-before, .playlists__item--drop-after')
      .forEach((el) => el.classList.remove('playlists__item--drop-before', 'playlists__item--drop-after'));
  }

  /**
   * Remove the selected videos from this playlist: the playlist entries
   * only, never a file, and resume positions and watched marks stay with
   * their paths. Two or more ask first: Select all and Remove would
   * otherwise empty a hand-made playlist in one click (block E2 review). One
   * asks nothing, as the X on one card asks nothing. All of them go in one
   * write, and the toast's Undo puts them back where they were.
   */
  async _removeSelected() {
    const pl = this._settings.getPlaylist(this._detailPlaylistId);
    if (!pl || !this._selectMode) return;
    const count = pl.videoPaths.filter((p) => this._selectedPaths.has(p)).length;
    if (count === 0) return;
    if (count > 1) {
      const ok = await Modal.confirm(
        t('playlists.removeFromPlaylist'),
        t('playlists.confirmRemoveSelection', { count, name: pl.name }),
        { confirmText: t('common.remove') },
      );
      if (!ok || !this._selectMode || this._detailPlaylistId !== pl.id) return;
    }
    const before = (this._settings.getPlaylist(pl.id)?.videoPaths || []).slice();
    const removed = before.filter((p) => this._selectedPaths.has(p));
    if (removed.length === 0) return;
    this._settings.removeVideosFromPlaylist(pl.id, removed);
    this._clearSelectState();
    const undo = { playlistId: pl.id, before, removed, done: false, toast: null };
    await this._renderDetail(pl.id);
    (this._container?.querySelector('.playlists__select-btn')
      || this._container?.querySelector('.playlists__back-btn'))?.focus();

    const { showToast } = await import('../js/toast.js');
    if (undo.done) return;
    const body = document.createElement('div');
    body.className = 'update-toast';
    const text = document.createElement('span');
    text.textContent = t('playlists.removedSelection', { count: removed.length, name: pl.name });
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'update-toast__btn playlists__remove-undo';
    undoBtn.textContent = t('toast.undo');
    undoBtn.addEventListener('click', () => this._undoRemoveSelected(undo));
    body.append(text, undoBtn);
    undo.toast = showToast(body, 'info', 8000) || null;
  }

  /** The Remove toast's Undo: the videos go back after the ones they followed. */
  _undoRemoveSelected(undo) {
    if (!undo || undo.done) return;
    undo.done = true;
    const pl = this._settings.getPlaylist(undo.playlistId);
    if (!pl) return; // deleted since
    const missing = new Set(undo.removed.filter((p) => !pl.videoPaths.includes(p)));
    if (missing.size === 0) return;
    const restored = reinsertRemoved(undo.before, pl.videoPaths, missing);
    // Added back in one write (at the end, as store.js adds), then put in
    // place by one pure reorder of what the playlist then holds.
    this._settings.addVideosToPlaylist(undo.playlistId, restored.filter((p) => missing.has(p)));
    this._settings.setPlaylistVideoPaths(undo.playlistId, restored);
    if (this._container && this._view === 'detail' && this._detailPlaylistId === undo.playlistId) {
      this._renderDetail(undo.playlistId);
    }
  }

  /**
   * Esc leaves Select mode; Ctrl+A selects every video in the open playlist
   * (entering Select mode), as Ctrl+A does in the Library. A dialog, the
   * Devices / EroScripts panel, the queue panel (Esc closes it first), a
   * text field and the editor keep their keys.
   */
  _onSelectKeyDown(e) {
    const esc = e.key === 'Escape';
    const selectAll = (e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (!esc && !selectAll) return;
    if (esc && !this._selectMode) return;
    if (e.defaultPrevented || this._view !== 'detail' || !this._detailGrid?.isConnected) return;
    const el = document.activeElement;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    if ([...document.querySelectorAll('[aria-modal="true"]')].some((d) => !d.closest('[hidden]'))) return;
    // An OPEN docked editor: the closed one's panel is always in the DOM, and
    // `.script-editor:not([hidden])` matched it, so neither key ever worked
    // in the real app (block E2 verify-1).
    if (document.querySelector('.modal-overlay') || dockedEditorOnScreen()) return;
    if (this._isQueueOpen?.()) return;
    e.preventDefault();
    if (esc) this._exitSelectMode();
    else this._selectAll();
  }

  /**
   * The play context a click starts with, from the playlist's order NOW. A
   * move, a drag or an Undo reorders the cards in place, and the context
   * captured when they rendered then sent Next, Previous and Up Next through
   * the old order (also after Move ↑/↓ and a list drag, since 2026-06-09).
   */
  _playContextNow(playContext, videoPath) {
    const id = playContext?.sourceContext?.playlistId;
    const list = id ? this._playlistFor(id)?.videoPaths : null;
    if (!Array.isArray(list) || !list.includes(videoPath)) return playContext;
    return { ...playContext, list: list.slice(), index: list.indexOf(videoPath) };
  }

  /**
   * @param {boolean} [available=true] false when the probe says this video's
   *   drive is offline. Such a tile reads NOTHING from disk (FT-071).
   */
  _createVideoCard(videoPath, playlist, playContext, available = true) {
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

    // A Stash group's playlist is read-only: no Remove, no Select, no drag
    // (its videos and order are Stash's; the detail says so).
    const readOnly = playlist?.readOnly === true;

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'playlists__video-remove-btn playlists__remove-one';
    removeBtn.appendChild(icon(X, { width: 12, height: 12 }));
    removeBtn.title = t('playlists.removeFromPlaylist');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._settings.removeVideoFromPlaylist(playlist.id, videoPath);
      this._renderDetail(playlist.id);
    });
    if (!readOnly) thumbnail.appendChild(removeBtn);

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
    // Identity for Select mode and an in-place reorder, as the list rows have.
    card.dataset.videoPath = videoPath;
    card.dataset.videoName = name;
    // The Select-mode tick sits in the title row, clear of the thumbnail's
    // four claimed corners (V67).
    if (!readOnly) info.appendChild(this._createSelectCheck(videoPath, name));
    const titleEl = document.createElement('div');
    titleEl.className = 'playlists__video-title';
    titleEl.textContent = name;
    titleEl.title = videoPath;
    info.appendChild(titleEl);
    card.appendChild(info);

    if (available) {
      // Lazy-load thumbnail
      this._loadVideoThumbnail(card, thumbnail, videoPath);

      // Check for funscript and show badge
      this._checkFunscriptBadge(card, thumbnail, videoPath);
    } else {
      // Offline: the thumbnail CACHE only, no disk or backend I/O. Every
      // request here fails (a backend thumbnail, a hidden-<video> fallback,
      // a read-funscript per tile), and the failed thumbnails count towards
      // main's "thumbnail generation is broken" error, which is false. A
      // click re-probes and re-renders, so a reconnected drive loads then.
      this._showCachedThumbnail(thumbnail, videoPath);
    }

    card.addEventListener('click', (e) => {
      // Selecting: a click picks the video instead of playing it, an offline
      // or broken one included (removing a dead entry is a reason to select).
      if (!readOnly && (this._selectMode || e.shiftKey || e.ctrlKey || e.metaKey)) {
        this._onSelectClick(videoPath, e);
        return;
      }
      // Unreachable right now (drive unplugged). Explain instead of opening a
      // player that will fail — the entry is intact, just not loadable.
      // Checked before --broken, as categories.js does.
      if (card.dataset.unavailable === 'true') {
        this._notifyUnavailable(videoPath);
        return;
      }
      if (card.classList.contains('playlists__video-card--broken')) return;
      this._playVideoByPath(videoPath, this._playContextNow(playContext, videoPath));
    });

    // Drag while selecting (tiles are draggable only then, `_paintSelection`):
    // a selected tile takes the whole selection, another tile only itself.
    // Across, so past a tile's middle means after it.
    card.addEventListener('dragstart', (e) => {
      if (!this._selectMode || readOnly) return; // e.g. the thumbnail <img>'s own drag
      const paths = this._dragSet(videoPath);
      this._dragMove = { paths, from: card };
      this._markDragging(paths, true);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', videoPath);
      }
    });
    card.addEventListener('dragover', (e) => {
      const drag = this._dragMove;
      if (!drag || drag.from === card) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const after = this._dropAfter(card, e);
      card.classList.toggle('playlists__item--drop-after', after);
      card.classList.toggle('playlists__item--drop-before', !after);
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('playlists__item--drop-before', 'playlists__item--drop-after');
    });
    card.addEventListener('drop', (e) => {
      const drag = this._dragMove;
      if (!drag) return; // not ours: a file from the desktop goes on to DragDrop
      e.preventDefault();
      this._clearDropMarks();
      if (drag.from === card) return;
      this._dropMove(drag.paths, videoPath, this._dropAfter(card, e), playlist.id);
    });
    card.addEventListener('dragend', () => {
      if (this._dragMove) this._markDragging(this._dragMove.paths, false);
      this._dragMove = null;
      this._clearDropMarks();
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

  /**
   * `autoPlay`: start playing once loaded, for an unattended advance into the
   * user's queue with "Auto-play the next video" on (app.js, CB-11). A click
   * leaves it off and opens as any click does.
   */
  async _playVideoByPath(videoPath, playContext, { autoPlay = false } = {}) {
    const fileName = videoPath.split(/[\\/]/).pop();
    const fileData = { name: fileName, path: videoPath, _isPathBased: true };
    if (autoPlay) fileData._autoPlayOnLoad = true;
    if (playContext) {
      fileData._playContext = this._withPlaylistLoop(playContext);
      const shuffle = this._shuffleRequest(playContext);
      if (shuffle) fileData._shuffle = shuffle;
    }

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
    let subtitleData = null;
    let variants;
    let readFailed = false;
    if (libVideo && typeof this._library.resolvePlayData === 'function') {
      // What a click on the library card loads (FT-070): the script with
      // its companions and routing, the subtitle and the variants. This
      // route passed only the script, so a playlist click had no subtitle
      // and an empty variant picker.
      let triedSidecar = null;
      ({ funscriptData, subtitleData, variants, triedSidecar } =
        await this._library.resolvePlayData(libVideo));
      // The record has no script: the playlist's own pick (an association,
      // else `<name>.funscript`) quietly, unless that is the file just tried.
      if (!(libVideo.hasFunscript && libVideo.funscriptPath) && fsPath && fsPath !== triedSidecar
          && !funscriptData?.textContent && !funscriptData?._customRouting) {
        let content = null;
        try { content = await window.funsync.readFunscript(fsPath); } catch { /* quiet */ }
        if (content) {
          funscriptData = {
            ...funscriptData, // keeps a vib-only `_multiAxis`
            name: fsPath.split(/[\\/]/).pop(),
            textContent: content,
            _funscriptPath: fsPath,
          };
        }
      }
      if (isExplicit && !funscriptData?.textContent) readFailed = true;
    } else {
      // Not in the library (its source was removed since the entry was
      // added): path-only, as before.
      try {
        const content = await window.funsync.readFunscript(fsPath);
        if (content) {
          // `_funscriptPath` as library.resolvePlayData sets it: the file this
          // copy came from, so app.js can read it again if the unsaved-changes
          // question saves it first (CB-01 review) and keys its embedded axes.
          funscriptData = { name: fsPath.split(/[\\/]/).pop(), textContent: content, _funscriptPath: fsPath };
        } else if (isExplicit) {
          readFailed = true;
        }
      } catch {
        if (isExplicit) readFailed = true;
      }
    }
    if (readFailed) {
      const { showToast } = await import('../js/toast.js');
      showToast(t('toast.funscriptUnreadable', { name: fileName }), 'warn', 4000);
    }
    this._onPlayVideo(fileData, funscriptData, subtitleData, variants);
    // No association (that one has its own toast above), but a script there
    // that cannot be reached (a locked folder): say so once (R3-18).
    if (!isExplicit && !funscriptData?.textContent) noticeUnreadableScript(fsPath);
  }

  /**
   * The play context with the playlist's Loop flag, read NOW. Up Next wraps
   * to item 1 only when the context says `loop`, and only Play All used to
   * pass it, so Continue and a card click ended on "End of list" with Loop
   * on (V29). Read at click time rather than when the cards rendered: the
   * Loop toggle sits in the same header and flips without a re-render.
   *
   * Shuffle travels separately, as `_shuffleRequest`.
   */
  _withPlaylistLoop(playContext) {
    const id = playContext?.sourceContext?.playlistId;
    const pl = id ? this._playlistFor(id) : null;
    if (!pl) return playContext;
    return { ...playContext, loop: !!pl.loop };
  }

  /**
   * The playlist's Shuffle, for a card click or Continue: what Play All
   * would get (the reachable entries as queue items, balance by script,
   * unwatched first, the watched lookup), or null with Shuffle off. Read at
   * click time, like Loop. app.js `_withShuffledStart` turns it into the
   * context's order: the chosen video first, then a shuffled rest (V29).
   * Until then both played the list in order after the chosen video.
   */
  _shuffleRequest(playContext) {
    const id = playContext?.sourceContext?.playlistId;
    const pl = id ? this._playlistFor(id) : null;
    if (!pl?.shuffle) return null;
    const unreachable = new Set(playContext.unavailablePaths || []);
    const paths = (playContext.list || []).filter((p) => !unreachable.has(p));
    return {
      videoList: this._queueItems(paths),
      balanceByScript: !!pl.balanceByScript,
      preferUnwatched: !!pl.preferUnwatched,
      isWatched: (path) => isFinished(this._resumeEntryFor(path)),
    };
  }

  /** Playlist entries as the queue items Play All hands app.js. */
  _queueItems(paths) {
    return paths.map((p) => {
      const name = p.split(/[\\/]/).pop();
      const funscriptPath = this._getFunscriptPath(p);
      // A scanned pairing or an association is expected; `<name>.funscript`
      // is only a guess, and Play All must not warn when it is not there
      // (app.js `_loadQueueItemContent`, CB-12).
      return { name, path: p, funscriptPath, scriptExpected: this._hasExplicitAssociation(p) };
    });
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
  }

  /**
   * An offline tile: draw it from the shared thumbnail cache if the library
   * or another view already fetched it this session, otherwise keep the
   * placeholder. Never requests anything (FT-071).
   */
  _showCachedThumbnail(thumbnailEl, videoPath) {
    this._applyThumbnail(thumbnailEl, thumbCache.getEntry(videoPath, 0));
  }

  /** Put a capture result on the tile. False when there is no image. */
  _applyThumbnail(thumbnailEl, result) {
    const dataUrl = result?.dataUrl || result;
    if (!dataUrl) return false;
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
    return true;
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
    const confirmed = await Modal.confirm(t('playlists.deletePlaylist'), t('playlists.confirmDelete'), { confirmText: t('common.delete') });
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

    const videoList = this._queueItems(validPaths);
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
    // The rows live in play-options-modal.js, shared with the Library /
    // Categories play options (#381) so both dialogs read the same.
    openPlayOptionsModal({
      title: t('playlists.advanced.title'),
      values: pl,
      shuffleOn: !!pl.shuffle,
      onChange: (key, on) => {
        if (key === 'balanceByScript') {
          pl.balanceByScript = on;
          this._settings.setPlaylistBalance(pl.id, on);
        } else if (key === 'preferUnwatched') {
          pl.preferUnwatched = on;
          this._settings.setPlaylistPreferUnwatched(pl.id, on);
        }
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

  /**
   * Queue panel toggle, far right like the Library header's. Without it the
   * only way into the queue from Playlists was the undocumented Shift+Q
   * (forum #381, app test V27). Skipped when the app wired no handler.
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

  /** @param {boolean} [available=true] see `_createVideoCard`. */
  _createVideoListItem(videoPath, playlist, playContext, available = true) {
    const fileName = videoPath.split(/[\\/]/).pop() || videoPath;
    const displayName = fileName.replace(/\.[^/.]+$/, '');
    const row = document.createElement('div');
    row.className = 'playlists__list-item';
    // Identity for reorder: derive order from the DOM, key by path.
    row.dataset.videoPath = videoPath;
    row.dataset.videoName = displayName;
    // A Stash group's playlist is read-only: no handle, Move, drag, Select or
    // Remove (as the grid tile).
    const readOnly = playlist?.readOnly === true;

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
    row.draggable = !readOnly;
    row.addEventListener('dragstart', (e) => {
      if (readOnly) return;
      this._dragRow = row;
      row.classList.add('playlists__list-item--dragging');
      // A selected row takes the whole selection with it (FT-104).
      this._dragMove = this._selectMode && this._selectedPaths.has(videoPath)
        ? { paths: this._dragSet(videoPath), from: row }
        : null;
      if (this._dragMove) this._markDragging(this._dragMove.paths, true);
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
      if (this._dragMove) {
        this._dropMove(this._dragMove.paths, videoPath, after, playlist.id);
        return;
      }
      grid.insertBefore(dragged, after ? row.nextElementSibling : row);
      this._persistOrderFromDom(grid, playlist.id);
      const pos = [...grid.children].indexOf(dragged) + 1;
      this._announceReorder(dragged.dataset.videoName || '', pos, grid.children.length);
    });
    row.addEventListener('dragend', () => {
      this._dragRow?.classList.remove('playlists__list-item--dragging');
      this._dragRow = null;
      if (this._dragMove) this._markDragging(this._dragMove.paths, false);
      this._dragMove = null;
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
    removeBtn.className = 'playlists__card-action-btn playlists__card-action-btn--danger playlists__remove-one';
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

    if (readOnly) {
      row.append(title, heatmap, ...(resumeBar ? [resumeBar] : []), badges);
    } else {
      row.append(this._createSelectCheck(videoPath, displayName), handle, title, heatmap,
        ...(resumeBar ? [resumeBar] : []), badges, moveGroup, removeBtn);
    }

    row.addEventListener('click', (e) => {
      // Selecting: the grid tile's rule (FT-104).
      if (!readOnly && (this._selectMode || e.shiftKey || e.ctrlKey || e.metaKey)) {
        this._onSelectClick(videoPath, e);
        return;
      }
      // Same rule as the grid tile: unreachable explains, it doesn't open.
      if (row.dataset.unavailable === 'true') {
        this._notifyUnavailable(videoPath);
        return;
      }
      this._playVideoByPath(videoPath, this._playContextNow(playContext, videoPath));
    });

    if (available) {
      const funscriptPath = this._getFunscriptPath(videoPath);
      this._loadListStats(videoPath, funscriptPath, fsBadge, badges, heatmap, row);
    } else {
      // Offline: cached heatmap bins only, no read-funscript for a path the
      // probe already says is unreachable (FT-071, as categories.js).
      const cachedBins = this._binsByPath.get(videoPath);
      if (cachedBins) {
        queueRenderBins(heatmap, cachedBins);
      } else {
        row.classList.add('playlists__list-item--no-heatmap');
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
        queueRenderBins(heatmapEl, bins);
      }
    } catch {
      if (rowEl) rowEl.classList.add('playlists__list-item--no-heatmap');
      if (heatmapEl) heatmapEl.remove();
    }
  }

  // --- Stash groups: read-only playlists (Stash "next" lot #6, 2026-11-19) ---
  //
  // Each Stash group the user's linked videos belong to shows as a read-only
  // "Stash: <group>" playlist in Stash's order (stash-groups.js), derived
  // from the Stash data on every render: never one of the user's playlists,
  // never in config.json or a backup. Stash off or Remove Stash data hides
  // them. Play All, Shuffle all, Continue, Add to queue and Copy to my
  // playlists work; Rename, Delete, Remove, Move, Sort, Select and drag are
  // not offered (Stash owns the group; the detail's note says so).

  /** Is Stash on? Its group playlists show only then. */
  _stashOn() {
    return this._settings.get?.('stash.enabled') === true;
  }

  /** The Stash group playlists now, from the Stash data and the library's videos. */
  _stashGroupPlaylists() {
    if (!this._stashOn()) return [];
    const videos = this._library?._videos;
    return stashGroupPlaylists(stashData(), {
      enabled: true,
      videos: Array.isArray(videos) && videos.length > 0 ? videos : null,
    });
  }

  _stashGroupPlaylist(id) {
    if (!isStashGroupPlaylistId(id)) return null;
    return this._stashGroupPlaylists().find((g) => g.id === id) || null;
  }

  /**
   * A group's playlist as the play paths read a playlist: its shown name, and
   * the Library's play options (Loop, equal turns, prefer unwatched), since
   * it has no record of its own to keep them on. No Shuffle toggle: Shuffle
   * all is its button.
   */
  _stashGroupView(pl) {
    const options = readLibraryPlayOptions(this._settings);
    return {
      ...pl,
      name: this._stashGroupName(pl),
      videoPaths: pl.videoPaths.slice(),
      loop: options.loop,
      shuffle: false,
      balanceByScript: options.balanceByScript,
      preferUnwatched: options.preferUnwatched,
    };
  }

  /** A playlist by id: one of the user's, or a Stash group's (`_stashGroupView`). */
  _playlistFor(id) {
    if (!id) return null;
    if (!isStashGroupPlaylistId(id)) return this._settings.getPlaylist?.(id) || null;
    const pl = this._stashGroupPlaylist(id);
    return pl ? this._stashGroupView(pl) : null;
  }

  /** The name a playlist is shown by, a Stash group's ("Stash: <group>") included; null for none. */
  playlistName(id) {
    return this._playlistFor(id)?.name || null;
  }

  _stashGroupName(pl) {
    return t('playlists.stashGroups.name', { name: pl.name || t('playlists.stashGroups.unnamed') });
  }

  /**
   * The Stash data, Stash on / off or the library's videos changed: the grid
   * or the open group is drawn again when what it shows changed. A user
   * playlist's detail shows no group and is left alone (its Select mode too).
   */
  _onStashGroupsChanged() {
    if (!this._shown || !this._container) return;
    const onGroup = this._view === 'detail' && isStashGroupPlaylistId(this._detailPlaylistId);
    if (this._view !== 'grid' && !onGroup) return;
    if (stashGroupSignature(this._stashGroupPlaylists()) === this._stashGroupSig) return;
    if (onGroup) this._renderDetail(this._detailPlaylistId);
    else this._renderGrid();
  }

  /** "From Stash": the group playlists, under the user's own. */
  _createStashGroupSection(groups) {
    const section = document.createElement('section');
    section.className = 'playlists__stash-section';
    section.setAttribute('aria-labelledby', 'playlists-stash-heading');
    const heading = document.createElement('h2');
    heading.id = 'playlists-stash-heading';
    heading.className = 'playlists__section-title';
    heading.textContent = t('playlists.stashGroups.sectionTitle');
    const hint = document.createElement('p');
    hint.className = 'playlists__section-hint';
    hint.textContent = t('playlists.stashGroups.sectionHint');
    const grid = document.createElement('div');
    grid.className = 'playlists__grid playlists__grid--stash';
    grid.classList.toggle('playlists__grid--list', this._viewMode === 'list');
    for (const pl of groups) {
      grid.appendChild(this._viewMode === 'list' ? this._createStashGroupListItem(pl) : this._createStashGroupCard(pl));
    }
    section.append(heading, hint, grid);
    return section;
  }

  /** The read-only mark; its tooltip says why (Stash owns the group). */
  _createReadOnlyBadge() {
    const badge = document.createElement('span');
    badge.className = 'playlists__stash-badge';
    badge.appendChild(icon(Link, { width: 12, height: 12 }));
    const label = document.createElement('span');
    label.textContent = t('playlists.stashGroups.readOnly');
    badge.appendChild(label);
    badge.title = t('playlists.stashGroups.readOnlyReason');
    return badge;
  }

  _stashGroupCountText(pl) {
    const parts = [t('playlists.videoCount', { count: pl.videoPaths.length })];
    if (pl.missing > 0) parts.push(t('playlists.stashGroups.missingCount', { count: pl.missing }));
    return parts.join(' · ');
  }

  /** Click, Enter or Space opens the group's detail. */
  _makeStashGroupOpenable(el, pl) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const open = () => {
      this._view = 'detail';
      this._detailPlaylistId = pl.id;
      this._renderDetail(pl.id);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open();
    });
  }

  /** A group's tile: name, count, the read-only mark. No Rename or Delete. */
  _createStashGroupCard(pl) {
    const card = document.createElement('div');
    card.className = 'playlists__card playlists__card--stash';
    card.dataset.playlistId = pl.id;
    const body = document.createElement('div');
    body.className = 'playlists__card-body';
    const name = document.createElement('div');
    name.className = 'playlists__card-name';
    name.textContent = this._stashGroupName(pl);
    name.title = name.textContent;
    const count = document.createElement('div');
    count.className = 'playlists__card-count';
    count.textContent = this._stashGroupCountText(pl);
    body.append(name, count, this._createReadOnlyBadge());
    card.appendChild(body);
    this._makeStashGroupOpenable(card, pl);
    return card;
  }

  /** A group's row in list view, as the tile. */
  _createStashGroupListItem(pl) {
    const row = document.createElement('div');
    row.className = 'playlists__list-item playlists__list-item--stash';
    row.dataset.playlistId = pl.id;
    const name = document.createElement('span');
    name.className = 'playlists__list-name';
    name.textContent = this._stashGroupName(pl);
    const count = document.createElement('span');
    count.className = 'playlists__list-count';
    count.textContent = this._stashGroupCountText(pl);
    row.append(name, count, this._createReadOnlyBadge());
    this._makeStashGroupOpenable(row, pl);
    return row;
  }

  /**
   * A group's detail: its linked videos in Stash's order, each scene with no
   * linked video in the library shown as missing, and Play All, Shuffle all,
   * the play options, Continue, Add to queue and Copy to my playlists. Gone
   * (Stash off, Remove Stash data, a complete sync without it): the grid.
   */
  async _renderStashGroupDetail(playlistId, renderGen) {
    const groups = this._stashGroupPlaylists();
    const pl = groups.find((g) => g.id === playlistId) || null;
    if (!pl) {
      this._view = 'grid';
      this._detailPlaylistId = null;
      this._renderGrid();
      return;
    }
    this._stashGroupSig = stashGroupSignature(groups);
    this._clearSelectState();
    this._detailGrid = null;
    this._selectionBar = null;
    this._container.innerHTML = '';
    const view = this._stashGroupView(pl);

    const header = document.createElement('div');
    header.className = 'playlists__header';

    const backBtn = document.createElement('button');
    backBtn.className = 'playlists__back-btn';
    backBtn.appendChild(icon(ArrowLeft, { width: 20, height: 20 }));
    backBtn.title = t('playlists.backToPlaylists');
    backBtn.addEventListener('click', () => this.navigateBack());

    const title = document.createElement('span');
    title.className = 'playlists__title';
    title.textContent = view.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'playlists__detail-count';
    countSpan.textContent = t('playlists.videoCount', { count: pl.videoPaths.length });

    header.append(backBtn, title, countSpan, this._createReadOnlyBadge());

    // Each button reads the group as it is at the click.
    const now = () => this._playlistFor(playlistId);

    const playAllBtn = document.createElement('button');
    playAllBtn.type = 'button';
    playAllBtn.className = 'playlists__play-all-btn';
    playAllBtn.appendChild(icon(Play, { width: 14, height: 14 }));
    playAllBtn.appendChild(document.createTextNode(' ' + t('playlists.playAll')));
    playAllBtn.addEventListener('click', () => { const g = now(); if (g) this._playAll(g); });
    header.appendChild(playAllBtn);

    const continueTarget = this._playlistHasProgress(view)
      ? pickContinueTarget(view.videoPaths, this._playlistProgress(view.id)?.lastVideoPath || null, (p) => this._resumeEntryFor(p))
      : null;
    if (continueTarget) {
      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.className = 'playlists__continue-btn';
      continueBtn.appendChild(icon(History, { width: 14, height: 14 }));
      continueBtn.appendChild(document.createTextNode(' ' + t('playlists.continueWatching')));
      continueBtn.title = t('playlists.continueWatchingNamed', { name: shownName(continueTarget.path) });
      continueBtn.setAttribute('aria-label', continueBtn.title);
      continueBtn.addEventListener('click', () => { const g = now(); if (g) this._continueFromLastWatched(g); });
      header.appendChild(continueBtn);
    }

    const shuffleBtn = document.createElement('button');
    shuffleBtn.type = 'button';
    shuffleBtn.className = 'playlists__loop-btn playlists__stash-shuffle-btn';
    shuffleBtn.title = t('library.shuffleAllTitle');
    shuffleBtn.appendChild(icon(Shuffle, { width: 14, height: 14 }));
    shuffleBtn.appendChild(document.createTextNode(' ' + t('library.shuffleAll')));
    shuffleBtn.addEventListener('click', () => { const g = now(); if (g) this._playAll({ ...g, shuffle: true }); });
    header.appendChild(shuffleBtn);

    // The Library's play options (Loop, equal turns, prefer unwatched), shared
    // with its Shuffle All and the categories: a group has no record to hold
    // its own.
    const optionsBtn = document.createElement('button');
    optionsBtn.type = 'button';
    optionsBtn.className = 'playlists__loop-btn playlists__advanced-btn';
    optionsBtn.title = t('library.playOptions.openTitle');
    optionsBtn.setAttribute('aria-label', optionsBtn.title);
    optionsBtn.setAttribute('aria-haspopup', 'dialog');
    optionsBtn.appendChild(icon(SlidersHorizontal, { width: 14, height: 14 }));
    const paintOptions = () => optionsBtn.classList.toggle('is-on', anyLibraryPlayOption(this._settings));
    paintOptions();
    optionsBtn.addEventListener('click', () => openPlayOptionsModal({
      title: t('library.playOptions.title'),
      values: readLibraryPlayOptions(this._settings),
      includeLoop: true,
      shuffleOn: true,
      note: t('playlists.stashGroups.playOptionsNote'),
      onChange: (key, on) => { setLibraryPlayOption(this._settings, key, on); paintOptions(); },
    }));
    header.appendChild(optionsBtn);

    if (this._onAddPathsToQueue) {
      const queueBtn = document.createElement('button');
      queueBtn.type = 'button';
      queueBtn.className = 'playlists__loop-btn playlists__stash-queue-btn';
      queueBtn.title = t('playlists.stashGroups.addToQueueTitle');
      queueBtn.appendChild(icon(ListVideo, { width: 14, height: 14 }));
      queueBtn.appendChild(document.createTextNode(' ' + t('playlists.stashGroups.addToQueue')));
      queueBtn.addEventListener('click', () => this._addStashGroupToQueue(playlistId));
      header.appendChild(queueBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'playlists__loop-btn playlists__stash-copy-btn';
    copyBtn.title = t('playlists.stashGroups.copyTitle');
    copyBtn.appendChild(icon(Plus, { width: 14, height: 14 }));
    copyBtn.appendChild(document.createTextNode(' ' + t('playlists.stashGroups.copy')));
    copyBtn.addEventListener('click', () => this._copyStashGroup(playlistId));
    header.appendChild(copyBtn);

    this._addViewToggle(header);
    this._addQueueToggle(header);
    this._container.appendChild(header);

    // Why there is no Rename, Remove, Move, Sort or Select here.
    const note = document.createElement('p');
    note.className = 'playlists__stash-note';
    note.setAttribute('role', 'note');
    note.textContent = t('playlists.stashGroups.readOnlyReason');
    this._container.appendChild(note);

    const wrapper = document.createElement('div');
    wrapper.className = 'playlists__grid-wrapper';

    // Reachability as for any playlist: an offline video stays, greyed.
    const availableSet = await probeAvailability(pl.videoPaths.slice());
    if (renderGen !== this._renderGen) return; // a newer render owns the container
    const isAvailable = availabilityPredicate(availableSet);
    this._availablePaths = availableSet;
    const { unavailable } = partitionByAvailability(pl.videoPaths, isAvailable);
    if (unavailable.length > 0) wrapper.appendChild(this._createUnavailableNotice(unavailable));

    const grid = document.createElement('div');
    grid.className = 'playlists__grid';
    grid.classList.toggle('playlists__grid--list', this._viewMode === 'list');
    const list = pl.videoPaths.slice();
    for (const entry of pl.entries) {
      if (!entry.path) {
        grid.appendChild(this._createMissingSceneItem(entry));
        continue;
      }
      const playContext = {
        source: 'playlist',
        sourceLabel: `playlist "${view.name}"`,
        sourceContext: { playlistId: pl.id },
        list: list.slice(),
        index: list.indexOf(entry.path),
        unavailablePaths: unavailable.slice(),
      };
      const available = isAvailable(entry.path);
      const el = this._viewMode === 'list'
        ? this._createVideoListItem(entry.path, view, playContext, available)
        : this._createVideoCard(entry.path, view, playContext, available);
      if (!available) this._markUnavailable(el, entry.path);
      grid.appendChild(el);
    }
    wrapper.appendChild(grid);
    this._container.appendChild(wrapper);
  }

  /** A scene of the group with no linked video in the library: listed, never played or guessed. */
  _createMissingSceneItem(entry) {
    const name = entry.title || t('playlists.stashGroups.untitledScene');
    const asRow = this._viewMode === 'list';
    const el = document.createElement('div');
    el.className = asRow ? 'playlists__list-item playlists__stash-missing' : 'playlists__video-card playlists__stash-missing';
    el.dataset.stashSceneId = entry.sceneId;
    el.setAttribute('aria-disabled', 'true');
    el.title = t('playlists.stashGroups.missingSceneTooltip');
    const titleEl = document.createElement(asRow ? 'span' : 'div');
    titleEl.className = asRow ? 'playlists__list-name' : 'playlists__video-title';
    titleEl.textContent = name;
    const noteEl = document.createElement('span');
    noteEl.className = 'playlists__stash-missing-note';
    noteEl.textContent = t('playlists.stashGroups.missingScene');
    if (asRow) {
      const mark = icon(FileX, { width: 14, height: 14 });
      mark.setAttribute('aria-hidden', 'true');
      el.append(mark, titleEl, noteEl);
      return el;
    }
    const thumbnail = document.createElement('div');
    thumbnail.className = 'playlists__video-thumbnail';
    const placeholder = document.createElement('div');
    placeholder.className = 'playlists__video-placeholder playlists__video-placeholder--broken';
    placeholder.appendChild(icon(FileX, { width: 32, height: 32 }));
    thumbnail.appendChild(placeholder);
    const info = document.createElement('div');
    info.className = 'playlists__video-info';
    info.append(titleEl, noteEl);
    el.append(thumbnail, info);
    return el;
  }

  /**
   * Add to queue: the group's reachable videos, in Stash's order, onto the
   * end of the user's queue in one go (app.js skips those already queued).
   */
  async _addStashGroupToQueue(playlistId) {
    const pl = this._stashGroupPlaylist(playlistId);
    if (!pl || !this._onAddPathsToQueue) return;
    const isAvailable = availabilityPredicate(await probeAvailability(pl.videoPaths.slice()));
    const { available, unavailable } = partitionByAvailability(pl.videoPaths, isAvailable);
    const { showToast } = await import('../js/toast.js');
    if (available.length === 0) {
      showToast(t('toast.playlistAllUnavailable'), 'warn');
      return;
    }
    const added = Number(this._onAddPathsToQueue(available.slice())) || 0;
    if (unavailable.length > 0) showToast(t('toast.playlistSkippedUnavailable', { count: unavailable.length }), 'info');
    showToast(added > 0
      ? t('playlists.stashGroups.addedToQueue', { count: added })
      : t('queuePanel.toastAlreadyQueued'), 'info');
  }

  /**
   * Copy to my playlists: a new playlist of the user's own (named as they
   * choose, the group's name offered), with the group's linked videos in
   * Stash's order. It is an ordinary playlist from then on: editable, and
   * it does not follow Stash. The group is untouched.
   */
  async _copyStashGroup(playlistId) {
    const pl = this._stashGroupPlaylist(playlistId);
    if (!pl) return;
    const name = await Modal.prompt(t('playlists.stashGroups.copy'), t('playlists.playlistNamePlaceholder'), pl.name || this._stashGroupName(pl));
    if (!name) return;
    const paths = (this._stashGroupPlaylist(playlistId) || pl).videoPaths.slice();
    let created = null;
    try {
      created = await this._settings.addPlaylist(name);
    } catch (err) {
      console.warn('[Playlists] could not copy the Stash group', err?.message || err);
    }
    const { showToast } = await import('../js/toast.js');
    if (!created?.id) {
      showToast(t('playlists.stashGroups.copyFailed'), 'error');
      return;
    }
    if (paths.length > 0) this._settings.addVideosToPlaylist(created.id, paths);
    showToast(t('playlists.stashGroups.copied', { name }), 'info');
  }
}
