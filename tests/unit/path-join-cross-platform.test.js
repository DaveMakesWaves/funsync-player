// Cross-platform path joining.
//
// Regression (Dave, 2026-08-06): download paths were built as
// `${dir}/${name}` then had every '/' rewritten to a backslash — a
// hard-coded Windows assumption. On Linux that turns
// /home/dave/clips/x.funscript into one backslash-laden filename rather
// than a path. FunSync ships a Linux AppImage, so EroScripts downloads were
// broken there for as long as the feature existed.
//
// NOTE: the backslash is built with String.fromCharCode(92) throughout.
// Writing it literally means surviving several layers of escaping between
// here and the file on disk, and getting that wrong silently changes what
// is under test.
import { describe, it, expect } from 'vitest';
import { joinPath, dirOfPath } from '../../renderer/js/path-utils.js';

const BS = String.fromCharCode(92);
const winPath = (...parts) => parts.join(BS);

describe('joinPath', () => {
  it('keeps POSIX paths forward-slashed', () => {
    expect(joinPath('/home/dave/clips', 'Video.funscript'))
      .toBe('/home/dave/clips/Video.funscript');
  });

  it('keeps Windows paths backslashed', () => {
    expect(joinPath(winPath('D:', 'clips'), 'Video.funscript'))
      .toBe(winPath('D:', 'clips', 'Video.funscript'));
  });

  it('never rewrites a POSIX path into backslashes', () => {
    // The exact failure mode being guarded.
    expect(joinPath('/home/dave', 'x.funscript')).not.toContain(BS);
  });

  it('trims a trailing separator rather than doubling it', () => {
    expect(joinPath('/home/dave/', 'x.funscript')).toBe('/home/dave/x.funscript');
    expect(joinPath(winPath('D:', 'clips') + BS, 'x.funscript'))
      .toBe(winPath('D:', 'clips', 'x.funscript'));
  });

  it('handles the POSIX filesystem root', () => {
    expect(joinPath('/', 'x.funscript')).toBe('/x.funscript');
  });

  it('returns the bare name when there is no directory', () => {
    expect(joinPath('', 'x.funscript')).toBe('x.funscript');
    expect(joinPath(null, 'x.funscript')).toBe('x.funscript');
  });
});

describe('dirOfPath', () => {
  it('strips the filename from a POSIX path', () => {
    expect(dirOfPath('/home/dave/clips/Video.mp4')).toBe('/home/dave/clips');
  });

  it('strips the filename from a Windows path', () => {
    expect(dirOfPath(winPath('D:', 'clips', 'Video.mp4'))).toBe(winPath('D:', 'clips'));
  });

  it('preserves the POSIX root instead of returning empty', () => {
    // `/Video.mp4` → '' would make the joined result relative, writing the
    // download to the working directory instead of the root.
    expect(dirOfPath('/Video.mp4')).toBe('/');
    expect(joinPath(dirOfPath('/Video.mp4'), 'Video.funscript')).toBe('/Video.funscript');
  });

  it('round-trips a POSIX video path to its sibling script', () => {
    const video = '/home/dave/clips/My Video.mp4';
    expect(joinPath(dirOfPath(video), 'My Video.roll.funscript'))
      .toBe('/home/dave/clips/My Video.roll.funscript');
  });

  it('round-trips a Windows video path to its sibling script', () => {
    const video = winPath('D:', 'clips', 'Video.mp4');
    expect(joinPath(dirOfPath(video), 'Video.roll.funscript'))
      .toBe(winPath('D:', 'clips', 'Video.roll.funscript'));
  });
});
