// SettingsPanel — App settings modal with tabs (Sources, Playback, Data)

import { Modal } from './modal.js';
import { icon, Trash2, Pencil, GripVertical } from '../js/icons.js';
import { showToast } from '../js/toast.js';
import { classifyOverlap } from '../js/path-utils.js';
import { t, SUPPORTED_LOCALES, LOCALE_LABELS, setLocale, getCurrentLocale } from '../js/i18n.js';
import { createToggleSwitch } from './toggle-switch.js';
import { createPatternTestSession } from '../js/filler-test-player.js';
import {
  readPatternChoice, readOrgasmSource, patternChoiceWrites, orgasmSourceWrites, patternChoicePlayer,
} from '../js/pattern-choice.js';
import { isUserEnabled, isToggleLocked, setUserEnabled } from '../js/source-state.js';
import { eventBus } from '../js/event-bus.js';
import { openFeedbackModal } from './feedback-modal.js';
import { GlobalHotkeysSettings } from './global-hotkeys-settings.js';
import { NAV_HIDEABLE_ITEMS } from './nav-bar.js';
import { binOs } from '../js/recycle-bin.js';
import { edgeHoldAction } from '../js/pattern-source.js';
import { createPatternSummaryRow, openPatternDrawer } from './pattern-drawer.js';
import { StashSettingsBlock } from './settings-stash.js';

// Interface size (V79). The steps and the default come from main's
// electron/ui-scale.js through the preload, so the select can only offer
// what main applies and labels the default store.js actually has.
const uiScaleDefault = () => Number(globalThis.window?.funsync?.uiScaleDefault) || 100;
function uiScaleSteps() {
  const steps = globalThis.window?.funsync?.uiScaleSteps;
  return Array.isArray(steps) && steps.length ? steps.map(Number) : [uiScaleDefault()];
}
/** A stored value as the nearest offered step (a hand-edited 120 shows as 125). */
function nearestUiScale(value, steps) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return uiScaleDefault();
  return steps.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), steps[0]);
}

// Canonical default values for each tunable Playback field. Used by the
// per-field reset-to-default `↻` button (Shneiderman #6 reversibility)
// and the "at default" dot indicator (Nielsen #1 visibility). When you
// add a new tunable setting, also add its default here so users can
// reset and see the default state.
const SETTINGS_DEFAULTS = {
  'player.gapSkip.mode': 'off',
  'player.gapFiller.enabled': false,
  'player.gapFiller.presetId': 'slowTease',
  // Fill gaps longer than (s). Absent, app.js uses Gap Skip's threshold,
  // else 10 s; ↻ writes 10 s.
  'player.gapFiller.thresholdSec': 10,
  'player.gapSkip.thresholdSec': 10,
  'player.upNext.mode': 'auto',
  'player.upNext.countdownSec': 10,
  'player.autoplayOnAdvance': false,
  // MUST match electron/store.js — see the note on preferMultiAxis there.
  'player.autoplayOnOpen': false,
  'player.rangeExtender.enabled': false,
  // MUST match electron/store.js — see the note on preferMultiAxis there.
  'player.rangeLivePreview': true,
  // 'multi' since 0.9.3. It was 'single', which meant a user who had gone to
  // the trouble of downloading .pitch/.roll companions and owned an OSR2 got
  // single-axis playback with nothing anywhere saying why — the files were
  // detected and then deliberately ignored (stingray, PM: "multi-axis scripts
  // don't actually play in multi-axis"). Auto-promotion is already
  // conservative: it never touches a video whose association the user has set
  // themselves, so a safer default costs nothing.
  'player.preferMultiAxis': 'multi',
  'player.smoothing': 'linear',
  'player.speedLimit': 0,
  'player.linearStrategy': 'action-boundary',
  'player.linearLookaheadMs': 60,
  'player.minStrokeMs': 60,
  'library.movingPreviews': true,
  'library.folderPreviews': true,
  // MUST match electron/store.js (FT-102).
  'library.folderScriptsAsVariants': false,
  // Off: cards look as they always did (P1 tags, Round 3). MUST match electron/store.js.
  'library.showTagsOnCards': false,
  // Off since 0.9.3 (promised to lr_x3). MUST match electron/store.js.
  'player.miniPlayer': false,
};

// The keys v0.9.2 reads, as it stored them. A Pattern block never writes
// them (a downgrade must find them exactly as they were); pattern-choice.js
// promises the same, and this holds it to that.
const OLD_PATTERN_KEYS = new Set([
  'player.orgasmPattern', 'player.orgasmLibraryPattern', 'player.edgePattern',
  'player.gapFiller.presetId', 'player.gapFiller.custom',
]);
const OLD_GAP_FILLER_FIELDS = ['presetId', 'custom'];

/**
 * patternChoiceWrites' list as it may be saved: an old key is dropped, and a
 * whole `player.gapFiller` keeps presetId / custom exactly as read (present
 * or absent).
 * @param {{key: string, value: any}[]} writes
 * @param {object} player — settings.player as read before the change
 */
export function safePatternWrites(writes, player) {
  const out = [];
  for (const w of Array.isArray(writes) ? writes : []) {
    if (!w || typeof w.key !== 'string' || OLD_PATTERN_KEYS.has(w.key)) continue;
    if (w.key === 'player' || w.key === 'player.gapFiller') {
      // Whole objects: put the old fields back as they were read.
      const read = w.key === 'player' ? (player || {}) : (player?.gapFiller || {});
      const value = w.value && typeof w.value === 'object' ? { ...w.value } : w.value;
      if (value && typeof value === 'object') {
        if (w.key === 'player') {
          for (const k of ['orgasmPattern', 'orgasmLibraryPattern', 'edgePattern', 'gapFiller']) {
            if (k in read) value[k] = read[k]; else delete value[k];
          }
        } else {
          for (const k of OLD_GAP_FILLER_FIELDS) {
            if (k in read) value[k] = read[k]; else delete value[k];
          }
        }
      }
      out.push({ key: w.key, value });
      continue;
    }
    out.push({ key: w.key, value: w.value });
  }
  return out;
}

export class SettingsPanel {
  constructor({
    settings,
    onSourcesChanged,
    onGapSkipChanged,
    onGapFillerChanged,
    onUpNextChanged,
    onPreferMultiAxisChanged,
    getMultiAxisEligibleCount,
    onFindDuplicates,
    onSmoothingChanged,
    onSpeedLimitChanged,
    onLinearStrategyChanged,
    onLinearLookaheadChanged,
    onMinStrokeChanged,
    onRangeExtenderChanged,
    onInlineVizOpacityChanged,
    onInlineHeatmapPlayheadChanged,
    onDeviceSimOpacityChanged,
    onLibraryDisplayChanged,
    onNavHiddenChanged,
    onPickOrgasmScript,
    onClearOrgasmScript,
    getOrgasmScriptName,
    onOrgasmPatternChanged,
    getConnectionState,
    getUnreachableSources,
    getFailedScanSources,
    onRecheckSources,
    onTestFillerPattern,
    onStopFillerTest,
    getStashVideos,
    onOpenStashCheck,
  }) {
    this._settings = settings;
    // Settings > Sources > Stash (S1): Sync now sends the library's videos
    // (app.js has them), and a Need-a-check row's Choose… opens that video's
    // dialog at File on its Stash choice (app.js → library.js).
    this.getStashVideos = getStashVideos || (() => []);
    this.onOpenStashCheck = onOpenStashCheck || null;
    // Filler test button. The panel owns no devices — app.js holds the sync
    // engines, so it hands back a start/stop pair and reports progress.
    this.onTestFillerPattern = onTestFillerPattern || null;
    this.onStopFillerTest = onStopFillerTest || null;
    this._onSourcesChanged = onSourcesChanged;
    // Reachability lives on the library/app side; the panel only reads it.
    // Supplied as a GETTER, not a value, so a re-probe is reflected without
    // re-constructing the panel.
    this.getUnreachableSources = getUnreachableSources || (() => new Set());
    // Sources whose folder exists but could not be read on the last scan.
    // Only the Recheck summary reads this; it does not lock the toggle.
    this.getFailedScanSources = getFailedScanSources || (() => new Set());
    this.onRecheckSources = onRecheckSources || null;
    this.onGapSkipChanged = onGapSkipChanged || null;
    // Every option app.js passes has to be named above AND kept here: a key
    // the destructuring leaves out is dropped without a word, and the
    // `if (this.onX)` at its call site then quietly does nothing. These two
    // were passed and dropped, so gap filler and the simulator opacity only
    // applied on the next video / restart (app test V71). Pinned by
    // settings-panel-callbacks.test.js.
    this.onGapFillerChanged = onGapFillerChanged || null;
    this.onUpNextChanged = onUpNextChanged || null;
    this.onPreferMultiAxisChanged = onPreferMultiAxisChanged || null;
    this.getMultiAxisEligibleCount = getMultiAxisEligibleCount || null;
    // Opens the duplicate-finder modal. app.js owns it because it needs the
    // library's video list and has to trigger a rescan after files are removed.
    this.onFindDuplicates = onFindDuplicates || null;
    this.onSmoothingChanged = onSmoothingChanged || null;
    this.onSpeedLimitChanged = onSpeedLimitChanged || null;
    this.onLinearStrategyChanged = onLinearStrategyChanged || null;
    this.onLinearLookaheadChanged = onLinearLookaheadChanged || null;
    this.onMinStrokeChanged = onMinStrokeChanged || null;
    this.onRangeExtenderChanged = onRangeExtenderChanged || null;
    this.onInlineVizOpacityChanged = onInlineVizOpacityChanged || null;
    // HM playhead marker (#381): app.js applies it to the live overlay.
    this.onInlineHeatmapPlayheadChanged = onInlineHeatmapPlayheadChanged || null;
    this.onDeviceSimOpacityChanged = onDeviceSimOpacityChanged || null;
    this.onLibraryDisplayChanged = onLibraryDisplayChanged || null;
    // Navigation bar section (#381): app.js re-applies the hidden map.
    this.onNavHiddenChanged = onNavHiddenChanged || null;
    this.onPickOrgasmScript = onPickOrgasmScript || null;
    this.onClearOrgasmScript = onClearOrgasmScript || null;
    this.getOrgasmScriptName = getOrgasmScriptName || null;
    // Orgasm Switch source "Generated pattern" (#373): app.js reloads the
    // finisher from the saved `player.orgasmPattern`.
    this.onOrgasmPatternChanged = onOrgasmPatternChanged || null;
    // Optional — returns a snapshot of device connection state for the
    // "Report a problem" dialog. Caller (app.js) owns the device managers
    // so it's the natural place to read this from.
    this.getConnectionState = getConnectionState || (() => ({}));
  }

  /**
   * Confirmation modal shown before flipping `player.preferMultiAxis`
   * from 'single' to 'multi'. Surfaces the count of eligible videos
   * because the action is one-way: switching back to Single does NOT
   * revert auto-assigned videos. Returns true if the user confirmed,
   * false if cancelled (Esc / backdrop / Cancel button).
   */
  _confirmMultiAxisToggle(eligibleCount) {
    // A number (eligible only) or `{ eligible, assigned }`, where `assigned`
    // counts videos with companions that already have a playback mode.
    const detail = (eligibleCount && typeof eligibleCount === 'object') ? eligibleCount : null;
    const raw = detail ? detail.eligible : eligibleCount;
    const count = (typeof raw === 'number' && raw >= 0) ? raw : null;
    const assigned = (typeof detail?.assigned === 'number') ? detail.assigned : 0;
    const subjectLine = (count == null)
      ? t('settingsPanel.multiAxisConfirm.bodyUnknown')
      : count > 0
        ? t('settingsPanel.multiAxisConfirm.bodyCount', { count })
        // Nothing to assign. "No videos have companion files" is only true
        // when none are already assigned either (V39).
        : assigned > 0
          ? t('settingsPanel.multiAxisConfirm.bodyAllAssigned')
          : t('settingsPanel.multiAxisConfirm.bodyNone');

    return Modal.open({
      title: t('settingsPanel.multiAxisConfirm.title'),
      onRender: (body, close) => {
        const msg = document.createElement('div');
        msg.className = 'modal-message';
        msg.textContent = subjectLine;
        body.appendChild(msg);

        const warning = document.createElement('div');
        warning.className = 'modal-message';
        warning.style.marginTop = '12px';
        warning.style.color = 'var(--text-secondary)';
        warning.textContent = t('settingsPanel.multiAxisConfirm.warning');
        body.appendChild(warning);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn--secondary';
        cancelBtn.textContent = t('common.cancel');
        cancelBtn.addEventListener('click', () => close(false));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn';
        confirmBtn.textContent = t('settingsPanel.multiAxisConfirm.confirm');
        confirmBtn.addEventListener('click', () => close(true));

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        body.appendChild(actions);
      },
    }).then((v) => v === true);
  }

  async show() {
    let unsubscribeLang = null;
    let unsubscribeScale = null;
    await Modal.open({
      title: t('settingsPanel.modalTitle'),
      // Its own panel layout (modal.css): the dialog body never scrolls,
      // only the content column (and the rail if it cannot fit). The plain
      // dialog body scrolled too, so at 125% Settings had two nested
      // scrollbars (FT-039).
      panelClass: 'modal-panel--settings',
      // Escape with a pattern drawer open closes the drawer (its draft
      // discarded), not Settings.
      onEscape: () => (this._patternDrawer?.isOpen() ? this._patternDrawer.cancel() : false),
      onRender: (body, close) => {
        this._renderBody(body, close, 'sources');

        // Ctrl+= / Ctrl+- / Ctrl+0 with Settings open: main saved the new
        // interface size; show it in the select (V79).
        unsubscribeScale = eventBus.on('settings:changed', ({ path, value } = {}) => {
          if (path !== 'player.uiScale') return;
          const select = body.querySelector('[data-setting="player.uiScale"]');
          if (select) select.value = String(nearestUiScale(value, uiScaleSteps()));
        });

        // Re-render on locale change — strings are baked via t() into the
        // tab labels, section headers, hints, etc. at render time, so
        // translatePage() alone doesn't catch them. Preserve the active
        // tab so the user stays where they were when they picked the
        // language (otherwise they'd get bounced back to Sources).
        unsubscribeLang = eventBus.on('language:changed', () => {
          // From the rail's own state (activateArea sets it). This used to
          // query `.settings-panel__tab--active`, a class from the old
          // horizontal tab strip that nothing sets any more, so every
          // language change bounced the panel back to Sources and the
          // refocus below never ran (app test V49).
          const activeTab = this._activeTabId || 'sources';
          const scrollTop = this._contentEl?.scrollTop || 0;
          // Update the modal chrome (title + close button) that lives in
          // the parent panel, outside our body.
          const panel = body.closest('.modal-panel');
          const titleEl = panel?.querySelector('.modal-title');
          if (titleEl) titleEl.textContent = t('settingsPanel.modalTitle');
          const closeBtn = panel?.querySelector('.modal-close-btn');
          if (closeBtn) {
            closeBtn.setAttribute('aria-label', t('modal.closeAria', { title: t('settingsPanel.modalTitle') }));
            closeBtn.title = t('common.close');
          }
          this._renderBody(body, close, activeTab);
          // activateArea scrolls to the top; put the user back where they
          // were in the area they stayed on.
          if (this._contentEl) this._contentEl.scrollTop = scrollTop;
          // Re-focus the language picker so keyboard users keep their
          // place after the rebuild wipes the DOM they were on.
          if (activeTab === 'appearance') {
            const langSelect = body.querySelector('[data-setting="player.language"]');
            if (langSelect) langSelect.focus();
          }
        });
      },
    });
    if (unsubscribeLang) unsubscribeLang();
    if (unsubscribeScale) unsubscribeScale();
    // The Stash block listens to main (sync progress, data changes) and may
    // hold an Undo; closing Settings ends both (an Undo moves to a toast).
    this._stashBlock?.destroy();
    this._stashBlock = null;
    this._closeSettings = null;
    // A Pattern block's test does not outlive its Stop button.
    this._endPatternBlocks();
  }

  /**
   * A feature's pattern in Settings (Dave, 2026-11-19 ~14:20: the sections
   * were "rather big"): ONE summary row (pattern-drawer.js
   * createPatternSummaryRow: the applied choice in a line, its small graph,
   * "Set pattern…"), the same for Gap Filler, Orgasm Switch and Edge Hold.
   * "Set pattern…" opens the shared drawer around the Pattern block
   * (pattern-source-rows.js) on a DRAFT; only Apply saves it, through
   * patternChoiceWrites: the keys that names and nothing else
   * (safePatternWrites drops an old key all the same).
   * @returns {{ row: object, read: () => object, refresh: () => void, open: () => void }|null}
   */
  _mountPatternSetting(feature, mount, {
    idPrefix, title, featureName, label, oneShotHint, onSaved, sampleOptions,
  } = {}) {
    if (!mount) return null;
    // The same reader app.js plays from, so the row shows what plays.
    const read = () => readPatternChoice(feature, this._choicePlayer());
    let row = null;
    const open = () => {
      this._patternDrawer?.cancel();
      const host = this._dialogPanel || mount.closest('.modal-panel') || document.body;
      this._patternDrawer = openPatternDrawer({
        host,
        idPrefix,
        feature,
        title,
        label,
        oneShotHint,
        sampleOptions,
        value: read(),
        testSession: this._patternTestSession(),
        // Why nothing played: a video owns the devices, or none is connected.
        onTestRefused: (status) => showToast(
          t(status === 'busy' ? 'toast.fillerTestBusy' : 'toast.fillerTestNoDevices'), 'info', 3000,
        ),
        onApply: (choice) => {
          const player = this._choicePlayer();
          for (const { key, value } of safePatternWrites(patternChoiceWrites(feature, choice, player), player)) {
            this._settings.set(key, value);
          }
          row.setValue(read());
          if (onSaved) onSaved(choice);
        },
        onClose: () => {
          this._patternDrawer = null;
          // Back where the user was: the button that opened it.
          if (row.button.isConnected) row.button.focus();
        },
      });
    };
    row = createPatternSummaryRow({
      idPrefix, featureName, feature, sampleOptions, value: read(), onSet: open,
    });
    mount.appendChild(row.element);
    (this._patternRows ||= []).push(row);
    return { row, read, refresh: () => row.refresh(), open };
  }

  /** settings.player as the three blocks read it (pattern-choice.js patternChoicePlayer, as app.js). */
  _choicePlayer() {
    return patternChoicePlayer((path) => this._settings.get(path));
  }

  /**
   * One Test at a time across the three blocks, through app.js's existing
   * test path (it refuses while a video drives the devices: 'busy').
   */
  _patternTestSession() {
    if (!this._patternTest) {
      this._patternTest = createPatternTestSession({
        start: (actions, hooks) => this.onTestFillerPattern?.(actions, hooks),
        stop: () => this.onStopFillerTest?.(),
      });
    }
    return this._patternTest;
  }

  /** Close a pattern drawer (its draft discarded), stop a running test, let go of the rows (Settings closed or rebuilt). */
  _endPatternBlocks() {
    this._patternDrawer?.cancel();
    this._patternDrawer = null;
    this._patternTest?.stop();
    for (const row of this._patternRows || []) row.destroy();
    this._patternRows = [];
  }

  /**
   * Areas shown in the left rail, and the section groups each one expands
   * to. `groups` entries are `{ id, label }` where `id` is the DOM id of a
   * `.settings-panel__section` inside that area's panel — the rail scrolls
   * to it and highlights whichever is currently in view.
   *
   * Only areas that are genuinely long carry groups. Sources is long too,
   * but it's ONE list (add / rename / reorder / enable), so splitting it
   * would invent divisions that aren't there.
   */
  _railAreas() {
    const isLinux = (typeof window !== 'undefined' && window.funsync?.platform === 'linux');
    return [
      { id: 'sources', label: t('settingsPanel.tabSources'), groups: [] },
      {
        id: 'playback',
        label: t('settingsPanel.tabPlayback'),
        groups: [
          { id: 'sp-sec-playback', label: t('settingsPanel.playback.playbackHeader') },
          { id: 'sp-sec-upnext', label: t('settingsPanel.playback.upNextHeader') },
          { id: 'sp-sec-gapskip', label: t('settingsPanel.playback.gapSkipHeader') },
          // Dave, 2026-11-19 ~15:05 ("Add both"): the three pattern features
          // each have an entry, next to each other.
          { id: 'sp-sec-gapfiller', label: t('settingsPanel.playback.fillerHeader') },
          { id: 'sp-sec-orgasm', label: t('settingsPanel.playback.orgasmHeader') },
          { id: 'sp-sec-edge', label: t('settingsPanel.playback.edgeHeader') },
          { id: 'sp-sec-global-hotkeys', label: t('settingsPanel.playback.globalHotkeysHeader') },
          { id: 'sp-sec-multiaxis', label: t('settingsPanel.playback.multiHeader') },
          // Linux-only setting, so the group would otherwise be an empty
          // rail entry on Windows.
          ...(isLinux ? [{ id: 'sp-sec-video', label: t('settingsPanel.playback.videoHeader') }] : []),
        ],
      },
      { id: 'editor', label: t('settingsPanel.tabEditor'), groups: [] },
      {
        id: 'appearance',
        label: t('settingsPanel.tabAppearance'),
        groups: [
          { id: 'sp-sec-theme', label: t('settingsPanel.appearance.themeHeader') },
          { id: 'sp-sec-style', label: t('settingsPanel.appearance.styleHeader') },
          { id: 'sp-sec-scale', label: t('settingsPanel.appearance.scaleHeader') },
          { id: 'sp-sec-language', label: t('settingsPanel.appearance.languageHeader') },
          { id: 'sp-sec-library', label: t('settingsPanel.appearance.libraryHeader') },
          { id: 'sp-sec-nav', label: t('settingsPanel.appearance.navHeader') },
        ],
      },
      { id: 'data', label: t('settingsPanel.tabData'), groups: [] },
      { id: 'security', label: t('settingsPanel.tabSecurity'), groups: [] },
      { id: 'help', label: t('settingsPanel.tabHelp'), groups: [] },
    ];
  }

  /** Mark one rail group link active, clearing the rest. */
  _markRailGroupActive(sectionId) {
    if (!this._railEl) return;
    for (const el of this._railEl.querySelectorAll('.settings-panel__rail-group')) {
      el.classList.toggle('settings-panel__rail-group--active', el.dataset.section === sectionId);
    }
  }

  /**
   * Highlight whichever group's section is currently at the top of the
   * content column. Runs on scroll and after an area switch, so the rail
   * agrees with the view whether the user clicked a link or just scrolled.
   *
   * Deliberately a scroll handler rather than IntersectionObserver: the
   * content column is a small, known scroller and this needs no observer
   * lifecycle to tear down when the dialog is rebuilt on a locale change.
   */
  _syncRailGroupHighlight() {
    const rail = this._railEl;
    const content = this._contentEl;
    if (!rail || !content) return;
    // A clicked group stays lit while its scroll runs and after it (FT-079):
    // the last sections can never reach the top, so the rule below marked
    // the one above them (Global hotkeys or Multi-Axis clicked, Orgasm Switch
    // lit). Released by the scroll's end or the user's own wheel, key or
    // pointer on the content (_releaseRailPin).
    if (this._railPin) {
      this._markRailGroupActive(this._railPin);
      return;
    }
    const visibleList = rail.querySelector('.settings-panel__rail-groups:not([hidden])');
    if (!visibleList) return;

    const links = [...visibleList.querySelectorAll('.settings-panel__rail-group')];
    if (links.length === 0) return;

    // A section counts as "current" once its top has passed just under the
    // top of the viewport; the last such section wins. The tolerance stops
    // a section sitting exactly at the edge from flickering between two.
    // Scrolled to the bottom, the last section whose top is in view wins:
    // the ones below the cutoff there can never pass it.
    const atBottom = content.scrollHeight > content.clientHeight
      && content.scrollTop + content.clientHeight >= content.scrollHeight - 2;
    const cutoff = atBottom ? content.scrollTop + content.clientHeight - 1 : content.scrollTop + 24;
    let currentId = links[0].dataset.section;
    for (const link of links) {
      const section = content.querySelector(`#${link.dataset.section}`);
      if (section && section.offsetTop <= cutoff) currentId = link.dataset.section;
    }
    this._markRailGroupActive(currentId);
  }

  /** The user scrolls or acts on the content themselves: the rail follows the view again. */
  _releaseRailPin() {
    this._railPin = null;
  }

  _renderBody(body, close, initialTabId) {
    // A rebuild (a language change) drops the Pattern blocks and their
    // Stop buttons: their test stops with them.
    this._endPatternBlocks();
    body.innerHTML = '';
    // Stash's "Choose…" closes Settings before it opens the video's dialog.
    this._closeSettings = close;
    // The pattern drawer opens over the whole dialog.
    this._dialogPanel = body.closest('.modal-panel');

    // Two-column shell: a vertical rail on the left, the active area's
    // panel scrolling on the right. Replaces the old horizontal tab strip,
    // which was at its limit at six tabs and had no room to surface the
    // sections inside the long ones.
    const layout = document.createElement('div');
    layout.className = 'settings-panel__layout';

    const rail = document.createElement('div');
    rail.className = 'settings-panel__rail';
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', t('settingsPanel.tabsAria'));

    const content = document.createElement('div');
    content.className = 'settings-panel__content';

    const areas = this._railAreas();
    const panels = {};
    const groupLists = {};

    const activateArea = (areaId, { focus = true } = {}) => {
      for (const a of areas) {
        const isActive = a.id === areaId;
        const item = rail.querySelector(`[data-area="${a.id}"]`);
        if (item) {
          item.classList.toggle('settings-panel__rail-item--active', isActive);
          item.setAttribute('aria-selected', isActive ? 'true' : 'false');
          item.tabIndex = isActive ? 0 : -1;
        }
        // Group links only make sense for the area you're in — showing all
        // of them at once would put the rail back where the tab strip was.
        if (groupLists[a.id]) groupLists[a.id].hidden = !isActive;
        if (panels[a.id]) panels[a.id].hidden = !isActive;
      }
      this._railPin = null; // a pin belongs to the area it was clicked in
      content.scrollTop = 0;
      this._activeTabId = areaId;
      const item = rail.querySelector(`[data-area="${areaId}"]`);
      if (focus && item) item.focus();
      this._syncRailGroupHighlight();
    };

    for (const area of areas) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-panel__rail-item';
      btn.dataset.area = area.id;
      btn.dataset.tab = area.id; // back-compat for anything querying by tab
      btn.textContent = area.label;
      btn.id = `settings-tab-${area.id}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('aria-controls', `settings-tabpanel-${area.id}`);
      btn.tabIndex = -1;
      btn.addEventListener('click', () => activateArea(area.id));
      rail.appendChild(btn);

      if (area.groups.length > 0) {
        const list = document.createElement('div');
        list.className = 'settings-panel__rail-groups';
        list.hidden = true;
        for (const group of area.groups) {
          const gBtn = document.createElement('button');
          gBtn.type = 'button';
          gBtn.className = 'settings-panel__rail-group';
          gBtn.dataset.section = group.id;
          gBtn.textContent = group.label;
          gBtn.addEventListener('click', () => {
            const target = content.querySelector(`#${group.id}`);
            if (!target) return;
            // Scroll the CONTENT column, not the page — the panel is the
            // scrolling container.
            // Pinned before the scroll starts: its scroll events must not
            // move the highlight off the group the user picked (FT-079).
            this._railPin = group.id;
            content.scrollTo({
              top: Math.max(0, target.offsetTop - 8),
              behavior: 'smooth',
            });
            this._markRailGroupActive(group.id);
          });
          list.appendChild(gBtn);
        }
        rail.appendChild(list);
        groupLists[area.id] = list;
      }
    }

    // Vertical tablist keyboard pattern (Nielsen #4 standards). Up/Down
    // now, not Left/Right — the rail is vertical.
    rail.addEventListener('keydown', (e) => {
      const items = [...rail.querySelectorAll('.settings-panel__rail-item')];
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      let next = -1;
      if (e.key === 'ArrowDown') next = (idx + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (idx - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next >= 0) {
        e.preventDefault();
        items[next].click();
      }
    });

    // Scroll-spy: highlight the group whose section is currently at the top
    // of the content column, so the rail keeps agreeing with what's on
    // screen when the user scrolls rather than clicks.
    this._railEl = rail;
    this._contentEl = content;
    this._railPin = null;
    content.addEventListener('scroll', () => this._syncRailGroupHighlight(), { passive: true });
    // A rail click's pin (FT-079) ends with its scroll, or as soon as the
    // user scrolls or acts on the content themselves.
    content.addEventListener('scrollend', () => this._releaseRailPin(), { passive: true });
    for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
      content.addEventListener(type, () => this._releaseRailPin(), { passive: true });
    }

    layout.appendChild(rail);
    layout.appendChild(content);
    body.appendChild(layout);

    // Helper — wire the per-tab panel ARIA + id pairing so the
    // tab→panel relationship is screen-reader-traversable.
    const wirePanel = (id) => {
      const p = panels[id];
      p.id = `settings-tabpanel-${id}`;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', `settings-tab-${id}`);
      content.appendChild(p);
      return p;
    };

    // --- Sources Tab ---
    panels.sources = this._buildSourcesTab();
    wirePanel('sources');

    // --- Playback Tab ---
    panels.playback = this._buildPlaybackTab();
    wirePanel('playback');

    // --- Editor Tab — script-authoring settings (position keys; future
    //     home for other editor-specific tunables). Sits between Playback
    //     and Appearance because it's content-side work that belongs
    //     next to playback in mental model, not next to theme settings. ---
    panels.editor = this._buildEditorTab();
    wirePanel('editor');

    // --- Appearance Tab (theme toggle) ---
    panels.appearance = this._buildAppearanceTab();
    wirePanel('appearance');

    // --- Data Tab ---
    panels.data = this._buildDataTab();
    wirePanel('data');

    // --- Security Tab ---
    panels.security = this._buildSecurityTab();
    wirePanel('security');

    // --- Help Tab ---
    panels.help = this._buildHelpTab();
    wirePanel('help');

    // Activate the requested initial area (defaults to 'sources' on first
    // render, but is preserved across locale-change rebuilds). No focus on
    // the initial pass — stealing focus as the dialog opens would move it
    // off whatever the modal itself focused.
    const activeId = panels[initialTabId] ? initialTabId : 'sources';
    activateArea(activeId, { focus: false });

    // Done button — dedicated class (was borrowing
    // `.library__assoc-save-btn` from the library multi-select flow,
    // a semantic class mismatch flagged by the design audit).
    const doneBtn = document.createElement('button');
    doneBtn.className = 'settings-panel__done-btn';
    doneBtn.textContent = t('settingsPanel.done');
    doneBtn.addEventListener('click', () => close());
    body.appendChild(doneBtn);
  }

  /**
   * Busy overlay for the sources tab.
   *
   * Reconnecting a source triggers a full library rescan, and on a large or
   * networked library that takes real time (Dave, 2026-08-11: "everything just
   * freezes, on the modal as well"). The main-process yields stop it being a
   * hard freeze, but the work is still slow, so the UI has to SAY it is
   * working rather than looking dead.
   *
   * Covers the whole tab, not just the button: the toggles and Add Source must
   * not be clickable mid-rescan or we queue a second scan behind the first.
   *
   * @param {boolean} on
   * @param {string} [message]
   */
  setSourcesBusy(on, message = '') {
    const panel = this._panel || this._container;
    const list = panel?.querySelector?.('.settings-panel__sources-list');
    if (!list) return;
    const host = list.parentElement || list;
    host.classList.toggle('settings-panel__sources--busy', !!on);

    let overlay = host.querySelector(':scope > .settings-panel__busy');
    if (on) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'settings-panel__busy';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        const spinner = document.createElement('span');
        spinner.className = 'settings-panel__busy-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'settings-panel__busy-text';
        overlay.appendChild(spinner);
        overlay.appendChild(text);
        host.appendChild(overlay);
      }
      overlay.querySelector('.settings-panel__busy-text').textContent =
        message || t('settingsPanel.sources.working');
    } else if (overlay) {
      overlay.remove();
    }
  }

  /** Repaint the sources list in place (after a re-probe). */
  refreshSources() {
    if (this._renderSources) this._renderSources();
  }

  _buildSourcesTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const sourcesList = document.createElement('div');
    sourcesList.className = 'settings-panel__sources-list';

    const renderSources = this._renderSources = () => {
      sourcesList.innerHTML = '';
      const sources = this._settings.get('library.sources') || [];
      const unreachable = this.getUnreachableSources() || new Set();

      if (sources.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'settings-panel__empty';
        empty.textContent = t('settingsPanel.sources.empty');
        sourcesList.appendChild(empty);
      } else {
        for (const src of sources) {
          const row = document.createElement('div');
          row.className = 'settings-panel__source-row';
          row.dataset.sourceId = src.id;
          row.draggable = true;
          if (src.enabled === false) row.classList.add('settings-panel__source-row--disabled');

          // Drag handle — reorder sources by dragging. Affects folder-view root
          // display order and persistence ordering. Native HTML5 DnD: dragstart
          // records the id, dragover targets highlight, drop swaps ids.
          const grip = document.createElement('span');
          grip.className = 'settings-panel__source-grip';
          grip.title = t('settingsPanel.sources.dragHandle');
          grip.appendChild(icon(GripVertical, { width: 14, height: 14 }));
          row.appendChild(grip);

          row.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', src.id);
            row.classList.add('settings-panel__source-row--dragging');
          });
          row.addEventListener('dragend', () => {
            row.classList.remove('settings-panel__source-row--dragging');
            sourcesList.querySelectorAll('.settings-panel__source-row--drop-target').forEach(el =>
              el.classList.remove('settings-panel__source-row--drop-target'));
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.classList.add('settings-panel__source-row--drop-target');
          });
          row.addEventListener('dragleave', () => {
            row.classList.remove('settings-panel__source-row--drop-target');
          });
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('settings-panel__source-row--drop-target');
            const draggedId = e.dataTransfer.getData('text/plain');
            if (!draggedId || draggedId === src.id) return;
            const srcs = this._settings.get('library.sources') || [];
            const fromIdx = srcs.findIndex(s => s.id === draggedId);
            const toIdx = srcs.findIndex(s => s.id === src.id);
            if (fromIdx < 0 || toIdx < 0) return;
            const [moved] = srcs.splice(fromIdx, 1);
            srcs.splice(toIdx, 0, moved);
            this._settings.set('library.sources', srcs);
            renderSources();
            if (this._onSourcesChanged) this._onSourcesChanged();
          });

          // Enable/disable toggle. Three states, not two: active, off (user
          // chose), and LOCKED (path unreachable). Off and locked must look
          // different or it reads as the app forgetting the setting.
          const locked = isToggleLocked(src, unreachable);
          const toggle = createToggleSwitch({
            checked: isUserEnabled(src),
            locked,
            className: 'settings-panel__source-toggle',
            label: src.name,
            title: locked
              ? t('settingsPanel.sources.unreachableHint')
              : (isUserEnabled(src)
                ? t('settingsPanel.sources.enabledHint')
                : t('settingsPanel.sources.disabledHint')),
            onChange: (next) => {
              const srcs = this._settings.get('library.sources') || [];
              // setUserEnabled is the ONLY writer of `enabled`, and it refuses
              // while unreachable — that refusal is what preserves the user's
              // last choice across a session where the drive was missing.
              const res = setUserEnabled(srcs, src.id, next, unreachable);
              // Explicit false = rejected, so the switch springs back rather
              // than sitting in a state the stored sources do not agree with.
              // (setUserEnabled refuses while the path is unreachable.)
              if (!res.changed) return false;
              this._settings.set('library.sources', res.sources);
              renderSources();
              // Switching a source ON rescans it. Show the same busy state as
              // Recheck, or the modal just sits there.
              if (this._onSourcesChanged) {
                this.setSourcesBusy(true, t('settingsPanel.sources.scanning'));
                Promise.resolve(this._onSourcesChanged())
                  .catch(() => { /* surfaced by the caller */ })
                  .finally(() => this.setSourcesBusy(false));
              }
              showToast(t('settingsPanel.sources.toggled', {
                name: src.name,
                state: res.enabled
                  ? t('settingsPanel.sources.stateEnabled')
                  : t('settingsPanel.sources.stateDisabled'),
              }), 'info');
            },
          });
          row.appendChild(toggle);
          if (locked) row.classList.add('settings-panel__source-row--unreachable');

          const info = document.createElement('div');
          info.className = 'settings-panel__source-info';
          const name = document.createElement('span');
          name.className = 'settings-panel__source-name';
          name.textContent = src.name;
          const path = document.createElement('span');
          path.className = 'settings-panel__source-path';
          path.textContent = src.path;
          path.title = src.path;
          info.appendChild(name);
          info.appendChild(path);
          if (locked) {
            const reason = document.createElement('span');
            reason.className = 'settings-panel__source-reason';
            reason.textContent = t('settingsPanel.sources.unreachableReason');
            info.appendChild(reason);
          }

          const actions = document.createElement('div');
          actions.className = 'settings-panel__source-actions';

          const renameBtn = document.createElement('button');
          renameBtn.className = 'settings-panel__source-btn';
          renameBtn.title = t('settingsPanel.sources.rename');
          renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
          renameBtn.addEventListener('click', async () => {
            const newName = await Modal.prompt(t('settingsPanel.sources.renameTitle'), t('settingsPanel.sources.nameLabel'), src.name);
            if (newName && newName !== src.name) {
              const srcs = this._settings.get('library.sources') || [];
              const target = srcs.find(s => s.id === src.id);
              if (target) { target.name = newName; this._settings.set('library.sources', srcs); renderSources(); if (this._onSourcesChanged) this._onSourcesChanged(); }
            }
          });

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'settings-panel__source-btn settings-panel__source-btn--danger';
          deleteBtn.title = t('settingsPanel.sources.remove');
          deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
          deleteBtn.addEventListener('click', async () => {
            // "Remove", not "Delete": the files stay on disk (the message
            // says so), and a red Delete button contradicted it.
            const confirmed = await Modal.confirm(t('settingsPanel.sources.removeTitle'), t('settingsPanel.sources.removeConfirm', { name: src.name }), { confirmText: t('common.remove') });
            if (confirmed) {
              // Pre-action snapshot — removing a source can cascade
              // into collection conversions, so this is one of the
              // bigger reversibility risks in the app.
              await window.funsync.backupPreAction?.('delete-source');

              // Auto-convert any synced collection that tracks this
              // source by id → folder-path mode, snapshotting the
              // source's path before it's deleted. Keeps the
              // collection tracking the same physical folder (the user
              // just needs to add it back as a source for videos to
              // show). Without this, sourceId would dangle forever and
              // the collection would silently empty.
              const { convertSourceIdToFolderPath } = await import('../js/collection-sync.js');
              const collections = this._settings.get('library.collections') || [];
              let convertedCount = 0;
              for (let i = 0; i < collections.length; i++) {
                if (collections[i].syncSource?.sourceId === src.id) {
                  collections[i] = convertSourceIdToFolderPath(collections[i], src.path);
                  convertedCount++;
                }
              }
              if (convertedCount > 0) {
                this._settings.set('library.collections', collections);
                showToast(
                  t('settingsPanel.sources.convertedCollections', { count: convertedCount }),
                  'info',
                  6000,
                );
              }

              const srcs = this._settings.get('library.sources') || [];
              this._settings.set('library.sources', srcs.filter(s => s.id !== src.id));

              // Clear the legacy `library.directory` singleton if it still
              // points at this source. Otherwise the migrate-on-load path
              // in `app.js::_refreshCollectionsUI` would re-add this source
              // on the next library refresh — only ever the FIRST source
              // ever added is affected (subsequent adds don't touch the
              // legacy key), so this fix is narrow but real.
              const legacyDir = this._settings.get('library.directory');
              if (legacyDir && legacyDir === src.path) {
                this._settings.set('library.directory', '');
              }

              renderSources();
              if (this._onSourcesChanged) this._onSourcesChanged();
              showToast(t('settingsPanel.sources.removed', { name: src.name }), 'info');
            }
          });

          actions.appendChild(renameBtn);
          actions.appendChild(deleteBtn);
          row.appendChild(info);
          row.appendChild(actions);
          sourcesList.appendChild(row);
        }
      }
    };

    renderSources();
    panel.appendChild(sourcesList);

    const addBtn = document.createElement('button');
    addBtn.className = 'settings-panel__add-btn';
    addBtn.textContent = t('settingsPanel.sources.add');
    addBtn.addEventListener('click', async () => {
      const dirPath = await window.funsync.selectDirectory();
      if (!dirPath) return;
      const srcs = this._settings.get('library.sources') || [];

      const overlap = classifyOverlap(dirPath, srcs);
      let removeChildrenIds = null;

      if (overlap.kind === 'exact') {
        showToast(t('settingsPanel.sources.alreadyAdded', { name: overlap.source.name }), 'warn');
        return;
      }

      if (overlap.kind === 'child') {
        const proceed = await Modal.confirm(
          t('settingsPanel.sources.childOverlapTitle'),
          t('settingsPanel.sources.childOverlapBody', { path: dirPath, parentName: overlap.parent.name, parentPath: overlap.parent.path }),
          { confirmText: t('settingsPanel.sources.addAnyway') },
        );
        if (!proceed) return;
      }

      if (overlap.kind === 'parent') {
        const childNames = overlap.children.map(c => `"${c.name}"`).join(', ');
        const msg = t('settingsPanel.sources.parentOverlapBody', { path: dirPath, count: overlap.children.length, names: childNames });
        const confirmed = await Modal.confirm(t('settingsPanel.sources.parentOverlapTitle'), msg, { confirmText: t('settingsPanel.sources.parentOverlapConfirm') });
        if (!confirmed) return;
        removeChildrenIds = new Set(overlap.children.map(c => c.id));
      }

      const name = await Modal.prompt(t('settingsPanel.sources.addNamePrompt'), t('settingsPanel.sources.addNamePlaceholder'), dirPath.split(/[\\/]/).pop());
      if (!name) return;

      let nextSrcs = srcs;
      if (removeChildrenIds) {
        nextSrcs = nextSrcs.filter(s => !removeChildrenIds.has(s.id));
      }
      nextSrcs = [...nextSrcs, { id: crypto.randomUUID(), name, path: dirPath, enabled: true }];
      this._settings.set('library.sources', nextSrcs);
      renderSources();
      if (this._onSourcesChanged) this._onSourcesChanged();
      showToast(t('settingsPanel.sources.added', { name }), 'info');
    });

    // Recheck: a source that was offline at launch is locked until something
    // re-probes it. Without this the only way back is restarting the app,
    // which is a poor answer to "I just turned the NAS on".
    const recheckBtn = document.createElement('button');
    recheckBtn.className = 'settings-panel__add-btn settings-panel__recheck-btn';
    recheckBtn.textContent = t('settingsPanel.sources.recheck');
    recheckBtn.title = t('settingsPanel.sources.recheckHint');
    recheckBtn.addEventListener('click', async () => {
      if (recheckBtn.disabled) return;
      recheckBtn.disabled = true;
      const original = recheckBtn.textContent;
      recheckBtn.textContent = t('settingsPanel.sources.rechecking');
      // The rescan behind a recheck is the slow part, not the probe, so the
      // busy state has to wrap the WHOLE callback.
      this.setSourcesBusy(true, t('settingsPanel.sources.rechecking'));
      try {
        if (this.onRecheckSources) await this.onRecheckSources();
        renderSources();
        // Count the sources the scan could not read as well as the ones the
        // probe could not reach. A folder that exists but cannot be listed
        // passes the probe and fails the scan, and Recheck used to report
        // "All sources are reachable." 50 ms before the scan's "Source
        // unavailable" toast for the same folder (app test V04). Only paths
        // that are still enabled sources count, so a removed one cannot linger.
        const enabledPaths = new Set((this._settings.get('library.sources') || [])
          .filter((s) => s.enabled !== false)
          .map((s) => s.path));
        const stillOut = new Set([
          ...(this.getUnreachableSources() || []),
          ...[...(this.getFailedScanSources() || [])].filter((p) => enabledPaths.has(p)),
        ]).size;
        showToast(
          stillOut > 0
            ? t('settingsPanel.sources.recheckedSome', { count: stillOut })
            : t('settingsPanel.sources.recheckedAll'),
          stillOut > 0 ? 'warn' : 'info',
        );
      } finally {
        this.setSourcesBusy(false);
        recheckBtn.disabled = false;
        recheckBtn.textContent = original;
      }
    });

    const sourceActions = document.createElement('div');
    sourceActions.className = 'settings-panel__source-buttons';
    sourceActions.appendChild(addBtn);
    sourceActions.appendChild(recheckBtn);
    panel.appendChild(sourceActions);

    // Stash (S1): a block at the bottom of Sources, not a rail item (Dave's
    // answer 1 in notes/features/DESIGN-stash-s1.md). settings-stash.js owns
    // it; a rebuild (a language change) replaces the old block.
    this._stashBlock?.destroy();
    this._stashBlock = new StashSettingsBlock({
      settings: this._settings,
      getVideos: () => this.getStashVideos(),
      onOpenCheck: this.onOpenStashCheck ? (videoPath) => this.onOpenStashCheck(videoPath) : null,
      closeSettings: () => this._closeSettings?.(),
    });
    panel.appendChild(this._stashBlock.el);

    return panel;
  }

  _buildPlaybackTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    // Gap Skip
    const gapSection = document.createElement('div');
    gapSection.className = 'settings-panel__section';
    gapSection.id = 'sp-sec-gapskip';
    gapSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.gapSkipHeader')}</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldMode')}</span>
        <select id="sp-gap-mode" class="settings-panel__input settings-panel__input--select">
          <option value="off">${t('settingsPanel.playback.gapModeOff')}</option>
          <option value="auto">${t('settingsPanel.playback.gapModeAuto')}</option>
          <option value="button">${t('settingsPanel.playback.gapModeButton')}</option>
        </select>
        <button type="button" id="sp-gap-mode-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.gapResetMode')}" aria-label="${t('settingsPanel.playback.gapResetModeAria')}">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-gap-threshold-row" hidden>
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldThreshold')}</span>
        <input type="range" id="sp-gap-threshold" class="settings-panel__input settings-panel__input--range" min="5" max="60" value="10" aria-describedby="sp-gap-hint">
        <span id="sp-gap-threshold-val" class="settings-panel__field-value">10s</span>
        <button type="button" id="sp-gap-threshold-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.gapResetThreshold')}" aria-label="${t('settingsPanel.playback.gapResetThresholdAria')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-gap-hint">${t('settingsPanel.playback.gapHint')}</div>
    `;
    panel.appendChild(gapSection);

    // Gap Filler: a section of its own since it has its own rail entry
    // (Dave, 2026-11-19 ~15:05: "Add both"), right after Gap Skip as before.
    const fillerSection = document.createElement('div');
    fillerSection.className = 'settings-panel__section';
    fillerSection.id = 'sp-sec-gapfiller';
    fillerSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.fillerHeader')}</h2>
      <!-- Gap Filler's own "when" rows, then (while the filler is on) the
           pattern's summary row and "Set pattern…", which opens the shared
           pattern drawer (pattern-drawer.js; the same for Orgasm Switch and
           Edge Hold, Dave 2026-11-19). -->
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-filler-enabled">${t('settingsPanel.playback.fillerEnable')}</label>
        <input type="checkbox" id="sp-filler-enabled" class="settings-panel__input settings-panel__input--checkbox">
        <button type="button" id="sp-filler-enabled-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.fillerResetEnable')}" aria-label="${t('settingsPanel.playback.fillerResetEnableAria')}">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-filler-threshold-row" hidden>
        <label class="settings-panel__field-label" for="sp-filler-threshold">${t('settingsPanel.playback.fillerThreshold')}</label>
        <input type="range" id="sp-filler-threshold" class="settings-panel__input settings-panel__input--range" min="5" max="60" step="1" value="10">
        <span id="sp-filler-threshold-val" class="settings-panel__field-value">10s</span>
        <button type="button" id="sp-filler-threshold-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.gapResetThreshold')}" aria-label="${t('settingsPanel.playback.fillerResetThresholdAria')}">↻</button>
      </div>
      <div id="sp-filler-pattern-rows" hidden></div>
      <div class="settings-panel__hint" id="sp-filler-hint">${t('settingsPanel.playback.fillerHint')}</div>
    `;
    panel.appendChild(fillerSection);

    // Up Next — autoplay-countdown card at the end of the video. Sits
    // next to Gap Skip because both decide what happens at the trailing
    // edge of a script (Norman: conceptual model — adjacent surfaces
    // for adjacent decisions).
    const upNextSection = document.createElement('div');
    upNextSection.className = 'settings-panel__section';
    upNextSection.id = 'sp-sec-upnext';
    upNextSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.upNextHeader')}</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldMode')}</span>
        <select id="sp-upnext-mode" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-upnext-hint">
          <option value="auto">${t('settingsPanel.playback.upNextModeAuto')}</option>
          <option value="off">${t('settingsPanel.playback.upNextModeOff')}</option>
        </select>
        <button type="button" id="sp-upnext-mode-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.upNextResetMode')}" aria-label="${t('settingsPanel.playback.gapResetModeAria')}">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-upnext-countdown-row" hidden>
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldCountdown')}</span>
        <input type="range" id="sp-upnext-countdown" class="settings-panel__input settings-panel__input--range" min="3" max="20" value="10" step="1" aria-describedby="sp-upnext-hint">
        <span id="sp-upnext-countdown-val" class="settings-panel__field-value">10s</span>
        <button type="button" id="sp-upnext-countdown-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.upNextResetCountdown')}" aria-label="${t('settingsPanel.playback.upNextResetCountdownAria')}">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-autoplay-on-advance-row" hidden>
        <label class="settings-panel__field-label" for="sp-autoplay-on-advance">${t('settingsPanel.playback.autoplayOnAdvanceLabel')}</label>
        <input type="checkbox" id="sp-autoplay-on-advance" class="settings-panel__input settings-panel__input--checkbox" aria-describedby="sp-upnext-hint">
        <button type="button" id="sp-autoplay-on-advance-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.autoplayOnAdvanceResetTitle')}" aria-label="${t('settingsPanel.playback.autoplayOnAdvanceResetAria')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-upnext-hint">${t('settingsPanel.playback.upNextHint')}</div>
    `;
    // Random variant fires on load, so it lives with the other
    // "what plays next and how" settings rather than under smoothing.
    upNextSection.insertAdjacentHTML('beforeend', `
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-random-variant">${t('settingsPanel.playback.randomVariantLabel')}</label>
        <input type="checkbox" id="sp-random-variant" class="settings-panel__input settings-panel__input--checkbox" aria-describedby="sp-random-variant-hint">
      </div>
      <div class="settings-panel__hint" id="sp-random-variant-hint">${t('settingsPanel.playback.randomVariantHint')}</div>
    `);
    panel.appendChild(upNextSection);

    // Multi-Axis — auto-promote eligible videos to multi-axis playback.
    // Sits next to Up Next + Gap Skip because all three decide what
    // happens at the script-funscript boundary (Norman: conceptual
    // model). The toggle is a one-shot promoter — it writes
    // `active='multi'` to `library.associations` for eligible videos.
    // Toggling back to Single does NOT revert the writes (per user
    // directive); the hint copy makes that explicit.
    const multiAxisSection = document.createElement('div');
    multiAxisSection.className = 'settings-panel__section';
    multiAxisSection.id = 'sp-sec-multiaxis';
    multiAxisSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.multiHeader')}</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldDefaultPlayback')}</span>
        <select id="sp-prefer-multi" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-multi-hint">
          <option value="single">${t('settingsPanel.playback.preferSingle')}</option>
          <option value="multi">${t('settingsPanel.playback.preferMulti')}</option>
        </select>
        <button type="button" id="sp-prefer-multi-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.preferResetTitle')}" aria-label="${t('settingsPanel.playback.preferResetAria')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-multi-hint">${t('settingsPanel.playback.multiHint')}</div>
    `;
    panel.appendChild(multiAxisSection);

    // --- Video & performance (Linux only) ---
    // Hardware decode was filed under Appearance ▸ Library, where it had
    // nothing to do with either. It's a decode/troubleshooting setting, so
    // it belongs with playback. The whole group is omitted off Linux rather
    // than left as an empty rail entry.
    if (typeof window !== 'undefined' && window.funsync?.platform === 'linux') {
      const videoSection = document.createElement('div');
      videoSection.className = 'settings-panel__section';
      videoSection.id = 'sp-sec-video';
      videoSection.innerHTML = `
        <h2 class="settings-panel__section-header">${t('settingsPanel.playback.videoHeader')}</h2>
        <div class="settings-panel__field">
          <label class="settings-panel__field-label" for="sp-hw-decode">${t('settingsPanel.appearance.hwDecodeLabel')}</label>
          <input type="checkbox" id="sp-hw-decode" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('player.hwVideoDecode') !== false ? 'checked' : ''} aria-describedby="sp-hw-decode-hint">
        </div>
        <div class="settings-panel__hint" id="sp-hw-decode-hint">${t('settingsPanel.appearance.hwDecodeHint')}</div>
      `;
      videoSection.querySelector('#sp-hw-decode')
        .addEventListener('change', (e) => {
          this._settings.set('player.hwVideoDecode', !!e.target.checked);
          // Chromium GPU flags are read once at launch (main.js, before
          // whenReady), so this only takes effect after a restart.
          showToast(t('settingsPanel.appearance.hwDecodeRestart'), 'info', 5000);
        });
      panel.appendChild(videoSection);
    }

    // Smoothing — each control linked to the section hint via
    // aria-describedby so screen readers read the hint when the
    // input gets focus (Nielsen #4 standards — WCAG 1.3.1 Info and
    // Relationships).
    // --- Playback ---
    // Was "Smoothing & limits", which had become a junk drawer: seven
    // controls of which two were about smoothing. The orgasm settings moved
    // to their own section below, random-variant moved to Up Next.
    const playbackSection = document.createElement('div');
    playbackSection.className = 'settings-panel__section';
    playbackSection.id = 'sp-sec-playback';
    playbackSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.playbackHeader')}</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldInterpolation')}</span>
        <select id="sp-smoothing" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-smoothing-hint">
          <option value="linear">${t('settingsPanel.playback.smoothLinear')}</option>
          <option value="pchip">${t('settingsPanel.playback.smoothPchip')}</option>
          <option value="makima">${t('settingsPanel.playback.smoothMakima')}</option>
          <option value="step">${t('settingsPanel.playback.smoothStep')}</option>
        </select>
        <button type="button" id="sp-smoothing-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.smoothResetTitle')}" aria-label="${t('settingsPanel.playback.smoothResetAria')}">↻</button>
      </div>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">${t('settingsPanel.playback.fieldSpeedLimit')}</span>
        <input type="range" id="sp-speed-limit" class="settings-panel__input settings-panel__input--range" min="0" max="500" value="0" step="10" aria-describedby="sp-smoothing-hint">
        <span id="sp-speed-limit-val" class="settings-panel__field-value">${t('settingsPanel.playback.speedLimitOff')}</span>
        <button type="button" id="sp-speed-limit-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.speedLimitResetTitle')}" aria-label="${t('settingsPanel.playback.speedLimitResetAria')}">↻</button>
      </div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-range-extender">${t('settingsPanel.playback.rangeExtenderLabel')}</label>
        <input type="checkbox" id="sp-range-extender" class="settings-panel__input settings-panel__input--checkbox" aria-describedby="sp-range-extender-hint">
        <button type="button" id="sp-range-extender-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.rangeExtenderResetTitle')}" aria-label="${t('settingsPanel.playback.rangeExtenderResetAria')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-range-extender-hint">${t('settingsPanel.playback.rangeExtenderHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-range-live-preview">${t('settingsPanel.playback.rangeLivePreviewLabel')}</label>
        <input type="checkbox" id="sp-range-live-preview" class="settings-panel__input settings-panel__input--checkbox" aria-describedby="sp-range-live-preview-hint">
        <button type="button" id="sp-range-live-preview-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.rangeLivePreviewResetTitle')}" aria-label="${t('settingsPanel.playback.rangeLivePreviewResetAria')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-range-live-preview-hint">${t('settingsPanel.playback.rangeLivePreviewHint')}</div>
      <div class="settings-panel__hint" id="sp-smoothing-hint">${t('settingsPanel.playback.smoothingHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-inline-viz-opacity">${t('settingsPanel.playback.inlineVizOpacityLabel')}</label>
        <input type="range" id="sp-inline-viz-opacity" class="settings-panel__input settings-panel__input--range" min="20" max="100" step="5" value="80" aria-describedby="sp-inline-viz-opacity-hint">
        <span id="sp-inline-viz-opacity-val" class="settings-panel__field-value">80%</span>
        <button type="button" id="sp-inline-viz-opacity-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.inlineVizOpacityResetTitle')}" aria-label="${t('settingsPanel.playback.inlineVizOpacityResetTitle')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-inline-viz-opacity-hint">${t('settingsPanel.playback.inlineVizOpacityHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-hm-playhead">${t('settingsPanel.playback.heatmapPlayheadLabel')}</label>
        <input type="checkbox" id="sp-hm-playhead" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('player.inlineHeatmapPlayhead') === true ? 'checked' : ''} aria-describedby="sp-hm-playhead-hint">
      </div>
      <div class="settings-panel__hint" id="sp-hm-playhead-hint">${t('settingsPanel.playback.heatmapPlayheadHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-device-sim-opacity">${t('settingsPanel.playback.deviceSimOpacityLabel')}</label>
        <input type="range" id="sp-device-sim-opacity" class="settings-panel__input settings-panel__input--range" min="20" max="100" step="5" value="80" aria-describedby="sp-device-sim-opacity-hint">
        <span id="sp-device-sim-opacity-val" class="settings-panel__field-value">80%</span>
        <button type="button" id="sp-device-sim-opacity-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.deviceSimOpacityResetTitle')}" aria-label="${t('settingsPanel.playback.deviceSimOpacityResetTitle')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-device-sim-opacity-hint">${t('settingsPanel.playback.deviceSimOpacityHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-mini-player">${t('settingsPanel.appearance.miniPlayerLabel')}</label>
        <input type="checkbox" id="sp-mini-player" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('player.miniPlayer') === true ? 'checked' : ''} aria-describedby="sp-mini-player-hint">
      </div>
      <div class="settings-panel__hint" id="sp-mini-player-hint">${t('settingsPanel.appearance.miniPlayerHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-remember-speed">${t('settingsPanel.playback.rememberSpeedLabel')}</label>
        <input type="checkbox" id="sp-remember-speed" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('player.rememberPlaybackSpeed') === true ? 'checked' : ''} aria-describedby="sp-remember-speed-hint">
      </div>
      <div class="settings-panel__hint" id="sp-remember-speed-hint">${t('settingsPanel.playback.rememberSpeedHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-open-fullscreen">${t('settingsPanel.playback.openFullscreenLabel')}</label>
        <input type="checkbox" id="sp-open-fullscreen" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('player.openFullscreen') === true ? 'checked' : ''} aria-describedby="sp-open-fullscreen-hint">
      </div>
      <div class="settings-panel__hint" id="sp-open-fullscreen-hint">${t('settingsPanel.playback.openFullscreenHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-autoplay-on-open">${t('settingsPanel.playback.autoplayOnOpenLabel')}</label>
        <input type="checkbox" id="sp-autoplay-on-open" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('player.autoplayOnOpen') === true ? 'checked' : ''} aria-describedby="sp-autoplay-on-open-hint">
        <button type="button" id="sp-autoplay-on-open-reset" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.autoplayOnOpenResetTitle')}" aria-label="${t('settingsPanel.playback.autoplayOnOpenResetAria')}">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-autoplay-on-open-hint">${t('settingsPanel.playback.autoplayOnOpenHint')}</div>
    `;
    playbackSection.querySelector('#sp-mini-player')
      .addEventListener('change', (e) => {
        this._settings.set('player.miniPlayer', !!e.target.checked);
      });
    // No propagation needed — VideoPlayer reads this at each video load.
    playbackSection.querySelector('#sp-open-fullscreen')
      ?.addEventListener('change', (e) => {
        this._settings.set('player.openFullscreen', !!e.target.checked);
      });
    // Read live by app.js at each video load — no callback needed.
    playbackSection.querySelector('#sp-autoplay-on-open')
      ?.addEventListener('change', (e) => {
        this._settings.set('player.autoplayOnOpen', !!e.target.checked);
      });
    playbackSection.querySelector('#sp-remember-speed')
      .addEventListener('change', (e) => {
        this._settings.set('player.rememberPlaybackSpeed', !!e.target.checked);
      });
    // HM playhead marker (#381): applied to the live overlay at once.
    playbackSection.querySelector('#sp-hm-playhead')
      .addEventListener('change', (e) => {
        this._settings.set('player.inlineHeatmapPlayhead', !!e.target.checked);
        if (this.onInlineHeatmapPlayheadChanged) this.onInlineHeatmapPlayheadChanged(!!e.target.checked);
      });
    panel.appendChild(playbackSection);

    // --- Orgasm Switch ---
    // Its own home at last. The script picker and the hold/toggle mode were
    // buried in the smoothing section with no heading of their own, which
    // made a feature with multi-axis and custom routing behind it read like
    // an afterthought.
    const orgasmSection = document.createElement('div');
    orgasmSection.className = 'settings-panel__section';
    orgasmSection.id = 'sp-sec-orgasm';
    orgasmSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.orgasmHeader')}</h2>
      <!-- X's own "when" rows (Dave 2026-11-19, same order as Edge Hold's):
           the key behaviour, then the source: the script file(s) set with
           Configure… (unchanged), or a pattern: its summary row and
           "Set pattern…" (the shared pattern drawer, pattern-drawer.js),
           whose library takes in the old "Generated pattern" shapes as its
           Simple shapes. -->
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-orgasm-mode">${t('settingsPanel.playback.orgasmModeLabel')}</label>
        <select id="sp-orgasm-mode" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-orgasm-mode-hint">
          <option value="hold">${t('settingsPanel.playback.orgasmModeHold')}</option>
          <option value="toggle">${t('settingsPanel.playback.orgasmModeToggle')}</option>
        </select>
      </div>
      <div class="settings-panel__hint" id="sp-orgasm-mode-hint">${t('settingsPanel.playback.orgasmModeHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-orgasm-source">${t('settingsPanel.playback.orgasmSourceLabel')}</label>
        <select id="sp-orgasm-source" class="settings-panel__input settings-panel__input--select">
          <option value="file">${t('settingsPanel.playback.orgasmSourceFile')}</option>
          <option value="pattern">${t('patterns.ui.pattern')}</option>
        </select>
      </div>
      <div class="settings-panel__field" id="sp-orgasm-file-row">
        <span class="settings-panel__field-label">${t('settingsPanel.playback.orgasmScriptLabel')}</span>
        <button type="button" id="sp-orgasm-script-pick" class="settings-panel__add-btn">${t('settingsPanel.playback.orgasmScriptChoose')}</button>
        <button type="button" id="sp-orgasm-script-clear" class="settings-panel__field-reset" hidden title="${t('settingsPanel.playback.orgasmScriptClear')}" aria-label="${t('settingsPanel.playback.orgasmScriptClear')}">✕</button>
      </div>
      <!-- Chosen script(s) on their OWN line below the button. Inline in the
           field row they were squeezed to nothing by "Configure…" (a multi-axis
           or custom-routing config names several scripts, which never fit on
           one line next to a button). -->
      <div id="sp-orgasm-script-name" class="settings-panel__value-block" hidden></div>
      <div id="sp-orgasm-pattern-rows" hidden>
        <div id="sp-orgasm-pattern-mount"></div>
        <div class="settings-panel__hint" id="sp-orgasm-pattern-none" hidden>${t('settingsPanel.playback.orgasmLibraryNone')}</div>
        <div class="settings-panel__hint">${t('settingsPanel.playback.orgasmLibraryHint')}</div>
      </div>
      <div class="settings-panel__hint">${t('settingsPanel.playback.orgasmScriptHint')}</div>
    `;
    panel.appendChild(orgasmSection);

    // --- Edge Hold ---
    // Z is the Orgasm Switch's inverse and sits next to X on the keyboard on
    // purpose, so it gets the same shape of control: hold vs toggle. Its own
    // section rather than a field under "Orgasm Switch" — nobody looking for
    // edging settings would think to open the orgasm heading.
    const edgeSection = document.createElement('div');
    edgeSection.className = 'settings-panel__section';
    edgeSection.id = 'sp-sec-edge';
    edgeSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.edgeHeader')}</h2>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-edge-mode">${t('settingsPanel.playback.edgeModeLabel')}</label>
        <select id="sp-edge-mode" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-edge-mode-hint">
          <option value="hold">${t('settingsPanel.playback.edgeModeHold')}</option>
          <option value="toggle">${t('settingsPanel.playback.edgeModeToggle')}</option>
        </select>
      </div>
      <div class="settings-panel__hint" id="sp-edge-mode-hint">${t('settingsPanel.playback.edgeModeHint')}</div>
      <!-- What Z does while it is on (next major): stop the devices (today)
           or play a pattern from the library, rows below. -->
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-edge-action">${t('settingsPanel.playback.edgeActionLabel')}</label>
        <select id="sp-edge-action" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-edge-action-hint">
          <option value="stop">${t('settingsPanel.playback.edgeActionStop')}</option>
          <option value="pattern">${t('settingsPanel.playback.edgeActionPattern')}</option>
        </select>
      </div>
      <div class="settings-panel__hint" id="sp-edge-action-hint">${t('settingsPanel.playback.edgeActionHint')}</div>
      <div id="sp-edge-pattern-rows" hidden></div>
      <div class="settings-panel__hint" id="sp-edge-pattern-none" hidden>${t('settingsPanel.playback.edgePatternNone')}</div>
    `;
    panel.appendChild(edgeSection);

    // --- Global hotkeys ---
    // Play/pause, Orgasm Switch and Edge Hold from any app (Eroto #316).
    // Registration and the handler shipped without any way to set a key
    // here, and a hand-edited binding applied only at the next launch
    // (V47). The rows write `player.globalShortcuts`; app.js re-registers
    // on that setting changing.
    const hotkeysSection = document.createElement('div');
    hotkeysSection.className = 'settings-panel__section';
    hotkeysSection.id = 'sp-sec-global-hotkeys';
    hotkeysSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.playback.globalHotkeysHeader')}</h2>
      <div id="sp-global-hotkeys-mount"></div>
      <div class="settings-panel__hint">${t('settingsPanel.playback.globalHotkeysHint')}</div>
    `;
    panel.appendChild(hotkeysSection);
    new GlobalHotkeysSettings({
      element: hotkeysSection.querySelector('#sp-global-hotkeys-mount'),
      settings: this._settings,
    });


    // Final order for the rail. Re-appending an existing child MOVES it, so
    // this reorders without disturbing the creation/wiring above. Reads
    // most-used first: how playback behaves, then what plays next.
    for (const el of [
      panel.querySelector('#sp-sec-playback'),
      panel.querySelector('#sp-sec-upnext'),
      panel.querySelector('#sp-sec-gapskip'),
      panel.querySelector('#sp-sec-gapfiller'),
      panel.querySelector('#sp-sec-orgasm'),
      panel.querySelector('#sp-sec-edge'),
      panel.querySelector('#sp-sec-global-hotkeys'),
      panel.querySelector('#sp-sec-multiaxis'),
      panel.querySelector('#sp-sec-video'),
    ]) {
      if (el) panel.appendChild(el);
    }

    // Wire events after DOM is built
    setTimeout(() => {
      const gapMode = panel.querySelector('#sp-gap-mode');
      const gapThreshold = panel.querySelector('#sp-gap-threshold');
      const gapThresholdVal = panel.querySelector('#sp-gap-threshold-val');
      const gapThresholdRow = panel.querySelector('#sp-gap-threshold-row');

      const saved = this._settings.get('player.gapSkip') || {};
      if (gapMode) gapMode.value = saved.mode || 'off';
      if (gapThreshold) gapThreshold.value = Math.round((saved.threshold || 10000) / 1000);
      if (gapThresholdVal) gapThresholdVal.textContent = `${gapThreshold?.value || 10}s`;
      if (gapThresholdRow) gapThresholdRow.hidden = !saved.mode || saved.mode === 'off';

      gapMode?.addEventListener('change', () => {
        const mode = gapMode.value;
        const threshold = (parseInt(gapThreshold?.value, 10) || 10) * 1000;
        this._settings.set('player.gapSkip', { mode, threshold });
        if (gapThresholdRow) gapThresholdRow.hidden = mode === 'off';
        if (this.onGapSkipChanged) this.onGapSkipChanged(mode, threshold);
      });

      gapThreshold?.addEventListener('input', () => {
        const seconds = parseInt(gapThreshold.value, 10) || 10;
        if (gapThresholdVal) gapThresholdVal.textContent = `${seconds}s`;
        const mode = gapMode?.value || 'off';
        this._settings.set('player.gapSkip', { mode, threshold: seconds * 1000 });
        if (this.onGapSkipChanged) this.onGapSkipChanged(mode, seconds * 1000);
      });

      // Gap filler — strokes during blank stretches of script. Its own
      // "when" rows (on / off, the threshold), then the shared Pattern block
      // while it is on. The on / off and threshold rows write the whole
      // `player.gapFiller` object as today, with every other field exactly
      // as read (presetId / custom are v0.9.2's and never rewritten, and
      // never added when absent); the block writes only what
      // patternChoiceWrites says.
      const fillerEnabled = panel.querySelector('#sp-filler-enabled');
      const fillerThreshold = panel.querySelector('#sp-filler-threshold');
      const fillerThresholdVal = panel.querySelector('#sp-filler-threshold-val');
      const fillerThresholdRow = panel.querySelector('#sp-filler-threshold-row');
      const fillerPatternRows = panel.querySelector('#sp-filler-pattern-rows');
      const savedFiller = this._settings.get('player.gapFiller') || {};
      if (fillerEnabled) fillerEnabled.checked = !!savedFiller.enabled;
      // What app.js uses: the filler's own threshold, else Gap Skip's, else 10 s.
      const fillerThresholdSec = () => {
        const own = Number(this._settings.get('player.gapFiller')?.thresholdMs);
        const skip = Number(this._settings.get('player.gapSkip')?.threshold);
        const ms = own > 0 ? own : (skip > 0 ? skip : 10000);
        return Math.max(5, Math.min(60, Math.round(ms / 1000)));
      };
      if (fillerThreshold) fillerThreshold.value = String(fillerThresholdSec());
      if (fillerThresholdVal) fillerThresholdVal.textContent = `${fillerThreshold?.value || 10}s`;
      const writeFiller = (patch) => {
        this._settings.set('player.gapFiller', { ...(this._settings.get('player.gapFiller') || {}), ...patch });
        if (this.onGapFillerChanged) this.onGapFillerChanged();
      };
      const fillerBlock = this._mountPatternSetting('gapFiller', fillerPatternRows, {
        idPrefix: 'sp-filler-pattern',
        featureName: t('settingsPanel.playback.fillerHeader'),
        title: t('settingsPanel.patternBlock.drawerTitle', { feature: t('settingsPanel.playback.fillerHeader') }),
        label: t('settingsPanel.patternBlock.groupAria', { feature: t('settingsPanel.playback.fillerHeader') }),
        oneShotHint: t('settingsPanel.patternBlock.oneShotHintGap'),
        // The preview's joins at the filler's own cap, as it plays.
        sampleOptions: Number(savedFiller.maxJoinSpeed) > 0 ? { maxJoinSpeed: Number(savedFiller.maxJoinSpeed) } : undefined,
        onSaved: () => { if (this.onGapFillerChanged) this.onGapFillerChanged(); },
      });
      const syncFiller = () => {
        const on = !!fillerEnabled?.checked;
        if (fillerThresholdRow) fillerThresholdRow.hidden = !on;
        if (fillerPatternRows) fillerPatternRows.hidden = !on;
        if (on) fillerBlock?.refresh();
        else if (this._patternDrawer?.isOpen()) this._patternDrawer.cancel();
      };
      fillerEnabled?.addEventListener('change', () => {
        writeFiller({ enabled: !!fillerEnabled.checked });
        syncFiller();
      });
      // The value follows the thumb; it saves on release, so a drag across
      // the range does not rebuild the filler on every frame.
      fillerThreshold?.addEventListener('input', () => {
        if (fillerThresholdVal) fillerThresholdVal.textContent = `${fillerThreshold.value}s`;
      });
      fillerThreshold?.addEventListener('change', () => {
        writeFiller({ thresholdMs: (parseInt(fillerThreshold.value, 10) || 10) * 1000 });
      });
      syncFiller();

      // Up Next
      const upNextMode = panel.querySelector('#sp-upnext-mode');
      const upNextCountdown = panel.querySelector('#sp-upnext-countdown');
      const upNextCountdownVal = panel.querySelector('#sp-upnext-countdown-val');
      const upNextCountdownRow = panel.querySelector('#sp-upnext-countdown-row');

      const savedUpNext = this._settings.get('player.upNext') || {};
      const upNextModeVal = savedUpNext.mode || SETTINGS_DEFAULTS['player.upNext.mode'];
      const upNextCountSec = savedUpNext.countdownSec || SETTINGS_DEFAULTS['player.upNext.countdownSec'];
      if (upNextMode) upNextMode.value = upNextModeVal;
      if (upNextCountdown) upNextCountdown.value = upNextCountSec;
      if (upNextCountdownVal) upNextCountdownVal.textContent = `${upNextCountSec}s`;
      // Hide countdown row when mode is off (mirrors gap-skip pattern).
      if (upNextCountdownRow) upNextCountdownRow.hidden = upNextModeVal === 'off';

      upNextMode?.addEventListener('change', () => {
        const mode = upNextMode.value;
        const countdownSec = parseInt(upNextCountdown?.value, 10) || SETTINGS_DEFAULTS['player.upNext.countdownSec'];
        this._settings.set('player.upNext', { mode, countdownSec });
        if (upNextCountdownRow) upNextCountdownRow.hidden = mode === 'off';
        if (this.onUpNextChanged) this.onUpNextChanged(mode, countdownSec);
      });

      upNextCountdown?.addEventListener('input', () => {
        const seconds = parseInt(upNextCountdown.value, 10) || SETTINGS_DEFAULTS['player.upNext.countdownSec'];
        if (upNextCountdownVal) upNextCountdownVal.textContent = `${seconds}s`;
        const mode = upNextMode?.value || 'auto';
        this._settings.set('player.upNext', { mode, countdownSec: seconds });
        if (this.onUpNextChanged) this.onUpNextChanged(mode, seconds);
      });

      // Auto-play on advance. Hidden when Up Next is off — the setting
      // is only meaningful when something is actually advancing.
      // Read at use-time in app.js::_playUpNext, so no callback needed.
      const autoplayCheckbox = panel.querySelector('#sp-autoplay-on-advance');
      const autoplayRow = panel.querySelector('#sp-autoplay-on-advance-row');
      const autoplaySaved = this._settings.get('player.autoplayOnAdvance');
      const autoplayVal = typeof autoplaySaved === 'boolean'
        ? autoplaySaved
        : SETTINGS_DEFAULTS['player.autoplayOnAdvance'];
      if (autoplayCheckbox) autoplayCheckbox.checked = autoplayVal;
      if (autoplayRow) autoplayRow.hidden = upNextModeVal === 'off';

      autoplayCheckbox?.addEventListener('change', () => {
        this._settings.set('player.autoplayOnAdvance', !!autoplayCheckbox.checked);
      });

      // Keep the autoplay row in sync with Up Next mode visibility —
      // if the user turns Up Next off, the autoplay toggle hides too.
      upNextMode?.addEventListener('change', () => {
        if (autoplayRow) autoplayRow.hidden = upNextMode.value === 'off';
      });

      // Multi-Axis default playback. Toggle from Single → Multi opens
      // a confirmation modal that surfaces the eligible-video count
      // because the action is one-way: switching back to Single does
      // not revert auto-assigned videos.
      const preferMulti = panel.querySelector('#sp-prefer-multi');
      const savedPreferMulti = this._settings.get('player.preferMultiAxis')
        || SETTINGS_DEFAULTS['player.preferMultiAxis'];
      if (preferMulti) preferMulti.value = savedPreferMulti;

      preferMulti?.addEventListener('change', async () => {
        const newValue = preferMulti.value;
        const previousValue = this._settings.get('player.preferMultiAxis')
          || SETTINGS_DEFAULTS['player.preferMultiAxis'];

        try {
          // Single → Multi triggers the confirmation modal. Multi →
          // Single is a no-op for already-promoted videos so it doesn't
          // need a prompt.
          if (newValue === 'multi' && previousValue !== 'multi') {
            // Yield before counting and before opening anything. Two
            // reasons, both learned from stingray's report (2026-08-24:
            // "the app freezes for a few seconds and once it recovers the
            // drop down remains on single-axis"):
            //
            //  1. The count walks the library. It is much cheaper now that
            //     companions are indexed, but it is still the one piece of
            //     real work on this path, and doing it inside the `change`
            //     event means the window is unresponsive while it runs.
            //  2. Opening a full-screen overlay synchronously from `change`
            //     puts a backdrop under the pointer before the events that
            //     follow the native select popup have been dispatched. Those
            //     hit-test against the live DOM, so a trailing click can land
            //     on the fresh backdrop and dismiss the dialog as a cancel —
            //     which reverts the select and writes nothing, exactly the
            //     symptom reported. Letting the event finish first removes
            //     the overlap entirely.
            await new Promise((resolve) => setTimeout(resolve, 0));

            const eligibleCount = this.getMultiAxisEligibleCount
              ? this.getMultiAxisEligibleCount()
              : null;
            const confirmed = await this._confirmMultiAxisToggle(eligibleCount);
            if (!confirmed) {
              // Revert the select silently — no setting write, no callback.
              preferMulti.value = previousValue;
              return;
            }
          }

          this._settings.set('player.preferMultiAxis', newValue);
          if (this.onPreferMultiAxisChanged) this.onPreferMultiAxisChanged(newValue);
        } catch (err) {
          // Never leave the control showing a value that was not saved.
          // Silently swallowing here is how "I selected it and it didn't
          // stick" becomes unreportable — put it back and say so.
          console.error('[SettingsPanel] preferMultiAxis change failed:', err);
          preferMulti.value = this._settings.get('player.preferMultiAxis')
            || SETTINGS_DEFAULTS['player.preferMultiAxis'];
          showToast(t('toast.settingSaveFailed'), 'error', 4000);
        }
      });

      const smoothing = panel.querySelector('#sp-smoothing');
      const speedLimit = panel.querySelector('#sp-speed-limit');
      const speedLimitVal = panel.querySelector('#sp-speed-limit-val');

      if (smoothing) {
        smoothing.value = this._settings.get('player.smoothing') || 'linear';
        smoothing.addEventListener('change', () => {
          this._settings.set('player.smoothing', smoothing.value);
          if (this.onSmoothingChanged) this.onSmoothingChanged(smoothing.value);
        });
      }

      if (speedLimit) {
        const savedLimit = this._settings.get('player.speedLimit') || 0;
        speedLimit.value = savedLimit;
        if (speedLimitVal) speedLimitVal.textContent = savedLimit > 0 ? `${savedLimit}` : t('settingsPanel.playback.speedLimitOff');
        speedLimit.addEventListener('input', () => {
          const val = parseInt(speedLimit.value, 10) || 0;
          if (speedLimitVal) speedLimitVal.textContent = val > 0 ? `${val}` : t('settingsPanel.playback.speedLimitOff');
          this._settings.set('player.speedLimit', val);
          if (this.onSpeedLimitChanged) this.onSpeedLimitChanged(val);
        });
      }

      // Range Extender — script-side stretch for limited-range scripts.
      // Default off; users opt in when they have a script that doesn't
      // use their device's full range. See device-transform-stack.js for
      // the apply pipeline (extender → invert → range → safety cap).
      const rangeExtender = panel.querySelector('#sp-range-extender');
      const savedExt = this._settings.get('player.rangeExtender.enabled');
      const extVal = typeof savedExt === 'boolean'
        ? savedExt
        : SETTINGS_DEFAULTS['player.rangeExtender.enabled'];
      if (rangeExtender) rangeExtender.checked = extVal;
      rangeExtender?.addEventListener('change', () => {
        this._settings.set('player.rangeExtender.enabled', !!rangeExtender.checked);
        if (this.onRangeExtenderChanged) this.onRangeExtenderChanged(!!rangeExtender.checked);
      });

      // Live range preview — with nothing playing, dragging a range slider in
      // the Connection panel jogs the device to that boundary so you can see
      // where it actually sits (stingray, 2026-08-24, adjusting for a new
      // sleeve). On by default: it only ever moves a device the user is
      // actively dragging a slider for, and it is silent during playback.
      // Switchable because a device moving unprompted should always be
      // something you can stop. Read live by ConnectionPanel — no callback.
      const rangeLivePreview = panel.querySelector('#sp-range-live-preview');
      const savedPreview = this._settings.get('player.rangeLivePreview');
      if (rangeLivePreview) {
        rangeLivePreview.checked = typeof savedPreview === 'boolean'
          ? savedPreview
          : SETTINGS_DEFAULTS['player.rangeLivePreview'];
      }
      rangeLivePreview?.addEventListener('change', () => {
        this._settings.set('player.rangeLivePreview', !!rangeLivePreview.checked);
      });

      // Orgasm Switch — pick / clear the global orgasm script (hold X to use).
      const orgasmName = panel.querySelector('#sp-orgasm-script-name');
      const orgasmPick = panel.querySelector('#sp-orgasm-script-pick');
      const orgasmClear = panel.querySelector('#sp-orgasm-script-clear');
      const refreshOrgasmName = () => {
        // Returns either a plain string (single script) or a summary + one
        // line per chosen script for multi-axis / custom-routing configs.
        const info = this.getOrgasmScriptName?.();
        if (orgasmName) {
          orgasmName.innerHTML = '';
          const raw = Array.isArray(info) ? info : (info ? [info] : []);
          // Nothing configured still shows "None" — the row would otherwise
          // read as though the setting didn't exist.
          const lines = raw.length > 0 ? raw : [t('settingsPanel.playback.orgasmScriptNone')];
          for (const line of lines) {
            const row = document.createElement('div');
            row.className = 'settings-panel__value-line';
            if (typeof line === 'string') {
              row.textContent = line;
            } else {
              // { label, name, missing } — axis/device prefix kept dim so
              // the filenames stay the thing the eye lands on. `label` is
              // null for a single-script config (nothing to prefix with).
              if (line.label) {
                const tag = document.createElement('span');
                tag.className = 'settings-panel__value-tag';
                tag.textContent = `${line.label}: `;
                row.appendChild(tag);
              }
              row.appendChild(document.createTextNode(line.name));
              // A script that no longer resolves has to SAY so — otherwise
              // the row shows a stored filename while the switch is dead.
              if (line.missing) {
                row.classList.add('settings-panel__value-line--missing');
                const warn = document.createElement('span');
                warn.className = 'settings-panel__value-missing';
                warn.textContent = ` ${t('settingsPanel.playback.orgasmScriptMissing')}`;
                row.appendChild(warn);
              }
            }
            orgasmName.appendChild(row);
          }
          orgasmName.hidden = false;
          orgasmName.classList.toggle('settings-panel__value-block--empty', raw.length === 0);
        }
        if (orgasmClear) orgasmClear.hidden = !(Array.isArray(info) ? info.length : info);
      };
      refreshOrgasmName();
      orgasmPick?.addEventListener('click', async () => {
        if (this.onPickOrgasmScript) await this.onPickOrgasmScript();
        refreshOrgasmName();
      });
      orgasmClear?.addEventListener('click', () => {
        if (this.onClearOrgasmScript) this.onClearOrgasmScript();
        refreshOrgasmName();
      });

      // Orgasm Switch source: the script file(s) (Configure…, untouched by
      // the other choice, so "Script file" brings them straight back) or a
      // pattern in the shared block. The select writes `player.orgasmSource`
      // only: the old `orgasmPattern` / `orgasmLibraryPattern` are v0.9.2's
      // and never rewritten (a downgrade finds them as they were). Every
      // change asks app.js to reload the finisher.
      const orgasmSource = panel.querySelector('#sp-orgasm-source');
      const orgasmFileRow = panel.querySelector('#sp-orgasm-file-row');
      const orgasmPatternRows = panel.querySelector('#sp-orgasm-pattern-rows');
      // No pattern chosen (X starts there): the note says X plays the file.
      const orgasmPatternNone = panel.querySelector('#sp-orgasm-pattern-none');
      if (orgasmSource && orgasmPatternRows) {
        orgasmSource.value = readOrgasmSource(this._choicePlayer()) === 'pattern' ? 'pattern' : 'file';
        const reloadFinisher = async () => {
          syncOrgasmSource();
          if (this.onOrgasmPatternChanged) await this.onOrgasmPatternChanged();
          // The summary of the file(s) is app.js's, read after its reload.
          syncOrgasmSource();
        };
        const orgasmBlock = this._mountPatternSetting('orgasm', panel.querySelector('#sp-orgasm-pattern-mount'), {
          idPrefix: 'sp-orgasm-pattern',
          featureName: t('settingsPanel.playback.orgasmHeader'),
          title: t('settingsPanel.patternBlock.drawerTitle', { feature: t('settingsPanel.playback.orgasmHeader') }),
          label: t('settingsPanel.patternBlock.groupAria', { feature: t('settingsPanel.playback.orgasmHeader') }),
          oneShotHint: t('patterns.ui.oneShotHint'),
          onSaved: reloadFinisher,
        });
        // The file row and the summary of the chosen file(s) belong to
        // "Script file"; the block and its notes to "Pattern".
        const syncOrgasmSource = () => {
          const isPattern = orgasmSource.value === 'pattern';
          if (orgasmFileRow) orgasmFileRow.hidden = isPattern;
          orgasmPatternRows.hidden = !isPattern;
          if (isPattern) {
            if (orgasmName) { orgasmName.replaceChildren(); orgasmName.hidden = true; }
            orgasmBlock?.refresh();
          } else {
            refreshOrgasmName();
            this._patternTest?.stop('orgasm');
          }
          if (orgasmPatternNone) orgasmPatternNone.hidden = !isPattern || orgasmBlock?.read().id !== null;
        };
        orgasmSource.addEventListener('change', () => {
          for (const { key, value } of safePatternWrites(orgasmSourceWrites(orgasmSource.value), this._choicePlayer())) {
            this._settings.set(key, value);
          }
          reloadFinisher();
        });
        syncOrgasmSource();
      }

      // Inline TL/HM overlay opacity. Live-applies on input so the user can
      // see the effect against the video while dragging, rather than having
      // to close the panel to judge it.
      const vizOpacity = panel.querySelector('#sp-inline-viz-opacity');
      const vizOpacityVal = panel.querySelector('#sp-inline-viz-opacity-val');
      const vizOpacityReset = panel.querySelector('#sp-inline-viz-opacity-reset');
      if (vizOpacity) {
        const DEFAULT_OPACITY = 80;
        const readOpacity = () => {
          const v = Number(this._settings.get('player.inlineVizOpacity'));
          return Number.isFinite(v) ? Math.min(100, Math.max(20, v)) : DEFAULT_OPACITY;
        };
        const paintOpacity = (v) => {
          vizOpacity.value = String(v);
          if (vizOpacityVal) vizOpacityVal.textContent = `${v}%`;
          if (vizOpacityReset) vizOpacityReset.hidden = v === DEFAULT_OPACITY;
        };
        paintOpacity(readOpacity());
        vizOpacity.addEventListener('input', () => {
          const v = Number(vizOpacity.value);
          this._settings.set('player.inlineVizOpacity', v);
          paintOpacity(v);
          if (this.onInlineVizOpacityChanged) this.onInlineVizOpacityChanged(v);
        });
        vizOpacityReset?.addEventListener('click', () => {
          this._settings.set('player.inlineVizOpacity', DEFAULT_OPACITY);
          paintOpacity(DEFAULT_OPACITY);
          if (this.onInlineVizOpacityChanged) this.onInlineVizOpacityChanged(DEFAULT_OPACITY);
          // paintOpacity just hid the focused ↻: hand focus to its slider, or
          // it falls to <body> and Space plays the video behind Settings.
          vizOpacity.focus();
        });
      }

      // Device simulator (D) opacity. Same 20-100 range and live-apply as the
      // inline viz above — both are video overlays and are judged against the
      // footage, not in the abstract.
      const simOpacity = panel.querySelector('#sp-device-sim-opacity');
      const simOpacityVal = panel.querySelector('#sp-device-sim-opacity-val');
      const simOpacityReset = panel.querySelector('#sp-device-sim-opacity-reset');
      if (simOpacity) {
        const DEFAULT_SIM_OPACITY = 80;
        const readSimOpacity = () => {
          const v = Number(this._settings.get('player.deviceSimOpacity'));
          return Number.isFinite(v) ? Math.min(100, Math.max(20, v)) : DEFAULT_SIM_OPACITY;
        };
        const paintSimOpacity = (v) => {
          simOpacity.value = String(v);
          if (simOpacityVal) simOpacityVal.textContent = `${v}%`;
          if (simOpacityReset) simOpacityReset.hidden = v === DEFAULT_SIM_OPACITY;
        };
        paintSimOpacity(readSimOpacity());
        simOpacity.addEventListener('input', () => {
          const v = Number(simOpacity.value);
          this._settings.set('player.deviceSimOpacity', v);
          paintSimOpacity(v);
          if (this.onDeviceSimOpacityChanged) this.onDeviceSimOpacityChanged(v);
        });
        simOpacityReset?.addEventListener('click', () => {
          this._settings.set('player.deviceSimOpacity', DEFAULT_SIM_OPACITY);
          paintSimOpacity(DEFAULT_SIM_OPACITY);
          if (this.onDeviceSimOpacityChanged) this.onDeviceSimOpacityChanged(DEFAULT_SIM_OPACITY);
          // Same as the overlay opacity reset above: keep focus in the dialog.
          simOpacity.focus();
        });
      }

      // Orgasm Switch behaviour: hold-to-ride vs press-to-finish.
      const orgasmMode = panel.querySelector('#sp-orgasm-mode');
      if (orgasmMode) {
        orgasmMode.value = this._settings.get('player.orgasmSwitchMode') || 'hold';
        orgasmMode.addEventListener('change', () => {
          this._settings.set('player.orgasmSwitchMode', orgasmMode.value);
        });
      }

      // Edge Hold behaviour: hold-to-edge vs press-to-toggle (lr_x3 #307).
      const edgeMode = panel.querySelector('#sp-edge-mode');
      if (edgeMode) {
        edgeMode.value = this._settings.get('player.edgeHoldMode') || 'hold';
        // No callback, like the Orgasm Switch mode above: app.js
        // `_onEdgeHold` reads `player.edgeHoldMode` on every press. (This
        // used to call an `onEdgeHoldModeChanged` that nothing passed or
        // stored, V71.)
        edgeMode.addEventListener('change', () => {
          this._settings.set('player.edgeHoldMode', edgeMode.value);
        });
      }

      // What Z does while it is on: stop the devices (the default, today)
      // or play a pattern, in the shared block. No callback: app.js reads
      // both at each Z press. `player.edgePattern` is v0.9.2's and never
      // rewritten; the block writes only what patternChoiceWrites says.
      const edgeAction = panel.querySelector('#sp-edge-action');
      const edgePatternRows = panel.querySelector('#sp-edge-pattern-rows');
      // 'pattern' with no pattern chosen (the default) behaves as 'stop':
      // this note says so while it is the case.
      const edgePatternNone = panel.querySelector('#sp-edge-pattern-none');
      if (edgeAction && edgePatternRows) {
        edgeAction.value = edgeHoldAction(this._settings.get('player.edgeHoldAction'));
        const syncEdgeAction = () => {
          const isPattern = edgeAction.value === 'pattern';
          edgePatternRows.hidden = !isPattern;
          if (isPattern) edgeBlock?.refresh();
          else this._patternTest?.stop('edge');
          if (edgePatternNone) edgePatternNone.hidden = !isPattern || edgeBlock?.read().id !== null;
        };
        const edgeBlock = this._mountPatternSetting('edge', edgePatternRows, {
          idPrefix: 'sp-edge-pattern',
          featureName: t('settingsPanel.playback.edgeHeader'),
          title: t('settingsPanel.patternBlock.drawerTitle', { feature: t('settingsPanel.playback.edgeHeader') }),
          label: t('settingsPanel.patternBlock.groupAria', { feature: t('settingsPanel.playback.edgeHeader') }),
          oneShotHint: t('patterns.ui.oneShotHint'),
          onSaved: () => syncEdgeAction(),
        });
        edgeAction.addEventListener('change', () => {
          this._settings.set('player.edgeHoldAction', edgeHoldAction(edgeAction.value));
          syncEdgeAction();
        });
        syncEdgeAction();
      }

      // Random script variation on play (zaikechi #209) — when a video has
      // 2+ variants, pick one at random each load. Beats pinned defaults
      // while on; pins resume when turned off.
      const randomVariant = panel.querySelector('#sp-random-variant');
      if (randomVariant) {
        randomVariant.checked = this._settings.get('player.randomVariantOnPlay') === true;
        randomVariant.addEventListener('change', () => {
          this._settings.set('player.randomVariantOnPlay', randomVariant.checked);
        });
      }

      // Per-field defaults wiring — render the "•" at-default dot suffix
      // on each value display, show/hide the "↻" reset button as the
      // user-changed status flips, and reset to canonical default on
      // click. Defaults sourced from SETTINGS_DEFAULTS at module top.
      const wireDefault = (input, valueEl, resetBtn, defaultValue) => {
        if (!input || !resetBtn) return;
        const isDefault = () => String(input.value) === String(defaultValue);
        const refresh = () => {
          const dflt = isDefault();
          if (valueEl) valueEl.classList.toggle('settings-panel__field-value--default', dflt);
          resetBtn.hidden = dflt;
        };
        resetBtn.addEventListener('click', () => {
          input.value = String(defaultValue);
          // Dispatch both events — selects respond to 'change', ranges
          // respond to 'input'. Existing listeners run + persist + fire
          // the relevant on*Changed callback. refresh() then updates UI.
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          refresh();
          input.focus();
        });
        input.addEventListener('input', refresh);
        input.addEventListener('change', refresh);
        refresh();
      };

      wireDefault(gapMode, null, panel.querySelector('#sp-gap-mode-reset'), SETTINGS_DEFAULTS['player.gapSkip.mode']);
      wireDefault(
        panel.querySelector('#sp-filler-threshold'),
        panel.querySelector('#sp-filler-threshold-val'),
        panel.querySelector('#sp-filler-threshold-reset'),
        SETTINGS_DEFAULTS['player.gapFiller.thresholdSec'],
      );
      wireDefault(gapThreshold, gapThresholdVal, panel.querySelector('#sp-gap-threshold-reset'), SETTINGS_DEFAULTS['player.gapSkip.thresholdSec']);
      wireDefault(upNextMode, null, panel.querySelector('#sp-upnext-mode-reset'), SETTINGS_DEFAULTS['player.upNext.mode']);
      wireDefault(upNextCountdown, upNextCountdownVal, panel.querySelector('#sp-upnext-countdown-reset'), SETTINGS_DEFAULTS['player.upNext.countdownSec']);
      wireDefault(preferMulti, null, panel.querySelector('#sp-prefer-multi-reset'), SETTINGS_DEFAULTS['player.preferMultiAxis']);
      wireDefault(smoothing, null, panel.querySelector('#sp-smoothing-reset'), SETTINGS_DEFAULTS['player.smoothing']);
      wireDefault(speedLimit, speedLimitVal, panel.querySelector('#sp-speed-limit-reset'), SETTINGS_DEFAULTS['player.speedLimit']);

      // Checkbox variant — wireDefault reads/writes `.value` which is
      // useless for type=checkbox (the meaningful prop is `.checked`).
      const wireDefaultCheckbox = (input, resetBtn, defaultValue) => {
        if (!input || !resetBtn) return;
        const refresh = () => { resetBtn.hidden = input.checked === defaultValue; };
        resetBtn.addEventListener('click', () => {
          input.checked = defaultValue;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          refresh();
          input.focus();
        });
        input.addEventListener('change', refresh);
        refresh();
      };
      wireDefaultCheckbox(autoplayCheckbox, panel.querySelector('#sp-autoplay-on-advance-reset'), SETTINGS_DEFAULTS['player.autoplayOnAdvance']);
      wireDefaultCheckbox(
        panel.querySelector('#sp-filler-enabled'),
        panel.querySelector('#sp-filler-enabled-reset'),
        SETTINGS_DEFAULTS['player.gapFiller.enabled'],
      );
      wireDefaultCheckbox(rangeExtender, panel.querySelector('#sp-range-extender-reset'), SETTINGS_DEFAULTS['player.rangeExtender.enabled']);
      wireDefaultCheckbox(rangeLivePreview, panel.querySelector('#sp-range-live-preview-reset'), SETTINGS_DEFAULTS['player.rangeLivePreview']);
      wireDefaultCheckbox(
        panel.querySelector('#sp-autoplay-on-open'),
        panel.querySelector('#sp-autoplay-on-open-reset'),
        SETTINGS_DEFAULTS['player.autoplayOnOpen'],
      );
    }, 0);

    return panel;
  }

  /**
   * Editor tab — script-authoring settings. Home for editor-specific
   * tunables that don't belong in Playback (which is about how the
   * video + script run together). Currently hosts the custom
   * position-key bindings; future editor-only options land here too.
   *
   * SCOPE: notes/features/SCOPE-editor-custom-position-keys.md
   */
  _buildEditorTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const customKeysSection = document.createElement('div');
    customKeysSection.className = 'settings-panel__section';
    customKeysSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('editor.customKeysTitle')}</h2>
      <div id="sp-custom-position-keys-mount"></div>
    `;
    panel.appendChild(customKeysSection);

    // Defer + lazy-load: the settings modal doesn't pay the cost of
    // pulling in custom-position-keys.js (and its KeyCapture dep) until
    // the user actually opens the Editor tab.
    setTimeout(async () => {
      const mountSlot = panel.querySelector('#sp-custom-position-keys-mount');
      if (!mountSlot) return;
      try {
        const { CustomPositionKeys } = await import('./custom-position-keys.js');
        new CustomPositionKeys({ element: mountSlot, settings: this._settings });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[settings-panel] failed to mount custom-position-keys', err);
      }
    }, 0);

    return panel;
  }

  _buildAppearanceTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const themeSection = document.createElement('div');
    themeSection.className = 'settings-panel__section';
    themeSection.id = 'sp-sec-theme';

    const current = this._settings.get('player.theme') || 'system';
    // Three radios — System default. We're explicit about "System" being a
    // real choice (not a hidden default) so users who change OS theme
    // mid-session see the app respect it. Hidden-system would mislead.
    themeSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.appearance.themeHeader')}</h2>
      <div class="settings-panel__hint" id="theme-hint">
        ${t('settingsPanel.appearance.themeHint')}
      </div>
      <div class="settings-panel__theme-options" role="radiogroup"
           aria-labelledby="theme-hint" data-setting="player.theme">
        <label class="settings-panel__theme-option">
          <input type="radio" name="theme" value="system" ${current === 'system' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">${t('settingsPanel.appearance.themeSystem')}</span>
            <span class="settings-panel__theme-desc">${t('settingsPanel.appearance.themeSystemDesc')}</span>
          </span>
        </label>
        <label class="settings-panel__theme-option">
          <input type="radio" name="theme" value="dark" ${current === 'dark' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">${t('settingsPanel.appearance.themeDark')}</span>
            <span class="settings-panel__theme-desc">${t('settingsPanel.appearance.themeDarkDesc')}</span>
          </span>
        </label>
        <label class="settings-panel__theme-option">
          <input type="radio" name="theme" value="light" ${current === 'light' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">${t('settingsPanel.appearance.themeLight')}</span>
            <span class="settings-panel__theme-desc">${t('settingsPanel.appearance.themeLightDesc')}</span>
          </span>
        </label>
      </div>
    `;

    themeSection.querySelector('[data-setting="player.theme"]')
      .addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'radio') return;
        // Persist to settings — theme-manager's settings:changed listener
        // reapplies the theme automatically (no need to re-call applyTheme
        // here; one place where the visual update originates keeps the
        // mental model simple — Norman conceptual model).
        this._settings.set('player.theme', target.value);
      });

    panel.appendChild(themeSection);

    // Interface style — Classic vs Modern. Orthogonal to the palette theme
    // above (applies in both dark and light). theme-manager's settings:changed
    // listener applies `data-style` automatically on change.
    const styleSection = document.createElement('div');
    styleSection.className = 'settings-panel__section';
    styleSection.id = 'sp-sec-style';
    const currentStyle = this._settings.get('player.uiStyle') || 'classic';
    styleSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.appearance.styleHeader')}</h2>
      <div class="settings-panel__hint" id="style-hint">
        ${t('settingsPanel.appearance.styleHint')}
      </div>
      <div class="settings-panel__theme-options" role="radiogroup"
           aria-labelledby="style-hint" data-setting="player.uiStyle">
        <label class="settings-panel__theme-option">
          <input type="radio" name="uiStyle" value="classic" ${currentStyle === 'classic' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">${t('settingsPanel.appearance.styleClassic')}</span>
            <span class="settings-panel__theme-desc">${t('settingsPanel.appearance.styleClassicDesc')}</span>
          </span>
        </label>
        <label class="settings-panel__theme-option">
          <input type="radio" name="uiStyle" value="modern" ${currentStyle === 'modern' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">${t('settingsPanel.appearance.styleModern')}</span>
            <span class="settings-panel__theme-desc">${t('settingsPanel.appearance.styleModernDesc')}</span>
          </span>
        </label>
      </div>
    `;
    styleSection.querySelector('[data-setting="player.uiStyle"]')
      .addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'radio') return;
        this._settings.set('player.uiStyle', target.value);
      });
    panel.appendChild(styleSection);

    // Interface size (Pudknocker #372, V79): the main window's zoom. Main
    // applies it (electron/ui-scale.js, through set-setting) and the View
    // menu's Ctrl+= / Ctrl+- / Ctrl+0 save to the same setting, so this
    // select and those keys always agree (show() keeps it in step while open).
    const scaleSection = document.createElement('div');
    scaleSection.className = 'settings-panel__section';
    scaleSection.id = 'sp-sec-scale';
    const scaleSteps = uiScaleSteps();
    const currentScale = nearestUiScale(this._settings.get('player.uiScale'), scaleSteps);
    const scaleOptions = scaleSteps.map((pct) => {
      const label = pct === uiScaleDefault()
        ? t('settingsPanel.appearance.scaleOptionDefault', { percent: pct })
        : t('settingsPanel.appearance.scaleOption', { percent: pct });
      return `<option value="${pct}" ${pct === currentScale ? 'selected' : ''}>${label}</option>`;
    }).join('');
    scaleSection.innerHTML = `
      <h2 class="settings-panel__section-header" id="sp-scale-header">${t('settingsPanel.appearance.scaleHeader')}</h2>
      <div class="settings-panel__hint" id="sp-scale-hint" style="margin-bottom:10px">
        ${t('settingsPanel.appearance.scaleHint')}
      </div>
      <select class="settings-panel__input settings-panel__input--select" data-setting="player.uiScale"
              aria-labelledby="sp-scale-header" aria-describedby="sp-scale-hint">
        ${scaleOptions}
      </select>
    `;
    scaleSection.querySelector('[data-setting="player.uiScale"]')
      .addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLSelectElement)) return;
        this._settings.set('player.uiScale', Number(target.value));
      });
    panel.appendChild(scaleSection);

    // Language section — locale picker. Native names in the dropdown so a
    // user who can't read the current UI language still recognises their
    // own (Nielsen #6 recognition over recall).
    const languageSection = document.createElement('div');
    languageSection.className = 'settings-panel__section';
    languageSection.id = 'sp-sec-language';
    const currentLocale = this._settings.get('player.language') || getCurrentLocale() || 'en';
    const options = SUPPORTED_LOCALES.map(code => {
      const label = LOCALE_LABELS[code] || code;
      const selected = code === currentLocale ? 'selected' : '';
      return `<option value="${code}" ${selected}>${label}</option>`;
    }).join('');
    languageSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.appearance.languageHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">
        ${t('settingsPanel.appearance.languageHint')}
      </div>
      <select class="settings-panel__input settings-panel__input--select" data-setting="player.language" aria-label="${t('settingsPanel.appearance.languageHeader')}">
        ${options}
      </select>
    `;
    languageSection.querySelector('[data-setting="player.language"]')
      .addEventListener('change', async (e) => {
        const target = e.target;
        if (!(target instanceof HTMLSelectElement)) return;
        const next = target.value;
        this._settings.set('player.language', next);
        // Picking from Settings is an explicit choice — same as picking
        // from the first-launch modal. Mark the flag so the modal does
        // not re-prompt on next launch.
        this._settings.set('player.languageSelected', true);
        try {
          // setLocale walks the static data-i18n keys itself, BEFORE the
          // language:changed handlers. Walking again here undid what they
          // set from state: a connected Handy read "Not connected" (V69).
          await setLocale(next);
        } catch (err) {
          console.warn('[settings] setLocale failed:', err);
        }
      });
    panel.appendChild(languageSection);

    // Library section — browsing visuals. The animated hover preview
    // (a playing <video> + canvas cycling through timestamps) is the
    // heaviest thing the grid does; on large libraries the decode churn
    // during fast mouse movement is what users feel as sluggishness.
    // Default ON to preserve behaviour; the gate in library.js only
    // disables on an explicit `false`.
    const librarySection = document.createElement('div');
    librarySection.className = 'settings-panel__section';
    librarySection.id = 'sp-sec-library';
    const movingOn = this._settings.get('library.movingPreviews') !== false;
    const folderPreviewsOn = this._settings.get('library.folderPreviews') !== false;
    // Default OFF (`=== true`), unlike the previews above: it adds a row to
    // every card and needs a funscript read per card to compute bins.
    const cardHeatmapOn = this._settings.get('library.showCardHeatmap') === true;
    // Default OFF (`=== true`, store default false): a tag line on every card.
    const cardTagsOn = this._settings.get('library.showTagsOnCards') === true;
    // Default ON (`!== false`): an invisible resume feature is no feature.
    // Still switchable — the bar is a visible record of what you watched.
    const resumeProgressOn = this._settings.get('library.showResumeProgress') !== false;
    // Linux-only: VA-API hardware video decode. Surfaced so users on a broken
    // GPU/VA-API driver (esp. nvidia-vaapi) can force software decode.
    librarySection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.appearance.libraryHeader')}</h2>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-moving-previews">${t('settingsPanel.appearance.movingPreviewsLabel')}</label>
        <input type="checkbox" id="sp-moving-previews" class="settings-panel__input settings-panel__input--checkbox" ${movingOn ? 'checked' : ''} aria-describedby="sp-moving-previews-hint">
      </div>
      <div class="settings-panel__hint" id="sp-moving-previews-hint">${t('settingsPanel.appearance.movingPreviewsHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-folder-previews">${t('settingsPanel.appearance.folderPreviewsLabel')}</label>
        <input type="checkbox" id="sp-folder-previews" class="settings-panel__input settings-panel__input--checkbox" ${folderPreviewsOn ? 'checked' : ''} aria-describedby="sp-folder-previews-hint">
      </div>
      <div class="settings-panel__hint" id="sp-folder-previews-hint">${t('settingsPanel.appearance.folderPreviewsHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-card-heatmap">${t('settingsPanel.appearance.cardHeatmapLabel')}</label>
        <input type="checkbox" id="sp-card-heatmap" class="settings-panel__input settings-panel__input--checkbox" ${cardHeatmapOn ? 'checked' : ''} aria-describedby="sp-card-heatmap-hint">
      </div>
      <div class="settings-panel__hint" id="sp-card-heatmap-hint">${t('settingsPanel.appearance.cardHeatmapHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-card-tags">${t('settingsPanel.appearance.tagsOnCardsLabel')}</label>
        <input type="checkbox" id="sp-card-tags" class="settings-panel__input settings-panel__input--checkbox" ${cardTagsOn ? 'checked' : ''} aria-describedby="sp-card-tags-hint">
      </div>
      <div class="settings-panel__hint" id="sp-card-tags-hint">${t('settingsPanel.appearance.tagsOnCardsHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-resume-progress">${t('settingsPanel.appearance.resumeProgressLabel')}</label>
        <input type="checkbox" id="sp-resume-progress" class="settings-panel__input settings-panel__input--checkbox" ${resumeProgressOn ? 'checked' : ''} aria-describedby="sp-resume-progress-hint">
      </div>
      <div class="settings-panel__hint" id="sp-resume-progress-hint">${t('settingsPanel.appearance.resumeProgressHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-hide-dupes">${t('settingsPanel.appearance.hideDupesLabel')}</label>
        <input type="checkbox" id="sp-hide-dupes" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('library.hideDuplicateNames') === true ? 'checked' : ''} aria-describedby="sp-hide-dupes-hint">
      </div>
      <div class="settings-panel__hint" id="sp-hide-dupes-hint">${t('settingsPanel.appearance.hideDupesHint')}</div>
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-folder-variants">${t('settingsPanel.appearance.folderScriptsAsVariantsLabel')}</label>
        <input type="checkbox" id="sp-folder-variants" class="settings-panel__input settings-panel__input--checkbox" ${this._settings.get('library.folderScriptsAsVariants') === true ? 'checked' : ''} aria-describedby="sp-folder-variants-hint">
      </div>
      <div class="settings-panel__hint" id="sp-folder-variants-hint">${t('settingsPanel.appearance.folderScriptsAsVariantsHint')}</div>
    `;
    librarySection.querySelector('#sp-moving-previews')
      .addEventListener('change', (e) => {
        this._settings.set('library.movingPreviews', !!e.target.checked);
      });
    librarySection.querySelector('#sp-folder-previews')
      .addEventListener('change', (e) => {
        this._settings.set('library.folderPreviews', !!e.target.checked);
      });
    librarySection.querySelector('#sp-card-heatmap')
      .addEventListener('change', (e) => {
        this._settings.set('library.showCardHeatmap', !!e.target.checked);
        // Cards are built once; the row has to be added/removed by a re-render.
        if (this.onLibraryDisplayChanged) this.onLibraryDisplayChanged(!!e.target.checked);
      });
    librarySection.querySelector('#sp-card-tags')
      .addEventListener('change', (e) => {
        this._settings.set('library.showTagsOnCards', !!e.target.checked);
        // Cards are built once: the tag line comes and goes with a re-render.
        if (this.onLibraryDisplayChanged) this.onLibraryDisplayChanged(!!e.target.checked);
      });
    librarySection.querySelector('#sp-resume-progress')
      .addEventListener('change', (e) => {
        this._settings.set('library.showResumeProgress', !!e.target.checked);
        // Same re-render requirement as the heatmap row above.
        if (this.onLibraryDisplayChanged) this.onLibraryDisplayChanged(!!e.target.checked);
      });
    librarySection.querySelector('#sp-hide-dupes')
      .addEventListener('change', (e) => {
        this._settings.set('library.hideDuplicateNames', !!e.target.checked);
        // Changes which videos are in the list, not just how they look —
        // the grid has to re-filter, not merely re-render.
        if (this.onLibraryDisplayChanged) this.onLibraryDisplayChanged(!!e.target.checked);
      });
    librarySection.querySelector('#sp-folder-variants')
      .addEventListener('change', (e) => {
        this._settings.set('library.folderScriptsAsVariants', !!e.target.checked);
        // The pairing is the scan's (FT-102): rescan, the way a source change
        // does, so the variant menus, the phone and VR follow at once.
        if (this._onSourcesChanged) this._onSourcesChanged();
      });
    panel.appendChild(librarySection);

    // Navigation bar (zaikechi #381): untick a button to take it off the bar.
    // A tick means "shown", so the default (everything ticked) is the bar as
    // it always was. Stored inverted as `player.navHidden` flags, which is
    // what NavBar reads. Library and Settings are not listed: hiding either
    // would leave no way back.
    const navSection = document.createElement('div');
    navSection.className = 'settings-panel__section';
    navSection.id = 'sp-sec-nav';
    const navHidden = this._settings.get('player.navHidden') || {};
    navSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.appearance.navHeader')}</h2>
      <div class="settings-panel__hint" id="sp-nav-hint" style="margin-bottom:10px">${t('settingsPanel.appearance.navHint')}</div>
      ${NAV_HIDEABLE_ITEMS.map(({ key, labelKey }) => `
      <div class="settings-panel__field">
        <label class="settings-panel__field-label" for="sp-nav-show-${key}">${t(labelKey)}</label>
        <input type="checkbox" id="sp-nav-show-${key}" data-nav-key="${key}" class="settings-panel__input settings-panel__input--checkbox" ${navHidden[key] === true ? '' : 'checked'} aria-describedby="sp-nav-hint">
      </div>`).join('')}
    `;
    navSection.addEventListener('change', (e) => {
      const key = e.target?.dataset?.navKey;
      if (!key) return;
      const next = { ...(this._settings.get('player.navHidden') || {}), [key]: !e.target.checked };
      this._settings.set('player.navHidden', next);
      if (this.onNavHiddenChanged) this.onNavHiddenChanged(next);
    });
    panel.appendChild(navSection);

    return panel;
  }

  _buildDataTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    // --- Section 1: Backup & Recovery (rolling snapshots) ----------------
    // Surfaces the automatic snapshot system. Status line provides
    // visibility (Nielsen #1) so users know the safety net is on; the
    // "Restore" affordance gives them user control + a clear undo path
    // for when they regret a config change (Shneiderman #6 reversibility).
    // Snapshot summaries on each row let the user recognise rather than
    // recall (Nielsen #6) which backup to roll back to.
    const backupSection = document.createElement('div');
    backupSection.className = 'settings-panel__section';
    backupSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.data.backupHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">
        ${t('settingsPanel.data.backupBlurb')}
      </div>
      <div id="sp-backup-status" class="settings-panel__hint" style="margin-bottom:12px">${t('settingsPanel.data.backupLoading')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="sp-backup-now" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.data.snapshotNow')}</button>
        <button id="sp-backup-restore" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.data.restore')}</button>
        <button id="sp-backup-folder" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.data.openFolder')}</button>
      </div>
    `;
    panel.appendChild(backupSection);

    // --- Section 2: Export & Import (existing zip flow) ------------------
    // Distinct from the snapshot system: this is for moving settings
    // BETWEEN machines / installations. Snapshots stay local; .funsync-
    // backup is a portable file.
    const exportSection = document.createElement('div');
    exportSection.className = 'settings-panel__section';
    exportSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.data.exportHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">${t('settingsPanel.data.exportBlurb')}</div>
      <div style="display:flex;gap:8px">
        <button id="sp-export" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.data.export')}</button>
        <button id="sp-import" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.data.import')}</button>
      </div>
    `;
    panel.appendChild(exportSection);

    // --- Section: Find duplicates ----------------------------------------
    // pallokala2 (#330) wants disk space back, not a tidier grid, so this
    // lives in Data next to the other library-maintenance actions rather
    // than in Appearance with the display-only "hide duplicate names"
    // toggle. Different jobs: that one hides them, this one removes them.
    const dupesSection = document.createElement('div');
    dupesSection.className = 'settings-panel__section';
    dupesSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.duplicates.sectionHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:12px">
        ${t('settingsPanel.duplicates.sectionBlurb', { os: binOs() })}
      </div>
    `;
    const dupesBtn = document.createElement('button');
    dupesBtn.type = 'button';
    // Same look as the Snapshot / Export buttons above. `settings-panel__btn`
    // has no CSS anywhere, so this rendered as a bare native button (V52).
    dupesBtn.className = 'settings-panel__add-btn';
    dupesBtn.style.borderStyle = 'solid';
    dupesBtn.id = 'sp-find-duplicates';
    dupesBtn.textContent = t('settingsPanel.duplicates.findBtn');
    dupesBtn.addEventListener('click', () => {
      if (this.onFindDuplicates) this.onFindDuplicates();
    });
    dupesSection.appendChild(dupesBtn);
    panel.appendChild(dupesSection);

    setTimeout(() => {
      this._wireDataTab(panel);
      this._refreshBackupStatus(panel);
    }, 0);

    return panel;
  }

  // Help tab — support / diagnostics / about. Lives separate from Data
  // (which is about managing app config) because reporting a problem,
  // opening logs, and looking up shortcuts are help/communication
  // actions, not data management (Norman: conceptual model — match
  // surface category to user's mental model). Mirrors Discord and
  // VS Code's Help-section pattern; peer-app survey in
  // notes/features/SCOPE-feedback-reporting.md.
  /**
   * Security tab — currently one control: hide media file names in the log.
   *
   * Exists because #bug-reports on Discord asks users to paste main.log, and
   * that log records the full path of every video opened. For this app the
   * FILENAME is the most revealing line in the file, so pasting one publicly
   * should be a deliberate choice rather than an accident.
   *
   * Off by default: most users are diagnosing their own machine, where a
   * redacted log is simply a worse log.
   */
  _buildSecurityTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const section = document.createElement('div');
    section.className = 'settings-panel__section';
    section.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.security.logsHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:12px">
        ${t('settingsPanel.security.logsBlurb')}
      </div>
    `;

    // The field-row pattern every other setting uses. `settings-panel__row`
    // and `settings-panel__label` have no CSS, so the label came out at the
    // base font size with the switch butted against it (V52).
    const row = document.createElement('div');
    row.className = 'settings-panel__field';

    const label = document.createElement('label');
    label.className = 'settings-panel__field-label';
    label.textContent = t('settingsPanel.security.hideFileNames');

    const toggle = createToggleSwitch({
      checked: !!this._settings.get('security.hideLogFileNames'),
      label: t('settingsPanel.security.hideFileNames'),
      onChange: (next) => {
        // The main process hooks this same key and updates the log redactor
        // immediately, so it takes effect without a restart.
        this._settings.set('security.hideLogFileNames', next);
      },
    });

    row.appendChild(label);
    row.appendChild(toggle);
    section.appendChild(row);

    const detail = document.createElement('div');
    detail.className = 'settings-panel__hint';
    detail.style.marginTop = '8px';
    detail.textContent = t('settingsPanel.security.hideFileNamesHint');
    section.appendChild(detail);

    panel.appendChild(section);
    return panel;
  }

  _buildHelpTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    // --- Section 1: Report a Problem ------------------------------------
    // Manual bug-report path. Opens a dialog that bundles app version,
    // OS, and the last ~80 log lines into a payload the user can edit
    // before submitting via GitHub / clipboard / file (Nielsen #1
    // visibility — user sees exactly what gets sent; Shneiderman #6
    // reversibility — every field is editable until they click send).
    const feedbackSection = document.createElement('div');
    feedbackSection.className = 'settings-panel__section';
    feedbackSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('feedback.sectionHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">${t('feedback.sectionBlurb')}</div>
      <div style="display:flex;gap:8px">
        <button id="sp-feedback" class="settings-panel__add-btn" style="border-style:solid">${t('feedback.sectionButton')}</button>
      </div>
    `;
    panel.appendChild(feedbackSection);

    // --- Section 2: Diagnostic Logs -------------------------------------
    // Reveal the app log in OS file explorer so the user can attach it
    // to a bug report. Different from the "Report a problem" log-tail
    // path (which is auto-bundled into the GitHub URL) — this gives
    // them the FULL log file when 80 lines isn't enough.
    const logsSection = document.createElement('div');
    logsSection.className = 'settings-panel__section';
    logsSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.help.logsHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">${t('settingsPanel.help.logsBlurb')}</div>
      <div style="display:flex;gap:8px">
        <button id="sp-open-log-folder" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.help.openLogFolder')}</button>
      </div>
    `;
    panel.appendChild(logsSection);

    // --- Section 3: Keyboard Shortcuts ----------------------------------
    // Discoverability path for the `?`-overlay. Power users press `?`;
    // novices find this section. Nielsen #10 (help / documentation) +
    // Shneiderman #2 (universal usability — both paths work).
    const shortcutsSection = document.createElement('div');
    shortcutsSection.className = 'settings-panel__section';
    shortcutsSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.help.shortcutsHeader')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">${t('settingsPanel.help.shortcutsBlurb')}</div>
      <div style="display:flex;gap:8px">
        <button id="sp-show-shortcuts" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.help.showShortcuts')}</button>
      </div>
    `;
    panel.appendChild(shortcutsSection);

    // --- Section 4: About -----------------------------------------------
    // Version + project links. Read-only — purely informational
    // (Nielsen #1 visibility of system status). External links open in
    // the user's default browser via shell.openExternal.
    const aboutSection = document.createElement('div');
    aboutSection.className = 'settings-panel__section';
    aboutSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.help.aboutHeader')}</h2>
      <div id="sp-about-version" class="settings-panel__hint" style="margin-bottom:10px">${t('settingsPanel.help.aboutVersion', { version: '…' })}</div>
      <div id="sp-about-portable" class="settings-panel__hint" style="margin-bottom:10px" hidden></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="sp-about-github" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.help.aboutGithub')}</button>
        <button id="sp-about-license" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.help.aboutLicense')}</button>
      </div>
    `;
    panel.appendChild(aboutSection);
    // Resolve the version asynchronously (IPC). Placeholder shows '…'
    // until the response lands — usually a single tick.
    window.funsync.getAppVersion?.().then((version) => {
      const el = panel.querySelector('#sp-about-version');
      if (el) el.textContent = t('settingsPanel.help.aboutVersion', { version: version || '?' });
    }).catch(() => { /* leave placeholder */ });
    // Portable-mode indicator — only shown when running portably so normal
    // installs see nothing (Nielsen #1 + #8 minimalist). Tells the user where
    // their data lives, which matters most on a USB stick.
    window.funsync.getPortableInfo?.().then((info) => {
      const el = panel.querySelector('#sp-about-portable');
      if (el && info?.portable) {
        el.textContent = t('settingsPanel.help.portableMode', { dir: info.dataDir || '' });
        el.hidden = false;
      }
    }).catch(() => { /* not portable / unavailable */ });

    // --- Section: Support ------------------------------------------------
    //
    // The Ko-fi link existed in exactly one place: the EroScripts thread OP,
    // which is now hundreds of posts long and which a growing share of users
    // never read. Weekday analysis (2026-08-26) showed downloads have
    // decoupled from forum activity — Monday forum posts run 77% below
    // average while installs hold at +2% — so people are arriving via GitHub
    // and word of mouth and never seeing that the project has a coffee link
    // at all. Lifetime: 3 donations against ~5,600 downloads. The constraint
    // was exposure, not willingness.
    //
    // Deliberately a quiet section at the BOTTOM of Help, not a nag: no
    // modal, no toast, no badge on the nav bar, nothing that appears
    // uninvited. Someone who never opens Settings never sees it, which is
    // the correct trade for a free tool.
    const supportSection = document.createElement('div');
    supportSection.className = 'settings-panel__section';
    supportSection.innerHTML = `
      <h2 class="settings-panel__section-header">${t('settingsPanel.support.header')}</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">${t('settingsPanel.support.blurb')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="sp-support-discord" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.support.discord')}</button>
        <button id="sp-support-kofi" class="settings-panel__add-btn" style="border-style:solid">${t('settingsPanel.support.kofi')}</button>
      </div>
      <div class="settings-panel__hint" style="margin-top:10px">${t('settingsPanel.support.footnote')}</div>
    `;
    panel.appendChild(supportSection);

    setTimeout(() => this._wireHelpTab(panel), 0);
    return panel;
  }

  _wireHelpTab(panel) {
    panel.querySelector('#sp-feedback')?.addEventListener('click', () => {
      openFeedbackModal({ getConnectionState: this.getConnectionState });
    });
    panel.querySelector('#sp-open-log-folder')?.addEventListener('click', async () => {
      try {
        const result = await window.funsync.openLogFolder();
        if (!result?.success) showToast(t('settingsPanel.help.openLogFolderFailed'), 'error');
      } catch {
        showToast(t('settingsPanel.help.openLogFolderFailed'), 'error');
      }
    });
    panel.querySelector('#sp-show-shortcuts')?.addEventListener('click', async () => {
      // Lazy-import — keyboard-help loads its own large groups arrays.
      const { openKeyboardHelp, getPlayerShortcutGroups } = await import('../js/keyboard-help.js');
      openKeyboardHelp(t('kbd.playerTitle'), getPlayerShortcutGroups());
    });
    panel.querySelector('#sp-about-github')?.addEventListener('click', () => {
      window.funsync.openExternal('https://github.com/DaveMakesWaves/funsync-player');
    });
    panel.querySelector('#sp-about-license')?.addEventListener('click', () => {
      window.funsync.openExternal('https://github.com/DaveMakesWaves/funsync-player/blob/main/LICENSE');
    });
    // Support links. Same openExternal path as the About links above — the
    // main process only opens http/https, so these cannot become an
    // arbitrary-scheme launcher.
    panel.querySelector('#sp-support-discord')?.addEventListener('click', () => {
      window.funsync.openExternal('https://discord.gg/tuveeXxFx5');
    });
    panel.querySelector('#sp-support-kofi')?.addEventListener('click', () => {
      window.funsync.openExternal('https://ko-fi.com/davemakeswaves');
    });
  }

  // Format a snapshot's age relative to now in a recognition-first style
  // (Nielsen #6) — "12 minutes ago" reads faster than a wall-clock time
  // that the user has to math against. Falls back to a date for old
  // snapshots so they don't read as "47 days ago" (loses precision).
  _formatRelativeTime(date) {
    const ms = Date.now() - date.getTime();
    if (ms < 0) return t('settingsPanel.data.relJustNow');
    const min = Math.floor(ms / 60_000);
    const hr = Math.floor(ms / 3_600_000);
    const day = Math.floor(ms / 86_400_000);
    if (min < 1) return t('settingsPanel.data.relJustNow');
    if (min < 60) return t('settingsPanel.data.relMinutesAgo', { count: min });
    if (hr < 24) return t('settingsPanel.data.relHoursAgo', { count: hr });
    if (day === 1) return t('settingsPanel.data.relYesterday');
    if (day < 7) return t('settingsPanel.data.relDaysAgo', { count: day });
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Trigger names from data-backup.js TRIGGER enum mapped to human labels.
  // Kept in the renderer rather than imported from main so we don't have
  // to thread a constants file across the contextBridge.
  _formatTrigger(trigger, label) {
    switch (trigger) {
      case 'startup':       return t('settingsPanel.data.triggerStartup');
      case 'debounced':     return t('settingsPanel.data.triggerDebounced');
      case 'pre-action':    return label ? t('settingsPanel.data.triggerPreAction', { label: label.replace(/-/g, ' ') }) : t('settingsPanel.data.triggerPreActionFallback');
      case 'manual':        return t('settingsPanel.data.triggerManual');
      case 'quit':          return t('settingsPanel.data.triggerQuit');
      case 'post-recovery': return t('settingsPanel.data.triggerPostRecovery');
      case 'baseline':      return t('settingsPanel.data.triggerBaseline');
      default:              return trigger || t('settingsPanel.data.triggerSnapshot');
    }
  }

  // One restore-list row's contents. The counts are how a user tells the
  // snapshot from before a loss apart from the one after it, so every kind
  // of data a loss can hit is listed: category assignments and
  // associations were missing, and a V01-style loss (assignments gone,
  // everything else intact) left two rows that read the same (V58).
  _formatSnapshotSummary(summary) {
    const s = summary || {};
    const parts = [];
    if (s.sources)             parts.push(t('settingsPanel.data.summarySources', { count: s.sources }));
    if (s.collections)         parts.push(t('settingsPanel.data.summaryCollections', { count: s.collections }));
    if (s.playlists)           parts.push(t('settingsPanel.data.summaryPlaylists', { count: s.playlists }));
    if (s.categories)          parts.push(t('settingsPanel.data.summaryCategories', { count: s.categories }));
    if (s.categoryAssignments) parts.push(t('settingsPanel.data.summaryCategoryAssignments', { count: s.categoryAssignments }));
    if (s.manualAssociations)  parts.push(t('settingsPanel.data.summaryAssociations', { count: s.manualAssociations }));
    if (s.customRoutings)      parts.push(t('settingsPanel.data.summaryRoutings', { count: s.customRoutings }));
    if (s.tagAssignments)      parts.push(t('settingsPanel.data.summaryTagAssignments', { count: s.tagAssignments }));
    if (s.eroscriptsLinks)     parts.push(t('settingsPanel.data.summaryEroscriptsLinks', { count: s.eroscriptsLinks }));
    return parts.join(', ') || t('settingsPanel.data.summaryEmpty');
  }

  _formatBytes(bytes) {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async _refreshBackupStatus(panel) {
    const statusEl = panel.querySelector('#sp-backup-status');
    if (!statusEl) return;
    try {
      const result = await window.funsync.backupList();
      if (!result?.success || !result.snapshots?.length) {
        statusEl.textContent = t('settingsPanel.data.backupNone');
        return;
      }
      const newest = result.snapshots[0];
      const totalBytes = result.snapshots.reduce((s, e) => s + (e.sizeBytes || 0), 0);
      const when = this._formatRelativeTime(new Date(newest.timestamp));
      const count = result.snapshots.length;
      statusEl.textContent = t('settingsPanel.data.backupLastLine', { when, count, total: this._formatBytes(totalBytes) });
    } catch (err) {
      statusEl.textContent = t('settingsPanel.data.backupUnavailable');
    }
  }

  _wireDataTab(panel) {
    // --- Snapshot Now ----------------------------------------------------
    panel.querySelector('#sp-backup-now')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#sp-backup-now');
      btn.disabled = true; btn.textContent = t('settingsPanel.data.snapshotting');
      try {
        const result = await window.funsync.backupSnapshotNow();
        if (result?.success) {
          showToast(t('settingsPanel.data.snapshotTaken'), 'info');
          this._refreshBackupStatus(panel);
        } else {
          showToast(t('settingsPanel.data.snapshotFailedReason', { error: result?.error || 'unknown error' }), 'error');
        }
      } catch (err) {
        showToast(t('settingsPanel.data.snapshotFailed'), 'error');
      }
      btn.disabled = false; btn.textContent = t('settingsPanel.data.snapshotNow');
    });

    // --- Restore From Backup ---------------------------------------------
    panel.querySelector('#sp-backup-restore')?.addEventListener('click', async () => {
      let listResult;
      try {
        listResult = await window.funsync.backupList();
      } catch (err) {
        showToast(t('settingsPanel.data.noBackupsList'), 'error');
        return;
      }
      if (!listResult?.success || !listResult.snapshots?.length) {
        showToast(t('settingsPanel.data.noBackupsAvailable'), 'info');
        return;
      }

      // Build the picker rows. Each item id is `subdir/filename` so the
      // restore IPC can route back to the right file.
      const items = listResult.snapshots.map(snap => {
        const when = new Date(snap.timestamp).toLocaleString(undefined, {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        const trig = this._formatTrigger(snap.trigger, snap.label);
        const subtitle = `${this._formatBytes(snap.sizeBytes)} · ${this._formatSnapshotSummary(snap.summary)}`;
        return {
          id: `${snap.subdir}/${snap.filename}`,
          label: `${when}  ·  ${trig}`,
          subtitle,
        };
      });

      const picked = await Modal.selectFromList(t('settingsPanel.data.restoreModalTitle'), items);
      if (!picked) return;

      // Confirm — restore is destructive (overwrites live config) and
      // requires a relaunch. Spell out the consequences (Shneiderman #4
      // dialog closure) and that we save the current state first
      // (Shneiderman #6 reversibility) so the user knows they can undo.
      const ok = await Modal.confirm(
        t('settingsPanel.data.restoreConfirmTitle'),
        t('settingsPanel.data.restoreConfirmBody'),
        { confirmText: t('settingsPanel.data.restoreConfirmBtn') },
      );
      if (!ok) return;

      const [subdir, filename] = picked.split('/');
      try {
        const result = await window.funsync.backupRestore(subdir, filename);
        // Cancel at the unsaved-editor-edits question: nothing was restored
        // and the user chose that, so no failure toast (R3-19).
        if (result?.cancelled) return;
        if (!result?.success) {
          showToast(t('settingsPanel.data.restoreFailedReason', { error: result?.error || 'unknown error' }), 'error');
        }
        // On success the main process relaunches the app, so this
        // renderer is about to be torn down — no further UI updates.
      } catch (err) {
        showToast(t('settingsPanel.data.restoreFailed'), 'error');
      }
    });

    // --- Open Backup Folder ----------------------------------------------
    panel.querySelector('#sp-backup-folder')?.addEventListener('click', async () => {
      try {
        const result = await window.funsync.backupOpenFolder();
        if (!result?.success) showToast(t('settingsPanel.data.openFolderFailed'), 'error');
      } catch (err) {
        showToast(t('settingsPanel.data.openFolderFailed'), 'error');
      }
    });

    // --- Export / Import (existing zip flow) -----------------------------
    panel.querySelector('#sp-export')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#sp-export');
      btn.disabled = true; btn.textContent = t('settingsPanel.data.exporting');
      try {
        const result = await window.funsync.exportData();
        if (result.success) showToast(t('settingsPanel.data.exportSaved', { path: result.path }), 'info');
        else showToast(t('settingsPanel.data.exportFailed'), 'error');
      } catch { showToast(t('settingsPanel.data.exportFailed'), 'error'); }
      btn.disabled = false; btn.textContent = t('settingsPanel.data.export');
    });

    // Import merges a backup file into the live config and RELAUNCHES, as
    // Restore does: every component holds settings read at boot, and the
    // DataService cache writes whole maps back, so an import that is not
    // followed by a fresh boot gets overwritten by the next edit (V02).
    // Say so before the file picker, not after the window disappears.
    panel.querySelector('#sp-import')?.addEventListener('click', async () => {
      const ok = await Modal.confirm(
        t('settingsPanel.data.importConfirmTitle'),
        t('settingsPanel.data.importConfirmBody'),
        { confirmText: t('settingsPanel.data.import') },
      );
      if (!ok) return;
      const btn = panel.querySelector('#sp-import');
      btn.disabled = true; btn.textContent = t('settingsPanel.data.importing');
      try {
        const result = await window.funsync.importData();
        // On success the main process relaunches the app, so this renderer
        // is about to be torn down; only the failure paths need UI.
        if (!result?.success) this._showImportFailure(result);
      } catch { showToast(t('settingsPanel.data.importFailed'), 'error'); }
      btn.disabled = false; btn.textContent = t('settingsPanel.data.import');
    });
  }

  /**
   * Toast for an import that did not happen. Says why, as Restore does, so
   * the user can tell a file that is not a backup from a broken one.
   */
  _showImportFailure(result) {
    if (result?.error === 'Cancelled') showToast(t('settingsPanel.data.importCancelled'), 'info');
    else if (result?.error) showToast(t('settingsPanel.data.importFailedReason', { error: result.error }), 'error');
    else showToast(t('settingsPanel.data.importFailed'), 'error');
  }
}
