// Unit tests for Script Variant Detection and Management
import { describe, it, expect } from 'vitest';

describe('Variant Detection (scan-directory logic)', () => {
  // Simulate the variant detection logic from main.js scan-directory
  const AXIS_SUFFIXES = new Set(['surge','sway','twist','roll','pitch','vib','lube','pump','suction','valve']);

  function classifyFunscript(filename) {
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.funscript')) return null;

    const nameNoExt = filename.slice(0, -'.funscript'.length);
    const dotIdx = nameNoExt.lastIndexOf('.');
    const dotSuffix = dotIdx >= 0 ? nameNoExt.slice(dotIdx + 1).toLowerCase() : null;
    const isAxis = !!(dotSuffix && AXIS_SUFFIXES.has(dotSuffix));

    const parenMatch = nameNoExt.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

    let videoBase, variantLabel;
    if (isAxis) {
      videoBase = nameNoExt.slice(0, dotIdx).toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      variantLabel = null;
    } else if (parenMatch) {
      videoBase = parenMatch[1].toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      variantLabel = parenMatch[2].trim();
    } else if (dotSuffix && dotIdx > 0) {
      videoBase = nameNoExt.slice(0, dotIdx).toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      variantLabel = dotSuffix;
    } else {
      videoBase = nameNoExt.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      variantLabel = null;
    }

    return { videoBase, variantLabel, isAxis, axisSuffix: isAxis ? dotSuffix : null };
  }

  describe('Default (no suffix)', () => {
    it('detects default funscript', () => {
      const result = classifyFunscript('video.funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBeNull();
      expect(result.isAxis).toBe(false);
    });

    it('handles spaces and separators in name', () => {
      const result = classifyFunscript('My_Cool-Video.funscript');
      expect(result.videoBase).toBe('my cool video');
      expect(result.variantLabel).toBeNull();
    });
  });

  describe('Parenthesized variants', () => {
    it('detects (Soft) variant', () => {
      const result = classifyFunscript('video (Soft).funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('Soft');
      expect(result.isAxis).toBe(false);
    });

    it('detects (Intense) variant', () => {
      const result = classifyFunscript('My Video (Intense).funscript');
      expect(result.videoBase).toBe('my video');
      expect(result.variantLabel).toBe('Intense');
    });

    it('handles no space before parenthesis', () => {
      const result = classifyFunscript('video(HalfSpeed).funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('HalfSpeed');
    });
  });

  describe('Dot-separated variants', () => {
    it('detects .intense variant', () => {
      const result = classifyFunscript('video.intense.funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('intense');
      expect(result.isAxis).toBe(false);
    });

    it('detects .halfspeed variant', () => {
      const result = classifyFunscript('video.halfspeed.funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('halfspeed');
    });
  });

  describe('Axis suffixes (NOT variants)', () => {
    it('detects .vib as axis, not variant', () => {
      const result = classifyFunscript('video.vib.funscript');
      expect(result.isAxis).toBe(true);
      expect(result.axisSuffix).toBe('vib');
      expect(result.variantLabel).toBeNull();
    });

    it('detects .twist as axis', () => {
      const result = classifyFunscript('video.twist.funscript');
      expect(result.isAxis).toBe(true);
      expect(result.axisSuffix).toBe('twist');
    });

    it('detects .surge as axis', () => {
      const result = classifyFunscript('video.surge.funscript');
      expect(result.isAxis).toBe(true);
      expect(result.axisSuffix).toBe('surge');
    });

    it('all 10 axis suffixes are detected', () => {
      const axes = ['surge','sway','twist','roll','pitch','vib','lube','pump','suction','valve'];
      for (const axis of axes) {
        const result = classifyFunscript(`video.${axis}.funscript`);
        expect(result.isAxis).toBe(true);
        expect(result.axisSuffix).toBe(axis);
      }
    });

    it('axis detection is case-insensitive', () => {
      const result = classifyFunscript('video.VIB.funscript');
      expect(result.isAxis).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('returns null for non-funscript files', () => {
      expect(classifyFunscript('video.mp4')).toBeNull();
      expect(classifyFunscript('video.txt')).toBeNull();
    });

    it('handles dots in video name', () => {
      const result = classifyFunscript('video.2024.01.funscript');
      // Last dot segment "01" is not an axis, so it's a variant
      expect(result.variantLabel).toBe('01');
    });

    it('handles empty filename', () => {
      const result = classifyFunscript('.funscript');
      expect(result.videoBase).toBe('');
    });
  });

  describe('Variant grouping', () => {
    it('groups variants by video base name', () => {
      const files = [
        'MyVideo.funscript',
        'MyVideo (Soft).funscript',
        'MyVideo (Intense).funscript',
        'MyVideo.vib.funscript',
        'OtherVideo.funscript',
      ];

      const classified = files.map(f => ({ ...classifyFunscript(f), name: f }));
      const myVideoVariants = classified.filter(c => c && c.videoBase === 'myvideo' && !c.isAxis);
      const myVideoAxes = classified.filter(c => c && c.videoBase === 'myvideo' && c.isAxis);

      expect(myVideoVariants).toHaveLength(3); // Default + Soft + Intense
      expect(myVideoAxes).toHaveLength(1); // vib
    });

    it('sorts variants with Default first', () => {
      const variants = [
        { label: 'Intense' },
        { label: 'Default' },
        { label: 'Soft' },
      ];
      variants.sort((a, b) => {
        if (a.label === 'Default') return -1;
        if (b.label === 'Default') return 1;
        return a.label.localeCompare(b.label);
      });

      expect(variants[0].label).toBe('Default');
      expect(variants[1].label).toBe('Intense');
      expect(variants[2].label).toBe('Soft');
    });

    it('only includes variants array when more than 1', () => {
      const variants = [{ label: 'Default', path: '/v.funscript' }];
      const result = variants.length > 1 ? variants : [];
      expect(result).toEqual([]);
    });
  });
});

describe('Variant Switching', () => {
  it('tracks active variant by path', () => {
    const variants = [
      { label: 'Default', path: '/v.funscript' },
      { label: 'Soft', path: '/v (Soft).funscript' },
      { label: 'Intense', path: '/v.intense.funscript' },
    ];

    let activeIndex = 0;
    let activePath = variants[0].path;

    // Switch to Intense
    activeIndex = 2;
    activePath = variants[2].path;

    // Resolve index from path after array rebuild
    const resolvedIndex = variants.findIndex(v => v.path === activePath);
    expect(resolvedIndex).toBe(2);
    expect(variants[resolvedIndex].label).toBe('Intense');
  });

  it('handles path not found after rebuild (falls back to index)', () => {
    const variants = [
      { label: 'Default', path: '/v.funscript' },
      { label: 'New', path: '/v.new.funscript' },
    ];

    const activePath = '/deleted.funscript';
    const resolvedIndex = variants.findIndex(v => v.path === activePath);
    expect(resolvedIndex).toBe(-1); // not found
  });

  it('cycle forward wraps around', () => {
    const len = 3;
    let idx = 2; // last
    idx = (idx + 1 + len) % len;
    expect(idx).toBe(0); // wraps to first
  });

  it('cycle backward wraps around', () => {
    const len = 3;
    let idx = 0; // first
    idx = (idx - 1 + len) % len;
    expect(idx).toBe(2); // wraps to last
  });
});

describe('Manual Variants', () => {
  it('stores manual variants per video path', () => {
    const manualVariants = {};
    const videoPath = '/videos/test.mp4';

    manualVariants[videoPath] = [];
    manualVariants[videoPath].push({ label: 'Custom', path: '/scripts/custom.funscript', name: 'custom.funscript' });

    expect(manualVariants[videoPath]).toHaveLength(1);
    expect(manualVariants[videoPath][0].label).toBe('Custom');
  });

  it('combines auto-detected and manual variants', () => {
    const autoVariants = [
      { label: 'Default', path: '/v.funscript' },
      { label: 'Soft', path: '/v (Soft).funscript' },
    ];
    const manualVariants = [
      { label: 'Custom', path: '/custom.funscript' },
    ];

    const all = [...autoVariants, ...manualVariants];
    expect(all).toHaveLength(3);
  });

  it('derives label from parenthesized filename', () => {
    const name = 'video (Super Soft).funscript';
    const nameNoExt = name.replace(/\.funscript$/i, '');
    const parenMatch = nameNoExt.match(/\(([^)]+)\)/);
    const label = parenMatch ? parenMatch[1].trim() : nameNoExt;
    expect(label).toBe('Super Soft');
  });

  it('derives label from full filename when no parentheses', () => {
    const name = 'HARDER video script.funscript';
    const nameNoExt = name.replace(/\.funscript$/i, '');
    const parenMatch = nameNoExt.match(/\(([^)]+)\)/);
    const label = parenMatch ? parenMatch[1].trim() : nameNoExt;
    expect(label).toBe('HARDER video script');
  });
});
