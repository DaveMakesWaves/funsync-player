// ScriptPlayerBar — the bar along the bottom of the window while the script
// player plays (v0.10.1, renderer/js/script-player.js). On every view: play /
// pause, the name, a moving stroke graph (Dave: "a thinner more stylized
// version of the script timeline": the strokes around the playhead in the
// timeline's speed colours, scrolling past a centre line, with the position
// now), a thin seek strip over the script's heat strip under it, the position
// and time, Loop (off by default), which devices follow it, and ✕, which stops
// the script and gives the devices back to the open video.
//
// The graph draws on animation frames only while the script plays and the bar
// is shown, and once on a seek or a pause. The time and the seek position are
// written 4 times a second, and only when they change.

import { t } from '../js/i18n.js';
import { icon, Play, Pause, Repeat, X } from '../js/icons.js';
import { computeBins, renderBins } from '../js/heatmap-strip.js';
import { ActionGraph } from '../js/action-graph.js';

/** How much of the script the graph shows each side of the playhead (ms). */
export const GRAPH_HALF_MS = 5000;

/**
 * Index range of the actions that touch [from, to], one either side included
 * so the lines run off the edges. Binary search; pure.
 * @param {{ at: number }[]} actions sorted by time
 * @returns {[number, number]} [first, last] inclusive, or [0, -1] for none
 */
export function actionWindow(actions, from, to) {
  const n = actions?.length || 0;
  if (!n) return [0, -1];
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (actions[mid].at < from) lo = mid + 1; else hi = mid; }
  const first = Math.max(0, lo - 1);
  lo = first; hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (actions[mid].at > to) hi = mid - 1; else lo = mid; }
  const last = Math.min(n - 1, lo + 1);
  return [first, last];
}

/** The position (0-100) at `t` ms, linear between actions. Pure. */
export function positionAt(actions, t) {
  const n = actions?.length || 0;
  if (!n) return null;
  if (t <= actions[0].at) return actions[0].pos;
  if (t >= actions[n - 1].at) return actions[n - 1].pos;
  const [i] = actionWindow(actions, t, t);
  for (let k = i; k < n - 1; k++) {
    const a = actions[k], b = actions[k + 1];
    if (t <= b.at) return a.pos + (b.pos - a.pos) * ((t - a.at) / Math.max(1, b.at - a.at));
  }
  return actions[n - 1].pos;
}

/** m:ss, or h:mm:ss past an hour. Pure. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class ScriptPlayerBar {
  /**
   * @param {object} opts
   * @param {import('../js/script-player.js').ScriptPlayer} opts.scriptPlayer
   * @param {() => void} opts.onClose ✕: stop and give the devices back
   * @param {HTMLElement} [opts.parent]
   */
  constructor({ scriptPlayer, onClose, parent = null }) {
    this.sp = scriptPlayer;
    this.onClose = onClose;
    this._timer = null;
    this._seeking = false;
    this._shownTime = null;
    this._shownSeek = null;
    this._stripFor = null;
    this._build(parent || document.getElementById('app') || document.body);
  }

  _build(parent) {
    const el = document.createElement('div');
    el.className = 'script-bar';
    el.setAttribute('role', 'region');
    el.hidden = true;
    el.innerHTML = `
      <button type="button" class="script-bar__btn script-bar__play"></button>
      <div class="script-bar__label">
        <div class="script-bar__name"></div>
        <span class="script-bar__devices"></span>
      </div>
      <div class="script-bar__track">
        <canvas class="script-bar__graph" aria-hidden="true"></canvas>
        <div class="script-bar__strip">
          <canvas class="script-bar__heat" aria-hidden="true"></canvas>
          <input type="range" class="script-bar__seek" min="0" max="1000" step="1" value="0">
        </div>
      </div>
      <div class="script-bar__readout">
        <span class="script-bar__pos"></span>
        <span class="script-bar__time"></span>
      </div>
      <button type="button" class="script-bar__btn script-bar__loop" aria-pressed="false"></button>
      <button type="button" class="script-bar__btn script-bar__close"></button>
    `;
    this.el = el;
    this._play = el.querySelector('.script-bar__play');
    this._name = el.querySelector('.script-bar__name');
    this._heat = el.querySelector('.script-bar__heat');
    this._graph = el.querySelector('.script-bar__graph');
    this._pos = el.querySelector('.script-bar__pos');
    this._raf = null;
    this._seek = el.querySelector('.script-bar__seek');
    this._time = el.querySelector('.script-bar__time');
    this._loop = el.querySelector('.script-bar__loop');
    this._devices = el.querySelector('.script-bar__devices');
    this._close = el.querySelector('.script-bar__close');
    this._loop.appendChild(icon(Repeat, { width: 16, height: 16 }));
    this._close.appendChild(icon(X, { width: 16, height: 16 }));

    this._play.addEventListener('click', () => { this.sp.toggle(); });
    this._loop.addEventListener('click', () => { this.sp.setLoop(!this.sp.state.loop); });
    this._close.addEventListener('click', () => { this.onClose?.(); });
    this._seek.addEventListener('input', () => { this._seeking = true; this._paintTime(this._seekSeconds()); });
    this._seek.addEventListener('change', () => {
      this._seeking = false;
      this.sp.seek(this._seekSeconds());
      this._tick();
      this._drawGraph();
    });
    parent.appendChild(el);
    this.retranslate();
  }

  _seekSeconds() {
    const d = this.sp.state.duration || 0;
    return (Number(this._seek.value) / 1000) * d;
  }

  /** Labels in the current language (also after a language change). */
  retranslate() {
    this.el.setAttribute('aria-label', t('scriptPlayer.barAria'));
    this._seek.setAttribute('aria-label', t('scriptPlayer.seekAria'));
    this._loop.title = t('scriptPlayer.loop');
    this._loop.setAttribute('aria-label', t('scriptPlayer.loop'));
    this._close.title = t('scriptPlayer.close');
    this._close.setAttribute('aria-label', t('scriptPlayer.close'));
    this.update(this.sp.state);
  }

  /** @param {ReturnType<import('../js/script-player.js').ScriptPlayer['state']>} state */
  update(state) {
    const on = !!state?.active;
    this.el.hidden = !on;
    document.documentElement.classList.toggle('has-script-bar', on);
    if (!on) { this._stopTimer(); this._stopGraph(); this._stripFor = null; return; }

    const paused = state.paused !== false;
    this._play.replaceChildren(icon(paused ? Play : Pause, { width: 18, height: 18 }));
    const playLabel = paused ? t('scriptPlayer.play') : t('scriptPlayer.pause');
    this._play.title = playLabel;
    this._play.setAttribute('aria-label', playLabel);
    this._name.textContent = (state.name || '').replace(/\.funscript$/i, '');
    this._name.title = state.path || state.name || '';
    this._loop.setAttribute('aria-pressed', state.loop ? 'true' : 'false');
    this._loop.classList.toggle('script-bar__loop--on', !!state.loop);
    this._devices.textContent = state.devices?.length ? t('scriptPlayer.devicesOn') : t('scriptPlayer.noDevices');
    this._devices.classList.toggle('script-bar__devices--none', !state.devices?.length);

    const key = `${state.path || ''}|${state.name || ''}|${state.duration || 0}`;
    if (key !== this._stripFor && state.duration > 0) {
      this._stripFor = key;
      const actions = this.sp.engine?.getActions?.() || [];
      try { renderBins(this._heat, computeBins(actions, 200)); } catch { /* no canvas (jsdom) */ }
    }
    this._tick();
    this._drawGraph();
    if (paused) { this._stopTimer(); this._stopGraph(); } else { this._startTimer(); this._startGraph(); }
  }

  /**
   * The strokes around the playhead: the timeline's speed colours on a thin
   * line with a dark edge, a dot per action, a faint centre line at 50, the
   * playhead in the middle and the position now on it.
   */
  _drawGraph() {
    const canvas = this._graph;
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return;
    const cssW = canvas.clientWidth || 0;
    const cssH = canvas.clientHeight || 0;
    if (!cssW || !cssH) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const st = this.sp.state;
    const actions = this.sp.engine?.getActions?.() || [];
    const t = st.time * 1000;
    const from = t - GRAPH_HALF_MS, to = t + GRAPH_HALF_MS;
    const pad = 4;
    const x = (ms) => ((ms - from) / (to - from)) * cssW;
    const y = (pos) => pad + (1 - pos / 100) * (cssH - pad * 2);

    // The 50 line, faint.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(50)); ctx.lineTo(cssW, y(50)); ctx.stroke();

    const [first, last] = actionWindow(actions, from, to);
    for (let i = first; i < last; i++) {
      const a = actions[i], b = actions[i + 1];
      const dt = b.at - a.at;
      const speed = dt > 0 ? Math.abs(b.pos - a.pos) / dt : 0;
      ctx.beginPath();
      ctx.moveTo(x(a.at), y(a.pos));
      ctx.lineTo(x(b.at), y(b.pos));
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = ActionGraph.speedToColor(speed);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    for (let i = first; i <= last; i++) {
      const a = actions[i];
      ctx.beginPath(); ctx.arc(x(a.at), y(a.pos), 1.6, 0, Math.PI * 2); ctx.fill();
    }

    // The playhead, and where the script is now.
    const cx = cssW / 2;
    const accent = (typeof getComputedStyle === 'function' && getComputedStyle(this.el).getPropertyValue('--accent').trim()) || '#e94560';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, cssH); ctx.stroke();
    const now = positionAt(actions, t);
    if (now != null) {
      ctx.beginPath(); ctx.arc(cx, y(now), 4, 0, Math.PI * 2);
      ctx.fillStyle = accent; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
      const pct = `${Math.round(now)}%`;
      if (pct !== this._shownPos) { this._pos.textContent = pct; this._shownPos = pct; }
    }
  }

  _startGraph() {
    if (this._raf || typeof requestAnimationFrame !== 'function') return;
    const loop = () => {
      this._raf = null;
      if (this.el.hidden || this.sp.state.paused) return;
      this._drawGraph();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopGraph() {
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _paintTime(seconds) {
    const d = this.sp.state.duration || 0;
    const text = `${formatClock(seconds)} / ${formatClock(d)}`;
    if (text !== this._shownTime) { this._time.textContent = text; this._shownTime = text; }
  }

  _tick() {
    const st = this.sp.state;
    if (!st.active) return;
    if (!this._seeking) {
      this._paintTime(st.time);
      const v = st.duration > 0 ? String(Math.round((st.time / st.duration) * 1000)) : '0';
      if (v !== this._shownSeek) { this._seek.value = v; this._shownSeek = v; }
    }
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 250);
  }

  _stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}
