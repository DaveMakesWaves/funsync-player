// SessionCard — bottom-right status card for active external-controller
// sessions (Web Remote phone, VR headset). Binds to a SessionTracker and
// re-renders on every `change` event.
//
// States:
//   - No active session → card hidden entirely.
//   - Session active + open      → full card visible.
//   - Session active + minimised → thin tab at the right edge with a status
//     dot; click the tab to expand.
//
// Auto-minimises when the script editor opens; restores to the previous
// state when the editor closes.

const STATE_LABEL = {
  idle:       'Connected, idle',
  preparing:  'Preparing devices…',
  playing:    'Playing',
  paused:     'Paused',
  'no-script':'No script for this video',
  error:      'Error',
};

const SOURCE_LABEL = {
  'web-remote': 'Web Remote',
  'vr':         'VR Companion',
};

export class SessionCard {
  /**
   * @param {object} opts
   * @param {import('../js/session-tracker.js').SessionTracker} opts.tracker
   * @param {() => void} opts.onOpenHistory  — user clicked the history icon
   */
  constructor({ tracker, onOpenHistory } = {}) {
    this._tracker = tracker;
    this._onOpenHistory = onOpenHistory || (() => {});
    this._el = null;
    this._open = true;          // user's preferred state; may be forced minimised by editor
    this._editorForcedMin = false;
    this._bound = (e) => this._render(e);
    this._historyBound = (e) => this._render(e);
  }

  mount(container) {
    this._el = document.createElement('div');
    this._el.className = 'session-card';
    this._el.hidden = true;
    container.appendChild(this._el);

    this._tracker.addEventListener('change', this._bound);
    this._tracker.addEventListener('history-changed', this._historyBound);
    this._render();
  }

  destroy() {
    this._tracker.removeEventListener('change', this._bound);
    this._tracker.removeEventListener('history-changed', this._historyBound);
    if (this._el && this._el.parentElement) this._el.parentElement.removeChild(this._el);
    this._el = null;
  }

  /** Force the card into minimised state (used when the script editor opens). */
  forceMinimised(on) {
    this._editorForcedMin = !!on;
    this._render();
  }

  // --- Rendering ---------------------------------------------------------

  _render() {
    if (!this._el) return;
    const session = this._tracker.getSession();
    if (!session) {
      this._el.hidden = true;
      this._el.innerHTML = '';
      return;
    }
    this._el.hidden = false;

    const minimised = this._editorForcedMin || !this._open;
    this._el.classList.toggle('session-card--minimised', minimised);

    if (minimised) {
      this._renderMinimised(session);
    } else {
      this._renderOpen(session);
    }
  }

  _renderMinimised(session) {
    const dot = dotClass(session.state);
    this._el.innerHTML = `
      <button class="session-card__tab" type="button" aria-label="Show session card">
        <span class="session-card__dot ${dot}"></span>
        <span class="session-card__tab-arrow">‹</span>
      </button>
    `;
    this._el.querySelector('.session-card__tab').addEventListener('click', () => {
      this._open = true;
      this._editorForcedMin = false; // user override — editor-force also cleared
      this._render();
    });
  }

  _renderOpen(session) {
    const dot = dotClass(session.state);
    const stateLabel = STATE_LABEL[session.state] || session.state;
    const source = SOURCE_LABEL[session.source] || session.source;
    const pct = session.duration > 0
      ? Math.max(0, Math.min(1, session.currentTime / session.duration)) * 100
      : 0;
    const curTime = formatTime(session.currentTime);
    const total = session.duration > 0 ? formatTime(session.duration) : '—:—';

    const devices = session.devices || {};
    const deviceRow = [
      ['Handy', devices.handy], ['Buttplug', devices.buttplug],
      ['TCode', devices.tcode], ['Autoblow', devices.autoblow],
    ]
      .filter(([, on]) => on !== undefined)
      .map(([name, on]) =>
        `<span class="session-card__device ${on ? 'session-card__device--on' : 'session-card__device--off'}">${name}</span>`)
      .join('');

    this._el.innerHTML = `
      <div class="session-card__header">
        <span class="session-card__dot ${dot}"></span>
        <span class="session-card__source">${escapeHtml(source)}</span>
        <span class="session-card__id">${escapeHtml(session.identifier || '')}</span>
        <button class="session-card__btn session-card__btn--history" type="button" title="Session history" aria-label="Session history">⏱</button>
        <button class="session-card__btn session-card__btn--min" type="button" title="Minimise" aria-label="Minimise">›</button>
      </div>
      <div class="session-card__state">${escapeHtml(stateLabel)}</div>
      ${session.videoName ? `<div class="session-card__video" title="${escapeHtml(session.videoName)}">${escapeHtml(session.videoName)}</div>` : ''}
      <div class="session-card__progress">
        <div class="session-card__progress-bar" style="width:${pct.toFixed(2)}%"></div>
      </div>
      <div class="session-card__meta">
        <span>${curTime} / ${total}</span>
        ${session.actionCount ? `<span>${session.actionCount} actions</span>` : ''}
      </div>
      ${deviceRow ? `<div class="session-card__devices">${deviceRow}</div>` : ''}
    `;

    this._el.querySelector('.session-card__btn--history').addEventListener('click', (e) => {
      e.stopPropagation();
      this._onOpenHistory();
    });
    this._el.querySelector('.session-card__btn--min').addEventListener('click', (e) => {
      e.stopPropagation();
      this._open = false;
      this._render();
    });
  }
}

function dotClass(state) {
  switch (state) {
    case 'playing':    return 'session-card__dot--green';
    case 'paused':     return 'session-card__dot--yellow';
    case 'preparing':  return 'session-card__dot--amber';
    case 'no-script':  return 'session-card__dot--amber';
    case 'error':      return 'session-card__dot--red';
    case 'idle':
    default:           return 'session-card__dot--blue';
  }
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
