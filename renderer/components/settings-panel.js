// SettingsPanel — App settings modal with tabs (Sources, Playback, Data)

import { Modal } from './modal.js';
import { icon, Trash2, Pencil, GripVertical } from '../js/icons.js';
import { showToast } from '../js/toast.js';
import { classifyOverlap } from '../js/path-utils.js';

// Canonical default values for each tunable Playback field. Used by the
// per-field reset-to-default `↻` button (Shneiderman #6 reversibility)
// and the "at default" dot indicator (Nielsen #1 visibility). When you
// add a new tunable setting, also add its default here so users can
// reset and see the default state.
const SETTINGS_DEFAULTS = {
  'player.gapSkip.mode': 'off',
  'player.gapSkip.thresholdSec': 10,
  'player.smoothing': 'linear',
  'player.speedLimit': 0,
  'player.linearStrategy': 'action-boundary',
  'player.linearLookaheadMs': 60,
  'player.minStrokeMs': 60,
};

export class SettingsPanel {
  constructor({ settings, onSourcesChanged, onGapSkipChanged, onSmoothingChanged, onSpeedLimitChanged, onLinearStrategyChanged, onLinearLookaheadChanged, onMinStrokeChanged }) {
    this._settings = settings;
    this._onSourcesChanged = onSourcesChanged;
    this.onGapSkipChanged = onGapSkipChanged || null;
    this.onSmoothingChanged = onSmoothingChanged || null;
    this.onSpeedLimitChanged = onSpeedLimitChanged || null;
    this.onLinearStrategyChanged = onLinearStrategyChanged || null;
    this.onLinearLookaheadChanged = onLinearLookaheadChanged || null;
    this.onMinStrokeChanged = onMinStrokeChanged || null;
  }

  async show() {
    await Modal.open({
      title: 'Settings',
      onRender: (body, close) => {
        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.className = 'settings-panel__tabs';
        tabBar.setAttribute('role', 'tablist');
        tabBar.setAttribute('aria-label', 'Settings sections');

        const tabs = [
          { id: 'sources', label: 'Sources' },
          { id: 'playback', label: 'Playback' },
          { id: 'appearance', label: 'Appearance' },
          { id: 'data', label: 'Data' },
        ];

        const panels = {};

        for (const tab of tabs) {
          const btn = document.createElement('button');
          btn.className = 'settings-panel__tab';
          btn.dataset.tab = tab.id;
          btn.textContent = tab.label;
          btn.id = `settings-tab-${tab.id}`;
          btn.setAttribute('role', 'tab');
          btn.setAttribute('aria-selected', 'false');
          btn.setAttribute('aria-controls', `settings-tabpanel-${tab.id}`);
          btn.tabIndex = -1;
          btn.addEventListener('click', () => {
            tabBar.querySelectorAll('.settings-panel__tab').forEach(t => {
              const isActive = t.dataset.tab === tab.id;
              t.classList.toggle('settings-panel__tab--active', isActive);
              t.setAttribute('aria-selected', isActive ? 'true' : 'false');
              t.tabIndex = isActive ? 0 : -1;
            });
            Object.values(panels).forEach(p => p.hidden = true);
            panels[tab.id].hidden = false;
            btn.focus();
          });
          tabBar.appendChild(btn);
        }
        // Wire arrow-key navigation between tabs (Nielsen #4 standards —
        // canonical tablist keyboard pattern).
        tabBar.addEventListener('keydown', (e) => {
          const tabBtns = [...tabBar.querySelectorAll('.settings-panel__tab')];
          const idx = tabBtns.indexOf(document.activeElement);
          if (idx < 0) return;
          let next = -1;
          if (e.key === 'ArrowRight') next = (idx + 1) % tabBtns.length;
          else if (e.key === 'ArrowLeft') next = (idx - 1 + tabBtns.length) % tabBtns.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = tabBtns.length - 1;
          if (next >= 0) {
            e.preventDefault();
            tabBtns[next].click();
          }
        });
        const initialTab = tabBar.querySelector('[data-tab="sources"]');
        initialTab.classList.add('settings-panel__tab--active');
        initialTab.setAttribute('aria-selected', 'true');
        initialTab.tabIndex = 0;
        body.appendChild(tabBar);

        // Helper — wire the per-tab panel ARIA + id pairing so the
        // tab→panel relationship is screen-reader-traversable.
        const wirePanel = (id) => {
          const p = panels[id];
          p.id = `settings-tabpanel-${id}`;
          p.setAttribute('role', 'tabpanel');
          p.setAttribute('aria-labelledby', `settings-tab-${id}`);
          return p;
        };

        // --- Sources Tab ---
        panels.sources = this._buildSourcesTab();
        body.appendChild(wirePanel('sources'));

        // --- Playback Tab ---
        panels.playback = this._buildPlaybackTab();
        panels.playback.hidden = true;
        body.appendChild(wirePanel('playback'));

        // --- Appearance Tab (theme toggle) ---
        panels.appearance = this._buildAppearanceTab();
        panels.appearance.hidden = true;
        body.appendChild(wirePanel('appearance'));

        // --- Data Tab ---
        panels.data = this._buildDataTab();
        panels.data.hidden = true;
        body.appendChild(wirePanel('data'));

        // Done button — dedicated class (was borrowing
        // `.library__assoc-save-btn` from the library multi-select flow,
        // a semantic class mismatch flagged by the design audit).
        const doneBtn = document.createElement('button');
        doneBtn.className = 'settings-panel__done-btn';
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
          row.dataset.sourceId = src.id;
          row.draggable = true;
          if (src.enabled === false) row.classList.add('settings-panel__source-row--disabled');

          // Drag handle — reorder sources by dragging. Affects folder-view root
          // display order and persistence ordering. Native HTML5 DnD: dragstart
          // records the id, dragover targets highlight, drop swaps ids.
          const grip = document.createElement('span');
          grip.className = 'settings-panel__source-grip';
          grip.title = 'Drag to reorder';
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

          // Enable/disable toggle — click to include or exclude this source from scans
          // without deleting it (useful for temporarily-offline drives or archive folders).
          const toggle = document.createElement('button');
          toggle.className = 'settings-panel__source-toggle';
          toggle.setAttribute('role', 'switch');
          const isEnabled = src.enabled !== false;
          toggle.setAttribute('aria-checked', String(isEnabled));
          toggle.classList.toggle('settings-panel__source-toggle--on', isEnabled);
          toggle.title = isEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
          toggle.addEventListener('click', () => {
            const srcs = this._settings.get('library.sources') || [];
            const target = srcs.find(s => s.id === src.id);
            if (!target) return;
            target.enabled = target.enabled === false ? true : false;
            this._settings.set('library.sources', srcs);
            renderSources();
            if (this._onSourcesChanged) this._onSourcesChanged();
            showToast(`Source "${src.name}" ${target.enabled ? 'enabled' : 'disabled'}`, 'info');
          });
          row.appendChild(toggle);

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
                  `${convertedCount} synced collection${convertedCount !== 1 ? 's' : ''} now tracks the folder directly. Add the folder back as a source to see videos.`,
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

      const overlap = classifyOverlap(dirPath, srcs);
      let removeChildrenIds = null;

      if (overlap.kind === 'exact') {
        showToast(`Already added as "${overlap.source.name}"`, 'warn');
        return;
      }

      if (overlap.kind === 'child') {
        const proceed = await Modal.confirm(
          'Folder already covered',
          `"${dirPath}" is inside "${overlap.parent.name}" (${overlap.parent.path}). Files here are already scanned — adding it will double-count every video.\n\nAdd anyway?`
        );
        if (!proceed) return;
      }

      if (overlap.kind === 'parent') {
        const childNames = overlap.children.map(c => `"${c.name}"`).join(', ');
        const msg = `"${dirPath}" contains existing source${overlap.children.length !== 1 ? 's' : ''} ${childNames}. Those files will be scanned twice unless you remove the nested source${overlap.children.length !== 1 ? 's' : ''}.\n\nRemove nested source${overlap.children.length !== 1 ? 's' : ''} and add this one?`;
        const confirmed = await Modal.confirm('Overlapping source', msg);
        if (!confirmed) return;
        removeChildrenIds = new Set(overlap.children.map(c => c.id));
      }

      const name = await Modal.prompt('Name this source', 'Source name', dirPath.split(/[\\/]/).pop());
      if (!name) return;

      let nextSrcs = srcs;
      if (removeChildrenIds) {
        nextSrcs = nextSrcs.filter(s => !removeChildrenIds.has(s.id));
      }
      nextSrcs = [...nextSrcs, { id: crypto.randomUUID(), name, path: dirPath, enabled: true }];
      this._settings.set('library.sources', nextSrcs);
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
      <h2 class="settings-panel__section-header">Gap Skip</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Mode</span>
        <select id="sp-gap-mode" class="settings-panel__input settings-panel__input--select">
          <option value="off">Off</option>
          <option value="auto">Auto (countdown)</option>
          <option value="button">Show Skip Button</option>
        </select>
        <button type="button" id="sp-gap-mode-reset" class="settings-panel__field-reset" hidden title="Reset to default (Off)" aria-label="Reset Mode to default">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-gap-threshold-row" hidden>
        <span class="settings-panel__field-label">Threshold</span>
        <input type="range" id="sp-gap-threshold" class="settings-panel__input settings-panel__input--range" min="5" max="60" value="10" aria-describedby="sp-gap-hint">
        <span id="sp-gap-threshold-val" class="settings-panel__field-value">10s</span>
        <button type="button" id="sp-gap-threshold-reset" class="settings-panel__field-reset" hidden title="Reset to default (10s)" aria-label="Reset Threshold to default">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-gap-hint">Gaps shorter than the threshold are ignored. Press G to skip manually.</div>
    `;
    panel.appendChild(gapSection);

    // Smoothing — each control linked to the section hint via
    // aria-describedby so screen readers read the hint when the
    // input gets focus (Nielsen #4 standards — WCAG 1.3.1 Info and
    // Relationships).
    const smoothSection = document.createElement('div');
    smoothSection.className = 'settings-panel__section';
    smoothSection.innerHTML = `
      <h2 class="settings-panel__section-header">Motion Smoothing</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Interpolation</span>
        <select id="sp-smoothing" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-smoothing-hint">
          <option value="linear">Linear (default)</option>
          <option value="pchip">Smooth (PCHIP)</option>
          <option value="makima">Extra Smooth (Makima)</option>
        </select>
        <button type="button" id="sp-smoothing-reset" class="settings-panel__field-reset" hidden title="Reset to default (Linear)" aria-label="Reset Interpolation to default">↻</button>
      </div>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Speed Limit</span>
        <input type="range" id="sp-speed-limit" class="settings-panel__input settings-panel__input--range" min="0" max="500" value="0" step="10" aria-describedby="sp-smoothing-hint">
        <span id="sp-speed-limit-val" class="settings-panel__field-value">Off</span>
        <button type="button" id="sp-speed-limit-reset" class="settings-panel__field-reset" hidden title="Reset to default (Off)" aria-label="Reset Speed Limit to default">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-smoothing-hint">Smoothing affects Buttplug.io linear devices. Handy uses its own interpolation.</div>
    `;
    panel.appendChild(smoothSection);

    // Buttplug linear command strategy — BLE smoothness tuning
    const bpSection = document.createElement('div');
    bpSection.className = 'settings-panel__section';
    bpSection.innerHTML = `
      <h2 class="settings-panel__section-header">Buttplug Linear Output (BLE)</h2>
      <div class="settings-panel__field">
        <span class="settings-panel__field-label">Strategy</span>
        <select id="sp-linear-strategy" class="settings-panel__input settings-panel__input--select" aria-describedby="sp-bp-hint">
          <option value="action-boundary">Per-stroke (smoother on BLE)</option>
          <option value="interpolated">Per-tick (legacy)</option>
        </select>
        <button type="button" id="sp-linear-strategy-reset" class="settings-panel__field-reset" hidden title="Reset to default (Per-stroke)" aria-label="Reset Strategy to default">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-lookahead-row">
        <span class="settings-panel__field-label">Lookahead</span>
        <input type="range" id="sp-lookahead" class="settings-panel__input settings-panel__input--range" min="0" max="200" value="60" step="10" aria-describedby="sp-bp-hint">
        <span id="sp-lookahead-val" class="settings-panel__field-value">60ms</span>
        <button type="button" id="sp-lookahead-reset" class="settings-panel__field-reset" hidden title="Reset to default (60ms)" aria-label="Reset Lookahead to default">↻</button>
      </div>
      <div class="settings-panel__field" id="sp-min-stroke-row">
        <span class="settings-panel__field-label">Min stroke</span>
        <input type="range" id="sp-min-stroke" class="settings-panel__input settings-panel__input--range" min="0" max="200" value="60" step="10" aria-describedby="sp-bp-hint">
        <span id="sp-min-stroke-val" class="settings-panel__field-value">60ms</span>
        <button type="button" id="sp-min-stroke-reset" class="settings-panel__field-reset" hidden title="Reset to default (60ms)" aria-label="Reset Min Stroke to default">↻</button>
      </div>
      <div class="settings-panel__hint" id="sp-bp-hint">Per-stroke sends one command per action and lets the device's firmware interpolate — matches how the Handy's WiFi API (HSSP) feels. Lookahead compensates for BLE round-trip; min stroke stretches too-short strokes up so BLE can honor them. For Handy via connection code (HSSP), these have no effect.</div>
    `;
    panel.appendChild(bpSection);

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

      // Linear strategy + lookahead + min-stroke
      const linearStrategy = panel.querySelector('#sp-linear-strategy');
      const lookahead = panel.querySelector('#sp-lookahead');
      const lookaheadVal = panel.querySelector('#sp-lookahead-val');
      const lookaheadRow = panel.querySelector('#sp-lookahead-row');
      const minStroke = panel.querySelector('#sp-min-stroke');
      const minStrokeVal = panel.querySelector('#sp-min-stroke-val');
      const minStrokeRow = panel.querySelector('#sp-min-stroke-row');

      const applyStrategyVisibility = (strategy) => {
        // Lookahead + min-stroke only apply to action-boundary mode.
        // Was `hidden = true` (silent disappearance — Nielsen #1
        // violation: user couldn't tell those options existed). Now
        // dimmed via --inert modifier so the option is visible and
        // a "(action-boundary only)" suffix explains why it's not
        // currently usable. Inputs aria-disabled for screen readers.
        const isActionBoundary = strategy === 'action-boundary';
        const setInert = (row, range) => {
          if (!row) return;
          row.classList.toggle('settings-panel__field--inert', !isActionBoundary);
          if (range) {
            range.disabled = !isActionBoundary;
            range.setAttribute('aria-disabled', String(!isActionBoundary));
          }
        };
        setInert(lookaheadRow, lookahead);
        setInert(minStrokeRow, minStroke);
      };

      if (linearStrategy) {
        const savedStrategy = this._settings.get('player.linearStrategy') || 'action-boundary';
        linearStrategy.value = savedStrategy;
        applyStrategyVisibility(savedStrategy);
        linearStrategy.addEventListener('change', () => {
          const val = linearStrategy.value;
          this._settings.set('player.linearStrategy', val);
          applyStrategyVisibility(val);
          if (this.onLinearStrategyChanged) this.onLinearStrategyChanged(val);
        });
      }

      if (lookahead) {
        const savedLookahead = this._settings.get('player.linearLookaheadMs');
        const lookaheadDefault = savedLookahead != null ? savedLookahead : 60;
        lookahead.value = lookaheadDefault;
        if (lookaheadVal) lookaheadVal.textContent = `${lookaheadDefault}ms`;
        lookahead.addEventListener('input', () => {
          const val = parseInt(lookahead.value, 10) || 0;
          if (lookaheadVal) lookaheadVal.textContent = `${val}ms`;
          this._settings.set('player.linearLookaheadMs', val);
          if (this.onLinearLookaheadChanged) this.onLinearLookaheadChanged(val);
        });
      }

      if (minStroke) {
        const savedMinStroke = this._settings.get('player.minStrokeMs');
        const minStrokeDefault = savedMinStroke != null ? savedMinStroke : 60;
        minStroke.value = minStrokeDefault;
        if (minStrokeVal) minStrokeVal.textContent = `${minStrokeDefault}ms`;
        minStroke.addEventListener('input', () => {
          const val = parseInt(minStroke.value, 10) || 0;
          if (minStrokeVal) minStrokeVal.textContent = `${val}ms`;
          this._settings.set('player.minStrokeMs', val);
          if (this.onMinStrokeChanged) this.onMinStrokeChanged(val);
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
      wireDefault(gapThreshold, gapThresholdVal, panel.querySelector('#sp-gap-threshold-reset'), SETTINGS_DEFAULTS['player.gapSkip.thresholdSec']);
      wireDefault(smoothing, null, panel.querySelector('#sp-smoothing-reset'), SETTINGS_DEFAULTS['player.smoothing']);
      wireDefault(speedLimit, speedLimitVal, panel.querySelector('#sp-speed-limit-reset'), SETTINGS_DEFAULTS['player.speedLimit']);
      wireDefault(linearStrategy, null, panel.querySelector('#sp-linear-strategy-reset'), SETTINGS_DEFAULTS['player.linearStrategy']);
      wireDefault(lookahead, lookaheadVal, panel.querySelector('#sp-lookahead-reset'), SETTINGS_DEFAULTS['player.linearLookaheadMs']);
      wireDefault(minStroke, minStrokeVal, panel.querySelector('#sp-min-stroke-reset'), SETTINGS_DEFAULTS['player.minStrokeMs']);
    }, 0);

    return panel;
  }

  _buildAppearanceTab() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel__tab-content';

    const themeSection = document.createElement('div');
    themeSection.className = 'settings-panel__section';

    const current = this._settings.get('player.theme') || 'system';
    // Three radios — System default. We're explicit about "System" being a
    // real choice (not a hidden default) so users who change OS theme
    // mid-session see the app respect it. Hidden-system would mislead.
    themeSection.innerHTML = `
      <h2 class="settings-panel__section-header">Theme</h2>
      <div class="settings-panel__hint" id="theme-hint">
        Choose how the app looks. "System" follows your OS preference and
        switches automatically when you toggle dark / light at the OS level.
      </div>
      <div class="settings-panel__theme-options" role="radiogroup"
           aria-labelledby="theme-hint" data-setting="player.theme">
        <label class="settings-panel__theme-option">
          <input type="radio" name="theme" value="system" ${current === 'system' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">System</span>
            <span class="settings-panel__theme-desc">Match my operating system</span>
          </span>
        </label>
        <label class="settings-panel__theme-option">
          <input type="radio" name="theme" value="dark" ${current === 'dark' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">Dark</span>
            <span class="settings-panel__theme-desc">FunSync's original look</span>
          </span>
        </label>
        <label class="settings-panel__theme-option">
          <input type="radio" name="theme" value="light" ${current === 'light' ? 'checked' : ''}>
          <span class="settings-panel__theme-label">
            <span class="settings-panel__theme-name">Light</span>
            <span class="settings-panel__theme-desc">Off-white surfaces, dark text</span>
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
      <h2 class="settings-panel__section-header">Backup &amp; Recovery</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">
        Your settings are automatically backed up every minute while you use the app and before any destructive change. If something goes wrong you can restore an earlier state.
      </div>
      <div id="sp-backup-status" class="settings-panel__hint" style="margin-bottom:12px">Loading backup status…</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="sp-backup-now" class="settings-panel__add-btn" style="border-style:solid">Snapshot Now</button>
        <button id="sp-backup-restore" class="settings-panel__add-btn" style="border-style:solid">Restore From Backup…</button>
        <button id="sp-backup-folder" class="settings-panel__add-btn" style="border-style:solid">Open Backup Folder</button>
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
      <h2 class="settings-panel__section-header">Export &amp; Import</h2>
      <div class="settings-panel__hint" style="margin-bottom:10px">Save your settings, playlists, categories, and associations to a portable file — useful for moving to another machine or for an extra off-host backup.</div>
      <div style="display:flex;gap:8px">
        <button id="sp-export" class="settings-panel__add-btn" style="border-style:solid">Export Backup File</button>
        <button id="sp-import" class="settings-panel__add-btn" style="border-style:solid">Import Backup File</button>
      </div>
    `;
    panel.appendChild(exportSection);

    setTimeout(() => {
      this._wireDataTab(panel);
      this._refreshBackupStatus(panel);
    }, 0);

    return panel;
  }

  // Format a snapshot's age relative to now in a recognition-first style
  // (Nielsen #6) — "12 minutes ago" reads faster than a wall-clock time
  // that the user has to math against. Falls back to a date for old
  // snapshots so they don't read as "47 days ago" (loses precision).
  _formatRelativeTime(date) {
    const ms = Date.now() - date.getTime();
    if (ms < 0) return 'Just now';
    const min = Math.floor(ms / 60_000);
    const hr = Math.floor(ms / 3_600_000);
    const day = Math.floor(ms / 86_400_000);
    if (min < 1) return 'Just now';
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    if (day === 1) return 'Yesterday';
    if (day < 7) return `${day} days ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Trigger names from data-backup.js TRIGGER enum mapped to human labels.
  // Kept in the renderer rather than imported from main so we don't have
  // to thread a constants file across the contextBridge.
  _formatTrigger(trigger, label) {
    switch (trigger) {
      case 'startup':       return 'Startup';
      case 'debounced':     return 'Auto-save';
      case 'pre-action':    return label ? `Before ${label.replace(/-/g, ' ')}` : 'Before action';
      case 'manual':        return 'Manual';
      case 'quit':          return 'App quit';
      case 'post-recovery': return 'After recovery';
      case 'baseline':      return 'First snapshot';
      default:              return trigger || 'Snapshot';
    }
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
        statusEl.textContent = 'No snapshots yet. One will be taken automatically as you make changes.';
        return;
      }
      const newest = result.snapshots[0];
      const totalBytes = result.snapshots.reduce((s, e) => s + (e.sizeBytes || 0), 0);
      const when = this._formatRelativeTime(new Date(newest.timestamp));
      const count = result.snapshots.length;
      statusEl.textContent = `Last backup: ${when}. ${count} backup${count === 1 ? '' : 's'} stored, ${this._formatBytes(totalBytes)} total.`;
    } catch (err) {
      statusEl.textContent = 'Backup status unavailable.';
    }
  }

  _wireDataTab(panel) {
    // --- Snapshot Now ----------------------------------------------------
    panel.querySelector('#sp-backup-now')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#sp-backup-now');
      btn.disabled = true; btn.textContent = 'Snapshotting…';
      try {
        const result = await window.funsync.backupSnapshotNow();
        if (result?.success) {
          showToast('Snapshot taken', 'info');
          this._refreshBackupStatus(panel);
        } else {
          showToast(`Snapshot failed: ${result?.error || 'unknown error'}`, 'error');
        }
      } catch (err) {
        showToast('Snapshot failed', 'error');
      }
      btn.disabled = false; btn.textContent = 'Snapshot Now';
    });

    // --- Restore From Backup ---------------------------------------------
    panel.querySelector('#sp-backup-restore')?.addEventListener('click', async () => {
      let listResult;
      try {
        listResult = await window.funsync.backupList();
      } catch (err) {
        showToast('Could not load backup list', 'error');
        return;
      }
      if (!listResult?.success || !listResult.snapshots?.length) {
        showToast('No backups available yet', 'info');
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
        const summary = snap.summary || {};
        const parts = [];
        if (summary.sources)        parts.push(`${summary.sources} source${summary.sources === 1 ? '' : 's'}`);
        if (summary.collections)    parts.push(`${summary.collections} collection${summary.collections === 1 ? '' : 's'}`);
        if (summary.playlists)      parts.push(`${summary.playlists} playlist${summary.playlists === 1 ? '' : 's'}`);
        if (summary.customRoutings) parts.push(`${summary.customRoutings} routing${summary.customRoutings === 1 ? '' : 's'}`);
        const subtitle = `${this._formatBytes(snap.sizeBytes)} · ${parts.join(', ') || 'empty'}`;
        return {
          id: `${snap.subdir}/${snap.filename}`,
          label: `${when}  ·  ${trig}`,
          subtitle,
        };
      });

      const picked = await Modal.selectFromList('Restore from backup', items);
      if (!picked) return;

      // Confirm — restore is destructive (overwrites live config) and
      // requires a relaunch. Spell out the consequences (Shneiderman #4
      // dialog closure) and that we save the current state first
      // (Shneiderman #6 reversibility) so the user knows they can undo.
      const ok = await Modal.confirm(
        'Restore this snapshot?',
        'Your current settings will be saved as an emergency snapshot first, so you can undo if needed. The app will relaunch to apply the restored state.'
      );
      if (!ok) return;

      const [subdir, filename] = picked.split('/');
      try {
        const result = await window.funsync.backupRestore(subdir, filename);
        if (!result?.success) {
          showToast(`Restore failed: ${result?.error || 'unknown error'}`, 'error');
        }
        // On success the main process relaunches the app, so this
        // renderer is about to be torn down — no further UI updates.
      } catch (err) {
        showToast('Restore failed', 'error');
      }
    });

    // --- Open Backup Folder ----------------------------------------------
    panel.querySelector('#sp-backup-folder')?.addEventListener('click', async () => {
      try {
        const result = await window.funsync.backupOpenFolder();
        if (!result?.success) showToast('Could not open folder', 'error');
      } catch (err) {
        showToast('Could not open folder', 'error');
      }
    });

    // --- Export / Import (existing zip flow) -----------------------------
    panel.querySelector('#sp-export')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#sp-export');
      btn.disabled = true; btn.textContent = 'Exporting…';
      try {
        const result = await window.funsync.exportData();
        if (result.success) showToast(`Backup saved: ${result.path}`, 'info');
        else showToast('Export failed', 'error');
      } catch { showToast('Export failed', 'error'); }
      btn.disabled = false; btn.textContent = 'Export Backup File';
    });

    panel.querySelector('#sp-import')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#sp-import');
      btn.disabled = true; btn.textContent = 'Importing…';
      try {
        const result = await window.funsync.importData();
        if (result.success) showToast(`Imported (${result.funscriptCount || 0} scripts)`, 'info');
        else showToast('Import cancelled', 'info');
      } catch { showToast('Import failed', 'error'); }
      btn.disabled = false; btn.textContent = 'Import Backup File';
    });
  }
}
