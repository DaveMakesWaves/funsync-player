// Bytes in the active language ("1.2 GB", "1,2 Go"). Moved out of
// video-options-dialog.js (which re-exports it) on 2026-11-23 so the delete
// dialog and the Library's toasts can use it without loading that dialog.
import { getCurrentLocale } from './i18n.js';

/** Bytes in the active language ("1.2 GB", "1,2 Go"). */
export function formatFileSize(bytes, locale = getCurrentLocale()) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let value = bytes;
  let u = 0;
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
  try {
    // Bytes in the long form: CLDR's short English one is "224 byte", no
    // plural (the delete dialog, T306); the long one is right everywhere
    // ("224 bytes", "224 octets", "224 байта"). KB and up stay short ("1.2 MB").
    return new Intl.NumberFormat(locale || 'en', {
      style: 'unit', unit: units[u], unitDisplay: u === 0 ? 'long' : 'short', maximumFractionDigits: u === 0 ? 0 : 1,
    }).format(value);
  } catch {
    return `${Math.round(value * 10) / 10} ${['B', 'KB', 'MB', 'GB', 'TB'][u]}`;
  }
}
