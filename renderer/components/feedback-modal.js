// FeedbackModal — in-app "Report a problem" dialog.
//
// UX is modelled on Signal Desktop's debug-log viewer + VS Code's Issue
// Reporter + Intiface Central's "Send Logs To Developers" button —
// shows the user EXACTLY what will be sent before they click anything.
// Nielsen #1 visibility, Shneiderman #3 informative feedback, Shneiderman
// #6 reversibility (the user can edit any field — including the
// diagnostics — before any button fires).
//
// Send paths (Shneiderman #7 user control — multiple exits):
//   - Open GitHub Issue   → composes a prefilled new-issue URL via
//                           shell.openExternal. URL truncated to 7500
//                           chars (GitHub's URL cap is ~8 KB). Full
//                           report is also copied to clipboard so
//                           nothing is lost on truncation.
//   - Copy to clipboard   → for users without a GitHub account, or who
//                           prefer to file via Discord / forum.
//   - Save to file        → for users who want to attach the report
//                           manually (logs longer than 8 KB go this way).
//
// The diagnostics text is read by the developer in English regardless
// of UI locale — the LABELS that frame it are translated.

import { Modal } from './modal.js';
import { showToast } from '../js/toast.js';
import { t } from '../js/i18n.js';
import { eventBus } from '../js/event-bus.js';

const REPO = 'DaveMakesWaves/funsync-player';
const ISSUE_URL_BUDGET = 7500;
const LOG_TAIL_LINES = 80;

/**
 * Format the diagnostics object into the plain-text block users see in
 * the preview AND that gets attached to GitHub Issues / copied / saved.
 * Pure — exported for unit tests.
 *
 * @param {Object} d — return value of window.funsync.collectDiagnostics()
 * @returns {string}
 */
export function formatDiagnostics(d) {
  if (!d || typeof d !== 'object') return '(no diagnostics)';
  const lines = [];
  const app = d.app || {};
  const platform = d.platform || {};
  const runtime = d.runtime || {};
  const backend = d.backend || {};
  const devices = d.devices || {};
  lines.push(`${app.name || 'FunSync Player'} ${app.version || '?'}`);
  lines.push(`OS: ${platform.os || '?'} ${platform.release || ''} (${platform.arch || '?'})`);
  lines.push(`Electron: ${runtime.electron || '?'}  Chrome: ${runtime.chrome || '?'}  Node: ${runtime.node || '?'}`);
  lines.push(`Backend: ${backend.running ? 'running' : 'not running'} (port ${backend.port || '?'})`);
  lines.push(
    'Devices: ' +
    `Handy=${devices.handy ? 'connected' : 'no'}  ` +
    `Buttplug=${devices.buttplug ? 'connected' : 'no'}  ` +
    `VR=${devices.vr ? 'connected' : 'no'}  ` +
    `count=${devices.deviceCount || 0}`,
  );
  lines.push('');
  lines.push(`Recent log (last ${LOG_TAIL_LINES} lines):`);
  lines.push(d.logTail || '(no log available)');
  return lines.join('\n');
}

/**
 * Compose the final body string sent to GitHub / clipboard / file.
 * Pure — exported for unit tests.
 */
export function composeBody({ description, steps, diagnostics }) {
  const parts = [];
  parts.push('### What happened?');
  parts.push((description || '').trim() || '_(no description)_');
  if ((steps || '').trim()) {
    parts.push('');
    parts.push('### Steps to reproduce');
    parts.push(steps.trim());
  }
  parts.push('');
  parts.push('### Diagnostics');
  parts.push('```');
  parts.push(diagnostics || '');
  parts.push('```');
  return parts.join('\n');
}

/**
 * Build the GitHub new-issue URL. If the URL would overflow
 * ISSUE_URL_BUDGET, the diagnostics block is truncated from the FRONT
 * (oldest log lines drop first; the recent ones near the error matter
 * more) and a marker line is prepended pointing the dev at the full
 * clipboard payload.
 *
 * Pure — exported for unit tests.
 *
 * @param {Object} args
 * @param {string} args.title
 * @param {string} args.description
 * @param {string} args.steps
 * @param {string} args.diagnostics
 * @returns {{ url: string, truncated: boolean }}
 */
export function buildIssueUrl({ title, description, steps, diagnostics }) {
  const baseParams = new URLSearchParams();
  // Intentionally NOT setting `template=bug_report.yml` — GitHub looks
  // that file up on the default branch and returns a 500 page to logged-
  // in users when it can't find it. Our body already renders structured
  // because it ships with `### What happened?` / `### Diagnostics` H3s.
  // The template file lives in .github/ISSUE_TEMPLATE/ for users who
  // file issues manually via the repo's "New Issue" button.
  //
  // `labels` only accepts label names that exist on the repo. `bug` is
  // a GitHub default so it survives even on a brand-new repo; custom
  // names (e.g. `user-report`) silently fail or compound the 500. Keep
  // it minimal — add more once they're created on the repo.
  baseParams.set('labels', 'bug');
  baseParams.set('title', (title || '').slice(0, 200));

  const base = `https://github.com/${REPO}/issues/new?`;
  // Compose with full diagnostics first.
  const fullBody = composeBody({ description, steps, diagnostics });
  baseParams.set('body', fullBody);
  let url = base + baseParams.toString();
  if (url.length <= ISSUE_URL_BUDGET) {
    return { url, truncated: false };
  }
  // Compute headroom for diagnostics by stripping it out of the body.
  baseParams.set('body', composeBody({ description, steps, diagnostics: '' }));
  const overhead = (base + baseParams.toString()).length;
  // Each non-ASCII char encodes to ~3 bytes (%XX). Be conservative.
  const allowedDiagBytes = Math.max(0, ISSUE_URL_BUDGET - overhead - 200);
  const allowedDiagChars = Math.floor(allowedDiagBytes / 3);
  const truncatedDiagnostics =
    '(diagnostics truncated — full report copied to clipboard)\n' +
    diagnostics.slice(-allowedDiagChars);
  baseParams.set('body', composeBody({ description, steps, diagnostics: truncatedDiagnostics }));
  url = base + baseParams.toString();
  return { url, truncated: true };
}

/**
 * Open the FunSync feedback modal.
 *
 * @param {Object} args
 * @param {() => Object} args.getConnectionState — returns
 *   { handyConnected, buttplugConnected, vrConnected, deviceCount }
 *   so the dialog can pass it to the main process. Renderer-side because
 *   device managers live in the renderer.
 * @returns {Promise<void>}
 */
export async function openFeedbackModal({ getConnectionState }) {
  let unsubscribeLang = null;
  // Local state preserved across language-rebuild.
  const state = { title: '', description: '', steps: '', diagnostics: '' };

  await Modal.open({
    title: t('feedback.title'),
    onRender: (body, close) => {
      renderInto(body, close, state, getConnectionState);
      // Re-render on locale change so the labels/buttons refresh while
      // the user's typed input survives. Same pattern as settings-panel.
      unsubscribeLang = eventBus.on('language:changed', () => {
        const panel = body.closest('.modal-panel');
        const titleEl = panel?.querySelector('.modal-title');
        if (titleEl) titleEl.textContent = t('feedback.title');
        const closeBtn = panel?.querySelector('.modal-close-btn');
        if (closeBtn) {
          closeBtn.setAttribute('aria-label', t('modal.closeAria', { title: t('feedback.title') }));
          closeBtn.title = t('common.close');
        }
        renderInto(body, close, state, getConnectionState);
      });
    },
  });
  if (unsubscribeLang) unsubscribeLang();
}

function renderInto(body, close, state, getConnectionState) {
  // Capture in-flight edits before wiping the DOM.
  const liveTitle = body.querySelector('#fb-title');
  const liveDesc = body.querySelector('#fb-desc');
  const liveSteps = body.querySelector('#fb-steps');
  const liveDiag = body.querySelector('#fb-diag');
  if (liveTitle) state.title = liveTitle.value;
  if (liveDesc) state.description = liveDesc.value;
  if (liveSteps) state.steps = liveSteps.value;
  if (liveDiag) state.diagnostics = liveDiag.value;

  body.innerHTML = '';
  body.classList.add('feedback-modal');

  const intro = document.createElement('p');
  intro.className = 'feedback-modal__intro';
  intro.textContent = t('feedback.intro');
  body.appendChild(intro);

  body.appendChild(buildField({
    id: 'fb-title',
    label: t('feedback.titleLabel'),
    placeholder: t('feedback.titlePlaceholder'),
    value: state.title,
    type: 'input',
  }));

  body.appendChild(buildField({
    id: 'fb-desc',
    label: t('feedback.descriptionLabel'),
    placeholder: t('feedback.descriptionPlaceholder'),
    value: state.description,
    type: 'textarea',
    rows: 4,
  }));

  body.appendChild(buildField({
    id: 'fb-steps',
    label: t('feedback.stepsLabel'),
    placeholder: t('feedback.stepsPlaceholder'),
    value: state.steps,
    type: 'textarea',
    rows: 3,
  }));

  const diagField = buildField({
    id: 'fb-diag',
    label: t('feedback.diagnosticsLabel'),
    placeholder: '',
    value: state.diagnostics || t('feedback.loadingDiagnostics'),
    type: 'textarea',
    rows: 10,
    monospace: true,
    hint: t('feedback.diagnosticsHint'),
  });
  body.appendChild(diagField);

  // Lazy-load diagnostics on first render — keeps the modal snappy.
  if (!state.diagnostics) {
    (async () => {
      try {
        const rendererState = getConnectionState?.() || {};
        const d = await window.funsync.collectDiagnostics(rendererState);
        state.diagnostics = formatDiagnostics(d);
        const el = body.querySelector('#fb-diag');
        if (el) el.value = state.diagnostics;
      } catch (err) {
        state.diagnostics = `(diagnostics failed: ${err?.message || err})`;
        const el = body.querySelector('#fb-diag');
        if (el) el.value = state.diagnostics;
      }
    })();
  }

  const privacy = document.createElement('p');
  privacy.className = 'feedback-modal__privacy';
  privacy.textContent = t('feedback.privacyNote');
  body.appendChild(privacy);

  // Action row. Cancel first (matches existing modal-actions convention),
  // then secondary outputs (Save, Copy), then primary (GitHub) at the
  // right edge — Fitts: primary action gets the largest weight and the
  // right-hand "commit" position users expect (Shneiderman #1 consistency).
  const actions = document.createElement('div');
  actions.className = 'feedback-modal__actions';

  const readState = () => ({
    title: body.querySelector('#fb-title')?.value?.trim() || '',
    description: body.querySelector('#fb-desc')?.value?.trim() || '',
    steps: body.querySelector('#fb-steps')?.value?.trim() || '',
    diagnostics: body.querySelector('#fb-diag')?.value || '',
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn modal-btn--secondary';
  cancelBtn.textContent = t('feedback.cancel');
  cancelBtn.addEventListener('click', () => close());
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn modal-btn--secondary';
  saveBtn.textContent = t('feedback.saveFile');
  saveBtn.addEventListener('click', async () => {
    const s = readState();
    const content = `Title: ${s.title || '(none)'}\n\n` + composeBody(s);
    try {
      const result = await window.funsync.saveFile?.({
        defaultPath: t('feedback.saveDialogDefaultName'),
        title: t('feedback.saveDialogTitle'),
        content,
      });
      if (result?.success) showToast(t('feedback.savedToast', { path: result.path }), 'info');
      else if (result?.cancelled) showToast(t('feedback.saveCancelled'), 'info');
      else showToast(t('feedback.saveFailed'), 'error');
    } catch {
      showToast(t('feedback.saveFailed'), 'error');
    }
  });
  actions.appendChild(saveBtn);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'modal-btn modal-btn--secondary';
  copyBtn.textContent = t('feedback.copy');
  copyBtn.addEventListener('click', async () => {
    const s = readState();
    const content = `Title: ${s.title || '(none)'}\n\n` + composeBody(s);
    try {
      await navigator.clipboard.writeText(content);
      showToast(t('feedback.copiedToast'), 'info');
    } catch {
      showToast(t('feedback.copyFailed'), 'error');
    }
  });
  actions.appendChild(copyBtn);

  const githubBtn = document.createElement('button');
  githubBtn.className = 'modal-btn modal-btn--primary';
  githubBtn.textContent = t('feedback.openGithub');
  githubBtn.addEventListener('click', async () => {
    const s = readState();
    if (!s.title) {
      showToast(t('feedback.titleRequired'), 'warn');
      body.querySelector('#fb-title')?.focus();
      return;
    }
    const { url } = buildIssueUrl(s);
    // Always copy full payload to clipboard before opening — covers
    // truncation AND covers the "browser failed to open" failure path.
    const fullContent = `Title: ${s.title}\n\n` + composeBody(s);
    try { await navigator.clipboard.writeText(fullContent); } catch { /* ignore */ }
    try {
      await window.funsync.openExternal(url);
      showToast(t('feedback.githubOpened'), 'info');
      close();
    } catch {
      showToast(t('feedback.githubOpenFailed'), 'error', 8000);
    }
  });
  actions.appendChild(githubBtn);

  body.appendChild(actions);
}

function buildField({ id, label, placeholder, value, type, rows, monospace, hint }) {
  const wrap = document.createElement('div');
  wrap.className = 'feedback-modal__field';

  const labelEl = document.createElement('label');
  labelEl.className = 'feedback-modal__label';
  labelEl.setAttribute('for', id);
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  let input;
  if (type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = rows || 3;
  } else {
    input = document.createElement('input');
    input.type = 'text';
  }
  input.id = id;
  input.className = 'feedback-modal__input' + (monospace ? ' feedback-modal__input--mono' : '');
  input.placeholder = placeholder || '';
  input.value = value || '';
  wrap.appendChild(input);

  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'feedback-modal__hint';
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }
  return wrap;
}
