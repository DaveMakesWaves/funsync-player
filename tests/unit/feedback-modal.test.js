/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Tests for the pure helpers in renderer/components/feedback-modal.js:
//   - formatDiagnostics — rendering of the diagnostics bundle.
//   - composeBody — markdown body for GitHub Issue / clipboard / file.
//   - buildIssueUrl — URL composition + truncation under the 7500-char
//     budget. The DOM-driven openFeedbackModal() is intentionally NOT
//     covered here; it's tested by integration / manual UAT.

import { describe, it, expect } from 'vitest';
import {
  formatDiagnostics,
  composeBody,
  buildIssueUrl,
} from '../../renderer/components/feedback-modal.js';

describe('formatDiagnostics', () => {
  it('renders a complete diagnostics object as a multi-line string', () => {
    const out = formatDiagnostics({
      app: { name: 'FunSync Player', version: '0.5.1' },
      platform: { os: 'win32', release: '10.0.26200', arch: 'x64' },
      runtime: { electron: '41.0.0', chrome: '140.0.0', node: '22.18.0' },
      backend: { running: true, port: 5123 },
      devices: { handy: true, buttplug: false, vr: false, deviceCount: 0 },
      logTail: '[10:32] info: started',
    });
    expect(out).toContain('FunSync Player 0.5.1');
    expect(out).toContain('OS: win32 10.0.26200 (x64)');
    expect(out).toContain('Electron: 41.0.0');
    expect(out).toContain('Backend: running (port 5123)');
    expect(out).toContain('Handy=connected');
    expect(out).toContain('Buttplug=no');
    expect(out).toContain('[10:32] info: started');
  });

  it('handles missing fields gracefully', () => {
    const out = formatDiagnostics({});
    expect(out).toContain('FunSync Player ?');
    expect(out).toContain('Backend: not running');
  });

  it('returns a placeholder for null/undefined input', () => {
    expect(formatDiagnostics(null)).toBe('(no diagnostics)');
    expect(formatDiagnostics(undefined)).toBe('(no diagnostics)');
  });

  it('shows "(no log available)" when logTail is missing', () => {
    const out = formatDiagnostics({ app: { version: '0.5.1' } });
    expect(out).toContain('(no log available)');
  });
});

describe('composeBody', () => {
  it('always includes What happened + Diagnostics sections', () => {
    const body = composeBody({
      description: 'It crashed',
      steps: '',
      diagnostics: 'D',
    });
    expect(body).toContain('### What happened?');
    expect(body).toContain('It crashed');
    expect(body).toContain('### Diagnostics');
    expect(body).toContain('```\nD\n```');
  });

  it('omits Steps section when steps is empty/whitespace', () => {
    const body = composeBody({ description: 'x', steps: '', diagnostics: 'D' });
    expect(body).not.toContain('### Steps');
    const body2 = composeBody({ description: 'x', steps: '   \n  ', diagnostics: 'D' });
    expect(body2).not.toContain('### Steps');
  });

  it('includes Steps section when provided', () => {
    const body = composeBody({
      description: 'x',
      steps: '1. open\n2. crash',
      diagnostics: 'D',
    });
    expect(body).toContain('### Steps to reproduce');
    expect(body).toContain('1. open\n2. crash');
  });

  it('shows _(no description)_ when description blank', () => {
    const body = composeBody({ description: '', steps: '', diagnostics: 'D' });
    expect(body).toContain('_(no description)_');
  });
});

describe('buildIssueUrl', () => {
  it('targets the correct repo and new-issue path', () => {
    const { url } = buildIssueUrl({
      title: 'Crash',
      description: 'x',
      steps: '',
      diagnostics: 'D',
    });
    expect(url).toMatch(/^https:\/\/github\.com\/DaveMakesWaves\/funsync-player\/issues\/new\?/);
  });

  it('sets labels=bug and does NOT set template (would 500 if template file missing on default branch)', () => {
    const { url } = buildIssueUrl({
      title: 'T', description: 'd', steps: '', diagnostics: 'D',
    });
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('labels')).toBe('bug');
    expect(qs.get('template')).toBeNull();
  });

  it('places the user title in the title query param, truncated to 200 chars', () => {
    const long = 'A'.repeat(500);
    const { url } = buildIssueUrl({
      title: long, description: 'd', steps: '', diagnostics: 'D',
    });
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('title').length).toBe(200);
  });

  it('escapes special characters in the title', () => {
    const { url } = buildIssueUrl({
      title: 'crash & burn?',
      description: 'd', steps: '', diagnostics: 'D',
    });
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('title')).toBe('crash & burn?');
    // raw URL should have URL-encoded special chars
    expect(url).toContain('crash+%26+burn%3F');
  });

  it('does NOT truncate when payload fits the budget', () => {
    const { url, truncated } = buildIssueUrl({
      title: 'short',
      description: 'd',
      steps: '',
      diagnostics: 'small log',
    });
    expect(truncated).toBe(false);
    expect(url).toContain('small+log');
  });

  it('truncates when diagnostics would push the URL past the 7500-char budget', () => {
    const hugeDiag = 'X'.repeat(20000);
    const { url, truncated } = buildIssueUrl({
      title: 't',
      description: 'd',
      steps: '',
      diagnostics: hugeDiag,
    });
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(7500);
    // Truncation marker is in the body so the dev knows the clipboard
    // has the full payload.
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('body')).toContain('diagnostics truncated');
  });

  it('keeps the tail of the diagnostics on truncation (recent log lines)', () => {
    // Use distinctive head + tail markers so we can tell which end
    // survived the truncate.
    const head = 'HEAD_MARKER_AAAA';
    const tail = 'TAIL_MARKER_ZZZZ';
    const filler = 'x'.repeat(20000);
    const diag = `${head}\n${filler}\n${tail}`;
    const { url, truncated } = buildIssueUrl({
      title: 't', description: 'd', steps: '', diagnostics: diag,
    });
    expect(truncated).toBe(true);
    const body = new URLSearchParams(url.split('?')[1]).get('body');
    // Tail survives (most recent log lines kept), head dropped.
    expect(body).toContain(tail);
    expect(body).not.toContain(head);
  });

  it('returns a URL under the budget even with completely empty input', () => {
    const { url } = buildIssueUrl({
      title: '', description: '', steps: '', diagnostics: '',
    });
    expect(url.length).toBeLessThanOrEqual(7500);
    expect(url).toMatch(/issues\/new\?/);
  });
});
