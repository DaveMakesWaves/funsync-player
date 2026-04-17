// NavBar — Persistent top navigation bar

import { icon, Library, ListVideo, Tag, Download } from '../js/icons.js';

export class NavBar {
  constructor({ onNavigate, onHandyClick, onEroScriptsClick }) {
    this._onNavigate = onNavigate;
    this._onHandyClick = onHandyClick;
    this._onEroScriptsClick = onEroScriptsClick;
    this._el = null;
    this._activeId = null;
    this._handyBtn = null;
    this._handyLed = null;
    this._handyText = null;
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

      btn.addEventListener('click', () => {
        this._onNavigate(item.id);
      });

      this._el.appendChild(btn);
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
