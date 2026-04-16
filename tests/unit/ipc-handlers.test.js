// Unit tests for IPC handler logic from electron/main.js
//
// main.js registers handlers via ipcMain.handle() — we can't call them
// directly without Electron. Instead we test local copies of the core logic
// (same pattern as data-migration.test.js). Changes to main.js handler logic
// must be mirrored here. Acceptable tradeoff for ~30 lines of glue.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- scan-directory logic (local copy from main.js) ----
// This is the core logic extracted from the scan-directory handler.

const normalizeName = (name) =>
  name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

function scanDirectory(entries, dirPath) {
  const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac'];
  const FUNSCRIPT_EXT = '.funscript';

  const pathJoin = (...parts) => parts.join('/');
  const pathExtname = (name) => {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
  };
  const pathBasename = (name, ext) => ext ? name.slice(0, name.length - ext.length) : name;

  // Collect funscript basenames for matching
  const funscriptMap = new Map();
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const ext = pathExtname(entry.name).toLowerCase();
    if (ext === FUNSCRIPT_EXT) {
      const baseName = normalizeName(pathBasename(entry.name, ext));
      funscriptMap.set(baseName, { name: entry.name, path: pathJoin(dirPath, entry.name), _used: false });
    }
  }

  // Build video list with funscript pairing
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const ext = pathExtname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) continue;

    const baseName = normalizeName(pathBasename(entry.name, ext));
    const fsEntry = funscriptMap.get(baseName);
    const funscriptPath = fsEntry ? fsEntry.path : null;
    if (fsEntry) fsEntry._used = true;

    videos.push({
      name: entry.name,
      path: pathJoin(dirPath, entry.name),
      ext,
      hasFunscript: funscriptPath !== null,
      funscriptPath,
    });
  }

  // Collect unmatched funscripts
  const unmatchedFunscripts = [];
  for (const fsEntry of funscriptMap.values()) {
    if (!fsEntry._used) {
      unmatchedFunscripts.push({ name: fsEntry.name, path: fsEntry.path });
    }
  }
  unmatchedFunscripts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { videos, unmatchedFunscripts };
}

// Helper: create a fake dirent-like object
function file(name) {
  return { name, isFile: true };
}
function dir(name) {
  return { name, isFile: false };
}

// ---- read-funscript logic (local copy) ----

function readFunscript(filePath, readFileSync) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---- write-funscript logic (local copy) ----

function writeFunscript(content, filePath, writeFileSync) {
  try {
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

// ---- open-file-dialog file classification (local copy) ----

function classifyFiles(filePaths) {
  const TEXT_EXTS = ['.funscript', '.srt', '.vtt'];
  const files = [];
  for (const filePath of filePaths) {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const name = filePath.slice(slash + 1);
    const entry = { name, path: filePath };
    if (TEXT_EXTS.includes(ext)) {
      entry.textContent = true; // in real code this would be file content
    }
    files.push(entry);
  }
  return files;
}

// =========================================================================
// Tests
// =========================================================================

describe('normalizeName', () => {
  it('lowercases and replaces separators', () => {
    expect(normalizeName('My_Video-File.name')).toBe('my video file name');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeName('a__b--c..d')).toBe('a b c d');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeName('_hello_')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(normalizeName('')).toBe('');
  });

  it('handles string with only separators', () => {
    expect(normalizeName('_-._')).toBe('');
  });
});

describe('scan-directory', () => {
  it('returns videos and pairs funscripts by normalized basename', () => {
    const entries = [
      file('My Video.mp4'),
      file('My Video.funscript'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].name).toBe('My Video.mp4');
    expect(result.videos[0].hasFunscript).toBe(true);
    expect(result.videos[0].funscriptPath).toBe('/dir/My Video.funscript');
    expect(result.unmatchedFunscripts).toHaveLength(0);
  });

  it('matches video to funscript with different separators', () => {
    const entries = [
      file('my_video-file.mp4'),
      file('My.Video.File.funscript'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos[0].hasFunscript).toBe(true);
  });

  it('returns empty arrays for empty directory', () => {
    const result = scanDirectory([], '/dir');
    expect(result.videos).toEqual([]);
    expect(result.unmatchedFunscripts).toEqual([]);
  });

  it('ignores non-video/non-funscript files', () => {
    const entries = [
      file('readme.txt'),
      file('image.png'),
      file('data.json'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toEqual([]);
    expect(result.unmatchedFunscripts).toEqual([]);
  });

  it('collects unmatched funscripts', () => {
    const entries = [
      file('video.mp4'),
      file('video.funscript'),
      file('orphan.funscript'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toHaveLength(1);
    expect(result.unmatchedFunscripts).toHaveLength(1);
    expect(result.unmatchedFunscripts[0].name).toBe('orphan.funscript');
  });

  it('handles directory with only funscripts (all unmatched)', () => {
    const entries = [
      file('script1.funscript'),
      file('script2.funscript'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toEqual([]);
    expect(result.unmatchedFunscripts).toHaveLength(2);
  });

  it('case-insensitive extension matching', () => {
    const entries = [
      file('video.MP4'),
      file('video.FUNSCRIPT'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].hasFunscript).toBe(true);
  });

  it('ignores directories', () => {
    const entries = [
      dir('subdir'),
      file('video.mp4'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toHaveLength(1);
  });

  it('sorts videos alphabetically', () => {
    const entries = [
      file('zulu.mp4'),
      file('alpha.mp4'),
      file('mike.mp4'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos.map((v) => v.name)).toEqual(['alpha.mp4', 'mike.mp4', 'zulu.mp4']);
  });

  it('sorts unmatched funscripts alphabetically', () => {
    const entries = [
      file('zulu.funscript'),
      file('alpha.funscript'),
    ];
    const result = scanDirectory(entries, '/dir');
    expect(result.unmatchedFunscripts.map((f) => f.name)).toEqual(['alpha.funscript', 'zulu.funscript']);
  });

  it('handles all supported video extensions', () => {
    const exts = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac'];
    const entries = exts.map((ext) => file(`test${ext}`));
    const result = scanDirectory(entries, '/dir');
    expect(result.videos).toHaveLength(exts.length);
  });

  it('video without matching funscript has hasFunscript=false', () => {
    const entries = [file('lonely.mp4')];
    const result = scanDirectory(entries, '/dir');
    expect(result.videos[0].hasFunscript).toBe(false);
    expect(result.videos[0].funscriptPath).toBeNull();
  });
});

describe('read-funscript', () => {
  it('returns file content as string', () => {
    const mockRead = vi.fn().mockReturnValue('{"actions":[]}');
    const result = readFunscript('/path/to/file.funscript', mockRead);
    expect(result).toBe('{"actions":[]}');
    expect(mockRead).toHaveBeenCalledWith('/path/to/file.funscript', 'utf-8');
  });

  it('returns null for non-existent file', () => {
    const mockRead = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    const result = readFunscript('/missing.funscript', mockRead);
    expect(result).toBeNull();
  });
});

describe('write-funscript', () => {
  it('writes content and returns path', () => {
    const mockWrite = vi.fn();
    const result = writeFunscript('{"actions":[]}', '/path/out.funscript', mockWrite);
    expect(result).toBe('/path/out.funscript');
    expect(mockWrite).toHaveBeenCalledWith('/path/out.funscript', '{"actions":[]}', 'utf-8');
  });

  it('returns null on write error', () => {
    const mockWrite = vi.fn().mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const result = writeFunscript('content', '/readonly.funscript', mockWrite);
    expect(result).toBeNull();
  });
});

describe('open-file-dialog classification', () => {
  it('classifies video files (no textContent)', () => {
    const files = classifyFiles(['/videos/test.mp4']);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('test.mp4');
    expect(files[0].path).toBe('/videos/test.mp4');
    expect(files[0].textContent).toBeUndefined();
  });

  it('classifies funscript files (with textContent flag)', () => {
    const files = classifyFiles(['/scripts/test.funscript']);
    expect(files[0].textContent).toBe(true);
  });

  it('classifies subtitle files (with textContent flag)', () => {
    const srt = classifyFiles(['/subs/test.srt']);
    expect(srt[0].textContent).toBe(true);
    const vtt = classifyFiles(['/subs/test.vtt']);
    expect(vtt[0].textContent).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(classifyFiles([])).toEqual([]);
  });

  it('handles mixed file types', () => {
    const files = classifyFiles(['/a.mp4', '/b.funscript', '/c.srt', '/d.mkv']);
    expect(files.filter((f) => f.textContent)).toHaveLength(2);
    expect(files.filter((f) => !f.textContent)).toHaveLength(2);
  });
});
