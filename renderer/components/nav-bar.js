// NavBar — Persistent top navigation bar

import { icon, Library, ListVideo, Tag, Download, Unplug, Settings, Smartphone, Goggles, ChevronDown } from '../js/icons.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';

export class NavBar {
  constructor({ onNavigate, onHandyClick, onSettingsClick, onRemoteClick, onVRClick, onEroScriptsClick, onLibraryCollectionChange, onNewCollection, onRenameCollection, onDeleteCollection, onAddSource }) {
    this._onNavigate = onNavigate;
    this._onHandyClick = onHandyClick;
    this._onSettingsClick = onSettingsClick;
    this._onRemoteClick = onRemoteClick;
    this._onVRClick = onVRClick;
    this._onEroScriptsClick = onEroScriptsClick;
    this._onLibraryCollectionChange = onLibraryCollectionChange;
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
          this._toggleLibraryDropdown();
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

    this._el.appendChild(this._buildClusterGap());

    // Device status widget — LED dot + "Devices" label + status text.
    // LED is aria-hidden; status text gets aria-live so screen readers
    // announce connect/disconnect transitions without re-focusing.
    this._handyBtn = document.createElement('button');
    this._handyBtn.className = 'nav-bar__action nav-bar__handy';
    this._handyBtn.title = t('nav.deviceConnection');
    this._handyBtn.setAttribute('aria-label', t('nav.devicesAria', { status: t('nav.notConnected') }));

    this._handyLed = document.createElement('span');
    this._handyLed.className = 'nav-bar__handy-led';
    this._handyLed.setAttribute('aria-hidden', 'true');

    this._handyLabel = document.createElement('span');
    this._handyLabel.className = 'nav-bar__handy-label nav-bar__action-label';
    this._handyLabel.textContent = t('nav.devices');

    this._handyText = document.createElement('span');
    this._handyText.className = 'nav-bar__handy-text';
    // Default state is "Not connected" (neutral) — was "Disconnected"
    // which read as a failure even on first launch. Reserve
    // "Disconnected" for actual drop-out (see setHandyStatus).
    this._handyText.textContent = t('nav.notConnected');
    this._handyText.setAttribute('aria-live', 'polite');

    this._handyBtn.appendChild(this._handyLed);
    this._handyBtn.appendChild(this._handyLabel);
    this._handyBtn.appendChild(this._handyText);

    this._handyBtn.addEventListener('click', () => {
      if (this._onHandyClick) this._onHandyClick();
    });

    this._el.appendChild(this._handyBtn);

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
    this._el.appendChild(this._remoteBtn);

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
    this._el.appendChild(this._vrBtn);

    this._el.appendChild(this._buildClusterGap());

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

    // Insert at the top of the parent
    parentEl.prepend(this._el);

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
    // Replay the last dynamic setter calls so their translated strings
    // refresh to the new locale.
    if (this._lastHandyStatus) {
      this.setHandyStatus(this._lastHandyStatus.status, this._lastHandyStatus.deviceCount);
    }
    if (this._lastRemoteState) {
      this.setRemoteState(this._lastRemoteState.connected, this._lastRemoteState.count);
    }
    if (this._lastVRTooltip) {
      this.setVRTooltip(this._lastVRTooltip.status, this._lastVRTooltip.detail);
    }
    // Static button titles set once in init() — re-apply now too.
    if (this._libraryBtn) this._libraryBtn.title = t('nav.library');
    if (this._esBtn) this._esBtn.title = t('nav.eroscriptsTitle');
    if (this._handyBtn && !this._lastHandyStatus) {
      this._handyBtn.title = t('nav.deviceConnection');
    }
    if (this._settingsBtn) {
      this._settingsBtn.title = t('nav.settings');
      this._settingsBtn.setAttribute('aria-label', t('nav.settings'));
    }
  }

  setActive(viewId) {
    this._activeId = viewId;
    if (!this._el) return;
    for (const btn of this._el.querySelectorAll('.nav-bar__item')) {
      btn.classList.toggle('nav-bar__item--active', btn.dataset.viewId === viewId);
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

  setHandyStatus(status, deviceCount = 0) {
    if (!this._handyLed || !this._handyText) return;
    this._lastHandyStatus = { status, deviceCount };
    this._handyLed.className = 'nav-bar__handy-led';

    if (this._handyLabel) {
      this._handyLabel.textContent = deviceCount === 1 ? t('nav.device') : t('nav.devices');
    }

    // "Not connected" is the neutral default — no failure framing
    // implied. "Disconnected" was the prior wording but read as
    // "something went wrong" even on first launch when nothing had
    // ever been connected (Nielsen #2 match real world). The status
    // strings here are user-facing.
    let textValue = t('nav.notConnected');
    switch (status) {
      case 'connected':
        this._handyLed.classList.add('nav-bar__handy-led--connected');
        textValue = deviceCount > 0 ? t('nav.deviceCount', { count: deviceCount }) : t('nav.connected');
        break;
      case 'connecting':
        this._handyLed.classList.add('nav-bar__handy-led--connecting');
        textValue = t('nav.connecting');
        break;
      case 'disconnected':
      default:
        textValue = t('nav.notConnected');
        break;
    }
    this._handyText.textContent = textValue;
    // Refresh button-level aria-label so the announcement reads
    // "Devices: 2 Connected" or similar (Norman signifier — text is
    // canonical, colour is secondary).
    if (this._handyBtn) {
      this._handyBtn.setAttribute('aria-label', t('nav.devicesAria', { status: textValue }));
    }
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
    }
  }

  _toggleLibraryDropdown() {
    if (!this._libraryDropdown) return;
    const arrow = this._el?.querySelector('.nav-bar__library-arrow');
    if (!this._libraryDropdown.hidden) {
      this._libraryDropdown.hidden = true;
      arrow?.setAttribute('aria-expanded', 'false');
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
      this._libraryDropdown.hidden = true;
      arrow?.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', this._libraryDropdownClose, true);
      this._libraryDropdownClose = null;
    };
    setTimeout(() => document.addEventListener('pointerdown', this._libraryDropdownClose, true), 0);
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
      dd.hidden = true;
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
            dd.hidden = true;
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
          renameBtn.addEventListener('click', (e) => { e.stopPropagation(); dd.hidden = true; if (this._onRenameCollection) this._onRenameCollection(col.id); });
          actions.appendChild(renameBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'nav-bar__library-action nav-bar__library-action--danger';
        deleteBtn.textContent = '✕';
        deleteBtn.title = t('common.delete');
        deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); dd.hidden = true; if (this._onDeleteCollection) this._onDeleteCollection(col.id); });
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

    const addSourceBtn = document.createElement('button');
    addSourceBtn.className = 'nav-bar__library-option nav-bar__library-option--new';
    addSourceBtn.textContent = t('nav.addSourceFolder');
    addSourceBtn.addEventListener('click', () => { dd.hidden = true; if (this._onAddSource) this._onAddSource(); });
    dd.appendChild(addSourceBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'nav-bar__library-option nav-bar__library-option--new';
    newBtn.textContent = t('nav.newCollection');
    newBtn.addEventListener('click', () => {
      dd.hidden = true;
      if (this._onNewCollection) this._onNewCollection();
    });
    dd.appendChild(newBtn);
  }

  setEroScriptsStatus(loggedIn) {
    if (this._esBtn) {
      this._esBtn.classList.toggle('nav-bar__eroscripts--connected', loggedIn);
    }
  }

  show() {
    if (this._el) this._el.hidden = false;
  }

  hide() {
    if (this._el) this._el.hidden = true;
  }
}
