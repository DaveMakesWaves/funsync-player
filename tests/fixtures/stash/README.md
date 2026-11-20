# Stash fixtures

All responses come from the local synthetic test Stash (v0.32.0, `../stash-test`), never from another server.

sn-* files (2026-11-19, seeded for the "next" lot):

- `sn-scenes.response.json`: all 10 scenes with rating100, organized, play_count, last_played_at, o_counter, play_history, o_history, tags (aliases, parents), groups { scene_index group { id name } } and files { fingerprints { type value } } incl. phash (tiny clip and the five edge clips have no phash).
- `sn-groups.response.json`: findGroups with 2 groups (Synthetic Series A, B). Group.scenes comes back in scene id order, NOT group order.
- `sn-group-scenes-ordered.response.json`: scenes of group 1 (`a`) and group 2 (`b`) with scene_index; the real order is by scene_index (A: 2, 3, 1; B: 4, 1). Scene 1 is in both groups.
- `sn-tags.response.json`: findTags with aliases and parents / children, incl. the chain Synthetic Grandparent Tag > Synthetic Parent Tag > Synthetic Tag B.
- `sn-duplicate-scenes.response.json`: findDuplicateScenes(distance: 0): one pair, synthetic_large.mkv and its re-encode synthetic_large_reencode.mp4 (same phash ab63cd1cc33c3343).
- `sn-duplicate-scenes-distance8.response.json`: the same with distance 8, duration_diff 1.

sn-* recordings of FunSync's own documents (2026-11-19, stage sn-main; each carries the document's sha256, pinned by tests/unit/stash-queries.test.js):

- `sn-scene-list.response.json`: FunSyncSceneList (the light list with play count, last play, O-count, groups and each file's phash), all 10 scenes.
- `sn-scene-details.response.json`: FunSyncSceneDetails for scenes 1-10 and the missing id 999 (null). The fake Stash's `snFixtureScenes()` serves these.
- `sn-tag-list.response.json`, `sn-tag-list-page-2-of-2.response.json`: FunSyncTagList (aliases, parents { id }), one page, and page 2 at 4 per page.

The S1 answers to the two documents the next lot changed (`s1-scene-list*.response.json`, `s1-scene-details.response.json`) stay as the S1 tests' data; their sha256 is now `s1DocumentSha256` (no longer pinned).
