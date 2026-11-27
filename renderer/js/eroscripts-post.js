// Reading an EroScripts post inside the tab's download window (the
// first-use review, 2026-11-23; Dave picked 2.1-2.5): the post's own text and
// images, what the script is like, whether its length fits the video, who
// posted each link and script, and the fixed scripts in the replies.
//
// Pure helpers; the window (components/eroscripts-view.js) draws them.

import { metaDurationSeconds, clockText } from './stream-session.js';

const FORUM = 'https://discuss.eroscripts.com';

// ---------------------------------------------------------------------------
// 2.1 The post, sanitised
// ---------------------------------------------------------------------------

/** Elements kept as themselves (no attributes ever copied). */
const KEEP = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'CODE', 'PRE', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'HR', 'SUB', 'SUP', 'SMALL', 'MARK', 'KBD', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DETAILS', 'SUMMARY']);
/** Elements dropped with everything inside them. */
const DROP = new Set(['SCRIPT', 'STYLE', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
  'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'LINK', 'META', 'HEAD', 'TITLE', 'CANVAS', 'AUDIO', 'SOURCE', 'TRACK', 'MAP']);
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
export const MAX_POST_IMAGES = 30;

/**
 * Discourse writes an emoji as an image named by its shortcode (:fire:).
 * The ones script posts use most, as characters; any other is left out (its
 * ":name:" text read badly, Dave's sandbox 2026-11-23).
 */
const EMOJI = {
  fire: '🔥', clock: '🕐', movie_camera: '🎥', video_camera: '📹', film_strip: '🎞️', film_frames: '🎞️', framed_picture: '🖼️',
  file_folder: '📁', open_file_folder: '📂', link: '🔗', paperclip: '📎', floppy_disk: '💾', cd: '💿', dvd: '📀', page_facing_up: '📄',
  memo: '📝', pencil2: '✏️', scroll: '📜', bookmark: '🔖', label: '🏷️', calendar: '📅', hourglass: '⌛', stopwatch: '⏱️',
  timer_clock: '⏲️', alarm_clock: '⏰', warning: '⚠️', information_source: 'ℹ️', question: '❓', exclamation: '❗', bangbang: '‼️',
  heavy_check_mark: '✔️', white_check_mark: '✅', x: '❌', no_entry: '⛔', no_entry_sign: '🚫', heavy_plus_sign: '➕', new: '🆕', free: '🆓',
  point_right: '👉', point_down: '👇', point_left: '👈', point_up: '☝️', arrow_down: '⬇️', arrow_right: '➡️', arrow_forward: '▶️',
  heart: '❤️', purple_heart: '💜', blue_heart: '💙', green_heart: '💚', yellow_heart: '💛', black_heart: '🖤', white_heart: '🤍',
  sparkling_heart: '💖', heart_eyes: '😍', smile: '😄', slight_smile: '🙂', slightly_smiling_face: '🙂', grin: '😁', grinning: '😀',
  joy: '😂', rofl: '🤣', sweat_smile: '😅', wink: '😉', smirk: '😏', blush: '😊', kissing_heart: '😘', thinking: '🤔', eyes: '👀',
  star: '⭐', star2: '🌟', sparkles: '✨', tada: '🎉', gift: '🎁', 100: '💯', rocket: '🚀', zap: '⚡', boom: '💥', crown: '👑', gem: '💎',
  '+1': '👍', thumbsup: '👍', '-1': '👎', ok_hand: '👌', pray: '🙏', clap: '👏', muscle: '💪', raised_hands: '🙌', wave: '👋',
  peach: '🍑', eggplant: '🍆', sweat_drops: '💦', droplet: '💧', lips: '👄', tongue: '👅', kiss: '💋',
  musical_note: '🎵', notes: '🎶', headphones: '🎧', video_game: '🎮', joystick: '🕹️', tv: '📺', computer: '💻', iphone: '📱',
  moneybag: '💰', dollar: '💵', lock: '🔒', unlock: '🔓', key: '🔑', bell: '🔔', bulb: '💡', gear: '⚙️', wrench: '🔧',
  hammer_and_wrench: '🛠️', construction: '🚧', robot: '🤖', red_circle: '🔴', green_circle: '🟢', yellow_circle: '🟡',
  large_blue_circle: '🔵', blue_circle: '🔵', chart_with_upwards_trend: '📈', bar_chart: '📊', mag: '🔍', speech_balloon: '💬',
};

/** An emoji image's character (from its :shortcode:), or '' when not one we know. */
export function emojiText(alt) {
  // ":thumbsup:t2:" is a skin tone: the plain one.
  const name = String(alt || '').trim().replace(/^:|:$/g, '').toLowerCase().replace(/:t\d$/, '');
  if (EMOJI[name]) return EMOJI[name];
  const clock = /^clock(\d{1,2}?)(30)?$/.exec(name);
  if (clock) {
    const h = Number(clock[1]);
    if (h >= 1 && h <= 12) return String.fromCodePoint((clock[2] ? 0x1F55C : 0x1F550) + h - 1);
  }
  return '';
}

/** An http(s) URL from a post's attribute (forum-relative made absolute), or null. */
export function postUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let url = s;
  if (s.startsWith('//')) url = `https:${s}`;
  else if (s.startsWith('/')) url = `${FORUM}${s}`;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

/** Is this an EroScripts host (images from it go with the session)? */
export function isForumUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (h === 'eroscripts.com' || h.endsWith('.eroscripts.com'));
  } catch { return false; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function hasClass(el, name) {
  return !!el.classList && el.classList.contains(name);
}

/**
 * A post's HTML (Discourse's `cooked`) as safe DOM for the reader: an
 * allow-list of plain elements with NO attributes copied, links as
 * `a.es-post__link[data-href]` (the window opens them outside), images as
 * `span.es-post__img[data-src]` slots the window fills (forum images through
 * main, another host's on a click), mentions and tags as text. The HTML is
 * parsed in an inert document (DOMParser): nothing in it runs or loads.
 * @param {string} html
 * @param {Document} [doc] the document to build in
 * @returns {DocumentFragment}
 */
export function sanitizePostHtml(html, doc = document) {
  const out = doc.createDocumentFragment();
  let parsed;
  try { parsed = new DOMParser().parseFromString(String(html || ''), 'text/html'); } catch { return out; }
  const state = { images: 0 };
  for (const child of Array.from(parsed.body?.childNodes || [])) walk(child, out, doc, state);
  return out;
}

function walk(node, parent, doc, state) {
  if (node.nodeType === 3) { // text
    parent.appendChild(doc.createTextNode(node.nodeValue));
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName.toUpperCase();
  if (DROP.has(tag)) return;
  const kids = (to) => { for (const c of Array.from(node.childNodes)) walk(c, to, doc, state); };

  // Discourse's furniture: image file info, avatars, emoji.
  if (hasClass(node, 'meta') && node.closest?.('.lightbox-wrapper')) return;
  if (tag === 'IMG') {
    if (hasClass(node, 'emoji')) { parent.appendChild(doc.createTextNode(emojiText(node.getAttribute('alt') || node.getAttribute('title')))); return; }
    if (hasClass(node, 'avatar')) return;
    const url = postUrl(node.getAttribute('src'));
    if (!url || state.images >= MAX_POST_IMAGES) return;
    state.images += 1;
    const slot = doc.createElement('span');
    slot.className = 'es-post__img';
    slot.dataset.src = url;
    slot.dataset.forum = isForumUrl(url) ? '1' : '0';
    slot.dataset.host = hostOf(url);
    const w = Number(node.getAttribute('width'));
    const h = Number(node.getAttribute('height'));
    if (w > 0 && h > 0) slot.style.aspectRatio = `${w} / ${h}`;
    const alt = node.getAttribute('alt');
    if (alt) slot.title = alt;
    parent.appendChild(slot);
    return;
  }
  if (tag === 'IFRAME' || tag === 'VIDEO') {
    const url = postUrl(node.getAttribute('src') || node.querySelector?.('source')?.getAttribute('src'));
    if (!url) return;
    parent.appendChild(linkEl(doc, url, `▶ ${hostOf(url) || url}`));
    return;
  }
  if (tag === 'A') {
    // A lightbox wraps its image in a link to the full size: the image only.
    if (hasClass(node, 'lightbox')) { kids(parent); return; }
    // Mentions, hashtags: forum furniture, kept as their text.
    if (hasClass(node, 'mention') || hasClass(node, 'mention-group') || hasClass(node, 'hashtag') || hasClass(node, 'hashtag-cooked')) {
      parent.appendChild(doc.createTextNode(node.textContent || ''));
      return;
    }
    const url = postUrl(node.getAttribute('href'));
    if (!url) { kids(parent); return; }
    const a = linkEl(doc, url, null);
    if (hasClass(node, 'attachment')) a.classList.add('es-post__attachment');
    kids(a);
    if (!a.childNodes.length) a.textContent = url;
    parent.appendChild(a);
    return;
  }
  if (tag === 'ASIDE' && hasClass(node, 'onebox')) {
    // A link preview: one link line, its title as the text.
    const url = postUrl(node.getAttribute('data-onebox-src') || node.querySelector?.('a[href]')?.getAttribute('href'));
    if (!url) return;
    const title = ((node.querySelector?.('h3, h4') || node.querySelector?.('header a'))?.textContent || '').trim();
    const p = doc.createElement('p');
    p.appendChild(linkEl(doc, url, title || url));
    parent.appendChild(p);
    return;
  }
  if (HEADINGS.has(tag)) {
    const h = doc.createElement('p');
    h.className = 'es-post__h';
    kids(h);
    parent.appendChild(h);
    return;
  }
  if (KEEP.has(tag)) {
    const el = doc.createElement(tag.toLowerCase());
    if (tag === 'DETAILS' && node.hasAttribute('open')) el.open = true;
    kids(el);
    parent.appendChild(el);
    return;
  }
  // Containers (div, aside.quote, span ...): their content, in a plain box.
  if (tag === 'ASIDE' && hasClass(node, 'quote')) {
    const q = doc.createElement('blockquote');
    q.className = 'es-post__quote';
    const who = node.getAttribute('data-username');
    if (who) {
      const by = doc.createElement('span');
      by.className = 'es-post__quote-by';
      by.textContent = `@${who}`;
      q.appendChild(by);
    }
    for (const c of Array.from(node.querySelector?.('blockquote')?.childNodes || node.childNodes)) walk(c, q, doc, state);
    parent.appendChild(q);
    return;
  }
  if (tag === 'DIV' && hasClass(node, 'title') && node.parentElement?.tagName === 'ASIDE') return; // a quote's header
  const box = doc.createElement(tag === 'SPAN' || tag === 'FONT' || tag === 'ABBR' ? 'span' : 'div');
  if (hasClass(node, 'spoiler') || hasClass(node, 'spoiled')) box.className = 'es-post__spoiler';
  kids(box);
  parent.appendChild(box);
}

function linkEl(doc, url, text) {
  const a = doc.createElement('a');
  a.className = 'es-post__link';
  a.href = url;
  a.dataset.href = url;
  a.rel = 'noopener noreferrer';
  a.title = url;
  if (text != null) a.textContent = text;
  return a;
}

/** A post's text, for reading a stated length (inert parse; nothing runs). */
export function postPlainText(html) {
  try {
    const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
    for (const q of Array.from(d.querySelectorAll('aside.quote, aside.onebox'))) q.remove();
    return (d.body?.textContent || '').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// 2.3 Lengths
// ---------------------------------------------------------------------------

const CLOCK = '(\\d{1,2}(?::\\d{2}){1,2})';
const LABEL = '(?:duration|length|runtime|run\\s*time|video\\s*length|total\\s*time|video\\s*duration)';

function clockSeconds(text) {
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.slice(1).some((n) => n >= 60)) return null;
  return parts.reduce((s, n) => s * 60 + n, 0);
}

/**
 * The video length a post states ("Duration: 43:16", "Length - 1:02:03",
 * "Runtime 25 min", "12m 34s"): {seconds, approx} or null. `approx` when
 * only whole minutes are given. Only a LABELLED length counts: a bare
 * "12:30" in the text could be anything.
 */
export function statedDuration(text) {
  const s = String(text || '');
  let m = new RegExp(`\\b${LABEL}\\b\\s*(?:is|of)?\\s*[:：\\-–=]?\\s*${CLOCK}(?!\\d)`, 'i').exec(s);
  if (m) {
    const sec = clockSeconds(m[1]);
    if (sec && sec >= 10) return { seconds: sec, approx: false };
  }
  m = new RegExp(`\\b${LABEL}\\b\\s*(?:is|of)?\\s*[:：\\-–=]?\\s*(?:(\\d{1,2})\\s*h(?:ours?|rs?)?\\s*)?(\\d{1,3})\\s*m(?:in(?:ute)?s?)?\\b(?:\\s*(\\d{1,2})\\s*s(?:ec(?:ond)?s?)?\\b)?`, 'i').exec(s);
  if (m) {
    const sec = (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + (Number(m[3]) || 0);
    if (sec >= 10) return { seconds: sec, approx: m[3] === undefined };
  }
  return null;
}

/**
 * Does the script fit the video? From the script's last action
 * (`scriptEndS`), the length it records (`metaS`, seconds or ms) and the
 * video's (`videoS`; `approx` when it is only to the minute):
 *   - pastEnd: the script runs past the video's end (a different cut, surely)
 *   - length: the script records another length (a different cut, likely)
 *   - muchLonger: the video is far longer than the script's last action
 *   - match: the recorded lengths agree; fits: the script ends inside the video
 * null when the video's length is unknown.
 */
export function lengthVerdict({ scriptEndS, metaS = null, videoS, approx = false }) {
  const video = Number(videoS);
  if (!Number.isFinite(video) || video <= 0) return null;
  const end = Number(scriptEndS) > 0 ? Number(scriptEndS) : 0;
  const meta = metaDurationSeconds(metaS);
  const slack = approx ? 60 : 3;
  if (end && end > video + slack) return { kind: 'pastEnd', scriptS: end, videoS: video, gapS: end - video };
  if (meta) {
    const gap = video - meta;
    if (Math.abs(gap) > Math.max(slack, meta * 0.01)) return { kind: 'length', scriptS: meta, videoS: video, gapS: gap };
    return { kind: 'match', scriptS: meta, videoS: video, gapS: gap };
  }
  if (!end) return null;
  if (video - end > Math.max(180, video * 0.25)) return { kind: 'muchLonger', scriptS: end, videoS: video, gapS: video - end };
  return { kind: 'fits', scriptS: end, videoS: video, gapS: video - end };
}

/** Is this verdict a warning? */
export function isLengthWarning(v) {
  return !!v && (v.kind === 'pastEnd' || v.kind === 'length' || v.kind === 'muchLonger');
}

export { clockText };

// ---------------------------------------------------------------------------
// 2.2 What the script is like
// ---------------------------------------------------------------------------

/** Over this (units/s, FunSync's pattern ceiling) a device may not keep up. */
export const FAST_SPEED = 600;

/**
 * {lengthS, count, avgSpeed, maxSpeed, fast} for a script's actions (sorted).
 * Speeds in units/s over moves (holds are not counted in the average); the
 * fastest is the 98th percentile of moves, so one glitch point does not
 * call a slow script frantic.
 */
export function scriptSummary(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const speeds = [];
  for (let i = 1; i < list.length; i++) {
    const dt = list[i].at - list[i - 1].at;
    const dp = Math.abs(list[i].pos - list[i - 1].pos);
    if (dt > 0 && dp > 0) speeds.push((dp / dt) * 1000);
  }
  const avg = speeds.length ? speeds.reduce((s, v) => s + v, 0) / speeds.length : 0;
  const sorted = speeds.slice().sort((a, b) => a - b);
  const max = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] : 0;
  return {
    lengthS: list.length ? list[list.length - 1].at / 1000 : 0,
    count: list.length,
    avgSpeed: Math.round(avg),
    maxSpeed: Math.round(max),
    fast: max > FAST_SPEED,
  };
}

// ---------------------------------------------------------------------------
// 2.4 / 2.5 Who posted it
// ---------------------------------------------------------------------------

export function sameUser(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Who a link or script came from: 'post' (the first post, the scripter's),
 * 'scripter' (a reply by the scripter), 'other' (a reply by someone else:
 * a re-upload, or another person's script).
 */
export function provenance(item, creator) {
  if (!item || item.from !== 'reply') return 'post';
  return sameUser(item.username, creator) ? 'scripter' : 'other';
}

/** Do two sizes differ by more than 2% (both known)? */
export function sizesDiffer(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return false;
  return Math.abs(x - y) / Math.max(x, y) > 0.02;
}

/**
 * The script choices: the first post's, then each reply's (newest reply
 * first), grouped the same way (`group` is the window's scriptChoices). The
 * one chosen at first: the scripter's newest reply with a whole script (an
 * update, review 2.5: "The scripter posted v2 in reply #23"), else the
 * post's first, else the newest reply's.
 * @returns {{choices: Array, index: number}}
 */
export function buildScriptChoices(postAttachments, replyScripts, creator, group) {
  const post = group(postAttachments || []).map((c) => ({ ...c, from: 'post' }));
  const byPost = new Map();
  for (const a of Array.isArray(replyScripts) ? replyScripts : []) {
    if (!byPost.has(a.postNumber)) byPost.set(a.postNumber, { meta: a, list: [] });
    byPost.get(a.postNumber).list.push({ name: a.name, url: a.url });
  }
  const replies = [];
  for (const { meta, list } of byPost.values()) {
    for (const c of group(list)) {
      replies.push({ ...c, from: 'reply', postNumber: meta.postNumber, username: meta.username, createdAt: meta.createdAt, likes: meta.likes || 0 });
    }
  }
  const choices = [...post, ...replies];
  let index = choices.findIndex((c) => c.from === 'reply' && sameUser(c.username, creator) && !c.lone && /\.funscript$/i.test(c.name));
  if (index < 0) index = choices.length ? 0 : -1;
  return { choices, index };
}
