// SettingsPanel — App settings modal with tabs (Sources, Playback, Data)

import { Modal } from './modal.js';
import { icon, Trash2, Pencil } from '../js/icons.js';
import { showToast } from '../js/toast.js';

export class SettingsPanel {
  constructor({ settings, onSourcesChanged, onGapSkipChanged, onSmoothingChanged, onSpeedLimitChanged }) {
    this._settings = settings;
    this._onSourcesChanged = onSourcesChanged;
    this.onGapSkipChanged = onGapSkipChanged || null;
    this.onSmoothingChanged = onSmoothingChanged || null;
    this.onSpeedLimitChanged = onSpeedLimitChanged || null;
  }

  async show() {
    await Modal.open({
      title: 'Settings',
      onRender: (body, close) => {
        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.className = 'settings-panel__tabs';

        const tabs = [
          { id: 'sources', label: 'Sources' },
          { id: 'playback', label: 'Playback' },
          { id: 'data', label: 'Data' },
        ];

        const panels = {};

        for (const tab of tabs) {
          const btn = document.createElement('button');
          btn.className = 'settings-panel__tab';
          btn.dataset.tab = tab.id;
          btn.textContent = tab.label;
          btn.addEventListener('click', () => {
            tabBar.querySelectorAll('.settings-panel__tab').forEach(t =>
              t.classList.toggle('settings-panel__tab--active', t.dataset.tab === tab.id));
            Object.values(panels).forEach(p => p.hidden = true);
            panels[tab.id].hidden = false;
          });
          tabBar.appendChild(btn);
        }
        tabBar.querySelector('[data-tab="sources"]').classList.add('settings-panel__tab--active');
        body.appendChild(tabBar);

        // --- Sources Tab ---
        panels.sources = this._buildSourcesTab();
        body.appendChild(panels.sources);

        // --- Playback Tab ---
        panels.playback = this._buildPlaybackTab();
        panels.playback.hidden = true;
        body.appendChild(panels.playback);

        // --- Data Tab ---
        panels.data = this._buildDataTab();
        panels.data.hidden = true;
        body.appendChild(panels.data);

        // Done button
        const doneBtn = document.createElement('button');
        doneBtn.className = 'library__assoc-save-btn';
        doneBtn.style.cssText = 'display:block;width:50%;margin:16px auto 0';
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', () => close());
        body.appendChild(doneBtn);
      },
    });
  }

  _buildSourcesTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const sourcesList = document.createElement('div');
    sourcesList.className = 'settings-panel__sources-list';

    const renderSources = () => {
      sourcesList.innerHTML = '';
      const sources = this._settings.get('library.sources') || [];

      if (sources.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'settings-panel__empty';
        empty.textContent = 'No source folders added';
        sourcesList.appendChild(empty);
      } else {
        for (const src of sources) {
          const row = document.createElement('div');
          row.className = 'settings-panel__source-row';

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

          const actions = document.createElement('div');
          actions.className = 'settings-panel__source-actions';

          const renameBtn = document.createElement('button');
          renameBtn.className = 'settings-panel__source-btn';
          renameBtn.title = 'Rename';
          renameBtn.appendChild(icon(Pencil, { width: 14, height: 14 }));
          renameBtn.addEventListener('click', async () => {
            const newName = await Modal.prompt('Rename Source', 'Name', src.name);
            if (newName && newName !== src.name) {
              const srcs = this._settings.get('library.sources') || [];
              const target = srcs.find(s => s.id === src.id);
              if (target) { target.name = newName; this._settings.set('library.sources', srcs); renderSources(); if (this._onSourcesChanged) this._onSourcesChanged(); }
            }
          });

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'settings-panel__source-btn settings-panel__source-btn--danger';
          deleteBtn.title = 'Remove';
          deleteBtn.appendChild(icon(Trash2, { width: 14, height: 14 }));
          deleteBtn.addEventListener('click', async () => {
            const confirmed = await Modal.confirm('Remove Source', `Remove "${src.name}"? Your files won't be deleted.`);
            if (confirmed) {
              const srcs = this._settings.get('library.sources') || [];
              this._settings.set('library.sources', srcs.filter(s => s.id !== src.id));
              renderSources();
              if (this._onSourcesChanged) this._onSourcesChanged();
              showToast(`Source "${src.name}" removed`, 'info');
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
    addBtn.textContent = '+ Add Source Folder';
    addBtn.addEventListener('click', async () => {
      const dirPath = await window.funsync.selectDirectory();
      if (!dirPath) return;
      const srcs = this._settings.get('library.sources') || [];
      if (srcs.some(s => s.path === dirPath)) { showToast('Already a source', 'warn'); return; }
      const name = await Modal.prompt('Name this source', 'Source name', dirPath.split(/[\\/]/).pop());
      if (!name) return;
      srcs.push({ id: crypto.randomUUID(), name, path: dirPath, enabled: true });
      this._settings.set('library.sources', srcs);
      renderSources();
      if (this._onSourcesChanged) this._onSourcesChanged();
      showToast(`Source "${name}" added`, 'info');
    });
    panel.appendChild(addBtn);

    return panel;
  }

  _buildPlaybackTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    // Gap Skip
    const gapSection = document.createElement('div');
    gapSection.className = 'settings-panel__section';
    gapSection.innerHTML = `
      <div class="settings-panel__section-header">Gap Skip</div>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Mode</span>
        <select id="sp-gap-mode" class="connection-panel__device-select">
          <option value="off">Off</option>
          <option value="auto">Auto (countdown)</option>
          <option value="button">Show Skip Button</option>
        </select>
      </div>
      <div class="settings-panel__field" id="sp-gap-threshold-row" hidden>
        <span class="settings-panel__field-label">Threshold</span>
        <input type="range" id="sp-gap-threshold" min="5" max="60" value="10" style="flex:1">
        <span id="sp-gap-threshold-val" class="settings-panel__field-value">10s</span>
      </div>
      <div class="settings-panel__hint">Gaps shorter than the threshold are ignored. Press G to skip manually.</div>
    `;
    panel.appendChild(gapSection);

    // Smoothing
    const smoothSection = document.createElement('div');
    smoothSection.className = 'settings-panel__section';
    smoothSection.innerHTML = `
      <div class="settings-panel__section-header">Motion Smoothing</div>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Interpolation</span>
        <select id="sp-smoothing" class="connection-panel__device-select">
          <option value="linear">Linear (default)</option>
          <option value="pchip">Smooth (PCHIP)</option>
          <option value="makima">Extra Smooth (Makima)</option>
        </select>
      </div>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Speed Limit</span>
        <input type="range" id="sp-speed-limit" min="0" max="500" value="0" step="10" style="flex:1">
        <span id="sp-speed-limit-val" class="settings-panel__field-value">Off</span>
      </div>
      <div class="settings-panel__hint">Smoothing affects Buttplug.io linear devices. Handy uses its own interpolation.</div>
    `;
    panel.appendChild(smoothSection);

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
        if (speedLimitVal) speedLimitVal.textContent = savedLimit > 0 ? `${savedLimit}` : 'Off';
        speedLimit.addEventListener('input', () => {
          const val = parseInt(speedLimit.value, 10) || 0;
          if (speedLimitVal) speedLimitVal.textContent = val > 0 ? `${val}` : 'Off';
          this._settings.set('player.speedLimit', val);
          if (this.onSpeedLimitChanged) this.onSpeedLimitChanged(val);
        });
      }
    }, 0);

    return panel;
  }

  _buildDataTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const section = document.createElement('div');
    section.className = 'settings-panel__section';
    section.innerHTML = `
      <div class="settings-panel__section-header">Backup</div>
      <div class="settings-panel__hint" style="margin-bottom:10px">Export all settings, playlists, categories, and associations as a backup file. Import to restore.</div>
      <div style="display:flex;gap:8px">
        <button id="sp-export" class="settings-panel__add-btn" style="border-style:solid">Export Backup</button>
        <button id="sp-import" class="settings-panel__add-btn" style="border-style:solid">Import Backup</button>
      </div>
    `;
    panel.appendChild(section);

    setTimeout(() => {
      panel.querySelector('#sp-export')?.addEventListener('click', async () => {
        const btn = panel.querySelector('#sp-export');
        btn.disabled = true; btn.textContent = 'Exporting...';
        try {
          const result = await window.funsync.exportData();
          if (result.success) showToast(`Backup saved: ${result.path}`, 'info');
          else showToast('Export failed', 'error');
        } catch { showToast('Export failed', 'error'); }
        btn.disabled = false; btn.textContent = 'Export Backup';
      });

      panel.querySelector('#sp-import')?.addEventListener('click', async () => {
        const btn = panel.querySelector('#sp-import');
        btn.disabled = true; btn.textContent = 'Importing...';
        try {
          const result = await window.funsync.importData();
          if (result.success) showToast(`Imported (${result.funscriptCount || 0} scripts)`, 'info');
          else showToast('Import cancelled', 'info');
        } catch { showToast('Import failed', 'error'); }
        btn.disabled = false; btn.textContent = 'Import Backup';
      });
    }, 0);

    return panel;
  }
}
