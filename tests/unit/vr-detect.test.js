import { describe, it, expect } from 'vitest';
import { isVRVideo } from '../../renderer/js/vr-detect.js';

describe('isVRVideo — strong format tokens', () => {
  const cases = [
    'movie_sbs.mp4',
    'movie-sbs.mp4',
    'movie.sbs.mp4',
    'movie sbs.mp4',
    'Movie_360x180_sbs.mp4',
    'Scene.MKX200.mkv',
    'Title-MKX220-7K.mp4',
    'Clip_FB360_8K.mp4',
    'Release [EAC360] 6K.mkv',
    'movie_RF52.mp4',
    'movie_fisheye190_sbs.mp4',
    'weird_lr_tag.mp4',
    'tb_example.mp4',
    'movie_mono180.mp4',
  ];
  for (const name of cases) {
    it(`detects: ${name}`, () => expect(isVRVideo(name)).toBe(true));
  }
});

describe('isVRVideo — resolution / projection tags', () => {
  const cases = [
    'VR180_title.mp4',
    'VR360-movie.mp4',
    'VR200.scene.mp4',
    'Title-VR180.mkv',
    '180VR_clip.mp4',
    '8KVR.mp4',
    'VR7K-blah.mp4',
    'Movie_VR8K_final.mp4',
  ];
  for (const name of cases) {
    it(`detects: ${name}`, () => expect(isVRVideo(name)).toBe(true));
  }
});

describe('isVRVideo — bare "VR" token', () => {
  const cases = [
    'StudioName.Title.4K.VR.180.SBS.mkv',
    '[VR] My Movie.mp4',
    'My Movie (VR).mp4',
    '(VR) Title.mp4',
    'Movie Title - VR - 7K.mp4',
    'VR Film.mp4',
    'title.vr.mkv',
    'Movie_8K_VR_2023.mp4',
  ];
  for (const name of cases) {
    it(`detects: ${name}`, () => expect(isVRVideo(name)).toBe(true));
  }
});

describe('isVRVideo — Western studio catalog', () => {
  const cases = [
    'WankzVR - Scene Title.mp4',
    'NaughtyAmericaVR.Scene.Title.mp4',
    'BadoinkVR - Scene.mp4',
    'MilfVR scene.mp4',
    'POVR.title.mp4',
    'SinsVR-title.mp4',
    'RealJamVR.scene.mp4',
    'CzechVR_0123.mp4',
    'GroobyVR - Daisy Taylor - Roommate Wanted VR.mp4',
    'VRBangers - title.mp4',
    'VRConk scene.mp4',
    '18VR.scene.mp4',
    'DarkRoomVR title.mp4',
    'StasyQVR_scene.mp4',
    // Rip-group / obfuscated codes seen in the user's library
    '9.VRBTS_46 20_Naie Mars_the_nutcracker_tmal.mp4',
    '8.vrbans_33 19_slty_receptionist_TMAL.mp4',
    '6.VRBS_42 15_Alise_Game Over TraR Pn_tmal.mp4',
    '5.VRBTNS_34 04_AIA RAE_watch_and_learn_TMAL.mp4',
  ];
  for (const name of cases) {
    it(`detects: ${name}`, () => expect(isVRVideo(name)).toBe(true));
  }
});

describe('isVRVideo — Japanese studio catalog', () => {
  const cases = [
    'SIVR-178-Title.mp4',
    'SIVR178.mp4',                   // no dash
    '[SIVR-178] Title (VR).mp4',
    'KAVR-483-Scene.mkv',
    'hhb3d-sivr-178.mp4',            // re-encoded community release
    'DSVR-1234.mp4',
    'VRKM-123 title.mp4',
    'BIKMVR-089.mp4',
    'SIVR.178.Title.mkv',
    // Unlisted but matches fallback (XXVR-###)
    'ZZVR-001.mp4',
    'VRZZ-001.mp4',
  ];
  for (const name of cases) {
    it(`detects: ${name}`, () => expect(isVRVideo(name)).toBe(true));
  }
});

describe('isVRVideo — folder-based organization (full path)', () => {
  it('detects via parent folder "VR"', () => {
    expect(isVRVideo('C:/Users/me/Downloads/VR/title.mp4')).toBe(true);
    expect(isVRVideo('/home/me/Videos/VR/title.mp4')).toBe(true);
    expect(isVRVideo('C:\\Downloads\\VR\\movie.mp4')).toBe(true);
  });

  it('detects via VR subfolder deeper in path', () => {
    expect(isVRVideo('D:/Media/VR/2024/clip.mp4')).toBe(true);
  });

  it('accepts a video object shape', () => {
    expect(isVRVideo({ name: 'title.mp4', path: 'C:/Downloads/VR/title.mp4' })).toBe(true);
    expect(isVRVideo({ name: 'title_sbs.mp4' })).toBe(true);
  });
});

describe('isVRVideo — rejects non-VR content', () => {
  const cases = [
    'movie.mp4',
    'Episode 01.mp4',
    'S01E02.mkv',
    'song.mp3',
    'podcast.wav',
    'my_home_movie.mp4',
    'Documentary.2023.1080p.BluRay.x264.mkv', // has dashes/dots but no VR tokens
    'project-files.mp4',
    'concert-recording.mp4',
  ];
  for (const name of cases) {
    it(`rejects: ${name}`, () => expect(isVRVideo(name)).toBe(false));
  }
});

describe('isVRVideo — edge cases', () => {
  it('handles null/undefined/empty', () => {
    expect(isVRVideo(null)).toBe(false);
    expect(isVRVideo(undefined)).toBe(false);
    expect(isVRVideo('')).toBe(false);
    expect(isVRVideo({})).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isVRVideo('MOVIE_SBS.MP4')).toBe(true);
    expect(isVRVideo('movie_SBS.mp4')).toBe(true);
    expect(isVRVideo('sivr-178.mp4')).toBe(true);
  });

  it('does not false-positive on "vr" embedded in words', () => {
    expect(isVRVideo('overview.mp4')).toBe(false);
    expect(isVRVideo('server-backup.mp4')).toBe(false);
    expect(isVRVideo('carving_wood.mp4')).toBe(false);
  });

  it('does not false-positive on non-VR 8K content', () => {
    // 8K alone (no VR tag) shouldn't be flagged as VR
    expect(isVRVideo('Movie.2023.8K.HDR.mp4')).toBe(false);
  });
});
