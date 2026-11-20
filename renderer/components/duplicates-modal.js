// duplicates-modal — review duplicate videos and reclaim disk space.
//
// pallokala2, EroScripts #330: "anyone who has a big collection also knows we
// are always out of space, so finding duplicates helps get some space back".
//
// The hard part is not finding duplicates, it is making a delete UI that a
// person can trust. Everything below follows from that:
//
//   NOTHING IS PRESELECTED. Every checkbox starts clear. A screen that opens
//   with 200 files already ticked for deletion invites one careless click, and
//   the batch actions exist precisely so nobody has to tick 200 boxes by hand.
//
//   THE KEEPER CANNOT BE TICKED. Each group has one copy marked "Keep", and
//   its checkbox is disabled. It is impossible to select every member of a
//   group, so this screen can never delete the last copy of anything.
//
//   THE EVIDENCE IS ON SCREEN. Groups are labelled identical / likely /
//   possible with the reason in words. A byte-for-byte match and a
//   similar-looking filename are not the same claim and must not look alike.
//   Identical means a matching content hash, not just size and length
//   (FT-B01), because "Select spares in Identical" is the button people trust.
//
//   RECOVERABLE BY DEFAULT. Files go to the Recycle Bin, and the confirm
//   dialog says so. Nothing here can permanently destroy a file.
//
// Batch actions operate per tier, never across the whole list at once: "select
// every non-keeper in the identical groups" is a reasonable thing to trust,
// "select everything including the fuzzy name guesses" is not.
//
// "Looks the same (Stash)" (Stash "next" lot, 2026-11-19; DESIGN-stash-s1.md
// (j) #2): while Stash is on, each LINKED video carries the phash of its
// Stash scene into the finder (stash-scene-fields.js: a link whose data
// counts, checked against the size read here). It is read from the data
// FunSync already synced (stash-store.js's copy of main's projection): this
// screen never asks Stash anything, and the tier, like every other, ticks
// nothing by itself.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { showToast } from '../js/toast.js';
import { binOs } from '../js/recycle-bin.js';
import {
  findDuplicates, totalReclaimable, formatBytes, TIER, sameSizeCandidates,
} from '../js/duplicate-finder.js';
import { dataService } from '../js/data-service.js';
import { stashData } from '../js/stash-store.js';
import { stashSceneFields } from '../js/stash-scene-fields.js';

const TIER_ORDER = [TIER.IDENTICAL, TIER.STASH, TIER.LIKELY, TIER.POSSIBLE];

const TIER_LABEL = {
  [TIER.IDENTICAL]: 'settingsPanel.duplicates.tierIdentical',
  [TIER.STASH]: 'settingsPanel.duplicates.tierStash',
  [TIER.LIKELY]: 'settingsPanel.duplicates.tierLikely',
  [TIER.POSSIBLE]: 'settingsPanel.duplicates.tierPossible',
};
const TIER_WHY = {
  [TIER.IDENTICAL]: 'settingsPanel.duplicates.whyIdentical',
  [TIER.STASH]: 'settingsPanel.duplicates.whyStash',
  [TIER.LIKELY]: 'settingsPanel.duplicates.whyLikely',
  [TIER.POSSIBLE]: 'settingsPanel.duplicates.whyPossible',
};

/**
 * What this screen reads of Stash: the switch (`settings.stash.enabled`)
 * and the renderer's copy of the synced data. `duplicateSets` is Stash's own
 * duplicate check as scene-id sets; today's data contract does not carry
 * it, so none are read.
 */
const DEFAULT_STASH = Object.freeze({
  enabled: () => dataService.get('stash.enabled') === true,
  data: () => stashData(),
  duplicateSets: () => [],
});

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** Folder part of a path, for telling two same-named files apart. */
function folderOf(p) {
  const parts = String(p || '').split(/[\\/]/);
  parts.pop();
  return parts.join('/') || '—';
}

export class DuplicatesModal {
  /**
   * @param {{ getVideos: () => Array, onRemoved: (paths: string[]) => void,
   *   stash?: {enabled: () => boolean, data: () => object, duplicateSets?: () => string[][]} }} deps
   *   `stash` defaults to the app's settings and the renderer's Stash copy.
   */
  constructor({ getVideos, onRemoved, stash } = {}) {
    this.getVideos = getVideos || (() => []);
    this.onRemoved = onRemoved || (() => {});
    this.stash = stash || DEFAULT_STASH;
    this._groups = [];
    this._selected = new Set();   // paths ticked for removal
  }

  async show() {
    return Modal.open({
      title: t('settingsPanel.duplicates.title'),
      onRender: (body, close) => {
        this._body = body;
        this._close = close;
        body.classList.add('duplicates');
        this._renderScanning();
        // Defer so the modal paints before the scan blocks the thread.
        setTimeout(() => this._scan(), 50);
      },
    });
  }

  _renderScanning() {
    this._body.innerHTML = `
      <div class="duplicates__status" role="status">
        ${this._esc(t('settingsPanel.duplicates.scanning'))}
      </div>
    `;
  }

  async _scan() {
    const videos = this.getVideos() || [];
    // Sizes are not part of the library scan — they are only needed here, and
    // stat-ing the whole library on every launch to serve one optional screen
    // would be a poor trade.
    let sizes = {};
    try {
      sizes = await window.funsync.statVideoFiles(videos.map((v) => v.path)) || {};
    } catch (err) {
      console.warn('[Duplicates] Could not read file sizes:', err?.message || err);
    }
    const enriched = videos.map((v) => ({
      path: v.path,
      name: v.name,
      duration: v.duration,
      hasFunscript: !!v.hasFunscript,
      size: sizes[v.path]?.size ?? null,
      contentHash: null,
    }));

    // "Identical" needs proof of the same bytes, not just the same size and
    // runtime (FT-B01). Only files sharing an exact size can be Identical,
    // so only those are read, read-only, in the main process. No hash (an
    // error, an unreadable file) means no Identical, never a guess.
    const candidates = sameSizeCandidates(enriched);
    if (candidates.length && typeof window.funsync?.hashVideoFiles === 'function') {
      try {
        const hashes = await window.funsync.hashVideoFiles(candidates) || {};
        for (const e of enriched) {
          const h = hashes[e.path]?.hash;
          if (typeof h === 'string' && h) e.contentHash = h;
        }
      } catch (err) {
        console.warn('[Duplicates] Could not hash same-size files:', err?.message || err);
      }
    }

    const stashSceneSets = this._addStash(enriched);
    this._groups = findDuplicates(enriched, { stashSceneSets });
    this._selected.clear();
    this._render();
  }

  /**
   * "Looks the same (Stash)": while Stash is on, each linked video gets its
   * scene's phash and id (read from the synced data, never asked of
   * Stash). The trust check reads the size stat-ed above, so a file swapped
   * since its link carries none. Returns Stash's own duplicate sets, if any.
   */
  _addStash(enriched) {
    let enabled = false;
    try { enabled = this.stash.enabled() === true; } catch { enabled = false; }
    if (!enabled) return [];
    let data = null;
    try { data = this.stash.data(); } catch { data = null; }
    if (!data || typeof data !== 'object') return [];
    for (const e of enriched) {
      let fields = null;
      try {
        fields = stashSceneFields(data, e.path, { size: e.size, enabled: true });
      } catch {
        fields = null;
      }
      if (!fields) continue;
      e.stashSceneId = fields.sceneId;
      if (fields.phash) e.stashPhash = fields.phash;
    }
    let sets = [];
    try { sets = this.stash.duplicateSets?.() || []; } catch { sets = []; }
    return Array.isArray(sets) ? sets : [];
  }

  _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  _render() {
    if (!this._groups.length) {
      this._body.innerHTML = `
        <div class="duplicates__empty">
          <div class="duplicates__empty-title">${this._esc(t('settingsPanel.duplicates.noneTitle'))}</div>
          <div class="duplicates__empty-hint">${this._esc(t('settingsPanel.duplicates.noneHint'))}</div>
        </div>
      `;
      return;
    }

    const total = totalReclaimable(this._groups);
    const groupsByTier = TIER_ORDER
      .map((tier) => ({ tier, groups: this._groups.filter((g) => g.tier === tier) }))
      .filter((x) => x.groups.length);

    this._body.innerHTML = `
      <div class="duplicates__summary">
        ${this._esc(t('settingsPanel.duplicates.summary', {
          groups: this._groups.length,
          size: formatBytes(total),
        }))}
      </div>
      <div class="duplicates__caveat">${this._esc(t('settingsPanel.duplicates.caveat'))}</div>
      <div class="duplicates__batch">
        ${groupsByTier.map(({ tier, groups }) => `
          <button type="button" class="duplicates__batch-btn" data-select-tier="${tier}">
            ${this._esc(tier === TIER.STASH
              ? t('settingsPanel.duplicates.selectTierStash', { count: groups.length })
              : t('settingsPanel.duplicates.selectTier', { tier: t(TIER_LABEL[tier]), count: groups.length }))}
          </button>
        `).join('')}
        <button type="button" class="duplicates__batch-btn duplicates__batch-btn--clear" data-clear-all>
          ${this._esc(t('settingsPanel.duplicates.clearSelection'))}
        </button>
      </div>
      <div class="duplicates__list">
        ${groupsByTier.map(({ tier, groups }) => `
          <div class="duplicates__tier">
            <h3 class="duplicates__tier-head">
              <span class="duplicates__tier-badge duplicates__tier-badge--${tier}">${this._esc(t(TIER_LABEL[tier]))}</span>
              <span class="duplicates__tier-why">${this._esc(t(TIER_WHY[tier]))}</span>
            </h3>
            ${groups.map((g) => this._groupHtml(g)).join('')}
          </div>
        `).join('')}
      </div>
      <div class="duplicates__actions">
        <span class="duplicates__selection" id="dup-selection" aria-live="polite"></span>
        <button type="button" class="duplicates__remove-btn" id="dup-remove" disabled>
          ${this._esc(t('settingsPanel.duplicates.remove', { os: binOs() }))}
        </button>
      </div>
    `;

    this._wire();
    this._refreshSelectionUi();
  }

  _groupHtml(g) {
    return `
      <div class="duplicates__group" data-group="${this._esc(g.id)}">
        <div class="duplicates__group-head">
          ${this._esc(t('settingsPanel.duplicates.groupHead', {
            count: g.members.length, size: formatBytes(g.reclaimable),
          }))}
        </div>
        ${g.members.map((m) => {
          const isKeeper = m.path === g.keeperPath;
          return `
          <label class="duplicates__item${isKeeper ? ' duplicates__item--keeper' : ''}">
            <input type="checkbox" class="duplicates__check"
                   data-path="${this._esc(m.path)}"
                   ${isKeeper ? 'disabled' : ''}
                   aria-label="${this._esc(m.name)}">
            <span class="duplicates__item-main">
              <span class="duplicates__item-name">${this._esc(m.name)}</span>
              <span class="duplicates__item-folder">${this._esc(folderOf(m.path))}</span>
            </span>
            <span class="duplicates__item-meta">
              <span>${this._esc(m.size == null ? '—' : formatBytes(m.size))}</span>
              <span>${this._esc(fmtDuration(m.duration))}</span>
              ${m.hasFunscript ? `<span class="duplicates__item-script" title="${this._esc(t('settingsPanel.duplicates.hasScript'))}">${this._esc(t('settingsPanel.duplicates.scriptBadge'))}</span>` : ''}
            </span>
            ${isKeeper ? `<span class="duplicates__keeper-badge">${this._esc(t('settingsPanel.duplicates.keep'))}</span>` : ''}
          </label>`;
        }).join('')}
      </div>
    `;
  }

  _wire() {
    this._body.querySelectorAll('.duplicates__check').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) this._selected.add(cb.dataset.path);
        else this._selected.delete(cb.dataset.path);
        this._refreshSelectionUi();
      });
    });

    this._body.querySelectorAll('[data-select-tier]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // Selects every NON-KEEPER in that tier. The keeper checkboxes are
        // disabled, so this cannot empty a group however many times it runs.
        const tier = btn.dataset.selectTier;
        for (const g of this._groups.filter((x) => x.tier === tier)) {
          for (const m of g.members) {
            if (m.path !== g.keeperPath) this._selected.add(m.path);
          }
        }
        this._syncChecks();
      });
    });

    this._body.querySelector('[data-clear-all]')?.addEventListener('click', () => {
      this._selected.clear();
      this._syncChecks();
    });

    this._body.querySelector('#dup-remove')?.addEventListener('click', () => this._confirmRemove());
  }

  _syncChecks() {
    this._body.querySelectorAll('.duplicates__check').forEach((cb) => {
      if (cb.disabled) return;
      cb.checked = this._selected.has(cb.dataset.path);
    });
    this._refreshSelectionUi();
  }

  _selectedBytes() {
    let total = 0;
    for (const g of this._groups) {
      for (const m of g.members) {
        if (this._selected.has(m.path)) total += m.size || 0;
      }
    }
    return total;
  }

  _refreshSelectionUi() {
    const count = this._selected.size;
    const label = this._body.querySelector('#dup-selection');
    const btn = this._body.querySelector('#dup-remove');
    if (label) {
      label.textContent = count === 0
        ? t('settingsPanel.duplicates.nothingSelected')
        : t('settingsPanel.duplicates.selectedCount', {
          count, size: formatBytes(this._selectedBytes()),
        });
    }
    if (btn) btn.disabled = count === 0;
  }

  async _confirmRemove() {
    const paths = [...this._selected];
    if (!paths.length) return;
    const bytes = this._selectedBytes();

    // Say the number, say the size, and say where they go. The Recycle Bin
    // is the whole reason this is safe to offer, so it belongs in the
    // sentence rather than in a tooltip.
    const ok = await Modal.confirm(
      // "Recycle Bin" on Windows, "Trash" elsewhere (R3-06).
      t('settingsPanel.duplicates.confirmTitle', { os: binOs() }),
      t('settingsPanel.duplicates.confirmBody', { count: paths.length, size: formatBytes(bytes), os: binOs() }),
      { confirmText: t('settingsPanel.duplicates.confirmBtn', { os: binOs() }) },
    );
    if (!ok) return;

    let results = [];
    try {
      results = await window.funsync.trashVideoFiles(paths) || [];
    } catch (err) {
      showToast(t('settingsPanel.duplicates.removeFailed', { error: err?.message || err }), 'error', 6000);
      return;
    }

    const moved = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    if (moved.length) {
      showToast(t('settingsPanel.duplicates.removedToast', {
        count: moved.length,
        size: formatBytes(moved.reduce((s, r) => s + (r.size || 0), 0)),
        os: binOs(),
      }), 'success', 5000);
      this.onRemoved(moved.map((r) => r.path));
    }
    // Never silent. A file that would not move is one the user still thinks
    // is gone, and they will go looking for the space.
    if (failed.length) {
      showToast(t('settingsPanel.duplicates.removeSomeFailed', { count: failed.length }), 'error', 8000);
      console.warn('[Duplicates] Failed to trash:', failed);
    }

    // Re-scan from disk rather than patching the list: the library still
    // holds the removed entries until its next scan, and showing a stale
    // group here would invite a second delete of a file already gone.
    this._selected.clear();
    this._renderScanning();
    setTimeout(() => this._scan(), 50);
  }
}
