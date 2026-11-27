// Embedded subtitles (#268 thirstyduck500, 2026-11-23): which of a file's
// subtitle streams to load, and what to call each one in the CC menu.
// Pure: the tracks come from the backend (/api/media/subtitle-tracks:
// { index, codec, language, title, default, forced, text }).

/** ISO 639-2 (what Matroska stores) to the two-letter code Intl knows. */
const ISO3_TO_2 = {
  eng: 'en', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr',
  spa: 'es', rus: 'ru', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', nor: 'no',
  dan: 'da', fin: 'fi', tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id',
  ukr: 'uk', ces: 'cs', cze: 'cs', hun: 'hu', gre: 'el', ell: 'el', rum: 'ro', ron: 'ro',
};

/** A language code as its name in the UI language ("eng" -> "English"), or the code itself. */
export function languageName(code, uiLocale = 'en') {
  const raw = String(code || '').trim().toLowerCase();
  if (!raw || raw === 'und') return '';
  const two = ISO3_TO_2[raw] || raw;
  try {
    const names = new Intl.DisplayNames([uiLocale], { type: 'language' });
    const name = names.of(two);
    if (name && name.toLowerCase() !== two) return name;
  } catch { /* an unknown code: the code itself */ }
  return raw.toUpperCase();
}

/**
 * What the CC menu calls a track: its title, else its language, else
 * "Track N"; the language added when the title does not say it.
 * @param {object} track
 * @param {number} n 1-based place among the file's subtitle tracks
 * @param {(key: string, params?: object) => string} t
 * @param {string} uiLocale
 */
export function subtitleTrackLabel(track, n, t, uiLocale = 'en') {
  const lang = languageName(track?.language, uiLocale);
  const title = String(track?.title || '').trim();
  let label;
  if (title && lang && !title.toLowerCase().includes(lang.toLowerCase())) label = `${title} (${lang})`;
  else label = title || lang || t('player.subtitles.track', { n });
  if (track && track.text === false) label = `${label}: ${t('player.subtitles.pictures')}`;
  return label;
}

/**
 * The text track to load when the file has no subtitle file beside it: the
 * one the file marks as default, else a forced one, else the first text
 * track. `show` only when the file marks it default or forced (so a file
 * with optional subtitles does not start with them on). null: no text track.
 */
export function pickEmbeddedTrack(tracks) {
  const text = (Array.isArray(tracks) ? tracks : []).filter((tr) => tr && tr.text);
  if (!text.length) return null;
  const pick = text.find((tr) => tr.default) || text.find((tr) => tr.forced) || text[0];
  return { track: pick, show: !!(pick.default || pick.forced) };
}

/** Files that can carry subtitle streams worth asking about. */
export function mayHaveEmbeddedSubtitles(path) {
  return /\.(mkv|mp4|m4v|mov|webm)$/i.test(String(path || ''));
}
