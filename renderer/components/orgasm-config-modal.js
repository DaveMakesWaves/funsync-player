// Orgasm Switch config modal — single / multi-axis / custom routing.
//
// Assignment parity with videos (Dave, 2026-08-04): the finisher uses the
// SAME parallel-slot association entry videos use (association-shape.js),
// picked through the same three-mode UI. This is a dedicated component
// rather than a refactor of library.js's _associateFunscript — that modal
// is coupled to library scan state (unmatched-script ranking, embedded-axes
// probing); here scripts come from the native file dialog and companion
// axes are probed directly on disk via the fileExists IPC, so it works
// before (or without) a library scan. CSS + most strings are shared with
// the library modal so the two look and read identically.
//
// Resolves with the new entry on save, `undefined` on cancel (so callers
// can distinguish "cancelled" from a future "cleared" null).

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { buildAssociationEntry, normalizeAssociation } from '../js/association-shape.js';
import { AXIS_DEFINITIONS, buildCompanionPath, axisSuffixVariants } from '../js/multi-axis.js';

const baseName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');

/**
 * @param {object} opts
 * @param {object|null} opts.entry — current normalized entry (or null)
 * @param {Array} opts.knownDevices — settings `knownDevices` list
 * @returns {Promise<object|undefined>} new entry, or undefined on cancel
 */
export async function openOrgasmConfigModal({ entry, knownDevices = [] } = {}) {
  const existing = normalizeAssociation(entry);
  const isMulti = existing.active === 'multi';
  const isCustom = existing.active === 'custom';

  // The finisher loop has no Autoblow drive path (upload+sync only, no
  // direct move API) — offering it would create a silently dead route.
  const routableDevices = knownDevices.filter((kd) => kd.type !== 'autoblow');

  const result = await Modal.open({
    title: t('orgasmConfig.title'),
    onRender: (body, close) => {
      // --- Mode radio (same classes + strings as the library modal) ---
      const modeRow = document.createElement('div');
      modeRow.className = 'library__assoc-mode';
      const radios = {};
      for (const mode of ['single', 'multi', 'custom']) {
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'orgasm-assoc-mode';
        radio.id = `orgasm-assoc-${mode}`;
        radio.value = mode;
        radio.checked = mode === 'single' ? (!isMulti && !isCustom) : mode === 'multi' ? isMulti : isCustom;
        const label = document.createElement('label');
        label.htmlFor = radio.id;
        label.textContent = t(`library.assoc.mode${mode[0].toUpperCase()}${mode.slice(1)}`);
        modeRow.appendChild(radio);
        modeRow.appendChild(label);
        radios[mode] = radio;
      }
      body.appendChild(modeRow);

      const makeSaveBtn = (onSave) => {
        const btn = document.createElement('button');
        btn.className = 'library__assoc-save-btn';
        btn.style.marginTop = '12px';
        btn.textContent = t('library.assoc.save');
        btn.addEventListener('click', onSave);
        return btn;
      };

      const makeScriptRow = (labelText, getName, onPick, onClear) => {
        const row = document.createElement('div');
        row.className = 'library__custom-route-field';
        const label = document.createElement('span');
        label.className = 'library__assoc-axis-label';
        label.textContent = labelText;
        const name = document.createElement('span');
        name.className = 'library__custom-route-script';
        const refresh = () => { name.textContent = getName() || t('library.assoc.scriptNone'); };
        refresh();
        const pick = document.createElement('button');
        pick.className = 'connection-panel__btn';
        pick.style.cssText = 'min-width:auto;padding:4px 10px;font-size:11px';
        pick.textContent = t('library.assoc.selectScriptBtn');
        pick.addEventListener('click', async () => { await onPick(); refresh(); });
        row.appendChild(label);
        row.appendChild(name);
        row.appendChild(pick);
        if (onClear) {
          const clear = document.createElement('button');
          clear.className = 'library__assoc-current-clear';
          clear.textContent = '✕';
          clear.title = t('library.assoc.removeAssociation');
          clear.addEventListener('click', () => { onClear(); refresh(); });
          row.appendChild(clear);
        }
        return { row, refresh };
      };

      const pickScript = async () => {
        const picked = await window.funsync.selectFunscript();
        return picked?.path || null;
      };

      // --- Single pane ---
      const singlePanel = document.createElement('div');
      singlePanel.className = 'library__assoc-panel';
      singlePanel.hidden = isMulti || isCustom;
      let singlePath = existing.single || null;
      const singleRow = makeScriptRow(
        t('orgasmConfig.mainScript'),
        () => baseName(singlePath),
        async () => { const p = await pickScript(); if (p) singlePath = p; },
      );
      singlePanel.appendChild(singleRow.row);
      const singleHint = document.createElement('div');
      singleHint.className = 'settings-panel__hint';
      singleHint.textContent = t('settingsPanel.playback.orgasmScriptHint');
      singlePanel.appendChild(singleHint);
      singlePanel.appendChild(makeSaveBtn(() => {
        if (!singlePath) return;
        close({ entry: buildAssociationEntry('single', singlePath, existing.multi, existing.custom) });
      }));
      body.appendChild(singlePanel);

      // --- Multi pane ---
      const multiPanel = document.createElement('div');
      multiPanel.className = 'library__assoc-panel';
      multiPanel.hidden = !isMulti;
      const multi = {
        main: existing.multi?.main || null,
        axes: { ...(existing.multi?.axes || {}) },
        buttplugVib: !!existing.multi?.buttplugVib,
      };
      const axisRefreshers = [];

      // A saved config keys each axis by whatever spelling was canonical when
      // it was written — `suction` before 2026-08-16, `suck` after. Read and
      // clear across every accepted spelling so an older association doesn't
      // silently lose its axis; always WRITE the canonical one.
      const readAxis = (axis) => {
        for (const v of axisSuffixVariants(axis)) if (multi.axes[v]) return multi.axes[v];
        return '';
      };
      const clearAxis = (axis) => {
        for (const v of axisSuffixVariants(axis)) delete multi.axes[v];
      };

      // Auto-probe companion files next to a freshly-picked main script —
      // `<main>.twist.funscript` etc. — via fileExists (no library scan
      // needed, and Linux-safe: buildCompanionPath keeps the main file's
      // own directory + base casing, only the suffix is fixed lowercase,
      // which is the TCode naming convention).
      const probeCompanions = async (mainPath) => {
        await Promise.all(AXIS_DEFINITIONS.map(async (axis) => {
          if (readAxis(axis)) return; // never clobber a manual pick
          // Scripters spell the same axis differently: `.suck.` vs `.suction.`,
          // `.surge.` vs `.forward.`, or the raw channel `.A1.`. Probe every
          // accepted spelling, canonical first, and take the first that exists —
          // a scripter's choice of word must not decide whether we find the file.
          for (const variant of axisSuffixVariants(axis)) {
            const candidate = buildCompanionPath(mainPath, variant);
            try {
              if (await window.funsync.fileExists(candidate)) {
                multi.axes[axis.suffix] = candidate;
                return;
              }
            } catch { /* probe is best-effort */ }
          }
        }));
        axisRefreshers.forEach((fn) => fn());
      };

      const mainRow = makeScriptRow(
        t('library.assoc.axisMain'),
        () => baseName(multi.main),
        async () => {
          const p = await pickScript();
          if (p) { multi.main = p; await probeCompanions(p); }
        },
      );
      multiPanel.appendChild(mainRow.row);

      for (const axis of AXIS_DEFINITIONS) {
        const { row, refresh } = makeScriptRow(
          axis.label,
          () => baseName(readAxis(axis)),
          async () => { const p = await pickScript(); if (p) { clearAxis(axis); multi.axes[axis.suffix] = p; } },
          () => { clearAxis(axis); },
        );
        axisRefreshers.push(refresh);
        multiPanel.appendChild(row);
      }

      const vibRow = document.createElement('label');
      vibRow.className = 'library__custom-route-field';
      const vibCheck = document.createElement('input');
      vibCheck.type = 'checkbox';
      vibCheck.checked = multi.buttplugVib;
      vibCheck.addEventListener('change', () => { multi.buttplugVib = vibCheck.checked; });
      vibRow.appendChild(vibCheck);
      vibRow.appendChild(document.createTextNode(' ' + t('library.assoc.useButtplugVib')));
      multiPanel.appendChild(vibRow);

      const multiHint = document.createElement('div');
      multiHint.className = 'settings-panel__hint';
      multiHint.textContent = t('orgasmConfig.hintMulti');
      multiPanel.appendChild(multiHint);

      multiPanel.appendChild(makeSaveBtn(() => {
        const hasAxis = Object.values(multi.axes).some(Boolean);
        if (!multi.main && !hasAxis) return;
        close({
          entry: buildAssociationEntry('multi', existing.single, {
            main: multi.main,
            axes: Object.fromEntries(Object.entries(multi.axes).filter(([, v]) => v)),
            buttplugVib: multi.buttplugVib,
          }, existing.custom),
        });
      }));
      body.appendChild(multiPanel);

      // --- Custom routing pane ---
      const customPanel = document.createElement('div');
      customPanel.className = 'library__assoc-panel';
      customPanel.hidden = !isCustom;
      const routes = (existing.custom?.routes?.length
        ? existing.custom.routes.map((r) => ({ ...r }))
        : [{ deviceId: '', scriptPath: '', scriptName: '', role: 'main' }]);

      const renderRoutes = () => {
        customPanel.innerHTML = '';
        routes.forEach((route, i) => {
          const isMain = route.role === 'main';
          const row = document.createElement('div');
          row.className = 'library__custom-route';

          const header = document.createElement('div');
          header.className = 'library__custom-route-header';
          const title = document.createElement('span');
          title.className = 'library__custom-route-title';
          title.textContent = isMain ? t('library.assoc.routeMain') : t('library.assoc.routeNumbered', { n: i + 1 });
          header.appendChild(title);
          if (!isMain) {
            const del = document.createElement('button');
            del.className = 'library__assoc-current-clear';
            del.textContent = '✕';
            del.title = t('library.assoc.removeRoute');
            del.addEventListener('click', () => { routes.splice(i, 1); renderRoutes(); });
            header.appendChild(del);
          }
          row.appendChild(header);

          // Device dropdown — same composite-id handling as the library
          // modal (`buttplug:Name#Index` options; route keeps a name-only
          // deviceId + buttplugIndex, which is what the matcher consumes).
          const devRow = document.createElement('div');
          devRow.className = 'library__custom-route-field';
          const devLabel = document.createElement('span');
          devLabel.className = 'library__assoc-axis-label';
          devLabel.textContent = t('library.assoc.device');
          const devSelect = document.createElement('select');
          devSelect.className = 'connection-panel__device-select';
          const defaultOpt = document.createElement('option');
          defaultOpt.value = '';
          defaultOpt.textContent = routableDevices.length > 0
            ? t('library.assoc.selectDevice') : t('library.assoc.connectDeviceFirst');
          devSelect.appendChild(defaultOpt);
          for (const kd of routableDevices) {
            const opt = document.createElement('option');
            opt.value = kd.id;
            opt.textContent = kd.label;
            devSelect.appendChild(opt);
          }
          const matchedKd = routableDevices.find((kd) => {
            if (kd.type === 'buttplug') {
              const name = kd.name || kd.label;
              if (`buttplug:${name}` !== route.deviceId) return false;
              if (Number.isFinite(route.buttplugIndex)) return kd.buttplugIndex === route.buttplugIndex;
              return true;
            }
            return kd.id === route.deviceId;
          });
          devSelect.value = matchedKd?.id || '';
          devSelect.addEventListener('change', () => {
            const known = routableDevices.find((kd) => kd.id === devSelect.value);
            if (known && known.type === 'buttplug') {
              route.deviceId = `buttplug:${known.name || known.label}`;
            } else {
              route.deviceId = devSelect.value;
            }
            if (known && typeof known.buttplugIndex === 'number') {
              route.buttplugIndex = known.buttplugIndex;
            } else {
              delete route.buttplugIndex;
            }
          });
          devRow.appendChild(devLabel);
          devRow.appendChild(devSelect);
          row.appendChild(devRow);

          const scriptRow = makeScriptRow(
            t('library.assoc.script'),
            () => route.scriptName || baseName(route.scriptPath),
            async () => {
              const p = await pickScript();
              if (p) { route.scriptPath = p; route.scriptName = baseName(p); }
            },
          );
          row.appendChild(scriptRow.row);
          customPanel.appendChild(row);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'modal-list-item library__assoc-action';
        addBtn.textContent = t('library.assoc.addRoute');
        addBtn.addEventListener('click', () => {
          routes.push({ deviceId: '', scriptPath: '', scriptName: '', role: 'axis' });
          renderRoutes();
        });
        customPanel.appendChild(addBtn);

        const customHint = document.createElement('div');
        customHint.className = 'settings-panel__hint';
        customHint.textContent = t('orgasmConfig.hintCustom');
        customPanel.appendChild(customHint);

        customPanel.appendChild(makeSaveBtn(() => {
          const mainRoute = routes.find((r) => r.role === 'main');
          if (!mainRoute?.scriptPath || !mainRoute.deviceId) return;
          const usable = routes.filter((r) => r.scriptPath && r.deviceId);
          close({
            entry: buildAssociationEntry('custom', existing.single, existing.multi, { routes: usable }),
          });
        }));
      };
      renderRoutes();
      body.appendChild(customPanel);

      // --- Mode switching ---
      const syncPanels = () => {
        singlePanel.hidden = !radios.single.checked;
        multiPanel.hidden = !radios.multi.checked;
        customPanel.hidden = !radios.custom.checked;
      };
      for (const radio of Object.values(radios)) {
        radio.addEventListener('change', syncPanels);
      }
    },
  });

  // Modal.open resolves null on X / Escape / backdrop → cancelled.
  return result?.entry ?? undefined;
}
