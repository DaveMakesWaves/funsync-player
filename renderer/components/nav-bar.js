// NavBar — Persistent top navigation bar

import { icon, Library, ListVideo, Tag, Download, Unplug } from '../js/icons.js';

export class NavBar {
  constructor({ onNavigate, onHandyClick, onEroScriptsClick, onLibraryCollectionChange, onNewCollection, onRenameCollection, onDeleteCollection, onAddSource }) {
    this._onNavigate = onNavigate;
    this._onHandyClick = onHandyClick;
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

        const arrow = document.createElement('button');
        arrow.className = 'nav-bar__library-arrow';
        arrow.textContent = '▾';
        arrow.title = 'Switch library';
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

    // EroScripts button (right-aligned, before device button)
    this._esBtn = document.createElement('button');
    this._esBtn.className = 'nav-bar__eroscripts';
    this._esBtn.title = 'Search EroScripts';
    this._esBtn.appendChild(icon(Download, { width: 14, height: 14 }));
    const esLabel = document.createElement('span');
    esLabel.textContent = 'EroScripts';
    this._esBtn.appendChild(esLabel);
    this._esBtn.addEventListener('click', () => {
      if (this._onEroScriptsClick) this._onEroScriptsClick();
    });
    this._el.appendChild(this._esBtn);

    // Device status widget (right-aligned)
    this._handyBtn = document.createElement('button');
    this._handyBtn.className = 'nav-bar__handy';
    this._handyBtn.title = 'Device Connection';

    this._handyLed = document.createElement('span');
    this._handyLed.className = 'nav-bar__handy-led';

    this._handyLabel = document.createElement('span');
    this._handyLabel.className = 'nav-bar__handy-label';
    this._handyLabel.textContent = 'Devices';

    this._handyText = document.createElement('span');
    this._handyText.className = 'nav-bar__handy-text';
    this._handyText.textContent = 'Disconnected';

    this._handyBtn.appendChild(this._handyLed);
    this._handyBtn.appendChild(this._handyLabel);
    this._handyBtn.appendChild(this._handyText);

    this._handyBtn.addEventListener('click', () => {
      if (this._onHandyClick) this._onHandyClick();
    });

    this._el.appendChild(this._handyBtn);

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

  setHandyStatus(status, deviceCount = 0) {
    if (!this._handyLed || !this._handyText) return;
    this._handyLed.className = 'nav-bar__handy-led';

    if (this._handyLabel) {
      this._handyLabel.textContent = deviceCount === 1 ? 'Device' : 'Devices';
    }

    switch (status) {
      case 'connected':
        this._handyLed.classList.add('nav-bar__handy-led--connected');
        this._handyText.textContent = deviceCount > 0 ? `${deviceCount} Connected` : 'Connected';
        break;
      case 'connecting':
        this._handyLed.classList.add('nav-bar__handy-led--connecting');
        this._handyText.textContent = 'Connecting...';
        break;
      case 'disconnected':
      default:
        this._handyText.textContent = 'Disconnected';
        break;
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
    if (!this._libraryDropdown.hidden) {
      this._libraryDropdown.hidden = true;
      return;
    }
    this._renderLibraryDropdown();
    this._libraryDropdown.hidden = false;

    // Close on outside click (clean up previous listener)
    if (this._libraryDropdownClose) {
      document.removeEventListener('click', this._libraryDropdownClose, true);
    }
    this._libraryDropdownClose = (e) => {
      if (!this._libraryDropdown.contains(e.target)) {
        this._libraryDropdown.hidden = true;
        document.removeEventListener('click', this._libraryDropdownClose, true);
        this._libraryDropdownClose = null;
      }
    };
    setTimeout(() => document.addEventListener('click', this._libraryDropdownClose, true), 0);
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
