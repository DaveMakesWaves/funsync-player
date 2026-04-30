// NavBar — Persistent top navigation bar

import { icon, Library, ListVideo, Tag, Download, Unplug, Settings, Smartphone, Goggles, ChevronDown } from '../js/icons.js';

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
    this._items = [
      { id: 'library', label: 'Library', iconNode: Library },
      { id: 'playlists', label: 'Playlists', iconNode: ListVideo },
      { id: 'categories', label: 'Categories', iconNode: Tag },
    ];
  }

  init(parentEl) {
    this._el = document.createElement('nav');
    this._el.className = 'nav-bar';
    this._el.setAttribute('role', 'navigation');
    this._el.setAttribute('aria-label', 'Main navigation');

    for (const item of this._items) {
      if (item.id === 'library') {
        // Library gets a dropdown for collections
        const wrapper = document.createElement('div');
        wrapper.className = 'nav-bar__library-wrapper';

        const btn = document.createElement('button');
        btn.className = 'nav-bar__item';
        btn.dataset.viewId = 'library';
        btn.title = 'Library';

        const iconEl = document.createElement('span');
        iconEl.className = 'nav-bar__icon';
        iconEl.appendChild(icon(item.iconNode, { width: 16, height: 16 }));

        this._libraryLabel = document.createElement('span');
        this._libraryLabel.className = 'nav-bar__label';
        this._libraryLabel.textContent = 'Library';

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
        arrow.title = 'Switch library';
        arrow.setAttribute('aria-label', 'Switch library');
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
        btn.title = item.label;

        const iconEl = document.createElement('span');
        iconEl.className = 'nav-bar__icon';
        iconEl.appendChild(icon(item.iconNode, { width: 16, height: 16 }));

        const label = document.createElement('span');
        label.className = 'nav-bar__label';
        label.textContent = item.label;

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
    this._esBtn.title = 'Search EroScripts';
    this._esBtn.appendChild(icon(Download, { width: 14, height: 14 }));
    const esLabel = document.createElement('span');
    esLabel.className = 'nav-bar__action-label';
    esLabel.textContent = 'EroScripts';
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
    this._handyBtn.title = 'Device Connection';
    this._handyBtn.setAttribute('aria-label', 'Devices: Not connected');

    this._handyLed = document.createElement('span');
    this._handyLed.className = 'nav-bar__handy-led';
    this._handyLed.setAttribute('aria-hidden', 'true');

    this._handyLabel = document.createElement('span');
    this._handyLabel.className = 'nav-bar__handy-label nav-bar__action-label';
    this._handyLabel.textContent = 'Devices';

    this._handyText = document.createElement('span');
    this._handyText.className = 'nav-bar__handy-text';
    // Default state is "Not connected" (neutral) — was "Disconnected"
    // which read as a failure even on first launch. Reserve
    // "Disconnected" for actual drop-out (see setHandyStatus).
    this._handyText.textContent = 'Not connected';
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
    this._remoteBtn.title = 'Web Remote — open on phone';
    this._remoteBtn.setAttribute('aria-label', 'Web Remote');
    this._remoteBtn.appendChild(icon(Smartphone, { width: 16, height: 16 }));
    const remoteLabel = document.createElement('span');
    remoteLabel.className = 'nav-bar__action-label';
    remoteLabel.textContent = 'Web Remote';
    this._remoteBtn.appendChild(remoteLabel);
    this._remoteBtn.addEventListener('click', () => {
      if (this._onRemoteClick) this._onRemoteClick();
    });
    this._el.appendChild(this._remoteBtn);

    // VR — opens VR server / PCVR companion modal. Tints accent when
    // the PCVR companion bridge is actively connected.
    this._vrBtn = document.createElement('button');
    this._vrBtn.className = 'nav-bar__action nav-bar__vr-btn';
    this._vrBtn.title = 'VR — Quest server + PCVR companion';
    this._vrBtn.setAttribute('aria-label', 'VR');
    this._vrBtn.appendChild(icon(Goggles, { width: 18, height: 18 }));
    const vrLabel = document.createElement('span');
    vrLabel.className = 'nav-bar__action-label';
    vrLabel.textContent = 'VR';
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
    this._settingsBtn.title = 'Settings';
    this._settingsBtn.setAttribute('aria-label', 'Settings');
    this._settingsBtn.appendChild(icon(Settings, { width: 16, height: 16 }));
    const settingsLabel = document.createElement('span');
    settingsLabel.className = 'nav-bar__action-label';
    settingsLabel.textContent = 'Settings';
    this._settingsBtn.appendChild(settingsLabel);
    this._settingsBtn.addEventListener('click', () => {
      if (this._onSettingsClick) this._onSettingsClick();
    });
    this._el.appendChild(this._settingsBtn);

    // Insert at the top of the parent
    parentEl.prepend(this._el);
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
    this._remoteBtn.classList.toggle('nav-bar__remote-btn--connected', !!connected);
    if (connected) {
      this._remoteBtn.title = count > 1
        ? `Web Remote — ${count} phones connected`
        : 'Web Remote — phone connected';
    } else {
      this._remoteBtn.title = 'Web Remote — open on phone';
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
    let title;
    if (status === 'connected') {
      title = detail.host ? `VR — connected to ${detail.host}` : 'VR — connected';
    } else if (status === 'waiting') {
      title = detail.host
        ? `VR — connected to ${detail.host}, waiting for HereSphere to send timestamps. Make sure 'Timestamp Server' is on.`
        : "VR — waiting for HereSphere to send timestamps. Make sure 'Timestamp Server' is on.";
    } else if (status === 'connecting') {
      title = 'VR — connecting...';
    } else {
      title = 'VR — Quest server + PCVR companion';
    }
    this._vrBtn.title = title;
  }

  setHandyStatus(status, deviceCount = 0) {
    if (!this._handyLed || !this._handyText) return;
    this._handyLed.className = 'nav-bar__handy-led';

    if (this._handyLabel) {
      this._handyLabel.textContent = deviceCount === 1 ? 'Device' : 'Devices';
    }

    // "Not connected" is the neutral default — no failure framing
    // implied. "Disconnected" was the prior wording but read as
    // "something went wrong" even on first launch when nothing had
    // ever been connected (Nielsen #2 match real world). The status
    // strings here are user-facing.
    let textValue = 'Not connected';
    switch (status) {
      case 'connected':
        this._handyLed.classList.add('nav-bar__handy-led--connected');
        textValue = deviceCount > 0 ? `${deviceCount} Connected` : 'Connected';
        break;
      case 'connecting':
        this._handyLed.classList.add('nav-bar__handy-led--connecting');
        textValue = 'Connecting...';
        break;
      case 'disconnected':
      default:
        textValue = 'Not connected';
        break;
    }
    this._handyText.textContent = textValue;
    // Refresh button-level aria-label so the announcement reads
    // "Devices: 2 Connected" or similar (Norman signifier — text is
    // canonical, colour is secondary).
    if (this._handyBtn) {
      this._handyBtn.setAttribute('aria-label', `Devices: ${textValue}`);
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
        this._libraryLabel.textContent = col ? col.name : 'Library';
      } else {
        this._libraryLabel.textContent = 'Library';
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
    allBtn.textContent = 'All Videos';
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
            ? `Synced with folder: ${col.syncSource.folderPath}`
            : 'Synced with source';
          btn.appendChild(syncBadge);
        }

        if (isUnavailable) {
          const unplugIcon = icon(Unplug, { width: 12, height: 12 });
          unplugIcon.classList.add('nav-bar__library-unplug');
          btn.appendChild(unplugIcon);
          btn.title = 'Source disconnected';
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
          renameBtn.title = 'Edit';
          renameBtn.addEventListener('click', (e) => { e.stopPropagation(); dd.hidden = true; if (this._onRenameCollection) this._onRenameCollection(col.id); });
          actions.appendChild(renameBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'nav-bar__library-action nav-bar__library-action--danger';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Delete';
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
    addSourceBtn.textContent = '+ Add Source Folder...';
    addSourceBtn.addEventListener('click', () => { dd.hidden = true; if (this._onAddSource) this._onAddSource(); });
    dd.appendChild(addSourceBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'nav-bar__library-option nav-bar__library-option--new';
    newBtn.textContent = '+ New Collection...';
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
