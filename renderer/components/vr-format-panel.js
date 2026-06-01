// VRFormatPanel — per-video override for the VR-flatten projection.
//
// Phase 1 of SCOPE-vr-flatten-full.md. Opens from:
//   - Ctrl+Shift+R (keyboard.js → onOpenVRFormat callback)
//   - Library kebab → "VR Format…"
//
// What it does:
//   - Lets the user override the auto-detected stereo packing for the
//     current video. Lives in `library.vrFormat[path]` (richer than the
//     legacy `library.vrFlatten` two-string shape — see store.js).
//   - Eye picker (left/top vs right/bottom) when a stereo projection is
//     active.
//   - Zoom slider (1.0×–2.0×) when planar; lets users override the
//     natural half-frame view for non-standard packings.
//   - Apply-to-folder: copies the current config to every sibling video
//     in the same parent directory. Non-recursive. Chunked writes
//     (50/batch) so a 1000-video folder doesn't freeze the UI.
//   - Reset-to-auto: clears the per-video entry; detection takes over.
//
// Non-planar projections (fisheye / equirect / MKX / RF52 / EAC) appear
// in the dropdown but are disabled — "Coming soon" — pending the
// WebGL pipeline in Phase 2a/2b.

import { Modal } from './modal.js';
import { showToast } from '../js/toast.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';
import { classifyStereoFormat } from '../js/vr-detect.js';

const PLANAR_PROJECTIONS = ['sbs-half', 'sbs-full', 'tb-half', 'tb-full'];
// Phase 2a — WebGL renderer ships these. Surfaced as enabled options.
const SPHERICAL_PROJECTIONS = ['equirect-180', 'fisheye-180'];
// Phase 2b — disabled "Coming soon" entries, kept in the panel for
// discoverability; the dropdown options are constructed disabled.
const NONPLANAR_COMING_SOON = [
  'fisheye-190', 'fisheye-200',
  'equirect-360',
  'mkx200', 'rf52', 'eac',
];

const APPLY_BATCH_SIZE = 50;

/**
 * Translate a projection key to a localised label. Falls back to the
 * raw key if no translation is present (so future projections show
 * up gracefully).
 */
function projectionLabel(key) {
  const k = `vrFormat.projection.${key}`;
  const label = t(k);
  return label === k ? key : label;
}

/**
 * Compute the dataService entry shape from the panel's current
 * controls. Pure — exported for tests.
 */
export function buildEntry({ projection, eye, zoom, fov, yaw, pitch, roll, source = 'manual' }) {
  if (!projection || projection === 'flat') {
    return { projection: 'flat', eye: null, zoom: 1, fov: 90, yaw: 0, pitch: 0, roll: 0, source };
  }
  return {
    projection,
    eye: eye === 'right' ? 'right' : 'left',
    zoom: Number.isFinite(zoom) ? Math.max(1, Math.min(2, zoom)) : 1,
    fov: Number.isFinite(fov) ? Math.max(30, Math.min(160, fov)) : 90,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    pitch: Number.isFinite(pitch) ? Math.max(-85, Math.min(85, pitch)) : 0,
    // Roll is binary (off / 180°) from the v1 UI but stored as degrees
    // so we can extend to free-roll later without a schema change.
    roll: Number.isFinite(roll) ? roll : 0,
    source,
  };
}

/**
 * Open the VR Format panel for the given video path.
 * @param {Object} opts
 * @param {string} opts.path — absolute video path
 * @param {Object} opts.dataService — settings-store handle
 * @param {Function} [opts.onApply] — called with (path, entry) on every change
 * @param {Function} [opts.enumerateFolderVideos] — `(dir) => Promise<string[]>` (injected for tests)
 */
export function openVRFormatPanel({ path, dataService, onApply, enumerateFolderVideos }) {
  if (!path) {
    showToast(t('toast.noVideoLoaded'), 'info');
    return Promise.resolve(null);
  }

  // Helpers (closures over `path` and `dataService`).
  const readEntry = () => {
    const map = dataService.get('library.vrFormat') || {};
    return map[path] || null;
  };
  const writeEntry = (entry) => {
    const map = { ...(dataService.get('library.vrFormat') || {}) };
    if (!entry) delete map[path];
    else map[path] = entry;
    dataService.set('library.vrFormat', map);
    eventBus.emit('vrFormat:changed', { path, entry });
    if (onApply) onApply(path, entry);
  };

  const detected = classifyStereoFormat(path);
  const initial = readEntry();
  // State held in the panel — written through on every change.
  const state = {
    projection: initial?.projection ?? (PLANAR_PROJECTIONS.includes(detected) ? detected : null),
    eye: initial?.eye === 'right' ? 'right' : 'left',
    zoom: Number.isFinite(initial?.zoom) ? initial.zoom : 1,
    fov: Number.isFinite(initial?.fov) ? initial.fov : 90,
    yaw: Number.isFinite(initial?.yaw) ? initial.yaw : 0,
    pitch: Number.isFinite(initial?.pitch) ? initial.pitch : 0,
    roll: Number.isFinite(initial?.roll) ? initial.roll : 0,
    source: initial?.source || (initial ? 'manual' : 'auto'),
  };

  return Modal.open({
    title: t('vrFormat.title'),
    onRender(body, close) {
      const wrap = document.createElement('div');
      wrap.className = 'vr-format-panel';

      // --- Projection picker ---
      const projSection = document.createElement('div');
      projSection.className = 'vr-format-panel__section';
      const projLabel = document.createElement('label');
      projLabel.className = 'vr-format-panel__label';
      projLabel.textContent = t('vrFormat.projectionLabel');
      projSection.appendChild(projLabel);

      const projSelect = document.createElement('select');
      projSelect.className = 'vr-format-panel__select';
      // Flat
      const flatGroup = document.createElement('optgroup');
      flatGroup.label = t('vrFormat.group.flat');
      const flatOpt = document.createElement('option');
      flatOpt.value = 'flat';
      flatOpt.textContent = t('vrFormat.projection.flat');
      flatGroup.appendChild(flatOpt);
      projSelect.appendChild(flatGroup);
      // Planar — enabled (CSS-transform path)
      const planarGroup = document.createElement('optgroup');
      planarGroup.label = t('vrFormat.group.planar');
      for (const p of PLANAR_PROJECTIONS) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = projectionLabel(p);
        planarGroup.appendChild(opt);
      }
      projSelect.appendChild(planarGroup);
      // Spherical — enabled (WebGL renderer, Phase 2a)
      const sphericalGroup = document.createElement('optgroup');
      sphericalGroup.label = t('vrFormat.group.spherical');
      for (const p of SPHERICAL_PROJECTIONS) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = projectionLabel(p);
        sphericalGroup.appendChild(opt);
      }
      projSelect.appendChild(sphericalGroup);
      // Coming soon — disabled (Phase 2b)
      const comingGroup = document.createElement('optgroup');
      comingGroup.label = t('vrFormat.group.nonplanar');
      for (const p of NONPLANAR_COMING_SOON) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = `${projectionLabel(p)} — ${t('vrFormat.comingSoon')}`;
        opt.disabled = true;
        comingGroup.appendChild(opt);
      }
      projSelect.appendChild(comingGroup);
      projSelect.value = state.projection || 'flat';
      projSection.appendChild(projSelect);

      // Status line — explains where the current value came from.
      const status = document.createElement('div');
      status.className = 'vr-format-panel__status';
      projSection.appendChild(status);

      wrap.appendChild(projSection);

      // --- Eye picker ---
      const eyeSection = document.createElement('div');
      eyeSection.className = 'vr-format-panel__section';
      const eyeLabel = document.createElement('div');
      eyeLabel.className = 'vr-format-panel__label';
      eyeLabel.textContent = t('vrFormat.eyeLabel');
      eyeSection.appendChild(eyeLabel);

      const eyeGroup = document.createElement('div');
      eyeGroup.className = 'vr-format-panel__seg';
      eyeGroup.setAttribute('role', 'radiogroup');
      const eyeButtons = {};
      for (const v of ['left', 'right']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vr-format-panel__seg-btn';
        b.setAttribute('role', 'radio');
        b.dataset.eye = v;
        // Label text adapts to TB vs SBS naming (top/bottom vs left/right).
        b.textContent = v;  // replaced by refresh()
        b.addEventListener('click', () => {
          state.eye = v;
          state.source = 'manual';
          refresh();
          commit();
        });
        eyeGroup.appendChild(b);
        eyeButtons[v] = b;
      }
      eyeSection.appendChild(eyeGroup);
      wrap.appendChild(eyeSection);

      // --- Zoom slider ---
      const zoomSection = document.createElement('div');
      zoomSection.className = 'vr-format-panel__section';
      const zoomLabel = document.createElement('label');
      zoomLabel.className = 'vr-format-panel__label';
      zoomSection.appendChild(zoomLabel);

      const zoomSlider = document.createElement('input');
      zoomSlider.type = 'range';
      zoomSlider.min = '1';
      zoomSlider.max = '2';
      zoomSlider.step = '0.05';
      zoomSlider.value = String(state.zoom);
      zoomSlider.className = 'vr-format-panel__slider';
      zoomSlider.addEventListener('input', () => {
        state.zoom = parseFloat(zoomSlider.value) || 1;
        state.source = 'manual';
        refresh();
        commit();
      });
      zoomSection.appendChild(zoomSlider);
      wrap.appendChild(zoomSection);

      // --- FOV slider (spherical only) ---
      const fovSection = document.createElement('div');
      fovSection.className = 'vr-format-panel__section';
      const fovLabel = document.createElement('label');
      fovLabel.className = 'vr-format-panel__label';
      fovSection.appendChild(fovLabel);

      const fovSlider = document.createElement('input');
      fovSlider.type = 'range';
      fovSlider.min = '60';
      fovSlider.max = '120';
      fovSlider.step = '5';
      fovSlider.value = String(state.fov);
      fovSlider.className = 'vr-format-panel__slider';
      fovSlider.addEventListener('input', () => {
        state.fov = parseFloat(fovSlider.value) || 90;
        state.source = 'manual';
        refresh();
        commit();
      });
      fovSection.appendChild(fovSlider);

      const recenterBtn = document.createElement('button');
      recenterBtn.type = 'button';
      recenterBtn.className = 'modal-btn modal-btn--secondary vr-format-panel__inline-btn';
      recenterBtn.textContent = t('vrFormat.recenter');
      recenterBtn.addEventListener('click', () => {
        state.yaw = 0;
        state.pitch = 0;
        state.source = 'manual';
        refresh();
        commit();
      });
      fovSection.appendChild(recenterBtn);

      // --- Rotate 180° toggle ---
      // For camera rigs mounted upside-down on the rig — content reads
      // inverted after flatten until the user flips it. Spherical-only;
      // planar half-frame paths don't run the shader. Stored as degrees
      // so v2 can extend to free-roll without a schema change.
      const rotateToggle = document.createElement('button');
      rotateToggle.type = 'button';
      rotateToggle.className = 'modal-btn modal-btn--secondary vr-format-panel__inline-btn';
      rotateToggle.setAttribute('aria-pressed', 'false');
      rotateToggle.textContent = t('vrFormat.rotate180');
      rotateToggle.addEventListener('click', () => {
        state.roll = state.roll === 180 ? 0 : 180;
        state.source = 'manual';
        refresh();
        commit();
      });
      fovSection.appendChild(rotateToggle);
      wrap.appendChild(fovSection);

      // --- Action row ---
      const actions = document.createElement('div');
      actions.className = 'vr-format-panel__actions';

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'modal-btn modal-btn--secondary';
      resetBtn.textContent = t('vrFormat.resetToAuto');
      resetBtn.addEventListener('click', () => {
        writeEntry(null);
        state.projection = PLANAR_PROJECTIONS.includes(detected) ? detected : null;
        state.eye = 'left';
        state.zoom = 1;
        state.fov = 90;
        state.yaw = 0;
        state.pitch = 0;
        state.roll = 0;
        state.source = 'auto';
        projSelect.value = state.projection || 'flat';
        zoomSlider.value = String(state.zoom);
        fovSlider.value = String(state.fov);
        refresh();
        showToast(t('vrFormat.toastReset'), 'info', 2500);
      });
      actions.appendChild(resetBtn);

      const folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = 'modal-btn modal-btn--secondary';
      folderBtn.textContent = t('vrFormat.applyToFolder');
      folderBtn.addEventListener('click', async () => {
        await applyToFolder({
          path,
          entry: currentEntry(),
          dataService,
          enumerateFolderVideos,
          onApply,
        });
      });
      actions.appendChild(folderBtn);

      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = 'modal-btn modal-btn--primary';
      doneBtn.textContent = t('common.done');
      doneBtn.addEventListener('click', () => close());
      actions.appendChild(doneBtn);

      wrap.appendChild(actions);
      body.appendChild(wrap);

      // --- Behaviour ---
      projSelect.addEventListener('change', () => {
        state.projection = projSelect.value === 'flat' ? null : projSelect.value;
        state.source = 'manual';
        refresh();
        commit();
      });

      function currentEntry() {
        if (projSelect.value === 'flat') {
          return buildEntry({ projection: 'flat', eye: null, zoom: 1, source: state.source });
        }
        if (!state.projection) return null;
        return buildEntry({
          projection: state.projection,
          eye: state.eye,
          zoom: state.zoom,
          fov: state.fov,
          yaw: state.yaw,
          pitch: state.pitch,
          roll: state.roll,
          source: state.source,
        });
      }

      function commit() {
        writeEntry(currentEntry());
      }

      function refresh() {
        const proj = projSelect.value;
        const isPlanar = PLANAR_PROJECTIONS.includes(proj);
        const isSpherical = SPHERICAL_PROJECTIONS.includes(proj);
        const isStereo = isPlanar || isSpherical; // both have left/right eye
        const isTB = proj === 'tb-half' || proj === 'tb-full';

        // Eye section: visible for any stereo projection (planar or spherical).
        eyeSection.style.display = isStereo ? '' : 'none';
        eyeButtons.left.textContent = isTB ? t('vrFormat.eye.top') : t('vrFormat.eye.left');
        eyeButtons.right.textContent = isTB ? t('vrFormat.eye.bottom') : t('vrFormat.eye.right');
        for (const v of ['left', 'right']) {
          const active = state.eye === v;
          eyeButtons[v].classList.toggle('vr-format-panel__seg-btn--active', active);
          eyeButtons[v].setAttribute('aria-checked', active ? 'true' : 'false');
        }

        // Zoom section: planar only (CSS scale path).
        zoomSection.style.display = isPlanar ? '' : 'none';
        zoomLabel.textContent = t('vrFormat.zoomLabel', { value: state.zoom.toFixed(2) });
        zoomSlider.value = String(state.zoom);

        // FOV + recenter + rotate-180: spherical only (WebGL viewport).
        fovSection.style.display = isSpherical ? '' : 'none';
        fovLabel.textContent = t('vrFormat.fovLabel', { value: Math.round(state.fov) });
        fovSlider.value = String(state.fov);
        const rolled = state.roll === 180;
        rotateToggle.classList.toggle('vr-format-panel__seg-btn--active', rolled);
        rotateToggle.setAttribute('aria-pressed', rolled ? 'true' : 'false');

        // Status line.
        if (proj === 'flat') {
          status.textContent = t('vrFormat.status.markedFlat');
        } else if (state.source === 'manual') {
          status.textContent = t('vrFormat.status.manual');
        } else if (detected && PLANAR_PROJECTIONS.includes(detected)) {
          status.textContent = t('vrFormat.status.detected', { projection: projectionLabel(detected) });
        } else if (detected === 'nonplanar') {
          status.textContent = t('vrFormat.status.detectedNonplanar');
        } else {
          status.textContent = t('vrFormat.status.noDetection');
        }

        // Folder button: only meaningful when a concrete config is set.
        folderBtn.disabled = !currentEntry();
      }

      refresh();
      projSelect.focus();
    },
  });
}

/**
 * Apply the given entry to every sibling video in the same parent
 * directory. Non-recursive. Chunked 50/batch with a single
 * `vrFormat:changed` emit afterwards. Pure-IO export (exported for
 * tests).
 */
export async function applyToFolder({ path, entry, dataService, enumerateFolderVideos, onApply }) {
  if (!entry) {
    showToast(t('vrFormat.applyEmptyError'), 'warn');
    return { applied: 0, cancelled: true };
  }
  const enumerate = enumerateFolderVideos || (window.funsync?.enumerateFolderVideos);
  if (!enumerate) {
    showToast(t('vrFormat.applyUnavailable'), 'warn');
    return { applied: 0, cancelled: true };
  }
  const dir = path.replace(/[\\/][^\\/]*$/, '');
  let siblings;
  try {
    siblings = await enumerate(dir);
  } catch (err) {
    console.warn('[vrFormat] enumerate failed:', err);
    showToast(t('vrFormat.applyEnumerateError'), 'warn');
    return { applied: 0, cancelled: true };
  }
  if (!Array.isArray(siblings) || siblings.length === 0) {
    showToast(t('vrFormat.applyNothingFound'), 'info');
    return { applied: 0, cancelled: true };
  }

  const existingMap = dataService.get('library.vrFormat') || {};
  const conflicts = siblings.filter(p => existingMap[p] && p !== path);
  const confirmed = await confirmApplyToFolder(siblings.length, conflicts.length, dir);
  if (!confirmed) return { applied: 0, cancelled: true };

  // Chunked write — build the final map and write once per chunk.
  const map = { ...existingMap };
  let applied = 0;
  for (let i = 0; i < siblings.length; i += APPLY_BATCH_SIZE) {
    const batch = siblings.slice(i, i + APPLY_BATCH_SIZE);
    for (const p of batch) {
      map[p] = entry;
      applied++;
    }
    dataService.set('library.vrFormat', map);
    // Yield so the UI can repaint between large batches.
    if (i + APPLY_BATCH_SIZE < siblings.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  eventBus.emit('vrFormat:changed', { path: null, entry, bulk: true });
  if (onApply) onApply(null, entry);
  showToast(t('vrFormat.applyDone', { count: applied }), 'success', 3000);
  return { applied, cancelled: false };
}

function confirmApplyToFolder(total, conflicts, dir) {
  const folderName = dir.split(/[\\/]/).pop() || dir;
  return Modal.open({
    title: t('vrFormat.applyConfirmTitle'),
    onRender(body, close) {
      const wrap = document.createElement('div');
      const summary = document.createElement('p');
      summary.className = 'modal-message';
      summary.textContent = t('vrFormat.applyConfirmSummary', { count: total, folder: folderName });
      wrap.appendChild(summary);
      if (conflicts > 0) {
        const conflict = document.createElement('p');
        conflict.className = 'modal-message';
        conflict.style.color = 'var(--text-secondary)';
        conflict.textContent = t('vrFormat.applyConfirmConflicts', { count: conflicts });
        wrap.appendChild(conflict);
      }
      body.appendChild(wrap);
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.className = 'modal-btn modal-btn--secondary';
      cancel.textContent = t('common.cancel');
      cancel.addEventListener('click', () => close(false));
      const ok = document.createElement('button');
      ok.className = 'modal-btn modal-btn--primary';
      ok.textContent = t('vrFormat.applyConfirmOk');
      ok.addEventListener('click', () => close(true));
      actions.appendChild(cancel);
      actions.appendChild(ok);
      body.appendChild(actions);
    },
  });
}
