// FunSync Web Remote — vanilla ES module SPA.
// Two views: library list + player. Navigation via hashchange so the phone's
// back button / swipe-back works naturally. Reads the library from
// /api/remote/videos and streams / scripts / thumbnails from the existing
// /api/media/* endpoints.

import { computeBins, renderBins } from './heatmap.js';
import { RemoteSyncClient } from './remote-sync.js';
import { fuzzySearch, sortVideos } from './library-search.js';
import { buildContextMapFromGroupings } from './search-context.js';
import { isVRVideo } from './vr-detect.js';
import { svgIcon } from './icons.js';
import { buildFolderIndex, descendantsOf, breadcrumbOf, canonicalPath, commonAncestorOfFiles } from './folder-index.js';

// === Mobile viewport-height sync ===
//
// iOS Safari has a long-standing layout bug: `100vh` doesn't account for
// the dynamic browser chrome (URL bar / bottom toolbar), and even
// `100dvh` (the modern fix) doesn't always recompute promptly after
// orientation change. Going landscape -> portrait frequently leaves the
// root container stuck at the pre-rotate dvh value, causing the page +
// player to no longer fit the screen until the user scrolls or
// re-renders. The canonical fix (and what every major mobile-web SPA
// does) is to maintain a `--app-vh` CSS custom property in JS, updated
// on every viewport-changing event, and use `calc(var(--app-vh) * 100)`
// instead of `100vh` / `100dvh` for the root container.
//
// Reported 2026-04-29 against the web-remote.
function _syncViewportHeight() {
  // window.innerHeight reflects the actual visible-content height on
  // mobile (excludes browser chrome). Multiply by 0.01 so the consumer
  // CSS can write `calc(var(--app-vh) * 100)` to match the `100vh`
  // mental model.
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--app-vh', `${vh}px`);
}
_syncViewportHeight();
window.addEventListener('resize', _syncViewportHeight);
window.addEventListener('orientationchange', () => {
  // iOS Safari reports stale innerHeight if you read it synchronously
  // inside the orientationchange handler — wait one frame for the
  // browser to settle on post-rotate dimensions before sampling.
  requestAnimationFrame(_syncViewportHeight);
});
if (window.visualViewport) {
  // visualViewport.resize fires for chrome show/hide AND keyboard
  // events on iOS, where `window.resize` doesn't always. Strictly more
  // accurate than window.resize on mobile when supported.
  window.visualViewport.addEventListener('resize', _syncViewportHeight);
}

const mainEl = document.getElementById('main');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('backBtn');
const countEl = document.getElementById('count');
const breadcrumbEl = document.getElementById('breadcrumb');
const toolbarEl = document.getElementById('toolbar');
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const searchIconSlot = document.getElementById('searchIconSlot');
const filterChipsEl = document.getElementById('filterChips');
const sortBtn = document.getElementById('sortBtn');
const sortIconSlot = document.getElementById('sortIconSlot');
const viewToggle = document.getElementById('viewToggle');
const viewIconSlot = document.getElementById('viewIconSlot');
const folderToggle = document.getElementById('folderToggle');
const folderIconSlot = document.getElementById('folderIconSlot');
const filtersBtn = document.getElementById('filtersBtn');
const filtersIconSlot = document.getElementById('filtersIconSlot');
const filtersBadge = document.getElementById('filtersBadge');
const contentActionsEl = document.getElementById('contentActions');
const refreshBtn = document.getElementById('refreshBtn');
const navTabsEl = document.getElementById('navTabs');
const filterSheetEl = document.getElementById('filterSheet');
const sortSheetEl = document.getElementById('sortSheet');

// Populate header + search chrome + content-actions + nav-tabs with inline
// SVGs (Lucide set, currentColor). Single-append at startup — syncControlsUI
// later swaps the view-toggle icon and updates filters-badge counts.
backBtn.appendChild(svgIcon('arrowLeft', 22));
refreshBtn.appendChild(svgIcon('refresh', 18));
searchClear.appendChild(svgIcon('x', 16));
searchIconSlot.appendChild(svgIcon('search', 18));
sortIconSlot.appendChild(svgIcon('arrowDownAZ', 18));
folderIconSlot.appendChild(svgIcon('folder', 18));
filtersIconSlot.appendChild(svgIcon('slidersHorizontal', 18));
// View-toggle icon set in syncControlsUI() since it flips with state.
// Bottom-nav icons — one per mode, paired with always-visible label.
document.getElementById('navLibraryIcon').appendChild(svgIcon('library', 22));
document.getElementById('navCollectionsIcon').appendChild(svgIcon('layoutGrid', 22));
document.getElementById('navPlaylistsIcon').appendChild(svgIcon('listMusic', 22));
document.getElementById('navCategoriesIcon').appendChild(svgIcon('tag', 22));

let library = null;       // cached list of video objects
let sources = null;       // cached list from /api/remote/sources
let folderIndex = null;   // Map<canonicalPath, FolderNode> — built from library+sources
let collections = null;   // cached list from /api/remote/collections
let playlists = null;     // cached list from /api/remote/playlists
let categories = null;    // cached list from /api/remote/categories
// Map<videoPath, string[]> of grouping names assigned to each video.
// Built lazily on first search so the user can find videos by typing a
// collection / playlist / category name (e.g. "Gym" → all videos in
// the "Gym" collection), matching the desktop's fuzzySearch behaviour.
// Null when not yet built; rebuilt on refresh.
let searchContextMap = null;
let _searchContextLoading = false;
let currentView = 'list'; // 'list' | 'player' | 'groupings' | 'grouping-detail'
let currentMode = 'library'; // 'library' | 'collections' | 'playlists' | 'categories'
let activeSyncClient = null;  // torn down on view change / unload

// Persisted filter/sort state
const storedState = loadFilterState();
let uiState = {
  search: '',
  tab: storedState.tab || 'all',          // matched | unmatched | all
  sort: storedState.sort || 'name:asc',
  vr: storedState.vr || 'all',             // all | vr | flat
  view: storedState.view || 'grid',        // grid | list
};

backBtn.addEventListener('click', () => {
  // Hash navigation — triggers hashchange → renders list.
  location.hash = '';
});

window.addEventListener('hashchange', render);
window.addEventListener('load', render);

/**
 * Fetch the library once, then cache. Subsequent navigations reuse it.
 *
 * If the library arrives with durations still missing (backend is
 * probing them in the background), schedule a silent re-fetch so the
 * user sees durations fill in without needing to hit refresh.
 */
async function loadLibrary() {
  if (library) return library;
  // Skeletons are painted by the calling render function (it knows the
  // shape — card grid vs row list vs grouping list). Fall through to a
  // bare loading text only on direct callers that don't paint
  // skeletons (e.g. renderPlayer's lookup before video loads).
  if (!mainEl.firstElementChild?.classList?.contains('skeleton')
      && !mainEl.querySelector('.skeleton')) {
    mainEl.innerHTML = '<div class="loading">Loading library…</div>';
  }
  try {
    const resp = await fetch('/api/remote/videos');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    library = data.videos || [];
  } catch (err) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Couldn't load library</div>
        <div>${escapeHtml(err.message)}</div>
      </div>`;
    throw err;
  }
  _scheduleDurationRefreshIfNeeded();
  // Kick off the search context build in the background — it needs the
  // three grouping endpoints fetched + inverted, which would otherwise
  // happen on first search keystroke and miss that initial render. If
  // the user already has a search active when context lands, re-render
  // so the freshly-available context affects the score.
  ensureSearchContext().then(() => {
    if (uiState.search) render();
  }).catch(() => { /* fall through — search degrades to no-context */ });
  return library;
}

// Silent re-fetches while the backend is still probing durations. Stops
// as soon as everything has a duration, the user navigates off, or we hit
// the attempt cap (don't poll forever for unprobe-able files — e.g.
// disconnected source).
let _durationRefreshTimer = null;
let _durationRefreshAttempts = 0;
const DURATION_REFRESH_MAX_ATTEMPTS = 5;
const DURATION_REFRESH_INTERVAL_MS = 4000;

function _scheduleDurationRefreshIfNeeded() {
  if (!library || library.length === 0) return;
  // "Missing" covers either no duration OR no speed stats (the backend
  // probes both in parallel after /register, so the phone just polls once
  // for both kinds of data).
  const missingCount = library.filter(v =>
    !v.duration || (v.hasFunscript && v.avgSpeed == null)
  ).length;
  if (missingCount === 0) {
    _durationRefreshAttempts = 0;
    return;
  }
  if (_durationRefreshAttempts >= DURATION_REFRESH_MAX_ATTEMPTS) return;
  if (_durationRefreshTimer) return;  // already scheduled

  _durationRefreshTimer = setTimeout(async () => {
    _durationRefreshTimer = null;
    _durationRefreshAttempts++;
    try {
      const resp = await fetch('/api/remote/videos');
      if (!resp.ok) return;
      const data = await resp.json();
      const fresh = data.videos || [];
      // Merge newly-learned duration + speed stats into the existing
      // library array so already-rendered views pick them up on the next
      // rerenderCurrent().
      const byId = new Map(fresh.map(v => [v.id, v]));
      let updated = 0;
      for (const v of library) {
        const hit = byId.get(v.id);
        if (!hit) continue;
        if (hit.duration && !v.duration) { v.duration = hit.duration; updated++; }
        if (hit.avgSpeed != null && v.avgSpeed == null) { v.avgSpeed = hit.avgSpeed; updated++; }
        if (hit.maxSpeed != null && v.maxSpeed == null) { v.maxSpeed = hit.maxSpeed; updated++; }
      }
      // Also refresh grouping caches so their totalDuration gets refreshed —
      // cheap, same backend call pattern the refresh button uses. Folder
      // tree doesn't need to rebuild because videos are merged in-place on
      // the same references the tree holds.
      if (updated > 0) {
        collections = null;
        playlists = null;
        categories = null;
        searchContextMap = null;
        rerenderCurrent();
      }
    } catch { /* transient — the next attempt will retry */ }
    _scheduleDurationRefreshIfNeeded();
  }, DURATION_REFRESH_INTERVAL_MS);
}

/**
 * Fetch + cache the library source folders. Used to seed the folder tree
 * with its source roots (so the walker knows where to stop climbing).
 */
async function loadSources() {
  if (sources) return sources;
  const resp = await fetch('/api/remote/sources');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  sources = data.sources || [];
  return sources;
}

/**
 * Build the folder tree once per session, keyed on library + sources. Any
 * refresh clears both caches so rebuilding happens lazily on next access.
 */
async function ensureFolderIndex() {
  if (folderIndex) return folderIndex;
  const [vids, srcs] = await Promise.all([loadLibrary(), loadSources()]);
  folderIndex = buildFolderIndex(vids, srcs);
  return folderIndex;
}

/**
 * Build a Map<videoPath, string[]> of grouping names assigned to each
 * video — the same shape `library.js::_buildSearchContextMap` produces
 * on desktop. Without this, searching "gym" on mobile won't find videos
 * the user has put into a collection called "Gym" the way it does on
 * desktop. Lazy + cached: kicked off after `loadLibrary` so the context
 * is typically ready by the time the user types, but applyFilters does
 * a graceful fallback (omit contextMap) if the user beats the fetch.
 */
async function ensureSearchContext() {
  if (searchContextMap) return searchContextMap;
  if (_searchContextLoading) return null;
  _searchContextLoading = true;
  try {
    const [cols, pls, cats] = await Promise.all([
      loadGrouping('collections'),
      loadGrouping('playlists'),
      loadGrouping('categories'),
    ]);
    searchContextMap = buildContextMapFromGroupings(library, cols, pls, cats);
    return searchContextMap;
  } finally {
    _searchContextLoading = false;
  }
}

/**
 * Generic loader for the view-only grouping endpoints. Caches per-kind so
 * switching modes doesn't re-fetch. Refresh button clears the cache.
 */
async function loadGrouping(kind) {
  const cache = { collections, playlists, categories }[kind];
  if (cache) return cache;
  const resp = await fetch(`/api/remote/${kind}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const out = data[kind] || [];
  if (kind === 'collections') collections = out;
  else if (kind === 'playlists') playlists = out;
  else if (kind === 'categories') categories = out;
  return out;
}

async function render() {
  // Every view change tears down the sync client for the previous view —
  // leaving it open would keep driving devices after the user navigates away.
  if (activeSyncClient) {
    activeSyncClient.stop();
    activeSyncClient = null;
  }

  const hash = location.hash.slice(1); // strip '#'

  if (hash.startsWith('play/')) {
    currentView = 'player';
    backBtn.hidden = false;
    await renderPlayer(hash.slice('play/'.length));
    return;
  }

  // Grouping detail: #collection/:id, #playlist/:id, #category/:id
  const detailMatch = hash.match(/^(collection|playlist|category)\/(.+)$/);
  if (detailMatch) {
    const kind = detailMatch[1] + 's';  // collection → collections
    currentMode = kind;
    currentView = 'grouping-detail';
    backBtn.hidden = false;
    await renderGroupingDetail(kind, detailMatch[2]);
    return;
  }

  // Grouping list: #collections, #playlists, #categories
  if (hash === 'collections' || hash === 'playlists' || hash === 'categories') {
    currentMode = hash;
    currentView = 'groupings';
    backBtn.hidden = true;
    setBrandTitle();
    await renderGroupingsList(hash);
    return;
  }

  // Folder browse: #folder (root — list of source folders) or
  // #folder/<canonicalPath> (contents of that folder — subfolders + videos).
  if (hash === 'folder') {
    currentMode = 'library';
    currentView = 'folders';
    backBtn.hidden = true;
    setBrandTitle();
    await renderFolderRoot();
    return;
  }
  if (hash.startsWith('folder/')) {
    currentMode = 'library';
    currentView = 'folder-detail';
    backBtn.hidden = false;
    const canonical = decodeURIComponent(hash.slice('folder/'.length));
    await renderFolderAt(canonical);
    return;
  }

  // Default: library mode
  currentMode = 'library';
  currentView = 'list';
  backBtn.hidden = true;
  setBrandTitle();
  await renderList();
}

// "FunSync" with the Fun- syllable in coral accent — matches the desktop
// splash screen. textContent would strip the span, so we build it in DOM.
function setBrandTitle() {
  titleEl.replaceChildren();
  const fun = document.createElement('span');
  fun.className = 'brand-accent';
  fun.textContent = 'Fun';
  titleEl.appendChild(fun);
  titleEl.appendChild(document.createTextNode('Sync'));
}

// Clean up the WebSocket on page unload so the desktop sees a clean
// disconnect (otherwise the socket hangs until TCP timeout).
window.addEventListener('beforeunload', () => {
  if (activeSyncClient) {
    activeSyncClient.stop();
    activeSyncClient = null;
  }
});

async function renderList() {
  toolbarEl.classList.remove('toolbar--hidden');
  contentActionsEl.classList.remove('content-actions--hidden');
  syncControlsUI();
  renderBreadcrumb([{ label: 'Library' }]);
  // Paint shape-matching skeletons before the await so the layout
  // doesn't reflow when data arrives (§3.4.1a).
  renderSkeletons(uiState.view === 'grid' ? 'card' : 'row',
                  uiState.view === 'grid' ? 6 : 8);

  let videos;
  try {
    videos = await loadLibrary();
  } catch { return; }

  const filtered = applyFilters(videos);
  countEl.textContent = filtered.length ? `${filtered.length}` : '';
  // Dwell once before ANY post-fetch render — empty / no-match / data
  // all share the same calmness contract (§3.4.1a point 6).
  await awaitSkeletonMinDwell();

  if (videos.length === 0) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">No videos yet</div>
        <div>Add a source folder in FunSync on your desktop.</div>
      </div>`;
    return;
  }
  if (filtered.length === 0) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">No matches</div>
        <div>Try a different search or filter.</div>
      </div>`;
    return;
  }

  if (uiState.view === 'grid') {
    mainEl.innerHTML = '';
    mainEl.appendChild(renderGrid(filtered));
  } else {
    mainEl.innerHTML = '';
    mainEl.appendChild(renderRows(filtered));
  }
}

function applyFilters(videos) {
  let out = applyMatchedVrFilters(videos);
  if (uiState.search) {
    // Pass the lazily-built contextMap so collection / playlist /
    // category names contribute to the score (parity with desktop
    // library.js::_applyFilters). When `searchContextMap` is still
    // null (first keystroke before the background fetch returns),
    // fuzzySearch silently degrades to name + path matching — same
    // result the user got pre-fix, just without context boost.
    out = fuzzySearch(out, uiState.search, {
      contextMap: searchContextMap || undefined,
    });
    // fuzzySearch returns results already ranked by relevance (exact
    // title match → prefix → word boundary → substring → fuzzy). Skip
    // sortVideos in this branch — re-sorting by name/duration/etc.
    // would throw that ranking away and let alphabetically-earlier
    // partial matches sink the exact-title match. Mirrors the desktop
    // gate at renderer/components/library.js:4252.
  } else {
    const [field, dir] = (uiState.sort || 'name:asc').split(':');
    out = sortVideos(out, field, dir || 'asc');
  }
  return out;
}

/**
 * Just the Matched/Unmatched + VR subset of filters — no search, no sort.
 * Reused when counting descendants for folder-empty-hide so the count
 * doesn't collapse just because the user's search query doesn't match any
 * video NAMES inside (those aren't relevant at the folder-row level).
 */
function applyMatchedVrFilters(videos) {
  let out = videos;
  if (uiState.tab === 'matched') out = out.filter(v => v.hasFunscript);
  else if (uiState.tab === 'unmatched') out = out.filter(v => !v.hasFunscript);
  if (uiState.vr === 'vr') out = out.filter(v => isVRVideo(v.name));
  else if (uiState.vr === 'flat') out = out.filter(v => !isVRVideo(v.name));
  return out;
}

// --- Grouping list view (collections / playlists / categories) ----------

async function renderGroupingsList(kind) {
  toolbarEl.classList.remove('toolbar--hidden');
  // Filters (matched/sort/vr) don't apply to grouping cards themselves,
  // only to the videos inside. Hide the action bar in the list view —
  // search stays visible (parity with desktop) so users can search the
  // grouping names directly.
  contentActionsEl.classList.add('content-actions--hidden');
  // syncControlsUI updates placeholder via currentMode, so the per-mode
  // text ("Search collections" etc.) lands automatically.
  syncControlsUI();
  renderBreadcrumb([{ label: MODE_TITLES[kind] || kind }]);
  // Grouping rows take a different skeleton shape (badge + name + meta)
  renderSkeletons('grouping', 5);

  let items;
  try {
    items = await loadGrouping(kind);
  } catch (err) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Couldn't load ${kind}</div>
        <div>${escapeHtml(err.message)}</div>
      </div>`;
    return;
  }

  // Filter grouping cards by search query. Reuses fuzzySearch (same
  // tokenisation / separator-flattening as the video search) so typing
  // "two girls" matches a collection named "Two-Girl Scenes" the same
  // way it would match a video filename. Wraps each grouping as a
  // {name, path} so fuzzySearch's name+path tiers don't error on
  // missing path; we strip the wrapper after.
  let filtered = items;
  if (uiState.search) {
    const wrapped = items.map(g => ({ name: g.name || '', path: g.name || '', _orig: g }));
    filtered = fuzzySearch(wrapped, uiState.search).map(w => w._orig);
  }

  countEl.textContent = filtered.length ? `${filtered.length}` : '';

  if (items.length === 0) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">No ${kind} yet</div>
        <div>Create ${kind} in FunSync on your desktop — they'll show up here.</div>
      </div>`;
    return;
  }
  if (filtered.length === 0) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">No matches</div>
        <div>Try a different search.</div>
      </div>`;
    return;
  }

  await awaitSkeletonMinDwell();
  mainEl.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'grouping-list';
  for (const item of filtered) list.appendChild(createGroupingRow(kind, item));
  mainEl.appendChild(list);
}

function createGroupingRow(kind, item) {
  const singular = kind.slice(0, -1); // collections → collection
  const row = document.createElement('div');
  row.className = 'grouping-row';
  row.addEventListener('click', () => { location.hash = `${singular}/${item.id}`; });

  // Colour dot for categories, icon tile for others
  const badge = document.createElement('span');
  badge.className = 'grouping-row__badge';
  if (kind === 'categories') {
    badge.classList.add('grouping-row__badge--dot');
    badge.style.backgroundColor = item.color || '#888';
  } else {
    badge.appendChild(svgIcon(kind === 'playlists' ? 'play' : 'layoutGrid', 18));
  }
  row.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'grouping-row__info';
  const name = document.createElement('div');
  name.className = 'grouping-row__name';
  name.textContent = item.name;
  info.appendChild(name);
  const sub = document.createElement('div');
  sub.className = 'grouping-row__sub';
  const countLabel = item.videoCount === 1 ? '1 video' : `${item.videoCount || 0} videos`;
  const runtime = formatTotalDuration(item.totalDuration || 0);
  sub.textContent = runtime ? `${countLabel} • ${runtime}` : countLabel;
  info.appendChild(sub);
  row.appendChild(info);

  const chev = document.createElement('span');
  chev.className = 'grouping-row__chev';
  chev.textContent = '›';
  row.appendChild(chev);

  return row;
}

// --- Folder browse (real subfolder tree) --------------------------------
//
// Ports the desktop's folder-index walker. The root view lists source
// roots; drilling in shows that folder's immediate subfolders + any
// videos that live directly at that level. Subfolders are further
// drillable.
//
// Hash scheme:
//   #folder                        → root (list of source roots)
//   #folder/<encodedCanonicalPath> → folder at that canonical path
//
// The canonical path already uses forward slashes + lowercased drive
// letter, so encodeURIComponent gives us a URL-safe round-trip.

async function renderFolderRoot() {
  toolbarEl.classList.remove('toolbar--hidden');
  // Show the action bar so Matched/VR filters can hide empty sources.
  // Sort is conceptually allowed but defaults to name (no other key
  // applies to source folders) — the bar is shown unchanged for
  // simplicity. User taps the chip to remove a filter if needed.
  contentActionsEl.classList.remove('content-actions--hidden');
  searchInput.placeholder = 'Search sources';
  syncControlsUI();
  renderBreadcrumb([{ label: 'Folders' }]);
  // Source list = grouping-row shape (badge + label + sub).
  renderSkeletons('grouping', 3);

  let index;
  try {
    index = await ensureFolderIndex();
  } catch (err) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Couldn't load folders</div>
        <div>${escapeHtml(err.message)}</div>
      </div>`;
    return;
  }

  // Source roots only — every node where isSourceRoot is true.
  const roots = [...index.values()].filter(n => n.isSourceRoot);

  // Pre-compute filtered descendant counts once per source so the filter
  // can hide empty sources. We deliberately skip the search filter here —
  // search at this level matches source NAMES, not descendants.
  let items = roots.map(n => {
    const all = descendantsOf(index, n.path);
    const matching = applyMatchedVrFilters(all);
    return {
      path: n.path,
      label: n.label,
      videoCount: matching.length,   // filtered count drives the "X videos" sub
      totalCount: all.length,        // kept for the "no matches" check
      totalDuration: matching.reduce((sum, v) => sum + (v.duration || 0), 0),
    };
  });

  // Hide empties when filters are active (Matched/Unmatched or VR); leave
  // always-empty source roots visible when no filter is on so the user
  // still sees their configured sources.
  const filtersActive = uiState.tab !== 'all' || uiState.vr !== 'all';
  if (filtersActive) items = items.filter(s => s.videoCount > 0);

  if (uiState.search) {
    const q = uiState.search.toLowerCase();
    items = items.filter(s => s.label.toLowerCase().includes(q));
  }
  items.sort((a, b) => a.label.localeCompare(b.label));

  countEl.textContent = items.length ? `${items.length}` : '';

  if (items.length === 0) {
    const title = filtersActive ? 'No matches' : 'No sources';
    const hint = filtersActive
      ? 'No sources contain videos that match the current filter.'
      : 'Add a source folder in FunSync on your desktop.';
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">${escapeHtml(title)}</div>
        <div>${escapeHtml(hint)}</div>
      </div>`;
    return;
  }

  await awaitSkeletonMinDwell();
  mainEl.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'grouping-list';
  for (const item of items) list.appendChild(createFolderRow(item));
  mainEl.appendChild(list);
}

/**
 * Render a single folder's contents: subfolders first (as folder rows),
 * then videos at this level (as the usual grid/list). This mirrors the
 * desktop's drilled-folder view.
 */
async function renderFolderAt(canonicalFolderPath) {
  toolbarEl.classList.remove('toolbar--hidden');
  contentActionsEl.classList.remove('content-actions--hidden');
  // Placeholder is set after we resolve the folder name (below) so the
  // breadcrumb-aware label drives both the title and the search hint.
  syncControlsUI();

  let index;
  try {
    index = await ensureFolderIndex();
  } catch { return; }

  const node = index.get(canonicalFolderPath);
  if (!node) {
    titleEl.replaceChildren();
    titleEl.textContent = '(not found)';
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Folder not found</div>
        <div>This folder is no longer on the desktop.</div>
      </div>`;
    return;
  }

  // Header title = this folder's label; back button already visible.
  titleEl.replaceChildren();
  titleEl.textContent = node.label;

  // Inline folder breadcrumb above the grid. Renamed local from
  // `breadcrumbEl` to `folderCrumbEl` post-redesign so it no longer
  // shadows the new top-level `breadcrumbEl` global. Top breadcrumb
  // also gets populated from the same crumbs so the user has a
  // matching path indicator in the header (Nielsen #1 visibility).
  const crumbs = breadcrumbOf(index, canonicalFolderPath);
  const folderCrumbEl = document.createElement('nav');
  folderCrumbEl.className = 'folder-breadcrumb';
  const rootCrumb = document.createElement('button');
  rootCrumb.type = 'button';
  rootCrumb.className = 'folder-breadcrumb__item';
  rootCrumb.textContent = 'All sources';
  rootCrumb.addEventListener('click', () => { location.hash = 'folder'; });
  folderCrumbEl.appendChild(rootCrumb);
  for (let i = 0; i < crumbs.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'folder-breadcrumb__sep';
    sep.textContent = '›';
    folderCrumbEl.appendChild(sep);
    const crumb = crumbs[i];
    const isCurrent = i === crumbs.length - 1;
    if (isCurrent) {
      const label = document.createElement('span');
      label.className = 'folder-breadcrumb__item folder-breadcrumb__item--current';
      label.textContent = crumb.label;
      folderCrumbEl.appendChild(label);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folder-breadcrumb__item';
      btn.textContent = crumb.label;
      btn.addEventListener('click', () => {
        location.hash = `folder/${encodeURIComponent(crumb.path)}`;
      });
      folderCrumbEl.appendChild(btn);
    }
  }
  // Mirror the same trail into the top breadcrumb.
  renderBreadcrumb([
    { label: 'Folders', hash: 'folder' },
    ...crumbs.map((c, i) => ({
      label: c.label,
      hash: i < crumbs.length - 1
        ? `folder/${encodeURIComponent(c.path)}`
        : null,
    })),
  ]);

  // Children — subfolders first, then videos at this folder level. When
  // Matched/VR filters are active, each subfolder is counted against them
  // and hidden if zero matching descendants remain. Keeps drilled views
  // consistent with the "hide empty sources" root behaviour.
  const filtersActive = uiState.tab !== 'all' || uiState.vr !== 'all';
  const subfolders = [...node.childFolders]
    .map(p => index.get(p))
    .filter(Boolean)
    .map(n => {
      const descendants = descendantsOf(index, n.path);
      const matching = applyMatchedVrFilters(descendants);
      return {
        path: n.path,
        label: n.label,
        videoCount: matching.length,
        totalDuration: matching.reduce((sum, v) => sum + (v.duration || 0), 0),
      };
    })
    .filter(n => !filtersActive || n.videoCount > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  // Filter videos at this level — only the ones directly in `node.videos`,
  // NOT descendants. Mirrors desktop behaviour: drilling is explicit.
  const filtered = applyFilters(node.videos);
  const totalCount = subfolders.length + filtered.length;
  countEl.textContent = totalCount ? `${totalCount}` : '';

  mainEl.innerHTML = '';
  mainEl.appendChild(folderCrumbEl);

  if (subfolders.length === 0 && filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <div class="empty__title">Empty folder</div>
      <div>No subfolders or videos here.</div>`;
    mainEl.appendChild(empty);
    return;
  }

  if (subfolders.length > 0) {
    const subList = document.createElement('div');
    subList.className = 'grouping-list';
    for (const item of subfolders) subList.appendChild(createFolderRow(item));
    mainEl.appendChild(subList);
  }

  if (filtered.length > 0) {
    if (uiState.view === 'grid') mainEl.appendChild(renderGrid(filtered));
    else mainEl.appendChild(renderRows(filtered));
  }
}

function createFolderRow(item) {
  const row = document.createElement('div');
  row.className = 'grouping-row';
  row.addEventListener('click', () => {
    location.hash = `folder/${encodeURIComponent(item.path)}`;
  });

  const badge = document.createElement('span');
  badge.className = 'grouping-row__badge';
  badge.appendChild(svgIcon('folder', 18));
  row.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'grouping-row__info';
  const name = document.createElement('div');
  name.className = 'grouping-row__name';
  name.textContent = item.label;
  info.appendChild(name);
  const sub = document.createElement('div');
  sub.className = 'grouping-row__sub';
  const countLabel = item.videoCount === 1 ? '1 video' : `${item.videoCount} videos`;
  const runtime = formatTotalDuration(item.totalDuration);
  sub.textContent = runtime ? `${countLabel} • ${runtime}` : countLabel;
  info.appendChild(sub);
  row.appendChild(info);

  const chev = document.createElement('span');
  chev.className = 'grouping-row__chev';
  chev.textContent = '›';
  row.appendChild(chev);

  return row;
}

// --- Grouping detail view (videos inside a selected grouping) ------------

async function renderGroupingDetail(kind, id) {
  toolbarEl.classList.remove('toolbar--hidden');
  contentActionsEl.classList.remove('content-actions--hidden');
  // Placeholder hint is "Search" inside a grouping (the user is filtering
  // to a single grouping's video set, so a generic placeholder fits).
  searchInput.placeholder = 'Search';
  syncControlsUI();
  renderSkeletons(uiState.view === 'grid' ? 'card' : 'row',
                  uiState.view === 'grid' ? 6 : 8);

  // Load the grouping list, main library, and the folder index in
  // parallel. The index is needed so the "In folder: X" jump link can
  // resolve the collection's common ancestor to an actual tree node.
  let grouping, allVideos;
  try {
    [grouping, allVideos] = await Promise.all([
      loadGrouping(kind),
      loadLibrary(),
      ensureFolderIndex().catch(() => null),  // best-effort — no jump if this fails
    ]);
  } catch { return; }

  const item = grouping.find(g => g.id === id);
  if (!item) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Not found</div>
        <div>This ${kind.slice(0, -1)} no longer exists on the desktop.</div>
      </div>`;
    // Put the title in the header anyway
    titleEl.replaceChildren();
    titleEl.textContent = '(not found)';
    return;
  }

  // Show the grouping's name in the header — no brand-accent for these
  titleEl.replaceChildren();
  titleEl.textContent = item.name || '(unnamed)';
  // Breadcrumb: parent grouping list → current grouping name. Tapping
  // the parent returns to the index view (Nielsen #3 user control,
  // Shneiderman #4 closure of the drill-down dialog).
  renderBreadcrumb([
    { label: MODE_TITLES[kind] || kind, hash: kind },
    { label: item.name || '(unnamed)' },
  ]);

  // Filter the library down to this grouping's video IDs
  const videoSet = new Set(item.videoIds || []);
  const videos = allVideos.filter(v => videoSet.has(v.id));
  const filtered = applyFilters(videos);
  countEl.textContent = filtered.length ? `${filtered.length}` : '';

  if (videos.length === 0) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Empty</div>
        <div>No videos in this ${kind.slice(0, -1)} are currently available.</div>
      </div>`;
    return;
  }
  if (filtered.length === 0) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">No matches</div>
        <div>Try a different search or filter.</div>
      </div>`;
    return;
  }

  await awaitSkeletonMinDwell();
  mainEl.innerHTML = '';

  // Desktop parity: when a collection (or playlist/category) was pinned
  // from a folder, its videos share a common ancestor. Show a small
  // "Open folder" affordance so the user can jump into folder-browse at
  // that location — mobile's equivalent of the desktop's auto-navigate.
  const anchor = _buildFolderJumpLink(videos);
  if (anchor) mainEl.appendChild(anchor);

  if (uiState.view === 'grid') mainEl.appendChild(renderGrid(filtered));
  else mainEl.appendChild(renderRows(filtered));
}

/**
 * Build a clickable "In folder: X" bar for views that have a well-defined
 * common ancestor (pinned-from-folder collections, categories that
 * happen to cluster in one folder, etc). Returns null when there's no
 * usable ancestor — e.g. videos spanning multiple drives, or an ancestor
 * that isn't actually a node in the folder tree.
 */
function _buildFolderJumpLink(videos) {
  if (!videos || videos.length < 2) return null;
  if (!folderIndex) return null;

  const paths = videos.map(v => v.path).filter(Boolean);
  if (paths.length < 2) return null;

  const ancestor = commonAncestorOfFiles(paths);
  if (!ancestor) return null;

  // Only jump into ancestors that are actually nodes in the tree. If the
  // common ancestor is "c:/" or some path above every source root, we'd
  // land nowhere useful — skip the affordance.
  const node = folderIndex.get(ancestor);
  if (!node) return null;

  // Trail built from the tree itself so labels (source-root name vs
  // folder basename) match the breadcrumb the user sees after tapping.
  const trail = breadcrumbOf(folderIndex, ancestor).map(c => c.label).join(' › ');
  if (!trail) return null;

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'folder-jump';
  link.addEventListener('click', () => {
    location.hash = `folder/${encodeURIComponent(ancestor)}`;
  });

  const icon = document.createElement('span');
  icon.className = 'folder-jump__icon';
  icon.appendChild(svgIcon('folder', 16));
  link.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'folder-jump__label';
  label.innerHTML = `In folder: <strong>${escapeHtml(trail)}</strong>`;
  link.appendChild(label);

  const chev = document.createElement('span');
  chev.className = 'folder-jump__chev';
  chev.textContent = '›';
  link.appendChild(chev);

  return link;
}

function renderGrid(videos) {
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const v of videos) grid.appendChild(createCard(v));
  return grid;
}

function renderRows(videos) {
  const list = document.createElement('div');
  list.className = 'list';
  for (const v of videos) list.appendChild(createRow(v));
  return list;
}

function createCard(v) {
  const card = document.createElement('div');
  card.className = 'card';
  card.addEventListener('click', () => { location.hash = `play/${v.id}`; });

  const thumb = document.createElement('img');
  thumb.className = 'card__thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.src = v.thumbUrl;
  thumb.onerror = () => {
    const ph = document.createElement('div');
    ph.className = 'card__thumb card__thumb--placeholder';
    ph.appendChild(svgIcon('play', 28));
    thumb.replaceWith(ph);
  };
  const thumbWrap = document.createElement('div');
  thumbWrap.style.position = 'relative';
  thumbWrap.appendChild(thumb);
  if (v.duration) {
    const dur = document.createElement('span');
    dur.className = 'card__thumb-dur';
    dur.textContent = formatDuration(v.duration);
    thumbWrap.appendChild(dur);
  }
  card.appendChild(thumbWrap);

  const body = document.createElement('div');
  body.className = 'card__body';
  const title = document.createElement('div');
  title.className = 'card__title';
  title.textContent = v.name;
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card__meta';
  if (v.sourceName) {
    const src = document.createElement('span');
    src.textContent = v.sourceName;
    meta.appendChild(src);
  }
  if (v.hasFunscript) {
    const b = document.createElement('span');
    b.className = 'card__badge';
    b.textContent = 'Script';
    meta.appendChild(b);
  }
  if (isVRVideo(v.name)) {
    const b = document.createElement('span');
    b.className = 'card__badge card__badge--vr';
    b.textContent = 'VR';
    meta.appendChild(b);
  }
  // Speed badge (grid/card view only — matches desktop library)
  const speedBadge = createSpeedBadge(v, { withText: true });
  if (speedBadge) meta.appendChild(speedBadge);

  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

/**
 * Build a speed badge (gauge icon + optional avg-speed text) colour-coded
 * by the same thresholds the desktop library uses:
 *   avgSpeed >=450 → insane, >=350 → extreme, >=250 → fast,
 *                 >=150 → medium,   <150 → slow.
 * Returns null when the video has no script or the stats haven't been
 * probed yet. `withText=true` appends the avg value as a short number
 * so grid cards show "[◎] 280" at a glance.
 */
function createSpeedBadge(v, { withText = false } = {}) {
  const avg = v.avgSpeed;
  const max = v.maxSpeed;
  // Null = not yet probed; 0 = probed but script empty/unreadable.
  if (avg == null || max == null) return null;
  if (avg === 0 && max === 0) return null;

  let tone;
  if (avg >= 450)      tone = 'insane';
  else if (avg >= 350) tone = 'extreme';
  else if (avg >= 250) tone = 'fast';
  else if (avg >= 150) tone = 'medium';
  else                 tone = 'slow';

  const b = document.createElement('span');
  b.className = `card__badge card__badge--speed-${tone}`;
  b.title = `Avg ${avg} units/s • Max ${max} units/s`;
  b.appendChild(svgIcon('gauge', 11));
  if (withText) {
    const txt = document.createElement('span');
    txt.className = 'card__badge-text';
    txt.textContent = String(avg);
    b.appendChild(txt);
  }
  return b;
}

function createRow(v) {
  const row = document.createElement('div');
  row.className = 'list__row';
  row.addEventListener('click', () => { location.hash = `play/${v.id}`; });

  const thumb = document.createElement('img');
  thumb.className = 'list__thumb';
  thumb.loading = 'lazy';
  thumb.alt = '';
  thumb.src = v.thumbUrl;
  thumb.onerror = () => {
    const ph = document.createElement('div');
    ph.className = 'list__thumb list__thumb--placeholder';
    ph.appendChild(svgIcon('play', 22));
    thumb.replaceWith(ph);
  };
  row.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'list__info';
  const title = document.createElement('div');
  title.className = 'list__title';
  title.textContent = v.name;
  info.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'list__sub';
  const parts = [];
  if (v.sourceName) parts.push(v.sourceName);
  if (v.duration) parts.push(formatDuration(v.duration));
  const text = document.createElement('span');
  text.textContent = parts.join(' • ');
  sub.appendChild(text);
  if (v.hasFunscript) {
    const b = document.createElement('span');
    b.className = 'list__badge';
    b.textContent = 'Script';
    sub.appendChild(b);
  }
  if (isVRVideo(v.name)) {
    const b = document.createElement('span');
    b.className = 'list__badge';
    b.textContent = 'VR';
    sub.appendChild(b);
  }
  info.appendChild(sub);
  row.appendChild(info);
  return row;
}

// --- Controls wiring -------------------------------------------------------

// Short debounce so swipe-typing / autocorrect don't rebuild the grid on
// every intermediate keystroke. 120 ms is below the typical keystroke gap
// while still feeling responsive.
let _searchDebounce = null;
const SEARCH_DEBOUNCE_MS = 120;

searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    uiState.search = searchInput.value;
    renderListIfActive();
  }, SEARCH_DEBOUNCE_MS);
});
// Pressing the keyboard's Search key should commit immediately — don't
// make the user wait out the debounce.
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(_searchDebounce);
    uiState.search = searchInput.value;
    renderListIfActive();
    searchInput.blur(); // dismiss the on-screen keyboard
  }
});
searchClear.addEventListener('click', () => {
  clearTimeout(_searchDebounce);
  searchInput.value = '';
  uiState.search = '';
  searchClear.hidden = true;
  renderListIfActive();
  searchInput.focus();
});
// Sort + Filters open the bottom sheet. The sheet's radio inputs commit
// state on change → syncControlsUI() re-renders the chip strip + active
// list. Sheets stay open after a selection so the user can refine
// multiple filters in one trip (Shneiderman #4 closure: open → choose
// → close, with the closing being explicit not implicit).
sortBtn.addEventListener('click', () => openSheet(sortSheetEl));
filtersBtn.addEventListener('click', () => openSheet(filterSheetEl));

// Sheet close paths: backdrop click, close button, Escape key. Each is
// wired centrally so adding a new sheet doesn't need three new handlers.
for (const el of document.querySelectorAll('[data-close-sheet]')) {
  el.addEventListener('click', (e) => {
    const sheet = e.currentTarget.closest('.sheet');
    if (sheet) closeSheet(sheet);
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = document.querySelector('.sheet:not([hidden])');
    if (open) { e.preventDefault(); closeSheet(open); return; }
  }
  // `/` focuses search at tablet/desktop widths only — on mobile the
  // search bar is already visible at the top of the toolbar so the
  // shortcut is redundant. Skip when an input is already focused so
  // typing a literal `/` in the search box doesn't loop.
  if (e.key === '/' && window.innerWidth >= 600 &&
      document.activeElement !== searchInput &&
      !(document.activeElement instanceof HTMLInputElement) &&
      !(document.activeElement instanceof HTMLTextAreaElement)) {
    e.preventDefault();
    searchInput.focus();
  }
});

// Filter sheet radios — wire them generically by `data-filter` so we
// don't have to hand-roll per-control listeners. New filter groups can
// be added in HTML alone.
for (const group of document.querySelectorAll('.sheet__options')) {
  const key = group.dataset.filter;     // 'tab' | 'vr' | 'sort'
  if (!key) continue;
  group.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
    uiState[key] = input.value;
    saveFilterState();
    syncControlsUI();
    renderListIfActive();
    // Sort sheet closes immediately on selection — single-choice flow,
    // closure should follow the choice. Filter sheet stays open so the
    // user can stack filter changes in one visit.
    if (key === 'sort') closeSheet(sortSheetEl);
  });
}

viewToggle.addEventListener('click', () => {
  uiState.view = uiState.view === 'grid' ? 'list' : 'grid';
  saveFilterState();
  syncControlsUI();
  renderListIfActive();
});

// Folder-browse toggle — independent of grid/list (works with either in
// detail view). Tapping toggles between the folder source list and the
// regular library list; the hash change re-runs `render()`. Search
// preserved across the toggle (post-redesign 3.3.1) so the user
// doesn't lose their query.
folderToggle.addEventListener('click', () => {
  const inFolder = currentView === 'folders' || currentView === 'folder-detail';
  location.hash = inFolder ? '' : 'folder';
});

// Mode tabs — clicking switches top-level view (library / collections /
// playlists / categories). Hash navigation so the phone's back button
// works. Search query is PRESERVED across modes (post-redesign 3.3.1):
// the placeholder updates to reflect the current scope ("Search
// collections", etc.) but the query stays so a user typing "gym" can
// switch from Library to Collections and immediately see matching
// collections rather than a blank slate.
for (const btn of navTabsEl.querySelectorAll('.nav-tabs__tab')) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    location.hash = mode === 'library' ? '' : mode;
  });
}

// Manual refresh + auto-refresh when the user returns to the tab (covers
// "I added videos on desktop while the phone was in my pocket" case).
refreshBtn.addEventListener('click', () => {
  // Clear all caches so the next render re-fetches fresh.
  library = null;
  sources = null;
  folderIndex = null;
  collections = null;
  playlists = null;
  categories = null;
  // searchContextMap was derived from the three groupings + library —
  // forget it too so it gets rebuilt against the fresh data on next
  // search. Without this, a user who refreshes after editing a
  // collection on desktop would still see stale collection-name
  // matches in mobile search.
  searchContextMap = null;
  // Reset duration-refresh budget so the user gets a fresh 5-attempt
  // polling window (useful when the backend just finished scanning and
  // the user hits refresh to see durations).
  _durationRefreshAttempts = 0;
  if (_durationRefreshTimer) { clearTimeout(_durationRefreshTimer); _durationRefreshTimer = null; }
  refreshBtn.classList.add('header__action--spinning');
  rerenderCurrent().finally(() => {
    setTimeout(() => refreshBtn.classList.remove('header__action--spinning'), 600);
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (currentView === 'list' || currentView === 'groupings' ||
      currentView === 'grouping-detail' || currentView === 'folders' ||
      currentView === 'folder-detail') {
    library = null;
    sources = null;
    folderIndex = null;
    collections = null;
    playlists = null;
    categories = null;
    searchContextMap = null;
    rerenderCurrent();
  }
});

// ============================================================
// Sheets — bottom-sheet on mobile, side-drawer at >= 600px.
// Single open-at-a-time policy: opening one closes any other.
// Focus management: trap focus inside the open sheet so VoiceOver /
// TalkBack don't escape into the masked content (a11y).
// ============================================================
let _lastFocusBeforeSheet = null;
function openSheet(sheetEl) {
  // Close any other open sheet first — only one at a time keeps the
  // mental model simple (Norman conceptual model).
  for (const open of document.querySelectorAll('.sheet:not([hidden])')) {
    if (open !== sheetEl) closeSheet(open);
  }
  if (!sheetEl.hidden) return;
  _lastFocusBeforeSheet = document.activeElement;
  sheetEl.hidden = false;
  // Move focus to the close button so screen readers announce the
  // dialog and keyboard users can immediately Esc-out.
  sheetEl.querySelector('[data-close-sheet]')?.focus();
}
function closeSheet(sheetEl) {
  if (sheetEl.hidden) return;
  sheetEl.hidden = true;
  // Return focus to the trigger button (Shneiderman #7 user control —
  // predictable; the user came from there).
  if (_lastFocusBeforeSheet && document.contains(_lastFocusBeforeSheet)) {
    _lastFocusBeforeSheet.focus();
  }
  _lastFocusBeforeSheet = null;
}

// ============================================================
// Filter chips — visualise active filters; clicking the X removes
// that one filter (Shneiderman #6 reversibility, Nielsen #6 recognition).
// Re-rendered every syncControlsUI tick. Cheap (max 2 chips).
// ============================================================
const FILTER_LABELS = {
  tab: { matched: 'Matched', unmatched: 'Unmatched' },
  vr:  { vr: 'VR only', flat: 'Non-VR' },
};
const FILTER_DEFAULTS = { tab: 'all', vr: 'all' };

function renderFilterChips() {
  const chips = [];
  for (const key of ['tab', 'vr']) {
    const value = uiState[key];
    if (value && value !== FILTER_DEFAULTS[key]) {
      const label = FILTER_LABELS[key]?.[value] || value;
      chips.push({ key, label });
    }
  }
  filterChipsEl.replaceChildren();
  filterChipsEl.hidden = chips.length === 0;
  for (const c of chips) {
    const chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.type = 'button';
    chip.setAttribute('aria-label', `Remove filter: ${c.label}`);
    const text = document.createElement('span');
    text.textContent = c.label;
    chip.appendChild(text);
    const close = document.createElement('span');
    close.className = 'filter-chip__close';
    close.appendChild(svgIcon('x', 12));
    chip.appendChild(close);
    chip.addEventListener('click', () => {
      uiState[c.key] = FILTER_DEFAULTS[c.key];
      saveFilterState();
      syncControlsUI();
      renderListIfActive();
    });
    filterChipsEl.appendChild(chip);
  }
}

function updateFiltersBadge() {
  let active = 0;
  for (const key of ['tab', 'vr']) {
    if (uiState[key] && uiState[key] !== FILTER_DEFAULTS[key]) active++;
  }
  if (active > 0) {
    filtersBadge.textContent = String(active);
    filtersBadge.hidden = false;
  } else {
    filtersBadge.hidden = true;
  }
}

// ============================================================
// Search placeholder — mode-aware (Norman signifier 3.3.2).
// ============================================================
const SEARCH_PLACEHOLDERS = {
  library: 'Search library',
  collections: 'Search collections',
  playlists: 'Search playlists',
  categories: 'Search categories',
};
function updateSearchPlaceholder() {
  searchInput.placeholder = SEARCH_PLACEHOLDERS[currentMode] || 'Search';
}

// ============================================================
// Breadcrumb — persistent "where am I" beneath the title (Nielsen #1).
// Rendered on every render() pass so it tracks hash navigation.
// Empty / single-segment paths hide the breadcrumb so a top-level
// view doesn't carry visual noise.
// ============================================================
const MODE_TITLES = {
  library: 'Library',
  collections: 'Collections',
  playlists: 'Playlists',
  categories: 'Categories',
};
function renderBreadcrumb(segments) {
  // segments: array of { label, hash } — hash null for current
  if (!segments || segments.length <= 1) {
    breadcrumbEl.hidden = true;
    breadcrumbEl.replaceChildren();
    return;
  }
  breadcrumbEl.hidden = false;
  breadcrumbEl.replaceChildren();
  segments.forEach((s, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb__sep';
      sep.appendChild(svgIcon('chevronRight', 12));
      breadcrumbEl.appendChild(sep);
    }
    const isLast = i === segments.length - 1;
    if (isLast || s.hash == null) {
      const span = document.createElement('span');
      span.className = 'breadcrumb__item breadcrumb__item--current';
      span.textContent = s.label;
      breadcrumbEl.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.className = 'breadcrumb__item';
      btn.type = 'button';
      btn.textContent = s.label;
      btn.addEventListener('click', () => { location.hash = s.hash; });
      breadcrumbEl.appendChild(btn);
    }
  });
}

// ============================================================
// Skeleton render — clones a template into the main content area
// while a fetch is pending. The template's shape matches the real
// content shape so when data arrives, the layout doesn't reflow
// (§3.4.1a). 200 ms minimum dwell makes brief loads feel calmer
// than instant flash-then-content.
// ============================================================
let _skeletonShownAt = 0;
function renderSkeletons(kind, count) {
  const tmplId = {
    card: 'tmpl-skeleton-card',
    row: 'tmpl-skeleton-row',
    grouping: 'tmpl-skeleton-grouping',
  }[kind];
  if (!tmplId) return;
  const tmpl = document.getElementById(tmplId);
  if (!tmpl) return;

  const wrap = document.createElement('div');
  wrap.className = kind === 'card' ? 'grid' : (kind === 'grouping' ? 'grouping-list' : 'list');
  for (let i = 0; i < count; i++) {
    wrap.appendChild(tmpl.content.cloneNode(true));
  }
  mainEl.replaceChildren(wrap);
  _skeletonShownAt = performance.now();
}

/**
 * Wait out the 200ms minimum dwell time before swapping skeletons for
 * real content. Awaited by render functions just before they call
 * `mainEl.innerHTML = ...` so the user sees a calm transition rather
 * than a flicker on fast paths.
 */
async function awaitSkeletonMinDwell() {
  if (!_skeletonShownAt) return;
  const elapsed = performance.now() - _skeletonShownAt;
  const MIN_DWELL_MS = 200;
  if (elapsed < MIN_DWELL_MS) {
    await new Promise(r => setTimeout(r, MIN_DWELL_MS - elapsed));
  }
  _skeletonShownAt = 0;
}

function syncControlsUI() {
  // Bottom-nav active state — driven by aria-selected (which CSS
  // also keys off, so visuals + accessibility stay in lockstep).
  for (const btn of navTabsEl.querySelectorAll('.nav-tabs__tab')) {
    btn.setAttribute('aria-selected', btn.dataset.mode === currentMode ? 'true' : 'false');
  }
  // Sheet radio group reflects current uiState
  for (const input of document.querySelectorAll('.sheet input[type="radio"]')) {
    const group = input.closest('.sheet__options');
    const key = group?.dataset.filter;
    if (!key) continue;
    input.checked = uiState[key] === input.value;
  }
  // Search input
  if (searchInput.value !== uiState.search) searchInput.value = uiState.search;
  searchClear.hidden = !uiState.search;
  updateSearchPlaceholder();

  // View toggle icon — shows the icon for the view you'll switch TO.
  viewIconSlot.replaceChildren(svgIcon(uiState.view === 'grid' ? 'layoutList' : 'layoutGrid', 18));
  viewToggle.setAttribute('aria-pressed', uiState.view === 'grid' ? 'true' : 'false');

  // Folder toggle active when we're inside the folder-browse flow.
  const inFolder = currentView === 'folders' || currentView === 'folder-detail';
  folderToggle.setAttribute('aria-pressed', inFolder ? 'true' : 'false');

  // Filter chips + count badge
  renderFilterChips();
  updateFiltersBadge();
}

// Re-run whichever view is currently active. Used for filter changes,
// search debounce, refresh, and tab visibility events.
function rerenderCurrent() {
  if (currentView === 'list') return renderList();
  if (currentView === 'groupings') return renderGroupingsList(currentMode);
  if (currentView === 'grouping-detail') {
    const m = location.hash.slice(1).match(/^(collection|playlist|category)\/(.+)$/);
    if (m) return renderGroupingDetail(m[1] + 's', m[2]);
  }
  if (currentView === 'folders') return renderFolderRoot();
  if (currentView === 'folder-detail') {
    const hash = location.hash.slice(1);
    if (hash.startsWith('folder/')) {
      return renderFolderAt(decodeURIComponent(hash.slice('folder/'.length)));
    }
  }
  return Promise.resolve();
}
// Back-compat alias — old code path used this name.
const renderListIfActive = rerenderCurrent;

function saveFilterState() {
  try {
    localStorage.setItem('funsync.remote.ui', JSON.stringify({
      tab: uiState.tab,
      sort: uiState.sort,
      vr: uiState.vr,
      view: uiState.view,
    }));
  } catch { /* ignore quota */ }
}

function loadFilterState() {
  try {
    return JSON.parse(localStorage.getItem('funsync.remote.ui') || '{}');
  } catch {
    return {};
  }
}

async function renderPlayer(id) {
  // Player view is full-bleed media — hide the entire toolbar AND the
  // breadcrumb so the video gets the full screen. Bottom nav stays
  // visible (user can still mode-switch out, by design).
  toolbarEl.classList.add('toolbar--hidden');
  breadcrumbEl.hidden = true;
  const videos = await loadLibrary();
  const video = videos.find(v => v.id === id);
  if (!video) {
    mainEl.innerHTML = `
      <div class="empty">
        <div class="empty__title">Video not found</div>
        <div>Go back and try again.</div>
      </div>`;
    return;
  }

  titleEl.textContent = video.name;
  countEl.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'player';

  const videoEl = document.createElement('video');
  videoEl.className = 'player__video';
  videoEl.src = video.streamUrl;
  videoEl.controls = true;
  videoEl.playsInline = true;
  videoEl.preload = 'metadata';
  if (video.subtitleUrl) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = video.subtitleUrl;
    track.default = true;
    track.srclang = 'en';
    videoEl.appendChild(track);
  }
  wrap.appendChild(videoEl);

  // Device-sync status pill above the video. Populated by server messages.
  const pill = document.createElement('div');
  pill.className = 'player__sync-pill';
  pill.textContent = 'Connecting to devices…';
  pill.dataset.state = 'connecting';
  wrap.appendChild(pill);

  // Open the device-sync WebSocket when the phone has a funscript to sync to.
  // No-op for videos without scripts — the pill explains why.
  if (video.hasFunscript) {
    activeSyncClient = new RemoteSyncClient({
      video: videoEl,
      videoId: video.id,
      onServerMessage: (msg) => renderSyncPill(pill, msg),
      onKicked: (reason) => {
        pill.dataset.state = 'kicked';
        pill.textContent = reason || 'Another device took over';
      },
    });
    activeSyncClient.start();
  } else {
    pill.dataset.state = 'noscript';
    pill.textContent = 'No funscript — playing video only';
  }

  if (video.hasFunscript && video.scriptUrl) {
    const hm = document.createElement('div');
    hm.className = 'player__heatmap-wrapper';
    const label = document.createElement('div');
    label.className = 'player__heatmap-label';
    label.textContent = 'Funscript intensity';
    hm.appendChild(label);
    const canvas = document.createElement('canvas');
    canvas.className = 'player__heatmap';
    hm.appendChild(canvas);
    wrap.appendChild(hm);

    // Fetch + render heatmap async — don't block player render.
    loadHeatmap(canvas, video.scriptUrl);
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'player__title';
  titleRow.textContent = video.name;
  wrap.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'player__meta';
  if (video.sourceName) {
    const src = document.createElement('span');
    src.textContent = video.sourceName;
    meta.appendChild(src);
  }
  if (video.duration) {
    const dur = document.createElement('span');
    dur.textContent = formatDuration(video.duration);
    meta.appendChild(dur);
  }
  wrap.appendChild(meta);

  // Speed stats row — only rendered when the backend has probed this
  // video's funscript. Shows avg + max in units/s, colour-coded by the
  // same thresholds the card badge uses (library colouring is consistent
  // between desktop and mobile).
  if (video.hasFunscript && video.avgSpeed != null && (video.avgSpeed > 0 || video.maxSpeed > 0)) {
    const speedRow = document.createElement('div');
    speedRow.className = 'player__speed';
    const speedBadge = createSpeedBadge(video, { withText: false });
    if (speedBadge) {
      speedBadge.classList.add('player__speed-badge');
      speedRow.appendChild(speedBadge);
    }
    const avg = document.createElement('span');
    avg.className = 'player__speed-stat';
    // Coerce to Number so a poisoned registry entry (string with HTML) can't
    // become an XSS sink here. Real speeds are always numeric; NaN → 0.
    avg.innerHTML = `Avg <strong>${Number(video.avgSpeed) || 0}</strong> <span class="player__speed-unit">units/s</span>`;
    speedRow.appendChild(avg);
    const max = document.createElement('span');
    max.className = 'player__speed-stat';
    max.innerHTML = `Max <strong>${Number(video.maxSpeed) || 0}</strong> <span class="player__speed-unit">units/s</span>`;
    speedRow.appendChild(max);
    wrap.appendChild(speedRow);
  }

  mainEl.innerHTML = '';
  mainEl.appendChild(wrap);
}

/**
 * Update the device-status pill based on server messages. Visually summarises
 * whether the desktop is ready to drive devices and which are connected.
 */
function renderSyncPill(pill, msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'script-loading':
      pill.dataset.state = 'preparing';
      pill.textContent = 'Preparing devices…';
      break;
    case 'script-ready': {
      pill.dataset.state = 'ready';
      pill.textContent = 'Devices ready';
      break;
    }
    case 'script-missing':
      pill.dataset.state = 'nomatch';
      pill.textContent = 'Desktop couldn’t find a matching script';
      break;
    case 'device-status': {
      // Prefer the detailed device list when the desktop sends one;
      // fall back to the legacy booleans only for older desktop
      // versions that haven't shipped the per-device payload yet.
      const devices = Array.isArray(msg.devices) ? msg.devices : null;
      if (devices) {
        renderDevicePill(pill, devices);
      } else {
        const parts = [];
        for (const k of ['handy', 'buttplug', 'tcode', 'autoblow']) {
          if (msg[k] === 'connected') parts.push(k[0].toUpperCase() + k.slice(1));
        }
        if (parts.length > 0) {
          pill.dataset.state = 'connected';
          pill.textContent = `Connected: ${parts.join(', ')}`;
        } else {
          pill.dataset.state = 'nodevice';
          pill.textContent = 'No devices connected on desktop';
        }
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Render the device-status pill as a clickable summary with a dropdown
 * of actual device names. Pill collapsed: "Connected devices · 3"; tap
 * it to reveal the list inline. Zero-device state stays flat text
 * since there's nothing to expand to.
 */
function renderDevicePill(pill, devices) {
  pill.replaceChildren();

  if (!devices || devices.length === 0) {
    pill.dataset.state = 'nodevice';
    pill.textContent = 'No devices connected on desktop';
    pill.onclick = null;
    return;
  }

  pill.dataset.state = 'connected';
  pill.classList.add('player__sync-pill--expandable');

  const summary = document.createElement('div');
  summary.className = 'player__sync-pill-summary';
  summary.textContent = `Connected devices · ${devices.length}`;
  const chev = document.createElement('span');
  chev.className = 'player__sync-pill-chev';
  chev.textContent = '▾';
  summary.appendChild(chev);
  pill.appendChild(summary);

  const list = document.createElement('ul');
  list.className = 'player__sync-pill-list';
  list.hidden = true;
  for (const d of devices) {
    const li = document.createElement('li');
    li.className = 'player__sync-pill-item';
    const name = document.createElement('span');
    name.className = 'player__sync-pill-item-name';
    name.textContent = d.label || '(unnamed)';
    li.appendChild(name);
    if (d.kind) {
      const tag = document.createElement('span');
      tag.className = 'player__sync-pill-item-kind';
      tag.textContent = d.kind;
      li.appendChild(tag);
    }
    list.appendChild(li);
  }
  pill.appendChild(list);

  pill.onclick = () => {
    const expanded = !list.hidden;
    list.hidden = expanded;
    pill.classList.toggle('player__sync-pill--open', !expanded);
    chev.textContent = expanded ? '▾' : '▴';
  };
}

async function loadHeatmap(canvas, scriptUrl) {
  try {
    const resp = await fetch(scriptUrl);
    if (!resp.ok) return;
    const fs = await resp.json();
    const actions = fs?.actions;
    if (!actions || actions.length < 2) return;
    const bins = computeBins(actions);
    // Wait one frame so clientWidth is measured after layout.
    requestAnimationFrame(() => renderBins(canvas, bins));
  } catch { /* heatmap is a progressive enhancement — silent fail is fine */ }
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * Human-friendly total runtime for grouping rows. Shorter than
 * formatDuration — "3h 42m" / "47m" / "28s" — because the precision of
 * a 4-hour playlist down to the second is noise in a list view.
 * Returns '' for 0 so callers can skip rendering when duration is unknown.
 */
function formatTotalDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
