'use strict';

// Stash S1: the keys stored Stash records live under (Round 2, 2026-11-18).
//
// Stash's ids (scenes, performers, studios, tags) are unique only within ONE
// Stash server: scene 12 on the Stash on this PC and scene 12 on a NAS are
// different scenes. FunSync keeps the data of an address it was pointed at
// before ("From your other Stash", DESIGN-stash-s1.md (e)), so two servers'
// records can sit in one library.json. Two rules make a mix-up impossible:
//
//   - STORED records are keyed by `<id>@<server key>` (recordKey): the key
//     itself names the server, so a sync of one server can never overwrite
//     another server's scene, person, studio or tag with the same id. Every
//     record also carries its raw Stash `id` and its `server`.
//   - The RENDERER sees opaque ids (projectedId): a record of the data's own
//     server (library.json `server.url`) keeps Stash's raw id ('12'), a record
//     of any other server gets '<id>@<server key>', and every reference to it
//     (a link's sceneId, a check's candidates, a scene's performers…) uses
//     the same form. So `data.scenes[link.sceneId]` is always the right scene,
//     and renderer code that treats ids as strings needs no change.
//
// Stash's raw ids are [A-Za-z0-9_-] (stash-map.js stashId), so they never
// contain '@'; a normalized address never does either (stash-client.js
// normalizeStashAddress refuses it). parseProjectedId splits at the FIRST '@'.
// No migration: no Stash data existed in any install when this was written.

const SEP = '@';

/** The form two Stash addresses are compared in: trimmed, no trailing '/', lower case. */
function serverKey(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '').toLowerCase() : '';
}

/**
 * Is `a` the same server as `b`? A side with no server recorded is taken as
 * the other one (S1 has one server at a time; data from before a server was
 * recorded belongs to the server in use).
 */
function sameServer(a, b) {
  const ka = serverKey(a);
  return !ka || ka === serverKey(b);
}

function rawId(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return typeof id === 'string' && id !== '' && !id.includes(SEP) ? id : null;
}

/**
 * The key a record is STORED under in library.json: `<id>@<server key>`.
 * null for an id that is not one.
 * @param {string|null|undefined} server the address the record came from
 * @param {string|number} id Stash's raw id
 * @returns {string|null}
 */
function recordKey(server, id) {
  const raw = rawId(id);
  return raw ? `${raw}${SEP}${serverKey(server)}` : null;
}

/**
 * The id the RENDERER sees for a record of `server`, when the data's own
 * server is `current`: the raw id for the data's own server (or a record
 * with no server recorded), `<id>@<server key>` for any other.
 * @returns {string|null}
 */
function projectedId(server, id, current) {
  const raw = rawId(id);
  if (!raw) return null;
  return sameServer(server, current) ? raw : `${raw}${SEP}${serverKey(server)}`;
}

/**
 * A projected (or stored) id back to its parts: `{id, server}` where
 * `server` is a server KEY, or null when the id carried none (the data's own
 * server). null for something that is not an id.
 * @param {unknown} value
 * @returns {{id: string, server: string|null}|null}
 */
function parseProjectedId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { id: String(value), server: null };
  if (typeof value !== 'string' || value === '') return null;
  const at = value.indexOf(SEP);
  if (at < 0) return { id: value, server: null };
  const id = value.slice(0, at);
  const server = value.slice(at + 1);
  return id ? { id, server: server || null } : null;
}

module.exports = {
  serverKey,
  sameServer,
  recordKey,
  projectedId,
  parseProjectedId,
};
