/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The delete dialog said "1 file, 224 byte" (test day 2026-11-26, T306):
// CLDR's short English form for bytes has no plural. Bytes now take the long
// form, which is right in every language; KB and up stay short.
import { describe, it, expect } from 'vitest';
import { formatFileSize } from '../../renderer/js/format-file-size.js';

describe('formatFileSize', () => {
  it('bytes read as a plural where the language has one', () => {
    expect(formatFileSize(224, 'en')).toBe('224 bytes');
    expect(formatFileSize(1, 'en')).toBe('1 byte');
    expect(formatFileSize(224, 'fr')).toMatch(/^224\s+octets$/);   // a no-break space
    expect(formatFileSize(224, 'es')).toBe('224 bytes');
    expect(formatFileSize(224, 'de')).toBe('224 Byte');
  });

  it('KB and up stay short, one decimal', () => {
    expect(formatFileSize(1536, 'en')).toBe('1.5 kB');
    expect(formatFileSize(3.4 * 1024 ** 3, 'en')).toBe('3.4 GB');
    expect(formatFileSize(1.2 * 1024 ** 2, 'fr')).toMatch(/^1,2\s?Mo$/);
  });

  it('nothing to say for a bad size', () => {
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
  });
});
