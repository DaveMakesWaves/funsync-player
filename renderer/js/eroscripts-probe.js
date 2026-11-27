// What a post offers, before you open it (Dave, 2026-11-23: "why wouldn't I
// be able to see this one has no video download available before clicking
// it", then "Why can't I filter by that?").
//
// The forum's lists carry no links, so each card's post is read once, in the
// background: ONE request (/t/{id}.json; its first page of replies comes
// with it, no extra request), the links classified by our own backend
// (local, no host is contacted). The answer: a downloadable video link? a
// script file? Cards say so on their Video / Script chips, and the tab's
// Download filter can hide the posts without one.
//
// Gentle on the forum: one post at a time, GAP_MS apart, a minute's pause
// after a "too many requests", and each answer remembered for CACHE_MS (in
// this browser's storage, so a restart does not ask again).

export const GAP_MS = 800;
export const BACKOFF_MS = 60000;
// After the login is confirmed good, a 401 / 403 on a post for this long is
// that post being closed to you, not the login: no new check each time.
export const LOGIN_TRUST_MS = 5 * 60 * 1000;
export const CACHE_MS = 12 * 60 * 60 * 1000;
// v2 (test day 2026-11-24): v1 answers came from a parser that missed a
// script linked as a plain upload (B002), so they are not reused.
// v3 (2026-11-24): a tube-site link counts apart (it downloads only with
// the Tube sites switch on); Gofile and Mega folders became downloads.
const CACHE_KEY = 'funsync.es.probe.v3';
const CACHE_MAX = 3000;

/**
 * What a post offers, from its topic answer and its links' classification.
 * `video`: a link this build can download. `script`: a .funscript (a .zip
 * pack counts as a script only as `pack`). `paid`: a shop link (Buy).
 */
export function summarisePost(answer, classified) {
  // A script in the replies counts too (a fixed v2 posted later, review 2.5).
  const attachments = [...(Array.isArray(answer?.attachments) ? answer.attachments : []), ...(Array.isArray(answer?.replyScripts) ? answer.replyScripts : [])];
  const names = attachments.map((a) => String(a?.name || '').toLowerCase());
  const list = Array.isArray(classified) ? classified : [];
  return {
    // A download this build can make; a tube site's only with the Tube switch on.
    video: list.some((c) => c && c.supported === true && c.kind !== 'tube'),
    tube: list.some((c) => c && c.supported === true && c.kind === 'tube'),
    script: names.some((n) => n.endsWith('.funscript')),
    pack: names.some((n) => n.endsWith('.zip')),
    paid: list.some((c) => c && c.kind === 'store'),
  };
}

/**
 * Does a post pass the Download filter ('any' | 'video' | 'script' | 'both')?
 * Unknown: shown. 'both' (Dave, 2026-11-25: "just being able to download both
 * no faf"): a video this build can download AND a script.
 */
export function passesNeed(info, need, { tube = false } = {}) {
  if (!info) return true; // not known yet: shown until the answer comes
  const video = info.video === true || (tube === true && info.tube === true);
  const script = info.script === true || info.pack === true;
  if (need === 'video') return video;
  if (need === 'script') return script;
  if (need === 'both') return video && script;
  return true;
}

export const NEEDS = Object.freeze(['any', 'video', 'script', 'both']);
export function normalizeNeed(v) { return NEEDS.includes(v) ? v : 'any'; }

function loadCache(storage, now) {
  try {
    const raw = storage?.getItem?.(CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const out = new Map();
    for (const [id, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && now - (v.at || 0) < CACHE_MS) out.set(id, v);
    }
    return out;
  } catch { return new Map(); }
}

/**
 * The queue. `fetchTopic(id)` answers the topic (as eroscriptsTopic does);
 * `classify(urls)` answers [{supported, kind}] in the same order. `onResult(id, info)`
 * after each answer. Timers and the clock are injectable for tests.
 */
export class PostProbe {
  constructor({ fetchTopic, classify, onResult, checkSession = null, storage = null, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
    this._fetchTopic = fetchTopic;
    // `checkSession()` answers 'valid' | 'expired' | 'loggedOut' | 'unknown'
    // (the panel's forced /session/current.json check, which also drops an
    // expired login with one toast). Asked after a 401 / 403 (B029).
    this._checkSession = checkSession;
    this._authHeld = false;    // stopped on an expired / absent login, until loginChanged(true)
    this._loginGoodUntil = 0;
    this._classify = classify;
    this._onResult = onResult || (() => {});
    this._storage = storage;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._known = loadCache(storage, now());
    this._queue = [];
    this._queued = new Set();
    this._timer = null;
    this._busy = false;
    this._paused = false;
    this._notBefore = 0;   // the next ask, not before (a 429 wait survives a pause)
  }

  /** What is known about a post: {video, script, pack, paid} or null. */
  get(id) {
    const v = this._known.get(String(id));
    return v ? { video: !!v.video, tube: !!v.tube, script: !!v.script, pack: !!v.pack, paid: !!v.paid } : null;
  }

  /** Ask about these posts (in order), once each; known ones are skipped. */
  enqueue(ids) {
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw);
      if (!id || this._known.has(id) || this._queued.has(id)) continue;
      this._queue.push(id);
      this._queued.add(id);
    }
    this._kick(0);
  }

  /** Forget the queue (a new list); what is known stays. */
  clearQueue() {
    this._queue = [];
    this._queued.clear();
  }

  get pending() { return this._queue.length + (this._busy ? 1 : 0); }

  /**
   * Stop asking while the tab is hidden (test day 2026-11-24: leaving the
   * tab kept reading posts); the queue is kept. resume() carries on, never
   * sooner than a wait already owed (a 429's minute).
   */
  pause() {
    this._paused = true;
    if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._kick(Math.max(0, this._notBefore - this._now()));
  }

  /**
   * Signed in: carry on (the posts held by an expired login are still
   * queued). Signed out: no card checks, the queue is kept (test day
   * 2026-11-24, B029).
   */
  loginChanged(loggedIn) {
    this._loginGoodUntil = 0;
    if (loggedIn) {
      this._authHeld = false;
      this._kick(Math.max(0, this._notBefore - this._now()));
    } else {
      this._authHeld = true;
      if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
    }
  }

  _kick(delay) {
    if (this._paused || this._authHeld || this._timer || this._busy || !this._queue.length) return;
    this._notBefore = Math.max(this._notBefore, this._now() + delay);
    this._timer = this._setTimer(() => { this._timer = null; this._next(); }, Math.max(0, this._notBefore - this._now()));
  }

  async _next() {
    if (this._paused || this._authHeld) return;
    const id = this._queue.shift();
    if (!id) return;
    this._busy = true;
    let wait = GAP_MS;
    try {
      const answer = await this._fetchTopic(id);
      if (answer?.errorCode === 'rateLimited') {
        // Too many requests: put it back and wait a minute.
        this._queue.unshift(id);
        wait = BACKOFF_MS;
      } else if (answer?.authExpired) {
        // 401 / 403 (B029). Going on to the next post asked the forum every
        // 0.8 s with a dead login and said nothing. Stop and ask whether
        // the login is good; the post goes back on the queue meanwhile.
        if (this._now() < this._loginGoodUntil) {
          this._queued.delete(id);           // the login is fine: this post is closed to you
        } else {
          this._queue.unshift(id);
          this._authHeld = true;
          let state = 'unknown';
          try { state = (await this._checkSession?.()) || 'unknown'; } catch { state = 'unknown'; }
          if (state === 'valid') {
            this._authHeld = false;
            this._loginGoodUntil = this._now() + LOGIN_TRUST_MS;
            const at = this._queue.indexOf(id);
            if (at >= 0) this._queue.splice(at, 1);
            this._queued.delete(id);
          } else if (state === 'unknown') {
            this._authHeld = false;           // could not tell (network): the same post in a minute
            wait = BACKOFF_MS;
          }
          // 'expired' / 'loggedOut': held, queue kept, until loginChanged(true).
        }
      } else if (answer && !answer.error) {
        const urls = [...(answer.links || []), ...(answer.replyLinks || [])].map((l) => l.url).filter(Boolean);
        let classified = [];
        if (urls.length) {
          try { classified = (await this._classify(urls)) || []; } catch { classified = []; }
        }
        const info = summarisePost(answer, classified);
        this._known.set(id, { ...info, at: this._now() });
        this._save();
        this._queued.delete(id);
        try { this._onResult(id, info); } catch { /* the view's repaint */ }
      } else {
        this._queued.delete(id); // a post that failed stays unknown (shown); not retried this session
      }
    } catch {
      this._queued.delete(id);
    } finally {
      this._busy = false;
      this._kick(wait);
    }
  }

  _save() {
    if (!this._storage?.setItem) return;
    try {
      const entries = [...this._known.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, CACHE_MAX);
      this._storage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* storage full or blocked: the session still remembers */ }
  }
}
