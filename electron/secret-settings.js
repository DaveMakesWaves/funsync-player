// The settings that hold a credential: ONE list for the whole main process
// (R3-08).
//
// Two modules need it and each used to keep its own copy, with nothing
// keeping them in step:
//   - electron/log-redact.js masks every secret on every log line (FT-010):
//     it needs `literals`, the secret strings inside the stored value;
//   - electron/data-export.js keeps a credential that is set here when a
//     backup is MERGE-imported (FT-008): it needs `import` and, for
//     'keep-local', `present` (is the local value worth keeping?).
// A new key, token or cookie setting is added HERE, once, and both follow.
// tests/unit/secret-settings-parity.test.js checks every entry end to end
// (masked in a log line, kept by a merge import) and fails for an entry it
// has no sample value for, so a new one cannot slip past either module.
//
// `import`:
//   'keep-local'   a value set here wins; the backup only fills an empty slot
//                  (data-export.js `_keepLocalSecrets`);
//   'union-by-key' a list of other people's keys: union by key, the local row
//                  wins (data-export.js `_mergeAudienceViewers`, which knows
//                  this one path).

const _isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const SECRET_SETTINGS = Object.freeze({
  'handy.connectionKey': Object.freeze({
    literals: (v) => [v],
    import: 'keep-local',
    present: _isNonEmptyString,
  }),
  'autoblow.token': Object.freeze({
    literals: (v) => [v],
    import: 'keep-local',
    present: _isNonEmptyString,
  }),
  // { cookie, username }; null after a log-out or an expired session.
  'eroscripts.session': Object.freeze({
    literals: (v) => [v && typeof v === 'object' ? v.cookie : v],
    import: 'keep-local',
    present: (v) => !!v && typeof v === 'object' && _isNonEmptyString(v.cookie),
  }),
  // The Audience roster: other people's Handy keys.
  'audience.viewers': Object.freeze({
    literals: (v) => {
      const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
      return list.map((x) => (x && typeof x === 'object' ? x.key : x));
    },
    import: 'union-by-key',
  }),
});

const SECRET_SETTING_PATHS = Object.freeze(Object.keys(SECRET_SETTINGS));

// The credentials kept in a FILE of their own under userData, never in
// config.json: so never in getAll(), the renderer, a config snapshot or a
// .funsync-backup (Stash S1, DESIGN-stash-s1.md (d)). Each entry:
//   file      its path under userData, with forward slashes;
//   literals  the secret strings inside the stored value, for log masking.
// The file's owner module registers the literals with log-redact.js
// (registerSecretLiterals) whenever it loads or saves the value, so the
// secret is masked on every log line. A new secret file is added HERE, once:
// tests/unit/secret-settings-parity.test.js checks every entry end to end
// (masked in a real log line, absent from getAll(), config.json, an export
// zip and the status reply) and fails for an entry it has no sample for.
const SECRET_FILES = Object.freeze({
  // The API key of the user's own Stash server (electron/stash-secret.js):
  // encrypted with safeStorage on an installed build, plain text in a
  // portable build's data folder (Dave, 2026-11-18).
  'stash.apiKey': Object.freeze({
    file: 'stash/key.json',
    literals: (v) => [v],
  }),
});

module.exports = { SECRET_SETTINGS, SECRET_SETTING_PATHS, SECRET_FILES };
