// The EroScripts tab (2026-11-22; notes/features/SCOPE-eroscripts-tab.md).
//
// Dave: "greyed out library cards as results with a download button which
// opens a modal with the links etc, and download progress should show on the
// library card ... showing when a funscript and video have been downloaded
// ... indicate if the script is paid or not and be able to easily filter free
// ones only ... as easy/intuitive as possible, think apple ui ... with the
// option to see a more complex version and have more control, hence the
// modal."
//
// - The search and login are the existing panel, docked across the top
//   (EroScriptsPanel.dock); its results arrive here (`onResults`) and are
//   drawn as cards shaped like the library's, grey until the video is here.
// - All / Free / Paid beside the search box narrows the forum's own search
//   (eroscripts-price.js) and is remembered.
// - A card's Download opens the download window: the script and the video it
//   would fetch, where to, one button. "More options" lists every script and
//   every link, the post's and the replies' (newest first: a dead link is
//   often replaced in a reply), each marked Works / Link dead after a check.
// - A download's progress, and afterwards Script / Video ticks and Play, show
//   on the card; what was downloaded is remembered per post
//   (`eroscripts.downloaded`), and shown only while the file is still there.
// - The video is saved under the post's title, the chosen script beside it
//   under the same name, so the library pairs them; the library rescans when
//   the folder is a library source. Downloads run in the backend
//   (/api/downloads, desktop only).

import { t } from '../js/i18n.js';
import { showToast, showUndoToast } from '../js/toast.js';
import { groupAttachments } from '../js/eroscripts-groups.js';
import { icon, ArrowDownWideNarrow, Check, ChevronDown, Clapperboard, ClipboardPaste, Download, FileText, LayoutGrid, LayoutList, Pause, Play, RefreshCw, SlidersHorizontal, X } from '../js/icons.js';
import { wireMenuKeys } from '../js/menu-keys.js';
import { renderFilterChips } from '../js/filter-chips.js';
import { priceOf, normalizePriceFilter, queryForPrice, matchesPrice } from '../js/eroscripts-price.js';
import { titleMatchesQuery } from '../js/search-name-clean.js';
import { Modal } from './modal.js';
import { createResultThumb } from './result-thumb.js';
import { askReplaceFiles, forgetFetched } from './replace-question.js';
import { recordDownloadTags, markVideosFromPosts } from '../js/script-tags.js';
import { downloadMeta, infoFromMeta } from '../js/download-meta.js';
import { TagInput } from './tag-input.js';
import { eventBus } from '../js/event-bus.js';
import { PostProbe, passesNeed, normalizeNeed, NEEDS } from '../js/eroscripts-probe.js';
import {
  sanitizePostHtml, postPlainText, statedDuration, lengthVerdict, isLengthWarning, clockText,
  scriptSummary, FAST_SPEED, provenance, sameUser, sizesDiffer, buildScriptChoices,
} from '../js/eroscripts-post.js';
import { computeBins, renderBins } from '../js/heatmap-strip.js';
import {
  SUGGEST_ID, libraryTagCounts, baselineCounts, formatPreference, rankTasteTags, suggestionReason, passesSuggested,
  avoidTags, readDismissed, dismissTopic, readLeftOut, setLeftOut, readAllowed, setAllowed,
} from '../js/eroscripts-suggest.js';
import {
  normalizeSort, sortParams, normalizeFilters, filterTags, matchesFilters, decorateQuery, tagRoom, MAX_HIDE_TAGS, anyFilterOrHide, passesHidden,
  cardTags, libraryByTopic, LENGTH_TAGS, SORTS, VIDEO_FILTERS, DEVICE_FILTERS,
} from '../js/eroscripts-browse.js';
import {
  FeedChecker, SETTING_FEEDS, MAX_FEEDS, MAX_TAGS, normalizeFeed, newFeedId, feedTags, feedRequest,
  inFeed, badgeText, defaultFeedName, parseTags, SEARCH_PAGE as FEED_SEARCH_PAGE,
} from '../js/eroscripts-feeds.js';

const POLL_MS = 1000;
// No bytes for this long while downloading: the card says it is waiting for the network.
export const STALL_SECONDS = 5;
// FunSync's logo in a notification (the page is renderer/index.html; assets/ ships beside it).
const APP_ICON = '../assets/icons/icon.png';
const SETTING_FOLDER = 'eroscripts.downloadFolder';
const SETTING_TUBE = 'eroscripts.tubeDownloads';
const SETTING_PRICE = 'eroscripts.priceFilter';
const SETTING_DONE = 'eroscripts.downloaded';
const SETTING_MORE = 'eroscripts.moreOptions';
/** The download window's Post section open (the review's 2.1, 2026-11-23). */
const SETTING_POST_OPEN = 'eroscripts.postOpen';
/** Who started the thread: the scripter (review 2.4 / 2.5). */
function creatorOf(p) { return p?.answer?.creator || p?.topic?.creator || ''; }
const SETTING_SORT = 'eroscripts.sort';
const SETTING_FILTERS = 'eroscripts.filters';
/** The Download filter (2026-11-23): 'any' | 'video' | 'script'. A view filter, also with a feed open. */
const SETTING_NEED = 'eroscripts.needFilter';
const SETTING_VIEW = 'eroscripts.viewMode';      // 'cards' | 'list'
const SETTING_AXES = 'eroscripts.allAxes';       // false: a multi-axis set's main script only
const SEARCH_PAGE = 50;          // the forum's search answers 50 a page
const QUICK_GAP_MS = 1200;       // between posts when downloading several (the forum's rate limit)

/** "1.2 GB", "340 MB". */
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}

/** A post title as a file name stem (the backend cleans it again). */
export function stemForPost(title) {
  const s = String(title || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || 'video').slice(0, 150).replace(/[ .]+$/, '') || 'video';
}

/** The word for a failed download's code (backend `DownloadError` codes). */
export function errorText(code) {
  const known = ['notFound', 'denied', 'rateLimited', 'login', 'geo', 'playlist', 'badFolder',
    'tubeOff', 'noVideo', 'incomplete', 'unsupported', 'megaFolder', 'browserOnly', 'noSpace', 'notResumable',
    'password', 'timeout', 'needsApp'];
  return t(`eroscripts.tab.err.${known.includes(code) ? code : 'failed'}`);
}

const HOST_NAMES = {
  pixeldrain: 'Pixeldrain', mega: 'Mega', pmvhaven: 'PMVHaven', faptap: 'FapTap',
  yandex: 'Yandex Disk', gofile: 'Gofile', erosync: 'EroSync', rule34video: 'Rule34Video',
};

/** 12345 -> "12.3k" (the forum list's Views). */
export function compactNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}m`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return String(v);
}

/** A host as people write it: "Pixeldrain", "PMVHaven", "xvideos.com". */
export function hostLabel(host) {
  const h = String(host || '');
  return HOST_NAMES[h] || h;
}

const compactName = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Is a forum post's title the same video as a name? Its words (as "Script
 * found" asks), and every number in the name in the title too: "PMV MIX //
 * VOL. 12" matched "PMV MIX // VOL. 01 + bunch of other pmvs" on its words
 * alone (seen live, 2026-11-22).
 */
export function sameVideoTitle(title, name) {
  if (!titleMatchesQuery(title, name)) return false;
  const nums = (s) => (String(s || '').match(/\d+/g) || []).map((n) => Number(n));
  const inTitle = new Set(nums(title));
  return nums(name).every((n) => inTitle.has(n));
}

/**
 * Is a link's file (or page) name this post's video? Its name squeezed is the
 * title's or the script's, or holds it, or the title's words are in it. A
 * post often links other videos too: a PMV mix credits its source PMVs, each
 * a working PMVHaven link (found live on "Pmv mix // vol. 12", 2026-11-22).
 * null when the link's name is not known.
 */
export function linkNameMatches(link, { title = '', scriptName = '' } = {}) {
  const name = link?.check?.name;
  if (!name) return null;
  const n = compactName(name);
  if (n.length < 3) return null;
  for (const other of [title, scriptName]) {
    const o = compactName(other);
    if (o.length >= 3 && (o === n || o.includes(n) || n.includes(o))) return true;
  }
  return titleMatchesQuery(name, title);
}

/**
 * The link the download window offers. Never a dead one, never a tube site
 * unless they are turned on. Best first: one that works over one that could
 * not be checked; one whose name is the post's (or its script's) over one
 * named otherwise; a file host's original file over a video site's copy over
 * a tube site; a host that is throttling this connection today (Pixeldrain
 * after its free daily 6 GB) behind one at full speed. List order (the
 * post's links, then the replies' newest first) breaks a tie.
 */
/**
 * A post's scripts as choices (2026-11-23: each .funscript was its own
 * choice and only one was saved, so a multi-axis post lost its axes):
 * a set's main script carries its axis files, [{suffix, label, name, url}],
 * in the app's axis order. Multi-axis sets first (eroscripts-groups.js).
 * Axis files with no main, and a second main, stay choices of their own.
 */
export function scriptChoices(attachments) {
  const out = [];
  const lone = [];   // axis files with no main script: last, not first
  for (const g of groupAttachments(attachments).groups) {
    if (g.main) {
      out.push({
        name: g.main.name,
        url: g.main.url,
        axes: g.axes.map((a) => ({
          suffix: a.axis.suffix,
          label: a.axis.suffix.charAt(0).toUpperCase() + a.axis.suffix.slice(1),
          name: a.name,
          url: a.url,
        })),
      });
    } else {
      for (const a of g.axes) lone.push({ name: a.name, url: a.url, axes: [], lone: true });
    }
    for (const x of g.extras) out.push({ name: x.name, url: x.url, axes: [] });
  }
  return [...out, ...lone];
}

/**
 * Can this link play in the player without downloading (2026-11-22)? The
 * backend streams FapTap / PMVHaven / Pixeldrain / direct links itself and a
 * tube site through yt-dlp (behind the same Tube switch as downloads). Mega is
 * encrypted and Gofile needs its page: not those. Nor a link known dead.
 */
export function canWatch(link, tube = false) {
  if (!link?.supported || link.check?.status === 'dead') return false;
  if (link.kind === 'videohost' || link.kind === 'direct') return true;
  if (link.kind === 'tube') return tube === true;
  return link.host === 'pixeldrain';
}

/** A watched post's script, kept in the app's stream-scripts folder: one name per topic and script address. */
export function streamScriptName(topicId, script) {
  const url = String(script?.url || '');
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  const base = String(script?.name || 'script').replace(/\.funscript$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 80) || 'script';
  return `${topicId || 'link'}-${h.toString(16)}-${base}.funscript`;
}

export function pickBestLink(links, opts = {}) {
  return rankLinks(links, opts)[0] || null;
}

/**
 * Every link that could give the post's video, best first (pickBestLink's
 * order; equal ranks keep the post's order). The next one is tried when one
 * fails (2026-11-23: a dead link was a dead end).
 */
export function rankLinks(links, { tube = false, title = '', scriptName = '', creator = '' } = {}) {
  const out = [];
  (links || []).forEach((l, i) => {
    if (!l?.supported || (l.kind === 'tube' && !tube) || l.check?.status === 'dead') return;
    const match = linkNameMatches(l, { title, scriptName });
    const rank = (l.check?.status === 'ok' ? 0 : 4)
      + (match === true ? 0 : match === null ? 1 : 2)
      + (l.kind === 'videohost' ? 0.5 : l.kind === 'tube' ? 1 : 0)
      + (l.check?.slow ? 1.5 : 0)
      // A re-upload by someone other than the scripter (review 2.4): after
      // the scripter's own links of the same standing.
      + (l.from === 'reply' && !sameUser(l.username, creator) ? 0.75 : 0);
    out.push({ l, rank, i });
  });
  return out.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.l);
}

/** "2h ago" / "3d ago" (the forum list's Activity), a short date past a month. */
export function relativeTime(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || undefined;
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec >= 30 * 86400) return shortDate(iso);
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always', style: 'narrow' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { style: 'narrow' }); }
  if (sec < 3600) return rtf.format(-Math.max(1, Math.round(sec / 60)), 'minute');
  if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
  return rtf.format(-Math.round(sec / 86400), 'day');
}

/** "3 May 2026" in the interface's language. */
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return d.toISOString().slice(0, 10); }
}

export class EroScriptsView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   #eroscripts-container
   * @param {object} opts.panel            the app's EroScriptsPanel
   * @param {object} opts.settings         DataService
   * @param {() => number|null} opts.getBackendPort
   * @param {(dir: string) => boolean} [opts.isLibraryFolder]  a source holds it
   * @param {() => void} [opts.onSavedIntoLibrary]  rescan
   * @param {(path: string) => boolean} [opts.playPath]  play a downloaded video
   */
  constructor({ container, panel, settings, getBackendPort, isLibraryFolder, onSavedIntoLibrary, playPath, showTab, playStream, resolveStream, queueStream, getSaveStreams, setSaveStreams }) {
    this._container = container;
    this._panel = panel;
    this._settings = settings;
    // Videos downloaded before the videoFromPost mark (2026-11-25): this
    // tab's own list says which post each came from; their records get it
    // (only added, nothing else written), so a script-less one shows its tags.
    try { markVideosFromPosts(settings, settings?.get?.(SETTING_DONE)); } catch { /* changes nothing */ }
    this._port = getBackendPort;
    this._isLibraryFolder = isLibraryFolder || (() => false);
    this._onSaved = onSavedIntoLibrary || (() => {});
    this._playPath = playPath || (() => false);
    // Watch: (resolved stream, script path or null) -> plays it (2026-11-22).
    this._playStream = playStream || null;
    // The app's lookup (it adds the Quality choice); the IPC alone without one.
    this._resolveStream = resolveStream || ((url) => window.funsync.resolveRemoteVideo(url));
    // Saved streams (2026-11-23): "Add to queue", and the "Save to library" tick.
    this._queueStream = queueStream || null;
    this._getSaveStreams = getSaveStreams || (() => false);
    this._setSaveStreams = setSaveStreams || (() => {});
    this._built = false;
    this._results = null;        // the last search's topics, or null
    this._cards = new Map();     // topic id -> { topic, card, els }
    this._previews = new Map();  // script url -> { state, summary, bins, metaDuration, channels } (review 2.2)
    this._imgCache = new Map();  // image url -> data: URL, this session (the post reader)
    this._imgLoading = new Map(); // image url -> its pending fetch
    this._exists = new Map();    // path -> true, or {at} when last found missing (asked again after 30 s)
    this._checking = new Set();
    this._jobs = [];
    this._jobInfo = new Map();   // job id -> { topicId, script, title, handled }
    this._pollTimer = null;
    this._visible = false;
    this._dl = null;             // the open download window: { body, close, post }
    this._libMap = new Map();    // topic id -> {video, script} the library already has
    // A video linked to a post (Get Script, Get tags, Find, Change post...)
    // lights that post's card at once (B009, 2026-11-24: the map was built
    // only when a list loaded, so linking in the library and coming back
    // left the card grey).
    eventBus.on?.('settings:changed', ({ path } = {}) => {
      if (typeof path !== 'string' || !(path === 'library' || path.startsWith('library.scriptTags'))) return;
      this._refreshLibMap();
    });
    // Files deleted from the library (Dave, 2026-11-25: deleted, the card
    // still said downloaded): "there" was kept for the session; ask again.
    eventBus.on?.('library:filesDeleted', ({ paths } = {}) => this.filesDeleted(paths));
    this._search = null;         // the search shown: { query, page, more, results, loading }
    this._selecting = false;     // picking several cards
    this._selected = new Map();  // topic id -> topic
    this._spaceCache = new Map(); // folder -> { free, at }
    // Feeds (2026-11-22): the open one, and when it had last been opened
    // before this time (its "New" chips).
    this._feedId = null;
    this._feedSince = null;
    this._showTab = showTab || (() => {});
    this.onFeedsChanged = null;   // (total new) => {}: the nav bar's badge
    this._checker = new FeedChecker({
      settings,
      latest: (...a) => window.funsync?.eroscriptsLatest?.(...a),
      search: (...a) => window.funsync?.eroscriptsSearch?.(...a),
      loggedIn: () => this._panel?.isLoggedIn !== false,
      onChange: () => this._feedsChanged(),
      onMore: (feed, count) => this._notifyFeed(feed, count),
    });
  }

  _api(path) { return `http://127.0.0.1:${this._port() || 5123}/api/downloads${path}`; }

  async _fetchJson(path, opts = {}) {
    const res = await fetch(this._api(path), {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { ok: res.ok, status: res.status, body };
  }

  _get(key) { return this._settings?.get?.(key); }
  _set(key, value) { this._settings?.set?.(key, value); }

  // --- the view -------------------------------------------------------------

  _build() {
    if (this._built) return;
    this._built = true;
    const c = this._container;
    c.classList.add('es-view');
    c.innerHTML = `
      <div class="es-view__top">
        <div class="es-view__search"></div>
        <div class="es-view__feeds"></div>
        <div class="es-view__actions">
          <button type="button" class="es-view__icon-btn es-view__paste-btn"></button>
          <div class="es-view__dl-wrap">
            <button type="button" class="es-view__icon-btn es-view__dl-btn" aria-expanded="false"><span class="es-view__dl-badge" hidden></span></button>
            <div class="es-view__dl-pop" hidden>
              <div class="es-view__downloads-head">
                <h2 class="es-view__h"></h2>
                <button type="button" class="eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__clear"></button>
              </div>
              <ul class="es-view__jobs"></ul>
            </div>
          </div>
          <div class="es-view__account">
            <button type="button" class="eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__login" hidden></button>
            <div class="es-view__me" hidden>
              <button type="button" class="es-view__me-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="es-me-menu">
                <span class="es-view__avatar"><img class="es-view__avatar-img" alt="" hidden><span class="es-view__avatar-letter" aria-hidden="true"></span></span>
                <span class="es-view__me-chev" aria-hidden="true"></span>
              </button>
              <div class="es-view__me-menu" id="es-me-menu" role="menu" hidden>
                <p class="es-view__me-name" role="none"></p>
                <button type="button" class="es-view__me-item" role="menuitem" data-act="logout"></button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="es-view__body">
        <div class="es-view__toolbar">
          <div class="library__chips es-view__chips" hidden></div>
          <h2 class="es-view__heading es-sr-only" hidden></h2>
          <div class="es-view__controls">
            <label class="es-tool es-tool--sort"><span class="es-tool__icon" aria-hidden="true"></span><span class="es-tool__label es-sr-only" data-k="sort"></span><select class="es-tool__select" data-k="sort"></select></label>
            <div class="library__picker es-view__filters">
              <button type="button" class="library__picker-btn es-view__filters-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="es-filters-pop">
                <span class="library__picker-icon" aria-hidden="true"></span>
                <span class="library__picker-label es-view__filters-label"></span>
                <span class="library__picker-badge es-view__filters-badge" hidden></span>
              </button>
              <div class="library__picker-pop library__picker-pop--filters es-view__filters-pop" id="es-filters-pop" role="dialog" hidden>
                <div class="es-view__filters-grid">
                  <label class="es-tool"><span class="es-tool__label" data-k="video"></span><select class="es-tool__select" data-k="video"></select></label>
                  <label class="es-tool"><span class="es-tool__label" data-k="length"></span><select class="es-tool__select" data-k="length"></select></label>
                  <label class="es-tool"><span class="es-tool__label" data-k="device"></span><select class="es-tool__select" data-k="device"></select></label>
                  <label class="es-tool"><span class="es-tool__label" data-k="get"></span><select class="es-tool__select" data-k="get"></select></label>
                </div>
                <div class="es-tool es-tool--tags"><span class="es-tool__label" data-k="tags"></span><span class="es-view__tags-host"></span></div>
                <div class="es-tool es-tool--tags es-tool--hide"><span class="es-tool__label" data-k="hide"></span><span class="es-view__hide-host"></span></div>
              </div>
            </div>
            <div class="es-seg es-view__mode" role="radiogroup">
              <button type="button" class="es-seg__btn es-view__mode-btn" data-mode="cards" role="radio"></button>
              <button type="button" class="es-seg__btn es-view__mode-btn" data-mode="list" role="radio"></button>
            </div>
            <button type="button" class="eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__refresh" hidden></button>
            <button type="button" class="eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__feed-edit" hidden></button>
            <button type="button" class="eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__select-btn"></button>
          </div>
        </div>
        <p class="es-view__empty" hidden></p>
        <div class="es-grid" role="list"></div>
      </div>
      <div class="es-view__selbar" hidden>
        <span class="es-view__selbar-text"></span>
        <button type="button" class="eroscripts-panel__btn es-view__selbar-go"></button>
        <button type="button" class="eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__selbar-cancel"></button>
      </div>`;
    this._searchHost = c.querySelector('.es-view__search');
    this._grid = c.querySelector('.es-grid');
    // The cards' widths follow the window: fit their Video / Script chips again (_fitParts).
    if (typeof ResizeObserver === 'function' && this._grid) {
      let lastWidth = -1;
      new ResizeObserver(() => {
        const w = this._grid.clientWidth;
        if (w === lastWidth) return;
        lastWidth = w;
        this._gridWidth = w;
        for (const entry of this._cards.values()) this._fitParts(entry);
      }).observe(this._grid);
    }
    this._emptyEl = c.querySelector('.es-view__empty');
    this._headingEl = c.querySelector('.es-view__heading');
    this._moreBtn = document.createElement('button');
    this._moreBtn.type = 'button';
    this._moreBtn.className = 'eroscripts-panel__btn eroscripts-panel__btn--secondary es-view__more';
    this._moreBtn.hidden = true;
    this._moreBtn.addEventListener('click', () => this._loadMore());
    this._body = c.querySelector('.es-view__body');
    this._body.appendChild(this._moreBtn);
    // More as you reach the bottom (the button stays, for a keyboard or a
    // screen too tall to scroll).
    if (typeof IntersectionObserver === 'function') {
      this._moreObserver = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && !this._moreBtn.hidden && !this._moreBtn.disabled) this._loadMore();
      }, { root: this._body, rootMargin: '0px 0px 600px 0px' });
      this._moreObserver.observe(this._moreBtn);
    }
    // Sort and filters.
    this._toolbar = c.querySelector('.es-view__toolbar');
    for (const sel of this._toolbar.querySelectorAll('.es-tool__select')) {
      sel.addEventListener('change', () => this._onToolChange(sel.dataset.k, sel.value));
    }
    // Your own tags (Dave, 2026-11-23: "it would be cool if you could search by
    // tag"): chips with the forum's suggestions; every one must be on a thread.
    this._tagFilter = new TagInput({
      tags: this._filters().tags,
      max: tagRoom(this._filters()),
      placeholder: t('eroscripts.tab.fTags.placeholder'),
      suggest: (q) => this._suggestTags(q, this._loadedTags()),
      exists: (tag) => this._tagExists(tag),
      onChange: (list) => this._onToolChange('tags', list),
    });
    this._tagFilter.el.classList.add('es-tool__tags');
    this._tagFilter.input.setAttribute('aria-label', t('eroscripts.tab.fTags.aria'));
    this._toolbar.querySelector('.es-view__tags-host').appendChild(this._tagFilter.el);
    // Tags to hide (Dave, 2026-11-23: "no results with for example pmv or animation").
    this._hideFilter = new TagInput({
      tags: this._filters().hide,
      max: MAX_HIDE_TAGS,
      placeholder: t('eroscripts.tab.fHide.placeholder'),
      suggest: (q) => this._suggestTags(q, this._loadedTags()),
      exists: (tag) => this._tagExists(tag),
      onChange: (list) => this._onToolChange('hide', list),
    });
    this._hideFilter.el.classList.add('es-tool__tags', 'es-tool__tags--hide');
    this._hideFilter.input.setAttribute('aria-label', t('eroscripts.tab.fHide.aria'));
    this._toolbar.querySelector('.es-view__hide-host').appendChild(this._hideFilter.el);
    // Sort and Filters as the Library has them (Dave, 2026-11-25: "put the
    // filter and sort options ... under a menu ... so that the results are the
    // main feature of the page"): Video / Length / Device / Download / Tags /
    // Hide in a Filters popover with a count on its button, what is set as
    // chips under the bar (each × takes one off), the list's title on the bar.
    this._filtersBtn = c.querySelector('.es-view__filters-btn');
    this._filtersPop = c.querySelector('.es-view__filters-pop');
    this._chipsEl = c.querySelector('.es-view__chips');
    this._filtersBtn.querySelector('.library__picker-icon').appendChild(icon(SlidersHorizontal, { width: 14, height: 14 }));
    this._toolbar.querySelector('.es-tool--sort .es-tool__icon').appendChild(icon(ArrowDownWideNarrow, { width: 14, height: 14 }));
    this._filtersBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setFiltersOpen(this._filtersPop.hidden, { fromKeyboard: e.detail === 0 });
    });
    // A press outside closes it (a tag's suggestion list is inside it).
    document.addEventListener('pointerdown', (e) => {
      if (this._filtersPop.hidden) return;
      if (e.target instanceof Node && c.querySelector('.es-view__filters').contains(e.target)) return;
      this._setFiltersOpen(false);
    }, true);
    // Escape closes it, the focus back on Filters (a tag's open suggestion
    // list takes its own Escape first: TagInput marks it taken).
    c.querySelector('.es-view__filters').addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || this._filtersPop.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      this._setFiltersOpen(false);
      this._filtersBtn.focus();
    });
    // What each post offers, read in the background (eroscripts-probe.js).
    this._probe = new PostProbe({
      fetchTopic: (id) => window.funsync?.eroscriptsTopic?.(Number(id), { replies: false }),
      classify: async (urls) => (await this._fetchJson('/classify', { method: 'POST', body: JSON.stringify({ links: urls }) })).body?.links || [],
      onResult: (id) => { const e = this._cards.get(String(id)); if (e) this._paintCard(e); },
      // A 401 / 403: is the login good? An expired one is dropped by the
      // panel (one toast) and the checks wait for a sign-in (B029).
      checkSession: async () => (await this._panel?.handleSessionExpired?.()) || 'unknown',
      storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    });
    // Cards or a list like the forum's (2026-11-22).
    for (const b of c.querySelectorAll('.es-view__mode-btn')) {
      b.appendChild(icon(b.dataset.mode === 'list' ? LayoutList : LayoutGrid, { width: 14, height: 14 }));
      b.addEventListener('click', () => this._setViewMode(b.dataset.mode));
    }
    // Feeds.
    this._feedsEl = c.querySelector('.es-view__feeds');
    this._feedEditBtn = c.querySelector('.es-view__feed-edit');
    this._feedEditBtn.addEventListener('click', () => this._openFeedEditor(this._openFeed()));
    // Refresh (Dave, 2026-11-23: "we need a manual refresh button for the
    // selected feed"): the open feed's (or All scripts') newest threads now.
    this._refreshBtn = c.querySelector('.es-view__refresh');
    this._refreshBtn.appendChild(icon(RefreshCw, { width: 14, height: 14 }));
    this._refreshLabel = document.createElement('span');
    // The icon alone on the bar (2026-11-25 tidy-up); the word stays its name.
    this._refreshLabel.className = 'es-sr-only';
    this._refreshBtn.appendChild(this._refreshLabel);
    this._refreshBtn.addEventListener('click', () => this.refreshFeed());
    // Several at once.
    this._selectBtn = c.querySelector('.es-view__select-btn');
    this._selectBtn.addEventListener('click', () => this._setSelecting(!this._selecting));
    this._selbar = c.querySelector('.es-view__selbar');
    c.querySelector('.es-view__selbar-go').addEventListener('click', () => this._downloadSelected());
    c.querySelector('.es-view__selbar-cancel').addEventListener('click', () => this._setSelecting(false));
    this._jobsEl = c.querySelector('.es-view__jobs');
    this._dlBtn = c.querySelector('.es-view__dl-btn');
    this._dlPop = c.querySelector('.es-view__dl-pop');
    this._dlBtn.addEventListener('click', () => this._toggleDownloads());
    this._pasteBtn = c.querySelector('.es-view__paste-btn');
    this._pasteBtn.addEventListener('click', () => this.openPasteLink());
    // Paste and Downloads as icons with their words as tooltips (Dave,
    // 2026-11-25: "replace the download and paste item buttons with icons
    // that have tooltips"); Downloads keeps its count as a badge.
    this._pasteBtn.appendChild(icon(ClipboardPaste, { width: 16, height: 16 }));
    this._dlBtn.prepend(icon(Download, { width: 16, height: 16 }));
    this._buildAccount();
    // A link pasted anywhere on the tab (not into a text box) opens the
    // window with it (Dave, 2026-11-22: FapTap videos with no forum post).
    this._onPaste = (e) => {
      if (!this._visible || document.querySelector('.modal-overlay')) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const text = String(e.clipboardData?.getData('text') || '').trim();
      if (!/^https?:\/\/\S+$/i.test(text)) return;
      e.preventDefault();
      this.openPasteLink(text);
    };
    document.addEventListener('paste', this._onPaste);
    c.querySelector('.es-view__clear').addEventListener('click', async () => {
      await this._fetchJson('/clear', { method: 'POST' }).catch(() => {});
      this._refreshJobs();
    });
    this._onDocClick = (e) => {
      if (!this._dlPop.hidden && !e.target.closest('.es-view__dl-wrap')) this._toggleDownloads(false);
    };
    document.addEventListener('click', this._onDocClick, true);
    this._dlPop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this._toggleDownloads(false); this._dlBtn.focus(); }
    });

    this._filterEl = this._buildFilter();
    this._paintStatic();
    this._renderJobs();
  }

  // --- cards or list --------------------------------------------------------------

  _viewMode() { return this._get(SETTING_VIEW) === 'list' ? 'list' : 'cards'; }

  _setViewMode(mode) {
    if (mode === this._viewMode()) return;
    this._set(SETTING_VIEW, mode === 'list' ? 'list' : 'cards');
    this._paintToolbar();
    this._rerender();
  }

  /** Draw what is loaded again (a new mode or language), without asking the forum. */
  _rerender() {
    if (this._mode === 'latest' && this._latest) {
      const st = this._latest;
      this._renderCards([], { latest: true });
      this._results = st.results;
      for (const topic of st.results) this._grid.appendChild(this._item(topic));
      this._moreBtn.hidden = !st.more;
    } else if (this._results) {
      this._renderCards(this._results);
      this._moreBtn.hidden = !this._search?.more;
    }
  }

  _item(topic) { return this._viewMode() === 'list' ? this._row(topic) : this._card(topic); }

  /** The list's column titles, as the forum's: Topic, Replies, Views, Activity. */
  _listHead() {
    const head = document.createElement('div');
    head.className = 'es-list__head';
    head.setAttribute('role', 'presentation');
    for (const [cls, key] of [['es-row__main', 'topic'], ['es-row__num', 'replies'], ['es-row__num', 'views'], ['es-row__num', 'activity']]) {
      const cell = document.createElement('span');
      cell.className = cls;
      cell.textContent = t(`eroscripts.tab.list.${key}`);
      head.appendChild(cell);
    }
    return head;
  }

  /**
   * One thread as a row of the forum's topic list: a small thumbnail (grey
   * until the video is here), the title with Free / Paid and the thread's
   * own tags under it, the creator and likes, Replies, Views, Activity, and
   * the same Video / Script marks and button as a card.
   */
  _row(topic) {
    const row = document.createElement('div');
    row.className = 'es-row';
    row.setAttribute('role', 'listitem');
    row.dataset.topicId = String(topic.id);

    const thumb = document.createElement('div');
    thumb.className = 'es-row__thumb';
    const img = createResultThumb({ thumbnail: topic.thumbnail, avatar: topic.avatar, className: 'es-row__img' });
    thumb.appendChild(img);
    if (!topic.thumbnail && topic.id) {
      window.funsync?.eroscriptsTopicImage?.(topic.id).then((url) => {
        if (url) { img.src = url; img.style.display = ''; }
      }).catch(() => {});
    }
    const check = document.createElement('span');
    check.className = 'es-card__check';
    check.setAttribute('aria-hidden', 'true');
    check.appendChild(icon(Check, { width: 12, height: 12, 'stroke-width': 3 }));
    thumb.appendChild(check);
    const progress = document.createElement('div');
    progress.className = 'es-card__progress';
    progress.hidden = true;
    const fill = document.createElement('div');
    fill.className = 'es-card__progress-fill';
    progress.appendChild(fill);
    thumb.appendChild(progress);

    const main = document.createElement('div');
    main.className = 'es-row__main';
    const title = document.createElement('div');
    title.className = 'es-row__title';
    title.textContent = topic.title;
    title.title = topic.title;
    const sub = document.createElement('div');
    sub.className = 'es-row__sub';
    const isNew = !!this._feedId && !!this._feedSince && Date.parse(topic.createdAt) > Date.parse(this._feedSince);
    if (isNew) {
      const n = document.createElement('span');
      n.className = 'es-chip es-chip--new';
      n.textContent = t('eroscripts.tab.feeds.new');
      sub.appendChild(n);
    }
    const price = priceOf(topic.categoryId);
    if (price) {
      const chip = document.createElement('span');
      chip.className = `es-row__cat es-row__cat--${price}`;
      chip.textContent = t(`eroscripts.tab.price.${price}`);
      sub.appendChild(chip);
    }
    for (const tag of (topic.tags || []).slice(0, 6)) {
      const tg = document.createElement('span');
      tg.className = 'es-row__tag';
      tg.textContent = tag;
      sub.appendChild(tg);
    }
    const by = document.createElement('span');
    by.className = 'es-row__by';
    by.textContent = [topic.creator ? `@${topic.creator}` : '', topic.likeCount > 0 ? t('eroscripts.likes', { count: topic.likeCount }) : ''].filter(Boolean).join(' · ');
    if (by.textContent) sub.appendChild(by);
    const status = document.createElement('div');
    status.className = 'es-card__status';
    status.hidden = true;
    main.append(title, sub, status);

    const num = (value) => {
      const c = document.createElement('span');
      c.className = 'es-row__num';
      c.textContent = value;
      return c;
    };
    const replies = num(Number.isFinite(topic.replies) ? String(topic.replies) : '–');
    const views = num(topic.views > 0 ? compactNumber(topic.views) : '–');
    const activity = num(relativeTime(topic.activityAt || topic.createdAt) || '–');
    activity.title = topic.activityAt || topic.createdAt || '';

    const acts = document.createElement('div');
    acts.className = 'es-row__acts';
    const parts = document.createElement('div');
    parts.className = 'es-card__parts';
    const videoPart = this._part(Clapperboard, t('eroscripts.tab.card.video'), 'video');
    const scriptPart = this._part(FileText, t('eroscripts.tab.card.script'), 'script');
    parts.append(videoPart, scriptPart);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eroscripts-panel__btn es-card__btn';
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._cardAction(topic, btn); });
    acts.append(parts, btn);

    row.append(thumb, main, replies, views, activity, acts);
    row.addEventListener('click', () => {
      if (this._selecting) this._toggleSelected(topic);
      else this.openPost(topic);
    });
    const entry = { topic, card: row, els: { progress, fill, status, btn, videoPart, scriptPart } };
    this._cards.set(String(topic.id), entry);
    this._probe?.enqueue([topic.id]);
    this._paintCard(entry);
    return row;
  }

  // --- sort and filters ---------------------------------------------------------

  _sort() { return normalizeSort(this._get(SETTING_SORT)); }

  _filters() { return normalizeFilters(this._get(SETTING_FILTERS)); }

  /** The tags on the threads shown now: instant suggestions before the forum answers. */
  _loadedTags() {
    const seen = new Set();
    for (const entry of this._cards?.values?.() || []) for (const tg of entry?.topic?.tags || []) seen.add(String(tg).toLowerCase());
    return [...seen];
  }

  _need() { return normalizeNeed(this._get(SETTING_NEED)); }

  _onToolChange(key, value) {
    if (key === 'get') {                            // a view filter: no new request, any list
      this._set(SETTING_NEED, normalizeNeed(value));
      this._paintToolbar();
      this._repaintAll();
      return;
    }
    if (this._feedId) return;                       // a feed's choices are its own (Edit feed)
    if (key === 'sort') this._set(SETTING_SORT, normalizeSort(value));
    else this._set(SETTING_FILTERS, normalizeFilters({ ...this._filters(), [key]: value }));
    this._paintToolbar();
    this._rerun();
  }

  /** Show again with the current price, sort and filters. */
  _rerun() {
    if (this._mode === 'search') this._panel?.search?.();
    else this._loadLatest(true);
  }

  _paintToolbar() {
    if (!this._toolbar) return;
    const f = this._filters();
    const options = {
      sort: SORTS.map((v) => [v, t(`eroscripts.tab.sort.${v.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`)]),
      video: ['any', 'vr', 'flat'].map((v) => [v, t(`eroscripts.tab.fVideo.${v}`)]),
      length: [['any', t('eroscripts.tab.fLength.any')], ...LENGTH_TAGS.map((v) => [v, t(`eroscripts.tab.len.${v.slice(4).replace(/-/g, '_')}`)])],
      device: ['any', 'multi', 'handy'].map((v) => [v, t(`eroscripts.tab.fDevice.${v}`)]),
      get: NEEDS.map((v) => [v, t(`eroscripts.tab.fGet.${v}`)]),
    };
    const feed = this._openFeed();
    const ff = feed ? feed.filters : f;
    const current = { sort: feed ? 'newest' : this._sort(), video: ff.video, length: ff.length, device: ff.device, get: this._need() };
    for (const sel of this._toolbar.querySelectorAll('.es-tool__select')) {
      const k = sel.dataset.k;
      sel.replaceChildren(...options[k].map(([v, label]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        return o;
      }));
      sel.value = current[k];
      sel.classList.toggle('es-tool__select--set', k !== 'sort' && current[k] !== 'any');
      sel.disabled = !!feed && k !== 'get';
    }
    // Your tags: the feed's while one is open (read-only), else the tab's; the room left beside the choices.
    if (this._tagFilter) {
      const label = this._toolbar.querySelector('.es-tool__label[data-k="tags"]');
      if (label) label.textContent = t('eroscripts.tab.fTags.label');
      const tags = feed ? (feed.tags || []) : f.tags;
      this._tagFilter.setMax(feed ? Infinity : tagRoom(f));
      this._tagFilter.setTags(tags);
      this._tagFilter.setDisabled(!!feed);
      this._tagFilter.el.classList.toggle('es-tool__tags--set', tags.length > 0);
    }
    if (this._hideFilter) {
      const label = this._toolbar.querySelector('.es-tool__label[data-k="hide"]');
      if (label) label.textContent = t('eroscripts.tab.fHide.label');
      const hide = feed ? normalizeFilters(feed.filters).hide : f.hide;
      this._hideFilter.setTags(hide);
      this._hideFilter.setDisabled(!!feed);
      this._hideFilter.el.classList.toggle('es-tool__tags--set', hide.length > 0);
    }
    this._feedEditBtn.hidden = !feed || !!feed.suggested;
    this._feedEditBtn.textContent = t('eroscripts.tab.feeds.edit');
    this._paintRefresh();
    for (const b of this._container.querySelectorAll('.es-view__mode-btn')) {
      const on = b.dataset.mode === this._viewMode();
      const words = t(`eroscripts.tab.view.${b.dataset.mode}`);
      b.title = words;
      b.setAttribute('aria-label', words);
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('es-seg__btn--on', on);
    }
    for (const lab of this._toolbar.querySelectorAll('.es-tool__label')) {
      lab.textContent = t(`eroscripts.tab.tool.${lab.dataset.k}`);
    }
    this._selectBtn.textContent = t(this._selecting ? 'eroscripts.tab.select.done' : 'eroscripts.tab.select.button');
    this._paintFilterChips();
  }

  /**
   * Your EroScripts account, far right (Dave, 2026-11-25: "instead of the user
   * name and a log out button have the users profile picture or an avatar with
   * an arrow button next to it which opens a dropdown with the logout
   * option"). Logged out: Log In. Logged in: the picture (the first letter
   * when there is none or it will not load) and a chevron; the menu names the
   * account and has Log Out. Built once (its keys are wired once); the panel
   * says when the name, the picture or the login window's waiting changes.
   */
  _buildAccount() {
    const c = this._container;
    this._accountEl = c.querySelector('.es-view__account');
    this._loginBtn = c.querySelector('.es-view__login');
    this._meBtn = c.querySelector('.es-view__me-btn');
    this._meMenu = c.querySelector('.es-view__me-menu');
    this._meBtn.querySelector('.es-view__me-chev').appendChild(icon(ChevronDown, { width: 14, height: 14 }));
    this._loginBtn.addEventListener('click', () => this._panel?.openLogin?.());
    this._meBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setAccountMenuOpen(this._meMenu.hidden);
    });
    wireMenuKeys(this._meBtn, this._meMenu, { close: () => this._setAccountMenuOpen(false) });
    document.addEventListener('pointerdown', (e) => {
      if (this._meMenu.hidden || (e.target instanceof Node && this._accountEl.contains(e.target))) return;
      this._setAccountMenuOpen(false);
    }, true);
    this._meMenu.querySelector('[data-act="logout"]').addEventListener('click', () => {
      this._setAccountMenuOpen(false);
      this._panel?.logout?.();
    });
    const img = this._accountEl.querySelector('.es-view__avatar-img');
    const letter = this._accountEl.querySelector('.es-view__avatar-letter');
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => { img.hidden = false; letter.hidden = true; });
    img.addEventListener('error', () => { this._avatarFailed = this._avatarFor; img.hidden = true; letter.hidden = false; });
    if (this._panel) this._panel.onProfileChanged = () => this._paintAccount();
  }

  _setAccountMenuOpen(open) {
    if (!this._meMenu) return;
    this._meMenu.hidden = !open;
    this._meBtn.setAttribute('aria-expanded', String(open));
  }

  _paintAccount() {
    if (!this._accountEl) return;
    const panel = this._panel;
    const signedIn = !!panel?.isLoggedIn;
    const name = String(panel?.username || '');
    this._loginBtn.hidden = signedIn;
    this._accountEl.querySelector('.es-view__me').hidden = !signedIn;
    if (!signedIn) {
      this._setAccountMenuOpen(false);
      // A picture still being fetched is no longer wanted; none is kept.
      this._avatarFor = '';
      const img = this._accountEl.querySelector('.es-view__avatar-img');
      img.hidden = true;
      img.removeAttribute('src');
      const waiting = !!panel?.loginPending;
      this._loginBtn.disabled = waiting;
      this._loginBtn.textContent = t(waiting ? 'eroscripts.waitingLogin' : 'eroscripts.logIn');
      return;
    }
    const label = t('eroscripts.tab.account.aria', { user: name });
    this._meBtn.setAttribute('aria-label', label);
    this._meBtn.title = label;
    this._meMenu.setAttribute('aria-label', label);
    this._accountEl.querySelector('.es-view__me-name').textContent = '@' + name;
    this._meMenu.querySelector('[data-act="logout"]').textContent = t('eroscripts.logOut');
    const letter = this._accountEl.querySelector('.es-view__avatar-letter');
    letter.textContent = (name.trim()[0] || '?').toUpperCase();
    const img = this._accountEl.querySelector('.es-view__avatar-img');
    const url = String(panel?.avatarUrl || '');
    if (!url || url === this._avatarFailed) {
      this._avatarFor = '';
      img.hidden = true;
      img.removeAttribute('src');
      letter.hidden = false;
      return;
    }
    if (this._avatarFor === url) return;
    // The letter until the picture has loaded (and for good if it fails).
    this._avatarFor = url;
    img.hidden = true;
    letter.hidden = false;
    this._loadAvatar(url, img);
  }

  /**
   * The picture through main, as a post's images: the forum serves its
   * uploads only with the login (Dave, 2026-11-25: "the avatar isnt showing
   * my profile picture from eroscripts": the window's own <img> request has
   * no forum cookie, and got the forum's placeholder or a refusal). Main
   * sends the session to the forum's hosts only; a CDN's letter avatar goes
   * without it. A data: address back (the page's CSP allows those).
   */
  async _loadAvatar(url, img) {
    const fetchImage = window.funsync?.eroscriptsImage;
    if (typeof fetchImage !== 'function') { img.src = url; return; }
    let res = null;
    try { res = await fetchImage(url, { external: true }); } catch { res = null; }
    if (this._avatarFor !== url) return;                     // another account or picture since
    if (res?.ok && typeof res.dataUrl === 'string' && res.dataUrl.startsWith('data:image/')) img.src = res.dataUrl;
    else this._avatarFailed = url;                            // the letter stays
  }

  /** Open or close the Filters popover; from the keyboard the focus goes into it. */
  _setFiltersOpen(open, { fromKeyboard = false } = {}) {
    if (!this._filtersPop) return;
    this._filtersPop.hidden = !open;
    this._filtersBtn.setAttribute('aria-expanded', String(open));
    if (open && fromKeyboard) this._filtersPop.querySelector('select:not(:disabled), input:not(:disabled)')?.focus();
  }

  /**
   * What is set, as chips under the bar (filter-chips.js, as the Library), and
   * the count on Filters. An open feed's own choices are its (Edit feed): only
   * Download, which applies to any list, shows then.
   */
  _paintFilterChips() {
    if (!this._chipsEl) return 0;
    const feed = this._openFeed();
    const f = this._filters();
    const need = this._need();
    const keys = feed ? ['get'] : ['video', 'length', 'device', 'get'];
    const state = {};
    const defaults = {};
    const labels = {};
    for (const k of keys) {
      state[k] = k === 'get' ? need : f[k];
      defaults[k] = 'any';
      labels[k] = {};
      for (const o of this._toolbar.querySelectorAll(`.es-tool__select[data-k="${k}"] option`)) labels[k][o.value] = o.textContent;
    }
    const extra = feed ? [] : [
      ...f.tags.map((tag) => ({ key: `tag:${tag}`, label: tag })),
      ...f.hide.map((tag) => ({ key: `hide:${tag}`, label: t('eroscripts.tab.chip.hide', { tag }) })),
    ];
    const n = renderFilterChips({
      container: this._chipsEl,
      state,
      defaults,
      labels,
      order: keys,
      extra,
      iconFactory: (_name, size) => icon(X, { width: size, height: size }),
      onRemove: (key) => this._removeFilterChip(key),
    });
    if (n >= 2) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'es-view__chips-clear';
      clear.textContent = t('eroscripts.tab.filtersClear');
      clear.addEventListener('click', () => this._clearFilters());
      this._chipsEl.appendChild(clear);
    }
    const badge = this._filtersBtn.querySelector('.es-view__filters-badge');
    badge.hidden = n === 0;
    badge.textContent = String(n);
    this._filtersBtn.querySelector('.es-view__filters-label').textContent = t('library.filters');
    this._filtersPop.setAttribute('aria-label', t('library.filtersPopAria'));
    return n;
  }

  /** A chip's ×: that one filter off. */
  _removeFilterChip(key) {
    const f = this._filters();
    if (key.startsWith('tag:')) this._onToolChange('tags', f.tags.filter((tag) => tag !== key.slice(4)));
    else if (key.startsWith('hide:')) this._onToolChange('hide', f.hide.filter((tag) => tag !== key.slice(5)));
    else this._onToolChange(key, 'any');
  }

  /** Clear all: every filter the chips show, in one go (one new list, not one per chip). */
  _clearFilters() {
    if (this._openFeed()) { this._onToolChange('get', 'any'); return; }
    this._set(SETTING_NEED, normalizeNeed('any'));
    this._set(SETTING_FILTERS, normalizeFilters({ ...this._filters(), video: 'any', length: 'any', device: 'any', tags: [], hide: [] }));
    this._paintToolbar();
    this._rerun();
  }

  /** What a search is sent as: price, Top, the first tag (decorateQuery). */
  _decorate(q) {
    return decorateQuery(q, { price: this._priceFilter(), sort: this._sort(), filters: this._filters() });
  }

  /** More of what is shown: the next page of the list or of the search. */
  _loadMore() {
    if (this._mode === 'search') this._loadSearchPage();
    else this._loadLatest(false);
  }

  async _loadSearchPage() {
    const st = this._search;
    if (!st || st.loading || !st.more) return;
    st.loading = true;
    this._moreBtn.disabled = true;
    let answer = null;
    try { answer = await window.funsync.eroscriptsSearch(this._decorate(st.query), st.page + 1); } catch { answer = null; }
    st.loading = false;
    this._moreBtn.disabled = false;
    if (this._search !== st || this._mode !== 'search') return;
    const got = answer?.results || [];
    st.page += 1;
    st.more = got.length >= SEARCH_PAGE;
    const seen = new Set(st.results.map((r) => r.id));
    const fresh = got.filter((r) => r && !seen.has(r.id));
    st.results.push(...fresh);
    this._results = st.results;
    const price = this._priceFilter();
    const filters = this._filters();
    for (const topic of fresh) if (matchesPrice(topic, price) && matchesFilters(topic, filters)) this._grid.appendChild(this._item(topic));
    this._moreBtn.hidden = !st.more;
  }

  // --- feeds ----------------------------------------------------------------------

  _feeds() { return this._checker.feeds(); }

  _openFeed() {
    if (this._feedId === SUGGEST_ID) return this._suggestedFeed();
    return this._feedId ? this._feeds().find((fd) => fd.id === this._feedId) || null : null;
  }

  /**
   * The built-in Suggested feed (2026-11-24), made from the library, never
   * stored: its tags are the library's taste tags (eroscripts-suggest.js),
   * shown read-only in the Tags box; the user's Hide tags still apply.
   */
  _suggestedFeed() {
    const f = this._filters();
    return {
      id: SUGGEST_ID, suggested: true, name: t('eroscripts.tab.suggest.chip'), price: 'all',
      filters: normalizeFilters({ hide: f.hide }),
      tags: (this._suggest?.tags || []).map((x) => x.tag),
    };
  }

  /** Has the user got this post, or linked a video to it? */
  _haveTopic(topic) {
    const id = Number(topic?.id);
    if (this._libMap?.has?.(id)) return true;
    return !!this._done()[topic?.id];
  }

  /**
   * What to suggest: the library's taste tags (ranked against the forum's
   * own tag counts when they can be read, once an hour in main), its format.
   */
  async _computeSuggest() {
    const lib = libraryTagCounts(this._get('library.scriptTags'), this._get('library.userTags'));
    if (!lib.videos) return { tags: [], avoid: [], format: null, videos: 0 };
    let known = null;
    try {
      const names = ((await window.funsync?.eroscriptsTags?.())?.tags || []).map((x) => x?.name).filter(Boolean);
      if (names.length) known = new Set(names);
    } catch { known = null; }
    const baseline = await this._suggestBaseline();
    return {
      tags: rankTasteTags(lib, { baseline, known }, { leftOut: readLeftOut(this._settings) }),
      avoid: avoidTags(lib, baseline, { allowed: readAllowed(this._settings) }),
      format: formatPreference(lib), videos: lib.videos,
    };
  }

  /**
   * What the forum's script posts are usually tagged: its two newest pages
   * (about 60 posts), read once an hour (2 requests). The forum's tag list
   * counts leave the script categories out, so they cannot say this.
   */
  async _suggestBaseline() {
    const held = this._baselineHeld;
    if (held && Date.now() - held.at < 60 * 60 * 1000) return held.baseline;
    const topics = [];
    for (const page of [0, 1]) {
      let r = null;
      try { r = await window.funsync?.eroscriptsLatest?.('all', page, { sort: 'newest', period: 'all', tags: [] }); } catch { r = null; }
      if (!r || r.error) break;
      topics.push(...(r.results || []));
      if (!r.more) break;
    }
    const baseline = baselineCounts(topics);
    if (baseline.posts) this._baselineHeld = { at: Date.now(), baseline };
    return baseline.posts ? baseline : null;
  }

  /** The Suggested heading's line: the tags it used, each can be left out. */
  _paintSuggestBar() {
    let bar = this._suggestBarEl;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'es-suggest';
      // Under the bar (its chips and the heading sit on it since 2026-11-25).
      this._toolbar.after(bar);
      this._suggestBarEl = bar;
    }
    const sg = this._feedId === SUGGEST_ID ? this._suggest : null;
    bar.hidden = !sg || !sg.tags.length;
    bar.replaceChildren();
    if (bar.hidden) return;
    bar.appendChild(this._p('es-suggest__from', t('eroscripts.tab.suggest.from', { count: sg.videos })));
    for (const x of sg.tags) {
      const chip = document.createElement('span');
      chip.className = 'es-suggest__tag';
      chip.textContent = x.tag;
      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'es-suggest__out';
      out.setAttribute('aria-label', t('eroscripts.tab.suggest.leaveOut', { tag: x.tag }));
      out.title = t('eroscripts.tab.suggest.leaveOut', { tag: x.tag });
      out.appendChild(icon(X, { width: 12, height: 12 }));
      out.addEventListener('click', () => { setLeftOut(this._settings, x.tag, true); this._loadLatest(true); });
      chip.appendChild(out);
      bar.appendChild(chip);
    }
    // What the library has none of: left out, each can be allowed back.
    if (sg.avoid?.length) {
      bar.appendChild(this._p('es-suggest__from es-suggest__from--avoid', t('eroscripts.tab.suggest.avoiding')));
      for (const x of sg.avoid) {
        const chip = document.createElement('span');
        chip.className = 'es-suggest__tag es-suggest__tag--avoid';
        chip.textContent = x.tag;
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'es-suggest__out';
        allow.setAttribute('aria-label', t('eroscripts.tab.suggest.allow', { tag: x.tag }));
        allow.title = t('eroscripts.tab.suggest.allow', { tag: x.tag });
        allow.appendChild(icon(X, { width: 12, height: 12 }));
        allow.addEventListener('click', () => { setAllowed(this._settings, x.tag, true); this._loadLatest(true); });
        chip.appendChild(allow);
        bar.appendChild(chip);
      }
    }
    const left = readLeftOut(this._settings);
    const allowed = readAllowed(this._settings);
    if (allowed.length) {
      const back = this._button(t('eroscripts.tab.suggest.avoidAgain', { count: allowed.length }), 'secondary', () => {
        for (const tag of allowed) setAllowed(this._settings, tag, false);
        this._loadLatest(true);
      });
      back.classList.add('es-suggest__back');
      bar.appendChild(back);
    }
    if (left.length) {
      const back = this._button(t('eroscripts.tab.suggest.bringBack', { count: left.length }), 'secondary', () => {
        for (const tag of left) setLeftOut(this._settings, tag, false);
        this._loadLatest(true);
      });
      back.classList.add('es-suggest__back');
      bar.appendChild(back);
    }
  }

  /** On a suggested card: why, and Not interested. */
  _whyLine(topic) {
    if (this._feedId !== SUGGEST_ID || !this._suggest) return null;
    const why = suggestionReason(topic, this._suggest.tags);
    if (!why.length) return null;
    const line = document.createElement('div');
    line.className = 'es-card__why';
    const words = document.createElement('span');
    words.className = 'es-card__why-text';
    words.textContent = t('eroscripts.tab.suggest.because', { tags: why.join(', ') });
    words.title = words.textContent;
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'es-card__not';
    // An x with its words as label and tooltip: the reason keeps the room.
    no.setAttribute('aria-label', t('eroscripts.tab.suggest.notInterested'));
    no.title = t('eroscripts.tab.suggest.notInterested');
    no.appendChild(icon(X, { width: 12, height: 12 }));
    no.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissTopic(this._settings, topic.id, true);
      const entry = this._cards.get(String(topic.id));
      entry?.card?.remove();
      this._cards.delete(String(topic.id));
      showUndoToast(t('eroscripts.tab.suggest.dismissed'), () => { dismissTopic(this._settings, topic.id, false); this._loadLatest(true); }, 'info', 6000);
    });
    line.append(words, no);
    return line;
  }

  /** New threads across every feed (the nav bar's badge). */
  totalNew() { return this._checker.totalNew(); }

  _feedsChanged() {
    this._renderFeeds();
    this.onFeedsChanged?.(this.totalNew());
  }

  _renderFeeds() {
    const el = this._feedsEl;
    if (!el) return;
    // One pill group on one line (Dave, 2026-11-25: "make that a pillgroup
    // and if it gets too long and would [move] onto the next row then change
    // the last one that will fit into a down arrow and put the rest under a
    // dropdown menu"): 30 feeds wrapped into five lines over the results.
    const group = document.createElement('div');
    group.className = 'es-feeds';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('eroscripts.tab.feeds.groupAria'));
    el.replaceChildren(group);
    const feeds = this._feeds();
    const chip = (label, active, onClick, badge = '', cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `es-feed${active ? ' es-feed--on' : ''}${cls ? ` ${cls}` : ''}`;
      b.setAttribute('aria-pressed', String(active));
      const name = document.createElement('span');
      name.className = 'es-feed__name';
      name.textContent = label;
      b.appendChild(name);
      if (badge) {
        const n = document.createElement('span');
        n.className = 'es-feed__badge';
        n.textContent = badge;
        b.appendChild(n);
        b.setAttribute('aria-label', `${label}, ${t('eroscripts.tab.feeds.newCount', { count: badge })}`);
      }
      b.addEventListener('click', onClick);
      group.appendChild(b);
      return b;
    };
    chip(t('eroscripts.tab.feeds.all'), !this._feedId, () => this.openFeed(null));
    chip(t('eroscripts.tab.suggest.chip'), this._feedId === SUGGEST_ID, () => this.openFeed(SUGGEST_ID), '', 'es-feed--suggested').dataset.feedId = SUGGEST_ID;
    for (const feed of feeds) {
      const b = chip(feed.name, this._feedId === feed.id, () => this.openFeed(feed.id), badgeText(feed));
      b.dataset.feedId = feed.id;
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this._openFeedEditor(feed); });
    }
    // At the cap the chip stays, disabled, and says why (it used to vanish).
    const add = chip(t('eroscripts.tab.feeds.add'), false, () => { if (feeds.length < MAX_FEEDS) this._openFeedEditor(null); }, '', 'es-feed--add');
    if (feeds.length >= MAX_FEEDS) {
      add.disabled = true;
      add.title = t('eroscripts.tab.feeds.full', { max: MAX_FEEDS });
      add.setAttribute('aria-label', t('eroscripts.tab.feeds.full', { max: MAX_FEEDS }));
    }
    group.appendChild(this._feedsMoreParts().wrap);
    this._fitFeeds();
  }

  /**
   * The ▾ that takes the pills which do not fit, and its menu: built once
   * (their keys and the outside press are wired once), put back at the end
   * of the group on every render. Its width is watched: a resize fits again.
   */
  _feedsMoreParts() {
    if (this._feedsMore) return this._feedsMore;
    const wrap = document.createElement('div');
    wrap.className = 'es-feeds__more-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'es-feeds__more';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'es-feeds-menu');
    const label = document.createElement('span');
    label.className = 'es-feeds__more-name';
    btn.append(label, icon(ChevronDown, { width: 14, height: 14 }));
    const menu = document.createElement('div');
    menu.className = 'es-feeds__menu';
    menu.id = 'es-feeds-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    wrap.append(btn, menu);
    wrap.hidden = true;
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._setFeedsMenuOpen(menu.hidden); });
    wireMenuKeys(btn, menu, { close: () => this._setFeedsMenuOpen(false) });
    document.addEventListener('pointerdown', (e) => {
      if (menu.hidden || (e.target instanceof Node && wrap.contains(e.target))) return;
      this._setFeedsMenuOpen(false);
    }, true);
    if (typeof ResizeObserver === 'function' && this._feedsEl) {
      let lastWidth = -1;
      new ResizeObserver(() => {
        const w = this._feedsEl.clientWidth;
        if (w === lastWidth) return;
        lastWidth = w;
        this._fitFeeds();
      }).observe(this._feedsEl);
    }
    this._feedsMore = { wrap, btn, label, menu };
    return this._feedsMore;
  }

  _setFeedsMenuOpen(open) {
    const m = this._feedsMore;
    if (!m) return;
    m.menu.hidden = !open;
    m.btn.setAttribute('aria-expanded', String(open));
  }

  /**
   * The room the group has and what it uses; a method so a test can lay it
   * out (jsdom has no layout: 0 room shows every pill).
   */
  _measureFeeds() {
    const group = this._feedsEl?.querySelector('.es-feeds');
    return { room: this._feedsEl?.clientWidth || 0, used: group?.scrollWidth || 0 };
  }

  /**
   * Every pill on one line, or as many as fit with the ▾ in the last slot
   * and the rest in its menu, in order. The ▾ shows the open feed's name,
   * lit, when that feed is in the menu.
   */
  _fitFeeds() {
    const group = this._feedsEl?.querySelector('.es-feeds');
    const more = this._feedsMore;
    if (!group || !more) return;
    const pills = [...group.querySelectorAll(':scope > .es-feed')];
    for (const pill of pills) pill.hidden = false;
    this._setFeedsMenuOpen(false);
    more.wrap.hidden = true;
    const hidden = [];
    const paint = () => {
      const on = hidden.find((pill) => pill.classList.contains('es-feed--on'));
      more.btn.classList.toggle('es-feeds__more--on', !!on);
      more.label.textContent = on ? on.querySelector('.es-feed__name')?.textContent || '' : '';
      more.label.hidden = !on;
      more.btn.setAttribute('aria-label', t('eroscripts.tab.feeds.more', { count: hidden.length }));
      more.btn.title = more.btn.getAttribute('aria-label');
    };
    let { room, used } = this._measureFeeds();
    if (room > 0 && used > room) {
      more.wrap.hidden = false;
      // From the end: each pill that does not fit goes into the menu; "All
      // scripts" always stays.
      for (let i = pills.length - 1; i >= 1; i--) {
        pills[i].hidden = true;
        hidden.unshift(pills[i]);
        paint();
        ({ room, used } = this._measureFeeds());
        if (used <= room) break;
      }
    }
    paint();
    this._fillFeedsMenu(hidden);
  }

  /** The menu: the pills that did not fit, each doing what its pill does. */
  _fillFeedsMenu(hidden) {
    const menu = this._feedsMore?.menu;
    if (!menu) return;
    menu.replaceChildren(...hidden.map((pill) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'es-feeds__item';
      item.setAttribute('role', 'menuitemradio');
      const on = pill.classList.contains('es-feed--on');
      item.setAttribute('aria-checked', String(on));
      if (on) item.classList.add('es-feeds__item--on');
      if (pill.classList.contains('es-feed--add')) item.classList.add('es-feeds__item--add');
      item.disabled = pill.disabled;
      if (pill.title) item.title = pill.title;
      const name = pill.querySelector('.es-feed__name')?.textContent || '';
      const nameEl = document.createElement('span');
      nameEl.className = 'es-feeds__item-name';
      nameEl.textContent = name;
      item.appendChild(nameEl);
      const badge = pill.querySelector('.es-feed__badge');
      if (badge) item.appendChild(badge.cloneNode(true));
      if (pill.getAttribute('aria-label')) item.setAttribute('aria-label', pill.getAttribute('aria-label'));
      item.addEventListener('click', () => {
        this._setFeedsMenuOpen(false);
        pill.click();
      });
      // Right-click: the feed's editor, as on its pill.
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._setFeedsMenuOpen(false);
        pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      return item;
    }));
  }

  /**
   * Open a feed (null: All scripts). Its threads since it was last opened
   * carry New this time; the feed is marked as seen now, its badge cleared.
   */
  openFeed(id) {
    this._build();
    const feed = id === SUGGEST_ID ? this._suggestedFeed() : (id ? this._feeds().find((fd) => fd.id === id) : null);
    this._feedId = feed ? feed.id : null;
    this._feedSince = feed && !feed.suggested ? feed.lastSeenAt : null;
    if (feed && !feed.suggested) this._checker.update(feed.id, { lastSeenAt: new Date().toISOString(), newCount: 0, full: false });
    const input = this._panel?._panel?.querySelector?.('#es-search-input');
    if (input && feed) input.value = '';
    this._feedsChanged();
    this._paintToolbar();
    this._paintFilter();
    this._loadLatest(true);
  }

  /**
   * Refresh: load the open feed's newest threads now (or All scripts'), not
   * at the next 15-minute check. The threads that came in since the feed was
   * last seen keep their New (the same since-time as when it was opened);
   * the feed counts as seen again, its badge cleared.
   */
  refreshFeed() {
    if (!this._built || this._mode === 'search' || this._latest?.loading) return;
    const feed = this._openFeed();
    if (feed && !feed.suggested) this._checker.update(feed.id, { lastSeenAt: new Date().toISOString(), newCount: 0, full: false });
    if (feed && !feed.suggested) this._feedsChanged();
    this._loadLatest(true);
  }

  /** The Refresh button: shown on a list (a feed or All scripts), busy while it loads. */
  _paintRefresh() {
    const b = this._refreshBtn;
    if (!b) return;
    const feed = this._openFeed();
    b.hidden = this._mode === 'search';
    const busy = !!this._latest?.loading;
    b.disabled = busy;
    b.classList.toggle('es-view__refresh--busy', busy);
    b.setAttribute('aria-busy', String(busy));
    this._refreshLabel.textContent = t('eroscripts.tab.feeds.refresh');
    b.title = feed
      ? t('eroscripts.tab.feeds.refreshFeedTitle', { name: feed.name })
      : t('eroscripts.tab.feeds.refreshAllTitle');
  }

  /**
   * The feed window: new (filled in from what the tab shows now) or one to
   * change. Name, price, video / length / device, tags, words, notify.
   */
  _openFeedEditor(existing) {
    const now = Date.now();
    const draft = existing ? { ...existing } : normalizeFeed({
      id: newFeedId(now),
      price: this._priceFilter(),
      filters: this._filters(),
      tags: [],
      words: this._mode === 'search' ? (this._lastQuery || '') : '',
      createdAt: new Date(now).toISOString(),
    }, now);
    const label = (kind, v) => {
      if (kind === 'all') return t('eroscripts.tab.feeds.all');
      if (kind === 'price') return t(`eroscripts.tab.price.${v}`);
      if (kind === 'video') return t(`eroscripts.tab.fVideo.${v}`);
      if (kind === 'length') return t(`eroscripts.tab.len.${v.slice(4).replace(/-/g, '_')}`);
      return t(`eroscripts.tab.fDevice.${v}`);
    };
    // Suggestions: the tags on the threads loaded now, most used first.
    const counts = new Map();
    for (const tp of this._results || []) for (const tg of tp.tags || []) counts.set(tg, (counts.get(tg) || 0) + 1);
    const suggestions = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tg]) => tg).slice(0, 120);

    Modal.open({
      title: t(existing ? 'eroscripts.tab.feeds.editTitle' : 'eroscripts.tab.feeds.newTitle'),
      panelClass: 'es-dl-panel',
      initialFocus: (body) => body.querySelector('.es-feedform__name'),
      onRender: (body, resolve) => {
        const form = document.createElement('div');
        form.className = 'es-dl es-feedform';
        const rows = document.createElement('div');
        rows.className = 'es-dl__rows';
        const field = (labelText, el) => { rows.append(this._label(labelText), el); return el; };
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'eroscripts-panel__input es-feedform__name';
        name.maxLength = 80;
        name.value = existing ? existing.name : '';
        field(t('eroscripts.tab.feeds.name'), name);
        // Price
        const seg = document.createElement('div');
        seg.className = 'es-seg es-feedform__price';
        for (const v of ['all', 'free', 'paid']) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'es-seg__btn';
          b.dataset.value = v;
          b.textContent = t(`eroscripts.tab.filter.${v}`);
          b.addEventListener('click', () => { draft.price = v; paint(); });
          seg.appendChild(b);
        }
        field(t('eroscripts.tab.feeds.price'), seg);
        // Video / Length / Device
        const select = (k, options) => {
          const sel = document.createElement('select');
          sel.className = 'es-tool__select';
          sel.dataset.k = k;
          for (const [v, text] of options) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = text;
            sel.appendChild(o);
          }
          sel.value = draft.filters[k];
          sel.addEventListener('change', () => { draft.filters = { ...draft.filters, [k]: sel.value }; paint(); });
          return sel;
        };
        field(t('eroscripts.tab.tool.video'), select('video', ['any', 'vr', 'flat'].map((v) => [v, t(`eroscripts.tab.fVideo.${v}`)])));
        field(t('eroscripts.tab.tool.length'), select('length', [['any', t('eroscripts.tab.fLength.any')], ...LENGTH_TAGS.map((v) => [v, t(`eroscripts.tab.len.${v.slice(4).replace(/-/g, '_')}`)])]));
        field(t('eroscripts.tab.tool.device'), select('device', ['any', 'multi', 'handy'].map((v) => [v, t(`eroscripts.tab.fDevice.${v}`)])));
        // Tags: chips, with the forum's own tag suggestions as you type.
        const tagBox = document.createElement('div');
        tagBox.className = 'es-dl__value';
        const tagInput = new TagInput({
          tags: draft.tags || [],
          max: Math.max(0, MAX_TAGS - filterTags(draft.filters).length),
          placeholder: t('eroscripts.tab.feeds.tagsPlaceholder'),
          suggest: (q) => this._suggestTags(q, suggestions),
          exists: (tag) => this._tagExists(tag),
          onChange: (list) => { draft.tags = list; paint(); },
        });
        tagInput.el.classList.add('es-feedform__tags');
        const tagHint = this._p('es-dl__sub', t('eroscripts.tab.feeds.tagsHint'));
        tagBox.append(tagInput.el, tagHint);
        field(t('eroscripts.tab.feeds.tags'), tagBox);
        // Hide: threads with any of these tags stay out of the feed and its count (2026-11-23).
        const hideBox = document.createElement('div');
        hideBox.className = 'es-dl__value';
        const hideInput = new TagInput({
          tags: normalizeFilters(draft.filters).hide,
          max: MAX_HIDE_TAGS,
          placeholder: t('eroscripts.tab.fHide.placeholder'),
          suggest: (q) => this._suggestTags(q, suggestions),
          exists: (tag) => this._tagExists(tag),
          onChange: (list) => { draft.filters = { ...draft.filters, hide: list }; paint(); },
        });
        hideInput.el.classList.add('es-feedform__tags');
        hideBox.append(hideInput.el, this._p('es-dl__sub', t('eroscripts.tab.feeds.hideHint')));
        field(t('eroscripts.tab.fHide.label'), hideBox);
        // Words
        const words = document.createElement('input');
        words.type = 'text';
        words.className = 'eroscripts-panel__input es-feedform__words';
        words.value = draft.words || '';
        words.placeholder = t('eroscripts.tab.feeds.wordsHint');
        words.addEventListener('input', () => { draft.words = words.value; paint(); });
        field(t('eroscripts.tab.feeds.words'), words);
        // Notify
        const notifyRow = document.createElement('label');
        notifyRow.className = 'es-view__tube';
        const notify = document.createElement('input');
        notify.type = 'checkbox';
        notify.className = 'es-feedform__notify';
        notify.checked = draft.notify === true;
        notify.addEventListener('change', () => { draft.notify = notify.checked; });
        const nText = document.createElement('span');
        nText.textContent = t('eroscripts.tab.feeds.notify');
        notifyRow.append(notify, nText);
        form.append(rows, notifyRow);

        const problem = this._p('es-dl__sub es-dl__sub--bad es-feedform__problem', '');
        const actions = document.createElement('div');
        actions.className = 'es-dl__actions es-feedform__actions';
        if (existing) {
          const del = this._button(t('eroscripts.tab.feeds.delete'), 'secondary', async () => {
            const ok = await Modal.confirm(t('eroscripts.tab.feeds.deleteTitle', { name: existing.name }), t('eroscripts.tab.feeds.deleteMessage'), { confirmText: t('eroscripts.tab.feeds.delete') });
            if (!ok) return;
            this._set(SETTING_FEEDS, this._feeds().filter((fd) => fd.id !== existing.id));
            if (this._feedId === existing.id) this.openFeed(null);
            this._feedsChanged();
            resolve(null);
          });
          del.classList.add('es-feedform__delete');
          actions.appendChild(del);
        }
        const save = this._button(t('eroscripts.tab.feeds.save'), 'primary', () => {
          const stored = normalizeFeed({
            ...draft,
            name: name.value.trim() || defaultFeedName(normalizeFeed(draft), label),
            tags: draft.tags,
          });
          const list = this._feeds();
          const i = list.findIndex((fd) => fd.id === stored.id);
          // A changed feed counts again from now: what it shows has changed.
          const changed = existing && (existing.price !== stored.price || existing.words !== stored.words
            || feedTags(existing).join(',') !== feedTags(stored).join(','));
          if (changed) Object.assign(stored, { lastSeenAt: new Date().toISOString(), newCount: 0, full: false });
          if (i >= 0) list[i] = stored; else list.push(stored);
          this._set(SETTING_FEEDS, list);
          resolve(stored.id);
        });
        save.classList.add('es-dl__main', 'es-feedform__save');
        actions.appendChild(save);
        form.append(problem, actions);
        body.appendChild(form);

        const paint = () => {
          for (const b of seg.children) {
            const on = b.dataset.value === draft.price;
            b.classList.toggle('es-seg__btn--on', on);
            b.setAttribute('aria-pressed', String(on));
          }
          name.placeholder = defaultFeedName(normalizeFeed(draft), label);
          tagInput.setMax(Math.max(0, MAX_TAGS - filterTags(draft.filters).length));
          const total = filterTags(draft.filters).length + (draft.tags || []).filter((tg) => !filterTags(draft.filters).includes(tg)).length;
          const tooMany = total > MAX_TAGS;
          problem.textContent = tooMany ? t('eroscripts.tab.feeds.tooManyTags', { max: MAX_TAGS }) : '';
          save.disabled = tooMany;
        };
        paint();
      },
    }).then((savedId) => {
      if (!savedId) return;
      this._feedsChanged();
      this.openFeed(savedId);
    });
  }

  /**
   * Tags for what is typed: the forum's own suggestions (every tag a member
   * can use), with the tags on the threads loaded now as an instant answer
   * and the fallback when the forum cannot be asked.
   */
  async _suggestTags(query, local = []) {
    const q = String(query || '').trim().toLowerCase();
    const near = local.filter((tg) => tg.includes(q));
    let forum = [];
    try {
      const r = await window.funsync?.eroscriptsTagSearch?.(q);
      forum = (r?.tags || []).map((tg) => tg.name);
    } catch { forum = []; }
    return [...forum, ...near];
  }

  /** Is this a tag on the forum? true / false, null when it cannot be asked. */
  async _tagExists(tag) {
    this._tagKnown = this._tagKnown || new Map();
    if (this._tagKnown.has(tag)) return this._tagKnown.get(tag);
    let answer = null;
    try {
      const r = await window.funsync?.eroscriptsTagSearch?.(tag);
      if (r && !r.error) answer = (r.tags || []).some((tg) => tg.name === tag);
    } catch { answer = null; }
    if (answer !== null) this._tagKnown.set(tag, answer);
    return answer;
  }

  /** A check found more new threads in a feed set to notify. */
  _notifyFeed(feed, count) {
    if (typeof Notification !== 'function' || Notification.permission === 'denied') return;
    try {
      const n = new Notification(feed.name, { body: t('eroscripts.tab.feeds.notifyBody', { count }), silent: false, icon: APP_ICON });
      n.onclick = () => {
        try { window.focus(); } catch { /* */ }
        this._showTab();
        this.openFeed(feed.id);
      };
    } catch { /* no notifications here */ }
  }

  // --- several at once ---------------------------------------------------------

  _setSelecting(on) {
    this._selecting = !!on;
    if (!on) this._selected.clear();
    this._container.classList.toggle('es-view--selecting', this._selecting);
    this._paintToolbar();
    this._paintSelbar();
    this._repaintAll();
  }

  _toggleSelected(topic) {
    const id = String(topic.id);
    if (this._selected.has(id)) this._selected.delete(id);
    else this._selected.set(id, topic);
    this._paintSelbar();
    const entry = this._cards.get(id);
    if (entry) this._paintCard(entry);
  }

  _paintSelbar() {
    if (!this._selbar) return;
    const n = this._selected.size;
    this._selbar.hidden = !this._selecting;
    if (this._bulk) {
      this._selbar.querySelector('.es-view__selbar-text').textContent = t('eroscripts.tab.select.starting', { done: this._bulk.done, count: this._bulk.count });
    } else {
      this._selbar.querySelector('.es-view__selbar-text').textContent = t('eroscripts.tab.select.count', { count: n });
    }
    const go = this._selbar.querySelector('.es-view__selbar-go');
    go.textContent = t('eroscripts.tab.select.download', { count: n });
    go.disabled = n === 0 || !!this._bulk;
    this._selbar.querySelector('.es-view__selbar-cancel').textContent = t('common.cancel');
  }

  /**
   * The chosen cards, one after another (the forum is asked about each post
   * in turn, a little apart): each gets what its download window would offer
   * with one press: the best working link and the chosen script, or the
   * script alone. Ones with nothing to download are counted and said.
   */
  async _downloadSelected() {
    const topics = [...this._selected.values()];
    if (!topics.length || this._bulk) return;
    this._bulk = { done: 0, count: topics.length };
    this._paintSelbar();
    let started = 0;
    let skipped = 0;
    for (const topic of topics) {
      if (this._bulk.done > 0) await new Promise((r) => setTimeout(r, QUICK_GAP_MS));
      let outcome = 'none';
      try { outcome = await this._quickDownload(topic); } catch { outcome = 'none'; }
      if (outcome === 'none') skipped += 1;
      else started += 1;
      this._bulk.done += 1;
      this._paintSelbar();
    }
    this._bulk = null;
    showToast(skipped
      ? t('eroscripts.tab.select.summarySkipped', { started, skipped })
      : t('eroscripts.tab.select.summary', { started }), skipped ? 'warn' : 'success');
    this._setSelecting(false);
  }

  /** One post, no window: 'video' | 'script' | 'none'. */
  async _quickDownload(topic) {
    const p = { topic, loading: true };
    await this._loadPost(p);
    if (p.failed || !p.links) return 'none';
    const script = p.scripts[p.scriptIndex] || null;
    const best = pickBestLink(p.links, { tube: this._get(SETTING_TUBE) === true, title: p.answer?.title || topic.title, scriptName: script?.name, creator: creatorOf(p) });
    if (best) return (await this._download(p, best, null)) ? 'video' : 'none';
    if (script) return (await this._saveScriptOnly(p, script, null)) ? 'script' : 'none';
    return 'none';
  }

  // --- free space ----------------------------------------------------------------

  /**
   * "51 GB free", or a warning when a download of `size` bytes will not fit
   * (it then calls `onShort`, which disables the download button). The
   * backend refuses one that does not fit too (noSpace).
   */
  _spaceLine(size, onShort) {
    const line = this._p('es-dl__sub es-dl__space', '');
    const dir = this._destFolder();
    if (!dir) return line;
    const show = (free, margin) => {
      if (!Number.isFinite(free)) return;
      if (size > 0 && free < size + (margin || 0)) {
        line.textContent = t('eroscripts.tab.space.short', { need: formatBytes(size), free: formatBytes(free) });
        line.classList.add('es-dl__sub--bad');
        onShort?.();
      } else {
        line.textContent = size > 0
          ? t('eroscripts.tab.space.fits', { size: formatBytes(size), free: formatBytes(free) })
          : t('eroscripts.tab.space.free', { free: formatBytes(free) });
      }
    };
    const cached = this._spaceCache.get(dir);
    if (cached && Date.now() - cached.at < 10000) { show(cached.free, cached.margin); return line; }
    this._fetchJson(`/space?dir=${encodeURIComponent(dir)}`).then((r) => {
      if (!r.ok || !Number.isFinite(r.body?.free)) return;
      this._spaceCache.set(dir, { free: r.body.free, margin: r.body.margin || 0, at: Date.now() });
      show(r.body.free, r.body.margin || 0);
    }).catch(() => {});
    return line;
  }

  _buildFilter() {
    const seg = document.createElement('div');
    seg.className = 'es-seg';
    seg.setAttribute('role', 'radiogroup');
    for (const value of ['all', 'free', 'paid']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'es-seg__btn';
      b.dataset.value = value;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this._setPriceFilter(value));
      seg.appendChild(b);
    }
    return seg;
  }

  _priceFilter() { return normalizePriceFilter(this._get(SETTING_PRICE)); }

  _setPriceFilter(value) {
    if (this._feedId) return;
    if (value === this._priceFilter()) return;
    this._set(SETTING_PRICE, value);
    this._paintFilter();
    if (this._mode === 'search') this._panel?.search?.();
    else this._loadLatest(true);
  }

  // --- the newest script threads (nothing searched) ---------------------------

  /**
   * Dave, 2026-11-22: "as well as a search functionality it should by default
   * just show the most recent threads ... free or paid, as long as they are
   * marked as scripts". All / Free / Paid picks the list; Show more adds the
   * next page. Logged in only (the forum hides its script categories).
   */
  async _loadLatest(reset) {
    if (!this._built) return;
    const feed = this._openFeed();
    const price = feed ? feed.price : this._priceFilter();
    if (reset) {
      this._mode = 'latest';
      this._latest = { price, page: 0, more: false, results: [] };
      this._renderCards([], { latest: true });
    }
    const st = this._latest;
    if (!st || st.loading) return;
    st.loading = true;
    this._paintRefresh();
    const token = (this._latestToken = (this._latestToken || 0) + 1);
    this._moreBtn.disabled = true;
    if (reset) {
      this._note(t('eroscripts.tab.latest.loading'));
      // Card-shaped placeholders while the first page loads (2026-11-23):
      // Modern shows them, Classic keeps the line alone (eroscripts.css).
      if (this._viewMode() !== 'list') this._grid.append(...this._skeletons(10));
    }
    let answer = null;
    const opts = { ...sortParams(this._sort()), tags: filterTags(this._filters()) };
    try {
      if (feed?.suggested) {
        // Suggested: the newest posts with ANY of the library's taste tags;
        // what the user has, the other format, Hide, Not interested left out.
        if (reset || !this._suggest) this._suggest = await this._computeSuggest();
        const sg = this._suggest;
        if (!sg.tags.length) answer = { results: [], more: false };
        else {
          answer = await window.funsync.eroscriptsLatest?.('all', st.page, { sort: 'newest', period: 'all', tags: sg.tags.map((x) => x.tag), anyTags: true });
          if (answer && !answer.error) {
            const ctx = { tags: sg.tags, avoid: sg.avoid, format: sg.format, hide: this._filters().hide, dismissed: readDismissed(this._settings), have: (tp) => this._haveTopic(tp) };
            this._libMap = libraryByTopic(this._get('library.scriptTags'));
            answer = { ...answer, results: (answer.results || []).filter((tp) => passesSuggested(tp, ctx)) };
          }
        }
      } else if (feed) {
        // A feed: its newest threads (a search when it has words).
        const req = feedRequest(feed);
        answer = req.kind === 'search'
          ? await window.funsync.eroscriptsSearch?.(req.query, st.page + 1)
          : await window.funsync.eroscriptsLatest?.(req.price, st.page, req.opts);
        if (answer && !answer.error) {
          const raw = (answer.results || []).length;
          answer = { ...answer, results: (answer.results || []).filter((tp) => inFeed(tp, feed)) };
          // A search page is full at 50: more pages while the forum fills them.
          if (req.kind === 'search') answer.more = raw >= FEED_SEARCH_PAGE;
        }
      } else {
        answer = await window.funsync.eroscriptsLatest?.(price, st.page, opts);
      }
    } catch { answer = null; }
    // A search (or another list) took over meanwhile: this answer is dropped.
    if (token !== this._latestToken || this._latest !== st || this._mode !== 'latest') { st.loading = false; this._paintRefresh(); return; }
    for (const sk of this._grid.querySelectorAll('.es-skel')) sk.remove();
    st.loading = false;
    this._paintRefresh();
    this._moreBtn.disabled = false;
    if (!answer || answer.error) {
      if (answer?.authExpired) this._panel?.handleSessionExpired?.();
      if (!st.results.length) this._note(t(answer?.loginRequired || answer?.authExpired ? 'eroscripts.tab.latest.loginNeeded' : 'eroscripts.tab.latest.failed'));
      this._moreBtn.hidden = true;
      return;
    }
    const seen = new Set(st.results.map((r) => r.id));
    // Hidden tags are left out here (the forum's list cannot leave several out);
    // a feed's page was checked above (inFeed). A page that is all hidden shows
    // nothing and the next one loads as the More button comes into view.
    const keep = feed ? () => true : (r) => passesHidden(r, this._filters());
    const fresh = (answer.results || []).filter((r) => r && !seen.has(r.id) && keep(r));
    st.results.push(...fresh);
    st.page += 1;
    st.more = answer.more === true;
    this._results = st.results;
    this._emptyEl.hidden = true;
    this._libMap = libraryByTopic(this._get('library.scriptTags'));
    if (feed?.suggested) { this._paintSuggestBar(); this._paintToolbar(); }
    for (const topic of fresh) this._grid.appendChild(this._item(topic));
    if (!st.results.length) {
      if (feed?.suggested) this._note(t(this._suggest?.tags?.length ? 'eroscripts.tab.suggest.nothingHere' : 'eroscripts.tab.suggest.none'));
      else this._note(t(anyFilterOrHide(this._filters()) ? 'eroscripts.tab.filter.noneTags' : 'eroscripts.tab.latest.none'));
    }
    this._moreBtn.hidden = !st.more;
  }

  /** Card-shaped placeholders (not .es-card: nothing counts them as threads). */
  _skeletons(n) {
    return Array.from({ length: n }, (_, i) => {
      const sk = document.createElement('div');
      sk.className = 'es-skel';
      sk.setAttribute('aria-hidden', 'true');
      sk.style.setProperty('--es-skel-i', String(i));
      const plate = document.createElement('div');
      plate.className = 'es-skel__thumb';
      const a = document.createElement('div');
      a.className = 'es-skel__line';
      const b = document.createElement('div');
      b.className = 'es-skel__line es-skel__line--short';
      sk.append(plate, a, b);
      return sk;
    });
  }

  _note(text) {
    this._emptyEl.textContent = text;
    this._emptyEl.hidden = !text;
  }

  /** The login changed (the app tells it): the newest list when it shows nothing yet. */
  onLoginChanged(loggedIn) {
    // The card checks wait while signed out, and carry on with the same
    // posts after a sign-in (B029).
    this._probe?.loginChanged?.(loggedIn);
    // Feeds are checked whether or not the tab is open.
    if (loggedIn) {
      this._checker.start();
      this._checker.checkIfStale().catch(() => {});
    } else {
      this._checker.stop();
    }
    if (!this._visible || this._mode === 'search') return;
    if (loggedIn && !(this._latest?.results?.length)) this._loadLatest(true);
  }

  _paintFilter() {
    const feed = this._openFeed?.();
    const current = feed ? feed.price : this._priceFilter();
    this._filterEl.setAttribute('aria-label', t('eroscripts.tab.filter.label'));
    for (const b of this._filterEl.children) {
      const on = b.dataset.value === current;
      b.textContent = t(`eroscripts.tab.filter.${b.dataset.value}`);
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('es-seg__btn--on', on);
      b.disabled = !!feed;
    }
  }

  _paintStatic() {
    const c = this._container;
    c.querySelector('.es-view__h').textContent = t('eroscripts.tab.downloadsHeading');
    c.querySelector('.es-view__clear').textContent = t('eroscripts.tab.clearFinished');
    this._pasteBtn.setAttribute('aria-label', t('eroscripts.tab.paste.button'));
    this._pasteBtn.title = t('eroscripts.tab.paste.title');
    this._paintAccount();
    this._paintToolbar();
    this._paintSelbar();
    this._paintFilter();
    this._paintDownloadsButton();
  }

  get visible() { return this._visible; }

  /** The library's links to posts, read again, and every card painted from them. */
  _refreshLibMap() {
    this._libMap = libraryByTopic(this._get('library.scriptTags'));
    this._repaintAll();
  }

  show() {
    this._build();
    this._visible = true;
    this._probe?.resume();   // the card checks carry on (paused while hidden)
    // Links made while the tab was hidden (B009).
    this._refreshLibMap();
    if (this._panel) {
      this._panel.onResults = (results, kind) => {
        if (results) {
          if (this._feedId) { this._feedId = null; this._renderFeeds(); this._paintToolbar(); this._paintFilter(); }
          this._mode = 'search';
          this._search = { query: this._lastQuery || '', page: 1, more: results.length >= SEARCH_PAGE, results: [...results], loading: false };
          this._paintRefresh();
          this._renderCards(results);
          this._moreBtn.hidden = !this._search.more;
        }
        else if (kind === 'placeholder') this._loadLatest(true);       // nothing searched
        else { this._mode = 'search'; this._search = null; this._paintRefresh(); this._renderCards(null); }       // searching, nothing found, log in
      };
      // The search box emptied: back to the newest threads.
      this._panel.onQueryCleared = () => { if (this._mode !== 'latest') this._loadLatest(true); };
      this._panel.queryDecorator = (q) => { this._lastQuery = q; return this._decorate(q); };
      this._panel.dock(this._searchHost, { searchExtras: this._filterEl });
      this._panel.show();
    }
    this._refreshJobs();
    this._renderFeeds();
    this._checker.checkIfStale().catch(() => {});
    // Nothing searched yet: the newest script threads.
    if (!this._mode) this._loadLatest(true);
  }

  hide() {
    this._visible = false;
    // No forum requests for cards nobody is looking at (test day 2026-11-24).
    this._probe?.pause();
    this._toggleDownloads(false);
    if (this._panel) {
      this._panel.onResults = null;
      this._panel.onQueryCleared = null;
      this._panel.queryDecorator = null;
      this._panel.undock();
    }
    // Downloads keep running in the backend; the list is read again on show.
    if (!this._jobs.some((j) => this._active(j))) this._stopPolling();
  }

  // --- cards ----------------------------------------------------------------

  _renderCards(results, { latest = false } = {}) {
    this._results = results;
    this._cards.clear();
    this._probe?.clearQueue();
    this._grid.replaceChildren();
    const list = this._viewMode() === 'list';
    this._grid.classList.toggle('es-grid--list', list);
    if (list && (latest || (results && results.length))) this._grid.appendChild(this._listHead());
    this._emptyEl.hidden = true;
    this._moreBtn.hidden = true;
    this._headingEl.hidden = !latest;
    if (this._suggestBarEl && this._feedId !== SUGGEST_ID) this._suggestBarEl.hidden = true;
    const openFeed = this._openFeed();
    if (latest) this._headingEl.textContent = openFeed ? openFeed.name : t(`eroscripts.tab.${this._sort() === 'newest' ? 'latest' : 'top'}.${this._priceFilter()}`);
    this._libMap = libraryByTopic(this._get('library.scriptTags'));
    if (!results || latest) return;
    const filter = this._priceFilter();
    const filters = this._filters();
    const shown = results.filter((r) => matchesPrice(r, filter) && matchesFilters(r, filters));
    if (!shown.length) {
      this._emptyEl.textContent = filter === 'all'
        ? t('eroscripts.tab.filter.noneTags')
        : t(`eroscripts.tab.filter.none.${filter === 'paid' ? 'paid' : 'free'}`);
      this._emptyEl.hidden = false;
      return;
    }
    for (const topic of shown) this._grid.appendChild(this._item(topic));
  }

  _card(topic) {
    const card = document.createElement('div');
    card.className = 'es-card';
    card.setAttribute('role', 'listitem');
    card.dataset.topicId = String(topic.id);

    const thumb = document.createElement('div');
    thumb.className = 'es-card__thumb';
    // Under the picture: the logo tile a post without one shows (the
    // library's no-video look, 2026-11-23). Modern shows it; Classic keeps
    // its plain dark plate (eroscripts.css hides it).
    const noThumb = document.createElement('div');
    noThumb.className = 'es-card__nothumb';
    noThumb.setAttribute('aria-hidden', 'true');
    thumb.appendChild(noThumb);
    const img = createResultThumb({ thumbnail: topic.thumbnail, avatar: topic.avatar, className: 'es-card__img' });
    thumb.appendChild(img);
    if (!topic.thumbnail && topic.id) {
      window.funsync?.eroscriptsTopicImage?.(topic.id).then((url) => {
        if (url) { img.src = url; img.style.display = ''; }
      }).catch(() => {});
    }
    const price = priceOf(topic.categoryId);
    if (price) {
      const chip = document.createElement('span');
      chip.className = `es-card__price es-card__price--${price}`;
      chip.textContent = t(`eroscripts.tab.price.${price}`);
      thumb.appendChild(chip);
    }
    // VR or 2D, length, multi-axis: from the thread's own tags.
    const ct = cardTags(topic.tags);
    const chips = [];
    const isNew = !!this._feedId && !!this._feedSince && Date.parse(topic.createdAt) > Date.parse(this._feedSince);
    if (isNew) chips.push(t('eroscripts.tab.feeds.new'));
    if (ct.video) chips.push(t(`eroscripts.tab.chip.${ct.video}`));
    if (ct.length) chips.push(t(`eroscripts.tab.len.${ct.length.slice(4).replace(/-/g, '_')}`));
    if (ct.multi) chips.push(t('eroscripts.tab.chip.multi'));
    if (chips.length) {
      const row = document.createElement('div');
      row.className = 'es-card__tags';
      for (const [i, text] of chips.entries()) {
        const chip = document.createElement('span');
        chip.className = isNew && i === 0 ? 'es-chip es-chip--new' : 'es-chip';
        chip.textContent = text;
        row.appendChild(chip);
      }
      thumb.appendChild(row);
    }
    // Picking several: a round tick in the corner.
    const check = document.createElement('span');
    check.className = 'es-card__check';
    check.setAttribute('aria-hidden', 'true');
    check.appendChild(icon(Check, { width: 14, height: 14, 'stroke-width': 3 }));
    thumb.appendChild(check);
    const progress = document.createElement('div');
    progress.className = 'es-card__progress';
    progress.hidden = true;
    const fill = document.createElement('div');
    fill.className = 'es-card__progress-fill';
    progress.appendChild(fill);
    thumb.appendChild(progress);

    const info = document.createElement('div');
    info.className = 'es-card__info';
    const title = document.createElement('div');
    title.className = 'es-card__title';
    title.textContent = topic.title;
    title.title = topic.title;
    const meta = document.createElement('div');
    meta.className = 'es-card__meta';
    meta.textContent = [topic.creator ? `@${topic.creator}` : '', topic.likeCount > 0 ? t('eroscripts.likes', { count: topic.likeCount }) : '']
      .filter(Boolean).join(' · ');
    // Video and Script, each on its own (Dave: "an indicator that the video
    // is downloaded and the funscript downloaded separately").
    const status = document.createElement('div');
    status.className = 'es-card__status';
    status.hidden = true;
    const foot = document.createElement('div');
    foot.className = 'es-card__foot';
    const parts = document.createElement('div');
    parts.className = 'es-card__parts';
    const videoPart = this._part(Clapperboard, t('eroscripts.tab.card.video'), 'video');
    const scriptPart = this._part(FileText, t('eroscripts.tab.card.script'), 'script');
    parts.append(videoPart, scriptPart);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eroscripts-panel__btn es-card__btn';
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._cardAction(topic, btn); });
    foot.append(parts, btn);
    info.append(title, meta, status, foot);
    const why = this._whyLine(topic);
    if (why) info.insertBefore(why, status);
    card.append(thumb, info);

    // The card itself opens the download window (the button may say Play);
    // while picking several, it is picked.
    card.addEventListener('click', () => {
      if (this._selecting) this._toggleSelected(topic);
      else this.openPost(topic);
    });

    const entry = { topic, card, els: { progress, fill, status, btn, videoPart, scriptPart } };
    this._cards.set(String(topic.id), entry);
    this._probe?.enqueue([topic.id]);
    this._paintCard(entry);
    return card;
  }

  _done() {
    const v = this._get(SETTING_DONE);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  _markDone(topicId, patch) {
    const all = { ...this._done() };
    all[topicId] = { ...(all[topicId] || {}), ...patch, at: Date.now() };
    this._set(SETTING_DONE, all);
  }

  /** Is a recorded file still there? Asked once per path; the card repaints. */
  /** These files were deleted: what was known of them is dropped, the cards painted again. */
  filesDeleted(paths) {
    if (!Array.isArray(paths) || !paths.length) return;
    const fold = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
    const gone = new Set(paths.map(fold));
    for (const key of [...this._exists.keys()]) if (gone.has(fold(key))) this._exists.delete(key);
    this._libMap = libraryByTopic(this._get('library.scriptTags'));
    if (this._built) this._repaintAll();
  }

  _present(path) {
    if (!path) return false;
    // "There" is kept; "not there" is asked again after 30 s (a drive that was
    // asleep or unplugged at the first look used to stay grey all session).
    const known = this._exists.get(path);
    if (known === true) return true;
    if (known && Date.now() - known.at < 30000) return false;
    if (!this._checking.has(path) && window.funsync?.fileExists) {
      this._checking.add(path);
      window.funsync.fileExists(path).then((yes) => {
        this._exists.set(path, yes === true ? true : { at: Date.now() });
      }).catch(() => {
        this._exists.set(path, { at: Date.now() });
      }).finally(() => {
        this._checking.delete(path);
        this._repaintAll();
      });
    }
    return false;
  }

  _jobForTopic(topicId) {
    let found = null;
    for (const job of this._jobs) {
      if (String(this._jobInfo.get(job.id)?.topicId) === String(topicId)) found = job;
    }
    return found;
  }

  _cardState(topicId) {
    // This tab's own record first, then what the library already has from the
    // post (a Get Script, an Associate search, an older download: its tag
    // record names the post).
    const done = this._done()[topicId] || {};
    const lib = this._libMap.get(Number(topicId)) || [];
    // A library video linked to THIS post (its EroScripts tag record names the
    // post) means you have it, on a drive that is connected or not (Dave,
    // 2026-11-23: "if a user has gone in and linked it to an eroscripts post
    // for the tags, its safe to say theyve got it"). Only this tab's own
    // download is still asked about on disk: you may have deleted it since.
    const linked = lib.map((l) => l.video).filter(Boolean);
    // The first of them on disk, else the first linked one, else this tab's record.
    const pick = (list) => list.find((p) => p && this._present(p)) || null;
    const video = pick([done.video, ...linked]) || linked[0] || done.video || null;
    const rec = { ...done, video, script: pick([done.script, ...lib.map((l) => l.script)]) || done.script || lib.map((l) => l.script).find(Boolean) || null };
    const job = this._jobForTopic(topicId);
    return {
      rec,
      job,
      active: !!job && this._active(job),
      paused: !!job && job.status === 'paused',
      failed: !!job && job.status === 'error',
      resumable: !!job && job.resumable === true,
      haveVideo: linked.includes(rec.video) || this._present(rec.video),
      haveScript: this._present(rec.script) || (linked.includes(rec.video) && lib.some((l) => l.script === rec.script)),
    };
  }

  _paintCard(entry) {
    const { topic, card, els } = entry;
    const s = this._cardState(topic.id);
    card.classList.toggle('es-card--have', s.haveVideo);
    card.classList.toggle('es-card--busy', s.active);
    card.classList.toggle('es-card--failed', s.failed && !s.active);
    card.classList.toggle('es-card--selected', this._selecting && this._selected.has(String(topic.id)));
    const partway = s.active || s.paused || (s.failed && s.resumable);
    els.progress.hidden = !partway;
    els.progress.classList.toggle('es-card__progress--paused', !s.active);
    const pct = s.job && s.job.total ? Math.min(100, Math.round((s.job.bytes / s.job.total) * 100)) : 0;
    els.fill.style.width = `${pct}%`;

    // The status line: only while downloading, paused, or after a failure.
    const line = (s.active || s.paused) ? this._statusText(s.job, pct) : (s.failed && !s.haveVideo ? errorText(s.job.error) : '');
    els.status.textContent = line;
    els.status.title = line;
    els.status.hidden = !line;
    const videoState = s.haveVideo ? 'done' : (s.active ? 'busy' : (s.paused ? 'paused' : 'missing'));
    // What the post offers (eroscripts-probe.js): "none" when it has no
    // video link this build can download, or no script file.
    const info = this._probe?.get(topic.id) || null;
    // Only on a tube site: a download with the Tube sites switch on, else "none".
    const tubeOn = this._get(SETTING_TUBE) === true;
    const noVideo = !!info && !info.video && !(info.tube && tubeOn) && videoState === 'missing';
    const noScript = !!info && !info.script && !info.pack && !s.haveScript;
    this._paintPart(els.videoPart, noVideo ? 'none' : videoState, 'video', (s.active || s.paused) && pct ? `${pct}%` : '');
    this._paintPart(els.scriptPart, s.haveScript ? 'done' : (noScript ? 'none' : 'missing'), 'script', '');
    // The Download filter: a post known not to offer it is hidden (unless you have it).
    card.hidden = !s.haveVideo && !s.active && !passesNeed(info, this._need(), { tube: tubeOn });

    const b = els.btn;
    const resume = !s.haveVideo && (s.paused || (s.failed && s.resumable));
    b.classList.toggle('eroscripts-panel__btn--secondary', s.active || (s.failed && !s.haveVideo && !s.resumable));
    if (s.active) b.textContent = t('eroscripts.tab.card.pause');
    else if (resume) b.textContent = t('eroscripts.tab.card.resume');
    else if (s.haveVideo) b.textContent = t('eroscripts.tab.card.play');
    else if (s.failed) b.textContent = t('eroscripts.tab.card.tryAnother');
    else b.textContent = t('eroscripts.tab.card.download');
    b.hidden = this._selecting;
    b.setAttribute('aria-label', `${b.textContent}: ${topic.title}`);
    this._fitParts(entry);
  }

  /**
   * Video and Script as icons only when their words do not fit beside the
   * button (a narrow card, a long button word such as German's
   * "Herunterladen"): the chips' row clipped "Script" to "Scrip" under the
   * Download button (Dave, 2026-11-26). Measured, not a fixed width, so it
   * holds in every language; the words stay each chip's title and label,
   * and the state still shows (struck through, accent, green with a tick).
   * @param {{els: {videoPart: HTMLElement}}} entry
   */
  _fitParts(entry) {
    const parts = entry?.els?.videoPart?.parentElement;
    if (!parts) return;
    // Measured again only when what decides it changed: a chip's words, the
    // button's word, the grid's width, the card shown or hidden. Every
    // download poll repaints every card (1 s): measuring 60 cards then forced
    // 60 layouts a second.
    const sig = [entry.els.videoPart.textContent, entry.els.scriptPart?.textContent, entry.els.btn?.textContent, this._gridWidth || 0, entry.card?.hidden].join('|');
    if (entry._fitSig === sig) return;
    // Painted before it is in the grid (a new card is painted, then added):
    // measured on the next frame. A card hidden by a filter is fitted by the
    // paint that shows it again.
    if (!parts.isConnected || parts.clientWidth === 0) {
      if (!entry._fitQueued && typeof requestAnimationFrame === 'function') {
        entry._fitQueued = true;
        requestAnimationFrame(() => {
          entry._fitQueued = false;
          if (parts.isConnected && parts.clientWidth > 0) this._fitParts(entry);
        });
      }
      return;
    }
    parts.classList.remove('es-card__parts--compact');
    if (parts.scrollWidth > parts.clientWidth + 1) parts.classList.add('es-card__parts--compact');
    entry._fitSig = sig;
  }

  _part(iconDef, label, kind) {
    const span = document.createElement('span');
    span.className = `es-part es-part--${kind}`;
    span.setAttribute('role', 'img');
    const ic = document.createElement('span');
    ic.className = 'es-part__icon es-part__icon--type';
    ic.appendChild(icon(iconDef, { width: 12, height: 12, 'stroke-width': 2.2 }));
    const done = document.createElement('span');
    done.className = 'es-part__icon es-part__icon--done';
    done.appendChild(icon(Check, { width: 12, height: 12, 'stroke-width': 3 }));
    const text = document.createElement('span');
    text.className = 'es-part__text';
    text.textContent = label;
    span.append(ic, done, text);
    return span;
  }

  /** One part's state: 'missing' | 'busy' | 'done'; its words as the title. */
  _paintPart(el, state, kind, extra) {
    el.classList.toggle('es-part--done', state === 'done');
    el.classList.toggle('es-part--busy', state === 'busy' || state === 'paused');
    el.dataset.state = state;
    el.querySelector('.es-part__text').textContent = t(`eroscripts.tab.card.${kind}`) + (extra ? ` ${extra}` : '');
    const words = t(`eroscripts.tab.card.${kind}State.${state}`);
    el.title = words;
    el.setAttribute('aria-label', words);
  }

  _tick(label) {
    const span = document.createElement('span');
    span.className = 'es-card__have';
    span.appendChild(icon(Check, { width: 12, height: 12, 'stroke-width': 3 }));
    span.appendChild(document.createTextNode(label));
    return span;
  }

  _repaintAll() {
    for (const entry of this._cards.values()) this._paintCard(entry);
  }

  async _cardAction(topic, btn) {
    const s = this._cardState(topic.id);
    if (s.active) { await this._jobAction(s.job, 'pause', btn); return; }
    if (!s.haveVideo && (s.paused || (s.failed && s.resumable))) { await this._jobAction(s.job, 'resume', btn); return; }
    if (s.haveVideo && this._playPath(s.rec.video)) return;
    this.openPost(topic);
  }

  // --- the download window --------------------------------------------------

  /** A result's Download (or "Videos…" from the floating panel). */
  openPost(topic) {
    this._build();
    if (this._dl) this._dl.close();
    const state = { topic, loading: true };
    Modal.open({
      title: topic.title || '',
      panelClass: 'es-dl-panel',
      onRender: (body, resolve) => {
        this._dl = { body, close: () => resolve(null), post: state };
        this._renderDl();
        this._loadPost(state);
      },
    }).then(() => { if (this._dl?.post === state) this._dl = null; });
  }

  async _loadPost(p) {
    let answer = null;
    try { answer = await window.funsync.eroscriptsTopic(p.topic.id, { replies: true }); } catch { answer = null; }
    if (!answer || answer.error) {
      if (answer?.authExpired) this._panel?.handleSessionExpired?.();
      Object.assign(p, { loading: false, failed: true, answer });
      this._renderDl(p);
      return;
    }
    const postLinks = (answer.links || []).map((l) => ({ ...l, from: 'post' }));
    const replyLinks = (answer.replyLinks || []).map((l) => ({ ...l, from: 'reply' }));
    const all = [...postLinks, ...replyLinks];
    let classified = [];
    if (all.length) {
      try {
        const r = await this._fetchJson('/classify', { method: 'POST', body: JSON.stringify({ links: all.map((l) => l.url) }) });
        classified = r.body?.links || [];
      } catch { classified = []; }
    }
    const links = all.map((l, i) => ({ ...l, ...(classified[i] || { kind: 'unsupported', host: '', supported: false }), url: l.url }));
    const built = buildScriptChoices(answer.attachments || [], answer.replyScripts || [], answer.creator || p.topic.creator, scriptChoices);
    const scripts = built.choices;
    Object.assign(p, {
      loading: false, answer, links, scripts, scriptIndex: built.index,
      // A video length the post states ("Duration: 43:16"), for the length check.
      stated: statedDuration(postPlainText(answer.post?.cooked || '')),
      checking: links.some((l) => l.supported),
    });
    this._renderDl(p);
    if (!p.checking) return;
    // Gofile (2026-11-24): the backend cannot look; the app's own window can.
    // Its answer (working or gone, the file's name and size) is the link's check.
    const gofiles = links.filter((l) => l.supported && l.host === 'gofile').slice(0, 2);
    const gofileChecks = gofiles.map((l) => this._gofile(l, scripts[built.index]?.name || '').then((g) => {
      if (g?.ok) l.check = { url: l.url, status: 'ok', size: g.size || 0, name: g.name || '' };
      else if (g?.error === 'notFound') l.check = { url: l.url, status: 'dead', size: 0, name: '' };
    }));
    // Which links still work (Dave: "there should be an indicator").
    try {
      const r = await this._fetchJson('/check', { method: 'POST', body: JSON.stringify({ links: links.filter((l) => l.supported).map((l) => l.url) }) });
      const byUrl = new Map((r.body?.links || []).map((c) => [c.url, c]));
      for (const l of links) if (byUrl.has(l.url) && l.host !== 'gofile') l.check = byUrl.get(l.url);
    } catch { /* every link stays "not checked" */ }
    await Promise.all(gofileChecks);
    p.checking = false;
    this._renderDl(p);
  }

  /**
   * A tag in a post's window, clicked (Dave, 2026-11-25): the posts with that
   * tag, as a tag link on the forum. All scripts, no search; the Video /
   * Length / Device choice the tag stands for, or the Tags filter with that
   * one tag; your Hide tags and the Download choice stay. The chips under the
   * bar show what is set, each one × away.
   */
  _showTag(tag) {
    const name = String(tag || '').trim().toLowerCase();
    if (!name) return;
    this._dl?.close();
    const next = { ...this._filters(), video: 'any', length: 'any', device: 'any', tags: [] };
    const video = Object.keys(VIDEO_FILTERS).find((k) => VIDEO_FILTERS[k] === name);
    const device = Object.keys(DEVICE_FILTERS).find((k) => DEVICE_FILTERS[k] === name);
    if (video) next.video = video;
    else if (LENGTH_TAGS.includes(name)) next.length = name;
    else if (device) next.device = device;
    else next.tags = [name];
    this._set(SETTING_FILTERS, normalizeFilters(next));
    this._panel?.clearQuery?.();
    this._feedId = null;
    this._feedSince = null;
    this._feedsChanged();
    this._paintToolbar();
    this._paintFilter();
    if (this._body) this._body.scrollTop = 0;
    this._loadLatest(true);
  }

  /**
   * A post's tag names, each once: its own answer's when it has them, else the
   * list's. The answer (main's eroscriptsTopic, `parseTopicMeta`) gives each
   * tag as `{id, name}` and the lists give names: String() of the object put
   * "[object Object]" in the post window (Dave, 2026-11-26), and the
   * multi-axis check below never matched.
   */
  _postTags(p) {
    const name = (x) => String((x && typeof x === 'object') ? (x.name ?? '') : (x ?? '')).trim();
    const own = Array.isArray(p.answer?.tags) && p.answer.tags.length ? p.answer.tags : null;
    const list = own || (Array.isArray(p.topic?.tags) ? p.topic.tags : []);
    return [...new Set(list.map(name).filter(Boolean))];
  }

  /** A Gofile link, resolved by the app (one hidden window; main keeps the answer 10 min). */
  async _gofile(link, hint = '') {
    try { return await window.funsync?.gofileResolve?.(link.url, hint); } catch { return { error: 'failed' }; }
  }

  _renderDl(p = this._dl?.post) {
    const dl = this._dl;
    if (!dl || dl.post !== p) return;
    const el = dl.body;
    el.replaceChildren();
    const box = document.createElement('div');
    box.className = 'es-dl';
    el.appendChild(box);

    const head = document.createElement('div');
    head.className = 'es-dl__head';
    const price = priceOf(p.answer?.categoryId ?? p.topic.categoryId);
    if (price) {
      const chip = document.createElement('span');
      chip.className = `es-card__price es-card__price--${price} es-dl__price`;
      chip.textContent = t(`eroscripts.tab.price.${price}`);
      head.appendChild(chip);
    }
    const creator = p.answer?.creator || p.topic.creator;
    if (creator) head.appendChild(this._p('es-dl__creator', `@${creator}`));
    const openPost = this._button(t('eroscripts.tab.openPost'), 'secondary', () => window.funsync.openExternal(p.answer?.url || p.topic.url));
    openPost.classList.add('es-dl__open-post');
    head.appendChild(openPost);
    box.appendChild(head);
    // The post's tags (Dave, 2026-11-25: "on the post preview for eroscripts i
    // cant at the moment see tags"): every one, as the forum names them (what
    // the Tags filter takes); a length tag reads as the cards do. The list's
    // tags at once, the post's own when it has loaded.
    const tags = this._postTags(p);
    if (tags.length) {
      const row = document.createElement('ul');
      row.className = 'es-dl__tags';
      row.setAttribute('aria-label', t('eroscripts.tab.tool.tags'));
      for (const tag of tags) {
        const li = document.createElement('li');
        // Clicked: the posts with that tag (Dave, 2026-11-25: "make the tags
        // clickable in the post window"), as a tag link on the forum.
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'es-dl__tag';
        b.dataset.tag = tag;
        b.textContent = LENGTH_TAGS.includes(tag) ? t(`eroscripts.tab.len.${tag.slice(4).replace(/-/g, '_')}`) : tag;
        b.title = t('eroscripts.tab.dl.tagShow', { tag });
        b.addEventListener('click', () => this._showTag(tag));
        li.appendChild(b);
        row.appendChild(li);
      }
      box.appendChild(row);
    }

    if (p.loading) { box.appendChild(this._p('es-dl__note', t('eroscripts.tab.dl.loading'))); return; }
    if (p.failed) { box.appendChild(this._p('es-dl__note', t('eroscripts.tab.postFailed'))); return; }

    const tube = this._get(SETTING_TUBE) === true;
    const script = p.scripts[p.scriptIndex] || null;
    const best = pickBestLink(p.links, { tube, title: p.answer?.title || p.topic.title, scriptName: script?.name, creator: creatorOf(p) });
    const shop = p.links.find((l) => l.kind === 'store');
    const rec = this._done()[p.topic.id] || {};

    if (rec.video && this._present(rec.video)) {
      box.appendChild(this._p('es-dl__already', t('eroscripts.tab.dl.already', { name: rec.video.split(/[\\/]/).pop() })));
    }

    // The simple part: what you get, where it goes, one button.
    const rows = document.createElement('div');
    rows.className = 'es-dl__rows';
    // Script
    const scriptVal = document.createElement('div');
    scriptVal.className = 'es-dl__value';
    if (script) {
      scriptVal.appendChild(this._tick(script.name));
      const sp = provenance(script, creatorOf(p));
      if (sp !== 'post') {
        scriptVal.appendChild(this._p(`es-dl__sub es-dl__prov es-dl__prov--${sp}${sp === 'other' ? ' es-dl__sub--warn' : ''}`, sp === 'scripter'
          ? t('eroscripts.tab.dl.scriptFromScripter', { post: script.postNumber, date: shortDate(script.createdAt) })
          : t('eroscripts.tab.dl.scriptFromOther', { user: script.username || '?', post: script.postNumber, date: shortDate(script.createdAt) })));
      }
      if (script.axes?.length) scriptVal.appendChild(this._axesRow(script, p));
      // Combined: one file holding every axis (funscript 2.0 channels, an
      // `axes` list). The player reads them on load (_feedEmbeddedMultiAxis);
      // a post tagged multi-axis with no axis files is most likely that.
      else if (this._postTags(p).includes('multi-axis')) {
        scriptVal.appendChild(this._p('es-dl__sub', t('eroscripts.tab.dl.combinedAxes')));
      }
      if (p.scripts.length > 1) scriptVal.appendChild(this._p('es-dl__sub', t('eroscripts.tab.dl.moreScripts', { count: p.scripts.length - 1 })));
      scriptVal.appendChild(this._previewBlock(p, script));
    } else if (shop) {
      scriptVal.appendChild(this._p('es-dl__text', t('eroscripts.tab.dl.paid', { host: hostLabel(shop.host) })));
      scriptVal.appendChild(this._button(t('eroscripts.tab.dl.buy'), 'secondary', () => window.funsync.openExternal(shop.url)));
    } else {
      scriptVal.appendChild(this._p('es-dl__text es-dl__text--muted', t('eroscripts.tab.dl.noScript')));
    }
    rows.append(this._label(t('eroscripts.tab.dl.script')), scriptVal);
    // Video
    const videoVal = document.createElement('div');
    videoVal.className = 'es-dl__value';
    if (best) {
      const line = document.createElement('div');
      line.className = 'es-dl__text';
      line.appendChild(this._dot(p.checking ? 'checking' : best.check?.status || 'unknown'));
      const size = best.check?.size ? ` · ${formatBytes(best.check.size)}` : '';
      line.appendChild(document.createTextNode(t('eroscripts.tab.dl.from', { host: hostLabel(best.host) }) + size));
      videoVal.appendChild(line);
      if (best.check?.slow) videoVal.appendChild(this._p('es-dl__sub es-dl__sub--warn', t('eroscripts.tab.dl.slow', { host: hostLabel(best.host) })));
      if (best.from === 'reply') {
        const lp = provenance(best, creatorOf(p));
        videoVal.appendChild(this._p(`es-dl__sub es-dl__prov es-dl__prov--${lp}${lp === 'other' ? ' es-dl__sub--warn' : ''}`, this._replyWords(best, lp)));
        const original = this._postSize(p);
        if (lp === 'other' && sizesDiffer(best.check?.size, original)) {
          videoVal.appendChild(this._p('es-dl__sub es-dl__sub--warn', t('eroscripts.tab.dl.sizeDiffers', { size: formatBytes(best.check.size), original: formatBytes(original) })));
        }
      }
      for (const line of this._lengthLines(p, best, script)) videoVal.appendChild(line);
    } else if (p.checking) {
      videoVal.appendChild(this._p('es-dl__text es-dl__text--muted', t('eroscripts.tab.dl.checking')));
    } else {
      const allDead = p.links.some((l) => l.supported && l.check?.status === 'dead') && !p.links.some((l) => l.supported && l.check?.status !== 'dead' && (l.kind !== 'tube' || tube));
      videoVal.appendChild(this._p('es-dl__text es-dl__text--muted', t(allDead ? 'eroscripts.tab.dl.allDead' : 'eroscripts.tab.dl.noVideo')));
    }
    rows.append(this._label(t('eroscripts.tab.dl.video')), videoVal);
    // Save to, and the room there.
    let main = null;
    let short = false;
    const folder = document.createElement('div');
    folder.className = 'es-dl__value';
    this._onFolderChanged = () => this._renderDl(p);
    folder.append(this._folderRow(), this._spaceLine(best?.check?.size || 0, () => { short = true; if (main && best) main.disabled = true; }));
    rows.append(this._label(t('eroscripts.tab.saveTo')), folder);
    box.appendChild(rows);

    const actions = document.createElement('div');
    actions.className = 'es-dl__actions';
    // This post's video is already in Downloads (stopped, paused, running):
    // Resume / Show it; a fresh copy only on purpose (2026-11-25).
    const existing = best ? this._existingJob((j) => String(this._jobInfo.get(j.id)?.topicId) === String(p.topic?.id)) : null;
    if (existing) {
      box.appendChild(this._p('es-dl__sub', t('eroscripts.tab.paste.inDownloads', { status: this._statusText(existing, this._pctOf(existing)) })));
      main = this._existingJobButton(existing, () => this._dl?.close());
      const again = this._button(t('eroscripts.tab.paste.downloadAgain'), 'secondary', (b) => this._download(p, best, b));
      if (p.checking || short) again.disabled = true;
      actions.appendChild(main);
      main = null;
      actions.appendChild(again);
    } else if (best) {
      main = this._button(t(script ? 'eroscripts.tab.dl.both' : 'eroscripts.tab.dl.videoOnly'), 'primary', (b) => this._download(p, best, b));
      if (p.checking || short) main.disabled = true;
    } else if (script && !p.checking) {
      main = this._button(t('eroscripts.tab.dl.scriptOnly'), 'primary', (b) => this._saveScriptOnly(p, script, b));
    }
    if (main) { main.classList.add('es-dl__main'); actions.appendChild(main); }
    // Watch now: the same video streamed into the player with this script.
    if (best && this._playStream && canWatch(best, tube)) {
      const watch = this._button(t('eroscripts.tab.watch.now'), 'secondary', (b) => this._watch(best, { post: p, script, tube }, b));
      watch.classList.add('es-dl__watch');
      if (p.checking) watch.disabled = true;
      actions.appendChild(watch);
      if (this._queueStream) {
        const later = this._button(t('remoteVideo.addToQueue'), 'secondary', (b) => this._queueFromPost(best, { post: p, script }, b));
        later.classList.add('es-dl__queue');
        if (p.checking) later.disabled = true;
        actions.appendChild(later);
      }
    }
    box.appendChild(actions);
    if (best && this._playStream && canWatch(best, tube)) box.appendChild(this._saveTick());
    if (p.answer?.post) box.appendChild(this._postReader(p));

    // More options: every script, every link, the tube switch.
    const more = document.createElement('details');
    more.className = 'es-dl__more';
    more.open = this._get(SETTING_MORE) === true;
    more.addEventListener('toggle', () => this._set(SETTING_MORE, more.open));
    const summary = document.createElement('summary');
    summary.textContent = t('eroscripts.tab.dl.more');
    more.appendChild(summary);
    this._renderMore(more, p, tube);
    box.appendChild(more);
  }

  _renderMore(el, p, tube) {
    el.appendChild(this._h(t('eroscripts.tab.scriptsHeading')));
    if (!p.scripts.length) {
      const paid = p.links.some((l) => l.kind === 'store');
      el.appendChild(this._p('es-view__note', t(paid ? 'eroscripts.tab.noScriptsPaid' : 'eroscripts.tab.noScripts')));
    } else {
      const list = document.createElement('div');
      list.className = 'es-view__scripts';
      p.scripts.forEach((s, i) => {
        const label = document.createElement('label');
        label.className = 'es-view__script';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `es-script-${p.topic.id}`;
        radio.checked = i === p.scriptIndex;
        radio.addEventListener('change', () => { p.scriptIndex = i; this._renderDl(p); });
        const name = document.createElement('span');
        name.textContent = s.axes?.length
          ? `${s.name} · ${t('eroscripts.tab.dl.multiAxis', { axes: s.axes.map((a) => a.label).join(', ') })}`
          : s.name;
        if (s.from === 'reply') {
          const by = sameUser(s.username, creatorOf(p)) ? ` (${t('eroscripts.tab.post.scripter')})` : '';
          name.textContent += ` · ${t('eroscripts.tab.dl.scriptReplyLabel', { post: s.postNumber, user: s.username || '?' })}${by}`;
        }
        label.append(radio, name);
        list.appendChild(label);
      });
      el.appendChild(list);
    }

    const postLinks = p.links.filter((l) => l.from !== 'reply');
    const replyLinks = p.links.filter((l) => l.from === 'reply');
    el.appendChild(this._h(t('eroscripts.tab.videosHeading')));
    if (!postLinks.length) el.appendChild(this._p('es-view__note', t('eroscripts.tab.noVideoLinks')));
    else el.appendChild(this._linkList(postLinks, p, tube));
    if (replyLinks.length) {
      el.appendChild(this._h(t('eroscripts.tab.dl.replyLinks')));
      el.appendChild(this._linkList(replyLinks, p, tube));
    }

    const tubeRow = document.createElement('label');
    tubeRow.className = 'es-view__tube';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'es-view__tube-box';
    box.checked = tube;
    box.addEventListener('change', () => { this._set(SETTING_TUBE, box.checked); this._renderDl(p); });
    const label = document.createElement('span');
    label.textContent = t('eroscripts.tab.tubeToggle');
    tubeRow.append(box, label);
    el.appendChild(tubeRow);
  }

  _linkList(links, p, tube) {
    const list = document.createElement('ul');
    list.className = 'es-view__links';
    for (const link of links) {
      const li = document.createElement('li');
      li.className = `es-view__link es-view__link--${link.kind}`;
      const status = !link.supported ? null : (p.checking ? 'checking' : link.check?.status || 'unknown');
      li.appendChild(status ? this._dot(status) : document.createElement('span'));
      const kind = document.createElement('span');
      kind.className = 'es-view__badge';
      kind.textContent = t(`eroscripts.tab.kind.${link.kind}`) + (link.host ? ` · ${hostLabel(link.host)}` : '');
      const text = document.createElement('span');
      text.className = 'es-view__link-text';
      const name = link.check?.name || (link.text && link.text !== link.url ? link.text : link.url);
      text.textContent = link.check?.size ? `${name} · ${formatBytes(link.check.size)}` : name;
      text.title = link.url;
      li.append(kind, text);
      const canDownload = link.supported && (link.kind !== 'tube' || tube);
      if (canDownload) {
        li.appendChild(this._button(t('eroscripts.tab.download'), link.check?.status === 'dead' ? 'secondary' : 'primary', (b) => this._download(p, link, b)));
      } else {
        li.appendChild(this._button(t('eroscripts.tab.openInBrowser'), 'secondary', () => window.funsync.openExternal(link.url)));
      }
      if (this._playStream && canWatch(link, tube)) {
        li.appendChild(this._button(t('eroscripts.tab.watch.button'), 'secondary', (b) => this._watch(link, { post: p, script: p.scripts[p.scriptIndex] || null, tube }, b)));
      }
      const notes = [];
      if (link.from === 'reply') {
        const lp = provenance(link, creatorOf(p));
        notes.push(this._replyWords(link, lp));
        if (lp === 'other' && sizesDiffer(link.check?.size, this._postSize(p))) {
          notes.push(t('eroscripts.tab.dl.sizeDiffers', { size: formatBytes(link.check.size), original: formatBytes(this._postSize(p)) }));
        }
      }
      if (status) notes.push(t(`eroscripts.tab.check.${status}`));
      if (link.check?.slow) notes.push(t('eroscripts.tab.dl.slow', { host: hostLabel(link.host) }));
      if (!canDownload) {
        if (link.reason === 'browserOnly') notes.push(t('eroscripts.tab.err.browserOnly'));
        else if (link.reason === 'megaFolder') notes.push(t('eroscripts.tab.err.megaFolder'));
        else if (link.kind === 'tube') notes.push(t('eroscripts.tab.tubeOffHint'));
      }
      if (notes.length) li.appendChild(this._p('es-view__why', notes.join(' · ')));
      list.appendChild(li);
    }
    return list;
  }

  _folderRow() {
    const row = document.createElement('div');
    row.className = 'es-view__folder';
    const select = document.createElement('select');
    select.className = 'es-view__folder-select';
    const sources = (this._get('library.sources') || []).filter((s) => s && s.path && s.enabled !== false);
    const saved = this._get(SETTING_FOLDER) || '';
    const paths = sources.map((s) => ({ path: s.path, name: s.name || s.path }));
    if (saved && !paths.some((p) => p.path === saved)) paths.push({ path: saved, name: saved });
    for (const p of paths) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.name === p.path ? p.path : `${p.name} (${p.path})`;
      select.appendChild(o);
    }
    if (saved) select.value = saved;
    select.addEventListener('change', () => { this._set(SETTING_FOLDER, select.value); this._onFolderChanged?.(); });
    const choose = this._button(t('eroscripts.tab.chooseFolder'), 'secondary', async () => {
      const dir = await window.funsync.selectDirectory?.();
      if (!dir) return;
      this._set(SETTING_FOLDER, dir);
      if (this._onFolderChanged) this._onFolderChanged();
      else this._renderDl();
    });
    row.append(select, choose);
    this._folderSelect = select;
    return row;
  }

  _destFolder() {
    // The open window's choice, the saved one, else the first library folder
    // (several at once has no window).
    const first = (this._get('library.sources') || []).find((s) => s && s.path && s.enabled !== false)?.path || '';
    return (this._folderSelect?.isConnected && this._folderSelect.value) || this._get(SETTING_FOLDER) || first;
  }

  async _download(p, link, btn, { tried = [] } = {}) {
    const dest = this._destFolder();
    if (!dest) { showToast(t('eroscripts.tab.err.badFolder'), 'warn'); return; }
    if (btn) btn.disabled = true;
    const script = p?.scripts?.[p.scriptIndex] || null;
    const sep = dest.includes('\\') ? '\\' : '/';
    const folder = dest.replace(/[\\/]+$/, '');
    // This post's script is already in that folder and its video is not (a
    // failed or cancelled try): the video takes the script's name instead of
    // a second "(1)" pair.
    const rec = this._done()[p.topic.id] || {};
    const ours = rec.script && this._present(rec.script) && !this._present(rec.video)
      && (!script || !rec.scriptUrl || rec.scriptUrl === script.url)
      && rec.script.slice(0, rec.script.length - rec.script.split(/[\\/]/).pop().length - 1).toLowerCase() === folder.toLowerCase()
      ? rec.script.split(/[\\/]/).pop().replace(/\.funscript$/i, '') : null;
    // Gofile (2026-11-24): the app opens the Gofile page in a window of its
    // own for the file link and guest cookie (electron/gofile.js).
    let resolved = null;
    if (link.host === 'gofile') {
      const g = await this._gofile(link, script?.name || '');
      if (!g?.ok) {
        if (btn) btn.disabled = false;
        showToast(errorText(g?.error), 'error');
        return false;
      }
      resolved = { link: g.link, name: g.name, size: g.size, cookie: g.cookie };
    }
    const axes = this._axesFor(script);
    const title = p?.answer?.title || p?.topic?.title;
    const r = await this._fetchJson('', {
      method: 'POST',
      body: JSON.stringify({
        url: link.url, destDir: dest, stem: ours || stemForPost(p?.answer?.title || p?.topic?.title),
        allowTube: this._get(SETTING_TUBE) === true,
        scriptIsOurs: !!ours,
        // Several videos behind one link (a Mega folder, a Pixeldrain list): the script's.
        hint: script?.name || '',
        ...(resolved ? { resolved } : {}),
        // Kept with the job: brought back after FunSync closes, it still
        // finishes as this post's (its script, tags, card; 2026-11-25).
        meta: downloadMeta({ topic: p?.topic, answer: p?.answer, script, axes, title }),
      }),
    }).catch(() => ({ ok: false, body: null }));
    if (!r.ok || !r.body?.job) {
      if (btn) btn.disabled = false;
      if (btn) showToast(errorText(r.body?.detail?.code), 'error');
      return false;
    }
    const job = r.body.job;
    const info = { topicId: p.topic.id, topic: p.topic, answer: p.answer, script, scriptPath: null, stem: job.stem, title, handled: false,
      // A link that fails before any of the video came: the post's next one.
      post: p, tried: [...tried, link.url],
      // A multi-axis set's axis files, unless "every axis" is off.
      axes };
    this._jobInfo.set(job.id, info);
    this._jobs.push(job);
    // The script now, under the name the backend reserved for the video, so
    // it is here (and ticked) at once, whatever happens to the video.
    const target = job.stem ? `${folder}${sep}${job.stem}.funscript` : '';
    // A split multi-axis set: its axis files beside it, under the same name.
    if (script && job.stem && info.axes.length) this._saveAxes(info.axes, folder, job.stem);
    if (ours && target === rec.script) {
      info.scriptPath = target;                  // already here, under this name
    } else if (script && job.stem) {
      window.funsync.eroscriptsDownload(script.url, target).then((res) => {
        if (!res?.success) return;
        info.scriptPath = target;
        this._exists.set(target, true);
        this._markDone(p.topic.id, { script: target, scriptUrl: script.url, title: info.title });
        this._repaintAll();
      }).catch(() => { /* saved with the video instead */ });
    }
    // Started: the card shows the rest (Dave: "progress should show on the card").
    if (btn) this._dl?.close();
    this._repaintAll();
    this._renderJobs();
    this._startPolling();
    return true;
  }

  /** No video to fetch: the script alone, as <post title>.funscript. */
  async _saveScriptOnly(p, script, btn) {
    const dest = this._destFolder();
    if (!dest) { showToast(t('eroscripts.tab.err.badFolder'), 'warn'); return; }
    const sep = dest.includes('\\') ? '\\' : '/';
    const base = stemForPost(p.answer?.title || p.topic.title);
    const path = `${dest.replace(/[\\/]+$/, '')}${sep}${base}.funscript`;
    if (btn) btn.disabled = true;
    const look = await window.funsync.eroscriptsDownload(script.url, path, { checkOnly: true }).catch(() => null);
    let replace = false;
    if (look?.exists) {
      if (!(await askReplaceFiles([`${base}.funscript`]))) { forgetFetched(script.url); if (btn) btn.disabled = false; return; }
      replace = true;
    } else if (!look?.success) {
      forgetFetched(script.url);
      if (btn) btn.disabled = false;
      showToast(t('eroscripts.tab.err.failed'), 'error');
      return;
    }
    const res = await window.funsync.eroscriptsDownload(script.url, path, { replace }).catch(() => null);
    if (res?.success) await this._saveAxes(this._axesFor(script), dest.replace(/[\\/]+$/, ''), base);
    if (!res?.success) {
      if (btn) btn.disabled = false;
      showToast(t('eroscripts.tab.err.failed'), 'error');
      return;
    }
    this._exists.set(path, true);
    this._markDone(p.topic.id, { script: path, scriptUrl: script.url, title: p.answer?.title || p.topic.title });
    if (btn) showToast(t('eroscripts.tab.dl.scriptSaved', { name: `${base}.funscript` }), 'success');
    if (btn) this._dl?.close();
    this._repaintAll();
    if (this._isLibraryFolder(dest)) this._onSaved();
    return true;
  }

  // --- downloads ------------------------------------------------------------

  _active(job) { return job && ['queued', 'resolving', 'downloading'].includes(job.status); }

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._refreshJobs(), POLL_MS);
  }

  _stopPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  async _refreshJobs() {
    let r;
    try { r = await this._fetchJson(''); } catch { return false; }
    if (!r.ok) return false;
    this._jobs = r.body?.jobs || [];
    for (const job of this._jobs) {
      // Not started this session (it came back after FunSync closed): its
      // post, script and tags from the note kept with it.
      if (!this._jobInfo.has(job.id)) this._jobInfo.set(job.id, infoFromMeta(job));
      const info = this._jobInfo.get(job.id);
      if (job.status === 'done' && info && !info.handled) {
        info.handled = true;
        await this._finish(job, info);
      } else if (job.status === 'error' && info && !info.handled && !job.resumable && !(job.bytes > 0) && info.post) {
        info.handled = true;
        this._downloadNextLink(job, info);
      }
    }
    this._repaintAll();
    this._renderJobs();
    if (this._jobs.some((j) => this._active(j))) this._startPolling();
    else this._stopPolling();
    return true;
  }

  /**
   * At start: downloads that were running when FunSync closed come back
   * paused from the backend's saved list. Say so once, with a way to them
   * (Dave, 2026-11-25: "there was no indicator that the download could
   * resume"); their cards and the Downloads list show Resume and how far
   * each got. The backend may still be starting: asked again a few times.
   * @returns {Promise<number>} how many stopped when FunSync closed
   */
  async checkInterruptedDownloads({ tries = 10, waitMs = 3000 } = {}) {
    for (let i = 0; i < tries; i++) {
      if (await this._refreshJobs()) {
        const stopped = this._jobs.filter((j) => j.status === 'paused' && j.interrupted === true);
        if (stopped.length) this._announceInterrupted(stopped);
        return stopped.length;
      }
      await new Promise((res) => setTimeout(res, waitMs));
    }
    return 0;
  }

  _announceInterrupted(jobs) {
    const one = jobs.length === 1 ? jobs[0] : null;
    const name = one ? (this._jobInfo.get(one.id)?.title || one.stem) : '';
    const text = !one
      ? t('eroscripts.tab.interrupted.many', { count: jobs.length })
      : (one.total
        ? t('eroscripts.tab.interrupted.one', { name, percent: Math.min(100, Math.round((one.bytes / one.total) * 100)) })
        : t('eroscripts.tab.interrupted.oneUnknown', { name }));
    const msg = document.createElement('span');
    msg.className = 'es-toast';
    const words = document.createElement('span');
    words.textContent = text;
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'es-toast__play';
    show.textContent = t('eroscripts.tab.interrupted.show');
    let toast = null;
    show.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showTab();
      this._build();
      this._toggleDownloads(true);
      // Done with: it stayed up over the list (live check, 2026-11-25).
      toast?.dismiss?.();
    });
    msg.append(words, show);
    toast = showToast(msg, 'info', 15000);
  }

  /**
   * A download that failed before any of the video came: the post's next
   * link, once each (2026-11-23). The failed one stays in the list with its
   * error; nothing more to try says so.
   */
  _downloadNextLink(job, info) {
    const p = info.post;
    const tube = this._get(SETTING_TUBE) === true;
    const script = p.scripts?.[p.scriptIndex] || null;
    const next = rankLinks(p.links, { tube, title: p.answer?.title || p.topic?.title, scriptName: script?.name, creator: creatorOf(p) })
      .find((l) => !info.tried.includes(l.url));
    if (!next) {
      showToast(t('eroscripts.tab.watch.noMoreLinks', { reason: errorText(job.error) }), 'error', 6000);
      return;
    }
    showToast(t('eroscripts.tab.watch.nextLink', { host: hostLabel(next.host) }), 'info');
    this._download(p, next, null, { tried: info.tried }).then((ok) => {
      if (!ok) showToast(t('eroscripts.tab.err.failed'), 'error');
    });
  }

  /** A video landed: its script beside it, the card, then the library. */
  async _finish(job, info) {
    const dir = job.path.replace(/[\\/][^\\/]*$/, '');
    const base = job.path.slice(dir.length + 1).replace(/\.[^.]+$/, '');
    const sep = job.path.includes('\\') ? '\\' : '/';
    // Saved at the start under the same name; again only when it is not there
    // (it failed then) or the video's name came out different.
    const target = `${dir}${sep}${base}.funscript`;
    let scriptPath = info.scriptPath === target ? target : null;
    // Brought back after FunSync closed: the script was saved when the
    // download started, if that worked; saved now if it is not there.
    if (scriptPath && info.restored) {
      try { if (await window.funsync.fileExists?.(scriptPath) !== true) scriptPath = null; } catch { scriptPath = null; }
    }
    if (info.script && !scriptPath) {
      try {
        const res = await window.funsync.eroscriptsDownload(info.script.url, target);
        if (res?.success) scriptPath = target;
      } catch { scriptPath = null; }
      // The video came out under another name: its axes follow it.
      if (info.axes?.length) await this._saveAxes(info.axes, dir, base);
    }
    this._exists.set(job.path, true);
    // The post's tags come with it (Dave, 2026-11-22: "if we're getting the
    // video and funscript from a post it just makes sense to get the tags
    // too"): the same record Get Script writes (script-tags.js).
    if (info.topic) {
      try { recordDownloadTags(this._settings, job.path, { topic: info.topic, answer: info.answer, scriptPath, video: true }); } catch { /* the download stands */ }
    }
    if (scriptPath) this._exists.set(scriptPath, true);
    if (info.topicId != null) {
      this._markDone(info.topicId, { video: job.path, ...(scriptPath ? { script: scriptPath, scriptUrl: info.script?.url } : {}), title: info.title });
    }
    this._announce(job.path, t(scriptPath ? 'eroscripts.tab.savedWithScript' : 'eroscripts.tab.saved', { name: base }), base);
    if (this._isLibraryFolder(dir)) this._onSaved();
    if (scriptPath) this._checkLength(job.path, scriptPath, base);
  }

  /**
   * The video landed: is it the cut the script was made for (the review's
   * 2.3: "Re-ups are often a different cut")? Its length (ffprobe) against
   * the saved script's; a warning when the script runs past the end or
   * records another length. Local only: no request to the forum.
   */
  async _checkLength(videoPath, scriptPath, name) {
    let meta = null;
    let text = null;
    try { [meta, text] = await Promise.all([window.funsync.fetchMetadata?.(videoPath), window.funsync.readFunscript?.(scriptPath)]); } catch { return; }
    let json = null;
    try { json = JSON.parse(text); } catch { return; }
    const actions = (Array.isArray(json?.actions) ? json.actions : []).filter((a) => Number.isFinite(Number(a?.at)));
    const end = actions.reduce((m, a) => Math.max(m, Number(a.at)), 0) / 1000;
    const v = lengthVerdict({ scriptEndS: end, metaS: json?.metadata?.duration ?? null, videoS: Number(meta?.duration) });
    if (!v || (v.kind !== 'pastEnd' && v.kind !== 'length')) return;
    showToast(t('eroscripts.tab.lenCheck.afterDownload', { name, video: clockText(v.videoS), script: clockText(v.scriptS) }), 'warn', 12000);
  }

  // --- who posted it, the lengths, the script preview, the post (review 2.1-2.5) ---

  /** "From the scripter, reply #23, 3 Nov" / "Re-upload by @x, reply #23, 3 Nov · 5 likes". */
  _replyWords(link, prov) {
    const date = shortDate(link.createdAt);
    const words = prov === 'scripter'
      ? t('eroscripts.tab.dl.byScripter', { post: link.postNumber, date })
      : t('eroscripts.tab.dl.reupBy', { user: link.username || '?', post: link.postNumber, date });
    return link.likes > 0 ? `${words} · ${t('eroscripts.tab.dl.likes', { count: link.likes })}` : words;
  }

  /** The size of the first post's own video link, when one was read. */
  _postSize(p) {
    let size = 0;
    for (const l of p.links || []) if (l.from !== 'reply' && l.check?.size > size) size = l.check.size;
    return size;
  }

  /** The video's length: from its host (EroSync), else the post's stated one. */
  _videoLength(p, best) {
    const d = Number(best?.check?.duration);
    if (d > 0) return { seconds: d, approx: false, source: 'host' };
    if (p.stated?.seconds > 0) return { seconds: p.stated.seconds, approx: p.stated.approx === true, source: 'post' };
    return null;
  }

  /** The Video row's length lines: the video's length, and whether the script fits it. */
  _lengthLines(p, best, script) {
    const out = [];
    const video = this._videoLength(p, best);
    if (!video) return out;
    out.push(this._p('es-dl__sub es-dl__len', video.source === 'host'
      ? t('eroscripts.tab.lenCheck.fromHost', { length: clockText(video.seconds), host: hostLabel(best.host) })
      : t('eroscripts.tab.lenCheck.fromPost', { length: clockText(video.seconds) })));
    // The post's length is the scripter's video. Someone else's re-upload
    // can be another cut or a clip (test day 2026-11-24, B005: "Lengths
    // match" for a re-upload that was 0:51 of a 6:40 video), so no verdict
    // from it: the download's own check says.
    if (video.source === 'post' && best && provenance(best, creatorOf(p)) === 'other') {
      out.push(this._p('es-dl__sub', t('eroscripts.tab.lenCheck.reupUnknown')));
      return out;
    }
    const prev = script?.url ? this._previews.get(script.url) : null;
    if (prev?.state !== 'ok') return out;
    const v = lengthVerdict({ scriptEndS: prev.summary.lengthS, metaS: prev.metaDuration, videoS: video.seconds, approx: video.approx });
    if (!v) return out;
    const warn = isLengthWarning(v);
    out.push(this._p(`es-dl__sub es-dl__len-verdict${warn ? ' es-dl__sub--warn' : ''}`, t(`eroscripts.tab.lenCheck.${v.kind}`, {
      script: clockText(v.scriptS), video: clockText(v.videoS), gap: clockText(Math.abs(v.gapS)),
    })));
    return out;
  }

  /** What the script is like (2.2): its heatmap, length, actions, speeds. */
  _previewBlock(p, script) {
    const box = document.createElement('div');
    box.className = 'es-dl__preview';
    if (!script?.url || !/\.funscript$/i.test(script.name || '')) return box;
    const prev = this._previews.get(script.url);
    if (!prev) this._loadPreview(p, script);
    if (!prev || prev.state === 'loading') {
      box.appendChild(this._p('es-dl__sub es-dl__text--muted', t('eroscripts.tab.preview.loading')));
      return box;
    }
    if (prev.state !== 'ok') {
      box.appendChild(this._p('es-dl__sub es-dl__text--muted', t('eroscripts.tab.preview.failed')));
      return box;
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'es-dl__heat';
    canvas.width = 480;
    canvas.height = 22;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('eroscripts.tab.preview.aria'));
    try { renderBins(canvas, prev.bins); } catch { /* no canvas here */ }
    const s = prev.summary;
    box.append(canvas, this._p('es-dl__sub es-dl__stats', t('eroscripts.tab.preview.stats', {
      length: clockText(s.lengthS), count: s.count.toLocaleString(), avg: s.avgSpeed, max: s.maxSpeed,
    })));
    if (s.fast) box.appendChild(this._p('es-dl__sub es-dl__sub--warn', t('eroscripts.tab.preview.fast', { limit: FAST_SPEED })));
    if (prev.channels?.length) box.appendChild(this._p('es-dl__sub', t('eroscripts.tab.preview.channels', { list: prev.channels.join(', ') })));
    return box;
  }

  /** Read the script's actions once (main keeps the bytes for the download). */
  async _loadPreview(p, script) {
    const url = script.url;
    this._previews.set(url, { state: 'loading' });
    let r = null;
    try { r = await window.funsync.eroscriptsScriptPreview?.(url); } catch { r = null; }
    if (r?.ok && Array.isArray(r.actions)) {
      this._previews.set(url, {
        state: 'ok', summary: scriptSummary(r.actions), bins: computeBins(r.actions),
        metaDuration: r.metaDuration ?? null, channels: Array.isArray(r.channels) ? r.channels : [],
      });
    } else {
      this._previews.set(url, { state: 'failed' });
    }
    while (this._previews.size > 40) this._previews.delete(this._previews.keys().next().value);
    this._renderDl(p);
  }

  /** The post (2.1): its text and images, then the replies, folded. */
  _postReader(p) {
    const wrap = document.createElement('details');
    wrap.className = 'es-dl__post';
    wrap.open = this._get(SETTING_POST_OPEN) === true;
    const count = Number(p.answer.replyCount) || 0;
    const summary = document.createElement('summary');
    summary.textContent = count
      ? `${t('eroscripts.tab.post.title')} · ${t('eroscripts.tab.post.replies', { count })}`
      : t('eroscripts.tab.post.title');
    wrap.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'es-post';
    const frag = sanitizePostHtml(p.answer.post.cooked || '');
    if (frag.childNodes.length) body.appendChild(frag);
    else body.appendChild(this._p('es-dl__note', t('eroscripts.tab.post.empty')));
    wrap.appendChild(body);
    const replies = Array.isArray(p.answer.replies) ? p.answer.replies : [];
    if (replies.length) {
      const rd = document.createElement('details');
      rd.className = 'es-post__replies';
      rd.open = p.repliesOpen === true;
      const rs = document.createElement('summary');
      rs.textContent = t('eroscripts.tab.post.replies', { count: Math.max(count, replies.length) });
      rd.appendChild(rs);
      const creator = creatorOf(p);
      for (const r of replies) {
        const item = document.createElement('div');
        item.className = 'es-post__reply';
        const op = sameUser(r.username, creator);
        if (op) item.classList.add('es-post__reply--op');
        const head = document.createElement('div');
        head.className = 'es-post__reply-head';
        head.textContent = [
          `#${r.postNumber}`,
          `@${r.username || '?'}${op ? ` (${t('eroscripts.tab.post.scripter')})` : ''}`,
          relativeTime(r.createdAt),
          r.likes > 0 ? t('eroscripts.tab.dl.likes', { count: r.likes }) : '',
        ].filter(Boolean).join(' · ');
        const rb = document.createElement('div');
        rb.className = 'es-post__body';
        rb.appendChild(sanitizePostHtml(r.cooked || ''));
        item.append(head, rb);
        rd.appendChild(item);
      }
      if (count > replies.length) rd.appendChild(this._p('es-dl__note', t('eroscripts.tab.post.showing', { shown: replies.length, total: count })));
      rd.addEventListener('toggle', () => { p.repliesOpen = rd.open; if (rd.open) this._fillImages(rd); });
      wrap.appendChild(rd);
      // Once it is on the page (a fill on a detached box stops at once).
      if (rd.open) queueMicrotask(() => this._fillImages(rd));
    }
    wrap.addEventListener('toggle', () => {
      this._set(SETTING_POST_OPEN, wrap.open);
      if (wrap.open) this._fillImages(body);
    });
    // Links in the post open in the browser, never in the app.
    wrap.addEventListener('click', (e) => {
      const a = e.target?.closest?.('a[data-href]');
      if (!a || !wrap.contains(a)) return;
      e.preventDefault();
      window.funsync.openExternal(a.dataset.href);
    });
    if (wrap.open) queueMicrotask(() => this._fillImages(body));
    return wrap;
  }

  /**
   * The post's images: forum images one at a time through main (with the
   * session), another host's only on "Show image from <host>". Each one is
   * kept for the session, so a repaint shows it at once.
   */
  async _fillImages(root) {
    const slots = Array.from(root.querySelectorAll('.es-post__img:not([data-state])'));
    for (const slot of slots) {
      slot.dataset.state = 'waiting';
      const cached = this._imgCache.get(slot.dataset.src);
      if (cached) { this._showImage(slot, cached); continue; }
      if (slot.dataset.forum !== '1') this._imageButton(slot);
    }
    for (const slot of slots) {
      if (!root.isConnected) return;
      if (slot.dataset.state !== 'waiting' || slot.dataset.forum !== '1') continue;
      await this._loadImage(slot, false);
    }
  }

  _imageButton(slot) {
    const btn = this._button(t('eroscripts.tab.post.showImage', { host: slot.dataset.host || '?' }), 'secondary', () => this._loadImage(slot, true));
    btn.classList.add('es-post__img-btn');
    slot.dataset.state = 'ask';
    slot.replaceChildren(btn);
  }

  async _loadImage(slot, external) {
    const url = slot.dataset.src;
    slot.dataset.state = 'loading';
    let pending = this._imgLoading.get(url);
    if (!pending) {
      pending = Promise.resolve(window.funsync.eroscriptsImage?.(url, { external })).catch(() => null);
      this._imgLoading.set(url, pending);
    }
    const r = await pending;
    this._imgLoading.delete(url);
    if (r?.ok && r.dataUrl) {
      this._imgCache.set(url, r.dataUrl);
      while (this._imgCache.size > 40) this._imgCache.delete(this._imgCache.keys().next().value);
      if (slot.isConnected) this._showImage(slot, r.dataUrl);
      return;
    }
    slot.dataset.state = 'failed';
    const failed = document.createElement('a');
    failed.className = 'es-post__link es-post__img-failed';
    failed.href = url;
    failed.dataset.href = url;
    failed.textContent = t('eroscripts.tab.post.imageFailed', { host: slot.dataset.host || '?' });
    slot.replaceChildren(failed);
  }

  _showImage(slot, dataUrl) {
    const img = document.createElement('img');
    img.alt = slot.title || '';
    img.src = dataUrl;
    slot.dataset.state = 'done';
    slot.style.aspectRatio = '';
    slot.replaceChildren(img);
  }

  /**
   * "Saved …" with a Play button; and, when the app is not in front (or the
   * tab is not open), a system notification that plays it when clicked.
   */
  _announce(path, text, name) {
    const msg = document.createElement('span');
    msg.className = 'es-toast';
    const words = document.createElement('span');
    words.textContent = text;
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'es-toast__play';
    play.textContent = t('eroscripts.tab.toastPlay');
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playPath(path)) window.funsync.showInFolder?.(path);
    });
    msg.append(words, play);
    showToast(msg, 'success', 10000);
    const away = typeof document.hasFocus === 'function' ? !document.hasFocus() : false;
    if ((away || !this._visible) && typeof Notification === 'function' && Notification.permission !== 'denied') {
      try {
        const n = new Notification(t('eroscripts.tab.notify.title'), { body: name, silent: false, icon: APP_ICON });
        n.onclick = () => { try { window.focus(); } catch { /* */ } if (!this._playPath(path)) window.funsync.showInFolder?.(path); };
      } catch { /* no notifications here */ }
    }
  }

  // --- paste a link ---------------------------------------------------------

  /**
   * A video from a link with no forum post behind it: FapTap, PMVHaven,
   * Pixeldrain, Mega, a direct link, and tube sites when they are on. The
   * link is looked at as soon as it is there (what it is, does it work, its
   * name and size); Save as and the folder can be changed; Download starts it
   * and opens the Downloads list. No script comes with it.
   */
  openPasteLink(initial = '') {
    this._build();
    if (this._paste) this._paste.close();
    const state = { url: '', link: null, checking: false, token: 0 };
    Modal.open({
      title: t('eroscripts.tab.paste.title'),
      panelClass: 'es-dl-panel',
      initialFocus: (body) => body.querySelector('.es-paste__input'),
      onRender: (body, resolve) => {
        this._paste = { body, close: () => resolve(null), state };
        this._buildPaste(body, state, initial);
      },
    }).then(() => { if (this._paste?.state === state) this._paste = null; });
  }

  _buildPaste(body, state, initial) {
    const box = document.createElement('div');
    box.className = 'es-dl es-paste';
    const label = document.createElement('label');
    label.className = 'es-paste__label';
    label.textContent = t('eroscripts.tab.paste.label');
    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'eroscripts-panel__input es-paste__input';
    input.placeholder = 'https://faptap.net/v/…';
    input.spellcheck = false;
    label.appendChild(input);
    const hint = this._p('es-dl__sub', t('eroscripts.tab.paste.hint'));
    const result = document.createElement('div');
    result.className = 'es-paste__result';
    box.append(label, hint, result);
    body.appendChild(box);
    state.input = input;
    state.result = result;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this._lookUpPaste(state, input.value), 350);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(timer);
      const go = state.result.querySelector('.es-dl__main');
      if (go && !go.disabled && state.url === input.value.trim()) go.click();
      else this._lookUpPaste(state, input.value);
    });
    if (initial) {
      input.value = initial;
      this._lookUpPaste(state, initial);
    } else {
      this._renderPasteResult(state);
    }
  }

  async _lookUpPaste(state, raw) {
    const url = String(raw || '').trim();
    const token = ++state.token;
    state.url = url;
    state.link = null;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      state.checking = false;
      this._renderPasteResult(state);
      return;
    }
    state.checking = true;
    this._renderPasteResult(state);
    let link = { url, kind: 'unsupported', host: '', supported: false };
    try {
      const r = await this._fetchJson('/classify', { method: 'POST', body: JSON.stringify({ links: [url] }) });
      if (r.body?.links?.[0]) link = { ...r.body.links[0], url };
    } catch { /* stays unsupported */ }
    if (token !== state.token) return;
    if (link.supported) {
      try {
        const r = await this._fetchJson('/check', { method: 'POST', body: JSON.stringify({ links: [url] }) });
        if (r.body?.links?.[0]) link.check = r.body.links[0];
      } catch { /* not checked */ }
      // The list as it is now: this link may already be in it (a download
      // brought back after FunSync closed, a paused one).
      await this._refreshJobs().catch(() => false);
    }
    if (token !== state.token) return;
    state.checking = false;
    state.link = link;
    // Its own name: the host's (FapTap's title, Pixeldrain's file name), else
    // the link's file name ("mov_bbb" for .../mov_bbb.mp4), never "video".
    let fromUrl = '';
    try { fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { fromUrl = ''; }
    const own = link.check?.name || (link.kind === 'direct' ? fromUrl : '');
    state.name = own ? stemForPost(own.replace(/\.[a-z0-9]{2,5}$/i, '')) : '';
    state.forum = null;
    // Many FapTap / PMVHaven videos are posted on EroScripts too, often with
    // a free script: looked for by the video's name (logged in only, one
    // search per link).
    if (state.name && link.supported && this._panel?.isLoggedIn) {
      state.forum = 'searching';
      this._findOnForum(state, token);
    }
    this._renderPasteResult(state);
  }

  async _findOnForum(state, token) {
    let topic = null;
    try {
      const r = await window.funsync.eroscriptsSearch(state.name);
      const hits = (r?.results || []).filter((x) => x && sameVideoTitle(x.title, state.name));
      const exact = hits.find((x) => compactName(x.title) === compactName(state.name));
      topic = exact || hits.find((x) => priceOf(x.categoryId) === 'free') || hits[0] || null;
    } catch { topic = null; }
    if (token !== state.token) return;
    state.forum = topic;
    this._renderPasteResult(state);
  }

  _forumRow(state) {
    const box = document.createElement('div');
    box.className = 'es-paste__forum';
    if (state.forum === 'searching') {
      box.appendChild(this._p('es-dl__sub', t('eroscripts.tab.paste.forumSearching')));
      return box;
    }
    const topic = state.forum;
    const head = document.createElement('div');
    head.className = 'es-paste__forum-head';
    head.appendChild(this._label(t('eroscripts.tab.paste.forum')));
    const price = priceOf(topic.categoryId);
    if (price) {
      const chip = document.createElement('span');
      chip.className = `es-card__price es-card__price--${price}`;
      chip.textContent = t(`eroscripts.tab.price.${price}`);
      head.appendChild(chip);
    }
    const title = document.createElement('span');
    title.className = 'es-paste__forum-title';
    title.textContent = topic.title;
    title.title = topic.title;
    head.appendChild(title);
    const use = this._button(t('eroscripts.tab.paste.forumUse'), 'primary', () => {
      this._paste?.close();
      this.openPost(topic);
    });
    box.append(head, this._p('es-dl__sub', t('eroscripts.tab.paste.forumHint')), use);
    return box;
  }

  _renderPasteResult(state) {
    const el = state.result;
    if (!el) return;
    el.replaceChildren();
    if (state.checking) { el.appendChild(this._p('es-dl__note', t('eroscripts.tab.paste.checking'))); return; }
    const link = state.link;
    if (!link) return;
    const tube = this._get(SETTING_TUBE) === true;

    const rows = document.createElement('div');
    rows.className = 'es-dl__rows';
    // What it is
    const what = document.createElement('div');
    what.className = 'es-dl__value';
    const line = document.createElement('div');
    line.className = 'es-dl__text';
    if (link.supported) line.appendChild(this._dot(link.check?.status || 'unknown'));
    const badge = document.createElement('span');
    badge.className = 'es-view__badge';
    badge.textContent = t(`eroscripts.tab.kind.${link.kind}`) + (link.host ? ` · ${hostLabel(link.host)}` : '');
    line.appendChild(badge);
    const status = link.supported ? t(`eroscripts.tab.check.${link.check?.status || 'unknown'}`) : t('eroscripts.tab.paste.unsupported');
    const size = link.check?.size ? ` · ${formatBytes(link.check.size)}` : '';
    line.appendChild(document.createTextNode(`${status}${size}`));
    what.appendChild(line);
    if (link.check?.slow) what.appendChild(this._p('es-dl__sub es-dl__sub--warn', t('eroscripts.tab.dl.slow', { host: hostLabel(link.host) })));
    if (link.reason === 'browserOnly') what.appendChild(this._p('es-dl__sub', t('eroscripts.tab.err.browserOnly')));
    else if (link.reason === 'megaFolder') what.appendChild(this._p('es-dl__sub', t('eroscripts.tab.err.megaFolder')));
    else if (link.reason === 'paid') what.appendChild(this._p('es-dl__sub', t('eroscripts.tab.noScriptsPaid')));
    rows.append(this._label(t('eroscripts.tab.dl.video')), what);
    // The script: never included with a link. For FapTap, what FapTap says
    // about it (Dave: "make sure users know the script is not available
    // unless paid for on faptap"); nothing here fetches it.
    if (link.supported) rows.append(this._label(t('eroscripts.tab.dl.script')), this._pasteScriptRow(link));

    const canDownload = link.supported && link.check?.status !== 'dead';
    if (canDownload) {
      // Save as
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'eroscripts-panel__input es-paste__name';
      name.value = state.name || '';
      name.placeholder = t('eroscripts.tab.paste.namePlaceholder');
      name.addEventListener('input', () => { state.name = name.value; });
      rows.append(this._label(t('eroscripts.tab.paste.saveAs')), name);
      const folder = document.createElement('div');
      folder.className = 'es-dl__value';
      this._onFolderChanged = () => this._renderPasteResult(state);
      folder.append(this._folderRow(), this._spaceLine(link.check?.size || 0, () => {
        state.short = true;
        const go = state.result?.querySelector('.es-dl__main');
        if (go) go.disabled = true;
      }));
      rows.append(this._label(t('eroscripts.tab.saveTo')), folder);
    }
    el.appendChild(rows);
    if (state.forum) el.appendChild(this._forumRow(state));

    if (link.kind === 'tube') {
      const tubeRow = document.createElement('label');
      tubeRow.className = 'es-view__tube';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'es-view__tube-box';
      cb.checked = tube;
      cb.addEventListener('change', () => { this._set(SETTING_TUBE, cb.checked); this._renderPasteResult(state); });
      const text = document.createElement('span');
      text.textContent = t('eroscripts.tab.tubeToggle');
      tubeRow.append(cb, text);
      el.appendChild(tubeRow);
    }

    const actions = document.createElement('div');
    actions.className = 'es-dl__actions';
    // Already in Downloads (stopped when FunSync closed, paused, failed
    // part-way, or running): offered, not a second copy from zero under
    // "Name (1)" (Dave, 2026-11-25, pasted a stopped download's link again).
    const existing = canDownload ? this._existingJob((j) => j.url === link.url) : null;
    if (existing) {
      el.appendChild(this._p('es-dl__sub', t('eroscripts.tab.paste.inDownloads', { status: this._statusText(existing, this._pctOf(existing)) })));
      actions.appendChild(this._existingJobButton(existing, () => this._paste?.close()));
      const again = this._button(t('eroscripts.tab.paste.downloadAgain'), 'secondary', (b) => this._downloadPasted(state, b));
      if (link.kind === 'tube' && !tube) again.disabled = true;
      actions.appendChild(again);
    } else if (canDownload) {
      el.appendChild(this._p('es-dl__sub', t('eroscripts.tab.paste.pairHint')));
      const go = this._button(t('eroscripts.tab.download'), 'primary', (b) => this._downloadPasted(state, b));
      go.classList.add('es-dl__main');
      if (link.kind === 'tube' && !tube) go.disabled = true;
      actions.appendChild(go);
    } else {
      actions.appendChild(this._button(t('eroscripts.tab.openInBrowser'), 'secondary', () => window.funsync.openExternal(link.url)));
    }
    // Watch: the video only (a pasted link brings no script; drop one on the player).
    if (this._playStream && canWatch(link, tube)) {
      actions.appendChild(this._button(t('eroscripts.tab.watch.button'), 'secondary', (b) => this._watch(link, {}, b)));
    }
    el.appendChild(actions);
  }

  _pasteScriptRow(link) {
    const val = document.createElement('div');
    val.className = 'es-dl__value';
    const info = link.host === 'faptap' ? link.check?.script : null;
    const text = (key, vars) => val.appendChild(this._p('es-dl__text es-dl__text--muted', t(key, vars)));
    if (!info) {
      text('eroscripts.tab.paste.noScript');
    } else if (!info.exists) {
      text('eroscripts.tab.paste.ftNone');
    } else if (info.downloadable) {
      text('eroscripts.tab.paste.ftDownloadable');
      val.appendChild(this._button(t('eroscripts.tab.paste.ftOpen'), 'secondary', () => window.funsync.openExternal(link.url)));
    } else if (info.shops?.length) {
      let host = '';
      try { host = new URL(info.shops[0]).hostname.replace(/^www\./, ''); } catch { host = ''; }
      text('eroscripts.tab.paste.ftPaid', { host: host.replace(/\.com$/, '').replace(/^./, (c) => c.toUpperCase()) });
      val.appendChild(this._button(t('eroscripts.tab.dl.buy'), 'secondary', () => window.funsync.openExternal(info.shops[0])));
    } else {
      text('eroscripts.tab.paste.ftNotIncluded');
    }
    return val;
  }

  /**
   * "Pair a script…" on a finished download that came without one: the
   * user picks the .funscript they have (bought, or from elsewhere) and it is
   * saved beside the video under the video's name, so the library pairs them
   * like any other. A file already there is never replaced without asking.
   */
  async _pairScript(job, btn) {
    // Bought scripts land in Downloads: the picker starts there.
    const picked = await window.funsync.selectFunscript?.({ startIn: 'downloads' });
    if (!picked?.path) return;
    // Still downloading: the name the backend reserved for the video.
    const where = job.path || `${String(job.destDir || '').replace(/[\\/]+$/, '')}${String(job.destDir || '').includes('/') ? '/' : '\\'}${job.stem}.video`;
    const dir = where.replace(/[\\/][^\\/]*$/, '');
    const base = job.path ? where.slice(dir.length + 1).replace(/\.[^.]+$/, '') : job.stem;
    const sep = where.includes('\\') ? '\\' : '/';
    const target = `${dir}${sep}${base}.funscript`;
    if (btn) btn.disabled = true;
    try {
      if (picked.path.toLowerCase() !== target.toLowerCase()) {
        if (await window.funsync.fileExists?.(target)) {
          if (!(await askReplaceFiles([`${base}.funscript`]))) return;
        }
        const content = await window.funsync.readFunscript(picked.path);
        if (typeof content !== 'string' || !(await window.funsync.writeFunscript(content, target))) {
          showToast(t('eroscripts.tab.pair.failed'), 'error');
          return;
        }
      }
      this._exists.set(target, true);
      const info = this._jobInfo.get(job.id);
      if (info) info.paired = target;
      if (info?.topicId != null) this._markDone(info.topicId, { script: target });
      showToast(t('eroscripts.tab.pair.done', { name: `${base}.funscript` }), 'success');
      if (this._isLibraryFolder(dir)) this._onSaved();
      this._repaintAll();
      this._renderJobs();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async _downloadPasted(state, btn) {
    const dest = this._destFolder();
    if (!dest) { showToast(t('eroscripts.tab.err.badFolder'), 'warn'); return; }
    const stem = stemForPost(state.name || state.link?.check?.name || state.link?.host || 'video');
    if (btn) btn.disabled = true;
    const r = await this._fetchJson('', {
      method: 'POST',
      body: JSON.stringify({ url: state.link.url, destDir: dest, stem, allowTube: this._get(SETTING_TUBE) === true, scriptIsOurs: false, meta: downloadMeta({ title: stem }) }),
    }).catch(() => ({ ok: false, body: null }));
    if (!r.ok || !r.body?.job) {
      if (btn) btn.disabled = false;
      showToast(errorText(r.body?.detail?.code), 'error');
      return;
    }
    const job = r.body.job;
    this._jobInfo.set(job.id, { topicId: null, script: null, scriptPath: null, stem: job.stem, title: stem, handled: false });
    this._jobs.push(job);
    this._paste?.close();
    // No card for it: the Downloads list shows it.
    this._renderJobs();
    this._toggleDownloads(true);
    this._startPolling();
  }

  _toggleDownloads(open = this._dlPop?.hidden) {
    if (!this._dlPop) return;
    this._dlPop.hidden = !open;
    this._dlBtn.setAttribute('aria-expanded', String(!!open));
    if (open) this._refreshJobs();
  }

  _paintDownloadsButton() {
    if (!this._dlBtn) return;
    const active = this._jobs.filter((j) => this._active(j)).length;
    // Paused ones (yours, or stopped when FunSync closed) wait for a Resume: counted too.
    const paused = this._jobs.filter((j) => j.status === 'paused' || (j.status === 'error' && j.resumable)).length;
    const words = active ? t('eroscripts.tab.downloadsActive', { count: active })
      : (paused ? t('eroscripts.tab.downloadsPaused', { count: paused }) : t('eroscripts.tab.downloadsHeading'));
    this._dlBtn.setAttribute('aria-label', words);
    this._dlBtn.title = words;
    const badge = this._dlBtn.querySelector('.es-view__dl-badge');
    badge.hidden = !(active || paused);
    badge.textContent = String(active || paused);
    badge.classList.toggle('es-view__dl-badge--paused', !active && paused > 0);
    this._dlBtn.classList.toggle('es-view__dl-btn--active', active > 0);
  }

  /**
   * The Downloads list. Rows are kept between refreshes, keyed by job: one is
   * rebuilt only when its buttons change (status, file, Pair); progress and
   * words update in place. It used to be rebuilt every second while anything
   * downloaded, which lost a Pause / Cancel press that spanned a refresh
   * (1 in 8 at 300 ms, test day 2026-11-24, B006) and threw away keyboard
   * focus every second.
   */
  _renderJobs() {
    this._paintDownloadsButton();
    const ul = this._jobsEl;
    if (!ul) return;
    if (!this._jobs.length) {
      this._jobRows = new Map();
      const li = document.createElement('li');
      li.className = 'es-view__job es-view__job--empty';
      li.textContent = t('eroscripts.tab.noDownloads');
      ul.replaceChildren(li);
      return;
    }
    const kept = this._jobRows || new Map();
    const rows = new Map();
    const order = [];
    for (const job of this._jobs) {
      const info = this._jobInfo.get(job.id);
      const canPair = !!(info && !info.script && !info.paired && (job.status === 'done' ? !!job.path : this._active(job) && !!job.stem));
      const file = job.path ? job.path.split(/[\\/]/).pop() : `${job.stem} · ${hostLabel(job.host)}`;
      const sig = [job.status, job.resumable === true, job.path || '', file, canPair].join('|');
      let row = kept.get(job.id);
      if (!row || row.sig !== sig) row = { sig, ...this._jobRow(job, file, canPair) };
      const pct = job.total ? Math.min(100, Math.round((job.bytes / job.total) * 100)) : (job.status === 'done' ? 100 : 0);
      row.fill.style.width = `${pct}%`;
      row.status.textContent = this._statusText(job, pct);
      // The column is narrow: the whole line on hover (2026-11-25, it cut the percent).
      row.status.title = row.status.textContent;
      row.name.title = job.url;
      rows.set(job.id, row);
      order.push(row.li);
    }
    this._jobRows = rows;
    // In order, moving only what is out of place (a moved node loses focus).
    order.forEach((li, i) => { if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null); });
    while (ul.children.length > order.length) ul.lastElementChild.remove();
  }

  /** One row of the Downloads list: {li, name, fill, status}. */
  _jobRow(job, file, canPair) {
    const li = document.createElement('li');
    li.className = `es-view__job es-view__job--${job.status}`;
    const name = document.createElement('span');
    name.className = 'es-view__job-name';
    name.textContent = file;
    name.title = job.url;
    const bar = document.createElement('span');
    bar.className = 'es-view__bar';
    const fill = document.createElement('span');
    fill.className = 'es-view__bar-fill';
    bar.appendChild(fill);
    const status = document.createElement('span');
    status.className = 'es-view__job-status';
    // The row's buttons in one group, so they stay on its line.
    const acts = document.createElement('span');
    acts.className = 'es-view__job-actions';
    li.append(name, bar, status, acts);
    if (canPair) {
      // Came without a script (a pasted link, a post with none): pair one,
      // even before the video has finished.
      acts.appendChild(this._button(t('eroscripts.tab.pair.button'), 'secondary', (b) => this._pairScript(job, b)));
    }
    // Icons, the words as their tooltip and label (Dave, 2026-11-22: "a
    // pause icon and an x would be best").
    if (this._active(job)) {
      acts.appendChild(this._iconButton(Pause, t('eroscripts.tab.card.pause'), (btn) => this._jobAction(job, 'pause', btn)));
      acts.appendChild(this._iconButton(X, t('common.cancel'), (btn) => this._jobAction(job, 'cancel', btn), 'danger'));
    } else if (job.status === 'paused' || (job.status === 'error' && job.resumable)) {
      acts.appendChild(this._iconButton(Play, t('eroscripts.tab.card.resume'), (btn) => this._jobAction(job, 'resume', btn)));
      acts.appendChild(this._iconButton(X, t('eroscripts.tab.discard'), (btn) => this._jobAction(job, 'cancel', btn), 'danger'));
    } else if (job.status === 'done' && job.path) {
      acts.appendChild(this._button(t('eroscripts.tab.showInFolder'), 'secondary', () => window.funsync.showInFolder?.(job.path)));
    }
    return { li, name, fill, status };
  }

  /** A download in the list that a Resume can still continue, or that is running. */
  _existingJob(match) {
    return this._jobs.find((j) => match(j) && (this._active(j) || j.status === 'paused' || (j.status === 'error' && j.resumable))) || null;
  }

  _pctOf(job) {
    return job.total ? Math.min(100, Math.round((job.bytes / job.total) * 100)) : 0;
  }

  /** Resume it (stopped, paused, failed part-way), or Show it (running), from a download window. */
  _existingJobButton(job, closeWindow) {
    const running = this._active(job);
    const b = this._button(t(running ? 'eroscripts.tab.interrupted.show' : 'eroscripts.tab.card.resume'), 'primary', async (btn) => {
      closeWindow?.();
      if (!running) await this._jobAction(job, 'resume', btn);
      this._toggleDownloads(true);
    });
    b.classList.add('es-dl__main');
    return b;
  }

  /** Pause, Resume or Cancel / Discard one download, then read the list again. */
  async _jobAction(job, action, btn) {
    if (btn) btn.disabled = true;
    // A Gofile download brought back after FunSync closed: its file link and
    // guest cookie are never saved, so the app looks them up again.
    let body;
    if (action === 'resume' && job.needsResolve) {
      const g = await this._gofile({ url: job.url, host: 'gofile' }, job.meta?.script?.name || '');
      if (!g?.ok) {
        if (btn) btn.disabled = false;
        showToast(errorText(g?.error), 'error');
        return;
      }
      body = JSON.stringify({ resolved: { link: g.link, name: g.name, size: g.size, cookie: g.cookie } });
    }
    const r = await this._fetchJson(`/${job.id}/${action}`, { method: 'POST', ...(body ? { body } : {}) }).catch(() => ({ ok: false }));
    if (btn) btn.disabled = false;
    if (!r.ok && action === 'resume') showToast(errorText(r.body?.detail?.code), 'error');
    await this._refreshJobs();
    if (action === 'resume') this._startPolling();
  }

  _statusText(job, pct) {
    // Pause / Cancel asked for, a read still waiting on a stalled connection
    // (it ends at its timeout): said, so a press is not repeated (Dave,
    // 2026-11-26: Cancel pressed three times on a frozen card).
    if (job.stopping && (job.status === 'downloading' || job.status === 'resolving')) return t('eroscripts.tab.status.stopping');
    // No bytes for a while: the network, said, instead of a frozen card.
    if (job.status === 'downloading' && (job.stalledFor || 0) >= STALL_SECONDS) return t('eroscripts.tab.status.stalled', { seconds: job.stalledFor });
    switch (job.status) {
      case 'paused':
        // Stopped by FunSync closing, not by you: said so, with how far it got.
        if (job.interrupted) {
          return job.total
            ? t('eroscripts.tab.status.interrupted', { percent: pct, size: formatBytes(job.total) })
            : t('eroscripts.tab.status.interruptedUnknown', { done: formatBytes(job.bytes) });
        }
        return job.total
          ? t('eroscripts.tab.status.paused', { percent: pct, size: formatBytes(job.total) })
          : t('eroscripts.tab.status.pausedUnknown', { done: formatBytes(job.bytes) });
      case 'queued': return t('eroscripts.tab.status.queued');
      case 'resolving': return t('eroscripts.tab.status.resolving');
      case 'downloading': return job.total
        ? t('eroscripts.tab.status.downloading', { percent: pct, size: formatBytes(job.total), speed: formatBytes(job.speed) })
        : t('eroscripts.tab.status.downloadingUnknown', { done: formatBytes(job.bytes) });
      case 'done': return t('eroscripts.tab.status.done', { size: formatBytes(job.bytes || job.total) });
      case 'cancelled': return t('eroscripts.tab.status.cancelled');
      default: return errorText(job.error);
    }
  }

  // --- small builders ----------------------------------------------------------

  _p(cls, text) { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; }

  _h(text) { const h = document.createElement('h3'); h.className = 'es-view__section'; h.textContent = text; return h; }

  _label(text) { const s = document.createElement('span'); s.className = 'es-dl__label'; s.textContent = text; return s; }

  /** Works / Link dead / Not checked / Checking: a dot, its word as the title. */
  _dot(status) {
    const d = document.createElement('span');
    d.className = `es-dot es-dot--${status}`;
    d.title = t(`eroscripts.tab.check.${status}`);
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', d.title);
    return d;
  }

  /**
   * Watch: stream `link` into the player with the post's script, saving
   * nothing in the library (Dave, 2026-11-22: "can we try to stream into
   * funsyncs own player"). The script waits in the app's stream-scripts folder.
   */
  async _watch(link, { post = null, script = null, tube = false } = {}, btn = null) {
    if (!this._playStream || this._watching) return false;
    this._watching = true;
    const run = (this._watchRun = (this._watchRun || 0) + 1);
    const stale = () => run !== this._watchRun;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = t('eroscripts.tab.watch.finding'); }
    // The steps, in the window (2026-11-23: "Finding…" on the button for up
    // to 20 s, then a black player, said nothing).
    const status = this._watchStatus(btn, () => { this._watchRun++; done(); });
    const done = () => {
      this._watching = false;
      if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; }
    };
    try {
      let scriptPath = null;
      let axes = null;
      if (script?.url) {
        status?.step(t('eroscripts.tab.watch.stepScript'));
        ({ scriptPath, axes } = await this._streamScripts(post, script));
        if (stale()) return false;
        if (!scriptPath) showToast(t('eroscripts.tab.watch.noScript'), 'warn');
      }
      // This link, then the post's other playable links, best first.
      const others = post
        ? rankLinks(post.links, { tube, title: post.answer?.title || post.topic?.title, scriptName: script?.name, creator: creatorOf(post) })
          .filter((l) => l.url !== link.url && canWatch(l, tube))
        : [];
      const tries = [link, ...others];
      let res = null;
      for (let i = 0; i < tries.length; i++) {
        status?.step(i === 0 ? t('eroscripts.tab.watch.stepFinding')
          : t('eroscripts.tab.watch.stepNext', { host: hostLabel(tries[i].host), n: i + 1, total: tries.length }));
        res = await this._resolveStream(tries[i].url);
        if (stale()) return false;
        if (res?.ok) break;
      }
      if (!res?.ok) {
        const key = `remoteVideo.err.${res?.kind || 'error'}`;
        const why = t(key);
        const reason = why === key ? t('remoteVideo.err.error') : why;
        if (status) status.fail(t(tries.length > 1 ? 'eroscripts.tab.watch.failedAll' : 'eroscripts.tab.watch.failed', { reason }), link.url);
        else showToast(t('eroscripts.tab.watch.failed', { reason }), 'error');
        return false;
      }
      const title = post ? (post.answer?.title || post.topic?.title) : '';
      const save = this._getSaveStreams() === true;
      // The video's own picture first; the post's image when the stream has none.
      const imageUrl = res.thumbnail || (save && post ? await this._postImage(post) : null);
      this._dl?.close();
      this._paste?.close();
      const saved = await this._playStream({ ...res, title: title || res.title }, scriptPath,
        axes && Object.keys(axes).length ? axes : null,
        { save, topicId: post?.topic?.id ?? null, imageUrl: imageUrl || null });
      if (saved?.key && post?.topic) this._tagSavedStream(saved.key, post, scriptPath);
      return true;
    } finally {
      if (!stale()) done();
    }
  }

  /**
   * A post's script (and its axis files) in the app's stream-scripts folder,
   * for Watch and Add to queue: {scriptPath, axes} (nulls when it failed).
   */
  async _streamScripts(post, script) {
    let scriptPath = null;
    let axes = null;
    try {
      const dir = await window.funsync.getStreamScriptsDir();
      const sep = dir.includes('\\') ? '\\' : '/';
      const target = `${dir}${sep}${streamScriptName(post?.topic?.id, script)}`;
      const got = await window.funsync.eroscriptsDownload(script.url, target);
      if (got?.success) scriptPath = target;
      const want = this._axesFor(script);
      if (scriptPath && want.length) axes = await this._saveAxes(want, dir, target.slice(dir.length + 1).replace(/\.funscript$/i, ''));
    } catch { scriptPath = null; }
    return { scriptPath, axes: axes && Object.keys(axes).length ? axes : null };
  }

  /** The post's picture for a saved stream's card. */
  async _postImage(post) {
    if (post?.topic?.thumbnail) return post.topic.thumbnail;
    try { return (await window.funsync.eroscriptsTopicImage?.(post?.topic?.id)) || null; } catch { return null; }
  }

  /** A saved stream from a post carries the post's tags, as a download does. */
  _tagSavedStream(key, post, scriptPath) {
    try { recordDownloadTags(this._settings, key, { topic: post.topic, answer: post.answer, scriptPath, video: true }); } catch { /* the stream is saved */ }
  }

  /**
   * "Add to queue" (2026-11-23): the post's script saved, the stream saved to
   * the library with it, and put at the end of the queue; nothing plays.
   */
  async _queueFromPost(link, { post, script }, btn) {
    if (!this._queueStream) return false;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = t('eroscripts.tab.watch.stepScript'); }
    try {
      const { scriptPath, axes } = script?.url ? await this._streamScripts(post, script) : { scriptPath: null, axes: null };
      const saved = await this._queueStream({
        pageUrl: link.url,
        title: post.answer?.title || post.topic?.title,
        site: hostLabel(link.host),
        scriptPath, axes,
        topicId: post.topic?.id ?? null,
        imageUrl: await this._postImage(post),
      });
      if (saved?.key) this._tagSavedStream(saved.key, post, scriptPath);
      if (saved) this._dl?.close();
      return !!saved;
    } finally {
      if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
  }

  /** The "Save to library" tick under Watch (on unless turned off, remembered). */
  _saveTick() {
    const row = document.createElement('label');
    row.className = 'es-view__tube es-dl__save';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this._getSaveStreams() === true;
    cb.addEventListener('change', () => this._setSaveStreams(cb.checked));
    const text = document.createElement('span');
    text.textContent = t('remoteVideo.saveToLibrary');
    row.append(cb, text);
    return row;
  }

  /** A choice's axis files to fetch: all of them, unless "every axis" is off. */
  _axesFor(script) {
    return script?.axes?.length && this._get(SETTING_AXES) !== false ? script.axes : [];
  }

  /**
   * Save a set's axis files beside its main script as <base>.<axis>.funscript,
   * the names the library pairs on its own. {suffix: path} of those saved.
   */
  async _saveAxes(axes, dir, base) {
    const sep = dir.includes('\\') ? '\\' : '/';
    const saved = {};
    for (const a of axes || []) {
      const path = `${dir}${sep}${base}.${a.suffix}.funscript`;
      try {
        const res = await window.funsync.eroscriptsDownload(a.url, path);
        if (res?.success) { saved[a.suffix] = path; this._exists.set(path, true); }
      } catch { /* that axis stays on the forum */ }
    }
    return saved;
  }

  /** "Multi-axis: Pitch, Roll" and the choice to take every axis or the main script only. */
  _axesRow(script, p) {
    const box = document.createElement('div');
    box.className = 'es-dl__axes';
    box.appendChild(this._p('es-dl__sub', t('eroscripts.tab.dl.multiAxis', { axes: script.axes.map((a) => a.label).join(', ') })));
    const row = document.createElement('label');
    row.className = 'es-view__tube es-dl__axes-all';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this._get(SETTING_AXES) !== false;
    cb.addEventListener('change', () => { this._set(SETTING_AXES, cb.checked); this._renderDl(p); });
    const text = document.createElement('span');
    text.textContent = t('eroscripts.tab.dl.allAxes', { count: script.axes.length + 1 });
    row.append(cb, text);
    box.appendChild(row);
    return box;
  }

  /**
   * The line under a window's buttons that says what Watch is doing, with
   * Cancel; on a failure, why, with Open in browser. Null when the button is
   * not in a window (then a failure is a toast).
   */
  _watchStatus(btn, onCancel) {
    const box = btn?.closest?.('.es-dl');
    if (!box) return null;
    box.querySelector('.es-dl__watch-status')?.remove();
    const el = document.createElement('div');
    el.className = 'es-dl__watch-status';
    el.setAttribute('role', 'status');
    const spin = document.createElement('span');
    spin.className = 'es-dl__watch-spin';
    spin.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'es-dl__watch-text';
    const cancel = this._button(t('common.cancel'), 'secondary', () => { el.remove(); onCancel(); });
    cancel.classList.add('es-dl__watch-cancel');
    el.append(spin, text, cancel);
    const actions = box.querySelector('.es-dl__actions');
    if (actions) actions.after(el); else box.appendChild(el);
    return {
      step: (msg) => { text.textContent = msg; },
      fail: (msg, url) => {
        el.classList.add('es-dl__watch-status--failed');
        el.setAttribute('role', 'alert');
        spin.remove();
        text.textContent = msg;
        cancel.remove();
        el.appendChild(this._button(t('eroscripts.tab.openInBrowser'), 'secondary', () => window.funsync.openExternal(url)));
      },
    };
  }

  /** A small square icon button; `label` is its tooltip and its name for screen readers. */
  _iconButton(svgIcon, label, onClick, tone = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `es-view__icon-btn${tone ? ` es-view__icon-btn--${tone}` : ''}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(svgIcon, { width: 15, height: 15, 'stroke-width': 2.25 }));
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  _button(label, kind, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `eroscripts-panel__btn${kind === 'secondary' ? ' eroscripts-panel__btn--secondary' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  /** Language switch: every string again, from state. */
  retranslate() {
    if (!this._built) return;
    this._paintStatic();
    this._paintToolbar();
    this._rerender();
    this._renderDl();
    this._renderJobs();
  }
}
