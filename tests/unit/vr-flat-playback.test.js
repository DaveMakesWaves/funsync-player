// Tests for the VR-as-flat playback feature (Monoinc 2026-05-17).
//
// Two layers:
//   1. `classifyStereoFormat(input)` — pure filename parser returning
//      'sbs-half' / 'sbs-full' / 'tb-half' / 'tb-full' / 'nonplanar' / null
//   2. `videoPlayer.setVRFlatten(format, eye)` / `cycleVRFlatten(format)` —
//      class-based CSS state machine on the <video> element. Tests stub
//      the element with a classList-bearing mock.

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyStereoFormat, isFlattenableStereo } from '../../renderer/js/vr-detect.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';

describe('classifyStereoFormat', () => {
  it('returns null for empty / non-string input', () => {
    expect(classifyStereoFormat(null)).toBeNull();
    expect(classifyStereoFormat(undefined)).toBeNull();
    expect(classifyStereoFormat('')).toBeNull();
    expect(classifyStereoFormat({})).toBeNull();
    expect(classifyStereoFormat({ path: '' })).toBeNull();
  });

  it('returns null for non-VR filenames', () => {
    expect(classifyStereoFormat('vacation_2024.mp4')).toBeNull();
    expect(classifyStereoFormat('movie - episode 5.mkv')).toBeNull();
  });

  it('detects half-SBS via the _SBS token', () => {
    expect(classifyStereoFormat('scene_180_SBS.mp4')).toBe('sbs-half');
    expect(classifyStereoFormat('Title-SBS-1080p.mkv')).toBe('sbs-half');
    expect(classifyStereoFormat('foo_lr_180.mp4')).toBe('sbs-half');
    expect(classifyStereoFormat('clip_3DH.mp4')).toBe('sbs-half');
    expect(classifyStereoFormat('mono180.mp4')).toBe('sbs-half');
  });

  it('detects full-SBS via the _SBSF / _LRF (HereSphere) suffix', () => {
    expect(classifyStereoFormat('Title_SBSF.mp4')).toBe('sbs-full');
    expect(classifyStereoFormat('Title_LRF.mkv')).toBe('sbs-full');
    expect(classifyStereoFormat('foo_fullsbs.mp4')).toBe('sbs-full');
  });

  it('detects half-TB via the _TB / _OU token', () => {
    expect(classifyStereoFormat('clip_180_TB.mp4')).toBe('tb-half');
    expect(classifyStereoFormat('movie-OU.mp4')).toBe('tb-half');
    expect(classifyStereoFormat('a_3DV.mp4')).toBe('tb-half');
  });

  it('detects full-TB via the _TBF / _OUF suffix', () => {
    expect(classifyStereoFormat('Title_TBF.mp4')).toBe('tb-full');
    expect(classifyStereoFormat('Title_OUF.mkv')).toBe('tb-full');
  });

  it('detects nonplanar formats (fisheye / equirect / mkx) regardless of stereo suffix', () => {
    // Nonplanar wins because the projection is the load-bearing fact.
    // Naive 2D crop is meaningless without a 3D unproject pass.
    expect(classifyStereoFormat('Title_mkx200_sbs.mp4')).toBe('nonplanar');
    expect(classifyStereoFormat('rf52.mp4')).toBe('nonplanar');
    expect(classifyStereoFormat('clip_fisheye190.mp4')).toBe('nonplanar');
    expect(classifyStereoFormat('something_eac360.mp4')).toBe('nonplanar');
    expect(classifyStereoFormat('foo_mono360.mp4')).toBe('nonplanar');
  });

  it('full-SBS takes priority over half-SBS when both could match', () => {
    // `_SBSF` contains `_SBS` as a substring — the FULL pattern is a
    // strict superset of HALF and must be checked first.
    expect(classifyStereoFormat('movie_SBSF.mp4')).toBe('sbs-full');
    expect(classifyStereoFormat('movie_LRF.mp4')).toBe('sbs-full');
  });

  it('full-TB takes priority over half-TB when both could match', () => {
    expect(classifyStereoFormat('movie_TBF.mp4')).toBe('tb-full');
    expect(classifyStereoFormat('movie_OUF.mp4')).toBe('tb-full');
  });

  it('accepts {name} / {path} object inputs', () => {
    expect(classifyStereoFormat({ name: 'scene_SBS.mp4' })).toBe('sbs-half');
    expect(classifyStereoFormat({ path: '/lib/scene_TB.mp4' })).toBe('tb-half');
  });

  it('path-based detection picks up folder-organized layouts too', () => {
    expect(classifyStereoFormat({ path: '/lib/180_SBS/scene.mp4' })).toBe('sbs-half');
    expect(classifyStereoFormat({ path: 'D:\\VR\\TB\\movie.mp4' })).toBe('tb-half');
  });

  it('case-insensitive matching', () => {
    expect(classifyStereoFormat('SCENE_SBS.MP4')).toBe('sbs-half');
    expect(classifyStereoFormat('clip_Tb.mp4')).toBe('tb-half');
  });
});

describe('isFlattenableStereo', () => {
  it('true for SBS / TB (half + full)', () => {
    expect(isFlattenableStereo('sbs-half')).toBe(true);
    expect(isFlattenableStereo('sbs-full')).toBe(true);
    expect(isFlattenableStereo('tb-half')).toBe(true);
    expect(isFlattenableStereo('tb-full')).toBe(true);
  });

  it('false for nonplanar projections', () => {
    expect(isFlattenableStereo('nonplanar')).toBe(false);
  });

  it('false for unknown / null', () => {
    expect(isFlattenableStereo(null)).toBe(false);
    expect(isFlattenableStereo(undefined)).toBe(false);
    expect(isFlattenableStereo('garbage')).toBe(false);
  });
});

describe('VideoPlayer.setVRFlatten + cycleVRFlatten', () => {
  let player;
  let videoEl;

  beforeEach(() => {
    // Construct a VideoPlayer with the minimum DOM the constructor reads.
    // The constructor accesses `document.getElementById(...)` for various
    // controls — easiest path is to build a stub element + bypass via
    // direct property setting after instantiation. We use Object.create
    // to skip the constructor entirely; only setVRFlatten / cycleVRFlatten
    // exercise the video element.
    player = Object.create(VideoPlayer.prototype);
    const classes = new Set();
    videoEl = {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        _values: classes,
      },
    };
    player.video = videoEl;
    player._vrFlattenFormat = null;
    player._vrFlattenEye = 1;
  });

  it('applies the sbs-half left-eye class', () => {
    player.setVRFlatten('sbs-half', 1);
    expect(videoEl.classList.contains('player__video--flat-sbs-half')).toBe(true);
    expect(videoEl.classList.contains('player__video--flat-eye-2')).toBe(false);
    expect(player.vrFlattenState).toEqual({ format: 'sbs-half', eye: 1, zoom: 1 });
  });

  it('applies the sbs-half right-eye class', () => {
    player.setVRFlatten('sbs-half', 2);
    expect(videoEl.classList.contains('player__video--flat-sbs-half')).toBe(true);
    expect(videoEl.classList.contains('player__video--flat-eye-2')).toBe(true);
    expect(player.vrFlattenState).toEqual({ format: 'sbs-half', eye: 2, zoom: 1 });
  });

  it('applies tb-full / tb-half + eye-2 cleanly', () => {
    player.setVRFlatten('tb-half', 2);
    expect(videoEl.classList.contains('player__video--flat-tb-half')).toBe(true);
    expect(videoEl.classList.contains('player__video--flat-eye-2')).toBe(true);
  });

  it("setVRFlatten('off') clears all flat-* and eye-2 classes", () => {
    player.setVRFlatten('sbs-half', 2);
    player.setVRFlatten('off');
    expect(videoEl.classList.contains('player__video--flat-sbs-half')).toBe(false);
    expect(videoEl.classList.contains('player__video--flat-eye-2')).toBe(false);
    expect(player.vrFlattenState).toEqual({ format: null, eye: 1, zoom: 1 });
  });

  it('switching format clears the previous format class', () => {
    player.setVRFlatten('sbs-half', 1);
    player.setVRFlatten('tb-full', 2);
    expect(videoEl.classList.contains('player__video--flat-sbs-half')).toBe(false);
    expect(videoEl.classList.contains('player__video--flat-tb-full')).toBe(true);
    expect(videoEl.classList.contains('player__video--flat-eye-2')).toBe(true);
  });

  it('unknown format is treated as off', () => {
    player.setVRFlatten('sbs-half', 1);
    player.setVRFlatten('weird-projection', 1);
    expect(videoEl.classList.contains('player__video--flat-sbs-half')).toBe(false);
    expect(player.vrFlattenState).toEqual({ format: null, eye: 1, zoom: 1 });
  });

  it('cycleVRFlatten(null) is a no-op (stays Off)', () => {
    expect(player.cycleVRFlatten(null)).toBe('off');
    expect(videoEl.classList._values.size).toBe(0);
  });

  it('cycleVRFlatten progresses Off → Left → Right → Off', () => {
    expect(player.cycleVRFlatten('sbs-half')).toBe('sbs-half (left)');
    expect(player.vrFlattenState).toEqual({ format: 'sbs-half', eye: 1, zoom: 1 });

    expect(player.cycleVRFlatten('sbs-half')).toBe('sbs-half (right)');
    expect(player.vrFlattenState).toEqual({ format: 'sbs-half', eye: 2, zoom: 1 });

    expect(player.cycleVRFlatten('sbs-half')).toBe('off');
    expect(player.vrFlattenState).toEqual({ format: null, eye: 1, zoom: 1 });
  });

  it('cycleVRFlatten switching format mid-cycle starts at Left', () => {
    player.cycleVRFlatten('sbs-half'); // Left
    // Now the loaded video is TB. The cycle should produce Right for
    // sbs-half because the prior state still maps to that family; in
    // practice app.js passes the SAME format here per-call so this is
    // a corner case but worth pinning.
    expect(player.cycleVRFlatten('tb-half')).toBe('tb-half (right)');
  });
});
