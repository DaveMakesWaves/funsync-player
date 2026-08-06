// Unit tests for the resume progress bar component — imports real source
import { describe, it, expect, beforeEach } from 'vitest';
import { createResumeBar, applyResumeBar } from '../../renderer/components/resume-bar.js';

describe('createResumeBar', () => {
  it('renders a bar whose fill matches the watched fraction', () => {
    const bar = createResumeBar({ position: 900, duration: 3600 });
    expect(bar).not.toBeNull();
    expect(bar.className).toBe('resume-bar');
    expect(bar.querySelector('.resume-bar__fill').style.width).toBe('25%');
  });

  it('returns null when there is nothing to show, so callers render nothing', () => {
    // This is the contract that keeps card height unchanged for videos
    // with no stored position.
    expect(createResumeBar(null)).toBeNull();
    expect(createResumeBar({ position: 0, duration: 3600 })).toBeNull();
    expect(createResumeBar({ position: 600 })).toBeNull();
  });

  it('clamps a position past the end to a full bar', () => {
    const bar = createResumeBar({ position: 9999, duration: 3600 });
    expect(bar.querySelector('.resume-bar__fill').style.width).toBe('100%');
  });

  it('prefers a live duration over the stored one', () => {
    const bar = createResumeBar({ position: 60, duration: 3600 }, 120);
    expect(bar.querySelector('.resume-bar__fill').style.width).toBe('50%');
  });

  it('carries an accessible label (the bar is otherwise unreachable)', () => {
    const bar = createResumeBar({ position: 900, duration: 3600 });
    expect(bar.getAttribute('role')).toBe('img');
    expect(bar.getAttribute('aria-label')).toBeTruthy();
  });

  it('adds the inline modifier for list rows', () => {
    const bar = createResumeBar({ position: 900, duration: 3600 }, undefined, { inline: true });
    expect(bar.className).toBe('resume-bar resume-bar--inline');
  });
});

describe('applyResumeBar', () => {
  let thumb;

  beforeEach(() => {
    thumb = document.createElement('div');
  });

  it('appends the bar to the thumbnail', () => {
    applyResumeBar(thumb, { position: 900, duration: 3600 });
    expect(thumb.querySelectorAll('.resume-bar')).toHaveLength(1);
  });

  it('replaces an existing bar rather than stacking a second', () => {
    applyResumeBar(thumb, { position: 900, duration: 3600 });
    applyResumeBar(thumb, { position: 1800, duration: 3600 });
    const bars = thumb.querySelectorAll('.resume-bar');
    expect(bars).toHaveLength(1);
    expect(bars[0].querySelector('.resume-bar__fill').style.width).toBe('50%');
  });

  it('removes the bar when the entry is cleared (finished video)', () => {
    applyResumeBar(thumb, { position: 900, duration: 3600 });
    applyResumeBar(thumb, null);
    expect(thumb.querySelectorAll('.resume-bar')).toHaveLength(0);
  });

  it('tolerates a missing thumbnail element', () => {
    expect(() => applyResumeBar(null, { position: 900, duration: 3600 })).not.toThrow();
    expect(applyResumeBar(null, { position: 900, duration: 3600 })).toBeNull();
  });

  it('only removes its OWN bar, not a nested one from a child card', () => {
    const child = document.createElement('div');
    const nested = document.createElement('div');
    nested.className = 'resume-bar';
    child.appendChild(nested);
    thumb.appendChild(child);

    applyResumeBar(thumb, { position: 900, duration: 3600 });
    // The nested one survives; only the direct child is managed.
    expect(child.querySelectorAll('.resume-bar')).toHaveLength(1);
    expect(thumb.querySelectorAll(':scope > .resume-bar')).toHaveLength(1);
  });
});
