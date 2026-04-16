import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../');
const RENDERER_DIR = path.join(ROOT, 'renderer');
const ELECTRON_DIR = path.join(ROOT, 'electron');

/** Recursively collect files matching extensions. */
function collectFiles(dir, exts) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        files.push(...collectFiles(fullPath, exts));
      } else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) {
        files.push(fullPath);
      }
    }
  } catch (e) { /* skip unreadable dirs */ }
  return files;
}

describe('CSP compliance', () => {
  const jsFiles = [
    ...collectFiles(RENDERER_DIR, ['.js']),
    ...collectFiles(ELECTRON_DIR, ['.js']),
  ];

  const htmlFiles = collectFiles(RENDERER_DIR, ['.html']);

  it('finds JS files to scan', () => {
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  it('no eval() calls in source files', () => {
    const violations = [];
    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      // Match eval( but not .mockResolvedValue or other test patterns
      // Also exclude comments
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('*')) continue;
        // Match standalone eval( — not part of another word
        if (/\beval\s*\(/.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.slice(0, 80)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no new Function() calls in source files', () => {
    const violations = [];
    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('*')) continue;
        if (/new\s+Function\s*\(/.test(line)) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.slice(0, 80)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no inline <script> tags in HTML files', () => {
    const violations = [];
    for (const file of htmlFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      // Match <script> without src attribute (inline scripts)
      const matches = content.match(/<script(?![^>]*\bsrc\b)[^>]*>[\s\S]*?<\/script>/gi);
      if (matches) {
        for (const match of matches) {
          // Allow empty <script> tags or module type with src
          if (match.replace(/<\/?script[^>]*>/g, '').trim().length > 0) {
            violations.push(`${path.relative(ROOT, file)}: inline script found`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no inline event handlers in HTML files', () => {
    const handlers = ['onclick', 'onload', 'onerror', 'onmouseover', 'onsubmit', 'onfocus', 'onblur', 'onchange', 'onkeydown', 'onkeyup'];
    const violations = [];
    for (const file of htmlFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const handler of handlers) {
        const pattern = new RegExp(`\\b${handler}\\s*=`, 'gi');
        if (pattern.test(content)) {
          violations.push(`${path.relative(ROOT, file)}: ${handler} attribute found`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('CSP meta tag present in index.html', () => {
    const indexPath = path.join(RENDERER_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toMatch(/Content-Security-Policy/i);
    }
  });
});
