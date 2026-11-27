// The EroScripts tab's note on a video download, kept WITH the job by the
// backend (services/video_downloader.py, <userData>/downloads.json).
//
// Dave, 2026-11-25: "i started a download closed the app reopened and
// downloaded again, it seemed to resume the download but there was no
// indicator that the download could resume". The backend's job list lived only
// in memory, and so did the tab's map from a job to its post (the script to
// save beside the video, the tags to record, the card to tick). Now a download
// running when FunSync closed comes back paused, with Resume, and this note
// lets it still finish as its post's.
//
// Pure: no DOM, no IPC. JSON only, and small (the backend drops a note over 64 KB).

/** The note for a new download: what finishing it needs, nothing the post can give again. */
export function downloadMeta({ topic = null, answer = null, script = null, axes = [], title = '' } = {}) {
  const pickPost = (o) => (o && typeof o === 'object' ? {
    id: o.id ?? null,
    topicId: o.topicId ?? null,
    url: textOr(o.url),
    title: textOr(o.title),
    creator: textOr(o.creator),
    // Names, or the post answer's {id, name} objects: both kept. Strings only
    // dropped every tag of the answer, and a download resumed after FunSync
    // closed recorded "no tags" (Dave, 2026-11-25).
    tags: Array.isArray(o.tags) ? o.tags.map(tagOf).filter(Boolean).slice(0, 100) : undefined,
  } : null);
  return {
    v: 1,
    topicId: topic?.id ?? null,
    title: textOr(title) || textOr(topic?.title) || '',
    topic: pickPost(topic),
    answer: pickPost(answer),
    script: script && typeof script === 'object' && script.url ? { url: String(script.url), name: textOr(script.name) } : null,
    axes: (Array.isArray(axes) ? axes : [])
      .filter((a) => a && a.url && a.suffix)
      .slice(0, 12)
      .map((a) => ({ url: String(a.url), suffix: String(a.suffix) })),
  };
}

/**
 * The tab's job info for a job it did not start this session (one brought
 * back after FunSync closed): from its note, else a bare one the Downloads
 * list can show. The script was saved under the video's reserved name when
 * the download started; `restored` makes the finish check it is still there.
 */
export function infoFromMeta(job) {
  const meta = job && typeof job.meta === 'object' && job.meta ? job.meta : null;
  const stem = String(job?.stem || '');
  const dir = String(job?.destDir || '').replace(/[\\/]+$/, '');
  const sep = dir.includes('\\') ? '\\' : '/';
  const script = meta?.script?.url ? { url: meta.script.url, name: meta.script.name || '' } : null;
  return {
    topicId: meta?.topicId ?? null,
    topic: meta?.topic?.id != null ? meta.topic : null,
    answer: meta?.answer || null,
    script,
    scriptPath: script && dir && stem ? `${dir}${sep}${stem}.funscript` : null,
    stem,
    title: meta?.title || stem,
    handled: false,
    axes: Array.isArray(meta?.axes) ? meta.axes : [],
    restored: true,
  };
}

/** A tag as the note keeps it: its name, or {id, name}; anything else null. */
function tagOf(x) {
  if (typeof x === 'string') return x.trim() ? x : null;
  if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !x.name.trim()) return null;
  return Number.isFinite(x.id) ? { id: x.id, name: x.name } : { name: x.name };
}

function textOr(v) {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
