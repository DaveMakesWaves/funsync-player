// NavBar — Persistent top navigation bar

import { icon, Library, ListVideo, Tag, Download, Unplug, Settings, Smartphone, Goggles, ChevronDown, CircleStop } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { moveMenuFocus, focusMenuFromKeyboard } from '../js/menu-keys.js';

/**
 * Nav-bar buttons a user can hide (zaikechi #381), in bar order, with the
 * label each one shows. Settings > Appearance > Navigation bar lists exactly
 * these; `player.navHidden` holds one flag per key. Library and Settings are
 * deliberately absent: without them there is no way back to anything.
 */
export const NAV_HIDEABLE_ITEMS = Object.freeze([
  { key: 'playlists', labelKey: 'nav.playlists' },
  { key: 'categories', labelKey: 'nav.categories' },
  { key: 'eroscripts', labelKey: 'nav.eroscripts' },
  { key: 'devices', labelKey: 'nav.devices' },
  { key: 'remote', labelKey: 'nav.webRemote' },
  { key: 'vr', labelKey: 'nav.vr' },
]);

/** How many `nav-bar--fit-N` steps nav-bar.css defines (see `_fitToWidth`). */
const NAV_FIT_LEVELS = 5;

/**
 * What the Devices pill says (Dave, 2026-11-25: one status pill, "but with 1
 * what if more than one device is connected?"). `devices` is every connected
 * device as `{ label, state }`, state 'connected' | 'slow' | 'unresponsive'.
 *
 *   none                 grey   "No devices"
 *   one                  green  its own name ("The Handy")
 *   two or more          green  "3 devices"; the tooltip lists each one
 *   one not responding   red    "The Handy not responding": a problem
 *                               outranks the count and names the device
 *   connecting           amber  "Connecting…"
 *   one slow to respond  amber  the name or count as usual; the tooltip says which
 *
 * A count rather than "The Handy +2": among a Handy, Intiface toys, T-Code
 * and an Autoblow there is no first device to name.
 * @returns {{status: string, text: string, title: string, aria: string, count: number}}
 */
export function deviceStatusSummary(devices = [], { connecting = false } = {}) {
  const list = (Array.isArray(devices) ? devices : [])
    .filter((d) => d && typeof d.label === 'string' && d.label.trim());
  const stateText = (s) => (s === 'unresponsive' ? t('nav.notResponding')
    : s === 'slow' ? t('nav.deviceSlow') : t('nav.connected'));
  const lines = list.map((d) => `${d.label.trim()} · ${stateText(d.state)}`);
  const bad = list.find((d) => d.state === 'unresponsive');
  let status;
  let text;
  if (bad) {
    status = 'unresponsive';
    text = t('nav.deviceNotResponding', { name: bad.label.trim() });
  } else if (connecting) {
    status = 'connecting';
    text = t('nav.connecting');
  } else if (!list.length) {
    status = 'disconnected';
    text = t('nav.noDevices');
  } else {
    status = list.some((d) => d.state === 'slow') ? 'slow' : 'connected';
    text = list.length === 1 ? list[0].label.trim() : t('nav.deviceTotal', { count: list.length });
  }
  const said = connecting && !bad ? [text, ...lines] : (lines.length ? lines : [text]);
  return {
    status,
    text,
    title: lines.length ? lines.join('\n') : t('nav.deviceConnection'),
    aria: t('nav.devicesAria', { status: said.join(', ') }),
    count: list.length,
  };
}

/** The LED class for each pill status ('slow' is amber, as before). */
const LED_FOR_STATUS = Object.freeze({
  connected: 'connected', slow: 'connecting', connecting: 'connecting', unresponsive: 'unresponsive',
});

export class NavBar {
  constructor({ onNavigate, onHandyClick, onSettingsClick, onRemoteClick, onVRClick, onEroScriptsClick, onLoadUrlClick, onLibraryCollectionChange, onNewCollection, onRenameCollection, onDeleteCollection, onAddSource, onStopAll, onDisabledVideos }) {
    this._onNavigate = onNavigate;
    // Stop all (DESIGN.md §2.15): the stop sign beside the device status.
    this._onStopAll = onStopAll;
    this._onHandyClick = onHandyClick;
    this._onSettingsClick = onSettingsClick;
    this._onRemoteClick = onRemoteClick;
    this._onVRClick = onVRClick;
    this._onEroScriptsClick = onEroScriptsClick;
    this._onLoadUrlClick = onLoadUrlClick;
    this._onLibraryCollectionChange = onLibraryCollectionChange;
    // "Scripts without a video" (v0.10.1, the script player).
    this._onDisabledVideos = onDisabledVideos;
    this._onNewCollection = onNewCollection;
    this._onRenameCollection = onRenameCollection;
    this._onDeleteCollection = onDeleteCollection;
    this._onAddSource = onAddSource;
    this._el = null;
    this._activeId = null;
    this._handyBtn = null;
    this._handyLed = null;
    this._handyText = null;
    this._libraryBtn = null;
    this._libraryDropdown = null;
    this._collections = [];
    this._activeCollectionId = null;
    this._sources = [];
    // Labels resolved via `t()` at render time AND on every
    // language:changed event (subscribed in `init`). Storing the
    // key, not the string, so the label is always current.
    this._items = [
      { id: 'library', labelKey: 'nav.library', iconNode: Library },
      { id: 'playlists', labelKey: 'nav.playlists', iconNode: ListVideo },
      { id: 'categories', labelKey: 'nav.categories', iconNode: Tag },
    ];
  }

  init(parentEl) {
    this._el = document.createElement('nav');
    this._el.className = 'nav-bar';
    this._el.setAttribute('role', 'navigation');
    this._el.setAttribute('aria-label', t('nav.mainNavAria'));

    // The Holiday style's logo (gold ring, Santa hat). Decorative, and hidden
    // by renderer/styles/holiday.css unless <html data-season="holiday">.
    const holidayLogo = document.createElement('span');
    holidayLogo.className = 'nav-bar__holiday-logo';
    holidayLogo.setAttribute('aria-hidden', 'true');
    this._el.appendChild(holidayLogo);

    for (const item of this._items) {
      if (item.id === 'library') {
        // Library gets a dropdown for collections
        const wrapper = document.createElement('div');
        wrapper.className = 'nav-bar__library-wrapper';

        const btn = document.createElement('button');
        btn.className = 'nav-bar__item';
        btn.dataset.viewId = 'library';
        btn.title = t(item.labelKey);

        const iconEl = document.createElement('span');
        iconEl.className = 'nav-bar__icon';
        iconEl.appendChild(icon(item.iconNode, { width: 16, height: 16 }));

        this._libraryLabel = document.createElement('span');
        this._libraryLabel.className = 'nav-bar__label';
        this._libraryLabel.dataset.i18nKey = item.labelKey;
        this._libraryLabel.textContent = t(item.labelKey);

        btn.appendChild(iconEl);
        btn.appendChild(this._libraryLabel);
        btn.addEventListener('click', () => this._onNavigate('library'));

        // Library-switcher arrow — was a raw `▾` unicode glyph; now a
        // real chevron icon. Carries `aria-haspopup="menu"` and an
        // `aria-expanded` flag that toggles in `_toggleLibraryDropdown`
        // so screen readers announce dropdown state changes.
        const arrow = document.createElement('button');
        arrow.className = 'nav-bar__library-arrow';
        arrow.appendChild(icon(ChevronDown, { width: 16, height: 16 }));
        arrow.title = t('nav.switchLibrary');
        arrow.setAttribute('aria-label', t('nav.switchLibrary'));
        arrow.setAttribute('aria-haspopup', 'menu');
        arrow.setAttribute('aria-expanded', 'false');
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleLibraryDropdown({ fromKeyboard: e.detail === 0 });
        });

        this._libraryDropdown = document.createElement('div');
        this._libraryDropdown.className = 'nav-bar__library-dropdown';
        this._libraryDropdown.hidden = true;

        wrapper.appendChild(btn);
        wrapper.appendChild(arrow);
        wrapper.appendChild(this._libraryDropdown);
        this._libraryBtn = btn;
        this._el.appendChild(wrapper);
      } else {
        const btn = document.createElement('button');
        btn.className = 'nav-bar__item';
        btn.dataset.viewId = item.id;
        btn.title = t(item.labelKey);

        const iconEl = document.createElement('span');
        iconEl.className = 'nav-bar__icon';
        iconEl.appendChild(icon(item.iconNode, { width: 16, height: 16 }));

        const label = document.createElement('span');
        label.className = 'nav-bar__label';
        label.dataset.i18nKey = item.labelKey;
        label.textContent = t(item.labelKey);

        btn.appendChild(iconEl);
        btn.appendChild(label);
        btn.addEventListener('click', () => this._onNavigate(item.id));
        this._el.appendChild(btn);
      }
    }

    // ---- Right-side actions ---------------------------------------
    //
    // Five buttons total, organised into THREE clusters with subtle
    // gap separators (Norman conceptual model + Shneiderman #1):
    //
    //   [EroScripts]  ⎯⎯  [Devices] [Web Remote] [VR]  ⎯⎯  [Settings]
    //                 ↑                              ↑
    //          cluster-gap                    cluster-gap
    //
    // All five share the .nav-bar__action class for visual consistency
    // (was 4 different shapes before this pass). EroScripts and Settings
    // sit on their own; Devices/Web Remote/VR cluster as connection-
    // related controls. Cluster-gap markers are aria-hidden spacers.

    // EroScripts (margin-left: auto pushes the entire right side over)
    this._esBtn = document.createElement('button');
    this._esBtn.className = 'nav-bar__action nav-bar__eroscripts';
    this._esBtn.title = t('nav.eroscriptsTitle');
    this._esBtn.appendChild(icon(Download, { width: 14, height: 14 }));
    const esLabel = document.createElement('span');
    esLabel.className = 'nav-bar__action-label';
    esLabel.dataset.i18nKey = 'nav.eroscripts';
    esLabel.textContent = t('nav.eroscripts');
    this._esBtn.appendChild(esLabel);
    this._esBtn.addEventListener('click', () => {
      if (this._onEroScriptsClick) this._onEroScriptsClick();
    });
    this._el.appendChild(this._esBtn);

    // Kept so setHiddenItems can drop a gap whose cluster is hidden.
    this._gapAfterEroScripts = this._buildClusterGap();
    this._el.appendChild(this._gapAfterEroScripts);

    // The connections, one button group (Dave, 2026-11-25): Devices, Stop
    // all, Web Remote and VR, as the EroScripts tab's Paste / Downloads /
    // account group. Settings stays on its own at the far right.
    this._connGroup = document.createElement('div');
    this._connGroup.className = 'nav-bar__group';
    this._connGroup.setAttribute('role', 'group');
    this._connGroup.setAttribute('aria-label', t('nav.connectionsGroup'));
    this._el.appendChild(this._connGroup);

    // Device status pill: a dot and what is connected (deviceStatusSummary).
    // It was "Devices · 2 Connected", which read as two things. The LED is
    // aria-hidden; the text is aria-live so connects are announced.
    this._handyBtn = document.createElement('button');
    this._handyBtn.className = 'nav-bar__action nav-bar__handy';

    this._handyLed = document.createElement('span');
    this._handyLed.className = 'nav-bar__handy-led';
    this._handyLed.setAttribute('aria-hidden', 'true');

    this._handyText = document.createElement('span');
    this._handyText.className = 'nav-bar__handy-text';
    this._handyText.setAttribute('aria-live', 'polite');

    this._handyBtn.appendChild(this._handyLed);
    this._handyBtn.appendChild(this._handyText);

    this._handyBtn.addEventListener('click', () => {
      if (this._onHandyClick) this._onHandyClick();
    });

    this._connGroup.appendChild(this._handyBtn);

    // Stop all (DESIGN.md §1.6 S1, §2.15): beside the device status it acts
    // on, shown while a device is connected (setDeviceStatus). Icon-only: the
    // stop sign is universal, and its name is in the tooltip and aria-label.
    this._stopAllBtn = document.createElement('button');
    this._stopAllBtn.type = 'button';
    this._stopAllBtn.className = 'nav-bar__action nav-bar__stop-all';
    this._stopAllBtn.hidden = true;
    this._stopAllBtn.title = t('nav.stopAllTitle');
    this._stopAllBtn.setAttribute('aria-label', t('nav.stopAll'));
    this._stopAllBtn.appendChild(icon(CircleStop, { width: 18, height: 18 }));
    this._stopAllBtn.addEventListener('click', () => this._onStopAll?.());
    this._connGroup.appendChild(this._stopAllBtn);

    // Web Remote — opens the phone/tablet connection modal. Now
    // surfaces a connected-state tint when ≥1 phone is connected
    // (mirrors the VR pattern). State updated via setRemoteState().
    this._remoteBtn = document.createElement('button');
    this._remoteBtn.className = 'nav-bar__action nav-bar__remote-btn';
    this._remoteBtn.title = t('nav.webRemoteTitle');
    this._remoteBtn.setAttribute('aria-label', t('nav.webRemote'));
    this._remoteBtn.appendChild(icon(Smartphone, { width: 16, height: 16 }));
    const remoteLabel = document.createElement('span');
    remoteLabel.className = 'nav-bar__action-label';
    remoteLabel.dataset.i18nKey = 'nav.webRemote';
    remoteLabel.textContent = t('nav.webRemote');
    this._remoteBtn.appendChild(remoteLabel);
    this._remoteBtn.addEventListener('click', () => {
      if (this._onRemoteClick) this._onRemoteClick();
    });
    this._connGroup.appendChild(this._remoteBtn);

    // VR — opens VR server / PCVR companion modal. Tints accent when
    // the PCVR companion bridge is actively connected.
    this._vrBtn = document.createElement('button');
    this._vrBtn.className = 'nav-bar__action nav-bar__vr-btn';
    this._vrBtn.title = t('nav.vrTitle');
    this._vrBtn.setAttribute('aria-label', t('nav.vr'));
    this._vrBtn.appendChild(icon(Goggles, { width: 18, height: 18 }));
    const vrLabel = document.createElement('span');
    vrLabel.className = 'nav-bar__action-label';
    vrLabel.dataset.i18nKey = 'nav.vr';
    vrLabel.textContent = t('nav.vr');
    this._vrBtn.appendChild(vrLabel);
    this._vrBtn.addEventListener('click', () => {
      if (this._onVRClick) this._onVRClick();
    });
    this._connGroup.appendChild(this._vrBtn);

    this._gapBeforeSettings = this._buildClusterGap();
    this._el.appendChild(this._gapBeforeSettings);

    // Settings — app preferences. Rightmost convention (Slack, Discord,
    // GitHub, Notion all do this).
    this._settingsBtn = document.createElement('button');
    this._settingsBtn.className = 'nav-bar__action nav-bar__settings';
    this._settingsBtn.title = t('nav.settings');
    this._settingsBtn.setAttribute('aria-label', t('nav.settings'));
    this._settingsBtn.appendChild(icon(Settings, { width: 16, height: 16 }));
    const settingsLabel = document.createElement('span');
    settingsLabel.className = 'nav-bar__action-label';
    settingsLabel.dataset.i18nKey = 'nav.settings';
    settingsLabel.textContent = t('nav.settings');
    this._settingsBtn.appendChild(settingsLabel);
    this._settingsBtn.addEventListener('click', () => {
      if (this._onSettingsClick) this._onSettingsClick();
    });
    this._el.appendChild(this._settingsBtn);

    // The pill's first state, before app.js reports any device.
    this.setDeviceStatus();

    // Insert at the top of the parent
    parentEl.prepend(this._el);

    // Keep everything on one line at any width, zoom and language (CB-20):
    // refit whenever the bar's width changes. ResizeObserver delivers before
    // paint, so a frame with overlapping items is never shown.
    if (typeof ResizeObserver === 'function') {
      this._fitObserver = new ResizeObserver(() => this._fitToWidth());
      this._fitObserver.observe(this._el);
    }
    this._fitToWidth();

    // Re-translate when the user switches locale. Walks every label with
    // a stashed `data-i18n-key` so we don't re-construct the DOM tree
    // (preserves event listeners, dropdown state, etc.).
    if (eventBus?.on) {
      eventBus.on('language:changed', () => this._retranslate());
    }
  }

  /** Re-apply translations to existing label elements + dynamic tooltips
   *  whose values were baked at the last setter call (handy status text,
   *  Web Remote tooltip, VR tooltip). Static data-i18n-key labels handled
   *  by walking the DOM; dynamic ones replayed from their cached args. */
  _retranslate() {
    if (!this._el) return;
    for (const el of this._el.querySelectorAll('[data-i18n-key]')) {
      const key = el.dataset.i18nKey;
      if (key) el.textContent = t(key);
    }
    // The library label carries `nav.library`, but shows the active
    // collection's NAME when one is picked; the walk above just replaced
    // that name with "Library".
    if (this._libraryLabel && this._activeCollectionId) {
      const col = this._collections.find((c) => c.id === this._activeCollectionId);
      if (col) this._libraryLabel.textContent = col.name;
    }
    // Replay the last dynamic setter calls so their translated strings
    // refresh to the new locale. ALWAYS, falling back to the state init()
    // drew: these used to replay only after a setter had run, so with no
    // saved device and no remote/VR activity the device widget, the remote
    // tooltip and the VR tooltip kept the boot language (app test V50).
    this.setDeviceStatus(this._lastDeviceStatus || {});
    this._connGroup?.setAttribute('aria-label', t('nav.connectionsGroup'));
    const remote = this._lastRemoteState || { connected: false, count: 0 };
    this.setRemoteState(remote.connected, remote.count);
    const vr = this._lastVRTooltip || { status: 'disconnected', detail: {} };
    this.setVRTooltip(vr.status, vr.detail);
    // Titles and aria-labels set once in init() — re-apply every one.
    this._el.setAttribute('aria-label', t('nav.mainNavAria'));
    for (const btn of this._el.querySelectorAll('.nav-bar__item')) {
      const item = this._items.find((i) => i.id === btn.dataset.viewId);
      if (item) btn.title = t(item.labelKey);
    }
    const arrow = this._el.querySelector('.nav-bar__library-arrow');
    if (arrow) {
      arrow.title = t('nav.switchLibrary');
      arrow.setAttribute('aria-label', t('nav.switchLibrary'));
    }
    if (this._esBtn) this._esBtn.title = t('nav.eroscriptsTitle');
    // The Devices pill's title is its device list, replayed above by
    // setDeviceStatus; a fixed title here put "Device Connection" back over it.
    if (this._remoteBtn) this._remoteBtn.setAttribute('aria-label', t('nav.webRemote'));
    if (this._vrBtn) this._vrBtn.setAttribute('aria-label', t('nav.vr'));
    if (this._stopAllBtn) {
      this._stopAllBtn.title = t('nav.stopAllTitle');
      this._stopAllBtn.setAttribute('aria-label', t('nav.stopAll'));
    }
    if (this._settingsBtn) {
      this._settingsBtn.title = t('nav.settings');
      this._settingsBtn.setAttribute('aria-label', t('nav.settings'));
    }
    // Every label just changed length: "Web Remote" is "Web-Fernsteuerung".
    this._scheduleFit();
  }

  // --- Fitting the bar to its width (CB-20) -------------------------------
  //
  // Labels differ by language and the interface zooms to 150% in a window
  // that can be 800 px wide, so no fixed breakpoint keeps the bar on one
  // line: German at 125% on 1280 px (1024 CSS px) ran "Nicht verbunden" into
  // "Web-Fernsteuerung", English did the same at 800 px. The right-side
  // buttons have `min-width: 36px`, so flexbox shrank them below their text
  // and the text painted over the next button.
  //
  // Instead the bar measures itself and takes text off in steps until it
  // fits, each step a `nav-bar--fit-N` class (nav-bar.css), cumulative:
  //   1  Web Remote, VR and Settings labels (icon-only, as below 1024 px)
  //   2  the "Devices" word (the LED and the status text stay)
  //   3  the EroScripts label
  //   4  the Playlists and Categories labels
  //   5  the Library label (it can show the active collection's name)
  //   6  the device status text may shrink, with an ellipsis, and the
  //      spacing tightens (reached near the minimum window at 150%)
  // A hidden label is visually hidden, not removed, so every button keeps
  // its accessible name, and each keeps its tooltip. Measured with the
  // buttons not allowed to shrink (`nav-bar--measuring`): the bar overflows
  // when the last button (Settings, never hideable) ends past the content
  // edge. A bar that is not laid out (hidden, or jsdom) is left alone.

  /** Refit once, after the current batch of label changes. */
  _scheduleFit() {
    if (this._fitQueued) return;
    this._fitQueued = true;
    // A microtask runs before the next paint, so the change never shows unfitted.
    queueMicrotask(() => {
      this._fitQueued = false;
      this._fitToWidth();
    });
  }

  _fitToWidth() {
    const el = this._el;
    if (!el || el.hidden || !el.isConnected || !this._settingsBtn) return;
    if (!el.getBoundingClientRect().width) return;
    const setLevel = (n) => {
      for (let i = 1; i <= NAV_FIT_LEVELS; i++) el.classList.toggle(`nav-bar--fit-${i}`, i <= n);
    };
    el.classList.add('nav-bar--measuring');
    let level = 0;
    setLevel(0);
    while (level < NAV_FIT_LEVELS && this._overflows()) setLevel(++level);
    el.classList.remove('nav-bar--measuring');
    this._fitLevel = level;
  }

  /** True when the last button ends past the bar's content edge. */
  _overflows() {
    const el = this._el;
    const padRight = parseFloat(getComputedStyle(el).paddingRight) || 0;
    const limit = el.getBoundingClientRect().right - padRight;
    return this._settingsBtn.getBoundingClientRect().right > limit + 0.5;
  }

  /**
   * Hide the nav-bar buttons the user switched off (`player.navHidden`,
   * zaikechi #381). Only `=== true` hides, so a missing map shows everything,
   * as before. Buttons are hidden with the `hidden` attribute and never
   * removed: app.js keeps references into them (it flashes `_handyLed` on
   * every device command), and a hidden Devices button leaves the H key and
   * the status updates working.
   *
   * A cluster gap is dropped when it would no longer sit between two visible
   * buttons, so hiding a whole cluster does not leave a double gap or a stray
   * one at the edge. And the right side is pushed over by a margin on
   * EroScripts (nav-bar.css), so with EroScripts hidden the first visible
   * right-side button takes the push instead.
   */
  setHiddenItems(hidden = {}) {
    if (!this._el) return;
    const map = (hidden && typeof hidden === 'object') ? hidden : {};
    const els = this._hideableEls();
    for (const { key } of NAV_HIDEABLE_ITEMS) {
      if (els[key]) els[key].hidden = map[key] === true;
    }
    this._layoutRightSide();
    // Fewer buttons may leave room for labels again, more need less.
    this._scheduleFit();
  }

  /** The element behind each NAV_HIDEABLE_ITEMS key. */
  _hideableEls() {
    const item = (id) => this._el?.querySelector(`.nav-bar__item[data-view-id="${id}"]`) || null;
    return {
      playlists: item('playlists'),
      categories: item('categories'),
      eroscripts: this._esBtn || null,
      devices: this._handyBtn || null,
      remote: this._remoteBtn || null,
      vr: this._vrBtn || null,
    };
  }

  /** Collapse cluster gaps around hidden buttons; move the right-side push. */
  _layoutRightSide() {
    // The connections group shows while any button in it does: with Devices,
    // Web Remote and VR all switched off (and nothing for Stop all to stop)
    // it would be an empty bordered box.
    if (this._connGroup) {
      this._connGroup.hidden = ![...this._connGroup.children].some((b) => !b.hidden);
    }
    const seq = [this._esBtn, this._gapAfterEroScripts, this._connGroup,
      this._gapBeforeSettings, this._settingsBtn].filter(Boolean);
    // A gap shows only with a visible button before it (since the last gap
    // that showed) AND one after it.
    let pending = null;
    let seen = false;
    for (const el of seq) {
      if (el.classList.contains('nav-bar__cluster-gap')) {
        el.hidden = true;
        if (seen) { pending = el; seen = false; }
      } else if (!el.hidden) {
        if (pending) { pending.hidden = false; pending = null; }
        seen = true;
      }
    }
    // Gaps can never be the first visible thing, so the first visible button
    // is the leftmost right-side element.
    const first = seq.find((el) => !el.hidden && !el.classList.contains('nav-bar__cluster-gap'));
    for (const el of seq) {
      el.classList.toggle('nav-bar__action--push', el === first && el !== this._esBtn);
    }
  }

  setActive(viewId) {
    this._activeId = viewId;
    if (!this._el) return;
    for (const btn of this._el.querySelectorAll('.nav-bar__item')) {
      btn.classList.toggle('nav-bar__item--active', btn.dataset.viewId === viewId);
    }
    // The EroScripts button opens a view too since 2026-11-22: marked while
    // open, with the views' underline since 2026-11-25 (it turned coral
    // instead, a second way of saying "you are here").
    if (this._esBtn) {
      this._esBtn.classList.toggle('nav-bar__eroscripts--active', viewId === 'eroscripts');
      if (viewId === 'eroscripts') this._esBtn.setAttribute('aria-current', 'page');
      else this._esBtn.removeAttribute('aria-current');
    }
  }

  /** Cluster-gap separator — purely visual spacing between conceptual
   *  groups in the nav bar. Same name + behaviour as the player
   *  bottom-bar `.controls-cluster-gap` (Norman conceptual model). */
  _buildClusterGap() {
    const gap = document.createElement('span');
    gap.className = 'nav-bar__cluster-gap';
    gap.setAttribute('aria-hidden', 'true');
    return gap;
  }

  /**
   * Toggle the Web Remote button's connected-state tint. Mirrors the
   * VR pattern (`setVRConnected`) so the user sees state without
   * opening the modal — Nielsen #1 visibility of system status.
   * @param {boolean} connected — at least one phone connected
   * @param {number} [count] — for tooltip ("2 phones connected")
   */
  setRemoteState(connected, count = 0) {
    if (!this._remoteBtn) return;
    // Stash for re-translation on language:changed — the tooltip text
    // is built with t() at call time, so without remembering the inputs
    // a locale switch leaves stale strings on the button.
    this._lastRemoteState = { connected, count };
    this._remoteBtn.classList.toggle('nav-bar__remote-btn--connected', !!connected);
    if (connected) {
      this._remoteBtn.title = count > 1
        ? t('nav.webRemotePhonesConnected', { count })
        : t('nav.webRemotePhoneConnected');
    } else {
      this._remoteBtn.title = t('nav.webRemoteTitle');
    }
  }

  /**
   * Toggle the VR toolbar button's connected-state tint. Matches the
   * Web Remote button's pattern — visible signal without opening the
   * modal. Boolean-arg form is back-compat; for the silent-failure
   * "waiting" tint use `setVRLinkState('waiting')` instead.
   */
  setVRConnected(connected) {
    this.setVRLinkState(connected ? 'connected' : 'disconnected');
  }

  /**
   * Three-state VR link tint:
   *   'connected' (receiving)  → accent-soft (green-ish, Norman feedback "good")
   *   'waiting'               → warning-soft (yellow, "TCP open but no packets — fix HereSphere")
   *   'disconnected'          → neutral (no tint)
   * Mirrors `vrBridge.linkState`. Driven by app.js::_updateVRTooltip's
   * 2s poll so the tint flips when the bridge silently stops receiving.
   */
  setVRLinkState(state) {
    if (!this._vrBtn) return;
    this._vrBtn.classList.toggle('nav-bar__vr-btn--connected', state === 'connected');
    this._vrBtn.classList.toggle('nav-bar__vr-btn--waiting', state === 'waiting');
  }

  /**
   * Update the nav-bar VR button's tooltip to reflect bridge link state.
   * Three-state model (matches `vrBridge.linkState`): connected (TCP +
   * packets flowing), waiting (TCP open but no packets — silent-failure
   * mode), disconnected. The legacy 'reconnecting' / 'connecting' values
   * still resolve to the disconnected tooltip for backwards compat.
   * @param {'connected'|'waiting'|'disconnected'|'connecting'|'reconnecting'} status
   * @param {object} [detail]
   * @param {string} [detail.host] — remote host, for connected/waiting states
   */
  setVRTooltip(status, detail = {}) {
    if (!this._vrBtn) return;
    this._lastVRTooltip = { status, detail };
    let title;
    if (status === 'connected') {
      title = detail.host ? t('nav.vrConnectedTo', { host: detail.host }) : t('nav.vrConnected');
    } else if (status === 'waiting') {
      title = detail.host
        ? t('nav.vrWaitingHost', { host: detail.host })
        : t('nav.vrWaiting');
    } else if (status === 'connecting') {
      title = t('nav.vrConnecting');
    } else {
      title = t('nav.vrTitle');
    }
    this._vrBtn.title = title;
  }

  /**
   * Paint the Devices pill (deviceStatusSummary). app.js calls this on every
   * device event with every connected device; `connecting` while the Handy
   * is connecting.
   * @param {{devices?: {label: string, state?: string}[], connecting?: boolean}} [opts]
   */
  setDeviceStatus({ devices = [], connecting = false } = {}) {
    if (!this._handyLed || !this._handyText) return;
    this._lastDeviceStatus = { devices, connecting };
    const shownBefore = this._handyText.textContent;
    const sum = deviceStatusSummary(devices, { connecting });
    this._handyLed.className = 'nav-bar__handy-led';
    const led = LED_FOR_STATUS[sum.status];
    if (led) this._handyLed.classList.add(`nav-bar__handy-led--${led}`);
    this._handyText.textContent = sum.text;
    this._handyBtn.title = sum.title;
    this._handyBtn.setAttribute('aria-label', sum.aria);
    this._handyBtn.dataset.status = sum.status;
    // Stop all (DESIGN.md §1.6 S1) shows while anything is connected,
    // a device that is not responding included.
    if (this._stopAllBtn) {
      const hide = sum.count === 0;
      if (this._stopAllBtn.hidden !== hide) {
        this._stopAllBtn.hidden = hide;
        this._layoutRightSide();
        this._scheduleFit();
      }
    }
    // "No devices" and "Lovense Edge not responding" differ in width (CB-20).
    // Only when the text changed: app.js calls this on every device event.
    if (this._handyText.textContent !== shownBefore) this._scheduleFit();
  }

  setCollections(collections, activeCollectionId, sources, unavailablePaths, unavailableCollectionIds) {
    this._collections = collections || [];
    this._activeCollectionId = activeCollectionId;
    this._sources = sources || [];
    this._unavailableCollectionIds = unavailableCollectionIds || new Set();

    if (this._libraryLabel) {
      if (activeCollectionId) {
        const col = this._collections.find(c => c.id === activeCollectionId);
        this._libraryLabel.textContent = col ? col.name : t('nav.library');
      } else {
        this._libraryLabel.textContent = t('nav.library');
      }
      // A collection's name can be longer than "Library" (CB-20).
      this._scheduleFit();
    }
  }

  _toggleLibraryDropdown({ fromKeyboard = false } = {}) {
    if (!this._libraryDropdown) return;
    const arrow = this._el?.querySelector('.nav-bar__library-arrow');
    if (!this._libraryDropdown.hidden) {
      this._closeLibraryDropdown();
      return;
    }
    this._renderLibraryDropdown();
    this._libraryDropdown.hidden = false;
    arrow?.setAttribute('aria-expanded', 'true');

    // Close on outside click (clean up previous listener)
    if (this._libraryDropdownClose) {
      document.removeEventListener('pointerdown', this._libraryDropdownClose, true);
    }
    this._libraryDropdownClose = (e) => {
      const arrow = this._el?.querySelector('.nav-bar__library-arrow');
      if (this._libraryDropdown.contains(e.target) || (arrow && arrow.contains(e.target))) return;
      this._closeLibraryDropdown();
    };
    // Reads the field when it fires: a close in the meantime nulls it, and
    // addEventListener(null) is a no-op, so no stale listener is armed.
    setTimeout(() => document.addEventListener('pointerdown', this._libraryDropdownClose, true), 0);

    // Escape closes it and gives the focus back to the arrow (the
    // menu-button pattern). It did nothing (test day 2026-11-24, B022). The
    // key goes no further: the app's own Escape must not also fire.
    if (this._libraryDropdownKey) document.removeEventListener('keydown', this._libraryDropdownKey, true);
    this._libraryDropdownKey = (e) => {
      // Down / Up / Home / End move through its items (the menu pattern,
      // menu-keys.js): it said aria-haspopup="menu", but only Tab moved
      // (test day 2026-11-26, S023).
      if (!this._libraryDropdown.hidden && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        && this._libraryDropdown.contains(document.activeElement)
        && moveMenuFocus(this._libraryDropdown, e.key)) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Escape' || this._libraryDropdown.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      this._closeLibraryDropdown();
      const a = this._el?.querySelector('.nav-bar__library-arrow');
      if (a?.isConnected) { try { a.focus({ preventScroll: true }); } catch { /* not focusable */ } }
    };
    document.addEventListener('keydown', this._libraryDropdownKey, true);
    // Opened from the keyboard: the library shown now takes the focus.
    if (fromKeyboard) focusMenuFromKeyboard(this._libraryDropdown, '.nav-bar__library-option--active');
  }

  /**
   * The ONE way the library dropdown closes. Hides the menu, resets the
   * arrow's aria-expanded (which is also what un-rotates the chevron,
   * nav-bar.css) and drops the outside-click listener.
   *
   * Every item handler used to do a bare `dd.hidden = true`, so picking an
   * item left the arrow announcing "expanded" with the chevron rotated (app
   * test V53). A mouse pick did too — its pointerdown lands inside the
   * dropdown, which the outside-click closer ignores — and only the next
   * click elsewhere healed it. Keyboard picks never healed.
   */
  _closeLibraryDropdown() {
    const arrow = this._el?.querySelector('.nav-bar__library-arrow');
    // The focus inside the menu (an item was chosen) goes back to the arrow
    // that opened it, so a dialog the item opens (Delete collection, Rename,
    // New collection) gives it back there, not to <body> (block C verifier
    // 1; also in v0.9.2).
    const returnFocus = !!this._libraryDropdown && !this._libraryDropdown.hidden
      && this._libraryDropdown.contains(document.activeElement);
    if (this._libraryDropdown) this._libraryDropdown.hidden = true;
    arrow?.setAttribute('aria-expanded', 'false');
    if (returnFocus && arrow?.isConnected) {
      try { arrow.focus({ preventScroll: true }); } catch { /* not focusable */ }
    }
    if (this._libraryDropdownClose) {
      document.removeEventListener('pointerdown', this._libraryDropdownClose, true);
      this._libraryDropdownClose = null;
    }
    if (this._libraryDropdownKey) {
      document.removeEventListener('keydown', this._libraryDropdownKey, true);
      this._libraryDropdownKey = null;
    }
  }

  _renderLibraryDropdown() {
    const dd = this._libraryDropdown;
    dd.innerHTML = '';

    const isAllActive = !this._activeCollectionId;

    // "All Videos" option
    const allBtn = document.createElement('button');
    allBtn.className = 'nav-bar__library-option';
    if (isAllActive) allBtn.classList.add('nav-bar__library-option--active');
    allBtn.textContent = t('nav.allVideos');
    allBtn.addEventListener('click', () => {
      this._closeLibraryDropdown();
      if (this._onLibraryCollectionChange) this._onLibraryCollectionChange(null);
    });
    dd.appendChild(allBtn);

    // Collections
    if (this._collections.length > 0) {
      for (const col of this._collections) {
        const isUnavailable = this._unavailableCollectionIds.has(col.id);
        const row = document.createElement('div');
        row.className = 'nav-bar__library-row';
        if (isUnavailable) row.classList.add('nav-bar__library-row--unavailable');

        const btn = document.createElement('button');
        btn.className = 'nav-bar__library-option';
        if (isUnavailable) btn.classList.add('nav-bar__library-option--unavailable');
        if (col.id === this._activeCollectionId) btn.classList.add('nav-bar__library-option--active');

        const nameSpan = document.createElement('span');
        nameSpan.textContent = col.name;
        btn.appendChild(nameSpan);

        // Synced collections get a small ↻ badge so users can see at a
        // glance which libraries auto-update when files are added. The
        // badge has a tooltip describing the sync target.
        if (col.syncSource?.sourceId || col.syncSource?.folderPath) {
          const syncBadge = document.createElement('span');
          syncBadge.className = 'nav-bar__library-sync-badge';
          syncBadge.textContent = '↻';
          syncBadge.title = col.syncSource.folderPath
            ? t('nav.syncedWithFolder', { path: col.syncSource.folderPath })
            : t('nav.syncedWithSource');
          btn.appendChild(syncBadge);
        }

        if (isUnavailable) {
          const unplugIcon = icon(Unplug, { width: 12, height: 12 });
          unplugIcon.classList.add('nav-bar__library-unplug');
          btn.appendChild(unplugIcon);
          btn.title = t('nav.sourceDisconnected');
          btn.disabled = true;
        } else {
          btn.addEventListener('click', () => {
            this._closeLibraryDropdown();
            if (this._onLibraryCollectionChange) this._onLibraryCollectionChange(col.id);
          });
        }

        const actions = document.createElement('div');
        actions.className = 'nav-bar__library-actions';

        if (!isUnavailable) {
          const renameBtn = document.createElement('button');
          renameBtn.className = 'nav-bar__library-action';
          renameBtn.textContent = '✎';
          renameBtn.title = t('nav.edit');
          renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this._closeLibraryDropdown(); if (this._onRenameCollection) this._onRenameCollection(col.id); });
          actions.appendChild(renameBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'nav-bar__library-action nav-bar__library-action--danger';
        deleteBtn.textContent = '✕';
        deleteBtn.title = t('common.delete');
        deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); this._closeLibraryDropdown(); if (this._onDeleteCollection) this._onDeleteCollection(col.id); });
        actions.appendChild(deleteBtn);
        row.appendChild(btn);
        row.appendChild(actions);
        dd.appendChild(row);
      }
    }

    // Divider + action buttons
    const divider = document.createElement('div');
    divider.className = 'nav-bar__library-divider';
    dd.appendChild(divider);

    // Load from URL (Dave, 2026-11-26: "since we have drag and drop
    // functionality anyway, i think load from url should be an option under
    // libary instead of on the navbar"). It was a nav-bar button since
    // 2026-11-22; the player's top bar keeps its own. Resolves a streaming
    // site's page link (yt-dlp) and plays it with a funscript
    // (SCOPE-remote-video-url.md).
    if (this._onLoadUrlClick) {
      const urlBtn = document.createElement('button');
      urlBtn.className = 'nav-bar__library-option nav-bar__library-option--url';
      urlBtn.textContent = t('remoteVideo.title');
      urlBtn.addEventListener('click', () => { this._closeLibraryDropdown(); this._onLoadUrlClick(); });
      dd.appendChild(urlBtn);
    }
    // "Scripts without a video" was here (v0.10.1) until Filters > Scripts
    // replaced it (Dave, 2026-11-26: "we can probably get rid of the scripts
    // without a video menu item under libary now").
    // Disabled videos, to review, enable or delete (zaikechi #381).
    if (this._onDisabledVideos) {
      const offBtn = document.createElement('button');
      offBtn.className = 'nav-bar__library-option nav-bar__library-option--disabled';
      offBtn.textContent = t('library.disabled.navItem');
      offBtn.addEventListener('click', () => { this._closeLibraryDropdown(); this._onDisabledVideos(); });
      dd.appendChild(offBtn);
    }

    const addSourceBtn = document.createElement('button');
    addSourceBtn.className = 'nav-bar__library-option nav-bar__library-option--new';
    addSourceBtn.textContent = t('nav.addSourceFolder');
    addSourceBtn.addEventListener('click', () => { this._closeLibraryDropdown(); if (this._onAddSource) this._onAddSource(); });
    dd.appendChild(addSourceBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'nav-bar__library-option nav-bar__library-option--new';
    newBtn.textContent = t('nav.newCollection');
    newBtn.addEventListener('click', () => {
      this._closeLibraryDropdown();
      if (this._onNewCollection) this._onNewCollection();
    });
    dd.appendChild(newBtn);

    // A menu of menu items (the arrows move through these; a collection's
    // rename / delete buttons stay Tab stops beside them).
    dd.setAttribute('role', 'menu');
    for (const b of dd.querySelectorAll('.nav-bar__library-option')) b.setAttribute('role', 'menuitem');
  }

  setEroScriptsStatus(loggedIn) {
    if (this._esBtn) {
      this._esBtn.classList.toggle('nav-bar__eroscripts--connected', loggedIn);
    }
  }

  /**
   * New threads across the EroScripts feeds (2026-11-22): a small count on the
   * button, gone at 0. Its words go in the title for a screen reader.
   */
  setEroScriptsBadge(count, label = '') {
    if (!this._esBtn) return;
    let badge = this._esBtn.querySelector('.nav-bar__badge');
    const n = Number(count) || 0;
    if (!n) { badge?.remove(); this._esBtn.title = t('nav.eroscriptsTitle'); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-bar__badge';
      this._esBtn.appendChild(badge);
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    this._esBtn.title = label ? `${t('nav.eroscriptsTitle')} · ${label}` : t('nav.eroscriptsTitle');
  }

  show() {
    if (this._el) this._el.hidden = false;
  }

  hide() {
    if (this._el) this._el.hidden = true;
  }
}
