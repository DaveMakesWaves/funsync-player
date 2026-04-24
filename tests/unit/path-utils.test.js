import { describe, it, expect } from 'vitest';
import { canonicalPath, isSubpath, classifyOverlap, commonAncestorOfFiles, pathToFileURL } from '../../renderer/js/path-utils.js';

describe('canonicalPath', () => {
  it('returns empty string for falsy input', () => {
    expect(canonicalPath('')).toBe('');
    expect(canonicalPath(null)).toBe('');
    expect(canonicalPath(undefined)).toBe('');
  });

  it('converts backslashes to forward slashes', () => {
    expect(canonicalPath('C:\\Users\\me\\Videos')).toBe('c:/Users/me/Videos');
  });

  it('lowercases the Windows drive letter', () => {
    expect(canonicalPath('D:\\VR')).toBe('d:/VR');
  });

  it('strips trailing slashes', () => {
    expect(canonicalPath('D:\\VR\\')).toBe('d:/VR');
    expect(canonicalPath('/home/me/videos/')).toBe('/home/me/videos');
  });

  it('preserves the root slash on unix paths', () => {
    expect(canonicalPath('/')).toBe('/');
  });

  it('handles mixed separators', () => {
    expect(canonicalPath('D:/Videos\\VR/japanese\\')).toBe('d:/Videos/VR/japanese');
  });
});

describe('isSubpath', () => {
  it('returns true for a nested child', () => {
    expect(isSubpath('D:\\VR\\japanese', 'D:\\VR')).toBe(true);
  });

  it('returns true regardless of separator style', () => {
    expect(isSubpath('D:/VR/japanese', 'D:\\VR')).toBe(true);
  });

  it('returns false when paths are equal', () => {
    expect(isSubpath('D:\\VR', 'D:\\VR')).toBe(false);
  });

  it('returns false when parent is not an ancestor', () => {
    expect(isSubpath('D:\\Movies', 'D:\\VR')).toBe(false);
  });

  it('does not match on string-prefix coincidence', () => {
    // "D:\VRBangers" starts with "D:\VR" as a string but is not a subpath
    expect(isSubpath('D:\\VRBangers', 'D:\\VR')).toBe(false);
  });

  it('handles unix paths', () => {
    expect(isSubpath('/home/me/Videos/VR', '/home/me/Videos')).toBe(true);
    expect(isSubpath('/home/me/VideosBackup', '/home/me/Videos')).toBe(false);
  });
});

describe('classifyOverlap', () => {
  const existing = [
    { id: '1', name: 'VR Drive', path: 'D:\\VR' },
    { id: '2', name: 'Movies', path: 'E:\\Movies' },
  ];

  it('returns none when there is no overlap', () => {
    expect(classifyOverlap('F:\\Stuff', existing)).toEqual({ kind: 'none' });
  });

  it('detects exact match regardless of separator style', () => {
    const result = classifyOverlap('D:/VR/', existing);
    expect(result.kind).toBe('exact');
    expect(result.source.id).toBe('1');
  });

  it('detects a child of an existing source', () => {
    const result = classifyOverlap('D:\\VR\\japanese', existing);
    expect(result.kind).toBe('child');
    expect(result.parent.id).toBe('1');
  });

  it('detects a parent of one or more existing sources', () => {
    const extended = [
      ...existing,
      { id: '3', name: 'VR JP', path: 'D:\\Media\\VR\\jp' },
      { id: '4', name: 'VR US', path: 'D:\\Media\\VR\\us' },
    ];
    const result = classifyOverlap('D:\\Media\\VR', extended);
    expect(result.kind).toBe('parent');
    expect(result.children.map(c => c.id).sort()).toEqual(['3', '4']);
  });

  it('prefers exact match over child/parent classification', () => {
    // Exact match takes priority even if it also happens to contain another source
    const extended = [
      ...existing,
      { id: '3', name: 'VR Sub', path: 'D:\\VR\\japanese' },
    ];
    const result = classifyOverlap('D:\\VR', extended);
    expect(result.kind).toBe('exact');
    expect(result.source.id).toBe('1');
  });
});

describe('commonAncestorOfFiles', () => {
  it('returns the shared folder when all files share one', () => {
    expect(commonAncestorOfFiles([
      'D:\\VR\\a.mp4',
      'D:\\VR\\b.mp4',
      'D:\\VR\\c.mp4',
    ])).toBe('d:/VR');
  });

  it('returns the nearest common ancestor when files are in subfolders', () => {
    expect(commonAncestorOfFiles([
      'D:\\VR\\japanese\\a.mp4',
      'D:\\VR\\western\\b.mp4',
    ])).toBe('d:/VR');
  });

  it('returns the file parent for a single file', () => {
    expect(commonAncestorOfFiles(['D:\\VR\\only.mp4'])).toBe('d:/VR');
  });

  it('returns an empty string when nothing is shared (different drives)', () => {
    expect(commonAncestorOfFiles([
      'D:\\VR\\a.mp4',
      'E:\\Movies\\b.mp4',
    ])).toBe('');
  });

  it('handles mixed separator styles', () => {
    expect(commonAncestorOfFiles([
      'D:/VR/a.mp4',
      'D:\\VR\\b.mp4',
    ])).toBe('d:/VR');
  });

  it('returns empty for empty or falsy input', () => {
    expect(commonAncestorOfFiles([])).toBe('');
    expect(commonAncestorOfFiles(null)).toBe('');
  });
});

describe('pathToFileURL', () => {
  it('returns empty string for falsy input', () => {
    expect(pathToFileURL('')).toBe('');
    expect(pathToFileURL(null)).toBe('');
    expect(pathToFileURL(undefined)).toBe('');
  });

  it('converts plain Windows paths to file:/// URLs with drive letter', () => {
    expect(pathToFileURL('C:\\Videos\\movie.mp4'))
      .toBe('file:///C:/Videos/movie.mp4');
  });

  it('converts plain Unix absolute paths to file:// URLs (prefix-merged)', () => {
    expect(pathToFileURL('/home/user/movie.mp4'))
      .toBe('file:///home/user/movie.mp4');
  });

  it('percent-encodes `#` so fragment truncation does not happen', () => {
    // Regression: "Your Step-sister #1 - Belleniko.mp4" was failing
    // because the browser treated #1 onward as a URL fragment.
    const url = pathToFileURL('C:\\Videos\\Your Step-sister #1 - Belleniko.mp4');
    expect(url).toBe('file:///C:/Videos/Your%20Step-sister%20%231%20-%20Belleniko.mp4');
    // Crucially, the URL parser now sees the full path — no fragment.
    expect(new URL(url).hash).toBe('');
  });

  it('percent-encodes `?` so query-string truncation does not happen', () => {
    const url = pathToFileURL('C:\\Videos\\What?.mp4');
    expect(url).toBe('file:///C:/Videos/What%3F.mp4');
    expect(new URL(url).search).toBe('');
  });

  it('percent-encodes `%` so it is not double-decoded', () => {
    const url = pathToFileURL('C:\\Videos\\50%20off.mp4');
    // `%` becomes `%25`; the literal `%20` (spaces in the source name) is
    // preserved verbatim as `%2520` so the browser decodes it back to `%20`.
    expect(url).toBe('file:///C:/Videos/50%2520off.mp4');
  });

  it('preserves forward slashes and colons in the path portion', () => {
    expect(pathToFileURL('C:/Videos/sub/file.mp4'))
      .toBe('file:///C:/Videos/sub/file.mp4');
  });

  it('encodes spaces as %20', () => {
    expect(pathToFileURL('C:\\My Videos\\a b.mp4'))
      .toBe('file:///C:/My%20Videos/a%20b.mp4');
  });

  it('handles paths with both backslashes and forward slashes', () => {
    // Rare but happens on mixed-origin paths (e.g. after cross-platform sync).
    expect(pathToFileURL('C:\\Videos/mixed/file.mp4'))
      .toBe('file:///C:/Videos/mixed/file.mp4');
  });

  it('encodes Unicode characters via encodeURI', () => {
    const url = pathToFileURL('C:\\Videos\\日本語.mp4');
    // encodeURI produces the UTF-8 percent-encoded form.
    expect(url).toBe('file:///C:/Videos/%E6%97%A5%E6%9C%AC%E8%AA%9E.mp4');
  });
});
