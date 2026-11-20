// A fake of the store the video options plans write through (`runOps` in
// renderer/js/video-options-model.js): dataService's get/set over a config
// object, plus its playlist and category methods with store.js's rules:
//   - addVideoToPlaylist appends, and never twice;
//   - setPlaylistVideoPaths takes only a pure reorder (anything else is
//     refused and the order is left as it was);
//   - assignCategory appends; unassignCategory filters and deletes the key
//     when the list is empty.
// Every call is recorded, so a test can say "nothing was written" or "no
// write reached library.scriptTags".

function walk(state, key, create) {
  const parts = String(key).split('.');
  let node = state;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] == null) {
      if (!create) return { node: null, last: parts[parts.length - 1] };
      node[parts[i]] = {};
    }
    node = node[parts[i]];
  }
  return { node, last: parts[parts.length - 1] };
}

export function makeFakeStore(initial = {}) {
  const state = JSON.parse(JSON.stringify(initial));
  const calls = [];
  const playlist = (id) => (state.playlists || []).find((p) => p.id === id);
  return {
    state,
    calls,
    writes: () => calls.filter((c) => c[0] !== 'get'),
    get(key) {
      calls.push(['get', key]);
      const { node, last } = walk(state, key, false);
      return node ? node[last] : undefined;
    },
    set(key, value) {
      calls.push(['set', key]);
      const { node, last } = walk(state, key, true);
      node[last] = value;
    },
    addVideoToPlaylist(id, path) {
      calls.push(['addVideoToPlaylist', id, path]);
      const pl = playlist(id);
      if (pl && !pl.videoPaths.includes(path)) pl.videoPaths.push(path);
    },
    removeVideoFromPlaylist(id, path) {
      calls.push(['removeVideoFromPlaylist', id, path]);
      const pl = playlist(id);
      if (pl) pl.videoPaths = pl.videoPaths.filter((p) => p !== path);
    },
    setPlaylistVideoPaths(id, order) {
      calls.push(['setPlaylistVideoPaths', id, order.slice()]);
      const pl = playlist(id);
      if (!pl) return null;
      const a = [...pl.videoPaths].sort();
      const b = [...order].sort();
      if (a.length !== b.length || a.some((p, i) => p !== b[i])) return [...pl.videoPaths];
      pl.videoPaths = [...order];
      return [...pl.videoPaths];
    },
    assignCategory(path, catId) {
      calls.push(['assignCategory', path, catId]);
      state.videoCategories = state.videoCategories || {};
      const map = state.videoCategories;
      if (!map[path]) map[path] = [];
      if (!map[path].includes(catId)) map[path].push(catId);
    },
    unassignCategory(path, catId) {
      calls.push(['unassignCategory', path, catId]);
      const map = state.videoCategories || {};
      if (!map[path]) return;
      map[path] = map[path].filter((id) => id !== catId);
      if (map[path].length === 0) delete map[path];
    },
  };
}
