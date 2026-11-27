// Check script dialog (editor work list 4.2, 2026-11-24): what checkScript()
// found, grouped by kind. A row jumps to its spot and selects its points; a
// group's "Select all" selects every point of that kind. Both close the
// dialog, which is modal: the fix happens in the editor behind it.
//
// Built on Modal.open (§2.5 contract: focus trap, Escape, focus restore) the
// way script-editor.js builds its tool dialogs (_openEveryNthModal), but with
// DOM nodes and textContent rather than an HTML string: the details carry
// numbers from the file, and nothing from a file goes through innerHTML.
//
// Long lists (DESIGN §2.17): a group shows its first ROW_LIMIT rows and says
// how many more there are; "Select all" still takes every one.

import { Modal } from './modal.js';
import { t } from '../js/i18n.js';
import { checkScript, groupIndices, formatCheckTime } from '../js/script-check.js';

/** Rows built per group; the rest are counted, and Select all includes them. */
export const ROW_LIMIT = 100;

// Literal keys (not built from the kind), so the i18n-keys-exist scan sees them.
const KIND_TITLE = {
  outOfRange: () => t('editor.check.kind.outOfRange'),
  notWhole: () => t('editor.check.kind.notWhole'),
  sameTime: () => t('editor.check.kind.sameTime'),
  tooFast: (o) => t('editor.check.kind.tooFast', { limit: o.maxSpeed }),
  tooSlow: (o) => t('editor.check.kind.tooSlow', { limit: o.minSpeed }),
  shortStroke: () => t('editor.check.kind.shortStroke'),
  longGap: (o) => t('editor.check.kind.longGap', { seconds: Math.round(o.longGapMs / 100) / 10 }),
};

const KIND_HINT = {
  outOfRange: () => t('editor.check.hint.outOfRange'),
  notWhole: () => t('editor.check.hint.notWhole'),
  sameTime: () => t('editor.check.hint.sameTime'),
  tooFast: () => t('editor.check.hint.tooFast'),
  tooSlow: () => t('editor.check.hint.tooSlow'),
  shortStroke: () => t('editor.check.hint.shortStroke'),
  longGap: () => t('editor.check.hint.longGap'),
};

/**
 * The words for one finding's detail (the part after the time).
 * @param {{kind: string, detail: object}} f
 * @returns {string}
 */
export function findingText(f) {
  const d = f.detail || {};
  switch (f.kind) {
    case 'tooFast':
    case 'tooSlow':
      return t('editor.check.detail.speed', { speed: d.speed });
    case 'sameTime':
      return t('editor.check.detail.sameTime', { count: d.count });
    case 'outOfRange':
      if (d.invalid) return t('editor.check.detail.invalid');
      if (d.pos !== undefined) return t('editor.check.detail.pos', { pos: d.pos });
      return t('editor.check.detail.time', { at: d.at });
    case 'notWhole':
      return t('editor.check.detail.notWhole', { at: d.at, pos: d.pos });
    case 'longGap':
      return t('editor.check.detail.gap', { seconds: Math.round(d.gapMs / 100) / 10 });
    case 'shortStroke':
      return t('editor.check.detail.short', { ms: d.ms, frame: d.frameMs });
    default:
      return '';
  }
}

/** Same points, same order, same values: nothing was edited since the check. */
function sameActions(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.at !== b[i]?.at || a[i]?.pos !== b[i]?.pos) return false;
  }
  return true;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Open the Check script dialog.
 *
 * @param {object} o
 * @param {Array<{at:number,pos:number}>} o.actions — the script to check (copied at open)
 * @param {{max?: number, min?: number, longGapMs?: number, frameMs?: number}} [o.limits]
 *   the editor's speed limits (ScriptEditor._speedLimits(): units/s, 0 =
 *   off), plus optional long-gap length and frame duration (ms; 0 / absent =
 *   no "shorter than one frame" check)
 * @param {(at: number) => void} [o.onJump] — move the playhead / view to `at` ms
 * @param {(indices: number[]) => void} [o.onSelect] — select exactly these points
 * @param {() => Array<{at:number,pos:number}>} [o.getActions] — the live
 *   points. When given, a click first checks nothing changed since the
 *   dialog opened (the pop-out can edit while it is open, FT-031): if
 *   something did, the dialog checks again and says so instead of selecting
 *   points by stale indices.
 * @returns {Promise<{action: 'jump'|'select', at?: number, indices: number[], kind: string}|null>}
 */
export function openScriptCheck({ actions, limits = {}, onJump, onSelect, getActions } = {}) {
  const opts = {
    maxSpeed: limits.max ?? limits.maxSpeed,
    minSpeed: limits.min ?? limits.minSpeed,
    longGapMs: limits.longGapMs,
    frameMs: limits.frameMs,
  };
  let snapshot = (Array.isArray(actions) ? actions : []).map((a) => ({ at: a?.at, pos: a?.pos }));

  return Modal.open({
    title: t('editor.check.title'),
    panelClass: 'script-check-panel',
    // Done, not the first "Select all": Enter on the dialog's first stop
    // must not change the selection by accident.
    initialFocus: (body) => body.querySelector('.script-check__done'),
    onRender(body, close) {
      const doc = body.ownerDocument;
      const root = el(doc, 'div', 'script-check');
      body.appendChild(root);

      const act = (result) => {
        if (typeof getActions === 'function') {
          const live = getActions();
          if (!sameActions(live, snapshot)) {
            snapshot = (Array.isArray(live) ? live : []).map((a) => ({ at: a?.at, pos: a?.pos }));
            render(true);
            // The clicked button is gone with the old list: keep the focus in the dialog.
            root.querySelector('.script-check__done')?.focus({ preventScroll: true });
            return;
          }
        }
        close(result);
        if (result.action === 'jump' && typeof onJump === 'function') onJump(result.at);
        if (typeof onSelect === 'function') onSelect(result.indices);
      };

      function render(changed = false) {
        root.replaceChildren();
        const report = checkScript(snapshot, opts);
        // The kinds' limits as checkScript used them (defaults filled in).
        const used = {
          maxSpeed: opts.maxSpeed ?? 400,
          minSpeed: opts.minSpeed ?? 33,
          longGapMs: opts.longGapMs ?? 10000,
        };

        const status = el(doc, 'p', 'script-check__status');
        status.setAttribute('role', 'status');
        if (changed) status.textContent = t('editor.check.changed');
        root.appendChild(status);

        if (report.points === 0 || report.total === 0) {
          // Empty state (§2.11): heading + hint.
          const empty = el(doc, 'div', 'script-check__empty');
          empty.appendChild(el(doc, 'p', 'script-check__empty-title',
            report.points === 0 ? t('editor.check.emptyTitle') : t('editor.check.allGood')));
          empty.appendChild(el(doc, 'p', 'script-check__empty-hint',
            report.points === 0 ? t('editor.check.emptyHint') : t('editor.check.allGoodHint', { count: report.points })));
          root.appendChild(empty);
        } else {
          root.appendChild(el(doc, 'p', 'script-check__summary', t('editor.check.summary', { count: report.total })));

          report.groups.forEach((group, g) => {
            const section = el(doc, 'section', 'script-check__group');
            section.dataset.kind = group.kind;
            const titleId = `script-check-${group.kind}-${g}`;
            section.setAttribute('aria-labelledby', titleId);

            const head = el(doc, 'div', 'script-check__group-head');
            const title = el(doc, 'h3', 'script-check__group-title');
            title.id = titleId;
            title.appendChild(el(doc, 'span', 'script-check__group-name', KIND_TITLE[group.kind]?.(used) ?? group.kind));
            title.appendChild(el(doc, 'span', 'script-check__count', String(group.findings.length)));
            head.appendChild(title);

            const all = groupIndices(group);
            const selectAll = el(doc, 'button', 'modal-btn modal-btn--secondary script-check__select-all',
              t('editor.check.selectAll', { count: all.length }));
            selectAll.type = 'button';
            selectAll.addEventListener('click', () => act({ action: 'select', indices: all, kind: group.kind }));
            head.appendChild(selectAll);
            section.appendChild(head);

            const hint = KIND_HINT[group.kind]?.();
            if (hint) section.appendChild(el(doc, 'p', 'script-check__hint', hint));

            const rows = el(doc, 'ul', 'script-check__rows');
            for (const f of group.findings.slice(0, ROW_LIMIT)) {
              const li = el(doc, 'li', 'script-check__row-item');
              const row = el(doc, 'button', 'script-check__row');
              row.type = 'button';
              row.appendChild(el(doc, 'span', 'script-check__time', formatCheckTime(f.at)));
              row.appendChild(el(doc, 'span', 'script-check__detail', findingText(f)));
              row.addEventListener('click', () => act({ action: 'jump', at: f.at, indices: [...f.indices], kind: group.kind }));
              li.appendChild(row);
              rows.appendChild(li);
            }
            section.appendChild(rows);
            const more = group.findings.length - ROW_LIMIT;
            if (more > 0) section.appendChild(el(doc, 'p', 'script-check__more', t('editor.check.more', { count: more })));
            root.appendChild(section);
          });
        }

        root.appendChild(el(doc, 'p', 'script-check__limits', t('editor.check.limitsHint')));

        const actionsBar = el(doc, 'div', 'modal-actions');
        const done = el(doc, 'button', 'modal-btn modal-btn--primary script-check__done', t('common.done'));
        done.type = 'button';
        done.addEventListener('click', () => close(null));
        actionsBar.appendChild(done);
        root.appendChild(actionsBar);
      }

      render(false);
    },
  });
}
