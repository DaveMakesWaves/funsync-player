/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
import { describe, it, expect } from 'vitest';
import {
  AXIS_DEFINITIONS, parseAxisSuffix, getBaseName, detectCompanionFiles,
  buildCompanionPath, getAxisBadges, tcodeToFeature,
  getAxisBySuffix, axisSuffixVariants,
} from '../../renderer/js/multi-axis.js';

describe('multi-axis', () => {
  describe('parseAxisSuffix', () => {
    it('detects twist suffix', () => {
      const axis = parseAxisSuffix('video.twist.funscript');
      expect(axis).not.toBeNull();
      expect(axis.suffix).toBe('twist');
      expect(axis.tcode).toBe('R0');
      expect(axis.type).toBe('rotate');
    });

    it('detects surge suffix', () => {
      const axis = parseAxisSuffix('video.surge.funscript');
      expect(axis.suffix).toBe('surge');
      expect(axis.tcode).toBe('L1');
      expect(axis.type).toBe('linear');
    });

    it('detects sway suffix', () => {
      const axis = parseAxisSuffix('video.sway.funscript');
      expect(axis.suffix).toBe('sway');
      expect(axis.tcode).toBe('L2');
    });

    it('detects vib suffix', () => {
      const axis = parseAxisSuffix('video.vib.funscript');
      expect(axis.suffix).toBe('vib');
      expect(axis.tcode).toBe('V0');
      expect(axis.type).toBe('vibrate');
    });

    it('detects all standard suffixes', () => {
      const expected = ['surge', 'sway', 'twist', 'roll', 'pitch', 'vib', 'lube', 'pump', 'suck', 'valve'];
      for (const suffix of expected) {
        const axis = parseAxisSuffix(`test.${suffix}.funscript`);
        expect(axis, `suffix "${suffix}" should be detected`).not.toBeNull();
        expect(axis.suffix).toBe(suffix);
      }
    });

    // The channel is the whole point of the mapping — a suffix that parses but
    // routes to the wrong wire does nothing useful. These are the MultiFunPlayer
    // v0.3 assignments, which is what scripters name their files against.
    it('routes each suffix to the TCode v0.3 channel MultiFunPlayer uses', () => {
      const expected = {
        surge: 'L1', sway: 'L2', twist: 'R0', roll: 'R1', pitch: 'R2',
        vib: 'V0', pump: 'V1', valve: 'A0', suck: 'A1', lube: 'A2',
      };
      for (const [suffix, tcode] of Object.entries(expected)) {
        expect(parseAxisSuffix(`v.${suffix}.funscript`).tcode, suffix).toBe(tcode);
      }
    });

    it('detects the legacy and alternate spellings scripters actually use', () => {
      // `suction` was FunSync's own name until 2026-08-16; the rest are MFP
      // alternates and raw channel names. All must land on the same channel.
      const aliases = {
        suction: 'A1', forward: 'L1', left: 'L2', yaw: 'R0', vibrate: 'V0',
        A1: 'A1', R0: 'R0', L1: 'L1', a2: 'A2',
      };
      for (const [alias, tcode] of Object.entries(aliases)) {
        const axis = parseAxisSuffix(`test.${alias}.funscript`);
        expect(axis, `alias "${alias}" should be detected`).not.toBeNull();
        expect(axis.tcode, alias).toBe(tcode);
      }
    });

    it('strips an alias suffix from the base name so companions still pair', () => {
      // If `.suction.` isn't stripped, the base name becomes "video.suction"
      // and the file never matches its own video.
      expect(getBaseName('video.suction.funscript')).toBe('video');
      expect(getBaseName('video.A1.funscript')).toBe('video');
    });

    it('never maps suction to V2, and never shares a channel between axes', () => {
      // V2 was the old suction channel. No TCode device registers V2 as suction
      // (a stock OSR2 registers no V2 at all), so it drove nothing. And `lube`
      // used to collide with `pump` on V1, last write winning.
      expect(getAxisBySuffix('suck').tcode).not.toBe('V2');
      expect(getAxisBySuffix('lube').tcode).not.toBe(getAxisBySuffix('pump').tcode);

      const channels = AXIS_DEFINITIONS.map((a) => a.tcode);
      expect(new Set(channels).size, 'each axis owns its own channel').toBe(channels.length);
    });

    it('resolves any accepted spelling through getAxisBySuffix', () => {
      // Saved associations are keyed by whatever was canonical when written.
      expect(getAxisBySuffix('suction')).toBe(getAxisBySuffix('suck'));
      expect(getAxisBySuffix('SUCTION').tcode).toBe('A1');
      expect(getAxisBySuffix('nonsense')).toBeNull();
      expect(getAxisBySuffix('')).toBeNull();
    });

    it('lists the canonical spelling first among the variants', () => {
      // Auto-assign probes in order and takes the first hit, so a file named
      // with the canonical suffix must win over one named with an alias.
      for (const axis of AXIS_DEFINITIONS) {
        expect(axisSuffixVariants(axis)[0]).toBe(axis.suffix);
        expect(axisSuffixVariants(axis).length).toBeGreaterThan(1);
      }
    });

    it('is case-insensitive', () => {
      expect(parseAxisSuffix('video.TWIST.funscript')).not.toBeNull();
      expect(parseAxisSuffix('video.Twist.FUNSCRIPT')).not.toBeNull();
      expect(parseAxisSuffix('video.SURGE.Funscript')).not.toBeNull();
    });

    it('returns null for primary axis (no suffix)', () => {
      expect(parseAxisSuffix('video.funscript')).toBeNull();
    });

    it('returns null for unknown suffix', () => {
      expect(parseAxisSuffix('video.unknown.funscript')).toBeNull();
    });

    it('returns null for non-funscript files', () => {
      expect(parseAxisSuffix('video.mp4')).toBeNull();
      expect(parseAxisSuffix('video.twist.mp4')).toBeNull();
    });

    it('returns null for null/empty input', () => {
      expect(parseAxisSuffix(null)).toBeNull();
      expect(parseAxisSuffix('')).toBeNull();
    });
  });

  describe('getBaseName', () => {
    it('extracts base name from primary funscript', () => {
      expect(getBaseName('video.funscript')).toBe('video');
    });

    it('strips axis suffix from companion file', () => {
      expect(getBaseName('video.twist.funscript')).toBe('video');
    });

    it('handles full paths', () => {
      expect(getBaseName('C:\\videos\\My Video.twist.funscript')).toBe('My Video');
      expect(getBaseName('/home/user/video.surge.funscript')).toBe('video');
    });

    it('preserves dots in base name that are not suffixes', () => {
      expect(getBaseName('my.video.v2.funscript')).toBe('my.video.v2');
    });

    it('strips known suffix even with dots in name', () => {
      expect(getBaseName('my.video.twist.funscript')).toBe('my.video');
    });

    it('returns empty for null/empty', () => {
      expect(getBaseName(null)).toBe('');
      expect(getBaseName('')).toBe('');
    });
  });

  describe('detectCompanionFiles', () => {
    const allFiles = [
      'video.funscript',
      'video.twist.funscript',
      'video.surge.funscript',
      'video.vib.funscript',
      'other.funscript',
      'other.twist.funscript',
      'video.mp4',
    ];

    it('detects companion files for a primary funscript', () => {
      const companions = detectCompanionFiles('video.funscript', allFiles);
      expect(companions.length).toBe(3);
      const suffixes = companions.map(c => c.axis.suffix).sort();
      expect(suffixes).toEqual(['surge', 'twist', 'vib']);
    });

    it('does not include the primary file', () => {
      const companions = detectCompanionFiles('video.funscript', allFiles);
      const paths = companions.map(c => c.path);
      expect(paths).not.toContain('video.funscript');
    });

    it('no false positives — different base name is not a companion', () => {
      const companions = detectCompanionFiles('video.funscript', allFiles);
      const paths = companions.map(c => c.path);
      expect(paths).not.toContain('other.funscript');
      expect(paths).not.toContain('other.twist.funscript');
    });

    it('video2.funscript is not a companion of video.funscript', () => {
      const files = ['video.funscript', 'video2.funscript', 'video2.twist.funscript'];
      const companions = detectCompanionFiles('video.funscript', files);
      expect(companions.length).toBe(0);
    });

    it('returns empty for empty file list', () => {
      expect(detectCompanionFiles('video.funscript', [])).toEqual([]);
    });

    it('returns empty for null inputs', () => {
      expect(detectCompanionFiles(null, allFiles)).toEqual([]);
      expect(detectCompanionFiles('video.funscript', null)).toEqual([]);
    });

    it('handles paths with directories', () => {
      const filesWithPaths = [
        'C:\\videos\\video.funscript',
        'C:\\videos\\video.twist.funscript',
        'C:\\videos\\video.surge.funscript',
      ];
      const companions = detectCompanionFiles('C:\\videos\\video.funscript', filesWithPaths);
      expect(companions.length).toBe(2);
    });
  });

  describe('buildCompanionPath', () => {
    it('builds correct companion path', () => {
      expect(buildCompanionPath('C:/videos/video.mp4', 'twist')).toBe('C:/videos/video.twist.funscript');
    });

    it('handles different extensions', () => {
      expect(buildCompanionPath('video.avi', 'surge')).toBe('video.surge.funscript');
    });

    it('returns empty for null', () => {
      expect(buildCompanionPath(null, 'twist')).toBe('');
    });
  });

  describe('getAxisBadges', () => {
    it('returns labels for companions', () => {
      const companions = [
        { path: 'a.twist.funscript', axis: { suffix: 'twist', tcode: 'R0', label: 'Twist', type: 'rotate' } },
        { path: 'a.surge.funscript', axis: { suffix: 'surge', tcode: 'L1', label: 'Surge', type: 'linear' } },
      ];
      expect(getAxisBadges(companions)).toEqual(['Twist', 'Surge']);
    });

    it('returns empty for no companions', () => {
      expect(getAxisBadges([])).toEqual([]);
      expect(getAxisBadges(null)).toEqual([]);
    });
  });

  describe('tcodeToFeature', () => {
    it('maps L axes to linear', () => {
      expect(tcodeToFeature('L0')).toBe('linear');
      expect(tcodeToFeature('L1')).toBe('linear');
      expect(tcodeToFeature('L2')).toBe('linear');
    });

    it('maps R axes to rotate', () => {
      expect(tcodeToFeature('R0')).toBe('rotate');
      expect(tcodeToFeature('R1')).toBe('rotate');
    });

    it('maps V axes to vibrate', () => {
      expect(tcodeToFeature('V0')).toBe('vibrate');
      expect(tcodeToFeature('V1')).toBe('vibrate');
    });

    it('maps A axes to linear', () => {
      expect(tcodeToFeature('A0')).toBe('linear');
    });

    it('defaults to linear for null/unknown', () => {
      expect(tcodeToFeature(null)).toBe('linear');
      expect(tcodeToFeature('')).toBe('linear');
      expect(tcodeToFeature('X0')).toBe('linear');
    });
  });

  describe('AXIS_DEFINITIONS', () => {
    it('has expected number of definitions', () => {
      expect(AXIS_DEFINITIONS.length).toBe(10);
    });

    it('all have required fields', () => {
      for (const axis of AXIS_DEFINITIONS) {
        expect(axis.suffix).toBeTruthy();
        expect(axis.tcode).toBeTruthy();
        expect(axis.label).toBeTruthy();
        expect(['linear', 'rotate', 'vibrate']).toContain(axis.type);
      }
    });
  });
});
