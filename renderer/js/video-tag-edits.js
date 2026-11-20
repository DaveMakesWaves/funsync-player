// The writers for a video's tags: add, remove, show again, their Undo, and
// "Make a category from this tag" (notes/features/DESIGN-video-options.md (c)
// "Editing" and "Make a category from this tag"; (e) for the store keys).
//
// NOT WIRED YET (2026-11-18). The video options dialog's Tags section (Round 2)
// is the first caller.
//
// The model, in short:
// - Your tags live in `library.userTags[videoPath]` (as typed). Tags you hid
//   on one video live in `library.hiddenTags[videoPath]` (as keys). Both are
//   path-keyed maps in config.json; the other sources (EroScripts, the
//   funscript file, Stash) are never written here.
// - Add writes your copy, and if that tag is hidden on this video the same
//   write shows it again (Dave, 2026-11-17: a hidden tag you add again shows
//   again).
// - Remove takes your copy away. If another source still gives the tag, it
//   is also hidden on this video, so the chip goes as you expect.
// - Show again takes a key out of this video's hidden list.
// - Every edit returns an Undo record that puts both lists of that ONE video
//   back exactly, absence included.
//
// Rules this module keeps:
// - Pure planners: they read the maps you pass and return the writes; the
//   caller writes them (applyWrites, or its own DataService.set). Nothing
//   here mutates its inputs.
// - Only the edited video's entry changes. Every other path, including a
//   path that is not in the library (an offline drive), is passed through
//   untouched: nothing here prunes.
// - Absence is never destructive. A missing map is empty. A map or an entry
//   of the wrong shape (a damaged config) is never overwritten: the edit is
//   refused with `reason: 'bad-store'`.
// - Tag text is untrusted. It is stored as typed (whitespace collapsed), and
//   only ever compared through video-tags.js keys.

import {
  IDENTITY_FACETS,
  IDENTITY_MARK,
  TAG_SOURCES,
  classifyTag,
  classifyTypedTag,
  compileTagRules,
  deslug,
  displayForm,
  effectiveTags,
  filterByTags,
  foldForMatch,
  sourceKeysUnder,
} from './video-tags.js';

/** Store keys (under settings, as DataService.get/set name them). */
export const USER_TAGS_KEY = 'library.userTags';
export const HIDDEN_TAGS_KEY = 'library.hiddenTags';

/** A tag you type is refused above this many characters, never cut. */
export const MAX_TAG_TEXT = 200;

/** Make a category: more videos than this take a pre-action snapshot first. */
export const SNAPSHOT_THRESHOLD = 25;

/** The pre-action snapshot label (main's backup:pre-action). */
export const SNAPSHOT_LABEL = 'make-category-from-tag';

// PRESET_COLORS[0] in category-create-modal.js (not imported: that module
// pulls in the Modal and the DOM). Used only when the caller gives no colour.
const DEFAULT_CATEGORY_COLOR = '#e94560';

const SLOTS = Object.freeze([
  { name: 'userTags', storeKey: USER_TAGS_KEY },
  { name: 'hiddenTags', storeKey: HIDDEN_TAGS_KEY },
]);

// ---------------------------------------------------------------------------
// Reading the stored maps
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * One slot of the state: its map and this video's list.
 * `ok: false` when the map or the entry has a shape we must not overwrite.
 */
function readSlot(map, path) {
  if (map === undefined || map === null) return { ok: true, map: {}, list: null };
  if (!isPlainObject(map)) return { ok: false };
  if (!hasOwn(map, path) || map[path] === undefined) return { ok: true, map, list: null };
  const list = map[path];
  if (!Array.isArray(list)) return { ok: false };
  return { ok: true, map, list };
}

function rulesOf(ctx) {
  if (ctx?.rules) return ctx.rules;
  const settings = isPlainObject(ctx?.tagSettings) ? ctx.tagSettings : {};
  return compileTagRules(settings);
}

const IDENTITY_FACET_SET = new Set(IDENTITY_FACETS);

// The bare name key of an identity key (Stash S1): `performer:jane-doe#3f2a…`
// -> `performer:jane-doe`. null for every other key.
function bareKeyOf(key) {
  if (typeof key !== 'string') return null;
  const colon = key.indexOf(':');
  if (colon < 1 || !IDENTITY_FACET_SET.has(key.slice(0, colon))) return null;
  const at = key.indexOf(IDENTITY_MARK, colon + 1);
  return at > colon + 1 ? key.slice(0, at) : null;
}

// The rules without the bare-name join: how a name reads once the join
// breaks (Stash turned off, its data removed, a second person of that name).
function withoutJoin(rules) {
  return rules?.nameIds ? { ...rules, nameIds: null } : rules;
}

// The rules without Stash's tag aliases (sn-fixup SN-R1): how a tag reads
// once "Use Stash's tag aliases and sub-tags" (or Stash) is off, or its data
// removed. null when the rules have no Stash layer. The layer never touches
// a performer, creator or studio, so the join is kept as it is.
function withoutStashLayer(rules) {
  const plain = rules?.withoutStash;
  return plain && plain.slugAliases instanceof Map ? { ...plain, nameIds: rules.nameIds ?? null } : null;
}

// The key of one stored item, read the way effectiveTags reads it: a string
// or a number as typed, or `{name}` / `{slug}` in a user record. `typed`:
// an item of userTags (a `#` in a performer or studio name is `-`, Stash
// S1); else a hidden KEY (an identity in it is kept).
function keyOfItem(item, rules, typed = false) {
  let raw = item;
  if (item && typeof item === 'object') raw = item.name ?? item.slug;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  return (typed ? classifyTypedTag(raw, rules) : classifyTag(raw, rules))?.key ?? null;
}

function sameList(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

const copyList = (list) => (list === null ? null : [...list]);

// The map with this path set to `list`, or removed when `list` is null.
function withEntry(map, path, list) {
  const next = { ...map };
  if (list === null) delete next[path];
  else next[path] = [...list];
  return next;
}

function refused(reason, extra = {}) {
  return { ok: false, reason, changed: false, writes: [], undo: null, ...extra };
}

/**
 * Turn the per-slot before/after lists into the plan the caller applies.
 * A list that ends up empty is removed from the map (absent = no tags).
 */
function finish(path, slots, extra) {
  const writes = [];
  const undo = { path, slots: {} };
  for (const { name, storeKey } of SLOTS) {
    const slot = slots[name];
    if (!slot) continue;
    if (sameList(slot.before, slot.after)) continue; // untouched, even an empty []
    const after = slot.after && slot.after.length ? slot.after : null;
    writes.push({ key: storeKey, value: withEntry(slot.map, path, after) });
    undo.slots[name] = { before: copyList(slot.before), after: copyList(after) };
  }
  const changed = writes.length > 0;
  return { ok: true, changed, writes, undo: changed ? undo : null, ...extra };
}

function validPath(path) {
  return typeof path === 'string' && path !== '';
}

// ---------------------------------------------------------------------------
// Add, remove, show again
// ---------------------------------------------------------------------------

/**
 * Add a tag you typed to one video. If that tag is hidden on this video, the
 * same plan takes it out of the hidden list, so it shows again. Adding a tag
 * you already gave the video only does the unhide (no second copy).
 *
 * @param {{userTags?: object, hiddenTags?: object}} state the two maps as stored
 * @param {string} path the video's path
 * @param {string} text what you typed (`facet:value` puts it in that facet)
 * @param {{rules?: object, tagSettings?: object}} [ctx]
 * @returns {{ok: boolean, reason?: string, changed: boolean, key?: string,
 *   text?: string, writes: {key: string, value: object}[], undo: object|null}}
 *   reasons: 'no-path', 'empty', 'too-long', 'bad-store'
 */
export function planAddTag(state, path, text, ctx = {}) {
  if (!validPath(path)) return refused('no-path');
  const typed = displayForm(text);
  if (!typed) return refused('empty');
  if (typed.length > MAX_TAG_TEXT) return refused('too-long');
  const rules = rulesOf(ctx);
  const key = classifyTypedTag(typed, rules)?.key;
  if (!key) return refused('empty');

  const user = readSlot(state?.userTags, path);
  const hidden = readSlot(state?.hiddenTags, path);
  if (!user.ok || !hidden.ok) return refused('bad-store', { key });

  const userBefore = user.list;
  const already = (userBefore || []).some((item) => keyOfItem(item, rules, true) === key);
  const userAfter = already ? userBefore : [...(userBefore || []), typed];

  const hiddenBefore = hidden.list;
  const hiddenAfter = hiddenBefore === null ? null : hiddenBefore.filter((item) => keyOfItem(item, rules) !== key);

  return finish(path, {
    userTags: { map: user.map, before: userBefore, after: userAfter },
    hiddenTags: { map: hidden.map, before: hiddenBefore, after: hiddenAfter },
  }, { key, text: typed });
}

/**
 * Does any source other than you give this video the tag? Read without any
 * hide, so a tag hidden everywhere still counts as given.
 */
function givenByOthers(path, key, ctx, rules) {
  const sources = isPlainObject(ctx?.sources) ? { ...ctx.sources } : {};
  delete sources[TAG_SOURCES.USER];
  return effectiveTags(path, sources, { scriptPath: ctx?.scriptPath, rules }).some((tag) => tag.key === key);
}

/**
 * Remove a tag from one video (the × on a chip). Your copy goes from
 * `userTags`. If another source still gives the tag, its key goes into
 * `hiddenTags` too, so the chip goes away.
 *
 * @param {{userTags?: object, hiddenTags?: object}} state
 * @param {string} path
 * @param {string} key the chip's key (effectiveTags' `key`), or a typed name
 * @param {{sources?: object, scriptPath?: string, rules?: object, tagSettings?: object}} [ctx]
 *   `sources` and `scriptPath` as given to effectiveTags (the `user` source
 *   is read from `state`, not from here)
 * @returns as planAddTag; `hidden: true` when the key was hidden
 */
export function planRemoveTag(state, path, key, ctx = {}) {
  if (!validPath(path)) return refused('no-path');
  const rules = rulesOf(ctx);
  const canonical = classifyTag(key, rules)?.key;
  if (!canonical) return refused('empty');

  const user = readSlot(state?.userTags, path);
  const hidden = readSlot(state?.hiddenTags, path);
  if (!user.ok || !hidden.ok) return refused('bad-store', { key: canonical });

  const userBefore = user.list;
  const userAfter = userBefore === null ? null : userBefore.filter((item) => keyOfItem(item, rules, true) !== canonical);

  const hiddenBefore = hidden.list;
  let hiddenAfter = hiddenBefore;
  const hide = givenByOthers(path, canonical, ctx, rules);
  if (hide && !(hiddenBefore || []).some((item) => keyOfItem(item, rules) === canonical)) {
    hiddenAfter = [...(hiddenBefore || []), canonical];
  }
  // A chip whose bare name (the script's, the post's) was JOINED to the one
  // Stash identity of that name (s1-review-a RA-S1-2): its bare key is
  // hidden too. While the join holds the bare key reads as the identity key,
  // so nothing else changes; once it breaks (Stash turned off, its data
  // removed, a second person of that name) the bare chip stays hidden.
  const bare = hide ? bareKeyOf(canonical) : null;
  if (bare) {
    const plain = withoutJoin(rules);
    if (!(hiddenAfter || []).some((item) => keyOfItem(item, plain) === bare) && givenByOthers(path, bare, ctx, plain)) {
      hiddenAfter = [...(hiddenAfter || []), bare];
    }
  }
  // A chip Stash's tag aliases made (sn-fixup, 2026-11-19, SN-R1; the
  // RA-S1-2 pattern for the alias layer): the keys the other sources' own
  // spellings of it have WITHOUT that layer are hidden too ("outside" from
  // EroScripts, shown as Stash's "Open Air"). While the layer holds they
  // read as this chip's key (one row, Show again lifts them all, Undo puts
  // the list back exactly); once the opt-in or Stash is off, or its data
  // removed, the tag stays removed.
  const plainStash = hide ? withoutStashLayer(rules) : null;
  if (plainStash) {
    const others = isPlainObject(ctx?.sources) ? { ...ctx.sources } : {};
    delete others[TAG_SOURCES.USER];
    const keys = sourceKeysUnder(path, others, canonical, rules, plainStash, { scriptPath: ctx?.scriptPath });
    // Another chip shown now is never hidden by this: a spelling Stash took
    // from a bundled alias ("bj": Stash's "Oral", else "Blowjob") whose
    // plain key is a chip of its own here was not the tag you removed.
    let shownNow = null;
    for (const k of keys) {
      if (k === canonical || (hiddenAfter || []).some((item) => keyOfItem(item, plainStash) === k)) continue;
      const nowKey = classifyTag(k, rules)?.key;
      if (nowKey !== canonical) {
        if (!shownNow) {
          shownNow = new Set(effectiveTags(path, others, { scriptPath: ctx?.scriptPath, rules }).map((tag) => tag.key));
          for (const item of userAfter || []) shownNow.add(keyOfItem(item, rules, true));
        }
        if (shownNow.has(nowKey)) continue;
      }
      hiddenAfter = [...(hiddenAfter || []), k];
    }
  }

  return finish(path, {
    userTags: { map: user.map, before: userBefore, after: userAfter },
    hiddenTags: { map: hidden.map, before: hiddenBefore, after: hiddenAfter },
  }, { key: canonical, hidden: hiddenAfter !== hiddenBefore });
}

/**
 * Show a tag hidden on this video again ("Hidden on this video" → Show
 * again): its key leaves `hiddenTags[path]`. `userTags` is not touched.
 *
 * @returns as planAddTag
 */
export function planShowAgain(state, path, key, ctx = {}) {
  if (!validPath(path)) return refused('no-path');
  const rules = rulesOf(ctx);
  const canonical = classifyTag(key, rules)?.key;
  if (!canonical) return refused('empty');

  const hidden = readSlot(state?.hiddenTags, path);
  if (!hidden.ok) return refused('bad-store', { key: canonical });
  const before = hidden.list;
  // The row "Hidden on this video" shows for this key: every stored item it
  // stands for goes (a joined chip's hide is two keys, RA-S1-2).
  const row = before === null ? null : hiddenRows(before, path, ctx, rules).find((r) => r.key === canonical);
  const lift = row ? new Set(row.items) : null;
  const after = before === null ? null
    : before.filter((item) => (lift ? !lift.has(item) : keyOfItem(item, rules) !== canonical));
  return finish(path, { hiddenTags: { map: hidden.map, before, after } }, { key: canonical });
}

/**
 * The plan that undoes an edit. When this video's lists are still what the
 * edit left, they go back EXACTLY (an entry that was absent is removed
 * again). When something changed them since (a later edit), only this
 * edit's own change is reversed, so the later edit survives: `exact: false`.
 *
 * @param {{userTags?: object, hiddenTags?: object}} state the maps NOW
 * @param {{path: string, slots: object}} undo from a plan
 * @returns {{ok: boolean, reason?: string, exact: boolean, changed: boolean,
 *   writes: {key: string, value: object}[]}}
 */
export function planUndo(state, undo) {
  if (!undo || !validPath(undo.path) || !isPlainObject(undo.slots)) {
    return { ok: false, reason: 'no-undo', exact: false, changed: false, writes: [] };
  }
  const { path } = undo;
  let exact = true;
  const writes = [];
  for (const { name, storeKey } of SLOTS) {
    const record = undo.slots[name];
    if (!record) continue;
    const slot = readSlot(state?.[name], path);
    if (!slot.ok) { exact = false; continue; } // never overwrite a damaged map
    const before = Array.isArray(record.before) ? record.before : null;
    const after = Array.isArray(record.after) ? record.after : null;
    let target;
    if (sameList(slot.list, after)) {
      target = before;
    } else {
      exact = false;
      const added = new Set((after || []).filter((item) => !(before || []).includes(item)));
      const removed = (before || []).filter((item) => !(after || []).includes(item));
      const kept = (slot.list || []).filter((item) => !added.has(item));
      target = [...kept, ...removed.filter((item) => !kept.includes(item))];
      if (!target.length && before === null) target = null;
    }
    if (sameList(slot.list, target)) continue;
    writes.push({ key: storeKey, value: withEntry(slot.map, path, target) });
  }
  return { ok: true, exact, changed: writes.length > 0, writes };
}

/**
 * Write a plan's writes through the settings service (DataService: get/set
 * of a whole map, the way every path-keyed map is written). Re-reads nothing:
 * plan and apply in the same tick.
 *
 * @param {{set: Function}} settings
 * @param {{writes?: {key: string, value: object}[]}} plan
 * @returns {number} how many maps were written
 */
export function applyWrites(settings, plan) {
  if (!settings?.set || !Array.isArray(plan?.writes)) return 0;
  for (const { key, value } of plan.writes) settings.set(key, value);
  return plan.writes.length;
}

/**
 * The tags hidden on one video, for the "Hidden on this video" line. Each
 * key once, in the order they were hidden. With `ctx.sources` the label is
 * the one the tag would show with (the source's spelling); without, the
 * key's value, de-slugged.
 *
 * @param {object} hiddenTags the stored map
 * @param {string} path
 * @param {{sources?: object, scriptPath?: string, rules?: object, tagSettings?: object}} [ctx]
 * @returns {{key: string, facet: string, label: string}[]}
 */
export function hiddenOnVideo(hiddenTags, path, ctx = {}) {
  const slot = validPath(path) ? readSlot(hiddenTags, path) : { ok: false };
  if (!slot.ok || !slot.list) return [];
  return hiddenRows(slot.list, path, ctx, rulesOf(ctx)).map(({ key, facet, label }) => ({ key, facet, label }));
}

/**
 * The rows of "Hidden on this video" with the stored items each stands for
 * (Show again lifts them all). Stash S1 (s1-review-a RA-S1-2, RA-S1-5):
 * - A key that names a person or studio by identity is labelled by its
 *   name, never by the raw key (`jane doe#aaaa 3f2a`), as a source spells
 *   it when one gives it.
 * - The hide of a joined chip is two keys (the identity and the bare
 *   name). While the join holds they read as one key, one row. Once it
 *   breaks, an identity no source gives now (Stash off, its data removed)
 *   folds into its bare name's row: one row, and Show again lifts both.
 * - Two rows of one name facet that read the same: each row with an
 *   identity gets Stash's disambiguation, "Jane Doe (blonde)", else the
 *   identity's last 4 characters, "Jane Doe · 3f2a" (the library index's
 *   rule, library-tag-filter.js).
 */
function hiddenRows(list, path, ctx, rules) {
  const shown = new Map();
  const known = isPlainObject(ctx?.sources);
  if (known) {
    for (const tag of effectiveTags(path, ctx.sources, { scriptPath: ctx.scriptPath, rules })) shown.set(tag.key, tag);
  }
  const rows = [];
  const byKey = new Map();
  for (const item of list) {
    const tag = classifyTag(item, rules);
    if (!tag) continue;
    let row = byKey.get(tag.key);
    if (!row) {
      const src = shown.get(tag.key);
      const bare = bareKeyOf(tag.key);
      const name = bare ? bare.slice(bare.indexOf(':') + 1) : tag.value;
      row = {
        key: tag.key,
        facet: tag.facet,
        label: src?.label ?? (tag.facet === 'length' ? tag.value : deslug(name)),
        identity: bare ? tag.value.slice(name.length + 1) : null,
        disambiguation: src?.disambiguation || '',
        items: [],
      };
      byKey.set(tag.key, row);
      rows.push(row);
    }
    row.items.push(item);
  }
  // An identity no source gives now folds into its bare name's row.
  const out = rows.filter((row) => {
    if (!known || !row.identity || shown.has(row.key)) return true;
    const into = byKey.get(bareKeyOf(row.key));
    if (!into || into === row) return true;
    into.items.push(...row.items);
    return false;
  });
  disambiguateHiddenLabels(out);
  return out;
}

// Rows of one name facet that read the same get the identity's words.
function disambiguateHiddenLabels(rows) {
  const tail = (row) => row.identity.slice(-4);
  const clashes = () => {
    const groups = new Map();
    for (const row of rows) {
      const mark = `${row.facet}\u0000${foldForMatch(row.label)}`;
      if (!groups.has(mark)) groups.set(mark, []);
      groups.get(mark).push(row);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  };
  const suffixed = new Set();
  for (const group of clashes()) {
    for (const row of group) {
      if (!row.identity) continue;
      row.label = row.disambiguation ? `${row.label} (${row.disambiguation})` : `${row.label} · ${tail(row)}`;
      if (row.disambiguation) suffixed.add(row);
    }
  }
  for (const group of clashes()) {
    for (const row of group) if (suffixed.has(row)) row.label = `${row.label} · ${tail(row)}`;
  }
}

// ---------------------------------------------------------------------------
// Make a category from this tag
// ---------------------------------------------------------------------------

/**
 * Plan "Make a category from this tag": which library videos have the tag,
 * whether a category with that name exists, and what would be assigned.
 * One shot: the category is not linked to the tag afterwards.
 *
 * Videos are matched by the tag's KEY in their effective tags (tagIndex),
 * never by its label. Only videos in `videos` (the library list) are
 * counted or assigned.
 *
 * @param {object} args
 * @param {string} args.key the chip's key
 * @param {string} args.name the category name (prefilled with the tag's label)
 * @param {{path: string}[]} args.videos the library list
 * @param {Map<string, Array>|Object<string, Array>} args.tagsByPath tagIndex()
 * @param {{id: string, name: string}[]} [args.categories]
 * @param {Object<string, string[]>} [args.videoCategories] root map
 * @param {object} [args.rules]
 * @returns {{ok: boolean, reason?: string, key?: string, name?: string,
 *   mode?: 'create'|'existing', category?: {id: string, name: string}|null,
 *   paths?: string[], assign?: string[], count?: number, snapshot?: boolean}}
 *   reasons: 'empty', 'empty-name'
 */
export function planMakeCategory({ key, name, videos, tagsByPath, categories = [], videoCategories = {}, rules } = {}) {
  const canonical = classifyTag(key, rules)?.key;
  if (!canonical) return { ok: false, reason: 'empty' };
  const cleanName = displayForm(name);
  if (!cleanName) return { ok: false, reason: 'empty-name' };

  const paths = [];
  const seen = new Set();
  for (const video of filterByTags(Array.isArray(videos) ? videos : [], { include: [canonical], mode: 'all' }, tagsByPath || new Map())) {
    const p = video.path;
    if (typeof p !== 'string' || !p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }

  const wanted = foldForMatch(cleanName);
  const existing = (Array.isArray(categories) ? categories : [])
    .find((c) => c && c.id != null && foldForMatch(c.name) === wanted) || null;
  const holds = (p) => {
    const ids = isPlainObject(videoCategories) && hasOwn(videoCategories, p) ? videoCategories[p] : null;
    return Array.isArray(ids) && ids.includes(existing.id);
  };
  const assign = existing ? paths.filter((p) => !holds(p)) : paths.slice();

  return {
    ok: true,
    key: canonical,
    name: cleanName,
    mode: existing ? 'existing' : 'create',
    category: existing ? { id: existing.id, name: existing.name } : null,
    paths,
    assign,
    count: paths.length,
    snapshot: assign.length > SNAPSHOT_THRESHOLD,
  };
}

/**
 * Carry out a make-category plan. Takes the pre-action snapshot first when
 * the plan says so (a snapshot that fails does not block: every write here
 * is an addition, and the Undo below reverses it). In 'existing' mode a
 * video that already holds the category (checked again now) is skipped, so
 * Undo never takes away an assignment this did not add.
 *
 * @param {object} plan from planMakeCategory (ok)
 * @param {object} deps
 * @param {{addCategory: Function, assignCategory: Function, getVideoCategories?: Function}} deps.settings
 *   DataService
 * @param {string} [deps.color] the new category's colour
 * @param {(label: string) => Promise<unknown>} [deps.takeSnapshot] window.funsync.backupPreAction
 * @returns {Promise<{ok: boolean, reason?: string, categoryId?: string,
 *   assigned?: string[], snapshotTaken?: boolean, undo?: object}>}
 */
export async function applyMakeCategory(plan, { settings, color, takeSnapshot } = {}) {
  if (!plan?.ok || !settings?.assignCategory) return { ok: false, reason: 'no-plan' };
  let snapshotTaken = false;
  if (plan.snapshot && typeof takeSnapshot === 'function') {
    try { await takeSnapshot(SNAPSHOT_LABEL); snapshotTaken = true; } catch { /* see above */ }
  }

  let categoryId;
  if (plan.mode === 'existing') {
    categoryId = plan.category?.id;
  } else {
    if (!settings.addCategory) return { ok: false, reason: 'no-plan', snapshotTaken };
    const created = await settings.addCategory(plan.name, color || DEFAULT_CATEGORY_COLOR);
    categoryId = created?.id;
  }
  if (categoryId == null) return { ok: false, reason: 'no-category', snapshotTaken };

  const assigned = [];
  for (const p of plan.assign || []) {
    if (plan.mode === 'existing' && typeof settings.getVideoCategories === 'function') {
      const ids = settings.getVideoCategories(p);
      if (Array.isArray(ids) && ids.includes(categoryId)) continue;
    }
    settings.assignCategory(p, categoryId);
    assigned.push(p);
  }

  const undo = plan.mode === 'existing'
    ? { mode: 'existing', categoryId, assigned: [...assigned] }
    : { mode: 'create', categoryId };
  return { ok: true, categoryId, assigned, snapshotTaken, undo };
}

/**
 * Undo "Make a category" (the toast's Undo): delete the category it created,
 * or take away only the assignments it added to an existing one.
 *
 * @param {{mode: string, categoryId: string, assigned?: string[]}} undo
 * @param {{settings: {deleteCategory: Function, unassignCategory: Function}}} deps
 * @returns {boolean} whether anything was undone
 */
export function undoMakeCategory(undo, { settings } = {}) {
  if (!undo || undo.categoryId == null || !settings) return false;
  if (undo.mode === 'create') {
    if (typeof settings.deleteCategory !== 'function') return false;
    settings.deleteCategory(undo.categoryId);
    return true;
  }
  if (undo.mode === 'existing' && Array.isArray(undo.assigned) && typeof settings.unassignCategory === 'function') {
    for (const p of undo.assigned) settings.unassignCategory(p, undo.categoryId);
    return undo.assigned.length > 0;
  }
  return false;
}
