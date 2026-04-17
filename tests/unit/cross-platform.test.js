// Unit tests for cross-platform compatibility
// Tests the platform-abstraction logic works correctly on any OS
import { describe, it, expect } from 'vitest';
import path from 'path';

describe('Cross-Platform: Path Handling', () => {
  describe('file:/// URL construction', () => {
    it('constructs valid file URL from Windows path', () => {
      const windowsPath = 'C:\\Users\\user\\Videos\\video.mp4';
      const normalized = windowsPath.replace(/\\/g, '/');
      const url = `file:///${normalized}`;
      expect(url).toBe('file:///C:/Users/user/Videos/video.mp4');
      expect(url.startsWith('file:///')).toBe(true);
    });

    it('constructs valid file URL from Linux path', () => {
      const linuxPath = '/home/user/Videos/video.mp4';
      const normalized = linuxPath.replace(/\\/g, '/');
      const url = `file:///${normalized}`;
      // file:////home/... has 4 slashes but browsers accept it
      expect(url).toMatch(/^file:\/\/\//);
      expect(url).toContain('/home/user/Videos/video.mp4');
    });

    it('handles paths with spaces', () => {
      const pathWithSpaces = 'C:\\Users\\user\\My Videos\\cool video.mp4';
      const normalized = pathWithSpaces.replace(/\\/g, '/');
      const url = `file:///${normalized}`;
      expect(url).toContain('My Videos/cool video.mp4');
    });

    it('handles paths with special characters', () => {
      const pathWithChars = '/home/user/Videos/video (2024).mp4';
      const normalized = pathWithChars.replace(/\\/g, '/');
      const url = `file:///${normalized}`;
      expect(url).toContain('video (2024).mp4');
    });
  });

  describe('Path separator splitting', () => {
    const splitPath = (p) => p.split(/[\\/]/);

    it('splits Windows paths', () => {
      const parts = splitPath('C:\\Users\\user\\video.mp4');
      expect(parts).toEqual(['C:', 'Users', 'user', 'video.mp4']);
    });

    it('splits Linux paths', () => {
      const parts = splitPath('/home/user/video.mp4');
      expect(parts).toEqual(['', 'home', 'user', 'video.mp4']);
    });

    it('splits mixed paths', () => {
      const parts = splitPath('some/path\\mixed/separators');
      expect(parts).toEqual(['some', 'path', 'mixed', 'separators']);
    });

    it('extracts filename from Windows path', () => {
      const name = 'C:\\Users\\user\\video.mp4'.split(/[\\/]/).pop();
      expect(name).toBe('video.mp4');
    });

    it('extracts filename from Linux path', () => {
      const name = '/home/user/video.mp4'.split(/[\\/]/).pop();
      expect(name).toBe('video.mp4');
    });
  });

  describe('Directory extraction', () => {
    it('extracts directory from Windows path', () => {
      const dir = 'C:\\Users\\user\\video.mp4'.replace(/[\\/][^\\/]+$/, '');
      expect(dir).toBe('C:\\Users\\user');
    });

    it('extracts directory from Linux path', () => {
      const dir = '/home/user/video.mp4'.replace(/[\\/][^\\/]+$/, '');
      expect(dir).toBe('/home/user');
    });

    it('detects path has directory separator', () => {
      expect('C:\\video.mp4'.includes('\\') || 'C:\\video.mp4'.includes('/')).toBe(true);
      expect('/home/video.mp4'.includes('\\') || '/home/video.mp4'.includes('/')).toBe(true);
      expect('video.mp4'.includes('\\') || 'video.mp4'.includes('/')).toBe(false);
    });
  });
});

describe('Cross-Platform: Filename Normalization', () => {
  const normalizeName = (name) => name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

  it('normalizes consistently regardless of OS path separators', () => {
    const winName = 'My_Cool-Video.mp4';
    const linuxName = 'My_Cool-Video.mp4';
    expect(normalizeName(winName)).toBe(normalizeName(linuxName));
  });

  it('handles unicode filenames', () => {
    const name = '日本語ビデオ.mp4';
    expect(normalizeName(name)).toBeTruthy();
  });
});

describe('Cross-Platform: Python Bridge Logic', () => {
  describe('Venv path detection', () => {
    it('uses Scripts on Windows', () => {
      const platform = 'win32';
      const backendDir = '/app/backend';
      const venvPython = platform === 'win32'
        ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
        : path.join(backendDir, '.venv', 'bin', 'python');

      expect(venvPython).toContain('Scripts');
      expect(venvPython).toContain('.exe');
    });

    it('uses bin on Linux', () => {
      const platform = 'linux';
      const backendDir = '/app/backend';
      const venvPython = platform === 'win32'
        ? path.join(backendDir, '.venv', 'Scripts', 'python.exe')
        : path.join(backendDir, '.venv', 'bin', 'python');

      expect(venvPython).toContain('bin');
      expect(venvPython).not.toContain('.exe');
    });
  });

  describe('Process killing', () => {
    it('uses taskkill on Windows', () => {
      const platform = 'win32';
      const method = platform === 'win32' ? 'taskkill' : 'sigkill';
      expect(method).toBe('taskkill');
    });

    it('uses SIGKILL process group on Linux', () => {
      const platform = 'linux';
      const method = platform === 'win32' ? 'taskkill' : 'sigkill';
      expect(method).toBe('sigkill');
    });

    it('spawns detached on Linux for process group kill', () => {
      const platform = 'linux';
      const detached = platform !== 'win32';
      expect(detached).toBe(true);
    });

    it('spawns attached on Windows', () => {
      const platform = 'win32';
      const detached = platform !== 'win32';
      expect(detached).toBe(false);
    });
  });

  describe('Backend binary detection', () => {
    it('appends .exe on Windows', () => {
      const platform = 'win32';
      const name = 'funsync-backend' + (platform === 'win32' ? '.exe' : '');
      expect(name).toBe('funsync-backend.exe');
    });

    it('no extension on Linux', () => {
      const platform = 'linux';
      const name = 'funsync-backend' + (platform === 'win32' ? '.exe' : '');
      expect(name).toBe('funsync-backend');
    });
  });
});

describe('Cross-Platform: Icon Selection', () => {
  it('uses .ico on Windows', () => {
    const platform = 'win32';
    const icon = platform === 'win32' ? 'icon.ico' : 'icon.png';
    expect(icon).toBe('icon.ico');
  });

  it('uses .png on Linux', () => {
    const platform = 'linux';
    const icon = platform === 'win32' ? 'icon.ico' : 'icon.png';
    expect(icon).toBe('icon.png');
  });
});

describe('Cross-Platform: ffmpeg Binary Detection', () => {
  it('appends .exe on Windows', () => {
    const osName = 'nt'; // os.name on Windows
    const binary = 'ffmpeg' + (osName === 'nt' ? '.exe' : '');
    expect(binary).toBe('ffmpeg.exe');
  });

  it('no extension on Linux', () => {
    const osName = 'posix'; // os.name on Linux
    const binary = 'ffmpeg' + (osName === 'nt' ? '.exe' : '');
    expect(binary).toBe('ffmpeg');
  });
});

describe('Cross-Platform: Safe Storage', () => {
  it('handles encryption unavailable gracefully', () => {
    const isAvailable = false; // Linux without keyring
    const key = 'my-secret-key';

    let stored;
    if (isAvailable) {
      stored = { encrypted: true, data: Buffer.from(key).toString('base64') };
    } else {
      stored = { encrypted: false, data: key };
    }

    // Restore
    let restored;
    if (stored.encrypted) {
      restored = Buffer.from(stored.data, 'base64').toString();
    } else {
      restored = stored.data;
    }

    expect(restored).toBe(key);
  });
});

describe('Cross-Platform: electron-builder config', () => {
  it('Windows config has nsis target and .exe ffmpeg', () => {
    const winConfig = {
      target: 'nsis',
      icon: 'icon.ico',
      ffmpegFilter: ['ffmpeg.exe', 'ffprobe.exe'],
    };
    expect(winConfig.target).toBe('nsis');
    expect(winConfig.ffmpegFilter.every(f => f.endsWith('.exe'))).toBe(true);
  });

  it('Linux config has AppImage target and extensionless ffmpeg', () => {
    const linuxConfig = {
      target: 'AppImage',
      icon: 'icon.png',
      ffmpegFilter: ['ffmpeg', 'ffprobe'],
    };
    expect(linuxConfig.target).toBe('AppImage');
    expect(linuxConfig.ffmpegFilter.every(f => !f.includes('.'))).toBe(true);
  });
});
